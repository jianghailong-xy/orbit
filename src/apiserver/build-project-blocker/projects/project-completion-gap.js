"use strict";
/**
 * §13.1 AG7 / §13.2 V8: what the loop does about an aggregate parent it can neither dispatch nor
 * complete.
 *
 * `planTaskAggregation` reports the SHAPES (`TaskCompletionGap`); this module decides what each one
 * becomes. Two outcomes, and the split is the whole point:
 *
 *   - A gap the loop can close by itself becomes a `FILE_VERIFICATION_TASK` proposal. That is the
 *     `VERIFICATION_PASSED` roll-up whose children are in and whose check nobody filed — if the
 *     team makes exactly one INDEPENDENT verifier determinable, asking a person to type it in is
 *     ceremony, and asking nobody at all is the 60-second idle this whole unit exists to remove.
 *   - Everything else becomes a §11 blocker with an owner and a required action, because every
 *     remaining exit is a judgement about the task graph — restore a child, take the policy back to
 *     MANUAL, re-parent a successor — and none of those is derivable from the graph that has the
 *     problem in it.
 *
 * Both answers come from ONE function of ONE snapshot (`completionGapDisposition`), so the pass
 * that files and the pass that raises cannot disagree about which case a task is in. A detector
 * that said "a person must do this" while the applier filed it anyway would open a row that clears
 * itself one pass later, for ever, on every project that ever hit the shape.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_VERIFICATION_TASK = exports.COMPLETION_GAP_FILING_MAX_REFUSALS = void 0;
exports.completionGapDisposition = completionGapDisposition;
exports.filingAuthorizationRequest = filingAuthorizationRequest;
exports.runnableVerifierAssignments = runnableVerifierAssignments;
exports.implementerAgentIds = implementerAgentIds;
exports.filingHistory = filingHistory;
exports.planCompletionGaps = planCompletionGaps;
const shared_1 = require("@orbit/shared");
const runtime_model_1 = require("../common/runtime-model");
const project_authorization_service_1 = require("./project-authorization.service");
/**
 * V8-e's ceiling on automatic retries.
 *
 * The generation lets a refusal that had no side effect be tried again, which is right — but a
 * world that refuses every attempt is not one more attempt away from working, and §10.3's rule
 * against silent idling is not satisfied by retrying silently instead. After this many CONSECUTIVE
 * refusals the loop stops proposing and says so in a row somebody owns.
 */
exports.COMPLETION_GAP_FILING_MAX_REFUSALS = 3;
/** The §7.3 action this unit proposes. Named here because both the planner and the applier spell it. */
exports.FILE_VERIFICATION_TASK = 'FILE_VERIFICATION_TASK';
const BLOCKER_KIND_FOR_GAP = {
    NO_CHILD_CAN_COMPLETE: 'AGGREGATE_PARENT_UNSATISFIABLE',
    SUCCESSOR_OUTSIDE_SUBTREE: 'SUCCESSOR_OUTSIDE_SUBTREE',
    NO_VERIFICATION_FILED: 'VERIFICATION_REQUIRED',
};
/**
 * The single decision, for one gap, from one snapshot.
 *
 * Deterministic in the strong sense the ledger needs: it reads only `decisionInput`, which is
 * frozen and hashed, so the same decision replayed a year later proposes the same key. Nothing
 * here reads a clock, a random source or `updated_at`.
 */
function completionGapDisposition(input, gap) {
    const kind = BLOCKER_KIND_FOR_GAP[gap.reason];
    // Only the missing-check shape has a machine answer. A roll-up with nothing that can finish it,
    // or one whose replacement work left the subtree, needs somebody to say where the work is.
    if (gap.reason !== 'NO_VERIFICATION_FILED')
        return { action: 'RAISE_BLOCKER', kind, why: null };
    const history = filingHistory(input, gap.taskId);
    if (history.consecutiveRefusals >= exports.COMPLETION_GAP_FILING_MAX_REFUSALS) {
        return { action: 'RAISE_BLOCKER', kind, why: 'FILING_REFUSALS_EXHAUSTED' };
    }
    // §9.2's frozen matrix, asked through the same function the commit point asks — never a
    // hand-written policy clause here and another one there. `FILE_VERIFICATION_TASK` is a
    // COORDINATOR_ROUTINE row, so a MANUAL project answers REQUIRE_APPROVAL and the loop does not
    // file; the permissions it exercises (CREATE_TASK to make the row, DELEGATE to hand it to
    // somebody else) are checked inside it too.
    const authorization = (0, project_authorization_service_1.createProjectAuthorizationAudit)(filingAuthorizationRequest(input, gap.taskId, history.attempts + 1));
    if (authorization.result.decision !== 'ALLOW') {
        return {
            action: 'RAISE_BLOCKER',
            kind,
            why: authorization.result.reasonCode === 'CREATE_TASK_PERMISSION_DENIED'
                || authorization.result.reasonCode === 'DELEGATE_PERMISSION_DENIED'
                || authorization.result.reasonCode === 'COORDINATOR_PERMISSION_DENIED'
                || authorization.result.reasonCode === 'COORDINATOR_NOT_ASSIGNED'
                || authorization.result.reasonCode === 'COORDINATOR_NOT_PROJECT_MEMBER'
                || authorization.result.reasonCode === 'COORDINATOR_AGENT_DISABLED'
                ? 'COORDINATOR_CANNOT_FILE'
                : 'POLICY_REQUIRES_APPROVAL',
        };
    }
    const subject = input.world.tasks.find((task) => task.id === gap.taskId);
    // WHO, WHERE and WITH WHAT, resolved together because a verifier is all five or it is none.
    const resolved = runnableVerifierAssignments(input, implementerAgentIds(input, gap.taskId));
    if (resolved.eligibleAgents.length === 0) {
        return { action: 'RAISE_BLOCKER', kind, why: 'NO_INDEPENDENT_AGENT' };
    }
    if (resolved.assignments.length === 0) {
        // There is somebody who could check it and nothing they could check it WITH. Named apart from
        // the clause above because the two send a reader to different settings.
        return { action: 'RAISE_BLOCKER', kind, why: 'NO_RUNNABLE_VERIFIER_COMBINATION' };
    }
    if (resolved.assignments.length > 1) {
        // Picking one would be the loop making a staffing or an engine decision on a coin flip, and the
        // audit would record it as a fact. More than one is a question, so it is asked.
        return { action: 'RAISE_BLOCKER', kind, why: 'AMBIGUOUS_VERIFIER_ASSIGNMENT' };
    }
    const assignment = resolved.assignments[0];
    return {
        action: 'FILE_VERIFICATION',
        filing: {
            subjectTaskId: gap.taskId,
            verifierAgentId: assignment.agentId,
            workspaceId: assignment.workspaceId,
            runnerId: assignment.runnerId,
            provider: assignment.provider,
            providerId: assignment.providerId,
            runtime: assignment.runtime,
            providerScope: assignment.providerScope,
            model: assignment.model,
            parentTaskId: subject?.parentTaskId ?? null,
            configRevision: input.world.project.configRevision,
            generation: String(history.attempts + 1),
            authorization,
        },
    };
}
/**
 * §9.2's request for one filing, built from the snapshot and from nothing else.
 *
 * Every field is a fact this decision READ; nothing is invented to make the shape fit. The three
 * counters §9.2 only consults for a dispatch are computed honestly anyway — an audit that carried a
 * fabricated number would replay, and would be a lie that replays.
 */
function filingAuthorizationRequest(input, subjectTaskId, generation) {
    const project = input.world.project;
    const coordinator = input.world.team.find((member) => member.agentId === project.coordinatorAgentId);
    const windowStart = input.evaluation.epoch * 1_000 - 24 * 60 * 60_000;
    return {
        v: 1,
        sourceDecisionInputHash: input.decisionInputHash,
        idempotencyKey: `pc:v1:${project.id}:file-verification:${subjectTaskId}:${generation}`,
        evaluatedAt: input.readAt,
        action: 'FILE_VERIFICATION_TASK',
        // The row it creates is the point; DELEGATE is checked beside it by the action's own clause.
        requiredPermission: 'CREATE_TASK',
        project: {
            id: project.id,
            status: project.status,
            coordinatorEnabled: project.coordinatorEnabled,
            automationPolicy: project.automationPolicy,
            configRevision: project.configRevision,
            inFlightTasks: input.world.tasks.filter((task) => task.liveSessionIds.length > 0).length,
            maxConcurrentTasks: project.maxConcurrentTasks,
            coordinatorSessionsStartedLast24h: input.world.actions.filter((action) => action.type === 'ROTATE_COORDINATOR_SESSION'
                && action.status === 'APPLIED'
                && Date.parse(action.createdAt) > windowStart).length,
            sessionBudgetPerDay: project.sessionBudgetPerDay,
        },
        principal: {
            agentId: project.coordinatorAgentId,
            coordinatorAgentId: project.coordinatorAgentId,
            memberRole: coordinator ? coordinator.role : null,
            agentEnabled: coordinator?.enabled ?? false,
            agentDeleted: Boolean(coordinator?.deletedAt),
            // §9.2 has no per-agent COORDINATE column today; membership as COORDINATOR is the fact.
            canCoordinate: coordinator?.role === 'COORDINATOR',
            canCreateTasks: coordinator?.canCreateTasks ?? false,
            canDelegate: coordinator?.canDelegate ?? false,
        },
        approval: { state: 'NONE', targetIdempotencyKey: null },
    };
}
/**
 * V8-a/V8-b: every (agent, workspace, runner, provider, model) this snapshot can NAME as a runnable
 * verifier for this subject, sorted so one world always produces one order.
 *
 * WHO and WITH WHAT are resolved separately and then joined, because they fail differently and a
 * reader has to be sent to different places. The join is the point: a plan that named an agent and
 * left the engine to be worked out later would reach the dispatcher's `provider ?? CLAUDE`, and a
 * check would run on an engine no decision chose and no audit records.
 *
 * Nothing here is inherited from the SUBJECT. The subject's engine is what the WORK ran on, and a
 * check that inherits it inherits the thing it is supposed to be independent of — and, worse, would
 * be resolved from a task row rather than from any verification policy. The engine comes from the
 * VERIFIER's own configuration: the provider fallbacks explicitly set on that agent, with that
 * agent's model, and only where the runner it would actually run on has that model in its catalog.
 *
 * Five clauses, and a candidate must answer all of them:
 *
 *  - **Independent.** Nobody who did the work being checked (`implementers`). A check performed by
 *    the author is not a second opinion, it is the same opinion with a different task id on it.
 *  - **On the team, and usable.** Enabled, not soft-deleted — otherwise this is the `WHO_DISABLED`
 *    refusal the resolution chain would raise one step later, filed as a task first.
 *  - **Somewhere to run.** An Agent IS a workspace on the wire today (see `ProjectMember.agentId`),
 *    so the workspace is the same row; enabled, not deleted, and bound to a runner.
 *  - **A machine that is up.** `ONLINE`, and having reported its capabilities — a runner that has
 *    never reported is one the chain refuses the moment anything is required of it.
 *  - **An engine that exists on that machine.** An explicit provider fallback on the agent, a model
 *    from that fallback or from the agent, the provider enabled for this project, and the model in
 *    that runner's own catalog for that provider. Every link stated; none defaulted.
 *
 * The coordinator is NOT excluded merely for being the coordinator. It is the identity that PLANNED
 * this project, which is a different thing from being one that did the work being checked;
 * excluding it by role would make "determinable" false on every two-agent team. If it also
 * implemented, the first clause removes it on the fact rather than on the title.
 */
function runnableVerifierAssignments(input, implementers) {
    const workspaceOf = new Map(input.world.workspaces.map((w) => [w.workspaceId, w]));
    const runnerOf = new Map(input.world.runners.map((r) => [r.runnerId, r]));
    const providerOf = new Map(input.world.providers.map((p) => [p.slug, p]));
    const eligibleAgents = [];
    const assignments = [];
    for (const member of input.world.team) {
        if (!member.enabled || member.deletedAt)
            continue;
        if (implementers.has(member.agentId))
            continue;
        const workspace = workspaceOf.get(member.agentId);
        if (!workspace || !workspace.enabled || workspace.deletedAt || !workspace.runnerId)
            continue;
        const runner = runnerOf.get(workspace.runnerId);
        if (!runner || runner.status !== 'ONLINE' || !runner.capabilitiesReportedAt)
            continue;
        eligibleAgents.push(member.agentId);
        for (const fallback of member.providerFallbacks) {
            const provider = providerOf.get(fallback.provider);
            if (!provider || !provider.enabled)
                continue;
            const model = fallback.model ?? member.model;
            if (!model)
                continue;
            if (!runnerServesModel(runner.modelCatalog, provider.runtime, model))
                continue;
            assignments.push({
                agentId: member.agentId,
                workspaceId: workspace.workspaceId,
                runnerId: runner.runnerId,
                provider: fallback.provider,
                providerId: provider.providerId,
                runtime: provider.runtime,
                providerScope: provider.scope,
                model,
            });
        }
    }
    const key = (a) => `${a.agentId}:${a.provider}:${a.model}`;
    const unique = new Map(assignments.map((a) => [key(a), a]));
    return {
        eligibleAgents: eligibleAgents.sort(),
        assignments: [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1)),
    };
}
/**
 * Does this runner actually serve that model for that provider's runtime?
 *
 * Delegates to `runtimeCatalogModels`, which is the ONE parser for `runner.model_catalog` in this
 * codebase — the heartbeat writes rows shaped `{ value, label, ... }` and a second reader that
 * guessed at `id` / `name` would call every production catalog empty and answer "no runnable
 * verifier" for every project that has one. Keyed on the provider's RUNTIME rather than its slug,
 * because that is what a runner reports under: a custom provider borrowing the `claude` runtime
 * appears in the catalog as `claude`.
 *
 * `undefined` — the runner has reported no catalog for that runtime at all — answers NO. Elsewhere
 * that is read as "possibly project-scoped" and left alone, and that is right for a model somebody
 * already chose; here the question is whether this snapshot can NAME a combination it knows will
 * run, and "the runner has never said it can" is not a yes.
 */
function runnerServesModel(catalog, runtime, model) {
    if (!Object.values(shared_1.AgentProvider).includes(runtime))
        return false;
    const models = (0, runtime_model_1.runtimeCatalogModels)(catalog, runtime);
    if (!models)
        return false;
    return models.some((row) => row.value === model);
}
/**
 * Everybody whose work this check would be checking (V8-a's "independent" clause, in full).
 *
 * Two sources, and both are needed because each one is falsifiable on its own:
 *
 *  - **Every assignee in the subject's whole SUBTREE**, not just its direct children. Work nests:
 *    a roll-up over roll-ups has its real implementers two levels down, and stopping at depth one
 *    would hand the check to the person who wrote the code it is checking.
 *  - **Every agent that has actually RUN one of those tasks**, from the Sessions bound to them.
 *    An assignee is a current pointer and can be rewritten after the fact — re-assign a subtask
 *    once it is DONE and its author becomes eligible to verify their own work, which is precisely
 *    the independence this clause exists to protect. A Session is history and cannot be moved.
 *
 * Every task-bound Session counts, work or salvage, and that is the explicit rule rather than an
 * omission: this is a question about who has SEEN the work, and a salvage conversation on a subtask
 * has seen it. The coordinator's own run is not bound to a task at all (`taskId === null`), so it
 * is excluded by the same clause rather than by a role exemption — coordinating a project is not
 * doing the work in it, and a coordinator that also implemented is caught by both sources above.
 */
function implementerAgentIds(input, subjectTaskId) {
    const childrenOf = new Map();
    for (const task of input.world.tasks) {
        if (!task.parentTaskId)
            continue;
        const bucket = childrenOf.get(task.parentTaskId);
        if (bucket)
            bucket.push(task.id);
        else
            childrenOf.set(task.parentTaskId, [task.id]);
    }
    // Iterative and `seen`-guarded: this walks data that AG2 says should never contain a cycle, and
    // "should never" is exactly the input a traversal must not trust.
    const subtree = new Set([subjectTaskId]);
    const stack = [subjectTaskId];
    while (stack.length > 0) {
        for (const child of childrenOf.get(stack.pop()) ?? []) {
            if (subtree.has(child))
                continue;
            subtree.add(child);
            stack.push(child);
        }
    }
    const implementers = new Set();
    for (const task of input.world.tasks) {
        if (subtree.has(task.id) && task.assigneeAgentId)
            implementers.add(task.assigneeAgentId);
    }
    for (const session of input.world.sessions) {
        if (!session.taskId || !subtree.has(session.taskId))
            continue;
        if (session.workspaceId)
            implementers.add(session.workspaceId);
    }
    return implementers;
}
/**
 * V8-e's two counters, read off the permanent ledger the snapshot carries.
 *
 * `world.actions` is this project's WHOLE action history (the capture has no window on it), which
 * is what makes both counts durable rather than a guess about how far back anybody can see.
 */
function filingHistory(input, subjectTaskId) {
    let attempts = 0;
    let consecutiveRefusals = 0;
    // Ordered by `(created_at, id)`, so walking forwards and resetting on a landing leaves the
    // TRAILING run of non-landings in the counter.
    for (const action of input.world.actions) {
        if (action.type !== exports.FILE_VERIFICATION_TASK || action.subjectId !== subjectTaskId)
            continue;
        attempts += 1;
        // APPLIED is the only status that filed anything. `REFUSED` (a stale snapshot) and
        // `SUPERSEDED` (the effect found the world had moved) both mean no check exists because of
        // this attempt — and counting only `REFUSED` would leave the mint unbounded on exactly the
        // shape that needs the bound: an effect that keeps answering SUPERSEDED while the gap stays
        // open would mint a fresh generation every pass, for ever, and never say so out loud.
        if (action.status === 'APPLIED')
            consecutiveRefusals = 0;
        else
            consecutiveRefusals += 1;
    }
    return { attempts, consecutiveRefusals };
}
/**
 * The §11 conditions this snapshot's gaps hold, and the filings it proposes, in one pass.
 *
 * They come back together because they are the two halves of one answer — a gap is either filed or
 * raised, never both and never neither.
 */
function planCompletionGaps(input, gaps) {
    const conditions = [];
    const filings = [];
    for (const gap of gaps) {
        const disposition = completionGapDisposition(input, gap);
        if (disposition.action === 'FILE_VERIFICATION') {
            filings.push(disposition.filing);
            continue;
        }
        conditions.push({
            kind: disposition.kind,
            // AG7-c. A PROJECT subject would be read by §11 BL1 as "stop everything", which is the
            // failure mode AG6-e already had to route around; this row is about one task and says so.
            subjectType: 'TASK',
            subjectId: gap.taskId,
            // TF2: the facts, not the counts. What a person must do depends on the SHAPE and on nothing
            // else, so a child count that moves under a gap that has not changed is the same condition —
            // and giving it a new `condition_version` every pass would be BL7's excluded churn.
            facts: { taskId: gap.taskId, policy: gap.policy, reason: gap.reason },
            detail: {
                taskId: gap.taskId,
                policy: gap.policy,
                reason: gap.reason,
                status: gap.status,
                ...(disposition.why ? { filingRefusedBecause: disposition.why } : {}),
                children: gap.evidence.children,
                verifications: gap.evidence.verifications,
            },
        });
    }
    return { conditions, filings };
}
//# sourceMappingURL=project-completion-gap.js.map