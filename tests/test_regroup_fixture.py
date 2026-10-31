"""#203: tests/fixtures/regroup/rows.json (the season rows of the five clubs the regroup and override tests name) is what its MANIFEST says,
is in the format freeze.py writes, and still has the shape the builder gives rows today.

The fixture is not a mirror of the archive: it changes only by tests/fixtures/regroup/freeze.py in a reviewed PR. A stale fixture fails here,
loudly: a changed byte (sha256 over LF text), a row field the builder added or dropped (the key sets below), a regroup season that moved
(MANIFEST.regroup), an anchor that left the rows. th.build() on stale rows would also raise or return errors (the last test)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import ecnl_api as api
import team_history as th

DIR = Path(__file__).parent / "fixtures/regroup"
MANIFEST = json.loads((DIR / "MANIFEST.json").read_text(encoding="utf-8"))
TEXT = (DIR / "rows.json").read_text(encoding="utf-8")
ROWS = json.loads(TEXT)


def freezer():
    spec = importlib.util.spec_from_file_location("regroup_freeze", DIR / "freeze.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Fixture(unittest.TestCase):
    def test_the_file_is_what_the_manifest_says(self):
        self.assertEqual(hashlib.sha256(TEXT.replace("\r\n", "\n").encode("utf-8")).hexdigest(), MANIFEST["sha256"], "rows.json changed: re-run freeze.py")
        self.assertEqual(len(TEXT.replace("\r\n", "\n").encode("utf-8")), MANIFEST["bytes"])
        self.assertEqual({s: len(v) for s, v in sorted(ROWS.items())}, MANIFEST["rows"])
        self.assertLess(MANIFEST["bytes"], 200_000, "a small fixture")

    def test_the_freezer_writes_this_format(self):
        # Determinism: the freezer's own writer gives this file back, byte for byte.
        self.assertEqual(freezer().dump(ROWS), TEXT.replace("\r\n", "\n"))

    def test_the_regroup_season_and_the_anchors_are_in_it(self):
        self.assertEqual(MANIFEST["regroup"], th.REGROUP, "the regroup season moved: the fixture was frozen for another one")
        self.assertIn(th.REGROUP, ROWS)
        self.assertTrue(all(r.get("regroup") for r in ROWS[th.REGROUP]))
        have = {(s, r["teamID"]) for s, rs in ROWS.items() for r in rs}
        for a in MANIFEST["anchors"]:
            season, tid = a.split("/")
            self.assertIn((season, int(tid)), have, a)
        for n in MANIFEST["named"]:
            season, name = n.split(" ", 1)
            self.assertIn(name, [r["name"] for r in ROWS[season]], n)

    def test_the_rows_have_the_shape_the_builder_gives_today(self):
        live = th.season_rows(api.load_sources())
        live_keys = {k for rs in live.values() for r in rs for k in r} - {"last"}
        fixture_keys = {k for rs in ROWS.values() for r in rs for k in r}
        # `inProgress` is on a row only while its squad has games to play, so it comes and goes with the season (the season-end variant has none).
        optional = {"inProgress"}
        self.assertEqual(fixture_keys - optional, live_keys - optional, "the builder's row fields changed: re-run tests/fixtures/regroup/freeze.py")
        # A season the archive adds (the rollover registers the next one) leaves the fixture's rows true; one it loses does not.
        self.assertLessEqual(set(ROWS), set(live), "a season of the fixture left the archive: re-run tests/fixtures/regroup/freeze.py")

    def test_the_builder_runs_on_it_without_errors(self):
        with patch.object(th, "season_rows", return_value=copy.deepcopy(ROWS)), \
                patch.object(th, "national_and_showcases", return_value=({}, {})), \
                patch.object(th, "load_links", return_value=({}, [])):
            squads, _stats, _rows, errors = th.build()
        self.assertEqual(errors, [])
        self.assertGreater(len(squads), 0)


if __name__ == "__main__":
    unittest.main()
