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
