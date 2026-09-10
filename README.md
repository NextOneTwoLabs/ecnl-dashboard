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
- **Send feedback** — A panel at the foot of the sidebar posts a message (and an optional reply
  address) to the site's own Cloudflare Worker; see [Feedback](#feedback)
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
If junk appears, the free plan includes one WAF rate-limiting rule per account; match `/api/*` so
the one rule covers both sites.

## Layout

| Path | What it is |
|---|---|
| **`public/`** | **Everything the site serves** — Pages output dir and local server root |
| `public/index.html` | The whole app — HTML, CSS and JS in one file |
| `public/favicon.svg` | The NextOneTwo badge mark alone (no wordmark text) — browser-tab icon and the mark in the page header; byte-identical to the entrance site's |
| `public/badge.svg` | The owner's full badge, mark plus wordmark — committed as the source the two badge PNGs are regenerated from; byte-identical to the entrance site's |
| `public/apple-touch-icon.png` | The full badge at 180×180 — iOS home-screen icon; regenerated by hand from `badge.svg`, no build step |
| `public/og.png` | The full badge centred on black at 1200×630 — link-preview card; regenerated by hand from `badge.svg`, no build step |
| `public/favicon-180.png` | The mark alone at 180×180, transparent — Safari ignores SVG favicons, so this is the PNG tab icon; rendered from `favicon.svg` at 720×720 and downscaled, no build step |
| `public/data/sources.json` | Season → conference → event ID registry, refresh policy, birth-year anchor |
| `public/archive/api/…` | Raw API responses keyed by endpoint path — what the site reads |
| `public/archive/match-days.json` | Fixture calendar that drives the refresh schedule |
| `public/archive/refresh-state.json` | When the data was last refreshed (powers "Updated 3h ago") |
| `public/archive/manifest.json` | Index tying event IDs back to season/conference/flight |
| `archive.py` | Crawler: match-day refresh, bulk backfill, CSV exports, `--verify` |
| `ecnl_api.py` | Shared API/archive helpers |
| `proxy_server.py` | Local static server, plus the `?live=1` API proxy |
| `export/<season>/<conf>/` | CSVs — not published; `*.standings.csv`, `*.schedule.csv` |
| `worker.js` | Redirects the `workers.dev` hostname, and handles `POST /api/feedback` |
| `wrangler.toml` | Cloudflare Workers config: the `public/` assets and the `FEEDBACK` KV binding |
| `.github/workflows/refresh.yml` | The 2-hourly scheduled refresh |
| `ecnl-standings.html` | Deprecated first version, kept for reference |

## Deploying

The site is a Cloudflare Worker serving static assets (`wrangler.toml` at the repo
root: `[assets] directory = "./public"`, plus a small `worker.js` that redirects the
`workers.dev` hostname and handles `POST /api/feedback`). It is built by Cloudflare's Git integration
on the **NextOneTwoLabs** Cloudflare account: repository `NextOneTwoLabs/ecnl-dashboard`,
branch `main`, build command empty, deploy command `npx wrangler deploy`. Pushing to
`main` — including the scheduled data commits — redeploys.

- **Canonical URL:** `https://ecnl.nextonetwo.com` — a custom domain attached to the
  Worker (the `nextonetwo.com` zone lives in the same Cloudflare account, so DNS and
  the certificate are managed automatically).
- `https://ecnl-dashboard.nextonetwolabs.workers.dev` permanently redirects there
  (`worker.js`, which runs ahead of the assets for `/` and `/api/*` only, so page views
  cost one Worker request and every other file is a free static asset).
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
A plain `python -m http.server` in `public/` serves the page fine, but `/api/feedback`
404s there — expected.

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
