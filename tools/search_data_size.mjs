// #158: sizes and parse times of the search data files (public/archive/search/, or a directory
// given as the first argument). Per file: raw bytes, gzip at levels 6 and 9, brotli at quality 11
// (the transfer size: Cloudflare compresses JSON on the wire), the median JSON.parse time over 15
// runs, and for a games file the median decode time with tests/search/search-data-format.mjs.
// With --index (#163): also the in-memory index the page builds from core.json and places.json:
// the first (cold) buildIndex, the median of 15, the heap it holds (run with --expose-gc for that),
// and its documents, terms and postings.
// Reads local files only. Run it under the netguard:
//   node --import ./tests/netguard/netguard.mjs [--expose-gc] tools/search_data_size.mjs [dir] [--index]
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeGames } from '../tests/search/search-data-format.mjs';

const argv = process.argv.slice(2), withIndex = argv.includes('--index'), dirArg = argv.find(a => !a.startsWith('--'));
const dir = dirArg ? pathToFileURL(resolve(dirArg) + '/') : new URL('../public/archive/search/', import.meta.url);
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

if (withIndex) {
  const { buildIndex } = await import('../public/search/search.mjs');
  const data = { core: JSON.parse(readFileSync(new URL('core.json', dir), 'utf8')), places: JSON.parse(readFileSync(new URL('places.json', dir), 'utf8')) };
  const gc = globalThis.gc;
  if (gc) gc();
  const before = process.memoryUsage().heapUsed;
  let t = performance.now();
  const index = buildIndex(data);
  const cold = performance.now() - t;
  if (gc) gc();
  const held = process.memoryUsage().heapUsed - before;
  const warm = median(() => buildIndex(data));
  console.log(`\nIndex (public/search/search.mjs): cold buildIndex ${cold.toFixed(1)} ms, median of 15 ${warm.toFixed(1)} ms; ` +
    `${gc ? `heap held ${kb(held)} KB` : 'heap: run with --expose-gc'}; ${JSON.stringify(index.stats)}`);
}
