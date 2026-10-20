// #180, #185: the team in .claude/agents/, one agent file per role with the people named inside it (engineer: Yunchang and
// Yide, Staff Software Engineers; reviewer: Kongming, who also runs the read-only production check; tpm: Xuande). No file
// fixes a model: Xuande picks it for each task from the issue's tier label. The agent files are configuration the team
// starts from, so this checks that they are what the roster says: the exact files, valid front matter, the people each
// lists, the tool restrictions, no fixed model, and no old role names. Offline, no data. Run under the netguard:
//   node --import ./tests/netguard/netguard.mjs --test tests/agents.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const readLF = url => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');   // a core.autocrlf=true checkout has CRLF
const AGENTS = new URL('.claude/agents/', ROOT);
const KEYS = ['name', 'description', 'model', 'effort', 'disallowedTools'];

// A hand-written reader of the front matter (the repo has no YAML library and gets none): `---` on line 1, one
// `key: value` per line, a closing `---`. It rejects what an agent file must not have. -> { meta, body }
export function parseFrontMatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error('no opening ---');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('no closing ---');
  const meta = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z]+): (.*)$/.exec(l);
    if (!m) throw new Error(`not a "key: value" line: ${l}`);
    const [, key, value] = m;
    if (!KEYS.includes(key)) throw new Error(`unknown key ${key}`);
    if (key in meta) throw new Error(`duplicate key ${key}`);
    if (!value.trim()) throw new Error(`blank value for ${key}`);
    meta[key] = value.trim();
  }
  if ('disallowedTools' in meta) {
    meta.disallowedTools = meta.disallowedTools.split(',').map(x => x.trim());
    if (meta.disallowedTools.some(x => !x)) throw new Error('empty entry in disallowedTools');
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

const ROLES = { engineer: ['Yunchang', 'Yide'], reviewer: ['Kongming'], tpm: ['Xuande'] };
const FILES = Object.keys(ROLES).map(r => `${r}.md`).sort();
const agent = f => parseFrontMatter(readLF(new URL(f, AGENTS)));

test('the folder holds exactly the three role files: engineer, reviewer and tpm (no file per person, no auditor)', () => {
  assert.deepEqual(readdirSync(AGENTS).sort(), FILES);
});

test('each file has valid front matter: name = the role = the file name, a description, effort, and no fixed model (inherit: Xuande picks it per task)', () => {
  for (const f of FILES) {
    const { meta, body } = agent(f);
    assert.equal(meta.name, f.replace(/\.md$/, ''), f);
    assert.ok(meta.description.length > 20, `${f}: a description`);
    assert.equal(meta.model, 'inherit', `${f}: model ${meta.model} (never a fixed opus or sonnet)`);
    assert.ok(['low', 'medium', 'high'].includes(meta.effort), `${f}: effort ${meta.effort}`);
    assert.ok(body.trim().length > 200, `${f}: instructions follow the front matter`);
  }
});

test('each file lists its people, in the description and in the instructions; the engineer file says the brief names which one', () => {
  for (const [role, people] of Object.entries(ROLES)) {
    const { meta, body } = agent(`${role}.md`);
    for (const who of people) {
      assert.match(meta.description, new RegExp(`\\b${who}\\b`), `${role}.md description: ${who}`);
      assert.match(body, new RegExp(`\\b${who}\\b`), `${role}.md body: ${who}`);
    }
  }
  assert.match(agent('engineer.md').body, /^\s*You are a Staff Software Engineer/);
  assert.match(agent('engineer.md').body, /brief you start from tells you which one you are/);
  assert.match(agent('reviewer.md').body, /^\s*You are Kongming, the Reviewer/);
  assert.match(agent('tpm.md').body, /^\s*You are Xuande, the TPM/);
});

test('the reviewer and the TPM are restricted: the reviewer disallows Edit, Write and NotebookEdit; the TPM Edit and NotebookEdit; the engineer nothing', () => {
  assert.deepEqual(agent('reviewer.md').meta.disallowedTools, ['Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(agent('tpm.md').meta.disallowedTools, ['Edit', 'NotebookEdit']);
  assert.equal('disallowedTools' in agent('engineer.md').meta, false);
});

test('the model rule is in every file: Xuande picks it per task from the tier label; the TPM file says Xuande decides the model of each task (Opus for tricky work, Sonnet for routine), that no issue defaults to one, and to pass the model', () => {
  for (const f of FILES) { const b = agent(f).body; assert.match(b, /Xuande/, `${f}: Xuande`); assert.match(b, /tier label/, `${f}: tier label`); }
  const x = agent('tpm.md').body;
  for (const s of ['for every role', 'matching tier label', '`tier:opus`', '`tier:sonnet`', 'Opus for tricky work', 'Sonnet for routine work', 'No issue defaults to a model', 'in every cost report', 'pass the model every time you start an agent']) assert.ok(x.includes(s), `tpm.md: ${s}`);
  assert.doesNotMatch(x, /no tier label|defaults? to Sonnet|runs on Sonnet/i, 'tpm.md: no default model for an unlabelled issue');
});

test('the rules that must survive the merge are in the files: the reviewer\'s production check, budget and dry-run rule, the TPM\'s limits, the engineer\'s PR format', () => {
  const k = agent('reviewer.md').body;
  for (const s of ['https://ecnl.nextonetwo.com/', '1280x800', '390x844', 'not verified', 'at most 25 requests', 'Return the report to Xuande', 'totalglobalsports.com', 'D:\\Projects\\ECNLDash', 'Do not post audit results to GitHub',
    'dry-run', 'offline', 'after every step', 'only on a request to a TGS host']) assert.ok(k.includes(s), `reviewer.md: ${s}`);
  const x = agent('tpm.md').body;
  for (const s of ['only the owner merges', "owner's explicit OK", 'tier label', '#12', 'tokens and cost']) assert.ok(x.includes(s), `tpm.md: ${s}`);
  assert.match(agent('engineer.md').body, /Kongming verifies live after merge/);
});

test('no old names: Yazi, Bixi, Website Auditor, a capitalised Auditor and a file per person (yunchang.md, kongming.md, ...) are gone from README.md, docs/*.md and .claude/agents/*.md', () => {
  const files = [new URL('README.md', ROOT), ...readdirSync(new URL('docs/', ROOT)).filter(n => n.endsWith('.md')).map(n => new URL(`docs/${n}`, ROOT)),
    ...FILES.map(f => new URL(f, AGENTS))];
  for (const u of files) assert.doesNotMatch(readLF(u), /\bYazi\b|\bBixi\b|Website Auditor|\bAuditor\b|\b(?:yunchang|yide|kongming|xuande)\.md\b/, u.pathname);
  assert.match(readLF(new URL('README.md', ROOT)), /auditor-93/, 'the API-key label example stays (lower case, a label, not a role)');
});

test('the front-matter reader has teeth: each bad file is rejected, and a CRLF copy reads the same', () => {
  const good = '---\nname: x\ndescription: d\nmodel: opus\n---\nbody\n';
  assert.deepEqual(parseFrontMatter(good).meta, { name: 'x', description: 'd', model: 'opus' });
  assert.deepEqual(parseFrontMatter(good.replace(/\n/g, '\r\n')), parseFrontMatter(good));
  const bad = {
    'no opening ---': 'name: x\n---\n',
    'no closing ---': '---\nname: x\nbody\n',
    'no closing --- (front matter only)': '---\nname: x\n',
    'a duplicate key': '---\nname: x\nname: y\n---\n',
    'a blank value': '---\nname: x\nmodel:  \n---\n',
    'an unknown key': '---\nname: x\ncolor: red\n---\n',
    'a line with no colon': '---\nname x\n---\n',
    'an empty disallowedTools entry': '---\nname: x\ndisallowedTools: Edit, , Write\n---\n',
  };
  for (const [what, text] of Object.entries(bad)) assert.throws(() => parseFrontMatter(text), Error, what);
  assert.deepEqual(parseFrontMatter('---\ndisallowedTools: Edit,Write ,  NotebookEdit\n---\n').meta.disallowedTools, ['Edit', 'Write', 'NotebookEdit'], 'split on commas, trimmed');
});
