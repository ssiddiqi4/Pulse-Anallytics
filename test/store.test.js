import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventStore } from '../src/store.js';

const silent = { error() {}, warn() {}, log() {} };

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pulse-store-'));
}

test('persists events, reloads them sorted, and filters queries', async (t) => {
  const dir = await tempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const store = await new EventStore({ dir: path.join(dir, 'events'), logger: silent }).init();
  const day = Date.UTC(2026, 9, 21);
  store.record({ ts: day + 2000, site: 'demo', type: 'pageview', visitor: 'v1', session: 's1', path: '/' });
  store.record({ ts: day + 1000, site: 'demo', type: 'pageview', visitor: 'v1', session: 's1', path: '/pricing' });
  store.record({ ts: day + 3000, site: 'other', type: 'pageview', visitor: 'v2', session: 's2', path: '/' });
  await store.close();

  const files = await fsp.readdir(path.join(dir, 'events'));
  assert.equal(files.length, 1);
  const line = (await fsp.readFile(path.join(dir, 'events', files[0]), 'utf8')).trim().split('\n');
  assert.equal(line.length, 3);

  const reloaded = await new EventStore({ dir: path.join(dir, 'events'), logger: silent }).init();
  t.after(() => reloaded.close());

  const events = reloaded.query('demo', day, day + 10_000);
  assert.equal(events.length, 2);
  assert.equal(events[0].ts, day + 1000, 'memory should be sorted by timestamp');
  assert.equal(reloaded.query('other', day, day + 10_000).length, 1);
  assert.equal(reloaded.query('demo', day + 1500, day + 10_000).length, 1);

  const status = reloaded.status();
  assert.equal(status.events, 3);
  assert.equal(status.writeErrors, 0);
});

test('caps memory and purges old files by retention', async (t) => {
  const dir = await tempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const eventsDir = path.join(dir, 'events');
  await fsp.mkdir(eventsDir, { recursive: true });

  const oldTs = Date.UTC(2020, 0, 1);
  const oldFile = path.join(eventsDir, 'events-2020-01-01.jsonl');
  await fsp.writeFile(
    oldFile,
    `${JSON.stringify({ ts: oldTs, site: 'demo', type: 'pageview', visitor: 'v', session: 's', path: '/' })}\n`,
  );

  const store = await new EventStore({ dir: eventsDir, retentionDays: 30, maxEvents: 2, logger: silent }).init();
  t.after(() => store.close());

  // init filters out files older than retention
  assert.equal(store.events.length, 0);
  await store.purge();
  const files = await fsp.readdir(eventsDir);
  assert.ok(!files.includes('events-2020-01-01.jsonl'), 'old file should be deleted');

  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    store.record({ ts: now + i, site: 'demo', type: 'pageview', visitor: 'v', session: 's', path: '/' });
  }
  assert.equal(store.events.length, 2);
  assert.equal(store.events[1].ts, now + 4);
});
