# A11 Tasks — implementation against the iOS baseline

This maps the pinned iOS Tasks pages to the Android implementation. It is a source correspondence plus controlled-fixture and emulator results, **not** a same-account cross-client acceptance. Pinned input: A07 `51bbcc303cec3c64dfb217316afce9498add760d`, absorbed by the ordinary merge `b075423118dacfb0a3c90c36b9f1aacad1feffd4`; the route-only commit is `cfe49df7a`. Android inherits A03 auth (`AuthSession`/`SessionHandle`), A04 real-time state (`RealtimeStore`, invalidation revision), A05 navigation (`OrbitRoute`/`OrbitNavigation`), A06 rendering (`MarkdownText`, reader links), A07 input (`ComposerCatalog`, `AttachmentLimits`, `AttachmentActions`) and A08 interaction cards; none of those files is changed by A11.

Source baseline: `src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift`, `TaskDetailParts.swift`, `TaskListParts.swift`, `TasksModel.swift`; OrbitKit `TaskListCopy.swift`, `TaskListLogic.swift`, `TaskDetailPage.swift`, `TaskReopen.swift`, `TaskJudgment.swift`, `TaskRunHandoff.swift`, `OwnerConfirmation.swift`, `SharePanel.swift`, `ShareMarkdown.swift`, `APIClient.swift`; the apiserver task controllers named in `tasks-projects-contract-audit.md`.

## How the baseline is carried over

OrbitKit's task rules and words are ported as pure Kotlin (`tasks/TaskLogic.kt`) and held to the Swift sources by tests rather than by review alone: `TaskCopyParityTest` reads the pinned Swift files from the repository and fails when any Android copy string is not a literal there; `TaskLogicTest` ports the XCTest cases (filters, pills, phrases, natural sort, run-state overlays, owner-confirmation panel action, reopen request, route words). Network calls go through A03's handle (`tasks/TaskApi.kt`), writes through A11's `taskprojects/FeatureWrites.kt`.

| iOS entry | Android | Contract |
| --- | --- | --- |
| Tasks / named lists / No list, scope switcher | `TaskBrowser.kt`, `TaskListsDirectory` | `GET /tasks/page` (limit 200, later pages `counts=none`), `/task-lists`, `/task-lists/:id?tasks=none`; All and No list send `projectId=none`, named lists and creator scopes omit it |
| Search, filter chips, labels, sort | `TaskBrowser.kt` options menu (Select Tasks, View as Tasks/Batches, Sort By + order, Filter by Label…, Refresh) | Server `q`, `status`, repeated `labels` (a comma may be part of a label); 250 ms debounce, a newer query cancels the older read; remembered filter as iOS `@AppStorage` |
| Counts, Happening now, progress | Chips with counts, pinned Happening now, progress line | `/tasks/counts` ignores tab and search; `/tasks/active` de-duplicated against the page; project counts shown as the scope note |
| Batches and selection | Batches view, bulk bar | `/tasks/labels`; selected tasks run/stop/assign/delete with the iOS confirmations; partial refusals and skipped rows stay visible; `BATCH_LIMIT` 200 |
| Detail: header, actions, verification, details, dependencies, description, acceptance, inputs, attribution, followed by, runs, comments | `TaskDetail.kt` | `GET /tasks/:id` plus side reads (owner confirmation, attribution, dependency graph, watches, lists, share, runner, providers); each side read keeps its last answer when it fails |
| Run now / Retry / Open run / gate rows | Action row | `POST /tasks/:id/execute {triggerId}`; the trigger is named once per press and rides every resend (3 resends); `TASK_ALREADY_RUNNING` / `TASK_RUN_PIN_CONFLICT` open the conflicting run card; gate rows never run |
| Owner confirmation, under review | Waiting / Under review / Confirm done | Fresh `GET /tasks/:id/owner-confirmation`; a waiting run opens its session's A08 card; the panel's own confirm is `{decision:CONFIRM, requestId:null, reviewRecordId:null}` after a re-read, never over a waiting request |
| Reopen, delete | Reopen / ⋯ Delete task | `PATCH {status:OPEN, supersededByTaskId:null, terminalReason:null}`; `DELETE /tasks/:id`; both confirmed |
| Assignee, suggested tier, provider/model, list, schedule | Details rows, `ScheduleSheet` | `PATCH` with explicit nulls; changing provider clears model; model hint options and route words from the server; `runAt` future-only, cancel is `runAt:null` |
| Dependencies | Summary, blocked notice, Graph/List, add/remove, auto-run | `GET /tasks/:id/dependency-graph?direction=both&maxNodes=500&pairUnary=true`; `POST /tasks/:id/dependencies`, `DELETE …/:dependsOnTaskId` (confirmed); candidates from the task page; the graph is the shared `TaskDependencyGraphView` |
| Acceptance | `AcceptanceSheet` | Criteria + command/expected-exit pair; blank pair clears both with explicit null; server completion rules stay authoritative |
| Inputs | `TaskInputUpload.kt` | System document picker, A07 size policy, multipart `POST /attachments?taskId=`; remove confirmed; open/share through A07 `AttachmentActions` |
| Attribution | Attribution rows | `GET /tasks/:id/attribution`: owning, discovery, crossing, blocker with absent reasons, iOS order and words; unavailable is distinct from none |
| Follow | `FollowSheet` | `POST /watches` with the four iOS conditions, deadline choices and idempotency key; Followed by lists ACTIVE/PAUSED watches |
| Runs, routing explanation | Runs section, `RouteWhySheet` | Run sessions with state/model/effort/time; the server's routing reasons |
| Comments | Pinned composer | `POST /tasks/:id/comments {body, mentions}`; `@Workspace` mentions resolved against the workspace list; nothing shown as sent before the server answers |
| Copy Link / Share… / Copy as Markdown | ⋯ menu, `taskprojects/SharePanel.kt` | Signed-in object link; public read-only share (layers, expiry, disable) on `/tasks/:id/share`; Markdown as `ShareMarkdown.task` |

## Write authority, offline, permissions

- Every write is gated at send time on `writable(state, handle, signedIn)`: the signed-in handle, the store's handle and a CONNECTED account stream. While the stream is down the page says "Reconnecting to Orbit… Changes are unavailable until it's back." (Android-only copy) and writes are refused locally (`FeatureWriteRefused`) — nothing is sent.
- A write whose answer is unknown holds a fence for 60 s on its revision key: a new press over the same displayed row is refused locally instead of sending a second, differently-named write. Definitive refusals (4xx other than 408/429 and `TASK_RUN_REQUEST_IN_PROGRESS`) are shown in the server's words and never turned into a local status change.
- A04 invalidations refresh the page in place (400 ms debounce); a busy run is followed every 4 s.
- A `403` on the task read withdraws the page and its actions ("Task couldn't be loaded" with the server's words and Retry), as A04 withdraws a session; a `404` says the task is no longer available. **Difference:** iOS keeps the last-read page beside a banner for a 403; Android withdraws it.

## Differences from the iOS baseline (deliberate, recorded)

1. **Mark done is not offered.** The pinned `TasksView.swift` sends `PATCH status:DONE`; the same pinned backend refuses it (`DIRECT_TASK_DONE_REFUSED`). Completion goes through evidence, owner confirmation or the server's criterion.
2. **"Created in ‹session›" has no entry — as in iOS.** The pinned base contains iOS `18edaeb0b`, which removed the created-tasks card's "View all in Tasks ›" footer; only its rows remain, opening the task (A01 matrix §2, "not to be recorded as reachable", item 2). Android's created-task rows now open the task through a minimal A08 hook (`cards/SessionCards.kt`); the creator scope keeps its implementation without a regular entry, as confirmed by the coordinator.
3. **No "new task" form.** Neither does iOS: tasks are filed by agents (A08 create cards). "Edit task" covers schedule, acceptance, assignee/provider/model/list and dependencies.
4. **403 withdraws the page** (above) and **offline writes are refused locally** — approved by the account owner as platform differences (card 34bbkPvI56b7ZUi8cJjX4, 2026-10-07T05:08:28Z).
5. Graph zoom buttons (Zoom in/out) beside pinch and pan — approved with the two above.
6. Writes belong to the app, not to the page (iOS's model-owned Task): a Run's resends, a comment, a project setting or a start finish when the page is left; sheets close only after the server takes their write; live events are coalesced into one read two seconds after the first of a burst (iOS `ProjectsModel.nudge`).

## Verification

- Unit (JVM): `TaskApiTest` (10), `TaskLogicTest` (14), `TaskCopyParityTest` (8), `FeatureWritesTest` (6) — query scope and punctuation-bearing labels, reopen body, panel confirm re-read, run trigger resend budget and unknown-answer fence, refusals in the server's words, dependency graph query, offline refusal before any request.
- Emulator (API 36 `emulator-5554`, controlled fixture `scripts/tasks-projects-fixture.py`, runner `scripts/tasks-projects-device-test.sh`): `TasksProjectsDeviceTest` journeys for session → task → back with the composer draft kept, search + label scope through activity recreation with the server's query recorded, prerequisite add / schedule cancel / acceptance edit / comment / Run now each checked against the fixture's final record, offline gating with no write sent, and 403 withdrawal. Results, logs and screenshots are in the evidence directory named in the task's evidence envelope.

## Gaps that remain

Controlled HTTP and emulator results establish the product wiring they exercise and nothing more. Not established: same-account installed iOS/Android/Web final state, physical GMS Android 10–16 phones, real deployed role accounts, FCM/release credentials and the deployed backend SHA. To close: install the pinned builds on the supplied devices/account, repeat list → detail → operation → original session, and compare the API's final records.

## Authored paths (relative to `src/android`)

`app/src/main/kotlin/io/orbitd/android/tasks/{TaskLogic,TaskViews,TaskApi,TaskBrowser,TaskDetail,TaskEditor,TaskInputUpload,TasksScreen}.kt`, `app/src/main/kotlin/io/orbitd/android/taskprojects/{FeatureWrites,SharePanel}.kt`, the Tasks branch line in `MainActivity.kt`, tests `app/src/test/kotlin/io/orbitd/android/tasks/*`, `taskprojects/FeatureWritesTest.kt`, the device test, fixture and runner, and this document.
