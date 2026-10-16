"""Build public/data/zip-places.json from the 2020 Census ZCTA relationship files (#159).

Run once, offline, from two files downloaded by hand (with the owner's OK; README "Census places"):
  tab20_zcta520_place20_natl.txt   ZCTA to place
  tab20_zcta520_county20_natl.txt  ZCTA to county
Both are pipe-delimited with a header row. Source: U.S. Census Bureau, 2020 Census ZCTA to Place
and ZCTA to County Relationship Files. Public domain (17 U.S.C. § 105).

It is not part of the refresh or CI: the raw files are never committed. CI checks the committed
table instead (tests/test_search_places.py): source.builder must equal this file's LF sha256, and
source.content must equal the sha256 of the table's canonical content, so the table changes only
through this tool and every correction goes in the reviewed files (zip-place-fixes.json,
city-counties.json).

The rules (#158 plan v2 MF5; #159 plan v2 MF1, MF2):
  - A row with an empty ZCTA (a part of a place or county outside every ZCTA) is skipped and counted.
  - Zip -> place: the place with the largest AREALAND_PART > 0; ties to the lowest place GEOID. An
    empty place (the part of a zip outside every place) is never a candidate. No candidate: no city.
  - Zip -> county: from the county file directly, by the largest AREALAND_PART; ties to the lowest
    county GEOID. Never through the place.
  - Place -> county: each of the place's ZCTA parts counts toward its ZCTA's county; the largest sum
    wins, ties to the lowest county GEOID (an approximation near county lines; overrides fix it).
  - Place names: NAMELSAD with its legal or statistical suffix stripped; an unknown suffix fails.
  - County names: NAMELSAD as published ("Richmond city" is Virginia's independent city, 51760).
  - State: from the 2-digit FIPS prefix; an unknown prefix fails.
Deterministic: sorted keys, LF, no clock (the retrieval date is an argument), no network.

Usage (python -I with the netguard loaded by path; see README "Census places"):
  tools/census_places.py --zcta-place <file> --zcta-county <file> --retrieved YYYY-MM-DD --out <json>
"""
import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys

SCHEMA = 1
BASE_URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/"
PLACE_FILE = "tab20_zcta520_place20_natl.txt"
COUNTY_FILE = "tab20_zcta520_county20_natl.txt"
MAX_BYTES = 200 * 1024 * 1024
PLACE_COLUMNS = ("GEOID_ZCTA5_20", "GEOID_PLACE_20", "NAMELSAD_PLACE_20", "CLASSFP_PLACE_20", "AREALAND_PART")
COUNTY_COLUMNS = ("GEOID_ZCTA5_20", "GEOID_COUNTY_20", "NAMELSAD_COUNTY_20", "AREALAND_PART")

# State FIPS -> USPS code: the 50 states, DC, Puerto Rico, and the Island Areas, whose county-equivalents
# the 2020 county file lists in rows with no ZCTA (American Samoa 60, Guam 66, Northern Mariana Islands 69,
# U.S. Minor Outlying Islands 74, U.S. Virgin Islands 78).
FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR",
    "60": "AS", "66": "GU", "69": "MP", "74": "UM", "78": "VI",
}
# Place-type suffixes of NAMELSAD, longest first so "city and borough" wins over "borough".
SUFFIXES = sorted([
    " metropolitan government (balance)", " metro government (balance)", " unified government (balance)",
    " consolidated government (balance)", " city (balance)", " town (balance)", " (balance)",
    " city and borough", " zona urbana", " comunidad", " municipality", " borough", " village",
    " city", " town", " CDP",
    # found in the 2020 file (#159): Utah's metro townships, consolidated governments without
    # "(balance)", Lexington-Fayette, and West Virginia's corporations
    " metro township", " unified government", " consolidated government", " metropolitan government",
    " urban county", " corporation",
], key=len, reverse=True)
# Census places whose 2020 NAMELSAD carries no place-type word at all (the whole name is the name).
# Any other name without a known suffix still fails the tool.
NO_SUFFIX = frozenset({"Macon-Bibb County", "Anaconda-Deer Lodge County", "Hartsville/Trousdale County",
                       "Carson City", "Princeton"})
Q1A_STATES = ("CT", "MA", "ME", "NH", "RI", "VT", "NJ", "NY", "PA")


class CensusError(Exception):
    """The input is not what the 2020 relationship files are; nothing is written."""


def strip_place_name(namelsad):
    if namelsad in NO_SUFFIX:
        return namelsad
    for s in SUFFIXES:
        if namelsad.endswith(s) and len(namelsad) > len(s):
            return namelsad[: -len(s)]
    raise CensusError(f"unknown place-type suffix: {namelsad!r}")


def state_of(geoid):
    st = FIPS.get(geoid[:2])
    if not st:
        raise CensusError(f"unknown state FIPS prefix in {geoid!r}")
    return st


def read_rows(path, columns, label):
    """(header, rows as dicts) from a pipe-delimited file, BOM tolerated, strictly UTF-8."""
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        raise CensusError(f"{label}: {size} bytes is over the {MAX_BYTES} cap")
    with open(path, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as e:
        raise CensusError(f"{label}: not UTF-8 ({e})") from None
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter="|", quoting=csv.QUOTE_NONE)
    header = reader.fieldnames or []
    missing = [c for c in columns if c not in header]
    if missing:
        raise CensusError(f"{label}: missing column(s) {missing}")
    return header, list(reader)


def _area(row, label, n):
    v = (row.get("AREALAND_PART") or "").strip()
    if not re.fullmatch(r"\d+", v):
        raise CensusError(f"{label} row {n}: AREALAND_PART {v!r} is not a non-negative integer")
    return int(v)


def build(place_path, county_path, retrieved, expect_zctas=(33000, 34500), builder_sha=None):
    """The table document. Raises CensusError on anything unexpected."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", retrieved or ""):
        raise CensusError("--retrieved must be YYYY-MM-DD")
    counts = {"rowsWithoutZcta": 0}
    # ---- counties ----
    _, crows = read_rows(county_path, COUNTY_COLUMNS, COUNTY_FILE)
    counties, zip_county, seen = {}, {}, set()
    for n, r in enumerate(crows, 2):
        z, c = (r["GEOID_ZCTA5_20"] or "").strip(), (r["GEOID_COUNTY_20"] or "").strip()
        if c:
            if not re.fullmatch(r"\d{5}", c):
                raise CensusError(f"{COUNTY_FILE} row {n}: county GEOID {c!r}")
            name = (r["NAMELSAD_COUNTY_20"] or "").strip()
            if counties.setdefault(c, [name, state_of(c)])[0] != name:
                raise CensusError(f"{COUNTY_FILE} row {n}: county {c} has two names")
        if not z:
            counts["rowsWithoutZcta"] += 1
            continue
        if not re.fullmatch(r"\d{5}", z):
            raise CensusError(f"{COUNTY_FILE} row {n}: ZCTA {z!r}")
        if not c:
            continue
        if (z, c) in seen:
            raise CensusError(f"{COUNTY_FILE} row {n}: duplicate ZCTA {z} / county {c}")
        seen.add((z, c))
        area = _area(r, COUNTY_FILE, n)
        best = zip_county.get(z)
        if best is None or (-area, c) < (-best[1], best[0]):
            zip_county[z] = (c, area)
    # ---- places ----
    _, prows = read_rows(place_path, PLACE_COLUMNS, PLACE_FILE)
    places, zip_place, parts, zips, seen = {}, {}, {}, set(zip_county), set()
    for n, r in enumerate(prows, 2):
        z, p = (r["GEOID_ZCTA5_20"] or "").strip(), (r["GEOID_PLACE_20"] or "").strip()
        if p:
            if not re.fullmatch(r"\d{7}", p):
                raise CensusError(f"{PLACE_FILE} row {n}: place GEOID {p!r}")
            name = strip_place_name((r["NAMELSAD_PLACE_20"] or "").strip())
            cls = (r["CLASSFP_PLACE_20"] or "").strip()
            if places.setdefault(p, [name, state_of(p), None, cls])[:2] != [name, state_of(p)]:
                raise CensusError(f"{PLACE_FILE} row {n}: place {p} has two names")
        if not z:
            counts["rowsWithoutZcta"] += 1
            continue
        if not re.fullmatch(r"\d{5}", z):
            raise CensusError(f"{PLACE_FILE} row {n}: ZCTA {z!r}")
        zips.add(z)
        if not p:
            continue                       # the part of the zip outside every place
        if (z, p) in seen:
            raise CensusError(f"{PLACE_FILE} row {n}: duplicate ZCTA {z} / place {p}")
        seen.add((z, p))
        area = _area(r, PLACE_FILE, n)
        if area <= 0:
            continue                       # touches the place only across water
        parts.setdefault(p, []).append((z, area))
        best = zip_place.get(z)
        if best is None or (-area, p) < (-best[1], best[0]):
            zip_place[z] = (p, area)
    lo, hi = expect_zctas
    if not lo <= len(zips) <= hi:
        raise CensusError(f"{len(zips)} distinct ZCTAs, expected {lo}-{hi}")
    for p, ps in parts.items():
        by = {}
        for z, area in ps:
            c = zip_county.get(z, (None,))[0]
            if c:
                by[c] = by.get(c, 0) + area
        if by:
            places[p][2] = min(by, key=lambda c: (-by[c], c))
    table_zips = {z: [zip_place.get(z, (None,))[0], zip_county.get(z, (None,))[0]] for z in sorted(zips)}
    no_place = {}
    for z, (p, c) in table_zips.items():
        if p is None and c:
            st = counties[c][1]
            if st in Q1A_STATES:
                no_place[st] = no_place.get(st, 0) + 1
    counts.update(zips=len(table_zips), zipsWithNoPlace=sum(1 for v in table_zips.values() if v[0] is None),
                  places=len(places), counties=len(counties))
    files = {}
    for name, path, rows in ((PLACE_FILE, place_path, prows), (COUNTY_FILE, county_path, crows)):
        with open(path, "rb") as f:
            data = f.read()
        files[name] = {"url": BASE_URL + name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "rows": len(rows)}
    body = {"counties": dict(sorted(counties.items())), "places": dict(sorted(places.items())), "zips": table_zips}
    source = {
        "publisher": "U.S. Census Bureau",
        "vintage": "2020 Census ZCTA to Place and ZCTA to County Relationship Files",
        "licence": "Public domain (17 U.S.C. § 105)",
        "retrieved": retrieved,
        "files": files,
        "rules": "zip->place: largest AREALAND_PART > 0, ties to the lowest GEOID, none outside every place; "
                 "zip->county: the county file, largest AREALAND_PART, ties to the lowest GEOID; "
                 "place->county: largest summed ZCTA-part area by ZCTA county, ties to the lowest GEOID; "
                 "names: NAMELSAD with the place-type suffix stripped; state: FIPS prefix",
        "counts": counts,
        "noPlaceByState": dict(sorted(no_place.items())),
        "builder": builder_sha,
        "content": content_sha(body),
    }
    return {"schema": SCHEMA, "source": source, **body}


def content_sha(body):
    """sha256 of the canonical dump of counties, places and zips (recomputed by CI)."""
    canon = json.dumps({k: body[k] for k in ("counties", "places", "zips")}, sort_keys=True,
                       separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def lf_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()


def dump(doc):
    """One county, place or zip per line, sorted, commas leading (as the search data files)."""
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    def table(name):
        d = doc[name]
        return f'"{name}":{{\n' + "\n,".join(f"{j(k)}:{j(d[k])}" for k in sorted(d)) + "\n}"
    return ("{" + "\n,".join([f'"schema":{doc["schema"]}', f'"source":{j(doc["source"])}',
                               table("counties"), table("places"), table("zips")]) + "}\n").encode("utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build public/data/zip-places.json from the 2020 Census ZCTA files.")
    ap.add_argument("--zcta-place", required=True)
    ap.add_argument("--zcta-county", required=True)
    ap.add_argument("--retrieved", required=True, help="the download date, YYYY-MM-DD")
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-zctas", default="33000-34500", help="the accepted range of distinct ZCTAs (tests use a small one)")
    a = ap.parse_args(argv)
    lo, hi = (int(x) for x in a.expect_zctas.split("-"))
    try:
        doc = build(a.zcta_place, a.zcta_county, a.retrieved, (lo, hi), builder_sha=lf_sha(os.path.abspath(__file__)))
    except CensusError as e:
        print(f"census_places: {e}", file=sys.stderr)
        return 1
    data = dump(doc)
    tmp = a.out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, a.out)
    c = doc["source"]["counts"]
    print(f"census_places: {c['zips']} zips ({c['zipsWithNoPlace']} with no place), {c['places']} places, "
          f"{c['counties']} counties, {c['rowsWithoutZcta']} rows with no ZCTA skipped; "
          f"no place in the county-subdivision states: {doc['source']['noPlaceByState']}")
    for n, f in doc["source"]["files"].items():
        print(f"  {n}: {f['bytes']} bytes, {f['rows']} rows, sha256 {f['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
