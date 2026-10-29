// #203: the data variants the refresh-proof bar is run on. Edits a COPY of the checkout (never this one) as a data refresh, the end of
// the season, a team withdrawn or added late, or a rename would; the repo's own builders are run afterwards by variants.py.
//
//   node --import ./tests/netguard/netguard.mjs tools/variants/sim_games.mjs <copy-dir> <variant> [--teams 1,2,3]
//
//   refresh        half of the unplayed active-season games are scored (gp follows)
//   season-end     every unplayed active-season game is scored (gp follows), so nothing is in progress
//   remove         the teams of --teams (default 55477) leave the active-season index, standings and schedules
//   withdraw-many  every 25th team of the active-season index leaves (31 teams today)
//   rename         the first team of --teams (default 55477) is spelled differently in the index and standings than in the schedules
//   double-header  two unplayed games of one pair on one date in one flight are both scored
//   late-add       two teams (cloned from 134153 and 46817, or the first two teams of --teams) are added with new ids and unplayed games
//
// <copy-dir> must be a directory outside this checkout: the script refuses this checkout's root and any path inside it, and a directory that
// has no public/data/sources.json. Offline: it only reads and writes files under <copy-dir>.
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

const REPO = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export function target(arg) {
  if (!arg) throw new Error('usage: sim_games.mjs <copy-dir> <variant> [--teams 1,2,3]');
  const dir = existsSync(arg) ? realpathSync(arg) : resolve(arg);
  if (dir === REPO || dir.startsWith(REPO + sep)) throw new Error(`refusing ${dir}: it is this checkout (or inside it); pass a copy outside the repo`);
  if (!existsSync(dir + '/public/data/sources.json')) throw new Error(`${dir} has no public/data/sources.json: it is not a copy of the checkout`);
  return dir;
}

const J = p => JSON.parse(readFileSync(p, 'utf8'));
const W = (p, o) => { try { unlinkSync(p); } catch {} writeFileSync(p, JSON.stringify(o)); };   // unlink first: files may be hard links
const ZERO = ['wins', 'losses', 'draws', 'gp', 'totalgames', 'standingpoints', 'goalsfor', 'goalsagainst', 'goaldifferential', 'ppg', 'winpercent'];

export function run(root, variant, teams = []) {
  const A = root + '/public/archive/';
  const src = J(root + '/public/data/sources.json'), OPEN = src.refresh.activeSeason;
  const events = new Set();
  (function w(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'eventId' && Number.isInteger(v)) events.add(v); else w(v); } })(src.seasons[OPEN]);
  const SCH = A + 'api/Event/get-schedules-by-flight/', STD = A + 'api/Event/get-standings-by-div-and-flight/';
  const idx = J(A + `teams/${OPEN}.json`);
  const info = { variant, season: OPEN };
  const scheduleFiles = function* () {
    for (const e of events) {
      const dir = SCH + e + '/'; if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) { const p = dir + f + '/0.json'; if (existsSync(p)) yield [e, f, p]; }
    }
  };
  const standingsFiles = function* () {
    if (!existsSync(STD)) return;
    for (const e of events) for (const d of readdirSync(STD)) for (const f of readdirSync(STD + d)) { const p = `${STD}${d}/${f}/${e}.json`; if (existsSync(p)) yield [e, d, f, p]; }
  };

  if (variant === 'refresh' || variant === 'season-end') {
    let scored = 0, left = 0; const played = new Map(); const bump = id => played.set(id, (played.get(id) || 0) + 1);
    for (const [, , p] of scheduleFiles()) {
      const j = J(p); let ch = false;
      const un = j.data.filter(g => g.hometeamscore == null || g.awayteamscore == null);
      const k = variant === 'season-end' ? un.length : Math.floor(un.length / 2);
      un.sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')).slice(0, k).forEach(g => { g.hometeamscore = (scored * 5) % 4; g.awayteamscore = (scored * 7 + 1) % 3; scored++; ch = true; });
      left += un.length - k;
      for (const g of j.data) if (g.hometeamscore != null && g.awayteamscore != null) { bump(g.hometeamID); bump(g.awayteamID); }
      if (ch) W(p, j);
    }
    const fix = t => { const n = played.get(t.teamID) || 0; if ((t.gp ?? 0) < n) t.gp = n; if ((t.totalgames ?? 0) < n) t.totalgames = n; };
    for (const [, , , p] of standingsFiles()) {
      const j = J(p);
      for (const b of Array.isArray(j.data) ? j.data : j.data ? [j.data] : []) for (const t of b.teamStandings || []) fix(t);
      W(p, j);
    }
    for (const t of idx.teams) fix(t);
    W(A + `teams/${OPEN}.json`, idx);
    Object.assign(info, { scored, unplayedLeft: left });
  } else if (variant === 'remove' || variant === 'withdraw-many') {
    const set = variant === 'remove'
      ? new Set(teams.length ? teams : [55477])
      : new Set([...idx.teams].sort((a, b) => a.teamID - b.teamID).filter((_, i) => i % 25 === 7).map(t => t.teamID));
    for (const [, , p] of scheduleFiles()) { const j = J(p); j.data = (j.data || []).filter(g => !set.has(g.hometeamID) && !set.has(g.awayteamID)); W(p, j); }
    for (const [, , , p] of standingsFiles()) {
      const j = J(p);
      for (const b of Array.isArray(j.data) ? j.data : j.data ? [j.data] : []) b.teamStandings = (b.teamStandings || []).filter(t => !set.has(t.teamID));
      W(p, j);
    }
    idx.teams = idx.teams.filter(t => !set.has(t.teamID));
    W(A + `teams/${OPEN}.json`, idx);
    info.removed = set.size;
  } else if (variant === 'rename') {
    const id = teams[0] || 55477, NAME = (idx.teams.find(t => t.teamID === id) || {}).name;
    if (!NAME) throw new Error(`team ${id} is not in the ${OPEN} index`);
    const NEW = 'Renamed SC ECNL G2010/11';
    for (const [, , p] of scheduleFiles()) { const s = readFileSync(p, 'utf8'); if (s.includes(NAME)) { unlinkSync(p); writeFileSync(p, s.split(NAME).join(NEW)); } }   // the schedules spell it the new way
    info.was = NAME; info.now = NEW;
  } else if (variant === 'double-header') {
    const key = g => (g.gameDate || '').slice(0, 10) + '|' + [g.hometeamID, g.awayteamID].sort().join('-');
    for (const [, , p] of scheduleFiles()) {
      const j = J(p), grp = {};
      for (const g of j.data.filter(g => g.hometeamscore == null)) (grp[key(g)] ||= []).push(g);
      const pair = Object.values(grp).find(a => a.length >= 2);
      if (!pair) continue;
      pair[0].hometeamscore = 2; pair[0].awayteamscore = 0; pair[1].hometeamscore = 1; pair[1].awayteamscore = 0;
      W(p, j); Object.assign(info, { pair: key(pair[0]), file: p.slice(root.length + 1) });
      break;
    }
    if (!info.pair) throw new Error('no flight has two unplayed games of one pair on one date');
  } else if (variant === 'late-add') {
    let n = 700001; const sources = teams.length >= 2 ? teams.slice(0, 2) : [134153, 46817];
    for (const srcId of sources) {
      const t = idx.teams.find(x => x.teamID === srcId); if (!t) throw new Error('no team ' + srcId);
      const id = n++;
      const p = `${STD}${t.divisionID}/${t.flightID}/${t.eventID}.json`, j = J(p);
      for (const b of Array.isArray(j.data) ? j.data : [j.data]) {
        const s = (b.teamStandings || []).find(x => x.teamID === srcId); if (!s) continue;
        const c = JSON.parse(JSON.stringify(s)); c.teamID = id; for (const k of ZERO) if (k in c) c[k] = 0;
        c.rank = b.teamStandings.length + 1; b.teamStandings.push(c);
      }
      W(p, j);
      // its games: the source team's, as unplayed games against the same opponents, a fortnight later (so no opponent plays twice at once),
      // with match ids above the real ones and below 9,999,999 (test_search_data appends that one)
      const sp = `${SCH}${t.eventID}/${t.flightID}/0.json`, sj = J(sp); let m = 3000000 + (id - 700000) * 1000; const add = [];
      for (const g of sj.data || []) if (g.hometeamID === srcId || g.awayteamID === srcId) {
        const c = JSON.parse(JSON.stringify(g)); c.matchID = m++;
        if (c.hometeamID === srcId) c.hometeamID = id; else c.awayteamID = id;
        for (const k of ['gameDate', 'gameDate1']) if (c[k]) c[k] = new Date(Date.parse(c[k] + 'Z') + 14 * 864e5).toISOString().slice(0, 19);
        c.hometeamscore = null; c.awayteamscore = null; add.push(c);
      }
      sj.data.push(...add); W(sp, sj);
      const ct = { ...t, teamID: id, rank: null }; for (const k of ZERO) if (k in ct) ct[k] = 0;   // same name as the source: a club's second side
      idx.teams.push(ct);
    }
    W(A + `teams/${OPEN}.json`, idx);
    info.added = sources.length;
  } else throw new Error(`unknown variant ${variant}`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [dir, variant, ...rest] = process.argv.slice(2);
  const teams = rest.includes('--teams') ? rest[rest.indexOf('--teams') + 1].split(',').map(Number) : [];
  console.log(JSON.stringify(run(target(dir), variant, teams)));
}
