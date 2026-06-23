"""Kryx Client account security: sessions, TOTP 2FA, and recovery codes."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from typing import Any, Dict, List, Optional, Tuple

import pyotp

MAX_AUTH_SESSIONS = 8
RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_PATTERN = re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{4}$")


def ensure_user_security(user: Dict[str, Any]) -> None:
    user.setdefault("totp_enabled", False)
    user.setdefault("totp_secret", "")
    user.setdefault("recovery_codes", [])
    user.setdefault("auth_sessions", [])
    user.setdefault("auth_session_epoch", 0)


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def totp_provisioning_uri(actor: str, secret: str, issuer: str = "Kryx Client") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=actor, issuer_name=issuer)


def verify_totp_code(user: Dict[str, Any], token: str) -> bool:
    secret = (user.get("totp_secret") or "").strip()
    if not secret:
        return False
    code = (token or "").strip().replace(" ", "")
    if not code.isdigit():
        return False
    return bool(pyotp.TOTP(secret).verify(code, valid_window=1))


def totp_is_enabled(user: Dict[str, Any]) -> bool:
    ensure_user_security(user)
    return bool(user.get("totp_enabled")) and bool((user.get("totp_secret") or "").strip())


def normalize_recovery_code(code: str) -> str:
    raw = (code or "").strip().upper().replace(" ", "")
    if len(raw) == 8 and "-" not in raw:
        raw = f"{raw[:4]}-{raw[4:]}"
    return raw


def hash_recovery_code(pepper: str, code: str) -> str:
    normalized = normalize_recovery_code(code)
    return hmac.new((pepper or "").encode("utf-8"), normalized.encode("utf-8"), hashlib.sha256).hexdigest()


def generate_recovery_codes(pepper: str) -> Tuple[List[str], List[Dict[str, str]]]:
    plain: List[str] = []
    stored: List[Dict[str, str]] = []
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(RECOVERY_CODE_COUNT):
        left = "".join(secrets.choice(alphabet) for _ in range(4))
        right = "".join(secrets.choice(alphabet) for _ in range(4))
        code = f"{left}-{right}"
        plain.append(code)
        stored.append({"hash": hash_recovery_code(pepper, code), "used_at": ""})
    return plain, stored


def recovery_codes_remaining(user: Dict[str, Any]) -> int:
    ensure_user_security(user)
    return sum(1 for row in user.get("recovery_codes", []) if not (row.get("used_at") or "").strip())


def consume_recovery_code(user: Dict[str, Any], pepper: str, code: str, now: str) -> bool:
    ensure_user_security(user)
    normalized = normalize_recovery_code(code)
    if not RECOVERY_CODE_PATTERN.match(normalized):
        return False
    digest = hash_recovery_code(pepper, normalized)
    for row in user.get("recovery_codes", []):
        if (row.get("used_at") or "").strip():
            continue
        if secrets.compare_digest((row.get("hash") or ""), digest):
            row["used_at"] = now
            return True
    return False


def register_auth_session(
    user: Dict[str, Any],
    session_id: str,
    user_agent: str,
    ip: str,
    now: str,
) -> int:
    ensure_user_security(user)
    epoch = int(user.get("auth_session_epoch", 0) or 0) + 1
    user["auth_session_epoch"] = epoch
    sessions = [row for row in user.get("auth_sessions", []) if row.get("id") != session_id]
    sessions.insert(
        0,
        {
            "id": session_id,
            "user_agent": (user_agent or "Unknown device")[:240],
            "ip": (ip or "Unknown")[:80],
            "created_at": now,
            "last_seen": now,
        },
    )
    user["auth_sessions"] = sessions[:MAX_AUTH_SESSIONS]
    return epoch


def touch_auth_session(user: Dict[str, Any], session_id: str, now: str) -> None:
    ensure_user_security(user)
    for row in user.get("auth_sessions", []):
        if row.get("id") == session_id:
            row["last_seen"] = now
            return


def auth_session_active(user: Dict[str, Any], session_id: str) -> bool:
    ensure_user_security(user)
    return any(row.get("id") == session_id for row in user.get("auth_sessions", []))


def auth_session_valid(user: Dict[str, Any], session_id: str, epoch: Any) -> bool:
    ensure_user_security(user)
    sid = (session_id or "").strip()
    if not sid:
        return False
    stored_epoch = int(user.get("auth_session_epoch", 0) or 0)
    if stored_epoch != int(epoch or 0):
        return False
    return auth_session_active(user, sid)


def active_session_count(user: Dict[str, Any]) -> int:
    ensure_user_security(user)
    return len(user.get("auth_sessions", []))


def list_auth_sessions(user: Dict[str, Any]) -> List[Dict[str, Any]]:
    ensure_user_security(user)
    return list(user.get("auth_sessions", []))


def revoke_auth_session(user: Dict[str, Any], session_id: str) -> bool:
    ensure_user_security(user)
    before = len(user.get("auth_sessions", []))
    user["auth_sessions"] = [row for row in user.get("auth_sessions", []) if row.get("id") != session_id]
    return len(user.get("auth_sessions", [])) < before


def revoke_other_auth_sessions(user: Dict[str, Any], current_session_id: str) -> int:
    ensure_user_security(user)
    kept = [row for row in user.get("auth_sessions", []) if row.get("id") == current_session_id]
    removed = len(user.get("auth_sessions", [])) - len(kept)
    user["auth_sessions"] = kept
    return removed


def disable_totp(user: Dict[str, Any]) -> None:
    ensure_user_security(user)
    user["totp_enabled"] = False
    user["totp_secret"] = ""
    user["recovery_codes"] = []


def enable_totp(user: Dict[str, Any], secret: str, pepper: str) -> List[str]:
    ensure_user_security(user)
    user["totp_secret"] = secret
    user["totp_enabled"] = True
    plain, stored = generate_recovery_codes(pepper)
    user["recovery_codes"] = stored
    return plain


def regenerate_recovery_codes(user: Dict[str, Any], pepper: str) -> List[str]:
    ensure_user_security(user)
    plain, stored = generate_recovery_codes(pepper)
    user["recovery_codes"] = stored
    return plain


def summarize_user_agent(user_agent: str) -> str:
    ua = (user_agent or "").strip()
    if not ua:
        return "Unknown device"
    if len(ua) <= 72:
        return ua
    return ua[:69] + "..."
