// #168 (#149 phase 1, PR 4b): the offline link test over every game. For every committed games file, each
// game's link is built through the modules (GameRow.href, links.mjs gameHref) and then resolved the way
// the page would, with the page's own functions sliced from public/index.html (undateBorrowedDates,
// mergeStandingsBlocks, knockoutGames, buildBrackets, isPlayed) on public/data/sources.json and the
// archived hierarchies, standings and schedules. A link is right only if:
//   - every value is one the router keeps rather than repairs: the season, the conference (or stage, or
//     showcase), the age group in the season's registry (rebuildAll repairs any other) and in the
//     event's hierarchy, and the tier or flight in that division;
//   - the event is the game's own event, and match= is the game's id;
//   - the game is drawn in that view: the Matches view lists it in a flight of the division with the
//     link's filter showing it, and the selected team is in the division's standings and in the game;
//     a bracket game is in knockoutGames (omitFromBracket applied) AND in a bracket buildBrackets draws,
//     main or sub; a Schedule or showcase Games view game is in the flight's file.
// Every game with no link has a side still to be decided. Closed seasons' counts are pinned exactly; the
// active season is pinned by 0 wrong and its total. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/search-game-links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
// From the line that starts `head` to the end of that function (team-history.test.mjs's slicing).
const block = head => {
  const start = html.indexOf('\n' + head) + 1, end = html.indexOf('\n    }\n', start) + 6;
  assert.ok(start > 0 && end > start, `${head} not found in index.html`);
  return html.slice(start, end);
};
const page = new Function([block('    function bracketName('), block('    function gameWinner('), block('    function buildBrackets('), block('    function undateBorrowedDates('),
  block('    function mergeStandingsBlocks('), block('    function knockoutGames('), block('    function isPlayed('),
  'return { buildBrackets, undateBorrowedDates, mergeStandingsBlocks, knockoutGames, isPlayed };'].join('\n'))();
const json = p => { try { return JSON.parse(readFileSync(new URL(p, root), 'utf8')); } catch { return null; } };
const S = await import(new URL('search/search.mjs', root));
const { GameRow } = await import(new URL('search/games.mjs', root));
const { indexOf, destinationProblem } = await import(new URL('../tests/search/judged.mjs', root));   // #178: the judged set's link check
const src = json('data/sources.json');
const index = S.buildIndex({ core: json('archive/search/core.json'), places: json('archive/search/places.json') });
const memo = new Map(), get = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
const hier = eid => get(`h${eid}`, () => (json(`archive/api/Event/get-event-schedule-or-standings/${eid}.json`) || {}).data || {});
const sched = (eid, fid, conf) => get(`s${eid}/${fid}/${conf}`, () => { const g = (json(`archive/api/Event/get-schedules-by-flight/${eid}/${fid}/0.json`) || {}).data || []; return conf ? page.undateBorrowedDates(g) : g; });
const blocks = (did, fid, eid) => get(`b${did}/${fid}/${eid}`, () => { const d = (json(`archive/api/Event/get-standings-by-div-and-flight/${did}/${fid}/${eid}.json`) || {}).data; return (Array.isArray(d) ? d : d ? [d] : []).filter(b => b && (b.teamStandings || []).length); });
const standingTeams = (div, f, eid) => (page.mergeStandingsBlocks(blocks(div.divisionID, f.flightID, eid)) || { teamStandings: [] }).teamStandings;

// -> null, or why the link is wrong. diag counts what is worth knowing but not wrong.
function resolve(href, g, diag) {
  const p = new URLSearchParams(href.slice(1)), season = p.get('season'), S_ = src.seasons[season];
  if (!S_) return 'unknown season';
  if (p.get('match') !== String(g.matchID)) return 'match= is not the game';
  const tab = p.get('tab');
  if (!tab) {   // the conference Matches view: every flight of the division, as loadCurrentView loads it
    const conf = S_.conferences[p.get('conf')]; if (!conf) return 'conference repaired';
    if (conf.eventId !== g.competition.eventID) return 'another event';
    if (!(S_.ageGroups || {})[p.get('age')]) return 'age not in the season registry (rebuildAll repairs it)';
    const div = (hier(conf.eventId).girlsDivAndFlightList || []).find(d => d.divisionName === p.get('age')); if (!div) return 'age repaired';
    if (p.get('view') !== 'schedule') return 'not the Matches view';
    const fl = div.flightList || [];
    const hit = fl.map(f => ({ f, g: sched(conf.eventId, f.flightID, true).find(x => x.matchID === g.matchID) })).find(x => x.g);
    if (!hit) return 'not listed in the division';
    const filt = p.get('sched') || 'upcoming';
    if ((filt === 'results') !== page.isPlayed(hit.g)) return `filter ${filt} hides it`;
    if (p.has('team')) {
      const t = +p.get('team');
      const own = fl.find(f => standingTeams(div, f, conf.eventId).some(x => x.teamID === t));
      if (!own) return 'team dropped (not in the standings)';
      if (hit.g.hometeamID !== t && hit.g.awayteamID !== t) return 'team not in the game';
      const other = [hit.g.hometeamID, hit.g.awayteamID].find(x => x !== t);
      const of = fl.find(f => standingTeams(div, f, conf.eventId).some(x => x.teamID === other));
      if (own.flightID !== hit.f.flightID || (of && of.flightID !== hit.f.flightID)) diag.crossFlight++;   // #155
    }
    return null;
  }
  if (tab === 'playoffs') {
    const ev = (S_.national || {})[p.get('stage')]; if (!ev) return 'stage repaired';
    if (ev.eventId !== g.competition.eventID) return 'another event';
    const div = (hier(ev.eventId).girlsDivAndFlightList || []).find(d => d.divisionName === p.get('age')); if (!div) return 'age repaired';
    const f = (div.flightList || []).find(x => x.flightID === +p.get('tier')); if (!f) return 'tier repaired';
    const games = sched(ev.eventId, f.flightID, false);
    if (p.get('view') === 'schedule') return games.some(x => x.matchID === g.matchID) ? null : 'not in the Schedule view';
    if (p.has('view')) return `unknown view ${p.get('view')}`;
    const raw = blocks(div.divisionID, f.flightID, ev.eventId), bl = raw.every(b => b.flightGroupID) ? raw : [page.mergeStandingsBlocks(raw)].filter(Boolean);
    const ko = page.knockoutGames(games, bl, ((ev.dataGaps || {})[f.flightID] || {}).omitFromBracket || []);
    if (!ko.some(x => x.matchID === g.matchID)) return 'not in the bracket';
    const warn = console.warn; console.warn = () => {};
    let br; try { br = page.buildBrackets(ko, f.flightName, f.flightName); } finally { console.warn = warn; }
    const inB = b => b.rounds.some(r => r.games.some(e => e && e.game && e.game.matchID === g.matchID));
    if (!br.list.some(inB)) return 'in no drawn bracket';
    const main = br.list.find(b => b.isMain);
    if (!(main && inB(main))) diag.subBracket++;
    return null;
  }
  if (tab === 'showcases') {
    const ev = Object.values(S_.showcases || {}).find(x => x.eventId === +p.get('event')); if (!ev) return 'showcase repaired';
    if (ev.eventId !== g.competition.eventID) return 'another event';
    const div = (hier(ev.eventId).girlsDivAndFlightList || []).find(d => d.divisionName === p.get('age')); if (!div) return 'age repaired';
    const f = (div.flightList || []).find(x => x.flightID === +p.get('flight')); if (!f) return 'flight repaired';
    if (p.get('view') !== 'schedule') return 'not the Games view';
    return sched(ev.eventId, f.flightID, false).some(x => x.matchID === g.matchID) ? null : 'not in the Games view';
  }
  return 'unknown route';
}

const seasons = index.vocab.seasons, active = index.vocab.active;
const games = new Map(seasons.map(s => { const g = S.startGames(index, json(`archive/search/games-${s}.json`), Infinity); let r; while (!(r = g.next()).done); return [s, r.value]; }));
const rowsOf = s => { const G = games.get(s); return Array.from({ length: G.N }, (_, i) => new GameRow(G, i, { cls: 'exact' })); };
// the planted mistakes the resolver must catch, each applied to the games it can apply to
const MUTANTS = {
  'no &sched=results': (h, g) => (g.score ? h.replace('&sched=results', '') : null),
  'the division id where the flight id goes': (h, g) => (/[?&#]tier=/.test(h) ? h.replace(/tier=\d+/, `tier=${(hier(g.competition.eventID).girlsDivAndFlightList || []).find(d => d.divisionName === g.competition.div)?.divisionID}`) : null),
  'no view=schedule on a [3] game': (h, g) => (g.dest[0] === 3 ? h.replace('&view=schedule', '') : null),
  'the wrong side for [1, 1]': (h, g) => (g.dest[0] === 1 && g.dest[1] === 1 ? h.replace(/team=\d+/, `team=${g.home.teamID}`) : null),
  "the team's season tab instead of the game": (h, g) => (g.home.seasonHref ? `${g.home.seasonHref}&match=${g.matchID}` : null),
};
// Closed seasons, pinned exactly (games by dest code); a closed season's file changes only with the builder
const CLOSED = {
  '2020-21': { 0: 11, 1: 7, 2: 385, 3: 209, '1,0': 5279, '1,1': 96 },
  '2021-22': { 0: 16, 1: 20, 2: 312, 3: 345, '1,0': 6753, '1,1': 44 },
  '2022-23': { 2: 330, 3: 330, '1,0': 6404 },
  '2023-24': { 2: 285, 3: 330, '1,0': 6326 },
  '2024-25': { 2: 241, 3: 216, '1,0': 5768 },
  '2025-26': { 2: 420, 3: 48, 4: 618, '1,0': 5956 },
};

test('every game of every season links to the view that draws it: 0 wrong destinations', () => {
  const diag = { crossFlight: 0, subBracket: 0 };
  const wrong = [], noLink = [], counts = {};
  let n = 0;
  for (const s of seasons) {
    counts[s] = {};
    for (const g of rowsOf(s)) {
      n++;
      const d = g.dest.join(',');
      counts[s][d] = (counts[s][d] || 0) + 1;
      if (!g.href) { noLink.push(g); continue; }
      const why = resolve(g.href, g, diag);
      if (why) wrong.push(`${s} ${g.matchID} [${d}] ${why}: ${g.href}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} wrong of ${n}`);
  for (const [s, want] of Object.entries(CLOSED)) assert.deepEqual(counts[s], Object.fromEntries(Object.entries(want).map(([k, v]) => [String(k), v])), `${s}: games by dest code`);
  // the active season grows with each refresh: its games are all checked above, and it holds some
  assert.ok(Object.values(counts[active]).reduce((x, y) => x + y, 0) > 1000 && n > 45000, `${n} games`);
  // no link only for a side still to be decided ("Winner Game 13 v Winner Game 14")
  assert.ok(noLink.length > 0 && noLink.every(g => !g.home.teamID || !g.away.teamID), `${noLink.length} games with no link, each with a TBD side`);
  // diagnostics: #155's cross-flight games (listed in their division's Matches view all the same) and the
  // bracket games that sit in a sub-bracket (a <details> the view opens for match=)
  assert.ok(diag.crossFlight > 2000 && diag.subBracket > 500, JSON.stringify(diag));
  console.log(`# ${n} games, 0 wrong; no link ${noLink.length} (all a TBD side); cross-flight ${diag.crossFlight}; sub-bracket ${diag.subBracket}`);
});

test('the resolver has teeth: each planted mistake is caught on the games it applies to', () => {
  for (const [name, mutate] of Object.entries(MUTANTS)) {
    let tried = 0, caught = 0;
    for (const s of seasons) for (const g of rowsOf(s)) {
      if (!g.href || tried >= 400) continue;
      const h = mutate(g.href, g);
      if (!h || h === g.href) continue;
      tried++;
      if (resolve(h, g, { crossFlight: 0, subBracket: 0 })) caught++;
    }
    assert.ok(tried > 0, `${name}: no game to plant it on`);
    assert.equal(caught, tried, `${name}: ${caught} of ${tried} caught`);
  }
});

// ---------- #178: the head-to-head links ----------
// Three kinds of link go to a head to head: a game row's (side A the matched side, else home; &match=), a pairing row's (one
// per season, age group, squad pair and orientation: the pairing groups are keyed by home and away, so they are a superset of
// the rows search shows, which are by unordered pair) and the lead row's (every squad pair that met, both ways). Each must pass
// the judged set's destinationProblem, open exactly the pair it names through the squads (never a candidate or an alias id), carry
// only conference-row ids (a showcase's own id is mapped to its squad's id that season) and have name= on A. On the committed
// data, which a refresh moves, the counts are rules (each derived here from the games), never pinned; the exact counts are on the
// frozen fixture (tests/search-h2h.test.mjs).
test('every head-to-head link (game rows, pairing rows, lead rows) opens the pair it names: 0 wrong destinations, only canonical ids', () => {
  const jix = indexOf(json('archive/search/core.json').teams, src);
  const sq = S.squadAt(index), ctx = { today: '2026-10-20' };
  const canon = (d, season, id) => d.rows.some(r => r.season === season && r.teamID === id);
  const pairMemo = new Map();
  const holds = (a, b, key) => {
    const k = `${a.key}|${b.key}`;
    let h = pairMemo.get(k);
    if (!h) { const r = S.headToHead(index, [a], [b], { today: ctx.today }); h = new Set(r.meetings.map(m => `${m.season}/${m.matchID}`)); pairMemo.set(k, h); }
    return h.has(key);
  };
  const check = (href, season, ha, hb, gameKey, why) => {
    const bad = destinationProblem(href, jix);
    if (bad) return `${why}: ${bad}: ${href}`;
    const p = new URLSearchParams(href.slice(1)), vs = S.parseVs(p.get('vs'));
    const A = S.resolveSide(index, p.get('season'), +p.get('team')), B = S.resolveSide(index, vs.season, vs.teamID);
    if (A.error || B.error || A.doc !== ha || B.doc !== hb) return `${why}: not the pair: ${href}`;
    if (!canon(A.doc, p.get('season'), +p.get('team')) || !canon(B.doc, vs.season, vs.teamID)) return `${why}: not a conference id: ${href}`;
    if (A.doc.rows.find(r => r.season === p.get('season') && r.teamID === +p.get('team')).name !== p.get('name')) return `${why}: name= is not A's: ${href}`;
    if (gameKey && !holds(A.doc, B.doc, gameKey)) return `${why}: the head to head lacks the game: ${href}`;
    return null;
  };
  const wrong = [], n = { game: 0, pairing: 0, lead: 0, noLink: 0, games: 0, ok: 0 };
  const groups = new Map(), pairs = new Map();
  for (const s of seasons) {
    const G = games.get(s);
    for (let i = 0; i < G.N; i++) {
      n.games++;
      const h = sq.get(`${s}/${G.h[i]}`), a = sq.get(`${s}/${G.a[i]}`), ok = G.h[i] && G.a[i] && h && a && h !== a;
      for (const matched of [null, 'away']) {
        const row = new GameRow(G, i, { cls: 'exact', matched }), href = row.h2hHref;
        if (!ok) { if (href) wrong.push(`${s} ${G.id[i]}: a link where there is no head to head`); else if (!matched) n.noLink++; continue; }
        if (!href) { wrong.push(`${s} ${G.id[i]}: no link between two squads`); continue; }
        n.game++;
        const [x, y] = matched ? [a, h] : [h, a];
        const w = check(href, s, x, y, `${s}/${G.id[i]}`, `game ${s} ${G.id[i]}`);
        if (w) wrong.push(w);
        if (new URLSearchParams(href.slice(1)).get('match') !== String(G.id[i])) wrong.push(`${s} ${G.id[i]}: match= is not the game`);
      }
      if (ok) {
        n.ok++;
        const f = G.flights.get(G.fl[i]);
        for (const side of ['h', 'a']) {
          const k = `${s}|${f.div}|${side === 'h' ? `${h.key}|${a.key}` : `${a.key}|${h.key}`}`;
          if (!groups.has(k)) groups.set(k, [G, i, side, side === 'h' ? [h, a] : [a, h]]);
        }
        pairs.set(h.key < a.key ? `${h.key}|${a.key}` : `${a.key}|${h.key}`, h.key < a.key ? [h, a] : [a, h]);
      }
    }
  }
  for (const [k, [G, i, side, [x, y]]] of groups) {
    n.pairing++;
    const href = S.gameH2HHref(G, i, side, sq, index.teamAt);
    const w = check(href, G.season, x, y, null, `pairing ${k}`);
    if (w) wrong.push(w);
    if (/match=/.test(href)) wrong.push(`pairing ${k}: a pairing link names no meeting`);
  }
  for (const [, [x, y]] of pairs) for (const [da, db] of [[x, y], [y, x]]) {
    n.lead++;
    const r = S.h2hRow(index, da, db, ctx, {}), w = check(r.href, da.latest.season, da, db, null, `lead ${da.key} v ${db.key}`);
    if (w) wrong.push(w);
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} wrong`);
  assert.equal(n.lead, 2 * pairs.size, 'a lead row for every squad pair that met, both ways');
  assert.ok(n.game > 40000 && n.pairing > 20000 && n.lead > 10000, JSON.stringify(n));
  assert.equal(n.game, 2 * n.ok, 'both orientations of every game between two squads');
  assert.equal(n.ok + n.noLink, n.games - 0 - (n.games - n.ok - n.noLink), 'every game is linked or has none');
  console.log(`# h2h links: ${n.game} game, ${n.pairing} pairing (by orientation; a superset of the rows shown), ${n.lead} lead; 0 wrong`);
});

test('the h2h link check has teeth: a candidate id, an alias id, a wrong name and a same-squad vs are each caught', () => {
  const jix = indexOf(json('archive/search/core.json').teams, src), sq = S.squadAt(index);
  const G = games.get(active), g = rowsOf(active).find(r => r.h2hHref);
  const href = g.h2hHref, p = new URLSearchParams(href.slice(1));
  assert.equal(destinationProblem(href, jix), null);
  assert.match(destinationProblem(href.replace(/vs=[^&]+/, 'vs=2019-20:5'), jix), /unknown vs season/);
  assert.match(destinationProblem(href.replace(/vs=[^&]+/, `vs=${p.get('season')}:${p.get('team')}`), jix), /same squad/);
  assert.match(destinationProblem(href.replace(/name=[^&]+/, 'name=Nobody'), jix), /name is not/);
  assert.match(destinationProblem(`${href}&view=season`, jix), /vs= takes no view=/);
  assert.ok(sq.size > 0 && G);
});
