// #165 (#149 phase 1, PR 4a), #148: the search panel. The page's own block (public/index.html, from
// "// ===== #165: the search panel" to the form chips' tooltip) is extracted and run in a small fake DOM
// on an index built, by the real modules (public/search), from the frozen search data
// (tests/search/fixtures/search). (The legacy panel was removed by #172.) What a browser adds
// (focus, layout, the phone sheet's trap, real requests) is tests/e2e/search-panel.e2e.mjs.
// Every expectation comes from the slate, the fixture or a stated page rule (R1-R12, at the top of the
// block), never from the code under test. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/search-panel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readJSON, readLF, HERE, ROOT, FIXTURES, indexOf, destinationProblem, loadFixtures, loadGames, todayOf } from './search/judged.mjs';

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
const TODAY = todayOf(NOW, doc.context.timeZone);   // the page's todayKey() on the fixture's clock
const CTX = { now: NOW, timeZone: doc.context.timeZone, selectedSeason: SEASON, today: TODAY };
const BUILT = S.buildIndex(fresh());
{ const g = S.startGames(BUILT, loadGames(BUILT.vocab.active), Infinity); while (!g.next().done); }   // as the page has it once games are ready
const slateOf = q => S.search(BUILT, q, CTX);
// the page's own helpers the block calls (displayName for a game's sides), sliced from index.html
const pageFn = head => { const a = html.indexOf('\n' + head) + 1, b = html.indexOf('\n    }\n', a) + 6; assert.ok(a > 0 && b > a, head); return html.slice(a, b); };
const { displayName } = new Function(pageFn('    function shortTeamName(') + pageFn('    function displayName(') + 'return { displayName };')();
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
function page({ sheet = false, live = false, mod = S, data = fresh, fetchJSON, season = SEASON, importMs = 0, saveData = false, games = s => loadGames(s), gamesGate = null, frames = 'auto' } = {}) {
  const tasksQ = [];   // #167: with api.manualTasks, a MessageChannel task waits for task()
  const els = new Map(), listeners = [], opened = [], appended = [], fetched = [], rafs = [];
  const node = id => ({
    id, hidden: false, value: '', textContent: '', className: '', attrs: {}, style: {}, on: {}, _html: '', dataset: {}, sets: 0, appends: 0, lives: [],
    addEventListener(k, f) { this.on[k] = f; },
    get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; this.sets++; },
    insertAdjacentHTML(where, h) { assert.equal(where, 'beforeend', 'the painter appends'); this._html += h; this.appends++; },   // #167
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
    // a node keeps what the block set on it until the list is drawn anew (innerHTML); an append keeps it (#167)
    const gen = el('usearchList').sets;
    if (!cellAttrs.has(id) || cellAttrs.get(id) !== gen) { n.attrs = Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(x => [x[1], x[2]])); cellAttrs.set(id, gen); }
    return n;
  };
  const location = { hash: '' };
  const hashEvents = [], replaced = [];
  const history = { replaceState: (st, t, url) => { replaced.push(url); location.hash = url; } };   // #168 nit 7
  const head = { appendChild: n => appended.push(n) };
  const stubs = {
    document: { getElementById, addEventListener() {}, createElement: tag => ({ tag }), head, querySelector: () => null },
    window: { location, innerWidth: sheet ? 390 : 1400, innerHeight: 900, dispatchEvent: e => hashEvents.push(e), addEventListener: (k, f) => listeners.push([k, f]), open: (...a) => opened.push(a) },
    navigator: { connection: saveData ? { saveData: true } : undefined },
    location, history, HashChangeEvent: class { constructor(t) { this.type = t; } },
    esc, isPhone: () => sheet, LIVE: live, NO_CLUB: 7, currentSeason: season, sessionBackAt: 0,
    teamSeasonTabLabel: seasonLabel, closeSidebarIfMobile() { api.sidebarClosed = (api.sidebarClosed || 0) + 1; },
    retryText: e => (e && e.status === 429 ? 'Too many requests.' : 'Please try again shortly.'),
    isMissing: e => !!e && e.status === 404, isRefusal: e => !!e && e.status >= 400 && e.status < 500 && e.status !== 404,
    fetchJSON: fetchJSON || (async path => {
      fetched.push(path);
      const m = /^search\/games\/(.+)$/.exec(path);
      if (m) { if (gamesGate) await gamesGate(m[1]); return games(m[1]); }   // #168: a games file, from the fixture
      const d = data(); return path === 'search/core' ? d.core : d.places;
    }),
    Date: class extends Date { static now() { return NOW; } }, todayKey: () => TODAY, displayName,
    requestIdleCallback: undefined,
    requestAnimationFrame: f => { if (frames === 'auto') setTimeout(f, 0); else rafs.push(f); },   // #167: a frame (manual: frame())
    setTimeout: (f, ms) => setTimeout(f, ms),
    MessageChannel: class {   // a real one, unless the test runs the tasks itself (task())
      constructor() {
        if (!api.manualTasks) return new MessageChannel();
        const p1 = { onmessage: null, close() {} };
        this.port1 = p1; this.port2 = { postMessage: () => tasksQ.push(() => p1.onmessage && p1.onmessage({})) };
      }
    },
  };
  const names = Object.keys(stubs);
  const api = new Function(...names, `${BLOCK}
    sxImport = async () => { if (arguments[${names.length}] ) await arguments[${names.length}](); return arguments[${names.length + 1}]; };
    return { sxOpen, sxOpenSheet, sxClose, sxRun, sxKey, sxDrive, sxLoad, sxPreload, sxFill, sxHoverCell, sxActivate, sxGoTo, sxMark, sxGroups, SX_MODULES, SX_TASK_MS, SX_SIZES,
      sxBuild, sxGamesFetch, SX_GAMES_STILL_MS, sxResultsBody, sxFlush, sxStats, SX_FIRST_CELLS, sxRefresh, sxCtx, sxWarmUp,
      sxRunRaw: sxRun, sxRun: q => { sxRun(q); sxFlush(); },   // #167: tests see the settled panel unless they ask for the parts (sxRunRaw)
      state: () => ({ sxState, sxView, sxActive, sxLoadP, sxIndex, sxG, sxPaint, sxWarmed, sxTyped, sxMod }), setImport: f => { sxImport = f; } };`)(...Object.values(stubs), importMs ? () => wait(importMs) : null, mod);
  const input = el(sheet ? 'usearchSheetInput' : 'usearchInput');
  const key = (k, extra = {}) => { const e = { key: k, shiftKey: false, preventDefault() { e.prevented = true; }, target: input, ...extra }; input.on.keydown(e); return e; };
  // #168: open waits for the active season's games too (the request "ready" starts), unless told not to
  const gamesIdle = async () => { for (let k = 0; k < 400 && api.state().sxG && (api.state().sxG.running || api.state().sxG.queue.length); k++) await wait(2); };
  const settle = async () => { for (let k = 0; k < 200 && api.state().sxPaint; k++) await wait(1); };
  const open = async (q = '', { games: g = true } = {}) => { input.value = q; api.sxOpen(input); await api.state().sxLoadP; await wait(0); if (g) await gamesIdle(); await settle(); return api; };
  const frame = () => { const f = rafs.splice(0); f.forEach(x => x()); return f.length; };
  const task = () => { const t = tasksQ.shift(); if (t) t(); return !!t; };
  const run = async q => { await open(q); input.value = q; api.sxRun(q); return list(); };
  const list = () => el('usearchList')._html;
  const click = (i, extra = {}) => el('usearchList').on.click({ target: { closest: () => ({ dataset: { c: String(i) } }) }, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });
  const cells = () => api.state().sxView ? api.state().sxView.cells : [];
  const activeCell = () => cells()[api.state().sxActive];
  const tree = () => parse(list());
  return Object.assign(api, { el, input, key, open, run, list, click, cells, activeCell, tree, location, hashEvents, replaced, opened, appended, fetched, listeners, stubs, gamesIdle, settle, frame, rafs, task, tasksQ,
    status: () => el('sxStatus').innerHTML, lead: () => el('sxLead').innerHTML, live: () => el('usearchLive').textContent, bar: () => ({
      hidden: el('usearchActions').hidden, text: el('usearchActive').textContent, cls: el('usearchActive').className, open: el('usearchOpen'), hist: el('usearchHist'), prev: el('usearchPrev') }),
    keysLine: () => el('sxKeys').innerHTML, pop: () => el('usearchPop'), nav: () => api.state().sxView && api.state().sxView.nav });
}

// ---------- the tests ----------
test('index.html keeps one line-ending style, and the panel block is bounded by its marker and the tooltip', () => {
  assert.ok(!/\r\n/.test(rawHtml) || !/[^\r]\n/.test(rawHtml), 'mixed line endings');
  assert.equal(html.split(START).length, 2);
  assert.ok(html.indexOf(START) < html.indexOf(END));
});

// #172 (PR 5): the legacy search is gone from the page, and its CSS with it. The kept .us- classes are named, so a
// failure names the class: each is used by the markup or the panel code, and no other .us- class is in the CSS.
test('#172: the legacy search is gone, and only the 9 kept .us- classes remain in the CSS, each used outside it', () => {
  assert.ok(!/TEAM_SEARCH|let usDb|usWire|dormant until PR 5/.test(html), 'no legacy marker');
  assert.ok(!/(?<![\w$.])us[A-Z]\w*\(/.test(html), 'no us* function call or declaration');
  assert.ok(!/\bUS_[A-Z_]+\b|usearchStatus|usearchTips|us-opt-/.test(html), 'no legacy constant or id');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')), rest = html.replace(css, '');
  const KEPT = ['us-actions', 'us-cancel', 'us-chip', 'us-foot', 'us-keys', 'us-sheet-head', 'us-sr', 'us-tipsbox', 'us-two'];
  const inCss = [...new Set([...css.matchAll(/(?<![\w-])(us-[a-z0-9-]+)/g)].map(m => m[1]))].sort();
  for (const c of inCss) assert.ok(KEPT.includes(c), `.${c} is in the CSS but is not a kept class (nothing uses it)`);
  for (const c of KEPT) {
    assert.ok(inCss.includes(c), `${c} has CSS`);
    assert.ok(new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(rest), `${c} is used by the markup or the panel code`);
  }
});

test('markup: the combobox opens a grid, the grid is always in the DOM and named, no role=option remains, the labels say events and games', () => {
  assert.match(html, /id="usearchInput"[^>]*aria-haspopup="grid"/);
  assert.match(html, /id="usearchSheetInput"[^>]*aria-haspopup="grid"/);
  assert.match(html, /<ul class="sx-list" id="usearchList" role="grid" aria-label="Search results"><\/ul>/);
  assert.ok(!/role="option"|role="listbox"/.test(BLOCK + html.slice(html.indexOf('<div class="usearch-pop sx"'), html.indexOf('<div class="sidebar-overlay"'))));
  assert.match(html, /id="headerSearch"[^>]*aria-label="Search teams, events and games"/, 'nit 5; #168');
  assert.match(html, /<div class="usearch" id="usearch" role="search" aria-label="Teams, events and games">/);
  assert.equal(html.split('placeholder="Search teams, clubs, places, events, fields…"').length, 3, 'both boxes (#168)');
  assert.match(html, /<span>Teams, events and games since 2020-21<\/span>/);
  for (const f of ['usOpenSheet()', 'usClose(true)']) assert.ok(!html.includes(`onclick="${f}"`), `${f} is not called from the markup`);
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

test('loading: first focus makes exactly 2 fetches (core, places), then (#168, Q5b b) exactly 1 for the active season\'s games after "ready"; none per keystroke, none on the second focus', async () => {
  const p = page();
  let seenAtReady = null;
  const t = setInterval(() => { if (seenAtReady === null && p.state().sxState === 'ready') seenAtReady = [...p.fetched]; }, 0);
  await p.open('');
  clearInterval(t);
  assert.deepEqual(p.fetched, ['search/core', 'search/places', 'search/games/2026-27']);
  assert.ok(!seenAtReady || !seenAtReady.includes('search/games/2026-27') || seenAtReady.indexOf('search/games/2026-27') === 2, 'the games file is asked for after core and places');
  assert.ok(p.state().sxIndex.games.has('2026-27'));
  for (const q of ['Surf', 'Surf C', 'southwest', 'zzzz', 'Surf Sports Park', 'MVLA 2011 vs Mustang 2011', 'Slammers HB Koge 2007 v So Cal Blues 2007']) { p.input.value = q; p.sxRun(q); }
  await wait(p.SX_GAMES_STILL_MS + 50);
  p.sxClose(); await p.open('Surf');
  assert.deepEqual(p.fetched, ['search/core', 'search/places', 'search/games/2026-27'], '0 per keystroke; on-request seasons are never fetched by themselves (MF1)');
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
  let releaseGames; const gamesGate = new Promise(r => { releaseGames = r; });
  const p = page({ mod, gamesGate: () => gamesGate }); p.setImport(async () => { await gate; return mod; });
  p.input.value = 'Surf'; p.sxOpen(p.input);
  assert.match(p.status(), /Getting search ready/);
  assert.match(p.lead(), /sx-bar/); assert.match(p.lead(), /us-chip/); assert.match(p.lead(), /sx-skel/);
  assert.equal(p.pop().hidden, false);
  p.input.on.input(); await wait(100);   // the 60 ms debounce passes, still loading: nothing runs
  assert.equal(searches, 0);
  release(); await p.state().sxLoadP; await wait(0); await p.settle();
  assert.equal(searches, 1, 'the typed query ran once, when ready');
  assert.match(p.list(), /Surf/);
  assert.match(p.list(), /Loading 2026–27 games…<\/strong> Teams and events are ready; games join them in a moment\./, '#168: the Games section says its games are loading');
  releaseGames(); await p.gamesIdle(); await wait(0);
  assert.equal(searches, 2, '#168: the query runs once more when its games land');
  assert.ok(!/Loading 2026–27 games/.test(p.list()) && /sxg-row/.test(p.list()));
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
  const mod = { ...S, SEARCH_API: 4, search: () => { searches++; }, startIndex: () => { started++; } };
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
  assert.match(BLOCK, /const SX_API_EXPECTED = 3;/);
  assert.equal(S.SEARCH_API, 3);
  const old = page({ mod: { ...S, SEARCH_API: 2 } }); await old.open('Surf').catch(() => { });
  assert.match(old.lead(), /Search was updated while this page was open/, 'a 4a module (SEARCH_API 2) is refused too');
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
    if (!s.sections.length) { assert.equal(p.list(), '', q); continue; }
    const want = [];
    if (s.best) want.push('Best match');
    const order = s.sections.map(x => x.name);
    if (!order.includes('games')) order.splice(s.rule === 3 ? 0 : order.length, 0, 'games');   // G1: its coverage lines, when it has some
    for (const name of order) {
      const sec = s.sections.find(x => x.name === name);
      if (name === 'games') { if (sec || /role="rowheader">Games/.test(p.list())) want.push('Games'); continue; }
      const n = s.best ? sec.rows.filter(r => (s.best.kind === 'team' ? r.key !== s.best.key : r.eventID !== s.best.eventID)).length : sec.rows.length;
      if (n) want.push(sec.name === 'teams' ? (s.best ? 'More teams' : 'Teams') : (s.best ? 'More events' : 'Events'));
    }
    assert.deepEqual(headings(p).map(h => h.replace(/\s(\d|no ).*$/, '').replace(/\s+\d+$/, '')), want, q);
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
    const sl = slateOf(q), noActive = !sl.enter && (sl.rule === 3 || (sl.sections[0] && sl.sections[0].name === 'games'));
    if (noActive) assert.equal(ad, null, `${q}: Games leads (or a games query waits) with no enter: no active cell until a key (#168)`);
    else if (p.cells().length) { assert.ok(ad && ids.has(ad), `${q}: aria-activedescendant names a cell of the grid`); assert.equal(all(t, x => x.attrs['aria-selected'] === 'true').length, 0, 'the drawn html has none selected: the block sets it on the element'); }
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
  const evIn = () => all(p.tree(), n => (hasClass(n, 'sx-rowli') || hasClass(n, 'sx-grp')) && !/Overview ›/.test(text(n)) && !all(n, x => hasClass(x, 'sxg-row') || hasClass(x, 'sxg-field')).length).length;
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
  const teamsMore = c => c.kind === 'more' && c.section === 'teams';   // #168: Games has its own "Show all"
  const m1 = f.cells().findIndex(teamsMore);
  assert.match(f.cells()[m1].text, /^Show all 578 teams · 51 clubs$/);
  f.sxActivate(m1);
  // MF2 (review of #166): the first new cell is active, not the "Show 1 more club" cell at the bottom
  const rowsFc = slateOf('fc').sections[0].rows, keyOf = r => (r.family ? `f:${r.family.name}` : r.clubID === 7 ? `t:${r.line}` : `c:${r.clubID}`);
  const ninth = [...new Set(rowsFc.filter(r => !( !r.current && r.continuesAs.some(k => rowsFc.find(x => x.key === k && x.current)))).map(keyOf))][8];
  assert.equal(f.state().sxActive, m1, 'the active cell is where the "more" cell was');
  assert.equal(keyOf(f.activeCell().team), ninth, "the 9th club's first cell");
  assert.notEqual(f.activeCell().kind, 'more');
  const m2 = f.cells().findIndex(teamsMore);
  assert.equal(f.cells()[m2].text, 'Show 1 more club · 1 left');
  f.sxActivate(m2);
  assert.ok(!f.cells().some(teamsMore));
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

test('MF1 (review of #166): a team that two earlier teams may continue names both in the bar, and the label is never clamped', async () => {
  const p = page(); await p.run('Slammers');
  for (let k = 0; k < 40 && !(p.activeCell().team && (p.activeCell().team.sxMay || []).length === 2); k++) { p.key('ArrowDown'); p.key('ArrowRight'); }
  const c = p.activeCell();
  assert.equal(c.team.sxMay.length, 2, 'precondition: a cell with two predecessors');
  const b = p.bar();
  assert.equal((b.text.match(/\d{4}-\d{2} team, born \d{4}/g) || []).length, 2, b.text);
  assert.match(b.text, /May continue here: 2025-26 team, born 2009; 2025-26 team, born 2010$/);
  assert.match(b.cls, /us-two/);
  assert.ok(html.includes('.usearch-pop.sx .us-actions span.us-two { display: block; -webkit-line-clamp: unset; overflow: visible;'), 'no line clamp in the new panel');
});

test('R3 fallback: a slate whose enter is a team folded into its successor opens on the successor', async () => {
  const real = slateOf('pateadors'), rows = real.sections[0].rows;
  const pred = rows.find(r => !r.current && r.continuesAs.some(k => rows.find(x => x.key === k && x.current)));
  assert.ok(pred, 'precondition: an ended team that may continue as a listed live team');
  const mod = { ...S, search: () => ({ ...real, best: null, enter: pred }) };
  const p = page({ mod }); await p.run('pateadors');
  assert.ok(p.activeCell() && p.activeCell().team && pred.continuesAs.includes(p.activeCell().team.key), 'the successor is active');
  assert.ok(!p.cells().some(c => c.team && c.team.key === pred.key), 'the folded team has no cell of its own');
});

test('closing the panel clears aria-activedescendant, and expanded', async () => {
  const p = page(); await p.run('Surf');
  assert.ok(p.input.getAttribute('aria-activedescendant'));
  p.sxClose();
  assert.equal(p.input.getAttribute('aria-activedescendant'), null);
  assert.equal(p.input.getAttribute('aria-expanded'), 'false');
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
  for (let i = 0; i < 40 && !p.activeCell().ev; i++) p.key('ArrowDown');
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
  assert.deepEqual(subs, ['Near Redmond, WA, in the same county', 'Near Redmond, WA, in the same county'], 'one sub-heading per section (#168: Games, then Teams), before its first nearby row');
  const teamHeads = all(t, n => hasClass(n, 'sx-clubhead'));
  const pills = teamHeads.flatMap(h => all(h, n => hasClass(n, 'sx-pill') && hasClass(n, 'near')));
  assert.equal(pills.length, teamHeads.length, 'a pill on each nearby club, none on a direct event');
  const fieldRows = all(t, n => roleOf(n) === 'gridcell' && hasClass(n, 'sxg-field'));
  assert.ok(fieldRows.length, 'Redmond WA lists fields');
  for (const n of fieldRows) assert.equal(/Nearby/.test(text(n)), /, nearby$/.test(n.attrs['aria-label']), '#168: a field\'s pill and its name agree');
  assert.ok(fieldRows.some(n => !/Nearby/.test(text(n)) && /Redmond, WA/.test(text(n))), 'a field in Redmond itself has no pill');
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

test('R12: zzzz says no team or event matches, and offers examples; a field is never "no match" (#168: it is a result)', async () => {
  const z = page(); await z.run('zzzz');
  assert.match(z.lead(), /<h3>No team or event matches “zzzz”<\/h3>/);
  assert.match(z.lead(), /class="us-chip"/);
  assert.match(z.status(), /No results/);
  assert.equal(z.list(), '', '#168: the old "Games aren\'t in search yet" line is gone');
  assert.equal(z.cells().length, 0);
  assert.equal(z.bar().hidden, true);
  assert.match(z.keysLine(), /^<kbd>Esc<\/kbd> close$/);
  assert.equal(z.input.getAttribute('aria-activedescendant'), null);
  const f = page(); await f.run('Surf Sports Park');
  assert.equal(slateOf('Surf Sports Park').empty, null);
  assert.ok(!/No team or event matches “|No results/.test(f.lead() + f.status()), 'never "no match" for a games reading');
  assert.match(f.status(), new RegExp(`<strong>${slateOf('Surf Sports Park').sections[0].rows[0].count} games</strong>`), 'a field query counts its field\'s games');
  assert.ok(!/games-not-indexed|aren’t in search yet/.test(BLOCK), 'the not-indexed words are gone');
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
  const ng = slateOf('Surf').sections.find(x => x.name === 'games').rows.length;
  assert.equal(p.live(), `83 teams in 7 clubs, no events. ${ng} games. Use the arrow keys to choose.`, '#168 G11: the games count');
  for (const c of all(p.tree(), n => roleOf(n) === 'gridcell' && 'aria-expanded' in n.attrs)) {
    assert.ok(!/collapsed|expanded/.test(c.attrs['aria-label']), c.attrs['aria-label']);
    assert.match(c.attrs['aria-label'], /^.+: \d+ ended teams?$/);
  }
  const q = page(); await q.run('southwest');
  assert.equal(q.live(), `No teams, 7 events. ${slateOf('southwest').sections.find(x => x.name === 'games').rows.length} games. Use the arrow keys to choose.`);
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
    if (!s.sections.length) { assert.equal(p.cells().length, 0, k); assert.match(p.status(), /No results/); continue; }
    drawn++;
    const sec = Object.fromEntries(s.sections.map(x => [x.name, x.total]));
    if (sec.teams) assert.ok(p.status().includes(`<strong>${sec.teams} team${sec.teams === 1 ? '' : 's'}</strong>`), k);
    if (sec.events) assert.ok(p.status().includes(`<strong>${sec.events} event${sec.events === 1 ? '' : 's'}</strong>`), k);
    const noActive = !s.enter && (s.rule === 3 || s.sections[0].name === 'games');
    assert.ok(p.cells().length > 0 && (p.state().sxActive >= 0 || noActive), k);
    assert.ok(p.live().endsWith('Use the arrow keys to choose.'), k);
    const g = s.sections.find(x => x.name === 'games'), f = g ? g.rows.filter(r => r.kind === 'field') : [];
    if (f.length > 1) assert.ok(p.status().includes(`<strong>${f.length} fields</strong>`), `${k}: G11 a place counts its fields`);
    else if (f.length === 1) assert.equal(p.status().includes(`<strong>${f[0].count} game${f[0].count === 1 ? '' : 's'}</strong>`), f[0].count > 0, `${k}: G11 a field's games`);
    else if (g && g.rows.some(r => r.kind === 'game')) assert.ok(p.status().includes(' game') && /\d+ games?\./.test(p.live()), `${k}: G11 games`);
  }
  assert.ok(drawn > 400, `${drawn} drawn`);
});

test('sxRun asks the module with the clock, the league zone and the selected season; a null season is an empty string', async () => {
  const seen = [];
  const mod = { ...S, search: (i, q, c, o) => { seen.push(c); return S.search(i, q, c, o); } };
  const p = page({ mod, season: null }); await p.run('Surf');
  assert.deepEqual(seen[0], { now: NOW, timeZone: 'America/Los_Angeles', selectedSeason: '', today: TODAY, gamesLoading: ['2026-27'], gamesMissing: [], gamesFailed: [] },
    '#168 MF7: today is the page\'s todayKey(); the games the page is loading, missing or failed');
  assert.deepEqual(seen.at(-1).gamesLoading, [], 'once the games are in');
  const q = page({ mod, season: '2024-25' }); await q.run('Surf');
  assert.equal(seen.at(-1).selectedSeason, '2024-25');
});

test('goHome, the "/" key and the header buttons reach the new panel (the legacy functions are not on the page)', () => {
  for (const f of ['usClose(', 'usOpenSheet(', 'usOpen(', 'usRun(']) assert.ok(!html.includes(f), `${f} is not on the page`);
  assert.match(html, /sxClose\(true\);\n      closeSidebarIfMobile\(\);\n      \/\/ #135 P1a/);
  assert.match(html, /if \(isPhone\(\)\) \{ sxOpenSheet\(\); return; \}/);
  assert.match(html, /id="headerSearch"[^>]*onclick="sxOpenSheet\(\)"/);
  assert.match(html, /class="us-cancel" onclick="sxClose\(true\)"/);
});

test('no request per keystroke: the block makes no fetch but the two search data files and (#168) the games loader\'s one, and no event handler fetches', () => {
  assert.equal((BLOCK.match(/fetchJSON\(/g) || []).length, 3);
  assert.equal((BLOCK.match(/fetchJSON\(`search\/games\/\$\{job\.season\}`\)/g) || []).length, 1, 'only the games loader fetches games (G12)');
  assert.ok(!/\bfetch\(/.test(BLOCK));
  assert.ok(!/getTeamDirectory/.test(BLOCK), 'search no longer reads /api/v1/teams');
  const code = BLOCK.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/setTimeout\(0\)|setTimeout\(\w+, 0\)/.test(code), 'setTimeout(0) clamps to 4 ms: the yield is scheduler.yield or a MessageChannel');
  assert.match(BLOCK, /scheduler\.yield/); assert.match(BLOCK, /new MessageChannel\(\)/);
});

test('the grid\'s CSS: chips are at least 28 px (36 px on the phone), the page keeps the popover [hidden] rule', () => {
  assert.match(html, /\.sx-chip \{[^}]*height: 28px/);
  assert.match(html, /@media \(max-width: 768px\) \{\s*\.sx-grp, \.sx-row \{[^}]*\}\s*\.sx-chip \{ height: 36px/);
  assert.ok(!/\.usearch-pop\.sx \{ display/.test(html), 'a rule that would beat [hidden]');
  assert.match(html, /\.usearch-pop\[hidden\] \{ display: none; \}/);
});

// ---------- #168 (PR 4b): the Games section, G1-G12, its loading and the meetings' Load cell (MF1) ----------
const gamesOf = q => (slateOf(q).sections.find(x => x.name === 'games') || { rows: [] }).rows;
const gameCells = p => p.cells().filter(c => c.game);
const cellEl = (p, i) => all(p.tree(), n => roleOf(n) === 'gridcell' && n.attrs.id === `sx-c-${i}`)[0];

test('G1, G2, G3: a team\'s games: the heading and count, up to 3 Upcoming then 3 Recent results, each one gridcell; "Show all" lists them in order', async () => {
  const p = page(); await p.run('MVLA 2011');
  const rows = gamesOf('MVLA 2011');
  assert.ok(headings(p).includes(`Games ${rows.length} games`), headings(p).join(' | '));
  const subs = all(p.tree(), n => hasClass(n, 'sxg-sub')).map(text);
  assert.deepEqual(subs, ['Upcoming', 'Recent results']);
  const g = gameCells(p);
  assert.equal(g.length, 6);
  const up = rows.filter(r => r.date >= TODAY && !r.score), done = rows.filter(r => !(r.date >= TODAY && !r.score));
  assert.deepEqual(g.map(c => c.game.matchID), [...up.slice(0, 3), ...done.slice(0, 3)].map(r => r.matchID), 'the soonest 3, then the newest 3');
  for (const c of g) {
    const el = cellEl(p, p.cells().indexOf(c));
    assert.equal(roleOf(el.parent), 'row', 'one gridcell per row');
    assert.match(el.attrs['aria-label'], /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d+, \d{4}(, \d+:\d{2} [AP]M)?, .+ against .+, (upcoming|today|.+ won \d+–\d+|drawn \d+–\d+|result not reported), NorCal U\d+/, 'G10');
    assert.ok(all(el, n => hasClass(n, 'hit')).length >= 1, 'the side the query matched is marked');
  }
  const played = g.find(c => c.game.score);
  if (played && played.game.winner) assert.equal(all(cellEl(p, p.cells().indexOf(played)), n => hasClass(n, 'win')).length, 1, 'the winner bold');
  const more = p.cells().findIndex(c => c.kind === 'more' && c.section === 'games');
  assert.equal(p.cells()[more].text, `Show all ${rows.length} games`);
  p.sxActivate(more);
  assert.deepEqual(gameCells(p).map(c => c.game.matchID), rows.map(r => r.matchID), 'in order, every game (42 < 50)');
  assert.equal(p.activeCell().game.matchID, rows[6].matchID, 'the first new cell is active');
  assert.ok(!/sxg-sub/.test(p.list()), 'no split once shown in full');
});

test('G4: a field query: one field row (aria-expanded) open by itself with its games under it, the first game active; Enter on the field closes it; "Show all" at the field', async () => {
  const p = page(); await p.run('Surf Sports Park');
  const f = p.cells().find(c => c.kind === 'field');
  assert.equal(f.open, true);
  assert.equal(cellEl(p, p.cells().indexOf(f)).attrs['aria-expanded'], 'true');
  const fr = gamesOf('Surf Sports Park')[0], gs = fr.games;
  assert.deepEqual(gameCells(p).map(c => c.game.matchID), gs.slice(0, 6).map(r => r.matchID));
  assert.equal(p.activeCell().game.matchID, gs[0].matchID, 'Enter opens the next game there');
  assert.match(text(cellEl(p, p.cells().indexOf(f))), /Surf Sports Park.*Del Mar, CA · \d+ upcoming games? in 2026–27/);
  assert.ok(p.cells().some(c => c.kind === 'more' && c.text === `Show all ${gs.length} games at Surf Sports Park`));
  assert.equal(p.bar().open.textContent, 'Open in Matches');
  p.key('ArrowUp'); assert.equal(p.activeCell().kind, 'field');
  assert.equal(p.bar().hidden, true, 'a field opens in the panel: no links');
  p.key('Enter');
  assert.equal(p.activeCell().kind, 'field'); assert.equal(p.activeCell().open, false);
  assert.equal(gameCells(p).length, 0);
  p.key('Enter'); assert.equal(gameCells(p).length, 6);
});

test('G5: a field with no games in the seasons asked names its seasons and offers one Load cell (one request); in a place\'s list, empty fields share one line', async () => {
  const p = page(); await p.run('60 Acres');
  const fr = gamesOf('60 Acres')[0];
  assert.equal(fr.count, 0);
  assert.match(p.list(), /Games here in 2021–22, 2023–24, 2025–26\. Earlier seasons load when you ask\./);
  assert.ok(!/No team or event matches|No results/.test(p.list() + p.lead() + p.status()), 'never "no match"');
  const L = p.cells().findIndex(c => c.kind === 'load');
  assert.deepEqual(p.cells()[L].seasons, ['2025-26']);
  assert.equal(cellEl(p, L).attrs['aria-label'], 'Load 2025–26 games, one request');
  assert.equal(p.activeCell().kind, 'field', 'the field is active, open over its Load line');
  assert.equal(p.activeCell().open, true);
  const before = p.fetched.length;
  for (let k = 0; k < 5 && p.state().sxActive !== L; k++) p.key('ArrowDown');
  p.key('Enter');
  await p.gamesIdle(); await wait(0);
  assert.deepEqual(p.fetched.slice(before), ['search/games/2025-26'], 'exactly 1 request');
  assert.equal(p.activeCell().game.season, '2025-26', 'the first newly added game is active');
  assert.ok(p.cells().find(c => c.kind === 'field').open);
  // seasons this visit loaded already show their games; the Load cell then names the latest season still not loaded
  const v = page(); await v.open(''); await v.sxGamesFetch(['2023-24', '2025-26']);
  v.input.value = '60 Acres'; v.sxRun('60 Acres');
  assert.ok(gameCells(v).length > 0 && gameCells(v).every(c => ['2023-24', '2025-26'].includes(c.game.season)));
  assert.match(v.list(), /Also games here in 2021–22\. Earlier seasons load when you ask\./);
  assert.deepEqual(v.cells().find(c => c.kind === 'load').seasons, ['2021-22']);
  const sp = page(); await sp.run('Surf Sports Park');
  assert.ok(!sp.cells().some(c => c.kind === 'load'), 'a field with games this season offers no Load cell');
  // a place: no Load cell per field, one shared line
  const s = page(); await s.run('San Diego');
  assert.equal(s.cells().filter(c => c.kind === 'load').length, 0);
  assert.match(s.list(), /\d+ fields here had games only in earlier seasons\. Type a season, such as 2024-25, to search them\./);
  assert.match(headings(s).find(h => h.startsWith('Games')), /^Games \d+ fields · \d+ upcoming games$/);
});

test('G6: club against club: one pairing row per season and age group (aria-expanded), the first open with its meetings; the record names the first side', async () => {
  const p = page(); await p.run('Slammers vs Blues');
  const pr = p.cells().filter(c => c.kind === 'pairing');
  assert.equal(pr.length, 6);
  assert.deepEqual(pr.map(c => c.open), [true, false, false, false, false, false]);
  const el = cellEl(p, p.cells().indexOf(pr[0]));
  assert.equal(el.attrs['aria-expanded'], 'true');
  assert.match(el.attrs['aria-label'], /^Slammers FC against So Cal Blues, U18\/19, 2026–27, 2 meetings · none played yet · next Sat May 1, 2027$/);
  assert.equal(gameCells(p).length, 2, 'the first pairing\'s 2 meetings');
  assert.equal(p.activeCell().game.matchID, gamesOf('Slammers vs Blues')[0].meetings[0].matchID, 'its first meeting is active');
  assert.equal(headings(p)[0], 'Games 6 pairings · 12 meetings');
});

test('G7: coverage lines are rows with a rowheader only; the only cells among them are Load and Try again cells', async () => {
  const p = page(); await p.open('');
  for (const q of ['60 Acres', 'San Diego', 'MVLA 2011', 'MVLA 2011 vs Mustang 2011', 'Slammers HB Koge 2007 v So Cal Blues 2007', 'Surf Cup']) {
    p.input.value = q; p.sxRun(q);
    for (const r of all(p.tree(), n => hasClass(n, 'sxg-cover'))) {
      assert.equal(roleOf(r), 'row', q);
      assert.equal(all(r, n => roleOf(n) === 'rowheader').length, 1, q);
      for (const c of all(r, n => roleOf(n) === 'gridcell')) assert.ok(hasClass(c, 'sxg-load'), `${q}: a cell in a coverage line is a Load or Try again cell`);
    }
  }
  p.input.value = 'MVLA 2011'; p.sxRun('MVLA 2011');
  assert.match(p.list(), /Games from 2026–27\. Type a season, such as 2024-25, for earlier games\./, 'the scope line');
});

test('G8: a game\'s action bar: what it is, "Open in <view>" from row.href (never rebuilt), each side\'s season tab; Shift+Enter opens the matched side\'s season tab', async () => {
  const p = page(); await p.run('MVLA 2011');
  const i = p.cells().findIndex(c => c.game);
  for (let k = 0; k < 10 && p.state().sxActive !== i; k++) p.key('ArrowDown');
  const g = p.activeCell().game, row = g.row;
  const b = p.bar();
  assert.equal(b.hidden, false);
  assert.equal(b.open.textContent, 'Open in Matches'); assert.equal(b.open.href, row.href);
  assert.equal(b.hist.textContent, `${displayName(row.home.name, '')} season`); assert.equal(b.hist.href, row.home.seasonHref);
  assert.equal(b.prev.textContent, `${displayName(row.away.name, '')} season`); assert.equal(b.prev.href, row.away.seasonHref);
  assert.match(p.keysLine(), /Shift<\/kbd>\+<kbd>Enter<\/kbd> team’s season/);
  const mine = row.matched === 'away' ? row.away : row.home;
  assert.match(mine.name, /MVLA/, 'precondition: the matched side is MVLA');
  p.key('Enter', { shiftKey: true });
  assert.equal(p.location.hash, mine.seasonHref, 'the matched side\'s season tab');
  const q = page(); await q.run('MVLA 2011');
  const j = q.cells().findIndex(c => c.game);
  for (let k = 0; k < 10 && q.state().sxActive !== j; k++) q.key('ArrowDown');
  const href = q.activeCell().game.href;
  q.key('Enter'); assert.equal(q.location.hash, href, 'Enter opens the game in its view');
  // the bar reads row.href: a row whose href is planted shows that one
  const flat = r => ({ ...r, home: r.home, away: r.away, date: r.date, time: r.time, score: r.score, pk: r.pk, winner: r.winner, competition: r.competition, field: r.field, dest: r.dest, href: '#planted' });
  const real = slateOf('MVLA 2011'), planted = { ...real, sections: real.sections.map(s => (s.name !== 'games' ? s : { ...s, rows: s.rows.map((r, k) => (k ? r : flat(r))) })) };
  const m = page({ mod: { ...S, search: () => planted } }); await m.run('MVLA 2011');
  const k0 = m.cells().findIndex(c => c.game && c.game.matchID === real.sections.find(s => s.name === 'games').rows[0].matchID);
  for (let k = 0; k < 10 && m.state().sxActive !== k0; k++) m.key('ArrowDown');
  assert.equal(m.bar().open.href, '#planted');
});

test('G9: a game with no link (a side still to be decided) says "No page yet"; Enter does nothing; G10: names render as text', async () => {
  const p = page(); await p.open('');
  await p.sxGamesFetch(['2020-21']);
  p.input.value = '2021-07-07 2020-21'; p.sxRun('2021-07-07 2020-21');
  const i = p.cells().findIndex(c => c.kind === 'nolink');
  assert.ok(i >= 0, 'a TBD game is listed');
  assert.match(text(cellEl(p, i)), /No page yet/);
  p.input.value = '2021-07-07 2020-21';
  for (let k = 0; k < 20 && p.state().sxActive !== i; k++) p.key('ArrowDown');
  p.key('Enter');
  assert.equal(p.location.hash, '', 'nothing opens');
  assert.equal(p.bar().open.hidden, true);
  // a name is text: a planted team name with markup is escaped in the cell and its name
  const games = s => { const d = structuredClone(loadGames(s)); for (const t of Object.values(d.teams)) t[0] = '<img src=x onerror=alert(1)> FC'; return d; };
  const h = page({ games }); await h.run('MVLA 2011');
  assert.ok(!/<img\b/i.test(h.list()) && h.list().includes('&lt;img src=x'));
});

test('G11: the status line and the live region count games or fields; "no games" fields and the meetings\' Load say so (build point 5)', async () => {
  const p = page(); await p.run('MVLA 2011');
  assert.match(p.status(), new RegExp(`<strong>${gamesOf('MVLA 2011').length} games</strong>`));
  const f = page(); await f.run('Farmington');
  assert.equal(f.live(), 'No teams, no events. 3 fields, no games in 2026–27. Use the arrow keys to choose.', 'nit 6, build point 5');
  assert.equal(f.status(), '<strong>3 fields</strong>', 'a place counts its fields');
  const a = page(); await a.run('60 Acres');
  assert.equal(a.live(), 'No teams, no events. 1 field, no games in 2026–27. Use the arrow keys to choose.');
  const h = page(); await h.run('Slammers HB Koge 2007 v So Cal Blues 2007');
  assert.equal(h.live(), '2 teams in 2 clubs, no events. No meetings loaded; earlier meetings can be loaded. Use the arrow keys to choose.');
  const m = page(); await m.run('MVLA 2011 vs Mustang 2011');
  assert.equal(m.live(), '4 teams in 2 clubs, no events. 2 games. Use the arrow keys to choose.');
  const sp = page(); await sp.run('Surf Sports Park');
  assert.equal(sp.live(), `No teams, no events. ${gamesOf('Surf Sports Park')[0].count} games. Use the arrow keys to choose.`);
  const sd = page(); await sd.run('San Diego');
  const fs = gamesOf('San Diego').filter(r => r.kind === 'field');
  assert.match(sd.live(), new RegExp(`, 2 events\\. ${fs.length} fields, ${fs.reduce((n, f) => n + f.upcoming, 0)} upcoming games\\. Use the arrow keys to choose\\.$`));
  assert.match(sd.status(), new RegExp(`<strong>${fs.length} fields</strong>`));
});

test('G12: drawing makes no request: every judged keystroke draws with no fetch beyond the 3 of the first focus', async () => {
  const p = page(); await p.open('');
  for (const k of judgedKeystrokes()) { p.input.value = k; p.sxRun(k); }
  assert.deepEqual(p.fetched, ['search/core', 'search/places', 'search/games/2026-27']);
});

test('loading: games-first queries wait without a best match or a committed Enter; a season a query names loads after 500 ms of stillness, once, and never while typing', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const p = page({ gamesGate: s => (s === '2024-25' ? gate : null) }); await p.open('');
  const q = 'Pateadores vs Slammers 2024-25';
  for (const k of ['Pateadores vs Slammers 2', 'Pateadores vs Slammers 202', 'Pateadores vs Slammers 2024', 'Pateadores vs Slammers 2024-2']) { p.input.value = k; p.sxRun(k); await wait(60); }
  p.input.value = q; p.sxRun(q);
  assert.equal(p.state().sxActive, -1, 'no committed Enter while 2024-25 is pending (4a MF4)');
  assert.ok(!/Best match/.test(p.list()));
  await wait(p.SX_GAMES_STILL_MS - 150);
  assert.ok(!p.fetched.some(f => /games\/202[0-5]/.test(f)), 'nothing yet');
  await wait(250);
  assert.deepEqual(p.fetched.filter(f => /games\/202[0-5]/.test(f)), ['search/games/2024-25'], 'exactly 1, after the box was still; none for 2023-24 or 2024-25 while typing "2024"');
  assert.equal(headings(p)[0], 'Games');
  assert.match(p.list(), /Loading 2024–25 games…<\/strong> Teams and events are ready; games join them in a moment\./, 'Games leads with its loading line');
  release(); await p.gamesIdle(); await wait(0);
  const firstPair = p.cells().find(c => c.kind === 'pairing');
  assert.ok(firstPair.open && p.activeCell().game && p.cells().indexOf(p.activeCell()) === p.cells().indexOf(firstPair) + 1, 'once in, Enter is committed: the first pairing\'s first meeting (G6)');
  assert.match(p.list(), /2024–25 games loaded for this search \(one request, kept for the visit\)\./);
  p.input.value = q; p.sxRun(q); await wait(p.SX_GAMES_STILL_MS + 50);
  assert.equal(p.fetched.filter(f => f === 'search/games/2024-25').length, 1, 'once per visit');
});

test('loading: a failed games file says Try again (a cell), and Try again asks once more; a 404 says there is no games file', async () => {
  let fail = true;
  const games = s => { if (s === '2023-24' && fail) throw Object.assign(new Error('API error 429'), { status: 429 }); if (s === '2022-23') throw Object.assign(new Error('API error 404'), { status: 404 }); return loadGames(s); };
  const p = page({ games }); await p.run('MVLA 2023-24');
  await wait(p.SX_GAMES_STILL_MS + 50); await p.gamesIdle(); await wait(0);
  assert.match(p.list(), /Couldn't load 2023–24 games\.<\/strong> Too many requests\./);
  const t = p.cells().findIndex(c => c.kind === 'retry');
  assert.ok(t >= 0 && hasClass(cellEl(p, t), 'sxg-load'));
  fail = false;
  p.sxActivate(t); await p.gamesIdle(); await wait(0);
  assert.equal(p.fetched.filter(f => f === 'search/games/2023-24').length, 2);
  assert.ok(gameCells(p).some(c => c.game.season === '2023-24'));
  const m = page({ games }); await m.run('MVLA 2022-23');
  await wait(m.SX_GAMES_STILL_MS + 50); await m.gamesIdle(); await wait(0);
  assert.match(m.list(), /No games file for 2022–23\./);
});

test('MF1 (Q2): one squad a side: the loaded meetings and a Load cell; 0 fetches before the press, exactly 3 on it; a disabled cell keeps the place while loading; the first new meeting is active after', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const p = page({ gamesGate: s => (s !== '2026-27' ? gate : null) }); await p.run('MVLA 2011 vs Mustang 2011');
  await wait(p.SX_GAMES_STILL_MS + 50);
  assert.deepEqual(p.fetched, ['search/core', 'search/places', 'search/games/2026-27'], '0 before the press');
  assert.equal(p.activeCell().game.matchID, 1094466, 'the latest loaded meeting');
  assert.equal(gameCells(p).length, 2);
  const L = p.cells().findIndex(c => c.kind === 'load');
  assert.equal(cellEl(p, L).attrs['aria-label'], 'Load earlier meetings, 2023–24, 2024–25, 2025–26, 3 seasons');
  assert.match(p.list(), /Earlier meetings: both teams also played 2023–24, 2024–25, 2025–26\./);
  for (let k = 0; k < 5 && p.state().sxActive !== L; k++) p.key('ArrowDown');
  assert.equal(p.state().sxActive, L);
  assert.equal(p.bar().hidden, true, 'no links for a Load cell');
  p.key('Enter', { shiftKey: true });
  assert.equal(p.fetched.length, 3, 'Shift+Enter does nothing');
  p.key(' ');
  assert.deepEqual(p.fetched.slice(3), ['search/games/2023-24', 'search/games/2024-25'], 'Space fetches, 2 at a time');
  const busy = p.activeCell();
  assert.equal(busy.kind, 'busy', 'the cell becomes a load in flight and stays active (build point 4)');
  assert.equal(cellEl(p, p.state().sxActive).attrs['aria-disabled'], 'true');
  assert.ok(p.input.getAttribute('aria-activedescendant'));
  assert.equal(p.live(), 'Loading earlier meetings… (3 requests)');
  assert.match(p.list(), /Loading earlier meetings…<\/strong> 2023–24, 2024–25, 2025–26 \(3 requests\)\./);
  p.key('Enter'); assert.equal(p.fetched.length, 5, 'pressing it again fetches nothing');
  release(); await p.gamesIdle(); await wait(0);
  assert.deepEqual(p.fetched.slice(3).sort(), ['search/games/2023-24', 'search/games/2024-25', 'search/games/2025-26'], 'exactly 3 on the press');
  const a = p.activeCell();
  assert.ok(a.game && ['2023-24', '2024-25', '2025-26'].includes(a.game.season), 'the first newly added meeting is active');
  assert.equal(a.game.matchID, gamesOf('MVLA 2011 vs Mustang 2011').length ? S.search((() => { const ix = S.buildIndex(fresh()); for (const s of ['2026-27', '2023-24', '2024-25', '2025-26']) { const g = S.startGames(ix, loadGames(s), Infinity); while (!g.next().done); } return ix; })(), 'MVLA 2011 vs Mustang 2011', CTX).sections[0].rows[2].matchID : null);
  assert.ok(!p.cells().some(c => c.kind === 'load' || c.kind === 'busy'), 'no season remains: the cell is gone');
  assert.equal(p.el('usearchList').scrolled, undefined, 'the list does not jump');
});

test('MF1: H04 leads with Games, its Load row and no active cell; Down makes the Load cell active; a changed query while loading draws nothing; a failure, then Try again', async () => {
  const p = page(); await p.run('Slammers HB Koge 2007 v So Cal Blues 2007');
  assert.equal(headings(p)[0], 'Games no meetings loaded');
  assert.match(p.list(), /No meetings in the seasons loaded\. Both teams played 2020–21 to 2024–25\./);
  assert.equal(p.state().sxActive, -1); assert.equal(p.input.getAttribute('aria-activedescendant'), null);
  p.key('Enter'); assert.equal(p.location.hash, '', 'Enter does nothing');
  p.key('ArrowDown');
  assert.equal(p.activeCell().kind, 'load');
  assert.deepEqual(p.activeCell().seasons, ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25']);
  // a changed query while loading: the seasons are installed, nothing is redrawn
  let release; const gate = new Promise(r => { release = r; });
  let fail = true;
  const q = page({ gamesGate: s => (s !== '2026-27' ? gate : null), games: s => { if (s === '2024-25' && fail) throw Object.assign(new Error('x'), { status: 503 }); return loadGames(s); } });
  await q.run('MVLA 2011 vs Mustang 2011');
  const L = q.cells().findIndex(c => c.kind === 'load');
  q.sxActivate(L);
  q.input.value = 'Surf'; q.sxRun('Surf');
  const drawn = q.list();
  release(); await q.gamesIdle(); await wait(0);
  assert.equal(q.list(), drawn, 'Surf is not redrawn by the meetings landing');
  assert.ok(q.state().sxIndex.games.has('2023-24') && q.state().sxIndex.games.has('2025-26'), 'the seasons are installed');
  q.input.value = 'MVLA 2011 vs Mustang 2011'; q.sxRun('MVLA 2011 vs Mustang 2011');
  const t = q.cells().findIndex(c => c.kind === 'retry');
  assert.ok(t >= 0, 'the failed season: Try again');
  assert.match(q.list(), /Couldn't load 2024–25 games\./);
  fail = false;
  q.sxActivate(t); await q.gamesIdle(); await wait(0);
  assert.equal(q.activeCell().game.season, '2024-25');
  assert.ok(!q.cells().some(c => c.kind === 'retry' || c.kind === 'load'));
});

test('nit 7: a game link to the view already shown, differing only in match=, replaces the address (no second history entry) and fires the route', async () => {
  const p = page(); await p.run('MVLA 2011');
  const i = p.cells().findIndex(c => c.game);
  for (let k = 0; k < 10 && p.state().sxActive !== i; k++) p.key('ArrowDown');
  const href = p.activeCell().game.href;
  p.location.hash = href.replace(/&match=-?\d+$/, '');   // the view on screen, as pushHash wrote it
  p.key('Enter');
  assert.deepEqual(p.replaced, [href], 'replaceState, not a new entry');
  assert.equal(p.hashEvents.length, 1, 'the route fires itself');
  const q = page(); await q.run('MVLA 2011');
  for (let k = 0; k < 10 && !(q.activeCell() || {}).game; k++) q.key('ArrowDown');
  const h2 = q.activeCell().game.href;
  q.location.hash = '#season=2025-26';
  q.key('Enter');
  assert.deepEqual(q.replaced, []); assert.equal(q.location.hash, h2, 'another view: a plain hash change');
});

// ---------- #167: the painter (the draw addendum v2) ----------
const MOCKUP_STATES = ['Surf Sports Park', 'Great Park field 15', 'San Diego', 'Slammers vs Blues', '60 Acres', 'MVLA 2011', 'MVLA 2011 vs Mustang 2011',
  'Slammers HB Koge 2007 v So Cal Blues 2007', 'so', 'fc', 'sa', 'ml', 'Sacra', 'Surf Cup', 'san dei', 'MVLA 201'];
const drawnIds = h => [...h.matchAll(/\bid="(sx-c-\d+)"/g)].map(m => m[1]);
// the settled panel of a query, drawn in one go by sxDraw (sxRefresh) on a page of its own: the reference
async function reference() {
  const r = page(); await r.open('');
  return q => { r.sxRunRaw('x'); r.input.value = q; r.sxRefresh(q); return { list: r.list(), status: r.status(), lead: r.lead(), live: r.live(), active: r.state().sxActive, cells: r.cells().length }; };
}

test('#167 the settled panel is byte for byte the one-go draw (sxDraw) for every judged keystroke and the mockup\'s states: list, status, lead, live region, active cell', async () => {
  const ref = await reference();
  const p = page(); await p.open('');
  let n = 0, deferred = 0;
  for (const k of [...judgedKeystrokes(), ...MOCKUP_STATES]) {
    if (k.trim().length < 2) continue;
    p.input.value = k; p.sxRunRaw(k);
    if (p.state().sxPaint && p.state().sxPaint.slate.gamesPending) deferred++;
    await p.settle();
    assert.equal(p.state().sxPaint, null, k);
    const want = ref(k);
    assert.equal(p.list(), want.list, `${k}: list`);
    assert.equal(p.status(), want.status, `${k}: status`);
    assert.equal(p.lead(), want.lead, `${k}: lead`);
    assert.equal(p.live(), want.live, `${k}: live`);
    assert.equal(p.state().sxActive, want.active, `${k}: active cell`);
    assert.equal(p.el('usearchList').getAttribute('aria-busy'), null, `${k}: not busy once settled`);
    n++;
  }
  assert.ok(n > 400 && deferred > 100, `${n} keystrokes, ${deferred} deferred`);
});

test('#167 the first frame: a prefix of the settled list (append only, the same nodes), the enter\'s cell and aria-activedescendant in it, aria-busy until settled, the live region set once', async () => {
  const p = page({ frames: 'manual' }); await p.open('');
  let split = 0;
  for (const k of [...MOCKUP_STATES, ...judgedKeystrokes().filter(k => k.length >= 2)]) {
    const L = p.el('usearchList'), live = p.el('usearchLive');
    let liveSets = 0; const lv = live.textContent;
    Object.defineProperty(live, 'textContent', { configurable: true, get() { return this._t; }, set(v) { this._t = v; liveSets++; } }); live._t = lv;
    const sets0 = L.sets, appends0 = L.appends;
    p.input.value = k; p.sxRunRaw(k);
    const first = p.list(), job = p.state().sxPaint;
    const firstIds = drawnIds(first);
    if (job) {
      split++;
      assert.equal(L.getAttribute('aria-busy'), 'true', `${k}: busy while parts are pending`);
      assert.equal(liveSets, 0, `${k}: the live region waits for the settled panel`);
      assert.ok(firstIds.length >= Math.min(p.SX_FIRST_CELLS, p.cells().length) || job.waiting, `${k}: at least SX_FIRST_CELLS cells first`);
      const enter = p.state().sxActive;
      if (enter >= 0) {
        assert.ok(firstIds.includes(`sx-c-${enter}`), `${k}: build point 3: the enter's cell is in the first frame`);
        assert.equal(p.input.getAttribute('aria-activedescendant'), `sx-c-${enter}`, `${k}: aria-activedescendant set in the first frame`);
      }
      assert.ok(p.frame() >= 1, `${k}: the rest waits for a frame`);
      await p.settle();
    }
    const done = p.list();
    assert.ok(done.startsWith(first), `${k}: the first part is a prefix of the settled list`);
    assert.equal(L.sets - sets0, 1, `${k}: the list is set once, then appended to`);
    if (job) assert.ok(L.appends > appends0 || done === first, `${k}: the rest is appended`);
    assert.equal(liveSets, 1, `${k}: the live region is set once`);
    assert.equal(L.getAttribute('aria-busy'), null, k);
    if (p.state().sxActive >= 0) assert.equal(p.input.getAttribute('aria-activedescendant'), `sx-c-${p.state().sxActive}`, `${k}: kept`);
    delete live.textContent; live.textContent = live._t;
  }
  assert.ok(split > 50, `${split} split`);
});

test('#167 mutation 12: nothing is appended before the frame; a newer query drops the pending parts (a stale task appends nothing)', async () => {
  const p = page({ frames: 'manual' }); await p.open('');
  p.input.value = 'so'; p.sxRunRaw('so');
  const L = p.el('usearchList'), first = p.list(), a0 = L.appends;
  assert.ok(p.state().sxPaint, 'so is painted in parts');
  await wait(20);
  assert.equal(L.appends, a0, 'no append before the frame');
  assert.equal(p.list(), first);
  p.input.value = 'mv'; p.sxRunRaw('mv');
  const second = p.list(), a1 = L.appends;
  p.frame(); await p.settle();
  await wait(20);
  assert.ok(p.list().startsWith(second), 'only the newer query\'s parts land');
  assert.ok(!p.state().sxPaint);
  // the first query's frame ran (frame() ran every pending callback) and appended nothing to the newer panel
  const ref = await reference();
  assert.equal(p.list(), ref('mv').list);
  assert.ok(L.appends >= a1);
});

test('#167 MF2: a key, a click and a hover rest right after the first frame act on the settled list, exactly as on the one-go draw', async () => {
  const seqs = [['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown'], ['End'], ['ArrowDown', 'ArrowUp'], ['Enter'], ['ArrowDown', 'Enter']];
  // two pages, each query run afresh on them (the panel reopened first: Enter may have closed it)
  const a = page({ frames: 'manual' }), b = page();
  const typed = async (x, q, raw = true) => { x.location.hash = ''; await x.open(''); x.input.value = q; if (raw) x.sxRunRaw(q); else x.sxRun(q); return x; };
  for (const q of ['so', 'sa', 'fc', 'San Diego', 'MVLA 2011', 'Surf Sports Park']) {
    for (const ks of seqs) {
      await typed(a, q); await typed(b, q, false);
      for (const k of ks) { a.key(k); b.key(k); }
      assert.equal(a.state().sxPaint, null, `${q} ${ks}: a key flushes`);
      assert.equal(a.list(), b.list(), `${q} ${ks}: list`);
      assert.equal(a.state().sxActive, b.state().sxActive, `${q} ${ks}: active`);
      assert.deepEqual(a.location.hash, b.location.hash, `${q} ${ks}: Enter went to the same place`);
      assert.equal(a.el('usearchList').getAttribute('aria-busy'), null);
      a.frame(); await a.settle(); assert.equal(a.list(), b.list(), `${q} ${ks}: the pending frame adds nothing after a flush`);
    }
    const h = await typed(a, q);
    const target = Math.min(20, h.cells().length - 1);
    h.sxHoverCell(target); await wait(300);
    assert.equal(h.state().sxPaint, null, `${q}: a hover rest flushes`);
    if (target > 0) assert.equal(h.state().sxActive, target, `${q}: hover lands on the settled list`);
    const c = await typed(a, q);
    const at = c.state().sxActive >= 0 ? c.state().sxActive : 0;
    c.click(at);
    assert.equal(c.state().sxPaint, null, `${q}: a click flushes`);
    for (const [what, fire] of [['a middle click', x => x.el('usearchList').on.auxclick({ target: { closest: () => null }, button: 1 })],
      ['an action-bar click', x => x.el('usearchOpen').on.click({ ctrlKey: true, metaKey: false, shiftKey: false, button: 0, preventDefault() {}, currentTarget: x.el('usearchOpen') })]]) {
      const x = await typed(a, q);
      if (!x.state().sxPaint) continue;
      fire(x);
      assert.equal(x.state().sxPaint, null, `${q}: ${what} flushes`);
    }
  }
});

test('#167 the first task runs no games search on a deferred keystroke; the games task runs exactly one team search; lazy groups: only the drawn ones are built (at most 8 a keystroke)', async () => {
  const calls = [], stats = [];
  const mod = { ...S, completeGames: (i, s, c) => { if (s.later && s.later.reader.text === 'so') calls.push('complete'); const st = stats[0]; return S.completeGames(i, s, c, { stats: st }); },
    search: (i, q, c, o) => { if (q !== 'so') return S.search(i, q, c, o); calls.push(o && o.games); const st = {}; stats.push(st); return S.search(i, q, c, { ...o, stats: st }); } };   // the warm-up's searches are left out
  const p = page({ mod, frames: 'manual' }); await p.open('');
  calls.length = 0;
  p.input.value = 'so'; p.sxRunRaw('so');
  const job = p.state().sxPaint;
  assert.ok(job && job.slate.gamesPending, 'so leaves Games for later');
  assert.deepEqual(calls, ['later'], 'the keystroke\'s task: one search, Games left for later');
  assert.equal(stats[0].gamesVisited || 0, 0, 'no game visited in the first task');
  p.frame(); await p.settle();
  assert.deepEqual(calls, ['later', 'complete']);
  assert.ok(stats[0].gamesVisited > 0, 'the games task visits the games');
  assert.equal(stats[0].teamSearches, 1, 'MF3: one team search for the keystroke, none in the games task');
  let most = 0;
  for (const k of judgedKeystrokes().filter(k => k.length >= 2)) { const g0 = p.sxStats.groupsBuilt; p.input.value = k; p.sxRun(k); most = Math.max(most, p.sxStats.groupsBuilt - g0); }
  assert.ok(most <= 8 && most > 0, `at most ${most} groups built for one keystroke (sa: 8; every group of so would be 36 or more)`);
});

test('#167 (Q3) the warm-up: after the active season\'s games, no request, the visible panel untouched; skipped once the visitor types', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let searches = 0;
  const mod = { ...S, search: (i, q, c, o) => { searches++; return S.search(i, q, c, o); } };
  const p = page({ mod, gamesGate: () => gate }); await p.open('', { games: false });
  p.input.value = 'mvla'; p.sxRun('mvla');
  const before = { list: p.list(), status: p.status(), live: p.live(), sets: p.el('usearchList').sets, appends: p.el('usearchList').appends, fetched: [...p.fetched] };
  assert.equal(p.state().sxWarmed, false, 'not before the games are in');
  const s0 = searches;
  release(); await p.gamesIdle();
  for (let k = 0; k < 400 && !(p.state().sxWarmed && searches - s0 >= 8 + 3); k++) await wait(2);
  await wait(50);
  assert.ok(p.state().sxWarmed && searches - s0 >= 8 + 3, `${searches - s0} warm-up searches`);
  assert.deepEqual(p.fetched, before.fetched, '0 fetches');
  // the panel on screen is what the landing's own redraw drew (sxRefresh: the games are in), nothing of the warm-up's
  const ref = await reference(), want = ref('mvla');
  assert.equal(p.list(), want.list); assert.equal(p.status(), want.status);
  assert.equal(p.el('usearchList').sets, before.sets + 1, 'the visible list is set once, by the landing\'s redraw'); assert.equal(p.el('usearchList').appends, before.appends);
  // a visitor who types stops it: no further warm-up search after the input event
  let n = 0;
  const mod2 = { ...S, search: (i, q, c, o) => { n++; return S.search(i, q, c, o); } };
  let release2; const gate2 = new Promise(r => { release2 = r; });
  const t = page({ mod: mod2, gamesGate: () => gate2 }); await t.open('', { games: false });
  t.input.on.input();
  release2(); await t.gamesIdle(); const n0 = n; await wait(200);
  assert.ok(t.state().sxTyped);
  assert.ok(n - n0 <= 1, `${n - n0} searches after typing (at most the keystroke's own, 60 ms on)`);
});

test('#167 mutations 3, 5: the first part stops early on a broad keystroke; a games task queued for an older query never runs', async () => {
  const p = page({ frames: 'manual' }); await p.open('');
  for (const q of ['so', 'sa', 'fc', 'san']) {   // broad keystrokes (a short list stops where Games waits)
    p.input.value = q; p.sxRunRaw(q);
    const first = drawnIds(p.list()).length;
    assert.ok(p.state().sxPaint && !p.state().sxPaint.done, `${q}: parts pending`);
    p.sxFlush();
    const all = drawnIds(p.list()).length;
    assert.ok(first >= p.SX_FIRST_CELLS && first < all && first <= p.SX_FIRST_CELLS + 12, `${q}: ${first} of ${all} cells first`);
  }
  // the rest has run and the games task is queued; a newer query comes before it
  const calls = [];
  const mod = { ...S, completeGames: (i, s, c) => { calls.push(s.later.reader.text); return S.completeGames(i, s, c); } };
  const t = page({ mod, frames: 'manual' }); await t.open('');
  t.manualTasks = true;
  t.input.value = 'so'; t.sxRunRaw('so');
  t.frame(); assert.ok(t.task(), 'the task after the frame: the rest');
  assert.ok(t.state().sxPaint && t.state().sxPaint.waiting && t.tasksQ.length === 1, 'the games task is queued');
  t.input.value = 'mv'; t.sxRunRaw('mv');
  const mvFirst = t.list();
  assert.ok(t.task(), 'the stale games task');
  assert.equal(t.list(), mvFirst, 'it appends nothing to the newer panel');
  assert.ok(!calls.includes('so'), 'and searches nothing');
  t.frame(); while (t.task()) t.frame();
  t.manualTasks = false;
  const ref = await reference();
  assert.equal(t.list(), ref('mv').list);
  assert.ok(!calls.includes('so') && calls.includes('mv'), 'only the newer query\'s games are searched (the warm-up also searches mv)');
});

test('#167 build point 3: the enter\'s cell is always in the first part, even when it sits past the first cells', async () => {
  // a slate whose enter is a Teams row far down the list (the data never has one: the module's enter is near the top)
  let deep = null;
  const mod = { ...S, search: (i, q, c, o) => {
    const s = S.search(i, q, c, o);
    if (q !== 'so') return s;
    const rows = s.sections.find(x => x.name === 'teams').rows;
    deep = rows[30];
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { enter: deep, best: null, later: s.later });
  } };
  const p = page({ mod, frames: 'manual' }); await p.open('');
  p.input.value = 'so'; p.sxRunRaw('so');
  const at = p.state().sxActive;
  assert.ok(at >= p.SX_FIRST_CELLS, `the enter's cell is ${at}`);
  assert.equal(p.cells()[at].team.key, deep.key);
  assert.ok(drawnIds(p.list()).includes(`sx-c-${at}`), 'drawn in the first part');
  assert.equal(p.input.getAttribute('aria-activedescendant'), `sx-c-${at}`);
});

test('#167 (review of #170, N1): a pending paint replaced by the tips or by an empty body leaves the grid not busy; N2: "Today" is a plain pill', async () => {
  for (const next of ['s', 'zzzz', '']) {
    const p = page({ frames: 'manual' }); await p.open('');
    p.input.value = 'so'; p.sxRunRaw('so');
    assert.equal(p.el('usearchList').getAttribute('aria-busy'), 'true', 'so is painting');
    p.input.value = next; p.sxRunRaw(next);
    assert.equal(p.state().sxPaint, null, `${JSON.stringify(next)}: the pending parts are dropped`);
    assert.equal(p.el('usearchList').getAttribute('aria-busy'), null, `${JSON.stringify(next)}: not busy`);
    p.frame(); await p.settle();
    assert.equal(p.el('usearchList').getAttribute('aria-busy'), null);
  }
  const css = html.slice(html.indexOf('.sxg-pill {'), html.indexOf('.sxg-pill.unreported'));
  assert.match(css, /\.sxg-pill\.upcoming \{ background: var\(--accent-surface\)/);
  assert.ok(!/\.sxg-pill\.today/.test(css), 'Today takes the plain pill (the mockup draws it grey)');
});
