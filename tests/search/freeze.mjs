// #156: re-freezes the judged set's fixtures, re-vendors today's search, and records the baseline.
// Reads committed files only: never runs git, never uses the network. Run it under the netguard:
//
//   node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --freeze --commit <sha>
//   node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --vendor
//   node --import ./tests/netguard/netguard.mjs tests/search/freeze.mjs --record today
//
// --freeze copies public/archive/directory.json and public/data/sources.json (as LF text), takes
// refresh-state.json's updatedAt, and extracts every cited closed-season game and every cited
// field from the schedule files into games-judged.json. Club logos are dropped everywhere (#117). It fails on a cited
// game it cannot find or one in the active season. --commit names the commit the working tree
// holds; it is recorded, not checked. Re-freezing is a reviewed PR: re-record the baseline after.
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ROOT, HERE, FIXTURES, FIXTURE_FILES, lf, sha, readLF, readJSON, stable, refsOf, refKind, fieldName, fieldNumber, fieldKey,
  trimGame, SCHEDULES, IMAGE, slicesOf, vendoredText, vendoredSlices, engineSha, loadFixtures, todayAdapter, baselineOf,
} from './judged.mjs';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const arg = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const write = (url, text) => writeFileSync(url, lf(text));
const MANIFEST = new URL('MANIFEST.json', FIXTURES);
const QUERIES = new URL('queries.json', HERE);
const VENDORED = new URL('engines/today.js', HERE);
const readManifest = () => { try { return readJSON(MANIFEST); } catch { return { schema: 1, retired: null }; } };
const writeManifest = m => write(MANIFEST, stable(m));

if (has('--vendor')) {
  const s = slicesOf(readLF(new URL('public/index.html', ROOT)));
  if (!s) throw new Error('index.html: the search markers are missing; set MANIFEST.retired instead of re-vendoring');
  mkdirSync(new URL('engines/', HERE), { recursive: true });
  write(VENDORED, vendoredText(s));
  const m = readManifest(); m.engineSha = engineSha(s); writeManifest(m);
  console.log(`vendored ${s.engine.split('\n').length + s.page.split('\n').length} lines, engineSha ${m.engineSha}`);
}

if (has('--freeze')) {
  const commit = arg('--commit');
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('--freeze needs --commit <sha>');
  const doc = readJSON(QUERIES), aliases = doc.vocabulary.fieldAliases;
  mkdirSync(FIXTURES, { recursive: true });
  // Club logos are dropped (#117, MF8): today's search only draws them, never matches on them.
  const dirObj = JSON.parse(readLF(new URL('public/archive/directory.json', ROOT)));
  for (const c of dirObj.clubs) c[2] = null;
  const directory = JSON.stringify(dirObj) + '\n';
  const sourcesText = readLF(new URL('public/data/sources.json', ROOT));
  const sources = JSON.parse(sourcesText);
  const active = sources.refresh.activeSeason;
  const updatedAt = readJSON(new URL('public/archive/refresh-state.json', ROOT)).updatedAt;
  // every event (conference seasons included) -> its season
  const seasonOfEvent = new Map();
  for (const [s, e] of Object.entries(sources.seasons))
    for (const list of [e.national, e.showcases, e.conferences]) for (const ev of Object.values(list || {})) if (ev && ev.eventId) seasonOfEvent.set(ev.eventId, s);
  const cited = new Set(), fieldRefs = new Map();
  for (const q of doc.queries) for (const [, ref] of refsOf(q)) {
    const k = refKind(ref);
    if (k === 'game') cited.add(ref.game);
    if (k === 'field') {
      const key = fieldKey(ref.field.name, ref.field.zip);
      if (!fieldRefs.has(key)) fieldRefs.set(key, new Set());
      if (ref.field.number != null) fieldRefs.get(key).add(ref.field.number);
    }
  }
  const games = new Map(), fields = new Map([...fieldRefs.keys()].map(k => [k, { complexIDs: new Set(), seasons: {}, numbers: {}, numberGames: {} }]));
  for (const ev of readdirSync(SCHEDULES)) for (const fl of readdirSync(new URL(`${ev}/`, SCHEDULES))) for (const f of readdirSync(new URL(`${ev}/${fl}/`, SCHEDULES))) {
    const path = `${ev}/${fl}/${f}`;
    for (const g of readJSON(new URL(path, SCHEDULES)).data || []) {
      const season = seasonOfEvent.get(g.eventID);
      if (!season) throw new Error(`event ${g.eventID} (${path}) has no season in sources.json`);
      if (cited.has(g.matchID)) {
        if (season === active) throw new Error(`cited game ${g.matchID} is in the active season ${active}`);
        games.set(g.matchID, trimGame(g, season, path));
      }
      const name = fieldName(g.complex, aliases), zip = String(g.zip || '').trim();
      const fk = name && fieldKey(name, zip);
      if (fk && fields.has(fk)) {
        const F = fields.get(fk), n = fieldNumber(g.venue);
        if (g.complexID != null) F.complexIDs.add(g.complexID);
        F.seasons[season] = (F.seasons[season] || 0) + 1;
        if (n != null) {
          F.numbers[n] = (F.numbers[n] || 0) + 1;
          if (fieldRefs.get(fk).has(n)) (F.numberGames[n] = F.numberGames[n] || new Set()).add(g.matchID);
        }
      }
    }
  }
  const missing = [...cited].filter(m => !games.has(m));
  if (missing.length) throw new Error(`cited games not found in the archive: ${missing.join(', ')}`);
  for (const [k, F] of fields) if (!F.complexIDs.size) throw new Error(`cited field ${k} has no game in the archive`);
  const judged = {
    about: 'The closed-season games and the fields the judged queries cite (#156). Trimmed: no logos. Fields are a normalised name plus zip (D6).',
    games: [...games.values()].sort((a, b) => a.matchID - b.matchID),
    fields: [...fields].map(([k, F]) => {
      const [name, zip] = k.split('@');
      return { name, zip, complexIDs: [...F.complexIDs].sort((a, b) => a - b), seasons: F.seasons, numbers: F.numbers,
        numberGames: Object.fromEntries(Object.entries(F.numberGames).map(([n, s]) => [n, [...s].sort((a, b) => a - b)])) };
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
  const judgedText = stable(judged);
  for (const [name, text] of [['directory.json', directory], ['games-judged.json', judgedText]])
    if (IMAGE.test(text)) throw new Error(`${name} must hold no logos or images`);
  write(new URL('directory.json', FIXTURES), directory);
  write(new URL('sources.json', FIXTURES), sourcesText);
  write(new URL('games-judged.json', FIXTURES), judgedText);
  const texts = { 'directory.json': directory, 'sources.json': sourcesText, 'games-judged.json': judgedText };
  const m = readManifest();
  Object.assign(m, {
    schema: 1, commit, refreshUpdatedAt: updatedAt, activeSeason: active, logos: 'dropped from directory.json (#117)',
    files: Object.fromEntries(FIXTURE_FILES.map(f => [f, { sha256: sha(texts[f]), bytes: Buffer.byteLength(lf(texts[f])) }])),
  });
  if (!('retired' in m)) m.retired = null;
  writeManifest(m);
  console.log(`froze ${FIXTURE_FILES.join(', ')} from ${commit} (refresh ${updatedAt}); ${games.size} games, ${fields.size} fields`);
}

if (has('--record')) {
  const engine = arg('--record');
  if (engine !== 'today') throw new Error('--record today (the only engine in PR 1)');
  const doc = readJSON(QUERIES), fx = loadFixtures();
  vendoredSlices(readLF(VENDORED));
  const base = baselineOf(doc, todayAdapter(fx, doc.context), fx);
  mkdirSync(new URL('baseline/', HERE), { recursive: true });
  write(new URL('baseline/today.json', HERE), stable(base));
  const o = base.summary.overall;
  console.log(`recorded baseline/today.json: ${o.pass} pass, ${o.fail} fail, ${o.unsupported} unsupported of ${o.queries}`);
}

if (!['--vendor', '--freeze', '--record'].some(has)) {
  console.error('usage: freeze.mjs [--vendor] [--freeze --commit <sha>] [--record today]');
  process.exit(2);
}
