# Kryx Client

Standalone team workspace for Kryx customers with **API access** (Agency plan or API-enabled accounts).

Team members sign in to this app and run investigations through the **owner's Kryx API key**. Credits and monthly caps are shared from the main Kryx account.

This folder is **self-contained**: theme CSS, search/report JavaScript, and templates live under `kryx-client/` (no dependency on the parent Kryx repo at runtime).

## Features

- Connect with Kryx API token (`/api/v1/search`, `/api/v1/account`)
- Owner login + team member accounts (add / edit / delete)
- Investigation search UI (main Kryx search theme + loading animation)
- Intelligence report view, print, and CSV export
- Audit logs and search logs per user
- Dashboard with credit snapshot and usage charts
- Owner **Settings** to update Kryx URL / API token without re-setup

## Requirements

- Main **Kryx** server running (default `http://127.0.0.1:8989`)
- Kryx account with **API access enabled** and an active API token (Kryx → API Access)

Production and LAN deployment: see **[instructions.md](instructions.md)**.

## Quick start (Windows)

```powershell
cd d:\path\to\kryx-client
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
.\.venv\Scripts\python app.py
```

Open **http://127.0.0.1:8990** and complete setup:

1. Kryx server URL
2. API token from Kryx (full `kryx_live_…` value)
3. Owner username/password (for this client app only)

## Fix “Invalid API token”

1. Sign in as **owner**
2. Open **Settings** in the sidebar
3. Paste a **fresh** API token from Kryx → API Access
4. Save, then try search again

The token is stored in `data/client_store.json` — if it was overwritten or rotated on Kryx, searches return HTTP 401 until you update Settings.

## Ports & env

| Variable | Default | Purpose |
|----------|---------|---------|
| `KRYX_CLIENT_PORT` | `8990` | Client app port |
| `KRYX_CLIENT_SECRET_KEY` | (dev default) | Flask session secret |
| `KRYX_CLIENT_DATA_DIR` | `./data` | Team + logs + report cache |
| `KRYX_CLIENT_INTEL_IMAGE_ORIGIN` | (empty) | Search API origin for `/id-images/…` URLs |

## Roles

| Role | Access |
|------|--------|
| **Owner** | Dashboard, team, logs, settings, search |
| **Team member** | Search only |

## Bundled assets

Shipped under `static/` and `templates/partials/`:

- `kryx.css`, `workspace-search-tabs.js`, `workspace-contextual-live.js`
- `intelligence-print-page.css`, `js/kryx-preview-common.js`
- `dashboard_preview_section.html`, `search_type_icon.html`
- `user_intel.py` (image/email sanitization for reports)

To refresh from a dev checkout of main Kryx (optional):

```powershell
python tools/sync_theme_from_kryx.py
```

## Security notes

- Store `data/client_store.json` outside a public web root in production.
- Use a strong `KRYX_CLIENT_SECRET_KEY`.
- The Kryx API token is stored locally after setup — protect the client server.

## Main Kryx API used

- `GET /api/v1/account` — credits, plan, billing period usage
- `POST /api/v1/search` — investigations (deducts owner credits)
