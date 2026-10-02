"""The catalog's team count (#135 P1a): seasons.<season>.teamCount in public/data/sources.json.

(a) The committed catalog's teamCount equals the distinct teamIDs of each season's committed team
    index (CI's drift check, from the data); a season with no index has none.
(b) The writer changes only the "teamCount" lines of the hand-formatted file, byte for byte.
(c) The count is of distinct teams (a team listed in two tables counts once).
(d) Only update_team_index syncs it (the refresh, a conference crawl, --team-index), through
    save_sources, into the registry its caller loaded; write_team_index never does; a failure is
    reported, never raised; --team-history --check fails on drift.
None of these tests writes the checkout (tests/test_zz_checkout_untouched.py watches sources.json).
"""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive
import ecnl_api as api

FIX = "run `python archive.py --team-index --all`, then commit public/data/sources.json"


def raw_catalog():
    with open(api.SOURCES_PATH, "rb") as f:
        return f.read().decode("utf-8")


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class CommittedCount(unittest.TestCase):
    def test_every_season_counts_its_index(self):
        sources = api.load_sources()
        self.assertEqual(archive.team_count_drift(sources), [], FIX)
        for season, entry in sources["seasons"].items():
            index = api.read_json_file(api.team_index_path(season))
            if index is None:
                self.assertNotIn("teamCount", entry, season)
                continue
            ids = {t["teamID"] for t in index["teams"]}
            self.assertEqual(entry["teamCount"], len(ids), season)
            self.assertGreater(entry["teamCount"], 0, season)

    def test_the_count_is_the_second_key_of_its_season(self):
        # The writer anchors on "startYear"; the page reads the field through Number.isInteger.
        text = raw_catalog().replace("\r\n", "\n")
        for season, entry in api.load_sources()["seasons"].items():
            if "teamCount" in entry:
                self.assertIn(f'\n    "{season}": {{\n      "startYear": {entry["startYear"]},\n      "teamCount": {entry["teamCount"]},\n', text)


class LineEdit(unittest.TestCase):
    def setUp(self):
        self.text = raw_catalog().replace("\r\n", "\n")
        self.seasons = list(json.loads(self.text)["seasons"])

    def strip(self, text):
        return "".join(l for l in text.splitlines(True) if not l.startswith('      "teamCount": '))

    def test_insert_replace_idempotent_and_nothing_else(self):
        bare = self.strip(self.text)
        s = self.seasons[1]
        once = archive.set_team_count_line(bare, s, 123)
        self.assertEqual(once, archive.set_team_count_line(once, s, 123), "idempotent")
        twice = archive.set_team_count_line(once, s, 124)
        self.assertEqual(self.strip(once), bare, "only that line was added")
        self.assertEqual(self.strip(twice), bare)
        self.assertEqual(json.loads(twice)["seasons"][s]["teamCount"], 124)
        expected = json.loads(bare)
        expected["seasons"][s] = {"startYear": expected["seasons"][s]["startYear"], "teamCount": 124,
                                  **{k: v for k, v in expected["seasons"][s].items() if k != "startYear"}}
        self.assertEqual(json.loads(twice), expected)
        self.assertEqual(list(json.loads(twice)["seasons"][s])[:2], ["startYear", "teamCount"])

    def test_a_season_the_file_does_not_have_raises(self):
        with self.assertRaises(ValueError):
            archive.set_team_count_line(self.text, "2099-00", 1)

    def test_save_sources_with_counts_keeps_every_other_byte_and_the_line_endings(self):
        with tempfile.TemporaryDirectory() as d:
            for nl in ("\n", "\r\n"):
                path = os.path.join(d, f"sources{len(nl)}.json")
                bare = self.strip(self.text)
                with open(path, "wb") as f:
                    f.write(bare.replace("\n", nl).encode("utf-8"))
                with patch.object(api, "SOURCES_PATH", path):
                    archive.save_sources(None, team_counts={self.seasons[0]: 7, self.seasons[-1]: 8})
                with open(path, "rb") as f:
                    out = f.read().decode("utf-8")
                self.assertEqual(out.count("\r\n"), out.count("\n") if nl == "\r\n" else 0)
                self.assertEqual(self.strip(out.replace("\r\n", "\n")), bare)
                got = json.loads(out)["seasons"]
                self.assertEqual((got[self.seasons[0]]["teamCount"], got[self.seasons[-1]]["teamCount"]), (7, 8))


class Sync(unittest.TestCase):
    """sync_team_counts / update_team_index on a temporary index and a fixture registry."""
    SEASON = "2099-00"   # not in the real catalog: the writer must never reach the real file

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.index = os.path.join(self.tmp, f"{self.SEASON}.json")
        self.sources = {"seasons": {self.SEASON: {"startYear": 2099, "conferences": {}}}}
        self.real = sha(api.SOURCES_PATH)
        self.addCleanup(lambda: self.assertEqual(sha(api.SOURCES_PATH), self.real, "the checkout's sources.json was written"))

    def write_index(self, ids):
        with open(self.index, "w", encoding="utf-8") as f:
            json.dump({"schema": 1, "season": self.SEASON, "teams": [{"teamID": i} for i in ids]}, f)

    def paths(self):
        real = api.team_index_path
        return patch.object(api, "team_index_path", side_effect=lambda s: self.index if s == self.SEASON else real(s))

    def test_distinct_teams_and_one_write_through_save_sources(self):
        self.write_index([1, 2, 2, 3])   # team 2 is listed in two tables (2025-26 has two such teams)
        stats = archive.Stats()
        with self.paths(), patch.object(archive, "save_sources") as save, contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(archive.sync_team_counts(self.sources, [self.SEASON], stats))
            save.assert_called_once_with(self.sources, team_counts={self.SEASON: 3})
            self.assertEqual(self.sources["seasons"][self.SEASON]["teamCount"], 3)
            # In line: nothing to write.
            self.assertFalse(archive.sync_team_counts(self.sources, [self.SEASON], stats))
            save.assert_called_once()
        self.assertEqual(stats.failed, 0)

    def test_no_index_no_count(self):
        stats = archive.Stats()
        with self.paths(), patch.object(archive, "save_sources") as save:
            self.assertFalse(archive.sync_team_counts(self.sources, [self.SEASON], stats))
        save.assert_not_called()
        self.assertNotIn("teamCount", self.sources["seasons"][self.SEASON])

    def test_a_failure_is_reported_not_raised(self):
        self.write_index([1])
        stats = archive.Stats()
        with self.paths(), patch.object(archive, "save_sources", side_effect=OSError("disk full")), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(archive.sync_team_counts(self.sources, [self.SEASON], stats))
        self.assertEqual(stats.failed, 1)
        self.assertIn("--team-index --all", stats.errors[0])
        self.assertNotIn("teamCount", self.sources["seasons"][self.SEASON])

    def test_unpatched_the_writer_refuses_a_registry_the_file_does_not_hold(self):
        # A fixture registry run through the real writer: the real file has no such season, so the
        # write fails (reported), and the real file is untouched (checked in tearDown).
        self.write_index([1, 2])
        stats = archive.Stats()
        with self.paths(), contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(archive.sync_team_counts(self.sources, [self.SEASON], stats))
        self.assertEqual(stats.failed, 1)

    def test_only_update_team_index_syncs_and_count_false_does_not(self):
        built = {"schema": 1, "season": self.SEASON, "teams": [{"teamID": 5}, {"teamID": 6}]}
        with self.paths(), patch.object(archive, "build_team_index", return_value=built), \
                patch.object(archive, "save_sources") as save, contextlib.redirect_stdout(io.StringIO()):
            archive.write_team_index(self.sources, self.SEASON)          # never syncs
            save.assert_not_called()
            stats = archive.Stats()
            archive.update_team_index(self.sources, self.SEASON, stats, count=False)
            save.assert_not_called()
            self.assertEqual(stats.failed, 0)
            self.assertNotIn("teamCount", self.sources["seasons"][self.SEASON])
        with self.paths(), patch.object(archive, "build_team_index", return_value=built), \
                patch.object(archive, "save_sources") as save, contextlib.redirect_stdout(io.StringIO()):
            stats = archive.Stats()
            archive.update_team_index(self.sources, self.SEASON, stats)
            save.assert_called_once_with(self.sources, team_counts={self.SEASON: 2})

    def test_team_index_command_syncs_the_registry_it_was_given(self):
        self.write_index([9, 8, 8])
        with self.paths(), patch.object(archive, "write_team_index", return_value=(False, 3)), \
                patch.object(archive, "save_sources") as save, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(archive.cmd_team_index(self.sources, self.SEASON), 0)
        save.assert_called_once_with(self.sources, team_counts={self.SEASON: 2})

    def test_crawls_pass_count_false_for_showcases_and_no_update_sources(self):
        src = Path(archive.__file__).read_text(encoding="utf-8")
        self.assertIn("update_team_index(sources, s, stats, count=not args.no_update_sources)", src)
        self.assertIn("update_team_index(sources, s, stats, count=False)", src)


class DriftCheck(unittest.TestCase):
    def test_the_check_fails_on_a_count_that_is_not_its_index(self):
        sources = copy.deepcopy(api.load_sources())
        season = next(iter(sources["seasons"]))
        sources["seasons"][season]["teamCount"] = sources["seasons"][season].get("teamCount", 0) + 1

        def history(_sources, keep=None, **_kw):
            keep["squads"] = []
            return [], []
        out = io.StringIO()
        with patch("team_history.check_history", side_effect=history), \
                patch("team_directory.check_directory", return_value=False), contextlib.redirect_stdout(out):
            self.assertEqual(archive.cmd_team_history(sources, check=True), 1)
        self.assertIn(f"Team count check: {season} has", out.getvalue())
        self.assertIn("python archive.py --team-index --all", out.getvalue())
        out = io.StringIO()
        with patch("team_history.check_history", side_effect=history), \
                patch("team_directory.check_directory", return_value=False), contextlib.redirect_stdout(out):
            self.assertEqual(archive.cmd_team_history(api.load_sources(), check=True), 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
