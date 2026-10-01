"""Archive-only v1 contract for the zero-dependency local server.

Sessions are off here (#90): every v1 response says X-ECNL-Session: off, no cookie is set
and no rate limit applies, which is how the Worker behaves without SESSION_SECRET. No API key
is checked (#93): an Authorization header, or a key in the URL, changes nothing here. Status
codes match the Worker's, except that the Worker can also answer 429, and 400, 401 or 503 for keys.
Cache-Control matches the Worker's with sessions off (#82, cache_policy): a closed season's event
routes and team index are kept by the browser for a day, so use DevTools "Disable cache" or a hard
reload to see a local data change there at once.
"""
import hashlib
import json
import re
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path

ROUTES = [
    (re.compile(r"/api/v1/catalog"), lambda: "data/sources.json"),
    (re.compile(r"/api/v1/status"), lambda: "archive/refresh-state.json"),
    (re.compile(r"/api/v1/events/([^/]+)/hierarchy"), lambda e: f"archive/api/Event/get-event-schedule-or-standings/{e}.json"),
    (re.compile(r"/api/v1/events/([^/]+)/divisions/([^/]+)/flights/([^/]+)/standings"), lambda e, d, f: f"archive/api/Event/get-standings-by-div-and-flight/{d}/{f}/{e}.json"),
    (re.compile(r"/api/v1/events/([^/]+)/flights/([^/]+)/schedule"), lambda e, f: f"archive/api/Event/get-schedules-by-flight/{e}/{f}/0.json"),
    (re.compile(r"/api/v1/seasons/(?P<season>[^/]+)/teams"), lambda s: f"archive/teams/{s}.json"),
    (re.compile(r"/api/v1/clubs"), lambda: "archive/clubs.json"),
    (re.compile(r"/api/v1/teams/([^/]+)/history"), lambda t: f"archive/history/{t}.json"),
    (re.compile(r"/api/v1/teams"), lambda: "archive/directory.json"),   # #114: the team directory
]


def valid_id(value):
    return re.fullmatch(r"[1-9][0-9]*", value) is not None


def valid_season(value):
    """A season key such as 2026-27: YYYY-YY with consecutive years."""
    match = re.fullmatch(r"(20[0-9]{2})-([0-9]{2})", value)
    return match is not None and (int(match[1]) + 1) % 100 == int(match[2])


def resolve_resource(path):
    for pattern, asset in ROUTES:
        match = pattern.fullmatch(path)
        if match:
            season = pattern.groupindex.get("season")
            if any(not (valid_season if i == season else valid_id)(part)
                   for i, part in enumerate(match.groups(), 1)):
                return 400, None
            return 200, asset(*match.groups())
    return 404, None


# #82: the twin of cachePolicy in api/data-api.mjs. A closed season's event routes and team index
# (a season earlier than the catalog's refresh.activeSeason) may be kept by the browser for a day;
# everything else is no-cache. Sessions are off here, which is the Worker's `off` case, so the
# long header is sent as is. tests/cache-policy.json holds the cases both suites run.
CLOSED_CACHE = "private, max-age=86400, stale-while-revalidate=86400"
EVENT_ROUTE = re.compile(r"/api/v1/events/([^/]+)/(?:hierarchy|divisions/[^/]+/flights/[^/]+/standings|flights/[^/]+/schedule)")
TEAMS_ROUTE = re.compile(r"/api/v1/seasons/([^/]+)/teams")
EVENT_LISTS = ("conferences", "national", "showcases")
_catalog_memo = None   # ((catalog path, mtime_ns, size), facts); only a usable catalog is kept


def _event_key(value):
    """A catalog event id as the Worker reads it: a positive safe integer (an integral float is the
    same number in JavaScript) or a canonical decimal string; anything else is no id."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int):
        return str(value) if 0 < value <= 2 ** 53 - 1 else None
    return value if isinstance(value, str) and valid_id(value) else None


def season_facts(catalog):
    """(activeSeason, {eventId: season}), or None for a catalog that can't be trusted: no valid
    activeSeason (a strict YYYY-YY string) or no seasons object. Seasons with a malformed key are
    skipped; an id listed in two seasons takes the later one. Mirrors seasonFacts in the Worker."""
    refresh = catalog.get("refresh") if isinstance(catalog, dict) else None
    active = refresh.get("activeSeason") if isinstance(refresh, dict) else None
    if not (isinstance(active, str) and valid_season(active) and isinstance(catalog.get("seasons"), dict)):
        return None
    events = {}
    for season, entry in catalog["seasons"].items():
        if not (valid_season(season) and isinstance(entry, dict)):
            continue
        for kind in EVENT_LISTS:
            group = entry.get(kind)
            for event in group if isinstance(group, list) else group.values() if isinstance(group, dict) else ():
                key = _event_key(event.get("eventId")) if isinstance(event, dict) else None
                if key and events.get(key, "") < season:
                    events[key] = season
    return active, events


def _reject_constant(name):
    raise ValueError(f"{name} is not JSON")   # as JSON.parse in the Worker: no NaN or Infinity


def cache_policy(path, root):
    """The Cache-Control for a 200 or 304 on `path`. Fails safe, as the Worker does: any fault,
    or a catalog that can't be trusted, gives no-cache."""
    global _catalog_memo
    event, teams = EVENT_ROUTE.fullmatch(path), TEAMS_ROUTE.fullmatch(path)
    if not (event or teams):
        return "no-cache"
    try:
        source = Path(root) / "data/sources.json"
        stat = source.stat()
        stamp = (str(source), stat.st_mtime_ns, stat.st_size)
        memo = _catalog_memo
        if memo and memo[0] == stamp:
            facts = memo[1]
        else:
            facts = season_facts(json.loads(source.read_bytes(), parse_constant=_reject_constant))
            if facts:
                _catalog_memo = (stamp, facts)
        if not facts:
            return "no-cache"
        active, events = facts
        season = events.get(event[1]) if event else teams[1]
        return CLOSED_CACHE if season and season < active else "no-cache"
    except Exception:   # fail safe: the data is still served, only without a lifetime
        return "no-cache"


def serve(handler, path, root):
    status, asset = resolve_resource(path)
    if status == 200 and handler.command not in ("GET", "HEAD"):
        status = 405
    raw = b""
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
               "X-ECNL-Session": "off"}
    if status == 200:
        try:
            with (Path(root) / asset).open("rb") as source:
                raw = source.read()
                import os
                modified = os.fstat(source.fileno()).st_mtime
            etag = '"' + hashlib.sha256(raw).hexdigest() + '"'
            headers.update({"Cache-Control": cache_policy(path, root), "ETag": etag, "Last-Modified": formatdate(modified, usegmt=True)})
            condition = handler.headers.get("If-None-Match")
            if condition is not None:
                if any(tag.strip().removeprefix("W/") in ("*", etag) for tag in condition.split(",")):
                    status = 304
            elif handler.headers.get("If-Modified-Since"):
                try:
                    if int(modified) <= parsedate_to_datetime(handler.headers["If-Modified-Since"]).timestamp():
                        status = 304
                except (ValueError, TypeError, OverflowError):
                    pass
        except FileNotFoundError:
            status = 404
        except OSError as error:
            handler.log_error("data-api: %s", error)
            status = 503
    if status not in (200, 304):
        errors = {400: "Invalid identifier", 404: "Not found", 405: "Method not allowed", 503: "Data is temporarily unavailable"}
        raw = json.dumps({"ok": False, "error": errors[status]}, separators=(",", ":")).encode()
        if status == 405:
            headers["Allow"] = "GET, HEAD"
    handler.send_response(status)
    for key, value in headers.items():
        handler.send_header(key, value)
    if status != 304:
        handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    if handler.command != "HEAD" and status != 304:
        handler.wfile.write(raw)
