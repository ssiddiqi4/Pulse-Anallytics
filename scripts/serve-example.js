#!/usr/bin/env node
/** Serves examples/static-site so you can watch the tracker end to end. */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../examples/static-site');
const PORT = Number(process.env.EXAMPLE_PORT || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/') relative = '/index.html';
    const file = path.resolve(ROOT, `.${relative}`);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pulse] demo site http://localhost:${PORT} (tracker posts to http://localhost:4000)`);
});
