// #165 (#149 phase 1, PR 4a), #148: the search panel. The page's own block (public/index.html, from
// "// ===== #165: the search panel" to the form chips' tooltip) is extracted and run in a small fake DOM
// on an index built, by the real modules (public/search), from the frozen search data
// (tests/search/fixtures/search). The legacy panel is dormant and not run here. What a browser adds
// (focus, layout, the phone sheet's trap, real requests) is tests/e2e/search-panel.e2e.mjs.
// Every expectation comes from the slate, the fixture or a stated page rule (R1-R12, at the top of the
// block), never from the code under test. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/search-panel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readJSON, readLF, HERE, ROOT, FIXTURES, indexOf, destinationProblem, loadFixtures } from './search/judged.mjs';

const PAGE = process.env.ECNL_TEST_HTML ? pathToFileURL(process.env.ECNL_TEST_HTML) : new URL('public/index.html', ROOT);   // a mutated copy, for the mutation checks
const html = readLF(PAGE);
const rawHtml = readFileSync(PAGE, 'utf8');
const START = '    // ===== #165: the search panel (public/search) =====\n', END = "    // #128: the form chips' tooltip";
const BLOCK = html.slice(html.indexOf(START), html.indexOf(END));
assert.ok(BLOCK.length > 20000 && html.indexOf(START) > 0, 'the #165 block is in index.html');

const MODULES = new URL('public/search/', ROOT);
const S = await import(new URL('search.mjs', MODULES));
const FX = new URL('search/', FIXTURES);
const coreText = readLF(new URL('core.json', FX)), placesText = readLF(new URL('places.json', FX));
const fresh = () => ({ core: JSON.parse(coreText), places: JSON.parse(placesText) });
const doc = readJSON(new URL('queries.json', HERE));
const NOW = Date.parse(doc.context.now), SEASON = doc.context.selectedSeason;
const CTX = { now: NOW, timeZone: doc.context.timeZone, selectedSeason: SEASON };
const BUILT = S.buildIndex(fresh());
const slateOf = q => S.search(BUILT, q, CTX);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const seasonLabel = s => (s === SEASON ? 'Current season' : `${s.replace('-', '–')} season`);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- a tiny HTML tree, to ask the ARIA questions of the drawn grid ----------
export function parse(h) {
  const root = { tag: '#root', attrs: {}, kids: [], parent: null }; let cur = root;
  for (const m of h.matchAll(/<(\/?)([a-z0-9]+)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/gi)) {
    if (m[5] != null) { cur.kids.push({ text: m[5], parent: cur }); continue; }
    const [, close, tag, attrs, self] = m;
    if (close) { while (cur.tag !== tag.toLowerCase() && cur.parent) cur = cur.parent; if (cur.parent) cur = cur.parent; continue; }
    const node = { tag: tag.toLowerCase(), attrs: Object.fromEntries([...attrs.matchAll(/([a-z-]+)="([^"]*)"/g)].map(x => [x[1], x[2]])), kids: [], parent: cur };
    cur.kids.push(node);
    if (!self) cur = node;
  }
  return root;
}
const walk = (n, f) => { if (n.tag) f(n); for (const k of n.kids || []) walk(k, f); };
const all = (n, pred) => { const out = []; walk(n, x => { if (pred(x)) out.push(x); }); return out; };
const text = n => (n.text != null ? n.text : (n.kids || []).map(text).join(''));
const hasClass = (n, c) => (n.attrs.class || '').split(/\s+/).includes(c);
const roleOf = n => n.attrs.role || null;

// ---------- the fake page: the globals the block reads, and the elements it writes ----------
function page({ sheet = false, live = false, mod = S, data = fresh, fetchJSON, season = SEASON, importMs = 0, saveData = false } = {}) {
  const els = new Map(), listeners = [], opened = [], appended = [], fetched = [];
  const node = id => ({
    id, hidden: false, value: '', textContent: '', className: '', attrs: {}, style: {}, on: {}, _html: '', dataset: {},
    addEventListener(k, f) { this.on[k] = f; },
    get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    querySelector: () => null, querySelectorAll: () => [], contains: () => false, scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; },
    focus() { api.focused = this; }, blur() { if (api.focused === this) api.focused = null; }, getBoundingClientRect: () => ({ left: 400, bottom: 50 }), offsetParent: {},
  });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  // a grid cell is found in the list's HTML, with its attributes as drawn, and keeps what the block sets on it
  const cellAttrs = new Map();
  const getElementById = id => {
    if (!/^sx-c-\d+$/.test(id)) return el(id);
    const h = el('usearchList')._html;
    const m = h.match(new RegExp(`<span role="gridcell"[^>]*\\bid="${id}"[^>]*>`));
    if (!m) return null;
    const n = el(id);
    if (!cellAttrs.has(id) || cellAttrs.get(id) !== h) { n.attrs = Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(x => [x[1], x[2]])); cellAttrs.set(id, h); }
    return n;
  };
  const location = { hash: '' };
  const hashEvents = [];
  const head = { appendChild: n => appended.push(n) };
  const stubs = {
    document: { getElementById, addEventListener() {}, createElement: tag => ({ tag }), head, querySelector: () => null },
    window: { location, innerWidth: sheet ? 390 : 1400, innerHeight: 900, dispatchEvent: e => hashEvents.push(e), addEventListener: (k, f) => listeners.push([k, f]), open: (...a) => opened.push(a) },
    navigator: { connection: saveData ? { saveData: true } : undefined },
    location, HashChangeEvent: class { constructor(t) { this.type = t; } },
    esc, isPhone: () => sheet, LIVE: live, NO_CLUB: 7, currentSeason: season, sessionBackAt: 0,
    teamSeasonTabLabel: seasonLabel, closeSidebarIfMobile() { api.sidebarClosed = (api.sidebarClosed || 0) + 1; },
    retryText: e => (e && e.status === 429 ? 'Too many requests.' : 'Please try again shortly.'),
    isMissing: e => !!e && e.status === 404, isRefusal: e => !!e && e.status >= 400 && e.status < 500 && e.status !== 404,
    fetchJSON: fetchJSON || (async path => { fetched.push(path); const d = data(); return path === 'search/core' ? d.core : d.places; }),
    Date: { now: () => NOW },
    requestIdleCallback: undefined,
    setTimeout: (f, ms) => setTimeout(f, ms),
  };
  const names = Object.keys(stubs);
  const api = new Function(...names, `${BLOCK}
    sxImport = async () => { if (arguments[${names.length}] ) await arguments[${names.length}](); return arguments[${names.length + 1}]; };
    return { sxOpen, sxOpenSheet, sxClose, sxRun, sxKey, sxDrive, sxLoad, sxPreload, sxFill, sxHoverCell, sxActivate, sxGoTo, sxMark, sxGroups, SX_MODULES, SX_TASK_MS, SX_SIZES,
      state: () => ({ sxState, sxView, sxActive, sxLoadP, sxIndex }), setImport: f => { sxImport = f; } };`)(...Object.values(stubs), importMs ? () => wait(importMs) : null, mod);
  const input = el(sheet ? 'usearchSheetInput' : 'usearchInput');
  const key = (k, extra = {}) => { const e = { key: k, shiftKey: false, preventDefault() { e.prevented = true; }, target: input, ...extra }; input.on.keydown(e); return e; };
  const open = async (q = '') => { input.value = q; api.sxOpen(input); await api.state().sxLoadP; await wait(0); return api; };
  const run = async q => { await open(q); input.value = q; api.sxRun(q); return list(); };
  const list = () => el('usearchList')._html;
  const click = (i, extra = {}) => el('usearchList').on.click({ target: { closest: () => ({ dataset: { c: String(i) } }) }, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });
  const cells = () => api.state().sxView ? api.state().sxView.cells : [];
  const activeCell = () => cells()[api.state().sxActive];
  const tree = () => parse(list());
  return Object.assign(api, { el, input, key, open, run, list, click, cells, activeCell, tree, location, hashEvents, opened, appended, fetched, listeners, stubs,
    status: () => el('sxStatus').innerHTML, lead: () => el('sxLead').innerHTML, live: () => el('usearchLive').textContent, bar: () => ({
      hidden: el('usearchActions').hidden, text: el('usearchActive').textContent, cls: el('usearchActive').className, open: el('usearchOpen'), hist: el('usearchHist'), prev: el('usearchPrev') }),
    keysLine: () => el('sxKeys').innerHTML, pop: () => el('usearchPop'), nav: () => api.state().sxView && api.state().sxView.nav });
}

// ---------- the tests ----------
test('index.html keeps one line-ending style, and the panel block is bounded by its marker and the tooltip', () => {
  assert.ok(!/\r\n/.test(rawHtml) || !/[^\r]\n/.test(rawHtml), 'mixed line endings');
  assert.equal(html.split(START).length, 2);
  assert.ok(html.indexOf(START) < html.indexOf(END));
  const mark = html.indexOf('    // #165: the legacy search above is dormant until PR 5 removes it');
  assert.ok(mark > 0 && mark < html.indexOf(START), 'the dormant marker sits before the block (PAGE_END)');
  assert.ok(!/function usWire|usWire\(\)/.test(html.slice(mark)), 'the legacy wiring is gone');
});

test('markup: the combobox opens a grid, the grid is always in the DOM and named, no role=option remains, the labels say events', () => {
  assert.match(html, /id="usearchInput"[^>]*aria-haspopup="grid"/);
  assert.match(html, /id="usearchSheetInput"[^>]*aria-haspopup="grid"/);
  assert.match(html, /<ul class="sx-list" id="usearchList" role="grid" aria-label="Search results"><\/ul>/);
  assert.ok(!/role="option"|role="listbox"/.test(BLOCK + html.slice(html.indexOf('<div class="usearch-pop sx"'), html.indexOf('<div class="sidebar-overlay"'))));
  assert.match(html, /id="headerSearch"[^>]*aria-label="Search teams and events"/, 'nit 5');
  assert.match(html, /<div class="usearch" id="usearch" role="search" aria-label="Teams and events">/);
  assert.match(html, /placeholder="Search teams, clubs, places, events…"/);
  for (const f of ['usOpenSheet()', 'usClose(true)']) assert.ok(!html.slice(0, html.indexOf('let usDb')).includes(`onclick="${f}"`), `${f} is not called from the markup`);
  for (const f of ['sxOpenSheet()', 'sxClose(true)']) assert.ok(html.includes(`onclick="${f}"`), f);
});

test('modules are preloaded at idle from the real file list, never in live mode or on a data-saver connection (Q4)', async () => {
  const files = readdirSync(MODULES).filter(f => f.endsWith('.mjs')).map(f => `/search/${f}`).sort();
  const p = page();
  assert.deepEqual([...p.SX_MODULES].sort(), files, 'the preload list is the modules directory');
  assert.equal(p.appended.length, 0, 'nothing at load: the block only schedules it');
  p.sxPreload();
  assert.deepEqual(p.appended.map(l => [l.rel, l.href]).sort(), files.map(f => ['modulepreload', f]));
  for (const opts of [{ live: true }, { saveData: true }]) { const q = page(opts); q.sxPreload(); assert.equal(q.appended.length, 0, JSON.stringify(opts)); }
  assert.match(BLOCK, /requestIdleCallback\(sxPreload/);
});

test('loading: first focus makes exactly 2 fetches (core, places), none per keystroke, and the second focus none', async () => {
  const p = page();
  await p.open('');
  assert.deepEqual(p.fetched, ['search/core', 'search/places']);
  for (const q of ['Surf', 'Surf C', 'southwest', 'zzzz']) { p.input.value = q; p.sxRun(q); }
  p.sxClose(); await p.open('Surf');
  assert.deepEqual(p.fetched, ['search/core', 'search/places']);
  assert.equal(p.state().sxState, 'ready');
});

test('loading: the panel opens at once with the loading words and tips; a query typed meanwhile runs once, when ready; events are built last', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let searches = 0, observed = [];
  const mod = { ...S, search: (...a) => { searches++; return S.search(...a); }, startIndex: function* (d, n) {
    const g = S.startIndex(d, n); let r;
    while (!(r = g.next()).done) { observed.push([r.value, p.state().sxState]); yield r.value; }
    observed.push(['index built', p.state().sxState]);   // the moment the last step (events) has run
    return r.value;
  } };
  const p = page({ mod }); p.setImport(async () => { await gate; return mod; });
  p.input.value = 'Surf'; p.sxOpen(p.input);
  assert.match(p.status(), /Getting search ready/);
  assert.match(p.lead(), /sx-bar/); assert.match(p.lead(), /us-chip/); assert.match(p.lead(), /sx-skel/);
  assert.equal(p.pop().hidden, false);
  p.input.on.input(); await wait(100);   // the 60 ms debounce passes, still loading: nothing runs
  assert.equal(searches, 0);
  release(); await p.state().sxLoadP; await wait(0);
  assert.equal(searches, 1, 'the typed query ran once, when ready');
  assert.match(p.list(), /Surf/);
  assert.ok(observed.length > 100 && observed.every(([, s]) => s === 'loading'), 'never ready before the last step');
  assert.deepEqual(observed.at(-2)[0], 'events', 'events are the last step: teams are never shown without them');
  assert.equal(observed.at(-1)[0], 'index built');
  assert.equal(p.state().sxState, 'ready', 'and the page is ready only after the index is built');
});

test('sxDrive: no task runs past the budget: it yields before a step that would pass it (a fake clock)', async () => {
  const p = page();
  let t = 0, yields = 0; const tasks = []; let taskStart = 0;
  const costs = [3, 3, 4, 2, 5, 3, 4, 3, 2, 4, 3, 5, 4, 2, 3];   // the largest step comes early, as the first heavy stage does
  let i = 0;
  const gen = (function* () { while (i < 300) { t += costs[i % costs.length]; i++; yield `s${i}`; } return 'done'; })();
  const now = () => t;
  const res = await p.sxDrive(gen, { now, budget: 40, yieldNow: async () => { tasks.push(t - taskStart); taskStart = t; yields++; } });
  tasks.push(t - taskStart);
  assert.equal(res, 'done');
  assert.ok(yields > 10, `${yields} yields`);
  assert.ok(Math.max(...tasks) <= 40 + 1e-9, `longest task ${Math.max(...tasks)} ms over the 40 ms budget`);
  assert.ok(Math.max(...tasks) > 30, 'the budget is used, not wasted');
  // a slow step is seen before the next: the guard adds the slowest step so far
  const slow = []; let u = 0, ts = 0; const g2 = (function* () { for (let k = 0; k < 40; k++) { u += k === 0 ? 38 : 2; yield k; } return 1; })();
  await p.sxDrive(g2, { now: () => u, budget: 40, yieldNow: async () => { slow.push(u - ts); ts = u; } });
  slow.push(u - ts);
  assert.ok(slow[0] <= 40 && slow.every(x => x <= 40 || x === slow[0]), JSON.stringify(slow));
  assert.deepEqual(await p.sxDrive((function* () { return 7; })(), { now }), 7);
});

test('sxDrive: an error thrown on the first step reaches the caller (the generator throws on next(), not on creation)', async () => {
  const p = page();
  const bad = fresh(); bad.core.schema = 3;
  const g = S.startIndex(bad, 50);   // creating it throws nothing
  await assert.rejects(p.sxDrive(g), e => e instanceof S.SearchDataError);
});

test('version: a SEARCH_API other than the expected shows the reload note, search is never called, and the note is an alert', async () => {
  let searches = 0, started = 0;
  const mod = { ...S, SEARCH_API: 3, search: () => { searches++; }, startIndex: () => { started++; } };
  const p = page({ mod }); await p.open('Surf').catch(() => { });
  assert.match(p.lead(), /Search was updated while this page was open/);
  assert.match(p.lead(), /role="alert"/);
  assert.match(p.lead(), /Reload page/);
  assert.equal(p.list(), '');
  p.input.value = 'Surf'; p.sxRun('Surf'); p.input.on.input(); await wait(80);
  assert.equal(searches + started, 0);
  assert.equal(p.state().sxState, 'reload');
  p.sxClose(); p.sxOpen(p.input);   // reopening shows the note again, no new import
  assert.match(p.lead(), /Search was updated/);
  assert.match(BLOCK, /mod\.SEARCH_API !== SX_API_EXPECTED/, 'not >=: any other version');
  assert.match(BLOCK, /const SX_API_EXPECTED = 2;/);
  assert.equal(S.SEARCH_API, 2);
});

test('version: an unknown schema (SearchDataError, thrown by the first build step) shows the same note', async () => {
  const p = page({ data: () => { const d = fresh(); d.core.schema = 9; return d; } });
  await p.open('Surf').catch(() => { });
  assert.match(p.lead(), /Search was updated while this page was open/);
  assert.equal(p.state().sxState, 'reload');
});

test('live mode: search is off: 0 fetches, 0 imports, and the words say so', async () => {
  let imports = 0;
  const p = page({ live: true }); p.setImport(async () => { imports++; return S; });
  await p.open('Surf').catch(() => { });
  assert.match(p.status(), /Search is not available in live mode/);
  assert.deepEqual(p.fetched, []);
  assert.equal(imports, 0);
});

test('errors: a 404 is "isn\'t available", a refusal says try again and is kept for a minute, a 5xx is forgotten', async () => {
  const mk = status => async path => { calls.push(path); throw Object.assign(new Error(`API error ${status}`), { status }); };
  let calls = [];
  const p404 = page({ fetchJSON: mk(404) }); await p404.open('Surf').catch(() => { });
  assert.match(p404.status(), /Search isn&#39;t available right now|Search isn't available right now/);
  const p429 = page({ fetchJSON: mk(429) }); await p429.open('Surf').catch(() => { });
  assert.match(p429.status(), /Couldn't load search\. Too many requests\./);
  calls = []; p429.sxClose(); await p429.open('Surf').catch(() => { });
  assert.deepEqual(calls, [], 'a refusal is kept: no new request within the minute');
  const p500 = page({ fetchJSON: mk(500) }); await p500.open('Surf').catch(() => { });
  assert.match(p500.status(), /Couldn't load search\. Please try again shortly\./);
  calls = []; p500.sxClose(); await p500.open('Surf').catch(() => { });
  assert.ok(calls.length >= 1, 'a 5xx is forgotten: the next focus asks again');
});

// ----- what is drawn, for every judged query -----
const judgedKeystrokes = () => { const out = new Set(); for (const q of doc.queries) for (let i = 1; i <= q.q.length; i++) out.add(q.q.slice(0, i)); return [...out]; };
const headings = p => all(p.tree(), n => hasClass(n, 'sx-head')).map(n => text(n).replace(/\s+/g, ' ').trim());

test('R12 and slate order: for every judged query the panel draws the slate\'s sections in the slate\'s order, best match first', async () => {
  const p = page(); await p.open('');
  let checked = 0;
  for (const { q } of doc.queries) {
    const s = slateOf(q); p.input.value = q; p.sxRun(q);
    if (!s.sections.length) { assert.equal(p.list().includes('role="row"'), p.list().includes('Games'), q); continue; }
    const want = [];
    if (s.best) want.push('Best match');
    for (const sec of s.sections) {
      const n = s.best ? sec.rows.filter(r => (s.best.kind === 'team' ? r.key !== s.best.key : r.eventID !== s.best.eventID)).length : sec.rows.length;
      if (n) want.push(sec.name === 'teams' ? (s.best ? 'More teams' : 'Teams') : (s.best ? 'More events' : 'Events'));
    }
    want.push('Games');
    assert.deepEqual(headings(p).map(h => h.replace(/\s\d.*$/, '').replace(/\s+\d+$/, '')), want, q);
    checked++;
  }
  assert.ok(checked >= 40, `${checked} queries drawn`);
});

test('ARIA grid: every cell sits in a row, every row in the grid or a rowgroup, ids are unique, nothing is an option (every judged keystroke)', async () => {
  const p = page(); await p.open('');
  let n = 0, cellsSeen = 0;
  for (const q of judgedKeystrokes()) {
    p.input.value = q; p.sxRun(q);
    const t = p.tree(), ids = new Set();
    for (const c of all(t, x => roleOf(x) === 'gridcell')) {
      cellsSeen++;
      assert.ok(!ids.has(c.attrs.id), `${q}: duplicate id ${c.attrs.id}`); ids.add(c.attrs.id);
      let a = c.parent; while (a && roleOf(a) !== 'row') a = a.parent;
      assert.ok(a, `${q}: a gridcell outside a row`);
    }
    for (const r of all(t, x => roleOf(x) === 'row')) {
      let a = r.parent; while (a && a.tag !== '#root' && roleOf(a) !== 'rowgroup') a = a.parent;
      assert.ok(a, `${q}: a row outside the grid and a rowgroup`);
    }
    assert.equal(all(t, x => roleOf(x) === 'option').length, 0, q);
    for (const e of all(t, x => 'aria-expanded' in x.attrs)) assert.equal(roleOf(e), 'gridcell', `${q}: aria-expanded only on gridcells`);
    const ad = p.input.getAttribute('aria-activedescendant');
    if (p.cells().length) { assert.ok(ad && ids.has(ad), `${q}: aria-activedescendant names a cell of the grid`); assert.equal(all(t, x => x.attrs['aria-selected'] === 'true').length, 0, 'the drawn html has none selected: the block sets it on the element'); }
    else assert.equal(ad, null, q);
    n++;
  }
  assert.ok(n > 500 && cellsSeen > 5000, `${n} keystrokes, ${cellsSeen} cells`);
});

test('ARIA: the active cell is the only one selected, the box names it, and the grid is in the popup aria-controls names', async () => {
  const p = page(); await p.run('Surf');
  assert.equal(p.input.getAttribute('aria-controls') ?? 'usearchList', 'usearchList');
  assert.match(html, /<ul class="sx-list" id="usearchList" role="grid"/);
  const a = p.activeCell(), id = `sx-c-${p.state().sxActive}`;
  assert.equal(p.input.getAttribute('aria-activedescendant'), id);
  assert.equal(p.stubs.document.getElementById(id).getAttribute('aria-selected'), 'true');
  p.key('ArrowDown');
  assert.equal(p.stubs.document.getElementById(id).getAttribute('aria-selected'), 'false', 'the previous cell is deselected');
  assert.equal(p.input.getAttribute('aria-activedescendant'), `sx-c-${p.state().sxActive}`);
  assert.ok(a.team);
});

test('R1: clubs in the slate\'s first-appearance order, a reviewed family as one group, one line per team name', async () => {
  const p = page(); await p.run('so');
  const rows = slateOf('so').sections[0].rows;
  const keyOf = r => (r.family ? `f:${r.family.name}` : r.clubID === 7 ? `t:${r.line}` : `c:${r.clubID}`);
  const nameOf = r => (r.family ? r.family.name : r.clubID === 7 ? r.line : r.club);
  const first = new Map(); for (const r of rows) if (!first.has(keyOf(r)) && !(!r.current && r.continuesAs.some(k => rows.find(x => x.key === k && x.current)))) first.set(keyOf(r), nameOf(r));
  const got = all(p.tree(), n => hasClass(n, 'sx-clubhead') || (hasClass(n, 'sx-rowli') && /Overview ›/.test(text(n))))
    .map(h => text(all(h, x => hasClass(x, 'sx-name'))[0]).replace(/ · born .*$/, ''));
  assert.equal(got.length, 8, 'at most 8 clubs at first (Q2)');
  assert.deepEqual(got, [...first.values()].slice(0, 8).map(String), 'first-appearance order');
  // a family: PDA's clubs are one group named for the family
  const q = page(); await q.run('PDA');
  const fam = slateOf('PDA').sections[0].rows;
  assert.ok(new Set(fam.map(r => r.clubID)).size > 1 && fam.every(r => r.family && r.family.name === 'PDA'), 'precondition: several clubs, one family');
  const hs = all(q.tree(), n => hasClass(n, 'sx-clubhead'));
  assert.equal(hs.length, 1);
  assert.equal(text(all(hs[0], n => hasClass(n, 'sx-name'))[0]), 'PDA');
  // one line per team name: Slammers has two, and club 1656 (no live team) one "Earlier lines" row
  const sl = page(); await sl.run('Slammers');
  const lines = all(sl.tree(), n => hasClass(n, 'sx-chipline')).map(n => text(all(n, x => roleOf(x) === 'rowheader')[0]).trim());
  assert.deepEqual(lines, ['SLAMMERS FC', 'Slammers FC HB Koge', 'Earlier lines']);
  assert.equal(all(sl.tree(), n => hasClass(n, 'sx-clubhead')).length, 2, 'two clubs');
});

test('Q2, DOM cap: 8 clubs and 6 events at first; "Show all" grows a section in place, then 50 at a time; the DOM stays bounded', async () => {
  const p = page(); await p.run('so');
  const clubsIn = () => all(p.tree(), n => hasClass(n, 'sx-clubhead') || (hasClass(n, 'sx-rowli') && /Overview ›/.test(text(n)))).length;
  assert.equal(clubsIn(), 8);
  const evIn = () => all(p.tree(), n => (hasClass(n, 'sx-rowli') || hasClass(n, 'sx-grp')) && !/Overview ›/.test(text(n))).length;
  assert.equal(evIn(), 6);
  const more = p.cells().findIndex(c => c.kind === 'more' && c.section === 'teams');
  assert.match(p.cells()[more].text, /^Show all 492 teams · 38 clubs$/);
  const before = p.cells().length;
  p.sxActivate(more);
  assert.equal(clubsIn(), 38, 'all 38 clubs fit in one page of 50');
  assert.ok(!p.cells().some(c => c.kind === 'more' && c.section === 'teams'));
  assert.equal(p.state().sxActive, more, 'the first new cell is active, so the keys go on from where they were');
  assert.ok(p.cells().length > before);
  const ev = p.cells().findIndex(c => c.kind === 'more' && c.section === 'events');
  assert.match(p.cells()[ev].text, /^Show all 14 events$/);
  p.sxActivate(ev); assert.equal(evIn(), 14);
  // 50 at a time: fc has 51 clubs: 8, then 50, then "Show 1 more club"
  const f = page(); await f.run('fc');
  const m1 = f.cells().findIndex(c => c.kind === 'more');
  assert.match(f.cells()[m1].text, /^Show all 578 teams · 51 clubs$/);
  f.sxActivate(m1);
  const m2 = f.cells().findIndex(c => c.kind === 'more');
  assert.equal(f.cells()[m2].text, 'Show 1 more club · 1 left');
  f.sxActivate(m2);
  assert.ok(!f.cells().some(c => c.kind === 'more'));
  // the cap per keystroke: at most 8 clubs and 6 events are drawn, whatever the match count
  const g = page(); await g.open('');
  let max = 0, maxAt = '';
  for (const q of judgedKeystrokes()) { g.input.value = q; g.sxRun(q); if (g.cells().length > max) { max = g.cells().length; maxAt = q; } }
  assert.ok(max <= 240, `${max} cells at "${maxAt}"`);
});

test('R2, R3: ended teams fold into "+n ended"; a predecessor folds into its live successor with a gold dot and is counted as "may continue"', async () => {
  const p = page(); await p.run('pateadors');
  const s = slateOf('pateadors'), rows = s.sections[0].rows;
  const folded = rows.filter(r => !r.current && !r.seasonTyped && r.continuesAs.some(k => rows.find(x => x.key === k && x.current)));
  assert.ok(folded.length > 0, 'precondition: some ended teams may continue as a team in the list');
  const t = p.tree();
  const meta = text(all(t, n => hasClass(n, 'sx-meta'))[0]);
  const live = rows.filter(r => r.current).length, ended = rows.length - live - folded.length;
  assert.equal(meta.includes(`${live} current`), true, meta);
  assert.equal(meta.includes(`${ended} ended`), true, meta);
  assert.equal(meta.includes(`${folded.length} may continue`), true, meta);
  const dots = all(t, n => roleOf(n) === 'gridcell' && hasClass(n, 'may'));
  assert.ok(dots.length > 0, 'the gold dot');
  for (const d of dots) assert.match(d.attrs['aria-label'], /may continue here/);
  assert.ok(!p.cells().some(c => c.team && folded.some(f => f.key === c.team.key)), 'a folded predecessor is not drawn as a chip');
  // its action bar says so and links to the earlier team
  const target = p.cells().findIndex(c => c.team && c.team.sxMay && c.team.sxMay.length);
  assert.ok(target >= 0);
  for (let k = 0; p.state().sxActive !== target && k < 40; k++) p.key('ArrowDown');
  assert.equal(p.state().sxActive, target);
  const bar = p.bar();
  assert.match(bar.text, /May continue here: \d{4}-\d{2} team, born \d{4}/);
  assert.equal(bar.prev.hidden, false);
  assert.equal(bar.prev.href, p.cells()[target].team.sxMay[0].overviewHref);
  assert.match(bar.cls, /us-two/);
});

test('R2, R4: a team named by a season never folds; the slate\'s enter is always a visible cell, its fold opens', async () => {
  const p = page(); await p.run('pateadores 2022-23');
  const s = slateOf('pateadores 2022-23');
  assert.ok(s.best && s.best.seasonTyped);
  assert.ok(!p.cells().some(c => c.kind === 'toggle'), 'nothing folds when the query names a season');
  assert.ok(all(p.tree(), n => roleOf(n) === 'rowgroup' && n.attrs['aria-label'] === 'Best match').length === 1);
  assert.equal(p.activeCell().team.key, s.enter.key);
  assert.match(p.bar().hist.textContent, /2022–23 season/, 'the season link');
  assert.equal(p.bar().hist.href, s.enter.seasonHref);
  // R4: every judged keystroke whose enter is an ended team shows it
  const q = page(); await q.open('');
  let n = 0;
  for (const k of judgedKeystrokes().filter(x => x.trim().length >= 2)) {
    const sl = slateOf(k), e = sl.enter;
    if (!e || e.kind !== 'team' || e.current || e.seasonTyped) continue;
    q.input.value = k; q.sxRun(k);
    const a = q.activeCell();
    assert.ok(a && a.team && (a.team.key === e.key || (e.continuesAs || []).includes(a.team.key)), `${k}: the active cell is the slate's enter (or its successor)`);
    assert.ok(q.stubs.document.getElementById(`sx-c-${q.state().sxActive}`), `${k}: and it is drawn`);
    n++;
  }
  assert.ok(n >= 5, `${n} keystrokes whose enter is an ended team`);
});

test('R4, keys: Enter on "+n ended" opens and closes the fold; the fold that held the enter can be closed again', async () => {
  const p = page(); await p.run('Surf');
  const before = p.cells().length;
  p.key('ArrowDown'); p.key('ArrowUp'); p.key('End');
  const t = p.activeCell();
  assert.equal(t.kind, 'toggle');
  assert.match(p.keysLine(), /Enter/);
  assert.equal(p.bar().hidden, true, 'a fold has no link: no action bar');
  p.key('Enter');
  assert.ok(p.cells().length > before, 'the ended chips appear');
  assert.equal(p.activeCell().kind, 'toggle', 'the toggle stays active');
  assert.equal(p.activeCell().open, true);
  const lbl = p.stubs.document.getElementById(`sx-c-${p.state().sxActive}`).getAttribute('aria-expanded');
  assert.equal(lbl, 'true');
  p.key('Enter');
  assert.equal(p.cells().length, before);
  // the fold R4 opened for an ended enter: Enter closes it, Enter again opens it
  const q = page(); await q.run('Midwest United');
  const e = slateOf('Midwest United').enter;
  assert.equal(q.activeCell().team.key, e.key);
  const toggles = q.cells().filter(c => c.kind === 'toggle');
  assert.ok(toggles.some(c => c.open), 'R4 opened the fold holding the enter');
});

test('keys: Up/Down move by row to the nearest column; Left/Right/Home/End only after a vertical move; Enter opens the slate\'s enter', async () => {
  const p = page(); await p.run('southwest');
  const s = slateOf('southwest');
  assert.equal(p.activeCell().href, s.enter.href, 'Enter opens the slate\'s enter: the best match\'s first chip');
  assert.equal(p.activeCell().col, 0);
  const r = p.key('ArrowRight');
  assert.ok(!r.prevented, 'Right is the text caret\'s until the viewer moves down');
  assert.equal(p.state().sxActive, 0);
  p.key('ArrowDown');
  assert.equal(p.activeCell().ev.season, '2025-26');
  assert.equal(p.activeCell().col, 0);
  p.key('ArrowRight'); p.key('ArrowRight'); p.key('ArrowRight');
  assert.equal(p.activeCell().col, 3);
  const ev = p.activeCell();
  assert.equal(ev.ev.ages[3], 'G2011', 'the 2025-26 "2011" chip');
  assert.equal(ev.href, '#season=2025-26&age=G2011&conf=Southwest&view=standings');
  const b = p.bar();
  assert.equal(b.text, 'Southwest 2011 · 2025–26 standings');
  assert.equal(b.open.textContent, 'Open standings'); assert.equal(b.open.href, ev.href);
  assert.equal(b.hist.hidden, true);
  p.key('ArrowDown');
  assert.equal(p.activeCell().col, 3, 'the nearest column is kept');
  p.key('End'); assert.equal(p.activeCell().col, 5);
  p.key('Home'); assert.equal(p.activeCell().col, 0);
  for (let i = 0; i < 20; i++) p.key('ArrowUp');   // wraps around
  assert.ok(p.activeCell());
  p.key('ArrowDown'); p.key('ArrowDown');
  p.key('Enter'); assert.ok(/^#season=.*&view=standings$/.test(p.location.hash), p.location.hash);
  assert.equal(p.pop().hidden, true, 'opening closes the panel');
  assert.equal(p.input.value, '', 'and clears the box');
});

test('#148: southwest is a best match with the 2026-27 chips, then one row per earlier season with that season\'s own divisions; every chip link is a real table', async () => {
  const p = page(); await p.run('southwest');
  const s = slateOf('southwest'), rows = s.sections[0].rows;
  assert.equal(rows.length, 7);
  const t = p.tree();
  assert.equal(all(t, n => hasClass(n, 'sx-best')).length, 1);
  const chipRows = all(t, n => hasClass(n, 'sx-grp'));
  assert.equal(chipRows.length, 7, 'the best match plus 6 season rows');
  const fx = loadFixtures(), ix = indexOf(fx.directory, fx.sources);
  chipRows.forEach((row, k) => {
    const r = rows[k], chips = all(row, n => roleOf(n) === 'gridcell');
    assert.deepEqual(chips.map(c => text(c)), r.ages.map(a => a.replace(/^G/, '').replace(/^U(\d+)\/U(\d+)/, 'U$1/$2').replace(/^(\d{4})\/(\d{2})(\d{2})$/, '$1/$3')), r.season);
    const cs = p.cells().filter(c => c.ev && c.ev.eventID === r.eventID);
    assert.deepEqual(cs.map(c => c.href), r.hrefs, 'R11: a chip opens row.hrefs[k]');
    for (const h of r.hrefs) assert.equal(destinationProblem(h, ix), null, h);
  });
  const names = chipRows.map(row => text(all(row, n => hasClass(n, 'sx-pill'))[0]));
  assert.deepEqual(names, rows.map(r => r.season.replace('-', '–')));
  const born = all(t, n => roleOf(n) === 'gridcell' && /\(born 2011\)/.test(n.attrs['aria-label'] || ''));
  assert.ok(born.length >= 2, 'a birth-year division says "born 2011" to a screen reader (Q8)');
  assert.ok(chipRows.some(row => /U18\/19 Composite/.test(text(row))), '2020-21 names a Composite division');
  // the DOM's chip links equal row.hrefs
  assert.equal(p.cells().filter(c => c.ev).length, rows.reduce((n, r) => n + r.hrefs.length, 0));
  // NorCal (C02)
  const n = page(); await n.run('NorCal');
  const ns = slateOf('NorCal');
  assert.equal(all(n.tree(), n2 => hasClass(n2, 'sx-grp')).length, Math.min(7, ns.sections[0].rows.length));
});

test('#146 moved here: U15 NorCal opens the GU15 standings on Enter, Shift+Enter and a click, on the desktop and the phone sheet', async () => {
  const want = '#season=2026-27&age=GU15&conf=NorCal&view=standings';
  for (const sheet of [false, true]) for (const how of ['enter', 'shift', 'click']) {
    const p = page({ sheet }); await p.run('U15 NorCal');
    const s = slateOf('U15 NorCal');
    assert.equal(s.sections[0].name, 'events');
    assert.equal(p.activeCell().href, want);
    assert.equal(p.bar().hist.hidden, true);
    assert.equal(p.bar().open.textContent, 'Open standings');
    if (how === 'enter') p.key('Enter'); else if (how === 'shift') p.key('Enter', { shiftKey: true }); else p.click(p.state().sxActive);
    assert.equal(p.location.hash, want, `${sheet ? 'sheet' : 'desktop'} ${how}`);
    assert.equal(p.pop().hidden, true);
  }
  const p = page({ sheet: true }); await p.run('U15 NorCal');
  p.key('ArrowDown');
  assert.equal(p.activeCell().kind, 'team', 'a team selection restores the team actions');
  assert.equal(p.bar().hist.hidden, false); assert.equal(p.bar().open.textContent, 'Overview');
});

test('keys and clicks: Enter and a click open the cell\'s link, Shift+Enter a team\'s season tab, Ctrl-click a new tab; a link to the page shown re-fires the route', async () => {
  const p = page(); await p.run('Slammers');
  const c = p.activeCell(), r = c.team;
  p.key('Enter'); assert.equal(p.location.hash, r.href);
  const q = page(); await q.run('Slammers');
  const qt = q.activeCell().team;
  q.key('Enter', { shiftKey: true }); assert.equal(q.location.hash, qt.seasonHref);
  assert.notEqual(qt.seasonHref, qt.overviewHref);
  const w = page(); await w.run('Slammers');
  w.click(w.state().sxActive, { ctrlKey: true }); assert.deepEqual(w.opened[0], [w.activeCell().href, '_blank', 'noopener']);
  assert.equal(w.location.hash, '', 'Ctrl-click does not navigate here');
  const h = page(); await h.run('Slammers'); h.location.hash = h.activeCell().href; h.key('Enter');
  assert.equal(h.hashEvents.length, 1, 'the same hash fires hashchange itself');
  // an event: Shift+Enter does what Enter does
  const e = page(); await e.run('San Diego Fall');
  const ec = e.activeCell(); assert.ok(ec.ev);   // read before the panel closes
  e.key('Enter', { shiftKey: true }); assert.equal(e.location.hash, ec.href);
  // the action bar's links close the panel and navigate
  const b = page(); await b.run('Slammers');
  const ev = { ctrlKey: false, metaKey: false, shiftKey: false, button: 0, preventDefault() { ev.prevented = true; }, currentTarget: { getAttribute: () => '#x=1' } };
  b.el('usearchOpen').on.click(ev);
  assert.equal(b.location.hash, '#x=1'); assert.ok(ev.prevented);
});

test('keys: Esc clears the text, then closes; Tab goes to the bar\'s links on the desktop and out of the popover; the sheet keeps Tab', async () => {
  const p = page(); await p.run('Surf');
  p.input.value = 'Surf';
  const e1 = p.key('Escape');
  assert.equal(p.input.value, ''); assert.equal(p.pop().hidden, false);
  assert.match(p.status(), /Teams and events since 2020-21/, 'the tips state');
  p.key('Escape'); assert.equal(p.pop().hidden, true);
  assert.ok(e1.prevented);
  const q = page(); await q.run('Surf');
  const t = q.key('Tab'); assert.ok(t.prevented, 'Tab moves to the Overview link');
  assert.equal(q.focused && q.focused.id, 'usearchOpen');
  const r = page(); await r.run('zzzz');
  r.key('Tab'); assert.equal(r.pop().hidden, true, 'no active cell: Tab leaves and closes');
  const s = page({ sheet: true }); await s.run('Surf');
  const st = s.key('Tab'); assert.ok(!st.prevented); assert.equal(s.pop().hidden, false, 'the phone sheet is modal: Tab stays');
  assert.equal(s.pop().getAttribute('role'), 'dialog'); assert.equal(s.pop().getAttribute('aria-modal'), 'true');
  assert.equal(page().pop().getAttribute('role'), null);
  s.sxClose(true);
  assert.equal(s.focused && s.focused.id, 'headerSearch', 'Cancel gives focus back to the header button');
});

test('hover: moves the active cell only after a 250 ms rest, never the keys; a key wins over a pending hover', async () => {
  const p = page(); await p.run('Surf');
  const a0 = p.state().sxActive;
  p.sxHoverCell(3); await wait(120); assert.equal(p.state().sxActive, a0, 'not yet');
  await wait(220); assert.equal(p.state().sxActive, 3, 'after the rest');
  assert.equal(p.nav(), false, 'a hover is not a vertical move: Left and Right stay the caret\'s');
  const r = p.key('ArrowRight'); assert.ok(!r.prevented);
  p.sxHoverCell(5); p.key('ArrowDown'); await wait(300);
  assert.notEqual(p.state().sxActive, 5, 'a key cancelled the pending hover');
  const q = page(); await q.run('Surf');
  const el = i => ({ dataset: { c: String(i) } });
  q.el('usearchList').on.pointerover({ pointerType: 'touch', target: { closest: () => el(2) } }); await wait(300);
  assert.equal(q.state().sxActive, 0, 'never on touch');
  assert.equal(q.el('usearchList').scrolled, undefined);
});

test('R6: Nearby is a pill on a nearby club or event only, with one sub-heading per section (Redmond WA)', async () => {
  const p = page(); await p.run('Redmond WA');
  const s = slateOf('Redmond WA');
  assert.ok(s.sections[0].rows.every(r => !r.nearby) && s.sections.find(x => x.name === 'teams').rows.every(r => r.nearby), 'precondition: events in Redmond, teams near it');
  const t = p.tree();
  const subs = all(t, n => hasClass(n, 'sx-sub')).map(text);
  assert.deepEqual(subs, ['Near Redmond, WA, in the same county'], 'one sub-heading, before the first nearby row');
  const pills = all(t, n => hasClass(n, 'sx-pill') && hasClass(n, 'near'));
  const teamHeads = all(t, n => hasClass(n, 'sx-clubhead'));
  assert.equal(pills.length, teamHeads.length, 'a pill on each nearby club, none on a direct event');
  assert.ok(pills.length >= 4);
  for (const row of all(t, n => hasClass(n, 'sx-rowli') && /Playoffs/.test(text(n)))) assert.ok(!/Nearby/.test(text(row)), 'an event in Redmond is direct');
  for (const c of all(t, n => roleOf(n) === 'gridcell' && n.attrs['aria-label'] && /nearby/.test(n.attrs['aria-label']))) assert.match(c.attrs['aria-label'], /, nearby$/);
  assert.ok(all(t, n => roleOf(n) === 'gridcell' && /nearby/.test(n.attrs['aria-label'] || '')).length >= 4);
  // a direct place: San Diego's own teams carry no pill; its nearby event does
  const sd = page(); await sd.run('San Diego');
  const st = sd.tree();
  assert.ok(all(st, n => hasClass(n, 'sx-clubhead')).some(h => !/Nearby/.test(text(h))), 'direct clubs have no pill');
  assert.ok(all(st, n => hasClass(n, 'sx-rowli') && /Nearby/.test(text(n))).length >= 1);
});

test('R7: Surf Cup: the lead sentence, a Partial match pill on every row, no best match; a tier-only partial event says why (R10)', async () => {
  const p = page(); await p.run('Surf Cup');
  const s = slateOf('Surf Cup');
  assert.equal(s.empty.reason, 'no-full-match');
  assert.match(p.lead(), /Nothing matches every word of “Surf Cup”\./);
  const t = p.tree();
  assert.equal(all(t, n => hasClass(n, 'sx-best')).length, 0);
  const heads = all(t, n => hasClass(n, 'sx-clubhead')), evs = all(t, n => hasClass(n, 'sx-rowli'));
  assert.ok(heads.length && evs.length);
  for (const r of [...heads, ...evs]) assert.ok(/Partial match/.test(text(r)), text(r).slice(0, 60));
  for (const c of all(t, n => roleOf(n) === 'gridcell' && !('aria-expanded' in n.attrs))) assert.match(c.attrs['aria-label'], /, partial match$/, 'Reviewer point 3');
  assert.ok(evs.every(r => /“cup” in a tier name/.test(text(r))), 'R10');
  assert.match(p.live(), /^Nothing matches every word\. /);
  // a full match has none of it
  const q = page(); await q.run('Surf');
  assert.ok(!/Partial match|partial match|in a tier name|Nothing matches/.test(q.list() + q.lead()));
});

test('R12: zzzz says no team or event matches, and offers examples; a field says games are not in search yet and never "no match"', async () => {
  const z = page(); await z.run('zzzz');
  assert.match(z.lead(), /<h3>No team or event matches “zzzz”<\/h3>/);
  assert.match(z.lead(), /class="us-chip"/);
  assert.match(z.status(), /No results/);
  assert.ok(z.list().includes('Games and fields aren’t in search yet'), 'the Games line');
  assert.equal(z.cells().length, 0);
  assert.equal(z.bar().hidden, true);
  assert.match(z.keysLine(), /^<kbd>Esc<\/kbd> close$/);
  assert.equal(z.input.getAttribute('aria-activedescendant'), null);
  const f = page(); await f.run('Surf Sports Park');
  assert.equal(slateOf('Surf Sports Park').empty.reason, 'games-not-indexed');
  assert.match(f.lead(), /<h3>Games and fields aren’t in search yet<\/h3>/);
  assert.ok(!/No team or event matches “|No results/.test(f.lead() + f.status()), 'never "no match" for a games reading');
  assert.match(f.status(), /No teams or events/);
  // season and age group
  const s = page(); await s.run('U15 NorCal 2030-31');
  assert.match(s.lead(), /No 2030-31 season in this archive/);
  assert.match(s.lead(), /Search covers 2020-21 to 2026-27/);
  const a = page(); await a.run('U12 NorCal');
  assert.match(a.lead(), /No such age group in that season/);
  // tips chips fill the box and run
  z.input.value = ''; z.sxFill('Southwest'); assert.equal(z.input.value, 'Southwest'); assert.match(z.list(), /Southwest/);
});

test('R9 typo: the hint names the word as the line spells it; the typo is marked; the lookup escapes the term (Reviewer point 5)', async () => {
  const p = page(); await p.run('pateadors');
  assert.match(p.status(), /<span class="sx-hint">Matched “Pateadores”<\/span>/);
  assert.match(p.list(), /<mark class="typo">Pateadores<\/mark>/);
  // a regex character in a matched term cannot break the page: the lookup is escaped
  const hostile = { matched: [{ term: 'pate(adores', cls: 'typo', field: 'name' }], namedPlace: null };
  const h = page(); assert.doesNotThrow(() => h.sxMark('Pate(adores FC', hostile));
  assert.equal(h.sxMark('Pate(adores FC', hostile), '<mark class="typo">Pate(adores</mark> FC');
  assert.match(BLOCK, /sxEscRe\(term\)/);
  // the word is found in the club when the team's line does not spell it
  const d = fresh(), t = d.core.teams;
  const k = t.clubs.findIndex(c => c[0] === 186);
  for (const sq of t.squads) if (sq.c === k) for (const r of sq.s) r[2] = 'Reds';
  const pre = S.search(S.buildIndex(d), 'pateadors', CTX).sections[0].rows[0];
  assert.ok(pre.line === 'Reds' && pre.matched.some(m => m.cls === 'typo' && m.field === 'club'), 'precondition: the typo is in the club name, not the line');
  const c = page({ data: () => d }); await c.run('pateadors');
  assert.ok(/Matched “Pateadores”/.test(c.status()), c.status());
});

test('R8: marks are placed on the raw text, each piece escaped on its own; names are rendered as text, never as html', async () => {
  const d = fresh(), t = d.core.teams;
  const payload = '<img src=x onerror=alert(1)> Rovers';
  t.clubs[0][1] = payload;
  for (const sq of t.squads) if (sq.c === 0) for (const r of sq.s) r[2] = payload;
  const p = page({ data: () => d }); await p.run('onerror');
  const out = p.list();
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;') || out.includes('&lt;img src=x <mark>onerror</mark>'), out.slice(0, 300));
  assert.ok(!/<img\b/i.test(out), 'no element made from a name');
  for (const c of all(p.tree(), n => n.attrs && n.attrs['aria-label'])) assert.ok(!/[<>]/.test(c.attrs['aria-label']), 'aria-labels hold no raw brackets');
  const h = page();
  assert.equal(h.sxMark('Tom & Jerry <b>', { matched: [{ term: 'amp', cls: 'exact', field: 'name' }] }), 'Tom &amp; Jerry &lt;b&gt;', 'a term never lands inside an entity');
  assert.equal(h.sxMark('San Diego Surf', { namedPlace: ['san', 'diego'], matched: [{ term: 'surf', cls: 'exact', field: 'name' }] }), '<mark>San Diego</mark> <mark>Surf</mark>');
  assert.equal(h.sxMark('Cup Gold', { matched: [{ term: 'cup', cls: 'exact', field: 'tier' }] }), 'Cup Gold', 'a tier or place match marks nothing in the name');
});

test('Reviewer point 6: a line that matched only through an older name says so ("was Sting Black")', async () => {
  const p = page(); await p.run('Sting Black');
  const t = p.tree();
  const was = all(t, n => hasClass(n, 'sx-was')).map(text);
  assert.ok(was.includes('was Sting Dallas Black'), JSON.stringify(was));
  assert.ok(all(t, n => roleOf(n) === 'gridcell' && /, was Sting/.test(n.attrs['aria-label'] || '')).length > 0, 'and in the cell\'s name');
  const s = slateOf('Sting Black');
  assert.equal(s.best.kind, 'team'); assert.equal(s.best.line, 'Sting Black');
  assert.equal(all(t, n => roleOf(n) === 'rowgroup').length, 1);
});

test('Reviewer points 3, 4: names end with ", partial match" or ", nearby"; a fold\'s name has no "collapsed"; the live region says the plan\'s words', async () => {
  const p = page(); await p.run('Surf');
  assert.equal(p.live(), '83 teams in 7 clubs, no events. Games aren\'t in search yet. Use the arrow keys to choose.');
  for (const c of all(p.tree(), n => roleOf(n) === 'gridcell' && 'aria-expanded' in n.attrs)) {
    assert.ok(!/collapsed|expanded/.test(c.attrs['aria-label']), c.attrs['aria-label']);
    assert.match(c.attrs['aria-label'], /^.+: \d+ ended teams?$/);
  }
  const q = page(); await q.run('southwest');
  assert.equal(q.live(), 'No teams, 7 events. Games aren\'t in search yet. Use the arrow keys to choose.');
  const s = page(); await s.run('Surf Cup');
  assert.equal(s.live().startsWith('Nothing matches every word. '), true);
  assert.match(s.live(), /101 teams in \d+ clubs?, 6 events\./);
  const r = page(); await r.run('Redmond WA');
  assert.match(r.live(), /^24 teams in \d+ clubs, 3 events\./);
  const z = page(); await z.run('zzzz'); assert.equal(z.live(), 'No results for zzzz.');
  const l = page(); l.input.value = 'x'; l.sxOpen(l.input); assert.equal(l.live(), 'Getting search ready');
});

test('the action bar: wraps instead of truncating (always a two-line label), the key line follows the active cell, Shift+Enter only on a team', async () => {
  const p = page(); await p.run('Surf');
  assert.match(p.bar().cls, /us-two/, 'Reviewer point 7: never the one-line truncating label');
  assert.ok(html.includes('.us-actions span.us-two { white-space: normal;'), 'the CSS that lets it wrap');
  assert.ok(html.includes('      .us-actions span.us-two { flex-basis: 100%; }'), 'a full line on the phone');
  assert.match(p.keysLine(), /Shift<\/kbd>\+<kbd>Enter<\/kbd> team’s season/);
  const q = page(); await q.run('southwest');
  assert.ok(!/Shift/.test(q.keysLine()), 'not on an event');
  assert.match(q.bar().text, /standings$/);
  q.key('ArrowDown'); assert.ok(!/Shift/.test(q.keysLine()));
  p.key('ArrowDown'); assert.match(p.keysLine(), /Shift/);
});

test('every judged keystroke draws without error, with a key line, a status and a live region that agree with the slate', async () => {
  const p = page(); await p.open('');
  let drawn = 0;
  for (const k of judgedKeystrokes()) {
    p.input.value = k; p.sxRun(k);
    if (k.trim().length < 2) { assert.match(p.status(), /Teams and events since 2020-21/); continue; }
    const s = slateOf(k);
    if (!s.sections.length) { assert.equal(p.cells().length, 0, k); assert.match(p.status(), /No results|No teams or events/); continue; }
    drawn++;
    const sec = Object.fromEntries(s.sections.map(x => [x.name, x.total]));
    if (sec.teams) assert.ok(p.status().includes(`<strong>${sec.teams} team${sec.teams === 1 ? '' : 's'}</strong>`), k);
    if (sec.events) assert.ok(p.status().includes(`<strong>${sec.events} event${sec.events === 1 ? '' : 's'}</strong>`), k);
    assert.ok(p.cells().length > 0 && p.state().sxActive >= 0, k);
    assert.ok(p.live().includes('Games aren\'t in search yet'), k);
  }
  assert.ok(drawn > 400, `${drawn} drawn`);
});

test('sxRun asks the module with the clock, the league zone and the selected season; a null season is an empty string', async () => {
  const seen = [];
  const mod = { ...S, search: (i, q, c, o) => { seen.push(c); return S.search(i, q, c, o); } };
  const p = page({ mod, season: null }); await p.run('Surf');
  assert.deepEqual(seen[0], { now: NOW, timeZone: 'America/Los_Angeles', selectedSeason: '' });
  const q = page({ mod, season: '2024-25' }); await q.run('Surf');
  assert.equal(seen.at(-1).selectedSeason, '2024-25');
});

test('goHome, the "/" key and the header buttons reach the new panel (the legacy functions are not called from outside the dormant slice)', () => {
  const outside = html.slice(html.indexOf('\n    // ========== DATA FETCH =========='), html.indexOf('let usDb')) + html.slice(html.indexOf(END));
  for (const f of ['usClose(', 'usOpenSheet(', 'usOpen(', 'usRun(']) assert.ok(!outside.includes(f), `${f} outside the dormant slice`);
  assert.match(html, /sxClose\(true\);\n      closeSidebarIfMobile\(\);\n      \/\/ #135 P1a/);
  assert.match(html, /if \(isPhone\(\)\) \{ sxOpenSheet\(\); return; \}/);
  assert.match(html, /id="headerSearch"[^>]*onclick="sxOpenSheet\(\)"/);
  assert.match(html, /class="us-cancel" onclick="sxClose\(true\)"/);
});

test('no request per keystroke: the block makes no fetch but the two search data files, and no event handler fetches', () => {
  assert.equal((BLOCK.match(/fetchJSON\(/g) || []).length, 2);
  assert.ok(!/\bfetch\(/.test(BLOCK));
  assert.ok(!/getTeamDirectory/.test(BLOCK), 'search no longer reads /api/v1/teams');
  const code = BLOCK.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/setTimeout\(0\)|setTimeout\(\w+, 0\)/.test(code), 'setTimeout(0) clamps to 4 ms: the yield is scheduler.yield or a MessageChannel');
  assert.match(BLOCK, /scheduler\.yield/); assert.match(BLOCK, /new MessageChannel\(\)/);
});

test('the grid\'s CSS: chips are at least 28 px (36 px on the phone), the legacy list rules stay for the dormant code', () => {
  assert.match(html, /\.sx-chip \{[^}]*height: 28px/);
  assert.match(html, /@media \(max-width: 768px\) \{\s*\.sx-grp, \.sx-row \{[^}]*\}\s*\.sx-chip \{ height: 36px/);
  assert.ok(!/\.usearch-pop\.sx \{ display/.test(html), 'a rule that would beat [hidden]');
  assert.match(html, /\.usearch-pop\[hidden\] \{ display: none; \}/);
});
