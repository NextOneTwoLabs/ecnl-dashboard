// #163 (#149 phase 1, PR 3): the slate, the result panel's content. One section per category in
// the order that best answers the query, an optional best match, and honest coverage: since #168 (PR
// 4b) the slate says, per season a query needs, whether its games are ready, loading, not loaded yet,
// loaded only on request, missing or failed, instead of showing them as empty. Pure.
import { CLASS_RANK, nameWords } from './match.mjs';

export const CATEGORY_ORDER = ['teams', 'events', 'games'];
export const SECTION_SIZES = { teams: 8, events: 6, games: 6 };
// Coverage states (#168): ready | loading | not-loaded (an explicit season or a bare year: the page loads
// it by itself) | on-request (one squad a side's earlier seasons: only on the Load press, MF1) | missing (no
// file, 404) | failed (a refusal or error: "Try again"). Pending = loading or not-loaded.
export const PENDING = new Set(['loading', 'not-loaded']);

// Section order (design, "Building the slate"): the first row that applies wins.
//   1 a conference plus an age group      Events, Teams, Games
//   2 a kind word                         Events, Games, Teams
//   3 vs, a field complex or a date       Games, Teams, Events
//   4 only a place                        Teams, Events, Games; a section with a result in the place
//                                         itself before one holding only nearby results (D2). #168
//                                         MF4: a Games section whose direct rows are only fields with no
//                                         games in the seasons asked ranks between the two, and never
//                                         leads: it moves behind the next section
//   5 otherwise                           the section whose top result is strongest: match class,
//                                         then the more specific reading (#163 Q2), then Teams,
//                                         Events; #168 MF3: Games after every section with results
//                                         (its rows are that section's teams' or event's games)
// Rule 3: a vs query, a date, a field alias (Great Park), or a field's own name when Teams and Events found nothing
// for every word (#167, review MF2: "Dallas Texans Lewisville" is its 18 teams first; search.mjs sets teamsWhole)
const gamesLead = reader => reader.vs || reader.sides.some(s => s.fieldAlias || (s.fieldNamed && !reader.teamsWhole) || s.dates);
export function sectionOrder(reader, full, { specificityTie = true } = {}) {
  const sides = reader.sides;
  let base, rule;
  if (sides.some(s => s.confAge)) { base = ['events', 'teams', 'games']; rule = 1; }
  else if (sides.some(s => s.kinds)) { base = ['events', 'games', 'teams']; rule = 2; }
  else if (gamesLead(reader)) { base = ['games', 'teams', 'events']; rule = 3; }
  else if (sides.some(s => s.placeOnly)) {
    rule = 4;
    // 2: a result in the place itself; 1: only fields in the place with no games in the seasons asked
    // (still before a section that is only nearby: P03, 60 Acres Park in Redmond); 0: only nearby
    const tier = c => { const rows = (full[c] || []).filter(r => !r.nearby && r.kind !== 'load'); return rows.some(r => !(r.kind === 'field' && !r.count)) ? 2 : rows.length ? 1 : 0; };
    base = ['teams', 'events', 'games'].sort((a, b) => tier(b) - tier(a));
    const present = base.filter(c => (full[c] || []).length);
    if (present[0] === 'games' && tier('games') === 1 && present.length > 1) base = [present[1], 'games', ...base.filter(c => c !== present[1] && c !== 'games')];
  } else {
    rule = 5;
    const top = c => (full[c] || [])[0];
    base = ['teams', 'events', 'games'].sort((a, b) => {
      const x = top(a), y = top(b);
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      if (a === 'games' || b === 'games') return a === 'games' ? 1 : -1;   // MF3: before the class compare
      if (x.cls !== y.cls) return CLASS_RANK[x.cls] - CLASS_RANK[y.cls];
      if (specificityTie && x.filterWords !== y.filterWords) return y.filterWords - x.filterWords;
      return 0;   // Array.prototype.sort is stable: Teams, Events, Games
    });
  }
  return { order: base, rule };
}

// The words of the query that are neither filters nor kind words, for whole-name matches.
const queryWords = reader => reader.sides.flatMap(s => s.tokens.segs.filter(g => !g.roles.some(r => r.type === 'kind')).flatMap(g => g.words));

// Best match (design): an exact whole-name match, or the only exact match in any category; never
// partial. It must be clearly ahead, so it is promoted only when no other section's first row is
// also an exact match: "texas" keeps the teams based in Texas first, not the Texas conference.
export function bestMatch(reader, sections) {
  const qw = queryWords(reader).join(' ');
  const firsts = sections.filter(s => !s.partialOnly).map(s => s.rows[0]).filter(Boolean);
  const exactFirsts = firsts.filter(r => r.cls === 'exact');
  if (exactFirsts.length !== 1) return null;
  const r = exactFirsts[0];
  if (r.kind === 'team' ? r.whole : nameWords(r.name || r.title).join(' ') === qw) return r;
  const exact = sections.filter(s => !s.partialOnly).flatMap(s => s.rows).filter(x => x.cls === 'exact');
  return exact.length === 1 ? exact[0] : null;
}

// The rule a query's reading alone decides (1 to 4), else 5: the order's rule before any result is known.
export function ruleOf(reader) {
  const sides = reader.sides;
  if (sides.some(s => s.confAge)) return 1;
  if (sides.some(s => s.kinds)) return 2;
  if (gamesLead(reader)) return 3;
  if (sides.some(s => s.placeOnly)) return 4;
  return 5;
}

// -> the slate
export function buildSlate(reader, res, options = {}) {
  const games = res.games || { rows: [], reasons: new Set(), coverage: [] };
  const full = { teams: res.teams.rows, events: res.events.rows, games: games.rows };
  const partial = res.partial || null;
  let sections, rule = null;
  if (partial) {
    const firstKey = c => (partial[c] || [])[0];
    const order = ['teams', 'events'].filter(c => (partial[c] || []).length).sort((a, b) => {
      const p = firstKey(a).partialKey, q = firstKey(b).partialKey;
      return q.matched - p.matched || CLASS_RANK[p.cls] - CLASS_RANK[q.cls] || p.rarity - q.rarity;
    });
    sections = order.map(c => ({ name: c, rows: partial[c], total: partial[c].length, partialOnly: true }));
  } else {
    const o = sectionOrder(reader, full, options);
    rule = o.rule;
    sections = o.order.filter(c => (full[c] || []).length).map(c => ({ name: c, rows: full[c], total: full[c].length, partialOnly: false }));
  }
  const coverage = (games.coverage || []).map(c => ({ category: 'games', ...c }));
  // #168 (as 4a's MF4): while the games a games-first query (rule 3) needs are pending, nothing is promoted
  // and Enter is not committed, so the first row never flips when they land
  const pendingFirst = rule === 3 && coverage.some(c => PENDING.has(c.state));
  // the best match is never a game, and there is none when Games leads (a vs, a field or a date asks for games)
  const gamesFirst = !!sections[0] && sections[0].name === 'games';
  const best = partial || gamesFirst || pendingFirst ? null : bestMatch(reader, sections.filter(s => s.name !== 'games'));
  // Enter: never the Load cell (MF1), never a place's field with no games in the seasons asked (MF4)
  const eligible = r => r.kind !== 'load' && !(rule === 4 && r.kind === 'field' && !r.count);
  let enter = null;
  if (!pendingFirst) {
    if (best) enter = best;
    else if (gamesFirst && rule === 3) enter = sections[0].rows.find(eligible) || null;
    else for (const sec of sections) { enter = sec.rows.find(eligible) || null; if (enter) break; }
  }
  const gamesAsked = reader.vs || reader.sides.some(s => s.field || s.dates);
  let empty = null;
  if (!sections.length || partial) {
    const reasons = new Set([...res.teams.reasons, ...res.events.reasons, ...(games.reasons || [])]);
    const pending = coverage.some(c => PENDING.has(c.state));
    const reason = partial ? 'no-full-match' : reasons.has('season-not-in-archive') ? 'season-not-in-archive'
      : reasons.has('no-such-age-group') ? 'no-such-age-group' : pending ? 'games-loading' : 'no-match';
    empty = { reason, unknownSeason: reader.sides.map(s => s.unknownSeason).find(Boolean) || null };
  }
  return {
    query: reader.text, sections, best, enter, empty, rule, coverage, gamesAsked,
    ended: !!res.teams.ended, capReached: reader.capReached, sizes: SECTION_SIZES,
  };
}
