#!/usr/bin/env node
/**
 * Deterministic demo-data generator.
 *
 *   npm run seed -- --days 90 --reset
 *
 * Writes realistic sessions (pageviews, durations, referrers, devices,
 * custom events, outbound clicks) straight into the event store.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { config, loadSites } from '../src/config.js';
import { EventStore } from '../src/store.js';

const DAY = 86_400_000;

function parseArgs(argv) {
  const args = { days: 90, reset: false, seed: 42 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') args.reset = true;
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg.startsWith('--days=')) args.days = Number(arg.slice(7));
    else if (arg.startsWith('--seed=')) args.seed = Number(arg.slice(7));
  }
  if (!Number.isFinite(args.days) || args.days < 1) args.days = 90;
  args.days = Math.min(365, Math.round(args.days));
  if (!Number.isFinite(args.seed)) args.seed = 42;
  return args;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = parseArgs(process.argv.slice(2));
const rng = mulberry32(args.seed);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function between(min, max) {
  return min + rng() * (max - min);
}

function randInt(min, max) {
  return Math.floor(between(min, max + 1));
}

function gaussian(mean, deviation) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick(entries) {
  return entries[Math.floor(rng() * entries.length)];
}

function weightedPick(entries) {
  let total = 0;
  for (const [, weight] of entries) total += weight;
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function weightedIndex(entries) {
  const value = weightedPick(entries);
  return entries.findIndex(([page]) => page === value);
}

function id(length = 16) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

const HOURS = [1, 1, 1, 1, 1, 1, 2, 4, 6, 8, 9, 9, 8, 8, 8, 8, 7, 7, 6, 6, 5, 4, 3, 2];

const SOURCES = [
  { name: 'Google', medium: 'search', domain: 'google.com', weight: 33 },
  { name: 'Direct', medium: 'direct', domain: null, weight: 29 },
  { name: 'X', medium: 'social', domain: 'x.com', weight: 6 },
  { name: 'LinkedIn', medium: 'social', domain: 'linkedin.com', weight: 5 },
  { name: 'newsletter', medium: 'email', domain: null, campaign: 'weekly-digest', weight: 4 },
  { name: 'DuckDuckGo', medium: 'search', domain: 'duckduckgo.com', weight: 3 },
  { name: 'Bing', medium: 'search', domain: 'bing.com', weight: 3 },
  { name: 'GitHub', medium: 'referral', domain: 'github.com', weight: 3 },
  { name: 'Hacker News', medium: 'social', domain: 'news.ycombinator.com', weight: 3 },
  { name: 'Reddit', medium: 'social', domain: 'reddit.com', weight: 2 },
  { name: 'Product Hunt', medium: 'social', domain: 'producthunt.com', weight: 2 },
  { name: 'dev.to', medium: 'referral', domain: 'dev.to', weight: 1 },
];

const COUNTRIES = [
  ['US', 31], ['DE', 15], ['GB', 11], ['IN', 10], ['FR', 6], ['CA', 5],
  ['NL', 5], ['AU', 4], ['BR', 3], ['JP', 3], ['ES', 2], ['SE', 2], ['PL', 1], ['IT', 1],
];

const LOCALE = {
  US: ['en-US', 'America/New_York'],
  DE: ['de-DE', 'Europe/Berlin'],
  GB: ['en-GB', 'Europe/London'],
  IN: ['en-IN', 'Asia/Kolkata'],
  FR: ['fr-FR', 'Europe/Paris'],
  CA: ['en-CA', 'America/Toronto'],
  NL: ['nl-NL', 'Europe/Amsterdam'],
  AU: ['en-AU', 'Australia/Sydney'],
  BR: ['pt-BR', 'America/Sao_Paulo'],
  JP: ['ja-JP', 'Asia/Tokyo'],
  ES: ['es-ES', 'Europe/Madrid'],
  SE: ['sv-SE', 'Europe/Stockholm'],
  PL: ['pl-PL', 'Europe/Warsaw'],
  IT: ['it-IT', 'Europe/Rome'],
};

const PROFILES = {
  demo: {
    base: 152,
    pages: [
      ['/', 32], ['/features', 14], ['/pricing', 12], ['/blog/analytics-without-cookies', 9],
      ['/blog/static-site-checklist', 7], ['/templates', 7], ['/integrations', 6],
      ['/docs/getting-started', 5], ['/about', 3], ['/changelog', 2], ['/contact', 1.5], ['/signup', 1.5],
    ],
    titles: {
      '/': 'Acme Studio — privacy-first tools for the web',
      '/features': 'Features',
      '/pricing': 'Pricing',
      '/blog/analytics-without-cookies': 'Analytics without cookies',
      '/blog/static-site-checklist': 'The static site launch checklist',
      '/templates': 'Templates',
      '/integrations': 'Integrations',
      '/docs/getting-started': 'Getting started',
      '/about': 'About us',
      '/changelog': 'Changelog',
      '/contact': 'Contact',
      '/signup': 'Create your account',
    },
  },
  docs: {
    base: 64,
    pages: [
      ['/docs', 30], ['/docs/getting-started', 18], ['/docs/tracker', 14],
      ['/docs/events', 10], ['/docs/api', 9], ['/docs/self-hosting', 8],
      ['/changelog', 6], ['/search', 5],
    ],
    titles: {
      '/docs': 'Documentation',
      '/docs/getting-started': 'Getting started',
      '/docs/tracker': 'Installing the tracker',
      '/docs/events': 'Custom events',
      '/docs/api': 'Stats API',
      '/docs/self-hosting': 'Self-hosting',
      '/changelog': 'Changelog',
      '/search': 'Search docs',
    },
  },
};

const FALLBACK_PROFILE = {
  base: 30,
  pages: [['/', 40], ['/pricing', 20], ['/about', 15], ['/blog', 15], ['/contact', 10]],
  titles: {},
};

function titleFor(profile, page) {
  return profile.titles[page] || page.replace(/^\//, '').replace(/[-_/]+/g, ' ') || 'Home';
}

function clientFor(device) {
  if (device === 'mobile') {
    const ios = rng() < 0.42;
    if (ios) {
      return { browser: weightedPick([['Safari', 82], ['Chrome', 12], ['Firefox', 4], ['Edge', 2]]), os: 'iOS' };
    }
    return {
      browser: weightedPick([['Chrome', 80], ['Samsung Internet', 10], ['Firefox', 6], ['Edge', 4]]),
      os: 'Android',
    };
  }
  if (device === 'tablet') {
    const ios = rng() < 0.55;
    return ios
      ? { browser: 'Safari', os: 'iOS' }
      : { browser: weightedPick([['Chrome', 80], ['Firefox', 12], ['Edge', 8]]), os: 'Android' };
  }
  return {
    browser: weightedPick([['Chrome', 55], ['Safari', 18], ['Firefox', 14], ['Edge', 13]]),
    os: weightedPick([['Windows', 57], ['macOS', 31], ['Linux', 12]]),
  };
}

function screenFor(device) {
  if (device === 'mobile') return pick([[390, 844], [414, 896], [360, 800], [430, 932]]);
  if (device === 'tablet') return pick([[820, 1180], [1024, 1366]]);
  return pick([[1440, 900], [1920, 1080], [1366, 768], [2560, 1440]]);
}

function pickStart(dayStart, dayEnd) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const hour = weightedPick(HOURS.map((weight, index) => [index, weight]));
    const ts = dayStart + hour * 3_600_000 + randInt(0, 3599) * 1000;
    if (ts < dayEnd - 90_000) return ts;
  }
  return dayStart + Math.floor(rng() * Math.max(60_000, dayEnd - dayStart - 90_000));
}

function outboundFor(profile) {
  const targets = [
    ['github.com', 'https://github.com/acme/pulse'],
    ['x.com', 'https://x.com/acme'],
    ['npmjs.com', 'https://www.npmjs.com/package/pulse-analytics'],
    ['developer.mozilla.org', 'https://developer.mozilla.org/en-US/docs/Web/API'],
  ];
  if (profile === PROFILES.docs) {
    targets.push(['nodejs.org', 'https://nodejs.org/api/http.html']);
    targets.push(['caddyserver.com', 'https://caddyserver.com/docs/']);
  }
  return pick(targets);
}

async function main() {
  await fsp.mkdir(config.eventsDir, { recursive: true });
  const existing = (await fsp.readdir(config.eventsDir)).filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  if (existing.length > 0 && !args.reset) {
    console.error(`Found ${existing.length} existing event file(s) in ${config.eventsDir}.`);
    console.error('Refusing to add duplicate demo data. Re-run with --reset to replace it.');
    process.exit(1);
  }
  if (args.reset) {
    for (const name of existing) {
      await fsp.unlink(path.join(config.eventsDir, name));
    }
    console.log(`Cleared ${existing.length} event file(s).`);
  }

  const sites = loadSites();
  const store = await new EventStore({
    dir: config.eventsDir,
    maxEvents: config.maxEvents,
    retentionDays: config.retentionDays,
  }).init();

  const now = Date.now();
  const today = new Date(now);
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const targets = [...sites.values()].map((site) => ({
    site,
    profile: PROFILES[site.id] || FALLBACK_PROFILE,
  }));

  const allEvents = [];
  let totalEvents = 0;
  const perSite = Object.fromEntries(targets.map(({ site }) => [site.id, { events: 0, sessions: 0 }]));

  for (let offset = args.days - 1; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * DAY;
    const isToday = offset === 0;
    const dayEnd = isToday ? now : dayStart + DAY;
    const elapsed = isToday ? clamp((now - dayStart) / DAY, 0.04, 1) : 1;
    const dayOfWeek = new Date(dayStart).getUTCDay();
    const weekly = [0.8, 1.06, 1.14, 1.09, 1.0, 0.85, 0.76][dayOfWeek];
    const growth = 0.88 + 0.3 * ((args.days - 1 - offset) / Math.max(1, args.days - 1));
    const noise = between(0.89, 1.11);

    for (const { site, profile } of targets) {
      const visitors = Math.max(3, Math.round(profile.base * weekly * growth * noise * elapsed));
      const visitorIds = Array.from({ length: visitors }, () => id(16));
      const sessionCount = Math.max(visitors, Math.round(visitors * between(1.06, 1.3)));

      for (let s = 0; s < sessionCount; s += 1) {
        const visitor = s < visitors ? visitorIds[s] : visitorIds[randInt(0, visitors - 1)];
        const session = id(16);
        const source = weightedPick(SOURCES.map((entry) => [entry, entry.weight]));
        const country = weightedPick(COUNTRIES);
        const device = weightedPick([['desktop', 33], ['mobile', 61], ['tablet', 6]]);
        const client = clientFor(device);
        const [lang, tz] = LOCALE[country] || ['en-US', 'UTC'];
        const [screenW, screenH] = screenFor(device);
        const pageCount = weightedPick([[1, 44], [2, 25], [3, 15], [4, 8], [5, 5], [6, 2], [7, 1]]);
        const firstIndex = weightedIndex(profile.pages);
        const visited = [profile.pages[firstIndex][0]];

        while (visited.length < pageCount) {
          let next = profile.pages[weightedIndex(profile.pages)][0];
          if (next === visited[visited.length - 1]) {
            next = profile.pages[randInt(0, profile.pages.length - 1)][0];
          }
          visited.push(next);
        }

        let cursor = pickStart(dayStart, dayEnd);
        const sessionEvents = [];
        const outbound = rng() < 0.045 ? outboundFor(profile) : null;

        for (let pageIndex = 0; pageIndex < visited.length; pageIndex += 1) {
          const page = visited[pageIndex];
          const pageviewId = id(12);
          const dwell = Math.round(clamp(gaussian(profile === PROFILES.docs ? 62 : 48, 34), 7, 420)) * 1000;

          sessionEvents.push({
            ts: cursor,
            site: site.id,
            type: 'pageview',
            visitor,
            session,
            path: page,
            pv: pageviewId,
            title: titleFor(profile, page).slice(0, 120),
            src: source.name,
            refdomain: source.domain,
            medium: source.medium,
            campaign: source.campaign || null,
            browser: client.browser,
            os: client.os,
            device,
            country,
            lang,
            tz,
            screen: [screenW, screenH],
          });

          sessionEvents.push({
            ts: cursor + dwell,
            site: site.id,
            type: 'duration',
            visitor,
            session,
            path: page,
            pv: pageviewId,
            duration: dwell,
          });

          const interactionAt = cursor + Math.min(dwell - 500, randInt(800, 120_000));
          if (rng() < 0.045) {
            sessionEvents.push({
              ts: interactionAt,
              site: site.id,
              type: 'event',
              visitor,
              session,
              path: page,
              name: 'cta_click',
              props: { cta: pick(['hero', 'nav', 'footer']) },
            });
          }
          if (page === '/pricing' && rng() < 0.09) {
            sessionEvents.push({
              ts: interactionAt,
              site: site.id,
              type: 'event',
              visitor,
              session,
              path: page,
              name: 'signup',
              props: { plan: pick(['starter', 'pro', 'team']) },
            });
          }
          if (page.startsWith('/blog') && rng() < 0.07) {
            sessionEvents.push({
              ts: interactionAt,
              site: site.id,
              type: 'event',
              visitor,
              session,
              path: page,
              name: 'newsletter_subscribe',
              props: { placement: 'post' },
            });
          }
          if (page === '/templates' && rng() < 0.08) {
            sessionEvents.push({
              ts: interactionAt,
              site: site.id,
              type: 'event',
              visitor,
              session,
              path: page,
              name: 'download_guide',
              props: { format: 'pdf' },
            });
          }
          if (page.startsWith('/docs') && rng() < 0.06) {
            sessionEvents.push({
              ts: interactionAt,
              site: site.id,
              type: 'event',
              visitor,
              session,
              path: page,
              name: 'copy_snippet',
              props: { snippet: pick(['tracker', 'event', 'api']) },
            });
          }

          cursor += dwell + randInt(1, 6) * 1000;
        }

        if (outbound && rng() < 0.8) {
          sessionEvents.push({
            ts: Math.min(cursor, dayEnd - 1000),
            site: site.id,
            type: 'outbound',
            visitor,
            session,
            path: visited[visited.length - 1],
            name: 'outbound',
            props: { host: outbound[0], url: outbound[1] },
          });
        }

        for (const event of sessionEvents) {
          if (event.ts >= dayEnd) continue;
          allEvents.push(event);
          totalEvents += 1;
          perSite[site.id].events += 1;
        }
        perSite[site.id].sessions += 1;
      }
    }

    if ((args.days - offset) % 10 === 0 || offset === 0) {
      process.stdout.write(`  generated ${args.days - offset}/${args.days} days (${totalEvents.toLocaleString()} events)\n`);
    }
  }

  // A small live tail so the "Live" panel and realtime feed are populated
  // immediately after seeding (independent of how late in the UTC day it runs).
  const liveSpecs = [
    { ago: 45_000, page: 2, source: 0, country: 'US', device: 'desktop', event: 'cta_click' },
    { ago: 110_000, page: 1, source: 1, country: 'DE', device: 'mobile' },
    { ago: 185_000, page: 0, source: 2, country: 'GB', device: 'mobile' },
  ];

  for (const { site, profile } of targets) {
    for (const spec of liveSpecs) {
      const visitor = id(16);
      const session = id(16);
      const pageviewId = id(12);
      const ts = now - spec.ago;
      const page = profile.pages[spec.page % profile.pages.length][0];
      const source = SOURCES[spec.source % SOURCES.length];
      const client = clientFor(spec.device);
      const [lang, tz] = LOCALE[spec.country] || ['en-US', 'UTC'];
      const [screenW, screenH] = screenFor(spec.device);

      allEvents.push({
        ts,
        site: site.id,
        type: 'pageview',
        visitor,
        session,
        path: page,
        pv: pageviewId,
        title: titleFor(profile, page),
        src: source.name,
        refdomain: source.domain,
        medium: source.medium,
        campaign: source.campaign || null,
        browser: client.browser,
        os: client.os,
        device: spec.device,
        country: spec.country,
        lang,
        tz,
        screen: [screenW, screenH],
      });
      allEvents.push({
        ts: ts + 9_000,
        site: site.id,
        type: 'duration',
        visitor,
        session,
        path: page,
        pv: pageviewId,
        duration: 9_000,
      });
      if (spec.event) {
        allEvents.push({
          ts: ts + 5_000,
          site: site.id,
          type: 'event',
          visitor,
          session,
          path: page,
          name: spec.event,
          props: { cta: 'hero' },
        });
      }
      perSite[site.id].events += spec.event ? 3 : 2;
      perSite[site.id].sessions += 1;
      totalEvents += spec.event ? 3 : 2;
    }
  }

  // Store queries assume chronological order. Real ingestion is append-only and
  // server-clocked; seeded sessions need an explicit sort before writing.
  allEvents.sort((a, b) => a.ts - b.ts);
  for (const event of allEvents) store.record(event);
  await store.close();

  console.log('\nDemo data ready.');
  for (const [siteId, counts] of Object.entries(perSite)) {
    console.log(`  ${siteId}: ${counts.events.toLocaleString()} events · ${counts.sessions.toLocaleString()} sessions`);
  }
  console.log(`  data dir: ${config.eventsDir}`);
  console.log('\nStart the server with: npm start');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
