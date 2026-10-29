// #203: the pick the conference-sheet tests run on (tests/conference-sheet.test.mjs), as a library shared by that test, by
// freeze.mjs (next to this file, which chooses the files) and by tests/conference-fixture.test.mjs (which checks them).
// The pick is the first conference (in the catalog's order) with a one-flight, one-block girls division of at least six
// teams, a published schedule, and played games for the sixth team. On the live archive that is a property of one point in the
// season (the sixth team's first played game), so the test runs on the frozen copy instead.
import { existsSync, readFileSync } from 'node:fs';

// `base` holds archive/api/Event/...; `seasons` is the catalog's `seasons`; `season` the season to look in.
export function files(base) {
  const archive = p => new URL(`archive/api/Event/${p}`, base);
  return {
    hierarchyFile: e => archive(`get-event-schedule-or-standings/${e}.json`),
    standingsFile: (e, d, f) => archive(`get-standings-by-div-and-flight/${d}/${f}/${e}.json`),
    scheduleFile: (e, f) => archive(`get-schedules-by-flight/${e}/${f}/0.json`),
  };
}

export function findFix(base, seasons, season) {
  const { hierarchyFile, standingsFile, scheduleFile } = files(base);
  const teamsOf = (e, d, f) => {
    if (!existsSync(standingsFile(e, d, f))) return [];
    const data = JSON.parse(readFileSync(standingsFile(e, d, f), 'utf8')).data;
    const blocks = Array.isArray(data) ? data : data ? [data] : [];
    return blocks.reduce((a, b) => ((b && b.teamStandings || []).length > a.length ? b.teamStandings : a), []);
  };
  for (const [conf, { eventId }] of Object.entries(seasons[season].conferences)) {
    if (!existsSync(hierarchyFile(eventId))) continue;
    const h = JSON.parse(readFileSync(hierarchyFile(eventId), 'utf8')).data;
    for (const d of h.girlsDivAndFlightList || []) {
      const flights = d.flightList || [];
      if (flights.length !== 1) continue;
      const f = flights[0];
      const raw = existsSync(standingsFile(eventId, d.divisionID, f.flightID)) ? JSON.parse(readFileSync(standingsFile(eventId, d.divisionID, f.flightID), 'utf8')).data : null;
      if (Array.isArray(raw) && raw.filter(b => b && (b.teamStandings || []).length).length > 1) continue;   // merged blocks: another test's
      const teams = teamsOf(eventId, d.divisionID, f.flightID);
      if (teams.length < 6 || !existsSync(scheduleFile(eventId, f.flightID))) continue;
      const games = JSON.parse(readFileSync(scheduleFile(eventId, f.flightID), 'utf8')).data || [];
      const six = teams[5];
      if (!games.some(g => (g.hometeamID === six.teamID || g.awayteamID === six.teamID) && g.hometeamscore != null)) continue;
      return { conf, eventId, divisionId: d.divisionID, flightId: f.flightID, age: d.divisionName, teams };
    }
  }
  return null;
}
