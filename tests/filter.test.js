// Sidebar filters: several can be picked; groups combine with AND, values within a group with OR.
'use strict';

const { startApp, fixture } = require('./harness');

module.exports = async (check) => {
  const data = fixture();
  const tag = (id, t) => { (function walk(n) { for (const c of n.children) { if (c.id === id) c.text += ` ${t}`; walk(c); } })(data.root); };
  tag('a1', '#ios'); tag('c1', '#ios'); tag('b12', '#backend');
  const app = await startApp(data);
  const { page } = app;
  const facet = (sel) => page.click(`#sidebar button[data-query="${sel}"]`);
  const hits = () => page.$$eval('#tree .item:not(.context-only)', (els) => els.map((e) => e.dataset.id).sort().join(','));
  const active = () => page.$$eval('#sidebar button.active', (els) => els.map((e) => e.dataset.query).sort().join(','));
  try {
    await facet('person:sam'); await facet('release:v2099.03.06'); await facet('status:planned');
    check('three filters from three groups can be picked together', (await page.inputValue('#search')) === 'person:sam release:v2099.03.06 status:planned');
    check('…all three stay highlighted', (await active()) === 'person:sam,release:v2099.03.06,status:planned', await active());
    check('…and only tasks matching all three show', (await hits()) === 'a1', await hits());

    await facet('person:sam');
    check('clicking a picked filter again removes only that one', (await page.inputValue('#search')) === 'release:v2099.03.06 status:planned');

    await page.fill('#search', ''); await page.dispatchEvent('#search', 'input');
    await facet('status:idea'); await facet('status:planned');
    check('two statuses show tasks with either', (await hits()) === 'a,a1,b14,b2,d1', await hits());

    await page.fill('#search', ''); await page.dispatchEvent('#search', 'input');
    await facet('person:riley'); await facet('release:v2099.03.06');
    check('a person and a release that never meet show nothing', (await hits()) === '', await hits());

    await page.fill('#search', ''); await page.dispatchEvent('#search', 'input');
    await facet('#ios'); await facet('#backend');
    check('two tags show tasks with either', (await hits()) === 'a1,b12,c1', await hits());

    await page.click('#tree .item[data-id="a"] > .row > .text');
    await app.key('Escape');
    check('Esc clears every filter', (await page.inputValue('#search')) === '' && (await active()) === '');
    check('no console errors (filter)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
