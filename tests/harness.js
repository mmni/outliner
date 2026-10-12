// Starts the real server on a temporary data folder and a free port, and drives it in headless Chrome.
'use strict';

const { chromium, devices } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
}

function find(root, id) {
  let found = null;
  (function walk(n) { for (const c of n.children) { if (c.id === id) found = c; walk(c); } })(root);
  return found;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start at ${url}`);
}

// options: { device: Playwright device name, hash: start URL hash }
async function startApp(data = fixture(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outliner-test-'));
  const dataFile = path.join(dir, 'outline.json');
  fs.writeFileSync(dataFile, JSON.stringify(data));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    env: { ...process.env, OUTLINER_DATA: dir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitForServer(url);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext(options.device ? devices[options.device] : { viewport: { width: 1300, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Each test starts from clean browser state; reloads within a test keep theirs.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('outliner-test')) { localStorage.clear(); sessionStorage.setItem('outliner-test', '1'); }
  });
  await page.goto(url + (options.hash ?? '#/'));
  await page.waitForSelector('#tree .text, #releases .item');

  return {
    page,
    url,
    errors,
    key: (k) => page.keyboard.press(k),
    type: (t) => page.keyboard.type(t),
    // The app saves 400 ms after a change; wait past that, then read what reached the disk.
    async file() {
      await page.waitForTimeout(600);
      return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    },
    selected: () => page.evaluate(() => document.querySelector('#tree .row.selected, #releases .row.selected')?.parentElement.dataset.id),
    editing: () => page.evaluate(() => document.body.classList.contains('editing')),
    rows: (root = '#tree') => page.$$eval(`${root} .item`, (els) => els.map((e) => e.dataset.id)),
    // Selects a row with keys only: first row, then down until it is reached.
    async select(id) {
      await page.keyboard.press('g');
      for (let i = 0; i < 40 && (await this.selected()) !== id; i++) await page.keyboard.press('j');
      if ((await this.selected()) !== id) throw new Error(`could not select ${id}`);
    },
    async close() {
      await browser.close();
      server.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startApp, fixture, find };
