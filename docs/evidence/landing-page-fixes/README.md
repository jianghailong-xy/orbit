# Landing page small fixes: web, iOS/macOS and Android

Task `34jQkOSz5CENWMRYAWVHC`. Branch `orbit/task-ready-ios-ios-web-3ea39c`, based on origin/main `e9fdb4080`. The four defects were found while reviewing the landing-session follow-up (task `34jBwFmcEPK012TsNL0Lc`), and all four predate this branch on main. The design references are the owner-approved boards `docs/mocks/landing-session/v4/` 04, 05 and 07.

Item 4 had one reading question. The creating session `34ZyHoLsfDlMhp5cstme6` chose option A (request `34jQvEVUSwSAglSiSlNWx`, recorded in task comment `34jQvvm91W6XZEtOSwutb`):
- A closed bare fold wears a grey ✓ in web's quiet ink, which is the glyph iOS and Android draw for a closed fold.
- A fold that counts landings keeps v4 04 c1's green ✓.
- An open fold keeps its grey ◌.

## Commits

| Item | Commit | What it does |
|---|---|---|
| 1 | `baaf77de5` | A merge check (CHECK_PROMOTION) that ends READY draws ✓ on its result line `Ready to merge into main`. The rule reads the line's `data.state` together with the job `kind` of the section the line is in, never the sentence. A LAND_PROMOTION that answers READY handed the candidate back to be checked again (M-T12, J-T13), so it keeps its ✗; so does a READY in a LAND_TASK section. Web: `landingEntryOk(entry, kind)`. Swift: `IntegrationTimelineEntry.succeeded(in:)` replaces the `succeeded` property. Kotlin: `LandingSessionModel.entryOk(entry, jobKind)`. Each platform's timeline mark passes `section.kind`. |
| 2 | `72d14373a` | iOS/macOS `LandingInlineOutput` hangs its `.task` on a `VStack` that exists before it has any lines. Before, the task hung on a `Group` holding only `if !lines.isEmpty`; with no lines that `Group` is no view, so the log was never read and the tail never appeared. A read that fails or finds nothing still draws nothing inline, as on web (`LandingInlineOutput` returns `null`). The line's `Log ›` still opens the log. |
| 3 | `1f710dbf1` | The iOS sessions page's Earlier fold label carries `.contentShape(Rectangle())`. The plain-style button now takes a press anywhere on its row, including the empty middle under the Spacer. |
| 4 | `fa19b3ac4` | Web: a closed bare `Earlier` fold (both counts 0, over cancelled, handled or declined rows) wears the ✓ with `is-quiet` instead of `is-ok`. |
| — | `f8c9e857b` | The evidence kits: `probe-harness/`, `web-kit/`, `android-kit/`. |
| — | this commit | The frames and this README. |

## Files changed (product and tests)

- **Item 1, `baaf77de5`:**
  - Web: `src/web/src/lib/landingSession.ts`, `src/web/src/components/LandingSessionView.tsx`, and their tests `landingSession.test.ts`, `LandingSessionView.test.tsx`.
  - OrbitKit: `Models/LandingSession.swift`, with tests `LandingSessionPageTests`, `LandingSessionDecodingTests`, `LandingViewsWiringTests`.
  - OrbitApp: `Views/LandingSessionPageView.swift`.
  - Android: `reader/LandingSessionModel.kt`, `reader/LandingSessionPage.kt`, with tests `reader/LandingSessionModelTest.kt`, `LandingSessionShellTest.kt`.
- **Item 2, `72d14373a`:** OrbitApp `Views/LandingSessionPageView.swift`; OrbitKit `LandingViewsWiringTests`.
- **Item 3, `1f710dbf1`:** OrbitApp `Views/SessionProjectPage.swift`; OrbitKit `LandingViewsWiringTests`.
- **Item 4, `fa19b3ac4`:** `src/web/src/components/SessionProjectLandings.tsx`, `src/web/src/components/WorkspaceView.projectSessions.test.tsx`.

**Commit rules.**
- No copy changed: this task adds no words.
- The only Swift string literals added are item 1's `"CHECK_PROMOTION"` and `"READY"` in the predicate. That commit changes `src/android` too.
- Items 2 and 3 change no Swift literal: only view structure and a modifier. Their commits touch no `src/android`.
- None of the changed web lines is pinned by OrbitKit. OrbitKit reads `landingSession.ts` only for its copy constants and `LEASE_STALE_MS` / `landingRefetchMs`, which did not change. It does not read `LandingSessionView.tsx` or `SessionProjectLandings.tsx`.
- Android's copy-parity tests read `SessionProjectPage.swift` and `LandingSessionPageView.swift` as text. They still pass (see Checks).

## Tests per item (file:line at `fa19b3ac4`)

- **1, ✓ for a merge check's READY.** Each platform pins READY ✓ in a CHECK_PROMOTION section, including a reworded sentence, and ✗ in a LAND_PROMOTION or LAND_TASK section.
  - Web lib: `src/web/src/lib/landingSession.test.ts:621`. The older cases now name their section's kind, at `:593`, `:608` and `:637`.
  - Web DOM: `src/web/src/components/LandingSessionView.test.tsx:421`, a three-section round: check READY ✓, merge READY ✗, check READY ✓.
  - Swift: `src/macos/OrbitKit/Tests/OrbitKitTests/LandingSessionPageTests.swift:753`, plus `:723`, `:737` and `:766`; `LandingSessionDecodingTests.swift:98`. `LandingViewsWiringTests.swift:174` pins `glyph(entry, jobKind: section.kind, …)` and `entry.succeeded(in: jobKind)` in OrbitApp.
  - Kotlin: `src/android/app/src/test/kotlin/io/orbitd/android/reader/LandingSessionModelTest.kt:381`, plus `:297`, `:354`, `:368` and `:393`. The page case is `LandingSessionShellTest.kt:229`, which renders two sections: check READY ✓, merge READY ✗.
  - Product lines:
    - web `landingSession.ts:982`/`:989` and `LandingSessionView.tsx:581`/`:675`;
    - Swift `LandingSession.swift:306`/`:313` and `LandingSessionPageView.swift:404`/`:467`;
    - Kotlin `LandingSessionModel.kt:747`/`:750` and `LandingSessionPage.kt:475`/`:511`.
- **2, iOS/macOS inline output.** `LandingViewsWiringTests.swift:188` pins three things: the read hangs on the stack (`LandingSessionPageView.swift:836`), there is no `Group {` in the view, and the guarded read draws nothing when it fails. The behaviour is the probe's `testIPhoneFailedCheckOutputLoadsInline` and `testMacFailedCheckOutputLoadsInline` (below).
- **3, iOS fold hit area.** `LandingViewsWiringTests.swift:209` pins `.contentShape(Rectangle())` on the label, inside `.buttonStyle(.plain)` (`SessionProjectPage.swift:392`). The behaviour is the probe's `testIPhoneEarlierFoldOpensFromTheEmptyMiddleOfItsRow`.
- **4, web bare fold.** `src/web/src/components/WorkspaceView.projectSessions.test.tsx`:
  - bare closed `✓:is-quiet` at `:1408` and `:1433`, opening to `◌:is-quiet` at `:1413`;
  - counted closed `✓:is-ok` at `:1365` and `:1386`, opening to `◌:is-quiet` at `:1369`.
  - The product line is `SessionProjectLandings.tsx:34`/`:49`.

**Red checks.**
- Web: with the old READY rule, the two new web tests fail. With the old fold mark, the two bare-fold tests fail (`✓:is-ok` received).
- OrbitKit: on main `e9fdb4080` with only the new `LandingViewsWiringTests` copied in, the three changed or new wiring tests fail (5 assertions) and the other 8 pass. The model tests cannot compile there, because the API changed.

## Checks

- **Web vitest, whole suite:** 426 files and 5590 tests passed under `TZ=UTC` (on `fa19b3ac4`) and under `TZ=Asia/Shanghai` (on `f8c9e857b`, whose product code is the same). `tsc` for web and shared is clean. The three web test files changed here type-check, apart from errors already on main in lines this branch does not touch.
- **OrbitKit** (`docker run --rm --memory=6g -v <worktree>:/src:ro -w /src/src/macos/OrbitKit swift:6.1 swift test --scratch-path /tmp/okbuild`, which is the task's command plus a memory cap): 4028 tests, 0 failures, 5 skipped. The same 5 are skipped on main.
- **OrbitKit on this branch merged into origin/main `a7462d4ac`** (a scratch merge, not pushed): 4038 tests, 0 failures on the rerun. The first run had 1 failure, `ProjectLandingHeadTests.testATakeoverNamesTheFirstStartTheClaimRowStillCarries`. It is a clock flake on main:
  - The test file is untouched by both sides.
  - Its helper takes the claim time as `now − 110.5 s` while its expectation uses `now − 110 s`, so the two straddle a minute whenever the test starts at :50.0–:50.5 seconds past the minute. It started at 23:08:50.061.
- **Android** (`:core:test --rerun :app:test --rerun --continue`):
  - core 266, app debug 1700, app release 1700 tests, 0 failures. Every result file was written during the run.
  - Parity tests included: `ProjectCopyParityTest` 8, `SessionProjectCopyParityTest` 6, `TaskCopyParityTest` 9, `LandingSessionCopyParityTest` 3, `SessionLandingsCopyParityTest` 4, and core `ExceptionCardsTest` 17.
- **GitHub `client.yml`**, dispatched on `f8c9e857b` (run 39512432520): macOS (build + test), iOS (generate + build), Font tokens and Navigation all passed.
- **GitHub Android CI** (`android.yml`: test + lint + debug APK) on `f8c9e857b` (run 39512365529): passed.
- **iPhone/Mac probe** (run 39512371867, probe commit `4fa296246`): passed.
  - The probe commit is `f8c9e857b` with only `.github/workflows/client.yml` replaced by `probe-harness/ci/client.probe.yml`.
  - Results: iPhone 3 tests and Mac 2 tests, 0 failures. `ios/tests-ios.txt` and `mac/tests-mac.txt` have the test case lines.
- **merge-tree:** `git merge-tree --write-tree origin/main HEAD` is clean, first against `a7462d4ac` and again after a fresh fetch against `aae7a27e5`. What main gained since the base shares no file with this branch: the needs-you capsule (`ee9306630` and its evidence) and the managed-runner merge (`aae7a27e5`, no client files).
- **Probe branches:** `probe/landing-page-fixes`, `probe/landing-page-fixes-results` and `probe/landing-page-fixes-gates` were deleted from origin after these runs.

## Screenshots

| | Web | iOS | macOS | Android |
|---|---|---|---|---|
| ① a merge check that ended READY: `Ready to merge into main` ✓ | `web/light-ready.png`, `web/dark-ready.png`; the round with a handed-back merge (READY ✗ in its own section) in `web/*-ready-round.png` | `ios/ios-1-ready-result.png` | `mac/mac-1-ready-result.png` | `android/light/01-ready-result.png`, `android/dark/01-ready-result.png` |
| ② a failed check's output inline | — | `ios/ios-2-failed-inline.png` | `mac/mac-2-failed-inline.png` | — |
| ③ the fold pressed on its empty middle | — | `ios/ios-3-fold-before.png` → `ios/ios-3-fold-after.png`; the press point is drawn on a copy, `ios/ios-3-fold-before-press.png` | — | — |
| ④ the bare fold | `web/light-fold-bare.png`, `web/dark-fold-bare.png` (closed, grey ✓); `web/*-fold-bare-open.png` (open, ◌); `web/*-fold-counted.png` (counted, green ✓) | — | — | — |

How each frame was checked, beyond the picture:
- **① iPhone and Mac.** The probe reads the mark on the result line's row from the accessibility tree and asserts ✓ (`ios/…ReadyDrawsACheckmark-notes.txt` and the Mac notes: `result line mark ✓, check line mark ✓`).
- **① Web.** `web/report-landing.json` lists each line's glyph and class beside its text.
- **① Android.** `LandingPageFixesShotsTest` asserts `landing:mark:6` is ✓ beside `landing:entry:6`, which is `Ready to merge into main`. `android/*/01-ready-result-semantics.txt` holds the tree.
- **② iPhone and Mac.** The tail appears with no press on `Log ›`. The stub logged the page's own read, `GET /api/sessions/L1/landing/log?jobId=jL&claim=1&round=1&check=1` (`ios/requests.log`, `mac/requests.log`, and the notes).
- **③ iPhone.** The fold row is (0, 650.3, 402 × 52) pt and its word ends at x = 72.3. The press landed at (221.2, 676.3) pt: 149 pt right of the word and 181 pt left of the row's end (`ios/ios-3-press.txt`). The fold opened onto all three older rows.
- **④ Web.** `web/report-fold.json` records the fold's mark: `✓ is-quiet` closed bare, `◌ is-quiet` open, `✓ is-ok` counted.

## Kits

- **iPhone and Mac:** `probe-harness/` is the follow-up kit (`docs/evidence/landing-session-followup/probe-harness`) with:
  - two new stub modes, `ready` and `failed`;
  - a failing tail for check 1 of `failed`;
  - its own UI tests, `UITests/LandingPageFixesTests.swift`;
  - its own branches.

  The stub's answers were preflighted through OrbitKit's decoders in docker before the run, 3/3.
- **Web:** `web-kit/capture-landing.mjs` comes from the landing page kit, and `web-kit/capture-fold.mjs` from the follow-up entries kit. Both run against a `vite build` of this branch, under `unshare -n`, with `FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf`.
- **Android:** `android-kit/` is compiled into the app's unit tests through `-I android-kit/kit.gradle`, and run with `--tests 'io.orbitd.android.LandingPageFixes*'`.

## Not covered, and found on the way

- **Pre-existing on all three clients, outside these four items: a READY attempt's status card says `Stopped · not landed`.** It shows under `Passed the check · waiting for the owner` in every ① frame. The terminal card's `failure` line falls back to `STOPPED_NOT_LANDED` for a READY attempt: web `landingSession.ts` `terminalCard`, Swift `LandingPageCopy.attemptCard`, and the Kotlin port. Board 05 draws no READY attempt card. This branch leaves it as it is.
- iOS/macOS frames are light only. Android and web have light and dark.
- Item 3 changes iOS only: the Mac has no Landings group.
