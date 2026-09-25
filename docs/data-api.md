# Archived data API v1

## Purpose and contract

The public dashboard reads collected data through a same-origin API. Collection,
JSON archives, CSV exports, refresh scheduling, and frontend rendering are unchanged.
The API has no database and does not crawl upstream or load the full archive.

**Who can call it (#93).** The dashboard page calls it with its session cookie. Anyone
else (scripts, agents, other servers) needs an API key that the owner issues; see
[API keys](#api-keys). **For scrapers, day 1 changes nothing:** a script with neither a
key nor a cookie still gets 120 requests a minute per IP (60 after #92), and a script that
keeps the page's cookie gets 300. Keys are a sanctioned, visible and revocable path, not a
lock.

| GET / HEAD route | Archived response |
| --- | --- |
| `/api/v1/catalog` | `public/data/sources.json`: season/conference registry, national events and display metadata |
| `/api/v1/status` | `public/archive/refresh-state.json`: refresh timestamps and per-flight status |
| `/api/v1/events/{eventId}/hierarchy` | Event hierarchy envelope: divisions and their flights |
| `/api/v1/events/{eventId}/divisions/{divisionId}/flights/{flightId}/standings` | Standings envelope with every group block |
| `/api/v1/events/{eventId}/flights/{flightId}/schedule` | Schedule envelope, all clubs in that flight |
| `/api/v1/seasons/{season}/teams` | Team index for one season (derived; see below): `public/archive/teams/{season}.json` |
| `/api/v1/clubs` | Club places, every season (derived; see below): `public/archive/clubs.json` |

Apart from the team index and the club places, success bodies are the original JSON bytes. Existing
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
standings file. What the page does with the index answer (#92):

| Index answer | The page | Remembered |
| --- | --- | --- |
| 200 with a known schema | uses the rows | for the session |
| 404, or an unknown schema | falls back to the full scan, which reuses page-memory standings caches | for the session |
| any other 4xx (429, 400, 401, 403, …) | no scan: "Couldn't search right now" or "Couldn't load this team", with "try again" | for a minute (a `none` 429 until the session is back, if sooner) |
| a 5xx, a network error or bad JSON | no scan: the same "try again" message | no: the next search or lookup asks once more |

A refused index therefore never starts the scan, and a team lookup stops there
instead of going on through the other seasons. A lookup that does scan (no
index) stops at a failure other than a 404 in the same way once that season's scan
is done, rather than answering "Couldn't find …". `?live=1` never uses the index.

### Club places (`/api/v1/clubs`)

Also **derived**: the city and state each club lists on TGS, shown on the Team at a
glance card ("Davis, CA"). `archive.py` reads them from TGS's
`Event/get-club-info/{clubId}`, keeps only the city and the state or province code,
and writes one global file for every season (the endpoint has no season parameter):

```json
{"schema":1,"clubs":{
"9":{"city":"Central Islip","state":"NY"},
"64":null,
…}}
```

- `schema` is `1`, with the same bump rule as the team index. `clubs` maps a
  `clubID` (the team index's and the standings' `clubID`) to `{city, state}`, or to
  `null` when TGS has a record for the club but no usable city and state. A club
  missing from the map has not been fetched yet. One club per line, sorted by id.
- **Only city and state are stored.** The TGS response also carries the street,
  zip, phone and the club president's name, email and phone; none of it is kept,
  logged or served, and the raw response is never written to the archive: the
  archive writer and the local proxy accept only the six mirrored endpoint
  families (`ecnl_api.ARCHIVE_FAMILIES`) and refuse everything else before any
  fetch.
- Values are shown as TGS publishes them, cleaned but never guessed: whitespace
  trimmed, words typed wholly in lower case capitalised, a state name mapped to its
  code, and "City, ST 12345" typed into the city field cut to the city. A region
  ("Bay Area, CA") or an abbreviation ("Shelby Twp, MI") is shown as listed. A city
  that is blank, holds a digit, an `@`, a comma or "PO Box", or is over 40
  characters, and any state outside the US, its territories and Canada, is `null`.
- **When it is fetched.** The refresh's daily sweep run, after the state write and
  the team index, fetches clubs new in the active season's index, and on the first
  successful sweep of each UTC calendar month re-checks every active-season club
  (121 requests for 2026-27, about 3 minutes at 1.2 s apart). Each fetch has a 10 s
  timeout and one retry; a sweep stops at 10 failed clubs or after 8 minutes. A
  record that comes back empty or for another club is a failed fetch and keeps the
  previous entry; a re-check that would turn more than 5% of usable entries into
  `null` writes nothing. A crawl (`archive.py --season S`) fetches that season's
  new clubs. `archive.py --clubs [--season S | --all] [--force]` fetches missing
  clubs (every club with `--force`) under the same limits; the clubs seen only in
  past seasons are backfilled once this way and never re-checked.
- `refresh-state.json` (public via `/api/v1/status`) records the re-check in two
  fields, carried forward by every refresh: `lastClubSweepDate`, the day of the
  last completed monthly re-check, and `lastClubSweepAttempt`, the day of the last
  one attempted. After a re-check that is stopped or aborted, it is retried at most
  once a week (7 days after the attempt), not on every daily sweep; new clubs are
  still fetched meanwhile. Its `requests` and `failed` counts include club requests.

The page requests `/api/v1/clubs` at most once per session, only when a card shows
a team, and only alongside the tables when the card will show one at once (a
`&team=` link, a team page, My Teams, or a followed team in the division being
opened). No place (null, a club not in the file, or the file not loaded yet) shows
nothing. A 404 is kept for the session; any other failure shows nothing and is
retried at most once a minute. `?live=1` never requests it.

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
- No extra server cache, account or broad CORS policy is introduced. Browser
  clients use the same origin. Direct use (scripts, agents, servers) needs an API
  key (see "API keys" below) and no CORS. The API sends no `Access-Control-*`
  header, so a key can't be used from another site's page; permitting sibling
  browser origins can be designed separately.
- Requests are session-scoped or keyed, and rate-limited, and every answer carries
  `X-ECNL-Session` (see "Sessions and rate limits" below). A limited request gets a
  JSON 429 with `Retry-After: 60`.

## Sessions and rate limits

`/api/v1/*` serves this site's page, on a session cookie (#90), and direct use with an
owner-issued API key (#93; see [API keys](#api-keys)). A request with neither is not
refused outright: it gets a small per-IP allowance, the small allowance for browsers
without cookies, and beyond it a 429 that points to keys. Everything is rate-limited, so
a plain script can't pull the data at full speed, and scraping shows up in counts. This
caps how *fast* data can be pulled, not how much: anyone determined can still load `/`,
keep the cookie and copy everything in a few minutes per IP address (keys don't close
that route), and the repo holds the same data.

### The session cookie

When the Worker serves the page (`GET` or `HEAD /`, including a 304), it sets, when there is no
valid session or it is over an hour old:

    __Host-ecnl_s=v1.<iat>.<exp>.<id>.<signature>; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax

- **What it holds:** a random 16-byte id and two times (issued, expires), signed with
  HMAC-SHA-256 under the `SESSION_SECRET` Worker secret. Nothing personal: no IP address,
  no user agent, nothing about the visitor. It is not a secret; it says "this client
  loaded the page", and its id keys the per-session limit.
- **Lifetimes:** the token is valid for 24 hours; the cookie is kept for 7 days, so a
  token that lapsed is counted as `anon-expired` rather than looking like a cookieless
  script. Once a token is an hour old, the next API answer re-issues it with a **fresh id**
  (`X-ECNL-Session: renewed`), so no browser carries one id for long. Requests already in
  flight at that moment may each get a new cookie; the browser keeps the last. Changing the
  lifetime in `api/session.mjs` invalidates every token at once: one spike of `anon-invalid`
  and one background `HEAD /` per open tab.
- **Renewal in the page:** any API answer with `X-ECNL-Session: none` (cookie lost,
  blocked, expired, or an anonymous-tier 429) makes the page send one background `HEAD /`,
  at most once a minute, which sets a fresh cookie. A session-tier 429 says `ok` and never
  triggers it. `?live=1` never does. If a request sent after a renewal landed (the `HEAD /`
  answered 2xx) still says `none`, the browser is not keeping cookies, and the page stops
  renewing until an answer says `ok` or `renewed` (#92). A renewal that fails (5xx or
  network) does not count, so renewal goes on.
- A response that sets the cookie is marked `Cache-Control: private, no-cache` (an API
  error keeps `no-store`). The archive read never sees the cookie.
- `Sec-Fetch-Site: cross-site` with a cookie (someone following a link to an API URL;
  `SameSite=Lax` withholds it from cross-site fetches) is served on the anonymous tier and
  counted as `anon-cross-site`.

### Limits

Every `/api/v1*` request, including 400/404/405 probes, is checked by Cloudflare's Workers
rate-limiting binding (`wrangler.toml`, `[[ratelimits]]`, wrangler 4.36.0 or later):

| Limiter | Key | Limit | Applies to |
| --- | --- | --- | --- |
| `RL_SESSION` | session id | 300 per 60 s | requests with a valid session cookie |
| `RL_KEY` | API key id (`key:<id>`) | 120 per 60 s | requests with a valid API key (#93) |
| `RL_ANON` | IP address, or the IPv6 /64 | 120 per 60 s: the small allowance for browsers without cookies; #92 lowers it to 60 | requests with neither a key nor a valid cookie |
| `RL_IP` | IP address, or the IPv6 /64 | 3,000 per 60 s | every request, keyed ones too (a per-IP ceiling sized for a crowd on one venue Wi-Fi; it does not protect the daily quota) |

An IPv4-mapped address (`::ffff:a.b.c.d`) is keyed as its IPv4 address. On the session and
anonymous tiers the IP check and the tier check run in parallel, so a request refused by one
still uses a count in the other. A keyed request is checked against `RL_IP` first (over it:
429 with no key lookup), then its key, then `RL_KEY`, so an invalid key never uses a real
key's allowance. Counters are per Cloudflare location and deliberately approximate; errors
favour visitors.

Over a limit: `429`, `{"ok":false,"error":"Too many requests. Please wait a minute and try
again."}`, `Retry-After: 60`, `Cache-Control: no-store`, no body on HEAD. On the anonymous
tier the body also has `"help"`, the bare URL of [API keys](#api-keys), and the same target
is in a `Link: <…#api-keys>; rel="help"` header. The page shows neither `error` nor `help`: it
says "Too many requests. Try again in a minute.", or on a 429 that says `none`, "Too many
requests. Try again in a minute, or allow cookies for this site and reload the page." (#92).
A table refused (or failing with anything but a 404) shows "Some tables couldn't load." with
a **Try again** button, never an empty "0 teams" table; nothing retries on its own. Every
answer from `/api/v1` carries `X-ECNL-Session`:

| Value | Meaning |
| --- | --- |
| `ok` / `renewed` | served on the session tier (`renewed` also sets a new cookie) |
| `key` | the request carried an `Authorization` header or a key in its URL: served on its key, or refused (400, 401, 429 or 503; see "API keys") |
| `none` | no key and no valid session: served on the anonymous tier, or refused there (429) |
| `off` | sessions are off: the Worker has no usable `SESSION_SECRET`, or it is the local Python server |
| `error` | a fault in the session code; the data is served without any limit (never on the key path) |

Measured locally (Chrome against an offline stand-in for the Worker with fake limiters): every
journey #81 and #87 measured, with cookies, gets zero 429s, and so does the busiest single tab
(149 requests in 11 s). Without cookies at 120 per minute, only that stress case is refused (14 of
134). At 60, the fastest real journey (every age group of the largest conference, twice, 66
requests) gets 6.

### Using the API from a script

Scripts and agents use an API key, sent in the `Authorization` header (see
[API keys](#api-keys)):

```sh
curl -s -H "Authorization: Bearer $ECNL_API_KEY" https://ecnl.nextonetwo.com/api/v1/status
```

Without a key, `curl` still works within the small anonymous allowance, and beyond it gets
a 429 whose `help` field points to keys.

### How the web app's session works (team testing)

This is how the page itself gets the session tier, and how the team tests it. It is not the
way for other scripts to use the API, which is a key; it is written down because anyone can
see it, and keys don't close it (see the scope note above).

```sh
curl -s -o /dev/null -c jar.txt https://ecnl.nextonetwo.com/
curl -s -b jar.txt -c jar.txt https://ecnl.nextonetwo.com/api/v1/status
```

The first request loads `/`, which sets the session cookie; the second sends it back and is
answered `X-ECNL-Session: ok`. Delete `jar.txt` afterwards.

### The Workers Free quota

The account is on **Workers Free: 100,000 Worker requests a day, reset at 00:00 UTC.** After
that, the Worker answers errors, and `/` and `/api/*` do not fall back to the static assets
(they run the Worker first), so **the whole site is down for every visitor until 00:00 UTC.**
Every request that reaches the Worker counts, **including the Worker's own 429s.** The limits
above make an unwanted request cheap to answer; they do not stop it from being counted. One
client at `RL_IP`'s pace (3,000 a minute) uses the day's quota in about 33 minutes, so **a
flood can take `/` and `/api/*` down for the rest of the UTC day.** This risk predates #90;
#90 does not create it.

- **Workers Paid is the only full remedy.** It is a hosting decision for the owner, not a
  charge to visitors.
- **On Free, the one free WAF rate-limiting rule is recommended** (owner, after merge): path
  starts with `/api/v1/`, counted per IP, 1,000 requests per 10 s, block for 10 s. It is
  partial: it still lets a determined client through at roughly the same pace, and whether
  it runs before the Worker (so that blocked requests are not Worker requests) is to be
  confirmed in Security Events.

### What is recorded

Each non-routine request writes **one** Workers Analytics Engine data point (dataset
`ecnl_api_events`, binding `API_EVENTS`): `blob1` the outcome, `blob2` the route kind
(`catalog`, `standings`, …, `invalid` or `unknown` for probes, `page` for `/`), `blob3` the
`Sec-Fetch-Site` class, `blob4` `production` or `preview` (from the request host, because
this Worker's version previews run with production's bindings and vars), `double1` 1. **No IP address,
session id or user agent.** Outcomes:

- `anon-missing`, `anon-invalid`, `anon-expired`, `anon-cross-site`: served on the anonymous tier.
- `limited-session`, `limited-anon`, `limited-ip`: refused with 429 (replaces the `anon-*` point).
- `minted`: `/` issued a new session. `disabled`: served with sessions off.
  `gate-error`: a fault in the session code.
- API keys (#93):
  - `key-ok`: served on a valid key. **Every keyed request is counted**, for per-key usage.
  - `key-invalid`: 401, with the reason in `blob6`: `scheme` (not `Bearer <key>`),
    `malformed` (not key-shaped), `unknown` (no record for that id), `record` (a record
    this code doesn't understand) or `mismatch` (the id exists, the secret is wrong).
  - `key-revoked`: 401 for a revoked key. `limited-key`: 429 over `RL_KEY`.
  - `limited-ip` with `blob6` `key`: a keyed request refused by `RL_IP` before its key was
    looked at.
  - `key-error`: 503, the key store missing or failing.
  - `key-in-url`: 400, a key-shaped string in the URL's path or query string.

  Key points add `blob5`, the key id, and `blob6`, the reason (empty when there is none).
  The id is recorded only once a record exists for it, and `-` otherwise, so an id a caller
  made up in a header is never stored. **The exception is `key-in-url`,** which keeps the id
  read from the URL, unverified, because it tells the owner which key to revoke. An id is
  12 hex characters and never the secret; the key itself, its hash and the `Authorization`
  header are never written anywhere. Points with a verified id use it as their index, so
  per-key sums sample fairly.

Routine session requests write nothing; totals come from the Worker's own metrics. A write
that fails (quota, missing binding) never changes the response. Rate-limit keys (a session
id, an IP address or a /64) are held briefly by Cloudflare's per-location limiter to count;
we never write them anywhere. On Free, Analytics Engine allows 100,000 points a day, as many
as the Worker has requests, and keeps them 3 months.

To report (a token with *Account · Account Analytics · Read*), always weighting by
`_sample_interval`, never `SUM(double1)`:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/<account-id>/analytics_engine/sql" \
  -H "Authorization: Bearer <token>" \
  --data "SELECT blob1 AS outcome, blob4 AS site, SUM(_sample_interval) AS requests
          FROM ecnl_api_events WHERE timestamp > NOW() - INTERVAL '1' DAY
          GROUP BY outcome, site ORDER BY requests DESC"
```

Per key, the same way with this query:

```sql
SELECT blob5 AS key_id, blob1 AS outcome, SUM(_sample_interval) AS requests
FROM ecnl_api_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND (blob1 LIKE 'key-%' OR blob1 = 'limited-key')
GROUP BY key_id, outcome ORDER BY requests DESC
```

The measure of success is the `limited-*` counts, not zero scraping.

### Failure modes

- **No secret** (or one under 32 characters): sessions are off. No cookie is set, only
  `RL_IP` applies, answers say `X-ECNL-Session: off`, and each request counts `disabled`.
  Production must never answer `off`.
- **A fault in the session code** (a limiter or crypto throw): the data is still served as
  JSON, never the assets' HTML, with `X-ECNL-Session: error`; it is counted as `gate-error`
  and logged with the tag `session`. A failed key import is retried on the next request.
- **The API key store missing or failing** (the `API_KEYS` binding, or KV's daily read
  quota): keyed requests **fail closed** with 503 and `Retry-After: 60`, counted as
  `key-error` and logged with the tag `apikey` (never the key). Any other fault on the key
  path answers the same way. It never takes the fail-open path above: otherwise any
  key-shaped header would get ungated data while KV is down. Cookie and anonymous requests
  never touch the key store and are unaffected.
- **The local Python server** runs with sessions off (`X-ECNL-Session: off`, no cookie, no
  limits), the same as the Worker without a secret, and checks no API keys: an
  `Authorization` header or a key in the URL changes nothing. Its status codes match the
  Worker's, except that the Worker can also answer 429, and 400, 401 or 503 for keys.

### Owner setup (the team changes none of this)

1. **Once, before the first build with these bindings:** create the Analytics Engine dataset
   `ecnl_api_events` with the binding `API_EVENTS` in the Cloudflare dashboard. The first
   build of #90 failed without it (done for #90).
2. **Before the PR's Cloudflare preview check:** create the secret with a generated value,
   not a passphrase. **Before merge, or whenever an undeployed version exists** (a PR preview
   is the latest uploaded version), add it to a new version **without deploying**, then use
   **Retry build** on the PR's latest build:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler versions secret put SESSION_SECRET --name ecnl-dashboard
   ```

   Later uploads keep existing secrets. **Don't** add the secret in the dashboard's
   Production settings with **Deploy**, and don't use a plain `wrangler secret put`, while a
   PR preview is the latest version: both build the new version from that latest version, so
   they could put unmerged PR code into production (or be refused). **Rotating the secret
   later, when the deployed version is the latest:** `npx wrangler secret put SESSION_SECRET
   --name ecnl-dashboard` is fine; it re-issues every session. This Worker's builds run
   `wrangler versions upload` (version preview URLs, not the newer Worker Previews), so a
   preview uses production's bindings and secrets; a version uploaded before `SESSION_SECRET`
   exists runs with sessions off (`X-ECNL-Session: off`) until it is uploaded again (**Retry
   build** in the dashboard).
3. **Before merge:** confirm no other Worker on the account uses rate-limit `namespace_id`s
   9001–9003 (a namespace id is shared by every Worker on the account that uses it).
4. **After merge:** add the WAF rate-limiting rule above (recommended on Free).
5. **For reports:** an API token with *Account · Account Analytics · Read*.
6. **API keys (#93):** the KV namespace `ECNL_API_KEYS` exists (created in the dashboard; its
   id is in `wrangler.toml` as the `API_KEYS` binding), and rate-limit `namespace_id` 9004
   (`RL_KEY`) is unused elsewhere on the account (checked in the sibling repo). Keys are
   issued and revoked as in [Issuing and revoking keys](#issuing-and-revoking-keys-owner).

Never:

- Enable Pseudo IPv4 "Overwrite headers": it would give each IPv6 address its own IPv4 and
  defeat the /64 key.
- Turn on Bot Fight Mode: it is zone-wide, can't be exempted per path, and challenges API
  clients, including the team's `curl` checks.
- List `SESSION_SECRET` under `[secrets] required` in `wrangler.toml`: a missing required
  secret blocks every deploy, including the data-refresh deploys.
- Turn on Workers Logs (`[observability]`) or run `wrangler tail` without first checking
  whether it records request headers: it may record `Authorization`, and so API keys
  (unverified; see "API keys").

## API keys

Direct use of `/api/v1` (scripts, agents, other servers) needs an API key that the owner
issues (#93). The dashboard page never uses one; it keeps its session cookie. There is no
self-service signup and no billing.

**How to ask for one.** Use **Send feedback** at the foot of the site's sidebar, and give a
reply address. Say what the key is for (a project or agent name) and roughly how many
requests a day. The owner replies from their own email with the key. Keys are never sent
in a GitHub issue, a pull request or a chat.

**How to send it.** Only in the `Authorization` header, as `Bearer <key>` (`Bearer` in any
case). Never in a URL: URLs end up in browser history, `Referer` headers, proxy and server
logs, chat previews and shared links. A key-shaped string anywhere in the path or query
string, plain or percent-encoded (up to 8 times over), is refused with 400, "Treat this key
as exposed and ask for a new one", and the owner can see which key it was.

```sh
curl -s -H "Authorization: Bearer $ECNL_API_KEY" https://ecnl.nextonetwo.com/api/v1/catalog
```

```python
import os, urllib.request
req = urllib.request.Request("https://ecnl.nextonetwo.com/api/v1/catalog",
                             headers={"Authorization": "Bearer " + os.environ["ECNL_API_KEY"]})
print(urllib.request.urlopen(req).read()[:200])
```

A key is `ecnl_live_<id>_<secret>`: `id` is 12 lowercase hex characters and not secret (it
names the key in counts and in the owner's commands); `secret` is 64 lowercase hex
characters. The API sends no CORS headers, so a key only works from servers, scripts and
agents, not from another site's page.

**Limits.** 120 requests per 60 s per key (`RL_KEY`), and every keyed request also counts
toward the per-IP ceiling (`RL_IP`, 3,000 per 60 s). That is 2 requests a second: a full
copy of every resource takes about 11 minutes. Over a limit: 429 with `Retry-After: 60`.

**Answers.** Every answer to a keyed request says `X-ECNL-Session: key`. Refusals (400, 401,
429, 503) are JSON with `Cache-Control: no-store`. A served request is answered as any other:
the data with `Cache-Control: no-cache`, or a 304 with no body. HEAD never has a body.

| Case | Status | Body and headers |
| --- | --- | --- |
| Valid key | 200 (or 304, 400, 404, 405 as for any request) | the data; no cookie |
| Invalid, unknown or revoked key, or not `Bearer <key>` | 401 | `{"ok":false,"error":"This API key is not valid or has been revoked.","help":"<this section's URL>"}`, the same for every reason; `WWW-Authenticate: Bearer realm="ecnl", error="invalid_token"` |
| Over `RL_KEY` or `RL_IP` | 429 | `{"ok":false,"error":"Too many requests. Please wait a minute and try again."}`, `Retry-After: 60` |
| Key in the URL | 400 | `{"ok":false,"error":"Send API keys in the Authorization header, never in a URL. Treat this key as exposed and ask for a new one.","help":"<this section's URL>"}` |
| Key store unavailable | 503 | `{"ok":false,"error":"API keys cannot be checked right now. Please try again later."}`, `Retry-After: 60` |

- An `Authorization` header is always judged as a key, even beside a valid session cookie:
  a bad key gets 401 and never falls back to the cookie.
- **Timing.** A new key works about 2 minutes after the owner stores it, and a revoked key
  stops within about 2 minutes: up to 60 s in the Worker's own cache plus up to 60 s for KV
  to reach every location. A key used before it is stored is remembered as unknown for as
  long, so wait the 2 minutes.
- **The Workers Free quota applies to keyed traffic too.** Every keyed request counts
  against the 100,000 a day, including 401s and 429s (see "The Workers Free quota"). A key
  at full pace would use the whole day's quota in about 14 hours; the per-key limit doesn't
  protect the quota.

**What the owner keeps about a key.** One KV record per key in the `ECNL_API_KEYS`
namespace (binding `API_KEYS`), under `key:<id>`:

| Field | Value |
| --- | --- |
| `v` | 1 |
| `hash` | SHA-256 (hex) of the whole key. The key itself is never stored. |
| `label` | a project or agent name the owner chooses, 1–40 letters, digits, spaces or `._-`; never a person's name or an email address |
| `created` | ISO time |
| `tier` | `standard` |
| `status` | `active`, or `revoked` (a revoked record keeps `v`, `label`, `status` and `revoked`, the time, and drops the hash) |

Counts record the key id, never the key (see "What is recorded").

**Handling a key.** Treat it like a password.
- Keep it in an environment variable or a file outside any repository; never commit it,
  paste it in an issue or chat, or put it in a URL.
- Never capture it in a debugging record: no `curl -v`, no browser HAR export and no
  Playwright trace while a key is in use, because all of them record request headers.
- In reports and messages, redact it to `ecnl_live_<id>_…`.
- If it may have been exposed, ask for a new one; the owner revokes the old one.
- `tests/apikey.test.mjs` fails CI if a key-shaped string is in the repository. **If it ever
  finds one, revoke that key first**: the repository is public, so a pushed key is already
  exposed. Then remove it from the tree.
- Keys travel in a request header. Workers Logs and `wrangler tail` may record request
  headers, including `Authorization` (not verified). This Worker has no `[observability]`
  section; keep it that way, or check what they record first.

### Issuing and revoking keys (owner)

`tools/apikey.mjs` does it. It needs only Node, makes no network request and never runs
wrangler: it prints the key once, writes only the hash record to the system temp folder, and
prints the exact commands to run. **Run it in a standalone PowerShell window, not the
desktop app's Terminal panel,** which assistants can read. Run the printed `npx.cmd wrangler`
commands in the same window, in your ECNLDash folder, as for the #90 secret; they name the
namespace by id, so they don't need this branch's `wrangler.toml`, and they always pass
`--remote`, because wrangler v4 otherwise writes only to a local copy on your computer.

```powershell
node tools\apikey.mjs new --label "acme-agent"                     # prints the key once, then the commands
node tools\apikey.mjs new --label "auditor-93" --ttl 604800        # a test key that KV deletes after 7 days
node tools\apikey.mjs revoke <id> --label "acme-agent"             # keeps a revoked record; prints the commands
node tools\apikey.mjs list                                         # prints the command that lists key ids
node tools\apikey.mjs get <id>                                     # prints the command that shows one record
node tools\apikey.mjs purge <id>                                   # prints the command that deletes a record
node tools\apikey.mjs help                                         # all of the above, with every wrangler command
```

`new` prints, in order: the key (give it to its holder by private email; it is not shown
again), the `npx.cmd wrangler kv key put "key:<id>" --path "<temp file>" --namespace-id
0f7cd5892944474598857af3e82bdafb --remote` that stores the record, and the `Remove-Item` for
the temp file (it holds only the hash). Use a project or agent name as the label, never a
person's name. `--ttl` is in seconds, at least 60. **Once you have sent the key and run the
printed commands, close that PowerShell window:** the key stays in its scrollback until you
do. (The tool itself doesn't say this.)

**Revoking** keeps a record with the id, label and time, so the counts still show a revoked
key that is being tried (`key-revoked`). **Purging** (`kv key delete`) removes it entirely;
use it only to clean up.

**Before #93 is merged** (the preview check), your checkout doesn't have the tool yet. The
tool is one self-contained file, so copy it, pinned to the commit the Reviewer reviewed
(5708d1d), and run it from the temp folder:

```powershell
git fetch origin claude/93-api-keys
git show 5708d1d:tools/apikey.mjs | Set-Content -Encoding ascii "$env:TEMP\ecnl-apikey-tool.mjs"
node "$env:TEMP\ecnl-apikey-tool.mjs" new --label "auditor-93" --ttl 604800
```

**Keep that copy until the test key is revoked, and revoke with it:**
`node "$env:TEMP\ecnl-apikey-tool.mjs" revoke <id> --label "auditor-93"`, with the key's id in
place of `<id>`. Only then delete the copy (`Remove-Item "$env:TEMP\ecnl-apikey-tool.mjs"`).
**After merge and a `git pull`,** `node tools\apikey.mjs …` works from your checkout, as above.

**The team's test key.** One per verification round, issued by the owner:
- `new --label "auditor-93" --ttl 604800`: KV deletes the record after 7 days, so a
  forgotten key expires. **Revoke it after the production check**, with the temp copy if
  it was issued before merge (see above).
- The owner gives it to the Auditor privately. The Auditor reads it from an environment
  variable (`ECNL_TEST_KEY`) or a file outside the repository, never uses `curl -v`, HAR or
  Playwright traces with it, and redacts it to `ecnl_live_<id>_…` in reports.
- **It works on production too:** version previews use production's bindings, so preview and
  production read the same key store.
- It sits in the Auditor's local transcript, which is why it expires.

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
to raw snapshot files, while `/api/v1/*` remains the API contract: the page's session or
an API key, and rate-limited (see "Sessions and rate limits" and "API keys").
Blocking requests prevents future downloads; it does not claw back copies already
cached in visitors' browsers from earlier releases (a cache purge of `/archive/*`
and `/data/*` on deploy is recommended hygiene).

Each v1 request now invokes the Worker, whereas direct static JSON reads did not.
With the team index (#81) and the club places (#87, one request per session),
measured locally: a cold shared team link for 2026-27 makes 7 v1 requests instead
of 78, a Teams search 1 instead of 73, and opening My Teams with three favourites
9 instead of 226. Without the index
(the fallback, after a 404; never after a refused or failed index, #92) a cold search
makes roughly 75 Worker requests per selected season; page-memory caches still
eliminate repeated standings reads. Include
this request volume in usage monitoring before increasing traffic: on Workers Free
every one of these requests counts against the 100,000-a-day quota (see "The Workers
Free quota").

Later, replace the archive reader with private R2 and add validated publishing.
That can remove data-only deployments without changing v1 clients. Server-side
search and database-backed analytics are separate future additions, and so are per-key
tiers or billing on top of the API keys (#93).

The Python server offers the same archive-only v1 routes with stdlib only, with
sessions off (`X-ECNL-Session: off`, no cookie, no rate limits) and no API key checks.
Its explicit `?live=1` debug path still uses the legacy proxy and reconstructed
schedule guards. Use Wrangler to test the actual Worker and feedback, which the
Python server does not implement.

The production `ecnl-dashboard.nextonetwolabs.workers.dev` hostname redirects to
the canonical site. Cloudflare version and branch preview hosts intentionally
serve their own deployment so preview checks cannot accidentally test production.
