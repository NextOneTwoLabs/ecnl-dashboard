"""The suite-wide network guard (#87): tests/netguard/sitecustomize.py.

During #87's planning an unmocked club step made about 242 real requests to TGS
while the suite still reported OK, because the refresh swallows every exception.
These tests prove the guard turns such a call into a failed run: each spawns a
child Python with the guard, deliberately calls ecnl_api.fetch_api_raw unmocked,
swallows the error the way the refresh does, and expects the process to fail at
exit. The children point ECNL_API_BASE at a `.invalid` host, so even a broken
guard could not reach TGS.
"""
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "tests" / "netguard"
DEAD_PROXY = "http://127.0.0.1:9"
PROXY_KEYS = {"https_proxy", "http_proxy", "all_proxy", "no_proxy"}


def run_child(code, proxy):
    env = {k: v for k, v in os.environ.items() if k.lower() not in PROXY_KEYS and k != "NETGUARD_REPORT"}
    env.update(PYTHONPATH=str(GUARD), ECNL_API_BASE="https://netguard-proof.invalid", PYTHONIOENCODING="utf-8")
    if proxy:
        env.update(HTTPS_PROXY=DEAD_PROXY, HTTP_PROXY=DEAD_PROXY)
    return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=60)


UNMOCKED_FETCH = """
import ecnl_api as api
try:
    api.fetch_api_raw("Event/get-event-details-by-eventID/1", timeout=2, retries=1)
except Exception as e:
    print("swallowed:", type(e).__name__)
"""

UNMOCKED_CLUB_STEP = """
import os, tempfile
import archive, ecnl_api as api
api.CLUBS_PATH = os.path.join(tempfile.mkdtemp(), "clubs.json")
archive.CLUB_DELAY, archive.CLUB_RETRIES = 0, 1
print("completed:", archive.update_club_places(["1425"], archive.Stats(), "proof"))
"""


class NetGuardTests(unittest.TestCase):
    def test_guard_is_loaded_in_ci(self):
        loaded = getattr(sys.modules.get("sitecustomize"), "NETGUARD_ACTIVE", False)
        if os.environ.get("GITHUB_ACTIONS") and not loaded:
            self.fail("CI must run the suite with PYTHONPATH=tests/netguard")
        if not loaded:
            self.skipTest("guard not on PYTHONPATH in this run")

    def test_unmocked_fetch_fails_the_run(self):
        for proxy in (True, False):
            with self.subTest(dead_proxy=proxy):
                r = run_child(UNMOCKED_FETCH, proxy)
                self.assertIn("swallowed:", r.stdout)          # the caller never saw a failure
                self.assertEqual(r.returncode, 97, r.stderr)   # but the run fails at exit
                self.assertIn("network attempt(s) refused", r.stderr)
                self.assertIn("127.0.0.1:9" if proxy else "netguard-proof.invalid", r.stderr)

    def test_unmocked_club_step_fails_the_run(self):
        r = run_child(UNMOCKED_CLUB_STEP, proxy=True)
        self.assertIn("completed: True", r.stdout)   # one failed club: the step itself is fine
        self.assertEqual(r.returncode, 97, r.stderr)

    def test_no_network_exits_cleanly(self):
        r = run_child("import archive, ecnl_api, proxy_server; print('ok')", proxy=True)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ok"), r.stderr)
        self.assertNotIn("netguard", r.stderr)


if __name__ == "__main__":
    unittest.main()
