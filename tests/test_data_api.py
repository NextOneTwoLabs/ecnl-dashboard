import copy
import hashlib
import http.client
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import proxy_server
import data_api

ROOT = Path(proxy_server.SERVE_DIR)
HISTORY_DATA = (ROOT / 'archive/history/55477.json').exists()


def route_cases():
    """tests/routes.json. The team-history files (#107) are committed separately from the code:
    without them, the history 200 cases are skipped (and printed), not failed."""
    import re
    out = []
    for path, expected in json.loads((Path(__file__).parent / 'routes.json').read_text()):
        m = re.fullmatch(r'/api/v1/teams/(\d+)/history', path)
        if m and expected == 200 and not (ROOT / f'archive/history/{m[1]}.json').exists():
            print(f'skipped (no history data): {path}')
            continue
        out.append((path, expected))
    return out

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
            for path, expected in route_cases():
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
            for path, expected in route_cases():
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

    def test_keys_ignored_locally(self):
        # #93: the local server checks no keys: an Authorization header, valid-looking or not,
        # changes nothing, every answer still says "off", and nothing asks for credentials.
        # The key-shaped value is built here, so no key-shaped literal is in the tree.
        fake = 'ecnl_live_' + '0' * 12 + '_' + '0' * 64
        with patch.object(proxy_server.api, 'fetch_api_raw', side_effect=AssertionError('v1 must not contact upstream')), patch.object(proxy_server.ProxyHandler, 'log_message'):
            for auth in ('Bearer ' + fake, 'Bearer junk', 'Basic abc', ''):
                for method in ('GET', 'HEAD'):
                    status, headers, body = self.request('/api/v1/catalog', method, {'Authorization': auth})
                    self.assertEqual((status, headers.get('X-ECNL-Session')), (200, 'off'), (auth, method))
                    self.assertNotIn('WWW-Authenticate', headers)
                    self.assertNotIn('Set-Cookie', headers)
                    if method == 'GET': self.assertIn(b'"seasons"', body)
            # The Worker refuses a key in a URL with 400; locally it is only a query string.
            status, headers, _ = self.request('/api/v1/catalog?k=' + fake)
            self.assertEqual((status, headers.get('X-ECNL-Session')), (200, 'off'))

    def test_all_archive_parity(self):
        count = 0
        import re
        patterns = [
            (r'get-event-schedule-or-standings/(\d+)\.json', lambda m: (f'/api/v1/events/{m[1]}/hierarchy', m[1])),
            (r'get-standings-by-div-and-flight/(\d+)/(\d+)/(\d+)\.json', lambda m: (f'/api/v1/events/{m[3]}/divisions/{m[1]}/flights/{m[2]}/standings', m[3])),
            (r'get-schedules-by-flight/(\d+)/(\d+)/0\.json', lambda m: (f'/api/v1/events/{m[1]}/flights/{m[2]}/schedule', m[1])),
        ]
        # #82: the policy each resource should get, derived here from the catalog on its own terms
        # (a season earlier than refresh.activeSeason), not by the code under test.
        catalog = json.loads((ROOT / 'data/sources.json').read_bytes())
        active = catalog['refresh']['activeSeason']
        event_season = {str(e['eventId']): season for season, s in catalog['seasons'].items()
                        for kind in ('conferences', 'national', 'showcases') for e in (s.get(kind) or {}).values()}
        expected = lambda season: data_api.CLOSED_CACHE if season and season < active else 'no-cache'
        tally = {}
        base = ROOT / 'archive/api/Event'
        with patch.object(proxy_server.ProxyHandler, 'log_message'):
            for file in base.rglob('*.json'):
                for pattern, endpoint in patterns:
                    match = re.fullmatch(pattern, file.relative_to(base).as_posix())
                    if not match: continue
                    path, event = endpoint(match)
                    status, headers, body = self.request(path)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers['Cache-Control'], expected(event_season.get(event)), path)
                    self.assertEqual(body, file.read_bytes())
                    tally[headers['Cache-Control']] = tally.get(headers['Cache-Control'], 0) + 1
                    count += 1
            for file in (ROOT / 'archive/teams').glob('*.json'):
                status, headers, body = self.request(f'/api/v1/seasons/{file.stem}/teams')
                self.assertEqual(status, 200, file.name)
                self.assertEqual(headers['Cache-Control'], expected(file.stem), file.name)
                self.assertEqual(body, file.read_bytes())
                count += 1
            status, headers, body = self.request('/api/v1/clubs')
            self.assertEqual((status, body), (200, (ROOT / 'archive/clubs.json').read_bytes()))
            self.assertEqual(headers['Cache-Control'], 'no-cache')
            count += 1
            for file in (ROOT / 'archive/history').glob('*.json'):   # #107
                status, headers, body = self.request(f'/api/v1/teams/{file.stem}/history')
                self.assertEqual((status, body), (200, file.read_bytes()), file.name)
                self.assertEqual(headers['Cache-Control'], 'no-cache', file.name)
                count += 1
        self.assertGreater(count, 1200)
        self.assertGreater(tally.get(data_api.CLOSED_CACHE, 0), 1000)
        print(f'Python archive parity: {count} resources ({tally.get(data_api.CLOSED_CACHE, 0)} closed event resources)')

    # #82: tests/cache-policy.json, shared with tests/data-api.test.mjs.
    POLICY = json.loads((Path(__file__).parent / 'cache-policy.json').read_bytes())

    def test_cache_policy_archive_rows(self):
        closed = self.POLICY['closed']
        self.assertEqual(data_api.CLOSED_CACHE, closed)
        rows = 0
        with patch.object(proxy_server.ProxyHandler, 'log_message'):
            for path, expected, *method in self.POLICY['archive']:
                method = method[0] if method else 'GET'
                history = re.fullmatch(r'/api/v1/teams/(\d+)/history', path)
                if history and not (ROOT / f'archive/history/{history[1]}.json').exists():
                    print(f'skipped (no history data): {path}')
                    continue
                policy = closed if expected == 'closed' else expected
                status, headers, _ = self.request(path, method)
                self.assertEqual(headers['Cache-Control'], policy, (method, path))
                self.assertEqual(status == 200, expected != 'no-store', (method, path, status))
                self.assertNotIn('Vary', headers)
                if status == 200:
                    # A 304 carries the same policy, so a revalidation renews the stored copy.
                    for verb in ('GET', 'HEAD'):
                        again, conditional, body = self.request(path, verb, {'If-None-Match': headers['ETag']})
                        self.assertEqual((again, conditional['Cache-Control'], body), (304, policy, b''), (verb, path))
                rows += 1
        self.assertGreaterEqual(rows, 24)

    def _case_root(self, case, paths):
        """A throwaway root holding the case's catalog (as tests/data-api.test.mjs builds it) and
        a stub file for every path."""
        root = Path(tempfile.mkdtemp(prefix='cache-policy-'))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        (root / 'data').mkdir()
        if not case.get('missing'):
            if 'raw' in case:
                text = case['raw']
            else:
                catalog = copy.deepcopy(self.POLICY['catalogs']['catalog'])
                if 'activeSeason' in case: catalog['refresh']['activeSeason'] = case['activeSeason']
                if 'without' in case: del catalog[case['without']]
                if 'seasons' in case: catalog['seasons'] = case['seasons']
                text = json.dumps(catalog)
            (root / 'data/sources.json').write_text(text, encoding='utf-8')
        for path in paths:
            status, asset = data_api.resolve_resource(path)
            self.assertEqual(status, 200, path)
            (root / asset).parent.mkdir(parents=True, exist_ok=True)
            (root / asset).write_text(json.dumps({'stub': '/' + asset}, separators=(',', ':')), encoding='utf-8')
        return root

    def test_cache_policy_catalog_cases(self):
        # Rollover, and catalogs that can't be trusted (broken, malformed, numeric, padded): the
        # same answers as the Worker, every path still served.
        paths, closed = self.POLICY['catalogs']['paths'], self.POLICY['closed']
        with patch.object(proxy_server.ProxyHandler, 'log_message'):
            for case in self.POLICY['catalogs']['cases']:
                root = self._case_root(case, paths)
                with patch.object(proxy_server, 'SERVE_DIR', str(root)):
                    for path in paths:
                        for method in ('GET', 'HEAD'):
                            status, headers, body = self.request(path, method)
                            want = closed if path in case['closed'] else 'no-cache'
                            self.assertEqual((status, headers['Cache-Control']), (200, want), (case['name'], method, path))
                            stub = json.dumps({'stub': '/' + data_api.resolve_resource(path)[1]}, separators=(',', ':')).encode()
                            self.assertEqual(body, b'' if method == 'HEAD' else stub, (case['name'], path))
        print(f"Python cache policy: {len(self.POLICY['catalogs']['cases'])} catalog cases x {len(paths)} paths")

    def test_cache_policy_follows_catalog_changes(self):
        # The catalog is re-read when it changes on disk; an unusable one is never kept.
        paths = ['/api/v1/seasons/2024-25/teams']
        root = self._case_root({}, paths)
        source = root / 'data/sources.json'
        good = source.read_bytes()
        self.assertEqual(data_api.cache_policy(paths[0], root), self.POLICY['closed'])
        source.write_text('{', encoding='utf-8')
        self.assertEqual(data_api.cache_policy(paths[0], root), 'no-cache')
        # (A different size: two writes within one clock tick can share an mtime.)
        source.write_bytes(good.replace(b'"2026-27"', b'"2023-24" ', 1))
        self.assertEqual(data_api.cache_policy(paths[0], root), 'no-cache', 'a rollback of activeSeason is seen at once')
        source.write_bytes(good)
        self.assertEqual(data_api.cache_policy(paths[0], root), self.POLICY['closed'])
        source.unlink()
        self.assertEqual(data_api.cache_policy(paths[0], root), 'no-cache')
        for path in ('/api/v1/catalog', '/api/v1/status', '/api/v1/clubs', '/api/v1/teams/55477/history'):
            self.assertEqual(data_api.cache_policy(path, root), 'no-cache')

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

    def test_history_missing_is_json_404(self):
        # #107: an id with no history file is a JSON 404, with or without the data committed.
        for method in ('GET', 'HEAD'):
            status, missing, body = self.request('/api/v1/teams/1/history', method)
            self.assertEqual((status, missing['Cache-Control']), (404, 'no-store'))
            self.assertEqual(body, b'' if method == 'HEAD' else b'{"ok":false,"error":"Not found"}')

    @unittest.skipUnless(HISTORY_DATA, 'the team-history data (#107) is not in this checkout')
    def test_history_etag_and_304(self):
        history = '/api/v1/teams/55477/history'
        status, headers, body = self.request(history)
        self.assertEqual((status, headers['Cache-Control'], body), (200, 'no-cache', (ROOT / 'archive/history/55477.json').read_bytes()))
        self.assertEqual(headers['ETag'], '"' + hashlib.sha256(body).hexdigest() + '"')
        for method in ('GET', 'HEAD'):
            status, conditional, body = self.request(history, method, {'If-None-Match': headers['ETag']})
            self.assertEqual((status, body, conditional['ETag']), (304, b'', headers['ETag']))

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
            "/archive/history/55477.json",
            "/data/team-links.json",
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
