"""Team directory (#114): public/archive/directory.json, built by team_directory.py.

(a) The committed file equals a fresh build of the committed archive (the drift check).
(b) Invariants, every expectation derived from the archive at run time, never a written total
    (#114 M6): every conference team-season once; the same squads as the history files; the
    #107 "possible continuation" links both ways; no event-only teams (#97 D4, #114 D3);
    the place column equals clubs.json, never for club 7; the key allow-list; the size budget.
(c) Writing: unchanged bytes are not rewritten; a failed write leaves the old file; --dry-run
    writes nothing; --clubs updates the places in place.
(d) The pipeline (#114 M3): the refresh builds the directory last, after the club places, from
    its own history build; a directory failure fails the run but keeps the histories and
    historyAsOf; the drift check (--team-history --check) covers the directory.
"""
import argparse
import contextlib
import functools
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive
import ecnl_api as api
import team_directory as td
import team_history as th

FIX = "run `python archive.py --team-history`, then commit public/archive/directory.json"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@functools.lru_cache(maxsize=None)
def built():
    """One build of the committed archive's squads, shared by the tests that only read it."""
    return th.build()[0]


@functools.lru_cache(maxsize=None)
def fresh():
    return td.file_bytes(api.load_sources(), built())


_SEED = []


def seed(tmp):
    """A private archive directory: a fresh build of the history files (once per run), the
    committed refresh state and the active team index, so nothing here writes the checkout."""
    if not _SEED:
        d = tempfile.mkdtemp()
        unittest.addModuleCleanup(shutil.rmtree, d, ignore_errors=True)
        th.write_history(out_dir=os.path.join(d, "history"))
        _SEED.append(os.path.join(d, "history"))
    shutil.copytree(_SEED[0], os.path.join(tmp, "history"))
    shutil.copy(api.REFRESH_STATE_PATH, os.path.join(tmp, "refresh-state.json"))
    shutil.copy(api.CLUBS_PATH, os.path.join(tmp, "clubs.json"))


class Committed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()
        cls.data = fresh()
        cls.doc = json.loads(cls.data)
        cls.history = [sq for f in sorted(Path(api.ARCHIVE_DIR, "history").glob("*.json")) for sq in load(f)["squads"]]

    def test_the_committed_file_equals_a_fresh_build(self):
        on_disk = Path(td.directory_path()).read_bytes().replace(b"\r\n", b"\n")
        self.assertTrue(on_disk == self.data, f"directory.json differs from a fresh build; {FIX}")

    def test_every_conference_team_season_once(self):
        want = set()
        for s in self.sources["seasons"]:
            idx = api.read_json_file(api.team_index_path(s))
            if idx:
                want |= {(s, t["teamID"]) for t in idx["teams"] if t.get("flightName") != "Play-In-Game"}
        got = [(self.doc["seasons"][r[0]], r[1]) for sq in self.doc["squads"] for r in sq["s"]]
        self.assertEqual(len(got), len(set(got)))
        self.assertEqual(set(got), want)

    def test_the_same_squads_as_the_history_files(self):
        key = lambda rows: tuple(rows)
        want = {key((r["season"], r["teamID"]) for r in sq["seasons"]) for sq in self.history}
        got = {key((self.doc["seasons"][r[0]], r[1]) for r in sq["s"]) for sq in self.doc["squads"]}
        self.assertEqual(got, want)

    def test_possible_continuations_match_the_history_files_both_ways(self):
        sq = self.doc["squads"]
        firsts = {(self.doc["seasons"][x["s"][0][0]], x["s"][0][1]): i for i, x in enumerate(sq)}
        for h in self.history:
            i = firsts[(h["seasons"][0]["season"], h["seasons"][0]["teamID"])]
            want = {firsts[next((self.doc["seasons"][x["s"][0][0]], x["s"][0][1]) for x in sq
                                if (m["season"], m["teamID"]) in {(self.doc["seasons"][r[0]], r[1]) for r in x["s"]})]
                    for m in h.get("maybe", [])}
            self.assertEqual(set(sq[i].get("m", [])), want)
            for j in sq[i].get("m", []):
                self.assertIn(i, sq[j].get("mp", []))

    def test_no_event_only_teams(self):
        """#97 decision 4 and #114 D3: only teams with a conference row, i.e. a team page."""
        self.assertEqual(set(self.doc), {"schema", "seasons", "confs", "divs", "events", "tiers", "clubs", "squads"})
        # A squad is in the file of each id it used, so the history files list some twice.
        distinct = {(sq["seasons"][0]["season"], sq["seasons"][0]["teamID"]) for sq in self.history}
        self.assertEqual(len(self.doc["squads"]), len(distinct))

    def test_allow_list(self):
        """Team-level public data only, every value already served by another route."""
        for sq in self.doc["squads"]:
            self.assertLessEqual(set(sq), {"c", "b", "s", "e", "best", "t", "m", "mp"})
            for r in sq["s"]:
                self.assertEqual(len(r), 7)
            for e in sq.get("e", []):
                self.assertEqual(len(e), 4)
        for c in self.doc["clubs"]:
            self.assertEqual(len(c), 4)          # id, name, logo URL (as in the team indexes), "City, ST"
        text = re.sub(r'"https://[^"]*"', '""', self.data.decode("utf-8"))
        self.assertIsNone(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text), "an email address")
        self.assertIsNone(re.search(r"\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b", text), "a phone number")

    def test_logos_are_the_team_indexes_own(self):
        served = set()
        for s in self.sources["seasons"]:
            idx = api.read_json_file(api.team_index_path(s))
            served |= {t.get("clublogo") for t in (idx or {}).get("teams", [])}
        self.assertTrue(all(c[2] in served for c in self.doc["clubs"] if c[2]), "no logo URL that isn't already served")

    def test_places_equal_clubs_json_and_club_7_has_none(self):
        places = api.read_json_file(api.CLUBS_PATH)["clubs"]
        for cid, _name, _logo, place in self.doc["clubs"]:
            p = places.get(str(cid))
            want = f"{p['city']}, {p['state']}" if p and cid != td.NO_CLUB else ""
            self.assertEqual(place, want, cid)

    def test_size_budget(self):
        """#114 S9: about 405 KB raw (74 KB gzip) for 2020-21 to 2026-27, growing about 60 KB a
        season, so this fails in about three seasons. Then decide on a slimmer format or split
        files; don't just raise the number."""
        self.assertLess(len(self.data), 600_000)
        self.assertLess(len(gzip.compress(self.data, 6)), 120_000)


class Writing(unittest.TestCase):
    def setUp(self):
        self.sources = api.load_sources()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = os.path.join(self.tmp, "directory.json")

    def test_unchanged_bytes_are_not_rewritten_and_crlf_is_not_a_change(self):
        self.assertTrue(td.write_directory(self.sources, built(), path=self.path))
        Path(self.path).write_bytes(fresh().replace(b"\n", b"\r\n"))       # a CRLF checkout
        before = os.stat(self.path).st_mtime_ns
        self.assertFalse(td.write_directory(self.sources, built(), path=self.path))
        self.assertEqual(os.stat(self.path).st_mtime_ns, before)
        self.assertFalse(td.check_directory(self.sources, built(), path=self.path))

    def test_a_failed_write_leaves_the_old_file_and_no_tmp(self):
        Path(self.path).write_bytes(b"old")
        with patch.object(td.os, "replace", side_effect=OSError("disk fixture fault")):
            with self.assertRaises(OSError):
                td.write_directory(self.sources, built(), path=self.path)
        self.assertEqual(Path(self.path).read_bytes(), b"old")
        self.assertEqual(os.listdir(self.tmp), ["directory.json"])

    def test_dry_run_writes_nothing(self):
        self.assertTrue(td.write_directory(self.sources, built(), dry_run=True, path=self.path))
        self.assertFalse(os.path.exists(self.path))

    def test_no_squads_is_an_error_not_an_empty_directory(self):
        with self.assertRaises(ValueError):
            td.write_directory(self.sources, [], path=self.path)

    def test_clubs_updates_only_the_places_and_equals_a_fresh_build(self):
        Path(self.path).write_bytes(fresh())
        places = json.loads(json.dumps(api.read_json_file(api.CLUBS_PATH)["clubs"]))
        cid = next(c[0] for c in json.loads(fresh())["clubs"] if c[3])
        places[str(cid)] = {"city": "Fixture City", "state": "CA"}
        places[str(td.NO_CLUB)] = {"city": "El Paso", "state": "TX"}     # SC2: club 7 never gets one
        self.assertTrue(td.refresh_places(places, path=self.path))
        self.assertEqual(Path(self.path).read_bytes(), td.file_bytes(self.sources, built(), places))
        doc = json.loads(Path(self.path).read_bytes())
        self.assertTrue(all(c[3] == "" for c in doc["clubs"] if c[0] == td.NO_CLUB))
        self.assertTrue(all(c[3] == "" for c in td.build(self.sources, built(), places)["clubs"] if c[0] == td.NO_CLUB))
        self.assertFalse(td.refresh_places(places, path=self.path), "a second run changes nothing")
        missing = os.path.join(self.tmp, "none.json")
        self.assertFalse(td.refresh_places(places, path=missing))
        self.assertFalse(os.path.exists(missing))


class Pipeline(unittest.TestCase):
    """archive.py builds the directory last, from the same history build (#114 M3)."""

    ACTIVE = api.load_sources()["refresh"]["activeSeason"]

    def setUp(self):
        self.sources = api.load_sources()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        seed(self.tmp)
        self.state = os.path.join(self.tmp, "refresh-state.json")
        self.clubs = os.path.join(self.tmp, "clubs.json")
        self.directory = os.path.join(self.tmp, "directory.json")
        self.index = os.path.join(self.tmp, f"{self.ACTIVE}.json")
        shutil.copy(api.team_index_path(self.ACTIVE), self.index)

    def paths(self):
        index_path = api.team_index_path
        return [
            patch.object(api, "ARCHIVE_DIR", self.tmp),
            patch.object(api, "REFRESH_STATE_PATH", self.state),
            patch.object(api, "CLUBS_PATH", self.clubs),
            patch.object(api, "MATCH_DAYS_PATH", os.path.join(self.tmp, "match-days.json")),
            patch.object(api, "team_index_path", side_effect=lambda s: self.index if s == self.ACTIVE else index_path(s)),
            patch.object(th, "HISTORY_DIR", os.path.join(self.tmp, "history")),
        ]

    def refresh(self, more=()):
        """cmd_refresh on a sweep, every upstream answer read back from the archive and every
        write kept in memory or under the temporary directory (as tests/test_team_history.py)."""
        overlay = {}
        read = api.read_archive

        def reader(path):
            return (overlay[path], "2026-09-30T00:00:00Z") if path in overlay else read(path)

        def writer(path, raw, allow_protected=False):
            overlay[path] = raw

        def answer(path):
            raw = read(path)[0]
            if raw is None:
                raise api.ApiError(f"not archived: {path}")
            return raw
        patches = self.paths() + [
            patch.object(api, "read_archive", side_effect=reader),
            patch.object(api, "write_archive", side_effect=writer),
            patch.object(api, "fetch_api_raw", side_effect=answer),
            patch.object(archive, "DELAY", 0),
            patch.object(archive, "export_flight_csv"),
        ] + [patch.object(*p) for p in more]
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            args = argparse.Namespace(date="2026-10-01", at_hour=7, sweep=True, dry_run=False, force=True)
            code = archive.cmd_refresh(self.sources, args)
        return code, out.getvalue()

    def test_the_refresh_builds_it_last_after_the_club_places(self):
        cid = next(c[0] for c in json.loads(fresh())["clubs"] if c[3])
        calls = []

        def club_step(season, today, stats):    # the sweep's club step changes one place
            calls.append("clubs")
            places = load(self.clubs)
            places["clubs"][str(cid)] = {"city": "Fixture City", "state": "CA"}
            Path(self.clubs).write_text(json.dumps(places), encoding="utf-8")
        real = td.write_directory

        def write(*a, **k):
            calls.append("directory")
            return real(*a, **k)
        with patch.object(th, "build", wraps=th.build) as builds:
            code, out = self.refresh(more=[(archive, "refresh_club_places", club_step), (td, "write_directory", write)])
        self.assertEqual(code, 0, out)
        self.assertEqual(calls, ["clubs", "directory"], "the directory comes after the club step")
        self.assertEqual(builds.call_count, 1, "one squad build serves the histories and the directory")
        doc = load(self.directory)
        self.assertIn([cid, *next(c[1:3] for c in doc["clubs"] if c[0] == cid), "Fixture City, CA"], doc["clubs"])
        state = load(self.state)
        self.assertEqual(state["historyAsOf"], state["updatedAt"])

    def test_a_directory_failure_fails_the_run_but_keeps_the_histories_and_history_as_of(self):
        Path(self.directory).write_bytes(b"old")
        code, out = self.refresh(more=[(archive, "refresh_club_places", lambda *a: None),
                                       (td, "build", unittest.mock.Mock(side_effect=RuntimeError("directory fixture fault")))])
        self.assertEqual(code, 1)
        self.assertIn("Team directory: FAILED: directory fixture fault", out)
        self.assertEqual(Path(self.directory).read_bytes(), b"old")
        self.assertNotIn("Team history: FAILED", out)
        state = load(self.state)
        self.assertEqual(state["historyAsOf"], state["updatedAt"], "a directory failure never holds back historyAsOf (#113)")

    def test_a_history_failure_leaves_the_directory_as_it_was(self):
        Path(self.directory).write_bytes(b"old")
        code, out = self.refresh(more=[(archive, "refresh_club_places", lambda *a: None),
                                       (th, "national_and_showcases", unittest.mock.Mock(side_effect=RuntimeError("history fixture fault")))])
        self.assertEqual(code, 1)
        self.assertIn("Team directory: not rebuilt", out)
        self.assertEqual(Path(self.directory).read_bytes(), b"old")

    def test_dry_runs_write_nothing(self):
        with contextlib.ExitStack() as stack:
            for p in self.paths():
                stack.enter_context(p)
            stack.enter_context(patch.object(archive, "fetch_json", side_effect=AssertionError("dry run fetched")))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            args = argparse.Namespace(date="2026-08-20", at_hour=0, sweep=False, dry_run=True, force=True)
            self.assertEqual(archive.cmd_refresh(self.sources, args), 0)
            self.assertEqual(archive.cmd_team_history(self.sources, dry_run=True), 0)
        self.assertFalse(os.path.exists(self.directory))

    def test_the_drift_check_covers_the_directory(self):
        with contextlib.ExitStack() as stack:
            for p in self.paths():
                stack.enter_context(p)
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            Path(self.directory).write_bytes(fresh())
            self.assertEqual(archive.cmd_team_history(self.sources, check=True), 0, out.getvalue())
            Path(self.directory).write_bytes(fresh().replace(b'"schema":1', b'"schema":1 ', 1))
            self.assertEqual(archive.cmd_team_history(self.sources, check=True), 1)
            self.assertIn("Team directory check: public/archive/directory.json differs", out.getvalue())

    # ---- SC1 (#118 review): each path that writes the directory, run in the sandbox ----
    def test_clubs_updates_the_directory_places_in_place(self):
        Path(self.directory).write_bytes(fresh())
        cid = next(c[0] for c in json.loads(fresh())["clubs"] if c[3])

        def fetched(todo, stats, why):            # the club step, with no network: one place changes
            places = load(self.clubs)
            places["clubs"][str(cid)] = {"city": "Fixture City", "state": "CA"}
            Path(self.clubs).write_text(json.dumps(places), encoding="utf-8")
        with contextlib.ExitStack() as stack:
            for p in self.paths() + [patch.object(archive, "update_club_places", side_effect=fetched)]:
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(archive.cmd_clubs(self.sources, None, force=True), 0)
        new = load(self.clubs)["clubs"]
        self.assertEqual(Path(self.directory).read_bytes(), td.file_bytes(self.sources, built(), new))
        self.assertIn("Fixture City, CA", Path(self.directory).read_text(encoding="utf-8"))

    def test_team_history_writes_the_directory(self):
        with contextlib.ExitStack() as stack:
            for p in self.paths():
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(archive.cmd_team_history(self.sources), 0)
        self.assertEqual(Path(self.directory).read_bytes(), fresh())

    def test_a_refresh_with_nothing_due_builds_the_history_then_the_directory(self):
        calls = []
        history, directory = archive.update_team_history, td.write_directory

        def h(*a, **k):
            calls.append("history")
            return history(*a, **k)

        def w(*a, **k):
            calls.append("directory")
            return directory(*a, **k)
        with contextlib.ExitStack() as stack:
            for p in self.paths() + [patch.object(archive, "update_team_history", side_effect=h),
                                     patch.object(td, "write_directory", side_effect=w),
                                     patch.object(archive, "fetch_json", side_effect=AssertionError("nothing due fetched"))]:
                stack.enter_context(p)
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            args = argparse.Namespace(date="2026-08-20", at_hour=0, sweep=False, dry_run=False, force=True)
            self.assertEqual(archive.cmd_refresh(self.sources, args), 0, out.getvalue())
        self.assertIn("nothing due", out.getvalue())
        self.assertEqual(calls, ["history", "directory"])
        self.assertEqual(Path(self.directory).read_bytes(), fresh())

    def test_every_history_build_in_archive_py_is_followed_by_the_directory(self):
        """The crawl tail is not run here (it needs upstream), so this checks the source: in every
        function that rebuilds the histories, the directory is rebuilt after it."""
        src = Path(archive.__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
        funcs = [f for f in src.split("\ndef ")[1:]
                 if "update_team_history(sources" in f and not f.startswith("update_team_history(")]
        self.assertGreaterEqual(len(funcs), 3, "cmd_team_history, cmd_refresh and the crawl")
        for f in funcs:
            name = f.split("(", 1)[0]
            self.assertGreater(f.rfind("update_team_directory("), f.rfind("update_team_history(sources"), name)


if __name__ == "__main__":
    unittest.main()
