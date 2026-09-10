// Entry point for the deployed Worker. The site itself is the static files in
// public/ (see [assets] in wrangler.toml); this script sends the workers.dev
// address to the canonical custom domain and serves the one dynamic route the
// site has, POST /api/feedback. It runs ahead of the static assets for "/"
// only (run_worker_first in wrangler.toml); every other path that matches a
// file in public/ is served as a free static asset without invoking us, and a
// path that matches no file — /api/feedback — reaches this script.
//
// Browsers carry the #fragment across a redirect, so deep links such as
// #tab=teams&team=55477 still land on the right page.
//
// EVERYTHING lives inside fetch(). A throw at module scope would kill every
// page view and no try/catch could save it, so there is no module-scope work
// here beyond these constants, and the whole handler body is wrapped with
// env.ASSETS.fetch(request) as the fallback: a fault in the feedback route
// can never take the site down with it.
const CANONICAL_HOST = 'ecnl.nextonetwo.com';

// Origins allowed to post feedback. The dashboard is served from exactly one
// host; www.ecnl.nextonetwo.com does not resolve (checked), and the apex
// nextonetwo.com is a different site that does not embed this form, so the
// allowlist is a single entry. Add the www variant here if it is ever
// pointed at this Worker.
const ALLOWED_ORIGINS = ['https://' + CANONICAL_HOST];

const FEEDBACK_PATH = '/api/feedback';
const MAX_BODY_BYTES = 8192;       // 413 above this, on Content-Length and on read
const MAX_MESSAGE_UNITS = 2000;    // UTF-16 code units, to match the client's maxlength
const MAX_EMAIL_UNITS = 254;
const MAX_UA_UNITS = 256;
const MAX_CONTEXT_UNITS = 200;
const MIN_DWELL_MS = 1000;         // server backstop; the real 2500 ms gate is client-side
const VALID_TYPES = ['bug', 'idea', 'other'];
const HONEYPOT_FIELD = 'subjectline';

const RECORD_TTL_SECONDS = 180 * 24 * 60 * 60;  // records expire after 180 days
const LIMIT_TTL_SECONDS = 24 * 60 * 60;         // rate-limit keys expire after 24 hours

// Per-address daily limit and the global daily cap that keeps the free tier's
// 1000 KV writes/day out of reach: 200 accepted submissions x 3 writes each
// (record, address counter, global counter) = 600.
const ADDRESS_DAILY_LIMIT = 10;
const GLOBAL_DAILY_CAP = 200;

// KV allows roughly one write per second per key, so a burst of accepted
// submissions would fail on a single shared counter rather than on the record.
// Both counters are therefore sharded: a write picks one shard at random, a
// read sums every shard. N is small on purpose — the read cost is N gets per
// accepted submission, and the counters are only touched after every free
// check has already passed.
const GLOBAL_SHARDS = 8;
const ADDRESS_SHARDS = 4;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // The workers.dev redirect stays first and unchanged.
      if (url.hostname.endsWith('.workers.dev')) {
        url.hostname = CANONICAL_HOST;
        return Response.redirect(url.toString(), 301);
      }

      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === FEEDBACK_PATH) {
        return await handleFeedback(request, env, ctx);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      // Last-ditch fallback. A fault anywhere above — including in the
      // feedback route — must still leave the site serving pages.
      return env.ASSETS.fetch(request);
    }
  },
};

// --- responses ------------------------------------------------------------

// Every response is JSON and no-store, and NEVER carries an Access-Control-*
// header: without CORS a cross-origin browser post cannot read the reply, and
// an accidentally cached reply cannot leak anything.
function json(status, body, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (extraHeaders) {
    for (const name of Object.keys(extraHeaders)) headers[name] = extraHeaders[name];
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Rejections never echo the submission back — only a stable machine-readable
// reason and a short human sentence.
function reject(status, reason, message, extraHeaders) {
  return json(status, { ok: false, error: reason, message }, extraHeaders);
}

// --- the feedback route ---------------------------------------------------

// Check order is deliberate: method, Origin, content type, Content-Length,
// parse, honeypot, dwell, then type/length. KV is not touched until all of
// them pass, and is NEVER written on a rejection.
async function handleFeedback(request, env, ctx) {
  if (request.method !== 'POST') {
    return reject(405, 'method_not_allowed', 'Use POST.', { Allow: 'POST' });
  }

  const origin = request.headers.get('Origin');
  if (!origin || ALLOWED_ORIGINS.indexOf(origin) === -1) {
    return reject(403, 'forbidden_origin', 'This form only accepts posts from the site itself.');
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return reject(415, 'unsupported_media_type', 'Send application/json.');
  }

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reject(413, 'too_large', 'That message is too long.');
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    return reject(413, 'too_large', 'That message is too long.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(buffer));
  } catch (err) {
    return reject(400, 'malformed_json', 'That request could not be read.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return reject(400, 'malformed_json', 'That request could not be read.');
  }

  // Honeypot: the only silent discard. No human can fill this field, so there
  // is no genuine submission to lose, and a bot that fills it learns nothing.
  const honeypot = payload[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return json(200, { ok: true });
  }

  // Dwell is a number the client sent, not a delay we observed, so it is only
  // a backstop against scripted clients. A failure is a visible 400, never a
  // silent success: the 2500 ms gate that a human might trip lives in the
  // client, where it can disable the button instead of discarding the text.
  const dwell = payload.dwell;
  if (typeof dwell !== 'number' || !Number.isFinite(dwell)) {
    return reject(400, 'bad_dwell', 'That request could not be read.');
  }
  if (dwell < MIN_DWELL_MS) {
    return reject(400, 'too_fast', 'That was too quick — please try again.');
  }

  if (typeof payload.type !== 'string' || VALID_TYPES.indexOf(payload.type) === -1) {
    return reject(400, 'bad_type', 'Choose what kind of feedback this is.');
  }

  if (typeof payload.message !== 'string') {
    return reject(400, 'empty_message', 'Please write a message.');
  }
  const message = payload.message.trim();
  if (message === '') {
    return reject(400, 'empty_message', 'Please write a message.');
  }
  // UTF-16 code units, the same thing the client's maxlength counts, so an
  // emoji-heavy message cannot pass the client and fail here.
  if (message.length > MAX_MESSAGE_UNITS) {
    return reject(400, 'message_too_long', 'Please keep it under 2000 characters.');
  }

  let email = null;
  if (payload.email !== undefined && payload.email !== null && payload.email !== '') {
    if (typeof payload.email !== 'string') {
      return reject(400, 'bad_email', 'That email address does not look right.');
    }
    email = payload.email.trim();
    if (email === '') {
      email = null;
    } else if (email.length > MAX_EMAIL_UNITS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reject(400, 'bad_email', 'That email address does not look right.');
    }
  }

  // Everything above is free. From here on we need storage.
  if (!env.FEEDBACK || typeof env.FEEDBACK.put !== 'function' || typeof env.FEEDBACK.get !== 'function') {
    return retryLater();
  }
  // No salt means no rate limiting, and an unlimited public write endpoint is
  // worse than a closed one, so a missing secret fails closed too.
  if (typeof env.FEEDBACK_SALT !== 'string' || env.FEEDBACK_SALT === '') {
    return retryLater();
  }

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);

  // request.cf is undefined outside Cloudflare (wrangler dev, the harness), so
  // country is simply unknown there.
  const country = (request.cf && typeof request.cf.country === 'string') ? request.cf.country : null;

  // The address never reaches a record and never reaches storage in the clear:
  // it becomes a key name derived through a per-UTC-day HMAC, so yesterday's
  // hashes cannot be correlated with today's, and the derived keys expire in
  // 24 hours.
  const address = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const addressHash = await dailyAddressHash(env.FEEDBACK_SALT, day, address);

  // Read-only check. At the limit this returns 429 having written nothing.
  const addressCount = await sumShards(env.FEEDBACK, 'rl:' + day + ':' + addressHash + ':', ADDRESS_SHARDS);
  if (addressCount >= ADDRESS_DAILY_LIMIT) {
    return reject(429, 'rate_limited', 'That is enough feedback from here for today — thank you.', {
      'Retry-After': String(LIMIT_TTL_SECONDS),
    });
  }

  // The global cap fails closed: at the cap we stop accepting rather than risk
  // the free tier's daily write budget, which the site's own deploys share.
  const globalCount = await sumShards(env.FEEDBACK, 'gc:' + day + ':', GLOBAL_SHARDS);
  if (globalCount >= GLOBAL_DAILY_CAP) {
    return retryLater();
  }

  const id = crypto.randomUUID();
  const ts = new Date(now).toISOString();

  // Inverted timestamp so KV's ascending list returns the NEWEST first in one
  // call: 9999999999999 - Date.now(), zero-padded to 13 digits. The padding is
  // load-bearing — the inverted value stays 13 digits until roughly the year
  // 2255, and mixed digit lengths would sort wrongly.
  const key = 'fb:' + String(9999999999999 - now).padStart(13, '0') + ':' + id;

  const record = {
    v: 1,
    id,
    ts,
    type: payload.type,
    message,
    email,
    context: readContext(payload.context),
    ua: clip(request.headers.get('User-Agent'), MAX_UA_UNITS),
    viewport: readViewport(payload.viewport),
    country,
  };

  // Metadata rides along with list(), so triage reads one list call and only
  // fetches the records worth opening.
  await env.FEEDBACK.put(key, JSON.stringify(record), {
    expirationTtl: RECORD_TTL_SECONDS,
    metadata: {
      t: ts,
      type: record.type,
      len: message.length,
      hasEmail: email !== null,
      country,
    },
  });

  // Counters are best-effort on purpose: the submission is already stored, and
  // a counter write that loses a race must not turn a stored message into an
  // error for the person who sent it. Undercounting is bounded by the WAF rule
  // in front of this route.
  await Promise.all([
    bumpShard(env.FEEDBACK, 'rl:' + day + ':' + addressHash + ':', ADDRESS_SHARDS),
    bumpShard(env.FEEDBACK, 'gc:' + day + ':', GLOBAL_SHARDS),
  ]);

  return json(200, { ok: true, id });
}

function retryLater() {
  return json(503, { ok: false, retry: true, error: 'unavailable', message: 'Feedback is unavailable right now — please try again later.' }, {
    'Retry-After': '3600',
  });
}

// --- helpers --------------------------------------------------------------

function clip(value, max) {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function readContext(raw) {
  const out = { hash: null, season: null, age: null, conference: null, view: null, tab: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const field of Object.keys(out)) {
    out[field] = clip(typeof raw[field] === 'string' ? raw[field] : null, MAX_CONTEXT_UNITS);
  }
  return out;
}

function readViewport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w: Math.max(0, Math.min(100000, Math.round(w))), h: Math.max(0, Math.min(100000, Math.round(h))) };
}

// HMAC(HMAC(salt, UTC date), address). Deriving a day key first means the
// stored key names correlate only inside the 24 hours the limiter needs.
async function dailyAddressHash(salt, day, address) {
  const encoder = new TextEncoder();
  const dayKey = await hmac(encoder.encode(salt), encoder.encode(day));
  const digest = await hmac(new Uint8Array(dayKey), encoder.encode(address));
  return hex(digest).slice(0, 32);
}

async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, messageBytes);
}

function hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// Sum every shard of a counter. KV reads are eventually consistent and edge
// cached, so this can lag and the cap can overshoot a little; at 600 writes of
// a 1000/day budget there is headroom for that.
async function sumShards(kv, prefix, shards) {
  const values = await Promise.all(
    Array.from({ length: shards }, (_, i) => kv.get(prefix + i))
  );
  let total = 0;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

// One write, to one randomly chosen shard, so no single key is hot.
async function bumpShard(kv, prefix, shards) {
  const shard = prefix + Math.floor(Math.random() * shards);
  try {
    const current = Number(await kv.get(shard));
    const next = (Number.isFinite(current) && current > 0 ? current : 0) + 1;
    await kv.put(shard, String(next), { expirationTtl: LIMIT_TTL_SECONDS });
  } catch (err) {
    // Best-effort, see above.
  }
}
