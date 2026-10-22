import test from 'node:test';
import assert from 'node:assert/strict';

import { createCollector, IngestError, normalizePath, visitorHash } from '../src/ingest.js';

const sites = new Map([
  ['demo', { id: 'demo', name: 'Demo', domain: 'acme.example', timezone: 'UTC' }],
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FIXED = new Date('2026-10-21T12:00:00.000Z');

function makeCollector() {
  return createCollector({
    sites,
    secret: 'test-secret',
    geoHeaders: ['cf-ipcountry'],
    now: () => FIXED,
  });
}

function pageview(overrides = {}) {
  return {
    v: 1,
    site: 'demo',
    type: 'pageview',
    sid: 'session_123456',
    pv: 'pageview_1234',
    p: '/pricing?plan=pro#faq',
    t: 'Pricing',
    r: 'https://www.google.com/search?q=pulse',
    u: { source: 'google', medium: 'cpc', name: 'launch' },
    l: 'en-US',
    tz: 'America/New_York',
    screen: { w: 1440, h: 900 },
    ...overrides,
  };
}

test('collects a pageview and strips identifying data', () => {
  const collector = makeCollector();
  const { event, reason } = collector.collect({
    body: JSON.stringify(pageview()),
    headers: { 'user-agent': UA, 'cf-ipcountry': 'de' },
    ip: '203.0.113.9',
  });

  assert.equal(reason, null);
  assert.equal(event.type, 'pageview');
  assert.equal(event.site, 'demo');
  assert.equal(event.path, '/pricing');
  assert.equal(event.country, 'DE');
  assert.equal(event.browser, 'Chrome');
  assert.equal(event.os, 'Windows');
  assert.equal(event.device, 'desktop');
  assert.equal(event.src, 'google');
  assert.equal(event.medium, 'cpc');
  assert.equal(event.campaign, 'launch');
  assert.equal(event.visitor.length, 16);
  assert.equal(event.session, 'session_123456');
  assert.equal(event.pv, 'pageview_1234');
  assert.deepEqual(event.screen, [1440, 900]);
  assert.equal(event.ip, undefined);
  assert.equal(event.ua, undefined);
});

test('visitor hashes are stable within a day and rotate the next day', () => {
  const base = { siteId: 'demo', ip: '203.0.113.9', userAgent: UA, secret: 'test-secret' };
  const morning = visitorHash({ ...base, now: new Date('2026-10-21T01:00:00Z') });
  const evening = visitorHash({ ...base, now: new Date('2026-10-21T23:00:00Z') });
  const tomorrow = visitorHash({ ...base, now: new Date('2026-10-22T01:00:00Z') });

  assert.equal(morning, evening);
  assert.notEqual(morning, tomorrow);
  assert.notEqual(
    morning,
    visitorHash({ ...base, ip: '203.0.113.10', now: new Date('2026-10-21T01:00:00Z') }),
  );
});

test('ignores bots, privacy signals and prefetches', () => {
  const collector = makeCollector();
  const bot = collector.collect({
    body: JSON.stringify(pageview()),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    ip: '1.1.1.1',
  });
  assert.equal(bot.event, null);
  assert.equal(bot.reason, 'bot');

  const dnt = collector.collect({
    body: JSON.stringify(pageview()),
    headers: { 'user-agent': UA, dnt: '1' },
    ip: '1.1.1.1',
  });
  assert.equal(dnt.reason, 'privacy-signal');

  const gpc = collector.collect({
    body: JSON.stringify(pageview()),
    headers: { 'user-agent': UA, 'sec-gpc': '1' },
    ip: '1.1.1.1',
  });
  assert.equal(gpc.reason, 'privacy-signal');

  const prefetch = collector.collect({
    body: JSON.stringify(pageview()),
    headers: { 'user-agent': UA, 'sec-purpose': 'prefetch;prerender' },
    ip: '1.1.1.1',
  });
  assert.equal(prefetch.reason, 'prefetch');
});

test('rejects unknown sites, bad JSON and invalid event names', () => {
  const collector = makeCollector();
  const headers = { 'user-agent': UA };

  assert.throws(
    () => collector.collect({ body: JSON.stringify(pageview({ site: 'nope' })), headers, ip: '1.1.1.1' }),
    (err) => err instanceof IngestError && err.status === 400,
  );
  assert.throws(() => collector.collect({ body: '{oops', headers, ip: '1.1.1.1' }), IngestError);
  assert.throws(
    () =>
      collector.collect({
        body: JSON.stringify(pageview({ type: 'event', name: '<script>alert(1)</script>' })),
        headers,
        ip: '1.1.1.1',
      }),
    (err) => err instanceof IngestError && err.status === 400,
  );
});

test('sanitizes paths and custom event properties', () => {
  assert.equal(normalizePath('/a//b?x=1#y'), '/a/b');
  assert.equal(normalizePath('relative'), '/relative');
  assert.equal(normalizePath('/bad\u0000path'), '/badpath');
  assert.equal(normalizePath(''), '/');

  const collector = makeCollector();
  const { event } = collector.collect({
    body: JSON.stringify({
      v: 1,
      site: 'demo',
      type: 'event',
      sid: 'session_123456',
      p: '/pricing',
      name: 'signup',
      props: {
        plan: 'pro',
        seats: 3,
        trial: true,
        nested: { evil: true },
        'bad key': 'dropped',
        long: 'x'.repeat(300),
      },
    }),
    headers: { 'user-agent': UA },
    ip: '1.1.1.1',
  });

  assert.equal(event.name, 'signup');
  assert.deepEqual(event.props, { plan: 'pro', seats: 3, trial: true, long: 'x'.repeat(120) });
  assert.equal(event.browser, undefined);
});

test('keeps real durations and drops noise', () => {
  const collector = makeCollector();
  const headers = { 'user-agent': UA };
  const base = { v: 1, site: 'demo', type: 'duration', sid: 'session_123456', p: '/', pv: 'pageview_1234' };

  const short = collector.collect({ body: JSON.stringify({ ...base, d: 100 }), headers, ip: '1.1.1.1' });
  assert.equal(short.event, null);

  const real = collector.collect({ body: JSON.stringify({ ...base, d: 15000 }), headers, ip: '1.1.1.1' });
  assert.equal(real.event.duration, 15000);

  const capped = collector.collect({ body: JSON.stringify({ ...base, d: 99_999_999 }), headers, ip: '1.1.1.1' });
  assert.equal(capped.event.duration, 1_800_000);
});

test('accepts outbound URLs and rejects non-http targets', () => {
  const collector = makeCollector();
  const headers = { 'user-agent': UA };
  const body = { v: 1, site: 'demo', type: 'outbound', sid: 'session_123456', p: '/', url: 'https://github.com/acme' };
  const { event } = collector.collect({ body: JSON.stringify(body), headers, ip: '1.1.1.1' });
  assert.equal(event.props.host, 'github.com');

  assert.throws(
    () =>
      collector.collect({
        body: JSON.stringify({ ...body, url: 'javascript:alert(1)' }),
        headers,
        ip: '1.1.1.1',
      }),
    IngestError,
  );
});
