"""Kryx Client — team workspace that searches via the main Kryx API (shared credits)."""

from __future__ import annotations

import csv
import io
import mimetypes
import os
import re
import secrets
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

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

import client_ops
import client_security
import kryx_api
import system_stats
import user_intel
from client_ops import (
    DEFAULT_TEAM_ROLE,
    active_jobs_snapshot,
    attention_flags,
    actor_usage_charts,
    actor_usage_stats,
    client_ip_from_request,
    clear_login_failures,
    login_rate_blocked,
    mask_search_display_value,
    normalize_team_role,
    recent_search_rows,
    record_login_failure,
)
from kryx_api import KryxApiError
from store import (
    DATA_DIR,
    REPORT_CONTEXT_MAX,
    append_audit,
    append_search_log,
    client_store_snapshot,
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
SESSION_AUTH_SESSION_ID = "client_auth_session_id"
SESSION_AUTH_EPOCH = "client_auth_epoch"
SESSION_PENDING_2FA_ACTOR = "client_pending_2fa_actor"
SESSION_PENDING_2FA_AT = "client_pending_2fa_at"
SESSION_TOTP_SETUP_SECRET = "client_totp_setup_secret"
SESSION_RECOVERY_PLAIN = "client_recovery_plain"
SESSION_MUST_CHANGE_PASSWORD = "client_must_change_password"

PENDING_2FA_TTL_SEC = 300
SECURITY_PEPPER = (
    os.environ.get("KRYX_CLIENT_SECURITY_PEPPER")
    or os.environ.get("KRYX_CLIENT_SECRET_KEY")
    or "change-kryx-client-secret-in-production"
)

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

CLIENT_SEARCH_JOBS: Dict[str, Dict[str, Any]] = {}
_CLIENT_SEARCH_JOBS_LOCK = threading.Lock()
CLIENT_SEARCH_JOB_TTL_SEC = max(60, int(os.environ.get("KRYX_CLIENT_SEARCH_JOB_TTL", "3600")))
CLIENT_SEARCH_JOB_MAX = max(10, int(os.environ.get("KRYX_CLIENT_SEARCH_JOB_MAX", "200")))


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


def _client_search_job_purge() -> None:
    now = time.time()
    with _CLIENT_SEARCH_JOBS_LOCK:
        expired = [
            jid
            for jid, row in CLIENT_SEARCH_JOBS.items()
            if now - float(row.get("created_at") or now) > CLIENT_SEARCH_JOB_TTL_SEC
        ]
        for jid in expired:
            CLIENT_SEARCH_JOBS.pop(jid, None)
        if len(CLIENT_SEARCH_JOBS) <= CLIENT_SEARCH_JOB_MAX:
            return
        ordered = sorted(
            CLIENT_SEARCH_JOBS.items(),
            key=lambda item: float(item[1].get("created_at") or 0),
        )
        for jid, _row in ordered[: max(0, len(CLIENT_SEARCH_JOBS) - CLIENT_SEARCH_JOB_MAX)]:
            CLIENT_SEARCH_JOBS.pop(jid, None)


def _client_search_job_create(
    actor: str,
    *,
    search_type: str,
    fields: Dict[str, str],
    query_display: str,
) -> str:
    _client_search_job_purge()
    job_id = secrets.token_urlsafe(12)
    now = time.time()
    with _CLIENT_SEARCH_JOBS_LOCK:
        CLIENT_SEARCH_JOBS[job_id] = {
            "job_id": job_id,
            "actor": (actor or "").strip(),
            "search_type": search_type,
            "fields": dict(fields),
            "query_display": query_display,
            "status": "queued",
            "upstream_status": None,
            "error": "",
            "redirect": "",
            "session_applied": False,
            "api_data": None,
            "created_at": now,
            "updated_at": now,
        }
    return job_id


def _finalize_client_search_success(
    store: Dict[str, Any],
    *,
    search_type: str,
    query_display: str,
    data: Dict[str, Any],
    credits_left: int,
    actor: str,
) -> str:
    result = data.get("result")
    query_meta = data.get("query") if isinstance(data.get("query"), dict) else {}
    if not query_meta:
        query_meta = {"type": search_type.upper(), "value": query_display}
    account = _fetch_account(store)
    context_payload = _build_search_context_payload(
        result,
        query_meta,
        account,
        actor=actor,
    )
    _save_session_search_context(store, context_payload)
    append_search_log(
        store,
        actor=actor,
        search_type=search_type,
        query_value=query_display,
        ok=True,
        credits_remaining=credits_left,
    )
    append_audit(store, actor, "search", f"{search_type}: {query_display}")
    cfg = _config(store)
    cfg["last_known_credits"] = credits_left
    store["config"] = cfg
    save_store(store)
    return url_for("search_report")


def _run_client_search_job(job_id: str) -> None:
    with app.app_context():
        with _CLIENT_SEARCH_JOBS_LOCK:
            job = CLIENT_SEARCH_JOBS.get(job_id)
            if not job:
                return
            actor = job["actor"]
            search_type = job["search_type"]
            fields = dict(job.get("fields") or {})
            query_display = job.get("query_display") or ""
            job["status"] = "running"
            job["upstream_status"] = "running"
            job["updated_at"] = time.time()

        store = load_store()
        base, token = _kryx_credentials(store)
        account = _fetch_account(store)
        if account and account.get("expired"):
            err = "Kryx account expired. Renew on Kryx Billing."
            with _CLIENT_SEARCH_JOBS_LOCK:
                row = CLIENT_SEARCH_JOBS.get(job_id)
                if row:
                    row["status"] = "failed"
                    row["error"] = err
                    row["updated_at"] = time.time()
            append_search_log(
                store,
                actor=actor,
                search_type=search_type,
                query_value=query_display,
                ok=False,
                credits_remaining=None,
                error=err,
            )
            append_audit(store, actor, "search_failed", err)
            save_store(store)
            return

        try:
            data, credits_left = kryx_api.search(
                base, token, search_type=search_type, fields=fields
            )
            with _CLIENT_SEARCH_JOBS_LOCK:
                row = CLIENT_SEARCH_JOBS.get(job_id)
                if not row:
                    return
                row["status"] = "done"
                row["upstream_status"] = "done"
                row["api_data"] = data
                row["credits_left"] = credits_left
                row["error"] = ""
                row["updated_at"] = time.time()
        except KryxApiError as exc:
            msg = str(exc)
            if exc.code == "invalid_token":
                msg += " Update the API token under Settings (owner login)."
            with _CLIENT_SEARCH_JOBS_LOCK:
                row = CLIENT_SEARCH_JOBS.get(job_id)
                if row:
                    row["status"] = "failed"
                    row["error"] = msg
                    row["upstream_status"] = "failed"
                    row.pop("api_data", None)
                    row["updated_at"] = time.time()
            append_search_log(
                store,
                actor=actor,
                search_type=search_type,
                query_value=query_display,
                ok=False,
                credits_remaining=None,
                error=str(exc),
            )
            append_audit(store, actor, "search_failed", str(exc))
            save_store(store)


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


def _client_ip() -> str:
    return client_ip_from_request(request)


def _actor_member(store: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if _is_owner():
        return None
    return team_by_username(store, _actor_label())


def _actor_team_role(store: Dict[str, Any]) -> str:
    if _is_owner():
        return "owner"
    member = _actor_member(store)
    if not member:
        return DEFAULT_TEAM_ROLE
    return normalize_team_role(member.get("role"))


def _actor_search_enabled(store: Dict[str, Any]) -> bool:
    if _is_owner():
        return True
    member = _actor_member(store)
    if not member or not member.get("active", True):
        return False
    if member.get("search_enabled", True) is False:
        return False
    if normalize_team_role(member.get("role")) == "auditor":
        return False
    return True


def _actor_can_view_logs(store: Dict[str, Any]) -> bool:
    if _is_owner():
        return True
    role = _actor_team_role(store)
    return role in {"supervisor", "auditor"}


def _actor_logs_scope(store: Dict[str, Any]) -> str:
    if _is_owner():
        return "all"
    role = _actor_team_role(store)
    if role == "supervisor":
        return "own"
    if role == "auditor":
        return "all"
    return "none"


def _owner_security(store: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _config(store)
    sec = cfg.setdefault("owner_security", {})
    client_security.ensure_user_security(sec)
    return sec


def _actor_security_record(store: Dict[str, Any]) -> Dict[str, Any]:
    if _is_owner():
        return _owner_security(store)
    member = _actor_member(store)
    if member is not None:
        client_security.ensure_user_security(member)
        return member
    return {}


def _must_change_password() -> bool:
    return bool(session.get(SESSION_MUST_CHANGE_PASSWORD))


def _set_must_change_password(flag: bool) -> None:
    if flag:
        session[SESSION_MUST_CHANGE_PASSWORD] = "1"
    else:
        session.pop(SESSION_MUST_CHANGE_PASSWORD, None)


def _clear_pending_2fa() -> None:
    session.pop(SESSION_PENDING_2FA_ACTOR, None)
    session.pop(SESSION_PENDING_2FA_AT, None)


def _pending_2fa_actor() -> Optional[str]:
    actor = (session.get(SESSION_PENDING_2FA_ACTOR) or "").strip()
    if not actor:
        return None
    try:
        started = float(session.get(SESSION_PENDING_2FA_AT) or 0)
    except (TypeError, ValueError):
        _clear_pending_2fa()
        return None
    if time.time() - started > PENDING_2FA_TTL_SEC:
        _clear_pending_2fa()
        return None
    return actor


def _security_record_for_actor(store: Dict[str, Any], actor: str, *, is_owner: bool) -> Dict[str, Any]:
    if is_owner:
        return _owner_security(store)
    member = team_by_username(store, actor)
    if member is None:
        return {}
    client_security.ensure_user_security(member)
    return member


def _complete_client_login(store: Dict[str, Any], actor: str, *, is_owner: bool) -> None:
    sec = _security_record_for_actor(store, actor, is_owner=is_owner)
    if not sec:
        return
    sid = secrets.token_urlsafe(18)
    epoch = client_security.register_auth_session(
        sec,
        sid,
        request.headers.get("User-Agent") or "",
        _client_ip(),
        _utc_now(),
    )
    if is_owner:
        store["config"] = _config(store)
    save_store(store)
    session[SESSION_ROLE] = "owner" if is_owner else "team"
    session[SESSION_ACTOR] = actor
    session[SESSION_AUTH_SESSION_ID] = sid
    session[SESSION_AUTH_EPOCH] = epoch
    _set_must_change_password(False)


def _session_valid(store: Dict[str, Any]) -> bool:
    actor = _actor_label()
    if not actor or actor == "unknown":
        return False
    sec = _actor_security_record(store)
    if not sec:
        return False
    sid = (session.get(SESSION_AUTH_SESSION_ID) or "").strip()
    epoch = session.get(SESSION_AUTH_EPOCH)
    if client_security.auth_session_valid(sec, sid, epoch):
        return True
    stored_epoch = int(sec.get("auth_session_epoch", 0) or 0)
    if sid and client_security.auth_session_active(sec, sid):
        session[SESSION_AUTH_EPOCH] = stored_epoch
        return True
    if session.get(SESSION_ACTOR) and not sec.get("auth_sessions"):
        sid = sid or secrets.token_urlsafe(18)
        epoch = client_security.register_auth_session(
            sec,
            sid,
            request.headers.get("User-Agent") or "",
            _client_ip(),
            _utc_now(),
        )
        if _is_owner():
            store["config"] = _config(store)
        save_store(store)
        session[SESSION_AUTH_SESSION_ID] = sid
        session[SESSION_AUTH_EPOCH] = epoch
        return True
    return False


def _touch_session(store: Dict[str, Any]) -> None:
    sec = _actor_security_record(store)
    if sec:
        client_security.touch_auth_session(
            sec,
            (session.get(SESSION_AUTH_SESSION_ID) or "").strip(),
            _utc_now(),
        )
        save_store(store)


def _actor_can_dashboard(store: Dict[str, Any]) -> bool:
    if _is_owner():
        return False
    return _actor_team_role(store) in {"investigator", "supervisor"}


def _home_endpoint_for_actor(store: Dict[str, Any]) -> str:
    if _is_owner():
        return "dashboard"
    role = _actor_team_role(store)
    if role == "auditor":
        return "logs"
    if role in {"investigator", "supervisor"}:
        return "team_dashboard"
    return "search"


def _fetch_account_with_error(store: Dict[str, Any]) -> tuple[Optional[Dict[str, Any]], str]:
    base, token = _kryx_credentials(store)
    if not base or not token:
        return None, "Kryx URL or API token is not configured."
    try:
        account = kryx_api.get_account_or_probe(base, token)
        if account and account.get("account_endpoint_missing"):
            last_credits = _config(store).get("last_known_credits")
            if last_credits is not None:
                account = dict(account)
                account["credits"] = int(last_credits)
        return account, ""
    except KryxApiError as exc:
        msg = str(exc)
        if exc.code == "invalid_token":
            msg += " Update the API token under Settings."
        return None, msg


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
            return redirect(url_for(_home_endpoint_for_actor(load_store())))
        return f(*args, **kwargs)

    return wrapper


def _require_search(f: Callable):
    @wraps(f)
    def wrapper(*args, **kwargs):
        store = load_store()
        if _must_change_password():
            return redirect(url_for("change_password"))
        if not _actor_search_enabled(store):
            flash("Search is not available for your account.", "error")
            return redirect(url_for(_home_endpoint_for_actor(store)))
        return f(*args, **kwargs)

    return wrapper


def _require_logs(f: Callable):
    @wraps(f)
    def wrapper(*args, **kwargs):
        store = load_store()
        if _must_change_password():
            return redirect(url_for("change_password"))
        if not _actor_can_view_logs(store):
            flash("You do not have access to logs.", "error")
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
    if request.method == "POST" and endpoint not in {"setup", "login", "verify_2fa"}:
        token = (request.form.get("csrf_token") or request.headers.get("X-CSRF-Token") or "").strip()
        if not _valid_csrf(token):
            if endpoint in {"search_report_context_sync", "search_jobs_create", "dashboard_api_live", "team_dashboard_api_live"}:
                return jsonify({"ok": False, "error": "Security check failed."}), 403
            flash("Security check failed. Refresh and try again.", "error")
            return redirect(request.referrer or url_for("dashboard"))

    if session.get(SESSION_ACTOR) and endpoint not in {
        "setup",
        "login",
        "logout",
        "verify_2fa",
        "change_password",
        "static",
        "client_brand_logo",
    }:
        if not _session_valid(store):
            session.clear()
            flash("Your session was revoked or expired. Sign in again.", "error")
            return redirect(url_for("login"))
        _touch_session(store)
        if _must_change_password() and endpoint not in {"change_password", "logout"}:
            return redirect(url_for("change_password"))


@app.context_processor
def inject_globals():
    endpoint = request.endpoint or ""
    actor = _actor_label()
    initials = (actor.replace(".", "").replace("_", "")[:2] or "U").upper()
    show_workspace = bool(session.get(SESSION_ACTOR) and endpoint not in {"setup", "login", "verify_2fa"})
    store = load_store()
    cfg = _config(store)
    org_name = (cfg.get("organization_name") or "My team").strip() or "My team"
    team_role = _actor_team_role(store) if session.get(SESSION_ACTOR) else ""
    return {
        "csrf_token": _csrf_token(),
        "is_owner": _is_owner(),
        "actor": actor,
        "actor_initials": initials,
        "workspace_nav_endpoint": endpoint,
        "show_workspace": show_workspace,
        "client_logo_url": _client_logo_url(),
        "client_org_name": org_name,
        "client_team_role": team_role,
        "client_can_search": _actor_search_enabled(store) if session.get(SESSION_ACTOR) else False,
        "client_can_logs": _actor_can_view_logs(store) if session.get(SESSION_ACTOR) else False,
        "client_can_dashboard": _actor_can_dashboard(store) if session.get(SESSION_ACTOR) else False,
        "client_totp_enabled": client_security.totp_is_enabled(_actor_security_record(store))
        if session.get(SESSION_ACTOR)
        else False,
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
    account, _err = _fetch_account_with_error(store)
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
    store = load_store()
    return redirect(url_for(_home_endpoint_for_actor(store)))


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
        if login_rate_blocked(_client_ip()):
            flash("Too many failed sign-in attempts. Try again in about 15 minutes.", "error")
            return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)

        username = (request.form.get("username") or "").strip().lower()
        password = request.form.get("password") or ""
        is_owner_login = username == (cfg.get("owner_username") or "").strip().lower()
        member = None if is_owner_login else team_by_username(store, username)

        authenticated = False
        must_change = False
        sec: Dict[str, Any] = {}

        if is_owner_login:
            if check_password_hash(cfg.get("owner_password_hash") or "", password):
                authenticated = True
                sec = _owner_security(store)
        elif member and check_password_hash(member.get("password_hash") or "", password):
            if not member.get("active", True):
                flash("This account is inactive. Contact the workspace owner.", "error")
                return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)
            authenticated = True
            must_change = bool(member.get("must_change_password"))
            client_security.ensure_user_security(member)
            sec = member

        if not authenticated:
            record_login_failure(_client_ip())
            append_audit(store, username or "unknown", "login_failed", "Invalid credentials")
            save_store(store)
            flash("Invalid username or password.", "error")
            return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)

        clear_login_failures(_client_ip())

        if client_security.totp_is_enabled(sec):
            session[SESSION_PENDING_2FA_ACTOR] = username
            session[SESSION_PENDING_2FA_AT] = str(time.time())
            session[SESSION_ROLE] = "owner" if is_owner_login else "team"
            if must_change:
                session[SESSION_MUST_CHANGE_PASSWORD] = "1"
            return redirect(url_for("verify_2fa"))

        _complete_client_login(store, username, is_owner=is_owner_login)
        if must_change:
            _set_must_change_password(True)
        append_audit(store, username, "login", "Owner signed in" if is_owner_login else "Team member signed in")
        save_store(store)
        return redirect(url_for(_home_endpoint_for_actor(store)))

    return render_template("login.html", org_name=cfg.get("organization_name"), config=cfg)


@app.route("/verify-2fa", methods=["GET", "POST"])
def verify_2fa():
    store = load_store()
    actor = _pending_2fa_actor()
    if not actor:
        return redirect(url_for("login"))
    cfg = _config(store)
    is_owner_login = actor == (cfg.get("owner_username") or "").strip().lower()
    if is_owner_login:
        sec = _owner_security(store)
    else:
        member = team_by_username(store, actor)
        sec = member or {}
        client_security.ensure_user_security(sec)
    if request.method == "POST":
        code = (request.form.get("totp_code") or "").strip()
        ok = client_security.verify_totp_code(sec, code)
        if not ok:
            ok = client_security.consume_recovery_code(sec, SECURITY_PEPPER, code, _utc_now())
        if not ok:
            flash("Authenticator or recovery code did not match.", "error")
            return render_template("verify_2fa.html", actor=actor)
        must_change = bool(session.get(SESSION_MUST_CHANGE_PASSWORD))
        _clear_pending_2fa()
        _complete_client_login(store, actor, is_owner=is_owner_login)
        if must_change:
            _set_must_change_password(True)
        append_audit(store, actor, "login", "2FA verified")
        save_store(store)
        return redirect(url_for("change_password" if _must_change_password() else _home_endpoint_for_actor(store)))
    return render_template("verify_2fa.html", actor=actor)


@app.route("/change-password", methods=["GET", "POST"])
@_require_login
def change_password():
    store = load_store()
    cfg = _config(store)
    actor = _actor_label()
    is_owner_user = _is_owner()
    member = _actor_member(store)
    if request.method == "POST":
        current = request.form.get("current_password") or ""
        new_pw = (request.form.get("new_password") or "").strip()
        confirm = (request.form.get("confirm_password") or "").strip()
        if len(new_pw) < 8:
            flash("New password must be at least 8 characters.", "error")
        elif new_pw != confirm:
            flash("New passwords do not match.", "error")
        elif is_owner_user:
            if not check_password_hash(cfg.get("owner_password_hash") or "", current):
                flash("Current password is incorrect.", "error")
            else:
                cfg["owner_password_hash"] = generate_password_hash(new_pw)
                store["config"] = cfg
                _set_must_change_password(False)
                append_audit(store, actor, "password_changed", "Owner password updated")
                save_store(store)
                flash("Password updated.", "info")
                return redirect(url_for(_home_endpoint_for_actor(store)))
        elif member:
            if not check_password_hash(member.get("password_hash") or "", current):
                flash("Current password is incorrect.", "error")
            else:
                member["password_hash"] = generate_password_hash(new_pw)
                member["must_change_password"] = False
                member["updated_at"] = _utc_now()
                _set_must_change_password(False)
                append_audit(store, actor, "password_changed", "Team password updated")
                save_store(store)
                flash("Password updated.", "info")
                return redirect(url_for(_home_endpoint_for_actor(store)))
        else:
            flash("Account not found.", "error")
    return render_template("change_password.html", forced=_must_change_password())


@app.route("/logout")
def logout():
    actor = _actor_label()
    store = load_store()
    if actor != "unknown":
        sec = _actor_security_record(store)
        sid = (session.get(SESSION_AUTH_SESSION_ID) or "").strip()
        if sec and sid:
            client_security.revoke_auth_session(sec, sid)
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
        action = (request.form.get("form_action") or "save").strip()
        if action == "change_owner_password":
            current = request.form.get("current_password") or ""
            new_pw = (request.form.get("new_password") or "").strip()
            confirm = (request.form.get("confirm_password") or "").strip()
            if len(new_pw) < 8:
                flash("New password must be at least 8 characters.", "error")
            elif new_pw != confirm:
                flash("New passwords do not match.", "error")
            elif not check_password_hash(cfg.get("owner_password_hash") or "", current):
                flash("Current owner password is incorrect.", "error")
            else:
                cfg["owner_password_hash"] = generate_password_hash(new_pw)
                store["config"] = cfg
                append_audit(store, _actor_label(), "password_changed", "Owner password updated in settings")
                save_store(store)
                flash("Owner password updated.", "info")
                return redirect(url_for("settings"))

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


@app.route("/dashboard/api/live", endpoint="dashboard_api_live")
@_require_login
@_require_owner
def dashboard_api_live():
    store = load_store()
    account, api_error = _fetch_account_with_error(store)
    base, _token = _kryx_credentials(store)
    health = kryx_api.fetch_search_health(base) if base else {"reachable": False, "degraded": True}
    return jsonify(
        {
            "ok": True,
            "account_ok": account is not None and not api_error,
            "api_error": api_error,
            "account": {
                "credits": int((account or {}).get("credits") or 0),
                "monthly_search_used": int((account or {}).get("monthly_search_used") or 0),
                "monthly_search_limit": int((account or {}).get("monthly_search_limit") or 0),
            }
            if account
            else None,
            "search_health": health,
            "active_jobs": active_jobs_snapshot(CLIENT_SEARCH_JOBS),
        }
    )


@app.route("/dashboard/api/system-memory", endpoint="dashboard_api_system_memory")
@_require_login
@_require_owner
def dashboard_api_system_memory():
    return jsonify(system_stats.system_memory_snapshot())


@app.route("/dashboard/api/system-cpu", endpoint="dashboard_api_system_cpu")
@_require_login
@_require_owner
def dashboard_api_system_cpu():
    return jsonify(system_stats.system_cpu_snapshot())


@app.route("/dashboard")
@_require_login
@_require_owner
def dashboard():
    store = load_store()
    account, api_error = _fetch_account_with_error(store)
    charts = _usage_charts(store, account)
    data_store = client_store_snapshot(store)
    base, _token = _kryx_credentials(store)
    search_health = kryx_api.fetch_search_health(base) if base else None
    flags = attention_flags(
        store,
        account,
        api_error=api_error,
        data_store_level=data_store.get("level") or "ok",
        report_context_count=data_store.get("report_context_count") or 0,
        report_context_max=data_store.get("report_context_max") or REPORT_CONTEXT_MAX,
    )
    return render_template(
        "dashboard.html",
        account=account,
        charts=charts,
        config=_config(store),
        team_count=len(store.get("team", [])),
        data_store=data_store,
        attention_flags=flags,
        api_error=api_error,
        search_health=search_health or {},
        recent_searches=recent_search_rows(store.get("search_logs", [])),
        active_jobs=active_jobs_snapshot(CLIENT_SEARCH_JOBS),
        security_sessions=client_security.active_session_count(_owner_security(store)),
        owner_totp_enabled=client_security.totp_is_enabled(_owner_security(store)),
    )


@app.route("/my-dashboard")
@_require_login
def team_dashboard():
    store = load_store()
    if _is_owner():
        return redirect(url_for("dashboard"))
    role = _actor_team_role(store)
    if role == "auditor":
        return redirect(url_for("logs"))
    if role not in {"investigator", "supervisor"}:
        return redirect(url_for("search"))
    account = _fetch_account(store)
    actor = _actor_label()
    usage = actor_usage_stats(store, actor, account)
    charts = actor_usage_charts(store, actor, account)
    flags = []
    if account:
        credits = int(account.get("credits") or 0)
        monthly_limit = int(account.get("monthly_search_limit") or 0)
        monthly_used = int(account.get("monthly_search_used") or 0)
        if credits <= 5:
            flags.append({"level": "warn", "title": f"Shared credits low ({credits})", "detail": "Inform the workspace owner."})
        if monthly_limit > 0 and monthly_used >= max(1, int(monthly_limit * 0.9)):
            flags.append({"level": "warn", "title": "Shared search cap almost reached", "detail": f"{monthly_used}/{monthly_limit} used on the Kryx account."})
    if charts.get("failed_30d"):
        flags.append(
            {
                "level": "warn",
                "title": f"{charts['failed_30d']} failed search attempt(s) in the last 30 days",
                "detail": "Review errors in your logs or retry when the upstream is healthy.",
            }
        )
    return render_template(
        "team_dashboard.html",
        account=account,
        usage=usage,
        charts=charts,
        attention_flags=flags,
        recent_searches=recent_search_rows(
            [r for r in store.get("search_logs", []) if (r.get("actor") or "").strip().lower() == actor.lower()],
            limit=8,
        ),
        active_jobs=active_jobs_snapshot(CLIENT_SEARCH_JOBS, actor=actor),
    )


@app.route("/my-dashboard/api/live", endpoint="team_dashboard_api_live")
@_require_login
def team_dashboard_api_live():
    store = load_store()
    if not _actor_can_dashboard(store):
        return jsonify({"ok": False, "error": "Forbidden."}), 403
    account, api_error = _fetch_account_with_error(store)
    actor = _actor_label()
    return jsonify(
        {
            "ok": True,
            "account_ok": account is not None and not api_error,
            "api_error": api_error,
            "account": {
                "credits": int((account or {}).get("credits") or 0),
                "monthly_search_used": int((account or {}).get("monthly_search_used") or 0),
                "monthly_search_limit": int((account or {}).get("monthly_search_limit") or 0),
            }
            if account
            else None,
            "active_jobs": active_jobs_snapshot(CLIENT_SEARCH_JOBS, actor=actor),
        }
    )


@app.route("/search/jobs", methods=["POST"], endpoint="search_jobs_create")
@_require_login
@_require_search
def search_jobs_create():
    """Start an async client search; browser polls GET /search/jobs/<id>."""
    store = load_store()
    account = _fetch_account(store)
    active_type = (request.form.get("search_type") or "username").strip()
    if active_type not in SEARCH_TYPES:
        active_type = "username"

    fields, query_display, validation_error = _search_fields_from_request(active_type, request.form)
    if validation_error:
        return jsonify({"ok": False, "error": validation_error}), 400
    if account and account.get("expired"):
        return jsonify({"ok": False, "error": "Kryx account expired. Renew on Kryx Billing."}), 400

    actor = _actor_label()
    job_id = _client_search_job_create(
        actor,
        search_type=active_type,
        fields=fields,
        query_display=query_display,
    )
    threading.Thread(target=_run_client_search_job, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True, "job_id": job_id, "status": "queued"}), 202


@app.route("/search/jobs/<job_id>", methods=["GET"], endpoint="search_jobs_poll")
@_require_login
def search_jobs_poll(job_id: str):
    """Poll client-side search job; applies session when Kryx API search completes."""
    jid = (job_id or "").strip()
    actor = _actor_label()
    apply_now = False
    api_data: Dict[str, Any] = {}
    search_type = ""
    query_display = ""
    credits_left = 0

    with _CLIENT_SEARCH_JOBS_LOCK:
        row = CLIENT_SEARCH_JOBS.get(jid)
        if not row or (row.get("actor") or "").strip() != actor:
            return jsonify({"ok": False, "error": "Job not found."}), 404
        if row.get("status") == "done" and not row.get("session_applied"):
            apply_now = True
            api_data = dict(row.get("api_data") or {})
            search_type = row.get("search_type") or "username"
            query_display = row.get("query_display") or ""
            credits_left = int(row.get("credits_left") or 0)
            row["session_applied"] = True

    if apply_now:
        store = load_store()
        try:
            redirect_url = _finalize_client_search_success(
                store,
                search_type=search_type,
                query_display=query_display,
                data=api_data,
                credits_left=credits_left,
                actor=actor,
            )
            with _CLIENT_SEARCH_JOBS_LOCK:
                row = CLIENT_SEARCH_JOBS.get(jid)
                if row:
                    row["redirect"] = redirect_url
                    row.pop("api_data", None)
        except Exception:
            with _CLIENT_SEARCH_JOBS_LOCK:
                row = CLIENT_SEARCH_JOBS.get(jid)
                if row:
                    row["status"] = "failed"
                    row["error"] = "Search could not be finalized. Please try again."
                    row.pop("api_data", None)

    with _CLIENT_SEARCH_JOBS_LOCK:
        row = CLIENT_SEARCH_JOBS.get(jid) or {}

    payload: Dict[str, Any] = {
        "ok": True,
        "job_id": jid,
        "status": row.get("status") or "queued",
    }
    upstream_status = row.get("upstream_status")
    if upstream_status:
        payload["upstream_status"] = upstream_status
    if row.get("status") == "done" and row.get("redirect"):
        payload["redirect"] = row["redirect"]
    if row.get("status") == "failed":
        payload["error"] = row.get("error") or "Search failed."
    return jsonify(payload)


@app.route("/search", methods=["GET", "POST"], endpoint="search")
@_require_login
@_require_search
def search_page():
    store = load_store()
    account = _fetch_account(store)
    active_type = (request.form.get("search_type") or request.args.get("type") or "username").strip()
    if active_type not in SEARCH_TYPES:
        active_type = "username"
    prefill: Dict[str, str] = {}
    q = (request.args.get("q") or "").strip()
    if request.args.get("first_name") or request.args.get("last_name"):
        prefill["first_name"] = (request.args.get("first_name") or "").strip()
        prefill["last_name"] = (request.args.get("last_name") or "").strip()
    elif active_type == "username":
        prefill["username"] = q
    elif active_type == "phone":
        prefill["phone"] = q
    elif active_type == "email":
        prefill["email"] = q
    elif active_type == "plate_number":
        prefill["plate_number"] = q
    elif active_type == "passport_number":
        prefill["passport_number"] = q

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
                _finalize_client_search_success(
                    store,
                    search_type=active_type,
                    query_display=query_display,
                    data=data,
                    credits_left=credits_left,
                    actor=_actor_label(),
                )
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
        search_prefill=prefill,
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
@_require_search
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
@_require_search
def search_print():
    store = load_store()
    context_payload = _load_session_search_context(store)
    if not context_payload:
        flash("Complete a search before opening the printable report.", "error")
        return redirect(url_for("search"))
    return render_template("search_print.html", context_payload=context_payload, actor=_actor_label())


@app.route("/search/export.csv")
@_require_login
@_require_search
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


@app.route("/security", methods=["GET", "POST"])
@_require_login
def security():
    store = load_store()
    sec = _actor_security_record(store)
    actor = _actor_label()
    if request.method == "POST":
        form_action = (request.form.get("form_action") or "").strip()
        password = (request.form.get("current_password") or "").strip()
        totp_code = (request.form.get("totp_code") or "").strip()

        if form_action == "start_totp_setup":
            if client_security.totp_is_enabled(sec):
                flash("Two-factor authentication is already enabled.", "error")
            else:
                session[SESSION_TOTP_SETUP_SECRET] = client_security.generate_totp_secret()
                flash("Scan the QR code, then enter a code from your authenticator app.", "info")
            return redirect(url_for("security"))

        if form_action == "confirm_totp_setup":
            setup_secret = (session.get(SESSION_TOTP_SETUP_SECRET) or "").strip()
            verify_code = (request.form.get("verify_code") or "").strip()
            if not setup_secret:
                flash("Start authenticator setup again.", "error")
                return redirect(url_for("security"))
            if not client_security.verify_totp_code({"totp_secret": setup_secret}, verify_code):
                flash("Authenticator code did not match. Try again.", "error")
                return redirect(url_for("security"))
            issued = client_security.enable_totp(sec, setup_secret, SECURITY_PEPPER)
            session.pop(SESSION_TOTP_SETUP_SECRET, None)
            session[SESSION_RECOVERY_PLAIN] = issued
            append_audit(store, actor, "totp_enabled", "2FA enabled")
            save_store(store)
            flash("Two-factor authentication is now enabled. Save your recovery codes.", "info")
            return redirect(url_for("security"))

        if form_action == "reset_totp":
            cfg = _config(store)
            if _is_owner():
                if not check_password_hash(cfg.get("owner_password_hash") or "", password):
                    flash("Current password is incorrect.", "error")
                    return redirect(url_for("security"))
            else:
                member = _actor_member(store)
                if not member or not check_password_hash(member.get("password_hash") or "", password):
                    flash("Current password is incorrect.", "error")
                    return redirect(url_for("security"))
            if not client_security.verify_totp_code(sec, totp_code) and not client_security.consume_recovery_code(
                sec, SECURITY_PEPPER, totp_code, _utc_now()
            ):
                flash("Authenticator or recovery code did not match.", "error")
                return redirect(url_for("security"))
            client_security.disable_totp(sec)
            append_audit(store, actor, "totp_disabled", "2FA reset")
            save_store(store)
            flash("Two-factor authentication has been reset.", "info")
            return redirect(url_for("security"))

    setup_secret = (session.get(SESSION_TOTP_SETUP_SECRET) or "").strip()
    recovery_plain = session.pop(SESSION_RECOVERY_PLAIN, None)
    qr_url = ""
    if setup_secret:
        qr_url = client_security.totp_provisioning_uri(actor, setup_secret)
    return render_template(
        "security.html",
        security_totp_enabled=client_security.totp_is_enabled(sec),
        security_setup_pending=bool(setup_secret),
        security_totp_qr_url=(
            f"https://api.qrserver.com/v1/create-qr-code/?size=180x180&data={quote(qr_url)}"
            if qr_url
            else ""
        ),
        security_recovery_plain=recovery_plain or [],
        security_active_sessions=client_security.active_session_count(sec),
    )


@app.route("/security/sessions", methods=["GET", "POST"])
@_require_login
def security_sessions():
    store = load_store()
    sec = _actor_security_record(store)
    current_sid = (session.get(SESSION_AUTH_SESSION_ID) or "").strip()
    if request.method == "POST":
        action = (request.form.get("form_action") or "").strip()
        target_sid = (request.form.get("session_id") or "").strip()
        if action == "revoke" and target_sid:
            client_security.revoke_auth_session(sec, target_sid)
            append_audit(store, _actor_label(), "session_revoked", target_sid[:8])
            save_store(store)
            flash("Session revoked.", "info")
        elif action == "revoke_others":
            removed = client_security.revoke_other_auth_sessions(sec, current_sid)
            append_audit(store, _actor_label(), "session_revoked_others", f"{removed} removed")
            save_store(store)
            flash("Other sessions signed out.", "info")
        return redirect(url_for("security_sessions"))
    sessions = client_security.list_auth_sessions(sec)
    return render_template(
        "security_sessions.html",
        security_sessions=sessions,
        security_current_session_id=current_sid,
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
                role = normalize_team_role(request.form.get("role"))
                force_reset = request.form.get("must_change_password") == "1"
                store.setdefault("team", []).append(
                    {
                        "id": new_id(),
                        "username": username,
                        "display_name": display_name,
                        "password_hash": generate_password_hash(password),
                        "active": True,
                        "role": role,
                        "search_enabled": request.form.get("search_enabled") == "1",
                        "must_change_password": force_reset,
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
                member["role"] = normalize_team_role(request.form.get("role") or member.get("role"))
                member["search_enabled"] = request.form.get("search_enabled") == "1"
                if request.form.get("must_change_password") == "1":
                    member["must_change_password"] = True
                if password:
                    member["password_hash"] = generate_password_hash(password)
                    member["must_change_password"] = request.form.get("must_change_password") == "1"
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
@_require_logs
def logs():
    store = load_store()
    tab = (request.args.get("tab") or "search").strip()
    scope = _actor_logs_scope(store)
    actor = _actor_label()
    search_logs = list(store.get("search_logs", []))
    if scope == "own":
        search_logs = [
            r for r in search_logs if (r.get("actor") or "").strip().lower() == actor.lower()
        ]
    for row in search_logs:
        st = (row.get("search_type") or "").strip()
        val = (row.get("query_value") or "").strip()
        row["display_value_masked"] = mask_search_display_value(st, val)
        row["display_value_full"] = val or "—"
    audit_logs = store.get("audit_logs", []) if scope == "all" else []
    return render_template(
        "logs.html",
        tab=tab,
        audit_logs=audit_logs[:200],
        search_logs=search_logs[:200],
        logs_scope=scope,
    )


@app.route("/logs/export.csv")
@_require_login
@_require_logs
def logs_export_csv():
    store = load_store()
    tab = (request.args.get("tab") or "search").strip()
    scope = _actor_logs_scope(store)
    actor = _actor_label()
    rows = io.StringIO()
    writer = csv.writer(rows)
    if tab == "audit" and scope == "all":
        writer.writerow(["created_at", "actor", "action", "details"])
        for row in store.get("audit_logs", []):
            writer.writerow(
                [
                    row.get("created_at") or "",
                    row.get("actor") or "",
                    row.get("action") or "",
                    row.get("details") or "",
                ]
            )
        filename = "client-audit-logs.csv"
    else:
        writer.writerow(["created_at", "actor", "search_type", "query_value", "ok", "credits_remaining", "error"])
        search_logs = store.get("search_logs", [])
        if scope == "own":
            search_logs = [
                r for r in search_logs if (r.get("actor") or "").strip().lower() == actor.lower()
            ]
        for row in search_logs:
            writer.writerow(
                [
                    row.get("created_at") or "",
                    row.get("actor") or "",
                    row.get("search_type") or "",
                    row.get("query_value") or "",
                    "yes" if row.get("ok") else "no",
                    row.get("credits_remaining") if row.get("credits_remaining") is not None else "",
                    row.get("error") or "",
                ]
            )
        filename = "client-search-logs.csv"
    return Response(
        rows.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
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
