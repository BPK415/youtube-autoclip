# youtube-autoclip — design

Date: 2026-10-25

## Goal

A portable, zero-dependency Node 20 script that watches one YouTube channel and,
for every new public upload, has Opus Clip cut it into short clips, then downloads
the top 10 clips to a local folder. It must run unattended on any machine
(cron, launchd, Task Scheduler, or a `--watch` loop) with nothing but Node and an
Opus Clip API key.

Out of scope for v1: posting clips to social accounts, webhooks, multiple
channels, brand-template management, and anything needing a public URL.

## External facts the design relies on

- Opus Clip REST API, base `https://api.opus.pro`, auth `Authorization: Bearer <OPUSCLIP_API_KEY>`,
  optional `x-opus-org-id` header. Requires Pro, Max, or Business plan.
  - `POST /api/clip-projects` → 201 `ClipProjectRepresentation` (`id`, `stage`).
  - `GET /api/clip-projects/{id}` → same; `stage` ∈ PENDING, QUEUED, IMPORT, CURATE, REFINE, RENDER, UPLOAD, COMPLETE, STALLED.
  - `GET /api/exportable-clips?q=findByProjectId&projectId=…` → array of clips with `id`, `title`, `durationMs`, `uriForExport`, `uriForPreview`. No score or rank field.
- Limits (Pro/Max): 30 req/min per key (429), 4 projects in flight (429 + `X-Cap-Reason: concurrent`),
  900 credits/month (403 `API_MONTHLY_CAP_REACHED`), 10-credit minimum per project, projects expire after 30 days.
- YouTube channel RSS: `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`
  lists the 15 most recent public uploads with `yt:videoId`, `title`, `published`. No auth. No duration.

## Behavior

Each invocation of `autoclip run` is one short, idempotent pass:

1. Load `state.json` (create if missing).
2. **Baseline on first run.** If state has no `baselinedAt`, record every video
   currently in the RSS feed as `skipped` and set `baselinedAt`. Only uploads that
   appear after setup get clipped, matching "videos that get posted". `--backfill N`
   overrides this and submits the N most recent instead.
3. **Discover.** Fetch the RSS feed. Any `videoId` not in state becomes `pending`.
   Titles matching any `skipTitlePatterns` entry (default `#shorts`, case-insensitive)
   become `skipped`.
4. **Submit.** For each `pending` video, oldest first, while in-flight count
   (`submitted` entries) is below `maxInFlight` (default 4): `POST /api/clip-projects`
   with the config's curation and render preferences. On 201 → `submitted`, store
   `projectId`. On 429 concurrent → stop submitting this pass. On 403 monthly cap →
   set `capReachedAt`, stop submitting; cleared automatically on the first pass of
   the next UTC month. Other 4xx → `failed` with the error body. 5xx/network → stay
   `pending`, retry next pass.
5. **Check.** For each `submitted` video: `GET /api/clip-projects/{id}`.
   `COMPLETE` → go to step 6. `STALLED` or `error` set → `failed`.
   Anything else → leave it; if `submittedAt` is older than `maxProjectAgeHours`
   (default 24) → `failed` with reason `timeout`.
6. **Collect.** `GET /api/exportable-clips` for the project. Take the first
   `clipCount` (default 10) in the order returned, which is assumed to be Opus
   Clip's ranked order. Skip clips with no `uriForExport`. Download each to
   `<outputDir>/<videoId>/NN-<slug>.mp4` (streamed, written to a `.part` file then
   renamed). Write `<outputDir>/<videoId>/manifest.json` with the source video,
   project id, and per-clip id, title, duration, and file. Any download error →
   leave the video `submitted` and retry next pass; after 30 days the project is
   gone, so mark `failed` with reason `expired`.
   Only after all N files exist → `complete`.
7. Save state atomically (write temp, rename). Print a one-line summary per video
   touched, exit 0. Exit 1 only on config or auth errors.

`autoclip run --watch <minutes>` repeats the pass on that interval for machines
without a scheduler.

### Other commands

- `autoclip resolve <@handle|channel URL>` → prints the `UC…` channel id
  (fetches the channel page and reads `"externalId"`), so the user can paste it
  into config.
- `autoclip submit <youtube-url>` → submit one video by hand, bypassing the feed.
  Same state tracking; useful for testing with the API live.
- `autoclip status` → table of videos in state with status, project id, clips downloaded.

## Configuration

`config.json` next to the script (path overridable with `--config`):

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

Secrets only via environment: `OPUSCLIP_API_KEY` (required), `OPUSCLIP_ORG_ID`
(optional). A `.env` file is read if present; never committed.

Request body built from config:

```json
{
  "videoUrl": "https://www.youtube.com/watch?v=<id>",
  "brandTemplateId": "<if set>",
  "uploadedVideoAttr": { "title": "<video title>" },
  "curationPref": { "model": "ClipBasic", "clipDurations": [[30,60]], "enableAutoHook": true },
  "renderPref": { "layoutAspectRatio": "portrait", "quickstartConfig": { "enableCaption": true } }
}
```

The exact key for captions in `renderPref` is not documented for the REST API
(the MCP exposes `enableCaption`); it is passed as shown and must be verified on
the first live run. If rejected, captions fall back to the brand template default.

## Structure

```
youtube-autoclip/
  bin/autoclip.js        CLI entry: parses argv, loads config + env, dispatches
  src/config.js          load + validate config, read .env
  src/state.js           load/save state.json atomically; status transitions
  src/youtube.js         fetchFeed(channelId) → [{videoId,title,publishedAt}]; resolveChannelId(input)
  src/opusclip.js        createProject, getProject, listClips; typed errors for 429/403; backoff
  src/download.js        downloadFile(url, dest) streamed with .part rename
  src/run.js             the pass described above, composed from the modules
  test/*.test.js         node:test, fetch mocked; no network
  config.example.json
  .env.example
  README.md              setup, scheduling snippets (cron, launchd, Task Scheduler, GitHub Actions note)
```

No npm dependencies. Node ≥ 20 for global `fetch` and `node:test`.

## State file

```json
{
  "baselinedAt": "2026-10-25T18:00:00Z",
  "capReachedAt": null,
  "videos": {
    "<videoId>": {
      "title": "…", "publishedAt": "…",
      "status": "pending|submitted|complete|failed|skipped",
      "projectId": "…", "submittedAt": "…", "completedAt": "…",
      "error": "…",
      "clips": [{ "id": "…", "title": "…", "durationMs": 0, "file": "…" }]
    }
  }
}
```

## Error handling summary

| Condition | Action |
|---|---|
| RSS fetch fails | log, skip discover, still check in-flight projects |
| 429 rate limit (30/min) | exponential backoff, max 3 tries, then abort pass |
| 429 concurrent | stop submitting this pass |
| 403 monthly cap | set `capReachedAt`, stop submitting until next UTC month |
| 401 | exit 1 with a clear message |
| project STALLED / error | mark `failed`, keep going |
| download fails | retry next pass; `expired` after 30 days |
| state write fails | exit 1, nothing partially written (temp + rename) |

## Testing

- `node --test`: feed parsing (fixture XML), baseline vs backfill, submit gating
  on in-flight count and cap errors, stage transitions, top-N selection and
  skip-no-URL, manifest shape, state atomicity, config validation.
- fetch is injected into every module so tests never touch the network.
- Live verification checklist in README for once the API is enabled: `autoclip submit`
  on one known video, confirm `enableCaption` accepted, confirm clip order is ranked.

## Open assumptions to verify live

1. `exportable-clips` order is the ranked order.
2. `renderPref.quickstartConfig.enableCaption` is the accepted key.
3. RSS feed shows a new upload within minutes (it usually does; YouTube may lag).
