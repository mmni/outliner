// Navigate mode: selection, rotation, search, editing, folding, mode indicators.
'use strict';

const { startApp, find } = require('./harness');

module.exports = async (check) => {
  const app = await startApp();
  const { page, key, type } = app;
  try {
    check('first row selected on load, nothing being edited', (await app.selected()) === 'a' && !(await app.editing()));

    await key('ArrowDown'); await key('ArrowDown'); await key('s'); await key('s');
    check('↓ ↓ s s rotates the third row none → idea → planned', find((await app.file()).root, 'b').status === 'planned');

    await app.select('c2');
    const start = find((await app.file()).root, 'c2').status;
    const cycle = [null, 'idea', 'planned', 'in-progress', 'review', 'testing', 'released'];
    await key('s');
    const one = find((await app.file()).root, 'c2').status;
    for (let i = 0; i < cycle.length - 1; i++) await key('s');
    const full = find((await app.file()).root, 'c2').status;
    check('s steps to the next status, and a full cycle comes back to the start', one === cycle[(cycle.indexOf(start) + 1) % cycle.length] && full === start, `${start} → ${one} → ${full}`);

    await key('/'); await type('import'); await key('Enter'); await key('p');
    let f = await app.file();
    check('/import Enter p: the search closes and p steps the match to the next person', find(f.root, 'b1').person === 'Sam');
    check('…and children that held the old person follow', find(f.root, 'b11').person === 'Sam');

    await key('/'); await type('multi');
    const revealed = await app.selected();
    await key('Enter');
    check('/multi reveals the folded parent and selects the hidden match', revealed === 'b131' && find((await app.file()).root, 'b13').collapsed === false);

    await key('g'); await key('Enter'); await type(' X'); await key('Escape'); await key('ArrowDown');
    check('Enter edits, Esc returns to navigate mode, ↓ moves on', find((await app.file()).root, 'a').text.endsWith(' X') && (await app.selected()) === 'a1' && !(await app.editing()));

    await key('g'); page.once('dialog', (d) => d.dismiss()); await key('x');
    check('x on a row with children asks first; cancel keeps it', !!find((await app.file()).root, 'a'));

    await key('ArrowDown');
    const before = find((await app.file()).root, 'a1').release;
    await key('r');
    const mid = find((await app.file()).root, 'a1').release;
    await key('u');
    const after = find((await app.file()).root, 'a1').release;
    check('u undoes an r rotation', mid !== before && after === before, `${before} → ${mid} → ${after}`);

    await page.click('#tree .item[data-id="c2"] > .row > .text'); await key('Escape');
    check('a click selects the row, and Esc keeps it selected', (await app.selected()) === 'c2');

    await key('o'); await type('new task'); await key('Escape');
    check('o adds an item below and edits it', find((await app.file()).root, 'c').children.map((x) => x.text).join('|').includes('Build cache|new task'));
    await key('Tab');
    check('Tab in navigate mode indents without entering editing', find((await app.file()).root, 'c2').children.some((x) => x.text === 'new task') && !(await app.editing()));

    await key('g'); await key('ArrowLeft');
    check('← collapses an expanded row', find((await app.file()).root, 'a').collapsed === true);
    await key('ArrowRight'); await key('ArrowRight');
    check('→ expands, then → again goes to the first child', find((await app.file()).root, 'a').collapsed === false && (await app.selected()) === 'a1');

    await key('v'); await page.waitForTimeout(200);
    check('v switches to the Releases view', (await page.getAttribute('#main', 'data-view')) === 'releases');
    await key('v'); await page.waitForTimeout(200);

    await key('?');
    check('? opens the key list', await page.isVisible('#help'));
    await key('Escape');
    check('Esc closes the key list', !(await page.isVisible('#help')));

    await key('/'); await type('zzzz');
    check('a search with no match says so', (await page.textContent('#keybar')).includes('no match'));
    await key('Escape');
    check('Esc cancels the search and clears the dimming', !(await page.evaluate(() => document.querySelector('#main').classList.contains('searching'))));

    // Only Enter starts editing; the label and ring follow the mode.
    const badge = () => page.textContent('#mode-badge');
    await page.click('#tree .item[data-id="b12"] > .row > .text');
    check('a click on task text selects it without editing', (await app.selected()) === 'b12' && !(await app.editing()) && (await badge()) === 'Navigate');
    await page.dblclick('#tree .item[data-id="b12"] > .row > .text');
    check('a double-click does not start editing either', !(await app.editing()));
    await key('Enter');
    const ring = await page.evaluate(() => getComputedStyle(document.querySelector('.item[data-id="b12"] > .row')).boxShadow);
    check('Enter edits: label says Edit and the row ring turns green', (await app.editing()) && (await badge()) === 'Edit' && ring.includes('26, 127, 55'), ring);
    await type('!');
    await page.click('#tree .item[data-id="b12"] > .row > .text', { position: { x: 3, y: 8 } });
    check('a click inside the row being edited keeps editing', await app.editing());
    await page.click('#tree .item[data-id="b14"] > .row > .text');
    check('a click on another row while editing saves, leaves editing and selects that row',
      find((await app.file()).root, 'b12').text.endsWith('!') && (await app.selected()) === 'b14' && !(await app.editing()) && (await badge()) === 'Navigate');

    // Level folding
    const levels = () => page.$$eval('#tree .item', (els) => els.map((e) => e.dataset.level));
    await app.select('b131');
    await key('1');
    const l1 = await levels();
    f = await app.file();
    check('1 shows only the top level', l1.length === f.root.children.length && l1.every((l) => l === '1'), `${l1.length} rows`);
    check('a selection folded away moves to its top-level ancestor', (await app.selected()) === 'b');
    await key('2');
    const l2 = await levels();
    f = await app.file();
    check('2 shows every level-2 task and nothing deeper', l2.length === f.root.children.reduce((n, c) => n + 1 + c.children.length, 0) && !l2.includes('3'));
    await key('0');
    f = await app.file();
    let anyCollapsed = false;
    (function walk(n) { for (const c of n.children) { if (c.children.length && c.collapsed) anyCollapsed = true; walk(c); } })(f.root);
    check('0 expands everything', !anyCollapsed);
    await key('u');
    check('u undoes the fold', !(await levels()).includes('3') && (await levels()).includes('2'));
    await key('Enter'); await type('42'); await key('Escape');
    check('digits type normally while editing', find((await app.file()).root, await app.selected()).text.endsWith('42'));

    check('no console errors (navigate)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
