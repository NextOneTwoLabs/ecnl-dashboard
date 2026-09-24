"""Club places (#87): the archive allow list, the normaliser, the club fetch rules,
the bounded sweep, the monthly gate and its back-off, the --clubs CLI and the
season-crawl hook, and the privacy of the written file.

No test makes a network request: api.fetch_api_raw is always patched, and CI runs
the suite under tests/netguard, which fails the run if anything reaches out.
"""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive
import ecnl_api as api
import proxy_server


def body(club_id, city="Davis", name="California", code="CA", **extra):
    data = {"clubID": club_id, "name": "Fixture FC", "city": city, "statename": name, "statecode": code,
            "country": "United States", **extra}
    return json.dumps({"result": "success", "data": {"homeJersey": "", "awayJersey": "", "clubData": data}}).encode()


def null_body():
    return json.dumps({"result": "success", "data": {"homeJersey": None, "awayJersey": None, "clubData": None}}).encode()


def by_path(path, **kw):
    """A fixture response for whichever club `path` names."""
    return body(int(path.rsplit("/", 1)[1]), **kw)


def fail_503(path, **kw):
    raise api.ApiError("HTTP 503")


class Sandbox:
    """Temporary clubs.json, refresh-state.json and match-days.json; nothing sleeps."""
    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(api, "CLUBS_PATH", os.path.join(d, "clubs.json")))
        self.stack.enter_context(patch.object(api, "REFRESH_STATE_PATH", os.path.join(d, "refresh-state.json")))
        self.stack.enter_context(patch.object(api, "MATCH_DAYS_PATH", os.path.join(d, "match-days.json")))
        self.stack.enter_context(patch.object(api, "MANIFEST_PATH", os.path.join(d, "manifest.json")))
        self.sleep = self.stack.enter_context(patch.object(archive.time, "sleep"))
        return self

    def __exit__(self, *exc):
        self.stack.close()
        self.tmp.cleanup()

    @staticmethod
    def clubs():
        return archive.load_club_places()

    @staticmethod
    def seed(clubs):
        archive.write_club_places(clubs)


class AllowListTests(unittest.TestCase):
    REFUSED = ["Event/get-club-info/1425", "Event/get-individual-team-info",
               "Event/get-individual-club-info-with-teams-and-staff/9/1425/4267",
               "Event/get-some-future-endpoint/1", "Other/get-standings-by-div-and-flight/1/2/3",
               # an allowed family with the wrong number of ids, or a non-numeric id
               "Event/get-standings-by-div-and-flight/1/2", "Event/get-standings-by-div-and-flight/1/2/3/4",
               "Event/get-event-details-by-eventID/1/2", "Event/get-event-schedule-or-standings",
               "Event/get-schedules-by-flight/1/2/x", "Event/get-flight-brackets-by-flight/1"]

    def test_refused_paths_write_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(api, "ARCHIVE_API_DIR", tmp), \
                contextlib.redirect_stderr(io.StringIO()):
            for path in self.REFUSED:
                self.assertIsNone(api.write_archive(path, b"{}"), path)
            self.assertEqual(list(Path(tmp).rglob("*")), [])
            self.assertIsNotNone(api.write_archive(api.p_standings(1, 2, 3), b"{}"))

    def test_every_crawl_path_is_archivable(self):
        for path in (api.p_hierarchy(1), api.p_standings(1, 2, 3), api.p_schedule(1, 2), api.p_brackets(1, 2),
                     api.p_brackets_design(1, 2), api.p_event_details(1)):
            self.assertTrue(api.is_archivable_path(path), path)
        self.assertFalse(api.is_archivable_path(api.p_club_info(1425)))
        self.assertEqual(len(api.ARCHIVE_FAMILIES), 6)

    def test_proxy_refuses_before_fetching(self):
        sent = []
        fake = type("H", (), {"_send_json": lambda self, code, obj: sent.append(code)})()
        with patch.object(api, "fetch_api_raw", side_effect=AssertionError("fetched a refused path")), \
                patch.object(api, "write_archive", side_effect=AssertionError("wrote a refused path")), \
                patch.object(proxy_server, "OFFLINE", False):
            for path in self.REFUSED:
                proxy_server.ProxyHandler._handle_api(fake, path, False)
        self.assertEqual(sent, [404] * len(self.REFUSED))

    def test_archive_tree_holds_only_allowed_paths(self):
        root = Path(api.ARCHIVE_API_DIR)
        self.assertEqual(sorted(p.name for p in root.iterdir()), ["Event"])
        bad, count = [], 0
        for f in root.rglob("*"):
            if f.is_file():
                count += 1
                rel = f.relative_to(root).as_posix()
                if not (rel.endswith(".json") and api.is_archivable_path(rel[:-5])):
                    bad.append(rel)
        self.assertEqual(bad, [], "remove these and never commit them: they may hold personal data")
        self.assertGreater(count, 1000)


class NormaliserTests(unittest.TestCase):
    @staticmethod
    def rec(city, name="", code="", country="United States"):
        return {"city": city, "statename": name, "statecode": code, "country": country}

    def test_cases(self):
        P = lambda c, s: {"city": c, "state": s}
        cases = [
            (self.rec("Denver, CO 80000 ", "Colorado", "CO"), P("Denver", "CO")),
            (self.rec("Denver, CO", "Colorado", "CO"), P("Denver", "CO")),
            (self.rec("Denver, CO 80000", "Texas", "TX"), None),
            (self.rec("Denver, co", "Colorado", "CO"), None),          # a comma left after the ZIP rule
            (self.rec("Denver, Colorado", "Colorado", "CO"), None),
            (self.rec("", "New Jersey", "NJ"), None),
            (self.rec("Cupertino", "California", "CA", country="Canada"), P("Cupertino", "CA")),
            (self.rec("Pineville ", "North Carolina", "NC"), P("Pineville", "NC")),
            (self.rec("Loves park", "Illinois", "IL"), P("Loves Park", "IL")),
            (self.rec("  hamilton ,", "New Jersey", "NJ"), P("Hamilton", "NJ")),
            (self.rec("st. louis", "Missouri", "MO"), P("St. Louis", "MO")),
            (self.rec("winston-salem", "North Carolina", "NC"), P("Winston-Salem", "NC")),
            (self.rec("stratford-on-avon", "Connecticut", "CT"), P("Stratford-on-Avon", "CT")),
            (self.rec("O'FALLON", "Missouri", "MO"), P("O'FALLON", "MO")),
            (self.rec("o'fallon", "Illinois", "IL"), P("O'Fallon", "IL")),
            (self.rec("mckinney", "Texas", "TX"), P("McKinney", "TX")),
            (self.rec("McKinney", "Texas", "TX"), P("McKinney", "TX")),
            (self.rec("DE PERE", "Wisconsin", "WI"), P("DE PERE", "WI")),
            (self.rec("Bay Area", "California", "CA"), P("Bay Area", "CA")),
            (self.rec("Shelby Twp", "Michigan", "MI"), P("Shelby Twp", "MI")),
            (self.rec("Ontario", "California", "CA"), P("Ontario", "CA")),
            (self.rec("Portland", "OR", ""), P("Portland", "OR")),
            (self.rec("Portland", "", "Oregon"), P("Portland", "OR")),
            (self.rec("Laval", "Québec", ""), P("Laval", "QC")),
            (self.rec("Vancouver", "British Columbia", ""), P("Vancouver", "BC")),
            (self.rec("Hagatna", "Guam", "GU"), P("Hagatna", "GU")),
            (self.rec("London", "England", "EN"), None),
            (self.rec("PO Box 12", "Texas", "TX"), None),
            (self.rec("P.O. Box", "Texas", "TX"), None),
            (self.rec("12 Main", "Texas", "TX"), None),
            (self.rec("info@club.org", "Texas", "TX"), None),
            (self.rec("A" * 41, "Texas", "TX"), None),
            (None, None),
        ]
        for rec, want in cases:
            with self.subTest(rec=rec):
                self.assertEqual(archive.club_place(rec), want)


class FetchRuleTests(unittest.TestCase):
    def fetch(self, raw, cid="7"):
        with patch.object(api, "fetch_api_raw", return_value=raw) as f:
            try:
                return archive.fetch_club_place(cid)
            finally:
                self.assertEqual(f.call_args.args, (api.p_club_info(cid),))
                self.assertEqual(f.call_args.kwargs, {"timeout": 10, "retries": 2})

    def test_null_clubdata_or_other_id_is_a_failed_fetch(self):
        for raw in (null_body(), body(8), json.dumps({"result": "error"}).encode(), b"[]"):
            with self.subTest(raw=raw), self.assertRaises(archive.ClubRecordMissing):
                self.fetch(raw)

    def test_real_record_with_unusable_city_is_null(self):
        self.assertIsNone(self.fetch(body(7, city="")))
        self.assertEqual(self.fetch(body(7)), {"city": "Davis", "state": "CA"})

    def test_missing_record_keeps_entry_and_nulls_only_new_ids(self):
        with Sandbox() as sb, contextlib.redirect_stdout(io.StringIO()):
            sb.seed({"1": {"city": "Davis", "state": "CA"}})
            with patch.object(api, "fetch_api_raw", return_value=null_body()):
                archive.update_club_places(["1", "2"], archive.Stats(), "t")
            self.assertEqual(sb.clubs(), {"1": {"city": "Davis", "state": "CA"}, "2": None})

    def test_transport_failure_keeps_entry_and_adds_nothing(self):
        with Sandbox() as sb, contextlib.redirect_stdout(io.StringIO()):
            sb.seed({"1": {"city": "Davis", "state": "CA"}})
            with patch.object(api, "fetch_api_raw", side_effect=api.ApiError("HTTP 503")):
                archive.update_club_places(["1", "2"], archive.Stats(), "t")
            self.assertEqual(sb.clubs(), {"1": {"city": "Davis", "state": "CA"}})

    def test_no_empty_file_is_created(self):
        with Sandbox(), contextlib.redirect_stdout(io.StringIO()):
            with patch.object(api, "fetch_api_raw", side_effect=api.ApiError("HTTP 503")):
                archive.update_club_places(["1"], archive.Stats(), "t")
            self.assertFalse(os.path.exists(api.CLUBS_PATH))

    def test_wipe_guard_aborts_and_writes_nothing(self):
        ids = [str(i) for i in range(1, 101)]
        good = {i: {"city": "Davis", "state": "CA"} for i in ids}
        for blanks, aborted in ((5, False), (6, True)):
            with self.subTest(blanks=blanks), Sandbox() as sb, contextlib.redirect_stdout(io.StringIO()):
                sb.seed(good)
                raws = [body(int(i), city="" if n < blanks else "Davis") for n, i in enumerate(ids)]
                stats = archive.Stats()
                with patch.object(api, "fetch_api_raw", side_effect=raws):
                    completed = archive.update_club_places(ids, stats, "t")
                nulls = sum(v is None for v in sb.clubs().values())
                self.assertEqual(nulls, 0 if aborted else blanks)
                self.assertEqual(any("aborted" in e for e in stats.errors), aborted)
                self.assertEqual(completed, not aborted)
                self.assertEqual(stats.fetched, 100)        # club requests are counted


class BoundsTests(unittest.TestCase):
    IDS = [str(i) for i in range(1, 122)]

    def test_failure_cap_stops_the_sweep(self):
        calls = []
        def fetch(cid):
            calls.append(cid)
            if int(cid) % 2:
                raise api.ApiError("flaky")   # intermittent: never many in a row
            return {"city": "Davis", "state": "CA"}
        _, rep = archive.sweep_club_places(self.IDS, {}, fetch=fetch, sleep=lambda s: None)
        self.assertEqual(len(rep["errors"]), 10)
        self.assertEqual(len(calls), 19)
        self.assertEqual(rep["requested"], 19)
        self.assertTrue(rep["stopped"])

    def test_tenth_failure_on_the_last_club_is_not_complete(self):
        ids = [str(i) for i in range(1, 11)]
        _, rep = archive.sweep_club_places(ids, {}, fetch=lambda c: fail_503(c), sleep=lambda s: None)
        self.assertEqual((rep["requested"], len(rep["errors"])), (10, 10))
        self.assertTrue(rep["stopped"])
        _, rep = archive.sweep_club_places(ids[:9], {}, fetch=lambda c: fail_503(c), sleep=lambda s: None)
        self.assertIsNone(rep["stopped"])      # nine failures: finished, errors reported

    def test_time_budget_stops_the_sweep(self):
        t = [0.0]
        def fetch(cid):
            t[0] += 20            # a slow TGS: 20 s per club
            return None
        _, rep = archive.sweep_club_places(self.IDS, {}, fetch=fetch, sleep=lambda s: None, clock=lambda: t[0])
        self.assertEqual(rep["fetched"], 25)
        self.assertIn("budget", rep["stopped"])

    def test_paced_at_1_2_seconds(self):
        sleeps = []
        archive.sweep_club_places(["1", "2", "3"], {}, fetch=lambda c: None, sleep=sleeps.append)
        self.assertEqual(sleeps, [1.2, 1.2])


class PrivacyTests(unittest.TestCase):
    MARKERS = {"address": "MARKER-STREET-1", "zip": "MARKER-ZIP-2", "phone": "MARKER-PHONE-3",
               "clubpresident": "MARKER-PRESIDENT-4", "clubpresidentemail": "marker5@example.invalid",
               "clubpresidentphone": "MARKER-PPHONE-6", "fullAddress": "MARKER-FULL-7",
               "location": "MARKER-LOCATION-8", "tgsRepUserID": 987654321, "clubwebsite": "MARKER-WEB-9"}

    def test_no_marker_reaches_the_written_file(self):
        with Sandbox(), contextlib.redirect_stdout(io.StringIO()) as out:
            raws = [body(1, **self.MARKERS), body(2, city="", **self.MARKERS)]
            with patch.object(api, "fetch_api_raw", side_effect=raws):
                archive.update_club_places(["1", "2"], archive.Stats(), "t")
            written = Path(api.CLUBS_PATH).read_bytes()
        for key, marker in self.MARKERS.items():
            self.assertNotIn(str(marker).encode(), written, key)
            self.assertNotIn(str(marker), out.getvalue(), key)
        self.assertEqual(written, b'{"schema":1,"clubs":{\n"1":{"city":"Davis","state":"CA"},\n"2":null\n}}\n')

    def test_committed_file_holds_only_city_and_state(self):
        committed = api.read_json_file(api.CLUBS_PATH)
        if committed is None:
            self.skipTest("no clubs.json committed yet")
        self.assertEqual(set(committed), {"schema", "clubs"})
        self.assertEqual(committed["schema"], 1)
        for k, v in committed["clubs"].items():
            self.assertRegex(k, r"^[1-9][0-9]*$")
            self.assertTrue(v is None or (set(v) == {"city", "state"} and v["state"] in archive.CLUB_STATE_CODES
                                          and archive.club_place({"city": v["city"], "statecode": v["state"]}) == v),
                            (k, v))


class RefreshTests(unittest.TestCase):
    IDS = [str(i) for i in range(1, 122)]
    GOOD = {i: {"city": "Davis", "state": "CA"} for i in IDS}

    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()

    @staticmethod
    def args(date, hour, **kw):
        return argparse.Namespace(**dict(dict(date=date, at_hour=hour, sweep=False, dry_run=False, force=True), **kw))

    def run_refresh(self, date, sweep=True, raws=by_path, dry_run=False):
        calls = []
        def fake(path, **kw):
            calls.append(path)
            return raws(path)
        flight = {"key": "1/2", "eventId": 1, "flightID": 2, "divisionID": 3,
                  "conference": "Fixture", "divisionName": "GU16", "flightName": "ECNL"}
        with patch.object(archive, "fetch_json", side_effect=api.ApiError("offline fixture")), \
                patch.object(archive, "season_flights", return_value=[flight]), \
                patch.object(archive, "build_match_days", return_value={"days": {}}), \
                patch.object(archive, "export_flight_csv"), \
                patch.object(archive, "update_team_index"), \
                patch.object(archive, "club_ids", return_value=self.IDS), \
                patch.object(api, "fetch_api_raw", side_effect=fake), \
                contextlib.redirect_stdout(io.StringIO()):
            archive.cmd_refresh(self.sources, self.args(date, 7, sweep=sweep, dry_run=dry_run))
        return calls

    @staticmethod
    def dates():
        s = api.load_refresh_state()
        return s.get("lastClubSweepDate"), s.get("lastClubSweepAttempt")

    def test_monthly_gate_and_carry_forward(self):
        with Sandbox() as sb:
            self.assertEqual(len(self.run_refresh("2026-10-03")), 121)          # first sweep of October
            self.assertEqual(self.dates(), ("2026-10-03", "2026-10-03"))
            self.assertEqual(api.load_refresh_state()["requests"], 121)        # counted in `requests`
            self.assertEqual(len(self.run_refresh("2026-10-03", sweep=False)), 0)   # a non-sweep run
            self.assertEqual(self.dates(), ("2026-10-03", "2026-10-03"))       # both carried forward
            self.assertEqual(len(self.run_refresh("2026-10-04")), 0)             # same month: nothing
            clubs = sb.clubs(); del clubs["57"]; archive.write_club_places(clubs)
            self.assertEqual(self.run_refresh("2026-10-05"), [api.p_club_info(57)])  # a new club, same month
            self.assertEqual(self.dates(), ("2026-10-03", "2026-10-03"))
            self.assertEqual(len(self.run_refresh("2026-11-01")), 121)          # next calendar month
            self.assertEqual(self.dates(), ("2026-11-01", "2026-11-01"))

    def test_failed_recheck_backs_off_a_week(self):
        with Sandbox() as sb:
            sb.seed(self.GOOD)
            self.assertEqual(len(self.run_refresh("2026-10-03", raws=fail_503)), 10)   # stopped by the cap
            self.assertEqual(self.dates(), (None, "2026-10-03"))
            self.assertEqual(sb.clubs(), self.GOOD)                               # nothing lost
            for day in range(4, 10):                                              # no daily re-fetch
                self.assertEqual(len(self.run_refresh(f"2026-10-{day:02d}", raws=fail_503)), 0, day)
            self.assertEqual(self.dates(), (None, "2026-10-03"))
            self.assertEqual(len(self.run_refresh("2026-10-10", raws=fail_503)), 10)   # one retry a week
            self.assertEqual(self.dates(), (None, "2026-10-10"))
            self.assertEqual(len(self.run_refresh("2026-10-17")), 121)            # TGS is back
            self.assertEqual(self.dates(), ("2026-10-17", "2026-10-17"))
            self.assertEqual(len(self.run_refresh("2026-10-18")), 0)

    def test_aborted_recheck_does_not_advance(self):
        with Sandbox() as sb:
            sb.seed(self.GOOD)
            blank = lambda p: by_path(p, city="")
            self.assertEqual(len(self.run_refresh("2026-11-01", raws=blank)), 121)
            self.assertEqual(self.dates(), (None, "2026-11-01"))
            self.assertEqual(sb.clubs(), self.GOOD)                               # the wipe guard wrote nothing
            self.assertEqual(len(self.run_refresh("2026-11-02", raws=blank)), 0)  # backing off

    def test_new_clubs_still_fetched_while_backing_off(self):
        with Sandbox() as sb:
            sb.seed({k: v for k, v in self.GOOD.items() if k != "99"})
            with open(api.REFRESH_STATE_PATH, "w", encoding="utf-8") as f:
                json.dump({"lastClubSweepDate": "2026-09-05", "lastClubSweepAttempt": "2026-10-01"}, f)
            self.assertEqual(self.run_refresh("2026-10-03"), [api.p_club_info(99)])
            self.assertEqual(self.dates(), ("2026-09-05", "2026-10-01"))

    def test_dry_run_makes_no_club_request(self):
        with Sandbox():
            self.assertEqual(self.run_refresh("2026-10-03", dry_run=True), [])


class CliTests(unittest.TestCase):
    """`archive.py --clubs [--season S | --all] [--force] [--dry-run]` and the crawl hook."""
    SEASON_IDS = {"2026-27": ["1", "2", "3"], "2025-26": ["3", "4"]}

    def main(self, *argv, raws=by_path):
        calls = []
        def fake(path, **kw):
            calls.append(path)
            return raws(path)
        def ids(seasons):
            return list(dict.fromkeys(c for s in seasons for c in self.SEASON_IDS.get(s, [])))
        with patch.object(sys, "argv", ["archive.py", *argv]), \
                patch.object(archive, "club_ids", side_effect=ids), \
                patch.object(archive, "archive_event", return_value=None), \
                patch.object(archive, "update_team_index"), \
                patch.object(archive, "save_sources", side_effect=AssertionError("wrote sources.json")), \
                patch.object(api, "fetch_api_raw", side_effect=fake), \
                contextlib.redirect_stdout(io.StringIO()):
            code = archive.main()
        return code, [int(p.rsplit("/", 1)[1]) for p in calls]

    def test_dry_run_makes_no_request(self):
        with Sandbox():
            for argv in (["--clubs", "--all", "--dry-run"], ["--clubs", "--season", "2026-27", "--dry-run", "--force"],
                         ["--season", "2026-27", "--dry-run"]):
                with self.subTest(argv=argv):
                    self.assertEqual(self.main(*argv), (0, []))
            self.assertFalse(os.path.exists(api.CLUBS_PATH))

    def test_season_all_and_force(self):
        with Sandbox() as sb:
            self.assertEqual(self.main("--clubs", "--season", "2026-27"), (0, [1, 2, 3]))
            self.assertEqual(self.main("--clubs", "--all"), (0, [4]))              # only the missing one
            self.assertEqual(self.main("--clubs", "--all"), (0, []))               # a second run: 0 requests
            self.assertEqual(self.main("--clubs", "--season", "2025-26", "--force"), (0, [3, 4]))
            self.assertEqual(set(sb.clubs()), {"1", "2", "3", "4"})
            self.assertFalse(os.path.exists(api.REFRESH_STATE_PATH))              # never stands in for the re-check

    def test_cli_failures_are_capped_and_loud(self):
        with Sandbox() as sb, patch.dict(self.SEASON_IDS, {"2026-27": [str(i) for i in range(1, 31)]}):
            code, calls = self.main("--clubs", "--season", "2026-27", raws=fail_503)
            self.assertEqual((code, len(calls)), (1, 10))
            self.assertEqual(sb.clubs(), {})

    def test_season_crawl_fetches_only_new_clubs(self):
        with Sandbox() as sb:
            sb.seed({"1": {"city": "Davis", "state": "CA"}})
            self.assertEqual(self.main("--season", "2026-27"), (0, [2, 3]))
            self.assertEqual(self.main("--season", "2026-27"), (0, []))
            self.assertEqual(self.main("--season", "2026-27", "--national"), (0, []))


if __name__ == "__main__":
    unittest.main()
