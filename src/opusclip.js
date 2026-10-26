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

  const unwrapList = (d) => {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data;
    if (d && Array.isArray(d.items)) return d.items;
    return [];
  };

  return {
    createProject: (body) => request('POST', '/api/clip-projects', body),
    getProject: (id) => request('GET', `/api/clip-projects/${encodeURIComponent(id)}`),
    listClips: async (projectId) => unwrapList(await request('GET', `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageSize=100`)),
    listSocialAccounts: async () => unwrapList(await request('GET', '/api/social-accounts?q=mine')),
    createPostTask: async (body) => {
      const d = await request('POST', '/api/post-tasks', body);
      return d && d.data ? d.data : d;
    },
  };
}
