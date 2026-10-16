"""tools/census_places.py (#159): the 2020 Census ZCTA files -> public/data/zip-places.json.

Run on hand-written imitations of the two files (tests/search/fixtures/census/, made-up GEOIDs
and names, never census data), so every rule is pinned without a download (plan v2 MF1, MF2):
the land-area rule and its tie-break, county from the county file, empty-ZCTA and empty-place
rows, water-only overlaps, suffixes, FIPS, BOM and strict UTF-8, the format checks, the counts,
the provenance checksums, determinism, and no clock or network.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / "tools" / "census_places.py"
FIX = HERE / "search" / "fixtures" / "census"
spec = importlib.util.spec_from_file_location("census_places", TOOL)
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)
SMALL = (1, 100)


def build(place=FIX / "zcta-place.txt", county=FIX / "zcta-county.txt", **kw):
    return cp.build(str(place), str(county), "2026-10-16", kw.pop("expect", SMALL), **kw)


class Rules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = build()

    def test_zip_to_place_by_largest_land_area_ties_to_the_lowest_geoid(self):
        self.assertEqual(self.doc["zips"]["90001"][0], "0690001", "Alpha and Beta tie on land: the lower GEOID")
        self.assertEqual(self.doc["zips"]["90005"][0], "0690004")

    def test_an_empty_place_or_a_water_only_overlap_is_never_a_city(self):
        self.assertEqual(self.doc["zips"]["90002"], [None, "06001"], "Beta only across water; the rest outside every place")
        self.assertEqual(self.doc["zips"]["01001"], [None, "25013"], "a zip outside every place keeps its county")

    def test_zip_to_county_comes_from_the_county_file_not_the_place(self):
        self.assertEqual(self.doc["zips"]["90005"][1], "06001")
        self.assertEqual(self.doc["places"]["0690004"][2], "06005", "Delta's own county is where most of it lies")
        self.assertEqual(self.doc["zips"]["90007"][1], "06003", "a county tie goes to the lower GEOID")

    def test_place_to_county_by_summed_zcta_parts(self):
        self.assertEqual(self.doc["places"]["0690001"][2], "06003", "500 in 90004 (Gamma) beats 100 in 90001 (Alpha)")
        self.assertEqual(self.doc["places"]["5131200"], ["Glen Allen", "VA", "51085", "U1"],
                         "the approximation can pick the wrong county: city-counties.json exists for this (P06)")

    def test_rows_with_no_zcta_are_skipped_and_counted(self):
        self.assertEqual(self.doc["source"]["counts"]["rowsWithoutZcta"], 2)
        self.assertNotIn("", self.doc["zips"])

    def test_place_suffixes_are_stripped_and_county_names_kept(self):
        p, c = self.doc["places"], self.doc["counties"]
        self.assertEqual([p[g][0] for g in ("0690001", "0690002", "0690011", "2148006", "1836003", "7263820", "7200100", "5167000")],
                         ["Alpha", "Beta", "Twin", "Metroville/Big County", "Indianapolis", "Ponce", "Aceitunas", "Richmond"])
        self.assertEqual(c["51760"], ["Richmond city", "VA"])
        self.assertEqual(c["51159"], ["Richmond County", "VA"])
        self.assertEqual(p["5167000"][2], "51760", "Richmond, VA is in its own county-equivalent, not Richmond County")

    def test_state_from_fips(self):
        self.assertEqual({v[1] for v in self.doc["counties"].values()}, {"CA", "IN", "KY", "MA", "VA", "PR"})

    def test_counts_and_the_q1a_report(self):
        c = self.doc["source"]["counts"]
        self.assertEqual((c["zips"], c["zipsWithNoPlace"], c["places"], c["counties"]), (16, 3, 13, 12))
        self.assertEqual(self.doc["source"]["noPlaceByState"], {"MA": 1})

    def test_provenance(self):
        s = self.doc["source"]
        self.assertEqual(s["content"], cp.content_sha(self.doc))
        self.assertEqual(sorted(s["files"]), [cp.COUNTY_FILE, cp.PLACE_FILE])
        for f in s["files"].values():
            self.assertRegex(f["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(f["url"].startswith("https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_"))
        self.assertIn("17 U.S.C.", s["licence"])


class Refusals(unittest.TestCase):
    def variant(self, which, edit, raw=False):
        tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.remove(os.path.join(tmp, n)) for n in os.listdir(tmp)] and os.rmdir(tmp))
        out = {}
        for name in ("zcta-place.txt", "zcta-county.txt"):
            data = (FIX / name).read_bytes()
            if name == which:
                data = edit(data) if raw else edit(data.decode("utf-8")).encode("utf-8")
            Path(tmp, name).write_bytes(data)
            out[name] = Path(tmp, name)
        return out["zcta-place.txt"], out["zcta-county.txt"]

    def refused(self, which, edit, pattern, raw=False):
        place, county = self.variant(which, edit, raw)
        with self.assertRaisesRegex(cp.CensusError, pattern):
            build(place, county)

    def test_an_unknown_place_suffix_fails(self):
        self.refused("zcta-place.txt", lambda t: t.replace("Alpha city", "Alpha hamlet"), "unknown place-type suffix")

    def test_an_unknown_fips_prefix_fails(self):
        self.refused("zcta-place.txt", lambda t: t.replace("|0690010|", "|9990010|"), "unknown state FIPS")

    def test_a_missing_column_fails(self):
        self.refused("zcta-county.txt", lambda t: t.replace("NAMELSAD_COUNTY_20", "NAME_COUNTY_20", 1), "missing column")

    def test_a_bad_area_fails(self):
        self.refused("zcta-place.txt", lambda t: t.replace("|100|0\n", "|1e2|0\n", 1), "AREALAND_PART")

    def test_a_duplicate_pair_fails(self):
        self.refused("zcta-county.txt", lambda t: t + t.splitlines()[1] + "\n", "duplicate")

    def test_a_bad_geoid_fails(self):
        self.refused("zcta-place.txt", lambda t: t.replace("|90004|", "|9004|", 1), "ZCTA")

    def test_not_utf8_fails_and_a_bom_is_fine(self):
        self.refused("zcta-place.txt", lambda b: b.replace(b"Alpha city", b"Alph\xe9 city"), "not UTF-8", raw=True)
        place, county = self.variant("zcta-place.txt", lambda b: b"\xef\xbb\xbf" + b, raw=True)
        self.assertEqual(build(place, county)["source"]["content"], build()["source"]["content"])

    def test_the_zcta_range_is_checked(self):
        with self.assertRaisesRegex(cp.CensusError, "distinct ZCTAs, expected 33000-34500"):
            build(expect=(33000, 34500))

    def test_the_retrieval_date_is_checked(self):
        with self.assertRaisesRegex(cp.CensusError, "YYYY-MM-DD"):
            cp.build(str(FIX / "zcta-place.txt"), str(FIX / "zcta-county.txt"), "yesterday", SMALL)


class Output(unittest.TestCase):
    def run_tool(self, out, seed, tz):
        env = dict(os.environ, PYTHONHASHSEED=seed, TZ=tz, LC_ALL="C")
        subprocess.run([sys.executable, str(TOOL), "--zcta-place", str(FIX / "zcta-place.txt"), "--zcta-county",
                        str(FIX / "zcta-county.txt"), "--retrieved", "2026-10-16", "--out", out, "--expect-zctas", "1-100"],
                       check=True, env=env, stdout=subprocess.DEVNULL)
        return Path(out).read_bytes()

    def test_identical_bytes_across_processes_and_the_recorded_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = self.run_tool(os.path.join(tmp, "a.json"), "1", "UTC")
            b = self.run_tool(os.path.join(tmp, "b.json"), "977", "Pacific/Kiritimati")
        self.assertEqual(a, b)
        doc = json.loads(a)
        self.assertEqual(doc["source"]["builder"], cp.lf_sha(str(TOOL)))
        self.assertEqual(doc["source"]["content"], cp.content_sha(doc))
        lines = a.decode().split("\n")
        self.assertIn(',"90001":["0690001","06001"]', lines, "one zip per line, its comma leading")
        self.assertTrue(all(not l.endswith(",") for l in lines), "commas lead")

    def test_no_clock_and_no_network(self):
        src = TOOL.read_text(encoding="utf-8")
        for bad in (r"\.now\(", r"\.today\(", r"\btime\.time\(", r"^import time\b", r"\burllib\b", r"\bsocket\b", r"\bhttp\.client\b"):
            self.assertIsNone(re.search(bad, src, re.M), bad)


if __name__ == "__main__":
    unittest.main()
