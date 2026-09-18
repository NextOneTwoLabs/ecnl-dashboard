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

Success bodies are the original JSON bytes. Existing envelopes (`data` where
present), field names/casing, array order, null values, IDs, empty groups, and
reconstructed match metadata (`source`, `reconstructed`, negative match IDs)
are preserved. No wrapping, merging, sorting, or date correction happens here.
The frontend continues interpreting these responses exactly as before.
Future storage readers must preserve this contract; incompatible schemas require
a new API version. IDs are canonical positive decimal strings (`[1-9][0-9]*`),
without leading zeros. Query parameters do not change the selected archived object.

The catalog resolves season/conference to eventId. Its hierarchy resolves the
selected age to divisionId and flightIds. Multiple flights require one request
each. Team search still fans out over the selected season and reuses page-memory
standings caches; no new search index or endpoint is introduced.

## HTTP behavior

- GET returns one JSON object; HEAD has equivalent status/headers without a body.
- Known route shapes with invalid IDs return 400. Unknown routes or missing
  objects return 404. Unsupported methods on known valid routes return 405 with
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
schema migration to reverse. Raw archive URLs remain public in this phase.

Later, replace the archive reader with private R2 and add validated publishing.
That can remove data-only deployments without changing v1 clients. Server-side
search and database-backed analytics are separate additions, not prerequisites.

The Python server offers the same archive-only v1 routes with stdlib only.
Its explicit `?live=1` debug path still uses the legacy proxy and reconstructed
schedule guards. Use Wrangler to test the actual Worker and feedback, which the
Python server does not implement.
