"""
Rebuild schedules that TGS removed, from ECNL's published recaps.

The 2024-25 ECNL Girls National Finals (TGS event 3975) publishes no games
through the API any more — every schedule endpoint returns an empty list — but
ECNL's three recaps name every quarterfinal, semifinal and final with scores
and penalty results. This script turns a hand-entered CSV of those results into
archive files shaped exactly like a real `get-schedules-by-flight` response, so
the dashboard draws the brackets with no special casing.

    python reconstruct.py                       rebuild every CSV registered in sources.json
    python reconstruct.py reconstructed/2024-25-finals-3975.csv
    python reconstruct.py --check               validate the archive without writing

Which events are reconstructed, from which CSV, and which flights are protected
from re-crawls, is registered under `reconstructed` on the event in
public/data/sources.json. Everything else comes from the archive:

  * division and flight ids       archived hierarchy of the event (never assumed —
                                  flight ids are not sequential by age)
  * team id, name, club, logo     the same season's conference standings, so a
                                  team's name here equals its name everywhere
                                  else on the site (My Teams matches by name)
  * the finals dates              the archived event details (start/end date)

Team names in the CSV are the recap's spellings; ALIASES maps the few that
differ from TGS's standings spelling. A name that resolves to zero or more than
one standings team is an error, never a guess.

Zero dependencies (stdlib only).
"""

import argparse
import csv
import json
import os
import re
import sys

import ecnl_api as api

ROUNDS = ("QF", "SF", "F")
ROUND_NAMES = {"QF": "Quarterfinals", "SF": "Semifinals", "F": "Final"}
CSV_COLUMNS = ["division", "round", "gamenumber", "date", "winner", "loser",
               "winner_score", "loser_score", "winner_pk", "loser_pk", "source_url"]

# Recap spelling -> the team's base name in TGS's conference standings (the
# name without its " ECNL Gnn" suffix). Matching is case- and space-insensitive
# on top of this, so "FC Delco" would resolve anyway; the map documents every
# known difference between the recaps, the Playoffs archive and the standings.
ALIASES = {
    "KC Athletics": "Kansas City Athletics",
    "Beach FC (CA)": "Beach FC",                   # Playoffs archive also says "(CA)"
    "Eclipse Select": "Eclipse Select SC",
    "FC Delco": "FC DELCO",
    "Slammers FC HB Køge": "Slammers FC HB Koge",  # TGS drops the ø
    "SOLAR SC": "Solar SC",                        # Playoffs-archive spelling
    "PDA Blue": "PDA Blue",                        # Playoffs archive: "PDA Blue ECNL G2008"; standings: "... G08"
}

# Key order of a real get-schedules-by-flight record (41 keys, see any archived
# 3865 file), followed by the two provenance keys. --check asserts the first 41
# still match a real record.
RECORD_KEYS = [
    "matchID", "gamenumber", "gameDate", "gameDate1", "gameTime", "complexID",
    "complex", "zip", "venueID", "venue", "eventID", "scheduleID", "isactive",
    "divisionID", "division", "flightID", "flight", "flightgroupID", "timeslotID",
    "type", "hometeamID", "homeClubLogo", "homeTeam", "awayteamID", "awayClubLogo",
    "awayTeam", "awayteamscore", "hometeamscore", "awayTeamClubID", "awayTeamClub",
    "homeTeamClubID", "homeTeamClub", "gameTimeText", "flagText", "publicNote",
    "status", "friendly", "matchDelayedMin", "hometeamPKscore", "awayteamPKscore",
    "statusID",
]
PROVENANCE_KEYS = ["source", "reconstructed"]

_SUFFIX = re.compile(r"\s+ECNL\s+G\s?\d{2,4}(?:\s*/\s*\d{2,4})?\s*$", re.I)


class ReconstructError(Exception):
    pass


# ---------- registry ----------

def reconstructed_blocks(sources):
    """Every event with a `reconstructed` block, with the fields the script needs."""
    out = []
    for season, kind, name, event in api.iter_events(sources):
        block = event.get("reconstructed")
        if not block:
            continue
        out.append({
            "season": season, "kind": kind, "name": name, "event": event,
            "eventId": event["eventId"],
            "csv": block.get("csv"),
            "flightIds": list(block.get("flightIds") or []),
            "sources": [s["url"] if isinstance(s, dict) else s for s in (block.get("sources") or [])],
            "champions": block.get("champions") or {},
            "qualifiedFrom": block.get("qualifiedFrom"),
            "startDate": event.get("startDate"),
            "endDate": event.get("endDate"),
        })
    return out


# ---------- archive readers ----------

def archived(path):
    raw, _ = api.read_archive(path)
    if raw is None:
        raise ReconstructError(f"not archived: {path} — run: python archive.py")
    return api.unwrap(json.loads(raw))


def event_flights(event_id):
    """{divisionName: [{divisionID, divisionName, flightID, flightName}, ...]}."""
    out = {}
    for div in (archived(api.p_hierarchy(event_id)) or {}).get("girlsDivAndFlightList") or []:
        for fl in div.get("flightList") or []:
            out.setdefault(div["divisionName"], []).append({
                "divisionID": div["divisionID"], "divisionName": div["divisionName"],
                "flightID": fl["flightID"], "flightName": fl["flightName"],
            })
    return out


def base_name(team_name):
    """'Solar SC ECNL G10' -> 'Solar SC'."""
    return _SUFFIX.sub("", team_name or "").strip()


def norm(name):
    return re.sub(r"\s+", " ", name or "").strip().lower()


def standings_index(sources, season):
    """{divisionName: {normalised base name: [team records]}} from the season's
    archived conference standings — the canonical name, club and logo source."""
    index = {}
    conferences = (sources["seasons"].get(season) or {}).get("conferences") or {}
    for conf, event in conferences.items():
        eid = event.get("eventId")
        if not eid:
            continue
        for div_name, flights in event_flights(eid).items():
            for fl in flights:
                payload = archived(api.p_standings(fl["divisionID"], fl["flightID"], eid))
                blocks = payload if isinstance(payload, list) else ([payload] if payload else [])
                for block in blocks:
                    for t in (block or {}).get("teamStandings") or []:
                        rec = {
                            "teamID": t.get("teamID"), "name": (t.get("name") or "").strip(),
                            "clubID": t.get("clubID"), "clubName": t.get("clubName"),
                            "logo": t.get("clublogo"), "conference": conf,
                        }
                        bucket = index.setdefault(div_name, {}).setdefault(norm(base_name(rec["name"])), [])
                        if not any(r["teamID"] == rec["teamID"] for r in bucket):
                            bucket.append(rec)
    return index


def resolve_team(recap_name, division, index):
    """The one standings team a recap name denotes, or a ReconstructError."""
    wanted = norm(ALIASES.get(recap_name, recap_name))
    matches = (index.get(division) or {}).get(wanted) or []
    if len(matches) != 1:
        how = "no team" if not matches else f"{len(matches)} teams ({', '.join(m['name'] for m in matches)})"
        raise ReconstructError(
            f"{division}: recap name {recap_name!r} matches {how} in the {division} conference standings")
    return matches[0]


# ---------- CSV ----------

def read_rows(csv_path):
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != CSV_COLUMNS:
            raise ReconstructError(f"{csv_path}: columns must be {','.join(CSV_COLUMNS)}")
        rows = list(reader)
    for i, r in enumerate(rows, start=2):
        if r["round"] not in ROUNDS:
            raise ReconstructError(f"{csv_path}:{i}: round must be one of {ROUNDS}")
        for k in ("gamenumber", "winner_score", "loser_score"):
            if not r[k].isdigit():
                raise ReconstructError(f"{csv_path}:{i}: {k} must be an integer")
        pk = (r["winner_pk"], r["loser_pk"])
        if any(pk) and not all(p.isdigit() for p in pk):
            raise ReconstructError(f"{csv_path}:{i}: both PK columns or neither")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["date"]):
            raise ReconstructError(f"{csv_path}:{i}: date must be YYYY-MM-DD")
        if not r["winner"].strip() or not r["loser"].strip() or r["winner"] == r["loser"]:
            raise ReconstructError(f"{csv_path}:{i}: winner and loser must be two names")
    return rows


# ---------- records ----------

def build_records(block, rows, flights, index):
    """{flightID: [record, ...]} for one event, records in gamenumber order."""
    per_flight = {}
    for r in rows:
        division = r["division"]
        candidates = [f for f in flights.get(division, []) if f["flightID"] in block["flightIds"]]
        if len(candidates) != 1:
            raise ReconstructError(
                f"{division}: expected exactly one reconstructed flight in event "
                f"{block['eventId']}'s hierarchy, found {len(candidates)}")
        fl = candidates[0]
        winner = resolve_team(r["winner"], division, index)
        loser = resolve_team(r["loser"], division, index)
        n = int(r["gamenumber"])
        ws, ls = int(r["winner_score"]), int(r["loser_score"])
        wpk = int(r["winner_pk"]) if r["winner_pk"] else None
        lpk = int(r["loser_pk"]) if r["loser_pk"] else None
        rec = {
            "matchID": -(fl["flightID"] * 100 + n),
            "gamenumber": n,
            "gameDate": f"{r['date']}T00:00:00",
            "gameDate1": f"{r['date']}T00:00:00",
            "gameTime": None,
            "complexID": None, "complex": None, "zip": None, "venueID": None, "venue": None,
            "eventID": block["eventId"],
            "scheduleID": None,
            "isactive": 1,
            "divisionID": fl["divisionID"], "division": fl["divisionName"],
            "flightID": fl["flightID"], "flight": fl["flightName"],
            "flightgroupID": None, "timeslotID": None,
            "type": "Bracket",
            # The winner is listed first (home): home/away is not published.
            "hometeamID": winner["teamID"], "homeClubLogo": winner["logo"], "homeTeam": winner["name"],
            "awayteamID": loser["teamID"], "awayClubLogo": loser["logo"], "awayTeam": loser["name"],
            "awayteamscore": ls, "hometeamscore": ws,
            "awayTeamClubID": loser["clubID"], "awayTeamClub": loser["clubName"],
            "homeTeamClubID": winner["clubID"], "homeTeamClub": winner["clubName"],
            "gameTimeText": None, "flagText": None, "publicNote": None, "status": None,
            "friendly": 0, "matchDelayedMin": None,
            "hometeamPKscore": wpk, "awayteamPKscore": lpk,
            "statusID": None,
            "source": r["source_url"],
            "reconstructed": True,
        }
        assert list(rec) == RECORD_KEYS + PROVENANCE_KEYS
        per_flight.setdefault(fl["flightID"], []).append(rec)
    for games in per_flight.values():
        games.sort(key=lambda g: g["gamenumber"])
    return per_flight


def payload_bytes(records):
    """Minified like every other archive file: {"result":"success","data":[...]}."""
    return json.dumps({"result": "success", "data": records}, separators=(",", ":")).encode("utf-8")


def write_flights(block, per_flight):
    written = []
    for flight_id, records in sorted(per_flight.items()):
        path = api.p_schedule(block["eventId"], flight_id)
        dest = api.write_archive(path, payload_bytes(records), allow_protected=True)
        if dest is None:
            raise ReconstructError(f"could not write {path}")
        written.append((path, len(records)))
    return written


def update_manifest(block, per_flight):
    import archive  # stdlib-only sibling; keeps one manifest writer
    manifest = archive.load_manifest()
    entry = manifest.get("events", {}).get(f"{block['season']}/{block['name']}")
    if not entry:
        return False
    for div in entry.get("divisions") or []:
        games = per_flight.get(div.get("flightID"))
        if games is None:
            continue
        div["teams"] = len({t for g in games for t in (g["hometeamID"], g["awayteamID"])})
        div["games"] = len(games)
        div["reconstructed"] = True
    archive.save_manifest(manifest)
    return True


# ---------- validation ----------

def winner_of(g):
    hs, as_ = g["hometeamscore"], g["awayteamscore"]
    if hs != as_:
        return g["hometeamID"] if hs > as_ else g["awayteamID"]
    hp, ap = g["hometeamPKscore"], g["awayteamPKscore"]
    if hp is not None and ap is not None and hp != ap:
        return g["hometeamID"] if hp > ap else g["awayteamID"]
    return None


def qualifying_flight(event_id, division, flight_name):
    flights = [f for f in event_flights(event_id).get(division) or [] if f["flightName"] == flight_name]
    return flights[0] if len(flights) == 1 else None


def playoff_last_day_winners(event_id, division, flight_name):
    """teamIDs winning on the last match day of the qualifying event's flight of
    the same division and name, or None when nothing is archived for it."""
    fl = qualifying_flight(event_id, division, flight_name)
    if not fl:
        return None
    games = [g for g in (archived(api.p_schedule(event_id, fl["flightID"])) or [])
             if g.get("type") == "Bracket" and g.get("gameDate")]
    if not games:
        return None
    last = max(g["gameDate"][:10] for g in games)
    return {winner_of(g) for g in games if g["gameDate"][:10] == last} - {None}


class Checker:
    def __init__(self):
        self.passed = 0
        self.failures = []

    def ok(self, cond, label):
        if cond:
            self.passed += 1
            print(f"  ok   {label}")
        else:
            self.failures.append(label)
            print(f"  FAIL {label}")
        return cond


def check_block(sources, block, chk, real_keys):
    eid = block["eventId"]
    print(f"\n{block['season']} / {block['name']} ({eid}) — {block['csv']}")
    rows = read_rows(os.path.join(api.ROOT, block["csv"]))
    flights = event_flights(eid)
    index = standings_index(sources, block["season"])
    per_flight = build_records(block, rows, flights, index)  # raises if any name is ambiguous
    n_teams = sum(len({t for g in v for t in (g["hometeamID"], g["awayteamID"])}) for v in per_flight.values())
    chk.ok(True, f"every CSV name resolves to exactly one {block['season']} conference-standings team "
                 f"({2 * len(rows)} names, {n_teams} teams)")
    chk.ok(sorted(per_flight) == sorted(block["flightIds"]),
           f"CSV covers exactly the registered flights {sorted(block['flightIds'])}")

    details = None
    try:
        details = archived(api.p_event_details(eid)) or {}
    except ReconstructError:
        print(f"  skip event details for {eid} are not archived — date cross-check not possible")
    all_ids = set()
    champions = {}
    name_diffs = []

    for flight_id in sorted(per_flight):
        games = per_flight[flight_id]
        division = games[0]["division"]
        tag = f"{division} / {games[0]['flight']} ({flight_id})"
        ids = [(g["hometeamID"], g["awayteamID"]) for g in games]
        teams = {t for pair in ids for t in pair}
        by_round = {}
        for g in games:
            r = next(r["round"] for r in rows if r["division"] == division and int(r["gamenumber"]) == g["gamenumber"])
            by_round.setdefault(r, []).append(g)

        chk.ok(len(games) == 7 and len(teams) == 8, f"{tag}: 7 games, 8 distinct teams")
        chk.ok([len(by_round.get(r, [])) for r in ROUNDS] == [4, 2, 1], f"{tag}: rounds are 4 QF, 2 SF, 1 F")
        appearances = {t: sum(t in pair for pair in ids) for t in teams}
        chk.ok(all(1 <= n <= 3 for n in appearances.values()), f"{tag}: each team appears 1-3 times")
        qf_w = {winner_of(g) for g in by_round["QF"]}
        sf_teams = {t for g in by_round["SF"] for t in (g["hometeamID"], g["awayteamID"])}
        sf_w = {winner_of(g) for g in by_round["SF"]}
        f_teams = {t for g in by_round["F"] for t in (g["hometeamID"], g["awayteamID"])}
        chk.ok(qf_w == sf_teams and len(qf_w) == 4, f"{tag}: semifinalists are the four quarterfinal winners")
        chk.ok(sf_w == f_teams and len(sf_w) == 2, f"{tag}: finalists are the two semifinal winners")
        final = by_round["F"][0]
        champ_id = winner_of(final)
        champ = final["homeTeam"] if champ_id == final["hometeamID"] else final["awayTeam"]
        expected = block["champions"].get(division)
        chk.ok(champ_id is not None and expected is not None and norm(base_name(champ)) == norm(expected),
               f"{tag}: champion is {champ!r} (expected {expected!r})")
        champions[division] = champ
        chk.ok(all((g["hometeamPKscore"] is not None and g["awayteamPKscore"] is not None
                    and g["hometeamPKscore"] != g["awayteamPKscore"]) == (g["hometeamscore"] == g["awayteamscore"])
                   for g in games), f"{tag}: PK scores present exactly when the game was drawn")
        chk.ok(all(g["hometeamscore"] >= g["awayteamscore"] and winner_of(g) == g["hometeamID"] for g in games),
               f"{tag}: the winner is listed first (home) in every game")
        dates = [sorted({g["gameDate"][:10] for g in by_round[r]}) for r in ROUNDS]
        chk.ok(all(len(d) == 1 for d in dates) and dates[0][0] < dates[1][0] < dates[2][0],
               f"{tag}: one date per round, QF {dates[0][0]} < SF {dates[1][0]} < F {dates[2][0]}")
        chk.ok(all(g["gameDate"] == g["gameDate1"] and g["gameDate"].endswith("T00:00:00") for g in games),
               f"{tag}: gameDate and gameDate1 both at T00:00:00")
        if details:
            start = (details.get("eventStartDate") or "")[:10]
            end = (details.get("eventEndDate") or "")[:10]
            chk.ok(start == dates[0][0] and end == dates[2][0],
                   f"{tag}: QF date equals the archived eventStartDate and the final the eventEndDate ({start} .. {end})")
        chk.ok(block["startDate"] == dates[0][0] and block["endDate"] == dates[2][0],
               f"{tag}: sources.json startDate/endDate match the QF and final dates")
        mids = [g["matchID"] for g in games]
        chk.ok(all(m < 0 for m in mids) and len(set(mids)) == len(mids) and not (all_ids & set(mids)),
               f"{tag}: matchIDs are negative and unique ({mids[0]}..{mids[-1]})")
        all_ids |= set(mids)
        chk.ok(all(list(g)[:len(RECORD_KEYS)] == RECORD_KEYS and list(g)[len(RECORD_KEYS):] == PROVENANCE_KEYS
                   for g in games) and set(RECORD_KEYS) == real_keys,
               f"{tag}: {len(RECORD_KEYS)} keys equal a real schedule record's, plus {PROVENANCE_KEYS}")
        chk.ok(all(g["type"] == "Bracket" and g["isactive"] == 1 and g["friendly"] == 0 and g["flightgroupID"] is None
                   and g["reconstructed"] is True and g["source"] in block["sources"] for g in games),
               f"{tag}: type Bracket, isactive 1, friendly 0, flightgroupID null, source is a registered recap URL")

        # Age suffix: every team's Gyy matches the flight's division (the FC Stars Blue U14/U15 trap)
        div_band = api.band_from_division_name(division)
        names = {g["hometeamID"]: g["homeTeam"] for g in games}
        names.update({g["awayteamID"]: g["awayTeam"] for g in games})
        chk.ok(all(api.band_from_team_name(n) == div_band for n in names.values()),
               f"{tag}: every team name carries the flight's age suffix (G{str(div_band[0])[2:]})")

        # Names equal the same-season conference-standings names, by teamID
        std_by_id = {t["teamID"]: t for bucket in index.get(division, {}).values() for t in bucket}

        def club_of(tid):
            g = next(g for g in games if tid in (g["hometeamID"], g["awayteamID"]))
            return g["homeTeamClubID"] if g["hometeamID"] == tid else g["awayTeamClubID"]

        chk.ok(all(tid in std_by_id and std_by_id[tid]["name"] == n and std_by_id[tid]["clubID"] == club_of(tid)
                   for tid, n in names.items()),
               f"{tag}: every stored name and club equals the {block['season']} conference-standings record")

        # Quarterfinalists equal the qualifying event's last-day winners, by teamID
        if block["qualifiedFrom"]:
            winners = playoff_last_day_winners(block["qualifiedFrom"], division, games[0]["flight"])
            qf_teams = {t for g in by_round["QF"] for t in (g["hometeamID"], g["awayteamID"])}
            if winners is None:
                print(f"  skip {tag}: no bracket games archived for event {block['qualifiedFrom']} — Playoffs cross-check not possible")
            else:
                chk.ok(winners == qf_teams,
                       f"{tag}: the 8 quarterfinalists equal the 8 last-day winners of event {block['qualifiedFrom']}, by teamID")
                # Informational: where the Playoffs spelling differs from the stored (standings) one
                pf = qualifying_flight(block["qualifiedFrom"], division, games[0]["flight"])
                pnames = {}
                for g in archived(api.p_schedule(block["qualifiedFrom"], pf["flightID"])) or []:
                    pnames[g["hometeamID"]] = g["homeTeam"]
                    pnames[g["awayteamID"]] = g["awayTeam"]
                for tid, n in names.items():
                    if tid in pnames and pnames[tid] != n:
                        name_diffs.append((division, tid, pnames[tid], n))

        # On-disk file equals the regeneration
        raw, _ = api.read_archive(api.p_schedule(eid, flight_id))
        chk.ok(raw == payload_bytes(games),
               f"{tag}: archived file equals the regeneration from the CSV, byte for byte")

    # Manifest and guard
    import archive
    entry = archive.load_manifest().get("events", {}).get(f"{block['season']}/{block['name']}") or {}
    divs = {d.get("flightID"): d for d in entry.get("divisions") or []}
    chk.ok(all(divs.get(fid, {}).get("reconstructed") is True and divs[fid].get("games") == len(per_flight[fid])
               and divs[fid].get("teams") == 8 for fid in per_flight),
           f"manifest.json: the {len(per_flight)} divisions carry reconstructed: true with real teams/games counts")
    chk.ok(all(api.is_protected_path(api.p_schedule(eid, fid)) for fid in per_flight),
           f"ecnl_api.protected_paths covers all {len(per_flight)} schedule paths")

    if name_diffs:
        print("  info Playoffs-archive spellings that differ from the stored (standings) name, by teamID:")
        for division, tid, pn, sn in name_diffs:
            print(f"       {division} {tid}: Playoffs {pn!r} -> stored {sn!r}")
    print("  champions: " + "; ".join(f"{d} {n}" for d, n in champions.items()))


def real_record_keys():
    """Key set of a genuine schedule record, from any archived non-empty schedule."""
    base = os.path.join(api.ARCHIVE_API_DIR, "Event", "get-schedules-by-flight")
    for root, _dirs, files in os.walk(base):
        for name in files:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(root, name), "r", encoding="utf-8") as f:
                    games = (json.load(f) or {}).get("data") or []
            except (OSError, ValueError):
                continue
            for g in games:
                if isinstance(g, dict) and not g.get("reconstructed"):
                    return set(g)
    raise ReconstructError("no real schedule record found in the archive to compare keys against")


def cmd_check(sources, blocks):
    chk = Checker()
    keys = real_record_keys()
    for block in blocks:
        try:
            check_block(sources, block, chk, keys)
        except ReconstructError as e:
            chk.ok(False, str(e))
    print(f"\n{chk.passed} checks passed, {len(chk.failures)} failed.")
    for f in chk.failures:
        print(f"  - {f}")
    return 1 if chk.failures else 0


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description="Rebuild removed TGS schedules from ECNL's recaps.")
    ap.add_argument("csv", nargs="*", help="CSV(s) to rebuild; default: every one registered in sources.json")
    ap.add_argument("--check", action="store_true", help="Validate the archived reconstruction; write nothing.")
    args = ap.parse_args()

    sources = api.load_sources()
    blocks = reconstructed_blocks(sources)
    if args.csv:
        wanted = {os.path.normpath(c) for c in args.csv}
        blocks = [b for b in blocks if b["csv"] and os.path.normpath(b["csv"]) in wanted]
        missing = wanted - {os.path.normpath(b["csv"]) for b in blocks}
        if missing:
            print(f"Not registered under `reconstructed` in sources.json: {', '.join(sorted(missing))}")
            return 2
    if not blocks:
        print("Nothing registered under `reconstructed` in sources.json.")
        return 2

    if args.check:
        return cmd_check(sources, blocks)

    for block in blocks:
        eid = block["eventId"]
        print(f"{block['season']} / {block['name']} ({eid}) <- {block['csv']}")
        try:
            rows = read_rows(os.path.join(api.ROOT, block["csv"]))
            flights = event_flights(eid)
            index = standings_index(sources, block["season"])
            per_flight = build_records(block, rows, flights, index)
            if sorted(per_flight) != sorted(block["flightIds"]):
                raise ReconstructError(
                    f"CSV flights {sorted(per_flight)} != registered flightIds {sorted(block['flightIds'])}")
            for path, n in write_flights(block, per_flight):
                print(f"  wrote {path}.json  ({n} games)")
            if update_manifest(block, per_flight):
                print(f"  manifest.json: {len(per_flight)} divisions marked reconstructed")
        except ReconstructError as e:
            print(f"  ERROR: {e}")
            return 1
    print("\nNow run: python reconstruct.py --check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
