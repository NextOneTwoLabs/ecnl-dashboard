// #168 (#149 phase 1, PR 4b): the Games category's index. One season's games file
// (docs/data-api.md, "Search data", games-<season>.json) becomes a games index, built in steps.
// No word is ever matched against game text: a game is found through the team documents the Teams
// section uses (its two team ids), a field (places.json's name@zip, D6/D6a), a flight (a conference,
// a national event, a showcase) or a day. Pure: "today" comes in through the context.
import { gameHref, teamHref, teamSeasonHref } from './links.mjs';
import { searchTeams } from './teams.mjs';
import { CLASS_RANK } from './match.mjs';

export const GAMES_SCHEMA = 1;
export const NO_DAY = -1e9;
const pad = n => String(n).padStart(2, '0');
// 'YYYY-MM-DD' <-> days since 1970-01-01 (UTC arithmetic: no time zone applies)
export const dayOf = s => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
export const dateOf = day => { const t = new Date(day * 86400000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };

// The games index of one season, in steps of at most n games per stage. It throws on a schema it does
// not know from the first next(). From the index: `vocab` (places.json's fields, places and counties: a
// field's label and city), `teamAt` ("season/teamID" -> the directory's name: a side's season tab) and
// `events` (eventID -> the event's document: its conference or stage name) and `squadAt` (#178: "season/teamID"
// -> the squad document, for a game's head-to-head link; null: no link).
export function* gamesIndexG(doc, { vocab, teamAt, events, squadAt = null }, n = 150) {
  if (!doc || doc.schema !== GAMES_SCHEMA) throw new Error(`games: unknown schema ${doc && doc.schema}`);
  const N = doc.games.length, base = dayOf(doc.base);
  const id = new Int32Array(N), day = new Int32Array(N), hm = new Int16Array(N), fl = new Int32Array(N), h = new Int32Array(N), a = new Int32Array(N);
  const hs = new Int16Array(N), as = new Int16Array(N), hp = new Int16Array(N), ap = new Int16Array(N), fx = new Int32Array(N), flags = new Uint8Array(N), dest = new Int8Array(N), dside = new Int8Array(N);
  const num = new Array(N), tbd = new Map();
  const fieldKeys = [], fieldIdx = new Map(), cxKey = new Map();
  for (const [cx, [name, zip]] of Object.entries(doc.fields)) { const k = `${name}@${zip}`; if (!fieldIdx.has(k)) { fieldIdx.set(k, fieldKeys.length); fieldKeys.push(k); } cxKey.set(+cx, fieldIdx.get(k)); }
  let prev = 0;
  for (let i = 0; i < N; i++) {
    if (i && i % n === 0) yield 'games:rows';
    const r = doc.games[i];
    const mid = r[0] + prev; prev = mid; id[i] = mid;
    const w = r[1];
    if (w == null) { day[i] = NO_DAY; hm[i] = -1; } else { const dd = Math.floor(w / 10000); day[i] = base + dd; const t = w - dd * 10000; hm[i] = t === 9999 ? -1 : t; }
    fl[i] = r[2];
    if (Number.isInteger(r[3])) h[i] = r[3]; else { h[i] = 0; tbd.set(`${i}h`, r[3] == null ? null : r[3]); }
    if (Number.isInteger(r[4])) a[i] = r[4]; else { a[i] = 0; tbd.set(`${i}a`, r[4] == null ? null : r[4]); }
    hs[i] = r[5] == null ? -1 : r[5]; as[i] = r[6] == null ? -1 : r[6]; hp[i] = r[7] == null ? -1 : r[7]; ap[i] = r[8] == null ? -1 : r[8];
    fx[i] = r[9] == null ? -1 : cxKey.get(r[9]); num[i] = r[10] == null ? null : r[10]; flags[i] = r[11] || 0;
    const d = r[12] || [0]; dest[i] = d[0]; dside[i] = d.length > 1 ? d[1] : -1;
  }
  yield 'games:lookups';
  const push = (m, k, i) => { let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(i); };
  const byTeam = new Map(), byField = new Map(), byFlight = new Map();
  for (let i = 0; i < N; i++) {
    if (i && i % (n * 4) === 0) yield 'games:lookups';
    if (h[i]) push(byTeam, h[i], i);
    if (a[i] && a[i] !== h[i]) push(byTeam, a[i], i);
    if (fx[i] >= 0) push(byField, fieldKeys[fx[i]], i);
    push(byFlight, fl[i], i);
  }
  yield 'games:order';
  // chronological order: day, kick-off, matchID; undated last (NO_DAY sorts first, so it is moved)
  const byOrd = Int32Array.from({ length: N }, (_, i) => i).sort((x, y) => (day[x] === NO_DAY) - (day[y] === NO_DAY) || (day[x] - day[y]) || (hm[x] - hm[y]) || (id[x] - id[y]));
  const ord = new Int32Array(N); for (let p = 0; p < N; p++) ord[byOrd[p]] = p;
  const flights = new Map(Object.entries(doc.flights).map(([f, [eventID, kind, div, tier]]) => { const ev = events.get(eventID); return [+f, { eventID, kind, div, tier, event: ev ? ev.name : null }]; }));
  // a field's label and city, from places.json: read when a row is drawn, kept
  const fieldMeta = new Map();
  const fieldInfo = key => {
    let m = fieldMeta.get(key);
    if (!m) { m = fieldLabel(key, vocab); fieldMeta.set(key, m); }
    return m;
  };
  return { season: doc.season, build: doc.build, N, id, day, hm, fl, h, a, hs, as, hp, ap, fx, num, flags, dest, dside, tbd, fieldKeys, byTeam, byField, byFlight, byOrd, ord, flights,
    teams: doc.teams, alt: doc.alt, teamAt, squadAt, fieldInfo, mark: new Uint8Array(N), mr: new Int8Array(N), ms: new Uint8Array(N) };
}

// A field's label (its original spelling, places.json) and "City, ST" (its census place, else its county).
// `v` holds places.json's fields, places and counties (the vocabulary does).
export function fieldLabel(key, v) {
  const f = (v.fields || {})[key];
  const name = key.slice(0, key.lastIndexOf('@'));
  if (!f) return { label: name, place: '' };
  const p = f[3] && (v.places || {})[f[3]], c = f[4] && (v.counties || {})[f[4]];
  return { label: f[0] || name, place: p ? `${p[0]}, ${p[1]}` : c ? `${c[0]}, ${c[1]}` : '' };
}

// A side of a game: its team id, name and club, as that game's event spells it (alt first), and its
// season tab when the directory lists that team in that season (else null: no team page to open).
export function gameSide(G, i, k) {
  const t = k === 'h' ? G.h[i] : G.a[i];
  if (!t) return { teamID: null, name: G.tbd.get(`${i}${k}`) || 'TBD', clubID: null, seasonHref: null };
  const f = G.flights.get(G.fl[i]);
  const [name, clubID] = G.alt[`${t}:${f.eventID}`] || G.teams[t] || [`Team ${t}`, null];
  const dir = G.teamAt ? G.teamAt.get(`${G.season}/${t}`) : null;
  return { teamID: t, name, clubID, seasonHref: dir ? teamSeasonHref(G.season, t, dir) : null };
}

// A game row (SEARCH_API 3). Built when read: a keystroke that matches thousands of games makes only
// the rows it returns, and their fields only when drawn.
//   matchID, season, date ('YYYY-MM-DD' | null), time ('HH:MM' | null), home, away, score, pk, winner,
//   competition { kind: c|n|s, eventID, event (conference or stage name, or the showcase's), div, tier,
//   flightID }, field { name, zip, number, label, place } | null, flags, dest, href, hrefs,
//   matched 'home' | 'away' | 'both' | null (the side the query's names matched), aHome (vs: side A at home)
export class GameRow {
  #G; #i;
  constructor(G, i, o) {
    this.#G = G; this.#i = i;
    this.section = 'games'; this.kind = 'game'; this.matchID = G.id[i]; this.season = G.season;
    this.cls = o.cls; this.reading = o.reading; this.filterWords = o.filterWords;
    this.matched = o.matched || null;
    if (o.aHome != null) this.aHome = o.aHome;
  }
  get home() { return gameSide(this.#G, this.#i, 'h'); }
  get away() { return gameSide(this.#G, this.#i, 'a'); }
  get date() { const d = this.#G.day[this.#i]; return d === NO_DAY ? null : dateOf(d); }
  get time() { const t = this.#G.hm[this.#i]; return t < 0 ? null : `${pad(Math.floor(t / 100))}:${pad(t % 100)}`; }
  get score() { const G = this.#G, i = this.#i; return G.hs[i] < 0 || G.as[i] < 0 ? null : [G.hs[i], G.as[i]]; }
  get pk() { const G = this.#G, i = this.#i; return G.hp[i] < 0 || G.ap[i] < 0 ? null : [G.hp[i], G.ap[i]]; }
  get winner() { const s = this.score; if (!s) return null; const p = this.pk; if (s[0] !== s[1]) return s[0] > s[1] ? 'home' : 'away'; if (p && p[0] !== p[1]) return p[0] > p[1] ? 'home' : 'away'; return null; }
  get competition() { const G = this.#G, f = G.flights.get(G.fl[this.#i]); return { kind: f.kind, eventID: f.eventID, event: f.event, div: f.div, tier: f.tier, flightID: G.fl[this.#i] }; }
  get field() {
    const G = this.#G, i = this.#i;
    if (G.fx[i] < 0) return null;
    const key = G.fieldKeys[G.fx[i]], at = key.lastIndexOf('@'), m = G.fieldInfo(key);
    return { name: key.slice(0, at), zip: key.slice(at + 1), number: G.num[i], label: m.label, place: m.place };
  }
  get flags() { return this.#G.flags[this.#i]; }
  get dest() { const G = this.#G, i = this.#i; return G.dside[i] >= 0 ? [G.dest[i], G.dside[i]] : [G.dest[i]]; }
  get href() { return gameHref(this); }
  get hrefs() { const h = this.href; return h ? [h] : []; }
  // #178: the game's head to head: side A is the side the query matched (else home), both by this game's season and
  // ids; null when a side is still to be decided, has no squad in the directory (no team page) or is the other side
  get h2hHref() { return gameH2HHref(this.#G, this.#i, this.matched === 'away' ? 'a' : 'h', this.#G.squadAt, this.#G.teamAt, true); }
}

// ---------- the search ----------
// Searching the loaded games indexes for one query.
// -> { rows, reasons, coverage }. The readings (reader.mjs `games`):
//   a field (D6, D6a)        one field row per name@zip, then its games
//   a place, no name (D2)    field rows: in the place first, then the rest of its county (nearby)
//   name words               the games of the squads the Teams section's own matcher finds, with the
//                            reading's season, age group, birth year (D11's weak rule) and conference
//   a conference / kind word that conference's, those national events' or the showcases' games
//   a date                   the games on that day
//   vs (two sides)           one pairing row per season and age group in which they met (D5); with one
//                            squad a side, the meetings themselves, and a Load row for earlier seasons
// Order (design, Q1): upcoming games (unplayed, today or later) soonest first, then the rest newest first,
// undated last. Seasons: a reading's own, else the active season (a field reading adds the seasons this
// visit has loaded in which the field had games, so its Load cell shows them). Pure: "today" is
// context.today; the page says which seasons are loading, missing (404) or failed.

const RANK_CLASS = ['exact', 'prefix', 'typo'];
// The seasons a reading's games come from: its own, else the active season.
const seasonsOf = (r, vocab) => (r.seasons && r.seasons.length ? r.seasons : r.unknownSeason ? [] : [vocab.active]);
// A date token ("10/18", "2026-10-18") as days; "10/18" in each of the seasons
function daysOf(r, seasons) {
  const out = new Set();
  for (const t of r.dates) {
    let m;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out.add(dayOf(t));
    else if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(t))) for (const s of seasons) { const y = +s.slice(0, 4) + (+m[1] <= 6 ? 1 : 0); out.add(dayOf(`${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`)); }
  }
  return out;
}
// Does a squad's season row pass a reading's filters (as teams.mjs anchorOf)?
function rowPasses(row, r, born, active) {
  if (r.u && row.u !== r.u) return false;
  // a birth year: the squad's own (strong), or D11's weak match on an active-season two-year division
  const weak = y => row.season === active && row.years.length === 2 && row.years.includes(y);
  if (r.band ? !(row.years.length === 2 && r.born.every(y => row.years.includes(y))) : r.born.length && !r.born.some(y => born.includes(y) || weak(y))) return false;
  if (r.conf && row.conf !== r.conf) return false;
  return true;
}
// The Teams section's matcher for a reading's name words (its field, dates and kinds left out).
function teamsOf(index, r, ctx, opts) {
  if (opts.stats) opts.stats.teamSearches = (opts.stats.teamSearches || 0) + 1;
  const tr = { ...r, field: null, dates: [], kinds: [] };
  return searchTeams(index.teams, { teams: [tr], placeOnly: false }, ctx, index.vocab, { known: index.known, cache: opts.cache, stats: opts.stats }).rows;
}
// The (season/teamID) keys of a reading's squads in the given seasons -> Map key -> class
function teamKeys(index, r, ctx, opts, seasons) {
  const out = new Map();
  for (const row of teamsOf(index, r, ctx, opts)) {
    for (const sr of row.squadRows) if (seasons.includes(sr.season) && rowPasses(sr, r, row.born, index.vocab.active)) out.set(`${sr.season}/${sr.teamID}`, row.cls);
    for (const x of row.aliasIDs) if (seasons.includes(x.season)) out.set(`${x.season}/${x.teamID}`, row.cls);
  }
  return out;
}
// The same as int maps, per season: season -> Map(teamID -> class rank). `rows` are the reading's squads
// ({ cls, squadRows, aliasIDs, born }: Teams rows, or a reading's own hits).
function teamRanks(index, r, rows, seasons) {
  const out = new Map(seasons.map(s => [s, new Map()]));
  const put = (s, id, rk) => { const m = out.get(s); if (!m) return; const o = m.get(id); if (o === undefined || rk < o) m.set(id, rk); };
  for (const row of rows) {
    const rk = CLASS_RANK[row.cls];
    for (const sr of row.squadRows) if (out.has(sr.season) && rowPasses(sr, r, row.born, index.vocab.active)) put(sr.season, sr.teamID, rk);
    for (const x of row.aliasIDs) put(x.season, x.teamID, rk);
  }
  return out;
}
const KIND_RE = new Map(), kindRe = k => { let re = KIND_RE.get(k); if (!re) KIND_RE.set(k, (re = new RegExp(`\\b${k}\\b`, 'i'))); return re; };   // compiled once (nit 9)
const divOf = (vocab, season, div) => (vocab.divs.get(season) || []).find(d => d.name === div) || {};
// club id -> name, from the team documents (pairing sides), made once per index
function clubNames(index) {
  if (!index.clubNames) { const m = new Map(); for (const d of index.teams.docs) if (!m.has(d.club.id)) m.set(d.club.id, d.club.name); index.clubNames = m; }
  return index.clubNames;
}

export function searchGames(index, reader, ctx, opts = {}) {
  const vocab = index.vocab, reasons = new Set();
  const loading = new Set(ctx.gamesLoading || []), missing = new Set(ctx.gamesMissing || []), failed = new Set(ctx.gamesFailed || []);
  const cov = new Map();   // season -> ready | missing | loading | failed | not-loaded | on-request
  const stateOf = s => (index.games.has(s) ? 'ready' : missing.has(s) ? 'missing' : loading.has(s) ? 'loading' : failed.has(s) ? 'failed' : 'not-loaded');
  const need = s => { if (!cov.has(s)) cov.set(s, stateOf(s)); };
  const tday = dayOf(ctx.today);
  const coverage = () => [...cov].map(([season, state]) => ({ season, state }));
  if (reader.vs) return vsGames(index, reader, ctx, opts, cov, stateOf, tday);
  const side = reader.sides[0];
  const fields = new Map();
  // marked games, per season: G.mark[i] = class rank + 1 (0: not found), G.mr[i] = the reading, G.ms[i] the
  // matched sides (1 home, 2 away). Reset in the finally, even if a search throws (nit 2).
  const touched = new Map();
  const touch = G => { let t = touched.get(G.season); if (!t) touched.set(G.season, (t = { G, list: [] })); return t; };
  try {
    side.games.forEach((r, ri) => {
      if (r.unknownSeason && !(r.seasons && r.seasons.length)) { reasons.add('season-not-in-archive'); return; }
      let seasons = seasonsOf(r, vocab);
      if (r.u && !seasons.some(s => (vocab.divs.get(s) || []).some(x => x.u === r.u))) { reasons.add('no-such-age-group'); return; }
      const base = { cls: 'exact', reading: ri, filterWords: r.filterWords };
      // fields: a field reading, or a place with no name, conference or kind
      if (r.field || (r.places && !r.names.length && !r.conf && !r.kinds.length)) {
        let fieldSeasons = seasons;
        for (const [key, f] of Object.entries(vocab.fields)) {
          const name = key.slice(0, key.lastIndexOf('@'));
          let nearby = false;
          if (r.field) { if (name !== r.field) continue; }
          else {
            let hit = null;
            for (const p of r.places) {
              if (p.places.includes(f[3]) || (p.state && vocab.places[f[3]] && vocab.places[f[3]][1] === p.state) || (p.state && vocab.counties[f[4]] && vocab.counties[f[4]][1] === p.state)) { hit = 'direct'; break; }
              if (p.counties.includes(f[4])) hit = hit || 'nearby';
            }
            if (!hit) continue;
            nearby = hit === 'nearby';
            if (r.codes.length && !r.codes.some(c => (vocab.places[f[3]] || vocab.counties[f[4]] || [])[1] === c)) continue;
          }
          if (r.fieldNumber != null && !f[2].includes(r.fieldNumber)) continue;
          // a field named with no season: the active season, plus the seasons loaded so far in which it had
          // games (its Load cell brings one in)
          const asked = r.field && !(r.seasons && r.seasons.length) ? vocab.seasons.filter(s => s === vocab.active || (index.games.has(s) && f[1].includes(s))) : seasons;
          if (r.field) fieldSeasons = [...new Set([...fieldSeasons, ...asked])];
          const placeLabel = f[3] && vocab.places[f[3]] ? `${vocab.places[f[3]][0]}, ${vocab.places[f[3]][1]}` : f[4] && vocab.counties[f[4]] ? `${vocab.counties[f[4]][0]}, ${vocab.counties[f[4]][1]}` : '';
          const o = fields.get(key);
          if (!o || (o.nearby && !nearby)) fields.set(key, { key, f, number: r.fieldNumber, nearby, nearbyOf: nearby ? r.places.map(p => p.label).join(' or ') : null, placeLabel, asked, allAges: !!(r.u || r.born.length), ...base });
        }
        for (const s of fieldSeasons) need(s);
        if (!r.field) return;   // a place lists its fields (Q7), not every game played there
        seasons = vocab.seasons.filter(s => fieldSeasons.includes(s));
      } else for (const s of seasons) need(s);
      const loaded = seasons.filter(s => index.games.has(s));
      if (!loaded.length) return;
      const days = r.dates.length ? daysOf(r, loaded) : null;
      // a field reading: the last word, while it is still a prefix of "field" ("Great Park f"), names no team
      if (r.field && r.names.length === 1 && r.names[0].last && 'field'.startsWith(r.names[0].w)) r = { ...r, names: [] };
      // #167 (MF3): a name reading's squads from the Teams search already made for this reading (opts.teams: that
      // search's result, whose readings are side.teams), else a team search of the reading alone
      const tri = opts.teams && opts.teams.readingRows ? side.teams.indexOf(r) : -1;
      const tk = r.names.length ? teamRanks(index, r, tri >= 0 ? opts.teams.readingRows(tri) : teamsOf(index, r, ctx, opts), loaded) : null;
      for (const s of loaded) {
        const G = index.games.get(s);
        const t = touch(G);
        const take = i => {
          if (opts.stats) opts.stats.gamesVisited = (opts.stats.gamesVisited || 0) + 1;   // every game visited (nit 1)
          if (days && !days.has(G.day[i])) return;
          if (r.fieldNumber != null && G.num[i] !== r.fieldNumber) return;
          let rk = 0, sides = 0;
          if (tk) {
            const m = tk.get(s), x = m.get(G.h[i]), y = m.get(G.a[i]);
            if (x === undefined && y === undefined) return;
            rk = Math.min(x === undefined ? 9 : x, y === undefined ? 9 : y);
            sides = (x === undefined ? 0 : 1) | (y === undefined ? 0 : 2);
          } else if (r.u || r.born.length) {
            const d = divOf(vocab, s, G.flights.get(G.fl[i]).div);
            if (r.u && d.u !== r.u) return;
            if (r.born.length && !r.born.some(y => (d.years || []).includes(y))) return;
          }
          const cur = G.mark[i];
          if (!cur) { t.list.push(i); G.mark[i] = rk + 1; G.mr[i] = ri; G.ms[i] = sides; }
          else { if (rk + 1 < cur) { G.mark[i] = rk + 1; G.mr[i] = ri; } G.ms[i] |= sides; }
        };
        if (r.field) { for (const key of fields.keys()) if (key.startsWith(r.field + '@')) for (const i of G.byField.get(key) || []) take(i); }
        else if (tk) { for (const id of tk.get(s).keys()) for (const i of G.byTeam.get(id) || []) take(i); }
        else if (r.conf || r.kinds.length) {
          for (const [fid, f] of G.flights) {
            if (r.conf && !(f.kind === 'c' && f.event === r.conf)) continue;
            let ok = true;
            for (const k of r.kinds) ok = ok && (k === 'showcase' ? f.kind === 's' : k === 'standings' ? f.kind === 'c' : f.kind === 'n' && !!f.event && kindRe(k).test(f.event));
            if (ok) for (const i of G.byFlight.get(fid) || []) take(i);
          }
        } else if (days) for (let i = 0; i < G.N; i++) take(i);
      }
    });
    const rows = [];
    // field rows, MF4: in the place first; a field with games in the seasons asked before one without; then
    // by upcoming games, by games, by seasons played, by key
    const count = (key, num, seasons, f) => { let n = 0, up = 0, played = 0; for (const s of seasons) { const G = index.games.get(s); if (G) for (const i of G.byField.get(key) || []) if (num == null || G.num[i] === num) { n++; if (G.hs[i] >= 0 && G.as[i] >= 0) played++; else if (G.day[i] !== NO_DAY && G.day[i] >= tday) up++; } } return f({ n, up, played }); };
    const fr = [...fields.values()].map(x => count(x.key, x.number, x.asked, c => ({ ...x, count: c.n, upcoming: c.up, played: c.played })));
    fr.sort((a, b) => (a.nearby - b.nearby) || ((b.count > 0) - (a.count > 0)) || (b.upcoming - a.upcoming) || (b.count - a.count) || (b.f[1].length - a.f[1].length) || (a.key < b.key ? -1 : 1));
    for (const x of fr) rows.push(fieldRow(index, x, tday));
    // games: upcoming soonest first (seasons oldest first), then the rest newest first, undated last
    const lists = [...touched.values()].sort((x, y) => (x.G.season < y.G.season ? -1 : 1));
    const up = [], past = [], none = [];
    for (const { G, list } of lists) {
      const inOrd = list.length * 8 > G.N ? (() => { const o = []; for (let p = 0; p < G.N; p++) { const i = G.byOrd[p]; if (G.mark[i]) o.push(i); } return o; })() : list.sort((x, y) => G.ord[x] - G.ord[y]);
      const ps = [], ns = [];
      for (const i of inOrd) { if (G.day[i] === NO_DAY) ns.push([G, i]); else if (G.day[i] >= tday && G.hs[i] < 0) up.push([G, i]); else ps.push([G, i]); }
      past.unshift(...ps.reverse()); none.unshift(...ns.reverse());   // seasons newest first, each newest first
    }
    const SIDE = [null, 'home', 'away', 'both'];
    for (const [G, i] of [...up, ...past, ...none]) rows.push(new GameRow(G, i, { cls: RANK_CLASS[G.mark[i] - 1], reading: G.mr[i], filterWords: side.games[G.mr[i]].filterWords, matched: SIDE[G.ms[i]] }));
    return { rows, reasons, coverage: coverage() };
  } finally { for (const { G, list } of touched.values()) for (const i of list) { G.mark[i] = 0; G.ms[i] = 0; } }
}

// A field row (SEARCH_API 3): one normalised field (name plus zip, D6), from places.json, whether or not a
// loaded season has games there.
//   key, field { name, zip, number }, label, place, seasons (every season with games there), numbers,
//   asked (the seasons this reading asks), loaded (those loaded), notLoaded (its seasons not loaded),
//   count / upcoming / played (its games in the loaded seasons asked), nearby, nearbyOf, allAges (an age in
//   the query does not apply to a field: its games are every age group's), and `games` (read when opened)
function fieldRow(index, x, tday) {
  const [name, zip] = [x.key.slice(0, x.key.lastIndexOf('@')), x.key.slice(x.key.lastIndexOf('@') + 1)];
  const f = x.f;
  const row = {
    section: 'games', kind: 'field', key: x.key, field: { name, zip, number: x.number == null ? null : x.number }, label: f[0] || name, place: x.placeLabel,
    seasons: f[1], numbers: f[2], placeGeo: f[3], countyGeo: f[4], asked: x.asked, loaded: x.asked.filter(s => index.games.has(s)), notLoaded: f[1].filter(s => !index.games.has(s)),
    count: x.count, upcoming: x.upcoming, played: x.played, nearby: x.nearby, nearbyOf: x.nearbyOf, allAges: x.allAges,
    cls: x.cls, reading: x.reading, filterWords: x.filterWords, hrefs: [],
  };
  // its games in the loaded seasons asked, in the games order: built only when the row is opened
  Object.defineProperty(row, 'games', { enumerable: false, get: () => {
    const list = [];
    for (const s of row.loaded) { const G = index.games.get(s); for (const i of G.byField.get(x.key) || []) if (x.number == null || G.num[i] === x.number) list.push({ G, i, o: { cls: 'exact', reading: x.reading, filterWords: x.filterWords } }); }
    return orderGames(list, tday).map(({ G, i, o }) => new GameRow(G, i, o));
  } });
  return row;
}

// upcoming (unplayed, today or later) soonest first; then the rest newest first; undated last
export function orderGames(list, tday) {
  const up = [], past = [], none = [];
  for (const x of list) { const { G, i } = x; if (G.day[i] === NO_DAY) none.push(x); else if (G.day[i] >= tday && G.hs[i] < 0) up.push(x); else past.push(x); }
  const k = x => x.G.ord[x.i], ss = (x, y) => (x.G.season < y.G.season ? -1 : x.G.season > y.G.season ? 1 : 0);
  up.sort((x, y) => ss(x, y) || k(x) - k(y)); past.sort((x, y) => -ss(x, y) || k(y) - k(x)); none.sort((x, y) => k(x) - k(y));
  return [...up, ...past, ...none];
}

// vs: side A against side B
function vsGames(index, reader, ctx, opts, cov, stateOf, tday) {
  const vocab = index.vocab, reasons = new Set();
  const coverage = () => [...cov].map(([season, state]) => ({ season, state }));
  const [A, B] = reader.sides;
  // a side's readings: those with a season in the archive, when it has any; one squad a side when one of
  // them names an age group or a birth year (then only those)
  const usable = s => { const ok = s.games.filter(r => !(r.unknownSeason && !(r.seasons && r.seasons.length))); return ok.length ? ok : s.games; };
  const isSpec = r => !!(r.u || r.born.length || r.band);
  const readsOf = s => { const u = usable(s); return u.some(isSpec) ? u.filter(isSpec) : u; };
  const specific = s => usable(s).some(isSpec);
  const sideKeys = (s, seasons) => { const m = new Map(); for (const r of readsOf(s)) if (r.names.length) for (const [k, cls] of teamKeys(index, r, ctx, opts, seasons)) { const o = m.get(k); if (!o || CLASS_RANK[cls] < CLASS_RANK[o]) m.set(k, cls); } return m; };
  const r0 = readsOf(A)[0] || readsOf(B)[0];
  if (!r0) return { rows: [], reasons, coverage: [] };
  if (r0.unknownSeason && !(r0.seasons && r0.seasons.length)) { reasons.add('season-not-in-archive'); return { rows: [], reasons, coverage: [] }; }
  let seasons = seasonsOf(r0, vocab), onRequest = [];
  const both = specific(A) && specific(B);
  if (both && !(r0.seasons && r0.seasons.length)) {
    // MF1 (owner, Q2): one squad a side and no season: the meetings in the seasons this visit has loaded
    // that both squads played; the other seasons they both played only on request ("Load earlier meetings")
    const all = vocab.seasons;
    const ka = sideKeys(A, all), kb = sideKeys(B, all);
    const sa = new Set([...ka.keys()].map(k => k.split('/')[0])), sb = new Set([...kb.keys()].map(k => k.split('/')[0]));
    const played = all.filter(s => sa.has(s) && sb.has(s));
    seasons = played.filter(s => index.games.has(s));
    onRequest = played.filter(s => !index.games.has(s));
    for (const s of onRequest) { const st = stateOf(s); cov.set(s, st === 'not-loaded' ? 'on-request' : st); }
  }
  for (const s of seasons) if (!cov.has(s)) cov.set(s, stateOf(s));
  const loaded = seasons.filter(s => index.games.has(s));
  const ka = sideKeys(A, loaded), kb = sideKeys(B, loaded);
  const meet = [];
  for (const s of loaded) {
    const G = index.games.get(s);
    for (const k of ka.keys()) if (k.startsWith(s + '/')) for (const i of G.byTeam.get(+k.slice(s.length + 1)) || []) {
      if (opts.stats) opts.stats.gamesVisited = (opts.stats.gamesVisited || 0) + 1;
      const ha = ka.get(`${s}/${G.h[i]}`), aa = ka.get(`${s}/${G.a[i]}`), hb = kb.get(`${s}/${G.h[i]}`), ab = kb.get(`${s}/${G.a[i]}`);
      if ((ha && ab) || (aa && hb)) meet.push({ G, i, aHome: !!(ha && ab), cls: [ha || aa, hb || ab].sort((x, y) => CLASS_RANK[y] - CLASS_RANK[x])[0] });
    }
  }
  const seen = new Set(), uniq = meet.filter(m => { const k = `${m.G.season}/${m.G.id[m.i]}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const asRows = list => orderGames(list.map(m => ({ ...m, o: { cls: m.cls, reading: 0, filterWords: r0.filterWords, aHome: m.aHome } })), tday).map(({ G, i, o }) => new GameRow(G, i, o));
  if (both) {
    const rows = asRows(uniq);
    // #178: one squad a side leads with the head-to-head summary. A side's squad: its one strong match (D11's weak
    // match, the active season's two-year division of the other birth year, gives way), else its one match; a side
    // with two strong squads (a club's Navy and Green teams) gets no lead row (Q9)
    const pick = s => {
      const by = new Map();
      for (const r of readsOf(s)) if (r.names.length) for (const t of teamsOf(index, r, ctx, opts)) { const o = by.get(t.key); if (!o || (o.weak && !t.weak)) by.set(t.key, t); }
      const all = [...by.values()], strong = all.filter(t => !t.weak);
      return strong.length === 1 ? strong[0] : !strong.length && all.length === 1 ? all[0] : null;
    };
    const pa = pick(A), pb = pick(B), sq = squadAt(index);
    const da = pa && sq.get(pa.key), db = pb && sq.get(pb.key);
    if (da && db && da !== db) rows.unshift(h2hRow(index, da, db, ctx, { cls: 'exact', reading: 0, filterWords: r0.filterWords }));
    // the Load row: never `enter`, never a result; it keeps the Games section (H04) when nothing is loaded yet
    const rest = onRequest.filter(s => cov.get(s) !== 'missing');
    if (rest.length) {
      const st = rest.map(s => cov.get(s));
      rows.push({ section: 'games', kind: 'load', what: 'meetings', seasons: rest, state: st.includes('loading') ? 'loading' : st.includes('failed') ? 'failed' : 'on-request',
        played: vocab.seasons.filter(s => seasons.includes(s) || onRequest.includes(s)), meetingsLoaded: uniq.length, cls: 'exact', reading: 0, filterWords: r0.filterWords, hrefs: [] });
    }
    return { rows, reasons, coverage: coverage() };
  }
  // D5: one pairing row per season and age group in which they met; a side is the clubs that met
  const cA = new Set(), cB = new Set();
  for (const m of uniq) { const h = gameSide(m.G, m.i, 'h').clubID, a = gameSide(m.G, m.i, 'a').clubID; if (m.aHome) { cA.add(h); cB.add(a); } else { cA.add(a); cB.add(h); } }
  const names = clubNames(index);
  const sides = [[...cA].sort((x, y) => x - y), [...cB].sort((x, y) => x - y)];
  const sideNames = sides.map(s => s.map(c => names.get(c) || `Club ${c}`));
  const by = new Map();
  for (const m of uniq) {
    const f = m.G.flights.get(m.G.fl[m.i]), k = `${m.G.season}|${f.div}`;
    if (!by.has(k)) by.set(k, { season: m.G.season, div: f.div, games: [] });
    by.get(k).games.push(m);
  }
  const rows = [...by.values()].map(p => {
    let w = 0, d = 0, l = 0;
    for (const m of p.games) { const o = outcome(m); if (o === 1) w++; else if (o === -1) l++; else if (o === 0) d++; }
    // #178: the squad pairs that met in this row; one opens its head to head, several each open theirs (their meetings')
    const sq = squadAt(index), sp = new Map();
    for (const m of p.games) {
      const G = m.G, x = sq.get(`${G.season}/${m.aHome ? G.h[m.i] : G.a[m.i]}`), y = sq.get(`${G.season}/${m.aHome ? G.a[m.i] : G.h[m.i]}`);
      if (x && y && x !== y && !sp.has(`${x.key}|${y.key}`)) sp.set(`${x.key}|${y.key}`, { a: x, b: y, m });
    }
    const one = sp.size === 1 ? [...sp.values()][0] : null;
    return { section: 'games', kind: 'pairing', key: `${p.season}|${p.div}`, sides, sideNames, season: p.season, div: p.div, u: divOf(vocab, p.season, p.div).u || 0,
      squadPairs: sp.size, h2hHref: one ? gameH2HHref(one.m.G, one.m.i, one.m.aHome ? 'h' : 'a', sq, index.teamAt) : null,
      pairNames: [...sp.values()].map(x => [x.a.latest.name, x.b.latest.name]),
      record: [w, d, l], meetings: asRows(p.games), cls: p.games.map(m => m.cls).sort((x, y) => CLASS_RANK[y] - CLASS_RANK[x])[0], reading: 0, filterWords: r0.filterWords, hrefs: [] };
  });
  // newest season first; then the oldest age group first
  rows.sort((a, b) => (a.season < b.season ? 1 : a.season > b.season ? -1 : 0) || b.u - a.u || (a.div < b.div ? -1 : 1));
  return { rows, reasons, coverage: coverage() };
}

// ---------- #178 (#149 phase 1, PR 6): head to head ----------
// Computed on the fly from the per-season games indexes search already loads; nothing is pre-built per pair.
// Pure: "today" comes in. A side is a squad (a team document: its conference rows `rows` and its alias ids at
// national events and showcases `x`); its earlier teams across the 2026-27 regroup (`maybePrev`) are listed for the
// visitor to add, never added or merged here.
const enc = encodeURIComponent;

// The head-to-head link: side A's team page with vs=<season>:<B>. The colon stays literal (URLSearchParams reads it).
export const h2hHref = (a, b) => `${teamHref(a.season, a.teamID, a.name)}&vs=${enc(b.season)}:${enc(b.teamID)}`;
export const VS_RE = /^(\d{4}-\d{2}):([1-9]\d{0,9})$/;
// vs= -> { season, teamID } | null (malformed)
export function parseVs(v) { const m = VS_RE.exec(v || ''); return m ? { season: m[1], teamID: +m[2] } : null; }

// "season/teamID" -> the squad document, built once per index. TGS reuses ids across squads, but never two squads in
// one season (a test pins it).
export function squadAt(index) {
  if (!index.squadAt) {
    const m = new Map();
    for (const d of index.teams.docs) { for (const r of d.rows) m.set(`${r.season}/${r.teamID}`, d); for (const x of d.x) m.set(`${x.season}/${x.teamID}`, d); }
    index.squadAt = m;
  }
  return index.squadAt;
}

// One side: season plus team id -> its squad, and the earlier teams it may continue across the regroup (#107
// maybePrev). None is chosen, none is merged: the page lists them and the visitor adds them.
export function resolveSide(index, season, teamID) {
  if (!index.vocab.seasons.includes(season)) return { error: 'unknown-season' };
  const d = squadAt(index).get(`${season}/${teamID}`);
  if (!d) return { error: 'no-squad' };
  return { doc: d, key: d.key, name: d.latest.name, club: d.club.name, born: d.born, first: d.rows[0].season, last: d.latest.season, candidates: d.maybePrev };
}

// season -> Set(teamID) over a side's squads
function idsOf(docs) {
  const m = new Map();
  const put = (s, t) => { let x = m.get(s); if (!x) m.set(s, (x = new Set())); x.add(t); };
  for (const d of docs) { for (const r of d.rows) put(r.season, r.teamID); for (const x of d.x) put(x.season, x.teamID); }
  return m;
}
// The seasons both sides played (their squads plus any earlier teams chosen): the only games files that can hold a
// meeting, so the head to head is complete once they are loaded. -> { both, loaded, need }
export function h2hSeasons(index, A, B) {
  const ia = idsOf(A), ib = idsOf(B), have = index.games || new Map();
  const both = index.vocab.seasons.filter(s => ia.has(s) && ib.has(s));
  return { both, loaded: both.filter(s => have.has(s)), need: both.filter(s => !have.has(s)) };
}

// How a game went for side A: 1 won, -1 lost, 0 drawn, null unplayed. As on the team Overview (docs/data-api.md), a
// shoot-out win counts as a win and a shoot-out loss as a loss; penalties are never goals. -> { r, pk } or null
function outcomeOf(G, i, aHome) {
  if (G.hs[i] < 0 || G.as[i] < 0) return null;
  const [x, y] = aHome ? [G.hs[i], G.as[i]] : [G.as[i], G.hs[i]];
  if (x !== y) return { r: x > y ? 1 : -1, pk: false, x, y };
  if (G.hp[i] >= 0 && G.ap[i] >= 0 && G.hp[i] !== G.ap[i]) { const [p, q] = aHome ? [G.hp[i], G.ap[i]] : [G.ap[i], G.hp[i]]; return { r: p > q ? 1 : -1, pk: true, x, y }; }
  return { r: 0, pk: false, x, y };
}
const outcome = m => { const o = outcomeOf(m.G, m.i, m.aHome); return o ? o.r : null; };

// The head to head of side A (its squads: the squad first, then the earlier teams chosen) against side B, over the
// seasons loaded. -> { seasons, complete, meetings (GameRow, upcoming first then newest first), upcoming, next, last,
// record [w, d, l] from A's side, goals [for, against], pens { won, lost } (shoot-outs inside the record),
// unreported, undated, played } or { error: 'same-team' }
export function headToHead(index, A, B, { today, stats = null } = {}) {
  const sa = new Set(A), sb = new Set(B);
  if ([...sa].some(d => sb.has(d))) return { error: 'same-team' };
  const ia = idsOf(A), ib = idsOf(B), seasons = h2hSeasons(index, A, B), tday = dayOf(today);
  const found = [];
  for (const s of seasons.loaded) {
    // A game is visited once per id of A it holds, and found once: its two ids never both belong to A (an id is in one squad a
    // season, and a side's two squads are never the same), so no game can come up twice
    const G = index.games.get(s), xa = ia.get(s), xb = ib.get(s);
    for (const t of xa) for (const i of G.byTeam.get(t) || []) {
      if (stats) stats.gamesVisited = (stats.gamesVisited || 0) + 1;
      const h = G.h[i], a = G.a[i];
      if (xa.has(h) && xb.has(a)) found.push({ G, i, aHome: true });
      else if (xa.has(a) && xb.has(h)) found.push({ G, i, aHome: false });
    }
  }
  const up = [], done = [], undated = [];
  for (const m of found) { const { G, i } = m; if (G.day[i] === NO_DAY) undated.push(m); else if (G.hs[i] < 0 && G.day[i] >= tday) up.push(m); else done.push(m); }
  const k = m => m.G.ord[m.i];
  const ss = (x, y) => (x.G.season < y.G.season ? -1 : x.G.season > y.G.season ? 1 : 0);
  up.sort((x, y) => ss(x, y) || k(x) - k(y));            // the next meeting first
  done.sort((x, y) => -ss(x, y) || k(y) - k(x));         // newest first
  undated.sort((x, y) => -ss(x, y) || k(x) - k(y));
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, pw = 0, pl = 0, unreported = 0, last = null;
  for (const m of done) {
    const o = outcomeOf(m.G, m.i, m.aHome);
    if (!o) { unreported++; continue; }
    gf += o.x; ga += o.y;
    if (o.r > 0) { w++; if (o.pk) pw++; } else if (o.r < 0) { l++; if (o.pk) pl++; } else d++;
    if (!last) last = m;
  }
  const row = m => new GameRow(m.G, m.i, { cls: 'exact', reading: 0, filterWords: 0, aHome: m.aHome });
  return {
    seasons, complete: !seasons.need.length,
    meetings: [...up.slice().reverse(), ...done, ...undated].map(row),   // newest first: the farthest upcoming on top
    upcoming: up.map(row), next: up.length ? row(up[0]) : null, last: last ? row(last) : null,
    record: [w, d, l], goals: [gf, ga], pens: { won: pw, lost: pl }, unreported, undated: undated.length, played: w + d + l,
  };
}

// The Games section's lead row for a vs query with one squad a side (design: "leads with the head-to-head summary").
// Typing makes no request, so its summary covers the seasons loaded; `notLoaded` are the others both played, which
// opening the head to head loads (at most 6). a and b are the squads' first season rows (as judged).
export function h2hRow(index, da, db, ctx, base) {
  const s = headToHead(index, [da], [db], { today: ctx.today });
  const la = da.latest, lb = db.latest;
  const href = h2hHref({ season: la.season, teamID: la.teamID, name: la.name }, { season: lb.season, teamID: lb.teamID });
  return {
    section: 'games', kind: 'h2h', key: `${da.key}|${db.key}`,
    a: { season: da.rows[0].season, teamID: da.rows[0].teamID }, b: { season: db.rows[0].season, teamID: db.rows[0].teamID },
    aName: la.name, bName: lb.name, aClub: da.club.name, bClub: db.club.name, aCandidates: da.maybePrev.length, bCandidates: db.maybePrev.length,
    played: s.seasons.both, loaded: s.seasons.loaded, notLoaded: s.seasons.need, complete: s.complete,
    record: s.record, goals: s.goals, pens: s.pens, meetings: s.meetings.length, last: s.last, next: s.next,
    href, hrefs: [href], ...base,
  };
}

// The one place a game's head-to-head link is made, for game rows and pairing rows alike: both sides must be squads
// (different ones); an alias id (a showcase's own id) links by the squad's conference id that season. aSide: 'h' | 'a';
// withMatch adds &match=<matchID> (Q2: a game row's link opens the head to head on that meeting, marked)
export function gameH2HHref(G, i, aSide, sq, teamAt, withMatch = false) {
  const h = G.h[i], a = G.a[i];
  if (!sq) return null;
  const sh = sq.get(`${G.season}/${h}`), sa = sq.get(`${G.season}/${a}`);   // a side still to be decided has id 0: no squad
  if (!sh || !sa || sh === sa) return null;
  const own = (d, t) => (d.rows.find(r => r.season === G.season) || { teamID: t }).teamID;
  const [x, y] = aSide === 'a' ? [own(sa, a), own(sh, h)] : [own(sh, h), own(sa, a)];
  return h2hHref({ season: G.season, teamID: x, name: teamAt ? teamAt.get(`${G.season}/${x}`) : undefined }, { season: G.season, teamID: y }) + (withMatch ? `&match=${enc(G.id[i])}` : '');
}

// A side's candidate earlier teams, as the control lists them: never the other side's own squad; one the other side
// has added is listed disabled, with the reason, so one squad is never on both sides.
// -> [{ doc, chosen, disabled: null | 'other-side' }]
export function candidateList(side, other, chosen, otherChosen) {
  return side.candidates.filter(c => c !== other.doc).map(c => ({ doc: c, chosen: chosen.includes(c), disabled: otherChosen.includes(c) ? 'other-side' : null }));
}
