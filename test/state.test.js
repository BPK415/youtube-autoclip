import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, loadState, saveState, videosByStatus, isCapActive } from '../src/state.js';

test('loadState returns an empty state when the file is missing', () => {
  assert.deepEqual(loadState(path.join(os.tmpdir(), `nope-${Date.now()}.json`)), emptyState());
});

test('saveState creates parent dirs, round-trips, and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-state-'));
  const file = path.join(dir, 'nested', 'state.json');
  const s = emptyState();
  s.videos.abc = { status: 'pending', title: 't', publishedAt: 'p' };
  saveState(file, s);
  assert.deepEqual(loadState(file), s);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('videosByStatus filters by status', () => {
  const s = emptyState();
  s.videos.a = { status: 'pending' };
  s.videos.b = { status: 'complete' };
  assert.deepEqual(videosByStatus(s, 'pending').map(([id]) => id), ['a']);
});

test('isCapActive is true only within the same UTC month', () => {
  const s = { ...emptyState(), capReachedAt: '2026-10-03T00:00:00Z' };
  assert.equal(isCapActive(s, new Date('2026-10-25T00:00:00Z')), true);
  assert.equal(isCapActive(s, new Date('2026-11-01T00:00:00Z')), false);
  assert.equal(isCapActive(emptyState()), false);
});
