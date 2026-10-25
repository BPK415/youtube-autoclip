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
