// Phone layout: readable rows, slide-over panels, tap to edit.
'use strict';

const { startApp } = require('./harness');

module.exports = async (check) => {
  const app = await startApp(undefined, { device: 'iPhone 13' });
  const { page } = app;
  try {
    check('the sidebar starts closed on a phone', (await page.evaluate(() => document.documentElement.dataset.sidebar)) === 'hidden');
    const widths = await page.$$eval('#tree .item[data-level="2"] > .row > .text', (els) => els.map((e) => e.getBoundingClientRect().width));
    check('level-2 task text gets most of the width, not a sliver', widths.every((w) => w > 250), widths.map(Math.round).join(','));
    check('nothing scrolls sideways', (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
    await page.tap('#tree .item[data-id="b14"] > .row > .text');
    check('a tap on task text edits it', await page.evaluate(() => document.activeElement.classList.contains('text')));
    await page.tap('#sidebar-toggle'); await page.waitForTimeout(300);
    await page.tap('#sidebar button[data-query="status:idea"]'); await page.waitForTimeout(300);
    check('picking a filter keeps the sidebar open for the next one', (await page.evaluate(() => document.documentElement.dataset.sidebar)) !== 'hidden');
    await page.tap('#main', { position: { x: 380, y: 600 } }); await page.waitForTimeout(300);
    check('a tap outside closes it', (await page.evaluate(() => document.documentElement.dataset.sidebar)) === 'hidden');
    check('no console errors (phone)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
