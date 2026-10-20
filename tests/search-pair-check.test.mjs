// #173: tools/search_pair_check.mjs, the production check of the age-pair rule, on the frozen fixture, offline.
// Run under the netguard: node --import ./tests/netguard/netguard.mjs --test tests/search-pair-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { check, fetchSite, queriesOf, REQUEST_CAP } = await import(new URL('../tools/search_pair_check.mjs', import.meta.url));
const FX = join(ROOT, 'tests/search/fixtures/search');
const AGE_OK = /export function ageOk\(row, r\) \{[\s\S]*?\n\}\n/;

// A site directory: the fixture's data and a copy of public/search/, optionally with ageOk replaced.
function site(ageOk) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-check-test-'));
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

test('#173 check: before-the-change modules vs the change, same files: only squads filed at their second age differ, and every rule holds', async () => {
  const after = site(null), before = site(FILED_ONLY);
  const r = await check({ afterDir: after, beforeModules: { dir: before }, quick: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.summary.differingQueries.includes('Eagles SC ECNL GU17/U18 2021-22'));
  assert.ok(r.summary.differingQueries.every(q => /eagles/i.test(q) && /u-?17\/u?18/i.test(q)), 'on the fixture, only Eagles pair queries differ');
  assert.equal(r.summary.differing, 10, 'fixture count: 5 pair spellings x (2021-22, 2021)');
});

test('#173 check: the check has teeth: an either-age rule (option A) is reported', async () => {
  const r = await check({ afterDir: site(EITHER_AGE), beforeModules: { dir: site(FILED_ONLY) }, quick: true });
  assert.ok(r.problems.some(p => p.startsWith('rule 1')), r.problems.join('\n'));
});

test('#173 check: the check has teeth: modules that never find squad 2195 first are reported', async () => {
  const same = site(FILED_ONLY);
  const r = await check({ afterDir: same, beforeModules: { dir: site(FILED_ONLY) }, quick: true });
  assert.ok(r.problems.some(p => p.startsWith('rule 3')), r.problems.join('\n'));
  assert.equal(r.summary.differing, 0);
});

test('#173 check: the production run is 13 GETs, under the cap of 25, and a failed GET stops it', async () => {
  const seen = [];
  const body = path => (path === '/' ? '<script src="/search/search.mjs">' : 'x');
  const fake = async url => { seen.push(url.pathname); return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body(url.pathname)) }; };
  const { requests } = await fetchSite('https://example.invalid/', fake);
  assert.equal(requests, 13);
  assert.equal(seen.length, 13);
  assert.ok(13 <= REQUEST_CAP && REQUEST_CAP === 25);
  assert.ok(seen.every(p => p === '/' || p.startsWith('/search/') || p.startsWith('/archive/search/')), 'our own site only');
  await assert.rejects(fetchSite('https://example.invalid/', async () => ({ ok: false, status: 503 })), /HTTP 503/);
});

test('#173 check: the query set holds the pair spellings, their keystrokes and the judged queries', () => {
  const core = JSON.parse(readFileSync(join(FX, 'core.json'), 'utf8'));
  const qs = new Set(queriesOf(core, ['MVLA 2011'], true));
  for (const q of ['GU17/U18 Southwest 2021-22', 'Eagles SC ECNL GU17/18 2021', 'Eagles SC ECNL GU17/U1', 'MVLA 2011', 'MVLA 201']) assert.ok(qs.has(q), q);
});
