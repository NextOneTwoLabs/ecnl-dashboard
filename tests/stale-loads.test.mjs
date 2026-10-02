// #120, #99, #121. A load of the main pane that the viewer has left must neither paint over
// what is on screen now nor ask for anything more: the team page (#120, teamToken) and the
// Playoffs (#99: playoffToken for the panel, playoffFlightToken for a competition) take a token at
// the start of each load and check it after every await, and switchTab drops them. R1-R4 are the
// Reviewer's scenarios from the plan review. The page's own code (public/index.html), extracted block by
// block as in tests/conference-return.test.mjs, run against a fake DOM with counted, held stubs.
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
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),          // the page's state
  line('    let loadToken = 0;'),
  block('    const TOP_TABS = ', 'function closeMyTeams('), block('    function switchTab('),
  block('    function getNationalEventsForSeason('), block('    function getPlayoffCacheKey('),
  block('    function currentNationalEvent('), block('    function tierLabel('), block('    function buildStageTabs('),
  block('    function buildPlayoffTierList('), block('    async function loadPlayoffsPanel('),
  block('    async function loadPlayoffAgeGroups('), block('    function buildPlayoffAgeGroupTabs('),
  block('    function selectStage('), block('    function selectPlayoffTier('), block('    function selectPlayoffAgeGroup('),
  block('    async function loadPlayoffFlight('),
  block('    async function changeSeason('),
  block('    async function showcaseFlightsForTeam('), block('    async function teamShowcaseSections('),
  block('    async function loadTeamSummary('),
  block('    function historyAvailable('), block('    function overviewAvailable('),
  block('    async function loadTeamHistory('),             // Overview, the team page's default (#114)
  // #135 P1a: the landing page and the Teams index, which switchTab calls.
  block('    // ========== LANDING (#135 P1a)', 'async function renderTeamsIndex('),
].join('\n');

const NOINDEX = { on: false };   // no team index (?live=1, a 404): showcases are found by scanning
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
// A followed 2025-26 team (already located), two showcases it played, and a national event with
// two competitions in its age group, each with one of its games.
const TEAM = { name: 'Followed team', teamID: 9, eventID: 3926, divisionID: 39261, flightID: 392601 };
const HIER = {
  3926: [{ divisionID: 39261, divisionName: 'G2011', flightList: [{ flightID: 392601, flightName: 'ECNL' }] }],
  600: [{ divisionID: 61, divisionName: 'G2011', flightList: [{ flightID: 6001, flightName: 'Champions League' }, { flightID: 6002, flightName: 'Cup' }] }],
  601: [{ divisionID: 62, divisionName: 'G2011', flightList: [{ flightID: 6011, flightName: 'Finals' }] }],
};

function page({ national = true, history = { squads: [{}] } } = {}) {
  const els = new Map();
  const node = id => ({ id, style: {}, hidden: false, textContent: '', value: '', tabIndex: 0, html: '', children: [], open: false,
    get innerHTML() { return this.html; }, set innerHTML(v) { this.html = v; this.children = []; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null,
    focus() {}, append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML(_p, h) { this.html += h; }, querySelector: () => node() });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => node() };
  // Every request is counted by kind and event; hold['kind:event'] holds the next one back.
  const calls = [], hold = {}, log = { saves: 0, hashes: 0 };
  const ask = async (kind, id, value) => {
    calls.push(`${kind}:${id}`);
    const h = hold[`${kind}:${id}`];
    if (h) { delete hold[`${kind}:${id}`]; h.asked = true; await h.promise; }
    return value;
  };
  const teamIndexShowcases = {}, teamHistoryMissing = new Set();
  const stubs = {
    document, window: { location: { hash: '' }, addEventListener() {} }, console: { error() {}, warn() {} },
    SEASONS: {}, NATIONAL_EVENTS: national ? { '2025-26': { Playoffs: { eventId: 600 }, Finals: { eventId: 601 } } } : {},
    teamIndexShowcases,
    getTeamIndex: season => NOINDEX.on ? ask('index', season, null) : ask('index', season, (teamIndexShowcases[season] = [
      { eventID: 501, flightID: 5011, teamIDs: [9] }, { eventID: 502, flightID: 5021, teamIDs: [9] }], [])),
    getEventHierarchy: id => ask('hierarchy', id, { girlsDivAndFlightList: HIER[id] || [] }),
    getStandings: (_d, _f, id) => ask('standings', id, { teamStandings: [{ teamID: 9, name: 'Followed team' }] }),
    getStandingsBlocks: (_d, _f, id) => ask('blocks', id, [{ flightGroupID: 1, teamStandings: [{ teamID: 9 }] }]),
    getSchedule: (id, f) => ask('schedule', id, [{ matchID: f, hometeamID: 9, awayteamID: 10, hometeamscore: 1, awayteamscore: 0 }]),
    loadClubPlaces: () => ask('clubs', '', null),
    // Overview (#114): the real loadTeamHistory; `history` is the history route's answer (null: no file).
    LIVE: false, teamHistoryMissing, currentFavorite: null, historyCrumb() {},
    getTeamHistory: id => ask('history', id, history),
    renderTeamHistory: () => { el('standingsContainer').innerHTML = 'OVERVIEW'; },
    // Collaborators that paint the other tabs, or render pieces of this one.
    openFavoritesTab: () => { el('standingsContainer').innerHTML = 'MY TEAMS'; el('contentTitle').textContent = 'My Teams'; },
    rebuildAll: () => { el('standingsContainer').innerHTML = 'CONFERENCES'; el('contentTitle').textContent = 'Conferences'; },
    loadCurrentView: () => { el('standingsContainer').innerHTML = 'CONFERENCES'; el('contentTitle').textContent = 'Conferences'; },
    loadShowcasesPanel: async () => { el('standingsContainer').innerHTML = 'SHOWCASES'; el('contentTitle').textContent = 'Showcases'; },
    saveState: () => { log.saves++; }, pushHash: () => { log.hashes++; },
    getSeasonData: () => ({ conferences: { 'Mid-Atlantic': {} } }), SOURCES: {}, openSeason: () => ACTIVE_SEASON, focusContentTitle() {},
    esc: s => String(s), getAgeLabel: d => d, getDivisionAge: d => d, sortAgeGroups: x => x, seasonLabel: s => s,
    clearTeamFilter() {}, closeSidebarIfMobile() {}, syncSeasonUI() {}, buildFavoritesList() {}, showTeamViewTabs() {},
    sameTeam: () => true, resolveFavorite: async () => true, isMissing: e => !!e && e.status === 404, retryText: () => 'try again',
    eventContext: () => ({ season: '2025-26', name: 'Midwest', kind: 'conference' }),
    computeTeamSummary: () => ({ mine: [], form: [], next: null }), glancePanelHtml: () => '', shortTeamName: n => n,
    getStandingsUrl: () => '#', getSchedulesUrl: () => '#', publicUrl: () => '#', formatDateRange: () => '',
    resultFor: () => 'W', knockoutGames: () => [], buildBrackets: () => null, postseasonOutcome: () => '',
    mergeStandingsBlocks: b => b[0] || null, updateViewTabsUI() {},
    loadWarning: () => ({ kind: 'warning', querySelector: () => ({}) }), failedFlightPanel: () => ({ kind: 'failed' }),
    renderStandingsTable: () => ({ kind: 'standings' }), renderScheduleTable: () => ({ kind: 'schedule' }),
    renderGroupCards: () => ({ kind: 'groups' }), renderBrackets: () => ({ kind: 'bracket' }),
  };
  const api = new Function(...Object.keys(stubs), CODE + `
    currentSeason = '2025-26';
    teamView = 'season';   // the team page's tables (#122 opens a team on its Overview by default)
    SHOWCASES = { '2025-26': { 'Fall showcase': { eventId: 501, startDate: '2025-10-01' }, 'Spring showcase': { eventId: 502, startDate: '2026-03-01' } } };
    return { switchTab, selectStage, selectPlayoffTier, loadTeamSummary, changeSeason, loadPlayoffFlight, playoffTier: () => currentPlayoffTier,
      setView: v => { currentView = v; }, setTeamView: v => { teamView = v; }, teamView: () => teamView, setPlayoffAge: v => { currentPlayoffAgeGroup = v; }, playoffAge: () => currentPlayoffAgeGroup };`)(...Object.values(stubs));
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
  const held = async key => { const h = (hold[key] = deferred()); return h; };
  const until = async h => { for (let i = 0; i < 200 && !h.asked; i++) await new Promise(r => setImmediate(r)); assert.ok(h.asked, 'the load never reached the held request'); };
  const since = () => { const n = calls.length, s = log.saves; return () => ({ requests: calls.slice(n), saves: log.saves - s }); };
  const shown = () => el('standingsContainer').innerHTML + el('standingsContainer').children.map(c => c.kind || 'node').join();
  const title = () => el('contentTitle').textContent;
  const ageTabs = () => el('playoffAgeGroupTabs').innerHTML;
  return { ...api, calls, log, flush, held, until, since, shown, title, ageTabs, teamHistoryMissing };
}

// ---------- #120: a team page left in any phase asks for nothing more and saves nothing ----------
test('#120 control: an undisturbed team page asks once for each table and saves its state', async () => {
  const p = page();
  p.switchTab('favorites');
  const d = p.since();
  await p.loadTeamSummary({ ...TEAM });
  assert.deepEqual(d().requests, ['hierarchy:3926', 'standings:3926', 'schedule:3926', 'clubs:', 'index:2025-26',
    'schedule:501', 'schedule:502', 'hierarchy:600', 'schedule:600', 'blocks:600', 'schedule:600', 'blocks:600',
    'hierarchy:601', 'schedule:601', 'blocks:601']);
  assert.equal(d().saves, 1);
});

const PHASES = {
  'its first request': 'hierarchy:3926',
  'the showcase phase': 'schedule:501',
  'the post-season phase (hierarchy)': 'hierarchy:600',
  'the post-season phase (a schedule)': 'schedule:600',
  'the post-season phase (a table)': 'blocks:600',
};
for (const [phase, key] of Object.entries(PHASES)) {
  for (const to of ['conferences', 'showcases']) {
    test(`#120: a team page left for ${to} during ${phase} asks for nothing more`, async () => {
      const p = page();
      p.switchTab('favorites');
      const h = await p.held(key);
      const load = p.loadTeamSummary({ ...TEAM });
      await p.until(h);
      p.switchTab(to);
      await p.flush();
      const shown = p.shown(), title = p.title();
      const d = p.since();
      h.resolve();
      await load;
      await p.flush();
      assert.deepEqual(d().requests, [], 'no request after leaving');
      assert.equal(d().saves, 0, 'no saveState after leaving');
      assert.equal(p.shown(), shown, 'nothing painted over');
      assert.equal(p.title(), title);
    });
  }
}

test('#120: a team page with no post-season, left during the showcase phase, asks for and saves nothing', async () => {
  const p = page({ national: false });
  p.switchTab('favorites');
  const h = await p.held('schedule:501');
  const load = p.loadTeamSummary({ ...TEAM });
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.resolve();
  await load;
  await p.flush();
  assert.deepEqual(d().requests, [], 'not the second showcase');
  assert.equal(d().saves, 0, 'the final saveState is guarded');
  assert.equal(p.shown(), 'CONFERENCES');
});

// ---------- #120 on Overview (#114's default view): loadTeamHistory's own token checks ----------
for (const [how, late] of Object.entries({ answers: h => h.resolve(), fails: h => h.reject(Object.assign(new Error('503'), { status: 503 })) })) {
  test(`#120 Overview: a team page left while its Overview loads, which then ${how}, asks for and paints nothing`, async () => {
    const p = page();
    p.setTeamView('history');
    p.switchTab('favorites');
    const h = await p.held('history:9');
    const load = p.loadTeamSummary({ ...TEAM });
    await p.until(h);
    p.switchTab('conferences');
    await p.flush();
    const d = p.since();
    late(h);
    await load;
    await p.flush();
    assert.deepEqual(d().requests, []);
    assert.equal(d().saves, 0);
    assert.equal(p.shown(), 'CONFERENCES');
  });
}

test('#120 Overview: no history file, still on the page: the season-tab fallback loads in full', async () => {
  const p = page({ history: null });
  p.setTeamView('history');
  p.switchTab('favorites');
  const d = p.since();
  await p.loadTeamSummary({ ...TEAM });
  await p.flush();
  assert.equal(p.teamView(), 'season');
  assert.ok(p.teamHistoryMissing.has('9'), 'the id is remembered as having no Overview');
  assert.deepEqual(d().requests.slice(0, 5), ['history:9', 'clubs:', 'hierarchy:3926', 'standings:3926', 'schedule:3926'],
    'the fallback reload is not cancelled by the tokens');
  assert.ok(d().requests.includes('blocks:601'), 'it runs to the end');
  assert.equal(p.shown(), 'node', "the season tab's layout is on screen");
  assert.equal(d().saves, 1);
});

test('#120 Overview: no history file, answered after leaving: no fallback reload', async () => {
  const p = page({ history: null });
  p.setTeamView('history');
  p.switchTab('favorites');
  const h = await p.held('history:9');
  const load = p.loadTeamSummary({ ...TEAM });
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.resolve();
  await load;
  await p.flush();
  assert.deepEqual(d().requests, []);
  assert.equal(p.shown(), 'CONFERENCES');
});

test('#120 Overview: an id known to have no history file opens on its season tab (overviewAvailable)', async () => {
  const p = page();
  p.teamHistoryMissing.add('9');
  p.setTeamView('history');
  p.switchTab('favorites');
  const d = p.since();
  await p.loadTeamSummary({ ...TEAM });
  assert.equal(p.teamView(), 'season');
  assert.equal(d().requests[0], 'hierarchy:3926', 'no history request');
});

// ---------- #99: a slow Playoffs load, then another tab, stage or competition ----------
const EXITS = { conferences: 'CONFERENCES', showcases: 'SHOWCASES', favorites: 'MY TEAMS' };

test('#99 control: an undisturbed Playoffs load paints its tables and saves once', async () => {
  const p = page();
  const d = p.since();
  p.switchTab('playoffs');
  await p.flush();
  assert.deepEqual(d().requests, ['hierarchy:600', 'hierarchy:600', 'blocks:600', 'schedule:600']);
  assert.equal(d().saves, 1);
  assert.equal(p.shown(), 'standings');
  assert.match(p.title(), /Champions League — G2011/);
});

for (const [to, painted] of Object.entries(EXITS)) {
  test(`#99: Playoffs tables that answer after a switch to ${to} paint nothing`, async () => {
    const p = page();
    const h = await p.held('blocks:600');
    p.switchTab('playoffs');
    await p.until(h);
    p.switchTab(to);
    await p.flush();
    assert.equal(p.shown(), painted);
    const d = p.since();
    h.resolve([]);
    await p.flush();
    assert.equal(p.shown(), painted, 'the Playoffs body did not paint over it');
    assert.equal(p.title(), painted === 'MY TEAMS' ? 'My Teams' : painted[0] + painted.slice(1).toLowerCase());
    assert.equal(d().saves, 0, 'no saveState or pushHash for a view no longer on screen');
  });
}

test('#99: leaving while the Playoffs age groups load asks for no tables', async () => {
  const p = page();
  const h = await p.held('hierarchy:600');
  p.switchTab('playoffs');
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.resolve();
  await p.flush();
  assert.deepEqual(d().requests, [], 'no hierarchy or table request after leaving');
  assert.equal(p.shown(), 'CONFERENCES');
  assert.equal(d().saves, 0);
});

test("#99: leaving while a competition's hierarchy loads asks for no tables", async () => {
  const p = page();
  p.switchTab('playoffs');                              // age groups now cached
  await p.flush();
  p.switchTab('conferences');
  const h = await p.held('hierarchy:600');
  p.switchTab('playoffs');
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.resolve();
  await p.flush();
  assert.deepEqual(d().requests, []);
  assert.equal(p.shown(), 'CONFERENCES');
});

test('#99: another stage chosen, then another tab, while its age groups load', async () => {
  const p = page();
  p.switchTab('playoffs');
  await p.flush();
  const h = await p.held('hierarchy:601');
  p.selectStage('Finals');
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.resolve();
  await p.flush();
  assert.deepEqual(d().requests, []);
  assert.equal(p.shown(), 'CONFERENCES');
});

test('#99: a season without Playoffs chosen while the tables load keeps its own page', async () => {
  const p = page();
  const h = await p.held('blocks:600');
  p.switchTab('playoffs');
  await p.until(h);
  await p.changeSeason('2026-27');                      // no national events: painted at once
  const shown = p.shown(), title = p.title();
  assert.match(shown, /not been played yet|isn't available here|playoff data/i);
  h.resolve([]);
  await p.flush();
  assert.equal(p.shown(), shown, "2025-26's tables did not paint over 2026-27");
  assert.equal(p.title(), title);
});

test('#99: a slow competition does not paint over the one chosen after it', async () => {
  const p = page();
  p.switchTab('playoffs');
  await p.flush();
  const h = await p.held('blocks:600');
  p.selectPlayoffTier(6001);                            // Champions League: its table is slow
  await p.until(h);
  p.selectPlayoffTier(6002);                            // the Cup answers at once
  await p.flush();
  const title = p.title();
  assert.match(title, /Cup/);
  h.resolve([]);
  await p.flush();
  assert.equal(p.title(), title, 'the Champions League did not paint over the Cup');
  assert.equal(p.playoffTier(), 6002);
});

test('#99: a Playoffs failure that arrives after a tab switch paints no error', async () => {
  const p = page();
  p.switchTab('playoffs');                              // age groups now cached
  await p.flush();
  p.switchTab('conferences');
  const h = await p.held('hierarchy:600');              // the competition's hierarchy fails late
  p.switchTab('playoffs');
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.reject(Object.assign(new Error('503'), { status: 503 }));
  await p.flush();
  assert.equal(p.shown(), 'CONFERENCES', 'no error message over Conferences');
  assert.equal(d().saves, 0);
});

// ---------- The Reviewer's scenarios ----------
// R1: a view change (Standings <-> Matches, selectView -> loadPlayoffFlight) while the Playoffs panel loads its
// age groups. The panel must still build the age-group chips and land on a table.
for (const saved of [null, 'G2011']) {
  test(`#99 R1: the Playoffs view changed while the age groups load still builds them (saved age ${saved})`, async () => {
    const p = page();
    if (saved) p.setPlayoffAge(saved);
    const h = await p.held('hierarchy:600');
    p.switchTab('playoffs');
    await p.until(h);
    p.setView('schedule');
    p.loadPlayoffFlight();                                  // what selectView does on the Playoffs tab
    await p.flush();
    h.resolve();
    await p.flush();
    assert.match(p.ageTabs(), /G2011/, 'the age-group chips were built');
    assert.notEqual(p.playoffAge(), null, 'an age group is chosen');
    assert.doesNotMatch(p.shown(), /Select an Age Group/, 'not left on "Select an Age Group"');
  });
}

// R2: a team page left while a post-season hierarchy is pending, and that request then fails.
test('#120 R2: a team page left during a post-season hierarchy that then fails asks for nothing more', async () => {
  const p = page();
  p.switchTab('favorites');
  const h = await p.held('hierarchy:600');
  const load = p.loadTeamSummary({ ...TEAM });
  await p.until(h);
  p.switchTab('conferences');
  await p.flush();
  const d = p.since();
  h.reject(Object.assign(new Error('503'), { status: 503 }));
  await load;
  await p.flush();
  assert.deepEqual(d().requests, [], 'no request after leaving');
  assert.equal(d().saves, 0);
});

// R3: no team index (?live=1, a 404): the showcase flights come from a scan of each showcase's hierarchy.
test('#120 R3: a team page left during the no-index showcase scan asks for nothing more', async () => {
  NOINDEX.on = true;
  try {
    const p = page();
    p.switchTab('favorites');
    const h = await p.held('hierarchy:501');
    const load = p.loadTeamSummary({ ...TEAM });
    await p.until(h);
    p.switchTab('conferences');
    await p.flush();
    const d = p.since();
    h.resolve();
    await load;
    await p.flush();
    assert.deepEqual(d().requests, [], 'no request after leaving');
  } finally { NOINDEX.on = false; }
});

// R4: Playoffs -> same tab again (a re-click, or a #tab=playoffs hash) while the tables load: the newer load paints.
test('#99 R4: Playoffs re-entered while its tables load: the newer load paints, the older saves nothing', async () => {
  const p = page();
  const h = await p.held('blocks:600');
  p.switchTab('playoffs');
  await p.until(h);
  const d = p.since();
  p.switchTab('playoffs');
  await p.flush();
  assert.equal(p.shown(), 'standings');
  const saves = d().saves;
  h.resolve([]);
  await p.flush();
  assert.equal(p.shown(), 'standings');
  assert.equal(d().saves, saves, 'the older load saved nothing');
});

// ---------- #121: a History tile breaks a word only when it cannot fit, and its column fits the word ----------
test('#121: the History tile values break words only as a last resort, in columns as wide as their longest word', () => {
  const rule = html.match(/\n    \.hist-tile \.stat-value \{([^}]*)\}/)[1];
  assert.match(rule, /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(rule, /anywhere/);
  const grid = html.match(/\n    \.hist-tiles \{([^}]*)\}/)[1];
  // "Quarterfinals" needs about 119px at 19px, and a fifth of a 700px panel leaves 108px.
  assert.match(grid, /grid-template-columns:\s*repeat\(5, minmax\(min-content, 1fr\)\)/);
});
