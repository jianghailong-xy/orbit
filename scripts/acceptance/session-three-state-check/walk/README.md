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
- `seed-control.cjs <tip> <walk>`: adds the plain RUNNING turns. One has no `engineStartedAt` (the F7 control, "Starting") and one has its engine started ("Running").
- `seed-task-runs.cjs <tip> <walk>`: adds one IN_PROGRESS task with two runs, a finished one (task_done) and one queued on hold (paused account), for the task panel's run badges.
- `seed-approval.cjs <tip> <walk> <case>`: adds a fresh pending Bash approval to one case's session, so there is a card to press again.
- `beat.sh <container> <runner id>`: keeps the runner's `last_heartbeat_at` fresh. Without it, the runner goes offline after 90 s, and a queued row shows its runner gate instead of "On hold".
- `vite.preview.config.mjs`: `vite preview` of `<tip>/src/web/dist` with `/api` proxied to the walk's apiserver. Build the console first with `cd src/web && npx vite build`.
- `api-read.mjs <walk> <out.json>`: the six fields from the list (matched by title, since the API answers public ids) and from the detail.
- `walk.mjs <walk> <origin> <out>`: signs in, opens each session, reads the DOM until it holds still, and takes screenshots.
- `walk-ab.mjs <walk> <origin> <out>`: the same console with `activity` nulled on rows stored RUNNING. It rewrites the list and detail JSON in the browser and never the `/events` stream.
- `walk-task.mjs <walk> <origin> <out>`: opens each seeded task's panel (`/tasks/<id>`) and reads every run's badge (`a.tdp-session .tdp-badge`), matched to a run by its link.
- `walk-approve.mjs <walk> <origin> <out>` (`WALK_CASE=<case>`, default `approval`): presses Approve on the card and waits up to 30 s for the word to change. It records the decision request, the DOM before and after, and the approval and session from the API before and after. It changes state, so run it last.
- `make-table.mjs <api.json> <dom.json> <ab.json> <out.md>`: the F7 table.
- `make-table-b.mjs <walk dir> <out.md>`: round B's table. It reads `api.json`, `run/dom.json` and `task/task.json`, and quotes the held run's `GET /api/tasks/:id` JSON.
- `make-table-fix.mjs <walk dir> <out.md>`: the fix walk's table. It reads `api-before-press.json`, `run2/dom.json`, `task/task.json`, `ab/ab.json` and `approve2/approve-*.json` under `<walk dir>`.
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

Playwright 1.63 (Chromium 1243) is the default module, `/root/orbit/node_modules/playwright`. Since 2026-11-24 that checkout no longer has it, so pass `/tmp/p3/tip/node_modules/playwright` (or wherever it lives) as the scripts' last argument.

## Result (2026-11-24)

All seven approved words match in the list row and the header.

The control found a defect outside the seven:

- **Cause.** The server's list row sends `activity: "TURN"` for every row stored PENDING or RUNNING (`sessionActivitySql`). The web's `runStateFromPhaseFields` reads phase RUNNING with any `activity` as AWAITING_INPUT.
- **Plain RUNNING turn.** It reads "Waiting for your reply", and the composer shows no Stop button.
- **Approval case.** The word is right, but the card is drawn dead: "This turn has ended…" with Approve disabled.

The table, screenshots and reads were uploaded with `file_upload`. They are not kept here.

## Fix walk (2026-11-24): console from e95ff30f32, apiserver from the tip

The fix console was built in its own checkout (`cd /tmp/p3/fix/src/web && npx vite build`) and served with `WALK_WEB_ROOT=/tmp/p3/fix/src/web`. Everything else ran the tip, as above, plus `seed-task-runs.cjs`, `walk-task.mjs`, `seed-approval.cjs` (on `approval` and `running-started`) and `walk-approve.mjs` once per case.

All the session words, Stop, the spinner or terminal glyph, and the approval card now read as expected, and pressing Approve leaves a running turn with Stop.

Still wrong: the task panel's badge for a run on hold says "Queued". The tip server's task detail sends each run with `status`, `runState` and `endReason` but no `waitingOn` (`TasksService.loadDetail`), and the panel's new "On hold" reading needs `waitingOn`.

## Round B (2026-11-24): console and apiserver both from the merged tip 941551f956

This round used the same recipe on ports 55771-55773 with the tip's own console build. The scripts were `seed.cjs`, `seed-control.cjs`, `seed-task-runs.cjs`, `api-read.mjs`, `walk.mjs` (which now also reads each row's list group), `walk-task.mjs` and `make-table-b.mjs`. There was no A/B and no press: every payload was the server's own answer.

Everything asked for matched:
- a running turn reads "Running" with Stop;
- an approval reads "Waiting for approval" with Approve enabled;
- a job-only session shows the background word and the terminal glyph, under Working;
- a parked session reads "Waiting for your reply" with no Stop;
- Failed and Ended read as before;
- the task panel shows "On hold" and "Finished" from the facts in the task detail's `sessions[]`.

Two task-level words still say "Queued" for a held run: the panel's Now card (TaskDetailPanel.tsx:2040-2043) and the Tasks list pill (TaskStatusPill.tsx:13).

