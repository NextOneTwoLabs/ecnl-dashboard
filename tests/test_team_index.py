"""The per-season team index (#81): public/archive/teams/<season>.json.

(a) Every committed index equals a fresh build from the committed archive.
(b) An independent simulation of the page's scans (resolveFavorite and
    searchAllConferences in public/index.html) over the archive agrees with the
    index-based lookups, for every team id and name, from every starting season.
(c) The refresh can never be stopped from writing refresh-state.json by the index
    build, and a dry run never writes an index.

The page's JS merge of multi-block standings is checked against the index ranks in
tests/data-api.test.mjs, so it runs in CI next to the route tests.
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

FIX = "run `python archive.py --team-index --all`, then commit public/archive/teams/"


def read_json(api_path):
    raw, _ = api.read_archive(api_path)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


class TeamIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()
        cls.seasons = list(cls.sources["seasons"])
        cls.index = {s: (api.read_json_file(api.team_index_path(s)) or {}).get("teams") for s in cls.seasons}
        # The scan's inputs, read the way the page reads them: per season, per registry
        # conference, the hierarchy's divisions and each flight's merged standings.
        cls.scan = {}
        for s in cls.seasons:
            confs = []
            for conf, ev in (cls.sources["seasons"][s].get("conferences") or {}).items():
                h = read_json(api.p_hierarchy(ev["eventId"]))
                h = (h or {}).get("data") or h or {}
                divs = h.get("girlsDivAndFlightList") or []
                pairs = []
                for d in divs:
                    for f in d.get("flightList") or []:
                        st = read_json(api.p_standings(d["divisionID"], f["flightID"], ev["eventId"]))
                        teams = archive.merge_standings_blocks((st or {}).get("data")) if st else []
                        pairs.append((d, f, teams))
                confs.append((conf, ev["eventId"], divs, pairs))
            cls.scan[s] = confs

    # ---------- (a) committed index is current ----------

    def test_committed_index_matches_archive(self):
        for s in self.seasons:
            with self.subTest(season=s):
                built = archive.build_team_index(self.sources, s)
                committed = api.read_json_file(api.team_index_path(s))
                if not built["teams"]:
                    self.assertIsNone(committed, f"{s}: index present but nothing archived; {FIX}")
                    continue
                self.assertIsNotNone(committed, f"{s}: no team index; {FIX}")
                self.assertEqual(committed.get("schema"), archive.TEAM_INDEX_SCHEMA, f"{s}: {FIX}")
                if committed != built:
                    stale = sum(a != b for a, b in zip(committed.get("teams") or [], built["teams"]))
                    self.fail(f"{s}: team index is stale ({stale} rows differ, "
                              f"{len(committed.get('teams') or [])} vs {len(built['teams'])} rows); {FIX}")

    def test_index_rows_are_complete(self):
        keys = archive.TEAM_INDEX_KEYS + ["conference", "flightName", "rank"] + archive.TEAM_INDEX_STATS
        for s in self.seasons:
            for t in self.index[s] or []:
                self.assertEqual(sorted(t), sorted(keys), s)

    def test_duplicate_division_names_fail_the_build(self):
        s = self.seasons[0]
        conf, ev = next(iter(self.sources["seasons"][s]["conferences"].items()))
        hierarchy = {"data": {"girlsDivAndFlightList": [
            {"divisionID": 1, "divisionName": "GU13", "flightList": []},
            {"divisionID": 2, "divisionName": "GU13", "flightList": []},
        ]}}
        real = api.read_archive

        def fake(path):
            if path == api.p_hierarchy(ev["eventId"]):
                return json.dumps(hierarchy).encode(), None
            return real(path)
        with patch.object(api, "read_archive", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "GU13"):
                archive.build_team_index(self.sources, s)

    # ---------- (b) index lookups equal the page's scan ----------

    @staticmethod
    def adopt(t, eid, did, dname, fid):
        return {"name": t["name"], "teamID": t["teamID"], "clubID": t["clubID"], "clubName": t["clubName"],
                "eventID": eid, "divisionID": did, "divisionName": dname, "flightID": fid,
                "logo": t.get("clublogo")}

    def first_hits(self, key):
        """Per season: key -> the record resolveFavorite adopts, for the scan and the index."""
        scan, index = {}, {}
        for s in self.seasons:
            # hits.find(Boolean) takes the first conference with a hit, found.find(Boolean)
            # the first (division, flight) in it, teams.find the first row in that table.
            scan[s] = {}
            for conf, eid, _divs, pairs in self.scan[s]:
                seen = {}
                for d, f, teams in pairs:
                    for t in teams:
                        seen.setdefault(key(t), self.adopt(t, eid, d["divisionID"], d["divisionName"], f["flightID"]))
                for k, rec in seen.items():
                    scan[s].setdefault(k, rec)
            index[s] = {}
            for t in self.index[s] or []:
                index[s].setdefault(key(t), self.adopt(t, t["eventID"], t["divisionID"], t["division"], t["flightID"]))
        return scan, index

    def resolve(self, hits, k, start):
        for s in [start] + [x for x in self.seasons if x != start]:
            if k in hits[s]:
                return s, hits[s][k]
        return None

    def national_teams(self):
        ids, names = set(), set()
        for s in self.seasons:
            for ev in (self.sources["seasons"][s].get("national") or {}).values():
                h = read_json(api.p_hierarchy(ev["eventId"]))
                h = (h or {}).get("data") or h or {}
                for d in h.get("girlsDivAndFlightList") or []:
                    for f in d.get("flightList") or []:
                        games = (read_json(api.p_schedule(ev["eventId"], f["flightID"])) or {}).get("data") or []
                        for g in games:
                            ids.update(x for x in (g.get("hometeamID"), g.get("awayteamID")) if x)
                            names.update(x for x in (g.get("homeTeam"), g.get("awayTeam")) if x)
        return ids, names

    def test_lookup_equals_scan(self):
        for s in self.seasons:
            self.assertIsNotNone(self.index[s], f"{s}: no team index; {FIX}")
        nat_ids, nat_names = self.national_teams()
        ids = {t["teamID"] for s in self.seasons for t in self.index[s]} | nat_ids | {999999999}
        names = {t["name"] for s in self.seasons for t in self.index[s]} | nat_names | {"No Such Team"}
        self.assertGreater(len(nat_ids - {t["teamID"] for s in self.seasons for t in self.index[s]}), 0,
                           "expected some ids that appear only in national schedules")
        checked = mismatches = 0
        for kind, keys, key in (("id", ids, lambda t: t["teamID"]), ("name", names, lambda t: t["name"])):
            scan, index = self.first_hits(key)
            for start in self.seasons:
                for k in keys:
                    checked += 1
                    if self.resolve(scan, k, start) != self.resolve(index, k, start):
                        mismatches += 1
                        if mismatches <= 5:
                            print(f"lookup mismatch: {kind} {k!r} from {start}")
        self.assertEqual(mismatches, 0, f"{mismatches} of {checked} lookups differ from the scan; {FIX}")
        print(f"Team index lookups: {checked} checked, 0 mismatches")

    def test_search_equals_scan(self):
        def row(ag, conf, flight_name, t, rank):
            return (ag, conf, flight_name, rank) + tuple(t.get(k) for k in archive.TEAM_INDEX_KEYS + archive.TEAM_INDEX_STATS)

        def arrange(by, groups):   # addRow: one body per age group, stable-sorted by conference
            return [r for ag in groups for r in sorted(by.get(ag, []), key=lambda r: r[1])]

        def scan_search(s, q, groups):
            by = {}
            for conf, _eid, divs, pairs in self.scan[s]:
                for ag in groups:
                    d = next((x for x in divs if x.get("divisionName") == ag), None)  # divList.find
                    for dd, f, teams in pairs:
                        if dd is not d:
                            continue
                        for i, t in enumerate(teams, 1):
                            if q in f"{t.get('name') or ''} {t.get('clubName') or ''}".lower():
                                by.setdefault(ag, []).append(row(ag, conf, f.get("flightName"), t, i))
            return arrange(by, groups)

        def index_search(s, q, groups):
            by, first = {}, {}
            for t in self.index[s]:
                k = (t["conference"], t["division"])
                first.setdefault(k, t["divisionID"])
                if first[k] != t["divisionID"] or t["division"] not in groups:
                    continue
                if q in f"{t['name'] or ''} {t['clubName'] or ''}".lower():
                    by.setdefault(t["division"], []).append(row(t["division"], t["conference"], t["flightName"], t, t["rank"]))
            return arrange(by, groups)

        queries = {"ecnl", "solar", "slammers", "fc", "g08", "2013/14", "rl", "zz-no-match"}
        for s in self.seasons:
            queries |= {(t["clubName"] or "").lower() for t in self.index[s] or []}
        checked = rows = 0
        for s in self.seasons:
            groups = list(self.sources["seasons"][s].get("ageGroups") or [])
            for q in sorted(x for x in queries if len(x) >= 2):
                a = scan_search(s, q, groups)
                self.assertEqual(a, index_search(s, q, groups), f"{s} search {q!r}; {FIX}")
                checked += 1
                rows += len(a)
        print(f"Team index searches: {checked} checked, {rows} result rows, 0 mismatches")

    # ---------- (c) the refresh path ----------

    @staticmethod
    def refresh_args(date, hour, **kw):
        return argparse.Namespace(**dict(dict(date=date, at_hour=hour, sweep=False, dry_run=False, force=True), **kw))

    def test_index_failure_cannot_stop_the_state_write(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(api, "REFRESH_STATE_PATH", os.path.join(tmp, "refresh-state.json")), \
                patch.object(api, "MATCH_DAYS_PATH", os.path.join(tmp, "match-days.json")), \
                patch.object(archive, "fetch_json", side_effect=api.ApiError("offline fixture")), \
                patch.object(archive, "export_flight_csv", side_effect=AssertionError("nothing was fetched")), \
                patch.object(archive, "build_team_index", side_effect=RuntimeError("index fixture fault")), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = archive.cmd_refresh(self.sources, self.refresh_args("2026-09-26", 7, sweep=True))
            with open(api.REFRESH_STATE_PATH, encoding="utf-8") as f:
                state = json.load(f)
        self.assertEqual(code, 1)
        self.assertEqual(state["lastSweepDate"], "2026-09-26")
        self.assertTrue(state["sweep"])
        self.assertIn("Team index", out.getvalue())
        self.assertIn("index fixture fault", out.getvalue())

    def test_nothing_due_failure_is_reported_not_raised(self):
        with patch.object(archive, "fetch_json", side_effect=AssertionError("no network on a quiet day")), \
                patch.object(archive, "build_team_index", side_effect=RuntimeError("index fixture fault")), \
                patch.object(archive, "write_team_index", wraps=archive.write_team_index) as writer, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = archive.cmd_refresh(self.sources, self.refresh_args("2026-08-20", 0))
        self.assertIn("nothing due", out.getvalue())
        self.assertEqual(writer.call_count, 1)
        self.assertEqual(code, 1)

    def test_dry_runs_never_write_the_index(self):
        for date, hour in (("2026-08-20", 0), ("2026-09-26", 7)):
            with self.subTest(date=date), \
                    patch.object(archive, "fetch_json", side_effect=AssertionError("dry run fetched")), \
                    patch.object(archive, "write_team_index", side_effect=AssertionError("dry run wrote the index")), \
                    patch.object(api, "write_json_file", side_effect=AssertionError("dry run wrote a file")), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(archive.cmd_refresh(self.sources, self.refresh_args(date, hour, dry_run=True)), 0)


if __name__ == "__main__":
    unittest.main()
