import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_DEPTH = 3;
const TITLE_MAX = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'vendor']);

export class PageError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PageError';
    this.status = status;
  }
}

/** Normalizes a page path relative to the content root and rejects escapes. */
export function normalizePagePath(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim();
  if (!raw) throw new PageError(400, 'Missing page path');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new PageError(400, 'Page path must be relative');
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new PageError(400, 'Page path contains control characters');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new PageError(400, 'Page path contains an invalid segment');
  }
  if (!/\.html?$/i.test(raw)) throw new PageError(400, 'Only .html pages can be edited');
  return parts.join('/');
}

export function extractTitle(html) {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
    .slice(0, TITLE_MAX);
}

function escapeTitle(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replaces the inner HTML of the document body, preserving head, scripts and attributes. */
export function replaceBody(html, body) {
  const open = /<body\b[^>]*>/i.exec(html);
  if (!open) throw new PageError(422, 'Page has no <body> element');
  const closeAt = html.toLowerCase().lastIndexOf('</body>');
  if (closeAt < open.index) throw new PageError(422, 'Page has no closing </body> tag');
  const start = open.index + open[0].length;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  return `${html.slice(0, start)}${eol}${body}${eol}${html.slice(closeAt)}`;
}

export function replaceTitle(html, title) {
  if (title === undefined) return html;
  const clean = String(title).trim().slice(0, TITLE_MAX);
  const tag = `<title>${escapeTitle(clean)}</title>`;
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, tag);
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  return html;
}

function assertSafeBody(body) {
  if (typeof body !== 'string') throw new PageError(400, 'body must be a string');
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    throw new PageError(413, 'Page body is too large (max 2 MB)');
  }
  if (/<(?:!doctype|html|head|body)\b/i.test(body)) {
    throw new PageError(400, 'Edit the body content only, not document-level tags');
  }
}

/**
 * A small, safe page library rooted at a directory. All paths are relative to
 * the root; symlinks and traversal are rejected. Saves are atomic and keep the
 * previous revision as `<file>.bak`.
 */
export class PageLibrary {
  constructor({ root, maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
    if (!root) throw new Error('PageLibrary requires a root directory');
    this.root = path.resolve(root);
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
  }

  #resolve(relative) {
    const rel = normalizePagePath(relative);
    const file = path.resolve(this.root, rel);
    if (file !== this.root && !file.startsWith(this.root + path.sep)) {
      throw new PageError(400, 'Page path escapes the content directory');
    }
    return { rel, file };
  }

  async #realPath(file) {
    let realRoot;
    try {
      realRoot = await fsp.realpath(this.root);
    } catch (err) {
      if (err.code === 'ENOENT') throw new PageError(404, 'Content directory does not exist');
      throw err;
    }
    let real;
    try {
      real = await fsp.realpath(file);
    } catch (err) {
      if (err.code === 'ENOENT') throw new PageError(404, 'Page not found');
      throw err;
    }
    if (!real.startsWith(realRoot + path.sep)) {
      throw new PageError(403, 'Page resolves outside the content directory');
    }
    return real;
  }

  async list() {
    const pages = [];
    const walk = async (dir, prefix, depth) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name)) continue;
          await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
          continue;
        }
        if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
        if (pages.length >= this.maxFiles) return;
        const file = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(file);
          pages.push({
            path: `${prefix}${entry.name}`,
            name: entry.name,
            dir: prefix.replace(/\/$/, ''),
            bytes: stat.size,
            modified: stat.mtimeMs,
          });
        } catch {
          /* a file can disappear between readdir and stat */
        }
      }
    };
    await walk(this.root, '', 0);
    pages.sort((a, b) => a.path.localeCompare(b.path));
    return pages;
  }

  async read(relative) {
    const { rel, file } = this.#resolve(relative);
    const real = await this.#realPath(file);
    const stat = await fsp.lstat(real);
    if (!stat.isFile()) throw new PageError(404, 'Page not found');
    if (stat.size > this.maxBytes) throw new PageError(413, 'Page is too large to edit (max 2 MB)');
    const html = await fsp.readFile(real, 'utf8');
    if (html.includes('\u0000')) throw new PageError(415, 'Page does not look like an HTML text file');
    return {
      path: rel,
      html,
      title: extractTitle(html),
      bytes: Buffer.byteLength(html, 'utf8'),
      modified: stat.mtimeMs,
    };
  }

  async get(relative) {
    const { rel, file } = this.#resolve(relative);
    const real = await this.#realPath(file);
    const stat = await fsp.lstat(real);
    if (!stat.isFile()) throw new PageError(404, 'Page not found');
    if (stat.size > this.maxBytes) throw new PageError(413, 'Page is too large to edit (max 2 MB)');
    const html = await fsp.readFile(real, 'utf8');
    return {
      path: rel,
      title: extractTitle(html),
      bytes: stat.size,
      modified: stat.mtimeMs,
      backup: await this.#hasBackup(file),
    };
  }

  async save(relative, { body, title } = {}) {
    assertSafeBody(body);
    const { rel, file } = this.#resolve(relative);
    const real = await this.#realPath(file);
    const stat = await fsp.lstat(real);
    if (!stat.isFile()) throw new PageError(404, 'Page not found');
    if (stat.size > this.maxBytes) throw new PageError(413, 'Page is too large to edit (max 2 MB)');

    const original = await fsp.readFile(real, 'utf8');
    if (original.includes('\u0000')) throw new PageError(415, 'Page does not look like an HTML text file');

    let nextBody = body.replace(/\r\n/g, '\n');
    if (original.includes('\r\n')) nextBody = nextBody.replace(/\n/g, '\r\n');
    let updated = replaceBody(original, nextBody);
    if (title !== undefined) {
      if (typeof title !== 'string') throw new PageError(400, 'title must be a string');
      updated = replaceTitle(updated, title);
    }
    if (Buffer.byteLength(updated, 'utf8') > this.maxBytes) {
      throw new PageError(413, 'Page is too large after saving (max 2 MB)');
    }

    await fsp.writeFile(`${real}.bak`, original, 'utf8');
    const temp = `${real}.pulse-${process.pid}-${Date.now()}.tmp`;
    try {
      await fsp.writeFile(temp, updated, 'utf8');
      await fsp.rename(temp, real);
    } catch (err) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw err;
    }

    const after = await fsp.stat(real);
    return {
      path: rel,
      title: extractTitle(updated),
      bytes: after.size,
      modified: after.mtimeMs,
      backup: `${rel}.bak`,
    };
  }

  async #hasBackup(file) {
    try {
      await fsp.access(`${file}.bak`);
      return true;
    } catch {
      return false;
    }
  }
}
