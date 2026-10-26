// #168 (#149 phase 1, PR 4b): the Games category of the search modules (public/search/games.mjs, and the
// reader, vocab, slate and search changes). The judged set
// (tests/search-judged.test.mjs) measures what it finds and the link test (search-game-links) where its
// links go; this file pins how: the staged games build, field phrases (Q4, MF5), each reading (D2, D5,
// D6, D6a, D8, names through the Teams matcher), the order (Q1), coverage and the slate's rules (MF1, MF3,
// MF4, the partial rule for places), and the work counters (nits 1, 2). Every expectation comes from the
// frozen fixture, the committed data or a stated rule. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/search-games.test.mjs
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readJSON, readLF, HERE, ROOT, loadSearchData, loadGames, modulesContext, todayOf } from './search/judged.mjs';
import { keystrokes, clubPrefixes, placeNames, reviewSet } from './search/sets.mjs';

const S = await import(new URL('public/search/search.mjs', ROOT));
const { readQuery } = await import(new URL('public/search/reader.mjs', ROOT));
const { words: normWords } = await import(new URL('public/search/match.mjs', ROOT));
const { ALIASES } = await import(new URL('public/search/vocab.mjs', ROOT));
const { GameRow, NO_DAY, dayOf } = await import(new URL('public/search/games.mjs', ROOT));
const doc = readJSON(new URL('queries.json', HERE));
const CTX = modulesContext(doc.context);   // today 2026-10-15 (America/Los_Angeles)
const load = (ix, s, dir) => { const g = S.startGames(ix, dir ? readJSON(new URL(`games-${s}.json`, dir)) : loadGames(s), Infinity); let r; while (!(r = g.next()).done); return r.value; };
const fixture = (seasons = null) => { const ix = S.buildIndex(loadSearchData()); for (const s of seasons || [ix.vocab.active]) load(ix, s); return ix; };
const IX = fixture();
const run = (q, ix = IX, ctx = CTX, o) => S.search(ix, q, ctx, o);
const sec = (s, name) => (s.sections.find(x => x.name === name) || { rows: [] }).rows;
const COMMITTED = new URL('public/archive/search/', ROOT);
const committed = () => ({ core: JSON.parse(readLF(new URL('core.json', COMMITTED))), places: JSON.parse(readLF(new URL('places.json', COMMITTED))) });
const CDATA = committed();
const CIX = S.buildIndex(CDATA); load(CIX, CIX.vocab.active, COMMITTED);
const CCTX = { now: Date.parse('2026-10-17T19:00:00Z'), timeZone: 'America/Los_Angeles', selectedSeason: CIX.vocab.active, today: '2026-10-17' };
// a row in full: its own fields and every getter of its class
const dump = row => { const out = { ...row }; for (let p = Object.getPrototypeOf(row); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) if (d.get && !(k in out)) out[k] = row[k]; return out; };
const slateText = s => JSON.stringify({ rule: s.rule, empty: s.empty, coverage: s.coverage, best: s.best && dump(s.best), enter: s.enter && dump(s.enter), sections: s.sections.map(x => ({ ...x, rows: x.rows.map(dump) })) });
// The field-name rule, derived from the data alone and independently of the modules (3c3ba1b3's MF5 rule):
// every field name of 2+ words, except one held by a club, team, family or alias (a name's words are a whole
// run inside the other name's words). Returns the phrases that read as a field and the names dropped.
const fieldRule = ({ core, places }) => {
  const t = core.teams, w = s => normWords(s);
  const names = new Set([...t.clubs.map(c => c[1]), ...(t.families || []).map(f => f[0]), ...Object.keys(ALIASES), ...Object.keys(core.vocab.confAliases || {})]);
  for (const sq of t.squads) for (const r of sq.s) names.add(r[2]);
  const joined = [...names].map(n => ` ${w(n).join(' ')} `);
  const alias = new Set(Object.values(places.vocab.fieldAliases));
  const want = [...new Set(Object.keys(places.fields).map(k => k.slice(0, k.lastIndexOf('@'))).filter(n => !alias.has(n)).map(n => w(n).join(' ')))].filter(k => k.includes(' '));
  const dropped = want.filter(k => joined.some(s => s.includes(` ${k} `))).sort();
  return { kept: want.filter(k => !dropped.includes(k)).sort(), dropped };
};
// the frozen fixture: tests/search/fixtures/search/. 900 before #169; the 35 reviewed aliases merge 70 names into
// 35 fields whose names are aliases (an alias's name is no field-name phrase): 944 -> 909 fields, 900 -> 831 phrases.
const FIXTURE_COUNT = 831;
const FIXTURE_RULE = fieldRule(loadSearchData()), LIVE_RULE = fieldRule(CDATA);
// #197: the kept fixture names that readQuery does not read as a field (stop words, a kind word or a digit in the name)
const FIELD_QUIRK = ['academy of holy angels', 'academy of the new church anc', 'allen high school track and field stadium', 'college of marin',
  'colorado school of mines stermole stadium', 'east meadow field of dreams', 'johnson and wales university scotts miraclegro', 'our lady of mercy',
  'reach 11 sports complex', 'sarah hegarty field 2', 'the academy of the holy cross', 'the calverton school', 'the masters college',
  'the parks at texas star', 'the pine school', 'the plex', 'the wellington school turf', 'town and country', 'toyota of lewisville railroad park', 'university of dallas'];
const phraseNames = ix => ix.vocab.phrases.filter(p => p.fieldName).map(p => p.words.join(' ')).sort();

// ---------- the staged games build ----------
test('startGames: staged at n = 1, 50 and 150 equals the build at once, on all 7 fixture files; rows in full', () => {
  const seasons = IX.vocab.seasons;
  const whole = fixture(seasons);
  const qs = ['Surf Sports Park', 'MVLA 2011', 'Slammers vs Blues 2023-24', 'Great Park 2024-25', 'NorCal 2021-22', 'playoffs 2022-23', '10/17', 'San Diego', 'MVLA 2011 vs Mustang 2011'];
  const want = qs.map(q => slateText(run(q, whole)));
  for (const n of [1, 50, 150]) {
    const ix = S.buildIndex(loadSearchData());
    for (const s of seasons) { const g = S.startGames(ix, loadGames(s), n); while (!g.next().done); }
    qs.forEach((q, k) => assert.equal(slateText(run(q, ix)), want[k], `n = ${n}: ${q}`));
  }
});
test('startGames: each step does at most n games (or n squads) of one stage; the count is pinned; the season is installed by the last step only', () => {
  const steps = (n, ix = S.buildIndex(loadSearchData()), s = '2026-27') => { const g = S.startGames(ix, loadGames(s), n), labels = []; let r; while (!(r = g.next()).done) { labels.push(r.value); assert.ok(!ix.games.has(s), 'not installed before the last step'); } assert.ok(ix.games.has(s)); return labels; };
  const hist = l => l.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
  const h1 = hist(steps(1));
  for (const n of [7, 50, 150]) for (const [stage, c1] of Object.entries(hist(steps(n)))) assert.ok(Math.abs(c1 - h1[stage] / n) <= 3 || stage === 'games:order', `n = ${n} ${stage}: ${c1} for ${h1[stage]} at n = 1`);
  assert.equal(steps(150).length, 67, 'the first season adds the one-time lookups (games:teams)');
  const ix = fixture(); assert.equal(steps(150, ix, '2025-26').length, 59, 'a later season: rows, lookups, order');
});
test('startGames: an unknown games schema throws SearchDataError from the first next(), naming the file', () => {
  const bad = { ...loadGames('2026-27'), schema: 9 };
  const g = S.startGames(fixture([]), bad);
  assert.throws(() => g.next(), e => e instanceof S.SearchDataError && e.file === 'games-2026-27.json');
  assert.equal(S.GAMES_SCHEMA, 1);
  assert.match(readLF(new URL('search_data.py', ROOT)), /^GAMES_SCHEMA = 1\b/m, 'the builder writes the schema the modules read');
});

// ---------- field phrases (Q4, MF5) ----------
test('Q4, MF5: every field name of 2 words or more reads as a field, except a name held by a club, team, family or alias; exact on the frozen fixture, the rule itself on the committed data', () => {
  const v = CIX.vocab;
  // the frozen fixture does not move: its counts are pinned. The committed data changes with every refresh: only the rule is asserted
  assert.equal(IX.vocab.phrases.filter(p => p.fieldName).length, FIXTURE_COUNT);
  assert.deepEqual(IX.vocab.fieldPhrasesDropped, ['fc dallas', 'oklahoma celtic', 'pda south'], 'the report: FC Dallas is in "FC Dallas Youth" and its teams\' names');
  assert.deepEqual(phraseNames(IX), FIXTURE_RULE.kept);
  // #177: a share of the live names, not a count (a refresh moves the count): 834 of 837 kept when set, floor 95%
  assert.ok(LIVE_RULE.kept.length > 0 && LIVE_RULE.dropped.length > 0 && LIVE_RULE.kept.length / (LIVE_RULE.kept.length + LIVE_RULE.dropped.length) >= 0.95, 'the rule keeps most names and drops some');
  assert.deepEqual(phraseNames(CIX), LIVE_RULE.kept, 'committed data: exactly the names the rule keeps');
  assert.deepEqual([...v.fieldPhrasesDropped].sort(), LIVE_RULE.dropped, 'committed data: exactly the names the rule drops');
  for (const p of v.phrases.filter(x => x.fieldName)) assert.ok(p.words.length >= 2, p.value);
  // #197: the named examples run on the frozen fixture (the committed data held the same rows when they were written);
  // the committed data keeps the rule: a dropped name never reads as a field (exact), a kept name does (a share)
  const field = (q, ix = IX) => readQuery(ix.vocab, q).sides[0].field;
  for (const d of ['fc dallas', 'pda south']) assert.ok(FIXTURE_RULE.dropped.includes(d), `${d}: a club's name never reads as a field`);
  assert.equal(field('Canyon Crest Academy'), true);
  for (const q of ['surf', 'Surf Cup', 'Canyon Crest', 'Grogan', 'Stadium', 'FC Dallas', 'PDA South', 'PDA']) assert.equal(field(q), false, `${q}: a part, or a club's name, never a field`);
  const s = run('FC Dallas');
  assert.deepEqual(s.sections.map(x => x.name), ['teams', 'games'], 'MF5: FC Dallas leads with Teams');
  assert.equal(s.enter.kind, 'team'); assert.equal(s.enter.club, 'FC Dallas Youth');
  // the rule on both data sets: no dropped name reads as a field. A kept name reads as a field, but 20 of the fixture's 831
  // do not (an existing quirk of the reader: stop words, a kind word or a digit in the name; not fixed here): pinned exactly
  // on the fixture, and a share (97.6% when set) on the committed data, which a refresh may add to
  for (const [ix, rule, what] of [[IX, FIXTURE_RULE, 'fixture'], [CIX, LIVE_RULE, 'committed data']]) for (const k of rule.dropped) assert.equal(field(k, ix), false, `${what}: ${k} is held by a name, so it reads as no field`);
  assert.deepEqual(FIXTURE_RULE.kept.filter(k => !field(k)), FIELD_QUIRK, 'the fixture: the kept names the reader does not read as a field');
  const unread = LIVE_RULE.kept.filter(k => !field(k, CIX));
  assert.ok(unread.length <= 0.05 * LIVE_RULE.kept.length, `${unread.length} of ${LIVE_RULE.kept.length} kept names do not read as a field: ${unread.join(', ')}`);
});

// #177 (N2 of the review of #176): the names `finishG` checks last (clubs with no squad, families, conference aliases) were
// never the only holder of a dropped field name in any dataset, so a mutant that skipped them survived. A copy of the
// frozen fixture with one field held only by each, and controls that nothing holds.
test('#177 N2: a field name held only by a club with no squad, a family or a conference alias is dropped; names nothing holds, or only part of one, are kept', () => {
  const d = loadSearchData(), t = d.core.teams, f = d.places.fields, proto = f['1849 park@78660'];
  t.clubs.push([990001, 'Zephyr Hollow United', null, '']);       // no squad row has this name
  t.families.push(['Quill Meadow Rovers', 2357]);
  d.core.vocab.confAliases['brindle ford league'] = 'NorCal';
  for (const [n, zip] of [['Zephyr Hollow', '99001'], ['Quill Meadow', '99002'], ['Brindle Ford', '99003'], ['Marlow Quay', '99004'], ['Zephyr Holl Quay', '99005']]) f[`${n.toLowerCase()}@${zip}`] = [n, ...proto.slice(1, 3), proto[3], proto[4]];
  const squadNames = new Set(t.squads.flatMap(sq => sq.s.map(r => normWords(r[2]).join(' '))));
  for (const n of ['zephyr hollow', 'quill meadow', 'brindle ford']) assert.ok(![...squadNames].some(x => ` ${x} `.includes(` ${n} `)), `${n}: no squad row holds it, so only the last-checked names can drop it`);
  const want = fieldRule(d), v = S.buildIndex(d).vocab;
  assert.deepEqual(want.dropped.filter(k => /zephyr|quill|brindle|marlow/.test(k)), ['brindle ford', 'quill meadow', 'zephyr hollow']);
  assert.deepEqual(phraseNames({ vocab: v }), want.kept, 'the phrases are the names the rule keeps');
  assert.deepEqual([...v.fieldPhrasesDropped].sort(), want.dropped, 'and the dropped list is the rule\'s');
  const kept = phraseNames({ vocab: v });
  assert.ok(kept.includes('marlow quay') && kept.includes('zephyr holl quay'), 'no holder; a part of a held name is no holder (whole words)');
});
test('#177 N2: no alias key is a name of 2 words or more, so the alias names the last-checked branch reads can never hold a field name; the day one does, add a case to the test above', () => {
  assert.deepEqual(Object.keys(ALIASES).filter(k => normWords(k).length >= 2), [], 'a multi-word alias can hold a field name: add it to the synthetic case above');
});
test('#167 (review of #170, MF1): the field names\' phrases are built with the index, each name checked as the team documents read it', () => {
  const ix = S.buildIndex(committed());
  assert.equal(S.buildIndex(loadSearchData()).vocab.phrases.filter(p => p.fieldName).length, FIXTURE_COUNT, 'the frozen fixture: pinned');
  assert.equal(ix.vocab.fieldSource, null, 'the sources are let go');
  assert.equal([...ix.vocab.byFirstBase.values()].flat().filter(p => p.fieldName).length, 0, 'Teams and Events read without them (MF2)');
  // the same phrases, in the same order, as the scan over every name done on its own (3c3ba1b3's MF5 rule)
  assert.deepEqual([...ix.vocab.fieldPhrasesDropped].sort(), LIVE_RULE.dropped);
  assert.deepEqual(phraseNames(ix), LIVE_RULE.kept);
});

test('MF5: a field name\'s words never join the known words (they would switch off a team\'s typo match: "mary")', () => {
  const noFields = loadSearchData(); noFields.places.fields = {};
  const plain = S.buildIndex(noFields);
  assert.deepEqual([...IX.known].sort(), [...plain.known].sort());
  for (const q of ['Mary', 'Maryland', 'Marylnd', 'mary grogan']) {
    const a = run(q, IX, CTX, { games: false }), b = run(q, plain, CTX, { games: false });
    assert.deepEqual(a.sections.map(x => [x.name, x.rows.map(r => r.key || r.eventID)]), b.sections.map(x => [x.name, x.rows.map(r => r.key || r.eventID)]), q);
  }
});
test('a field reading: the number in "Great Park field 15"; the last word still being "field" names no team', () => {
  assert.equal(readQuery(IX.vocab, 'Great Park field 15').sides[0].tokens.fieldNumber, 15);
  const s = run('Great Park field 15');
  assert.deepEqual(sec(s, 'games').filter(r => r.kind === 'field').map(r => [r.key, r.field.number]), [['Great Park@92618', 15]]);
  for (const q of ['Great Park f', 'Great Park fi', 'Great Park fie']) {
    const stats = { teamSearches: 0 }; run(q, IX, CTX, { stats });
    const named = readQuery(IX.vocab, q).sides[0].games.filter(r => !r.field && r.names.length).length;
    assert.ok(readQuery(IX.vocab, q).sides[0].games.some(r => r.field && r.names.length === 1), `${q}: precondition: a field reading with the last word`);
    assert.equal(stats.teamSearches, 1 + named, `${q}: the field reading runs no team search for its last word`);
    assert.equal(sec(run(q), 'games')[0].kind, 'field', q);
  }
});

// ---------- the readings ----------
test('D6, D6a: one field row per name and zip: Great Park @ 92618 is one row for every complex id (3069 in 2024-25)', () => {
  const ix = fixture(['2026-27', '2024-25']);
  const s = run('Great Park 2024-25', ix);
  const f = sec(s, 'games').filter(r => r.kind === 'field');
  assert.deepEqual(f.map(r => r.key), ['Great Park@92618']);
  const G = ix.games.get('2024-25'), cx = Object.entries(loadGames('2024-25').fields).filter(([, v]) => v[0] === 'Great Park' && v[1] === '92618').map(([k]) => +k);
  assert.ok(cx.includes(3069) && cx.length === 6, cx.join());
  const ids = new Set(f[0].games.map(g => g.matchID));
  const want = loadGames('2024-25').games.reduce((a, r) => { a.id += r[0]; if (cx.includes(r[9])) a.out.push(a.id); return a; }, { id: 0, out: [] }).out;
  assert.deepEqual([...ids].sort(), [...want].sort(), 'its games: every complex id of the field');
  assert.equal(f[0].count, want.length);
  assert.ok(G.N > 0);
});
test('D2, Q7: a place lists its fields, in the place first, then the rest of its county under one Nearby label; never every game played there', () => {
  const s = run('San Diego');
  const all = sec(s, 'games'), g = all.filter(r => r.kind === 'field');
  // the place reading gives fields; the name reading ("San Diego" as words) gives its teams' games, after them
  assert.ok(g.length > 10 && all.slice(0, g.length).every(r => r.kind === 'field'), 'fields first');
  const named = new Set(sec(s, 'teams').flatMap(t => t.squadRows.map(r => r.teamID)));
  assert.ok(all.slice(g.length).every(r => r.kind === 'game' && (named.has(r.home.teamID) || named.has(r.away.teamID))), 'then only the games of teams named San Diego');
  const firstNear = g.findIndex(r => r.nearby);
  assert.ok(firstNear > 0 && g.slice(firstNear).every(r => r.nearby), 'direct, then nearby');
  assert.ok(g.slice(firstNear).every(r => r.nearbyOf === 'San Diego, CA'));
  assert.ok(g.slice(0, firstNear).every(r => r.place === 'San Diego, CA'));
  // MF4: inside each, a field with games in the seasons asked first
  for (const part of [g.slice(0, firstNear), g.slice(firstNear)]) { const k = part.findIndex(r => !r.count); assert.ok(k < 0 || part.slice(k).every(r => !r.count)); }
  // #169 (owner decision Q7): Miramesa High School and Mira Mesa High School are one field, labelled with TGS's full spelling
  assert.deepEqual(g.slice(0, 3).map(r => [r.label, r.count]), [['Mira Mesa High School', 9], ['Canyon Crest Academy', 12], ['Scripps Ranch High School', 3]], 'upcoming games first');
  // nit 3: an age group does not apply to a field (its games are every age group\'s)
  assert.ok(sec(run('San Diego U15'), 'games').filter(r => r.kind === 'field').every(r => r.allAges));
});
test('D8: Richmond\'s fields are in Richmond, VA only', () => {
  const g = sec(run('Richmond'), 'games').filter(r => r.kind === 'field');
  assert.ok(g.length > 0);
  assert.ok(g.filter(r => !r.nearby).every(r => / VA$/.test(r.place)), g.map(r => r.place).join());
  assert.ok(g.every(r => !/ CA$/.test(r.place)));
});
test('names: a game is listed if and only if one of its teams is a squad of the Teams section (every judged keystroke with plain name words)', () => {
  let n = 0;
  for (const q of keystrokes(doc)) {
    const rd = readQuery(IX.vocab, q);
    if (rd.vs || rd.sides[0].games.some(r => r.u || r.born.length || r.band || r.conf || r.seasons || r.unknownSeason || r.kinds.length || r.places || r.field || r.dates.length || !r.names.length)) continue;
    const s = run(q);
    if (s.rule !== 5 || s.partial || (s.empty && s.empty.reason === 'no-full-match')) continue;
    const G = IX.games.get(IX.vocab.active), mine = new Set();
    for (const t of sec(s, 'teams')) { for (const r of t.squadRows) if (r.season === IX.vocab.active) mine.add(r.teamID); for (const x of t.aliasIDs) if (x.season === IX.vocab.active) mine.add(x.teamID); }
    const want = new Set(); for (let i = 0; i < G.N; i++) if (mine.has(G.h[i]) || mine.has(G.a[i])) want.add(G.id[i]);
    const got = new Set(sec(s, 'games').map(r => r.matchID));
    assert.deepEqual([...got].sort(), [...want].sort(), q);
    n++;
  }
  assert.ok(n > 150, `${n} keystrokes`);
});
test('a conference, a kind word and a date: that conference\'s games, those national events\' games, the day\'s games', () => {
  const nc = sec(run('NorCal'), 'games');
  assert.ok(nc.length > 100 && nc.every(r => r.competition.kind === 'c' && r.competition.event === 'NorCal'));
  const d = sec(run('10/17'), 'games');
  const G = IX.games.get('2026-27'); let want = 0; for (let i = 0; i < G.N; i++) if (G.day[i] === dayOf('2026-10-17')) want++;
  assert.ok(d.length === want && want > 100 && d.every(r => r.date === '2026-10-17'));
  assert.deepEqual(sec(run('2026-10-17'), 'games').map(r => r.matchID), d.map(r => r.matchID));
  const ix = fixture(['2026-27', '2025-26']);
  const p = sec(run('playoffs 2025-26', ix), 'games');
  assert.ok(p.length > 50 && p.every(r => r.competition.kind === 'n' && /playoffs/i.test(r.competition.event)), 'a kind word: the stage\'s own name');
  const sc = sec(run('showcase 2025-26', ix), 'games');
  assert.ok(sc.length > 50 && sc.every(r => r.competition.kind === 's'));
});
test('the default season is the active one; a typed season or bare year names its own (not-loaded until the page loads it)', () => {
  assert.ok(sec(run('MVLA'), 'games').every(r => r.season === '2026-27'));
  assert.deepEqual(run('MVLA 2023-24').coverage.map(c => [c.season, c.state]), [['2023-24', 'not-loaded']]);
  assert.deepEqual(run('Slammers vs Blues 2026').coverage.map(c => c.season).sort(), ['2025-26', '2026-27']);
  const ix = fixture(['2026-27', '2023-24']);
  assert.ok(sec(run('MVLA 2023-24', ix), 'games').length > 10 && sec(run('MVLA 2023-24', ix), 'games').every(r => r.season === '2023-24'));
});
test('D5: club against club is one pairing row per season and age group, newest season first, oldest age first; sides are the clubs that met; the record is the first side\'s', () => {
  const s = run('Slammers vs Blues');
  assert.deepEqual(s.sections.map(x => x.name), ['games', 'teams']);
  const p = sec(s, 'games');
  assert.deepEqual(p.map(r => r.div), ['GU18/19', 'GU17', 'GU16', 'GU15', 'GU14', 'GU13']);
  assert.ok(p.every(r => r.kind === 'pairing' && r.season === '2026-27' && JSON.stringify(r.sides) === '[[96],[98]]' && r.meetings.length === 2));
  assert.deepEqual(p[0].sideNames, [['Slammers FC'], ['So Cal Blues']]);
  assert.equal(s.enter, p[0]);
  const ix = fixture(['2026-27', '2023-24']);
  const h = sec(run('Slammers vs Blues 2023-24', ix), 'games');
  assert.ok(h.length && h.every(r => JSON.stringify(r.sides) === '[[96,1656],[98]]'), 'H03: Slammers is clubs 96 and 1656 that season');
  for (const r of h) {
    let w = 0, d = 0, l = 0;
    // #178 (MF4, Q3): as the team Overview counts it, a drawn game decided on penalties is a win or a loss for the side that won them
    for (const m of r.meetings) if (m.score) { const [x, y] = m.aHome ? m.score : [m.score[1], m.score[0]]; const pk = m.pk && m.pk[0] !== m.pk[1] ? (m.aHome ? m.pk[0] - m.pk[1] : m.pk[1] - m.pk[0]) : 0; if (x > y || (x === y && pk > 0)) w++; else if (x < y || (x === y && pk < 0)) l++; else d++; }
    assert.deepEqual(r.record, [w, d, l], `${r.div}`);
  }
  assert.ok(h.some(r => r.record.some(Boolean)), 'some meetings were played');
  // B1: the G2008 pairing was [1,2,1] while a shoot-out counted as a draw; a drawn game decided on penalties is now a win (Q3: the owner's decision)
  assert.deepEqual(h.find(r => r.div === 'G2008').record, [2, 1, 1]);
});
test('MF1 (Q2): one squad a side, no season: the loaded seasons\' meetings, then a Load row for the other seasons both played, never fetched by itself', () => {
  const s = run('MVLA 2011 vs Mustang 2011');
  const g = sec(s, 'games');
  assert.deepEqual(g.map(r => r.kind), ['h2h', 'game', 'game', 'load'], '#178: one squad a side leads with the head to head');
  assert.deepEqual(g.slice(1, 3).map(r => r.matchID), [1094466, 1094465]);
  assert.equal(s.enter, g[0], 'the head to head (it was the latest loaded meeting, 1094466); never the Load row');
  const L = g[3];
  assert.deepEqual([L.what, L.state, L.seasons], ['meetings', 'on-request', ['2023-24', '2024-25', '2025-26']]);
  assert.deepEqual(s.coverage.filter(c => c.state === 'on-request').map(c => c.season), ['2023-24', '2024-25', '2025-26'], 'on-request, not not-loaded: the page never fetches them by itself');
  assert.ok(!s.coverage.some(c => c.state === 'not-loaded'));
  // H04: no meeting in a loaded season: Games still leads, with the Load row only; Enter commits nothing
  const h = run('Slammers HB Koge 2007 v So Cal Blues 2007');
  assert.deepEqual(h.sections.map(x => x.name), ['games', 'teams']);
  assert.deepEqual(sec(h, 'games').map(r => r.kind), ['h2h', 'load'], '#178: the head to head leads, with 0 meetings in the loaded seasons');
  assert.deepEqual(sec(h, 'games')[1].seasons, ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25']);
  assert.equal(h.enter, sec(h, 'games')[0], 'it is the enter (it was null: Enter committed nothing)'); assert.equal(h.best, null); assert.equal(h.empty, null);
  // while loading, and after: the seasons loaded so far count (the visit's own results)
  assert.equal(sec(run('MVLA 2011 vs Mustang 2011', IX, { ...CTX, gamesLoading: ['2023-24', '2024-25', '2025-26'] }), 'games').at(-1).state, 'loading');
  assert.equal(sec(run('MVLA 2011 vs Mustang 2011', IX, { ...CTX, gamesFailed: ['2024-25'] }), 'games').at(-1).state, 'failed');
  const after = run('MVLA 2011 vs Mustang 2011', fixture(['2026-27', '2023-24', '2024-25', '2025-26']));
  const ga = sec(after, 'games');
  assert.ok(ga.length > 2 && ga[0].kind === 'h2h' && ga.slice(1).every(r => r.kind === 'game'), 'the Load row is gone once no season remains');
  assert.deepEqual(new Set(ga.slice(1).map(r => r.season)), new Set(['2023-24', '2024-25', '2025-26', '2026-27']));
  const part = sec(run('MVLA 2011 vs Mustang 2011', fixture(['2026-27', '2024-25'])), 'games').at(-1);
  assert.deepEqual(part.seasons, ['2023-24', '2025-26'], 'a season loaded earlier counts: the Load row names only the rest');
});
test('G5: a field with no games in the seasons asked counts 0 and names its seasons; once its Load season is in, it shows that season too', () => {
  const s = run('60 Acres');
  const f = sec(s, 'games')[0];
  assert.deepEqual([f.kind, f.count, f.loaded], ['field', 0, ['2026-27']]);
  assert.ok(f.seasons.length && f.notLoaded.length && !f.seasons.includes('2026-27'), f.seasons.join());
  const latest = f.notLoaded.at(-1);
  const after = sec(run('60 Acres', fixture(['2026-27', latest])), 'games')[0];
  assert.deepEqual(after.loaded, ['2026-27', latest].sort());
  assert.ok(after.count > 0 && after.games.every(g => g.season === latest));
});

// ---------- order ----------
test('Q1 order: upcoming games (unplayed, today or later) soonest first, then the rest newest first, undated last; the same in every zone', () => {
  const check = (rows, today) => {
    const t = dayOf(today), up = r => r.date && dayOf(r.date) >= t && !r.score;
    const k = rows.findIndex(r => !up(r));
    const head = k < 0 ? rows : rows.slice(0, k), tail = k < 0 ? [] : rows.slice(k);
    assert.ok(tail.every(r => !up(r)), 'upcoming first');
    for (let i = 1; i < head.length; i++) assert.ok(head[i - 1].date <= head[i].date, 'soonest first');
    const dated = tail.filter(r => r.date), u = tail.findIndex(r => !r.date);
    assert.ok(u < 0 || tail.slice(u).every(r => !r.date), 'undated last');
    for (let i = 1; i < dated.length; i++) assert.ok(dated[i - 1].season > dated[i].season || dated[i - 1].date >= dated[i].date, 'then newest first');
  };
  const ix = fixture(['2026-27', '2025-26']);
  for (const q of ['MVLA', 'Slammers 2026', 'NorCal 2026', 'Surf Sports Park 2026']) check(sec(run(q, ix), 'games').filter(r => r.kind === 'game'), CTX.today);
  const a = run('MVLA 2026', ix);
  const zone = tz => { const old = process.env.TZ; process.env.TZ = tz; try { return slateText(run('MVLA 2026', ix)); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } };
  assert.equal(zone('UTC'), zone('Pacific/Kiritimati'));
  assert.equal(zone('UTC'), slateText(a));
  assert.equal(sec(run('MVLA', IX, { ...CTX, today: '2027-12-31' }), 'games').filter(r => r.date && !r.score).length, sec(run('MVLA'), 'games').filter(r => r.date && !r.score).length);
});
test('game rows carry what the page draws: date, time, sides (as the event spells them, with a season tab when listed), score, competition, field, dest, the matched side', () => {
  const g = sec(run('MVLA 2011'), 'games');
  assert.ok(g.length > 20);
  for (const r of g) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(r.time == null || /^\d{2}:\d{2}$/.test(r.time));
    assert.ok(['home', 'away', 'both'].includes(r.matched), 'the side the query matched');
    const side = r[r.matched === 'away' ? 'away' : 'home'];
    assert.match(side.name, /MVLA/);
    assert.match(side.seasonHref, /^#tab=teams&season=2026-27&team=\d+&name=.+&view=season$/);
    assert.equal(r.competition.kind, 'c'); assert.ok(r.competition.event && r.competition.div);
    assert.ok(r.href.startsWith('#season=2026-27&') && r.href.includes(`&match=${r.matchID}`));
    if (r.field) { assert.ok(r.field.label && r.field.zip); }
  }
  const f = sec(run('Surf Sports Park'), 'games')[1];
  assert.deepEqual([f.field.label, f.field.place], ['Surf Sports Park', 'Del Mar, CA']);
  assert.equal(f.matched, null, 'a field query matches no side');
});

// ---------- the slate ----------
test('MF3: under rule 5 Games comes after every section, and Teams and Events (order, rows, enter) are as without games: every 2-5-letter club prefix', () => {
  let n = 0, games = 0;
  const prefixes = [...clubPrefixes(CDATA.core), 'St', 'St.', 'North', 'West'];
  for (const q of prefixes) {
    const a = run(q, CIX, CCTX), b = run(q, CIX, CCTX, { games: false });
    if (a.rule === 4) continue;
    const names = a.sections.map(x => x.name);
    assert.deepEqual(names.filter(x => x !== 'games'), b.sections.map(x => x.name), q);
    if (a.rule === 5) { if (names.includes('games')) { games++; assert.equal(names.at(-1), 'games', q); } assert.equal(a.enter && (a.enter.key || a.enter.eventID), b.enter && (b.enter.key || b.enter.eventID), `${q}: enter`); }
    n++;
  }
  // #177: shares (92.3% of the prefixes run, 91.7% of those with games when set); floors 80% and 80%
  assert.ok(n >= 0.8 * prefixes.length && games >= 0.8 * n, `${n} of ${prefixes.length} prefixes, ${games} with games`);
  assert.equal(run('St').enter.title.startsWith('Stanislaus'), true, 'St: Stanislaus Surf, as on main (#197: the frozen fixture)');
});
test('MF4: a place query leads with Games only when a field in the place has games in the seasons asked; Enter is never an empty field', () => {
  let lead = 0, n = 0;
  const qs = new Set(['Naperville', 'Tulsa', 'Lake Forest', 'Orange', 'Weston', 'Redmond', 'Farmington', 'Plantation']);
  for (const c of CDATA.core.teams.clubs) if (c[3]) qs.add(c[3].split(',')[0]);
  for (const q of placeNames(CDATA.places)) qs.add(q);   // every census place and county (the Reviewer's set)
  for (const q of qs) {
    const s = run(q, CIX, CCTX);
    if (s.rule !== 4) continue;
    n++;
    if (s.sections[0] && s.sections[0].name === 'games' && s.sections.length > 1) { lead++; const r = s.sections[0].rows[0]; assert.ok(r.kind === 'field' && !r.nearby && r.count > 0, `${q}: Games leads on ${r.label}`); }
    if (s.enter && s.enter.kind === 'field') assert.ok(s.enter.count > 0, `${q}: enter is an empty field`);
  }
  // #177: shares (96.5% of the queries are rule 4, 11.2% of those led by Games when set); floors 75% (doubled places: 84%) and 3% (doubled places and no California fields: 4.7%)
  assert.ok(n >= 0.75 * qs.size && lead >= 0.03 * n, `${n} of ${qs.size} place queries, ${lead} led by Games`);
  // #197: the named places on the frozen fixture
  for (const q of ['Naperville', 'Tulsa', 'Lake Forest', 'Orange']) assert.equal(run(q).sections[0].name, 'teams', q);
  assert.deepEqual(run('Redmond').sections.map(x => x.name), ['events', 'games', 'teams'], 'P03');
  assert.equal(run('Weston').sections[0].name, 'games');
  const f = run('Farmington');
  assert.deepEqual([f.sections.map(x => x.name), f.enter, f.empty], [['games'], null, null], 'Farmington: honest coverage, no false Enter target');
});
test('build point 2: a place whose fields match every word shows no partial guesses (San Francisco, on main: San Diego Fall, San Diego Surf, San Juan SC, all partial)', () => {
  const s = run('San Francisco'), old = run('San Francisco', IX, CTX, { games: false });   // #197: the frozen fixture
  assert.equal(old.empty.reason, 'no-full-match', 'without games: partial guesses');
  assert.ok(old.sections.every(x => x.partialOnly) && sec(old, 'teams').some(r => /San Diego Surf/.test(r.club)));
  assert.deepEqual(s.sections.map(x => x.name), ['games']);
  assert.ok(sec(s, 'games').every(r => r.kind === 'field' && !r.partial && /San Francisco, CA/.test(r.place)));
  assert.equal(s.empty, null);
  // the census places and counties whose Teams and Events change are all of this kind
  let changed = 0;
  for (const q of placeNames(CDATA.places)) {
    const a = run(q, CIX, CCTX), b = run(q, CIX, CCTX, { games: false });
    const sig = x => JSON.stringify(x.sections.filter(y => y.name !== 'games').map(y => [y.name, y.rows.length]));
    if (sig(a) === sig(b)) continue;
    changed++;
    assert.equal(b.empty && b.empty.reason, 'no-full-match', `${q}: only partial guesses go`);
    assert.ok(sec(a, 'games').some(r => r.kind === 'field') && !a.sections.some(x => x.partialOnly), q);
  }
  // #177: a ceiling as a share of the places (4.9% when set), so more places cannot break it: at most 10%
  const nPlaces = placeNames(CDATA.places).length;
  assert.ok(changed > 0 && changed <= 0.1 * nPlaces, `${changed} of ${nPlaces} place queries change`);
});
test('the best match is never a game, and there is none when Games leads; Enter waits while a games-first query\'s season is pending', () => {
  for (const q of keystrokes(doc)) { const s = run(q); if (s.best) assert.notEqual(s.best.section, 'games', q); if (s.sections[0] && s.sections[0].name === 'games') assert.equal(s.best, null, q); }
  const pend = run('Pateadores vs Slammers 2024-25');
  assert.deepEqual(pend.coverage.map(c => c.state), ['not-loaded']);
  assert.deepEqual([pend.best, pend.enter], [null, null], 'no best match, Enter not committed (as 4a MF4)');
  assert.equal(run('Pateadores vs Slammers 2024-25', IX, { ...CTX, gamesLoading: ['2024-25'] }).enter, null);
  const done = run('Pateadores vs Slammers 2024-25', fixture(['2026-27', '2024-25']));
  assert.equal(done.enter.kind, 'pairing');
  // C07: rule 5's tie leaves Games after Teams and Events
  assert.notEqual(run('Northwest 2023-24', fixture(['2026-27', '2023-24'])).sections[0].name, 'games');
});

// ---------- work ----------
test('nit 1: gamesVisited counts every game looked at (a date scans the season); nit 2: the marks are reset even when a search throws', () => {
  const st = { gamesVisited: 0, teamSearches: 0 };
  run('10/17', IX, CTX, { stats: st });
  assert.equal(st.gamesVisited, IX.games.get('2026-27').N);
  const G = IX.games.get('2026-27'), real = G.flights.get;
  let calls = 0;
  G.flights.get = function (k) { if (++calls === 50) throw new Error('boom'); return real.call(this, k); };
  try { assert.throws(() => run('U15 10/17'), /boom/); } finally { G.flights.get = real; }
  assert.ok(G.mark.every(x => x === 0) && G.ms.every(x => x === 0), 'no stale marks');
  assert.equal(sec(run('MVLA'), 'games').length, sec(run('MVLA'), 'games').length);
});

// ---------- #167: Games left for later (the draw addendum v2, S1 and MF1, MF3) ----------
// The queries the Reviewer named (6230407924, 6230432011): `ml`, `Sacra` and the rest are the ones whose empty.reason a
// search with no games installed would turn from no-match into games-loading; they are derived here as such.
const NAMED = ['ml', 'Sacra', 'San de', 'U1', 'playoffs 2025-', 'showcase 202', 'Legends Del Ma', 'Surf Cup', 'san dei', 'MVLA 201',
  'U15 NorCal vs U15 Texas', 'NorCal U15 vs Mustang', 'U15 NorCal vs Surf',   // rule 1 on both sides of a vs: never deferred
  'colorado academy'];   // a field name that is also a team's, read beside its Teams rows: never deferred
const textHash = s => createHash('sha256').update(slateText(s)).digest('hex');
const LATER_SET = (() => {
  const base = [...new Set([...reviewSet(CDATA.core, CDATA.places, doc), ...keystrokes(doc), ...NAMED])];
  const bare = S.buildIndex(committed());   // no games installed, the active season reported loading
  const loadingCtx = { ...CCTX, gamesLoading: [bare.vocab.active] };
  // each query's slate searched once (the three tests below compare with it): its text as a hash, its stats
  const ref = new Map();
  for (const q of base) { const stats = {}, full = run(q, CIX, CCTX, { stats }); ref.set(q, { full, text: textHash(full), stats }); }
  const flipped = base.filter(q => { const a = ref.get(q).full, b = run(q, bare, loadingCtx); return a.empty && a.empty.reason === 'no-match' && b.empty && b.empty.reason === 'games-loading'; });
  return { all: base, flipped, ref };
})();
// #177: a place name never defers (it reads no Teams or Events), so the shares of queries that defer or reuse are taken of the
// queries that are not place names: more places (a refresh adding census places) cannot lower them. 1535 of 2208 when set.
const PLACE_QS = new Set(placeNames(CDATA.places)), NONPLACE = LATER_SET.all.filter(q => !PLACE_QS.has(q)).length;

test('#167 S1, MF1: completeGames(search(q, later)) is search(q), rows in full (getters too), on the review set, every judged keystroke and the named queries; a deferred season is ready, never loading', () => {
  const { all, flipped } = LATER_SET;
  // #177 (C1): the absolute floor stays: 73 when set, and it held at 73 while the set grew from 2072 to 2208 queries
  assert.ok(flipped.length >= 60, `${flipped.length} queries a games-less search would call loading`);
  // #197: the seven the Reviewer named flip on the frozen fixture (a bare index reports the active season loading), not by name in the live set
  const FB = S.buildIndex(loadSearchData()), fbCtx = { ...CTX, gamesLoading: [FB.vocab.active] };
  for (const q of ['ml', 'Sacra', 'San de', 'U1', 'playoffs 2025-', 'showcase 202', 'Legends Del Ma']) assert.deepEqual([run(q).empty && run(q).empty.reason, run(q, FB, fbCtx).empty && run(q, FB, fbCtx).empty.reason], ['no-match', 'games-loading'], q);
  let deferred = 0;
  for (const q of all) {
    const want = LATER_SET.ref.get(q).text, st = {}, l = run(q, CIX, CCTX, { games: 'later', stats: st });
    if (!l.gamesPending) { assert.equal(textHash(l), want, `${q}: nothing deferred, the same slate`); continue; }
    deferred++;
    assert.ok(!l.coverage.some(c => c.state === 'loading') && !(l.empty && l.empty.reason === 'games-loading'), `${q}: MF1`);
    assert.equal(st.teamSearches, 1, `${q}: the keystroke's one team search`);
    const done = S.completeGames(CIX, l, CCTX, { stats: st });
    assert.equal(st.teamSearches, 1, `${q}: MF3: the games task searches no team`);
    assert.equal(textHash(done), want, q);
    assert.equal(S.completeGames(CIX, done, CCTX), done, 'a settled slate is returned as it is');
  }
  for (const q of flipped) assert.equal(run(q, CIX, CCTX, { games: 'later' }).empty.reason, 'no-match', `${q}: MF1`);
  // #177: a share of the queries that are not place names (67.2% when set); the old floor of 900 was 58.6% of them
  assert.ok(deferred >= 0.58 * NONPLACE, `${deferred} of ${NONPLACE} non-place queries deferred`);
});

test('#167 S1: later defers only under rules 1 and 5 with Teams or Events results; never under rules 2, 3, 4, on vs, on a partial slate (Surf Cup) or with nothing found', () => {
  let seen = { 2: 0, 3: 0, 4: 0, partial: 0 };
  for (const q of LATER_SET.all) {
    const full = LATER_SET.ref.get(q).full, l = run(q, CIX, CCTX, { games: 'later' });
    const partial = full.sections.some(x => x.rows.some(r => r.partial));
    if (l.gamesPending) {
      assert.ok([1, 5].includes(l.rule), `${q}: rule ${l.rule}`);
      assert.ok(!partial && full.sections.some(x => x.name !== 'games' && x.rows.length), `${q}: Teams or Events found, none partial`);
      assert.ok(!readQuery(CIX.vocab, q).vs, q);
    } else {
      if ([2, 3, 4].includes(full.rule)) seen[full.rule]++;
      if (partial) seen.partial++;
    }
  }
  // #177: shares of the set (2208 when set: 1.45%, 8.3%, 33.1%, 5.5%); floors 0.7% (it must survive three times the places), 4%, 28%, 3%
  const total = LATER_SET.all.length;
  assert.ok(seen[2] >= 0.007 * total && seen[3] >= 0.04 * total && seen[4] >= 0.28 * total && seen.partial >= 0.03 * total, `${JSON.stringify(seen)} of ${total}`);
  { const c = run('colorado academy', IX, CTX, { games: 'later' });   // #197: the three named queries run on the frozen fixture
     assert.ok(c.rule === 5 && c.sections[0].name === 'teams' && !c.gamesPending, 'a field name read beside Teams rows: rule 5, and its Games is searched at once'); }
  for (const q of ['U15 NorCal vs U15 Texas', 'NorCal U15 vs Mustang']) { const l = run(q, IX, CTX, { games: 'later' }); assert.ok(l.rule === 1 && !l.gamesPending, `${q}: a vs query under rule 1 is searched at once`); }
  const sc = run('Surf Cup', IX, CTX, { games: 'later' });
  assert.ok(!sc.gamesPending && sc.sections.every(x => x.rows.every(r => r.partial || x.name === 'games')), 'build point 1: partial rows never feed Games');
});

test('#167 MF3: Games from the Teams search already made equals a search of each name reading alone (teamsReuse: false), and makes one team search', () => {
  let reused = 0;
  for (const q of LATER_SET.all) {
    const { text, stats: a } = LATER_SET.ref.get(q), b = {};
    const y = run(q, CIX, CCTX, { stats: b, teamsReuse: false });
    assert.equal(textHash(y), text, q);
    if (a.teamSearches < b.teamSearches) { reused++; assert.equal(a.teamSearches, 1, q); }
  }
  // #177: a share of the queries that are not place names (62.7% when set); the old floor of 900 was 58.6% of them
  assert.ok(reused >= 0.53 * NONPLACE, `${reused} of ${NONPLACE} non-place queries spared a second team search`);
});

// ---------- #167 (review of #170, MF2): a field name never takes words away from Teams and Events ----------
test('MF2: Teams and Events read every field name (alone, with 2011, with U15) as if no field name were a phrase, rows in full; Games adds the field', () => {
  // the index with the field names' phrases taken out of the reader: what Teams and Events must equal
  const bare = S.buildIndex(committed()); load(bare, bare.vocab.active, COMMITTED);
  bare.vocab.byFirst = bare.vocab.byFirstBase;
  const names = CIX.vocab.phrases.filter(p => p.fieldName).map(p => p.value);
  assert.equal(names.length, LIVE_RULE.kept.length, 'one phrase for each name the rule keeps');
  let n = 0, field = 0;
  // Teams and Events, rows in full (every getter), and the best match unless it is a game. Partial guesses are left
  // out of the bare search: they come only when nothing matches every word, and a field name that matches is a
  // whole match (build point 2), so those are the by-design changes the review counts (525 partial-only queries).
  const whole = s => s.sections.filter(x => (x.name === 'teams' || x.name === 'events') && !x.rows.some(r => r.partial));
  const part = s => slateText({ rule: null, empty: null, coverage: [], best: s.best && s.best.section !== 'games' && !s.best.partial ? s.best : null, enter: null, sections: whole(s) });
  let partialOnly = 0;
  for (const name of names) for (const q of [name, `${name} 2011`, `${name} U15`]) {
    const a = run(q, CIX, CCTX), b = run(q, bare, CCTX);
    assert.equal(part(a), part(b), q);
    if (b.sections.some(x => x.rows.some(r => r.partial)) && !whole(b).length) partialOnly++;
    if (sec(a, 'games').some(r => r.kind === 'field')) field++;
    n++;
  }
  assert.ok(partialOnly > 0 && partialOnly < n, `${partialOnly} partial-only without the field names`);
  assert.equal(n, 3 * LIVE_RULE.kept.length);
  // #177: a share of the names run (97.6% when set; the count fell 8% between the #176 review and then with no refresh)
  assert.ok(field >= 0.9 * n, `${field} of ${n} with the field in Games (Q4)`);
});

test('MF2: Dallas Texans Lewisville is its 18 teams first, then Games with the field; colorado academy keeps the place Colorado; a field name with no team leads with Games', () => {
  // #197: every example runs on the frozen fixture (the committed data's counts move with every refresh)
  const d = run('Dallas Texans Lewisville');
  assert.equal(sec(d, 'teams').length, 18);
  assert.deepEqual(d.sections.map(x => x.name), ['teams', 'games']);
  assert.equal(d.rule, 5, 'Teams found every word: the field does not lead (rule 3 does not apply)');
  assert.ok(sec(d, 'games').some(r => r.kind === 'field' && /Dallas Texans Lewisville/i.test(r.name || r.field?.name || r.key)), 'Games holds the field');
  assert.equal(d.enter.section, 'teams');
  assert.equal(sec(run('Dallas Texans Lewisville 2011'), 'teams').length, 3);
  assert.equal(sec(run('dallas texans lewisville u15'), 'teams').length, 1);
  const c = run('colorado academy'), ct = sec(c, 'teams');
  assert.equal(ct.length, 5);
  assert.ok(ct.every(r => (r.namedPlace || []).join(' ') === 'colorado'), 'the state Colorado, as on main');
  assert.equal(c.rule, 5);
  const f = run('Canyon Crest Academy');
  assert.equal(f.rule, 3, 'a field name no team or event holds: Games first (Q4)');
  assert.equal(f.sections[0].name, 'games');
  for (const q of ['Great Park', 'Surf Sports Park', 'Great Park field 15']) assert.equal(run(q).rule, 3, `${q}: a field alias leads, as before`);
});

// ---------- #169 + #162 (owner decisions Q1-Q11): the reviewed aliases, counties and place fixes ----------
test('#169 (Q9, review MF3): a field alias\'s words never join the known words, so they cannot switch off a typo match', () => {
  const plainData = loadSearchData(); plainData.places.vocab = { ...plainData.places.vocab, fieldAliases: {} };
  const plain = S.buildIndex(plainData); load(plain, plain.vocab.active);
  assert.deepEqual([...IX.known].sort(), [...plain.known].sort(), 'the 78 alias phrases add no known word');
  const rows = s => s.sections.filter(x => x.name !== 'games').map(x => [x.name, x.rows.map(r => r.key || r.eventID)]);
  for (const q of ['turf', 'high', 'arena', 'aksc', 'wide', 'pleasent', 'Bay Arena Surf', 'West Wide Alliance', 'Turf Cup', 'The Wellington School (Turf)']) {
    assert.deepEqual(rows(run(q)), rows(run(q, plain)), `${q}: Teams and Events as without the aliases`);
  }
  assert.equal(sec(run('turf'), 'teams')[0].clubID, 3986, 'turf is still read as a typo of Bay Area Surf');
  assert.equal(sec(run('Bay Arena Surf'), 'teams')[0].clubID, 3986);
  assert.ok(sec(run('Bay Arena Surf'), 'games').length > 0, 'Bay Arena Surf keeps its games');
});
test('#169: two spellings of one field are one row (D6): Grass Lawn Park @ 98052', () => {
  for (const q of ['grass lawn park', 'grasslawn park', 'Grass Lawn Park']) {
    const g = sec(run(q), 'games');
    assert.deepEqual(g.map(r => [r.kind, r.key, r.place]), [['field', 'Grass Lawn Park@98052', 'Redmond, WA']], q);
    assert.deepEqual(g[0].seasons, ['2020-21', '2024-25'], 'complex 1515 (2020-21) and complex 2859 (2024-25)');
  }
  const red = sec(run('Redmond'), 'games').filter(r => r.kind === 'field');
  assert.deepEqual(red.filter(r => /grass ?lawn/i.test(r.label)).map(r => r.key), ['Grass Lawn Park@98052']);
});
test('#162: the place fixes (Q4-Q6) on the frozen fixture, with the knock-ons of review N5; the entries of #195 change nothing', () => {
  const near = (q, club) => sec(run(q), 'teams').some(r => r.clubID === club && r.nearby);
  // review MF1: the 4 county entries and the Knoxville and Plymouth fixes moved to #195. Until then these searches are as on main.
  for (const [q, club] of [['Mercer County', 3313], ['Macomb County', 1713], ['Worcester County', 94], ['Baltimore County', 3405]]) assert.ok(!near(q, club), `${q}: club ${club} has no county yet (#195)`);
  assert.equal(run('Mercer County').sections.length, 0, 'no club, field or event is in Mercer County yet');
  for (const q of ['Newington', 'Newington CT', 'Briarcliff']) assert.equal(run(q).sections.length, 0, `${q}: no field or club is there any more`);
  const hartford = sec(run('Hartford County'), 'games').filter(r => r.kind === 'field' && /@06032$/.test(r.key));
  assert.ok(hartford.length && hartford.every(r => r.place === 'Hartford County, CT'), 'the 06032 fields have no city, only their county');
  assert.ok(hartford.some(r => r.label === 'FSA-Farmington Sports Arena'));
  const knox = sec(run('Knoxville'), 'games').find(r => r.kind === 'field' && r.key === 'hardin valley academy stadium@37932');
  assert.ok(knox && knox.place === 'Farragut, TN' && knox.nearby, 'Hardin Valley Academy is still labelled Farragut (#195)');
  assert.ok(!sec(run('Plymouth'), 'games').some(r => r.key === 'plymouth north stadium@02360'), 'Plymouth North is still labelled The Pinehills (#195)');
  const worc = run('Worcester');
  const stj = sec(worc, 'games').filter(r => r.kind === 'field' && r.key === 'st johns fields@01545');
  assert.deepEqual(stj.map(r => [r.place, !!r.nearby]), [['Worcester County, MA', true]], 'St. Johns Fields (Shrewsbury): no city, only Nearby through the county');
  assert.ok(!sec(worc, 'games').some(r => r.place === 'Worcester, MA'), 'no field is labelled Worcester any more');
  assert.ok(sec(worc, 'teams').every(r => r.nearby) && !near('Worcester', 94), 'Worcester city left: the county answers; Scorpions SC has no county until #195');
  assert.equal(run('The Pinehills').sections.length, 0, 'The Pinehills stays a place, as on main: an empty slate');
});
