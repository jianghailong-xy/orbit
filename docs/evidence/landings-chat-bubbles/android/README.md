# Android — the Landings window drawn as a chat

Owner 2026-11-02, board `docs/mocks/landings-chat-bubbles/` (option C, every recommended pick: the time at the end of each bubble's
foot, a read-only bar shaped like the composer with `Open coordinator`, Orbit's avatar once per group). The window's code is
`src/android/app/src/main/kotlin/io/orbitd/android/reader/ProjectLandingsWindow.kt`; the shared grouping rule is
`SessionProjectLandings.groups` (`directory/SessionProjectLandings.kt`), OrbitKit's `groups` / `groupGap` line for line.

The pictures are commit `50e1e1f3b`'s debug build on the shared emulator (`sdk_gphone64_x86_64`, Android 16 / API 36,
1080 × 2400 at 420 dpi, Asia/Shanghai), driven through the real product shell by `kit/src/LandingsChatShotsTest.kt` against a
MockWebServer inside the instrumentation: no deployed server, account or runner. Its project, `install.sh on multi-user machines`, has
had these landings (every name is example data; the times are set relative to the run):

- Yesterday: `T1 install.sh: keep one orbit binary per account` landed at 22:11 and its merge into main followed at 22:13
  (`1 task · automatically`); `T2 host setup refuses a binary it did not install` at 23:07, merged at 23:09; `T4 install.sh under sudo
  writes the unit file once` at 23:25, merged at 23:29.
- Today: `T3 sudo hints name the binary's real path` landed and merged in the same minute, halfway from midnight to the run (04:31
  here).
- Now: `T5 orbit doctor reports the runner's own binary` waits for a decision (its task acceptance exited 1 after 3m 52s; the
  coordinator has it); `T6 upgrade keeps each account's service running` is checking.

| Picture (`light/`, and the same in `dark/`) | Board part | What it shows |
|---|---|---|
| `a-window-at-its-bottom.png` | 02 d | The window as the sessions page's Landings row opens it, at its bottom: the `Today` chip, T3's bubble and the merge that carried it in one group beside one avatar, the `Now` chip in the accent, then one group holding today's two status cards unchanged and without the end gutter (T5: red ✕, `Not landed`, `Open coordinator` / `Open task`; T6: clock, budget bar, liveness), and the read-only bar. |
| `b-day-chips-and-groups.png` | 01 b | Scrolled up: the `Yesterday` and `Today` chips, and yesterday's three groups, each a task's bubble (✓ `Landed`, its time) with its merge two to four minutes later (⇢ `3c1e9a0 · 1 task · automatically`), one avatar per group. Task names are whole and wrap; a merge bubble hugs its words; every bubble keeps the end gutter. |
| `c-bubble-opened.png` | 03 e | T3's bubble tapped: its record opens under it on a quiet panel at the column's width — `Generation 1`'s timeline, then `Open task ›` and `Open source session ›`. |
| `d-bubble-long-press-menu.png` | 03 f ①② | A long press on T3's bubble: today's menu, anchored under the bubble — `Open task`, `Open source session`, `Open coordinator`. |
| `e-opened-on-a-landing-outlined.png` | 03 f ③ | An `orbit-session:` link to yesterday's T2 (the way Open landing ›, a coordinator's card, the task page and a landing label open a landing): the window opens scrolled to it, opened, and outlined on its bubble. |
| `e2-after-the-outline.png` | 03 f ③ | The same 2 s later on the test's frame clock: the outline has gone, T2 stays open. |

The test asserts each frame before it is taken (the cards' heads and doors, both groups of today and the bar's door for `a`;
yesterday's groups for `b`; the record panel and its links for `c`; the menu's rows for `d`; the outline on T2 and its record for `e`,
and its going for `e2`) and that the settled landing it was opened on is read once, never polled. `light/notes.txt` and
`dark/notes.txt` say what it read on each frame (chips, titles, details, times, avatars on screen, the bar's words), and
`requests.txt` every call it answered. `source-sha.txt` is the tree the run took, `apks.sha256` the APKs it installed and
`installed.sha256` what the device held inside the same lock hold.

## Checks

| Check | Result |
|---|---|
| The classes this touches, at `50e1e1f3b`'s tree: `SessionProjectLandingsTest` 14, `SessionLandingsCopyParityTest` 7, `LandingEntriesShellTest` 21, `LandingSessionShellTest` 24, `ProjectMergeShellTest` 16, `LandingSessionViewTest` 1 | 83 passed |
| `src/android/scripts/verify.sh` at `50e1e1f3b`, in a clone on `/mnt/data` (`verify/`) | exit 0: `:core:test` 338, `:app:testDebugUnitTest` 2093, `:app:testReleaseUnitTest` 2093, 4524 local tests passed, no skips; `lintDebug` no errors; `assembleDebug` passed. Its first attempt was ended at 01:12:50Z by a host-wide OOM kill (exit 143; the kernel log has another process asking for the memory and the build's JVM, at `oom_score_adj` 900, taken first); the second ran through in 18m 6s |
| `:app:compileDebugAndroidTestKotlin`, `:app:assembleDebugAndroidTest` at `bdceccd77` | built (CI does not compile these) |
| `ProjectIncrementsDeviceTest` on the emulator, by `increments-device-test.sh`, at `bdceccd77` | `PASS 6` (`verify/project-increments-device-summary.tsv`); it holds the one device wait that named the up arrow |
| This kit on the emulator at `50e1e1f3b` | `OK (1 test)` in light and in dark (`light/instrumentation.txt`, `dark/instrumentation.txt`, `result.txt`, `device.txt`) |

`bdceccd77` differs from `50e1e1f3b` only in that one device test. The other device journeys through the window
(`LandingSessionDeviceTest`, `LandingEntriesDeviceTest`, `TaskLandingDeviceTest`, `ProjectMergeDeviceTest`,
`ProjectMergeRealStackDeviceTest`) compile and use only tags that are still there; they were not run for this.

## Run

```bash
# Build the debug APK and an androidTest APK that carries the kit's test (nothing under src/android changes for it):
bash src/android/gradlew -p src/android -I docs/evidence/landings-chat-bubbles/android/kit/kit.gradle \
  :app:assembleDebug :app:assembleDebugAndroidTest
# Photograph on a booted emulator (light, then dark). It waits for host memory without the device lock, then holds
# /var/lib/orbit/android/ui.lock for the run only; it never starts or stops the emulator, and puts night mode and the
# stylus setting back as it found them.
ANDROID_SERIAL=emulator-5554 bash docs/evidence/landings-chat-bubbles/android/kit/run.sh \
  src/android/app/build/outputs/apk/debug/app-debug.apk \
  src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk <new empty dir>
```

The frames land in `<dir>/landings-chat/{light,dark}/`. These were built with the build directories moved to `/mnt/data` by an init
script (a second `-I`), which only changes where the APKs are.

## Notes

- **The avatar** is `R.drawable.orbit_app_icon`, the drawable the sign-in page already draws, not the launcher's foreground: that one is
  the blue mark meant for a white adaptive-icon background, and this one is the board's `avatar()` (the `#5C8CFF → #3370FF` tile, radius
  229/1024, the white mark).
- **The bar.** Android's `SessionComposer` is not one rounded card as on iOS: it is a full-width `Surface(tonalElevation = 2.dp)` band
  holding an `OutlinedTextField` over a row of buttons. The bar takes that band and its padding, and the field's shape, minimum height,
  border and outline colour on a plain box. There is no text field. `Open coordinator` is an `OutlinedButton` with a new `ic_person`
  vector (no person icon existed), at the end of the row, where Send stands.
- **No up arrow on a bubble**: the board's open bubble draws none, and its foot ends with the time. `Now`'s cards keep theirs.
- **The long press** is today's Material dropdown under the bubble. The board's lift and dimming are what iOS's context menu does; they
  are not drawn here.
- **Links in a panel.** `Open task ›` and `Open source session ›` are a `FlowRow` now: in a bubble's narrower column the second goes under
  the first rather than breaking inside its button. The record's words are unchanged, and its lines wrap sooner than in the old
  full-width row (`Merge check passed · 8m 41s` beside `Log ›`).
- **Open question: `Now`'s cards are unchanged, so T6's task name keeps the card's one line and ellipsis.** The avatar narrows the card by
  40dp, so that name is cut where the old full-width card would have fitted it, and the board draws it wrapping (02 d). It is one
  `maxLines` on `landing:task-name` in `LandingSessionPage.kt`, left as it is because the cards were to stay unchanged.
- **Words.** No new copy; Android's sentence-case menu rows are the existing platform exception. A failed check's sentence reads `Task
  acceptance exited 1 …` as it does today in every client, where the board's drawing says `Merge check exited 1 …`. The board's project
  subtitle is Chinese example data; the kit names the project in English.
