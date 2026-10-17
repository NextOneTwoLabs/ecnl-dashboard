// #168 (PR 4b): the probe query sets the plan and the Reviewer used, built from the search data, so a
// test can run the same sets. A library, not a test file.
//   keystrokes(doc)             every prefix of every judged query
//   clubPrefixes(core)          every club name's 2-5-letter prefixes (MF3)
//   reviewSet(core, places, doc) the Reviewer's set (6230407924): every judged keystroke; every club
//                               name, its first word and its 2-6-letter prefixes; every census place and
//                               county; every conference, with U13, U15 and U17 and with each season; the
//                               kind words and a few named queries (2,059 queries on the committed data
//                               at the time of the review)
//   placeNames(places)          every census place and county name
export const keystrokes = doc => [...new Set(doc.queries.flatMap(q => [...q.q].map((_, k) => q.q.slice(0, k + 1))))];

export function clubPrefixes(core) {
  const qs = new Set();
  for (const c of core.teams.clubs) { const n = c[1].replace(/[^A-Za-z ]/g, '').trim(); for (let k = 2; k <= 5; k++) if (n.length >= k) qs.add(n.slice(0, k)); }
  return [...qs];
}

export const placeNames = places => [...new Set([...Object.values(places.places).map(p => p[0]), ...Object.values(places.counties).map(c => c[0])])];

export function reviewSet(core, places, doc) {
  const qs = new Set(keystrokes(doc));
  for (const c of core.teams.clubs) {
    const n = c[1];
    if (c[0] === 7) continue;
    qs.add(n); qs.add(n.split(/\s+/)[0]);
    for (let k = 2; k <= Math.min(6, n.length); k++) qs.add(n.slice(0, k));
  }
  for (const q of placeNames(places)) qs.add(q);
  for (const c of core.teams.confs) { qs.add(c); for (const u of ['U13', 'U15', 'U17']) qs.add(`${c} ${u}`); for (const s of core.seasons) qs.add(`${c} ${s}`); }
  for (const k of ['playoffs', 'finals', 'showcase', 'standings', 'playoffs 2025-26', '2026 playoffs', 'showcase 2024-25', 'finals u15', 'zzzz', 'texas u15 2023-24',
    'Slammers Irvine', 'Surf San Diego', 'MVLA Los Altos', 'Legends Del Mar', 'Slammers 2011', 'Slammers U15', 'Slammers southwest', 'Pateadores 2023-24',
    'san diego surf 2011', 'Mustang 2011', 'Sting Black', 'Northwest 2023-24', 'Surf Cup', 'Surf Spo', 'san dei', 'MVLA 2', 'MVLA 201', 'Sting Black 20']) qs.add(k);
  return [...qs];
}
