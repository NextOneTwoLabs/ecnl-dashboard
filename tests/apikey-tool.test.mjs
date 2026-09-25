// The owner's key tool, tools/apikey.mjs (#93). It is run here as a lone copy in a fresh temp
// folder, under the network guard, with the system temp folder pointed into that folder, so
// the test proves it is self-contained, and removes every file it made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KEY, hashKey, checkKey, clearKeyCache } from '../api/apikey.mjs';

const NAMESPACE_ID = '0f7cd5892944474598857af3e82bdafb';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const WHERE = `--namespace-id ${NAMESPACE_ID} --remote`;
const GUARD = pathToFileURL(resolve('tests/netguard/netguard.mjs')).href;
const KEY_ANYWHERE = /ecnl_live_[0-9a-f]{12}_[0-9a-f]{64}/g;

// Runs the lone copy; -> { status, out, err }. The child's temp folder is <dir>/tmp.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ecnl-apikey-test-'));
  const temp = join(dir, 'tmp');
  mkdirSync(temp);
  copyFileSync('tools/apikey.mjs', join(dir, 'apikey.mjs'));
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, NETGUARD_REPORT: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
  const run = (...args) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, ['--import', GUARD, 'apikey.mjs', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
    } catch (e) { return { status: e.status, out: e.stdout, err: e.stderr }; }
  };
  return { dir, temp, run, files: () => readdirSync(temp), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const records = (records, cache = true) => { if (cache) clearKeyCache(); return { API_KEYS: { async get(k) { return records.get(k) ?? null; } } }; };

test('tool: self-contained ASCII file with the same namespace id as wrangler.toml', () => {
  const src = readFileSync('tools/apikey.mjs');
  assert.ok(src.every(b => b < 128), 'plain ASCII, so a PowerShell 5.1 copy with -Encoding ascii is exact');
  const text = src.toString('utf8');
  assert.deepEqual([...text.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]).filter(s => !s.startsWith('node:')), [], 'Node standard library only');
  assert.match(readFileSync('wrangler.toml', 'utf8'), new RegExp(`binding = "API_KEYS"\\r?\\nid = "${NAMESPACE_ID}"`));
  assert.ok(text.includes(`'${NAMESPACE_ID}'`));
});

test('tool new: prints the key once; its record matches api/apikey.mjs and is accepted by checkKey', async () => {
  const s = sandbox();
  try {
    const r = s.run('new', '--label', 'auditor-93', '--ttl', '604800');
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^netguard: 0 attempts/m, 'ran under the guard, no network');
    const keys = r.out.match(KEY_ANYWHERE);
    assert.equal(keys.length, 1, 'the key is printed exactly once');
    const key = keys[0], id = KEY.exec(key)[1];
    assert.match(key, KEY, 'the format api/apikey.mjs accepts');
    assert.deepEqual(s.files(), [`ecnl-apikey-${id}.json`], 'one record file, in the system temp folder');
    const file = join(s.temp, `ecnl-apikey-${id}.json`);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(key.slice(23)), 'the record never holds the secret');
    const rec = JSON.parse(raw);
    assert.deepEqual(Object.keys(rec).sort(), ['created', 'hash', 'label', 'status', 'tier', 'v']);
    assert.equal(rec.hash, await hashKey(key), 'the same hash as api/apikey.mjs');
    assert.deepEqual([rec.v, rec.label, rec.tier, rec.status], [1, 'auditor-93', 'standard', 'active']);
    assert.equal((await checkKey('Bearer ' + key, records(new Map([['key:' + id, rec]])))).state, 'ok');
    // The exact commands, for this owner on this platform.
    assert.ok(r.out.includes(`   ${NPX} wrangler kv key put "key:${id}" --path "${file}" ${WHERE} --ttl 604800\n`), r.out);
    assert.ok(r.out.includes(`   ${NPX} wrangler kv key get "key:${id}" ${WHERE}\n`));
    assert.ok(r.out.includes(process.platform === 'win32' ? `   Remove-Item "${file}"\n` : `   rm "${file}"\n`));
    assert.match(r.out, /revoke [0-9a-f]{12} --label "auditor-93"/);
    assert.match(r.out, /--remote because wrangler v4 otherwise uses a local copy/);
    assert.ok(!/--binding/.test(r.out));
    if (process.platform === 'win32') assert.ok(!/(^|\s)npx /m.test(r.out), 'npx.cmd on Windows');
  } finally { s.cleanup(); }
});

test('tool revoke: needs --label; its record reads as revoked; prints the purge', async () => {
  const s = sandbox();
  try {
    const id = 'abcdef012345';
    const bare = s.run('revoke', id);
    assert.equal(bare.status, 2);
    assert.match(bare.err, /--label is required/);
    assert.deepEqual(s.files(), [], 'nothing written when refused');
    const r = s.run('revoke', id, '--label', 'acme-agent');
    assert.equal(r.status, 0, r.err);
    const file = join(s.temp, `ecnl-apikey-${id}-revoked.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(rec).sort(), ['label', 'revoked', 'status', 'v']);
    assert.deepEqual([rec.v, rec.label, rec.status], [1, 'acme-agent', 'revoked']);
    const key = `ecnl_live_${id}_${'0'.repeat(64)}`;
    assert.equal((await checkKey('Bearer ' + key, records(new Map([['key:' + id, rec]])))).state, 'revoked');
    assert.ok(r.out.includes(`   ${NPX} wrangler kv key put "key:${id}" --path "${file}" ${WHERE}\n`), 'no --ttl on a revoke');
    assert.ok(r.out.includes(`   ${NPX} wrangler kv key delete "key:${id}" ${WHERE}`));
    assert.equal(s.run('revoke', 'not-an-id', '--label', 'x').status, 2);
  } finally { s.cleanup(); }
});

test('tool list, get, purge and help print the exact commands', () => {
  const s = sandbox();
  try {
    const id = '0123456789ab';
    assert.ok(s.run('list').out.includes(`   ${NPX} wrangler kv key list ${WHERE} --prefix key:\n`));
    assert.ok(s.run('get', id).out.includes(`   ${NPX} wrangler kv key get "key:${id}" ${WHERE}\n`));
    assert.ok(s.run('purge', id).out.includes(`   ${NPX} wrangler kv key delete "key:${id}" ${WHERE}\n`));
    const help = s.run('help');
    assert.equal(help.status, 0);
    for (const verb of ['new:', 'list:', 'get:', 'revoke:', 'purge:']) assert.ok(help.out.includes(verb), verb);
    assert.match(help.out, /project or agent name/);
    assert.match(help.out, /never a person's name/);
    assert.match(help.out, /standalone PowerShell window/);
    assert.equal(s.run('get').status, 2);
    assert.equal(s.run().status, 2);
    assert.equal(s.run('rotate').status, 2);
    assert.deepEqual(s.files(), []);
  } finally { s.cleanup(); }
});

test('tool refuses --ttl under 60 and bad labels, and writes nothing then', () => {
  const s = sandbox();
  try {
    for (const ttl of ['30', '59', '0', '-60', '1e3', 'abc', '']) {
      const r = s.run('new', '--label', 'ttl-test', '--ttl', ttl);
      assert.equal(r.status, 2, `--ttl ${JSON.stringify(ttl)}`);
    }
    assert.match(s.run('new', '--label', 'ttl-test', '--ttl', '30').err, /at least 60/);
    for (const label of ['a@b.c', ' lead', 'x'.repeat(41), '', 'x<y>', '--ttl']) {
      assert.equal(s.run('new', '--label', label).status, 2, JSON.stringify(label));
    }
    assert.equal(s.run('new').status, 2, 'no label');
    assert.deepEqual(s.files(), []);
    const ok = s.run('new', '--label', 'ttl-test', '--ttl', '60');
    assert.equal(ok.status, 0, ok.err);
    assert.match(ok.out, / --ttl 60\n/);
    assert.equal(s.files().length, 1);
  } finally { s.cleanup(); }
  assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('ecnl-apikey-test-') && n === s.dir.split(/[\\/]/).pop()), [], 'cleaned up');
});
