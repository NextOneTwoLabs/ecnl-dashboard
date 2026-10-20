// #173: tools/search_pair_check.mjs, the production check of the age-pair rule, on the frozen fixture, offline.
// Every test runs an explicit short query list (the real run uses the full set): the file takes seconds, not a minute.
// Run under the netguard: node --import ./tests/netguard/netguard.mjs --test tests/search-pair-check.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { check, fetchSite, queriesOf, servedProblems, REQUEST_CAP, USAGE } = await import(new URL('../tools/search_pair_check.mjs', import.meta.url));
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

const SPELLINGS = ['GU17/U18', 'gu17/u18', 'U17/U18', 'GU17/18', 'u17/18'];
const PINNED = 'Eagles SC ECNL GU17/U18 2021-22';
// about 20: the pinned queries, the 5 Eagles spellings (with and without the season), a Southwest table, a no-season query
const SHORT = [PINNED, 'Eagles SC U18 2021-22', 'Eagles SC 2004 2021-22', 'GU17/U18 Southwest 2021-22', 'Eagles SC ECNL GU17/U18',
  ...SPELLINGS.flatMap(p => [`Eagles SC ECNL ${p} 2021-22`, `Eagles SC ECNL ${p} 2021`]), 'U17/U18 Southwest 2021', 'GU17/U18 2021-22'];

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

test('#173 check: the production run is 13 GETs, under the cap of 25, and a failed GET stops it and leaves no folder', async () => {
  const seen = [], body = path => (path === '/' ? '<script src="/search/search.mjs">' : 'x');
  const fake = async url => { seen.push(url.pathname); return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body(url.pathname)) }; };
  const { dir, requests } = await fetchSite('https://example.invalid/', fake);
  made.push(dir);
  assert.equal(requests, 13);
  assert.equal(seen.length, 13);
  assert.ok(13 <= REQUEST_CAP && REQUEST_CAP === 25);
  assert.ok(seen.every(p => p === '/' || p.startsWith('/search/') || p.startsWith('/archive/search/')), 'our own site only');
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('pair-check-after-')).length;
  await assert.rejects(fetchSite('https://example.invalid/', async () => ({ ok: false, status: 503 })), /HTTP 503/);
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith('pair-check-after-')).length, before, 'the failed run removed its own folder');
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
