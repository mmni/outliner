// Two windows on one outline: live updates, and no silent overwrite by a stale window.
'use strict';

const { startApp, find } = require('./harness');

const status = (page, id) => page.evaluate((i) => document.querySelector(`#tree .item[data-id="${i}"]`)?.dataset.status ?? null, id);

module.exports = async (check) => {
  const app = await startApp();
  const { page: a } = app;
  try {
    // Live: window B picks up A's save without reloading.
    const b = await app.openAnother();
    await app.select('b'); await app.key('s');
    await b.waitForTimeout(1200);
    check('a save in one window shows up in another window by itself', (await status(b, 'b')) === 'idea');
    check('…with a short notice', (await b.textContent('#keybar')).includes('Updated from another window'));
    check("the saving window does not treat its own save as someone else's", !(await a.isVisible('#keybar')) || !(await a.textContent('#keybar')).includes('another window'));
    await app.key('u');
    check('…so its undo still works', find((await app.file()).root, 'b').status === null);
    await b.close();

    // Stale: window C never hears about A's saves, then saves on top of them.
    const c = await app.openAnother({ offline: true });
    await app.select('a'); await app.key('s');           // A: Mobile App idea → planned
    const afterA = find((await app.file()).root, 'a').status;
    await c.keyboard.press('G'); await c.keyboard.press('s');   // C: last row, from its stale copy
    await c.waitForTimeout(1200);
    const f = await app.file();
    check("the stale window's save is refused, so the other window's change survives", find(f.root, 'a').status === afterA && afterA === 'planned');
    check("…and the refused change is not in the file", find(f.root, 'd2').status === null);
    check('the stale window reloads the saved outline and says why', (await status(c, 'a')) === 'planned' && (await c.textContent('#keybar')).includes('Changed in another window'));
    await c.keyboard.press('s');
    await c.waitForTimeout(800);
    const g = await app.file();
    check('after reloading, the stale window saves normally again', find(g.root, 'd2').status === 'idea' && find(g.root, 'a').status === 'planned');
    await c.close();

    // Server: a save based on an old version is refused.
    const res = await fetch(`${app.url}api/outline`, { method: 'PUT', headers: { 'If-Match': 'old', 'Content-Type': 'application/json' }, body: JSON.stringify(await app.file()) });
    check('the server answers 409 to a save based on an old version', res.status === 409);
    check('no console errors (sync)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
