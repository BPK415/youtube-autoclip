import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify, downloadFile } from '../src/download.js';

test('slugify lowercases, collapses punctuation, trims, caps length, never empty', () => {
  assert.equal(slugify('  Hello, World! -- Part 2 '), 'hello-world-part-2');
  assert.equal(slugify('!!!'), 'clip');
  assert.equal(slugify('a'.repeat(100)).length, 40);
});

test('downloadFile streams to .part then renames into place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dl-'));
  const dest = path.join(dir, 'vid', '01-x.mp4');
  const fetch = async () => new Response(Buffer.from('hello'));
  assert.equal(await downloadFile('https://x/y.mp4', dest, { fetch }), dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['01-x.mp4']);
});

test('downloadFile throws on HTTP error and leaves no part file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dl-'));
  const dest = path.join(dir, '01-x.mp4');
  await assert.rejects(downloadFile('https://x/y.mp4', dest, { fetch: async () => new Response('', { status: 403 }) }), /HTTP 403/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
