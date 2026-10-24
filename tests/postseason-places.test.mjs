// #194: the postseason places in the conference standings, run as the page's own code (public/index.html,
// extracted block by block as the other page tests do) against the committed rules file
// (public/data/postseason-2026-27.json) and frozen tables (tests/fixtures/postseason/: five real ones
// frozen from the archive, the rest synthetic). Exact places are asserted only on those frozen
// fixtures, and every expected tag below is written by hand from the document's rules and the frozen
// table, not taken from the code. Then rule-based checks on every archived 2026-27 conference table
// (no counts a refresh can move), and the loading: the rules are asked for once, beside the tables,
// the view is painted once, a superseded load paints nothing, and a failure is forgotten (MF2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const between = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b, i);
  assert.ok(i > 0 && j > i, `${a} not found in index.html`);
  return html.slice(i, j);
};
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RULES = JSON.parse(readFileSync(new URL('../public/data/postseason-2026-27.json', import.meta.url), 'utf8'));
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/postseason/${name}.json`, import.meta.url), 'utf8'));

// ---------- the places, the tag, the legend and the rank cell ----------
const PLACES = [
  block('    function shortTeamName('), block('    function displayName('),
  between("    // #194: the postseason places a conference age's tables", '    // Logo + short name;'),
].join('\n');
const warnings = [];
class Box { constructor() { this.className = ''; this.innerHTML = ''; } }
const document = { createElement: () => new Box() };
const consoleStub = { warn: m => warnings.push(m) };
const page = new Function('esc', 'document', 'console', PLACES + '\nreturn { postseasonPlaces, posTagHtml, postseasonLegend, rankHtml, POS_TIEBREAK };')(esc, document, consoleStub);

// currentFlightData as loadCurrentView builds it: _origRank is the published position.
const flightsOf = fx => fx.flights.map(f => {
  const teamStandings = f.teamStandings.map((t, i) => ({ ...t, _origRank: i + 1 }));
  return { flight: { flightName: f.flightName }, standings: { teamStandings }, standingsError: f.failed ? new Error('503') : null };
});
const placesOf = (fx, mutate = x => x) => {
  const fd = mutate(flightsOf(fx));
  return { fd, post: page.postseasonPlaces(RULES, fx.conference, fx.division, fd) };
};
// One label per row of each table, in published order ('' for no place).
const labels = (fd, post) => fd.map(f => f.standings.teamStandings.map(t => (post.places.get(t.teamID) || {}).label || ''));

const EXPECT = {
  // Mid-Atlantic U16, as published: Arlington (12/6) and Charlotte (6/3) are both 2.00 across the CL/CL* line;
  // SC Surf, Wilmington and NC Fusion are all 1.00 across the NAC/SA and SA/SB lines.
  'mid-atlantic-u16': [['CL', 'CL', 'CL=', 'CL*=', 'NAC', 'NAC=', 'SA=', 'SB=', '', '', '']],
  // Texas U17: Westlake 13/8 (1.625) is above FC Dallas 8/5 (1.60), so no tie across the CL/CL* line.
  'texas-u17': [['CL', 'CL', 'CL', 'CL', 'CL', 'CL', 'CL*', 'NAC', 'NAC', 'SA', 'SA', 'SB', '', '', '', '']],
  'north-atlantic-u13': [['CL', 'CL', 'CL', 'PI', '', '', '', '', '', '']],
  'new-england-u14': [['CL', 'CL', 'CL', 'PI', '', '', '', '', '']],
  // Midwest U13: top 2 of each division, then Michigan Hawks (East, 2.00) and KC Athletics (West, 1.70).
  'midwest-u13': [['CL', 'CL', 'CL', '', '', '', '', ''], ['CL', 'CL', 'CL', '', '', '', '', '']],
  'north-atlantic-u16': [['CL', 'CL', 'CL*', 'PI', 'NAC', 'SA', 'SB', '', '', '']],
  'new-england-u18': [['CL', '', '', '', '', '', '', '', '']],
  'ohio-valley-u16': [['CL', 'CL', 'NAC', 'NAC', '', ''], ['CL', 'CL', 'SA', 'SA', '', '']],
  'midwest-u13-tie': [['CL', 'CL', 'CL', '', ''], ['CL', 'CL', 'CL=', '', '']],
  // Q13: North D beats South C on GD and North E beats it on GF, both against table position; no '=' (N3).
  'ohio-valley-u16-order': [['CL', 'CL', 'NAC', 'NAC', 'SA', ''], ['CL', 'CL', 'SA', '', '', '']],
  'northwest-u13-early': [['CL', 'CL', '', 'CL', '', '', '']],
  'southeast-u15-none': [Array(16).fill('')],
};

for (const [name, want] of Object.entries(EXPECT)) {
  test(`frozen ${name}: the places, by hand from the document`, () => {
    const fx = fixture(name);
    const { fd, post } = placesOf(fx);
    assert.ok(post, 'the rules cover this table');
    assert.deepEqual(labels(fd, post), want);
  });
}

test('the words: League Cup, play-in opponents, "4th or 5th", U18/19 (B4) and ties, in the screen-reader text', () => {
  const text = (name, row, flight = 0) => { const { fd, post } = placesOf(fixture(name)); return post.places.get(fd[flight].standings.teamStandings[row].teamID).text; };
  assert.equal(text('mid-atlantic-u16', 3), 'Champions League, unless the League Cup winner takes it. Level on PPG with Arlington Soccer Association; order as published by TGS');
  assert.equal(text('mid-atlantic-u16', 0), 'Champions League');
  assert.equal(text('north-atlantic-u13', 3), 'Champions League play-in v New England');
  assert.equal(text('new-england-u14', 3), 'Champions League play-in v North Atlantic');
  assert.equal(text('north-atlantic-u16', 4), 'North American Cup, or one place higher, depending on the League Cup and the play-in');
  assert.equal(text('new-england-u18', 0), 'U18/19 Champions League, starts with a play-in game for the National Finals');
  assert.equal(text('midwest-u13', 2, 1), 'Champions League, next best across both divisions');
  assert.equal(text('midwest-u13-tie', 2, 1), 'Champions League, next best across both divisions. Level on PPG, GD, GF and GA with West D; the document gives no tie-breaker, so the table position decides here');
  const { post } = placesOf(fixture('new-england-u18'));
  const rank = page.rankHtml(1, [...post.places.values()][0], true);
  assert.match(rank, /class="rank-num pos-pill pos-cl">1<\/span><span class="sr-only">\. Postseason place: U18\/19 Champions League, starts with a play-in game/);
  assert.equal(page.posTagHtml([...post.places.values()][0]), '<span class="pos-tag pos-cl" aria-hidden="true" title="U18/19 Champions League, starts with a play-in game for the National Finals">CL</span>');
});

test('the rank cell: unchanged without places; no top-three accent in a table that shows places (N7)', () => {
  assert.equal(page.rankHtml(2), '<span class="rank-num rank-top">2</span>');
  assert.equal(page.rankHtml(4), '<span class="rank-num">4</span>');
  assert.equal(page.rankHtml(2, null, true), '<span class="rank-num">2</span>');
  assert.equal(page.posTagHtml(null), '');
});

test('from either division, a PPG tie is settled by GD, then GF, ahead of table position, and is not marked level (Q13, B3)', () => {
  const { post } = placesOf(fixture('ohio-valley-u16-order'));
  assert.deepEqual(post.pooled.map(p => `${p.tier} ${p.name} (${p.division})`),
    ['NAC North C (North)', 'NAC North D (North)', 'SA North E (North)', 'SA South C (South)']);
  assert.deepEqual(post.levels, [], 'GD decides the NAC/SA cut (North D +5, North E +2, both 2.00): no level');
  assert.ok([...post.places.values()].every(p => !p.level && !p.label.includes('=')), 'no = anywhere');
  const legend = page.postseasonLegend(post).innerHTML;
  assert.match(legend, /North American Cup: the next 2 by PPG from either division: North C \(North\), North D \(North\)\./);
  assert.match(legend, /Showcase Cup A: the next 2 by PPG from either division: North E \(North\), South C \(South\)\./);
  assert.doesNotMatch(legend, /Level on/);
});

test('a full pooled tie still gives exactly N places, decided by table position, both written as level (MF3)', () => {
  const { fd, post } = placesOf(fixture('midwest-u13-tie'));
  const cl = [...post.places.values()].filter(p => p.tier === 'CL');
  assert.equal(cl.length, 6, '2 + 2 by division, 2 pooled: never 7');
  assert.deepEqual(post.pooled.map(p => `${p.name} (${p.division})`), ['West C (West)', 'East C (East)']);
  assert.deepEqual(post.levels, [{ a: 'East C', b: 'West D', by: 'PPG, GD, GF and GA' }]);
  assert.equal(post.places.has(fd[0].standings.teamStandings[3].teamID), false, 'West D: no place');
  const legend = page.postseasonLegend(post).innerHTML;
  assert.match(legend, /= Level on PPG, GD, GF and GA: East C and West D\. The document gives no tie-breaker, so the table position decides here\./);
  assert.match(legend, /Champions League: the top 2 in each division\./);
  assert.match(legend, /Champions League: also the next 2 by PPG from either division: West C \(West\), East C \(East\)\./);
  assert.ok(legend.includes(esc(page.POS_TIEBREAK)), 'the pooled order is in the legend');
  assert.match(page.POS_TIEBREAK, /borrowed from the document's rule for ranking group runners-up/, 'B3');
});

test('the legend: the projection, every tag, every tie by name, the source; U18/19 says it starts with a play-in (B4)', () => {
  const ma = page.postseasonLegend(placesOf(fixture('mid-atlantic-u16')).post).innerHTML;
  assert.match(ma, /Postseason places if the season ended today \(projection, by conference PPG\)/);
  for (const s of ['>CL</span> Champions League<', '>CL*</span> Champions League, unless the League Cup winner takes it<',
    '>NAC</span> North American Cup<', '>SA</span> Showcase Cup A<', '>SB</span> Showcase Cup B<']) assert.ok(ma.includes(s), s);
  assert.match(ma, /= Level on PPG: Arlington Soccer Association and Charlotte SA\. Order as published by TGS\./);
  assert.match(ma, /= Level on PPG: South Carolina Surf and Wilmington Hammerheads\./);
  assert.match(ma, /= Level on PPG: Wilmington Hammerheads and NC Fusion\./);
  assert.match(ma, /Source: 2026-27 ECNL Girls Post-Season Structure\./);
  assert.doesNotMatch(ma, /Places appear once/);
  const ne = page.postseasonLegend(placesOf(fixture('new-england-u18')).post).innerHTML;
  assert.match(ne, />CL<\/span> U18\/19 Champions League, starts with a play-in game for the National Finals</);
  const na = page.postseasonLegend(placesOf(fixture('north-atlantic-u16')).post).innerHTML;
  assert.match(na, />PI<\/span> Champions League play-in v New England</);
  assert.match(na, /North American Cup, Showcase Cup A, Showcase Cup B: may be one place higher, depending on the League Cup and the play-in\./);
  const none = placesOf(fixture('southeast-u15-none')).post;
  assert.equal(none.places.size, 0);
  assert.match(page.postseasonLegend(none).innerHTML, /Places appear once games are played\./);
});

test('no places when the rules do not fit the tables, or a single table failed; a failed division keeps the division places only', () => {
  warnings.length = 0;
  const mw = fixture('midwest-u13');
  assert.equal(page.postseasonPlaces(RULES, 'Midwest', 'GU13', flightsOf(mw).slice(0, 1)), null, 'divisions expected, one table');
  const ma = fixture('mid-atlantic-u16');
  assert.equal(page.postseasonPlaces(RULES, 'Mid-Atlantic', 'GU16', [...flightsOf(ma), ...flightsOf(ma)]), null, 'one table expected, two');
  assert.equal(warnings.length, 2);
  assert.equal(page.postseasonPlaces(RULES, 'Atlantis', 'GU16', flightsOf(ma)), null, 'an unknown conference');
  assert.equal(page.postseasonPlaces(RULES, 'Mid-Atlantic', 'GU12', flightsOf(ma)), null, 'an unknown age');
  assert.equal(page.postseasonPlaces(RULES, 'Mid-Atlantic', 'GU16', flightsOf({ flights: [{ ...ma.flights[0], failed: true }] })), null, 'a failed single table');
  const { fd, post } = placesOf(mw, f => { f[1].standingsError = new Error('503'); return f; });
  assert.deepEqual(labels(fd.slice(0, 1), post), [['CL', 'CL', '', '', '', '', '', '']]);
  assert.equal(post.missing, true);
  assert.match(page.postseasonLegend(post).innerHTML, /Places from either division need both tables/);
});

// ---------- every archived 2026-27 conference table: rules, never counts ----------
const root = new URL('../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('archive/manifest.json', root), 'utf8'));
const standingsFile = (d, ev) => new URL(`archive/api/Event/get-standings-by-div-and-flight/${d.divisionID}/${d.flightID}/${ev.eventId}.json`, root);
test('every archived 2026-27 conference table: exactly min(N, eligible) per rule, contiguous among teams that have played (N6)', () => {
  let tables = 0;
  for (const ev of Object.values(manifest.events)) {
    if (ev.season !== '2026-27' || ev.kind !== 'conference') continue;
    for (const age of [...new Set(ev.divisions.map(d => d.divisionName))]) {
      const ds = ev.divisions.filter(d => d.divisionName === age);
      if (!ds.every(d => existsSync(standingsFile(d, ev)))) continue;
      const fd = ds.map(d => {
        const data = JSON.parse(readFileSync(standingsFile(d, ev), 'utf8')).data;
        const teamStandings = (Array.isArray(data) ? data : [data]).flatMap(b => (b && b.teamStandings) || []).map((t, i) => ({ ...t, _origRank: i + 1 }));
        return { flight: { flightName: d.flightName }, standings: { teamStandings }, standingsError: null };
      });
      const post = page.postseasonPlaces(RULES, ev.name, age, fd);
      const at = `${ev.name} ${age}`;
      assert.ok(post, `${at}: the rules fit`);
      tables += fd.length;
      const played = fd.map(f => f.standings.teamStandings.filter(t => (t.gp || 0) > 0));
      const eligible = played.reduce((n, q) => n + q.length, 0);
      let need = 0;
      for (const r of post.rules) need += r.scope === 'division' ? played.reduce((n, q) => n + Math.min(r.next, q.length), 0) : r.next;
      assert.equal(post.places.size, Math.min(need, eligible), `${at}: exactly min(N, eligible)`);
      for (let k = 0; k < fd.length; k++) {
        for (const t of fd[k].standings.teamStandings) if (!(t.gp > 0)) assert.equal(post.places.has(t.teamID), false, `${at}: a team that has not played`);
        if (fd.length === 1) {   // a single table: placed teams are the first ones that have played, in tier order
          const q = played[0], tags = q.map(t => post.places.get(t.teamID));
          const n = tags.filter(Boolean).length;
          assert.ok(tags.slice(0, n).every(Boolean) && tags.slice(n).every(x => !x), `${at}: contiguous from the top`);
          const order = post.rules.map(r => r.tier);
          let last = 0;
          for (const p of tags.slice(0, n)) { const i = order.indexOf(p.tier, last); assert.ok(i >= last, `${at}: tiers in rule order`); last = i; }
        } else {   // divisions: each division's first 2 that have played are Champions League
          assert.ok(played[k].slice(0, 2).every(t => (post.places.get(t.teamID) || {}).tier === 'CL'), `${at} ${fd[k].flight.flightName}: top 2 CL`);
        }
      }
      for (const l of post.levels) assert.ok(l.a && l.b && l.a !== l.b, `${at}: a tie names two teams`);
    }
  }
  assert.ok(tables >= 60, `only ${tables} tables checked`);
});

// ---------- loading (MF2) ----------
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('getPostseasonRules: other seasons and ?live=1 ask for nothing (B1); a file is kept; a 404 is kept as none; a 503 is forgotten; a 429 waits a minute', async () => {
  const MEMO = between('    // ========== POSTSEASON PLACES (#194) ==========', '    // clubID -> { city, state }');
  const make = live => {
    const calls = [], answers = [];
    const fetchJSON = async path => { calls.push(path); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
    const isRefusal = e => !!e && e.status >= 400 && e.status < 500 && e.status !== 404;
    const isMissing = e => !!e && e.status === 404;
    const api = new Function('LIVE', 'fetchJSON', 'isRefusal', 'isMissing', 'sessionBackAt', MEMO + '\nreturn { getPostseasonRules, POSTSEASON_SEASONS };')(live, fetchJSON, isRefusal, isMissing, 0);
    return { ...api, calls, answers };
  };
  const err = (status, session = 'ok') => Object.assign(new Error(`API error ${status}`), { status, session, sentAt: Date.now() });
  const p = make(false);
  assert.deepEqual(p.POSTSEASON_SEASONS, ['2026-27']);
  assert.equal(await p.getPostseasonRules('2025-26'), null);
  assert.deepEqual(p.calls, [], '2025-26: no request');
  p.answers.push(RULES);
  assert.equal(await p.getPostseasonRules('2026-27'), RULES);
  assert.equal(await p.getPostseasonRules('2026-27'), RULES);
  assert.deepEqual(p.calls, ['seasons/2026-27/postseason'], 'kept for the session');

  const live = make(true);
  assert.equal(await live.getPostseasonRules('2026-27'), null);
  assert.deepEqual(live.calls, [], '?live=1: no request, no places (B1)');

  const missing = make(false);
  missing.answers.push(err(404));
  assert.equal(await missing.getPostseasonRules('2026-27'), null);
  assert.equal(await missing.getPostseasonRules('2026-27'), null);
  assert.equal(missing.calls.length, 1, 'a 404 is kept as none');

  const schema = make(false);
  schema.answers.push({ schema: 2, season: '2026-27', tiers: {}, conferences: {} });
  assert.equal(await schema.getPostseasonRules('2026-27'), null, 'an unknown schema is none');

  const down = make(false);
  down.answers.push(err(503), RULES);
  await assert.rejects(down.getPostseasonRules('2026-27'));
  assert.equal(await down.getPostseasonRules('2026-27'), RULES, 'a 503 is forgotten: the next load asks again');
  assert.equal(down.calls.length, 2);

  const busy = make(false);
  busy.answers.push(err(429), RULES);
  await assert.rejects(busy.getPostseasonRules('2026-27'));
  await assert.rejects(busy.getPostseasonRules('2026-27'));
  assert.equal(busy.calls.length, 1, 'a refusal is remembered for a minute');
});

// loadCurrentView and selectView, the page's own, with held and counted stubs.
function conferencePage() {
  const CODE = [block('    function selectView('), block('    let currentConfMeta = null;', 'async function loadCurrentView(')].join('\n');
  const node = () => ({ style: {}, textContent: '', innerHTML: '' });
  const els = {};
  const T = { rules: 0, renders: [], hierarchy: {}, rulesHold: null, rulesAnswer: RULES, standings: 0 };
  const SEASON_DATA = { conferences: { Midwest: { eventId: 4264 }, 'Mid-Atlantic': { eventId: 4263 } } };
  const hierarchyOf = id => ({ girlsDivAndFlightList: [{ divisionName: 'GU13', divisionID: id * 10, flightList: [{ flightID: id * 100, flightName: 'ECNL' }] }] });
  const stubs = {
    document: { getElementById: id => (els[id] ||= node()) }, currentTab: 'conferences', currentView: 'standings',
    currentSeason: '2026-27', currentConference: 'Mid-Atlantic', currentAgeGroup: 'GU13', AGE_LABELS: {},
    getSeasonData: () => SEASON_DATA, buildBreadcrumb() {}, updateViewTabsUI() {}, clearTeamFilter() {},
    bindMatch() {}, focusMatch() {}, dropMatch() {}, currentFlightData: [], selectedTeamID: null,
    favoriteInDivision: () => false, loadClubPlaces: async () => {}, clubPlaces: null, defaultSelection: () => null,
    getEventHierarchy: async id => { if (T.hierarchy[id]) await T.hierarchy[id].promise; return hierarchyOf(id); },
    getStandings: async () => { T.standings++; return { teamStandings: [{ teamID: 1, gp: 1 }] }; },
    getSchedule: async () => [], isMissing: () => false, retryText: String, esc,
    getPostseasonRules: async () => { T.rules++; if (T.rulesHold) await T.rulesHold.promise; if (T.rulesAnswer instanceof Error) throw T.rulesAnswer; return T.rulesAnswer; },
    saveState() {}, pushHash() {}, selectTeamView() {}, loadPlayoffFlight() {}, loadShowcaseFlight() {},
  };
  let api;
  stubs.renderConferenceView = () => T.renders.push({ conf: api.meta().confName, postseason: api.meta().postseason });
  api = new Function(...Object.keys(stubs), CODE + `
    return { loadCurrentView, selectView, meta: () => currentConfMeta, go: (c, a) => { currentConference = c; currentAgeGroup = a; } };`)(...Object.values(stubs));
  return { ...api, T };
}

test('loadCurrentView: the rules are asked for before the hierarchy answers, and the view is painted once, with them (MF2, B2)', async () => {
  const p = conferencePage();
  p.T.hierarchy[4263] = deferred();
  p.T.rulesHold = deferred();
  const load = p.loadCurrentView();
  await flush();
  assert.equal(p.T.rules, 1, 'asked for beside the tables, while the hierarchy is pending');
  p.T.hierarchy[4263].resolve();
  await flush();
  assert.equal(p.T.standings, 1, 'the tables are in');
  assert.equal(p.T.renders.length, 0, 'and wait for the rules');
  p.T.rulesHold.resolve();
  await load;
  assert.deepEqual(p.T.renders, [{ conf: 'Mid-Atlantic', postseason: RULES }], 'one paint, with the rules');
  // Standings -> Matches -> Standings is a re-render: no load, no rules request.
  p.selectView('schedule'); p.selectView('standings');
  assert.equal(p.T.rules, 1);
  assert.equal(p.T.renders.length, 3);
});

test('loadCurrentView: rules that arrive after a navigation paint nothing; the new view paints once', async () => {
  const p = conferencePage();
  p.T.rulesHold = deferred();
  const first = p.loadCurrentView();
  await flush();
  p.go('Midwest', 'GU13');
  p.T.hierarchy[4264] = deferred();
  const second = p.loadCurrentView();
  p.T.rulesHold.resolve();
  await first;
  await flush();
  assert.equal(p.T.renders.length, 0, 'the superseded load painted nothing');
  p.T.hierarchy[4264].resolve();
  await second;
  assert.deepEqual(p.T.renders, [{ conf: 'Midwest', postseason: RULES }]);
});

test('loadCurrentView: a rules failure still paints the tables once, with no places', async () => {
  const p = conferencePage();
  p.T.rulesAnswer = Object.assign(new Error('API error 503'), { status: 503 });
  await p.loadCurrentView();
  assert.deepEqual(p.T.renders, [{ conf: 'Mid-Atlantic', postseason: null }]);
});

// ---------- colours (Q9) and the selected row (MF1) ----------
test('every tier\'s ink reaches 4.5:1 on its tint in both themes; the selected-row stripe and tint are unchanged (MF1)', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = theme => {
    const m = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, theme);
    return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(x => [x[1], x[2].trim()]));
  };
  const rgb = c => { const m = /^#([0-9a-f]{6})$/i.exec(c); assert.ok(m, c); const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const lum = c => { const [r, g, b] = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const theme of ['light', 'dark']) {
    const tk = tokens(theme);
    for (const tier of ['cl', 'pi', 'nac', 'sc']) {
      const r = ratio(rgb(tk[`--pos-${tier}-ink`]), rgb(tk[`--pos-${tier}-bg`]));
      assert.ok(r >= 4.5, `${theme} ${tier}: ${r.toFixed(2)}:1`);
    }
  }
  for (const tier of ['cl', 'pi', 'nac', 'sc']) assert.match(css, new RegExp(`\\.pos-${tier} \\{ --pos-bg: var\\(--pos-${tier}-bg\\); --pos-ink: var\\(--pos-${tier}-ink\\); \\}`));
  assert.match(css, /\.team-row-highlight td \{ background: var\(--accent-surface\) !important; \}/);
  assert.match(css, /\.team-row-highlight td:first-child \{ box-shadow: inset 3px 0 0 var\(--accent\); \}/);
  assert.doesNotMatch(css, /pos-[\w-]*[^{]*\{[^}]*box-shadow/, 'no tier bar on the row edge');
  assert.doesNotMatch(css, /pos-[\w-]*[^{]*\{[^}]*!important/, 'the tier cues never override the selection');
});

test('index.html stays LF only', () => {
  assert.equal(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('\r'), false);
});
