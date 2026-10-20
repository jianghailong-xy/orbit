# Landing-session follow-up: web, iOS/macOS and Android

Task `34jBwFmcEPK012TsNL0Lc`. Branch `orbit/task-earlier-round-n-of-m-05d764`, based on origin/main `868fc13b6`, which carries contract revision 25 (erratum 3). The design references are the owner-approved boards `docs/mocks/landing-session/v4/` (04–07) and `/var/tmp/landing-session/decisions-2026-10-18.md`.

Two scope questions went to the creating coordinator session `34ZyHoLsfDlMhp5cstme6`. Both answers are recorded as task comments:
- **Item 5, decision A** (request `34jFLwpFTsECc4dkq9bUz`). The timeline's ROUND line is written by the server, so `roundText(round, kind)` is fixed there. The 3 is one shared TypeScript constant (contract J5); Swift and Kotlin each keep their own. Stored rows keep `Round N`; there is no backfill.
- **Item 1, decision B** (request `34jHv4mHyCy5tiUqHoa28`):
  - A count above 0 gives `Earlier · …` with only the non-zero segments.
  - Both counts 0 with older rows gives a bare `Earlier` fold, which opens onto them.
  - Nothing older gives no fold.
  - The counts still name only landed and nothing-to-land, so a mixed fold (for example `Earlier · 2 landed` over five rows) understates, as it did on main. No new words were added for the other kinds.

## Commits

| Item | Commits | What it does |
|---|---|---|
| 1 | `201de54b6`, `b04cb9390` | The Earlier fold leaves out a zero segment. When both counts are 0 and older landings exist (handled, cancelled, declined, deleted…), the fold is a bare `Earlier` that opens onto them. Nothing older means no fold. The gate is main's own; only the line builder changed. |
| 2 | `9a9282425`, `a04ae5ed5` | A Landing card whose single job is a merge job (CHECK_PROMOTION or LAND_PROMOTION) no longer writes "Nothing to do — it lands on its own.". The flag needs the counts to say one job, so an older server counting two jobs keeps the sentence. |
| 3 | `b1dd78b5c` | The timeline's ✓/✗ and the inline-output gate read each entry's `kind` and `data`: for CHECK_FINISHED `exitCode`/`expectedExitCode`/`timedOut`, for RESULT and RESULT_FALLBACK `state`. They no longer read the sentence. Swift and Kotlin now decode `data`. |
| 4 | `322296430` | The merge card's Re-run the check sends `Re-run the timed-out check from the merge card.`. Swift adds `LandingPageCopy.rerunCheckReason`, and `APIClient.rerunPromotionCheck(…, reason:)` now requires the reason. Kotlin adds `LandingSessionCopy.RERUN_CHECK_REASON`. The landing page still sends its own sentence. |
| 5 | `55e71ebe5`, `6a66985b5`, `1842b6409` | `round N of M` takes M from the job kind: LAND_TASK `round N of 3`, CHECK_PROMOTION and LAND_PROMOTION `round N`. The rule is applied on every surface (table below). The server writes the timeline's ROUND line with `roundText(round, kind)`. |
| 6 | `32d9edeb5` | The Android source-session label draws a static `ic_sync` ring before the text while the landing runs (tone `run`), as web and iOS do. |
| 7 | `e7a7407c1`, `35054df51` | The iOS/macOS landing page's status-card Abandon is `.bordered` + `.tint(.red)` + `role: .destructive`: board 05's light red wash with a red word. On macOS the label is red. The X-E5 card's solid lead Abandon is untouched. |
| 8 | `3e1a032d3` | Android `LandingSessionViewTest` writes to `src/android/build/evidence/landing-session-android/<theme>/`. It writes `docs/evidence/landing-session-android/` only with `ORBIT_WRITE_EVIDENCE=1`. |
| — | `afe4bde64` | OrbitKit pins on the OrbitApp sources Linux cannot compile: each Re-run door's sentence, and the timeline marks reading `checkPassed`/`succeeded`. `35054df51` adds the Abandon tint and the Landing card's sentence gate. |
| — | `25638c231`, `e4259af81`, `3dd4f3365`, `95552877f`, `301431db4` | The screenshot kits used below, and this evidence. |

## Files changed (`git diff --stat 868fc13b6..3dd4f3365 -- src`: 56 files)

- **Web:**
  - `src/web/src/lib/sessionProjects.ts`, `landingSession.ts`.
  - `src/web/src/components/ProjectPanoramaHeader.tsx`, `ProjectLandingCard.tsx`, `LandingSessionView.tsx`, `ProjectProgressStatus.tsx`.
  - Their tests: `sessionProjects.test.ts`, `landingSession.test.ts`, `ProjectPanoramaHeader.test.tsx`, `LandingSessionView.test.tsx`, `ProjectProgressStatus.test.tsx`, `WorkspaceView.projectSessions.test.tsx`.
- **Shared:** `src/shared/src/project-progress.ts` (`LAND_TASK_ROUNDS_PER_CLAIM`).
- **Server:**
  - `src/apiserver/src/projects/project-integration-event.ts`, `runner-api/integration-job-relay.ts`, `projects/open-item-escalation.service.ts` (a comment only).
  - Specs: `project-integration-event.spec.ts` (new), `project-integration-event.pg.spec.ts`, `landing-lease-expired.pg.spec.ts` (a comment only).
- **OrbitKit:**
  - `App/SessionProjectLandings.swift`, `App/ProjectPage.swift`, `App/LandingSessionPage.swift`, `App/OwnerItemCards.swift`, `Models/LandingSession.swift`, `Net/APIClient.swift`.
  - Tests: `LandingCopyParityTests`, `SessionProjectLandingsTests`, `ProjectLandingCardTests`, `LandingEntranceTests`, `LandingSessionPageTests`, `LandingSessionDecodingTests`, `ProjectLandingHeadTests`, `LandingRerunDoorTests`, `LandingViewsWiringTests`.
- **OrbitApp:** `AppModel.swift`, `Views/LandingSessionPageView.swift`, `Views/ProjectLandingCard.swift`, `Views/SessionProjectPage.swift`.
- **Android:**
  - app: `directory/SessionProjectLandings.kt`, `directory/SessionProjectPage.kt`, `projects/ProjectPage.kt`, `projects/ProjectLanding.kt`, `reader/LandingSessionModel.kt`, `reader/LandingSessionPage.kt`, `reader/SessionReader.kt`.
  - core: `cards/ExceptionCards.kt`.
  - Tests: `SessionLandingsCopyParityTest`, `LandingEntriesShellTest`, `LandingEntriesShotsTest`, `LandingSessionShellTest`, `ProjectLandingCardTest`, `ProjectLandingCardViewTest`, `ProjectPageTest`, `LandingSessionModelTest`, `LandingSessionViewTest`, core `ExceptionCardsTest`.

**Commit rules.**
- Every commit that changes or removes a Swift literal also changes `src/android` in the same commit: `322296430`, `201de54b6`, `b1dd78b5c`, `55e71ebe5`, `b04cb9390`.
- Commits touching Swift without Android change only button styles and tests: `e7a7407c1`, `35054df51`, `afe4bde64`, `6a66985b5`, `a04ae5ed5` (the last also changes Android).
- Every web line that OrbitKit pins changed in the same commit as its pin: `201de54b6` and `b04cb9390` (sessionProjects.ts); `55e71ebe5` (ProjectProgressStatus.tsx's round line, plus the shared constant).
- Kotlin ⊆ Swift for the new strings:
  - `RERUN_CHECK_REASON` is covered by `LandingSessionCopyParityTest.everyWordIsTheSwifts`.
  - The fold line and the gate by `SessionLandingsCopyParityTest.kt:39`, `:70`, `:96`.
  - `landTaskRoundsPerClaim` is pinned to the Swift source by `ExceptionCardsTest.kt:409`.
- `git merge-tree --write-tree` of the tip against origin/main `4f5c3b766` (fetched 2026-10-20 17:1x UTC) is clean. The two commits main gained since the base (`01415e5e2`, `4f5c3b766`) touch only model routing and the Go Codex runner, none of this branch's files. The server cleanup task `34jBwFldsZVGXcU3hPS6A`, which also edits `integration-job-relay.ts`, has not landed.

## Tests per item (file:line at `3dd4f3365`)

- **1 Earlier.**
  - Web: `src/web/src/lib/sessionProjects.test.ts:374` (zero segment), `:392` (bare fold over CANCELLED/HANDLED/DECLINED, opening to them), `:415` (nothing older); `src/web/src/components/WorkspaceView.projectSessions.test.tsx:1366`, `:1383` (the bare fold is clicked open and its rows are drawn), `:1408`, `:1426`.
  - Swift: `src/macos/OrbitKit/Tests/OrbitKitTests/SessionProjectLandingsTests.swift:81`, `:99`, `:125`; the web pins are in `LandingCopyParityTests.swift:190`, `:203`.
  - Kotlin: `src/android/app/src/test/kotlin/io/orbitd/android/LandingEntriesShellTest.kt:255`, `:269` (the bare fold, clicked open), `:285`, `:295`; `directory/SessionLandingsCopyParityTest.kt:96`.
- **2 Merge-job card.**
  - Web: `src/web/src/components/ProjectPanoramaHeader.test.tsx:531` (DOM: both merge kinds, an older server, and an older server counting two jobs), `:590`, `:1215`.
  - Swift: `ProjectLandingCardTests.swift:173`, `LandingEntranceTests.swift:129`, `LandingViewsWiringTests.swift:82` (the OrbitApp card reads the flag).
  - Kotlin: `projects/ProjectLandingCardTest.kt:133`, `projects/ProjectLandingCardViewTest.kt:191`.
- **3 ✓ rule** (each platform has a case where the wording changed and the ✓ did not).
  - Web: `src/web/src/lib/landingSession.test.ts:568`–`:618`, `src/web/src/components/LandingSessionView.test.tsx:363`.
  - Swift: `LandingSessionPageTests.swift:712`, `:723`, `:737`, `:748`; `LandingSessionDecodingTests.swift:98`; `LandingViewsWiringTests.swift:172` (the OrbitApp view).
  - Kotlin: `reader/LandingSessionModelTest.kt:343`, `:354`, `:367`, `:378`; `LandingSessionShellTest.kt:207`.
- **4 Re-run reason.**
  - Web: `LandingJobsSheet.test.tsx:598` (merge card), `LandingSessionView.test.tsx:534` (landing page).
  - Swift: `LandingRerunDoorTests.swift:115`; `LandingViewsWiringTests.swift:158` (the merge card and the landing page each pass their own sentence); `LandingCopyParityTests.swift:313` (pinned against web `RERUN_CHECK_REASON`).
  - Kotlin: `LandingEntriesShellTest.kt:146` (merge card request body), `LandingSessionShellTest.kt:153` (landing page).
- **5 round N of M.** See the table below.
- **6 Android ring.** `LandingEntriesShotsTest.kt:200` (the ring for a running label; none for landed or failed) and `LandingEntriesShellTest.kt:308`.
- **7 iOS Abandon.** `LandingViewsWiringTests.swift:59` (`.bordered` with `.tint(.red)`, not `.borderedProminent`). `ExceptionCardsWiringTests.swift:308` still pins the X-E5 card's solid lead.
- **8 Android shots.** The switch is at `LandingSessionViewTest.kt:253`.
  - Every plain Android run left `git status docs/evidence/landing-session-android` empty.
  - An `ORBIT_WRITE_EVIDENCE=1` run of the two classes changed 32 files there (per `git status`). They were restored with `git checkout`.

### Round rule, surface by platform

| Surface | Web | Swift | Kotlin |
|---|---|---|---|
| status card | `landingSession.test.ts:245` | `LandingSessionPageTests.swift:208` | `LandingSessionModelTest.kt:197` |
| timed-out claim line | `landingSession.test.ts:362`, `:367`, `:369`; `LandingSessionView.test.tsx:487` | `LandingSessionPageTests.swift:386` | `LandingSessionModelTest.kt:490` |
| landing head (Landing card, project row, jobs sheet, Work overview) | `ProjectPanoramaHeader.test.tsx:1065`, `:1084` | `ProjectLandingHeadTests.swift:194`, `:206` | `ProjectPageTest.kt:367` |
| X-E5 Step row | `ProjectProgressStatus.test.tsx:1696` | `SessionProjectLandingsTests.swift:287` | core `ExceptionCardsTest.kt:208` |
| timeline ROUND line | written by the server: `integration-job-relay.ts:1118` calls `roundText(round, input.before.kind)`; `project-integration-event.spec.ts:14`, `:20`, `:25`; `project-integration-event.pg.spec.ts:574` (`Round 1 of 3`), `:1103` (`Round 2 of 3`), `:1158` (`Round 1`, CHECK_PROMOTION) | same server line | same server line |

All three clients draw the server's `text` as is (web `LandingSessionView.test.tsx:302`, Swift `LandingSessionPageView.swift:418`, Kotlin `LandingSessionShellTest.kt:192`), so the timeline lines in the screenshots below are what the kits serve: a copy of what the server now writes. The constants: `LAND_TASK_ROUNDS_PER_CLAIM` in `src/shared/src/project-progress.ts:237`, imported by apiserver and web; `ProjectPage.landTaskRoundsPerClaim` in OrbitKit `ProjectPage.swift:291`; `ExceptionCards.landTaskRoundsPerClaim` in Android core `ExceptionCards.kt:353`. Each cites contract J5 and §7.2 V6 and is pinned across (`LandingCopyParityTests.swift:322`, `ExceptionCardsTest.kt:409`).

## Checks on the tip `3dd4f3365`

Everything after `3dd4f3365` touches only `docs/evidence/landing-session-followup/`: `95552877f` and `301431db4` change the probe's UI test, and the last commit adds this evidence.


- web vitest, whole suite: 426 files and 5588 tests passed, under both `TZ=UTC` and `TZ=Asia/Shanghai`. `tsc` for shared and web is clean.
- OrbitKit (`swift:6.1` docker, worktree mounted read-only): 4025 tests, 0 failures, 5 skipped. The same 5 are skipped on main.
- Android `:core:test :app:test`, debug and release, with the evidence kit compiled in: core 266, app debug 1722, app release 1722 tests, 0 failures. That includes `ProjectCopyParityTest` 8, `SessionProjectCopyParityTest` 6, `TaskCopyParityTest` 9, `ExceptionCardsTest` 17, `LandingSessionCopyParityTest` 3, `SessionLandingsCopyParityTest` 4, and the kit's 24 frames.
- apiserver unit tests (`npm test`): 5379 of 5379.
- pg specs (`scripts/run-pg-spec.sh`). The server code has not changed since `1842b6409`.
  - Clean main: `project-integration-event`, `landing-session`, `landing-lease-expired`, `integration-job-log`, `integration-job-release` and `integration-abandon` pass 70/70.
  - Branch: `project-integration-event` 12/12 (one new case), `landing-lease-expired` 23/23. The other four matched main on `55e71ebe5`.
- GitHub `client.yml` dispatched on `3dd4f3365` (run 39461160439): macOS build + test, iOS build, font-token and navigation gates all passed.
- GitHub Android CI (`android.yml`: unit tests + lint + debug APK) on `3dd4f3365` (run 39461141494): passed. It also passed on the probe commit `1a90254b0` (run 39461134330) and earlier on `f42a24b37` (run 39451279397).

## Screenshots, against v4

`boards/` holds the v4 frames these screenshots compare with, cropped by `boards/crop.mjs` (by each frame's own words, or by its CSS class: `.chip4.run` for 06 e, `.cap4.red` for 05's light Abandon):
- `04-c1-earlier-ios.png`, `04-c1-earlier-web.png`: the Earlier row.
- `04-task-card-*.png`: the task card, the only card drawn with the sentence.
- `04-merge-check-row-*.png`: a merge job's head, which has no body.
- `05-abandon-light-*.png`, `05-abandon-web.png`: the status card's light Abandon.
- `05-round-*.png`: `round 1 of 3`.
- `06-c-xe5-*.png`: the X-E5 card.
- `06-e-source-label.png`: the source label's ring.
- `07-*.png`: Android.

v4 has no Work-overview frame of a lone merge job: board 04 only says the Work overview draws "the same card (merge jobs included)". The merge-job card is therefore compared with the merge job's head anatomy in `04-merge-check-row-*`.

Where a narrow head truncates its line (the web sessions page column, `landing-card-task` and `merge-check`; Android `07-card-task`; iPhone `ios-04-b1-card-task`, `ios-04-b4-merge-check`), the full text is in the frame's report or semantics file: `web/report-entries.json` `landingHeadDetail`, `android/*/07-card-task-semantics.txt`, and the probe's XCUITest assertions. The round line is fully visible in the Work overview, landing page and X-E5 frames.

### Web (the built console over the `ui-migration` fixtures; `web-kit/run.sh`, on `3dd4f3365`)

`web/<theme>-<frame>.png` covers the project sessions page, the project page and the coordinator conversation. `web/landing-<theme>-<frame>.png` covers the landing session page. `web/report-*.json` holds the words each frame drew. `web/before/` is the same kit on unchanged main; its Work overview frames come from a clean `868fc13b6` checkout (`report-overview.json`).

| Frame | Shows | Main drew | v4 |
|---|---|---|---|
| `earlier-both` / `earlier-landed` / `earlier-nothing` | `Earlier · 5 landed · 1 nothing to land` / `Earlier · 6 landed` / `Earlier · 2 nothing to land` | `Earlier · 6 landed · 0 nothing to land` (`before/light-earlier-landed.png`) | 04 c1 |
| `earlier-bare`, `earlier-bare-open` | a bare `Earlier` over cancelled, handled and declined landings, closed, then open with those three rows listed | `Earlier · 0 landed · 0 nothing to land` | 04 c1 |
| `earlier-none` | nothing older: no fold | — | 04 c1 |
| `overview-merge-check`, `overview-merge-to-main` | the Work overview card for a lone merge job: head `claim 1 · round 1` and foot, no sentence | `Nothing to do — it lands on its own.` and `round 1 of 1` (`before/light-overview-merge-*.png`) | 04 (`04-merge-check-row-*`) |
| `overview-task`, `landing-card-task` | a LAND_TASK keeps the sentence; head `claim 1 · round 1 of 3` with one check in the run | `round 1 of 1` (`before/light-overview-task.png`) | 04 b1 (`04-task-card-*`) |
| `merge-check` | the merge check row's head: `… · claim 1 · round 1` (see the report) | `round 1 of 1` | 04 b4 |
| `chat-xe5`, `chat-xe5-check` | X-E5 Step row `rebasing · claim 1 · round 1 of 3` (LAND_TASK, check count 1) and `checking · claim 1 · round 1` (CHECK_PROMOTION) | `round 1 of 1` (`before/light-chat-xe5.png`) | 06 c |
| `landing-*-a-live`, `landing-*-i-timeout` | LAND_TASK status card and claim line `round 1 of 3`; timeline `Round 1 of 3`; in i-timeout, Retry solid and Abandon the outlined danger secondary | — | 05 a, 05 i |
| `landing-*-d-merge`, `landing-*-e-check-timeout` | LAND_PROMOTION / CHECK_PROMOTION `round 1`, timeline `Round 1`; Re-run the check plus the outlined Abandon | `round 1 of 1` (`before/landing-light-e-check-timeout.png`) | 05 e (`05-abandon-web.png`) |
| `landing-*-f-marks` | reworded lines keep their marks: `Task acceptance passed its first half · exit 1` ✗ with its output inline, `Merge check green` ✓, `Put on project/p1` (LANDED) ✓. The old text rule drew the opposite on all three | — | 05 |
| `landing-*-c-merged` | the merged round's ✓ lines, read from their data | — | 05 c |
| `source-session` | web's ring in the source label, the reference for Android's | — | 06 e (`06-e-source-label.png`) |

### Android (Robolectric NATIVE: `android-kit/` and the repo's `LandingSessionViewTest`, on `3dd4f3365`)

`android/<theme>/`, light and dark, each frame beside its semantics tree:

| Frame | Shows | v4 |
|---|---|---|
| `01-earlier-landed`, `02-earlier-nothing`, `03-earlier-both` | `Earlier · 1 landed` / `Earlier · 1 nothing to land` / both | 07 (`07-earlier.png`) |
| `04-earlier-bare`, `04-earlier-bare-open`, `04-earlier-empty` | the bare `Earlier` fold, closed, then open onto Cancelled, Handled and Declined; and no fold with nothing older | 07 |
| `05-card-merge-check`, `06-card-merge-to-main`, `07-card-task` | the Landing card: a lone merge job has no sentence and reads `claim 1 · round 1`; a task keeps the sentence and reads `round 1 of 3` (cut off in the picture, full in `07-card-task-semantics.txt`) | 07 / 04 |
| `08-xe5-task`, `09-xe5-check` | X-E5 Step row `rebasing · claim 1 · round 1 of 3` and `checking · claim 1 · round 1`; Abandon is still the solid lead door | 07 (`07-round-*`), 06 c |
| `10-source-label` | the source label with its ring | 06 e (`06-e-source-label.png`) |
| `11-timeline-marks` | reworded lines keep their marks (✗, ✓, ✓; the test asserts each one) | 05 |
| `landing-page-01-checking`, `-02-timed-out-land-task`, `-03-timed-out-merge-to-main`, `-08-merge-checking` | the landing page's round lines: LAND_TASK `round 1 of 3`, the two merge kinds `round 1` (in the semantics files) | 07 / 05 |

### iOS and macOS (probe on GitHub macOS runners; `probe-harness/`)

Run 39473732186 on GitHub's macOS runner built both probe apps from the real OrbitApp and iOS sources. It ran on probe commit `ab433e7f7`, which is the branch's `301431db4` with only `.github/workflows/client.yml` swapped for `probe-harness/ci/client.probe.yml`; the product code is that of `3dd4f3365`. 11 iPhone and 6 Mac tests ran, 0 failures; `native-tests.txt` has every test case line. The results branch `probe/landing-session-followup-results` holds the pictures and xcodebuild logs, and they are copied to `ios/` and `mac/`.

Earlier runs, for the record:
- 39451279393: the zero-count check matched the progress card's "· 0 running" (fixed in `e4259af81`).
- 39455746907: all green, on code before the Abandon tint and decision B.
- 39461134279 and 39465901820: the bare fold was pressed at its button's centre, which does not open it (see below).
- 39465901820's first attempt got no macOS runner.

| Frame | Shows | v4 |
|---|---|---|
| `ios-04-earlier-nothing`, `ios-04-earlier-landed`, `ios-04-earlier-both` | `Earlier · 1 nothing to land` / `Earlier · 1 landed` / both; the XCUITest also asserts no `0 landed` / `0 nothing to land` | 04 c1 (`04-c1-earlier-ios.png`) |
| `ios-04-earlier-bare`, `ios-04-earlier-bare-open` | the bare `Earlier` fold over a cancelled, a handled and a declined landing; pressed, it lists all three | 04 c1 |
| `ios-04-earlier-empty` | nothing older: no fold | 04 c1 |
| `ios-04-b1-card-task`, `ios-04-b4-merge-check` | the sessions page heads: LAND_TASK `round 1 of 3` (asserted; the picture cuts it), the merge check with no `of` (asserted) | 04 b1, b4 |
| `mac-04-overview-merge-check`, `mac-04-overview-merge-to-main` | the Work overview's Landing card for a lone merge job: `claim 1 · round 1`, no "Nothing to do" (both asserted) | 04 (`04-merge-check-row-*`) |
| `mac-04-overview-task` | a LAND_TASK's card keeps the sentence and reads `round 1 of 3` | 04 b1 |
| `ios-05-i-task-timeout`, `ios-05-i-task-timeline`, `mac-05-i-task-timeout` | LAND_TASK claim line `claim 1 · round 1 of 3` and timeline `Round 1 of 3`; Retry solid, Abandon the light red secondary | 05 i (`05-abandon-light-*`, `05-round-*`) |
| `ios-05-e-check-timeout`, `mac-05-e-check-timeout`, `ios-05-a-live` | CHECK_PROMOTION `claim 1 · round 1` and timeline `Round 1`; Re-run the check solid, Abandon light red | 05 e |
| `ios-05-marks`, `mac-05-marks` | reworded lines keep their marks: ✗ for `…passed its first half · exit 1`, ✓ for `Merge check green` and for `Put on project/P1` | 05 |
| `ios-06-xe5-check`, `ios-06-xe5-task` | X-E5 Step row `checking · claim 1 · round 1` and `rebasing · claim 1 · round 1 of 3`; Abandon is still the solid lead door | 06 c (`06-c-xe5-*`) |
| `ios-06-source-label` | iOS's ring in the source label, the reference for Android's | 06 e (`06-e-source-label.png`) |

**Abandon, measured.** The pill's dominant fill on the amber card:

| Picture | Fill |
|---|---|
| board 05's `cap4.red` (`boards/05-abandon-light-b.png`) | (255,224,215) |
| iPhone, `ios-05-e-check-timeout` | (255,212,206) |
| Mac, `mac-05-e-check-timeout` | (248,229,220) |
| iPhone before the tint (`.bordered` + destructive role only, run 39455746907) | grey (233,226,220) |

**Two iOS/macOS behaviours this run brought out. Both exist on main, and this task does not change them:**
- **The Earlier fold opens only when its words are pressed.** The fold (`SessionProjectPage.swift`, unchanged here) is a plain-style button whose label is an HStack with a Spacer between the word and the chevron. A plain button answers only where it draws, so a press on the empty middle of the row does nothing; that is why the probe now presses the word. Under decision B the bare fold is the only way to the uncounted older rows, so this matters more than before.
- **A failed check's inline output never loads.** `LandingInlineOutput` in `LandingSessionPageView.swift` hangs its `.task` on a `Group` whose only child is `if !lines.isEmpty`. That view draws nothing until it has lines, its task never runs, and no log read is made: the `marks` mode shows no `/landing/log` request in `ios/requests.log`. So on iOS and macOS, unlike web and Android, a failed check shows `Log ›` but no tail inline. The gate in front of it now reads `checkPassed`.

## Not covered by this evidence

- The contract's §7.2 V6 现状 note (the three clients write the check count after `of`) describes main before this branch. This task does not edit the contract.
- Committed frames of earlier tasks (`docs/evidence/landing-session-android/`, `landing-entries-android/`, `landing-session-native/`) still show the old behaviour. They are kept as history. Item 8 means a plain test run no longer rewrites the first of them.
- On web the closed fold always wears the green ✓ mark, also over a bare fold of cancelled rows (iOS and Android draw it neutral grey). This is the fold's existing affordance, which decision B keeps.
- iOS/macOS frames are light only.
- The two iOS/macOS behaviours above (the fold's hit area, the inline output that never loads) predate this branch and are offered as a follow-up task.
- The kits depend on this host: `web-kit/run.sh` uses `/mnt/data/pe-mock/fonts.conf`, and the local test logs are under `/mnt/data/lsf-34jBw/logs`. The CI runs above are the durable records.
