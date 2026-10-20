// #173, #190: tools/search_pair_check.mjs, the production check of the age-pair rule, on the frozen fixture and a local server, offline.
// Every test runs an explicit short query list (the real run uses the full set): the file takes seconds, not a minute.
// Run under the netguard: node --import ./tests/netguard/netguard.mjs --test tests/search-pair-check.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { check, fetchSite, queriesOf, servedProblems, parseArgs, isLoopback, SHORT_QUERIES, REQUEST_CAP, USAGE } = await import(new URL('../tools/search_pair_check.mjs', import.meta.url));
const FX = join(ROOT, 'tests/search/fixtures/search');
const AGE_OK = /export function ageOk\(row, r\) \{[\s\S]*?\n\}\n/;
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'pair-check-test-')); made.push(d); return d; };

// A site directory: the fixture's data and a copy of public/search/, optionally with ageOk replaced.
function site(ageOk) {
  const dir = temp();
  mkdirSync(join(dir, 'archive/search'), { recursive: true });
  for (const f of ['core.json', 'places.json', 'games-2021-22.json']) cpSync(join(FX, f), join(dir, 'archive/search', f));
  cpSync(join(ROOT, 'public/search'), join(dir, 'search'), { recursive: true });
  if (ageOk) {
    const p = join(dir, 'search/match.mjs'), s = readFileSync(p, 'utf8');
    assert.ok(AGE_OK.test(s), 'ageOk is where the test expects it');
    writeFileSync(p, s.replace(AGE_OK, ageOk));
  }
  return dir;
}
const FILED_ONLY = 'export function ageOk(row, r) { return !r.u || row.u === r.u; }\n';          // main before #173
const EITHER_AGE = 'export function ageOk(row, r) { return !r.u || row.u === r.u || (r.u2 != null && row.u === r.u2); }\n';   // option A

const PINNED = 'Eagles SC ECNL GU17/U18 2021-22';
const SHORT = SHORT_QUERIES;

test('#173 check: before-the-change modules vs the change, same files: only squads filed at their second age differ, and every rule holds', async () => {
  const keystrokes = Array.from({ length: PINNED.length - 1 }, (_, i) => PINNED.slice(0, i + 1));   // no judged keystrokes: the baseline test pins them
  const r = await check({ afterDir: site(null), beforeModules: { dir: site(FILED_ONLY) }, queries: [...new Set([...SHORT, ...keystrokes])] });
  assert.deepEqual(r.problems, []);
  assert.ok(r.summary.differingQueries.includes(PINNED));
  assert.ok(r.summary.differingQueries.every(q => /eagles/i.test(q) && /u-?17\/u?18/i.test(q)), 'on the fixture, only Eagles pair queries differ');
  assert.equal(r.summary.differing, 10, 'fixture count: 5 spellings x (2021-22, 2021); no keystroke prefix of the pinned query differs before ...2021');
});

test('#173 check: the check has teeth: an either-age rule (option A) is reported', async () => {
  const r = await check({ afterDir: site(EITHER_AGE), beforeModules: { dir: site(FILED_ONLY) }, queries: SHORT });
  assert.ok(r.problems.some(p => p.startsWith('rule 1')), r.problems.join('\n'));
});

test('#173 check: the check has teeth: modules that never find squad 2195 first are reported', async () => {
  const r = await check({ afterDir: site(FILED_ONLY), beforeModules: { dir: site(FILED_ONLY) }, queries: SHORT });
  assert.ok(r.problems.some(p => p.startsWith('rule 3')), r.problems.join('\n'));
  assert.equal(r.summary.differing, 0);
});

// ---------- #190: the real route layout ----------
// A free loopback port, found by listening on port 0.
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const ping = port => new Promise(res => get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
// Starts `python proxy_server.py --offline` (the Worker's route table: /archive* and /data* are 404, /api/v1/search/* is served from the
// archive) on a free port, waits for it up to 15 s, and kills it in `after`. New to the CI list: a Node test that starts a local server.
// PYTHON, as tests/team-history.test.mjs does. A failure to start is a clear error, never a hang.
const children = [];
after(() => { for (const c of children) c.kill(); });
async function withServer() {
  const port = await freePort();
  const child = spawn(process.env.PYTHON || 'python', ['proxy_server.py', '--offline', '--port', String(port)], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PYTHONPATH: join('tests', 'netguard'), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
  children.push(child);
  let exited = false; child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  while (!exited && Date.now() - t0 < 15000 && !(await ping(port))) await new Promise(r => setTimeout(r, 100));
  if (!(await ping(port))) throw new Error('the local server did not start within 15 s');
  return { base: `http://127.0.0.1:${port}`, port };
}
const COMMITTED = n => readFileSync(join(ROOT, 'public/archive/search', n));
const DATA_ROUTES = { '/api/v1/search/core': 'core.json', '/api/v1/search/places': 'places.json', '/api/v1/search/games/2021-22': 'games-2021-22.json' };
const tmpFolders = () => readdirSync(tmpdir()).filter(n => n.startsWith('pair-check-')).sort();

test('#190: the real route table: /archive/search is 404 and the API routes serve the same bytes; fetchSite makes 13 GETs, all to the API for data', async () => {
  const { base } = await withServer();
  assert.equal((await fetch(`${base}/archive/search/core.json`)).status, 404, 'the premise: the archive is not a public URL');
  for (const [route, name] of Object.entries(DATA_ROUTES)) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(COMMITTED(name)), `${route} is byte-identical to ${name}`);
  }
  const seen = [], recording = (u, o) => { seen.push(new URL(u).pathname); return fetch(u, o); };
  const { dir, requests } = await fetchSite(base, recording);
  made.push(dir);
  assert.equal(requests, 13);
  assert.deepEqual(seen.filter(p => p.startsWith('/api/')), Object.keys(DATA_ROUTES));
  assert.ok(seen.every(p => p === '/' || p.startsWith('/search/') || p.startsWith('/api/v1/search/')), 'no /archive request: ' + seen.join());
  for (const [, name] of Object.entries(DATA_ROUTES)) assert.ok(readFileSync(join(dir, 'archive/search', name)).equals(COMMITTED(name)), name);
});

test('#190: today\'s URLs (/archive/search/*) fail on the real route table with HTTP 404 (the bug), and leave no folder', async () => {
  const { base } = await withServer();
  const before = tmpFolders();
  const old = (u, o) => fetch(String(u).replace('/api/v1/search/core', '/archive/search/core.json').replace('/api/v1/search/places', '/archive/search/places.json').replace('/api/v1/search/games/2021-22', '/archive/search/games-2021-22.json'), o);
  await assert.rejects(fetchSite(base, old), /HTTP 404/);
  assert.deepEqual(tmpFolders(), before);
});

test('#190: failures of a data route name the route and leave no folder: 429, HTML, a bad body, 404 (a fake fetch: the local server never limits)', async () => {
  const ok = body => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }), arrayBuffer: async () => Buffer.from(body) });
  const page = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => Buffer.from('<script src="/search/search.mjs">') };
  const make = bad => async url => {
    const p = new URL(url).pathname;
    if (p === '/') return page;
    if (p === '/api/v1/search/places') return bad(p);
    if (p.startsWith('/api/')) return ok('{}');
    return ok('x');
  };
  const before = tmpFolders();
  await assert.rejects(fetchSite('https://example.invalid/', make(() => ({ ok: false, status: 429, headers: new Headers() }))), /\/api\/v1\/search\/places: HTTP 429, rate limited: wait 60 s/);
  await assert.rejects(fetchSite('https://example.invalid/', make(() => page)), /\/api\/v1\/search\/places: content type "text\/html", not JSON/);
  await assert.rejects(fetchSite('https://example.invalid/', make(() => ok('<html>'))), /\/api\/v1\/search\/places: the body is not valid JSON/);
  await assert.rejects(fetchSite('https://example.invalid/', make(() => ({ ok: false, status: 404, headers: new Headers() }))), /\/api\/v1\/search\/places: HTTP 404/);
  assert.deepEqual(tmpFolders(), before, 'every failed run removed its own folder');
});

test('#190: the whole command line against the local server: --fetch, --short, 13 GETs, the served-bytes check, the cleanup, the labelled ok line', async () => {
  const { base } = await withServer();
  const before = tmpFolders();
  const r = spawnSync(process.execPath, ['--import', './tests/netguard/netguard.mjs', 'tools/search_pair_check.mjs', '--short', '--before-rev', 'HEAD', '--expect-rev', 'HEAD', '--fetch', base],
    { cwd: ROOT, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const summary = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{')));
  assert.equal(summary.requests, 13);
  assert.equal(summary.short, true);
  assert.equal(summary.queries, SHORT_QUERIES.length);
  assert.ok(r.stdout.split('\n').includes('ok (short list, local only): every rule holds'), 'the label is part of the line');
  assert.deepEqual(tmpFolders(), before, 'the run removed its own temp folders');
});

test('#190: --short is local only: a non-loopback host exits 2 before any request or folder; --short with --quick is refused; loopback is decided on the parsed host', () => {
  for (const site of ['https://example.invalid/', 'http://127.0.0.1.example.invalid/', 'http://localhost.example.invalid/', 'http://127.0.0.1@example.invalid/', 'not a url']) {
    assert.equal(isLoopback(site), false, site);
    const before = tmpFolders();
    const r = spawnSync(process.execPath, ['--import', './tests/netguard/netguard.mjs', 'tools/search_pair_check.mjs', '--short', '--before-rev', 'HEAD', '--expect-rev', 'HEAD', '--fetch', site], { cwd: ROOT, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 2, site + r.stderr);
    assert.match(r.stderr, /--short is for the local server; production runs the full set/);
    assert.ok(!r.stdout.includes('"queries"') && !r.stdout.includes('ok'), 'nothing ran');
    assert.deepEqual(tmpFolders(), before, 'no temp folder was made');
  }
  for (const site of ['http://127.0.0.1:8080/', 'http://localhost:3000/', 'http://[::1]:8000/']) assert.equal(isLoopback(site), true, site);
  assert.ok(parseArgs(['--short', '--quick', '--before-rev', 'HEAD']).error.startsWith('--short and --quick are exclusive'));
  assert.equal(parseArgs(['--short', '--before-rev', 'HEAD', '--expect-rev', 'HEAD', '--fetch', 'http://127.0.0.1:1/']).short, true);
  assert.equal(parseArgs(['--before-rev', 'HEAD', '--expect-rev', 'HEAD', '--fetch', 'https://example.invalid/']).site, 'https://example.invalid/', 'the full set may fetch from any host');
  assert.equal(parseArgs(['--short']).error, USAGE);
});

test('#190: SHORT_QUERIES keeps the three squad-2195 queries', () => {
  for (const q of ['Eagles SC ECNL GU17/U18 2021-22', 'Eagles SC U18 2021-22', 'Eagles SC 2004 2021-22']) assert.ok(SHORT_QUERIES.includes(q), q);
});

test('#173 check: --fetch without --expect-rev exits 2 with the usage line; served bytes that differ from the revision are reported', () => {
  const run = (...a) => spawnSync(process.execPath, ['--import', './tests/netguard/netguard.mjs', 'tools/search_pair_check.mjs', ...a], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const r = run('--before-rev', 'HEAD', '--fetch', 'https://example.invalid/');
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(USAGE), r.stderr);
  assert.equal(run('--fetch', 'https://example.invalid/', '--expect-rev', 'HEAD').status, 2, '--before-rev is required too');
  // the served directory is HEAD's own modules: no problem; one changed byte: that module is reported
  const dir = temp(); mkdirSync(join(dir, 'search'));
  for (const m of ['events', 'games', 'links', 'match', 'reader', 'search', 'slate', 'teams', 'vocab']) {
    const g = spawnSync('git', ['show', `HEAD:public/search/${m}.mjs`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
    assert.equal(g.status, 0, g.stderr);
    writeFileSync(join(dir, 'search', `${m}.mjs`), g.stdout);
  }
  assert.deepEqual(servedProblems(dir, 'HEAD'), []);
  writeFileSync(join(dir, 'search/reader.mjs'), readFileSync(join(dir, 'search/reader.mjs'), 'utf8') + '\n// changed\n');
  assert.deepEqual(servedProblems(dir, 'HEAD'), ["served reader.mjs is not HEAD's"]);
});

test('#173 check: the full query set holds the pair spellings, their keystrokes and the judged queries', () => {
  const core = JSON.parse(readFileSync(join(FX, 'core.json'), 'utf8'));
  const qs = new Set(queriesOf(core, ['MVLA 2011'], true));
  for (const q of ['GU17/U18 Southwest 2021-22', 'Eagles SC ECNL GU17/18 2021', 'Eagles SC ECNL GU17/U1', 'MVLA 2011', 'MVLA 201']) assert.ok(qs.has(q), q);
});
