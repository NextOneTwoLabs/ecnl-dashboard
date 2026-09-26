// #92: the page's own request logic (public/index.html), run in Node with a stubbed fetch and
// clock. A refused request (429, or any 4xx but 404) must mean "try again", never "no index"
// or "not found": no fallback scan, no next season, one request per refusal at most. A 5xx, a
// network error or bad JSON is "try again" too, but not remembered.
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
const CODE = [
  block('    let sessionRenewAt = 0', 'function noteSession('),
  block('    async function fetchJSON(', 'function failedFlightPanel('),
  block('    async function getEventHierarchy(', 'function mergeStandingsBlocks('),
  block('    const teamIndexMemo = {};', 'function getTeamIndex('),
  block('    async function resolveFavorite(', 'async function resolveFavorite('),
].join('\n');

const SEASON = '2026-27';
const SEASONS = Object.fromEntries(['2026-27', '2025-26', '2024-25'].map((s, i) => [s, {
  conferences: Object.fromEntries(['A', 'B', 'C'].map((c, j) => [c, { eventId: 100 + 10 * i + j }])),
}]));
const hierarchy = { girlsDivAndFlightList: [{ divisionID: 1, divisionName: 'G2012', flightList: [{ flightID: 7, flightName: 'ECNL' }, { flightID: 8, flightName: 'ECNL II' }] }] };
const HELP = 'https://github.com/NextOneTwoLabs/ecnl-dashboard/blob/main/docs/data-api.md#api-keys';

// answer(url) -> { status, session, body } or an Error (a network failure). `head` answers the
// renewal HEAD / (a status, or an Error), one event-loop turn later (see settle). `delay` holds
// every answer back that many ms. `bodyDelay` sends each API body that many ms after its headers,
// and `step` moves the clock that far when a renewal lands and when a slow body arrives.
function page(answer, { head = 200, delay = 0, bodyDelay = 0, step = 0 } = {}) {
  const calls = [], clock = { t: 1e12 };
  const fetch = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (url === '/') {
      await new Promise(r => setImmediate(r));
      clock.t += step;
      if (head instanceof Error) throw head;
      return new Response(null, { status: head });
    }
    const a = answer(url);
    if (a instanceof Error) throw a;
    const text = a.raw ?? JSON.stringify(a.body ?? (a.status === 429 ? { ok: false, error: 'Too many requests. Please wait a minute and try again.', help: HELP } : {}));
    const body = !bodyDelay ? text : new ReadableStream({ async start(c) {
      await new Promise(r => setTimeout(r, bodyDelay));
      clock.t += step;
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    } });
    return new Response(body,
      { status: a.status, headers: { 'content-type': 'application/json', 'x-ecnl-session': a.session || 'none' } });
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const adoptStandingsRow = (rec, t, extra) => Object.assign(rec, { teamID: t.teamID, name: t.name }, extra);
  const favoriteResolved = rec => !!(rec && rec.eventID && rec.divisionID && rec.flightID);
  const api = new Function('LIVE', 'fetch', 'Date', 'dataUrl', 'esc', 'eventHierarchy', 'currentFlightData', 'currentSeason',
    'SEASONS', 'adoptStandingsRow', 'favoriteResolved', 'eventContext', 'undateBorrowedDates',
    CODE + '\nreturn { noteSession, fetchJSON, isRefusal, retryText, getTeamIndex, resolveFavorite };')(
    false, fetch, { now: () => clock.t }, p => '/api/v1/' + p, esc, {}, [], SEASON,
    SEASONS, adoptStandingsRow, favoriteResolved, () => null, g => g);
  const apiCalls = () => calls.filter(c => c.startsWith('GET /api/v1/'));
  const heads = () => calls.filter(c => c === 'HEAD /').length;
  return { ...api, calls, apiCalls, heads, clock };
}
const route = table => url => { for (const [re, a] of table) if (re.test(url)) return a; return { status: 200, body: {} }; };
const INDEX = /\/seasons\/[^/]+\/teams$/;
const ok = { status: 200, session: 'ok' };
const indexOk = { ...ok, body: { schema: 1, season: SEASON, teams: [] } };
const answer = session => ({ headers: new Headers({ 'x-ecnl-session': session }) });
const settle = () => new Promise(r => setImmediate(r));   // lets a renewal HEAD / land

test('index: a 429 rejects with "try again", is remembered for a minute, then asked again', async () => {
  const p = page(route([[INDEX, { status: 429, session: 'none' }]]));
  const e = await p.getTeamIndex(SEASON).then(() => null, err => err);
  assert.equal(e.status, 429);
  assert.equal(e.session, 'none');
  assert.equal(p.retryText(e), 'Too many requests. Try again in a minute, or allow cookies for this site and reload the page.');
  assert.ok(!JSON.stringify({ message: e.message, ...e }).includes('github.com'), 'the help URL never reaches the page');
  for (let i = 0; i < 20; i++) await assert.rejects(p.getTeamIndex(SEASON));   // keystrokes
  assert.equal(p.apiCalls().length, 1, 'one request for a minute of keystrokes');
  p.clock.t += 60000;
  await assert.rejects(p.getTeamIndex(SEASON));
  assert.equal(p.apiCalls().length, 2);
});

test('index: in a tab that blocks cookies, a "none" refusal costs one more request after the renewal, no more', async () => {
  const p = page(route([[INDEX, { status: 429, session: 'none' }]]));
  await assert.rejects(p.getTeamIndex(SEASON));      // its "none" answer sends the renewal
  p.clock.t += 50;
  await settle();                                    // it lands, but the browser drops the cookie
  p.clock.t += 300;
  for (let i = 0; i < 20; i++) await assert.rejects(p.getTeamIndex(SEASON));
  assert.equal(p.apiCalls().length, 2, 'asked once more after the renewal (S1), then remembered');
  assert.equal(p.heads(), 1, 'that second "none" stops renewal');
});

test('index: every other 4xx is treated like a 429; a session-tier 429 has no cookie hint', async () => {
  for (const status of [400, 401, 403, 405, 410]) {
    const p = page(route([[INDEX, { status, session: 'ok' }]]));
    const e = await p.getTeamIndex(SEASON).then(() => null, err => err);
    assert.equal(e.status, status);
    assert.ok(p.isRefusal(e));
    await assert.rejects(p.getTeamIndex(SEASON));
    assert.equal(p.apiCalls().length, 1, `${status} is remembered`);
    assert.equal(p.retryText(e), 'Please try again shortly.');
  }
  const p = page(route([[INDEX, { status: 429, session: 'ok' }]]));
  assert.equal(p.retryText(await p.getTeamIndex(SEASON).catch(e => e)), 'Too many requests. Try again in a minute.');
});

test('index: a 404 or an unknown schema means "no index" (scan), kept for the session', async () => {
  for (const a of [{ status: 404 }, { status: 200, body: { schema: 2 } }]) {
    const p = page(route([[INDEX, a]]));
    assert.equal(await p.getTeamIndex(SEASON), null);
    assert.equal(await p.getTeamIndex(SEASON), null);
    assert.equal(p.apiCalls().length, 1);
  }
});

test('index: a 503, a network error or bad JSON rejects (no scan) and is not remembered', async () => {
  for (const a of [{ status: 503, session: 'ok' }, new TypeError('Failed to fetch'), { status: 200, session: 'ok', raw: '{"schema":1,' }]) {
    const p = page(route([[INDEX, a]]));
    const e = await p.getTeamIndex(SEASON).then(() => null, err => err);
    assert.ok(e && !p.isRefusal(e));
    assert.equal(p.retryText(e), 'Please try again shortly.');
    await assert.rejects(p.getTeamIndex(SEASON));
    assert.equal(p.apiCalls().length, 2, 'the next call asks once more');
  }
});

test('index (X1): concurrent calls share one request, and a 200 is kept for the session', async () => {
  const p = page(route([[INDEX, indexOk]]), { delay: 5 });
  assert.deepEqual(await Promise.all([p.getTeamIndex(SEASON), p.getTeamIndex(SEASON), p.getTeamIndex(SEASON)]), [[], [], []]);
  assert.equal(p.apiCalls().length, 1);
  p.clock.t += 3600e3;
  assert.deepEqual(await p.getTeamIndex(SEASON), []);
  assert.equal(p.apiCalls().length, 1, 'kept for the session');
});

test('index (X2): after the minute, a 200 replaces the refusal and is kept', async () => {
  let refusing = true;
  const p = page(url => INDEX.test(url) ? (refusing ? { status: 429, session: 'ok' } : indexOk) : ok);
  await assert.rejects(p.getTeamIndex(SEASON));
  refusing = false;
  p.clock.t += 30000;
  await assert.rejects(p.getTeamIndex(SEASON), 'still remembered within the minute');
  p.clock.t += 30000;
  assert.deepEqual(await p.getTeamIndex(SEASON), []);
  p.clock.t += 600000;
  assert.deepEqual(await p.getTeamIndex(SEASON), []);
  assert.equal(p.apiCalls().length, 2);
});

test('index (S1): a "none" refusal is forgotten once the session is back; a session-tier one is not', async () => {
  // An answer that says "ok" (or "renewed"): the next search asks again, and gets the index.
  // (Here the renewal HEAD / fails, so only that answer brings the session back.)
  let refusing = true;
  const p = page(url => INDEX.test(url) ? (refusing ? { status: 429, session: 'none' } : indexOk) : ok, { head: 503 });
  await assert.rejects(p.getTeamIndex(SEASON));
  refusing = false;
  p.clock.t += 2000;
  await assert.rejects(p.getTeamIndex(SEASON), 'still remembered while the session is not back');
  p.noteSession(answer('renewed'), p.clock.t);
  p.clock.t += 1;
  assert.deepEqual(await p.getTeamIndex(SEASON), []);
  assert.equal(p.apiCalls().length, 2);

  // A renewal that lands (HEAD / answers 2xx) brings the cookie back too.
  refusing = true;
  const q = page(url => INDEX.test(url) ? (refusing ? { status: 429, session: 'none' } : indexOk) : ok);
  await assert.rejects(q.getTeamIndex(SEASON));      // its "none" answer sends the renewal
  assert.equal(q.heads(), 1);
  q.clock.t += 50;
  await settle();                                    // the renewal lands, after the refusal
  refusing = false;
  q.clock.t += 2000;
  assert.deepEqual(await q.getTeamIndex(SEASON), []);
  assert.equal(q.apiCalls().length, 2);

  // A session-tier 429 ("ok") stays remembered for its minute whatever other answers say.
  const r = page(route([[INDEX, { status: 429, session: 'ok' }]]));
  await assert.rejects(r.getTeamIndex(SEASON));
  r.clock.t += 1000;
  r.noteSession(answer('ok'), r.clock.t);
  r.clock.t += 1000;
  await assert.rejects(r.getTeamIndex(SEASON));
  assert.equal(r.apiCalls().length, 1);
});

test('index (S1): a refusal is dated by when its request was sent, so a renewal that lands while its body is read still clears it', async () => {
  // Sent at t; its "none" headers start the renewal, which lands at t+10; the refused body is
  // read at t+20. Dated by arrival (t+20), the refusal would look newer than the session's
  // return and the next search would send nothing.
  let refusing = true;
  const p = page(url => INDEX.test(url) ? (refusing ? { status: 429, session: 'none' } : indexOk) : ok, { bodyDelay: 20, step: 10 });
  const sent = p.clock.t;
  await assert.rejects(p.getTeamIndex(SEASON));
  assert.equal(p.heads(), 1);
  assert.equal(p.clock.t, sent + 20, 'the renewal landed (t+10) before the refused body was read (t+20)');
  refusing = false;
  p.clock.t += 1000;
  assert.deepEqual(await p.getTeamIndex(SEASON), [], 'the next search asks again');
  assert.equal(p.apiCalls().length, 2);
});

test('team lookup: a refused index stops at once, with no scan and no other season', async () => {
  const p = page(route([[INDEX, { status: 429, session: 'none' }]]));
  await assert.rejects(p.resolveFavorite({ name: 'Nobody', teamID: 1 }), e => e.status === 429);
  assert.deepEqual(p.apiCalls(), ['GET /api/v1/seasons/2026-27/teams']);
});

test('team lookup without an index: a refusal during the scan rejects, with no second season', async () => {
  const p = page(route([[INDEX, { status: 404 }], [/hierarchy$/, { ...ok, body: hierarchy }], [/standings$/, { status: 429, session: 'none' }]]));
  await assert.rejects(p.resolveFavorite({ name: 'Nobody', teamID: 1 }), e => e.status === 429);
  const calls = p.apiCalls();
  assert.equal(calls.filter(c => INDEX.test(c)).length, 1, 'no second season');
  // Requests already sent in that season finish; none of another season starts.
  assert.ok(calls.length <= 1 + 3 + 6, `at most one season's scan (${calls.length})`);
});

test('team lookup without an index (S4): a 503 or a network error during the scan rejects too, never "not found"', async () => {
  for (const failure of [{ status: 503, session: 'ok' }, new TypeError('Failed to fetch')]) {
    const p = page(route([[INDEX, { status: 404 }], [/hierarchy$/, { ...ok, body: hierarchy }], [/standings$/, failure]]));
    const e = await p.resolveFavorite({ name: 'Nobody', teamID: 1 }).then(() => null, err => err);
    assert.ok(e && !p.isRefusal(e), 'rejects instead of resolving false');
    assert.equal(p.retryText(e), 'Please try again shortly.');
    assert.equal(p.apiCalls().filter(c => INDEX.test(c)).length, 1, 'no second season');
  }
});

test('team lookup without an index still finds a team, and a 404 flight is skipped', async () => {
  const standings = { data: { teamStandings: [{ teamID: 42, name: 'Found FC' }] } };
  const p = page(route([[INDEX, { status: 404 }], [/hierarchy$/, { ...ok, body: hierarchy }],
    [/\/events\/102\/divisions\/1\/flights\/8\/standings$/, { ...ok, body: standings }], [/standings$/, { status: 404 }]]));
  const rec = { name: 'Found FC', teamID: 42 };
  assert.equal(await p.resolveFavorite(rec), true);
  assert.equal(rec.eventID, 102);
  assert.equal(rec.flightID, 8);
});

test('renewal: one background HEAD /, and none after a renewal that did not stick', async () => {
  const p = page(() => ok);
  const sentBefore = p.clock.t;
  p.noteSession(answer('none'), sentBefore);
  assert.equal(p.heads(), 1);
  await settle();                                    // the renewal lands
  p.clock.t += 10;
  p.noteSession(answer('none'), sentBefore);         // sent before it landed: still renewing
  p.noteSession(answer('none'), p.clock.t);          // sent after it landed: cookies are blocked
  p.clock.t += 120000;
  p.noteSession(answer('none'), p.clock.t);
  assert.equal(p.heads(), 1, 'no renewal once cookies are known to be blocked');
  p.noteSession(answer('ok'), p.clock.t);            // cookies work again (for example, allowed)
  p.noteSession(answer('none'), p.clock.t);
  assert.equal(p.heads(), 2);
});

test('renewal: "renewed" re-enables renewal like "ok"', async () => {
  const p = page(() => ok);
  p.noteSession(answer('none'), p.clock.t);
  await settle();
  p.clock.t += 10;
  p.noteSession(answer('none'), p.clock.t);          // blocked
  p.clock.t += 120000;
  p.noteSession(answer('none'), p.clock.t);
  assert.equal(p.heads(), 1);
  p.noteSession(answer('renewed'), p.clock.t);
  p.noteSession(answer('none'), p.clock.t);
  assert.equal(p.heads(), 2);
});

test('renewal (S2): a HEAD / that fails (5xx or network) does not count, so renewal goes on', async () => {
  for (const head of [503, new TypeError('offline')]) {
    const p = page(() => ok, { head });
    p.noteSession(answer('none'), p.clock.t);
    await settle();
    p.clock.t += 10;
    p.noteSession(answer('none'), p.clock.t);        // sent after the failed renewal: not "blocked"
    assert.equal(p.heads(), 1, 'still at most once a minute');
    p.clock.t += 60000;
    p.noteSession(answer('none'), p.clock.t);
    assert.equal(p.heads(), 2, `renews again a minute later (${head})`);
  }
});
