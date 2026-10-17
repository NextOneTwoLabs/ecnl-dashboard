// #163 (#149 phase 1, PR 3): words, matching and scoring, shared by every category.
// Pure functions: no page globals, no storage, no network, no clock.
//
// A query word expands into index terms by three classes (design, "Matching and ranking"):
//   exact  1.0  the same word
//   prefix 0.7  the last word typed at any length; any other word from 3 letters
//   typo   0.4  letters-only words from 4 letters, within 1 edit (2 from 8 letters); a swap of
//               neighbouring letters counts as 1 (optimal string alignment)
// Fix 1: club initials match exactly or by prefix, never by typo. Refinement A (owner, #163 Q4):
// a word that is itself a known term is never also read as a typo of another.
//
// Scoring is BM25F with one saturation per query word (plan v2 MF3): the word's best expansion in
// each field is weighted and length-normalised, the fields are summed, and only then saturated.

export const CLASS = { exact: 1.0, prefix: 0.7, typo: 0.4 };
export const CLASS_RANK = { exact: 0, prefix: 1, typo: 2 };
export const K1 = 1.2;
// b = 0: names are 2 to 6 words, and a lighter b still let an old squad's shorter name outrank
// the current squad of the same club before "plays this season" could break the tie (#163, tuned
// on the judged set: Y06, W03).
export const B = 0;

// Lower case, accents dropped, '.' and apostrophes dropped (so "St." is "st", "O'Fallon" is
// "ofallon"), dashes unified. Word splitting happens in words().
const ASCII = /^[\x00-\x7f]*$/;
export function normalize(s) {
  let t = String(s == null ? '' : s);
  if (!ASCII.test(t)) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/’/g, '');
  return t.toLowerCase().replace(/[.']/g, '');
}
export const words = s => { const out = []; for (const w of normalize(s).split(/[^a-z0-9]+/)) if (w) out.push(w); return out; };

// Words that say nothing about which team or event it is (today's search, #114).
export const NOISE = new Set(['ecnl', 'girls', 'girl', 'team', 'teams', 'the', 'and', 'of', 'based', 'from']);
// Age tokens in names ("gu15", "g06", "g2012", "13", "08g", "2026"): read as ages, never as name words.
export const AGE_WORD = /^(g?u\d{1,2}|g?\d{2}|g?(19|20)\d{2}|\d{2}g|u\d{2}rl|\d{4})$/;
// Spellings that mean the same, both ways ("saint louis" finds "St Louis").
export const NAME_ALIAS = { mount: 'mt', mt: 'mount', saint: 'st', st: 'saint' };
export const nameWordsOf = ws => ws.filter(w => !NOISE.has(w) && !AGE_WORD.test(w));   // #167: from words() already made
export const nameWords = s => nameWordsOf(words(s));
// A word plus its NAME_ALIAS twin.
export const withAliases = ws => [...new Set(ws.flatMap(w => (NAME_ALIAS[w] ? [w, NAME_ALIAS[w]] : [w])))];
// "United Futbol Academy" -> "ufa": clubs are often called by their initials.
export function initials(name) {
  const w = nameWords(name).filter(x => /^[a-z]/.test(x));
  return w.length >= 3 ? w.map(x => x[0]).join('') : null;
}
// All-caps words of two or more letters as written ("LA Breakers FC" -> LA, FC): an alias such as
// `la` matches only these (D3), never the plain word "La" of "La Roca".
export const capsWords = s => String(s || '').split(/[^A-Za-z0-9]+/).filter(w => w.length >= 2 && /^[A-Z]+$/.test(w));

// "MVLA ECNL G2010/11" -> "MVLA"; "Sting Black ECNL G2011/12" -> "Sting Black" (today's teamTitle).
export function teamTitle(name, clubName) {
  const t = String(name || '')
    .replace(/\b(G?U\d{1,2}(\/U?\d{1,2})?( Composite)?|G?(19|20)\d{2}(\/\d{2,4})?|G\d{2}(\/\d{2})?|\d{2}G|U\d{2}RL)\b/gi, '')
    .replace(/\bECNL\b(?!\s*-?R)/gi, '').replace(/\s*[-–]\s*$/, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  return t || clubName || name;
}

// Optimal string alignment distance, stopping once it passes max. `stats.osaCells` counts the work.
export function osa(a, b, max, stats) {
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
    if (stats) stats.osaCells += b.length;
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

export const typoMax = w => (w.length >= 8 ? 2 : 1);
export const typoAllowed = w => w.length >= 4 && /^[a-z]+$/.test(w);

// A sorted term list, bucketed by length, so a typo scan visits only lengths it can reach.
export class TermList {
  constructor(terms, { bucketed = true } = {}) {
    this.sorted = [...new Set(terms)].sort();
    this.set = new Set(this.sorted);
    this.bucketed = bucketed;
    this.byLen = new Map();
    for (const t of this.sorted) { if (!this.byLen.has(t.length)) this.byLen.set(t.length, []); this.byLen.get(t.length).push(t); }
    this.maxLen = Math.max(0, ...this.byLen.keys());
  }
  has(t) { return this.set.has(t); }
  // Terms that start with w, by binary search on the sorted list.
  *prefixed(w, stats) {
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sorted[mid] < w) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < this.sorted.length && this.sorted[i].startsWith(w); i++) { if (stats) stats.termsVisited++; yield this.sorted[i]; }
  }
  // Candidate terms for a typo of w: lengths within the edit bound, or (the last word, still
  // being typed) any longer term, whose first letters are compared.
  *typoCandidates(w, max, last, stats) {
    const lens = this.bucketed ? [...this.byLen.keys()].filter(n => n >= w.length - max && (last || n <= w.length + max)) : [...this.byLen.keys()];
    for (const n of lens) for (const t of this.byLen.get(n)) { if (stats) stats.termsVisited++; yield t; }
  }
}

// Expand one query word against a category's terms: Map(term -> { cls, m }).
//   terms     TermList of the category's ordinary terms
//   initials  TermList of its initials (stored as '#' + initials): exact or prefix only (Fix 1)
//   known     every term and vocabulary word of every category: refinement A
// Within one edit, the first two letters agree somewhere (a substitution, insertion, deletion or swap
// at the start still leaves one of these pairs equal): a cheap test before the full alignment.
const mayBeOneEdit = (a, b) => a[0] === b[0] || a[1] === b[1] || a[0] === b[1] || a[1] === b[0];

// Letters of a that b lacks (as multisets). Each edit removes at most one such letter (a swap none),
// so a surplus above max rules a term out before the full alignment. Scratch counts are reset on
// every call.
const COUNTS = new Int16Array(128);
function surplus(a, b) {
  for (let i = 0; i < b.length; i++) COUNTS[b.charCodeAt(i) & 127]++;
  let n = 0;
  for (let i = 0; i < a.length; i++) { const c = a.charCodeAt(i) & 127; if (COUNTS[c] > 0) COUNTS[c]--; else n++; }
  for (let i = 0; i < b.length; i++) COUNTS[b.charCodeAt(i) & 127] = 0;
  return n;
}

export function expand(word, { terms, initials: inits, known, last, stats, cache }) {
  const ck = cache && `${last ? 1 : 0}|${word}`;
  if (cache && cache.has(ck)) return cache.get(ck);
  const out = new Map();
  if (cache) cache.set(ck, out);
  const put = (t, cls) => { const o = out.get(t); if (!o || CLASS_RANK[cls] < CLASS_RANK[o.cls]) out.set(t, { cls, m: CLASS[cls] }); };
  const prefixOk = last || word.length >= 3;
  if (terms.has(word)) put(word, 'exact');
  if (prefixOk) for (const t of terms.prefixed(word, stats)) put(t, t === word ? 'exact' : 'prefix');
  if (inits) {
    if (inits.has('#' + word)) put('#' + word, 'exact');
    if (prefixOk) for (const t of inits.prefixed('#' + word, stats)) put(t, t === '#' + word ? 'exact' : 'prefix');
  }
  if (typoAllowed(word) && !(known && known.has(word))) {
    const max = typoMax(word);
    for (const t of terms.typoCandidates(word, max, last, stats)) {
      if (out.has(t) || (max === 1 && !mayBeOneEdit(word, t))) continue;
      const head = last && t.length > word.length + max ? t.slice(0, word.length + max) : null;
      if ((surplus(word, t) <= max && osa(word, t, max, stats) <= max) || (head && surplus(word, head) <= max && osa(word, head, max, stats) <= max)) put(t, 'typo');
    }
  }
  return out;
}

// Runs a staged builder (a generator) to its end and returns its value: how the one-shot builders
// are defined (#165: startIndex is the build; buildIndex drains it).
export function drain(g) { let r; while (!(r = g.next()).done); return r.value; }

// One category's fielded documents and postings, for BM25F, built in steps of at most `n` documents
// (the `Postings` constructor drains it).
//   fields   [{ name, w }]
//   docs     [{ fields: [[term...]...] }]: each field its distinct terms (names are short: tf = 1)
export function* postingsG(fieldDefs, docs, n) {
  const P = Object.create(Postings.prototype);
  P.fieldDefs = fieldDefs; P.N = docs.length; P.docs = docs; P.post = new Map(); P.idfs = new Map(); P.lists = docs.map(d => d.fields);
  const sums = fieldDefs.map(() => 0);
  for (let i = 0; i < docs.length; i++) {
    if (i && i % n === 0) yield 'postings';
    const d = docs[i], seen = new Set();
    d.fields.forEach((f, k) => { sums[k] += f.length; for (const t of f) if (!seen.has(t)) { seen.add(t); if (!P.post.has(t)) P.post.set(t, []); P.post.get(t).push(i); } });
  }
  P.avg = sums.map(s => (docs.length ? s / docs.length || 1 : 1));
  yield 'postings';
  const all = [...P.post.keys()];
  P.terms = new TermList(all.filter(t => t[0] !== '#'));
  P.initials = new TermList(all.filter(t => t[0] === '#'));
  return P;
}
export class Postings {
  constructor(fieldDefs, docs) { return drain(postingsG(fieldDefs, docs, Infinity)); }
  df(t) { return (this.post.get(t) || []).length; }
  idf(t) {
    let v = this.idfs.get(t);
    if (v === undefined) { const df = this.df(t); v = Math.log(1 + (this.N - df + 0.5) / (df + 0.5)); this.idfs.set(t, v); }
    return v;
  }
  // Documents holding any term of an expansion.
  candidates(exp, stats) {
    const out = new Set();
    for (const t of exp.keys()) for (const i of this.post.get(t) || []) { if (stats) stats.postingsVisited++; out.add(i); }
    return out;
  }
  // The BM25F score of one query word in one document, or null when it is not there:
  // { s, cls, term, field }. One contribution per word, however many fields hold it (MF3).
  // `skip`: a field the word may not match in (a place word read as a name: not the city text).
  wordScore(i, exp, skip = -1) {
    const fields = this.lists[i];
    let T = 0, bestPart = -1, bestTerm = null, bestCls = null, bestField = -1;
    for (let k = 0; k < fields.length; k++) {
      if (k === skip) continue;
      let ft = null, fm = 0, fc = null;
      const list = fields[k];
      for (let j = 0; j < list.length; j++) {
        const t = list[j];
        const e = exp.get(t);
        if (e && (ft === null || e.m > fm || (e.m === fm && t < ft))) { ft = t; fm = e.m; fc = e.cls; }
      }
      if (ft === null) continue;
      const part = this.fieldDefs[k].w * fm / (1 - B + B * list.length / this.avg[k]);
      T += part;
      if (part > bestPart || (part === bestPart && ft < bestTerm)) { bestPart = part; bestTerm = ft; bestCls = fc; bestField = k; }
    }
    if (bestTerm === null) return null;
    return { s: this.idf(bestTerm) * T / (K1 + T), cls: bestCls, term: bestTerm, field: this.fieldDefs[bestField].name };
  }
}

// A filter word scores as an exact match in its own pseudo-field (tf 1, no length normalisation),
// with the rarity of the documents that pass that filter alone (MF3).
export function filterScore(w, passing, N) {
  const idf = Math.log(1 + (N - passing + 0.5) / (passing + 0.5));
  return idf * w / (K1 + w);
}

export const worseClass = (a, b) => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);
