# Editor API for Pulse Analytics

The page editor is exposed through the dashboard web UI. This document explains how to use and integrate with the editor APIs.

## Overview

Pulse's editor is a **WYSIWYG** tool built entirely in the browser. It doesn't require authentication on collection routes, but editing requires admin access when `ADMIN_TOKEN` is set.

### What Gets Edited

- **Body content:** The inner HTML between `<body>` tags
- **Title:** Document title from the `<title>` tag (max 120 chars)

Everything else (`<head>`, stylesheets, scripts, body attributes, DOCTYPE, encoding) is preserved on every save.

### Limitations Summary

| Feature | Status | Reason |
|---------|--------|--------|
| Create new files | ❌ Not supported | Security: prevents writes outside `CONTENT_DIR` |
| Upload media | ❌ Not supported | No file storage beyond static disk |
| Delete/rename files | ❌ Not supported | Avoids refactoring complexity |
| Revision history | ❌ Not supported | Keeps design simple; `.bak` per save only |
| Rename pages | ❌ Not supported | File system changes discouraged |
| Concurrent edit detection | ❌ Not supported | Single-tab assumption simplifies UX |

---

## Editor Workflow in the Dashboard

1. **Browse files:** `/api/v1/pages` (or sidebar file list) returns `path` and `depth`.
2. **Open a page:** Click a file → iframe fetches from `/content/<path>` with preview CSP.
3. **Preview environment:** Same-origin, sandboxed iframe, scripts blocked, design mode enabled.
4. **Edit inline:** Toolbar commands format text; source mode edits raw HTML body content; save persists changes atomically.

### Editing Commands (Toolbar)

All toolbar actions operate on the iframe document:

| Command | Action | Keyboard (Ctrl/Cmd) |
|---------|--------|---------------------|
| `formatBlock` | Headings `<h1>`–`<h3>`, paragraphs, pre/code | `Ctrl+B`, `I`... (browser-dependent) |
| `insertUnorderedList`/`insertOrderedList` | Unordered/ordered lists | `Alt+0`/`9` in browser menus |
| `createLink` | Insert/linkify selected text to a URL | `Ctrl+K` (native link dialog) |
| `insertImage` | Prompt for image URL | Image button opens file picker |
| `unlink` | Remove link styling | Click on link then unlink icon |
| Bold/Italic/Underline | Inline emphasis | Standard shortcuts |

The toolbar is built with simple DOM manipulation; no rich-text library. Future versions may deprecate in favor of modern APIs like `DocumentProcessor`.

---

## Preview Security Layer

The `/content/**` route serves the preview HTML for editing:

```http
Content-Security-Policy: frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
Cache-Control: no-store
Connection: close
Content-Type: text/html; charset=utf-8
```

- **Sandboxed iframe:** `sandbox="allow-same-origin"` denies scripts, forms, and nesting.
- **Preview CSP:** `script-src 'none'` prevents embedded JS from running.
- **Page origin:** Scripts in the file remain after saving because they're not fetched from another origin.

This design is intentional: editing never allows cross-site attacks through your static HTML pages while previewing them.

---

## Saving Changes (Backend API)

The save POST to `/api/v1/pages/file` accepts:

```json
{
  "path": "about.html",
  "body": "<h1>About Me</h1>",
  "title": "About Myself"
}
```

Or a `PUT` request (same structure) for the same endpoint.

### Atomic Save Process

1. **Read current file:** `pages.js.read()` fetches the existing content and metadata.
2. **Normalize body input:** Escape HTML entities only if source mode; accept raw HTML as-is in editing.
3. **Construct new HTML:** Replace inner text between `<body>` tags and update `<title>`.
4. **Write backup first:** `path.bak` receives the original file; this happens immediately before commit.
5. **Atomic write:** Temp file + rename on POSIX, or write+unlink+create sequence on Windows.
6. **Response:** Same headers as read route; no auth cookie manipulation.

### Backup Strategy

- Each save creates `<file>.bak` with the immediate predecessor version.
- No merge conflict detection: if you open a file and it's been edited elsewhere, your edits are applied on top of that newer baseline.
- For containers using Docker volumes:
  - Keep backups limited (e.g., cron cleanup of `.bak` >24h old) to avoid filling disk space.
  - Ensure the container write user (`node`, UID 1000) can create temp files and rename.

### Error Handling

- **Malformed body:** If `<body>` tags don't exist, server rejects with helpful error message.
- **Path validation:** Resolved realpath must reside within content root; path traversal rejected immediately.
- **Size limits:** Bodies >2 MB cause rejection to protect heap and disk.

---

## Dashboard JavaScript API (Optional)

Pulse exposes a global `pulse` object on all tracked pages for custom tracking, but no dedicated editor API beyond what's available via the UI.

### Available Global Methods

```js
// Track a custom event
pulse.track(eventName, { /* up to 10 properties */ });

// Force a pageview ping if you've triggered client-side routing changes
pulse.pageview();

// Opt out of all tracking for this browser
pulse.optOut(); // persists in localStorage

// Restore tracking (after opt-out)
pulse.optIn();
```

There is no `pulse.editor` or direct saving via JavaScript; editing uses the dashboard UI which calls these APIs internally.

### Example: Custom Event After Editing

Add a custom event listener after content loads, if using dynamic HTML:

```js
document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('click', (e) => {
    if (e.target.closest('.cta-button')) {
      pulse.track('cta_click', { cta: 'hero' });
    }
  });
});
```

---

## Integration Notes for Third-Party Editors

You could build a standalone editor tool around the same patterns:

1. **Fetch list of files** from `/api/v1/pages` (requires auth).
2. **Open preview** from `/content/<path>` with CSP headers captured by your tool.
3. **Save back** via `PUT /api/v1/pages/file`.
4. **Preview in local iframe** to edit without round-trip if you trust your own environment.

This pattern is possible because the API is simple and stateless: fetch, render, save.

The editor UI is provided by Pulse's dashboard; embedding it directly would require copying or rebuilding frontend assets.

---

## File Selection Logic

Pulse lists `.html`/`.htm` files recursively from `CONTENT_DIR`:

- **Max depth:** 3 folders (parent + two children)
- **Max files:** 200 entries
- **Exclusions:** dotfiles, symlink targets, `node_modules`, `.git`, `vendor` directories
- **Path traversal:** Blocked at list time; only allowed paths returned to client

This keeps scanning fast and reduces risk of accidental exposure.

---

## Summary Checklist for Users

| Task | How-To | Notes |
|------|--------|-------|
| List editable files | Dashboard → Page editor sidebar or `/api/v1/pages` | Auth required if ADMIN_TOKEN set |
| Open a page to edit | Click file in sidebar | Preview loads in iframe, CSP applied |
| Format text (headings, links, images) | Toolbar icons / `Ctrl+B/I/U` | Uses `document.execCommand`; source mode for raw HTML |
| Save changes | `Ctrl/Cmd+S` or toolbar Save button | Creates `.bak` backup; head preserved |
| Discard current edits | Click away from dirty page; warn shown before closing | No permanent discard endpoint needed |
| Opt-out of tracking | `pulse.optOut()` in console or opt-out link | Persists until cache cleared |

---

## Troubleshooting the Editor

### Save Rejected with "Path not found"

- **Cause:** `CONTENT_DIR` doesn't match actual file location; Docker volumes not mounted correctly.
- **Fix:** Double-check mount paths in `docker-compose.yml`; ensure files exist inside container at expected relative path.

### Page Won't Preview (CSP blocked)

- **Cause:** Browser blocks cross-site framing or CSP errors shown in console.
- **Fix:** Check console; ensure you're using the localhost:4000 origin. CORS errors should not appear for same-origin requests.

### Changes Not Persisting After Close

- **Cause:** Editor marks page as "dirty" until save; discarding current edits loses unsaved changes.
- **Fix:** Save before closing tab or clicking outside dirty pages.

### ".bak" Files Piling Up

- **Cause:** Each save overwrites the immediate previous version into `.bak`.
- **Fix:** Consider cleanup cron (`find /data -name "*.html.bak" -mtime +1 -delete`) if running containerized for long periods.

---

## See Also

- [DESIGN.md#page-library-architecture](DESIGN.md#page-library-architecture) — internals of page operations
- [DESIGN.md#preview-security-model](DESIGN.md#preview-security-model) — security guarantees
- [README.md#getting-started](README.md#getting-started) — quick setup guide
