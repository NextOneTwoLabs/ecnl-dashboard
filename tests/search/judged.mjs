// #149 phase 1, PR 1 (#156): the judged query set's runner. A library, not a test file: the CI
// test is tests/search-judged.test.mjs, and tests/search/freeze.mjs re-freezes and records.
//
// Pieces, in order: text and checksums (always over LF text, so a CRLF checkout hashes the same),
// fixtures and their index, the query-file schema, ref resolution, the frozen clock, the adapters
// (today's search, and a clock canary), the per-query checks and measures, the baseline, and the
// season-bound facts compared with the live archive.
//
// Nothing here reads the network, the machine clock or the machine time zone on behalf of an
// engine: engines get an injected, frozen Date and Intl (makeClock).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as SEARCH from '../../public/search/search.mjs';

export const HERE = new URL('./', import.meta.url);
export const ROOT = new URL('../../', import.meta.url);
export const FIXTURES = new URL('fixtures/', HERE);

// ---------- text and checksums ----------
export const lf = s => String(s).replace(/\r\n/g, '\n');
export const sha = s => createHash('sha256').update(lf(s), 'utf8').digest('hex');
export const readLF = url => lf(readFileSync(url, 'utf8'));
export const readJSON = url => JSON.parse(readLF(url));
// Stable JSON: object keys sorted, two-space indent, LF, trailing newline.
export function stable(v) {
  const norm = x => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])])) : x;
  return JSON.stringify(norm(v), null, 2) + '\n';
}

// ---------- constants ----------
export const GROUPS = ['team-names', 'typos', 'events', 'collisions', 'not-ignored', 'cities', 'fields', 'games-h2h', 'nothing'];
export const SECTIONS = ['teams', 'events', 'games'];
export const SECTION_CAP = { teams: 8, events: 6, games: 6 };   // the doc's first-show sizes
export const KIND_SECTION = { team: 'teams', club: 'teams', conference: 'events', event: 'events', game: 'games', field: 'games', h2h: 'games', pairing: 'games', empty: null };
export const EMPTY_REASONS = ['no-match', 'no-full-match', 'season-not-in-archive', 'no-such-age-group'];
const MODIFIERS = ['current', 'within', 'partial', 'nearby', 'duplicate'];
const LABELS = ['partial', 'nearby'];
export const refKind = ref => Object.keys(ref).find(k => k in KIND_SECTION);

// ---------- fixtures ----------
export function loadFixtures(dir = FIXTURES) {
  return {
    manifest: readJSON(new URL('MANIFEST.json', dir)),
    directory: readJSON(new URL('directory.json', dir)),
    sources: readJSON(new URL('sources.json', dir)),
    judged: readJSON(new URL('games-judged.json', dir)),
  };
}
export const FIXTURE_FILES = ['directory.json', 'sources.json', 'games-judged.json'];
// Logos and images (#117, MF8): no fixture may hold one.
export const IMAGE = /PlayerForm|PlayerImage|ClubImages|images\.totalglobalsports|\.(png|jpe?g|gif|webp|svg)\b/i;

// The directory and catalog, indexed for refs and links.
export function indexOf(directory, sources) {
  const S = directory.seasons, active = S[S.length - 1];
  const clubs = new Map(directory.clubs.map(c => [c[0], { id: c[0], name: c[1], place: c[3] || '' }]));
  const squads = directory.squads.map((sq, i) => {
    const rows = sq.s.map(r => ({ season: S[r[0]], teamID: r[1], name: r[2], conf: r[3] == null ? null : directory.confs[r[3]], div: directory.divs[r[4]][1] }));
    return { i, club: directory.clubs[sq.c][0], born: sq.b, rows, key: `${rows[0].season}/${rows[0].teamID}`, current: rows[rows.length - 1].season === active };
  });
  const rowAt = new Map();
  for (const sq of squads) for (const r of sq.rows) {
    const k = `${r.season}/${r.teamID}`;
    if (!rowAt.has(k)) rowAt.set(k, []);
    rowAt.get(k).push({ sq, r });
  }
  return { S, active, clubs, squads, rowAt, sources };
}

// ---------- fields (D6): a field is a normalised name plus zip, with aliases ----------
export const fieldName = (name, aliases) => {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return aliases[n] || null;
};
export const fieldNumber = venue => { const m = /field\s*#?\s*0*(\d+)/i.exec(String(venue || '')); return m ? +m[1] : null; };
export const fieldKey = (name, zip) => `${name}@${zip}`;

// ---------- the clock: a frozen Date and an Intl that defaults to the context's time zone ----------
export function makeClock({ now, timeZone }) {
  const Real = Date, NOW = Real.parse(now);
  if (!Number.isFinite(NOW)) throw new Error(`context.now is not a date: ${now}`);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
  const parts = t => Object.fromEntries(fmt.formatToParts(new Real(t)).map(p => [p.type, p.value]));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  class FrozenDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
    getFullYear() { return +parts(this.getTime()).year; }
    getMonth() { return +parts(this.getTime()).month - 1; }
    getDate() { return +parts(this.getTime()).day; }
    getDay() { return DAYS.indexOf(parts(this.getTime()).weekday); }
    getHours() { return +parts(this.getTime()).hour; }
    getMinutes() { return +parts(this.getTime()).minute; }
    getSeconds() { return +parts(this.getTime()).second; }
    getTimezoneOffset() {
      const t = this.getTime() - (((this.getTime() % 1000) + 1000) % 1000), p = parts(t);
      return Math.round((t - Real.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)) / 60000);
    }
    toLocaleString(l, o = {}) { return super.toLocaleString(l, { timeZone, ...o }); }
    toLocaleDateString(l, o = {}) { return super.toLocaleDateString(l, { timeZone, ...o }); }
    toLocaleTimeString(l, o = {}) { return super.toLocaleTimeString(l, { timeZone, ...o }); }
    toString() { return `${this.toLocaleString('en-US')} (${timeZone})`; }
  }
  const FrozenIntl = Object.create(Intl);
  FrozenIntl.DateTimeFormat = function DateTimeFormat(l, o = {}) { return new Intl.DateTimeFormat(l, { timeZone, ...o }); };
  return { Date: FrozenDate, Intl: FrozenIntl };
}

// The clock stubs every engine gets: one builder, shared by today's adapter and the canary, so the
// canary's test guards the path today's search runs on.
export function clockStubs(context) { const c = makeClock(context); return { Date: c.Date, Intl: c.Intl }; }

// Compile engine source with named stubs in scope (the clock among them). `tail` returns the API.
export function compile(src, stubs, tail, extra = []) {
  const names = Object.keys(stubs);
  return new Function(...names, src + '\n' + tail)(...Object.values(stubs), ...extra);
}

// ---------- the frozen copy of today's search (D9) ----------
// Vendored from index.html by #156; since #172 (PR 5) the page no longer holds it, so the copy is frozen: it is no
// longer compared with index.html (MANIFEST.retired), only with MANIFEST.engineSha.
const V_ENGINE = '//@@ENGINE\n', V_PAGE = '\n//@@PAGE\n';
export function vendoredSlices(text) {
  text = lf(text);
  const a = text.indexOf(V_ENGINE), b = text.indexOf(V_PAGE);
  if (a < 0 || b < a) throw new Error('engines/today.js: vendored markers missing');
  return { engine: text.slice(a + V_ENGINE.length, b), page: text.slice(b + V_PAGE.length) };
}
export const engineSha = s => sha(s.engine + s.page);

// ---------- the query file: schema ----------
export function checkSchema(doc, ix) {
  const errs = [], err = (id, m) => errs.push(`${id}: ${m}`);
  if (doc.schema !== 1) err('file', 'schema must be 1');
  if (JSON.stringify(doc.groups) !== JSON.stringify(GROUPS)) err('file', 'groups must be the nine groups, in order');
  for (const k of ['now', 'timeZone', 'selectedSeason']) if (!doc.context || !doc.context[k]) err('file', `context.${k} missing`);
  const ids = new Set();
  const qs = doc.queries || [];
  if (qs.length < 55 || qs.length > 70) err('file', `${qs.length} queries; 55 to 70 expected`);
  for (const g of GROUPS) { const n = qs.filter(q => q.group === g).length; if (n < 4) err('file', `group ${g} has ${n} queries; at least 4`); }
  const decisions = new Set(Object.keys(doc.decisions || {}));
  const ALLOWED = ['id', 'group', 'q', 'stability', 'sections', 'mustShow', 'mustNever', 'top', 'exact', 'order', 'useful', 'cites', 'decision', 'note', 'place'];
  for (const q of qs) {
    const id = q.id || '?';
    if (!/^[A-Z]\d{2}$/.test(id)) err(id, 'id must look like T01');
    if (ids.has(id)) err(id, 'duplicate id'); ids.add(id);
    for (const k of Object.keys(q)) if (!ALLOWED.includes(k)) err(id, `unknown field ${k}`);
    if (!GROUPS.includes(q.group)) err(id, `unknown group ${q.group}`);
    if (typeof q.q !== 'string' || !q.q.trim()) err(id, 'q missing');
    if (!['frozen', 'closed', 'live'].includes(q.stability)) err(id, `stability ${q.stability}`);
    if (!Array.isArray(q.sections) || q.sections.some(s => !SECTIONS.includes(s)) || new Set(q.sections).size !== q.sections.length) err(id, 'sections must be distinct names of teams, events, games');
    if (!Array.isArray(q.useful) || !q.useful.length) err(id, 'useful must be a non-empty list');
    if (q.exact && !q.top) err(id, 'exact needs top');
    if (q.stability === 'live' && (q.exact || q.top || q.order)) err(id, 'a live query may carry only sections, mustShow and mustNever (MF10)');
    for (const d of q.decision || []) if (!decisions.has(d)) err(id, `unknown decision ${d}`);
    for (const [where, ref] of refsOf(q)) {
      const kind = refKind(ref);
      if (!kind) { err(id, `${where}: unknown ref ${JSON.stringify(ref)}`); continue; }
      for (const k of Object.keys(ref)) if (k !== kind && k !== 'note' && !MODIFIERS.includes(k)) err(id, `${where}: unknown modifier ${k}`);
      if (ref.duplicate && where !== 'mustNever') err(id, 'duplicate is a mustNever modifier');
      if (ref.current && kind !== 'club') err(id, 'current applies to a club ref');
      if (where === 'cites' && kind !== 'game') err(id, 'cites holds game refs');
      if (kind === 'conference' && !ref.conference.season && where !== 'mustNever') err(id, `${where}: a conference ref needs a season outside mustNever`);
      if (q.stability === 'closed') for (const s of seasonsOfRef(ref)) if (s === ix.active) err(id, `${where}: a closed query names the active season ${s}`);
    }
    if (q.top) for (const [s, refs] of Object.entries(q.top)) {
      if (!SECTIONS.includes(s)) err(id, `top.${s}`);
      for (const r of refs) if (KIND_SECTION[refKind(r)] !== s) err(id, `top.${s} holds a ${refKind(r)} ref`);
    }
    // D11: a birth year never forbids a squad whose 2026-27 two-year division also covers that year.
    // "2011", "G2011" and "2011G" (nit 6)
    const years = (q.q.match(/\b(?:g)?(20\d{2})(?:g)?\b/gi) || []).map(y => +y.replace(/\D/g, '')).filter(y => y >= 2002 && y <= 2014);
    for (const y of years) for (const ref of q.mustNever || []) {
      for (const sq of squadsOfRef(ref, ix)) {
        const row = sq.rows.find(r => r.season === ix.active);
        const ag = row && ((ix.sources.seasons[ix.active] || {}).ageGroups || {})[row.div];
        if (ag && (ag.birthYears || []).includes(y)) err(id, `mustNever ${sq.key} shares the ${ix.active} division ${row.div} with ${y} (D11)`);
      }
    }
  }
  return errs;
}
export function* refsOf(q) {
  for (const k of ['mustShow', 'mustNever', 'useful', 'cites']) for (const r of q[k] || []) yield [k, r];
  for (const refs of Object.values(q.top || {})) for (const r of refs) yield ['top', r];
  for (const o of q.order || []) for (const r of [...(o.before || []), ...(o.after || [])]) yield ['order', r];
}
export function seasonsOfRef(ref) {
  const k = refKind(ref), v = ref[k];
  if (k === 'team' || k === 'event') return [v.season];
  if (k === 'conference' || k === 'pairing') return v.season ? [v.season] : [];
  if (k === 'h2h') return [v.a.season, v.b.season];
  return [];
}
export function squadsOfRef(ref, ix) {
  const k = refKind(ref), v = ref[k];
  if (k === 'team') return (ix.rowAt.get(`${v.season}/${v.teamID}`) || []).map(h => h.sq);
  if (k === 'club') return ix.squads.filter(sq => sq.club === v.clubID && (!v.born || sq.born.includes(v.born)) && (!ref.current || sq.current));
  return [];
}

// ---------- refs: do they resolve in the fixtures? ----------
export function resolveProblems(doc, fx) {
  const ix = indexOf(fx.directory, fx.sources), out = [];
  const games = new Map(fx.judged.games.map(g => [g.matchID, g]));
  const fields = new Map(fx.judged.fields.map(f => [fieldKey(f.name, f.zip), f]));
  const aliases = doc.vocabulary.fieldAliases;
  for (const q of doc.queries) for (const [where, ref] of refsOf(q)) {
    const p = resolveRef(ref, { ix, games, fields, aliases });
    if (p) out.push(`${q.id} ${where} ${JSON.stringify(ref)}: ${p}`);
  }
  // county judgements (D2): a nearby club is based in the query place's county, not in the city itself
  for (const q of doc.queries) for (const ref of q.mustShow || []) if (ref.nearby && ref.club) {
    const c = ix.clubs.get(ref.club.clubID), city = (c.place || '').replace(/, [A-Z]{2}$/, '');
    const county = q.place && doc.vocabulary.counties[q.place.county];
    if (!county) out.push(`${q.id}: a nearby ref needs place.county`);
    else if (!county.includes(city) || city === q.place.city) out.push(`${q.id}: club ${c.id} (${city}) is not elsewhere in ${q.place.county}`);
  }
  return out;
}
function resolveRef(ref, { ix, games, fields, aliases }) {
  const k = refKind(ref), v = ref[k], sources = ix.sources;
  switch (k) {
    case 'team': return ix.rowAt.has(`${v.season}/${v.teamID}`) ? null : 'no such team in that season';
    case 'club': {
      if (!ix.clubs.has(v.clubID)) return 'no such club';
      return squadsOfRef(ref, ix).length ? null : 'no squad of this club matches';
    }
    case 'conference': {
      const seasons = v.season ? [v.season] : Object.keys(sources.seasons);
      const ok = seasons.some(s => {
        const e = sources.seasons[s];
        if (!e || !(e.conferences || {})[v.conf]) return false;
        if (!v.div) return true;
        return (e.ageGroups || {})[v.div] && ix.squads.some(sq => sq.rows.some(r => r.season === s && r.conf === v.conf && r.div === v.div));
      });
      return ok ? null : 'no such conference (season, division)';
    }
    case 'event': return eventOf(sources, v.season, v.eventID) ? null : 'no such event in that season';
    case 'game': return games.has(v) ? null : 'game not in games-judged.json';
    case 'field': {
      const f = fields.get(fieldKey(v.name, v.zip));
      if (!f) return 'field not in games-judged.json';
      if (!Object.values(aliases).includes(v.name)) return 'field name is not a vocabulary name';
      if (v.number != null && !(f.numbers || {})[v.number]) return `field has no number ${v.number}`;
      return null;
    }
    case 'h2h': for (const s of [v.a, v.b]) if (!ix.rowAt.has(`${s.season}/${s.teamID}`)) return 'a side is not a team';
      return null;
    case 'pairing': {
      if (!Array.isArray(v.sides) || v.sides.length !== 2) return 'pairing needs two sides';
      for (const side of v.sides) for (const c of side) if (!ix.clubs.has(c)) return `no club ${c}`;
      const [A, B] = v.sides.map(s => new Set(s));
      const met = [...games.values()].some(g => ((A.has(g.home.clubID) && B.has(g.away.clubID)) || (B.has(g.home.clubID) && A.has(g.away.clubID)))
        && (!v.season || g.season === v.season) && (!v.div || g.division === v.div));
      return met ? null : 'no cited game between the sides';
    }
    case 'empty': return EMPTY_REASONS.includes(v.reason) ? null : 'unknown empty reason';
  }
  return 'unknown kind';
}
export function eventOf(sources, season, eventID) {
  const e = sources.seasons[season];
  if (!e) return null;
  for (const [type, list] of [['national', e.national], ['showcases', e.showcases]])
    for (const [name, ev] of Object.entries(list || {})) if (ev.eventId === eventID) return { type, name, location: ev.location || null };
  return null;
}

// ---------- adapters ----------
// An adapter: { name, capabilities: { sections, kinds, labels }, run(q) -> outcome }.
// outcome: { sections: [{ name, rows: [row] }], enter: row | null, capReached: bool | null }.
// row: { section, kind, ...facts, hrefs: [], partial?, nearby? }.
export function todayAdapter(fx, context) {
  const vendored = vendoredSlices(readLF(new URL('engines/today.js', HERE)));
  const els = new Map();
  const node = id => ({
    id, hidden: false, value: '', textContent: '', className: '', _html: '', attrs: {}, style: { setProperty() {} }, selectionStart: 0, on: {},
    addEventListener(k, f) { this.on[k] = f; },
    get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    querySelector: () => null, insertAdjacentHTML() {}, scrollIntoView() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
  });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const location = { hash: '' };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stubs = {
    document: { getElementById: el, addEventListener() {} },
    window: { location, innerWidth: 1400, innerHeight: 900, dispatchEvent() {}, addEventListener() {}, open() {} },
    location, HashChangeEvent: class {}, esc, isPhone: () => false, currentSeason: context.selectedSeason, SOURCES: fx.sources,
    teamSeasonTabLabel: s => s, closeSidebarIfMobile() {}, retryText: e => String(e), getTeamDirectory: async () => fx.directory,
    NO_CLUB: 7, ...clockStubs(context),
  };
  const n = Object.keys(stubs).length;
  const api = compile(vendored.engine + vendored.page, stubs, `
    usDb = TEAM_SEARCH.prepare(arguments[${n}]);
    usInput = document.getElementById('usearchInput');
    return { usRun, items: () => usItems };`, [fx.directory]);
  return {
    name: 'today',
    capabilities: { sections: ['teams', 'events'], kinds: ['team', 'club', 'conference', 'event'], labels: [] },
    run(q) {
      el('usearchPop').hidden = false;
      api.usRun(q);
      const sections = [];
      for (const it of api.items()) {
        if (!it) continue;   // an "ended" toggle in the grouped view
        const row = todayRow(it);
        let s = sections.find(x => x.name === row.section);
        if (!s) sections.push(s = { name: row.section, rows: [] });
        s.rows.push(row);
      }
      return { sections, enter: sections.length ? sections[0].rows[0] : null, capReached: null };
    },
  };
}

// One of today's usItems as an outcome row. Fails loudly on a kind it does not know (nit 2).
export function todayRow(r) {
  if (r && r.kind === 'competition') {
    const [type, season, ...rest] = String(r.key).split('/');
    if (type === 'conference') { const [conf, ...div] = rest; return { section: 'events', kind: 'conference', season, conf, div: div.join('/'), hrefs: [r.href] }; }
    if (type === 'playoffs' || type === 'showcases') return { section: 'events', kind: 'event', season, eventID: +rest[0], hrefs: [r.href] };
    throw new Error(`today adapter: unknown competition key ${r.key}`);
  }
  if (r && r.kind === undefined && r.doc && r.club) {
    return { section: 'teams', kind: 'team', teamRows: r.doc.rows.map(x => `${x.season}/${x.teamID}`), clubID: r.club.id, born: r.born,
      current: !!r.current, hrefs: [...new Set([r.href, r.overviewHref, r.seasonHref].filter(Boolean))] };
  }
  throw new Error(`today adapter: unknown result kind ${r && r.kind}`);
}

// ---------- the search modules (#163, PR 3): public/search/*.mjs on the frozen search data ----------
export const MODULES = new URL('public/search/', ROOT);
export const moduleFiles = () => readdirSync(MODULES).filter(n => n.endsWith('.mjs')).sort();
// One checksum over every module, by name and LF text: the modules baseline's header holds it.
export const modulesSha = () => sha(moduleFiles().map(n => `${n}\n${readLF(new URL(n, MODULES))}`).join('\n'));
export function loadSearchData(dir = new URL('search/', FIXTURES)) {
  return { core: readJSON(new URL('core.json', dir)), places: readJSON(new URL('places.json', dir)) };
}
// A season's frozen games file (#168), read once per process.
const GAMES_FILES = new Map();
export function loadGames(season, dir = new URL('search/', FIXTURES)) {
  const k = `${dir.href}|${season}`;
  if (!GAMES_FILES.has(k)) GAMES_FILES.set(k, readJSON(new URL(`games-${season}.json`, dir)));
  return GAMES_FILES.get(k);
}
// #168 build point 3: the modules need context.today; here it is derived from now and the time zone (the page
// passes its own todayKey), so the TZ variants still prove that nothing reads the machine's zone.
export const todayOf = (now, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const modulesContext = context => ({ now: Date.parse(context.now), timeZone: context.timeZone, selectedSeason: context.selectedSeason, today: todayOf(Date.parse(context.now), context.timeZone) });
// The modules as an adapter (#168: games, fields and pairings are judged; head to head stays `unsupported`
// until PR 6). MF2: every query starts from the page's own state: the active season's games, plus the
// seasons the query itself names (an explicit season or a bare year: `not-loaded`, which the page fetches by
// itself), loaded and searched again as the page does. Seasons loaded only on request (`on-request`, the Load
// cells) are never loaded here.
export function modulesAdapter(context, { searchData = loadSearchData(), options = {}, gamesDir = new URL('search/', FIXTURES) } = {}) {
  const index = SEARCH.buildIndex(searchData);
  const ctx = modulesContext(context);
  const built = new Map();   // season -> its games index, built once (on a scratch index) and shared
  const games = s => {
    if (!built.has(s)) { const tmp = SEARCH.buildIndex(searchData); const g = SEARCH.startGames(tmp, loadGames(s, gamesDir), Infinity); let r; while (!(r = g.next()).done); built.set(s, r.value); }
    return built.get(s);
  };
  const prep = SEARCH.startGames(index, loadGames(index.vocab.active, gamesDir), Infinity); while (!prep.next().done);   // the index's one-time lookups
  const reset = () => { index.games = new Map([[index.vocab.active, games(index.vocab.active)]]); };
  return {
    name: 'modules', index,
    capabilities: { sections: ['teams', 'events', 'games'], kinds: ['team', 'club', 'conference', 'event', 'game', 'field', 'pairing', 'h2h'], labels: ['partial', 'nearby'] },
    run(q) {
      reset();
      let slate = SEARCH.search(index, q, ctx, options);
      const need = slate.coverage.filter(c => c.state === 'not-loaded').map(c => c.season);
      if (need.length) { for (const s of need) index.games.set(s, games(s)); slate = SEARCH.search(index, q, ctx, options); }
      const sections = slate.sections.map(s => ({ name: s.name, rows: s.rows.map(modulesRow) }));
      const enter = slate.enter ? modulesRow(slate.enter) : null;
      return { sections, enter, capReached: !!slate.capReached, slate, loaded: need };
    },
  };
}
// One slate row as an outcome row. Fails loudly on a kind it does not know (the twin of nit 2).
export function modulesRow(r) {
  const labels = { ...(r.partial ? { partial: true } : {}), ...(r.nearby ? { nearby: true } : {}) };
  if (r && r.kind === 'team') return { section: 'teams', kind: 'team', teamRows: r.teamRows, clubID: r.clubID, born: r.born, current: !!r.current, hrefs: r.hrefs, ...labels };
  if (r && r.kind === 'conference') return { section: 'events', kind: 'conference', season: r.season, conf: r.conf, div: r.div, hrefs: r.hrefs, ...labels };
  if (r && r.kind === 'event') return { section: 'events', kind: 'event', season: r.season, eventID: r.eventID, hrefs: r.hrefs, ...labels };
  if (r && r.kind === 'game') return { section: 'games', kind: 'game', matchID: r.matchID, season: r.season, hrefs: r.hrefs, ...labels };
  if (r && r.kind === 'field') return { section: 'games', kind: 'field', field: { name: r.field.name, zip: r.field.zip, number: r.field.number }, hrefs: [], ...labels };
  if (r && r.kind === 'pairing') return { section: 'games', kind: 'pairing', sides: r.sides, season: r.season, div: r.div, hrefs: [], ...labels };
  if (r && r.kind === 'h2h') return { section: 'games', kind: 'h2h', a: r.a, b: r.b, hrefs: r.hrefs, ...labels };
  if (r && r.kind === 'load') return { section: 'games', kind: 'load', hrefs: [], ...labels };
  throw new Error(`modules adapter: unknown row kind ${r && r.kind}`);
}
export function modulesBaselineOf(doc, adapter, fx, run = runAll(doc, adapter, fx)) {
  return {
    header: {
      engine: 'modules', modulesSha: modulesSha(), manifestSha: manifestSha(fx.manifest), queriesSha: sha(stable(doc)), context: doc.context,
      recordedBy: 'node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --record modules',
    },
    summary: run.summary,
    perQuery: Object.fromEntries(Object.entries(run.perQuery).map(([id, r]) => [id, r])),
  };
}

// Each marker of the removed legacy search, checked on its own: one coming back alone (a partial restore) fails
// the retirement. Line endings never count (the text is compared as LF).
export const LEGACY_MARKERS = [
  { name: 'const TEAM_SEARCH', re: /const TEAM_SEARCH = \(\(\) =>/ },
  { name: 'let usDb', re: /let usDb\b/ },
  { name: 'the "#165: the legacy search above is dormant" comment', re: /the legacy search above is dormant until PR 5/ },
  { name: 'a function us* declaration', re: /function us[A-Z]\w*\(/ },
];
export const legacyMarkers = html => LEGACY_MARKERS.filter(m => m.re.test(lf(html))).map(m => m.name);

// The retirement check on the frozen copy (MF7): MANIFEST.retired must be { pr, reason } (non-empty strings),
// index.html must hold none of the legacy markers, and the frozen copy must still match MANIFEST.engineSha.
// Never skipped silently: an unset or malformed retirement fails.
export function driftStatus(html, vendored, manifest) {
  const r = manifest.retired;
  if (r == null) return { ok: false, message: 'MANIFEST.retired is not set: index.html no longer holds the legacy search (#172); set retired { pr, reason }' };
  if (typeof r !== 'object' || Array.isArray(r) || typeof r.pr !== 'string' || !r.pr || typeof r.reason !== 'string' || !r.reason) return { ok: false, message: 'MANIFEST.retired must be { pr, reason }' };
  const back = legacyMarkers(html);
  if (back.length) return { ok: false, message: `MANIFEST.retired is set, but index.html still holds the legacy search (${back.join('; ')}): remove it, or unset retired and re-vendor from an older commit` };
  if (engineSha(vendoredSlices(vendored)) !== manifest.engineSha) return { ok: false, message: 'engines/today.js does not match MANIFEST.engineSha: the frozen copy was edited' };
  return { ok: true, retired: true, message: `retired by ${r.pr}: ${r.reason}` };
}

// The clock canary (MF6): engine source that reads the clock and the time zone. It runs through the
// same compile() and the same stubs as today's search, so it proves the injection, which today's
// search (it never reads the clock) cannot.
export const CANARY_SOURCE = `function canary() {
  const d = new Date();
  return { iso: d.toISOString(), now: Date.now(), y: d.getFullYear(), m: d.getMonth(), day: d.getDate(), wd: d.getDay(),
    h: d.getHours(), min: d.getMinutes(), offset: d.getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    local: d.toLocaleString('en-US') };
}`;
export function canaryRun(context, { frozen = true } = {}) {
  const stubs = frozen ? clockStubs(context) : { Date, Intl };
  return compile(CANARY_SOURCE, stubs, 'return canary();');
}

// ---------- matching rows against refs ----------
const sameSides = (a, b) => {
  const k = s => [...new Set(s)].sort((x, y) => x - y).join(',');
  const A = a.map(k).sort(), B = b.map(k).sort();
  return A[0] === B[0] && A[1] === B[1];
};
export function matches(ref, row, ctx) {
  const k = refKind(ref), v = ref[k];
  if (ref.partial && !row.partial) return false;
  if (ref.nearby && !row.nearby) return false;
  switch (k) {
    case 'team': return row.kind === 'team' && row.teamRows.includes(`${v.season}/${v.teamID}`);
    case 'club': return row.kind === 'team' && row.clubID === v.clubID && (!v.born || (row.born || []).includes(v.born)) && (!ref.current || row.current);
    case 'conference': return row.kind === 'conference' && (!v.season || row.season === v.season) && row.conf === v.conf && (!v.div || row.div === v.div);
    case 'event': return row.kind === 'event' && row.season === v.season && row.eventID === v.eventID;
    case 'game': return row.kind === 'game' && row.matchID === v;
    case 'field': return row.kind === 'field' && row.field && row.field.name === v.name && row.field.zip === v.zip && (v.number == null || row.field.number === v.number);
    case 'h2h': {
      if (row.kind !== 'h2h') return false;
      const s = x => `${x.season}/${x.teamID}`, r = [s(row.a), s(row.b)].sort(), w = [s(v.a), s(v.b)].sort();
      return r[0] === w[0] && r[1] === w[1];
    }
    case 'pairing': return row.kind === 'pairing' && sameSides(row.sides, v.sides) && (!v.season || row.season === v.season) && (!v.div || row.div === v.div);
    case 'empty': return false;
  }
  return false;
}
export function supported(ref, caps) {
  const k = refKind(ref);
  if (k === 'empty') return true;
  if (!caps.sections.includes(KIND_SECTION[k]) || !caps.kinds.includes(k)) return false;
  return LABELS.every(l => !ref[l] || caps.labels.includes(l));
}

// ---------- one query's checks ----------
const fold = statuses => statuses.includes('fail') ? 'fail' : statuses.includes('unsupported') ? 'unsupported' : 'pass';
export const refText = ref => {
  const k = refKind(ref), v = ref[k];
  const mods = MODIFIERS.filter(m => ref[m] != null && ref[m] !== false).map(m => (ref[m] === true ? m : `${m}=${ref[m]}`));
  const body = k === 'team' ? `${v.season}/${v.teamID}` : k === 'club' ? `${v.clubID}${v.born ? ' born ' + v.born : ''}`
    : k === 'conference' ? [v.season || '*', v.conf, v.div].filter(Boolean).join('/') : k === 'event' ? `${v.season}/${v.eventID}`
      : k === 'game' ? String(v) : k === 'field' ? `${v.name}@${v.zip}${v.number != null ? '#' + v.number : ''}`
        : k === 'h2h' ? `${v.a.season}/${v.a.teamID} v ${v.b.season}/${v.b.teamID}` : k === 'pairing' ? `${v.sides.map(s => s.join('+')).join(' v ')}${v.season ? ' ' + v.season : ''}${v.div ? ' ' + v.div : ''}`
          : v.reason;
  return `${k}:${body}${mods.length ? ' [' + mods.join(',') + ']' : ''}`;
};
export const rowText = row => row.kind === 'team' ? `team:${row.teamRows[0]}` : row.kind === 'conference' ? `conference:${row.season}/${row.conf}/${row.div}`
  : row.kind === 'event' ? `event:${row.season}/${row.eventID}` : row.kind === 'game' ? `game:${row.matchID}`
    : row.kind === 'field' ? `field:${row.field.name}@${row.field.zip}` : `${row.kind}`;

export function evaluate(q, outcome, adapter, fx, ix = indexOf(fx.directory, fx.sources)) {
  const caps = adapter.capabilities;
  const sec = name => (outcome.sections.find(s => s.name === name) || { rows: [] }).rows;
  const allRows = outcome.sections.flatMap(s => s.rows);
  const checks = {}, misses = [], hits = [];
  // mustShow: a club ref without `within` asks for every squad it names; any other ref for one row
  // (within the first N rows of its section when `within` is set).
  const show = (q.mustShow || []).map(ref => {
    if (!supported(ref, caps)) return 'unsupported';
    const rows = sec(KIND_SECTION[refKind(ref)]);
    let ok;
    if (ref.within) ok = rows.slice(0, ref.within).some(r => matches(ref, r, ix));
    else if (refKind(ref) === 'club') {
      const want = squadsOfRef(ref, ix);
      const missing = want.filter(sq => !rows.some(r => r.kind === 'team' && r.teamRows.includes(sq.key) && matches(ref, r, ix)));
      ok = !missing.length;
      if (!ok) misses.push(`${refText(ref)}: ${missing.length} of ${want.length} squads missing`);
      return ok ? 'pass' : 'fail';
    } else ok = rows.some(r => matches(ref, r, ix));
    if (!ok) misses.push(refText(ref));
    return ok ? 'pass' : 'fail';
  });
  checks.mustShow = q.mustShow ? fold(show) : null;
  const never = (q.mustNever || []).map(ref => {
    if (!supported(ref, caps)) return 'unsupported';
    const n = allRows.filter(r => matches(ref, r, ix)).length;
    const bad = ref.duplicate ? n > 1 : n > 0;
    if (bad) hits.push(`${refText(ref)} (${n} row${n === 1 ? '' : 's'})`);
    return bad ? 'fail' : 'pass';
  });
  checks.mustNever = q.mustNever ? fold(never) : null;
  // section order: the non-empty sections, ignoring those that hold only partial rows
  const actual = outcome.sections.filter(s => s.rows.some(r => !r.partial)).map(s => s.name);
  const expected = q.sections;
  let order;
  if (JSON.stringify(actual) === JSON.stringify(expected)) order = 'pass';
  else if (expected.every(s => caps.sections.includes(s))) order = 'fail';
  else order = JSON.stringify(expected.filter(s => caps.sections.includes(s))) === JSON.stringify(actual) ? 'unsupported' : 'fail';
  checks.sections = order;
  // relative order (judged on frozen or closed data only)
  checks.order = q.order ? fold(q.order.map(o => {
    const refs = [...o.before, ...o.after];
    if (!refs.every(r => supported(r, caps))) return 'unsupported';
    const rows = sec(KIND_SECTION[refKind(refs[0])]);
    const pos = list => rows.map((r, i) => (list.some(ref => matches(ref, r, ix)) ? i : -1)).filter(i => i >= 0);
    const b = pos(o.before), a = pos(o.after);
    const ok = !b.length || !a.length || Math.max(...b) < Math.min(...a);
    if (!ok) misses.push(`order: ${o.before.map(refText).join(', ')} before ${o.after.map(refText).join(', ')}`);
    return ok ? 'pass' : 'fail';
  })) : null;
  // first useful result
  const enter = outcome.enter;
  let firstUseful = 0, usefulStatus;
  const sup = q.useful.filter(r => supported(r, caps));
  if (sup.some(r => (refKind(r) === 'empty' ? allRows.length === 0 : enter && matches(r, enter, ix)))) { firstUseful = 1; usefulStatus = 'pass'; }
  else usefulStatus = sup.length ? 'fail' : 'unsupported';
  checks.useful = usefulStatus;
  // reciprocal rank within each judged section, cut at the first-show size
  const rr = {}, exact = {};
  for (const [s, refs] of Object.entries(q.top || {})) {
    if (!caps.sections.includes(s) || !refs.every(r => supported(r, caps))) { rr[s] = null; exact[s] = 'unsupported'; continue; }
    const rows = sec(s).slice(0, SECTION_CAP[s]);
    const i = rows.findIndex(r => refs.some(ref => matches(ref, r, ix)));
    rr[s] = i < 0 ? 0 : 1 / (i + 1);
    if (q.exact) exact[s] = refs.every((ref, j) => rows[j] && matches(ref, rows[j], ix)) ? 'pass' : 'fail';
  }
  checks.exact = q.exact ? fold(Object.values(exact)) : null;
  // wrong destination: every href a row emits resolves to a real page in the fixtures
  const wrong = [];
  for (const r of allRows) for (const h of r.hrefs || []) { const p = destinationProblem(h, ix); if (p) wrong.push(`${h}: ${p}`); }
  const statuses = Object.values(checks).filter(Boolean);
  return {
    status: fold(statuses), checks, firstUseful, rr, exact: q.exact ? exact : null,
    sections: { expected, actual }, enter: enter ? rowText(enter) : null,
    rows: Object.fromEntries(outcome.sections.map(s => [s.name, s.rows.slice(0, 6).map(rowText)])),
    counts: Object.fromEntries(outcome.sections.map(s => [s.name, s.rows.length])),
    mustShowMissing: misses, mustNeverHits: hits, wrongDestinations: [...new Set(wrong)], capReached: outcome.capReached,
  };
}

// ---------- wrong destination: does a link open the page it names? ----------
export function destinationProblem(href, ix) {
  if (!href || href[0] !== '#') return 'not a hash link';
  const p = new URLSearchParams(href.slice(1)), src = ix.sources, tab = p.get('tab');
  const season = p.get('season');
  if (!season || !src.seasons[season]) return `unknown season ${season}`;
  if (tab === 'teams') {
    const hits = ix.rowAt.get(`${season}/${p.get('team')}`);
    if (!hits) return 'team not in that season';
    if (p.has('name') && !hits.some(h => h.r.name === p.get('name'))) return 'name is not that team\'s name in that season';
    if (p.has('view') && p.get('view') !== 'season') return `unknown view ${p.get('view')}`;
    if (p.has('vs')) {   // #178: vs=<season>:<B>, a squad other than A's, and no view= beside it
      const m = /^(\d{4}-\d{2}):([1-9]\d*)$/.exec(p.get('vs'));
      if (!m) return `vs= is not <season>:<team>: ${p.get('vs')}`;
      if (p.has('view')) return 'vs= takes no view=';
      if (!src.seasons[m[1]]) return `unknown vs season ${m[1]}`;
      const b = ix.rowAt.get(`${m[1]}/${m[2]}`);
      if (!b) return 'vs team not in that season';
      if (b.some(x => hits.some(h => h.sq === x.sq))) return 'vs is the same squad';
    }
    return null;
  }
  if (tab === 'playoffs') {
    if (!Object.keys(src.seasons[season].national || {}).includes(p.get('stage'))) return `no stage ${p.get('stage')}`;
    return p.has('match') ? gameLinkProblem(p, season, src.seasons[season].national[p.get('stage')].eventId, 'tier') : null;
  }
  if (tab === 'showcases') {
    if (eventOf(src, season, +p.get('event'))?.type !== 'showcases') return `no showcase ${p.get('event')}`;
    return p.has('match') ? gameLinkProblem(p, season, +p.get('event'), 'flight') : null;
  }
  if (!tab && p.has('conf')) {
    const e = src.seasons[season], conf = p.get('conf'), age = p.get('age');
    if (!(e.conferences || {})[conf]) return `no conference ${conf}`;
    if (!(e.ageGroups || {})[age]) return `no age group ${age}`;
    if (!ix.squads.some(sq => sq.rows.some(r => r.season === season && r.conf === conf && r.div === age))) return 'no table for that age group';
    if (p.has('view') && !['standings', 'schedule'].includes(p.get('view'))) return `unknown view ${p.get('view')}`;
    if (p.has('team') && !ix.squads.some(sq => sq.rows.some(r => r.season === season && r.conf === conf && r.div === age && r.teamID === +p.get('team')))) return 'team not in that table';
    if (p.has('sched') && !['upcoming', 'results', 'all'].includes(p.get('sched'))) return `unknown filter ${p.get('sched')}`;
    return p.has('match') ? gameLinkProblem(p, season, e.conferences[conf].eventId, null) : null;
  }
  return 'unknown route';
}
// #168: a game link names its game (match=), the game is in that event and age group, in the tier or flight
// the link names, with the selected team as one side; the Matches view needs view=schedule and a played
// game sched=results (tests/search-game-links.test.mjs resolves every game against the real views).
function gameLinkProblem(p, season, eventID, flightKey) {
  let games;
  try { games = loadGames(season); } catch { return `no games file for ${season}`; }
  const id = +p.get('match');
  if (!/^-?\d+$/.test(p.get('match'))) return `match= is not a game id: ${p.get('match')}`;
  let prev = 0, row = null;
  for (const r of games.games) { prev += r[0]; if (prev === id) { row = r; break; } }
  if (!row) return `no game ${id} in ${season}`;
  const [eid, , div] = games.flights[row[2]] || [];
  if (eid !== eventID) return `game ${id} is not in event ${eventID}`;
  if (div !== p.get('age')) return `game ${id} is in ${div}, not ${p.get('age')}`;
  if (flightKey && +p.get(flightKey) !== row[2]) return `game ${id} is in flight ${row[2]}, not ${p.get(flightKey)}`;
  if (p.get('view') !== 'schedule' && !(flightKey === 'tier' && !p.has('view'))) return 'a game opens a schedule view (or the bracket)';
  if (p.has('team') && +p.get('team') !== row[3] && +p.get('team') !== row[4]) return `team ${p.get('team')} is not in game ${id}`;
  if (!flightKey && (row[5] != null && row[6] != null) !== (p.get('sched') === 'results')) return 'the filter hides the game';
  return null;
}

// ---------- the whole set ----------
export function runAll(doc, adapter, fx) {
  const ix = indexOf(fx.directory, fx.sources), perQuery = {};
  for (const q of doc.queries) perQuery[q.id] = evaluate(q, adapter.run(q.q), adapter, fx, ix);
  return { perQuery, summary: summarise(doc, perQuery) };
}
export function summarise(doc, perQuery) {
  const blank = () => ({ queries: 0, pass: 0, fail: 0, unsupported: 0, firstUseful: 0, sectionsAgree: 0, sectionsAgreeSupported: 0, sectionsSupported: 0,
    mrr: Object.fromEntries(SECTIONS.map(s => [s, { sum: 0, n: 0, judged: 0 }])), wrongDestinations: 0, mustNeverHits: 0, mustShowMissing: 0, capReached: null });
  const groups = Object.fromEntries(GROUPS.map(g => [g, blank()])), all = blank();
  for (const q of doc.queries) {
    const r = perQuery[q.id];
    for (const t of [groups[q.group], all]) {
      t.queries++; t[r.status]++; t.firstUseful += r.firstUseful;
      if (r.checks.sections === 'pass') t.sectionsAgree++;
      if (r.checks.sections !== 'unsupported') { t.sectionsSupported++; if (r.checks.sections === 'pass') t.sectionsAgreeSupported++; }
      for (const [s, v] of Object.entries(r.rr)) { t.mrr[s].judged++; if (v != null) { t.mrr[s].sum += v; t.mrr[s].n++; } }
      t.wrongDestinations += r.wrongDestinations.length; t.mustNeverHits += r.mustNeverHits.length; t.mustShowMissing += r.mustShowMissing.length;
      if (r.capReached != null) t.capReached = (t.capReached || 0) + (r.capReached ? 1 : 0);
    }
  }
  const round = x => Math.round(x * 10000) / 10000;
  const finish = t => ({
    ...t,
    firstUsefulRate: t.queries ? round(t.firstUseful / t.queries) : null,
    sectionsAgreeRate: t.queries ? round(t.sectionsAgree / t.queries) : null,
    sectionsAgreeRateSupported: t.sectionsSupported ? round(t.sectionsAgreeSupported / t.sectionsSupported) : null,
    // MRR over every judged (query, section): an unsupported section counts as 0 here...
    mrr: Object.fromEntries(Object.entries(t.mrr).map(([s, m]) => [s, { judged: m.judged, supported: m.n,
      all: m.judged ? round(m.sum / m.judged) : null,
      // ...and is left out here.
      supportedOnly: m.n ? round(m.sum / m.n) : null }])),
  });
  return { overall: finish(all), groups: Object.fromEntries(Object.entries(groups).map(([g, t]) => [g, finish(t)])) };
}

// ---------- the baseline ----------
// The fixtures' checksum for a baseline header. `retired` (#172) is not fixture content: setting it must not re-record
// the baselines, so it is left out (the value is the one recorded while retired was null).
export const manifestSha = m => sha(stable({ ...m, retired: null }));
export function baselineOf(doc, adapter, fx, run = runAll(doc, adapter, fx)) {
  return {
    header: {
      engine: adapter.name,
      engineSha: fx.manifest.engineSha,
      manifestSha: manifestSha(fx.manifest),
      queriesSha: sha(stable(doc)),
      context: doc.context,
      recordedBy: 'node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --record today',
    },
    summary: run.summary,
    perQuery: run.perQuery,
  };
}

// ---------- season-bound facts, compared with the live archive (MF5) ----------
// Only facts that a refresh cannot change: rows of closed seasons, closed-season events and
// games. Never squad grouping (#107 relinks) and never club metadata (names, places, logos).
export function seasonFacts(doc, data, closedSeasons) {
  const ix = indexOf(data.directory, data.sources), out = {};
  const closed = s => closedSeasons.includes(s);
  const team = (s, t) => (ix.rowAt.get(`${s}/${t}`) || []).map(h => `${h.r.name}|club ${h.sq.club}|${h.r.conf}|${h.r.div}`).sort();
  for (const q of doc.queries) for (const [, ref] of refsOf(q)) {
    const k = refKind(ref), v = ref[k];
    if (k === 'team' && closed(v.season)) out[`team:${v.season}/${v.teamID}`] = team(v.season, v.teamID);
    if (k === 'h2h') for (const s of [v.a, v.b]) if (closed(s.season)) out[`team:${s.season}/${s.teamID}`] = team(s.season, s.teamID);
    if (k === 'event' && closed(v.season)) out[`event:${v.season}/${v.eventID}`] = eventOf(data.sources, v.season, v.eventID);
    if (k === 'conference' && v.season && closed(v.season)) {
      const e = data.sources.seasons[v.season] || {};
      out[`conference:${v.season}/${v.conf}/${v.div || ''}`] = { conf: !!(e.conferences || {})[v.conf], div: v.div ? (e.ageGroups || {})[v.div] || null : null };
    }
    if (k === 'game') {
      const g = data.game(v);
      const f = data.fixtureGame(v);   // closed by construction: freeze refuses active-season games
      if (f && closed(f.season)) out[`game:${v}`] = g ? { season: g.season, date: g.date, home: g.home.teamID, away: g.away.teamID, complex: g.complex, zip: g.zip } : null;
    }
  }
  return out;
}
// A game as games-judged.json stores it, read from a schedule file of the archive.
export function trimGame(g, season, path) {
  const s = x => (x == null ? null : String(x).trim());
  return {
    matchID: g.matchID, season, eventID: g.eventID, flightID: g.flightID, path, division: g.division, type: g.type, date: g.gameDate,
    home: { teamID: g.hometeamID, clubID: g.homeTeamClubID, name: s(g.homeTeam) },
    away: { teamID: g.awayteamID, clubID: g.awayTeamClubID, name: s(g.awayTeam) },
    score: [g.hometeamscore ?? null, g.awayteamscore ?? null], pk: [g.hometeamPKscore ?? null, g.awayteamPKscore ?? null],
    complexID: g.complexID ?? null, complex: s(g.complex), venue: s(g.venue), zip: s(g.zip),
  };
}
export const SCHEDULES = new URL('public/archive/api/Event/get-schedules-by-flight/', ROOT);
export function liveGame(path, matchID, season) {
  const url = new URL(path, SCHEDULES);
  if (!existsSync(url)) return null;
  const g = (readJSON(url).data || []).find(x => x.matchID === matchID);
  return g ? trimGame(g, season, path) : null;
}
