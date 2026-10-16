"""places.json (#159): fields, census places and counties, in their own search data file.

(a) The resolution order (plan v2 MF2) on a synthetic census table built by tools/census_places.py
    from tests/search/fixtures/census/: aliases, name match, a single incorporated place, ambiguity
    reported, county overrides for census places too, redundant entries, zip fixes, non-ZCTA zips
    and the Q1a report.
(b) Stability (MF3): a new field in a new place adds its lines and nothing else; a club moving
    between places changes one line; a field change never touches core; games files never depend
    on census data.
(c) The committed files: places.json and core (schema 2), the reviewed seeds.
(d) With the real table committed (public/data/zip-places.json): its integrity and provenance
    (MF1), and the judged D2 and D8 facts of tests/search/queries.json.
"""
import difflib
import functools
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
import sys
sys.path.insert(0, str(HERE.parent))
import ecnl_api as api
import search_index as si

spec = importlib.util.spec_from_file_location("census_places", HERE.parent / "tools" / "census_places.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)
CENSUS_FIX = HERE / "search" / "fixtures" / "census"
DATA = Path(api.PUBLIC_DIR) / "data"
TABLE = DATA / "zip-places.json"
SEARCH = Path(api.ARCHIVE_DIR) / "search"


def load(path):
    with open(path, "rb") as f:
        return json.loads(f.read().replace(b"\r\n", b"\n"))


@functools.lru_cache(maxsize=None)
def synthetic_table():
    return cp.build(str(CENSUS_FIX / "zcta-place.txt"), str(CENSUS_FIX / "zcta-county.txt"), "2026-10-16", (1, 100))


def inputs(tmp, fixes=(), aliases=(), cities=(), table=True):
    """A checkout-shaped inputs directory: the committed field and zip inputs, the synthetic census
    table, and the given census corrections."""
    d = Path(tmp) / "public" / "data"
    d.mkdir(parents=True, exist_ok=True)
    for n in ("field-aliases.json", "zip-fixes.json"):
        shutil.copy(DATA / n, d / n)
    if table:
        (d / "zip-places.json").write_bytes(cp.dump(synthetic_table()))
    (d / "zip-place-fixes.json").write_text(json.dumps({"schema": 1, "fixes": list(fixes), "aliases": list(aliases)}), encoding="utf-8")
    (d / "city-counties.json").write_text(json.dumps({"schema": 1, "cities": list(cities)}), encoding="utf-8")
    return tmp


def resolver(tmp):
    import collections
    census, _ = si.load_census(tmp)
    fixes, aliases, counties, errors = si.load_place_inputs(census, tmp)
    report = collections.defaultdict(list)
    return si.Places(census, fixes, aliases, counties, report, errors), report, errors


class Order(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_normalisation_is_the_same_on_both_sides(self):
        n = si.norm_city
        self.assertEqual(n("RALEIGH"), n("Raleigh"))
        self.assertEqual(n("St Johns"), n("St. Johns"))
        self.assertEqual(n("St Johns"), "saint johns")
        self.assertEqual(n("Mt. Pleasant"), n("Mount Pleasant"))
        self.assertEqual(n("O'Fallon"), n("O’Fallon"))
        self.assertEqual(n("O'Fallon"), "ofallon")
        self.assertEqual(n("Winston-Salem"), "winston salem")

    def test_a_single_incorporated_place_wins_otherwise_nothing_is_picked(self):
        pl, report, errors = resolver(inputs(self.tmp))
        self.assertEqual(pl.city("Twin, CA", "club 1")[0], "0690010", "the city beats the CDP of the same name")
        self.assertEqual(pl.city("Pair, CA", "club 2"), [None, None], "two CDPs: no pick")
        self.assertTrue(any("Pair, CA" in x for x in report["cities matching two or more census places (no pick; add an alias with evidence)"]))

    def test_a_city_county_entry_beats_a_census_places_computed_county(self):
        """P06's Glen Allen case: the summed-ZCTA approximation says Hanover; the entry says Henrico."""
        pl, _, errors = resolver(inputs(self.tmp))
        self.assertEqual(pl.city("Glen Allen, VA", "club 417"), ["5131200", "51085"], "the computed county, without an entry")
        pl, _, errors = resolver(inputs(self.tmp, cities=[{"city": "Glen Allen", "state": "VA", "countyGeoid": "51087",
                                                           "countyName": "Henrico County", "evidence": "home fields 23238"}]))
        self.assertEqual(pl.city("Glen Allen, VA", "club 417"), ["5131200", "51087"])
        self.assertEqual(pl.place_county["5131200"], "51087", "the place itself carries the override")
        self.assertEqual(errors, [])

    def test_a_redundant_county_entry_is_an_error(self):
        pl, _, errors = resolver(inputs(self.tmp, cities=[{"city": "Glen Allen", "state": "VA", "countyGeoid": "51085",
                                                           "countyName": "Hanover County", "evidence": "e"}]))
        pl.city("Glen Allen, VA", "club 417")
        pl.city("Glen Allen, VA", "club 418")
        self.assertEqual(len([e for e in errors if "redundant" in e]), 1)

    def test_a_city_that_is_no_census_place_gets_its_entry_or_is_reported(self):
        pl, report, _ = resolver(inputs(self.tmp, cities=[{"city": "Woodland Hills", "state": "CA", "countyGeoid": "06005",
                                                           "countyName": "Delta County", "evidence": "e"}]))
        self.assertEqual(pl.city("Woodland Hills, CA", "club 82"), [None, "06005"])
        self.assertEqual(pl.city("Bay Area, CA", "club 3986"), [None, None])
        self.assertTrue(any("Bay Area, CA" in x for k, v in report.items() for x in v))

    def test_an_alias_names_a_consolidated_place(self):
        pl, _, errors = resolver(inputs(self.tmp, aliases=[{"city": "Metroville", "state": "KY", "placeGeoid": "2148006",
                                                            "placeName": "Metroville/Big County", "evidence": "e"}]))
        self.assertEqual(pl.city("Metroville, KY", "club 3408"), ["2148006", "21111"])
        self.assertEqual(errors, [])
        pl, _, _ = resolver(inputs(tempfile.mkdtemp(dir=self.tmp)))
        self.assertEqual(pl.city("Metroville, KY", "club 3408"), [None, None], "without the alias, no match")

    def test_zip_fixes_non_zctas_and_the_q1a_report(self):
        pl, report, errors = resolver(inputs(self.tmp, fixes=[{"zip": "90002", "placeGeoid": "0690002", "placeName": "Beta",
                                                               "state": "CA", "evidence": "e"}]))
        self.assertEqual(pl.zip("90002", "f"), ["0690002", "06001"])
        self.assertEqual(pl.zip("90005", "f"), ["0690004", "06001"], "the zip's county comes from the county file")
        self.assertEqual(pl.zip("99999", "Nowhere Park"), [None, None])
        self.assertEqual(pl.zip("01001", "Mass Field"), [None, "25013"])
        self.assertEqual(report["field zips that are not ZCTAs (no city, no county)"], ["99999 (Nowhere Park)"])
        self.assertEqual(report["field zips with no census place in the county-subdivision states (Q1a; county kept)"], ["MA 01001 (Mass Field)"])
        self.assertEqual(errors, [])

    def test_bad_entries_are_left_out_and_reported(self):
        tmp = inputs(self.tmp,
                     fixes=[{"zip": "90001", "placeGeoid": "0690001", "placeName": "Alpha", "state": "CA", "evidence": "e"},   # redundant
                            {"zip": "90002", "placeGeoid": "0690002", "placeName": "Bravo", "state": "CA", "evidence": "e"},   # wrong name
                            {"zip": "9000", "placeGeoid": "0690002", "placeName": "Beta", "state": "CA", "evidence": "e"}],    # bad zip
                     aliases=[{"city": "Metroville", "state": "KY", "placeGeoid": "2199999", "placeName": "X", "evidence": "e"}],
                     cities=[{"city": "Fairfax", "state": "VA", "countyGeoid": "51059", "countyName": "Fairfax County", "evidence": "e"},
                             {"city": "Glen Allen", "state": "VA", "countyGeoid": "51087", "countyName": "Henrico County"}])
        census, _ = si.load_census(tmp)
        fixes, aliases, counties, errors = si.load_place_inputs(census, tmp)
        self.assertEqual((fixes, aliases), ({}, {}))
        self.assertEqual(list(counties), [], "51059 is not in the synthetic table; the other entry has no evidence")
        self.assertEqual(len(errors), 6, errors)


class Stability(unittest.TestCase):
    """MF3 and the Reviewer's nit 4, on the committed archive with the synthetic table."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        inputs(cls.tmp)
        cls.directory = load(Path(api.ARCHIVE_DIR) / "directory.json")
        ids = [c[0] for c in cls.directory["clubs"] if c[3]][:3]
        cls.ids = ids
        for c in cls.directory["clubs"]:
            if c[0] in ids:
                c[3] = {ids[0]: "Alpha, CA", ids[1]: "Alpha, CA", ids[2]: "Delta, CA"}[c[0]]
        cls.base = si.build(directory=cls.directory, inputs=cls.tmp)[0]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def diff(self, a, b):
        a, b = a.decode().split("\n"), b.decode().split("\n")
        return [l for l in difflib.unified_diff(a, b, lineterm="", n=0) if l[:1] in "+-" and not l.startswith(("+++", "---"))]

    def test_a_club_moving_between_places_changes_one_line(self):
        d = json.loads(json.dumps(self.directory))
        for c in d["clubs"]:
            if c[0] == self.ids[1]:
                c[3] = "Delta, CA"
        files = si.build(directory=d, inputs=self.tmp)[0]
        changes = self.diff(self.base["places.json"], files["places.json"])
        self.assertEqual(len(changes), 4, changes)          # build, and the club's clubPlaces line
        self.assertTrue(all(l[1:].startswith((',"build":', f'"{self.ids[1]}":', f',"{self.ids[1]}":')) for l in changes), changes)

    def test_a_new_field_in_a_new_place_adds_its_lines_and_never_touches_core(self):
        """One new game at a new complex in zip 90008 (Twin CDP, county 06005, already listed):
        places.json gains the place line and the field line, and its build line changes."""
        src = api.load_sources()
        eid = src["seasons"]["2023-24"]["conferences"]["Southwest"]["eventId"]
        h = load(Path(api.ARCHIVE_API_DIR) / "Event" / "get-event-schedule-or-standings" / f"{eid}.json")
        f = h["data"]["girlsDivAndFlightList"][0]["flightList"][0]["flightID"]
        path = api.p_schedule(eid, f)
        real = api.read_archive

        def read(p):
            raw, stamp = real(p)
            if p == path:
                doc = json.loads(raw)
                doc["data"].append(dict(doc["data"][0], matchID=99999901, complex="Churn Test Park", complexID=99999901, zip="90008"))
                return json.dumps(doc).encode(), stamp
            return raw, stamp
        from unittest.mock import patch
        with patch.object(api, "read_archive", side_effect=read):
            files = si.build(directory=self.directory, inputs=self.tmp)[0]
        self.assertEqual(files["core.json"], self.base["core.json"], "a field change never touches core (nit 4)")
        changes = self.diff(self.base["places.json"], files["places.json"])
        added = sorted(l for l in changes if l.startswith("+"))
        removed = [l for l in changes if l.startswith("-")]
        self.assertEqual(len(removed), 1, changes)
        self.assertTrue(removed[0].startswith('-,"build":'), changes)
        self.assertEqual(len(added), 3, changes)
        self.assertTrue(any(l.startswith('+,"build":') for l in added), changes)
        self.assertIn('+,"0690011":["Twin","CA","06005"]', added)
        self.assertTrue(any(l.startswith('+,"churn test park@90008":[') and l.endswith(',"0690011","06005"]') for l in added), changes)

    def test_games_files_never_depend_on_census_data(self):
        without = tempfile.mkdtemp(dir=self.tmp)
        inputs(without, table=False)
        files = si.build(directory=self.directory, inputs=without)[0]
        for n, b in self.base.items():
            if n != "places.json":
                self.assertEqual(files[n], b, n)


class Committed(unittest.TestCase):
    def test_places_json_and_core_schema_2(self):
        places = load(SEARCH / "places.json")
        self.assertEqual(list(places), ["schema", "build", "census", "vocab", "counties", "places", "clubPlaces", "eventPlaces", "fields"])
        self.assertEqual(places["schema"], 1)
        core = load(SEARCH / "core.json")
        self.assertEqual(core["schema"], 2)
        self.assertNotIn("fields", core)
        self.assertNotIn("fieldAliases", core["vocab"])
        for v in places["fields"].values():
            self.assertEqual(len(v), 5)
            self.assertEqual(v[1], sorted(v[1]))

    def test_the_reviewed_seeds(self):
        fixes = load(DATA / "zip-place-fixes.json")
        self.assertEqual([f["zip"] for f in fixes["fixes"]], ["92014"])
        self.assertEqual([(a["city"], a["state"]) for a in fixes["aliases"]], [("Louisville", "KY")])
        cities = {(c["city"], c["state"]): c["countyGeoid"] for c in load(DATA / "city-counties.json")["cities"]}
        self.assertEqual(cities[("Woodland Hills", "CA")], "06037")
        self.assertEqual(cities[("Fairfax", "VA")], "51059", "owner decision Q-E: Fairfax County")
        for doc, keys in ((fixes["fixes"], si.PLACE_FIX_KEYS), (fixes["aliases"], si.PLACE_ALIAS_KEYS),
                          (load(DATA / "city-counties.json")["cities"], si.CITY_COUNTY_KEYS)):
            for e in doc:
                self.assertEqual(set(e), keys)
                self.assertTrue(e["evidence"].strip())


@unittest.skipUnless(TABLE.exists(), "public/data/zip-places.json is not committed yet (the census download waits for the owner's OK)")
class RealTable(unittest.TestCase):
    """The committed census table: provably the tool's output (MF1), and the judged facts."""

    @classmethod
    def setUpClass(cls):
        cls.table = load(TABLE)
        cls.places = load(SEARCH / "places.json")

    def test_provenance(self):
        s = self.table["source"]
        self.assertEqual(s["builder"], cp.lf_sha(str(HERE.parent / "tools" / "census_places.py")), "rebuild the table with the current tool")
        self.assertEqual(s["content"], cp.content_sha(self.table), "zip-places.json was edited by hand")
        self.assertEqual(self.places["census"], s["content"])
        for f in s["files"].values():
            self.assertRegex(f["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(f["rows"], 30000)
        self.assertTrue(33000 <= s["counts"]["zips"] <= 34500)

    def test_every_reference_resolves(self):
        t = self.table
        for z, (p, c) in t["zips"].items():
            self.assertTrue(p is None or p in t["places"], z)
            self.assertTrue(c is None or c in t["counties"], z)
        for g, v in t["places"].items():
            self.assertTrue(v[2] is None or v[2] in t["counties"], g)

    # ---- the judged D2 and D8 facts (tests/search/queries.json) ----
    def club(self, cid):
        g, c = self.places["clubPlaces"][str(cid)]
        return (self.places["places"][g][0] if g else None), (self.places["counties"][c][0] if c else None), c

    def event(self, eid):
        g, c = self.places["eventPlaces"][str(eid)]
        return (self.places["places"][g][0] if g else None), (self.places["counties"][c][0] if c else None), c

    def field(self, key):
        g, c = self.places["fields"][key][3:5]
        return (self.places["places"][g][0] if g else None), (self.places["counties"][c][0] if c else None), c

    def test_the_judged_county_lists(self):
        counties = json.loads((HERE / "search" / "queries.json").read_text(encoding="utf-8"))["vocabulary"]["counties"]
        by_city = {}
        for cid in self.places["clubPlaces"]:
            name, county, _ = self.club(cid)
            if name:
                by_city.setdefault(name, set()).add(county)
        for county_st, cities in counties.items():
            county = county_st.rsplit(", ", 1)[0]
            for city in cities:
                if city == "Woodland Hills":
                    self.assertEqual(self.club(82)[1], county)
                elif city in by_city:
                    self.assertEqual(by_city[city], {county}, city)

    def test_p01_sacramento(self):
        self.assertEqual(self.club(88)[1], "Sacramento County")
        self.assertNotEqual(self.club(88)[0], "Sacramento")
        self.assertEqual(self.club(1425)[1], "Yolo County")
        self.assertEqual(self.club(3054)[1], "Placer County")

    def test_p02_p08_san_diego_and_del_mar(self):
        self.assertEqual(self.field("Surf Sports Park@92014")[:2], ("Del Mar", "San Diego County"))
        for eid in (2719, 4041):
            self.assertEqual(self.event(eid)[:2], ("Del Mar", "San Diego County"), eid)
        for cid in (87, 39):
            self.assertEqual(self.club(cid)[:2], ("San Diego", "San Diego County"), cid)
        self.assertEqual(self.club(300)[:2], ("Chula Vista", "San Diego County"))
        self.assertEqual(self.club(61)[1], "Riverside County")

    def test_p03_redmond(self):
        self.assertEqual(self.field("60 Acres Park@98052")[:2], ("Redmond", "King County"))
        for eid in (2436, 3064, 4251):
            self.assertEqual(self.event(eid)[:2], ("Redmond", "King County"), eid)
        for cid in (398, 3476, 2331, 1643):
            self.assertEqual(self.club(cid)[1], "King County", cid)
            self.assertNotEqual(self.club(cid)[0], "Redmond", cid)
        self.assertEqual(self.club(112)[1], "Pierce County")

    def test_p04_p05_los_angeles(self):
        self.assertEqual(self.club(2289)[:2], ("Los Angeles", "Los Angeles County"))
        self.assertEqual(self.club(16)[:2], ("Torrance", "Los Angeles County"))
        self.assertEqual(self.club(82)[1:], ("Los Angeles County", "06037"), "Woodland Hills, through city-counties.json")
        for cid, county in ((41, "Ventura County"), (13, "San Bernardino County"), (96, "Orange County"), (186, "Orange County"),
                            (98, "Orange County"), (61, "Riverside County")):
            self.assertEqual(self.club(cid)[1], county, cid)
        self.assertEqual(self.club(1760)[2][:2], "49", "La Roca FC is in Utah")

    def test_p06_richmond_d8(self):
        for eid in (2289, 2437, 2720, 3238, 3975):
            name, county, geoid = self.event(eid)
            self.assertEqual((name, geoid), ("Richmond", "51760"), eid)
        self.assertEqual(self.club(417)[1:], ("Henrico County", "51087"))
        self.assertEqual(self.club(69)[1], "Contra Costa County")

    def test_p07_phoenix(self):
        for cid in (592, 3716):
            self.assertEqual(self.club(cid)[:2], ("Phoenix", "Maricopa County"), cid)
        self.assertEqual(self.event(4133)[:2], ("Phoenix", "Maricopa County"))
        self.assertEqual(self.club(1141)[:2], ("Scottsdale", "Maricopa County"))

    def test_owner_decisions_fairfax_and_louisville(self):
        self.assertEqual(self.club(357)[1:], ("Fairfax County", "51059"), "Q-E")
        for cid in (3408, 3475):
            self.assertEqual(self.club(cid)[1], "Jefferson County", cid)


if __name__ == "__main__":
    unittest.main()
