# Kryx Client — deployment instructions

This guide explains how to install and run **Kryx Client** for a team workspace. The client is a separate Flask app that talks to your main **Kryx** server over the API (`/api/v1/search`, `/api/v1/account`).

For feature overview and quick local dev, see [README.md](README.md).

---

## 1. Before you deploy

### Main Kryx server

- Main Kryx must be running and reachable from the client host (default `http://127.0.0.1:8989`).
- The Kryx account used for setup must have **API access** and an active API token (`kryx_live_…` from Kryx → API Access).
- Credits and monthly caps are shared from that Kryx account.

### Client server

- **Python 3.10+** (3.11 or 3.12 recommended)
- Outbound HTTPS/HTTP to the Kryx server URL you configure
- A persistent directory for `client_store.json` (team accounts, logs, report cache, API token)

### Architecture (recommended)

```text
Team browsers → HTTPS (optional reverse proxy) → Waitress → Kryx Client (app.py) :8990
                                                      ↓
                                              Main Kryx API :8989
                                                      ↓
                                              Private data dir (KRYX_CLIENT_DATA_DIR)
```

- Do **not** expose the `data/` folder as a public web directory.
- Do **not** run `python app.py` with debug enabled in production.
- Use a strong `KRYX_CLIENT_SECRET_KEY` (long random string).

---

## 2. Install the app

### Windows (PowerShell)

```powershell
cd D:\path\to\kryx-client
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

### Linux

```bash
cd /opt/kryx-client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` before first run (see [Environment variables](#5-environment-variables)).

---

## 3. First-time setup (browser wizard)

1. Start the app (see [Run modes](#4-run-modes) below).
2. Open the client URL (default `http://127.0.0.1:8990`).
3. Complete setup:
   - **Kryx server URL** — base URL of main Kryx (no trailing slash), e.g. `https://kryx.yourdomain.com` or `http://192.168.1.10:8989`
   - **API token** — full `kryx_live_…` value from Kryx
   - **Owner username / password** — login for this client app only (not the main Kryx admin password)
   - **Organization name** — optional label for the workspace
4. Sign in as **owner** and add team members under **Team**.

| Role | Access |
|------|--------|
| Owner | Dashboard, team, logs, settings, search |
| Team member | Search only |

---

## 4. Run modes

### Development (single machine)

```powershell
# Windows
.\.venv\Scripts\python app.py
```

```bash
# Linux
.venv/bin/python app.py
```

Listens on **127.0.0.1:8990** only — suitable for local use on the same PC.

### Production (LAN or server)

Install Waitress (production WSGI server):

```powershell
.\.venv\Scripts\pip install waitress
```

```bash
.venv/bin/pip install waitress
```

Run bound to all interfaces so other machines on the LAN can connect:

```powershell
cd D:\path\to\kryx-client
.\.venv\Scripts\waitress-serve --listen=0.0.0.0:8990 app:app
```

```bash
cd /opt/kryx-client
.venv/bin/waitress-serve --listen=0.0.0.0:8990 app:app
```

Open `http://<server-ip>:8990` from team workstations.

For internet-facing deployments, put **Nginx**, **Caddy**, or **IIS ARR** in front with HTTPS and proxy to `127.0.0.1:8990`.

---

## 5. Environment variables

Copy `.env.example` to `.env` in the `kryx-client` folder.

| Variable | Default | Purpose |
|----------|---------|---------|
| `KRYX_CLIENT_SECRET_KEY` | dev placeholder | Flask session signing — **change in production** |
| `KRYX_CLIENT_PORT` | `8990` | Port when using `python app.py` |
| `KRYX_CLIENT_DATA_DIR` | `./data` | Team, logs, search report cache, stored API token |
| `KRYX_CLIENT_INTEL_IMAGE_ORIGIN` | (empty) | Origin for ID image URLs in reports (see below) |
| `KRYX_CLIENT_DEBUG` | off | Set `1` only for local debugging |

### ID images in reports

If investigation results include `/id-images/…` URLs, set:

```env
KRYX_CLIENT_INTEL_IMAGE_ORIGIN=http://your-kryx-search-api-host:port
```

Use the same search API origin configured on main Kryx (`KRYX_SEARCH_API_URL` or equivalent). Leave empty if you do not need inline ID photos in the client UI.

### Moving data off the app folder (recommended)

```env
KRYX_CLIENT_DATA_DIR=C:\kryx-client-data
```

```env
KRYX_CLIENT_DATA_DIR=/var/lib/kryx-client
```

Ensure the process user can read and write this directory. Back it up regularly — it contains the API token and team password hashes.

---

## 6. Reverse proxy examples

### Nginx (HTTPS → client)

```nginx
server {
    listen 443 ssl;
    server_name client.example.com;

    # ssl_certificate ...;
    # ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:8990;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Apache (XAMPP) — proxy only, do not use DocumentRoot

Do **not** point Apache `DocumentRoot` at `kryx-client/`. Run Waitress separately, then proxy:

```apache
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:8990/
ProxyPassReverse / http://127.0.0.1:8990/
```

Enable `mod_proxy` and `mod_proxy_http`.

---

## 7. Run at startup

### Linux (systemd)

Create `/etc/systemd/system/kryx-client.service`:

```ini
[Unit]
Description=Kryx Client team workspace
After=network.target

[Service]
Type=simple
User=kryx
WorkingDirectory=/opt/kryx-client
EnvironmentFile=/opt/kryx-client/.env
ExecStart=/opt/kryx-client/.venv/bin/waitress-serve --listen=127.0.0.1:8990 app:app
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kryx-client
sudo systemctl status kryx-client
```

Use `--listen=0.0.0.0:8990` only if you intentionally expose the port without a reverse proxy.

### Windows (Task Scheduler or NSSM)

1. Program: `D:\path\to\kryx-client\.venv\Scripts\waitress-serve.exe`
2. Arguments: `--listen=0.0.0.0:8990 app:app`
3. Start in: `D:\path\to\kryx-client`
4. Run whether user is logged on or not

---

## 8. Firewall and network

- Default port: **8990**
- Allow inbound TCP 8990 only on trusted networks, or only on `127.0.0.1` when using a reverse proxy on the same host.
- The client must reach the **Kryx server URL** you entered at setup (outbound).

---

## 9. Security checklist

- [ ] Strong `KRYX_CLIENT_SECRET_KEY` in `.env`
- [ ] `data/` (or `KRYX_CLIENT_DATA_DIR`) not web-accessible — `data/.htaccess` denies Apache access if the folder is under htdocs
- [ ] HTTPS in front of the client for any non-LAN deployment
- [ ] Restrict firewall to office / VPN IP ranges
- [ ] Rotate Kryx API token in **Settings** if compromised
- [ ] Strong owner and team passwords on the client app
- [ ] Regular backup of `client_store.json`

---

## 10. Updates

1. Stop the service (or stop `waitress-serve` / `python app.py`).
2. Replace app files (`app.py`, `static/`, `templates/`, etc.) — keep `.env` and `data/`.
3. Install dependencies if `requirements.txt` changed:

   ```bash
   .venv/bin/pip install -r requirements.txt
   ```

4. Start the service again.
5. Owner: verify **Settings** still shows valid Kryx URL and API token; run a test search.

Optional — refresh UI assets from a dev checkout of main Kryx:

```powershell
python tools/sync_theme_from_kryx.py
```

---

## 11. Troubleshooting

| Issue | What to do |
|-------|------------|
| **Invalid API token (401)** | Owner → **Settings** → paste a fresh `kryx_live_…` token from Kryx → API Access |
| **Could not reach Kryx API** | Check Kryx URL in Settings, firewall, and that main Kryx is running |
| **Print shows unfiltered results** | Click **Apply filters** on the report, then **Print** (filtered data is synced before print opens) |
| **ID images broken** | Set `KRYX_CLIENT_INTEL_IMAGE_ORIGIN` to the search API origin |
| **Team cannot connect** | Use `waitress-serve --listen=0.0.0.0:8990` and open firewall port 8990 |
| **Session / CSRF errors** | Ensure one `KRYX_CLIENT_SECRET_KEY`; do not run multiple instances with different secrets sharing one data dir |

Logs: audit and search activity are stored in `client_store.json` under **Logs** in the owner UI.

---

## 12. Quick reference

| Item | Value |
|------|--------|
| Default URL | `http://127.0.0.1:8990` |
| App entry | `app.py` |
| Production server | `waitress-serve --listen=0.0.0.0:8990 app:app` |
| Config file | `.env` |
| Persistent data | `KRYX_CLIENT_DATA_DIR` / `client_store.json` |
| Main Kryx APIs used | `GET /api/v1/account`, `POST /api/v1/search` |
