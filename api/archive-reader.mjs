// Storage layout stays behind this adapter; handlers never accept asset paths.
export function assetPath(resource) {
  const { kind, event, division, flight, season } = resource;
  switch (kind) {
    case 'catalog': return '/data/sources.json';
    case 'status': return '/archive/refresh-state.json';
    case 'hierarchy': return `/archive/api/Event/get-event-schedule-or-standings/${event}.json`;
    case 'standings': return `/archive/api/Event/get-standings-by-div-and-flight/${division}/${flight}/${event}.json`;
    case 'schedule': return `/archive/api/Event/get-schedules-by-flight/${event}/${flight}/0.json`;
    case 'teams': return `/archive/teams/${season}.json`;
    case 'clubs': return '/archive/clubs.json';
    default: throw new Error('Unknown resource');
  }
}

export function readArchive(request, env, resource) {
  const url = new URL(assetPath(resource), request.url);
  // Forward validators only, not cookies, ranges, or arbitrary browser headers.
  const headers = new Headers();
  for (const name of ['if-none-match', 'if-modified-since']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  return env.ASSETS.fetch(new Request(url, { method: request.method, headers }));
}
