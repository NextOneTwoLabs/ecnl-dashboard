// #163 (#149 phase 1, PR 3): the query reader. It reads the typed text once, through the shared
// vocabulary, and keeps every plausible reading of an ambiguous word (design rule 3), up to 4 per
// category, in a fixed order. Pure: the selected season comes from the context.
//
// Roles: season, bare year (two seasons, or a birth year inside core.birthYears), birth year, age
// group, conference, state, place (census place or alias), county, field complex and date (games
// only), kind word, and name word. Plan v2, section 3, maps each rule to the judged queries.
import { normalize, words, NOISE } from './match.mjs';
import { KIND_WORDS, WORD_CODES, ALIASES } from './vocab.mjs';

export const READING_CAP = 4;
const PAIR = new Set(['vs', 'v', '@', 'versus']);
// role priority, for ordering readings (plan v2 nit 1): season, age, birth year > conference >
// place > kind > field > name
const PRIO = { season: 0, age: 0, born: 0, conf: 1, state: 2, place: 2, county: 2, code: 2, kind: 3, field: 4, date: 4, name: 9 };

// One side of the query (a `vs` query has two) as tokens: filters, then word segments.
function tokens(raw, vocab) {
  const out = { seasons: [], unknownSeason: null, u: null, born: [], band: false, years: [], dates: [], fieldNumber: null, segs: [], lastWord: -1 };
  const ws = [];
  const list = raw.split(/[\s,;]+/).filter(Boolean);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    let m;
    if ((m = /^(?:20)?(\d{2})-(?:20)?(\d{2})$/.exec(t))) {
      const s = `20${m[1]}-${m[2]}`;
      if ((+m[1] + 1) % 100 === +m[2] && vocab.seasons.includes(s)) out.seasons.push(s); else out.unknownSeason = `20${m[1]}-${m[2]}`;
      continue;
    }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)) || (m = /^(\d{1,2})\/(\d{1,2})$/.exec(t))) { out.dates.push(t); continue; }
    if ((m = /^g?u-?(\d{1,2})(?:\/u?\d{1,2})?s?$/.exec(t)) && +m[1] >= 8 && +m[1] <= 19) { out.u = +m[1]; continue; }
    if ((m = /^([gb])?((?:19|20)\d{2})(?:\/((?:19|20)?\d{2}))?([gb])?$/.exec(t))) {
      const y = +m[2];
      if (m[3]) { out.born.push(y, m[3].length === 2 ? Math.floor(y / 100) * 100 + +m[3] : +m[3]); out.band = true; }
      else if (m[1] || m[4]) out.born.push(y);
      else out.years.push(y);                    // a bare year: two seasons, or a birth year
      continue;
    }
    if ((m = /^[gb](\d{2})(?:\/(\d{1,2}))?$/.exec(t)) || (m = /^(\d{2})[gb]$/.exec(t))) {
      out.born.push(2000 + +m[1]);
      if (m[2]) { out.born.push(2000 + +m[2]); out.band = true; }
      continue;
    }
    if (/^\d{1,2}$/.test(t) && ws.length && ws[ws.length - 1] === 'field') { out.fieldNumber = +t; ws.pop(); continue; }
    if (/^\d{2}$/.test(t) && +t <= 20 && 2000 + +t >= vocab.birthYears[0] && 2000 + +t <= vocab.birthYears[1]) { out.born.push(2000 + +t); continue; }
    const before = ws.length;
    for (const w of words(t)) if (!NOISE.has(w)) ws.push(w);
    if (i === list.length - 1 && ws.length > before) out.lastWord = ws.length - 1;
  }
  // segments: the longest vocabulary phrase at each position; every phrase of that length is a role
  for (let i = 0; i < ws.length;) {
    const w = ws[i];
    if (KIND_WORDS[w]) { out.segs.push({ at: i, words: [w], roles: [{ type: 'kind', value: KIND_WORDS[w] }], name: false }); i++; continue; }
    const cands = (vocab.byFirst.get(w) || []).filter(p => p.words.every((x, k) => ws[i + k] === x));
    const len = cands.length ? Math.max(...cands.map(p => p.words.length)) : 0;
    if (len) {
      const roles = cands.filter(p => p.words.length === len).map(p => ({ ...p, type: p.type }));
      out.segs.push({ at: i, words: ws.slice(i, i + len), roles, name: true });
      i += len;
      continue;
    }
    if (w.length === 2 && vocab.states[w.toUpperCase()] && !ALIASES[w]) { out.segs.push({ at: i, words: [w], roles: [{ type: 'code', value: w.toUpperCase(), label: vocab.states[w.toUpperCase()] }], name: true, code: true }); i++; continue; }
    out.segs.push({ at: i, words: [w], roles: [], name: true });
    i++;
  }
  // MF7: an alias's plain name reading is kept only with another name word, when it says so. Only a
  // word with no other role counts: in "LA Utah", utah is a state, not another name (#164 nit 2).
  const nameSegs = s => out.segs.filter(x => x !== s && x.name && !x.code && !x.roles.length).length;
  for (const s of out.segs) for (const r of s.roles) if (r.alias && r.nameWord === 'with-other-name-word' && !nameSegs(s)) s.name = false;
  // two-letter state codes (today's D-P1): strict as a place when nothing else names a team or a
  // place; otherwise place-or-name; "in", "or", "me" only as the whole query
  const others = out.segs.filter(s => !s.code && s.name && !s.roles.length).length;
  const placed = out.segs.some(s => s.roles.some(r => ['place', 'state', 'county'].includes(r.type)));
  for (const s of out.segs) if (s.code) {
    const c = s.words[0];
    if (WORD_CODES.has(c) && (out.segs.length > 1)) { s.roles = []; continue; }
    const strict = !others && !placed;
    s.roles[0].soft = !strict;
    s.name = false;          // a soft code already matches by place or by the code in a name
  }
  return out;
}

// Every reading of one side: a choice per segment (one of its roles, or name words), per bare year
// (seasons, or a birth year inside the catalog's range).
function readingsOf(tk, vocab) {
  const dims = tk.segs.map(s => [...s.roles.map(r => ({ seg: s, role: r })), ...(s.name ? [{ seg: s, role: null }] : [])]);
  const yearDims = tk.years.map(y => {
    const opts = [{ year: y, as: 'seasons' }];
    if (y >= vocab.birthYears[0] && y <= vocab.birthYears[1]) opts.push({ year: y, as: 'born' });
    return opts;
  });
  const all = [...dims, ...yearDims];
  // At most 256 combinations: past that, combinations are cut, never dimensions, so every word is
  // still read (#164 nit 3); the cut is reported as the cap.
  let combos = [[]], cut = false;
  for (const d of all) {
    if (!d.length) continue;
    const next = [];
    for (const c of combos) for (const o of d) next.push([...c, o]);
    cut = cut || next.length > 256;
    combos = next.length > 256 ? next.slice(0, 256) : next;
  }
  tk.cut = cut;
  const out = [];
  for (const combo of combos) {
    const r = {
      seasons: tk.seasons.length ? [...tk.seasons] : null, unknownSeason: tk.unknownSeason, u: tk.u, born: [...tk.born], band: tk.band,
      conf: null, places: null, kinds: [], field: null, dates: tk.dates, fieldNumber: tk.fieldNumber, names: [], filterWords: 0, longest: 0, prio: 9,
      roles: [], key: '', confConflict: false, codes: [],
    };
    if (tk.seasons.length || tk.unknownSeason) r.filterWords++;
    if (tk.u) r.filterWords++;
    if (tk.born.length) r.filterWords++;
    for (const c of combo) {
      if (c.year != null) {
        if (c.as === 'born') { r.born.push(c.year); r.filterWords++; r.prio = Math.min(r.prio, PRIO.born); }
        else {
          const ss = [`${c.year - 1}-${String(c.year).slice(2)}`, `${c.year}-${String(c.year + 1).slice(2)}`].filter(s => vocab.seasons.includes(s));
          if (!ss.length) { r.unknownSeason = r.unknownSeason || `${c.year}`; }
          r.seasons = r.seasons ? r.seasons.filter(s => ss.includes(s)) : ss;
          r.filterWords++; r.prio = Math.min(r.prio, PRIO.season);
        }
        r.roles.push(c.as === 'born' ? `born:${c.year}` : `year:${c.year}`);
        continue;
      }
      const { seg, role } = c;
      // the last word of the text, while it is still being typed, matches by prefix at any length
      // A word that is also a place matches names only as a name word, never a club's or an event's
      // city text: the place reading answers where (so an alias such as richmond keeps D8).
      if (!role) {
        const place = seg.roles.some(x => ['place', 'county', 'state', 'code'].includes(x.type));
        seg.words.forEach((w, k) => r.names.push({ w, last: seg.at + k === tk.lastWord, place }));
        r.roles.push(`name:${seg.words.join(' ')}`);
        continue;
      }
      r.filterWords += seg.words.length;
      r.longest = Math.max(r.longest, seg.words.length);
      r.prio = Math.min(r.prio, PRIO[role.type]);
      r.roles.push(`${role.type}:${role.value}`);
      if (role.type === 'conf') { if (r.conf && r.conf !== role.value) r.confConflict = true; r.conf = role.value; }
      else if (role.type === 'kind') r.kinds.push(role.value);
      else if (role.type === 'field') r.field = role.value;
      else if (role.type === 'code' && role.soft) r.codes.push(role.value);   // a soft code narrows: AND (today's rule)
      else {   // place, county, state, strict code: any of them (OR)
        if (!r.places) r.places = [];
        r.places.push({ type: role.type, value: role.value, places: role.places || [], counties: role.counties || [], state: role.type === 'state' || role.type === 'code' ? role.value : null,
          soft: !!role.soft, words: seg.words, initialism: role.initialism || null, alias: role.alias || null, label: role.label || role.value });
      }
    }
    // A state (a code or a full name) beside a place, county or alias narrows it (AND), never adds to
    // it: "Redmond WA" and "Redmond Washington" are Redmond, Washington (#164 MF2). An alias keeps its
    // own places in that state and its initialism, plus the census places of that name in the state:
    // "LA CA" is still Los Angeles, and "Richmond CA" is Richmond, California (#164 MF1).
    const where = r.places ? r.places.filter(p => !p.state) : [];
    const pinned = [...new Set([...(r.places || []).filter(p => p.state).map(p => p.state), ...r.codes])];
    if (where.length && pinned.length) {
      const inState = g => vocab.places[g] && pinned.includes(vocab.places[g][1]);
      const countyIn = c => vocab.counties[c] && pinned.includes(vocab.counties[c][1]);
      r.places = where.map(p => {
        let places = p.places.filter(inState), counties = p.counties.filter(countyIn);
        if (p.alias) {
          const named = (vocab.placeByName.get(p.alias) || []).filter(x => pinned.includes(x.state));
          places = [...new Set([...places, ...named.map(x => x.geoid)])];
          counties = [...new Set([...counties, ...named.map(x => x.county).filter(Boolean)])];
        }
        const label = places.length ? places.map(g => `${vocab.places[g][0]}, ${vocab.places[g][1]}`).join(' or ')
          : counties.map(c => `${vocab.counties[c][0]}, ${vocab.counties[c][1]}`).join(' or ') || p.label;
        return { ...p, places, counties, label };
      });
      r.codes = pinned;      // the state narrows every result (AND), names included
      r.statePinned = true;
    }
    if (r.confConflict) continue;
    r.key = r.roles.join('|');
    out.push(r);
  }
  return out;
}

const order = (a, b) => b.filterWords - a.filterWords || b.longest - a.longest || a.prio - b.prio || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// Which readings each category can use. `why` explains a reading a category cannot use.
function forTeams(r) {
  if (r.field || r.dates.length) return false;
  const named = r.names.length > 0;
  if (named && r.names.map(n => n.w).join('').length < 2) return false;
  return named || !!r.places || (!!r.conf && !!(r.u || r.band || r.born.length));
}
function forEvents(r) {
  if (r.field || r.dates.length) return false;
  if (r.roles.some(x => x.startsWith('born:'))) return false;    // a birth year applies to teams only
  if (r.born.length && !r.u && !r.conf && !r.kinds.length && !r.names.length && !r.places) return false;
  const named = r.names.length > 0;
  if (named && r.names.map(n => n.w).join('').length < 2) return false;
  return named || !!r.conf || r.kinds.length > 0 || !!r.places;
}

function capped(list) {
  const seen = new Set(), out = [];
  for (const r of [...list].sort(order)) { if (seen.has(r.key)) continue; seen.add(r.key); out.push(r); }
  return { readings: out.slice(0, READING_CAP), capReached: out.length > READING_CAP };
}

// -> { text, sides: [{ teams, events, games, placeOnly, ... }], vs, capReached, flags }
export function readQuery(vocab, text) {
  const norm = normalize(text).trim();
  const parts = norm.split(/\s+/).filter(Boolean);
  const cut = parts.findIndex((p, i) => PAIR.has(p) && i > 0 && i < parts.length - 1);
  const sideTexts = cut > 0 ? [parts.slice(0, cut).join(' '), parts.slice(cut + 1).join(' ')] : [parts.join(' ')];
  const toks = sideTexts.map(t => tokens(t, vocab));
  // a vs query: a season or year on either side applies to both
  if (toks.length === 2) for (const k of ['seasons', 'years']) {
    const all = [...new Set(toks.flatMap(t => t[k]))];
    for (const t of toks) t[k] = all;
    if (toks.some(t => t.unknownSeason)) for (const t of toks) t.unknownSeason = t.unknownSeason || toks.find(x => x.unknownSeason).unknownSeason;
  }
  let capReached = false;
  const sides = toks.map(tk => {
    const all = readingsOf(tk, vocab);
    const teams = capped(all.filter(forTeams));
    const events = capped(toks.length === 2 ? [] : all.filter(forEvents));
    const games = all.filter(r => r.field || r.dates.length);
    capReached = capReached || teams.capReached || events.capReached || !!tk.cut;
    // design row 4: some reading uses every word as a place, with no other filter
    const placeOnly = all.some(r => r.places && (!r.codes.length || r.statePinned) && !r.names.length && !r.conf && !r.kinds.length && !r.field && !r.dates.length
      && !r.seasons && !r.unknownSeason && !r.u && !r.born.length);
    return {
      tokens: tk, teams: teams.readings, events: events.readings, games, placeOnly,
      confAge: all.some(r => r.conf && (r.u || r.band)), kinds: all.some(r => r.kinds.length), field: games.some(r => r.field), dates: tk.dates.length > 0,
      unknownSeason: tk.unknownSeason, nameWords: [...new Set(all.flatMap(r => r.names.map(n => n.w)))],
    };
  });
  return { text: norm, sides, vs: sides.length === 2, capReached };
}
