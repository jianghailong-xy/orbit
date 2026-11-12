# Capture kit for these boards

- `capture.mjs` + `scenes.mjs` + `data.mjs`: the real web console (vite) against the repo's
  `src/web/ui-migration/fixtures.mjs`, with a CBAI-shaped project laid over `/api/projects/:id` and
  `/integration`. Proposal rows are injected into the real page with the console's own classes.
  Scenes: `web1` (How it runs, header), `web3b` (acceptance card with confirmer rows, mode menu).
- `run-ns.sh`: starts vite on :5941 and runs a scene inside `unshare -n` (no network churn).
  `unshare -n ./run-ns.sh capture.mjs web1`. Needs `bash scripts/worktree-overlay.sh` first.
- `render.mjs <abs board.html> <out.png>`: shoots `.board` at 2x. Fonts come from
  `/mnt/data/tmp/pdf-mock/fonts` (Inter, Noto Sans SC, JetBrains Mono); on a Mac -apple-system wins.
- iOS frames are hand-drawn HTML (no SwiftUI on Linux).
