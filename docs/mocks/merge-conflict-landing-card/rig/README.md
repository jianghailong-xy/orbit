# Rig for the merge-conflict landing card boards

The frames under `../shots/` were taken with this rig: the real web console (vite) against a fake
control plane (`server.mjs`) shaped on project 34ZZeq0e3IR65GVm2kAs7 at 2026-10-06 23:44Z, with
the proposal drawn into the live page by `frames/*.js` (helpers in `kit.js`). Once the cards are
implemented, the same scenarios render the real components, so evidence screenshots can be compared
frame for frame with the boards.

- `node server.mjs` serves :3997. Pick a scenario with `GET /api/__scenario?name=now|fixing|escalated|relanding|landed`.
  `now` makes today's code draw both exception cards (the delivery card and the escalated owner card).
- `WT=<checkout> vite --config vite.config.mjs` serves :5197. Fix the plugin import path to an install that has `@vitejs/plugin-react`.
- `READY='<js>' node shot.mjs '/sessions/<coordinator>?project=<project>' out.png 1440 900 frames/<frame>.js [mobile]`.
  Ids come from `GET /api/__ids`. Chrome is `~/.cache/ms-playwright/chromium-1243`; fonts come from `FONTCONFIG_FILE=/tmp/orbit-mock/fonts.conf`
  (Inter + Noto Sans SC). Without those fonts, CJK renders as tofu.
- `./run-all.sh [frame…]` renders everything, and the phone frames too. Never run two shots at once: the scenario is global to the server.
- `node render-board.mjs <board.html> <out.png>` renders a board at 2x.
