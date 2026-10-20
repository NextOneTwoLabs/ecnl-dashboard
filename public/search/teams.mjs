// #163 (#149 phase 1, PR 3): the Teams category. One document per #107 squad, from core.json's
// teams (the team directory) and places.json's club places. Pure.
import { postingsG, drain, Postings, nameWords, nameWordsOf, withAliases, initials, capsWords, teamTitle, words, expand, filterScore, CLASS_RANK, ageOk } from './match.mjs';
import { placeWords, ALIASES } from './vocab.mjs';
import { teamHref, teamSeasonHref } from './links.mjs';

export const TEAM_FIELDS = [{ name: 'name', w: 1.0 }, { name: 'club', w: 0.9 }, { name: 'older name', w: 0.6 }, { name: 'place', w: 0.4 }];
export const W_CONF = 0.5, W_PLACE = 0.8, W_FILTER = 0.3;
const PLACE_FIELD = 3;     // TEAM_FIELDS[3], the club's city and state text
const NO_CLUB = 7;   // TGS's "No Club Selection": its name, initials and place say nothing (today's S7)
// Sorting compares lower-cased keys made once per document (plain code-unit order: the same in every
// locale, and cheap).

export function teamDocs(core, vocab) { return drain(teamDocsG(core, vocab, Infinity)); }
// The team documents in steps of at most `n` squads (the postings, the counts and the lookups likewise).
export function* teamDocsG(core, vocab, n, onName = null, stats = null) {
  const t = core.teams, S = t.seasons;
  // names repeat across seasons: read each distinct one once
  const memo = f => { const m = new Map(); return x => { let v = m.get(x); if (v === undefined) { if (stats) stats.normalised++; v = f(x); m.set(x, v); } return v; }; };
  // #167 (review MF1): every distinct club and squad-row name is normalised here once, and handed, as its words,
  // to the field names' check (vocab.mjs fieldNamesG), which so never normalises a name a second time
  const nw = memo(nameWords), caps = memo(capsWords), ini = memo(initials);
  const aliasWords = memo(x => { const w = words(x); if (onName) onName(x, w); return withAliases(nameWordsOf(w)); });
  yield 'team docs';
  const div = t.divs.map(([s, name, u, years]) => ({ season: S[s], name, u, years }));
  const docs = [];
  for (let i = 0; i < t.squads.length; i++) { const sq = t.squads[i]; if (stats) stats.units++; if (i && i % n === 0) yield 'team docs'; docs.push((() => {
    const [id, clubName, , place, fam] = t.clubs[sq.c];
    const noClub = id === NO_CLUB;
    const at = noClub ? -1 : (place || '').lastIndexOf(', ');
    const famRow = fam != null && fam !== '' && t.families[fam] ? t.families[fam] : null;
    const club = { familyName: famRow ? famRow[0] : null, familyMain: famRow ? famRow[1] : null, id, name: clubName, city: at > 0 ? place.slice(0, at) : '', state: at > 0 ? place.slice(at + 2) : '', family: fam };
    const rows = sq.s.map(([s, teamID, name, conf, d, rank, of]) => ({ season: S[s], teamID, name, conf: t.confs[conf], div: div[d].name, u: div[d].u, years: div[d].years, rank, of }));
    const latest = rows[rows.length - 1];
    const title = new Set(aliasWords(latest.name));
    const clubF = new Set(noClub ? [] : aliasWords(clubName));
    const clubIni = noClub ? null : ini(clubName);
    if (clubIni) clubF.add('#' + clubIni);
    const older = new Set();
    for (let k = 0; k < rows.length - 1; k++) for (const w of aliasWords(rows[k].name)) if (!title.has(w) && !clubF.has(w)) older.add(w);
    const placeF = new Set(at > 0 ? [...placeWords(club.city), ...words((core.vocab.states || {})[club.state] || '')] : []);
    const loc = noClub ? null : vocab.clubPlaces[id] || null;
    const titleText = teamTitle(latest.name, clubName);
    const capsSet = new Set(noClub ? [] : caps(clubName));
    for (const r of rows) for (const w of caps(r.name)) capsSet.add(w);
    // name fields hold 2 to 6 words: arrays, which take far less memory than sets (#163)
    const lc = x => String(x).toLowerCase();
    return {
      // sort keys, read once (a sort compares them many times)
      sortClub: lc(noClub ? titleText : clubName), sortTitle: lc(titleText), sortName: lc(latest.name), sortU: latest.u || 0,
      i, club, born: sq.b, rows, latest, key: `${rows[0].season}/${rows[0].teamID}`, current: latest.season === vocab.active,
      x: (sq.x || []).map(([si, tid]) => ({ season: S[si], teamID: tid })),   // #168: alias ids at national events and showcases; #179: reviewed orphan ids
      titleText, titleWords: nw(titleText), caps: [...capsSet],
      placeGeo: loc ? loc[0] : null, countyGeo: loc ? loc[1] : null, m: sq.m || [], mp: sq.mp || [],
      fields: [[...title], [...clubF], [...older], [...placeF]],
    };
  })()); }
  for (const d of docs) { d.maybe = d.m.map(i => docs[i]); d.maybePrev = d.mp.map(i => docs[i]); }
  const post = yield* postingsG(TEAM_FIELDS, docs, n, stats);
  // documents passing each filter alone, for a filter's rarity (MF3)
  const count = function* (key, f) { const m = new Map(); for (const d of docs) { if (stats) stats.units++; if (d.i && d.i % n === 0) yield 'counts'; for (const k of new Set(f(d))) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const counts = {
    conf: yield* count('conf', d => d.rows.map(r => r.conf)),
    season: yield* count('season', d => d.rows.map(r => r.season)),
    u: yield* count('u', d => d.rows.map(r => r.u)),
    born: yield* count('born', d => d.born),
  };
  // lookups, so a place, state or conference reading starts from its candidates, not every squad
  const by = function* (f) { const m = new Map(); for (const d of docs) { if (stats) stats.units++; if (d.i && d.i % n === 0) yield 'lookups'; for (const k of new Set(f(d))) if (k != null && k !== '') { if (!m.has(k)) m.set(k, []); m.get(k).push(d.i); } } return m; };
  const lookups = {
    place: yield* by(d => [d.placeGeo]), county: yield* by(d => [d.countyGeo]), state: yield* by(d => [d.club.state]),
    caps: yield* by(d => d.caps), conf: yield* by(d => d.rows.map(r => r.conf)),
  };
  return { docs, post, counts, lookups, N: docs.length };
}

// Every squad a reading's places can reach: in the place, its county or its state, or named after it.
function placeUnion(T, places) {
  const out = new Set();
  const add = l => { for (const i of l || []) out.add(i); };
  for (const p of places) {
    for (const g of p.places) add(T.lookups.place.get(g));
    for (const c of p.counties) add(T.lookups.county.get(c));
    if (p.state) add(T.lookups.state.get(p.state));
    if (p.initialism) add(T.lookups.caps.get(p.initialism));
    else if (p.words.length) {
      const lists = p.words.map(w => new Set(T.post.post.get(w) || []));
      for (const i of lists[0]) if (lists.every(l => l.has(i))) out.add(i);
    }
  }
  return out;
}

// Does a place filter hold for a document? -> null, or { direct, nearby, named }
function placeHit(d, places) {
  let best = null;
  for (const p of places) {
    let hit = null;
    const named = p.initialism ? d.caps.includes(p.initialism) : p.words.every(w => d.fields[0].includes(w) || d.fields[1].includes(w));
    if (named) hit = { direct: true, named: true, p };
    else if (p.state && d.club.state === p.state) hit = { direct: true, named: false, p };
    else if (d.placeGeo && p.places.includes(d.placeGeo)) hit = { direct: true, named: false, p };
    else if (d.countyGeo && p.counties.includes(d.countyGeo)) hit = { direct: false, named: false, p };
    if (hit && (!best || (hit.direct && !best.direct) || (hit.named && !best.named))) best = hit;
  }
  return best;
}

// The row of a squad a reading anchors on (latest first), or null. D11: a birth year also matches
// the active season's two-year division of a squad born the other year: a weak match, ranked lower.
// Returns the row, or null; ANCHOR_WEAK says whether it was a weak (D11) match. A module-level flag
// rather than a fresh object per squad: this runs for every candidate on every keystroke.
let ANCHOR_WEAK = false;
function anchorOf(d, r, ctx, active) {
  ANCHOR_WEAK = false;
  const seasons = r.seasons || (r.u ? [ctx.selectedSeason] : null);
  for (let i = d.rows.length - 1; i >= 0; i--) {
    const row = d.rows[i];
    if (seasons && !seasons.includes(row.season)) continue;
    if (!ageOk(row, r)) continue;
    if (r.band ? !(row.years.length === 2 && r.born.every(y => row.years.includes(y))) : r.born.length && !r.born.some(y => d.born.includes(y))) continue;
    if (r.conf && row.conf !== r.conf) continue;
    return row;
  }
  if (r.born.length && !r.band) {
    const row = d.rows.find(x => x.season === active);
    if (row && (!seasons || seasons.includes(active)) && ageOk(row, r) && (!r.conf || row.conf === r.conf)
        && row.years.length === 2 && r.born.some(y => row.years.includes(y))) { ANCHOR_WEAK = true; return row; }
  }
  return null;
}

// Search one side's team readings. -> { rows, reasons: Set }. With { partial: true }: documents
// that match some but not all name words of a reading (every filter still holds).
export function searchTeams(T, side, ctx, vocab, { partial = false, stats = null, known = null, cache = null } = {}) {
  const reasons = new Set();
  const best = new Map();
  const currentOnly = side.placeOnly;
  let hitsOf = [];   // #167 (MF3): each reading's own hits, before they are merged, for the Games section
  const run = (onlyCurrent) => {
    best.clear(); hitsOf = [];
    side.teams.forEach((r, ri) => {
      if (r.unknownSeason && !(r.seasons && r.seasons.length)) { reasons.add('season-not-in-archive'); return; }
      if (r.u) {
        const ss = r.seasons || [ctx.selectedSeason];
        if (!ss.some(s => (vocab.divs.get(s) || []).some(x => x.u === r.u))) { reasons.add('no-such-age-group'); return; }
      }
      if (partial && r.names.length < 2) return;
      const exps0 = r.names.map(n => expand(n.w, { terms: T.post.terms, initials: T.post.initials, known, last: n.last, stats, cache }));
      // a partial match never rests on a prefix shorter than 3 letters ("Great P", "qwerty a"): that is
      // noise, not a near miss (#163)
      const exps = partial ? exps0.map((e, k) => (r.names[k].w.length >= 3 ? e : new Map([...e].filter(([, v]) => v.cls !== 'prefix')))) : exps0;
      // A word read as a place, or one whose prefix or typo lands on an alias (Richmon, Richmnd), never
      // matches a club's city text by name: the place reading answers where (D8; #164 nit 1).
      const skip = r.names.map((n, k) => (n.place || [...exps[k].keys()].some(t => ALIASES[t]) ? PLACE_FIELD : -1));
      const reach = r.places ? placeUnion(T, r.places) : null;
      let cand;
      if (!r.names.length) cand = reach ? [...reach].sort((a, b) => a - b) : r.conf ? (T.lookups.conf.get(r.conf) || []) : T.docs.map(d => d.i);
      else if (partial) cand = [...new Set(exps.flatMap(e => [...T.post.candidates(e, stats)]))].sort((a, b) => a - b);
      else {
        const sets = exps.map(e => T.post.candidates(e, stats)).sort((a, b) => a.size - b.size);
        cand = [...sets[0]].filter(i => sets.every(s => s.has(i))).sort((a, b) => a - b);
      }
      const table = !!r.conf && !!(r.u || r.band) && !r.names.length && !r.places;
      const hits = [];
      const placePass = reach ? reach.size : 0;
      // filter scores are the same for every squad of this reading
      let filters = 0;
      if (r.conf) filters += filterScore(W_CONF, T.counts.conf.get(r.conf) || 0, T.N);
      for (const s of r.seasons || []) filters += filterScore(W_FILTER, T.counts.season.get(s) || 0, T.N) / r.seasons.length;
      if (r.u) filters += filterScore(W_FILTER, T.counts.u.get(r.u) || 0, T.N);
      for (const y of r.born) filters += filterScore(W_FILTER, T.counts.born.get(y) || 0, T.N) / r.born.length;
      const placeFilter = reach ? filterScore(W_PLACE, placePass, T.N) : 0;
      const nameSet = new Set(r.names.map(n => n.w));
      const codes = r.codes.map(c => [c, c.toLowerCase()]);
      for (const i of cand) {
        if (stats) stats.docsScored++;
        const d = T.docs[i];
        if (onlyCurrent && !d.current) continue;
        let score = 0, matched = 0, cls = 'exact', bestCls = 'typo', rarity = Infinity;
        const ws = new Array(exps.length);
        for (let k = 0; k < exps.length; k++) {
          const w = T.post.wordScore(i, exps[k], skip[k]);
          ws[k] = w;
          if (!w) continue;
          matched++; score += w.s;
          if (CLASS_RANK[w.cls] > CLASS_RANK[cls]) cls = w.cls;
          if (CLASS_RANK[w.cls] < CLASS_RANK[bestCls]) bestCls = w.cls;
          if (partial) rarity = Math.min(rarity, T.post.df(w.term) / T.N);
        }
        if (partial ? !(matched > 0 && matched < exps.length) : matched !== exps.length) continue;
        const ph = r.places ? placeHit(d, r.places) : null;
        if (r.places && !ph) continue;
        if (codes.length && !codes.every(([c, l]) => d.club.state === c || d.fields[0].includes(l) || d.fields[1].includes(l))) continue;
        const anchor = anchorOf(d, r, ctx, vocab.active);
        if (!anchor) continue;
        const weak = ANCHOR_WEAK;
        if (ph) {
          let ns = 0;
          if (ph.named && !ph.p.initialism) for (const w of ph.p.words) { const s = T.post.wordScore(i, exactOf(w)); if (s) ns += s.s; }
          score += Math.max(placeFilter, ns);
        }
        score += filters;
        hits.push({ d, anchor, weak, viaPair: r.u2 != null && anchor.u === r.u2, nearby: ph ? !ph.direct : false, score, cls, reading: ri, filterWords: r.filterWords, table,
          whole: d.titleWords.length > 0 && d.titleWords.every(w => nameSet.has(w)), ws, ph, conf: r.conf, seasonTyped: !!r.seasons,
          partialKey: partial ? { matched, cls: bestCls, rarity } : null });
      }
      hitsOf[ri] = hits;
      for (const h of hits) {
        const o = best.get(h.d.i);
        const fw = Math.max(h.filterWords, o ? o.filterWords : 0);
        const keep = !o || better(h, o) ? h : o;
        keep.filterWords = fw;      // a row is as specific as the most specific reading it matched (#163 Q2)
        best.set(h.d.i, keep);
      }
    });
  };
  run(currentOnly);
  let ended = false;
  if (currentOnly && !best.size) { run(false); ended = best.size > 0; }
  const out = [...best.values()];
  if (stats) stats.rowsSorted += out.length;
  out.sort(stats ? (a, b) => { stats.sortCompares++; return compare(a, b, currentOnly, partial); } : (a, b) => compare(a, b, currentOnly, partial));   // #165: comparisons are counted, not only rows
  const res = { rows: placeMaybe(out).map(h => rowOf(h, partial)), reasons, ended };
  // #167 (MF3): reading ri's squads as a search of that reading alone finds them ({ cls, squadRows, aliasIDs,
  // born }, what the Games section reads), so Games never searches teams a second time
  if (!partial) Object.defineProperty(res, 'readingRows', { value: ri => (hitsOf[ri] || []).map(h => ({ cls: h.cls, squadRows: h.d.rows, aliasIDs: h.d.x, born: h.d.born })) });
  return res;
}

// one exact expansion per word, kept (a place word read as a name word)
const EXACT = new Map();
const exactOf = w => { let m = EXACT.get(w); if (!m) { m = new Map([[w, { cls: 'exact', m: 1 }]]); EXACT.set(w, m); } return m; };

// #173: `better` (one squad matched by several readings) has no viaPair step. Two readings that anchor a squad on different rows carry
// different filter scores, so they never tie there; the tie-break lives in `compare` alone.
const better = (a, b) => (a.nearby !== b.nearby ? !a.nearby : a.weak !== b.weak ? !a.weak : a.table !== b.table ? a.table : a.score !== b.score ? a.score > b.score : a.reading < b.reading);

// Teams order (design, plus #163 Q3): table rows in table order; direct before nearby (D2); strong
// before weak (D11); score; whole-title match; plays this season; newest season; then, for a place
// on its own, age group oldest first before club (Q3, D12), otherwise club, title, age group.
function compare(a, b, placeOnly, partial) {
  if (partial) {
    const p = a.partialKey, q = b.partialKey;
    if (p.matched !== q.matched) return q.matched - p.matched;
    if (p.cls !== q.cls) return CLASS_RANK[p.cls] - CLASS_RANK[q.cls];
    if (p.rarity !== q.rarity) return p.rarity - q.rarity;
  }
  const A = a.d, B = b.d;
  if (a.table !== b.table) return a.table ? -1 : 1;
  if (a.table) return lt(a.anchor.conf, b.anchor.conf) || (a.anchor.rank || 99) - (b.anchor.rank || 99) || lt(A.sortClub, B.sortClub) || A.i - B.i;
  if (a.nearby !== b.nearby) return a.nearby ? 1 : -1;
  if (a.weak !== b.weak) return a.weak ? 1 : -1;
  if (a.score !== b.score) return b.score - a.score;
  // #173: at equal score, the squad that passed through the pair its own name spells goes first. It sits before the whole-title check
  // because the row's own name spelled the typed age, which is a typed word too. Never a score bonus: it cannot lift a row over a higher score.
  if (a.viaPair !== b.viaPair) return a.viaPair ? -1 : 1;
  if (a.whole !== b.whole) return a.whole ? -1 : 1;
  if (A.current !== B.current) return A.current ? -1 : 1;
  const sa = a.anchor.season, sb = b.anchor.season;
  if (sa !== sb) return sa < sb ? 1 : -1;
  const age = B.sortU - A.sortU;
  if (placeOnly) return age || lt(A.sortClub, B.sortClub) || lt(A.sortTitle, B.sortTitle) || lt(A.sortName, B.sortName) || A.i - B.i;
  return lt(A.sortClub, B.sortClub) || lt(A.sortTitle, B.sortTitle) || age || lt(A.sortName, B.sortName) || A.i - B.i;
}
const lt = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// A possible predecessor (#107 maybe) sits directly under its candidate(s); never merged (today's rule).
function placeMaybe(out) {
  if (!out.some(h => h.d.maybe.length || h.d.maybePrev.length)) return out;
  const inOut = new Map(out.map(h => [h.d, h]));
  const placed = new Set(), ordered = [];
  const place = h => { if (!placed.has(h)) { placed.add(h); ordered.push(h); } };
  for (const h of out) {
    if (placed.has(h)) continue;
    if (h.d.maybe.some(m => inOut.has(m) && !placed.has(inOut.get(m)))) continue;
    place(h);
    for (const prev of h.d.maybePrev) { const p = inOut.get(prev); if (p && !placed.has(p)) place(p); }
  }
  for (const h of out) place(h);
  return ordered;
}

// Why a row matched ("name: slammers (typo); place: Del Mar, CA (nearby)"): for tests and for a
// later explanation; hidden from visitors.
export function explain(why) {
  const out = why.ws.filter(Boolean).map(w => `${w.field}: ${w.term.replace(/^#/, '')}${w.cls === 'exact' ? '' : ` (${w.cls})`}`);
  if (why.ph) out.push(`place: ${why.ph.p.label}${why.ph.direct ? (why.ph.named ? ' (in the name)' : '') : ' (nearby)'}`);
  if (why.conf) out.push(`conference: ${why.conf}`);
  return out.join('; ');
}

// A result row. Its links and explanation are built when read, so a keystroke that matches
// hundreds of squads builds only what the panel shows.
class TeamRow {
  #h;
  constructor(h, partial) {
    const { d, anchor } = h;
    this.#h = h;
    this.section = 'teams'; this.kind = 'team'; this.key = d.key; this.clubID = d.club.id; this.club = d.club.name;
    this.born = d.born; this.current = d.current; this.title = d.titleText; this.name = d.latest.name;
    this.season = anchor.season; this.teamID = anchor.teamID; this.age = anchor.div; this.conf = anchor.conf;
    this.cls = h.cls; this.reading = h.reading; this.filterWords = h.filterWords; this.nearby = h.nearby; this.weak = h.weak;
    this.whole = h.whole; this.score = h.score;
    if (partial) { this.partial = true; this.partialKey = h.partialKey; }
  }
  get teamRows() { return this.#h.d.rows.map(r => `${r.season}/${r.teamID}`); }
  // #168: the squad's season rows ({ season, teamID, name, conf, div, u, years }) and its alias ids
  // ({ season, teamID }), from which the Games section takes the squad's games
  get squadRows() { return this.#h.d.rows; }
  get aliasIDs() { return this.#h.d.x; }
  get overviewHref() { const l = this.#h.d.latest; return teamHref(l.season, l.teamID, l.name); }
  get seasonHref() { const a = this.#h.anchor; return teamSeasonHref(a.season, a.teamID, a.name); }
  get href() { return this.#h.seasonTyped ? this.seasonHref : this.overviewHref; }
  get hrefs() { return [...new Set([this.href, this.overviewHref, this.seasonHref])]; }
  get why() { return explain(this.#h); }
  // #165 (SEARCH_API 2): structured fields, so the page never parses `why`.
  //   family {name, main}|null   the reviewed club family (#133), else null
  //   line                       the team name this squad's line is drawn under
  //   seasonTyped                the query named a season: the row opens that season's tab
  //   continuesAs / mayFrom      #107 squad keys: who this squad may continue as / who may continue as it
  //   place, last                the club's "City, ST" and the squad's last season
  //   matched [{term, cls, field}]   what each query word matched (cls: exact | prefix | typo)
  //   namedPlace                 the place's words when the place is in the team's name
  //   nearbyOf                   the place's label when the row is only nearby it
  //   was                        the earlier name that matched, when only an older name did (Reviewer point 6)
  get family() { const c = this.#h.d.club; return c.familyName ? { name: c.familyName, main: c.familyMain } : null; }
  get line() { return this.#h.d.titleText; }
  get seasonTyped() { return !!this.#h.seasonTyped; }
  get continuesAs() { return this.#h.d.maybe.map(x => x.key); }
  get mayFrom() { return this.#h.d.maybePrev.map(x => x.key); }
  get place() { const c = this.#h.d.club; return c.city ? `${c.city}, ${c.state}` : ''; }
  get matched() { return this.#h.ws.filter(Boolean).map(w => ({ term: w.term.replace(/^#/, ''), cls: w.cls, field: w.field })); }
  get namedPlace() { const p = this.#h.ph; return p && p.named && !p.p.initialism ? p.p.words : null; }
  get nearbyOf() { const p = this.#h.ph; return p && !p.direct ? p.p.label : null; }
  get last() { return this.#h.d.latest.season; }
  // The latest earlier name that holds every word the query matched in an older name ("Sting Black", for the
  // squad now called Sting Royal), or null: why a row is found when its own line says nothing of the query.
  get was() {
    const ow = this.#h.ws.filter(w => w && w.field === 'older name').map(w => w.term);
    if (!ow.length) return null;
    const d = this.#h.d;
    for (let k = d.rows.length - 2; k >= 0; k--) {
      const ws = withAliases(nameWords(d.rows[k].name));
      if (ow.every(t => ws.includes(t))) return teamTitle(d.rows[k].name, d.club.name);
    }
    return null;
  }
}

const rowOf = (h, partial) => new TeamRow(h, partial);
