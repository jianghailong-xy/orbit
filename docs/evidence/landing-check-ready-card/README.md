# A merge check that ended READY no longer says `Stopped · not landed`: web, iOS/macOS and Android

Task `34jTrtQ1h6ufNX0JSKuLA`. Branch `orbit/task-ready-stopped-not-landed-00731c`, based on origin/main `a4273267a`.

The landing page fixes task (`34jQkOSz5CENWMRYAWVHC`) found this defect; see `docs/evidence/landing-page-fixes/README.md`, "Not covered, and found on the way". A merge check (CHECK_PROMOTION) could end READY. The landing page's status card then said `Passed the check · waiting for the owner` and, on the line under it, `Stopped · not landed`. All three clients did this. That task's READY frames show it: `landing-page-fixes/web/light-ready.png`, `ios/ios-1-ready-result.png`, `mac/mac-1-ready-result.png` and `android/light/01-ready-result.png`.

## Cause and fix

Each client builds this card in `terminalCard`. It is the card for an attempt that has ended while its subject is still open. The card's failure line has its own branches:
- a failed or timed-out check;
- CONFLICT;
- ERROR.

Every other state fell through to `Stopped · not landed`, READY included.

The fix adds one branch before the fallback. A CHECK_PROMOTION whose state is READY has no failure line: null on web and in Kotlin, nil in Swift. Nothing else changes:
- The head still says `Merge check`, `Ready` and `Passed the check · waiting for the owner`.
- `Stopped · not landed` still appears for an attempt that really stopped without landing, such as a CANCELLED one (the owner's Stop Landing).

Board v4 05 draws no card for a READY attempt. Its frames a–j are: checking, main moved, merged, the ⋯ menu, a check that timed out, a merge that timed out, a task check that failed, the task menu, a task that timed out, and a takeover. Board 07 has no READY card either. So the board had no other sentence for this place, and this task adds or changes no words.

| | Product line (at `77c3aae0c`) | Where the page draws it |
|---|---|---|
| Web | `src/web/src/lib/landingSession.ts:570`, in `terminalCard` (`:538`) | `src/web/src/components/LandingSessionView.tsx:398` draws `card.failure` only when there is one |
| Swift | `src/macos/OrbitKit/Sources/OrbitKit/App/LandingSessionPage.swift:582`, in `terminalCard` (`:548`). The local `failure` is now `String?` (`:571`); the card's field already was (`:284`) | OrbitApp `Views/LandingSessionPageView.swift:222`, `if let failure = card.failure` |
| Kotlin | `src/android/app/src/main/kotlin/io/orbitd/android/reader/LandingSessionModel.kt:576`, in `terminalCard` (`:557`) | `reader/LandingSessionPage.kt:409`, `card.failure?.let` |

The fix and its tests are one commit, `1bd5010bf`, across all three clients. The kits are `77c3aae0c`. This README and the frames are the commit after it.

**Copy rules.**
- No words were added, changed or removed.
- The Swift change adds the literals `"CHECK_PROMOTION"` and `"READY"` in a condition. It changes or deletes no existing Swift literal. The same commit changes `src/android` anyway, since the fix is one commit for all three clients.
- The parity tests compare copy constants, and none of them moved. OrbitKit's `LandingCopyParityTests` read `landingSession.ts`'s `LANDING_PAGE_COPY`. Android's `LandingSessionCopyParityTest`, `SessionLandingsCopyParityTest` and `TaskCopyParityTest` read the Swift sources.

## A merge to main that answers READY: outside this task, unchanged

A merge to main (LAND_PROMOTION) answers READY when it hands the candidate back to be checked again and merges nothing (contract J-T6, J-T13, M-T12). This task leaves that card as it is.

The three clients draw it from the same `terminalCard`, and today it reads:
- head `Merge to main`;
- right `Ready`;
- under the head, `Passed the check · waiting for the owner`;
- then the line `Stopped · not landed`.

`web/light-land-ready.png` and `web/dark-land-ready.png` show it. In `web/report.json`, those frames have `cardLines: ["Stopped · not landed"]`. The new tests do not pin this card either way.

## Tests (file:line at `77c3aae0c`)

Each platform has the same cases:
- **READY.** A CHECK_PROMOTION that ended READY has no failure line. Its word, state, right slot and detail are pinned too.
- **CANCELLED.** A cancelled task landing still says `Stopped · not landed`, and so does a cancelled merge check. So the line is hidden by the merge check's READY, not by its kind.

Where they are:
- **Web lib:** `src/web/src/lib/landingSession.test.ts:291` (describe). READY is at `:300`. CANCELLED is at `:310`: a task landing with `Not landed` and a merge check with `Not merged`.
- **Web page:** `src/web/src/components/LandingSessionView.test.tsx`.
  - `:464` READY: the rendered status card has no `.landing-card-line` and no text `Stopped · not landed`.
  - `:479` CANCELLED: the card's one line is `Stopped · not landed`.
- **Swift:** `src/macos/OrbitKit/Tests/OrbitKitTests/LandingSessionPageTests.swift`. READY is at `:704` and CANCELLED at `:714`; the helper is at `:691`.
- **Kotlin model:** `src/android/app/src/test/kotlin/io/orbitd/android/reader/LandingSessionModelTest.kt`. READY is at `:265` and CANCELLED at `:275`; the helper is at `:257`.
- **Kotlin page:** `src/android/app/src/test/kotlin/io/orbitd/android/LandingSessionShellTest.kt`. This is the production shell over the fixture transport.
  - `:243` READY: no `landing:failure` node, and no node with the text `Stopped · not landed`.
  - `:254` CANCELLED: `landing:failure` says `Stopped · not landed`.

**Red checks.** Each one runs the new tests against main's product file. Every READY case fails on main, and every CANCELLED case passes on main and on the branch:
- **Web:** `landingSession.ts` taken from `a4273267a`, then the two changed test files run.
  - 2 of 69 fail: the lib READY case (`expected 'Stopped · not landed' to be null`) and the page READY case (the card's text contains `Stopped · not landed`).
  - The file was put back before the commit.
- **Swift:** a copy of the OrbitKit package (`/mnt/data/rdy-34jTr/okpre`) with this branch's tests and main's `LandingSessionPage.swift` (sha1 matches `a4273267a`), run with `swift test --filter LandingSessionPageTests` in `swift:6.1`.
  - 46 tests ran with 1 failure: `testAMergeCheckThatEndedReadyWritesNoFailureLine`, `XCTAssertNil failed: "Stopped · not landed"` at `:710`.
- **Kotlin:** main's `LandingSessionModel.kt` swapped in, then `:app:testDebugUnitTest --tests` for `LandingSessionModelTest` and `LandingSessionShellTest`, then the file restored in the same job.
  - 55 tests ran with 2 failures: the model's READY case (`expected null, but was:<Stopped · not landed>`) and the page's READY case (the `landing:failure` node exists).
  - Afterwards `git status` shows no change under `src/android`.

## Checks

- **Web vitest, whole suite,** on `77c3aae0c`, whose product code is `1bd5010bf`'s:
  - `TZ=UTC`: 426 files and 5594 tests passed.
  - `TZ=Asia/Shanghai`: the same 426 files and 5594 tests passed.
  - The JSON reports are in `/mnt/data/rdy-34jTr/logs/web-{utc,shanghai}.json`, and all four new web cases (two lib, two page) are among the passed tests.
  - `tsc -p src/web/tsconfig.json` is clean.
- **OrbitKit,** on `1bd5010bf`: 4040 tests, 0 failures, 5 skipped. Both new cases passed. The command is the task's plus a memory cap:

  `docker run --rm --memory=6g -v <worktree>:/src:ro -w /src/src/macos/OrbitKit swift:6.1 swift test --scratch-path /tmp/okbuild`
- **Android** (`:core:test --rerun :app:test --rerun --continue`), on `1bd5010bf`:
  - core 266, app debug 1709 and app release 1709 tests, 0 failures. Every result file was written during the run.
  - The four new cases passed in both variants.
  - Parity tests included, each green in both variants: `LandingSessionCopyParityTest` 3, `SessionLandingsCopyParityTest` 4, `ProjectCopyParityTest` 8, `SessionProjectCopyParityTest` 6, `TaskCopyParityTest` 9 and `SessionLineCopyParityTest` 4, with the other `*ParityTest` and `*CopyTest` classes. In core: `ExceptionCardsTest` 17, `ProjectMergeCopyTest` 15 and `QuestionRecordsParityTest` 4.
- **GitHub `client.yml`,** dispatched on `77c3aae0c` from branch `probe/landing-check-ready-card-gates` (run 39524181481). These all passed:
  - iOS (generate + build);
  - macOS (OrbitKit test and OrbitApp build);
  - Font tokens;
  - Navigation.
- **GitHub Android CI** (`android.yml`: test, lint and debug APK) on the probe commit `938faab50`, run 39524057998: passed in 21m30s. `Verify Android` and the debug APK step were both green.
- **iPhone/Mac probe,** run 39524058101 on probe commit `938faab50`. That commit is `77c3aae0c` with only `.github/workflows/client.yml` replaced by `probe-harness/ci/client.probe.yml`. iPhone ran 2 tests and the Mac 1, with 0 failures (`ios/tests-ios.txt`, `mac/tests-mac.txt`).
- **merge-tree:** `git merge-tree --write-tree origin/main HEAD` is clean against origin/main `a4273267a`, fetched again before this README was written; main had not moved since the base. The commit carrying this README adds only new files under `docs/evidence/landing-check-ready-card/`.
- **Probe branches:** `probe/landing-check-ready-card`, `probe/landing-check-ready-card-results` and `probe/landing-check-ready-card-gates` were deleted from origin after these runs. `git ls-remote origin 'refs/heads/probe/landing-check-ready-card*'` now lists nothing.

## Screenshots

| | Web | iPhone | Mac | Android |
|---|---|---|---|---|
| A merge check that ended READY: no `Stopped · not landed` | `web/light-ready.png`, `web/dark-ready.png` | `ios/ios-1-ready-card.png` | `mac/mac-1-ready-card.png` | `android/light/01-ready-card.png`, `android/dark/01-ready-card.png` |
| A landing the owner stopped (CANCELLED): the line is still there | `web/light-cancelled.png`, `web/dark-cancelled.png` | `ios/ios-2-cancelled-card.png` | — | `android/light/02-cancelled-card.png`, `android/dark/02-cancelled-card.png` |
| A merge to main that answered READY (today's card, unchanged) | `web/light-land-ready.png`, `web/dark-land-ready.png` | — | — | — |

The frames before this fix are in `docs/evidence/landing-page-fixes`: its READY frames show the extra line on every client.

How each frame was checked, beyond the picture:
- **iPhone and Mac, READY.** The probe finds the head's three texts by their exact label (on the Mac, their value) and notes their frames. Then it asks for every element whose label or text value contains `Stopped · not landed`, and finds 0 on both: see `ios/…WritesNoStoppedLine-notes.txt` and `mac/…WritesNoStoppedLine-notes.txt`. The trees are kept too:
  - `ios/ios-1-ready-card-tree.txt` has no `Stopped`.
  - In `mac/mac-1-ready-card-tree.txt`, the head's detail is followed directly by the section title `Merge check · 1`. That tree shortens long values, so the probe's own query is the check.
- **iPhone, CANCELLED.** The page has three `Stopped · not landed` texts. Two are above the timeline's first line: the head's detail and the line under it. The third is the timeline's own result line (notes).
- **Web.** `web/report.json` lists the status card's lines for each frame and theme:
  - `ready`: none;
  - `cancelled`: `Stopped · not landed`;
  - `land-ready`: `Stopped · not landed`.

  No fixture call went unhandled.
- **Android.** For READY, the shot test asserts the head (`Merge check`, `Ready`, `Passed the check · waiting for the owner`), no `landing:failure` node, and no node carrying the text. For CANCELLED, it asserts that `landing:failure` says `Stopped · not landed`. Each frame's semantics tree sits beside it: the READY trees have no `Stopped`, and the CANCELLED trees have the `landing:failure` node.

## Kits

All three come from `docs/evidence/landing-page-fixes`.
- **iPhone and Mac:** `probe-harness/`. It is that task's kit, with:
  - a new stub mode, `cancelled`: a LAND_TASK attempt the owner stopped, with `Stop requested · claim 1` and the server's `Stopped · not landed` result, and the subject still open;
  - its own UI tests, `UITests/LandingReadyCardTests.swift`;
  - its own branches, `probe/landing-check-ready-card` and `-results`.

  Before the run, the stub's `ready` and `cancelled` answers were dumped and decoded with OrbitKit's own models in `swift:6.1`. Both decoded, and the fixed card model drew READY with no failure line and CANCELLED with `Stopped · not landed`.
- **Web:** `web-kit/capture-card.mjs`, from that task's `capture-landing.mjs`. It ran against a `vite build` of `77c3aae0c` into `/mnt/data/rdy-34jTr/web/dist`:

  `FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c 'ip link set lo up && node capture-card.mjs <out>'`
- **Android:** `android-kit/`, compiled into the app's unit tests through `-I android-kit/kit.gradle` and run with `:app:testDebugUnitTest --tests 'io.orbitd.android.LandingReadyCard*'`. The frames are written to `src/android/build/evidence/landing-check-ready-card/`, which git ignores, and copied here.

## Not covered, and found on the way

- **A merge to main that answers READY** keeps `Stopped · not landed` (see above). That is out of scope by the task's own terms.
- **iOS/macOS frames are light only.** Web and Android have light and dark.
- **A cancelled landing says `Stopped · not landed` twice:** on the head's detail line and on the failure line under it. All three clients draw it this way on main. This task keeps that line where it was and changes nothing else on that card.
