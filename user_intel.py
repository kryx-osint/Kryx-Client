"""Per-user and package permissions for intelligence report image viewing."""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

KRYX_PACKAGE_SPECS: Dict[str, Dict[str, bool]] = {
    "Professional": {"intel_image_view_enabled": False},
    "Agency": {"intel_image_view_enabled": True},
}

_IMAGE_FIELD_RE = re.compile(
    r"(^|_)(img|image|images|photo|photos|picture|pictures|avatar|avatars|"
    r"profile_pic|profile_picture|profile_image|pic|thumbnail|"
    r"photo_url|image_url|img_url|picture_url|avatar_url)(_|$)",
    re.IGNORECASE,
)

_EMAIL_FIELD_RE = re.compile(
    r"(^|_)(email|e_mail|mail|email_address|emailaddress|email_addr)(_|$)",
    re.IGNORECASE,
)

_INTEL_EASYTRIP_EMAIL_MASKED = "[Email redacted]"


def package_intel_image_view_default(package: str) -> bool:
    spec = KRYX_PACKAGE_SPECS.get((package or "").strip(), {})
    return bool(spec.get("intel_image_view_enabled", False))


def ensure_user_intel_fields(user: Dict[str, Any]) -> None:
    user.setdefault("api_access_enabled", False)
    if "intel_image_view_enabled" not in user:
        user["intel_image_view_enabled"] = package_intel_image_view_default(
            str(user.get("package") or "Professional")
        )


def intel_image_view_enabled(user: Optional[Dict[str, Any]]) -> bool:
    if not user:
        return False
    if user.get("is_admin"):
        return True
    if "intel_image_view_enabled" in user:
        return bool(user.get("intel_image_view_enabled"))
    return package_intel_image_view_default(str(user.get("package") or ""))


def field_key_is_email_like(field: str) -> bool:
    k = re.sub(r"[^a-z0-9]+", "_", (field or "").lower()).strip("_")
    if not k:
        return False
    return bool(_EMAIL_FIELD_RE.search(k))


def value_looks_like_email(value: str) -> bool:
    raw = (value or "").strip()
    return bool(raw) and "@" in raw and "." in raw.split("@")[-1]


def should_mask_easytrip_email(field: str, value: str) -> bool:
    raw = (value or "").strip()
    if not raw or "easytrip" not in raw.lower():
        return False
    return field_key_is_email_like(field) or value_looks_like_email(raw)


def mask_easytrip_email_value(field: str, value: str) -> str:
    if should_mask_easytrip_email(field, value):
        return _INTEL_EASYTRIP_EMAIL_MASKED
    return value


def field_key_is_image_like(field: str) -> bool:
    k = re.sub(r"[^a-z0-9]+", "_", (field or "").lower()).strip("_")
    if not k:
        return False
    return bool(_IMAGE_FIELD_RE.search(k))


_IMAGE_EXT_RE = re.compile(
    r"\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$",
    re.IGNORECASE,
)


def path_looks_like_intel_image(path: str) -> bool:
    """Safe relative paths served by the search API (e.g. /id-images/…)."""
    raw = (path or "").strip()
    if not raw.startswith("/") or ".." in raw:
        return False
    low = raw.lower()
    if "/id-images/" in low or "/id_images/" in low:
        return True
    if _IMAGE_EXT_RE.search(raw):
        return True
    return bool(re.search(r"/images?/", low))


def value_looks_like_image_url(value: str) -> bool:
    raw = (value or "").strip()
    if not raw:
        return False
    if raw.lower().startswith("data:image/"):
        return True
    if raw.startswith("/"):
        return path_looks_like_intel_image(raw)
    if not raw.lower().startswith(("http://", "https://")):
        return False
    if _IMAGE_EXT_RE.search(raw):
        return True
    return "/image" in raw.lower()


def resolve_intel_image_url(value: str, origin: str) -> str:
    """Turn API-relative image paths into absolute URLs."""
    raw = (value or "").strip()
    if not raw:
        return raw
    if raw.lower().startswith(("http://", "https://", "data:image/")):
        return raw
    if raw.startswith("/") and origin:
        base = origin.rstrip("/")
        return f"{base}{raw}"
    return raw


def row_value_is_image_content(field: str, value: str) -> bool:
    if field_key_is_image_like(field):
        return bool((value or "").strip())
    return value_looks_like_image_url(value)


def redact_image_export_value(field: str, value: str, *, allowed: bool) -> str:
    if allowed:
        return value
    if row_value_is_image_content(field, value):
        return "[Image hidden — not included in your plan]"
    return value


_INTEL_IMAGE_REDACTED = "[Image hidden — not included in your plan]"


def _sanitize_intel_node(field_key: str, value: Any, *, image_allowed: bool) -> Any:
    if isinstance(value, dict):
        return {k: _sanitize_intel_node(k, v, image_allowed=image_allowed) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_intel_node(field_key, item, image_allowed=image_allowed) for item in value]
    if isinstance(value, str):
        text = value
        if not image_allowed and row_value_is_image_content(field_key, text):
            return _INTEL_IMAGE_REDACTED
        return mask_easytrip_email_value(field_key, text)
    return value


def sanitize_intel_context_result(result: Any, *, allowed: bool) -> Any:
    """Strip sensitive intel values before payloads are sent to the browser."""
    if not isinstance(result, dict):
        return _sanitize_intel_node("", result, image_allowed=allowed)
    return _sanitize_intel_node("", result, image_allowed=allowed)
