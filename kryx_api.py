"""HTTP client for the main Kryx server's API v1."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import requests


class KryxApiError(Exception):
    def __init__(self, message: str, *, code: str = "", status_code: int = 0, payload: Any = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.payload = payload

    def __str__(self) -> str:
        parts = [super().__str__()]
        if self.code:
            parts.append(f"(code: {self.code})")
        if self.status_code:
            parts.append(f"[HTTP {self.status_code}]")
        return " ".join(parts)


def _headers(api_token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {(api_token or '').strip()}",
        "X-API-Token": (api_token or "").strip(),
        "Accept": "application/json",
    }


def _request_json(
    method: str,
    url: str,
    *,
    api_token: str,
    json_body: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
) -> Tuple[requests.Response, Any]:
    try:
        resp = requests.request(
            method,
            url,
            headers=_headers(api_token),
            json=json_body,
            timeout=timeout,
        )
    except requests.ConnectionError:
        raise KryxApiError(
            "Cannot reach the Kryx server. Check the URL and that Kryx is running "
            "(e.g. python app.py on port 8989)."
        ) from None
    except requests.Timeout:
        raise KryxApiError("Kryx server timed out. Try again or check the server URL.") from None
    except requests.RequestException as exc:
        raise KryxApiError(f"Network error talking to Kryx: {exc}") from exc

    try:
        data = resp.json()
    except ValueError:
        snippet = (resp.text or "")[:200].strip()
        if resp.status_code == 404:
            raise KryxApiError(
                "Kryx API route not found (HTTP 404). Restart the main Kryx app so "
                "/api/v1/account is available, or update Kryx to the latest version.",
                status_code=404,
                payload=snippet,
            )
        raise KryxApiError(
            f"Kryx returned a non-JSON response (HTTP {resp.status_code}). "
            f"Is the server URL correct?{(' Preview: ' + snippet) if snippet else ''}",
            status_code=resp.status_code,
            payload=snippet,
        )
    return resp, data


def _parse_error(resp: requests.Response, data: Any) -> KryxApiError:
    message = "Kryx API request failed"
    code = ""
    if isinstance(data, dict):
        message = (data.get("error") or message).strip()
        code = (data.get("code") or "").strip()
    if resp.status_code == 404:
        message = (
            "Kryx API route not found. Restart the main Kryx server (python app.py) "
            "after updating, then try setup again."
        )
    elif resp.status_code == 401 and code == "invalid_token":
        message = (
            "Invalid API token. In Kryx Client, sign in as owner → Settings and paste "
            "a fresh token from Kryx → API Access."
        )
    elif resp.status_code == 403 and code == "api_access_disabled":
        message = (
            "API access is not enabled on this Kryx account. Use an Agency plan or "
            "enable standalone API access in Kryx admin."
        )
    return KryxApiError(message, code=code, status_code=resp.status_code, payload=data)


def _verify_via_search_probe(base_url: str, api_token: str) -> Dict[str, Any]:
    """Fallback when /api/v1/account is missing on older Kryx builds."""
    url = f"{base_url.rstrip('/')}/api/v1/search"
    resp, data = _request_json(
        "POST",
        url,
        api_token=api_token,
        json_body={"search_type": "username"},
        timeout=30,
    )
    if resp.status_code == 401:
        raise _parse_error(resp, data)
    if resp.status_code == 403:
        raise _parse_error(resp, data)
    if resp.status_code == 400 and isinstance(data, dict) and data.get("code") == "invalid_request":
        return {
            "email": "",
            "package": "",
            "active": True,
            "expired": False,
            "credits": 0,
            "monthly_search_limit": 0,
            "monthly_search_used": 0,
            "api_access_enabled": True,
            "account_endpoint_missing": True,
        }
    if resp.status_code >= 400:
        raise _parse_error(resp, data)
    raise KryxApiError("Unexpected response while verifying API token.", payload=data)


def verify_api_access(base_url: str, api_token: str) -> Dict[str, Any]:
    """Validate token during client setup. Uses /account or search probe fallback."""
    try:
        return get_account(base_url, api_token)
    except KryxApiError as exc:
        if exc.status_code == 404:
            return _verify_via_search_probe(base_url, api_token)
        raise


def get_account(base_url: str, api_token: str, *, timeout: int = 30) -> Dict[str, Any]:
    url = f"{base_url.rstrip('/')}/api/v1/account"
    resp, data = _request_json("GET", url, api_token=api_token, timeout=timeout)
    if resp.status_code >= 400:
        raise _parse_error(resp, data)
    if not isinstance(data, dict) or not data.get("ok"):
        raise KryxApiError("Unexpected account response", payload=data)
    account = data.get("account")
    if not isinstance(account, dict):
        raise KryxApiError("Account payload missing", payload=data)
    return account


def get_account_or_probe(base_url: str, api_token: str) -> Optional[Dict[str, Any]]:
    try:
        return get_account(base_url, api_token)
    except KryxApiError as exc:
        if exc.status_code != 404:
            return None
        try:
            return _verify_via_search_probe(base_url, api_token)
        except KryxApiError:
            return None


def search(
    base_url: str,
    api_token: str,
    *,
    search_type: str,
    fields: Dict[str, str],
    timeout: int = 120,
) -> Tuple[Dict[str, Any], int]:
    url = f"{base_url.rstrip('/')}/api/v1/search"
    body = {"search_type": search_type, **fields}
    resp, data = _request_json("POST", url, api_token=api_token, json_body=body, timeout=timeout)
    if resp.status_code >= 400:
        raise _parse_error(resp, data)
    if not isinstance(data, dict) or not data.get("ok"):
        raise KryxApiError("Unexpected search response", payload=data)
    credits = int(data.get("credits_remaining") or 0)
    return data, credits
