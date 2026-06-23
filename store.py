"""Local JSON store for Kryx Client (team, logs, setup)."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional

from filelock import FileLock, Timeout

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("KRYX_CLIENT_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
STORE_FILE = DATA_DIR / "client_store.json"
LOCK = FileLock(str(DATA_DIR / ".client_store.lock"), timeout=35)
CLIENT_STORE_WARN_BYTES = 5 * 1024 * 1024
CLIENT_STORE_CRITICAL_BYTES = 15 * 1024 * 1024
REPORT_CONTEXT_MAX = 50


def _default_store() -> Dict[str, Any]:
    return {
        "config": {
            "setup_complete": False,
            "kryx_url": "",
            "api_token": "",
            "owner_username": "owner",
            "owner_password_hash": "",
            "organization_name": "My team",
            "custom_logo": "",
        },
        "team": [],
        "audit_logs": [],
        "search_logs": [],
    }


def load_store() -> Dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with LOCK:
            if not STORE_FILE.is_file():
                store = _default_store()
                save_store_unlocked(store)
                return store
            with STORE_FILE.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return _default_store()
            data.setdefault("config", _default_store()["config"])
            cfg = data["config"]
            if isinstance(cfg, dict) and "custom_logo" not in cfg:
                cfg["custom_logo"] = ""
            data.setdefault("team", [])
            data.setdefault("audit_logs", [])
            data.setdefault("search_logs", [])
            data.setdefault("search_contexts", {})
            return data
    except (Timeout, json.JSONDecodeError, OSError):
        return _default_store()


def save_store_unlocked(store: Dict[str, Any]) -> None:
    tmp = STORE_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(json.dumps(store, indent=2))
    os.replace(tmp, STORE_FILE)


def save_store(store: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK:
        save_store_unlocked(store)


def new_id() -> str:
    return secrets.token_urlsafe(8)


def append_audit(store: Dict[str, Any], actor: str, action: str, details: str = "") -> None:
    logs: List[Dict[str, Any]] = store.setdefault("audit_logs", [])
    logs.insert(
        0,
        {
            "id": new_id(),
            "actor": actor,
            "action": action,
            "details": details,
            "created_at": _utc_now(),
        },
    )
    del logs[500:]


def append_search_log(
    store: Dict[str, Any],
    *,
    actor: str,
    search_type: str,
    query_value: str,
    ok: bool,
    credits_remaining: Optional[int],
    error: str = "",
) -> None:
    logs: List[Dict[str, Any]] = store.setdefault("search_logs", [])
    logs.insert(
        0,
        {
            "id": new_id(),
            "actor": actor,
            "search_type": search_type,
            "query_value": query_value,
            "ok": ok,
            "credits_remaining": credits_remaining,
            "error": error,
            "created_at": _utc_now(),
        },
    )
    del logs[2000:]


def team_by_username(store: Dict[str, Any], username: str) -> Optional[Dict[str, Any]]:
    target = (username or "").strip().lower()
    return next(
        (
            m
            for m in store.get("team", [])
            if (m.get("username") or "").strip().lower() == target and m.get("active", True)
        ),
        None,
    )


def team_by_id(store: Dict[str, Any], member_id: str) -> Optional[Dict[str, Any]]:
    mid = (member_id or "").strip()
    return next((m for m in store.get("team", []) if m.get("id") == mid), None)


def save_search_context(store: Dict[str, Any], token: str, payload: Dict[str, Any]) -> None:
    """Persist report payload on disk; session only holds the token (results exceed cookie size)."""
    contexts = store.setdefault("search_contexts", {})
    contexts[(token or "").strip()] = payload
    if len(contexts) > REPORT_CONTEXT_MAX:
        for key in list(contexts.keys())[:-REPORT_CONTEXT_MAX]:
            del contexts[key]


def _format_data_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def client_store_snapshot(store: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    store_bytes = STORE_FILE.stat().st_size if STORE_FILE.is_file() else 0
    if store_bytes >= CLIENT_STORE_CRITICAL_BYTES:
        level = "critical"
    elif store_bytes >= CLIENT_STORE_WARN_BYTES:
        level = "warn"
    else:
        level = "ok"
    contexts = (store or {}).get("search_contexts") if isinstance(store, dict) else {}
    context_count = len(contexts) if isinstance(contexts, dict) else 0
    return {
        "level": level,
        "store_bytes": store_bytes,
        "store_size_label": _format_data_size(store_bytes),
        "warn_threshold_label": _format_data_size(CLIENT_STORE_WARN_BYTES),
        "critical_threshold_label": _format_data_size(CLIENT_STORE_CRITICAL_BYTES),
        "report_context_count": context_count,
        "report_context_max": REPORT_CONTEXT_MAX,
    }


def get_search_context(store: Dict[str, Any], token: str) -> Optional[Dict[str, Any]]:
    cache = store.get("search_contexts")
    if not isinstance(cache, dict):
        return None
    payload = cache.get((token or "").strip())
    return payload if isinstance(payload, dict) else None


def _utc_now() -> str:
    from datetime import datetime

    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
