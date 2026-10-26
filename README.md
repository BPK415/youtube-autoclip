# youtube-autoclip

Watches one YouTube channel. Every new public upload is sent to [Opus Clip](https://www.opus.pro),
cut into short clips, and the **top 10 clips are downloaded** to a folder with a manifest.
Optionally, every clip Opus Clip scores **80 or higher** is **posted automatically** as a
YouTube Short to the channel connected in your Opus Clip account.

Zero npm dependencies. Runs anywhere Node 20+ runs: a Mac, a Linux box, a Windows machine,
or a scheduled job. One short pass per run; state lives in a single JSON file.

## Requirements

- Node **20 or newer** (`node --version`)
- An Opus Clip account on a plan with API access (**Pro, Max, or Business**) and an API key
  from the Opus Clip dashboard under *API Access → Create key*. The free plan is refused.

## Setup

```bash
git clone <this repo> youtube-autoclip
cd youtube-autoclip
cp config.example.json config.json
cp .env.example .env            # put your real key in .env
node bin/autoclip.js resolve @yourhandle   # prints UC... — paste into config.json "channelId"
```

`config.json` fields (defaults shown in `config.example.json`):

| field | meaning |
|---|---|
| `channelId` | the `UC…` id of the channel to watch (use `resolve` to find it) |
| `clipCount` | how many clips to keep per video (first N in Opus Clip's returned order) |
| `clipDurations` | `[[minSec, maxSec], …]` buckets passed to Opus Clip |
| `aspectRatio` | `portrait`, `square`, `landscape`, or `four_five` |
| `enableCaption`, `enableAutoHook` | captions on the clips; AI hook at the start of each clip |
| `model` | `ClipBasic` or `ClipAnything` |
| `brandTemplateId` | an Opus Clip brand template id, or `null` for the account default |
| `skipTitlePatterns` | case-insensitive substrings; matching uploads are ignored (default `#shorts`) |
| `maxInFlight` | projects processing at once (Opus Clip allows 4 on Pro/Max) |
| `maxProjectAgeHours` | give up on a project still processing after this long |
| `outputDir`, `stateFile` | where clips and the state file go (relative to `config.json`) |
| `post.enabled` | `true` to auto-post; default `false` so nothing publishes until you say so |
| `post.minScore` | Opus Clip virality score threshold, 0–99; clips at or above it are posted (default 80) |
| `post.platforms` | which connected Opus Clip accounts to post to; default `["YOUTUBE"]` |
| `post.privacy` | `public`, `unlisted`, or `private` (YouTube privacy; default `public`) |
| `post.mediaType` | platform media type override, normally leave `null` |

Secrets are read from the environment first, then from `.env` next to `config.json`:
`OPUSCLIP_API_KEY` (required), `OPUSCLIP_ORG_ID` (only if your login has several orgs).

## Commands

```bash
node bin/autoclip.js run                 # one pass
node bin/autoclip.js run --backfill 3    # first run only: also clip the 3 most recent uploads
node bin/autoclip.js run --watch 10      # keep running, one pass every 10 minutes
node bin/autoclip.js submit <youtube-url>   # clip one video by hand (good for testing)
node bin/autoclip.js status              # table of tracked videos (and posts)
node bin/autoclip.js accounts            # social accounts connected in Opus Clip, and whether posting is on
node bin/autoclip.js resolve @handle     # channel handle/url -> UC... id
```

### What a pass does

1. **First run only:** records the uploads already on the channel as a baseline and clips
   nothing, so only videos posted *after* setup get clipped. `--backfill N` overrides this.
2. Reads the channel's public RSS feed and queues any upload it hasn't seen.
3. Submits queued uploads to Opus Clip, oldest first, up to `maxInFlight` at once.
4. Checks every in-flight project. When one is `COMPLETE`, lists its clips, keeps the first
   `clipCount` that have an export URL, downloads them to
   `clips/<videoId>/01-<title>.mp4 …` and writes `clips/<videoId>/manifest.json`.
5. If `post.enabled` is true, every clip in that project scoring `post.minScore` or higher is
   posted to each connected account whose platform is in `post.platforms`, using the clip's
   own title, description, and hashtags. Each post is recorded in `state.json` with its post
   id, so a clip is never posted twice; a post that fails is retried on the next pass.
6. Saves `state.json` atomically. Every step is safe to re-run.

Processing takes Opus Clip a few minutes to an hour, so a video usually completes a few
passes after it was submitted.

## Auto-posting to YouTube Shorts

1. In the Opus Clip web app, connect the YouTube channel under *Social accounts*.
2. Run `node bin/autoclip.js accounts` and confirm a `YOUTUBE` row appears.
3. In `config.json` set `"post": { "enabled": true, "minScore": 80, "platforms": ["YOUTUBE"], "privacy": "unlisted" }`
   for the first video, check the result on YouTube, then switch `privacy` to `public`.
4. Clips are rendered portrait and 30–60 s by default, which YouTube classifies as Shorts on
   its own; no special flag is needed. If a post lands as a regular video, set
   `post.mediaType` to `"short"` and try again.

Notes: Opus Clip marks its posting API as beta and says per-post pricing may change. Posting
to X costs credits per post. The score is Opus Clip's 0–99 virality score, the same number
shown next to each clip in their web app. The gate is independent of `clipCount`: if 12 clips
score 80+, all 12 are posted even though only 10 are downloaded.

## Running it on another machine or account

Nothing here is tied to a person. To hand it to someone else:

1. Give them access to this repo (GitHub → Settings → Collaborators) and have them clone it.
2. They create their **own** Opus Clip API key (Pro/Max/Business) and put it in their `.env`.
3. They connect their YouTube channel inside **their** Opus Clip account, since posting goes
   through whichever Opus Clip org the API key belongs to.
4. They set `channelId` to the channel to watch and `post.enabled` as they like.
5. `state.json` and `clips/` are per machine and git-ignored; the first run baselines fresh.

If they use Claude Code, `CLAUDE.md` in this repo tells Claude how to operate and troubleshoot
the tool.

## Scheduling

Pick one. All of them just run `autoclip run` on a timer.

**cron (Linux/macOS)** — every 10 minutes:
```
*/10 * * * * cd /path/to/youtube-autoclip && /usr/local/bin/node bin/autoclip.js run >> autoclip.log 2>&1
```

**launchd (macOS)** — save as `~/Library/LaunchAgents/com.autoclip.run.plist`, then
`launchctl load ~/Library/LaunchAgents/com.autoclip.run.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.autoclip.run</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string><string>bin/autoclip.js</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/youtube-autoclip</string>
  <key>StartInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>/path/to/youtube-autoclip/autoclip.log</string>
  <key>StandardErrorPath</key><string>/path/to/youtube-autoclip/autoclip.log</string>
</dict></plist>
```

**Windows Task Scheduler** — from an admin PowerShell:
```powershell
schtasks /Create /SC MINUTE /MO 10 /TN "autoclip" /TR "cmd /c cd /d C:\youtube-autoclip && node bin\autoclip.js run >> autoclip.log 2>&1"
```

**No scheduler** — leave a terminal open:
```bash
node bin/autoclip.js run --watch 10
```

**GitHub Actions** works too (schedule a workflow that runs `node bin/autoclip.js run` with
the key in a secret), but `state.json` must be committed back or restored from cache
between runs, and the clips need uploading as artifacts. A real machine is simpler.

## Limits to know (Opus Clip Pro/Max)

- 900 API credits per calendar month, roughly 1 credit per minute of source video, with a
  10-credit minimum per video. When the cap is hit the script stops submitting and resumes
  automatically the next month (`status` shows this).
- 4 projects processing at once. Extra uploads wait in `pending` until a slot frees.
- Projects expire after 30 days; clips not downloaded by then are marked `expired`.
- Only **public** uploads appear in the RSS feed. Shorts are skipped by title pattern since
  the feed carries no duration.

## First live run checklist

Do this once the API key works, before trusting the schedule:

1. `node bin/autoclip.js submit https://www.youtube.com/watch?v=<a real video on the channel>`
   and confirm it reports `submitted` with a project id. If Opus Clip rejects the request,
   the most likely culprit is `renderPref.quickstartConfig.enableCaption`, which is undocumented
   for the REST API: set `enableCaption` to match your brand template and remove it from
   `buildProjectBody` in `src/opusclip.js` if it keeps failing.
2. Run `node bin/autoclip.js run` every few minutes until `status` shows `complete`, then open
   `clips/<videoId>/manifest.json` and check each clip has a numeric `score`. Clips are
   sorted by that score, so the 10 files should match the top of Opus Clip's dashboard.
   If `score` is `null`, the API stopped returning it and `collect` in `src/run.js` falls back
   to list order; posting would then never trigger.
3. Confirm a fresh upload shows up in the feed within a few minutes of going public.
4. If posting is on: confirm the first post appears on the channel with the expected title,
   description, and privacy.

## Development

```bash
npm test            # node --test, no network
```
Layout: `src/config.js` (config + env), `src/state.js` (atomic state file), `src/youtube.js`
(RSS + channel resolution), `src/opusclip.js` (API client), `src/download.js`, `src/run.js`
(the pass), `bin/autoclip.js` (CLI). Design and plan live under `docs/superpowers/`.
