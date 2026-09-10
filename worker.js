// Entry point for the deployed Worker. The site itself is the static files in
// public/ (see [assets] in wrangler.toml). This script does two things and runs
// ahead of the static assets for "/" and "/api/*" only (run_worker_first in
// wrangler.toml), so a page view costs one Worker request and every other file
// is served as a free static asset:
//
//   1. Sends the workers.dev address to the canonical custom domain. Browsers
//      carry the #fragment across a redirect, so deep links such as
//      #tab=teams&team=55477 still land on the right page.
//   2. Accepts visitor feedback at POST /api/feedback and stores it in the
//      FEEDBACK KV namespace, one key per submission. Stored: when it was sent,
//      the message, the reply email if the visitor gave one, and the URL hash
//      the visitor was on, so "the standings look wrong" says which standings.
//      No IP address, no user agent, nothing else about the visitor.
const CANONICAL_HOST = 'ecnl.nextonetwo.com';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Matches the textarea's maxlength in public/index.html; both count UTF-16 code units.
const MAX_MESSAGE = 2000;
// The hash names the view (season, age group, conference, tab). Nothing real comes close to
// this long; the cap only stops a crafted body from padding the record.
const MAX_HASH = 200;
// The body is two short strings, so 8 KB is generous. Without this, request.json() would let
// Cloudflare buffer up to its 100 MB limit into this isolate — the same isolate that serves
// the page — before anything measured it.
const MAX_BODY = 8192;
// Long enough to act on a report and reply, short enough that nothing lingers for years.
const TTL_SECONDS = 180 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isFeedback = url.pathname === '/api/feedback';
    try {
      if (url.hostname.endsWith('.workers.dev')) {
        url.hostname = CANONICAL_HOST;
        return Response.redirect(url.toString(), 301);
      }
      if (isFeedback) return await feedback(request, env);
    } catch {
      // A fault in the feedback handler must not take page serving down with it. The request
      // body may already be spent by now, so the feedback path answers for itself instead of
      // handing a consumed request to the assets binding.
      if (isFeedback) return json({ ok: false, error: 'Something went wrong. Please try again.' }, 503);
    }
    return env.ASSETS.fetch(request);
  },
};

// Feedback answers JSON and only JSON: the dashboard renders nothing without JavaScript, so
// there is no plain-form fallback to redirect. Nothing here is cacheable, and the only caller
// is this site's own page, so no Access-Control-* header is ever set.
const json = (body, status) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

async function feedback(request, env) {
  const reply = (status, error) => json(error ? { ok: false, error } : { ok: true }, status);

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'Method not allowed' }, {
      status: 405,
      headers: { allow: 'POST', 'cache-control': 'no-store' },
    });
  }
  // A deploy that lost the binding should say so rather than throw on the put below.
  if (!env.FEEDBACK) return reply(503, 'Feedback is not available right now. Please try again later.');

  // Measure before reading (see MAX_BODY).
  const declared = request.headers.get('content-length');
  const size = declared ? Number(declared) : NaN;
  if (!Number.isFinite(size)) return reply(411, 'Please try again.');
  if (size > MAX_BODY) return reply(413, 'Please keep it under 2,000 characters.');

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // JSON.parse can return null or a scalar; neither can be dereferenced below.
  if (!body || typeof body !== 'object') body = {};

  // Honeypot: real visitors never see the "website" field. Pretend it worked and store nothing.
  if (body.website) return reply(200);

  const message = String(body.message || '').trim();
  if (!message) return reply(400, 'Please add a message.');
  if (message.length > MAX_MESSAGE) return reply(400, 'Please keep it under 2,000 characters.');

  // The email is optional, so it is only checked when the visitor gave one.
  const email = String(body.email || '').trim().toLowerCase();
  if (email && (!EMAIL.test(email) || email.length > 254)) {
    return reply(400, 'Please enter a valid email address.');
  }

  // The one thing recorded about the page rather than the person: which view was open.
  const hash = String(body.hash || '').trim().slice(0, MAX_HASH);

  // One key per submission. The email cannot be the key: it is optional and not unique. The ISO
  // timestamp makes `kv key list` come back in chronological order and readable by eye; the random
  // suffix keeps two submissions in the same millisecond apart. Repeating the email as metadata
  // lets a listing show whether there is a reply address without fetching every record.
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const record = { sent: new Date().toISOString(), message };
  if (email) record.email = email;
  if (hash) record.hash = hash;
  await env.FEEDBACK.put(`${record.sent}-${suffix}`, JSON.stringify(record), {
    metadata: { email: email || null },
    expirationTtl: TTL_SECONDS,
  });
  return reply(200);
}
