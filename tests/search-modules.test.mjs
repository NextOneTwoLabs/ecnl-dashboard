// #163 (#149 phase 1, PR 3): the page's search modules, public/search/*.mjs, imported directly.
// The judged set (tests/search-judged.test.mjs) measures what they find; this file pins how:
//   - purity (no page globals, storage, network or clock), the API version and the schemas;
//   - the reader's rules, the alias table (D3, D8, MF7), the cap of 4 readings;
//   - matching and BM25F scoring (Fix 1, refinement A, one contribution per word);
//   - the slate: section order, partial matches, best match, coverage, empty reasons;
//   - the per-keystroke budget (work counts, pinned) and its wall-clock backstop;
//   - serving: /search/*.mjs are static assets, and the CI test list is complete.
// Run under the netguard: node --import ./tests/netguard/netguard.mjs --test tests/search-modules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readJSON, readLF, HERE, ROOT, FIXTURES, indexOf, destinationProblem, loadFixtures } from './search/judged.mjs';
import { CORE_SCHEMA as FORMAT_CORE, PLACES_SCHEMA as FORMAT_PLACES } from './search/search-data-format.mjs';

const MODULES = new URL('public/search/', ROOT);
const files = readdirSync(MODULES).sort();
const SEARCH_URL = new URL('search.mjs', MODULES);
const coldStart = performance.now();
const S = await import(SEARCH_URL);
const { osa, expand, TermList, Postings, CLASS } = await import(new URL('match.mjs', MODULES));
const { readQuery, READING_CAP } = await import(new URL('reader.mjs', MODULES));
const { ALIASES } = await import(new URL('vocab.mjs', MODULES));

const FX = new URL('search/', FIXTURES);
const coreText = readLF(new URL('core.json', FX)), placesText = readLF(new URL('places.json', FX));
const fresh = () => ({ core: JSON.parse(coreText), places: JSON.parse(placesText) });
const index = S.buildIndex(fresh());
const COLD_BUILD_MS = performance.now() - coldStart;
const doc = readJSON(new URL('queries.json', HERE));
const CTX = { now: Date.parse(doc.context.now), timeZone: doc.context.timeZone, selectedSeason: doc.context.selectedSeason };
const run = (q, idx = index, ctx = CTX, opts) => S.search(idx, q, ctx, opts);
const rows = (slate, name) => (slate.sections.find(s => s.name === name) || { rows: [] }).rows;
const clubsOf = (slate, name = 'teams') => rows(slate, name).map(r => r.clubID);

// ---------- purity, API, schemas ----------
// Comments are stripped first; word boundaries keep "teamDocs" or "one document" from tripping it.
export function impurities(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const banned = [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/,
    /\bDate\.now\b/, /new\s+Date\s*\(\s*\)/, /\bMath\.random\b/, /\bimport\s*\(/, /\bnavigator\b/, /\bglobalThis\b/];
  const out = banned.filter(re => re.test(code)).map(String);
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) if (!/^\.\/[a-z]+\.mjs$/.test(m[1])) out.push(`import ${m[1]}`);
  return out;
}

test('purity: no module reads page globals, storage, the network, the clock or randomness', () => {
  assert.ok(files.length >= 8);
  for (const f of files) assert.deepEqual(impurities(readLF(new URL(f, MODULES))), [], f);
  // the scan has teeth, and ignores comments and longer words
  assert.deepEqual(impurities('// window.x\nconst teamDocs = 1; /* document */'), []);
  assert.ok(impurities('const x = window.x;').length);
  assert.ok(impurities('const t = new Date();').length);
  assert.ok(impurities("import { x } from 'node:fs';").length);
});

test('modules: every file is an .mjs module, and every relative import resolves to one of them', () => {
  assert.deepEqual(files.filter(f => !f.endsWith('.mjs')), []);
  for (const f of files) for (const m of readLF(new URL(f, MODULES)).matchAll(/\bfrom\s+'\.\/([a-z]+\.mjs)'/g)) assert.ok(files.includes(m[1]), `${f} imports ${m[1]}`);
});

test('MF5: search.mjs exports SEARCH_API 1 and exactly these names', () => {
  assert.equal(S.SEARCH_API, 1);
  assert.deepEqual(Object.keys(S).sort(), ['CORE_SCHEMA', 'PLACES_SCHEMA', 'SEARCH_API', 'SearchDataError', 'buildIndex', 'search']);
});

test('schemas: an unknown core or places schema throws SearchDataError naming the file; constants agree', () => {
  const a = fresh(); a.core.schema = 3;
  assert.throws(() => S.buildIndex(a), e => e instanceof S.SearchDataError && e.file === 'core.json');
  const b = fresh(); b.places.schema = 2;
  assert.throws(() => S.buildIndex(b), e => e instanceof S.SearchDataError && e.file === 'places.json');
  const py = readLF(new URL('search_data.py', ROOT));
  const val = n => +new RegExp(`^${n} = (\\d+)`, 'm').exec(py)[1];
  assert.deepEqual([S.CORE_SCHEMA, S.PLACES_SCHEMA], [val('SCHEMA'), val('PLACES_SCHEMA')]);
  assert.deepEqual([S.CORE_SCHEMA, S.PLACES_SCHEMA], [FORMAT_CORE, FORMAT_PLACES]);
});

test('context: now, timeZone and selectedSeason are required (the clock comes in, never read)', () => {
  assert.throws(() => S.search(index, 'mvla', { timeZone: 'UTC', selectedSeason: '2026-27' }), /context\.now/);
  assert.throws(() => S.search(index, 'mvla', { now: 0, selectedSeason: '2026-27' }), /timeZone/);
});

test('clock: "today" comes from context.now (showcase 2025-26: the nearer showcase first)', () => {
  const first = iso => rows(run('showcase 2025-26', index, { ...CTX, now: Date.parse(iso) }), 'events')[0].eventID;
  assert.equal(first('2025-12-31T20:00:00Z'), 4041, 'San Diego Fall (2025-10-11) is nearer on 31 December');
  assert.equal(first('2026-03-01T20:00:00Z'), 4133, 'Phoenix Spring (2026-03-27) is nearer on 1 March');
});

// ---------- the reader ----------
const R = q => readQuery(index.vocab, q);
const keys = (q, c = 'teams') => R(q).sides[0][c].map(r => r.key);

test('reader: a bare year is two seasons, and a birth year inside the catalog range (R4)', () => {
  assert.deepEqual(R('2026 playoffs').sides[0].events.map(r => r.seasons), [['2025-26', '2026-27']]);
  const t = R('MVLA 2011').sides[0].teams;
  assert.ok(t.some(r => r.born.includes(2011)), 'a birth year reading');
  assert.ok(t.some(r => r.seasons && r.seasons.length === 0), 'the season reading finds no season (2010-11, 2011-12)');
  assert.ok(!R('2020 finals').sides[0].teams.some(r => r.born.includes(2020)), '2020 is outside 2002-2014');
});

test('reader: seasons, age groups and their hard filters (R3, R6)', () => {
  assert.deepEqual(run('U15 NorCal 2030-31').empty.reason, 'season-not-in-archive');
  assert.deepEqual(run('playoffs 2019-20').empty.reason, 'season-not-in-archive');
  assert.deepEqual(run('U12 NorCal').empty.reason, 'no-such-age-group');
  assert.deepEqual(rows(run('U15 NorCal 2024-25'), 'events').map(r => `${r.season}/${r.div}`), ['2024-25/G2010']);
});

test('reader: texas is a conference and a state; NorCal has an alias (R7, R8)', () => {
  const k = keys('texas');
  assert.ok(k.includes('state:TX') && k.includes('name:texas'), k.join(' '));
  assert.ok(keys('texas', 'events').includes('conf:Texas'));
  assert.ok(keys('northern california', 'events').includes('conf:NorCal'));
  assert.equal(rows(run('southwest'), 'teams').length, 0, 'a conference alone lists no teams');
});

test('reader: census places keep every place of a name; counties; the county fallback (R9, R10)', () => {
  const placesOf = q => R(q).sides[0].teams.flatMap(r => (r.places || []).flatMap(p => p.places));
  assert.deepEqual([...new Set(placesOf('Jacksonville'))].sort(), ['1235000', '3734200']);
  assert.deepEqual([...new Set(placesOf('Aurora'))].sort(), ['0804000', '1703012']);
  const sac = R('Sacramento').sides[0].teams.flatMap(r => r.places || []);
  assert.deepEqual(sac.map(p => p.counties), [['06067']], 'Sacramento has no census place: Sacramento County');
  assert.ok(R('Orange County').sides[0].teams.some(r => (r.places || []).some(p => p.type === 'county')));
});

test('reader: field complexes and dates are games readings; surf alone is not (R14, R15)', () => {
  assert.equal(R('Surf Sports Park').sides[0].field, true);
  assert.equal(R('surf').sides[0].field, false);
  assert.equal(R('Great Park field 15').sides[0].tokens.fieldNumber, 15);
  assert.equal(R('MVLA 2026-10-17').sides[0].dates, true);
});

test('reader: vs, v and @ split two sides; a season on one side applies to both (R2)', () => {
  for (const q of ['MVLA vs Mustang', 'MVLA v Mustang', 'Mustang @ MVLA']) assert.equal(R(q).vs, true, q);
  const s = R('Slammers vs Blues 2023-24').sides;
  assert.deepEqual(s.map(x => x.tokens.seasons), [['2023-24'], ['2023-24']]);
  assert.equal(run('MVLA vs Mustang').coverage[0].asked, true);
});

test('reader: the cap of 4 readings per category is reported', () => {
  const r = R('texas phoenix richmond 2011 orange');
  assert.equal(r.capReached, true);
  assert.ok(r.sides[0].teams.length <= READING_CAP);
  assert.equal(R('MVLA 2011').capReached, false);
});

// ---------- the alias table (MF2, MF7) ----------
test('alias table: every entry says when its name reading is built, with evidence', () => {
  assert.deepEqual(Object.keys(ALIASES).sort(), ['la', 'richmond']);
  for (const [k, a] of Object.entries(ALIASES)) {
    assert.ok(['always', 'with-other-name-word'].includes(a.nameWord), k);
    assert.match(a.evidence, /D3|D8/, k);
  }
});

test('MF7: La Roca finds La Roca FC first as a full match; LA alone never shows it (D3)', () => {
  for (const q of ['La Roca', 'la roca fc']) {
    const s = run(q), first = rows(s, 'teams')[0];
    assert.equal(first.clubID, 1760, q); assert.equal(first.current, true, q);
    assert.notEqual(first.partial, true, q); assert.equal(s.empty, null, q);
  }
  for (const q of ['LA', 'LA 2011']) assert.ok(!clubsOf(run(q)).includes(1760), q);
  const la = rows(run('LA'), 'teams')[0];
  assert.deepEqual([la.clubID, la.current], [2289, true]);
  const lb = run('LA Breakers');
  assert.deepEqual([rows(lb, 'teams')[0].clubID, rows(lb, 'teams')[0].current], [2289, true]);
  assert.ok(!clubsOf(lb).includes(1760));
  assert.equal(rows(run('Richmond'), 'teams')[0].clubID, 417, 'richmond keeps its name reading (always)');
});

// Planted clubs on a copy of the fixture: D3 and D8 hold by rule, not by today's data.
function planted(place, county, cityState, placeRow, countyRow) {
  const d = fresh();
  const club = d.core.teams.clubs.find(c => c[0] === 3054);      // Placer United, Rocklin, CA
  club[3] = cityState;
  d.places.clubPlaces['3054'] = [place, county];
  if (placeRow) d.places.places[place] = placeRow;
  if (countyRow) d.places.counties[county] = countyRow;
  return S.buildIndex(d);
}
test('MF2: a club planted in Louisiana never appears for LA or Los Angeles (D3)', () => {
  const idx = planted('2270000', '22017', 'Shreveport, LA', ['Shreveport', 'LA', '22017'], ['Caddo County', 'LA']);
  for (const q of ['LA', 'Los Angeles']) assert.ok(!clubsOf(run(q, idx)).includes(3054), q);
  assert.ok(clubsOf(run('Shreveport', idx)).includes(3054), 'the planted club is findable by its own city');
});
test('MF2: a club planted in Richmond, CA never appears for Richmond, but does for Richmond CA (D8)', () => {
  const idx = planted('0660620', '06013', 'Richmond, CA');
  assert.ok(!clubsOf(run('Richmond', idx)).includes(3054));
  assert.ok(!clubsOf(run('Richmond', idx)).includes(69), 'no Contra Costa club is nearby either');
  assert.ok(clubsOf(run('Richmond CA', idx)).includes(3054));
  assert.ok(!clubsOf(run('Richmond CA', idx)).includes(417), 'the state narrows name matches too');
});
test('Q6: a county fallback keeps the name reading (Placer finds Placer United directly)', () => {
  const first = rows(run('Placer'), 'teams')[0];
  assert.equal(first.clubID, 3054); assert.notEqual(first.nearby, true);
});

// ---------- matching and scoring ----------
test('match: osa counts a swap as one edit and stops past the bound', () => {
  assert.equal(osa('sruf', 'surf', 1), 1);
  assert.equal(osa('mlva', 'mvla', 1), 1);
  assert.equal(osa('slamers', 'slammers', 1), 1);
  assert.equal(osa('abcdef', 'uvwxyz', 1), 2);
});

test('match: prefix on the last word at any length, other words from 3 letters; typo bounds', () => {
  const terms = new TermList(['mvla', 'mustang', 'slammers', 'pateadores', 'surf', 'abc']);
  const ex = (w, last) => expand(w, { terms, last });
  assert.ok(ex('mv', true).has('mvla')); assert.ok(!ex('mv', false).has('mvla'));
  assert.ok(ex('mus', false).has('mustang'));
  assert.equal(ex('slamers', false).get('slammers').cls, 'typo');
  assert.ok(ex('pateadors', false).has('pateadores'), '2 edits allowed from 8 letters');
  assert.ok(!ex('abd', false).has('abc'), 'no typo under 4 letters');
  assert.ok(!ex('sur1', false).has('surf'), 'letters only');
  assert.equal(CLASS.exact, 1); assert.equal(CLASS.prefix, 0.7); assert.equal(CLASS.typo, 0.4);
});

test('Fix 1: initials match exactly or by prefix, never by typo (sruf is not South Carolina United)', () => {
  const s = run('sruf');
  assert.ok(!clubsOf(s).includes(1689) && !clubsOf(s).includes(91));
  assert.ok(clubsOf(run('UFA')).includes(3407), 'United Futbol Academy by its initials');
});

test('refinement A: a known word is not also a typo (southwest never lists Southeast or Northwest)', () => {
  const ev = rows(run('southwest'), 'events');
  assert.ok(ev.length && ev.every(r => r.conf === 'Southwest'), ev.map(r => r.conf).join());
  const terms = new TermList(['southwest', 'southeast', 'northwest']);
  assert.ok(!expand('southwest', { terms, known: new Set(['southwest']) }).has('southeast'));
  assert.ok(expand('southwest', { terms }).has('southeast'), 'without the rule it would');
});

// A small synthetic core for the scoring tests.
function synthetic(squads, clubs = [[1, 'Foo Club', null, 'Town, CA'], [2, 'Bar Club', null, 'Town, CA']]) {
  const seasons = ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
  return S.buildIndex({
    core: { schema: 2, build: 'x', directoryBuild: 'y', activeSeason: '2025-26', seasons, birthYears: [2008, 2014],
      vocab: { confAliases: {}, states: { CA: 'California' } }, events: {},
      teams: { seasons, confs: ['Alpha'], divs: seasons.map((s, i) => [i, `GU${14 + i}`, 14 + i, [2011]]), events: [], tiers: [], clubs, families: [], squads } },
    places: { schema: 1, build: 'p', census: 'c', vocab: { fieldAliases: {} }, counties: {}, places: {}, clubPlaces: {}, eventPlaces: {}, fields: {} },
  });
}
test('MF3: a squad with 6 seasons of one name does not outscore a new squad of that name', () => {
  const idx = synthetic([
    { b: [2011], c: 1, s: [0, 1, 2, 3, 4, 5].map(i => [i, 100, 'Foo FC G11', 0, i, 1, 8]) },
    { b: [2011], c: 1, s: [[5, 200, 'Foo FC G11', 0, 5, 2, 8]] },
  ]);
  const r = rows(run('Foo', idx, { ...CTX, selectedSeason: '2025-26' }), 'teams');
  assert.equal(r.length, 2);
  assert.equal(r[0].score, r[1].score);
});
test('MF3: a word in two fields saturates once (below twice, above once)', () => {
  const P = new Postings([{ name: 'name', w: 1 }, { name: 'club', w: 0.9 }], [
    { fields: [['foo'], ['foo']] }, { fields: [['foo'], ['bar']] }, { fields: [['baz'], ['qux']] }]);
  const e = new Map([['foo', { cls: 'exact', m: 1 }]]);
  const both = P.wordScore(0, e).s, one = P.wordScore(1, e).s;
  assert.ok(both > one && both < 2 * one, `${both} vs ${one}`);
});
test('MF3: a typo of a rare word outranks a typo of a common one (Fix 2, rarity)', () => {
  const docs = [{ fields: [['rare']] }, ...Array.from({ length: 20 }, () => ({ fields: [['common']] }))];
  const P = new Postings([{ name: 'name', w: 1 }], docs);
  const t = new Map([['rare', { cls: 'typo', m: 0.4 }], ['common', { cls: 'typo', m: 0.4 }]]);
  assert.ok(P.wordScore(0, t).s > P.wordScore(1, t).s);
});
test('MF3 (d), D13: the squad named Sting Black now outranks one named so only earlier', () => {
  const r = rows(run('Sting Black'), 'teams').map(x => x.teamRows);
  const pos = id => r.findIndex(t => t.some(k => k.endsWith(`/${id}`)));
  assert.ok(pos(116000) >= 0 && pos(116000) < pos(59609));
});

// ---------- the slate ----------
test('slate: the section-order rows (design table), first match wins', () => {
  const order = q => run(q).sections.map(s => s.name);
  assert.deepEqual([run('U15 NorCal').rule, order('U15 NorCal')], [1, ['events', 'teams']]);
  assert.deepEqual([run('playoffs 2025-26').rule, order('playoffs 2025-26')], [2, ['events']]);
  assert.deepEqual([run('MVLA 2011 vs Mustang 2011').rule, order('MVLA 2011 vs Mustang 2011')], [3, ['teams']]);
  assert.deepEqual([run('San Diego').rule, order('San Diego')], [4, ['teams', 'events']]);
  assert.deepEqual([run('Slammers').rule, order('Slammers')], [5, ['teams']]);
});
test('slate: D2 across sections: a section with results in the place itself first (Redmond)', () => {
  const s = run('Redmond');
  assert.deepEqual(s.sections.map(x => x.name), ['events', 'teams']);
  assert.ok(rows(s, 'teams').every(r => r.nearby));
});
test('slate: partial rows only when nothing matches fully and every reading is indexed (D4)', () => {
  const w = run('Surf Cup');
  assert.equal(w.empty.reason, 'no-full-match');
  assert.ok(w.sections.every(x => x.partialOnly));
  assert.ok([3986, 87, 2246, 737, 57, 64, 3644].includes(w.enter.clubID), 'a Surf club opens first (surf is rarer than cup)');
  assert.ok(!rows(w, 'events').some(r => r.eventID === 4041));
  assert.equal(w.best, null, 'a partial row is never the best match');
  const f = run('Surf Sports Park');
  assert.deepEqual(f.sections, [], 'a games-only reading: no partial Surf teams');
  assert.equal(f.empty.reason, 'games-not-indexed');
});
test('MF4: the partial order is rarity, not luck: make cup rarer than surf and events lead', () => {
  const d = fresh(), t = d.core.teams;
  const cup = new Set(t.tiers.map((x, i) => (/\bcup\b/i.test(x) ? i : -1)).filter(i => i >= 0));
  const keep = t.events.findIndex(e => e[3] === 4251);
  for (const sq of t.squads) if (sq.e) sq.e = sq.e.filter(([, ev, tier]) => !cup.has(tier) || ev === keep);
  const s = run('Surf Cup', S.buildIndex(d));
  assert.equal(s.sections[0].name, 'events');
  assert.equal(s.enter.eventID, 4251);
});
test('slate: games are always reported as not indexed, never as empty', () => {
  for (const q of ['Slammers', 'zzzz', 'Surf Sports Park', 'MVLA vs Mustang']) assert.deepEqual(run(q).coverage.map(c => [c.category, c.state]), [['games', 'not-indexed']], q);
  assert.equal(run('zzzz').empty.reason, 'no-match');
  assert.equal(run('qwerty asdf').empty.reason, 'no-match');
});
test('slate: a best match is an exact first row, never ahead of a section that also starts exactly', () => {
  assert.equal(run('San Diego Fall').best.eventID, 4041);
  assert.equal(run('texas').best, null, 'teams based in Texas and the Texas conference both start exactly');
  assert.equal(run('texas').enter.section, 'teams');
});
test('slate: every link of every row of the judged queries opens a real page', () => {
  const fx = loadFixtures(), ix = indexOf(fx.directory, fx.sources);
  let n = 0;
  for (const q of doc.queries) for (const s of run(q.q).sections) for (const r of s.rows) for (const h of r.hrefs) { n++; assert.equal(destinationProblem(h, ix), null, `${q.id} ${h}`); }
  assert.ok(n > 500, `${n} links checked`);
});

// ---------- the per-keystroke budget (plan v2 section 6, MF6) ----------
// Work counts are deterministic: every judged query is typed one character at a time and each
// keystroke's counters are weighed in estimated nanoseconds (weights fitted on the PR's machine,
// Intel Xeon 2.10 GHz, Node 22: a least-squares fit of the time per keystroke against the counters).
const WEIGHTS = { base: 30000, termsVisited: 70, osaCells: 320, postingsVisited: 160, docsScored: 980, rowsSorted: 2850 };
const cost = s => WEIGHTS.base + Object.entries(s).reduce((n, [k, v]) => n + WEIGHTS[k] * v, 0);
const CEILING_NS = 16e6 / 15;            // 16 ms on a 4x-throttled phone / 15 (cold-to-cold calibration, plan v2 MF6)
// Recorded by this PR. A change to the work done changes these numbers: re-measure and explain.
const RECORDED = { keystrokes: 807, max: 2115570, maxAt: 'so', p95: 598660 };
// The worst keystroke may not grow past twice its recorded cost; the 95th percentile must stay under
// the phone ceiling. (The worst, a two-letter prefix matching ~500 squads, is over that ceiling:
// reported on #163, and measured on a throttled browser after merge, Q12.)
const KEYSTROKE_BUDGET = 2 * RECORDED.max;
function replay(idx = index) {
  const out = [];
  for (const q of doc.queries) for (let i = 1; i <= q.q.length; i++) {
    const p = q.q.slice(0, i);
    const stats = { termsVisited: 0, osaCells: 0, postingsVisited: 0, docsScored: 0, rowsSorted: 0 };
    const t = performance.now();
    S.search(idx, p, CTX, { stats });
    out.push({ p, cost: cost(stats), ms: performance.now() - t, stats });
  }
  return out;
}
test('budget: the work per keystroke is pinned, its 95th percentile is under the phone ceiling', () => {
  const r = replay(), costs = r.map(x => x.cost).sort((a, b) => a - b);
  const max = r.reduce((m, x) => (x.cost > m.cost ? x : m));
  const p95 = costs[Math.floor(costs.length * 0.95)];
  assert.deepEqual({ keystrokes: r.length, max: max.cost, maxAt: max.p, p95 }, RECORDED, 'the work changed: re-measure, record and explain');
  assert.ok(p95 <= CEILING_NS, `p95 ${p95} ns-equivalent over ${CEILING_NS}`);
  assert.ok(max.cost <= KEYSTROKE_BUDGET);
});
test('budget: wall clock backstop: no keystroke over 20 ms, no cold build over 200 ms', () => {
  replay();                                  // warm
  const r = replay();
  const worst = r.reduce((m, x) => (x.ms > m.ms ? x : m));
  assert.ok(worst.ms < 20, `${worst.p}: ${worst.ms.toFixed(2)} ms`);
  assert.ok(COLD_BUILD_MS < 200, `cold import and build ${COLD_BUILD_MS.toFixed(1)} ms`);
  const s = index.stats;
  assert.ok(s.terms <= 2 * 518 && s.postings <= 2 * 11531, JSON.stringify(s));
});

// ---------- serving and CI ----------
test('serving: /search/*.mjs are static assets: no run_worker_first pattern matches them', () => {
  const toml = readLF(new URL('wrangler.toml', ROOT));
  const pats = JSON.parse(/run_worker_first\s*=\s*(\[[^\]]*\])/.exec(toml)[1]);
  const hit = path => pats.some(p => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));
  for (const f of files) assert.equal(hit(`/search/${f}`), false, f);
  assert.equal(hit('/archive/x.json'), true, 'the check has teeth');
  assert.equal(hit('/api/v1/search/core'), true);
});
test('CI: the Node test lists in api-tests.yml and the README equal tests/*.test.mjs', () => {
  const all = readdirSync(new URL('tests/', ROOT)).filter(n => n.endsWith('.test.mjs')).map(n => `tests/${n}`).sort();
  const list = text => [...new Set((/--test ([^\n]*?)(?:\s+#|\n|$)/.exec(text) || [])[1].split(/\s+/).filter(x => x.endsWith('.test.mjs')))].sort();
  assert.deepEqual(list(readLF(new URL('.github/workflows/api-tests.yml', ROOT))), all);
  assert.deepEqual(list(readLF(new URL('README.md', ROOT))), all);
});
