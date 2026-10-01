// #97: the page's own showcase logic (public/index.html), run in Node with stubs. #92's rule
// holds for every showcase fetch: a refused request means "try again", never "didn't attend",
// "no team page" or a fallback scan (review M2 a-c). The reviewed alias (M3) finds a team's
// showcase flight and its team page, and a response half is kept once it has succeeded (S6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
// From the line that starts `head` to the end of the function (or statement) that `last` names.
const block = (head, last = head) => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf('\n    }\n', from) + 6;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const PAGE = [
  block('    let sessionRenewAt = 0', 'function noteSession('),
  block('    async function fetchJSON(', 'function failedFlightPanel('),
  block('    const teamIndexMemo = {};', 'function getTeamIndex('),
  block('    async function showcaseIndex('),
  block('    function showcaseTeamPage('),
  block('    const showcaseMemo = new Map();', 'function showcaseHalf('),
  block('    async function showcaseFlightsForTeam('),
  block('    async function teamShowcaseSections('),
].join('\n');

const SEASON = '2025-26';
const SHOWCASES = { [SEASON]: { 'Phoenix Spring': { eventId: 4133, startDate: '2026-03-27', teamAliases: { 112470: 69910 } } } };
const INDEX_ROWS = [{ teamID: 75387 }, { teamID: 69910 }];
const SC_ROWS = [
  { eventID: 4133, divisionID: 20345, flightID: 36390, teamIDs: [75387, 112470, 90001], aliases: { 112470: 69910 } },
  { eventID: 4133, divisionID: 20343, flightID: 36386, teamIDs: [59771] },
];
const GAMES = [
  { hometeamID: 75387, awayteamID: 90001, hometeamscore: 3, awayteamscore: 1 },
  { hometeamID: 112470, awayteamID: 75387, hometeamscore: 0, awayteamscore: 2 },
  { hometeamID: 90001, awayteamID: 112470, hometeamscore: 1, awayteamscore: 1 },
  { hometeamID: 112470, awayteamID: 90002, hometeamscore: 3, awayteamscore: 1 },
  { hometeamID: 75387, awayteamID: 90002, hometeamscore: null, awayteamscore: null },
];
const refused = (status = 429) => Object.assign(new Error(`API error ${status}`), { status, session: 'ok' });

// `index`: the team index answer ({status, body}); `schedule(flightID)`: the schedule, or a
// rejection. Every request the page code makes is recorded.
function page({ index = { status: 200, body: { schema: 1, season: SEASON, teams: INDEX_ROWS, showcases: SC_ROWS } },
                schedule = () => GAMES } = {}) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    const a = index;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { 'content-type': 'application/json', 'x-ecnl-session': 'ok' } });
  };
  const getEventHierarchy = async id => { calls.push(`hierarchy ${id}`); return { girlsDivAndFlightList: [{ divisionName: 'G2011', flightList: [{ flightID: 36390 }] }] }; };
  const getSchedule = async (eventId, flightId) => {
    calls.push(`schedule ${eventId}/${flightId}`);
    const s = schedule(flightId);
    if (s instanceof Error) throw s;
    return s;
  };
  const resultFor = (g, id) => {
    if (g.hometeamscore == null || g.awayteamscore == null) return null;
    if (g.hometeamscore === g.awayteamscore) return 'D';
    return (g.hometeamscore > g.awayteamscore) === (g.hometeamID === id) ? 'W' : 'L';
  };
  const esc = s => String(s);
  const api = new Function('LIVE', 'fetch', 'Date', 'dataUrl', 'esc', 'SHOWCASES', 'getEventHierarchy', 'getSchedule',
    'getAgeLabel', 'resultFor',
    PAGE + '\nreturn { getTeamIndex, showcaseIndex, showcaseTeamPage, showcaseHalf, showcaseFlightsForTeam, teamShowcaseSections };')(
    false, fetch, { now: () => 1e12 }, p => '/api/v1/' + p, esc, SHOWCASES, getEventHierarchy, getSchedule, d => d, resultFor);
  return { ...api, calls };
}

test('M2a: a refused index rejects the team-page lookup, and nothing is scanned', async () => {
  const p = page({ index: { status: 429 } });
  await assert.rejects(p.showcaseFlightsForTeam(SEASON, 75387, 'G2011'), e => e.status === 429);
  await assert.rejects(p.teamShowcaseSections(SEASON, 75387, 'G2011'), e => e.status === 429);
  assert.equal(p.calls.filter(c => c.startsWith('hierarchy') || c.startsWith('schedule')).length, 0);
  assert.equal(p.calls.length, 1, 'the refusal is remembered: one index request');
});

test('M2a: only a resolved "no index" (404) scans the team\'s age group', async () => {
  const p = page({ index: { status: 404 } });
  const out = await p.showcaseFlightsForTeam(SEASON, 75387, 'G2011');
  assert.deepEqual(out.map(o => o.flightID), [36390]);
  assert.ok(p.calls.includes('hierarchy 4133'));
});

test('index: only the showcase flights the team played in, and none for a season without showcases', async () => {
  const p = page();
  assert.deepEqual((await p.showcaseFlightsForTeam(SEASON, 75387, 'G2011')).map(o => o.flightID), [36390]);
  assert.deepEqual(await p.showcaseFlightsForTeam(SEASON, 11111, 'G2011'), []);
  assert.deepEqual(await p.showcaseFlightsForTeam('2024-25', 75387, 'G2011'), []);
  assert.equal(p.calls.filter(c => c.startsWith('hierarchy')).length, 0);
  assert.equal(p.calls.filter(c => c.includes('/seasons/2024-25/')).length, 0, 'no index request without showcases');
});

test('M2b: a refused showcase schedule is a "couldn\'t load" section, a 404 is skipped', async () => {
  const p = page({ schedule: () => refused(429) });
  const out = await p.teamShowcaseSections(SEASON, 75387, 'G2011');
  assert.equal(out.length, 1);
  assert.equal(out[0].error.status, 429);
  assert.equal(out[0].name, 'Phoenix Spring');
  assert.equal(out[0].games, undefined);
  for (const status of [503, 403]) {
    const q = page({ schedule: () => refused(status) });
    assert.equal((await q.teamShowcaseSections(SEASON, 75387, 'G2011'))[0].error.status, status);
  }
  const missing = page({ schedule: () => refused(404) });
  assert.deepEqual(await missing.teamShowcaseSections(SEASON, 75387, 'G2011'), []);
});

test('team page: the team\'s games and record (W, L, D, goals from scored games only)', async () => {
  const p = page();
  const [s] = await p.teamShowcaseSections(SEASON, 75387, 'G2011');
  assert.equal(s.games.length, 3);
  assert.deepEqual(s.record, { W: 2, L: 0, D: 0, gf: 5, ga: 1 });
});

test('M3: the conference id finds its showcase games through the reviewed alias', async () => {
  const p = page();
  const out = await p.showcaseFlightsForTeam(SEASON, 69910, 'G2011');
  assert.deepEqual(out.map(o => [o.flightID, o.ids]), [[36390, [69910, 112470]]]);
  const [s] = await p.teamShowcaseSections(SEASON, 69910, 'G2011');
  assert.deepEqual(s.record, { W: 1, L: 1, D: 1, gf: 4, ga: 4 });
});

test('M2c: a refused index claims nothing about any row, and says "try again"', async () => {
  const p = page({ index: { status: 429 } });
  const r = await p.showcaseIndex(SEASON);
  assert.equal(r.linkable, null);
  assert.equal(r.error.status, 429);
  for (const id of [75387, 112470, 90001]) assert.equal(p.showcaseTeamPage(id, r.linkable, { 112470: 69910 }), null);
  const none = await page({ index: { status: 404 } }).showcaseIndex(SEASON);
  assert.deepEqual(none, { linkable: null, error: null });
});

test('M2c/M3: with the index read, rows link to their page (or the alias), others have none', async () => {
  const p = page();
  const { linkable, error } = await p.showcaseIndex(SEASON);
  assert.equal(error, null);
  const aliases = { 112470: 69910 };
  assert.equal(p.showcaseTeamPage(75387, linkable, aliases), 75387);
  assert.equal(p.showcaseTeamPage(112470, linkable, aliases), 69910);
  assert.equal(p.showcaseTeamPage(90001, linkable, aliases), false);
  assert.equal(p.showcaseTeamPage(112470, linkable, {}), false, 'without the alias it has no page');
});

test('S6: a successful half is kept; a failed one is asked again; a 404 is no error', async () => {
  const p = page();
  let n = 0;
  const ok = () => { n++; return Promise.resolve(['row']); };
  assert.deepEqual(await p.showcaseHalf('s/1', ok), { value: ['row'], error: null });
  assert.deepEqual(await p.showcaseHalf('s/1', ok), { value: ['row'], error: null });
  assert.equal(n, 1);
  let m = 0;
  const bad = () => { m++; return Promise.reject(refused(503)); };
  assert.equal((await p.showcaseHalf('g/1', bad)).error.status, 503);
  assert.equal((await p.showcaseHalf('g/1', bad)).error.status, 503);
  assert.equal(m, 2);
  assert.deepEqual(await p.showcaseHalf('g/2', () => Promise.reject(refused(404))), { value: null, error: null });
});

// S-B: the page's own loadShowcaseFlight, with a stub document. A load whose answer arrives
// after the viewer moved on (another tab, showcase or flight) must leave the screen, the
// state and the hash alone.
const LOADER = [
  block('    const showcaseMemo = new Map();', 'function showcaseHalf('),
  block('    async function showcaseIndex('),
  block('    function showcaseLoadStale('),
  block('    let showcaseLoad = null;', 'async function loadShowcaseFlight('),
].join('\n');

function showcasePage({ holdHierarchy = false, holdStandings = false } = {}) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      els.set(id, { id, children: [], style: {}, textContent: '', open: false, html: '',
        get innerHTML() { return this.html; }, set innerHTML(v) { this.html = v; this.children = []; },
        appendChild(c) { this.children.push(c); return c; }, insertAdjacentHTML(_p, h) { this.html += h; } });
    }
    return els.get(id);
  };
  const gates = {};
  const hold = name => new Promise((resolve, reject) => { gates[name] = { resolve, reject }; });
  const log = { saves: 0, hashes: 0, standings: 0 };
  const H = { girlsDivAndFlightList: [
    { divisionID: 20345, divisionName: 'G2011', flightList: [{ flightID: 36390, flightName: 'Phoenix - Spring' }] },
    { divisionID: 20346, divisionName: 'G2012', flightList: [{ flightID: 36387, flightName: 'Phoenix - Spring' }] }] };
  const EVT = { eventId: 4133, location: 'Phoenix, AZ', startDate: '2026-03-27', endDate: '2026-03-29' };
  const stubs = {
    document: { getElementById: el }, esc: s => String(s), console: { error() {} },
    currentShowcaseEntry: () => ({ name: 'Phoenix Spring', evt: EVT }),
    clearTeamFilter() {}, sortAgeGroups: a => a, getAgeLabel: a => a, tierLabel: (e, f) => f, formatDateRange: () => '',
    getEventHierarchy: () => holdHierarchy ? hold('hierarchy') : Promise.resolve(H),
    getStandingsBlocks: () => { log.standings++; return holdStandings ? hold('standings') : Promise.resolve([{ teamStandings: [{ teamID: 1 }] }]); },
    getSchedule: () => Promise.resolve([]), getTeamIndex: () => Promise.resolve([{ teamID: 1 }]),
    isMissing: e => !!e && e.status === 404, mergeStandingsBlocks: b => b[0] || null,
    updateViewTabsUI() {}, getSchedulesUrl: () => '#', publicUrl: () => '#', EXTERNAL_ICON: '',
    loadWarning: () => ({ style: {} }), failedFlightPanel: () => ({ kind: 'failed' }),
    renderScheduleTable: () => ({ kind: 'games' }), renderStandingsTable: () => ({ kind: 'results', insertAdjacentHTML() {} }),
    SHOWCASE_COLS: [], retryText: () => 'try again', saveState: () => { log.saves++; }, pushHash: () => { log.hashes++; },
  };
  const api = new Function(...Object.keys(stubs), `
    let currentTab = 'showcases', currentShowcase = 4133, currentShowcaseAge = 'G2011', currentShowcaseFlight = null,
      currentSeason = '2025-26', currentView = 'standings', showcaseLinkable = null, showcaseAliases = {};
    ${LOADER}
    return { loadShowcaseFlight, state: () => ({ showcaseLoad, currentShowcaseFlight }),
      setTab: v => { currentTab = v; }, setShowcase: v => { currentShowcase = v; }, setFlight: v => { currentShowcaseFlight = v; } };`)(
    ...Object.values(stubs));
  const until = async cond => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setImmediate(r));
    assert.ok(cond(), 'the load never reached the held request');
  };
  return { ...api, el, gates, log, until };
}
const ANSWER = [{ teamStandings: [{ teamID: 1 }] }];

test('S-B control: an undisturbed load paints the table and saves its state', async () => {
  const p = showcasePage();
  await p.loadShowcaseFlight();
  assert.deepEqual(p.el('standingsContainer').children.map(c => c.kind), ['results']);
  assert.equal(p.log.hashes, 1);
  assert.equal(p.state().showcaseLoad.key, '4133/36390');
  assert.match(p.el('showcaseAgeGroupTabs').innerHTML, /G2011/);
});

test('S-B: switching tab while the answers are pending leaves the new tab alone', async () => {
  const p = showcasePage({ holdStandings: true });
  const load = p.loadShowcaseFlight();
  await p.until(() => p.gates.standings);
  p.setTab('conferences');
  p.el('standingsContainer').innerHTML = 'CONFERENCES';
  p.gates.standings.resolve(ANSWER);
  await load;
  assert.equal(p.el('standingsContainer').innerHTML, 'CONFERENCES');
  assert.equal(p.el('standingsContainer').children.length, 0);
  assert.deepEqual([p.log.saves, p.log.hashes], [0, 0], 'no state or hash written');
  assert.equal(p.state().showcaseLoad, null);
});

test('S-B: another age group (flight) chosen while the answers are pending', async () => {
  const p = showcasePage({ holdStandings: true });
  const load = p.loadShowcaseFlight();
  await p.until(() => p.gates.standings);
  p.setFlight(36387);
  p.el('standingsContainer').innerHTML = 'U14';
  p.gates.standings.resolve(ANSWER);
  await load;
  assert.equal(p.el('standingsContainer').innerHTML, 'U14');
  assert.deepEqual([p.log.saves, p.log.hashes], [0, 0]);
  assert.equal(p.state().showcaseLoad, null);
});

test('S-B: switching tab or showcase while the hierarchy is pending', async () => {
  for (const move of [p => p.setTab('playoffs'), p => p.setShowcase(9999)]) {
    const p = showcasePage({ holdHierarchy: true });
    const load = p.loadShowcaseFlight();
    await p.until(() => p.gates.hierarchy);
    move(p);
    p.el('standingsContainer').innerHTML = 'ELSEWHERE';
    p.gates.hierarchy.resolve({ girlsDivAndFlightList: [{ divisionID: 20345, divisionName: 'G2011', flightList: [{ flightID: 36390, flightName: 'x' }] }] });
    await load;
    assert.equal(p.el('standingsContainer').innerHTML, 'ELSEWHERE');
    assert.equal(p.el('showcaseAgeGroupTabs').innerHTML, '', 'no age chips written');
    assert.equal(p.log.standings, 0, 'nothing more requested');
    assert.deepEqual([p.log.saves, p.log.hashes], [0, 0]);
  }
});

test('S-B: a failure that arrives after the tab changed paints nothing', async () => {
  const p = showcasePage({ holdHierarchy: true });
  const load = p.loadShowcaseFlight();
  await p.until(() => p.gates.hierarchy);
  p.setTab('conferences');
  p.el('standingsContainer').innerHTML = 'CONFERENCES';
  p.gates.hierarchy.reject(refused(429));
  await load;
  assert.equal(p.el('standingsContainer').innerHTML, 'CONFERENCES');
  assert.deepEqual([p.log.saves, p.log.hashes], [0, 0]);
});

// #99 (S): every Showcases load takes a token as well; a newer load (leave and come back, Try again)
// drops the older one, in every phase. A re-render (Results <-> Games) supersedes nothing.
const H_4133 = { girlsDivAndFlightList: [{ divisionID: 20345, divisionName: 'G2011', flightList: [{ flightID: 36390, flightName: 'x' }] }] };
test('S: an older load of the same flight asks for nothing once a newer one has started (hierarchy phase)', async () => {
  const p = showcasePage({ holdHierarchy: true });
  const first = p.loadShowcaseFlight();
  await p.until(() => p.gates.hierarchy);
  const g1 = p.gates.hierarchy; delete p.gates.hierarchy;
  const second = p.loadShowcaseFlight();                // Showcases -> another tab -> Showcases
  await p.until(() => p.gates.hierarchy);
  g1.resolve(H_4133);
  await first;
  assert.equal(p.log.standings, 0, 'the older load asked for no tables');
  p.gates.hierarchy.resolve(H_4133);
  await second;
  assert.equal(p.log.standings, 1);
  assert.equal(p.log.hashes, 1);
});

test('S: an older load whose tables answer after a newer one started paints and saves nothing (tables phase)', async () => {
  const p = showcasePage({ holdStandings: true });
  const first = p.loadShowcaseFlight();
  await p.until(() => p.gates.standings);
  const g1 = p.gates.standings; delete p.gates.standings;
  const second = p.loadShowcaseFlight();
  await p.until(() => p.gates.standings);
  g1.resolve(ANSWER);
  await first;
  assert.deepEqual([p.log.saves, p.log.hashes], [0, 0], 'the older load saved nothing');
  assert.equal(p.el('standingsContainer').children.length, 0, 'and painted nothing');
  p.gates.standings.resolve(ANSWER);
  await second;
  assert.deepEqual(p.el('standingsContainer').children.map(c => c.kind), ['results']);
  assert.equal(p.log.hashes, 1);
});

test('S: an older load that fails after a newer one started paints no error', async () => {
  const p = showcasePage({ holdHierarchy: true });
  const first = p.loadShowcaseFlight();
  await p.until(() => p.gates.hierarchy);
  const g1 = p.gates.hierarchy; delete p.gates.hierarchy;
  const second = p.loadShowcaseFlight();
  await p.until(() => p.gates.hierarchy);
  g1.reject(refused(503));
  await first;
  assert.doesNotMatch(p.el('standingsContainer').innerHTML, /Couldn't load/);
  p.gates.hierarchy.resolve(H_4133);
  await second;
  assert.deepEqual(p.el('standingsContainer').children.map(c => c.kind), ['results']);
});

// Review R5 (M2): "Try again" on a failed table, then Results <-> Games before the retry answers.
test('S R5: a retry is not dropped by a re-render that starts while it loads', async () => {
  const p = showcasePage({ holdStandings: true });
  const first = p.loadShowcaseFlight();
  await p.until(() => p.gates.standings);
  const g0 = p.gates.standings; delete p.gates.standings;
  g0.reject(refused(503));
  await first;
  assert.deepEqual(p.el('standingsContainer').children.map(c => c.kind).filter(Boolean), ['failed']);
  const retry = p.loadShowcaseFlight();                 // Try again
  await p.until(() => p.gates.standings);
  await p.loadShowcaseFlight({ rerender: true });       // Results <-> Games while the retry loads
  p.gates.standings.resolve(ANSWER);
  await retry;
  assert.deepEqual(p.el('standingsContainer').children.map(c => c.kind).filter(Boolean), ['results'], 'the retry painted its table');
});
