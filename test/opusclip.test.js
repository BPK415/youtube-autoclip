import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, buildProjectBody, OpusClipError } from '../src/opusclip.js';
import { validateConfig } from '../src/config.js';

function mockFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no more mocked responses');
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fetch, calls };
}
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };
const mk = (responses) => {
  const m = mockFetch(responses);
  return { ...m, client: createClient({ apiKey: 'sk-test', orgId: 'org_1', fetch: m.fetch, sleep }) };
};
const CFG = validateConfig({ channelId: 'UC1234567890abcdefghijkl', brandTemplateId: 'tpl-1' }, '/b');

test('createClient without an api key throws UNAUTHORIZED', () => {
  assert.throws(() => createClient({ apiKey: null }), (e) => e instanceof OpusClipError && e.code === 'UNAUTHORIZED');
});

test('buildProjectBody maps config and video into the Opus Clip request', () => {
  assert.deepEqual(buildProjectBody(CFG, { videoId: 'dQw4w9WgXcQ', title: 'T' }), {
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    brandTemplateId: 'tpl-1',
    uploadedVideoAttr: { title: 'T' },
    curationPref: { model: 'ClipBasic', clipDurations: [[30, 60]], enableAutoHook: true },
    renderPref: { layoutAspectRatio: 'portrait', quickstartConfig: { enableCaption: true } },
  });
  assert.equal('brandTemplateId' in buildProjectBody({ ...CFG, brandTemplateId: null }, { videoId: 'x', title: 'y' }), false);
});

test('createProject sends bearer auth, org header, JSON body and returns parsed JSON', async () => {
  const { client, calls } = mk([{ status: 201, body: { id: 'P1', stage: 'QUEUED' } }]);
  const out = await client.createProject({ videoUrl: 'u' });
  assert.deepEqual(out, { id: 'P1', stage: 'QUEUED' });
  assert.equal(calls[0].url, 'https://api.opus.pro/api/clip-projects');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['x-opus-org-id'], 'org_1');
  assert.equal(calls[0].init.body, '{"videoUrl":"u"}');
});

test('getProject and listClips use the documented paths; listClips unwraps {data}', async () => {
  const { client, calls } = mk([{ status: 200, body: { id: 'P1', stage: 'COMPLETE' } }, { status: 200, body: { data: [{ id: 'c1' }] } }, { status: 200, body: [{ id: 'c2' }] }]);
  assert.equal((await client.getProject('P1')).stage, 'COMPLETE');
  assert.equal(calls[0].url, 'https://api.opus.pro/api/clip-projects/P1');
  assert.deepEqual(await client.listClips('P1'), [{ id: 'c1' }]);
  assert.match(calls[1].url, /\/api\/exportable-clips\?q=findByProjectId&projectId=P1/);
  assert.deepEqual(await client.listClips('P1'), [{ id: 'c2' }]);
});

test('429 with X-Cap-Reason: concurrent -> CONCURRENT, no retry', async () => {
  const { client, calls } = mk([{ status: 429, headers: { 'x-cap-reason': 'concurrent' } }]);
  await assert.rejects(client.createProject({}), (e) => e.code === 'CONCURRENT');
  assert.equal(calls.length, 1);
});

test('plain 429 retries with backoff then RATE_LIMIT', async () => {
  sleeps.length = 0;
  const { client, calls } = mk([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
  await assert.rejects(client.getProject('P'), (e) => e.code === 'RATE_LIMIT');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test('plain 429 then 200 succeeds', async () => {
  const { client } = mk([{ status: 429 }, { status: 200, body: { ok: 1 } }]);
  assert.deepEqual(await client.getProject('P'), { ok: 1 });
});

test('error code mapping: cap, 401, 403, 500, 404', async () => {
  const codeOf = async (r) => { try { await mk([r]).client.getProject('P'); } catch (e) { return e.code; } };
  assert.equal(await codeOf({ status: 403, body: { code: 'API_MONTHLY_CAP_REACHED' } }), 'MONTHLY_CAP');
  assert.equal(await codeOf({ status: 401 }), 'UNAUTHORIZED');
  assert.equal(await codeOf({ status: 403, body: { message: 'API access required' } }), 'UNAUTHORIZED');
  assert.equal(await codeOf({ status: 500 }), 'SERVER_ERROR');
  assert.equal(await codeOf({ status: 404, body: { message: 'gone' } }), 'CLIENT_ERROR');
});
