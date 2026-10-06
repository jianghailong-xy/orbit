# A11 Tasks / Projects fixed-source contract audit

This is a source inventory and implementation checklist, not an installed-iOS or same-account acceptance result. The A01 inventory and approved S1 / D09 decisions do not establish a frozen runtime matrix. Product differences below must remain explicit until reviewed against actual clients.

## Version identity

- A11 starting commit: `3cb12b3be2a38c55601786bdfa1967f60a86990a`.
- Required inherited A07 commit: `51bbcc303cec3c64dfb217316afce9498add760d`.
- Ordinary two-parent merge: `b075423118dacfb0a3c90c36b9f1aacad1feffd4`; parents are exactly the two commits above.
- `git diff 51bbcc3 b0754231 -- src/shared src/apiserver src/macos` is empty. The combined code does not substitute another Swift, shared, or backend baseline.
- The corresponding identical subtree identities at both commits are `src/shared=de5d906751a4f57018c24f30c6ef0bca61ddf911`, `src/apiserver=c0aa1a79ded9d330c38acfb668e746e80d768b1b`, and `src/macos=2689ba528cc644d9d39b8e62e662dcc4396793cc`.
- Last inherited path commits: shared `c29a6cbe1c218c6005ec83eccfc44d7ed50fd211`; apiserver `0f914c4098ebf18617f3dd0254ef6009bf84d41b`. These are repository ancestry, not deployed process identity.
- Initial read-only `docker ps --format '{{.Names}} {{.Image}} {{.ID}}'` was denied access to `/var/run/docker.sock`; that failed inspection remains part of the evidence history. The parent subsequently inspected with read-only elevated access and found five scratch PostgreSQL containers, no Orbit apiserver container, and only emulator/runner Orbit systemd units. No local API runtime SHA was established. `/api/health` intentionally returns only `{status:'ok'}` and cannot establish a deployment SHA. No remote deployment or credential probing was performed.

## Authoritative source map

| Concern | Fixed source |
| --- | --- |
| iOS task list, batch selection, list directory, task detail | `src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift`, `TaskDetailParts.swift`, `TaskListParts.swift` |
| iOS project index/detail, graph, landing activity | `src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift`, `ProjectGraphView.swift`, `ProjectLandingRow.swift` |
| Swift network and refresh behavior | `src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift`; `src/macos/OrbitApp/Sources/OrbitApp/TasksModel.swift`, `ProjectsModel.swift` |
| Task display/action rules | `src/macos/OrbitKit/Sources/OrbitKit/App/TaskListLogic.swift`, `TaskDetailPage.swift`, `TaskJudgment.swift`, `TaskRunHandoff.swift`, `TaskReopen.swift` |
| Project display/action rules | `src/macos/OrbitKit/Sources/OrbitKit/App/ProjectPage.swift`, `ProjectPageSections.swift`, `ProjectAttention.swift`, `ProjectGraphLayout.swift`, `ProjectRunSettings.swift`, `StartProject.swift` |
| Read models and nullable writes | `src/macos/OrbitKit/Sources/OrbitKit/Models/Tasks.swift`, `TaskDetailReads.swift`, `Projects.swift`, `ProjectDetail.swift`, `ProjectOwnerItems.swift`, `ProjectPlan.swift` |
| Shared wire contracts | `src/shared/src/dto.ts`, `enums.ts`, `task-start.ts`, `task-run-reason.ts`, `project-start.ts`, `project-progress.ts`, `project-done.ts`, `owner-confirmation.ts`, `owner-confirmation-review.ts`, `criteria-changes.ts`, `events.ts` |
| Final permissions and state changes | `src/apiserver/src/tasks/tasks.controller.ts`, `tasks.service.ts`, `task-owner-confirmation.controller.ts`, `task-completion-evidence.controller.ts`; `src/apiserver/src/projects/projects.controller.ts`, `projects.service.ts`, `project-acceptance.service.ts`, `coordinator-authority.ts`, `project-promotion.controller.ts`; `src/apiserver/src/task-lists/task-lists.controller.ts` |

`src/shared/src/taskProgress.ts` describes background sub-agent/workflow progress, not the durable task progress-report record. Do not treat its `phases`/`agents` payload as the durable Tasks API shape.

## Task/list correspondence

Each row is baseline scope to account for. Presence here does not claim that Android implements or verifies it.

| Surface / operation | Actual read/write contract and interpretation |
| --- | --- |
| All tasks / No list / named list | `GET /tasks/page`; all/no-list use `projectId=none`, no-list also `listId=none`. Named list uses its id and omits project scope. Explicit `creatorSessionId` also omits project scope. A project's tasks otherwise belong on its project page. |
| Scope directory | `GET /task-lists`, `GET /task-lists/:id?tasks=none`. Active/completed groups, search, task/running counts; omit project-only lists from global Tasks when `tasksOutsideProjects=0` and taskCount is positive. Empty lists remain visible. |
| Search and status | `q`, `status=RUNNABLE/RUNNING/ONGOING/FAILED/DONE/CANCELLED`; omit for All. Default remembered filter or All. Search is server-backed and debounce/cancellation must prevent old reads overwriting newer queries. |
| Pagination | Opaque `nextCursor`; task page default Swift limit 200. Later pages use `counts=none`. `total` and `counts` are optional in reduced modes. Deduplicate ids; reset cursor when scope/filter/query changes. |
| Counts and progress | `GET /tasks/counts` uses scope/creator/labels, not page status or search. `done/total` bar and status chips must not infer global counts from one page. Preserve `inProjects` scope note when supplied. |
| Happening now | `GET /tasks/active` returns `{items,total,truncated}`. Keep bounded active work separate from the current page. Running/queued overlays take precedence over the task lifecycle label. |
| Labels / Batches | `GET /tasks/labels` returns `{items,labelTotal,truncated}`; each row carries label, total, open, inProgress, done, failed, cancelled. A batch is a label summary, not a new task-list entity. Selecting label(s) narrows tasks; send repeated `labels` query values, not comma joining, because comma can be part of a label. |
| Selected-task operations | POST `/tasks/batch-execute` `{taskIds,maxConcurrent,triggerId}`, `/batch-stop` `{taskIds}`, `/batch-assign` `{taskIds,assigneeId}`, `/batch-delete` `{taskIds}`. Null assignment explicitly clears. Confirm stop/delete as Swift does; surface partial refusals and reread. |
| List steering / plan | POST `/task-lists/:id/console` resolves/creates one durable steering session and returns `sessionId`. Enter existing session navigation. Plan/batch/DAG proposals in that conversation use A08 approval cards. |
| List pause and revision contract | `PATCH /task-lists/:id` accepts `paused` and note; project queue resume uses `{paused:false,note}`. Backend exposes revisions and restore, but the named fixed Swift views expose steering/resume rather than a dedicated revision editor. Do not invent a plan editor or claim unshown revision UI parity. |
| Row / full detail | `GET /tasks/:id/row` is lightweight changed-row hydration; `GET /tasks/:id` includes runs/comments/dependencies. Detail block order: header/actions, verification, details, dependencies, description, acceptance, inputs, attribution, followed-by, runs, comments. |
| Run now / retry / current run | POST `/tasks/:id/execute` `{triggerId}`. Create triggerId at the gesture, preserve it over any transport/auth retry. A live run opens its session instead; do not start another. Show 409 handoff/conflict details and returned session link. Do not treat HTTP completion as task DONE. |
| Runnable predicate | Honor `runnable` when returned by the server. Gate rows (`completionPolicy=VERIFICATION_PASSED` and `verifiesTaskId=null`) do not run. Dependencies, paused/held lists, retired attempts, workspace enablement, runner, cancelled project, and aggregate parents are server concerns; a local `status != DONE` check is insufficient. |
| Lifecycle | Reopen DONE/CANCELLED/FAILED with one PATCH `{status:'OPEN',supersededByTaskId:null,terminalReason:null}`. Keeping either retirement field blocks reopen. Delete uses DELETE `/tasks/:id`. Cancellation uses permitted PATCH `status=CANCELLED`; run stop is its separate endpoint/batch operation. Never synthesize direct task DONE. |
| Owner completion / review | GET `/tasks/:id/owner-confirmation`; when waiting, navigate to waiting.sessionId and A08 card. UNDER_REVIEW is not an actionable owner decision. Swift panel may confirm an OWNER_CONFIRMED task when no waiting request, using `{decision:'CONFIRM',requestId:null}`; service reread/refusal remains authoritative. |
| Evidence completion | Evidence/independence decisions live in A08 session standing queue. Body binds decidingSessionId + evidenceRevision; never decide from a task status badge. Independent session and criterion checks stay server-owned. |
| Assignment / provider / model | PATCH task with explicit nullable assigneeId, provider, model, listId. Changing provider clears model in the same write. Model hint uses existing server options, shows coordinator reason and run routing facts; do not introduce a new model catalogue. |
| Schedule | PATCH `runAt` ISO instant or null. Display in local timezone. Unreadable existing timestamp is distinct from unset and may be cleared/replaced. Run now clears schedule server-side. |
| Dependencies | GET `/tasks/:id/dependency-graph?direction=both&maxNodes=500&pairUnary=true`; show graph/list, status, direct-edge blocking, truncation. POST `/tasks/:id/dependencies` `{dependsOnTaskId}`; DELETE `/tasks/:id/dependencies/:dependsOnTaskId`; confirm removal. Search candidates via task page. Server owns cycle/scope checks. |
| Verification / retirement | Show completion criterion/policy, verifier link and PASS/FAIL/Open state; superseded/dropped attempts retain history and successor relation. Do not confuse VERIFICATION criterion with a codeless gate row. |
| Description / acceptance | Existing rich text. Acceptance edit PATCH contains only changed fields; command + expected exit code are a pair, blank clears both with explicit null. Changing the completion criterion may require `completionCriterionOverrideReason` at the current backend; do not hide that refusal. |
| Inputs | Existing authenticated attachment uploader/read/removal paths (`uploadTaskInput`, DELETE attachment). Task inputs are copied per run. Do not replace composer/attachment implementation; any absent task-input UI remains an explicit gap. |
| Attribution | GET `/tasks/:id/attribution`: counts-towards project/criterion, noticed-in session, crossing, blockers, absentReason. Keep unavailable/error distinct from no attribution. Link named resources through the current navigation stack. |
| Watches | Show watches that target the task and Follow task entry; use A12 interface rather than implementing another watch state machine. Scope ownership does not remove the baseline Followed by section. |
| Runs | Session links, state/time, provider/model/effort, model routing explanation. A session opening is a push; returning restores task detail then original session, not drawer root. |
| Comments | POST `/tasks/:id/comments` `{body,mentions?}` where mentions are agent ids and can notify/start work. Render existing rich text, title/name/time; do not infer mentions from arbitrary ids. GET detail reconciles created comment. |
| Sharing | Swift has signed-in Copy Link, public read-only Share, Copy as Markdown. Inherit existing sharing boundaries and record unsupported actions; do not repurpose public sharing as an authenticated object link. |

## Project correspondence

| Surface / operation | Actual read/write contract and interpretation |
| --- | --- |
| Project index | GET `/projects` or optional status filter; search title/content shown by Swift, attention-group sorting, completed fold. Owner needs-you and coordinator activity are distinct signals. Counts and fractions are server facts. |
| Detail document | GET `/projects/:id`: title, goal, instructions, acceptanceCriteriaItems, progress, task count, status, authorization settings/configRevision. Preserve unconfirmed/stale/absent reasons and criteria key/text. |
| Work overview / progress | GET `/projects/:id/panorama` and `/integration`; show lanes/buckets, blocked/ready/running/integrating, manual ready, line and check state. A task's DONE is not proof that its code landed. |
| Landing activity | Integration `inFlight`: oldest running else oldest queued, task title, checking/queued, started/updated timestamps. `mergeCheckOnTip` is legacy name for latest attempt checks and may not prove current tip. `landTasks` is an optional newer field. |
| Relationship graph | GET `/projects/:id/dependency-graph`: server-folded marks, task/run/motif nodes, edges, counts. Nodes open tasks, folded marks retain represented identities; inline and full-screen views. Never substitute a JSON dump for a graph. |
| Tasks and criteria | GET `/projects/:id/tasks/page` with cursor/limit 100; separate loaded tasks from total. Criterion met/unmet/held-up/landing/verification information is server-derived; show serving tasks and links. Criteria text alone is not met evidence. |
| Blockers | Read project/panorama blockers. POST `/projects/:id/blockers/:blockerId/resolve` `{reason}`; require actual reason and display result. No client-side task unlock. |
| Ready/run queue | GET `/projects/:id/panorama/ready?limit=5`: taskId, title, status, runState, sessionId, pausedList, downstream impact/truncation. READY runs, RUNNING/QUEUED open session, PAUSED resumes list with note. Honor server state. |
| Coordinator | GET `/projects/:id/coordinator/status` includes openability, current/stale session, state and disabled/unbound reasons. POST `/coordinator` returns `{sessionId,created,...}`; POST `/coordinator/replace` requires replacement confirmation. 409 unbound workspace is a rebind/settings handoff, not another auto-created session. |
| Open items | GET `/projects/:id/open-items`: separate startRequest, needsYou, coordinator items. Render kind/title/assigneeReason/delivery/waitingSince/facts. Actions are supplied by server; OWNER vs COORDINATOR is an item assignment, not proof about arbitrary user credentials. Open coordinator and focus existing item to use A08. |
| Start | GET `/acceptance/confirmation` plus document/openItems/plan. POST `/start` binds criteriaDigest and requestId when answering a request; settings include line MAIN/PROJECT_BRANCH, automatic, maxConcurrentTasks, mergeCheckCommand, optional projectBranchName. Use existing A08 START card for requested starts. Swift also has owner-initiated Start when no request; it is not counted as needs-you. |
| Run authorization | PATCH `/projects/:id` `{automatic?,maxConcurrentTasks?,expectedConfigRevision}`. `automatic` is not `coordinatorEnabled`: old latter field also pauses/resumes. Stale revision returns 409 STALE_CONFIG_REVISION; reload, do not overwrite. |
| Integration settings | PATCH `/projects/:id/integration` fields line, mergeCheckCommand, exceptionEscalationSeconds. `locked` prohibits line changes; 409 INTEGRATION_LINE_LOCKED. Empty merge check explicitly null; display missing-check warning and unrecognized existing escalation as its actual value. |
| Pause / resume | POST `/projects/:id/pause` or `/resume`, app owner channel. Automatic work stops while paused; existing runs finish and owner's manual Run remains separate. Do not infer pause from Automatic off. |
| Exceptions | A08 verbs: retry task (gesture triggerId), cancel task, return-to-coordinator, fuse episode resume, mark handled with note. Card assignment/version changes revoke old actions. Never locally resolve a blocker/open item. |
| Acceptance changes | Pending criteria decision includes decidability, commitToken, currentSeal, baselineSeal, proposed set and diff; A08 requires matching seals. Confirm criteria binds digest. Read changesSinceConfirmed including revised/removed, not only added. |
| Merge review | GET `/promotions/current`; A08 confirms READY candidate with sourceSha, declines, or cancels CONFIRMED/RECHECKING. POST `/promotions/:id/confirm/decline/cancel`; all owner-channel only. Review checks/conflicts/changed SHA; no raw git merge/push from UI. Merged receipts are separate GET `/promotions/merged`. |
| Lifecycle / delete | Swift PATCH project status OPEN/CANCELLED/DONE is a compatibility path; see difference below. DELETE empty project only, taskCount>0 disabled and server 409 authoritative. Confirmation should state actual effects. |
| Sharing | Signed-in link, public read-only share, and markdown copy are separate Swift entries. Keep existing sharing behavior or record the gap. |

## A08 and shared entry contracts

There is no class named `CardApi` or `CardModel` in the pinned Kotlin code. Public symbols are:

- `CardCatalog.session(id: String, snapshot: SessionSnapshot, now: Instant)` and `CardCatalog.project(session: String, project: String, standing: Map<String, JsonElement>)`.
- `InteractionCard(key, family, title, source, sessionId, projectId, objectId, binding, actions, status, context)`.
- `CardRequests.build(card: InteractionCard, verb: CardVerb, input: CardInput = CardInput()): ApiRequest`.
- `CardActions(auth: AuthSession, store: RealtimeStore, scope: CoroutineScope)`, `restore(handle,cards)`, `submit(handle,card,verb,input): Job`, `valid(handle,sessionId)` and action state flow.
- `CardAuthority(api: OrbitApi, handle: SessionHandle).read(card)` rereads the exact source and compares version.

`CardActions.valid` requires the exact current `SessionHandle`, foreground/online state, `RealtimeStore.selectSession(card.sessionId)`, and a fresh accessible snapshot for that session. Standalone project reads do not meet that condition. `CardAuthority` reconstructs task/project cards from `RealtimeRest.session`; fabricated cards will not authorize. The minimal baseline-compatible entry is to push the coordinator/run session and reuse its A08 card. Any standalone card hosting needs the existing session selection/freshness contract, not relaxed validity.

A08 decisions serialize across instances, re-read before write, bind tokens/revisions, durably fence uncertain/sent writes, never automatically replay uncertain decisions, and refresh session/directory after attempts. Do not duplicate those mechanisms in task/project UI. `RealtimeRest` standing keys are `evidenceDecisions`, `ownerConfirmation`, `criteriaDecisions`, `acceptanceConfirmation`, `project`, `openItems`, `promotion`; project catalog requires matching document id. Unrecognized actions stay read-only.

`OrbitRoute` already contains TASKS/TASK/LIST/PROJECTS/PROJECT as well as Wiki/Watch/Settings destinations. `OrbitNavigation.push` retains the exact previous frame; `back` pops; `bindAccount` clears former account stacks and carries pending signed-out links into login. Minimal A11 branch wiring must preserve that behavior, IME clearing, other destinations, and A06 denial/cleanup. Common route fields (`id`, `recordId`, `workspaceId`, `origin`) must not silently acquire incompatible meanings with A12/A13.

For object reads/actions, a stale response after account/server/route switch must not repopulate another identity. Distinguish initial loading, no rows, read failure, permission denial, stale content, missing object, and action refusal. Refresh after writes and on control-stream invalidation/cross-device changes. Do not restore an optimistic success after process death or treat cached data as current authority.

## Fixed-source differences requiring explicit disposition

1. **Task Mark done is stale in Swift.** `TasksView.swift` sends PATCH status DONE. The same pinned `TasksService.update` rejects it with `DIRECT_TASK_DONE_REFUSED` for every principal and supplies criterion/requiredAction. Android must respect this server rule and route to existing completion/review, not claim the legacy press succeeds.
2. **Project done has two non-equivalent paths.** Swift uses compatibility PATCH status DONE. This is allowed without acting-session header but the post-commit derived projection can restore OPEN; it does not create the durable OWNER record. The newer shared `project-done.ts` / POST `/projects/:id/done` requires criteriaDigest, acceptedGaps and optional requestId. A08 has no DONE_REQUEST completion verb. Do not conflate a compatibility PATCH with owner acceptance of gaps.
3. **Shared open-item vocabulary exceeds fixed Swift/A08.** `DONE_REQUEST` and `DELIVERY_REVIEW` exist in shared/backend but lack full dedicated A08/Swift decision coverage. Preserve visible details/coordinator entry and explicitly record unsupported decision UX; never invent an approval or relabel all unknowns as escalations.
4. **Owner-initiated no-request start and task panel confirm differ from request cards.** A08 START is generated only from a startRequest and owner confirmation only from waiting requests. Swift has direct owner doors for no-request start / no-waiting panel confirm. Do not fabricate waiting request ids to reuse a card.
5. **Acceptance editing can encounter newer server guard.** An edit deriving a different completion criterion requires override reason, although the fixed simple Swift editor sends only acceptance fields. Surface the actual refusal and leave task unchanged; retain this as a parity issue until a concrete UI decision is reviewed.

## Existing fixtures and meaningful verification

- `src/shared/src/interaction-cards.fixture.json`: full task/project standing, allowed actions, payload contracts used by inherited card tests.
- `src/shared/src/interaction-cards-review.fixture.json`, `owner-confirmation-review.fixture.json`, `owner-confirmation-if-confirmed.fixture.json`: pending/reviewed/outdated owner review and consequences.
- `src/shared/src/session-created-tasks.fixture.json`: creator scope and count copy; tests must read this fixture rather than duplicate expected copy.
- `src/shared/src/orbit-link.fixture.json`: object URL parsing and identity; existing navigation tests cover stack/account behavior.
- `src/shared/src/realtime-recovery.fixture.json`: invalidation/recovery boundaries. Inherited `RealtimeStoreTest`, `CardActionsTest`, `CardContractTest` cover session freshness and durable card fences.
- Swift tests `TaskAPIClientTests`, `TaskListLogicTests`, `TaskDetailLogicTests`, `TaskReopenTests`, `TaskRunHandoffTests`, `ProjectPageTests`, `ProjectPageSectionsTests`, `ProjectRunSettingsTests`, `ProjectGraphLayoutTests`, `StartProjectTests`, plus wiring/codable tests are executable descriptions of the fixed baseline.
- Existing Android controlled servers/scripts: `scripts/cards-fixture.py`, `cards-device-test.sh`, `realtime-fixture.py`, `realtime-device-test.sh`, `directory-device-test.sh`, `scripts/verify.sh`. Preserve original gates and old evidence identities; fixture success proves controlled transport/UI behavior only.

New A11 checks should cover actual HTTP query/body serialization, stale generation/403/404 withdrawal, cancelled project/runnable false, unknown status/action, dependency mutation/refusal, schedule null, partial batch failure, duplicate run gesture fencing, 409 config/merge/review staleness, and session → detail → original session. Device execution must hold `/var/lib/orbit/android/ui.lock` with flock, use Gradle `--max-workers=2`, restore settings, exit fixture, remove reverse, and release lock. This read-only audit performed no Gradle/device runs.

Still unestablished: installed iOS identity, same-account real Android/iOS/Web final API state, physical Android 10–16/GMS behavior, deployed role/FCM/release credentials, and actual deployment SHA. Follow-up must capture client build ids + backend/shared identity, execute the same named seeded business objects on each real client, compare final API records, and preserve screenshots/logs without relabeling controlled fixtures as business results.
