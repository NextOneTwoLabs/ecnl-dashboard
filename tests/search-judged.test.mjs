// #149 phase 1, PR 1 (#156): the judged query set, run on frozen fixtures against today's search,
// whose outcome is the recorded baseline (tests/search/baseline/today.json). See tests/search/.
//
// What fails here: an invalid query file, a ref that does not resolve, a fixture whose checksum
// (over LF text) differs from MANIFEST, a logo in a fixture, the vendored search drifting from
// index.html (or its markers vanishing while MANIFEST.retired is unset), today's outcome
// differing from the baseline, an engine seeing the machine clock or time zone, a closed-season
// fact that differs in the live archive, and the measures' own unit tests. What does not fail:
// judgements today's search gets wrong or cannot answer. They are the baseline's recorded facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HERE, ROOT, FIXTURES, FIXTURE_FILES, IMAGE, lf, sha, readLF, readJSON, stable, loadFixtures, indexOf, checkSchema, resolveProblems,
  todayAdapter, todayRow, canaryRun, makeClock, driftStatus, slicesOf, vendoredText, vendoredSlices, engineSha, runAll, baselineOf,
  evaluate, summarise, destinationProblem, seasonFacts, liveGame, GROUPS,
  modulesAdapter, modulesRow, modulesBaselineOf, modulesSha,
} from './search/judged.mjs';

const doc = readJSON(new URL('queries.json', HERE));
const fx = loadFixtures();
const ix = indexOf(fx.directory, fx.sources);
const VENDORED = readLF(new URL('engines/today.js', HERE));
const BASELINE = readJSON(new URL('baseline/today.json', HERE));
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- fixtures ----------
test('fixtures: each file\'s LF checksum and size match MANIFEST', () => {
  for (const f of FIXTURE_FILES) {
    const text = readLF(new URL(f, FIXTURES));
    assert.equal(sha(text), fx.manifest.files[f].sha256, `${f} checksum`);
    assert.equal(Buffer.byteLength(text), fx.manifest.files[f].bytes, `${f} bytes`);
  }
  assert.equal(fx.manifest.refreshUpdatedAt, doc.context.now, 'context.now is the frozen refresh time');
  assert.equal(fx.manifest.activeSeason, doc.context.selectedSeason);
  assert.equal(ix.active, doc.context.selectedSeason);
});

test('MF4: a CRLF copy of every checked file hashes the same as the LF original', () => {
  const files = [...FIXTURE_FILES.map(f => new URL(f, FIXTURES)), new URL('queries.json', HERE), new URL('engines/today.js', HERE), new URL('baseline/today.json', HERE)];
  for (const url of files) {
    const text = readLF(url), crlf = text.replace(/\n/g, '\r\n');
    assert.notEqual(crlf, text);
    assert.equal(sha(crlf), sha(text), url.pathname);
  }
  assert.notEqual(sha('a\nb'), sha('a\nc'), 'the checksum still sees content');
});

test('#117: no fixture holds a logo or an image URL', () => {
  for (const f of [...FIXTURE_FILES, 'MANIFEST.json']) assert.doesNotMatch(readLF(new URL(f, FIXTURES)), IMAGE, f);
  assert.ok(fx.directory.clubs.every(c => c[2] === null), 'club logos are dropped from the directory fixture');
  assert.match('https://s3.amazonaws.com/images.totalglobalsports.com/PlayerForm/x.png', IMAGE, 'the pattern catches a logo');
});

// ---------- the query file ----------
test('queries.json: the schema holds (60 queries, nine groups, MF10, D11)', () => {
  assert.deepEqual(checkSchema(doc, ix), []);
  assert.deepEqual(doc.groups, GROUPS);
  assert.ok(doc.queries.length >= 55 && doc.queries.length <= 70);
});

test('queries.json: the schema check catches what it must', () => {
  const bad = clone(doc);
  bad.queries[1].id = bad.queries[0].id;                                                // duplicate id
  const live = bad.queries.find(q => q.stability === 'live'); live.top = { teams: [] }; live.exact = true;   // exact on a live query
  const t01 = bad.queries.find(q => q.q === 'MVLA 2011');
  t01.mustNever = [{ team: { season: '2024-25', teamID: 55325 } }];                     // D11: G2011/12 covers 2011 in 2026-27
  t01.q = 'MVLA 2011G';                                                                  // the 2011G form is a birth year too (nit 6)
  bad.queries.find(q => q.id === 'N05').mustShow = [{ gizmo: 1 }];                     // unknown ref kind
  const errs = checkSchema(bad, ix).join('\n');
  assert.match(errs, /duplicate id/);
  assert.match(errs, /live query may carry only/);
  assert.match(errs, /55325 shares the 2026-27 division GU15 with 2011 \(D11\)/);
  assert.match(errs, /unknown ref/);
});

test('every ref resolves in the fixtures; county judgements are consistent (D2)', () => {
  assert.deepEqual(resolveProblems(doc, fx), []);
  const bad = clone(doc);
  bad.queries[0].mustShow = [{ team: { season: '2023-24', teamID: 55478 } }];
  bad.queries.find(q => q.id === 'P01').mustShow = [{ club: { clubID: 1425 }, current: true, nearby: true }];   // Davis is in Yolo County
  bad.queries.find(q => q.id === 'H03').cites.push({ game: 1 });
  const p = resolveProblems(bad, fx).join('\n');
  assert.match(p, /55478.*no such team/);
  assert.match(p, /club 1425 \(Davis\) is not elsewhere in Sacramento County/);
  assert.match(p, /"game":1}: game not in games-judged/);
});

// ---------- the vendored copy of today's search (D9, MF7) ----------
test('MF7: the vendored search equals index.html\'s slices (LF), and its checksum is in MANIFEST', () => {
  const html = readFileSync(new URL('public/index.html', ROOT), 'utf8');
  const st = driftStatus(html, VENDORED, fx.manifest);
  assert.ok(st.ok, st.message);
  assert.equal(st.retired, false);
  assert.equal(engineSha(vendoredSlices(VENDORED)), fx.manifest.engineSha);
  assert.ok(driftStatus(html.replace(/\n/g, '\r\n'), VENDORED, fx.manifest).ok, 'line endings never count as drift');
});

test('MF7: drift and retirement are never silent', () => {
  const html = lf(readFileSync(new URL('public/index.html', ROOT), 'utf8'));
  const m = clone(fx.manifest);
  const edited = html.replace('const NOISE = new Set([', 'const NOISE = new Set([\'xyz\', ');
  assert.match(driftStatus(edited, VENDORED, m).message, /differs from tests\/search\/engines\/today\.js/);
  const renamed = html.replace('    let usDb = null, usItems = []', '    let usDatabase = null, usItems = []');
  assert.match(driftStatus(renamed, VENDORED, m).message, /no longer holds the legacy search markers/, 'a renamed marker fails, never skips');
  assert.equal(driftStatus(renamed, VENDORED, { ...m, retired: { pr: '#999', reason: 'PR 5 removed the legacy search' } }).ok, true, 'explicit retirement');
  assert.match(driftStatus(html, VENDORED, { ...m, retired: { pr: '#999', reason: 'x' } }).message, /still holds the legacy search/);
  assert.match(driftStatus(renamed, VENDORED, { ...m, retired: true }).message, /must be \{ pr, reason \}/);
  const s = slicesOf(html);
  assert.equal(vendoredText(s), VENDORED, 'the vendored file is exactly what --vendor writes');
});

// ---------- the clock (MF6) ----------
const withTZ = (tz, f) => { const old = process.env.TZ; process.env.TZ = tz; try { return f(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } };

test('MF6: the clock canary sees the frozen time and time zone, never the machine\'s', () => {
  const c = canaryRun(doc.context);
  assert.equal(c.now, Date.parse(doc.context.now));
  assert.equal(c.iso, new Date(doc.context.now).toISOString());
  assert.equal(c.tz, doc.context.timeZone);
  // 2026-10-15T22:10:33Z is 15:10:33 on Thursday 15 October in Los Angeles (PDT, UTC-7).
  assert.deepEqual([c.y, c.m, c.day, c.wd, c.h, c.min, c.offset], [2026, 9, 15, 4, 15, 10, 420]);
  // Some ICU versions put U+202F (narrow no-break space) before AM/PM (nit 5).
  assert.equal(c.local.replace(/\u202f/g, ' '), '10/15/2026, 3:10:33 PM');
  // Without the frozen clock the canary reads the machine: the test can fail.
  const real = canaryRun(doc.context, { frozen: false });
  assert.notEqual(real.now, c.now, 'an unfrozen canary sees the machine clock');
});

test('MF6: the canary and the whole set give the same outcome under TZ=UTC and TZ=Pacific/Kiritimati', () => {
  const run = () => ({ canary: canaryRun(doc.context), set: runAll(doc, todayAdapter(fx, doc.context), fx).perQuery });
  const a = withTZ('UTC', run), b = withTZ('Pacific/Kiritimati', run);
  assert.deepEqual(a, b);
  // The switch is real in this process: an unfrozen Date's hour differs by 14 between the two.
  const h = tz => withTZ(tz, () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).getHours());
  assert.equal((h('Pacific/Kiritimati') - h('UTC') + 24) % 24, 14, 'TZ switching works here, so the equality above means something');
  const unfrozen = tz => withTZ(tz, () => canaryRun(doc.context, { frozen: false }).h);
  assert.notEqual(unfrozen('UTC'), unfrozen('Pacific/Kiritimati'));
});

test('MF6: makeClock rejects a context with no valid time', () => {
  assert.throws(() => makeClock({ now: 'soon', timeZone: 'UTC' }), /not a date/);
});

// ---------- the baseline ----------
test('today\'s search on the fixtures equals the recorded baseline, query by query', () => {
  const now = baselineOf(doc, todayAdapter(fx, doc.context), fx);
  const hint = ' (re-record with: node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --record today, and explain the diff in the PR)';
  assert.deepEqual(Object.keys(now.perQuery).sort(), Object.keys(BASELINE.perQuery).sort(), 'the same queries' + hint);
  for (const id of Object.keys(now.perQuery)) assert.deepEqual(JSON.parse(stable(now.perQuery[id])), BASELINE.perQuery[id], id + hint);
  assert.deepEqual(JSON.parse(stable(now.header)), BASELINE.header, 'header (engine, fixtures, queries, context)' + hint);
  assert.deepEqual(JSON.parse(stable(now.summary)), BASELINE.summary, 'summary' + hint);
});

test('today\'s links all open a real page (wrong destination = 0)', () => {
  assert.equal(BASELINE.summary.overall.wrongDestinations, 0);
  assert.equal(destinationProblem('#tab=teams&season=2026-27&team=55477&name=MVLA%20ECNL%20G2010%2F11', ix), null);
  assert.match(destinationProblem('#tab=teams&season=2026-27&team=55477&name=Wrong', ix), /name/);
  assert.match(destinationProblem('#tab=teams&season=2019-20&team=55477', ix), /unknown season/);
  assert.equal(destinationProblem('#season=2026-27&age=GU15&conf=NorCal&view=standings', ix), null);
  assert.match(destinationProblem('#season=2026-27&age=GU12&conf=NorCal&view=standings', ix), /no age group/);
  assert.equal(destinationProblem('#tab=playoffs&season=2025-26&stage=Playoffs%20%26%20Finals', ix), null);
  assert.match(destinationProblem('#tab=playoffs&season=2025-26&stage=Finals', ix), /no stage/);
  assert.equal(destinationProblem('#tab=showcases&season=2025-26&event=4041', ix), null);
  assert.match(destinationProblem('#tab=showcases&season=2025-26&event=4251', ix), /no showcase/);
});

test('nit 2: the today adapter fails loudly on a result kind it does not know', () => {
  assert.throws(() => todayRow({ kind: 'mystery' }), /unknown result kind/);
  assert.throws(() => todayRow({ kind: 'competition', key: 'league/2026-27/x' }), /unknown competition key/);
  assert.deepEqual(todayRow({ kind: 'competition', key: 'conference/2025-26/NorCal/G2008/2007', href: '#h' }),
    { section: 'events', kind: 'conference', season: '2025-26', conf: 'NorCal', div: 'G2008/2007', hrefs: ['#h'] });
});

// ---------- the measures, on hand-built outcomes ----------
const team = (key, extra = {}) => ({ section: 'teams', kind: 'team', teamRows: [key], clubID: 294, born: [2011], current: true, hrefs: [], ...extra });
const event = (season, eventID) => ({ section: 'events', kind: 'event', season, eventID, hrefs: [] });
const outcome = (...sections) => ({ sections: sections.filter(s => s.rows.length), enter: sections.find(s => s.rows.length)?.rows[0] || null, capReached: null });
const caps = { capabilities: { sections: ['teams', 'events'], kinds: ['team', 'club', 'conference', 'event'], labels: [] } };
const capsAll = { capabilities: { sections: ['teams', 'events', 'games'], kinds: ['team', 'club', 'conference', 'event', 'game', 'field', 'h2h', 'pairing'], labels: ['partial', 'nearby'] } };
const T = (season, teamID) => ({ team: { season, teamID } });

test('measures: first useful result, reciprocal rank, exact top and section order', () => {
  const q = { id: 'X01', group: 'team-names', q: 'x', stability: 'frozen', sections: ['teams', 'games'], useful: [T('2023-24', 55477)],
    top: { teams: [T('2023-24', 55477)] }, exact: true, mustShow: [T('2023-24', 55477)] };
  const first = outcome({ name: 'teams', rows: [team('2023-24/55477'), team('2024-25/55325')] });
  const third = outcome({ name: 'teams', rows: [team('2024-25/55325'), team('2021-22/33438'), team('2023-24/55477')] });
  const a = evaluate(q, first, caps, fx, ix), b = evaluate(q, third, caps, fx, ix);
  assert.equal(a.firstUseful, 1); assert.equal(a.rr.teams, 1); assert.equal(a.checks.exact, 'pass');
  assert.equal(b.firstUseful, 0); assert.equal(b.rr.teams, 1 / 3); assert.equal(b.checks.exact, 'fail'); assert.equal(b.checks.useful, 'fail');
  // games expected but today cannot show games: unsupported, not failed, when the rest agrees
  assert.equal(a.checks.sections, 'unsupported'); assert.equal(a.status, 'unsupported');
  assert.equal(evaluate(q, first, capsAll, fx, ix).checks.sections, 'fail', 'an engine that can show games and does not, fails');
  // a row beyond the first-show size (8 teams) earns no reciprocal rank
  const late = outcome({ name: 'teams', rows: [...Array(8)].map((_, i) => team(`2020-21/${i}`)).concat([team('2023-24/55477')]) });
  assert.equal(evaluate(q, late, caps, fx, ix).rr.teams, 0);
  // the wrong section order fails even when unsupported sections are expected
  const evFirst = outcome({ name: 'events', rows: [event('2025-26', 4041)] }, { name: 'teams', rows: [team('2023-24/55477')] });
  assert.equal(evaluate(q, evFirst, caps, fx, ix).checks.sections, 'fail');
});

test('measures: must show (club = every squad), must never (with duplicate), order, empty state', () => {
  const sq = ix.squads.filter(s => s.club === 294 && s.current);
  const all = sq.map(s => team(s.key));
  const q = { id: 'X02', group: 'team-names', q: 'x', stability: 'frozen', sections: ['teams'], useful: [{ club: { clubID: 294 } }],
    mustShow: [{ club: { clubID: 294 }, current: true }], mustNever: [{ event: { season: '2025-26', eventID: 4041 } }],
    order: [{ before: [{ team: { season: sq[0].rows[0].season, teamID: sq[0].rows[0].teamID } }], after: [{ team: { season: sq[1].rows[0].season, teamID: sq[1].rows[0].teamID } }] }] };
  assert.equal(evaluate(q, outcome({ name: 'teams', rows: all }), caps, fx, ix).status, 'pass');
  const short = evaluate(q, outcome({ name: 'teams', rows: all.slice(1) }), caps, fx, ix);
  assert.equal(short.checks.mustShow, 'fail'); assert.match(short.mustShowMissing[0], /1 of 6 squads missing/);
  const swapped = evaluate(q, outcome({ name: 'teams', rows: [all[1], all[0], ...all.slice(2)] }), caps, fx, ix);
  assert.equal(swapped.checks.order, 'fail');
  const hit = evaluate(q, outcome({ name: 'events', rows: [event('2025-26', 4041)] }, { name: 'teams', rows: all }), caps, fx, ix);
  assert.equal(hit.checks.mustNever, 'fail'); assert.deepEqual(hit.mustNeverHits, ['event:2025-26/4041 (1 row)']);
  const fieldRow = n => ({ section: 'games', kind: 'field', field: { name: 'Great Park', zip: '92618' }, hrefs: [] });
  const dq = { ...q, sections: ['games'], mustShow: undefined, order: undefined, useful: [{ field: { name: 'Great Park', zip: '92618' } }],
    mustNever: [{ field: { name: 'Great Park', zip: '92618' }, duplicate: true }] };
  assert.equal(evaluate(dq, outcome({ name: 'games', rows: [fieldRow()] }), capsAll, fx, ix).checks.mustNever, 'pass');
  assert.equal(evaluate(dq, outcome({ name: 'games', rows: [fieldRow(), fieldRow()] }), capsAll, fx, ix).checks.mustNever, 'fail', 'a field split in two rows');
  assert.equal(evaluate(dq, outcome({ name: 'games', rows: [fieldRow()] }), caps, fx, ix).checks.mustNever, 'unsupported');
  const nq = { id: 'X03', group: 'nothing', q: 'zzzz', stability: 'frozen', sections: [], useful: [{ empty: { reason: 'no-match' } }] };
  assert.equal(evaluate(nq, outcome(), caps, fx, ix).firstUseful, 1);
  assert.equal(evaluate(nq, outcome({ name: 'teams', rows: [all[0]] }), caps, fx, ix).firstUseful, 0);
  // labels: a nearby ref needs a nearby row, and is unsupported for an engine with no labels
  const nb = { ...q, mustShow: [{ club: { clubID: 294 }, current: true, nearby: true }], mustNever: undefined, order: undefined };
  assert.equal(evaluate(nb, outcome({ name: 'teams', rows: all }), caps, fx, ix).checks.mustShow, 'unsupported');
  assert.equal(evaluate(nb, outcome({ name: 'teams', rows: all }), capsAll, fx, ix).checks.mustShow, 'fail');
  assert.equal(evaluate(nb, outcome({ name: 'teams', rows: all.map(r => ({ ...r, nearby: true })) }), capsAll, fx, ix).checks.mustShow, 'pass');
});

test('measures: the summary counts statuses, rates and MRR per group', () => {
  const d = { queries: [{ id: 'A', group: 'typos' }, { id: 'B', group: 'typos' }, { id: 'C', group: 'nothing' }] };
  const r = (status, fu, sections, rr) => ({ status, firstUseful: fu, checks: { sections }, rr, wrongDestinations: [], mustNeverHits: [], mustShowMissing: [], capReached: null });
  const s = summarise(d, { A: r('pass', 1, 'pass', { teams: 1 }), B: r('unsupported', 0, 'unsupported', { teams: 0.5, games: null }), C: r('fail', 0, 'fail', {}) });
  assert.deepEqual([s.groups.typos.pass, s.groups.typos.unsupported, s.groups.nothing.fail], [1, 1, 1]);
  assert.equal(s.overall.firstUsefulRate, 0.3333);
  assert.equal(s.overall.sectionsAgreeRate, 0.3333);
  assert.equal(s.overall.sectionsAgreeRateSupported, 0.5);
  assert.deepEqual(s.overall.mrr.teams, { judged: 2, supported: 2, all: 0.75, supportedOnly: 0.75 });
  assert.deepEqual(s.overall.mrr.games, { judged: 1, supported: 0, all: 0, supportedOnly: null });
  assert.equal(s.overall.capReached, null, 'reading cap: n/a until an engine reports it (PR 3)');
});

// ---------- season-bound facts and refreshes (MF5) ----------
const fixtureGames = new Map(fx.judged.games.map(g => [g.matchID, g]));
const closedSeasons = fx.directory.seasons.filter(s => s !== fx.manifest.activeSeason);
const factsOf = (directory, sources, game) => seasonFacts(doc, { directory, sources, game, fixtureGame: m => fixtureGames.get(m) }, closedSeasons);
const fixtureFacts = () => factsOf(fx.directory, fx.sources, m => fixtureGames.get(m));

test('MF5: closed-season facts in the fixtures equal the live archive', () => {
  const live = factsOf(readJSON(new URL('public/archive/directory.json', ROOT)), readJSON(new URL('public/data/sources.json', ROOT)),
    m => { const f = fixtureGames.get(m); return f && liveGame(f.path, m, f.season); });
  const mine = fixtureFacts();
  assert.ok(Object.keys(mine).length > 150, `${Object.keys(mine).length} facts compared`);
  assert.deepEqual(live, mine);
});

test('MF5: a simulated refresh (new squads, a relink, club changes) keeps the facts; a changed closed-season row does not', () => {
  const before = fixtureFacts();
  const dir = clone(fx.directory), active = dir.seasons.indexOf(fx.manifest.activeSeason);
  // a new 2026-27 squad
  dir.squads.push({ c: 0, b: [2014], s: [[active, 999999, 'New Team ECNL G2014', 0, dir.divs.findIndex(d => d[1] === 'GU13'), 1, 10]], e: [], best: 0 });
  // a closed-season squad re-linked (#107): MVLA 2011's squad split in two, rows unchanged
  const i = dir.squads.findIndex(sq => sq.s.some(r => r[1] === 55477) && sq.s.length > 2);
  const sq = dir.squads[i];
  dir.squads.splice(i, 1, { ...sq, s: sq.s.slice(0, 1) }, { ...sq, s: sq.s.slice(1) });
  // a club's name, place and logo change (a club sweep)
  const club = dir.clubs.find(c => c[0] === 294); club[1] = 'MVLA Soccer Club'; club[2] = 'https://example.invalid/new-logo.png'; club[3] = 'Mountain View, CA';
  assert.deepEqual(factsOf(dir, fx.sources, m => fixtureGames.get(m)), before);
  // ...but a closed-season row whose name changes is a real change
  const renamed = clone(fx.directory);
  const row = renamed.squads.flatMap(s => s.s).find(r => r[1] === 55477 && renamed.seasons[r[0]] === '2024-25');
  row[2] = 'MVLA Renamed';
  assert.notDeepEqual(factsOf(renamed, fx.sources, m => fixtureGames.get(m)), before);
  // ...as is a closed-season game whose date moves
  const moved = m => (m === 539613 ? { ...fixtureGames.get(m), date: '2023-09-10T11:30:00' } : fixtureGames.get(m));
  assert.notDeepEqual(factsOf(fx.directory, fx.sources, moved), before);
});

// ---------- the search modules (#163, PR 3): public/search/*.mjs measured on the same set ----------
// The pass criteria of the approved plan (v2, section 5). The modules answer teams and events only:
// games, fields, head to head and pairings stay `unsupported` until PR 4b and PR 6.
const MODULES = readJSON(new URL('baseline/modules.json', HERE));
const modules = modulesAdapter(doc.context);
const modulesRun = runAll(doc, modules, fx);
// Queries allowed to fail a supported check, each with its reason. Empty since the owner's Q1
// decision on #163 (C07's expected sections). A fix or a new failure both edit this list.
const KNOWN_FAILING = {};

test('#163: the modules on the fixtures equal the recorded baseline, query by query', () => {
  const now = modulesBaselineOf(doc, modules, fx, modulesRun);
  const hint = ' (re-record with: node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --record modules, and explain the diff in the PR)';
  assert.deepEqual(Object.keys(now.perQuery).sort(), Object.keys(MODULES.perQuery).sort(), 'the same queries' + hint);
  for (const id of Object.keys(now.perQuery)) assert.deepEqual(JSON.parse(stable(now.perQuery[id])), MODULES.perQuery[id], id + hint);
  assert.deepEqual(JSON.parse(stable(now.header)), MODULES.header, 'header (modules, fixtures, queries, context)' + hint);
  assert.deepEqual(JSON.parse(stable(now.summary)), MODULES.summary, 'summary' + hint);
  assert.equal(MODULES.header.modulesSha, modulesSha());
});

test('#163 pass criteria: first result useful better than today overall, and no group worse', () => {
  const t = BASELINE.summary, m = modulesRun.summary;
  assert.ok(m.overall.firstUseful > t.overall.firstUseful, `${m.overall.firstUseful} > ${t.overall.firstUseful}`);
  assert.equal(m.overall.firstUseful, 48, 'the plan expects 48/60: every query the modules can answer');
  for (const g of GROUPS) assert.ok(m.groups[g].firstUseful >= t.groups[g].firstUseful, `${g}: ${m.groups[g].firstUseful} >= ${t.groups[g].firstUseful}`);
});

test('#163 pass criteria: 0 wrong destinations, 0 must-never hits, section order, no reading cap', () => {
  const o = modulesRun.summary.overall;
  assert.equal(o.wrongDestinations, 0);
  assert.equal(o.mustNeverHits, 0);
  assert.equal(o.mustShowMissing, 0);
  assert.ok(o.sectionsAgreeRateSupported >= 0.9, `section order ${o.sectionsAgreeSupported}/${o.sectionsSupported}`);
  assert.equal(o.capReached, 0, 'no judged query reaches the cap of 4 readings');
  for (const [id, r] of Object.entries(modulesRun.perQuery)) {
    if (BASELINE.perQuery[id].checks.sections === 'pass') assert.equal(r.checks.sections, 'pass', `${id}: its section order passes today`);
  }
});

test('#163 pass criteria: no check that passes today fails now, and only the known queries fail', () => {
  for (const [id, r] of Object.entries(modulesRun.perQuery)) {
    for (const [k, v] of Object.entries(BASELINE.perQuery[id].checks)) if (v === 'pass') assert.notEqual(r.checks[k], 'fail', `${id} ${k}`);
  }
  const failing = Object.entries(modulesRun.perQuery).filter(([, r]) => r.status === 'fail').map(([id]) => id).sort();
  assert.deepEqual(failing, Object.keys(KNOWN_FAILING).sort());
});

test('#163: the modules adapter fails loudly on a row kind it does not know', () => {
  assert.throws(() => modulesRow({ kind: 'mystery' }), /unknown row kind/);
  assert.deepEqual(modulesRow({ kind: 'event', season: '2025-26', eventID: 4041, hrefs: ['#h'], nearby: true }),
    { section: 'events', kind: 'event', season: '2025-26', eventID: 4041, hrefs: ['#h'], nearby: true });
});

test('#163 MF6: the modules give the same outcome under TZ=UTC and TZ=Pacific/Kiritimati', () => {
  const run = () => runAll(doc, modulesAdapter(doc.context), fx).perQuery;
  assert.deepEqual(withTZ('UTC', run), withTZ('Pacific/Kiritimati', run));
});

test('#163 Q2: refinement B (the more specific reading wins a tie) changes only C07', () => {
  const off = modulesAdapter(doc.context, { options: { specificityTie: false } });
  const changed = doc.queries.filter(q => {
    const a = modules.run(q.q), b = off.run(q.q);
    return JSON.stringify(a.sections.map(s => s.name)) !== JSON.stringify(b.sections.map(s => s.name)) || JSON.stringify(a.enter) !== JSON.stringify(b.enter);
  }).map(q => q.id);
  assert.deepEqual(changed, ['C07']);
  assert.equal(evaluate(doc.queries.find(q => q.id === 'C07'), off.run('Northwest 2023-24'), off, fx, ix).firstUseful, 0, 'without it, C07 opens a team');
});
