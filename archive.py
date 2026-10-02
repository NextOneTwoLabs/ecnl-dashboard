"""
ECNL Dashboard archiver (zero-dependency).

Crawls the events listed in public/data/sources.json and writes:
  public/archive/api/<endpoint-path>.json   raw API mirror (what the site serves)
  public/archive/match-days.json            fixture calendar driving the refresh
  public/archive/refresh-state.json         when data was last refreshed
  public/archive/teams/<season>.json        per-season team index (derived, #81)
  public/archive/clubs.json                 club city and state (derived, #87)
  public/archive/history/<teamID>.json      one squad across seasons and events (derived, #107)
  export/<season>/<conference>/*.csv        human-readable standings & schedules
  export/<season>/showcases/<showcase>/*.csv  the same for a showcase (#97)
  public/archive/manifest.json              index tying event IDs to season/conference

Scheduled use (what the GitHub workflow runs every 2h):
    python archive.py --refresh               match-day driven; no-ops on quiet days
    python archive.py --refresh --sweep       force the all-flights schedule sweep
    python archive.py --refresh --dry-run --date 2026-09-12    test a given day

Manual/bulk use:
    python archive.py --verify --all          check every event ID resolves
    python archive.py --season 2026-27        full crawl of one season
    python archive.py --all                   every season (~1200+ requests)
    python archive.py --all --force           ignore the freshness check
    python archive.py --season 2025-26 --showcases --max-requests 20
                                              only the season's showcases, at most
                                              20 HTTP requests, retries included
    python archive.py --season 2025-26 --showcases --event 4133 --verify --max-requests 2
    python archive.py --season 2025-26 --showcases --event 4133 --dry-run
    python archive.py --season 2025-26 --showcases --event 4133 --max-requests 16
                                              one showcase only (#103): --event <id>
                                              needs --season and --showcases; without
                                              --event, verify and the crawl act on every
                                              showcase of the season. The team index is
                                              still rebuilt for the whole season; only
                                              this showcase's manifest entry is written
    python archive.py --team-index --all      rebuild every season's team index
                                              from the archive (no API calls)
    python archive.py --team-history          rebuild every team's history file (#107)
                                              from the archive (no API calls); with
                                              --check, write nothing and fail on drift
    python archive.py --clubs --all           fetch the city and state of every club
                                              with no entry yet (--force: re-check all)

Schedules reconstructed by reconstruct.py (listed under `reconstructed` in
sources.json) are never re-fetched or overwritten unless --force-reconstructed
is passed; the archived copy is used instead.
"""

import argparse
import csv
import datetime
import json
import os
import re
import sys
import time
import traceback
import unicodedata

import ecnl_api as api

# Skip re-fetching anything archived more recently than this, unless --force.
FRESH_SECONDS = 12 * 3600
# Politeness delay between API calls.
DELAY = 0.25
# Reconstructed schedules (ecnl_api.protected_paths) are never re-fetched or
# overwritten unless --force-reconstructed is passed. --force is routine and
# does not imply it.
FORCE_RECONSTRUCTED = False


class Stats:
    def __init__(self):
        self.fetched = 0
        self.skipped = 0
        self.failed = 0
        self.errors = []

    def fail(self, msg):
        self.failed += 1
        self.errors.append(msg)


def get_json(path, stats, force):
    """Fetch an API path, archive the raw bytes, return parsed JSON.

    Uses the archived copy when it is fresh and --force was not passed, and
    always for a reconstructed path unless --force-reconstructed was passed —
    so the manifest and CSV export rebuild from the reconstruction, not from
    the empty live response.
    """
    protected = api.read_archive_protected(path) if not FORCE_RECONSTRUCTED else None
    if protected is not None:
        stats.skipped += 1
        return protected

    age = api.archive_age_seconds(path)
    if not force and age is not None and age < FRESH_SECONDS:
        raw, _ = api.read_archive(path)
        if raw:
            stats.skipped += 1
            return json.loads(raw)

    raw = api.fetch_api_raw(path)
    data = json.loads(raw)  # validate before writing
    api.write_archive(path, raw, allow_protected=FORCE_RECONSTRUCTED)
    stats.fetched += 1
    time.sleep(DELAY)
    return data


# ---------- CSV export ----------

STANDINGS_COLUMNS = [
    "rank", "team", "club", "teamID", "gp", "w", "l", "d",
    "pts", "ppg", "gf", "ga", "gd",
]

SCHEDULE_COLUMNS = [
    "date", "time", "type", "homeTeam", "homeScore", "awayScore", "awayTeam",
    "complex", "venue", "status", "matchID",
]


def standings_rows(teams, kind="conference"):
    """CSV rows in table order. `rank` is the 1-based position, except for a showcase
    (#97): its table is a results list, not a ranking, so `rank` is TGS's own `rank`
    field as published (1 on most rows at Phoenix Spring, 2 on some), never a position
    the site would have invented."""
    rows = []
    for i, t in enumerate(teams):
        rows.append({
            "rank": t.get("rank") if kind == "showcase" else i + 1,
            "team": t.get("name"),
            "club": t.get("clubName"),
            "teamID": t.get("teamID"),
            "gp": t.get("gp"),
            "w": t.get("wins"),
            "l": t.get("losses"),
            "d": t.get("draws"),
            "pts": t.get("standingpoints"),
            "ppg": t.get("ppg"),
            "gf": t.get("goalsfor"),
            "ga": t.get("goalsagainst"),
            "gd": t.get("goaldifferential"),
        })
    return rows


def merge_standings_blocks(payload):
    """A flight's standings as one list of teams.

    TGS occasionally publishes a conference flight as two blocks: an unnamed
    group (flightGroupID 0) holding one or two teams beside "Group A" with the
    rest — seven 2021-22 U13 flights and three in 2022-23. The largest block
    keeps its published order; every other block's teams are slotted in by
    points per game (then goal difference, goals for), after any published team
    with the same key. PPG never increases down a published table, so the
    insertion is faithful; a full re-sort would not be, because TGS's own
    tie-breaks aren't reproducible from the stats it publishes.
    Mirrors mergeStandingsBlocks() in public/index.html.
    """
    blocks = payload if isinstance(payload, list) else ([payload] if payload else [])
    live = [b for b in blocks if isinstance(b, dict) and b.get("teamStandings")]
    if not live:
        return []
    main = max(live, key=lambda b: len(b["teamStandings"]))
    merged = list(main["teamStandings"])

    def key(t):
        return (-(t.get("ppg") or 0), -(t.get("goaldifferential") or 0), -(t.get("goalsfor") or 0))

    for b in live:
        if b is main:
            continue
        for t in b["teamStandings"]:
            k = key(t)
            i = next((j for j, m in enumerate(merged) if k < key(m)), len(merged))
            merged.insert(i, t)
    return merged


def schedule_rows(games):
    rows = []
    for g in sorted(games, key=lambda x: (x.get("gameDate") or "", x.get("gameTime") or "")):
        date = (g.get("gameDate") or "")[:10]
        rows.append({
            "date": date,
            "time": g.get("gameTimeText"),
            "type": g.get("type"),
            "homeTeam": g.get("homeTeam"),
            "homeScore": g.get("hometeamscore"),
            "awayScore": g.get("awayteamscore"),
            "awayTeam": g.get("awayTeam"),
            "complex": g.get("complex"),
            "venue": g.get("venue"),
            "status": g.get("status"),
            "matchID": g.get("matchID"),
        })
    return rows


def write_csv(path, columns, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        w.writerows(rows)


# ---------- verification ----------

class EventFilterError(Exception):
    """--event names no showcase of the season; the message says what the id is."""


def select_events(sources, season, conference=None, kind=None, event_id=None):
    """The (season, kind, name, event) rows that verify() and the crawl act on, as a list
    built before any request. `kind` ("national" or "showcase") keeps only that kind.

    With `event_id` (--event, #103), exactly one row: the showcase of `season` with that
    eventId. An unknown id, another kind's id or another season's showcase raises
    EventFilterError naming what the id is, so nothing is ever requested for it."""
    if event_id is None:
        return [row for row in api.iter_events(sources, season, conference)
                if not kind or row[1] == kind]
    if not season:
        raise EventFilterError(f"--event {event_id} needs an explicit --season")
    found = [row for row in api.iter_events(sources)
             if str(row[3].get("eventId")) == str(event_id)]
    chosen = [row for row in found if row[0] == season and row[1] == "showcase"]
    if len(chosen) == 1:
        return chosen
    if len(chosen) > 1:
        names = ", ".join(repr(n) for _s, _k, n, _e in chosen)
        raise EventFilterError(f"--event {event_id} is registered {len(chosen)} times in {season}: "
                               f"showcases {names}; an eventId must be unique in sources.json")
    if not found:
        raise EventFilterError(f"--event {event_id}: no event in the registry "
                               f"(public/data/sources.json) has this id")
    what = " and ".join(f"the {s} {k} {n!r}" for s, k, n, _e in found)
    raise EventFilterError(f"--event {event_id} is not a {season} showcase: it is {what}")


def verify(sources, season, conference, kind=None, event_id=None):
    """Confirm each configured event ID resolves to the expected event name.
    `kind` ("national" or "showcase") checks only that kind of event; `event_id`
    (--event) only that one showcase of `season` (see select_events)."""
    ok = bad = 0
    for season_key, ev_kind, name, event in select_events(sources, season, conference, kind, event_id):
        eid = event.get("eventId")
        if not eid:
            print(f"  SKIP  {season_key} {name}: no eventId set")
            continue
        try:
            data = api.unwrap(api.fetch_api(api.p_event_details(eid)))
            actual = (data or {}).get("name")
        except api.ApiError as e:
            print(f"  FAIL  {season_key} {name} ({eid}): {e}")
            bad += 1
            continue
        expected = event.get("eventName")
        if expected and actual != expected:
            print(f"  DIFF  {season_key} {name} ({eid})")
            print(f"        registry: {expected!r}")
            print(f"        live:     {actual!r}")
            bad += 1
        else:
            print(f"  OK    {season_key} {name} ({eid}) {actual!r}")
            ok += 1
        time.sleep(DELAY)
    print(f"\n{ok} verified, {bad} problem(s).")
    return 1 if bad else 0


# ---------- archiving ----------

def export_dir(season, kind, name):
    """Where an event's CSVs go: export/<season>/<name>/ for a conference or national
    event, export/<season>/showcases/<name>/ for a showcase (#97), so a showcase can
    never share a folder with a conference or national event of the same name."""
    parts = [api.EXPORT_DIR, api.slug(season)] + (["showcases"] if kind == "showcase" else [])
    return os.path.join(*parts, api.slug(name))


def archive_event(sources, season_key, kind, name, event, stats, force, dry_run):
    eid = event.get("eventId")
    if not eid:
        print(f"  skip {season_key} / {name}: no eventId")
        return None

    label = f"{season_key} / {name} ({eid})"
    if dry_run:
        print(f"  would archive {label}")
        for path in sorted(p for p in api.protected_paths() if p.startswith(f"Event/get-schedules-by-flight/{eid}/")):
            if FORCE_RECONSTRUCTED:
                print(f"    would overwrite reconstructed {path} (--force-reconstructed)")
            else:
                print(f"    {api.protected_notice(path)}")
        return None
    print(f"  {label}")

    try:
        hierarchy = api.unwrap(get_json(api.p_hierarchy(eid), stats, force))
    except api.ApiError as e:
        stats.fail(f"{label}: hierarchy: {e}")
        print(f"    ! hierarchy failed: {e}")
        return None

    divisions = (hierarchy or {}).get("girlsDivAndFlightList") or []
    templates = sources.get("publicUrlTemplates", {})
    export_base = export_dir(season_key, kind, name)

    entry = {
        "season": season_key,
        "kind": kind,
        "name": name,
        "eventId": eid,
        "eventName": event.get("eventName"),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "publicUrl": templates.get("eventHome", "").replace("{eventId}", str(eid)),
        "divisions": [],
    }

    all_standings = []
    div_team_names = {}  # divisionName -> [team names], for the birth-year anchor

    for div in divisions:
        div_id = div.get("divisionID")
        div_name = div.get("divisionName")
        for flight in (div.get("flightList") or []):
            flight_id = flight.get("flightID")
            flight_name = flight.get("flightName")
            stem = f"{api.slug(div_name)}-{api.slug(flight_name)}"
            record = {
                "divisionID": div_id,
                "divisionName": div_name,
                "flightID": flight_id,
                "flightName": flight_name,
                "standingsUrl": templates.get("standings", "")
                    .replace("{eventId}", str(eid)).replace("{flightId}", str(flight_id)),
                "schedulesUrl": templates.get("schedules", "")
                    .replace("{eventId}", str(eid)).replace("{flightId}", str(flight_id)),
            }

            # Standings
            try:
                payload = api.unwrap(get_json(api.p_standings(div_id, flight_id, eid), stats, force))
                teams = merge_standings_blocks(payload)
                record["teams"] = len(teams)
                div_team_names.setdefault(div_name, []).extend(
                    t.get("name") or "" for t in teams)
                rows = standings_rows(teams, kind)
                if rows:
                    write_csv(os.path.join(export_base, stem + ".standings.csv"),
                              STANDINGS_COLUMNS, rows)
                    for r in rows:
                        all_standings.append(dict(r, division=div_name, flight=flight_name))
            except api.ApiError as e:
                stats.fail(f"{label} {div_name}/{flight_name}: standings: {e}")
                print(f"    ! standings {div_name}/{flight_name}: {e}")

            # Schedule
            try:
                games = api.unwrap(get_json(api.p_schedule(eid, flight_id), stats, force)) or []
                record["games"] = len(games)
                if api.is_protected_path(api.p_schedule(eid, flight_id)):
                    # Reconstructed flight (reconstruct.py): keep the manifest
                    # marker across re-crawls, and count teams from the games
                    # since TGS publishes no standings for it.
                    record["reconstructed"] = True
                    if not record.get("teams"):
                        record["teams"] = len({t for g in games for t in (g.get("hometeamID"), g.get("awayteamID")) if t})
                rows = schedule_rows(games)
                if rows:
                    write_csv(os.path.join(export_base, stem + ".schedule.csv"),
                              SCHEDULE_COLUMNS, rows)
            except api.ApiError as e:
                stats.fail(f"{label} {div_name}/{flight_name}: schedule: {e}")
                print(f"    ! schedule {div_name}/{flight_name}: {e}")

            # Brackets, for national playoff/finals events only. The design
            # endpoint returns every named bracket (main, cup, consolations).
            # Never for a showcase: showcases have no brackets (#97).
            if kind == "national":
                try:
                    payload = api.unwrap(get_json(api.p_brackets_design(eid, flight_id), stats, force))
                    names = [b.get("bracketName") for b in payload if isinstance(b, dict)] \
                        if isinstance(payload, list) else []
                    record["brackets"] = [n for n in names if n]
                except api.ApiError as e:
                    print(f"    - no brackets for {div_name}/{flight_name}: {e}")

            entry["divisions"].append(record)

    if all_standings:
        write_csv(os.path.join(export_base, "_all.standings.csv"),
                  STANDINGS_COLUMNS + ["division", "flight"], all_standings)

    entry["_divTeamNames"] = div_team_names  # consumed by update_age_groups, not persisted
    return entry


# ---------- birth-year anchor ----------

def update_age_groups(sources, season_key, divisions, div_team_names):
    """Derive each division's birth-year band and record it under the season.

    Returns a list of human-readable change descriptions.
    """
    season = sources["seasons"][season_key]
    start_year = season.get("startYear") or int(season_key[:4])
    existing = season.get("ageGroups") or {}

    # Two-year bands (school-year cohorts) began in 2026-27. This only matters
    # as a fallback when neither the division nor the team names carry years.
    two_year = start_year >= 2026

    changes = []
    for div in divisions:
        name = div.get("divisionName")
        if not name:
            continue
        resolved = api.resolve_age_group(
            name, start_year, div_team_names.get(name, []), two_year_bands=two_year)
        if not resolved:
            continue
        prev = existing.get(name)
        # Never downgrade a band we already resolved from real data to a computed guess
        if prev and prev.get("source") != "computed" and resolved["source"] == "computed":
            continue
        if prev != resolved:
            changes.append(
                f"{season_key} {name}: {prev['birthYears'] if prev else '—'} -> "
                f"{resolved['birthYears']} (U{resolved['u']}, {resolved['source']})")
        existing[name] = resolved

    if existing:
        # Oldest cohort first, by earliest birth year — the cross-season anchor
        season["ageGroups"] = dict(
            sorted(existing.items(), key=lambda kv: kv[1]["birthYears"][0]))
    return changes


def save_sources(sources, team_counts=None):
    """Rewrite data/sources.json, preserving key order. Reformats to 2-space indent.

    With team_counts ({season: n}, #135 P1a) only those seasons' "teamCount" lines change: the
    file is hand-formatted, and a full rewrite would reformat it. This is the one writer of the
    registry, so a test that patches save_sources guards every write to it."""
    if team_counts:
        with open(api.SOURCES_PATH, "rb") as f:
            raw = f.read().decode("utf-8")
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        for season, n in team_counts.items():
            text = set_team_count_line(text, season, n)
        tmp = api.SOURCES_PATH + ".tmp"
        with open(tmp, "wb") as f:
            f.write(text.replace("\n", nl).encode("utf-8"))
        os.replace(tmp, api.SOURCES_PATH)
        return
    tmp = api.SOURCES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sources, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, api.SOURCES_PATH)


# ---------- the catalog's team count (#135 P1a) ----------
#
# seasons.<season>.teamCount is the number of distinct teams in the season's conference tables:
# the distinct teamIDs of its team index (archive/teams/<season>.json). The landing page shows
# it ("774 teams in 2026-27") from the catalog it already loads, at no extra request. It is
# written beside the index by update_team_index (the refresh, a conference crawl and --team-index;
# never by write_team_index itself), and checked by --team-history --check.

def set_team_count_line(text, season, n):
    """`text` (sources.json, LF) with the season's `"teamCount": n,` line inserted or replaced
    right after its "startYear" line; every other byte unchanged. Raises ValueError when the
    season has no "startYear" first line to anchor on."""
    m = re.search(r'\n    "' + re.escape(season) + r'": \{\n      "startYear": \d+,\n(      "teamCount": \d+,\n)?', text)
    if not m:
        raise ValueError(f'{season}: no "startYear" line to put "teamCount" after in sources.json')
    # The season's block ends at its closing brace (4 spaces in). A second "teamCount" in it (one
    # moved by a full rewrite, say) would make readers take the stale one: refuse, never add a twin.
    close = re.compile(r'\n    \}').search(text, m.end())
    if '"teamCount"' in text[m.end():close.start() if close else len(text)]:
        raise ValueError(f'{season}: a "teamCount" line that is not the second key; remove it, then run '
                         f'python archive.py --team-index --all')
    end = m.end() - len(m.group(1) or "")
    return text[:end] + f'      "teamCount": {int(n)},\n' + text[m.end():]


def team_count(season):
    """The distinct teamIDs of the season's committed team index, or None without one (or with
    no conference team: a count of 0 would only say "0 teams")."""
    index = api.read_json_file(api.team_index_path(season))
    if not index:
        return None
    return len({t.get("teamID") for t in index.get("teams") or [] if t.get("teamID") is not None}) or None


def team_count_drift(sources):
    """[(season, catalog value, index value)] for every season whose teamCount is not its index's."""
    out = []
    for season, entry in (sources.get("seasons") or {}).items():
        want = team_count(season)
        if entry.get("teamCount") != want:
            out.append((season, entry.get("teamCount"), want))
    return out


def put_team_count(entry, n):
    """Set entry["teamCount"] as the key right after "startYear", where the line edit puts it, so a
    later full save_sources() writes it there too (else the next line edit would add a twin). The
    dict is changed in place, keeping every other key's order."""
    items = [(k, v) for k, v in entry.items() if k != "teamCount"]
    entry.clear()
    for k, v in items:
        entry[k] = v
        if k == "startYear":
            entry["teamCount"] = n
    if "teamCount" not in entry:
        entry["teamCount"] = n


def sync_team_counts(sources, seasons, stats):
    """Bring the registry the caller loaded (`sources`) in line with the seasons' indexes, through
    save_sources. Never raises (like update_team_index): a failure is reported through stats.fail.
    Returns True when it wrote, False when nothing changed, None on a failure."""
    try:
        changed = {}
        for s in seasons:
            entry = (sources.get("seasons") or {}).get(s)
            n = team_count(s)
            if entry is not None and n is not None and entry.get("teamCount") != n:
                changed[s] = n
        if not changed:
            return False
        save_sources(sources, team_counts=changed)
        for s, n in changed.items():
            put_team_count(sources["seasons"][s], n)
        print(f"Team count written: {', '.join(f'{s} {n}' for s, n in changed.items())}.")
        return True
    except Exception as e:  # noqa: BLE001 — must never escape into the refresh
        stats.fail(f"team count: {e} (fix, then run: python archive.py --team-index --all)")
        print(f"Team count: FAILED: {e}")
        return None


# ---------- match-day driven refresh ----------
#
# Schedules carry scores as well as fixtures, so one schedule fetch collects
# both. Standings is the only endpoint needing a separate call, and it can only
# move if a score moved — so it is gated behind a diff.

def fetch_json(path, stats):
    """Fetch and archive, ignoring the mtime freshness check.

    Refresh mode must never trust mtime: a CI checkout resets every file's mtime
    to clone time, which would make everything look fresh and silently skip all
    work. refresh-state.json is the authority instead.

    Reconstructed paths are returned from the archive (see get_json).
    """
    protected = api.read_archive_protected(path) if not FORCE_RECONSTRUCTED else None
    if protected is not None:
        return protected

    raw = api.fetch_api_raw(path)
    data = json.loads(raw)  # validate before writing
    api.write_archive(path, raw, allow_protected=FORCE_RECONSTRUCTED)
    stats.fetched += 1
    time.sleep(DELAY)
    return data


def national_event_active(event, today, before_days=7, after_days=14):
    """Include a national (playoffs/finals) event in the refresh only around
    its dates: from a week before it starts to two weeks after it ends, so
    late-entered results are still picked up. Events without dates are
    always included."""
    start = event.get("startDate")
    end = event.get("endDate")
    if not start or not end:
        return True
    try:
        s = datetime.date.fromisoformat(start) - datetime.timedelta(days=before_days)
        e = datetime.date.fromisoformat(end) + datetime.timedelta(days=after_days)
    except ValueError:
        return True
    return s <= today <= e


def showcase_event_active(event, today):
    """Include a showcase in the refresh only on its own dates, startDate to endDate
    inclusive (UTC days), with no padding either side: a showcase is one weekend,
    and after its end date it is frozen (#97, owner decision 9). A showcase without
    valid dates is never refreshed; tests/test_showcases.py requires them."""
    try:
        start = datetime.date.fromisoformat(event["startDate"])
        end = datetime.date.fromisoformat(event["endDate"])
    except (KeyError, TypeError, ValueError):
        return False
    return start <= today <= end


def season_flights(sources, season, today=None):
    """Every flight in a season, from the archived hierarchies.

    Conference events are always included; national events only within their
    date window (see national_event_active), showcases only on their own dates
    (see showcase_event_active). Each dict carries the event's kind, name,
    division and flight identifiers. `today` defaults to the UTC date; the
    refresh passes its own (--date), so a dry run for a given day is that day's.
    """
    today = today or datetime.datetime.now(datetime.timezone.utc).date()
    season_data = sources["seasons"][season]
    events = [("conference", n, ev) for n, ev in (season_data.get("conferences") or {}).items()]
    events += [("national", n, ev) for n, ev in (season_data.get("national") or {}).items()
               if national_event_active(ev, today)]
    events += [("showcase", n, ev) for n, ev in (season_data.get("showcases") or {}).items()
               if showcase_event_active(ev, today)]
    return event_flights(events)


def event_flights(events):
    """The archived flights of (kind, name, event) triples, in order, as season_flights
    returns them. An event with no archived hierarchy has none."""
    out = []
    for kind, name, ev in events:
        eid = ev.get("eventId")
        if not eid:
            continue
        raw, _ = api.read_archive(api.p_hierarchy(eid))
        if not raw:
            continue
        try:
            divs = json.loads(raw)["data"]["girlsDivAndFlightList"] or []
        except (ValueError, KeyError, TypeError):
            continue
        for d in divs:
            for f in d.get("flightList") or []:
                out.append({
                    "kind": kind,
                    "conference": name,
                    "eventId": eid,
                    "divisionID": d.get("divisionID"),
                    "divisionName": d.get("divisionName"),
                    "flightID": f.get("flightID"),
                    "flightName": f.get("flightName"),
                    "key": api.flight_key(eid, f.get("flightID")),
                })
    return out


def archived_games(event_id, flight_id):
    raw, _ = api.read_archive(api.p_schedule(event_id, flight_id))
    if not raw:
        return []
    try:
        return json.loads(raw).get("data") or []
    except ValueError:
        return []


def build_match_days(sources, season, flights):
    """Rebuild the fixture calendar from the archived schedules."""
    days = {}
    for fl in flights:
        for g in archived_games(fl["eventId"], fl["flightID"]):
            d = api.game_date(g)
            if not d:
                continue
            entry = days.setdefault(d, {"games": 0, "flights": []})
            entry["games"] += 1
            if fl["key"] not in entry["flights"]:
                entry["flights"].append(fl["key"])
    return {
        "season": season,
        "generatedAt": api.iso_now(),
        "days": dict(sorted(days.items())),
    }


def results_signature(games):
    """Score state of a flight; changes only when a result is entered or edited."""
    return sorted(
        (g.get("matchID"), g.get("hometeamscore"), g.get("awayteamscore"),
         g.get("hometeamPKscore"), g.get("awayteamPKscore"), api.game_date(g))
        for g in games
    )


def pending_result_flights(flights, today, max_age_days):
    """Flights with a past game still missing a score, within the chase window.

    The cap matters: 14 games from 2025-26 have been unscored for nearly a year.
    Without it they would trigger standings refreshes forever.
    """
    out = {}
    for fl in flights:
        n = 0
        for g in archived_games(fl["eventId"], fl["flightID"]):
            d = api.game_date(g)
            if not d or d >= today.isoformat() or api.has_score(g):
                continue
            age = (today - datetime.date.fromisoformat(d)).days
            if 0 < age <= max_age_days:
                n += 1
        if n:
            out[fl["key"]] = n
    return out


def flights_playing(calendar, flights, today, lookback_days):
    """Flights with a game in [today - lookback, today]."""
    want = set()
    for i in range(lookback_days + 1):
        d = (today - datetime.timedelta(days=i)).isoformat()
        want.update((calendar.get("days", {}).get(d) or {}).get("flights") or [])
    return {fl["key"] for fl in flights if fl["key"] in want}


def is_match_day(calendar, today, padding_days):
    """True if today, or any of the previous `padding_days`, has fixtures.

    gameDate is a local wall-clock string with no timezone while cron runs in
    UTC, and teams span Pacific to Eastern — an 8pm Saturday kickoff in
    California is 03:00 Sunday UTC. The padding absorbs that.
    """
    for i in range(padding_days + 1):
        d = (today - datetime.timedelta(days=i)).isoformat()
        if (calendar.get("days") or {}).get(d):
            return True
    return False


def export_flight_csv(sources, season, fl):
    """Regenerate one flight's standings/schedule CSVs from the archive.

    Returns the standings rows so callers can rebuild _all.standings.csv.
    """
    base = export_dir(season, fl["kind"], fl["conference"])
    stem = f"{api.slug(fl['divisionName'])}-{api.slug(fl['flightName'])}"

    standings = []
    raw, _ = api.read_archive(api.p_standings(fl["divisionID"], fl["flightID"], fl["eventId"]))
    if raw:
        try:
            payload = json.loads(raw).get("data")
            standings = standings_rows(merge_standings_blocks(payload), fl["kind"])
            if standings:
                write_csv(os.path.join(base, stem + ".standings.csv"), STANDINGS_COLUMNS, standings)
        except (ValueError, AttributeError, TypeError):
            pass

    rows = schedule_rows(archived_games(fl["eventId"], fl["flightID"]))
    if rows:
        write_csv(os.path.join(base, stem + ".schedule.csv"), SCHEDULE_COLUMNS, rows)
    return standings


def cmd_export(sources, season):
    """Rebuild every CSV under export/ from the archive, with no API calls.

    Conferences and showcases (#97, every archived one, whatever its dates); national
    events are not rebuilt here (a crawl writes theirs). Per-flight files come from
    export_flight_csv; each event's _all.standings.csv is rebuilt from those rows in
    the same order archive_event writes it.
    """
    seasons = [season] if season else list(sources["seasons"].keys())
    for s in seasons:
        data = sources["seasons"][s]
        flights = event_flights(
            [("conference", n, ev) for n, ev in (data.get("conferences") or {}).items()]
            + [("showcase", n, ev) for n, ev in (data.get("showcases") or {}).items()])
        per_event = {}
        for fl in flights:
            rows = export_flight_csv(sources, s, fl)
            per_event.setdefault((fl["kind"], fl["conference"]), []).extend(
                dict(r, division=fl["divisionName"], flight=fl["flightName"]) for r in rows)
        for (kind, name), rows in per_event.items():
            if rows:
                write_csv(os.path.join(export_dir(s, kind, name), "_all.standings.csv"),
                          STANDINGS_COLUMNS + ["division", "flight"], rows)
        count = lambda kind: sum(1 for k, _n in per_event if k == kind)
        print(f"{s}: exported {len(flights)} flights across {count('conference')} conferences"
              f" and {count('showcase')} showcases")
    return 0


# ---------- per-season team index (#81) ----------
#
# One file per season listing every team row in the season's conference standings, so
# the page can find a team (deep links, My Teams) or search a season with one request
# instead of reading every hierarchy and standings file. Built only from the archive,
# with no API calls. Rows are in the page's scan order (registry conference, hierarchy
# division and flight, position in the merged table), so the page's "first match" in
# the index is the scan's first match. Rows keep TGS's standings-row key names, so the
# page renders them unchanged. A shape change bumps TEAM_INDEX_SCHEMA (the page then
# ignores the file and scans). Served at /api/v1/seasons/{season}/teams.

TEAM_INDEX_SCHEMA = 1
TEAM_INDEX_KEYS = [
    "teamID", "name", "clubID", "clubName", "clublogo",
    "eventID", "divisionID", "division", "flightID",
]
TEAM_INDEX_STATS = ["gp", "wins", "losses", "draws", "standingpoints", "goaldifferential"]


def build_team_index(sources, season):
    """The season's index as a dict. A missing or unreadable hierarchy or standings
    file is skipped, as the page's scan skips a failed request. Raises ValueError if
    an event lists two divisions with the same name: the page's search reads only the
    first, so the index could not mirror it."""
    teams = []
    for conf, ev in ((sources["seasons"].get(season) or {}).get("conferences") or {}).items():
        eid = ev.get("eventId")
        if not eid:
            continue
        raw, _ = api.read_archive(api.p_hierarchy(eid))
        if not raw:
            continue
        try:
            divs = json.loads(raw)["data"]["girlsDivAndFlightList"] or []
        except (ValueError, KeyError, TypeError):
            continue
        names = [d.get("divisionName") for d in divs]
        dupes = sorted({str(n) for n in names if names.count(n) > 1})
        if dupes:
            raise ValueError(f"{season}/{conf} (event {eid}) lists division "
                             f"{', '.join(dupes)} more than once")
        for d in divs:
            for f in d.get("flightList") or []:
                sraw, _ = api.read_archive(api.p_standings(d.get("divisionID"), f.get("flightID"), eid))
                if not sraw:
                    continue
                try:
                    merged = merge_standings_blocks(json.loads(sraw).get("data"))
                except (ValueError, AttributeError, TypeError):
                    continue
                for rank, t in enumerate(merged, 1):
                    row = {k: t.get(k) for k in TEAM_INDEX_KEYS}
                    row.update(conference=conf, flightName=f.get("flightName"), rank=rank)
                    row.update({k: t.get(k) for k in TEAM_INDEX_STATS})
                    teams.append(row)
    index = {"schema": TEAM_INDEX_SCHEMA, "season": season, "teams": teams}
    showcases = showcase_index_rows(sources, season)
    if showcases:
        index["showcases"] = showcases
    return index


def showcase_index_rows(sources, season):
    """#97: one row per archived showcase flight of the season, with the ids of the
    teams that play in it, so a team page fetches only the showcase schedules its team
    played in. The ids come from the schedule (a flight without a table still counts),
    in first-appearance order; rows are in registry, then hierarchy order. `aliases`
    carries the registry's hand-reviewed teamAliases (showcase id -> the same team's
    conference id) for the ids in this flight; the showcase ids themselves stay as the
    games carry them. The `teams` rows above are unchanged, so the schema stays 1."""
    out = []
    for _name, ev in ((sources["seasons"].get(season) or {}).get("showcases") or {}).items():
        eid = ev.get("eventId")
        raw, _ = api.read_archive(api.p_hierarchy(eid)) if eid else (None, None)
        if not raw:
            continue
        try:
            divs = json.loads(raw)["data"]["girlsDivAndFlightList"] or []
        except (ValueError, KeyError, TypeError):
            continue
        aliases = {str(k): v for k, v in (ev.get("teamAliases") or {}).items()}
        for d in divs:
            for f in d.get("flightList") or []:
                ids = []
                for g in archived_games(eid, f.get("flightID")):
                    for t in (g.get("hometeamID"), g.get("awayteamID")):
                        if t and t not in ids:
                            ids.append(t)
                if not ids:
                    continue
                row = {"eventID": eid, "divisionID": d.get("divisionID"),
                       "flightID": f.get("flightID"), "teamIDs": ids}
                here = {k: v for k, v in aliases.items() if k.isdigit() and int(k) in ids}
                if here:
                    row["aliases"] = here
                out.append(row)
    return out


def team_index_bytes(index):
    """One team (or showcase flight) per line, so a refresh diff shows only the rows
    that moved."""
    head = json.dumps({k: v for k, v in index.items() if k not in ("teams", "showcases")},
                      ensure_ascii=False, separators=(",", ":"))[:-1]
    rows = ",\n".join(json.dumps(t, ensure_ascii=False, separators=(",", ":")) for t in index["teams"])
    tail = ""
    if index.get("showcases"):
        tail = ',"showcases":[\n' + ",\n".join(
            json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in index["showcases"]) + "\n]"
    return (head + ',"teams":[\n' + rows + "\n]" + tail + "}\n").encode("utf-8")


def write_team_index(sources, season):
    """Rebuild one season's index and write it only when its parsed content changed
    (so line endings in a checkout never cause a rewrite). Never creates an empty file
    for a season with nothing archived. Returns (written, team_count)."""
    index = build_team_index(sources, season)
    path = api.team_index_path(season)
    current = api.read_json_file(path)
    if current == index or (not index["teams"] and current is None):
        return False, len(index["teams"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(team_index_bytes(index))
    os.replace(tmp, path)
    return True, len(index["teams"])


def update_team_index(sources, season, stats, count=True):
    """write_team_index for the crawl and refresh paths. Any failure is reported
    through stats.fail and never raises, so it cannot stop refresh-state.json from
    being written (a missing state write would repeat the day's full sweep).

    Then (count, #135 P1a) the catalog's teamCount for the season follows the index, into the
    registry the caller loaded, through save_sources: the refresh, a conference crawl and
    --team-index. A showcase crawl changes no conference row and passes count=False, as does a
    crawl run with --no-update-sources."""
    try:
        written, n = write_team_index(sources, season)
    except Exception as e:  # noqa: BLE001 — must never escape into the refresh
        stats.fail(f"{season}: team index: {e} "
                   f"(fix, then run: python archive.py --team-index --season {season})")
        print(f"Team index {season}: FAILED: {e}")
        return None
    print(f"Team index {season}: {n} teams, {'written' if written else 'unchanged'}.")
    if count:
        sync_team_counts(sources, [season], stats)
    return written


def cmd_team_index(sources, season):
    stats = Stats()
    for s in ([season] if season else list(sources["seasons"].keys())):
        update_team_index(sources, s, stats)
    for e in stats.errors:
        print(f"  - {e}")
    return 1 if stats.failed else 0


# ---------- team histories (#107) ----------
#
# public/archive/history/<teamID>.json: one squad across every season and event, built by
# team_history.py from the archive alone (no API calls) and served at
# /api/v1/teams/{teamID}/history. Every crawl and every --refresh rebuilds the whole set right
# after the team index, so the history files change in the same commit as the season data they
# come from. The build is all in memory first; only then are the changed files written, and a
# failure leaves every file as it was (docs/data-api.md, "When the data changes").

def update_team_history(sources, stats, dry_run=False):
    """team_history.write_history for the crawl and refresh paths. Never raises, so it cannot
    stop refresh-state.json from being written or the data from being committed. On success,
    refresh-state.json's historyAsOf becomes its updatedAt (the data the files were built from);
    on failure historyAsOf keeps its old value, the page says "history as of <date>", and the
    failure goes to stats.fail, so the run exits non-zero. A team-links.json entry that no
    longer fits is reported the same way, and only that entry is left out (#107 S1).

    Returns the squads it built (for update_team_directory, #114), or None on failure."""
    import team_history
    keep = {}
    try:
        written, removed, total, errors = team_history.write_history(sources, dry_run=dry_run, keep=keep)
    except Exception as e:  # noqa: BLE001 — must never escape into the refresh
        state = api.load_refresh_state()
        here = os.path.dirname(os.path.abspath(__file__))
        tb = [f for f in traceback.extract_tb(e.__traceback__) if os.path.dirname(os.path.abspath(f.filename)) == here]
        where = f" [{type(e).__name__} at {os.path.basename(tb[-1].filename)}:{tb[-1].lineno}]" if tb else f" [{type(e).__name__}]"
        stats.fail(f"team history: {e}{where} (fix, then run: python archive.py --team-history)")
        if isinstance(e, team_history.PartialWrite):
            print(f"Team history: FAILED: {e}{where}. Some history files are NEW and some OLD until "
                  f"it is rebuilt; the drift check (--team-history --check) lists them.")
        else:
            print(f"Team history: FAILED: {e}{where}. The history files were left as they were "
                  f"(built from the data of {state.get('historyAsOf') or 'an earlier run'}).")
        return None
    for err in errors:
        stats.fail(f"team history: {err}")
    verb = "would write" if dry_run else "written"
    print(f"Team history: {total} teams, {written} {verb}, {removed} {'would be ' if dry_run else ''}removed"
          f"{f', {len(errors)} team-links.json problem(s)' if errors else ''}.")
    # Only when the state file belongs to this archive (a test that moves the archive elsewhere
    # must not touch the checkout's refresh-state.json).
    if not dry_run and os.path.dirname(os.path.abspath(api.REFRESH_STATE_PATH)) == os.path.abspath(api.ARCHIVE_DIR):
        state = api.load_refresh_state()
        if state.get("updatedAt") and state.get("historyAsOf") != state["updatedAt"]:
            state["historyAsOf"] = state["updatedAt"]
            api.write_json_file(api.REFRESH_STATE_PATH, state)
    return keep.get("squads")


# ---------- team directory (#114) ----------
#
# public/archive/directory.json: every team (one #107 squad per row) in one file, for the
# page's team search, served at /api/v1/teams. Built by team_directory.py from the squads of
# the history build in the same run, so it needs no second build and never lags the
# histories. It is rebuilt LAST in every path (after the club places and the catalog's
# birth-year anchor, which it carries), and only from a successful history build.

def update_team_directory(sources, stats, squads, dry_run=False):
    """team_directory.write_directory for the crawl, refresh, --team-history and --clubs paths.
    Never raises. With no squad list (the history build failed, or a test stubbed it), the file
    is left as it was. A failure goes to stats.fail, so the run exits non-zero, and leaves the
    old file. Never touches refresh-state.json: historyAsOf belongs to the histories (#113)."""
    import team_directory
    if not isinstance(squads, list):
        print("Team directory: not rebuilt (no team history build in this run); left as it was.")
        return None
    errors = []
    try:
        changed = team_directory.write_directory(sources, squads, dry_run=dry_run, errors=errors)
    except Exception as e:  # noqa: BLE001 (must never escape into the refresh)
        stats.fail(f"team directory: {e} [{type(e).__name__}] (fix, then run: python archive.py --team-history)")
        print(f"Team directory: FAILED: {e}. The directory was left as it was.")
        return None
    # #133: a bad club-families.json entry is left out and reported; the directory is still written.
    for err in errors:
        stats.fail(f"team directory: {err} (fix public/data/club-families.json)")
        print(f"Team directory: {err}")
    state = ("would change" if dry_run else "written") if changed else "unchanged"
    print(f"Team directory: {len(squads)} teams, {state}.")
    return changed


def cmd_team_history(sources, dry_run=False, check=False):
    """--team-history: rebuild every history file (all seasons: a squad spans them). --check
    writes nothing and fails when a committed file differs from a fresh build (CI's drift
    check); --dry-run counts what would change."""
    import team_history
    import team_directory
    if check:
        keep = {}
        try:
            diff, errors = team_history.check_history(sources, keep=keep)
            family_errors = []
            stale_directory = team_directory.check_directory(sources, keep["squads"], errors=family_errors)
        except Exception as e:  # noqa: BLE001
            print(f"Team history check: FAILED: {e}")
            return 1
        for err in errors:
            print(f"  - team-links.json: {err}")
        for err in family_errors:
            print(f"  - {err}")
        errors = errors + family_errors
        if diff:
            print(f"Team history check: {len(diff)} file(s) differ from a fresh build of the archive, e.g. "
                  f"{', '.join(diff[:8])}. Run: python archive.py --team-history, then commit public/archive/history/")
        else:
            print("Team history check: every file equals a fresh build of the archive.")
        if stale_directory:
            print("Team directory check: public/archive/directory.json differs from a fresh build. "
                  "Run: python archive.py --team-history, then commit public/archive/directory.json")
        else:
            print("Team directory check: directory.json equals a fresh build of the archive.")
        # #135 P1a: the catalog's teamCount equals its season's committed team index.
        drift = team_count_drift(sources)
        if drift:
            print("Team count check: " + "; ".join(f"{s} has {have} in sources.json, {want} in its team index"
                                                  for s, have, want in drift) +
                  ". Run: python archive.py --team-index --all, then commit public/data/sources.json"
                  " (a season with no index, or none of its teams, keeps no teamCount: remove its line)")
        else:
            print("Team count check: every season's teamCount equals its team index.")
        return 1 if diff or errors or stale_directory or drift else 0
    stats = Stats()
    squads = update_team_history(sources, stats, dry_run=dry_run)
    update_team_directory(sources, stats, squads, dry_run=dry_run)
    for e in stats.errors:
        print(f"  - {e}")
    return 1 if stats.failed else 0


# ---------- club places (#87) ----------
#
# public/archive/clubs.json maps clubID -> {"city", "state"}, or null for a club whose
# TGS record has no usable city and state. Derived from Event/get-club-info, which also
# returns the street, zip, phone and the club president's contacts: none of that is kept,
# and the raw response is never written anywhere (ecnl_api.ARCHIVE_FAMILIES excludes it).
# The values are shown as TGS publishes them ("Bay Area, CA"), cleaned but never guessed.

CLUB_DELAY = 1.2              # seconds between club requests
CLUB_TIMEOUT = 10             # seconds per attempt
CLUB_RETRIES = 2              # attempts per club: one retry
CLUB_FAILURE_CAP = 10         # a sweep stops at this many failed clubs
CLUB_BUDGET_SECONDS = 8 * 60  # and after this much wall-clock time
CLUB_WIPE_LIMIT = 0.05        # abort, writing nothing, if more usable entries than this would go null
CLUB_RETRY_DAYS = 7           # after a failed monthly re-check, retry at most once a week
# TGS's placeholder club "No Club Selection": teams of about 22 unrelated clubs share it, and its
# record's place (El Paso, TX) is none of theirs (#108). club_ids() never yields it, so no path
# fetches it; clubs.json holds it as null. The same id as team_history.NO_CLUB and the page's
# NO_CLUB (tests/test_club_places.py checks that the three agree).
NO_CLUB_IDS = frozenset({"7"})

US_STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
    "Puerto Rico": "PR", "Guam": "GU", "U.S. Virgin Islands": "VI", "Virgin Islands": "VI",
    "American Samoa": "AS", "Northern Mariana Islands": "MP",
}
CA_PROVINCES = {
    "Alberta": "AB", "British Columbia": "BC", "Manitoba": "MB", "New Brunswick": "NB",
    "Newfoundland and Labrador": "NL", "Nova Scotia": "NS", "Ontario": "ON",
    "Prince Edward Island": "PE", "Quebec": "QC", "Saskatchewan": "SK",
    "Northwest Territories": "NT", "Nunavut": "NU", "Yukon": "YT",
}
CLUB_STATE_CODES = frozenset(US_STATES.values()) | frozenset(CA_PROVINCES.values())


def _fold(s):
    """Lower case without accents, for the name lookup ("Québec" -> "quebec")."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


_STATE_BY_NAME = {_fold(k): v for k, v in {**US_STATES, **CA_PROVINCES}.items()}
_MINOR_WORDS = {"by", "the", "of", "on", "de", "la", "del", "du"}
_CITY_ST_ZIP = re.compile(r"^(.+?),\s*([A-Z]{2})(\s+\d{5}(-\d{4})?)?\s*$")


def _clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().strip(",").strip()


def club_state_code(c):
    """A known USPS / Canada Post code from `statecode` or `statename`, whichever
    holds one (a code or a full name in either field), else ""."""
    for v in (c.get("statecode"), c.get("statename")):
        v = _clean(v)
        if len(v) == 2 and v.upper() in CLUB_STATE_CODES:
            return v.upper()
        if _fold(v) in _STATE_BY_NAME:
            return _STATE_BY_NAME[_fold(v)]
    return ""


def _cap(part, first):
    if part != part.lower() or (not first and part in _MINOR_WORDS):
        return part                      # mixed or upper case is left exactly as typed
    if re.match(r"^o'[a-z]", part):
        return "O'" + part[2].upper() + part[3:]
    if re.match(r"^mc[a-z]", part):
        return "Mc" + part[2].upper() + part[3:]
    return part[:1].upper() + part[1:]


def club_city_case(city):
    """Only words typed entirely in lower case change; minor words stay lower case
    except first, including inside hyphenated names ("stratford-on-avon")."""
    return " ".join("-".join(_cap(p, i == 0 and j == 0) for j, p in enumerate(w.split("-")))
                    for i, w in enumerate(city.split(" ")))


def club_place(c):
    """{"city", "state"} from a TGS clubData record, or None when it has no usable
    city and state. Street, zip, `location` and `country` are never read."""
    if not isinstance(c, dict):
        return None
    state = club_state_code(c)
    city = _clean(c.get("city"))
    m = _CITY_ST_ZIP.match(city)           # "Denver, CO 80202": the club typed it all in
    if m:
        if m.group(2) != state:
            return None
        city = _clean(m.group(1))
    if not city or not state or "," in city:
        return None
    if re.search(r"\d|@", city) or len(city) > 40 or re.search(r"\bP\.?\s*O\.?\s*Box\b", city, re.I):
        return None
    return {"city": club_city_case(city), "state": state}


class ClubRecordMissing(Exception):
    """200 'success' but no clubData, or a clubData for another id: a failed fetch."""


def fetch_club_place(club_id):
    """One club's place, or None for a real record with no usable place. Raises
    ClubRecordMissing or api.ApiError. Only city and state leave this function."""
    raw = api.fetch_api_raw(api.p_club_info(club_id), timeout=CLUB_TIMEOUT, retries=CLUB_RETRIES)
    payload = json.loads(raw)
    data = payload.get("data") if isinstance(payload, dict) else None
    c = data.get("clubData") if isinstance(data, dict) else None
    if not isinstance(payload, dict) or payload.get("result") != "success" or not isinstance(c, dict) \
            or str(c.get("clubID")) != str(club_id):
        raise ClubRecordMissing(f"club {club_id}: no clubData for this id")
    return club_place(c)


def club_ids(seasons):
    """Distinct clubIDs of the seasons' team indexes, in first-seen order, without the
    placeholder NO_CLUB_IDS. Every club fetch takes its ids from here."""
    seen = {}
    for s in seasons:
        for t in (api.read_json_file(api.team_index_path(s)) or {}).get("teams") or []:
            if t.get("clubID") and str(t["clubID"]) not in NO_CLUB_IDS:
                seen.setdefault(str(t["clubID"]), None)
    return list(seen)


def load_club_places():
    return dict((api.read_json_file(api.CLUBS_PATH) or {}).get("clubs") or {})


def club_places_bytes(clubs):
    """One club per line, sorted by id, LF, so a diff shows only the clubs that moved."""
    rows = ",\n".join(f"{json.dumps(k)}:{json.dumps(v, ensure_ascii=False, separators=(',', ':'))}"
                      for k, v in sorted(clubs.items(), key=lambda kv: int(kv[0])))
    return ('{"schema":1,"clubs":{\n' + rows + "\n}}\n").encode("utf-8")


def write_club_places(clubs):
    """Write only when the parsed content changed, and never an empty file where
    there was none. Returns True if written."""
    current = api.read_json_file(api.CLUBS_PATH)
    if current == {"schema": 1, "clubs": clubs} or (not clubs and current is None):
        return False
    os.makedirs(os.path.dirname(api.CLUBS_PATH), exist_ok=True)
    tmp = api.CLUBS_PATH + ".tmp"
    with open(tmp, "wb") as f:
        f.write(club_places_bytes(clubs))
    os.replace(tmp, api.CLUBS_PATH)
    return True


def sweep_club_places(ids, current, fetch=None, sleep=None, clock=None):
    """Fetch `ids` into a copy of `current`. Returns (places, report).
    report["stopped"] names the cap that ended the sweep (it did not complete, even
    when the cap was reached on the last club); report["aborted"] is set when the
    result must not be written at all (the wipe guard)."""
    fetch, sleep, clock = fetch or fetch_club_place, sleep or time.sleep, clock or time.monotonic
    places, errors, requested, fetched, stopped = dict(current), [], 0, 0, None
    start = clock()
    for i, cid in enumerate(ids):
        if i and clock() - start > CLUB_BUDGET_SECONDS:
            stopped = f"the {CLUB_BUDGET_SECONDS // 60}-minute budget"
            break
        if i:
            sleep(CLUB_DELAY)
        requested += 1
        try:
            place = fetch(cid)
        except ClubRecordMissing as e:
            errors.append(str(e))
            places.setdefault(cid, None)       # null only when there is no entry yet
        except (api.ApiError, ValueError, AttributeError) as e:
            errors.append(f"club {cid}: {e}")  # keep the previous entry; retried later
        else:
            fetched += 1
            places[cid] = place
            continue
        if len(errors) >= CLUB_FAILURE_CAP:
            stopped = f"{len(errors)} failures"
            break
    usable = [k for k in ids if current.get(k)]
    lost = [k for k in usable if not places.get(k)]
    aborted = bool(usable) and len(lost) > CLUB_WIPE_LIMIT * len(usable)
    return places, {"requested": requested, "fetched": fetched, "errors": errors, "stopped": stopped,
                    "aborted": f"{len(lost)} of {len(usable)} usable entries would become null" if aborted else None}


def update_club_places(ids, stats, label):
    """Sweep, guard and write. Never raises. Club requests count in stats.fetched.
    Returns True when the sweep completed (not stopped by a cap, not aborted)."""
    try:
        places, rep = sweep_club_places(ids, load_club_places())
        stats.fetched += rep["requested"]
        for e in rep["errors"]:
            stats.fail(f"club places: {e}")
        if rep["aborted"]:
            stats.fail(f"club places: {label} aborted, nothing written: {rep['aborted']}")
            print(f"Club places {label}: ABORTED ({rep['aborted']}); nothing written.")
            return False
        written = write_club_places(places)
        if rep["stopped"]:
            stats.fail(f"club places: {label} stopped at {rep['stopped']}")
        print(f"Club places {label}: {rep['fetched']} of {len(ids)} fetched, {len(rep['errors'])} failed"
              f"{', stopped at ' + rep['stopped'] if rep['stopped'] else ''}, "
              f"{'written' if written else 'unchanged'}.")
        return not rep["stopped"]
    except Exception as e:  # noqa: BLE001 - must never escape into the refresh
        stats.fail(f"club places: {label}: {e}")
        print(f"Club places {label}: FAILED: {e}")
        return False


def fetch_new_club_places(seasons, stats, label):
    """Fetch only the seasons' clubs with no entry yet (a crawl, or a sweep between
    monthly re-checks). Never raises. Returns (requested_any, completed)."""
    try:
        current = load_club_places()
        todo = [c for c in club_ids(seasons) if c not in current]
    except Exception as e:  # noqa: BLE001
        stats.fail(f"club places: {label}: {e}")
        return False, False
    if not todo:
        print(f"Club places {label}: no new clubs.")
        return False, True
    return True, update_club_places(todo, stats, f"{label}: {len(todo)} new")


def _club_retry_wait(state, today):
    """Days left before a failed monthly re-check may run again, else 0."""
    ok, tried = state.get("lastClubSweepDate") or "", state.get("lastClubSweepAttempt") or ""
    if not tried or tried <= ok:
        return 0
    try:
        return max(0, CLUB_RETRY_DAYS - (today - datetime.date.fromisoformat(tried)).days)
    except ValueError:
        return 0


def refresh_club_places(season, today, stats):
    """The refresh's club step, on the day's sweep run after the state write and the
    team index: new clubs on every sweep; every active-season club on the first
    successful sweep of each UTC calendar month; after a failed re-check, at most one
    retry a week. Re-reads refresh-state.json and changes only the club dates and the
    request/failure counts. Never raises."""
    try:
        state = api.load_refresh_state()
        monthly = (state.get("lastClubSweepDate") or "")[:7] != today.isoformat()[:7]
        wait = _club_retry_wait(state, today) if monthly else 0
        if wait:
            print(f"Club places: monthly re-check failed on {state.get('lastClubSweepAttempt')}; "
                  f"next retry in {wait} day(s).")
            monthly = False
        if monthly:
            ids = club_ids([season])
            requested = bool(ids)
            completed = update_club_places(ids, stats, "monthly re-check") if ids else False
        else:
            requested, completed = fetch_new_club_places([season], stats, "sweep")
        if not requested:
            return
        state = api.load_refresh_state()          # read-modify-write
        if monthly:
            state["lastClubSweepAttempt"] = today.isoformat()
            if completed:
                state["lastClubSweepDate"] = today.isoformat()
        state["requests"] = stats.fetched
        state["failed"] = stats.failed
        api.write_json_file(api.REFRESH_STATE_PATH, state)
    except Exception as e:  # noqa: BLE001 - must never escape into the refresh
        stats.fail(f"club places: {e}")
        print(f"Club places: FAILED: {e}")


def cmd_clubs(sources, season, force=False, dry_run=False):
    """`--clubs [--season S | --all] [--force]`: fetch the clubs with no entry yet
    (every club with --force), under the refresh's caps. Never touches
    refresh-state.json, so it does not stand in for the monthly re-check."""
    seasons = [season] if season else list(sources["seasons"])
    ids = club_ids(seasons)
    current = load_club_places()
    todo = ids if force else [c for c in ids if c not in current]
    print(f"Club places: {len(ids)} clubs in {', '.join(seasons)}; "
          f"{len(todo)} to fetch{' (--force)' if force else ''}"
          f"{', dry run: nothing fetched' if dry_run else ''}.")
    if dry_run or not todo:
        return 0
    stats = Stats()
    update_club_places(todo, stats, "--clubs")
    # The team directory carries each club's place (#114 M3): only that column can change here,
    # so it is updated in place, with no squad build. Never raises.
    try:
        import team_directory
        if team_directory.refresh_places():
            print("Team directory: club places updated.")
    except Exception as e:  # noqa: BLE001
        stats.fail(f"team directory: {e} (fix, then run: python archive.py --team-history)")
    for e in stats.errors:
        print(f"  - {e}")
    return 1 if stats.failed else 0


def refresh_policy(sources):
    p = sources.get("refresh") or {}
    md = p.get("matchDay") or {}
    return {
        "activeSeason": p.get("activeSeason") or next(iter(sources["seasons"])),
        "everyHours": md.get("everyHours", 2),
        "lookbackDays": md.get("lookbackDays", 2),
        "timezonePaddingDays": md.get("timezonePaddingDays", 1),
        "sweepDaily": (p.get("sweep") or {}).get("daily", True),
        "sweepAtUtcHour": (p.get("sweep") or {}).get("atUtcHour", 6),
        "maxPendingAgeDays": (p.get("pending") or {}).get("maxPendingAgeDays", 21),
        "minIntervalMinutes": p.get("minIntervalMinutes", 90),
    }


def cmd_refresh(sources, args):
    """Match-day driven incremental refresh. Returns a process exit code."""
    pol = refresh_policy(sources)
    season = pol["activeSeason"]
    if season not in sources["seasons"]:
        print(f"Active season {season!r} is not in the registry.")
        return 2

    today = (datetime.date.fromisoformat(args.date) if args.date
             else datetime.datetime.now(datetime.timezone.utc).date())
    now_hour = (args.at_hour if args.at_hour is not None
                else datetime.datetime.now(datetime.timezone.utc).hour)
    state = api.load_refresh_state()

    # Rate guard, so a manual re-run or a duplicated cron cannot hammer the API.
    last = state.get("updatedAt")
    if last and not args.force and not args.date:
        try:
            prev = datetime.datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ") \
                .replace(tzinfo=datetime.timezone.utc)
            mins = (datetime.datetime.now(datetime.timezone.utc) - prev).total_seconds() / 60
            if mins < pol["minIntervalMinutes"]:
                print(f"Last run was {mins:.0f} min ago "
                      f"(< minIntervalMinutes={pol['minIntervalMinutes']}). Nothing to do.")
                return 0
        except ValueError:
            pass

    flights = season_flights(sources, season, today)
    if not flights:
        print(f"No archived hierarchy for {season}; run: python archive.py --season {season}")
        return 2

    calendar = api.load_match_days()
    if calendar.get("season") != season:
        calendar = build_match_days(sources, season, flights)

    # A sweep is just the run that lands on the configured hour — or the first
    # run of a day that has not swept yet, so a missed cron self-heals.
    swept_on = state.get("lastSweepDate")
    due_by_hour = pol["sweepDaily"] and now_hour >= pol["sweepAtUtcHour"]
    sweep = bool(args.sweep or (due_by_hour and swept_on != today.isoformat()))

    match_day = is_match_day(calendar, today, pol["timezonePaddingDays"])
    pending = pending_result_flights(flights, today, pol["maxPendingAgeDays"])

    # ---- candidate set ----
    candidates = set()
    if sweep:
        candidates |= {fl["key"] for fl in flights}
    if match_day:
        candidates |= flights_playing(calendar, flights, today, pol["lookbackDays"])
    candidates |= set(pending)

    reason = ", ".join(filter(None, [
        "sweep" if sweep else "",
        "match day" if match_day else "",
        f"{len(pending)} flights with pending results" if pending else "",
    ])) or "nothing due"
    print(f"{today}  {season}  [{reason}]  -> {len(candidates)} of {len(flights)} flights")

    if not candidates:
        print("Non-match day, no sweep due, no pending results. No network calls.")
        if args.dry_run:
            return 0
        # Heal an index left stale by a hand edit; written only if a row changed. The team
        # histories follow it the same way (#107).
        stats = Stats()
        update_team_index(sources, season, stats)
        squads = update_team_history(sources, stats)
        update_team_directory(sources, stats, squads)
        return 1 if stats.failed else 0
    if args.dry_run:
        for fl in sorted((f for f in flights if f["key"] in candidates),
                         key=lambda f: (f["conference"], f["divisionName"])):
            print(f"  would refresh {fl['conference']:15} {fl['divisionName']:12} {fl['flightName']}")
        return 0

    stats = Stats()
    started = time.time()
    standings_refreshed = 0
    touched = set()

    # Hierarchies change rarely; refresh them only on a sweep, to catch new flights.
    if sweep:
        for conf, ev in (sources["seasons"][season].get("conferences") or {}).items():
            try:
                fetch_json(api.p_hierarchy(ev["eventId"]), stats)
            except api.ApiError as e:
                stats.fail(f"{season}/{conf}: hierarchy: {e}")
        # A showcase can add flights late, so on its own dates the sweep re-reads its
        # hierarchy too (#97). Outside them it is never fetched.
        for name, ev in (sources["seasons"][season].get("showcases") or {}).items():
            if not ev.get("eventId") or not showcase_event_active(ev, today):
                continue
            try:
                fetch_json(api.p_hierarchy(ev["eventId"]), stats)
            except api.ApiError as e:
                stats.fail(f"{season}/{name}: hierarchy: {e}")
        flights = season_flights(sources, season, today) or flights

    by_key = {fl["key"]: fl for fl in flights}
    for key in sorted(candidates):
        fl = by_key.get(key)
        if not fl:
            continue
        label = f"{fl['conference']}/{fl['divisionName']}/{fl['flightName']}"

        before = results_signature(archived_games(fl["eventId"], fl["flightID"]))
        try:
            payload = fetch_json(api.p_schedule(fl["eventId"], fl["flightID"]), stats)
        except api.ApiError as e:
            stats.fail(f"{label}: schedule: {e}")
            continue
        games = payload.get("data") or []
        after = results_signature(games)
        touched.add(key)

        # Standings cannot move unless a result did — so only refetch when the
        # score signature actually changed, or when we have no standings at all.
        have_standings = api.read_archive(
            api.p_standings(fl["divisionID"], fl["flightID"], fl["eventId"]))[0] is not None
        if after != before or not have_standings:
            try:
                fetch_json(api.p_standings(fl["divisionID"], fl["flightID"], fl["eventId"]), stats)
                standings_refreshed += 1
            except api.ApiError as e:
                stats.fail(f"{label}: standings: {e}")

    # Keep the CSV exports in step with the JSON we just refreshed. Local work
    # only, no API cost.
    for key in sorted(touched):
        fl = by_key.get(key)
        if fl:
            export_flight_csv(sources, season, fl)

    # Rebuild the calendar from whatever is now on disk.
    calendar = build_match_days(sources, season, flights)
    api.write_json_file(api.MATCH_DAYS_PATH, calendar)

    still_pending = pending_result_flights(flights, today, pol["maxPendingAgeDays"])
    elapsed = time.time() - started
    api.write_json_file(api.REFRESH_STATE_PATH, {
        "updatedAt": api.iso_now(),
        "activeSeason": season,
        "runDate": today.isoformat(),
        "sweep": sweep,
        "matchDay": match_day,
        "lastSweepDate": today.isoformat() if sweep else swept_on,
        # Club places (#87): set only by refresh_club_places, carried forward here.
        "lastClubSweepDate": state.get("lastClubSweepDate"),
        "lastClubSweepAttempt": state.get("lastClubSweepAttempt"),
        # Team histories (#107): set by update_team_history once they are rebuilt from this
        # run's data, carried forward here so a failed build keeps saying how old they are.
        "historyAsOf": state.get("historyAsOf"),
        "flightsConsidered": len(flights),
        "flightsRefreshed": len(candidates),
        "standingsRefreshed": standings_refreshed,
        "requests": stats.fetched,
        "failed": stats.failed,
        "durationSeconds": round(elapsed, 1),
        "pendingResultFlights": len(still_pending),
        "pendingResultGames": sum(still_pending.values()),
    })

    # The team index follows the standings and hierarchies just written (#81). Local
    # work only, after the state write and unable to raise, so it can never stop the
    # state (and lastSweepDate) from being saved. The catalog's teamCount follows it (#135 P1a).
    update_team_index(sources, season, stats)

    # Team histories (#107) follow the index: every history file whose seasons, results or
    # events changed is rewritten in this run, so the workflow commits it with the data. All
    # seasons are rebuilt (a squad spans them); unchanged files are not rewritten. Local work
    # only; unable to raise; a failure keeps the old files and fails the run.
    squads = update_team_history(sources, stats)

    # Club places (#87): on the day's sweep, after the state write and the team index
    # (so a club new in today's standings is fetched today). Bounded; never raises.
    if sweep:
        refresh_club_places(season, today, stats)

    # The team directory (#114) last, after the club places it carries, from the squads of the
    # history build above. Local work only; unable to raise; never touches historyAsOf.
    update_team_directory(sources, stats, squads)

    print(f"{stats.fetched} requests ({standings_refreshed} standings), "
          f"{stats.failed} failed, {elapsed:.0f}s. "
          f"Pending results: {sum(still_pending.values())} games "
          f"in {len(still_pending)} flights.")
    if stats.errors:
        for e in stats.errors[:10]:
            print(f"  - {e}")
    return 1 if stats.failed else 0


def load_manifest():
    if os.path.exists(api.MANIFEST_PATH):
        try:
            with open(api.MANIFEST_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except ValueError:
            pass
    return {"updated": None, "events": {}}


def save_manifest(manifest):
    os.makedirs(api.ARCHIVE_DIR, exist_ok=True)
    manifest["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(api.MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")


class _OnceAction(argparse.Action):
    """Store an option that may be given only once: argparse would silently keep the
    last of two `--event` values, and act on a showcase the caller did not mean."""

    def __call__(self, parser, namespace, values, option_string=None):
        if getattr(namespace, self.dest, None) is not None:
            parser.error(f"{option_string} given more than once "
                         f"({getattr(namespace, self.dest)}, then {values}); name one showcase")
        setattr(namespace, self.dest, values)


def main():
    ap = argparse.ArgumentParser(description="Archive ECNL standings and schedules locally.")
    ap.add_argument("--season", help="Season key, e.g. 2024-25. Defaults to the newest season.")
    ap.add_argument("--conference", help="Single conference name, e.g. Texas.")
    ap.add_argument("--national", action="store_true",
                    help="Only the season's national (Playoffs/Finals) events; skips conferences.")
    ap.add_argument("--showcases", action="store_true",
                    help="Only the season's showcases (#97); skips conferences and national events. "
                         "With --verify, verifies only them.")
    ap.add_argument("--event", type=int, metavar="ID", action=_OnceAction,
                    help="Only with an explicit --season S and --showcases: act on the one "
                         "showcase of S with this TGS event id (#103), for --verify (one "
                         "request), --dry-run and the crawl (--force re-fetches only it). "
                         "Without --event, verify and the crawl act on every showcase of the "
                         "season. The team index is still rebuilt for the whole season; only "
                         "this showcase's manifest entry is written. Not with --all, --national, "
                         "--conference, --refresh, --export, --team-index or --clubs, and "
                         "given only once.")
    ap.add_argument("--max-requests", type=int, metavar="N",
                    help="Stop asking upstream after N HTTP requests, retries included "
                         "(a request budget for a crawl or --verify).")
    ap.add_argument("--all", action="store_true", help="Every season in the registry.")
    ap.add_argument("--verify", action="store_true",
                    help="Only check that event IDs resolve to the expected names.")
    ap.add_argument("--dry-run", action="store_true", help="List what would be fetched.")
    ap.add_argument("--force", action="store_true",
                    help="Re-fetch even if the archived copy is less than 12h old.")
    ap.add_argument("--force-reconstructed", action="store_true",
                    help="Also re-fetch and overwrite the reconstructed schedules listed in "
                         "sources.json (never implied by --force; see reconstruct.py).")
    ap.add_argument("--no-update-sources", action="store_true",
                    help="Do not write derived age-group birth years back to data/sources.json.")
    ap.add_argument("--refresh", action="store_true",
                    help="Match-day driven incremental refresh of the active season "
                         "(what the scheduled workflow runs).")
    ap.add_argument("--sweep", action="store_true",
                    help="With --refresh: force the all-flights schedule sweep.")
    ap.add_argument("--date", metavar="YYYY-MM-DD",
                    help="With --refresh: pretend today is this date (for testing).")
    ap.add_argument("--at-hour", type=int, metavar="H",
                    help="With --refresh: pretend the current UTC hour is H (for testing).")
    ap.add_argument("--export", action="store_true",
                    help="Rebuild the CSVs under export/ from the archive (no API calls).")
    ap.add_argument("--team-index", action="store_true",
                    help="Rebuild public/archive/teams/<season>.json from the archive "
                         "(no API calls). With --all, every season.")
    ap.add_argument("--team-history", action="store_true",
                    help="Rebuild public/archive/history/<teamID>.json, every team's squad history "
                         "across all seasons (#107), from the archive (no API calls). Always all "
                         "seasons; --dry-run counts what would change.")
    ap.add_argument("--check", action="store_true",
                    help="With --team-history: write nothing, and exit 1 when a committed history "
                         "file differs from a fresh build of the archive (the CI drift check).")
    ap.add_argument("--clubs", action="store_true",
                    help="Fetch the city and state of the season's clubs (--all: every season) "
                         "that have no entry in public/archive/clubs.json yet; with --force, "
                         "re-check every one. --dry-run lists the count and fetches nothing.")
    args = ap.parse_args()
    if args.event is not None:
        # #103: --event acts on one showcase of one named season, and on nothing else.
        clash = [flag for flag, on in (
            ("--all", args.all), ("--national", args.national), ("--conference", args.conference),
            ("--refresh", args.refresh), ("--export", args.export),
            ("--team-index", args.team_index), ("--team-history", args.team_history),
            ("--clubs", args.clubs)) if on]
        if clash:
            ap.error(f"--event cannot be combined with {', '.join(clash)}")
        if not args.season or not args.showcases:
            ap.error("--event needs an explicit --season S and --showcases")
    if args.check and not args.team_history:
        ap.error("--check needs --team-history")
    if args.national and args.conference:
        ap.error("--national cannot be combined with --conference (the conference filter drops national events)")
    if args.showcases and (args.conference or args.national):
        ap.error("--showcases cannot be combined with --conference or --national")
    if args.max_requests is not None:
        if args.max_requests < 0:
            ap.error("--max-requests must be 0 or more")
        api.HTTP_BUDGET = args.max_requests

    global FORCE_RECONSTRUCTED
    FORCE_RECONSTRUCTED = args.force_reconstructed

    try:
        sources = api.load_sources()
    except (OSError, ValueError) as e:
        print(f"Could not read {api.SOURCES_PATH}: {e}")
        return 2

    if args.refresh:
        return cmd_refresh(sources, args)

    if args.team_history:   # every season, whatever --season or --all says: a squad spans them
        return cmd_team_history(sources, dry_run=args.dry_run, check=args.check)

    season_keys = list(sources["seasons"].keys())
    if args.all:
        season = None
    elif args.season:
        if args.season not in sources["seasons"]:
            print(f"Unknown season {args.season!r}. Known: {', '.join(season_keys)}")
            return 2
        season = args.season
    else:
        season = season_keys[0]
        print(f"No --season/--all given; defaulting to {season}.\n")

    only_kind = "showcase" if args.showcases else "national" if args.national else None
    if args.verify:
        try:
            code = verify(sources, season, args.conference, only_kind, args.event)
        except EventFilterError as e:
            ap.error(str(e))
        print(f"HTTP requests: {api.HTTP_ATTEMPTS} (retries included).")
        return code

    if args.export:
        return cmd_export(sources, season)

    if args.team_index:
        return cmd_team_index(sources, season)

    if args.clubs:
        return cmd_clubs(sources, season, force=args.force, dry_run=args.dry_run)

    try:
        events = select_events(sources, season, args.conference, only_kind, args.event)
    except EventFilterError as e:
        ap.error(str(e))

    stats = Stats()
    manifest = load_manifest()
    started = time.time()

    age_changes = []
    # Only the crawled events' manifest entries are replaced (with --event, that one);
    # every other entry is carried over as loaded.
    for season_key, kind, name, event in events:
        entry = archive_event(sources, season_key, kind, name, event, stats, args.force, args.dry_run)
        if entry:
            div_team_names = entry.pop("_divTeamNames", {})
            if kind == "conference" and not args.no_update_sources:
                divisions = [{"divisionName": d["divisionName"]} for d in entry["divisions"]]
                age_changes += update_age_groups(
                    sources, season_key, divisions, div_team_names)
            manifest["events"][f"{season_key}/{name}"] = entry
            save_manifest(manifest)  # checkpoint, so an interrupted crawl keeps progress

    # Rebuild the team index of every season whose conferences were crawled (#81).
    if not args.dry_run and not args.national and not args.showcases:
        for s in sorted({s for s, kind, _n, _e in api.iter_events(sources, season, args.conference)
                         if kind == "conference"}):
            # The catalog's teamCount follows the index (#135 P1a), unless the registry is not to be written.
            update_team_index(sources, s, stats, count=not args.no_update_sources)
            # Then the season's clubs with no place yet (#87); usually none.
            fetch_new_club_places([s], stats, s)
    # A showcase crawl rebuilds the index for its showcase rows (#97), and never runs the
    # club step: clubs seen only at a showcase are never fetched.
    if not args.dry_run and args.showcases:
        for s in sorted({s for s, kind, _n, _e in api.iter_events(sources, season)
                         if kind == "showcase"}):
            update_team_index(sources, s, stats, count=False)   # no conference row changes (#135 P1a)
    # Any crawl (conference, national or showcase) can change a team's history (#107).
    squads = None
    if not args.dry_run:
        squads = update_team_history(sources, stats)

    if age_changes and not args.dry_run:
        save_sources(sources)
        print(f"\nBirth-year anchor updated in {api.SOURCES_PATH}:")
        for c in age_changes:
            print(f"  {c}")

    # The team directory (#114) last: after the club places and the birth-year anchor above.
    if not args.dry_run:
        update_team_directory(sources, stats, squads)

    elapsed = time.time() - started
    print(f"\nFetched {stats.fetched}, reused {stats.skipped} fresh, "
          f"{stats.failed} failed, in {elapsed:.0f}s. "
          f"HTTP requests: {api.HTTP_ATTEMPTS} (retries included).")
    if stats.errors:
        print("\nProblems:")
        for e in stats.errors:
            print(f"  - {e}")
    if not args.dry_run:
        print(f"\nArchive: {api.ARCHIVE_API_DIR}\nCSVs:    {api.EXPORT_DIR}")
    return 1 if stats.failed else 0


if __name__ == "__main__":
    sys.exit(main())
