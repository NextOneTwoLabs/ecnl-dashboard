// #194: postseason places in a real browser, against the local offline server. Run locally for a PR that
// changes them, and record the result in the PR (a CI job is its own issue):
//
//   HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
//     node --import ./tests/netguard/netguard.mjs tests/e2e/postseason.e2e.mjs
//
// The harness is tests/e2e/h2h.e2e.mjs's: `python proxy_server.py --offline` on a free loopback port, Chromium
// behind the dead proxy, every request that is not to that port aborted and counted, none answered. At 1280
// and 375 px, light and dark: a tagged table shows its pills, tags and legend; a selected tagged row keeps
// the accent stripe and tint and still shows its pill and tag (MF1); Midwest U13 shows the places from
// either division; a 2025-26 table shows none and asks for no rules; no horizontal scroll on a phone; at
// most 1 rules request and 20 same-origin requests a load. Asserts rules, never counts a refresh can move.
// SHOTS_DIR, when set, receives the screenshots for the owner. PLAYWRIGHT_MODULES names Playwright's node_modules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const ping = port => new Promise(res => get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const wait = ms => new Promise(r => setTimeout(r, ms));
let server, port, browser, BASE;
before(async () => {
  port = await freePort(); BASE = `http://127.0.0.1:${port}`;
  server = spawn('python3', ['proxy_server.py', '--offline', '--port', String(port)], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PYTHONPATH: 'tests/netguard', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
  for (let i = 0; i < 100 && !(await ping(port)); i++) await wait(100);
  assert.ok(await ping(port), 'the local server is up');
  browser = await chromium.launch({ args: ['--proxy-server=127.0.0.1:9'] });
});
after(async () => { if (browser) await browser.close(); if (server) server.kill(); });
async function context({ theme = 'light', ...opts }) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  await ctx.addInitScript(t => { try { localStorage.setItem('ecnl-theme', t); } catch (e) { } }, theme);
  const log = { same: [], aborted: [], answered: [] };
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === BASE) { log.same.push(u.pathname + u.search); return route.continue(); }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    log.aborted.push(u.href); return route.abort();
  });
  ctx.on('requestfinished', r => { const u = new URL(r.url()); if (u.origin !== BASE && u.protocol.startsWith('http')) log.answered.push(u.href); });
  return { ctx, log };
}
const rulesAsked = log => log.same.filter(p => p.startsWith('/api/v1/seasons/') && p.endsWith('/postseason'));
const MA_U16 = '/#season=2026-27&age=GU16&conf=Mid-Atlantic';
const MW_U13 = '/#season=2026-27&age=GU13&conf=Midwest';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

// Every row of the tables on screen: its GP, its tag text and pill class, and the colours as painted.
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll('#standingsContainer .standings-table')].map(table => {
  const gpCol = [...table.querySelectorAll('thead th')].findIndex(th => th.textContent.trim() === 'GP');
  return [...table.querySelectorAll('tbody tr')].map(tr => {
    const pill = tr.querySelector('.pos-pill'), tag = tr.querySelector('.pos-tag'), cs = e => e && getComputedStyle(e);
    return { gp: Number(tr.children[gpCol].textContent), tag: tag ? tag.textContent : '', pill: pill ? pill.className : '',
      pillBg: pill ? cs(pill).backgroundColor : '', tagBg: tag ? cs(tag).backgroundColor : '', tagShown: !!(tag && tag.getBoundingClientRect().width > 0),
      sr: (tr.querySelector('.sr-only') || {}).textContent || '', selected: tr.classList.contains('team-row-highlight'),
      stripe: cs(tr.children[0]).boxShadow, start: tr.classList.contains('pos-start') };
  });
}));

for (const theme of ['light', 'dark']) {
  test(`desktop ${theme}: Mid-Atlantic U16 shows pills, tags and the legend; a selected tagged row keeps both cues (MF1); one rules request`, async () => {
    const { ctx, log } = await context({ theme, viewport: { width: 1280, height: 1400 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + MA_U16);
    await page.waitForSelector('.pos-legend', { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme);
    const [rows] = await rowsOf(page);
    const played = rows.filter(r => r.gp > 0).length;
    assert.equal(rows.filter(r => r.tag).length, Math.min(8, played), 'Mid-Atlantic U16 has 8 places: CL 1-3, CL* 4, NAC 5-6, SA 7, SB 8');
    assert.deepEqual(rows.filter(r => r.tag).map(r => r.tag.replace('=', '')), ['CL', 'CL', 'CL', 'CL*', 'NAC', 'NAC', 'SA', 'SB'].slice(0, Math.min(8, played)));
    for (const r of rows.filter(x => x.tag)) {
      assert.ok(r.tagShown, 'the tag is drawn');
      assert.match(r.sr, /^\. Postseason place: /, 'the place in words');
      assert.equal(r.pillBg, r.tagBg, 'pill and tag share the tier tint');
    }
    assert.ok(rows.filter(r => r.start).length >= 3, 'a border starts each new tier');
    assert.equal(await page.locator('.rank-top').count(), 0, 'no top-three accent beside the places (N7)');
    const legend = await page.locator('.pos-legend').innerText();
    assert.match(legend, /Postseason places if the season ended today \(projection, by conference PPG\)/);
    assert.match(legend, /unless the League Cup winner takes it/);
    await shot(page, `ma-u16-desktop-${theme}`);
    // MF1: select the first tagged row.
    await page.locator('#standingsContainer .standings-table tbody tr').first().click();
    await page.waitForSelector('#standingsContainer tr.team-row-highlight');
    const [after] = await rowsOf(page);
    const sel = after.find(r => r.selected);
    assert.ok(sel && sel.tag, 'a tagged row is selected');
    assert.match(sel.stripe, /inset/, 'the selection stripe');
    assert.ok(sel.tagShown && sel.pill.includes('pos-pill'), 'the pill and the tag');
    assert.equal(sel.pillBg, rows[0].pillBg, 'the pill keeps its tint on the selected row');
    await shot(page, `ma-u16-selected-${theme}`);
    assert.ok(rulesAsked(log).length <= 1, `rules requests: ${rulesAsked(log).length}`);
    assert.ok(log.same.length <= 20, `same-origin requests: ${log.same.length}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(log.answered, []);
    console.log(JSON.stringify({ [`desktop-${theme}`]: { sameOrigin: log.same.length, rules: rulesAsked(log).length, aborted: log.aborted.length } }));
    await ctx.close();
  });

  test(`phone ${theme}: Mid-Atlantic U16 at 375 px keeps the tags and has no horizontal scroll`, async () => {
    const { ctx, log } = await context({ theme, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + MA_U16);
    await page.waitForSelector('.pos-legend', { timeout: 20000 });
    const [rows] = await rowsOf(page);
    assert.ok(rows.filter(r => r.tag).every(r => r.tagShown), 'every tag is drawn on a phone');
    const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(scroll.sw <= scroll.cw, `no horizontal page scroll: ${scroll.sw} > ${scroll.cw}`);
    // The tag sits under the name on a phone, so the table never needs a sideways scroll for it.
    const fit = await page.evaluate(() => { const p = document.querySelector('.standings-panel'); return { panel: p.clientWidth, table: p.querySelector('table').scrollWidth }; });
    assert.ok(fit.table <= fit.panel, `the table fits its panel: ${fit.table} > ${fit.panel}`);
    const legendBox = await page.locator('.pos-legend').boundingBox();
    assert.ok(legendBox && legendBox.width <= 375, 'the legend fits');
    await shot(page, `ma-u16-phone-${theme}`);
    await page.locator('.pos-legend').scrollIntoViewIfNeeded();
    await shot(page, `ma-u16-phone-legend-${theme}`);
    assert.ok(rulesAsked(log).length <= 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(log.answered, []);
    await ctx.close();
  });
}

test('desktop light: Midwest U13 shows the top 2 of each division and the places from either division', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 1900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + MW_U13);
  await page.waitForSelector('.pos-legend', { timeout: 20000 });
  const tables = await rowsOf(page);
  assert.equal(tables.length, 2, 'East and West');
  for (const rows of tables) assert.deepEqual(rows.filter(r => r.gp > 0).slice(0, 2).map(r => r.tag.replace('=', '')), ['CL', 'CL']);
  assert.equal(tables.flat().filter(r => r.tag).length, 6, '2 + 2 by division and 2 from either division');
  assert.ok(tables.flat().filter(r => /next best across both divisions/.test(r.sr)).length === 2);
  const legend = await page.locator('.pos-legend').innerText();
  assert.match(legend, /the next 2 by PPG from either division: .+ \((East|West)\), .+ \((East|West)\)\./);
  assert.match(legend, /borrowed from the document's rule for ranking group runners-up/);
  await shot(page, 'midwest-u13-pooled-light');
  assert.ok(rulesAsked(log).length <= 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(log.answered, []);
  await ctx.close();
});

test('desktop: a 2025-26 table shows no places and asks for no rules; Standings, Matches, Standings asks again for nothing', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/#season=2025-26&age=G2010&conf=Mid-Atlantic');
  await page.waitForSelector('#standingsContainer .standings-table', { timeout: 20000 });
  assert.equal(await page.locator('.pos-tag, .pos-pill, .pos-legend').count(), 0);
  assert.ok(await page.locator('.rank-top').count() >= 1, 'the top-three accent as before');
  assert.deepEqual(rulesAsked(log), [], '2025-26: no rules request');
  await page.goto(BASE + MA_U16);
  await page.waitForSelector('.pos-legend', { timeout: 20000 });
  const n = rulesAsked(log).length;
  await page.locator('#viewTabSchedule').click();
  await page.waitForFunction(() => !document.querySelector('.pos-legend'));
  await page.locator('#viewTabStandings').click();
  await page.waitForSelector('.pos-legend');
  assert.equal(rulesAsked(log).length, n, 'no new rules request');
  assert.ok(n <= 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(log.answered, []);
  await ctx.close();
});
