import hashlib
import http.client
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import proxy_server
import data_api

ROOT = Path(proxy_server.SERVE_DIR)

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = proxy_server.http.server.ThreadingHTTPServer(('127.0.0.1', 0), proxy_server.ProxyHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_contract(self):
        with patch.object(proxy_server.api, 'fetch_api_raw', side_effect=AssertionError('v1 must not contact upstream')), patch.object(proxy_server.ProxyHandler, 'log_message'):
            for path, expected in json.loads((Path(__file__).parent / 'routes.json').read_text()):
                for method in ('GET', 'HEAD', 'POST', 'OPTIONS'):
                    status, headers, body = self.request(path, method)
                    self.assertEqual(status, 405 if expected == 200 and method not in ('GET', 'HEAD') else expected, path)
                    self.assertIn('application/json', headers['Content-Type'])
                    if method == 'HEAD': self.assertEqual(body, b'')
                    if status == 405: self.assertEqual(headers['Allow'], 'GET, HEAD')

    def test_contract_sessions_off(self):
        # #90: the local server is the Worker without SESSION_SECRET. No cookie and a forged
        # cookie change nothing, every v1 answer says "off", and none sets a cookie.
        forged = '__Host-ecnl_s=v1.1790000000.1790086400.AAAAAAAAAAAAAAAAAAAAAA.' + 'A' * 43
        with patch.object(proxy_server.api, 'fetch_api_raw', side_effect=AssertionError('v1 must not contact upstream')), patch.object(proxy_server.ProxyHandler, 'log_message'):
            for path, expected in json.loads((Path(__file__).parent / 'routes.json').read_text()):
                for cookie in (None, forged):
                    for method in ('GET', 'HEAD', 'POST', 'OPTIONS'):
                        status, headers, body = self.request(path, method, {'Cookie': cookie} if cookie else None)
                        self.assertEqual(status, 405 if expected == 200 and method not in ('GET', 'HEAD') else expected, (path, method, cookie))
                        self.assertIn('application/json', headers['Content-Type'])
                        self.assertEqual(headers.get('X-ECNL-Session'), 'off', path)
                        self.assertNotIn('Set-Cookie', headers)
                        if method == 'HEAD': self.assertEqual(body, b'')
            status, headers, _ = self.request('/api/v1/catalog', headers={'If-None-Match': '*'})
            self.assertEqual((status, headers.get('X-ECNL-Session')), (304, 'off'))

    def test_all_archive_parity(self):
        count = 0
        import re
        patterns = [
            (r'get-event-schedule-or-standings/(\d+)\.json', lambda m: f'/api/v1/events/{m[1]}/hierarchy'),
            (r'get-standings-by-div-and-flight/(\d+)/(\d+)/(\d+)\.json', lambda m: f'/api/v1/events/{m[3]}/divisions/{m[1]}/flights/{m[2]}/standings'),
            (r'get-schedules-by-flight/(\d+)/(\d+)/0\.json', lambda m: f'/api/v1/events/{m[1]}/flights/{m[2]}/schedule'),
        ]
        base = ROOT / 'archive/api/Event'
        with patch.object(proxy_server.ProxyHandler, 'log_message'):
            for file in base.rglob('*.json'):
                for pattern, endpoint in patterns:
                    match = re.fullmatch(pattern, file.relative_to(base).as_posix())
                    if not match: continue
                    status, headers, body = self.request(endpoint(match))
                    self.assertEqual(status, 200)
                    self.assertEqual(body, file.read_bytes())
                    self.assertEqual(headers['Cache-Control'], 'no-cache')
                    count += 1
            for file in (ROOT / 'archive/teams').glob('*.json'):
                status, headers, body = self.request(f'/api/v1/seasons/{file.stem}/teams')
                self.assertEqual(status, 200, file.name)
                self.assertEqual(body, file.read_bytes())
                self.assertEqual(headers['Cache-Control'], 'no-cache')
                count += 1
            status, headers, body = self.request('/api/v1/clubs')
            self.assertEqual((status, body), (200, (ROOT / 'archive/clubs.json').read_bytes()))
            self.assertEqual(headers['Cache-Control'], 'no-cache')
            count += 1
        self.assertGreater(count, 1200)
        print(f'Python archive parity: {count} resources')

    def test_conditionals_and_errors(self):
        path = '/api/v1/catalog'
        status, headers, body = self.request(path)
        self.assertEqual(body, (ROOT / 'data/sources.json').read_bytes())
        for method in ('GET', 'HEAD'):
            for condition in ({'If-None-Match': headers['ETag']}, {'If-None-Match': 'W/' + headers['ETag']}, {'If-None-Match': '*'}, {'If-Modified-Since': headers['Last-Modified']}):
                status, conditional, body = self.request(path, method, condition)
                self.assertEqual(status, 304)
                self.assertEqual(body, b'')
                self.assertEqual(conditional['ETag'], headers['ETag'])
        self.assertEqual(self.request(path, headers={'If-None-Match': '"different"', 'If-Modified-Since': headers['Last-Modified']})[0], 200)
        self.assertEqual(self.request('/api/v1/events/999999999/hierarchy')[0], 404)
        for missing in ('/api/v1/seasons/2030-31/teams', '/api/v1/seasons/2099-00/teams'):
            for method in ('GET', 'HEAD'):
                status, headers, body = self.request(missing, method)
                self.assertEqual(status, 404, missing)
                self.assertIn('application/json', headers['Content-Type'])
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertEqual(body, b'' if method == 'HEAD' else b'{"ok":false,"error":"Not found"}')
        teams = '/api/v1/seasons/2026-27/teams'
        status, headers, _ = self.request(teams)
        self.assertEqual((status, headers['Cache-Control']), (200, 'no-cache'))
        for method in ('GET', 'HEAD'):
            status, conditional, body = self.request(teams, method, {'If-None-Match': headers['ETag']})
            self.assertEqual((status, body, conditional['ETag']), (304, b'', headers['ETag']))
        clubs = '/api/v1/clubs'
        status, headers, _ = self.request(clubs)
        self.assertEqual((status, headers['Cache-Control']), (200, 'no-cache'))
        for method in ('GET', 'HEAD'):
            status, conditional, body = self.request(clubs, method, {'If-None-Match': headers['ETag']})
            self.assertEqual((status, body, conditional['ETag']), (304, b'', headers['ETag']))
        with patch.object(Path, 'open', side_effect=PermissionError('fixture fault')):
            self.assertEqual(self.request(path)[0], 503)

    def test_live_reconstructed_guard(self):
        protected = next(iter(proxy_server.api.protected_paths()))
        with patch.object(proxy_server.api, 'fetch_api_raw', side_effect=AssertionError('protected data must not contact upstream')):
            status, headers, body = self.request('/api/' + protected + '?refresh=1')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-ECNL-Source'], 'reconstructed')

    def test_direct_archive_and_data_blocked(self):
        blocked_paths = [
            "/archive",
            "/archive/",
            "/archive/refresh-state.json",
            "/archive/api/Event/get-event-schedule-or-standings/4263.json",
            "/archive/teams/2026-27.json",
            "/%61rchive/teams/2026-27.json",
            "/archive/clubs.json",
            "/%61rchive/clubs.json",
            "/data",
            "/data/",
            "/data/sources.json",
            "/%61rchive/refresh-state.json",
            "/%64ata/sources.json",
            "/Archive/refresh-state.json",
            "/%41rchive/refresh-state.json",
            "/./archive/refresh-state.json",
            "/foo/../data/sources.json",
        ]
        with patch.object(proxy_server.ProxyHandler, 'log_message'):
            for path in blocked_paths:
                for method in ("GET", "HEAD", "POST"):
                    status, headers, body = self.request(path, method)
                    self.assertEqual(status, 404, f"{method} {path} should return 404")
                    self.assertIn("application/json", headers.get("Content-Type", ""))
                    self.assertEqual(headers.get("Cache-Control"), "no-store")
                    if method == "HEAD":
                        self.assertEqual(body, b"")
                    else:
                        data = json.loads(body.decode())
                        self.assertFalse(data.get("ok"))
                        self.assertEqual(data.get("error"), "Not found")

if __name__ == '__main__':
    unittest.main()
