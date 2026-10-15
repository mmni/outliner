// Zooming into a task happens only on purpose: a ⌘-click (Ctrl-click off a Mac) or ] / [, never a plain click.
'use strict';

const { startApp, fixture } = require('./harness');

module.exports = async (check) => {
  const data = fixture();
  data.root.children[1].children[0].collapsed = true; // fold "Import pipeline…" so Enter from Releases must unfold it
  const app = await startApp(data);
  const { page, key } = app;
  const MOD = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Meta' : 'Control'));
  const state = () => page.evaluate(() => ({ hash: location.hash, title: document.querySelector('#title').hidden ? null : document.querySelector('#title').textContent }));
  const atRoot = async () => { const s = await state(); return (s.hash === '#/' || s.hash === '') && s.title === null; };
  try {
    await page.click('#tree .item[data-id="a"] > .row > .bullet');
    await page.waitForTimeout(200);
    check('a plain click on a bullet does not zoom', await atRoot());
    await page.click('#tree .item[data-id="c"] > .row > .text');
    await page.waitForTimeout(200);
    check('a plain click on task text does not zoom', await atRoot());

    await page.click('#tree .item[data-id="c"] > .row > .text', { modifiers: [MOD] });
    await page.waitForTimeout(200);
    let s = await state();
    check(`${MOD}-click on task text zooms into that task`, s.hash === '#/c' && s.title === 'Tooling', JSON.stringify(s));
    check('…and shows its children as the top level', (await app.rows()).join(',') === 'c1,c2');
    await page.click('#breadcrumb a');
    await page.waitForTimeout(200);
    check('the breadcrumb zooms back out', await atRoot());

    await page.click('#tree .item[data-id="d"] > .row > .bullet', { modifiers: [MOD] });
    await page.waitForTimeout(200);
    check(`${MOD}-click on a bullet zooms too`, (await state()).hash === '#/d');
    await key('[');
    await page.waitForTimeout(200);
    check('[ zooms out', await atRoot());
    await app.select('a'); await key(']');
    await page.waitForTimeout(200);
    check('] zooms into the selected task', (await state()).hash === '#/a');
    await key('[');
    await page.waitForTimeout(200);

    await page.keyboard.down(MOD);
    const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('#tree .text')).cursor);
    await page.keyboard.up(MOD);
    check(`holding ${MOD} shows a zoom-in pointer over tasks`, cursor === 'zoom-in', cursor);
    check('the key list mentions the click and the keys', (await page.textContent('#shortcut-list')).includes('Zoom into a task'));

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
    check('dragging by the bullet still moves the item, without zooming', (await app.file()).root.children[0].id === 'd' && (await atRoot()));
    check('no console errors (zoom)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
