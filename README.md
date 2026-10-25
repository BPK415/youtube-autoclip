# youtube-autoclip

Watches one YouTube channel. Every new public upload is sent to [Opus Clip](https://www.opus.pro),
cut into short clips, and the **top 10 clips are downloaded** to a folder with a manifest.

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

Secrets are read from the environment first, then from `.env` next to `config.json`:
`OPUSCLIP_API_KEY` (required), `OPUSCLIP_ORG_ID` (only if your login has several orgs).

## Commands

```bash
node bin/autoclip.js run                 # one pass
node bin/autoclip.js run --backfill 3    # first run only: also clip the 3 most recent uploads
node bin/autoclip.js run --watch 10      # keep running, one pass every 10 minutes
node bin/autoclip.js submit <youtube-url>   # clip one video by hand (good for testing)
node bin/autoclip.js status              # table of tracked videos
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
5. Saves `state.json` atomically. Every step is safe to re-run.

Processing takes Opus Clip a few minutes to an hour, so a video usually completes a few
passes after it was submitted.

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
   `clips/<videoId>/` and check the 10 files are the ones Opus Clip ranks highest in its
   dashboard. If the order differs, the dashboard's ranking is not the API's list order and
   the selection in `src/run.js` (`collect`) needs a sort.
3. Confirm a fresh upload shows up in the feed within a few minutes of going public.

## Development

```bash
npm test            # node --test, no network
```
Layout: `src/config.js` (config + env), `src/state.js` (atomic state file), `src/youtube.js`
(RSS + channel resolution), `src/opusclip.js` (API client), `src/download.js`, `src/run.js`
(the pass), `bin/autoclip.js` (CLI). Design and plan live under `docs/superpowers/`.
