// #135 P1a: the landing page and its routing. A bare URL with no saved place is the landing page
// (it loads nothing more and saves nothing); a saved place resumes as before (variant A); "ECNL
// Girls" and an empty hash show it; leaving it adds one history entry; Continue is a cold resume
// of the saved place; #season=X alone is the Teams index. The page's own code (public/index.html),
// extracted block by block as in tests/conference-return.test.mjs, against a fake DOM, a fake
// history and storage, and the real catalog (public/data/sources.json) where data matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CATALOG = JSON.parse(readFileSync(new URL('../public/data/sources.json', import.meta.url), 'utf8'));
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const line = head => block(head, head, '\n');
const CODE = [
  block('    let AGE_GROUPS = [];', 'let showcaseAliases', '\n'),          // the page's state
  line('    let favoriteMeta = new Map();'), line('    let currentFavorite = null;'),
  line('    let loadToken = 0;'), line('    let showcaseToken = 0;'),
  line('    function getSeasonData()'),
  block('    function saveState('), block('    function loadSavedState('), block('    function loadFavorites('),
  block('    function pushHash('), block('    function loadFromHash('),
  block("    window.addEventListener('hashchange'", "window.addEventListener('hashchange'", '\n    });\n'),
  block('    const TOP_TABS = ', 'function closeMyTeams('), block('    function switchTab('),
  block('    async function loadAgeGroupsForSeason('), block('    function syncSeasonUI('),
  block('    async function changeSeason('), block('    async function rebuildAll('),
  block('    function goHome('),
  block('    function eventContext('), block('    function favoriteLabel('), block('    function sortedFavorites('),
  block("    document.addEventListener('keydown', (e) => {", "document.addEventListener('keydown'", '\n    });\n'),
  block('    // ========== LANDING (#135 P1a)', 'async function renderTeamsIndex('),
  block('    async function initPage('),
  // The views behind the routes, as the page's loaders behave for routing: each paints, then
  // saves its place and writes its hash. A conference table honours loadToken (#99/#102).
  `function loadStandings() { return loadCurrentView(); }
   async function loadCurrentView() {
     const token = ++loadToken;
     T.loads.push('table:' + currentSeason + '/' + currentConference + '/' + currentAgeGroup);
     const h = T.hold.table; if (h) { delete T.hold.table; await h.promise; }
     if (token !== loadToken) return;
     document.getElementById('standingsContainer').innerHTML = 'TABLE ' + currentConference + ' ' + currentAgeGroup;
     saveState(); pushHash();
   }
   async function loadPlayoffsPanel() { T.loads.push('playoffs:' + currentSeason); document.getElementById('standingsContainer').innerHTML = 'PLAYOFFS'; saveState(); pushHash(); }
   async function loadShowcasesPanel() { T.loads.push('showcases:' + currentSeason); document.getElementById('standingsContainer').innerHTML = 'SHOWCASES'; saveState(); pushHash(); }
   function openFavoritesTab() {
     const rec = previewTeam || favoriteMeta.get(currentFavorite) || null;
     T.loads.push('team:' + (rec && rec.name) + ':' + teamView);
     document.getElementById('standingsContainer').innerHTML = 'TEAM ' + (rec && rec.name);
     saveState(); pushHash();
   }
   SHOWCASES = Object.fromEntries(Object.entries(SEASONS).filter(([, d]) => d.showcases).map(([s, d]) => [s, d.showcases]));`,
].join('\n');

const STATE_KEY = 'ecnl-dash-v2-state', FAV_KEY = 'ecnl-dash-v2-favorites';
const S0 = Object.keys(CATALOG.seasons)[0];
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(y => { resolve = y; }); return { promise, resolve }; };

// A page. `saved`: the saved place; `favs`: followed records; `hash`, `search`, `state`: the address
// and the history entry it opens on; `seasons`: a catalog other than the real one.
function page({ saved = null, favs = null, hash = '', search = '', state = null, seasons = CATALOG.seasons, escape = s => String(s) } = {}) {
  const T = { loads: [], hold: {}, focused: null, sheetClosed: 0, searchFocus: 0, titleFocus: 0, picks: [], clicks: [], history: [], writes: [], drawerClosed: 0 };
  const els = new Map();
  const node = id => {
    const cls = new Set(), attrs = {};
    return {
      id, style: {}, hidden: id === 'landing', textContent: '', innerHTML: '', value: '', tabIndex: 0,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c), contains: c => cls.has(c) },
      setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: k => { delete attrs[k]; }, getAttribute: k => attrs[k] ?? null,
      focus: () => { T.focused = id; if (id === 'contentTitle') T.titleFocus++; }, click: () => T.clicks.push(id),
      matches: () => false, closest: () => null, append() {}, appendChild() {}, querySelector: () => null,
    };
  };
  const el = id => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); };
  const listeners = {};
  const document = {
    getElementById: el, body: el('body'), createElement: () => node(),
    querySelector: sel => (sel === '.section-label' ? el('sectionLabel') : null), querySelectorAll: () => [],
    addEventListener: (t, f) => { listeners['doc:' + t] = f; },
  };
  const location = { hash, pathname: '/', search, host: 'ecnl.test' };
  const setUrl = url => { const i = url.indexOf('#'); location.hash = i >= 0 ? url.slice(i) : ''; };
  const history = {
    state,
    pushState: (s, _t, url) => { T.history.push(['push', s, url]); history.state = s; setUrl(url); },
    replaceState: (s, _t, url) => { T.history.push(['replace', s, url]); history.state = s; setUrl(url); },
  };
  const store = {};
  if (saved) store[STATE_KEY] = JSON.stringify(saved);
  if (favs) store[FAV_KEY] = JSON.stringify(favs);
  const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { T.writes.push(k); store[k] = v; } };
  const stubs = {
    T, document, window: { location, addEventListener: (t, f) => { listeners[t] = f; } }, location, history, localStorage,
    SEASONS: seasons, SOURCES: { seasons }, NATIONAL_EVENTS: {}, LIVE: false,
    getAgeLabel: d => d, birthYearLabel: () => '', seasonLabel: s => s, esc: escape, displayName: n => n, sortAgeGroups: x => x,
    getEventHierarchy: async () => { throw new Error('no hierarchy request on these routes'); },
    buildAgeGroupTabs() {}, buildConferenceList() {}, buildFavoritesList() {}, updateMyTeamsCount() {},
    loadTheme() {}, loadSidebarState() {}, purgeLegacyCache() {}, loadSources: async () => {}, loadRefreshState: async () => {}, setObserved() {},
    usClose() {}, closeSidebarIfMobile: () => { T.drawerClosed++; }, toggleSidebar() {}, focusTeamSearch: () => { T.searchFocus++; },
    closeTeamSheet: () => { T.sheetClosed++; }, focusContentTitle: () => el('contentTitle').focus(),
    selectAgeGroup: a => T.picks.push('age:' + a), selectConference: c => T.picks.push('conf:' + c), retryText: () => 'try again',
    isPhone: () => false,
  };
  const api = new Function(...Object.keys(stubs), CODE + `
    return { initPage, loadFromHash, pushHash, saveState, switchTab, changeSeason, showLanding, continueSaved, goHome, renderTeamsIndex,
      LANDING_HEADING,
      state: () => ({ tab: currentTab, view: currentView, season: currentSeason, age: currentAgeGroup, conf: currentConference,
        team: selectedTeamID, sched: scheduleFilter, more: showMoreStats, fav: currentFavorite, preview: previewTeam && previewTeam.name,
        teamView, stage: currentPlayoffStage, pAge: currentPlayoffAgeGroup, tier: currentPlayoffTier,
        showcase: currentShowcase, sAge: currentShowcaseAge, flight: currentShowcaseFlight }),
      flags: () => ({ landingOpen, teamsIndex }), ages: () => AGE_GROUPS.slice(), usGoTo: h => { location.hash = h; } };`)(...Object.values(stubs));
  const p = {
    ...api, T, store, el, history, location,
    init: async () => { await api.initPage(); await flush(); },
    fire: async h => { location.hash = h; listeners.hashchange(); await flush(); },
    back: async h => { location.hash = h; listeners.hashchange(); await flush(); },   // Back/Forward to an entry with hash h
    home: async () => { api.goHome({ currentTarget: { host: location.host }, preventDefault() {} }); await flush(); },
    key: (key, target = node('x')) => listeners['doc:keydown']({ key, target, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false }),
    shown: () => el('standingsContainer').innerHTML,
    onLanding: () => el('body').classList.contains('route-landing') && !el('landing').hidden,
    landingHtml: () => el('landing').innerHTML,
    saved: () => JSON.parse(store[STATE_KEY] || 'null'),
    pushes: () => T.history.filter(h => h[0] === 'push'),
  };
  return p;
}

// Saved places of every kind, from the real catalog.
const seasonsWithShowcases = Object.keys(CATALOG.seasons).filter(s => Object.keys(CATALOG.seasons[s].showcases || {}).length);
const SC_SEASON = seasonsWithShowcases[0];
const [SC_NAME, SC] = Object.entries(CATALOG.seasons[SC_SEASON].showcases)[0];
const CONF = Object.keys(CATALOG.seasons[S0].conferences)[4];
const AGE = Object.keys(CATALOG.seasons[S0].ageGroups)[1];
const FOLLOWED = { name: 'MVLA ECNL G2008/09', teamID: 33438, clubName: 'MVLA', eventID: CATALOG.seasons[S0].conferences[CONF].eventId };
const PLACES = {
  conference: { season: S0, ageGroup: AGE, conference: CONF, view: 'schedule', tab: 'conferences', sched: 'results', team: 77, moreStats: true },
  playoffs: { season: seasonsWithShowcases[0], tab: 'playoffs', stage: 'Playoffs & Finals', playoffAgeGroup: 'G2011', tier: 5, ageGroup: AGE, conference: CONF },
  showcases: { season: SC_SEASON, tab: 'showcases', showcase: SC.eventId, showcaseAge: 'G2011', ageGroup: AGE, conference: CONF },
  'followed team (season tab)': { season: S0, tab: 'favorites', favorite: FOLLOWED.name, teamPage: { teamID: FOLLOWED.teamID, name: FOLLOWED.name, view: 'season' } },
  'team page not followed': { season: S0, tab: 'favorites', favorite: null, teamPage: { teamID: 55477, name: 'PDA Blue ECNL G2009', view: 'history' } },
};

// ---------- the landing page

test('#135 P1a: a new visitor\'s bare URL is the landing page: nothing loaded, nothing saved, one marked entry', async () => {
  const p = page();
  await p.init();
  assert.ok(p.onLanding());
  assert.deepEqual(p.T.loads, []);
  assert.deepEqual(p.T.writes, []);
  assert.deepEqual(p.T.history, [['replace', { landing: 1 }, '/']]);
  assert.equal(p.LANDING_HEADING, 'ECNL Girls team and event.');
  assert.match(p.landingHtml(), new RegExp(`<h1 id="landTitle" tabindex="-1">${p.LANDING_HEADING.replace('.', '\\.')}</h1>`));
  assert.equal(p.el('sectionLabel').getAttribute('aria-current'), 'page');
  // The cards are links with their own names: the Teams index and the newest season's Playoffs.
  assert.match(p.landingHtml(), new RegExp(`<a class="land-card" href="#season=${encodeURIComponent(S0)}" aria-labelledby="landTeamsT" aria-describedby="landTeamsD landTeamsC">`));
  assert.match(p.landingHtml(), new RegExp(`<a class="land-card" href="#tab=playoffs&season=${encodeURIComponent(S0)}" aria-labelledby="landEventsT" aria-describedby="landEventsD landEventsC">`));
  for (const id of ['landTeamsT', 'landTeamsD', 'landTeamsC', 'landEventsT', 'landEventsD', 'landEventsC']) assert.ok(p.landingHtml().includes(`id="${id}"`), id);
  assert.ok(!p.landingHtml().includes('Welcome back'), 'nothing to continue');
});

test('#135 P1a: on the landing page saveState and pushHash are inert, whoever calls them (a late load, a star, a sheet)', async () => {
  // Reached from Playoffs, so the tab is not Conferences: only the landing guard holds.
  const p = page({ hash: `#tab=playoffs&season=${SC_SEASON}` });
  await p.init();
  await p.home();
  const before = p.store[STATE_KEY], writes = p.T.writes.length, entries = p.T.history.length;
  p.saveState();
  p.pushHash();
  assert.equal(p.store[STATE_KEY], before);
  assert.equal(p.T.writes.length, writes);
  assert.equal(p.location.hash, '');
  assert.equal(p.T.history.length, entries);
});

test('#135 P1a: the cards\' counts come from the catalog (teamCount, conferences, the newest season with events)', async () => {
  const p = page();
  await p.init();
  const s = CATALOG.seasons[S0];
  const confs = Object.keys(s.conferences).length;
  const count = Number.isInteger(s.teamCount) ? ` · ${s.teamCount.toLocaleString('en-US')} teams in ${S0}` : '';
  assert.ok(p.landingHtml().includes(`<b>${confs} conferences</b>${count}<`), 'Teams count');
  const evSeason = Object.keys(CATALOG.seasons).find(x => Object.keys(CATALOG.seasons[x].national || {}).length || Object.keys(CATALOG.seasons[x].showcases || {}).length);
  const sc = Object.keys(CATALOG.seasons[evSeason].showcases || {}).length;
  assert.ok(p.landingHtml().includes(`<b>${evSeason}:</b> ${[Object.keys(CATALOG.seasons[evSeason].national || {}).length ? 'Playoffs & Finals' : '', sc ? `${sc} showcase${sc === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`), 'Events count');
  // A catalog without teamCount shows no team count, and no invented number.
  const bare = JSON.parse(JSON.stringify(CATALOG.seasons));
  for (const x of Object.values(bare)) delete x.teamCount;
  const q = page({ seasons: bare });
  await q.init();
  assert.ok(!/teams in/.test(q.landingHtml()));
});

test('#135 P1a: the committed catalog has a teamCount for its newest season (the landing page\'s Teams card)', () => {
  assert.ok(Number.isInteger(CATALOG.seasons[S0].teamCount) && CATALOG.seasons[S0].teamCount > 0);
});

for (const [kind, saved] of Object.entries(PLACES)) {
  test(`#135 P1a (variant A): a returning visitor's bare URL resumes the saved place, ${kind}`, async () => {
    const p = page({ saved, favs: [FOLLOWED] });
    await p.init();
    assert.ok(!p.onLanding());
    assert.equal(p.T.loads.length, 1, p.T.loads.join());
    const st = p.state();
    assert.equal(st.tab, saved.tab);
    assert.equal(st.season, saved.season);
    if (kind === 'conference') assert.deepEqual([st.conf, st.age, st.sched, st.view, st.more, st.team], [CONF, AGE, 'results', 'schedule', true, 77]);
    if (kind === 'showcases') assert.deepEqual([st.showcase, st.sAge], [SC.eventId, 'G2011']);
    if (kind.startsWith('followed')) assert.deepEqual([st.fav, st.preview, st.teamView], [FOLLOWED.name, null, 'season']);
    if (kind === 'team page not followed') assert.deepEqual([st.fav, st.preview, st.teamView], [null, 'PDA Blue ECNL G2009', 'history']);
  });
}

test('#135 P1a (S2): a reload of a landing entry shows the landing page even with a saved place', async () => {
  const p = page({ saved: PLACES.conference, state: { landing: 1 } });
  await p.init();
  assert.ok(p.onLanding());
  assert.deepEqual(p.T.loads, []);
  assert.ok(p.landingHtml().includes(`Continue: ${CONF} · ${AGE} · ${S0} →`));
});

test('#135 P1a (S3): an unusable hash on a first visit is the landing page and saves nothing; with a saved place it resumes', async () => {
  for (const hash of ['#foo', '#season=1999-00', '#season=']) {
    const p = page({ hash });
    await p.init();
    assert.ok(p.onLanding(), hash);
    assert.deepEqual([p.T.loads, p.T.writes, p.location.hash], [[], [], ''], hash);
    const q = page({ hash, saved: PLACES.conference });
    await q.init();
    assert.ok(!q.onLanding(), hash);
    assert.equal(q.state().conf, CONF);
  }
});

test('#135 P1a: corrupted saved state is no place: the landing page, no Continue', async () => {
  for (const raw of ['not json', 'null', '[]', '"x"', JSON.stringify({ season: '1999-00' })]) {
    const p = page();
    p.store[STATE_KEY] = raw;
    await p.init();
    assert.ok(p.onLanding(), raw);
    assert.ok(!p.landingHtml().includes('Continue'), raw);
  }
});

test('#135 P1a (S4): an old name-only favourite shows on the landing page without a "not located" label', async () => {
  const p = page({ saved: PLACES.conference, state: { landing: 1 }, favs: ['Sting Royal ECNL G2008/09'] });
  await p.init();
  assert.ok(p.landingHtml().includes('★ Sting Royal ECNL G2008/09</a>'));
  assert.ok(!p.landingHtml().includes('not located'));
});

// ---------- leaving and returning

test('#135 P1a: leaving by a card adds one entry, focuses the new view, and Back walks back to the landing page', async () => {
  const p = page();
  await p.init();
  await p.fire(`#season=${S0}`);                        // the Teams card (a link: the browser adds the entry)
  assert.ok(!p.onLanding());
  assert.deepEqual(p.flags(), { landingOpen: false, teamsIndex: true });
  assert.equal(p.T.titleFocus, 1, 'S1: focus moves to the new view');
  await p.fire(`#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}`);   // a grid cell
  assert.equal(p.shown(), `TABLE ${CONF} ${AGE}`);
  assert.equal(p.T.titleFocus, 2);
  assert.equal(p.saved().conference, CONF);
  assert.equal(p.pushes().length, 0, 'links, not pushState');
  await p.back(`#season=${S0}`);
  assert.ok(p.shown().includes('class="tix"'));
  await p.back('');
  assert.ok(p.onLanding());
  assert.equal(p.T.focused, 'landTitle');
});

test('#135 P1a: "ECNL Girls" pushes one marked entry (none when already there) and keeps ?live=1', async () => {
  const p = page({ hash: `#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}`, search: '?live=1' });
  await p.init();
  assert.ok(!p.onLanding());
  await p.home();
  assert.ok(p.onLanding());
  assert.deepEqual(p.pushes(), [['push', { landing: 1 }, '/?live=1']]);
  assert.equal(p.T.focused, 'landTitle');
  await p.home();
  assert.equal(p.pushes().length, 1, 'no second entry');
  assert.equal(p.saved().conference, CONF, 'the landing page keeps the saved place as it was');
});

test('#135 P1a (RM3, RM4): leaving for the landing page closes the sheet and drops a table still loading', async () => {
  const p = page({ hash: `#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}` });
  await p.init();
  const writes = p.T.writes.length;
  const held = deferred();
  p.T.hold.table = held;
  const other = Object.keys(CATALOG.seasons[S0].ageGroups)[0];
  await p.fire(`#season=${S0}&age=${encodeURIComponent(other)}&conf=${encodeURIComponent(CONF)}`);
  const sheets = p.T.sheetClosed;
  await p.back('');
  assert.ok(p.onLanding());
  assert.ok(p.T.sheetClosed > sheets, 'RM3: the sheet is closed');
  held.resolve(); await flush();
  assert.notEqual(p.shown(), `TABLE ${CONF} ${other}`, 'RM4: the late answer paints nothing');
  assert.equal(p.T.writes.length, writes, 'and saves nothing');
  assert.equal(p.location.hash, '');
});

// ---------- Continue (M2)

for (const [kind, saved] of Object.entries(PLACES)) {
  test(`#135 P1a (M2): Continue is a cold resume of the saved place from a different live state, ${kind}`, async () => {
    // The cold resume, for comparison.
    const cold = page({ saved, favs: [FOLLOWED] });
    await cold.init();
    // A warm page somewhere else: another tab, team view, showcase flight and season.
    const p = page({ saved, favs: [FOLLOWED], hash: kind === 'showcases'
      ? `#tab=teams&season=${S0}&team=${FOLLOWED.teamID}&name=${encodeURIComponent(FOLLOWED.name)}&view=season`
      : `#tab=showcases&season=${SC_SEASON}&event=${SC.eventId}&age=G2012&flight=999&view=schedule` });
    await p.init();
    p.store[STATE_KEY] = JSON.stringify(saved);          // its saved place is the other one
    await p.home();
    assert.ok(p.landingHtml().includes('Continue: '));
    const before = p.T.history.length;
    await p.continueSaved();
    await flush();
    assert.ok(!p.onLanding());
    assert.deepEqual(p.state(), cold.state());
    assert.equal(p.location.hash, cold.location.hash);
    const after = p.T.history.slice(before);
    assert.deepEqual(after.filter(h => h[0] === 'push'), [['push', null, '/']], 'one new entry');
    assert.equal(p.T.focused, 'contentTitle');
  });
}

test('#135 P1a: Continue labels name the saved place', async () => {
  const want = {
    conference: `${CONF} · ${AGE} · ${S0}`, playoffs: `Playoffs & Finals · ${PLACES.playoffs.season}`,
    showcases: `${SC_NAME} · ${SC_SEASON}`, 'followed team (season tab)': `${FOLLOWED.name} · My Teams`,
    'team page not followed': `PDA Blue ECNL G2009 · ${S0}`,
  };
  for (const [kind, saved] of Object.entries(PLACES)) {
    const p = page({ saved, favs: [FOLLOWED], state: { landing: 1 } });
    await p.init();
    assert.ok(p.landingHtml().includes(`Continue: ${want[kind]} →`), kind);
  }
});

// ---------- the Teams index

for (const season of Object.keys(CATALOG.seasons)) {
  test(`#135 P1a: #season=${season} alone is the Teams index: every conference x age group, nothing saved`, async () => {
    const p = page({ hash: `#season=${season}` });
    await p.init();
    assert.deepEqual(p.T.loads, [], 'no table request');
    assert.deepEqual(p.T.writes, [], 'nothing saved');
    assert.equal(p.location.hash, `#season=${season}`);
    const confs = Object.keys(CATALOG.seasons[season].conferences), ages = Object.keys(CATALOG.seasons[season].ageGroups);
    assert.deepEqual(p.ages(), ages);
    const hrefs = [...p.shown().matchAll(/<a href="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(hrefs, confs.flatMap(c => ages.map(a => `#season=${encodeURIComponent(season)}&age=${encodeURIComponent(a)}&conf=${encodeURIComponent(c)}`)));
    // Each cell opens its table.
    const [c, a] = [confs.at(-1), ages.at(-1)];
    await p.fire(`#season=${encodeURIComponent(season)}&age=${encodeURIComponent(a)}&conf=${encodeURIComponent(c)}`);
    assert.deepEqual([p.state().season, p.state().conf, p.state().age, p.flags().teamsIndex], [season, c, a, false]);
    assert.equal(p.shown(), `TABLE ${c} ${a}`);
  });
}

test('#135 P1a: the index keeps its place across a season change and a tab round trip, and rewrites #season=X&view=…', async () => {
  const [s1, s2] = Object.keys(CATALOG.seasons);
  const p = page({ hash: `#season=${s1}&view=schedule` });
  await p.init();
  assert.equal(p.location.hash, `#season=${s1}`);
  await p.changeSeason(s2); await flush();
  assert.ok(p.shown().includes('class="tix"'));
  assert.equal(p.location.hash, `#season=${s2}`);
  p.switchTab('playoffs'); await flush();
  p.switchTab('conferences'); await flush();
  assert.ok(p.shown().includes('class="tix"'), 'back to the index, not a blank pane');
  assert.deepEqual(p.T.writes.filter(k => k === STATE_KEY).length, 1, 'only Playoffs saved');
});

test('#135 P1a (S10): Conferences after the landing page\'s Events card is the index, not a default table', async () => {
  const p = page();
  await p.init();
  await p.fire(`#tab=playoffs&season=${S0}`);
  p.switchTab('conferences'); await flush();
  assert.ok(p.shown().includes('class="tix"'));
  assert.ok(!p.T.loads.some(l => l.startsWith('table:')));
});

// ---------- M1: the index flag never leaks into another tab

const leaves = {
  Playoffs: async p => { p.switchTab('playoffs'); await flush(); },
  Showcases: async p => { p.switchTab('showcases'); await flush(); },
  'My Teams': async p => { p.switchTab('favorites'); await flush(); },
  'a search result (team link)': async p => { await p.fire(`#tab=teams&season=${S0}&team=33438&name=${encodeURIComponent('MVLA ECNL G2008/09')}`); },
};
for (const [where, leave] of Object.entries(leaves)) {
  test(`#135 P1a (M1): leaving the index for ${where} saves that place, and Enter works there`, async () => {
    const p = page({ hash: `#season=${S0}`, favs: [FOLLOWED] });
    await p.init();
    assert.equal(p.saved(), null);
    await leave(p);
    assert.notEqual(p.saved(), null, 'the new place is saved');
    assert.notEqual(p.saved().tab, 'conferences');
    if (where.startsWith('a search')) assert.equal(p.flags().teamsIndex, false, 'a team link leaves the index');
    const li = { matches: s => s === 'li[tabindex]', closest: () => null, click() { this.clicked = true; } };
    p.key('Enter', li);
    assert.ok(li.clicked, 'Enter on a list item works');
    // ... and Continue later opens this place, not the index or another tab.
    const tab = p.saved().tab;
    await p.home();
    await p.continueSaved(); await flush();
    assert.equal(p.state().tab, tab);
  });
}

test('#135 P1a: the arrow keys do nothing on the landing page or the index; "/" opens the search', async () => {
  for (const hash of ['', `#season=${S0}`]) {
    const p = page({ hash });
    await p.init();
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) p.key(k);
    await flush();
    assert.deepEqual([p.T.picks, p.T.loads, p.T.writes], [[], [], []], hash || 'landing');
    p.key('/');
    assert.equal(p.T.searchFocus, 1);
  }
});

// ---------- deep links, unchanged

test('#135 P1a: deep links open as before (and never the index)', async () => {
  const cases = [
    [`#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}&view=schedule&team=7&sched=all`,
      { tab: 'conferences', conf: CONF, age: AGE, view: 'schedule', team: 7, sched: 'all' }],
    [`#season=${S0}&team=7`, { tab: 'conferences', team: 7, conf: Object.keys(CATALOG.seasons[S0].conferences)[0] }],
    [`#tab=playoffs&season=${SC_SEASON}&stage=Playoffs&age=G2011&tier=5`, { tab: 'playoffs', stage: 'Playoffs', pAge: 'G2011', tier: 5 }],
    [`#tab=showcases&season=${SC_SEASON}&event=${SC.eventId}&age=G2011&flight=9`, { tab: 'showcases', showcase: SC.eventId, sAge: 'G2011', flight: 9 }],
    [`#tab=teams&season=${S0}&team=55477&name=PDA&view=season`, { tab: 'favorites', preview: 'PDA', teamView: 'season' }],
    [`#tab=myteams&season=${S0}&team=55477&name=PDA`, { tab: 'favorites', preview: 'PDA', teamView: 'history' }],
  ];
  for (const [hash, want] of cases) {
    const p = page({ hash });
    await p.init();
    const st = p.state();
    for (const [k, v] of Object.entries(want)) assert.equal(st[k], v, `${hash}: ${k}`);
    assert.equal(p.flags().teamsIndex, false, hash);
    assert.ok(!p.onLanding(), hash);
  }
});

test('#135 P1a: a team page that is not followed is saved and comes back as itself (cold and Continue)', async () => {
  const p = page({ hash: `#tab=teams&season=${S0}&team=55477&name=${encodeURIComponent('PDA Blue ECNL G2009')}&view=season` });
  await p.init();
  assert.deepEqual(p.saved().teamPage, { teamID: 55477, name: 'PDA Blue ECNL G2009', view: 'season' });
  const cold = page({ saved: p.saved() });
  await cold.init();
  assert.deepEqual([cold.state().tab, cold.state().preview, cold.state().teamView], ['favorites', 'PDA Blue ECNL G2009', 'season']);
  assert.equal(cold.location.hash, p.location.hash);
  await p.home();
  await p.continueSaved(); await flush();
  assert.equal(p.location.hash, cold.location.hash);
});

// ---------- PR #142 review: MF2, SC1, SC3, SC4

const NORCAL = `#season=${S0}&age=${encodeURIComponent(AGE)}&conf=${encodeURIComponent(CONF)}`;
test('#135 P1a (PR #142 MF2): a table chosen in this page survives the landing page: ECNL Girls → Events card → Conferences', async () => {
  const p = page({ hash: NORCAL });
  await p.init();
  await p.home();
  await p.fire(`#tab=playoffs&season=${S0}`);             // the Events card
  p.switchTab('conferences'); await flush();
  assert.equal(p.shown(), `TABLE ${CONF} ${AGE}`);
  assert.equal(p.flags().teamsIndex, false);
});

test('#135 P1a (PR #142 MF2): NorCal → Playoffs → ECNL Girls → Back → Conferences is NorCal again', async () => {
  const p = page({ hash: NORCAL });
  await p.init();
  p.switchTab('playoffs'); await flush();
  await p.home();
  await p.back(`#tab=playoffs&season=${S0}`);             // Back to the Playoffs entry
  p.switchTab('conferences'); await flush();
  assert.equal(p.shown(), `TABLE ${CONF} ${AGE}`);
});

test('#135 P1a (PR #142 MF2): with no table chosen, Conferences after the landing page is still the index (new visitor, and index → Playoffs → ECNL Girls → Back)', async () => {
  const p = page({ hash: `#season=${S0}` });
  await p.init();
  p.switchTab('playoffs'); await flush();
  await p.home();
  await p.back(`#tab=playoffs&season=${S0}`);
  p.switchTab('conferences'); await flush();
  assert.ok(p.shown().includes('class="tix"'));
});

test('#135 P1a (PR #142 R7): on a landing page reached from a table the arrow keys write and load nothing', async () => {
  const p = page({ hash: NORCAL });
  await p.init();
  await p.home();
  assert.equal(p.flags().teamsIndex, false, 'only landingOpen guards here');
  const loads = p.T.loads.length, writes = p.T.writes.length;
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) p.key(k);
  await flush();
  assert.deepEqual([p.T.picks, p.T.loads.length, p.T.writes.length], [[], loads, writes]);
});

test('#135 P1a (PR #142 SC3): the landing page closes the phone drawer', async () => {
  const p = page({ hash: NORCAL });
  await p.init();
  const before = p.T.drawerClosed;
  await p.back('');
  assert.ok(p.T.drawerClosed > before);
});

test('#135 P1a (PR #142 R3, R4): names on the landing page are escaped (Continue label, followed-team pills)', async () => {
  const realEsc = new Function(block('    function esc(') + '\nreturn esc;')();
  const evil = '<img src=x onerror=alert(1)>';
  const p = page({ saved: { season: S0, tab: 'favorites', teamPage: { teamID: 55477, name: evil, view: 'history' } },
    favs: [{ name: evil + ' 2', teamID: 1, eventID: FOLLOWED.eventID }], state: { landing: 1 }, escape: realEsc });
  await p.init();
  assert.ok(!p.landingHtml().includes('<img src=x'));
  assert.ok(p.landingHtml().includes('Continue: &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(p.landingHtml().includes('★ &lt;img src=x onerror=alert(1)&gt; 2'));
});

test('#135 P1a (PR #142 R6, R11, R17, R20): the index shows its caption and named cells; leaving it shows the sidebar lists, and aria-current leaves ECNL Girls', async () => {
  const p = page();
  await p.init();
  assert.equal(p.el('sectionLabel').getAttribute('aria-current'), 'page');
  await p.fire(`#season=${S0}`);
  assert.equal(p.el('sectionLabel').getAttribute('aria-current'), null, 'R11');
  assert.ok(p.shown().includes(`<caption class="sr-only">Conference tables by age group, ${S0}</caption>`), 'R20');
  assert.ok(p.shown().includes(`aria-label="${CONF} ${AGE}"`), 'R17');
  assert.ok(p.el('conferencesPanel').classList.contains('on-index'));
  await p.fire(NORCAL);
  assert.ok(!p.el('conferencesPanel').classList.contains('on-index'), 'R6: the sidebar lists come back');
});

test('#135 P1a (PR #142 R13): index → a search result → Conferences tab is the index, not a blank pane', async () => {
  const p = page({ hash: `#season=${S0}` });
  await p.init();
  await p.fire(`#tab=teams&season=${S0}&team=33438&name=${encodeURIComponent('MVLA ECNL G2008/09')}`);
  assert.equal(p.flags().teamsIndex, false);
  p.switchTab('conferences'); await flush();
  assert.ok(p.shown().includes('class="tix"'));
});

test('#135 P1a (PR #142 SC4): a teamCount of 0 shows no count', async () => {
  const zero = JSON.parse(JSON.stringify(CATALOG.seasons));
  zero[S0].teamCount = 0;
  const p = page({ seasons: zero });
  await p.init();
  assert.ok(!/teams in/.test(p.landingHtml()));
  await p.fire(`#season=${S0}`);
  assert.ok(!/ teams$/.test(p.el('contentSubtitle').textContent));
});

test('#146: competition search standings hash clears team filter and playoff context through the real router', async () => {
  for (const start of [
    '#tab=teams&season=2026-27&team=95449&name=Bay%20Area%20Surf',
    '#tab=playoffs&season=2025-26&stage=Playoffs%20%26%20Finals&age=G2011&tier=CL&team=95449'
  ]) {
    const p = page({ hash: start }); await p.init();
    await p.fire('#season=2026-27&age=GU15&conf=NorCal&view=standings');
    const s = p.state();
    assert.equal(s.tab, 'conferences'); assert.equal(s.view, 'standings');
    assert.equal(s.season, '2026-27'); assert.equal(s.age, 'GU15'); assert.equal(s.conf, 'NorCal');
    assert.equal(s.team, null);
    assert.match(p.shown(), /TABLE NorCal GU15/);
    assert.equal(p.saved().selectedTeamID, undefined);
    assert.ok(!p.location.hash.includes('team='));
  }
});
