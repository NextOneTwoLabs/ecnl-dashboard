import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolveResource, dataApi } from '../api/data-api.mjs';
import { assetPath } from '../api/archive-reader.mjs';
import worker from '../worker.js';

const request = (path, options) => new Request('https://ecnl.nextonetwo.com' + path, options);
const cases = JSON.parse(await readFile(new URL('./routes.json', import.meta.url)));
const root = new URL('../public/', import.meta.url);
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

test('each archived resource is returned byte-for-byte by one asset read', async () => {
  let count = 0;
  for (const file of await readdir(new URL('archive/api/Event/', root), { recursive: true })) {
    const path = file.replaceAll('\\', '/');
    let match, endpoint;
    if ((match = /^get-event-schedule-or-standings\/(\d+)\.json$/.exec(path))) endpoint = `/api/v1/events/${match[1]}/hierarchy`;
    if ((match = /^get-standings-by-div-and-flight\/(\d+)\/(\d+)\/(\d+)\.json$/.exec(path))) endpoint = `/api/v1/events/${match[3]}/divisions/${match[1]}/flights/${match[2]}/standings`;
    if ((match = /^get-schedules-by-flight\/(\d+)\/(\d+)\/0\.json$/.exec(path))) endpoint = `/api/v1/events/${match[1]}/flights/${match[2]}/schedule`;
    if (!endpoint) continue;
    let reads = 0;
    const response = await dataApi(request(endpoint), { ASSETS: { fetch(req) { reads++; return env.ASSETS.fetch(req); } } });
    assert.equal(response.status, 200, endpoint);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('archive/api/Event/' + path, root)));
    assert.equal(reads, 1);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    count++;
  }
  for (const file of await readdir(new URL('archive/teams/', root))) {
    const match = /^(\d{4}-\d{2})\.json$/.exec(file);
    if (!match) continue;
    let reads = 0;
    const response = await dataApi(request(`/api/v1/seasons/${match[1]}/teams`), { ASSETS: { fetch(req) { reads++; return env.ASSETS.fetch(req); } } });
    assert.equal(response.status, 200, file);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('archive/teams/' + file, root)));
    assert.equal(reads, 1);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    count++;
  }
  {
    let reads = 0;
    const response = await dataApi(request('/api/v1/clubs'), { ASSETS: { fetch(req) { reads++; return env.ASSETS.fetch(req); } } });
    assert.equal(response.status, 200, '/api/v1/clubs');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('archive/clubs.json', root)));
    assert.equal(reads, 1);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    count++;
  }
  assert.ok(count > 1200, `only ${count} resources checked`);
  console.log(`Archive parity: ${count} resources`);
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
    const response = await dataApi(request('/api/v1/seasons/2026-27/teams', { method, headers: { 'if-none-match': '"fixture"' } }), { ASSETS: { fetch(req) {
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
