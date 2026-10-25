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
