# ECNL Girls Conference Standings Dashboard

A standings **and schedule** dashboard for ECNL (Elite Clubs National League) Girls
conferences — a single static HTML page over a self-refreshing local archive of the data.

Everything is mirrored to disk, so the dashboard keeps working from local files if the
upstream API or website ever goes away.

## Features

- **Conference Standings** — All 10 ECNL conferences across 6 seasons (2021-22 through 2026-27), per-flight tables
- **Matches** — Date-grouped match cards per conference: kickoff, both teams, score, venue. Opens on upcoming matches, with Results (newest first) and Full season (scrolled to the next match day) a click away
- **Team at a glance** — Click any team in a standings table: position, points, recent form, next match, last result and more statistics in a side panel, with a Follow button and a link to the full team page
- **Fully static** — no backend at runtime; deploys to any static host for free, and works offline once loaded
- **Self-refreshing** — a scheduled job updates the data on match days and keeps the fixture calendar current
- **CSV exports** — Human-readable standings and schedule tables under `export/`, openable in Excel
- **Playoffs & Finals** — National post-season per age group and competition (Champions League, North American Cup, Showcase Cup, Showcase Games): knockout brackets drawn as trees, cup and consolation brackets, group tables where a group stage exists, round-tagged schedules, and a format note per competition
- **★ My Teams** — Follow any team; each favorite opens a summary page: the glance panel, the full table with the team highlighted, the team's own fixtures and results, and its post-season games when it played any
- **One team search** — Find a team across every age group and conference in the current season; a result opens it on its conference page with the age group and team selected
- **Age group navigation** — Tabs populated from the API; keyboard arrow-key navigation, `/` to search
- **Dark mode**, and **deep links** (season, age group, conference, view, selected team and match filter in the URL hash)
- **Data explained** — Standings state that the order is as published by TGS (points per game, then goal difference), the header shows when the data was observed, and every view links to its source page on TGS

## How it works

The site is **fully static**. `archive.py` pre-fetches every API response into
`public/archive/api/**.json`, and the page reads those files directly — it never
calls the API from the browser (which it couldn't anyway: the API sends no CORS
headers). A scheduled GitHub Action keeps the data current.

`public/` is simultaneously the Cloudflare Pages output directory and the local
server root, so **the hosted site and your local copy are the same files** with no
build step between them.

## Run it locally

```bash
cd public && python -m http.server 8000     # any static server works
```

Then open [http://localhost:8000/](http://localhost:8000/). No backend needed.

Or use `python proxy_server.py` (port 5000) if you also want `?live=1`, which
routes data requests through a live API proxy for debugging.

## Refresh the data

```bash
python archive.py --refresh        # what the scheduled workflow runs
```

The refresh is **driven by the fixture calendar**, not a clock. Of 288 days in a
season only 81 have games, and 99.7% of those are Sat/Sun — so on most days there
is provably nothing to fetch:

| Run | Work done |
|---|---|
| Non-match day, not the sweep hour | exits in seconds, **0 requests** |
| Sweep hour (daily) | all flight schedules, rebuilding the calendar |
| Match day | the flights that played, every 2 h |

Standings are only refetched where a **result actually changed** — schedule
payloads carry scores, so a schedule fetch collects results too, and standings
cannot move unless a score did.

Useful flags:

```bash
python archive.py --refresh --sweep                    # force the all-flights sweep
python archive.py --refresh --dry-run --date 2026-09-12  # test a given day
python archive.py --season 2026-27                     # full crawl of one season
python archive.py --all                                # every season (~1,200 requests)
```

Commit `public/archive/` and `export/` — that is what makes the data durable, and
pushing to `main` is what deploys.

## Adding a season or conference

`data/sources.json` is the single source of truth for which event IDs back each
season and conference. Both the dashboard and `archive.py` read it, so nothing is
hardcoded in the HTML.

1. Add the season/conference and its `eventId` to `data/sources.json`. The event ID
   is the number in a TGS URL: `public.totalglobalsports.com/public/event/**3925**/…`
2. Verify it points where you think it does — this calls the API and compares the
   real event name against the `eventName` you recorded:

   ```bash
   python archive.py --verify --season 2026-27
   ```

3. Archive it: `python archive.py --season 2026-27`

The season dropdown rebuilds itself from the registry, so no HTML edit is needed.
It sits under the sidebar tabs, above the tab panels, and is available on
Conferences and Playoffs (My Teams hides it, since a favorite belongs to one
season).

## National playoffs

A season's post-season events live under `national` in `data/sources.json`, keyed
by the stage name shown in the sidebar. 2024-25 had separate `Playoffs` and
`Finals` events; 2025-26 has one combined event, so its row reads
`"Playoffs & Finals"` and the stage selector is hidden.

```json
"national": {
  "Playoffs & Finals": {
    "eventId": 4251,
    "eventName": "ECNL Girls National Playoffs and Finals",
    "location": "Redmond, WA",
    "startDate": "2026-07-11", "endDate": "2026-07-17",
    "tierLabels": { "Friendlies": "Showcase Games" },
    "tierNotes":  { "Champions League": "32 teams seeded by conference PPG …" }
  }
}
```

- `startDate`/`endDate` gate the refresh: the event's flights join the match-day
  refresh from a week before it starts until two weeks after it ends, then drop out.
- `tierLabels` renames TGS flight names for display; `tierNotes` is the collapsible
  "Format" text under each competition, taken from ECNL's post-season structure doc.

**Brackets are derived from the schedule, not from TGS's bracket HTML.** Knockout
flights have no standings, but every game carries both team IDs, scores, PK scores
and a game number. The page follows each team's lineage — losing in round *r* of a
bracket moves it into that round's losers bracket — which reproduces the main
bracket, the Champions League Cup (day-one losers) and the consolation games without
any template. A game that ended level with no PK score recorded is settled from the
next game each team plays. TGS's bracket HTML is archived for durability only.

Not included: the U18/19 National Finals is a separate TGS event (St. Louis, June)
and can be added as a second `national` entry when its event ID is known. The
2024-25 Finals event (3975) publishes no games through the API, so that bracket
ends at the round played at the Playoffs event.

## My Teams

Favorites are stored in the browser (`localStorage`) as records — the team name plus
the IDs that locate it (`eventID`, `divisionID`, `flightID`, `teamID`) — captured from
the standings row when the ★ is clicked. A favorite therefore belongs to one team in
one season; clicking it switches the season selector to that season. Favorites saved
by the earlier version (name only) are located by scanning the archived standings the
first time My Teams is opened, and upgraded in place.

`#tab=teams&season=2026-27&team=<teamID>` deep-links to a team's summary even in a
browser where it isn't a favorite (it is shown, not added to the list).

A conference view is `#season=2026-27&age=GU16&conf=NorCal`, optionally with
`&view=schedule`, `&team=<teamID>` (the team shown in the glance panel) and
`&sched=results` or `&sched=all` (the match filter; upcoming is the default).

Playoffs is `#tab=playoffs&season=2026-27`, with `&stage=`, `&age=` and `&tier=`
appended once the season has national events. Keys omitted from a link take
their defaults (Standings, upcoming matches, no selected team — the glance panel
falls back to a favourite, if any; for Playoffs the first stage, age group and
competition) rather than the viewer's last state. The season can be changed from
the Playoffs tab; the tab is kept and the hash follows the new season.

## Layout

| Path | What it is |
|---|---|
| **`public/`** | **Everything the site serves** — Pages output dir and local server root |
| `public/index.html` | The whole app — HTML, CSS and JS in one file |
| `public/data/sources.json` | Season → conference → event ID registry, refresh policy, birth-year anchor |
| `public/archive/api/…` | Raw API responses keyed by endpoint path — what the site reads |
| `public/archive/match-days.json` | Fixture calendar that drives the refresh schedule |
| `public/archive/refresh-state.json` | When the data was last refreshed (powers "Updated 3h ago") |
| `public/archive/manifest.json` | Index tying event IDs back to season/conference/flight |
| `archive.py` | Crawler: match-day refresh, bulk backfill, CSV exports, `--verify` |
| `ecnl_api.py` | Shared API/archive helpers |
| `proxy_server.py` | Local static server, plus the `?live=1` API proxy |
| `export/<season>/<conf>/` | CSVs — not published; `*.standings.csv`, `*.schedule.csv` |
| `.github/workflows/refresh.yml` | The 2-hourly scheduled refresh |
| `ecnl-standings.html` | Deprecated first version, kept for reference |

## Deploying

The site is a Cloudflare Worker serving static assets (`wrangler.toml` at the repo
root: `[assets] directory = "./public"`, plus `worker.js`, which redirects the
`workers.dev` hostname and serves the one dynamic route the site has,
`POST /api/feedback` (see [Visitor feedback](#visitor-feedback)). It is built
by Cloudflare's Git integration
on the **NextOneTwoLabs** Cloudflare account: repository `NextOneTwoLabs/ecnl-dashboard`,
branch `main`, build command empty, deploy command `npx wrangler deploy`. Pushing to
`main` — including the scheduled data commits — redeploys.

- **Canonical URL:** `https://ecnl.nextonetwo.com` — a custom domain attached to the
  Worker (the `nextonetwo.com` zone lives in the same Cloudflare account, so DNS and
  the certificate are managed automatically).
- `https://ecnl-dashboard.nextonetwolabs.workers.dev` permanently redirects there
  (`worker.js`, which runs ahead of the assets for `/` only, so page views cost one
  Worker request and every other file is a free static asset).
- `https://ecnl-dashboard.zhenyisx.workers.dev` — the original address — also
  redirects there, served by the tiny Worker in [`redirect/`](redirect/) from the
  original personal account.

Deep-link `#` fragments survive both redirects.

The `workers.dev` subdomain belongs to the Cloudflare account, not to GitHub — moving
the repository between GitHub owners does not change the URL, but Cloudflare's GitHub
App must be installed on the new owner for builds to continue.

## Visitor feedback

`POST /api/feedback` on the Worker takes the "Send feedback" form in the page and
writes it to a private Cloudflare KV namespace on the same account. Nothing leaves
our own hosting, there is no third-party form service, and the sender needs no
account. The maintainers read the submissions, then open ordinary public issues in
their own words, without personal details.

### The endpoint

JSON in, JSON out. Every response is `Cache-Control: no-store`, never carries an
`Access-Control-*` header (so a cross-origin browser post cannot read the reply)
and never echoes the submission back.

```json
{ "type": "bug", "message": "...", "email": "optional@example.com",
  "dwell": 4200, "context": { "hash": "#tab=teams", "season": "2025-26",
  "age": "GU15", "conference": "Midwest", "view": "standings", "tab": "teams" },
  "viewport": { "w": 390, "h": 844 } }
```

| Status | When |
| --- | --- |
| `200 {ok,id}` | stored |
| `200 {ok}` | honeypot field filled — nothing is stored, and this is the only silent discard |
| `400` | malformed JSON, bad or missing type, empty message, message over 2000 UTF-16 units, bad email, non-numeric dwell, dwell under the backstop |
| `403` | `Origin` missing or not `https://ecnl.nextonetwo.com` |
| `405` (`Allow: POST`) | any other method, including GET, HEAD and OPTIONS |
| `411` | `Content-Length` absent or not a plain integer — a chunked or unlabelled body is refused before it is read |
| `413` | `Content-Length` over 8192, or the body exceeds it on read |
| `415` | content type is not `application/json` (a `; charset=utf-8` parameter is fine) |
| `429` (`Retry-After`) | the per-address daily limit — checked with a read, never a write. `Retry-After` is the seconds left until UTC midnight, when the day-keyed bucket actually resets |
| `503 {retry:true}` | the KV binding or `FEEDBACK_SALT` is missing, or the global daily cap is reached |

Checks run in that order — method, `Origin`, content type, `Content-Length`, parse,
honeypot, dwell, then type and length — and **KV is not touched until every one of
them passes, and is never written on a rejection.**

The body is never read unbounded. A request must **declare** a `Content-Length` that
is a plain integer no greater than 8192, or it is refused with `411`/`413` before a
byte is pulled; and because the header is only a claim, the body is then read through
a reader that cancels the stream the moment the accumulated byte count crosses the
cap. A chunked or lying request costs one chunk, not the 100 MB Cloudflare would
otherwise let it buffer into a 128 MB isolate.

The whole `fetch()` body is wrapped in a catch that **always returns a Response**, so
a fault in this route can never stop the site serving pages. It is deliberately not a
bare `env.ASSETS.fetch(request)`: on the feedback path the request body has usually
already been read, and fetching a consumed `Request` throws, so the feedback path
returns the same `503 {retry:true}` JSON the client already handles. Every other path
falls through to the assets inside its own try/catch, so a missing or broken `ASSETS`
binding degrades to a plain `503` rather than an unhandled rejection. All of the new
code lives inside the handler, because a throw at module scope would kill every page
view and no try/catch could save it.

Local dev does not run the Worker at all (`proxy_server.py` implements only GET),
so the form reports that feedback is unavailable on a local copy. `npx wrangler dev`
exercises the route against local storage.

### What stops abuse

- A **WAF rate-limiting rule on `/api/feedback`**, configured in the Cloudflare
  dashboard. This is the only defence that protects the *site*: every page view is
  already a Worker request against the free tier's 100k/day, so a flood on this
  route would take the homepage down before any of our code runs.

  It is also **the only bound on KV read spend**, which matters just as much.
  Measured against the harness: an accepted submission costs **14 reads and 3
  writes** (4 address shards + 8 global shards + one read per counter bump; record
  + two counter shards), and a rate-limited one costs **4 reads and 0 writes**.
  Two hundred accepted submissions is 2,800 reads of the free 100,000/day, which is
  comfortable — but 4 reads on the *rejected* path means roughly **25,000 rejected
  requests exhaust the daily read budget**, and after that the reads themselves fail:
  the limiter check throws, lands in the outer catch, and the endpoint degrades to
  `503 {retry:true}` for the rest of the UTC day. Pages keep serving — they are
  static assets and touch no KV — but feedback stops until midnight. Nothing in
  this Worker can prevent that, because the spend happens before any of our checks
  can be cheap enough to matter; only the WAF rule, in front of the route, can.
  The read and write counts per path are asserted in `worker.test.mjs`, so the
  arithmetic above cannot drift out of date without a test failing.
- An **`Origin` allowlist** of the one canonical host, and no CORS headers.
- A **honeypot** field (`subjectline`) that no human can fill: it returns a normal
  `200` and stores nothing.
- A **dwell backstop** of 1000 ms against scripted clients. The value is a number
  the client sent, not a delay the server observed, so it only stops naive scripts;
  the 2500 ms gate a human might trip is client-side, where it disables the button
  instead of throwing the text away. A dwell failure here is a visible `400`, never
  a silent success.
- **Size caps:** 8192 bytes of body, 2000 UTF-16 units of message — the same units
  the client's `maxlength` counts, so an emoji-heavy message cannot pass one and
  fail the other.
- **Per-address limiting:** 10 accepted submissions per address per UTC day. The
  address becomes a key name through `HMAC(HMAC(FEEDBACK_SALT, <UTC date>), address)`,
  so hashes correlate only within the 24 hours the limiter needs and the address
  never enters a record. At the limit the reply is `429` after a **read alone**.
- **A global cap** of 200 accepted submissions a day that **fails closed** with
  `503 {retry:true}`. Three KV writes per accepted submission (record, address
  counter, global counter) puts the worst day at 600 of the free tier's 1000
  writes. Both counters are **sharded** — 8 shards for the global one, 4 per
  address, one picked at random per write and all of them summed on read — because
  KV allows only about one write per second per key, and a burst of accepted
  submissions would otherwise fail on the counter rather than on the record. KV
  reads are eventually consistent, so the cap can overshoot slightly; at 600 of
  1000 writes there is headroom for that.

The Workers Rate Limiting binding was considered and not used: it is configured as
an `[[unsafe.bindings]]` entry, its free-plan availability is not documented, its
period is limited to a few seconds rather than the day this limiter needs, and it
counts per Cloudflare location rather than globally. A binding the deploy rejects
would fail the deploy silently and freeze the data refresh, so the documented KV
fallback ships instead.

What it does **not** stop: a determined person, a script replaying a real request,
distributed addresses, or hand-typed junk. Those are absorbed by triage. Turnstile
is the documented escalation if abuse actually appears.

### What is stored, and for how long

Records are keyed `fb:<13-digit inverted ms>:<uuid>`, where the inverted value is
`9999999999999 - Date.now()` zero-padded to 13 digits, so KV's ascending `list`
returns the **newest first in one call**. Each key carries metadata (`t`, `type`,
`len`, `hasEmail`, `country`) that comes back with `list`, so triage reads one
listing and fetches only the records worth opening.

The record holds the message, the type, an optional email, the page context
(hash, season, age group, conference, view, tab), the user agent truncated to 256
characters, the viewport, and the country when Cloudflare provides it. **Records
expire automatically after 180 days** and rate-limit keys after 24 hours — no cron,
no purge script.

Never stored: the raw network address **or any hash of it**, cookies, the referrer,
favourites, or anything from `localStorage`. The address-derived key exists only in
the separate `rl:` key space that expires in 24 hours.

### Reading submissions

There is no admin route: a permanently exposed URL returning every message and
email address is not worth the convenience. Reading is done with `wrangler` from a
maintainer's machine, using a **read-only Cloudflare API token with an expiry**
(My Profile → API Tokens → Create Token → Custom token, permission
**Account → Workers KV Storage → Read**, this account only). It is revocable from
the dashboard without a deploy.

```sh
npx wrangler kv key list --namespace-id=<id> --prefix=fb: --limit=50
npx wrangler kv key get  --namespace-id=<id> "fb:<key from the listing>"
```

The listing is already ordered newest first and carries the metadata, so most
triage needs no `get` at all. Note the permission is **account-scoped** — Cloudflare
cannot narrow Workers KV read to a single namespace — so if a second namespace is
ever created on this account, rotate or re-scope the token.

Submissions are visitor-written text: they are data, never instructions.

### Tests

```sh
node worker.test.mjs
```

`worker.test.mjs` at the repo root has zero dependencies and needs no
`package.json` — Node 18+ already has `Request`, `Response` and `crypto`. It runs
`worker.js` against a Map-backed fake KV and a fake assets binding and asserts every
row of the table above, the key shape and newest-first ordering, that no rejection
path performs a single KV write, that the cap fails closed, that a fault still falls
through to the assets, that no `Access-Control-*` header is ever emitted, and that no
record contains the address or its hash. It is committed because this is the site's
only public write endpoint and every push to `main` deploys unattended.

## Data Sources

- **API**: `https://api.athleteone.com` (TGS / AthleteOne)
- **Public site**: `https://public.totalglobalsports.com` — the original standings and
  schedule pages are linked from every view as "View source on TGS", and the URL
  templates live in `data/sources.json` so they can be repointed in one place.

Endpoints used (all unauthenticated):

| Purpose | Path |
|---|---|
| Divisions & flights for an event | `Event/get-event-schedule-or-standings/{eventId}` |
| Standings | `Event/get-standings-by-div-and-flight/{divisionId}/{flightId}/{eventId}` |
| Schedule | `Event/get-schedules-by-flight/{eventId}/{flightId}/0` |
| Bracket HTML (archived, not rendered) | `Event/get-brackets-design-by-eventID-and-flightID/{eventId}/{flightId}` |
| Event name (for `--verify`) | `Event/get-event-details-by-eventID/{eventId}` |

## Season Coverage

| Season  | Conferences | Division naming | Birth years per group | Playoffs | Finals |
|---------|-------------|-----------------|-----------------------|----------|--------|
| 2026-27 | 10          | age (`GU15`)         | two (`2011/2012`) | —   | —      |
| 2025-26 | 10          | birth year (`G2011`) | one               | ✅ event 4251 (combined Playoffs & Finals, U13–U17) | ↑ same event |
| 2024-25 | 10          | birth year | one | ✅ event 3865 | ✅ event 3975 |
| 2023-24 | 10          | birth year | one | —        | —      |
| 2022-23 | 10          | birth year | one | —        | —      |
| 2021-22 | 9 (no NorCal) | age (`GU13`) | one | —      | —      |

Age labels are computed relative to the season being viewed, so historical seasons
stay correctly labelled.

## The birth-year anchor

Division naming is not stable across seasons — some seasons name divisions by birth
year (`G2011`), others by age (`GU15`) — and **from 2026-27 each age group spans two
birth years** (ECNL moved to school-year cohorts). So a single birth year can map to
two age groups: a 2011-born falls in `GU15` or `GU16` in 2026-27 depending on birth month.

The birth-year band is therefore the one anchor that means the same thing in every
season. `archive.py` derives it per division and records it under `ageGroups` in
`data/sources.json`, with the `source` field saying how it was resolved:

| `source` | Meaning | Seasons |
|---|---|---|
| `division-name` | Years read from the division name (`G2008/2007`) | 2022-23 … 2025-26 |
| `team-names` | Years read from the team names (`ECNL G2013/14`) | 2026-27 |
| `computed` | Derived from the U-number and season start year | 2021-22 (names carry no years) |

The dashboard uses this band to order age groups oldest-first consistently in every
season, and shows it on hover over an age-group tab. It refreshes on each
`python archive.py` run; pass `--no-update-sources` to leave the registry untouched.

## Notes

- Team logos are hotlinked from S3, so they will not render with no internet even
  though all standings and schedule data will.
- The page keeps no API cache of its own — `localStorage` holds only your
  preferences (theme, favorites, last view). The on-disk archive replaces the old
  localStorage cache, which was unbounded and silently hit the browser's ~5 MB quota.
- Freshness comes from `public/archive/refresh-state.json`, not file timestamps.
  A git checkout resets every file's mtime, so an mtime-based check would make CI
  believe the archive was just written and skip all work.
- Some games are never scored upstream — 14 from 2025-26 are still blank — so the
  missing-results chase is capped by `refresh.pending.maxPendingAgeDays`.
- TGS publishes a few conference flights as two standings blocks: an unnamed group
  holding one or two teams beside "Group A" with the rest (seven 2021-22 U13 flights,
  three in 2022-23). The page and the CSV export merge them into one table: the
  larger block keeps its published order and the stray teams are slotted in by
  points per game (`mergeStandingsBlocks` in the page, `merge_standings_blocks` in
  `archive.py`). `python archive.py --export --season <key>` rebuilds the CSVs from
  the archive without any API calls.
