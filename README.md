# Outliner

A personal, offline outliner in the style of Dynalist. Items nest freely and carry `#tags` and a
status: idea, planned, in-progress, under review, testing or released.

```bash
npm start            # http://localhost:4477
```

No dependencies and no build step. You need Node 18 or later.

## Run it permanently (macOS)

```bash
npm run service:install     # starts now, at every login, and restarts if it crashes
```

To give it its own window and Dock icon, open http://localhost:4477 in Safari and choose
**File → Add to Dock**. In Chrome, use **⋮ → Cast, save and share → Install page as app**.

Inside VS Code, ⌘⌥O opens it in a Simple Browser tab. That shortcut is a user keybinding
(`simpleBrowser.show` with `http://localhost:4477`) in
`~/Library/Application Support/Code/User/keybindings.json`, not part of this repo.

| Command | What it does |
|---|---|
| `npm run service:restart` | Restart the server, needed after editing `server.js` |
| `npm run service:log` | Follow the server log (`~/Library/Logs/outliner.log`) |
| `npm run service:uninstall` | Stop it and remove it from login. Data is kept |

Edits to `public/` still apply live while the service runs. Stop the service before using
`npm start`, because both use port 4477.

## Licence

MIT — see [LICENSE](LICENSE).

## Files

| File | What it holds |
|---|---|
| `server.js` | Serves `public/` and reads/writes the outline. This machine only unless `HOST` says otherwise |
| `public/styles.css` | All visuals. Tokens at the top: light in `:root`, dark in `:root[data-theme="dark"]` |
| `public/app.js` | Model, rendering, keyboard handling. `STATUSES` and `SHORTCUTS` are at the top |
| `data/outline.json` | Your outline (git-ignored). Written atomically, pretty-printed |
| `data/backups/` | The first version of each day, `outline-YYYY-MM-DD.json` |

While the server runs, saving a file in `public/` refreshes the open page. A CSS change is swapped
in place; any other change reloads the page after flushing unsaved edits.

Set `OUTLINER_DATA=/some/dir` to keep the data elsewhere, and `PORT` to change the port.

## On the network

By default the server answers only this machine. To use it from a phone or another computer on the
same network, set `HOST=0.0.0.0`: before `npm start`, or when installing the service
(`HOST=0.0.0.0 npm run service:install`). It is then at `http://<this-mac>.local:4477` or
`http://<its-ip>:4477`, and the server log lists the addresses it answers on.

⚠ There is no login. With `HOST=0.0.0.0`, anyone who can reach the port can read and overwrite the
outline. Only do this on a network you trust.

Several windows can be open at once. A save in one shows up in the others straight away, and a window
holding an older copy cannot overwrite newer work: its save is refused, and it reloads the latest
outline instead (its own unsaved change is dropped, and it says so).

On a phone (screens up to 700px wide) the pills move to a line under the task text, placeholders
for an unset person, release, status or link appear only on the row being edited, and the sidebar
is a slide-over that starts closed. The narrow-screen rules are at the end of `public/styles.css`.

## Using it

The outline opens in **navigate mode**: one row is selected (a ring around it) and single keys act
on it — ↑/↓ or j/k to move, `/` to search, `s` / `p` / `r` to step through status, person and
release, `1` / `2` … to fold the outline to that many levels and `0` to expand it all, Enter to edit
the text, Esc to stop editing. `?` shows every key. A click selects a row but
never edits it (on a phone a tap still does). The top bar shows **NAVIGATE** or **EDIT**, and the
row's ring is blue while navigating and green while editing.


- **Scratch pad:** `c` jots a note into a panel on the right, outside the plan. `` ` `` moves the
  selection between outline and pad. In the pad, `m` (or **→**, or a drag) moves a note into the
  outline under a task you pick, where it takes that task's person and release; `x` deletes. The
  top bar shows how many notes are waiting.
- Type `#word` anywhere in an item to tag it. Click a tag to filter by it.
- Give a task a **release** (⌥R or the release pill) and a **person** (⌥P or the person pill). Each
  item holds one of each. Both copy down: a new or moved child takes its parent's values when empty, and
  changing a parent carries every descendant that is empty or still holds the parent's old value. A
  child set to something different keeps it.
  The picker highlights the first match, ↑/↓ move the highlight, and **Create "…"** adds a new value.
- **Outline / Releases** in the top bar switches views. Releases groups each tagged task with its
  subtree under its release, sorted by date, with a progress bar. It has its own folds (arrow, ←/→,
  Space, `1`…`9`/`0`), so folding there and in the Outline never affect each other. Enter on a task there opens it in the
  Outline. A child with a different release appears under that release instead.
- **Ticket link:** paste a Jira URL into a task to attach it. It shows as a chip with the ticket key
  right after the text; click it to open the ticket. ⌥J or right-click the chip edits or removes it,
  and once one Jira link exists a bare key like `PROJ-123` is enough. One link per task.
- Click the status pill (shown on hover) or press ⌥1–6 to set a status, and ⌥0 to clear it.
- **Zoom into a task:** ⌘-click its text or bullet (Ctrl-click off a Mac), or `]` on the selected row.
  A plain click never zooms. The breadcrumb, browser Back or `[` zoom out. Holding ⌘ shows a zoom-in
  pointer. `ZOOM_ENABLED` at the top of `public/app.js` switches zooming off entirely.
- Drag a bullet to move an item with its children. Dropping on the top third of a row puts it above, the bottom third below, and the middle makes it the row's first child. Esc cancels.
- The filter box combines words, `#tags`, `status:<id>`, `release:<name>`, `person:<name>` and `link:<text>`
  (lower-case, `_` for spaces — e.g. `#backend person:alex`). `none` matches an unset value; `link:any` finds tasks with a link.
  It keeps matching items' parents visible for context. Clicking entries in the sidebar adds them to
  the filter, and clicking again removes them: different groups must all match (a release **and** a
  person **and** a status), while values within one group are alternatives (Idea **or** Planned; the
  same for tags).
- The panel button (top left) or ⌘\ hides and shows the sidebar; the choice is remembered.
- The sun/moon button (top right) flips light/dark. It follows the system setting until you flip it once.
- Pasting several lines creates one item per line and strips leading `-`, `*` and `1.` markers.

The sidebar lists every keyboard shortcut.

## Tests

```bash
npm install          # once: installs playwright-core (dev only; the app itself has no dependencies)
npm test             # all suites; or name some: node tests/run.js scratch navigate
npm run test:invert  # every assertion flipped: passes only if every check fails
```

The tests drive the real server and page in headless Google Chrome (it must be installed). Each run
uses a temporary data folder and a free local port, so your own outline is never touched. Test data
is in `tests/fixture.json`.

## Data shape

```json
{ "version": 1,
  "root": { "id": "root", "text": "", "status": null, "collapsed": false,
            "children": [ { "id": "…", "text": "Task #tag", "status": "planned",
                            "person": "Alex", "release": "v2026.10.23",
                            "link": "https://…/browse/PROJ-123",
                            "collapsed": false, "children": [] } ] },
  "scratch": [ { "id": "…", "text": "a quick note", "created": "2026-10-12T14:00:00.000Z" } ] }
```

Tags aren't stored separately. They're parsed from `text`.
