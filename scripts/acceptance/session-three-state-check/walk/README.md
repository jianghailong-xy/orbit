# Session three-state: real-stack walk of the web console

This walk checked the project tip 4f99cb45ff on 2026-11-24. It drives the real apiserver (`node build/main.js` on a throwaway postgres:16), serves the built console with `vite preview`, and signs in with Playwright through the real login form.

It reads each seeded session's six fields (`phase`, `released`, `lastTurnOutcome`, `waitingOn`, `endReason`, `workFinished`) from `GET /api/sessions` and `GET /api/sessions/:id`. It also reads the words the console shows, from the DOM: the list row line (`.session-preview`), the header word (`.workspace-sub`) and the row glyph's tooltip.

## Scripts

- `up.sh <tip> <walk> <pg port> <api port> <web port>`: starts the postgres container `p3walk-pg-<pg port>` on 127.0.0.1, writes `<walk>/env` (mode 600, fresh random secrets) and runs `prisma migrate deploy`.
- `api.sh <tip> <walk>`: starts `node build/main.js` and waits for `/api/health`. Rebuild with `npx tsc -p tsconfig.test.json` first if `src/` is newer than `build/main.js`.
- `seed.cjs <tip> <walk>`: creates the owner with the real `POST /api/auth/bootstrap`, checks that the real login works, then writes the runner, workspace and seven sessions with Prisma, shaped like `session-payloads.fixture.ts` `buildWorld`. The seven sessions are:
  - held idle
  - a job with no turn
  - waiting on an approval
  - on hold (paused account)
  - failed turn
  - released by End
  - task run finished, with a DONE task
- `seed-control.cjs <tip> <walk>`: adds the control session, a plain RUNNING turn.
- `beat.sh <container> <runner id>`: keeps the runner's `last_heartbeat_at` fresh. Without it, the runner goes offline after 90 s, and a queued row shows its runner gate instead of "On hold".
- `vite.preview.config.mjs`: `vite preview` of `<tip>/src/web/dist` with `/api` proxied to the walk's apiserver. Build the console first with `cd src/web && npx vite build`.
- `api-read.mjs <walk> <out.json>`: the six fields from the list (matched by title, since the API answers public ids) and from the detail.
- `walk.mjs <walk> <origin> <out>`: signs in, opens each session, reads the DOM until it holds still, and takes screenshots.
- `walk-ab.mjs <walk> <origin> <out>`: the same console with `activity` nulled on rows stored RUNNING. It rewrites the list and detail JSON in the browser and never the `/events` stream.
- `make-table.mjs <api.json> <dom.json> <ab.json> <out.md>`: builds the table.
- `down.sh <walk>`: stops the processes by their pid files and removes only the walk's own container.

## Rerun

```sh
K=$(pwd)/scripts/acceptance/session-three-state-check/walk; T=/tmp/p3/tip; R=/tmp/p3/walk   # from the repo root
$K/up.sh $T $R 55731 55732 55733 && $K/api.sh $T $R
(. $R/env && node $K/seed.cjs $T $R && node $K/seed-control.cjs $T $R)
nohup $K/beat.sh "$(cat $R/pg.name)" "$(node -e "console.log(require('$R/seed.json').runnerId)")" > $R/beat.log 2>&1 & echo $! > $R/beat.pid
(cd $T/src/web && WALK_WEB_ROOT=$T/src/web WALK_API=http://127.0.0.1:55732 WALK_WEB_PORT=55733 \
  nohup npx vite preview --config $K/vite.preview.config.mjs > $R/preview.log 2>&1 & echo $! > $R/preview.pid)
(. $R/env && node $K/api-read.mjs $R $R/api.json)
node $K/walk.mjs $R http://127.0.0.1:55733 $R/run && node $K/walk-ab.mjs $R http://127.0.0.1:55733 $R/ab
node $K/make-table.mjs $R/api.json $R/run/dom.json $R/ab/ab.json $R/table.md
$K/down.sh $R
```

Playwright comes from `/root/orbit/node_modules/playwright` (1.63, Chromium 1243). Pass another module path as the scripts' last argument if it lives elsewhere.

## Result (2026-11-24)

All seven approved words match in the list row and the header.

The control found a defect outside the seven:

- **Cause.** The server's list row sends `activity: "TURN"` for every row stored PENDING or RUNNING (`sessionActivitySql`). The web's `runStateFromPhaseFields` reads phase RUNNING with any `activity` as AWAITING_INPUT.
- **Plain RUNNING turn.** It reads "Waiting for your reply", and the composer shows no Stop button.
- **Approval case.** The word is right, but the card is drawn dead: "This turn has ended…" with Approve disabled.

The table, screenshots and reads were uploaded with `file_upload`. They are not kept here.
