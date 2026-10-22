const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_SESSION_MS = 30 * 60_000;

const RANGES = {
  '24h': { label: 'Last 24 hours', ms: DAY, interval: 'hour' },
  '7d': { label: 'Last 7 days', days: 7, interval: 'day' },
  '30d': { label: 'Last 30 days', days: 30, interval: 'day' },
  '90d': { label: 'Last 90 days', days: 90, interval: 'day' },
};

export const RANGE_KEYS = Object.keys(RANGES);

export function resolveRange(key, now = new Date()) {
  const selected = Object.hasOwn(RANGES, key) ? key : '30d';
  const spec = RANGES[selected];
  const to = now.getTime();
  let from;

  if (spec.ms) {
    from = to - spec.ms;
  } else {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    from = today - (spec.days - 1) * DAY;
  }

  return {
    key: selected,
    label: spec.label,
    interval: spec.interval,
    from,
    to,
    previous: { from: from - (to - from), to: from },
  };
}

function bucketStart(ts, interval) {
  const date = new Date(ts);
  if (interval === 'hour') {
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function buildBuckets(from, to, interval) {
  const step = interval === 'hour' ? HOUR : DAY;
  const first = bucketStart(from, interval);
  const last = bucketStart(to, interval);
  const buckets = [];
  for (let t = first; t <= last; t += step) buckets.push(t);
  return buckets;
}

function addTo(map, key, visitor) {
  let row = map.get(key);
  if (!row) {
    row = { pageviews: 0, visitors: new Set() };
    map.set(key, row);
  }
  row.pageviews += 1;
  row.visitors.add(visitor);
  return row;
}

function toRows(map, total, mapper, limit = 10, sortBy = 'pageviews') {
  const rows = [];
  for (const [key, value] of map) {
    const row = mapper(key, value);
    row.share = total > 0 ? value.pageviews / total : 0;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      (Number(b[sortBy]) || 0) - (Number(a[sortBy]) || 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
  return rows.slice(0, limit);
}

function sessionRows(map, total, limit = 5) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, sessions: count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function compactTotals(events) {
  const visitors = new Set();
  const sessions = new Map();
  let pageviews = 0;

  for (const event of events) {
    let session = sessions.get(event.session);
    if (!session) {
      session = { pageviews: 0, interactions: 0, first: event.ts, last: event.ts, duration: 0 };
      sessions.set(event.session, session);
    }
    session.first = Math.min(session.first, event.ts);
    session.last = Math.max(session.last, event.ts);
    if (event.type === 'pageview') {
      pageviews += 1;
      visitors.add(event.visitor);
      session.pageviews += 1;
    } else if (event.type === 'duration') {
      session.duration += Math.min(MAX_SESSION_MS, Math.max(0, event.duration || 0));
    } else {
      session.interactions += 1;
    }
  }

  const real = [...sessions.values()].filter((session) => session.pageviews > 0);
  const bounces = real.filter((session) => session.pageviews === 1 && session.interactions === 0).length;
  let durationSum = 0;
  for (const session of real) {
    const span = Math.max(0, session.last - session.first);
    durationSum += Math.min(MAX_SESSION_MS, Math.max(session.duration, span));
  }

  return {
    visitors: visitors.size,
    pageviews,
    sessions: real.length,
    bounceRate: real.length > 0 ? bounces / real.length : 0,
    visitDuration: real.length > 0 ? durationSum / real.length : 0,
    viewsPerVisit: real.length > 0 ? pageviews / real.length : 0,
  };
}

/**
 * Aggregates raw events into dashboard-ready metrics. All dimensions except
 * pageviews and visitors are derived from pageview events.
 */
export function computeStats(events, { from, to, interval, site, previousEvents = [], now = Date.now() }) {
  const visitors = new Set();
  const sessions = new Map();
  const pages = new Map();
  const sources = new Map();
  const countries = new Map();
  const devices = new Map();
  const browsers = new Map();
  const oses = new Map();
  const customEvents = new Map();
  const outbound = new Map();
  const entryPages = new Map();
  const exitPages = new Map();

  const buckets = buildBuckets(from, to, interval);
  const bucketVisitors = new Map(buckets.map((bucket) => [bucket, new Set()]));
  const bucketViews = new Map(buckets.map((bucket) => [bucket, 0]));

  let pageviews = 0;

  for (const event of events) {
    if (event.ts < from || event.ts >= to + 1) continue;

    let session = sessions.get(event.session);
    if (!session) {
      session = {
        pageviews: 0,
        interactions: 0,
        first: event.ts,
        last: event.ts,
        duration: 0,
        entry: null,
        exit: null,
      };
      sessions.set(event.session, session);
    }
    session.first = Math.min(session.first, event.ts);
    session.last = Math.max(session.last, event.ts);

    if (event.type === 'pageview') {
      pageviews += 1;
      visitors.add(event.visitor);
      session.pageviews += 1;
      session.entry ??= event.path;
      session.exit = event.path;

      const bucket = bucketStart(event.ts, interval);
      if (bucketViews.has(bucket)) {
        bucketViews.set(bucket, bucketViews.get(bucket) + 1);
        bucketVisitors.get(bucket)?.add(event.visitor);
      }

      addTo(pages, event.path, event.visitor);
      addTo(sources, event.src || 'Direct', event.visitor);
      addTo(devices, event.device || 'desktop', event.visitor);
      addTo(browsers, event.browser || 'Other', event.visitor);
      addTo(oses, event.os || 'Other', event.visitor);
      if (event.country) addTo(countries, event.country, event.visitor);
    } else if (event.type === 'duration') {
      session.duration += Math.min(MAX_SESSION_MS, Math.max(0, event.duration || 0));
    } else if (event.type === 'event') {
      session.interactions += 1;
      addTo(customEvents, event.name || 'event', event.visitor);
    } else if (event.type === 'outbound') {
      session.interactions += 1;
      addTo(outbound, event.props?.host || 'unknown', event.visitor);
    }
  }

  const realSessions = [...sessions.values()].filter((session) => session.pageviews > 0);
  const sessionsCount = realSessions.length;
  const bounces = realSessions.filter(
    (session) => session.pageviews === 1 && session.interactions === 0,
  ).length;

  let durationSum = 0;
  const entryCounts = new Map();
  const exitCounts = new Map();
  for (const session of realSessions) {
    const span = Math.max(0, session.last - session.first);
    durationSum += Math.min(MAX_SESSION_MS, Math.max(session.duration, span));
    if (session.entry) entryCounts.set(session.entry, (entryCounts.get(session.entry) || 0) + 1);
    if (session.exit) exitCounts.set(session.exit, (exitCounts.get(session.exit) || 0) + 1);
  }

  const totals = {
    visitors: visitors.size,
    pageviews,
    sessions: sessionsCount,
    bounceRate: sessionsCount > 0 ? bounces / sessionsCount : 0,
    visitDuration: sessionsCount > 0 ? durationSum / sessionsCount : 0,
    viewsPerVisit: sessionsCount > 0 ? pageviews / sessionsCount : 0,
    events: [...customEvents.values()].reduce((sum, row) => sum + row.pageviews, 0),
    outbound: [...outbound.values()].reduce((sum, row) => sum + row.pageviews, 0),
  };

  const previousTotals = compactTotals(previousEvents);

  const series = buckets.map((t) => ({
    t,
    visitors: bucketVisitors.get(t).size,
    pageviews: bucketViews.get(t),
  }));

  return {
    site,
    range: { from, to, interval },
    generatedAt: now,
    totals,
    previousTotals,
    series,
    topPages: toRows(
      pages,
      pageviews,
      (name, value) => ({ name, path: name, pageviews: value.pageviews, visitors: value.visitors.size }),
    ),
    entryPages: sessionRows(entryCounts, sessionsCount),
    exitPages: sessionRows(exitCounts, sessionsCount),
    sources: toRows(
      sources,
      pageviews,
      (name, value) => ({ name, pageviews: value.pageviews, visitors: value.visitors.size }),
      8,
      'visitors',
    ),
    countries: toRows(
      countries,
      pageviews,
      (name, value) => ({ name, pageviews: value.pageviews, visitors: value.visitors.size }),
      8,
      'visitors',
    ),
    devices: toRows(
      devices,
      pageviews,
      (name, value) => ({ name, pageviews: value.pageviews, visitors: value.visitors.size }),
      4,
    ),
    browsers: toRows(
      browsers,
      pageviews,
      (name, value) => ({ name, pageviews: value.pageviews, visitors: value.visitors.size }),
      6,
      'visitors',
    ),
    os: toRows(
      oses,
      pageviews,
      (name, value) => ({ name, pageviews: value.pageviews, visitors: value.visitors.size }),
      5,
    ),
    events: toRows(
      customEvents,
      totals.events,
      (name, value) => ({ name, count: value.pageviews, visitors: value.visitors.size, pageviews: value.pageviews }),
      8,
      'count',
    ),
    outboundLinks: toRows(
      outbound,
      totals.outbound,
      (name, value) => ({ name, count: value.pageviews, visitors: value.visitors.size, pageviews: value.pageviews }),
      6,
      'count',
    ),
  };
}

/** Live visitor count + recent event feed for the last few minutes. */
export function liveSnapshot(events, { now = Date.now(), activeWindowMs = 5 * 60_000, feedWindowMs = 30 * 60_000, max = 12 } = {}) {
  const active = new Set();
  const recent = [];

  for (const event of events) {
    if (now - event.ts <= activeWindowMs) active.add(event.visitor);
    if (now - event.ts <= feedWindowMs) recent.push(event);
  }

  recent.sort((a, b) => b.ts - a.ts);
  return {
    active: active.size,
    windowSeconds: Math.round(activeWindowMs / 1000),
    recent: recent.slice(0, max).map((event) => ({
      ts: event.ts,
      type: event.type,
      path: event.path,
      name: event.name || null,
      source: event.src || null,
      country: event.country || null,
      device: event.device || null,
      browser: event.browser || null,
    })),
  };
}
