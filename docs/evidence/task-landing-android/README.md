# Android: the task page's Landing section (A-3)

Contract §2.7a and the owner's 2026-10-08 decision (Android gets the task page's Landing section),
drawn from the v4 board `docs/mocks/landing-session/v4/07-android.png` — its task-page quadrant — in
the web `LandTaskStatus` and OrbitKit `TaskLandingLogic` words.

## What the section draws

| the board | this delivery |
| --- | --- |
| `Landing` + `generation N` | the section heading, with `generation 3` beside it |
| the badge (`Waiting to land`, `Landing`, `Landing checks failed`, `Landed`, …) | `LANDING_LABELS`' words with the web's ink: amber, blue, red, green, muted |
| `checking`, or `stopped while checking` | the attempt's phase word; `stopped while <step>` for `CONFLICT`, `CHECK_FAILED`, `ERROR` |
| the reason sentence | `blockingReason.summary` verbatim; `Waiting to land: the landing has not been queued yet` when no attempt exists |
| the receipt sentence | `Its work is on <branch> by an existing receipt.` — drawn apart from the attempt, because a receipt outranks one |
| Target / Queue wait / Queued / Started / Heartbeat / Finished | the six facts, `—` where the server sent nothing |
| `Open landing ›` | a TextButton into the landing session's page (A-1); not drawn when the server names no session |
| — | a `RUNNING` landing is reread every 4 s, a `QUEUED` one every 15 s, a settled one not at all |

## Captures (API 36 emulator, light)

Every capture is the task page scrolled to its Landing section, with the semantics tree the test
read beside it. The page is served by the test's own controlled HTTP fixture (`MockWebServer`), not
a deployed account.

| state | capture | the section says |
| --- | --- | --- |
| running | `light/01-checking.png` | `Landing` · `generation 3` · blue `Landing` · `checking` · the six facts · `Open landing ›` |
| queued | `light/02-queued.png` | amber `Waiting to land` · the server's reason sentence · no step · `Open landing ›` |
| checks failed | `light/03-check-failed.png` | red `Landing checks failed` · `stopped while checking` · the server's reason · `Open landing ›` |
| landed | `light/04-landed.png` | green `Landed` · no step · no receipt · no `Open landing` (the fixture sends no session id) |
| open landing | `light/05-open-landing.png` | the landing session's own page (A-1) opened from `Open landing ›` |

`light/measurements.txt` records what the test measured: the page rereads a running landing twice in
9 s of page time, and a queued one at quarter-minute steps (nothing in the first six seconds, then a
read, then another quarter minute). Page time is the Compose test clock, which is what the page's
coroutine delays run on (`DirectoryDeviceTest`'s toast expiry uses the same clock).

## How it was produced

- `src/android/app/src/androidTest/kotlin/io/orbitd/android/tasks/TaskLandingDeviceTest.kt` — five
  journeys over the fixture: the four states, the two cadences, and the entrance. It also asserts
  that a settled landing is not reread after 20 s of page time, and that `Open landing ›` is absent
  when the server names no session.
- `src/android/app/src/test/kotlin/io/orbitd/android/tasks/TaskLandingTest.kt` — the JVM tests for
  decoding (no `integration`, no `landTask`, no `landingSessionId`), every label and ink, the
  claim-lease "No report" rule, the receipt, the six facts, the entrance's presence and destination,
  and the 4 s / 15 s intervals.
- `src/android/scripts/verify.sh` — unit, lint and assemble on the same tree.

Device tests are not part of CI; this is a local API 36 emulator result at 720x1280 / 320 dpi.
