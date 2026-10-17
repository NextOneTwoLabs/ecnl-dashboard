// #168 (PR 4b): match= in the views. A game link from search names its game (&match=<matchID>); the view
// that lists it scrolls to it, marks it and focuses it, once, for the load that carried it (MF8). The page's
// own code (public/index.html), extracted block by block as in tests/landing-route.test.mjs, against a fake
// DOM and the real catalog. What a browser adds (layout, real focus, Back) is tests/e2e/search-panel.e2e.mjs.
//   node --import ./tests/netguard/netguard.mjs --test tests/match-param.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CATALOG = JSON.parse(readFileSync(new URL('../public/data/sources.json', import.meta.url), 'utf8'));
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1, from = html.indexOf(last, start), end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const MATCH = html.slice(html.indexOf('    // ========== #168: match='), html.indexOf('    // ========== URL HASH'));
assert.ok(MATCH.length > 2000, 'the match= block');
const CODE = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    function getSeasonData()'),
  block('    function saveState('), block('    function pushHash('), block('    function loadFromHash('),
  block("    window.addEventListener('hashchange'", "window.addEventListener('hashchange'", '\n    });\n'),
  MATCH,
  block('    function matchRowHtml('), block('    function bracketMatchCard('),
].join('\n');

// ---------- a small DOM: enough for focusMatch (querySelector by data-match, closest, classes, rects) ----------
function el(tag, { cls = [], attrs = {}, rect = { top: 0, bottom: 20, left: 0, width: 100 }, kids = [] } = {}) {
  const n = { tagName: tag.toUpperCase(), attrs: { ...attrs }, kids: [], parent: null, rect, open: false, focused: null, scrollTop: 0, scrollLeft: 0, clientHeight: 400, clientWidth: 600, scrollWidth: 600, textContent: '' };
  const c = new Set(cls);
  n.classList = { add: x => c.add(x), remove: x => c.delete(x), contains: x => c.has(x) };
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); }; n.getAttribute = k => n.attrs[k] ?? null;
  n.getBoundingClientRect = () => ({ top: n.rect.top, bottom: n.rect.bottom, left: n.rect.left, width: n.rect.width });
  n.focus = o => { n.focused = o; FOCUS.push(n); };
  const all = () => { const out = []; const w = x => { for (const k of x.kids) { out.push(k); w(k); } }; w(n); return out; };
  const is = (x, sel) => (sel === 'details' ? x.tagName === 'DETAILS' : sel.startsWith('.') ? x.classList.contains(sel.slice(1)) : sel.startsWith('[data-match=') ? x.attrs['data-match'] === sel.slice(13, -2) : false);
  n.querySelector = sel => all().find(x => is(x, sel)) || null;
  n.closest = sel => { for (let x = n; x; x = x.parent) if (is(x, sel)) return x; return null; };
  n.insertAdjacentHTML = (where, h) => { n.inserted = (n.inserted || []).concat([[where, h]]); };
  Object.defineProperty(n, 'previousElementSibling', { get: () => { const s = n.parent ? n.parent.kids : []; return s[s.indexOf(n) - 1] || null; } });
  for (const k of kids) { k.parent = n; n.kids.push(k); }
  return n;
}
const FOCUS = [];

function page({ hash = '', container = null, games = [], render = null } = {}) {
  const T = { titleFocus: 0, loads: [], history: [] };
  const els = new Map();
  const box = id => { if (!els.has(id)) els.set(id, el('div', { attrs: { id } })); return els.get(id); };
  if (container) els.set('standingsContainer', container);
  const scroll = el('div', { attrs: { id: 'standingsScroll' }, rect: { top: 100, bottom: 500, left: 0, width: 600 } });
  els.set('standingsScroll', scroll);
  const listeners = {}, docListeners = [];
  const document = { getElementById: box, querySelectorAll: () => (container ? [container, ...(() => { const o = []; const w = x => { for (const k of x.kids) { o.push(k); w(k); } }; w(container); return o; })()].filter(x => x.classList.contains('is-match')) : []),
    addEventListener: (t, f, cap) => docListeners.push([t, f, cap]) };
  const location = { hash };
  const history = { replaceState: (s, t, url) => { T.history.push(url); location.hash = url.slice(url.indexOf('#')); } };
  const store = {};
  const stubs = {
    T, document, window: { location, addEventListener: (t, f) => { listeners[t] = f; } }, location, history,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    SEASONS: CATALOG.seasons,
    showLanding() {}, leaveLanding() {}, syncSeasonUI() {}, switchTab: t => T.loads.push('tab:' + t), rebuildAll: () => T.loads.push('rebuild'),
    focusContentTitle: () => { T.titleFocus++; },
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    displayName: n => String(n || '').replace(/ ECNL.*$/, ''), isPlayed: g => g.hometeamscore != null && g.awayteamscore != null,
    gameDateKey: g => (g.gameDate || '').slice(0, 10), formatMatchDate: k => `Day ${k}`, formatShortDate: d => String(d || '').slice(0, 10),
    renderConferenceView: () => { T.loads.push('render'); if (render) render(); },
  };
  const api = new Function(...Object.keys(stubs), CODE + `
    return { loadFromHash, pushHash, saveState, bindMatch, dropMatch, focusMatch, matchRowHtml, bracketMatchCard,
      get pending() { return pendingMatch; }, set pending(v) { pendingMatch = v; },
      setView: (v, f) => { currentView = v; scheduleFilter = f; }, filter: () => scheduleFilter };`)(...Object.values(stubs));
  return Object.assign(api, { T, store, location, listeners, docListeners, box, scroll, fire: () => listeners.hashchange() });
}

const S0 = Object.keys(CATALOG.seasons).at(-1);
const CONF = Object.keys(CATALOG.seasons[S0].conferences)[0];
const AGE = Object.keys(CATALOG.seasons[S0].ageGroups)[0];
const CONF_LINK = `#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}&view=schedule&team=1&match=1085880`;
const NAT = Object.entries(CATALOG.seasons).find(([, d]) => Object.keys(d.national || {}).length);
const SC = Object.entries(CATALOG.seasons).find(([, d]) => Object.keys(d.showcases || {}).length);

test('router: match= is read in the conference, playoffs and showcases branches only, and reset by every call', () => {
  const p = page();
  p.location.hash = CONF_LINK; assert.equal(p.loadFromHash(), true);
  assert.deepEqual(p.pending, { id: 1085880, kind: 'conf', token: null });
  p.location.hash = `#tab=playoffs&season=${NAT[0]}&stage=${encodeURIComponent(Object.keys(NAT[1].national)[0])}&age=GU15&tier=40581&match=-12`;
  p.loadFromHash(); assert.deepEqual(p.pending, { id: -12, kind: 'playoff', token: null }, 'a negative id (a reconstructed game) is accepted');
  p.location.hash = `#tab=showcases&season=${SC[0]}&event=${Object.values(SC[1].showcases)[0].eventId}&age=GU14&flight=7&view=schedule&match=644874`;
  p.loadFromHash(); assert.deepEqual(p.pending, { id: 644874, kind: 'showcase', token: null });
  p.location.hash = `#tab=teams&season=${S0}&team=5&name=X&match=99`;
  p.loadFromHash(); assert.equal(p.pending, null, 'a team link with match= leaves nothing pending');
  p.location.hash = CONF_LINK.replace('&match=1085880', '');
  p.loadFromHash(); assert.equal(p.pending, null, 'the next load without match= clears it');
  p.location.hash = CONF_LINK.replace('1085880', 'abc'); p.loadFromHash(); assert.equal(p.pending, null, 'not a game id');
  p.pending = { id: 1, kind: 'conf', token: null };
  p.location.hash = '#match=5';
  assert.equal(p.loadFromHash(), false, 'an unknown-only hash stays a no-op');
  assert.equal(p.pending, null);
});

test('router: pushHash and saveState never write match=, so the address loses it once the view is drawn', () => {
  const p = page();
  p.location.hash = CONF_LINK; p.loadFromHash();
  p.pushHash();
  assert.ok(!/match=/.test(p.location.hash), p.location.hash);
  assert.match(p.location.hash, /&view=schedule&team=1$/);
  p.saveState();
  assert.ok(!/match|1085880/.test(JSON.stringify(p.store)), 'never saved as the place');
  assert.equal(p.T.history.length, 1, 'replaceState: no history entry');
});

test('MF8: the hashchange handler focuses the title only when no match is pending (focus moves once)', () => {
  const p = page();
  p.location.hash = CONF_LINK; p.fire();
  assert.equal(p.T.titleFocus, 0, 'a match= link: focusMatch is the only place focus goes');
  assert.ok(html.includes('if (handOff && !pendingMatch) focusContentTitle();'));
});

test('MF8: a match lives only as long as the load that carried it: bound to its token, dropped by a newer load, an error, a click or a key', () => {
  const p = page();
  p.pending = { id: 7, kind: 'conf', token: null };
  p.bindMatch('playoff', 3); assert.equal(p.pending.token, null, 'another view\'s load does not take it');
  p.bindMatch('conf', 3); assert.equal(p.pending.token, 3);
  p.bindMatch('conf', 4); assert.equal(p.pending, null, 'superseded: a second load before the first rendered marks nothing');
  assert.equal(p.focusMatch('conf', 4, []), null);
  // a failed load, then an age click: no note
  const c = el('div', { attrs: { id: 'standingsContainer' } });
  const q = page({ container: c });
  q.pending = { id: 7, kind: 'conf', token: null };
  q.bindMatch('conf', 1); q.dropMatch('conf', 1);
  assert.equal(q.pending, null, 'the error path drops it');
  q.bindMatch('conf', 2);
  assert.equal(q.focusMatch('conf', 2, []), null);
  assert.equal(c.inserted, undefined, 'no "isn\'t in this list" note on an unrelated view');
  // any click or key drops a match still waiting, and the mark
  const r = page({ container: c });
  r.pending = { id: 7, kind: 'conf', token: 5 };
  const caps = r.docListeners.filter(([, , cap]) => cap === true).map(([t]) => t).sort();
  assert.deepEqual(caps, ['keydown', 'pointerdown']);
  r.docListeners.find(([t]) => t === 'pointerdown')[1]({});
  assert.equal(r.pending, null);
});

test('focusMatch: opens a consolation bracket, scrolls only the content pane, marks and focuses the row, announces it once', () => {
  FOCUS.length = 0;
  const card = el('div', { cls: ['bracket-match'], attrs: { 'data-match': '644874' }, rect: { top: 900, bottom: 980, left: 0, width: 200 } });
  const det = el('details', { kids: [el('div', { cls: ['bracket'], kids: [card] })] });
  const c = el('div', { attrs: { id: 'standingsContainer' }, kids: [det] });
  const p = page({ container: c });
  p.pending = { id: 644874, kind: 'playoff', token: 9 };
  const g = { matchID: 644874, homeTeam: 'MVLA ECNL G11', awayTeam: 'Mustang SC ECNL G11', gameDate: '2025-07-12T12:00:00', complex: '60 Acres Park', venue: 'Field 5' };
  const got = p.focusMatch('playoff', 9, [g]);
  assert.equal(got, card);
  assert.equal(det.open, true, 'the consolation <details> holding it opens');
  assert.ok(card.classList.contains('is-match'));
  assert.equal(card.attrs.tabindex, '-1');
  assert.deepEqual(FOCUS.map(x => [x, x.focused]), [[card, { preventScroll: true }]], 'focused once, without the browser scrolling');
  assert.equal(p.scroll.scrollTop, 900 - 100 - Math.round(400 / 3), 'only the content pane scrolls: the game a third of the way down');
  assert.equal(p.box('matchNote').textContent, 'From search: MVLA against Mustang SC, Day 2025-07-12, 60 Acres Park Field 5.');
  assert.equal(p.pending, null, 'once');
  assert.equal(p.focusMatch('playoff', 9, [g]), null, 'a second render does nothing');
  // a Matches row whose day heading fits with it: the heading at the top
  const row = el('div', { cls: ['match-row'], attrs: { 'data-match': '5' }, rect: { top: 640, bottom: 700, left: 0, width: 500 } });
  const day = el('section', { cls: ['match-day'], kids: [el('h3', { cls: ['match-day-head'], rect: { top: 600, bottom: 630, left: 0, width: 500 } }), row] });
  const q = page({ container: el('div', { attrs: { id: 'standingsContainer' }, kids: [day] }) });
  q.pending = { id: 5, kind: 'conf', token: 1 };
  q.focusMatch('conf', 1, [{ matchID: 5, homeTeam: 'A', awayTeam: 'B', gameDate: '2026-04-10' }]);
  assert.equal(q.scroll.scrollTop, 600 - 100 - 8);
});

test('focusMatch: a game the filter hides switches the filter once; a game that is not there gets a note, never a wrong mark', () => {
  const c = el('div', { attrs: { id: 'standingsContainer' } });
  let rendered = 0;
  const p = page({ container: c, render: () => { rendered++; c.kids.push(Object.assign(el('div', { cls: ['match-row'], attrs: { 'data-match': '11' } }), { parent: c })); } });
  p.setView('schedule', 'upcoming');
  p.pending = { id: 11, kind: 'conf', token: 2 };
  const got = p.focusMatch('conf', 2, [{ matchID: 11, hometeamscore: 2, awayteamscore: 1, gameDate: '2026-10-10' }]);
  assert.equal(p.filter(), 'results', 'a score landed since the link was built: Results');
  assert.equal(rendered, 1, 'once');
  assert.ok(got && got.classList.contains('is-match'));
  const d = el('div', { attrs: { id: 'standingsContainer' } });
  const q = page({ container: d });
  q.setView('schedule', 'upcoming');
  q.pending = { id: 12, kind: 'conf', token: 2 };
  assert.equal(q.focusMatch('conf', 2, []), null);
  assert.equal(d.inserted.length, 1);
  assert.match(d.inserted[0][1], /This game isn’t in this list any more\. It may have moved since the search data was built\./);
});

test('the three views mark their rows with data-match: the Matches view, a bracket card, a Schedule row', () => {
  const p = page();
  const g = { matchID: -35, hometeamID: 1, awayteamID: 2, homeTeam: 'A', awayTeam: 'B', gameDate: '2026-04-10', gameTimeText: '9:00 AM' };
  assert.match(p.matchRowHtml(g, { today: '2026-10-17' }), /<div class="match-row" data-home="1" data-away="2" data-match="-35">/);
  assert.match(p.bracketMatchCard({ game: g, winner: null }), /<div class="bracket-match" data-gm="" data-match="-35">/);
  assert.match(block('    function renderScheduleTable('), /<tr data-match="\$\{esc\(g\.matchID\)\}">/);
});

test('the loads bind the match to their token and focus it at the end of their render; their errors drop it', () => {
  const conf = block('    async function loadCurrentView('), po = block('    async function loadPlayoffFlight('), sc = block('    async function loadShowcaseFlight(');
  assert.match(conf, /const token = \+\+loadToken;\n\s+bindMatch\('conf', token\);/);
  assert.match(conf, /renderConferenceView\(\);\n\s+focusMatch\('conf', token, currentFlightData\.flatMap/);
  assert.match(conf, /catch \(err\) \{\n\s+console\.error\(err\);\n\s+dropMatch\('conf', token\);/);
  assert.match(po, /bindMatch\('playoff', token\);/); assert.match(po, /focusMatch\('playoff', token, games\);\n\s+\} catch/); assert.match(po, /dropMatch\('playoff', token\);/);
  assert.match(sc, /if \(!rerender\) bindMatch\('showcase', token\);/); assert.match(sc, /focusMatch\('showcase', token, games\);\n\s+\} catch/); assert.match(sc, /dropMatch\('showcase', token\);/);
});
