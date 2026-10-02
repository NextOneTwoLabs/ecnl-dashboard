// #114 (owner decision, 2026-10-01): a team page opens on Overview (#107's History view) and its
// tabs read "Overview | Current season" (or "Overview | 2024–25 season"). The page's own code
// (public/index.html), extracted block by block as in tests/conference-return.test.mjs, run
// against a fake DOM: the default view per entry point, the season tab's label, &view=season
// round-tripping, the legacy &view=history, S11 (another team opens on Overview), and the links
// that open a team page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ACTIVE_SEASON = JSON.parse(readFileSync(new URL('../public/data/sources.json', import.meta.url), 'utf8')).refresh.activeSeason;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const CODE = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    function getSeasonData()'), line('    function seasonLabel('),
  block('    function saveState('), block('    function pushHash('), block('    function loadFromHash('),
  block('    function sameTeam('),
  block("    // The team page's view tabs (#114", 'function showTeamViewTabs('),
  block('    function selectTeamView('),
  block('    async function loadTeamSummary('),
  block('    function historyAvailable('), block('    async function loadTeamHistory('),
].join('\n');

const SEASONS = {
  '2026-27': { conferences: { 'Mid-Atlantic': { eventId: 4263 } } },
  '2024-25': { conferences: { 'Mid-Atlantic': { eventId: 3157 } } },
};
const SOURCES = { refresh: { activeSeason: '2026-27' }, seasons: SEASONS };
const seasonOf = id => Object.keys(SEASONS).find(s => Object.values(SEASONS[s].conferences).some(c => c.eventId === id));

function page({ live = false, history = { squads: [{}] } } = {}) {
  const els = new Map();
  const node = id => ({ id, style: {}, textContent: '', innerHTML: '', classList: { toggle(c, on) { this[c] = on; }, add() {}, remove() {}, contains: () => false },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, querySelector: () => node(), append() {}, appendChild() {} });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const location = { hash: '' };
  const calls = { history: [], season: [], locate: 0 };
  const stubs = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => node() },
    window: { location, addEventListener() {} }, location, history: { replaceState: (_s, _t, h) => { location.hash = h; } },
    localStorage: { setItem() {}, getItem: () => null }, SEASONS, SOURCES,
    getEventHierarchy: async id => { calls.season.push(id); return { girlsDivAndFlightList: [] }; },
    getStandings: async () => ({ teamStandings: [] }), getSchedule: async () => [],
    esc: s => String(s), clearTeamFilter() {}, syncSeasonUI() {}, buildFavoritesList() {},
    resolveFavorite: async () => { calls.locate++; return true; },
    eventContext: id => ({ season: seasonOf(id), name: 'Mid-Atlantic', kind: 'conference' }),
    // Overview: the real loader, with its history answer stubbed (null: no file, as a 404).
    LIVE: live, teamHistoryMissing: new Set(), historyCrumb() {}, openSeason: () => ACTIVE_SEASON,
    getTeamHistory: async id => { calls.history.push(id); return history; },
    renderTeamHistory: () => { el('standingsContainer').innerHTML = 'OVERVIEW'; },
    computeTeamSummary: () => ({ mine: [], form: [], next: null }), getStandingsUrl: () => '', glancePanelHtml: () => '',
    loadWarning: () => node(), renderStandingsTable: () => node(), renderScheduleTable: () => node(), failedFlightPanel: () => node(),
    shortTeamName: n => n, teamShowcaseSections: async () => [], NATIONAL_EVENTS: {}, loadClubPlaces: async () => {}, clubPlaces: null,
    isMissing: () => false, retryText: e => String(e),
  };
  const api = new Function(...Object.keys(stubs), CODE + `
    return { loadFromHash, pushHash, showTeamViewTabs, selectTeamView, loadTeamSummary, teamSeasonTabLabel,
      missing: id => teamHistoryMissing.add(String(id)),
      view: () => teamView, setSeason: s => { currentSeason = s; }, tab: () => currentTab, preview: () => previewTeam };`)(...Object.values(stubs));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const tabs = () => [el('viewTabStandings').textContent, el('viewTabSchedule').textContent];
  const overviewShown = () => el('viewTabStandings').style.display !== 'none';
  const active = () => (el('viewTabStandings').attrs['aria-selected'] === 'true' ? 'overview' : 'season');
  return { ...api, location, calls, flush, tabs, active, overviewShown };
}
const A = { teamID: 55477, name: 'MVLA ECNL G2010/11', eventID: 4263, divisionID: 1, flightID: 2 };
const B = { teamID: 33438, name: 'MVLA ECNL G08', eventID: 3157, divisionID: 1, flightID: 2 };

test('a cold team link with no view opens Overview; &view=history and &view=overview too', () => {
  for (const [hash, view] of [['#tab=teams&season=2026-27&team=55477&name=MVLA', 'history'],
    ['#tab=teams&season=2026-27&team=55477&view=history', 'history'], ['#tab=teams&season=2026-27&team=55477&view=overview', 'history'],
    ['#tab=teams&season=2026-27&team=55477&view=season', 'season']]) {
    const p = page();
    p.location.hash = hash;
    assert.equal(p.loadFromHash(), true);
    assert.equal(p.view(), view, hash);
  }
});

test('&view=season round-trips: pushHash writes it for the season tab, and nothing for Overview', () => {
  const p = page();
  p.location.hash = '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08&view=season';
  p.loadFromHash();
  p.pushHash();
  assert.equal(p.location.hash, '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08&view=season');
  p.location.hash = '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08&view=history';   // a #107 link
  p.loadFromHash();
  p.pushHash();
  assert.equal(p.location.hash, '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08', 'Overview needs no view');
});

test('the tabs read "Overview | Current season" in the active season, "Overview | 2024–25 season" before', () => {
  const p = page();
  p.setSeason('2026-27'); p.showTeamViewTabs();
  assert.deepEqual(p.tabs(), ['Overview', 'Current season']);
  assert.equal(p.active(), 'overview', 'Overview is the default');
  p.setSeason('2024-25'); p.showTeamViewTabs();
  assert.deepEqual(p.tabs(), ['Overview', '2024–25 season']);
  assert.equal(p.teamSeasonTabLabel('2026-27'), 'Current season');
});

test('My Teams opens a followed team on Overview, in its own season, and the season tab names that season', async () => {
  const p = page();
  p.setSeason('2026-27');
  await p.loadTeamSummary({ ...B });
  await p.flush();
  assert.equal(p.view(), 'history');
  assert.deepEqual(p.calls.history, [33438]);
  assert.deepEqual(p.calls.season, [], 'Overview reads no event tables');
  assert.equal(p.calls.locate, 0, 'nor looks the team up first (V17)');
  assert.deepEqual(p.tabs(), ['Overview', '2024–25 season']);
});

test('the season tab, then another team: that team opens on Overview (S11); the same team keeps its tab', async () => {
  const p = page();
  p.location.hash = '#tab=teams&season=2026-27&team=55477&name=MVLA%20ECNL%20G2010%2F11&view=season';
  p.loadFromHash();
  await p.loadTeamSummary({ ...A });
  await p.flush();
  assert.equal(p.view(), 'season');
  assert.equal(p.active(), 'season');
  assert.deepEqual(p.calls.season, [4263], 'the season tab reads its tables');
  await p.loadTeamSummary({ ...A });                  // the same team again: its tab stays
  assert.equal(p.view(), 'season');
  await p.loadTeamSummary({ ...B });                  // another team: Overview
  await p.flush();
  assert.equal(p.view(), 'history');
  assert.equal(p.active(), 'overview');
});

test('the tab order is Overview first: the left tab (Standings slot) is Overview, the right one the season', () => {
  const sel = html.slice(html.indexOf('\n    function selectView('), html.indexOf('\n    function selectView(') + 300);
  assert.match(sel, /selectTeamView\(view === 'standings' \? 'history' : 'season'\)/);
});

test('links that open a team page: Overview unless they name the season tab', () => {
  // The glance card: "Team overview →" (no view) and "<season> page →" (&view=season).
  const glance = block('    function glancePanelHtml(');
  assert.match(glance, /&name=\$\{encodeURIComponent\(team\.name\)\}">Team overview →<\/a>/);
  assert.match(glance, /&view=season">\$\{esc\(teamSeasonTabLabel\(ctx\.season\)\)\} page →<\/a>/);
  assert.ok(!/Season-by-season history|Full team page/.test(glance));
  // The showcase table's team link: no view, so Overview.
  const sc = html.slice(html.indexOf('class="sc-team-link"'), html.indexOf('class="sc-team-link"') + 300);
  assert.ok(!sc.includes('view='));
  // Overview's own links: "Team page" per season opens that season's tab; refs open Overview.
  const pageHref = new Function(line('    const pageHref = ') + '\nreturn pageHref;')();
  const r = { season: '2024-25', teamID: 33438, name: 'MVLA ECNL G08' };
  assert.equal(pageHref(r), '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08&view=season');
  assert.equal(pageHref(r, true), '#tab=teams&season=2024-25&team=33438&name=MVLA%20ECNL%20G08');
});

test('no visitor-facing "History" label is left on the team page or in search', () => {
  for (const s of ["'This season'", '>History<', 'Season-by-season history', "'Team history'", 'Shift</kbd>+<kbd>Enter</kbd> history'])
    assert.ok(!html.includes(s), s);
  assert.ok(html.includes('<a id="usearchOpen" href="#">Overview</a>'));
});

test('MF2: in live mode (no history route) a team page opens on its season tab, with no Overview tab', async () => {
  const p = page({ live: true });
  p.location.hash = '#tab=teams&season=2026-27&team=55477&name=MVLA%20ECNL%20G2010%2F11';
  p.loadFromHash();
  await p.loadTeamSummary({ ...A });
  await p.flush();
  assert.equal(p.view(), 'season');
  assert.equal(p.overviewShown(), false);
  assert.deepEqual(p.calls.history, [], 'no history request');
  assert.deepEqual(p.calls.season, [4263], 'the season tab reads its tables');
  await p.loadTeamSummary({ ...B });                  // another team, still live: the season tab
  assert.equal(p.view(), 'season');
});

test('SC1: a team with no history file opens on its season tab, and Overview is not offered', async () => {
  const p = page({ history: null });                  // the route answered 404
  await p.loadTeamSummary({ ...A });
  await p.flush();
  assert.equal(p.view(), 'season');
  assert.deepEqual(p.calls.history, [55477], 'asked once');
  assert.deepEqual(p.calls.season, [4263], 'then its season tab');
  assert.equal(p.overviewShown(), false);
  const q = page();
  q.missing(33438);                                   // already known to have no file
  await q.loadTeamSummary({ ...B });
  await q.flush();
  assert.equal(q.view(), 'season');
  assert.deepEqual(q.calls.history, []);
  const r = page();                                   // and a team that has one keeps Overview
  await r.loadTeamSummary({ ...A });
  await r.flush();
  assert.equal(r.overviewShown(), true);
});

// SC2: the search wiring that only a browser covered (prreview122b F3, F7, V18, V19).
const uiBlock = (head, last = head) => block(head, last);
test('search wiring: the status line follows the engine, Shift+Enter and the season link open the season tab', () => {
  const status = uiBlock('    function usStatus(');
  assert.match(status, /if \(res\.currentOnly\) bits\.push\(`playing in /, 'F3: "playing in" only for a current-only list');
  assert.ok(!/placeOnly/.test(status));
  const go = uiBlock('    function usGo(');
  assert.match(go, /to === 'season' \? r\.seasonHref : to === 'overview' \? r\.overviewHref : r\.href/);
  const key = uiBlock('    function usKey(');
  assert.match(key, /usGo\(usActiveIdx, e\.shiftKey \? 'season' : null\)/, 'V18');
  assert.match(html, /usGo\(usActiveIdx, id === 'usearchHist' \? 'season' : 'overview'\)/, 'V19');
  assert.match(html, /hl\.href = r\.seasonHref;/);
});

test('search wiring: a code with no club and no name says so (F7)', () => {
  const code = line('    const usPlaceWord = ') + uiBlock('    function usEmptyText(');
  const usEmptyText = new Function('esc', code + '\nreturn usEmptyText;')(x => String(x));
  const p = { text: [], places: [], codes: [{ code: 'RI', strict: true }], conf: null };
  assert.equal(usEmptyText('RI', p, { note: { kind: 'name', code: 'RI', label: 'Rhode Island', n: 0 } }),
    'No teams based in Rhode Island, and no team has “RI” in its name.');
  assert.equal(usEmptyText('NJ NY', { ...p, codes: [{}, {}] }, { note: null }), 'No team is based in any of those places.');
});
