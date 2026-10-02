// #135 P3: the team page's Overview leads with the team. An identity header with Follow beside the
// title; "at a glance", scoped to the squad's newest season, with the next match under #64's rule
// (nextFixture, shared with the conference card, P2's sheet and the season tab); next actions; the
// history unchanged below; "how these seasons are linked" in a disclosure. A team the visitor
// doesn't follow sits under Conferences (its sidebar, its tab), not an empty My Teams.
// The page's own code (public/index.html), extracted block by block as in the other page tests,
// runs on a small fake DOM with requests answered from the committed archive. Fixtures are found
// by scanning the history files and the schedules, and every expectation is computed from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(process.env.ECNL_TEST_HTML || new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };

// ---------- the data ----------
const SOURCES = read('data/sources.json');
const SEASONS = SOURCES.seasons;
const OPEN = SOURCES.refresh.activeSeason;
const CLUBS = read('archive/clubs.json');
const HIST = new URL('archive/history/', root);
const FILES = existsSync(HIST) ? readdirSync(HIST).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(new URL(f, HIST), 'utf8'))) : [];
const missingHistory = !FILES.length && 'no team-history data in this checkout';
const scheduleFile = (e, f) => new URL(`archive/api/Event/get-schedules-by-flight/${e}/${f}/0.json`, root);
const scheduleOf = (e, f) => existsSync(scheduleFile(e, f)) ? (JSON.parse(readFileSync(scheduleFile(e, f), 'utf8')).data || []) : null;
const label = s => s.replace('-', '–');
const short = r => String(r.name).replace(/\s*[-–]?\s*ECNL\b.*$/i, '').trim() || r.clubName;
const placeOf = clubID => { const p = clubID != null && Number(clubID) !== 7 && CLUBS.clubs[clubID]; return p && p.city && p.state ? `${p.city}, ${p.state}` : ''; };
// The squad the page shows for a link to `season` (as renderTeamHistory picks it), and its newest row.
const mineIn = (q, id) => q.seasons.filter(r => String(r.teamID) === String(id));
function squadFor(doc, season) {
  const latest = q => (mineIn(q, doc.teamID).slice(-1)[0] || { season: '' }).season;
  return doc.squads.find(q => mineIn(q, doc.teamID).some(r => r.season === season))
    || doc.squads.slice().sort((a, b) => latest(b).localeCompare(latest(a)))[0];
}
const newest = (doc, season) => { const q = squadFor(doc, season); return q.seasons[q.seasons.length - 1]; };
const linkSeason = doc => (mineIn(doc.squads[0], doc.teamID).slice(-1)[0] || doc.squads[0].seasons.slice(-1)[0]).season;
const unplayed = g => g.hometeamscore == null || g.awayteamscore == null;
const day = g => (g.gameDate || '').slice(0, 10);
const realDate = g => !g.dateUnconfirmed && day(g) >= '1900';
// A current squad with an unplayed, dated game ahead in its schedule; an archived squad; a link
// whose season is older than its squad's newest row; a squad that has played no games.
const CUR = FILES.find(d => d.squads.length === 1 && (r => r.season === OPEN && r.inProgress && r.gp > 0 && Array.isArray(r.last) && r.form && r.last.length === r.form.length
  && new Set((scheduleOf(r.eventID, r.flightID) || []).filter(g => (g.hometeamID === r.teamID || g.awayteamID === r.teamID) && unplayed(g) && realDate(g)).map(day)).size >= 2)(newest(d, linkSeason(d))));
const OLD = FILES.find(d => d.squads.length === 1 && (r => r.season < OPEN && d.squads[0].seasons.length >= 3)(newest(d, linkSeason(d))));
const OLDER = FILES.find(d => d.squads.length === 1 && newest(d, OPEN).season === OPEN && mineIn(d.squads[0], d.teamID).some(r => r.season < OPEN));
const GP0 = FILES.find(d => d.squads.length === 1 && (r => r.season === OPEN && r.gp === 0)(newest(d, OPEN)));
const skip = missingHistory || (!CUR && 'no current-season squad with dated pending fixtures in committed archive');

// ---------- a small fake DOM (as tests/conference-sheet.test.mjs) ----------
function makeDom() {
  let active = null, top = null;
  const docOn = {};
  const attrsOf = s => Object.fromEntries([...s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
  const one = (el, compound) => {
    const m = compound.match(/^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(:[\w-]+)?$/i);
    if (!m) throw new Error(`fake DOM: selector ${compound}`);
    if (m[5]) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2].slice(1)) return false;
    for (const c of (m[3] || '').split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
    for (const a of (m[4] || '').match(/\[[^\]]+\]/g) || []) {
      const [, k, v] = a.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!(k in el.attrs) || (v !== undefined && el.attrs[k] !== v)) return false;
    }
    return true;
  };
  const matches = (el, sel) => sel.split(',').some(s => {
    const parts = s.trim().split(/\s+/);
    if (!one(el, parts.pop())) return false;
    for (let e = el.parent; parts.length && e; e = e.parent) if (one(e, parts[parts.length - 1])) parts.pop();
    return !parts.length;
  });
  class El {
    constructor(tag, attrs = {}) { Object.assign(this, { tagName: tag.toUpperCase(), attrs, kids: [], parent: null, alive: true, on: {}, _html: '', textContent: '', style: {}, hidden: false, writes: 0 }); }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }
    get classList() {
      const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
      return { contains: c => list().includes(c), add: c => { if (!list().includes(c)) el.className = [...list(), c].join(' '); },
        remove: c => { el.className = list().filter(x => x !== c).join(' '); },
        toggle(c, on) { on = on === undefined ? !list().includes(c) : !!on; if (on) this.add(c); else this.remove(c); return on; } };
    }
    get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
    get open() { return 'open' in this.attrs; }
    set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
    get isConnected() { for (let e = this; e; e = e.parent) { if (!e.alive) return false; if (e === top) return true; } return false; }
    get innerHTML() { return this._html; }
    set innerHTML(h) {
      this.writes++;
      for (const k of this.kids) k.alive = false;
      this._html = h; this.kids = [];
      for (const m of h.matchAll(/<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) { const k = new El(m[1], attrsOf(m[2])); k.parent = this; this.kids.push(k); }
      this.textContent = h.replace(/<[^>]*>/g, '');
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...ks) { for (const k of ks) { k.parent = this; this.kids.push(k); } }
    appendChild(k) { this.append(k); return k; }
    all() { return this.kids.flatMap(k => [k, ...k.all()]); }
    matches(sel) { return matches(this, sel); }
    closest(sel) { for (let e = this; e && e !== top; e = e.parent) if (e.matches(sel)) return e; return null; }
    querySelector(sel) { return this.all().find(e => e.matches(sel)) || null; }
    querySelectorAll(sel) { return this.all().filter(e => e.matches(sel)); }
    contains(x) { for (; x; x = x.parent) if (x === this) return true; return false; }
    focus() { active = this; }
    addEventListener(t, f) { (this.on[t] ||= []).push(f); }
  }
  top = new El('html');
  const body = new El('body');
  top.append(body);
  const add = (tag, attrs) => { const e = new El(tag, attrs); body.append(e); return e; };
  for (const id of ['breadcrumb', 'contentSubtitle', 'extLinks', 'formatNote', 'standingsContainer', 'viewTabs', 'sidebarSeason', 'showcasesPanel',
    'favoritesPanel', 'playoffsPanel', 'myTeamsBackLabel', 'landing', 'favoritesList', 'favoritesEmpty', 'observed']) add('div', { id });
  add('div', { id: 'conferencesPanel', class: 'sidebar-panel' });
  add('h1', { id: 'contentTitle', tabindex: '-1' });
  add('div', { id: 'titleActions', class: 'title-actions' }).hidden = true;
  for (const id of ['tabConferences', 'tabPlayoffs', 'tabShowcases']) add('button', { id, class: 'sidebar-tab', role: 'tab' });
  add('button', { id: 'myTeamsToggle', 'aria-expanded': 'false' });
  add('button', { id: 'viewTabStandings' }); add('button', { id: 'viewTabSchedule' });
  add('a', { class: 'section-label' });
  const document = {
    documentElement: top, body, get activeElement() { return active || body; },
    getElementById: id => top.all().find(e => e.id === id) || null,
    querySelector: s => top.querySelector(s), querySelectorAll: s => top.querySelectorAll(s),
    createElement: t => new El(t), addEventListener: (t, f) => { (docOn[t] ||= []).push(f); }, dispatchEvent() {},
  };
  return { El, document, top, body };
}

// ---------- the page ----------
const OVERVIEW = [
  block('    function getAgeLabel(', 'function sortAgeGroups('), line('    function seasonLabel('),
  block('    function shortTeamName('), block('    function displayName('), block('    function gameWinner('), block('    function resultFor('),
  line('    function gameDateKey('), line('    function isPlayed('), block('    function sortGames('),
  block('    // #64: the next match', 'function computeTeamSummary('),
  block('    async function getSchedule(', 'function undateBorrowedDates('), block('    function formatGameDate('), block('    function opponentText('),
  block('    // #128: form chips that show their game.', 'function chipGames('),
  line('    const isRefusal'), line('    const isMissing'), block('    function retryText('),
  block('    let clubPlaces = null', 'function favoriteInDivision('),
  line('    const teamHistoryMissing'), block('    function historyAvailable('), block('    function teamSeasonTabLabel('),
  block('    function starButton(', 'function recordFromButton('), block('    function glancePanelHtml('),
  block('    function historyYears(', 'function historyOutcome('), block('    function historySplitNotes('), block('    function historyChartSvg('),
  block('    function historyCrumb('), block('    function renderTeamHistory('), line('    const confHref'), line('    const pageHref'),
].join('\n');
const SIDEBAR = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'), line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    let loadToken = 0;'), line('    let showcaseToken = 0;'),
  line('    function getSeasonData()'), line('    function seasonLabel('), block('    function saveState('), block('    function loadSavedState('),
  block('    function pushHash('), block('    function loadFromHash('),
  block('    const TOP_TABS = ', 'function closeMyTeams('), block('    function switchTab('),
  block('    // #135 P3: a team the visitor', 'function previewChrome('),
  block('    async function loadAgeGroupsForSeason('), block('    function selectAgeGroup('), block('    function selectConference('),
  block('    function starButton(', 'function recordFromButton('), block('    function toggleFavorite('), block('    function openFavoritesTab('),
  block('    function historyCrumb('), block('    async function loadTeamSummary('),
  block('    async function loadTeamHistory('), line('    const teamHistoryMissing'),
  block('    // ========== LANDING (#135 P1a)', 'async function renderTeamsIndex('),
].join('\n');

function page({ today = '2026-10-02', holdSchedule = null, schedule = null, favorites: follow = [] } = {}) {
  const dom = makeDom();
  const { document, El } = dom;
  const calls = [], spy = { sidebar: [], openFav: 0, ageTabs: [], confList: [], loadStandings: 0, history: [] };
  const store = {};
  const location = { hash: '', search: '' };
  const stubs = {
    document, location, window: { location, addEventListener() {} }, history: { replaceState: (_s, _t, h) => { location.hash = h; }, pushState() {} },
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] ?? null },
    SOURCES, SEASONS, LIVE: false, esc, refreshState: {}, NATIONAL_EVENTS: {}, EXTERNAL_ICON: '', todayKey: () => today, CLUBS_FOR_TEST: CLUBS,
    fetchJSON: async path => {
      calls.push(path);
      let m;
      if ((m = path.match(/^events\/(\d+)\/flights\/(\d+)\/schedule$/))) {
        if (holdSchedule) await holdSchedule.promise;
        if (schedule) return schedule(m[1], m[2]);
        const games = scheduleOf(m[1], m[2]);
        if (!games) throw Object.assign(new Error('404'), { status: 404 });
        return { data: games };
      }
      if (path === 'clubs') return CLUBS;
      throw new Error(`unexpected request ${path}`);
    },
    eventContext: e => { for (const [s, v] of Object.entries(SEASONS)) for (const [n, c] of Object.entries(v.conferences)) if (String(c.eventId) === String(e)) return { season: s, name: n, kind: 'conference' }; return null; },
    getStandingsUrl: () => '#tgs', getSchedulesUrl: () => '#tgs', formatDateRange: (a, b) => `${a}–${b}`, formatObservedDate: d => d,
    sortAgeGroups: x => x,
  };
  const api = new Function(...Object.keys(stubs), `let teamToken = 0, previewTeam = null, currentFavorite = null, favorites = new Set(), favoriteMeta = new Map(), currentSeason = ${JSON.stringify(OPEN)};
    const showTeamInSidebar = (...a) => sidebarCalls.push(a);
    const sidebarCalls = [];
    ${OVERVIEW}
    return { renderTeamHistory, nextFixture, computeTeamSummary, glancePanelHtml, recordFromButton, starButton, sidebarCalls,
      bump: () => ++teamToken, token: () => teamToken, setPlaces: () => { clubPlaces = CLUBS_FOR_TEST.clubs; }, setPreview: r => { previewTeam = r; }, setSeason: s => { currentSeason = s; } };`)(...Object.values(stubs));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  const render = (doc, season) => {
    const sq = squadFor(doc, season), r = newest(doc, season);
    const rec = { teamID: doc.teamID, name: r.name };
    api.setSeason(season); api.setPreview(rec);
    dom.document.getElementById('standingsContainer').innerHTML = '';
    api.renderTeamHistory(rec, season, doc);
    const c = document.getElementById('standingsContainer');
    const stack = c.querySelector('.hist-stack');
    return { sq, r, c, stack, card: c.querySelector('.ov-glance'), slot: c.querySelector('.ov-next-body'), aside: c.querySelector('aside'),
      title: document.getElementById('contentTitle'), subtitle: document.getElementById('contentSubtitle').textContent, follow: document.getElementById('titleActions') };
  };
  return { ...api, dom, document, calls, flush, render, El };
}
const glanceHtml = (p, el) => el ? el.innerHTML : '';
const panelsOf = c => c.querySelector('.hist-stack').kids.map(k => k.className);

test('H1: the identity header: the squad and its birth years, then its newest name, age group, conference and place (every file)', { skip: missingHistory }, () => {
  const p = page();
  p.setPlaces();   // as loadTeamHistory loads them before it renders
  for (const doc of FILES) {
    const season = linkSeason(doc), sq = squadFor(doc, season), r = newest(doc, season);
    const o = p.render(doc, season);
    const years = sq.birthYears.length === 1 ? String(sq.birthYears[0]) : `${sq.birthYears[0]}/${String(sq.birthYears.at(-1)).slice(-2)}`;
    assert.ok(o.title.innerHTML.endsWith(esc(`${short(r)} · born ${years}`)), `${doc.teamID}: title`);
    const prefix = r.season !== OPEN ? `Last seen ${label(r.season)}: ` : '';
    assert.ok(o.subtitle.startsWith(`${prefix}${r.name} · `), `${doc.teamID}: subtitle`);
    assert.ok(o.subtitle.endsWith(placeOf(sq.clubID) ? ` · ${placeOf(sq.clubID)}` : ` · ${r.conference}`), `${doc.teamID}: place`);
    assert.equal(o.follow.hidden, false);
  }
});

test('H2: the scope line, and a next-match slot only for the open season (every file)', { skip: missingHistory }, () => {
  const p = page();
  for (const doc of FILES) {
    const season = linkSeason(doc), r = newest(doc, season);
    const o = p.render(doc, season);
    const scope = o.card.querySelector('.ov-scope');
    const want = r.season !== OPEN ? `Latest recorded season: ${label(r.season)} (final)` : `${label(r.season)} · ${r.inProgress ? `in progress, ${r.played} of ${r.games} games` : 'final'}`;
    assert.equal(o.card.innerHTML.match(/<div class="ov-scope">([^<]*)</)[1], esc(want), `${doc.teamID}`);
    assert.equal(!!o.slot, r.season === OPEN, `${doc.teamID}: next-match slot`);
    assert.ok(scope);
  }
});

test('H3: the glance figures are the newest row of the squad, even when the link names an older season; 0 games: no position', { skip: skip || (!(OLDER && GP0) && 'archive has no older-link or zero-games fixture') }, () => {
  assert.ok(CUR && OLDER && GP0, 'fixtures (precondition)');
  const p = page();
  for (const [doc, season] of [[CUR, linkSeason(CUR)], [OLDER, mineIn(OLDER.squads[0], OLDER.teamID).find(r => r.season < OPEN).season]]) {
    const o = p.render(doc, season), r = newest(doc, season);
    assert.equal(r.season, OPEN, 'the newest row is the open season');
    const h = o.card.innerHTML;
    assert.match(h, new RegExp(`<div class="stat-value">${r.rank}<span class="stat-of"> / ${r.of}</span></div>`));
    assert.match(h, new RegExp(`<div class="stat-value">${r.w}-${r.d}-${r.l}</div>`));
    const ppg = r.ppg != null ? r.ppg : r.pts / r.gp;
    assert.ok(h.includes(`${r.pts} pts · ${r.gp} GP · ${ppg.toFixed(2)} PPG`));
    assert.ok(h.includes(`${label(r.season)} · in progress`), 'scoped to the newest season, not the linked one');
  }
  const o = p.render(GP0, OPEN);
  assert.match(o.card.innerHTML, /<div class="stat-value">—<\/div>/);
  assert.ok(o.card.innerHTML.includes('No games yet · '));
});

test('H4: #64: the next match is dated today or later; past unplayed games are "not reported"; the views agree', { skip }, async () => {
  const r = newest(CUR, linkSeason(CUR));
  const mine = (scheduleOf(r.eventID, r.flightID) || []).filter(g => g.hometeamID === r.teamID || g.awayteamID === r.teamID);
  const ahead = mine.filter(g => unplayed(g) && realDate(g)).sort((a, b) => day(a).localeCompare(day(b)));
  const days = [...new Set(ahead.map(day))];
  assert.ok(days.length >= 2, 'two unplayed dates (precondition)');
  const cases = [[days[0], ahead.find(g => day(g) === days[0])], [days[1], ahead.find(g => day(g) === days[1])]];
  const after = `${Number(days.at(-1).slice(0, 4)) + 1}-12-31`;
  for (const [today, want] of [...cases, [after, null]]) {
    const notReported = mine.filter(g => unplayed(g) && realDate(g) && day(g) < today).length;
    const p = page({ today });
    const o = p.render(CUR, linkSeason(CUR));
    await p.flush();
    const t = o.slot.innerHTML;
    if (want) {
      const opp = want.hometeamID === r.teamID ? want.awayTeam : want.homeTeam;
      assert.ok(t.includes(esc(`${want.hometeamID === r.teamID ? 'vs' : 'at'} ${String(opp).replace(/\s*[-–]?\s*ECNL\b.*$/i, '').trim()}`)), `${today}: the next match`);
    } else assert.match(t, /No upcoming match/);
    if (notReported) assert.ok(t.includes(`${notReported} result${notReported === 1 ? '' : 's'} not reported yet`), `${today}: not reported`);
    else assert.doesNotMatch(t, /not reported/);
    // The same through computeTeamSummary: the conference card, P2's sheet, the season tab and My Teams.
    const s = p.computeTeamSummary(r.teamID, [], mine, 5, true);
    assert.equal(s.next ? s.next.matchID ?? day(s.next) : null, want ? want.matchID ?? day(want) : null, `${today}: computeTeamSummary`);
    assert.equal(s.unreported, notReported);
    const card = p.glancePanelHtml({ teamID: r.teamID, name: r.name, clubName: r.clubName }, s, {});
    if (notReported) assert.ok(card.includes(`${notReported} result${notReported === 1 ? '' : 's'} not reported yet`));
    if (!want) assert.match(card, /No upcoming match/);
  }
  // Undated games come after dated ones; a 0001-01-01 game is TBD, never "not reported", with no time (S1).
  const p = page({ today: after });
  const g0 = { ...ahead[0], gameDate: '0001-01-01T00:00:00', gameTimeText: '10:00 AM' };
  const tbd = { ...ahead[0], dateUnconfirmed: true };
  assert.equal(p.nextFixture([g0], true).next, g0);
  assert.equal(p.nextFixture([g0], true).unreported, 0);
  assert.equal(p.nextFixture([tbd, ahead[0]], true).next, tbd, 'after the last date, the TBD leg');
  const before = page({ today: days[0] });
  assert.equal(before.nextFixture([tbd, g0, ahead[0]], true).next, ahead[0], 'dated future fixture outranks TBD');
  const sentinel = page({ today: after, schedule: () => ({ data: [g0] }) });
  const sentinelView = sentinel.render(CUR, linkSeason(CUR));
  await sentinel.flush();
  assert.match(sentinelView.slot.innerHTML, /Date TBD/);
  assert.doesNotMatch(sentinelView.slot.innerHTML, /10:00 AM|Date TBD · /);
  const s0 = p.computeTeamSummary(r.teamID, [], [g0], 5, true);
  const card0 = p.glancePanelHtml({ teamID: r.teamID, name: r.name }, s0, {});
  assert.match(card0, /Date TBD<\/div>/);
  assert.doesNotMatch(card0, /Date TBD · /);
  // A closed season: no next match and nothing "not reported".
  assert.deepEqual(p.nextFixture(ahead, false), { next: null, unreported: 0 });
  assert.equal(p.computeTeamSummary(r.teamID, [], ahead, 5, false).next, null);
});

test('H5: a next match that answers after the page moved on writes nothing into the old slot', { skip }, async () => {
  const hold = deferred();
  const p = page({ holdSchedule: hold });
  const o = p.render(CUR, linkSeason(CUR));
  const before = o.slot.writes;
  p.bump();   // another team, My Teams' empty state, the landing page
  hold.resolve();
  await p.flush();
  assert.equal(o.slot.writes, before, 'the detached old slot node is not written');
});

test('H6: a refused schedule says "try again" with a Try again that asks once; a 404 says no fixtures', { skip }, async () => {
  let n = 0;
  const nextGames = scheduleOf(CUR_ROW.eventID, CUR_ROW.flightID);
  const p = page({ schedule: () => { if (++n === 1) throw Object.assign(new Error('429'), { status: 429 }); return { data: nextGames }; } });
  const o = p.render(CUR, linkSeason(CUR));
  await p.flush();
  assert.match(o.slot.innerHTML, /try again/i);
  assert.match(o.slot.innerHTML, /<button type="button" class="ov-retry/);
  assert.equal(n, 1);
  o.slot.querySelector('.ov-retry').onclick();
  await p.flush();
  assert.equal(n, 2, 'retry asks exactly once');
  assert.doesNotMatch(o.slot.innerHTML, /try again/i);
  assert.match(o.slot.innerHTML, /ov-next/);
  const q = page({ schedule: () => { throw Object.assign(new Error('404'), { status: 404 }); } });
  const o2 = q.render(CUR, linkSeason(CUR));
  await q.flush();
  assert.match(o2.slot.innerHTML, /No fixtures published yet/);
  assert.doesNotMatch(o2.slot.innerHTML, /<button/);
});

test('H7 (record): the header Follow carries the record the old aside did (#111), and only one Follow is on the page', { skip }, () => {
  const p = page();
  const o = p.render(CUR, linkSeason(CUR));
  const r = newest(CUR, linkSeason(CUR));
  const want = { name: r.name, teamID: r.teamID, clubID: r.clubID, clubName: r.clubName, eventID: r.eventID, divisionID: r.divisionID, division: r.division, flightID: r.flightID, clublogo: r.logo };
  assert.equal(o.follow.innerHTML, p.starButton(want, { label: true }));
  const btn = o.follow.querySelector('.star-btn');
  const got = p.recordFromButton(btn);
  for (const k of ['name', 'teamID', 'clubID', 'eventID', 'divisionID', 'flightID']) assert.equal(String(got[k]), String(want[k]), k);
  assert.ok(!o.aside.innerHTML.includes('star-btn'), 'no second Follow in the aside');
});

test('H8: "How these seasons are linked" is a closed disclosure; the notes on the seasons stay in place', { skip }, () => {
  const p = page();
  const o = p.render(CUR, linkSeason(CUR));
  const d = o.aside.querySelector('details.ov-linked');
  assert.ok(d && !d.open, 'closed by default');
  assert.match(o.aside.innerHTML, /<details class="ov-linked"><summary>How these seasons are linked<\/summary>[\s\S]*<dt>Linked by<\/dt>[\s\S]*<dt>Names used<\/dt>[\s\S]*<\/details>/);
  const withNotes = FILES.find(d2 => d2.squads.length === 1 && d2.squads[0].maybe && d2.squads[0].maybe.length);
  if (withNotes) {
    const o2 = p.render(withNotes, linkSeason(withNotes));
    const order = panelsOf(o2.c);
    assert.ok(order.indexOf('hist-maybe') > order.indexOf('flight-panel ov-glance'), 'the note stays in the history, below the glance');
  }
});

test('H9: the actions: the season tab, the standings and the newest event, each a link the page reads back', { skip }, () => {
  const p = page();
  for (const doc of [CUR, OLD]) {
    const o = p.render(doc, linkSeason(doc)), r = newest(doc, linkSeason(doc));
    const hrefs = [...o.card.innerHTML.matchAll(/<a class="ov-action[^"]*" href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1].replace(/&amp;/g, '&'), m[2]]);
    assert.equal(hrefs[0][0], `#tab=teams&season=${encodeURIComponent(r.season)}&team=${encodeURIComponent(r.teamID)}&name=${encodeURIComponent(r.name)}&view=season`);
    assert.equal(hrefs[0][1], `Open ${label(r.season)} season`);
    assert.equal(hrefs[1][0], `#season=${encodeURIComponent(r.season)}&age=${encodeURIComponent(r.division)}&conf=${encodeURIComponent(r.conference)}&team=${encodeURIComponent(r.teamID)}`);
    const sq = squadFor(doc, linkSeason(doc));
    const evs = [...(sq.postseason || []).map(e => ({ e, po: 1 })), ...(sq.showcases || []).map(e => ({ e, po: 0 }))].sort((a, b) => a.e.season.localeCompare(b.e.season) || a.po - b.po);
    if (evs.length) {
      const ev = evs.at(-1);
      assert.ok(hrefs[2][0].startsWith(ev.po ? `#tab=playoffs&season=${ev.e.season}` : `#tab=showcases&season=${ev.e.season}&event=${ev.e.eventID}`));
      if (!ev.po) assert.equal(hrefs[2][1], esc(`${ev.e.stage} ${label(ev.e.season)}: results`), 'the showcase is named (S5)');
    } else assert.equal(hrefs.length, 2);
    for (const [i, [href]] of hrefs.entries()) {
      const q = sidebar(); q.setAges(r.season); q.location.hash = href; q.loadFromHash();
      assert.equal(q.season(), i < 2 ? r.season : evs.at(-1).e.season);
      if (i === 0) { assert.equal(q.tab(), 'favorites'); assert.equal(q.view(), 'season'); assert.equal(q.preview().teamID, r.teamID); }
      if (i === 1) { assert.equal(q.tab(), 'conferences'); assert.equal(q.conf(), r.conference); assert.equal(q.age(), r.division); }
      if (i === 2) assert.equal(q.tab(), evs.at(-1).po ? 'playoffs' : 'showcases');
    }
  }
});

test('H12: requests: a current squad asks for its schedule once; an archived squad asks for nothing', { skip }, async () => {
  const p = page();
  p.render(CUR, linkSeason(CUR));
  await p.flush();
  const r = newest(CUR, linkSeason(CUR));
  assert.deepEqual(p.calls, [`events/${r.eventID}/flights/${r.flightID}/schedule`]);
  const q = page();
  q.render(OLD, linkSeason(OLD));
  await q.flush();
  assert.deepEqual(q.calls, []);
});

// ---------- the sidebar, routing and Follow ----------
function sidebar({ follow = [], historyLoad = null, games = [], summaryApi = null, hierarchy = null } = {}) {
  const dom = makeDom();
  const { document } = dom;
  const store = {}, calls = [], spy = { openFav: 0, built: [], standings: 0, teamSummary: [], history: [] };
  const location = { hash: '', search: '' };
  const stubs = {
    document, location, window: { location, addEventListener() {} }, history: { replaceState: (_s, _t, h) => { location.hash = h; }, pushState() {} },
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] ?? null }, SOURCES, SEASONS, esc, LIVE: false,
    getEventHierarchy: async () => { calls.push('hierarchy'); return hierarchy || { girlsDivAndFlightList: [] }; },
    getAgeLabel: d => d, sortAgeGroups: x => x, closeSidebarIfMobile() {}, closeTeamSheet() {},
    buildAgeGroupTabs: () => spy.built.push(['ages', AGE()]), buildConferenceList: () => spy.built.push(['confs', CONF()]),
    loadCurrentView: () => {}, rebuildAll: async () => {}, loadPlayoffsPanel: async () => {}, loadShowcasesPanel: async () => {},
    buildFavoritesList() {}, saveFavorites() {}, resolveAllFavorites() {}, sortedFavorites: () => [], focusTeamSearch() {},
    displayName: n => n, starText: (on, wide) => (wide ? (on ? '★ Following' : '☆ Follow') : (on ? '★' : '☆')),
    teamToken0: 0, overviewAvailable: () => true, showTeamViewTabs() {}, clearTeamFilter() {}, syncSeasonUI() {},
    resolveFavorite: async () => true, loadStandings: () => { spy.standings++; },
    eventContext: e => { for (const [s, v] of Object.entries(SEASONS)) for (const [n, c] of Object.entries(v.conferences)) if (String(c.eventId) === String(e)) return { season: s, name: n, kind: 'conference' }; return null; },
    getTeamHistory: async id => { spy.history.push(id); return historyLoad ? await historyLoad(id) : FILES.find(d => d.teamID === id) || { squads: [{}] }; },
    renderTeamHistory(rec, season, doc) { if (doc.squads[0]?.seasons) { const r = newest(doc, season); api.showTeamInSidebar(season, r.conference, r.division); } }, sameTeam: () => true,
    getStandings: async () => ({ teamStandings: [] }), getSchedule: async () => games, loadClubPlaces: async () => {},
    computeTeamSummary: (...a) => summaryApi ? summaryApi.computeTeamSummary(...a) : ({ mine: [], form: [], next: null }),
    glancePanelHtml: (...a) => summaryApi ? summaryApi.glancePanelHtml(...a) : '', getStandingsUrl: () => '', openSeason: () => OPEN,
    renderStandingsTable: () => new dom.El('div'), renderScheduleTable: () => new dom.El('div'), loadWarning: () => { const e = new dom.El('div'); e.innerHTML = '<strong>Error</strong>'; return e; }, failedFlightPanel: () => new dom.El('div'),
    shortTeamName: n => n, teamShowcaseSections: async () => [], NATIONAL_EVENTS: {}, isMissing: () => false, retryText: e => String(e),
    getDivisionAge: d => d, updateMyTeamsCount() {}, favoriteLabel: () => '', resumeLabel: () => '', savedPlace: () => null,
  };
  let AGE = () => null, CONF = () => null;
  const api = new Function(...Object.keys(stubs), SIDEBAR + `
    return { switchTab, toggleMyTeams, toggleFavorite, starButton, saveState, loadSavedState, loadFromHash, pushHash, selectConference, selectAgeGroup,
      showTeamInSidebar, openFavoritesTab, loadTeamSummary, showLanding, tabChrome,
      previewChrome,
      ages: () => AGE_GROUPS, age: () => currentAgeGroup, conf: () => currentConference, season: () => currentSeason, setSeason: s => { currentSeason = s; },
      tab: () => currentTab, preview: () => previewTeam, setPreview: r => { previewTeam = r; }, fav: () => currentFavorite, favs: () => favorites, token: () => teamToken, view: () => teamView,
      setAges: (s) => { ageGroupsSeason = s; AGE_GROUPS = Object.keys(SEASONS[s].ageGroups); seasonAgeGroups[s] = AGE_GROUPS; } };`)(...Object.values(stubs));
  AGE = () => api.age(); CONF = () => api.conf();
  const el = id => document.getElementById(id);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  // A team link, as hashchange reads one: a preview unless the team is followed.
  const open = async (r, view = '') => {
    location.hash = `#tab=teams&season=${r.season}&team=${r.teamID}&name=${encodeURIComponent(r.name)}${view}`;
    api.loadFromHash(); api.switchTab('favorites'); await flush();
  };
  const chrome = () => ({ fav: el('favoritesPanel').style.display, conf: el('conferencesPanel').style.display, expanded: el('myTeamsToggle').getAttribute('aria-expanded'),
    confTab: el('tabConferences').getAttribute('aria-selected'), onIndex: el('conferencesPanel').classList.contains('on-index'), season: el('sidebarSeason').style.display });
  return { ...api, dom, el, store, calls, spy, flush, open, chrome, location };
}
const CUR_ROW = CUR && newest(CUR, linkSeason(CUR));
const OLD_ROW = OLD && newest(OLD, linkSeason(OLD));

// Independent of fixture dates and season rollover: two valid catalog destinations.
const CONTEXTS = Object.entries(SEASONS[OPEN].conferences).slice(0, 2).map(([conference, c], i) => ({
  name: `Context team ${i + 1}`, teamID: 900001 + i, eventID: c.eventId,
  season: OPEN, conference, division: Object.keys(SEASONS[OPEN].ageGroups)[i],
}));
const followContext = (p, r) => p.toggleFavorite({ dataset: { team: r.name, teamId: String(r.teamID),
  event: String(r.eventID), divName: r.division } });

test('R143: Unfollow during a second team pending/refused history uses its own saved and navigation context', async () => {
  for (const view of ['', '&view=season']) {
    const held = deferred();
    const [a, b] = CONTEXTS;
    const p = sidebar({ historyLoad: async id => { if (id === b.teamID) { await held.promise; throw Object.assign(new Error('refused'), { status: 503 }); } return { squads: [{}] }; } });
    p.setAges(OPEN);
    followContext(p, a); followContext(p, b);
    await p.open(a);
    await p.showTeamInSidebar(a.season, a.conference, a.division);
    // Season view waits on hierarchy instead; the cached-context bug is the same load boundary.
    await p.open(b);
    if (view) await p.open(b, view);
    assert.match(p.el('breadcrumb').innerHTML, /My Teams/);
    p.toggleFavorite(b.name);
    await p.flush();
    assert.equal(p.conf(), b.conference, 'highlight is B conference, never A');
    assert.equal(p.age(), b.division, 'highlight is B age, never A');
    assert.doesNotMatch(p.el('breadcrumb').innerHTML, /My Teams/);
    const saved = JSON.parse(p.store['ecnl-dash-v2-state']);
    assert.deepEqual([saved.conference, saved.ageGroup], [b.conference, b.division]);
    held.resolve();
    await p.flush();
    p.switchTab('conferences', { silent: true });
    assert.deepEqual([p.conf(), p.age()], [b.conference, b.division], 'Conferences destination remains B after refusal');
  }
});

test('R143: selected preview tab is the single keyboard tab stop', async () => {
  const p = sidebar(); p.setAges(OPEN);
  p.switchTab('playoffs', { silent: true });
  await p.open(CONTEXTS[0]);
  assert.equal(p.el('tabConferences').tabIndex, 0);
  assert.equal(p.el('tabPlayoffs').tabIndex, -1);
});

test('R143: unknown second-team context withholds old highlight, saved place and navigation destination', async () => {
  const p = sidebar(); p.setAges(OPEN);
  const [a, b] = CONTEXTS;
  followContext(p, a);
  p.toggleFavorite({ dataset: { team: b.name, teamId: String(b.teamID) } });
  await p.open(a); await p.showTeamInSidebar(a.season, a.conference, a.division);
  await p.open(b);
  p.toggleFavorite(b.name); await p.flush();
  assert.equal(p.chrome().conf, 'none');
  const saved = JSON.parse(p.store['ecnl-dash-v2-state']);
  assert.deepEqual([saved.conference, saved.ageGroup], [null, null]);
  p.switchTab('conferences', { silent: true });
  assert.equal(p.age(), null, 'unknown context opens the index, not A table');
});

test('R143: an awaited age catalog for a departed team cannot apply its sidebar place', async () => {
  const p = sidebar(); const [a, b] = CONTEXTS;
  await p.open(b);
  p.setAges(Object.keys(SEASONS).find(s => s !== OPEN));
  const before = p.conf();
  const held = p.showTeamInSidebar(b.season, b.conference, b.division);
  p.setPreview(a);
  await held;
  assert.equal(p.conf(), before, 'departed team did not set conference after await');
});

test('H4 callers: closed conference card and actual season page suppress next match and unreported totals', () => {
  const closed = Object.keys(SEASONS).find(s => s !== OPEN);
  const [conf, c] = Object.entries(SEASONS[closed].conferences)[0];
  const division = Object.keys(SEASONS[closed].ageGroups)[0];
  const team = { teamID: 900099, name: 'Closed team', eventID: c.eventId, divisionName: division };
  const games = [{ hometeamID: team.teamID, awayteamID: 1, gameDate: '2099-10-20', homeTeam: team.name, awayTeam: 'Other' },
    { hometeamID: team.teamID, awayteamID: 1, gameDate: '2000-01-01', homeTeam: team.name, awayTeam: 'Other' }];
  const real = page();
  const glanceHtmlFor = new Function('computeTeamSummary', 'glancePanelHtml', 'currentSeason', 'openSeason', 'currentConference', 'currentConfMeta',
    block('    function glanceHtmlFor(') + '\nreturn glanceHtmlFor;')(real.computeTeamSummary, real.glancePanelHtml, closed, () => OPEN, conf, { ageLabel: division, flights: [] });
  const card = glanceHtmlFor({ team, fd: { standings: { teamStandings: [] }, games } });
  assert.doesNotMatch(card, /Other|not reported/);
  return (async () => {
    const p = sidebar({ games, summaryApi: real });
    p.el('titleActions').innerHTML = '<button>Old Follow</button>'; p.el('titleActions').hidden = false;
    await p.open({ ...team, season: closed }, '&view=season');
    assert.ok(p.el('standingsContainer').querySelector('.conf-layout'), 'real season page rendered successfully');
    assert.doesNotMatch(p.el('standingsContainer').querySelector('.glance-panel').innerHTML, /Other|not reported/);
    assert.equal(p.el('titleActions').innerHTML, '');
    assert.equal(p.el('titleActions').hidden, true);
  })();
});

test('H10: an unfollowed team sits under Conferences: that panel and tab, My Teams not expanded; a followed team keeps My Teams', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  await p.open(CUR_ROW);
  assert.deepEqual(p.chrome(), { fav: 'none', conf: '', expanded: 'false', confTab: 'true', onIndex: false, season: '' });
  // The team's own conference and age group, so the Conferences tab opens its table, and that is saved.
  await p.showTeamInSidebar(CUR_ROW.season, CUR_ROW.conference, CUR_ROW.division);
  assert.equal(p.conf(), CUR_ROW.conference);
  assert.equal(p.age(), CUR_ROW.division);
  assert.equal(JSON.parse(p.store['ecnl-dash-v2-state']).conference, CUR_ROW.conference, 'the place saved is the team\'s');
  // Followed: My Teams, as before.
  const q = sidebar();
  q.setAges(OPEN);
  q.toggleFavorite(q.starButton ? { dataset: { team: CUR_ROW.name, teamId: String(CUR_ROW.teamID) } } : CUR_ROW.name);
  await q.open(CUR_ROW);
  assert.equal(q.chrome().fav, 'flex');
  assert.equal(q.chrome().expanded, 'true');
  // A followed team is never a preview, even with a preview record left behind.
  q.setPreview({ name: CUR_ROW.name, teamID: CUR_ROW.teamID });
  assert.equal(q.tabChrome('favorites'), false);
  assert.equal(q.chrome().fav, 'flex');
});

test('H10 (M2): a team from another season loads that season\'s age groups (no request) and highlights its own', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  p.setSeason(OLD_ROW.season);
  await p.open(OLD_ROW);
  await p.showTeamInSidebar(OLD_ROW.season, OLD_ROW.conference, OLD_ROW.division);
  assert.deepEqual(p.ages(), Object.keys(SEASONS[OLD_ROW.season].ageGroups));
  assert.equal(p.age(), OLD_ROW.division);
  assert.equal(p.conf(), OLD_ROW.conference);
  assert.deepEqual(p.calls, [], 'the catalog has the age groups: no request');
  assert.ok(p.spy.built.some(([k, v]) => k === 'ages' && v === OLD_ROW.division));
});

test('H10 (M3): the season tab calls the same helper, so &view=season and ?live=1 previews are highlighted too', () => {
  const ts = block('    async function loadTeamSummary(');
  assert.match(ts, /showTeamInSidebar\(ctx\.season, ctx\.name, divisionName\)/);
  assert.match(block('    function renderTeamHistory('), /showTeamInSidebar\(season, here\.conference, here\.division\)/);
});

test('H10 (M4): leaving clears the preview; My Teams opens from a preview; My Teams\' empty state drops a late team page', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  await p.open(CUR_ROW);
  p.switchTab('conferences', { silent: true });
  assert.equal(p.preview(), null, 'leaving the team page leaves its preview');
  await p.open(CUR_ROW);
  p.toggleMyTeams();
  await p.flush();
  assert.equal(p.tab(), 'favorites');
  assert.equal(p.preview(), null);
  assert.equal(p.chrome().fav, 'flex');
  assert.equal(p.chrome().expanded, 'true');
  const t = p.token();
  p.openFavoritesTab();   // no team followed: the empty state
  assert.ok(p.token() > t, 'a team page still loading must not paint over My Teams');
  // Choosing a conference from a preview's sidebar leaves for that table.
  await p.open(CUR_ROW);
  p.selectConference(CUR_ROW.conference);
  assert.equal(p.tab(), 'conferences');
  assert.equal(p.preview(), null);
  assert.ok(p.spy.standings >= 1);
  await p.open(CUR_ROW);
  p.selectAgeGroup(CUR_ROW.division);
  assert.equal(p.tab(), 'conferences');
  assert.equal(p.preview(), null, 'choosing an age leaves team preview');
});

test('H7 (M5, re-review M1): Unfollow on the page keeps it, as a preview, with Conferences\' sidebar and no "My Teams" crumb', { skip }, async () => {
  for (const followedFirst of [false, true]) {
    const p = sidebar();
    p.setAges(OPEN);
    const btn = () => p.dom.document.getElementById('titleActions').querySelector('.star-btn');
    const rec = { name: CUR_ROW.name, teamID: CUR_ROW.teamID, eventID: CUR_ROW.eventID, divisionID: CUR_ROW.divisionID, flightID: CUR_ROW.flightID, division: CUR_ROW.division };
    if (followedFirst) { p.dom.document.getElementById('titleActions').innerHTML = p.starButton(rec, { label: true }); p.toggleFavorite(btn()); }
    await p.open(CUR_ROW);
    await p.showTeamInSidebar(CUR_ROW.season, CUR_ROW.conference, CUR_ROW.division);
    p.dom.document.getElementById('titleActions').innerHTML = p.starButton(rec, { label: true });
    if (!followedFirst) p.toggleFavorite(btn());   // Follow
    const hash = p.location.hash, opens = p.spy.history.length;
    const of = p.openFavoritesTab;
    p.toggleFavorite(btn());   // Unfollow
    await p.flush();
    assert.equal(p.tab(), 'favorites');
    assert.ok(p.preview() && p.preview().name === CUR_ROW.name, 'a preview of the same team');
    assert.equal(p.location.hash.replace(/&name=[^&]*/, ''), hash.replace(/&name=[^&]*/, ''), 'the hash keeps the team');
    assert.equal(p.spy.history.length, opens, 'openFavoritesTab not called: no reload of the page');
    assert.deepEqual([p.chrome().fav, p.chrome().conf, p.chrome().expanded, p.chrome().confTab], ['none', '', 'false', 'true'], `${followedFirst ? 'followed' : 'preview'}: Conferences' chrome`);
    assert.doesNotMatch(p.el('breadcrumb').innerHTML, /My Teams/);
    assert.equal(p.conf(), CUR_ROW.conference);
    assert.equal(p.age(), CUR_ROW.division);
    assert.equal(btn().getAttribute('aria-pressed'), 'false');
  }
});

test('H11: the Follow slot is emptied by every tab switch (Overview → Playoffs) and on the landing page; crumbs; CSS', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  await p.open(CUR_ROW);
  p.el('titleActions').innerHTML = '<button type="button" class="star-btn">☆ Follow</button>'; p.el('titleActions').hidden = false;
  p.switchTab('playoffs');
  assert.equal(p.el('titleActions').hidden, true);
  assert.equal(p.el('titleActions').innerHTML, '');
  // The season tab's breadcrumb names My Teams only for a followed team (S4).
  const ts = block('    async function loadTeamSummary(');
  assert.equal((ts.match(/\(currentFavorite \? `<span>My Teams<\/span><span class="breadcrumb-sep">›<\/span>` : ''\)/g) || []).length, 2);
  assert.doesNotMatch(ts, /<span>My Teams<\/span>` \+\n/);
  const css = html.slice(0, html.indexOf('</style>'));
  assert.match(css, /@media \(max-width: 1024px\) \{ \.conf-layout\.ov-layout > \.glance-panel \{ order: 1; position: static; \} \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.hist-stack \.hist-table-wrap \{ display: none; \} \.hist-stack \.hist-cards \{ display: block; \} \}/);
  assert.match(css, /\.hist-links a \{ display: inline-flex; align-items: center; justify-content: center; min-height: 24px; min-width: 24px; \}/);
  assert.match(css, /\.hist-links a \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(css, /\.hist-form \.form-chip\.inline \{ width: 44px; min-width: 44px; height: 44px;/);
  assert.match(css, /\.ov-glance \.form-chip \{ width: 44px; min-width: 44px; height: 44px;/);
  assert.match(css, /\.ov-action, \.ov-linked summary, \.ov-retry \{ min-height: 44px; \}/);
  assert.match(html, /<div class="title-row"><h1 class="content-title" id="contentTitle" tabindex="-1">Select a conference<\/h1><div class="title-actions" id="titleActions" hidden><\/div><\/div>/);
});

test('Interplay with #142 (1): a preview reached from the Teams index shows the age groups and the conference list', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  p.el('conferencesPanel').classList.add('on-index');   // the index hid them
  await p.open(CUR_ROW);
  assert.equal(p.chrome().onIndex, false, 'the lists are visible');
  assert.equal(p.chrome().conf, '');
});

test('Interplay with #142 (2): the landing page empties the Follow slot and the preview; a late next match paints nothing', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  await p.open(CUR_ROW);
  p.el('titleActions').innerHTML = '<button type="button" class="star-btn">☆ Follow</button>'; p.el('titleActions').hidden = false;
  const t = p.token();
  p.showLanding();
  assert.equal(p.el('titleActions').innerHTML, '');
  assert.equal(p.el('titleActions').hidden, true);
  assert.equal(p.preview(), null);
  assert.ok(p.token() > t, '#142 bumps the team token (H5 shows a bumped token writes nothing)');
});

test('Interplay with #142 (3): #142\'s saved team page reopens a P3 preview as a preview', { skip }, async () => {
  const p = sidebar();
  p.setAges(OPEN);
  await p.open(CUR_ROW);
  p.saveState();
  const saved = JSON.parse(p.store['ecnl-dash-v2-state']);
  assert.deepEqual([saved.tab, saved.teamPage && saved.teamPage.teamID, saved.teamPage && saved.teamPage.name], ['favorites', CUR_ROW.teamID, CUR_ROW.name]);
  const q = sidebar();
  q.setAges(OPEN);
  q.store['ecnl-dash-v2-state'] = p.store['ecnl-dash-v2-state'];
  q.loadSavedState();
  q.switchTab('favorites');
  await q.flush();
  assert.ok(q.preview() && q.preview().teamID === CUR_ROW.teamID);
  assert.deepEqual([q.chrome().fav, q.chrome().conf, q.chrome().expanded], ['none', '', 'false']);
});
