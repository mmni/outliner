// The scratch pad: capture, edit, delete, undo, and moving notes into the outline.
'use strict';

const { startApp, find } = require('./harness');

module.exports = async (check) => {
  const app = await startApp();
  const { page, key, type } = app;
  const open = () => page.evaluate(() => document.documentElement.dataset.scratch === 'open');
  const pane = () => page.evaluate(() => document.body.dataset.pane);
  const noteSel = () => page.evaluate(() => document.querySelector('#scratch .row.selected')?.parentElement.dataset.id);
  const notes = async () => ((await app.file()).scratch || []).map((n) => n.text);
  try {
    check('scratch pad starts closed with a count of 0', !(await open()) && (await page.textContent('#scratch-toggle .n')) === '0');
    const outlineBefore = JSON.stringify((await app.file()).root);

    await key('c');
    check('c opens the pad with the cursor in the capture box', (await open()) && (await page.evaluate(() => document.activeElement.id)) === 'scratch-input');
    await type('note one'); await key('Enter'); await type('note two #idea'); await key('Enter');
    check('Enter keeps the box open for the next note', (await page.evaluate(() => document.activeElement.id)) === 'scratch-input');
    await key('Enter');
    check('Enter on an empty box closes the pad and returns to the outline', !(await open()) && (await pane()) === 'outline' && (await page.textContent('#mode-badge')) === 'Navigate');
    let f = await app.file();
    check('notes are saved newest first with a date, outline untouched', f.scratch.map((n) => n.text).join('|') === 'note two #idea|note one' && !!f.scratch[0].created && JSON.stringify(f.root) === outlineBefore);
    check('the top bar count shows 2', (await page.textContent('#scratch-toggle .n')) === '2');

    await key('`');
    check('` opens the pad and moves the selection there', (await open()) && (await pane()) === 'scratch' && !!(await noteSel()));
    await key('j');
    const second = await noteSel();
    await key('Enter'); await type(' edited'); await key('Enter');
    check('Enter edits a note; Enter again saves it', (await notes()).includes('note one edited') && (await page.textContent('#mode-badge')) === 'Navigate');
    check('the selection stayed on the edited note', (await noteSel()) === second);

    await key('s');
    check('s in the scratch pad does not touch the outline', JSON.stringify((await app.file()).root) === outlineBefore);

    await key('x');
    check('x deletes the note', (await notes()).length === 1);
    await key('u');
    check('u restores it', (await notes()).length === 2);

    await key('g'); await key('j');
    await key('m');
    check('m opens the move menu', await page.isVisible('#move-menu'));
    await type('import'); await key('Enter');
    f = await app.file();
    const moved = find(f.root, 'b1').children.at(-1);
    check('m + Enter moves the note to the end of the chosen task', moved.text === 'note one edited' && f.scratch.length === 1);
    check("the moved note takes the task's person and release", moved.person === 'Riley' && moved.release === 'v2099.02.20');
    await key('u');
    f = await app.file();
    check('u undoes the move in one step', f.scratch.length === 2 && !find(f.root, 'b1').children.some((c) => c.text === 'note one edited'));

    await key('Escape');
    check('Esc hands the selection back to the outline', (await pane()) === 'outline');
    await key('`');

    const src = await page.locator('#scratch .note >> nth=0 >> .bullet').boundingBox();
    const dst = await page.locator('#tree .item[data-id="c"] > .row').boundingBox();
    await page.mouse.move(src.x + 4, src.y + 4); await page.mouse.down();
    await page.mouse.move(dst.x + 150, dst.y + dst.height / 2, { steps: 10 }); await page.mouse.up();
    f = await app.file();
    check("dragging a note onto a task makes it that task's first child", find(f.root, 'c').children[0].text === 'note two #idea' && f.scratch.length === 1);

    await page.hover('#scratch .note >> nth=0 >> .row');
    await page.click('#scratch .note >> nth=0 >> .note-delete');
    check('the × button deletes', (await app.file()).scratch.length === 0);
    check('the empty pad says how to add a note', (await page.textContent('#scratch-list')).includes('Press c'));

    await key('c'); await type('temp'); await key('Enter'); await key('Escape');
    check('after capturing, the selection is back in the scratch pad where it was', (await pane()) === 'scratch');
    await key('g'); await key('Enter');
    await key('Meta+a'); await key('Backspace'); await key('Enter');
    check("clearing a note's text deletes it", (await app.file()).scratch.length === 0);

    await key('Escape'); await key('?');
    check('the key list has a Scratch pad group', (await page.textContent('#help')).includes('Scratch pad'));
    await key('Escape');
    check('no console errors (scratch)', app.errors.length === 0, app.errors.join('; '));
  } finally {
    await app.close();
  }
};
