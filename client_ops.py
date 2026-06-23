"""Dashboard, privacy masking, and access helpers for Kryx Client."""

from __future__ import annotations

import re
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Any, Deque, Dict, List, Optional

from flask import url_for

CLIENT_TEAM_ROLES = frozenset({"investigator", "supervisor", "auditor"})
DEFAULT_TEAM_ROLE = "investigator"

_LOGIN_FAILS: Dict[str, Deque[float]] = defaultdict(deque)
_LOGIN_WINDOW_SEC = 900
_LOGIN_MAX_FAILS = 10


def client_ip_from_request(request) -> str:
    forwarded = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    return forwarded or (request.remote_addr or "unknown")


def login_failures_prune(key: str) -> None:
    now = time.monotonic()
    dq = _LOGIN_FAILS[key]
    while dq and dq[0] < now - _LOGIN_WINDOW_SEC:
        dq.popleft()


def login_rate_blocked(ip: str) -> bool:
    login_failures_prune(ip)
    return len(_LOGIN_FAILS[ip]) >= _LOGIN_MAX_FAILS


def record_login_failure(ip: str) -> None:
    login_failures_prune(ip)
    _LOGIN_FAILS[ip].append(time.monotonic())


def clear_login_failures(ip: str) -> None:
    _LOGIN_FAILS.pop(ip, None)


def normalize_team_role(raw: str) -> str:
    role = (raw or DEFAULT_TEAM_ROLE).strip().lower()
    return role if role in CLIENT_TEAM_ROLES else DEFAULT_TEAM_ROLE


def mask_search_display_value(search_type: str, value: str) -> str:
    v = (value or "").strip()
    if not v:
        return "—"
    qt = (search_type or "").strip().upper()

    def _mask_token(token: str) -> str:
        token = token.strip()
        if not token:
            return "***"
        if len(token) <= 1:
            return token[0] + "***"
        if len(token) <= 3:
            return token[0] + "***"
        return token[:2] + "***" + token[-1]

    if qt == "EMAIL" and "@" in v:
        local, _, domain = v.partition("@")
        return f"{_mask_token(local)}@{domain}"
    if qt in {"MOBILENO", "PHONE"}:
        digits = re.sub(r"\D", "", v)
        if len(digits) <= 4:
            return "***"
        return "***" + digits[-4:]
    if "NAME" in qt or search_type == "name":
        parts = v.split(None, 1)
        if len(parts) == 2:
            return f"{_mask_token(parts[0])} {_mask_token(parts[1])}"
        return _mask_token(parts[0]) if parts else "***"
    return _mask_token(v)


def search_rerun_url(search_type: str, query_value: str) -> str:
    st = (search_type or "username").strip().lower()
    params: Dict[str, str] = {"type": st}
    value = (query_value or "").strip()
    if st == "name":
        parts = value.split(None, 1)
        params["first_name"] = parts[0] if parts else ""
        params["last_name"] = parts[1] if len(parts) > 1 else ""
    elif value:
        params["q"] = value
    return url_for("search", **params)


def recent_search_rows(
    search_logs: List[Dict[str, Any]], *, limit: int = 8
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for row in search_logs:
        if not row.get("ok"):
            continue
        st = (row.get("search_type") or "").strip()
        val = (row.get("query_value") or "").strip()
        rows.append(
            {
                "search_type": st,
                "query_value": val,
                "created_at": row.get("created_at") or "",
                "actor": row.get("actor") or "",
                "display_value_masked": mask_search_display_value(st, val),
                "display_value_full": val or "—",
                "rerun_url": search_rerun_url(st, val),
            }
        )
        if len(rows) >= limit:
            break
    return rows


def active_jobs_snapshot(jobs: Dict[str, Dict[str, Any]], *, actor: str = "") -> List[Dict[str, Any]]:
    now = time.time()
    target = (actor or "").strip().lower()
    out: List[Dict[str, Any]] = []
    for job_id, row in jobs.items():
        if target and (row.get("actor") or "").strip().lower() != target:
            continue
        status = (row.get("status") or "queued").strip().lower()
        if status not in {"queued", "running", "failed"}:
            continue
        started = float(row.get("created_at") or now)
        age_sec = now - started
        out.append(
            {
                "job_id": job_id,
                "status": status,
                "search_type": (row.get("search_type") or "username").strip(),
                "actor": (row.get("actor") or "").strip(),
                "age_label": _format_duration(age_sec),
                "error": (row.get("error") or "").strip(),
            }
        )
    order = {"running": 0, "queued": 1, "failed": 2}
    out.sort(key=lambda item: (order.get(item["status"], 9), item.get("job_id") or ""))
    return out


def _format_duration(seconds: float) -> str:
    total = int(max(0, seconds))
    if total < 60:
        return f"{total}s"
    if total < 3600:
        return f"{total // 60}m {total % 60}s"
    return f"{total // 3600}h {(total % 3600) // 60}m"


def attention_flags(
    store: Dict[str, Any],
    account: Optional[Dict[str, Any]],
    *,
    api_error: str = "",
    data_store_level: str = "ok",
    report_context_count: int = 0,
    report_context_max: int = 50,
) -> List[Dict[str, Any]]:
    flags: List[Dict[str, Any]] = []
    if api_error:
        flags.append(
            {
                "level": "critical",
                "title": "Kryx API connection failed",
                "detail": api_error,
                "href": url_for("settings"),
            }
        )
    elif account is None:
        flags.append(
            {
                "level": "critical",
                "title": "Cannot load Kryx account",
                "detail": "Check server URL and API token in Settings.",
                "href": url_for("settings"),
            }
        )
    if account:
        if account.get("expired"):
            flags.append(
                {
                    "level": "critical",
                    "title": "Kryx account expired",
                    "detail": "Renew billing on the main Kryx server.",
                    "href": url_for("settings"),
                }
            )
        credits = int(account.get("credits") or 0)
        monthly_limit = int(account.get("monthly_search_limit") or 0)
        monthly_used = int(account.get("monthly_search_used") or 0)
        if monthly_limit > 0:
            if monthly_used >= monthly_limit:
                flags.append(
                    {
                        "level": "critical",
                        "title": "Monthly search cap reached",
                        "detail": f"{monthly_used} of {monthly_limit} searches used on the shared Kryx account.",
                        "href": url_for("dashboard"),
                    }
                )
            elif monthly_used >= max(1, int(monthly_limit * 0.9)):
                flags.append(
                    {
                        "level": "warn",
                        "title": "Near monthly search cap",
                        "detail": f"{monthly_used} of {monthly_limit} used ({monthly_limit - monthly_used} remaining).",
                        "href": url_for("dashboard"),
                    }
                )
        if credits <= 0 and (monthly_limit <= 0 or monthly_used >= monthly_limit):
            flags.append(
                {
                    "level": "critical",
                    "title": "No credits available",
                    "detail": "Team searches may fail until credits are added on Kryx.",
                    "href": url_for("dashboard"),
                }
            )
        elif credits <= 5:
            flags.append(
                {
                    "level": "warn",
                    "title": f"Low shared credits ({credits} remaining)",
                    "detail": "Consider topping up the Kryx wallet before the team is blocked.",
                    "href": url_for("dashboard"),
                }
            )
    if data_store_level == "critical":
        flags.append(
            {
                "level": "critical",
                "title": "Client data store is very large",
                "detail": "Saves may slow or fail. Archive old reports and logs.",
                "href": url_for("logs"),
            }
        )
    elif data_store_level == "warn":
        flags.append(
            {
                "level": "warn",
                "title": "Client data store is growing",
                "detail": "Plan to trim cached reports or export logs.",
                "href": url_for("logs"),
            }
        )
    if report_context_count >= max(1, report_context_max - 5):
        flags.append(
            {
                "level": "warn",
                "title": f"Report cache nearly full ({report_context_count}/{report_context_max})",
                "detail": "Oldest cached reports are dropped automatically when the limit is reached.",
                "href": url_for("logs"),
            }
        )
    return flags


def actor_usage_charts(
    store: Dict[str, Any], actor: str, account: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Per-member search usage charts (UTC dates, successful searches only)."""
    target = (actor or "").strip().lower()
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

    type_counts: Dict[str, int] = defaultdict(int)
    failed_30d = 0
    for row in store.get("search_logs", []):
        if (row.get("actor") or "").strip().lower() != target:
            continue
        created = (row.get("created_at") or "")[:10]
        if not created:
            continue
        try:
            sd = datetime.strptime(created, "%Y-%m-%d").date()
        except ValueError:
            continue
        delta_days = (today - sd).days
        if delta_days < 30 and not row.get("ok"):
            failed_30d += 1
        if not row.get("ok"):
            continue
        if 0 <= delta_days < 30:
            day_counts[29 - delta_days] += 1
        month_key = created[:7]
        if month_key in month_labels:
            month_counts[month_labels.index(month_key)] += 1
        st = (row.get("search_type") or "other").strip().lower() or "other"
        type_counts[st] += 1

    type_labels_sorted = sorted(type_counts.keys())
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
        "type_labels": [t.replace("_", " ").title() for t in type_labels_sorted],
        "type_counts": [type_counts[k] for k in type_labels_sorted],
        "has_type_data": bool(type_counts),
        "failed_30d": failed_30d,
        "period_total": sum(day_counts),
    }


def actor_usage_stats(
    store: Dict[str, Any], actor: str, account: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    target = (actor or "").strip().lower()
    today = datetime.utcnow().date()
    period_total = 0
    total_all = 0
    for row in store.get("search_logs", []):
        if not row.get("ok"):
            continue
        if (row.get("actor") or "").strip().lower() != target:
            continue
        total_all += 1
        created = (row.get("created_at") or "")[:10]
        try:
            sd = datetime.strptime(created, "%Y-%m-%d").date()
        except ValueError:
            continue
        if (today - sd).days < 30:
            period_total += 1
    credits = int((account or {}).get("credits") or 0)
    monthly_limit = int((account or {}).get("monthly_search_limit") or 0)
    monthly_used = int((account or {}).get("monthly_search_used") or 0)
    return {
        "searches_30d": period_total,
        "searches_all": total_all,
        "shared_credits": credits,
        "monthly_used": monthly_used,
        "monthly_limit": monthly_limit,
        "monthly_remaining": max(0, monthly_limit - monthly_used) if monthly_limit else None,
    }
