import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPass } from '../src/run.js';
import { emptyState } from '../src/state.js';
import { validateConfig } from '../src/config.js';
import { OpusClipError } from '../src/opusclip.js';

const CH = 'UC1234567890abcdefghijkl';
const NOW = new Date('2026-10-25T18:00:00Z');
const FEED = [
  { videoId: 'AAAAAAAAAAA', title: 'Newest', publishedAt: '2026-10-25T12:00:00.000Z' },
  { videoId: 'BBBBBBBBBBB', title: 'Quick #Shorts', publishedAt: '2026-10-24T12:00:00.000Z' },
  { videoId: 'CCCCCCCCCCC', title: 'Older', publishedAt: '2026-10-20T12:00:00.000Z' },
];
const cfg = (over = {}) => validateConfig({ channelId: CH, ...over }, fs.mkdtempSync(path.join(os.tmpdir(), 'ac-run-')));
const feedOf = (entries) => async () => entries;
const done = (id) => ({ id, stage: 'COMPLETE' });
const fakeClient = (over = {}) => {
  const calls = { create: [], get: [], list: [] };
  return { calls, client: {
    createProject: async (b) => { calls.create.push(b); return over.create ? over.create(b) : { id: 'P' + b.videoUrl.slice(-11), stage: 'QUEUED' }; },
    getProject: async (id) => { calls.get.push(id); return over.get ? over.get(id) : { id, stage: 'QUEUED' }; },
    listClips: async (id) => { calls.list.push(id); return over.list ? over.list(id) : []; },
  } };
};
const downloads = [];
const fakeDownload = async (url, dest) => { downloads.push({ url, dest }); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, url); };
const failingDownload = async () => { throw new Error('boom'); };
const clips = (n, withUrl = true) => Array.from({ length: n }, (_, i) => ({ id: `P.c${i + 1}`, title: `Clip ${i + 1}!`, durationMs: 1000 * (i + 1), uriForExport: withUrl ? `https://cdn/c${i + 1}.mp4` : undefined }));
const submitted = (id, projectId, submittedAt = '2026-10-25T17:00:00.000Z') => ({ title: 't', publishedAt: 'p', status: 'submitted', projectId, submittedAt });
const base = (over = {}) => ({ now: () => NOW, log: () => {}, download: fakeDownload, ...over });

test('first run baselines every feed entry as skipped and submits nothing', async () => {
  const state = emptyState();
  const { client, calls } = fakeClient();
  await runPass(base({ config: cfg(), state, client, feed: feedOf(FEED) }));
  assert.equal(state.baselinedAt, NOW.toISOString());
  assert.deepEqual(Object.values(state.videos).map((v) => v.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(calls.create.length, 0);
});

test('first run with backfill submits the newest N, still skipping #shorts titles', async () => {
  const state = emptyState();
  const { client, calls } = fakeClient();
  await runPass(base({ config: cfg(), state, client, feed: feedOf(FEED), backfill: 2 }));
  assert.equal(state.videos.AAAAAAAAAAA.status, 'submitted');
  assert.equal(state.videos.AAAAAAAAAAA.projectId, 'PAAAAAAAAAAA');
  assert.equal(state.videos.BBBBBBBBBBB.status, 'skipped');
  assert.equal(state.videos.CCCCCCCCCCC.status, 'skipped');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].videoUrl, 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
  assert.equal(calls.create[0].uploadedVideoAttr.title, 'Newest');
});

test('later run submits new videos oldest-first up to maxInFlight', async () => {
  const state = { ...emptyState(), baselinedAt: '2026-10-01T00:00:00Z' };
  const { client, calls } = fakeClient();
  const feed = feedOf([...FEED, { videoId: 'DDDDDDDDDDD', title: 'D', publishedAt: '2026-10-25T13:00:00.000Z' }]);
  await runPass(base({ config: cfg({ maxInFlight: 2 }), state, client, feed }));
  assert.deepEqual(calls.create.map((b) => b.videoUrl.slice(-11)), ['CCCCCCCCCCC', 'AAAAAAAAAAA']);
  assert.equal(state.videos.DDDDDDDDDDD.status, 'pending');
  assert.equal(state.videos.BBBBBBBBBBB.status, 'skipped');
});

test('CONCURRENT stops submitting and leaves the video pending', async () => {
  const state = { ...emptyState(), baselinedAt: 'x' };
  const { client, calls } = fakeClient({ create: () => { throw new OpusClipError('busy', { status: 429, code: 'CONCURRENT' }); } });
  await runPass(base({ config: cfg(), state, client, feed: feedOf(FEED) }));
  assert.equal(calls.create.length, 1);
  assert.equal(state.videos.AAAAAAAAAAA.status, 'pending');
  assert.equal(state.videos.CCCCCCCCCCC.status, 'pending');
});

test('MONTHLY_CAP records capReachedAt and blocks submits until next UTC month', async () => {
  const state = { ...emptyState(), baselinedAt: 'x' };
  const { client, calls } = fakeClient({ create: () => { throw new OpusClipError('cap', { status: 403, code: 'MONTHLY_CAP' }); } });
  await runPass(base({ config: cfg(), state, client, feed: feedOf(FEED) }));
  assert.equal(state.capReachedAt, NOW.toISOString());
  assert.equal(calls.create.length, 1);
  await runPass(base({ config: cfg(), state, client, feed: feedOf(FEED) }));
  assert.equal(calls.create.length, 1);
  const ok = fakeClient();
  await runPass(base({ config: cfg(), state, client: ok.client, feed: feedOf(FEED), now: () => new Date('2026-11-01T00:00:00Z') }));
  assert.equal(state.capReachedAt, null);
  assert.equal(ok.calls.create.length, 2);
});

test('CLIENT_ERROR marks the video failed; UNAUTHORIZED propagates', async () => {
  const state = { ...emptyState(), baselinedAt: 'x' };
  const bad = fakeClient({ create: () => { throw new OpusClipError('nope', { status: 400, code: 'CLIENT_ERROR' }); } });
  await runPass(base({ config: cfg(), state, client: bad.client, feed: feedOf(FEED) }));
  assert.equal(state.videos.AAAAAAAAAAA.status, 'failed');
  assert.match(state.videos.AAAAAAAAAAA.error, /nope/);
  const s2 = { ...emptyState(), baselinedAt: 'x' };
  const auth = fakeClient({ create: () => { throw new OpusClipError('key', { status: 401, code: 'UNAUTHORIZED' }); } });
  await assert.rejects(runPass(base({ config: cfg(), state: s2, client: auth.client, feed: feedOf(FEED) })), (e) => e.code === 'UNAUTHORIZED');
});

test('COMPLETE project: downloads top clipCount with export urls, writes manifest, marks complete', async () => {
  downloads.length = 0;
  const config = cfg({ clipCount: 2 });
  const state = { ...emptyState(), baselinedAt: 'x', videos: { AAAAAAAAAAA: submitted('AAAAAAAAAAA', 'P1') } };
  const { client } = fakeClient({ get: done, list: () => [...clips(1, false), ...clips(3)] });
  const summary = await runPass(base({ config, state, client, feed: null }));
  const v = state.videos.AAAAAAAAAAA;
  assert.equal(v.status, 'complete');
  assert.equal(v.completedAt, NOW.toISOString());
  assert.deepEqual(downloads.map((d) => d.url), ['https://cdn/c1.mp4', 'https://cdn/c2.mp4']);
  assert.deepEqual(v.clips.map((c) => c.file), ['AAAAAAAAAAA/01-clip-1.mp4', 'AAAAAAAAAAA/02-clip-2.mp4']);
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'AAAAAAAAAAA', 'manifest.json'), 'utf8'));
  assert.equal(manifest.projectId, 'P1');
  assert.equal(manifest.sourceUrl, 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
  assert.equal(manifest.clips.length, 2);
  assert.deepEqual(summary, [{ videoId: 'AAAAAAAAAAA', status: 'complete', clips: 2 }]);
});

test('COMPLETE project with no exportable clips -> failed', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: { AAAAAAAAAAA: submitted('AAAAAAAAAAA', 'P1') } };
  const { client } = fakeClient({ get: done, list: () => clips(2, false) });
  await runPass(base({ config: cfg(), state, client, feed: null }));
  assert.equal(state.videos.AAAAAAAAAAA.status, 'failed');
  assert.match(state.videos.AAAAAAAAAAA.error, /no exportable clips/);
});

test('STALLED -> failed; in-progress past maxProjectAgeHours -> failed timeout; fresh in-progress stays', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: {
    S: submitted('S', 'PS'), T: submitted('T', 'PT', '2026-10-24T10:00:00.000Z'), F: submitted('F', 'PF'),
  } };
  const stages = { PS: 'STALLED', PT: 'RENDER', PF: 'CURATE' };
  const { client } = fakeClient({ get: (id) => ({ id, stage: stages[id] }) });
  await runPass(base({ config: cfg(), state, client, feed: null }));
  assert.equal(state.videos.S.status, 'failed');
  assert.equal(state.videos.T.status, 'failed');
  assert.equal(state.videos.T.error, 'timeout');
  assert.equal(state.videos.F.status, 'submitted');
});

test('download failure keeps the video submitted; after 30 days it is marked expired', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: { A: submitted('A', 'PA'), O: submitted('O', 'PO', '2026-09-01T00:00:00.000Z') } };
  const { client } = fakeClient({ get: done, list: () => clips(1) });
  await runPass(base({ config: cfg(), state, client, feed: null, download: failingDownload }));
  assert.equal(state.videos.A.status, 'submitted');
  assert.equal(state.videos.O.status, 'failed');
  assert.equal(state.videos.O.error, 'expired');
});

test('feed error skips discovery but still checks in-flight projects', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: { A: submitted('A', 'PA') } };
  const { client, calls } = fakeClient({ get: done, list: () => clips(1) });
  const logs = [];
  await runPass(base({ config: cfg(), state, client, feed: async () => { throw new Error('rss down'); }, log: (m) => logs.push(m) }));
  assert.equal(calls.get.length, 1);
  assert.equal(state.videos.A.status, 'complete');
  assert.ok(logs.some((m) => /rss down/.test(m)));
});
