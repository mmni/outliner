// The Releases view: its own folds, and level styling that matches the outline.
'use strict';

const { startApp } = require('./harness');

const it = (id, text, kids = [], o = {}) => ({
  id, text, status: o.status ?? null, person: o.person ?? null, release: o.release ?? null, link: null, collapsed: !!o.collapsed, children: kids,
});

module.exports = async (check) => {
  const steps = [1, 2, 3, 4, 5].map((n) => it(`fd${n}`, `deploy step ${n}`, [], { person: 'Alex', release: 'v2099.01.01' }));
  const data = { version: 2, root: it('root', '', [
    it('svc', 'Platform Service', [
      it('fd', 'First Deployment', steps, { person: 'Alex', release: 'v2099.01.01', status: 'in-progress', collapsed: true }),
      it('ex', 'Expansion', [it('ex1', 'expansion step', [], { release: 'v2099.02.02' })], { release: 'v2099.02.02' }),
    ]),
  ]) };
  const app = await startApp(data);
  const { page, key } = app;
  const level = (root, id) => page.evaluate(([r, i]) => document.querySelector(`${r} .item[data-id="${i}"]`)?.dataset.level, [root, id]);
  const relRows = () => app.rows('#releases');
  try {
    const outlineFd = await level('#tree', 'fd');
    await key('v'); await page.waitForTimeout(200);
    check('a task has the same level in both views', outlineFd === '2' && (await level('#releases', 'fd')) === '2');
    check('its subtasks are level 3 in the Releases view', (await level('#releases', 'fd1')) === '3');
    check('a task folded in the Outline is open in the Releases view', (await relRows()).includes('fd3'));

    const dataFile = `${app.url}api/outline`;
    const before = await (await fetch(dataFile)).text();
    await page.click('#releases .item[data-id="fd"] > .row > .toggle', { force: true });
    await page.waitForTimeout(200);
    check('the fold arrow works in the Releases view', !(await relRows()).includes('fd3'));
    await page.waitForTimeout(600);
    check('folding in the Releases view does not change the outline file', (await (await fetch(dataFile)).text()) === before);
    await page.reload(); await page.waitForSelector('#releases .item');
    check('a Releases-view fold survives a reload', !(await relRows()).includes('fd3'));

    await app.select('fd');
    await key('ArrowRight');
    check('→ unfolds in the Releases view', (await relRows()).includes('fd3'));
    await key('ArrowLeft');
    check('← folds in the Releases view', !(await relRows()).includes('fd3'));
    await key(' ');
    check('Space toggles in the Releases view', (await relRows()).includes('fd3'));
    await key('j');
    const child = await app.selected();
    await key('1');
    check('1 shows only the tasks listed under each release', !(await relRows()).some((x) => /^fd\d/.test(x)) && (await relRows()).includes('ex'));
    check('…and a selected subtask hands the selection to its visible parent', child === 'fd1' && (await app.selected()) === 'fd');
    await key('0');
    check('0 expands everything in the Releases view', (await relRows()).includes('fd5') && (await relRows()).includes('ex1'));

    await key('v'); await page.waitForTimeout(200);
    check('the outline still has the task folded', !(await app.rows()).includes('fd3'));
    check('no console errors (releases)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
