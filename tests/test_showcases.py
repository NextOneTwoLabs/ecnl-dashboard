"""Showcases, the third event kind (#97): a season's `showcases` map in sources.json.

(a) The crawler and the refresh, on fixtures: the event kind, the refresh window (the
    event's own dates only, with --date passed through), the team index's showcase
    rows, the export folder, no brackets, the CLI guards, and the request budget that
    counts retries.
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


def fixture_archive(event_id=FAKE_ID):
    """read_archive answering the fixture showcase's hierarchy and schedules, and the
    real archive for everything else."""
    real = api.read_archive
    files = {api.p_hierarchy(event_id): HIERARCHY}
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
        self.assertEqual(written, [os.path.join(api.EXPORT_DIR, api.slug(self.active), "showcases", "Fixture",
                                                "GU13-Fixture.schedule.csv")])

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
                patch.object(api.time, "sleep"):
            with self.assertRaises(api.BudgetSpent):
                api.fetch_api_raw("Event/get-event-schedule-or-standings/1")
            with self.assertRaises(api.BudgetSpent):
                api.fetch_api_raw("Event/get-event-schedule-or-standings/2")
        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(api.HTTP_ATTEMPTS, 2)
        self.assertTrue(issubclass(api.BudgetSpent, api.ApiError))   # the crawl reports it as a failure


if __name__ == "__main__":
    unittest.main()
