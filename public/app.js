'use strict';

/* ==========================================================================
   Config
   ========================================================================== */
const STATUSES = [
  { id: 'idea', label: 'Idea' },
  { id: 'planned', label: 'Planned' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'testing', label: 'Testing' },
  { id: 'released', label: 'Released' },
];
const SAVE_DELAY_MS = 400;
// Zooming into a task (bullet click, ] / [, zoomed URLs) is switched off; true brings it all back.
const ZOOM_ENABLED = false;
const MAX_STYLED_LEVEL = 4; // levels below this share the last level's style
const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-\/.]*[\p{L}\p{N}_])/gu;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

// Single-value fields picked from a list. An inherited field also applies to every descendant.
const FIELDS = {
  person: { label: 'Person', key: 'KeyP', inherited: false, list: '#people-list', empty: `Assign with ${ALT} P` },
  release: { label: 'Release', key: 'KeyR', inherited: true, list: '#release-list', empty: `Set one with ${ALT} R` },
};

// Keys when a row is selected but not being edited (navigate mode).
const NAV_SHORTCUTS = [
  ['↑ ↓ / j k', 'Select previous / next row'],
  ['← →', 'Collapse / expand, or go to parent / child'],
  ['g / G', 'First / last row'],
  ['Click', 'Select a row'],
  ['Enter', 'Edit the row'],
  ['o / O', 'New item below / above'],
  ['Tab / ⇧ Tab', 'Indent / outdent'],
  [`${MOD} ⇧ ↑/↓`, 'Move item'],
  ['Space', 'Collapse / expand'],
  ['1 / 2 … 9', 'Show only that many levels'],
  ['0', 'Expand everything'],
  ['s / S', 'Next / previous status'],
  ['p / P', 'Next / previous person'],
  ['r / R', 'Next / previous release'],
  [`${ALT} P / R / J`, 'Person, release or link picker'],
  ['l', 'Open the ticket link'],
  ...(ZOOM_ENABLED ? [['] / [', 'Zoom in / out']] : []),
  ['/', 'Search; Enter keeps, Esc cancels'],
  ['n / N', 'Next / previous search match'],
  ['f', 'Filter box'],
  ['v', 'Outline ⇄ Releases'],
  ['x', 'Delete'],
  ['u', 'Undo'],
  ['?', 'All keys'],
];

// Keys while editing a row's text.
// Keys while the scratch pad has the selection.
const SCRATCH_SHORTCUTS = [
  ['c', 'Capture a note (from anywhere)'],
  ['`', 'Switch between outline and scratch pad'],
  ['↑ ↓ / j k', 'Select a note'],
  ['Enter', 'Edit the note'],
  ['m', 'Move the note into the outline'],
  ['x', 'Delete the note'],
  ['Esc', 'Back to the outline'],
];

const EDIT_SHORTCUTS = [
  ['Esc', 'Stop editing, keep the row selected'],
  ['Enter', 'New item / split'],
  ['Tab / ⇧ Tab', 'Indent / outdent'],
  [`${MOD} ⇧ ↑/↓`, 'Move item'],
  ['Drag •', 'Move item with the mouse'],
  [`${MOD} ↑/↓`, 'Collapse / expand'],
  ...(ZOOM_ENABLED ? [[`${MOD} ] / [`, 'Zoom in / out']] : []),
  [`${ALT} 1–5 / 0`, 'Set / clear status'],
  [`${ALT} P / R / J`, 'Person, release or link picker'],
  [`${MOD} ⇧ ⌫`, 'Delete with children'],
  [`${MOD} \\`, 'Show / hide sidebar'],
];

/* ==========================================================================
   State
   ========================================================================== */
let doc = null;            // { version, root }
const index = new Map();   // id -> { node, parent }
let zoomId = 'root';
let view = 'outline';      // 'outline' | 'releases'
let lastOutlineHash = '#/';
let pendingFocus = null;   // item to focus after switching to the outline
let query = '';
let cursorId = null;       // the selected row (navigate mode)
let cursorHint = 0;        // its last position, used when the row disappears
let keepNav = false;       // true while a navigate-mode action commits, so nothing enters editing
let saveTimer = null;
let saveState = 'saved';

const $ = (sel) => document.querySelector(sel);
const els = {
  main: $('#main'),
  tree: $('#tree'),
  title: $('#title'),
  breadcrumb: $('#breadcrumb'),
  saveState: $('#save-state'),
  search: $('#search'),
  statusList: $('#status-list'),
  tagList: $('#tag-list'),
  shortcutList: $('#shortcut-list'),
  statusMenu: $('#status-menu'),
  fieldMenu: $('#field-menu'),
  linkMenu: $('#link-menu'),
  moveMenu: $('#move-menu'),
  scratch: $('#scratch'),
  scratchList: $('#scratch-list'),
  scratchInput: $('#scratch-input'),
  scratchToggle: $('#scratch-toggle'),
  addItem: $('#add-item'),
  releases: $('#releases'),
  viewSwitch: $('#view-switch'),
  keybar: $('#keybar'),
  help: $('#help'),
};

/* ==========================================================================
   Model helpers
   ========================================================================== */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function newItem(text = '') {
  return { id: uid(), text, status: null, person: null, release: null, link: null, collapsed: false, children: [] };
}

function reindex() {
  index.clear();
  (function walk(node, parent) {
    index.set(node.id, { node, parent });
    node.children.forEach((c) => walk(c, node));
  })(doc.root, null);
}

const nodeOf = (id) => index.get(id)?.node;
const parentOf = (id) => index.get(id)?.parent;
const positionOf = (id) => parentOf(id).children.findIndex((c) => c.id === id);

function ancestorsOf(id) {
  const out = [];
  for (let p = parentOf(id); p; p = parentOf(p.id)) out.unshift(p);
  return out;
}

function tagsOf(text) {
  return [...text.matchAll(TAG_RE)].map((m) => m[2].toLowerCase());
}

// Lower-case, underscores for spaces: how field values appear in filter tokens.
const norm = (s) => s.toLowerCase().replace(/\s+/g, '_');

function fieldValue(node, field) {
  if (!FIELDS[field].inherited) return node[field] || null;
  for (let n = node; n && n.id !== 'root'; n = parentOf(n.id)) if (n[field]) return n[field];
  return null;
}

// Person and release are copied down the tree so each task carries its own value (filters and the
// Releases view read the task itself). A task with a different value is left alone, with its subtree.
const PROPAGATED = ['person', 'release'];

// Fills empty person / release on a new or moved item, and its empty descendants, from its parent.
function inheritFields(node, parent) {
  for (const f of PROPAGATED) {
    let v = null;
    for (let p = parent; p && p.id !== 'root'; p = parentOf(p.id)) if (p[f]) { v = p[f]; break; }
    if (v) fillEmpty(node, f, v);
  }
}

function fillEmpty(node, field, value) {
  if (node[field]) return;
  node[field] = value;
  node.children.forEach((c) => fillEmpty(c, field, value));
}

// Sets a field and carries it down: descendants that are empty, or still hold the old value, follow.
function setPropagated(node, field, value) {
  const old = node[field] || null;
  node[field] = value;
  if (!PROPAGATED.includes(field)) return;
  (function walk(n) {
    for (const c of n.children) {
      if (!c[field] || (old && c[field] === old)) {
        c[field] = value;
        walk(c);
      }
    }
  })(node);
}

// One-time fill for outlines saved before values were copied down (version 1).
function migrateOutline() {
  if ((doc.version || 1) >= 2) return false;
  (function walk(node, inherited) {
    for (const c of node.children) {
      const next = {};
      for (const f of PROPAGATED) {
        if (!c[f] && inherited[f]) c[f] = inherited[f];
        next[f] = c[f] || null;
      }
      walk(c, next);
    }
  })(doc.root, {});
  doc.version = 2;
  return true;
}

function releaseDate(name) {
  const m = /^v?(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})$/i.exec(name);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function compareReleases(a, b) {
  const da = releaseDate(a);
  const db = releaseDate(b);
  if (da && db) return da - db;
  if (da || db) return da ? -1 : 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

function fieldValues(field) {
  const values = new Set();
  forEachNode((n) => { if (n[field]) values.add(n[field]); });
  return [...values].sort(field === 'release' ? compareReleases : (a, b) => a.localeCompare(b));
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function releaseDateLabel(name) {
  const d = releaseDate(name);
  if (!d) return '';
  const days = Math.round((d - startOfToday()) / 86400000);
  const rel = days === 0 ? 'today' : days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${rel}`;
}

function todayRelease() {
  const d = new Date();
  return `v${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

const LINK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10"/><path d="M9 2h5v5"/><path d="M14 2 7.5 8.5"/></svg>';

// The ticket key from a Jira URL (/browse/KEY or selectedIssue=KEY), else the host name.
function linkLabel(url) {
  const m = /(?:\/browse\/|selectedIssue=)([A-Z][A-Z0-9]+-\d+)/i.exec(url);
  if (m) return m[1].toUpperCase();
  try { return new URL(url).hostname; } catch { return url; }
}

// The "https://host/browse/" prefix of an existing link, so a bare ticket key can be typed.
function jiraBase() {
  let base = null;
  forEachNode((n) => {
    const m = n.link && /^(https?:\/\/[^/]+\/browse\/)/i.exec(n.link);
    if (m) base = m[1];
  });
  return base;
}

// Returns a URL, null to clear, or undefined when the input is not usable.
function resolveLink(raw) {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\/\S+$/i.test(v)) return v;
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(v) && jiraBase()) return jiraBase() + v.toUpperCase();
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return `https://${v}`;
  return undefined;
}

function countDescendants(node) {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

function forEachNode(fn) {
  (function walk(node) {
    node.children.forEach((c) => { fn(c); walk(c); });
  })(doc.root);
}

/* ==========================================================================
   Persistence
   ========================================================================== */
async function load() {
  const res = await fetch('/api/outline');
  doc = await res.json();
  if (!Array.isArray(doc.scratch)) doc.scratch = [];
  reindex();
  if (migrateOutline()) scheduleSave();
}

function scheduleSave() {
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  clearTimeout(saveTimer);
  setSaveState('saving');
  try {
    const res = await fetch('/api/outline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(await res.text());
    if (saveState === 'saving') setSaveState('saved');
  } catch (err) {
    console.error(err);
    setSaveState('error');
  }
}

function setSaveState(state) {
  saveState = state;
  const labels = { saved: 'Saved', pending: 'Editing…', saving: 'Saving…', error: 'Not saved — is the server running?' };
  els.saveState.textContent = labels[state];
  els.saveState.className = state;
}

window.addEventListener('beforeunload', (e) => {
  if (saveState !== 'saved') {
    save();
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ==========================================================================
   Filtering
   ========================================================================== */
function parseQuery(q) {
  const parsed = { words: [], tags: [], statuses: [], person: [], release: [], link: [] };
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const field = Object.keys(FIELDS).find((f) => tok.startsWith(`${f}:`));
    if (tok.startsWith('link:')) parsed.link.push(tok.slice(5));
    else if (tok.startsWith('#') && tok.length > 1) parsed.tags.push(tok.slice(1));
    else if (tok.startsWith('status:')) parsed.statuses.push(tok.slice(7));
    else if (field) parsed[field].push(tok.slice(field.length + 1));
    else parsed.words.push(tok);
  }
  return parsed;
}

function matches(node, q) {
  const text = node.text.toLowerCase();
  const tags = tagsOf(node.text);
  return q.words.every((w) => text.includes(w))
    && q.tags.every((t) => tags.includes(t))
    && (q.statuses.length === 0 || q.statuses.includes(node.status || 'none'))
    && Object.keys(FIELDS).every((f) => q[f].length === 0 || q[f].includes(norm(fieldValue(node, f) || 'none')))
    && q.link.every((t) => (t === 'none' ? !node.link : t === 'any' ? !!node.link : (node.link || '').toLowerCase().includes(t)));
}

// Returns { show: ids to render, hits: ids that match themselves }, or null when not filtering.
function computeFilter(scope = nodeOf(zoomId)) {
  if (!query.trim()) return null;
  const q = parseQuery(query);
  const show = new Set();
  const hits = new Set();
  (function walk(node) {
    let anyChild = false;
    for (const c of node.children) if (walk(c)) anyChild = true;
    const self = node !== scope && matches(node, q);
    if (self) hits.add(node.id);
    if (self || anyChild) { show.add(node.id); return true; }
    return false;
  })(scope);
  return { show, hits };
}

/* ==========================================================================
   Rendering
   ========================================================================== */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text) {
  return escapeHtml(text).replace(TAG_RE, (_m, pre, tag) => `${pre}<span class="tag" data-tag="${tag.toLowerCase()}">#${tag}</span>`);
}

function statusLabel(id) {
  return STATUSES.find((s) => s.id === id)?.label ?? '';
}

function fieldAttrs(node) {
  return Object.keys(FIELDS).map((f) => (node[f] ? ` data-${f}="${escapeHtml(node[f])}"` : '')).join('');
}

function rowHtml(node, editable) {
  const pills = Object.entries(FIELDS).map(([f, def]) =>
    `<button class="field" data-field="${f}" tabindex="-1" type="button">${node[f] ? escapeHtml(node[f]) : def.label.toLowerCase()}</button>`).join('');
  return `<div class="row">
      <button class="toggle" tabindex="-1" type="button">▼</button>
      ${editable
        ? (ZOOM_ENABLED
          ? `<a class="bullet" href="#/${node.id}" tabindex="-1" draggable="false" title="Click to zoom, drag to move"></a>`
          : '<span class="bullet" title="Drag to move"></span>')
        : '<span class="bullet" title="Open in the outline"></span>'}
      <div class="text"${editable ? ' contenteditable="plaintext-only" spellcheck="false"' : ''}>${highlight(node.text)}</div>
      <span class="meta">
      ${node.link
        ? `<a class="link set" href="${escapeHtml(node.link)}" target="_blank" rel="noopener" tabindex="-1" title="${escapeHtml(node.link)}\nClick to open · ${ALT} J or right-click to edit">${LINK_ICON}${escapeHtml(linkLabel(node.link))}</a>`
        : `<button class="link" tabindex="-1" type="button" title="Add a ticket link (${ALT} J, or paste a URL into the task)">${LINK_ICON}</button>`}
      <span class="row-fill"></span>
      ${pills}
      <button class="status" tabindex="-1" type="button">${node.status ? statusLabel(node.status) : 'status'}</button>
      </span>
    </div>`;
}

function itemOpenTag(node, { hasChildren, open, contextOnly, depth }) {
  const classes = ['item'];
  if (hasChildren) classes.push('has-children');
  if (!open) classes.push('collapsed');
  if (contextOnly) classes.push('context-only');
  const level = Math.min(depth, MAX_STYLED_LEVEL);
  return `<li class="${classes.join(' ')}" data-id="${node.id}" data-level="${level}"${node.status ? ` data-status="${node.status}"` : ''}${fieldAttrs(node)}>`;
}

function itemHtml(node, filter, depth = 1) {
  const kids = filter ? node.children.filter((c) => filter.show.has(c.id)) : node.children;
  const open = filter ? true : !node.collapsed;
  return `${itemOpenTag(node, { hasChildren: node.children.length > 0, open, contextOnly: filter && !filter.hits.has(node.id), depth })}
    ${rowHtml(node, true)}
    ${open && kids.length ? `<ul class="children">${kids.map((k) => itemHtml(k, filter, depth + 1)).join('')}</ul>` : ''}
  </li>`;
}

function render() {
  reindex();
  if (!index.has(zoomId)) zoomId = 'root';
  els.main.dataset.view = view;
  renderViewSwitch();
  renderSidebar();
  renderScratch();
  if (view === 'releases') {
    els.tree.innerHTML = '';
    renderReleases();
    paintCursor();
    return;
  }
  els.releases.innerHTML = '';

  const zoom = nodeOf(zoomId);
  const filter = computeFilter();

  els.tree.innerHTML = (filter ? zoom.children.filter((c) => filter.show.has(c.id)) : zoom.children)
    .map((c) => itemHtml(c, filter)).join('');

  const atRoot = zoomId === 'root';
  els.title.hidden = atRoot;
  els.main.classList.toggle('no-title', atRoot);
  if (!atRoot && document.activeElement !== els.title) els.title.textContent = zoom.text;

  renderBreadcrumb();
  paintCursor();
}

function renderViewSwitch() {
  for (const a of els.viewSwitch.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.view === view);
    if (a.dataset.view === 'outline') a.setAttribute('href', lastOutlineHash);
  }
}

function renderBreadcrumb() {
  if (zoomId === 'root') {
    els.breadcrumb.innerHTML = '';
    return;
  }
  const crumbs = ancestorsOf(zoomId).map((n) =>
    `<a href="#/${n.id === 'root' ? '' : n.id}">${n.id === 'root' ? 'Home' : escapeHtml(n.text || 'Untitled')}</a>`);
  els.breadcrumb.innerHTML = crumbs.join('<span class="sep">›</span>');
}

function renderSidebar() {
  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
  const tagCounts = new Map();
  forEachNode((n) => {
    if (n.status) statusCounts[n.status]++;
    for (const t of new Set(tagsOf(n.text))) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  });

  const q = parseQuery(query);
  els.statusList.innerHTML = STATUSES.map((s) => `
    <li><button type="button" data-query="status:${s.id}" class="${q.statuses.includes(s.id) ? 'active' : ''}">
      <span class="swatch" data-status="${s.id}"></span>${s.label}<span class="count">${statusCounts[s.id]}</span>
    </button></li>`).join('');

  for (const [f, def] of Object.entries(FIELDS)) {
    const counts = new Map();
    forEachNode((n) => { if (n[f]) counts.set(n[f], (counts.get(n[f]) || 0) + 1); });
    const values = fieldValues(f);
    $(def.list).innerHTML = values.length
      ? values.map((v) => `
        <li><button type="button" data-query="${f}:${escapeHtml(norm(v))}" class="${q[f].includes(norm(v)) ? 'active' : ''}">
          ${escapeHtml(v)}<span class="count">${counts.get(v)}</span>
        </button></li>`).join('')
      : `<li class="empty">${def.empty}</li>`;
  }

  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  els.tagList.innerHTML = tags.length
    ? tags.map(([t, n]) => `
      <li><button type="button" data-query="#${escapeHtml(t)}" class="${q.tags.includes(t) ? 'active' : ''}">
        #${escapeHtml(t)}<span class="count">${n}</span>
      </button></li>`).join('')
    : '<li class="empty">Type #tag in an item</li>';
}

function shortcutsHtml() {
  const group = (title, keys) => `<dt class="group">${title}</dt>${keys.map(([k, d]) => `<dt><kbd>${k}</kbd></dt><dd>${d}</dd>`).join('')}`;
  return group('Navigate', NAV_SHORTCUTS) + group('Scratch pad', SCRATCH_SHORTCUTS) + group('Editing', EDIT_SHORTCUTS);
}

function renderShortcuts() {
  els.shortcutList.innerHTML = shortcutsHtml();
}

/* ==========================================================================
   Caret helpers (offsets are in plain-text characters)
   ========================================================================== */
function getCaret(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function setCaret(el, offset) {
  const sel = getSelection();
  const r = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (remaining <= n.length) {
      r.setStart(n, remaining);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    remaining -= n.length;
  }
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function selectionCollapsed() {
  const sel = getSelection();
  return !sel.rangeCount || sel.getRangeAt(0).collapsed;
}

// True when the caret sits on the first (dir < 0) or last (dir > 0) visual line of el.
function caretOnEdgeLine(el, dir) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rect = r.getClientRects()[0];
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return dir < 0 ? rect.top - box.top < lineHeight * 0.75 : box.bottom - rect.bottom < lineHeight * 0.75;
}

function textEl(id) {
  return els.tree.querySelector(`.item[data-id="${id}"] > .row > .text`);
}

function focusItem(id, offset = 'end') {
  const el = textEl(id);
  if (!el) return;
  el.focus();
  setCaret(el, offset === 'end' ? el.textContent.length : offset);
}

function visibleIds() {
  return [...els.tree.querySelectorAll('.item')].map((li) => li.dataset.id);
}

function neighbourId(id, dir) {
  const ids = visibleIds();
  return ids[ids.indexOf(id) + dir];
}

/* ==========================================================================
   Mutations — each one re-renders, saves and restores focus via commit()
   ========================================================================== */
function commit(focusId, offset) {
  render();
  scheduleSave();
  if (focusId && !keepNav) focusItem(focusId, offset);
}

function insertAt(parent, position, item) {
  parent.children.splice(position, 0, item);
}

function removeNode(id) {
  const parent = parentOf(id);
  parent.children.splice(positionOf(id), 1);
}

function splitItem(id, offset) {
  const node = nodeOf(id);
  const parent = parentOf(id);
  const pos = positionOf(id);

  // Enter at the very start of a non-empty item opens a blank item above it.
  if (offset === 0 && node.text.length > 0) {
    const blank = newItem();
    inheritFields(blank, parent);
    insertAt(parent, pos, blank);
    commit(id, 0);
    return;
  }

  const item = newItem(node.text.slice(offset));
  node.text = node.text.slice(0, offset);
  // Enter at the end of an expanded parent adds its first child, like Dynalist.
  const intoNode = node.children.length && !node.collapsed && item.text === '';
  inheritFields(item, intoNode ? node : parent);
  if (intoNode) insertAt(node, 0, item);
  else insertAt(parent, pos + 1, item);
  commit(item.id, 0);
}

function indent(id, offset) {
  const parent = parentOf(id);
  const pos = positionOf(id);
  if (pos === 0) return;
  const target = parent.children[pos - 1];
  const node = nodeOf(id);
  removeNode(id);
  target.children.push(node);
  inheritFields(node, target);
  target.collapsed = false;
  commit(id, offset);
}

function outdent(id, offset) {
  const parent = parentOf(id);
  if (parent.id === zoomId) return;
  const grand = parentOf(parent.id);
  const node = nodeOf(id);
  removeNode(id);
  insertAt(grand, grand.children.indexOf(parent) + 1, node);
  inheritFields(node, grand);
  commit(id, offset);
}

function moveItem(id, dir, offset) {
  const parent = parentOf(id);
  const pos = positionOf(id);
  const to = pos + dir;
  if (to < 0 || to >= parent.children.length) return;
  const [node] = parent.children.splice(pos, 1);
  parent.children.splice(to, 0, node);
  commit(id, offset);
}

function isAncestor(ancestorId, id) {
  for (let p = parentOf(id); p; p = parentOf(p.id)) if (p.id === ancestorId) return true;
  return false;
}

// where: 'before' / 'after' the target as a sibling, or 'inside' as its first child.
function moveRelative(id, targetId, where) {
  if (id === targetId || isAncestor(id, targetId)) return;
  const node = nodeOf(id);
  removeNode(id);
  const target = nodeOf(targetId);
  if (where === 'inside') {
    insertAt(target, 0, node);
    inheritFields(node, target);
    target.collapsed = false;
  } else {
    insertAt(parentOf(targetId), positionOf(targetId) + (where === 'after' ? 1 : 0), node);
    inheritFields(node, parentOf(targetId));
  }
  commit();
}

function setCollapsed(id, collapsed) {
  const node = nodeOf(id);
  if (!node.children.length || node.collapsed === collapsed) return;
  node.collapsed = collapsed;
  commit(id, getCaret(textEl(id)) ?? 'end');
}

function setStatus(id, status) {
  const node = nodeOf(id);
  node.status = status;
  const el = textEl(id);
  const offset = el && document.activeElement === el ? getCaret(el) : null;
  commit(offset == null ? null : id, offset);
}

function deleteItem(id) {
  const node = nodeOf(id);
  const n = countDescendants(node);
  if (n > 0 && !confirm(`Delete this item and its ${n} sub-item${n === 1 ? '' : 's'}?`)) return;
  const prev = neighbourId(id, -1);
  const next = neighbourId(id, +1);
  removeNode(id);
  commit(prev ?? next, 'end');
}

// Backspace at the start of an item: delete it if empty, otherwise merge it into the item above.
function backspaceAtStart(id) {
  const node = nodeOf(id);
  if (node.children.length) return false;
  const prev = neighbourId(id, -1);
  if (node.text === '') {
    removeNode(id);
    commit(prev ?? neighbourId(id, +1), 'end');
    return true;
  }
  if (!prev) return false;
  const target = nodeOf(prev);
  const join = target.text.length;
  target.text += node.text;
  removeNode(id);
  commit(prev, join);
  return true;
}

function addChildToZoom(atStart = false) {
  const zoom = nodeOf(zoomId);
  const item = newItem();
  inheritFields(item, zoom);
  insertAt(zoom, atStart ? 0 : zoom.children.length, item);
  if (query) setQuery('');
  commit(item.id, 0);
}

function pasteLines(id, offset, lines) {
  const node = nodeOf(id);
  const parent = parentOf(id);
  const tail = node.text.slice(offset);
  node.text = node.text.slice(0, offset) + lines[0];
  let pos = positionOf(id);
  let last = node;
  for (const line of lines.slice(1)) {
    last = newItem(line);
    inheritFields(last, parent);
    insertAt(parent, ++pos, last);
  }
  // The text after the caret moves to the end of the last pasted line.
  const caret = last.text.length;
  last.text += tail;
  commit(last.id, caret);
}

/* ==========================================================================
   Mouse drag to reorder — the bullet is the handle; a plain click still zooms
   ========================================================================== */
const DRAG_START_PX = 4;    // movement before a press on the bullet becomes a drag
const DROP_EDGE = 0.3;      // top/bottom share of a row that means before/after; the rest means inside
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_STEP = 14;

let drag = null;            // { id, x, y, active, target: { id, where } | null }
let suppressClick = false;
const dropIndicator = $('#drop-indicator');

function cssPx(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

function findDropTarget(x, y) {
  const row = document.elementFromPoint(x, y)?.closest('#tree .row');
  if (!row) {
    // Below the last row: drop after the last top-level item of this view.
    const rows = els.tree.querySelectorAll(':scope > .item');
    const last = rows[rows.length - 1];
    if (last && y > last.getBoundingClientRect().bottom && last.dataset.id !== drag.id) {
      return { id: last.dataset.id, where: 'after', row: last.querySelector(':scope > .row') };
    }
    return undefined; // in a gap between rows: keep the previous target
  }
  const li = row.parentElement;
  const id = li.dataset.id;
  if (id === drag.id || isAncestor(drag.id, id)) return null;
  const r = row.getBoundingClientRect();
  const f = (y - r.top) / r.height;
  const childrenShown = li.querySelector(':scope > .children') !== null;
  let where = 'inside';
  if (f < DROP_EDGE) where = 'before';
  else if (f > 1 - DROP_EDGE && !childrenShown) where = 'after';
  return { id, where, row };
}

function showDropTarget(t) {
  els.tree.querySelectorAll('.row.drop-inside').forEach((r) => r.classList.remove('drop-inside'));
  if (!t) {
    dropIndicator.hidden = true;
    return;
  }
  const r = t.row.getBoundingClientRect();
  const bullet = t.row.querySelector('.bullet').getBoundingClientRect();
  const left = t.where === 'inside' ? bullet.left + cssPx('--indent') : bullet.left;
  dropIndicator.style.top = `${(t.where === 'before' ? r.top : r.bottom) - cssPx('--drop-line') / 2}px`;
  dropIndicator.style.left = `${left}px`;
  dropIndicator.style.width = `${r.right - left}px`;
  dropIndicator.hidden = false;
  if (t.where === 'inside') t.row.classList.add('drop-inside');
}

function startDrag() {
  drag.active = true;
  document.body.classList.add('dragging');
  (drag.note ? els.scratchList : els.tree).querySelector(`[data-id="${drag.id}"]`)?.classList.add('drag-source');
  closeStatusMenu();
}

function endDrag() {
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drag-source').forEach((el) => el.classList.remove('drag-source'));
  showDropTarget(null);
  drag = null;
}

els.tree.addEventListener('pointerdown', (e) => {
  const bullet = e.target.closest('.bullet');
  if (!bullet || e.button !== 0) return;
  drag = { id: bullet.closest('.item').dataset.id, x: e.clientX, y: e.clientY, active: false, target: null };
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START_PX) return;
    startDrag();
  }
  e.preventDefault();
  const t = findDropTarget(e.clientX, e.clientY);
  if (t !== undefined) {
    drag.target = t;
    showDropTarget(t);
  }
  const m = els.main.getBoundingClientRect();
  if (e.clientY < m.top + AUTOSCROLL_EDGE) els.main.scrollTop -= AUTOSCROLL_STEP;
  else if (e.clientY > m.bottom - AUTOSCROLL_EDGE) els.main.scrollTop += AUTOSCROLL_STEP;
});

document.addEventListener('pointerup', () => {
  if (!drag) return;
  const { active, id, target, note } = drag;
  endDrag();
  if (!active) return;
  // The click that follows this pointerup must not zoom into the dragged bullet.
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  if (target && note) moveNote(id, target.id, target.where);
  else if (target) moveRelative(id, target.id, target.where);
});

document.addEventListener('pointercancel', () => drag && endDrag());

document.addEventListener('click', (e) => {
  if (suppressClick) { e.preventDefault(); e.stopPropagation(); }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag?.active) { e.preventDefault(); endDrag(); }
}, true);

/* ==========================================================================
   Zoom (hash routing: #/<id>)
   ========================================================================== */
function zoomTo(id) {
  if (!ZOOM_ENABLED) return;
  location.hash = id && id !== 'root' ? `#/${id}` : '#/';
}

function applyHash() {
  const path = location.hash.replace(/^#\/?/, '');
  if (path === 'releases') {
    view = 'releases';
  } else {
    view = 'outline';
    zoomId = ZOOM_ENABLED && index.has(path) ? path : 'root';
    lastOutlineHash = zoomId === 'root' ? '#/' : `#/${zoomId}`;
  }
  closeStatusMenu();
  closeFieldMenu();
  closeLinkMenu();
  render();
  els.main.scrollTop = 0;
  rowEl(cursorId)?.scrollIntoView({ block: 'nearest' });
  if (pendingFocus && view === 'outline') {
    const id = pendingFocus;
    pendingFocus = null;
    focusItem(id, 'end');
    const row = textEl(id)?.closest('.row');
    row?.scrollIntoView({ block: 'center' });
    row?.classList.add('flash');
  }
}

// Shows an item in the Outline view, zoomed to its parent, with the cursor in it.
function openInOutline(id) {
  pendingFocus = id;
  query = '';
  els.search.value = '';
  const parent = parentOf(id);
  if (!ZOOM_ENABLED) {
    // Without zoom the task is shown in the full outline, so its folded parents open.
    for (const a of ancestorsOf(id)) if (a.id !== 'root' && a.collapsed) { a.collapsed = false; scheduleSave(); }
  }
  const hash = parent.id === 'root' || !ZOOM_ENABLED ? '#/' : `#/${parent.id}`;
  if (location.hash === hash) applyHash(); else location.hash = hash;
}

/* ==========================================================================
   Releases view — tasks grouped by release, each with its subtree
   ========================================================================== */
const COLLAPSED_GROUPS_KEY = 'outliner.collapsedReleaseGroups';
const NO_RELEASE = '__none__';
let collapsedGroups = new Set();
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)) || []); } catch { /* start expanded */ }

// A group root is an item whose own release differs from what it inherits. Items with no
// release anywhere above them are grouped under "No release" by their top-level item.
function releaseGroups() {
  const groups = new Map();
  const unplanned = [];
  (function walk(node, inherited) {
    for (const c of node.children) {
      const own = c.release || null;
      if (own && own !== inherited) {
        if (!groups.has(own)) groups.set(own, []);
        groups.get(own).push(c);
      } else if (!own && !inherited && node.id === 'root') {
        unplanned.push(c);
      }
      walk(c, own || inherited);
    }
  })(doc.root, null);
  const sorted = [...groups].sort((a, b) => compareReleases(a[0], b[0]));
  return [...sorted, [null, unplanned]];
}

// Children that carry a different release belong to that release's group instead.
function groupChildren(node, release) {
  return node.children.filter((c) => !(c.release && c.release !== release));
}

function groupStats(roots, release) {
  const stats = { total: 0, none: 0 };
  for (const s of STATUSES) stats[s.id] = 0;
  (function walk(nodes) {
    for (const n of nodes) {
      stats.total++;
      stats[n.status || 'none']++;
      walk(groupChildren(n, release));
    }
  })(roots);
  return stats;
}

// With a filter, an item shows when it or a descendant inside the same group matches.
function groupVisible(roots, release, filter) {
  const show = new Set();
  (function walk(nodes) {
    let any = false;
    for (const n of nodes) {
      const inside = walk(groupChildren(n, release));
      if (inside || filter.hits.has(n.id)) { show.add(n.id); any = true; }
    }
    return any;
  })(roots);
  return { show, hits: filter.hits };
}

// The Releases view keeps its own folds (per browser), so folding there never touches the outline.
const RELEASE_FOLDS_KEY = 'outliner.releaseFolds';
let releaseFolds = new Set();
try { releaseFolds = new Set(JSON.parse(localStorage.getItem(RELEASE_FOLDS_KEY)) || []); } catch { /* start expanded */ }

function setReleaseFold(id, folded) {
  if (folded) releaseFolds.add(id); else releaseFolds.delete(id);
  try { localStorage.setItem(RELEASE_FOLDS_KEY, JSON.stringify([...releaseFolds])); } catch { /* session only */ }
}

// Depth in the whole outline (top-level = 1), so a task is styled the same in both views.
function outlineDepth(id) {
  return ancestorsOf(id).length;
}

// `isRoot` marks a task listed directly under its release; it shows its outline path above it.
function releaseItemHtml(node, release, filter, isRoot = true) {
  const depth = outlineDepth(node.id);
  const kids = groupChildren(node, release).filter((c) => !filter || filter.show.has(c.id));
  const open = filter ? true : !releaseFolds.has(node.id);
  const ancestors = isRoot ? ancestorsOf(node.id).filter((a) => a.id !== 'root') : [];
  const context = ancestors.map((a) => a.text || 'Untitled').join(' › ');
  return `${itemOpenTag(node, { hasChildren: kids.length > 0, open, contextOnly: filter && !filter.hits.has(node.id), depth })}
    ${context ? `<div class="context">${escapeHtml(context)}</div>` : ''}
    ${rowHtml(node, false)}
    ${open && kids.length ? `<ul class="children">${kids.map((k) => releaseItemHtml(k, release, filter, false)).join('')}</ul>` : ''}
  </li>`;
}

function renderReleases() {
  const filter = computeFilter(doc.root);
  const groups = releaseGroups();
  const today = startOfToday();
  const html = [];

  for (const [release, roots] of groups) {
    const groupFilter = filter && groupVisible(roots, release, filter);
    const shown = groupFilter ? roots.filter((r) => groupFilter.show.has(r.id)) : roots;
    if (!shown.length && (filter || !release)) continue;
    const key = release ?? NO_RELEASE;
    const stats = groupStats(roots, release);
    const date = release && releaseDate(release);
    const classes = ['release-group'];
    if (collapsedGroups.has(key)) classes.push('collapsed');
    if (!release) classes.push('unplanned');
    if (date && date < today) classes.push('past');
    const bar = STATUSES.filter((s) => stats[s.id])
      .map((s) => `<span data-status="${s.id}" style="width:${(stats[s.id] / stats.total) * 100}%" title="${s.label}: ${stats[s.id]}"></span>`)
      .join('');
    html.push(`<section class="${classes.join(' ')}" data-group="${escapeHtml(key)}">
      <header class="release-head">
        <span class="release-toggle">▼</span>
        <h2>${release ? escapeHtml(release) : 'No release'}</h2>
        ${date ? `<span class="release-date">${releaseDateLabel(release)}</span>` : ''}
        <span class="release-stats">${stats.released} / ${stats.total} released</span>
      </header>
      ${stats.total ? `<div class="release-bar">${bar}</div>` : ''}
      <ul class="children root release-list">${shown.map((r) => releaseItemHtml(r, release, groupFilter)).join('')}</ul>
    </section>`);
  }

  if (groups.length === 1) {
    html.unshift(`<p class="release-empty">No releases yet. Give a task one with ${ALT} R or the release pill on its row in the Outline.</p>`);
  }
  els.releases.innerHTML = html.join('') || '<p class="release-empty">Nothing matches the filter.</p>';
}

els.releases.addEventListener('mousedown', (e) => {
  if (e.target.closest('.toggle, .status, .field, .tag, .release-head, .link')) e.preventDefault();
});

els.releases.addEventListener('contextmenu', onLinkContextMenu);
els.releases.addEventListener('click', (e) => {
  const head = e.target.closest('.release-head');
  if (head) {
    const key = head.parentElement.dataset.group;
    if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
    try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups])); } catch { /* session only */ }
    render();
    return;
  }
  const item = e.target.closest('.item');
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest('.toggle')) {
    setReleaseFold(id, !releaseFolds.has(id));
    render();
  } else if (e.target.closest('.status')) {
    openStatusMenu(id, e.target.closest('.status'));
  } else if (onLinkClick(e, id)) {
    // handled
  } else if (e.target.closest('.field')) {
    const pill = e.target.closest('.field');
    openFieldMenu(pill.dataset.field, id, pill);
  } else if (e.target.closest('.tag')) {
    setQuery(`#${e.target.closest('.tag').dataset.tag}`);
  } else if (ZOOM_ENABLED && e.target.closest('.text, .bullet, .row-fill')) {
    openInOutline(id);
  }
});

/* ==========================================================================
   Status menu
   ========================================================================== */
let statusMenuFor = null;

function openStatusMenu(id, anchor) {
  statusMenuFor = id;
  const current = nodeOf(id).status;
  els.statusMenu.innerHTML = [
    ...STATUSES.map((s, i) => `<button type="button" data-status="${s.id}" class="${s.id === current ? 'current' : ''}">
      <span class="swatch" data-status="${s.id}"></span>${s.label}<span class="key">${ALT} ${i + 1}</span></button>`),
    `<button type="button" data-status=""><span class="swatch"></span>No status<span class="key">${ALT} 0</span></button>`,
  ].join('');
  closeFieldMenu();
  closeLinkMenu();
  showPopover(els.statusMenu, anchor);
}

function showPopover(menu, anchor) {
  menu.hidden = false;
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(a.bottom + 4, innerHeight - m.height - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(a.left, innerWidth - m.width - 8))}px`;
}

function closeStatusMenu() {
  els.statusMenu.hidden = true;
  statusMenuFor = null;
}

els.statusMenu.addEventListener('mousedown', (e) => e.preventDefault());
els.statusMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !statusMenuFor) return;
  setStatus(statusMenuFor, btn.dataset.status || null);
  closeStatusMenu();
});
document.addEventListener('mousedown', (e) => {
  if (!els.statusMenu.hidden && !els.statusMenu.contains(e.target)) closeStatusMenu();
  if (!els.fieldMenu.hidden && !els.fieldMenu.contains(e.target)) closeFieldMenu();
  if (!els.linkMenu.hidden && !els.linkMenu.contains(e.target)) closeLinkMenu();
  if (!els.moveMenu.hidden && !els.moveMenu.contains(e.target)) closeMoveMenu();
});

/* ==========================================================================
   Field menu (person, release): pick an existing value or type a new one
   ========================================================================== */
let fieldMenuFor = null;   // { field, id, returnOffset }

function cleanFieldValue(field, raw) {
  const v = raw.trim().replace(/^[#@]/, '').replace(/\s+/g, ' ');
  return field === 'release' ? v.replace(/ /g, '') : v;
}

function openFieldMenu(field, id, anchor, returnOffset = null) {
  closeStatusMenu();
  fieldMenuFor = { field, id, returnOffset };
  const def = FIELDS[field];
  const current = nodeOf(id)[field];
  const placeholder = field === 'release' ? `New release, e.g. ${todayRelease()}` : `New ${def.label.toLowerCase()}`;
  els.fieldMenu.innerHTML = `
    <input type="text" placeholder="${placeholder}" spellcheck="false" autocomplete="off">
    <div class="options">${fieldValues(field).map((v) => `
      <button type="button" data-value="${escapeHtml(v)}" class="${v === current ? 'current' : ''}">
        ${escapeHtml(v)}${field === 'release' && releaseDate(v) ? `<span class="key">${releaseDate(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>` : ''}
      </button>`).join('')}<button type="button" class="create" hidden>Create “<span></span>”</button></div>
    <button type="button" data-value="" class="clear">No ${def.label.toLowerCase()}</button>`;
  showPopover(els.fieldMenu, anchor);
  els.fieldMenu.querySelector('input').focus();
  refreshFieldOptions();
  setActiveOption(els.fieldMenu.querySelector('.options .current'));
}

function closeFieldMenu(restoreFocus = false) {
  if (els.fieldMenu.hidden) return;
  els.fieldMenu.hidden = true;
  const m = fieldMenuFor;
  fieldMenuFor = null;
  if (restoreFocus && m?.returnOffset != null) focusItem(m.id, m.returnOffset);
}

function applyField(value) {
  const { field, id, returnOffset } = fieldMenuFor;
  closeFieldMenu();
  const before = JSON.stringify(doc);
  setPropagated(nodeOf(id), field, cleanFieldValue(field, value) || null);
  recordUndo(before, id);
  if (returnOffset != null && view === 'outline') commit(id, returnOffset);
  else commit();
}

els.fieldMenu.addEventListener('mousedown', (e) => {
  if (e.target.tagName !== 'INPUT') e.preventDefault();
});
els.fieldMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && fieldMenuFor) applyField(btn.dataset.value);
});
// Keeps the "Create" row and the highlighted option in step with what is typed.
function refreshFieldOptions() {
  const input = els.fieldMenu.querySelector('input');
  const typed = cleanFieldValue(fieldMenuFor.field, input.value);
  const lower = typed.toLowerCase();
  let exact = false;
  for (const btn of els.fieldMenu.querySelectorAll('.options button[data-value]:not(.create)')) {
    const v = btn.dataset.value.toLowerCase();
    btn.hidden = lower !== '' && !v.includes(lower);
    if (v === lower) exact = true;
  }
  const create = els.fieldMenu.querySelector('.create');
  create.hidden = typed === '' || exact;
  create.dataset.value = typed;
  create.querySelector('span').textContent = typed;
  setActiveOption(visibleOptions()[0] ?? null);
}

function visibleOptions() {
  return [...els.fieldMenu.querySelectorAll('.options button:not([hidden])')];
}

function setActiveOption(btn) {
  els.fieldMenu.querySelectorAll('.options .active').forEach((b) => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
    btn.scrollIntoView({ block: 'nearest' });
  }
}

els.fieldMenu.addEventListener('input', refreshFieldOptions);
els.fieldMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFieldMenu(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const opts = visibleOptions();
    if (!opts.length) return;
    const i = opts.indexOf(els.fieldMenu.querySelector('.options .active'));
    const next = e.key === 'ArrowDown' ? (i + 1) % opts.length : (i - 1 + opts.length) % opts.length;
    setActiveOption(opts[next]);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = els.fieldMenu.querySelector('.options .active');
    if (active) applyField(active.dataset.value);
  }
});

/* ==========================================================================
   Link editor: one ticket URL per item
   ========================================================================== */
let linkMenuFor = null;    // { id, returnOffset }

function openLinkMenu(id, anchor, returnOffset = null) {
  closeStatusMenu();
  closeFieldMenu();
  linkMenuFor = { id, returnOffset };
  const current = nodeOf(id).link || '';
  els.linkMenu.innerHTML = `
    <input type="text" value="${escapeHtml(current)}" placeholder="${jiraBase() ? 'Paste a URL or type a ticket key' : 'Paste a ticket URL'}" spellcheck="false" autocomplete="off">
    <div class="link-actions">
      <button type="button" data-act="save">Save<span class="key">↵</span></button>
      ${current ? `<button type="button" data-act="open">Open<span class="key">${MOD} ↵</span></button>
      <button type="button" data-act="remove">Remove</button>` : ''}
    </div>`;
  showPopover(els.linkMenu, anchor);
  const input = els.linkMenu.querySelector('input');
  input.focus();
  input.select();
}

function closeLinkMenu(restoreFocus = false) {
  if (els.linkMenu.hidden) return;
  els.linkMenu.hidden = true;
  const m = linkMenuFor;
  linkMenuFor = null;
  if (restoreFocus && m?.returnOffset != null) focusItem(m.id, m.returnOffset);
}

function setLink(id, link, returnOffset = null) {
  nodeOf(id).link = link;
  if (returnOffset != null && view === 'outline') commit(id, returnOffset);
  else commit();
}

function linkMenuAction(act) {
  const { id, returnOffset } = linkMenuFor;
  const input = els.linkMenu.querySelector('input');
  if (act === 'open') {
    window.open(nodeOf(id).link, '_blank', 'noopener');
    return;
  }
  const link = act === 'remove' ? null : resolveLink(input.value);
  if (link === undefined) {
    input.classList.add('invalid');
    return;
  }
  closeLinkMenu();
  setLink(id, link, returnOffset);
}

els.linkMenu.addEventListener('mousedown', (e) => {
  if (e.target.tagName !== 'INPUT') e.preventDefault();
});
els.linkMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn && linkMenuFor) linkMenuAction(btn.dataset.act);
});
els.linkMenu.addEventListener('input', (e) => e.target.classList.remove('invalid'));
els.linkMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeLinkMenu(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    linkMenuAction((IS_MAC ? e.metaKey : e.ctrlKey) && nodeOf(linkMenuFor.id).link ? 'open' : 'save');
  }
});

// Clicks on the link chip, shared by both views. Returns true when handled.
function onLinkClick(e, id, offset = null) {
  const btn = e.target.closest('.link');
  if (!btn) return false;
  if (btn.classList.contains('set')) return true; // the anchor opens the URL itself
  e.preventDefault();
  openLinkMenu(id, btn, offset);
  return true;
}

function onLinkContextMenu(e) {
  const btn = e.target.closest('.link');
  if (!btn) return;
  e.preventDefault();
  openLinkMenu(btn.closest('.item').dataset.id, btn);
}

/* ==========================================================================
   Tree events (delegated)
   ========================================================================== */
function onTextKeydown(e) {
  if (e.isComposing) return;
  const el = e.target;
  const id = el.closest('.item').dataset.id;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const key = e.key;
  const caret = () => getCaret(el) ?? 0;

  if (key === 'Enter' && !mod && !e.altKey) {
    e.preventDefault();
    if (!e.shiftKey) splitItem(id, caret());
  } else if (key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) outdent(id, caret()); else indent(id, caret());
  } else if (key === 'Backspace' && mod && e.shiftKey) {
    e.preventDefault();
    deleteItem(id);
  } else if (key === 'Backspace' && !mod && !e.altKey && selectionCollapsed() && caret() === 0) {
    if (backspaceAtStart(id)) e.preventDefault();
  } else if ((key === 'ArrowUp' || key === 'ArrowDown') && mod && e.shiftKey) {
    e.preventDefault();
    moveItem(id, key === 'ArrowUp' ? -1 : 1, caret());
  } else if ((key === 'ArrowUp' || key === 'ArrowDown') && mod) {
    e.preventDefault();
    setCollapsed(id, key === 'ArrowUp');
  } else if ((key === 'ArrowUp' || key === 'ArrowDown') && !e.shiftKey && !e.altKey) {
    const dir = key === 'ArrowUp' ? -1 : 1;
    if (!caretOnEdgeLine(el, dir)) return;
    const target = neighbourId(id, dir);
    if (target) {
      e.preventDefault();
      focusItem(target, Math.min(caret(), nodeOf(target).text.length));
    } else if (dir < 0 && zoomId !== 'root') {
      e.preventDefault();
      els.title.focus();
      setCaret(els.title, els.title.textContent.length);
    }
  } else if (mod && key === ']') {
    e.preventDefault();
    zoomTo(id);
  } else if (mod && key === '[') {
    e.preventDefault();
    if (zoomId !== 'root') zoomTo(parentOf(zoomId).id);
  } else if (e.altKey && /^Digit[0-5]$/.test(e.code)) {
    e.preventDefault();
    const n = Number(e.code.slice(5));
    setStatus(id, n === 0 ? null : STATUSES[n - 1].id);
  } else if (e.altKey && e.code === 'KeyJ') {
    e.preventDefault();
    openLinkMenu(id, el.closest('.row').querySelector('.link'), caret());
  } else if (e.altKey && Object.values(FIELDS).some((d) => d.key === e.code)) {
    e.preventDefault();
    const field = Object.keys(FIELDS).find((f) => FIELDS[f].key === e.code);
    openFieldMenu(field, id, el.closest('.row').querySelector(`.field[data-field="${field}"]`), caret());
  } else if (key === 'Escape') {
    el.blur();
  }
}

function onTextInput(e) {
  const el = e.target;
  if (!el.classList.contains('text')) return;
  const node = nodeOf(el.closest('.item').dataset.id);
  node.text = el.textContent;
  if (!e.isComposing && (node.text.includes('#') || el.children.length)) {
    const offset = getCaret(el);
    el.innerHTML = highlight(node.text);
    if (offset != null) setCaret(el, offset);
  }
  scheduleSave();
  renderSidebar();
}

els.tree.addEventListener('keydown', (e) => {
  if (e.target.classList.contains('text')) onTextKeydown(e);
});
els.tree.addEventListener('contextmenu', onLinkContextMenu);
els.tree.addEventListener('input', onTextInput);

els.tree.addEventListener('paste', (e) => {
  const el = e.target.closest('.text');
  if (!el) return;
  const text = e.clipboardData.getData('text/plain');
  // A lone URL becomes the item's link rather than text.
  if (/^\s*https?:\/\/\S+\s*$/i.test(text)) {
    e.preventDefault();
    setLink(el.closest('.item').dataset.id, text.trim(), getCaret(el) ?? 'end');
    return;
  }
  if (!text.includes('\n')) return;
  e.preventDefault();
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trimEnd()).filter((l) => l.trim());
  if (lines.length) pasteLines(el.closest('.item').dataset.id, getCaret(el) ?? 0, lines);
});

els.tree.addEventListener('mousedown', (e) => {
  // Keep focus where it is when clicking the chrome around an item.
  if (e.target.closest('.toggle, .status, .field, .tag, .bullet, .link')) e.preventDefault();
});

els.tree.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const id = item.dataset.id;

  if (e.target.closest('.toggle')) {
    const node = nodeOf(id);
    node.collapsed = !node.collapsed;
    commit();
  } else if (e.target.closest('.status')) {
    openStatusMenu(id, e.target.closest('.status'));
  } else if (e.target.closest('.link')) {
    const text = item.querySelector(':scope > .row > .text');
    onLinkClick(e, id, document.activeElement === text ? getCaret(text) : null);
  } else if (e.target.closest('.row-fill')) {
    if (touchScreen.matches) focusItem(id, 'end');
  } else if (e.target.closest('.field')) {
    const pill = e.target.closest('.field');
    const text = item.querySelector(':scope > .row > .text');
    const offset = document.activeElement === text ? getCaret(text) : null;
    openFieldMenu(pill.dataset.field, id, pill, offset);
  } else if (e.target.closest('.tag')) {
    setQuery(`#${e.target.closest('.tag').dataset.tag}`);
  }
});

/* ==========================================================================
   Title (the zoomed-in item)
   ========================================================================== */
els.title.addEventListener('input', () => {
  nodeOf(zoomId).text = els.title.textContent;
  scheduleSave();
});
els.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addChildToZoom(true);
  } else if (e.key === 'ArrowDown') {
    const first = visibleIds()[0];
    if (first) { e.preventDefault(); focusItem(first, 0); }
  } else if (e.key === 'Escape') {
    els.title.blur();
  }
});
els.title.addEventListener('blur', () => renderBreadcrumb());

/* ==========================================================================
   Sidebar, search, global keys
   ========================================================================== */
function setQuery(q) {
  query = q;
  els.search.value = q;
  render();
}

els.search.addEventListener('input', () => { query = els.search.value; render(); });
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setQuery(''); els.search.blur(); }
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    els.search.blur();
    const first = rowIds()[0];
    if (first) setCursor(first);
  }
});

document.querySelector('#sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-query]');
  if (!btn) return;
  setQuery(btn.classList.contains('active') ? '' : btn.dataset.query);
});

els.addItem.addEventListener('click', () => addChildToZoom());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.statusMenu.hidden) { closeStatusMenu(); return; }
  if (e.key === 'Escape' && !els.fieldMenu.hidden) { closeFieldMenu(true); return; }
  if (e.key === 'Escape' && !els.linkMenu.hidden) { closeLinkMenu(true); return; }
  if (e.key === 'Escape' && !els.moveMenu.hidden) { closeMoveMenu(); return; }
  onNavKeydown(e);
});

window.addEventListener('hashchange', applyHash);

/* ==========================================================================
   Navigate mode — a selected row driven by single keys; Enter edits it
   ========================================================================== */
const CURSOR_KEY = 'outliner.cursor';
const UNDO_LIMIT = 50;
const undoStack = [];      // { doc: JSON, cursor } snapshots taken before navigate-mode changes
let search = null;         // { text, prev, matches: [ids], i } while "/" is open
let lastSearch = '';
let keybarTimer = null;

function viewRoot() {
  return view === 'releases' ? els.releases : els.tree;
}

function rowIds() {
  return [...viewRoot().querySelectorAll('.item')].map((li) => li.dataset.id);
}

function rowEl(id) {
  return id ? viewRoot().querySelector(`.item[data-id="${id}"] > .row`) : null;
}

// Re-applies the selection after a render. A row folded away hands over to its nearest visible
// ancestor; a deleted row hands over to the one now in its place.
function paintCursor() {
  const ids = rowIds();
  if (!ids.includes(cursorId)) {
    const shown = new Set(ids);
    const ancestor = index.has(cursorId) ? [...ancestorsOf(cursorId)].reverse().find((a) => shown.has(a.id)) : null;
    cursorId = ancestor ? ancestor.id : ids[Math.min(cursorHint, ids.length - 1)] ?? null;
  }
  viewRoot().querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
  rowEl(cursorId)?.classList.add('selected');
  paintSearch();
}

function setCursor(id, scroll = true) {
  cursorId = id;
  cursorHint = Math.max(0, rowIds().indexOf(id));
  viewRoot().querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
  const row = rowEl(id);
  row?.classList.add('selected');
  if (scroll) row?.scrollIntoView({ block: 'nearest' });
  try { localStorage.setItem(CURSOR_KEY, id); } catch { /* not remembered */ }
}

function moveCursor(dir) {
  const ids = rowIds();
  if (!ids.length) return;
  const i = ids.indexOf(cursorId);
  setCursor(ids[i === -1 ? 0 : Math.max(0, Math.min(ids.length - 1, i + dir))]);
}

// Runs a change without entering editing, and records an undo step if the outline changed.
function navChange(fn) {
  const before = JSON.stringify(doc);
  const cursor = cursorId;
  keepNav = true;
  try { fn(); } finally { keepNav = false; }
  recordUndo(before, cursor);
}

function recordUndo(before, cursor) {
  if (JSON.stringify(doc) === before) return;
  undoStack.push({ doc: before, cursor });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  const step = undoStack.pop();
  if (!step) {
    flashKeybar('Nothing to undo');
    return;
  }
  doc = JSON.parse(step.doc);
  cursorId = step.cursor;
  render();
  scheduleSave();
  rowEl(cursorId)?.scrollIntoView({ block: 'nearest' });
  flashKeybar('Undone');
}

// The next value in a cycle that ends with "none"; a value outside the cycle starts it over.
function rotate(values, current, dir) {
  const cycle = [...values, null];
  const i = cycle.indexOf(current ?? null);
  if (i === -1) return cycle[0];
  return cycle[(i + dir + cycle.length) % cycle.length];
}

function rotationValues(field) {
  if (field === 'status') return STATUSES.map((s) => s.id);
  if (field === 'release') {
    const today = startOfToday();
    return fieldValues('release').filter((v) => !releaseDate(v) || releaseDate(v) >= today);
  }
  return fieldValues(field);
}

function rotateField(id, field, dir) {
  const node = nodeOf(id);
  const next = rotate(rotationValues(field), node[field], dir);
  navChange(() => {
    setPropagated(node, field, next);
    commit();
  });
}

function isFolded(id) {
  return view === 'releases' ? releaseFolds.has(id) : nodeOf(id).collapsed;
}

// Whether the row has children in the current view (the Releases view can leave some out).
function rowHasChildren(id) {
  return !!rowEl(id)?.parentElement.classList.contains('has-children');
}

function setCollapsedNav(id, collapsed) {
  if (!rowHasChildren(id) || isFolded(id) === collapsed) return;
  if (view === 'releases') {
    setReleaseFold(id, collapsed);
    render();
    return;
  }
  nodeOf(id).collapsed = collapsed;
  render();
  scheduleSave();
}

function navLeft(id) {
  if (rowHasChildren(id) && !isFolded(id)) {
    setCollapsedNav(id, true);
    return;
  }
  const parent = parentOf(id);
  if (parent && rowEl(parent.id)) setCursor(parent.id);
}

function navRight(id) {
  if (!rowHasChildren(id)) return;
  if (isFolded(id)) {
    setCollapsedNav(id, false);
    return;
  }
  const child = rowEl(id)?.parentElement.querySelector(':scope > .children > .item');
  if (child) setCursor(child.dataset.id);
}

// Folds the zoomed-in outline to show `levels` levels (0 = everything). If the selected row is
// folded away, the selection moves to its ancestor that is still shown.
function showLevels(levels) {
  if (view === 'releases') {
    showReleaseLevels(levels);
    return;
  }
  navChange(() => {
    (function walk(node, depth) {
      for (const c of node.children) {
        if (c.children.length) c.collapsed = levels > 0 && depth >= levels;
        walk(c, depth + 1);
      }
    })(nodeOf(zoomId), 1);
    if (cursorId && levels > 0) {
      const path = ancestorsOf(cursorId);
      const below = path.slice(path.findIndex((a) => a.id === zoomId) + 1);
      if (below.length >= levels) cursorId = below[levels - 1].id;
    }
    render();
    scheduleSave();
  });
  rowEl(cursorId)?.scrollIntoView({ block: 'nearest' });
  flashKeybar(levels ? `Showing ${levels} level${levels === 1 ? '' : 's'}` : 'Showing everything');
}

// The Releases view counterpart: levels counted from each task listed under a release.
function showReleaseLevels(levels) {
  for (const [release, roots] of releaseGroups()) {
    (function walk(nodes, depth) {
      for (const n of nodes) {
        const kids = groupChildren(n, release);
        if (kids.length) setReleaseFold(n.id, levels > 0 && depth >= levels);
        walk(kids, depth + 1);
      }
    })(roots, 1);
  }
  render();
  rowEl(cursorId)?.scrollIntoView({ block: 'nearest' });
  flashKeybar(levels ? `Showing ${levels} level${levels === 1 ? '' : 's'}` : 'Showing everything');
}

function newSiblingNav(id, below) {
  if (!id) {
    addChildToZoom();
    return;
  }
  const item = newItem();
  navChange(() => {
    inheritFields(item, parentOf(id));
    insertAt(parentOf(id), positionOf(id) + (below ? 1 : 0), item);
  });
  cursorId = item.id;
  commit(item.id, 0);
}

function deleteNav(id) {
  navChange(() => deleteItem(id));
}

/* ---- Search: "/" then type; matches highlight and the selection follows ---- */
function searchCandidates() {
  if (view === 'releases') return rowIds();
  const filter = computeFilter();
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      if (filter && !filter.show.has(c.id)) continue;
      out.push(c.id);
      walk(c);
    }
  })(nodeOf(zoomId));
  return out;
}

function findMatches(text) {
  const t = text.toLowerCase();
  const all = searchCandidates();
  return { all, matches: t ? all.filter((id) => nodeOf(id).text.toLowerCase().includes(t)) : [] };
}

// Opens the collapsed ancestors of an item, below the zoomed-in one, so it can be shown.
function revealNode(id) {
  let changed = false;
  let below = zoomId === 'root';
  for (const a of ancestorsOf(id)) {
    if (a.id === zoomId) { below = true; continue; }
    if (below && a.collapsed) { a.collapsed = false; changed = true; }
  }
  if (changed) {
    render();
    scheduleSave();
  }
}

function goToMatch(i) {
  search.i = i;
  const id = search.matches[i];
  if (view === 'outline') revealNode(id);
  setCursor(id);
  paintSearch();
  renderKeybar();
}

function updateSearch(startFrom) {
  const { all, matches } = findMatches(search.text);
  search.matches = matches;
  if (!matches.length) {
    search.i = -1;
    paintSearch();
    renderKeybar();
    return;
  }
  const order = new Map(all.map((id, i) => [id, i]));
  const from = order.get(startFrom) ?? 0;
  const i = matches.findIndex((id) => order.get(id) >= from);
  goToMatch(i === -1 ? 0 : i);
}

function startSearch() {
  search = { text: '', prev: cursorId, matches: [], i: -1 };
  renderKeybar();
}

function endSearch() {
  search = null;
  paintSearch();
  renderKeybar();
}

function onSearchKey(e) {
  const k = e.key;
  const n = search.matches.length;
  if (k === 'Escape' || (k === 'Backspace' && !search.text)) {
    e.preventDefault();
    const prev = search.prev;
    endSearch();
    if (prev && rowEl(prev)) setCursor(prev);
  } else if (k === 'Enter') {
    e.preventDefault();
    if (search.text) lastSearch = search.text;
    endSearch();
  } else if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    if (n) goToMatch((search.i + (k === 'ArrowDown' ? 1 : -1) + n) % n);
  } else if (k === 'Backspace') {
    e.preventDefault();
    search.text = search.text.slice(0, -1);
    updateSearch(search.matches[search.i] ?? search.prev);
  } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    search.text += k;
    updateSearch(search.matches[search.i] ?? search.prev);
  }
}

// n / N after a search: the next or previous match of the last search text.
function repeatSearch(dir) {
  if (!lastSearch) return;
  const { all, matches } = findMatches(lastSearch);
  if (!matches.length) {
    flashKeybar(`No match for “${lastSearch}”`);
    return;
  }
  const order = new Map(all.map((id, i) => [id, i]));
  const here = order.get(cursorId) ?? -1;
  const pick = dir > 0
    ? matches.find((id) => order.get(id) > here) ?? matches[0]
    : [...matches].reverse().find((id) => order.get(id) < here) ?? matches[matches.length - 1];
  if (view === 'outline') revealNode(pick);
  setCursor(pick);
  flashKeybar(`/${lastSearch}  ${matches.indexOf(pick) + 1} of ${matches.length}`);
}

// Character offsets within an element's text, as a DOM range across its text nodes.
function textRange(el, start, end) {
  const r = document.createRange();
  let pos = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const next = pos + n.length;
    if (start >= pos && start <= next) r.setStart(n, start - pos);
    if (end >= pos && end <= next) { r.setEnd(n, end - pos); break; }
    pos = next;
  }
  return r;
}

function paintSearch() {
  viewRoot().querySelectorAll('.row.match').forEach((r) => r.classList.remove('match'));
  if (window.CSS?.highlights) CSS.highlights.delete('search-match');
  const active = !!(search && search.text);
  els.main.classList.toggle('searching', active);
  if (!active) return;
  const t = search.text.toLowerCase();
  const ranges = [];
  for (const id of search.matches) {
    const row = rowEl(id);
    if (!row) continue;
    row.classList.add('match');
    const el = row.querySelector('.text');
    const lower = el.textContent.toLowerCase();
    for (let at = lower.indexOf(t); at !== -1; at = lower.indexOf(t, at + t.length)) {
      ranges.push(textRange(el, at, at + t.length));
    }
  }
  if (window.CSS?.highlights && ranges.length) CSS.highlights.set('search-match', new Highlight(...ranges));
}

/* ---- Bottom bar: the search line, or a short message ---- */
function renderKeybar() {
  clearTimeout(keybarTimer);
  if (!search) {
    els.keybar.hidden = true;
    return;
  }
  const n = search.matches.length;
  const count = !search.text ? 'type to search' : n ? `${search.i + 1} of ${n}` : 'no match';
  els.keybar.innerHTML = `<span class="query">/${escapeHtml(search.text)}<span class="caret"></span></span><span class="count">${count}</span>`;
  els.keybar.classList.toggle('nomatch', !!search.text && !n);
  els.keybar.hidden = false;
}

function flashKeybar(message) {
  if (search) return;
  els.keybar.innerHTML = `<span class="query">${escapeHtml(message)}</span>`;
  els.keybar.classList.remove('nomatch');
  els.keybar.hidden = false;
  clearTimeout(keybarTimer);
  keybarTimer = setTimeout(() => { els.keybar.hidden = true; }, 1600);
}

/* ---- Key list overlay ---- */
function toggleHelp(show = els.help.hidden) {
  if (show) els.help.innerHTML = `<h2>Keys</h2><dl>${shortcutsHtml()}</dl><p class="hint">Esc or ? to close</p>`;
  els.help.hidden = !show;
}

els.help.addEventListener('click', (e) => { if (e.target === els.help) toggleHelp(false); });

/* ---- The key handler ---- */
function isEditable(el) {
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function onNavKeydown(e) {
  if (e.defaultPrevented || e.isComposing || drag?.active || isEditable(e.target)) return;
  if (!els.help.hidden) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); toggleHelp(false); }
    return;
  }
  if (!els.statusMenu.hidden || !els.fieldMenu.hidden || !els.linkMenu.hidden || !els.moveMenu.hidden) return;
  if (search) {
    onSearchKey(e);
    return;
  }
  if (pane === 'scratch' && scratchIsOpen()) {
    onScratchKey(e);
    return;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'c') { e.preventDefault(); startCapture(); return; }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === '`') { e.preventDefault(); enterScratchPane(); return; }

  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const id = cursorId;
  const outline = view === 'outline';
  const k = e.key;
  let handled = true;

  if (mod && e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
    if (id && outline) navChange(() => moveItem(id, k === 'ArrowUp' ? -1 : 1));
  } else if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
    if (id) setCollapsedNav(id, k === 'ArrowUp');
  } else if (mod && k === ']') {
    if (id && outline) { cursorHint = 0; zoomTo(id); }
  } else if (mod && k === '[') {
    if (outline && zoomId !== 'root') { cursorId = zoomId; zoomTo(parentOf(zoomId).id); }
  } else if (mod || (e.altKey && !['KeyP', 'KeyR', 'KeyJ'].includes(e.code) && !/^Digit[0-5]$/.test(e.code))) {
    handled = false; // leave other shortcuts to the browser
  } else if (e.altKey) {
    if (!id) return;
    const row = rowEl(id);
    if (/^Digit[0-5]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      navChange(() => setStatus(id, n === 0 ? null : STATUSES[n - 1].id));
    } else if (e.code === 'KeyJ') openLinkMenu(id, row.querySelector('.link'));
    else {
      const field = e.code === 'KeyP' ? 'person' : 'release';
      openFieldMenu(field, id, row.querySelector(`.field[data-field="${field}"]`));
    }
  } else if (k === 'ArrowDown' || k === 'j') moveCursor(1);
  else if (k === 'ArrowUp' || k === 'k') moveCursor(-1);
  else if (k === 'g') { const ids = rowIds(); if (ids.length) setCursor(ids[0]); }
  else if (k === 'G') { const ids = rowIds(); if (ids.length) setCursor(ids[ids.length - 1]); }
  else if (k === 'ArrowLeft') { if (id) navLeft(id); }
  else if (k === 'ArrowRight') { if (id) navRight(id); }
  else if (k === ' ') { if (id) setCollapsedNav(id, !isFolded(id)); }
  else if (/^[0-9]$/.test(k)) showLevels(Number(k));
  else if (k === 'Enter') {
    if (!id) { if (outline) addChildToZoom(); }
    else if (outline) focusItem(id, 'end');
    else openInOutline(id);
  } else if (k === 'o' || k === 'O') { if (outline) newSiblingNav(id, k === 'o'); }
  else if (k === 'Tab') {
    if (id && outline) navChange(() => (e.shiftKey ? outdent(id) : indent(id)));
  } else if (k === 's' || k === 'S') { if (id) rotateField(id, 'status', k === 's' ? 1 : -1); }
  else if (k === 'p' || k === 'P') { if (id) rotateField(id, 'person', k === 'p' ? 1 : -1); }
  else if (k === 'r' || k === 'R') { if (id) rotateField(id, 'release', k === 'r' ? 1 : -1); }
  else if (k === 'l') { if (id && nodeOf(id).link) window.open(nodeOf(id).link, '_blank', 'noopener'); }
  else if (k === ']') { if (id && outline) { cursorHint = 0; zoomTo(id); } }
  else if (k === '[') { if (outline && zoomId !== 'root') { cursorId = zoomId; zoomTo(parentOf(zoomId).id); } }
  else if (k === '/') startSearch();
  else if (k === 'n' || k === 'N') repeatSearch(k === 'n' ? 1 : -1);
  else if (k === 'f') { els.search.focus(); els.search.select(); }
  else if (k === 'v') location.hash = outline ? '#/releases' : lastOutlineHash;
  else if (k === 'x' || k === 'Delete') { if (id && outline) deleteNav(id); }
  else if (k === 'u') undo();
  else if (k === '?') toggleHelp(true);
  else if (k === 'Escape') { if (query) setQuery(''); }
  else handled = false;

  if (handled) e.preventDefault();
}

// Editing a row selects it; the ring shows only while nothing is being edited.
// Edit mode means the cursor is in a row's text or the zoomed-in title; anything else is navigate.
const touchScreen = matchMedia('(hover: none)');
const modeBadge = $('#mode-badge');

function syncMode() {
  const a = document.activeElement;
  const editing = !!a && (a.id === 'title' || a.id === 'scratch-input' || !!a.closest?.('#tree .text, #scratch-list .text'));
  document.body.classList.toggle('editing', editing);
  modeBadge.textContent = editing ? 'Edit' : 'Navigate';
  modeBadge.dataset.mode = editing ? 'edit' : 'navigate';
}

document.addEventListener('focusin', (e) => {
  const item = e.target.closest?.('#tree .item');
  if (item && e.target.classList.contains('text')) setCursor(item.dataset.id, false);
  syncMode();
});
document.addEventListener('focusout', () => setTimeout(syncMode));

// On a desktop a click selects a row and never starts editing; only Enter does.
// Touch screens have no Enter key, so there a tap on the text still edits it.
for (const root of [els.tree, els.releases]) {
  root.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    setPane('outline');
    setCursor(item.dataset.id, false);
    if (root !== els.tree || touchScreen.matches || !e.target.closest('.text, .row-fill')) return;
    const text = item.querySelector(':scope > .row > .text');
    if (document.activeElement === text) return; // already editing this row: the click moves the caret
    e.preventDefault();
    if (isEditable(document.activeElement)) document.activeElement.blur();
  });
}


/* ==========================================================================
   Scratch pad — quick notes outside the plan; triaged by deleting or moving into the outline
   ========================================================================== */
let pane = 'outline';      // which list has the selection: 'outline' or 'scratch'
let noteCursor = null;
let noteHint = 0;
let captureReturn = null;  // where `c` came from, to go back after capturing
let editingNote = null;    // { id, before } while a note's text is being edited
let moveFor = null;        // the note the move menu is for

function scratchIsOpen() {
  return document.documentElement.dataset.scratch === 'open';
}

function setScratchOpen(open) {
  if (open) document.documentElement.dataset.scratch = 'open';
  else {
    delete document.documentElement.dataset.scratch;
    if (pane === 'scratch') setPane('outline');
  }
}

function setPane(p) {
  pane = p;
  document.body.dataset.pane = p;
}

function noteIds() {
  return doc.scratch.map((n) => n.id);
}

function noteRow(id) {
  return els.scratchList.querySelector(`.note[data-id="${id}"] > .row`);
}

function noteDate(iso) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderScratch() {
  const notes = doc.scratch;
  els.scratchToggle.querySelector('.n').textContent = notes.length;
  els.scratchToggle.classList.toggle('has-notes', notes.length > 0);
  $('#scratch-count').textContent = notes.length || '';
  if (editingNote) return; // rebuilt when the edit ends, so the caret is not lost
  els.scratchList.innerHTML = notes.length
    ? notes.map((n) => `<li class="note" data-id="${n.id}">
        <div class="row">
          <span class="bullet" title="Drag into the outline"></span>
          <div class="note-body">
            <div class="text">${highlight(n.text)}</div>
            <span class="note-date">${noteDate(n.created)}</span>
          </div>
          <button class="note-move" type="button" tabindex="-1" title="Move into the outline (m)">→</button>
          <button class="note-delete" type="button" tabindex="-1" title="Delete (x)">×</button>
        </div>
      </li>`).join('')
    : '<li class="scratch-empty">Nothing here. Press c to jot something down.</li>';
  paintNoteCursor();
}

function paintNoteCursor() {
  els.scratchList.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
  const ids = noteIds();
  if (!ids.includes(noteCursor)) noteCursor = ids[Math.min(noteHint, ids.length - 1)] ?? null;
  if (noteCursor) noteRow(noteCursor)?.classList.add('selected');
}

function setNoteCursor(id, scroll = true) {
  noteCursor = id;
  noteHint = Math.max(0, noteIds().indexOf(id));
  paintNoteCursor();
  if (scroll) noteRow(id)?.scrollIntoView({ block: 'nearest' });
}

function enterScratchPane() {
  setScratchOpen(true);
  setPane('scratch');
  paintNoteCursor();
}

function addNote(text) {
  const before = JSON.stringify(doc);
  const note = { id: uid(), text, created: new Date().toISOString() };
  doc.scratch.unshift(note);
  recordUndo(before, cursorId);
  noteCursor = note.id;
  renderScratch();
  scheduleSave();
}

function deleteNote(id) {
  const i = doc.scratch.findIndex((n) => n.id === id);
  if (i === -1) return;
  const before = JSON.stringify(doc);
  doc.scratch.splice(i, 1);
  recordUndo(before, cursorId);
  noteHint = i;
  renderScratch();
  scheduleSave();
}

// where: 'end' (last child; target 'root' = top level), or a drop position: 'before' / 'after' / 'inside'.
function moveNote(id, targetId, where = 'end') {
  const note = doc.scratch.find((n) => n.id === id);
  if (!note) return;
  const before = JSON.stringify(doc);
  const item = newItem(note.text);
  let parent;
  let pos;
  if (where === 'end' || where === 'inside') {
    parent = targetId === 'root' ? doc.root : nodeOf(targetId);
    pos = where === 'end' ? parent.children.length : 0;
    if (parent !== doc.root) parent.collapsed = false;
  } else {
    parent = parentOf(targetId);
    pos = positionOf(targetId) + (where === 'after' ? 1 : 0);
  }
  inheritFields(item, parent);
  insertAt(parent, pos, item);
  doc.scratch.splice(doc.scratch.indexOf(note), 1);
  recordUndo(before, cursorId);
  commit();
  flashKeybar(`Moved under “${parent === doc.root ? 'top level' : parent.text.trim() || 'Untitled'}”`);
}

/* ---- Capture box ---- */
function startCapture() {
  captureReturn = { wasOpen: scratchIsOpen(), pane };
  setScratchOpen(true);
  els.scratchInput.focus();
}

function endCapture() {
  const back = captureReturn;
  captureReturn = null;
  els.scratchInput.value = '';
  els.scratchInput.blur();
  syncMode();
  if (!back) return;
  if (!back.wasOpen) setScratchOpen(false);
  setPane(back.pane === 'scratch' && scratchIsOpen() ? 'scratch' : 'outline');
}

els.scratchInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = els.scratchInput.value.trim();
    if (text) {
      addNote(text);
      els.scratchInput.value = '';
    } else {
      endCapture();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    endCapture();
  }
});
els.scratchInput.addEventListener('blur', () => { captureReturn = null; });

/* ---- Editing a note ---- */
function noteTextEl(id) {
  return els.scratchList.querySelector(`.note[data-id="${id}"] .text`);
}

function editNote(id) {
  const el = noteTextEl(id);
  const note = doc.scratch.find((n) => n.id === id);
  if (!el || !note) return;
  editingNote = { id, before: JSON.stringify(doc) };
  el.contentEditable = 'plaintext-only';
  el.textContent = note.text;
  el.focus();
  setCaret(el, el.textContent.length);
}

els.scratchList.addEventListener('keydown', (e) => {
  if (!editingNote || !e.target.classList.contains('text')) return;
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    e.target.blur();
  }
});
els.scratchList.addEventListener('input', (e) => {
  if (!editingNote) return;
  const note = doc.scratch.find((n) => n.id === editingNote.id);
  if (note) note.text = e.target.textContent;
  scheduleSave();
});
els.scratchList.addEventListener('focusout', (e) => {
  if (!editingNote || !e.target.classList.contains('text')) return;
  const { id, before } = editingNote;
  editingNote = null;
  e.target.removeAttribute('contenteditable');
  const note = doc.scratch.find((n) => n.id === id);
  if (note && !note.text.trim()) doc.scratch.splice(doc.scratch.indexOf(note), 1);
  recordUndo(before, cursorId);
  scheduleSave();
  syncMode();
  setTimeout(renderScratch);
});

/* ---- Mouse ---- */
els.scratchList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('.note');
  if (!li) return;
  setPane('scratch');
  setNoteCursor(li.dataset.id, false);
  if (e.target.closest('.note-move, .note-delete, .bullet')) { e.preventDefault(); return; }
  const text = e.target.closest('.text');
  if (!text || text.isContentEditable) return;
  e.preventDefault(); // a click selects; Enter edits (on a phone a tap edits)
  if (isEditable(document.activeElement)) document.activeElement.blur();
  if (touchScreen.matches) editNote(li.dataset.id);
});

els.scratchList.addEventListener('click', (e) => {
  const li = e.target.closest('.note');
  if (!li) return;
  if (e.target.closest('.note-move')) openMoveMenu(li.dataset.id, e.target.closest('.note-move'));
  else if (e.target.closest('.note-delete')) deleteNote(li.dataset.id);
  else if (e.target.closest('.tag')) setQuery(`#${e.target.closest('.tag').dataset.tag}`);
});

els.scratchList.addEventListener('pointerdown', (e) => {
  const bullet = e.target.closest('.bullet');
  if (!bullet || e.button !== 0) return;
  drag = { id: bullet.closest('.note').dataset.id, note: true, x: e.clientX, y: e.clientY, active: false, target: null };
});

els.scratchToggle.addEventListener('click', () => setScratchOpen(!scratchIsOpen()));
$('#scratch-close').addEventListener('click', () => setScratchOpen(false));

/* ---- Keys while the scratch pad has the selection ---- */
function onScratchKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const id = noteCursor;
  const ids = noteIds();
  const i = ids.indexOf(id);
  let handled = true;
  if (k === 'ArrowDown' || k === 'j') { if (ids.length) setNoteCursor(ids[Math.min(ids.length - 1, i + 1)]); }
  else if (k === 'ArrowUp' || k === 'k') { if (ids.length) setNoteCursor(ids[Math.max(0, i - 1)]); }
  else if (k === 'g') { if (ids.length) setNoteCursor(ids[0]); }
  else if (k === 'G') { if (ids.length) setNoteCursor(ids[ids.length - 1]); }
  else if (k === 'Enter') { if (id) editNote(id); }
  else if (k === 'x' || k === 'Delete' || k === 'Backspace') { if (id) deleteNote(id); }
  else if (k === 'm') { if (id) openMoveMenu(id, noteRow(id)); }
  else if (k === 'c') startCapture();
  else if (k === '`' || k === 'Escape') setPane('outline');
  else if (k === 'u') undo();
  else if (k === '?') toggleHelp(true);
  else handled = false;
  if (handled) e.preventDefault();
}

/* ---- "Move under…" menu ---- */
function openMoveMenu(id, anchor) {
  moveFor = id;
  els.moveMenu.innerHTML = '<input type="text" placeholder="Move under… type to find a task" autocomplete="off" spellcheck="false"><div class="options"></div>';
  showPopover(els.moveMenu, anchor);
  els.moveMenu.querySelector('input').focus();
  refreshMoveOptions();
}

function closeMoveMenu() {
  els.moveMenu.hidden = true;
  moveFor = null;
}

function refreshMoveOptions() {
  const t = els.moveMenu.querySelector('input').value.trim().toLowerCase();
  const found = [];
  forEachNode((n) => { if (found.length < 40 && n.text.trim() && (!t || n.text.toLowerCase().includes(t))) found.push(n); });
  const top = !t || 'top level'.includes(t) ? ['<button type="button" data-target="root">Top level</button>'] : [];
  const rows = found.map((n) => {
    const path = ancestorsOf(n.id).filter((a) => a.id !== 'root').map((a) => a.text.trim() || 'Untitled').join(' › ');
    return `<button type="button" data-target="${n.id}"><span class="move-text">${escapeHtml(n.text)}</span>${path ? `<span class="move-path">${escapeHtml(path)}</span>` : ''}</button>`;
  });
  els.moveMenu.querySelector('.options').innerHTML = [...top, ...rows].join('') || '<div class="move-none">No matching task</div>';
  els.moveMenu.querySelector('.options button')?.classList.add('active');
}

function moveMenuStep(dir) {
  const opts = [...els.moveMenu.querySelectorAll('.options button')];
  if (!opts.length) return;
  const i = opts.findIndex((b) => b.classList.contains('active'));
  opts.forEach((b) => b.classList.remove('active'));
  const next = opts[(i + dir + opts.length) % opts.length];
  next.classList.add('active');
  next.scrollIntoView({ block: 'nearest' });
}

function chooseMoveTarget(targetId) {
  const id = moveFor;
  closeMoveMenu();
  if (id && targetId) moveNote(id, targetId);
}

els.moveMenu.addEventListener('input', refreshMoveOptions);
els.moveMenu.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
els.moveMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-target]');
  if (btn) chooseMoveTarget(btn.dataset.target);
});
els.moveMenu.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveMenuStep(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); chooseMoveTarget(els.moveMenu.querySelector('.options .active')?.dataset.target); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMoveMenu(); }
});

setPane('outline');

/* ==========================================================================
   Theme — follows the system until flipped, then remembers the choice
   ========================================================================== */
const THEME_KEY = 'outliner.theme';

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable: choice lasts this session */ }
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (!saved) setTheme(e.matches ? 'dark' : 'light');
});

/* ==========================================================================
   Sidebar — shown or hidden, remembered per browser
   ========================================================================== */
const SIDEBAR_KEY = 'outliner.sidebar';
const sidebarToggle = $('#sidebar-toggle');
const narrowScreen = matchMedia('(max-width: 700px)');

function setSidebarHidden(hidden) {
  if (hidden) document.documentElement.dataset.sidebar = 'hidden';
  else delete document.documentElement.dataset.sidebar;
  sidebarToggle.title = `${hidden ? 'Show' : 'Hide'} sidebar (${MOD} \\)`;
  // On a narrow screen the sidebar is a slide-over, so its state is not remembered.
  if (narrowScreen.matches) return;
  try { localStorage.setItem(SIDEBAR_KEY, hidden ? 'hidden' : 'shown'); } catch { /* session only */ }
}

function toggleSidebar() {
  setSidebarHidden(document.documentElement.dataset.sidebar !== 'hidden');
}

sidebarToggle.addEventListener('click', toggleSidebar);

// On a narrow screen, a tap outside the open sidebar, or on one of its filters, closes it.
document.addEventListener('click', (e) => {
  if (!narrowScreen.matches || document.documentElement.dataset.sidebar === 'hidden') return;
  if (sidebarToggle.contains(e.target)) return;
  if (!$('#sidebar').contains(e.target) || e.target.closest('#sidebar button[data-query]')) setSidebarHidden(true);
});
sidebarToggle.title = `${document.documentElement.dataset.sidebar === 'hidden' ? 'Show' : 'Hide'} sidebar (${MOD} \\)`;

// Works while typing in an item too.
document.addEventListener('keydown', (e) => {
  if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    toggleSidebar();
  }
}, true);

/* ==========================================================================
   Dev: live reload when files in public/ change (CSS swaps in place)
   ========================================================================== */
function connectDevReload() {
  const es = new EventSource('/api/dev-reload');
  es.onmessage = async (e) => {
    if (e.data.endsWith('.css')) {
      const link = document.querySelector('link[rel="stylesheet"]');
      link.href = `styles.css?v=${Date.now()}`;
    } else {
      if (saveState !== 'saved') await save();
      location.reload();
    }
  };
}

/* ==========================================================================
   Boot
   ========================================================================== */
(async function boot() {
  renderShortcuts();
  try {
    await load();
  } catch (err) {
    console.error(err);
    setSaveState('error');
    els.tree.innerHTML = '<li class="item"><div class="row">Could not load the outline. Start the server with <code>npm start</code>.</div></li>';
    return;
  }
  setSaveState('saved');
  try { cursorId = localStorage.getItem(CURSOR_KEY); } catch { /* start at the top */ }
  applyHash();
  if (view === 'outline' && !nodeOf(zoomId).children.length) addChildToZoom();
  syncMode();
  connectDevReload();
})();
