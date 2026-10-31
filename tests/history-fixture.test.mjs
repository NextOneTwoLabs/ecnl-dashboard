// #201: the frozen history copy (tests/fixtures/history/) is what its MANIFEST says. It is a fixture, not a mirror of the
// archive: it changes only by tests/fixtures/history/freeze.mjs in a reviewed PR. These tests check the files against the
// MANIFEST (sha256 over LF text, so a CRLF checkout hashes the same), that no file is added or missing, that each pick still
// has its property, and that the catalog the tests pair it with is the one it was frozen for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dataset, allPicks, PICK_NAMES, NOTES, NOTES_WITH_REGROUP, pickFrom } from './fixtures/history/picks.mjs';

const DIR = new URL('./fixtures/history/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL('MANIFEST.json', DIR), 'utf8'));
const SEARCH_SOURCES = new URL('./search/fixtures/sources.json', import.meta.url);
const lf = s => s.replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(lf(s), 'utf8').digest('hex');
const walk = (url, base = '') => readdirSync(url).flatMap(n => statSync(new URL(n, url)).isDirectory() ? walk(new URL(n + '/', url), base + n + '/') : [base + n]);

test('#201: every fixture file matches the MANIFEST, and none is added or missing', () => {
  const have = walk(DIR).filter(f => !['MANIFEST.json', 'picks.mjs', 'freeze.mjs'].includes(f)).sort();
  assert.deepEqual(have, Object.keys(MANIFEST.files).sort());
  for (const [rel, want] of Object.entries(MANIFEST.files)) {
    const text = readFileSync(new URL(rel, DIR), 'utf8');
    assert.equal(sha(text), want.sha256, rel);
    assert.equal(Buffer.byteLength(lf(text)), want.bytes, `${rel}: bytes`);
  }
  assert.ok(Object.keys(MANIFEST.files).length >= 8 && Object.keys(MANIFEST.files).length <= 40, 'a small fixture');
  assert.deepEqual(MANIFEST.notes, NOTES, 'the named files of the note test are the ones picks.mjs names (#203)');
});

test('#201: each pick is a frozen file that has its property, on the catalog it was frozen for', () => {
  const data = dataset(DIR, SEARCH_SOURCES);
  assert.equal(data.OPEN, MANIFEST.activeSeason, 'the search fixture catalog and this fixture agree on the open season');
  assert.deepEqual(Object.keys(MANIFEST.picks).sort(), [...PICK_NAMES].sort());
  for (const name of PICK_NAMES) assert.ok(pickFrom(data, MANIFEST, name), name);
  assert.equal(data.files.length, new Set([...Object.values(MANIFEST.picks), ...NOTES]).size, 'no history file that is neither a pick nor a named file (#203)');
});

test('#201: the schedule each frozen squad opens with is frozen too (a pick never reads a missing file)', () => {
  const data = dataset(DIR, SEARCH_SOURCES);
  for (const doc of data.files.filter(d => !NOTES.includes(d.teamID) || Object.values(MANIFEST.picks).includes(d.teamID))) for (const sq of doc.squads) {
    const r = sq.seasons[sq.seasons.length - 1];
    assert.ok(data.scheduleOf(r.eventID, r.flightID), `${doc.teamID} ${r.season}: schedule ${r.eventID}/${r.flightID}`);
  }
  // The control for the predicates: a doc that has none of the properties is refused by pickFrom.
  const picks = allPicks(data);
  assert.ok(!picks.GP0(data.files.find(d => d.teamID === MANIFEST.picks.CUR)), 'CUR is not at 0 games');
});

test('#203: the named files of the "One TGS id" note test are frozen, and those that read a 2026-27 row still have one', () => {
  const data = dataset(DIR, SEARCH_SOURCES);
  for (const id of NOTES) {
    const doc = data.files.find(d => d.teamID === id);
    assert.ok(doc, `${id} is frozen`);
    const has = doc.squads.some(q => q.seasons.some(r => r.season === MANIFEST.activeSeason && String(r.teamID) === String(id)));
    assert.equal(has, NOTES_WITH_REGROUP.includes(id), `${id}: a ${MANIFEST.activeSeason} row exactly when picks.mjs says so`);
  }
});
