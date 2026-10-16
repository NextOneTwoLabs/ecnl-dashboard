// #158: a reference decoder for the search data files (core.json, games-<season>.json), the
// JavaScript twin of search_data.decode_games. The files are the prepared records; the index is
// the word-to-records map PR 3 builds from them in the browser. Pure functions: no DOM, no
// network, no clock. docs/data-api.md, "Search data", describes the format.

export const GAMES_SCHEMA = 1;
export const CORE_SCHEMA = 2;     // 2 since #159 (fields moved to places.json)
export const PLACES_SCHEMA = 1;
export const NO_TIME = 9999;
export const FLAGS = { bracket: 1, undated: 2, reconstructed: 4, friendly: 8, bye: 16 };

const pad = n => String(n).padStart(2, '0');

// 'YYYY-MM-DD' plus `days` (which may be negative), in UTC arithmetic so no time zone applies.
export function addDays(base, days) {
  const [y, m, d] = base.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// when = day offset * 10000 + HHMM (9999: no kick-off time). Floor division, so a day before the
// base (a negative offset) decodes as the right day (#158 MF4). null stays null.
export function decodeWhen(when, base) {
  if (when == null) return { date: null, time: null };
  const day = Math.floor(when / 10000), hhmm = when - day * 10000;
  return { date: addDays(base, day), time: hhmm === NO_TIME ? null : `${pad(Math.floor(hhmm / 100))}:${pad(hhmm % 100)}` };
}

// Every game as an object, in the file's order (matchID ascending). Throws on a schema it does not
// know, so a caller refuses the file rather than misreading it.
export function decodeGames(doc) {
  if (!doc || doc.schema !== GAMES_SCHEMA) throw new Error(`unknown games schema ${doc && doc.schema}`);
  const out = [];
  let prev = 0;
  for (const raw of doc.games) {
    const r = [...raw];
    while (r.length < 13) r.push(null);
    const matchID = r[0] + prev;
    prev = matchID;
    const [eventID, kind, division, flightName] = doc.flights[r[2]];
    const side = v => {
      if (Number.isInteger(v)) {
        const [name, clubID] = doc.alt[`${v}:${eventID}`] || doc.teams[v];
        return { teamID: v, name, clubID };
      }
      return { teamID: null, name: v, clubID: null };
    };
    const field = r[9] == null ? null : { complexID: r[9], name: doc.fields[r[9]][0], zip: doc.fields[r[9]][1] };
    const { date, time } = decodeWhen(r[1], doc.base);
    out.push({ matchID, date, time, flightID: r[2], eventID, kind, division, flightName, home: side(r[3]), away: side(r[4]),
      score: [r[5], r[6]], pk: [r[7], r[8]], field, number: r[10], flags: r[11] || 0, dest: r[12] });
  }
  return out;
}
