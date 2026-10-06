# Cross-project crossings on the iOS and macOS project page

Task: [iOS/macOS 项目页加跨项目确认卡（含移动请求），文案与 Web 一致](orbit-task:34b99rROWy9XZs7gyAr8t),
project [跨项目移动任务：agent 发起，账号所有者确认即生效](orbit-project:34b8pthjtmO06pvd8i3FW), criterion 5.
Branch `orbit/ios-macos-web-857cee`: the card in `4dddff557`; main merged up to `30cf89786` (which brought the task
page's own MOVE_TASK words, `TaskDetailCopy.moveTaskStateMeaning`), after which the card reads that one map
(`2d746caee`). Everything below was checked on `2d746caee`. Executed on HPC (Linux), no local Mac: OrbitKit ran in
`swift:6.1` docker; the macOS and iOS builds, the XCUITests and the pictures ran on GitHub Actions through
push-triggered probe branches (never merged, deleted afterwards).

## What the clients do now

- **The card.** The project page (`ProjectDetailView`, the one page the Mac, the iPad and the iPhone's
  compact shell all draw) reads `GET /projects/:id/handoffs` beside its other reads and, when the project is
  an end of any crossing, draws "Cross-project crossings · N waiting" last — where the web draws it. Same
  scope as the web card: FILE_TASK, DEPEND_ON_TASK and MOVE_TASK, both directions, questions first (oldest
  first), then answered rows (newest first).
- **A row.** The server's state as a chip, its word ("Waiting for your answer"), the kind; for a move "Task
  to move: <title now> <id>", otherwise the row's title; both projects by title, id and status; what the
  state means for that kind (a move's own words: "the task stays in its project until you answer, and
  confirming moves it"); for a move the target criterion requested and the source criterion it serves now
  ("Confirming the move withdraws this declaration."); "Reason given: …".
- **Two presses.** Only a PENDING row offers them. Approve… / Refuse… only ask; the second step names the
  subject and both projects ("Approve moving “…” from A to B?"), says the consequence (a move: "Confirming is
  the move: the task joins the target project as soon as you answer, and nobody has to send the request
  again."), shows the crossing key, and Yes, approve / Yes, refuse sends
  `POST /projects/:id/handoffs/:handoffId/decision` with `{decision, acknowledgedCrossingKey}` — the door at
  which the server moves the task and spends the request. One question open at a time.
- **A refusal.** The second step stays open under "That answer was not recorded", the server's code and its
  reason (e.g. `MOVE_TASK_LANDING_IN_FLIGHT … the request is still waiting`).
- **Words.** `ProjectCrossings` (OrbitKit) holds every sentence — the state words shared with the task page's
  attribution card (`TaskDetailCopy`); `ProjectCrossingsCardCopyParityTests` reads
  `src/web/src/components/ProjectCrossingsCard.tsx` and `src/web/src/lib/attribution.ts` and compares each one
  whole (a missing file is a failure, never a skip).

## Pictures (real app UI, XCUITest on CI against `stub.py`, run 37516956540 on `2d746caee`)

The probe builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the shared sources,
pointed at a stub serving project P1 "Runner hardening" with five crossings: X1 a move of "Wire the drain
watchdog" in from a DONE project, X2 a move out whose task is being landed, X3 a filing, X4/X5 answered.
`CrossingsShotTests` drives the real controls; each platform's `writes.txt` shows what the app sent.

| Step | iPhone (`ios/`) | Mac (`mac/`) |
|---|---|---|
| the card: the MOVE_TASK row, PENDING | `ios-1-move-request.png` | `mac-1-move-request.png` |
| Approve… → the second step (both projects, consequence, crossing key) | `ios-2-second-step.png` | `mac-2-second-step.png` |
| Yes, approve → read back APPLIED, "the task was moved when this request was confirmed"; header 3 → 4 tasks | `ios-3-moved.png` | `mac-3-moved.png` |
| the move out confirmed → refused: code and reason, second step still open | `ios-4-refused.png` | `mac-4-refused.png` |
| Refuse… → the refusal's second step (cancelled, nothing sent) | `ios-5-refuse-step.png` | `mac-5-refuse-step.png` |

What the apps sent (`ios/writes.txt`, `mac/writes.txt`): one
`POST /api/projects/P1/handoffs/X1/decision` with `"decision":"APPROVE"` and `"acknowledgedCrossingKey":"8f3c1d2e…"`
→ 201, one for X2 → 409 `MOVE_TASK_LANDING_IN_FLIGHT`, no DENY. (The two keys' order in the body varies with
Foundation's encoder.) The same flow passed on `4dddff557` too (runs 37505299361, 37509553027).

## Checks on `2d746caee`

| Check | Result |
|---|---|
| OrbitKit, Linux `swift:6.1` docker | 3230 tests; the 32 new ones (`ProjectCrossings*`) and the project-page and task-page suites pass; 12 failures in 6 tests — identical on clean main `30cf89786` (3198 tests, the same 12): `ci/orbitkit-linux-swift61.txt` (with the earlier runs on `4dddff557`/`51f0cdfee` and `7e8bad80c`/`be0f8c22a`) |
| client.yml, run 37516956540 | font-tokens ✓, nav-push ✓, iOS build ✓ (`** BUILD SUCCEEDED **`), macOS OrbitApp `swift build` ✓ (`Build complete!`); macOS OrbitKit `swift test` ✗ with exactly the 12 failures the same step has on clean main `30cf89786` in the same run (the baseline job reports success because its step only records; `ci/baseline-out-outcomes.txt` says failure): `ci/` |
| XCUITest, iPhone simulator + Mac | both `** TEST SUCCEEDED **`: `ios/`, `mac/` |
| merge check, the exact command | exit 0 — shared 398, apiserver 4551, web 4293, go ok: `ci/merge-check.txt` (with the earlier step-by-step runs on `4dddff557` and clean `51f0cdfee`, and two runs on `54146166e` whose go step failed on a timing flake and on a full host disk) |

The tests red on main — `ConfirmationStyleWiringTests.testEveryConfirmationAsksThroughTheWidthAwareStyle` (the
access-token revoke dialogs in `SettingsAdminView.swift` and `SettingsSheet.swift` call `.confirmationDialog`
directly), `WikiCopyParityTests.testTheDrawerRowCountsWhatTheWebSidebarCounts` (the web sidebar's wiki count moved),
and three more `WikiCopyParityTests`, one `WikiPlanCopyParityTests` and one `WikiReviewModeCopyParityTests` (the web
wiki home's topic list) — came with other projects' merges (`90b80b42f`, `6c4e0ac0e`, `2f9cc095f`) and are not
touched here.

## Limits

- The pictures are against a stub, not a running apiserver: they show the app's own UI and the request it
  sends. That this door moves the task is the server's (`ProjectHandoffService.decide` →
  `TasksService.applyMoveApproval`, already on main) and is not re-tested here; `src/apiserver` is unchanged.
  The stub answers the way the door does (key fence, PENDING only, a confirmed move spent as APPLIED).
- The card is the page's last section, as on the web, so on a long project it is reached by scrolling.
- The CI Mac's display is 1024 points wide; the Mac pictures fold the source list away to fit the window.
