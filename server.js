#!/usr/bin/env node
// Outliner server: serves public/ and persists the outline to data/outline.json.
// No dependencies and no authentication, so by default it answers this machine only.
// HOST=0.0.0.0 opens it to the network, where anyone who can reach the port can read and overwrite the outline.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 4477;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.OUTLINER_DATA || path.join(__dirname, 'data');
const OUTLINE_FILE = path.join(DATA_DIR, 'outline.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const EMPTY_OUTLINE = {
  version: 1,
  root: { id: 'root', text: '', status: null, collapsed: false, children: [] },
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function readOutline() {
  try {
    return fs.readFileSync(OUTLINE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return JSON.stringify(EMPTY_OUTLINE);
    throw err;
  }
}

// Keeps the first version of each day, so a bad edit can be recovered from yesterday's file.
function backupOncePerDay() {
  if (!fs.existsSync(OUTLINE_FILE)) return;
  const day = new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
  const dest = path.join(BACKUP_DIR, `outline-${day}.json`);
  if (!fs.existsSync(dest)) fs.copyFileSync(OUTLINE_FILE, dest);
}

// The outline's version. A save names the version it was based on, so a window holding an older
// copy cannot silently replace newer work saved from another window.
let revision = (() => { try { return String(fs.statSync(OUTLINE_FILE).mtimeMs); } catch { return '0'; } })();
let writes = 0;

function writeOutline(body) {
  const outline = JSON.parse(body);
  if (!outline || !outline.root || !Array.isArray(outline.root.children)) {
    throw new Error('outline must have a root with a children array');
  }
  backupOncePerDay();
  const tmp = `${OUTLINE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(outline, null, 2));
  fs.renameSync(tmp, OUTLINE_FILE);
  revision = `${Date.now()}-${++writes}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Dev convenience: browsers connected here are told when a file in public/ changes.
const reloadClients = new Set();
fs.watch(PUBLIC_DIR, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  for (const res of reloadClients) res.write(`data: ${filename}\n\n`);
});

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/api/outline' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store', 'X-Outline-Rev': revision });
      res.end(readOutline());
    } else if (pathname === '/api/outline' && req.method === 'PUT') {
      const base = req.headers['if-match'];
      const body = await readBody(req);
      if (base && base !== revision) {
        res.writeHead(409, { 'Content-Type': CONTENT_TYPES['.json'] }).end(JSON.stringify({ rev: revision }));
        return;
      }
      writeOutline(body);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.json'] }).end(JSON.stringify({ rev: revision }));
      // Other open windows reload the outline when they have nothing unsaved of their own.
      for (const client of reloadClients) client.write(`event: outline\ndata: ${revision}\n\n`);
    } else if (pathname === '/api/dev-reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': connected\n\n');
      reloadClients.add(res);
      req.on('close', () => reloadClients.delete(res));
    } else if (req.method === 'GET') {
      serveStatic(req, res, pathname);
    } else {
      res.writeHead(405).end();
    }
  } catch (err) {
    console.error(err);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(err.message || err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Outliner running at http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) if (a.family === 'IPv4' && !a.internal) console.log(`  on the network: http://${a.address}:${PORT}`);
    }
  }
  console.log(`Data file: ${OUTLINE_FILE}`);
});
