"""#203: tools/variants/ (the data variants the refresh-proof bar is run on): what it refuses, and the shape of what its simulations do.

The tool never edits a checkout: it refuses the repo root, any path inside it, and a directory above it, and it writes only to the directory it is
given. These tests run it on a tiny synthetic tree in a temp directory (not the archive), offline, with the Node ones under the network guard."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools/variants"
GUARD = str(ROOT / "tests/netguard/netguard.mjs")


def run(*cmd, **kw):
    return subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)


def sim(tree, variant, *extra):
    return run("node", "--import", GUARD, TOOL / "sim_games.mjs", tree, variant, *extra)


def write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def team(i, name, gp=0):
    return {"teamID": i, "name": name, "eventID": 1, "divisionID": 10, "flightID": 20, "gp": gp, "wins": 0, "totalgames": gp}


def game(m, home, away, day, score=None):
    return {"matchID": m, "gameDate": f"2026-11-{day:02d}T10:00:00", "gameDate1": f"2026-11-{day:02d}T00:00:00", "hometeamID": home, "awayteamID": away,
            "hometeamscore": score[0] if score else None, "awayteamscore": score[1] if score else None}


def tree(root):
    """Ten teams in one flight; four scored games, six unplayed (two of them a same-date same-pair pair), each team with a name."""
    teams = [team(i, f"Team {i} ECNL G11", gp=1 if i in (1, 2) else 0) for i in range(1, 11)] + [team(55477, "MVLA ECNL G2010/11")]
    write(root / "public/data/sources.json", {"refresh": {"activeSeason": "2026-27"}, "seasons": {"2026-27": {"conferences": {"A": {"eventId": 1}}}}})
    write(root / "public/archive/teams/2026-27.json", {"schema": 1, "season": "2026-27", "teams": teams})
    write(root / "public/archive/api/Event/get-standings-by-div-and-flight/10/20/1.json", {"data": [{"teamStandings": [dict(t) for t in teams]}]})
    games = [game(1, 1, 2, 1, (1, 0)), game(2, 3, 4, 1), game(3, 5, 6, 2), game(4, 3, 4, 8), game(5, 3, 4, 8), game(6, 55477, 7, 9), game(7, 8, 9, 10), game(8, 1, 10, 11)]
    write(root / "public/archive/api/Event/get-schedules-by-flight/1/20/0.json", {"data": games})
    return root


def read(root, rel):
    return json.loads((root / rel).read_text(encoding="utf-8"))


SCHEDULE = "public/archive/api/Event/get-schedules-by-flight/1/20/0.json"
STANDINGS = "public/archive/api/Event/get-standings-by-div-and-flight/10/20/1.json"
INDEX = "public/archive/teams/2026-27.json"


class Refusals(unittest.TestCase):
    def test_the_builder_refuses_this_checkout_and_the_paths_around_it(self):
        for target in (ROOT, ROOT / "scratch-variant", ROOT / "tools", ROOT.parent):
            before = sorted(p.name for p in ROOT.iterdir())
            r = run(sys.executable, TOOL / "variants.py", "build", "base", target)
            self.assertNotEqual(r.returncode, 0, target)
            self.assertIn("refusing", r.stderr, target)
            self.assertFalse((ROOT / "scratch-variant").exists())
            self.assertEqual(sorted(p.name for p in ROOT.iterdir()), before, "the checkout is untouched")

    def test_the_builder_refuses_a_directory_that_is_not_empty(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "keep.txt").write_text("x", encoding="utf-8")
            r = run(sys.executable, TOOL / "variants.py", "build", "base", d)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("not empty", r.stderr)
            self.assertEqual([p.name for p in Path(d).iterdir()], ["keep.txt"])

    def test_the_builder_refuses_an_unknown_variant(self):
        with tempfile.TemporaryDirectory() as d:
            r = run(sys.executable, TOOL / "variants.py", "build", "nonsense", Path(d) / "out")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("unknown variant", r.stderr)

    def test_the_runner_writes_no_log_inside_the_checkout(self):
        with tempfile.TemporaryDirectory() as d:
            r = run(sys.executable, TOOL / "variants.py", "run", d, ROOT / "variant.log", "py")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("refusing", r.stderr)
            self.assertFalse((ROOT / "variant.log").exists())

    def test_the_simulations_refuse_this_checkout(self):
        r = sim(ROOT, "refresh")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refusing", r.stderr)
        r = run(sys.executable, TOOL / "sim_rollover.py", ROOT)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refusing", r.stderr)

    def test_the_simulations_refuse_a_directory_that_is_not_a_copy(self):
        with tempfile.TemporaryDirectory() as d:
            r = sim(d, "refresh")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("not a copy of the checkout", r.stderr)


class Shapes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = tree(Path(self.tmp))

    def unplayed(self):
        return [g for g in read(self.root, SCHEDULE)["data"] if g["hometeamscore"] is None]

    def test_refresh_scores_half_of_the_unplayed_games_and_season_end_all(self):
        before = len(self.unplayed())
        self.assertEqual(before, 7)
        r = sim(self.root, "refresh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.unplayed()), before - before // 2)
        r = sim(self.root, "season-end")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.unplayed(), [])
        gp = {t["teamID"]: t["gp"] for t in read(self.root, INDEX)["teams"]}
        self.assertTrue(all(gp[i] >= 1 for i in (1, 2, 3, 4)), gp)

    def test_remove_takes_the_team_out_of_the_index_the_standings_and_the_schedule(self):
        r = sim(self.root, "remove", "--teams", "55477")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(55477, [t["teamID"] for t in read(self.root, INDEX)["teams"]])
        self.assertNotIn(55477, [t["teamID"] for b in read(self.root, STANDINGS)["data"] for t in b["teamStandings"]])
        self.assertFalse([g for g in read(self.root, SCHEDULE)["data"] if 55477 in (g["hometeamID"], g["awayteamID"])])

    def test_withdraw_many_removes_every_25th_team(self):
        sim(self.root, "withdraw-many")
        ids = sorted(t["teamID"] for t in read(self.root, INDEX)["teams"])
        self.assertEqual(len(ids), 10)   # 11 teams, index 7 of the sorted ids (8) is gone
        self.assertNotIn(8, ids)

    def test_rename_spells_one_team_differently_in_the_schedules(self):
        r = sim(self.root, "rename", "--teams", "55477")
        self.assertEqual(r.returncode, 0, r.stderr)
        text = (self.root / SCHEDULE).read_text(encoding="utf-8")
        self.assertNotIn("MVLA", text)
        self.assertEqual({t["name"] for t in read(self.root, INDEX)["teams"] if t["teamID"] == 55477}, {"MVLA ECNL G2010/11"})

    def test_double_header_scores_the_two_games_of_one_pair_on_one_date(self):
        r = sim(self.root, "double-header")
        self.assertEqual(r.returncode, 0, r.stderr)
        scored = {g["matchID"]: (g["hometeamscore"], g["awayteamscore"]) for g in read(self.root, SCHEDULE)["data"] if g["matchID"] in (4, 5)}
        self.assertEqual(scored, {4: (2, 0), 5: (1, 0)})

    def test_late_add_adds_two_teams_with_new_ids_and_unplayed_games(self):
        r = sim(self.root, "late-add", "--teams", "1,5")
        self.assertEqual(r.returncode, 0, r.stderr)
        index = read(self.root, INDEX)["teams"]
        self.assertEqual({t["teamID"] for t in index} - set(range(1, 11)) - {55477}, {700001, 700002})
        games = [g for g in read(self.root, SCHEDULE)["data"] if 700001 in (g["hometeamID"], g["awayteamID"])]
        self.assertEqual(len(games), 2)   # team 1 has two games (one played): both come back unplayed
        self.assertTrue(all(g["hometeamscore"] is None and g["matchID"] > 3_000_000 for g in games))
        self.assertTrue(all(g["gameDate"] > "2026-11-14" for g in games))

    def test_an_unknown_variant_fails(self):
        self.assertNotEqual(sim(self.root, "nonsense").returncode, 0)


class Subset(unittest.TestCase):
    NODE_OLD = "ok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP gone\n"
    PY_OLD = "test_a (m.C.test_a) ... ok\ntest_b (m.C.test_b) ... FAIL\n"

    def logs(self, d, node_new, py_new=None):
        d = Path(d)
        (d / "v-old-node.txt").write_text(self.NODE_OLD, encoding="utf-8")
        (d / "v-new-node.txt").write_text(node_new, encoding="utf-8")
        (d / "v-old-py.txt").write_text(self.PY_OLD, encoding="utf-8")
        (d / "v-new-py.txt").write_text(py_new or "test_a (m.C.test_a) ... ok\ntest_b (m.C.test_b) ... ok\n", encoding="utf-8")

    def test_a_subset_passes_and_a_new_red_or_a_red_new_test_fails(self):
        with tempfile.TemporaryDirectory() as d:
            self.logs(d, "ok 1 - a\nok 2 - b\nok 3 - c\nok 4 - new test\n")
            r = run(sys.executable, TOOL / "subset.py", d, "v")
            self.assertEqual(r.returncode, 0, r.stdout)
            self.assertIn("SUBSET CHECK: PASS", r.stdout)
            self.logs(d, "ok 1 - a\nnot ok 2 - b\nok 3 - c\nnot ok 4 - new test\nnot ok 5 - another\n")
            r = run(sys.executable, TOOL / "subset.py", d, "v")
            self.assertEqual(r.returncode, 1)
            self.assertIn("SUBSET CHECK: FAIL", r.stdout)
            self.assertIn("NEW red/skipped not in old", r.stdout)


if __name__ == "__main__":
    unittest.main()
