"""Search data files (#158): public/archive/search/core.json and games-<season>.json, built by
search_data.py. They are the prepared records the page's search reads; the index is the
word-to-records map the browser builds from them. Each test fails without the change it names.

(a) Games: undateBorrowedDates ported (one fixture with Node); every game once (#155 dedupe);
    the destination code per game (MF1); dates (MF4); every side keeps its own name (MF7).
(b) Fields and zips (MF5, D6/D6a, Q3/Q4): strip, ZIP+4, the reviewed fix list, then inference;
    the alias file; placeholders; bad entries reported and failing the check.
(c) Core: the directory verbatim (logos as the directory, MF8 option a), alias team ids, the build
    id pair with directory.json (Q9).
(d) Stability: identical bytes across processes, hash seeds and time zones (MF3); a score change
    rewrites one row line plus `build`; closed seasons untouched (MF2).
(e) The pipeline: every path that rebuilds the directory rebuilds the search data from it; a
    failure keeps the old files and fails the run; --dry-run writes nothing; the drift check.
(f) The frozen fixture (MF6): built from 1c4c3268; its directoryBuild names PR 1's frozen directory.
"""
import argparse
import collections
import contextlib
import functools
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import archive
import ecnl_api as api
import search_data as sd
import team_directory as td
import team_history as th

SEARCH = Path(api.ARCHIVE_DIR) / "search"
FIXTURES = HERE / "search" / "fixtures"
FIX = "run `python archive.py --search-data`, then commit public/archive/search/"


def load(path):
    with open(path, "rb") as f:
        return json.loads(f.read().replace(b"\r\n", b"\n"))


@functools.lru_cache(maxsize=None)
def fresh():
    """One build of the committed archive, shared by the tests that only read it."""
    files, errors, report = sd.build()
    return files, tuple(errors), report


def decoded(files, season):
    return {g["matchID"]: g for g in sd.decode_games(json.loads(files[f"games-{season}.json"]))}


@functools.lru_cache(maxsize=None)
def all_games():
    files = fresh()[0]
    return {g["matchID"]: g for n in files if n.startswith("games-") for g in sd.decode_games(json.loads(files[n]))}


def overlay(changes):
    """A patched api.read_archive: `changes` maps an API path to a function of its parsed JSON."""
    real = api.read_archive

    def read(path):
        raw, stamp = real(path)
        if path in changes and raw is not None:
            return json.dumps(changes[path](json.loads(raw))).encode(), stamp
        return raw, stamp
    return patch.object(api, "read_archive", side_effect=read)


class Committed(unittest.TestCase):
    def test_the_committed_files_equal_a_fresh_build(self):
        files, errors, _ = fresh()
        self.assertEqual(errors, ())
        self.assertEqual(sd.check(files), [], f"the search data files differ from a fresh build; {FIX}")

    def test_every_game_of_the_archive_once(self):
        """#155: whichever flight's file holds a game, it is in its season's games file once."""
        src = set()
        root = Path(api.ARCHIVE_API_DIR) / "Event" / "get-schedules-by-flight"
        for f in root.glob("*/*/0.json"):
            src |= {g["matchID"] for g in load(f).get("data") or []}
        games = all_games()
        self.assertEqual(set(games), src)
        rows = sum(len(json.loads(b)["games"]) for n, b in fresh()[0].items() if n.startswith("games-"))
        self.assertEqual(rows, len(src))
        # 539486, Del Mar Sharks v LAFC So Cal (2023-24 Southwest), stored only in the Sonoran file.
        g = decoded(fresh()[0], "2023-24")[539486]
        self.assertEqual({g["home"]["teamID"], g["away"]["teamID"]} - {None}, {g["home"]["teamID"], g["away"]["teamID"]})

    def test_each_side_keeps_its_own_name_and_club(self):
        """MF7: a team spelled one way in conference and another at a national event keeps both."""
        src = {}
        root = Path(api.ARCHIVE_API_DIR) / "Event" / "get-schedules-by-flight"
        for f in root.glob("*/*/0.json"):
            for g in load(f).get("data") or []:
                src[g["matchID"]] = g
        games = all_games()
        for mid, g in games.items():
            s = src[mid]
            for side, name, club in (("home", "homeTeam", "homeTeamClubID"), ("away", "awayTeam", "awayTeamClubID")):
                tid = s[side + "teamID"]
                want = (tid, " ".join((s[name] or "").split()) or None, s[club] if tid is not None else None)
                self.assertEqual((g[side]["teamID"], g[side]["name"], g[side]["clubID"]), want, f"{mid} {side}")
        self.assertTrue(any(json.loads(b)["alt"] for n, b in fresh()[0].items() if n.startswith("games-")),
                        "some team has another spelling at a national event or showcase")

    def test_logos_as_the_directory_and_none_in_games(self):
        """MF8 option (a): core carries the directory's logos exactly; games carry none."""
        core = json.loads(fresh()[0]["core.json"])
        directory = load(td.directory_path())
        self.assertEqual([c[2] for c in core["teams"]["clubs"]], [c[2] for c in directory["clubs"]])
        image = re.compile(r"PlayerForm|PlayerImage|ClubImages|images\.totalglobalsports|\.(png|jpe?g|gif|webp|svg)\b", re.I)
        for n, b in fresh()[0].items():
            if n.startswith("games-"):
                self.assertIsNone(image.search(b.decode("utf-8")), n)

    def test_core_keys_and_the_build_id_pair(self):
        """Q9: directory.json's build is the hash of its dump without it, and core names it."""
        core = json.loads(fresh()[0]["core.json"])
        self.assertEqual(list(core), ["schema", "build", "directoryBuild", "activeSeason", "seasons", "birthYears",
                                      "vocab", "events", "teams"])
        self.assertEqual(core["schema"], 2, "#159: fields moved to places.json")
        directory = load(td.directory_path())
        self.assertEqual(list(directory)[:2], ["schema", "build"])
        self.assertEqual(directory["build"], td.build_id(directory))
        self.assertEqual(core["directoryBuild"], directory["build"])
        changed = json.loads(json.dumps(directory))
        changed["squads"][0]["s"][0][5] = (changed["squads"][0]["s"][0][5] or 0) + 1
        self.assertNotEqual(td.build_id(changed), directory["build"], "a changed rank changes the build id")
        self.assertEqual(core["birthYears"], [2002, 2014])

    def test_alias_team_ids(self):
        """The catalog's teamAliases: 2025-26 Phoenix Spring team 112470 is squad 69910's."""
        core = json.loads(fresh()[0]["core.json"])
        t = core["teams"]
        sq = next(s for s in t["squads"] if any(r[1] == 69910 for r in s["s"]))
        self.assertEqual(sq["x"], [[t["seasons"].index("2025-26"), 112470]])
        self.assertEqual(sum(1 for s in t["squads"] if "x" in s), 1)

    def test_conference_event_dates_ignore_sentinels_and_dates_outside_the_season(self):
        """MF4: 2020-21 Midwest held a 0001-01-01 row; 2023-24 Southwest held a 2022-10-28 game."""
        core = json.loads(fresh()[0]["core.json"])
        src = api.load_sources()
        for season, conf in (("2020-21", "Midwest"), ("2023-24", "Southwest")):
            eid = src["seasons"][season]["conferences"][conf]["eventId"]
            start, end = core["events"][str(eid)][5:7]
            self.assertGreaterEqual(start, f"{season[:4]}-07-01", (season, conf))
            self.assertLessEqual(end, f"20{season[5:]}-07-31", (season, conf))

    def test_size_budget(self):
        """#158 test 14: past these, revisit the format rather than raise the limit."""
        files = fresh()[0]
        gz = {n: len(gzip.compress(b, 6)) for n, b in files.items()}
        active = api.load_sources()["refresh"]["activeSeason"]
        self.assertLessEqual(gz["core.json"], 120 * 1024)
        self.assertLessEqual(gz["places.json"], 60 * 1024, "#159 (owner MF5 a+)")
        self.assertLessEqual(gz[f"games-{active}.json"], 100 * 1024)
        self.assertLessEqual(sum(v for n, v in gz.items() if n.startswith("games-")), 800 * 1024)


class Destinations(unittest.TestCase):
    """MF1: what each game's row opens, by what the page does (index.html loadCurrentView lists every
    flight of the division; team= is looked up in the whole division's standings)."""

    def test_the_rules_hold_on_the_archive(self):
        arc = sd.Archive()
        src = api.load_sources()
        members, flights_in = {}, {}
        for season, entry in src["seasons"].items():
            for conf, ev in (entry.get("conferences") or {}).items():
                eid = ev["eventId"]
                for d in (arc.hierarchy(eid) or {}).get("data", {}).get("girlsDivAndFlightList") or []:
                    fl = [f["flightID"] for f in d.get("flightList") or []]
                    ids = {t.get("teamID") for f in fl for b in sd._blocks(arc.standings(d["divisionID"], f, eid)) for t in b["teamStandings"]}
                    for f in fl:
                        members[f] = ids
                        flights_in[f] = eid
        counts = collections.Counter()
        for g in all_games().values():
            dest, k = g["dest"], g["kind"]
            counts[(k, tuple(dest))] += 1
            tbd = g["home"]["teamID"] is None or g["away"]["teamID"] is None
            if k == "c":
                self.assertIn(g["flightID"], members, f"{g['matchID']}: its flight is in its division's flightList")
                if dest[:1] == [1] and len(dest) == 2:
                    self.assertIn(g["away" if dest[1] else "home"]["teamID"], members[g["flightID"]], g["matchID"])
                    if dest[1] == 1:
                        self.assertNotIn(g["home"]["teamID"], members[g["flightID"]], "home comes first")
                elif dest == [1]:
                    self.assertFalse({g["home"]["teamID"], g["away"]["teamID"]} & members[g["flightID"]])
                else:
                    self.assertEqual(dest, [0])
                    self.assertTrue(tbd)
            elif k == "n":
                self.assertIn(dest, ([0], [2], [3]))
                if dest == [3]:
                    self.assertFalse(tbd)
            else:
                self.assertEqual(dest, [0] if tbd else [4])
        national = sum(v for (k, _), v in counts.items() if k == "n")
        self.assertEqual(national, sum(counts[("n", d)] for d in ((0,), (2,), (3,))), "the national partition is complete")

    def test_the_counts_on_the_frozen_fixture(self):
        """The plan's figures, pinned where the data cannot move (1c4c3268)."""
        counts = collections.Counter()
        flags = collections.Counter()
        for f in sorted((FIXTURES / "search").glob("games-*.json")):
            for g in sd.decode_games(load(f)):
                counts[(g["kind"], tuple(g["dest"]))] += 1
                if g["kind"] == "n" and g["dest"] == [3]:
                    flags[g["flags"] & sd.F_BRACKET] += 1
        self.assertEqual(counts[("c", (1, 0))], 42790)
        self.assertEqual(counts[("c", (1, 1))], 140)
        self.assertEqual(counts[("c", (1,))], 27)
        self.assertEqual(counts[("c", (0,))], 16)
        self.assertEqual([counts[("n", (2,))], counts[("n", (3,))], counts[("n", (0,))]], [1973, 1478, 11])
        self.assertEqual(sum(v for (k, _), v in counts.items() if k == "n"), 3462)
        self.assertEqual(flags[0], 1141, "typed Group Play")
        self.assertEqual(flags[1], 337, "typed Bracket but not in the bracket: the 2021-22 group stage (332) and omitFromBracket (5)")
        self.assertEqual(counts[("s", (4,))], 618)


class Games(unittest.TestCase):
    def test_undate_borrowed_dates_matches_the_shared_fixture(self):
        """The port of index.html's undateBorrowedDates; tests/search-data.test.mjs runs the page's."""
        doc = load(FIXTURES / "borrowed-dates.json")
        self.assertGreaterEqual(len(doc["cases"]), 10)
        for c in doc["cases"]:
            before = json.loads(json.dumps(c["games"]))
            out = sd.undate_borrowed_dates(c["games"])
            self.assertEqual(c["games"], before, f"{c['name']}: input not mutated")
            want = [dict(g, gameDate=None, dateUnconfirmed=True) if g["matchID"] in c["undated"] else g for g in before]
            self.assertEqual(out, want, c["name"])

    def test_the_three_live_legs_are_undated_and_flagged(self):
        games = all_games()
        for mid in (1133108, 1133109, 1133110):
            g = games.get(mid)
            if g is None:      # a later refresh may have resolved them; the fixture keeps them
                continue
            self.assertIsNone(g["date"])
            self.assertTrue(g["flags"] & sd.F_UNDATED)
        fixture = {g["matchID"]: g for f in (FIXTURES / "search").glob("games-2026-27.json") for g in sd.decode_games(load(f))}
        for mid in (1133108, 1133109, 1133110):
            self.assertTrue(fixture[mid]["flags"] & sd.F_UNDATED, mid)

    def test_dates_encode_and_decode(self):
        """MF4: floor division before the base; no time; the sentinel and an empty date are no date."""
        base = sd.season_base("2023-24")
        self.assertEqual(base.isoformat(), "2023-07-01")
        w = sd.encode_when("2022-10-28T09:00:00", base)
        self.assertEqual(w, -246 * 10000 + 900)
        self.assertEqual(sd.decode_when(w, base), ("2022-10-28", "09:00"))
        self.assertEqual(sd.decode_when(sd.encode_when("2023-09-09T00:00:00", base), base), ("2023-09-09", None))
        for d in ("0001-01-01T00:00:00", "", None, "1899-12-31T10:00:00"):
            self.assertIsNone(sd.encode_when(d, base), d)
        games = all_games()
        for mid in (172092, 337987, 337992, 337994, 338006, 338008, 275826):
            self.assertIsNone(games[mid]["date"], mid)
            self.assertFalse(games[mid]["flags"] & sd.F_UNDATED, f"{mid}: no date is not an undated leg")
        self.assertEqual((games[538653]["date"], games[538653]["time"]), ("2022-10-28", "09:00"))

    def test_byes_are_flagged_and_stay_in_the_bracket(self):
        byes = [g for g in all_games().values() if g["flags"] & sd.F_BYE]
        self.assertTrue(byes)
        self.assertTrue(all(g["kind"] == "n" for g in byes))

    def test_a_duplicate_match_is_kept_once_the_scored_copy_wins(self):
        """#155: if TGS ever lists one game in two flights' files, it is still one row."""
        src = api.load_sources()
        eid = src["seasons"]["2023-24"]["conferences"]["Southwest"]["eventId"]
        h = load(Path(api.ARCHIVE_API_DIR) / "Event" / "get-event-schedule-or-standings" / f"{eid}.json")
        fl = [f["flightID"] for d in h["data"]["girlsDivAndFlightList"] for f in d["flightList"]][:2]
        a, b = (api.p_schedule(eid, f) for f in fl)
        first = load(Path(api.ARCHIVE_API_DIR) / (a + ".json"))["data"][0]
        copy = dict(first, hometeamscore=None, awayteamscore=None)        # a bare copy in another flight

        def add(doc):
            return dict(doc, data=[copy] + doc["data"])
        report = collections.defaultdict(list)
        with overlay({b: add}):
            games = sd.collect(sd.Archive(), src, report)
        self.assertEqual(games["2023-24"][first["matchID"]][0]["hometeamscore"], first["hometeamscore"])
        self.assertEqual(games["2023-24"][first["matchID"]][1][3], fl[0])
        self.assertIn(str(first["matchID"]), report["duplicate matchIDs whose copies differ (the fuller copy is kept)"])

    def test_two_names_for_one_team_at_one_event_fail_the_build(self):
        """MF7: never a silent pick."""
        src = api.load_sources()
        eid = src["seasons"]["2023-24"]["conferences"]["Southwest"]["eventId"]
        h = load(Path(api.ARCHIVE_API_DIR) / "Event" / "get-event-schedule-or-standings" / f"{eid}.json")
        f = h["data"]["girlsDivAndFlightList"][0]["flightList"][0]["flightID"]
        path = api.p_schedule(eid, f)

        def rename(doc):
            rows = doc["data"]
            g = dict(rows[0], homeTeam=(rows[0]["homeTeam"] or "") + " Renamed")
            return dict(doc, data=[g] + rows[1:])
        with overlay({path: rename}), self.assertRaises(sd.BuildError):
            sd.build()

    def test_a_complex_with_two_fields_fails_the_build(self):
        src = api.load_sources()
        eid = src["seasons"]["2023-24"]["conferences"]["Southwest"]["eventId"]
        h = load(Path(api.ARCHIVE_API_DIR) / "Event" / "get-event-schedule-or-standings" / f"{eid}.json")
        f = h["data"]["girlsDivAndFlightList"][0]["flightList"][0]["flightID"]
        path = api.p_schedule(eid, f)

        def move(doc):
            rows = doc["data"]
            i = next(i for i, g in enumerate(rows) if g.get("complex"))
            return dict(doc, data=rows[:i] + [dict(rows[i], zip="99999")] + rows[i + 1:])
        with overlay({path: move}), self.assertRaisesRegex(sd.BuildError, "two fields"):
            sd.build()


class Fields(unittest.TestCase):
    """MF5, D6/D6a, Q3/Q4."""

    def test_zip_rule(self):
        fixes = {"7834": "07834", "9561": "95618", "7514": None}
        self.assertEqual(sd.zip5("92618", fixes), ("92618", None, False))
        self.assertEqual(sd.zip5("08060 ", fixes), ("08060", None, False))
        self.assertEqual(sd.zip5(" 60441", fixes), ("60441", None, False))
        self.assertEqual(sd.zip5("97006-5941", fixes), ("97006", None, False))
        self.assertEqual(sd.zip5("7834", fixes), ("07834", None, True))
        self.assertEqual(sd.zip5("9561", fixes), ("95618", None, True))
        self.assertEqual(sd.zip5("7514", fixes), ("", None, True))
        self.assertEqual(sd.zip5("TBD", fixes), ("", "TBD", False))
        self.assertEqual(sd.zip5("20175l", fixes), ("", "20175l", False))
        self.assertEqual(sd.zip5("", fixes), ("", None, False))
        self.assertEqual(sd.zip5(None, fixes), ("", None, False))
        self.assertEqual(sd.zip5("2780", {}), ("", "2780", False), "a 4-digit zip is never padded blind")

    def test_fixed_zips_and_inference_on_the_archive(self):
        """Whitespace kept (279 games); 9561 joins Davis Legacy at 95618; Valley Ridge Park's 7514
        (a Texas park) is not inferred from the Washington park of the same name."""
        files = fresh()[0]
        fields = {}
        for n, b in files.items():
            if n.startswith("games-"):
                for cid, v in json.loads(b)["fields"].items():
                    fields[int(cid)] = tuple(v)
        by_key = collections.defaultdict(set)
        for cid, key in fields.items():
            by_key[key].add(cid)
        self.assertIn(("davis legacy soccer complex", "95618"), by_key)
        self.assertNotIn(("davis legacy soccer complex", ""), by_key, "Davis Legacy is never split")
        self.assertIn(("westampton sports complex", "08060"), by_key)
        valley = {k for k in by_key if k[0] == "valley ridge park"}
        self.assertEqual(valley, {("valley ridge park", ""), ("valley ridge park", "98188")})
        self.assertEqual(by_key[("Great Park", "92618")], {80, 422, 1018, 2555, 2838, 3069, 3075, 3416, 4559, 6698, 7083, 7319})
        self.assertEqual(len(by_key[("Surf Sports Park", "92014")]) >= 2, True, "Surf Cup Sports Park joins Surf Sports Park (Q3)")
        self.assertFalse([k for k in by_key if sd.PLACEHOLDER.match(k[0]) or not k[0]], "no placeholder field")

    def test_field_numbers_and_names(self):
        self.assertEqual(sd.field_number("Field 08"), 8)
        self.assertEqual(sd.field_number("Field #03"), 3)
        self.assertEqual(sd.field_number(" Stadium  Field "), "Stadium Field")
        self.assertIsNone(sd.field_number(""))
        self.assertEqual(sd.norm_name("Orange County Great Park "), "orange county great park")
        self.assertEqual(sd.norm_name("St. Joe's  Sports Dome"), "st joes sports dome")
        for p in ("TBD", "tba", "To Be Determined"):
            self.assertEqual(sd.norm_name(p), "")

    def test_core_field_rows(self):
        places = json.loads(fresh()[0]["places.json"])          # #159: fields live in places.json
        label, seasons, numbers = places["fields"]["Great Park@92618"][:3]
        self.assertEqual(label, "Orange County Great Park")
        self.assertIn("2023-24", seasons)
        self.assertEqual(seasons, sorted(seasons))
        self.assertIn(15, numbers)
        self.assertEqual(numbers, sorted(numbers, key=sd._num_key))
        self.assertEqual(places["vocab"]["fieldAliases"]["oc great park"], "Great Park")
        self.assertIsNone(places["fields"]["60 Acres Park@98052"][0], "a label equal to the key's name is dropped")

    def write_inputs(self, tmp, aliases=None, fixes=None):
        d = Path(tmp) / "public" / "data"
        d.mkdir(parents=True)
        for name, extra, key in (("field-aliases.json", aliases, "fields"), ("zip-fixes.json", fixes, "fixes")):
            doc = load(Path(api.PUBLIC_DIR) / "data" / name)
            doc[key] = doc[key] + (extra or [])
            (d / name).write_text(json.dumps(doc), encoding="utf-8")
        return tmp

    def test_bad_reviewed_entries_are_left_out_and_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_inputs(tmp, aliases=[
                {"name": "X", "zip": "1234", "label": "X", "aliases": ["x"], "evidence": "e"},
                {"name": "Y", "zip": "92618", "label": "Y", "aliases": ["great park"], "evidence": "e"},
                {"name": "Z", "zip": "92618", "label": "Z", "aliases": ["Not Normalised"], "evidence": "e"},
                {"name": "W", "zip": "92618", "label": "W", "aliases": ["w"]},
            ], fixes=[{"raw": "92618", "zip": "92618", "evidence": "e"}, {"raw": "123", "zip": "1", "evidence": "e"},
                      {"raw": "7834", "zip": "07834", "evidence": "again"}])
            aliases, a_err = sd.load_aliases(tmp)
            fixes, f_err = sd.load_fixes(tmp)
        self.assertEqual(len(a_err), 4, a_err)
        self.assertEqual(len(f_err), 3, f_err)
        self.assertEqual(aliases[("great park", "92618")][0], "Great Park", "the good entries are kept")
        self.assertEqual(fixes["7834"], "07834")

    def test_the_drift_check_fails_on_a_bad_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_inputs(tmp, fixes=[{"raw": "x", "zip": "1", "evidence": "e"}])
            real = sd.inputs_dir
            with patch.object(sd, "inputs_dir", side_effect=lambda base=None: real(base or tmp)), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                code = archive.cmd_search_data(api.load_sources(), check=True)
        self.assertEqual(code, 1)
        self.assertIn("zip-fixes.json fixes[6]", out.getvalue())


class Stability(unittest.TestCase):
    """MF2 and MF3."""

    def test_identical_bytes_across_processes_hash_seeds_and_time_zones(self):
        with tempfile.TemporaryDirectory() as tmp:
            outs = []
            for seed, tz in (("1", "UTC"), ("977", "Pacific/Kiritimati")):
                out = os.path.join(tmp, seed)
                env = dict(os.environ, PYTHONHASHSEED=seed, TZ=tz, LC_ALL="C")
                subprocess.run([sys.executable, str(HERE.parent / "search_data.py"), "--root", str(HERE.parent),
                                "--inputs", str(HERE.parent), "--out", out], check=True, env=env, stdout=subprocess.DEVNULL)
                outs.append({n: Path(out, n).read_bytes() for n in sorted(os.listdir(out))})
        self.assertEqual(outs[0], outs[1])
        self.assertEqual(outs[0], fresh()[0])

    def test_the_builder_never_reads_the_clock_or_the_locale(self):
        src = (HERE.parent / "search_data.py").read_text(encoding="utf-8")
        for bad in (r"\.now\(", r"\.today\(", r"\btime\.time\(", r"^import time\b", r"\bimport locale\b", r"\blocale\.", r"utcnow", r"localtime", r"os\.environ"):
            self.assertIsNone(re.search(bad, src, re.M), bad)

    def changed_score(self, extra=None):
        """A build with one active-season score set (and optionally a game appended after it). The
        game already has a kick-off time, so no borrowed-date leg can change with it."""
        active = api.load_sources()["refresh"]["activeSeason"]
        games = decoded(fresh()[0], active)
        mid, g = next((m, x) for m, x in sorted(games.items()) if x["kind"] == "c" and x["time"]
                      and x["home"]["teamID"] and x["away"]["teamID"] and x["score"] == [None, None])
        path = api.p_schedule(g["eventID"], g["flightID"])

        def edit(doc):
            rows = [dict(r, hometeamscore=7, awayteamscore=0) if r["matchID"] == mid else r for r in doc["data"]]
            if extra:
                rows.append(dict(next(r for r in rows if r["matchID"] == mid), matchID=extra))
            return dict(doc, data=rows)
        with overlay({path: edit}):
            return sd.build()[0], active

    def test_a_score_change_rewrites_one_row_and_the_build_line(self):
        files, active = self.changed_score()
        base = fresh()[0]
        for n in base:
            if n not in (f"games-{active}.json", "core.json"):
                self.assertEqual(files[n], base[n], f"{n}: a closed season never changes")
        a, b = base[f"games-{active}.json"].decode().split("\n"), files[f"games-{active}.json"].decode().split("\n")
        self.assertEqual(len(a), len(b))
        diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        self.assertEqual(len(diff), 2, "one row line plus the build line")
        self.assertTrue(b[diff[0]].startswith(',"build":'))

    def test_a_new_game_adds_one_line(self):
        files, active = self.changed_score(extra=9_999_999)
        a, b = fresh()[0][f"games-{active}.json"].decode().split("\n"), files[f"games-{active}.json"].decode().split("\n")
        self.assertEqual(len(b), len(a) + 1)
        import difflib
        changes = [l for l in difflib.unified_diff(a, b, lineterm="", n=0) if l[:1] in "+-" and not l.startswith(("+++", "---"))]
        self.assertEqual(len([l for l in changes if l.startswith("+")]), 3, "build, the changed row, the new row")
        self.assertEqual(len([l for l in changes if l.startswith("-")]), 2, "build and the changed row, nothing else")


class Writing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_unchanged_files_are_not_rewritten_and_crlf_is_not_a_change(self):
        files = fresh()[0]
        self.assertEqual(sorted(sd.write(files, self.tmp)), sorted(files))
        p = Path(self.tmp, "core.json")
        p.write_bytes(files["core.json"].replace(b"\n", b"\r\n"))
        before = os.stat(p).st_mtime_ns
        self.assertEqual(sd.write(files, self.tmp), [])
        self.assertEqual(os.stat(p).st_mtime_ns, before)
        self.assertEqual(sd.check(files, self.tmp), [])
        Path(self.tmp, "games-2019-20.json").write_text("{}", encoding="utf-8")
        self.assertEqual(sd.check(files, self.tmp), ["games-2019-20.json"], "a file no longer built is drift")
        self.assertEqual(sd.write(files, self.tmp), ["games-2019-20.json"])
        self.assertFalse(Path(self.tmp, "games-2019-20.json").exists())

    def test_a_failed_write_leaves_the_old_files_and_no_tmp(self):
        files = fresh()[0]
        for n in files:
            Path(self.tmp, n).write_bytes(b"old")
        with patch.object(sd.os, "replace", side_effect=OSError("disk fixture fault")):
            with self.assertRaises(OSError):
                sd.write(files, self.tmp)
        self.assertEqual(sorted(os.listdir(self.tmp)), sorted(files))
        self.assertTrue(all(Path(self.tmp, n).read_bytes() == b"old" for n in files))

    def test_core_is_moved_last(self):
        files = fresh()[0]
        moved = []
        real = os.replace
        with patch.object(sd.os, "replace", side_effect=lambda a, b: (moved.append(os.path.basename(b)), real(a, b))):
            sd.write(files, self.tmp)
        self.assertEqual(moved[-1], "core.json")

    def test_dry_run_writes_nothing(self):
        self.assertTrue(sd.write(fresh()[0], self.tmp, dry_run=True))
        self.assertEqual(os.listdir(self.tmp), [])


class Pipeline(unittest.TestCase):
    """archive.py rebuilds the search data after the team directory, from that directory."""

    _history = []

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        if not Pipeline._history:
            d = tempfile.mkdtemp()
            unittest.addModuleCleanup(shutil.rmtree, d, ignore_errors=True)
            th.write_history(out_dir=os.path.join(d, "history"))
            Pipeline._history.append(os.path.join(d, "history"))
        shutil.copytree(Pipeline._history[0], os.path.join(self.tmp, "history"))
        shutil.copy(api.REFRESH_STATE_PATH, os.path.join(self.tmp, "refresh-state.json"))
        shutil.copy(api.CLUBS_PATH, os.path.join(self.tmp, "clubs.json"))
        self.search = os.path.join(self.tmp, "search")

    def run_in_sandbox(self, fn, *extra):
        with contextlib.ExitStack() as stack:
            for p in [patch.object(api, "ARCHIVE_DIR", self.tmp),
                      patch.object(api, "REFRESH_STATE_PATH", os.path.join(self.tmp, "refresh-state.json")),
                      patch.object(api, "CLUBS_PATH", os.path.join(self.tmp, "clubs.json")),
                      patch.object(th, "HISTORY_DIR", os.path.join(self.tmp, "history"))] + list(extra):
                stack.enter_context(p)
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            code = fn()
        return code, out.getvalue()

    def test_team_history_writes_the_directory_then_the_search_data(self):
        code, out = self.run_in_sandbox(lambda: archive.cmd_team_history(api.load_sources()))
        self.assertEqual(code, 0, out)
        self.assertLess(out.index("Team directory:"), out.index("Search data: 9 files"))
        for n, b in fresh()[0].items():
            self.assertEqual(Path(self.search, n).read_bytes(), b, n)
        self.assertEqual(load(os.path.join(self.search, "core.json"))["directoryBuild"],
                         load(os.path.join(self.tmp, "directory.json"))["build"])

    def test_dry_run_writes_nothing(self):
        code, out = self.run_in_sandbox(lambda: archive.cmd_team_history(api.load_sources(), dry_run=True))
        self.assertEqual(code, 0, out)
        self.assertIn("Search data: not built (dry run).", out)
        self.assertFalse(os.path.exists(self.search))

    def test_a_directory_failure_never_builds_from_a_stale_file(self):
        Path(self.tmp, "directory.json").write_bytes(Path(td.directory_path()).read_bytes())
        os.makedirs(self.search)
        Path(self.search, "core.json").write_bytes(b"old")
        code, out = self.run_in_sandbox(lambda: archive.cmd_team_history(api.load_sources()),
                                        patch.object(td, "build", side_effect=RuntimeError("directory fixture fault")))
        self.assertEqual(code, 1)
        self.assertIn("Search data: not rebuilt", out)
        self.assertEqual(Path(self.search, "core.json").read_bytes(), b"old")

    def test_a_directory_write_failure_never_pairs_core_with_an_unwritten_directory(self):
        os.makedirs(self.search)
        Path(self.search, "core.json").write_bytes(b"old")
        real = os.replace

        def replace(a, b):
            if os.path.basename(b) == "directory.json":
                raise OSError("disk fixture fault")
            return real(a, b)
        code, out = self.run_in_sandbox(lambda: archive.cmd_team_history(api.load_sources()),
                                        patch.object(td.os, "replace", side_effect=replace))
        self.assertEqual(code, 1)
        self.assertIn("Search data: not rebuilt", out)
        self.assertEqual(Path(self.search, "core.json").read_bytes(), b"old")

    def test_a_search_failure_keeps_the_old_files_and_fails_the_run(self):
        os.makedirs(self.search)
        Path(self.search, "core.json").write_bytes(b"old")
        state = Path(self.tmp, "refresh-state.json").read_bytes()
        code, out = self.run_in_sandbox(lambda: archive.cmd_team_history(api.load_sources()),
                                        patch.object(sd, "collect", side_effect=RuntimeError("search fixture fault")))
        self.assertEqual(code, 1)
        self.assertIn("Search data: FAILED: search fixture fault", out)
        self.assertEqual(os.listdir(self.search), ["core.json"])
        self.assertEqual(Path(self.search, "core.json").read_bytes(), b"old")
        self.assertEqual(Path(self.tmp, "refresh-state.json").read_bytes(), state)

    def test_clubs_rebuilds_the_search_data_with_the_new_build_id(self):
        Path(self.tmp, "directory.json").write_bytes(Path(td.directory_path()).read_bytes())
        cid = next(c[0] for c in load(td.directory_path())["clubs"] if c[3])

        def fetched(todo, stats, why):
            places = load(os.path.join(self.tmp, "clubs.json"))
            places["clubs"][str(cid)] = {"city": "Fixture City", "state": "CA"}
            Path(self.tmp, "clubs.json").write_text(json.dumps(places), encoding="utf-8")
        code, out = self.run_in_sandbox(lambda: archive.cmd_clubs(api.load_sources(), None, force=True),
                                        patch.object(archive, "update_club_places", side_effect=fetched))
        self.assertEqual(code, 0, out)
        directory = load(os.path.join(self.tmp, "directory.json"))
        self.assertNotEqual(directory["build"], load(td.directory_path())["build"])
        self.assertEqual(directory["build"], td.build_id(directory))
        self.assertEqual(load(os.path.join(self.search, "core.json"))["directoryBuild"], directory["build"])

    def test_the_drift_check(self):
        os.makedirs(self.search)
        for n, b in fresh()[0].items():
            Path(self.search, n).write_bytes(b.replace(b"\n", b"\r\n"))
        Path(self.tmp, "directory.json").write_bytes(Path(td.directory_path()).read_bytes())
        code, out = self.run_in_sandbox(lambda: archive.cmd_search_data(api.load_sources(), check=True))
        self.assertEqual(code, 0, out)
        p = Path(self.search, "games-2024-25.json")
        p.write_bytes(p.read_bytes().replace(b'"schema":1', b'"schema":1 ', 1))
        code, out = self.run_in_sandbox(lambda: archive.cmd_search_data(api.load_sources(), check=True))
        self.assertEqual(code, 1)
        self.assertIn("games-2024-25.json", out)

    def test_the_flag_is_search_data_and_the_old_name_is_gone(self):
        """#163 (owner decision 149#6207974871): the flag is --search-data; the old name has no alias.
        argparse refuses before any work, so neither run reads the archive or the network."""
        env = dict(os.environ)
        ok = subprocess.run([sys.executable, str(HERE.parent / "archive.py"), "--help"],
                            capture_output=True, text=True, env=env, cwd=str(HERE.parent))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("--search-data", ok.stdout)
        self.assertNotIn("--search-" + "index", ok.stdout)
        old = subprocess.run([sys.executable, str(HERE.parent / "archive.py"), "--search-" + "index", "--check"],
                             capture_output=True, text=True, env=env, cwd=str(HERE.parent))
        self.assertEqual(old.returncode, 2, old.stdout + old.stderr)
        self.assertIn("unrecognized arguments", old.stderr)

    def test_every_directory_build_in_archive_py_is_followed_by_the_search_data(self):
        """Every path (the crawl, --refresh both ways, --team-history, --clubs) runs the build after
        the directory; the crawl and refresh tails need upstream, so this reads the source."""
        src = Path(archive.__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
        funcs = {f.split("(", 1)[0]: f for f in src.split("\ndef ")[1:]}
        users = [n for n, f in funcs.items() if "update_team_directory(sources" in f and n != "update_team_directory"]
        self.assertEqual(sorted(users), ["cmd_refresh", "cmd_team_history", "main"])
        for n in users:
            f = funcs[n]
            for at in [m.start() for m in re.finditer(r"update_team_directory\(sources", f)]:
                nxt = f.find("update_search_data(sources", at)
                self.assertGreater(nxt, at, n)
                self.assertNotIn("update_team_directory(sources", f[at + 1:nxt], f"{n}: each directory build has its own")
        self.assertIn("update_search_data(sources", funcs["cmd_clubs"])


class Fixture(unittest.TestCase):
    """MF6: tests/search/fixtures/search/ was built from 1c4c3268 (README "Search data")."""

    def test_its_directory_build_names_pr1s_frozen_directory(self):
        core = load(FIXTURES / "search" / "core.json")
        pr1 = load(FIXTURES / "directory.json")          # 1c4c3268, logos dropped (#117)
        self.assertNotIn("build", pr1)
        self.assertEqual(core["directoryBuild"], td.build_id(pr1))
        self.assertEqual(load(FIXTURES / "MANIFEST.json")["search"]["commit"], load(FIXTURES / "MANIFEST.json")["commit"])

    def test_the_builder_and_inputs_are_the_recorded_ones(self):
        m = load(FIXTURES / "MANIFEST.json")["search"]
        self.assertEqual(m["builder"], sd.lf_sha(str(HERE.parent / "search_data.py")), "re-freeze the fixture (README)")
        self.assertEqual(sorted(m["inputs"]), sorted(sd.INPUTS), "every reviewed input is recorded (#159)")
        for n in sd.INPUTS:
            path = os.path.join(api.PUBLIC_DIR, "data", n)
            self.assertEqual(m["inputs"][n], sd.lf_sha(path) if os.path.exists(path) else None, n)


if __name__ == "__main__":
    unittest.main()
