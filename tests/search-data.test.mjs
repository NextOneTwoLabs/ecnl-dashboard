// #158: the search data files (public/archive/search/core.json and games-<season>.json), the
// prepared records the page's search will read. The Python side (tests/test_search_data.py)
// covers the build; this file covers what the browser side relies on:
//   - undateBorrowedDates in index.html and its Python port agree on one shared fixture;
//   - tests/search/search-data-format.mjs decodes every committed games file back to its source rows
//     (each side's own team id, name and club; flight; scores and PKs; date and time; field) (MF7);
//   - dates: no date stays null, a day before the base decodes with floor division (MF4);
//   - the frozen fixture: its checksums, its provenance (MF6), parity with PR 1's frozen directory,
//     and the facts PR 1's judged queries cite;
//   - no logo or image in any games file (MF8 option a).
// Run under the netguard: node --import ./tests/netguard/netguard.mjs --test tests/search-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeGames, decodeWhen, FLAGS, GAMES_SCHEMA, CORE_SCHEMA, PLACES_SCHEMA } from './search/search-data-format.mjs';
import { readJSON, readLF, sha, lf, IMAGE, FIXTURES, refsOf, refKind } from './search/judged.mjs';

const ROOT = new URL('../', import.meta.url);
const SEARCH = new URL('public/archive/search/', ROOT);
const SCHEDULES = new URL('public/archive/api/Event/get-schedules-by-flight/', ROOT);
const FX = new URL('search/', FIXTURES);
const gamesFiles = dir => readdirSync(dir).filter(n => /^games-\d{4}-\d{2}\.json$/.test(n)).sort();
const squash = s => String(s || '').split(/\s+/).filter(Boolean).join(' ');

// ---------- undateBorrowedDates: the page's function and the Python port, on one fixture ----------
function pageUndate() {
  const html = lf(readFileSync(new URL('public/index.html', ROOT), 'utf8'));
  const start = html.indexOf('    function undateBorrowedDates(games) {\n');
  assert.ok(start > 0, 'index.html: undateBorrowedDates not found');
  const end = html.indexOf('\n    }\n', start);
  return new Function(`${html.slice(start, end + 6)}; return undateBorrowedDates;`)();
}

test('undateBorrowedDates (index.html) matches the shared fixture the Python port also runs', () => {
  const undate = pageUndate();
  const { cases } = readJSON(new URL('borrowed-dates.json', FIXTURES));
  assert.ok(cases.length >= 10);
  for (const c of cases) {
    const input = structuredClone(c.games);
    const out = undate(c.games);
    assert.deepEqual(c.games, input, `${c.name}: input not mutated`);
    const want = input.map(g => (c.undated.includes(g.matchID) ? { ...g, gameDate: null, dateUnconfirmed: true } : g));
    assert.deepEqual(out, want, c.name);
  }
});

// ---------- the committed games files decode back to their source rows (MF7) ----------
function sourceGames() {
  const src = new Map();
  for (const e of readdirSync(SCHEDULES)) for (const f of readdirSync(new URL(`${e}/`, SCHEDULES))) {
    for (const g of JSON.parse(readFileSync(new URL(`${e}/${f}/0.json`, SCHEDULES), 'utf8')).data || []) src.set(g.matchID, g);
  }
  return src;
}
const PLACEHOLDER = /^(tbd|tba|to be determined)$/;
const named = c => { const n = squash(c).toLowerCase().replace(/[^a-z0-9 ]+/g, ''); return !!n.trim() && !PLACEHOLDER.test(n.split(/\s+/).filter(Boolean).join(' ')); };

test('every committed games file decodes to every game of the archive, once, with its own facts', () => {
  const src = sourceGames(), seen = new Set();
  for (const n of gamesFiles(SEARCH)) {
    const doc = JSON.parse(readLF(new URL(n, SEARCH)));
    assert.equal(`games-${doc.season}.json`, n);
    for (const g of decodeGames(doc)) {
      const s = src.get(g.matchID);
      assert.ok(s, `${n}: ${g.matchID} not in any schedule file`);
      assert.ok(!seen.has(g.matchID), `${g.matchID} twice`);
      seen.add(g.matchID);
      assert.equal(g.flightID, s.flightID, `${g.matchID} flight`);
      assert.equal(g.eventID, s.eventID, `${g.matchID} event`);
      for (const side of ['home', 'away']) {
        const id = s[`${side}teamID`];
        const want = id == null ? { teamID: null, name: squash(s[`${side}Team`]) || null, clubID: null }
          : { teamID: id, name: squash(s[`${side}Team`]), clubID: s[`${side === 'home' ? 'homeTeam' : 'awayTeam'}ClubID`] };
        assert.deepEqual(g[side], want, `${g.matchID} ${side}`);
      }
      assert.deepEqual(g.score, [s.hometeamscore, s.awayteamscore], `${g.matchID} score`);
      assert.deepEqual(g.pk, [s.hometeamPKscore, s.awayteamPKscore], `${g.matchID} pk`);
      const d = s.gameDate || '';
      if (g.flags & FLAGS.undated) assert.equal(g.date, null, `${g.matchID}: an undated leg has no date`);
      else if (!d || +d.slice(0, 4) < 1900) assert.deepEqual([g.date, g.time], [null, null], `${g.matchID}: no date in the source`);
      else assert.deepEqual([g.date, g.time], [d.slice(0, 10), d.slice(11, 16) === '00:00' ? null : d.slice(11, 16)], `${g.matchID} when`);
      assert.equal(g.field ? g.field.complexID : null, named(s.complex) ? s.complexID : null, `${g.matchID} field`);
      assert.equal(!!(g.flags & FLAGS.reconstructed), !!s.reconstructed, `${g.matchID} reconstructed`);
    }
  }
  assert.equal(seen.size, src.size, 'every game of the archive is in a games file');
});

test('dates: a day before the base decodes with floor division; no time and no date stay null (MF4)', () => {
  assert.deepEqual(decodeWhen(-2459100, '2023-07-01'), { date: '2022-10-28', time: '09:00' });
  assert.deepEqual(decodeWhen(-19999, '2023-07-01'), { date: '2023-06-29', time: '00:01' });
  assert.deepEqual(decodeWhen(9999, '2023-07-01'), { date: '2023-07-01', time: null });
  assert.deepEqual(decodeWhen(null, '2023-07-01'), { date: null, time: null });
  // 538653 (2023-24 Southwest) is dated 2022-10-28, before its season's base.
  const g = decodeGames(JSON.parse(readLF(new URL('games-2023-24.json', SEARCH)))).find(x => x.matchID === 538653);
  assert.deepEqual([g.date, g.time], ['2022-10-28', '09:00']);
  // The 0001-01-01 sentinel (172092 and the 2021-22 Bye rows) and the empty date (275826): no date.
  const all = gamesFiles(SEARCH).flatMap(n => decodeGames(JSON.parse(readLF(new URL(n, SEARCH)))));
  for (const id of [172092, 337987, 337992, 337994, 338006, 338008, 275826]) {
    const x = all.find(y => y.matchID === id);
    assert.equal(x.date, null, `${id}`);
    assert.equal(x.flags & FLAGS.undated, 0, `${id}: no date is not an undated leg`);
  }
  assert.ok(all.some(x => x.flags & FLAGS.bye), 'Byes are flagged');
});

test('no games file holds a logo or an image URL; rows and tables have only the documented keys', () => {
  for (const dir of [SEARCH, FX]) for (const n of gamesFiles(dir)) {
    const text = readLF(new URL(n, dir));
    assert.doesNotMatch(text, IMAGE, n);
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc), ['schema', 'season', 'base', 'build', 'flights', 'teams', 'alt', 'fields', 'games'], n);
    for (const r of doc.games) assert.ok(r.length <= 13, `${n}: a row has at most 13 values`);
  }
});

// ---------- the frozen fixture (#158 MF6) ----------
const manifest = readJSON(new URL('MANIFEST.json', FIXTURES));

test('fixture: each search data file\'s LF checksum and size match MANIFEST.search, from MANIFEST\'s commit', () => {
  const m = manifest.search;
  assert.equal(m.commit, manifest.commit);
  assert.deepEqual(Object.keys(m.files).sort(), ['core.json', 'places.json', ...gamesFiles(FX)].sort());
  for (const [n, f] of Object.entries(m.files)) {
    const text = readLF(new URL(n, FX));
    assert.equal(sha(text), f.sha256, `${n} checksum`);
    assert.equal(Buffer.byteLength(text), f.bytes, `${n} bytes`);
  }
  assert.equal(gamesFiles(FX).length, 7, 'all seven seasons (Q6)');
});

test('fixture: built by this builder from these reviewed inputs (else re-freeze; README "Search data")', () => {
  const lfSha = url => createHash('sha256').update(readFileSync(url).toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
  assert.equal(manifest.search.builder, lfSha(new URL('search_data.py', ROOT)), 'search_data.py changed: re-freeze the fixture');
  // #159: every reviewed input, null for one not committed yet (the census table before its download).
  const inputs = ['field-aliases.json', 'zip-fixes.json', 'zip-places.json', 'zip-place-fixes.json', 'city-counties.json'];
  assert.deepEqual(Object.keys(manifest.search.inputs).sort(), [...inputs].sort());
  for (const n of inputs) {
    const url = new URL(`public/data/${n}`, ROOT);
    assert.equal(manifest.search.inputs[n], existsSync(url) ? lfSha(url) : null, `${n} changed: re-freeze the fixture`);
  }
});

test('fixture: core\'s teams, without x, equal PR 1\'s frozen directory (same commit, logos dropped)', () => {
  const core = JSON.parse(readLF(new URL('core.json', FX)));
  const pr1 = readJSON(new URL('directory.json', FIXTURES));
  const strip = d => { const { schema, build, ...rest } = d; return rest; };
  const teams = { ...core.teams, squads: core.teams.squads.map(({ x, ...sq }) => sq) };
  assert.deepEqual(strip(teams), strip(pr1));
  assert.ok(core.teams.clubs.every(c => c[2] === null), 'no logo in the fixture');
});

test('fixture: every closed-season game PR 1 cites has the same facts, and every field ref resolves', () => {
  const judged = readJSON(new URL('games-judged.json', FIXTURES));
  const games = new Map(gamesFiles(FX).flatMap(n => decodeGames(JSON.parse(readLF(new URL(n, FX))))).map(g => [g.matchID, g]));
  for (const j of judged.games) {
    const g = games.get(j.matchID);
    assert.ok(g, `${j.matchID} missing`);
    assert.equal(`${g.date}T${g.time || '00:00'}:00`, j.date, `${j.matchID} date`);
    assert.deepEqual([g.home.teamID, g.away.teamID], [j.home.teamID, j.away.teamID], `${j.matchID} teams`);
    assert.deepEqual([g.home.name, g.away.name], [squash(j.home.name), squash(j.away.name)], `${j.matchID} names`);
    assert.deepEqual(g.score, j.score, `${j.matchID} score`);
    assert.deepEqual(g.pk, j.pk, `${j.matchID} pk`);
    assert.equal(g.field && g.field.complexID, j.complexID, `${j.matchID} complex`);
    if (/^\d{5}$/.test(String(j.zip).trim())) assert.equal(g.field.zip, String(j.zip).trim(), `${j.matchID} zip`);
  }
  const places = JSON.parse(readLF(new URL('places.json', FX)));      // #159: fields live in places.json
  const doc = readJSON(new URL('../queries.json', FIXTURES));
  const all = [...games.values()];
  for (const q of doc.queries) for (const [, ref] of refsOf(q)) {
    if (refKind(ref) !== 'field') continue;
    const { name, zip, number } = ref.field;
    assert.ok(places.fields[`${name}@${zip}`], `${q.id}: field ${name}@${zip} not in places.json`);
    const at = all.filter(g => g.field && g.field.name === name && g.field.zip === zip);
    assert.ok(at.length, `${q.id}: no game at ${name}@${zip}`);
    if (number != null) assert.ok(at.some(g => g.number === number), `${q.id}: no game on field ${number}`);
  }
  // D6: Great Park @ 92618 is 12 complex IDs; its Field 15 has 57 games (PR 1's count).
  const gp = all.filter(g => g.field && g.field.name === 'Great Park' && g.field.zip === '92618');
  assert.deepEqual([...new Set(gp.map(g => g.field.complexID))].sort((a, b) => a - b), [80, 422, 1018, 2555, 2838, 3069, 3075, 3416, 4559, 6698, 7083, 7319]);
  assert.equal(gp.filter(g => g.number === 15).length, 57);
});

// #159: the census inputs and the places.json split changed only core and places.json; every frozen
// games file keeps the bytes #160 recorded, so game keys never depend on census data.
const GAMES_160 = {
  'games-2020-21.json': '4adadafd37810c0a6b30b62c146b468ec4c6b398129d9580aa2785676e1e96c6',
  'games-2021-22.json': '1b038fbca1dba9b397faea23b7e84f29c19267d28fdbf2e1ba7a63067b7ef851',
  'games-2022-23.json': 'c50e08d1c7469c801d8bccf6b232585760149d5f42484f15b1586ed33851b36c',
  'games-2023-24.json': '16d3203b3fcf8d7badd21b3ca3dcb671eb8e73d6feabaad43d1828b23f565b41',
  'games-2024-25.json': '366bf01df7c241a754cf9b2d734be69c1219f3ac5095b35c79291136a846a3a4',
  'games-2025-26.json': 'c84e811863faced6479b0f2a55d8c92745ed6a76e9a0922ca043eb2412850921',
  'games-2026-27.json': '73f40f6c55f17501142f2a05792f6a9744473811e32b931693c30595ed4561a2'
};

test('fixture: the seven games files are byte-identical to #160\'s (census data never reaches them)', () => {
  for (const [n, want] of Object.entries(GAMES_160)) assert.equal(manifest.search.files[n].sha256, want, n);
});

test('places.json: every place, county and club place reference resolves (committed and frozen)', () => {
  for (const dir of [SEARCH, FX]) {
    const p = JSON.parse(readLF(new URL('places.json', dir)));
    assert.equal(p.schema, 1);
    const ok = ([g, c]) => (g === null || g in p.places) && (c === null || c in p.counties);
    for (const [k, v] of Object.entries(p.fields)) assert.ok(ok(v.slice(3, 5)), `field ${k}`);
    for (const [k, v] of [...Object.entries(p.clubPlaces), ...Object.entries(p.eventPlaces)]) assert.ok(ok(v), k);
    for (const [g, v] of Object.entries(p.places)) assert.ok(v[2] === null || v[2] in p.counties, g);
    const core = JSON.parse(readLF(new URL('core.json', dir)));
    assert.equal(core.schema, 2);
    assert.equal('fields' in core, false);
  }
});

// #163: the decoder's schema constants are the builder's (CORE_SCHEMA was left at 1 by #159).
test('search-data-format.mjs: its schema constants equal search_data.py\'s', () => {
  const py = readLF(new URL('search_data.py', ROOT));
  const val = name => { const m = new RegExp(`^${name} = (\\d+)`, 'm').exec(py); assert.ok(m, name); return +m[1]; };
  assert.deepEqual([CORE_SCHEMA, PLACES_SCHEMA, GAMES_SCHEMA], [val('SCHEMA'), val('PLACES_SCHEMA'), val('GAMES_SCHEMA')]);
  assert.equal(JSON.parse(readLF(new URL('core.json', FX))).schema, CORE_SCHEMA);
});

// #163 (owner decision 149#6207974871): "index" means only the in-memory map. The old file and flag
// names are gone from every text file outside the archive data. The banned strings are built from
// pieces, so this file never matches itself.
const BANNED = [['search', '_index'], ['search', '-index'], ['index', '-format'], ['search', '_index', '_size']].map(p => p.join(''));
function textFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    const rel = url.pathname.slice(ROOT.pathname.length);
    if (e.isDirectory()) {
      if (['.git/', 'public/archive/', 'node_modules/'].includes(rel) || e.name === '__pycache__' || e.name.startsWith('.parity-')) continue;
      textFiles(url, out);
    } else if (/\.(py|mjs|js|json|md|yml|yaml|toml|html|txt)$/.test(e.name)) out.push([rel, url]);
  }
  return out;
}
test('renames: no text file outside public/archive/ names the old search_data files or flag', () => {
  const files = textFiles(ROOT);
  assert.ok(files.length > 50 && files.some(([r]) => r === 'archive.py') && files.some(([r]) => r === '.github/workflows/api-tests.yml'), 'the walk sees the tree');
  const hits = [];
  for (const [rel, url] of files) {
    const text = readFileSync(url, 'utf8');
    for (const b of BANNED) if (text.includes(b)) hits.push(`${rel}: ${b}`);
  }
  assert.deepEqual(hits, []);
  assert.ok(['python ' + BANNED[0] + '.py'].some(s => BANNED.some(b => s.includes(b))), 'the check has teeth');
  for (const n of ['search_data.py', 'tests/test_search_data.py', 'tests/search-data.test.mjs', 'tests/search/search-data-format.mjs', 'tools/search_data_size.mjs'])
    assert.ok(existsSync(new URL(n, ROOT)), n);
});
