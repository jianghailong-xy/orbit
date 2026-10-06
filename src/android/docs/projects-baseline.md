# A11 Projects — static implementation correspondence

This is a source correspondence at the A11 combination, **not a frozen iOS installation matrix or a cross-device business result**. Development input is the ordinary merge `b075423118dacfb0a3c90c36b9f1aacad1feffd4`, whose A07 parent is the requested `51bbcc303cec3c64dfb217316afce9498add760d`. The route-only checkpoint is `cfe49df7a`. No upstream composer, attachment, auth, reader, or card implementation is authored by this module.

## Sources and feature correspondence

| Existing source / entry | Android implementation | Contract and behavior |
| --- | --- | --- |
| `Views/ProjectsView.swift` / `ProjectsListView`, OrbitKit `ProjectAttention.swift` | `projects/ProjectsScreen.kt`, `ProjectData.kt` | Authenticated `GET /projects`; title/goal search; Needs attention, Running, Ready, Waiting, Needs definition and folded Completed. Owner items, start request, integration/coordinator activity and quiet task activity influence lanes. Missing timestamp makes no inactivity claim. |
| `ProjectsView.swift` / `ProjectDetailView` and `ProjectsModel.swift` | `ProjectsApi.page` and project detail | Reads document, panorama, integration, open items, coordinator status, dependency graph, ready queue, task page and criteria confirmation. Independent optional-section failures are shown. Document or auxiliary 401/403 withdraws page; document 404 clears it. Old data after transport failure is read-only. |
| Work overview, `ProjectLandingRow.swift` | `ProjectOverview` | Server seven buckets and optional integration lanes; actual integration kind/state/phase, task title, start and last report timestamps; per-task landing blocking reason. No done-from-count inference. |
| `ProjectGraphView.swift`, OrbitKit `ProjectPlan.swift`, graph endpoint | `ProjectGraph.kt` | Draws server marks and prerequisite-to-dependent edges; full view, zoom controls, group/member inspection and task navigation. Preserves server truncation notice. It does not invent runnable state from graph position. |
| Coordinator section / `openCoordinator`, `replaceCoordinator` | Coordinator controls | `GET /coordinator/status` grants `canOpen`; POST resolve-or-create; replacement is a separately confirmed request and preserves agent/workspace. Server refusal/required action displayed. Existing host stack handles return navigation. |
| Open items / Review, Answer, exception and merge review | `ProjectOpenItems` → coordinator session | Uses server `actions`, preserves owner/coordinator attribution and routes Review to the coordinator as Swift does. The conversation renders and submits unchanged A08 `CardCatalog`, `BusinessCard`, `CardActions`, `CardAuthority`, `CardRequests`. No local criteria/merge/exception approval rules are introduced. Unknown kinds remain visible. |
| Owner's own `Start…` and `OwnerStartProjectSheet` | `ProjectStartDialog` | Shown only when OPEN, explicit `startedAt:null`, and successful open-items read reports no request. Reads criteria digest and integration/graph. Reuses A08 `BusinessCard` settings and `CardRequests` validation; omits `requestId` on the owner-only request. The locally constructed presentation card is not a coordinator request or an authority grant. Backend verifies current digest and owner authority. |
| `ProjectRunSettings.swift` / How it runs | `ProjectSettingsDialog` | Saves `automatic` and concurrency with exact string `expectedConfigRevision`; never sends legacy `coordinatorEnabled` for Automatic. Separate line/check/escalation writes; locked line disabled. Pause and resume use their existing owner endpoints. Settings 409 and unknown-write messages are visible in the modal. |
| Blockers section | Project blocker cards | Required action, owner/severity, criterion text, agent argument and paths; USER-owned blocker resolution records a required reason through the dedicated endpoint. Coordinator/system blockers remain visible. Resolved history includes actor/note. |
| Ready queue | Ready to run section | Only server `runState:READY` offers Run; PAUSED offers a confirmed list resume naming release counts; queued/running can open their session. Task execute uses a new trigger, but transport fence identity excludes the random trigger and includes displayed row identity. |
| Criteria/instructions/tasks | Native Markdown and task rows | Criteria text, satisfied/landing, verification method and unmet task links; instructions; paginated real task rows with work/dependency/integration state. Refresh re-reads the previously loaded task window. |
| Lifecycle menu | Project options | Confirmed record done/cancelled/reopen; empty-project delete; copied object link and Markdown. Final displayed state always comes from a fresh read. |

All HTTP uses inherited A03 `AuthSession` / `SessionHandle` through `DirectoryApi`; invalidation is A04's revision and directory freshness. A11's `taskprojects/FeatureWrites` provides transport mutex and durable ambiguous-write fencing, without defining permissions. Settings/start/blocker/lifecycle responses do not optimistically change task or project state. Shared navigation is only the Tasks/Projects branch handoff owned by A11's root; this module does not edit other destination branches.

## Known source differences and remaining evidence

- The current backend also has durable owner `/projects/:id/done` semantics. The pinned Swift menu calls compatibility `PATCH {status:DONE}`; this implementation follows that entry and reports the returned/derived server state. It does not invent a new done decision card outside A08.
- The node graph preserves the server folds. Swift additionally folds settled blocks client-side and uses pinch zoom; Android currently uses explicit zoom controls and a member inspection dialog. Relationship/task reachability is preserved; pixel parity is not claimed.
- List attention ordering within a lane currently uses activity/title; Swift applies detailed owner-item priority/severity/wait tie-breakers. This is a visible presentation difference, not an authorization difference.
- The pinned Swift public Share panel is not present in the first business checkpoint; Copy link and Copy as Markdown are present. This entry must be completed or retained as an explicit acceptance gap.
- Static source APIs and controlled fixture success do not establish same-account iOS/Android/Web final business state. No installed iOS baseline, physical Android 10–16 GMS phone, actual role account matrix or production integration runner credentials were provided. Those checks remain pending.

## Local verification ownership

`app/src/test/kotlin/io/orbitd/android/projects/ProjectDataTest.kt` covers attention/activity distinctions, bigint config revision and Automatic body, graph direction/default start line, loaded-page restoration with independent 503, and auxiliary 403 revocation. Root runs these with the original Android gates using Gradle `--max-workers=2`; test existence alone is not a pass claim. Root owns the controlled HTTP fixture/device tests and records exact SHA/APK identity and failed evidence. No emulator is controlled by this subtask.

## Authored paths

- `app/src/main/kotlin/io/orbitd/android/projects/ProjectsScreen.kt`
- `app/src/main/kotlin/io/orbitd/android/projects/ProjectData.kt`
- `app/src/main/kotlin/io/orbitd/android/projects/ProjectGraph.kt`
- `app/src/main/kotlin/io/orbitd/android/projects/ProjectSettings.kt`
- `app/src/test/kotlin/io/orbitd/android/projects/ProjectDataTest.kt`
- `docs/projects-baseline.md`

Paths above are relative to `src/android`. Source inherited by the ordinary A07 merge is not A11-authored work.
