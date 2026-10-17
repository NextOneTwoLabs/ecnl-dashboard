// #163 (#149 phase 1, PR 3): the entry point of the page's search. Pure functions: no page
// globals, no storage, no network; the clock and time zone come in through `context`.
//
//   buildIndex(searchData)            searchData = { core, places }: the search data files
//                                     (docs/data-api.md, "Search data"). Returns the index, the
//                                     word-to-records map. Throws SearchDataError on a schema it
//                                     does not know, naming the file.
//   startIndex(searchData, n)         the same build as a generator, at most n units per next();
//                                     its return value is the index (#165).
//   search(index, query, context)     context = { now: epoch ms, timeZone, selectedSeason, today:
//                                     'YYYY-MM-DD' (#168 MF7: the page's own todayKey; no Intl
//                                     formatter is made by a search), and optionally gamesLoading,
//                                     gamesMissing, gamesFailed: seasons }. Returns the slate (slate.mjs).
//   startGames(index, gamesDoc, n)    #168: one season's games file into the index, as a generator of
//                                     at most n games per step; its last step installs the season.
//
// SEARCH_API is this module's API version (3 since #168: games). The page compares it with the
// version it expects and shows a coverage note instead of calling a changed API (plan v2 MF5).
import { buildVocabG } from './vocab.mjs';
import { drain } from './match.mjs';
import { readQuery } from './reader.mjs';
import { teamDocsG, searchTeams } from './teams.mjs';
import { eventDocs, searchEvents } from './events.mjs';
import { buildSlate } from './slate.mjs';
import { gamesIndexG, GAMES_SCHEMA, searchGames } from './games.mjs';

export { GAMES_SCHEMA };
export const SEARCH_API = 3;
export const CORE_SCHEMA = 2;
export const PLACES_SCHEMA = 1;

export class SearchDataError extends Error {
  constructor(file, message) { super(`${file}: ${message}`); this.name = 'SearchDataError'; this.file = file; }
}

// The build in steps (#165): each next() does at most `n` units of one stage and yields a label, so the
// page can hand the main thread back between steps. The value it returns is the index. Events are the
// last step, so a visitor never sees teams without events. A schema it does not know throws
// SearchDataError from the first next(), not from this call.
export function* startIndex(searchData, n = 150) {
  const { core, places } = searchData || {};
  if (!core || core.schema !== CORE_SCHEMA) throw new SearchDataError('core.json', `unknown schema ${core && core.schema}`);
  if (!places || places.schema !== PLACES_SCHEMA) throw new SearchDataError('places.json', `unknown schema ${places && places.schema}`);
  const vocab = yield* buildVocabG(core, places, n);
  const teams = yield* teamDocsG(core, vocab, n);
  yield 'events';
  const events = eventDocs(core, vocab);
  // refinement A (#163 Q4): every word any category or the vocabulary knows
  const known = new Set([...vocab.known, ...teams.post.terms.sorted, ...events.post.terms.sorted]);
  const postings = c => [...c.post.post.values()].reduce((m, l) => m + l.length, 0);
  return {
    api: SEARCH_API, build: core.build, directoryBuild: core.directoryBuild, vocab, teams, events, known, games: new Map(),
    stats: { teamDocs: teams.N, eventDocs: events.N, terms: teams.post.post.size + events.post.post.size, postings: postings(teams) + postings(events) },
  };
}

// The whole build at once: startIndex, run to its end. The index holds no games until startGames.
export const buildIndex = searchData => drain(startIndex(searchData, Infinity));

// #168: one season's games file into the index, in steps of at most n games (n squads for the one-time
// lookups the first season adds). The last step installs the season, so a search never sees half of
// one. A schema it does not know throws SearchDataError from the first next(), not from this call.
export function* startGames(index, doc, n = 150) {
  if (!doc || doc.schema !== GAMES_SCHEMA) throw new SearchDataError(`games-${doc && doc.season}.json`, `unknown schema ${doc && doc.schema}`);
  // once per index: "season/teamID" -> the directory's name (a side's season tab), and eventID -> event
  if (!index.teamAt) {
    const teamAt = new Map();
    let k = 0;
    for (const d of index.teams.docs) { if (++k % n === 0) yield 'games:teams'; for (const r of d.rows) teamAt.set(`${r.season}/${r.teamID}`, r.name); }
    index.teamAt = teamAt;
  }
  if (!index.eventByID) index.eventByID = new Map(index.events.docs.map(d => [d.id, d]));
  const G = yield* gamesIndexG(doc, { vocab: index.vocab, teamAt: index.teamAt, events: index.eventByID }, n);
  if (!index.games) index.games = new Map();
  index.games.set(doc.season, G);
  return G;
}

function checkContext(context) {
  const c = context || {};
  if (!Number.isFinite(c.now)) throw new TypeError('search: context.now must be epoch milliseconds');
  if (typeof c.timeZone !== 'string' || !c.timeZone) throw new TypeError('search: context.timeZone is required');
  if (typeof c.selectedSeason !== 'string') throw new TypeError('search: context.selectedSeason is required');
  if (typeof c.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.today)) throw new TypeError("search: context.today ('YYYY-MM-DD') is required");
  return c;
}

// options: { stats } counts the work done (the per-keystroke budget, tests/search-modules.test.mjs;
// #168 adds gamesVisited and teamSearches); { games: false } searches teams and events only, as before #168
// (the tests compare the two);
// { specificityTie: false } turns refinement B off, for the test that lists what it changes.
export function search(index, query, context, options = {}) {
  const ctx = checkContext(context);
  const stats = options.stats || null;
  const reader = readQuery(index.vocab, query);
  // one expansion per word and category per search, whatever the number of readings
  const caches = { teams: new Map(), events: new Map() };
  const opts = { stats, known: index.known };
  const merge = (results) => {
    if (results.length === 1) return results[0];        // one side: nothing to merge
    const seen = new Set(), rows = [], reasons = new Set();
    let ended = false;
    for (const r of results) { for (const x of r.rows) if (!seen.has(x.key || `${x.eventID}/${x.div || ''}`)) { seen.add(x.key || `${x.eventID}/${x.div || ''}`); rows.push(x); } for (const x of r.reasons) reasons.add(x); ended = ended || !!r.ended; }
    return { rows, reasons, ended };
  };
  const res = {
    teams: merge(reader.sides.map(s => searchTeams(index.teams, s, ctx, index.vocab, { ...opts, cache: caches.teams }))),
    events: merge(reader.sides.map(s => searchEvents(index.events, s, ctx, index.vocab, { ...opts, cache: caches.events }))),
  };
  if (stats) stats.teamSearches = (stats.teamSearches || 0) + reader.sides.length;   // the Teams section: one per side
  res.games = options.games === false ? { rows: [], reasons: new Set(), coverage: [] } : searchGames(index, reader, ctx, { stats, cache: caches.teams });
  // Partial matches only when no category matches every word (#168: games included: a place whose fields
  // match every word shows no partial guesses), and never for a games reading (a field, a date, `vs`).
  const gamesReading = reader.vs || reader.sides.some(s => s.field || s.dates);
  if (!res.teams.rows.length && !res.events.rows.length && !res.games.rows.length && !gamesReading) {
    const pt = merge(reader.sides.map(s => searchTeams(index.teams, s, ctx, index.vocab, { ...opts, cache: caches.teams, partial: true })));
    const pe = merge(reader.sides.map(s => searchEvents(index.events, s, ctx, index.vocab, { ...opts, cache: caches.events, partial: true })));
    if (pt.rows.length || pe.rows.length) res.partial = { teams: pt.rows, events: pe.rows };
  }
  return buildSlate(reader, res, { specificityTie: options.specificityTie !== false });
}
