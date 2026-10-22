import crypto from 'node:crypto';
import { parseUA } from './ua.js';
import { classifyReferrer } from './referrer.js';

const TYPES = new Set(['pageview', 'event', 'duration', 'outbound']);
const OPAQUE_ID = /^[A-Za-z0-9_-]{6,48}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

export class IngestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

/**
 * Stable per-day, per-site visitor pseudonym. The raw IP and UA are never
 * stored; the hash rotates at UTC midnight so cross-day tracking is impossible.
 */
export function visitorHash({ siteId, ip, userAgent, secret, now = new Date() }) {
  const day = now.toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${siteId}|${day}|${secret}|${ip}|${userAgent}`)
    .digest('hex')
    .slice(0, 16);
}

export function normalizePath(raw) {
  let value = typeof raw === 'string' ? raw : '/';
  value = value.split('#')[0].split('?')[0];
  if (!value.startsWith('/')) value = `/${value}`;
  value = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\/{2,}/g, '/')
    .slice(0, 300);
  return value || '/';
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function boundedInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeUtm(utm) {
  if (!utm || typeof utm !== 'object' || Array.isArray(utm)) return null;
  const out = {
    source: cleanText(utm.source, 64),
    medium: cleanText(utm.medium, 64),
    name: cleanText(utm.name, 64),
  };
  return out.source || out.medium || out.name ? out : null;
}

function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (count >= 10) break;
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = cleanText(value, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else continue;
    count += 1;
  }
  return count > 0 ? out : null;
}

function countryFromHeaders(headers, geoHeaders) {
  for (const name of geoHeaders) {
    const value = headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    const country = String(raw || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) return country;
  }
  return null;
}

/**
 * @param {{ sites: Map<string, any>, secret: string, geoHeaders?: string[], now?: () => Date }} options
 */
export function createCollector({ sites, secret, geoHeaders = [], now = () => new Date() }) {
  return {
    collect({ body, headers = {}, ip = '' }) {
      if (String(headers.dnt || '') === '1' || String(headers['sec-gpc'] || '') === '1') {
        return { event: null, reason: 'privacy-signal' };
      }

      const userAgent = String(headers['user-agent'] || '');
      const agent = parseUA(userAgent);
      if (agent.bot) return { event: null, reason: 'bot' };

      const purpose = String(headers['sec-purpose'] || headers.purpose || '');
      if (/prefetch|prerender|preview/i.test(purpose)) {
        return { event: null, reason: 'prefetch' };
      }

      let payload = body;
      if (typeof body === 'string') {
        try {
          payload = JSON.parse(body);
        } catch {
          throw new IngestError(400, 'Request body must be valid JSON');
        }
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new IngestError(400, 'Request body must be a JSON object');
      }
      if (payload.v !== undefined && payload.v !== 1) {
        throw new IngestError(400, 'Unsupported payload version');
      }

      const site = sites.get(String(payload.site || ''));
      if (!site) throw new IngestError(400, 'Unknown site id');

      const type = String(payload.type || 'pageview');
      if (!TYPES.has(type)) throw new IngestError(400, 'Unsupported event type');

      const at = now();
      const ts = at.getTime();
      const visitor = visitorHash({ siteId: site.id, ip, userAgent, secret, now: at });
      const rawSession = String(payload.sid || '');
      const session = OPAQUE_ID.test(rawSession)
        ? rawSession
        : `s_${visitor.slice(0, 8)}_${Math.floor(ts / 1800000)}`;
      const rawPv = String(payload.pv || '');
      const pageviewId = OPAQUE_ID.test(rawPv) ? rawPv : null;

      const event = {
        ts,
        site: site.id,
        type,
        visitor,
        session,
        path: normalizePath(payload.p),
      };

      if (type === 'pageview') {
        const ref = classifyReferrer(payload.r, {
          siteDomain: site.domain,
          utm: sanitizeUtm(payload.u),
        });
        const screen = payload.screen && typeof payload.screen === 'object' ? payload.screen : {};
        event.pv = pageviewId;
        event.title = cleanText(payload.t, 120) || null;
        event.src = ref.source;
        event.refdomain = ref.domain;
        event.medium = ref.medium;
        event.campaign = ref.campaign;
        event.browser = agent.browser;
        event.os = agent.os;
        event.device = agent.device;
        event.country = countryFromHeaders(headers, geoHeaders);
        event.lang = cleanText(payload.l, 24) || null;
        event.tz = cleanText(payload.tz, 48) || null;
        event.screen = [
          boundedInt(screen.w ?? payload.w, 0, 20000, 0),
          boundedInt(screen.h ?? payload.h, 0, 20000, 0),
        ];
      } else if (type === 'duration') {
        event.pv = pageviewId;
        event.duration = boundedInt(payload.d, 0, 1800000, 0);
        if (event.duration < 250) return { event: null, reason: 'too-short' };
      } else if (type === 'event') {
        const name = cleanText(payload.name, 64);
        if (!EVENT_NAME.test(name)) throw new IngestError(400, 'Invalid event name');
        event.name = name;
        event.props = sanitizeProps(payload.props);
      } else if (type === 'outbound') {
        const url = cleanText(payload.url, 300);
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new IngestError(400, 'Invalid outbound URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new IngestError(400, 'Invalid outbound URL');
        }
        event.name = 'outbound';
        event.props = { host: parsed.hostname.slice(0, 120), url: url.slice(0, 240) };
      }

      return { event, reason: null };
    },
  };
}
