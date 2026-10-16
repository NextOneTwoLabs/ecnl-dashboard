"""#163: the local server serves the page's search modules as JavaScript (plan v2 nit 3).

Browsers refuse an ES module served with any other type. proxy_server.py pins .mjs and .js in its
handler's extensions_map, merged with the default map, so a Windows registry entry cannot change
them and the compression types stay as they were.
"""
import http.server
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import proxy_server


class StaticMime(unittest.TestCase):
    def handler(self):
        # guess_type needs no socket: build the handler without running __init__
        return proxy_server.ProxyHandler.__new__(proxy_server.ProxyHandler)

    def test_modules_are_javascript(self):
        h = self.handler()
        self.assertEqual(h.guess_type("/search/search.mjs"), "text/javascript")
        self.assertEqual(h.guess_type("/search/x.js"), "text/javascript")

    def test_the_default_map_is_kept(self):
        base = http.server.SimpleHTTPRequestHandler.extensions_map
        for ext, kind in base.items():
            self.assertEqual(proxy_server.ProxyHandler.extensions_map[ext], kind, ext)
        self.assertIn(".gz", proxy_server.ProxyHandler.extensions_map)

    def test_every_module_in_public_search_is_mjs(self):
        files = sorted(p.name for p in (Path(proxy_server.SERVE_DIR) / "search").iterdir())
        self.assertTrue(files, "public/search/ holds the modules")
        self.assertEqual([f for f in files if not f.endswith(".mjs")], [])


if __name__ == "__main__":
    unittest.main()
