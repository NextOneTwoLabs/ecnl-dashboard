// #165 (PR 4a), Q9: the search panel in a real browser, against the local offline server. Run locally for
// a PR that changes the panel, and record the result in the PR (a CI job is its own issue):
//
//   HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
//     node --import ./tests/netguard/netguard.mjs tests/e2e/search-panel.e2e.mjs
//
// It needs Playwright and a Chromium (not a dependency of the repo): PLAYWRIGHT_MODULES names the
// node_modules that hold it (default /opt/node-tools/node_modules/).
//
// No request leaves the machine:
//   - the server is `python proxy_server.py --offline` on a free loopback port, under the Python guard
//     (PYTHONPATH=tests/netguard) and the dead proxy;
//   - Chromium starts with --proxy-server=127.0.0.1:9, service workers blocked, and every request that is
//     not to that loopback port is aborted by the context's route and counted (fonts, and club logos on
//     TGS's S3 once a standings table is shown). The test asserts each one was aborted, none answered.
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

// A context where every non-loopback request is aborted and counted.
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
const apiSearch = log => log.same.filter(p => p.startsWith('/api/v1/search/'));
const modules = log => log.same.filter(p => /^\/search\/[a-z]+\.mjs/.test(p));
const sameCount = log => log.same.length;

test('desktop: first focus makes exactly 2 search API requests and 0 to /api/v1/teams, typing makes none, a chip opens its table', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForLoadState('load');
  await page.waitForTimeout(600);   // the idle preload of the modules
  assert.equal(apiSearch(log).length, 0, 'nothing from the search API before the first focus');
  assert.equal(modules(log).length, 8, 'the 8 modules are preloaded at idle');
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'usearchInput', '"/" focuses the box');
  await ready(page);
  assert.deepEqual(apiSearch(log).sort(), ['/api/v1/search/core', '/api/v1/search/places']);
  assert.equal(log.same.filter(p => p.startsWith('/api/v1/teams')).length, 0, 'no request to /api/v1/teams');
  assert.equal(modules(log).length, 8, 'no module requested twice');

  const before = sameCount(log);
  await page.keyboard.type('southwest');
  await page.waitForSelector('#usearchList [role=gridcell]');
  await page.waitForTimeout(400);
  assert.equal(sameCount(log), before, '0 same-origin requests while typing');
  assert.equal(await page.evaluate(() => document.getElementById('usearchList').getAttribute('role')), 'grid');
  const grid = await page.evaluate(() => {
    const inp = document.getElementById('usearchInput'), ctl = document.getElementById(inp.getAttribute('aria-controls'));
    const cells = [...document.querySelectorAll('[role=gridcell]')], ad = document.getElementById(inp.getAttribute('aria-activedescendant'));
    return { all: cells.length, outside: cells.filter(c => !ctl.contains(c)).length, options: document.querySelectorAll('[role=option]').length, activeInside: !!ad && ctl.contains(ad), expandedBad: [...document.querySelectorAll('[aria-expanded]')].filter(e => !['gridcell', 'combobox', 'button'].includes(e.getAttribute('role') || e.tagName.toLowerCase())).length };
  });
  assert.ok(grid.all > 30 && grid.outside === 0 && grid.options === 0 && grid.activeInside && grid.expandedBad === 0, JSON.stringify(grid));

  // the keys: Down, then Right x3 lands on the 2025-26 "2011" chip, which the action bar names
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#usearchActive').textContent(), 'Southwest 2011 · 2025–26 standings');
  assert.equal(await page.locator('#usearchOpen').getAttribute('href'), '#season=2025-26&age=G2011&conf=Southwest&view=standings');

  // click that chip: the table opens
  const blockedBefore = log.aborted.length;
  await page.locator('#usearchList [role=gridcell][aria-label*="2025-26, G2011"]').click();
  await page.waitForFunction(() => location.hash === '#season=2025-26&age=G2011&conf=Southwest&view=standings');
  await page.waitForFunction(() => document.querySelectorAll('table.standings-table tbody tr').length > 5, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.getElementById('usearchPop').hidden), true, 'the panel closed');
  assert.match(await page.evaluate(() => document.getElementById('contentTitle').textContent), /Southwest/);

  // Redmond WA: Nearby pills, one sub-heading
  await page.keyboard.press('/');
  await page.keyboard.type('Redmond WA');
  await page.waitForSelector('.sx-sub');
  assert.equal(await page.locator('.sx-sub').count(), 1);
  assert.ok(await page.locator('.sx-pill.near').count() >= 4);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('usearchPop').hidden), true);

  // dark mode: no horizontal scroll, the panel readable
  await page.keyboard.press('/'); await page.keyboard.type('Surf');
  await page.waitForSelector('.sx-clubhead');
  await page.evaluate(() => document.getElementById('themeToggle').click());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  assert.equal(apiSearch(log).length, 2, 'still exactly 2 search API requests after every query above');
  // the network: everything off the machine was aborted, nothing was answered
  assert.deepEqual(log.answered, []);
  assert.ok(log.aborted.length >= 1, 'the font request was aborted and counted');
  const hosts = new Set(log.aborted.map(u => new URL(u).host));
  for (const h of hosts) assert.ok(['fonts.googleapis.com', 'fonts.gstatic.com', 's3.amazonaws.com'].includes(h), `unexpected host ${h}`);
  assert.ok(log.aborted.slice(0, blockedBefore).every(u => new URL(u).host === 'fonts.googleapis.com'), 'before the table opens, only the font; the search itself loads no logos');
  console.log(JSON.stringify({ desktop: { sameOrigin: log.same.length, searchApi: apiSearch(log).length, modules: modules(log).length, abortedOffMachine: log.aborted.length, hosts: [...hosts] } }));
  await ctx.close();
});

test('phone: the sheet opens from the header button, traps Tab, Cancel returns focus, no horizontal scroll', async () => {
  const { ctx, log } = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/'); await page.waitForTimeout(600);
  await page.locator('#headerSearch').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'usearchSheetInput');
  assert.equal(await page.evaluate(() => document.getElementById('usearchPop').getAttribute('role')), 'dialog');
  assert.equal(await page.evaluate(() => document.getElementById('usearchPop').getAttribute('aria-modal')), 'true');
  await ready(page);
  await page.keyboard.type('southwest');
  await page.waitForSelector('#usearchList [role=gridcell]');
  // Tab stays inside the sheet, in both directions
  const inside = () => page.evaluate(() => document.getElementById('usearchPop').contains(document.activeElement));
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); assert.equal(await inside(), true, `Tab ${i}`); }
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await inside(), true, `Shift+Tab ${i}`); }
  await page.locator('#usearchSheetInput').fill('Sting Black');
  await page.waitForFunction(() => /Sting Black/.test((document.querySelector('.sx-best') || {}).textContent || ''));
  assert.match(await page.locator('.sx-best').textContent(), /Sting Black/);
  // the action bar's label wraps to two lines instead of truncating (Slammers' may-continue line is the long one)
  await page.locator('#usearchSheetInput').fill('Slammers');
  await page.waitForFunction(() => /Slammers/.test((document.querySelector('.sx-clubhead') || {}).textContent || ''));
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => /May continue here/.test(document.getElementById('usearchActive').textContent));
  const label = await page.evaluate(() => { const e = document.getElementById('usearchActive'); return { h: e.getBoundingClientRect().height, clipped: e.scrollHeight > e.clientHeight + 1, ellipsis: getComputedStyle(e).textOverflow }; });
  assert.ok(label.h > 30 && !label.clipped, `the label wraps to two lines and is whole: ${JSON.stringify(label)}`);
  await page.locator('#usearchSheetInput').fill('Sting Black');
  await page.waitForFunction(() => /Sting Black/.test((document.querySelector('.sx-best') || {}).textContent || ''));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 390');
  const chip = await page.locator('#usearchList [role=gridcell]').first().boundingBox();
  assert.ok(chip.height >= 36, `a chip is ${chip.height} px tall: at least 36 on the phone`);
  await page.locator('.us-cancel').click();
  assert.equal(await page.evaluate(() => document.getElementById('usearchPop').hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'headerSearch', 'Cancel returns focus to the header button');
  assert.equal(await page.evaluate(() => document.getElementById('usearchSheetInput').value), '');
  assert.deepEqual(errors, []);
  assert.equal(apiSearch(log).length, 2);
  assert.deepEqual(log.answered, []);
  console.log(JSON.stringify({ phone: { sameOrigin: log.same.length, searchApi: apiSearch(log).length, abortedOffMachine: log.aborted.length } }));
  await ctx.close();
});

test('action bar: a team that two earlier teams may continue is named whole, never clipped, at 1280 and 390 (MF1 of the review of #166)', async () => {
  for (const [w, h, phone] of [[1280, 800, false], [390, 844, true]]) {
    const { ctx } = await context(phone ? { viewport: { width: w, height: h }, isMobile: true, hasTouch: true } : { viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/'); await page.waitForTimeout(500);
    if (phone) await page.locator('#headerSearch').click(); else await page.keyboard.press('/');
    await ready(page);
    await page.keyboard.type('Slammers');
    await page.waitForSelector('#usearchList [role=gridcell]');
    let text = '';
    for (let i = 0; i < 40 && !/born 2010$/.test(text); i++) {   // down, then right: HB Koge U17 has two earlier teams
      await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowDown');
      text = await page.locator('#usearchActive').textContent();
    }
    assert.match(text, /May continue here: 2025-26 team, born 2009; 2025-26 team, born 2010$/, `${w}: ${text}`);
    const m = await page.evaluate(() => { const e = document.getElementById('usearchActive'), c = getComputedStyle(e); return { clipped: e.scrollHeight > e.clientHeight + 1, clamp: c.webkitLineClamp, overflow: c.overflow, h: e.getBoundingClientRect().height, lineH: parseFloat(c.lineHeight) }; });
    assert.ok(!m.clipped && m.clamp === 'none', `${w}: ${JSON.stringify(m)}`);
    assert.ok(m.h >= m.lineH * 2 - 1, `${w}: the long label takes the lines it needs: ${JSON.stringify(m)}`);
    await ctx.close();
  }
});

test('version: a search.mjs with another SEARCH_API shows the reload note, and nothing is searched (the 2 data files are still fetched)', async () => {
  const { ctx, log } = await context({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/search/search.mjs', async route => {
    const body = (await (await route.fetch()).text()).replace('export const SEARCH_API = 2', 'export const SEARCH_API = 999');
    assert.match(body, /SEARCH_API = 999/);
    await route.fulfill({ contentType: 'text/javascript', body });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/'); await page.waitForTimeout(400);
  await page.keyboard.press('/');
  await page.waitForSelector('.sx-note.warn');
  assert.match(await page.locator('.sx-note').textContent(), /Search was updated while this page was open/);
  assert.equal(await page.locator('.sx-note').getAttribute('role'), 'alert');
  assert.equal(await page.locator('.sx-note button').textContent(), 'Reload page');
  await page.keyboard.type('Surf'); await page.waitForTimeout(300);
  assert.equal(await page.locator('#usearchList [role=gridcell]').count(), 0, 'nothing is searched');
  assert.equal(apiSearch(log).filter(p => p.endsWith('/core') || p.endsWith('/places')).length <= 2, true);
  await ctx.close();
});
