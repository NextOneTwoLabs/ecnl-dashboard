// #114 (owner decision, 2026-10-01): a team page opens on Overview (#107's History view) and its
// tabs read "Overview | Current season" (or "Overview | 2024–25 season"). The page's own code
// (public/index.html), extracted block by block as in tests/conference-return.test.mjs, run
// against a fake DOM: the default view per entry point, the season tab's label, &view=season
// round-tripping, the legacy &view=history, S11 (another team opens on Overview), and the links
// that open a team page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
].join('\n');

const SEASONS = {
  '2026-27': { conferences: { 'Mid-Atlantic': { eventId: 4263 } } },
  '2024-25': { conferences: { 'Mid-Atlantic': { eventId: 3157 } } },
};
const SOURCES = { refresh: { activeSeason: '2026-27' }, seasons: SEASONS };
const seasonOf = id => Object.keys(SEASONS).find(s => Object.values(SEASONS[s].conferences).some(c => c.eventId === id));

function page() {
  const els = new Map();
  const node = id => ({ id, style: {}, textContent: '', innerHTML: '', classList: { toggle(c, on) { this[c] = on; }, add() {}, remove() {}, contains: () => false },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, querySelector: () => node(), append() {}, appendChild() {} });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const location = { hash: '' };
  const calls = { history: [], season: [] };
  const stubs = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => node() },
    window: { location, addEventListener() {} }, location, history: { replaceState: (_s, _t, h) => { location.hash = h; } },
    localStorage: { setItem() {}, getItem: () => null }, SEASONS, SOURCES,
    getEventHierarchy: async id => { calls.season.push(id); return { girlsDivAndFlightList: [] }; },
    getStandings: async () => ({ teamStandings: [] }), getSchedule: async () => [],
    esc: s => String(s), clearTeamFilter() {}, syncSeasonUI() {}, buildFavoritesList() {},
    resolveFavorite: async () => true, eventContext: id => ({ season: seasonOf(id), name: 'Mid-Atlantic', kind: 'conference' }),
    loadTeamHistory: async (rec, season) => { calls.history.push([rec.teamID, season]); },
    computeTeamSummary: () => ({ mine: [], form: [], next: null }), getStandingsUrl: () => '', glancePanelHtml: () => '',
    loadWarning: () => node(), renderStandingsTable: () => node(), renderScheduleTable: () => node(), failedFlightPanel: () => node(),
    shortTeamName: n => n, teamShowcaseSections: async () => [], NATIONAL_EVENTS: {}, loadClubPlaces: async () => {}, clubPlaces: null,
    isMissing: () => false, retryText: e => String(e),
  };
  const api = new Function(...Object.keys(stubs), CODE + `
    return { loadFromHash, pushHash, showTeamViewTabs, selectTeamView, loadTeamSummary, teamSeasonTabLabel,
      view: () => teamView, setSeason: s => { currentSeason = s; }, tab: () => currentTab, preview: () => previewTeam };`)(...Object.values(stubs));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const tabs = () => [el('viewTabStandings').textContent, el('viewTabSchedule').textContent];
  const active = () => (el('viewTabStandings').attrs['aria-selected'] === 'true' ? 'overview' : 'season');
  return { ...api, location, calls, flush, tabs, active };
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
  assert.deepEqual(p.calls.history, [[33438, '2024-25']]);
  assert.deepEqual(p.calls.season, [], 'Overview reads no event tables');
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
