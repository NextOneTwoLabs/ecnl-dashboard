// #158: sizes and parse times of the search data files (public/archive/search/, or a directory
// given as the first argument). Per file: raw bytes, gzip at levels 6 and 9, brotli at quality 11
// (the transfer size: Cloudflare compresses JSON on the wire), the median JSON.parse time over 15
// runs, and for a games file the median decode time with tests/search/search-data-format.mjs.
// Reads local files only. Run it under the netguard:
//   node --import ./tests/netguard/netguard.mjs tools/search_data_size.mjs [dir]
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { decodeGames } from '../tests/search/search-data-format.mjs';

const dir = new URL(process.argv[2] ? `file://${process.argv[2].replace(/\/?$/, '/')}` : '../public/archive/search/', import.meta.url);
const kb = n => (n / 1024).toFixed(1);
const median = f => { const t = []; for (let i = 0; i < 15; i++) { const s = performance.now(); f(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return t[7]; };
const rows = [];
let games = { raw: 0, gz6: 0, br: 0 };
for (const n of readdirSync(dir).filter(n => /^(core|places|games-\d{4}-\d{2})\.json$/.test(n)).sort()) {
  const buf = readFileSync(new URL(n, dir)), text = buf.toString('utf8');
  const gz6 = gzipSync(buf, { level: 6 }).length, gz9 = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const parse = median(() => JSON.parse(text));
  const doc = JSON.parse(text);
  const decode = n.startsWith('games-') ? median(() => decodeGames(doc)) : null;
  if (n.startsWith('games-')) { games.raw += buf.length; games.gz6 += gz6; games.br += br; }
  rows.push([n, kb(buf.length), kb(gz6), kb(gz9), kb(br), parse.toFixed(2), decode == null ? '' : decode.toFixed(2)]);
}
console.log('| File | Raw KB | gzip 6 KB | gzip 9 KB | brotli 11 KB | JSON.parse ms | decode ms |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
console.log(`| all games files | ${kb(games.raw)} | ${kb(games.gz6)} | | ${kb(games.br)} | | |`);
console.log(`\nNode ${process.version}, median of 15 runs.`);
