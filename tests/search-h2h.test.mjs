// #178 (#149 phase 1, PR 6): the head to head in the search modules (public/search/games.mjs: squadAt, resolveSide,
// parseVs, h2hSeasons, headToHead, candidateList, h2hRow, gameH2HHref, GameRow.h2hHref, the lead row and the pairing
// rows' squad pairs). The page's side of it is tests/h2h-page.test.mjs; where the links go is
// tests/search-game-links.test.mjs. Every exact count is pinned on the frozen fixture (tests/search/fixtures/search/,
// #175/#176): on the committed data, which a refresh moves, this file asserts rules and properties, never counts.
//   node --import ./tests/netguard/netguard.mjs --test tests/search-h2h.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJSON, readLF, HERE, ROOT, loadSearchData, loadGames, modulesContext } from './search/judged.mjs';

const S = await import(new URL('public/search/search.mjs', ROOT));
const G = await import(new URL('public/search/games.mjs', ROOT));
const doc = readJSON(new URL('queries.json', HERE));
const CTX = modulesContext(doc.context);   // today 2026-10-15 (America/Los_Angeles)
const TODAY = '2026-10-20';
const loadSeason = (ix, s, dir) => { const g = S.startGames(ix, dir ? readJSON(new URL(`games-${s}.json`, dir)) : loadGames(s), Infinity); let r; while (!(r = g.next()).done); return r.value; };
const fixture = (seasons = null) => { const ix = S.buildIndex(loadSearchData()); for (const s of seasons || ix.vocab.seasons) loadSeason(ix, s); return ix; };
const IX = fixture();   // every season loaded
const ACTIVE = S.buildIndex(loadSearchData()); loadSeason(ACTIVE, ACTIVE.vocab.active);   // as after the first focus
const COMMITTED = new URL('public/archive/search/', ROOT);
const CIX = S.buildIndex({ core: JSON.parse(readLF(new URL('core.json', COMMITTED))), places: JSON.parse(readLF(new URL('places.json', COMMITTED))) });
for (const s of CIX.vocab.seasons) loadSeason(CIX, s, COMMITTED);
const sec = (s, name) => (s.sections.find(x => x.name === name) || { rows: [] }).rows;
const run = (q, ix = ACTIVE, ctx = CTX) => S.search(ix, q, ctx);
const h2h = (ix, sa, ta, sb, tb, xa = [], xb = []) => {
  const A = S.resolveSide(ix, sa, ta), B = S.resolveSide(ix, sb, tb), sq = S.squadAt(ix);
  return { A, B, h: S.headToHead(ix, [A.doc, ...xa.map(k => sq.get(k))], [B.doc, ...xb.map(k => sq.get(k))], { today: TODAY }) };
};
const ids = h => h.meetings.map(m => m.matchID);

test('squadAt: no (season, team id) belongs to two squads, and an alias id (a showcase\'s own) maps to its squad; the page\'s vs= pattern is the module\'s', () => {
  for (const ix of [IX, CIX]) {
    const seen = new Map();
    for (const d of ix.teams.docs) {
      for (const k of [...d.rows.map(r => `${r.season}/${r.teamID}`), ...d.x.map(x => `${x.season}/${x.teamID}`)]) {
        assert.ok(!seen.has(k) || seen.get(k) === d, `${k} is in two squads`);
        seen.set(k, d);
      }
    }
    assert.equal(S.squadAt(ix).size, seen.size);
  }
  const alias = IX.teams.docs.flatMap(d => d.x.map(x => [x, d]))[0];
  assert.equal(S.squadAt(IX).get('2025-26/112470').rows.some(r => r.season === '2025-26' && r.teamID === 69910), true, 'Phoenix Spring 112470 is MVLA-side squad 69910 in 2025-26');
  assert.ok(alias);
  const page = readLF(new URL('public/index.html', ROOT)), m = /const H2H_VS_RE = (\/.*\/);/.exec(page);
  assert.ok(m, 'the page has the pattern');
  assert.equal(m[1], String(G.VS_RE), 'index.html and games.mjs read vs= alike');
});

test('parseVs: <season>:<team id> and nothing else', () => {
  assert.deepEqual(S.parseVs('2026-27:55477'), { season: '2026-27', teamID: 55477 });
  for (const bad of ['abc', '2026-27', '2026-27:0', '2026-27:01', '26-27:5', '2026-27:5x', ':5', '', null, undefined, '2026-27:12345678901']) assert.equal(S.parseVs(bad), null, String(bad));
});

test('resolveSide: a known side, no-squad, unknown-season; candidates are listed, never merged', () => {
  const a = S.resolveSide(IX, '2026-27', 60044);
  assert.equal(a.key, '2026-27/60044');
  assert.deepEqual(a.candidates.map(c => c.key), ['2021-22/60044', '2022-23/62271'], 'two candidate earlier teams, in order, none chosen');
  assert.deepEqual(S.resolveSide(IX, '2025-26', 113270), { error: 'no-squad' }, 'an RL team with no squad');
  assert.deepEqual(S.resolveSide(IX, '2019-20', 5), { error: 'unknown-season' });
  assert.equal(S.resolveSide(IX, '2026-27', 134858).candidates.length, 4, 'SLSG Navy G2009/10 has 4 candidates');
  const before = JSON.stringify(S.resolveSide(IX, '2026-27', 60044).doc.rows);
  h2h(IX, '2026-27', 60044, '2022-23', 33633, ['2022-23/62271']);
  assert.equal(JSON.stringify(S.resolveSide(IX, '2026-27', 60044).doc.rows), before, 'adding a candidate to a head to head merges nothing');
});

test('headToHead: MVLA 55477 v Mustang 31529 over every season both played; the mirror; newest first, seasons grouped', () => {
  const { A, B, h } = h2h(IX, '2023-24', 55477, '2023-24', 31529);
  assert.deepEqual(h.seasons.both, ['2023-24', '2024-25', '2025-26', '2026-27']);
  assert.deepEqual([h.record, h.goals, h.meetings.length, h.played], [[1, 4, 3], [7, 10], 8, 8]);
  assert.deepEqual([h.last.date, h.last.score], ['2026-08-30', [2, 1]]);
  assert.equal(h.next, null);
  const seasons = h.meetings.map(m => m.season);
  assert.deepEqual(seasons, [...seasons].sort().reverse(), 'seasons newest first');
  const m = S.headToHead(IX, [B.doc], [A.doc], { today: TODAY });
  assert.deepEqual([m.record, m.goals], [[3, 4, 1], [10, 7]], 'the mirror');
  assert.deepEqual(ids(m).sort(), ids(h).sort(), 'the same meetings');
});

test('MF4, Q3: a shoot-out is a win or a loss as on the team Overview, never goals: Slammers 42498 v LA Breakers 55512 is [5,3,1], goals 13-2, penalties won 0 lost 1; the next meeting', () => {
  const { h } = h2h(IX, '2021-22', 42498, '2021-22', 55512);
  assert.deepEqual([h.record, h.goals, h.pens, h.meetings.length], [[5, 3, 1], [13, 2], { won: 0, lost: 1 }, 10]);
  assert.deepEqual([h.next.date, h.next.time, h.next.field.label], ['2026-10-31', '09:00', 'Bell Gardens Sports Complex']);
  assert.equal(h.next.matchID, 1085613);
  assert.deepEqual([h.last.date, h.last.score, h.last.pk], ['2026-07-13', [1, 1], [5, 4]], 'the 1-1 game LA Breakers (home) won 5-4 on penalties is the last result, a loss for Slammers');
  // the mirror turns that loss into a win
  const r = h2h(IX, '2021-22', 55512, '2021-22', 42498).h;
  assert.deepEqual([r.record, r.pens], [[1, 3, 5], { won: 1, lost: 0 }]);
  // MVLA v Mustang's 2-2 had no shoot-out: still a draw
  assert.deepEqual(h2h(IX, '2023-24', 55477, '2023-24', 31529).h.pens, { won: 0, lost: 0 });
});

test('never met: MVLA 55477 v Solar 81882 played the same four seasons and no game between them is listed', () => {
  const { h } = h2h(IX, '2023-24', 55477, '2023-24', 81882);
  assert.deepEqual([h.meetings.length, h.record, h.seasons.both.length], [0, [0, 0, 0], 4]);
});

test('regroup: Force 60044 v MVLA 33633 has 2 meetings by default and 10 with 2022-23/62271 added; MF3: candidateList never lists the other side\'s squad and disables a team the other side added', () => {
  const base = h2h(IX, '2026-27', 60044, '2022-23', 33633);
  assert.deepEqual([base.h.meetings.length, base.h.seasons.both], [2, ['2026-27']]);
  const added = h2h(IX, '2026-27', 60044, '2022-23', 33633, ['2022-23/62271']);
  assert.deepEqual([added.h.meetings.length, added.h.record, added.h.goals], [10, [1, 0, 8], [8, 33]]);
  assert.deepEqual(added.h.seasons.both, ['2022-23', '2023-24', '2024-25', '2025-26', '2026-27']);
  // SLSG Navy G2013/14 (134824) v Green G2013/14 (134825): both list the other's G13 team
  const A = S.resolveSide(IX, '2026-27', 134824), B = S.resolveSide(IX, '2026-27', 134825), sq = S.squadAt(IX);
  const names = l => l.map(x => x.doc.latest.name);
  assert.deepEqual(names(S.candidateList(A, B, [], [])), ['SLSG Green ECNL G13', 'SLSG Navy ECNL G13']);
  assert.deepEqual(names(S.candidateList(B, A, [], [])), ['SLSG Green ECNL G13', 'SLSG Navy ECNL G13']);
  const navy13 = A.candidates.find(c => c.latest.name === 'SLSG Navy ECNL G13');
  const dis = S.candidateList(B, A, [], [navy13]).find(x => x.doc === navy13);
  assert.equal(dis.disabled, 'other-side', 'a team added on one side is listed disabled on the other');
  assert.equal(S.candidateList(A, B, [navy13], []).find(x => x.doc === navy13).chosen, true);
  const ok = S.headToHead(IX, [A.doc, navy13], [B.doc], { today: TODAY });
  assert.ok(!ok.error && ok.meetings.length === 2, 'the head to head returns the meetings, not an error');
  assert.deepEqual(S.headToHead(IX, [A.doc, navy13], [B.doc, navy13], { today: TODAY }), { error: 'same-team' }, 'the same team on both sides through the API');
  // a constructed vs= naming B's squad among A's candidates never lists it
  const own = S.candidateList(A, { ...B, doc: A.candidates[0] }, [], []);
  assert.ok(!own.some(x => x.doc === A.candidates[0]), 'the other side\'s own squad is not listed');
  assert.ok(sq.get('2026-27/134824') === A.doc);
});

test('MF3 on the data: SLSG Navy and Green each list the other\'s squad among their candidates, which candidateList never shows', () => {
  let clash = 0;
  for (const d of IX.teams.docs) for (const r of d.rows) if (r.season === '2026-27') {
    for (const c of d.maybePrev) for (const e of IX.teams.docs) if (e !== d && e.rows.some(x => x.season === '2026-27') && e.maybePrev.includes(c) && c.club.id === d.club.id && c.club.id === e.club.id) clash++;
  }
  assert.ok(clash > 0, 'the situation exists on the fixture');
  const A = S.resolveSide(IX, '2026-27', 134824), B = S.resolveSide(IX, '2026-27', 134825);
  for (const [x, y] of [[A, B], [B, A]]) assert.ok(!S.candidateList(x, y, [], []).some(c => c.doc === y.doc));
});

test('completeness on the fixture: 17,131 squad pairs and 46,686 meetings, each found by the modules as a direct scan of the games finds it; 39 + 327 + 1 games have no head to head (#179: the 16 reviewed orphan ids add 280 meetings and 18 pairs)', () => {
  const sq = S.squadAt(IX);
  const pairs = new Map(); let meetings = 0, tbd = 0, nosq = 0, same = 0;
  for (const s of IX.vocab.seasons) {
    const g = IX.games.get(s);
    for (let i = 0; i < g.N; i++) {
      if (!g.h[i] || !g.a[i]) { tbd++; continue; }
      const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`);
      if (!a || !b) { nosq++; continue; }
      if (a === b) { same++; continue; }
      meetings++;
      const k = `${a.key}|${b.key}`, r = pairs.get(k) || { a, b, ids: [] };
      r.ids.push(`${s}/${g.id[i]}`); pairs.set(k, r);
    }
  }
  assert.deepEqual([meetings, tbd, nosq, same], [46686, 39, 327, 1]);   // #179: 46,406 + 280; 607 - 280
  let wrong = 0;
  const seen = new Set();
  for (const [, r] of pairs) {
    const rk = [r.a.key, r.b.key].sort().join('|');
    if (seen.has(rk)) continue; seen.add(rk);
    const h = S.headToHead(IX, [r.a], [r.b], { today: TODAY });
    const want = new Set([...r.ids, ...(pairs.get(`${r.b.key}|${r.a.key}`) || { ids: [] }).ids]);
    if (h.meetings.length !== want.size || !h.meetings.every(m => want.has(`${m.season}/${m.matchID}`))) wrong++;
  }
  assert.equal(seen.size, 17131, 'squad pairs that ever met (#179: 17,113 + 18 that first meet through a reviewed id)');
  assert.equal(wrong, 0, 'pairs whose meetings differ from the direct scan');
});

test('MF1: the unlinked games split 124 / 203 on the fixture: 124 have a side with a team page in another season (by season and kind), 203 never had one (#179: 404 before the 16 reviewed ids)', () => {
  const sq = S.squadAt(IX), elsewhere = new Set(IX.teams.docs.flatMap(d => d.rows.map(r => r.teamID)));
  const by = {}; let orphan = 0, never = 0;
  for (const s of IX.vocab.seasons) {
    const g = IX.games.get(s);
    for (let i = 0; i < g.N; i++) {
      if (!g.h[i] || !g.a[i]) continue;
      const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`);
      if (a && b) continue;
      const els = (!a && elsewhere.has(g.h[i])) || (!b && elsewhere.has(g.a[i]));
      if (els) { orphan++; const k = `${s} ${g.flights.get(g.fl[i]).kind}`; by[k] = (by[k] || 0) + 1; } else never++;
    }
  }
  assert.deepEqual([orphan, never], [124, 203]);
  // #179: was 2020-21 c 194, n 28; 2021-22 c 109, n 18; the rest are RL, Pre-ECNL, age-slot, second-team and cross-regroup ids (excluded)
  assert.deepEqual(by, { '2020-21 c': 44, '2020-21 n': 19, '2021-22 n': 6, '2022-23 n': 7, '2025-26 s': 48 });
});

test('rules on the committed data: no key in two squads; meetings found = games between two different squads; each unlinked game is a TBD side, no squad or the same squad; orphan + never = unlinked', () => {
  const sq = S.squadAt(CIX);
  let nGames = 0, noLink = 0, tbd = 0, nosq = 0, same = 0, elsewhere = 0;
  const has = new Set(CIX.teams.docs.flatMap(d => d.rows.map(r => r.teamID)));
  for (const s of CIX.vocab.seasons) {
    const g = CIX.games.get(s);
    for (let i = 0; i < g.N; i++) {
      nGames++;
      const row = new G.GameRow(g, i, { cls: 'exact' });
      if (row.h2hHref) continue;
      noLink++;
      if (!g.h[i] || !g.a[i]) { tbd++; continue; }
      const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`);
      if (!a || !b) { nosq++; if ((!a && has.has(g.h[i])) || (!b && has.has(g.a[i]))) elsewhere++; } else if (a === b) same++; else assert.fail(`${s} ${g.id[i]}: two squads and no link`);
    }
  }
  assert.equal(tbd + nosq + same, noLink);
  assert.ok(elsewhere <= nosq && nGames > 45000);
});

test('requests: the seasons a pair needs after the first focus are at most 6 for every pair (fixture: median 2, 90th percentile 5, max 6); a cold open is 2 + the seasons both played, at most 8 (#179: unchanged with the reviewed ids)', () => {
  const sq = S.squadAt(IX), seen = new Set(), need = [], cold = [], BARE = S.buildIndex(loadSearchData());   // no games loaded
  for (const s of IX.vocab.seasons) {
    const g = IX.games.get(s);
    for (let i = 0; i < g.N; i++) {
      const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`);
      if (!a || !b || a === b) continue;
      const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
      if (seen.has(k)) continue; seen.add(k);
      need.push(S.h2hSeasons(ACTIVE, [a], [b]).need.length);
      cold.push(2 + S.h2hSeasons(BARE, [a], [b]).both.length);
    }
  }
  need.sort((x, y) => x - y); cold.sort((x, y) => x - y);
  const at = (l, p) => l[Math.floor(l.length * p)];
  assert.deepEqual([need.length, need[need.length >> 1], at(need, 0.9), need.at(-1)], [17131, 2, 5, 6]);   // #179: 18 more pairs, the same spread
  assert.ok(cold.at(-1) <= 8 && cold.at(-1) === 8, `cold open maximum ${cold.at(-1)}`);
  assert.deepEqual([cold[cold.length >> 1], at(cold, 0.9)], [4, 7]);
});

test('work: the meeting filter visits 89 games for MVLA v Mustang, at most 143 for any pair on the fixture', () => {
  const st = {};
  S.headToHead(IX, [S.resolveSide(IX, '2023-24', 55477).doc], [S.resolveSide(IX, '2023-24', 31529).doc], { today: TODAY, stats: st });
  assert.equal(st.gamesVisited, 89);
  let max = 0; const sq = S.squadAt(IX), seen = new Set();
  for (const s of IX.vocab.seasons) { const g = IX.games.get(s); for (let i = 0; i < g.N; i++) {
    const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`); if (!a || !b || a === b || seen.has(`${a.key}|${b.key}`)) continue; seen.add(`${a.key}|${b.key}`);
    const t = {}; S.headToHead(IX, [a], [b], { today: TODAY, stats: t }); max = Math.max(max, t.gamesVisited || 0); } }
  assert.equal(max, 143);
});

test('the lead row: one squad a side leads with the head to head (the strong squad beats the weak one); two strong squads on a side get none; a clubs-only query never has one', () => {
  const lead = q => sec(run(q), 'games').find(r => r.kind === 'h2h');
  const a = lead('MVLA 2011 vs Mustang 2011');
  assert.deepEqual([a.a, a.b], [{ season: '2023-24', teamID: 55477 }, { season: '2023-24', teamID: 31529 }], 'H01: 55477, not the weak G2011/12 squad 55325');
  assert.equal(run('MVLA 2011 vs Mustang 2011').enter.key, a.key, 'it is the slate\'s enter');
  assert.deepEqual([a.notLoaded, a.complete], [['2023-24', '2024-25', '2025-26'], false], 'typing makes no request: 3 earlier seasons load when it opens');
  assert.ok(a.href.startsWith('#tab=teams&season=2026-27&team=55477&name=MVLA%20ECNL%20G2010%2F11&vs=2026-27:31529'));
  const f = lead('Force (CA) 2009/10 vs MVLA 2009/10');   // H08: the squads, never a candidate
  assert.deepEqual([f.a.season + '/' + f.a.teamID, f.b.season + '/' + f.b.teamID], ['2026-27/60044', '2022-23/33633']);
  assert.equal(lead('Slammers 2008 vs LA Breakers 2008'), undefined, 'H12 (Q9): two strong Slammers squads: no lead row');
  const g = sec(run('Slammers 2008 vs LA Breakers 2008'), 'games').filter(r => r.kind === 'game').map(r => r.matchID);
  assert.ok(g.includes(1085613) && g.includes(1085547), 'its meetings stay');
  assert.equal(lead('MVLA vs Mustang'), undefined, 'clubs only: pairing rows');
  assert.ok(sec(run('MVLA vs Mustang'), 'games').every(r => r.kind === 'pairing'));
});

test('GameRow.h2hHref: side A is the matched side, else home; ids are canonical (that season\'s row, else the nearest: #179); match= names the game; none for a TBD side, no squad or the same squad', () => {
  const sq = S.squadAt(IX);
  let linked = 0, none = 0, other = 0;
  const yr = x => +x.slice(0, 4), near = (d, s, t) => d.rows.find(r => r.season === s) || d.rows.reduce((b, r) => {
    const gp = x => Math.abs(yr(x.season) - yr(s)); return gp(r) < gp(b) || (gp(r) === gp(b) && r.teamID === t && b.teamID !== t) ? r : b; });
  for (const s of IX.vocab.seasons) {
    const g = IX.games.get(s);
    for (let i = 0; i < g.N; i++) {
      const r = new G.GameRow(g, i, { cls: 'exact' }), v = new G.GameRow(g, i, { cls: 'exact', matched: 'away' });
      if (!r.h2hHref) { none++; continue; }
      linked++;
      const p = new URLSearchParams(r.h2hHref.slice(1)), q = new URLSearchParams(v.h2hHref.slice(1));
      assert.equal(p.get('match'), String(g.id[i]));
      const a = sq.get(`${s}/${g.h[i]}`), b = sq.get(`${s}/${g.a[i]}`);
      // #179 (Q4, N2): a side's conference row that season, else its nearest row (a tie: the game's own id, else the earlier)
      const ra = near(a, s, g.h[i]), rb = near(b, s, g.a[i]);
      assert.deepEqual([p.get('season'), +p.get('team')], [ra.season, ra.teamID], 'A is the home side, by its conference id');
      assert.deepEqual([q.get('season'), +q.get('team')], [rb.season, rb.teamID], 'matched away: A is the away side');
      assert.equal(p.get('vs'), `${rb.season}:${rb.teamID}`);
      if (ra.season !== s || rb.season !== s) other++;
    }
  }
  assert.deepEqual([linked, none, other], [46686, 367, 280], '#179: 280 games of a reviewed id link a side by its nearest row');
});

test('N-c: the pairing path itself: Avalanche vs Eagles 2025-26 links the conference id 69910, never the alias 112470; one squad pair opens its head to head, several open each meeting\'s', () => {
  const ix = fixture(['2026-27', '2025-26']);
  const rows = sec(run('Avalanche vs Eagles 2025-26', ix), 'games').filter(r => r.kind === 'pairing');
  assert.ok(rows.length);
  const hrefs = rows.map(r => r.h2hHref).filter(Boolean);
  assert.ok(hrefs.length && hrefs.every(h => /team=69910|vs=2025-26:69910/.test(h) && !/112470/.test(h)), hrefs.join('\n'));
  const slam = sec(run('Slammers vs Blues 2023-24', fixture(['2026-27', '2023-24'])), 'games').filter(r => r.kind === 'pairing');
  assert.ok(slam.length && slam.every(r => r.squadPairs === 2 && r.h2hHref === null && r.pairNames.length === 2), 'two Slammers squads met Blues in each age group: no link on the row, each meeting has its own');
  const one = sec(run('MVLA vs Mustang'), 'games').filter(r => r.kind === 'pairing');
  assert.ok(one.length && one.every(r => r.squadPairs === 1 && /&vs=\d{4}-\d{2}:\d+$/.test(r.h2hHref) && r.pairNames.length === 1), 'one squad pair: the row opens its head to head');
});

test('MF4, B1: the pairing row\'s record counts a drawn game decided on penalties as a win or a loss, as the Overview does: Slammers v Blues 2023-24, G2008 is [2,1,1], not [1,2,1] (Q3, the owner\'s decision)', () => {
  const rows = sec(run('Slammers vs Blues 2023-24', fixture(['2026-27', '2023-24'])), 'games');
  const g08 = rows.find(r => r.div === 'G2008');
  assert.deepEqual(g08.record, [2, 1, 1], 'was [1,2,1] while a shoot-out counted as a draw');
  assert.ok(g08.meetings.some(m => m.score && m.score[0] === m.score[1] && m.pk && m.pk[0] !== m.pk[1]), 'a drawn game decided on penalties is among them');
});

// ---------- #179: reviewed orphan team ids ----------
// public/data/orphan-team-ids.json attaches 16 reviewed ids (games in a season TGS's conference table left the id out of)
// to their squads as `x`. Exact counts are pinned on the frozen fixture; the committed data asserts the rules.
const ORPHANS = readJSON(new URL('public/data/orphan-team-ids.json', ROOT)).orphans;

test('#179: the 16 reviewed ids resolve to the squads they name, on the fixture and the committed data; a season with no row for them', () => {
  assert.equal(ORPHANS.length, 16);
  for (const ix of [IX, CIX]) for (const e of ORPHANS) {
    const d = S.squadAt(ix).get(`${e.season}/${e.teamID}`);
    assert.ok(d, `${e.season}/${e.teamID} resolves`);
    assert.equal(d.key, e.squad);
    assert.ok(!d.rows.some(r => r.season === e.season), 'no conference row that season');
    assert.deepEqual(S.resolveSide(ix, e.season, e.teamID).key, e.squad);
  }
  assert.equal(S.resolveSide(IX, '2020-21', 46767).error, 'no-squad', 'Q2: SLSG White 46767 stays out');
  assert.equal(S.resolveSide(IX, '2020-21', 50300).error, 'no-squad', 'FC Portland 50300, a second GU13 team that season, stays out');
});

test('#179: Vardar GU13 v Michigan Hawks G08 met twice in 2020-21 (they read "haven\'t met" before); NC Fusion v NCFC Youth G08 is 9 meetings, 3-2-4', () => {
  const v = h2h(IX, '2025-26', 46771, '2020-21', 46776).h;
  assert.deepEqual(v.seasons.both, ['2020-21']);
  assert.deepEqual(ids(v).sort(), [172274, 172291]);
  const n = h2h(IX, '2020-21', 13888, '2025-26', 45785).h;
  assert.deepEqual([n.meetings.length, n.record, n.seasons.both[0]], [9, [3, 2, 4], '2020-21']);
  assert.deepEqual(n.meetings.filter(m => m.season === '2020-21').map(m => m.matchID).sort(), [193876, 193903, 227851]);
});

test('#179 rules on the committed data: every alias id is a catalog teamAliases key or a reviewed entry; a reviewed key has no row that season, and its squad has a row with that id in an adjacent season', () => {
  const src = readJSON(new URL('public/data/sources.json', ROOT)), cat = new Set(), reviewed = new Map(ORPHANS.map(e => [`${e.season}/${e.teamID}`, e]));
  for (const [s, e] of Object.entries(src.seasons)) for (const k of ['national', 'showcases']) for (const ev of Object.values(e[k] || {})) for (const a of Object.keys(ev.teamAliases || {})) cat.add(`${s}/${a}`);
  const yr = s => +s.slice(0, 4);
  let n = 0;
  for (const d of CIX.teams.docs) for (const x of d.x) {
    const k = `${x.season}/${x.teamID}`, e = reviewed.get(k);
    assert.ok(cat.has(k) || e, `${k}: neither a catalog alias nor reviewed`);
    if (!e) continue;
    n++;
    assert.equal(d.key, e.squad);
    assert.ok(!d.rows.some(r => r.season === x.season), `${k}: a row that season`);
    assert.ok(d.rows.some(r => r.teamID === x.teamID && Math.abs(yr(r.season) - yr(x.season)) === 1), `${k}: no adjacent row with that id`);
  }
  assert.equal(n, ORPHANS.length, 'every reviewed entry applied');
});

test('#179 N2: a side with no row in the game\'s season is named by its nearest row; on a tie, the row with the game\'s own id, else the earlier', () => {
  const doc = (key, rows) => ({ key, rows: rows.map(([season, teamID]) => ({ season, teamID })) });
  const P = doc('2020-21/5', [['2020-21', 5], ['2022-23', 6]]), Q = doc('2021-22/9', [['2021-22', 9]]);
  const game = id => ({ season: '2021-22', h: [id], a: [9], id: [77] });
  const href = (id, d = P) => S.gameH2HHref(game(id), 0, 'h', new Map([[`2021-22/${id}`, d], ['2021-22/9', Q]]), null);
  assert.match(href(6), /season=2022-23&team=6&/, 'a tie: the row with the game\'s own id');
  assert.match(href(5), /season=2020-21&team=5&/, 'a tie: the row with the game\'s own id (the earlier)');
  assert.match(href(7), /season=2020-21&team=5&/, 'a tie, neither id: the earlier row');
  assert.match(href(4, doc('2022-23/4', [['2022-23', 4], ['2023-24', 4]])), /season=2022-23&team=4&/, 'no tie: the nearest');
  assert.match(href(8, doc('2020-21/8', [['2020-21', 8], ['2021-22', 3]])), /season=2021-22&team=3&/, 'a row in the game\'s season always wins');
});
