import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolveResource, dataApi, CLOSED_CACHE, resetCatalogMemo } from '../api/data-api.mjs';
import { assetPath } from '../api/archive-reader.mjs';
import worker from '../worker.js';

const request = (path, options) => new Request('https://ecnl.nextonetwo.com' + path, options);
const root = new URL('../public/', import.meta.url);
// The team-history files (#107) are committed separately from the code: without them, the
// history 200 cases are skipped (and logged), not failed.
const cases = JSON.parse(await readFile(new URL('./routes.json', import.meta.url))).filter(([path, status]) => {
  const m = /^\/api\/v1\/teams\/(\d+)\/history$/.exec(path);
  if (!m || status !== 200 || existsSync(new URL(`archive/history/${m[1]}.json`, root))) return true;
  console.log(`skipped (no history data): ${path}`);
  return false;
});
const env = { ASSETS: { async fetch(req) {
  try { return new Response(await readFile(new URL(new URL(req.url).pathname.slice(1), root)), { headers: { 'content-type': 'application/json', etag: '"fixture"' } }); }
  catch { return new Response('<html>missing</html>', { status: 404 }); }
} } };

test('shared route cases, methods, HEAD and JSON failures', async () => {
  for (const [path, status] of cases) {
    assert.equal(resolveResource(path).status || 200, status, path);
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      const response = await dataApi(request(path, { method }), env);
      assert.equal(response.status, status === 200 && !['GET', 'HEAD'].includes(method) ? 405 : status, path);
      assert.match(response.headers.get('content-type'), /application\/json/);
      if (method === 'HEAD') assert.equal(await response.text(), '');
      if (response.status === 405) assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  }
});

// #82: the policy each archived resource should get, derived here from the catalog on its own
// terms (a season earlier than refresh.activeSeason), not by the code under test.
const catalog = JSON.parse(await readFile(new URL('data/sources.json', root)));
const ACTIVE = catalog.refresh.activeSeason;
const eventSeason = {};
for (const [season, s] of Object.entries(catalog.seasons)) {
  for (const kind of ['conferences', 'national', 'showcases']) for (const e of Object.values(s[kind] || {})) eventSeason[e.eventId] = season;
}
const expectedPolicy = season => season && season < ACTIVE ? CLOSED_CACHE : 'no-cache';

test('each archived resource is returned byte-for-byte with its cache policy: one asset read each, plus the catalog once', async () => {
  resetCatalogMemo();
  let reads = 0, catalogReads = 0, count = 0;
  const counted = { ASSETS: { fetch(req) { reads++; if (new URL(req.url).pathname === '/data/sources.json') catalogReads++; return env.ASSETS.fetch(req); } } };
  const tally = {};
  const check = async (endpoint, file, policy) => {
    const response = await dataApi(request(endpoint), counted);
    assert.equal(response.status, 200, endpoint);
    assert.equal(response.headers.get('cache-control'), policy, endpoint);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(file), endpoint);
    tally[policy] = (tally[policy] || 0) + 1;
    count++;
  };
  for (const file of await readdir(new URL('archive/api/Event/', root), { recursive: true })) {
    const path = file.replaceAll('\\', '/');
    let match, endpoint, event;
    if ((match = /^get-event-schedule-or-standings\/(\d+)\.json$/.exec(path))) [endpoint, event] = [`/api/v1/events/${match[1]}/hierarchy`, match[1]];
    if ((match = /^get-standings-by-div-and-flight\/(\d+)\/(\d+)\/(\d+)\.json$/.exec(path))) [endpoint, event] = [`/api/v1/events/${match[3]}/divisions/${match[1]}/flights/${match[2]}/standings`, match[3]];
    if ((match = /^get-schedules-by-flight\/(\d+)\/(\d+)\/0\.json$/.exec(path))) [endpoint, event] = [`/api/v1/events/${match[1]}/flights/${match[2]}/schedule`, match[1]];
    if (!endpoint) continue;
    await check(endpoint, new URL('archive/api/Event/' + path, root), expectedPolicy(eventSeason[event]));
  }
  for (const file of await readdir(new URL('archive/teams/', root))) {
    const match = /^(\d{4}-\d{2})\.json$/.exec(file);
    if (match) await check(`/api/v1/seasons/${match[1]}/teams`, new URL('archive/teams/' + file, root), expectedPolicy(match[1]));
  }
  await check('/api/v1/clubs', new URL('archive/clubs.json', root), 'no-cache');
  await check('/api/v1/teams', new URL('archive/directory.json', root), 'no-cache');   // #114, its own kind
  for (const file of existsSync(new URL('archive/history/', root)) ? await readdir(new URL('archive/history/', root)) : []) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match) await check(`/api/v1/teams/${match[1]}/history`, new URL('archive/history/' + file, root), 'no-cache');
  }
  assert.ok(count > 1200, `only ${count} resources checked`);
  assert.ok(tally[CLOSED_CACHE] > 1000, 'most event resources are closed');
  assert.equal(catalogReads, 1, 'the catalog is read once per isolate');
  assert.equal(reads, count + 1, 'one asset read per resource, plus the catalog once');
  console.log(`Archive parity: ${count} resources (${tally[CLOSED_CACHE]} closed, ${tally['no-cache']} no-cache), ${reads} asset reads`);
});

// #82: tests/cache-policy.json, shared with tests/test_data_api.py.
const policyCases = JSON.parse(await readFile(new URL('./cache-policy.json', import.meta.url)));
const policyOf = expected => expected === 'closed' ? policyCases.closed : expected;

test('cache policy: the shared archive rows, directly and through the Worker with sessions off', async () => {
  assert.equal(CLOSED_CACHE, policyCases.closed);
  let rows = 0;
  for (const [path, expected, method = 'GET'] of policyCases.archive) {
    const history = /^\/api\/v1\/teams\/(\d+)\/history$/.exec(path);
    if (history && !existsSync(new URL(`archive/history/${history[1]}.json`, root))) { console.log(`skipped (no history data): ${path}`); continue; }
    for (const [label, fetchIt] of [['dataApi', r => dataApi(r, env)], ['worker (off)', r => worker.fetch(r, env)]]) {
      resetCatalogMemo();
      const response = await fetchIt(request(path, { method }));
      assert.equal(response.headers.get('cache-control'), policyOf(expected), `${label} ${method} ${path}`);
      assert.equal(response.status === 200, expected !== 'no-store', `${label} ${method} ${path}: ${response.status}`);
      assert.equal(response.headers.get('vary'), null);
      if (response.status === 200) assert.ok(response.headers.get('etag'), `${label} ${path}: the ETag is kept`);
    }
    rows++;
  }
  assert.ok(rows >= 24);
});

// A stand-in for ASSETS that serves `text` as the catalog (or a 404, or HTML) and stub data elsewhere.
function catalogEnv({ text, missing = false, html = false } = {}) {
  const env = { reads: 0, catalogReads: 0, ASSETS: { async fetch(req) {
    env.reads++;
    const path = new URL(req.url).pathname;
    if (path === '/data/sources.json') {
      env.catalogReads++;
      assert.equal(req.method, 'GET', 'the catalog read is a GET');
      assert.equal(req.headers.get('if-none-match'), null, 'the catalog read carries no validator');
      if (missing) return new Response('<html>missing</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(text, { headers: { 'content-type': html ? 'text/html' : 'application/json', etag: '"catalog"' } });
    }
    if (req.headers.get('if-none-match') === '"stub"') return new Response(null, { status: 304, headers: { etag: '"stub"' } });
    return new Response(req.method === 'HEAD' ? null : JSON.stringify({ stub: path }), { headers: { 'content-type': 'application/json', etag: '"stub"' } });
  } } };
  return env;
}
// The case's catalog text: the shared catalog with one change, as tests/test_data_api.py builds it.
function caseCatalog(c) {
  if ('raw' in c) return c.raw;
  const cat = structuredClone(policyCases.catalogs.catalog);
  if ('activeSeason' in c) cat.refresh.activeSeason = c.activeSeason;
  if (c.without) delete cat[c.without];
  if (c.seasons) cat.seasons = c.seasons;
  return JSON.stringify(cat);
}

test('cache policy: the shared catalog cases (rollover; broken, malformed, numeric, padded) fail safe with the data served', async () => {
  const { paths, cases } = policyCases.catalogs;
  for (const c of cases) {
    resetCatalogMemo();
    const env = catalogEnv({ text: caseCatalog(c), missing: c.missing, html: c.html });
    for (const path of paths) {
      for (const method of ['GET', 'HEAD']) {
        const response = await dataApi(request(path, { method }), env);
        assert.equal(response.status, 200, `${c.name}: ${method} ${path}`);
        assert.equal(response.headers.get('cache-control'), c.closed.includes(path) ? policyCases.closed : 'no-cache', `${c.name}: ${method} ${path}`);
        assert.equal(await response.text(), method === 'HEAD' ? '' : JSON.stringify({ stub: assetPath(resolveResource(path)) }), `${c.name}: ${path} body`);
      }
    }
  }
  console.log(`Cache policy: ${cases.length} catalog cases x ${paths.length} paths`);
});

test('cache policy: the catalog is read once per isolate (N + 1 reads); a failed read is not kept', async () => {
  const closed = '/api/v1/seasons/2024-25/teams';
  resetCatalogMemo();
  const good = catalogEnv({ text: caseCatalog({}) });
  for (let i = 0; i < 5; i++) assert.equal((await dataApi(request(closed), good)).headers.get('cache-control'), CLOSED_CACHE);
  assert.deepEqual([good.reads, good.catalogReads], [6, 1], '5 answers, 6 reads');
  // Each kind of failed read gives no-cache, with the data, and is not kept.
  resetCatalogMemo();
  for (const failing of [{ ASSETS: { fetch: req => new URL(req.url).pathname === '/data/sources.json' ? Promise.reject(new Error('fixture fault')) : good.ASSETS.fetch(req) } },
    catalogEnv({ text: '{' }), catalogEnv({ missing: true }), catalogEnv({ text: caseCatalog({ activeSeason: 'zzz' }) })]) {
    const response = await dataApi(request(closed), failing);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  const retry = catalogEnv({ text: caseCatalog({}) });
  assert.equal((await dataApi(request(closed), retry)).headers.get('cache-control'), CLOSED_CACHE, 'the next request reads again');
  assert.equal(retry.catalogReads, 1);
  // Once read, the isolate keeps it: a Worker version's assets never change.
  const later = catalogEnv({ missing: true });
  assert.equal((await dataApi(request(closed), later)).headers.get('cache-control'), CLOSED_CACHE);
  assert.equal(later.catalogReads, 0);
  // Routes that are never closed make their one read and nothing more (the catalog route's
  // one read is the catalog itself).
  resetCatalogMemo();
  const other = catalogEnv({ text: caseCatalog({}) });
  for (const path of ['/api/v1/catalog', '/api/v1/status', '/api/v1/clubs', '/api/v1/teams/55477/history', '/api/v1/teams']) await dataApi(request(path), other);
  assert.deepEqual([other.reads, other.catalogReads], [5, 1]);
});

test('cache policy: a closed 304 carries the one-day policy (renewing the stored copy), an active 304 no-cache', async () => {
  for (const [path, policy] of [['/api/v1/seasons/2024-25/teams', CLOSED_CACHE], ['/api/v1/events/3157/flights/24009/schedule', CLOSED_CACHE],
    ['/api/v1/seasons/2026-27/teams', 'no-cache'], ['/api/v1/events/4263/hierarchy', 'no-cache']]) {
    for (const method of ['GET', 'HEAD']) {
      resetCatalogMemo();
      const assets = catalogEnv({ text: caseCatalog({}) });
      const response = await dataApi(request(path, { method, headers: { 'if-none-match': '"stub"' } }), assets);
      assert.equal(response.status, 304, `${method} ${path}`);
      assert.equal(response.headers.get('cache-control'), policy, `${method} ${path}`);
      assert.equal(response.headers.get('etag'), '"stub"');
      assert.equal(await response.text(), '');
      assert.equal(assets.catalogReads, 1, 'the catalog was read, not the fail-safe path');
    }
  }
});

test('conditional validators forwarded; 304 and HEAD have no body', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await dataApi(request('/api/v1/catalog', { method, headers: { 'if-none-match': '"fixture"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT', cookie: 'private=yes', range: 'bytes=0-4' } }), { ASSETS: { fetch(req) {
      assert.equal(req.method, method);
      assert.equal(new URL(req.url).pathname, '/data/sources.json');
      assert.equal(req.headers.get('if-none-match'), '"fixture"');
      assert.ok(req.headers.get('if-modified-since'));
      assert.equal(req.headers.get('cookie'), null);
      assert.equal(req.headers.get('range'), null);
      return new Response(null, { status: 304, headers: { etag: '"fixture"' } });
    } } });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('etag'), '"fixture"');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), '');
  }
});

test('team index: validators forwarded to its asset path; 304 and HEAD have no body', async () => {
  for (const method of ['GET', 'HEAD']) {
    resetCatalogMemo();
    // #82: the catalog is served too, so the policy comes from it, not from the fail-safe path.
    const response = await dataApi(request('/api/v1/seasons/2026-27/teams', { method, headers: { 'if-none-match': '"fixture"' } }), { ASSETS: { fetch(req) {
      if (new URL(req.url).pathname === '/data/sources.json') return env.ASSETS.fetch(req);
      assert.equal(req.method, method);
      assert.equal(new URL(req.url).pathname, '/archive/teams/2026-27.json');
      assert.equal(req.headers.get('if-none-match'), '"fixture"');
      return new Response(null, { status: 304, headers: { etag: '"fixture"' } });
    } } });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), '');
  }
});

test('club places: validators forwarded to its asset path; 304 and HEAD have no body', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await dataApi(request('/api/v1/clubs', { method, headers: { 'if-none-match': '"fixture"' } }), { ASSETS: { fetch(req) {
      assert.equal(req.method, method);
      assert.equal(new URL(req.url).pathname, '/archive/clubs.json');
      assert.equal(req.headers.get('if-none-match'), '"fixture"');
      return new Response(null, { status: 304, headers: { etag: '"fixture"' } });
    } } });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), '');
  }
});

test('a season without an index is a JSON 404, never HTML', async () => {
  for (const path of ['/api/v1/seasons/2030-31/teams', '/api/v1/seasons/2099-00/teams']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await dataApi(request(path, { method }), env);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (method === 'GET') assert.deepEqual(await response.json(), { ok: false, error: 'Not found' });
      else assert.equal(await response.text(), '');
    }
  }
});

// The page's own mergeStandingsBlocks (public/index.html) must rank every flight as
// archive.py's merge_standings_blocks did when it built the team index (#81), so an
// index lookup or search shows the rank the conference page shows.
test('page JS merge matches the team index ranks', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const start = html.indexOf('function mergeStandingsBlocks(');
  const end = html.slice(start).search(/\r?\n {4}\}\r?\n/);
  assert.ok(start >= 0 && end > 0, 'mergeStandingsBlocks not found in index.html');
  const mergeStandingsBlocks = new Function(html.slice(start, start + end) + '\n}\nreturn mergeStandingsBlocks;')();
  let rows = 0, multi = 0, flights = 0;
  for (const file of await readdir(new URL('archive/teams/', root))) {
    if (!/^\d{4}-\d{2}\.json$/.test(file)) continue;
    const byFlight = new Map();
    for (const t of JSON.parse(await readFile(new URL('archive/teams/' + file, root), 'utf8')).teams) {
      const key = `${t.divisionID}/${t.flightID}/${t.eventID}`;
      if (!byFlight.has(key)) byFlight.set(key, []);
      byFlight.get(key).push(t);
    }
    for (const [key, teams] of byFlight) {
      const data = JSON.parse(await readFile(new URL(`archive/api/Event/get-standings-by-div-and-flight/${key}.json`, root), 'utf8')).data;
      const blocks = Array.isArray(data) ? data : (data ? [data] : []);
      const merged = (mergeStandingsBlocks(blocks) || { teamStandings: [] }).teamStandings;
      const fields = ['teamID', 'name', 'gp', 'wins', 'losses', 'draws', 'standingpoints', 'goaldifferential'];
      assert.deepEqual(teams.map(t => [t.rank, ...fields.map(k => t[k])]), merged.map((t, i) => [i + 1, ...fields.map(k => t[k])]),
        `${file} flight ${key}: page merge differs from the index (python archive.py --team-index --all, then commit)`);
      if (blocks.filter(b => b && (b.teamStandings || []).length).length > 1) multi++;
      rows += teams.length;
      flights++;
    }
  }
  assert.ok(multi >= 10, `only ${multi} multi-block flights checked`);
  console.log(`JS merge vs team index: ${rows} rows in ${flights} flights (${multi} multi-block), 0 mismatches`);
});

// #90: every route case answers the same through the Worker with sessions on, whether the
// request has no cookie or a forged one; only X-ECNL-Session says which tier served it.
const limiter = () => ({ async limit() { return { success: true }; } });
const sessionEnv = { ...env, SESSION_SECRET: 'r'.repeat(40), RL_SESSION: limiter(), RL_ANON: limiter(), RL_IP: limiter(), API_EVENTS: { writeDataPoint() {} } };
const forged = '__Host-ecnl_s=v1.1790000000.1790086400.AAAAAAAAAAAAAAAAAAAAAA.' + 'A'.repeat(43);

test('shared route cases through the Worker: no cookie and a forged cookie change nothing', async () => {
  for (const [path, status] of cases) {
    for (const cookie of [null, forged]) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
        const response = await worker.fetch(request(path, { method, headers: cookie ? { cookie } : {} }), sessionEnv);
        assert.equal(response.status, status === 200 && !['GET', 'HEAD'].includes(method) ? 405 : status, `${method} ${path} ${cookie ? 'forged' : 'no'} cookie`);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal(response.headers.get('x-ecnl-session'), 'none');
        assert.equal(response.headers.get('set-cookie'), null);
        // #82: a "none" answer is never kept with a lifetime, closed season or not.
        assert.doesNotMatch(response.headers.get('cache-control') || '', /max-age/, `${method} ${path}`);
        if (method === 'HEAD') assert.equal(await response.text(), '');
      }
    }
  }
});

test('HTML fallback, upstream error, thrown storage fault, throwing limiter and key import stay JSON', async () => {
  for (const [stored, expected] of [[() => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }), 404], [() => new Response('broken', { status: 500 }), 503], [() => { throw new Error('fixture fault'); }, 503]]) {
    const response = await dataApi(request('/api/v1/catalog'), { ASSETS: { fetch: stored } });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).ok, false);
  }
  // A fault in the session gate serves the data ungated (#90), never the assets' HTML.
  const logged = [], original = console.error, importKey = crypto.subtle.importKey;
  console.error = (...args) => logged.push(args[0]);
  const boom = { async limit() { throw new Error('limiter fault'); } };
  try {
    for (const faultEnv of [{ ...sessionEnv, RL_SESSION: boom, RL_ANON: boom, RL_IP: boom }, { ...sessionEnv, SESSION_SECRET: 'k'.repeat(40) }]) {
      if (faultEnv.RL_IP !== boom) crypto.subtle.importKey = async () => { throw new Error('import fault'); };
      for (const [path, status] of [['/api/v1/catalog', 200], ['/api/v1/unknown', 404]]) {
        // With a cookie, so the key import is reached (a request without one never verifies).
        const response = await worker.fetch(request(path, { headers: { cookie: forged } }), faultEnv);
        assert.equal(response.status, status, path);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal(response.headers.get('x-ecnl-session'), 'error');
      }
    }
  } finally {
    console.error = original;
    crypto.subtle.importKey = importKey;
  }
  assert.deepEqual(logged, ['session', 'session', 'session', 'session']);
});

test('Worker integration keeps redirects, feedback and static assets', async () => {
  assert.equal((await worker.fetch(request('/api/v1/unknown'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://ecnl-dashboard.nextonetwolabs.workers.dev/?a=1'), env)).headers.get('location'), 'https://ecnl.nextonetwo.com/?a=1');
  assert.equal((await worker.fetch(new Request('https://preview-ecnl-dashboard.nextonetwolabs.workers.dev/api/v1/catalog'), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/feedback'), env)).status, 405);
  const calls = [];
  const feedbackEnv = { ...env, FEEDBACK: { put(...args) { calls.push(args); } } };
  const body = JSON.stringify({ message: 'API regression test' });
  const response = await worker.fetch(request('/api/feedback', { method: 'POST', body, headers: { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'application/json' } }), feedbackEnv);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const home = await worker.fetch(request('/'), { ASSETS: { fetch: () => new Response('homepage') } });
  assert.equal(await home.text(), 'homepage');
});

test('direct visitor access to /archive and /data is blocked', async () => {
  const blockedPaths = [
    '/archive',
    '/archive/',
    '/archive/api/Event/get-event-schedule-or-standings/4263.json',
    '/archive/refresh-state.json',
    '/archive/match-days.json',
    '/archive/teams/2026-27.json',
    '/%61rchive/teams/2026-27.json',
    '/archive/clubs.json',
    '/%61rchive/clubs.json',
    '/archive/history/55477.json',
    '/data/team-links.json',
    '/data',
    '/data/',
    '/data/sources.json',
    '/%61rchive/refresh-state.json',
    '/%64ata/sources.json',
    '/Archive/refresh-state.json',
    '/%41rchive/refresh-state.json',
    '/./archive/refresh-state.json',
    '/foo/../data/sources.json',
  ];
  for (const path of blockedPaths) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await worker.fetch(request(path, { method }), env);
      assert.equal(response.status, 404, `${method} ${path} should be 404`);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (method === 'HEAD') {
        assert.equal(await response.text(), '');
      } else {
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.equal(body.error, 'Not found');
      }
    }
  }
});

test('#114: the team directory has its own route kind, not the season index kind', async () => {
  assert.deepEqual(resolveResource('/api/v1/teams'), { kind: 'directory' });
  assert.equal(assetPath(resolveResource('/api/v1/teams')), '/archive/directory.json');
  assert.equal(resolveResource('/api/v1/seasons/2026-27/teams').kind, 'teams');
  for (const path of ['/api/v1/teams/', '/api/v1/teams/directory', '/api/v1/teams.json']) assert.equal(resolveResource(path).status, 404, path);
  // No catalog read for it: cachePolicy treats only event kinds and the season index specially.
  resetCatalogMemo();
  let catalogReads = 0;
  const counting = { ASSETS: { fetch(req) { if (new URL(req.url).pathname === '/data/sources.json') catalogReads++; return env.ASSETS.fetch(req); } } };
  const response = await dataApi(request('/api/v1/teams'), counting);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(catalogReads, 0);
});
