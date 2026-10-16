// #163 (#149 phase 1, PR 3): the slate, the result panel's content. One section per category in
// the order that best answers the query, an optional best match, and honest coverage: games are
// not indexed until PR 4b, and the slate says so instead of showing them as empty. Pure.
import { CLASS_RANK, nameWords } from './match.mjs';

export const CATEGORY_ORDER = ['teams', 'events', 'games'];
export const SECTION_SIZES = { teams: 8, events: 6, games: 6 };
export const COVERAGE = [{ category: 'games', state: 'not-indexed' }];

// Section order (design, "Building the slate"): the first row that applies wins.
//   1 a conference plus an age group      Events, Teams, Games
//   2 a kind word                         Events, Games, Teams
//   3 vs, a field complex or a date       Games, Teams, Events
//   4 only a place                        Teams, Events, Games; a section with a result in the place
//                                         itself before one holding only nearby results (D2)
//   5 otherwise                           the section whose top result is strongest: match class,
//                                         then the more specific reading (#163 Q2), then Teams,
//                                         Events, Games
export function sectionOrder(reader, full, { specificityTie = true } = {}) {
  const sides = reader.sides;
  let base, rule;
  if (sides.some(s => s.confAge)) { base = ['events', 'teams', 'games']; rule = 1; }
  else if (sides.some(s => s.kinds)) { base = ['events', 'games', 'teams']; rule = 2; }
  else if (reader.vs || sides.some(s => s.field || s.dates)) { base = ['games', 'teams', 'events']; rule = 3; }
  else if (sides.some(s => s.placeOnly)) {
    rule = 4;
    const direct = c => (full[c] || []).some(r => !r.nearby);
    base = ['teams', 'events', 'games'].sort((a, b) => (direct(a) === direct(b) ? 0 : direct(a) ? -1 : 1));
  } else {
    rule = 5;
    const top = c => (full[c] || [])[0];
    base = ['teams', 'events', 'games'].sort((a, b) => {
      const x = top(a), y = top(b);
      if (!x || !y) return x ? -1 : y ? 1 : 0;
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

// -> the slate
export function buildSlate(reader, res, options = {}) {
  const full = { teams: res.teams.rows, events: res.events.rows };
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
  const best = partial ? null : bestMatch(reader, sections);
  const enter = best || (sections[0] ? sections[0].rows[0] : null);
  // Honest coverage: with games not indexed, an empty games-only query is "not indexed", never
  // "no match".
  const gamesAsked = reader.vs || reader.sides.some(s => s.field || s.dates);
  let empty = null;
  if (!sections.length || partial) {
    const reasons = new Set([...res.teams.reasons, ...res.events.reasons]);
    const reason = partial ? 'no-full-match' : reasons.has('season-not-in-archive') ? 'season-not-in-archive'
      : reasons.has('no-such-age-group') ? 'no-such-age-group' : gamesAsked ? 'games-not-indexed' : 'no-match';
    empty = { reason, unknownSeason: reader.sides.map(s => s.unknownSeason).find(Boolean) || null };
  }
  return {
    query: reader.text, sections, best, enter, empty, rule,
    coverage: COVERAGE.map(c => ({ ...c, asked: gamesAsked })),
    ended: !!res.teams.ended, capReached: reader.capReached, sizes: SECTION_SIZES,
  };
}
