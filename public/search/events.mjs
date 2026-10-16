// #163 (#149 phase 1, PR 3): the Events category. One document per catalog event (a conference
// season, a national event or a showcase) from core.json's events, its tier names from the squads'
// event entries (#163 Q8), and its place from places.json. A conference season's age-group tables
// are rows inside it. Pure; "today" comes from the context's clock and time zone.
import { Postings, nameWords, words, expand, filterScore, worseClass, CLASS_RANK } from './match.mjs';
import { placeWords } from './vocab.mjs';
import { conferenceHref, nationalHref, showcaseHref } from './links.mjs';

export const EVENT_FIELDS = [{ name: 'name', w: 1.0 }, { name: 'event name', w: 0.8 }, { name: 'location', w: 0.5 }, { name: 'tier', w: 0.3 }];
export const W_CONF = 0.5, W_PLACE = 0.8, W_FILTER = 0.3;
const LOCATION_FIELD = 2;  // EVENT_FIELDS[2], the event's city and state text
const cmpStr = (a, b) => { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };

// Each field holds only the words no higher field holds: "ECNL Girls Norcal 2022-23" adds nothing to
// the name NorCal, so every NorCal season scores the same and the selected season comes first
// (one contribution per word, as plan v2 MF3 sets for older team names).
function distinctFields(lists) {
  const seen = new Set();
  return lists.map(l => { const f = [...new Set(l.filter(w => !seen.has(w)))]; for (const w of f) seen.add(w); return f; });
}

export function eventDocs(core, vocab) {
  const t = core.teams;
  const tiers = new Map();
  for (const sq of t.squads) for (const [, e, tier] of sq.e || []) {
    const id = String(t.events[e][3]);
    if (!tiers.has(id)) tiers.set(id, new Set());
    tiers.get(id).add(t.tiers[tier]);
  }
  const ids = Object.keys(core.events).sort((a, b) => +a - +b);
  const docs = ids.map((id, i) => {
    const [season, kind, name, eventName, location, start, end, ages] = core.events[id];
    const at = location.lastIndexOf(', ');
    const state = at > 0 ? location.slice(at + 2) : null;
    const tierNames = [...(tiers.get(id) || [])].sort();
    const loc = vocab.eventPlaces[id] || null;
    const u = div => ((vocab.divs.get(season) || []).find(x => x.name === div) || {}).u || 0;
    return {
      i, id: +id, season, kind, name, eventName, location, start, end, ages: [...ages].sort((a, b) => u(b) - u(a) || cmpStr(a, b)), ageU: u,
      state, tierNames, placeGeo: loc ? loc[0] : null, countyGeo: loc ? loc[1] : null, stageWords: new Set(words(name)),
      fields: distinctFields([nameWords(name), nameWords(eventName),
        at > 0 ? [...placeWords(location.slice(0, at)), ...words((core.vocab.states || {})[state] || '')] : [],
        tierNames.flatMap(nameWords)]),
    };
  });
  const post = new Postings(EVENT_FIELDS, docs);
  const kinds = new Map(); for (const d of docs) kinds.set(d.kind, (kinds.get(d.kind) || 0) + 1);
  return { docs, post, N: docs.length, kinds };
}

function placeHit(d, places) {
  let best = null;
  for (const p of places) {
    let hit = null;
    const named = !p.initialism && p.words.every(w => d.fields.some(f => f.includes(w)));
    if (named) hit = { direct: true, named: true, p };
    else if (p.state && d.state === p.state) hit = { direct: true, p };
    else if (d.placeGeo && p.places.includes(d.placeGeo)) hit = { direct: true, p };
    else if (d.countyGeo && p.counties.includes(d.countyGeo)) hit = { direct: false, p };
    if (hit && (!best || (hit.direct && !best.direct))) best = hit;
  }
  return best;
}

// Days between two 'YYYY-MM-DD' dates (UTC arithmetic: no time zone applies).
const days = (a, b) => { const p = s => s.split('-').map(Number); const [y1, m1, d1] = p(a), [y2, m2, d2] = p(b); return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000); };
// How far an event is from today: 0 while it runs, else days to its nearer end; no dates: last.
function distance(d, today) {
  if (!d.start) return Infinity;
  const end = d.end || d.start;
  if (today >= d.start && today <= end) return 0;
  return Math.min(Math.abs(days(d.start, today)), Math.abs(days(end, today)));
}

// Today's date in the context's time zone, 'YYYY-MM-DD'. A formatter is costly to build, so one is
// kept per time zone (it holds no clock: the instant comes from ctx.now).
const FORMATS = new Map();
function todayIn(ctx) {
  let f = FORMATS.get(ctx.timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); FORMATS.set(ctx.timeZone, f); }
  return f.format(ctx.now);
}

// -> { rows, reasons: Set }
export function searchEvents(E, side, ctx, vocab, { partial = false, stats = null, known = null, cache = null } = {}) {
  const reasons = new Set();
  const best = new Map();
  side.events.forEach((r, ri) => {
    if (r.unknownSeason && !(r.seasons && r.seasons.length)) { reasons.add('season-not-in-archive'); return; }
    const ageSeasons = r.seasons || [ctx.selectedSeason];
    if (r.u && !ageSeasons.some(s => (vocab.divs.get(s) || []).some(x => x.u === r.u))) { reasons.add('no-such-age-group'); return; }
    if (partial && r.names.length < 2) return;
    const exps0 = r.names.map(n => expand(n.w, { terms: E.post.terms, initials: null, known, last: n.last, stats, cache }));
    // a partial match never rests on a prefix shorter than 3 letters ("Great P", "qwerty a"): that is
    // noise, not a near miss (#163)
    const exps = partial ? exps0.map((e, k) => (r.names[k].w.length >= 3 ? e : new Map([...e].filter(([, v]) => v.cls !== 'prefix')))) : exps0;
    let placePass = 0;
    if (r.places) for (const d of E.docs) if (placeHit(d, r.places)) placePass++;
    for (const d of E.docs) {
      if (stats) stats.docsScored++;
      // filters: season, kind, conference
      if (r.seasons && !r.seasons.includes(d.season)) continue;
      if (r.conf && !(d.kind === 'c' && d.name === r.conf)) continue;
      // an age group with no season names the selected season's tables (as today)
      if (d.kind === 'c' && r.u && !r.seasons && d.season !== ctx.selectedSeason) continue;
      let kindOk = true;
      for (const k of r.kinds) {
        if (k === 'showcase') kindOk = kindOk && d.kind === 's';
        else if (k === 'standings') kindOk = kindOk && d.kind === 'c';
        else kindOk = kindOk && d.kind === 'n' && d.stageWords.has(k);     // playoffs, finals: in the stage's own name
      }
      if (!kindOk) continue;
      const ws = exps.map((e, k) => E.post.wordScore(d.i, e, r.names[k].place ? LOCATION_FIELD : -1));
      const matched = ws.filter(Boolean).length;
      if (partial ? !(matched > 0 && matched < ws.length) : matched !== ws.length) continue;
      const ph = r.places ? placeHit(d, r.places) : null;
      if (r.places && !ph) continue;
      if (!r.codes.every(c => d.state === c || d.fields.some(f => f.includes(c.toLowerCase())))) continue;
      let score = ws.reduce((s, w) => s + (w ? w.s : 0), 0);
      const why = ws.filter(Boolean).map(w => `${w.field}: ${w.term}${w.cls === 'exact' ? '' : ` (${w.cls})`}`);
      if (ph) {
        let ns = 0;
        if (ph.named) for (const w of ph.p.words) { const s = E.post.wordScore(d.i, new Map([[w, { cls: 'exact', m: 1 }]])); if (s) ns += s.s; }
        score += Math.max(filterScore(W_PLACE, placePass, E.N), ns);
        why.push(`place: ${ph.p.label}${ph.direct ? '' : ' (nearby)'}`);
      }
      if (r.conf) { score += filterScore(W_CONF, E.kinds.get('c') || 0, E.N); why.push(`conference: ${r.conf}`); }
      for (const k of r.kinds) { score += filterScore(W_FILTER, E.kinds.get(k === 'showcase' ? 's' : k === 'standings' ? 'c' : 'n') || 0, E.N); why.push(`kind: ${k}`); }
      const cls = ws.filter(Boolean).reduce((c, w) => worseClass(c, w.cls), 'exact');
      const bestCls = ws.filter(Boolean).reduce((c, w) => (CLASS_RANK[w.cls] < CLASS_RANK[c] ? w.cls : c), 'typo');
      const rarity = Math.min(...ws.filter(Boolean).map(w => E.post.df(w.term) / E.N));
      const base = { d, score, cls, reading: ri, filterWords: r.filterWords, nearby: ph ? !ph.direct : false, why, partialKey: partial ? { matched, cls: bestCls, rarity } : null };
      // a conference season with an age group: its tables in that age group; otherwise the event
      const divs = d.kind === 'c' && r.u ? d.ages.filter(a => d.ageU(a) === r.u) : [null];
      if (d.kind === 'c' && r.u && !divs.length) continue;
      for (const div of divs) {
        const k = `${d.id}/${div || ''}`;
        const h = { ...base, div };
        const o = best.get(k);
        const keep = !o || (h.nearby !== o.nearby ? !h.nearby : h.score !== o.score ? h.score > o.score : h.reading < o.reading) ? h : o;
        keep.filterWords = Math.max(h.filterWords, o ? o.filterWords : 0);   // the most specific reading it matched (#163 Q2)
        best.set(k, keep);
      }
    }
  });
  const today = todayIn(ctx);
  const out = [...best.values()];
  if (stats) stats.rowsSorted += out.length;
  for (const h of out) h.dist = distance(h.d, today);
  // Events order (design): direct before nearby; score; the selected season first; then the event
  // nearest today; within a conference season, age groups oldest first.
  out.sort((a, b) => {
    if (partial) {
      const p = a.partialKey, q = b.partialKey;
      if (p.matched !== q.matched) return q.matched - p.matched;
      if (p.cls !== q.cls) return CLASS_RANK[p.cls] - CLASS_RANK[q.cls];
      if (p.rarity !== q.rarity) return p.rarity - q.rarity;
    }
    if (a.nearby !== b.nearby) return a.nearby ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    const sa = a.d.season === ctx.selectedSeason, sb = b.d.season === ctx.selectedSeason;
    if (sa !== sb) return sa ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.d.id !== b.d.id) return cmpStr(a.d.name, b.d.name) || a.d.id - b.d.id;
    return (a.div ? a.d.ageU(b.div) - a.d.ageU(a.div) : 0) || cmpStr(a.div || '', b.div || '');
  });
  return { rows: out.map(h => rowOf(h, partial)), reasons };
}

function rowOf(h, partial) {
  const { d, div } = h;
  let row;
  if (d.kind === 'c') {
    const age = div || d.ages[0];
    row = { section: 'events', kind: 'conference', season: d.season, conf: d.name, div: div || '', eventID: d.id, title: d.eventName, name: d.name,
      hrefs: age ? [conferenceHref(d.season, age, d.name)] : [], ages: d.ages };
  } else if (d.kind === 'n') row = { section: 'events', kind: 'event', season: d.season, eventID: d.id, title: d.name, name: d.name, hrefs: [nationalHref(d.season, d.name)] };
  else row = { section: 'events', kind: 'event', season: d.season, eventID: d.id, title: d.name, name: d.name, hrefs: [showcaseHref(d.season, d.id)] };
  Object.assign(row, { href: row.hrefs[0] || null, location: d.location, start: d.start, end: d.end, cls: h.cls, reading: h.reading,
    filterWords: h.filterWords, nearby: h.nearby, score: h.score, why: h.why.join('; ') });
  if (partial) { row.partial = true; row.partialKey = h.partialKey; }
  return row;
}
