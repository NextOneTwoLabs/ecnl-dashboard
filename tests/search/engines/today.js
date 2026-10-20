// Today's search, as public/index.html held it until PR 5 (#172) removed it. FROZEN: the page no longer holds this code, so it is
// no longer compared with index.html (tests/search/fixtures/MANIFEST.json retired); tests/search-judged.test.mjs checks it
// against MANIFEST.engineSha, and tests/search/baseline/today.json is what it records (freeze.mjs --record today).
// The TEAM_SEARCH block, then the page's search code from `let usDb` up to the removed `#165 ... dormant` comment. Do not edit.
//@@ENGINE
    const TEAM_SEARCH = (() => {
      // #114 team search engine (PR B). Inlined into public/index.html between the TEAM SEARCH
      // markers; tests/team-search.test.mjs extracts it from there. Pure functions: no DOM, no network.
      // A result is a team: one club and age group, i.e. one #107 squad, from the team directory
      // (/api/v1/teams). A query names a team, or a place, or an age group (or band) plus a conference;
      // season, age group, birth year, conference and place words narrow it.
      const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const words = s => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
      // Words that say nothing about which team it is, dropped from names and queries alike.
      const NOISE = new Set(['ecnl', 'girls', 'girl', 'team', 'teams', 'the', 'and', 'of', 'based', 'from']);
      // Age tokens in team names ("gu15", "g06", "g2012", "13", "08g"): the parser reads these as ages
      // and birth years, so they are not name words (S8).
      const AGE_WORD = /^(g?u\d{1,2}|g?\d{2}|g?(19|20)\d{2}|\d{2}g|u\d{2}rl|\d{4})$/;
      // "No Club Selection" (TGS's placeholder club 7): its name, initials and place say nothing about a team (S7).
      const NO_CLUB = 7;
      // US states and DC, for place searches (D-P1). A club's place is its "City, ST" from clubs.json.
      const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
        DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
        IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
        MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
        NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
        OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
        UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
      // Two-letter codes that are also common English words: a place only when they are the whole query.
      const WORD_CODES = new Set(['in', 'or', 'me']);
      // Spellings of place words that mean the same ("Mount Pleasant" = "Mt. Pleasant").
      const PLACE_ALIAS = { mount: 'mt', saint: 'st' };
      // ... and in names, both ways ("saint louis" finds "St Louis", SC6).
      const NAME_ALIAS = { mount: 'mt', mt: 'mount', saint: 'st', st: 'saint' };

      // Optimal string alignment distance, stopping once it passes max.
      function osa(a, b, max) {
        if (Math.abs(a.length - b.length) > max) return max + 1;
        const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) d[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
          let rowMin = Infinity;
          for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
            d[i][j] = v;
            if (v < rowMin) rowMin = v;
          }
          if (rowMin > max) return max + 1;
        }
        return d[a.length][b.length];
      }

      // 3 exact word, 2 word prefix, 1 one typo from 4 letters (two from 8), 0 none.
      function tokenScore(tok, w, isLast) {
        if (w === tok) return 3;
        if (w.startsWith(tok) && (isLast || tok.length >= 3)) return 2;
        if (tok.length >= 4 && /^[a-z]+$/.test(tok)) {
          const max = tok.length >= 8 ? 2 : 1;
          if (osa(tok, w.slice(0, tok.length + max), max) <= max || osa(tok, w, max) <= max) return 1;
        }
        return 0;
      }
      function vocabScores(tok, vocab, isLast) {
        const m = new Map();
        for (const w of vocab) { const s = tokenScore(tok, w, isLast); if (s) m.set(w, s); }
        return m;
      }
      const nameWords = s => words(s).filter(w => !NOISE.has(w) && !AGE_WORD.test(w));
      // "United Futbol Academy" -> "ufa": clubs are often called by their initials.
      const acronym = name => {
        const w = nameWords(name).filter(x => /^[a-z]/.test(x));
        return w.length >= 3 ? w.map(x => x[0]).join('') : null;
      };
      const placeWords = s => words(s).map(w => PLACE_ALIAS[w] || w);

      // "MVLA ECNL G2010/11" -> "MVLA"; "Sting Black ECNL G2011/12" -> "Sting Black".
      function teamTitle(name, clubName) {
        const t = String(name || '')
          .replace(/\b(G?U\d{1,2}(\/U?\d{1,2})?( Composite)?|G?(19|20)\d{2}(\/\d{2,4})?|G\d{2}(\/\d{2})?|\d{2}G|U\d{2}RL)\b/gi, '')
          .replace(/\bECNL\b(?!\s*-?R)/gi, '').replace(/\s*[-–]\s*$/, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
        return t || clubName || name;
      }

      function prepare(index) {
        const seasons = index.seasons;
        const ev = index.events.map(([s, kind, stage, eventID]) => ({ season: seasons[s], kind: kind === 'n' ? 'national' : 'showcase', stage, eventID }));
        const div = index.divs.map(([s, name, u, years]) => ({ season: seasons[s], name, u, years }));
        const club = c => {
          const [id, name, logo, place, fam] = index.clubs[c];
          const at = id === NO_CLUB ? -1 : (place || '').lastIndexOf(', ');   // a city never holds a comma (clubs.json rule)
          // #133: a reviewed family (club-families.json): several TGS ids shown as one club.
          const f = fam != null && index.families && index.families[fam];
          return { id, name, logo, place: at > 0 ? place : '', city: at > 0 ? placeWords(place.slice(0, at)).join(' ') : '',
            cityLabel: at > 0 ? place.slice(0, at) : '', state: at > 0 ? place.slice(at + 2) : '',
            family: f ? { name: f[0], main: f[1] } : null };
        };
        const docs = index.squads.map(sq => {
          const c = club(sq.c);
          const rows = sq.s.map(([s, teamID, name, conf, d, rank, of]) => ({
            season: seasons[s], teamID, name, conf: index.confs[conf], div: div[d].name, u: div[d].u, years: div[d].years, rank, of,
          }));
          const events = (sq.e || []).map(([s, e, tier, outcome]) => ({ season: seasons[s], ev: ev[e], tier: index.tiers[tier], outcome }));
          // M2: a word of the latest name (or the club's) scores in full; a word found only in an
          // older name scores at most 2, so "Sting Royal" ranks the squad that is Sting Royal now first.
          const latest = new Set(nameWords(rows[rows.length - 1].name));
          if (c.id !== NO_CLUB) { nameWords(c.name).forEach(w => latest.add(w)); const a = acronym(c.name); if (a) latest.add(a); }
          for (const w of [...latest]) if (NAME_ALIAS[w]) latest.add(NAME_ALIAS[w]);
          const older = new Set(rows.slice(0, -1).flatMap(r => nameWords(r.name)).flatMap(w => (NAME_ALIAS[w] ? [w, NAME_ALIAS[w]] : [w])).filter(w => !latest.has(w)));
          const title = teamTitle(rows[rows.length - 1].name, c.name);
          return { club: c, born: sq.b, rows, events, best: sq.best, latest, older, title, titleWords: nameWords(title),
            key: `${rows[0].season}/${rows[0].teamID}`, m: sq.m || [], mp: sq.mp || [] };
        });
        for (const d of docs) { d.maybe = d.m.map(i => docs[i]); d.maybePrev = d.mp.map(i => docs[i]); }
        const phrases = index.confs.map(c => ({ type: 'conf', value: c, words: words(c) }));
        phrases.push({ type: 'conf', value: 'NorCal', words: ['northern', 'california'] });
        const confWords = new Set(phrases.map(p => p.words.join(' ')));
        for (const [code, name] of Object.entries(STATES)) {
          // "Texas" is a conference phrase; parseQuery decides whether it means the state (D-P2).
          if (!confWords.has(words(name).join(' '))) phrases.push({ type: 'state', value: code, label: name, words: words(name) });
        }
        const cities = new Map();
        for (const d of docs) if (d.club.city) cities.set(d.club.city, d.club.cityLabel);
        for (const [city, label] of cities) phrases.push({ type: 'city', value: city, label, words: city.split(' ') });
        phrases.sort((a, b) => b.words.length - a.words.length);
        const vocab = [...new Set(docs.flatMap(d => [...d.latest, ...d.older]))];
        return { seasons, active: seasons[seasons.length - 1], docs, phrases, vocab };
      }

      // "2024-25", "24-25" -> season; "U15", "GU15" -> age group; "2011", "G2011", "G11", "2011G",
      // "11" -> birth year; "G2010/11" -> a two-year band; conference, state and city names; two-letter
      // state codes (D-P1); everything else is name words.
      function parseQuery(q, db) {
        const raw = norm(q).replace(/[,;]+/g, ' ').split(/\s+/).filter(Boolean);
        const out = { season: null, u: null, years: [], band: false, conf: null, places: [], codes: [], text: [] };
        const toks = [];
        for (const t of raw) {
          let m;
          if ((m = /^(?:20)?(\d{2})-(?:20)?(\d{2})$/.exec(t)) && (+m[1] + 1) % 100 === +m[2] && db.seasons.includes(`20${m[1]}-${m[2]}`)) { out.season = `20${m[1]}-${m[2]}`; continue; }
          if ((m = /^g?u-?(\d{1,2})(?:\/u?\d{1,2})?s?$/.exec(t)) && +m[1] >= 8 && +m[1] <= 19) { out.u = +m[1]; continue; }   // U15, GU18/19, GU18/U19
          if ((m = /^[gb]?((?:19|20)\d{2})(?:\/((?:19|20)?\d{2}))?[gb]?$/.exec(t))) {
            out.years.push(+m[1]);
            if (m[2]) { out.years.push(m[2].length === 2 ? Math.floor(+m[1] / 100) * 100 + +m[2] : +m[2]); out.band = true; }
            continue;
          }
          if ((m = /^[gb](\d{2})(?:\/(\d{1,2}))?$/.exec(t)) || (m = /^(\d{2})[gb]$/.exec(t))) {
            out.years.push(2000 + +m[1]);
            if (m[2]) { out.years.push(2000 + +m[2]); out.band = true; }
            continue;
          }
          if (/^\d{2}$/.test(t) && +t <= 20) { out.years.push(2000 + +t); continue; }
          toks.push(...words(t).filter(w => !NOISE.has(w)));
        }
        const ptoks = toks.map(w => PLACE_ALIAS[w] || w);
        for (let i = 0; i < toks.length;) {
          const p = db.phrases.find(p => (p.type !== 'conf' || !out.conf) && p.words.every((w, k) => (p.type === 'conf' ? toks : ptoks)[i + k] === w));
          if (p && p.type === 'conf') out.conf = p.value;
          else if (p) out.places.push(p);           // a state or city: matches by place or by name
          else out.text.push(toks[i]);
          i += p ? p.words.length : 1;
        }
        // "Texas" names a conference and a state: with an age group or a band it is the conference's
        // table ("U15 Texas"); otherwise, a birth year included ("texas 2011"), it is the state (D-P2).
        const stateOfConf = out.conf && Object.entries(STATES).find(([, n]) => norm(n) === norm(out.conf));
        if (stateOfConf && !(out.u || out.band)) {
          out.places.push({ type: 'state', value: stateOfConf[0], label: stateOfConf[1], words: words(stateOfConf[1]) });
          out.conf = null;
        }
        // Two-letter state codes ("CA", "SC"): a strict place when the query has no name word and no
        // place name ("SC" = South Carolina, not every "Soccer Club"; "NJ NY" = either state);
        // otherwise a code matches by place or by name ("Mustang SC", "Rush CO", "Tulsa SC").
        // "in", "or", "me" count only as the whole query (D-P1).
        const codes = out.text.filter(t => t.length === 2 && STATES[t.toUpperCase()]);
        const others = out.text.length - codes.length;
        for (const c of codes) {
          out.text.splice(out.text.indexOf(c), 1);
          if (WORD_CODES.has(c) && (others || out.places.length || codes.length > 1)) continue;
          out.codes.push({ code: c.toUpperCase(), label: STATES[c.toUpperCase()], strict: !others && !out.places.length });
        }
        return out;
      }

      const ageText = (u, div) => (u ? `U${u}${/composite/i.test(div || '') ? ' Composite' : ''}` : div || '');
      const bornText = b => (b.length === 2 ? `${b[0]}/${String(b[1]).slice(-2)}` : b.join('/'));
      const teamHref = (season, teamID, name) =>
        `#tab=teams&season=${encodeURIComponent(season)}&team=${encodeURIComponent(teamID)}&name=${encodeURIComponent(name)}`;

      // -> { query, results, total, note, currentOnly }. `currentOnly`: the list holds only teams
      // playing in the active season (a place on its own, D-P3). `note` explains a list that
      // differs from the plain reading: { kind: 'ended', label, n } when no team based there plays
      // in the active season (the list is then every season's), or { kind: 'name', code, label, n }
      // when a code alone matched no club: the list is the teams with that code as a whole word in
      // their name ("LA" -> LA Breakers), and n is 0 when none has ("RI").
      function search(db, q, { season = null, limit = 60 } = {}) {
        const p = parseQuery(q, db);
        const empty = { query: p, results: [], total: 0, note: null, currentOnly: false };
        const strictPlaces = [...p.places, ...p.codes.filter(c => c.strict).map(c => ({ type: 'state', value: c.code, label: c.label, words: [], code: true }))];
        const tableQuery = !p.text.length && !p.places.length && !p.codes.length && !!p.conf && !!(p.u || p.band);
        const placeQuery = !p.text.length && strictPlaces.length > 0;
        if (!p.text.length && !tableQuery && !placeQuery) return empty;
        if (p.text.length && p.text.join('').length < 2) return empty;
        // A place on its own lists the teams playing now (D-P3). Only when every code in it was read as
        // a place: "Tulsa SC" names a club, and lists its ended teams too.
        const currentOnly = placeQuery && !p.season && !p.u && !p.years.length && p.codes.every(c => c.strict);
        let res = run(db, p, { season, tableQuery, placeQuery, strictPlaces, currentOnly });
        let note = null, current = currentOnly;
        if (!res.length && currentOnly) {                    // every team based there has ended
          res = run(db, p, { season, tableQuery, placeQuery, strictPlaces, currentOnly: false });
          current = false;
          if (res.length) note = { kind: 'ended', label: strictPlaces.map(x => x.label).join(' or '), n: res.length };
        }
        const lone = p.codes.length === 1 && p.codes[0].strict && !p.places.length;
        if (!res.length && lone) {                           // "LA", "DE": no club based there, so the name
          const c = p.codes[0], w = c.code.toLowerCase();
          const q2 = { ...p, codes: [], text: [w] };
          res = run(db, q2, { season, tableQuery: false, placeQuery: false, strictPlaces: [], currentOnly: false })
            .filter(r => r.doc.latest.has(w) || r.doc.older.has(w));   // the whole word, never a prefix (MF2)
          current = false;
          note = { kind: 'name', code: c.code, label: c.label, n: res.length };
        }
        const results = res.slice(0, limit);
        for (const r of results) r.desc = describe(r, db);   // only for the rows shown
        return { query: p, results, total: res.length, note, currentOnly: current };
      }

      function run(db, p, { season, tableQuery, placeQuery, strictPlaces, currentOnly }) {
        const ageSeason = p.u && !p.season ? (season || db.active) : null;
        const maps = p.text.map((t, i) => vocabScores(t, db.vocab, i === p.text.length - 1));
        const out = [];
        for (const d of db.docs) {
          let text = 0;
          for (const m of maps) {
            let s = 0;
            for (const w of d.latest) { const v = m.get(w); if (v > s) s = v; if (s === 3) break; }
            for (const w of d.older) { const x = m.get(w) || 0; const v = x === 3 ? 2 : Math.min(1, x); if (v > s) s = v; }
            if (!s) { text = -1; break; }
            text += s;
          }
          if (text < 0) continue;
          // Places: the club's own place (never a club with none: club 7 and the null places), or a
          // place name's words in the team's name. Several places: any of them ("NJ NY").
          const named = ws => ws.length > 0 && ws.every(w => d.latest.has(w) || d.older.has(w));
          const at = ph => (ph.type === 'state' ? d.club.state === ph.value : d.club.city === ph.value) || named(ph.words);
          if (strictPlaces.length && !strictPlaces.some(at)) continue;
          const soft = p.codes.filter(c => !c.strict);
          if (!soft.every(c => d.club.state === c.code || named([c.code.toLowerCase()]))) continue;
          // A place or code word that is also in the team's name counts as a name match ("Tennessee SC",
          // "Legends FC (CA)", and a city's namesake: "phoenix" -> Phoenix Rising); on a whole state's
          // list ("california") no team jumps the order.
          const nameish = p.text.length || soft.length;
          for (const ph of p.places) if (named(ph.words) && (ph.type === 'city' || nameish)) text += 3 * ph.words.length;
          for (const c of soft) if (named([c.code.toLowerCase()])) text += 3;
          const latest = d.rows[d.rows.length - 1];
          if (currentOnly && latest.season !== db.active) continue;
          let anchor = null;
          for (let i = d.rows.length - 1; i >= 0 && !anchor; i--) {
            const r = d.rows[i];
            if (p.season && r.season !== p.season) continue;
            if (ageSeason && r.season !== ageSeason) continue;
            if (p.u && r.u !== p.u) continue;
            if (p.band ? !(r.years.length === 2 && p.years.every(y => r.years.includes(y)))
              : p.years.length && !p.years.some(y => d.born.includes(y))) continue;
            if (p.conf && r.conf !== p.conf) continue;
            anchor = r;
          }
          if (!anchor) continue;
          // Ranking: name quality (a whole title +5), then teams playing now, then the more recent
          // season. A table query is ordered like the table instead.
          const whole = d.titleWords.length && d.titleWords.every(w => p.text.includes(w)) ? 5 : 0;
          const score = tableQuery ? 0 : text * 10 + whole + (latest.season === db.active ? 3 : 0) + db.seasons.indexOf(anchor.season) * 0.2;
          const r = {
            doc: d, key: d.key, club: d.club, born: d.born, score, pinned: !!(p.season || p.u),
            name: latest.name, title: d.title, teamID: anchor.teamID, season: anchor.season,
            age: ageText(anchor.u, anchor.div), conf: anchor.conf, rank: anchor.rank, of: anchor.of, anchorName: anchor.name,
            first: d.rows[0].season, last: latest.season, nSeasons: d.rows.length, current: latest.season === db.active,
            latestAge: ageText(latest.u, latest.div), latestConf: latest.conf,
          };
          // Enter opens the team's Overview; a query that names a season opens that season's tab
          // (D2), as does Shift+Enter or the action bar's season link.
          r.overviewHref = teamHref(latest.season, latest.teamID, latest.name);
          r.seasonHref = teamHref(r.season, r.teamID, r.anchorName) + '&view=season';
          r.href = p.season ? r.seasonHref : r.overviewHref;
          out.push(r);
        }
        // Ties (D-P4): club, then team line, then oldest age group; a table query by its table.
        const club = r => (r.club.id === NO_CLUB ? r.title : r.club.name);
        out.sort((a, b) => b.score - a.score ||
          (tableQuery ? String(a.conf).localeCompare(String(b.conf)) || (a.rank || 99) - (b.rank || 99) : 0) ||
          club(a).localeCompare(club(b)) || a.title.localeCompare(b.title) ||
          (b.doc.rows.at(-1).u || 0) - (a.doc.rows.at(-1).u || 0) || a.name.localeCompare(b.name));
        // A possible predecessor (#107 maybe) sits directly under its candidate(s); never merged.
        const inOut = new Map(out.map(r => [r.doc, r]));
        const placed = new Set(), ordered = [];
        const place = r => { if (!placed.has(r)) { placed.add(r); ordered.push(r); } };
        for (const r of out) {
          if (placed.has(r)) continue;
          if (r.doc.maybe.some(m => inOut.has(m) && !placed.has(inOut.get(m)))) continue;
          place(r);
          for (const prev of r.doc.maybePrev) {
            const pr = inOut.get(prev);
            if (!pr || placed.has(pr)) continue;
            pr.continuesAs = prev.maybe.filter(m => inOut.has(m)).map(m => inOut.get(m));
            place(pr);
          }
        }
        for (const r of out) place(r);
        // S4: titles that collide in this list get a distinguishing token.
        const groups = new Map();
        for (const r of ordered) { const k = `${r.title}\n${bornText(r.born)}`; groups.set(k, [...(groups.get(k) || []), r]); }
        for (const g of groups.values()) if (g.length > 1) for (const r of g) r.distinct = distinguish(r, g);
        return ordered;
      }

      // The first of latest age group, conference, last season, TGS id that tells this row apart.
      function distinguish(r, group) {
        const pick = [x => x.latestAge, x => x.latestConf, x => x.last, x => `id ${x.doc.rows.at(-1).teamID}`];
        for (const f of pick) if (group.filter(x => f(x) === f(r)).length === 1) return f(r);
        return `id ${r.doc.rows.at(-1).teamID}`;
      }

      const TIER = [[/champions league/i, 'CL'], [/north american cup/i, 'NAC'], [/showcase cup/i, 'Showcase Cup'], [/open cup/i, 'Open Cup']];
      const tierShort = t => (TIER.find(([re]) => re.test(t)) || [null, t])[1];
      const OUT = { Champion: 'champion', Final: 'final', Semifinals: 'semis', Quarterfinals: 'QF', 'Round of 16': 'R16', 'Round of 32': 'R32' };
      const DEPTH = { Champion: 7, Final: 6, Semifinals: 5, Quarterfinals: 4, 'Round of 16': 3, 'Round of 32': 2 };
      const yy = season => `'${season.slice(-2)}`;
      const ord = n => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
      const finish = e => `${tierShort(e.tier)} ${OUT[e.outcome] || (/^Group/.test(e.outcome) ? 'group stage' : e.outcome) || 'played'} ${yy(e.season)}`.replace(/\s+/g, ' ');

      // One line, most useful first: (the continuation hint, S3), age group and conference in the
      // season shown, place, seasons in the archive, one standout from the #107 data.
      function describe(r, db) {
        const bits = [];
        if (r.continuesAs) {
          const c = r.continuesAs, from = c[0].first;
          bits.push(c.length === 1 && c[0].title !== r.title ? `May continue as ${c[0].title} from ${from}`
            : `May continue in ${from} as ${c.map(x => `U${x.doc.rows[0].u}`).join(' or ')}`);
        }
        const where = `${r.age} ${r.conf}` + (r.season !== db.active ? ` ${r.season}` : '');
        bits.push(r.pinned && r.rank ? `${where}, ${ord(r.rank)} of ${r.of}` : where);
        if (r.club.place) bits.push(r.club.place);
        bits.push(r.nSeasons === 1 ? '1 season' : `${r.nSeasons} seasons`);
        if (!r.continuesAs) {
          const posts = r.doc.events.filter(e => e.outcome);
          const inSeason = r.pinned ? posts.filter(e => e.season === r.season).sort((a, b) => (DEPTH[b.outcome] || 1) - (DEPTH[a.outcome] || 1))[0] : null;
          const titles = posts.filter(e => e.outcome === 'Champion');
          if (inSeason) bits.push(`${inSeason.ev.stage}: ${finish(inSeason)}`);
          else if (titles.length) bits.push(`\u{1F3C6} ${finish(titles[titles.length - 1])}`);
          else if (r.doc.best != null) bits.push(`best ${finish(r.doc.events[r.doc.best])}`);
        }
        return bits.join(' · ');
      }
      // #133: a club's best Champions League finish over its teams, for its header.
      function clubStandout(docs) {
        let best = null;
        for (const d of docs) for (const e of d.events) {
          if (!e.outcome || !/champions league/i.test(e.tier)) continue;
          const k = (DEPTH[e.outcome] || 1) * 10000 + +e.season.slice(0, 4);
          if (!best || k > best.k) best = { e, k };
        }
        return !best ? '' : best.e.outcome === 'Champion' ? `\u{1F3C6} ${finish(best.e)}` : `best ${finish(best.e)}`;
      }
      return { prepare, search, parseQuery, bornText, teamTitle, clubStandout, placeWords };
    })();

//@@PAGE
    let usDb = null, usItems = [], usCompetitions = [], usActiveIdx = -1, usInput = null, usTimer = null;
    // #146: registered destinations alongside teams. No fetch or inference of event flight IDs.
    function usCompetitionSearch(q, db, registry, selectedSeason) {
      if (!registry || !registry.seasons || !db) return [];
      const text = String(q || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[–—]/g, '-');
      const raw = text.split(/[\s,;]+/).filter(Boolean);
      const explicit = raw.find(t => /^(?:20)?\d{2}-(?:20)?\d{2}$/.test(t));
      const parsed = TEAM_SEARCH.parseQuery(text, db);
      if (explicit && !parsed.season) return [];   // never substitute today's season for an unknown one
      const season = parsed.season || selectedSeason || registry.refresh?.activeSeason;
      const entry = registry.seasons[season];
      if (!entry) return [];
      const e = encodeURIComponent, rows = [];
      const bounded = () => Object.assign(rows.slice(0, 6), { omitted: Math.max(0, rows.length - 6) });
      const intent = new Set(['standings', 'standing', 'conference', 'conferences']);
      if (parsed.conf && (parsed.u || parsed.years.length) && !parsed.places.length && !parsed.codes.length
          && parsed.text.every(t => intent.has(t)) && entry.conferences?.[parsed.conf]) {
        const divisions = new Map();
        for (const d of db.docs) for (const r of d.rows) {
          if (r.season !== season || r.conf !== parsed.conf || !entry.ageGroups?.[r.div]) continue;
          if (parsed.u && r.u !== parsed.u) continue;
          if (parsed.band ? !(r.years.length === 2 && parsed.years.every(y => r.years.includes(y)))
            : parsed.years.length && !parsed.years.some(y => r.years.includes(y))) continue;
          divisions.set(r.div, r);
        }
        for (const r of [...divisions.values()].sort((a,b) => b.u - a.u || a.div.localeCompare(b.div))) {
          rows.push({ kind: 'competition', key: `conference/${season}/${parsed.conf}/${r.div}`, season,
            title: `${parsed.conf} · Girls U${r.u === 18 && r.div.includes('/') ? '18/19' : r.u}${/composite/i.test(r.div) ? ' Composite' : ''} standings`,
            desc: `${season.replace('-', '–')} · Conference standings`, action: 'Open standings',
            href: `#season=${e(season)}&age=${e(r.div)}&conf=${e(parsed.conf)}&view=standings` });
        }
        return bounded();
      }
      // All remaining meaningful words must describe the event; a team word such as "Surf"
      // cannot disappear just because its city also names a showcase. Ages are not asserted here.
      const noise = new Set(['ecnl','girls','girl','the','and','event','events','results','result','brackets','bracket']);
      const tokens = raw.filter(t => t !== explicit && !/^g?u-?\d{1,2}(?:\/u?\d{1,2})?s?$/.test(t)
        && !/^[gb]?((?:19|20)\d{2}|\d{2})(?:\/(?:20)?\d{2})?[gb]?$/.test(t))
        .flatMap(t => t.split(/[^a-z0-9]+/)).filter(t => t && !noise.has(t));
      if (!tokens.length || (!parsed.text.length && (parsed.places.length || parsed.codes.length))) return []; // place-only queries keep their team groups
      for (const [se, v] of Object.entries(registry.seasons)) {
        if (parsed.season && se !== parsed.season) continue;
        for (const [type, list] of [['playoffs', v.national], ['showcases', v.showcases]]) {
          for (const [name, event] of Object.entries(list || {})) {
            const tierNames = [...Object.keys(event.tierNotes || {}), ...Object.values(event.tierLabels || {})];
            const eventWords = new Set(`${name} ${event.eventName || ''} ${event.location || ''} ${tierNames.join(' ')} ${type === 'showcases' ? 'showcase showcases' : /playoffs?/i.test(name) ? 'playoff playoffs' : ''} ${type === 'playoffs' && /finals?/i.test(name) ? 'final finals' : ''}`
              .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
            if (!tokens.every(t => eventWords.has(t))) continue;
            const tierWords = new Set(tierNames.join(' ').toLowerCase().split(/[^a-z0-9]+/));
            const choose = parsed.u || parsed.years.length || tokens.some(t => tierWords.has(t) && !['showcase','showcases'].includes(t));
            rows.push({ kind: 'competition', key: `${type}/${se}/${event.eventId}`, season: se, title: name,
              desc: `${se.replace('-', '–')} · ${type === 'showcases' ? 'Showcase results' : 'Playoff brackets & results'}${choose ? ' · Choose age group on the event page' : ''}`,
              action: 'Open event', href: type === 'showcases' ? `#tab=showcases&season=${e(se)}&event=${e(event.eventId)}`
                : `#tab=playoffs&season=${e(se)}&stage=${e(name)}` });
          }
        }
      }
      rows.sort((a,b) => Number(b.season === season) - Number(a.season === season)
        || b.season.localeCompare(a.season) || a.title.localeCompare(b.title));
      return bounded();
    }
    function usCompetitionRows(grid = false) {
      if (!usCompetitions.length) return '';
      const section = t => grid ? `<li role="row" class="us-section"><span role="rowheader">${esc(t)}</span></li>`
        : `<li role="presentation" class="us-section">${esc(t)}</li>`;
      let h = section('Competitions');
      for (const r of usCompetitions) {
        const i = usItems.push(r) - 1;
        if (grid) usPos.push({ row: i, col: 0, key: r.key });
        const contents = `<span class="us-text"><span class="us-name">${esc(r.title)}</span><span class="us-meta">${esc(r.desc)}</span></span><span class="us-act" aria-hidden="true">${r.action === 'Open standings' ? 'Standings' : 'Event'} ›</span>`;
        h += grid ? `<li role="row" class="us-competition"><span role="gridcell" class="us-cell us-row" id="us-opt-${i}" data-i="${i}" aria-selected="false">${contents}</span></li>`
          : `<li role="option" class="us-row us-competition" id="us-opt-${i}" data-i="${i}" aria-selected="false">${contents}</li>`;
      }
      if (usCompetitions.omitted) {
        const hint = `${usCompetitions.omitted} more competitions. Add a season or more of the event name.`;
        h += grid ? `<li role="row" class="us-more"><span role="rowheader">${esc(hint)}</span></li>`
          : `<li role="presentation" class="us-more">${esc(hint)}</li>`;
      }
      return h + section('Teams');
    }
    function usCompetitionActions(r) {
      document.getElementById('usearchActive').textContent = `${r.title} · ${r.season.replace('-', '–')}`;
      document.getElementById('usearchActive').className = '';
      const o = document.getElementById('usearchOpen'); o.href = r.href; o.textContent = r.action;
      document.getElementById('usearchHist').hidden = true; document.getElementById('usearchHist').href = '#';
      document.getElementById('usearchPrev').hidden = true; document.getElementById('usearchPrev').href = '#';
      document.getElementById('usearchActions').hidden = false;
    }
    function usLoad() {
      if (usDb) return Promise.resolve(usDb);
      return getTeamDirectory().then(d => {
        if (d === 'live') throw Object.assign(new Error('live'), { usText: 'Team search is not available in live mode.' });
        if (!d) throw Object.assign(new Error('missing'), { usText: "Team search isn't available right now." });
        usDb = TEAM_SEARCH.prepare(d);
        return usDb;
      });
    }
    const usPop = () => document.getElementById('usearchPop');
    const usSheet = () => isPhone();
    function usPlace() {
      const pop = usPop();
      if (usSheet()) { pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'true'); pop.setAttribute('aria-label', 'Search teams and competitions'); return; }
      pop.removeAttribute('role'); pop.removeAttribute('aria-modal'); pop.removeAttribute('aria-label');
      const r = document.getElementById('usearchInput').getBoundingClientRect();
      const width = Math.min(640, window.innerWidth - 32);
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.width = width + 'px';
      pop.style.maxHeight = (window.innerHeight - r.bottom - 22) + 'px';
    }
    function usOpen(inp) {
      usInput = inp;
      usPlace();
      usPop().hidden = false;
      inp.setAttribute('aria-expanded', 'true');
      if (!usDb) usShowStatus('Loading every team…');
      usLoad().then(() => usRun(inp.value))
        .catch(e => { usShowStatus(esc(e.usText || `Couldn't load team search. ${retryText(e)}`)); usList(''); });
    }
    function usOpenSheet() { const s = document.getElementById('usearchSheetInput'); usOpen(s); s.focus(); }
    function usClose(clear) {
      const pop = usPop();
      if (!pop) return;
      const wasSheet = !pop.hidden && usSheet();
      pop.hidden = true;
      ['usearchInput', 'usearchSheetInput'].forEach(id => {
        const i = document.getElementById(id);
        i.setAttribute('aria-expanded', 'false'); i.removeAttribute('aria-activedescendant');
        if (clear) i.value = '';
      });
      usActiveIdx = -1;
      if (wasSheet) document.getElementById('headerSearch').focus();   // the dialog gives focus back
    }
    function usShowStatus(h) { document.getElementById('usearchStatus').innerHTML = h; }
    function usList(h) {
      document.getElementById('usearchList').innerHTML = h;
      document.getElementById('usearchActions').hidden = true;
    }
    const US_TIPS = ['MVLA 2011', 'Sting 2012', 'California', 'U15 NorCal', 'Dallas 2012'];
    function usRun(q) {
      usHoverCancel();
      usItems = []; usCompetitions = []; usActiveIdx = -1;
      const tips = document.getElementById('usearchTips');
      if (q.trim().length < 2) {
        usView = null; usPos = [];
        document.getElementById('usearchList').setAttribute('role', 'listbox');
        if (usInput) usInput.setAttribute('aria-haspopup', 'listbox');
        usShowStatus('Teams since 2020-21 and registered competitions. Try U15 NorCal or San Diego Fall.');
        if (!tips.querySelector('button')) tips.insertAdjacentHTML('beforeend', US_TIPS.map(t =>
          `<button type="button" class="us-chip" onmousedown="event.preventDefault()" onclick="usFill(this.textContent)">${esc(t)}</button>`).join(''));
        tips.hidden = false;
        usList('');
        document.getElementById('usearchLive').textContent = '';
        return;
      }
      tips.hidden = true;
      // #133: every match is grouped and counted; today's flat list draws its first 60, as before.
      const all = TEAM_SEARCH.search(usDb, q, { season: currentSeason, limit: Infinity });
      usCompetitions = usCompetitionSearch(q, usDb, typeof SOURCES !== 'undefined' ? SOURCES : null, currentSeason);
      const view = usViewOf(all, usDb, usSheet());
      usView = null; usPos = [];
      if (view.mode !== 'flat' && view.mode !== 'empty') {
        const open = new Set();
        if (view.groups.every(g => !g.nLive)) {   // SC2: chips to open, not toggles to unfold
          for (const g of view.groups) { if (g.earlier) open.add(`${g.key}|earlier`); for (const L of g.lines) open.add(`${g.key}|${L.title}|ended`); }
        }
        usView = Object.assign(view, { res: all, q, open, nav: false, sheet: usSheet() });
        usRenderView(all, q);
        const n = all.total, c = view.groups.length;
        usShowStatus((usCompetitions.length ? `<strong>${usCompetitions.length} competition${usCompetitions.length === 1 ? '' : 's'}</strong> · ` : '') + usStatus(all, all.query).replace(/^<strong>/, `<strong>${c} club${c === 1 ? '' : 's'} · `));
        document.getElementById('usearchLive').textContent = `${usCompetitions.length ? usCompetitions.length + ' competitions, ' : ''}${c} club${c === 1 ? '' : 's'}, ${n} team${n === 1 ? '' : 's'}. ` +
          'Use the up and down arrows to move between rows, then left and right along a row.';
        return;
      }
      const list = document.getElementById('usearchList');
      list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', usCompetitions.length ? 'Competitions and teams' : 'Teams');
      if (usInput) usInput.setAttribute('aria-haspopup', 'listbox');
      const res = { ...all, results: all.results.slice(0, 60) };
      const p = res.query;
      const marks = p.text.map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
      const re = marks.length ? new RegExp(`\\b(${marks.join('|')})`, 'gi') : null;
      // Match the raw title, then escape each piece.
      const mark = s => {
        if (!re) return esc(s);
        let out = '', at = 0;
        s.replace(re, (m, _g, i) => { out += esc(s.slice(at, i)) + '<mark>' + esc(m) + '</mark>'; at = i + m.length; return m; });
        return out + esc(s.slice(at));
      };
      let rank = 0;
      const row = r => {
        const i = usItems.push(r) - 1;
        const label = r.continuesAs ? '↳' : String(++rank);
        const ini = r.title.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        const logo = r.club.logo
          ? `<img class="us-logo" src="${esc(r.club.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;us-initials&quot;>${esc(ini)}</span>'">`
          : `<span class="us-initials">${esc(ini)}</span>`;
        const tok = r.distinct ? ` <span class="us-tok">· ${esc(r.distinct)}</span>` : '';
        const pill = r.continuesAs ? '<span class="us-pill cont">May continue</span>' : r.current ? '' : `<span class="us-pill past">Ended ${esc(r.last)}</span>`;
        const where = res.query.season ? esc(usSeasonText(r.season)) : 'Overview';
        return `<li role="option" class="us-row${r.continuesAs ? ' us-cont' : ''}" id="us-opt-${i}" aria-selected="false" data-i="${i}">` +
          `<span class="us-rank" aria-hidden="true">${label}</span>${logo}<div class="us-text"><div class="us-name">${mark(r.title)} · born ${esc(TEAM_SEARCH.bornText(r.born))}${tok}${pill}</div>` +
          `<div class="us-meta" title="${esc(r.desc)}">${esc(r.desc)}</div></div><div class="us-act" aria-hidden="true">${where} ›</div></li>`;
      };
      let h = usCompetitionRows() + res.results.map(row).join('');
      const placed = p.places.length || p.codes.some(c => c.strict);
      if (res.total > res.results.length) h += `<li role="presentation" class="us-more">${res.total - res.results.length} more. ${usNarrowHint(p, placed)}</li>`;
      if (!h) h = `<li role="presentation" class="us-more">${usEmptyText(q, p, res)}</li>`;
      usList(h);
      const n = res.total;
      usShowStatus((usCompetitions.length ? `<strong>${usCompetitions.length} competition${usCompetitions.length === 1 ? '' : 's'}</strong> · ` : '') + (n ? usStatus(res, p) : 'No teams'));
      document.getElementById('usearchLive').textContent = usCompetitions.length || n ? `${usCompetitions.length ? usCompetitions.length + ' competitions, ' : ''}${n} team${n === 1 ? '' : 's'}. Use the up and down arrows to choose.` : 'No teams found.';
      if (usItems.length) usSetActive(0);
    }
    const usPlaceWord = p => (p.places[0] ? p.places[0].label : (p.codes.find(c => c.strict) || {}).code || '');
    // "Add a birth year or an age group (…)", without what the query already has (#133 SC4).
    function usNarrowHint(p, placed) {
      const year = !p.years.length, age = !(p.u || p.band);
      if (!year && !age) return 'Add a club or team name.';
      const w = esc(usPlaceWord(p));
      const eg = placed ? [year ? `“${w} 2011”` : '', age ? `“U15 ${w}”` : ''].filter(Boolean).join(', ') : '';
      return `Add ${year && age ? 'a birth year or an age group' : year ? 'a birth year' : 'an age group'}${eg ? ` (${eg})` : ''}.`;
    }
    function usEmptyText(q, p, res) {
      if (res && res.note && res.note.kind === 'name') return `No teams based in ${esc(res.note.label)}, and no team has “${esc(res.note.code)}” in its name.`;
      if (!p.text.length && !p.places.length && !p.codes.length && !p.conf) return 'Add a team or club name, or a place. For example “MVLA 2011” or “California”.';
      if (p.places.length > 1 || p.codes.length > 1) return 'No team is based in any of those places.';
      return `No team matches “${esc(q.trim())}”. Try a club name with a birth year (2011, G11) or an age group (U15).`;
    }
    // "150 teams · based in California · playing in 2026-27"; the notes say why a list is not the
    // plain reading (a place whose teams have all ended; a code with no club based there).
    function usStatus(res, p) {
      const n = res.total;
      const bits = [`<strong>${n} team${n === 1 ? '' : 's'}</strong>`];
      if (res.note && res.note.kind === 'ended') return `No teams based in ${esc(res.note.label)} play in ${esc(currentSeasonActive())} · <strong>${n} earlier team${n === 1 ? '' : 's'}</strong>`;
      if (res.note && res.note.kind === 'name') return `No teams based in ${esc(res.note.label)} · “${esc(res.note.code)}” in a team name: <strong>${n} team${n === 1 ? '' : 's'}</strong>`;
      if (p.years.length) bits.push(`born ${p.years.join('/')}`);
      if (p.u) bits.push(`U${p.u}${p.season ? '' : ' in ' + currentSeason}`);
      if (p.conf) bits.push(p.conf);
      const placeLabels = [...p.places.map(x => x.label), ...p.codes.filter(c => c.strict).map(c => c.label)];
      if (placeLabels.length) bits.push(`based in ${placeLabels.join(' or ')}`);
      p.codes.filter(c => !c.strict).forEach(c => bits.push(`${c.code}: ${c.label} or in the name`));
      if (p.season) bits.push(p.season);
      if (res.currentOnly) bits.push(`playing in ${currentSeasonActive()}`);   // the engine says so (MF1)
      return bits.map((b, i) => (i ? esc(b) : b)).join(' · ');
    }
    const currentSeasonActive = () => (usDb ? usDb.active : currentSeason);
    function usSetActive(i, hover) {
      const prev = document.getElementById(`us-opt-${usActiveIdx}`);
      if (prev) prev.setAttribute('aria-selected', 'false');
      usActiveIdx = i;
      const el = document.getElementById(`us-opt-${i}`), r = usItems[i];
      if (usView && el) return usSetActiveCell(i, el, r, hover);
      if (!el || !r) return;
      el.setAttribute('aria-selected', 'true');
      el.scrollIntoView({ block: 'nearest' });
      if (usInput) usInput.setAttribute('aria-activedescendant', el.id);
      if (r.kind === 'competition') { usCompetitionActions(r); return; }
      document.getElementById('usearchHist').hidden = false;
      document.getElementById('usearchOpen').textContent = 'Overview';
      // The active row's real links sit outside the listbox (an option holds no link): new tab,
      // copy link and middle-click all work on them.
      document.getElementById('usearchActive').textContent = `${r.title} · born ${TEAM_SEARCH.bornText(r.born)}`;
      document.getElementById('usearchActive').className = '';
      document.getElementById('usearchPrev').hidden = true;
      const o = document.getElementById('usearchOpen'), hl = document.getElementById('usearchHist');
      o.href = r.overviewHref;
      hl.href = r.seasonHref; hl.textContent = usSeasonText(r.season);
      document.getElementById('usearchActions').hidden = false;
    }
    // #133: a cell's team (or an "ended" toggle) in the action bar: its line, age and birth years,
    // the engine's one-liner, and the squads that may continue as it, with a link to the first.
    function usSetActiveCell(i, el, r, hover) {
      el.setAttribute('aria-selected', 'true');
      if (!hover) el.scrollIntoView({ block: 'nearest' });   // N5: a hover never scrolls the list
      if (usInput) usInput.setAttribute('aria-activedescendant', el.id);
      const bar = document.getElementById('usearchActions'), span = document.getElementById('usearchActive');
      const prevLink = document.getElementById('usearchPrev');
      if (!r) { bar.hidden = true; return; }
      if (r.kind === 'competition') { usCompetitionActions(r); return; }
      document.getElementById('usearchHist').hidden = false;
      document.getElementById('usearchOpen').textContent = 'Overview';
      const may = r.mayFrom && r.mayFrom.length
        ? ` · May continue here: ${r.mayFrom.map(x => `${x.last} team, born ${TEAM_SEARCH.bornText(x.born)}`).join('; ')}` : '';
      span.className = 'us-two';
      span.textContent = `${r.title} · ${r.live ? r.slot : `ended ${r.last}`} · born ${TEAM_SEARCH.bornText(r.born)} — ${r.desc}${may}`;
      const o = document.getElementById('usearchOpen'), hl = document.getElementById('usearchHist');
      o.href = r.overviewHref;
      hl.href = r.seasonHref; hl.textContent = usSeasonText(r.season);
      prevLink.hidden = !may;
      if (may) prevLink.href = r.mayFrom[0].overviewHref;
      bar.hidden = false;
    }
    // "Current season" or "2024–25 season", as the team page's own tab reads.
    const usSeasonText = s => teamSeasonTabLabel(s);
    // `to`: 'season' (Shift+Enter, the season link), 'overview' (the Overview link), else the row's own link.
    function usGo(i, to) {
      const r = usItems[i];
      if (!r) return;
      usGoTo(r.kind === 'competition' ? r.href : to === 'season' ? r.seasonHref : to === 'overview' ? r.overviewHref : r.href);
    }
    function usGoTo(target) {
      usClose(true);
      if (usInput) usInput.blur();
      closeSidebarIfMobile();
      if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));   // reopen the same team
      else location.hash = target;
    }
    function usFill(t) { usInput.value = t; usRun(t); usInput.focus(); }

    // ===== #133: the results by club =====
    // Every match is grouped (the engine is asked for all of them), and a view is chosen from the
    // engine's own reading of the query, in this order (review M1):
    //   1. no match: today's text;  2. 3 teams or fewer;  3. a table query (age group or band and a
    //   conference);  4. a name or a place with an age group or band (one team per line: chips add
    //   nothing);  5. every club with one team: today's flat rows (2-5);  6. the engine's name fallback ("LA") or ended fallback (a place whose teams
    //   have all ended): B;  7. a place on its own: clubs named for the place, or matched by a team
    //   name, or based elsewhere, as B ("Clubs named ..."), then the clubs only based there, as C
    //   ("Other clubs based in ..."), either section left out when empty;  8. anything else: B;
    //   9. on the phone sheet, C is drawn as B's cards.
    // A group is a club: a reviewed family (#133 club-families.json), else the TGS club id; club 7's
    // teams by team line. #107 "may continue" squads fold into their successors (a gold dot, and a
    // line in the action bar). A team line's ended teams are one "+n ended" chip; two or more lines
    // with no team playing are one "Earlier lines" row per club, and a single such line keeps its
    // own name (owner decision 6, as ruled). When no team in the list is playing (the engine's
    // ended fallback), the ended chips start unfolded, so Enter opens a team (SC2).
    const US_MAX_CLUBS = 30, US_MAX_CELLS = 200;   // S1: drawn at most; every match is still counted
    let usView = null, usPos = [];
    function usGroups(res, db) {
      const results = res.results, pinned = !!(res.query.season || res.query.u);
      const folded = new Set();
      for (const r of results) r.mayFrom = [];
      for (const r of results) if (r.continuesAs && r.continuesAs.length) { folded.add(r); r.continuesAs.forEach(s => s.mayFrom && s.mayFrom.push(r)); }
      const groups = new Map();
      for (const r of results) {
        if (folded.has(r)) continue;
        // A chip's age: that season's when the query names a season or an age group, else today's.
        const anchor = r.doc.rows.find(x => x.season === r.season && x.teamID === r.teamID) || r.doc.rows.at(-1);
        r.live = pinned || r.current;
        r.slot = pinned ? r.age : r.latestAge;
        r.slotU = (pinned ? anchor.u : r.doc.rows.at(-1).u) || 0;
        const f = r.club.family;
        const k = f ? `f:${f.name}` : r.club.id === NO_CLUB || r.club.id == null ? `t:${r.title}` : `c:${r.club.id}`;
        if (!groups.has(k)) groups.set(k, { key: k, name: f ? f.name : k[0] === 't' ? r.title : r.club.name, family: f, teams: [] });
        groups.get(k).teams.push(r);
      }
      const byAge = (a, b) => (a.born[0] || 0) - (b.born[0] || 0) || b.slotU - a.slotU || a.title.localeCompare(b.title);
      const byEnd = (a, b) => b.last.localeCompare(a.last) || byAge(a, b);
      const out = [...groups.values()];
      for (const g of out) {
        const main = g.family && (g.teams.find(r => r.club.id === g.family.main) || db.docs.find(d => d.club.id === g.family.main));
        g.club = main ? main.club : g.teams[0].club;
        g.places = new Set(g.teams.map(r => r.club.place).filter(Boolean)).size;
        const lines = new Map();
        for (const r of g.teams) { if (!lines.has(r.title)) lines.set(r.title, []); lines.get(r.title).push(r); }
        const all = [...lines].map(([title, ts]) => ({ title, live: ts.filter(r => r.live).sort(byAge), ended: ts.filter(r => !r.live).sort(byEnd) }));
        g.lines = all.filter(L => L.live.length).sort((a, b) => b.live.length - a.live.length || a.title.localeCompare(b.title));
        const old = all.filter(L => !L.live.length);
        g.earlier = !old.length ? null : {
          title: old.length === 1 ? old[0].title : 'Earlier lines', lines: old.map(L => L.title),
          ended: old.flatMap(L => L.ended).sort(byEnd), merged: old.length > 1 };
        g.may = new Set(g.teams.flatMap(r => r.mayFrom)).size;
        g.nLive = g.teams.filter(r => r.live).length;
        g.nEnded = g.teams.length - g.nLive;
        g.nAll = g.teams.length + g.may;
        g.standout = TEAM_SEARCH.clubStandout(g.teams.map(r => r.doc));
      }
      return { groups: out, folded, pinned };
    }
    // The view for these results: { mode: 'flat' | 'B' | 'C' | 'BC', groups, named, based }.
    function usViewOf(res, db, sheet) {
      const p = res.query;
      if (!res.total) return { mode: 'empty', groups: [], named: [], based: [] };
      const G = usGroups(res, db);
      const tableQuery = !p.text.length && !p.places.length && !p.codes.length && !!p.conf && !!(p.u || p.band);
      const place = !p.text.length && (p.places.length > 0 || p.codes.some(c => c.strict)) && p.codes.every(c => c.strict);
      let mode;
      if (res.total <= 3 || tableQuery || p.u || p.band || G.groups.every(g => g.teams.length === 1)) mode = 'flat';
      else if (res.note) mode = 'B';                    // the engine's name or ended fallback
      else if (!place) mode = 'B';
      let named = [], based = [];
      if (!mode) {
        // Owner ruling: a club name first. A code counts by its state's name ("SC": South Carolina,
        // never the "SC" of "... SC"). Named: a live team's name words (the engine's own, with the
        // club's name) or the family's name hold every word of the place.
        const phrases = [...p.places.map(x => x.words), ...p.codes.map(c => TEAM_SEARCH.placeWords(c.label))].filter(w => w.length);
        const isNamed = g => phrases.some(ph => g.teams.some(r => r.live && ph.every(w => r.doc.latest.has(w)))
          || ph.every(w => TEAM_SEARCH.placeWords(g.name).includes(w)));
        const isBased = g => g.teams.some(r => p.places.some(x => (x.type === 'state' ? r.club.state === x.value : r.club.city === x.value))
          || p.codes.some(c => c.strict && r.club.state === c.code));
        for (const g of G.groups) (isBased(g) && !isNamed(g) ? based : named).push(g);
        if (!based.length) mode = 'B';
        else if (!named.length) mode = 'C';
        else mode = 'BC';
        named.allNamed = named.every(isNamed);
      }
      if (sheet && (mode === 'C' || mode === 'BC')) mode = mode === 'C' ? 'B' : 'BB';   // the phone: cards
      return { mode, groups: G.groups, named, based, pinned: G.pinned, place: [...p.places.map(x => x.label), ...p.codes.map(c => c.label)].join(' or ') };
    }

    // The grouped list (B, C, or both). usItems[i] is the team (so usGo opens r.href: Overview, or
    // the season tab when the query names a season, #122 D2), or null for an "ended" toggle;
    // usPos[i] holds its row, column, and toggle key.
    function usRenderView(res, q, keepKey) {
      const v = usView, p = res.query, list = document.getElementById('usearchList');
      usItems = []; usPos = []; usActiveIdx = -1;
      list.setAttribute('role', 'grid');
      list.setAttribute('aria-label', usCompetitions.length ? 'Competitions and teams by club' : 'Teams by club');
      if (usInput) usInput.setAttribute('aria-haspopup', 'grid');
      const marks = p.text.map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
      const re = marks.length ? new RegExp(`\\b(${marks.join('|')})`, 'gi') : null;
      const mark = s => {
        if (!re) return esc(s);
        let out = '', at = 0;
        s.replace(re, (m, _g, i) => { out += esc(s.slice(at, i)) + '<mark>' + esc(m) + '</mark>'; at = i + m.length; return m; });
        return out + esc(s.slice(at));
      };
      const where = p.season ? null : 'Overview';
      const born = r => TEAM_SEARCH.bornText(r.born);
      const nameOf = (line, r) => `${line}, ${r.live ? r.slot : `ended ${r.last}`}, born ${born(r)}` +
        (r.mayFrom && r.mayFrom.length ? `, ${r.mayFrom.length} earlier team${r.mayFrom.length === 1 ? '' : 's'} may continue here` : '') +
        `, ${r.desc}, ${where || usSeasonText(r.season)}`;
      let row = usCompetitions.length, cells = 0;
      const out = [usCompetitionRows(true)];
      const cell = (r, line, cls, label, col, r0, tag = 'span') => {
        const i = usItems.push(r) - 1; usPos.push({ row: r0, col, key: r.key });
        cells++;
        return `<${tag} role="gridcell" class="us-cell ${cls}${r.mayFrom && r.mayFrom.length ? ' may' : ''}" id="us-opt-${i}" data-i="${i}" aria-selected="false" aria-label="${esc(nameOf(line, r))}">${esc(label)}</${tag}>`;
      };
      const toggle = (key, line, n, col, r0, cls) => {
        const open = v.open.has(key);
        const i = usItems.push(null) - 1; usPos.push({ row: r0, col, key, toggle: true });
        cells++;
        return `<span role="gridcell" class="us-cell ${cls}" id="us-opt-${i}" data-i="${i}" aria-selected="false" aria-expanded="${open}"` +
          ` aria-label="${esc(`${line}: ${n} ended team${n === 1 ? '' : 's'}, ${open ? 'expanded' : 'collapsed'}`)}">${open ? '−' : '+'}${n} ended</span>`;
      };
      const meta = g => {
        const bits = [];
        if (g.club.place) bits.push(g.club.place + (g.places > 1 ? ` +${g.places - 1} place${g.places > 2 ? 's' : ''}` : ''));
        if (g.lines.length > 1) bits.push(`${g.lines.length} team lines`);
        if (v.pinned) bits.push(`${g.teams.length} team${g.teams.length === 1 ? '' : 's'}${p.season ? ` in ${p.season}` : ''}`);
        else {
          bits.push(g.nLive ? `${g.nLive} current` : 'no current team');
          if (g.nEnded) bits.push(`${g.nEnded} ended`);
        }
        if (g.may) bits.push(`${g.may} may continue`);   // S6: so the pill's count adds up
        if (g.standout) bits.push(g.standout);
        return bits.join(' · ');
      };
      const logo = g => {
        const ini = String(g.name).split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        return g.club.logo
          ? `<img class="us-logo" src="${esc(g.club.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;us-initials&quot;>${esc(ini)}</span>'">`
          : `<span class="us-initials">${esc(ini)}</span>`;
      };
      const head = g => `${logo(g)}<span class="us-text" role="rowheader"><span class="us-name">${mark(g.name)}<span class="us-count">${g.nAll} team${g.nAll === 1 ? '' : 's'}</span></span>` +
        `<span class="us-meta">${esc(meta(g))}</span></span>`;
      // The ended chips of a line (or of the earlier lines, each chip under its own line's name).
      const endedChips = (line, list2, r0, start, labelled) => {
        let last = null;
        // Two ended teams of one line with the same birth years: the season each ended tells them apart.
        const seen = new Map();
        list2.forEach(r => { const k = `${r.title}|${born(r)}`; seen.set(k, (seen.get(k) || 0) + 1); });
        const label = r => born(r) + (seen.get(`${r.title}|${born(r)}`) > 1 ? ` ’${r.last.slice(-2)}` : '');
        return list2.map((r, k) => {
          const sub = labelled && r.title !== last ? `<span class="us-sublabel" aria-hidden="true">${mark(r.title)}</span>` : '';
          last = r.title;
          return sub + cell(r, labelled ? r.title : line, 'us-agechip ended', label(r), start + k, r0);
        }).join('');
      };
      const renderB = groups => {
        for (const g of groups) {
          out.push(`<li role="row" class="us-clubhead">${head(g)}</li>`);
          for (const L of g.lines) {
            const r0 = row++;
            let h = L.live.map((r, k) => cell(r, L.title, 'us-agechip', r.slot, k, r0)).join('');
            if (L.ended.length) {
              const key = `${g.key}|${L.title}|ended`;
              h += toggle(key, L.title, L.ended.length, L.live.length, r0, 'us-agechip ended');
              if (v.open.has(key)) h += endedChips(L.title, L.ended, r0, L.live.length + 1, false);
            }
            const same = g.lines.length === 1 && !g.earlier && L.title === g.name;
            out.push(`<li role="row" class="us-chipline"><span class="${same ? 'us-sr' : 'us-lname'}" role="rowheader">${mark(L.title)}</span>${h}</li>`);
          }
          if (g.earlier) {
            const E = g.earlier, r0 = row++, key = `${g.key}|earlier`;
            let h = toggle(key, E.merged ? `Earlier lines (${E.lines.join(', ')})` : E.title, E.ended.length, 0, r0, 'us-agechip ended');
            if (v.open.has(key)) h += endedChips(E.title, E.ended, r0, 1, E.merged);
            out.push(`<li role="row" class="us-chipline"><span class="us-lname" role="rowheader">${mark(E.title)}</span>${h}</li>`);
          }
          if (out.length && (++v.drawn >= US_MAX_CLUBS || cells >= US_MAX_CELLS)) return groups.indexOf(g) + 1;
        }
        return groups.length;
      };
      const renderC = groups => {
        const ages = [...new Map(groups.flatMap(g => g.teams).filter(r => r.live).map(r => [r.slot, r.slotU])).entries()]
          .sort((a, b) => b[1] - a[1]).map(a => a[0]);
        list.style.setProperty('--cols', ages.length);
        // M3: a visual header only; every cell's name holds its line and age.
        out.push(`<li class="us-ghead" aria-hidden="true"><span>Club · team line</span>${ages.map(a => `<span>${esc(a)}</span>`).join('')}<span>Ended</span></li>`);
        const lineCells = (g, L, r0) => {
          const h = ages.map((a, col) => {
            const r = L.live.find(x => x.slot === a);
            return r ? cell(r, L.title, 'us-gcell', String(r.born[0]).slice(-2) + (r.born[1] ? '/' + String(r.born[1]).slice(-2) : ''), col, r0)
              : `<span class="us-gcell none" aria-hidden="true">·</span>`;
          }).join('');
          if (!L.ended.length) return h + `<span class="us-gcell none" aria-hidden="true"></span>`;
          const key = `${g.key}|${L.title}|ended`;
          return h + toggle(key, L.title, L.ended.length, ages.length, r0, 'us-gcell ended');
        };
        const unfolded = (g, L, merged) => {
          const key = merged ? `${g.key}|earlier` : `${g.key}|${L.title}|ended`;
          if (!v.open.has(key)) return;
          const r0 = row++;
          out.push(`<li role="row" class="us-chipline us-gended"><span class="us-sublabel" role="rowheader">Ended:</span>${endedChips(L.title, L.ended, r0, 0, merged)}</li>`);
        };
        for (const g of groups) {
          const rows = [...g.lines];
          if (g.earlier) rows.push({ title: g.earlier.title, live: [], ended: g.earlier.ended, earlier: g.earlier });
          const cellsOf = (L, r0) => (L.earlier
            ? ages.map(() => `<span class="us-gcell none" aria-hidden="true">·</span>`).join('') +
              toggle(`${g.key}|earlier`, L.earlier.merged ? `Earlier lines (${L.earlier.lines.join(', ')})` : L.title, L.ended.length, ages.length, r0, 'us-gcell ended')
            : lineCells(g, L, r0));
          if (rows.length === 1) {
            const r0 = row++;
            out.push(`<li role="row" class="us-gline us-gone"><span class="us-gclubcell">${head(g)}</span>${cellsOf(rows[0], r0)}</li>`);
            unfolded(g, rows[0], !!(rows[0].earlier && rows[0].earlier.merged));
          } else {
            out.push(`<li role="row" class="us-gclub">${head(g)}</li>`);
            for (const L of rows) {
              const r0 = row++;
              out.push(`<li role="row" class="us-gline"><span class="us-lname" role="rowheader">${mark(L.title)}</span>${cellsOf(L, r0)}</li>`);
              unfolded(g, L, !!(L.earlier && L.earlier.merged));
            }
          }
          if (++v.drawn >= US_MAX_CLUBS || cells >= US_MAX_CELLS) return groups.indexOf(g) + 1;
        }
        return groups.length;
      };
      const section = t => out.push(`<li role="row" class="us-section"><span role="rowheader">${esc(t)}</span></li>`);
      v.drawn = 0;
      let shown = [];
      if (v.mode === 'B' || v.mode === 'C') {
        const n = (v.mode === 'B' ? renderB : renderC)(v.groups);
        shown = v.groups.slice(0, n);
      } else {   // BC, or BB on the phone: the clubs named for the place first, then those only based there
        section(v.named.allNamed ? `Clubs named “${v.place}”` : `Clubs and teams named “${v.place}”`);
        const n1 = renderB(v.named);
        shown = v.named.slice(0, n1);
        if (n1 === v.named.length && v.drawn < US_MAX_CLUBS && cells < US_MAX_CELLS) {
          section(`Other clubs based in ${v.place}`);
          const n2 = (v.mode === 'BC' ? renderC : renderB)(v.based);
          shown = shown.concat(v.based.slice(0, n2));
        }
      }
      const restGroups = v.groups.length - shown.length;
      if (restGroups > 0) {
        const restTeams = res.total - shown.reduce((n, g) => n + g.nAll, 0);
        const placed = p.places.length || p.codes.some(c => c.strict);
        out.push(`<li role="row" class="us-more"><span role="rowheader">${restGroups} more club${restGroups === 1 ? '' : 's'}, ${restTeams} team${restTeams === 1 ? '' : 's'}. ${usNarrowHint(p, placed)}</span></li>`);
      }
      usList(out.join(''));
      let start = keepKey ? usPos.findIndex(x => x.key === keepKey) : -1;
      if (start < 0) start = usItems.findIndex(Boolean);
      if (start < 0) start = 0;
      if (usItems.length) usSetActive(start);
    }
    // MF1 (review of #134): a hover moves the active cell, and so the action bar, only once the
    // pointer has rested 250 ms on a cell. A mouse crossing chips on its way to the bar's links
    // leaves the bar on the chip it was reading.
    const US_HOVER_MS = 250;
    let usHoverT = 0;
    function usHoverCell(i) {
      clearTimeout(usHoverT);
      if (usView && i !== usActiveIdx) usHoverT = setTimeout(() => { if (usView && usItems.length > i) usSetActive(i, true); }, US_HOVER_MS);
    }
    function usHoverCancel() { clearTimeout(usHoverT); }
    function usToggle(i) {
      const pos = usPos[i];
      if (!usView || !pos || !pos.toggle) return false;
      if (usView.open.has(pos.key)) usView.open.delete(pos.key); else usView.open.add(pos.key);
      usRenderView(usView.res, usView.q, pos.key);
      return true;
    }
    // Up and Down move between rows (keeping the nearest column); Left and Right, Home and End move
    // along a row, but only once the viewer has moved into the list with Up or Down (until then they
    // are the text caret's; a hover moves the active cell without taking them, S2); Enter opens the
    // team through usGo (r.href) or opens and closes an "ended" chip.
    function usKeyView(e) {
      usHoverCancel();   // a key wins over a pending hover
      if (!usView || !usItems.length || usActiveIdx < 0) return false;
      const at = usPos[usActiveIdx];
      const pick = (pred, score) => { let best = -1, bs = Infinity; usPos.forEach((x, i) => { if (pred(x)) { const s = score(x); if (s < bs) { bs = s; best = i; } } }); return best; };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        usView.nav = true;
        const rows = [...new Set(usPos.map(x => x.row))].sort((a, b) => a - b);
        const k = rows.indexOf(at.row), to = rows[(k + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
        usSetActive(pick(x => x.row === to, x => Math.abs(x.col - at.col)));
        return true;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        if (!usView.nav) return false;
        const same = usPos.map((x, i) => [x, i]).filter(([x]) => x.row === at.row).sort((a, b) => a[0].col - b[0].col).map(x => x[1]);
        const k = same.indexOf(usActiveIdx);
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? same.length - 1 : k + (e.key === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        if (j >= 0 && j < same.length) usSetActive(same[j]);
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!usToggle(usActiveIdx)) usGo(usActiveIdx, e.shiftKey ? 'season' : null);
        return true;
      }
      return false;
    }
    function usKey(e) {
      const pop = usPop();
      if (usView && !pop.hidden && usKeyView(e)) return;   // #133: rows and cells
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (pop.hidden) { usOpen(e.target); return; }
        e.preventDefault();
        if (!usItems.length) return;
        const n = usItems.length;
        usSetActive(((usActiveIdx < 0 ? -1 : usActiveIdx) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      } else if (e.key === 'Enter') { e.preventDefault(); if (usActiveIdx >= 0) usGo(usActiveIdx, e.shiftKey ? 'season' : null); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (!pop.hidden && e.target.value) { e.target.value = ''; usRun(''); } else { usClose(); e.target.blur(); }
      } else if (e.key === 'Tab' && !usSheet() && !e.shiftKey && !document.getElementById('usearchActions').hidden) {
        // Tab from the bar goes to the active row's links, then out (the popover then closes).
        e.preventDefault(); document.getElementById('usearchOpen').focus();
      } else if (e.key === 'Tab' && !usSheet()) usClose();
    }
