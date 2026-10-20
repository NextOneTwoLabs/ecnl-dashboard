"""Search data files (#149 phase 1, PR 2a; #158).

Two kinds of search data file, the prepared records that the page's search reads:

  public/archive/search/core.json            teams (the team directory, verbatim), events, fields
                                             and the shared vocabulary; /api/v1/search/core
  public/archive/search/games-<season>.json  one row per game of that season, every flight of
                                             every event; /api/v1/search/games/{season}

They are not the index: the index is the word-to-records map the browser builds from these files
in memory (PR 3). Everything here is built offline from the committed archive (no network, no
clock, no locale), and written only when its bytes change. See docs/data-api.md, "Search data".

How a games file stays quiet across refreshes (#158 MF2): rows carry TGS's own ids (matchID,
flightID, teamID, complexID), never positions in a table; the tables are keyed by those ids, one
entry per line, sorted; lines begin with their comma, so an entry added at the end adds one line.
A refresh that changes one score rewrites that game's line and the `build` line, nothing else.

Determinism (#158 MF3): every set and dict is emitted in an explicit sort order, the date base
comes from the season key, and the report goes to stdout only. A key that maps to two values (a
complexID with two fields, a team with two names at one event, a flight in two events) is an
error, never a silent pick (#158 MF7).

Usage:
    python search_data.py --root <checkout> --inputs <checkout> --out <dir> [--fixture --commit <sha>]
archive.py runs the build after the team directory in every path that rebuilds it, and
`python archive.py --search-data [--check]` runs it on its own (see archive.py).
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import re
import sys
import unicodedata

import ecnl_api as api

SCHEMA = 2                # core.json (2 since #159: fields moved to places.json)
PLACES_SCHEMA = 1         # places.json (#159)
GAMES_SCHEMA = 1          # games-<season>.json
BUILD_LEN = 16            # hex digits of sha256 kept as a build id
# The reviewed inputs under public/data/ (MANIFEST.search.inputs records each one's LF sha256, or null).
INPUTS = ("field-aliases.json", "zip-fixes.json", "zip-places.json", "zip-place-fixes.json", "city-counties.json", "orphan-team-ids.json")

# Row positions in a games file (docs/data-api.md, "Search data"). Trailing nulls are dropped.
ROW = ("matchID", "when", "flight", "home", "away", "hs", "as", "hpk", "apk", "complex", "number", "flags", "dest")
# Flag bits. 2 is set only by undate_borrowed_dates, never for a game with no date in the source.
F_BRACKET, F_UNDATED, F_RECONSTRUCTED, F_FRIENDLY, F_BYE = 1, 2, 4, 8, 16
NO_TIME = 9999            # HHMM for a game with no kick-off time (T00:00:00)
PLACEHOLDER = re.compile(r"^(tbd|tba|to be determined)$")
BYE = re.compile(r"^bye$", re.I)
# The conference aliases today's team search already knows (index.html TEAM_SEARCH prepare()).
CONF_ALIASES = {"northern california": "NorCal"}
STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
    "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
ALIAS_KEYS = {"name", "zip", "label", "aliases", "evidence"}
FIX_KEYS = {"raw", "zip", "evidence"}
PLACE_FIX_KEYS = {"zip", "placeGeoid", "placeName", "state", "evidence"}
PLACE_ALIAS_KEYS = {"city", "state", "placeGeoid", "placeName", "evidence"}
CITY_COUNTY_KEYS = {"city", "state", "countyGeoid", "countyName", "evidence"}
Q1A_STATES = ("CT", "MA", "ME", "NH", "RI", "VT", "NJ", "NY", "PA")
KINDS = (("conferences", "c"), ("national", "n"), ("showcases", "s"))


class BuildError(Exception):
    """The archive holds something the format cannot represent without dropping a fact."""


# ---------- where things are ----------

def search_dir():
    return os.path.join(api.ARCHIVE_DIR, "search")


def inputs_dir(base=None):
    return os.path.join(base, "public", "data") if base else os.path.join(api.PUBLIC_DIR, "data")


class Archive:
    """The committed archive: this checkout through ecnl_api (so a test's patched reader applies),
    or another checkout's files under `root` (the frozen fixture, #158 MF6)."""

    def __init__(self, root=None):
        self.root = root

    def _api(self, path):
        if self.root:
            try:
                with open(os.path.join(self.root, "public", "archive", "api", path + ".json"), "rb") as f:
                    raw = f.read()
            except OSError:
                return None
        else:
            raw = api.read_archive(path)[0]
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def hierarchy(self, eid):
        return self._api(api.p_hierarchy(eid))

    def standings(self, div, flight, eid):
        return self._api(api.p_standings(div, flight, eid))

    def schedule(self, eid, flight):
        return self._api(api.p_schedule(eid, flight))

    def schedule_flights(self, eid):
        """Flight ids with a schedule file on disk for this event, sorted."""
        base = os.path.join(self.root, "public", "archive", "api") if self.root else api.ARCHIVE_API_DIR
        d = os.path.join(base, "Event", "get-schedules-by-flight", str(eid))
        try:
            return sorted(int(x) for x in os.listdir(d) if x.isdigit() and os.path.exists(os.path.join(d, x, "0.json")))
        except OSError:
            return []

    def sources(self):
        if self.root:
            return api.load_sources(os.path.join(self.root, "public", "data", "sources.json"))
        return api.load_sources()

    def directory(self):
        path = os.path.join(self.root, "public", "archive", "directory.json") if self.root else os.path.join(api.ARCHIVE_DIR, "directory.json")
        with open(path, "rb") as f:
            return json.loads(f.read().replace(b"\r\n", b"\n"))


# ---------- reviewed inputs ----------

def norm_name(name):
    """A complex name as a key: NFKC, lower case, punctuation dropped, whitespace collapsed. A
    placeholder (TBD, TBA, To Be Determined) is no name."""
    n = unicodedata.normalize("NFKC", str(name or "")).lower()
    n = " ".join(re.sub(r"[^a-z0-9 ]+", "", " ".join(n.split())).split())
    return "" if PLACEHOLDER.match(n) else n


def _load(path, key, label):
    if not os.path.exists(path):
        return [], [f"{label}: missing; no entry applied"]
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        return [], [f"{label}: unreadable ({e}); no entry applied"]
    if not isinstance(doc, dict) or doc.get("schema") != 1 or not isinstance(doc.get(key), list):
        return [], [f'{label}: not {{"schema": 1, "{key}": [...]}}; no entry applied']
    return doc[key], []


def load_aliases(base=None):
    """public/data/field-aliases.json (#158 Q3): {(alias, zip): (name, label)}, and an error per
    entry left out. Each entry is {name, zip, label, aliases, evidence}: a canonical field name
    used once per zip, a 5-digit zip, a display label, aliases already in norm_name form, never
    one alias for two fields at one zip, and evidence."""
    entries, errors = _load(os.path.join(inputs_dir(base), "field-aliases.json"), "fields", "field-aliases.json")
    out, names = {}, set()
    for i, e in enumerate(entries):
        label = f"field-aliases.json fields[{i}]"
        why = None
        if not isinstance(e, dict):
            why = "not an object"
        elif set(e) - ALIAS_KEYS or ALIAS_KEYS - set(e):
            why = f"keys must be {sorted(ALIAS_KEYS)}"
        elif not all(isinstance(e[k], str) and e[k].strip() for k in ("name", "label", "evidence")):
            why = "name, label and evidence must be non-empty text"
        elif not re.fullmatch(r"\d{5}", e["zip"] if isinstance(e["zip"], str) else ""):
            why = "zip must be 5 digits"
        elif (e["name"], e["zip"]) in names:
            why = "a name already used at this zip"
        elif not isinstance(e["aliases"], list) or not e["aliases"] or any(not isinstance(a, str) or norm_name(a) != a or not a for a in e["aliases"]):
            why = "aliases must be a non-empty list of normalised names (lower case, no punctuation)"
        elif any((a, e["zip"]) in out for a in e["aliases"]):
            why = "an alias already used at this zip"
        if why:
            errors.append(f"{label}: {why}; skipped")
            continue
        names.add((e["name"], e["zip"]))
        for a in e["aliases"]:
            out[(a, e["zip"])] = (e["name"], e["label"])
    return out, errors


def load_fixes(base=None):
    """public/data/zip-fixes.json (#158 MF5): {raw: zip or None} for zips TGS holds malformed, each
    with evidence. Applied after whitespace and ZIP+4, before any inference from the name. A null
    zip means "known bad, unknown": no zip, and never inferred from the name either."""
    entries, errors = _load(os.path.join(inputs_dir(base), "zip-fixes.json"), "fixes", "zip-fixes.json")
    out = {}
    for i, e in enumerate(entries):
        label = f"zip-fixes.json fixes[{i}]"
        why = None
        if not isinstance(e, dict) or set(e) != FIX_KEYS:
            why = f"keys must be {sorted(FIX_KEYS)}"
        elif not isinstance(e["raw"], str) or not e["raw"] or e["raw"] != e["raw"].strip() or re.fullmatch(r"\d{5}(?:-\d{4})?", e["raw"]):
            why = "raw must be a stripped value that is not already a zip"
        elif e["zip"] is not None and not (isinstance(e["zip"], str) and re.fullmatch(r"\d{5}", e["zip"])):
            why = "zip must be 5 digits, or null for a known-bad value"
        elif not isinstance(e["evidence"], str) or not e["evidence"].strip():
            why = "no evidence"
        elif e["raw"] in out:
            why = "raw already fixed"
        if why:
            errors.append(f"{label}: {why}; skipped")
            continue
        out[e["raw"]] = e["zip"]
    return out, errors


def zip5(raw, fixes):
    """(#158 MF5) Strip whitespace; ZIP+4 -> its first 5 digits; then the reviewed fix list.
    Anything else is no zip. Returns (zip, rejected raw value or None, fixed): `fixed` is True when
    the fix list decided, so a null fix is never overridden by inference."""
    z = str(raw if raw is not None else "").strip()
    m = re.fullmatch(r"(\d{5})(?:-\d{4})?", z)
    if m:
        return m.group(1), None, False
    if z in fixes:
        return fixes[z] or "", None, True
    return "", (z or None), False


# ---------- games ----------

def undate_borrowed_dates(games):
    """A port of index.html's undateBorrowedDates (#66), line for line; parity-tested in Node on
    tests/search/fixtures/borrowed-dates.json. TGS can list both legs of a home-and-away pairing
    on one date, one leg with no time, venue or score: that leg becomes undated (gameDate None,
    dateUnconfirmed True), when the reversed pairing on that date has a score, a time or a venue.
    Conference events only; inputs are not mutated."""
    def slotted(g):
        return (g.get("hometeamscore") is not None or g.get("awayteamscore") is not None
                or not re.search(r"T00:00:00$", g.get("gameDate") or "") or bool(g.get("complex") or g.get("venue")))

    def dated(g):
        return g.get("hometeamID") is not None and g.get("awayteamID") is not None and bool(g.get("gameDate"))

    def key(home, away, g):
        return f"{home}>{away}@{g['gameDate'][:10]}"
    slots = {key(g["hometeamID"], g["awayteamID"], g) for g in games if dated(g) and slotted(g)}
    return [dict(g, gameDate=None, dateUnconfirmed=True)
            if dated(g) and not slotted(g) and key(g["awayteamID"], g["hometeamID"], g) in slots else g
            for g in games]


def season_base(season):
    """Day 0 of a season's dates: 1 July of its first year (from the key, never the clock)."""
    return datetime.date(int(season[:4]), 7, 1)


def encode_when(game_date, base):
    """(#158 MF4) day offset * 10000 + HHMM, HHMM 9999 when there is no time (T00:00:00). None
    for no date: empty, or a year before 1900 (TGS's 0001-01-01 sentinel), as the page reads it."""
    d = game_date or ""
    if not d or not re.match(r"\d{4}-\d{2}-\d{2}", d) or int(d[:4]) < 1900:
        return None
    day = (datetime.date.fromisoformat(d[:10]) - base).days
    t = d[11:16]
    return day * 10000 + (NO_TIME if t in ("", "00:00") else int(t[:2]) * 100 + int(t[3:5]))


def decode_when(when, base):
    """(date 'YYYY-MM-DD', time 'HH:MM' or None), or (None, None). Floor division, so a day
    before the base (a negative offset) decodes as the right day."""
    if when is None:
        return None, None
    day, hhmm = when // 10000, when % 10000
    date = (base + datetime.timedelta(days=day)).isoformat()
    return date, None if hhmm == NO_TIME else f"{hhmm // 100:02d}:{hhmm % 100:02d}"


def field_number(venue):
    """`Field 08` = `Field #08` = 8; other venue text kept as text; none as None."""
    v = " ".join(str(venue or "").split())
    m = re.fullmatch(r"field\s*#?\s*0*(\d+)", v, re.I)
    return int(m.group(1)) if m else (v or None)


def _blocks(payload):
    """The standings blocks the page uses: non-empty ones only (team_history's loader)."""
    sd = (payload or {}).get("data")
    return [b for b in (sd if isinstance(sd, list) else [sd]) if b and b.get("teamStandings")]


def _richness(g):
    return (g.get("hometeamscore") is not None and g.get("awayteamscore") is not None,
            not re.search(r"T00:00:00$", g.get("gameDate") or "T00:00:00"),
            bool(g.get("complex") or g.get("venue")))


def collect(arc, sources, report):
    """Every game of every catalog event, once, as {season: {matchID: (game, ctx)}}. A game's ctx
    holds its event, division, flight and destination code (#158 MF1):
      [1, 0] / [1, 1]  conference: the Matches view for the division, home (0) or away (1) selected,
                       the first side in the division's standings (every flight of it, merged)
      [1]              conference: neither side in the division's standings; the view still lists it
      [2]              national: in the bracket (team_history.knockout_games, as the page)
      [3]              national: not TBD and not in the bracket (the Schedule view lists the flight)
      [4]              showcase
      [0]              a TBD side, or a flight the event's hierarchy does not list
    """
    import team_history
    out = collections.defaultdict(dict)
    flights_of = {}
    for season in sorted(sources["seasons"]):
        entry = sources["seasons"][season]
        for kind, k in KINDS:
            for name in sorted(entry.get(kind) or {}):
                ev = entry[kind][name]
                eid = ev.get("eventId") if isinstance(ev, dict) else None
                if not eid:
                    continue
                gaps = {key: v for key, v in (ev.get("dataGaps") or {}).items() if not key.startswith("_")}
                h = arc.hierarchy(eid) or {}
                divs = sorted((h.get("data") or {}).get("girlsDivAndFlightList") or [], key=lambda d: d["divisionID"])
                reached = set()
                for d in divs:
                    fl = sorted(d.get("flightList") or [], key=lambda f: f["flightID"])
                    blocks = {f["flightID"]: _blocks(arc.standings(d["divisionID"], f["flightID"], eid)) for f in fl}
                    members = {t.get("teamID") for f in fl for b in blocks[f["flightID"]] for t in b["teamStandings"]}
                    for f in fl:
                        fid = f["flightID"]
                        reached.add(fid)
                        games = (arc.schedule(eid, fid) or {}).get("data") or []
                        if k == "c":
                            games = undate_borrowed_dates(games)
                        omit = set(((gaps.get(str(fid)) or {}).get("omitFromBracket")) or [])
                        ko = {g.get("matchID") for g in team_history.knockout_games(games, blocks[fid], omit)} if k == "n" else set()
                        for g in games:
                            tbd = g.get("hometeamID") is None or g.get("awayteamID") is None
                            if k == "c":
                                dest = [0] if tbd else [1, 0] if g["hometeamID"] in members else [1, 1] if g["awayteamID"] in members else [1]
                            elif k == "n":
                                dest = [2] if g.get("matchID") in ko else [0] if tbd else [3]
                            else:
                                dest = [0] if tbd else [4]
                            _add(out, flights_of, season, g, (eid, k, d.get("divisionName") or "", fid, f.get("flightName") or ""), dest, report)
                for fid in arc.schedule_flights(eid):
                    if fid in reached:
                        continue
                    report["schedule files the hierarchy does not list (no link)"].append(f"{season} event {eid} flight {fid}")
                    games = (arc.schedule(eid, fid) or {}).get("data") or []
                    if k == "c":
                        games = undate_borrowed_dates(games)
                    for g in games:
                        _add(out, flights_of, season, g, (eid, k, g.get("division") or "", fid, g.get("flight") or ""), [0], report)
    return out


def _add(out, flights_of, season, g, flight, dest, report):
    mid = g.get("matchID")
    if not isinstance(mid, int) or isinstance(mid, bool):
        report["rows with no integer matchID (left out)"].append(f"{season} flight {flight[3]}")
        return
    fid = flight[3]
    if flights_of.setdefault(fid, flight) != flight:
        raise BuildError(f"flight {fid} is listed under two events or divisions: {flights_of[fid]} and {flight}")
    for s, games in out.items():
        if s != season and mid in games:
            raise BuildError(f"match {mid} is in two seasons ({s} and {season})")
    have = out[season].get(mid)
    if have is not None:
        a, b = have[0], g
        facts = lambda x: (x.get("gameDate"), x.get("hometeamID"), x.get("awayteamID"), x.get("hometeamscore"), x.get("awayteamscore"))
        if facts(a) != facts(b):
            report["duplicate matchIDs whose copies differ (the fuller copy is kept)"].append(f"{mid}")
        else:
            report["duplicate matchIDs (kept once)"].append(f"{mid}")
        # (#155) the copy with a score, then a time, then a venue; then the lowest (event, flight)
        if (_richness(b), [-flight[0], -fid]) <= (_richness(a), [-have[1][0], -have[1][3]]):
            return
    out[season][mid] = (g, flight, dest)


def fields_of(games_by_season, fixes, aliases, report):
    """complexID -> (field name, zip) and per-field facts (#158 MF5, D6/D6a). Zip: strip, ZIP+4,
    the fix list, then, for a game with no zip, the zip of its normalised name when that name has
    exactly one valid zip in the archive. Name: the reviewed alias for (name, zip), else the
    normalised name. A complexID with two field keys is a BuildError (MF7)."""
    name_zips = collections.defaultdict(set)
    rows = []
    for season in sorted(games_by_season):
        for mid in sorted(games_by_season[season]):
            g = games_by_season[season][mid][0]
            n = norm_name(g.get("complex"))
            z, bad, fixed = zip5(g.get("zip"), fixes)
            if bad is not None:
                report["zips that are not 5 digits and not in zip-fixes.json (no zip)"].append(f"{bad!r} (match {mid})")
            if n and z:
                name_zips[n].add(z)
            rows.append((season, mid, g, n, z, fixed))
    for n in sorted(name_zips):
        if len(name_zips[n]) > 1:
            report["names with more than one valid zip (no zip is inferred for them)"].append(f"{n}: {', '.join(sorted(name_zips[n]))}")
    by_cid, facts = {}, {}
    variants = collections.defaultdict(collections.Counter)
    for season, mid, g, n, z, fixed in rows:
        if not n:
            continue
        cid = g.get("complexID")
        if not z and not fixed and len(name_zips[n]) == 1:
            z = next(iter(name_zips[n]))
        canon, label = aliases.get((n, z), (n, None))
        key = (canon, z)
        if cid is None:
            raise BuildError(f"match {mid} has a complex name and no complexID")
        if by_cid.setdefault(cid, key) != key:
            raise BuildError(f"complex {cid} maps to two fields: {by_cid[cid]} and {key}")
        f = facts.setdefault(key, {"label": label, "seasons": collections.Counter(), "numbers": set(), "complexIDs": set(), "spellings": collections.Counter()})
        f["seasons"][season] += 1
        f["complexIDs"].add(cid)
        num = field_number(g.get("venue"))
        if num is not None:
            f["numbers"].add(num)
        f["spellings"][" ".join(str(g.get("complex")).split())] += 1
        variants[z][n] += 1
    for z in sorted(variants):
        if z and len(variants[z]) > 1:
            report["zips with more than one complex name (alias candidates; never merged automatically)"].append(
                f"{z}: " + "; ".join(f"{n} ({c})" for n, c in sorted(variants[z].items())))
    return by_cid, facts


def _num_key(v):
    return (0, v, "") if isinstance(v, int) else (1, 0, str(v))


def games_rows(season, games, by_cid):
    """The games file document for one season (#158 MF2, MF4, MF7)."""
    base = season_base(season)
    flights, names, rows = {}, collections.defaultdict(set), []
    kind_of = {}
    for mid in sorted(games):
        g, (eid, k, div, fid, fname), dest = games[mid]
        flights[fid] = [eid, k, div, fname]
        kind_of[eid] = k
        sides = []
        for side, team, club in (("home", "homeTeam", "homeTeamClubID"), ("away", "awayTeam", "awayTeamClubID")):
            tid = g.get(side + "teamID")
            name = " ".join(str(g.get(team) or "").split())
            if tid is None:
                sides.append(name or None)           # a TBD side keeps its own name inline
            else:
                names[(tid, eid)].add((name, g.get(club)))
                sides.append(tid)
        flags = ((F_BRACKET if g.get("type") == "Bracket" else 0) | (F_UNDATED if g.get("dateUnconfirmed") else 0)
                 | (F_RECONSTRUCTED if g.get("reconstructed") else 0) | (F_FRIENDLY if g.get("friendly") else 0)
                 | (F_BYE if any(g.get(s + "teamID") is None and BYE.match(str(g.get(t) or "").strip())
                                 for s, t in (("home", "homeTeam"), ("away", "awayTeam"))) else 0))
        cid = g.get("complexID") if g.get("complexID") in by_cid else None
        row = [mid, encode_when(g.get("gameDate"), base), fid, sides[0], sides[1], g.get("hometeamscore"), g.get("awayteamscore"),
               g.get("hometeamPKscore"), g.get("awayteamPKscore"), cid, field_number(g.get("venue")) if cid is not None else None,
               flags or None, dest]
        rows.append(row)
    for key, vals in names.items():
        if len(vals) > 1:
            raise BuildError(f"team {key[0]} has more than one name or club at event {key[1]}: {sorted(vals, key=str)}")
    teams, alt = {}, {}
    by_team = collections.defaultdict(list)
    for (tid, eid) in names:
        by_team[tid].append(eid)
    for tid in sorted(by_team):
        evs = sorted(by_team[tid])
        conf = [e for e in evs if kind_of[e] == "c"]
        home_ev = conf[0] if conf else evs[0]
        base_val = list(next(iter(names[(tid, home_ev)])))
        teams[tid] = base_val
        for e in evs:
            v = list(next(iter(names[(tid, e)])))
            if v != base_val:
                alt[f"{tid}:{e}"] = v
    fields = {cid: list(by_cid[cid]) for cid in sorted({r[9] for r in rows if r[9] is not None})}
    return {"schema": GAMES_SCHEMA, "season": season, "base": base.isoformat(),
            "flights": flights, "teams": teams, "alt": alt, "fields": fields, "games": rows}


def _j(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _table(name, d, order):
    if not d:
        return f'"{name}":{{}}'
    lines = [f"{_j(str(k))}:{_j(d[k])}" for k in sorted(d, key=order)]
    return f'"{name}":{{\n' + "\n,".join(lines) + "\n}"


def _alt_order(k):
    t, e = k.split(":")
    return (int(t), int(e))


def dump_games(doc, build=None):
    """One table entry or game per line, commas leading. matchIDs are stored as the difference
    from the row before (the first one whole); trailing nulls are dropped."""
    rows, prev = [], 0
    for r in doc["games"]:
        r = list(r)
        r[0], prev = r[0] - prev, r[0]
        while r and r[-1] is None:
            r.pop()
        rows.append(_j(r))
    head = [f'"schema":{doc["schema"]}', f'"season":{_j(doc["season"])}', f'"base":{_j(doc["base"])}']
    if build is not None:
        head.append(f'"build":{_j(build)}')
    parts = head + [_table("flights", doc["flights"], int), _table("teams", doc["teams"], int),
                    _table("alt", doc["alt"], _alt_order), _table("fields", doc["fields"], int),
                    '"games":[\n' + "\n,".join(rows) + "\n]"]
    return ("{" + "\n,".join(parts) + "}\n").encode("utf-8")


def build_id(data):
    return hashlib.sha256(data).hexdigest()[:BUILD_LEN]


def with_build(dump, doc):
    """A file's bytes with its own build id: the sha256 of the dump without it."""
    return dump(doc, build_id(dump(doc)))


def decode_games(doc):
    """The games file as one dict per game (the Python twin of tests/search/search-data-format.mjs)."""
    base = datetime.date.fromisoformat(doc["base"])
    out, prev = [], 0
    for r in doc["games"]:
        r = list(r) + [None] * (len(ROW) - len(r))
        mid = r[0] + prev
        prev = mid
        eid, kind, div, fname = doc["flights"][str(r[2])]
        date, time = decode_when(r[1], base)

        def side(v):
            if isinstance(v, int) and not isinstance(v, bool):
                name, club = doc["alt"].get(f"{v}:{eid}") or doc["teams"][str(v)]
                return {"teamID": v, "name": name, "clubID": club}
            return {"teamID": None, "name": v, "clubID": None}
        field = doc["fields"][str(r[9])] if r[9] is not None else None
        out.append({"matchID": mid, "date": date, "time": time, "flightID": r[2], "eventID": eid, "kind": kind,
                    "division": div, "flightName": fname, "home": side(r[3]), "away": side(r[4]),
                    "score": [r[5], r[6]], "pk": [r[7], r[8]],
                    "field": None if field is None else {"complexID": r[9], "name": field[0], "zip": field[1]},
                    "number": r[10], "flags": r[11] or 0, "dest": r[12]})
    return out


# ---------- reviewed orphan team ids (#179) ----------
#
# public/data/orphan-team-ids.json: a team id that has games in a season but no conference row that season (TGS's
# published table leaves it out), attached to the squad it belongs to as an alias id (`x`), so head to head and search
# find its games. A reviewed list with evidence per id, never a rule: TGS reuses ids across birth years. Every entry is
# re-checked here against this build's archive on every build; an entry failing any check is left out and reported with
# every reason it fails (so no check hides another), which fails the run and `python archive.py --search-data --check`.
# The checks (docs/data-api.md, "Search data"; plan v2 / v2.1 on #179):
#   level      no game in a Regional League flight, no TGS name with RL, Pre-ECNL or US Club (another programme)
#   regroup    never onto a squad that starts in 2026-27 or later from an earlier season (#107 M6: a candidate only)
#   club       the TGS club on every game is the squad's club, and `clubID` says so
#   birth year `birthYears` is the squad's; at least one conference game (else unproven), and every conference
#              division TGS placed the id in that season has the squad's birth year (TGS reuses ids across birth years)
#   continuity the squad has a row with this id in an adjacent season
#   clash      the squad has no conference row that season; the key is no catalog teamAliases key; a (season, id) is
#              listed once; one reviewed id per squad per season (every entry of such a group fails, in any file order)
#   stale      no squad has a conference row for the key: once TGS publishes it, the entry must be removed (Q7)
#   name       `name` is TGS's name for it that season, and its club part (team_history.stem) is the squad's, or an
#              owner-approved `renamed` {from, to, approved} says exactly which rename it is
#   games      `games` is the archive's count; `evidence` is non-empty
ORPHAN_FILE = "orphan-team-ids.json"
ORPHAN_KEYS = {"season", "teamID", "squad", "name", "clubID", "birthYears", "games", "evidence"}
ORPHAN_OPTIONAL = {"renamed"}
RENAMED_KEYS = {"from", "to", "approved"}
ORPHAN_LEVEL = re.compile(r"(\bRL\b|pre\W*ecnl|\bUS Club\b)", re.I)
APPROVED = re.compile(r"^https://github\.com/NextOneTwoLabs/ecnl-dashboard/issues/\d+#issuecomment-\d+$")
REGROUP_SEASON = "2026-27"


def load_orphans(base=None):
    """public/data/orphan-team-ids.json (#179): its entries, and an error when it is unreadable or malformed. A
    missing file is no entries."""
    path = os.path.join(inputs_dir(base), ORPHAN_FILE)
    if not os.path.exists(path):
        return [], []
    return _load(path, "orphans", ORPHAN_FILE)


def _is_int(v):
    return type(v) is int


def orphan_games(doc, t):
    """[(kind, division, flight name, TGS name, TGS club)] for each game of team id t in one season's games document
    (as built, or as read from its file)."""
    out = []
    for row in doc["games"]:
        if t in (row[3], row[4]):
            eid, kind, div, fname = doc["flights"].get(row[2]) or doc["flights"][str(row[2])]
            nm, cl = doc["alt"].get(f"{t}:{eid}") or doc["teams"].get(t) or doc["teams"][str(t)]
            out.append((kind, div, fname, nm, cl))
    return out


def orphan_problems(e, teams, gdocs, owner, first, aliases):
    """Every check entry e fails on its own, as reasons (none: valid). The checks across entries are validate_orphans'."""
    import team_history
    stem = team_history.stem
    if not isinstance(e, dict):
        return ["shape: not an object"]
    if set(e) - ORPHAN_KEYS - ORPHAN_OPTIONAL or ORPHAN_KEYS - set(e):
        return [f"shape: keys must be {sorted(ORPHAN_KEYS)} plus optional 'renamed'"]
    s, t, by = e["season"], e["teamID"], e["birthYears"]
    if not (isinstance(s, str) and _is_int(t) and isinstance(e["squad"], str) and isinstance(e["name"], str) and _is_int(e["clubID"])
            and _is_int(e["games"]) and isinstance(by, list) and by and all(_is_int(y) for y in by) and by == sorted(set(by))):
        return ["shape: season, squad and name are strings, teamID, clubID and games integers, birthYears sorted distinct integers"]
    bad = []
    if not isinstance(e["evidence"], str) or not e["evidence"].strip():
        bad.append("evidence: none")
    S, SQ = teams["seasons"], teams["squads"]
    if s not in S or s not in gdocs:
        return bad + ["season: not in the archive"]
    mine = orphan_games(gdocs[s], t)
    if not mine:
        return bad + ["games: no game with this team id in this season"]
    si = S.index(s)
    if (s, t) in owner:
        bad.append(f"stale: TGS now has a conference row for it (squad {owner[(s, t)]}), remove this entry")
    if (si, t) in aliases:
        bad.append("clash: a catalog teamAliases key")
    if len(mine) != e["games"]:
        bad.append(f"games: the archive has {len(mine)}, the entry says {e['games']}")
    names = {m[3] for m in mine}
    if e["name"] not in names:
        bad.append(f"name: TGS calls it {sorted(names)}")
    if any(ORPHAN_LEVEL.search(m[3]) or "Regional League" in (m[2] or "") for m in mine):
        bad.append("level: an RL, Pre-ECNL, US Club or Regional League team is not the ECNL squad")
    i = first.get(e["squad"])
    if i is None:
        return bad + [f"squad: {e['squad']!r} is not a squad's first row"]
    sq = SQ[i]
    rows = sq["s"]
    if {m[4] for m in mine} != {e["clubID"]} or teams["clubs"][sq["c"]][0] != e["clubID"]:
        bad.append("club: not the squad's club on every game")
    band = {d: set(b) for x, d, _u, b in teams["divs"] if x == si}
    conf = [m for m in mine if m[0] == "c"]
    if by != sorted(sq["b"]):
        bad.append(f"birth year: the squad's are {sorted(sq['b'])}")
    if not conf:
        bad.append("birth year: unproven (no conference game, so no division TGS placed it in)")
    elif any(not band.get(m[1], set()) & set(sq["b"]) for m in conf):
        bad.append("birth year: a conference division of another birth year")
    if S[rows[0][0]] >= REGROUP_SEASON > s:
        bad.append(f"regroup: across the {REGROUP_SEASON} regroup (#107 M6: a candidate, never the squad)")
    adj = [r for r in rows if r[1] == t and abs(r[0] - si) == 1]
    if not adj:
        bad.append("continuity: no row with this id in an adjacent season")
    if any(r[0] == si for r in rows):
        bad.append("clash: the squad already has a conference row this season")
    stems = {stem(r[2]) for r in rows}
    ren = e.get("renamed")
    if ren is None:
        if any(stem(m[3]) not in stems for m in mine):
            bad.append("name: its club part is not the squad's (an owner-approved rename needs 'renamed')")
    elif not (isinstance(ren, dict) and set(ren) == RENAMED_KEYS and all(isinstance(v, str) for v in ren.values())):
        bad.append("name: 'renamed' must be {from, to, approved}")
    else:
        if any(stem(m[3]) != ren["from"] for m in mine):
            bad.append("name: renamed.from is not the club part of every TGS name that season")
        if not adj or any(stem(r[2]) != ren["to"] for r in adj):
            bad.append("name: renamed.to is not the club part of the squad's adjacent row with this id")
        if not APPROVED.match(ren["approved"]):
            bad.append("name: renamed.approved must link the owner's comment")
        if all(stem(m[3]) in stems for m in mine):
            bad.append("name: renamed is not needed (the club part already matches)")
    return bad


def validate_orphans(entries, teams, gdocs, aliases=frozenset()):
    """-> ({squad index: {(season index, teamID)}}, errors). `teams` is the directory (squads without `x`), `gdocs`
    this build's games documents by season, `aliases` the catalog's teamAliases keys as (season index, teamID). An
    entry failing any check is left out, with every reason; the checks across entries see the whole list first, so
    the result never depends on the file's order."""
    S, SQ = teams["seasons"], teams["squads"]
    owner, first = {}, {}
    for i, sq in enumerate(SQ):
        first[f"{S[sq['s'][0][0]]}/{sq['s'][0][1]}"] = i
        for r in sq["s"]:
            owner[(S[r[0]], r[1])] = i
    keyed = [(e.get("season"), e.get("teamID"), e.get("squad")) if isinstance(e, dict) else None for e in entries]
    times = collections.Counter((k[0], k[1]) for k in keyed if k)
    ids = collections.defaultdict(set)      # MF5: (squad, season) -> the reviewed ids
    for k in keyed:
        if k and isinstance(k[0], str) and isinstance(k[2], str) and _is_int(k[1]):
            ids[(k[2], k[0])].add(k[1])
    out, errors = collections.defaultdict(set), []
    for n, e in enumerate(entries):
        bad = orphan_problems(e, teams, gdocs, owner, first, aliases)
        k = keyed[n]
        if k and not any(b.startswith("shape:") for b in bad):
            if times[(k[0], k[1])] > 1:
                bad.append("clash: listed twice")
            if len(ids[(k[2], k[0])]) > 1:
                bad.append(f"clash: two reviewed ids for this squad this season ({', '.join(map(str, sorted(ids[(k[2], k[0])])))}), "
                           "one id per squad per season")
        label = f"{ORPHAN_FILE} orphans[{n}]" + (f" {k[0]}/{k[1]}" if k else "")
        if bad:
            errors.append(f"{label}: {'; '.join(bad)}; skipped")
            continue
        out[first[e["squad"]]].add((S.index(e["season"]), e["teamID"]))
    return out, errors

# ---------- core ----------

def strip_build(directory):
    return {k: v for k, v in directory.items() if k != "build"}


def directory_build(directory):
    """The team directory's build id: the sha256 of its dump without `build` (team_directory)."""
    import team_directory
    return team_directory.build_id(directory)


def core_doc(sources, directory, games_by_season, facts, aliases, orphans=(), gdocs=None, errors=None):
    """The core.json document. `orphans` are orphan-team-ids.json's entries (#179), checked against `gdocs` (this
    build's games documents by season); an error per entry left out goes to `errors`."""
    seasons = sorted(sources["seasons"])
    teams = strip_build(directory)
    teams = {k: v for k, v in teams.items() if k != "schema"}
    # x: a team id a squad played under at a showcase or national event but not in conference
    # (the catalog's teamAliases), so its games are found (#158 MF3 nit 2 of the design review);
    # and (#179) a reviewed orphan id: games in a season TGS's conference table left the id out of.
    first = {}
    for i, sq in enumerate(teams["squads"]):
        for r in sq["s"]:
            first[(teams["seasons"][r[0]], r[1])] = i
    extra = collections.defaultdict(set)
    for season in seasons:
        for kind, _k in KINDS[1:]:
            for _name, ev in sorted((sources["seasons"][season].get(kind) or {}).items()):
                for alias, conf in sorted((ev.get("teamAliases") or {}).items()):
                    i = first.get((season, conf))
                    if i is not None and str(alias).isdigit():
                        extra[i].add((teams["seasons"].index(season), int(alias)))
    got, errs = validate_orphans(orphans, teams, gdocs or {}, {k for v in extra.values() for k in v})
    if errors is not None:
        errors.extend(errs)
    for i, keys in got.items():
        extra[i] |= keys
    squads = []
    for i, sq in enumerate(teams["squads"]):
        if i in extra:
            sq = dict(sq, x=[list(p) for p in sorted(extra[i])])
        squads.append(sq)
    teams = dict(teams, squads=squads)

    events = {}
    played = collections.defaultdict(set)      # conference (season, conf) -> divisions with squads
    for sq in teams["squads"]:
        for r in sq["s"]:
            played[(teams["seasons"][r[0]], teams["confs"][r[3]])].add(teams["divs"][r[4]][1])
    span = collections.defaultdict(list)
    divs_of = collections.defaultdict(set)
    for season, games in games_by_season.items():
        base = season_base(season)
        lo, hi = base, datetime.date(base.year + 1, 7, 31)
        for mid, (g, (eid, k, div, fid, fname), dest) in games.items():
            divs_of[eid].add(div)
            if g.get("dateUnconfirmed"):
                continue
            w = encode_when(g.get("gameDate"), base)
            if w is None:
                continue
            d = datetime.date.fromisoformat(decode_when(w, base)[0])
            if lo <= d <= hi:
                span[eid].append(d.isoformat())
    for season in seasons:
        entry = sources["seasons"][season]
        for kind, k in KINDS:
            for name in sorted(entry.get(kind) or {}):
                ev = entry[kind][name]
                eid = ev.get("eventId") if isinstance(ev, dict) else None
                if not eid:
                    continue
                if k == "c":
                    start, end = (min(span[eid]), max(span[eid])) if span[eid] else (None, None)
                    ages = sorted(played[(season, name)])
                else:
                    start, end = ev.get("startDate"), ev.get("endDate")
                    ages = sorted(divs_of[eid])
                events[eid] = [season, k, name, ev.get("eventName") or "", ev.get("location") or "", start, end, ages]

    years = sorted({y for s in seasons for ag in (sources["seasons"][s].get("ageGroups") or {}).values()
                    for y in (ag.get("birthYears") or [])})
    vocab = {
        "confAliases": dict(sorted(CONF_ALIASES.items())),
        "states": STATES,
    }
    return {"schema": SCHEMA, "directoryBuild": directory_build(directory),
            "activeSeason": sources["refresh"]["activeSeason"], "seasons": seasons,
            "birthYears": [years[0], years[-1]] if years else [], "vocab": vocab,
            "events": events, "teams": teams}


def dump_core(doc, build=None):
    head = [f'"schema":{doc["schema"]}']
    if build is not None:
        head.append(f'"build":{_j(build)}')
    head += [f'"directoryBuild":{_j(doc["directoryBuild"])}', f'"activeSeason":{_j(doc["activeSeason"])}',
             f'"seasons":{_j(doc["seasons"])}', f'"birthYears":{_j(doc["birthYears"])}', f'"vocab":{_j(doc["vocab"])}',
             _table("events", doc["events"], int)]
    t = doc["teams"]
    thead = ",".join(f"{_j(k)}:{_j(v)}" for k, v in t.items() if k != "squads")
    head.append('"teams":{' + thead + ',"squads":[\n' + "\n,".join(_j(sq) for sq in t["squads"]) + "\n]}")
    return ("{" + "\n,".join(head) + "}\n").encode("utf-8")


# ---------- places (#159): fields, census places and counties ----------
#
# places.json holds everything about where: the fields (moved from core, which is schema 2 since),
# and the city and county of each field, club and event, from public/data/zip-places.json (the 2020
# Census ZCTA relationship files, built once by tools/census_places.py) and two reviewed files. It
# hardly grows with seasons, so core keeps its headroom (owner decision MF5 (a+)).
#
# The order, stated once (plan v2 MF2):
#   a club or event city's place:  zip-place-fixes.json `aliases`, else the one census place of that
#                                  normalised name in the state (a single incorporated one wins a
#                                  tie with CDPs), else none; two or more and no single winner: none,
#                                  reported, never a pick
#   its county:                    city-counties.json (which may override a census place's computed
#                                  county), else the place's computed county, else none, reported
#   a field zip's city:            zip-place-fixes.json `fixes`, else the table's area rule
#   a field zip's county:          the table's county file rule, always
# Game keys never depend on any of this: only places.json changes with the census inputs.

def norm_city(name):
    """One normalisation for club and event cities and census names (after the suffix is gone):
    NFKC, lower case, '.' and apostrophes dropped, other punctuation a space, whitespace collapsed,
    then st -> saint and mt -> mount word by word."""
    n = unicodedata.normalize("NFKC", str(name or "")).lower()
    n = re.sub(r"[.'’]", "", n)
    n = re.sub(r"[^a-z0-9]+", " ", n)
    words = [{"st": "saint", "mt": "mount"}.get(w, w) for w in n.split()]
    return " ".join(words)


def split_city(value):
    """'City, ST' -> (city, ST), or (None, None)."""
    v = str(value or "")
    at = v.rfind(", ")
    if at <= 0 or not re.fullmatch(r"[A-Z]{2}", v[at + 2:]):
        return None, None
    return v[:at], v[at + 2:]


def load_census(base=None):
    """public/data/zip-places.json, or None when it is not committed yet (reported, not fatal)."""
    path = os.path.join(inputs_dir(base), "zip-places.json")
    if not os.path.exists(path):
        return None, []
    try:
        with open(path, "rb") as f:
            doc = json.loads(f.read().replace(b"\r\n", b"\n"))
    except (OSError, ValueError) as e:
        return None, [f"zip-places.json: unreadable ({e})"]
    if not isinstance(doc, dict) or doc.get("schema") != 1 or not all(isinstance(doc.get(k), dict) for k in ("counties", "places", "zips")):
        return None, ["zip-places.json: not the census table schema 1"]
    return doc, []


def _read_doc(path, label, keys):
    """A reviewed file's lists, by name: ({list name: [entry]}, errors)."""
    if not os.path.exists(path):
        return {}, [f"{label}: missing; no entry applied"]
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        return {}, [f"{label}: unreadable ({e}); no entry applied"]
    if not isinstance(doc, dict) or doc.get("schema") != 1 or not all(isinstance(doc.get(k), list) for k in keys):
        return {}, [f"{label}: not {{\"schema\": 1, {', '.join(repr(k) for k in keys)}: [...]}}; no entry applied"]
    return {k: doc[k] for k in keys}, []


def _entries(entries, where, keys, errors):
    good = []
    for i, e in enumerate(entries):
        at = f"{where}[{i}]"
        if not isinstance(e, dict) or set(e) != keys:
            errors.append(f"{at}: keys must be {sorted(keys)}; skipped")
        elif not all(isinstance(e[k], str) and e[k].strip() for k in keys):
            errors.append(f"{at}: every value must be non-empty text; skipped")
        else:
            good.append((at, e))
    return good


def load_place_inputs(census, base=None):
    """The reviewed census corrections, checked against the table when it is committed:
    (zip fixes {zip: placeGeoid}, aliases {(city, ST): placeGeoid}, county overrides
    {(city, ST): countyGeoid}, errors). Without the table the entries are taken as written."""
    d = inputs_dir(base)
    fixes, aliases, counties = {}, {}, {}
    places = (census or {}).get("places") or {}
    cnty = (census or {}).get("counties") or {}
    zips = (census or {}).get("zips") or {}
    doc, errors = _read_doc(os.path.join(d, "zip-place-fixes.json"), "zip-place-fixes.json", ("fixes", "aliases"))
    for at, e in _entries(doc.get("fixes", []), "zip-place-fixes.json fixes", PLACE_FIX_KEYS, errors):
        why = None
        if not re.fullmatch(r"\d{5}", e["zip"]):
            why = "zip must be 5 digits"
        elif e["zip"] in fixes:
            why = "zip already fixed"
        elif census and places.get(e["placeGeoid"], [None, None])[:2] != [e["placeName"], e["state"]]:
            why = f"place {e['placeGeoid']} is not {e['placeName']}, {e['state']} in zip-places.json"
        elif census and (zips.get(e["zip"]) or [None])[0] == e["placeGeoid"]:
            why = "redundant: the area rule already gives this place"
        if why:
            errors.append(f"{at}: {why}; skipped")
        else:
            fixes[e["zip"]] = e["placeGeoid"]
    for at, e in _entries(doc.get("aliases", []), "zip-place-fixes.json aliases", PLACE_ALIAS_KEYS, errors):
        key = (norm_city(e["city"]), e["state"])
        if key in aliases:
            errors.append(f"{at}: city already aliased; skipped")
        elif census and places.get(e["placeGeoid"], [None, None])[:2] != [e["placeName"], e["state"]]:
            errors.append(f"{at}: place {e['placeGeoid']} is not {e['placeName']}, {e['state']} in zip-places.json; skipped")
        else:
            aliases[key] = e["placeGeoid"]
    doc, errs = _read_doc(os.path.join(d, "city-counties.json"), "city-counties.json", ("cities",))
    errors += errs
    for at, e in _entries(doc.get("cities", []), "city-counties.json cities", CITY_COUNTY_KEYS, errors):
        key = (norm_city(e["city"]), e["state"])
        if key in counties:
            errors.append(f"{at}: city already given a county; skipped")
        elif census and cnty.get(e["countyGeoid"]) != [e["countyName"], e["state"]]:
            errors.append(f"{at}: county {e['countyGeoid']} is not {e['countyName']}, {e['state']} in zip-places.json; skipped")
        else:
            counties[key] = e["countyGeoid"]
    return fixes, aliases, counties, errors


class Places:
    """Resolves club and event cities and field zips to [placeGeoid, countyGeoid] (MF2's order)."""

    def __init__(self, census, fixes, aliases, counties, report, errors):
        self.census, self.fixes, self.aliases, self.counties = census, fixes, aliases, counties
        self.report, self.errors = report, errors
        self.by_name = collections.defaultdict(list)
        for g, (name, st, _c, cls) in sorted(((census or {}).get("places") or {}).items()):
            self.by_name[(norm_city(name), st)].append((g, cls))
        self.used_county = set()
        self.place_county = {}          # a census place whose county a city-counties.json entry sets
        self.redundant = set()

    def place_of(self, city, st):
        key = (norm_city(city), st)
        if key in self.aliases:
            return self.aliases[key]
        found = self.by_name.get(key, [])
        if len(found) == 1:
            return found[0][0]
        inc = [g for g, cls in found if cls.startswith("C")]
        if len(inc) == 1:
            return inc[0]
        if found:
            self.report["cities matching two or more census places (no pick; add an alias with evidence)"].append(
                f"{city}, {st}: {', '.join(g for g, _ in found)}")
        return None

    def county_of_place(self, g, city, st):
        key = (norm_city(city), st)
        if key in self.counties:
            computed = self.census["places"][g][2] if g else None
            if computed == self.counties[key] and key not in self.redundant:
                self.redundant.add(key)
                self.errors.append(f"city-counties.json: {city}, {st} is redundant: its census place's county is already {computed}")
            self.used_county.add(key)
            if g:
                self.place_county[g] = self.counties[key]
            return self.counties[key]
        return self.census["places"][g][2] if g else None

    def city(self, value, what):
        city, st = split_city(value)
        if city is None or not self.census:
            return [None, None]
        g = self.place_of(city, st)
        c = self.county_of_place(g, city, st)
        if g is None and c is None:
            self.report["club and event cities with no census place and no county (add a city-counties.json entry with evidence)"].append(f"{value} ({what})")
        return [g, c]

    def zip(self, z, what):
        if not z or not self.census:
            return [None, None]
        row = self.census["zips"].get(z)
        if row is None:
            self.report["field zips that are not ZCTAs (no city, no county)"].append(f"{z} ({what})")
            return [None, None]
        g = self.fixes.get(z, row[0])
        if g is None and self.census["counties"].get(row[1], [None, None])[1] in Q1A_STATES:
            self.report["field zips with no census place in the county-subdivision states (Q1a; county kept)"].append(
                f"{self.census['counties'][row[1]][1]} {z} ({what})")
        return [g, row[1]]


def places_doc(sources, directory, games_by_season, facts, aliases, census, place_inputs, report, errors):
    fixes, city_aliases, county_overrides, _ = place_inputs
    pl = Places(census, fixes, city_aliases, county_overrides, report, errors)
    fields = {}
    for (name, z), f in sorted(facts.items()):
        label = f["label"] or sorted(f["spellings"].items(), key=lambda x: (-x[1], x[0]))[0][0]
        # key "name@zip"; value [label or null (null when it equals the key's name), [seasons with games],
        # [field numbers and other venue names], placeGeoid or null, countyGeoid or null].
        fields[f"{name}@{z}"] = [None if label == name else label, sorted(f["seasons"]),
                                 sorted(f["numbers"], key=_num_key)] + pl.zip(z, f"{label}")
    club_places = {}
    for c in directory["clubs"]:
        if c[3]:
            club_places[c[0]] = pl.city(c[3], f"club {c[0]}")
    event_places = {}
    for season in sorted(sources["seasons"]):
        for kind, _k in KINDS:
            for _name, ev in sorted((sources["seasons"][season].get(kind) or {}).items()):
                if isinstance(ev, dict) and ev.get("eventId") and ev.get("location"):
                    event_places[ev["eventId"]] = pl.city(ev["location"], f"event {ev['eventId']}")
    for key in sorted(set(county_overrides) - pl.used_county):
        report["city-counties.json entries no club or event uses"].append(f"{key[0]}, {key[1]}")
    used = [v[3:5] for v in fields.values()] + list(club_places.values()) + list(event_places.values())
    if census:
        places = {g: [census["places"][g][0], census["places"][g][1], pl.place_county.get(g, census["places"][g][2])]
                  for g in sorted({g for g, _c in used if g})}
        county_ids = {c for _g, c in used if c} | {v[2] for v in places.values() if v[2]}
        counties = {c: census["counties"][c] for c in sorted(county_ids)}
    else:
        places, counties = {}, {}
        report["census table (public/data/zip-places.json)"].append("not committed yet: no places or counties")
    return {"schema": PLACES_SCHEMA,
            "census": (census or {}).get("source", {}).get("content"),
            "vocab": {"fieldAliases": {a: aliases[(a, z)][0] for a, z in sorted(aliases)}},
            "counties": counties, "places": places, "clubPlaces": club_places, "eventPlaces": event_places,
            "fields": fields}


def dump_places(doc, build=None):
    head = [f'"schema":{doc["schema"]}']
    if build is not None:
        head.append(f'"build":{_j(build)}')
    head += [f'"census":{_j(doc["census"])}', f'"vocab":{_j(doc["vocab"])}',
             _table("counties", doc["counties"], str), _table("places", doc["places"], str),
             _table("clubPlaces", doc["clubPlaces"], int), _table("eventPlaces", doc["eventPlaces"], int),
             _table("fields", doc["fields"], str)]
    return ("{" + "\n,".join(head) + "}\n").encode("utf-8")


# ---------- the build ----------

def build(sources=None, directory=None, root=None, inputs=None, fixture=False):
    """{filename: bytes} for every search data file, plus (errors, report). Raises BuildError when
    a fact cannot be kept. `fixture` drops club logos (#117, as PR 1's fixtures) and recomputes
    directoryBuild over the stripped directory, so the fixture's pair check is about the pair."""
    arc = Archive(root)
    if sources is None:
        sources = arc.sources()
    if directory is None:
        directory = arc.directory()
    directory = json.loads(json.dumps(directory))
    if fixture:
        for c in directory["clubs"]:
            c[2] = None
    aliases, alias_errors = load_aliases(inputs)
    fixes, fix_errors = load_fixes(inputs)
    census, census_errors = load_census(inputs)
    place_inputs = load_place_inputs(census, inputs)
    report = collections.defaultdict(list)
    games = collect(arc, sources, report)
    statuses = collections.Counter(g.get("status") for s in games.values() for g, _f, _d in s.values())
    for v, n in sorted(statuses.items(), key=lambda x: str(x[0])):
        if v not in ("On Time", None):
            report["status values other than On Time (not kept; report only)"].append(f"{v!r}: {n}")
    by_cid, facts = fields_of({s: g for s, g in games.items()}, fixes, aliases, report)
    files = {}
    gdocs = {}
    orphans, orphan_errors = load_orphans(inputs)
    for season in sorted(games):
        doc = games_rows(season, games[season], by_cid)
        gdocs[season] = doc
        files[f"games-{season}.json"] = with_build(dump_games, doc)
    files["core.json"] = with_build(dump_core, core_doc(sources, directory, games, facts, aliases, orphans, gdocs, orphan_errors))
    place_errors = []
    files["places.json"] = with_build(dump_places, places_doc(sources, directory, games, facts, aliases, census,
                                                              place_inputs, report, place_errors))
    return files, alias_errors + fix_errors + census_errors + place_inputs[3] + place_errors + orphan_errors, report


def print_report(report, out=None):
    out = out or sys.stdout
    for k in sorted(report):
        items = report[k]
        print(f"Search data: {k}: {len(items)}", file=out)
        for x in items[:20]:
            print(f"  - {x}", file=out)
        if len(items) > 20:
            print(f"  - … and {len(items) - 20} more", file=out)


def _on_disk(path):
    try:
        with open(path, "rb") as f:
            return f.read().replace(b"\r\n", b"\n")
    except OSError:
        return None


def write(files, out_dir=None, dry_run=False):
    """Write the files whose bytes changed and remove search data files no longer built. Every new
    file is written to .tmp first; then the games files are moved into place, core last. A failure
    removes every .tmp file and raises; the files already moved stay (games before core, which is
    the harmless order: a games file never depends on core). Returns the names changed."""
    out_dir = out_dir or search_dir()
    changed = sorted(n for n, b in files.items() if _on_disk(os.path.join(out_dir, n)) != b)
    stale = sorted(n for n in (os.listdir(out_dir) if os.path.isdir(out_dir) else [])
                   if re.fullmatch(r"games-\d{4}-\d{2}\.json", n) and n not in files)
    if dry_run or not (changed or stale):
        return changed + stale
    os.makedirs(out_dir, exist_ok=True)
    order = sorted(changed, key=lambda n: (n == "core.json", n))
    tmps = []
    try:
        for n in order:
            tmp = os.path.join(out_dir, n + ".tmp")
            tmps.append(tmp)
            with open(tmp, "wb") as f:
                f.write(files[n])
        for n in order:
            os.replace(os.path.join(out_dir, n + ".tmp"), os.path.join(out_dir, n))
        for n in stale:
            os.remove(os.path.join(out_dir, n))
    except BaseException:
        for tmp in tmps:
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise
    return changed + stale


def check(files, out_dir=None):
    """The drift check: names of committed files that differ from `files`, are missing, or are
    no longer built."""
    out_dir = out_dir or search_dir()
    diff = [n for n in sorted(files) if _on_disk(os.path.join(out_dir, n)) != files[n]]
    extra = sorted(n for n in (os.listdir(out_dir) if os.path.isdir(out_dir) else [])
                   if n.endswith(".json") and n not in files)
    return diff + extra


def lf_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the search data files from a checkout's archive.")
    ap.add_argument("--root", required=True, help="the checkout whose archive is read (public/archive, public/data/sources.json)")
    ap.add_argument("--inputs", required=True, help="the checkout whose reviewed inputs are read (public/data/field-aliases.json, zip-fixes.json)")
    ap.add_argument("--out", required=True, help="the directory to write the files to")
    ap.add_argument("--fixture", action="store_true", help="drop club logos and write PROVENANCE.json (tests/search fixtures)")
    ap.add_argument("--commit", help="with --fixture: the commit --root is checked out at (recorded, not verified here)")
    args = ap.parse_args(argv)
    if args.fixture and not (args.commit and re.fullmatch(r"[0-9a-f]{7,40}", args.commit)):
        ap.error("--fixture needs --commit <sha>")
    files, errors, report = build(root=args.root, inputs=args.inputs, fixture=args.fixture)
    print_report(report)
    for e in errors:
        print(f"Search data: {e}")
    if errors:
        return 1
    os.makedirs(args.out, exist_ok=True)
    for n, b in sorted(files.items()):
        with open(os.path.join(args.out, n), "wb") as f:
            f.write(b)
    if args.fixture:
        prov = {"commit": args.commit,
                "builder": lf_sha(os.path.abspath(__file__)),
                "inputs": {n: (lf_sha(os.path.join(inputs_dir(args.inputs), n)) if os.path.exists(os.path.join(inputs_dir(args.inputs), n)) else None)
                           for n in INPUTS}}
        with open(os.path.join(args.out, "PROVENANCE.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(prov, indent=2, sort_keys=True) + "\n")
    print(f"Search data: {len(files)} files written to {args.out}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
