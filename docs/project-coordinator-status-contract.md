# `GET /projects/:id/coordinator/status` — the read contract

**Status: frozen contract, not implemented.** Nothing in `src/` serves this route today. This
document is what the implementing task builds against; it decides every field, its wire shape, the
row or function it comes from, and what it says when it has no value.

## Why it exists again

The project detail page's Coordinator section is one static sentence and one button
(`src/web/src/pages/ProjectsPage.tsx:305`, component at `:382`). It cannot say whether a
coordinator exists, whether the conversation is alive, whether it is in Trash, or whether the
button will refuse — it presses `POST /projects/:id/coordinator`
(`src/web/src/pages/ProjectsPage.tsx:366`, route at `src/apiserver/src/projects/projects.controller.ts:433`)
and renders whatever comes back. The redesign needs to know all four of those *before* the press.

A route of this name existed during the control loop and was deleted in `6418a1e5`, with the types
it left behind removed in `68a58d93` ("take out what the control loop left with no reader"). The
last revision that holds the full implementation is `0a3cb3c8`
(`git show 0a3cb3c8:src/apiserver/src/projects/projects.service.ts`, method at line 1030). A dead
sample of its payload still sits in `src/web/src/pages/ProjectDetailPanorama.test.tsx:121` — a stub
for an endpoint that no longer exists, wired at `ProjectDetailPanorama.test.tsx:189`.

**What is kept from it:** the `<field>AbsentReason` idiom. A fact with no value is served as `null`
*beside a closed-set reason*, never dropped and never left for the reader to guess. That is what
lets a client tell "this project has never had a coordinator" from "this server does not report
one".

**What is dropped from it:** everything the control loop was the reader for. See
[Deliberately excluded](#deliberately-excluded).

## Route

| | |
| --- | --- |
| Method / path | `GET /api/projects/:id/coordinator/status` |
| Auth | JWT, `@CurrentUser()`, like every other route on `ProjectsController` (`src/apiserver/src/projects/projects.controller.ts:39`) |
| `:id` | `PublicIdPipe` — accepts base62 or raw UUID, as every other project route does |
| 404 | project not owned by the caller, decided by the query's own `ownerId` predicate rather than a second lookup |
| Side effects | none. A read, and only a read: it takes no lock, opens nothing, and writes nothing |

It answers about the project's **coordination binding**, never about its tasks, its acceptance or
its dependency graph — each of those already has an endpoint.

## Wire-shape rules this payload has to obey

1. **BigInt.** `coordinatorGeneration` is a Prisma `BigInt` (`src/apiserver/prisma/schema.prisma:1689`).
   It reaches the client as a **decimal string**, via the global `BigInt.prototype.toJSON` at
   `src/apiserver/src/main.ts:22`. Not a number: the counter is only ever allowed to go up, and
   JSON numbers are doubles.
2. **Id spelling.** `PublicIdInterceptor` (`src/apiserver/src/main.ts:47`) rewrites values **by
   field name**, using `PUBLIC_ID_FIELDS` (`src/shared/src/codec.ts:67`) — the walk is
   `addTwins` in `src/apiserver/src/common/public-id-body.ts:85`, and nesting does not matter
   (depth cap 8). Every id-bearing name in this payload is already on that list:
   `id` (`codec.ts:68`), `sessionId` (`codec.ts:71`), `coordinatorSessionId` (`codec.ts:77`),
   `workspaceId` (`codec.ts:78`), `projectId` (`codec.ts:158`), `agentId` (`codec.ts:186`). **No new id-shaped name is introduced**, so
   `src/shared/src/codec.ts` needs no edit for this endpoint.
   Each also gains a twin — `id` → `publicId`, `<x>Id` → `<x>PublicId`
   (`src/apiserver/src/common/public-id-body.ts:37`) — which is additive and needs no declaring here.
3. **Do not name a field `generation`.** That name is claimed by `NEVER_PUBLIC_ID_FIELDS`
   (`src/shared/src/codec.ts:228`, entry at `:235`) as a compare-and-swap fence. The field here is
   `coordinatorGeneration`, which is also the spelling `GET /projects/:id` already serves
   (`src/apiserver/src/projects/projects.service.ts:228`).
4. **The `workspace`/`agent` mirror.** `WorkspaceAliasInterceptor`
   (`src/apiserver/src/common/workspace-alias.interceptor.ts:22`) copies `workspaceId`↔`agentId`,
   `workspaceName`↔`agentName`, `workspace`↔`agent` **between siblings of one object**, adding
   whichever half is missing (`workspace-alias.interceptor.ts:45`). So a `workspaceId` emitted without an `agentId` beside it
   comes back with `agentId` silently set to the *workspace's* id. Two consequences, both binding:
   - inside `coordination`, all four of `workspaceId` / `workspaceName` / `agentId` / `agentName`
     are **always emitted**, `null` when absent — the interceptor only fills a name that is
     *missing*, so an explicit `null` suppresses it;
   - inside `openability.landing`, `agentId` and `agentName` are emitted as **constant `null`**
     for exactly that reason. A landing is a place, not an identity, and the interceptor would
     otherwise invent one.
5. **Error bodies are not rewritten by the interceptor** — they go through
   `PublicIdExceptionFilter` instead. This endpoint's refusals carry no ids at all, which is the
   same choice `coordinatorUnavailable` already makes
   (`src/apiserver/src/projects/projects.service.ts:1764`).

## The payload

```jsonc
{
  "projectId": "34CVrUINmbGw6RWddCF0v",
  "readAt": "2026-08-24T07:00:00.000Z",
  "state": "LIVE",

  "coordination": {
    "sessionId": "6ZARyvpxHyfZorIuHMx1I4",
    "sessionIdAbsentReason": null,
    "session": { "…": "see below" },
    "sessionAbsentReason": null,
    "coordinatorGeneration": "0",

    "workspaceId": "3CuIHiSJZBQ7nLVUwc7ekz",
    "workspaceIdAbsentReason": null,
    "workspaceName": "orbit",
    "workspaceNameAbsentReason": null,
    "agentId": "3CuIHiSJZBQ7nLVUwc7ekz",
    "agentIdAbsentReason": null,
    "agentName": "orbit",
    "agentNameAbsentReason": null
  },

  "openability": {
    "canOpen": true,
    "willCreate": false,
    "refusalCode": null,
    "refusalDetail": null,
    "refusalCodeAbsentReason": "NOTHING_REFUSES",
    "requiredAction": null,
    "requiredActionAbsentReason": "NOTHING_REFUSES",
    "landing": {
      "workspaceId": null,
      "workspaceIdAbsentReason": "COORDINATOR_ALREADY_LIVE",
      "workspaceName": null,
      "workspaceNameAbsentReason": "COORDINATOR_ALREADY_LIVE",
      "agentId": null,
      "agentName": null,
      "fixed": true
    }
  }
}
```

### Envelope

| Field | Type | Wire | Source | `absentReason` values |
| --- | --- | --- | --- | --- |
| `projectId` | uuid | base62 string (`PUBLIC_ID_FIELDS`, `src/shared/src/codec.ts:158`) | `project.id` — `src/apiserver/prisma/schema.prisma:1452` | never absent |
| `readAt` | `Date` | ISO-8601 string | `new Date()` taken once at the top of the handler | never absent |
| `state` | enum | `"NEVER_OPENED" \| "LIVE" \| "TRASHED" \| "UNAVAILABLE"` | derived — the truth table in [The four states](#the-four-states); the branches it mirrors are `coordinator()` `src/apiserver/src/projects/projects.service.ts:1522` and `coordinatorLanding()` `:1714` | never absent |

`state` is the one derivation this endpoint owns. It is a *project-coordination* bucket, not a
session run state — see the next section for why that distinction matters.

### `coordination`

| Field | Type | Wire | Source | `absentReason` values |
| --- | --- | --- | --- | --- |
| `sessionId` | uuid? | base62 string or `null` (`codec.ts:71`) | `project.coordinator_session_id` — `schema.prisma:1493` | `COORDINATOR_NEVER_OPENED`, `COORDINATOR_SESSION_PURGED` |
| `session` | object? | object or `null` (fields below) | the `session` row `coordinator_session_id` points at | same two values as `sessionId` |
| `coordinatorGeneration` | `BigInt` | **decimal string** (`main.ts:22`) | `project_runtime.coordinator_generation` — `schema.prisma:1689`; maintained only by the DB trigger `project_coordinator_rotation_count` (`prisma/migrations/0113_project_coordinator_final_row/migration.sql:247`, counting rule at `:144`) | never absent — a project with no `project_runtime` row reads `"0"`, the same fallback `withCoordination` already takes (`projects.service.ts:228`) |
| `workspaceId` | uuid? | base62 string or `null` (`codec.ts:78`) | `project.coordinator_workspace_id` — `schema.prisma:1511` | `NO_COORDINATION_WORKSPACE`, `COORDINATION_WORKSPACE_PURGED` |
| `workspaceName` | string? | string or `null` | `workspace.name` — `schema.prisma:558`, joined on `coordinator_workspace_id` | `NO_COORDINATION_WORKSPACE`, `COORDINATION_WORKSPACE_PURGED`, `COORDINATION_WORKSPACE_TRASHED` |
| `agentId` | uuid? | base62 string or `null` (`codec.ts:186`) | the `COORDINATOR` `project_member.agent_id` — `schema.prisma:1656`, role at `:1658`; the same one-row lateral `COORDINATION_INCLUDE` reads (`projects.service.ts:197`) | `NO_COORDINATOR_AGENT` |
| `agentName` | string? | string or `null` | `workspace.name` — `schema.prisma:558`, joined on that member's `agent_id` | `NO_COORDINATOR_AGENT` |

Notes that are part of the contract, not commentary:

- **`COORDINATOR_NEVER_OPENED` vs `COORDINATOR_SESSION_PURGED`.** The pointer is `null` in both.
  They are told apart by `coordinator_workspace_id`, **not** by the generation: both columns are
  written in the *same* statement whenever a coordinator is bound
  (`projects.service.ts:1634`, and `:407-408` for a project recorded from inside a session), and
  only a session **hard**-delete empties the pointer — `onDelete: SetNull` on
  `schema.prisma:1494`, reachable through `sessions.purge`
  (`src/apiserver/src/sessions/sessions.service.ts:4939`). A soft delete (Trash) leaves the pointer
  standing, which is the `TRASHED` state, not this one.
  Rule: `sessionIdAbsentReason = COORDINATOR_SESSION_PURGED` when
  `coordinator_workspace_id IS NOT NULL OR coordinator_generation > 0`, else
  `COORDINATOR_NEVER_OPENED`. The generation is the fallback for the one case where the workspace
  was hard-deleted too. This is stricter than the deleted contract, which keyed the whole
  distinction on `generation > 0` — wrong for a project whose *first* coordinator was purged,
  because a first bind is generation 0 by design (`0113_project_coordinator_final_row/migration.sql:134-139`).
- **`COORDINATION_WORKSPACE_PURGED` vs `COORDINATION_WORKSPACE_TRASHED`.** `coordinator_workspace_id`
  is `SET NULL` on workspace hard-delete (`schema.prisma:1512`) and untouched by the soft delete
  (`workspace.deleted_at`, `schema.prisma:636`). So a `null` id is PURGED; a non-null id whose
  workspace row has `deleted_at` set is TRASHED, and the id is still served because it is what the
  owner needs in order to restore it.
- **`agentId` may be absent while `workspaceId` is present.** The trigger deletes the coordinator
  membership when the landing can no longer carry an identity (`0113_project_coordinator_final_row/migration.sql:195-203`). That is a
  real state, and it is why the four alias-mirrored names must all be emitted explicitly (rule 4).

### `coordination.session`

`null` unless `coordination.sessionId` is non-null.

| Field | Type | Wire | Source | `absentReason` values |
| --- | --- | --- | --- | --- |
| `id` | uuid | base62 string (`codec.ts:68`) | `session.id` | never absent within this object |
| `title` | string | string | `session.title` — `schema.prisma:770` | never absent (non-nullable column) |
| `runStatus` | enum | `RunStatus` string | `session.status` — `schema.prisma:863` | never absent |
| `runState` | enum | `SessionRunState` string | **`deriveSessionRunState`** — `src/shared/src/enums.ts:130` | never absent |
| `lifecycleState` | enum | `SessionLifecycleState` string | **`deriveSessionLifecycleState`** — `src/shared/src/enums.ts:161` | never absent |
| `filingState` | enum | `SessionFilingState` string (deprecated mirror) | **`deriveSessionFilingState`** — `src/shared/src/enums.ts:171` | never absent |
| `endReason` | string? | string or `null` | `session.end_reason` — `schema.prisma:898` | `SESSION_NOT_ENDED` |
| `startedAt` | `Date?` | ISO string or `null` | `session.started_at` — `schema.prisma:889` | `SESSION_NEVER_STARTED` |
| `finishedAt` | `Date?` | ISO string or `null` | `session.finished_at` — `schema.prisma:890` | `SESSION_STILL_RUNNING` |
| `completedAt` | `Date?` | ISO string or `null` | `session.completed_at` — `schema.prisma:1017` (legacy mirror `archived_at` at `:1019`) | `SESSION_NOT_COMPLETED` |
| `deletedAt` | `Date?` | ISO string or `null` | `session.deleted_at` — `schema.prisma:1020` | `SESSION_NOT_TRASHED` |
| `engineTurnActive` | bool | bool | `session.engine_turn_active` — `schema.prisma:934` | never absent (non-nullable, default `false`) |
| `pendingApprovals` | int | number | `COUNT(*)` over `approval` where `session_id` matches and `status = 'PENDING'` — `schema.prisma:1272`/`:1278`, indexed at `:1293`; the same count the session list makes at `src/apiserver/src/sessions/sessions.service.ts:2022-2027`, and gated the same way on `isSessionGenerating` (`src/apiserver/src/common/session-generating.ts:17`) | never absent — `0` when the session is not generating |

**The three derived state fields are produced by `withSessionState`**
(`src/apiserver/src/sessions/session-state.ts:109`), which is the single wrapper every other
Session payload goes through — `sessions.service.ts:722`, `:1163`, `:1229`. This endpoint calls it
with the raw row and takes `runState` / `lifecycleState` / `filingState` from the result.
**No second mapping is written**, for the reason the deleted implementation gave in its own words
(`0a3cb3c8:src/apiserver/src/projects/projects.service.ts:1523`): "a second mapping here is a
second answer to *is it finished*".

The card's three live sub-states are a **client-side** read of these fields, not a fifth server
enum:

| Card shows | Predicate |
| --- | --- |
| Working | `runState === "RUNNING"` \|\| (`runState === "AWAITING_INPUT"` && `engineTurnActive`) — i.e. `isSessionGenerating` |
| Needs you | `pendingApprovals > 0` \|\| (`runState === "AWAITING_INPUT"` && `!engineTurnActive`) |
| Idle | anything else with `lifecycleState !== "TRASH"` — `QUEUED`, `SUCCEEDED`, `FAILED`, `INTERRUPTED`, `ENDED` |

`FAILED` sits under Idle on purpose: `coordinator()` reuses a FAILED coordinator rather than
replacing it (`projects.service.ts:1512-1514`), so it is a conversation to reopen, not a dead one.

### `openability`

What `POST /projects/:id/coordinator` would do if pressed right now. Every field is a projection of
the branches in `coordinator()` (`projects.service.ts:1522`) and `coordinatorLanding()` (`:1714`).

| Field | Type | Wire | Source | `absentReason` values |
| --- | --- | --- | --- | --- |
| `canOpen` | bool | bool | derived — `refusalCode === null` | never absent |
| `willCreate` | bool | bool | derived — `false` on the reuse branch (`projects.service.ts:1558`), `true` otherwise | never absent |
| `refusalCode` | enum? | `"COORDINATOR_UNAVAILABLE" \| "NO_LANDING_WORKSPACE" \| null` | `COORDINATOR_UNAVAILABLE_CODE` — `projects.service.ts:52`, thrown at `:1591`/`:1729`/`:1736`; `NO_LANDING_WORKSPACE` is the read's name for the `BadRequestException` at `:1742` | `NOTHING_REFUSES` |
| `refusalDetail` | enum? | `"WORKSPACE_TRASHED" \| "WORKSPACE_DISABLED" \| "WORKSPACE_UNBOUND" \| "WORKSPACE_FORGOTTEN" \| "NO_TASK_ASSIGNEE" \| null` | see the mapping below | none of its own — it is a refinement of `refusalCode` and is null exactly when that is, so it shares `refusalCodeAbsentReason` rather than carrying a second one |
| `requiredAction` | string? | string or `null` | the same sentence `coordinatorUnavailable` puts in its refusal body (`projects.service.ts:1771-1773`), and for `NO_LANDING_WORKSPACE` the sentence at `:1743-1744` | `NOTHING_REFUSES` |
| `landing.workspaceId` | uuid? | base62 string or `null` (`codec.ts:78`) | fixed branch: `lastCoordinatorWorkspace` (`projects.service.ts:1820`); free branch: `busiestAssignee` (`:1844`) | `COORDINATOR_ALREADY_LIVE`, `LANDING_REFUSED` |
| `landing.workspaceName` | string? | string or `null` | `workspace.name` — `schema.prisma:558` | `COORDINATOR_ALREADY_LIVE`, `LANDING_REFUSED` |
| `landing.agentId` | `null` | always `null` | constant — suppresses the alias mirror (rule 4) | not applicable; the field is the suppression |
| `landing.agentName` | `null` | always `null` | constant — same reason | not applicable |
| `landing.fixed` | bool | bool | `true` when `coordinator_workspace_id` is set — the `fixed` flag `coordinatorLanding` returns (`projects.service.ts:1733`) | never absent |

`refusalDetail` mapping, in the order `coordinatorLanding` evaluates:

| Condition (all read-only) | `refusalCode` | `refusalDetail` |
| --- | --- | --- |
| `coordinator_workspace_id` set, its `workspace.deleted_at` is not null | `COORDINATOR_UNAVAILABLE` | `WORKSPACE_TRASHED` |
| `coordinator_workspace_id` set, `workspace.enabled = false` (`schema.prisma:595`) | `COORDINATOR_UNAVAILABLE` | `WORKSPACE_DISABLED` |
| `coordinator_workspace_id` set, workspace live and enabled, `workspace.runner_id IS NULL` (`schema.prisma:588`) | `COORDINATOR_UNAVAILABLE` | `WORKSPACE_UNBOUND` |
| `coordinator_workspace_id` null **and** `coordinator_session_id` not null | `COORDINATOR_UNAVAILABLE` | `WORKSPACE_FORGOTTEN` |
| both pointers null and `busiestAssignee` finds nothing | `NO_LANDING_WORKSPACE` | `NO_TASK_ASSIGNEE` |

The first two come from `lastCoordinatorWorkspace`'s `deletedAt: null, enabled: true` filter
(`projects.service.ts:1830`) returning nothing. The third is not decided in
`coordinatorLanding` at all — it is `sessions.create` refusing with
`'pick a workspace bound to a runner, or pass assignedRunnerId'`
(`src/apiserver/src/sessions/sessions.service.ts:515`), which `coordinator()` catches and
translates to `COORDINATOR_UNAVAILABLE` **on the fixed branch only** (`projects.service.ts:1589-1596`).

**Honesty clause.** `openability` is a **prediction from committed rows**, and the POST is what
decides. It is exact for every condition above, because every one of them is a column this read
selects. It cannot see a workspace that is disabled *between* this read and the press, and it does
not model refusals that are not about the landing (a provider that is not configured,
`sessions.service.ts:539`). A client must still handle a 409 or 400 from the POST; this field
exists so the common cases are visible before the press, not so the press becomes infallible.

`ELSEWHERE` (`projects.service.ts:1860`) — the 409 for asking to open in a *different* workspace —
is deliberately not modelled. It is a property of the request body, not of the project, and this
endpoint takes no body.

## The four states

`state` is decided by four facts, all of them columns this read already selects:

- **P** = `project.coordinator_session_id` (`schema.prisma:1493`)
- **T** = the pointed-at `session.deleted_at` is not null (`schema.prisma:1020`)
- **W** = `project.coordinator_workspace_id` (`schema.prisma:1511`)
- **U** = the landing is usable — `W` names a workspace of this owner with `deleted_at IS NULL`,
  `enabled = true` (`projects.service.ts:1830`) and `runner_id IS NOT NULL` (`schema.prisma:588`)

| P | T | W | U | `state` | Mirrors |
| --- | --- | --- | --- | --- | --- |
| set | no | – | – | `LIVE` | the reuse branch, `projects.service.ts:1545` — it returns the bound session and never consults the landing |
| set | yes | set | yes | `TRASHED` | falls through to `coordinatorLanding`, which returns `{fixed: true}` |
| set | yes | set | no | `UNAVAILABLE` | `projects.service.ts:1729` / the translated `sessions.create` refusal at `:1591` |
| set | yes | null | – | `UNAVAILABLE` | `projects.service.ts:1735-1737` — "no longer records the workspace its coordinator ran in" |
| null | – | set | yes | `TRASHED` | the session was purged; `W` survives, so the replacement is still fixed |
| null | – | set | no | `UNAVAILABLE` | same two branches as above |
| null | – | null | – | `NEVER_OPENED` | the free branch, `projects.service.ts:1740` — `canOpen` then turns on whether `busiestAssignee` finds anything |

`TRASHED` covers both "the conversation is in Trash" and "the conversation was purged out of
Trash": in both, this project *has* had a coordinator, it is not reachable, and the next open makes
a replacement in a workspace that is already decided. `sessionId` / `sessionIdAbsentReason` carry
the finer distinction, and only the first of the two can be restored.

`UNAVAILABLE` cannot co-occur with `LIVE`, because the reuse branch never reaches the landing —
a live coordinator in a workspace that was disabled underneath it still opens.

### What each state needs

| | `NEVER_OPENED` | `LIVE` | `TRASHED` | `UNAVAILABLE` |
| --- | --- | --- | --- | --- |
| `state` | ✓ | ✓ | ✓ | ✓ |
| `coordination.sessionId` + reason | reason | ✓ | ✓ in Trash, reason once purged | ✓ / reason |
| `coordination.session.*` | – | ✓ (all) | `id`, `title`, `lifecycleState`, `deletedAt` in Trash, else – | the same four when a trashed pointer survives, else – |
| `coordination.coordinatorGeneration` | ✓ | ✓ | ✓ | ✓ |
| `coordination.workspaceId` + reason | reason | ✓ | ✓ | ✓, except `WORKSPACE_FORGOTTEN` → reason |
| `coordination.workspaceName` + reason | reason | ✓ | ✓ | ✓, except `WORKSPACE_FORGOTTEN` → reason |
| `coordination.agentId` / `agentName` + reasons | reasons | ✓ | ✓ | ✓ or reasons — the trigger drops the membership when the landing cannot carry one |
| `openability.canOpen` / `willCreate` | ✓ | ✓ | ✓ | ✓ |
| `openability.refusalCode` / `refusalDetail` / `requiredAction` | ✓ when `NO_LANDING_WORKSPACE`, else reasons | reasons | reasons | ✓ |
| `openability.landing.*` | ✓, or reasons when `NO_LANDING_WORKSPACE` | reasons | ✓ | reasons |

Read as: ✓ = a value the card renders; "reason" = the field is emitted carrying its
`absentReason` instead of a value; – = emitted as `null` with its reason and unused by that
state's layout. Nothing is ever omitted from the body — that is the whole point of the idiom.

Per state, in words:

- **`NEVER_OPENED`** — "No coordinator yet." Button reads *Start coordinator*. It needs
  `openability.landing.workspaceName` to say **where** it will open, and
  `refusalCode = NO_LANDING_WORKSPACE` + `requiredAction` for the project that has no assignee to
  borrow a workspace from, where the button would 400.
- **`LIVE`** — links to `coordination.sessionId` and labels itself from `session.title`. The three
  sub-states come from `runState` / `engineTurnActive` / `pendingApprovals` as tabulated above.
  `agentName` and `workspaceName` say who coordinates and where.
- **`TRASHED`** — "The coordinator conversation is in Trash." Two affordances: restore
  `coordination.sessionId` (when it is non-null), or open a replacement, which
  `openability.landing` already names and `landing.fixed = true` says cannot be redirected.
- **`UNAVAILABLE`** — `refusalDetail` picks the sentence and the affordance:
  `WORKSPACE_DISABLED` → enable it (an endpoint exists, below); `WORKSPACE_TRASHED` → restore it;
  `WORKSPACE_UNBOUND` → bind it to a runner; `WORKSPACE_FORGOTTEN` → rebind, **for which no
  endpoint exists**. `coordination.workspaceId` / `workspaceName` name the workspace in the first
  three; in the fourth they are `null` with reason `COORDINATION_WORKSPACE_PURGED`, which is
  precisely why that case has nothing to offer.

## Deliberately excluded

Every field of the deleted contract that is **not** carried forward, with the one-line reason.
Section names are the deleted implementation's own
(`git show 0a3cb3c8:src/apiserver/src/projects/projects.service.ts:1273-1438`).

| Dropped | Why |
| --- | --- |
| `decisions[]`, `decisionsEmptyReason` | reads `project_decision`, a table that **no longer exists** — dropped in migration `0163_drop_control_loop_tables/migration.sql:60`. |
| `pendingActions[]`, `pendingActionsEmptyReason` | reads `project_action`, which survives (`schema.prisma:1744`) but lost `decision_id` (`0163_drop_control_loop_tables/migration.sql:54`) and has no writer left — its one remaining reader is `src/apiserver/src/tasks/verification-epoch-read.ts:153`. |
| `events{pending,recent}` | reads `project_event`, a table that **no longer exists** — dropped in migration `0164_drop_project_event_outbox/migration.sql:50`. |
| `nextWake{at,reason,candidates,flooredBy,decisionId}` | the scheduled-wake timer was the loop; nothing fires now, and the candidates were read back out of `project_decision.outcome`, whose table is gone. |
| the whole activity feed (`GET :id/panorama/activity`) | deleted with its module in `68a58d93`; a card frozen for good reads worse than no card. |
| dispatch health (`GET :id/panorama/dispatch-health`) | its endpoint went with the loop; the file was deleted in `68a58d93`. |
| `runtime.lease{expiresAt,heartbeatAt,fencingToken}`, `leaseAbsentReason` | the lease is the loop's mutual exclusion between passes. No passes, no lease. |
| `runtime.runState`, `runtime.fencingToken`, `runtime.acceptanceAttempt` | `project_runtime` columns only the loop advanced; nothing moves them now, so serving them would be serving a constant. |
| `coordination.identitySource` | `DERIVED` vs `EXPLICIT` is an input to the reconcile trigger, not something any of the four states branches on. |
| `policy{coordinatorEnabled,automationPolicy,configRevision,maxConcurrentTasks,sessionBudgetPerDay}` | already served by `GET /projects/:id` — `projects.service.ts:564` spreads the whole project row through `withCoordination` (`:215`). Duplicating it here creates two answers to one question. |
| `consumption{tasksInFlight,concurrencyRemaining,coordinatorSessionsLast24h,budgetRemaining,budgetWindowStartedAt}` | these existed to be compared against `policy` by the admission gates. The gates are gone. |
| `project{title,status,createdAt,updatedAt,taskCount,tasksByStatus}` | `GET /projects/:id` serves all of it, `tasksByStatus` at `projects.service.ts:578`. |
| `blockers{open,resolved}` | `project_blocker` still has readers (`project-acceptance.service.ts:583`, `project-attribution.service.ts:121`) but no writer since the loop; and none of the four states turns on one. |
| `acceptance{criteria,attempt,run,doneGate,lastRun,mergeReceipts,evidence}` | `GET /projects/:id/acceptance` is the endpoint for this (`projects.controller.ts:231`), and it is about the project's goal, not its coordinator. |
| `acceptance.evidence.undeliveredMentions` | the @-mention delivery ledger — a different subject with a different addressee. |
| `publicDedupeKey` / `publicIdempotencyKey` handling | both existed to strip UUIDs out of `project_event.dedupe_key` and `project_action.idempotency_key`. No such string is served here. |
| `lease_holder` | not served then, not served now: it is a compare-and-swap fence, listed in `NEVER_PUBLIC_ID_FIELDS` (`src/shared/src/codec.ts:228`). |

## The three actions the card needs

### 1. Enable a disabled workspace — **exists**

`PATCH /api/workspaces/:id` (the controller is mounted on both `workspaces` and `agents`,
`src/apiserver/src/workspaces/workspaces.controller.ts:26`; route at `:60`), body `{"enabled": true}`.

- DTO field: `src/apiserver/src/workspaces/dto.ts:83`
- Write: `src/apiserver/src/workspaces/workspaces.service.ts:262`, the column at `:274`
- The column: `workspace.enabled`, `src/apiserver/prisma/schema.prisma:595`

This clears `refusalDetail = WORKSPACE_DISABLED` and nothing else. It does **not** restore a
trashed workspace and does not bind one to a runner.

### 2. List selectable workspaces — **exists**

`GET /api/workspaces` (alias `GET /api/agents`), `src/apiserver/src/workspaces/workspaces.controller.ts:35`;
service at `src/apiserver/src/workspaces/workspaces.service.ts:148`.

Returns the owner's workspaces with `deletedAt: null`, in sidebar order, with the runner included.
Two caveats for a picker built on it:

- it does **not** filter to *usable* — disabled rows and rows with `runnerId: null` are in the
  list, so the picker must apply `enabled === true && runnerId != null` itself, which is the same
  predicate `openability` uses;
- there is no per-project variant. "Where this project's work already runs" is
  `busiestAssignee` (`src/apiserver/src/projects/projects.service.ts:1844`), which is private to
  the service and is surfaced only as `openability.landing`.

### 3. Rebind the coordination workspace — **does not exist**

There is no endpoint that changes `project.coordinator_workspace_id` on a project that already has
one. The evidence:

- the column has exactly two writers, both of which *bind* rather than *rebind*:
  `createProjectInSession` (`src/apiserver/src/projects/projects.service.ts:408`) and the
  compare-and-swap in `coordinator()` (`:1634`), which only fires when the pointer was null or
  trashed;
- `UpdateProjectDto` has no `coordinatorWorkspaceId` — `src/apiserver/src/projects/dto.ts:97-181`;
- `POST /projects/:id/coordinator` refuses a different workspace with a 409 rather than moving one:
  `ProjectsService.ELSEWHERE`, thrown at `projects.service.ts:1554`, `:1680` and `:1724`, text at
  `:1860`. `coordinatorLanding`'s own doc comment states the rule — §7.5 freezes a rotation as
  "the SESSION is replaced; the agent and the workspace are not" (`:1691-1712`).

**The nearest existing thing is not a substitute.** `PATCH /projects/:id` accepts
`coordinatorAgentId` (`src/apiserver/src/projects/dto.ts:141`, resolved at
`projects.service.ts:988-990`, which also flips `coordinator_identity_source` to `EXPLICIT` at
`:1405`). That moves **who** coordinates. It does not touch `coordinator_workspace_id`, so it does
not clear `COORDINATOR_UNAVAILABLE`: `lastCoordinatorWorkspace` still reads the old column
(`projects.service.ts:1830`).

Consequence for the redesign: in the `WORKSPACE_FORGOTTEN` case there is **nothing the UI can
offer**, and in `WORKSPACE_TRASHED` / `WORKSPACE_UNBOUND` the only route out is repairing the named
workspace. If the card is to offer "move this coordinator", that endpoint has to be designed and
built; it is out of this contract's scope and is not assumed anywhere above.
