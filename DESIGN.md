# Pulse design notes

This document explains how Pulse works internally, why it is built this way, and where the sharp edges are. It is aimed at someone deploying, modifying or auditing the code — not at visitors of the tracked site.

## Goals and non-goals

**Goals**

- Drop-in analytics for sites that only serve static files.
- No cookies, no cross-day identifiers, no third-party requests.
- One process, one data directory, zero runtime dependencies.
- Useful aggregates in under a second for a personal/small-team site.
- A small WYSIWYG editor for static HTML files, without a separate CMS.
- Straightforward deployment behind any TLS proxy or container platform.

**Non-goals**

- Adversarial fraud detection or billing-grade accuracy.
- Multi-tenant accounts, teams, roles or SSO.
- Sub-second real-time reporting at very high volumes.
- Full session replay, heatmaps or user-level journeys.
- Arbitrary analytics queries (the dashboard exposes a fixed set of metrics).
- A general-purpose CMS: the editor changes one body at a time, has no media library, publishing workflow, drafts, revisions or remote deployment.

## Architecture

```
                       static site (browser)
                 ┌───────────────────────────────┐
                 │ t.js                          │
                 │  pageview / duration / event  │
                 │  outbound · sessionStorage    │
                 └───────────────┬───────────────┘
                                 │ POST text/plain (sendBeacon)
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ server.js (node:http)                                        │
│                                                              │
│  /api/v1/event ──► rate limit ──► ingest.js ──► store.js     │
│                                      │            │          │
│                                      │            ├─ memory index
│                                      │            └─ data/events/YYYY-MM-DD.jsonl
│                                      ▼                        │
│                              stats.js ◄──── query by time     │
│                                 │                             │
│  /api/v1/stats, /live, /export ◄┘ (10 s cache)               │
│  /t.js, /, /docs, static assets (gzip, ETag)                 │
│  /api/v1/pages, /content/* ──► pages.js (admin editor)       │
└──────────────────────────────────────────────────────────────┘
                                 ▲
                                 │ JSON / CSV
                        dashboard (vanilla JS + SVG)
```

There is no database, queue, worker or build step. The server is the collector, query engine and static file host.

## Request lifecycle

### Collection

1. `POST /api/v1/event` (or `/api/collect`) arrives with a body up to 16 KB. CORS allows any origin because the collector is public; the response is `204`.
2. A fixed-window limiter allows 120 requests per minute per IP (configurable). Rejections return `429`.
3. `ingest.js` checks privacy signals (`DNT: 1`, `Sec-GPC: 1`), then classifies the user agent. Bots, crawlers, headless browsers, monitoring agents and empty agents are dropped. Requests marked `Sec-Purpose: prefetch|prerender|preview` are dropped.
4. The JSON body is parsed; version, site ID and event type are validated. Unknown sites and malformed payloads return `400`.
5. The event is built:
   - `visitor` = first 16 hex chars of `SHA-256(site | UTC day | secret | IP | user agent)`.
   - `session` = client-supplied opaque ID, or a deterministic fallback derived from the visitor and a 30-minute bucket.
   - `path` is normalized: query string and fragment removed, control characters stripped, repeated slashes collapsed, 300-character cap.
   - Pageviews are enriched with referrer/UTM classification, coarse UA dimensions, optional CDN country, language, timezone and viewport size.
   - Duration events under 250 ms are discarded as noise.
6. Accepted events are appended to the in-memory index and queued for disk. The HTTP response does not wait for disk I/O.

### Query

1. `/api/v1/stats` resolves the range (UTC), queries the store for the current and previous windows, and computes aggregates in one pass.
2. Results are cached for 10 seconds per `site|range`. The dashboard requests stats every 20 seconds and live data every 5 seconds, pausing when the tab is hidden.
3. `/api/v1/live` scans only the last 30 minutes, counts distinct visitors active in the last 5, and returns the 12 newest events.
4. `/api/v1/export` reuses the cached aggregates and emits CSV.

### Static files

`public/` is served with ETags, `Cache-Control`, gzip for compressible assets (cached in memory), and a strict CSP on HTML. Path traversal is blocked by resolving against `publicDir` and checking the prefix. The tracker is served with `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin` so it can be embedded from any site; the dashboard itself is same-origin only.

### Page editing

1. The dashboard lists `.html`/`.htm` files under `CONTENT_DIR` (through `src/pages.js`), up to 200 files, three folders deep. Dotfiles, symlinks, `node_modules`, `.git`, `vendor` and uncommon binary assets are skipped.
2. The editor loads the real page from `/content/<path>`. That route requires the admin session when `ADMIN_TOKEN` is set, sends `Cache-Control: no-store`, applies a preview CSP with `script-src 'none'` and allows same-origin framing.
3. The page is displayed in a same-origin iframe with the `sandbox="allow-same-origin"` attribute. `designMode = 'on'` makes the body editable with the page's own CSS, while scripts are blocked by both mechanisms. The parent injects a tiny editor stylesheet and listens for `input` events.
4. Toolbar commands use `document.execCommand` on the iframe document (headings via `formatBlock`, lists, links, images, emphasis). The source toggle reads and writes `iframe.body.innerHTML`.
5. Saving sends only the body HTML and title to `PUT /api/v1/pages/file`. The server reads the current file, validates the body, replaces the inner HTML between the existing `<body>` tags, updates `<title>`, and writes the result atomically (temp file + rename). The exact previous file is saved as `<file>.bak`.
6. Saves preserve `<head>`, stylesheets, scripts, body attributes, UTF-8 and the file's CRLF/LF convention. Document-level tags are rejected; line endings inside the body are normalized to the file's convention.

The editor is intentionally body-only. It does not upload files, create pages, rename them, diff revisions or detect concurrent edits. A body over 2 MB is rejected. Editing is in place, so Docker deployments must mount the content folder.

## Page Library Architecture (`src/pages.js`)

Pulse implements a **PageLibrary** class to encapsulate safe file operations on the static site:
- **Recursive listing:** `listFiles()` traverses `CONTENT_DIR`, respects depth limits (3 folders), rejects symlinks, and ignores dotfiles/`node_modules/vendor`. Returns `{ path, depth }` entries.
- **Read with metadata:** `read(path)` validates the resolved realpath against the content root to reject traversal attempts, then parses HTML to extract title (limited to 120 chars) and body bounds.
- **Atomic save:** `save(path, body, title)` reads the current file, validates the body is pure inner HTML, constructs replacements preserving the existing `<head>` and all attributes, writes to a temp file in the same directory, then renames atomically. The previous content is saved as `<path>.bak` immediately before commit.
- **Rejection protections:** Path traversal (`..`) detected via `realpath` mismatch; paths outside the content root are rejected; non-.html/.htm files are ignored at list time; oversized bodies (>2 MB) or malformed HTML cause early return with no state change.

This API keeps the server module simple: the pages handler calls `listFiles()`, `read()` and `save()` without worrying about traversal, size limits, backup creation or atomicity.

## Preview Security Model

The `/content/*` route serves preview HTML for editing via an iframe sandbox:
- **Same-origin response:** The server strips any external `<script>` referrers and sets `Content-Security-Policy: frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`.
- **Sandboxed iframe:** Created with `sandbox="allow-same-origin"`, denying scripts, forms, and nesting. The page's CSS is allowed (same origin) to enable visual editing, but its JS is blocked by both the sandbox flag and `script-src 'none'` in a separate CSP layer.
- **No cookie writing:** Preview responses omit `Set-Cookie` headers; session cookies are not leaked.
- **Body-only edits:** The POST/PUT save endpoint replaces only text between the existing `<body>` start/end tags, preserving any data attributes, event listeners attached to elements in the head (though uncommon), and file structure.

This prevents injected scripts from running while editing and avoids CSRF vectors. Scripts stored in the page continue to execute after save because they remain embedded; users should be cautious of XSS-prone content.

## Backup and Atomic Writes

Every saved revision gets a `.bak` backup:
1. Server writes `<path>.bak` containing the original file contents.
2. The new file is written to a temp path (e.g., `_<path>` or via `fs.writeSync` with `flags: 'w'` into an atomic target).
3. `rename()` swaps atomically on POSIX; Windows uses equivalent write + unlink + create sequence within one tick.
4. If the process is killed mid-write, the `.bak` may grow as older versions accumulate until the next save or manual cleanup. This is expected and benign for local development.

For Docker deployments mounted from outside, consider a cron job to prune `.bak` files older than 24 hours to avoid filling disk space with stale backups. The `.bak` naming avoids collision because it appends directly to the file path without changing the extension (the original may be `index.html`, backup becomes `index.html.bak`).

## Editor Limitations Summary

| Limitation            | Reason                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Body-only edits       | Head, scripts and attributes are preserved intentionally; avoids complex HTML diffing/merge logic. |
| One `.bak` per change | Lightweight rollback; no multi-branch version history or blame.                                  |
| No file creation      | Security: prevents arbitrary file writes beyond the content root.                               |
| Depth ≤ 3 folders     | Limits filesystem overhead and keeps previews fast.                                                  |
| 200 files limit       | Avoids scanning large codebases for a personal analytics tool.                                      |
| No uploads            | Edit existing pages only; no attachment storage or CDN integration.                                 |
| No conflict detection | Runs in one browser tab; concurrent edits from multiple users not supported.                        |
| Deprecated `execCommand` | The editor uses the legacy API; modern alternatives require a build step.                      |

These constraints keep Pulse dependency-free, simple to deploy and safe by default.

## Data model

Events are JSON objects, one per line, in a file named for their **UTC** day. Example pageview:

```json
{
  "ts": 1792613213587,
  "site": "demo",
  "type": "pageview",
  "visitor": "5c1f0a9e3b7d2468",
  "session": "6vt8kze30m5xx7tv",
  "path": "/pricing",
  "pv": "k2m9x1q7p4ab",
  "title": "Pricing",
  "src": "Google",
  "refdomain": "google.com",
  "medium": "search",
  "campaign": null,
  "browser": "Chrome",
  "os": "macOS",
  "device": "desktop",
  "country": "US",
  "lang": "en-US",
  "tz": "Europe/Berlin",
  "screen": [1440, 900]
}
```

| Field | Present on | Notes |
| --- | --- | --- |
| `ts` | all | Server receive time in ms. Client clocks are not trusted for bucketing. |
| `site` | all | Site ID from the registry. |
| `type` | all | `pageview`, `duration`, `event`, `outbound`. |
| `visitor` | all | Daily pseudonym; never a raw IP or UA. |
| `session` | all | Opaque ID; 8–40 chars of `[A-Za-z0-9_-]`. |
| `path` | all | Normalized pathname. |
| `pv` | pageview/duration | Pageview ID used to correlate duration pings. |
| `title` | pageview | Document title, 120 chars. |
| `src`, `refdomain`, `medium`, `campaign` | pageview | Referrer summary; no full referring URL. |
| `browser`, `os`, `device` | pageview | Coarse classification from the UA. |
| `country` | pageview | ISO-3166 alpha-2 from a CDN geo header, or null. |
| `lang`, `tz` | pageview | Client locale and IANA timezone, optional. |
| `screen` | pageview | `[width, height]` of the viewport. |
| `duration` | duration | Milliseconds, 250 ms–30 min. |
| `name`, `props` | event | Custom event name and sanitized properties. |
| `url` | outbound | Full external URL (240 chars) plus `props.host`. |

Custom event properties are stored as-is after validation: max 10 keys, key length 40, string values 120 chars, numbers and booleans only. They are not indexed or filterable in the dashboard yet; only the event name is aggregated.

### Sessions

Sessions are **derived**, not stored. The tracker keeps an ID in `sessionStorage` and refreshes it after 30 minutes of inactivity. The server accepts any well-formed opaque ID; it does not verify continuity. Aggregation groups events by `session`, keeps only sessions with at least one pageview, and computes:

- entry page = first pageview path,
- exit page = last pageview path,
- span = last event time − first event time,
- duration = sum of duration pings, capped at 30 minutes per ping,
- interactions = custom events + outbound clicks.

A session that spans a range boundary is evaluated using only the events inside the queried window, so its span and entry/exit may be truncated at the edges. The same session can appear in two adjacent ranges.

`sessionStorage` is per-tab and cleared when the tab closes, so two tabs are two sessions. A duplicated tab inherits the storage in some browsers; this is accepted as an approximation.

### Visitors

The visitor hash is:

```
SHA-256(`${siteId}|${YYYY-MM-DD}|${secret}|${ip}|${userAgent}`).slice(0, 16)
```

Consequences:

- Stable within a UTC day, so sessions and repeat visits on the same day dedupe correctly.
- Rotates at UTC midnight, so there is no cross-day identifier.
- Includes the site ID, so the same person on two sites cannot be correlated.
- Includes `secret`, which is generated once at `data/.salt` (mode `0600`) or supplied via `SALT_SECRET`.
- 64 bits of output: collisions are negligible at realistic daily volumes.

Multi-day ranges therefore count a returning visitor once per day. The dashboard labels visitors as a daily-unique metric rather than claiming cross-day reach. This is the central privacy/accuracy trade-off in Pulse.

### Storage layout

```
data/
├── .salt                     # 32 random bytes (hex), created on first run
└── events/
    ├── events-2026-07-24.jsonl
    ├── events-2026-07-25.jsonl
    └── ...
```

- One file per UTC day; events are appended in arrival order.
- Writes are queued and flushed every 500 ms, or immediately when 200 events are pending. Each flush groups lines by file and calls `appendFile` once per file.
- On startup, files within retention are read line by line. Malformed lines are counted and skipped. Events are sorted by `ts` and trimmed to the newest `MAX_EVENTS`.
- A daily maintenance timer (and startup) deletes files older than `RETENTION_DAYS` and trims the in-memory list.
- `SIGINT`/`SIGTERM` stop accepting connections and flush pending writes before exiting.

Durability boundary: an accepted event may live only in memory for up to 500 ms (or until 200 events accumulate). A hard kill can lose that window. Disk write failures are counted in `/api/v1/health` (`writeErrors`) and logged, but events already in memory remain queryable. There is no write-ahead log or retry queue.

The in-memory index holds full event objects. At the default 250,000-event cap expect roughly 50–100 MB of heap depending on string sizes. Files are not memory-mapped; disk usage is around 250–350 bytes per event.

## Aggregation

`computeStats` walks the events once and builds maps of pageviews and visitor sets per dimension. It also allocates chart buckets up front so empty intervals appear as zeroes.

- **Totals:** unique visitors, pageviews, sessions, bounce rate, average visit duration, views per visit, custom event count, outbound count.
- **Series:** visitors (distinct per bucket) and pageviews per hour or day.
- **Top pages:** pageviews and visitors, top 10, sorted by pageviews.
- **Sources, countries, browsers:** top 8 by visitors; **devices** top 4; **OS** top 5; custom events top 8 by count; outbound hosts top 6.
- **Entry/exit pages:** top 5 sessions.
- **Previous period:** the immediately preceding equal-length window, computed with a lighter pass that only needs totals.
- **Share:** pageview share of the dimension total (for entry/exit, session share).

Notes and edge cases:

- A pageview increments pageviews, visitors, session pageviews, page buckets and every dimension.
- Duration events contribute only to session duration; they do not create a session on their own.
- A custom event or outbound click makes a one-pageview session non-bouncing.
- Custom event counts use the same `addTo` structure as pages, so each event row carries a count and a distinct-visitor count.
- Chart buckets are UTC-aligned. `24h` uses `floor(ts / hour)`, daily ranges use UTC midnight. `7d` is today plus the six previous UTC days, not a rolling 168-hour window.
- Stats are computed from the in-memory index, not from disk. If the process restarted with more files than `MAX_EVENTS`, older data remains on disk but is invisible to queries until the cap is raised.

## Dashboard

The frontend is intentionally framework-free:

- `index.html` defines the shell, skeleton states and sections (Overview, Pages, Sources, Audience, Live, Events).
- `dashboard.js` fetches sites and stats, keeps a small state object, formats numbers/dates, renders tables, the donut and the SVG chart.
- `styles.css` contains the design system, responsive breakpoints (1180/980/700/430 px), dark/light tokens and reduced-motion support.
- Charts are generated SVG with a gradient area fill, hover crosshair and a tooltip. There is no chart library.
- The theme follows `prefers-color-scheme` until the user toggles it; the choice is stored in `localStorage` (`pulse.theme`), as is the selected range (`pulse.range`).
- Live polling runs every 5 seconds and full stats every 20 seconds, only while the tab is visible. A 401 stops polling and opens the login dialog.
- The nav highlights sections with `IntersectionObserver`; tables expose CSV export links for their dataset.
- The page editor is a full-screen overlay in the same shell. It pauses dashboard polling while open, loads the page into a sandboxed iframe, marks dirty state on input, warns before discarding, saves with `Ctrl/Cmd+S`, and restores polling on close.
- All API fetches are same-origin and `credentials: same-origin`.

The dashboard is server-rendered only as an empty shell; it needs JavaScript. That is acceptable for an admin surface and keeps the build dependency-free.

## Authentication and security

- With `ADMIN_TOKEN` unset, read APIs and the dashboard are public (“open mode”). The UI warns about this.
- With a token set, read APIs require either `Authorization: Bearer <token>` or a `pulse_auth` cookie.
- Login exchanges the token for an HMAC-SHA256 signature of `admin:${ADMIN_TOKEN}` keyed by `SALT_SECRET`. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, 7 days, and `Secure` when the request is HTTPS (directly or via `X-Forwarded-Proto`).
- Comparisons are timing-safe: both sides are hashed and compared with `crypto.timingSafeEqual`.
- Login attempts are limited to 10/minute/IP. Collection has its own limiter.
- Changing `ADMIN_TOKEN` or `SALT_SECRET` invalidates all sessions.
- The collection endpoint must remain public by design. Site IDs are not secrets; anyone can post events to a known site. Rate limits and bot filtering reduce abuse but do not authenticate the sender.
- HTML responses set a strict CSP (`default-src 'self'`; no inline or third-party scripts), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff` and a restrictive permissions policy.
- Request bodies are bounded (16 KB ingest, 64 KB general, 3 MB editor saves), static paths are resolved and prefix-checked, and responses never reflect unsanitized input.
- The page editor is admin-only when `ADMIN_TOKEN` is set. `/content/*` and the editor APIs share that gate. Paths are normalized, resolved against the content root, checked after `realpath`, and limited to HTML files; symlinks are skipped and saves are atomic with a `.bak`.
- Preview HTML is framed with `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` and `script-src 'none'`; the iframe is additionally sandboxed without `allow-scripts`. Page scripts therefore cannot run while editing, but remain in the saved file.
- Cookies are not used for tracking, only for the optional admin session.

Operational recommendations: terminate TLS in front of Pulse, bind to `127.0.0.1` when possible, set `TRUST_PROXY=1` only when a trusted proxy overwrites forwarding headers, and keep the data directory private.

## Privacy and threat model

**What is stored:** event time, site, event type, daily visitor pseudonym, session ID, path, referrer summary (label + hostname), coarse UA dimensions, optional country/language/timezone/viewport, durations, custom event names/properties, outbound URLs.

**What is not stored:** raw IP addresses, raw user-agent strings, full referrer URLs, cookies, names, emails, precise location, keystrokes or cross-site identifiers.

**Who can see what:**

- A passive network observer sees TLS traffic, and the request size/timing. Nothing is sent to third parties.
- The server operator can observe raw IPs and UAs transiently in memory and in proxy logs outside Pulse. Pulse itself does not log them.
- Anyone with disk access plus the salt can test guesses of `IP + UA` for a given day. The salt is therefore sensitive; protect `data/.salt` (or `SALT_SECRET`) like a credential. If it leaks, daily pseudonyms become guessable for known networks/devices, though the daily rotation still prevents long-lived profiles.
- The dashboard is only as protected as `ADMIN_TOKEN`. Without it, all aggregates are public.

**Consent:** Pulse avoids cookies and cross-day identifiers, but “cookie-free” is not automatically “consent-free” in every jurisdiction. Whether you need a banner depends on your legal basis, the data, and local rules. The tracker honors DNT/GPC by default, offers a persistent opt-out, and stores only coarse data, which helps but is not a legal opinion.

**Retention:** files older than `RETENTION_DAYS` are deleted by a daily job and at startup. Backups are outside Pulse’s control; delete them separately.

## Scaling out

The current design targets one node and a few hundred thousand events. The first bottlenecks, in order, are:

1. **Memory.** All retained events are in RAM. Raising `MAX_EVENTS` costs heap linearly and increases startup time.
2. **Query cost.** Every uncached stats request scans the selected window. A 90-day query over a large site is the worst case; the 10-second cache hides it for normal dashboard use.
3. **Single writer.** Multiple processes cannot share the in-memory index or coordinate appends safely.

A pragmatic migration path:

1. **SQLite.** Replace the JSONL index with `node:sqlite` (available in modern Node). Keep the same event table (`ts`, `site`, `type`, `visitor`, `session`, `path`, dimensions) with indexes on `(site, ts)`. Queries and retention become SQL; the API and aggregation code stay mostly unchanged. This removes the memory cap and makes restarts cheap.
2. **Pre-aggregation.** Add hourly rollup tables (site, hour, dimension, counts, distinct visitors). Daily and multi-day dashboards then read small rollups; raw events are only needed for live and recent windows. Distinct-visitor rollups need either exact daily sets or an approximate sketch (HLL) if you accept approximation.
3. **Columnar store.** For millions of events/month, write to ClickHouse, DuckDB or BigQuery. Keep Pulse as the collector and dashboard, or put the ingest endpoint behind a queue and batch inserts. Country and UA enrichment can stay at the edge.
4. **Horizontal ingest.** Put a load balancer in front of stateless collectors that write to a shared queue/store, and keep the dashboard/query service separate. The public collection endpoint is the easiest part to scale; the query path is the hard part.
5. **Edge collection.** If you need to absorb spikes or reduce latency, collect at the CDN edge and forward batched events. This moves the trust boundary: the edge sees raw IPs, so hashing should happen there or the edge must be trusted.

What not to do: run two Pulse processes against the same `data/` directory, or put the data directory on a network filesystem. Both break the single-writer assumption.

## Testing

`npm test` uses Node's built-in runner and needs no dependencies:

- **Ingest:** validation, privacy headers, bot/prefetch filtering, path and property sanitization, duration noise, outbound URLs, daily hash rotation and stability.
- **Referrers:** direct/self referrers, search engines across country domains, social networks, UTM precedence, malformed input.
- **UA:** Chrome/Edge/Safari/mobile/tablet/bot classification.
- **Stats:** totals, sessions, bounce rate, durations, breakdowns, hourly/daily series, previous-period comparison, range resolution, live snapshot ordering.
- **Store:** persistence and reload, filtering, malformed lines, memory cap, retention purge.
- **Pages:** recursive listing and filtering, title entity decoding, body-only replacement, head/script/attribute preservation, CRLF preservation, backups, traversal/non-HTML rejection, size limits and atomic saves.
- **Server:** end-to-end collect → stats → tracker/CORS, plus auth behavior (Bearer, login cookie, public collection, 401s), editor listing/read/save, `/content` auth and preview CSP, and traversal rejection.

The tests use temporary directories and ephemeral ports. There are no browser tests; the dashboard is exercised manually and with headless screenshots.

## Known limitations and roadmap

- No per-site timezone: all buckets and labels are UTC.
- Visitor counts are daily-unique, not cross-day reach.
- Only the top N rows per dimension are returned; there is no pagination or arbitrary filtering.
- Custom event properties are stored but not queryable in the UI.
- No funnels, retention cohorts, revenue, A/B tests or annotations.
- No scheduled email reports, alerts or public sharing links.
- Single admin token, no users/roles/2FA; no audit log.
- No import of historical analytics, no server-side SDKs.
- No built-in TLS; use a proxy or platform ingress.
- Collection trusts the sender’s `site` ID and event shape within validation limits.
- Bot detection is UA-based; sophisticated bots can still get through.
- Geo requires CDN headers; bare deployments have no country data.
- CSV exports cover aggregates, not raw events (raw data is the JSONL files).
- The page editor is body-only and in-place: no media uploads, drafts, revision history, rename/delete, concurrent-edit detection or remote publishing. It keeps one `.bak` per file.
- The editor relies on `document.execCommand`, which is deprecated but still supported in current browsers. It works best on simple static pages; heavily scripted layouts may not preview faithfully.

Possible next steps that fit the design: hourly rollups, optional SQLite storage, per-site timezone rendering, saved segments, and a small read-only public dashboard token.
