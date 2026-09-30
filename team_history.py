"""Team histories (#107): one squad across seasons and events.

Writes public/archive/history/<teamID>.json, served at /api/v1/teams/{teamID}/history, from
the committed archive only (no API calls): the per-season team indexes (#81), the conference
standings and schedules, the national events' schedules and standings, and the showcase
schedules (#97). Each file holds every squad its TGS team id belongs to: normally one, but TGS
sometimes reused an id for an age slot rather than its players, so an id can belong to two or
three squads. Run by `archive.py` after the team index (crawl, --refresh) and by
`python archive.py --team-history`; see docs/data-api.md "Team history" for the format.

A squad is a chain of conference team-seasons, linked season to season by these rules, in order:

  manual  public/data/team-links.json (hand-reviewed, like showcase teamAliases): a "link" entry
          joins two team-seasons, an "unlink" entry forbids a link. Every entry is validated
          here; an invalid, conflicting or doubly claimed entry is reported and has no effect.
  id      the same TGS team id, and the birth-year band ages correctly (next age group up; at
          the 2026-27 school-year regroup the old birth year must be in the new band).
  name    a new id with the same name (club part: age token and "ECNL" removed), which ages
          correctly, is the predecessor's only such candidate, and no other predecessor claims.
  club    a new id in the same club (never TGS's placeholder club 7, "No Club Selection") under
          the same conditions, when the name rule found no candidate at all.

Nothing is linked by name or club across the 2026-27 regroup, and an id TGS kept there in the
SAME age group (a club keeping its ids in their age slots) is not linked either (#107 M6): both
are offered as "maybe" (a possible continuation, shown with every candidate, never merged). A
candidate two predecessors could claim is never linked (M5), so the links do not depend on the
order of the input rows. Anything else ends the squad.

usage: python team_history.py [--stats] [--parity FILE]   (archive.py --team-history writes)
"""
import argparse
import collections
import json
import math
import os
import re
import sys

import ecnl_api as api

SCHEMA = 1
# Both follow ecnl_api's directories at call time (a test that moves the archive moves them
# too); set them to override.
HISTORY_DIR = None     # public/archive/history
LINKS_PATH = None      # public/data/team-links.json


def history_dir():
    return HISTORY_DIR or os.path.join(api.ARCHIVE_DIR, "history")


def links_path():
    return LINKS_PATH or os.path.join(api.PUBLIC_DIR, "data", "team-links.json")
NO_CLUB = 7            # TGS's placeholder club "No Club Selection": never a club identity
REGROUP = "2026-27"    # the first season of school-year age groups (two birth years per group)
AGE = re.compile(r"\b(G?U\d{1,2}(/U?\d{1,2})?( Composite)?|G?(19|20)\d{2}(/\d{2,4})?|G\d{2}(/\d{2})?)\b", re.I)
# A bracket round's depth, from the name the page's buildBrackets gives it (by its game count).
DEPTH = {"Final": 6, "Semifinals": 5, "Quarterfinals": 4, "Round of 16": 3, "Round of 32": 2}
LISTS = ("seasons", "postseason", "showcases", "maybe", "maybePrev")
MAX_REMOVALS = 20      # a build that would delete more history files than this (or 5 %) refuses


def stem(name):
    """A team name's club part: "MVLA ECNL G2010/11" -> "mvla"."""
    n = AGE.sub("", " ".join((name or "").split()))
    n = re.sub(r"\b(ecnl|encl)\b", "", n, flags=re.I)
    return " ".join(n.split()).lower()


def jraw(path):
    raw, _ = api.read_archive(path)
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def archived_games(event_id, flight_id):
    return ((jraw(api.p_schedule(event_id, flight_id)) or {}).get("data")) or []


def played(g):
    return g.get("hometeamscore") is not None and g.get("awayteamscore") is not None


def winner(g):
    """'home', 'away' or None, as the page's gameWinner: a level score goes to the shoot-out."""
    hs, as_ = g.get("hometeamscore"), g.get("awayteamscore")
    if hs is None or as_ is None:
        return None
    if hs != as_:
        return "home" if hs > as_ else "away"
    hp, ap = g.get("hometeamPKscore"), g.get("awayteamPKscore")
    if hp is not None and ap is not None and hp != ap:
        return "home" if hp > ap else "away"
    return None


def result_for(g, tid):
    if not played(g):
        return None
    w = winner(g)
    if not w:
        return "D"
    return "W" if (w == "home") == (g.get("hometeamID") == tid) else "L"


def sort_games(games):
    return sorted(games, key=lambda g: ((g.get("gameDate") or ""), (g.get("gameTime") or ""), g.get("gamenumber") or 0))


def record(games, tid):
    """W-D-L and goals from the played games; a shoot-out win counts as a win."""
    r = {"w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0}
    for g in games:
        x = result_for(g, tid)
        if not x:
            continue
        r[x.lower()] += 1
        home = g.get("hometeamID") == tid
        r["gf"] += g["hometeamscore"] if home else g["awayteamscore"]
        r["ga"] += g["awayteamscore"] if home else g["hometeamscore"]
    return r


def merge_blocks(payload):
    """The conference table as one list (archive.merge_standings_blocks), and the block count."""
    import archive   # late: archive imports this module
    blocks = payload if isinstance(payload, list) else ([payload] if payload else [])
    live = [b for b in blocks if isinstance(b, dict) and b.get("teamStandings")]
    return archive.merge_standings_blocks(payload), len(live)


# ---- a port of knockoutGames / buildBrackets (public/index.html); parity-tested in Node ----
def knockout_games(games, blocks, omit=()):
    if not any(g.get("gamenumber") for g in games):
        return []

    def undecided(g):
        return g.get("hometeamscore") is None and any(
            i is None and not re.fullmatch(r"bye", (n or ""), re.I)
            for i, n in ((g.get("hometeamID"), g.get("homeTeam")), (g.get("awayteamID"), g.get("awayTeam"))))
    games = [g for g in games if not undecided(g) and g.get("matchID") not in omit]
    if len(blocks) > 1 and all(b.get("flightGroupID") for b in blocks):
        games = [g for g in games if g.get("type") != "Bracket" or g.get("gamenumber") is not None]
    ko = not blocks and any(g.get("type") == "Bracket" for g in games)
    return [g for g in games if g.get("type") == "Bracket" or (ko and g.get("flightgroupID") is None)]


def bracket_name(path, flight, tier):
    if path == "":
        return tier
    cl = bool(re.search(r"champions league", flight or "", re.I))
    if path == "L1":
        return "Champions League Cup" if cl else "Round 1 Losers"
    if path == "L2":
        return "Round 2 Losers · Consolation"
    if path == "L1L1":
        return "Cup Consolation" if cl else "Round 1 Losers from Losers Bracket"
    m = re.match(r"^(.*)L(\d+)$", path)
    return f"Losers of {bracket_name(m.group(1), flight, tier)} R{m.group(2)}" if m else path


def build_brackets(games, flight, tier):
    srt = sort_games(games)
    state, paths = {}, {}

    def fresh():
        return {"path": "", "round": 0, "pending": None}

    def side_of(entry, i):
        return "home" if entry["game"].get("hometeamID") == i else "away"

    def settle(entry, ws):
        entry["winner"] = ws
        for k, i in enumerate((entry["game"].get("hometeamID"), entry["game"].get("awayteamID"))):
            s = state.get(i)
            if not s or s["pending"] is not entry:
                continue
            won = (ws == "home") == (k == 0)
            state[i] = ({"path": entry["path"], "round": entry["round"], "pending": None} if won
                        else {"path": entry["path"] + "L" + str(entry["round"]), "round": 0, "pending": None})

    for g in srt:
        ids = [g.get("hometeamID"), g.get("awayteamID")]
        st = [state.get(i) or fresh() for i in ids]
        for k, s in enumerate(st):
            if not s["pending"]:
                continue
            o = st[1 - k]
            if o["pending"]:
                continue
            me = side_of(s["pending"], ids[k])
            if o["path"] == s["path"] and o["round"] == s["round"]:
                settle(s["pending"], me)
            elif o["path"] == s["path"] + "L" + str(s["round"]):
                settle(s["pending"], "away" if me == "home" else "home")
            else:
                settle(s["pending"], me)
        st = [state.get(i) or fresh() for i in ids]
        for k, s in enumerate(st):
            if s["pending"]:
                settle(s["pending"], side_of(s["pending"], ids[k]))
        st = [state.get(i) or fresh() for i in ids]
        path = st[0]["path"]
        if st[0]["path"] != st[1]["path"]:
            path = st[0]["path"] if len(st[0]["path"]) <= len(st[1]["path"]) else st[1]["path"]
        rnd = 1 + max(st[0]["round"] if st[0]["path"] == path else 0, st[1]["round"] if st[1]["path"] == path else 0)
        w = winner(g)
        entry = {"game": g, "round": rnd, "winner": w, "path": path}
        paths.setdefault(path, []).append(entry)
        for k, i in enumerate(ids):
            if i is None:
                continue
            if w is None:
                state[i] = {"path": path, "round": rnd, "pending": entry}
            elif (w == "home") == (k == 0):
                state[i] = {"path": path, "round": rnd, "pending": None}
            else:
                state[i] = {"path": path + "L" + str(rnd), "round": 0, "pending": None}
    out = []
    for path, entries in paths.items():
        by = collections.defaultdict(list)
        for e in entries:
            by[e["round"]].append(e)
        rounds = [{"n": n, "games": sorted(by[n], key=lambda e: e["game"].get("gamenumber") or 0)} for n in sorted(by)]
        single = path != "" and len(rounds) == 1
        for r in rounds:
            n = len(r["games"])
            r["name"] = (("Consolation" if n == 1 else "Consolation games") if single else
                         "Final" if n == 1 else "Semifinals" if n == 2 else "Quarterfinals" if n == 4 else f"Round of {n * 2}")
        last = rounds[-1] if rounds else None
        fin = last["games"][0] if (path == "" and last and len(last["games"]) == 1) else None
        champ = None
        if fin and fin["winner"]:
            champ = fin["game"].get("hometeamID") if fin["winner"] == "home" else fin["game"].get("awayteamID")
        out.append({"path": path, "name": bracket_name(path, flight, tier), "rounds": rounds, "champion": champ,
                    "isMain": path == "", "final": fin})
    out.sort(key=lambda b: (len(b["path"]), b["path"]))
    return out


def in_round(r, tid):
    return any(tid in (e["game"].get("hometeamID"), e["game"].get("awayteamID")) for e in r["games"])


def reached(b, tid):
    names = [r["name"] for r in b["rounds"] if in_round(r, tid)]
    return names[-1] if names else None


def reached_label(b, tid):
    """reached(), for the history: a round whose size is not a power of two gets its bracket
    name from a game count TGS's data made odd (2021-22 Showcase Cup B's first round has nine
    games, the page's bracket calls it "Round of 18"); the history says "First round" instead."""
    for i, r in reversed(list(enumerate(b["rounds"]))):
        if in_round(r, tid):
            n = len(r["games"])
            if r["name"].startswith("Round of ") and n & (n - 1):
                return "First round" if i == 0 else f"Round {i + 1}"
            return r["name"]
    return None


def flight_outcomes(games, blocks, omit, flight_name, tier):
    """(main, cup) brackets of a national flight, as the page builds them."""
    ko = knockout_games(games, blocks, set(omit or ()))
    brackets = build_brackets(ko, flight_name, tier) if ko else []
    main = next((b for b in brackets if b["isMain"]), None)
    cup = next((b for b in brackets if b["path"] == "L1"), None)
    return ko, main, cup


# ---- the season rows ----
def season_rows(sources):
    """{season: [row]} for every team-season in a conference table, from the team indexes.
    A team is listed once per season (the 2025-26 play-in rows repeat teams)."""
    active = api_active_season(sources)
    rows = {}
    for season, sdata in sources["seasons"].items():
        idx = api.read_json_file(api.team_index_path(season))
        if not idx or idx.get("schema") != 1:
            continue
        ages = sdata.get("ageGroups") or {}
        start = int(sdata.get("startYear") or season[:4])
        flights, seen, out = {}, set(), []
        for r in idx["teams"]:
            if r["teamID"] in seen or r.get("flightName") == "Play-In-Game":
                continue
            seen.add(r["teamID"])
            fk = (r["eventID"], r["divisionID"], r["flightID"])
            if fk not in flights:
                merged, nblocks = merge_blocks((jraw(api.p_standings(r["divisionID"], r["flightID"], r["eventID"])) or {}).get("data"))
                flights[fk] = ({t.get("teamID"): t for t in merged}, len(merged), nblocks, archived_games(r["eventID"], r["flightID"]))
            table, n, nblocks, games = flights[fk]
            t = table.get(r["teamID"], {})
            ag = ages.get(r["division"]) or {}
            u = ag.get("u")
            if u is None:
                m = re.match(r"^G?U(\d+)", r["division"] or "")
                u = int(m.group(1)) if m else None
            band = sorted(ag.get("birthYears") or ([start + 1 - u] if u else []))
            mine = sort_games([g for g in games if r["teamID"] in (g.get("hometeamID"), g.get("awayteamID"))])
            done = [g for g in mine if played(g)]
            row = {
                "season": season, "teamID": r["teamID"], "name": " ".join((r["name"] or "").split()),
                "clubID": r["clubID"], "clubName": (r["clubName"] or "").strip(), "logo": r.get("clublogo"),
                "conference": r["conference"], "eventID": r["eventID"], "divisionID": r["divisionID"],
                "division": r["division"], "flightID": r["flightID"], "flightName": r["flightName"],
                "u": u, "birthYears": band, "rank": r["rank"], "of": n,
                "gp": t.get("gp"), "w": t.get("wins"), "d": t.get("draws"), "l": t.get("losses"),
                "pts": t.get("standingpoints"), "gf": t.get("goalsfor"), "ga": t.get("goalsagainst"),
                "gd": t.get("goaldifferential"), "ppg": t.get("ppg"),
                "form": "".join(result_for(g, r["teamID"]) for g in done[-5:]),
                "games": len(mine), "played": len(done),
            }
            if nblocks > 1:
                row["merged"] = True          # TGS published this table in two blocks; we merge them
            # M2: only the open season can be in progress; an unplayed game in a past season
            # (cancelled, never scored) does not make that season unfinished.
            if season == active and (not mine or len(done) < len(mine)):
                row["inProgress"] = True
            if season == REGROUP:
                row["regroup"] = True         # age groups by school year from here on
            out.append(row)
        rows[season] = out
    return rows


def api_active_season(sources):
    return (sources.get("refresh") or {}).get("activeSeason") or next(iter(sources["seasons"]))


def ages_on(a, b):
    """Does row b (the next season) age correctly from row a?"""
    if not a["u"] or not b["u"]:
        return False
    if b["season"] == REGROUP:
        return max(a["birthYears"]) in b["birthYears"] and b["u"] in (a["u"], a["u"] + 1)
    return b["u"] == a["u"] + 1 or (a["u"] >= 17 and b["u"] >= 18 and bool(set(a["birthYears"]) & set(b["birthYears"])))


def ends(r):
    """The top age group (and 2020-21's Composite) ends a squad's ECNL years."""
    return (r["u"] and r["u"] >= 18) or "Composite" in (r["division"] or "")


def next_season(seasons, s):
    i = seasons.index(s)
    return seasons[i + 1] if i + 1 < len(seasons) else None


def load_links(path=None):
    path = path or links_path()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, []
    except (OSError, ValueError) as e:
        return {}, [f"team-links.json: unreadable ({e}); no manual link or unlink applied"]
    if not isinstance(data, dict):
        return {}, ["team-links.json: not an object; no manual link or unlink applied"]
    return data, []


def parse_key(value):
    m = re.fullmatch(r"(20\d{2}-\d{2})/([1-9][0-9]*)", str(value or ""))
    return (m.group(1), int(m.group(2))) if m else None


def validate_links(manual, rows):
    """S1: every team-links.json entry checked against the archive. Returns (links, unlinks,
    errors): links {from: to}, unlinks {(from, to)}; an entry that fails is left out whole."""
    seasons = sorted(rows)
    byk = {(s, r["teamID"]): r for s in rows for r in rows[s]}
    errors, unlinks, cand = [], set(), []

    def check(kind, i, e):
        if not isinstance(e, dict):
            errors.append(f"team-links.json {kind}[{i}]: not an object")
            return None
        a, b = parse_key(e.get("from")), parse_key(e.get("to"))
        label = f"team-links.json {kind}[{i}] {e.get('from')} -> {e.get('to')}"
        if not a or not b:
            errors.append(f"{label}: 'from' and 'to' must read SEASON/TEAMID, e.g. 2025-26/54493")
            return None
        if a not in byk or b not in byk:
            errors.append(f"{label}: {'from' if a not in byk else 'to'} is not in any conference table")
            return None
        if next_season(seasons, a[0]) != b[0]:
            errors.append(f"{label}: 'to' must be in the season after 'from' ({next_season(seasons, a[0])})")
            return None
        if kind == "link" and not ages_on(byk[a], byk[b]):
            errors.append(f"{label}: does not age correctly ({byk[a]['division']} -> {byk[b]['division']})")
            return None
        if kind == "link" and not str(e.get("note") or "").strip():
            errors.append(f"{label}: needs a 'note' with the evidence")
            return None
        return a, b

    for i, e in enumerate(manual.get("unlink") or []):
        ab = check("unlink", i, e)
        if ab:
            unlinks.add(ab)
    for i, e in enumerate(manual.get("link") or []):
        ab = check("link", i, e)
        if ab:
            cand.append((i, ab))
    froms = collections.Counter(a for _, (a, _b) in cand)
    tos = collections.Counter(b for _, (_a, b) in cand)
    links = {}
    for i, (a, b) in cand:
        if froms[a] > 1 or tos[b] > 1:
            errors.append(f"team-links.json link[{i}] {a[0]}/{a[1]} -> {b[0]}/{b[1]}: "
                          f"{'from' if froms[a] > 1 else 'to'} is claimed by more than one link entry; none applied")
        elif (a, b) in unlinks:
            errors.append(f"team-links.json link[{i}] {a[0]}/{a[1]} -> {b[0]}/{b[1]}: also listed under unlink")
        else:
            links[a] = b
    return links, unlinks, errors


def link_seasons(rows, manual):
    """Season-to-season links. Returns (nxt, maybe, stats, errors): nxt {(s, id): ((s', id'),
    how)}, maybe {(s, id): [(s', id'), ...]} (possible continuations, never merged)."""
    seasons = sorted(rows)
    links, unlinks, errors = validate_links(manual, rows)
    nxt, maybe, stats = {}, {}, collections.Counter()
    for a, b in zip(seasons, seasons[1:]):
        regroup = b == REGROUP
        byid = {r["teamID"]: r for r in rows[b]}
        # The id rule first, so a manual link can be checked against it.
        auto = {}
        for r in rows[a]:
            k, n = (a, r["teamID"]), byid.get(r["teamID"])
            if ends(r) or not n or not ages_on(r, n) or (k, (b, n["teamID"])) in unlinks:
                continue
            if regroup and n["u"] == r["u"]:
                continue          # M6: TGS kept the id in its age slot; offered below, never merged
            auto[k] = (b, n["teamID"])
        mine = {k: v for k, v in links.items() if k[0] == a}
        for k, v in sorted(mine.items()):
            holder = next((p for p, t in auto.items() if t == v and p != k and p not in mine), None)
            if holder:
                errors.append(f"team-links.json link {k[0]}/{k[1]} -> {v[0]}/{v[1]}: the target continues "
                              f"{holder[0]}/{holder[1]} by its TGS id; unlink that first. Not applied")
                continue
            nxt[k] = (v, "manual")
            stats["manual"] += 1
        taken = {v for k, (v, _h) in nxt.items() if k[0] == a}
        for k, v in auto.items():
            if k not in nxt and v not in taken:
                nxt[k] = (v, "id")
                taken.add(v)
                stats["id"] += 1
        pend = []
        for r in rows[a]:
            k = (a, r["teamID"])
            if k in nxt:
                continue
            if ends(r):
                stats["ends: top age group"] += 1
                continue
            pend.append(r)
        free = [n for n in rows[b] if (b, n["teamID"]) not in taken]

        def cands(r, same):
            k = (a, r["teamID"])
            return [(b, n["teamID"]) for n in sorted(free, key=lambda n: n["teamID"])
                    if ages_on(r, n) and (k, (b, n["teamID"])) not in unlinks and same(n)]

        # Name, then club: every candidate list is computed before anything is linked, and a
        # candidate listed by two predecessors is linked to neither (M5).
        by_name = {(a, r["teamID"]): cands(r, lambda n, r=r: stem(n["name"]) == stem(r["name"])) for r in pend}
        # A team another predecessor lists by name is not a club candidate: the name is the
        # stronger claim. At the regroup nothing is linked anyway, so every club team that
        # ages correctly is offered (De Anza Force G12, #107 review).
        named = set() if regroup else {c for cs in by_name.values() for c in cs}
        by_club = {(a, r["teamID"]): cands(r, lambda n, r=r: n["clubID"] == r["clubID"] and (b, n["teamID"]) not in named)
                   for r in pend if not by_name[(a, r["teamID"])] and r["clubID"] != NO_CLUB}
        for how, table in (("name", by_name), ("club", by_club)):
            claims = collections.Counter(c for cs in table.values() for c in cs)
            for k, cs in sorted(table.items()):
                if not regroup and len(cs) == 1 and claims[cs[0]] == 1:
                    nxt[k] = (cs[0], how)
                    stats[how] += 1
        for r in pend:
            k = (a, r["teamID"])
            if k in nxt:
                continue
            cs = list(by_name.get(k) or by_club.get(k) or [])
            carry = byid.get(r["teamID"])
            if regroup and carry and ages_on(r, carry) and (b, carry["teamID"]) not in taken and (b, carry["teamID"]) not in cs \
                    and (k, (b, carry["teamID"])) not in unlinks:
                cs = sorted(cs + [(b, carry["teamID"])], key=lambda c: c[1])
            if cs:
                maybe[k] = cs
                stats["regroup: offered, not linked" if regroup else "ambiguous: offered, not linked"] += 1
                if regroup and carry and carry["u"] == r["u"] and (b, carry["teamID"]) in cs:
                    stats["regroup: same-age-group id carry (in the offered)"] += 1
            else:
                stats["no successor"] += 1
    return nxt, maybe, stats, errors


# ---- post-season and showcases ----
def tier_rank(tier):
    t = tier or ""
    if re.search(r"champions league", t, re.I):
        return 4
    if re.search(r"north american cup", t, re.I):
        return 3
    if re.search(r"open cup", t, re.I):
        return 2
    if re.search(r"showcase (cup|a\b)", t, re.I):
        return 1
    return 0


def stage_rank(stage):
    return 2 if re.search(r"finals", stage or "", re.I) else 1


def national_and_showcases(sources, rows):
    """(season, conference teamID) -> post-season entries, and -> showcase entries."""
    active = api_active_season(sources)
    post, shows = collections.defaultdict(list), collections.defaultdict(list)
    for season, sdata in sources["seasons"].items():
        known = {r["teamID"] for r in rows.get(season, [])}
        for kind, bucket in (("national", post), ("showcases", shows)):
            for stage, ev in (sdata.get(kind) or {}).items():
                eid = ev.get("eventId")
                h = jraw(api.p_hierarchy(eid)) if eid else None
                if not h:
                    continue
                alias = {int(k): v for k, v in (ev.get("teamAliases") or {}).items() if str(k).isdigit()}
                recon = set((ev.get("reconstructed") or {}).get("flightIds") or [])
                gaps = {k: v for k, v in (ev.get("dataGaps") or {}).items() if not k.startswith("_")}
                for d in (h.get("data") or {}).get("girlsDivAndFlightList") or []:
                    for f in d.get("flightList") or []:
                        games = archived_games(eid, f["flightID"])
                        ids = {i for g in games for i in (g.get("hometeamID"), g.get("awayteamID")) if i}
                        st = jraw(api.p_standings(d["divisionID"], f["flightID"], eid)) if kind == "national" else None
                        sd = (st or {}).get("data")
                        blocks = [b for b in (sd if isinstance(sd, list) else [sd]) if b and b.get("teamStandings")]
                        gap = gaps.get(str(f["flightID"]))
                        # A group TGS published without its games (2024-25) still places a team.
                        ids |= {t.get("teamID") for b in blocks for t in b["teamStandings"] if t.get("teamID")}
                        ours = {i: alias.get(i, i) for i in ids if alias.get(i, i) in known}
                        if not ours:
                            continue
                        tier = (ev.get("tierLabels") or {}).get(f["flightName"], f["flightName"])
                        base = {"season": season, "stage": stage, "eventID": eid, "eventName": ev.get("eventName"),
                                "divisionID": d["divisionID"], "division": d["divisionName"], "flightID": f["flightID"],
                                "flightName": f["flightName"], "tier": tier}
                        if kind == "showcases":
                            for tid, conf in sorted(ours.items()):
                                mine = [g for g in games if tid in (g.get("hometeamID"), g.get("awayteamID"))]
                                e = {**base, "teamID": tid, "location": ev.get("location"),
                                     "startDate": ev.get("startDate"), "endDate": ev.get("endDate"),
                                     "games": len(mine), "played": sum(1 for g in mine if played(g)), **record(mine, tid)}
                                if season == active and e["played"] < e["games"]:
                                    e["inProgress"] = True
                                bucket[(season, conf)].append(e)
                            continue
                        ko, main, cup = flight_outcomes(games, blocks, (gap or {}).get("omitFromBracket"), f["flightName"], tier)
                        ko_ids = {g.get("matchID") for g in ko}
                        last = main["rounds"][-1] if main and main["rounds"] else None
                        for tid, conf in sorted(ours.items()):
                            mine = [g for g in games if tid in (g.get("hometeamID"), g.get("awayteamID"))]
                            grp, t = None, None
                            for b in blocks:
                                for i, row in enumerate(b.get("teamStandings") or []):
                                    if row.get("teamID") == tid:
                                        grp = {"name": b.get("flightGroupName") or "", "pos": i + 1, "of": len(b["teamStandings"])}
                                        t = row
                            rec = record(mine, tid)
                            n_played = sum(1 for g in mine if played(g))
                            e = {**base, "teamID": tid, "games": len(mine), "played": n_played, **rec}
                            grp_played = [g for g in mine if g.get("matchID") not in ko_ids and played(g)]
                            if gap and grp and t and (t.get("gp") or 0) > len(grp_played):
                                # M1: only a declared gap uses the group table: TGS published it but
                                # not its games (2024-25). Its record, plus the published knockout games.
                                kr = record([g for g in mine if g.get("matchID") in ko_ids], tid)
                                e.update(w=(t.get("wins") or 0) + kr["w"], d=(t.get("draws") or 0) + kr["d"],
                                         l=(t.get("losses") or 0) + kr["l"], gf=(t.get("goalsfor") or 0) + kr["gf"],
                                         ga=(t.get("goalsagainst") or 0) + kr["ga"], fromTable=True)
                            e["group"] = grp
                            e["reached"] = reached_label(main, tid) if main else None
                            e["champion"] = bool(main and main["champion"] == tid)
                            # M4: "Runner-up" only when a champion was decided and it is the other team.
                            if main and main["final"] and last and in_round(last, tid) and not e["champion"]:
                                e["final"] = "lost" if main["champion"] is not None else "undecided"
                            e["cup"] = (cup["name"] + ": " + reached(cup, tid)) if cup and reached(cup, tid) else None
                            e["reconstructed"] = f["flightID"] in recon
                            e["dataGap"] = bool(gap)
                            if season == active and n_played < len(mine):
                                e["inProgress"] = True
                            bucket[(season, conf)].append(e)
    return post, shows


def depth(e):
    """How far an entry went: 7 champion, 6 final ... 2 round of 32, 1 group stage, 0 played."""
    if e.get("champion"):
        return 7
    name = e.get("reached")
    if name in DEPTH:
        return DEPTH[name]
    m = re.fullmatch(r"Round of (\d+)", name or "")
    if m:       # an odd round size (e.g. 9 games, "Round of 18"): between its neighbours
        return max(1.5, 7 - math.log2(int(m.group(1))))
    return 1.5 if name else 1 if e.get("group") else 0


def best_and_titles(posts):
    """M3: the best Champions League finish (tier label, then depth, Finals above Playoffs, the
    better group place, the latest season), and every title, ranked by tier and stage. Indices
    into `posts`."""
    cl = [i for i, e in enumerate(posts) if tier_rank(e["tier"]) == 4]

    def place(e):   # a better group place ranks higher; no group counts as first
        return -(e["group"]["pos"]) if e.get("group") else -1
    best = max(cl, key=lambda i: (depth(posts[i]), stage_rank(posts[i]["stage"]), place(posts[i]), posts[i]["season"]),
               default=None)
    titles = sorted((i for i, e in enumerate(posts) if e.get("champion")),
                    key=lambda i: (-tier_rank(posts[i]["tier"]), -stage_rank(posts[i]["stage"]), posts[i]["season"]))
    return best, titles


def band(chain):
    """The birth years every season of the chain agrees on: [2011] for MVLA G2011; [2010, 2011]
    for a squad seen only in 2026-27's two-year groups."""
    common = set(chain[0]["birthYears"])
    for r in chain[1:]:
        common &= set(r["birthYears"])
    return sorted(common or chain[0]["birthYears"])


def build(sources=None, links_path=None):
    """Every squad. Returns (squads, stats, rows, errors)."""
    sources = sources or api.load_sources()
    manual, errors = load_links(links_path)
    rows = season_rows(sources)
    nxt, maybe, stats, link_errors = link_seasons(rows, manual)
    errors += link_errors
    prev = {v[0]: k for k, v in nxt.items()}
    post, shows = national_and_showcases(sources, rows)
    byk = {(r["season"], r["teamID"]): r for s in rows.values() for r in s}

    def ref(k):
        r = byk[k]
        return {"season": r["season"], "teamID": r["teamID"], "name": r["name"], "division": r["division"],
                "conference": r["conference"]}

    maybe_prev = collections.defaultdict(list)
    for k, cs in sorted(maybe.items()):
        for c in cs:
            maybe_prev[c].append(k)
    squads = []
    for k in sorted(byk):
        if k in prev:
            continue       # not a squad's first season
        chain, how, cur = [], "start", k
        while cur:
            r = dict(byk[cur])
            r["link"] = how
            chain.append(r)
            n = nxt.get(cur)
            cur, how = (n[0], n[1]) if n else (None, None)
        last, first = chain[-1], chain[0]
        posts = [e for r in chain for e in post.get((r["season"], r["teamID"]), [])]
        sq = {"clubID": last["clubID"], "clubName": last["clubName"], "birthYears": band(chain)}
        best, titles = best_and_titles(posts)
        if best is not None:
            sq["best"] = best
        if titles:
            sq["titles"] = titles
        sq["seasons"] = chain
        sq["postseason"] = posts
        sq["showcases"] = [e for r in chain for e in shows.get((r["season"], r["teamID"]), [])]
        lk = (last["season"], last["teamID"])
        m = maybe.get(lk)
        if m:
            sq["maybe"] = [ref(c) for c in m]
            # Outside the regroup a candidate is offered, not linked, because another
            # predecessor could claim it too (M5): name those (#107 review).
            for c, out in zip(m, sq["maybe"]):
                rivals = [p for p in maybe_prev.get(c, []) if p != lk]
                if c[0] != REGROUP and rivals:
                    out["alsoClaimedBy"] = [{k: ref(p)[k] for k in ("season", "teamID", "name")} for p in rivals]
        mp = maybe_prev.get((first["season"], first["teamID"]))
        if mp:
            sq["maybePrev"] = [ref(c) for c in mp]
        squads.append(sq)
    return squads, stats, rows, errors


def by_team(squads):
    files = collections.defaultdict(list)
    for sq in squads:
        for tid in dict.fromkeys(r["teamID"] for r in sq["seasons"]):
            files[tid].append(sq)
    return files


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def file_bytes(tid, squads):
    """S4: one season or event per line, so a refresh diff shows only the rows that moved."""
    parts = []
    for sq in squads:
        head = _dump({k: v for k, v in sq.items() if k not in LISTS})[:-1]
        body = "".join(f',"{k}":[' + (("\n" + ",\n".join(_dump(x) for x in sq[k]) + "\n") if sq[k] else "") + "]"
                       for k in LISTS if k in sq)
        parts.append(head + body + "}")
    return ('{"schema":%d,"teamID":%d,"squads":[\n' % (SCHEMA, tid) + ",\n".join(parts) + "\n]}\n").encode("utf-8")


def document(tid, squads):
    return {"schema": SCHEMA, "teamID": tid, "squads": squads}


def plan(sources=None, links_path=None, out_dir=None):
    """Build everything in memory and compare it with the files on disk byte for byte, line
    endings normalised (a CRLF checkout is not a change; a reformatted file is). Returns
    (changes {path: bytes}, stale [path], total, errors). Raises if nothing could be built, or
    if the build would remove more than a few files (a season's index missing, not teams TGS
    dropped)."""
    out_dir = out_dir or history_dir()
    squads, _stats, _rows, errors = build(sources, links_path)
    files = by_team(squads)
    if not files:
        raise ValueError("no team-seasons found; is the team index built? (python archive.py --team-index --all)")
    changes = {}
    for tid, sq in sorted(files.items()):
        path = os.path.join(out_dir, f"{tid}.json")
        data = file_bytes(tid, sq)
        if _on_disk(path) != data:
            changes[path] = data
    stale = []
    if os.path.isdir(out_dir):
        for name in sorted(os.listdir(out_dir)):
            m = re.fullmatch(r"([1-9][0-9]*)\.json", name)
            if m and int(m.group(1)) not in files:
                stale.append(os.path.join(out_dir, name))
    if len(stale) > max(MAX_REMOVALS, len(files) // 20):
        raise ValueError(f"the build would remove {len(stale)} of the history files; refusing (is a season's "
                         f"team index missing or empty?). Nothing was written")
    return changes, stale, len(files), errors


def _on_disk(path):
    """A file's bytes with CRLF read as LF (git's autocrlf checkout), or None."""
    try:
        with open(path, "rb") as f:
            return f.read().replace(b"\r\n", b"\n")
    except OSError:
        return None


def _write_tmp(path, data):
    with open(path + ".tmp", "wb") as f:
        f.write(data)


def _move(src, dst):
    os.replace(src, dst)


class PartialWrite(OSError):
    """Some history files were replaced and could not be put back."""


def write_history(sources=None, dry_run=False, links_path=None, out_dir=None):
    """Rebuild every history file; write the changed ones and remove those of ids no longer in
    any conference table. Returns (written, removed, total, errors).

    Never a half-built set: the whole build happens in memory first (a failure there writes
    nothing); every changed file is then written beside its target as <id>.json.tmp (a failure
    there removes the .tmp files and writes nothing); only then are they moved into place, and
    a failure while moving puts back every file already replaced (its old bytes are kept in
    memory) before it raises. Only if that restore itself fails does it raise PartialWrite,
    naming the files, so the log never says "left as they were" when they were not."""
    out_dir = out_dir or history_dir()
    changes, stale, total, errors = plan(sources, links_path, out_dir)
    if dry_run:
        return len(changes), len(stale), total, errors
    os.makedirs(out_dir, exist_ok=True)
    old = {}
    for path in changes:
        try:
            with open(path, "rb") as f:
                old[path] = f.read()
        except FileNotFoundError:
            old[path] = None

    def drop_tmp():
        for path in changes:
            for leftover in (path + ".tmp", path + ".bak.tmp"):
                try:
                    os.remove(leftover)
                except OSError:
                    pass
    try:
        for path, data in changes.items():
            _write_tmp(path, data)
    except BaseException:
        drop_tmp()
        raise
    replaced = []
    try:
        for path in changes:
            _move(path + ".tmp", path)
            replaced.append(path)
    except BaseException as e:
        lost = []
        for path in replaced:
            try:
                if old[path] is None:
                    os.remove(path)
                else:
                    with open(path + ".bak.tmp", "wb") as f:
                        f.write(old[path])
                    os.replace(path + ".bak.tmp", path)
            except OSError:
                lost.append(os.path.basename(path))
        drop_tmp()
        if lost:
            raise PartialWrite(f"moving the new files failed ({e}) and {len(lost)} could not be put back "
                               f"({', '.join(lost[:8])}); run: python archive.py --team-history") from e
        raise
    for path in stale:
        os.remove(path)
    return len(changes), len(stale), total, errors


def check_history(sources=None, links_path=None, out_dir=None):
    """The drift check: ids whose committed file differs from a fresh build (missing, changed or
    stale), and the team-links.json problems. Writes nothing."""
    changes, stale, _total, errors = plan(sources, links_path, out_dir)
    return sorted(os.path.basename(p) for p in list(changes) + stale), errors


def parity(sources):
    """Every national team-flight's round reached, title and cup result, as this port computes
    them; tests/team-history.test.mjs compares it with the page's own bracket code."""
    out = {}
    for _season, sdata in sources["seasons"].items():
        for _stage, ev in (sdata.get("national") or {}).items():
            h = jraw(api.p_hierarchy(ev["eventId"]))
            gaps = ev.get("dataGaps") or {}
            for d in ((h or {}).get("data") or {}).get("girlsDivAndFlightList") or []:
                for f in d.get("flightList") or []:
                    games = archived_games(ev["eventId"], f["flightID"])
                    sd = (jraw(api.p_standings(d["divisionID"], f["flightID"], ev["eventId"])) or {}).get("data")
                    blocks = [b for b in (sd if isinstance(sd, list) else [sd]) if b and b.get("teamStandings")]
                    tier = (ev.get("tierLabels") or {}).get(f["flightName"], f["flightName"])
                    _ko, main, cup = flight_outcomes(games, blocks, (gaps.get(str(f["flightID"])) or {}).get("omitFromBracket"),
                                                     f["flightName"], tier)
                    for tid in sorted({i for g in games for i in (g.get("hometeamID"), g.get("awayteamID")) if i}):
                        out[f"{ev['eventId']}/{f['flightID']}/{tid}"] = [
                            reached(main, tid) if main else None, bool(main and main["champion"] == tid),
                            (cup["name"] + ": " + reached(cup, tid)) if cup and reached(cup, tid) else None]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Team histories (#107). archive.py --team-history writes them.")
    ap.add_argument("--stats", action="store_true", help="Print link and size statistics.")
    ap.add_argument("--parity", metavar="FILE", help="Write the bracket outcomes the Node parity test compares.")
    a = ap.parse_args(argv)
    sources = api.load_sources()
    if a.parity:
        out = parity(sources)
        with open(a.parity, "w", encoding="utf-8") as fh:
            json.dump(out, fh)
        print("parity rows:", len(out))
    if a.stats:
        import gzip
        squads, stats, _rows, errors = build(sources)
        files = by_team(squads)
        sizes = sorted((len(b), len(gzip.compress(b)), t) for t, b in ((t, file_bytes(t, s)) for t, s in files.items()))
        print("links:", dict(sorted(stats.items())))
        lens = collections.Counter(len(sq["seasons"]) for sq in squads)
        print("squads:", len(squads), "by seasons covered:", dict(sorted(lens.items())))
        multi = collections.Counter(len(v) for v in files.values())
        print("files:", len(files), "squads per file:", dict(sorted(multi.items())))
        tot = sum(s[0] for s in sizes)
        print(f"bytes: total {tot}, median {sizes[len(sizes) // 2][0]} (gzip {sizes[len(sizes) // 2][1]}), "
              f"max {sizes[-1][0]} (gzip {sizes[-1][1]}) team {sizes[-1][2]}")
        print("squads with a possible continuation:", sum(1 for sq in squads if sq.get("maybe")),
              "| with possible earlier seasons:", sum(1 for sq in squads if sq.get("maybePrev")))
        for e in errors:
            print("error:", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
