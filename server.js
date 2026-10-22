import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { config, loadSites } from './src/config.js';
import { EventStore } from './src/store.js';
import { createCollector, IngestError } from './src/ingest.js';
import { computeStats, liveSnapshot, resolveRange, RANGE_KEYS } from './src/stats.js';
import { RateLimiter } from './src/ratelimit.js';
import { PageLibrary, PageError } from './src/pages.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/;
const COLLECT_PATHS = new Set(['/api/v1/event', '/api/collect']);
const COLLECT_LIMIT = config.collectBodyLimit;
const STATS_TTL_MS = 10_000;
const LIVE_WINDOW_MS = 30 * 60_000;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const sites = loadSites();
const store = await new EventStore({
  dir: config.eventsDir,
  maxEvents: config.maxEvents,
  retentionDays: config.retentionDays,
}).init();

const collector = createCollector({
  sites,
  secret: config.saltSecret,
  geoHeaders: config.geoHeaders,
});

const pages = new PageLibrary({ root: config.contentDir });

const limiter = new RateLimiter({ limit: config.rateLimitPerMinute });
const loginLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
const statsCache = new Map();
const gzipCache = new Map();
const serverStarted = Date.now();

function corsHeaders() {
  return { ...CORS_HEADERS, 'Cache-Control': 'no-store' };
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function authSignature() {
  return crypto
    .createHmac('sha256', config.saltSecret)
    .update(`admin:${config.adminToken}`)
    .digest('hex');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isAuthorized(req) {
  if (!config.adminToken) return true;
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ') && safeEqual(header.slice(7), config.adminToken)) return true;
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies.pulse_auth && safeEqual(cookies.pulse_auth, authSignature()));
}

function clientIp(req) {
  if (config.trustProxy) {
    const candidates = [
      req.headers['cf-connecting-ip'],
      req.headers['x-vercel-forwarded-for'],
      req.headers['x-real-ip'],
      req.headers['x-forwarded-for'],
    ];
    for (const candidate of candidates) {
      const raw = Array.isArray(candidate) ? candidate[0] : candidate;
      const first = String(raw || '').split(',')[0].trim();
      if (first) return first.replace(/^::ffff:/, '');
    }
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Payload too large');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function pickSite(url) {
  const requested = url.searchParams.get('site');
  if (requested) {
    const site = sites.get(requested);
    return site || null;
  }
  return sites.values().next().value || null;
}

function siteSummary(site) {
  return { id: site.id, name: site.name, domain: site.domain };
}

function getStats(site, rangeKey) {
  const cacheKey = `${site.id}|${rangeKey}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.value;

  const now = new Date();
  const range = resolveRange(rangeKey, now);
  const events = store.query(site.id, range.from, range.to + 1);
  const previousEvents = store.query(site.id, range.previous.from, range.previous.to);

  const value = computeStats(events, {
    from: range.from,
    to: range.to,
    interval: range.interval,
    site: siteSummary(site),
    previousEvents,
    now: now.getTime(),
  });
  value.range = {
    key: range.key,
    label: range.label,
    from: range.from,
    to: range.to,
    interval: range.interval,
    previous: range.previous,
  };

  statsCache.set(cacheKey, { at: Date.now(), value });
  if (statsCache.size > 40) {
    const oldest = [...statsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) statsCache.delete(oldest[0]);
  }
  return value;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(stats, dataset) {
  let header;
  let rows;

  if (dataset === 'pages' || dataset === 'entry' || dataset === 'exit') {
    const key = dataset === 'pages' ? 'topPages' : dataset === 'entry' ? 'entryPages' : 'exitPages';
    header = ['name', 'pageviews', 'visitors', 'share'];
    rows = (stats[key] || []).map((row) => [
      row.path || row.name,
      row.pageviews ?? row.sessions,
      row.visitors ?? '',
      row.share,
    ]);
  } else if (dataset === 'events' || dataset === 'outbound') {
    const key = dataset === 'events' ? 'events' : 'outboundLinks';
    header = ['name', 'count', 'visitors'];
    rows = (stats[key] || []).map((row) => [row.name, row.count, row.visitors]);
  } else {
    const allowed = ['sources', 'countries', 'devices', 'browsers', 'os'];
    const key = allowed.includes(dataset) ? dataset : 'topPages';
    header = ['name', 'pageviews', 'visitors', 'share'];
    rows = (stats[key] || []).map((row) => [row.name, row.pageviews, row.visitors, row.share]);
  }

  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

/**
 * Serves a file from a root directory. `mode` controls caching and framing:
 * dashboard HTML gets a strict CSP and cannot be framed; content pages are
 * editable previews, so scripts are disabled but same-origin framing is allowed.
 */
async function serveFile(req, res, pathname, { root = config.publicDir, mode = 'dashboard' } = {}) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (relative === '/' || relative === '') relative = '/index.html';

  let filePath = path.resolve(root, `.${relative}`);
  if (!filePath.startsWith(root + path.sep)) {
    return sendText(res, 404, 'Not found');
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath);
    }
    if (!stat.isFile()) return sendText(res, 404, 'Not found');
    if (mode === 'content') {
      const realRoot = await fsp.realpath(root);
      const realFile = await fsp.realpath(filePath);
      if (!realFile.startsWith(realRoot + path.sep)) return sendText(res, 404, 'Not found');
    }
  } catch {
    return sendText(res, 404, 'Not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': mode === 'content' ? 'no-store' : 'no-cache' });
    return res.end();
  }

  let body = await fsp.readFile(filePath);
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': mode === 'content' ? 'no-store' : isHtml ? 'no-cache' : 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  };

  if (isHtml) {
    if (mode === 'content') {
      headers['Content-Security-Policy'] = [
        "script-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'self'",
      ].join('; ');
      headers['X-Frame-Options'] = 'SAMEORIGIN';
      headers['Referrer-Policy'] = 'no-referrer';
    } else {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ');
      headers['Referrer-Policy'] = 'no-referrer';
      headers['X-Frame-Options'] = 'DENY';
      headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()';
    }
  }

  if (
    body.length > 1024 &&
    COMPRESSIBLE.test(type) &&
    /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
  ) {
    const cacheKey = `${filePath}|${etag}`;
    let gz = gzipCache.get(cacheKey);
    if (!gz) {
      gz = zlib.gzipSync(body, { level: 9 });
      gzipCache.set(cacheKey, gz);
      if (gzipCache.size > 60) {
        const first = gzipCache.keys().next().value;
        gzipCache.delete(first);
      }
    }
    body = gz;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }

  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, pathname) {
  return serveFile(req, res, pathname);
}

function contentLabel() {
  const relative = path.relative(config.root, config.contentDir).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') ? relative : config.contentDir;
}

async function handle(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // ---------- collection ----------
  if (COLLECT_PATHS.has(pathname)) {
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Use POST' }, { ...corsHeaders(), Allow: 'POST, OPTIONS' });
    }

    const ip = clientIp(req);
    if (!limiter.take(ip)) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' }, corsHeaders());
    }

    let body;
    try {
      body = await readBody(req, COLLECT_LIMIT);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message }, corsHeaders());
    }

    try {
      const { event } = collector.collect({ body, headers: req.headers, ip });
      if (event) store.record(event);
      res.writeHead(204, corsHeaders());
      res.end();
    } catch (err) {
      if (err instanceof IngestError) {
        return sendJson(res, err.status, { error: err.message }, corsHeaders());
      }
      throw err;
    }
    return;
  }

  // ---------- tracker ----------
  if (pathname === '/t.js' || pathname === '/js/tracker.js') {
    try {
      const body = await fsp.readFile(path.join(config.publicDir, 't.js'));
      const etag = `W/"${body.length.toString(16)}-${Math.floor((await fsp.stat(path.join(config.publicDir, 't.js'))).mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      const headers = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      };
      let payload = body;
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        payload = zlib.gzipSync(body, { level: 9 });
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
      }
      res.writeHead(200, headers);
      return res.end(payload);
    } catch {
      return sendText(res, 404, 'Not found');
    }
  }

  // ---------- editable content preview ----------
  if (pathname === '/content' || pathname.startsWith('/content/')) {
    if (!config.editorEnabled) return sendText(res, 404, 'Not found');
    if (!isAuthorized(req)) return sendText(res, 401, 'Unauthorized');
    if (method !== 'GET' && method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    return serveFile(req, res, pathname.replace(/^\/content/, ''), {
      root: config.contentDir,
      mode: 'content',
    });
  }

  // ---------- API ----------
  if (pathname.startsWith('/api/')) {
    if (!pathname.startsWith('/api/v1/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (pathname === '/api/v1/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version: config.version,
        uptimeSeconds: Math.round((Date.now() - serverStarted) / 1000),
        store: store.status(),
        sites: sites.size,
      });
    }

    if (pathname === '/api/v1/login' && method === 'POST') {
      if (!config.adminToken) return sendJson(res, 400, { error: 'Authentication is disabled' });
      if (!loginLimiter.take(clientIp(req))) {
        return sendJson(res, 429, { error: 'Too many attempts' });
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 4096) || '{}');
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
      if (!payload.token || !safeEqual(payload.token, config.adminToken)) {
        return sendJson(res, 401, { error: 'Invalid token' });
      }
      const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '') === 'https';
      const cookie = [
        `pulse_auth=${authSignature()}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        'Max-Age=604800',
        secure ? 'Secure' : null,
      ]
        .filter(Boolean)
        .join('; ');
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    if (pathname === '/api/v1/logout' && method === 'POST') {
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': 'pulse_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' },
      );
    }

    if (pathname === '/api/v1/sites' && method === 'GET') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendJson(res, 200, {
        sites: [...sites.values()].map(siteSummary),
        auth: Boolean(config.adminToken),
        editor: config.editorEnabled,
        contentRoot: config.editorEnabled ? contentLabel() : null,
        version: config.version,
      });
    }

    if (pathname === '/api/v1/pages') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      if (!config.editorEnabled) {
        return sendJson(res, 403, {
          error: 'The page editor is disabled. Set EDITOR=1 to enable it.',
        });
      }
      if (method !== 'GET') return sendJson(res, 405, { error: 'Use GET' }, { Allow: 'GET' });
      try {
        return sendJson(res, 200, {
          pages: await pages.list(),
          root: contentLabel(),
        });
      } catch (err) {
        if (err instanceof PageError) return sendJson(res, err.status, { error: err.message });
        throw err;
      }
    }

    if (pathname === '/api/v1/pages/file') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      if (!config.editorEnabled) {
        return sendJson(res, 403, {
          error: 'The page editor is disabled. Set EDITOR=1 to enable it.',
        });
      }

      try {
        if (method === 'GET') {
          return sendJson(res, 200, await pages.get(url.searchParams.get('path') || ''));
        }

        if (method === 'PUT') {
          let payload;
          try {
            payload = JSON.parse((await readBody(req, config.pageBodyLimit)) || '{}');
          } catch (err) {
            if (err.status === 413) return sendJson(res, 413, { error: 'Page is too large (max 3 MB)' });
            return sendJson(res, 400, { error: 'Request body must be valid JSON' });
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return sendJson(res, 400, { error: 'Request body must be a JSON object' });
          }
          const saved = await pages.save(payload.path, {
            body: payload.body,
            title: payload.title,
          });
          return sendJson(res, 200, { ok: true, ...saved });
        }

        return sendJson(res, 405, { error: 'Use GET or PUT' }, { Allow: 'GET, PUT' });
      } catch (err) {
        if (err instanceof PageError) return sendJson(res, err.status, { error: err.message });
        throw err;
      }
    }

    if (pathname === '/api/v1/stats' && method === 'GET') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const site = pickSite(url);
      if (!site) return sendJson(res, 404, { error: 'Unknown site' });
      const range = url.searchParams.get('range') || '30d';
      if (!RANGE_KEYS.includes(range)) {
        return sendJson(res, 400, { error: `range must be one of: ${RANGE_KEYS.join(', ')}` });
      }
      return sendJson(res, 200, getStats(site, range));
    }

    if (pathname === '/api/v1/live' && method === 'GET') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const site = pickSite(url);
      if (!site) return sendJson(res, 404, { error: 'Unknown site' });
      const now = Date.now();
      const events = store.query(site.id, now - LIVE_WINDOW_MS, now + 1);
      return sendJson(res, 200, {
        site: siteSummary(site),
        generatedAt: now,
        ...liveSnapshot(events, { now }),
      });
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  return serveStatic(req, res, pathname);
}

// Separate export route so the CSV is streamed with the right headers.
const baseHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.on('finish', () => {
    if (url.pathname.startsWith('/api/') || url.pathname === '/t.js') {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  try {
    if (url.pathname === '/api/v1/export') {
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const site = pickSite(url);
      if (!site) return sendJson(res, 404, { error: 'Unknown site' });
      const range = url.searchParams.get('range') || '30d';
      if (!RANGE_KEYS.includes(range)) return sendJson(res, 400, { error: 'Invalid range' });
      const dataset = url.searchParams.get('dataset') || 'pages';
      const stats = getStats(site, range);
      const csv = `\ufeff${buildCsv(stats, dataset)}`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pulse-${site.id}-${dataset}-${range}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(csv);
    }
    await handle(req, res, url);
  } catch (err) {
    console.error('[pulse] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  }
};

const server = http.createServer(baseHandler);

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`[pulse] listening http://${host}:${port}  (data: ${config.dataDir})`);
  if (config.openMode) {
    console.log('[pulse] open mode: no ADMIN_TOKEN set, dashboard is public. Set one before exposing this server.');
  }
  console.log(`[pulse] ready ${JSON.stringify({ port, sites: [...sites.keys()], events: store.events.length })}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pulse] ${signal} received, flushing events...`);
  server.close();
  try {
    await store.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
