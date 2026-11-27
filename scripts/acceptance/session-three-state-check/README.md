# Session three-state: do the three clients decide the same things?

Checked at the project tip 4f99cb45ff (project/3508bDBDE5xPH43TYuiqP), no product code changed.

- `make-fixture.mjs` -> `fixture.json`: 15 session payloads (the seven statuses; running a job with no turn; waiting on an
  approval; on hold; ended with the runner never confirming; an old plain SUCCEEDED row; ending after an interrupted turn;
  an unknown status with no capabilities, held and released), each with the new fields and again with `phase`, `released`,
  `lastTurnOutcome`, `waitingOn`, `workFinished` removed (an older server). 30 rows.
- `web-decisions.test.ts`, `AppleDecisionsTests.swift`, `AndroidDecisionsTest.kt`: one driver per client, calling the client's own
  decision functions (web `sessionSendDispositionOf` / `isSessionTerminal` / `statusLabel`; Apple `ComposerLogic.availability` +
  `shouldResume` / `Session.isReleased` / `SessionHeader.statusWord`; Android `sendEndpoint` / `runEnded` / `SessionHeader.statusWord`).
- `run-all.sh <tip checkout> <outdir>` runs them (vitest, `swift test` in swift:6.1, gradle) and `compare.mjs` writes `table.md`.

Send: web SEND/RESUME/CREATE/BLOCK; Apple: SEND = sendNow or queue, RESUME, BLOCK; Android `turns` = SEND, `resume`, a thrown
refusal = BLOCK.

Regenerate everything (table.md is the output):

    git worktree add --detach /tmp/tip project/3508bDBDE5xPH43TYuiqP   # then node_modules as in any checkout; apiserver built with
    (cd /tmp/tip/src/apiserver && npx tsc -p tsconfig.test.json)       # tsc -p tsconfig.test.json for the server-built capabilities
    scripts/acceptance/session-three-state-check/run-all.sh /tmp/tip /tmp/out

`make-fixture.mjs` regenerates fixture.json (hand-written capabilities); `server-capabilities.cjs` replaces them with the server's own.
web.json, apple.json and android.json are the driver outputs the committed table.md was built from.

The display check across the three clients (project 353SgnUjvamRr06Sho0EZ, criterion 7) is in [display/](display/README.md).
