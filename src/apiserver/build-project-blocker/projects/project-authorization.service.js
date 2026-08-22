"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectAuthorizationService = exports.PROJECT_POLICY_MATRIX = void 0;
exports.projectPolicyCell = projectPolicyCell;
exports.createProjectAuthorizationAudit = createProjectAuthorizationAudit;
exports.replayProjectAuthorizationAudit = replayProjectAuthorizationAudit;
exports.authorizeProjectAction = authorizeProjectAction;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
const task_retry_policy_1 = require("../tasks/task-retry-policy");
const task_supersession_1 = require("../tasks/task-supersession");
const project_coordinator_session_1 = require("./project-coordinator-session");
const task_aggregation_1 = require("./task-aggregation");
const verification_dependency_1 = require("../tasks/verification-dependency");
/** The frozen policy matrix. Classification is separate; every policy answer comes from here. */
exports.PROJECT_POLICY_MATRIX = [
    {
        id: 'ALWAYS_SAFE', risk: 'LOW',
        cells: { MANUAL: 'ALLOW', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
    },
    {
        id: 'DISPATCH_INITIAL', risk: 'LOW',
        cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
    },
    {
        id: 'DISPATCH_RETRY', risk: 'LOW',
        cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
    },
    {
        id: 'DISPATCH_MAX_ATTEMPTS', risk: 'HIGH',
        cells: {
            MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'REQUIRE_APPROVAL',
        },
    },
    {
        id: 'DISPATCH_OVER_LIMIT', risk: 'HIGH',
        cells: { MANUAL: 'DENY', GUARDED_AUTO: 'DENY', AUTO: 'DENY' },
    },
    {
        id: 'DISPATCH_PROVIDER_FALLBACK', risk: 'HIGH',
        cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'ALLOW' },
    },
    {
        id: 'COORDINATOR_ROUTINE', risk: 'LOW',
        cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
    },
    {
        id: 'PROJECT_ACCEPTANCE', risk: 'HIGH',
        cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'ALLOW' },
    },
    {
        id: 'USER_CONTROL_ONLY', risk: 'PROHIBITED',
        cells: { MANUAL: 'DENY', GUARDED_AUTO: 'DENY', AUTO: 'DENY' },
    },
];
const ALWAYS_SAFE = new Set([
    'SCHEDULE_WAKE', 'NOOP', 'RAISE_BLOCKER', 'CLEAR_BLOCKER', 'AGGREGATE_PARENT',
    'REQUEST_APPROVAL',
]);
const COORDINATOR_ROUTINE = new Set([
    // §13.2 V8's filing sits here beside the verdict it is the mirror of: both are the coordinator
    // acting on a check, and both CREATE a task row (V8 the check itself, the verdict its defect).
    // Classifying it anywhere else would be a second policy answer for the same kind of write.
    'OPEN_COORDINATOR_TURN', 'ROTATE_COORDINATOR_SESSION', 'APPLY_VERIFICATION_VERDICT',
    'FILE_VERIFICATION_TASK',
]);
const USER_CONTROL_ONLY = new Set([
    'SET_PROJECT_DONE', 'DELETE_TASK', 'DELETE_PROJECT', 'CHANGE_ACCEPTANCE_CRITERIA',
    'REASSIGN_TASK',
]);
const SESSION_START_ACTIONS = new Set([
    'DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION',
]);
function projectPolicyCell(policy, rowId) {
    const row = exports.PROJECT_POLICY_MATRIX.find((candidate) => candidate.id === rowId);
    if (!row)
        throw new Error(`unknown Project policy row ${rowId}`);
    return row.cells[policy];
}
function createProjectAuthorizationAudit(request) {
    const requestHash = sha256(request);
    return {
        v: 1,
        requestHash,
        request,
        result: authorizeProjectAction(request),
    };
}
function replayProjectAuthorizationAudit(audit) {
    return audit.v === 1
        && audit.requestHash === sha256(audit.request)
        && canonicalJson(audit.result) === canonicalJson(authorizeProjectAction(audit.request));
}
function authorizeProjectAction(input) {
    const baseRow = classifyPolicyRow(input, false);
    const baseRisk = riskOf(baseRow);
    const result = (decision, reasonCode, extra = {}) => ({
        v: 1,
        decision,
        reasonCode,
        policyRow: extra.policyRow ?? baseRow,
        risk: extra.risk ?? baseRisk,
        ...extra,
    });
    if (input.project.status !== 'OPEN')
        return result('DENY', 'PROJECT_NOT_OPEN');
    if (USER_CONTROL_ONLY.has(input.action)) {
        return result('DENY', 'USER_CONTROL_REQUIRED', {
            policyRow: 'USER_CONTROL_ONLY', risk: 'PROHIBITED',
        });
    }
    if (!input.project.coordinatorEnabled)
        return result('DENY', 'COORDINATOR_DISABLED');
    if (!input.principal.coordinatorAgentId || !input.principal.agentId
        || input.principal.agentId !== input.principal.coordinatorAgentId) {
        return result('DENY', 'COORDINATOR_NOT_ASSIGNED');
    }
    if (input.principal.memberRole !== 'COORDINATOR') {
        return result('DENY', 'COORDINATOR_NOT_PROJECT_MEMBER');
    }
    if (!input.principal.agentEnabled || input.principal.agentDeleted) {
        return result('DENY', 'COORDINATOR_AGENT_DISABLED');
    }
    if (!input.principal.canCoordinate) {
        return result('DENY', 'COORDINATOR_PERMISSION_DENIED');
    }
    if (input.requiredPermission === 'CREATE_TASK' && !input.principal.canCreateTasks) {
        return result('DENY', 'CREATE_TASK_PERMISSION_DENIED');
    }
    if (input.requiredPermission === 'DELEGATE' && !input.principal.canDelegate) {
        return result('DENY', 'DELEGATE_PERMISSION_DENIED');
    }
    // §13.2 V8 is the one action that exercises BOTH, and `requiredPermission` names one. It creates
    // a task AND hands it to a different agent, so a coordinator with only one of the two may not
    // perform it — checking both here keeps that in the frozen matrix rather than in a hand-written
    // clause at the two call sites, which is where the two would eventually differ.
    if (input.action === 'FILE_VERIFICATION_TASK'
        && !(input.principal.canCreateTasks && input.principal.canDelegate)) {
        return result('DENY', input.principal.canCreateTasks
            ? 'DELEGATE_PERMISSION_DENIED'
            : 'CREATE_TASK_PERMISSION_DENIED');
    }
    let providerResolution;
    if (input.action === 'DISPATCH_TASK') {
        const taskGate = authorizeTaskState(input);
        if (taskGate)
            return result(taskGate.decision, taskGate.reasonCode, taskGate.extra);
        if (input.provider) {
            providerResolution = resolveProvider(input.provider);
            if (!providerResolution.selectedProvider) {
                return result('DENY', 'PROVIDER_UNAVAILABLE', { providerResolution });
            }
        }
        if (input.runner && !input.runner.available) {
            return result('DEFER', 'RUNNER_UNAVAILABLE', { providerResolution });
        }
        if (input.runner) {
            const capabilities = new Set(input.runner.capabilities);
            const missing = [...new Set(input.runner.requiredCapabilities)]
                .filter((required) => !input.runner.capabilitiesReported || !capabilities.has(required))
                .sort();
            if (missing.length > 0) {
                return result('DENY', 'RUNTIME_REQUIREMENT_UNMET', {
                    providerResolution,
                    missingCapabilities: missing,
                });
            }
        }
    }
    if (input.action === 'DISPATCH_TASK'
        && input.project.inFlightTasks >= input.project.maxConcurrentTasks) {
        return result('DEFER', 'PROJECT_CONCURRENCY_LIMIT', {
            policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
        });
    }
    if (input.action === 'DISPATCH_TASK' && input.task?.agentMaxConcurrentTasks != null
        && input.task.agentInFlightTasks >= input.task.agentMaxConcurrentTasks) {
        return result('DEFER', 'AGENT_CONCURRENCY_LIMIT', {
            policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
        });
    }
    if (SESSION_START_ACTIONS.has(input.action) && input.project.sessionBudgetPerDay != null
        && input.project.coordinatorSessionsStartedLast24h >= input.project.sessionBudgetPerDay) {
        return result('DEFER', 'SESSION_BUDGET_EXHAUSTED', {
            policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
        });
    }
    const rowId = classifyPolicyRow(input, providerResolution?.usedFallback ?? false);
    const cell = projectPolicyCell(input.project.automationPolicy, rowId);
    const risk = riskOf(rowId);
    if (cell === 'DENY') {
        return result('DENY', rowId === 'USER_CONTROL_ONLY'
            ? 'USER_CONTROL_REQUIRED'
            : 'POLICY_REQUIRES_APPROVAL', { policyRow: rowId, risk, providerResolution });
    }
    if (cell === 'ALLOW') {
        return result('ALLOW', 'POLICY_ALLOWED', { policyRow: rowId, risk, providerResolution });
    }
    const approval = input.approval;
    // An approval is authority for exactly one durable action. In particular, an unbound
    // APPROVED bit is not a wildcard grant that may be replayed against another idempotency key.
    if (approval.state === 'APPROVED'
        && approval.targetIdempotencyKey !== input.idempotencyKey) {
        return result('DENY', 'APPROVAL_TARGET_MISMATCH', {
            policyRow: rowId, risk, providerResolution,
        });
    }
    if (approval.state === 'APPROVED') {
        return result('ALLOW', 'APPROVAL_GRANTED', { policyRow: rowId, risk, providerResolution });
    }
    if (approval.state === 'DENIED') {
        return result('DENY', 'APPROVAL_DENIED', { policyRow: rowId, risk, providerResolution });
    }
    if (approval.state === 'PENDING') {
        return result('REQUIRE_APPROVAL', 'APPROVAL_PENDING', {
            policyRow: rowId, risk, providerResolution,
        });
    }
    return result('REQUIRE_APPROVAL', approval.state === 'EXPIRED'
        ? 'APPROVAL_EXPIRED'
        : rowId === 'DISPATCH_MAX_ATTEMPTS'
            ? input.task?.failureAttributable === false ? 'UNKNOWN_FAILURE' : 'MAX_ATTEMPTS_REACHED'
            : 'POLICY_REQUIRES_APPROVAL', { policyRow: rowId, risk, providerResolution });
}
function authorizeTaskState(input) {
    const task = input.task;
    if (!task)
        return { decision: 'DENY', reasonCode: 'TASK_NOT_OPEN' };
    // §13.6 SU6, first and DENY. First because a retired attempt is not a task whose preconditions
    // are unmet — none of the clauses below is the reason it must not run — and DENY because every
    // other refusal here describes a condition that can lift. This one cannot: the successor named by
    // the link is what is live now, and no amount of waiting makes this row the work again.
    if ((0, task_supersession_1.taskIsObsolete)({
        retirement: task.retirement ?? null,
        subjectRetirement: task.verificationSubjectRetirement ?? null,
    })) {
        return { decision: 'DENY', reasonCode: 'TASK_SUPERSEDED' };
    }
    // §13.1 AG6, second and DENY, for the reason above and in the same position §7.8's pass puts it:
    // before the status clause, because a FAILED aggregate parent is not a run to retry. This is the
    // half of the gate that survives a plan made against an older shape — §7.8 chose from a snapshot,
    // and children and policy are both columns somebody may write between that snapshot and here.
    //
    // Absent facts read as "not an aggregate parent", which is what an audit captured before AG6
    // meant. A caller that supplies them cannot get that answer by omission: the adapter below fills
    // the field for every DISPATCH_TASK it builds.
    if (task.aggregateParent && (0, task_aggregation_1.isAggregateParent)(task.aggregateParent)) {
        return { decision: 'DENY', reasonCode: 'TASK_AGGREGATE_PARENT' };
    }
    // §7.4 precondition 1, v1.18 (`PC-CX-64`): `FAILED` is a status this gate ADMITS ON, not one it
    // refuses out of hand. WHICH of §9.5 Q3's rows the task is on is then settled by clauses this
    // function already had, and that is deliberate — they are where `failedTaskBlockerKind` took its
    // precedence FROM: a live session below is `TASK_ALREADY_RUNNING`, an unexpired backoff is
    // `RETRY_BACKOFF_ACTIVE`, and both terminal cells are `classifyPolicyRow`'s
    // `DISPATCH_MAX_ATTEMPTS` row, which answers `MAX_ATTEMPTS_REACHED` or — when nothing attributed
    // the failure — `UNKNOWN_FAILURE`, and therefore opens a row somebody can act on.
    //
    // `TASK_NOT_OPEN` was the silent fallback: it is in §11.2's non-blocking list, so a `FAILED` task
    // got no dispatch, no blocker and nothing to read.
    if (task.status !== 'OPEN' && task.status !== 'FAILED') {
        return { decision: 'DEFER', reasonCode: 'TASK_NOT_OPEN' };
    }
    if (task.dispatchHold)
        return { decision: 'DEFER', reasonCode: 'TASK_DISPATCH_HELD' };
    if (!task.runAtDue)
        return { decision: 'DEFER', reasonCode: 'TASK_NOT_DUE' };
    // §7.4's third precondition is one bullet with two halves — prerequisites DONE, and a subject
    // that has not been sent back by a failed check — so both answer the same question. The verdict
    // goes first because when both are true it is the answer somebody can act on: an outstanding
    // prerequisite says "wait", while a failed check says what to go and fix. DEFER, not DENY: the
    // condition clears when the defect is fixed and the check passes again, with nobody asked.
    if (task.verificationBlock) {
        return {
            decision: 'DEFER',
            reasonCode: task.verificationBlock.reason === 'SUBJECT_DEFECT_OPEN'
                ? 'VERIFICATION_DEFECT_OPEN'
                : 'VERIFICATION_FAILED_UPSTREAM',
        };
    }
    if (!task.dependenciesReady) {
        // §13.3 DEP. Still DEFER, not DENY: a check that failed is re-run once the defect is fixed, and
        // the epoch opens with nobody asked — the same shape as `verificationBlock` above, which is the
        // other half of §7.4 precondition 3 and answers for the SUBJECT rather than for an edge.
        return {
            decision: 'DEFER',
            reasonCode: task.dependenciesVerificationBlocked
                ? 'VERIFICATION_NOT_PASSED'
                : 'TASK_DEPENDENCIES_INCOMPLETE',
        };
    }
    if (task.hasLiveSession)
        return { decision: 'DEFER', reasonCode: 'TASK_ALREADY_RUNNING' };
    if (!task.assigneeAgentId)
        return { decision: 'DENY', reasonCode: 'WHO_UNRESOLVED' };
    if (!task.assigneeIsProjectMember)
        return { decision: 'DENY', reasonCode: 'WHO_NOT_IN_TEAM' };
    if (!task.assigneeEnabled)
        return { decision: 'DENY', reasonCode: 'WHO_DISABLED' };
    if (task.failureCount > 0 && task.failureCount < task.maxAutoRunFailures
        && task.failureAttributable
        && task.retryBackoffUntil != null
        && Date.parse(task.retryBackoffUntil) > Date.parse(input.evaluatedAt)) {
        return {
            decision: 'DEFER', reasonCode: 'RETRY_BACKOFF_ACTIVE',
            extra: { policyRow: 'DISPATCH_RETRY', retryAt: task.retryBackoffUntil },
        };
    }
    return null;
}
function classifyPolicyRow(input, usedFallback) {
    if (ALWAYS_SAFE.has(input.action))
        return 'ALWAYS_SAFE';
    if (USER_CONTROL_ONLY.has(input.action))
        return 'USER_CONTROL_ONLY';
    if (input.action === 'RUN_PROJECT_ACCEPTANCE')
        return 'PROJECT_ACCEPTANCE';
    if (COORDINATOR_ROUTINE.has(input.action))
        return 'COORDINATOR_ROUTINE';
    if (input.action === 'DISPATCH_TASK') {
        if (input.project.inFlightTasks >= input.project.maxConcurrentTasks
            || (input.task?.agentMaxConcurrentTasks != null
                && input.task.agentInFlightTasks >= input.task.agentMaxConcurrentTasks)
            || (input.project.sessionBudgetPerDay != null
                && input.project.coordinatorSessionsStartedLast24h >= input.project.sessionBudgetPerDay)) {
            return 'DISPATCH_OVER_LIMIT';
        }
        if (((input.task?.failureCount ?? 0) > 0 && input.task?.failureAttributable === false)
            || (input.task?.failureCount ?? 0)
                >= (input.task?.maxAutoRunFailures ?? task_retry_policy_1.MAX_AUTO_RUN_FAILURES)) {
            return 'DISPATCH_MAX_ATTEMPTS';
        }
        if (usedFallback)
            return 'DISPATCH_PROVIDER_FALLBACK';
        if ((input.task?.failureCount ?? 0) > 0)
            return 'DISPATCH_RETRY';
        return 'DISPATCH_INITIAL';
    }
    return 'USER_CONTROL_ONLY';
}
function riskOf(rowId) {
    return exports.PROJECT_POLICY_MATRIX.find((row) => row.id === rowId).risk;
}
function resolveProvider(input) {
    const considered = [input.requestedProvider];
    const requested = findAvailableProvider(input.availability, input.requestedProvider, input.requestedModel);
    if (requested) {
        return {
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
            selectedProvider: requested.provider,
            selectedModel: input.requestedModel ?? requested.defaultModel ?? null,
            configuredFallbacks: input.explicitFallbacks,
            candidatesConsidered: considered,
            fallbackHops: [],
            usedFallback: false,
        };
    }
    for (const fallback of input.explicitFallbacks) {
        considered.push(fallback.provider);
        const available = findAvailableProvider(input.availability, fallback.provider, fallback.model ?? null);
        if (!available)
            continue;
        return {
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
            selectedProvider: fallback.provider,
            selectedModel: fallback.model ?? available.defaultModel ?? null,
            configuredFallbacks: input.explicitFallbacks,
            candidatesConsidered: considered,
            fallbackHops: [{
                    from: input.requestedProvider,
                    to: fallback.provider,
                    reason: 'PROVIDER_UNAVAILABLE',
                }],
            usedFallback: true,
        };
    }
    return {
        requestedProvider: input.requestedProvider,
        requestedModel: input.requestedModel,
        selectedProvider: null,
        selectedModel: null,
        configuredFallbacks: input.explicitFallbacks,
        candidatesConsidered: considered,
        fallbackHops: [],
        usedFallback: false,
    };
}
function findAvailableProvider(candidates, provider, model) {
    return candidates.find((candidate) => candidate.provider === provider
        && candidate.available
        && (model == null || candidate.models == null || candidate.models.includes(model)));
}
function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalValue(item)]));
    }
    return value;
}
function sha256(value) {
    return (0, node_crypto_1.createHash)('sha256').update(canonicalJson(value)).digest('hex');
}
/**
 * Commit-time, side-effect-free authorization adapter. It locks the Project row and reads every
 * mutable admission fact in the caller's transaction; task 13 can create the Session in that same
 * transaction after ALLOW. This unit deliberately does not dispatch anything itself.
 */
let ProjectAuthorizationService = class ProjectAuthorizationService {
    async authorizeInTransaction(tx, command, now = new Date()) {
        const projects = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT p."id", p."status"::text, p."coordinator_enabled" AS "coordinatorEnabled",
             p."automation_policy"::text AS "automationPolicy",
             p."config_revision" AS "configRevision",
             p."max_concurrent_tasks" AS "maxConcurrentTasks",
             p."session_budget_per_day" AS "sessionBudgetPerDay",
             coordinator."agent_id" AS "coordinatorAgentId"
        FROM "project" p
        LEFT JOIN LATERAL (
          SELECT pm."agent_id" FROM "project_member" pm
           WHERE pm."project_id" = p."id" AND pm."role"::text = 'COORDINATOR'
           ORDER BY pm."id" LIMIT 1
        ) coordinator ON true
       WHERE p."id" = ${command.projectId}::uuid AND p."owner_id" = ${command.ownerId}::uuid
       FOR NO KEY UPDATE OF p
    `);
        const project = projects[0];
        if (!project)
            return null;
        const agents = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT w."id", pm."role"::text, w."enabled", w."deleted_at" AS "deletedAt",
             w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate",
             w."max_concurrent_tasks" AS "maxConcurrentTasks",
             w."provider_fallbacks" AS "providerFallbacks"
        FROM "workspace" w
        JOIN "project_member" pm
          ON pm."project_id" = ${command.projectId}::uuid AND pm."agent_id" = w."id"
       WHERE w."id" = ${command.coordinatorAgentId}::uuid
         AND w."owner_id" = ${command.ownerId}::uuid
       FOR SHARE OF w, pm
    `);
        const principal = agents[0];
        // `FOR SHARE` on the task is this gate's fence, and §13.6 SU6's two columns are read THROUGH
        // it: `task_supersession_guard` fires on `BEFORE UPDATE OF superseded_by_task_id`, so a
        // concurrent link takes a row lock that conflicts with this one. Either the link commits first
        // and this read sees it (refused below), or this dispatch commits first and the link waits and
        // then applies to a task that is already running — never both reading the other as absent.
        const taskRows = command.taskId == null ? [] : await tx.$queryRaw(client_1.Prisma.sql `
      SELECT t."id", t."status"::text, t."dispatch_hold" AS "dispatchHold",
             t."run_at" AS "runAt", t."assignee_id" AS "assigneeAgentId",
             t."superseded_by_task_id" AS "supersededByTaskId",
             t."terminal_reason" AS "terminalReason",
             t."verifies_task_id" AS "verifiesTaskId",
             -- §13.1 AG6's policy column, read from the row this statement already locks:
             -- switching a policy is an UPDATE of exactly this row, so the lock that fences
             -- supersession fences the policy flip too, with no second lock and no new lock order.
             t."completion_policy"::text AS "completionPolicy"
        FROM "task" t
       WHERE t."id" = ${command.taskId}::uuid AND t."project_id" = ${command.projectId}::uuid
         AND t."owner_id" = ${command.ownerId}::uuid
       FOR SHARE
    `);
        const task = taskRows[0];
        // §13.6 SU6's derived half, in a SECOND statement — deliberately, and not as a LEFT JOIN with
        // `FOR SHARE OF t, subject`: PostgreSQL refuses to lock the nullable side of an outer join, so
        // that spelling is not merely inelegant, it is an error on every ordinary task.
        //
        // Two statements in a fixed order — verifier, then subject — which is also the order 0130's
        // session guard takes, so the two cannot invert. There is no TOCTOU between them: the link is a
        // column of the row this transaction now holds `FOR SHARE`, and changing it requires an UPDATE
        // of that row, which this lock blocks. What was read above is what will still be true here.
        const subjectRows = task?.verifiesTaskId == null ? [] : await tx.$queryRaw(client_1.Prisma.sql `
      SELECT t."superseded_by_task_id" AS "supersededByTaskId",
             t."terminal_reason" AS "terminalReason"
        FROM "task" t WHERE t."id" = ${task.verifiesTaskId}::uuid
       FOR SHARE
    `);
        // §13.1 AG6's first clause, at the commit point. A THIRD statement, after the verifier and its
        // subject, so the three keep one fixed order and cannot invert against 0130's session guard.
        //
        // OWNER-scoped, and deliberately not project-scoped: that is the scope
        // `collectAggregationScope` walks, and the two rules are one predicate read in opposite
        // directions — aggregation completes this task iff the loop must not dispatch it. The API
        // refuses a cross-project parent (`assertParentEligible`), so the scopes differ only for rows
        // raw SQL produced, and there the wider one is the fail-closed answer. `LIMIT 1`: existence.
        //
        // This read is NOT what makes the rule atomic, and it must not be mistaken for it. A row lock
        // on a parent is not a predicate lock over its children — a child insert takes only the FK's
        // `FOR KEY SHARE` on this row, which `FOR SHARE` does not conflict with. What this closes is
        // the ordering §7.8's staleness leaves open: a child filed after the pass took its snapshot and
        // committed before this transaction is seen HERE, and refused with a code a reader can act on.
        // The genuinely concurrent case is closed one layer down, by migration 0132's pair of guards on
        // a shared `FOR UPDATE` of this row — this gate exists so that the common case produces a
        // refusal code rather than a raised exception.
        const childRows = command.taskId == null ? [] : await tx.$queryRaw(client_1.Prisma.sql `
        SELECT c."id" FROM "task" c
         WHERE c."parent_task_id" = ${command.taskId}::uuid
           AND c."owner_id" = ${command.ownerId}::uuid
         LIMIT 1
      `);
        const targetAgents = !task?.assigneeAgentId ? []
            : await tx.$queryRaw(client_1.Prisma.sql `
          SELECT w."id", pm."role"::text, w."enabled", w."deleted_at" AS "deletedAt",
                 w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate",
                 w."max_concurrent_tasks" AS "maxConcurrentTasks",
                 w."provider_fallbacks" AS "providerFallbacks"
            FROM "workspace" w
            JOIN "project_member" pm
              ON pm."project_id" = ${command.projectId}::uuid AND pm."agent_id" = w."id"
           WHERE w."id" = ${task.assigneeAgentId}::uuid AND w."owner_id" = ${command.ownerId}::uuid
           FOR SHARE OF w, pm
        `);
        const targetAgent = targetAgents[0];
        // Lock the current edge/prerequisite set before interpreting it: rank 50 for the prerequisite
        // Tasks whose status decides readiness, then rank 70 for this Task's dependency revision.
        //
        // The revision row is what makes the EMPTY edge set lockable, which the edge rows cannot be —
        // 0122 borrowed the dependent Task's own row for that by touching its `updated_at`, and 0132
        // replaced it with a row that belongs to the edge set. Every dependency change advances it, so
        // holding it FOR SHARE means no edge of this Task can commit between here and this
        // transaction's own commit: the counts read below stay true for as long as they are used.
        //
        // Rank order, and why it is safe to hold a rank-70 row all the way through the Session insert:
        // by the time this runs the caller has already taken rank 10 (the owner, FOR KEY SHARE — I4 in
        // common/lock-order.ts, and the thing that makes rank 70 reachable without a cycle), rank 40
        // (the project, above) and rank 50 (this Task, FOR SHARE, taken by the dispatcher before it
        // called here). Everything the dispatch does after this point — the Session insert and its
        // capacity/authority triggers, the Task status write — asks only for rows it is already
        // holding. The one writer that takes a `task` row BEFORE it advances a revision,
        // TasksService.update rewriting dependencies alongside a scalar write, is excluded by that
        // rank-50 FOR SHARE rather than able to meet this transaction head-on.
        if (command.taskId != null) {
            await tx.$queryRaw(client_1.Prisma.sql `
        SELECT d."task_id", prerequisite."id"
          FROM "task_dependency" d
          JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
         WHERE d."task_id" = ${command.taskId}::uuid
         ORDER BY prerequisite."id"
         FOR SHARE OF d, prerequisite
      `);
            await tx.$queryRaw(client_1.Prisma.sql `
        SELECT r."revision" FROM "task_dependency_revision" r
         WHERE r."task_id" = ${command.taskId}::uuid
         FOR SHARE
      `);
        }
        // §9.4's cap counts every session §4.2 guard 5 calls live, which is the four in
        // `PROJECT_LIVE_SESSION_STATUS_SQL` and not the two this query used to name. A run paused at
        // `AWAITING_INPUT` still holds its slot: it is resumable, nothing has released the runner, and
        // counting it as free let a project run over its own concurrency limit.
        const [projectConcurrency] = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT count(*)::int AS "count" FROM "session" s
        JOIN "task" t ON t."id" = s."task_id"
       WHERE t."project_id" = ${command.projectId}::uuid
         AND t."owner_id" = ${command.ownerId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
         AND s."deleted_at" IS NULL AND s."starts_task_work"
         AND s."status"::text IN (${client_1.Prisma.raw(project_coordinator_session_1.PROJECT_LIVE_SESSION_STATUS_SQL)})
    `);
        const [agentConcurrency] = !task?.assigneeAgentId ? [{ count: 0 }]
            : await tx.$queryRaw(client_1.Prisma.sql `
          SELECT count(*)::int AS "count" FROM "session" s
            JOIN "task" t ON t."id" = s."task_id"
           WHERE t."project_id" = ${command.projectId}::uuid
             AND t."owner_id" = ${command.ownerId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND t."assignee_id" = ${task.assigneeAgentId}::uuid
             AND s."deleted_at" IS NULL AND s."starts_task_work"
             AND s."status"::text IN (${client_1.Prisma.raw(project_coordinator_session_1.PROJECT_LIVE_SESSION_STATUS_SQL)})
        `);
        const [dailyBudget] = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT count(*)::int AS "count" FROM "project_action" a
       WHERE a."project_id" = ${command.projectId}::uuid
         AND a."type"::text IN ('DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION')
         AND a."status"::text IN ('CLAIMED', 'APPLIED')
         AND (${command.currentActionId ?? null}::uuid IS NULL
              OR a."id" <> ${command.currentActionId ?? null}::uuid)
         AND a."created_at" >= ${new Date(now.getTime() - 24 * 60 * 60 * 1_000)}
    `);
        const [dependencyState] = command.taskId == null
            ? [{ incomplete: 0, verificationBlocked: false }]
            : await tx.$queryRaw(client_1.Prisma.sql `
          -- §13.6 SU9: an edge names an ATTEMPT, and a replaced attempt's work is held by its
          -- successor. Walked forward with a recursive CTE — the chain is short (0128 caps it at
          -- 256 and refuses cycles), and the walk is bounded here as well so data the trigger says
          -- is unwritable cannot spin. A prerequisite counts as complete when the END of its chain
          -- is DONE; a chain that runs out at a retired row with no successor does not, because
          -- nothing took that work over.
          WITH RECURSIVE chain(root, id, status, depth) AS (
            SELECT prerequisite."id", prerequisite."id", prerequisite."status"::text, 0
              FROM "task_dependency" d
              JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
             WHERE d."task_id" = ${command.taskId}::uuid
               AND prerequisite."owner_id" = ${command.ownerId}::uuid
            UNION ALL
            SELECT chain.root, successor."id", successor."status"::text, chain.depth + 1
              FROM chain
              JOIN "task" current ON current."id" = chain.id
              JOIN "task" successor ON successor."id" = current."superseded_by_task_id"
             WHERE chain.depth < 256
          )
          -- §13.3 DEP, on the same walk: once something CHECKS a prerequisite, that prerequisite
          -- being DONE no longer means it is done — the check has to have passed. Asked of the
          -- prerequisite's epoch SUBJECT, which is the row itself or, when the edge names a check,
          -- what that check is about. verificationEpochOpenSql is TRUE for every task nothing
          -- checks, so ordinary prerequisites reduce to exactly the old clause.
          --
          -- Projected per link and rolled up afterwards rather than written as
          -- bool_and(... EXISTS ...): an aggregate whose argument carries a correlated subquery
          -- is the shape that is easiest to get subtly wrong, and this one is read at a commit
          -- point.
          SELECT count(*)::int AS "incomplete",
                 bool_or(rolled."verificationBlocked") AS "verificationBlocked"
            FROM (
              SELECT links.root,
                     bool_and(NOT links."satisfied") AS "unsatisfied",
                     bool_or(links."status" = 'DONE' AND NOT links."epochOpen")
                       AS "verificationBlocked"
                FROM (
                  SELECT chain.root AS root, chain.status AS "status",
                         ${client_1.Prisma.raw((0, verification_dependency_1.verificationEpochOpenSql)('chain_task', 'dependent_task'))}
                           AS "epochOpen",
                         (chain.status = 'DONE'
                          AND ${client_1.Prisma.raw((0, verification_dependency_1.verificationEpochOpenSql)('chain_task', 'dependent_task'))}
                         ) AS "satisfied"
                    FROM chain
                    JOIN "task" chain_task ON chain_task."id" = chain.id
                    -- The WAITING task, joined so DEP's self-exemption can be asked: a check that
                    -- depends on the subject it checks must not wait for its own conclusion.
                    JOIN "task" dependent_task ON dependent_task."id" = ${command.taskId}::uuid
                ) links
               GROUP BY links.root
            ) rolled
           WHERE rolled."unsatisfied"
        `);
        // §7.4 precondition 3's second half. Two shapes, one read, most-specific first:
        //
        //   SUBJECT_DEFECT_OPEN — this task IS the subject of a failed check whose defect subtask is
        //     still outstanding. Re-running it before the defect is fixed repeats the finding, and V4
        //     says it becomes dispatchable again once that subtask is settled. A defect somebody
        //     deleted stops holding it: an unresolvable block is a wedge, not a safeguard.
        //   UPSTREAM — this task depends on such a subject. Only a later PASS lifts this one; the
        //     subject going DONE again on its own must not, or the old verdict would have quietly
        //     become a pass, which is precisely the hole V4 names.
        //
        // The tasks this reads are already locked above (the task row FOR SHARE, its prerequisites
        // FOR SHARE), and every write that raises a condition takes FOR UPDATE on the subject — so a
        // verdict landing concurrently is serialized against this read rather than racing it.
        const [verificationBlockRow] = command.taskId == null ? [undefined]
            : await tx.$queryRaw(client_1.Prisma.sql `
          SELECT * FROM (
            SELECT 'SUBJECT_DEFECT_OPEN' AS "reason", 0 AS "rank", f."id" AS "failureId",
                   f."verifier_task_id" AS "verifierTaskId",
                   f."subject_task_id" AS "subjectTaskId", f."verdict"::text AS "verdict",
                   f."verdict_revision" AS "verdictRevision",
                   f."defect_task_id" AS "defectTaskId", f."created_at" AS "createdAt"
              FROM "task_verification_failure" f
              JOIN "task" defect ON defect."id" = f."defect_task_id"
              JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
              JOIN "task" subject ON subject."id" = f."subject_task_id"
             WHERE f."subject_task_id" = ${command.taskId}::uuid
               AND f."project_id" = ${command.projectId}::uuid
               AND f."resolved_at" IS NULL
               AND defect."status"::text NOT IN ('DONE', 'CANCELLED')
               -- §13.6 SU6: a defect somebody REPLACED stops holding the subject, for the same
               -- reason V4 already lets a deleted one stop holding it — an unresolvable block is a
               -- wedge, not a safeguard. The successor is dispatchable on its own account.
               AND ${client_1.Prisma.raw((0, task_supersession_1.taskNotRetiredSql)('defect'))}
               -- ...and so does the whole finding once the check that made it, or the work it was
               -- about, has been replaced. Shared verbatim with §13.4's DONE gate so "this failure
               -- is history" cannot mean two things.
               AND NOT ${client_1.Prisma.raw((0, task_supersession_1.verificationFailureIsHistorySql)())}
            UNION ALL
            SELECT 'UPSTREAM' AS "reason", 1 AS "rank", f."id" AS "failureId",
                   f."verifier_task_id" AS "verifierTaskId",
                   f."subject_task_id" AS "subjectTaskId", f."verdict"::text AS "verdict",
                   f."verdict_revision" AS "verdictRevision",
                   f."defect_task_id" AS "defectTaskId", f."created_at" AS "createdAt"
              FROM "task_verification_failure" f
              JOIN "task_dependency" d ON d."depends_on_task_id" = f."subject_task_id"
              JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
              JOIN "task" subject ON subject."id" = f."subject_task_id"
             WHERE d."task_id" = ${command.taskId}::uuid
               AND f."project_id" = ${command.projectId}::uuid
               AND f."resolved_at" IS NULL AND f."blocks_downstream" = true
               -- Same predicate as the arm above: a finding from a replaced check, or about
               -- replaced work, must not defer every task downstream of it forever.
               AND NOT ${client_1.Prisma.raw((0, task_supersession_1.verificationFailureIsHistorySql)())}
          ) blocks
           ORDER BY "rank", "createdAt", "failureId"
           LIMIT 1
        `);
        const [liveTask] = command.taskId == null ? [{ count: 0 }]
            : await tx.$queryRaw(client_1.Prisma.sql `
          SELECT count(*)::int AS "count" FROM "session" s
           WHERE s."task_id" = ${command.taskId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND s."deleted_at" IS NULL AND s."starts_task_work"
             AND s."status"::text IN (${client_1.Prisma.raw(project_coordinator_session_1.PROJECT_LIVE_SESSION_STATUS_SQL)})
        `);
        const failures = command.taskId == null ? []
            : await tx.$queryRaw(client_1.Prisma.sql `
          SELECT s."created_at" AS "createdAt", s."error"
            FROM "session" s
           WHERE s."task_id" = ${command.taskId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND s."status"::text = 'FAILED'
           ORDER BY s."created_at", s."id"
        `);
        const countedFailures = failures.filter((failure) => !isUsageLimitFailure(failure.error));
        const lastFailure = countedFailures.at(-1) ?? null;
        const backoffUntil = (0, task_retry_policy_1.retryBackoffUntil)(countedFailures.length, lastFailure?.createdAt ?? null);
        const fallbackSource = targetAgent ?? principal;
        const explicitFallbacks = parseFallbacks(fallbackSource?.providerFallbacks);
        return createProjectAuthorizationAudit({
            v: 1,
            sourceDecisionInputHash: command.sourceDecisionInputHash,
            idempotencyKey: command.idempotencyKey,
            evaluatedAt: now.toISOString(),
            action: command.action,
            requiredPermission: command.requiredPermission ?? 'COORDINATE',
            project: {
                id: (0, shared_1.uuidToBase62)(project.id),
                status: project.status,
                coordinatorEnabled: project.coordinatorEnabled,
                automationPolicy: project.automationPolicy,
                configRevision: String(project.configRevision),
                inFlightTasks: projectConcurrency?.count ?? 0,
                maxConcurrentTasks: project.maxConcurrentTasks,
                coordinatorSessionsStartedLast24h: dailyBudget?.count ?? 0,
                sessionBudgetPerDay: project.sessionBudgetPerDay,
            },
            principal: {
                agentId: (0, shared_1.uuidToBase62)(principal?.id ?? command.coordinatorAgentId),
                coordinatorAgentId: project.coordinatorAgentId == null
                    ? null
                    : (0, shared_1.uuidToBase62)(project.coordinatorAgentId),
                memberRole: principal?.role ?? null,
                agentEnabled: principal?.enabled ?? false,
                agentDeleted: principal?.deletedAt != null,
                canCoordinate: principal?.role === 'COORDINATOR',
                canCreateTasks: principal?.canCreateTasks ?? false,
                canDelegate: principal?.canDelegate ?? false,
            },
            ...(command.action === 'DISPATCH_TASK'
                ? {
                    task: {
                        id: task?.id == null ? '' : (0, shared_1.uuidToBase62)(task.id),
                        status: task?.status ?? 'MISSING',
                        dispatchHold: task?.dispatchHold ?? true,
                        runAtDue: task?.runAt == null || task.runAt <= now,
                        dependenciesReady: (dependencyState?.incomplete ?? 0) === 0,
                        dependenciesVerificationBlocked: dependencyState?.verificationBlocked === true,
                        verificationBlock: verificationBlockRow == null ? null : {
                            reason: verificationBlockRow.reason,
                            failureId: (0, shared_1.uuidToBase62)(verificationBlockRow.failureId),
                            verifierTaskId: (0, shared_1.uuidToBase62)(verificationBlockRow.verifierTaskId),
                            subjectTaskId: (0, shared_1.uuidToBase62)(verificationBlockRow.subjectTaskId),
                            verdict: verificationBlockRow.verdict,
                            verdictRevision: String(verificationBlockRow.verdictRevision),
                            defectTaskId: verificationBlockRow.defectTaskId == null
                                ? null
                                : (0, shared_1.uuidToBase62)(verificationBlockRow.defectTaskId),
                        },
                        hasLiveSession: (liveTask?.count ?? 0) > 0,
                        retirement: task == null ? null : (0, task_supersession_1.taskRetirement)(task),
                        aggregateParent: task == null ? null : {
                            completionPolicy: task.completionPolicy,
                            hasDirectChildren: childRows.length > 0,
                        },
                        verificationSubjectRetirement: subjectRows[0]
                            ? (0, task_supersession_1.taskRetirement)(subjectRows[0])
                            : null,
                        assigneeAgentId: task?.assigneeAgentId == null
                            ? null
                            : (0, shared_1.uuidToBase62)(task.assigneeAgentId),
                        assigneeIsProjectMember: targetAgent?.role != null,
                        assigneeEnabled: targetAgent?.enabled === true && targetAgent.deletedAt == null,
                        agentInFlightTasks: agentConcurrency?.count ?? 0,
                        agentMaxConcurrentTasks: targetAgent?.maxConcurrentTasks ?? null,
                        failureCount: countedFailures.length,
                        maxAutoRunFailures: task_retry_policy_1.MAX_AUTO_RUN_FAILURES,
                        failureAttributable: countedFailures.every((failure) => Boolean(failure.error?.trim())),
                        retryBackoffUntil: backoffUntil?.toISOString() ?? null,
                    },
                }
                : {}),
            approval: {
                state: command.approval?.state ?? 'NONE',
                targetIdempotencyKey: command.approval?.targetIdempotencyKey ?? null,
            },
            ...(command.provider
                ? { provider: { ...command.provider, explicitFallbacks } }
                : {}),
            ...(command.runner ? { runner: command.runner } : {}),
        });
    }
};
exports.ProjectAuthorizationService = ProjectAuthorizationService;
exports.ProjectAuthorizationService = ProjectAuthorizationService = __decorate([
    (0, common_1.Injectable)()
], ProjectAuthorizationService);
function parseFallbacks(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
            return [];
        const item = candidate;
        if (typeof item.provider !== 'string' || !item.provider.trim())
            return [];
        if (item.model != null && typeof item.model !== 'string')
            return [];
        return [{ provider: item.provider, ...(item.model == null ? {} : { model: item.model }) }];
    });
}
function isUsageLimitFailure(error) {
    if (!error)
        return false;
    const normalized = error.toLocaleLowerCase();
    return shared_1.USAGE_LIMIT_ERROR_MARKERS.some((marker) => normalized.includes(marker.toLocaleLowerCase()));
}
//# sourceMappingURL=project-authorization.service.js.map