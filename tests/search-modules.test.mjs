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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJSON, readLF, HERE, ROOT, FIXTURES, indexOf, destinationProblem, loadFixtures, loadGames, todayOf } from './search/judged.mjs';
import { CORE_SCHEMA as FORMAT_CORE, PLACES_SCHEMA as FORMAT_PLACES } from './search/search-data-format.mjs';

const MODULES = new URL('public/search/', ROOT);
const files = readdirSync(MODULES).sort();
const SEARCH_URL = new URL('search.mjs', MODULES);
const S = await import(SEARCH_URL);
const { osa, expand, TermList, Postings, CLASS } = await import(new URL('match.mjs', MODULES));
const { readQuery, READING_CAP } = await import(new URL('reader.mjs', MODULES));
const { ALIASES } = await import(new URL('vocab.mjs', MODULES));

const FX = new URL('search/', FIXTURES);
const coreText = readLF(new URL('core.json', FX)), placesText = readLF(new URL('places.json', FX));
const fresh = () => ({ core: JSON.parse(coreText), places: JSON.parse(placesText) });
// #168: as on the page, the active season's games are installed once the index is ready
const withGames = (ix, seasons = [ix.vocab.active]) => { for (const s of seasons) { const g = S.startGames(ix, loadGames(s), Infinity); while (!g.next().done); } return ix; };
const index = withGames(S.buildIndex(fresh()));
const doc = readJSON(new URL('queries.json', HERE));
const CTX = { now: Date.parse(doc.context.now), timeZone: doc.context.timeZone, selectedSeason: doc.context.selectedSeason, today: todayOf(Date.parse(doc.context.now), doc.context.timeZone) };
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

test('MF5, #165, #167, #168: search.mjs exports SEARCH_API 3 and exactly these names', () => {
  assert.equal(S.SEARCH_API, 3, 'PR 4b adds games (startGames, the Games section, context.today): the page expects 3');
  assert.deepEqual(Object.keys(S).sort(), ['CORE_SCHEMA', 'GAMES_SCHEMA', 'PLACES_SCHEMA', 'SEARCH_API', 'SearchDataError', 'buildIndex', 'completeGames', 'search', 'startGames', 'startIndex']);
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

test('context: now, timeZone, selectedSeason and (#168 MF7) today are required (the clock comes in, never read)', () => {
  assert.throws(() => S.search(index, 'mvla', { timeZone: 'UTC', selectedSeason: '2026-27', today: '2026-10-15' }), /context\.now/);
  assert.throws(() => S.search(index, 'mvla', { now: 0, selectedSeason: '2026-27', today: '2026-10-15' }), /timeZone/);
  assert.throws(() => S.search(index, 'mvla', { now: 0, timeZone: 'UTC', selectedSeason: '2026-27' }), /context\.today/);
  assert.throws(() => S.search(index, 'mvla', { ...CTX, today: '10/15/2026' }), /context\.today/);
});

test('clock: "today" is context.today (showcase 2025-26: the nearer showcase first); no Intl formatter in the modules', () => {
  const first = day => rows(run('showcase 2025-26', index, { ...CTX, today: day }), 'events')[0].eventID;
  assert.equal(first('2025-12-31'), 4041, 'San Diego Fall (2025-10-11) is nearer on 31 December');
  assert.equal(first('2026-03-01'), 4133, 'Phoenix Spring (2026-03-27) is nearer on 1 March');
  assert.equal(first('2026-03-01'), rows(run('showcase 2025-26', index, { ...CTX, now: 0, today: '2026-03-01' }), 'events')[0].eventID, 'now is not read for today');
  for (const f of files) assert.ok(!/\bIntl\b/.test(readLF(new URL(f, MODULES)).replace(/\/\/.*$/gm, '')), `${f} makes no Intl formatter (MF7)`);
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
  assert.equal(run('MVLA vs Mustang').gamesAsked, true);
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
// #164 review: a state beside a place narrows it (AND) and the reading stays place-only (MF1, MF2)
test('#164 MF1: an alias with its state keeps its places: LA CA finds every club LA finds in CA', () => {
  const inCA = new Set(clubsOf(run('LA')));      // every club LA finds is in California
  for (const q of ['LA CA', 'LA, CA', 'LA California']) {
    const got = new Set(clubsOf(run(q)));
    for (const c of inCA) assert.ok(got.has(c), `${q}: club ${c}`);
    assert.ok(!got.has(1760), q);
  }
  assert.deepEqual([...inCA].sort((a, b) => a - b), [16, 82, 2289]);
});
test('#164 MF2: Redmond WA and Redmond Washington read as P03 (D2), never Washington Premier', () => {
  for (const q of ['Redmond WA', 'Redmond Washington']) {
    const s = run(q);
    assert.equal(s.rule, 4, q);
    assert.deepEqual(s.sections.map(x => x.name), ['events', 'games', 'teams'], q);   // #168 MF4: fields in Redmond, no 2026-27 games: between
    assert.ok(rows(s, 'teams').every(r => r.nearby && r.current), q);
    assert.ok(!clubsOf(s).includes(112), q);
  }
});
test('#164 MF2: Phoenix AZ keeps D12; Chula Vista CA and Del Mar CA keep their place order', () => {
  const p = rows(run('Phoenix AZ'), 'teams');
  for (const c of [592, 3716, 1141]) assert.ok(p.slice(0, 8).some(r => r.clubID === c), `Phoenix AZ: ${c} in the first 8`);
  assert.ok(p.every(r => r.current));
  const cv = run('Chula Vista CA');
  assert.equal(cv.rule, 4); assert.equal(rows(cv, 'teams')[0].clubID, 300);
  const dm = run('Del Mar CA');
  assert.equal(dm.rule, 4); assert.equal(rows(dm, 'teams')[0].clubID, 39);
  assert.deepEqual(dm.sections.map(x => x.name), ['teams', 'events', 'games']);
});
test('#164 MF4: richmond keeps its name reading (always): an older name with Richmond is found', () => {
  const d = fresh(), t = d.core.teams;
  const sq = t.squads.find(x => t.clubs[x.c][0] === 3054 && x.s.length >= 2 && t.seasons[x.s[x.s.length - 1][0]] === d.core.activeSeason);
  sq.s[0][2] = 'Richmond Strikers ECNL G11';            // an earlier name only; Placer United stays in Rocklin, CA
  const idx = S.buildIndex(d);
  const hit = rows(run('Richmond', idx), 'teams').filter(r => r.clubID === 3054);
  assert.equal(hit.length, 1);
  assert.notEqual(hit[0].nearby, true);
  assert.equal(rows(run('Richmond'), 'teams').some(r => r.clubID === 3054), false, 'and not without the planted name');
});
test('#164 nit 1: a prefix or typo that lands on an alias never matches city text (D8 while typing)', () => {
  const idx = planted('0660620', '06013', 'Richmond, CA');
  for (const q of ['Richmon', 'Richmnd', 'Richmond']) assert.ok(!clubsOf(run(q, idx)).includes(3054), q);
});
test('#164 nit 2: only a word with no other role is "another name word" for la (LA Utah)', () => {
  assert.ok(!clubsOf(run('LA Utah')).includes(1760));
});
test('#164 nit 3: past 256 combinations every word is still read, and the cap is reported', () => {
  const s = run('phoenix texas richmond redmond sacramento dallas houston seattle denver zzzqx');
  assert.equal(s.capReached, true);
  assert.equal(s.sections.filter(x => !x.partialOnly).length, 0, 'zzzqx matches nothing, so nothing matches every word');
});
test('#164 nit 6: deviations 6 and 9 have behavioural tests', () => {
  // deviation 6: a team row is as specific as the most specific reading it matched
  assert.equal(rows(run('midwest united'), 'teams')[0].filterWords, 1);
  // deviation 9: a state code is never a plain name word (ca would prefix-match Carolina)
  assert.ok(!clubsOf(run('Surf CA')).includes(3644));
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
  assert.deepEqual([run('U15 NorCal').rule, order('U15 NorCal')], [1, ['events', 'teams', 'games']]);
  assert.deepEqual([run('playoffs 2025-26').rule, order('playoffs 2025-26')], [2, ['events']]);
  assert.deepEqual([run('MVLA 2011 vs Mustang 2011').rule, order('MVLA 2011 vs Mustang 2011')], [3, ['games', 'teams']]);
  assert.deepEqual([run('San Diego').rule, order('San Diego')], [4, ['teams', 'events', 'games']]);
  assert.deepEqual([run('Slammers').rule, order('Slammers')], [5, ['teams', 'games']]);
});
test('slate: D2 across sections: a section with results in the place itself first (Redmond)', () => {
  const s = run('Redmond');
  assert.deepEqual(s.sections.map(x => x.name), ['events', 'games', 'teams'], 'P03: Redmond\'s fields (no 2026-27 games) between the events in Redmond and the nearby teams (MF4)');
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
  assert.deepEqual(f.sections.map(x => x.name), ['games'], 'a games-only reading: the field, and no partial Surf teams');
  assert.equal(f.empty, null);
  assert.ok(f.sections[0].rows.every(r => !r.partial));
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
test('slate (#168): coverage names each season a query needs and its state; an empty query is "no match" only when nothing is pending', () => {
  const cov = (q, ix = index, ctx = CTX) => run(q, ix, ctx).coverage.map(c => [c.category, c.season, c.state]);
  for (const q of ['Slammers', 'Surf Sports Park', 'MVLA vs Mustang']) assert.deepEqual(cov(q), [['games', '2026-27', 'ready']], q);
  assert.deepEqual(cov('zzzz'), [['games', '2026-27', 'ready']]);
  assert.equal(run('zzzz').empty.reason, 'no-match');
  assert.equal(run('qwerty asdf').empty.reason, 'no-match');
  // an explicit season not loaded yet: the page loads it by itself (not-loaded), then the states it passes
  assert.deepEqual(cov('Slammers vs Blues 2023-24'), [['games', '2023-24', 'not-loaded']]);
  for (const [k, st] of [['gamesLoading', 'loading'], ['gamesMissing', 'missing'], ['gamesFailed', 'failed']]) assert.deepEqual(cov('Slammers vs Blues 2023-24', index, { ...CTX, [k]: ['2023-24'] }), [['games', '2023-24', st]], k);
  // a games-only query whose season is pending is never "no match"
  const bare = withGames(S.buildIndex(fresh()), []);
  assert.equal(run('Surf Sports Park', bare, { ...CTX, gamesLoading: ['2026-27'] }).sections[0].name, 'games', 'the field row comes from places.json');
  assert.equal(run('10/17', bare, { ...CTX, gamesLoading: ['2026-27'] }).empty.reason, 'games-loading');
  assert.equal(run('10/17', bare, CTX).empty.reason, 'games-loading', 'not loaded yet is pending too');
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
// #165 refit: sortCompares (the comparator calls of the two sorts) joins rowsSorted, because a sort costs
// comparisons, not rows (the worst keystroke, `so`, sorts 506 rows in 3,697 counted comparisons). Fitted on the
// committed fixture, 15 repeats of every keystroke, trimmed mean, three fits averaged.
// #168 refit: gamesVisited (every game a games search looks at) joins them at 300 ns, fitted the same way on the
// time the other weights leave unexplained (305 ns; a fit of every weight at once gives 299). teamSearches is
// counted, not weighed: a team search's own work is in docsScored and the rest.
const WEIGHTS = { base: 28000, termsVisited: 55, osaCells: 210, postingsVisited: 125, docsScored: 620, rowsSorted: 1150, sortCompares: 160, gamesVisited: 300, teamSearches: 0 };
const cost = s => WEIGHTS.base + Object.entries(s).reduce((n, [k, v]) => n + WEIGHTS[k] * v, 0);
const CEILING_NS = 16e6 / 15;            // 16 ms on a 4x-throttled phone / 15 (cold-to-cold calibration, plan v2 MF6)
// Recorded by this PR. A change to the work done changes these numbers: re-measure and explain.
// #168: was max 1,620,690 and p95 412,600; games add their own team search and the games it touches (so: 4,029,315).
// #167 (MF3): a name reading's games come from the Teams search already made, never a second one: max 4,029,315 ->
// 2,509,890, p95 807,305 -> 552,325 (the Games rows are unchanged: tests/search-games.test.mjs, teamsReuse: false).
const RECORDED = { keystrokes: 807, max: 2509890, maxAt: 'so', p95: 552325 };
// The worst keystroke may not grow past twice its recorded cost; the 95th percentile must stay under
// the phone ceiling. (The worst, a two-letter prefix matching ~500 squads, is over that ceiling:
// reported on #163, and measured on a throttled browser after merge, Q12.)
const KEYSTROKE_BUDGET = 2 * RECORDED.max;
function replay(idx = index) {
  const out = [];
  for (const q of doc.queries) for (let i = 1; i <= q.q.length; i++) {
    const p = q.q.slice(0, i);
    const stats = { termsVisited: 0, osaCells: 0, postingsVisited: 0, docsScored: 0, rowsSorted: 0, sortCompares: 0, gamesVisited: 0, teamSearches: 0 };
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
// Contention (node --test runs files in parallel) only ever adds time, so each figure is the fastest
// of 3: a keystroke's own repeats, and 3 fresh processes for the cold build (#164). Uncounted work,
// such as a quadratic sort, slows every repeat and still trips the ceiling.
// The child prints one tagged JSON line; only that line is read, because other output can share
// stdout (the netguard's exit report under NETGUARD_REPORT=1, as in CI: #164). A child that fails or
// prints no such line fails the test with its exit code and output, never a NaN.
const COLD_TAG = 'SEARCH_COLD_BUILD ';
export function parseColdBuild(r) {
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith(COLD_TAG));
  let ms = NaN;
  try { ms = line ? JSON.parse(line.slice(COLD_TAG.length)).ms : NaN; } catch { ms = NaN; }
  if (r.status !== 0 || !Number.isFinite(ms)) {
    throw new Error(`cold build child: exit ${r.status}, no ${COLD_TAG.trim()} line\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return ms;
}
// #167 (review of #170, MF1): the child times its main thread's CPU (process.threadCpuUsage), not the wall clock.
// Other processes on a busy runner add wall time, never this thread's CPU; a real regression (an eager scan, a
// quadratic sort, a second pass) adds both, so it is still caught. A child without the API fails, never skips.
function coldBuildMs() {
  const src = `if (typeof process.threadCpuUsage !== 'function') throw new Error('process.threadCpuUsage is missing');
    const c0 = process.threadCpuUsage(); const S = await import(${JSON.stringify(SEARCH_URL.href)});
    const { readFileSync } = await import('node:fs');
    const j = n => JSON.parse(readFileSync(new URL(n, ${JSON.stringify(FX.href)}), 'utf8'));
    S.buildIndex({ core: j('core.json'), places: j('places.json') });
    const c = process.threadCpuUsage(c0);
    process.stdout.write(${JSON.stringify(COLD_TAG)} + JSON.stringify({ ms: (c.user + c.system) / 1000 }) + '\\n');`;
  return parseColdBuild(spawnSync(process.execPath, ['--import', './tests/netguard/netguard.mjs', '--input-type=module', '-e', src],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8', env: process.env }));
}
test('budget: the cold-build child is read by its tagged line, and a broken child fails readably', () => {
  assert.equal(parseColdBuild({ status: 0, stdout: `${COLD_TAG}{"ms":71.5}\nnetguard: 0 attempts (pid 1)\n`, stderr: '' }), 71.5);
  assert.throws(() => parseColdBuild({ status: 1, stdout: '', stderr: 'SyntaxError: boom' }), /exit 1[\s\S]*SyntaxError: boom/);
  assert.throws(() => parseColdBuild({ status: 0, stdout: '71.5netguard: 0 attempts\n', stderr: '' }), /no SEARCH_COLD_BUILD line/);
});
test('budget: backstop: no keystroke over 20 ms (wall clock), no cold build over 200 ms of main-thread CPU', () => {
  assert.equal(typeof process.threadCpuUsage, 'function', 'process.threadCpuUsage (Node 22) is required: the backstop never skips');
  replay();                                  // warm
  const runs = [replay(), replay(), replay()];
  const fastest = runs[0].map((x, i) => ({ p: x.p, ms: Math.min(...runs.map(r => r[i].ms)) }));
  const worst = fastest.reduce((m, x) => (x.ms > m.ms ? x : m));
  assert.ok(worst.ms < 20, `${worst.p}: ${worst.ms.toFixed(2)} ms (fastest of 3)`);
  const cold = Math.min(coldBuildMs(), coldBuildMs(), coldBuildMs());
  assert.ok(cold < 200, `cold import and build ${cold.toFixed(1)} ms of main-thread CPU (fastest of 3 fresh processes)`);
  const s = index.stats;
  assert.ok(s.terms <= 2 * 518 && s.postings <= 2 * 11531, JSON.stringify(s));
});

// ---------- #165 (PR 4a): the staged build, the sort counter and the row fields ----------
const DATA = fresh();
const drained = (n, d = fresh()) => { const g = S.startIndex(d, n); const labels = []; let r; while (!(r = g.next()).done) labels.push(r.value); return { index: r.value, labels }; };
// A row in full: its own fields and every getter of its class (a TeamRow's links, `why`, `line`, `matched`,
// `continuesAs`, `mayFrom` ...), so a difference in any of them shows (Reviewer point 8).
export function dump(row) {
  const out = { ...row };
  for (let p = Object.getPrototypeOf(row); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) if (d.get && !(k in out)) out[k] = row[k];
  }
  return out;
}
const slateText = sl => JSON.stringify({ rule: sl.rule, empty: sl.empty, coverage: sl.coverage, ended: sl.ended, capReached: sl.capReached,
  best: sl.best && dump(sl.best), enter: sl.enter && dump(sl.enter), sections: sl.sections.map(x => ({ ...x, rows: x.rows.map(dump) })) });
test('#165: dump() reads the getters, so a difference in line, matched or continuesAs shows', () => {
  const r = rows(run('pateadors'), 'teams').find(x => x.continuesAs.length);
  const d = dump(r);
  for (const k of ['hrefs', 'why', 'line', 'matched', 'continuesAs', 'mayFrom', 'family', 'seasonTyped', 'place', 'last', 'namedPlace', 'nearbyOf', 'overviewHref', 'seasonHref']) assert.ok(k in d, k);
  const a = JSON.stringify(d);
  assert.notEqual(a, JSON.stringify({ ...d, line: 'x' }));
});
test('#165: startIndex drained at n = 1, 7, 50 and 150 gives the same slates as buildIndex over every judged keystroke, rows in full', () => {
  const want = [];
  for (const q of doc.queries) for (let i = 1; i <= q.q.length; i++) want.push([q.q.slice(0, i), slateText(run(q.q.slice(0, i)))]);
  assert.equal(want.length, RECORDED.keystrokes);
  for (const n of [1, 7, 50, 150]) {
    const ix = withGames(drained(n).index);
    assert.deepEqual(ix.stats, index.stats, `n = ${n}`);
    for (const [p, w] of want) if (slateText(run(p, ix)) !== w) assert.fail(`n = ${n}: "${p}" differs`);
  }
});
test('#165: the staged build gives the same index structure as buildIndex (vocabulary, postings, counts, lookups, known)', () => {
  const a = withGames(drained(50).index), b = index;   // both with the games (and so the field names' phrases)
  assert.deepEqual([...a.known].sort(), [...b.known].sort());
  assert.deepEqual(a.vocab.phrases.map(p => [p.type, p.value, p.words.join(' ')]), b.vocab.phrases.map(p => [p.type, p.value, p.words.join(' ')]));
  for (const c of ['teams', 'events']) {
    assert.deepEqual([...a[c].post.post], [...b[c].post.post], c);
    assert.deepEqual(a[c].post.avg, b[c].post.avg, c);
  }
  for (const k of ['place', 'county', 'state', 'caps', 'conf']) assert.deepEqual([...a.teams.lookups[k]], [...b.teams.lookups[k]], k);
  for (const k of ['conf', 'season', 'u', 'born']) assert.deepEqual([...a.teams.counts[k]], [...b.teams.counts[k]], k);
});
test('#165: each step does at most n units: the yields per stage follow n, and the step count is pinned', () => {
  const one = drained(1).labels, hist = l => l.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
  const h1 = hist(one);
  for (const n of [7, 50, 150]) {
    const hn = hist(drained(n).labels);
    assert.deepEqual(Object.keys(hn).sort(), Object.keys(h1).sort(), `n = ${n}: the same stages`);
    for (const [stage, c1] of Object.entries(h1)) {
      assert.ok(Math.abs(hn[stage] - c1 / n) <= 6,   // a stage has up to 5 loops, each losing at most one yield to rounding
         `n = ${n} ${stage}: ${hn[stage]} yields for ${c1} at n = 1`);
    }
  }
  assert.equal(drained(50).labels.length, STEPS_50, 'the step count at n = 50 changed: re-measure, record and explain');
  assert.equal(drained(150).labels.length, STEPS_150);
  assert.equal(drained(50).labels.at(-1), 'events', 'events are the last step: teams are never ready without them');
  assert.equal(drained(50).labels.filter(l => l === 'events').length, 1);
});
// yields before the last step, on the frozen fixture: 460 and 158 before #168. The field names' phrases add
// vocab:fields: 944 fields, then the 147 clubs, families and aliases no squad row names (every squad-row name is
// checked as teamDocsG reads it, review of #170 MF1), then one last step: 482 and 166 (596 and 205 at 3c3ba1b3).
const STEPS_50 = 482, STEPS_150 = 166;
test('#165 (Reviewer point 2): an unknown schema throws SearchDataError from the first next(), not from startIndex()', () => {
  const a = fresh(); a.core.schema = 3;
  const g = S.startIndex(a);
  assert.throws(() => g.next(), e => e instanceof S.SearchDataError && e.file === 'core.json');
  const b = fresh(); b.places.schema = 9;
  assert.throws(() => S.startIndex(b).next(), e => e instanceof S.SearchDataError && e.file === 'places.json');
  assert.throws(() => S.startIndex(null).next(), S.SearchDataError);
});
test('#165: the vocabulary order needs no ICU collator: code-unit order equals localeCompare order, on both data sets', async () => {
  const committed = { core: JSON.parse(readLF(new URL('public/archive/search/core.json', ROOT))), places: JSON.parse(readLF(new URL('public/archive/search/places.json', ROOT))) };
  for (const [name, d] of [['fixture', fresh()], ['committed', committed]]) {
    const ix = S.buildIndex(d), ph = ix.vocab.phrases;
    const ROLE = { conf: 0, state: 1, place: 2, county: 3, field: 4 };
    const old = [...ph].sort((a, b) => b.words.length - a.words.length || ROLE[a.type] - ROLE[b.type] || a.words.join(' ').localeCompare(b.words.join(' ')));
    assert.deepEqual(ph.map(p => p.value + '|' + p.type), old.map(p => p.value + '|' + p.type), `${name}: the phrase order`);
    for (const p of ph) {
      assert.match(p.words.join(' '), /^[a-z0-9 ]+$/, `${name}: a phrase key outside [a-z0-9 ]`);
      if (p.places) {
        assert.deepEqual(p.places, [...p.places].sort((a, b) => a.localeCompare(b)), `${name}: ${p.value}`);
        for (const g of p.places) assert.match(g, /^\d{7}$/);
      }
    }
    assert.ok(ph.length > 800, `${name}: ${ph.length} phrases`);
  }
});
test('#165: no module calls localeCompare while the index is built (the first call starts the ICU collator, 6-9 ms)', () => {
  const calls = [], orig = String.prototype.localeCompare;
  String.prototype.localeCompare = function (...a) { calls.push(String(this)); return orig.apply(this, a); };
  try { drained(50); } finally { String.prototype.localeCompare = orig; }
  assert.deepEqual(calls.slice(0, 3), [], 'localeCompare in the build');
});
test('#165: sortCompares counts the comparator calls of both sorts, and stays out of the way without stats', () => {
  const real = Array.prototype.sort; let calls = 0;
  Array.prototype.sort = function (cmp) { return real.call(this, cmp ? (a, b) => { calls++; return cmp(a, b); } : cmp); };
  const stats = { termsVisited: 0, osaCells: 0, postingsVisited: 0, docsScored: 0, rowsSorted: 0, sortCompares: 0 };
  try { S.search(index, 'so', CTX, { stats }); } finally { Array.prototype.sort = real; }
  assert.ok(stats.sortCompares > 1000, `so: ${stats.sortCompares} comparisons`);
  // the two result sorts are counted; the small candidate-set sorts are not (they are linear in the postings, which are counted)
  assert.ok(stats.sortCompares <= calls && stats.sortCompares >= calls * 0.5 && stats.sortCompares > stats.rowsSorted, `counted ${stats.sortCompares} of ${calls} comparator calls for ${stats.rowsSorted} rows`);
  assert.deepEqual(S.search(index, 'so', CTX).sections.map(x => x.total), S.search(index, 'so', CTX, { stats: { ...stats, sortCompares: 0 } }).sections.map(x => x.total));
});
test('#165: a quadratic sort now fails the pinned work count, not only the wall clock', () => {
  // the comparator is called about n^2/4 times by an insertion sort; the pinned cost must notice
  const real = Array.prototype.sort;
  Array.prototype.sort = function (cmp) { if (!cmp) return real.call(this); for (let i = 1; i < this.length; i++) for (let j = i; j > 0 && cmp(this[j - 1], this[j]) > 0; j--) [this[j - 1], this[j]] = [this[j], this[j - 1]]; return this; };
  let base, bad;
  try {
    const st = { termsVisited: 0, osaCells: 0, postingsVisited: 0, docsScored: 0, rowsSorted: 0, sortCompares: 0 };
    S.search(index, 'so', CTX, { stats: st }); bad = cost(st);
  } finally { Array.prototype.sort = real; }
  const st = { termsVisited: 0, osaCells: 0, postingsVisited: 0, docsScored: 0, rowsSorted: 0, sortCompares: 0 };
  S.search(index, 'so', CTX, { stats: st }); base = cost(st);
  assert.ok(bad > 5 * base, `quadratic ${bad} vs ${base}`);
  assert.ok(bad > KEYSTROKE_BUDGET, 'over the pinned budget');
});
test('#165 MF7: team rows carry the structured fields the page draws from (family, line, matched, nearbyOf, namedPlace, seasonTyped, mayFrom ...)', () => {
  const pda = rows(run('PDA'), 'teams');
  assert.ok(pda.length && pda.every(r => r.family && r.family.name === 'PDA' && r.family.main === 2357), 'a reviewed family (#133)');
  assert.equal(rows(run('Slammers'), 'teams')[0].family, null);
  const lines = new Set(rows(run('Slammers'), 'teams').map(r => r.line));
  assert.ok(lines.has('SLAMMERS FC') && lines.has('Slammers FC HB Koge'), [...lines].join('|'));
  const sting = rows(run('Sting Black'), 'teams');
  assert.ok(sting.some(r => r.line === 'Sting Royal' && r.matched.some(m => m.field === 'older name' && m.term === 'black')), 'an older name is reported as one');
  assert.ok(sting[0].matched.every(m => m.field === 'name' && m.cls === 'exact'));
  assert.deepEqual([...new Set(sting.filter(r => r.line === 'Sting Royal').map(r => r.was))].sort(), ['Sting Black', 'Sting Dallas Black'], 'an older-name match says which name (Reviewer point 6)');
  assert.ok(sting.filter(r => r.matched.every(m => m.field !== 'older name')).every(r => r.was === null));
  const pat = rows(run('pateadors'), 'teams');
  assert.ok(pat.every(r => r.matched.some(m => m.cls === 'typo' && m.term === 'pateadores')), 'the typo word is the matched term');
  const succ = pat.find(r => r.mayFrom.length), pred = pat.find(r => r.continuesAs.length);
  assert.ok(succ && pred && pred.continuesAs.includes(succ.key) && pat.some(r => r.mayFrom.includes(pred.key)), '#107 keys, both directions');
  assert.ok(pat.every(r => r.place === 'Costa Mesa, CA' && /^\d{4}-\d{2}$/.test(r.last)));
  const dated = rows(run('pateadores 2022-23'), 'teams');
  assert.ok(dated.length && dated.every(r => r.seasonTyped === true && r.href === r.seasonHref), 'a season in the query opens the season tab');
  assert.ok(rows(run('Slammers'), 'teams').every(r => r.seasonTyped === false));
  const sd = run('San Diego');
  assert.deepEqual(rows(sd, 'teams')[0].namedPlace, ['san', 'diego']);
  assert.equal(rows(sd, 'teams')[0].nearbyOf, null);
  const near = rows(run('Redmond WA'), 'teams').find(r => r.nearby);
  assert.equal(near.nearbyOf, 'Redmond, WA');
  assert.equal(near.namedPlace, null);
  assert.ok(rows(run('Redmond WA'), 'teams').filter(r => !r.nearby).every(r => r.nearbyOf === null));
});
test('#165 MF7: event rows carry matched, namedPlace, nearbyOf and the kind (the tier reason, the Nearby sub-heading)', () => {
  const cup = rows(run('Surf Cup'), 'events');
  assert.ok(cup.length && cup.every(r => r.partial && r.matched.length && r.matched.every(m => m.field === 'tier' && m.term === 'cup')), 'a partial event row that matched only a tier name');
  assert.ok(rows(run('Surf Cup'), 'teams').every(r => r.partial && r.matched.every(m => m.field !== 'tier')));
  const sd = rows(run('San Diego'), 'events');
  assert.deepEqual(sd.find(r => r.title === 'San Diego Fall').namedPlace, ['san', 'diego']);
  assert.equal(sd.find(r => r.nearby).nearbyOf, 'San Diego, CA');
  assert.deepEqual([...new Set(rows(run('southwest'), 'events').map(r => r.ekind))], ['c']);
  assert.ok(rows(run('playoffs'), 'events').some(r => r.ekind === 'n') && rows(run('San Diego'), 'events').some(r => r.ekind === 's'));
});
test('#148, #165 nit 1: an age-less conference row carries every chip\'s link, one per age group; a row with an age keeps one', () => {
  const sw = rows(run('southwest'), 'events');
  assert.equal(sw.length, 7);
  for (const r of sw) {
    assert.equal(r.div, '');
    assert.deepEqual(r.hrefs, r.ages.map(a => `#season=${r.season}&age=${encodeURIComponent(a)}&conf=Southwest&view=standings`), r.season);
    assert.equal(r.href, r.hrefs[0], 'href stays the first chip (the oldest age group)');
  }
  assert.deepEqual(sw[1].ages, ['G2008/2007', 'G2009', 'G2010', 'G2011', 'G2012', 'G2013'], '2025-26 names its divisions by birth year');
  const nc = rows(run('U15 NorCal'), 'events');
  assert.equal(nc.length, 1);
  assert.deepEqual(nc[0].hrefs, ['#season=2026-27&age=GU15&conf=NorCal&view=standings']);
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
