import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
ensureDir(dataDir);

function loadSecret() {
  if (process.env.SALT_SECRET) return process.env.SALT_SECRET;
  const file = path.join(dataDir, '.salt');
  try {
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (secret) return secret;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export const config = {
  root: ROOT,
  version: readVersion(),
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  eventsDir: path.join(dataDir, 'events'),
  publicDir: path.join(ROOT, 'public'),
  sitesFile: path.resolve(ROOT, process.env.SITES_FILE || 'sites.json'),
  contentDir: path.resolve(ROOT, process.env.CONTENT_DIR || 'examples/static-site'),
  editorEnabled: !/^(0|false|no|off)$/i.test(process.env.EDITOR || ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  saltSecret: loadSecret(),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  geoHeaders: (process.env.GEO_HEADERS || 'cf-ipcountry,x-vercel-ip-country,x-country-code,x-geo-country')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  retentionDays: Math.round(numberFromEnv(process.env.RETENTION_DAYS, 400)),
  maxEvents: Math.round(numberFromEnv(process.env.MAX_EVENTS, 250000)),
  rateLimitPerMinute: Math.round(numberFromEnv(process.env.RATE_LIMIT, 120)),
  collectBodyLimit: 16 * 1024,
  bodyLimit: 64 * 1024,
  pageBodyLimit: 3 * 1024 * 1024,
  openMode: !process.env.ADMIN_TOKEN,
};

export const DEFAULT_SITES = [
  { id: 'demo', name: 'Acme Studio', domain: 'acme.example' },
  { id: 'docs', name: 'Acme Docs', domain: 'docs.acme.example' },
];

/**
 * Loads the site registry from sites.json. Creates a starter file on first run.
 * Site IDs are public identifiers embedded in the tracking snippet, not secrets.
 */
export function loadSites() {
  let raw;
  try {
    raw = fs.readFileSync(config.sitesFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    raw = JSON.stringify({ sites: DEFAULT_SITES }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(config.sitesFile), { recursive: true });
    fs.writeFileSync(config.sitesFile, raw);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in sites file: ${config.sitesFile}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed.sites;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`sites file must contain a non-empty "sites" array: ${config.sitesFile}`);
  }

  const sites = new Map();
  for (const entry of list) {
    const id = String(entry?.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
      throw new Error(`Invalid site id "${id}". Use 2-32 chars: a-z, 0-9, _ or -.`);
    }
    if (sites.has(id)) throw new Error(`Duplicate site id "${id}" in ${config.sitesFile}`);
    sites.set(id, {
      id,
      name: String(entry.name || id).slice(0, 80),
      domain: String(entry.domain || '').trim().toLowerCase().slice(0, 120),
    });
  }
  return sites;
}
