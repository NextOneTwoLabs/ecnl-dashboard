// #163 (#149 phase 1, PR 3): the shared vocabulary every category reads the query through.
// Built from core.json and places.json (docs/data-api.md, "Search data"); pure.
import { words, drain, sortCounted } from './match.mjs';

// The reviewed alias table (plan v2 MF2, addendum MF7). Each entry names what a word means as a
// place, and when its plain name-word reading is also built:
//   'always'                the name reading is always kept beside the place
//   'with-other-name-word'  only when the query has another name word (filters do not count)
// An aliased word never takes the census lookup or the two-letter state-code reading.
export const ALIASES = {
  la: {
    places: ['0644000'], initialism: 'LA', nameWord: 'with-other-name-word',
    evidence: 'D3 (queries.json): LA = Los Angeles plus the whole word LA in names; never Louisiana; La Roca FC never for the query LA alone (#163 MF7).',
  },
  richmond: {
    places: ['5167000'], initialism: null, nameWord: 'always',
    evidence: 'D8 (queries.json) and the owner on #156 (6205614938): Richmond means Richmond, VA only; Richmond United is still a name match (#163 Q7).',
  },
};

// Kind words (design, "How a query is read"). Never name words in events (plan v2 MF4).
export const KIND_WORDS = {
  playoff: 'playoffs', playoffs: 'playoffs', final: 'finals', finals: 'finals',
  showcase: 'showcase', showcases: 'showcase', standings: 'standings', standing: 'standings',
};

// Two-letter codes that are also common English words: a state only as the whole query (today's D-P1).
export const WORD_CODES = new Set(['in', 'or', 'me']);

// census names: st -> saint, mt -> mount (search_data.norm_city)
const CITY_ALIAS = { st: 'saint', mt: 'mount' };
export const placeWords = s => words(s).map(w => CITY_ALIAS[w] || w);

// Code-unit order, not localeCompare: every key sorted here is [a-z0-9 ] words or digit geoids, for which the
// two agree, and the first localeCompare call initialises the browser's ICU collator, a 6-9 ms step (#165).
const cu = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
export function buildVocab(core, places) { return drain(buildVocabG(core, places, Infinity)); }
// The vocabulary in steps of at most `n` units (a place, a place name or a county each count one).
export function* buildVocabG(core, places, n, stats = null) {
  let units = 0;
  const t = core.teams;
  const seasons = [...core.seasons];
  const active = core.activeSeason;
  const [byLo, byHi] = core.birthYears.length ? core.birthYears : [0, -1];
  // divisions by season: [{ name, u, years }]
  const divs = new Map(seasons.map(s => [s, []]));
  t.divs.forEach(([si, name, u, years]) => divs.get(t.seasons[si]).push({ name, u, years }));
  // conferences, as phrases
  const phrases = [];
  for (const c of t.confs) phrases.push({ type: 'conf', value: c, words: words(c) });
  for (const [k, v] of Object.entries(core.vocab.confAliases || {})) phrases.push({ type: 'conf', value: v, words: words(k) });
  // states by full name; codes separately
  const states = core.vocab.states || {};
  for (const [code, name] of Object.entries(states)) phrases.push({ type: 'state', value: code, label: name, words: words(name) });
  yield 'vocab:setup';
  // census places by normalised name -> every place of that name (MF2: all kept)
  const placeByName = new Map();
  for (const g in places.places) { const [name, st, county] = places.places[g];
    if (stats) stats.units++;
    if (++units % n === 0) yield 'vocab:places';
    const k = placeWords(name).join(' ');
    if (!placeByName.has(k)) placeByName.set(k, []);
    placeByName.get(k).push({ geoid: g, name, state: st, county });
  }
  for (const [k, list] of placeByName) {
    if (stats) stats.units++;
    if (++units % n === 0) yield 'vocab:byname';
    if (ALIASES[k]) continue;
    sortCounted(list, stats, (a, b) => cu(a.geoid, b.geoid));
    phrases.push({ type: 'place', value: k, places: list.map(p => p.geoid), counties: [...new Set(list.map(p => p.county).filter(Boolean))],
      label: list.map(p => `${p.name}, ${p.state}`).join(' or '), words: k.split(' ') });
  }
  // counties: "<name> county"; and a bare name with no place but one county of that name (Q6)
  const countyBase = new Map();
  for (const [g, [name, st]] of Object.entries(places.counties)) {
    if (stats) stats.units++;
    if (++units % n === 0) yield 'vocab:counties';
    const m = /^(.*) County$/.exec(name);
    if (!m) continue;
    const base = placeWords(m[1]).join(' ');
    if (!countyBase.has(base)) countyBase.set(base, []);
    countyBase.get(base).push({ geoid: g, name, state: st });
  }
  for (const [base, list] of countyBase) {
    const geo = list.map(c => c.geoid); sortCounted(geo, stats, cu);
    const label = list.map(c => `${c.name}, ${c.state}`).join(' or ');
    phrases.push({ type: 'county', value: base, counties: geo, label, words: [...base.split(' '), 'county'] });
    if (!placeByName.has(base) && !ALIASES[base] && list.length === 1)
      phrases.push({ type: 'county', value: base, counties: geo, label, words: base.split(' '), fallback: true });
  }
  // aliases (MF2): a place phrase of their own
  for (const [k, a] of Object.entries(ALIASES)) {
    const ps = a.places.filter(g => places.places[g]);
    phrases.push({ type: 'place', value: k, alias: k, places: ps, counties: [...new Set(ps.map(g => places.places[g][2]).filter(Boolean))],
      initialism: a.initialism, nameWord: a.nameWord, label: ps.map(g => `${places.places[g][0]}, ${places.places[g][1]}`).join(' or '), words: k.split(' ') });
  }
  // field complexes (games only): whole names, never a part (design: never `surf` alone)
  for (const [k, v] of Object.entries((places.vocab || {}).fieldAliases || {})) phrases.push({ type: 'field', value: v, words: words(k) });
  // longest first, then a stable order
  yield 'vocab:sort';
  sortCounted(phrases, stats, byLen);
  yield 'vocab:first';
  const byFirst = firstIndex(phrases);
  // every word the vocabulary knows (refinement A adds the categories' terms in search.mjs). A field
  // name's words are games-only (#168 MF5): they never join it, so they cannot switch off a team's or an
  // event's typo match ("mary" of Mary Grogan Community Park). #169 (owner decision Q9): the same holds for
  // the field aliases: their phrases still read as fields, but their words never join `known` ("turf" of an
  // alias would switch off the typo match turf -> surf of Bay Area Surf).
  yield 'vocab:known';
  const known = new Set([...phrases.filter(p => p.type !== 'field').flatMap(p => p.words), ...Object.keys(KIND_WORDS)]);
  const vocab = {
    seasons, active, birthYears: [byLo, byHi], divs, states, phrases, byFirst, byFirstBase: byFirst, known, placeByName,
    places: places.places, counties: places.counties, fields: places.fields || {}, clubPlaces: places.clubPlaces || {}, eventPlaces: places.eventPlaces || {},
    fieldPhrasesDropped: null,   // #168 MF5: set by fieldPhrasesG, at the end of the build
  };
  // #167: what fieldPhrasesG reads, kept by reference until it runs
  Object.defineProperty(vocab, 'fieldSource', { value: { places, core }, writable: true, configurable: true });
  return vocab;
}

const ROLE = { conf: 0, state: 1, place: 2, county: 3, field: 4 };
const PLAIN = /^[a-z0-9]+( [a-z0-9]+)*$/;
const byLen = (a, b) => b.words.length - a.words.length || ROLE[a.type] - ROLE[b.type] || cu(a.words.join(' '), b.words.join(' '));
function firstIndex(phrases) {
  const byFirst = new Map();
  for (const p of phrases) { const f = p.words[0]; if (!byFirst.has(f)) byFirst.set(f, []); byFirst.get(f).push(p); }
  return byFirst;
}

// #168 (Q4): every field's own name of two words or more is a field phrase too, a whole name, never a part.
// MF5: except a name that appears, as consecutive whole words, inside a name: a club's, a team's (current or
// older, every squad row), a family's or an alias ('fc dallas' is in "FC Dallas Youth" and in every FC Dallas
// team's name). #167 (review MF1): no name is normalised twice. startIndex runs this in three parts:
// fieldNamesG builds the candidates (a step per n fields) and returns the check; teamDocsG hands it each club and
// squad-row name as it normalises it (`visit`); `finishG` checks the few names left (families, aliases,
// conference aliases, clubs with no squad) and installs the phrases in one last step. Field-name phrases read
// Games only (review MF2): `byFirstBase` keeps the vocabulary without them, for Teams and Events.
export function* fieldNamesG(vocab, n, stats = null) {
  const { places, core } = vocab.fieldSource, t = core.teams;
  let units = 0;
  const aliasNames = new Set(Object.values((places.vocab || {}).fieldAliases || {}));
  const cand = new Map(), byTwo = new Map();   // first word -> second word -> the field names' word lists
  for (const key of Object.keys(places.fields || {})) {
    if (stats) stats.units++;
    if (++units % n === 0) yield 'vocab:fields';
    const name = key.slice(0, key.lastIndexOf('@'));
    if (aliasNames.has(name)) continue;
    const plain = PLAIN.test(name), w = plain ? name.split(' ') : words(name), k = plain ? name : w.join(' ');   // a key in words() form is split
    if (w.length < 2 || cand.has(k)) continue;
    cand.set(k, { name, w });
    let m = byTwo.get(w[0]); if (!m) byTwo.set(w[0], (m = new Map()));
    let l = m.get(w[1]); if (!l) m.set(w[1], (l = []));
    l.push(w);
  }
  const inName = new Set(), seen = new Set();
  const check = w => {
    for (let i = 0; i + 1 < w.length; i++) {
      const m = byTwo.get(w[i]); if (!m) continue;
      const l = m.get(w[i + 1]); if (!l) continue;
      for (const fw of l) {
        if (i + fw.length > w.length) continue;
        let ok = true;
        for (let k = 2; k < fw.length && ok; k++) ok = w[i + k] === fw[k];
        if (ok) inName.add(fw.join(' '));
      }
    }
  };
  const visit = (name, w) => { if (!seen.has(name)) { seen.add(name); check(w); } };
  function* finishG() {
    // every squad row's name was visited by teamDocsG; clubs with no squad, families and aliases were not
    const rest = [...t.clubs.map(c => c[1]), ...(t.families || []).map(f => f[0]), ...Object.keys(ALIASES), ...Object.keys(core.vocab.confAliases || {})];
    for (const nm of rest) { if (stats) stats.units++; if (++units % n === 0) yield 'vocab:fields'; if (!seen.has(nm)) visit(nm, words(nm)); }
    const dropped = [], fieldPhrases = [], fk = new Map();   // phrase -> its words joined
    for (const [k, { name, w }] of cand) {
      if (inName.has(k)) dropped.push(k);
      else { const p = { type: 'field', value: name, words: w, fieldName: true }; fieldPhrases.push(p); fk.set(p, k); }
    }
    // sorted, merged with the vocabulary's (a tie takes the vocabulary's first, as one stable sort of both did) and
    // indexed, in one last step; byLen with each phrase's text joined once (it would join it on every compare)
    yield 'vocab:fields';
    const keyed = (a, b) => b.words.length - a.words.length || ROLE[a.type] - ROLE[b.type] || cu(fk.get(a), fk.get(b));
    sortCounted(fieldPhrases, stats, keyed);
    const phrases = vocab.phrases, merged = [], pk = phrases.map(p => p.words.join(' '));
    for (let i = 0, j = 0; i < phrases.length || j < fieldPhrases.length;) {
      const f = fieldPhrases[j], k = f && fk.get(f);
      const takeBase = j >= fieldPhrases.length || (i < phrases.length && (f.words.length - phrases[i].words.length || ROLE[phrases[i].type] - ROLE[f.type] || cu(pk[i], k)) <= 0);
      merged.push(takeBase ? phrases[i++] : fieldPhrases[j++]);
    }
    vocab.phrases = merged; vocab.byFirst = firstIndex(merged);
    vocab.fieldPhrasesDropped = sortCounted(dropped, stats, cu);   // MF5: the field names left out because a name holds them
    vocab.fieldSource = null;
  }
  return { visit, finishG };
}

// The divisions of a season with age u ("U15" is GU15 in 2026-27, G2010 in 2024-25).
export const divsOfAge = (vocab, season, u) => (vocab.divs.get(season) || []).filter(d => d.u === u);
