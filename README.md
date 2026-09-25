# ECNL Girls Conference Standings Dashboard

A standings **and schedule** dashboard for ECNL (Elite Clubs National League) Girls
conferences — a single static HTML page over a self-refreshing local archive of the data.

Everything is mirrored to disk, so the dashboard keeps working from local files if the
upstream API or website ever goes away.

## Features

- **Conference Standings** — All 10 ECNL conferences across 7 seasons (2020-21 through 2026-27), per-flight tables
- **Matches** — Date-grouped match cards per conference: kickoff, both teams, score, venue. Opens on upcoming matches, with Results (newest first) and Full season (scrolled to the next match day) a click away
- **Team at a glance** — Click any team in a standings table: position, points, recent form, next match, last result and more statistics in a side panel, with a Follow button and a link to the full team page
- **Archived data API** — a thin Worker serves collected JSON through a stable `/api/v1` contract; the Python server supports offline local browsing
- **Self-refreshing** — a scheduled job updates the data on match days and keeps the fixture calendar current
- **CSV exports** — Human-readable standings and schedule tables under `export/`, openable in Excel
- **Playoffs & Finals** — National post-season per age group and competition (Champions League, North American Cup, Showcase Cup, Showcase Games): knockout brackets drawn as trees, cup and consolation brackets, group tables where a group stage exists, round-tagged schedules, and a format note per competition
- **★ My Teams** — Follow any team; each favorite opens a summary page: the glance panel, the full table with the team highlighted, the team's own fixtures and results, and its post-season games when it played any
- **One team search** — Find a team across every age group and conference in the current season; a result opens it on its conference page with the age group and team selected
- **Age group navigation** — Tabs populated from the API; keyboard arrow-key navigation, `/` to search
- **Dark mode**, and **deep links** (season, age group, conference, view, selected team and match filter in the URL hash)
- **Send feedback** — A panel at the foot of the sidebar posts a message (and an optional reply
  address) to the site's own Cloudflare Worker; see [Feedback](#feedback)
- **Data explained** — Standings state that the order is as published by TGS (points per game, then goal difference), the header shows when the data was observed, and every view links to its source page on TGS

## How it works

`archive.py` pre-fetches upstream responses into `public/archive/api/**.json`.
The browser requests `/api/v1` on the same hostname. The Worker maps each request
to one archived asset and streams it without parsing or preloading the archive.
A scheduled GitHub Action keeps those files current; normal page requests never
contact the upstream API. The [v1 contract](docs/data-api.md) is the boundary
between collection and presentation.

`public/` remains the frontend and bundled-data directory. There is no frontend
build step. Worker, UI, and data still deploy together on every main commit,
including data-only refresh commits. Direct external visitor access to `/archive/` and
`/data/` is blocked at the edge Worker and local server; the frontend reads
exclusively through `/api/v1`.

`/api/v1` is free and rate-limited (#90). The page gets a signed session cookie from `/`,
and sessions get 300 requests a minute. Direct use (scripts, agents, other servers) needs
an API key that the owner issues (#93): `Authorization: Bearer <key>`, 120 requests a minute
per key. Ask for one through the site's **Send feedback** panel with a reply address; see
[API keys](docs/data-api.md#api-keys). A request with neither a key nor a cookie is not
refused outright: it gets a small per-IP allowance (for browsers without cookies), then a
429 that points to keys. **For scrapers, day 1 changes nothing:** keyless scripts still get
120 a minute (60 after #92), and scripts that keep the cookie get 300. Keys are a sanctioned,
visible and revocable path, not a lock. See
[Sessions and rate limits](docs/data-api.md#sessions-and-rate-limits).

## Run it locally

```bash
python proxy_server.py --offline    # archive-only API and frontend on port 5000
npx wrangler dev                    # actual Worker, assets, and local feedback KV
```

The Python server runs with sessions off: no cookie, no rate limits, and every
`/api/v1` answer says `X-ECNL-Session: off`, as the Worker does without its secret. It
checks no API keys: an `Authorization` header changes nothing locally.

Open the address printed by the server. A plain static HTTP server or opening
`public/index.html` directly cannot serve `/api/v1` and no longer supports the
full default application.

For explicit upstream debugging, run `python proxy_server.py` and open
`http://localhost:5000/?live=1`. Only this mode uses the legacy live proxy;
reconstructed schedules remain protected from upstream replacement. V1 routes
always read the local archive, even when the server is not in offline mode.

## Validate changes

```bash
node --import ./tests/netguard/netguard.mjs --test tests/data-api.test.mjs tests/session.test.mjs tests/apikey.test.mjs tests/apikey-tool.test.mjs tests/netguard.test.mjs  # Node 22+
PYTHONPATH=tests/netguard HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
  python -m unittest discover -s tests -p 'test_*.py'
python reconstruct.py --check
```

The API contract workflow runs these checks on pull requests and main commits.
No test may reach the network: `tests/netguard/sitecustomize.py` (Python) and
`tests/netguard/netguard.mjs` (Node, preloaded with `--import`) refuse any non-loopback
connection and fail the run at exit if anything tried, even when the code under test
swallowed the error; the dead proxy is a second layer. No npm dependencies are required.

## Refresh the data

```bash
python archive.py --refresh        # what the scheduled workflow runs
```

The refresh is **driven by the fixture calendar**, not a clock. Of 288 days in a
season only 81 have games, and 99.7% of those are Sat/Sun — so on most days there
is provably nothing to fetch:

| Run | Work done |
|---|---|
| Non-match day, no sweep due, nothing pending | **0 requests**, exits at once |
| Sweep due (first run at or after the hour) | all schedules, and the calendar |
| Match day | the flights that played, on every scheduled run |
| A past game still missing a score | that flight, on any day, until it lands |

The workflow asks for a run every two hours, but GitHub delays and drops
scheduled jobs on shared runners. Over the 57 gaps between the 58 scheduled
runs from 1 to 12 September 2026 the spread was 2.9 to 6.5 hours, mean 4.6,
median 5.0, and 27 of the 57 ran over five hours — so in practice it is
**roughly every 3 to 5½ hours**, and on a match day that is how quickly scores
appear. Those are measured figures from one snapshot rather than a guarantee:
GitHub schedules on a best-effort basis, so expect them to drift.

The daily sweep is not at risk from this. `archive.py` treats a sweep as due
once the hour is at or past the configured one (06:00 UTC) **and** the day has
not been swept yet — the `due_by_hour` / `lastSweepDate` logic in
`cmd_refresh` — rather than requiring a run to land inside a particular hour,
so a late or dropped run never skips it. Losing *every* run from 06:00 UTC
onward on a given day is the one case that does: nothing is left that day to
notice the sweep is due.

Standings are only refetched where a **result actually changed** — schedule
payloads carry scores, so a schedule fetch collects results too, and standings
cannot move unless a score did.

Useful flags:

```bash
python archive.py --refresh --sweep                    # force the all-flights sweep
python archive.py --refresh --dry-run --date 2026-09-12  # test a given day
python archive.py --season 2026-27                     # full crawl of one season
python archive.py --all                                # every season (~1,200 requests)
python archive.py --team-index --all                   # rebuild every season's team index (no API calls)
python archive.py --clubs --all                        # fetch club city/state for clubs with no entry yet
python archive.py --clubs --season 2026-27 --force     # re-check every club of one season
```

The Team at a glance card shows the club's city and state from
`public/archive/clubs.json` (served at `/api/v1/clubs`; see `docs/data-api.md`).
The refresh's daily sweep fetches clubs new in the active season, and the first
successful sweep of each calendar month re-checks all of them (121 requests);
after a failed re-check it retries at most once a week. The 22 clubs seen only in
past seasons were backfilled once with `--clubs --all` and are never re-checked.
Only city and state are stored; the rest of TGS's club record (street, zip, phone,
the club president's contacts) is never kept.

Every crawl and every `--refresh` also rebuilds the affected season's team index
(`public/archive/teams/<season>.json`, served at `/api/v1/seasons/{season}/teams`),
which lets a shared team link, My Teams and a Teams search find a team with one
request instead of reading every standings file. It is rewritten only when a row
changes. If `tests/test_team_index.py` reports it stale, run
`python archive.py --team-index --all` and commit the result.

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
by the stage name shown in the sidebar. 2020-21 through 2024-25 each had separate
`Playoffs` and `Finals` events; 2025-26 has one combined event, so its row reads
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
- `defaultTier` names the TGS flight to open first when an age group is selected, where
  TGS lists another ahead of it (the 2020-21 Finals list GU15's `Consolation` before
  `Flight 1`); without it the first flight opens.
- `dataGaps` lists flights TGS published with unreliable or incomplete data, keyed by
  flight id. Each entry carries a `note` and its `sources`, shown above the bracket and
  the schedule; `hideTgsSchedule: true` drops the "Schedule on TGS" link where there is
  no schedule page to open; `omitFromBracket` lists match ids the bracket tree leaves
  out (the Schedule view still lists them). Nothing is rebuilt — that is the
  `reconstructed` block below.

**Brackets are derived from the schedule, not from TGS's bracket HTML.** Knockout
flights have no standings, but every game carries both team IDs, scores, PK scores
and a game number. The page follows each team's lineage — losing in round *r* of a
bracket moves it into that round's losers bracket — which reproduces the main
bracket, the Champions League Cup (day-one losers) and the consolation games without
any template. A game that ended level with no PK score recorded is settled from the
next game each team plays. TGS's bracket HTML is archived for durability only.

Not included: the U18/19 National Finals is a separate TGS event (St. Louis, June)
and can be added as a second `national` entry when its event ID is known.

### Reconstructed data

TGS removed the 2024-25 National Finals schedules (event 3975) after the event: every
schedule endpoint returns an empty list and the public site shows nothing. The 35
results — five Champions League brackets, U13 to U17 — are rebuilt from ECNL's three
published recaps ([Day 1](https://theecnl.com/news/2025/7/18/ecnl-girls-national-finals-recap-day-1.aspx),
[Day 2](https://theecnl.com/news/2025/7/19/ecnl-girls-national-finals-recap-day-2.aspx),
[Champions crowned](https://theecnl.com/news/2025/7/22/ecnl-girls-national-finals-recap-champions-crowned.aspx))
by `reconstruct.py`. `reconstructed/2024-25-finals-3975.csv` is the human-readable
source of truth, one line per game with its recap URL; the script turns it into five
archive files shaped exactly like a real schedule response (the 41 keys of a real
record plus `source` and `reconstructed: true`), taking division and flight ids from
the archived hierarchy and each team's id, name, club and logo from the same season's
conference standings — so a team's name here equals its name everywhere else on the
site, which My Teams relies on. What the recaps do not publish is left null and said
so on the page: kick-off times, fields, and which side was home — the winner is listed
first. The finals date, 21 July, comes from the archived event-details response.

`archive.py` and `proxy_server.py` never overwrite these five paths — the log says
`protected (reconstructed): … not overwritten` and the archived copy is used instead,
even under `?live=1` — unless `--force-reconstructed` is passed (`--force` alone does
not imply it). The scheduled refresh runs `python reconstruct.py --check` before it
commits, which asserts the brackets are internally consistent: 7 games and 8 teams per
flight, semifinalists are the quarterfinal winners and finalists the semifinal winners,
the five expected champions, PK scores exactly on draws, dates by round, every name
equal to its conference-standings name with the flight's age suffix, and for U14–U17
the eight quarterfinalists equal the eight last-day winners of the Playoffs event by
team id. The 41-key shape is compared against one pinned past-season archive file
(`3865/32795`, the 2024-25 U17 Playoffs), never against a file the refresh rewrites.
The trade-off is deliberate: a failing check blocks the data commit so a broken
reconstruction can never be published, which also means a check failure for any
reason pauses data updates until someone looks at the workflow run. To regenerate
after editing the CSV: `python reconstruct.py reconstructed/2024-25-finals-3975.csv`,
then `python reconstruct.py --check`.

The honest limit: the check can prove the right teams advanced, but not a score. A
wrong score with the right winner cannot be caught, and for four of the five finals
the score rests on a single sentence of ECNL prose (the U17 final is corroborated by
Real Colorado's own club page). The Day 1 recap itself contradicts its own score list
in one place, which is why the Playoffs cross-check exists.

## My Teams

Favorites are stored in the browser (`localStorage`) as records — the team name plus
the IDs that locate it (`eventID`, `divisionID`, `flightID`, `teamID`) — captured from
the standings row when the ★ is clicked. A favorite therefore belongs to one team in
one season; clicking it switches the season selector to that season. Favorites saved
by the earlier version (name only) are located through each season's team index (or,
without one, by scanning the archived standings) the first time My Teams is opened,
and upgraded in place.

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

## Feedback

The **Send feedback** panel at the foot of the sidebar posts JSON to `POST /api/feedback`, handled
by `worker.js` (the same Worker that serves the site). It writes one key per submission into the
`FEEDBACK` KV namespace:

    key:      <sent, ISO 8601>-<8 random hex characters>
              e.g. 2026-09-10T18:04:21.512Z-9f3ac1b2
    value:    { "sent": "<ISO 8601>", "message": "<what the visitor typed>",
                "email": "<optional>", "hash": "<the URL hash the visitor was on>" }
    metadata: { "email": "<the same address, or null>" }

`email` and `hash` are left out of the value entirely when empty. The email cannot be the key: it
is optional and not unique. The timestamp prefix makes a key listing come back in chronological
order and readable by eye; the random suffix keeps two submissions in the same millisecond apart.
The address is repeated as key metadata so a listing shows the date and whether there is a reply
address without fetching every record. `hash` is the deep link the visitor was looking at
(`#season=2026-27&age=GU16&conf=NorCal`), so "the standings look wrong" says which standings.

**Records expire after 180 days.** Each `put` carries an `expirationTtl`, so KV deletes the record
by itself — there is no cron job and no manual cleanup. **We don't offer per-message deletion**, and
the panel says so: nothing automates a request. A specific record can still be removed by hand with
`npx wrangler kv key delete <key> --binding FEEDBACK --remote` — a key listing prints the reply
address as metadata, so an emailed record is findable — but that is a manual, unadvertised path.

**The message is free text.** It can contain anything a visitor chooses to type, including a name,
a club, a player, or contact details the site never asked for and cannot validate. It is stored in
plain text, readable by anyone with Cloudflare dashboard or `wrangler` access. Nothing else about
the visitor is stored: no IP address, no user agent, no country, no viewport.

### Reading submissions back

    npx wrangler kv key list --binding FEEDBACK --remote
    npx wrangler kv key get "2026-09-10T18:04:21.512Z-9f3ac1b2" --binding FEEDBACK --remote

or in the Cloudflare dashboard under **Storage & Databases → KV**, where the namespace is listed
as `ECNL_FEEDBACK` (the binding is `FEEDBACK`; the title differs). Keys are not guessable, so
reading feedback back is list-then-get, one call per submission — it is storage, not an inbox.

> **A listing prints the metadata, so it prints every reply email.** Never paste a `kv key list`
> output, or a screenshot of one, into a public issue, a PR, or a commit message.

Add `--local` instead of `--remote` to read the simulated namespace that `npx wrangler dev` writes
on your own machine.

### Spam and limits

A hidden honeypot field (`hp-note` — the name is deliberately odd, because browser address autofill
ignores `autocomplete="off"` and fills anything called `website`, which would silently drop a real
visitor's message) drops the crudest bots, the message is capped at 2,000 characters and the
request body at 8 KB. Those bound each write, not how many arrive. **KV writes on the free plan are
capped at 1,000 a day for the whole Cloudflare account**, and that budget is shared with the
sibling site's waiting list — a flood of feedback here would break signups on `nextonetwo.com` too.
The free plan includes one WAF rate-limiting rule per zone (both sites share the `nextonetwo.com`
zone), and it is now recommended for the
data API (path starts with `/api/v1/`; see [The Workers Free quota](docs/data-api.md#the-workers-free-quota)).
If feedback junk appears too, the owner chooses: widen that rule to `/api/` (it would then also
cover the sibling site's `/api/*`, since the rule has no hostname field) or move to a paid plan.

## Layout

| Path | What it is |
|---|---|
| **`public/`** | **Everything the site serves** — Pages output dir and local server root |
| `public/index.html` | The whole app — HTML, CSS and JS in one file |
| `public/favicon.svg` | The NextOneTwo badge mark alone (no wordmark text) — browser-tab icon and the mark in the page header; byte-identical to the entrance site's |
| `public/badge.svg` | The owner's full badge, mark plus wordmark — kept as the source the two badge PNGs can be regenerated from; byte-identical to the entrance site's |
| `public/apple-touch-icon.png` | The full badge at 180×180 — iOS home-screen icon; copied from the entrance site, no build step |
| `public/og.png` | The full badge centred on black at 1200×630 — link-preview card; copied from the entrance site, no build step |
| `public/favicon-180.png` | The mark alone at 180×180, transparent — Safari ignores SVG favicons, so this is the PNG tab icon; rendered from `favicon.svg` at 720×720, downscaled and quantised to a 144-colour palette, no build step |
| `public/data/sources.json` | Season → conference → event ID registry, refresh policy, birth-year anchor (read via `/api/v1/catalog`) |
| `public/archive/api/…` | Raw API responses keyed by endpoint path — read internally by the v1 storage adapter; direct external access blocked |
| `public/archive/match-days.json` | Fixture calendar that drives the refresh schedule |
| `public/archive/refresh-state.json` | When the data was last refreshed (powers "Updated 3h ago"; read via `/api/v1/status`) |
| `public/archive/manifest.json` | Index tying event IDs back to season/conference/flight |
| `public/archive/teams/<season>.json` | Per-season team index, derived from the archived hierarchies and standings by `archive.py` (read via `/api/v1/seasons/{season}/teams`; see `docs/data-api.md`) |
| `public/archive/clubs.json` | Club city and state for every season's clubs (`null` when TGS lists none), derived by `archive.py` from TGS's club records, keeping nothing else (read via `/api/v1/clubs`; see `docs/data-api.md`) |
| `archive.py` | Crawler: match-day refresh, bulk backfill, CSV exports, `--verify` |
| `ecnl_api.py` | Shared API/archive helpers |
| `proxy_server.py` | Local static and archive-only v1 server, plus the `?live=1` API proxy |
| `reconstruct.py` | Rebuilds schedules TGS removed from a hand-entered CSV; `--check` validates them (see "Reconstructed data") |
| `reconstructed/` | The CSVs behind the reconstructed archive files — one line per game, with its source URL |
| `export/<season>/<conf>/` | CSVs — not published; `*.standings.csv`, `*.schedule.csv` |
| `worker.js` | Redirects the `workers.dev` hostname, blocks raw data paths, sets the session cookie on `/`, and handles `/api/v1/*` and `POST /api/feedback` |
| `api/session.mjs` | Session cookie, rate limits and counts for `/api/v1/*` (see `docs/data-api.md`, "Sessions and rate limits") |
| `api/apikey.mjs` | API keys for direct use of `/api/v1/*`: format, hash check, key-in-URL check, cached KV lookup (see `docs/data-api.md`, "API keys") |
| `tools/apikey.mjs` | The owner's key tool: issues a key, prints the wrangler commands to store, list, show, revoke or purge its record (self-contained, no network) |
| `wrangler.toml` | Cloudflare Workers config: the `public/` assets, the `FEEDBACK` and `API_KEYS` KV bindings, the four rate limiters and the `API_EVENTS` Analytics Engine dataset |
| `.gitattributes` | Pins the image assets (`*.svg`, `*.png`) as binary, so the files copied from the entrance site stay byte-identical across checkouts instead of being line-ending converted |
| `.github/workflows/refresh.yml` | The scheduled refresh — asks for every 2 h, measured at 3 to 5½ |
| `ecnl-standings.html` | Deprecated first version, kept for reference |

## Deploying

The site is a Cloudflare Worker serving static assets (`wrangler.toml` at the repo
root: `[assets] directory = "./public"`, plus a small `worker.js` that redirects the
`workers.dev` hostname, blocks raw data paths, and handles `/api/v1/*` and `POST /api/feedback`). It is built by Cloudflare's Git integration
on the **NextOneTwoLabs** Cloudflare account: repository `NextOneTwoLabs/ecnl-dashboard`,
branch `main`, build command empty, deploy command `npx wrangler deploy`. Pushing to
`main` — including the scheduled data commits — redeploys.

- **Canonical URL:** `https://ecnl.nextonetwo.com` — a custom domain attached to the
  Worker (the `nextonetwo.com` zone lives in the same Cloudflare account, so DNS and
  the certificate are managed automatically).
- `https://ecnl-dashboard.nextonetwolabs.workers.dev` permanently redirects there
  (`worker.js`, which runs ahead of the assets for `/` and `/api/*` only, so page views
  and API calls invoke the Worker; other assets are served directly).
- `https://ecnl-dashboard.zhenyisx.workers.dev` — the original address — also
  redirects there, served by the tiny Worker in [`redirect/`](redirect/) from the
  original personal account.

Deep-link `#` fragments survive both redirects.

The `workers.dev` subdomain belongs to the Cloudflare account, not to GitHub — moving
the repository between GitHub owners does not change the URL, but Cloudflare's GitHub
App must be installed on the new owner for builds to continue.

**Feedback KV namespace.** The namespace already exists on the NextOneTwoLabs account and its
real id is in `wrangler.toml`, so there is nothing to create or paste before the first deploy.

Its title on the account is `ECNL_FEEDBACK`, not `FEEDBACK`: the account already holds a
`FEEDBACK` namespace belonging to the sibling marketing site, and two stores sharing one name
would be indistinguishable in the dashboard. The binding is still `FEEDBACK`, so `env.FEEDBACK`
in the Worker and the `--binding FEEDBACK` commands above are unaffected by the title.

To run the Worker and the panel locally, `npx wrangler dev` and open
<http://localhost:8787>. KV is simulated on your machine, so test submissions stay there.
Use `python proxy_server.py --offline` for local data browsing without Wrangler.
It does not implement feedback. A plain static server cannot serve the v1 API.

**Session secret and rate limits (#90).** The owner, not the team, sets these up:

1. Once, before the first build with these bindings: create the Analytics Engine dataset
   `ecnl_api_events` with the binding `API_EVENTS` in the Cloudflare dashboard. The first build
   of #90 failed without it (done for #90).
2. Before a preview check of the rate limits, create the secret with a value from
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (a generated
   value, never a passphrase). **Before merge, or whenever an undeployed version exists:**
   `npx wrangler versions secret put SESSION_SECRET --name ecnl-dashboard` (adds it to a new
   version without deploying; later uploads keep it), then **Retry build** on the PR's latest
   build. **Don't** add it in the dashboard's Production settings with **Deploy**, or with a plain
   `wrangler secret put`, while a PR preview is the latest version: that could deploy unmerged PR
   code. **Rotating it later, when the deployed version is the latest:**
   `npx wrangler secret put SESSION_SECRET --name ecnl-dashboard` is fine.
   Without the secret the API still works with only the per-IP
   limit, answering `X-ECNL-Session: off`; production must never say `off`. This Worker's builds
   run `wrangler versions upload` (version preview URLs), so a preview uses production's bindings
   and secrets; a version uploaded before `SESSION_SECRET` exists runs with sessions off until it
   is uploaded again (**Retry build**).
3. Before merge: confirm no other Worker on the account uses rate-limit `namespace_id`s 9001–9003.
4. After merge: the WAF rate-limiting rule (recommended on Workers Free).
5. For reports: an API token with *Account · Account Analytics · Read*.

Never enable Pseudo IPv4 "Overwrite headers", leave Bot Fight Mode off, and don't list the
secret under `[secrets] required` (a missing required secret blocks every deploy, including
the data-refresh ones). Details: [docs/data-api.md](docs/data-api.md#owner-setup-the-team-changes-none-of-this).

**API keys (#93).** The owner issues, lists and revokes keys with `tools/apikey.mjs`, in a
standalone PowerShell window (not a terminal an assistant can read). It needs only Node,
makes no network request and never runs wrangler: it prints the key once and the exact
`npx.cmd wrangler kv key ... --namespace-id 0f7cd5892944474598857af3e82bdafb --remote` commands
to run. The KV namespace `ECNL_API_KEYS` (binding `API_KEYS`) already exists and holds only a
SHA-256 hash of each key.

    node tools\apikey.mjs new --label "acme-agent"            # a project or agent name, never a person's
    node tools\apikey.mjs revoke <id> --label "acme-agent"
    node tools\apikey.mjs help                                # list, get, purge and every command

After issuing a key and running the printed commands, close the PowerShell window: the key
stays in its scrollback. Requests arrive through the **Send feedback** panel (with a reply
address); the owner sends each key by private email. The team's test key is issued per
verification round with `--ttl 604800` (7 days) and revoked after the production check.
**Before #93 is merged**, `tools\apikey.mjs` isn't in the owner's checkout: copy it pinned to
the reviewed commit (`git fetch origin claude/93-api-keys`, then `git show 5708d1d:tools/apikey.mjs |
Set-Content -Encoding ascii "$env:TEMP\ecnl-apikey-tool.mjs"`), run that copy, and **keep it
until the test key is revoked, then revoke with it** (`node "$env:TEMP\ecnl-apikey-tool.mjs"
revoke <id> --label "auditor-93"`). After merge and `git pull`, `node tools\apikey.mjs …` works
from the checkout. Details: [Issuing and revoking keys](docs/data-api.md#issuing-and-revoking-keys-owner).

**Workers Free quota.** The account is on Workers Free: 100,000 Worker requests a day, reset at
00:00 UTC, and every request to `/` or `/api/*` counts, including the Worker's own 429s. When
it runs out, `/` and `/api/*` fail for every visitor until 00:00 UTC, so a flood can take the
site down for the rest of the UTC day. The rate limits don't prevent that; the WAF rule
reduces it; Workers Paid is the only full remedy.

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
| First bracket (archived, not rendered) | `Event/get-flight-brackets-by-flight/{eventId}/{flightId}` |
| Bracket HTML (archived, not rendered) | `Event/get-brackets-design-by-eventID-and-flightID/{eventId}/{flightId}` |
| Event name (for `--verify`) | `Event/get-event-details-by-eventID/{eventId}` |
| Club city and state (city and state only; never archived raw) | `Event/get-club-info/{clubId}` |

Only the first six families are mirrored under `public/archive/api/`; the archive
writer and the local `?live=1` proxy refuse every other path, so a club profile, a
roster or an endpoint TGS adds later can never be written into the public repo.

## Season Coverage

| Season  | Conferences | Division naming | Birth years per group | Playoffs | Finals |
|---------|-------------|-----------------|-----------------------|----------|--------|
| 2026-27 | 10          | age (`GU15`)         | two (`2011/2012`) | —   | —      |
| 2025-26 | 10          | birth year (`G2011`) | one               | ✅ event 4251 (combined Playoffs & Finals, U13–U17) | ↑ same event |
| 2024-25 | 10          | birth year | one | ✅ event 3865 — U13/U14 group games and U13's round of 16 never published by TGS; U13 has group tables only, U14 its tables and round of 16 | ✅ event 3975 — reconstructed from ECNL's recaps |
| 2023-24 | 10          | birth year | one | ✅ event 3064 | ✅ event 3238 |
| 2022-23 | 10          | birth year | one | ✅ event 2719 | ✅ event 2720 |
| 2021-22 | 9 (no NorCal) | age (`GU13`; the national events say `U13`) | one | ✅ event 2436 — U15 Regional League Finals bracket corrupt at TGS (placeholder team before the final); final correct | ✅ event 2437 |
| 2020-21 | 9 (no NorCal) | age (`GU13`; the national events say `U13`, the Finals `GU13`) | one | ✅ event 2118 — Tropical Storm Elsa cut the event short: the U13 Champions League and the four U15 cups have no final and the U15 Champions League no knockout (U13 and U15 finished at the Finals); U18/U19 Composite placement rows corrupt at TGS, left out of the bracket; finals correct | ✅ event 2289 — GU15 quarterfinal and semifinal rows and GU17 semifinal rows corrupt at TGS (GU17's left out of the bracket); finals correct |

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
| `computed` | Derived from the U-number and season start year | 2020-21, 2021-22 (names carry no years) |

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
  three in 2022-23, Southwest GU13 in 2020-21). The page and the CSV export merge them into one table: the
  larger block keeps its published order and the stray teams are slotted in by
  points per game (`mergeStandingsBlocks` in the page, `merge_standings_blocks` in
  `archive.py`). `python archive.py --export --season <key>` rebuilds the CSVs from
  the archive without any API calls.
- 2020-21 had no NorCal conference: the Bay Area clubs' first ECNL season was played
  in the Northwest conference, whose divisions were split into Bay Area, Mountain and
  Pacific flights (the page shows one panel per flight). Six conferences also ran a
  `GU18/U19 Composite` division beside `GU18/U19`; the Conferences tab takes its age
  chips from the registry's `ageGroups` keys, so a division only some conferences ran
  still gets a chip (a conference without it shows "No data found").
