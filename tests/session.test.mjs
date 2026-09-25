// Session cookie and rate limits for /api/v1/* (#90). R1–R13 are the Reviewer's cases from the
// plan review, turned into assertions against the fixes adopted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mint, verify, readCookie, setCookie, ipKey, gate, decorate, COOKIE, TTL, RENEW_AFTER, COOKIE_MAX_AGE } from '../api/session.mjs';
import worker from '../worker.js';

const SECRET = 'a'.repeat(32) + '-test-secret';
const OTHER = 'b'.repeat(32) + '-other-secret';
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const req = (path, headers = {}, method = 'GET', host = 'ecnl.nextonetwo.com') => new Request(`https://${host}${path}`, { method, headers });
const cookieOf = response => /^__Host-ecnl_s=([^;]+);/.exec(response.headers.get('set-cookie') || '')?.[1];

function limiter(limit) {
  const counts = new Map();
  return { counts, async limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit }; } };
}
function sink() { const points = []; return { points, writeDataPoint(p) { points.push(p); } }; }
const limiters = (anon = 120) => ({ RL_SESSION: limiter(300), RL_ANON: limiter(anon), RL_IP: limiter(3000) });
const assets = { async fetch(r) {
  const p = new URL(r.url).pathname;
  if (p === '/') {
    const headers = { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate', etag: '"p"' };
    if (r.headers.get('if-none-match') === '"p"') return new Response(null, { status: 304, headers });
    return new Response(r.method === 'HEAD' ? null : '<html>page</html>', { headers });
  }
  if (p === '/data/sources.json') return new Response(r.method === 'HEAD' ? null : '{"seasons":{}}', { headers: { 'content-type': 'application/json', etag: '"c"' } });
  if (p === '/archive/clubs.json') return new Response(r.method === 'HEAD' ? null : '{"schema":1,"clubs":{}}', { headers: { 'content-type': 'application/json', etag: '"k"' } });
  return new Response('<!doctype html><html>fallback</html>', { status: 404, headers: { 'content-type': 'text/html' } });
} };
async function quietly(fn) {
  const original = console.error, logged = [];
  console.error = (...args) => logged.push(args);
  try { return { result: await fn(), logged }; } finally { console.error = original; }
}

test('token: valid, renew, expired, forged, wrong secret, missing, malformed', async () => {
  const t = await mint(SECRET, T0);
  assert.match(t, /^v1\.\d{10}\.\d{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await verify(SECRET, t, T0)).state, 'valid');
  assert.equal((await verify(SECRET, t, T0 + (RENEW_AFTER - 1) * 1000)).state, 'valid');
  assert.equal((await verify(SECRET, t, T0 + RENEW_AFTER * 1000)).state, 'renew');
  assert.equal((await verify(SECRET, t, T0 + (TTL - 1) * 1000)).state, 'renew');
  assert.equal((await verify(SECRET, t, T0 + TTL * 1000)).state, 'expired');
  assert.equal((await verify(OTHER, t, T0)).state, 'invalid', 'wrong secret');
  const [v, iat, exp, sid, sig] = t.split('.');
  // Forgeries: extended expiry, swapped id, flipped signature, future issue time.
  assert.equal((await verify(SECRET, [v, iat, String(Number(exp) + 86400), sid, sig].join('.'), T0)).state, 'invalid');
  assert.equal((await verify(SECRET, [v, iat, exp, 'A'.repeat(22), sig].join('.'), T0)).state, 'invalid');
  assert.equal((await verify(SECRET, [v, iat, exp, sid, (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)].join('.'), T0)).state, 'invalid');
  assert.equal((await verify(SECRET, await mint(SECRET, T0 + 3600 * 1000), T0)).state, 'invalid', 'issued in the future');
  assert.equal((await verify(SECRET, null, T0)).state, 'missing');
  assert.equal((await verify(SECRET, '', T0)).state, 'missing');
  for (const junk of ['x', 'v1', t + '.', 'v2' + t.slice(2), t.replace(/\./g, ','), '<script>']) assert.equal((await verify(SECRET, junk, T0)).state, 'invalid', junk);
  assert.notEqual((await mint(SECRET, T0)).split('.')[3], (await mint(SECRET, T0)).split('.')[3], 'two mints never share an id');
});

test('R3 only the canonical base64url encoding of a signature verifies', async () => {
  for (let i = 0; i < 8; i++) {
    const t = await mint(SECRET, T0);
    const head = t.slice(0, -1);
    let accepted = 0;
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') if ((await verify(SECRET, head + ch, T0)).state === 'valid') accepted++;
    assert.equal(accepted, 1, t);
  }
});

test('cookie parsing and attributes: 7-day cookie, 24-hour token', () => {
  assert.equal(readCookie(`a=1; ${COOKIE}=tok; b=2`), 'tok');
  assert.equal(readCookie('a=1'), null);
  assert.equal(readCookie(null), null);
  assert.equal(COOKIE_MAX_AGE, 604800);
  assert.equal(TTL, 86400);
  assert.equal(setCookie('tok'), `${COOKIE}=tok; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax`);
});

test('R7 ip keys: IPv4 whole, IPv4-mapped as IPv4, IPv6 by /64', () => {
  const cases = {
    '203.0.113.9': 'ip:203.0.113.9',
    '2001:db8:1:2:3:4:5:6': 'ip6:2001:db8:1:2::/64',
    '2001:db8:1:2::9': 'ip6:2001:db8:1:2::/64',
    '2001:0DB8:0001:0002:aaaa::1': 'ip6:2001:db8:1:2::/64',
    '2001:DB8:1:2::': 'ip6:2001:db8:1:2::/64',
    '2001:db8::1': 'ip6:2001:db8:0:0::/64',
    '2001:db8:0:0:1::1': 'ip6:2001:db8:0:0::/64',
    '::1': 'ip6:0:0:0:0::/64',
    '::ffff:198.51.100.7': 'ip:198.51.100.7',
    '::FFFF:198.51.100.7': 'ip:198.51.100.7',
    '0:0:0:0:0:ffff:c633:6407': 'ip:198.51.100.7',
  };
  for (const [ip, want] of Object.entries(cases)) assert.equal(ipKey(ip), want, ip);
  assert.equal(ipKey(null), 'ip:unknown');
});

test('gate: session tiers, renewal with a fresh id, anonymous states, counts without IP or id', async () => {
  const env = { SESSION_SECRET: SECRET, ...limiters(), API_EVENTS: sink() };
  const t = await mint(SECRET, T0);
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  let g = await gate(req('/api/v1/catalog', { ...ip, cookie: `${COOKIE}=${t}`, 'sec-fetch-site': 'same-origin' }), env, T0);
  assert.deepEqual(g, { session: 'ok', cookie: null });
  assert.equal(env.API_EVENTS.points.length, 0, 'a routine session request writes nothing');
  g = await gate(req('/api/v1/catalog', { ...ip, cookie: `${COOKIE}=${t}` }), env, T0 + 2 * 3600 * 1000);
  assert.equal(g.session, 'renewed');
  const renewed = /^__Host-ecnl_s=([^;]+);/.exec(g.cookie)[1];
  assert.notEqual(renewed.split('.')[3], t.split('.')[3], 'a renewal starts a fresh session id');
  assert.equal((await verify(SECRET, renewed, T0 + 2 * 3600 * 1000)).state, 'valid');
  assert.equal(env.API_EVENTS.points.length, 0, 'a renewal is routine');
  for (const [cookie, state] of [[null, 'missing'], ['garbage', 'invalid'], [await mint(OTHER, T0), 'invalid'], [t, 'expired']]) {
    const now = state === 'expired' ? T0 + TTL * 1000 : T0;
    const before = env.API_EVENTS.points.length;
    g = await gate(req('/api/v1/clubs', { ...ip, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) }), env, now);
    assert.deepEqual(g, { session: 'none', cookie: null }, state);
    assert.equal(env.API_EVENTS.points.length, before + 1, 'one data point per request');
    assert.deepEqual(env.API_EVENTS.points.at(-1).blobs, ['anon-' + state, 'clubs', 'absent', 'production']);
  }
  // Probes are counted by their shape; preview hosts are told apart from production.
  await gate(req('/api/v1/events/01/hierarchy', ip), env, T0);
  assert.deepEqual(env.API_EVENTS.points.at(-1).blobs, ['anon-missing', 'invalid', 'absent', 'production']);
  await gate(req('/api/v1/nope', { ...ip, 'sec-fetch-site': 'weird' }, 'GET', 'abc123-ecnl-dashboard.nextonetwolabs.workers.dev'), env, T0);
  assert.deepEqual(env.API_EVENTS.points.at(-1).blobs, ['anon-missing', 'unknown', 'other', 'preview']);
  const written = JSON.stringify(env.API_EVENTS.points);
  assert.ok(!written.includes('198.51.100') && !written.includes(t.split('.')[3]) && !written.includes(renewed.split('.')[3]), 'no IP or session id in analytics');
});

test('R6 cross-site with a cookie is anon-cross-site; R8 other Sec-Fetch-Site values keep the session', async () => {
  const env = { SESSION_SECRET: SECRET, ...limiters(), API_EVENTS: sink() };
  const t = await mint(SECRET, T0);
  const g = await gate(req('/api/v1/clubs', { cookie: `${COOKIE}=${t}`, 'sec-fetch-site': 'cross-site' }), env, T0);
  assert.equal(g.session, 'none', 'a cross-site request does not get the session tier');
  assert.deepEqual(env.API_EVENTS.points[0].blobs, ['anon-cross-site', 'clubs', 'cross-site', 'production']);
  await gate(req('/api/v1/clubs', { 'sec-fetch-site': 'cross-site' }), env, T0);
  assert.equal(env.API_EVENTS.points[1].blobs[0], 'anon-missing', 'cross-site without a cookie is just missing');
  for (const sfs of ['same-origin', 'same-site', 'none', undefined]) {
    const h = { cookie: `${COOKIE}=${t}` };
    if (sfs) h['sec-fetch-site'] = sfs;
    assert.equal((await gate(req('/api/v1/clubs', h), env, T0)).session, 'ok', String(sfs));
  }
});

test('gate: 429 JSON with Retry-After and X-ECNL-Session per tier; HEAD has no body', async () => {
  const env = { SESSION_SECRET: SECRET, ...limiters(120), API_EVENTS: sink() };
  const ip = { 'cf-connecting-ip': '198.51.100.8' };
  for (let i = 0; i < 120; i++) assert.ok(!(await gate(req('/api/v1/catalog', ip), env, T0)).response, `anon ${i}`);
  const r = (await gate(req('/api/v1/catalog', ip), env, T0)).response;
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-ecnl-session'), 'none');
  assert.deepEqual(await r.json(), { ok: false, error: 'Too many requests. Please wait a minute and try again.' });
  assert.equal(await (await gate(req('/api/v1/catalog', ip, 'HEAD'), env, T0)).response.text(), '');
  // A session on the same IP is not affected by the anonymous tier.
  const t = await mint(SECRET, T0);
  for (let i = 0; i < 300; i++) assert.ok(!(await gate(req('/api/v1/catalog', { ...ip, cookie: `${COOKIE}=${t}` }), env, T0)).response, `session ${i}`);
  const limited = (await gate(req('/api/v1/catalog', { ...ip, cookie: `${COOKIE}=${t}` }), env, T0)).response;
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-ecnl-session'), 'ok');
  // A second session on that IP still works until the IP backstop.
  const t2 = await mint(SECRET, T0);
  assert.ok(!(await gate(req('/api/v1/catalog', { ...ip, cookie: `${COOKIE}=${t2}` }), env, T0)).response);
  const outcomes = env.API_EVENTS.points.map(p => p.blobs[0]);
  assert.ok(outcomes.includes('limited-anon') && outcomes.includes('limited-session'));
});

test('R5 a cookieless flood writes exactly one data point per request, limited-* replacing anon-*', async () => {
  const env = { SESSION_SECRET: SECRET, ...limiters(60), API_EVENTS: sink() };
  const ip = { 'cf-connecting-ip': '198.51.100.20' };
  for (let i = 0; i < 100; i++) await gate(req('/api/v1/catalog', ip), env, T0);
  const by = {};
  for (const p of env.API_EVENTS.points) by[p.blobs[0]] = (by[p.blobs[0]] || 0) + 1;
  assert.equal(env.API_EVENTS.points.length, 100);
  assert.deepEqual(by, { 'anon-missing': 60, 'limited-anon': 40 });
});

test('R9 a request refused by RL_IP counts limited-ip; the parallel session check still used a count', async () => {
  const env = { SESSION_SECRET: SECRET, RL_SESSION: limiter(300), RL_ANON: limiter(120), RL_IP: limiter(0), API_EVENTS: sink() };
  const t = await mint(SECRET, T0);
  const g = await gate(req('/api/v1/clubs', { cookie: `${COOKIE}=${t}`, 'cf-connecting-ip': '203.0.113.1' }), env, T0);
  assert.equal(g.response.status, 429);
  assert.equal(g.response.headers.get('x-ecnl-session'), 'ok');
  assert.deepEqual(env.API_EVENTS.points.map(p => p.blobs[0]), ['limited-ip']);
  assert.deepEqual([...env.RL_SESSION.counts.values()], [1]);
});

test('missing or short secret fails open (IP backstop only, "off"); missing bindings skip limits', async () => {
  for (const secret of [undefined, '', 'short']) {
    const env = { SESSION_SECRET: secret, RL_IP: limiter(2), API_EVENTS: sink() };
    assert.deepEqual(await gate(req('/api/v1/catalog'), env, T0), { session: 'off' });
    assert.deepEqual(await gate(req('/api/v1/catalog'), env, T0), { session: 'off' });
    const r = (await gate(req('/api/v1/catalog'), env, T0)).response;
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-ecnl-session'), 'off');
    assert.deepEqual(env.API_EVENTS.points.map(p => p.blobs[0]), ['disabled', 'disabled', 'limited-ip']);
  }
  assert.deepEqual(await gate(req('/api/v1/catalog'), { SESSION_SECRET: SECRET }, T0), { session: 'none', cookie: null });
});

test('worker: "/" mints a cookie once, the API honours it, the curl jar flow works', async () => {
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, ...limiters(), API_EVENTS: sink() };
  for (const method of ['GET', 'HEAD']) {
    const home = await worker.fetch(req('/', {}, method), env);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('set-cookie'), /^__Host-ecnl_s=v1\.[^;]+; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.equal(home.headers.get('cache-control'), 'private, no-cache');
    const token = cookieOf(home);
    const again = await worker.fetch(req('/', { cookie: `${COOKIE}=${token}` }, method), env);
    assert.equal(again.headers.get('set-cookie'), null, 'a valid cookie is not re-issued');
    assert.equal(again.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const api = await worker.fetch(req('/api/v1/catalog', { cookie: `${COOKIE}=${token}` }), env);
    assert.equal(api.status, 200);
    assert.equal(api.headers.get('x-ecnl-session'), 'ok');
    assert.equal(api.headers.get('cache-control'), 'no-cache');
    assert.equal(api.headers.get('set-cookie'), null);
  }
  assert.deepEqual(env.API_EVENTS.points.map(p => p.blobs.slice(0, 2)), [['minted', 'page'], ['minted', 'page']]);
  const anon = await worker.fetch(req('/api/v1/catalog'), env);
  assert.equal(anon.status, 200, 'no cookie is served under the anonymous tier, not refused');
  assert.equal(anon.headers.get('x-ecnl-session'), 'none');
  // Without a secret the page gets no cookie and the API still answers.
  const off = { ASSETS: assets };
  assert.equal((await worker.fetch(req('/'), off)).headers.get('set-cookie'), null);
  const offApi = await worker.fetch(req('/api/v1/catalog'), off);
  assert.equal(offApi.status, 200);
  assert.equal(offApi.headers.get('x-ecnl-session'), 'off');
});

test('R4 a 304 on "/" still carries the cookie and private, no-cache; R11 cookie only on "/"', async () => {
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, API_EVENTS: sink() };
  const r = await worker.fetch(req('/', { 'if-none-match': '"p"' }), env);
  assert.equal(r.status, 304);
  assert.match(r.headers.get('set-cookie') || '', /^__Host-ecnl_s=v1\./);
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.equal(r.headers.get('etag'), '"p"');
  assert.equal((await worker.fetch(req('/index.html'), env)).headers.get('set-cookie'), null);
  assert.equal((await worker.fetch(req('/', {}, 'POST'), env)).headers.get('set-cookie'), null);
  assert.match((await worker.fetch(req('/?live=1'), env)).headers.get('set-cookie') || '', /^__Host-ecnl_s=/, '/?live=1 is still "/"');
  // An old token is renewed on "/" with a fresh id and without counting a mint.
  const old = await mint(SECRET, Date.now() - 2 * 3600 * 1000);
  const renewed = await worker.fetch(req('/', { cookie: `${COOKIE}=${old}` }), env);
  assert.ok(cookieOf(renewed) && cookieOf(renewed).split('.')[3] !== old.split('.')[3]);
  assert.deepEqual(env.API_EVENTS.points.map(p => p.blobs[0]), ['minted', 'minted']);
});

test('worker: an API renewal sets the cookie; R10 an API error keeps no-store', async () => {
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, ...limiters(), API_EVENTS: sink() };
  const old = await mint(SECRET, Date.now() - 2 * 3600 * 1000);
  const r = await worker.fetch(req('/api/v1/catalog', { cookie: `${COOKIE}=${old}` }), env);
  assert.equal(r.headers.get('x-ecnl-session'), 'renewed');
  assert.ok(cookieOf(r));
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  const missing = await worker.fetch(req('/api/v1/seasons/2030-31/teams', { cookie: `${COOKIE}=${old}` }), env);
  assert.equal(missing.status, 404);
  assert.ok(cookieOf(missing));
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(decorate(new Response('{}', { status: 404, headers: { 'cache-control': 'no-store' } }), { session: 'renewed', cookie: '__Host-ecnl_s=x' }).headers.get('cache-control'), 'no-store');
});

test('R2 a throwing writeDataPoint never changes a response', async () => {
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, ...limiters(0), API_EVENTS: { writeDataPoint() { throw new Error('quota'); } } };
  const ok = await worker.fetch(req('/api/v1/catalog', { cookie: `${COOKIE}=${await mint(SECRET)}` }), env);
  assert.equal(ok.status, 200);
  const none = await worker.fetch(req('/api/v1/catalog'), env);
  assert.equal(none.status, 429);
  assert.equal(none.headers.get('x-ecnl-session'), 'none');
  assert.ok(cookieOf(await worker.fetch(req('/'), env)));
});

test('R13 an anonymous-tier 429 says "none", so the page renews its cookie', async () => {
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, RL_SESSION: limiter(300), RL_ANON: limiter(0), RL_IP: limiter(3000), API_EVENTS: sink() };
  const r = await worker.fetch(req('/api/v1/catalog', { 'cf-connecting-ip': '203.0.113.50' }), env);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('x-ecnl-session'), 'none');
  assert.equal(r.headers.get('set-cookie'), null);
  // The renewal the page then sends: HEAD / mints a cookie, and the next request is served.
  const head = await worker.fetch(req('/', { 'cf-connecting-ip': '203.0.113.50' }, 'HEAD'), env);
  const next = await worker.fetch(req('/api/v1/catalog', { 'cf-connecting-ip': '203.0.113.50', cookie: `${COOKIE}=${cookieOf(head)}` }), env);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('x-ecnl-session'), 'ok');
});

test('R1 R12 a throwing limiter or key import still serves JSON; a failed import is not cached', async () => {
  const boom = { async limit() { throw new Error('limiter down'); } };
  const env = { ASSETS: assets, SESSION_SECRET: SECRET, RL_SESSION: boom, RL_ANON: boom, RL_IP: boom, API_EVENTS: sink() };
  const { result: r, logged } = await quietly(() => worker.fetch(req('/api/v1/catalog'), env));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('x-ecnl-session'), 'error');
  assert.deepEqual(env.API_EVENTS.points.map(p => p.blobs.slice(0, 2)), [['gate-error', 'catalog']]);
  assert.deepEqual(logged.map(args => args[0]), ['session']);

  const fresh = 'c'.repeat(32) + '-import-fault';
  const stale = `${COOKIE}=${await mint(OTHER)}`;  // a cookie, so verify imports the key
  const importKey = crypto.subtle.importKey;
  crypto.subtle.importKey = async () => { throw new Error('import fault'); };
  let faulted;
  try {
    faulted = await quietly(async () => ({
      api: await worker.fetch(req('/api/v1/clubs', { cookie: stale }), { ...env, SESSION_SECRET: fresh, ...limiters() }),
      page: await worker.fetch(req('/'), { ...env, SESSION_SECRET: fresh }),
    }));
  } finally { crypto.subtle.importKey = importKey; }
  assert.equal(faulted.result.api.status, 200);
  assert.equal(faulted.result.api.headers.get('x-ecnl-session'), 'error');
  assert.match(faulted.result.api.headers.get('content-type'), /application\/json/);
  assert.equal(faulted.result.page.status, 200, 'the page is served without a cookie');
  assert.equal(faulted.result.page.headers.get('set-cookie'), null);
  assert.deepEqual(faulted.logged.map(args => args[0]), ['session', 'session']);
  // The import works again: the failure was not kept for the isolate.
  const home = await worker.fetch(req('/'), { ...env, SESSION_SECRET: fresh });
  assert.ok(cookieOf(home));
  const api = await worker.fetch(req('/api/v1/clubs', { cookie: `${COOKIE}=${cookieOf(home)}` }), { ...env, SESSION_SECRET: fresh, ...limiters() });
  assert.equal(api.headers.get('x-ecnl-session'), 'ok');
});

// The page's own noteSession (public/index.html), run with a stub fetch and clock.
test('page: only X-ECNL-Session "none" sends a background HEAD /, at most once a minute', async () => {
  const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = html.indexOf('    let sessionRenewAt = 0;');
  const end = html.indexOf('\n    }\n', html.indexOf('function noteSession(', start)) + 6;
  assert.ok(start >= 0 && end > start, 'noteSession not found in index.html');
  const calls = [], clock = { t: 1e12 };
  const load = live => new Function('LIVE', 'fetch', 'Date', html.slice(start, end) + '\nreturn noteSession;')(
    live, (url, options) => { calls.push([url, options.method, options.cache]); return Promise.resolve(); }, { now: () => clock.t });
  const answer = session => ({ headers: new Headers(session ? { 'x-ecnl-session': session } : {}) });
  const noteSession = load(false);
  // A session-tier 429 says "ok"; with sessions off or after a gate fault nothing can be renewed.
  for (const session of ['ok', 'renewed', 'off', 'error', null]) noteSession(answer(session));
  assert.equal(calls.length, 0);
  noteSession(answer('none'));
  noteSession(answer('none'));
  assert.deepEqual(calls, [['/', 'HEAD', 'no-store']]);
  clock.t += 59999;
  noteSession(answer('none'));
  assert.equal(calls.length, 1, 'at most once a minute');
  clock.t += 1;
  noteSession(answer('none'));
  assert.equal(calls.length, 2);
  load(true)(answer('none'));
  assert.equal(calls.length, 2, '?live=1 never renews');
});
