// Person and release copy down to children; version-1 files are filled in once on load.
'use strict';

const { startApp, find } = require('./harness');

const it = (id, text, kids = [], o = {}) => ({
  id, text, status: null, person: o.person ?? null, release: o.release ?? null, link: null, collapsed: !!o.collapsed, children: kids,
});

module.exports = async (check) => {
  // P has values and is folded; c2 has its own person; g1 sits under c2.
  const v1 = { version: 1, root: it('root', '', [
    it('P', 'Parent task', [it('c1', 'child one'), it('c2', 'child two', [it('g1', 'grandchild')], { person: 'Riley' })], { person: 'Alex', release: 'v2099.01.01', collapsed: true }),
    it('Q', 'Other topic', [it('q1', 'q child')]),
  ]) };
  const app = await startApp(v1);
  const { page, key, type } = app;
  const pick = async (combo, value) => {
    await key(combo);
    await page.waitForSelector('#field-menu:not([hidden]) input');
    await type(value);
    await key('ArrowUp'); // wraps to the "Create" row
    await key('Enter');
  };
  try {
    let d = await app.file();
    let r = d.root;
    check('version-1 outline migrated to version 2', d.version === 2);
    check('empty children take the parent person and release', find(r, 'c1').person === 'Alex' && find(r, 'c1').release === 'v2099.01.01');
    check('a child with its own person keeps it', find(r, 'c2').person === 'Riley');
    check('a grandchild follows its nearest ancestor with a value', find(r, 'g1').person === 'Riley' && find(r, 'g1').release === 'v2099.01.01');
    check('an untouched topic stays empty', find(r, 'q1').person === null && find(r, 'q1').release === null);

    await key('v'); await page.waitForTimeout(200);
    const rel = await app.rows('.release-group[data-group="v2099.01.01"]');
    check('Releases view shows the parent folded in the outline with its whole breakdown', ['P', 'c1', 'c2', 'g1'].every((x) => rel.includes(x)), rel.join(','));
    await page.click('#people-list button >> text=Alex');
    const alex = await page.$$eval('#releases .item:not(.context-only)', (els) => els.map((e) => e.dataset.id));
    check('filtering the Releases view by person includes the subtasks', alex.includes('P') && alex.includes('c1') && !alex.includes('c2'), alex.join(','));
    await key('Escape'); await key('v'); await page.waitForTimeout(200);

    await key('g'); await key('ArrowRight'); await key('ArrowRight');
    await key('o'); await type('new under P'); await key('Escape');
    r = (await app.file()).root;
    const added = find(r, 'P').children.find((c) => c.text === 'new under P');
    check('a new item under P inherits person and release', added && added.person === 'Alex' && added.release === 'v2099.01.01');

    await key('g'); await key('o'); await type('moved in'); await key('Escape');
    const emptyBefore = (await app.file()).root.children.find((c) => c.text === 'moved in')?.person === null;
    await key('Tab');
    r = (await app.file()).root;
    const moved = find(r, 'P').children.find((c) => c.text === 'moved in');
    check('an empty item indented under P takes its values', emptyBefore && moved?.person === 'Alex' && moved?.release === 'v2099.01.01');

    await key('g'); await pick('Alt+KeyP', 'Sam');
    r = (await app.file()).root;
    check('changing P to Sam carries the children that held Alex', find(r, 'P').person === 'Sam' && find(r, 'c1').person === 'Sam');
    check('…and leaves the child set to Riley, and its subtree, alone', find(r, 'c2').person === 'Riley' && find(r, 'g1').person === 'Riley');
    await key('u');
    r = (await app.file()).root;
    check('u undoes the parent change and everything it carried', find(r, 'P').person === 'Alex' && find(r, 'c1').person === 'Alex');

    await pick('Alt+KeyR', 'v2099.02.02');
    r = (await app.file()).root;
    check('a new release on P carries every descendant that held the old one', ['P', 'c1', 'c2', 'g1'].every((x) => find(r, x).release === 'v2099.02.02'));

    check('no console errors (copydown)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
