"""Team directory (#114): every team in one file, for the page's team search.

A team is one club and age group followed across seasons: a #107 squad, exactly as
team_history.build() links it. The directory has one row per squad, built from the archive
alone (no API calls) and from the same in-memory squads as the history files. It is written to
public/archive/directory.json and served at /api/v1/teams. Teams seen only at a national event
or a showcase have no conference row and no team page, and are not listed (#97 decision 4;
#114 owner decision D3).

archive.py rebuilds it LAST in every path that can change its inputs (a crawl, --refresh,
--team-history, --clubs), after the club places and the catalog's birth-year anchor, and only
from a successful history build in the same run (#114 M3). See docs/data-api.md, "Team
directory".
"""
import json
import os
import re

import ecnl_api as api

SCHEMA = 1
NO_CLUB = 7            # TGS's placeholder club "No Club Selection": never placed (#108)


def directory_path():
    return os.path.join(api.ARCHIVE_DIR, "directory.json")


def outcome(e):
    """A post-season entry's result as one short label: "Champion", "Final", the last round
    reached ("Round of 16"), "Group 2/4", or "" (played, no round or group known)."""
    if e.get("champion"):
        return "Champion"
    if e.get("final") == "lost":
        return "Final"
    if e.get("reached"):
        return e["reached"]
    g = e.get("group")
    if g and g.get("pos"):
        return f"Group {g['pos']}/{g['of']}"
    return ""


def build(sources, squads, places=None):
    """The directory for `squads` (team_history.build()'s list, in its order).

    {"schema":1, "seasons":[...], "confs":[name], "divs":[[season, division, u, birthYears]],
     "events":[[season, "n"|"s", stage, eventId]], "tiers":[label], "clubs":[[id, name, logo, "City, ST"]],
     "squads":[{"c":club, "b":birthYears, "s":[[season, teamID, name, conf, div, rank, of]],
                "e":[[season, event, tier, outcome]], "best", "t", "m", "mp"}]}
    Indexes point into the shared tables. `e` lists post-season entries first (so the #107
    `best` index points into it), then showcases (outcome ""). `t` is the number of titles; `m`
    and `mp` are the #107 "possible continuation" links as squad indexes, both ways."""
    if places is None:
        places = (api.read_json_file(api.CLUBS_PATH) or {}).get("clubs") or {}
    seasons = sorted(sources["seasons"])
    si = {s: i for i, s in enumerate(seasons)}
    tables = {"confs": [], "divs": [], "events": [], "tiers": [], "clubs": []}
    ix = {k: {} for k in tables}

    def put(kind, key, value):
        if key not in ix[kind]:
            ix[kind][key] = len(tables[kind])
            tables[kind].append(value)
        return ix[kind][key]

    def div(season, name):
        ag = (sources["seasons"][season].get("ageGroups") or {}).get(name) or {}
        u = ag.get("u")
        if u is None:
            m = re.match(r"^G?U(\d+)", name or "")
            u = int(m.group(1)) if m else None
        return put("divs", (season, name), [si[season], name, u, sorted(ag.get("birthYears") or [])])

    def club(cid, name, logo):
        i = put("clubs", cid, [cid, " ".join((name or "").split()), logo or "", _place_of(places, cid)])
        if logo and not tables["clubs"][i][2]:
            tables["clubs"][i][2] = logo
        return i

    for s in seasons:
        for kind in ("national", "showcases"):
            for stage, ev in (sources["seasons"][s].get(kind) or {}).items():
                put("events", ev["eventId"], [si[s], "n" if kind == "national" else "s", stage, ev["eventId"]])

    start = {}
    for n, sq in enumerate(squads):
        for r in sq["seasons"]:
            start[(r["season"], r["teamID"])] = n
    out = []
    for sq in squads:
        last = sq["seasons"][-1]
        item = {
            "c": club(sq["clubID"], sq["clubName"], last.get("logo")),
            "b": sq["birthYears"],
            "s": [[si[r["season"]], r["teamID"], r["name"], put("confs", r["conference"], r["conference"]),
                   div(r["season"], r["division"]), r["rank"], r["of"]] for r in sq["seasons"]],
        }
        events = [[si[e["season"]], ix["events"][e["eventID"]], put("tiers", e["tier"], e["tier"]), outcome(e)]
                  for e in sq.get("postseason") or []]
        events += [[si[e["season"]], ix["events"][e["eventID"]], put("tiers", e["tier"], e["tier"]), ""]
                   for e in sq.get("showcases") or []]
        if events:
            item["e"] = events
        if sq.get("best") is not None:
            item["best"] = sq["best"]
        if sq.get("titles"):
            item["t"] = len(sq["titles"])
        if sq.get("maybe"):
            item["m"] = sorted({start[(m["season"], m["teamID"])] for m in sq["maybe"]})
        if sq.get("maybePrev"):
            item["mp"] = sorted({start[(m["season"], m["teamID"])] for m in sq["maybePrev"]})
        out.append(item)
    return {"schema": SCHEMA, "seasons": seasons, **tables, "squads": out}


def dump(doc):
    """One squad per line, so a refresh diff shows only the teams that changed."""
    def j(o):
        return json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    head = j({k: v for k, v in doc.items() if k != "squads"})[:-1]
    return (head + ',"squads":[\n' + ",\n".join(j(x) for x in doc["squads"]) + "\n]}\n").encode("utf-8")


def file_bytes(sources, squads, places=None):
    return dump(build(sources, squads, places))


def _on_disk(path):
    """The file's bytes with CRLF read as LF (git's autocrlf checkout), or None."""
    try:
        with open(path, "rb") as f:
            return f.read().replace(b"\r\n", b"\n")
    except OSError:
        return None


def write_directory(sources, squads, dry_run=False, path=None):
    """Write the directory if it differs from a fresh build. Returns True when it changed (or,
    with dry_run, would change). Atomic: the new bytes go to <path>.tmp, then os.replace; a
    failure removes the .tmp file, leaves the old file as it was, and raises."""
    path = path or directory_path()
    if not squads:
        raise ValueError("no squads to list; is the team history built?")
    data = file_bytes(sources, squads)
    if _on_disk(path) == data:
        return False
    if dry_run:
        return True
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return True


def _place_of(places, cid):
    p = places.get(str(cid)) if cid != NO_CLUB else None
    return f"{p['city']}, {p['state']}" if isinstance(p, dict) and p.get("city") and p.get("state") else ""


def refresh_places(places=None, path=None):
    """`archive.py --clubs`: only the club places changed, so update the "City, ST" column of the
    committed directory in place (no squad build). The result equals a fresh build whenever the
    rest of the file was current. A missing file is left missing. Returns True when it changed."""
    path = path or directory_path()
    raw = _on_disk(path)
    if raw is None:
        return False
    if places is None:
        places = (api.read_json_file(api.CLUBS_PATH) or {}).get("clubs") or {}
    doc = json.loads(raw)
    for c in doc["clubs"]:
        c[3] = _place_of(places, c[0])
    data = dump(doc)
    if data == raw:
        return False
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return True


def check_directory(sources, squads, path=None):
    """The drift check: True when the committed file differs from a fresh build. Writes nothing."""
    return _on_disk(path or directory_path()) != file_bytes(sources, squads)
