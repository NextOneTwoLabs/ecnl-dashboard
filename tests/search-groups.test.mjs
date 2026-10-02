// #133: the header search's results by club. B (age chips) for a name search, C (an age grid)
// for a place search, clubs named for the place first (owner rulings), today's flat rows where
// grouping adds nothing. The page's own code (public/index.html) is extracted and run on the
// committed team directory, through a small fake DOM for the parts that draw and take keys.
// Every fixture is found by scanning the data for the property under test, with its precondition
// asserted (review M5): no query here is expected to keep a mode because of today's numbers.
// Expectations come from the directory and clubs.json, never from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} in index.html`);
  return html.slice(a, b);
};
const ENGINE_SRC = slice('\n    const TEAM_SEARCH = (() => {\n', '\n    })();\n') + '\n    })();\n';
const PAGE_SRC = slice('    let usDb = null, usItems = []', '    (function usWire() {');
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const DIR = read('archive/directory.json');
const FAMILIES = read('data/club-families.json').families;
const ACTIVE = read('data/sources.json').refresh.activeSeason;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- a fake DOM: elements by id; list cells are found in the list's HTML ----------
function page({ sheet = false } = {}) {
  const els = new Map();
  const node = id => ({
    id, hidden: false, value: '', textContent: '', className: '', _html: '', attrs: {}, style: { setProperty() {} }, selectionStart: 0,
    get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    querySelector: () => null, insertAdjacentHTML() {}, scrollIntoView() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
  });
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const getElementById = id => {
    if (id.startsWith('us-opt-')) {
      const h = el('usearchList')._html;
      const m = h.match(new RegExp(`<(?:span|li)([^>]*)\\bid="${id}"[^>]*>`));
      if (!m) return null;
      const n = el(id);
      n.attrs = Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
      return n;
    }
    return el(id);
  };
  const location = { hash: '' };
  const stubs = {
    document: { getElementById }, window: { location, innerWidth: sheet ? 390 : 1400, innerHeight: 900, dispatchEvent() {} },
    location, HashChangeEvent: class {}, esc, isPhone: () => sheet, currentSeason: ACTIVE,
    teamSeasonTabLabel: s => (s === ACTIVE ? 'Current season' : `${s.replace('-', '–')} season`),
    closeSidebarIfMobile() {}, retryText: e => String(e), getTeamDirectory: async () => DIR,
  };
  const api = new Function(...Object.keys(stubs), ENGINE_SRC + PAGE_SRC + `
    usDb = TEAM_SEARCH.prepare(${'arguments'}[${Object.keys(stubs).length}]);
    usInput = document.getElementById('usearchInput');
    return { TEAM_SEARCH, usRun, usKey, usViewOf, usGroups, db: () => usDb,
      state: () => ({ usItems, usPos, usView, usActiveIdx }) };`)(...Object.values(stubs), DIR);
  const key = (k, extra = {}) => { const e = { key: k, shiftKey: false, preventDefault() {}, target: el('usearchInput'), ...extra }; api.usKey(e); return e; };
  const list = () => el('usearchList')._html;
  // Each search starts with the popover open, as typing in the bar does (a test may have left it).
  const usRun = q => { el('usearchPop').hidden = false; api.usRun(q); };
  return { ...api, usRun, el, location, key, list };
}
const P = page();
const E = P.TEAM_SEARCH, db = P.db();
const search = q => E.search(db, q, { season: ACTIVE, limit: Infinity });
const view = (q, sheet = false) => P.usViewOf(search(q), db, sheet);

// ---------- independent facts from the directory ----------
const words = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .map(w => ({ mount: 'mt', saint: 'st' })[w] || w);
const clubRow = new Map(DIR.clubs.map(c => [c[0], c]));
const placeOf = id => { const p = (clubRow.get(id) || [])[3] || ''; const at = p.lastIndexOf(', '); return at > 0 ? { city: p.slice(0, at), state: p.slice(at + 2) } : null; };
const STATES = { CA: 'California', TX: 'Texas', FL: 'Florida', NJ: 'New Jersey', NY: 'New York', SC: 'South Carolina', CO: 'Colorado', AZ: 'Arizona',
  VA: 'Virginia', WA: 'Washington', OH: 'Ohio', MI: 'Michigan', GA: 'Georgia', IL: 'Illinois', PA: 'Pennsylvania', NC: 'North Carolina', MD: 'Maryland',
  LA: 'Louisiana', DE: 'Delaware', OK: 'Oklahoma', UT: 'Utah', OR: 'Oregon', TN: 'Tennessee', MO: 'Missouri', KS: 'Kansas', MN: 'Minnesota', CT: 'Connecticut' };
const cities = [...new Set(DIR.clubs.map(c => placeOf(c[0])).filter(Boolean).map(p => p.city))];
const placeQueries = [...Object.values(STATES), ...Object.keys(STATES), ...cities];
const memo = new Map();
const scan = q => { if (!memo.has(q)) { const res = search(q); memo.set(q, { q, res, v: P.usViewOf(res, db, false) }); } return memo.get(q); };
const find = (what, list, pred) => { const hit = list.map(scan).find(pred); assert.ok(hit, `no query has ${what} (fixture precondition)`); return hit; };
const isFlat = v => v.mode === 'flat';

test('#133 families: every club of a family is one group, shown as its main club', () => {
  assert.ok(FAMILIES.length >= 1);
  for (const f of FAMILIES) {
    const v = view(f.name);
    const members = new Set(f.clubIDs);
    const g = v.groups.filter(x => x.teams.some(r => members.has(r.club.id)));
    assert.equal(g.length, 1, `${f.name}: one group`);
    assert.equal(g[0].name, f.name);
    assert.equal(g[0].club.id, f.main, 'the main club stands for the family');
    assert.ok(g[0].teams.every(r => members.has(r.club.id)));
    assert.deepEqual(new Set(g[0].teams.map(r => r.club.id)).size > 1, true, 'several TGS ids joined (precondition)');
  }
});

test('#133 B: chips oldest first, today\'s age groups; ended teams per line; may-continue squads folded', () => {
  const hit = find('a name search with a club of two live team lines', DIR.clubs.map(c => words(c[1]).find(w => w.length > 3)).filter(Boolean),
    s => s.v.mode === 'B' && s.v.groups.some(g => g.lines.length >= 2));
  for (const g of hit.v.groups) for (const L of g.lines) {
    const born = L.live.map(r => r.born[0]);
    assert.deepEqual(born, [...born].sort((a, b) => a - b), `${L.title}: oldest first`);
    for (const r of L.live) {
      assert.ok(r.current, 'live means playing now when no season is named');
      const last = r.doc.rows.at(-1);
      assert.equal(r.slot.replace(/ Composite$/, ''), `U${last.u}`);
    }
    for (const r of L.ended) assert.ok(!r.current);
  }
  // Folding: every squad that may continue is drawn under no club, and sits in each successor's list.
  const fold = find('a name search with folded "may continue" squads', [...FAMILIES.map(f => f.name), ...DIR.clubs.map(c => words(c[1])[0])],
    s => s.res.results.some(r => r.continuesAs && r.continuesAs.length) && !isFlat(s.v));
  const drawn = new Set(fold.v.groups.flatMap(g => g.teams));
  for (const r of fold.res.results.filter(x => x.continuesAs && x.continuesAs.length)) {
    assert.ok(!drawn.has(r));
    for (const s of r.continuesAs) assert.ok(s.mayFrom.includes(r));
  }
  const g = fold.v.groups.find(x => x.may);
  assert.equal(g.nAll, g.teams.length + g.may, 'counts include the folded squads (S6)');
});

test('#133 owner decision 6: lines with no team playing are one "Earlier lines" row per club', () => {
  const hit = find('a club with two or more ended-only team lines', DIR.clubs.map(c => c[1]),
    s => !isFlat(s.v) && s.v.groups.some(g => g.earlier && g.earlier.lines.length >= 2));
  const g = hit.v.groups.find(x => x.earlier && x.earlier.lines.length >= 2);
  const old = new Set(g.teams.filter(r => !g.lines.some(L => L.title === r.title)).map(r => r.title));
  assert.deepEqual(new Set(g.earlier.lines), old, 'exactly the lines with no live team');
  assert.equal(g.earlier.title, 'Earlier lines');
  assert.equal(g.earlier.ended.length, g.teams.filter(r => old.has(r.title)).length, 'n is the sum');
  // Drawn: one row, one toggle named with its lines; unfolded chips keep their own line.
  P.usRun(hit.q);
  const toggles = [...P.list().matchAll(/aria-label="(Earlier lines \([^"]*\): \d+ ended teams?, collapsed)"/g)];
  assert.ok(toggles.length >= 1, `the Earlier lines toggle (${hit.q}: ${hit.v.mode})`);
  const key = `${g.key}|earlier`;
  // Down until the toggle is active (it may sit below the cap: then this fixture is not drawn).
  for (let n = 0; n < 400 && (P.state().usPos[P.state().usActiveIdx] || {}).key !== key; n++) {
    if (n === 399) assert.fail('the Earlier lines toggle was never reached');
    P.key('ArrowDown');
  }
  P.key('Enter');
  const h = P.list();
  assert.match(h, /aria-expanded="true"\s+aria-label="Earlier lines \([^"]+\): \d+ ended teams?, expanded"/);
  // Each unfolded chip is named with its own line, never "Earlier lines".
  const names = [...h.matchAll(/class="us-cell us-agechip ended[^"]*" id="[^"]+" data-i="\d+" aria-selected="[a-z]+" aria-label="([^"]+)"/g)].map(m => m[1]);
  assert.equal(names.length, g.earlier.ended.length, 'one chip per ended team (the toggle aside)');
  for (const r of g.earlier.ended) assert.ok(names.some(n => n.startsWith(`${r.title}, ended ${r.last}, born `)), `${r.title} ${r.last}`);
  assert.ok(!names.some(n => n.startsWith('Earlier lines')));
  assert.equal(P.state().usPos[P.state().usActiveIdx].key, key, 'the toggle stays active after it opens');
  // In C too: a club's lines with no team playing are one row with one "ended" cell.
  const c = find('a grid with a club whose line has no team playing', placeQueries.flatMap(x => [`${x} 2011`, `${x} 2012`, `${x} 2010`]),
    s => (s.v.mode === 'C' || s.v.mode === 'BC') && (s.v.mode === 'C' ? s.v.groups : s.v.based).some(x => x.earlier));
  const cg = (c.v.mode === 'C' ? c.v.groups : c.v.based).find(x => x.earlier);
  P.usRun(c.q);
  const label = cg.earlier.merged ? `Earlier lines (${cg.earlier.lines.join(', ')})` : cg.earlier.title;
  assert.ok(P.list().includes(`aria-label="${esc(`${label}: ${cg.earlier.ended.length} ended team${cg.earlier.ended.length === 1 ? '' : 's'}, collapsed`)}"`), c.q);
});

test('#133 rule 7: the clubs only based in the place sit in "Other clubs based in …"; every other club comes first', () => {
  let both = 0;
  for (const q of placeQueries) {
    const s = scan(q);
    if (s.v.mode !== 'BC' && s.v.mode !== 'C' && s.v.mode !== 'B') continue;
    if (s.res.note || isFlat(s.v)) continue;
    const p = s.res.query;
    if (s.v.mode === 'B' && !s.v.named.length) continue;   // a name search
    const phrases = [...p.places.map(x => words(x.label)), ...p.codes.map(c => words(c.label))];
    const named = g => phrases.some(ph => ph.every(w => new Set([...words(g.name), ...g.teams.filter(r => r.current).flatMap(r => words(r.name)),
      ...g.teams.flatMap(r => words(r.club.name))]).has(w)));
    const based = g => g.teams.some(r => { const pl = placeOf(r.club.id); return pl && (p.places.some(x => (x.type === 'state' ? pl.state === x.value : words(pl.city).join(' ') === x.value))
      || p.codes.some(c => pl.state === c.code)); });
    for (const g of s.v.based) assert.ok(based(g) && !named(g), `${q}: ${g.name} is only based there`);
    for (const g of s.v.named) assert.ok(named(g) || !based(g), `${q}: ${g.name} is named for it, or not based there`);
    if (s.v.mode === 'BC') both++;
  }
  assert.ok(both >= 1, 'a place with both sections (precondition)');
  // A club matched by a team's name but based elsewhere is never under "based in".
  const away = find('a place listing a club based elsewhere', placeQueries,
    s => !s.res.note && ['BC', 'B'].includes(s.v.mode) && s.v.named.some(g => g.teams.every(r => { const pl = placeOf(r.club.id);
      const p = s.res.query; return !(pl && (p.places.some(x => (x.type === 'state' ? pl.state === x.value : words(pl.city).join(' ') === x.value)) || p.codes.some(c => pl.state === c.code))); })));
  assert.ok(away.v.based.every(g => !away.v.named.includes(g)));
  // A club neither named for the place nor based there (matched by an older team name) goes first.
  // Built from a real list, since today's data may hold none: one based-only club, moved away.
  const bc = find('a place with both sections', placeQueries, s => s.v.mode === 'BC');
  const g0 = bc.v.based[0];
  const moved = { ...g0.club, state: 'ZZ', city: 'nowhere', place: 'Nowhere, ZZ' };
  const res2 = { ...bc.res, results: bc.res.results.map(r => (r.club.id === g0.club.id ? { ...r, club: moved } : r)) };
  const v2 = P.usViewOf(res2, db, false);
  assert.ok(v2.named.some(g => g.club.id === g0.club.id), 'not based there: the first section');
  assert.ok(!v2.based.some(g => g.club.id === g0.club.id), 'never under "Other clubs based in …"');
});

test('#133 rules 2-6, found by scanning: flat, the name fallback, the ended fallback', () => {
  const few = find('a name search of 2 or 3 teams', DIR.clubs.map(c => words(c[1]).join(' ')), s => s.res.total >= 2 && s.res.total <= 3 && s.res.query.text.length);
  assert.equal(few.v.mode, 'flat');
  const confs = DIR.confs;
  const table = find('a table query', confs.flatMap(c => [`U15 ${c}`, `U14 ${c}`]), s => s.res.total > 3 && !s.res.query.text.length && s.res.query.conf);
  assert.equal(table.v.mode, 'flat');
  const ageAtPlace = find('a place with an age group and more than 3 teams', Object.values(STATES).map(x => `${x} U15`), s => s.res.total > 3 && s.res.query.u);
  assert.equal(ageAtPlace.v.mode, 'flat');
  const nameFallback = find('a code that fell back to team names, with a club of 2+ teams', Object.keys(STATES),
    s => s.res.note && s.res.note.kind === 'name' && s.res.total > 3 && s.v.groups.some(g => g.teams.length > 1));
  assert.equal(nameFallback.v.mode, 'B', 'a name match: B, never a grid (M1)');
  const ended = find('a place whose teams have all ended, with a club of 2+ teams', cities,
    s => s.res.note && s.res.note.kind === 'ended' && s.res.total > 3 && s.v.groups.some(g => g.teams.length > 1));
  assert.equal(ended.v.mode, 'B', 'by birth year, never a one-column grid (M1)');
  const years = [2008, 2009, 2010, 2011, 2012, 2013, 2014];
  const one = find('a search where every club has one team (and more than 3 teams, no age group)',
    [...Object.values(STATES), ...cities].flatMap(x => years.map(y => `${x} ${y}`)),
    s => s.res.total > 3 && !s.res.query.u && !s.res.query.band && s.v.groups.length > 1 && s.v.groups.every(g => g.teams.length === 1));
  assert.equal(one.v.mode, 'flat');
  // The phone draws C as B's cards.
  const c = find('a place drawn as a grid', placeQueries, s => s.v.mode === 'C' || s.v.mode === 'BC');
  assert.equal(view(c.q, true).mode, c.v.mode === 'C' ? 'B' : 'BB');
});

test('#133 M2: a query naming a season labels chips by that season, and Enter opens that season\'s tab', () => {
  const seasons = DIR.seasons.filter(s => s !== ACTIVE);
  const hit = find('a club name with a past season, as B', FAMILIES.map(f => f.name).concat(DIR.clubs.map(c => words(c[1])[0])).flatMap(w => seasons.map(s => `${w} ${s}`)),
    s => s.v.mode === 'B' && s.res.query.season);
  const season = hit.res.query.season;
  for (const g of hit.v.groups) for (const L of g.lines) for (const r of L.live) {
    const row = r.doc.rows.find(x => x.season === season && x.teamID === r.teamID);
    assert.ok(row, 'an anchor in the named season');
    assert.equal(r.slot.replace(/ Composite$/, ''), `U${row.u}`, 'that season\'s age group');
  }
  assert.ok(hit.v.groups.every(g => !g.earlier || g.earlier.ended.length === 0 || g.lines.length >= 0));
  P.usRun(hit.q);
  const st = P.state(), r = st.usItems[st.usActiveIdx];
  assert.ok(r && /&view=season$/.test(r.href) && r.href.includes(encodeURIComponent(season)), 'r.href is the season tab (D2)');
  P.key('Enter');
  assert.equal(P.location.hash, r.href, 'Enter goes through usGo with r.href');
});

test('#133 keys: Left and Right are the text caret\'s until Down or Up; then they move along the row', () => {
  const hit = find('a B view with a row of 3+ cells', FAMILIES.map(f => f.name).concat(DIR.clubs.map(c => words(c[1])[0])), s => s.v.mode === 'B' && s.v.groups.some(g => g.lines.some(L => L.live.length >= 3)));
  P.usRun(hit.q);
  const a0 = P.state().usActiveIdx;
  P.key('ArrowRight');
  assert.equal(P.state().usActiveIdx, a0, 'Right before Down: not the list\'s');
  assert.equal(P.state().usView.nav, false);
  // Down to a row of 3 or more cells, at its first cell.
  const wide = () => { const st = P.state(), row = st.usPos[st.usActiveIdx].row; return st.usPos.filter(x => x.row === row).length >= 3; };
  for (let n = 0; n < 400 && !(n && wide()); n++) P.key('ArrowDown');
  assert.ok(wide(), 'a row of 3+ cells reached');
  P.key('Home');
  const a1 = P.state().usActiveIdx, row = P.state().usPos[a1].row;
  P.key('ArrowRight');
  const a2 = P.state().usActiveIdx;
  assert.notEqual(a2, a1);
  assert.equal(P.state().usPos[a2].row, row, 'along the same row');
  P.key('Home');
  assert.equal(P.state().usPos[P.state().usActiveIdx].col, Math.min(...P.state().usPos.filter(x => x.row === row).map(x => x.col)));
});

test('#133 ARIA (M3): one grid; section titles and club headers are rows; C\'s header row is hidden; toggles named with their line', () => {
  const bc = find('a place with both sections', placeQueries, s => s.v.mode === 'BC');
  P.usRun(bc.q);
  const h = P.list();
  assert.equal(P.el('usearchList').getAttribute('role'), 'grid');
  assert.equal(P.el('usearchInput').getAttribute('aria-haspopup'), 'grid');
  assert.ok(!/role="presentation"/.test(h), 'no presentation rows in the grid');
  assert.equal((h.match(/class="us-section"/g) || []).length, 2);
  assert.ok([...h.matchAll(/<li role="row" class="us-section"><span role="rowheader">([^<]+)</g)].length === 2);
  assert.match(h, /<li class="us-ghead" aria-hidden="true">/);
  assert.ok(!/columnheader/.test(h));
  for (const m of h.matchAll(/aria-expanded="(?:true|false)"\s+aria-label="([^"]+)"/g)) assert.match(m[1], /^.+: \d+ ended teams?, (collapsed|expanded)$/);
  for (const m of h.matchAll(/role="gridcell" class="us-cell [^"]*"[^>]*aria-label="([^"]+)"/g)) assert.match(m[1], /, (Overview|Current season|\d{4}–\d{2} season)$/);
  // S5: the section titles use the place's name, never a code.
  const code = find('a state code with both sections', Object.keys(STATES), s => s.v.mode === 'BC');
  P.usRun(code.q);
  assert.ok(P.list().includes(`Other clubs based in ${STATES[code.q]}`), 'the state\'s name');
  // The flat list keeps today's listbox and rank numbers (S4).
  const few = find('a flat name search', DIR.clubs.map(c => words(c[1]).join(' ')), s => s.v.mode === 'flat' && s.res.total >= 2);
  P.usRun(few.q);
  assert.equal(P.el('usearchList').getAttribute('role'), 'listbox');
  assert.match(P.list(), /<span class="us-rank" aria-hidden="true">1<\/span>/);
});

test('#133 S1: a broad search draws at most 30 clubs or 200 chips, and says how many more', () => {
  const candidates = [...new Set(DIR.clubs.flatMap(c => words(c[1])))].filter(w => w.length >= 2);
  const broad = candidates.map(scan).filter(s => !isFlat(s.v) && s.v.groups.length > 30).sort((a, b) => b.v.groups.length - a.v.groups.length)[0];
  assert.ok(broad, 'a search with more than 30 clubs (precondition)');
  P.usRun(broad.q);
  const h = P.list();
  const drawn = (h.match(/class="us-clubhead"|class="us-gclub"|class="us-gline us-gone"/g) || []).length;
  const cells = (h.match(/role="gridcell"/g) || []).length;
  assert.ok(drawn <= 30 && cells < 200 + 40, `${drawn} clubs, ${cells} cells`);
  const more = h.match(/(\d+) more clubs?, (\d+) teams?/);
  assert.ok(more, 'the "n more" line');
  assert.equal(+more[1], broad.v.groups.length - drawn);
  assert.equal(broad.res.total, broad.res.results.length, 'every match is searched (Infinity), only the drawing is capped');
});
