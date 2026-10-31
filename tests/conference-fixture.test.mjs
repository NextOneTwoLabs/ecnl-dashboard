// #203: the frozen conference (tests/fixtures/conference/) is what its MANIFEST says. It is a fixture, not a mirror of the archive:
// it changes only by tests/fixtures/conference/freeze.mjs in a reviewed PR. These tests check the files against the MANIFEST (sha256
// over LF text, so a CRLF checkout hashes the same), that none is added or missing, that the pick of pick.mjs still finds the
// conference the MANIFEST names, and that the catalog and the clubs the conference-sheet tests pair it with are the ones it was
// frozen for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { findFix } from './fixtures/conference/pick.mjs';

const DIR = new URL('./fixtures/conference/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL('MANIFEST.json', DIR), 'utf8'));
const SOURCES = JSON.parse(readFileSync(new URL('./search/fixtures/sources.json', import.meta.url), 'utf8'));
const lf = s => s.replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(lf(s), 'utf8').digest('hex');
const walk = (url, base = '') => readdirSync(url).flatMap(n => statSync(new URL(n, url)).isDirectory() ? walk(new URL(n + '/', url), base + n + '/') : [base + n]);

test('#203: every conference fixture file matches the MANIFEST, and none is added or missing', () => {
  const have = walk(DIR).filter(f => !['MANIFEST.json', 'pick.mjs', 'freeze.mjs'].includes(f)).sort();
  assert.deepEqual(have, Object.keys(MANIFEST.files).sort());
  assert.equal(have.length, 3, 'the hierarchy, one standings file and one schedule');
  for (const [rel, want] of Object.entries(MANIFEST.files)) {
    const text = readFileSync(new URL(rel, DIR), 'utf8');
    assert.equal(sha(text), want.sha256, rel);
    assert.equal(Buffer.byteLength(lf(text)), want.bytes, `${rel}: bytes`);
  }
  assert.ok(Object.values(MANIFEST.files).reduce((a, f) => a + f.bytes, 0) < 200_000, 'a small fixture');
});

test('#203: the pick finds the frozen conference, on the catalog it was frozen for', () => {
  assert.equal(SOURCES.refresh.activeSeason, MANIFEST.activeSeason, 'tests/search/fixtures/sources.json was re-frozen for another season: re-run tests/fixtures/conference/freeze.mjs');
  const fix = findFix(DIR, SOURCES.seasons, MANIFEST.activeSeason);
  assert.ok(fix, 'no conference in the fixture has the property of the pick');
  assert.deepEqual({ conference: fix.conf, eventId: fix.eventId, divisionId: fix.divisionId, flightId: fix.flightId, age: fix.age, teams: fix.teams.length }, MANIFEST.pick);
  assert.ok(fix.teams.length >= 6);
});

test('#203: the clubs the conference tests read are the history fixture\'s, which has its own MANIFEST (no second copy)', () => {
  const clubs = new URL('./fixtures/history/archive/clubs.json', import.meta.url);
  assert.ok(existsSync(clubs));
  assert.ok(!existsSync(new URL('archive/clubs.json', DIR)), 'a second copy of clubs.json');
  const history = JSON.parse(readFileSync(new URL('./fixtures/history/MANIFEST.json', import.meta.url), 'utf8'));
  assert.ok(history.files['archive/clubs.json'], 'the history MANIFEST guards clubs.json');
  assert.equal(sha(readFileSync(clubs, 'utf8')), history.files['archive/clubs.json'].sha256);
});
