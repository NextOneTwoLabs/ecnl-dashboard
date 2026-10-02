// #135 P2: the conference page. At <=1024 px there is no card above the standings: the viewer's own
// selection (a row, a match name) opens the team in a modal sheet (<dialog>.showModal()), and a
// load (a &team= link, a followed team) never does. At >1024 px the side card stays and the
// names link to the team's Overview. The page's own code (public/index.html), extracted block by
// block as in tests/conference-return.test.mjs, run against a small fake DOM with counted
// requests answered from the committed archive. The fixture (a conference, an age group, a team)
// is found in the data, and every expectation is computed from the same files, never from the
// code under test. Layout and real focus behaviour are covered by the PR's Playwright run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const between = (from, to) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} in index.html`);
  return html.slice(a, b);
};
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CODE = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    function getSeasonData()'), line('    function seasonLabel('),
  block('    function saveState('), block('    function pushHash('), block('    function loadFromHash('),
  block('    function setSidebarToggle('),
  block('    async function getEventHierarchy('),
  block('    const standingsMemo = {};', 'function mergeStandingsBlocks('),
  block('    async function getSchedule(', 'function undateBorrowedDates('),
  block('    let clubPlaces = null', 'function favoriteInDivision('),
  block('    function shortTeamName('), block('    function displayName('),
  block('    function gameWinner('), block('    function resultFor('),
  line('    function gameDateKey('), line('    function isPlayed('), block('    function sortGames('),
  block('    function computeTeamSummary('), block('    function formatGameDate('), block('    function opponentText('),
  block('    // #128: form chips that show their game.', 'function chipGames('),
  block('    function starButton(', 'function recordFromButton('), block('    function toggleFavorite('),
  line('    const teamHistoryMissing = new Set();'), block('    function historyAvailable('), block('    function teamSeasonTabLabel('),
  block('    function buildBreadcrumb('), block('    function teamCellHtml('),
  block('    function selectTeam('),
  block('    let currentConfMeta = null;', 'async function loadCurrentView('),
  block('    function findTeamInFlights('), block('    function defaultSelection('),
  between('    // ========== TEAM SHEET (#135 P2) ==========', '    // ========== TEAM AT A GLANCE =========='),
  block('    function updateGlancePanel(', 'function glanceHtmlFor('),
  block('    function glancePanelHtml('),
  between('    // ========== KEYBOARD NAV ==========', "    document.getElementById('ageGroupTabs')"),
  block('    function matchTeamKey('),
].join('\n');
const CHIP_TIPS = between('    (function chipTips() {', '    // ========== KEYBOARD NAV ==========');

// ---------- the fixture, found in the data ----------
const SOURCES = read('data/sources.json');
const SEASON = SOURCES.refresh.activeSeason;
const SEASONS = SOURCES.seasons;
const archive = p => new URL(`archive/api/Event/${p}`, root);
const hierarchyFile = e => archive(`get-event-schedule-or-standings/${e}.json`);
const standingsFile = (e, d, f) => archive(`get-standings-by-div-and-flight/${d}/${f}/${e}.json`);
const scheduleFile = (e, f) => archive(`get-schedules-by-flight/${e}/${f}/0.json`);
const teamsOf = (e, d, f) => {
  if (!existsSync(standingsFile(e, d, f))) return [];
  const data = JSON.parse(readFileSync(standingsFile(e, d, f), 'utf8')).data;
  const blocks = Array.isArray(data) ? data : data ? [data] : [];
  return blocks.reduce((a, b) => ((b && b.teamStandings || []).length > a.length ? b.teamStandings : a), []);
};
// The first conference (in the registry's order) with a one-flight, one-block girls division of
// at least six teams, a published schedule, and played games for the sixth team.
const FIX = (() => {
  for (const [conf, { eventId }] of Object.entries(SEASONS[SEASON].conferences)) {
    if (!existsSync(hierarchyFile(eventId))) continue;
    const h = JSON.parse(readFileSync(hierarchyFile(eventId), 'utf8')).data;
    for (const d of h.girlsDivAndFlightList || []) {
      const flights = d.flightList || [];
      if (flights.length !== 1) continue;
      const f = flights[0];
      const raw = existsSync(standingsFile(eventId, d.divisionID, f.flightID)) ? JSON.parse(readFileSync(standingsFile(eventId, d.divisionID, f.flightID), 'utf8')).data : null;
      if (Array.isArray(raw) && raw.filter(b => b && (b.teamStandings || []).length).length > 1) continue;   // merged blocks: another test's
      const teams = teamsOf(eventId, d.divisionID, f.flightID);
      if (teams.length < 6 || !existsSync(scheduleFile(eventId, f.flightID))) continue;
      const games = JSON.parse(readFileSync(scheduleFile(eventId, f.flightID), 'utf8')).data || [];
      const six = teams[5];
      if (!games.some(g => (g.hometeamID === six.teamID || g.awayteamID === six.teamID) && g.hometeamscore != null)) continue;
      return { conf, eventId, age: d.divisionName, teams };
    }
  }
  return null;
})();
const skip = !FIX && 'no one-flight division with six teams and played games in this checkout';
const CLUBS = read('archive/clubs.json');
const placeOf = t => {
  const p = t && t.clubID != null && Number(t.clubID) !== 7 && CLUBS.clubs[t.clubID];   // 7: TGS's "No Club Selection"
  return p && p.city && p.state ? `${p.city}, ${p.state}` : '';
};
const short = t => String(t.name).replace(/\s*[-–]?\s*ECNL\b.*$/i, '').trim() || t.clubName || t.name;
const HASH = FIX ? `#season=${SEASON}&age=${encodeURIComponent(FIX.age)}&conf=${encodeURIComponent(FIX.conf)}` : '';
const TEAM = FIX && FIX.teams[5];
const deferred = () => { let resolve; const promise = new Promise(y => { resolve = y; }); return { promise, resolve }; };

// ---------- a small fake DOM ----------
// innerHTML is parsed into flat child elements (enough for the selectors the page uses here);
// focus is document.activeElement. A <dialog> has showModal() (modal; it remembers what had focus,
// as browsers do) and close() (restores that focus if it is still in the page, then fires "close"
// as a task).
function makeDom({ dialog = true, narrow = true } = {}) {
  let active = null;
  const docOn = {};
  const attrsOf = s => Object.fromEntries([...s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
  const one = (el, compound) => {
    const m = compound.match(/^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(:[\w-]+)?$/i);
    if (!m) throw new Error(`fake DOM: selector ${compound}`);
    if (m[5]) return false;   // no :hover or :focus-visible here
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2].slice(1)) return false;
    for (const c of (m[3] || '').split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
    for (const a of (m[4] || '').match(/\[[^\]]+\]/g) || []) {
      const [, k, v] = a.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!(k in el.attrs) || (v !== undefined && el.attrs[k] !== v)) return false;
    }
    return true;
  };
  const matches = (el, sel) => sel.split(',').some(s => {
    const parts = s.trim().split(/\s+/);
    if (!one(el, parts.pop())) return false;
    for (let e = el.parent; parts.length && e; e = e.parent) if (one(e, parts[parts.length - 1])) parts.pop();
    return !parts.length;
  });
  let top = null;
  class El {
    constructor(tag, attrs = {}) {
      Object.assign(this, { tagName: tag.toUpperCase(), attrs, kids: [], parent: null, alive: true, on: {}, _html: '', textContent: '', style: {}, hidden: false });
    }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }
    get classList() {
      const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
      return {
        contains: c => list().includes(c),
        add: c => { if (!list().includes(c)) el.className = [...list(), c].join(' '); },
        remove: c => { el.className = list().filter(x => x !== c).join(' '); },
        toggle(c, on) { on = on === undefined ? !list().includes(c) : !!on; if (on) this.add(c); else this.remove(c); return on; },
      };
    }
    get dataset() {
      return Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v]));
    }
    get open() { return 'open' in this.attrs; }
    set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
    get isConnected() { for (let e = this; e; e = e.parent) { if (!e.alive) return false; if (e === top) return true; } return false; }
    get innerHTML() { return this._html; }
    set innerHTML(h) {
      for (const k of this.kids) k.alive = false;
      this._html = h; this.kids = [];
      for (const m of h.matchAll(/<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
        const k = new El(m[1], attrsOf(m[2])); k.parent = this; this.kids.push(k);
      }
      this.textContent = h.replace(/<[^>]*>/g, '');
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...ks) { for (const k of ks) { k.parent = this; this.kids.push(k); } }
    appendChild(k) { if (k.parent) k.parent.kids = k.parent.kids.filter(x => x !== k); this.append(k); return k; }
    get parentNode() { return this.parent; }
    all() { return this.kids.flatMap(k => [k, ...k.all()]); }
    matches(sel) { return matches(this, sel); }
    closest(sel) { for (let e = this; e && e !== top; e = e.parent) if (e.matches(sel)) return e; return null; }
    querySelector(sel) { return this.all().find(e => e.matches(sel)) || null; }
    querySelectorAll(sel) { return this.all().filter(e => e.matches(sel)); }
    contains(x) { for (; x; x = x.parent) if (x === this) return true; return false; }
    focus() { active = this; }
    addEventListener(t, f) { (this.on[t] ||= []).push(f); }
    fire(t, ev = {}) { for (const f of this.on[t] || []) f({ type: t, target: this, preventDefault() {}, ...ev }); }
    getBoundingClientRect() { return { left: 10, top: 300, right: 54, bottom: 344, width: 44, height: 44 }; }
    get offsetWidth() { return 120; }
    get offsetHeight() { return 30; }
  }
  top = new El('html');
  const body = new El('body');
  top.append(body);
  const add = (tag, attrs) => { const e = new El(tag, attrs); body.append(e); return e; };
  add('button', { class: 'hamburger', 'aria-expanded': 'false' });
  add('nav', { id: 'sidebar', class: 'sidebar' });
  add('div', { id: 'breadcrumb', class: 'breadcrumb' });
  add('h1', { id: 'contentTitle', tabindex: '-1' });
  add('div', { id: 'contentSubtitle' });
  add('div', { id: 'extLinks' }); add('div', { id: 'formatNote' });
  add('div', { id: 'standingsContainer' });
  const sheet = add('dialog', { id: 'teamSheet', class: 'team-sheet', 'aria-modal': 'true', 'aria-labelledby': 'teamSheetName teamSheetTitle' });
  sheet.append(new El('div', { id: 'teamSheetContent' }));
  sheet.modal = false;
  if (dialog) {
    sheet.showModal = function () {
      if (this.open) throw new Error('InvalidStateError: already open');
      this.open = true; this.modal = true; this.returnTo = active;
    };
    sheet.show = function () { this.open = true; this.modal = false; this.returnTo = active; };
  }
  sheet.close = function () {
    if (!this.open) return;
    this.open = false; this.modal = false;
    active = this.returnTo && this.returnTo.isConnected ? this.returnTo : null;
    setTimeout(() => this.fire('close'), 0);
  };
  const mq = { narrow, fns: [] };
  const location = { hash: '', search: '' };
  const document = {
    documentElement: top, body,
    get activeElement() { return active || body; },
    getElementById: id => top.all().find(e => e.id === id) || null,
    querySelector: s => top.querySelector(s), querySelectorAll: s => top.querySelectorAll(s),
    createElement: t => new El(t),
    addEventListener: (t, f) => { (docOn[t] ||= []).push(f); },
    dispatchEvent: ev => { for (const f of docOn[ev.type] || []) f(ev); },
  };
  const window = {
    location, innerWidth: narrow ? 390 : 1400,
    matchMedia: () => ({ get matches() { return mq.narrow; }, addEventListener: (_t, f) => mq.fns.push(f) }),
    addEventListener() {},
  };
  const HTMLDialogElement = dialog ? class { showModal() {} } : class {};
  const setNarrow = on => { mq.narrow = on; for (const f of mq.fns) f(); };
  return { El, top, body, sheet, document, window, location, HTMLDialogElement, docOn, setNarrow, Event: class { constructor(t) { this.type = t; } } };
}

// ---------- the page ----------
function page({ narrow = true, dialog = true, live = false, follow = null } = {}) {
  const dom = makeDom({ dialog, narrow });
  const { El, document } = dom;
  const el = id => document.getElementById(id);
  const calls = [], hold = {}, render = { n: 0, sorts: 0 }, conf = { selected: [] };
  const answer = path => {
    let m;
    if ((m = path.match(/^events\/(\d+)\/hierarchy$/))) return hierarchyFile(m[1]);
    if ((m = path.match(/^events\/(\d+)\/divisions\/(\d+)\/flights\/(\d+)\/standings$/))) return standingsFile(m[1], m[2], m[3]);
    if ((m = path.match(/^events\/(\d+)\/flights\/(\d+)\/schedule$/))) return scheduleFile(m[1], m[2]);
    if (path === 'clubs') return new URL('archive/clubs.json', root);
    throw new Error(`unexpected request ${path}`);
  };
  let api;
  const stubs = {
    document, window: dom.window, location: dom.location, HTMLDialogElement: dom.HTMLDialogElement, Event: dom.Event,
    history: { replaceState: (_s, _t, h) => { dom.location.hash = h; } },
    localStorage: { setItem() {}, getItem: () => null }, SEASONS, SOURCES, LIVE: live, esc,
    fetchJSON: async path => {
      calls.push(path);
      if (hold[path]) await hold[path].promise;
      const file = answer(path);
      if (!existsSync(file)) throw Object.assign(new Error('404'), { status: 404 });
      return JSON.parse(readFileSync(file, 'utf8'));
    },
    eventContext: () => ({ kind: 'conference' }), isMissing: e => !!e && e.status === 404, retryText: e => String(e),
    clearTeamFilter() {}, updateViewTabsUI() {}, saveFavorites() {}, buildFavoritesList() {}, openFavoritesTab() {},
    selectAgeGroup: a => conf.selected.push(['age', a]), selectConference: c => conf.selected.push(['conf', c]),
    focusTeamSearch: () => conf.selected.push(['search']), toggleSidebar() {}, isPhone: () => narrow,
    // The conference view: a table panel (its sort headers, sorting as the page's thead handler
    // does: a new column starts descending, except # and Team; the same column flips; and "How
    // ranking works"), one row per team (with its follow star and name), and the side card.
    renderConferenceView: () => {
      render.n++;
      const c = el('standingsContainer');
      c.innerHTML = '';
      const layout = new El('div', { class: 'conf-layout is-conf' }), aside = new El('aside', { id: 'glancePanel', class: 'glance-panel' });
      const panel = new El('div', { class: 'flight-panel standings-panel' });
      c.append(layout); layout.append(panel, aside);
      panel.innerHTML = '<th data-col="rank" class="sortable sort-active sort-asc"><button type="button" class="th-sort">#</button></th>' +
        '<th data-col="standingpoints" class="sortable"><button type="button" class="th-sort">Pts</button></th>' +
        '<details class="rank-help"><summary>How ranking works</summary></details>';
      for (const th of panel.querySelectorAll('th[data-col]')) {
        th.click = () => {
          render.sorts++;
          const asc = th.classList.contains('sort-active') ? !th.classList.contains('sort-asc') : th.dataset.col === 'rank';
          for (const o of panel.querySelectorAll('th[data-col]')) { o.classList.remove('sort-active'); o.classList.remove('sort-asc'); }
          th.classList.add('sort-active'); th.classList.toggle('sort-asc', asc);
        };
      }
      for (const fd of api.flights()) for (const t of fd.standings.teamStandings || []) {
        const tr = new El('tr', { 'data-team-id': String(t.teamID), tabindex: '0', class: t.teamID === api.selected() ? 'team-row team-row-highlight' : 'team-row' });
        layout.append(tr);
        tr.innerHTML = api.starButton(t) + api.teamCellHtml(t, { link: true });
      }
      api.updateGlancePanel();
    },
  };
  api = new Function(...Object.keys(stubs), CODE + `
    if (${JSON.stringify(follow)}) favorites.add(${JSON.stringify(follow)});
    return { loadFromHash, loadCurrentView, selectTeam, switchTab: t => { closeTeamSheet('title'); currentTab = t; },
      starButton, teamCellHtml, updateGlancePanel, toggleFavorite, buildBreadcrumb, setSidebarToggle, closeTeamSheet,
      sheetMode, matchTeamKey, flights: () => currentFlightData, selected: () => selectedTeamID, favorites: () => favorites,
      setSeason: s => { currentSeason = s; }, setConference: c => { currentConference = c; } };`)(...Object.values(stubs));
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };
  const row = id => document.querySelector(`#standingsContainer tr[data-team-id="${id}"]`);
  // Cold, from a conference link, as the page's INIT reads one.
  const open = async (hash = HASH) => { api.setSeason(SEASON); dom.location.hash = hash; api.loadFromHash(); await api.loadCurrentView(); await flush(); };
  const since = () => { const n = calls.length; return () => calls.slice(n); };
  const choose = id => { const tr = row(id); tr.focus(); api.selectTeam(id, { user: true, from: tr }); return tr; };
  return { ...api, dom, el, calls, hold, render, conf, flush, row, open, since, choose, sheet: dom.sheet, active: () => document.activeElement };
}
const sheetHtml = p => p.el('teamSheetContent').innerHTML;
const namedIn = (p, t) => new RegExp(`id="teamSheetName">${re(esc(short(t)))} ·</span>`).test(sheetHtml(p));

test('T1: a row chosen on a narrow screen opens a modal sheet with that team, named for it, focus on Close', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  assert.equal(p.dom.top.classList.contains('no-dialog'), false);
  p.choose(TEAM.teamID);
  assert.equal(p.sheet.open, true);
  assert.equal(p.sheet.modal, true, 'showModal(): the page behind is inert');
  assert.equal(p.sheet.getAttribute('aria-modal'), 'true');
  assert.deepEqual(p.sheet.getAttribute('aria-labelledby').split(' ').map(id => !!p.el(id)), [true, true], 'its name resolves');
  assert.ok(namedIn(p, TEAM), 'named "<team> · Team at a glance" (S2)');
  assert.match(sheetHtml(p), /<h2 id="teamSheetTitle">Team at a glance<\/h2>/);
  assert.equal(p.active().className, 'sheet-close');
  // The table's own figures: position n / N, points, played, PPG; and the Overview link.
  assert.match(sheetHtml(p), new RegExp(`>6<span class="stat-of"> / ${FIX.teams.length}</span>`));
  assert.match(sheetHtml(p), new RegExp(`<div class="stat-value">${TEAM.standingpoints || 0}</div>`));
  assert.match(sheetHtml(p), new RegExp(`${TEAM.gp || 0} played · ${(TEAM.ppg || 0).toFixed(2)} PPG`));
  assert.match(sheetHtml(p), new RegExp(`&team=${TEAM.teamID}&name=[^"]*">Team overview →</a>`));
  assert.equal(p.dom.top.classList.contains('sheet-open'), true);
});

test('T2: a load never opens the sheet: a &team= link, a followed team, a selection that is not the viewer\'s', { skip }, async () => {
  const deep = page({ narrow: true });
  await deep.open(`${HASH}&team=${TEAM.teamID}`);
  assert.equal(deep.selected(), TEAM.teamID, 'the link selects the team');
  assert.equal(deep.sheet.open, false, 'and opens no sheet');
  const followed = page({ narrow: true, follow: TEAM.name });
  await followed.open();
  assert.equal(followed.selected(), TEAM.teamID, 'a followed team in the table is selected');
  assert.equal(followed.sheet.open, false);
  followed.selectTeam(FIX.teams[0].teamID);   // no { user: true }: as a hand-off or a redraw would
  followed.updateGlancePanel();
  assert.equal(followed.sheet.open, false);
});

test('T3: closing returns focus to what opened it (found again if the table was redrawn); the team stays selected', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  const hides = [];
  p.dom.document.addEventListener('chiptip-hide', () => hides.push(1));
  for (const [how, close] of [['Close', () => p.closeTeamSheet()], ['the backdrop', () => p.sheet.fire('click', { target: p.sheet })], ['Esc', () => p.sheet.close()]]) {
    p.choose(TEAM.teamID);
    await p.flush();
    assert.equal(p.sheet.open, true);
    const n = hides.length;
    close();
    await p.flush();
    assert.equal(hides.length, n + 1, `${how}: an open #128 tooltip is hidden`);
    assert.equal(p.sheet.open, false, how);
    assert.equal(p.active(), p.row(TEAM.teamID), `${how}: focus is back on the row`);
    assert.equal(p.selected(), TEAM.teamID);
    assert.match(p.dom.location.hash, new RegExp(`&team=${TEAM.teamID}(&|$)`));
    assert.equal(sheetHtml(p), '', 'the sheet is emptied');
    assert.equal(p.dom.top.classList.contains('sheet-open'), false);
  }
  // The row that opened it is replaced while the sheet is open (a redraw behind it).
  const tr = p.choose(TEAM.teamID);
  const container = p.el('standingsContainer');
  container.innerHTML = '';
  const fresh = new p.dom.El('tr', { 'data-team-id': String(TEAM.teamID), tabindex: '0' });
  container.append(fresh);
  assert.equal(tr.isConnected, false);
  p.closeTeamSheet();
  await p.flush();
  assert.equal(p.active(), fresh, 'the row as it is now, not the detached one');
});

test('T4: a new view or tab closes the sheet, and focus goes to the page title (S5)', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  p.choose(TEAM.teamID);
  await p.flush();             // its place has arrived: nothing else is pending
  assert.equal(p.sheet.open, true);
  await p.loadCurrentView();   // another age group or conference: selectAgeGroup and selectConference call it directly
  await p.flush();
  assert.equal(p.sheet.open, false);
  assert.equal(p.active(), p.el('contentTitle'));
  p.choose(TEAM.teamID);
  p.switchTab('playoffs');
  await p.flush();
  assert.equal(p.sheet.open, false);
  assert.equal(p.active(), p.el('contentTitle'));
  assert.match(block('    function switchTab('), /if \(typeof closeTeamSheet === 'function'\) closeTeamSheet\('title'\);/, 'the page\'s switchTab does the same');
});

test('T5: Follow in the sheet follows the team in the sheet and in the table, keeps the sheet open, asks for nothing', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  p.choose(TEAM.teamID);
  await p.flush();
  const req = p.since();
  const star = p.sheet.querySelector('.star-btn');
  star.focus();
  p.toggleFavorite(star);
  assert.ok(p.favorites().has(TEAM.name));
  assert.equal(p.sheet.querySelector('.star-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(p.row(TEAM.teamID).querySelector('.star-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(p.sheet.open, true);
  assert.equal(p.active(), star);
  assert.deepEqual(req(), []);
});

test('T6: the club place arriving redraws the sheet, focus staying on the same control (S1); a stale team is not drawn', { skip }, async () => {
  for (const [what, pick] of [['Follow', d => d.querySelector('.star-btn')], ['Team overview', d => d.querySelectorAll('a.glance-link').at(-1)]]) {
    const p = page({ narrow: true });
    p.hold.clubs = deferred();
    await p.open();
    p.choose(TEAM.teamID);
    assert.doesNotMatch(sheetHtml(p), /glance-place/, 'no place yet');
    const hides = [];
    p.dom.document.addEventListener('chiptip-hide', () => hides.push(what));
    p.sheet.querySelector('.glance-more').open = true;
    const before = pick(p.sheet);
    before.focus();
    p.hold.clubs.resolve();
    await p.flush();
    assert.equal(p.sheet.open, true);
    assert.equal(p.sheet.querySelector('.glance-more').open, true, '"More statistics" stays open (S1)');
    assert.equal(hides.length, 1, 'the redraw hides an open #128 tooltip');
    if (placeOf(TEAM)) assert.match(sheetHtml(p), new RegExp(`glance-place[^>]*>${re(esc(placeOf(TEAM)))}<`));
    assert.notEqual(pick(p.sheet), before, 'redrawn');
    assert.equal(p.active(), pick(p.sheet), `focus stays on ${what}`);
  }
  // Opened for one team, closed, opened for another before the places arrive: the second is drawn.
  const p = page({ narrow: true });
  p.hold.clubs = deferred();
  await p.open();
  const other = FIX.teams[0];
  p.choose(TEAM.teamID);
  p.closeTeamSheet(); await p.flush();
  p.choose(other.teamID);
  p.hold.clubs.resolve(); await p.flush();
  assert.ok(namedIn(p, other));
  assert.equal(p.calls.filter(c => c === 'clubs').length, 1, 'one request for the places');
});

test('T7: on a wide screen a row selects in the side card and opens no sheet; names link to the Overview', { skip }, async () => {
  const p = page({ narrow: false });
  await p.open();
  assert.equal(p.sheetMode(), false);
  p.choose(TEAM.teamID);
  assert.equal(p.sheet.open, false);
  assert.match(p.el('glancePanel').innerHTML, new RegExp(`>${re(esc(short(TEAM)))}</span>`));
  const links = FIX.teams.map(t => p.teamCellHtml(t, { link: true }).match(/<a class="team-link" href="([^"]+)"/));
  assert.equal(links.filter(Boolean).length, FIX.teams.length, 'every team has an Overview (no 404 seen)');
  // The link round-trips: that team's page, in this season, on Overview.
  p.dom.location.hash = links[5][1];
  assert.equal(p.loadFromHash(), true);
  p.setSeason(SEASON);
  assert.equal(new URLSearchParams(links[5][1].slice(1)).get('team'), String(TEAM.teamID));
  assert.equal(new URLSearchParams(links[5][1].slice(1)).get('tab'), 'teams');
  assert.equal(new URLSearchParams(links[5][1].slice(1)).get('season'), SEASON);
  assert.doesNotMatch(links[5][1], /view=/, 'Overview needs no view');
  // A narrow screen draws the names as text; ?live=1 has no Overview; other tables are unchanged.
  const n = page({ narrow: true });
  assert.ok(!FIX.teams.some(t => /<a /.test(n.teamCellHtml(t, { link: true }))));
  const live = page({ narrow: false, live: true });
  assert.ok(!FIX.teams.some(t => /<a /.test(live.teamCellHtml(t, { link: true }))));
  assert.ok(!FIX.teams.some(t => /<a /.test(p.teamCellHtml(t, {}))));
});

test('T8: crossing 1025 px redraws from memory; an open sheet gives way to the side card, focus on the row (S5)', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  p.choose(TEAM.teamID);
  await p.flush();
  const req = p.since(), n = p.render.n;
  p.dom.setNarrow(false);
  await p.flush();
  assert.equal(p.render.n, n + 1, 'redrawn: names become links');
  assert.equal(p.sheet.open, false);
  assert.equal(p.active(), p.row(TEAM.teamID));
  assert.match(p.el('glancePanel').innerHTML, /glance-name/, 'the side card shows the team');
  p.dom.setNarrow(true);
  await p.flush();
  assert.equal(p.render.n, n + 2);
  assert.equal(p.sheet.open, false, 'narrowing again opens nothing');
  assert.deepEqual(req().filter(c => c !== 'clubs'), [], 'no table request either way');
});

test('T9: rows and match names select with { user: true } (click, Enter, Space); a load does not', () => {
  const rows = block('    function renderStandingsTable(');
  assert.equal((rows.match(/selectTeam\(Number\(tr\.dataset\.teamId\), \{ user: true, from: tr \}\)/g) || []).length, 2, 'row click and key');
  const matches = block('    function renderMatchCards(');
  assert.equal((matches.match(/selectTeam\(Number\(t\.dataset\.teamId\), \{ user: true, from: t \}\)/g) || []).length, 1, 'name click');
  assert.match(matches, /wrap\.addEventListener\('keydown', matchTeamKey\);/, 'name keys');
  assert.match(block('    function matchTeamKey('), /selectTeam\(Number\(t\.dataset\.teamId\), \{ user: true, from: t \}\)/);
  assert.doesNotMatch(block('    async function loadCurrentView('), /user: true/);
});

test('T9b (R28): a match name acts on Enter and Space only; Tab passes through and opens nothing', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  const name = new p.dom.El('span', { class: 'match-team', 'data-team-id': String(TEAM.teamID), role: 'button', tabindex: '0' });
  p.el('standingsContainer').append(name);
  const press = key => { let prevented = false; p.matchTeamKey({ key, target: name, preventDefault: () => { prevented = true; } }); return prevented; };
  for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) {
    assert.equal(press(key), false, `${key} is not taken`);
    assert.equal(p.sheet.open, false, `${key} opens nothing`);
  }
  for (const key of ['Enter', ' ']) {
    name.focus();
    assert.equal(press(key), true);
    assert.equal(p.sheet.open, true, `${JSON.stringify(key)} opens the sheet`);
    p.closeTeamSheet(); await p.flush();
    assert.equal(p.active(), name, 'and focus comes back to the name');
  }
});

test('T10: requests: a narrow &team= link reads no club places (S6); the sheet reads them once', { skip }, async () => {
  const per = ['hierarchy', 'standings', 'schedule'];
  const kinds = cs => cs.map(c => (c === 'clubs' ? 'clubs' : per.find(k => c.endsWith(k))));
  const narrow = page({ narrow: true });
  await narrow.open(`${HASH}&team=${TEAM.teamID}`);
  assert.deepEqual(kinds(narrow.calls), per, 'one flight: hierarchy, standings, schedule, and no clubs');
  const wide = page({ narrow: false });
  await wide.open(`${HASH}&team=${TEAM.teamID}`);
  assert.deepEqual(kinds(wide.calls).sort(), [...per, 'clubs'].sort(), 'a wide card shows the place: + clubs');
  const req = narrow.since();
  narrow.choose(TEAM.teamID);
  await narrow.flush();
  narrow.closeTeamSheet(); await narrow.flush();
  narrow.choose(TEAM.teamID);
  await narrow.flush();
  assert.deepEqual(req(), ['clubs'], 'opened twice: the places once');
});

test('T11: CSS and markup: only the conference card hides, targets per decision 4, the sheet before its script', () => {
  const css = html.slice(0, html.indexOf('</style>'));
  const hides = [...css.matchAll(/([^{}]*\.glance-panel[^{}]*)\{[^}]*display:\s*none/g)].map(m => m[1].trim().split('\n').pop().trim());
  assert.deepEqual(hides, ['html:not(.no-dialog) .conf-layout.is-conf > .glance-panel'], 'the conference card only, and only with <dialog>');
  const at1024 = css.slice(css.indexOf('@media (max-width: 1024px) {\n      .conf-layout'));
  assert.ok(at1024.indexOf('.conf-layout.is-conf > .glance-panel { display: none; }') < at1024.indexOf('\n    }\n'), 'inside the <=1024 px rule');
  const touch = css.slice(css.indexOf('/* Comfortable targets on touch screens */'));
  const touchBlock = touch.slice(0, touch.indexOf('\n    }\n'));
  assert.match(touchBlock, /\.star-btn \{ min-width: 44px; min-height: 44px; \}/, 'Q2: the star is 44 px on touch');
  assert.match(touchBlock, /\.th-sort \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(touchBlock, /\.hamburger, \.theme-toggle, \.header-search \{ min-width: 44px; min-height: 44px; \}/);
  assert.match(css, /\n    \.star-btn \{ min-width: 24px; min-height: 24px; \}/, 'Q2: 24 px everywhere');
  assert.match(css, /\.glance-link \{ display: inline-flex; align-items: center; min-height: 24px; \}/);
  assert.match(css, /\.glance-more summary \{ display: flex; align-items: center; min-height: 24px; \}/);
  assert.match(css, /\.glance-form \.form-chip \{ width: 44px; height: 44px;/);
  assert.match(css, /\.match-team \{ min-width: 44px; min-height: 44px; \}/);
  assert.match(css, /\.star-btn \{[^}]*color: var\(--star-idle\);/, "#137's colour is untouched");
  // MF1: "How ranking works" is 24 px, and 44 px on touch: the 24 px rule must come first.
  const r24 = css.indexOf('\n    .rank-help summary { min-height: 24px; }');
  const r44 = css.indexOf('.rank-help summary { display: inline-flex; align-items: center; min-height: 44px; }');
  assert.ok(r24 > 0 && r44 > r24, 'the 24 px rule is above the touch rule');
  assert.equal(css.slice(r44).search(/\.rank-help summary \{[^}]*min-height: 24px/), -1, 'nothing after the touch rule takes it back to 24');
  assert.ok(css.lastIndexOf('@media (max-width: 768px), (pointer: coarse) {', r44) > r24, 'the 44 px rule is in a touch block after it');
  // MF2: below 340 px the wordmark keeps its mark and drops its text (owner: the mark on small phones).
  assert.match(css, /@media \(max-width: 339px\) \{ \.wordmark \{ font-size: 0; min-width: 44px; justify-content: center; \} \.header \.wordmark img \{ margin-right: 0; \} \}/);
  // S3, the table star's margin (rows keep their height), and Change only on a phone.
  assert.match(css, /@media \(pointer: coarse\) \{ html\.sheet-open, html\.sheet-open body, html\.sheet-open #standingsScroll \{ overflow: hidden; \} \}/);
  assert.match(css, /\.standings-table \.star-btn \{ margin-block: -2px; \}/);
  assert.match(css, /\n    \.ctx-change \{ display: none; \}/);
  const pill = css.indexOf('.ctx-change { display: inline-flex;');
  assert.ok(pill > 0 && css.lastIndexOf('@media (max-width: 768px) {', pill) > css.lastIndexOf('\n    }\n', pill), 'the pill shows only inside the <=768 px rule');
  const dialog = html.match(/<dialog class="team-sheet" id="teamSheet"[^>]*>/);
  assert.ok(dialog && html.indexOf(dialog[0]) < html.indexOf('\n  <script>\n'), 'the sheet is in the page before the script that wires it');
  assert.match(dialog[0], /aria-modal="true"/);
  assert.match(dialog[0], /aria-labelledby="teamSheetName teamSheetTitle"/);
});

test('T12 (M2): the context bar is #breadcrumb\'s content, so no other tab keeps it; Change says if the drawer is open (S7)', { skip }, async () => {
  assert.doesNotMatch(html, /getElementById\('breadcrumb'\)\.className/, 'no class is left on #breadcrumb');
  assert.doesNotMatch(html.slice(0, html.indexOf('</style>')), /ctx[\w-]*[^{}]*content-subtitle/, 'no rule hides the subtitle');
  const p = page({ narrow: true });
  await p.open();
  const bar = p.el('breadcrumb');
  assert.equal(bar.className, 'breadcrumb');
  assert.match(bar.innerHTML, new RegExp(`<b>${re(esc(FIX.conf))}</b> · Girls [^·<]+ · ${SEASON.replace('-', '–')}</span>`));
  assert.match(bar.innerHTML, /<button type="button" class="ctx-change" onclick="toggleSidebar\(\)" aria-controls="sidebar" aria-expanded="false" aria-label="Change season, age group or conference">Change<\/button>/);
  p.setSidebarToggle(true);
  assert.equal(bar.querySelector('.ctx-change').getAttribute('aria-expanded'), 'true');
  p.setSidebarToggle(false);
  assert.equal(bar.querySelector('.ctx-change').getAttribute('aria-expanded'), 'false');
  // Q3: on the conference page the subtitle keeps the count; the bar says the rest.
  const view = block('    function renderConferenceView(');
  assert.match(view, /\[countKnown \? `\$\{teamCount\} teams` : '', multi \? `\$\{flights\.length\} flights` : ''\]/);
  // The bar goes because every other view rewrites #breadcrumb, its empty states included.
  for (const fn of ['    async function loadPlayoffsPanel(', '    async function loadShowcasesPanel(']) {
    const body = block(fn), early = body.slice(0, body.indexOf('\n        return;\n'));
    assert.match(early, /getElementById\('breadcrumb'\)\.innerHTML =/, `${fn.trim()}: its empty state writes #breadcrumb`);
  }
  // S8: the footnote says what a click does.
  assert.ok(block('    function renderStandingsTable(').includes("' · Select a row for details · a name opens its Overview' : ' · Select a team for details'"));
});

test('T13: names are escaped in the bar, the link and the sheet\'s label, and encoded in the href', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  const hostile = 'A & <b>"C"</b>';
  p.setConference(hostile);
  p.buildBreadcrumb();
  assert.ok(p.el('breadcrumb').innerHTML.startsWith(`<span class="ctx-where"><b>${esc(hostile)}</b> · `));
  const t = { ...TEAM, name: `${hostile} ECNL G10` };
  const wide = page({ narrow: false });
  const cell = wide.teamCellHtml(t, { link: true });
  assert.ok(cell.includes(`&name=${encodeURIComponent(t.name)}">`), 'the href is encoded');
  assert.ok(cell.includes(`>${esc(hostile)}</span></a>`), 'the text is escaped');
  p.setConference(FIX.conf);
  p.flights()[0].standings.teamStandings[5].name = t.name;
  p.choose(TEAM.teamID);
  assert.ok(sheetHtml(p).includes(`id="teamSheetName">${esc(hostile)} ·</span>`), 'the sheet\'s label is escaped');
});

test('T14 (SC1): crossing 1025 px keeps the sort, an open "How ranking works", and focus', { skip }, async () => {
  for (const start of [false, true]) {
    const p = page({ narrow: start });
    await p.open();
    const ths = () => p.el('standingsContainer').querySelectorAll('th[data-col]');
    ths()[1].click();   // Pts, descending
    p.el('standingsContainer').querySelector('.rank-help').open = true;
    p.row(TEAM.teamID).querySelector('.star-btn').focus();
    p.dom.setNarrow(!start);
    await p.flush();
    const [rank, pts] = ths();
    assert.deepEqual([rank.classList.contains('sort-active'), pts.classList.contains('sort-active'), pts.classList.contains('sort-asc')], [false, true, false], 'Pts, descending');
    assert.equal(p.el('standingsContainer').querySelector('.rank-help').open, true);
    assert.equal(p.active(), p.row(TEAM.teamID).querySelector('.star-btn'), 'focus on the same star');
    // Focus on a sort button, and the same column flipped to ascending.
    pts.click();
    p.el('standingsContainer').querySelectorAll('.th-sort')[1].focus();
    p.dom.setNarrow(start);
    await p.flush();
    assert.equal(ths()[1].classList.contains('sort-asc'), true, 'Pts, ascending');
    assert.equal(p.active(), p.el('standingsContainer').querySelectorAll('.th-sort')[1]);
  }
  // The default order needs no click.
  const p = page({ narrow: false });
  await p.open();
  const sorts = p.render.sorts;
  p.dom.setNarrow(true);
  await p.flush();
  assert.equal(p.render.sorts, sorts);
});

test('M3: while the sheet is open the page\'s shortcuts do nothing (ArrowDown would change the conference)', { skip }, async () => {
  const p = page({ narrow: true });
  await p.open();
  p.choose(TEAM.teamID);
  const keydown = p.dom.docOn.keydown.at(-1);
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', '/']) keydown({ key, target: p.sheet, preventDefault() {} });
  assert.deepEqual(p.conf.selected, []);
  p.closeTeamSheet(); await p.flush();
  keydown({ key: 'ArrowDown', target: p.dom.body, preventDefault() {} });
  assert.equal(p.conf.selected.length, 1, 'closed: the shortcut works again');
});

test('M4: a #128 tooltip for a chip in the open sheet is drawn inside the dialog; the sheet hides it', () => {
  const dom = makeDom();
  const { document, sheet } = dom;
  new Function('document', 'window', CHIP_TIPS)(document, dom.window);
  const tip = document.getElementById('chipTip');
  const onDoc = t => dom.docOn[t].at(-1);
  const content = document.getElementById('teamSheetContent');
  sheet.showModal();
  content.innerHTML = '<button type="button" class="form-chip" tabindex="0" data-tip="W 3–1 vs Example SC · Sep 27">W</button>';
  onDoc('click')({ target: content.querySelector('.form-chip'), detail: 0 });   // Enter or Space
  assert.equal(tip.hidden, false);
  assert.equal(tip.parentNode, sheet, 'in the top layer with the sheet');
  document.dispatchEvent(new dom.Event('chiptip-hide'));
  assert.equal(tip.hidden, true, 'the sheet hides it when it redraws or closes');
  sheet.close();
  const out = new dom.El('button', { class: 'form-chip', 'data-tip': 'D 1–1 vs Example SC · Sep 20' });
  document.body.append(out);
  onDoc('click')({ target: out, detail: 0 });
  assert.equal(tip.parentNode, document.body, 'outside a sheet it is the page\'s again');
});

test('S4: without showModal the card stays above the table and nothing opens', { skip }, async () => {
  const p = page({ narrow: true, dialog: false });
  await p.open(`${HASH}&team=${TEAM.teamID}`);
  assert.equal(p.dom.top.classList.contains('no-dialog'), true, 'html.no-dialog keeps the card (CSS)');
  assert.equal(p.sheetMode(), false);
  p.choose(TEAM.teamID);
  await p.flush();
  assert.equal(p.sheet.open, false);
  assert.match(p.el('glancePanel').innerHTML, /glance-name/, 'the card shows the team');
  assert.ok(p.calls.includes('clubs'), 'with its place, as before P2');
});
