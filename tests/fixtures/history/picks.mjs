// #201: the picks that run on the frozen history fixture (tests/fixtures/history/). A library, not a test file: the
// tests are tests/team-overview-header.test.mjs, tests/team-overview.test.mjs and tests/history-fixture.test.mjs, and
// freeze.mjs (next to this file) chooses the files. Each pick is a property of one point in a season (a squad in
// progress with pending dated games, a squad at 0 games) or is thin on live data (3 or 4 files), so a refresh or the end of
// the season can make the live file disappear. The same predicates run here on the frozen files, as a precondition.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// ---------- the squad helpers the page tests share ----------
export const mineIn = (q, id) => q.seasons.filter(r => String(r.teamID) === String(id));
// The squad the page shows for a link to `season` (as renderTeamHistory picks it), and its newest row.
export function squadFor(doc, season) {
  const latest = q => (mineIn(q, doc.teamID).slice(-1)[0] || { season: '' }).season;
  return doc.squads.find(q => mineIn(q, doc.teamID).some(r => r.season === season))
    || doc.squads.slice().sort((a, b) => latest(b).localeCompare(latest(a)))[0];
}
export const newest = (doc, season) => { const q = squadFor(doc, season); return q.seasons[q.seasons.length - 1]; };
export const linkSeason = doc => (mineIn(doc.squads[0], doc.teamID).slice(-1)[0] || doc.squads[0].seasons.slice(-1)[0]).season;
export const unplayed = g => g.hometeamscore == null || g.awayteamscore == null;
export const day = g => (g.gameDate || '').slice(0, 10);
export const realDate = g => !g.dateUnconfirmed && day(g) >= '1900';

// ---------- a data set: history files, clubs, sources and schedules under one root ----------
// `base` holds archive/history/, archive/clubs.json and archive/api/Event/...; `sourcesUrl` the catalog.
export function dataset(base, sourcesUrl) {
  const hist = new URL('archive/history/', base);
  const files = existsSync(hist)
    ? readdirSync(hist).filter(f => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map(f => JSON.parse(readFileSync(new URL(f, hist), 'utf8')))
    : [];
  const SOURCES = JSON.parse(readFileSync(sourcesUrl, 'utf8'));
  const clubsFile = new URL('archive/clubs.json', base);
  const scheduleFile = (e, f) => new URL(`archive/api/Event/get-schedules-by-flight/${e}/${f}/0.json`, base);
  return {
    base, files, SOURCES, SEASONS: SOURCES.seasons, OPEN: SOURCES.refresh.activeSeason,
    CLUBS: existsSync(clubsFile) ? JSON.parse(readFileSync(clubsFile, 'utf8')) : { clubs: {} },
    scheduleFile,
    scheduleOf: (e, f) => existsSync(scheduleFile(e, f)) ? (JSON.parse(readFileSync(scheduleFile(e, f), 'utf8')).data || []) : null,
  };
}

// ---------- the picks ----------
// Header (team-overview-header.test.mjs): a current squad with an unplayed, dated game ahead in its schedule; an archived
// squad; a link whose season is older than its squad's newest row; a squad that has played no games.
export const HEADER = {
  CUR: ({ OPEN, scheduleOf }) => d => d.squads.length === 1 && (r => r.season === OPEN && r.inProgress && r.gp > 0 && Array.isArray(r.last) && r.form && r.last.length === r.form.length
    && new Set((scheduleOf(r.eventID, r.flightID) || []).filter(g => (g.hometeamID === r.teamID || g.awayteamID === r.teamID) && unplayed(g) && realDate(g)).map(day)).size >= 2)(newest(d, linkSeason(d))),
  OLD: ({ OPEN }) => d => d.squads.length === 1 && (r => r.season < OPEN && d.squads[0].seasons.length >= 3)(newest(d, linkSeason(d))),
  OLDER: ({ OPEN }) => d => d.squads.length === 1 && newest(d, OPEN).season === OPEN && newest(d, OPEN).gp > 0 && mineIn(d.squads[0], d.teamID).some(r => r.season < OPEN),
  GP0: ({ OPEN }) => d => d.squads.length === 1 && (r => r.season === OPEN && r.gp === 0)(newest(d, OPEN)),
};
// Overview (team-overview.test.mjs): the two pick() calls that match 3 and 4 live files. The others match 63 to 1034 and stay live.
export const THIN = {
  'both maybe and maybePrev': d => d.squads.length === 1 && !!(d.squads[0].maybe?.length && d.squads[0].maybePrev?.length),
  'maybePrev and 2 or more seasons': d => d.squads.length === 1 && !!(d.squads[0].maybePrev?.length && d.squads[0].seasons.length >= 2),
};
// Every pick, by name, as a predicate over a document, for a data set.
export const allPicks = data => ({
  CUR: HEADER.CUR(data), OLD: HEADER.OLD(data), OLDER: HEADER.OLDER(data), GP0: HEADER.GP0(data), ...THIN,
});
export const PICK_NAMES = ['CUR', 'OLD', 'OLDER', 'GP0', ...Object.keys(THIN)];
// The frozen document for a pick, by the id MANIFEST.picks records; the predicate is checked here, so a wrong file is loud.
export function pickFrom(data, manifest, name) {
  const id = manifest.picks[name];
  const doc = data.files.find(d => d.teamID === id);
  if (!doc) throw new Error(`fixture: pick ${name} (${id}) is not among the frozen history files`);
  if (!allPicks(data)[name](doc)) throw new Error(`fixture: ${id} no longer has the property of ${name}`);
  return doc;
}
