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
    if (project.stage === 'COMPLETE') { await collect({ id, v, config, client, download, now, summary, log }); continue; }
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
