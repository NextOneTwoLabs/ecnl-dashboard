"""Archive-only v1 contract for the zero-dependency local server."""
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


def serve(handler, path, root):
    status, asset = resolve_resource(path)
    if status == 200 and handler.command not in ("GET", "HEAD"):
        status = 405
    raw = b""
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    if status == 200:
        try:
            with (Path(root) / asset).open("rb") as source:
                raw = source.read()
                import os
                modified = os.fstat(source.fileno()).st_mtime
            etag = '"' + hashlib.sha256(raw).hexdigest() + '"'
            headers.update({"Cache-Control": "no-cache", "ETag": etag, "Last-Modified": formatdate(modified, usegmt=True)})
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
