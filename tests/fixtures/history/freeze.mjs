// #201: re-freezes tests/fixtures/history/, the small frozen copy of the team-history files the fragile picks run on.
// Reads committed files only: never runs git, never uses the network. Run it under the netguard:
//
//   node --import ./tests/netguard/netguard.mjs tests/fixtures/history/freeze.mjs --freeze --commit <sha>
//
// For each pick in picks.mjs it takes the first live history file (numeric id order) that has the property, then copies
// that file and, for every squad of it, the schedule of the flight of the squad's newest season, plus archive/clubs.json,
// all as LF text. MANIFEST.json records the pick -> team id, the active season and the sha256 of every file (over LF text,
// so a CRLF checkout hashes the same). The season catalog is not copied: the tests read tests/search/fixtures/sources.json,
// which has its own MANIFEST entry. Re-freezing is a reviewed PR.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dataset, allPicks, PICK_NAMES, squadFor } from './picks.mjs';

const args = process.argv.slice(2);
const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;
if (!args.includes('--freeze') || !commit || !/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('usage: freeze.mjs --freeze --commit <sha>');
const ROOT = new URL('../../../public/', import.meta.url);
const HERE = new URL('./', import.meta.url);
const lf = s => String(s).replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(lf(s), 'utf8').digest('hex');
const SEARCH_SOURCES = new URL('../../search/fixtures/sources.json', import.meta.url);

const live = dataset(ROOT, new URL('data/sources.json', ROOT));
const fixSources = JSON.parse(readFileSync(SEARCH_SOURCES, 'utf8'));
if (fixSources.refresh.activeSeason !== live.OPEN) throw new Error(`the search fixture's active season (${fixSources.refresh.activeSeason}) is not the live one (${live.OPEN}); the picks would see two seasons`);
if (!live.files.length) throw new Error('no history files in this checkout');

const picks = {}, docs = new Map();
const preds = allPicks(live);
for (const name of PICK_NAMES) {
  const doc = live.files.find(preds[name]);
  if (!doc) throw new Error(`no live history file has the property of ${name}`);
  picks[name] = doc.teamID; docs.set(doc.teamID, doc);
}

const out = new Map();   // path under HERE -> LF text
for (const [id, doc] of [...docs].sort((a, b) => a[0] - b[0])) {
  out.set(`archive/history/${id}.json`, lf(readFileSync(new URL(`archive/history/${id}.json`, ROOT), 'utf8')));
  for (const sq of doc.squads) {
    const r = sq.seasons[sq.seasons.length - 1], rel = `archive/api/Event/get-schedules-by-flight/${r.eventID}/${r.flightID}/0.json`;
    if (existsSync(new URL(rel, ROOT))) out.set(rel, lf(readFileSync(new URL(rel, ROOT), 'utf8')));
  }
}
out.set('archive/clubs.json', lf(readFileSync(new URL('archive/clubs.json', ROOT), 'utf8')));

rmSync(new URL('archive/', HERE), { recursive: true, force: true });
const files = {};
for (const [rel, text] of [...out].sort((a, b) => a[0].localeCompare(b[0]))) {
  mkdirSync(new URL('.', new URL(rel, HERE)), { recursive: true });
  writeFileSync(new URL(rel, HERE), text);
  files[rel] = { bytes: Buffer.byteLength(text), sha256: sha(text) };
}
const manifest = { schema: 1, activeSeason: live.OPEN, commit, picks, files, sources: 'tests/search/fixtures/sources.json (guarded by its own MANIFEST)' };
writeFileSync(new URL('MANIFEST.json', HERE), JSON.stringify(manifest, null, 2) + '\n');
console.log(`froze ${docs.size} history files, ${Object.keys(files).length} files in all, picks ${JSON.stringify(picks)}`);
