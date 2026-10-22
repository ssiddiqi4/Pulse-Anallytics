# Getting Started with Pulse Analytics

This guide walks you through setting up Pulse for your static HTML site, including the dashboard editor and tracking setup.

## What You'll Build

1. A privacy-first analytics tracker in one `<script>` tag
2. A vanilla JS dashboard showing visitors, sessions, pages, sources, devices, locations and more
3. A WYSIWYG editor to visually edit your static HTML files
4. Zero dependencies, no build step, no database

## Prerequisites

- Node.js 20.11 or later (Node 22/26 verified)
- Basic HTTP server for serving your static site

---

## Quick Start (Local Development)

### 1. Install Pulse

```bash
cd pulse-analytics
npm start
# Server running at http://localhost:4000
```

### 2. Open the Dashboard

Browser open <http://localhost:4000> and explore:

- **Overview:** Visitors, traffic charts, top pages, sources, devices, live feed
- **Pages:** Your editable HTML files list
- **Admin settings:** Toggle dark mode, select range (24h/7d/30d/90d)

### 3. Set Up Tracking on Your Static Site

Add your virtual site to [`sites.json`](sites.json):

```bash
# Edit sites.json:
{
  "sites": [
    { "id": "demo", "name": "My Site", "domain": "mysite.example" }
  ]
}
```

Restart the server if you changed this file.

Add one tag to every HTML page (before `</head>`):

```html
<script defer src="http://localhost:4000/t.js" data-site="demo"></script>
```

For local development, add `data-dev="true"` to track on localhost/127.0.0.1:

```html
<script defer src="http://localhost:4000/t.js" data-site="demo" data-dev="true"></script>
```

### 4. Edit Your HTML Files Visually

#### Option A: Using the Dashboard Editor

- Point `CONTENT_DIR` at your static files in `.env`:

  ```env
  CONTENT_DIR=/path/to/your-html-files
  ```

- Or mount them inside Docker (`docker-compose.yml`)
- Open the dashboard; click **Page editor** in the sidebar; pick a file and edit
- Save is atomic with `.bak` backups

#### Option B: Manual Editing

Edit `.html` files directly, ensuring you keep `<head>`/scripts intact. Pulse only edits the body content.

---

## Custom Events and Outbound Tracking

### Fire Custom Events in JavaScript

```js
pulse.track('signup', { plan: 'pro', seats: 3 });
pulse.track('button_click', { button: 'cta_hero' });
```

Valid names: letters, digits, `_`, `.`, `:` and `-` (max 64 chars). Up to 10 properties per event.

### Opt-Out (Optional)

Add an opt-out link anywhere in your footer:

```html
<button type="button" onclick="pulse.optOut()">Opt out of analytics</button>
```

Users are no longer tracked once opted out (persisted in `localStorage`).

---

## Docker Deployment

### 1. Prepare Environment File

```bash
cp .env.example .env
# Edit .env: set a strong ADMIN_TOKEN, optionally CONTENT_DIR
ADMIN_TOKEN=$(openssl rand -base64 32)
echo "ADMIN_TOKEN=$ADMIN_TOKEN" >> .env
```

### 2. Build and Run

```bash
docker compose up -d --build
```

Docker volumes:
- `pulse-data`: persists events, salt and state
- Optional: your content folder to enable editing

### 3. Sync Sites Registry Inside Container

```bash
# Copy sites.json into the container after build:
docker compose cp ./sites.json pulse-analytics:/data/sites.json

# Or restart the container:
docker compose restart pulse-analytics
```

The container health check (`/api/v1/health`) confirms it's running.

---

## API Endpoints Overview

### Collection (Public)

```http
POST /api/v1/event            # or POST /api/collect
Content-Type: text/plain      # or application/json

{
  "v": 1,
  "site": "demo",
  "type": "pageview",
  "sid": "session-abc123",
  "pv": "page-view-id",
  "p": "/pricing",
  "t": "Pricing",
  "r": "https://www.google.com/",
  "u": { "source": "google", "medium": "organic", "name": null },
  "l": "en-US",
  "tz": null,
  "screen": [1440, 900]
}
```

Returns `204` silently. Use `sendBeacon()` for page-unload reliability:

```js
const data = { v: 1, site: 'demo', type: 'pageview', sid, pv, p, t, r, u, l, tz, screen };
navigator.sendBeacon('/api/v1/event', new Blob([JSON.stringify(data)], {type:'text/plain'}));
```

### Dashboard and Stats (Auth-enabled)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/stats` | GET | Aggregates for Overview dashboard (ranges: 24h, 7d, 30d, 90d) |
| `/api/v1/live` | GET | Real-time snapshot of recent visitors and events |
| `/api/v1/export` | GET | CSV export in `dataset=pages\|entry\|exit\|events\|outbound\|sources\|countries\|devices\|browsers\|os` |
| `/api/v1/sites` | GET | Site registry; shows editor availability and auth mode |
| `/api/v1/pages` | GET | List of editable HTML files under `CONTENT_DIR` |
| `/api/v1/login` | POST | Exchange token for auth cookie |
| `/api/v1/logout` | POST | Clear the auth cookie |

### Querying Stats (Example)

```bash
curl http://localhost:4000/api/v1/stats?site=demo&range=7d > stats.json
```

---

## Tips and Best Practices

### Rate Limiting and Abuse Prevention

- Collection limited to ~120 requests/minute/IP (`RATE_LIMIT` env var; adjustable)
- Bots are detected via user-agent patterns; common crawlers are filtered automatically
- Privacy headers `DNT: 1` or `Sec-GPC: 1` suppress tracking

### Data Retention

Events are stored daily in [`data/events/`](data/events/) per UTC day. A background timer deletes files older than `RETENTION_DAYS` (default 400 days).

### Troubleshooting

| Issue | Solution |
|-------|----------|
| No events showing up | Ensure `DATA_DIR` writable, server running, and tracker's `src` matches collector URL |
| "Site not found" on dashboard | Edit [`sites.json`](sites.json); add site ID; restart server if non-Docker |
| Editor page won't save | Verify `ADMIN_TOKEN` set; permissions on `CONTENT_DIR`; browser console for CSP errors |

### Security Checklist for Production

- [ ] Set a strong, unique `ADMIN_TOKEN` before going live
- [ ] Bind to `127.0.0.1` or behind a TLS-terminating proxy (`TRUST_PROXY=1`)
- [ ] Place the data directory (`DATA_DIR`) outside web root
- [ ] Use reverse proxy with `X-Forwarded-*` headers if behind one

---

## Next Steps

- Explore [`DESIGN.md`](DESIGN.md) to understand privacy, architecture and scaling options.
- Read the docs at <http://localhost:4000/docs> for installation details.
- See [`readme.txt`](readme.txt) for a plain-text version of this guide.

Happy tracking! 🚀
