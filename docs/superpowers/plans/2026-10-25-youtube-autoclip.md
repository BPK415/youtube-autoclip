# youtube-autoclip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node 20 CLI that watches one YouTube channel, submits new uploads to Opus Clip, and downloads the top 10 clips per video.

**Architecture:** Six small ES modules under `src/` (config, state, youtube, opusclip, download, run) composed by one CLI entry in `bin/`. Every module that touches the network takes `fetch` as an injected dependency so tests run offline with `node:test`. State is one JSON file written atomically; each `run` is a short idempotent pass.

**Tech Stack:** Node ≥ 20 (global `fetch`, `node:test`, `node:util.parseArgs`), ES modules, no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-youtube-autoclip-design.md`

## Global Constraints

- Node ≥ 20; `"type": "module"`; **no npm dependencies**.
- Secrets only from env `OPUSCLIP_API_KEY` / `OPUSCLIP_ORG_ID` or a `.env` file; never in config.json; `.env`, `state.json`, `clips/` are git-ignored.
- Opus Clip base URL `https://api.opus.pro`; header `Authorization: Bearer <key>`; optional `x-opus-org-id`.
- Project `stage` values: PENDING, QUEUED, IMPORT, CURATE, REFINE, RENDER, UPLOAD, COMPLETE, STALLED.
- Defaults: clipCount 10, clipDurations [[30,60]], aspectRatio portrait, captions on, auto-hook on, ClipBasic, maxInFlight 4, maxProjectAgeHours 24, skipTitlePatterns ["#shorts"].
- Test runner: `node --test` (files `test/*.test.js`). Commits after every task.

---

## File map

| File | Responsibility |
|---|---|
| `package.json` | name, `"type":"module"`, `bin`, `test` script, engines |
| `src/config.js` | DEFAULTS, `parseDotEnv`, `loadEnv`, `validateConfig`, `loadConfig`, `ConfigError` |
| `src/state.js` | `emptyState`, `loadState`, `saveState` (atomic), `videosByStatus`, `isCapActive` |
| `src/youtube.js` | RSS feed fetch/parse, channel-id resolution, video-id extraction, oEmbed title |
| `src/opusclip.js` | `createClient` (createProject/getProject/listClips with typed errors + backoff), `buildProjectBody`, `OpusClipError` |
| `src/download.js` | `downloadFile` (stream → `.part` → rename), `slugify` |
| `src/run.js` | `runPass`: discover → submit → check → collect, per spec |
| `bin/autoclip.js` | CLI: `run [--watch N] [--backfill N]`, `resolve`, `submit`, `status` |
| `test/*.test.js` | one test file per module, fetch mocked |
| `config.example.json`, `.env.example`, `.gitignore`, `README.md` | setup + scheduling docs |

---

### Task 1: Project scaffold + config module

**Files:**
- Create: `package.json`, `.gitignore`, `config.example.json`, `.env.example`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `DEFAULTS`, `ConfigError`, `parseDotEnv(text) → object`, `loadEnv(dir, env?) → {apiKey, orgId}`, `validateConfig(raw, baseDir?) → config` (outputDir/stateFile absolute), `loadConfig(file) → config`.

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "youtube-autoclip",
  "version": "0.1.0",
  "description": "Watch a YouTube channel and auto-generate the top 10 clips per upload with Opus Clip",
  "type": "module",
  "bin": { "autoclip": "bin/autoclip.js" },
  "scripts": { "test": "node --test", "run": "node bin/autoclip.js run" },
  "engines": { "node": ">=20" },
  "license": "MIT",
  "private": true
}
```
`.gitignore`:
```
node_modules/
.env
state.json
*.tmp
clips/
.DS_Store
```
`config.example.json`:
```json
{
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "clipCount": 10,
  "clipDurations": [[30, 60]],
  "aspectRatio": "portrait",
  "enableCaption": true,
  "enableAutoHook": true,
  "model": "ClipBasic",
  "brandTemplateId": null,
  "skipTitlePatterns": ["#shorts"],
  "maxInFlight": 4,
  "maxProjectAgeHours": 24,
  "outputDir": "./clips",
  "stateFile": "./state.json"
}
```
`.env.example`:
```
OPUSCLIP_API_KEY=sk-your-key-here
# Only needed if your Opus Clip login belongs to more than one organization
# OPUSCLIP_ORG_ID=org_xxxxxxxx
```

- [ ] **Step 2: Write the failing test** `test/config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, validateConfig, DEFAULTS, ConfigError } from '../src/config.js';

const GOOD = { channelId: 'UC1234567890abcdefghijkl' };

test('parseDotEnv reads KEY=value, ignores comments, blanks, bad lines, strips quotes', () => {
  const env = parseDotEnv('# c\nOPUSCLIP_API_KEY="sk-1"\nOPUSCLIP_ORG_ID=org_x\n\nBAD\n');
  assert.deepEqual(env, { OPUSCLIP_API_KEY: 'sk-1', OPUSCLIP_ORG_ID: 'org_x' });
});

test('validateConfig applies defaults and resolves paths against baseDir', () => {
  const c = validateConfig(GOOD, '/base');
  assert.equal(c.clipCount, DEFAULTS.clipCount);
  assert.deepEqual(c.clipDurations, [[30, 60]]);
  assert.equal(c.outputDir, '/base/clips');
  assert.equal(c.stateFile, '/base/state.json');
});

test('validateConfig rejects a handle instead of a channel id', () => {
  assert.throws(() => validateConfig({ channelId: '@handle' }), ConfigError);
});

test('validateConfig rejects bad durations, aspect, model, booleans', () => {
  assert.throws(() => validateConfig({ ...GOOD, clipDurations: [[60, 30]] }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, aspectRatio: 'tall' }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, model: 'ClipMagic' }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, enableCaption: 'yes' }), ConfigError);
});
```

- [ ] **Step 3: Run** `node --test test/config.test.js` → FAIL (cannot find module).

- [ ] **Step 4: Implement** `src/config.js`

```js
import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

export const DEFAULTS = Object.freeze({
  clipCount: 10,
  clipDurations: [[30, 60]],
  aspectRatio: 'portrait',
  enableCaption: true,
  enableAutoHook: true,
  model: 'ClipBasic',
  brandTemplateId: null,
  skipTitlePatterns: ['#shorts'],
  maxInFlight: 4,
  maxProjectAgeHours: 24,
  outputDir: './clips',
  stateFile: './state.json',
});

const ASPECTS = ['portrait', 'square', 'landscape', 'four_five'];
const MODELS = ['ClipBasic', 'ClipAnything'];
export const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function loadEnv(dir, env = process.env) {
  const file = path.join(dir, '.env');
  const fromFile = fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, 'utf8')) : {};
  const get = (k) => env[k] ?? fromFile[k] ?? null;
  return { apiKey: get('OPUSCLIP_API_KEY'), orgId: get('OPUSCLIP_ORG_ID') };
}

const isPosInt = (n) => Number.isInteger(n) && n > 0;
const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) && p[0] >= 0 && p[1] > p[0];

export function validateConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  const c = { ...DEFAULTS, ...raw };
  if (!CHANNEL_ID_RE.test(c.channelId ?? '')) throw new ConfigError('channelId must look like UC… (24 chars). Run: autoclip resolve @yourhandle');
  if (!isPosInt(c.clipCount)) throw new ConfigError('clipCount must be a positive integer');
  if (!Array.isArray(c.clipDurations) || c.clipDurations.length === 0 || !c.clipDurations.every(isPair)) throw new ConfigError('clipDurations must be a non-empty array of [minSec, maxSec] pairs');
  if (!ASPECTS.includes(c.aspectRatio)) throw new ConfigError(`aspectRatio must be one of ${ASPECTS.join(', ')}`);
  if (!MODELS.includes(c.model)) throw new ConfigError(`model must be one of ${MODELS.join(', ')}`);
  if (!Array.isArray(c.skipTitlePatterns) || !c.skipTitlePatterns.every((s) => typeof s === 'string')) throw new ConfigError('skipTitlePatterns must be an array of strings');
  if (!isPosInt(c.maxInFlight)) throw new ConfigError('maxInFlight must be a positive integer');
  if (!(typeof c.maxProjectAgeHours === 'number' && c.maxProjectAgeHours > 0)) throw new ConfigError('maxProjectAgeHours must be a number > 0');
  for (const k of ['enableCaption', 'enableAutoHook']) if (typeof c[k] !== 'boolean') throw new ConfigError(`${k} must be true or false`);
  if (c.brandTemplateId !== null && typeof c.brandTemplateId !== 'string') throw new ConfigError('brandTemplateId must be a string or null');
  c.outputDir = path.resolve(baseDir, c.outputDir);
  c.stateFile = path.resolve(baseDir, c.stateFile);
  return c;
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new ConfigError(`config not found: ${abs} (copy config.example.json to config.json)`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new ConfigError(`config is not valid JSON: ${e.message}`); }
  return validateConfig(raw, path.dirname(abs));
}
```

- [ ] **Step 5: Run** `node --test test/config.test.js` → PASS (4 tests).
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: scaffold project and config module"`

---

### Task 2: State module

**Files:** Create `src/state.js`; Test `test/state.test.js`

**Interfaces:**
- Produces: `emptyState() → {baselinedAt:null, capReachedAt:null, videos:{}}`, `loadState(file)`, `saveState(file, state)` (atomic), `videosByStatus(state, status) → [[id, video], …]`, `isCapActive(state, now?) → boolean`.
- Video record shape: `{ title, publishedAt, status: 'pending'|'submitted'|'complete'|'failed'|'skipped', discoveredAt, projectId?, submittedAt?, completedAt?, error?, clips?: [{id,title,durationMs,file}] }`.

- [ ] **Step 1: Write the failing test** `test/state.test.js`

```js
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
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `src/state.js`

```js
import fs from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return { baselinedAt: null, capReachedAt: null, videos: {} };
}

export function loadState(file) {
  if (!fs.existsSync(file)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...emptyState(), ...parsed, videos: parsed.videos ?? {} };
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function videosByStatus(state, status) {
  return Object.entries(state.videos).filter(([, v]) => v.status === status);
}

export function isCapActive(state, now = new Date()) {
  if (!state.capReachedAt) return false;
  const at = new Date(state.capReachedAt);
  return at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth();
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: add atomic state store`

---

### Task 3: YouTube module

**Files:** Create `src/youtube.js`, `test/fixtures/feed.xml`; Test `test/youtube.test.js`

**Interfaces:**
- Produces: `feedUrl(channelId)`, `watchUrl(videoId)`, `parseFeed(xml) → [{videoId,title,publishedAt(ISO)}]`, `fetchFeed(channelId, {fetch})`, `extractVideoId(input) → id|null`, `channelPageUrl(input) → url|null`, `extractChannelId(html) → id|null`, `resolveChannelId(input, {fetch})`, `fetchVideoTitle(videoId, {fetch}) → string|null`.

- [ ] **Step 1: Fixture** `test/fixtures/feed.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>UC1234567890abcdefghijkl</yt:channelId>
 <title>Test Channel</title>
 <entry>
  <id>yt:video:AAAAAAAAAAA</id>
  <yt:videoId>AAAAAAAAAAA</yt:videoId>
  <title>Newest full episode</title>
  <published>2026-10-25T12:00:00+00:00</published>
 </entry>
 <entry>
  <id>yt:video:BBBBBBBBBBB</id>
  <yt:videoId>BBBBBBBBBBB</yt:videoId>
  <title>Quick one #Shorts</title>
  <published>2026-10-24T12:00:00+00:00</published>
 </entry>
 <entry>
  <id>yt:video:CCCCCCCCCCC</id>
  <yt:videoId>CCCCCCCCCCC</yt:videoId>
  <title>Older episode &amp; friends</title>
  <published>2026-10-20T12:00:00+00:00</published>
 </entry>
</feed>
```

- [ ] **Step 2: Write the failing test** `test/youtube.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeed, fetchFeed, extractVideoId, resolveChannelId, extractChannelId, fetchVideoTitle } from '../src/youtube.js';

const XML = fs.readFileSync(new URL('./fixtures/feed.xml', import.meta.url), 'utf8');
const CH = 'UC1234567890abcdefghijkl';

test('parseFeed extracts id, decoded title, ISO date for each entry', () => {
  const entries = parseFeed(XML);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[2], { videoId: 'CCCCCCCCCCC', title: 'Older episode & friends', publishedAt: '2026-10-20T12:00:00.000Z' });
});

test('fetchFeed hits the channel feed url and throws on HTTP error', async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return new Response(XML, { status: 200 }); };
  const entries = await fetchFeed(CH, { fetch });
  assert.equal(calls[0], `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`);
  assert.equal(entries[0].videoId, 'AAAAAAAAAAA');
  await assert.rejects(fetchFeed(CH, { fetch: async () => new Response('', { status: 404 }) }), /HTTP 404/);
});

test('extractVideoId handles watch, youtu.be, shorts, live urls and bare ids', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtube.com/live/dQw4w9WgXcQ?x=1'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://example.com/'), null);
});

test('extractChannelId finds externalId or channel_id in page html', () => {
  assert.equal(extractChannelId('x "externalId":"UCabcdefghijklmnopqrstuv" y'), 'UCabcdefghijklmnopqrstuv');
  assert.equal(extractChannelId('feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"'), 'UCabcdefghijklmnopqrstuv');
  assert.equal(extractChannelId('<html></html>'), null);
});

test('resolveChannelId returns UC ids untouched and resolves handles via the channel page', async () => {
  assert.equal(await resolveChannelId(CH, { fetch: async () => { throw new Error('should not fetch'); } }), CH);
  const fetch = async (url) => {
    assert.equal(url, 'https://www.youtube.com/@athleteslaunch');
    return new Response('<html>"externalId":"UCabcdefghijklmnopqrstuv"</html>');
  };
  assert.equal(await resolveChannelId('@athleteslaunch', { fetch }), 'UCabcdefghijklmnopqrstuv');
  assert.equal(await resolveChannelId('athleteslaunch', { fetch }), 'UCabcdefghijklmnopqrstuv');
});

test('fetchVideoTitle uses oEmbed and returns null on failure', async () => {
  assert.equal(await fetchVideoTitle('dQw4w9WgXcQ', { fetch: async () => Response.json({ title: 'Hi' }) }), 'Hi');
  assert.equal(await fetchVideoTitle('dQw4w9WgXcQ', { fetch: async () => new Response('', { status: 404 }) }), null);
  assert.equal(await fetchVideoTitle('dQw4w9WgXcQ', { fetch: async () => { throw new Error('net'); } }), null);
});
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `src/youtube.js`

```js
const ID_RE = /UC[A-Za-z0-9_-]{22}/;

export function feedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };
export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e) => ENTITIES[e]);
}

export function parseFeed(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = block.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1];
    if (!videoId || !published) continue;
    entries.push({ videoId, title: decodeEntities(title), publishedAt: new Date(published).toISOString() });
  }
  return entries;
}

export async function fetchFeed(channelId, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(feedUrl(channelId), { headers: { accept: 'application/atom+xml' } });
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`);
  return parseFeed(await res.text());
}

export function extractVideoId(input) {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function channelPageUrl(input) {
  const s = String(input).trim();
  if (new RegExp(`^${ID_RE.source}$`).test(s)) return null;
  if (s.startsWith('@')) return `https://www.youtube.com/${s}`;
  if (/^https?:\/\//.test(s)) return s;
  return `https://www.youtube.com/@${s}`;
}

export function extractChannelId(html) {
  const m = html.match(new RegExp(`"externalId":"(${ID_RE.source})"`))
    || html.match(new RegExp(`channel_id=(${ID_RE.source})`))
    || html.match(new RegExp(`"channelId":"(${ID_RE.source})"`));
  return m ? m[1] : null;
}

export async function resolveChannelId(input, { fetch = globalThis.fetch } = {}) {
  const url = channelPageUrl(input);
  if (!url) return String(input).trim();
  const res = await fetch(url, { headers: { 'accept-language': 'en', 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`channel page fetch failed: HTTP ${res.status}`);
  const id = extractChannelId(await res.text());
  if (!id) throw new Error(`could not find a channel id on ${url}`);
  return id;
}

export async function fetchVideoTitle(videoId, { fetch = globalThis.fetch } = {}) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`);
    if (!res.ok) return null;
    return (await res.json()).title ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run** → PASS. **Step 6: Commit** `feat: add YouTube feed and channel resolution`

---

### Task 4: Opus Clip client

**Files:** Create `src/opusclip.js`; Test `test/opusclip.test.js`

**Interfaces:**
- Produces: `OpusClipError` with `.status`, `.code ∈ {UNAUTHORIZED, CONCURRENT, RATE_LIMIT, MONTHLY_CAP, CLIENT_ERROR, SERVER_ERROR}`, `.body`;
  `buildProjectBody(config, {videoId,title}) → request body`;
  `createClient({apiKey, orgId?, baseUrl?, fetch?, sleep?, maxRetries?}) → { createProject(body), getProject(id), listClips(projectId) → array }`.

- [ ] **Step 1: Write the failing test** `test/opusclip.test.js`

```js
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

test('429 with X-Cap-Reason: concurrent → CONCURRENT, no retry', async () => {
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
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/opusclip.js`

```js
export class OpusClipError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', body = null } = {}) {
    super(message);
    this.name = 'OpusClipError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function buildProjectBody(config, video) {
  const body = {
    videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    uploadedVideoAttr: { title: video.title },
    curationPref: { model: config.model, clipDurations: config.clipDurations, enableAutoHook: config.enableAutoHook },
    renderPref: { layoutAspectRatio: config.aspectRatio, quickstartConfig: { enableCaption: config.enableCaption } },
  };
  if (config.brandTemplateId) body.brandTemplateId = config.brandTemplateId;
  return body;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ apiKey, orgId = null, baseUrl = 'https://api.opus.pro', fetch = globalThis.fetch, sleep = defaultSleep, maxRetries = 3 }) {
  if (!apiKey) throw new OpusClipError('OPUSCLIP_API_KEY is not set (put it in .env or the environment)', { status: 401, code: 'UNAUTHORIZED' });

  async function request(method, path, body) {
    const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
    if (orgId) headers['x-opus-org-id'] = orgId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.ok) return data;
      const detail = data && typeof data === 'object' && data.message ? `: ${data.message}` : '';
      const msg = `${method} ${path} -> HTTP ${res.status}${detail}`;
      if (res.status === 429) {
        if ((res.headers.get('x-cap-reason') || '').toLowerCase() === 'concurrent') throw new OpusClipError(msg, { status: 429, code: 'CONCURRENT', body: data });
        if (attempt < maxRetries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new OpusClipError(msg, { status: 429, code: 'RATE_LIMIT', body: data });
      }
      if (res.status === 403 && data && data.code === 'API_MONTHLY_CAP_REACHED') throw new OpusClipError(msg, { status: 403, code: 'MONTHLY_CAP', body: data });
      if (res.status === 401 || res.status === 403) throw new OpusClipError(msg, { status: res.status, code: 'UNAUTHORIZED', body: data });
      if (res.status >= 500) throw new OpusClipError(msg, { status: res.status, code: 'SERVER_ERROR', body: data });
      throw new OpusClipError(msg, { status: res.status, code: 'CLIENT_ERROR', body: data });
    }
  }

  return {
    createProject: (body) => request('POST', '/api/clip-projects', body),
    getProject: (id) => request('GET', `/api/clip-projects/${encodeURIComponent(id)}`),
    listClips: async (projectId) => {
      const d = await request('GET', `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageSize=100`);
      if (Array.isArray(d)) return d;
      if (d && Array.isArray(d.data)) return d.data;
      if (d && Array.isArray(d.items)) return d.items;
      return [];
    },
  };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: add Opus Clip API client with typed errors and backoff`

---

### Task 5: Download module

**Files:** Create `src/download.js`; Test `test/download.test.js`

**Interfaces:** Produces `slugify(title, max=40) → string` (never empty), `downloadFile(url, dest, {fetch}) → dest`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/download.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function slugify(title, max = 40) {
  const s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '') || 'clip';
}

export async function downloadFile(url, dest, { fetch = globalThis.fetch } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  return dest;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: add streamed clip download`

---

### Task 6: The run pass

**Files:** Create `src/run.js`; Test `test/run.test.js`

**Interfaces:**
- Consumes: `videosByStatus`, `isCapActive` (Task 2); `buildProjectBody`, `OpusClipError` codes (Task 4); `slugify` (Task 5); `watchUrl` (Task 3).
- Produces: `runPass({config, state, client, feed, download, now?, log?, backfill?}) → summary[]` where `feed` is `async () => entries[]` or `null` (skip discovery), `download` is `async (url, dest) => void`, `now` is `() => Date`, and `summary` items are `{videoId, status, ...}`. Mutates `state`. Throws only `OpusClipError` with code `UNAUTHORIZED`.

- [ ] **Step 1: Write the failing test** `test/run.test.js`

```js
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
const fakeClient = (over = {}) => {
  const calls = { create: [], get: [], list: [] };
  return { calls, client: {
    createProject: async (b) => { calls.create.push(b); return over.create ? over.create(b) : { id: 'P' + b.videoUrl.slice(-11), stage: 'QUEUED' }; },
    getProject: async (id) => { calls.get.push(id); return over.get ? over.get(id) : { id, stage: 'COMPLETE' }; },
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
  const { client } = fakeClient({ list: () => [...clips(1, false), ...clips(3)] });
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

test('COMPLETE project with no exportable clips → failed', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: { AAAAAAAAAAA: submitted('AAAAAAAAAAA', 'P1') } };
  const { client } = fakeClient({ list: () => clips(2, false) });
  await runPass(base({ config: cfg(), state, client, feed: null }));
  assert.equal(state.videos.AAAAAAAAAAA.status, 'failed');
  assert.match(state.videos.AAAAAAAAAAA.error, /no exportable clips/);
});

test('STALLED → failed; in-progress past maxProjectAgeHours → failed timeout; fresh in-progress stays', async () => {
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
  const { client } = fakeClient({ list: () => clips(1) });
  await runPass(base({ config: cfg(), state, client, feed: null, download: failingDownload }));
  assert.equal(state.videos.A.status, 'submitted');
  assert.equal(state.videos.O.status, 'failed');
  assert.equal(state.videos.O.error, 'expired');
});

test('feed error skips discovery but still checks in-flight projects', async () => {
  const state = { ...emptyState(), baselinedAt: 'x', videos: { A: submitted('A', 'PA') } };
  const { client, calls } = fakeClient({ list: () => clips(1) });
  const logs = [];
  await runPass(base({ config: cfg(), state, client, feed: async () => { throw new Error('rss down'); }, log: (m) => logs.push(m) }));
  assert.equal(calls.get.length, 1);
  assert.equal(state.videos.A.status, 'complete');
  assert.ok(logs.some((m) => /rss down/.test(m)));
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/run.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { videosByStatus, isCapActive } from './state.js';
import { buildProjectBody } from './opusclip.js';
import { slugify } from './download.js';
import { watchUrl } from './youtube.js';

const PROJECT_TTL_DAYS = 30;
const byPublished = (a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0);
const matchesSkip = (title, patterns) => patterns.some((p) => title.toLowerCase().includes(p.toLowerCase()));
const hoursSince = (iso, now) => (now - new Date(iso)) / 3.6e6;
const fail = (v, error) => { v.status = 'failed'; v.error = error; };

export async function runPass({ config, state, client, feed, download, now = () => new Date(), log = () => {}, backfill = 0 }) {
  const summary = [];
  if (state.capReachedAt && !isCapActive(state, now())) state.capReachedAt = null;

  if (feed) {
    let entries = null;
    try { entries = await feed(); } catch (e) { log(`feed error, skipping discovery: ${e.message}`); }
    if (entries) discover({ state, entries, config, now: now(), backfill, summary });
  }
  await submitPending({ state, config, client, now: now(), summary, log });
  await checkSubmitted({ state, config, client, download, now: now(), summary, log });
  return summary;
}

function discover({ state, entries, config, now, backfill, summary }) {
  const first = !state.baselinedAt;
  const sorted = [...entries].sort(byPublished);
  const backfillIds = new Set(first && backfill > 0 ? sorted.slice(-backfill).map((e) => e.videoId) : []);
  for (const e of sorted) {
    if (state.videos[e.videoId]) continue;
    const v = { title: e.title, publishedAt: e.publishedAt, status: 'pending', discoveredAt: now.toISOString() };
    if (first && !backfillIds.has(e.videoId)) { v.status = 'skipped'; v.error = 'baseline'; }
    else if (matchesSkip(e.title, config.skipTitlePatterns)) { v.status = 'skipped'; v.error = 'title pattern'; }
    state.videos[e.videoId] = v;
    summary.push({ videoId: e.videoId, status: v.status });
  }
  if (first) state.baselinedAt = now.toISOString();
}

async function submitPending({ state, config, client, now, summary, log }) {
  if (isCapActive(state, now)) { log('monthly API cap reached; not submitting until next month'); return; }
  let inFlight = videosByStatus(state, 'submitted').length;
  const pending = videosByStatus(state, 'pending').sort(([, a], [, b]) => byPublished(a, b));
  for (const [id, v] of pending) {
    if (inFlight >= config.maxInFlight) { log(`in-flight limit ${config.maxInFlight} reached; ${id} waits`); break; }
    try {
      const project = await client.createProject(buildProjectBody(config, { videoId: id, title: v.title }));
      v.status = 'submitted';
      v.projectId = project.id;
      v.submittedAt = now.toISOString();
      inFlight++;
      summary.push({ videoId: id, status: 'submitted', projectId: project.id });
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') throw e;
      if (e.code === 'CONCURRENT') { log(`Opus Clip concurrency cap hit; ${id} waits`); break; }
      if (e.code === 'MONTHLY_CAP') { state.capReachedAt = now.toISOString(); log('monthly API cap reached; stopping submits'); break; }
      if (e.code === 'RATE_LIMIT') { log(`rate limited; ${id} waits`); break; }
      if (e.code === 'CLIENT_ERROR') { fail(v, e.message); summary.push({ videoId: id, status: 'failed', error: e.message }); continue; }
      log(`submit ${id} failed transiently, will retry: ${e.message}`);
    }
  }
}

async function checkSubmitted({ state, config, client, download, now, summary, log }) {
  for (const [id, v] of videosByStatus(state, 'submitted')) {
    let project;
    try {
      project = await client.getProject(v.projectId);
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') throw e;
      if (e.status === 404) { fail(v, 'expired'); summary.push({ videoId: id, status: 'failed', error: 'expired' }); continue; }
      log(`check ${id} failed, will retry: ${e.message}`);
      continue;
    }
    if (project.stage === 'COMPLETE') { await collect({ state, id, v, config, client, download, now, summary, log }); continue; }
    if (project.stage === 'STALLED' || project.error) {
      const reason = project.error ? `project error: ${typeof project.error === 'string' ? project.error : JSON.stringify(project.error)}` : 'stalled';
      fail(v, reason);
      summary.push({ videoId: id, status: 'failed', error: reason });
      continue;
    }
    if (hoursSince(v.submittedAt, now) > config.maxProjectAgeHours) {
      fail(v, 'timeout');
      summary.push({ videoId: id, status: 'failed', error: 'timeout' });
      continue;
    }
    log(`${id} still ${project.stage}`);
  }
}

async function collect({ id, v, config, client, download, now, summary, log }) {
  let clips;
  try {
    clips = await client.listClips(v.projectId);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED') throw e;
    log(`list clips ${id} failed, will retry: ${e.message}`);
    return;
  }
  const chosen = clips.filter((c) => c && c.uriForExport).slice(0, config.clipCount);
  if (chosen.length === 0) { fail(v, 'no exportable clips'); summary.push({ videoId: id, status: 'failed', error: v.error }); return; }
  const dir = path.join(config.outputDir, id);
  const results = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${slugify(c.title || 'clip')}.mp4`);
    if (!fs.existsSync(file)) {
      try {
        await download(c.uriForExport, file);
      } catch (e) {
        log(`download ${id} clip ${i + 1} failed: ${e.message}`);
        if (hoursSince(v.submittedAt, now) > PROJECT_TTL_DAYS * 24) { fail(v, 'expired'); summary.push({ videoId: id, status: 'failed', error: 'expired' }); }
        return;
      }
    }
    results.push({ id: c.id, title: c.title, durationMs: c.durationMs, file: path.relative(config.outputDir, file) });
  }
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { videoId: id, title: v.title, sourceUrl: watchUrl(id), projectId: v.projectId, completedAt: now.toISOString(), clips: results };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  v.status = 'complete';
  v.completedAt = now.toISOString();
  v.clips = results;
  summary.push({ videoId: id, status: 'complete', clips: results.length });
}
```

- [ ] **Step 4: Run** `node --test` → all PASS. **Step 5: Commit** `feat: add the run pass (discover, submit, check, collect)`

---

### Task 7: CLI

**Files:** Create `bin/autoclip.js` (executable); Test `test/cli.test.js` (smoke: `--help`, `status` on empty state, config error exit code).

**Interfaces:** Consumes everything above. Commands:
- `autoclip run [--config path] [--backfill N] [--watch MINUTES]`
- `autoclip submit <url|id> [--config path]`
- `autoclip resolve <@handle|url|UC…>`
- `autoclip status [--config path]`

- [ ] **Step 1: Write the failing test** `test/cli.test.js`

```js
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
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `bin/autoclip.js`

```js
#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadEnv, ConfigError } from '../src/config.js';
import { loadState, saveState } from '../src/state.js';
import { createClient, OpusClipError } from '../src/opusclip.js';
import { fetchFeed, resolveChannelId, extractVideoId, fetchVideoTitle } from '../src/youtube.js';
import { downloadFile } from '../src/download.js';
import { runPass } from '../src/run.js';

const USAGE = `youtube-autoclip — clip new YouTube uploads with Opus Clip

Usage:
  autoclip run [--config config.json] [--backfill N] [--watch MINUTES]
      One pass: discover new uploads, submit to Opus Clip, download finished clips.
      --backfill N   on the very first run, clip the N most recent uploads instead of baselining
      --watch M      keep running, one pass every M minutes
  autoclip submit <youtube-url|video-id> [--config config.json]
      Submit one video by hand (bypasses the channel feed; same state tracking).
  autoclip resolve <@handle|channel-url|UC...>
      Print the channel id to paste into config.json.
  autoclip status [--config config.json]
      Show every tracked video and its state.

Secrets: OPUSCLIP_API_KEY (required for run/submit), OPUSCLIP_ORG_ID (optional), via env or a .env file next to config.json.
`;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printSummary(summary) {
  if (summary.length === 0) { log('nothing to do'); return; }
  for (const s of summary) {
    const extra = s.projectId ? ` project=${s.projectId}` : s.clips !== undefined ? ` clips=${s.clips}` : s.error ? ` (${s.error})` : '';
    log(`${s.videoId}: ${s.status}${extra}`);
  }
}

function makeClient(cfg) {
  const env = loadEnv(path.dirname(cfg.stateFile));
  return createClient({ apiKey: env.apiKey, orgId: env.orgId });
}

async function passAndSave(cfg, client, { feed, backfill = 0 }) {
  const state = loadState(cfg.stateFile);
  try {
    const summary = await runPass({ config: cfg, state, client, feed, download: downloadFile, log, backfill });
    printSummary(summary);
  } finally {
    saveState(cfg.stateFile, state);
  }
}

async function cmdRun(cfg, values) {
  const client = makeClient(cfg);
  const backfill = values.backfill ? Number.parseInt(values.backfill, 10) : 0;
  if (Number.isNaN(backfill) || backfill < 0) throw new ConfigError('--backfill must be a non-negative integer');
  const feed = () => fetchFeed(cfg.channelId);
  if (!values.watch) { await passAndSave(cfg, client, { feed, backfill }); return; }
  const minutes = Number.parseFloat(values.watch);
  if (!(minutes > 0)) throw new ConfigError('--watch must be a number of minutes > 0');
  let first = true;
  for (;;) {
    try {
      await passAndSave(cfg, client, { feed, backfill: first ? backfill : 0 });
    } catch (e) {
      if (e instanceof OpusClipError && e.code === 'UNAUTHORIZED') throw e;
      log(`pass failed: ${e.message}`);
    }
    first = false;
    log(`sleeping ${minutes} min`);
    await sleep(minutes * 60_000);
  }
}

async function cmdSubmit(cfg, target) {
  if (!target) throw new ConfigError('submit needs a YouTube url or video id');
  const videoId = extractVideoId(target);
  if (!videoId) throw new ConfigError(`could not find a video id in: ${target}`);
  const client = makeClient(cfg);
  const state = loadState(cfg.stateFile);
  const existing = state.videos[videoId];
  if (existing && existing.status !== 'failed' && existing.status !== 'skipped') { log(`${videoId} already ${existing.status}`); return; }
  const title = (await fetchVideoTitle(videoId)) ?? videoId;
  state.videos[videoId] = { title, publishedAt: new Date().toISOString(), status: 'pending', discoveredAt: new Date().toISOString(), manual: true };
  saveState(cfg.stateFile, state);
  await passAndSave(cfg, client, { feed: null });
}

async function cmdResolve(target) {
  if (!target) throw new ConfigError('resolve needs a handle, channel url, or UC id');
  console.log(await resolveChannelId(target));
}

function cmdStatus(cfg) {
  const state = loadState(cfg.stateFile);
  const rows = Object.entries(state.videos).sort(([, a], [, b]) => (a.publishedAt < b.publishedAt ? 1 : -1));
  if (rows.length === 0) { console.log('no videos tracked yet'); return; }
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log(`${pad('video', 12)}${pad('status', 10)}${pad('project', 16)}${pad('clips', 6)}title / note`);
  for (const [id, v] of rows) {
    const note = v.status === 'complete' ? v.title : v.error ? `${v.title} — ${v.error}` : v.title;
    console.log(`${pad(id, 12)}${pad(v.status, 10)}${pad(v.projectId, 16)}${pad(v.clips ? v.clips.length : '', 6)}${note}`);
  }
  if (state.capReachedAt) console.log(`\nmonthly API cap reached at ${state.capReachedAt}; submits resume next month`);
  console.log(`\nbaselined: ${state.baselinedAt ?? 'not yet (first run will baseline)'}  state: ${cfg.stateFile}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config.json' },
      watch: { type: 'string' },
      backfill: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, target] = positionals;
  if (values.help || !cmd) { process.stdout.write(USAGE); process.exit(cmd ? 0 : 1); }
  if (cmd === 'resolve') return cmdResolve(target);
  const cfg = loadConfig(values.config);
  if (cmd === 'run') return cmdRun(cfg, values);
  if (cmd === 'submit') return cmdSubmit(cfg, target);
  if (cmd === 'status') return cmdStatus(cfg);
  throw new ConfigError(`unknown command: ${cmd}\n\n${USAGE}`);
}

main().catch((e) => {
  const prefix = e instanceof ConfigError ? 'config error' : e instanceof OpusClipError ? `opus clip error (${e.code})` : 'error';
  console.error(`${prefix}: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4:** `chmod +x bin/autoclip.js`; run `node --test` → PASS. **Step 5: Commit** `feat: add autoclip CLI`

---

### Task 8: README and scheduling docs

**Files:** Create `README.md`

- [ ] **Step 1: Write README** covering: what it does, requirements (Node ≥ 20, Opus Clip Pro/Max/Business API key), setup (copy config.example.json → config.json, `autoclip resolve @handle`, `.env`), commands, scheduling snippets (cron every 10 min, launchd plist, Windows Task Scheduler one-liner, `--watch 10`, GitHub Actions note about persisting state.json), the live verification checklist from the spec (submit one video; confirm `enableCaption` accepted; confirm clip order is ranked), limits (900 credits/mo, 10-credit min, 4 in flight, 30-day expiry), and where output lands.
- [ ] **Step 2: Commit** `docs: add README with setup and scheduling`

---

### Task 9: Final verification

- [ ] `node --test` → all pass, 0 failures.
- [ ] `node bin/autoclip.js --help` prints usage.
- [ ] `node bin/autoclip.js resolve @youtube` returns a `UC…` id (live network sanity check of the resolver; skip if offline).
- [ ] `git status` clean.

## Self-review (done while writing)

- Spec coverage: baseline/backfill (T6), discover + skip patterns (T6), submit gating on in-flight/concurrent/cap/4xx/5xx (T4+T6), check stages + timeout (T6), collect top-N/skip-no-URL/manifest/expired (T5+T6), atomic state (T2), commands run/watch/submit/resolve/status (T7), config + env (T1), README + live checklist (T8). Webhooks and social posting: out of scope per spec.
- Type consistency: `runPass` signature identical in T6 impl, T6 tests, and T7 CLI; `OpusClipError.code` values identical across T4 and T6; video record fields identical across T2 doc, T6, T7.
