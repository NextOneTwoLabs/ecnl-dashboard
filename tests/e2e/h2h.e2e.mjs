// #178 (#149 phase 1, PR 6): the head to head in a real browser, against the local offline server. Run locally for a PR
// that changes it, and record the result in the PR (a CI job is its own issue):
//
//   HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
//     node --import ./tests/netguard/netguard.mjs tests/e2e/h2h.e2e.mjs
//
// The harness is tests/e2e/search-panel.e2e.mjs's: `python proxy_server.py --offline` on a free loopback port, Chromium
// behind the dead proxy, every request that is not to that port aborted and counted. It asserts rules and the request
// budget (typing 0; opening from search at most 6; a cold open at most 8; Back and Forward 0; no image from the page),
// never counts a data refresh could move. PLAYWRIGHT_MODULES names the node_modules that hold Playwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, get } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
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
async function context(opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
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
const ready = page => page.waitForFunction(() => !/Getting search ready/.test(document.querySelector('#sxStatus').textContent), null, { timeout: 20000 });
const gamesReady = page => page.waitForFunction(() => typeof sxIndex !== 'undefined' && sxIndex && sxIndex.games.has(sxIndex.vocab.active) && !sxG.running, null, { timeout: 20000 });
const gamesApi = log => log.same.filter(p => p.startsWith('/api/v1/search/games/'));
const apiSearch = log => log.same.filter(p => p.startsWith('/api/v1/search/'));
const h2hDone = page => page.waitForFunction(() => document.querySelector('.h2h') && !document.querySelector('.h2h-loading') && /Head to head/.test(document.getElementById('breadcrumb').textContent), null, { timeout: 20000 });
const recordOf = page => page.evaluate(() => [...document.querySelectorAll('.h2h-nums b')].map(b => +b.textContent));

test('desktop: typing makes 0 requests; Enter on the lead row opens the head to head with exactly the seasons both played; Back and Forward make 0; a meeting opens its game; 0 images', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/'); await page.waitForLoadState('load'); await page.waitForTimeout(600);
  await page.keyboard.press('/');
  await ready(page); await gamesReady(page);
  const before = log.same.length;
  await page.keyboard.type('MVLA 2011 vs Mustang 2011');
  await page.waitForSelector('.sxg-h2hrow');
  await page.waitForTimeout(400);
  assert.equal(log.same.length, before, 'typing makes 0 requests');
  assert.equal(await page.locator('.sxg-h2hrow').getAttribute('aria-selected'), 'true', 'the lead row is the active cell');
  const cells = await page.evaluate(() => [...document.querySelectorAll('#usearchList .sxg-row')].length);
  assert.equal(await page.locator('#usearchList .sxg-h2h').count(), cells, 'every game row of this query has an H2H cell');
  const g0 = gamesApi(log).length;
  await page.keyboard.press('Enter');
  await h2hDone(page);
  const asked = gamesApi(log).slice(g0);
  assert.deepEqual(asked.sort(), ['/api/v1/search/games/2023-24', '/api/v1/search/games/2024-25', '/api/v1/search/games/2025-26'], 'exactly the 3 earlier seasons both played');
  assert.equal(await page.locator('#viewTabH2H').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#contentTitle').textContent(), /MVLA.* v .*Mustang/);
  const [w, d, l] = await recordOf(page);
  const played = await page.evaluate(() => +/(\d+) meetings? played/.exec(document.querySelector('.h2h-goals').innerText)[1]);
  assert.equal(w + d + l, played, 'the record adds up to the meetings played');
  assert.equal(await page.locator('.h2h img').count(), 0, 'the head to head draws no image');
  assert.equal(await page.evaluate(() => /vs=|h2h/.test(localStorage.getItem('ecnl-dash-v2-state') || '')), false, 'never saved as the place to resume');
  const hash = await page.evaluate(() => location.hash);
  assert.match(hash, /^#tab=teams&season=2026-27&team=\d+&name=.+&vs=2026-27:\d+$|^#tab=teams&season=\d{4}-\d{2}&team=\d+&name=.+&vs=\d{4}-\d{2}:\d+$/);
  const n = log.same.length;
  await page.locator('.h2h-game').first().click();
  await page.waitForFunction(() => /view=(schedule|standings)|tab=(playoffs|showcases)/.test(location.hash) && /match=/.test(location.hash) || document.querySelector('.is-match'), null, { timeout: 20000 });
  await page.goBack();
  await h2hDone(page);
  assert.equal(await page.evaluate(() => /vs=/.test(location.hash)), true, 'Back returns to the head to head');
  const m = log.same.length;
  await page.goForward(); await page.waitForTimeout(300); await page.goBack(); await h2hDone(page);
  assert.equal(gamesApi(log).length, g0 + 3, 'Back and Forward make no games request');
  assert.ok(log.same.length <= 32, `the production check's ceiling is 32 same-origin requests a load: ${log.same.length}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(log.answered, []);
  console.log(JSON.stringify({ desktop: { sameOrigin: log.same.length, gamesApi: gamesApi(log).length, aborted: log.aborted.length } }));
  await ctx.close();
});

test('regroup: nothing is added for the visitor; adding an earlier team fetches only its new seasons and the record grows; the other side cannot add the same team', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/'); await page.waitForTimeout(500);
  await page.keyboard.press('/'); await ready(page); await gamesReady(page);
  await page.keyboard.type('Force (CA) 2009/10 vs MVLA 2009/10');
  await page.waitForSelector('.sxg-h2hrow');
  await page.keyboard.press('Enter');
  await h2hDone(page);
  assert.ok(await page.locator('.h2h-regroup').count() >= 1, 'a regroup control');
  assert.equal(await page.locator('.h2h-regroup input:checked').count(), 0, 'none is checked for the visitor');
  const before = await recordOf(page), g0 = gamesApi(log).length;
  const box = page.locator('.h2h-regroup input:not([disabled])').first();
  await box.check();
  await page.waitForFunction(() => !document.querySelector('.h2h-loading') && document.querySelector('.h2h-regroup input:checked'));
  const after = await recordOf(page);
  assert.ok(after.reduce((a, b) => a + b, 0) >= before.reduce((a, b) => a + b, 0), 'the record grows or stays');
  assert.equal(await page.evaluate(() => document.activeElement.id), await box.getAttribute('id'), 'focus stays on the checkbox');
  assert.ok(gamesApi(log).length - g0 <= 6, 'only the new seasons');
  assert.deepEqual(errors, []);
  assert.deepEqual(log.answered, []);
  await ctx.close();
});

test('phone: from a Matches card, a cold open makes core, places and the games files both played (exactly 6 for this pair; at most 8 for any), no horizontal scroll; a bad vs opens the Overview with a note', async () => {
  const { ctx, log } = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/#season=2026-27&age=GU16&conf=NorCal&view=schedule&team=55477&sched=all');
  await page.waitForSelector('.match-h2h', { timeout: 20000 });
  assert.equal(apiSearch(log).length, 0, 'the Matches view loads no search data');
  const links = await page.locator('.match-h2h').count();
  const cards = await page.locator('.match-row').count();
  assert.equal(links, cards, 'every card of this division has a Head to head link');
  await page.locator('.match-row', { hasText: 'Mustang' }).locator('.match-h2h').first().click();
  await h2hDone(page);
  const api = apiSearch(log);
  assert.equal(api.length, 6, `search/core, search/places and the 4 seasons both played (2023-24 to 2026-27): ${api.join()}`);
  assert.ok(api.includes('/api/v1/search/core') && api.includes('/api/v1/search/places'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 390');
  assert.equal(await page.locator('.h2h img').count(), 0);
  const cold = log.same.length;
  assert.ok(cold <= 32, `the production check's ceiling is 32 same-origin requests a load: ${cold}`);
  await page.goto(BASE + '/#tab=teams&season=2026-27&team=55477&name=MVLA&vs=2026-27:1');
  await page.reload();
  await page.waitForSelector('.h2h-note:not([hidden])', { timeout: 20000 });
  assert.match(await page.locator('.h2h-note').textContent(), /no team page for 2026–27/);
  assert.equal(await page.evaluate(() => /vs=/.test(location.hash)), false, 'the address drops vs');
  assert.deepEqual(errors, []);
  assert.deepEqual(log.answered, []);
  console.log(JSON.stringify({ phone: { coldLoadSameOrigin: cold, sameOrigin: log.same.length, searchApi: apiSearch(log).length, aborted: log.aborted.length } }));
  await ctx.close();
});

test('#182: the "can\'t open" note lines up with the cards (left edge, and right edge with the grid) at 390, 1280 and 1920 wide; a hash that names nothing leaves the head to head on screen, 0 requests', async () => {
  const geo = [];
  for (const [width, height] of [[1280, 800], [390, 844], [1920, 1080]]) {
    const { ctx, log } = await context({ viewport: { width, height }, ...(width === 390 ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/#tab=teams&season=2026-27&team=55477&name=MVLA&vs=2026-27:1');
    await page.waitForSelector('.h2h-note:not([hidden])', { timeout: 20000 });
    await page.waitForSelector('#standingsContainer .flight-panel', { timeout: 20000 });
    await page.waitForTimeout(500);
    const g = await page.evaluate(() => {
      const n = document.querySelector('.h2h-note').getBoundingClientRect(), c = document.querySelector('#standingsContainer .flight-panel').getBoundingClientRect(), box = document.getElementById('standingsContainer').getBoundingClientRect();
      return { noteLeft: n.left, noteRight: n.right, cardLeft: c.left, gridRight: box.right, gap: c.top - n.bottom, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    geo.push({ width, ...Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Math.round(v * 10) / 10])) });
    assert.ok(Math.abs(g.noteLeft - g.cardLeft) <= 0.5, `${width}: the note starts at the cards' left edge (${g.noteLeft} v ${g.cardLeft})`);
    assert.ok(Math.abs(g.noteRight - g.gridRight) <= 0.5, `${width}: the note ends at the grid's right edge (${g.noteRight} v ${g.gridRight})`);
    assert.ok(g.gap >= 8 && g.gap <= 24, `${width}: a gap above the cards, not flush (${g.gap})`);
    assert.ok(g.scrollW <= g.innerW, `${width}: no horizontal scroll`);
    assert.deepEqual(errors, []); assert.deepEqual(log.answered, []);
    await ctx.close();
  }
  console.log(JSON.stringify({ note: geo }));
  // a hash that names nothing
  const { ctx, log } = await context({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/#tab=teams&season=2026-27&team=55477&name=MVLA&vs=2026-27:31529');
  await h2hDone(page);
  for (let i = 0; i < 100 && gamesApi(log).length < 4; i++) await wait(100);
  await wait(500);
  const n = log.same.length;
  for (const h of ['#foo', '#match=5']) {
    await page.evaluate(x => { location.hash = x; }, h); await wait(500);
    assert.equal(await page.locator('.h2h .h2h-summary').count(), 1, `${h}: the head to head stays on screen`);
    assert.equal(await page.locator('#viewTabH2H').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => currentTab), 'favorites', `${h}: the tab is as it was`);
    assert.equal(await page.evaluate(() => /vs=|h2h/.test(localStorage.getItem('ecnl-dash-v2-state') || '')), false, `${h}: still never saved as the place to resume`);
  }
  assert.equal(log.same.length, n, 'a hash that names nothing makes 0 requests');
  assert.deepEqual(errors, []); assert.deepEqual(log.answered, []);
  await ctx.close();
});
