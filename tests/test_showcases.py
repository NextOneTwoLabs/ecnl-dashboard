"""Showcases, the third event kind (#97): a season's `showcases` map in sources.json.

(a) The crawler and the refresh, on fixtures: the event kind, the refresh window (the
    event's own dates only, with --date passed through), the team index's showcase
    rows, the export folder, no brackets, the CLI guards, and the request budget that
    counts retries.
(b) The registry: every showcase has what the refresh and the page need, names are unique
    across a season's conferences, national events and showcases (they are manifest keys
    and export folders), and every teamAliases entry is well formed and documented.
(c) The archived showcases: a hand-declared alias really is the same team (onboarding
    checklist, alias review), the index rows, and only the mirrored families.
(d) `--event <id>` (#103) on a two-showcase fixture: the flag checks, the id resolution,
    one details request for --verify, one "would archive" line for --dry-run, and a crawl
    that fetches and writes only that showcase.
No test reaches the network (tests/netguard).
"""
import argparse
import contextlib
import copy
import datetime
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive  # noqa: E402
import ecnl_api as api  # noqa: E402

FAKE_ID = 990001          # an event id no registry entry uses
FAKE = {"eventId": FAKE_ID, "eventName": "Fixture Showcase", "location": "Phoenix, AZ",
        "startDate": "2026-11-20", "endDate": "2026-11-22",
        "teamAliases": {"5003": 7003}, "teamAliasesNote": "fixture"}
HIERARCHY = {"result": "success", "data": {"girlsDivAndFlightList": [
    {"divisionID": 11, "divisionName": "GU13", "flightList": [{"flightID": 21, "flightName": "Fixture"}]},
    {"divisionID": 12, "divisionName": "GU14", "flightList": [{"flightID": 22, "flightName": "Fixture"},
                                                              {"flightID": 23, "flightName": "Empty"}]},
]}}
GAMES = {
    21: [{"matchID": 1, "hometeamID": 5001, "awayteamID": 5002, "gameDate": "2026-11-20T08:00:00"},
         {"matchID": 2, "hometeamID": 5003, "awayteamID": 5001, "gameDate": "2026-11-21T08:00:00"}],
    22: [{"matchID": 3, "hometeamID": 6001, "awayteamID": 6002, "gameDate": "2026-11-20T09:00:00"}],
    23: [],
}


# TGS's showcase tables give most rows rank 1 and some 2: a results list, not a ranking.
STANDINGS_21 = [{"flightGroupID": 0, "teamStandings": [
    {"teamID": 5001, "name": "A", "rank": 1, "ppg": 1.5, "gp": 2},
    {"teamID": 5003, "name": "C", "rank": 2, "ppg": 0.0, "gp": 1},
    {"teamID": 5002, "name": "B", "rank": 1, "ppg": 0.0, "gp": 1},
]}]


def fixture_archive(event_id=FAKE_ID):
    """read_archive answering the fixture showcase's hierarchy, schedules and one
    standings file, and the real archive for everything else."""
    real = api.read_archive
    files = {api.p_hierarchy(event_id): HIERARCHY,
             api.p_standings(11, 21, event_id): {"result": "success", "data": STANDINGS_21}}
    files.update({api.p_schedule(event_id, f): {"result": "success", "data": g} for f, g in GAMES.items()})

    def read(path):
        if path in files:
            return json.dumps(files[path]).encode(), "2026-01-01T00:00:00Z"
        return real(path)
    return patch.object(api, "read_archive", side_effect=read)


def with_fake_showcase(sources, season):
    src = copy.deepcopy(sources)
    src["seasons"][season]["showcases"] = {"Fixture": dict(FAKE)}
    return src


class ShowcaseKindTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()
        cls.active = archive.refresh_policy(cls.sources)["activeSeason"]
        cls.src = with_fake_showcase(cls.sources, cls.active)

    def test_iter_events_yields_the_showcase_kind(self):
        rows = [(s, k, n) for s, k, n, _e in api.iter_events(self.src, self.active) if k == "showcase"]
        self.assertEqual(rows, [(self.active, "showcase", "Fixture")])
        conf = next(iter(self.src["seasons"][self.active]["conferences"]))
        self.assertEqual({k for _s, k, _n, _e in api.iter_events(self.src, self.active, conf)}, {"conference"})
        self.assertNotIn("showcase", {k for _s, k, _n, _e in
                                      api.iter_events(self.src, self.active, include_showcases=False)})

    def test_refresh_window_is_the_event_dates_only(self):
        d = datetime.date
        cases = [(d(2026, 11, 19), False), (d(2026, 11, 20), True), (d(2026, 11, 22), True), (d(2026, 11, 23), False)]
        for day, want in cases:
            self.assertIs(archive.showcase_event_active(FAKE, day), want, day)
        for bad in ({}, {"startDate": "2026-11-20"}, {"startDate": "11/20/26", "endDate": "11/22/26"},
                    {"startDate": None, "endDate": None}):
            self.assertFalse(archive.showcase_event_active(bad, d(2026, 11, 21)), bad)
        with fixture_archive():
            n = lambda day: sorted(f["flightID"] for f in archive.season_flights(self.src, self.active, day)
                                   if f["kind"] == "showcase")
            self.assertEqual(n(d(2026, 11, 19)), [])
            self.assertEqual(n(d(2026, 11, 20)), [21, 22, 23])
            self.assertEqual(n(d(2026, 11, 22)), [21, 22, 23])
            self.assertEqual(n(d(2026, 11, 23)), [])

    @staticmethod
    def refresh_args(date, hour, **kw):
        return argparse.Namespace(**dict(dict(date=date, at_hour=hour, sweep=False, dry_run=False, force=True), **kw))

    def test_refresh_dry_run_uses_the_given_date(self):
        # S4: --date drives the flight list, not the wall clock.
        with fixture_archive(), \
                patch.object(archive, "fetch_json", side_effect=AssertionError("dry run fetched")), \
                patch.object(api, "write_json_file", side_effect=AssertionError("dry run wrote a file")):
            for date, listed in (("2026-11-21", True), ("2026-11-24", False)):
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(archive.cmd_refresh(self.src, self.refresh_args(date, 7, dry_run=True, sweep=True)), 0)
                self.assertEqual("would refresh Fixture" in out.getvalue(), listed, date)

    def test_sweep_rereads_the_showcase_hierarchy_only_on_its_dates(self):
        for date, want in (("2026-11-21", True), ("2026-11-23", False)):
            asked = []

            def fetch(path, stats):
                asked.append(path)
                raise api.ApiError("offline fixture")
            with self.subTest(date=date), tempfile.TemporaryDirectory() as tmp, fixture_archive(), \
                    patch.object(api, "REFRESH_STATE_PATH", os.path.join(tmp, "refresh-state.json")), \
                    patch.object(api, "MATCH_DAYS_PATH", os.path.join(tmp, "match-days.json")), \
                    patch.object(archive, "fetch_json", side_effect=fetch), \
                    patch.object(archive, "export_flight_csv", side_effect=AssertionError("nothing was fetched")), \
                    patch.object(archive, "update_team_index"), \
                    patch.object(archive, "update_team_history"), \
                    patch.object(archive, "refresh_club_places"), \
                    patch.object(api, "fetch_api_raw", side_effect=AssertionError("network in a test")), \
                    contextlib.redirect_stdout(io.StringIO()):
                archive.cmd_refresh(self.src, self.refresh_args(date, 7, sweep=True))
            self.assertEqual(api.p_hierarchy(FAKE_ID) in asked, want)
            self.assertEqual(any(p.startswith(f"Event/get-schedules-by-flight/{FAKE_ID}/") for p in asked), want)
            self.assertFalse(any("brackets" in p for p in asked))

    def test_team_index_showcase_rows(self):
        with fixture_archive():
            rows = archive.showcase_index_rows(self.src, self.active)
        self.assertEqual(rows, [
            {"eventID": FAKE_ID, "divisionID": 11, "flightID": 21, "teamIDs": [5001, 5002, 5003],
             "aliases": {"5003": 7003}},
            {"eventID": FAKE_ID, "divisionID": 12, "flightID": 22, "teamIDs": [6001, 6002]},
        ])   # the flight with no games has no row; the alias only where its id plays

    def test_team_index_bytes_keep_the_teams_rows(self):
        base = {"schema": 1, "season": "2025-26", "teams": [{"teamID": 1, "name": "A"}]}
        plain = archive.team_index_bytes(base)
        self.assertEqual(plain, b'{"schema":1,"season":"2025-26","teams":[\n{"teamID":1,"name":"A"}\n]}\n')
        withsc = dict(base, showcases=[{"eventID": 9, "divisionID": 1, "flightID": 2, "teamIDs": [1]}])
        out = archive.team_index_bytes(withsc)
        self.assertTrue(out.startswith(plain[:-3]))
        self.assertEqual(json.loads(out), withsc)
        self.assertEqual(out.count(b"\n"), 5)   # one row per line

    def test_export_folder(self):
        self.assertEqual(archive.export_dir("2025-26", "showcase", "Phoenix Spring"),
                         os.path.join(api.EXPORT_DIR, "2025-26", "showcases", "Phoenix-Spring"))
        for kind in ("conference", "national"):
            self.assertEqual(archive.export_dir("2025-26", kind, "Texas"), os.path.join(api.EXPORT_DIR, "2025-26", "Texas"))
        fl = {"kind": "showcase", "conference": "Fixture", "eventId": FAKE_ID, "divisionID": 11,
              "divisionName": "GU13", "flightID": 21, "flightName": "Fixture"}
        written = []
        with fixture_archive(), patch.object(archive, "write_csv", side_effect=lambda p, c, r: written.append(p)):
            archive.export_flight_csv(self.src, self.active, fl)
        folder = os.path.join(api.EXPORT_DIR, api.slug(self.active), "showcases", "Fixture")
        self.assertEqual(written, [os.path.join(folder, "GU13-Fixture.standings.csv"),
                                   os.path.join(folder, "GU13-Fixture.schedule.csv")])

    def test_archive_event_never_asks_for_brackets(self):
        asked = []

        def get(path, stats, force):
            asked.append(path)
            if path == api.p_hierarchy(FAKE_ID):
                return HIERARCHY
            if "/get-schedules-by-flight/" in path:
                return {"data": GAMES[int(path.split("/")[3])]}
            return {"data": []}
        csvs = []
        with patch.object(archive, "get_json", side_effect=get), \
                patch.object(archive, "write_csv", side_effect=lambda p, c, r: csvs.append(p)), \
                contextlib.redirect_stdout(io.StringIO()):
            entry = archive.archive_event(self.src, self.active, "showcase", "Fixture", FAKE, archive.Stats(), False, False)
        self.assertEqual(len(asked), 1 + 2 * 3)   # hierarchy, then standings + schedule per flight
        self.assertFalse(any("brackets" in p or "event-details" in p for p in asked))
        self.assertEqual(entry["kind"], "showcase")
        self.assertTrue(csvs and all(os.sep + "showcases" + os.sep in p for p in csvs))

    def test_showcase_csv_rank_is_tgs_own(self):
        # S-A: a showcase CSV never carries a position the site invented; a conference's does.
        teams = STANDINGS_21[0]["teamStandings"]
        self.assertEqual([r["rank"] for r in archive.standings_rows(teams, "showcase")], [1, 2, 1])
        self.assertEqual([r["rank"] for r in archive.standings_rows(teams)], [1, 2, 3])
        self.assertEqual([r["rank"] for r in archive.standings_rows(teams, "national")], [1, 2, 3])
        written = {}
        with fixture_archive(), patch.object(archive, "write_csv", side_effect=lambda p, c, r: written.__setitem__(p, r)):
            archive.export_flight_csv(self.src, self.active, {
                "kind": "showcase", "conference": "Fixture", "eventId": FAKE_ID, "divisionID": 11,
                "divisionName": "GU13", "flightID": 21, "flightName": "Fixture"})
        standings = [r for p, r in written.items() if p.endswith(".standings.csv")]
        self.assertEqual([[x["rank"] for x in r] for r in standings], [[1, 2, 1]])

    def test_export_rebuilds_showcase_csvs(self):
        # S-D: --export covers every archived showcase, whatever its dates, in its own folder,
        # with its _all.standings.csv; national events stay out as before.
        src = {"seasons": {"2099-00": {"startYear": 2099, "conferences": {},
                                       "national": {"Finals": {"eventId": FAKE_ID + 1}},
                                       "showcases": {"Fixture": dict(FAKE, startDate="2000-01-01", endDate="2000-01-02")}}}}
        written = {}
        with fixture_archive(), patch.object(archive, "write_csv", side_effect=lambda p, c, r: written.__setitem__(p, r)), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(archive.cmd_export(src, "2099-00"), 0)
        base = os.path.join(api.EXPORT_DIR, "2099-00", "showcases", "Fixture")
        self.assertEqual(sorted(os.path.relpath(p, base) for p in written), [
            "GU13-Fixture.schedule.csv", "GU13-Fixture.standings.csv", "GU14-Fixture.schedule.csv", "_all.standings.csv"])
        self.assertEqual([r["rank"] for r in written[os.path.join(base, "_all.standings.csv")]], [1, 2, 1])
        self.assertIn("3 flights across 0 conferences and 1 showcases", out.getvalue())

    def test_cli_rejects_mixed_filters(self):
        for extra in (["--national"], ["--conference", "Texas"]):
            with patch.object(sys, "argv", ["archive.py", "--showcases"] + extra), \
                    patch.object(api, "fetch_api_raw", side_effect=AssertionError("network")), \
                    contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as cm:
                archive.main()
            self.assertEqual(cm.exception.code, 2)
            self.assertIn("--showcases cannot be combined", err.getvalue())

    def test_verify_filters_by_kind(self):
        asked = []

        def details(path, **kw):
            asked.append(path)
            return {"data": {"name": "Fixture Showcase"}}
        with patch.object(api, "fetch_api", side_effect=details), patch.object(archive.time, "sleep"), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(archive.verify(self.src, self.active, None, "showcase"), 0)
        self.assertEqual(asked, [api.p_event_details(FAKE_ID)])
        self.assertIn("1 verified, 0 problem(s)", out.getvalue())


# #103: a fixture season with two showcases, a conference and a national event, and an
# older season with a showcase of its own.
S = "2099-00"
ALPHA, BETA, CONF, OLD, NAT, NOWHERE = 990011, 990012, 990013, 990014, 990015, 990099
FLIGHTS = {ALPHA: [(31, "GU13", 41), (32, "GU14", 42)], BETA: [(33, "GU13", 43), (34, "GU14", 44)]}


def _showcase(eid, event_name):
    return {"eventId": eid, "eventName": event_name, "location": "Phoenix, AZ",
            "startDate": "2099-11-20", "endDate": "2099-11-22"}


TWO = {"seasons": {
    S: {"startYear": 2099,
        "conferences": {"Gamma": {"eventId": CONF, "eventName": "Fixture Gamma"}},
        "national": {"Finals": {"eventId": NAT, "eventName": "Fixture Finals"}},
        "showcases": {"Alpha": _showcase(ALPHA, "Fixture Alpha"), "Beta": _showcase(BETA, "Fixture Beta")}},
    "2098-99": {"startYear": 2098, "conferences": {}, "showcases": {"Old": _showcase(OLD, "Fixture Old")}},
}}


def _upstream(version):
    """What the fake upstream answers for the two showcases; `version` moves every score, so
    a showcase crawled again writes different CSVs."""
    ok = lambda data: json.dumps({"result": "success", "data": data}).encode()
    out = {}
    for eid, flights in FLIGHTS.items():
        out[api.p_event_details(eid)] = ok({"name": TWO["seasons"][S]["showcases"]
                                            ["Alpha" if eid == ALPHA else "Beta"]["eventName"]})
        out[api.p_hierarchy(eid)] = ok({"girlsDivAndFlightList": [
            {"divisionID": d, "divisionName": dn, "flightList": [{"flightID": f, "flightName": "Fixture"}]}
            for d, dn, f in flights], "boysDivAndFlightList": []})
        for d, _dn, f in flights:
            home, away = f * 100 + 1, f * 100 + 2
            out[api.p_standings(d, f, eid)] = ok([{"flightGroupID": 0, "teamStandings": [
                {"teamID": home, "name": f"H{f}", "rank": 1, "gp": 1, "wins": 1, "goalsfor": version},
                {"teamID": away, "name": f"A{f}", "rank": 1, "gp": 1, "losses": 1, "goalsagainst": version}]}])
            out[api.p_schedule(eid, f)] = ok([{
                "matchID": f * 10, "hometeamID": home, "awayteamID": away, "homeTeam": f"H{f}",
                "awayTeam": f"A{f}", "gameDate": "2099-11-20T08:00:00", "type": "Group Play",
                "hometeamscore": version, "awayteamscore": 0}])
    return out


class EventFilterTests(unittest.TestCase):
    """#103: `archive.py --season S --showcases --event <id>` acts on exactly one showcase."""

    def setUp(self):
        self.asked = []
        self.upstream = _upstream(1)
        self.saved = (api.HTTP_ATTEMPTS, api.HTTP_BUDGET)

    def tearDown(self):
        api.HTTP_ATTEMPTS, api.HTTP_BUDGET = self.saved

    def fetch(self, path, **kw):
        self.asked.append(path)
        if path not in self.upstream:
            raise AssertionError(f"unexpected request: {path}")
        return self.upstream[path]

    def run_main(self, argv, sources=TWO, **never):
        """archive.main() with `argv` on `sources`, the fake upstream and every writer named
        in `never` refused (sources=None: the registry must not even be read). Returns (exit
        code, stdout, stderr); an ap.error is exit 2."""
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["archive.py"] + argv))
            stack.enter_context(patch.object(api, "load_sources", return_value=copy.deepcopy(sources))
                                if sources is not None else
                                patch.object(api, "load_sources", side_effect=AssertionError("registry read")))
            stack.enter_context(patch.object(api, "_PROTECTED_PATHS", frozenset()))
            stack.enter_context(patch.object(api, "fetch_api_raw", side_effect=self.fetch))
            stack.enter_context(patch.object(archive.time, "sleep"))
            stack.enter_context(patch.object(archive, "save_sources",
                                             side_effect=AssertionError("sources.json written")))
            # The team histories (#107) are tested in tests/test_team_history.py.
            stack.enter_context(patch.object(archive, "update_team_history"))
            for name in never:
                stack.enter_context(patch.object(archive, name, side_effect=AssertionError(f"{name} called")))
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            try:
                code = archive.main()
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    WRITERS = dict.fromkeys(["archive_event", "save_manifest", "write_csv", "update_team_index",
                             "cmd_refresh", "cmd_export", "cmd_team_index", "cmd_clubs"])

    def test_a_rejected_combinations(self):
        # (a) Each exits 2 before the registry is even read, so before any request.
        ok = ["--season", S, "--showcases", "--event", str(ALPHA)]
        cases = [
            (["--all", "--showcases", "--event", str(ALPHA)], "--all"),
            (["--showcases", "--event", str(ALPHA)], "needs an explicit --season S and --showcases"),
            (["--season", S, "--event", str(ALPHA)], "needs an explicit --season S and --showcases"),
            (["--season", S, "--verify", "--event", str(ALPHA)], "needs an explicit --season S and --showcases"),
            (ok + ["--national"], "--national"),
            (["--season", S, "--national", "--event", str(ALPHA)], "--national"),
            (ok + ["--conference", "Gamma"], "--conference"),
            (ok + ["--refresh"], "--refresh"),
            (ok + ["--refresh", "--dry-run"], "--refresh"),
            (ok + ["--export"], "--export"),
            (ok + ["--team-index"], "--team-index"),
            (ok + ["--clubs"], "--clubs"),
            (ok + ["--clubs", "--dry-run"], "--clubs"),
        ]
        for argv, says in cases:
            with self.subTest(argv=" ".join(argv)):
                attempts = api.HTTP_ATTEMPTS
                code, _out, err = self.run_main(argv, sources=None, **self.WRITERS)
                self.assertEqual(code, 2, err)
                self.assertIn("--event", err)
                self.assertIn(says, err)
                self.assertEqual(self.asked, [])
                self.assertEqual(api.HTTP_ATTEMPTS, attempts)

    def test_b_ids_that_are_not_a_showcase_of_the_season(self):
        # (b) Unknown, another kind's and another season's ids: exit 2, naming what the id
        # is, with 0 requests and nothing written, in every mode.
        cases = [
            (NOWHERE, "no event in the registry"),
            (CONF, f"not a {S} showcase: it is the {S} conference 'Gamma'"),
            (NAT, f"not a {S} showcase: it is the {S} national 'Finals'"),
            (OLD, f"not a {S} showcase: it is the 2098-99 showcase 'Old'"),
        ]
        for eid, says in cases:
            for mode in (["--verify"], ["--dry-run"], [], ["--force"]):
                with self.subTest(event=eid, mode=mode):
                    code, _out, err = self.run_main(["--season", S, "--showcases", "--event", str(eid)] + mode,
                                                    **dict.fromkeys(["archive_event", "save_manifest",
                                                                     "write_csv", "update_team_index"]))
                    self.assertEqual(code, 2, err)
                    self.assertIn(f"--event {eid}", err)
                    self.assertIn(says, err)
                    self.assertEqual(self.asked, [])
        # The real registry: 4133 is a 2025-26 showcase, and a conference id is not one.
        real = api.load_sources()
        conf_name, conf = next(iter(real["seasons"]["2025-26"]["conferences"].items()))
        for season, eid, says in (("2026-27", 4133, "it is the 2025-26 showcase 'Phoenix Spring'"),
                                  ("2025-26", conf["eventId"], f"it is the 2025-26 conference {conf_name!r}")):
            with self.subTest(season=season, event=eid):
                code, _out, err = self.run_main(["--season", season, "--showcases", "--event", str(eid), "--dry-run"],
                                                sources=real, **dict.fromkeys(["archive_event", "save_manifest"]))
                self.assertEqual(code, 2, err)
                self.assertIn(says, err)
                self.assertEqual(self.asked, [])

    def test_c_verify_asks_exactly_one_details_path(self):
        # (c) Two showcases in the season: with --event, one details request; without, both.
        never = dict.fromkeys(["archive_event", "save_manifest", "write_csv", "update_team_index"])
        code, out, err = self.run_main(["--verify", "--season", S, "--showcases", "--event", str(BETA)], **never)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.asked, [api.p_event_details(BETA)])
        self.assertIn("1 verified, 0 problem(s)", out)
        self.assertIn("'Fixture Beta'", out)
        self.asked.clear()
        code, out, _err = self.run_main(["--verify", "--season", S, "--showcases"], **never)
        self.assertEqual(code, 0)
        self.assertEqual(self.asked, [api.p_event_details(ALPHA), api.p_event_details(BETA)])

    def test_repeated_event_is_rejected(self):
        # S1: argparse would keep the last value and act on the other showcase.
        for argv in (["--verify", "--event", str(ALPHA), "--event", str(BETA)],
                     ["--dry-run", "--event", str(ALPHA), "--event", str(ALPHA)],
                     [f"--event={BETA}", "--event", str(ALPHA)]):
            with self.subTest(argv=argv):
                code, _out, err = self.run_main(["--season", S, "--showcases"] + argv, sources=None, **self.WRITERS)
                self.assertEqual(code, 2, err)
                self.assertIn("--event given more than once", err)
                self.assertEqual(self.asked, [])

    def test_a_showcase_id_registered_twice(self):
        # S2: an invalid registry with one eventId on two showcases of the season exits 2
        # with its own message, before any request.
        dup = copy.deepcopy(TWO)
        dup["seasons"][S]["showcases"]["Beta"]["eventId"] = ALPHA
        with self.assertRaises(archive.EventFilterError) as cm:
            archive.select_events(dup, S, kind="showcase", event_id=ALPHA)
        self.assertEqual(str(cm.exception), f"--event {ALPHA} is registered 2 times in {S}: showcases "
                                            f"'Alpha', 'Beta'; an eventId must be unique in sources.json")
        for mode in (["--verify"], ["--dry-run"], []):
            with self.subTest(mode=mode):
                code, _out, err = self.run_main(["--season", S, "--showcases", "--event", str(ALPHA)] + mode,
                                                sources=dup, **self.WRITERS)
                self.assertEqual(code, 2, err)
                self.assertIn(f"is registered 2 times in {S}", err)
                self.assertNotIn("is not a", err)
                self.assertEqual(self.asked, [])

    def test_select_events_without_event(self):
        # S3: the helper's path without --event is the old filter: the kind, and the
        # conference filter that drops national events and showcases.
        names = lambda **kw: [(s, k, n) for s, k, n, _e in archive.select_events(TWO, **kw)]
        self.assertEqual(names(season=S, kind="national"), [(S, "national", "Finals")])
        self.assertEqual(names(season=S, kind="showcase"), [(S, "showcase", "Alpha"), (S, "showcase", "Beta")])
        self.assertEqual(names(season=S), [(S, "conference", "Gamma"), (S, "national", "Finals"),
                                           (S, "showcase", "Alpha"), (S, "showcase", "Beta")])
        self.assertEqual(names(season=S, conference="Gamma"), [(S, "conference", "Gamma")])
        self.assertEqual(names(season=S, conference="Gamma", kind=None), [(S, "conference", "Gamma")])
        self.assertEqual(names(season=None, kind="showcase"),
                         [(S, "showcase", "Alpha"), (S, "showcase", "Beta"), ("2098-99", "showcase", "Old")])

    def test_dry_run_prints_one_would_archive_line(self):
        code, out, err = self.run_main(["--dry-run", "--season", S, "--showcases", "--event", str(ALPHA)],
                                       **dict.fromkeys(["save_manifest", "write_csv", "update_team_index", "get_json"]))
        self.assertEqual(code, 0, out + err)
        lines = [l for l in out.splitlines() if "would archive" in l]
        self.assertEqual(lines, [f"  would archive {S} / Alpha ({ALPHA})"])
        self.assertEqual(self.asked, [])

    def test_d_crawl_fetches_and_writes_only_that_showcase(self):
        # (d) Crawl both showcases, then `--event ALPHA --force` with every score moved
        # upstream: only Alpha's paths are asked; Beta's manifest entry, CSVs and archive
        # files stay byte-identical; the team index is rebuilt for the whole season.
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            archive_dir = os.path.join(tmp, "public", "archive")
            for name, value in (("ARCHIVE_DIR", archive_dir),
                                ("ARCHIVE_API_DIR", os.path.join(archive_dir, "api")),
                                ("MANIFEST_PATH", os.path.join(archive_dir, "manifest.json")),
                                ("TEAM_INDEX_DIR", os.path.join(archive_dir, "teams")),
                                ("CLUBS_PATH", os.path.join(archive_dir, "clubs.json")),
                                ("EXPORT_DIR", os.path.join(tmp, "export"))):
                stack.enter_context(patch.object(api, name, value))
            stack.enter_context(patch.object(archive, "fetch_new_club_places",
                                             side_effect=AssertionError("club step")))
            # A conference already archived, so the season's index has `teams` rows.
            with patch.object(api, "_PROTECTED_PATHS", frozenset()):
                api.write_archive(api.p_hierarchy(CONF), json.dumps({"result": "success", "data": {
                    "girlsDivAndFlightList": [{"divisionID": 51, "divisionName": "GU13",
                                               "flightList": [{"flightID": 61, "flightName": "Gamma"}]}]}}).encode())
                api.write_archive(api.p_standings(51, 61, CONF), json.dumps({"result": "success", "data": [
                    {"teamStandings": [{"teamID": 4101, "name": "H41", "clubID": 7}]}]}).encode())

            code, out, err = self.run_main(["--season", S, "--showcases", "--no-update-sources"])
            self.assertEqual(code, 0, out + err)
            self.assertEqual(len(self.asked), 2 * (1 + 2 * 2))

            # Give Beta's entry a stamp this run could never write, so any rewrite shows.
            with open(api.MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            manifest["events"][f"{S}/Beta"]["fetchedAt"] = "2000-01-01T00:00:00Z"
            manifest["updated"] = "2000-01-01T00:00:00Z"
            with open(api.MANIFEST_PATH, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2, ensure_ascii=False)
                f.write("\n")

            def files(folder):
                return {os.path.relpath(os.path.join(d, n), folder): Path(d, n).read_bytes()
                        for d, _s, names in os.walk(folder) for n in names}
            beta_csv = os.path.join(api.EXPORT_DIR, S, "showcases", "Beta")
            alpha_csv = os.path.join(api.EXPORT_DIR, S, "showcases", "Alpha")
            beta_paths = [p for p in _upstream(1) if f"/{BETA}" in p and "event-details" not in p]
            before_beta_csv, before_alpha_csv = files(beta_csv), files(alpha_csv)
            before_beta_archive = {p: api.read_archive(p)[0] for p in beta_paths}
            index_before = api.read_json_file(api.team_index_path(S))
            self.assertEqual(len(before_beta_csv), 5)       # 2 flights x 2 files + _all.standings.csv
            self.assertTrue(all(before_beta_archive.values()))
            self.assertEqual([r["eventID"] for r in index_before["showcases"]], [ALPHA, ALPHA, BETA, BETA])

            self.asked.clear()
            self.upstream = _upstream(2)
            with patch.object(archive, "update_team_index", wraps=archive.update_team_index) as index_step:
                code, out, err = self.run_main(["--season", S, "--showcases", "--event", str(ALPHA),
                                                "--force", "--no-update-sources"])
            self.assertEqual(code, 0, out + err)
            self.assertEqual(self.asked, [api.p_hierarchy(ALPHA),
                                          api.p_standings(31, 41, ALPHA), api.p_schedule(ALPHA, 41),
                                          api.p_standings(32, 42, ALPHA), api.p_schedule(ALPHA, 42)])
            self.assertEqual(files(beta_csv), before_beta_csv)
            self.assertEqual({p: api.read_archive(p)[0] for p in beta_paths}, before_beta_archive)
            self.assertNotEqual(files(alpha_csv), before_alpha_csv)     # Alpha was crawled again
            # The manifest: Alpha's entry and `updated` replaced, every other byte as before.
            with open(api.MANIFEST_PATH, "r", encoding="utf-8") as f:
                text = f.read()
            after = json.loads(text)
            self.assertNotEqual(after["updated"], manifest["updated"])
            expected = copy.deepcopy(manifest)
            expected["events"][f"{S}/Alpha"] = after["events"][f"{S}/Alpha"]
            expected["updated"] = after["updated"]
            self.assertEqual(text, json.dumps(expected, indent=2, ensure_ascii=False) + "\n")
            self.assertEqual(list(after["events"]), [f"{S}/Alpha", f"{S}/Beta"])
            # The team index: rebuilt once, for the whole season, with both showcases' rows.
            self.assertEqual([c.args[1] for c in index_step.call_args_list], [S])
            index_after = api.read_json_file(api.team_index_path(S))
            self.assertEqual(index_after, index_before)
            self.assertEqual([r["eventID"] for r in index_after["showcases"]], [ALPHA, ALPHA, BETA, BETA])


class RegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()

    def test_names_are_unique_within_a_season(self):
        # S5: `<season>/<name>` is the manifest key and slug(name) the export folder, for
        # every kind; "showcases" is the showcase export folder itself.
        for season, data in self.sources["seasons"].items():
            names = [n for kind in ("conferences", "national", "showcases") for n in (data.get(kind) or {})]
            self.assertEqual(len(names), len(set(names)), f"{season}: a name is used twice: {names}")
            slugs = [api.slug(n).lower() for n in names]
            self.assertEqual(len(slugs), len(set(slugs)), f"{season}: two names share an export folder: {names}")
            self.assertNotIn("showcases", slugs[:len(names) - len(data.get("showcases") or {})], season)

    def test_event_ids_are_unique(self):
        # #103 S2: `--event <id>` resolves an id to one event, so no eventId may be
        # registered twice, across every kind and season.
        seen = {}
        for season, kind, name, ev in api.iter_events(self.sources):
            if ev.get("eventId"):
                seen.setdefault(ev["eventId"], []).append(f"{season} {kind} {name}")
        dupes = {eid: where for eid, where in seen.items() if len(where) > 1}
        self.assertEqual(dupes, {}, "an eventId is registered more than once")
        self.assertGreater(len(seen), 1)

    def test_showcase_entries(self):
        ids = {e["eventId"] for _s, k, _n, e in api.iter_events(self.sources) if k != "showcase"}
        seen = 0
        for season, kind, name, ev in api.iter_events(self.sources):
            if kind != "showcase":
                continue
            seen += 1
            label = f"{season}/{name}"
            self.assertIsInstance(ev.get("eventId"), int, label)
            self.assertNotIn(ev["eventId"], ids, f"{label}: event id also registered as another event")
            self.assertTrue(ev.get("eventName"), f"{label}: eventName (TGS's exact name) is required")
            self.assertRegex(ev.get("location") or "", r"^[^,]+, [A-Z]{2}$", f"{label}: location is 'City, ST'")
            start = datetime.date.fromisoformat(ev["startDate"])
            end = datetime.date.fromisoformat(ev["endDate"])
            first = self.sources["seasons"][season].get("startYear") or int(season[:4])
            self.assertTrue(datetime.date(first, 8, 1) <= start <= end <= datetime.date(first + 1, 7, 31),
                            f"{label}: dates must be ISO, in order, and inside the season")
            for bad in ("reconstructed", "defaultTier"):
                self.assertNotIn(bad, ev, f"{label}: showcases have no brackets or tiers to default")
            aliases = ev.get("teamAliases") or {}
            for k, v in aliases.items():
                self.assertRegex(k, r"^[1-9][0-9]*$", label)
                self.assertIsInstance(v, int, label)
                self.assertNotEqual(int(k), v, label)
            if aliases:
                self.assertTrue(ev.get("teamAliasesNote"), f"{label}: every alias needs its source note")
        self.assertGreaterEqual(seen, 1)

    def test_phoenix_spring(self):
        ev = self.sources["seasons"]["2025-26"]["showcases"]["Phoenix Spring"]
        self.assertEqual((ev["eventId"], ev["eventName"], ev["location"], ev["startDate"], ev["endDate"]),
                         (4133, "ECNL Phoenix - Spring", "Phoenix, AZ", "2026-03-27", "2026-03-29"))
        self.assertEqual(ev["teamAliases"], {"112470": 69910})
        # 2025-26 is not the active season, so 4133 is never refreshed.
        self.assertNotEqual(archive.refresh_policy(self.sources)["activeSeason"], "2025-26")

    def test_san_diego_fall(self):
        # #101: TGS 4041, checked by --verify (name) and the event details (dates, Del Mar).
        ev = self.sources["seasons"]["2025-26"]["showcases"]["San Diego Fall"]
        self.assertEqual((ev["eventId"], ev["eventName"], ev["location"], ev["startDate"], ev["endDate"]),
                         (4041, "ECNL Girls San Diego", "Del Mar, CA", "2025-10-11", "2025-10-13"))
        self.assertEqual(list(ev["tierNotes"]), ["San Diego"], "keyed by the TGS flight name")
        self.assertNotIn("teamAliases", ev, "the #101 alias review found no candidate")
        self.assertNotIn("dataGaps", ev)

    def test_showcases_are_in_calendar_order(self):
        # #101 S4: a season's showcases are listed by startDate (the Showcases tab opens on
        # the first one, and the list reads in calendar order).
        for season, data in self.sources["seasons"].items():
            starts = [ev["startDate"] for ev in (data.get("showcases") or {}).values()]
            self.assertEqual(starts, sorted(starts), f"{season}: showcases not in startDate order")


def _archived(path):
    raw, _ = api.read_archive(path)
    return json.loads(raw) if raw else None


class ArchivedShowcaseTests(unittest.TestCase):
    """Checks on the committed showcase data; each archived showcase is checked (the registry
    test above requires every showcase's fields, so a registered one is never skipped silently
    once crawled)."""

    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()
        cls.events = [(s, n, e) for s, k, n, e in api.iter_events(cls.sources)
                      if k == "showcase" and _archived(api.p_hierarchy(e["eventId"]))]

    def showcase_rows(self, eid):
        """(flightID, standings rows, games) for each flight of an archived showcase."""
        h = _archived(api.p_hierarchy(eid))["data"]
        out = []
        for d in h["girlsDivAndFlightList"] or []:
            for f in d.get("flightList") or []:
                st = _archived(api.p_standings(d["divisionID"], f["flightID"], eid))
                rows = archive.merge_standings_blocks(st["data"]) if st else []
                games = (_archived(api.p_schedule(eid, f["flightID"])) or {}).get("data") or []
                out.append((d, f, rows, games))
        return out

    def test_aliases_are_the_same_team(self):
        # Onboarding checklist, alias review (M3): the showcase id plays at the event under
        # exactly the conference team's name, in the same age group; the conference id is in
        # the season's index and does not itself play at the event.
        if not self.events:
            self.skipTest("no showcase archived yet")
        for season, name, ev in self.events:
            index = api.read_json_file(api.team_index_path(season))["teams"]
            by_id = {t["teamID"]: t for t in index}
            flights = self.showcase_rows(ev["eventId"])
            played = {t for _d, _f, _r, games in flights for g in games for t in (g["hometeamID"], g["awayteamID"])}
            for k, v in (ev.get("teamAliases") or {}).items():
                with self.subTest(showcase=f"{season}/{name}", alias=k):
                    self.assertIn(int(k), played)
                    self.assertNotIn(v, played)
                    self.assertIn(v, by_id)
                    row = next(r for d, _f, rows, _g in flights for r in rows if r["teamID"] == int(k))
                    div = next(d for d, _f, rows, _g in flights if any(r["teamID"] == int(k) for r in rows))
                    self.assertEqual(row["name"], by_id[v]["name"])
                    self.assertEqual(div["divisionName"], by_id[v]["division"])

    def test_phoenix_spring_index_rows(self):
        idx = api.read_json_file(api.team_index_path("2025-26"))
        rows = [r for r in idx.get("showcases") or [] if r["eventID"] == 4133]
        if not any(e["eventId"] == 4133 for _s, _n, e in self.events):
            self.skipTest("4133 not archived yet")
        self.assertEqual([r["flightID"] for r in rows], [36386, 36388, 36390, 36387, 36389, 36391])
        self.assertEqual([len(r["teamIDs"]) for r in rows], [54, 54, 54, 58, 58, 24])
        self.assertEqual([r.get("aliases") for r in rows], [None, None, {"112470": 69910}, None, None, None])
        bare = copy.deepcopy(self.sources)
        bare["seasons"]["2025-26"].pop("showcases")
        self.assertEqual(archive.build_team_index(bare, "2025-26")["teams"], idx["teams"],
                         "the conference rows are what they were without showcases")
        for d, f, standings, games in self.showcase_rows(4133):
            self.assertEqual(len(games) and all(g.get("type") == "Group Play" for g in games), True)
        self.assertEqual(sum(len(g) for *_x, g in self.showcase_rows(4133)), 453)

    def test_san_diego_fall_index_rows(self):
        # #101 S1: TGS 4041, one flight per age group, in hierarchy order.
        if not any(e["eventId"] == 4041 for _s, _n, e in self.events):
            self.skipTest("4041 not archived yet")
        idx = api.read_json_file(api.team_index_path("2025-26"))
        rows = [r for r in idx.get("showcases") or [] if r["eventID"] == 4041]
        self.assertEqual([r["flightID"] for r in rows], [34643, 34645, 34646, 34644])
        self.assertEqual([len(r["teamIDs"]) for r in rows], [30, 28, 30, 22])
        self.assertEqual([r.get("aliases") for r in rows], [None] * 4)
        flights = self.showcase_rows(4041)
        self.assertEqual([len(standings) for _d, _f, standings, _g in flights], [30, 28, 30, 22])
        self.assertEqual(sum(len(g) for *_x, g in flights), 165)

    def test_every_showcase_game_is_group_play(self):
        # #101 S1: a showcase has no knockout, so no title is at stake (the Format note says
        # so); a bracket game would need a new design, not a note.
        if not self.events:
            self.skipTest("no showcase archived yet")
        for season, name, ev in self.events:
            for d, f, _standings, games in self.showcase_rows(ev["eventId"]):
                with self.subTest(showcase=f"{season}/{name}", flight=f["flightID"]):
                    self.assertTrue(games)
                    self.assertEqual({g.get("type") for g in games}, {"Group Play"})

    def test_only_mirrored_families(self):
        if not self.events:
            self.skipTest("no showcase archived yet")
        for _s, _n, ev in self.events:
            eid = ev["eventId"]
            self.assertIsNone(api.read_archive(api.p_event_details(eid))[0], "event details are never archived")
            for d, f, _r, _g in self.showcase_rows(eid):
                self.assertIsNone(api.read_archive(api.p_brackets_design(eid, f["flightID"]))[0])
                self.assertIsNone(api.read_archive(api.p_brackets(eid, f["flightID"]))[0])


class RequestBudgetTests(unittest.TestCase):
    """S7: every HTTP attempt counts, retries included, and a budget stops the next one."""

    def setUp(self):
        self.saved = (api.HTTP_ATTEMPTS, api.HTTP_BUDGET)
        api.HTTP_ATTEMPTS, api.HTTP_BUDGET = 0, None

    def tearDown(self):
        api.HTTP_ATTEMPTS, api.HTTP_BUDGET = self.saved

    @staticmethod
    def answer_503(*a, **kw):
        raise urllib.error.HTTPError("https://example.invalid/", 503, "Service Unavailable", {}, io.BytesIO(b""))

    def test_retries_count(self):
        with patch.object(api.urllib.request, "urlopen", side_effect=self.answer_503) as urlopen, \
                patch.object(api.time, "sleep"):
            with self.assertRaises(api.ApiError):
                api.fetch_api_raw("Event/get-event-schedule-or-standings/1")
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(api.HTTP_ATTEMPTS, 3)

    def test_budget_stops_inside_a_retry_loop(self):
        api.HTTP_BUDGET = 2
        with patch.object(api.urllib.request, "urlopen", side_effect=self.answer_503) as urlopen, \
                patch.object(api.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(api.BudgetSpent):
                api.fetch_api_raw("Event/get-event-schedule-or-standings/1")
            with self.assertRaises(api.BudgetSpent):
                api.fetch_api_raw("Event/get-event-schedule-or-standings/2")
        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(api.HTTP_ATTEMPTS, 2)
        self.assertTrue(issubclass(api.BudgetSpent, api.ApiError))   # the crawl reports it as a failure

    def test_budget_prints_every_attempt(self):
        # S-C: under --max-requests each attempt is one printed line (the record kept on
        # the onboarding issue); without a budget nothing is printed.
        class Ok:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"data":[]}'
        answers = [Ok(), urllib.error.HTTPError("https://example.invalid/", 503, "x", {}, io.BytesIO(b"")), Ok()]
        with patch.object(api.urllib.request, "urlopen", side_effect=answers), patch.object(api.time, "sleep"), contextlib.redirect_stdout(io.StringIO()) as out:
            api.fetch_api_raw("Event/get-event-schedule-or-standings/1")      # silent: no budget
            api.HTTP_BUDGET = 5
            api.fetch_api_raw("Event/get-event-schedule-or-standings/2")      # a 503, then a 200
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 2, lines)
        self.assertRegex(lines[0], r"^  request 2/5\t\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\t"
                                   r"Event/get-event-schedule-or-standings/2\t503\t0 B$")
        self.assertRegex(lines[1], r"^  request 3/5\t.*Z\tEvent/get-event-schedule-or-standings/2\t200\t11 B$")


if __name__ == "__main__":
    unittest.main()
