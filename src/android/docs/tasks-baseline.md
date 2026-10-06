# A11 Tasks baseline and implementation

This is a source/API mapping, not a frozen same-account device acceptance matrix. The pinned input is A07 `51bbcc303cec3c64dfb217316afce9498add760d`, absorbed by ordinary merge `b075423118dacfb0a3c90c36b9f1aacad1feffd4`. The early A11 route-only commit is `cfe49df7a`. Android inherits A03 auth, A04 real-time state, A05 navigation, A06 rendering, A07 input handling, and A08 interaction cards. No inherited file is an authored Tasks change.

Source baseline: `src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift`, `TaskDetailParts.swift`, `TaskListParts.swift`; OrbitKit `Tasks.swift`, `TaskDetailReads.swift`, `TaskListLogic.swift`, `TaskReopen.swift`, `TaskDetailPage.swift`, `OwnerConfirmation.swift`; `src/apiserver/src/tasks/tasks.controller.ts`, `dto.ts`, `task-lists/task-lists.controller.ts`; and `src/shared/src/{owner-confirmation,watch,task-start,taskProgress}.ts`.

| iOS entry | Android implementation / authority |
| --- | --- |
| Tasks, named lists, No list | `TaskBrowser`, `GET /tasks/page`, `/task-lists`, named header `?tasks=none`; aggregate and No list send `projectId=none`, named lists retain project membership |
| Search, status, assignee, labels, sort, cursor | Server `q`, status, assignee and repeated `labels` query parameters; saveable screen choices; opaque cursor; older page responses cannot append after a refresh/scope change; sorting applies to loaded rows as in the native baseline |
| Scope counts and live work | `/tasks/counts` ignores status/search; `/tasks/active` provides Happening now; native text and progress meter; project counts open Projects |
| Batches and selection | `/tasks/labels`; label totals and task drilldown; selected loaded tasks run/stop/assign/delete with confirmation; response counts and item refusals remain visible |
| Detail, loading, empty, error, cross-end changes | `/tasks/:id` plus row, graph, owner confirmation and attribution reads; A04 invalidation refreshes; account/session epochs and `directoryFresh` gate writes; protected 401/403 clears detail |
| Run, retry, stop, reopen, delete | Server `row.runnable`; per-press execute trigger; batch stop; reopen sends OPEN plus both retirement fields null; destructive confirmations; run refusal opens conflicting run when provided |
| Owner confirmation / review | Fresh owner-confirmation read; no waiting run permits exact `{decision:CONFIRM,requestId:null}` panel request after re-read. Waiting run uses A08 `BusinessCard` read-only preview and opens the actual review session, as iOS does. No local replacement approval policy |
| Assignee, list, suggested tier, provider/model | PATCH explicit null for inheritance; server modelHintOptions; existing `ComposerCatalog` reads the runner/provider model catalog; changing provider resets model selection |
| Schedule / task plan entry | Local date/time picker, ISO `runAt`, null cancellation; named-list console opens its server-created steering session, whose plan cards use A08 |
| Dependencies | Exact add/remove contracts; server graph nodes/edges adapted to reusable native `ProjectGraph`, graph/list modes, current-task identification, truncation notice, task navigation and auto-run toggle |
| Description and checklist prose | A06 Markdown renderer, including GFM checklists; no new checklist state machine or fabricated checklist endpoint |
| Acceptance | Criteria + command/expected-exit pair editor; paired explicit null clearing; server completion-criterion checks remain authoritative. No direct DONE PATCH button: completion is evidence/owner/server-evaluated under the current backend |
| Inputs | Native document picker with A07 size policy, multipart `/attachments?taskId=…`, remove task input, existing `AttachmentActions` download/open/share/copy; no composer or attachment subsystem rewrite |
| Attribution | Actual `owning`, `discovery`, singular `crossing` and `blocker`, absent reasons, project/task/session navigation |
| Following | Server watches filtered by `targetKind`/`targetResourceId`; task follow terminal/done/failed condition, fixed task target, notification action, deadline and idempotency key; opens existing Watch destination |
| Runs and routing explanation | Run sessions, status/model/effort/time, server routing reasons/policy, original session navigation |
| Comments | A06 Markdown, author/time, direct comment POST; no success until server response |
| Copy / public share | Signed-in link/Markdown clipboard; server share token; public include-layer choices, expiry and disable; existing attachment sharing remains inherited |

Write transport uses feature-local `FeatureWrites`, never A08's card authority for unrelated operations. Unknown responses leave a durable revision-scoped fence; a new random run trigger cannot bypass it. Definitive HTTP refusals are shown and never converted to local status transitions. Task/session return behavior remains in A05 `OrbitNavigation`; Tasks does not replace route stacks.

## Verification and remaining evidence

`TaskApiTest` checks query scope, punctuation-bearing labels, cursor identity, reopened retirement fields, authenticated endpoints, owner-confirmation races, missing owner reads, durable unknown-run fencing across a new API instance, permission refusals, batch payloads/partial results, acceptance pair constraints, live-state presentation and graph edge direction. Root runs the original Android gate and controlled HTTP/emulator scenarios and records their own logs and screenshots.

Controlled HTTP and emulator results establish only the controlled product wiring and recovery paths they actually exercise. The same-account installed iOS/Android/Web final-state comparison, physical GMS Android 10–16 coverage, real deployment roles and issued release/FCM credentials remain external evidence gaps. Follow-up: install the pinned builds on the supplied devices/account, repeat the mapped list → detail → operation → original-session flows, compare actual API final states and capture device/build identities. These gaps do not convert fixture outcomes into real business acceptance.

Authored Tasks paths are `app/src/main/kotlin/io/orbitd/android/tasks/*`, `app/src/test/kotlin/io/orbitd/android/tasks/TaskApiTest.kt`, and this document. Root owns minimal `MainActivity` wiring, the shared feature transport, device tests and evidence, and the Projects module owns the graph renderer. Shared Markdown, cards, navigation, composer, core auth and attachment internals are inherited and untouched by Tasks.
