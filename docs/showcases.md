# Showcases

A showcase is an ECNL weekend event outside the conference season: teams from different
conferences (and some ECNL RL, Pre-ECNL and guest teams) play a few games each, and no title
is at stake. The site shows each archived showcase on the **Showcases** tab (a Results table
and a Games list per age group) and on the team page of every conference team that played in
it. Showcases were added in #97; the first is **Phoenix Spring** (TGS event 4133, 2025-26).

## How a showcase is stored

- **Registry.** `public/data/sources.json`, `seasons.<season>.showcases`, keyed by the display
  name. Required: `eventId`, `eventName` (TGS's exact name, checked by `--verify`),
  `location` (`"City, ST"`), `startDate` and `endDate` (ISO). Optional: `tierNotes` (the
  collapsible "Format" note, keyed by TGS flight name), `tierLabels`, `dataGaps`, and
  `teamAliases` with its `teamAliasesNote` (see "Team aliases").
- **Archive.** The same three mirrored endpoint families as a conference: the hierarchy, and
  per flight its standings and schedule. Showcases have no brackets, so the bracket design is
  never fetched, and the page never builds a bracket from a showcase's games. Event details
  are read by `--verify` only and never written (they carry organizer payment fields).
- **Team index.** `public/archive/teams/<season>.json` gains an optional `showcases` array: one
  row per showcase flight with the ids of the teams in its schedule, so a team page fetches
  only the showcase schedules its team played in. Its conference `teams` rows are unchanged,
  and showcase-only teams are not searchable or followable. See `docs/data-api.md`.
- **Manifest and CSVs.** The manifest entry has `"kind": "showcase"`; its CSVs go to
  `export/<season>/showcases/<name>/`. The display name is also the manifest key, so it must
  not repeat a conference or national event name of the same season (a test checks this).
  - The standings CSVs have the same columns as a conference's, but **`rank` is TGS's own
    `rank` field as published, not a position**: a showcase table is a results list (at
    Phoenix Spring TGS gives 294 rows rank 1 and 8 rows rank 2). Rows are in TGS's order,
    as on the page. A conference CSV's `rank` stays the 1-based position.
  - `python archive.py --export` rebuilds every archived showcase's CSVs from the archive
    with no requests, beside the conferences' (national events are not rebuilt by
    `--export`; a crawl writes theirs).
- **Refresh.** A showcase of the active season joins the match-day refresh only on its own
  dates (`startDate` to `endDate`, UTC days); the day's sweep then also re-reads its hierarchy.
  Before and after, it is never fetched. A showcase of a past season is never refreshed.
  Trade-off: a score TGS enters after the last UTC day is not picked up (games that end on a
  Sunday evening in the US finish after midnight UTC); the owner can allow one extra day later.

### Team aliases

TGS sometimes gives a team another id at a showcase than in its conference (at Phoenix Spring,
Utah Avalanche ECNL G11 is 112470 at the showcase and 69910 in the Northwest conference). An
alias maps the showcase id to the conference id; the page uses it for the Results table's link
and to find the team's showcase games on its page. Aliases are **declared by hand after
review**, never guessed: the candidate must have exactly the conference team's name, in the
same age group, with no other candidate, and the conference id must not itself play at the
event. `tests/test_showcases.py` re-checks every declared alias against the archive.

## Request cost

- **Onboarding** one showcase: 1 (`--verify --event <id>`) + 1 + 2 × flights (the crawl with
  `--event <id>`). Phoenix Spring has 6 flights: 14 requests. `--event <id>` (#103) needs an
  explicit `--season` and `--showcases`, and exits 2 before any request with `--all`,
  `--national`, `--conference`, `--refresh`, `--export`, `--team-index` or `--clubs`, when
  given twice, or when the id is not a showcase of that season. A 5xx is retried up to 3 times, so every budget counts HTTP
  requests, retries included: `--max-requests N` stops the run before request N + 1, and the
  crawl's summary prints the count.
- **The standard for a budgeted run is the crawler's own pace under `--max-requests`**
  (0.25 s after each fetched file, 1.5 s and then 2.25 s before a retry). With a budget set,
  the crawler prints one line per HTTP attempt, retries included:
  `request <n>/<budget>`, the UTC start time to the millisecond, the path, the status (or the
  transport error) and the bytes. **Save that printed log to the issue** as the request
  record. No other driver or logger is needed.
- **A live showcase** adds its flights to the match-day refresh on its dates: one schedule per
  flight per run, plus a standings request when a score changed.
- **On the site (Workers):** a cold Showcases link costs 6 requests; another age group 2;
  Results and Games switch with none. A team page in a season with showcases reads that
  season's team index once per session (one extra request on a My Teams page, where the index
  was not needed before), plus one schedule per showcase flight the team played in.

## Onboarding a showcase

| # | Who | Step | TGS requests |
|---|---|---|---|
| 0 | TPM (from an owner-approved list, or the owner names one) | File one issue per event, or one per season batch: "Onboard showcase <name> (TGS <id>)" | 0 |
| 1 | SWE | **Identify:** event details and hierarchy give the TGS name, dates, place, divisions, flights, team counts and girls-only status. The season is the one whose August-to-July span holds the dates, cross-checked against the division naming | 2 |
| 2 | SWE | **Registry edit:** one hand-written hunk under `seasons.<S>.showcases` (display name, `eventId`, exact `eventName`, `location` "City, ST", ISO `startDate`/`endDate`, optional `tierNotes`/`dataGaps`). Never re-serialize `sources.json` | 0 |
| 3 | SWE | `python archive.py --verify --season <S> --showcases --event <id> --max-requests 2` → one OK line, for this showcase only; save its printed request line to the issue. Without `--event`, verify and the crawl act on every showcase of the season | 1 |
| 4 | SWE | `python archive.py --season <S> --showcases --event <id> --dry-run` → one "would archive" line, then the crawl: `python archive.py --season <S> --showcases --event <id> --no-update-sources --max-requests <1 + 2 × flights + a small margin>`, at the crawler's own pace. Only this showcase's paths are fetched and only its manifest entry is written (plus `updated`); the team index is still rebuilt for the whole season. Save its printed request log (one line per attempt) to the issue | 1 + 2 × flights |
| 5 | SWE, offline under the netguard | The team index's `teams` rows unchanged and its `showcases` rows added; manifest +1 entry (and its `updated` stamp); blast radius = the event's archive paths, its export folder, `teams/<S>.json` and the manifest; `reconstruct.py --check`; the Python and Node suites; `--refresh --dry-run --date <a day inside and outside the event>` | 0 |
| 6 | SWE, offline | **Data audit:** placeholder dates, null sides, unscored past games, `gamenumber`, TGS `rank`, standings block count, teams with no conference row. **Name check:** the display name is unique among the season's conferences, national events and showcases (`tests/test_showcases.py`). **Alias review:** list showcase teams whose exact name matches a conference team with another id in the same age group; declare each confirmed one in `teamAliases` with a `teamAliasesNote` naming the evidence. Anything odd goes into `tierNotes` or `dataGaps`, with a source | 0 |
| 7 | SWE, offline browser | Every age group (Results and Games), "no team page" only on rows with none, one attendee team page, 390 px, dark mode; no console errors | 0 |
| 8 | SWE → Reviewer | Pull request; the Reviewer re-fetches a sample for provenance (at most 1 + 2 × flights, retries counted) | ≤ 1 + 2 × flights |
| 9 | **Owner** | Approves the display name and any note; merges | 0 |
| 10 | Auditor | Checks the Cloudflare preview before merge and production after the deploy | 0 TGS |
| 11 | Nobody | A live showcase refreshes itself on its dates and is frozen afterwards; a past one is never re-fetched | automatic |

Discovery of other showcases (which events exist, with their TGS ids) is deferred by the
owner; it needs its own issue and request budget.
