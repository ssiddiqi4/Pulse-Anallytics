Pulse — Privacy-first Analytics for Static Sites
================================================

This is Pulse, a lightweight analytics solution for static sites that works 
without cookies or third-party requests. It provides a dashboard with visitor 
counts, traffic charts, and device/location breakdowns plus a built-in page 
editor for your HTML files.

== Requirements ==

- Node.js 20.11+ (tested on v22 and v26)
- Modern browser for the dashboard (Chromium, Firefox, Safari, Edge)

Pulse has zero dependencies beyond core Node.js; no build steps are needed.

Get started at <http://localhost:4000> or see /docs/ in the web UI.

== Quick Start ===

  cd pulse-analytics
  npm start
  # open http://localhost:4000

That's it. Add tracking to your site (see below). Set ADMIN_TOKEN before 
sharing publicly.

For realistic demo data, stop the server first so event files are rewritten.

== Demo Data ==

  stop the server: Ctrl+C in the terminal running Pulse
  npm run seed -- --days 90 --reset
  npm start
  
This writes 90 days of events for two example sites into data/events/. Use 
--days 30 for a smaller dataset.

== Configure Tracking on Your Site ==

Place your site in sites.json (or set via SITES_FILE env var):

    {
      "sites": [
        { "id": "demo", "name": "Acme Studio", "domain": "acme.example" },
        { "id": "docs", "name": "Acme Docs", "domain": "docs.acme.example" }
      ]
    }

Then paste this inside every page's <head> element:

    <script defer src="https://your-collector.com/t.js" data-site="demo"></script>

Attributes:
  - data-site: REQUIRED. Site ID from sites.json (2–32 chars, lowercase letters, 
    digits, underscore or hyphen only).
  - data-endpoint: Collector origin (default is the script's own src origin).
  - data-dev: Allow on localhost/127.0.0.1/*.local; false by default.
  - data-respect-dnt: Honor Do Not Track / Global Privacy Control; true by default.
  - data-outbound: Track clicks on external/download links; enabled by default.
  - data-exclude: Comma-separated paths or prefixes to ignore (supports * wildcards).

== Environment Variables ==

| Variable          | Default    | Description                                   |
| ----------------- | ---------- | --------------------------------------------- |
| PORT              | 4000       | HTTP port                                     |
| HOST              | 0.0.0.0    | Bind address (use 127.0.0.1 behind a proxy)   |
| DATA_DIR          | ./data     | Event files, salt and state                   |
| SITES_FILE        | ./sites.json | Site registry path                          |
| ADMIN_TOKEN       | (none)     | Enable dashboard authentication               |
| SALT_SECRET       | auto       | Hash salt and auth cookie secret              |
| TRUST_PROXY       | off (0)    | Set 1 only behind a trusted reverse proxy     |
| GEO_HEADERS       | see default | Country headers, first valid ISO-3166 wins   |
| RETENTION_DAYS    | 400        | Delete event files older than this            |
| MAX_EVENTS        | 250000     | In-memory event cap                           |
| RATE_LIMIT        | 120        | Collection requests per minute per IP         |
| CONTENT_DIR       | ./examples/static-site | Page editor content folder          |
| EDITOR            | enabled    | Set to 0/false/off to disable page editor     |

== Authentication ==

When ADMIN_TOKEN is set:
- Dashboard shows sign-in dialog
- Token exchanges for HttpOnly, SameSite=Lax cookie (7-day expiry)
- Scripts use Authorization: Bearer <token> for read APIs
- Login attempts limited to 10 per minute per IP

Keep this off only for local development. Never expose with a trivial token.

== Docker ==

Copy .env.example → .env, set ADMIN_TOKEN, then:

    docker compose up -d --build
    docker compose cp ./sites.json pulse:/data/sites.json
    docker compose restart pulse

To mount your own files for editing (Linux requires write access or uid 1000):

    volumes:
      - pulse-data:/data
      - /path/to/your/content:/content
    environment:
      CONTENT_DIR: /content

== Common Operations ==

Stop server on Windows: Ctrl+C, then `node server.js` to restart.

Restart on macOS/Linux: kill node process + npm start or docker compose restart pulse.

Kill orphaned servers (if needed):
    ps aux | grep "pulse-analytics" | awk '{print $2}' | xargs -r kill -9
  OR on Windows PowerShell:
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

== Troubleshooting ==

Server won't start?
  - Node version: requires v20.11+, check with `node --version`
  - Port in use: change PORT env var or stop whatever is using port 4000
  - Auth errors: set ADMIN_TOKEN before accessing protected endpoints
  - Editor fails: ensure CONTENT_DIR exists and is writable
  - No geo data: CDN must provide geo headers (Cloudflare CF-IPCountry, etc.)

Tests fail?
  - Ensure no stray server processes holding open sockets
  - Clean DATA_DIR only if you've stopped Pulse first; events are append-only

Editor shows errors?
  - `.bak` backup files exist in CONTENT_DIR; delete them manually if needed
  - File size exceeds 2 MB, path is too deep (>3 folders), or outside allowed types
  - Symlinks and hidden files (dotfiles) aren't supported by the editor

Event data not appearing?
  - Check DATA_DIR permissions; events are written immediately after collect
  - RETENTION_DAYS might be set too low for your time window
  - Events filtered: bots, DNT=1, GPC=1, prefetch headers are dropped by design

== Page Editor Features ==

- WYSIWYG editing with source view toggle
- Atomic saves with `.bak` revision backup on every change
- Preserves `<head>`, scripts, meta tags; only edits `<body>` content and title
- Preview is sandboxed: scripts blocked, CSS from the page itself loaded
- Limits: .html/.htm files only, 200 files, 3 folders deep, 2 MB per file
- No uploads, no delete/rename, no conflict detection

Disable entirely via EDITOR=0 or ensure CONTENT_DIR is empty/non-writable.

== Design Notes (see DESIGN.md) ==

Pulse uses an append-only JSONL store with in-memory index for fast queries. 
Events are hashed by day and never re-used to identify people across days. 
No cross-day user IDs exist. The page editor uses content-addressed saves with
automatic backups but doesn't implement full conflict resolution or versioning.

For scaling beyond a single node, see DESIGN.md — currently designed as one-process, one-file-system.

== Testing ==

    npm test  # 34 tests covering ingest, privacy filters, UA parsing, 
              aggregation, JSONL store, page editor API, auth endpoints, e2e

Run individual:
    npm run seed -- --days 30 --reset  (generate demo events)
    npm run example                     (start static site on :8080)

== Deployment ==

Place TLS-terminating proxy in front with TRUST_PROXY=1 so client IPs are trusted.

Caddy:
    stats.example.com {
        reverse_proxy 127.0.0.1:4000
    }

Nginx:
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

Start with service manager, e.g.:
    ADMIN_TOKEN=your-strong-token TRUST_PROXY=1 HOST=127.0.0.1 node server.js

== Privacy Summary ==

- No cookies: sessionStorage for continuity only
- No raw IPs stored: salted hash by UTC day (rotates daily)
- No cross-day tracking: visitor ID changes at midnight UTC
- Limited referrer data: hostname + source name only, not full URL
- Honors DNT and GPC by default
- Bot/prefetch filtering; collection endpoint is public but rate-limited
- Data stays on your server; dashboard only loads local assets

Privacy laws vary by jurisdiction; this is technical baseline guidance.

== File Structure ==

server.js              HTTP server, routing, auth, static files, CSV export
src/                   Library modules: config, ingest, referrer, ua, store, stats, ratelimit, pages
public/               Dashboard assets: index.html, dashboard.js, t.js tracker, styles.css
public/docs/          Installation guide served at /docs
examples/static-site  Default content folder for page editor (HTML examples)
scripts/seed.js        Demo data generator
test/                  Unit and integration tests (~34 tests)
DESIGN.md              Architecture and scaling notes
readme.txt             This file (plain-text install guide)
README.md              Markdown documentation (updated version of this)

