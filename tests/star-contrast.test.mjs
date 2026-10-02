// #136: the unfollowed follow star (☆) must reach 3:1 against every background it sits on, in
// both themes (WCAG 2.2 1.4.11, a UI component), and the "ECNL Girls" header link must stay on
// the current host. The colours are computed from the page's own CSS tokens and rules, the way a
// browser composites them: a rule's opacity blends the colour into the background, and a star
// with no colour of its own is the browser's black (the bug: 2.12:1 light, 1.08:1 dark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

// Every `selector { body }` at any nesting depth (an @media body is searched too).
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
const decl = (body, prop) => { const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`)); return m ? m[1].trim() : null; };
const tokens = theme => {
  const r = rules.find(x => x.sel === `[data-theme="${theme}"]`);
  assert.ok(r, `no [data-theme="${theme}"] block`);
  return Object.fromEntries([...r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
};

const parse = c => {
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return { rgb: [n >> 16 & 255, n >> 8 & 255, n & 255], a: 1 }; }
  m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] == null ? 1 : +m[4] };
  throw new Error(`unparsed colour ${c}`);
};
const resolve = (value, tk) => { const m = value.match(/^var\((--[\w-]+)\)$/); return m ? resolve(tk[m[1]] ?? assert.fail(`no token ${m[1]}`), tk) : value; };
const over = (fg, a, bg) => fg.map((x, i) => a * x + (1 - a) * bg[i]);
const lum = c => { const [r, g, b] = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The backgrounds an unfollowed star sits on: the table and panel surfaces, a hovered row, and
// the highlighted (selected) row, whose accent-surface is translucent in dark mode.
const backgrounds = tk => {
  const surface = parse(resolve('var(--bg-surface)', tk)).rgb;
  const out = {};
  for (const k of ['--bg-surface', '--bg-surface-alt', '--bg-body', '--row-hover', '--accent-surface']) {
    const c = parse(resolve(`var(${k})`, tk));
    out[k] = over(c.rgb, c.a, surface);
  }
  return out;
};

// The rules that style an unfollowed star: any selector naming .star-btn, except the followed
// state and the labelled pill (which sets its own text colour and border).
const idleRules = (state = '') => rules.filter(r => r.sel.split(',').some(s => {
  s = s.trim();
  return /\.star-btn(?![-\w])/.test(s) && !/\.starred|\.star-btn-label|:focus/.test(s) && (state ? s.includes(state) : !/:hover|:active/.test(s));
}));
const effective = (list, base = { color: '#000000', opacity: 1 }) => {
  let color = base.color, opacity = base.opacity;
  for (const r of list) {   // source order; a lower opacity anywhere only makes it fainter
    const c = decl(r.body, 'color'); if (c) color = c;
    const o = decl(r.body, 'opacity'); if (o != null) opacity = Math.min(opacity, parseFloat(o));
  }
  return { color, opacity };
};

for (const theme of ['light', 'dark']) {
  test(`#136: the unfollowed ☆ reaches 3:1 on every background, ${theme}`, () => {
    const tk = tokens(theme), bgs = backgrounds(tk);
    const { color, opacity } = effective(idleRules());
    const fg = parse(resolve(color, tk));
    for (const [name, bg] of Object.entries(bgs)) {
      const r = ratio(over(fg.rgb, fg.a * opacity, bg), bg);
      assert.ok(r >= 3, `${theme}: ☆ ${color} at opacity ${opacity} on ${name} is ${r.toFixed(2)}:1`);
    }
  });

  test(`#136: the hovered ☆ stays at 3:1 or more, ${theme}`, () => {
    const tk = tokens(theme), bgs = backgrounds(tk);
    const base = effective(idleRules());
    const { color, opacity } = effective(idleRules(':hover'), base);
    const fg = parse(resolve(color, tk));
    for (const [name, bg] of Object.entries(bgs)) {
      const r = ratio(over(fg.rgb, fg.a * opacity, bg), bg);
      assert.ok(r >= 3, `${theme}: hovered ☆ on ${name} is ${r.toFixed(2)}:1`);
    }
  });
}

test('#136: the star colour is a token defined in both themes, and the followed ★ is unchanged', () => {
  const base = rules.find(r => r.sel === '.star-btn');
  assert.equal(decl(base.body, 'color'), 'var(--star-idle)');
  for (const theme of ['light', 'dark']) assert.ok(tokens(theme)['--star-idle'], `--star-idle missing in ${theme}`);
  const starred = rules.find(r => r.sel === '.star-btn.starred');
  assert.equal(decl(starred.body, 'color'), 'var(--star-color)');
  assert.equal(decl(starred.body, 'opacity'), '1');
});

test('#136: the "ECNL Girls" link is relative, so it never leaves the current host', () => {
  const a = html.match(/<a class="section-label"[^>]*>ECNL Girls<\/a>/);
  assert.ok(a, 'the ECNL Girls link is missing');
  assert.match(a[0], / href="\/"/);
  assert.match(a[0], /onclick="return goHome\(event\)"/);
  // goHome intercepts only a same-host link; with href="/" that is every host.
  assert.ok(html.includes("if (!link || link.host !== location.host) return true;"));
});

test('#136: no link in the page points at the production origin', () => {
  // Absolute production URLs are allowed only where they must be absolute: the canonical link
  // and the social-card metadata. Nothing a visitor clicks may carry one.
  const prod = /https?:\/\/ecnl\.nextonetwo\.com/;
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]).filter(t => prod.test(t));
  assert.deepEqual(anchors, []);
  const hrefs = [...html.matchAll(/href\s*=\s*["'`]([^"'`]*)/g)].map(m => m[1]).filter(h => prod.test(h));
  assert.deepEqual(hrefs, ['https://ecnl.nextonetwo.com/'], 'only the canonical <link> may name the origin');
  assert.match(html, /<link rel="canonical" href="https:\/\/ecnl\.nextonetwo\.com\/">/);
});
