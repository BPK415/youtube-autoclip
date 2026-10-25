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
