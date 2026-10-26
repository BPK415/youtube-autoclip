# youtube-autoclip — notes for Claude Code

This repo is a small, dependency-free Node 20 CLI. Read `README.md` first; it is the source
of truth for setup and commands. Design and plan are under `docs/superpowers/`.

## What it does
Watches one YouTube channel (RSS, no YouTube API key), sends new uploads to Opus Clip's REST
API, downloads the top 10 clips by virality score, and optionally auto-posts clips scoring
`post.minScore`+ (default 80) to the YouTube channel connected in the user's Opus Clip account.

## Operating it
- One pass: `node bin/autoclip.js run`. Everything is idempotent; re-running is always safe.
- `node bin/autoclip.js status` shows every tracked video; `accounts` shows connected social
  accounts and whether posting is on; `submit <url>` clips one video by hand; `resolve @handle`
  finds a channel id.
- Secrets live only in `.env` (`OPUSCLIP_API_KEY`, optional `OPUSCLIP_ORG_ID`). Never print
  them, never commit them, never put them in `config.json`.
- `state.json` is the memory. Deleting it makes the next run re-baseline the channel and forget
  what was posted, so do not delete it to "fix" something; edit the specific video entry instead
  (set its `status` back to `pending` to resubmit, or remove a key from `posts` to re-post).

## Guardrails
- Do not set `post.enabled` to true, or change `post.privacy` to `public`, without the user
  saying so in this conversation. Posting publishes to a real channel.
- Do not loop `submit` over many videos: each one spends Opus Clip credits (about 1 per source
  minute, 10 minimum; 900 per month on Pro/Max).
- Before any change to `src/`, run `npm test` (offline, mocked fetch) and keep it green.

## Troubleshooting map
| Symptom | Where to look |
|---|---|
| `opus clip error (UNAUTHORIZED)` | key missing/wrong, or org not on a plan with API access |
| `monthly API cap reached` in logs / status | Opus Clip's 900-credit month cap; resumes next UTC month |
| video stuck `submitted` | Opus Clip still processing; `status` after a few passes. Fails as `timeout` after `maxProjectAgeHours` |
| `no exportable clips` | project finished with nothing renderable; check it in the Opus Clip web app |
| `no connected YOUTUBE account` | connect the channel in Opus Clip → Social accounts, then `accounts` |
| posts pending (`*` in status) | a post request failed; retried every pass, see the run log line |
| `score: null` in a manifest | API stopped returning scores; posting cannot trigger (see README checklist) |

## Code map
`src/config.js` config + env · `src/state.js` atomic state file · `src/youtube.js` RSS + channel
resolution · `src/opusclip.js` API client (typed errors, backoff) · `src/download.js` ·
`src/run.js` the pass (discover → submit → check → collect → post) · `bin/autoclip.js` CLI.
Tests: `test/*.test.js`, `node --test`.
