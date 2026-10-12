// Zooming into a task is switched off; nothing may land the page in a zoomed view.
'use strict';

const { startApp, fixture } = require('./harness');

module.exports = async (check) => {
  const data = fixture();
  data.root.children[1].children[0].collapsed = true; // fold "Import pipeline…" so Enter must unfold it
  const app = await startApp(data);
  const { page, key } = app;
  const atRoot = () => page.evaluate(() => (location.hash === '#/' || location.hash === '') && document.querySelector('#title').hidden);
  try {
    await page.click('#tree .item[data-id="a"] > .row > .bullet');
    await page.waitForTimeout(200);
    check('a bullet click does not zoom', await atRoot());
    await key('g'); await key(']'); await page.waitForTimeout(200);
    check('] does not zoom', await atRoot());
    await key('Enter'); await key('Meta+BracketRight'); await page.waitForTimeout(200); await key('Escape');
    check('⌘] while editing does not zoom', await atRoot());
    check('the zoom keys are not in the key list', !(await page.textContent('#shortcut-list')).includes('Zoom'));

    await page.goto(`${app.url}#/b`); await page.waitForSelector('#tree .text');
    check('an old zoomed link opens the full outline', await page.evaluate(() => document.querySelector('#title').hidden && !!document.querySelector('#tree .item[data-id="a"]')));

    await page.goto(`${app.url}#/releases`); await page.waitForSelector('#releases .item');
    await page.click('#releases .item[data-id="b1"] > .row > .text');
    await page.waitForTimeout(200);
    check('a click in the Releases view only selects', (await page.getAttribute('#main', 'data-view')) === 'releases' && (await app.selected()) === 'b1');
    await page.click('#releases .item[data-id="b14"] > .row > .text'); await key('Enter'); await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ view: document.querySelector('#main').dataset.view, hash: location.hash, editing: document.activeElement.closest?.('.item')?.dataset.id }));
    check('Enter in the Releases view opens the task in the full outline, parents unfolded', st.view === 'outline' && (st.hash === '#/' || st.hash === '') && st.editing === 'b14', JSON.stringify(st));
    await key('Escape');

    const src = await page.locator('#tree .item[data-id="d"] > .row > .bullet').boundingBox();
    const dst = await page.locator('#tree .item[data-id="a"] > .row').boundingBox();
    await page.mouse.move(src.x + 5, src.y + 5); await page.mouse.down();
    await page.mouse.move(dst.x + 200, dst.y + 3, { steps: 8 }); await page.mouse.up();
    check('dragging by the bullet still moves the item', (await app.file()).root.children[0].id === 'd');
    check('no console errors (zoom)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
