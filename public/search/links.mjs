// #163 (#149 phase 1, PR 3): the links a result opens, in exactly today's formats, so the judged
// set's wrong-destination check (tests/search/judged.mjs, destinationProblem) covers them, and the
// game links of #168 (PR 4b), which tests/search-game-links.test.mjs resolves for every game.
const e = encodeURIComponent;

// A team's Overview (#107), or its season tab with view=season.
export const teamHref = (season, teamID, name) => `#tab=teams&season=${e(season)}&team=${e(teamID)}&name=${e(name)}`;
export const teamSeasonHref = (season, teamID, name) => `${teamHref(season, teamID, name)}&view=season`;
// A conference table: the standings of one age group in one season.
export const conferenceHref = (season, div, conf) => `#season=${e(season)}&age=${e(div)}&conf=${e(conf)}&view=standings`;
// A national event (its stage tab) and a showcase page.
export const nationalHref = (season, stage) => `#tab=playoffs&season=${e(season)}&stage=${e(stage)}`;
export const showcaseHref = (season, eventID) => `#tab=showcases&season=${e(season)}&event=${e(eventID)}`;

// #168: a game, in the view that lists it, from the games file's `dest` code (docs/data-api.md):
//   [1, s]  the conference Matches view for the division, side s's team selected; [1] no team selected.
//           A played game adds &sched=results (the default Upcoming filter lists only unplayed games).
//   [2]     the national bracket for the age group and tier (the flight); [3] that tier's Schedule view
//   [4]     the showcase's Games view for the age group and flight; [0] no link (a side still to be decided)
// &match= names the game: the view scrolls to it and marks it, and it is never saved as the place.
export function gameHref(g) {
  const d = g.dest, c = g.competition, m = `&match=${e(g.matchID)}`;
  if (d[0] === 1) {
    const team = d.length > 1 ? (d[1] ? g.away : g.home).teamID : null;
    return `#season=${e(g.season)}&age=${e(c.div)}&conf=${e(c.event)}&view=schedule${team ? `&team=${e(team)}` : ''}${g.score ? '&sched=results' : ''}${m}`;
  }
  if (d[0] === 2 || d[0] === 3) return `${nationalHref(g.season, c.event)}&age=${e(c.div)}&tier=${e(c.flightID)}${d[0] === 3 ? '&view=schedule' : ''}${m}`;
  if (d[0] === 4) return `${showcaseHref(g.season, c.eventID)}&age=${e(c.div)}&flight=${e(c.flightID)}&view=schedule${m}`;
  return null;
}
