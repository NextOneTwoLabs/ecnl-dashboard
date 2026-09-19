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

test('HTML fallback, upstream error and thrown storage fault stay JSON', async () => {
  for (const [stored, expected] of [[() => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }), 404], [() => new Response('broken', { status: 500 }), 503], [() => { throw new Error('fixture fault'); }, 503]]) {
    const response = await dataApi(request('/api/v1/catalog'), { ASSETS: { fetch: stored } });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).ok, false);
  }
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
