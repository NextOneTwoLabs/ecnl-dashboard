// The team page's own code (public/index.html), extracted block by block as in
// tests/team-history.test.mjs. #108: the glance card's club place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/\r\n/g, '\n');
// From the line that starts `head` to the end of the function (or statement) that `last` names.
const block = (head, last = head) => {
  const start = html.indexOf('\n' + head) + 1;
  const from = html.indexOf(last, start);
  const end = html.indexOf('\n    }\n', from) + 6;
  assert.ok(start > 0 && from >= start && end > from, `${head} not found in index.html`);
  return html.slice(start, end);
};

test('#108: the placeholder club 7 never shows a place, even when the data has one', () => {
  const place = new Function('clubPlaces', block('    const NO_CLUB = 7;', 'function clubPlaceText(') + '\nreturn clubPlaceText;');
  const f = place({ 7: { city: 'El Paso', state: 'TX' }, 1425: { city: 'Davis', state: 'CA' }, 64: null });
  assert.equal(f(7), '');
  assert.equal(f('7'), '');
  assert.equal(f(1425), 'Davis, CA');
  assert.equal(f('1425'), 'Davis, CA');
  assert.equal(f(64), '');
  assert.equal(f(null), '');
  assert.equal(f(undefined), '');
  assert.equal(place(null)(1425), '');            // the file not loaded yet
});

test('#108: the History header uses the same rule, with no inline club-7 check of its own', () => {
  assert.ok(html.includes('const place = clubPlaceText(sq.clubID);'));
  assert.ok(!/clubID\s*!==?\s*7\b/.test(html), 'a second club-7 rule outside clubPlaceText');
});
