// #163 (#149 phase 1, PR 3): the entry point of the page's search. Pure functions: no page
// globals, no storage, no network; the clock and time zone come in through `context`.
//
//   buildIndex(searchData)            searchData = { core, places }: the search data files
//                                     (docs/data-api.md, "Search data"). Returns the index, the
//                                     word-to-records map. Throws SearchDataError on a schema it
//                                     does not know, naming the file.
//   startIndex(searchData, n)         the same build as a generator, at most n units per next();
//                                     its return value is the index (#165).
//   search(index, query, context)     context = { now: epoch ms, timeZone, selectedSeason }.
//                                     Returns the slate (slate.mjs).
//
// SEARCH_API is this module's API version. The page (PR 4a) compares it with the version it
// expects and shows a coverage note instead of calling a changed API (plan v2 MF5).
import { buildVocabG } from './vocab.mjs';
import { drain } from './match.mjs';
import { readQuery } from './reader.mjs';
import { teamDocsG, searchTeams } from './teams.mjs';
import { eventDocs, searchEvents } from './events.mjs';
import { buildSlate } from './slate.mjs';

export const SEARCH_API = 2;
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
    api: SEARCH_API, build: core.build, directoryBuild: core.directoryBuild, vocab, teams, events, known,
    stats: { teamDocs: teams.N, eventDocs: events.N, terms: teams.post.post.size + events.post.post.size, postings: postings(teams) + postings(events) },
  };
}

// The whole build at once: startIndex, run to its end.
export const buildIndex = searchData => drain(startIndex(searchData, Infinity));

function checkContext(context) {
  const c = context || {};
  if (!Number.isFinite(c.now)) throw new TypeError('search: context.now must be epoch milliseconds');
  if (typeof c.timeZone !== 'string' || !c.timeZone) throw new TypeError('search: context.timeZone is required');
  if (typeof c.selectedSeason !== 'string') throw new TypeError('search: context.selectedSeason is required');
  return c;
}

// options: { stats } counts the work done (the per-keystroke budget, tests/search-modules.test.mjs);
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
  // Partial matches only when no category matches every word, and every category with a reading
  // for this query is indexed (plan v2 MF4, nit 2): a field, a date or `vs` is a games reading.
  const gamesReading = reader.vs || reader.sides.some(s => s.field || s.dates);
  if (!res.teams.rows.length && !res.events.rows.length && !gamesReading) {
    const pt = merge(reader.sides.map(s => searchTeams(index.teams, s, ctx, index.vocab, { ...opts, cache: caches.teams, partial: true })));
    const pe = merge(reader.sides.map(s => searchEvents(index.events, s, ctx, index.vocab, { ...opts, cache: caches.events, partial: true })));
    if (pt.rows.length || pe.rows.length) res.partial = { teams: pt.rows, events: pe.rows };
  }
  return buildSlate(reader, res, { specificityTie: options.specificityTie !== false });
}
