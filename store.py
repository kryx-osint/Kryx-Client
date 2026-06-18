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
    if len(contexts) > 50:
        for key in list(contexts.keys())[:-50]:
            del contexts[key]


def get_search_context(store: Dict[str, Any], token: str) -> Optional[Dict[str, Any]]:
    cache = store.get("search_contexts")
    if not isinstance(cache, dict):
        return None
    payload = cache.get((token or "").strip())
    return payload if isinstance(payload, dict) else None


def _utc_now() -> str:
    from datetime import datetime

    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
