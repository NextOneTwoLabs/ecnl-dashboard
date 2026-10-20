// #178 (#149 phase 1, PR 6): the head to head page. The page's own code (public/index.html: the routing, the head-to-head
// block, the search panel's lead row and H2H cells, the Matches cards and the team's schedule rows) is extracted and run in a
// fake DOM on an index built, by the real modules (public/search), from the frozen search data
// (tests/search/fixtures/search). What a browser adds (layout, real focus, Back and Forward) is tests/e2e/h2h.e2e.mjs. Every
// exact figure is the frozen fixture's. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/h2h-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readJSON, readLF, HERE, ROOT, FIXTURES, loadGames } from './search/judged.mjs';

const html = readLF(new URL('public/index.html', ROOT));
const CATALOG = JSON.parse(readLF(new URL('public/data/sources.json', ROOT)));
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1, from = html.indexOf(last, start), end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const MATCH = html.slice(html.indexOf('    // ========== #168: match='), html.indexOf('    // ========== URL HASH'));
const START = '    // ===== #165: the search panel (public/search) =====\n', END = "    // #128: the form chips' tooltip";
const PANEL = html.slice(html.indexOf(START), html.indexOf(END));
assert.ok(PANEL.includes('// ===== #178: head to head =====') && MATCH.length > 2000, 'the blocks are in index.html');
const trimAt = (src, marker) => { const i = src.indexOf(marker); assert.ok(i > 0, marker); return src.slice(0, i + marker.length) + '\n    }\n'; };
const ROUTING = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'), line('    function getSeasonData()'),
  block('    function saveState('), block('    function pushHash('), block('    function loadFromHash('),
  block("    window.addEventListener('hashchange'", "window.addEventListener('hashchange'", '\n    });\n'),
  MATCH,
  block('    function selectFavorite('), block('    function selectTeamView('), block('    function showTeamViewTabs('), block('    function sameTeam('),
  block('    function overviewAvailable('), block('    function historyAvailable('), block('    async function changeSeason('), block('    function switchTab('),
  trimAt(block('    function showLanding('), 'landingOpen = true;'),
  block('    async function loadTeamSummary('),
  block('    function matchRowHtml('),
].join('\n');

const MODULES = new URL('public/search/', ROOT);
const S = await import(new URL('search.mjs', MODULES));
const FX = new URL('search/', FIXTURES);
const coreText = readLF(new URL('core.json', FX)), placesText = readLF(new URL('places.json', FX));
const fresh = () => ({ core: JSON.parse(coreText), places: JSON.parse(placesText) });
const doc = readJSON(new URL('queries.json', HERE));
const NOW = Date.parse(doc.context.now), SEASON = doc.context.selectedSeason;
const TODAY = '2026-10-20';
const wait = ms => new Promise(r => setTimeout(r, ms));
const pageFn = head => { const a = html.indexOf('\n' + head) + 1, b = html.indexOf('\n    }\n', a) + 6; assert.ok(a > 0 && b > a, head); return html.slice(a, b); };
const { displayName } = new Function(pageFn('    function shortTeamName(') + pageFn('    function displayName(') + 'return { displayName };')();
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- a fake page: the globals the code reads and the elements it writes ----------
function page({ hash = '', saved = null, live = false, games = s => loadGames(s), activeGames = true, season = SEASON, favs = [], fetchFail = null, teamIndex = null } = {}) {
  const T = { loads: [], history: [], fetched: [], notes: [], tabs: [], titleFocus: 0, focused: [] };
  const els = new Map(), store = {};
  if (saved) store['ecnl-dash-v2-state'] = JSON.stringify(saved);
  const node = id => {
    const n = { id, hidden: false, textContent: '', _html: '', style: {}, attrs: {}, dataset: {}, kids: [], parentNode: null, className: '',
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; },
      insertAdjacentHTML(w, h) { this._html = w === 'afterbegin' ? h + this._html : this._html + h; }, appendChild(c) { this.kids.push(c); return c; },
      contains: () => false, offsetParent: {}, scrollIntoView() {}, blur() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener(k, f) { (this.on = this.on || {})[k] = f; },
      focus(o) { T.focused.push(id); }, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, bottom: 10 }), scrollTop: 0, clientHeight: 400 };
    return n;
  };
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const container = el('standingsContainer');
  container.parentNode = { insertBefore: n => { n.parentNode = container.parentNode; els.set(n.id, n); } };
  const box = { on: {}, addEventListener(k, f) { this.on[k] = f; } };
  const matchEls = new Map();
  container.querySelector = sel => { const m = /^\[data-match="(-?\d+)"\]$/.exec(sel); if (m) { if (!matchEls.has(m[1])) matchEls.set(m[1], null); return matchEls.get(m[1]); } return sel === '.h2h' ? box : sel === '#h2hFail' ? el('h2hFail') : null; };
  const location = { hash, search: live ? '?live=1' : '' }, listeners = {};
  const history = { replaceState: (s, t, url) => { T.history.push(url); location.hash = url.slice(url.indexOf('#')); } };
  const stubs = {
    T, document: { getElementById: el, addEventListener() {}, createElement: tag => node('new-' + tag), querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} } },
    window: { location, innerWidth: 1400, addEventListener: (t, f) => { listeners[t] = f; }, dispatchEvent() {} }, location, history, navigator: {},
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    SEASONS: CATALOG.seasons, SOURCES: CATALOG, LIVE: live, NO_CLUB: 7, sessionBackAt: 0, esc, displayName, todayKey: () => TODAY,
    isPhone: () => false, closeSidebarIfMobile() {}, retryText: () => 'Please try again shortly.', isMissing: e => !!e && e.status === 404, isRefusal: e => !!e && e.status >= 400 && e.status < 500 && e.status !== 404,
    seasonLabel: s => String(s || '').replace('-', '–'), teamSeasonTabLabel: s => `${s} season`, showLanding0() {}, leaveLanding() {}, syncSeasonUI() {}, focusContentTitle: () => { T.titleFocus++; },
    tabChrome() {}, openFavoritesTab() { T.loads.push('openFavoritesTab'); }, loadPlayoffsPanel() {}, loadShowcasesPanel() {}, renderTeamsIndex() {}, indexChrome() {}, closeTeamSheet() {}, loadCurrentView() {},
    rebuildAll: () => T.loads.push('rebuild'), buildFavoritesList() {}, historyCrumb() {}, clearTeamFilter() {}, showTeamInSidebar: (...a) => T.loads.push(['sidebar', ...a]),
    loadWarning: (e, retry) => ({ warn: true, e, retry }), resolveFavorite: async () => false, loadTeamHistory: async rec => { T.loads.push(['overview', rec.name]); }, historyAvailable0() {}, eventContext: () => null, teamHistoryMissing: new Set(),
    teamToken0: 0, lastTopTab: 'conferences', getTeamIndex: async () => { if (teamIndex instanceof Error) throw teamIndex; return teamIndex; }, loadSavedState() {},
    isPlayed: g => g.hometeamscore != null && g.awayteamscore != null, gameDateKey: g => (g.gameDate || '').slice(0, 10),
    fetchJSON: async path => {
      T.fetched.push(path);
      if (fetchFail) { const f = fetchFail(path); if (f) throw f; }
      const m = /^search\/games\/(.+)$/.exec(path);
      if (m) return games(m[1]);
      const d = fresh(); return path === 'search/core' ? d.core : d.places;
    },
    Date: class extends Date { static now() { return NOW; } },
    requestAnimationFrame: f => setTimeout(f, 0), setTimeout: (f, ms) => setTimeout(f, ms), requestIdleCallback: undefined, MessageChannel,
    HashChangeEvent: class { constructor(t) { this.type = t; } },
  };
  const loadTeamStub = !!arguments[0] && arguments[0].realTeam === false;
  const names = Object.keys(stubs);
  const api = new Function(...names, `let loadToken = 0, showcaseToken = 0;\n${ROUTING}\n${PANEL}
    sxImport = async () => arguments[${names.length}];
    ${loadTeamStub ? 'loadTeamSummary = async rec => { T.loads.push(["team", teamView, rec.name]); };' : ''}
    favorites = new Set(arguments[${names.length + 1}]); for (const n of favorites) favoriteMeta.set(n, { name: n, teamID: arguments[${names.length + 2}][n] });
    return { saveState, pushHash, loadFromHash, loadTeamSummary, selectFavorite, selectTeamView, showTeamViewTabs, switchTab, changeSeason, showLanding, sxLoad, sxGamesFetch, matchRowHtml,
      h2hCardLinker, h2hSeasonLinks, h2hToggle, h2hLoad, sxRun, sxOpen, sxFlush, sxActivate,
      get: () => ({ teamView, h2hVs, h2hMatch, h2hNote, previewTeam, currentFavorite, currentTab, currentSeason, sxIndex, sxMod, sxG, sxView, sxActive, sxState, h2hChosen, teamToken }),
      set: o => { if ('teamView' in o) teamView = o.teamView; if ('currentFlightData' in o) currentFlightData = o.currentFlightData; if ('selectedTeamID' in o) selectedTeamID = o.selectedTeamID; if ('currentSeason' in o) currentSeason = o.currentSeason; if ('currentTab' in o) currentTab = o.currentTab; } };`)(...Object.values(stubs), S, favs.map(f => f[0]), Object.fromEntries(favs));
  api.set({ currentSeason: season });
  const fire = async h => { if (h != null) location.hash = h; listeners.hashchange(); await wait(0); };
  const settle = async () => { for (let k = 0; k < 400; k++) { await wait(5); if (!/loading|Loading/.test(container._html) || /h2h-regroup|h2h-list|h2h-empty/.test(container._html)) { if (!api.get().sxG.running && !api.get().sxG.queue.length) break; } } await wait(5); };
  return Object.assign(api, { T, store, location, listeners, els, el, container, box, fire, settle, history, matchEls });
}
const saved = () => ({ season: '2026-27', ageGroup: 'GU16', conference: 'NorCal', view: 'standings', tab: 'conferences', stage: null, playoffAgeGroup: null, tier: null, favorite: null, showcase: null, showcaseAge: null, team: null, sched: 'upcoming', moreStats: false, teamPage: null });
const MVLA = `#tab=teams&season=2026-27&team=55477&name=${encodeURIComponent('MVLA ECNL G2010/11')}`;
const H2H = `${MVLA}&vs=2026-27:31529`;
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('routing: vs= opens the head to head of the team named, view= is ignored, match= is kept for that view only; every bad value opens A\'s Overview with a note', () => {
  const p = page();
  p.location.hash = H2H + '&match=1094466&view=season';
  assert.equal(p.loadFromHash(), true);
  assert.deepEqual([p.get().teamView, p.get().h2hVs, p.get().h2hMatch], ['h2h', { season: '2026-27', teamID: 31529 }, 1094466]);
  p.location.hash = MVLA + '&match=99'; p.loadFromHash();
  assert.deepEqual([p.get().teamView, p.get().h2hVs, p.get().h2hMatch], ['history', null, null], 'match= alone is ignored on a team page, as before');
  const bad = {
    'malformed (abc)': [`${MVLA}&vs=abc`, 'That head-to-head link is incomplete.'],
    'no team (2026-27)': [`${MVLA}&vs=2026-27`, 'That head-to-head link is incomplete.'],
    'team 0': [`${MVLA}&vs=2026-27:0`, 'That head-to-head link is incomplete.'],
    'leading zero': [`${MVLA}&vs=2026-27:01`, 'That head-to-head link is incomplete.'],
    'short season': [`${MVLA}&vs=26-27:5`, 'That head-to-head link is incomplete.'],
    'no team id on A': [`#tab=teams&season=2026-27&name=X&vs=2026-27:5`, 'That head-to-head link is incomplete.'],
    'no season on A': [`#tab=teams&team=55477&name=X&vs=2026-27:5`, 'That head-to-head link is incomplete.'],
    'a season not in the archive': [`${MVLA}&vs=2019-20:5`, 'No 2019–20 season in this archive.'],
  };
  for (const [what, [h, note]] of Object.entries(bad)) {
    p.location.hash = h; p.loadFromHash();
    assert.deepEqual([p.get().teamView, p.get().h2hVs, p.get().h2hNote], ['history', null, note], what);
  }
  // a link to another view leaves the head to head
  for (const out of [`#season=2026-27&age=GU16&conf=NorCal&view=schedule`, `#tab=playoffs&season=2025-26`, `#tab=showcases&season=2025-26`, MVLA]) {
    p.location.hash = H2H; p.loadFromHash(); assert.equal(p.get().teamView, 'h2h');
    p.location.hash = out; p.loadFromHash();
    assert.deepEqual([p.get().teamView, p.get().h2hVs], ['history', null], out);
  }
});

test('pushHash writes vs= with a literal colon and never match=; saveState writes nothing while a head to head is open', () => {
  const p = page({ saved: saved() });
  const before = p.store['ecnl-dash-v2-state'];
  p.location.hash = H2H + '&match=1094466'; p.loadFromHash();
  p.pushHash();
  assert.equal(p.location.hash, H2H, 'canonical: vs= with its colon, no match=, no view=');
  p.saveState();
  assert.equal(p.store['ecnl-dash-v2-state'], before, 'the stored place is byte for byte unchanged');
  assert.ok(!/vs=|h2h/.test(p.store['ecnl-dash-v2-state']));
  assert.equal(p.T.history.length, 1, 'replaceState: no history entry');
});

test('MF2: every exit clears the head to head, and saveState writes again with the new place and no vs: Back to the Matches view, a season change, a tab switch, another team, the Overview and season tabs, the landing page', async () => {
  const open = (favs = []) => { const p = page({ saved: saved(), realTeam: false, favs }); p.location.hash = H2H; p.loadFromHash(); p.set({ currentTab: 'favorites' }); p.saveState(); assert.equal(p.store['ecnl-dash-v2-state'], JSON.stringify(saved()), 'while open: not written'); return p; };
  const wrote = (p, what) => {
    assert.equal(p.get().teamView === 'h2h' || p.get().h2hVs !== null, false, `${what}: the head to head state is cleared`);
    p.saveState();
    const s = JSON.parse(p.store['ecnl-dash-v2-state']);
    assert.notDeepEqual(s, saved(), `${what}: saveState writes again`);
    assert.ok(!/vs=|h2h/.test(JSON.stringify(s)), `${what}: no vs in the place`);
    return s;
  };
  let p = open(); await p.fire('#season=2026-27&age=GU16&conf=NorCal&view=schedule&team=55477');
  assert.equal(wrote(p, 'Back to the Matches view').view, 'schedule');
  p = open([['MVLA ECNL G2010/11', 55477]]); await p.changeSeason('2025-26');   // a followed team: a preview would show the Teams index, which saves nothing (#135)
  assert.equal(wrote(p, 'a season change').season, '2025-26');
  p = open(); p.switchTab('playoffs');
  assert.equal(wrote(p, 'a tab switch (Playoffs)').tab, 'playoffs');
  p = open(); await p.fire(`#tab=teams&season=2026-27&team=31529&name=${encodeURIComponent('Mustang SC ECNL G2010/11')}`);
  const s = wrote(p, 'another team'); assert.equal(s.teamPage.teamID, 31529);
  p = open(); p.selectTeamView('history');
  assert.equal(wrote(p, 'the Overview tab').tab, 'favorites');
  p = open(); p.selectTeamView('season');
  assert.equal(p.get().teamView, 'season'); wrote(p, 'the season tab');
  p = open(); p.showLanding({ focus: false });
  assert.equal(p.get().teamView, 'history'); assert.equal(p.get().h2hVs, null);
});

test('MF2 mutation: a guard on teamView alone would stop saving for good (the guard is scoped to My Teams)', () => {
  assert.match(html, /if \(currentTab === 'favorites' && teamView === 'h2h'\) return;/);
  assert.doesNotMatch(html, /\n\s+if \(teamView === 'h2h'\) return;/);
});

test('N-a: clicking team A itself in My Teams while its head to head is open opens the Overview', async () => {
  const p = page({ realTeam: false, favs: [['MVLA ECNL G2010/11', 55477]] });
  p.location.hash = H2H; p.loadFromHash();
  p.set({ currentTab: 'favorites' });
  p.selectFavorite('MVLA ECNL G2010/11');
  assert.deepEqual([p.get().teamView, p.get().h2hVs], ['history', null]);
  assert.deepEqual(p.T.loads.at(-1), ['team', 'history', 'MVLA ECNL G2010/11']);
});

test('the Overview and season tabs show a third tab only on a head to head', () => {
  const p = page(); p.set({ teamView: 'h2h' }); p.get();
  p.set({ teamView: 'h2h' }); p.showTeamViewTabs();
  assert.equal(p.el('viewTabH2H').hidden, false); assert.equal(p.el('viewTabH2H').attrs['aria-selected'], 'true');
  assert.equal(p.el('viewTabSchedule').attrs['aria-selected'], 'false', 'the season tab is not selected on a head to head');
  p.set({ teamView: 'season' }); p.showTeamViewTabs();
  assert.equal(p.el('viewTabH2H').hidden, true); assert.equal(p.el('viewTabSchedule').attrs['aria-selected'], 'true');
});

test('opening from a ready index fetches exactly the seasons both played (3 for MVLA v Mustang), none on reopening; cold: core, places and only those; the page draws no image and saves no place', async () => {
  const p = page({ saved: saved() });
  p.location.hash = H2H; p.loadFromHash();
  await p.sxLoad(); await p.sxGamesFetch([p.get().sxIndex.vocab.active]);
  p.T.fetched.length = 0;
  await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await p.settle();
  assert.deepEqual(p.T.fetched.sort(), ['search/games/2023-24', 'search/games/2024-25', 'search/games/2025-26']);
  const h = p.container._html;
  assert.match(h, /h2h-summary/); assert.ok(!/<img/.test(h), 'no image');
  assert.deepEqual([...h.matchAll(/<b>(\d+)<\/b><i>/g)].map(m => +m[1]), [1, 4, 3], 'MVLA v Mustang is 1-4-3');
  assert.match(text(h), /8 meetings played · 2023–24 to 2026–27/);
  assert.match(text(h), /Games from 2020–21 on: conference seasons, national events and showcases in this archive\. A game counts when both teams have a team page for that season/);
  p.T.fetched.length = 0;
  await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await p.settle();
  assert.deepEqual(p.T.fetched, [], 'reopening makes 0 requests');
  assert.equal(p.location.hash, H2H); assert.equal(p.el('viewTabH2H').hidden, false);
  // cold: nothing loaded; core and places, then only the seasons both played (N1: the active one only if both played it)
  const c = page(); c.location.hash = H2H; c.loadFromHash();
  await c.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await c.settle();
  assert.deepEqual(c.T.fetched.slice(0, 2).sort(), ['search/core', 'search/places']);
  assert.deepEqual(c.T.fetched.slice(2).sort(), ['search/games/2023-24', 'search/games/2024-25', 'search/games/2025-26', 'search/games/2026-27'], 'exactly the 4 seasons both played');
  // N1: a pair that did not play the active season never loads it
  const d = page(); d.location.hash = `#tab=teams&season=2024-25&team=${S0TEAM.a}&name=x&vs=2024-25:${S0TEAM.b}`; d.loadFromHash();
  await d.loadTeamSummary({ name: 'x', teamID: S0TEAM.a }); await d.settle();
  assert.ok(!d.T.fetched.includes('search/games/2026-27'), d.T.fetched.join());
});
// a pair with no 2026-27 season in common, found in the fixture's directory
const S0TEAM = (() => {
  const ix = S.buildIndex(fresh());
  for (const d of ix.teams.docs) for (const e of ix.teams.docs) {
    if (d === e || d.club.id !== e.club.id) continue;
    const r = d.rows.find(x => x.season === '2024-25'), q = e.rows.find(x => x.season === '2024-25');
    if (r && q && !S.h2hSeasons(ix, [d], [e]).both.includes('2026-27') && S.h2hSeasons(ix, [d], [e]).both.includes('2024-25')) return { a: r.teamID, b: q.teamID };
  }
  throw new Error('no pair');
})();

test('bad vs: A\'s Overview opens with a note naming the season (a team with no squad that season, an unknown season, the same team); no games file is fetched; the address drops vs', async () => {
  const run = async hash => {
    const p = page(); p.location.hash = hash; p.loadFromHash();
    await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await p.settle();
    return p;
  };
  let p = await run(`${MVLA}&vs=2025-26:113270`);   // an RL team with no squad
  assert.deepEqual(p.T.loads.at(-1), ['overview', 'MVLA ECNL G2010/11'], 'A\'s Overview opens');
  assert.match(text(p.el('h2hNote').innerHTML), /^ This head to head can’t open .+ has no team page for 2025–26, so there is no squad to compare\. Here is MVLA ECNL G2010\/11’s overview instead\.$/);
  assert.match(p.el('h2hNote').innerHTML, /Team 113270 has no team page for 2025–26/, 'no games file loaded for that season: its id, no request to learn its name');
  assert.deepEqual(p.T.fetched, ['search/core', 'search/places'], 'a head to head that cannot open fetches no games file');
  p.pushHash(); assert.equal(p.location.hash, MVLA, 'the address drops vs');
  p = await run(`${MVLA}&vs=2026-27:55477`);
  assert.match(text(p.el('h2hNote').innerHTML), /Both sides are the same team/);
  p = await run(`${MVLA}&vs=2019-20:5`);
  assert.match(text(p.el('h2hNote').innerHTML), /No 2019–20 season in this archive/);
  assert.deepEqual(p.T.fetched, [], 'a season not in the archive makes no request');
  // live mode: no fetch, and the words say so
  const l = page({ live: true }); l.location.hash = H2H; l.loadFromHash();
  await l.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await l.settle();
  assert.deepEqual(l.T.fetched, []); assert.match(text(l.el('h2hNote').innerHTML), /needs the archive and isn’t available in live mode/);
  // the note goes with the next load
  p.set({ teamView: 'history' }); await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 });
  assert.equal(p.el('h2hNote').hidden, true, 'cleared by the next load');
});

test('a search that is refused: the page\'s retry box with Try again; a games season that fails says which and offers Try again', async () => {
  const p = page({ fetchFail: path => (path === 'search/core' ? Object.assign(new Error('x'), { status: 503 }) : null) });
  p.location.hash = H2H; p.loadFromHash();
  await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await p.settle();
  assert.ok(p.container.kids.some(k => k.warn), 'the load warning with its retry');
  const q = page({ fetchFail: path => (path === 'search/games/2024-25' ? Object.assign(new Error('x'), { status: 503 }) : null) });
  q.location.hash = H2H; q.loadFromHash();
  await q.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await q.settle();
  assert.ok(q.el('h2hFail').kids.some(k => k.warn && typeof k.retry === 'function'), 'Try again');
  assert.match(q.container._html, /h2h-summary/, 'what did load is shown');
});

// ---------- the regroup control ----------
const toggle = async (p, side, i, on = true) => { p.box.on.change({ target: { dataset: { side, i: String(i) }, checked: on } }); await p.settle(); await wait(10); };
test('regroup: nothing is checked for the visitor; adding an earlier team fetches only its new seasons and the record grows; the choice is kept for the visit', async () => {
  const hash = `#tab=teams&season=2026-27&team=60044&name=${encodeURIComponent('Force (CA) ECNL G2009/10')}&vs=2022-23:33633`;
  const p = page(); p.location.hash = hash; p.loadFromHash();
  await p.loadTeamSummary({ name: 'Force (CA) ECNL G2009/10', teamID: 60044 }); await p.settle();
  assert.equal((p.container._html.match(/<input type="checkbox"[^>]* checked/g) || []).length, 0, 'none is checked');
  assert.match(p.container._html, /Earlier teams it may continue \(2\)/);
  assert.match(p.container._html, /Loads 4 seasons/);
  assert.match(text(p.container._html), /1 meeting played · 1 upcoming/);
  p.T.fetched.length = 0;
  await toggle(p, 'a', 1);   // 2022-23/62271
  assert.deepEqual(p.T.fetched.sort(), ['search/games/2022-23', 'search/games/2023-24', 'search/games/2024-25', 'search/games/2025-26'], 'only the seasons both now played and not loaded');
  assert.match(text(p.container._html), /9 meetings played · 1 upcoming/);
  assert.match(p.container._html, /Added · 8 meetings/);
  assert.match(text(p.container._html), /Includes Force \(CA\) ECNL G10, added above/);
  assert.match(p.container._html, /id="h2hLive" role="status" aria-live="polite">Added Force \(CA\) ECNL G10</, 'the live region says what was added');
  // kept for the visit: a fresh load of the same pair shows it
  await p.loadTeamSummary({ name: 'Force (CA) ECNL G2009/10', teamID: 60044 }); await p.settle();
  assert.match(text(p.container._html), /9 meetings played · 1 upcoming/);
  await toggle(p, 'a', 1, false);
  assert.match(text(p.container._html), /1 meeting played · 1 upcoming/, 'removing it');
  assert.deepEqual(p.get().h2hChosen.get('2026-27/60044|2022-23/33633').a, [], 'the squads themselves are untouched (nothing is merged)');
});

test('N-b, MF3: SLSG Navy v Green G2013/14: a team added on one side is disabled on the other with its reason; each side adding its own G13 team brings in the 2025-26 derby; the reason text has the panel\'s secondary colour', async () => {
  const hash = `#tab=teams&season=2026-27&team=134824&name=${encodeURIComponent('SLSG Navy ECNL G2013/14')}&vs=2026-27:134825`;
  const p = page(); p.location.hash = hash; p.loadFromHash();
  await p.loadTeamSummary({ name: 'SLSG Navy ECNL G2013/14', teamID: 134824 }); await p.settle();
  const names = h => [...h.matchAll(/<b>([^<]+)<\/b><small>/g)].map(m => m[1]);
  assert.deepEqual(names(p.container._html), ['SLSG Green ECNL G13', 'SLSG Navy ECNL G13', 'SLSG Green ECNL G13', 'SLSG Navy ECNL G13'], 'both list the same two teams');
  assert.ok(!/disabled/.test(p.container._html));
  await toggle(p, 'a', 1);   // Navy adds Navy G13
  assert.match(p.container._html, /<label class="h2h-cand off"><input type="checkbox" id="h2h-c-b-1" disabled aria-describedby="rgb h2h-c-b-1-why"><span><b>SLSG Navy ECNL G13<\/b>/);
  assert.match(p.container._html, /id="h2h-c-b-1-why">Added on the other side</);
  assert.match(text(p.container._html), /Added · 0 meetings/, 'Navy G13 against Green G13/14 alone: none');
  assert.ok(!/class="us-sr" id="h2hNote"/.test(p.container._html));
  await toggle(p, 'b', 0);   // Green adds its own G13 team
  assert.ok(!/Same team/.test(p.container._html));
  const n = +/(\d+) meetings? played/.exec(text(p.container._html))[1];
  assert.ok(n >= 2, `${n} meetings`);
  assert.match(p.container._html, /Added · [1-9]\d* meetings?/, 'each side adding its own G13 brings in the derby of 2025-26');
  assert.match(html, /\.h2h-cand\.off \.h2h-cost \{ color: var\(--text-secondary\); \}/, 'the reason is readable: the secondary text colour, not a fade');
  assert.doesNotMatch(html, /\.h2h-cand\.off \{[^}]*opacity/);
});

// ---------- search: the lead row, the H2H cells, the action bar ----------
test('search: the lead row is the active cell and opens the head to head; every game row has an H2H gridcell in column 1 reached with the right arrow; the action bar has a Head to head link; unlinked rows say why', async () => {
  const p = page();
  const inp = p.el('usearchInput'); inp.value = 'MVLA 2011 vs Mustang 2011';
  p.sxOpen(inp); await p.get().sxLoadP; await wait(0);
  await p.sxLoad(); await p.sxGamesFetch([p.get().sxIndex.vocab.active]); await wait(20);
  p.sxRun('MVLA 2011 vs Mustang 2011'); p.sxFlush();
  const v = p.get().sxView, cells = v.cells;
  assert.equal(cells[p.get().sxActive].kind, 'h2h', 'the lead row is the active cell');
  const lead = cells.find(c => c.kind === 'h2h');
  assert.match(lead.href, /&vs=2026-27:31529$/);
  assert.equal(p.get().sxView.slate.enter.kind, 'h2h');
  const games = cells.filter(c => c.game), chips = cells.filter(c => c.kind === 'chip');
  assert.ok(games.length >= 2 && chips.length === games.length, 'one H2H cell per game row');
  for (const c of chips) { assert.equal(c.col, 1); assert.equal(c.row, cells.find(g => g.game && g.game.matchID === c.hgame.matchID).row, 'on its game\'s row'); assert.match(c.href, /&vs=2026-27:\d+&match=\d+$/); }
  assert.match(p.el('usearchList')._html, /role="gridcell" class="sx-chip sxg-h2h" id="sx-c-\d+" data-c="\d+" aria-selected="false" title="Head to head" aria-label="Head to head: Mustang SC against MVLA"/);
  assert.match(p.el('sxKeys').innerHTML, /→<\/kbd> H2H/);
  // the bar for the lead row, then Enter opens the head to head
  assert.equal(p.el('usearchOpen').textContent, 'Open head to head'); assert.equal(p.el('usearchOpen').href, lead.href);
  // a game cell's bar carries a Head to head link, and the right arrow reaches the H2H cell
  const input = p.el('usearchInput');
  const key = (k, extra = {}) => { const e = { key: k, shiftKey: false, preventDefault() { }, target: input, ...extra }; input.on.keydown(e); };
  key('ArrowDown');
  assert.equal(p.get().sxView.cells[p.get().sxActive].kind, 'game');
  assert.equal(p.el('usearchH2H').hidden, false); assert.match(p.el('usearchH2H').href, /vs=2026-27:\d+&match=/);
  key('ArrowRight');
  assert.equal(p.get().sxView.cells[p.get().sxActive].kind, 'chip', 'right arrow: the H2H cell');
  assert.match(p.el('sxKeys').innerHTML, /the game · <kbd>Enter<\/kbd> head to head/);
  key('ArrowLeft');
  assert.equal(p.get().sxView.cells[p.get().sxActive].kind, 'game', 'left arrow: back to the game');
  key('ArrowRight');
  key('Enter');
  assert.match(p.location.hash, /vs=2026-27:\d+&match=\d+$/, 'Enter on the H2H cell opens the head to head, on that meeting');
});

test('search: a pairing row of one squad pair has an H2H cell and the note; a game with a side that has no team page has an empty reserved cell and the bar says why', async () => {
  const p = page();
  const inp = p.el('usearchInput'); inp.value = 'MVLA vs Mustang';
  p.sxOpen(inp); await p.get().sxLoadP; await p.sxLoad(); await p.sxGamesFetch([p.get().sxIndex.vocab.active]); await wait(20);
  p.sxRun('MVLA vs Mustang'); p.sxFlush();
  const cells = p.get().sxView.cells;
  const pr = cells.filter(c => c.kind === 'pairing'), chips = cells.filter(c => c.kind === 'chip' && !c.hgame);
  assert.ok(pr.length > 1 && chips.length === pr.length, 'one H2H cell per pairing row');
  assert.match(p.el('usearchList')._html, /Earlier seasons are added when you open the head to head\./);
  assert.ok(chips.every(c => c.act === 'Head to head' && /&vs=\d{4}-\d{2}:\d+$/.test(c.href)));
  // an Oregon Surf 2011 game against a team with no squad
  const q = page(); const i2 = q.el('usearchInput'); i2.value = 'x';
  q.sxOpen(i2); await q.get().sxLoadP; await q.sxLoad(); await q.sxGamesFetch(['2025-26']); await wait(20);
  q.sxRun('Oregon Surf 2011 2025-26'); q.sxFlush();
  q.sxActivate(q.get().sxView.cells.findIndex(c => c.kind === 'more' && c.section === 'games')); q.sxFlush();   // Show all
  const gl = q.get().sxView.cells.filter(c => c.game);
  const bare = gl.find(c => !c.game.row.h2hHref && c.game.home.teamID && c.game.away.teamID);
  assert.ok(bare, 'a game between a squad and a team with no team page');
  assert.match(q.el('usearchList')._html, /<span class="sxg-h2hgap" aria-hidden="true"><\/span>/, 'the column is reserved');
  const set = q.get().sxView.cells.indexOf(bare);
  const key = (k) => { const e = { key: k, shiftKey: false, preventDefault() { }, target: i2 }; i2.on.keydown(e); };
  for (let k = 0; k < 60 && q.get().sxActive !== set; k++) key('ArrowDown');
  assert.match(q.el('usearchActive').textContent, /has no team page for 2025–26, so this game has no head to head$/);
  assert.equal(q.el('usearchH2H').hidden, true);
});

// ---------- the Matches cards and the team's schedule rows ----------
test('Matches cards: Head to head only when both sides are in the division\'s standings; side A is the selected team when it plays, else home; the link carries match=; 0 requests', () => {
  const p = page();
  const flights = [{ standings: { teamStandings: [{ teamID: 10 }, { teamID: 20 }, { teamID: 30 }] } }];
  p.set({ currentFlightData: flights, currentSeason: '2026-27', selectedTeamID: null });
  const link = p.h2hCardLinker();
  const g = { matchID: 5, hometeamID: 10, awayteamID: 20, homeTeam: 'Home FC', awayTeam: 'Away FC', homeTeamClub: 'Home', awayTeamClub: 'Away', gameTimeText: '9:00 AM', hometeamscore: null, awayteamscore: null };
  const h = p.matchRowHtml(g, { today: TODAY, h2h: link });
  assert.match(h, /<a class="match-h2h" href="#tab=teams&amp;season=2026-27&amp;team=10&amp;name=Home%20FC&amp;vs=2026-27:20&amp;match=5" aria-label="Head to head: Home FC against Away FC">Head to head<\/a>/);
  assert.match(p.matchRowHtml({ ...g, hometeamID: 99 }, { today: TODAY, h2h: link }), /match-where"|^(?!.*match-h2h)/s);
  assert.ok(!/match-h2h/.test(p.matchRowHtml({ ...g, hometeamID: 99 }, { today: TODAY, h2h: link })), 'a side outside the standings: no link');
  p.set({ selectedTeamID: 20 });
  assert.match(p.matchRowHtml(g, { today: TODAY, h2h: p.h2hCardLinker() }), /team=20&amp;name=Away%20FC&amp;vs=2026-27:10&amp;match=5/);
  assert.ok(!/match-h2h/.test(p.matchRowHtml(g, { today: TODAY })), 'without the linker a card is as before');
  assert.ok(!/match-h2h/.test(p.matchRowHtml({ ...g, hometeamID: null }, { today: TODAY, h2h: link })));
  assert.deepEqual(p.T.fetched, []);
});

test('the team\'s schedule rows: H2H under the score when the opponent is in the season\'s team index; a refused index, live mode and a left page give none', async () => {
  const mk = () => {
    const rows = [['1', 'A', 'B'], ['2', 'A', 'C'], ['3', 'D', 'A']].map(([m, x, y]) => ({ m, names: [x, y], added: [] }));
    const panel = { querySelectorAll: () => rows.map(r => ({ dataset: { match: r.m }, querySelectorAll: sel => (sel === 'td' ? [{}, {}, { insertAdjacentHTML: (w, h) => r.added.push(h) }] : r.names.map(n => ({ textContent: n }))) })) };
    return { rows, panel };
  };
  const games = [{ matchID: 1, hometeamID: 7, awayteamID: 8 }, { matchID: 2, hometeamID: 7, awayteamID: 9 }, { matchID: 3, hometeamID: 8, awayteamID: 7 }];
  const rec = { name: 'MVLA ECNL G2010/11', teamID: 7 };
  const run = async (opts, token) => { const p = page(opts), { rows, panel } = mk(); await p.h2hSeasonLinks(panel, rec, 7, '2026-27', games, token === undefined ? p.get().teamToken : token); return rows.map(r => r.added.join('')); };
  const out = await run({ teamIndex: [{ teamID: 7 }, { teamID: 8 }] });
  assert.match(out[0], /^<a class="sched-h2h" href="#tab=teams&season=2026-27&team=7&name=MVLA%20ECNL%20G2010%2F11&vs=2026-27:8&match=1" aria-label="Head to head: A against B">H2H<\/a>$/);
  assert.equal(out[1], '', 'an opponent outside the season\'s team index: no link');
  assert.match(out[2], /vs=2026-27:8&match=3/, 'side A is the team, whichever side it played');
  assert.deepEqual(await run({ teamIndex: null }), ['', '', ''], 'no index');
  assert.deepEqual(await run({ teamIndex: Object.assign(new Error('x'), { status: 429 }) }), ['', '', ''], 'a refused index: no links');
  assert.deepEqual(await run({ live: true, teamIndex: [{ teamID: 7 }, { teamID: 8 }] }), ['', '', ''], 'live mode');
  assert.deepEqual(await run({ teamIndex: [{ teamID: 7 }, { teamID: 8 }] }, -1), ['', '', ''], 'the page was left while the index loaded');
});

test('match=: the meeting a link names is marked and focused once; one that is not there gets a note and the title; match= is never written to the address', async () => {
  const make = id => ({ classes: [], tab: null, focused: 0, classList: { add(c) { this.owner.classes.push(c); } }, setAttribute() {}, focus() { this.focused++; }, getBoundingClientRect: () => ({ top: 300 }), get owner() { return this; } });
  const p = page(); const el = make(); el.classList.owner = el;
  p.matchEls.set('1094466', el);
  p.location.hash = `${H2H}&match=1094466`; p.loadFromHash();
  await p.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await p.settle();
  assert.deepEqual([el.classes, el.focused, p.get().h2hMatch], [['is-match'], 1, null], 'marked and focused once, then dropped');
  assert.ok(!/match=/.test(p.location.hash), p.location.hash);
  const q = page(); q.location.hash = `${H2H}&match=5`; q.loadFromHash();
  await q.loadTeamSummary({ name: 'MVLA ECNL G2010/11', teamID: 55477 }); await q.settle();
  assert.match(q.container._html, /class="match-gone" role="status">This game isn’t in this head to head/);
  assert.equal(q.T.titleFocus, 1, 'focus goes to the title');
});

test('line endings: index.html keeps one line-ending style, and the head-to-head block is in it exactly once', () => {
  const raw = readFileSync(new URL('public/index.html', ROOT), 'utf8');
  const crlf = (raw.match(/\r\n/g) || []).length, lf = (raw.match(/\n/g) || []).length;
  assert.ok(crlf === 0 || crlf === lf, `one style: ${crlf} CRLF of ${lf} line ends`);   // a Windows checkout may be all CRLF; a mix is the bug
  assert.equal(raw.split('// ===== #178: head to head =====').length, 2);
});
