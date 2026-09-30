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
