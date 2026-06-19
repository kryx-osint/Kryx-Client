"""Kryx Client — team workspace that searches via the main Kryx API (shared credits)."""

from __future__ import annotations

import csv
import io
import mimetypes
import os
import secrets
from collections import defaultdict
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from werkzeug.utils import secure_filename

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

from flask import (
    Flask,
    Response,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

import kryx_api
import user_intel
from kryx_api import KryxApiError
from store import (
    DATA_DIR,
    append_audit,
    append_search_log,
    get_search_context,
    load_store,
    new_id,
    save_search_context,
    save_store,
    team_by_id,
    team_by_username,
)

CLIENT_ROOT = Path(__file__).resolve().parent
BRAND_DIR = DATA_DIR / "brand"
DEFAULT_LOGO_STATIC = "logo.svg"
_LOGO_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".svg"})
_MAX_LOGO_BYTES = 2 * 1024 * 1024

app = Flask(__name__)
app.secret_key = os.environ.get("KRYX_CLIENT_SECRET_KEY", "change-kryx-client-secret-in-production")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

SESSION_ROLE = "client_role"
SESSION_ACTOR = "client_actor"
SESSION_CSRF = "csrf_token"
SESSION_SEARCH_OK = "client_search_ok"
SESSION_SEARCH_TOKEN = "client_search_token"

SEARCH_TYPES = {
    "username": {"label": "Username", "field": "username", "placeholder": "username"},
    "phone": {"label": "Phone", "field": "phone", "placeholder": "+63 9XX XXX XXXX"},
    "email": {"label": "Email", "field": "email", "placeholder": "email@example.com"},
    "name": {"label": "Name", "fields": [("first_name", "First name"), ("last_name", "Last name")]},
    "plate_number": {"label": "Plate", "field": "plate_number", "placeholder": "ABC 1234"},
    "passport_number": {"label": "Passport", "field": "passport_number", "placeholder": "P1234567"},
}

_SEARCH_EMPTY_MESSAGES = {
    "username": "Enter a username for this search.",
    "name": "Enter both first name and last name.",
    "phone": "Enter a phone number.",
    "email": "Enter an email address.",
    "plate_number": "Enter a plate number.",
    "passport_number": "Enter a passport number.",
}


def _search_fields_from_request(active_type: str, form) -> tuple[Dict[str, str], str, Optional[str]]:
    """Collect submitted fields for the active search type; return (fields, display, error)."""
    if active_type not in SEARCH_TYPES:
        active_type = "username"
    spec = SEARCH_TYPES[active_type]
    fields: Dict[str, str] = {}
    if "fields" in spec:
        for key, _label in spec["fields"]:
            fields[key] = (form.get(key) or "").strip()
        query_display = " ".join(fields.values()).strip()
        if active_type == "name" and (not fields.get("first_name") or not fields.get("last_name")):
            return fields, query_display, _SEARCH_EMPTY_MESSAGES["name"]
    else:
        field = spec["field"]
        fields[field] = (form.get(field) or "").strip()
        query_display = fields[field]
        if not query_display:
            return fields, query_display, _SEARCH_EMPTY_MESSAGES.get(
                active_type, "Enter a search value."
            )
    if not query_display:
        return fields, query_display, _SEARCH_EMPTY_MESSAGES.get(active_type, "Enter a search value.")
    return fields, query_display, None


def _utc_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _csrf_token() -> str:
    token = (session.get(SESSION_CSRF) or "").strip()
    if not token:
        token = secrets.token_urlsafe(24)
        session[SESSION_CSRF] = token
    return token


def _valid_csrf(token: str) -> bool:
    expected = (session.get(SESSION_CSRF) or "").strip()
    got = (token or "").strip()
    return bool(expected and got and secrets.compare_digest(expected, got))


def _config(store: Dict[str, Any]) -> Dict[str, Any]:
    return store.get("config") if isinstance(store.get("config"), dict) else {}


def _brand_logo_path(store: Dict[str, Any]) -> Optional[Path]:
    name = secure_filename(((_config(store).get("custom_logo") or "")).strip())
    if not name or name != (_config(store).get("custom_logo") or "").strip():
        return None
    path = (BRAND_DIR / name).resolve()
    try:
        path.relative_to(BRAND_DIR.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def _client_logo_url() -> str:
    store = load_store()
    if _brand_logo_path(store):
        return url_for("client_brand_logo")
    return url_for("static", filename=DEFAULT_LOGO_STATIC)


def _clear_client_logo(store: Dict[str, Any]) -> None:
    if BRAND_DIR.is_dir():
        for old in BRAND_DIR.glob("logo.*"):
            try:
                old.unlink()
            except OSError:
                pass
    cfg = _config(store)
    cfg["custom_logo"] = ""
    store["config"] = cfg


def _apply_logo_from_settings(store: Dict[str, Any]) -> Optional[str]:
    """Handle logo upload or reset from settings. Returns error message or None."""
    upload = request.files.get("logo")
    if upload and getattr(upload, "filename", None) and (upload.filename or "").strip():
        return _save_client_logo(store, upload)
    if (request.form.get("remove_logo") or "").strip() == "1":
        _clear_client_logo(store)
    return None


def _save_client_logo(store: Dict[str, Any], upload) -> Optional[str]:
    """Persist an uploaded organization logo. Returns an error message or None."""
    if not upload or not getattr(upload, "filename", None):
        return None
    original = (upload.filename or "").strip()
    if not original:
        return None
    ext = Path(original).suffix.lower()
    if ext not in _LOGO_EXTENSIONS:
        return "Logo must be PNG, JPG, WebP, or SVG."
    upload.stream.seek(0, os.SEEK_END)
    size = upload.stream.tell()
    upload.stream.seek(0)
    if size <= 0:
        return "Uploaded logo file is empty."
    if size > _MAX_LOGO_BYTES:
        return "Logo must be 2 MB or smaller."
    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    for old in BRAND_DIR.glob("logo.*"):
        try:
            old.unlink()
        except OSError:
            pass
    dest_name = f"logo{ext}"
    dest_path = BRAND_DIR / dest_name
    upload.save(dest_path)
    cfg = _config(store)
    cfg["custom_logo"] = dest_name
    store["config"] = cfg
    return None


def _setup_complete(store: Dict[str, Any]) -> bool:
    cfg = _config(store)
    return bool(
        cfg.get("setup_complete")
        and (cfg.get("kryx_url") or "").strip()
        and (cfg.get("api_token") or "").strip()
        and (cfg.get("owner_password_hash") or "").strip()
    )


def _kryx_credentials(store: Dict[str, Any]) -> tuple[str, str]:
    cfg = _config(store)
    return (cfg.get("kryx_url") or "").strip().rstrip("/"), (cfg.get("api_token") or "").strip()


def _apply_kryx_api_config(
    store: Dict[str, Any],
    *,
    kryx_url: str,
    api_token: str,
) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Verify Kryx API credentials and update store config. Returns (error, account)."""
    kryx_url = (kryx_url or "").strip().rstrip("/")
    api_token = (api_token or "").strip()
    if not kryx_url or not api_token:
        return "Kryx server URL and API token are required.", None
    try:
        account = kryx_api.verify_api_access(kryx_url, api_token)
    except KryxApiError as exc:
        hint = ""
        if exc.code == "invalid_token":
            hint = " Generate a new token in Kryx → API Access and paste it here."
        return f"Could not verify Kryx API: {exc}{hint}", None
    if account.get("expired"):
        return "The Kryx account for this API key is expired. Renew on Kryx Billing first.", None
    if not account.get("api_access_enabled"):
        return (
            "API access is not enabled for this Kryx account. Enable API on an Agency plan "
            "or turn on standalone API access in Kryx admin.",
            None,
        )
    cfg = _config(store)
    cfg.update(
        {
            "kryx_url": kryx_url,
            "api_token": api_token,
            "kryx_owner_email": account.get("email") or cfg.get("kryx_owner_email") or "",
            "kryx_package": account.get("package") or cfg.get("kryx_package") or "",
        }
    )
    store["config"] = cfg
    return None, account


def _actor_label() -> str:
    return (session.get(SESSION_ACTOR) or "").strip() or "unknown"


def _is_owner() -> bool:
    return session.get(SESSION_ROLE) == "owner"


def _require_login(f: Callable):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get(SESSION_ACTOR):
            flash("Please sign in.", "error")
            return redirect(url_for("login"))
        return f(*args, **kwargs)

    return wrapper


def _require_owner(f: Callable):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _is_owner():
            flash("Owner access required.", "error")
            return redirect(url_for("search"))
        return f(*args, **kwargs)

    return wrapper


@app.before_request
def guard_setup_and_csrf():
    endpoint = request.endpoint or ""
    if endpoint in {"static", None, "client_brand_logo"}:
        return None
    store = load_store()
    if not _setup_complete(store) and endpoint != "setup":
        return redirect(url_for("setup"))
    if request.method == "POST" and endpoint not in {"setup", "login"}:
        token = (request.form.get("csrf_token") or request.headers.get("X-CSRF-Token") or "").strip()
        if not _valid_csrf(token):
            if endpoint == "search_report_context_sync":
                return jsonify({"ok": False, "error": "Security check failed."}), 403
            flash("Security check failed. Refresh and try again.", "error")
            return redirect(request.referrer or url_for("dashboard"))


@app.context_processor
def inject_globals():
    endpoint = request.endpoint or ""
    actor = _actor_label()
    initials = (actor.replace(".", "").replace("_", "")[:2] or "U").upper()
    show_workspace = bool(session.get(SESSION_ACTOR) and endpoint not in {"setup", "login"})
    cfg = _config(load_store())
    org_name = (cfg.get("organization_name") or "My team").strip() or "My team"
    return {
        "csrf_token": _csrf_token(),
        "is_owner": _is_owner(),
        "actor": actor,
        "actor_initials": initials,
        "workspace_nav_endpoint": endpoint,
        "show_workspace": show_workspace,
        "client_logo_url": _client_logo_url(),
        "client_org_name": org_name,
    }


def _intel_image_origin() -> str:
    return (os.environ.get("KRYX_CLIENT_INTEL_IMAGE_ORIGIN") or "").strip().rstrip("/")


def _build_search_context_payload(
    result: Any,
    query: Dict[str, Any],
    account: Optional[Dict[str, Any]],
    *,
    actor: str,
) -> Dict[str, Any]:
    query_meta = query if isinstance(query, dict) else {}
    image_origin = _intel_image_origin()
    return {
        "query": {
            "type": (query_meta.get("type") or "-").strip() or "-",
            "value": (query_meta.get("value") or "-").strip() or "-",
        },
        "result": user_intel.sanitize_intel_context_result(
            result if isinstance(result, dict) else {},
            allowed=True,
        ),
        "meta": {
            "report_id": secrets.token_urlsafe(8),
            "created_at": _utc_now(),
            "operator": actor,
        },
        "permissions": {
            "intel_image_view": True,
            "intel_image_proxy_prefix": "",
            "intel_image_origin": image_origin,
        },
    }


def _profile_source(result: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    for key in ("profiles", "results", "records", "matches", "data"):
        val = result.get(key)
        if isinstance(val, dict) and val:
            return val
    return result


def _flatten_rows(value: Any, prefix: str = "") -> List[tuple[str, str]]:
    rows: List[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            rows.extend(_flatten_rows(child, next_prefix))
        return rows
    if isinstance(value, list):
        for idx, child in enumerate(value, start=1):
            next_prefix = f"{prefix}[{idx}]" if prefix else f"item[{idx}]"
            rows.extend(_flatten_rows(child, next_prefix))
        return rows
    rows.append((prefix or "value", "" if value is None else str(value)))
    return rows


def _friendly_label(key: str) -> str:
    pretty = (key or "").replace("_", " ").replace("-", " ").replace(".", " ")
    return " ".join(pretty.split()).title()


def _load_session_search_context(store: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if session.get(SESSION_SEARCH_OK) != "1":
        return None
    token = (session.get(SESSION_SEARCH_TOKEN) or "").strip()
    if not token:
        return None
    return get_search_context(store, token)


def _save_session_search_context(store: Dict[str, Any], payload: Dict[str, Any]) -> None:
    token = secrets.token_urlsafe(18)
    save_search_context(store, token, payload)
    save_store(store)
    session[SESSION_SEARCH_TOKEN] = token
    session[SESSION_SEARCH_OK] = "1"


def _update_session_search_context(store: Dict[str, Any], payload: Dict[str, Any]) -> bool:
    if session.get(SESSION_SEARCH_OK) != "1":
        return False
    token = (session.get(SESSION_SEARCH_TOKEN) or "").strip()
    if not token or not get_search_context(store, token):
        return False
    save_search_context(store, token, payload)
    save_store(store)
    return True


def _fetch_account(store: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    base, token = _kryx_credentials(store)
    if not base or not token:
        return None
    account = kryx_api.get_account_or_probe(base, token)
    if account and account.get("account_endpoint_missing"):
        last_credits = _config(store).get("last_known_credits")
        if last_credits is not None:
            account = dict(account)
            account["credits"] = int(last_credits)
    return account


def _usage_charts(store: Dict[str, Any], account: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    today = datetime.utcnow().date()
    day_labels: List[str] = []
    day_counts: List[int] = []
    for offset in range(29, -1, -1):
        d = today - timedelta(days=offset)
        day_labels.append(d.strftime("%m-%d"))
        day_counts.append(0)

    month_labels: List[str] = []
    month_counts: List[int] = []
    cursor = today.replace(day=1)
    for _ in range(5):
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    for _ in range(6):
        month_labels.append(cursor.strftime("%Y-%m"))
        month_counts.append(0)
        ny, nm = cursor.year + (1 if cursor.month == 12 else 0), (cursor.month % 12) + 1
        cursor = cursor.replace(year=ny, month=nm)

    by_actor: Dict[str, int] = defaultdict(int)
    for row in store.get("search_logs", []):
        if not row.get("ok"):
            continue
        created = (row.get("created_at") or "")[:10]
        if not created:
            continue
        try:
            sd = datetime.strptime(created, "%Y-%m-%d").date()
        except ValueError:
            continue
        delta_days = (today - sd).days
        if 0 <= delta_days < 30:
            day_counts[29 - delta_days] += 1
        month_key = created[:7]
        if month_key in month_labels:
            month_counts[month_labels.index(month_key)] += 1
        by_actor[(row.get("actor") or "unknown").strip()] += 1

    credits = int((account or {}).get("credits") or 0)
    monthly_limit = int((account or {}).get("monthly_search_limit") or 0)
    monthly_used = int((account or {}).get("monthly_search_used") or 0)
    return {
        "credits_remaining": credits,
        "monthly_limit": monthly_limit,
        "monthly_used": monthly_used,
        "monthly_remaining": max(0, monthly_limit - monthly_used) if monthly_limit else credits,
        "day_labels": day_labels,
        "day_counts": day_counts,
        "month_labels": month_labels,
        "month_counts": month_counts,
        "actor_labels": list(by_actor.keys())[:8],
        "actor_counts": [by_actor[k] for k in list(by_actor.keys())[:8]],
    }


@app.route("/")
def index():
    if not session.get(SESSION_ACTOR):
        return redirect(url_for("login"))
    return redirect(url_for("dashboard" if _is_owner() else "search"))


@app.route("/brand/logo")
def client_brand_logo():
    store = load_store()
    path = _brand_logo_path(store)
    if not path:
        return redirect(url_for("static", filename=DEFAULT_LOGO_STATIC))
    mime, _encoding = mimetypes.guess_type(path.name)
    return send_from_directory(path.parent, path.name, mimetype=mime or "application/octet-stream")


@app.route("/setup", methods=["GET", "POST"])
def setup():
    store = load_store()
    if request.method == "GET" and _setup_complete(store):
        return redirect(url_for("login"))
    if request.method == "POST":
        kryx_url = (request.form.get("kryx_url") or "").strip().rstrip("/")
        api_token = (request.form.get("api_token") or "").strip()
        owner_username = (request.form.get("owner_username") or "owner").strip().lower()
        owner_password = (request.form.get("owner_password") or "").strip()
        org_name = (request.form.get("organization_name") or "My team").strip()
        if not kryx_url or not api_token or not owner_username or not owner_password:
            flash("All setup fields are required.", "error")
            return render_template("setup.html", config=_config(store))
        err, account = _apply_kryx_api_config(store, kryx_url=kryx_url, api_token=api_token)
        if err:
            flash(err, "error")
            return render_template("setup.html", config=_config(store))
        logo_err = _save_client_logo(store, request.files.get("logo"))
        if logo_err:
            flash(logo_err, "error")
            return render_template("setup.html", config=_config(store))
        cfg = _config(store)
        cfg.update(
            {
                "setup_complete": True,
                "owner_username": owner_username,
                "owner_password_hash": generate_password_hash(owner_password),
                "organization_name": org_name,
            }
        )
        store["config"] = cfg
        append_audit(store, owner_username, "setup_complete", f"Linked {(account or {}).get('email', '')}")
        save_store(store)
        if account.get("account_endpoint_missing"):
            flash(
                "API token verified. Restart the main Kryx app (python app.py) for full "
                "dashboard credit sync via /api/v1/account.",
                "info",
            )
        flash("Client app configured. Sign in as owner to manage your team.", "info")
        return redirect(url_for("login"))
    return render_template("setup.html", config=_config(store))


@app.route("/login", methods=["GET", "POST"])
def login():
    store = load_store()
    cfg = _config(store)
    if request.method == "POST":
        username = (request.form.get("username") or "").strip().lower()
        password = request.form.get("password") or ""
        if username == (cfg.get("owner_username") or "").strip().lower():
            if check_password_hash(cfg.get("owner_password_hash") or "", password):
                session[SESSION_ROLE] = "owner"
                session[SESSION_ACTOR] = username
                append_audit(store, username, "login", "Owner signed in")
                save_store(store)
                return redirect(url_for("dashboard"))
            flash("Invalid owner credentials.", "error")
            return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)
        member = team_by_username(store, username)
        if member and check_password_hash(member.get("password_hash") or "", password):
            session[SESSION_ROLE] = "team"
            session[SESSION_ACTOR] = username
            append_audit(store, username, "login", "Team member signed in")
            save_store(store)
            return redirect(url_for("search"))
        flash("Invalid username or password.", "error")
    return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)


@app.route("/logout")
def logout():
    actor = _actor_label()
    if actor != "unknown":
        store = load_store()
        append_audit(store, actor, "logout", "Signed out")
        save_store(store)
    session.clear()
    flash("Signed out.", "info")
    return redirect(url_for("login"))


@app.route("/settings", methods=["GET", "POST"])
@_require_login
@_require_owner
def settings():
    store = load_store()
    cfg = _config(store)
    if request.method == "POST":
        kryx_url = (request.form.get("kryx_url") or cfg.get("kryx_url") or "").strip().rstrip("/")
        api_token = (request.form.get("api_token") or "").strip() or (cfg.get("api_token") or "").strip()
        org_name = (request.form.get("organization_name") or cfg.get("organization_name") or "My team").strip()
        err, account = _apply_kryx_api_config(store, kryx_url=kryx_url, api_token=api_token)
        if err:
            flash(err, "error")
            return render_template("settings.html", config=_config(store))
        logo_err = _apply_logo_from_settings(store)
        if logo_err:
            flash(logo_err, "error")
            return render_template("settings.html", config=_config(store))
        cfg = _config(store)
        cfg["organization_name"] = org_name
        store["config"] = cfg
        upload = request.files.get("logo")
        uploaded_logo = bool(
            upload and getattr(upload, "filename", None) and (upload.filename or "").strip()
        )
        if uploaded_logo:
            audit_detail = "Organization logo updated"
        elif (request.form.get("remove_logo") or "").strip() == "1":
            audit_detail = "Organization logo reset to Kryx default"
        else:
            audit_detail = f"Kryx API linked: {(account or {}).get('email', '')}"
        append_audit(store, _actor_label(), "settings_update", audit_detail)
        save_store(store)
        flash("Settings saved.", "info")
        return redirect(url_for("settings"))
    return render_template("settings.html", config=cfg)


@app.route("/dashboard")
@_require_login
@_require_owner
def dashboard():
    store = load_store()
    account = _fetch_account(store)
    charts = _usage_charts(store, account)
    return render_template(
        "dashboard.html",
        account=account,
        charts=charts,
        config=_config(store),
        team_count=len(store.get("team", [])),
    )


@app.route("/search", methods=["GET", "POST"], endpoint="search")
@_require_login
def search_page():
    store = load_store()
    account = _fetch_account(store)
    active_type = (request.form.get("search_type") or request.args.get("type") or "username").strip()
    if active_type not in SEARCH_TYPES:
        active_type = "username"

    if request.method == "POST":
        base, token = _kryx_credentials(store)
        fields, query_display, validation_error = _search_fields_from_request(
            active_type, request.form
        )
        if validation_error:
            flash(validation_error, "error")
        elif account and account.get("expired"):
            flash("Kryx account expired. Renew on Kryx Billing.", "error")
        else:
            try:
                data, credits_left = kryx_api.search(
                    base, token, search_type=active_type, fields=fields
                )
                result = data.get("result")
                query_meta = data.get("query") if isinstance(data.get("query"), dict) else {}
                if not query_meta:
                    query_meta = {"type": active_type.upper(), "value": query_display}
                context_payload = _build_search_context_payload(
                    result,
                    query_meta,
                    account,
                    actor=_actor_label(),
                )
                _save_session_search_context(store, context_payload)
                append_search_log(
                    store,
                    actor=_actor_label(),
                    search_type=active_type,
                    query_value=query_display,
                    ok=True,
                    credits_remaining=credits_left,
                )
                append_audit(store, _actor_label(), "search", f"{active_type}: {query_display}")
                cfg = _config(store)
                cfg["last_known_credits"] = credits_left
                store["config"] = cfg
                save_store(store)
                return redirect(url_for("search_report"))
            except KryxApiError as exc:
                append_search_log(
                    store,
                    actor=_actor_label(),
                    search_type=active_type,
                    query_value=query_display,
                    ok=False,
                    credits_remaining=None,
                    error=str(exc),
                )
                append_audit(store, _actor_label(), "search_failed", str(exc))
                save_store(store)
                msg = str(exc)
                if exc.code == "invalid_token":
                    msg += " Update the API token under Settings (owner login)."
                flash(msg, "error")

    return render_template(
        "search.html",
        account=account,
        search_types=SEARCH_TYPES,
        active_type=active_type,
    )


@app.route("/search/report/context", methods=["POST"], endpoint="search_report_context_sync")
@_require_login
def search_report_context_sync():
    """Persist the current (possibly filtered) report result for print/export."""
    store = load_store()
    existing = _load_session_search_context(store)
    if not existing:
        return jsonify({"ok": False, "error": "No active report."}), 400

    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("result"), dict):
        return jsonify({"ok": False, "error": "Invalid payload."}), 400

    updated = dict(existing)
    updated["result"] = body["result"]
    filters = body.get("filters")
    if isinstance(filters, dict):
        meta = dict(updated.get("meta") or {})
        active = {
            key: str(filters.get(key) or "").strip()
            for key in ("middleName", "birthday", "wildcard")
            if str(filters.get(key) or "").strip()
        }
        if active:
            meta["report_filters"] = active
        else:
            meta.pop("report_filters", None)
        updated["meta"] = meta

    if not _update_session_search_context(store, updated):
        return jsonify({"ok": False, "error": "Could not update report."}), 400

    return jsonify({"ok": True})


@app.route("/search/report", endpoint="search_report")
@_require_login
def search_report():
    store = load_store()
    context_payload = _load_session_search_context(store)
    if not context_payload:
        flash("Complete an investigation search before opening the intelligence report.", "error")
        return redirect(url_for("search"))
    return render_template(
        "search_report.html",
        context_payload=context_payload,
        workspace_page_class=" page-workspace-contextual",
    )


@app.route("/search/print")
@_require_login
def search_print():
    store = load_store()
    context_payload = _load_session_search_context(store)
    if not context_payload:
        flash("Complete a search before opening the printable report.", "error")
        return redirect(url_for("search"))
    return render_template("search_print.html", context_payload=context_payload, actor=_actor_label())


@app.route("/search/export.csv")
@_require_login
def search_export_csv():
    store = load_store()
    context_payload = _load_session_search_context(store)
    if not context_payload:
        flash("Complete a search before exporting.", "error")
        return redirect(url_for("search"))

    rows = io.StringIO()
    writer = csv.writer(rows)
    meta = context_payload.get("meta") if isinstance(context_payload.get("meta"), dict) else {}
    query = context_payload.get("query") if isinstance(context_payload.get("query"), dict) else {}
    result = context_payload.get("result") if isinstance(context_payload.get("result"), dict) else {}
    writer.writerow(["operator", meta.get("operator", _actor_label())])
    writer.writerow(["created_at", meta.get("created_at", "")])
    writer.writerow(["query_type", query.get("type", "")])
    writer.writerow(["query_value", query.get("value", "")])
    writer.writerow([])
    writer.writerow(["profile", "field", "value"])
    image_origin = _intel_image_origin()
    for profile_key, profile_value in _profile_source(result).items():
        for field, val in _flatten_rows(profile_value):
            safe_val = user_intel.redact_image_export_value(field, val, allowed=True)
            if user_intel.row_value_is_image_content(field, str(val)) and image_origin:
                safe_val = user_intel.resolve_intel_image_url(str(val), image_origin)
            safe_val = user_intel.mask_easytrip_email_value(field, safe_val)
            writer.writerow([_friendly_label(str(profile_key)), _friendly_label(field), safe_val])

    return Response(
        rows.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="intelligence-report.csv"',
            "Cache-Control": "no-store",
        },
    )


@app.route("/team", methods=["GET", "POST"])
@_require_login
@_require_owner
def team():
    store = load_store()
    if request.method == "POST":
        action = (request.form.get("form_action") or "").strip()
        if action == "create":
            username = (request.form.get("username") or "").strip().lower()
            password = (request.form.get("password") or "").strip()
            display_name = (request.form.get("display_name") or username).strip()
            cfg = _config(store)
            if not username or not password:
                flash("Username and password are required.", "error")
            elif username == (cfg.get("owner_username") or "").strip().lower():
                flash("That username is reserved for the owner.", "error")
            elif team_by_username(store, username):
                flash("Username already exists.", "error")
            else:
                store.setdefault("team", []).append(
                    {
                        "id": new_id(),
                        "username": username,
                        "display_name": display_name,
                        "password_hash": generate_password_hash(password),
                        "active": True,
                        "created_at": _utc_now(),
                        "updated_at": _utc_now(),
                    }
                )
                append_audit(store, _actor_label(), "team_add", username)
                save_store(store)
                flash("Team member added.", "info")
                return redirect(url_for("team"))
        elif action == "update":
            member_id = (request.form.get("member_id") or "").strip()
            member = team_by_id(store, member_id)
            if not member:
                flash("Member not found.", "error")
            else:
                display_name = (request.form.get("display_name") or member.get("display_name") or "").strip()
                password = (request.form.get("password") or "").strip()
                member["display_name"] = display_name or member.get("username")
                member["active"] = request.form.get("active") == "1"
                if password:
                    member["password_hash"] = generate_password_hash(password)
                member["updated_at"] = _utc_now()
                append_audit(store, _actor_label(), "team_update", member.get("username", ""))
                save_store(store)
                flash("Team member updated.", "info")
                return redirect(url_for("team"))
        elif action == "delete":
            member_id = (request.form.get("member_id") or "").strip()
            member = team_by_id(store, member_id)
            if member:
                store["team"] = [m for m in store.get("team", []) if m.get("id") != member_id]
                append_audit(store, _actor_label(), "team_delete", member.get("username", ""))
                save_store(store)
                flash("Team member removed.", "info")
                return redirect(url_for("team"))

    return render_template("team.html", team=store.get("team", []))


@app.route("/logs")
@_require_login
@_require_owner
def logs():
    store = load_store()
    tab = (request.args.get("tab") or "search").strip()
    return render_template(
        "logs.html",
        tab=tab,
        audit_logs=store.get("audit_logs", [])[:200],
        search_logs=store.get("search_logs", [])[:200],
    )


@app.route("/api/account")
@_require_login
def api_account_snapshot():
    store = load_store()
    account = _fetch_account(store)
    if not account:
        return jsonify({"ok": False, "error": "Could not reach Kryx API."}), 502
    return jsonify({"ok": True, "account": account})


if __name__ == "__main__":
    port = int(os.environ.get("KRYX_CLIENT_PORT", "8990"))
    debug = os.environ.get("KRYX_CLIENT_DEBUG", "").strip().lower() in ("1", "true", "yes")
    app.run(host="127.0.0.1", port=port, debug=debug)
