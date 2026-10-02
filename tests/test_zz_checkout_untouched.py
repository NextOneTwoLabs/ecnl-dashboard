"""No test writes into the checkout's derived data (#107 review).

`python -m unittest discover` imports every test module before it runs any test, and runs
the modules in name order, so this module's snapshot is taken before the suite and its test
runs last. A test that runs a real refresh or crawl must stub archive.update_team_history
(and the index step) or point the archive at a temporary directory.
"""
import hashlib
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ecnl_api as api

WATCHED = [os.path.join(api.ARCHIVE_DIR, "history"), os.path.join(api.ARCHIVE_DIR, "teams"),
           api.REFRESH_STATE_PATH, api.CLUBS_PATH, os.path.join(api.ARCHIVE_DIR, "directory.json"),
           api.SOURCES_PATH]   # #135 P1a: the refresh now writes the catalog's teamCount


def snapshot():
    out = {}
    for top in WATCHED:
        paths = [top] if os.path.isfile(top) else (
            [os.path.join(top, n) for n in sorted(os.listdir(top))] if os.path.isdir(top) else [])
        for p in paths:
            with open(p, "rb") as f:
                out[os.path.relpath(p, api.PUBLIC_DIR)] = hashlib.sha256(f.read()).hexdigest()
    return out


BEFORE = snapshot()


class CheckoutUntouched(unittest.TestCase):
    def test_the_suite_left_the_derived_data_as_it_found_it(self):
        after = snapshot()
        changed = sorted(k for k in set(BEFORE) | set(after) if BEFORE.get(k) != after.get(k))
        self.assertEqual(changed[:20], [], f"{len(changed)} files under public/ changed during the test run")


if __name__ == "__main__":
    unittest.main()
