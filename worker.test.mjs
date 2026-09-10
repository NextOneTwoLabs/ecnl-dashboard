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
// rejection, that the cap fails closed, that a fault still falls through to
// the assets, and that no Access-Control-* header is ever emitted.

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

function post(payload, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (opts.origin !== null) headers.set('Origin', opts.origin || ORIGIN);
  if (opts.contentType !== null) headers.set('Content-Type', opts.contentType || 'application/json');
  headers.set('User-Agent', opts.ua || 'Mozilla/5.0 (test harness)');
  if (opts.address !== null) headers.set('CF-Connecting-IP', opts.address || '203.0.113.9');
  const init = { method: opts.method || 'POST', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = opts.raw !== undefined ? opts.raw : JSON.stringify(payload);
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

  // 413 — an oversized body, read and rejected.
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

  const noEmail = await call(post(body({ email: '' })), env);
  eq(noEmail.status, 200, 'an empty email is treated as no email');
  const last = env.FEEDBACK.records();
  const record = JSON.parse(env.FEEDBACK.store.get(last[0]).value);
  ok(record.email === null || typeof record.email === 'string', 'email is null or a string, never undefined');

  const emoji = await call(post(body({ message: '👍'.repeat(1000) })), env);
  eq(emoji.status, 200, '1000 surrogate pairs = 2000 UTF-16 units is accepted, matching maxlength');
  const emojiTooLong = await call(post(body({ message: '👍'.repeat(1001) })), env);
  eq(emojiTooLong.status, 400, '1001 surrogate pairs is over the cap, the same count the client makes');

  const noContext = await call(post({ type: 'idea', message: 'no context at all', dwell: 3000 }), env);
  eq(noContext.status, 200, 'context and viewport are optional');
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
  eq(limited.headers.get('Retry-After'), '86400', 'the 429 says when to come back');

  const before = env.FEEDBACK.writes;
  await call(post(body({ message: 'and another' })), env);
  eq(env.FEEDBACK.writes - before, 0, 'a rate-limited request performs ZERO KV writes');

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

section('A fault in the route still falls through to the assets');
{
  const env = makeEnv({ FEEDBACK: makeKV({ failPut: true }) });
  let response;
  try {
    response = await call(post(body()), env);
  } catch (err) {
    failures.push('a KV fault escaped the handler instead of falling through to the assets: ' + err.message);
    response = new Response('', { status: 599 });
  }
  eq(response.headers.get('X-Served-By'), 'assets', 'a KV fault falls through to env.ASSETS.fetch');
  eq(response.status, 200, 'the fallback response is the asset response, not a 500');
  eq(env.ASSETS.calls, 1, 'the assets binding was used exactly once');

  // The same fault must not stop the site serving pages.
  const page = await call(new Request(ORIGIN + '/'), env);
  eq(page.headers.get('X-Served-By'), 'assets', 'page views are unaffected by a broken feedback route');

  // And a fault in the assets binding itself cannot crash the redirect.
  const brokenAssets = makeEnv({ ASSETS: { async fetch() { throw new Error('assets down'); } } });
  const redirect = await call(new Request('https://ecnl-dashboard.nextonetwolabs.workers.dev/'), brokenAssets);
  eq(redirect.status, 301, 'the redirect does not depend on the assets binding');
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
