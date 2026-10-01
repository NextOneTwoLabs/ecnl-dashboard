// The team page's own code (public/index.html), extracted block by block as in
// tests/team-history.test.mjs. #108: the glance card's club place. #109: the Playoffs line,
// for every team with a team page in every archived national flight; the champion is decided
// by team id, by name only without an id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
// From the line that starts `head` to the end of the function (or statement) that `last` names.
const block = (head, last = head) => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf('\n    }\n', from) + 6;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};

test('#108: the placeholder club 7 never shows a place, even when the data has one', () => {
  const place = new Function('clubPlaces', block('    const NO_CLUB = 7;', 'function clubPlaceText(') + '\nreturn clubPlaceText;');
  const f = place({ 7: { city: 'El Paso', state: 'TX' }, 1425: { city: 'Davis', state: 'CA' }, 64: null });
  assert.equal(f(7), '');
  assert.equal(f('7'), '');
  assert.equal(f(1425), 'Davis, CA');
  assert.equal(f('1425'), 'Davis, CA');
  assert.equal(f(64), '');
  assert.equal(f(null), '');
  assert.equal(f(undefined), '');
  assert.equal(place(null)(1425), '');            // the file not loaded yet
});

test('#108: the History header uses the same rule, with no inline club-7 check of its own', () => {
  assert.ok(html.includes('const place = clubPlaceText(sq.clubID);'));
  assert.ok(!/clubID\s*!==?\s*7\b/.test(html), 'a second club-7 rule outside clubPlaceText');
});

const page = new Function([block('    function tierLabel('), block('    function bracketName('), block('    function gameWinner('), block('    function knockoutGames('),
  block('    function buildBrackets('), block('    function postseasonOutcome('),
  'return { tierLabel, knockoutGames, buildBrackets, postseasonOutcome };'].join('\n'))();
const json = p => { try { return JSON.parse(readFileSync(new URL(p, root), 'utf8')); } catch { return null; } };

function* flights() {
  const cat = json('data/sources.json');
  for (const [season, s] of Object.entries(cat.seasons)) {
    const index = new Map((json(`archive/teams/${season}.json`)?.teams || []).map(t => [t.teamID, t]));
    for (const ev of Object.values(s.national || {})) {
      const h = json(`archive/api/Event/get-event-schedule-or-standings/${ev.eventId}.json`);
      for (const d of (h?.data?.girlsDivAndFlightList || [])) for (const f of (d.flightList || [])) {
        const games = json(`archive/api/Event/get-schedules-by-flight/${ev.eventId}/${f.flightID}/0.json`)?.data || [];
        const st = json(`archive/api/Event/get-standings-by-div-and-flight/${d.divisionID}/${f.flightID}/${ev.eventId}.json`)?.data;
        const blocks = (Array.isArray(st) ? st : st ? [st] : []).filter(b => b && (b.teamStandings || []).length);
        const tier = page.tierLabel(ev, f.flightName);
        const ko = page.knockoutGames(games, blocks, ((ev.dataGaps || {})[f.flightID] || {}).omitFromBracket || []);
        yield { season, f, games, tier, index, brackets: ko.length ? page.buildBrackets(ko, f.flightName, tier) : null };
      }
    }
  }
}

test('#109: in every archived final the winner, and only the winner, reads Champion on its team page', () => {
  // Exact counts only for the seasons through 2025-26, whose post-season is complete; the
  // archive grows, so everything else is a lower bound.
  const closed = s => s <= '2025-26';
  const warn = console.warn; console.warn = () => {};
  const finals = [], champions = [], renamed = [], changed = [];
  let teams = 0;
  try {
    for (const { season, f, games, brackets, tier, index } of flights()) {
      const main = brackets && brackets.list.find(b => b.isMain);
      const last = main && main.rounds[main.rounds.length - 1];
      const fin = last && last.games.length === 1 ? last.games[0] : null;
      const winnerID = fin && fin.winner ? (fin.winner === 'home' ? fin.game.hometeamID : fin.game.awayteamID) ?? null : null;
      if (fin) finals.push(season);
      assert.equal(brackets ? brackets.championID : null, winnerID, `flight ${f.flightID}: championID is the final's winner`);
      for (const id of new Set(games.flatMap(g => [g.hometeamID, g.awayteamID]).filter(Boolean))) {
        const rec = index.get(id);
        if (!rec) continue;                           // no team page (an RL team, a guest)
        teams++;
        const text = page.postseasonOutcome(brackets, id, rec.name, tier);
        assert.equal(text.startsWith('🏆'), id === winnerID, `${season} ${f.flightID} ${rec.name}: ${text}`);
        const byName = brackets && page.postseasonOutcome({ ...brackets, championID: null }, id, rec.name, tier);
        if (brackets && text !== byName) changed.push(`${season} ${tier} ${id}`);
        if (id === winnerID) {
          champions.push(season);
          if (rec.name !== brackets.champion) renamed.push(`${season} ${tier} ${id}`);
        }
      }
    }
  } finally { console.warn = warn; }
  assert.equal(finals.filter(closed).length, 88);
  assert.equal(champions.filter(closed).length, 75);   // 87 decided finals; 12 won by a team with no team page
  const RENAMED = [
    '2020-21 Champions League Finals 20122', '2020-21 Champions League Finals 29720',
    '2025-26 Champions League 58541', '2025-26 Champions League 84689',
    '2025-26 North American Cup 56277', '2025-26 North American Cup 69014',
  ];
  assert.deepEqual(renamed.filter(x => closed(x.slice(0, 7))).sort(), RENAMED);
  // The id rule changes exactly the renamed champions' lines; the name rule read them "Reached the Final".
  assert.deepEqual(changed.filter(x => closed(x.slice(0, 7))).sort(), RENAMED);
  assert.ok(finals.length >= 88 && champions.length >= 75, `${finals.length} finals, ${champions.length} champions`);
  assert.ok(teams >= 2109, `${teams} team-flights`);
});

test('#109: without a winner id the name decides; an undecided final has no champion', () => {
  const g = (h, a, hs, as, hid, aid) => ({ homeTeam: h, awayTeam: a, hometeamscore: hs, awayteamscore: as, hometeamID: hid, awayteamID: aid, type: 'Bracket', gamenumber: 1, gameDate: '2026-07-01' });
  const CL = 'Champions League';
  const noId = page.buildBrackets([g('A', 'B', 2, 1, null, 2)], CL, CL);
  assert.equal(noId.championID, null);
  assert.equal(page.postseasonOutcome(noId, 99, 'A', CL), '🏆 Champions League Champion');
  assert.equal(page.postseasonOutcome(noId, 2, 'B', CL), 'Reached the Final of the Champions League');
  const draw = page.buildBrackets([g('A', 'B', 1, 1, 1, 2)], CL, CL);
  assert.equal(draw.champion, null);
  assert.equal(draw.championID, null);
  assert.equal(page.postseasonOutcome(draw, 1, 'A', CL), 'Reached the Final of the Champions League');
  const byId = page.buildBrackets([g('A at the event', 'B', 3, 0, 1, 2)], CL, CL);
  assert.equal(byId.championID, 1);
  assert.equal(page.postseasonOutcome(byId, 1, 'A in the conference', CL), '🏆 Champions League Champion');
  assert.equal(page.postseasonOutcome(byId, 2, 'A at the event', CL), 'Reached the Final of the Champions League');
  const away = page.buildBrackets([g('A', 'B', 0, 2, 1, 2)], CL, CL);
  assert.equal(away.championID, 2);
  assert.equal(page.postseasonOutcome(away, 2, 'B', CL), '🏆 Champions League Champion');
  assert.equal(page.postseasonOutcome(null, 1, 'A', CL), '');
});
