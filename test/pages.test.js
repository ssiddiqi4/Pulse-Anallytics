import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PageLibrary,
  PageError,
  normalizePagePath,
  extractTitle,
  replaceBody,
  replaceTitle,
} from '../src/pages.js';

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pulse-pages-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const index = `<!doctype html>
<html lang="en">
<head>
  <title>Home &amp; Welcome</title>
  <style>body { color: red }</style>
  <script>window.keep = true;</script>
</head>
<body class="home" data-page="one">
  <h1>Hello</h1>
  <p>Original copy.</p>
</body>
</html>
`;
  await fsp.mkdir(path.join(root, 'guides'), { recursive: true });
  await fsp.writeFile(path.join(root, 'index.html'), index);
  await fsp.writeFile(
    path.join(root, 'guides', 'install.html'),
    '<!doctype html><html><head><title>Install</title></head><body><p>Install it.</p></body></html>',
  );
  await fsp.writeFile(path.join(root, 'styles.css'), 'body{}');
  await fsp.writeFile(path.join(root, '.draft.html'), '<html><body>draft</body></html>');
  return { root, index };
}

test('lists HTML pages recursively and ignores assets and dotfiles', async (t) => {
  const { root } = await fixture(t);
  const library = new PageLibrary({ root });
  const pages = await library.list();
  assert.deepEqual(pages.map((page) => page.path), ['guides/install.html', 'index.html']);
  assert.equal(pages[1].name, 'index.html');
  assert.equal(pages[1].dir, '');
  assert.equal(pages[0].dir, 'guides');
  assert.ok(pages[1].bytes > 0);
  assert.ok(pages[1].modified > 0);
});

test('reads metadata and extracts entities from the title', async (t) => {
  const { root } = await fixture(t);
  const library = new PageLibrary({ root });
  const meta = await library.get('index.html');
  assert.equal(meta.title, 'Home & Welcome');
  assert.equal(meta.backup, false);
  assert.ok(meta.bytes > 100);

  const page = await library.read('index.html');
  assert.match(page.html, /<h1>Hello<\/h1>/);
  assert.equal(extractTitle('<title> A &lt; B </title>'), 'A < B');
});

test('saves only the body, preserves head/scripts/attributes and creates a backup', async (t) => {
  const { root, index } = await fixture(t);
  const library = new PageLibrary({ root });
  const saved = await library.save('index.html', {
    body: '<h1>Updated</h1>\n<p>New copy.</p>',
    title: 'A new <title>',
  });

  const html = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<body class="home" data-page="one">/, 'body attributes preserved');
  assert.match(html, /<h1>Updated<\/h1>/);
  assert.match(html, /<p>New copy.<\/p>/);
  assert.match(html, /<style>body \{ color: red \}<\/style>/, 'styles preserved');
  assert.match(html, /<script>window\.keep = true;<\/script>/, 'scripts preserved');
  assert.match(html, /<title>A new &lt;title&gt;<\/title>/);
  assert.doesNotMatch(html, /Original copy/);
  assert.equal(extractTitle(html), 'A new <title>');

  const backup = await fsp.readFile(path.join(root, 'index.html.bak'), 'utf8');
  assert.equal(backup, index, 'backup holds the exact previous revision');
  assert.equal(saved.backup, 'index.html.bak');
  assert.equal(saved.title, 'A new <title>');
  assert.equal((await library.get('index.html')).backup, true);
});

test('preserves CRLF line endings', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pulse-crlf-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'index.html'), '<html>\r\n<body>\r\n<p>old</p>\r\n</body>\r\n</html>\r\n');
  const library = new PageLibrary({ root });
  await library.save('index.html', { body: '<p>first</p>\n<p>second</p>' });
  const html = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<p>first<\/p>\r\n<p>second<\/p>/);
  assert.doesNotMatch(html, /[^\r]\n/);
});

test('rejects traversal, non-HTML files, document tags and oversized pages', async (t) => {
  const { root } = await fixture(t);
  const library = new PageLibrary({ root });

  await assert.rejects(() => library.read('../outside.html'), (err) => err instanceof PageError && err.status === 400);
  await assert.rejects(() => library.read('/etc/passwd'), (err) => err instanceof PageError && err.status === 400);
  await assert.rejects(() => library.read('styles.css'), (err) => err instanceof PageError && err.status === 400);
  await assert.rejects(() => library.read('missing.html'), (err) => err instanceof PageError && err.status === 404);

  await assert.rejects(
    () => library.save('index.html', { body: '<html><body>sneaky</body></html>' }),
    (err) => err instanceof PageError && err.status === 400,
  );
  await assert.rejects(
    () => library.save('index.html', { body: '<p>ok</p>', title: 42 }),
    (err) => err instanceof PageError && err.status === 400,
  );

  const small = new PageLibrary({ root, maxBytes: 120 });
  await assert.rejects(() => small.read('index.html'), (err) => err instanceof PageError && err.status === 413);
  await assert.rejects(() => small.get('index.html'), (err) => err instanceof PageError && err.status === 413);

  assert.equal(normalizePagePath('guides\\install.html'), 'guides/install.html');
  assert.throws(() => normalizePagePath('guides/../index.html'), PageError);
  assert.throws(() => normalizePagePath(''), PageError);
  assert.throws(() => normalizePagePath('index.asp'), PageError);
});

test('replaceBody requires a body element and title replacement escapes text', () => {
  assert.throws(() => replaceBody('<html><head></head></html>', '<p>x</p>'), PageError);
  assert.equal(
    replaceBody('<html><body class="x">old</body></html>', '<p>new</p>').includes('<body class="x">'),
    true,
  );
  assert.equal(replaceTitle('<head><title>Old</title></head>', 'New & improved'), '<head><title>New &amp; improved</title></head>');
  assert.equal(replaceTitle('<head><title>Old</title></head>', ''), '<head><title></title></head>');
  assert.equal(replaceTitle('<head></head>', 'Added'), '<head>  <title>Added</title>\n</head>');
  assert.equal(replaceTitle('<head><title>Old</title></head>', undefined), '<head><title>Old</title></head>');
});
