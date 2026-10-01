// #127: the team page's Overview lists its seasons, its Playoffs and Finals and its showcases
// newest first; the chart and each row's form stay oldest to newest, left to right. The page's
// own renderer (public/index.html, renderTeamHistory), extracted as in tests/team-view.test.mjs,
// run against a fake DOM on real history files. Every fixture is found by scanning the files for
// the property it tests (review M1: no fixture that a routine data refresh can invalidate), and
// every expected order is derived from the file, never from the renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
// historyYears … historyOutcome (the real words for the best-finish tile), the "One TGS id"
// notes, the chart and the renderer itself, with the form-chip helpers (#128).
const CODE = [
  block('    function shortTeamName('), block('    function displayName('),
  block('    // #128: form chips that show their game.', 'function chipGames('),
  block('    function historyYears(', 'function historyOutcome('),
  block('    function historySplitNotes('), block('    function historyChartSvg('),
  block('    function renderTeamHistory('),
].join('\n');

const DIR = new URL('../public/archive/history/', import.meta.url);
const hasData = existsSync(DIR) && readdirSync(DIR).some(f => f.endsWith('.json'));
const skip = !hasData && 'no team-history data in this checkout';
const FILES = hasData ? readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'))) : [];
const label = s => s.replace('-', '–');
const clone = x => JSON.parse(JSON.stringify(x));

// The first one-squad file whose squad has the property (one squad: the page shows squads[0]).
function pick(what, pred) {
  const file = FILES.find(d => d.squads.length === 1 && pred(d.squads[0]));
  assert.ok(file, `no history file has ${what} (fixture precondition)`);
  return file;
}

// Render a history document as the page does for its squad's latest season, into a fake DOM:
// the panels in order (class and HTML), the season rows and cards, and the aside.
function render(doc) {
  const els = new Map();
  const node = () => ({ style: {}, className: '', innerHTML: '', textContent: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); } });
  const el = k => { if (!els.has(k)) els.set(k, node()); return els.get(k); };
  const stubs = {
    document: { getElementById: el, createElement: () => node() },
    previewTeam: null, refreshState: {}, SOURCES: { refresh: { activeSeason: '2026-27' } }, SEASONS: { '2026-27': {} },
    seasonLabel: label, ordinal: n => `${n}th`, esc: s => String(s ?? ''), clubPlaceText: () => '', resultFor: () => null,
    historyCrumb() {}, getAgeLabel: d => d,
    pageHref: r => `#team=${r.teamID}&season=${r.season}`, confHref: r => `#season=${r.season}`, getStandingsUrl: () => '#tgs',
    getSchedulesUrl: () => '#tgs', NATIONAL_EVENTS: {}, formatDateRange: (a, b) => `${a}–${b}`, formatObservedDate: d => d,
    starButton: () => '', teamSeasonTabLabel: s => s, EXTERNAL_ICON: '',
  };
  const renderTeamHistory = new Function(...Object.keys(stubs), CODE + '\nreturn renderTeamHistory;')(...Object.values(stubs));
  const sq = doc.squads[0];
  const last = sq.seasons[sq.seasons.length - 1];
  renderTeamHistory({ teamID: doc.teamID, name: last.name }, last.season, doc);
  const [stack, aside] = el('standingsContainer').children[0].children;   // the layout: stack, aside
  const panels = stack.children.map(d => ({ cls: d.className, html: d.innerHTML }));
  const at = text => panels.findIndex(p => p.html.includes(text));
  const seasonsPanel = panels[at('flight-title">Season by season<')];
  const tbody = seasonsPanel.html.split('<tbody>')[1].split('</tbody>')[0];
  const rows = tbody.split('<tr').slice(1);
  const cardsPart = seasonsPanel.html.split('<div class="hist-cards">')[1].split(/<div class="hist-(?:legend|note)">/)[0];
  const cards = [...cardsPart.matchAll(/<div class="hist-card( hist-live)?">([\s\S]*?)(?=<div class="hist-card(?: hist-live)?">|$)/g)]
    .map(m => (m[1] ? 'live|' : '|') + m[2]);
  const seasonOf = h => h.match(/class="hist-season">([^<]+)</)[1];
  const events = title => {
    const p = panels.find(x => x.html.includes(`flight-title">${title}<`));
    assert.ok(p, `no ${title} panel`);
    return [...p.html.matchAll(/hist-event-when">([^<]+)<\/div>\s*<div class="hist-event-what">([^<·]+)/g)].map(m => `${m[1]} ${m[2].trim()}`);
  };
  return { sq, panels, at, seasonsPanel, rows, cards, seasonOf, events, aside: aside.innerHTML };
}
// Newest first, from the file: seasons by name, descending; events by season, descending, and
// within a season the later entry first (the builder lists Playoffs before Finals).
const newestFirst = list => list.map((e, i) => ({ e, i })).sort((a, b) => b.e.season.localeCompare(a.e.season) || b.i - a.i).map(x => x.e);
const moves = s => s.some((x, i) => i && s[i - 1].conference !== x.conference);

test('#127: every history list is oldest first, so the page reverses it (all files)', { skip }, () => {
  assert.ok(FILES.length > 1000);
  const asc = (l, k) => l.every((x, i) => !i || l[i - 1][k] <= x[k]);
  for (const d of FILES) for (const q of d.squads) {
    assert.ok(q.seasons.every((x, i) => !i || q.seasons[i - 1].season < x.season), `${d.teamID} seasons`);
    assert.ok(asc(q.postseason || [], 'season'), `${d.teamID} postseason`);
    assert.ok(asc(q.showcases || [], 'startDate'), `${d.teamID} showcases`);
  }
});

test('#127: the season rows, in the table and the phone cards, are newest first', { skip }, () => {
  const r = render(pick('5 or more seasons', q => q.seasons.length >= 5));
  const want = r.sq.seasons.map(x => x.season).sort().reverse().map(label);
  assert.deepEqual(r.rows.map(r.seasonOf), want);
  assert.deepEqual(r.cards.map(r.seasonOf), want);
  assert.match(r.seasonsPanel.html, /<caption class="sr-only">Season by season, conference tables, newest first<\/caption>/);
  assert.match(r.seasonsPanel.html, /<div class="hist-note">Newest season first\./);
});

test('#127: the regroup pill and the in-progress highlight stay on their own season', { skip }, () => {
  // The regroup is permanent (2026-27 on); "in progress" is not (it ends with the season), so it
  // is set by the test on a middle row of a copy: the highlight must follow that row, not the top.
  const doc = clone(pick('a regroup row and 3 or more seasons', q => q.seasons.length >= 3 && q.seasons.some(x => x.regroup)));
  const s = doc.squads[0].seasons;
  for (const x of s) delete x.inProgress;
  const mid = s[1];
  mid.inProgress = true;
  const r = render(doc);
  for (const [i, h] of r.rows.entries()) {
    const row = s.find(x => label(x.season) === r.seasonOf(h));
    assert.equal(/^ class="hist-live"/.test(h), row === mid, `${row.season} row highlight`);
    assert.equal(h.includes('>In progress<'), row === mid, `${row.season} "In progress" pill`);
    assert.equal(h.includes('>school-year regroup<'), !!row.regroup, `${row.season} regroup pill`);
    assert.equal(r.cards[i].startsWith('live|'), row === mid, `${row.season} card highlight`);
    assert.equal(r.cards[i].includes('>school-year regroup<'), !!row.regroup, `${row.season} card regroup pill`);
  }
  assert.match(r.seasonsPanel.html, /class="hist-legend">[\s\S]*school-year regroup[\s\S]*<\/div>/);
});

test('#127: a "moved from" pill names the season before, not the row above it', { skip }, () => {
  const r = render(pick('a conference change and 3 or more seasons', q => q.seasons.length >= 3 && moves(q.seasons)));
  const s = r.sq.seasons;
  const want = s.map((x, i) => i && s[i - 1].conference !== x.conference ? `${label(x.season)}:${s[i - 1].conference}` : null).filter(Boolean);
  const got = r.rows.map(h => { const m = h.match(/>moved from ([^<]+)</); return m ? `${r.seasonOf(h)}:${m[1]}` : null; }).filter(Boolean);
  assert.ok(want.length);
  assert.deepEqual(got.sort(), want.sort());
});

test('#127: "What happened next" sits just above the table, "Earlier seasons" just below it', { skip }, () => {
  const next = 'What happened next is not confirmed', prev = 'Earlier seasons not confirmed';
  const both = render(pick('both maybe and maybePrev', q => q.maybe?.length && q.maybePrev?.length));
  const table = both.at('flight-title">Season by season<');
  assert.equal(both.at(next), table - 1);
  assert.equal(both.at(prev), table + 1);
  const onlyNext = render(pick('maybe only', q => q.maybe?.length && !q.maybePrev?.length && q.seasons.length >= 2));
  assert.equal(onlyNext.at(next), onlyNext.at('flight-title">Season by season<') - 1);
  assert.equal(onlyNext.at(prev), -1);
  const onlyPrev = render(pick('maybePrev only', q => q.maybePrev?.length && !q.maybe?.length));
  assert.equal(onlyPrev.at(prev), onlyPrev.at('flight-title">Season by season<') + 1);
  assert.equal(onlyPrev.at(next), -1);
});

test('#127: "Earlier seasons not confirmed" still reads the oldest season (review S5)', { skip }, () => {
  const doc = clone(pick('maybePrev and 2 or more seasons', q => q.maybePrev?.length && q.seasons.length >= 2));
  const s = doc.squads[0].seasons;
  // The oldest and the newest rows differ, both ways, so reading the wrong end shows.
  for (const oldestRegroup of [true, false]) {
    s[0].regroup = oldestRegroup;
    s[s.length - 1].regroup = !oldestRegroup;
    const p = render(doc).panels.find(x => x.html.includes('Earlier seasons not confirmed'));
    assert.equal(p.html.includes(`In ${label(s[0].season)} ECNL regrouped ages`), oldestRegroup, `oldest regroup ${oldestRegroup}`);
  }
});

test('#127: Playoffs and Finals newest first, Finals above Playoffs within a season', { skip }, () => {
  const doc = pick('two seasons of post-season with Playoffs then Finals in one season', q => {
    const p = q.postseason || [];
    return new Set(p.map(e => e.season)).size >= 2 && p.some((e, i) => i && p[i - 1].season === e.season);
  });
  const r = render(doc);
  const want = newestFirst(r.sq.postseason).map(e => `${label(e.season)} ${e.stage}`);
  assert.deepEqual(r.events('Playoffs and Finals'), want);
  assert.notDeepEqual(want, r.sq.postseason.map(e => `${label(e.season)} ${e.stage}`), 'the file order differs');
});

test('#127: Showcases newest first', { skip }, () => {
  const r = render(pick('two showcases on different dates', q => new Set((q.showcases || []).map(e => e.startDate)).size >= 2));
  const want = r.sq.showcases.slice().sort((a, b) => b.startDate.localeCompare(a.startDate)).map(e => `${label(e.season)} ${e.stage}`);
  assert.deepEqual(r.events('Showcases'), want);
});

test('#127: the best finish and the titles still point at the right events (review M2)', { skip }, () => {
  // sq.best and sq.titles are indexes into postseason in the file's order: reversing the list
  // the renderer reads (rather than a copy for display) would point them at other events.
  const doc = pick('a best finish and a title that a reversed list would misplace', q => {
    const p = q.postseason || [];
    if (q.best == null || !(q.titles || []).length) return false;
    const rev = p.slice().reverse();
    return rev[q.best] !== p[q.best] && q.titles.some(i => rev[i] !== p[i]);
  });
  const r = render(doc);
  const p = r.sq.postseason, best = p[r.sq.best];
  const tiles = r.panels.find(x => x.html.includes('Best Champions League finish')).html;
  const tile = tiles.split('Best Champions League finish')[1];
  assert.ok(tile.includes(`<div class="stat-sub">${label(best.season)} · ${best.stage}</div>`), `best: ${best.season} ${best.stage}`);
  const titles = r.sq.titles.map(i => p[i]).map(e => `${e.tier}${/finals/i.test(e.tier) ? '' : `, ${e.stage}`} ${label(e.season)}`);
  const line = tiles.match(/<div class="hist-titles">([\s\S]*?)<\/div>/)[1];
  assert.equal(line.replace(/<b>[^<]*<\/b> /, ''), titles.join(' · '));
});

test('#127: the chart and each row\'s form chips stay oldest to newest', { skip }, () => {
  const r = render(pick('3 or more seasons with form', q => q.seasons.length >= 3 && q.seasons.every(x => x.form)));
  const ticks = [...r.aside.matchAll(/<text class="ax" x="[\d.]+" y="\d+" text-anchor="middle">(\d\d-\d\d)<\/text>/g)].map(m => m[1]);
  assert.deepEqual(ticks, r.sq.seasons.map(x => x.season.slice(2)));
  for (const h of r.rows) {
    const row = r.sq.seasons.find(x => label(x.season) === r.seasonOf(h));
    assert.equal([...h.matchAll(/class="form-chip inline ([wdl])"[^>]*>([WDL])</g)].map(m => m[2]).join(''), row.form);   // #128: buttons or spans
    assert.match(h, /results, oldest first/);
  }
  assert.match(r.seasonsPanel.html, /each row's form is ours, from TGS's scores, and reads oldest to newest\./);
});
