// Zero-dependency test harness for worker.js.
//
//   node worker.test.mjs
//
// No package.json, no node_modules, nothing to install: Node 18+ already has
// Request, Response, Headers and crypto. This file is committed because
// /api/feedback is the site's only public write endpoint and every push to
// main deploys unattended, including the two-hourly data commits — a broken
// worker.js would ship with nobody watching.
//
// It runs worker.js against a Map-backed fake KV and a fake ASSETS binding and
// asserts every row of the status table, that KV is never written on a
// rejection, that the cap fails closed, that a fault always produces a
// Response, that the KV read and write cost per path is what the README's
// free-tier arithmetic claims, and that no Access-Control-* header is ever
// emitted.
//
// The fake ASSETS binding mirrors production in one respect that matters:
// it THROWS when handed a Request whose body has already been read, exactly
// as env.ASSETS.fetch() does. Without that, a fall-through test on the
// feedback path passes vacuously for the one case it exists to prove.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'worker.js');

// worker.js is an ES module in a repo with no package.json. Node 22.7+ detects
// that on its own; on older Node the same source is loaded through a data URL
// so the harness still runs on 18 and 20.
let worker;
let loadedVia;
try {
  worker = (await import(pathToFileURL(WORKER_PATH).href)).default;
  loadedVia = 'file import';
} catch (err) {
  const source = readFileSync(WORKER_PATH, 'utf8');
  worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source))).default;
  loadedVia = 'data-URL import (older Node)';
}

const ORIGIN = 'https://ecnl.nextonetwo.com';
const ENDPOINT = ORIGIN + '/api/feedback';
const SALT = 'PBmA0/2xkYT1r0m1hQ0xkP1xwZ8k3n4hOe1QW9r5cE0=';
const HONEYPOT_FIELD = 'subjectline'; // must match worker.js and the PR 2 client
const TODAY = new Date().toISOString().slice(0, 10);

// --- tiny assertion framework --------------------------------------------

let checks = 0;
const failures = [];

function ok(condition, label) {
  checks++;
  if (!condition) failures.push(label);
}

function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  process.stdout.write(`\n  ${name}\n`);
}

// --- fakes ----------------------------------------------------------------

function makeKV(options = {}) {
  const store = new Map();
  return {
    store,
    writes: 0,
    reads: 0,
    async get(key) {
      this.reads++;
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async getWithMetadata(key) {
      this.reads++;
      const entry = store.get(key);
      return entry ? { value: entry.value, metadata: entry.metadata } : { value: null, metadata: null };
    },
    async put(key, value, opts = {}) {
      if (options.failPut) throw new Error('injected KV fault');
      this.writes++;
      store.set(key, {
        value: String(value),
        metadata: opts.metadata === undefined ? null : opts.metadata,
        expirationTtl: opts.expirationTtl === undefined ? null : opts.expirationTtl,
      });
    },
    async delete(key) {
      store.delete(key);
    },
    // Real KV lists ascending by key name and hands metadata back with it.
    async list({ prefix = '', limit = 1000 } = {}) {
      const names = [...store.keys()].filter((name) => name.startsWith(prefix)).sort();
      return {
        list_complete: names.length <= limit,
        keys: names.slice(0, limit).map((name) => ({ name, metadata: store.get(name).metadata })),
      };
    },
    seed(key, value) {
      store.set(key, { value: String(value), metadata: null, expirationTtl: null });
    },
    records() {
      return [...store.keys()].filter((name) => name.startsWith('fb:')).sort();
    },
  };
}

function makeAssets() {
  return {
    calls: 0,
    async fetch(request) {
      this.calls++;
      // Production behaviour: the assets binding constructs a new Request from
      // this one, and a Request whose body has been read cannot be reused —
      // "Cannot construct a Request with a Request object that has already
      // been used". Anything that reads the body and then falls through to the
      // assets is a 500 in production, so it must fail here too.
      if (request && request.bodyUsed === true) {
        throw new TypeError('Cannot construct a Request with a Request object that has already been used.');
      }
      return new Response('static asset for ' + new URL(request.url).pathname, {
        status: 200,
        headers: { 'X-Served-By': 'assets' },
      });
    },
  };
}

function makeEnv(overrides = {}) {
  const env = { ASSETS: makeAssets(), FEEDBACK: makeKV(), FEEDBACK_SALT: SALT };
  return Object.assign(env, overrides);
}

const CTX = { waitUntil() {}, passThroughOnException() {} };

// Every response the worker produces during this run, so the CORS and
// no-store rules can be checked over all of them at the end.
const seen = [];

async function call(request, env) {
  const response = await worker.fetch(request, env, CTX);
  seen.push(response);
  return response;
}

function body(payload = {}) {
  return Object.assign({ type: 'bug', message: 'The standings table wraps oddly on my phone.', dwell: 4000 }, payload);
}

// Cloudflare puts Content-Length on an incoming non-chunked request; Node does
// not put one on a Request built here, so the helper declares it, the way a
// real browser post does. opts.contentLength === null omits it (the chunked /
// absent case, now a 411); a string sets it verbatim, so a lying length can be
// tested.
function post(payload, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (opts.origin !== null) headers.set('Origin', opts.origin || ORIGIN);
  if (opts.contentType !== null) headers.set('Content-Type', opts.contentType || 'application/json');
  headers.set('User-Agent', opts.ua || 'Mozilla/5.0 (test harness)');
  if (opts.address !== null) headers.set('CF-Connecting-IP', opts.address || '203.0.113.9');
  const init = { method: opts.method || 'POST', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = opts.raw !== undefined ? opts.raw : JSON.stringify(payload);
    if (opts.contentLength === undefined) {
      headers.set('Content-Length', String(new TextEncoder().encode(init.body).byteLength));
    } else if (opts.contentLength !== null) {
      headers.set('Content-Length', String(opts.contentLength));
    }
  }
  return new Request(opts.url || ENDPOINT, init);
}

// Header shim for the hand-built requests below: Node will not let a Request
// carry a Content-Length header of our choosing, and the worker only ever
// calls headers.get().
function fakeHeaders(values) {
  const lower = new Map(Object.keys(values).map((name) => [name.toLowerCase(), values[name]]));
  return { get: (name) => (lower.has(name.toLowerCase()) ? lower.get(name.toLowerCase()) : null) };
}

async function readJson(response) {
  const text = await response.clone().text();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { __unparseable: text };
  }
}

// Reimplemented independently of worker.js, so a matching key proves the
// worker derived the same hash — and a record containing it would be caught.
async function expectedAddressHash(address) {
  const enc = new TextEncoder();
  const sign = async (keyBytes, message) => {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  };
  const dayKey = await sign(enc.encode(SALT), TODAY);
  const digest = await sign(dayKey, address);
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// --- 1. the untouched redirect and the untouched asset path ---------------

section('Existing behaviour is unchanged');
{
  const env = makeEnv();
  const redirect = await call(new Request('https://ecnl-dashboard.nextonetwolabs.workers.dev/?x=1'), env);
  eq(redirect.status, 301, 'workers.dev still redirects with 301');
  eq(redirect.headers.get('Location'), 'https://ecnl.nextonetwo.com/?x=1', 'redirect keeps path and query on the canonical host');
  eq(env.ASSETS.calls, 0, 'the redirect does not touch the assets');

  const page = await call(new Request(ORIGIN + '/'), env);
  eq(page.headers.get('X-Served-By'), 'assets', 'the homepage is still served from the assets binding');

  const asset = await call(new Request(ORIGIN + '/data/sources.json'), env);
  eq(asset.headers.get('X-Served-By'), 'assets', 'other paths are still served from the assets binding');
  eq(env.FEEDBACK.writes, 0, 'serving pages writes nothing to KV');
}

// --- 2. the happy path ----------------------------------------------------

section('200 — a stored submission');
let happyRecord = null;
{
  const env = makeEnv();
  const response = await call(post(body({
    email: 'someone@example.com',
    context: { hash: '#tab=teams&team=55477', season: '2025-26', age: 'GU15', conference: 'Midwest', view: 'standings', tab: 'teams' },
    viewport: { w: 390, h: 844 },
  })), env);
  const json = await readJson(response);

  eq(response.status, 200, '200 on a good submission');
  eq(json.ok, true, 'body is {ok:true, id}');
  ok(typeof json.id === 'string' && json.id.length === 36, 'the reply carries a uuid id');
  eq(response.headers.get('Cache-Control'), 'no-store', 'the 200 is no-store');
  ok((response.headers.get('Content-Type') || '').startsWith('application/json'), 'the 200 is JSON');
  ok(!('message' in json) && !('email' in json), 'the reply never echoes the submission');

  const keys = env.FEEDBACK.records();
  eq(keys.length, 1, 'exactly one record was written');
  ok(/^fb:\d{13}:[0-9a-f-]{36}$/.test(keys[0]), 'key shape is fb:<13 digits>:<uuid>, got ' + keys[0]);
  eq(env.FEEDBACK.writes, 3, 'an accepted submission costs 3 KV writes (record + 2 sharded counters)');

  const entry = env.FEEDBACK.store.get(keys[0]);
  happyRecord = JSON.parse(entry.value);
  eq(entry.expirationTtl, 180 * 24 * 60 * 60, 'the record expires after 180 days');
  eq(happyRecord.v, 1, 'record is versioned');
  eq(happyRecord.id, json.id, 'the stored id matches the one returned');
  eq(happyRecord.type, 'bug', 'the type is stored');
  eq(happyRecord.email, 'someone@example.com', 'the optional email is stored');
  eq(happyRecord.context.conference, 'Midwest', 'the page context is stored');
  eq(happyRecord.viewport.w, 390, 'the viewport is stored');
  ok(typeof happyRecord.ts === 'string' && happyRecord.ts.endsWith('Z'), 'the timestamp is ISO-8601 UTC');

  eq(entry.metadata.type, 'bug', 'metadata carries the type');
  eq(entry.metadata.len, happyRecord.message.length, 'metadata carries the message length');
  eq(entry.metadata.hasEmail, true, 'metadata carries hasEmail');
  eq(entry.metadata.t, happyRecord.ts, 'metadata carries the timestamp');
  ok('country' in entry.metadata, 'metadata carries country');

  const counters = [...env.FEEDBACK.store.keys()].filter((k) => !k.startsWith('fb:'));
  eq(counters.length, 2, 'one address-counter shard and one global-counter shard were written');
  ok(counters.every((k) => env.FEEDBACK.store.get(k).expirationTtl === 24 * 60 * 60), 'rate-limit keys expire after 24 hours');
  ok(counters.some((k) => k.startsWith('rl:')) && counters.some((k) => k.startsWith('gc:')), 'the two counters are the per-address and global ones');
  ok(/:\d$/.test(counters[0]) && /:\d$/.test(counters[1]), 'counters are sharded (a numeric shard suffix), so neither is a hot key');
}

section('The user agent is truncated and the message trimmed');
{
  const env = makeEnv();
  await call(post(body({ message: '   spaces around   ' }), { ua: 'U'.repeat(900) }), env);
  const record = JSON.parse(env.FEEDBACK.store.get(env.FEEDBACK.records()[0]).value);
  eq(record.ua.length, 256, 'the user agent is truncated to 256 characters');
  eq(record.message, 'spaces around', 'the message is stored trimmed');
}

// --- 3. request.cf --------------------------------------------------------

section('request.cf');
{
  const env = makeEnv();
  const request = post(body());
  eq(request.cf, undefined, 'a plain Request has no cf, as in wrangler dev and here');
  const response = await call(request, env);
  eq(response.status, 200, 'an undefined request.cf does not throw — still 200');
  const record = JSON.parse(env.FEEDBACK.store.get(env.FEEDBACK.records()[0]).value);
  eq(record.country, null, 'country is null when Cloudflare does not provide it');

  // The same request with cf present, as it arrives on Cloudflare.
  const env2 = makeEnv();
  const withCf = post(body());
  Object.defineProperty(withCf, 'cf', { value: { country: 'US' }, configurable: true });
  await call(withCf, env2);
  const record2 = JSON.parse(env2.FEEDBACK.store.get(env2.FEEDBACK.records()[0]).value);
  eq(record2.country, 'US', 'country is stored when Cloudflare provides it');
  eq(env2.FEEDBACK.store.get(env2.FEEDBACK.records()[0]).metadata.country, 'US', 'country reaches the metadata too');
}

// --- 4. the address never reaches a record --------------------------------

section('The address is never stored, in the clear or hashed');
{
  const env = makeEnv();
  const address = '198.51.100.77';
  await call(post(body()), env);                       // 203.0.113.9, a different address
  await call(post(body(), { address }), env);
  const hash = await expectedAddressHash(address);

  const rlKeys = [...env.FEEDBACK.store.keys()].filter((k) => k.startsWith('rl:'));
  ok(rlKeys.some((k) => k.includes(hash)), 'the limiter keys on a per-day HMAC of the address');
  ok(rlKeys.every((k) => !k.includes(address)), 'no rate-limit key contains the raw address');

  for (const name of env.FEEDBACK.records()) {
    const raw = env.FEEDBACK.store.get(name).value;
    ok(!raw.includes(address), 'the record does not contain the raw address');
    ok(!raw.includes(hash), 'the record does not contain the address hash either');
    ok(!name.includes(hash), 'the record key does not contain the address hash');
    const record = JSON.parse(raw);
    ok(!('ip' in record) && !('address' in record) && !('addr' in record), 'the record has no address field at all');
  }
}

// --- 5. newest-first ordering --------------------------------------------

section('Two records a second apart list newest first');
{
  const env = makeEnv();
  const realNow = Date.now;
  try {
    Date.now = () => 1789041600000;
    const first = await readJson(await call(post(body({ message: 'older' })), env));
    Date.now = () => 1789041601000;
    const second = await readJson(await call(post(body({ message: 'newer' })), env));

    const listing = await env.FEEDBACK.list({ prefix: 'fb:' });
    eq(listing.keys.length, 2, 'both records are listed');
    eq(listing.keys[0].name, 'fb:8210958398999:' + second.id, 'the newer record sorts first (9999999999999 - 1789041601000)');
    eq(listing.keys[1].name, 'fb:8210958399999:' + first.id, 'the older record sorts second (9999999999999 - 1789041600000)');
    ok(listing.keys[0].name < listing.keys[1].name, 'ascending KV order really does put the newest first');
    eq(listing.keys[0].metadata.len, 5, 'one list call already carries enough metadata to triage');
  } finally {
    Date.now = realNow;
  }
}

section('The zero padding on the inverted timestamp is load-bearing');
{
  // The inverted value only drops below 13 digits around the year 2255, but
  // when it does, an unpadded key would sort wrongly and triage would silently
  // read the oldest records first. Two submissions either side of that
  // boundary prove the padding is doing the work.
  const env = makeEnv();
  const realNow = Date.now;
  try {
    Date.now = () => 8000000000000;               // inverted 1999999999999 — 13 digits
    const older = await readJson(await call(post(body({ message: 'older' })), env));
    Date.now = () => 9000000000000;               // inverted  999999999999 — 12 digits
    const newer = await readJson(await call(post(body({ message: 'newer' })), env));

    const listing = await env.FEEDBACK.list({ prefix: 'fb:' });
    eq(listing.keys[0].name, 'fb:0999999999999:' + newer.id, 'the 12-digit inverted value is zero-padded to 13');
    eq(listing.keys[1].name, 'fb:1999999999999:' + older.id, 'and still sorts after the newer one');
  } finally {
    Date.now = realNow;
  }
}

// --- 6. every rejection path, and never a KV write ------------------------

section('Rejections — the status table, with a running KV write count');
{
  const env = makeEnv();
  const kv = env.FEEDBACK;

  async function rejects(label, request, status, extra) {
    const before = kv.writes;
    const response = await call(request, env);
    eq(response.status, status, label);
    eq(kv.writes - before, 0, `${label} — wrote nothing to KV`);
    eq(response.headers.get('Cache-Control'), 'no-store', `${label} — no-store`);
    if (extra) await extra(response);
    return response;
  }

  // 405 — every method other than POST, including GET, HEAD and OPTIONS.
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    await rejects(`405 on ${method}`, post(body(), { method }), 405, async (r) => {
      eq(r.headers.get('Allow'), 'POST', `405 on ${method} carries Allow: POST`);
      // A response to HEAD carries no body, by definition.
      const text = await r.clone().text();
      if (method === 'HEAD') {
        eq(text, '', '405 on HEAD carries no body');
      } else {
        ok(text.length > 0, `405 on ${method} still explains itself in JSON`);
      }
    });
  }

  // 403 — Origin missing or foreign.
  await rejects('403 when Origin is missing', post(body(), { origin: null }), 403);
  await rejects('403 on a foreign Origin', post(body(), { origin: 'https://evil.example' }), 403);
  await rejects('403 on a lookalike Origin', post(body(), { origin: 'https://ecnl.nextonetwo.com.evil.example' }), 403);
  await rejects('403 on the http scheme', post(body(), { origin: 'http://ecnl.nextonetwo.com' }), 403);

  // 415 — wrong content type.
  await rejects('415 on text/plain', post(body(), { contentType: 'text/plain' }), 415);
  await rejects('415 on a form post', post(body(), { contentType: 'application/x-www-form-urlencoded' }), 415);
  await rejects('415 when Content-Type is missing', post(body(), { contentType: null }), 415);

  // 411 — a body with no declared length is refused before it is read at all.
  // Number(null) is 0, so an absent or chunked Content-Length used to pass the
  // size gate and the whole body was then buffered unbounded.
  await rejects('411 when Content-Length is absent (chunked or stripped)', post(body(), { contentLength: null }), 411, async (r) => {
    eq((await readJson(r)).error, 'length_required', 'the 411 names length_required');
  });
  await rejects('411 when Content-Length is not a number', post(body(), { contentLength: 'lots' }), 411);
  await rejects('411 when Content-Length is empty', post(body(), { contentLength: '' }), 411);
  await rejects('411 when Content-Length is negative', post(body(), { contentLength: '-1' }), 411);
  await rejects('411 when Content-Length is exponential notation', post(body(), { contentLength: '1e2' }), 411);
  await rejects('411 when Content-Length is fractional', post(body(), { contentLength: '10.5' }), 411);

  // 413 — an oversized body, refused on its declared length.
  await rejects('413 on a body over 8192 bytes', post(body({ message: 'x'.repeat(9000) })), 413);

  // 413 — a declared Content-Length over the cap short-circuits before the
  // body is read at all. Node does not put Content-Length on a Request's
  // header list (Cloudflare does), so this case is hand-built.
  let bodyWasRead = false;
  const reader = async () => {
    bodyWasRead = true;
    return new TextEncoder().encode(JSON.stringify(body({ message: 'y'.repeat(9000) }))).buffer;
  };
  await rejects('413 when the declared Content-Length exceeds 8192', {
    method: 'POST',
    url: ENDPOINT,
    cf: undefined,
    headers: fakeHeaders({ Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '99999' }),
    arrayBuffer: reader,
  }, 413);
  eq(bodyWasRead, false, 'an oversized Content-Length is rejected without reading the body');

  // 413 — a body that exceeds the cap despite a small declared length.
  await rejects('413 when the body exceeds the cap on read, whatever it declared', {
    method: 'POST',
    url: ENDPOINT,
    cf: undefined,
    headers: fakeHeaders({ Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '42' }),
    arrayBuffer: reader,
  }, 413);
  eq(bodyWasRead, true, 'the body was read before that one was rejected');

  // 413 — a LYING Content-Length with a huge streamed body. This is the case
  // that used to buffer the lot: the header claims 42 bytes, the stream would
  // happily deliver 12 MB. The reader must stop after the first chunk that
  // crosses 8192 bytes and cancel the stream, never calling arrayBuffer().
  let chunksPulled = 0;
  let streamCancelled = false;
  const bigChunk = new TextEncoder().encode('z'.repeat(64 * 1024));  // 64 KB a chunk
  const lyingStream = new ReadableStream({
    pull(controller) {
      chunksPulled++;
      if (chunksPulled > 200) { controller.close(); return; }   // 12.8 MB if fully drained
      controller.enqueue(bigChunk);
    },
    cancel() { streamCancelled = true; },
  });
  await rejects('413 on a huge streamed body behind a small Content-Length', {
    method: 'POST',
    url: ENDPOINT,
    cf: undefined,
    headers: fakeHeaders({ Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '42' }),
    body: lyingStream,
    async arrayBuffer() { throw new Error('arrayBuffer() was called on a streamed body — the read is unbounded again'); },
  }, 413);
  ok(chunksPulled <= 2, `the stream was abandoned after the chunk that crossed the cap (pulled ${chunksPulled} x 64 KB, not 200)`);
  ok(streamCancelled, 'the oversized stream was cancelled rather than left to drain');

  // 400 — malformed JSON and wrong shapes.
  await rejects('400 on malformed JSON', post(null, { raw: '{"type":"bug",' }), 400);
  await rejects('400 on an empty body', post(null, { raw: '' }), 400);
  await rejects('400 on a JSON array', post(null, { raw: '[1,2,3]' }), 400);
  await rejects('400 on JSON null', post(null, { raw: 'null' }), 400);

  // 400 — dwell.
  await rejects('400 on a non-numeric dwell', post(body({ dwell: 'soon' })), 400);
  await rejects('400 on a missing dwell', post({ type: 'bug', message: 'hello' }), 400);
  await rejects('400 on NaN dwell', post(null, { raw: '{"type":"bug","message":"hi","dwell":null}' }), 400);
  const fast = await rejects('400 (not a silent 200) when dwell is under the 1000 ms backstop', post(body({ dwell: 200 })), 400);
  const fastJson = await readJson(fast);
  eq(fastJson.ok, false, 'the dwell rejection is visible to the client, not a silent success');

  // 400 — type.
  await rejects('400 on a missing type', post({ message: 'hello', dwell: 4000 }), 400);
  await rejects('400 on an unknown type', post(body({ type: 'praise' })), 400);
  await rejects('400 on a non-string type', post(body({ type: 3 })), 400);

  // 400 — message.
  await rejects('400 on an empty message', post(body({ message: '' })), 400);
  await rejects('400 on a whitespace-only message', post(body({ message: '   \n\t ' })), 400);
  await rejects('400 on a non-string message', post(body({ message: { text: 'hi' } })), 400);
  await rejects('400 on a message over 2000 UTF-16 units', post(body({ message: 'a'.repeat(2001) })), 400);

  // 400 — email.
  await rejects('400 on an email with no @', post(body({ email: 'not-an-email' })), 400);
  await rejects('400 on an email with a space', post(body({ email: 'a b@example.com' })), 400);
  await rejects('400 on a non-string email', post(body({ email: 42 })), 400);
  // Over the 254-unit cap but otherwise a perfectly well-formed address, so
  // only the length check can reject it.
  await rejects('400 on an email over 254 units', post(body({ email: 'a'.repeat(250) + '@example.com' })), 400, async (r) => {
    eq((await readJson(r)).error, 'bad_email', 'the over-length email is a bad_email rejection');
  });
  const atEmailCap = 'b'.repeat(254 - '@example.com'.length) + '@example.com';
  eq(atEmailCap.length, 254, 'the boundary address really is exactly 254 units');

  eq(kv.writes, 0, 'ZERO KV writes across every rejection path above');
  eq(kv.store.size, 0, 'and nothing at all is in the store');
}

// --- 7. the boundaries that must be accepted ------------------------------

section('Boundaries that must pass');
{
  const env = makeEnv();
  const charset = await call(post(body(), { contentType: 'application/json; charset=utf-8' }), env);
  eq(charset.status, 200, '415 tolerates a charset parameter on the content type');

  const cased = await call(post(body(), { contentType: 'Application/JSON' }), env);
  eq(cased.status, 200, 'the content-type check is case-insensitive');

  const exact = await call(post(body({ message: 'z'.repeat(2000) })), env);
  eq(exact.status, 200, 'a message of exactly 2000 units is accepted');

  const atGate = await call(post(body({ dwell: 1000 })), env);
  eq(atGate.status, 200, 'a dwell of exactly 1000 ms is accepted');

  const atCap = 'b'.repeat(254 - '@example.com'.length) + '@example.com';
  const emailAtCap = await call(post(body({ email: atCap })), env);
  eq(emailAtCap.status, 200, 'an email of exactly 254 units is accepted');

  const emoji = await call(post(body({ message: '👍'.repeat(1000) })), env);
  eq(emoji.status, 200, '1000 surrogate pairs = 2000 UTF-16 units is accepted, matching maxlength');
  const emojiTooLong = await call(post(body({ message: '👍'.repeat(1001) })), env);
  eq(emojiTooLong.status, 400, '1001 surrogate pairs is over the cap, the same count the client makes');

  const noContext = await call(post({ type: 'idea', message: 'no context at all', dwell: 3000 }), env);
  eq(noContext.status, 200, 'context and viewport are optional');
}

section('A submission with no email stores null, and says so in the metadata');
{
  // A fresh env per case, so the record under test is the only one in it and
  // the assertions cannot be satisfied by some earlier submission's record.
  for (const [label, payload] of [
    ['omitted entirely', { type: 'idea', message: 'no email on this one', dwell: 3000 }],
    ['an empty string', body({ email: '' })],
    ['whitespace only', body({ email: '   ' })],
    ['explicit null', body({ email: null })],
  ]) {
    const env = makeEnv();
    const response = await call(post(payload), env);
    eq(response.status, 200, `200 when the email is ${label}`);
    const keys = env.FEEDBACK.records();
    eq(keys.length, 1, `exactly one record when the email is ${label}`);
    const entry = env.FEEDBACK.store.get(keys[0]);
    const record = JSON.parse(entry.value);
    eq(record.email, null, `the stored email is null when it is ${label}`);
    eq(entry.metadata.hasEmail, false, `metadata.hasEmail is false when the email is ${label}`);
  }

  // And the positive case, so the flag is proved to move rather than being
  // constant in either direction.
  const withEmail = makeEnv();
  await call(post(body({ email: 'someone@example.com' })), withEmail);
  const entry = withEmail.FEEDBACK.store.get(withEmail.FEEDBACK.records()[0]);
  eq(JSON.parse(entry.value).email, 'someone@example.com', 'and a supplied email is stored as given');
  eq(entry.metadata.hasEmail, true, 'and metadata.hasEmail is true when there is one');
}

section('An oversized context value is clipped, not stored whole');
{
  const env = makeEnv();
  await call(post(body({
    context: {
      hash: '#' + 'h'.repeat(5000),
      season: 's'.repeat(400),
      age: 'GU15',
      conference: null,
      view: 12345,                        // not a string: dropped, not coerced
      tab: 't'.repeat(200),               // exactly at the cap
      extra: 'not a whitelisted field',   // must not survive
    },
  })), env);
  const record = JSON.parse(env.FEEDBACK.store.get(env.FEEDBACK.records()[0]).value);
  eq(record.context.hash.length, 200, 'an oversized context hash is clipped to 200 units');
  eq(record.context.season.length, 200, 'an oversized context season is clipped to 200 units');
  eq(record.context.tab.length, 200, 'a context value of exactly 200 units survives intact');
  eq(record.context.age, 'GU15', 'a normal context value is untouched');
  eq(record.context.view, null, 'a non-string context value becomes null, not a coerced string');
  eq(record.context.conference, null, 'an explicit null stays null');
  eq('extra' in record.context, false, 'a field outside the whitelist never reaches the record');
  eq(Object.keys(record.context).length, 6, 'the context is exactly the six whitelisted fields');
}

// --- 8. the honeypot is the ONLY silent discard ---------------------------

section('Honeypot — 200 with nothing stored');
{
  const env = makeEnv();
  const response = await call(post(body({ [HONEYPOT_FIELD]: 'https://spam.example' })), env);
  const json = await readJson(response);
  eq(response.status, 200, 'a filled honeypot looks like success to the bot');
  eq(json.ok, true, 'the honeypot reply is {ok:true}');
  eq(json.id, undefined, 'no id is returned, because nothing was stored');
  eq(env.FEEDBACK.writes, 0, 'the honeypot writes NOTHING to KV');
  eq(env.FEEDBACK.store.size, 0, 'the store is empty after a honeypot hit');

  const empty = await call(post(body({ [HONEYPOT_FIELD]: '' })), env);
  eq(empty.status, 200, 'an empty honeypot field is normal and stores as usual');
  eq(env.FEEDBACK.records().length, 1, 'the normal submission was stored');
}

// --- 9. per-address rate limiting ----------------------------------------

section('429 — the per-address daily limit, read-only');
{
  const env = makeEnv();
  let accepted = 0;
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const response = await call(post(body({ message: 'submission number ' + i })), env);
    if (response.status === 200) accepted++;
    else if (limited === null) limited = response;
  }
  eq(accepted, 10, 'ten submissions from one address are accepted in a UTC day');
  ok(limited !== null, 'the eleventh is rejected');
  eq(limited.status, 429, 'the limit is a 429');
  // The bucket is keyed on the UTC date, so Retry-After must be the seconds
  // left until UTC midnight, not a flat 86400 that over-promises all day.
  const retryAfter = Number(limited.headers.get('Retry-After'));
  const untilMidnight = Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000);
  ok(Number.isInteger(retryAfter) && retryAfter > 0, 'the 429 says when to come back, as a positive integer of seconds');
  ok(retryAfter <= 86400, `Retry-After never exceeds a day (got ${retryAfter})`);
  ok(Math.abs(retryAfter - untilMidnight) <= 2, `Retry-After is the seconds left until UTC midnight (got ${retryAfter}, expected about ${untilMidnight})`);

  const before = env.FEEDBACK.writes;
  const beforeReads = env.FEEDBACK.reads;
  await call(post(body({ message: 'and another' })), env);
  eq(env.FEEDBACK.writes - before, 0, 'a rate-limited request performs ZERO KV writes');
  eq(env.FEEDBACK.reads - beforeReads, 4, 'a rate-limited request costs 4 KV reads (the address counter shards) and stops there');

  // A different address is unaffected: the limit is per address, not global.
  const other = await call(post(body(), { address: '192.0.2.55' }), env);
  eq(other.status, 200, 'a different address is not affected by another address limit');
}

// --- 10. the global cap fails closed -------------------------------------

section('503 — the global daily cap fails closed');
{
  const env = makeEnv();
  env.FEEDBACK.seed('gc:' + TODAY + ':0', 120);
  env.FEEDBACK.seed('gc:' + TODAY + ':5', 80); // 200 across two shards, summed on read
  const before = env.FEEDBACK.writes;
  const response = await call(post(body()), env);
  const json = await readJson(response);
  eq(response.status, 503, 'at the global cap the endpoint fails CLOSED with 503');
  eq(json.retry, true, 'the 503 body carries {retry:true} so the client can keep the typed text');
  eq(env.FEEDBACK.writes - before, 0, 'a capped request writes nothing');
  eq(env.FEEDBACK.records().length, 0, 'and stores no record');

  // One below the cap still works, proving the shards are summed, not read singly.
  const env2 = makeEnv();
  env2.FEEDBACK.seed('gc:' + TODAY + ':0', 120);
  env2.FEEDBACK.seed('gc:' + TODAY + ':5', 79);
  eq((await call(post(body()), env2)).status, 200, 'one below the cap is still accepted (shards are summed)');
}

section('The rate-limit bucket is never attacker-chosen');
{
  // CF-Connecting-IP is the only address source. X-Forwarded-For is
  // client-supplied, so honouring it would hand a flooder a fresh daily
  // allowance per spoofed value; without CF-Connecting-IP every request must
  // land in one shared 'unknown' bucket instead.
  const env = makeEnv();
  let accepted = 0;
  for (let i = 0; i < 12; i++) {
    const response = await call(post(body({ message: 'spoof attempt ' + i }), {
      address: null,
      headers: { 'X-Forwarded-For': '198.51.100.' + i },
    }), env);
    if (response.status === 200) accepted++;
  }
  eq(accepted, 10, 'twelve different X-Forwarded-For values still share ONE bucket — only 10 get through');

  const unknownHash = await expectedAddressHash('unknown');
  const rlKeys = [...env.FEEDBACK.store.keys()].filter((k) => k.startsWith('rl:'));
  ok(rlKeys.length > 0 && rlKeys.every((k) => k.includes(unknownHash)), 'the bucket is the constant "unknown", not any header the client sent');
  for (let i = 0; i < 12; i++) {
    const spoofed = await expectedAddressHash('198.51.100.' + i);
    ok(rlKeys.every((k) => !k.includes(spoofed)), 'no bucket is derived from an X-Forwarded-For value');
  }
}

// --- 10b. the KV cost per path, which the free-tier arithmetic rests on ---

section('KV reads and writes per path — the free-tier arithmetic');
{
  // The README's budget: 14 reads + 3 writes per accepted submission, 4 reads
  // + 0 writes per rate-limited one, and the WAF rule is the only thing
  // bounding the read spend on the rejected path. Pin all three numbers, so a
  // change to the shard counts has to come here and update the README with it.
  const env = makeEnv();
  const kv = env.FEEDBACK;

  const r0 = kv.reads, w0 = kv.writes;
  eq((await call(post(body()), env)).status, 200, 'the costed submission is accepted');
  eq(kv.reads - r0, 14, 'an accepted submission costs 14 KV reads (4 address shards + 8 global shards + 1 per counter bump)');
  eq(kv.writes - w0, 3, 'an accepted submission costs 3 KV writes (record + 2 counter shards)');

  // Free-tier arithmetic, stated as an assertion rather than as prose.
  eq(200 * 3, 600, '200 accepted submissions is 600 writes, inside the free 1000/day');
  ok(200 * 14 < 100000, '200 accepted submissions is 2800 reads, well inside the free 100000/day');
  ok(Math.floor(100000 / 4) === 25000, 'and 4 reads on the rate-limited path means ~25k rejected requests exhausts the daily read budget');

  // Every check before storage is free: no KV traffic at all on a rejection
  // that never reaches the limiter.
  const r1 = kv.reads, w1 = kv.writes;
  await call(post(body(), { origin: 'https://evil.example' }), env);
  await call(post(body(), { contentType: 'text/plain' }), env);
  await call(post(body(), { contentLength: null }), env);
  await call(post(body({ dwell: 10 })), env);
  await call(post(body({ message: '' })), env);
  eq(kv.reads - r1, 0, 'a rejection before the storage checks costs ZERO KV reads');
  eq(kv.writes - w1, 0, 'and zero writes');

  // At the global cap: both counters are read, nothing is written.
  const capped = makeEnv();
  capped.FEEDBACK.seed('gc:' + TODAY + ':0', 200);
  const r2 = capped.FEEDBACK.reads;
  eq((await call(post(body()), capped)).status, 503, 'the capped submission is a 503');
  eq(capped.FEEDBACK.reads - r2, 12, 'a capped request costs 12 KV reads (4 address shards + 8 global shards)');
  eq(capped.FEEDBACK.writes, 0, 'and zero writes');
}

// --- 11. missing binding, missing salt ------------------------------------

section('503 — missing binding and missing salt');
{
  const noBinding = makeEnv({ FEEDBACK: undefined });
  const response = await call(post(body()), noBinding);
  const json = await readJson(response);
  eq(response.status, 503, 'a missing KV binding is a 503, not a throw');
  eq(json.retry, true, 'the missing-binding 503 carries {retry:true}');
  eq(noBinding.ASSETS.calls, 0, 'it did not fall through to the assets, so nothing threw');

  const brokenBinding = makeEnv({ FEEDBACK: {} });
  eq((await call(post(body()), brokenBinding)).status, 503, 'a binding without get/put is a 503 as well');

  const noSalt = makeEnv({ FEEDBACK_SALT: undefined });
  const saltResponse = await call(post(body()), noSalt);
  eq(saltResponse.status, 503, 'a missing FEEDBACK_SALT fails closed with 503');
  eq(noSalt.FEEDBACK.writes, 0, 'and writes nothing — no salt means no rate limiting, so nothing is accepted');
  eq((await readJson(saltResponse)).retry, true, 'the missing-salt 503 carries {retry:true}');

  const emptySalt = makeEnv({ FEEDBACK_SALT: '' });
  eq((await call(post(body()), emptySalt)).status, 503, 'an empty FEEDBACK_SALT fails closed too');
}

// --- 12. a thrown route error still serves the site -----------------------

section('A fault always produces a Response, and never a consumed-Request retry');
{
  // A storage fault on the feedback path. By this point the body has been
  // read, so retrying env.ASSETS.fetch(request) would throw in production —
  // the fake assets binding above throws too, so if the worker tried it this
  // test would see a 503 with no asset call, or an escape.
  const env = makeEnv({ FEEDBACK: makeKV({ failPut: true }) });
  let response;
  try {
    response = await call(post(body()), env);
  } catch (err) {
    failures.push('a KV fault escaped the handler entirely: ' + err.message);
    response = new Response('{}', { status: 599, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  eq(response.status, 503, 'a storage fault on the feedback path is a 503, not a 500 and not an asset page');
  const faultJson = await readJson(response);
  eq(faultJson.ok, false, 'the fault reply is JSON, which is what the client parses');
  eq(faultJson.retry, true, 'the fault reply carries {retry:true} so the client can keep the typed text');
  eq(response.headers.get('X-Served-By'), null, 'the feedback path does NOT fall through to the assets');
  eq(env.ASSETS.calls, 0, 'the assets binding is not touched with an already-read Request');
  eq(response.headers.get('Cache-Control'), 'no-store', 'the fault reply is no-store like every other one');

  // The consumed-Request rule the fake assets binding enforces is real: prove
  // the harness would actually catch a fall-through here.
  const consumed = post(body());
  await consumed.text();
  eq(consumed.bodyUsed, true, 'reading a Request body sets bodyUsed');
  let assetsThrew = false;
  try {
    await makeAssets().fetch(consumed);
  } catch (err) {
    assetsThrew = true;
  }
  ok(assetsThrew, 'the fake assets binding rejects an already-read Request, as production does');

  // The same fault must not stop the site serving pages.
  const page = await call(new Request(ORIGIN + '/'), env);
  eq(page.headers.get('X-Served-By'), 'assets', 'page views are unaffected by a broken feedback route');
  eq(env.ASSETS.calls, 1, 'and that page view is the first and only asset call in this env');

  // A fault in the assets binding itself cannot crash the redirect.
  const brokenAssets = makeEnv({ ASSETS: { async fetch() { throw new Error('assets down'); } } });
  const redirect = await call(new Request('https://ecnl-dashboard.nextonetwolabs.workers.dev/'), brokenAssets);
  eq(redirect.status, 301, 'the redirect does not depend on the assets binding');

  // ...and a page view with a broken assets binding degrades to a 503 rather
  // than throwing out of fetch(). The catch's own body must not be able to
  // throw.
  let brokenPage;
  try {
    brokenPage = await call(new Request(ORIGIN + '/'), brokenAssets);
  } catch (err) {
    failures.push('a broken ASSETS binding escaped fetch() as an unhandled rejection: ' + err.message);
    brokenPage = new Response('', { status: 599 });
  }
  eq(brokenPage.status, 503, 'a broken assets binding is a 503, not an unhandled rejection');

  // env.ASSETS missing altogether — the catch used to dereference it blindly.
  const noAssets = makeEnv({ ASSETS: undefined });
  let missing;
  try {
    missing = await call(new Request(ORIGIN + '/'), noAssets);
  } catch (err) {
    failures.push('a missing ASSETS binding escaped fetch() as an unhandled rejection: ' + err.message);
    missing = new Response('', { status: 599 });
  }
  eq(missing.status, 503, 'a missing ASSETS binding is a 503, not an unhandled rejection');

  // And on the feedback path with no assets binding at all: still JSON.
  const noAssetsFeedback = makeEnv({ ASSETS: undefined, FEEDBACK: makeKV({ failPut: true }) });
  let missingFeedback;
  try {
    missingFeedback = await call(post(body()), noAssetsFeedback);
  } catch (err) {
    failures.push('a fault with no ASSETS binding escaped fetch(): ' + err.message);
    missingFeedback = new Response('{}', { status: 599, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  eq(missingFeedback.status, 503, 'a storage fault with no assets binding is still a 503');
  eq((await readJson(missingFeedback)).retry, true, 'and still carries {retry:true}');
}

// --- 13. no CORS headers, anywhere ----------------------------------------

section('No Access-Control-* header on any response, ever');
{
  let offenders = 0;
  let noStoreOnJson = 0;
  let jsonResponses = 0;
  for (const response of seen) {
    for (const name of response.headers.keys()) {
      if (name.toLowerCase().startsWith('access-control-')) offenders++;
    }
    if ((response.headers.get('Content-Type') || '').startsWith('application/json')) {
      jsonResponses++;
      if (response.headers.get('Cache-Control') === 'no-store') noStoreOnJson++;
    }
  }
  eq(offenders, 0, `no Access-Control-* header across all ${seen.length} responses in this run`);
  eq(noStoreOnJson, jsonResponses, `every one of the ${jsonResponses} JSON responses is Cache-Control: no-store`);
  ok(seen.length > 50, 'the CORS check covered the whole run, not a handful of responses');
}

// --- summary --------------------------------------------------------------

const line = '-'.repeat(64);
process.stdout.write('\n' + line + '\n');
process.stdout.write(`worker.js loaded via ${loadedVia}\n`);
if (failures.length === 0) {
  process.stdout.write(`PASS  ${checks} assertions, 0 failures, ${seen.length} worker responses exercised\n`);
  process.stdout.write(line + '\n');
  process.exit(0);
} else {
  process.stdout.write(`FAIL  ${checks} assertions, ${failures.length} failures\n\n`);
  for (const failure of failures) process.stdout.write('  x ' + failure + '\n');
  process.stdout.write(line + '\n');
  process.exit(1);
}
