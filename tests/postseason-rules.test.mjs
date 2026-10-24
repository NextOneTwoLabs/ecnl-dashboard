// #194: the reviewed postseason rules files (public/data/postseason-<season>.json) against the owner's
// document, "2026-27 ECNL Girls Post-Season Structure". The national field sizes and each tier's age
// groups below are written here from the document, never read from the file under test: 48 U13-U17
// Champions League places per age (47 direct + the winner of the one North Atlantic v New England
// play-in), 16 U18/19 qualifiers, 16 North American Cup (U15-U17), 16 Showcase Cup A and 8 Showcase
// Cup B (U16-U17). Also: the walk reproduces every place the document prints, the rules fit the
// archived 2026-27 tables (divisions where the manifest has two flights), and the page's
// POSTSEASON_SEASONS lists exactly the seasons that have a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const html = readFileSync(new URL('index.html', root), 'utf8');
const files = readdirSync(new URL('data/', root)).filter(f => /^postseason-.*\.json$/.test(f)).sort();
const sources = read('data/sources.json');
const manifest = read('archive/manifest.json');

const AGES = ['U13', 'U14', 'U15', 'U16', 'U17', 'U18/19'];
const TIER_AGES = {   // from the document's national section
  CL: ['U13', 'U14', 'U15', 'U16', 'U17'], CLPI: ['U13', 'U14', 'U15', 'U16', 'U17'], CL18: ['U18/19'],
  NAC: ['U15', 'U16', 'U17'], SA: ['U16', 'U17'], SB: ['U16', 'U17'],
};
const FIELD = { CL: 47, CL18: 16, NAC: 16, SA: 16, SB: 8 };   // per age; CL direct places, the play-in pair apart

test('POSTSEASON_SEASONS in the page lists exactly the seasons with a rules file (MF2)', () => {
  const m = /\n {4}const POSTSEASON_SEASONS = \[([^\]]*)\];\n/.exec(html);
  assert.ok(m, 'POSTSEASON_SEASONS is in index.html');
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(listed, files.map(f => f.slice('postseason-'.length, -'.json'.length)));
  assert.ok(listed.includes('2026-27'));
});

for (const file of files) {
  const rules = read(`data/${file}`);
  const season = file.slice('postseason-'.length, -'.json'.length);

  test(`${file}: schema, season, source and every rule's fields`, () => {
    assert.equal(rules.schema, 1);
    assert.equal(rules.season, season);
    assert.equal(rules.source.title, `${season} ECNL Girls Post-Season Structure`);
    assert.match(rules.source.driveFileId, /^[\w-]{20,}$/);
    assert.deepEqual(Object.keys(rules.tiers).sort(), Object.keys(TIER_AGES).sort());
    for (const [k, t] of Object.entries(rules.tiers)) {
      assert.deepEqual(t.ages, TIER_AGES[k], `${k}: ages`);
      assert.ok(t.label && t.short && t.short.length <= 3, k);
    }
    assert.match(rules.tiers.CL18.label, /starts with a play-in/, 'B4: the U18/19 tag always says it starts with a play-in');
    assert.deepEqual(Object.keys(rules.conferences).sort(), Object.keys(sources.seasons[season].conferences).sort(), 'the catalog\'s conferences');
    for (const [conf, c] of Object.entries(rules.conferences)) {
      assert.ok(c.docName, conf);
      for (const r of c.rules) {
        const at = `${conf} ${r.tier} ${r.ages}`;
        assert.ok(Number.isInteger(r.next) && r.next > 0, at);
        assert.ok(r.ages.length && r.ages.every(a => rules.tiers[r.tier].ages.includes(a)), `${at}: a tier only in its own ages`);
        assert.match(r.doc, /based on PPG from Conference games only/, `${at}: the document's line`);
        assert.ok([undefined, 'division', 'pooled'].includes(r.scope), at);
        assert.ok([undefined, 'leagueCupWinner'].includes(r.or), at);
        assert.ok([undefined, 'cupOrPlayIn', 'playIn'].includes(r.alt), at);
        assert.equal(r.opponent !== undefined, r.tier === 'CLPI', `${at}: a play-in names its opponent conference`);
        if (r.opponent) assert.ok(rules.conferences[r.opponent] && r.opponent !== conf, at);
        const keys = Object.keys(r).filter(k => !['ages', 'tier', 'next', 'scope', 'or', 'alt', 'opponent', 'printed', 'doc', 'docNote'].includes(k));
        assert.deepEqual(keys, [], `${at}: no unknown field`);
      }
      for (const age of AGES) {   // a division rule never follows a pooled one (the walk takes divisions first)
        const scopes = c.rules.filter(r => r.ages.includes(age)).map(r => r.scope || 'table');
        const firstPooled = scopes.indexOf('pooled');
        if (firstPooled >= 0) assert.ok(!scopes.slice(firstPooled).includes('division'), `${conf} ${age}: divisions before pooled places`);
      }
    }
  });

  // The season's conference tables as archived: { conference: { age: [team counts per flight] } }.
  const tables = {};
  for (const [key, ev] of Object.entries(manifest.events)) {
    if (!key.startsWith(season + '/') || ev.kind !== 'conference') continue;
    tables[ev.name] = {};
    for (const d of ev.divisions) (tables[ev.name][d.divisionName.replace(/^G/, '')] ||= []).push(d.teams);
  }
  const haveTables = Object.keys(tables).length > 0;

  test(`${file}: the national fields add up to the document's, and the walk lands on every printed place`, { skip: !haveTables && 'no archived tables for this season' }, () => {
    for (const age of AGES) {
      const total = { CL: 0, CL18: 0, NAC: 0, SA: 0, SB: 0 }, playIn = [];
      for (const [conf, c] of Object.entries(rules.conferences)) {
        const divisions = (tables[conf] && tables[conf][age] || []).length;
        assert.ok(divisions >= 1, `${conf} ${age}: archived`);
        let at = 0;
        for (const r of c.rules.filter(x => x.ages.includes(age))) {
          const take = r.scope === 'division' ? r.next * divisions : r.next;
          if (r.tier === 'CLPI') playIn.push(conf); else total[r.tier] += take;
          if (r.printed) {
            const walk = Array.from({ length: take }, (_, i) => at + 1 + i);
            if (r.alt) {   // "4th or 5th": one team, and the walk gives the later place
              assert.equal(take, 1, `${conf} ${age} ${r.tier}`);
              assert.deepEqual(r.printed, [walk[0] - 1, walk[0]], `${conf} ${age} ${r.tier}: the later of the printed pair`);
            } else assert.deepEqual(r.printed, walk, `${conf} ${age} ${r.tier}: printed places`);
          }
          at += take;
        }
        assert.ok(at <= tables[conf][age].reduce((a, b) => a + b, 0), `${conf} ${age}: no more places than teams`);
      }
      const want = {
        CL: TIER_AGES.CL.includes(age) ? FIELD.CL : 0, CL18: age === 'U18/19' ? FIELD.CL18 : 0,
        NAC: TIER_AGES.NAC.includes(age) ? FIELD.NAC : 0, SA: TIER_AGES.SA.includes(age) ? FIELD.SA : 0, SB: TIER_AGES.SB.includes(age) ? FIELD.SB : 0,
      };
      assert.deepEqual(total, want, `${age}: the national fields`);
      assert.deepEqual(playIn.sort(), TIER_AGES.CLPI.includes(age) ? ['New England', 'North Atlantic'] : [], `${age}: one North Atlantic v New England play-in`);
    }
  });

  test(`${file}: divisions are used exactly where the archived tables have two flights`, { skip: !haveTables && 'no archived tables for this season' }, () => {
    assert.deepEqual(Object.keys(tables).sort(), Object.keys(rules.conferences).sort(), 'the archived conferences');
    const divided = [];
    for (const [conf, ages] of Object.entries(tables)) {
      for (const [age, flights] of Object.entries(ages)) {
        const list = rules.conferences[conf].rules.filter(r => r.ages.includes(age));
        assert.ok(list.length, `${conf} ${age}: has rules`);
        const usesDivisions = list.some(r => r.scope === 'division' || r.scope === 'pooled');
        assert.equal(usesDivisions, flights.length > 1, `${conf} ${age}: ${flights.length} flight(s)`);
        if (flights.length > 1) {
          divided.push(`${conf} ${age}`);
          assert.ok(list.every(r => r.scope === 'division' || r.scope === 'pooled'), `${conf} ${age}: every rule says how divisions count`);
        }
      }
    }
    // As the document describes 2026-27; a refresh that changes it should turn this red (the page shows no places then).
    if (season === '2026-27') assert.deepEqual(divided.sort(), ['Midwest U13', 'Midwest U14', 'Ohio Valley U15', 'Ohio Valley U16', 'Ohio Valley U17']);
  });
}
