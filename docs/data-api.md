# Archived data API v1

## Purpose and contract

The public dashboard reads collected data through a same-origin API. Collection,
JSON archives, CSV exports, refresh scheduling, and frontend rendering are unchanged.
The API has no database and does not crawl upstream or load the full archive.

| GET / HEAD route | Archived response |
| --- | --- |
| `/api/v1/catalog` | `public/data/sources.json`: season/conference registry, national events and display metadata |
| `/api/v1/status` | `public/archive/refresh-state.json`: refresh timestamps and per-flight status |
| `/api/v1/events/{eventId}/hierarchy` | Event hierarchy envelope: divisions and their flights |
| `/api/v1/events/{eventId}/divisions/{divisionId}/flights/{flightId}/standings` | Standings envelope with every group block |
| `/api/v1/events/{eventId}/flights/{flightId}/schedule` | Schedule envelope, all clubs in that flight |
| `/api/v1/seasons/{season}/teams` | Team index for one season (derived; see below): `public/archive/teams/{season}.json` |

Apart from the team index, success bodies are the original JSON bytes. Existing
envelopes (`data` where present), field names/casing, array order, null values,
IDs, empty groups, and reconstructed match metadata (`source`, `reconstructed`,
negative match IDs) are preserved. No wrapping, merging, sorting, or date
correction happens here. The frontend continues interpreting these responses
exactly as before. Future storage readers must preserve this contract;
incompatible schemas require a new API version. IDs are canonical positive
decimal strings (`[1-9][0-9]*`), without leading zeros. A season is `YYYY-YY`
with consecutive years and a first year from 2000 to 2099 (`2026-27`; not
`2026-28`, `26-27`, `1999-00` or `2026%2D27`). Query parameters do not change
the selected archived object.

The catalog resolves season/conference to eventId. Its hierarchy resolves the
selected age to divisionId and flightIds. Multiple flights require one request
each.

### Team index (`/api/v1/seasons/{season}/teams`)

Unlike the other routes, this body is **derived**: `archive.py` builds it from the
archived hierarchies and standings (no upstream requests) and serves the file's
bytes unchanged. It is rebuilt at the end of a crawl, by every `--refresh`
(including a run with nothing due, so a stale file heals), and by
`python archive.py --team-index --all`; it is rewritten only when a row changes.

```json
{"schema":1,"season":"2026-27","teams":[
{"teamID":131830,"name":"…","clubID":22,"clubName":"…","clublogo":"https://…","eventID":4263,"divisionID":22407,"division":"GU13","flightID":40551,"conference":"Mid-Atlantic","flightName":"ECNL","rank":1,"gp":1,"wins":1,"losses":0,"draws":0,"standingpoints":3,"goaldifferential":5},
…]}
```

- `schema` is `1`. Any change to the shape (a field renamed, removed or retyped)
  bumps it; the page ignores a schema it does not know and scans instead.
- `season` is the season key. `teams` has one row per team per flight, for every
  team row in the season's conference standings, in the page's scan order:
  catalog conference order, then hierarchy division and flight order, then
  table position.
- Row fields: `teamID`, `name`, `clubID`, `clubName`, `clublogo`, `eventID`,
  `divisionID`, `division`, `flightID` and the stats `gp`, `wins`, `losses`,
  `draws`, `standingpoints`, `goaldifferential` keep the standings row's names
  and values. `conference` is the catalog conference name, `flightName` the
  hierarchy flight name, and `rank` the 1-based position in the flight's table
  after merging group blocks as the page does.
- Teams that played only a national event are not listed (the scan never found
  them either). A season with nothing archived has no file (404).

The page uses the index to find a deep-linked team or a saved favourite and to
run a Teams search: one request per season instead of every hierarchy and
standings file. If the index is missing (404), has an unknown schema, or fails
(then retried on the next lookup), the page falls back to the full scan, which
reuses page-memory standings caches. `?live=1` never uses the index.

## HTTP behavior

- GET returns one JSON object; HEAD has equivalent status/headers without a body.
- Known route shapes with invalid IDs or a malformed season return 400 with
  `"error": "Invalid identifier"`. Unknown routes or missing objects (including
  a well-formed season with no index, such as `2030-31`) return 404. Unsupported methods on known valid routes return 405 with
  `Allow: GET, HEAD`. Storage faults return 503.
- Errors are `{ "ok": false, "error": "..." }` JSON and `Cache-Control: no-store`.
  Missing assets never fall through to an HTML page or the live upstream API.
- Success and 304 responses use `Cache-Control: no-cache`: stored browser copies
  must revalidate. The Worker forwards If-None-Match / If-Modified-Since to the
  asset binding and retains its validators and 304 status. Python generates a
  content ETag and Last-Modified and implements conditional requests, with ETag
  taking precedence. Validators can differ between local Python and Cloudflare.
- No extra server cache, authentication, or broad CORS policy is introduced.
  Browser clients use the same origin. Server-to-server clients do not require
  CORS; permitting sibling browser origins can be designed separately.

## Deployment and evolution

Keep the existing single Worker/static-assets deployment and all data-triggered
builds. New data is bundled, so a commit alone does not update production until
its deployment completes. Deploy API and frontend together. Before production,
verify a preview using current standings, multiple flights, historical groups,
playoffs, reconstructed finals, search, favorites, deep links, and feedback.
Compare cold/warm navigation and search with the previous release.

Rollback restores the previous complete application deployment; there is no
schema migration to reverse. Direct visitor access to raw archive and data
assets (`/archive/*`, `/data/*`, and bare `/archive`, `/data`) is blocked with
404 at the edge Worker and local server. This closes the unauthenticated side door
to raw snapshot files, while `/api/v1/*` remains the unauthenticated public API contract.
Blocking requests prevents future downloads; it does not claw back copies already
cached in visitors' browsers from earlier releases (a cache purge of `/archive/*`
and `/data/*` on deploy is recommended hygiene).

Each v1 request now invokes the Worker, whereas direct static JSON reads did not.
With the team index (#81), measured locally: a cold shared team link for
2026-27 makes 6 v1 requests instead of 78, a Teams search 1 instead of 73, and
opening My Teams with three favourites 8 instead of 226. Without the index
(the fallback) a cold search makes roughly 75 Worker requests per selected
season; page-memory caches still eliminate repeated standings reads. Include
this request volume in usage monitoring before increasing traffic.

Later, replace the archive reader with private R2 and add validated publishing.
That can remove data-only deployments without changing v1 clients. Server-side
search, database-backed analytics, and a keyed private API are separate future additions.

The Python server offers the same archive-only v1 routes with stdlib only.
Its explicit `?live=1` debug path still uses the legacy proxy and reconstructed
schedule guards. Use Wrangler to test the actual Worker and feedback, which the
Python server does not implement.

The production `ecnl-dashboard.nextonetwolabs.workers.dev` hostname redirects to
the canonical site. Cloudflare version and branch preview hosts intentionally
serve their own deployment so preview checks cannot accidentally test production.
