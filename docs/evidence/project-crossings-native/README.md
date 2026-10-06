# Cross-project crossings on the iOS and macOS project page

Task: [iOS/macOS 项目页加跨项目确认卡（含移动请求），文案与 Web 一致](orbit-task:34b99rROWy9XZs7gyAr8t),
project [跨项目移动任务：agent 发起，账号所有者确认即生效](orbit-project:34b8pthjtmO06pvd8i3FW), criterion 5.
Branch `orbit/ios-macos-web-857cee`, code commit `4dddff557` on main `51f0cdfee`, then main `be0f8c22a` merged (`7e8bad80c`). Executed on HPC (Linux),
no local Mac: OrbitKit ran in `swift:6.1` docker; the macOS and iOS builds, the XCUITests and the pictures
ran on GitHub Actions through push-triggered probe branches (never merged, deleted afterwards).

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
- **Words.** `ProjectCrossings` (OrbitKit) holds every sentence; `ProjectCrossingsCardCopyParityTests` reads
  `src/web/src/components/ProjectCrossingsCard.tsx` and `src/web/src/lib/attribution.ts` and compares each
  one whole (a missing file is a failure, never a skip).

## Pictures (real app UI, XCUITest on CI against `stub.py`)

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
`POST /api/projects/P1/handoffs/X1/decision {"decision":"APPROVE","acknowledgedCrossingKey":"8f3c1d2e…"}` → 201,
one for X2 → 409 `MOVE_TASK_LANDING_IN_FLIGHT`, no DENY.

## Checks

| Check | Result |
|---|---|
| OrbitKit, Linux `swift:6.1` docker, `4dddff557` | 3228 tests; the 32 new ones (`ProjectCrossings*`) pass; 5 failures in 2 tests — identical on clean main `51f0cdfee` (3196 tests, same 5): `ci/orbitkit-linux-swift61.txt` |
| OrbitKit, same, after merging the newer main `be0f8c22a` (`7e8bad80c`) | 3228 tests; the new ones pass; 12 failures in 6 tests — identical on clean main `be0f8c22a` (3196 tests, same 12; its wiki home change broke four more wiki parity tests): same file |
| client.yml on the probe of `4dddff557` (run 37505299361) | font-tokens ✓, nav-push ✓, iOS build ✓ (`** BUILD SUCCEEDED **`), macOS OrbitApp `swift build` ✓; macOS OrbitKit `swift test` ✗ with the same 2 tests (5 failures) as the same step on clean main in the same run: `ci/` |
| XCUITest, iPhone simulator + Mac | both `** TEST SUCCEEDED **`: `ios/`, `mac/` (run 37509553027) |
| native sources after merging `be0f8c22a` | `git diff 4dddff557 7e8bad80c -- src/macos src/ios` is empty, and the web card and `attribution.ts` are unchanged: the CI runs above built the same native code |
| merge check, each step | `4dddff557` and clean main `51f0cdfee`: build, shared (398), apiserver (4545), web (4255), go — all exit 0: `ci/merge-check.txt` |

The tests red on main — `ConfirmationStyleWiringTests.testEveryConfirmationAsksThroughTheWidthAwareStyle`
(the access-token revoke dialogs in `SettingsAdminView.swift` and `SettingsSheet.swift` call `.confirmationDialog` directly),
`WikiCopyParityTests.testTheDrawerRowCountsWhatTheWebSidebarCounts` (the web sidebar's wiki count moved), and since
`be0f8c22a` three more `WikiCopyParityTests`, one `WikiPlanCopyParityTests` and one `WikiReviewModeCopyParityTests` (the
web wiki home's topic list, `2f9cc095f`) — came with other projects' merges (`90b80b42f`, `6c4e0ac0e`, `2f9cc095f`)
and are not touched here.

## Limits

- The pictures are against a stub, not a running apiserver: they show the app's own UI and the request it
  sends. That this door moves the task is the server's (`ProjectHandoffService.decide` →
  `TasksService.applyMoveApproval`, already on main) and is not re-tested here; `src/apiserver` is unchanged.
  The stub answers the way the door does (key fence, PENDING only, a confirmed move spent as APPLIED).
- The card is the page's last section, as on the web, so on a long project it is reached by scrolling.
- The CI Mac's display is 1024 points wide; the Mac pictures fold the source list away to fit the window.
