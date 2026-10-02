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
FAMILIES_PATH = None   # public/data/club-families.json (#133)
FAMILY_KEYS = {"name", "main", "clubIDs", "evidence"}


def directory_path():
    return os.path.join(api.ARCHIVE_DIR, "directory.json")


def families_path():
    return FAMILIES_PATH or os.path.join(api.PUBLIC_DIR, "data", "club-families.json")


def load_families(path=None):
    """#133: the reviewed club families, as (entries, errors). A missing file is no families; an
    unreadable or malformed one is no families and one error (the directory is still written)."""
    path = path or families_path()
    if not os.path.exists(path):
        return [], []
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        return [], [f"club-families.json: unreadable ({e}); no family applied"]
    if not isinstance(doc, dict) or doc.get("schema") != 1 or not isinstance(doc.get("families"), list):
        return [], ["club-families.json: not {\"schema\": 1, \"families\": [...]}; no family applied"]
    return doc["families"], []


def validate_families(entries, known):
    """#133: the families that pass, as [(name, main, [ids])], and an error per entry dropped. Like
    team-links.json, a bad entry is skipped and reported, never fatal: the directory is still
    written, and the drift check (--team-history --check) fails on the error. An entry is
    {"name", "main", "clubIDs", "evidence"} and nothing else: a non-empty name used once, two or
    more distinct integer TGS club ids in the directory (never club 7, never an id another family
    already holds), a main id among them (its logo and place stand for the family), evidence."""
    out, errors, taken, names = [], [], {}, set()
    for i, e in enumerate(entries):
        label = f"club-families.json families[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{label}: not an object; skipped")
            continue
        label += f" {e.get('name')!r}"
        ids = e.get("clubIDs")
        why = None
        if set(e) - FAMILY_KEYS:
            why = f"unknown key(s) {sorted(set(e) - FAMILY_KEYS)}"
        elif not isinstance(e.get("name"), str) or not e["name"].strip():
            why = "no name"
        elif e["name"].strip() in names:
            why = "a name already used"
        elif not isinstance(e.get("evidence"), str) or not e["evidence"].strip():
            why = "no evidence"
        elif not isinstance(ids, list) or len(ids) < 2 or any(type(x) is not int for x in ids) or len(set(ids)) != len(ids):
            why = "clubIDs must be two or more distinct integer ids"
        elif NO_CLUB in ids:
            why = f"club {NO_CLUB} (No Club Selection) can't be in a family"
        elif any(x not in known for x in ids):
            why = f"club id(s) {[x for x in ids if x not in known]} not in the directory"
        elif any(x in taken for x in ids):
            why = f"club id(s) {[x for x in ids if x in taken]} already in {taken[[x for x in ids if x in taken][0]]!r}"
        elif type(e.get("main")) is not int or e["main"] not in ids:
            why = "main must be one of its clubIDs"
        if why:
            errors.append(f"{label}: {why}; skipped")
            continue
        name = e["name"].strip()
        names.add(name)
        for x in ids:
            taken[x] = name
        out.append((name, e["main"], list(ids)))
    return out, errors


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


def build(sources, squads, places=None, families=None, errors=None):
    """The directory for `squads` (team_history.build()'s list, in its order).

    {"schema":1, "seasons":[...], "confs":[name], "divs":[[season, division, u, birthYears]],
     "events":[[season, "n"|"s", stage, eventId]], "tiers":[label],
     "clubs":[[id, name, logo, "City, ST"(, family)]], "families":[[name, mainClubID]],
     "squads":[{"c":club, "b":birthYears, "s":[[season, teamID, name, conf, div, rank, of]],
                "e":[[season, event, tier, outcome]], "best", "t", "m", "mp"}]}
    Indexes point into the shared tables. `e` lists post-season entries first (so the #107
    `best` index points into it), then showcases (outcome ""). `t` is the number of titles; `m`
    and `mp` are the #107 "possible continuation" links as squad indexes, both ways. A club in a
    reviewed family (#133, public/data/club-families.json, read here so the drift check sees a
    change to it) has a 5th element, its index in `families`; `families` is [name, main club].
    `families` (entries) defaults to the file's; problems are appended to `errors`."""
    if places is None:
        places = (api.read_json_file(api.CLUBS_PATH) or {}).get("clubs") or {}
    if families is None:
        families, problems = load_families()
        if errors is not None:
            errors.extend(problems)
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
    fams, problems = validate_families(families, set(ix["clubs"]))
    if errors is not None:
        errors.extend(problems)
    for fi, (_name, _main, ids) in enumerate(fams):
        for cid in ids:
            tables["clubs"][ix["clubs"][cid]].append(fi)
    return {"schema": SCHEMA, "seasons": seasons, **tables, "families": [[n, m] for n, m, _ids in fams], "squads": out}


def dump(doc):
    """One squad per line, so a refresh diff shows only the teams that changed."""
    def j(o):
        return json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    head = j({k: v for k, v in doc.items() if k != "squads"})[:-1]
    return (head + ',"squads":[\n' + ",\n".join(j(x) for x in doc["squads"]) + "\n]}\n").encode("utf-8")


def file_bytes(sources, squads, places=None, errors=None):
    return dump(build(sources, squads, places, errors=errors))


def _on_disk(path):
    """The file's bytes with CRLF read as LF (git's autocrlf checkout), or None."""
    try:
        with open(path, "rb") as f:
            return f.read().replace(b"\r\n", b"\n")
    except OSError:
        return None


def write_directory(sources, squads, dry_run=False, path=None, errors=None):
    """Write the directory if it differs from a fresh build. Returns True when it changed (or,
    with dry_run, would change). Atomic: the new bytes go to <path>.tmp, then os.replace; a
    failure removes the .tmp file, leaves the old file as it was, and raises. A bad family entry
    is not a failure: it is left out, the rest is written, and it is appended to `errors`."""
    path = path or directory_path()
    if not squads:
        raise ValueError("no squads to list; is the team history built?")
    data = file_bytes(sources, squads, errors=errors)
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


def check_directory(sources, squads, path=None, errors=None):
    """The drift check: True when the committed file differs from a fresh build (club-families.json
    included). Writes nothing. Family problems are appended to `errors`."""
    return _on_disk(path or directory_path()) != file_bytes(sources, squads, errors=errors)
