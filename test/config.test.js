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

test('post block defaults to disabled YouTube at minScore 80 and merges overrides', () => {
  const c = validateConfig(GOOD, '/base');
  assert.deepEqual(c.post, { enabled: false, minScore: 80, platforms: ['YOUTUBE'], privacy: 'public', mediaType: null });
  const o = validateConfig({ ...GOOD, post: { enabled: true, minScore: 85 } }, '/base');
  assert.equal(o.post.enabled, true);
  assert.equal(o.post.minScore, 85);
  assert.deepEqual(o.post.platforms, ['YOUTUBE']);
});

test('post block rejects bad values', () => {
  assert.throws(() => validateConfig({ ...GOOD, post: { minScore: 120 } }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, post: { platforms: [] } }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, post: { platforms: ['MYSPACE'] } }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, post: { privacy: 'secret' } }), ConfigError);
  assert.throws(() => validateConfig({ ...GOOD, post: { enabled: 'yes' } }), ConfigError);
});
