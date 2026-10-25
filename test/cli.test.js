import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = new URL('../bin/autoclip.js', import.meta.url).pathname;
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, OPUSCLIP_API_KEY: '' } });

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /autoclip run/);
});

test('missing config exits 1 with a clear message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  const r = run(['status'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config not found/);
});

test('status on a fresh config prints the empty table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channelId: 'UC1234567890abcdefghijkl' }));
  const r = run(['status'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no videos tracked yet/);
});

test('run without an api key exits 1 mentioning OPUSCLIP_API_KEY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channelId: 'UC1234567890abcdefghijkl' }));
  const r = run(['run'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OPUSCLIP_API_KEY/);
});
