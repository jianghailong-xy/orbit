# Cross-client display check: the same state and marks on web, Mac, iPhone and Android?

The check of project 353SgnUjvamRr06Sho0EZ criterion 7, run on the project tip 38d75a2d22 (web, Mac/iPhone and Android
landed). The results are in [report.md](report.md), [display-table.md](display-table.md) (one row per case: state and each
mark per client; older server; Needs you / Working groups) and [surfaces.md](surfaces.md) (every payload kind and surface).
[table-send.md](table-send.md) is the previous rig's own table (send, wait, words, run label) rerun on the same tip.

## Pieces

- `server-payloads.cjs`: seeds 23 cases as real rows (the server's `session-payloads.fixture.ts` plus the board's cases
  and the marks it lacks) and writes all eight payload kinds as the tip's server code builds them.
- `walk-cross.mjs` / `run-walk.sh`: the built console on the tip's apiserver and PostgreSQL over those rows; reads and
  screenshots every web surface and holds each to the board; also reads `GET /sessions/search`.
- `make-rows.mjs`: the drivers' input: the rig's 36 `../fixture.json` rows plus the walk's server payloads.
- `web-display.test.ts`, `AppleDisplayTests.swift`, `AndroidDisplayTest.kt`: one driver per client, calling the client's own
  display functions and surface words on each row, decoding each payload kind as that client decodes it.
- `*Groups*`: Needs you / Working membership only, run at the tip and at the commit before the display change.
- `run-drivers.sh`, `make-display-table.mjs`: run the drivers and render the tables; the generator exits non-zero on any
  difference from the board, between clients on a payload, or in a group.

## Rerun

Two scratch checkouts with `npm ci`, `npm run build -w @orbit/shared` in each; in the tip also
`(cd src/apiserver && npx prisma generate && npx tsc -p tsconfig.test.json)` and `(cd src/web && npx vite build)`.
Never run it in a checkout you commit from: the drivers are copied into its `src/`.

    K=scripts/acceptance/session-three-state-check
    $K/display/run-walk.sh $TIP /tmp/w /tmp/walkout 56731 56732 56733 $TIP/node_modules/playwright
    $K/run-all.sh $TIP /tmp/run $BASE /tmp/walkout     # BASE = cf06a12e75, before the display change

Android needs `ANDROID_HOME=/opt/android-sdk` and an offline Gradle cache; OrbitKit runs in `swift:6.1` on Linux, so no
SwiftUI view is drawn here (see the report).
