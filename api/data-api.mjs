import { readArchive } from './archive-reader.mjs';

const routes = [
  [/^\/api\/v1\/catalog$/, 'catalog', []],
  [/^\/api\/v1\/status$/, 'status', []],
  [/^\/api\/v1\/events\/([^/]+)\/hierarchy$/, 'hierarchy', ['event']],
  [/^\/api\/v1\/events\/([^/]+)\/divisions\/([^/]+)\/flights\/([^/]+)\/standings$/, 'standings', ['event', 'division', 'flight']],
  [/^\/api\/v1\/events\/([^/]+)\/flights\/([^/]+)\/schedule$/, 'schedule', ['event', 'flight']],
  [/^\/api\/v1\/seasons\/([^/]+)\/teams$/, 'teams', ['season']],
  [/^\/api\/v1\/clubs$/, 'clubs', []],
  [/^\/api\/v1\/teams\/([^/]+)\/history$/, 'history', ['team']],
];

// IDs are canonical positive decimals; a season is "YYYY-YY" with consecutive years.
const isId = value => /^[1-9][0-9]*$/.test(value);
const isSeason = value => {
  const match = /^(20[0-9]{2})-([0-9]{2})$/.exec(value);
  return !!match && (Number(match[1]) + 1) % 100 === Number(match[2]);
};

export function resolveResource(path) {
  for (const [pattern, kind, fields] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (fields.some((name, i) => !(name === 'season' ? isSeason : isId)(match[i + 1]))) return { status: 400 };
    return { kind, ...Object.fromEntries(fields.map((name, i) => [name, match[i + 1]])) };
  }
  return { status: 404 };
}

// #82: a closed season (earlier than the catalog's refresh.activeSeason) is never fetched by
// the refresh again, so its event routes and its team index may be kept by the visitor's
// browser for a day, and shown once more while a newer copy is fetched. `private`: never by a
// shared cache. Everything else (the active season, a future or unknown one, the catalog,
// status, clubs, history) stays no-cache. See docs/data-api.md, "HTTP behavior".
export const CLOSED_CACHE = 'private, max-age=86400, stale-while-revalidate=86400';
const EVENT_KINDS = ['hierarchy', 'standings', 'schedule'];
const EVENT_LISTS = ['conferences', 'national', 'showcases'];
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// A catalog event id: a positive safe integer, or a canonical decimal string (as in a URL).
const eventKey = id => Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === 'string' && isId(id) ? id : null;

// { active, events: Map(eventId -> season) }, or null for a catalog that can't be trusted: no
// valid activeSeason (a strict YYYY-YY), or no seasons object. Seasons with a malformed key are
// skipped; an id listed in two seasons takes the later one. data_api.py's season_facts is the twin.
function seasonFacts(catalog) {
  const active = isObject(catalog) && isObject(catalog.refresh) ? catalog.refresh.activeSeason : null;
  if (typeof active !== 'string' || !isSeason(active) || !isObject(catalog.seasons)) return null;
  const events = new Map();
  for (const [season, entry] of Object.entries(catalog.seasons)) {
    if (!isSeason(season) || !isObject(entry)) continue;
    for (const kind of EVENT_LISTS) {
      const list = entry[kind];
      for (const event of Array.isArray(list) ? list : isObject(list) ? Object.values(list) : []) {
        const id = isObject(event) ? eventKey(event.eventId) : null;
        if (id && !(events.get(id) >= season)) events.set(id, season);
      }
    }
  }
  return { active, events };
}

// The catalog's season facts, read through ASSETS once per isolate. A module memo, not one per
// env.ASSETS: a Worker version's assets never change (every data change is a new deploy, and an
// isolate runs one version), and this does not depend on the binding object keeping its identity
// across requests. Only the parsed result is kept, never a pending read, so no request awaits
// another request's I/O. A failed or untrusted read is not kept: the next request reads again.
let catalogMemo = null;
export const resetCatalogMemo = () => { catalogMemo = null; };
async function catalogFacts(request, env) {
  if (catalogMemo) return catalogMemo;
  // A plain GET with no validators, whatever the request was (HEAD, If-None-Match).
  const stored = await readArchive(new Request(request.url), env, { kind: 'catalog' });
  if (stored.status !== 200 || !/^application\/json(?:;|$)/i.test(stored.headers.get('content-type') || '')) return null;
  const facts = seasonFacts(await stored.json());
  if (facts) catalogMemo = facts;
  return facts;
}

// The Cache-Control for a 200 or 304. Fails safe: any fault, or a catalog that can't be
// trusted, gives no-cache, and the data is still served.
export async function cachePolicy(request, env, resource) {
  const isEvent = EVENT_KINDS.includes(resource.kind);
  if (!isEvent && resource.kind !== 'teams') return 'no-cache';
  try {
    const facts = await catalogFacts(request, env);
    if (!facts) return 'no-cache';
    const season = isEvent ? facts.events.get(resource.event) : resource.season;
    return season && season < facts.active ? CLOSED_CACHE : 'no-cache';
  } catch {
    return 'no-cache';
  }
}

function failure(request, status) {
  const errors = { 400: 'Invalid identifier', 404: 'Not found', 405: 'Method not allowed', 503: 'Data is temporarily unavailable' };
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (status === 405) headers.allow = 'GET, HEAD';
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ ok: false, error: errors[status] }), { status, headers });
}

export async function dataApi(request, env) {
  const resource = resolveResource(new URL(request.url).pathname);
  if (resource.status) return failure(request, resource.status);
  if (!['GET', 'HEAD'].includes(request.method)) return failure(request, 405);
  try {
    const stored = await readArchive(request, env, resource);
    if (stored.status === 404) return failure(request, 404);
    // Missing assets may return HTML through SPA/404 fallback; never expose it as data.
    if (stored.status !== 304 && (stored.status !== 200 || !/^application\/json(?:;|$)/i.test(stored.headers.get('content-type') || ''))) {
      return failure(request, stored.status === 200 ? 404 : 503);
    }
    const headers = new Headers(stored.headers);
    // A 304 carries the same policy, so a revalidation renews the stored copy's lifetime.
    headers.set('cache-control', await cachePolicy(request, env, resource));
    headers.delete('set-cookie');
    return new Response(request.method === 'HEAD' || stored.status === 304 ? null : stored.body, { status: stored.status, headers });
  } catch (error) {
    console.error('data-api', error);
    return failure(request, 503);
  }
}
