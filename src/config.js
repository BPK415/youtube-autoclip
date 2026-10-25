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
  const get = (k) => env[k] || fromFile[k] || null;
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
