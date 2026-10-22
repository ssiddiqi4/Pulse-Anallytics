import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

test('server accepts events and serves stats, tracker and CORS', async (t) => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pulse-server-'));
  const sitesFile = path.join(temp, 'sites.json');
  await fsp.writeFile(
    sitesFile,
    JSON.stringify({ sites: [{ id: 'acme', name: 'Acme', domain: 'acme.test' }] }),
  );

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: path.join(temp, 'data'),
      SITES_FILE: sitesFile,
      ADMIN_TOKEN: '',
      SALT_SECRET: 'e2e-test-secret',
      RATE_LIMIT: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let exited = false;
  child.on('exit', () => { exited = true; });

  t.after(async () => {
    if (!exited) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await fsp.rm(temp, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/\[pulse\] ready (\{.*\})/);
      if (match) {
        clearTimeout(timer);
        resolve(JSON.parse(match[1]).port);
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${output}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'User-Agent': UA,
    'CF-IPCountry': 'DE',
  };

  const tracker = await fetch(`${base}/t.js`);
  assert.equal(tracker.status, 200);
  assert.match(tracker.headers.get('content-type'), /javascript/);
  assert.equal(tracker.headers.get('access-control-allow-origin'), '*');
  assert.match(await tracker.text(), /sendBeacon/);

  const pageviewResponse = await fetch(`${base}/api/v1/event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      v: 1,
      site: 'acme',
      type: 'pageview',
      sid: 'testsession123',
      pv: 'testpageview01',
      p: '/pricing?utm_source=newsletter',
      t: 'Pricing',
      r: 'https://www.google.com/search?q=acme',
      u: { source: 'newsletter', medium: 'email', name: 'fall' },
      l: 'de-DE',
      tz: 'Europe/Berlin',
      screen: { w: 1280, h: 800 },
    }),
  });
  assert.equal(pageviewResponse.status, 204);

  const durationResponse = await fetch(`${base}/api/v1/event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      v: 1,
      site: 'acme',
      type: 'duration',
      sid: 'testsession123',
      pv: 'testpageview01',
      p: '/pricing',
      d: 12_000,
    }),
  });
  assert.equal(durationResponse.status, 204);

  const eventResponse = await fetch(`${base}/api/v1/event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      v: 1,
      site: 'acme',
      type: 'event',
      sid: 'testsession123',
      p: '/pricing',
      name: 'signup',
      props: { plan: 'pro' },
    }),
  });
  assert.equal(eventResponse.status, 204);

  const statsResponse = await fetch(`${base}/api/v1/stats?site=acme&range=24h`);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.equal(stats.totals.pageviews, 1);
  assert.equal(stats.totals.visitors, 1);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.bounceRate, 0, 'custom event counts as engagement');
  assert.equal(stats.topPages[0].path, '/pricing');
  assert.equal(stats.sources[0].name, 'newsletter');
  assert.equal(stats.countries[0].name, 'DE');
  assert.equal(stats.events[0].name, 'signup');
  assert.ok(stats.totals.visitDuration >= 12_000);
  assert.equal(stats.range.key, '24h');
  assert.equal(stats.site.name, 'Acme');

  const live = await (await fetch(`${base}/api/v1/live?site=acme`)).json();
  assert.equal(live.active, 1);
  assert.ok(live.recent.some((row) => row.name === 'signup'));

  const sites = await (await fetch(`${base}/api/v1/sites`)).json();
  assert.equal(sites.auth, false);
  assert.equal(sites.editor, true);
  assert.equal(sites.sites[0].id, 'acme');

  const openPages = await fetch(`${base}/api/v1/pages`);
  assert.equal(openPages.status, 200);
  assert.ok((await openPages.json()).pages.some((page) => page.path === 'index.html'));

  const preflight = await fetch(`${base}/api/v1/event`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const unknown = await fetch(`${base}/api/v1/event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ v: 1, site: 'missing', type: 'pageview', p: '/' }),
  });
  assert.equal(unknown.status, 400);

  const health = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.store.events, 3);

  const exportResponse = await fetch(`${base}/api/v1/export?site=acme&range=24h&dataset=pages`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /text\/csv/);
  assert.match(await exportResponse.text(), /\/pricing/);

  const dashboard = await fetch(`${base}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Pulse/);
});

test('admin token protects dashboard APIs while collection stays public', async (t) => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pulse-auth-'));
  const sitesFile = path.join(temp, 'sites.json');
  await fsp.writeFile(
    sitesFile,
    JSON.stringify({ sites: [{ id: 'acme', name: 'Acme', domain: 'acme.test' }] }),
  );
  const contentDir = path.join(temp, 'content');
  await fsp.mkdir(contentDir, { recursive: true });
  const originalPage = '<!doctype html><html><head><title>Editable</title><script>window.keep=1;</script></head><body><p>Before</p></body></html>';
  await fsp.writeFile(path.join(contentDir, 'index.html'), originalPage);
  await fsp.writeFile(path.join(contentDir, 'about.htm'), '<html><head><title>About</title></head><body><p>About</p></body></html>');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: path.join(temp, 'data'),
      SITES_FILE: sitesFile,
      CONTENT_DIR: contentDir,
      ADMIN_TOKEN: 'top-secret-token',
      SALT_SECRET: 'auth-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let exited = false;
  child.on('exit', () => { exited = true; });
  t.after(async () => {
    if (!exited) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await fsp.rm(temp, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/\[pulse\] ready (\{.*\})/);
      if (match) {
        clearTimeout(timer);
        resolve(JSON.parse(match[1]).port);
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${output}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/v1/sites`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/stats?site=acme&range=7d`)).status, 401);

  const wrong = await fetch(`${base}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'nope' }),
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'top-secret-token' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie');
  assert.ok(setCookie, 'login should set a cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.doesNotMatch(setCookie, /top-secret-token/, 'raw token must not be stored in the cookie');
  const cookie = setCookie.split(';')[0];

  const sites = await fetch(`${base}/api/v1/sites`, { headers: { cookie } });
  assert.equal(sites.status, 200);
  const sitesPayload = await sites.json();
  assert.equal(sitesPayload.auth, true);
  assert.equal(sitesPayload.editor, true);
  assert.ok(sitesPayload.contentRoot, 'content root is reported');

  assert.equal((await fetch(`${base}/api/v1/pages`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/pages/file?path=index.html`)).status, 401);

  const pageList = await fetch(`${base}/api/v1/pages`, { headers: { cookie } });
  assert.equal(pageList.status, 200);
  const pageListPayload = await pageList.json();
  assert.deepEqual(pageListPayload.pages.map((page) => page.path), ['about.htm', 'index.html']);
  assert.ok(pageListPayload.root);

  const pageMeta = await (await fetch(`${base}/api/v1/pages/file?path=index.html`, { headers: { cookie } })).json();
  assert.equal(pageMeta.title, 'Editable');
  assert.equal(pageMeta.backup, false);

  const traversal = await fetch(`${base}/api/v1/pages/file?path=../sites.json`, { headers: { cookie } });
  assert.equal(traversal.status, 400);

  const save = await fetch(`${base}/api/v1/pages/file`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'index.html', body: '<p>After</p>', title: 'Saved page' }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.path, 'index.html');
  assert.equal(saved.title, 'Saved page');

  const savedHtml = await fsp.readFile(path.join(contentDir, 'index.html'), 'utf8');
  assert.match(savedHtml, /<title>Saved page<\/title>/);
  assert.match(savedHtml, /<p>After<\/p>/);
  assert.match(savedHtml, /window\.keep=1/, 'head script preserved');
  const backup = await fsp.readFile(path.join(contentDir, 'index.html.bak'), 'utf8');
  assert.equal(backup, originalPage);

  assert.equal((await fetch(`${base}/content/index.html`)).status, 401);
  const preview = await fetch(`${base}/content/index.html`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy'), /script-src 'none'/);
  assert.match(await preview.text(), /<p>After<\/p>/);

  const htmPreview = await fetch(`${base}/content/about.htm`, { headers: { cookie } });
  assert.equal(htmPreview.status, 200);
  assert.match(htmPreview.headers.get('content-type'), /text\/html/);
  assert.match(htmPreview.headers.get('content-security-policy'), /script-src 'none'/);

  const bearer = await fetch(`${base}/api/v1/stats?site=acme&range=7d`, {
    headers: { authorization: 'Bearer top-secret-token' },
  });
  assert.equal(bearer.status, 200);

  const collect = await fetch(`${base}/api/v1/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': UA },
    body: JSON.stringify({
      v: 1,
      site: 'acme',
      type: 'pageview',
      sid: 'authsession123',
      p: '/',
    }),
  });
  assert.equal(collect.status, 204, 'public tracking endpoint ignores admin auth');

  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  assert.equal((await fetch(`${base}/t.js`)).status, 200);
});
