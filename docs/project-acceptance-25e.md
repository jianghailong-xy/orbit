# 25E — Independent project acceptance of the Coordinator control loop

A fresh Claude session, a fresh worktree, a fresh database, and no reuse of what 25A–25D
concluded. What follows is what this run *observed*; where an earlier round's answer and this
one's differ, this file records the observation, not the reconciliation.

**Verdict: FAIL — 11 of 12 criteria pass, clause 6 does not.** The project stays OPEN.

## What was reviewed

| | |
|---|---|
| Review branch | `orbit/25e-claude-main-43e0c1` @ `2a9e7389071be0f6b04f8851bd8889dbe09e0f79` |
| Aligned to | `feat/project` @ `2a9e7389071be0f6b04f8851bd8889dbe09e0f79` (`git merge --ff-only`, no-op fast-forward) |
| `main` | `54744005f6aa8cb82146b51a6e9a7d6fd87d4b0c` — unchanged for the whole run |
| Deployed apiserver | image `orbit-apiserver`, created 2026-08-21T10:47:51Z, 144 migrations applied (…0127, 0128, 0129) |
| Environment | node v22.22.2, npm 10.9.7, go1.24.4, PostgreSQL 16-alpine (disposable) / 17.11 client, Linux 6.12.38 |

The baseline gate was executed before anything else. `feat/project` already contained `main`
(`git merge-base main feat/project` = `54744005…`, `git rev-list --left-right --count main...feat/project`
= `0 21`), so the rebase gate was a verified no-op and the review branch was fast-forwarded onto
`feat/project` from a clean worktree. No `reset`, no `stash`, no `update-ref` was used at any point.

## Test evidence

Every suite was run from this worktree against a private `node_modules` (per-entry symlinks) and a
Prisma client generated from *this* branch's schema, so nothing was measured against `main`'s build.

| Suite | Result |
|---|---|
| `tsc -p tsconfig.test.json` (apiserver) | rc=0 — clean, where `main` still fails to compile |
| apiserver unit specs (227 files) | **2100 tests, 2075 pass, 0 fail, 25 skipped** |
| apiserver pg matrix (`scripts/project-pg-matrix.sh`, 34 specs) | **350 tests, 350 pass, 0 fail, 0 skipped, 0 spec-level red** |
| `task-supersession.pg.spec` + `task-verification-doors.pg.spec` (cut off by the harness; re-run on a fresh DB) | **26 tests, 26 pass, 0 fail** |
| `src/web` vitest | **58 files, 838 tests, all pass** |
| `src/shared` vitest | **12 files, 141 tests, all pass** |
| `go build ./...` + `go test ./...` (runner-go) | rc=0 / `ok orbit 81.5s` |

Each pg spec ran on its own database cloned from a freshly migrated template (144 migrations) on a
disposable `postgres:16-alpine` the run provisioned and destroyed.

## The twelve criteria

Checks marked *live* were executed against the running deployment through the `feat/project`
runner CLI built from this branch, on a throwaway canary project (`25E acceptance canary`,
`34Axukmp27kqR6IcbAXCu`) created for the purpose.

**1 — Coordinator identity, workspace, rotatable session, Base62. PASS.**
`project status` reports `agentId`/`workspaceId`/`sessionId`/`generation` with
`identitySource: DERIVED`. Four live payloads (`project status`, `project acceptance`,
`project verifications`, `project blockers`) were scanned for raw UUIDs: **zero** matches of
`[0-9a-f]{8}-…-[0-9a-f]{12}`. Production has applied `ROTATE_COORDINATOR_SESSION` once.
`agent-identity-migration`, `agent-persistence`, `coordinator-identity` specs green.

**2 — Reliable event delivery, idempotent under duplication/reordering/restart. PASS.**
Live `project_event`: `unconsumed=0`, `retried=0`, `max(occurrences)=18` — duplicates collapse onto
one row by `dedupe_key` rather than replaying. Every canary event reached
`disposition=RECONCILED`. `project-events` 7/7, `project-events-fault-injection` 5/5,
`project-reconcile-fault-injection` 7/7.

**3 — Testable liveness: start the next task, or persist a reason. PASS (live).**
A task was filed into the canary with no manual start. Within 10 s the loop applied
`DISPATCH_TASK` under `pc:v1:34Axukmp27kqR6IcbAXCu:dispatch:34Ay6oDCwhGjQcxNeiRuC:0`; the session
ran, commented, closed its task and ended **naturally** — `runStatus: SUCCEEDED`,
`endReason: task_done`. The other branch was observed too: while blocked, the project persisted a
blocker carrying `owner`, `requiredAction`, `nextCheckAt` and `recovery`, and scheduled
`timer.due` wakes. Neither state was silent idling.

**4 — manual / guarded-auto / auto, with explicit boundaries; guarded-auto by default. PASS (live).**
A project created during this run came back `coordinatorEnabled: true`,
`automationPolicy: GUARDED_AUTO`, `maxConcurrentTasks: 3`. Every one of the nine projects created
since the feature shipped carries `t / GUARDED_AUTO` in the production database.
`project-authorization`, `project-dispatch-boundary`, `project-dispatch-boundary-verification`
(17/17) and `project-dispatch-pass` (14/14) green.

**5 — Consistent snapshot, and a decision ledger with idempotency keys. PASS (live).**
Canary decisions carry `decisionInputHash`, `fencingToken`, `configRevision`, `nextWakeAt`,
`nextWakeReason` and their actions. Production `project_action` shows `RAISE_BLOCKER` 10,
`CLEAR_BLOCKER` 6, `DISPATCH_TASK` 4 applied + 1 **refused**, `ROTATE_COORDINATOR_SESSION` 1 —
refusals are recorded, not swallowed.

**6 — A failed verification must natively revert its subject, file a defect subtask, or block
downstream. FAIL — see below.**

**7 — Aggregate completion policies. PASS (live).**
`ALL_CHILDREN_DONE`: parent went OPEN → DONE when both children completed, back to OPEN when one
reopened, and DONE again when it re-completed — with no status write on the parent.
`VERIFICATION_PASSED`: parent stayed OPEN with its only child DONE, and completed only once a PASS
verdict was written. `task-aggregation` 25/25, `task-verification-doors` 13/13.

**8 — Structured blockers with dedupe and escalation, no silent fallback. PASS (live).**
The FAIL raised `VERIFICATION_FAILED` / `CRITICAL` / owner `COORDINATOR` / recovery `EVENT`, with
`requiredAction`, `nextCheckAt`, `conditionVersion` and
`dedupeKey=VERIFICATION_FAILED:TASK:34AxvFGxaauQN6VieiWL1`. Seventeen occurrences collapsed onto
**one** row (`lifecycle_generation` 1), and the later PASS resolved it with `resolved_by=AUTO`.
`project-blocker` 15/15.

**9 — Recovery after crash, session end, runner offline, takeover, mixed versions. PASS.**
`project-e2e-recovery` 18/18, `project-reconcile-fault-injection` 7/7 (SIGKILL injected mid-pass),
`coordinator-service-linearization` 9/9, `coordinator-linearization` 44/44,
`project-coordinator-driver` 6/6. The dispatch-boundary spec's restart case ran for real against a
restartable container rather than reporting `# SKIP`.

**10 — Web / API / CLI surfaces, and independently runnable test tiers. PASS, with one note.**
The CLI built from this branch exposes `project status|blockers|verifications|acceptance|
acceptance-run|acceptance-verdict|merge-evidence` and all of them answered live. The API serves
`/projects/:id/{coordinator/status,blockers,verifications,acceptance,acceptance/runs,…}`. Web:
838 tests over `ProjectCoordinatorPanel`, `coordinatorStatus`, `taskOutcome`. Unit, pg, fault
injection and migration tiers each run standalone.
*Note:* the CLI **installed on this host** is the released 0.1.129 and does not carry the
acceptance commands — a release-lag fact about the shipped binary, not a defect in this branch.
*Note:* the `failures` and `blockedTasks` fields of the verifications surface are structurally
unreachable in production — a consequence of clause 6, counted there and not twice.

**11 — Existing projects stay compatible and are not silently automated. PASS (live).**
All six projects that predate the feature are still `coordinator_enabled=f, automation_policy=MANUAL`,
this project among them. Turning a coordinator on without naming a policy is refused
(`projects.service.ts`), so the migration left the choice with the owner.

**12 — Project acceptance and merge check gate DONE. PASS (mechanism, live).**
`PATCH` of `status=DONE` on a project with no acceptance run was refused **409
`ACCEPTANCE_MISSING`** — "DONE is a claim about evidence, and there is none" — naming `owner`,
`requiredAction` and `acceptanceDigest`. The criteria decompose into 12 addressable rows with
stable `criterionKey`s, and a run's verdict is derived from them rather than supplied. This run
opened an attempt and answered all twelve; the merge state was recorded as merge evidence and a
session merge receipt.

## The finding — P1, clause 6

**A verification FAIL never reverts its subject, never files a defect subtask, and never blocks
downstream, because nothing in production applies the plan.**

`ProjectVerificationVerdictService.apply` is the one path that writes those three consequences
(`task_verification_failure`, the reverted subject, the defect subtask). It is declared in
`projects.module.ts`, and its only callers anywhere in the tree are `project-e2e-harness.ts`,
`task-verification-verdict.pg.spec.ts` and `project-e2e-acceptance.pg.spec.ts` — test code. No
controller, service or reconcile pass injects it.

`ProjectDecisionService` *does* compute the plan — `verificationVerdicts: verificationVerdictPlan(input)`
at `project-decision.service.ts:1394` — and it is persisted with the decision. But
`ProjectReconcileService` applies only `outcome.coordinator`, `outcome.aggregations` and
`outcome.blockers` (`project-reconcile.service.ts:346-348`). `outcome.verificationVerdicts` is read
by exactly one thing, `verificationConditions` in `project-blocker-conditions.ts`, which raises the
blocker. The revert, the defect and the downstream block are computed, stored, and dropped.

Observed live, end to end:

1. Subject task DONE, downstream task depending on it, verification task pointed at the subject.
2. `--verdict FAIL` written through the CLI → `verdict: FAIL`, `verdictRevision: 1`.
3. After reconcile (`disposition: RECONCILED`, 5 decisions): subject **still DONE**, **no** defect
   subtask, `failures: []`, `blockedTasks: []`. Only the blocker appeared.

Confirmed against the production database, all-time:

```
SELECT count(*) FROM task_verification_failure;              ->  0
SELECT verdict, count(*) FROM task WHERE verdict IS NOT NULL ->  FAIL 2, PASS 6
SELECT type, status, count(*) FROM project_action GROUP BY 1,2
   ->  RAISE_BLOCKER/APPLIED 10, CLEAR_BLOCKER/APPLIED 6,
       DISPATCH_TASK/APPLIED 4, DISPATCH_TASK/REFUSED 1,
       ROTATE_COORDINATOR_SESSION/APPLIED 1
```

Eight verdicts have been concluded in this deployment and the failure table has never held a row.

This is the same failure shape the tree has already been bitten by once and documented — the header
of `task-verification-doors.pg.spec.ts` says so about `planTaskAggregation`: *"complete, correct and
applied in exactly one place: inside a reconcile … So a phase parent set to ALL_CHILDREN_DONE sat at
OPEN"*. Aggregation was given a write-path applier (`task-aggregation-writer.ts`) and 25D gave
dispatch one (`project-dispatch-pass.service.ts`). The verdict pass never got its own, so the specs
that cover it are green while the behaviour is unreachable — which is precisely what clause 6's
"不得只依赖提示词约定" is guarding against.

Why it matters beyond the clause: `GET /projects/:id/verifications` reads `task_verification_failure`
for both `failures` and `blockedTasks`. With no writer, both are permanently empty, so the surface a
coordinator is supposed to read before dispatching cannot report an unresolved failure — and a
downstream task whose upstream check failed dispatches anyway.

Not fixed here: this is an acceptance run, and the audit branch may not carry the change it is
judging. Filed as a defect subtask under this task.

## Residue

`pcc25e-matrix-pg16` and `pcc25e-tail-pg16` were provisioned and destroyed; **zero** `pcc25e-*`
containers, networks or volumes remain. The `pcc02b-pg` container still running belongs to a
different session working concurrently in another worktree and was deliberately left alone. The
canary project and its tasks are left in terminal states as the evidence for this report.
