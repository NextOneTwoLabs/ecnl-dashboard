// #128: each form chip shows its game (opponent, score, date) on hover, keyboard focus or tap.
// The page's own code (public/index.html), extracted block by block: the chip text and buttons,
// the Overview's chips from the history files' `last` (and today's letter-only chips when `last`
// is missing or doesn't match `form`, review M2), and the glance card's chips from the page's own
// games, which must read exactly as the Overview's for the same season (checked on every row).
// The tooltip's behaviour is a browser matter: the PR's Playwright run covers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

process.env.TZ = 'America/Los_Angeles';   // review S2: a date must not slide a day west of UTC

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (head, last = head, close = '\n    }\n') => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf(close, from) + close.length;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CHIPS = [
  block('    function shortTeamName('), block('    function displayName('),
  block('    function gameWinner('), block('    function resultFor('),
  block('    function isPlayed(', 'function isPlayed(', '\n'), block('    function sortGames('), block('    function todayKey('), block('    // #64: the next match', 'function computeTeamSummary('),
  block('    // #128: form chips that show their game.', 'function chipGames('),
].join('\n');
const page = new Function('esc', CHIPS + '\nreturn { chipText, chipDate, formChipsHtml, chipGames, computeTeamSummary };')(esc);

const HIST = new URL('../public/archive/history/', import.meta.url);
const hasData = existsSync(HIST) && readdirSync(HIST).some(f => f.endsWith('.json'));
const skip = !hasData && 'no team-history data in this checkout';
const FILES = hasData ? readdirSync(HIST).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(new URL(f, HIST), 'utf8'))) : [];
const ROWS = new Map();   // one per (season, team id): a row is in its team's file and any other id's
for (const d of FILES) for (const q of d.squads) for (const r of q.seasons) ROWS.set(`${r.season}|${r.teamID}`, r);
const schedule = (() => {
  const memo = new Map();
  return (e, f) => {
    if (!memo.has(`${e}/${f}`)) {
      const p = new URL(`../public/archive/api/Event/get-schedules-by-flight/${e}/${f}/0.json`, import.meta.url);
      memo.set(`${e}/${f}`, existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).data || []) : null);
    }
    return memo.get(`${e}/${f}`);
  };
})();

// The expected words, written here from the owner's examples, not from the page.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = n => String(n).replace(/\s*[-–]?\s*ECNL\b.*$/i, '').trim() || n;
function expected(letter, g) {
  const date = `${MON[+g.date.slice(5, 7) - 1]} ${+g.date.slice(8, 10)}`;
  const score = `${g.gf}–${g.ga}${g.pk ? ` (${g.pk[0]}–${g.pk[1]} pens)` : ''}`;
  return g.home == null ? `${letter} ${score} · opponent not published · ${date}` : `${letter} ${score} ${g.home ? 'vs' : 'at'} ${short(g.opp)} · ${date}`;
}

test('#128: the chip words, in the owner\'s format', () => {
  const g = { r: 'W', gf: 3, ga: 1, home: true, opp: 'Example SC ECNL G2010', date: '2026-09-27' };
  assert.deepEqual(page.chipText(g), { tip: 'W 3–1 vs Example SC · Sep 27', name: 'W, win 3–1 vs Example SC, Sep 27' });
  assert.deepEqual(page.chipText({ ...g, r: 'L', gf: 0, ga: 2, home: false, date: '2026-10-04' }),
    { tip: 'L 0–2 at Example SC · Oct 4', name: 'L, loss 0–2 at Example SC, Oct 4' });
  assert.deepEqual(page.chipText({ ...g, r: 'W', gf: 1, ga: 1, pk: [4, 3] }),
    { tip: 'W 1–1 (4–3 pens) vs Example SC · Sep 27', name: 'W, win 1–1 (4–3 pens) vs Example SC, Sep 27' });
  assert.deepEqual(page.chipText({ ...g, r: 'D', gf: 2, ga: 2, home: null, opp: null, date: '2022-03-05' }),
    { tip: 'D 2–2 · opponent not published · Mar 5', name: 'D, draw 2–2, opponent not published, Mar 5' });
  // From the text: midnight UTC would be Sep 26 here (review S2); TGS's "no date" year is blank.
  assert.equal(new Date('2026-09-27').getDate(), 26, 'the test runs west of UTC');
  assert.equal(page.chipDate('2026-09-27'), 'Sep 27');
  assert.equal(page.chipDate('2026-09-27T23:30:00'), 'Sep 27');
  assert.equal(page.chipDate('0001-01-01'), '');
  assert.equal(page.chipText({ ...g, date: '' }).tip, 'W 3–1 vs Example SC');
});

test('#128: chips are buttons in a group with one Tab stop, named by their letter first', () => {
  const games = ['W', 'D', 'L'].map((r, i) => ({ r, gf: 2 - i, ga: 1, home: i !== 1, opp: `Team ${i} ECNL G11`, date: `2026-09-0${i + 1}` }));
  const out = page.formChipsHtml(games, true);
  const buttons = [...out.matchAll(/<button type="button" class="form-chip inline ([wdl])" tabindex="(-?\d)" aria-label="([^"]+)" data-tip="([^"]+)">([WDL])<\/button>/g)];
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map(m => m[2]), ['0', '-1', '-1']);
  for (const m of buttons) {
    assert.equal(m[1].toUpperCase(), m[5]);
    assert.ok(m[3].startsWith(`${m[5]}, `), '2.5.3: the name starts with the visible letter');
  }
  assert.ok(!/title=/.test(out));
  assert.match(page.formChipsHtml(games, false), /class="form-chip w"/);
  // A hostile opponent name stays text in both attributes (review SC2): escaped here, and the
  // tooltip is filled with textContent, so it shows literally.
  const hostile = page.formChipsHtml([{ ...games[0], opp: 'A "B" <C> & <img src=x onerror="x()"> ECNL' }], true);
  assert.match(hostile, /aria-label="W, win 2–1 vs A &quot;B&quot; &lt;C&gt; &amp; &lt;img src=x onerror=&quot;x\(\)&quot;&gt;, Sep 1"/);
  assert.match(hostile, /data-tip="W 2–1 vs A &quot;B&quot; &lt;C&gt; &amp; &lt;img src=x onerror=&quot;x\(\)&quot;&gt; · Sep 1"/);
  assert.ok(!/<img/.test(hostile));
});

test('#128: the glance card\'s chips read exactly as the Overview\'s, for every season row', { skip }, () => {
  // The page's own path (computeTeamSummary on the archived schedule, then chipGames) against
  // the builder's `last`, row by row: the same games, in the same order, in the same words.
  let rows = 0, games = 0;
  for (const r of ROWS.values()) {
    const sched = schedule(r.eventID, r.flightID);
    assert.ok(sched, `${r.season} ${r.teamID}: schedule archived`);
    const s = page.computeTeamSummary(r.teamID, [], sched);
    assert.equal(s.form.join(''), r.form, `${r.season} ${r.teamID}: form`);
    if (!r.form) { assert.equal(r.last, undefined); continue; }
    const fromPage = page.chipGames(s.played.slice(-s.form.length), r.teamID).map(page.chipText);
    const fromFile = r.last.map((g, i) => page.chipText({ ...g, r: r.form[i] }));
    assert.deepEqual(fromPage, fromFile, `${r.season} ${r.teamID}`);
    rows++; games += r.last.length;
  }
  assert.ok(rows > 4000 && games > 20000, `${rows} rows, ${games} games`);
});

test('#128: a shoot-out shows its penalties; TGS\'s 0–0 placeholder on a draw does not (review M1)', { skip }, () => {
  const all = [...ROWS.values()].flatMap(r => (r.last || []).map((g, i) => ({ r, g, letter: r.form[i] })));
  const shootouts = all.filter(x => x.g.pk);
  assert.ok(shootouts.length >= 1, 'a decided shoot-out in the files (precondition)');
  for (const { g, letter } of shootouts) {
    assert.equal(g.gf, g.ga);
    assert.match(page.chipText({ ...g, r: letter }).tip, new RegExp(`^${letter} ${g.gf}–${g.ga} \\(${g.pk[0]}–${g.pk[1]} pens\\) `));
  }
  // A draw whose schedule row carries 0-0 penalties: no "pens", from the file or from the page.
  const placeholder = all.find(({ r, g, letter }) => letter === 'D' && (schedule(r.eventID, r.flightID) || []).some(x =>
    (x.gameDate || '').startsWith(g.date) && [x.hometeamID, x.awayteamID].includes(r.teamID) && x.hometeamPKscore === 0 && x.awayteamPKscore === 0));
  assert.ok(placeholder, 'a draw with TGS\'s 0-0 placeholder (precondition)');
  assert.equal(placeholder.g.pk, undefined);
  assert.ok(!/pens/.test(page.chipText({ ...placeholder.g, r: 'D' }).tip));
  const x = { hometeamID: 1, awayteamID: 2, homeTeam: 'H', awayTeam: 'A', hometeamscore: 1, awayteamscore: 1, hometeamPKscore: 0, awayteamPKscore: 0, gameDate: '2022-01-01T10:00:00' };
  assert.equal(page.chipGames([x], 1)[0].pk, null);
  assert.deepEqual(page.chipGames([{ ...x, hometeamPKscore: 3, awayteamPKscore: 4 }], 2)[0].pk, [4, 3]);
});

test('#128: a game with no opponent listed says so, with no "vs" or "at"', { skip }, () => {
  const none = [...ROWS.values()].flatMap(r => (r.last || []).map((g, i) => ({ g, letter: r.form[i] }))).filter(x => x.g.home === null);
  assert.ok(none.length >= 1, 'such games exist (precondition)');
  for (const { g, letter } of none) {
    const t = page.chipText({ ...g, r: letter });
    assert.equal(t.tip, expected(letter, g));
    assert.ok(!/ vs | at /.test(t.tip));
  }
  const x = { hometeamID: 1, awayteamID: null, homeTeam: 'H', awayTeam: '', hometeamscore: 3, awayteamscore: 0, gameDate: '2022-03-05T10:00:00' };
  assert.deepEqual(page.chipGames([x], 1)[0], { r: 'W', gf: 3, ga: 0, home: null, opp: null, date: '2022-03-05', pk: null });
});

// The Overview, rendered by the page's own renderer on real files (as tests/team-overview.test.mjs).
const OVERVIEW = [
  block('    function shortTeamName('), block('    function displayName('),
  block('    // #128: form chips that show their game.', 'function chipGames('),
  block('    function historyYears(', 'function historyOutcome('),
  block('    function historySplitNotes('), block('    function historyChartSvg('), block('    function renderTeamHistory('),
].join('\n');
function overview(doc) {
  const els = new Map();
  const node = () => ({ style: {}, className: '', innerHTML: '', textContent: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
    querySelector: () => ({ innerHTML: '' }) });
  const el = k => { if (!els.has(k)) els.set(k, node()); return els.get(k); };
  const stubs = {
    document: { getElementById: el, createElement: () => node() }, previewTeam: null, refreshState: {},
    SOURCES: { refresh: { activeSeason: '2026-27' } }, SEASONS: { '2026-27': {} }, seasonLabel: s => s.replace('-', '–'),
    ordinal: n => `${n}th`, esc, clubPlaceText: () => '', historyCrumb() {}, getAgeLabel: d => d, resultFor: () => null,
    pageHref: () => '#', confHref: () => '#', getStandingsUrl: () => '#', getSchedulesUrl: () => '#', NATIONAL_EVENTS: {},
    formatDateRange: () => '', formatObservedDate: d => d, starButton: () => '', teamSeasonTabLabel: s => s, EXTERNAL_ICON: '',
    openSeason: () => '2026-27', teamToken: 0, getSchedule: () => new Promise(() => {}), isMissing: () => false, retryText: e => String(e), 
  };
  const render = new Function(...Object.keys(stubs), OVERVIEW + '\nreturn renderTeamHistory;')(...Object.values(stubs));
  const sq = doc.squads[0], last = sq.seasons[sq.seasons.length - 1];
  render({ teamID: doc.teamID, name: last.name }, last.season, doc);
  const stack = el('standingsContainer').children[0].children[0];
  const panel = stack.children.map(d => d.innerHTML).find(h => h.includes('flight-title">Season by season<'));
  const tbody = panel.split('<tbody>')[1].split('</tbody>')[0];
  return { sq, panel, rows: tbody.split('<tr').slice(1) };
}
const pick = (what, pred) => {
  const d = FILES.find(x => x.squads.length === 1 && pred(x.squads[0]));
  assert.ok(d, `no history file has ${what} (fixture precondition)`);
  return d;
};
const seasonOf = h => h.match(/class="hist-season">([^<]+)</)[1].replace('–', '-');

test('#128: the Overview\'s chips carry each row\'s games, from the file', { skip }, () => {
  const doc = pick('3 or more seasons, each with 5 games', q => q.seasons.length >= 3 && q.seasons.every(r => r.last?.length === 5 && r.form.length === 5));
  const o = overview(doc);
  for (const h of o.rows) {
    const row = o.sq.seasons.find(r => r.season === seasonOf(h));
    const group = h.match(/<span class="hist-form" role="group" aria-label="Last 5 results, oldest first">([\s\S]*?)<\/span>/);
    assert.ok(group, `${row.season}: a group`);
    const tips = [...group[1].matchAll(/data-tip="([^"]+)"/g)].map(m => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.deepEqual(tips, row.last.map((g, i) => expected(row.form[i], g)), row.season);
    assert.equal((group[1].match(/tabindex="0"/g) || []).length, 1);
    assert.ok(!/sr-only/.test(group[1]), 'the buttons say it: no duplicate summary');
  }
  assert.equal(o.panel.split('vs = home game, at = away game, as TGS lists them; at a neutral venue TGS still names one team as home.').length, 2, 'the footnote, once');
});

test('#128: without a matching `last`, the Overview shows today\'s letter-only chips (review M2)', { skip }, () => {
  const base = pick('2 or more seasons with games', q => q.seasons.length >= 2 && q.seasons.every(r => r.last?.length));
  const variants = {
    'no last (an older file)': r => { delete r.last; },
    'an empty last': r => { r.last = []; },
    'a last shorter than form': r => { r.last = r.last.slice(1); },
  };
  for (const [what, change] of Object.entries(variants)) {
    const doc = JSON.parse(JSON.stringify(base));
    doc.squads[0].seasons.forEach(change);
    const o = overview(doc);
    for (const h of o.rows) {
      const row = o.sq.seasons.find(r => r.season === seasonOf(h));
      assert.ok(!/<button/.test(h), `${what}: no buttons`);
      assert.match(h, new RegExp(`<span class="sr-only">Last ${row.form.length} results, oldest first: `));
      assert.equal([...h.matchAll(/<span class="form-chip inline ([wdl])" aria-hidden="true">([WDL])<\/span>/g)].map(m => m[2]).join(''), row.form, what);
    }
    assert.ok(!o.panel.includes('vs = home game'), `${what}: no footnote`);
  }
  // One row without: that row falls back, the others keep their games.
  const doc = JSON.parse(JSON.stringify(base));
  delete doc.squads[0].seasons[0].last;
  const o = overview(doc);
  const oldest = o.rows.find(h => seasonOf(h) === doc.squads[0].seasons[0].season);
  assert.ok(!/<button/.test(oldest) && o.rows.filter(h => /<button/.test(h)).length === o.rows.length - 1);
  assert.ok(o.panel.includes('vs = home game'));
});

test('#128: the glance card\'s chips are the same buttons (season tab and Conferences)', () => {
  const GLANCE = [CHIPS, block('    function opponentText('), block('    function glancePanelHtml(')].join('\n');
  const glancePanelHtml = new Function('esc', 'clubPlaceText', 'historyAvailable', 'starButton', 'formatGameDate', 'teamSeasonTabLabel', 'currentSeason',
    GLANCE + '\nreturn glancePanelHtml;')(esc, () => '', () => true, () => '', d => d, s => s, '2026-27');
  const g = (n, hs, as, home) => ({ hometeamID: home ? 7 : 8, awayteamID: home ? 8 : 7, homeTeam: home ? 'Us ECNL G10' : 'Them FC ECNL G10',
    awayTeam: home ? 'Them FC ECNL G10' : 'Us ECNL G10', hometeamscore: hs, awayteamscore: as, gameDate: `2026-09-0${n}T10:00:00`, gameTime: '10:00:00' });
  const games = [g(1, 3, 1, true), g(2, 0, 2, false), g(3, 1, 1, true)];
  const s = page.computeTeamSummary(7, [], games);
  const out = glancePanelHtml({ teamID: 7, name: 'Us ECNL G10', clubName: 'Us' }, s, { season: '2026-27', link: true });
  const tips = [...out.matchAll(/<button type="button" class="form-chip ([wdl])" tabindex="-?\d" aria-label="[^"]+" data-tip="([^"]+)">/g)].map(m => m[2]);
  assert.deepEqual(tips, ['W 3–1 vs Them FC · Sep 1', 'W 2–0 at Them FC · Sep 2', 'D 1–1 vs Them FC · Sep 3']);
  assert.match(out, /<div class="form-chips" role="group" aria-label="Last 3 results, oldest first">/);
  assert.ok(!/title="(Win|Loss|Draw)"/.test(out), 'no title tooltip left');
  assert.match(out, /Last: <span class="form-chip inline d">D<\/span>/, 'the "Last:" chip stays plain: its game is written beside it');
});
