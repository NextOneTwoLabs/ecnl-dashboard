// #173: the production check for the age-pair rule. It runs the search modules from before the change and the modules from the
// change on the SAME core.json, places.json and games file, offline, and asserts RULES (never live counts):
//   1. every query whose slate differs holds a parsed age pair (GU17/U18, u17/18, ...) and returns, after the change, a squad whose
//      season row is filed at the pair's SECOND age and whose own name spells that pair (the rule, not the name "Eagles": a later
//      refresh that adds another such row is caught by the data tripwire in tests/search-modules.test.mjs, not by this check);
//   2. nothing else differs: a conference-and-age table (no team named) is byte-identical, and so is every judged query;
//   3. squad 2195 is first for "Eagles SC ECNL GU17/U18 2021-22", and still first for "... U18 2021-22" and "... 2004 2021-22".
//
// Local (a dry run, no request at all):
//   node --import ./tests/netguard/netguard.mjs tools/search_pair_check.mjs --before-rev <parent commit> [--after public] [--quick]
// Production (13 GETs to our own site, cap 25, 0 to TGS; --expect-rev is the merge commit, whose modules the served bytes must equal):
//   node tools/search_pair_check.mjs --before-rev <merge parent> --expect-rev <merge commit> --fetch https://<site>
// --fetch needs --expect-rev: without it the served bytes would never be compared, so the run exits 2 with the usage line.
// The page (/) is only a wiring smoke test: its HTML must mention /search/; the modules themselves are compared byte for byte.
// Exit 0 when every rule holds, 1 otherwise, 2 for bad arguments.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULES = ['events', 'games', 'links', 'match', 'reader', 'search', 'slate', 'teams', 'vocab'];
const DATA = ['core.json', 'places.json', 'games-2021-22.json'];
export const REQUEST_CAP = 25;

const arg = (name, argv) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const git = (...a) => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };

// Download the 13 files the check needs: the page, the 9 modules and 3 data files. Returns { dir, requests }.
export async function fetchSite(base, fetchFn = fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-check-after-'));
  const wanted = [['/', null], ...MODULES.map(m => [`/search/${m}.mjs`, `search/${m}.mjs`]), ...DATA.map(d => [`/archive/search/${d}`, `archive/search/${d}`])];
  let requests = 0;
  try {
  for (const [path, out] of wanted) {
    if (requests >= REQUEST_CAP) throw new Error(`request cap ${REQUEST_CAP} reached`);
    requests++;
    const res = await fetchFn(new URL(path, base));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (out) { mkdirSync(join(dir, out, '..'), { recursive: true }); writeFileSync(join(dir, out), body); }
    else if (!body.toString('utf8').includes('/search/')) throw new Error('the page does not mention /search/');
  }
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { dir, requests };
}

// The "before" modules: the files of a git revision, next to the same data files.
function beforeDir(rev, dataDir) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-check-before-'));
  mkdirSync(join(dir, 'search'), { recursive: true });
  try { for (const m of MODULES) writeFileSync(join(dir, 'search', `${m}.mjs`), git('show', `${rev}:public/search/${m}.mjs`)); } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { dir, dataDir };
}

export const USAGE = 'usage: --before-rev <rev> [--after <dir containing search/ and archive/search/>] [--quick] | --before-rev <rev> --fetch <site> --expect-rev <rev>';
// The served modules against a git revision's files (line endings aside): -> a list of problems.
export function servedProblems(dir, rev) {
  const problems = [];
  for (const m of MODULES) if (readFileSync(join(dir, 'search', `${m}.mjs`), 'utf8').replace(/\r\n/g, '\n') !== git('show', `${rev}:public/search/${m}.mjs`).replace(/\r\n/g, '\n')) problems.push(`served ${m}.mjs is not ${rev}'s`);
  return problems;
}

const pairOf = text => { const m = /\bg?u-?(\d{1,2})\/u?(\d{1,2})\b/i.exec(text); return m ? [+m[1], +m[2]] : null; };

async function load(modDir, dataDir) {
  const S = await import(pathToFileURL(join(modDir, 'search', 'search.mjs')).href + `?d=${encodeURIComponent(modDir)}`);
  const j = n => JSON.parse(readFileSync(join(dataDir, 'archive', 'search', n), 'utf8'));
  const core = j('core.json'), ix = S.buildIndex({ core, places: j('places.json') });
  const g = S.startGames(ix, j('games-2021-22.json'), Infinity); while (!g.next().done);
  return { S, ix, core };
}

// The queries: every squad row's name alone and with its season, every pair spelling alone, with each season and with
// conferences, every keystroke prefix of a query that holds a pair, and the judged queries.
export function queriesOf(core, judged, quick) {
  const T = core.teams, qs = new Set(), pairs = new Set(['GU17/U18', 'gu17/u18', 'U17/U18', 'GU17/18', 'u17/18', 'GU18/U19', 'GU18/19', 'U18/U19', 'U16/U17', 'U17/U19']);
  for (const q of T.squads) for (const [s, , name] of q.s) {
    const p = /\bG?U-?\d{1,2}\/U?\d{1,2}\b/i.exec(name);
    if (p) pairs.add(p[0]);
    if (!quick || p) { qs.add(`${name} ${T.seasons[s]}`); qs.add(name); }
  }
  const confs = quick ? T.confs.filter(c => /Southwest|NorCal|Mid-Atlantic/.test(c)) : T.confs;
  for (const p of pairs) {
    qs.add(p);
    for (const s of T.seasons) { qs.add(`${p} ${s}`); for (const c of confs) qs.add(`${p} ${c} ${s}`); }
    for (const c of confs) qs.add(`${p} ${c}`);
    qs.add(`Eagles SC ECNL ${p} 2021-22`);
  }
  const pinned = ['Eagles SC ECNL GU17/U18 2021-22', 'Eagles SC U18 2021-22', 'Eagles SC 2004 2021-22', 'GU17/U18 Southwest 2021-22'];
  for (const q of pinned) qs.add(q);
  for (const q of judged) qs.add(q);
  const withPair = [...qs].filter(q => pairOf(q));
  for (const q of withPair) for (let i = 1; i < q.length; i++) qs.add(q.slice(0, i));
  for (const q of judged) for (let i = 1; i < q.length; i++) qs.add(q.slice(0, i));
  return [...qs];
}

const text = sl => JSON.stringify(sl, (k, v) => (v instanceof Map || v instanceof Set ? [...v] : v));

// -> { problems: [], summary }
export async function check({ afterDir, beforeModules, quick = false, queries = null, judgedPath = join(ROOT, 'tests/search/queries.json'), log = () => {} }) {
  const judgedDoc = JSON.parse(readFileSync(judgedPath, 'utf8'));
  const A = await load(afterDir, afterDir), B = await load(beforeModules.dir, afterDir);
  const ctx = { now: Date.parse(judgedDoc.context.now), timeZone: judgedDoc.context.timeZone, selectedSeason: judgedDoc.context.selectedSeason };
  ctx.today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now);
  const T = A.core.teams, byKey = new Map();
  for (const q of T.squads) byKey.set(`${T.seasons[q.s[0][0]]}/${q.s[0][1]}`, q);
  const judged = new Set(judgedDoc.queries.map(q => q.q));
  const qs = queries || queriesOf(A.core, [...judged], quick);   // an explicit list is for the tests; the real run uses the full set
  const problems = [], differing = [];
  const teamKeys = sl => ((sl.sections.find(s => s.name === 'teams') || { rows: [] }).rows).map(r => r.key);
  for (const q of qs) {
    const before = B.S.search(B.ix, q, ctx), after = A.S.search(A.ix, q, ctx);
    if (text(before) === text(after)) continue;
    differing.push(q);
    // rule 1: a parsed pair, and a returned squad with a row filed at the pair's second age whose own name spells it
    const p = pairOf(q);
    const second = k => p && (byKey.get(k) || { s: [] }).s.some(r => {
      const rp = pairOf(r[2]);
      return rp && rp[0] === p[0] && rp[1] === p[1] && T.divs[r[4]][2] === p[1];
    });
    const ok = p && teamKeys(after).some(second);
    if (!ok) problems.push(`rule 1: "${q}" differs without a parsed pair and a returned squad filed at its second age`);
    // and the difference is confined to those squads (they may join or move up): the other Teams rows are the same rows in the same order
    else if (JSON.stringify(teamKeys(after).filter(k => !second(k))) !== JSON.stringify(teamKeys(before).filter(k => !second(k)))) problems.push(`rule 1: "${q}" changes Teams rows other than the second-age squads`);
    if (judged.has(q)) problems.push(`rule 2: judged query "${q}" differs`);
  }
  // rule 2: a conference-and-age table, byte-identical (also covered above: any difference would be listed)
  for (const q of qs.filter(x => pairOf(x) && /Southwest|NorCal|Mid-Atlantic/.test(x) && !/eagles/i.test(x))) if (differing.includes(q)) problems.push(`rule 2: table "${q}" differs`);
  // rule 3: squad 2195
  const first = q => teamKeys(A.S.search(A.ix, q, ctx))[0];
  const own = ['2020-21/2195', '2021-22/2195'];
  for (const q of ['Eagles SC ECNL GU17/U18 2021-22', 'Eagles SC U18 2021-22', 'Eagles SC 2004 2021-22']) if (!own.includes(first(q))) problems.push(`rule 3: "${q}" has ${first(q)} first, not squad 2195`);
  return { problems, summary: { queries: qs.length, differing: differing.length, differingQueries: differing } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), quick = argv.includes('--quick');
  const beforeRev = arg('--before-rev', argv), site = arg('--fetch', argv), expectRev = arg('--expect-rev', argv);
  if (!beforeRev || (site && !expectRev)) { console.error(USAGE); process.exit(2); }
  const temp = [];
  let code = 0;
  try {
    let afterDir, requests = 0;
    const problems = [];
    if (site) {
      ({ dir: afterDir, requests } = await fetchSite(site));
      temp.push(afterDir);
      problems.push(...servedProblems(afterDir, expectRev));
    } else {
      afterDir = resolve(arg('--after', argv) || join(ROOT, 'public'));
    }
    const before = beforeDir(beforeRev, afterDir);
    temp.push(before.dir);
    const r = await check({ afterDir, beforeModules: before, quick });
    problems.push(...r.problems);
    console.log(JSON.stringify({ requests, ...r.summary, differingQueries: undefined }));
    for (const q of r.summary.differingQueries) console.log('differs:', JSON.stringify(q));
    if (problems.length) { console.error(problems.join('\n')); code = 1; } else console.log('ok: every rule holds');
  } finally {
    for (const d of temp) rmSync(d, { recursive: true, force: true });   // the temp folders are this run's own
  }
  process.exit(code);
}
