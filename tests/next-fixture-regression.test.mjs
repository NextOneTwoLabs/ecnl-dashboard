// #64: run the same deterministic behavioral test against main and the PR implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(process.env.ECNL_TEST_HTML || new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = name => {
  const start = html.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
};
const line = name => html.match(new RegExp(`    function ${name}\\([^\\n]*`))[0];
const optional = name => html.includes(`    function ${name}(`) ? block(name) : '';
const code = [line('gameDateKey'), line('isPlayed'), block('sortGames'), optional('fixtureDay'), optional('fixtureUndated'), optional('nextFixture'), block('computeTeamSummary')].join('\n');
const compute = new Function('todayKey', 'resultFor', code + '\nreturn computeTeamSummary;')(() => '2030-10-02', () => null);
const past = { matchID: 1, hometeamID: 7, awayteamID: 8, gameDate: '2030-10-01T00:00:00', hometeamscore: null, awayteamscore: null };
const future = { ...past, matchID: 2, gameDate: '2030-10-03T00:00:00' };
test('#64: actual summary ignores an unscored past fixture and chooses the future fixture', () => {
  assert.equal(compute(7, [], [past, future], 5, true).next?.matchID, future.matchID);
});
test('#64: actual summary returns no next fixture for a closed season', () => {
  assert.equal(compute(7, [], [past, future], 5, false).next, null);
});
