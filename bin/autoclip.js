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
    const note = v.error && v.status !== 'complete' ? `${v.title} — ${v.error}` : v.title;
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
  if (values.help) { process.stdout.write(USAGE); return; }
  if (!cmd) { process.stdout.write(USAGE); process.exit(1); }
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
