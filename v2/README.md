# AGP Scanner v2 (lite)

A separate Worker (`agp-scanner-v2`). It does not replace or modify v1 (`index.js` + `wrangler.toml` in the repo root).

## What changed vs v1
| | v1 | v2 |
|---|---|---|
| Browser Rendering | every run | none |
| Workers AI | every run (result unused) | none |
| Runs | rebuilds every 12h | rebuilds only if the gstatic CSS hash changed |
| Safety | overwrites prod CSS blindly | validates size/type first, keeps `css/gstatic-cache.prev.css` backup |
| Trigger key | hardcoded in source | `AGP_KEY` secret |
| Default | always writes | dry run until `MODE=apply` |

v2 writes the same things the live Worker already reads: R2 `css/gstatic-cache.css`, KV `GSTATIC_CSS=ready`, and seeds `LCP_IMAGE_URL` / `GHOST_CSS` only if missing. It also writes a versioned copy `css/gstatic-<hash>.css` and KV `GSTATIC_CSS_PATH` (not used by the live Worker yet).

It does not touch `CRITICAL_CSS`. The live Worker never injects it today (undefined `fetchedCritical`), so v1 was computing it for nothing.

## Try it (nothing in prod changes)
```
npx wrangler deploy --config v2/wrangler.toml
npx wrangler secret put AGP_KEY --config v2/wrangler.toml
```
Then open `https://agp-scanner-v2.<your-subdomain>.workers.dev/?key=<AGP_KEY>`. It reports `unchanged` or `would-update` and writes nothing. `/status` shows the last real run.

## Switch over
1. Run `?key=...&apply=1` once and check the site's PageSpeed score.
2. Set `MODE = "apply"` and uncomment `crons` in `v2/wrangler.toml`, then redeploy.
3. Remove the cron from v1 so only one scanner runs.

## Revert
- Bad CSS: `https://agp-scanner-v2.<subdomain>.workers.dev/rollback?key=...` restores the previous CSS.
- Whole thing: re-add the cron to v1 (it is unchanged on `main`) and delete or disable v2.

## Tests
`node v2/test.mjs` (mocks fetch, KV and R2).

## Known limitation
The live Worker serves everything under `/assets/` with `Cache-Control: immutable` for one year, so a refreshed `gstatic-cache.css` can be served stale. Fixing that means a small change to the live Worker (point the stylesheet swap at `GSTATIC_CSS_PATH`). Not done here on purpose.
