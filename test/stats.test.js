import test from 'node:test';
import assert from 'node:assert/strict';

import { computeStats, liveSnapshot, resolveRange } from '../src/stats.js';

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 9, 15);
const TO = FROM + 7 * DAY - 1;
const HOUR = 3_600_000;
const site = { id: 'demo', name: 'Demo', domain: 'acme.example' };

function pageview(overrides) {
  return {
    ts: FROM + HOUR,
    site: 'demo',
    type: 'pageview',
    visitor: 'v1',
    session: 's1',
    path: '/',
    src: 'Google',
    browser: 'Chrome',
    os: 'Windows',
    device: 'desktop',
    country: 'US',
    ...overrides,
  };
}

function fixture() {
  return [
    pageview({ ts: FROM + HOUR, session: 's1', visitor: 'v1', path: '/', src: 'Google', country: 'US' }),
    pageview({ ts: FROM + HOUR + 20_000, session: 's1', visitor: 'v1', path: '/pricing', src: 'Google', country: 'US' }),
    { ts: FROM + HOUR + 60_000, site: 'demo', type: 'duration', visitor: 'v1', session: 's1', path: '/pricing', duration: 30_000 },
    { ts: FROM + HOUR + 65_000, site: 'demo', type: 'event', visitor: 'v1', session: 's1', path: '/pricing', name: 'signup' },

    pageview({ ts: FROM + 2 * DAY + HOUR, session: 's2', visitor: 'v2', path: '/', src: 'Direct', country: 'DE' }),
    { ts: FROM + 2 * DAY + HOUR + 10_000, site: 'demo', type: 'duration', visitor: 'v2', session: 's2', path: '/', duration: 10_000 },

    pageview({ ts: FROM + 3 * DAY + HOUR, session: 's3', visitor: 'v1', path: '/pricing', src: 'X', country: 'US' }),
    pageview({ ts: FROM + 3 * DAY + HOUR + 20_000, session: 's3', visitor: 'v1', path: '/features', src: 'X', country: 'US' }),
    { ts: FROM + 3 * DAY + HOUR + 30_000, site: 'demo', type: 'outbound', visitor: 'v1', session: 's3', path: '/features', props: { host: 'github.com', url: 'https://github.com/acme' } },
  ];
}

test('computes totals, sessions, bounce rate and durations', () => {
  const stats = computeStats(fixture(), {
    from: FROM,
    to: TO,
    interval: 'day',
    site,
    previousEvents: [],
    now: TO,
  });

  assert.equal(stats.totals.visitors, 2);
  assert.equal(stats.totals.pageviews, 5);
  assert.equal(stats.totals.sessions, 3);
  assert.ok(Math.abs(stats.totals.bounceRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(stats.totals.viewsPerVisit - 5 / 3) < 1e-9);
  assert.equal(stats.totals.events, 1);
  assert.equal(stats.totals.outbound, 1);

  // (span 65s, duration 10s, span 30s) / 3 = 35s
  assert.ok(Math.abs(stats.totals.visitDuration - 35_000) < 1, `got ${stats.totals.visitDuration}`);
});

test('builds breakdowns and hourly/daily series', () => {
  const stats = computeStats(fixture(), { from: FROM, to: TO, interval: 'day', site });
  assert.equal(stats.series.length, 7);
  assert.equal(stats.series.reduce((sum, row) => sum + row.pageviews, 0), 5);
  assert.equal(stats.series[0].pageviews, 2);
  assert.equal(stats.series[0].visitors, 1);
  assert.equal(stats.series[1].pageviews, 0);

  const pricing = stats.topPages.find((row) => row.path === '/pricing');
  assert.equal(pricing.pageviews, 2);
  assert.equal(pricing.visitors, 1);

  assert.equal(stats.entryPages[0].name, '/');
  assert.equal(stats.entryPages[0].sessions, 2);
  const exits = Object.fromEntries(stats.exitPages.map((row) => [row.name, row.sessions]));
  assert.equal(exits['/pricing'], 1);
  assert.equal(exits['/features'], 1);

  const sources = Object.fromEntries(stats.sources.map((row) => [row.name, row.pageviews]));
  assert.equal(sources.Google, 2);
  assert.equal(sources.X, 2);
  assert.equal(sources.Direct, 1);

  const countries = Object.fromEntries(stats.countries.map((row) => [row.name, row.visitors]));
  assert.deepEqual(countries, { US: 1, DE: 1 });
  assert.equal(stats.devices[0].name, 'desktop');
  assert.equal(stats.events[0].name, 'signup');
  assert.equal(stats.events[0].count, 1);
  assert.equal(stats.outboundLinks[0].name, 'github.com');
});

test('compares against the previous period', () => {
  const previous = [
    pageview({ ts: FROM - 2 * DAY, session: 'old', visitor: 'old', path: '/' }),
    pageview({ ts: FROM - 2 * DAY + 10_000, session: 'old', visitor: 'old', path: '/pricing' }),
  ];
  const stats = computeStats(fixture(), {
    from: FROM,
    to: TO,
    interval: 'day',
    site,
    previousEvents: previous,
  });
  assert.equal(stats.previousTotals.visitors, 1);
  assert.equal(stats.previousTotals.pageviews, 2);
  assert.equal(stats.previousTotals.sessions, 1);
});

test('resolveRange returns aligned windows and a previous window', () => {
  const now = new Date('2026-10-21T15:30:00Z');
  const range = resolveRange('30d', now);
  assert.equal(range.interval, 'day');
  assert.equal(range.to, now.getTime());
  assert.equal(range.from, Date.UTC(2026, 8, 22));
  assert.equal(range.previous.to, range.from);
  assert.equal(range.previous.from, range.from - (range.to - range.from));

  const fallback = resolveRange('bogus', now);
  assert.equal(fallback.key, '30d');

  const hourly = resolveRange('24h', now);
  assert.equal(hourly.interval, 'hour');
  assert.equal(hourly.to - hourly.from, DAY);
});

test('live snapshot counts recent visitors and sorts the feed', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  const events = [
    pageview({ ts: now - 10 * 60_000, visitor: 'old', path: '/old' }),
    pageview({ ts: now - 60_000, visitor: 'a', path: '/a' }),
    { ts: now - 30_000, site: 'demo', type: 'event', visitor: 'b', session: 's', path: '/b', name: 'cta' },
    pageview({ ts: now - 4 * 60_000, visitor: 'a', path: '/c' }),
  ];

  const snapshot = liveSnapshot(events, { now });
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.recent[0].path, '/b');
  assert.equal(snapshot.recent.length, 4);
});
