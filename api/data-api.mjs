import { readArchive } from './archive-reader.mjs';

const routes = [
  [/^\/api\/v1\/catalog$/, 'catalog', []],
  [/^\/api\/v1\/status$/, 'status', []],
  [/^\/api\/v1\/events\/([^/]+)\/hierarchy$/, 'hierarchy', ['event']],
  [/^\/api\/v1\/events\/([^/]+)\/divisions\/([^/]+)\/flights\/([^/]+)\/standings$/, 'standings', ['event', 'division', 'flight']],
  [/^\/api\/v1\/events\/([^/]+)\/flights\/([^/]+)\/schedule$/, 'schedule', ['event', 'flight']],
  [/^\/api\/v1\/seasons\/([^/]+)\/teams$/, 'teams', ['season']],
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
    headers.set('cache-control', 'no-cache');
    headers.delete('set-cookie');
    return new Response(request.method === 'HEAD' || stored.status === 304 ? null : stored.body, { status: stored.status, headers });
  } catch (error) {
    console.error('data-api', error);
    return failure(request, 503);
  }
}
