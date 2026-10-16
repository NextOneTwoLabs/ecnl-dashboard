// #163 (#149 phase 1, PR 3): the links a result opens, in exactly today's formats, so the judged
// set's wrong-destination check (tests/search/judged.mjs, destinationProblem) covers them. PR 4b
// adds game links here.
const e = encodeURIComponent;

// A team's Overview (#107), or its season tab with view=season.
export const teamHref = (season, teamID, name) => `#tab=teams&season=${e(season)}&team=${e(teamID)}&name=${e(name)}`;
export const teamSeasonHref = (season, teamID, name) => `${teamHref(season, teamID, name)}&view=season`;
// A conference table: the standings of one age group in one season.
export const conferenceHref = (season, div, conf) => `#season=${e(season)}&age=${e(div)}&conf=${e(conf)}&view=standings`;
// A national event (its stage tab) and a showcase page.
export const nationalHref = (season, stage) => `#tab=playoffs&season=${e(season)}&stage=${e(stage)}`;
export const showcaseHref = (season, eventID) => `#tab=showcases&season=${e(season)}&event=${e(eventID)}`;
