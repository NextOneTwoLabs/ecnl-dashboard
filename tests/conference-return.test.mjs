// #102: the Conferences sidebar (its age groups, age tabs and conference list) is built for one
// season. A team page in another season, the season picker on Playoffs or Showcases, or a
// #tab= link can move the season on behind it; returning to Conferences must then show a valid
// view of that season, with an address and saved state that name it, painted once. Leaving a
// team page that is still loading cancels it: it must not paint over Conferences or move the
// season afterwards. The page's own code (public/index.html), extracted block by block as in
// tests/team-page.test.mjs, run against a fake DOM with counted, stubbed requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ACTIVE_SEASON = JSON.parse(readFileSync(new URL('../public/data/sources.json', import.meta.url), 'utf8')).refresh.activeSeason;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// From the line that starts `head` to the end of the function (or statement) that `last` names.
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const teamSummary = block('    async function loadTeamSummary(');
assert.ok(teamSummary.endsWith('      saveState();\n      pushHash();\n    }\n'), 'loadTeamSummary extracted whole');
const CODE = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),          // the page's state
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    function getSeasonData()'),
  block('    function saveState('), block('    function pushHash('), block('    function loadFromHash('),
  block("    window.addEventListener('hashchange'", "window.addEventListener('hashchange'", '\n    });\n'),
  block('    const TOP_TABS = ', 'function closeMyTeams('), block('    function switchTab('),
  block('    async function loadAgeGroupsForSeason('), block('    function syncSeasonUI('),
  block('    function selectAgeGroup('), line('    function loadStandings()'),
  block('    async function changeSeason('), block('    async function rebuildAll('),
  block('    let currentConfMeta = null;', 'async function loadCurrentView('),
  teamSummary,
  block('    async function loadTeamHistory('),             // Overview, the team page's default (#114)
  // #135 P1a: the landing page and the Teams index, which hashchange, switchTab and rebuildAll call.
  block('    // ========== LANDING (#135 P1a)', 'async function renderTeamsIndex('),
].join('\n');

// Three seasons; 2020-21 Mid-Atlantic never ran the GU18/U19 Composite that other conferences did.
const SEASONS = {
  '2026-27': { ageGroups: { 'GU18/19': {}, GU17: {} }, conferences: { 'Mid-Atlantic': { eventId: 4263 }, Midwest: { eventId: 4264 } } },
  '2025-26': { ageGroups: { 'G2008/2007': {}, G2009: {} }, conferences: { 'Mid-Atlantic': { eventId: 3925 }, Midwest: { eventId: 3926 } } },
  '2020-21': { ageGroups: { 'GU18/U19': {}, 'GU18/U19 Composite': {} }, conferences: { 'Mid-Atlantic': { eventId: 2040 } } },
};
const seasonOf = id => Object.keys(SEASONS).find(s => Object.values(SEASONS[s].conferences).some(c => c.eventId === id));
const hierarchyOf = id => ({ girlsDivAndFlightList: Object.keys(SEASONS[seasonOf(id)].ageGroups)
  .filter(d => !(id === 2040 && /Composite/.test(d)))
  .map((d, i) => ({ divisionName: d, divisionID: id * 10 + i, flightList: [{ flightID: id * 100 + i, flightName: 'ECNL' }] })) });
// A followed 2025-26 Midwest team, already located (as My Teams stores it).
const TEAM = { name: 'Followed team', teamID: 9, eventID: 3926, divisionID: 39261, flightID: 392601 };
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };

function page() {
  const els = new Map();
  const node = id => ({ id, style: {}, hidden: false, textContent: '', innerHTML: '', value: '', tabIndex: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null,
    focus() {}, append() {}, appendChild() {}, querySelector: () => node() });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => node() };
  const listeners = {};
  const location = { hash: '' };
  const window = { location, addEventListener: (t, f) => { listeners[t] = f; } };
  const history = { replaceState: (_s, _t, h) => { location.hash = h; } };
  const store = {};
  // Counts are calls. The stub memoises the hierarchy per event for the whole test, while the
  // page empties its eventHierarchy on changeSeason and openTeamInContext, so after a season
  // change a browser can make one more hierarchy request than counted here. The page memoises
  // standings too, and not schedules. hold[id] and hooks.locate hold an answer back.
  const calls = { hierarchy: 0, standings: 0, schedule: 0, ageTabs: 0 };
  const hooks = {}, memo = {}, hold = {};
  const stubs = {
    document, window, location, history, SEASONS, openSeason: () => ACTIVE_SEASON,
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] ?? null },
    getEventHierarchy: async id => {
      if (memo[id]) return memo[id];
      calls.hierarchy++;
      if (hold[id]) await hold[id].promise;
      return (memo[id] = hierarchyOf(id));
    },
    getStandings: async () => { calls.standings++; return { teamStandings: [] }; },
    getSchedule: async () => { calls.schedule++; return []; },
    getAgeLabel: d => d.replace(/^G/, ''), sortAgeGroups: x => x, seasonLabel: s => s, esc: s => String(s),
    buildAgeGroupTabs: () => { calls.ageTabs++; }, buildConferenceList() {}, buildBreadcrumb() {}, updateViewTabsUI() {},
    clearTeamFilter() {}, loadClubPlaces: async () => {}, favoriteInDivision: () => false, clubPlaces: null,
    defaultSelection: () => null, renderConferenceView: () => { el('standingsContainer').innerHTML = 'TABLE'; },
    isMissing: () => false, retryText: e => String(e), closeSidebarIfMobile() {},
    openFavoritesTab: () => hooks.openFavorites(), loadPlayoffsPanel: async () => { el('standingsContainer').innerHTML = 'PLAYOFFS'; el('contentTitle').textContent = 'Playoffs'; },
    loadShowcasesPanel: async () => {},
    // The team page's own collaborators (loadTeamSummary).
    sameTeam: () => true, showTeamViewTabs() {}, buildFavoritesList() {},
    resolveFavorite: async () => (hooks.locate ? hooks.locate.promise : true),
    eventContext: id => ({ season: seasonOf(id), name: 'Midwest', kind: 'conference' }),
    computeTeamSummary: () => ({ mine: [], form: [], next: null }), getStandingsUrl: () => '', glancePanelHtml: () => '',
    loadWarning: () => node(), renderStandingsTable: () => node(), renderScheduleTable: () => node(), failedFlightPanel: () => node(),
    shortTeamName: n => n, teamShowcaseSections: async () => [], NATIONAL_EVENTS: {},
    // Overview's collaborators (the real loadTeamHistory, #114). hold.history holds its answer back;
    // rejecting it is a failed history request. A painted Overview reads 'OVERVIEW'.
    LIVE: false, overviewAvailable: () => true, historyCrumb() {}, teamHistoryMissing: new Set(),
    getTeamHistory: async () => { if (hold.history) await hold.history.promise; return { squads: [{}] }; },
    renderTeamHistory: () => { el('standingsContainer').innerHTML = 'OVERVIEW'; },
  };
  let api;
  api = new Function(...Object.keys(stubs), CODE + `
    return { switchTab, closeMyTeams, toggleMyTeams, changeSeason, rebuildAll, selectAgeGroup, loadTeamSummary,
      // The season tab for the followed team (as &view=season would), so a test can take the
      // path that locates the team and reads its tables.
      seasonTab: () => { teamView = 'season'; teamViewFor = { id: ${TEAM.teamID}, name: ${JSON.stringify(TEAM.name)} }; },
      view: () => teamView,
      setSeason: s => { currentSeason = s; },
      state: () => ({ season: currentSeason, age: currentAgeGroup, conf: currentConference, ages: AGE_GROUPS.join() }) };`)(...Object.values(stubs));
  // My Teams shows the followed team.
  hooks.openFavorites = () => api.loadTeamSummary({ ...TEAM });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  const fire = async hash => { location.hash = hash; listeners.hashchange(); await flush(); };
  // Cold, no hash: the registry's first season, then INIT's rebuildAll.
  const cold = async () => { api.setSeason('2026-27'); await api.rebuildAll(); await flush(); };
  const shown = () => el('standingsContainer').innerHTML;
  const title = () => el('contentTitle').textContent;
  const heading = () => [el('contentTitle').textContent, el('contentSubtitle').textContent];
  const saved = () => JSON.parse(store['ecnl-dash-v2-state'] || 'null');
  const since = () => { const before = { ...calls }; return () => Object.fromEntries(Object.keys(calls).map(k => [k, calls[k] - before[k]])); };
  return { ...api, hooks, hold, calls, location, flush, fire, cold, shown, title, heading, saved, since };
}
const VALID_2026 = { season: '2026-27', age: 'GU18/19', conf: 'Mid-Atlantic', ages: 'GU18/19,GU17' };
const VALID_2025 = { season: '2025-26', age: 'G2008/2007', conf: 'Mid-Atlantic', ages: 'G2008/2007,G2009' };
const HASH_2026 = '#season=2026-27&age=GU18%2F19&conf=Mid-Atlantic';
const HASH_2025 = '#season=2025-26&age=G2008%2F2007&conf=Mid-Atlantic';

test('#102: Back to Conferences from a team in another season shows a valid view of that season, once', async () => {
  const p = page();
  await p.cold();
  assert.equal(p.location.hash, HASH_2026);
  p.toggleMyTeams();
  await p.flush();
  assert.equal(p.title(), 'Followed team');
  assert.equal(p.view(), 'history', 'My Teams opens the team on Overview (#114)');
  assert.equal(p.state().season, '2025-26', "the team page takes the team's season");
  assert.match(p.location.hash, /^#tab=teams&season=2025-26/);
  assert.doesNotMatch(p.location.hash, /view=/, 'Overview is the default: no view in the address');
  const d = p.since();
  p.closeMyTeams();
  await p.flush();
  assert.equal(p.shown(), 'TABLE', 'not "No data found"');
  assert.deepEqual(p.state(), VALID_2025);
  assert.equal(p.location.hash, HASH_2025);
  assert.deepEqual([p.saved().tab, p.saved().season, p.saved().ageGroup], ['conferences', '2025-26', 'G2008/2007']);
  assert.deepEqual(d(), { hierarchy: 1, standings: 1, schedule: 1, ageTabs: 1 });   // one paint
});

for (const tab of ['playoffs', 'showcases']) {
  test(`#102: the season picker on ${tab}, then the Conferences tab, shows that season`, async () => {
    const p = page();
    await p.cold();
    p.switchTab(tab);
    await p.changeSeason('2025-26');
    const d = p.since();
    p.switchTab('conferences');
    await p.flush();
    assert.equal(p.shown(), 'TABLE');
    assert.deepEqual(p.state(), VALID_2025);
    assert.equal(p.location.hash, HASH_2025);
    assert.deepEqual(d(), { hierarchy: 1, standings: 1, schedule: 1, ageTabs: 1 });
  });
}

test('#102: the season picker with My Teams open goes to Conferences with one paint', async () => {
  const p = page();
  await p.cold();
  p.toggleMyTeams();                                   // the 2025-26 team page moves the season
  await p.flush();
  const d = p.since();
  await p.changeSeason('2025-26');
  await p.flush();
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(p.state(), VALID_2025);
  assert.equal(p.location.hash, HASH_2025);
  assert.deepEqual(d(), { hierarchy: 1, standings: 1, schedule: 1, ageTabs: 1 });   // not two rebuilds
});

test('#102: browser Back to a conference link repaints once', async () => {
  const p = page();
  await p.cold();
  await p.fire('#tab=teams&season=2025-26');
  const d = p.since();
  await p.fire(HASH_2026);
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(p.state(), VALID_2026);
  assert.equal(d().schedule, 1, 'one schedule request, not one per paint');
});

test('#102: an age group the conference did not run says so, and the address and saved state name it', async () => {
  const p = page();
  p.setSeason('2020-21');
  await p.rebuildAll();
  await p.flush();
  p.selectAgeGroup('GU18/U19 Composite');
  await p.flush();
  assert.match(p.shown(), /No data found for U18\/U19 Composite in Mid-Atlantic/);
  assert.equal(p.location.hash, '#season=2020-21&age=GU18%2FU19%20Composite&conf=Mid-Atlantic');
  assert.equal(p.saved().ageGroup, 'GU18/U19 Composite');
});

test('#102: returning in the same season repaints only, with no sidebar rebuild', async () => {
  const p = page();
  await p.cold();
  p.switchTab('playoffs');
  const d = p.since();
  p.switchTab('conferences');
  await p.flush();
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(d(), { hierarchy: 0, standings: 1, schedule: 1, ageTabs: 0 });
});

test('#102: back in a season whose age groups were cached, the sidebar counts as built for it', async () => {
  const p = page();
  await p.cold();
  await p.changeSeason('2025-26');
  await p.changeSeason('2026-27');                    // 2026-27's age groups come from the cache
  // (hierarchy: 0 below holds for the stub's memo; the point of each check is ageTabs.)
  assert.deepEqual(p.state(), VALID_2026);
  p.switchTab('playoffs');
  const d = p.since();
  p.switchTab('conferences');
  await p.flush();
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(d(), { hierarchy: 0, standings: 1, schedule: 1, ageTabs: 0 });
  // A team page of the other cached season, then Back, rebuilds from that cache.
  p.toggleMyTeams();
  await p.flush();
  const d2 = p.since();
  p.closeMyTeams();
  await p.flush();
  assert.deepEqual(p.state(), VALID_2025);
  assert.equal(p.location.hash, HASH_2025);
  assert.deepEqual(d2(), { hierarchy: 0, standings: 1, schedule: 1, ageTabs: 1 });
});

// Every way out of a slow team page cancels it: ‹ Back to either top tab, the Conferences tab
// (or "/", which calls the same switchTab), and a conference link (hashchange).
const EXITS = {
  '‹ Back to Conferences': async p => { p.closeMyTeams(); },
  '‹ Back to Playoffs': async p => { p.closeMyTeams(); },
  'the Conferences tab': async p => { p.switchTab('conferences'); },
  'a conference link': async p => { await p.fire(HASH_2025); },
};
const VIEWS = {
  'its season tab': { set: p => p.seasonTab(), hold: p => (p.hold[TEAM.eventID] = deferred()), late: d => d.resolve() },
  'Overview': { set: () => {}, hold: p => (p.hold.history = deferred()), late: d => d.resolve() },
  'a failing Overview': { set: () => {}, hold: p => (p.hold.history = deferred()), late: d => d.reject(Object.assign(new Error('503'), { status: 503 })) },
};
for (const [exit, leave] of Object.entries(EXITS)) for (const [viewName, view] of Object.entries(VIEWS)) {
  test(`#102: a slow team page (${viewName}) does not paint over the page after ${exit}`, async () => {
    const p = page();
    await p.cold();
    const playoffs = exit.endsWith('Playoffs');
    if (playoffs) p.switchTab('playoffs');             // where ‹ Back goes
    view.set(p);
    const held = view.hold(p);                          // its answer comes late
    p.toggleMyTeams();
    await p.flush();
    assert.equal(p.view(), viewName === 'its season tab' ? 'season' : 'history');
    await leave(p);
    await p.flush();
    const shown = p.shown(), title = p.title();
    assert.equal(shown, playoffs ? 'PLAYOFFS' : 'TABLE');
    if (!playoffs) assert.deepEqual(p.state(), VALID_2025);   // the season had moved before leaving
    const error = console.error;
    console.error = () => {};
    try { view.late(held); await p.flush(); } finally { console.error = error; }
    assert.equal(p.shown(), shown, 'the team page did not paint over it');
    assert.equal(p.title(), title);
    if (!playoffs) assert.equal(p.location.hash, HASH_2025);
  });
}

test('#102: leaving while the team is still being located keeps the season and the view', async () => {
  const p = page();
  await p.cold();
  p.seasonTab();                                       // Overview needs no locating (#114)
  p.hooks.locate = deferred();
  p.toggleMyTeams();
  await p.flush();
  p.closeMyTeams();
  await p.flush();
  assert.deepEqual(p.state(), VALID_2026);
  p.hooks.locate.resolve(true);
  await p.flush();
  assert.deepEqual(p.state(), VALID_2026, 'the season did not move after Back');
  assert.equal(p.shown(), 'TABLE');
  assert.equal(p.location.hash, HASH_2026);
});

test('#102: a team page that fails after ‹ Back shows no error over Conferences', async () => {
  const p = page();
  await p.cold();
  p.seasonTab();                                       // the season tab reads the event's tables (#114)
  p.hold[TEAM.eventID] = deferred();
  p.toggleMyTeams();
  await p.flush();
  p.closeMyTeams();
  await p.flush();
  const before = p.heading();
  const error = console.error;
  console.error = () => {};
  try {
    p.hold[TEAM.eventID].reject(new Error('503'));
    await p.flush();
  } finally { console.error = error; }
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(p.heading(), before, "the title and subtitle are still the conference view's");
  assert.equal(p.location.hash, HASH_2025);
});

test('#102 with #114: on the season tab, Back to Conferences still shows that season, once', async () => {
  const p = page();
  await p.cold();
  p.seasonTab();
  p.toggleMyTeams();
  await p.flush();
  assert.match(p.location.hash, /^#tab=teams&season=2025-26.*&view=season$/);
  const d = p.since();
  p.closeMyTeams();
  await p.flush();
  assert.equal(p.shown(), 'TABLE');
  assert.deepEqual(p.state(), VALID_2025);
  assert.equal(p.location.hash, HASH_2025);
  assert.deepEqual(d(), { hierarchy: 1, standings: 1, schedule: 1, ageTabs: 1 });
});

// #99 (C): a Conferences load still in flight is dropped by any tab switch, so its table never
// paints over the tab the viewer chose: Playoffs, My Teams, or a team page opened from a link.
const HELD_CONF = async p => {
  await p.cold();
  p.hold[3925] = deferred();                            // 2025-26 Mid-Atlantic answers late
  const change = p.changeSeason('2025-26');
  await p.flush();
  return change;
};
const LEAVE = {
  'the Playoffs tab': async p => { p.switchTab('playoffs'); },
  'My Teams': async p => { p.switchTab('favorites'); },
  'a team link (#tab=teams)': async (p, on) => { await p.fire('#tab=teams&season=2025-26&team=9' + (on === 'its season tab' ? '&view=season' : '')); },
};
const ON = { 'Overview': () => {}, 'its season tab': p => p.seasonTab() };   // the team page's two views (#114)
for (const [to, leave] of Object.entries(LEAVE)) for (const [onName, on] of Object.entries(to === 'the Playoffs tab' ? { '': () => {} } : ON)) {
  test(`#99 C: a Conferences load that answers after a switch to ${to}${onName && ` (${onName})`} paints nothing`, async () => {
    const p = page();
    const change = await HELD_CONF(p);
    on(p);
    await leave(p, onName);
    await p.flush();
    const shown = p.shown(), title = p.title();
    assert.notEqual(shown, 'TABLE');
    p.hold[3925].resolve();
    await change;
    await p.flush();
    assert.equal(p.shown(), shown, 'the conference table did not paint over it');
    assert.equal(p.title(), title);
  });
}

// #99: a conference load that would start after the switch (rebuildAll's continuation, once its
// age groups are known) does not start at all.
test('#99: a Conferences rebuild that continues after a switch to Playoffs paints nothing', async () => {
  const p = page();
  await p.cold();
  const d = p.since();
  const rebuild = p.rebuildAll();
  p.switchTab('playoffs');
  await rebuild;
  await p.flush();
  assert.equal(p.shown(), 'PLAYOFFS');
  assert.equal(p.title(), 'Playoffs');
  assert.deepEqual([d().standings, d().schedule], [0, 0], 'no conference table requested');
});
