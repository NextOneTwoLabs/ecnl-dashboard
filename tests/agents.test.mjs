// #180: the team roster in .claude/agents/ (Yunchang and Yide, Staff Software Engineers; Kongming, the Reviewer, who also runs
// the read-only production check; Xuande, the TPM). The agent files are configuration the team starts from, so this checks
// that they are what the roster says: the exact files, valid front matter, the tool restrictions, and no old role names.
// Offline, no data. Run under the netguard:
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

const FILES = ['kongming.md', 'xuande.md', 'yide.md', 'yunchang.md'];
const agent = f => parseFrontMatter(readLF(new URL(f, AGENTS)));

test('the folder holds exactly the four roster files (no auditor, engineer or reviewer)', () => {
  assert.deepEqual(readdirSync(AGENTS).sort(), FILES);
});

test('each file has valid front matter: name = the file name, a description, a known model and effort', () => {
  for (const f of FILES) {
    const { meta, body } = agent(f);
    assert.equal(meta.name, f.replace(/\.md$/, ''), f);
    assert.ok(meta.description.length > 20, `${f}: a description`);
    assert.ok(['sonnet', 'opus'].includes(meta.model), `${f}: model ${meta.model}`);
    assert.ok(['low', 'medium', 'high'].includes(meta.effort), `${f}: effort ${meta.effort}`);
    assert.ok(body.trim().length > 200, `${f}: instructions follow the front matter`);
  }
});

test('Kongming and Xuande are restricted: Kongming disallows Edit, Write and NotebookEdit; Xuande Edit and NotebookEdit; the engineers nothing', () => {
  assert.deepEqual(agent('kongming.md').meta.disallowedTools, ['Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(agent('xuande.md').meta.disallowedTools, ['Edit', 'NotebookEdit']);
  for (const f of ['yunchang.md', 'yide.md']) assert.equal('disallowedTools' in agent(f).meta, false, f);
  assert.deepEqual([agent('kongming.md').meta.model, agent('xuande.md').meta.model], ['opus', 'opus']);
  assert.deepEqual([agent('yunchang.md').meta.model, agent('yide.md').meta.model], ['sonnet', 'sonnet']);
});

test('Yunchang and Yide keep the same engineer rules: the bodies are identical after the title line', () => {
  const rest = f => agent(f).body.trim().split('\n').slice(1).join('\n');
  assert.equal(rest('yide.md'), rest('yunchang.md'));
  assert.match(agent('yunchang.md').body, /^\s*You are Yunchang, a Staff Software Engineer/);
  assert.match(agent('yide.md').body, /^\s*You are Yide, a Staff Software Engineer/);
});

test('the rules that must survive the merge are in the files: Kongming\'s production check and budget, Xuande\'s limits', () => {
  const k = agent('kongming.md').body;
  for (const s of ['https://ecnl.nextonetwo.com/', '1280x800', '390x844', 'not verified', 'at most 25 requests', 'Return the report to Xuande', 'totalglobalsports.com', 'D:\\Projects\\ECNLDash']) assert.ok(k.includes(s), `kongming.md: ${s}`);
  const x = agent('xuande.md').body;
  for (const s of ['only the owner merges', "owner's explicit OK", 'tier label', '#12', 'tokens and cost']) assert.ok(x.includes(s), `xuande.md: ${s}`);
  assert.match(agent('yide.md').body, /Kongming verifies live after merge/);
});

test('no old role names: Yazi, Bixi, Website Auditor and a capitalised Auditor are gone from README.md, docs/*.md and .claude/agents/*.md', () => {
  const files = [new URL('README.md', ROOT), ...readdirSync(new URL('docs/', ROOT)).filter(n => n.endsWith('.md')).map(n => new URL(`docs/${n}`, ROOT)),
    ...FILES.map(f => new URL(f, AGENTS))];
  for (const u of files) assert.doesNotMatch(readLF(u), /\bYazi\b|\bBixi\b|Website Auditor|\bAuditor\b/, u.pathname);
  assert.match(readLF(new URL('README.md', ROOT)), /auditor-93/, 'the API-key label example stays (lower case, a label, not a role)');
});

test('the front-matter reader has teeth: each bad file is rejected, and a CRLF copy reads the same', () => {
  const good = '---\nname: x\ndescription: d\nmodel: opus\n---\nbody\n';
  assert.deepEqual(parseFrontMatter(good).meta, { name: 'x', description: 'd', model: 'opus' });
  assert.deepEqual(parseFrontMatter(good.replace(/\n/g, '\r\n')), parseFrontMatter(good));
  const bad = {
    'no opening ---': 'name: x\n---\n',
    'no closing ---': '---\nname: x\nbody\n',
    'a duplicate key': '---\nname: x\nname: y\n---\n',
    'a blank value': '---\nname: x\nmodel:  \n---\n',
    'an unknown key': '---\nname: x\ncolor: red\n---\n',
    'a line with no colon': '---\nname x\n---\n',
    'an empty disallowedTools entry': '---\nname: x\ndisallowedTools: Edit, , Write\n---\n',
  };
  for (const [what, text] of Object.entries(bad)) assert.throws(() => parseFrontMatter(text), Error, what);
  assert.deepEqual(parseFrontMatter('---\ndisallowedTools: Edit,Write ,  NotebookEdit\n---\n').meta.disallowedTools, ['Edit', 'Write', 'NotebookEdit'], 'split on commas, trimmed');
});
