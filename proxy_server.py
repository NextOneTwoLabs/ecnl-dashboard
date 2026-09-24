"""
ECNL Dashboard Proxy Server (zero-dependency)

Serves static files and proxies API requests to api.athleteone.com, writing
every successful response into archive/api/ and falling back to that archive
whenever the live API is unreachable.

Usage:
    python proxy_server.py              live, with write-through archiving
    python proxy_server.py --offline    serve only from archive/, never hit the network
    python proxy_server.py --port 8000

    Then open http://localhost:5000/

Responses carry X-ECNL-Source: live | archive | reconstructed so the dashboard
can show where the data came from. Reconstructed schedules (ecnl_api.protected_paths)
are always served from the archive, even with ?live=1.
"""

import argparse
import http.server
import json
import os
import posixpath
import re
import sys
import urllib.error
import urllib.parse
from urllib.parse import urlparse, parse_qs

import ecnl_api as api
import data_api

PORT = 5000
# Serve public/ — the same directory Cloudflare Pages serves — so the local site
# and the hosted site are byte-identical. The Python tooling stays outside it.
SERVE_DIR = api.PUBLIC_DIR

OFFLINE = False


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files from the project directory and proxies /api/* requests."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if self._handle_v1():
            return

        if self._handle_blocked():
            return

        if parsed.path.startswith("/api/"):
            api_path = parsed.path[len("/api/"):]
            query = parse_qs(parsed.query)
            refresh = query.get("refresh", ["0"])[0] == "1"
            self._handle_api(api_path, refresh)
            return

        super().do_GET()

    def _handle_v1(self):
        path = urlparse(self.path).path
        if path == "/api/v1" or path.startswith("/api/v1/"):
            data_api.serve(self, path, SERVE_DIR)
            return True
        return False

    def _handle_blocked(self):
        raw_path = urlparse(self.path).path
        norm_path = posixpath.normpath(urllib.parse.unquote(raw_path))
        if re.match(r"^/(archive|data)($|/)", norm_path, re.IGNORECASE):
            self._send_json(404, {"ok": False, "error": "Not found"})
            return True
        return False

    def do_HEAD(self):
        if self._handle_v1():
            return
        if self._handle_blocked():
            return
        super().do_HEAD()

    def _unsupported(self):
        if not self._handle_v1() and not self._handle_blocked():
            self.send_error(501, "Unsupported method")

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = _unsupported

    # ---------- API ----------

    def _handle_api(self, api_path, refresh):
        if not api.is_safe_api_path(api_path):
            self._send_json(400, {"error": "Invalid API path"})
            return
        # Only the endpoint families the archive mirrors; refused before any fetch (#87).
        if not api.is_archivable_path(api_path):
            self._send_json(404, {"error": f"Not an archived endpoint family: {api_path}"})
            return

        # Reconstructed schedules (see ecnl_api.protected_paths): the live
        # endpoint returns an empty list, so the archived copy is the answer
        # even under ?live=1, and the write-through below must not run.
        if api.is_protected_path(api_path):
            if self._send_from_archive(api_path, note="reconstructed; live response not used"):
                return
            self._send_json(404, {"error": f"Protected (reconstructed) path {api_path} "
                                           f"has no archived copy. Run: python reconstruct.py"})
            return

        if OFFLINE:
            if not self._send_from_archive(api_path):
                self._send_json(
                    504,
                    {"error": f"Offline mode and no archived copy of {api_path}. "
                              f"Run: python archive.py"},
                )
            return

        try:
            raw = api.fetch_api_raw(api_path, timeout=15, retries=1)
            json.loads(raw)  # only archive well-formed JSON
        except (api.ApiError, ValueError, urllib.error.URLError) as e:
            # Live call failed — this is exactly what the archive is for.
            if self._send_from_archive(api_path, note=str(e)):
                self.log_fallback(api_path, e)
                return
            self._send_json(502, {"error": str(e)})
            return

        api.write_archive(api_path, raw)
        self._send_bytes(
            raw,
            source="live",
            cache="no-store" if refresh else "public, max-age=300",
        )

    def _send_from_archive(self, api_path, note=None):
        raw, stamp = api.read_archive(api_path)
        if raw is None:
            return False
        source = "reconstructed" if api.is_protected_path(api_path) else "archive"
        self._send_bytes(raw, source=source, archived_at=stamp,
                         cache="no-store", note=note)
        return True

    # ---------- response helpers ----------

    def _send_bytes(self, payload, source, archived_at=None, cache="no-store", note=None):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers",
                         "X-ECNL-Source, X-ECNL-Archived-At, X-ECNL-Note")
        self.send_header("X-ECNL-Source", source)
        if archived_at:
            self.send_header("X-ECNL-Archived-At", archived_at)
        if note:
            # Header values must stay on one line and ASCII-clean.
            self.send_header("X-ECNL-Note", "".join(
                c for c in note if c.isprintable() and ord(c) < 128)[:200])
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(payload)

    def _send_json(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    # ---------- logging ----------

    def log_fallback(self, api_path, err):
        sys.stderr.write(f"\033[33m[ARCHIVE]\033[0m {api_path} (live failed: {err})\n")

    def log_message(self, format, *args):
        msg = format % args
        if "/api/" in msg:
            tag = "\033[35m[OFFLINE]\033[0m" if OFFLINE else "\033[36m[PROXY]\033[0m"
            sys.stderr.write(f"{tag} {msg}\n")
        else:
            sys.stderr.write(f"[STATIC] {msg}\n")


def main():
    global OFFLINE
    ap = argparse.ArgumentParser(description="ECNL dashboard static + API proxy server.")
    ap.add_argument("--offline", action="store_true",
                    help="Serve API responses only from archive/, never from the network.")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    OFFLINE = args.offline

    mode = "OFFLINE (archive only)" if OFFLINE else "live + write-through archive"
    print(f"\n  ECNL Dashboard — serving {os.path.relpath(SERVE_DIR, api.ROOT)}/  ({mode})")
    print(f"  http://localhost:{args.port}/")
    print(f"  The page reads archive-only /api/v1 by default; add ?live=1 to use the proxy.")
    if not os.path.isdir(api.ARCHIVE_API_DIR):
        print(f"  note: no archive yet — run `python archive.py` to build one")
    print(f"  Press Ctrl+C to stop\n")

    # Threaded: browsers open several connections at once for the JSON fetches,
    # and a single-threaded server would serve them one at a time.
    server = http.server.ThreadingHTTPServer(("", args.port), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
