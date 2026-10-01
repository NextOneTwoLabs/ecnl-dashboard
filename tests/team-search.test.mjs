// #114: the team search engine, extracted from public/index.html (the TEAM_SEARCH block) and run
// on the committed team directory (public/archive/directory.json). A result is a team: one club
// and age group, i.e. one #107 squad. Every expected set is derived here from the history files
// (squads, names, seasons, birth years) and clubs.json (each club's city and state), never from
// the engine, and no test writes down a total that a data refresh can change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('\n    const TEAM_SEARCH = (() => {\n') + 1;
const end = html.indexOf('\n    })();\n', start) + '\n    })();\n'.length;
assert.ok(start > 0 && end > start, 'the TEAM_SEARCH block in index.html');
const ENGINE = new Function(html.slice(start, end) + '\nreturn TEAM_SEARCH;')();
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const db = ENGINE.prepare(read('archive/directory.json'));
const catalog = read('data/sources.json');
const ACTIVE = catalog.refresh.activeSeason;
const places = read('archive/clubs.json').clubs;
const u = (season, div) => ((catalog.seasons[season].ageGroups || {})[div] || {}).u;

const squads = new Map();
const historyDir = new URL('archive/history/', root);
for (const f of readdirSync(historyDir)) {
  for (const sq of JSON.parse(readFileSync(new URL(f, historyDir), 'utf8')).squads) squads.set(`${sq.seasons[0].season}/${sq.seasons[0].teamID}`, sq);
}
const last = sq => sq.seasons[sq.seasons.length - 1];
const current = sq => last(sq).season === ACTIVE;
const named = (sq, re) => sq.seasons.some(s => re.test(s.name)) || (sq.clubID !== 7 && re.test(sq.clubName));
const placeOf = sq => (sq.clubID === 7 ? null : places[String(sq.clubID)]) || null;
const inState = (sq, st) => placeOf(sq)?.state === st;
const inCity = (sq, city) => (placeOf(sq)?.city || '').toLowerCase() === city;
const keysWhere = pred => new Set([...squads].filter(([, sq]) => pred(sq)).map(([k]) => k));
const keys = rs => new Set(rs.map(r => r.key));
const run = (q, opts) => ENGINE.search(db, q, { limit: 5000, ...opts });
// Every possible predecessor sits directly under one of its candidates (#107 maybe).
const maybeOrderHolds = r => r.results.forEach((x, i) => {
  if (x.continuesAs) assert.ok(x.continuesAs.includes(r.results[i - 1]) || r.results[i - 1].continuesAs, `${x.key} not under its candidate`);
});

// ---------- names, birth years, ages, seasons, conferences ----------
test('"MVLA 2011": the MVLA team(s) born 2011, linked to the team page in their latest season', () => {
  const r = run('MVLA 2011');
  const want = keysWhere(sq => named(sq, /\bmvla\b/i) && sq.birthYears.includes(2011));
  assert.ok(want.size >= 1);
  assert.deepEqual(keys(r.results), want);
  const l = last(squads.get(r.results[0].key));
  assert.equal(r.results[0].href, `#tab=teams&season=${l.season}&team=${l.teamID}&name=${encodeURIComponent(l.name)}`);
  // #114 owner decision: Enter opens the Overview (no view); Shift+Enter that season's tab.
  assert.equal(r.results[0].overviewHref, r.results[0].href);
  assert.equal(r.results[0].seasonHref, r.results[0].href + '&view=season');
  for (const q of ['MVLA G11', 'mvla g2011', 'MVLA 2011G']) assert.deepEqual(keys(run(q).results), want, q);
});

test('"MVLA": every MVLA team; current ones first, oldest age group first', () => {
  const r = run('MVLA');
  assert.deepEqual(keys(r.results), keysWhere(sq => named(sq, /\bmvla\b/i)));
  const cur = r.results.filter(x => x.current);
  assert.deepEqual(r.results.slice(0, cur.length), cur);
  const us = cur.map(x => x.doc.rows.at(-1).u);
  assert.deepEqual(us, [...us].sort((a, b) => b - a));
  maybeOrderHolds(r);
});

test('"U15 NorCal", "U15 NorCal 2024-25", "G2010/11 NorCal": one table each, in table order', () => {
  const table = (season, pick) => keysWhere(sq => sq.seasons.some(s => s.season === season && s.conference === 'NorCal' && pick(s)));
  const cases = [['U15 NorCal', table(ACTIVE, s => u(ACTIVE, s.division) === 15)],
    ['U15 NorCal 2024-25', table('2024-25', s => u('2024-25', s.division) === 15)],
    ['G2010/11 NorCal', keysWhere(sq => sq.seasons.some(s => s.conference === 'NorCal' &&
      JSON.stringify((catalog.seasons[s.season].ageGroups[s.division] || {}).birthYears) === '[2010,2011]'))]];
  for (const [q, want] of cases) {
    const r = run(q);
    assert.deepEqual(keys(r.results), want, q);
    assert.deepEqual(r.results.map(x => x.rank), r.results.map(x => x.rank).sort((a, b) => a - b), q);
  }
  // D2: a query that names a season opens that season's tab.
  assert.ok(run('U15 NorCal 2024-25').results.every(x => x.href.includes('season=2024-25') && x.href.endsWith('&view=season')));
  assert.ok(run('U15 NorCal').results.every(x => !x.href.includes('view=')), 'no season named: Overview');
});

test('"MVLA 2011 2024-25": a team in a named season opens that season', () => {
  const r = run('MVLA 2011 2024-25');
  assert.deepEqual(keys(r.results), keysWhere(sq => named(sq, /\bmvla\b/i) && sq.birthYears.includes(2011) && sq.seasons.some(s => s.season === '2024-25')));
  assert.ok(r.results.every(x => x.href.includes('season=2024-25') && x.href.endsWith('&view=season')));
  assert.ok(r.results.every(x => x.overviewHref.startsWith('#tab=teams&season=') && !x.overviewHref.includes('view=')));
});

test('"Slamers" (typo) finds every Slammers team; "UFA 2004" a club by its initials', () => {
  assert.deepEqual(keys(run('Slamers').results), keysWhere(sq => named(sq, /slammers/i)));
  const ufa = run('UFA 2004');
  assert.deepEqual(keys(ufa.results), keysWhere(sq => /united futbol academy/i.test(sq.clubName) && sq.birthYears.includes(2004)));
  assert.ok(ufa.results.every(x => !x.current && x.href.includes(`season=${x.last}`)));
});

for (const side of ['Royal', 'Black']) {
  test(`M2: "Sting ${side} 2012" puts the team that is Sting ${side} now first`, () => {
    const r = run(`Sting ${side} 2012`);
    const now = keysWhere(sq => sq.birthYears.includes(2012) && new RegExp(`\\bsting ${side}\\b`, 'i').test(last(sq).name));
    assert.ok(now.size >= 1);
    assert.deepEqual(keys(r.results.slice(0, now.size)), now);
  });
}

test('S4: sister sides and colliding titles are always told apart', () => {
  for (const q of ['Concorde Fire 2013', 'MVLA 2002', 'Sting 2012']) {
    const labels = run(q).results.map(x => `${x.title} ${ENGINE.bornText(x.born)} ${x.distinct || ''}`);
    assert.equal(new Set(labels).size, labels.length, q);
  }
  assert.ok(run('MVLA 2002').results.some(x => x.distinct), 'two MVLA born 2002/03 teams in 2020-21');
});

test('S3: a possible predecessor sits under its candidate, its hint first', () => {
  for (const q of ['PDA Blue 2009', 'Fairfax 2008']) {
    const r = run(q);
    assert.ok(r.results.some(x => x.continuesAs), q);
    assert.ok(r.results.filter(x => x.continuesAs).every(x => x.desc.startsWith('May continue')), q);
    maybeOrderHolds(r);
  }
});

test('a search needs a team name, a place, or an age group (or band) and a conference', () => {
  for (const q of ['U15', '2011', '2024-25', 'NorCal', 'U15 2024-25', 'Champions League', 'Playoffs']) {
    const r = run(q);
    assert.ok(r.results.every(x => x.doc.rows.some(row => /champions|league|playoffs/i.test(row.name))), q);
    if (!/league|playoffs/i.test(q)) assert.equal(r.total, 0, q);
  }
});

test('S7: club 7\'s name ("No Club Selection") is not a search word', () => {
  assert.ok(run('selection').results.every(x => x.doc.rows.some(row => /selection/i.test(row.name))));
});

// ---------- places (plan114place, D-P1 to D-P4, and the review's must-fixes) ----------
test('"california", "CA", "teams in California": every team based in California playing now', () => {
  const want = keysWhere(sq => current(sq) && (inState(sq, 'CA') || named(sq, /\bcalifornia\b/i)));
  assert.ok(want.size > 60, 'more than the 60 rows shown');
  for (const q of ['california', 'CA', 'California', 'teams in California']) assert.deepEqual(keys(run(q).results), want, q);
  assert.equal(ENGINE.search(db, 'california').results.length, 60, 'the page shows 60 rows, then a hint');
});

test('D-P2: "texas" (and "texas 2011") is the state; "U15 Texas" the conference table', () => {
  assert.deepEqual(keys(run('texas').results), keysWhere(sq => current(sq) && inState(sq, 'TX')));
  assert.deepEqual(keys(run('TX').results), keys(run('texas').results));
  assert.deepEqual(keys(run('texas 2011').results), keysWhere(sq => inState(sq, 'TX') && sq.birthYears.includes(2011)));
  const table = keysWhere(sq => sq.seasons.some(s => s.season === ACTIVE && s.conference === 'Texas' && u(ACTIVE, s.division) === 15));
  assert.deepEqual(keys(run('U15 Texas').results), table);
  assert.ok([...table].some(k => !inState(squads.get(k), 'TX')), 'the conference also holds clubs outside Texas');
});

test('state names of one and two words, and a city that starts with one', () => {
  for (const [q, st] of [['new jersey', 'NJ'], ['virginia', 'VA'], ['north carolina', 'NC']])
    assert.deepEqual(keys(run(q).results), keysWhere(sq => current(sq) && (inState(sq, st) || named(sq, new RegExp(`\\b${q}\\b`, 'i')))), q);
  assert.deepEqual(keys(run('virginia beach').results), keysWhere(sq => current(sq) && (inCity(sq, 'virginia beach') || named(sq, /virginia beach/i))));
});

test('a place narrows like any filter: "california 2011", "U15 california", "MVLA california"', () => {
  const ca = sq => inState(sq, 'CA') || named(sq, /\bcalifornia\b/i);
  assert.deepEqual(keys(run('california 2011').results), keysWhere(sq => ca(sq) && sq.birthYears.includes(2011)));
  assert.ok(run('california 2011').results.some(x => !x.current), 'a narrowed place query lists ended teams too');
  assert.deepEqual(keys(run('U15 california').results), keysWhere(sq => ca(sq) && sq.seasons.some(s => s.season === ACTIVE && u(ACTIVE, s.division) === 15)));
  assert.deepEqual(keys(run('MVLA california').results), keysWhere(sq => named(sq, /\bmvla\b/i) && ca(sq)));
});

test('cities with several clubs: "dallas", "dallas 2012", "costa mesa"', () => {
  assert.ok(new Set([...squads.values()].filter(sq => inCity(sq, 'dallas')).map(sq => sq.clubID)).size >= 2);
  const dallas = sq => inCity(sq, 'dallas') || named(sq, /\bdallas\b/i);
  assert.deepEqual(keys(run('dallas').results), keysWhere(sq => current(sq) && dallas(sq)));
  assert.deepEqual(keys(run('dallas 2012').results), keysWhere(sq => dallas(sq) && sq.birthYears.includes(2012)));
  assert.deepEqual(keys(run('costa mesa').results), keysWhere(sq => current(sq) && inCity(sq, 'costa mesa')));
});

test('must-fix 3: a bare place word lists current teams only, also teams named for it ("dallas", "phoenix")', () => {
  for (const [q, re] of [['dallas', /\bdallas\b/i], ['phoenix', /\bphoenix\b/i]]) {
    const ended = keysWhere(sq => !current(sq) && named(sq, re));
    assert.ok(ended.size > 0, `${q}: some teams named for it have ended`);
    const got = keys(run(q).results);
    for (const k of ended) assert.ok(!got.has(k), `${q}: ${k} is not listed on its own`);
    // ... and a season brings them back.
    const season = last(squads.get([...ended][0])).season;
    assert.ok(keys(run(`${q} ${season}`).results).has([...ended][0]), `${q} ${season}`);
  }
  const ph = run('phoenix');
  const firstOther = ph.results.findIndex(x => !/phoenix/i.test(x.name));
  assert.ok(firstOther > 0 && ph.results.slice(firstOther).every(x => !/phoenix/i.test(x.name)), 'a city: its namesake first');
});

test('D-P1: "SC" alone is South Carolina; "Mustang SC" and "Rush CO" read a code by place or name', () => {
  assert.deepEqual(keys(run('SC').results), keysWhere(sq => current(sq) && inState(sq, 'SC')));
  assert.ok(keysWhere(sq => named(sq, /\bsc\b/i)).size > 5 * run('SC').total, '"SC" is in many more names');
  assert.deepEqual(keys(run('Mustang SC').results), keysWhere(sq => named(sq, /\bmustang\b/i) && (inState(sq, 'SC') || named(sq, /\bsc\b/i))));
  assert.deepEqual(keys(run('Rush CO').results), keysWhere(sq => named(sq, /\brush\b/i) && (inState(sq, 'CO') || named(sq, /\bco\b/i))));
});

test('must-fix 1: a club named for a place plus a code ("Tulsa SC", "Tennessee SC") keeps its ended teams', () => {
  for (const [q, re] of [['Tulsa SC', /\btulsa\b/i], ['Tennessee SC', /\btennessee\b/i]]) {
    const want = keysWhere(sq => named(sq, re) && (inState(sq, 'SC') || named(sq, /\bsc\b/i)));
    assert.ok([...want].some(k => !current(squads.get(k))), `${q}: has ended teams`);
    assert.deepEqual(keys(run(q).results), want, q);
  }
});

test('must-fix 2: a place whose teams have all ended lists them all, with a note', () => {
  const cityOf = sq => (placeOf(sq)?.city || '').toLowerCase();
  const at = (sq, c) => cityOf(sq) === c || named(sq, new RegExp(`\\b${c.replace(/[^a-z ]/g, '.')}\\b`, 'i'));
  const ended = [...new Set([...squads.values()].map(cityOf).filter(Boolean))]
    .filter(c => ![...squads.values()].some(sq => at(sq, c) && current(sq)) && !db.phrases.some(p => p.type === 'state' && p.words.join(' ') === c));
  assert.ok(ended.length > 0, 'the archive has places whose clubs have all left');
  for (const c of ended) {
    const r = run(c);
    assert.ok(r.total > 0, c);
    assert.equal(r.note && r.note.kind, 'ended', c);
    assert.ok(keysWhere(sq => cityOf(sq) === c).size <= r.total, c);
  }
});

test('should-consider: a code for a state with no club offers its name reading ("LA", "DE")', () => {
  for (const code of ['LA', 'DE']) {
    assert.equal(keysWhere(sq => inState(sq, code)).size, 0, `${code}: no club based there`);
    const r = run(code);
    assert.equal(r.note && r.note.kind, 'name', code);
    assert.ok(r.total > 0 && r.results.every(x => [...x.doc.latest, ...x.doc.older].some(w => w.startsWith(code.toLowerCase()))), code);
  }
});

test('should-consider: several places together match any of them ("NJ NY", "california texas")', () => {
  assert.deepEqual(keys(run('NJ NY').results), keysWhere(sq => current(sq) && (inState(sq, 'NJ') || inState(sq, 'NY'))));
  assert.deepEqual(keys(run('california texas').results),
    keysWhere(sq => current(sq) && (inState(sq, 'CA') || inState(sq, 'TX') || named(sq, /\bcalifornia\b/i))));
});

test('"in", "or", "me" are places only on their own; "de anza" is a name', () => {
  assert.deepEqual(keys(run('IN').results), keysWhere(sq => current(sq) && inState(sq, 'IN')));
  assert.deepEqual(keys(run('teams in california').results), keys(run('california').results));
  assert.ok(run('de anza').total > 0 && run('de anza').results.every(x => x.doc.rows.some(r => /de anza/i.test(r.name))));
});

test('clubs with no place (club 7 and the null places) never match a place', () => {
  const noPlace = new Set([...squads.values()].filter(sq => !placeOf(sq)).map(sq => sq.clubID));
  assert.ok(noPlace.has(7), 'club 7');
  assert.ok(noPlace.size >= 2, 'and at least one club with a null place');
  const states = [...new Set(Object.values(places).filter(Boolean).map(p => p.state))];
  for (const st of states) for (const x of run(st).results) assert.ok(!noPlace.has(x.club.id), `${st}: club ${x.club.id}`);
});

test('D-P4: a place list is ordered by club, then team line, then oldest age group', () => {
  for (const q of ['california', 'texas', 'virginia', 'SC']) {
    const r = run(q).results.filter(x => !x.continuesAs);
    const seenClubs = [];
    for (const x of r) if (seenClubs.at(-1) !== x.club.name) { assert.ok(!seenClubs.includes(x.club.name), `${q}: ${x.club.name} split`); seenClubs.push(x.club.name); }
    assert.deepEqual(seenClubs, [...seenClubs].sort((a, b) => a.localeCompare(b)), `${q}: clubs A to Z`);
    for (let i = 1; i < r.length; i++) {
      if (r[i].club.name === r[i - 1].club.name && r[i].title === r[i - 1].title)
        assert.ok(r[i].doc.rows.at(-1).u <= r[i - 1].doc.rows.at(-1).u, `${q}: ${r[i].title} oldest first`);
    }
  }
});

// ---------- every team can be found ----------
test('every squad ranks in the top 3 for "<team> <birth year> <season>", and for its own TGS name', () => {
  const worst = [];
  for (const [k, sq] of squads) {
    const l = last(sq);
    for (const q of [`${ENGINE.teamTitle(l.name, sq.clubName)} ${sq.birthYears[0]} ${l.season}`, `${l.name} ${l.season}`]) {
      const i = run(q).results.findIndex(x => x.key === k);
      if (i > 2 || (i < 0 && !q.startsWith(l.name))) worst.push(`${q} -> ${i}`);
    }
  }
  assert.deepEqual(worst, []);
});
