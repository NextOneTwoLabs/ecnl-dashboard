// #203: re-freezes tests/fixtures/conference/, the one conference (hierarchy, one standings file, one schedule) the conference-sheet
// tests run on. Reads committed files only: never runs git, never uses the network. Run it under the netguard:
//
//   node --import ./tests/netguard/netguard.mjs tests/fixtures/conference/freeze.mjs --freeze --commit <sha>
//
// It takes the pick of pick.mjs on the live archive (first conference with a one-flight division of six or more teams whose sixth
// team has played), and copies its event's hierarchy, the division's standings and the flight's schedule as LF text. The season
// catalog is tests/search/fixtures/sources.json and the clubs are tests/fixtures/history/archive/clubs.json (each has its own MANIFEST),
// so nothing is copied twice. MANIFEST.json records the pick, the season, the commit and the sha256 of every file (over LF text, so a
// CRLF checkout hashes the same). Re-freezing is a reviewed PR.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { findFix, files } from './pick.mjs';

const args = process.argv.slice(2);
const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;
if (!args.includes('--freeze') || !commit || !/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('usage: freeze.mjs --freeze --commit <sha>');
const ROOT = new URL('../../../public/', import.meta.url);
const HERE = new URL('./', import.meta.url);
const lf = s => String(s).replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(lf(s), 'utf8').digest('hex');

const live = JSON.parse(readFileSync(new URL('data/sources.json', ROOT), 'utf8'));
const fixed = JSON.parse(readFileSync(new URL('../../search/fixtures/sources.json', import.meta.url), 'utf8'));
const season = fixed.refresh.activeSeason;
if (season !== live.refresh.activeSeason) throw new Error(`the search fixture's active season (${season}) is not the live one (${live.refresh.activeSeason})`);
const fix = findFix(ROOT, live.seasons, season);
if (!fix) throw new Error('no live conference has the property of the pick');

const from = files(ROOT), to = files(HERE);
const copy = [[from.hierarchyFile(fix.eventId), to.hierarchyFile(fix.eventId)],
  [from.standingsFile(fix.eventId, fix.divisionId, fix.flightId), to.standingsFile(fix.eventId, fix.divisionId, fix.flightId)],
  [from.scheduleFile(fix.eventId, fix.flightId), to.scheduleFile(fix.eventId, fix.flightId)]];
rmSync(new URL('archive/', HERE), { recursive: true, force: true });
const out = {};
for (const [src, dst] of copy) {
  const text = lf(readFileSync(src, 'utf8'));
  mkdirSync(new URL('.', dst), { recursive: true });
  writeFileSync(dst, text);
  out[dst.href.slice(HERE.href.length)] = { bytes: Buffer.byteLength(text), sha256: sha(text) };
}
const manifest = { schema: 1, activeSeason: season, commit, pick: { conference: fix.conf, eventId: fix.eventId, divisionId: fix.divisionId, flightId: fix.flightId, age: fix.age, teams: fix.teams.length },
  files: out, sources: 'tests/search/fixtures/sources.json', clubs: 'tests/fixtures/history/archive/clubs.json' };
writeFileSync(new URL('MANIFEST.json', HERE), JSON.stringify(manifest, null, 2) + '\n');
console.log(`froze ${copy.length} files for ${fix.conf} ${fix.age} (event ${fix.eventId}), ${Object.values(out).reduce((a, f) => a + f.bytes, 0)} bytes`);
