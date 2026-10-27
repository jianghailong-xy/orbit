# Android — a project's landings in one Landings window

Task `34nGbUykKeP4geymwZYB8` (owner 2026-10-27, board `docs/mocks/landings-one-window/`, contract
`docs/project-integration-line-contract.md` §2.9 LS6 / §3.6, revision 28; design `docs/landing-session-design.md` §3).

The pictures are this tree's debug build on the shared emulator (`sdk_gphone64_x86_64`, Android 16 / API 36, 1080 × 2400 at
420 dpi, Asia/Shanghai), driven through the real product shell by `kit/src/LandingsWindowShotsTest.kt` against a MockWebServer
inside the instrumentation — no deployed server, account or runner. Its project, `Ledger service`, has two landings in hand (one
waiting for a decision after its check failed, one checking), five settled today (three landed — one of them already on the
branch —, one with nothing to land, and the round that merged into main, joined with its record by `landingSessionId`), two
settled yesterday, and one merge into main from before landing sessions. Every name is example data. Its times are set relative to
the moment it runs; these were taken at 04:11 local time, so Today's rows sit early in the morning.

| Picture (`light/`, and the same in `dark/`) | Board frame | What it shows |
|---|---|---|
| `b-sessions-page-landings-row.png` | 01 b | The project's sessions page: under Coordinator one **Landings** row — ✕ (a landing waits for a decision), `18m` (the longest wait), `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` over two lines — and the day sections below it with sessions only (no Merged into main row). |
| `d-window-at-its-bottom.png` | 02 d | The row, pressed, opens the project's Landings window at its bottom: `Landings` / `Run by Orbit · Ledger service` and its ⋮, Today's settled rows (◌ Nothing to land, ✓ Landed, ⇢ `Merged into main · 3f1c2a9 · 2 tasks · automatically`, ✓ Already landed) at their settle times, then `Now` with the waiting card — its attempt stopped on a failed check, so its head wears the Landings row's red ✕ and a red `Not landed` (revision 2) — with its doors Open coordinator / Open task, and the checking card (V6 clock, budget bar about a fifth full at `6m 16s of 30m` with the usual-duration tick, liveness), and the read-only footer. No composer. |
| `d2-window-day-sections.png` | 02 d | The same window scrolled up: the session list's day sections, oldest first — `8–30 days ago` (a merge into main from before landing sessions, which opens to its receipt alone), `Yesterday`, `Today`. |
| `g-card-long-press-menu.png` | 03 g | A long press on the checking card: the old landing page's ⋯ rows — Open task, Open source session, Open coordinator, then `Stop landing` with `Before the push only · nothing pushed yet`. The menu stands above the card, the room below it being the footer's. |
| `e-merge-row-open.png` | 03 e | Today's Merged into main row pressed: opened in place (⌃ on its right) to the receipt — `Now on main · 2 tasks`, the tasks, `✓ Passed on the combined tree · 17m 41s`, `Landed exactly the tested tree 5e5bfca · as a merge commit` — over the round's own record (`Merge check · 1`, `Merge to main · 1`). |
| `f-opened-on-a-landing.png` | 03 f | An `orbit-session:` link to yesterday's `Currency code lookup` — the way every Open landing ›, coordinator card door, task page Landing section and landing label opens a landing — opens the window on it: scrolled to, opened (two generations, the failed check's tail inline, `Open task ›` / `Open source session ›`) and outlined. |
| `f2-after-the-outline.png` | 03 f | The same 2 s later (on the test's frame clock): the outline has gone; the landing stays open. |

The test asserts each frame before it is taken (the row's line and time, the cards' heads — the waiting card's red ✕ and the checking
card's ring — and doors, the menu's rows, the receipt's lines, the outline and both generations) and that a settled landing's own view is read once, never polled; `light/notes.txt`
and `dark/notes.txt` say what it read on each frame, and `requests.txt` every call it answered.

## Checks

| Check | Result |
|---|---|
| `src/android/scripts/verify.sh` (in a clone of this tree) | exit 0 — `:core:test` 282, `:app:testDebugUnitTest` 1863, `:app:testReleaseUnitTest` 1863: 4008 local tests passed, no skips; `lintDebug` and `assembleDebug` passed |
| `:app:assembleDebugAndroidTest` | built (the device journeys that went through the single landing page — `LandingSessionDeviceTest`, `LandingEntriesDeviceTest`, `TaskLandingDeviceTest`, `ProjectIncrementsDeviceTest`, `ProjectMergeDeviceTest`, `ProjectMergeRealStackDeviceTest` — now go through the window; they compile, and were not run on a device for this task) |
| This kit on the emulator | `OK (1 test)` in light and in dark (`light/instrumentation.txt`, `dark/instrumentation.txt`; the run itself in `result.txt`, the device in `device.txt`) |

## Run

```bash
# Build the debug APK and an androidTest APK that carries the kit's test (nothing under src/android changes):
bash src/android/gradlew -p src/android -I docs/evidence/landings-one-window/android/kit/kit.gradle \
  :app:assembleDebug :app:assembleDebugAndroidTest
# Photograph, holding the shared device lock (light, then dark):
ANDROID_SERIAL=emulator-5554 bash docs/evidence/landings-one-window/android/kit/run.sh \
  src/android/app/build/outputs/apk/debug/app-debug.apk \
  src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk <new empty dir>
```

## Notes

- Android's menu rows are sentence case (`Open task`, `Stop landing`), the platform's existing exception in the copy-parity tests;
  every other word on these pictures is OrbitKit's.
- Revision 2 (review of revision 1): an attempt that stopped on a failure — `CHECK_FAILED`, `CONFLICT`, `ERROR`, read from the
  attempt's state (`LandingSessionModel.FAILURE_STATES`, held to OrbitKit's by `LandingSessionCopyParityTest`) — wears the red ✕ head
  and a red `Not landed` on its status card (board 02 d); `CANCELLED` and every other state keep the quiet head. Every frame here was
  taken again after that change.
- An https link to the web's `/projects/<id>/landings` is not routed to the Android window; Android opens it from the project
  page's row and from any landing session's id.
