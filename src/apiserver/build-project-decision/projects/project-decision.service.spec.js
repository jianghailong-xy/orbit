"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const shared_1 = require("@orbit/shared");
const project_decision_service_1 = require("./project-decision.service");
const project_authorization_service_1 = require("./project-authorization.service");
const PROJECT = '00000000-0000-7000-8000-000000001101';
const OWNER = '00000000-0000-7000-8000-000000001102';
const TASK = '00000000-0000-7000-8000-000000001103';
const DECISION = '00000000-0000-7000-8000-000000001104';
function input(overrides = {}) {
    const world = {
        project: {
            id: (0, shared_1.uuidToBase62)(PROJECT), ownerId: (0, shared_1.uuidToBase62)(OWNER), title: 'ship', goal: null,
            acceptanceCriteria: null, status: 'OPEN', coordinatorEnabled: true,
            automationPolicy: 'GUARDED_AUTO', maxConcurrentTasks: 3, sessionBudgetPerDay: null,
            configRevision: '7', coordinatorAgentId: null, coordinatorSessionId: null,
            coordinatorWorkspaceId: null,
        },
        runtime: {
            runState: 'PLANNING', fencingToken: '4', coordinatorGeneration: '1',
            nextWakeAt: null, acceptanceAttempt: '0',
        },
        team: [],
        tasks: [{
                id: (0, shared_1.uuidToBase62)(TASK), title: 'work', contentHash: 'a'.repeat(64), status: 'OPEN',
                parentTaskId: null, assigneeAgentId: null, provider: null, model: null,
                autoRunWhenReady: true, dispatchHold: false, runAt: null, verifiesTaskId: null,
                dispatchAuthority: 'COORDINATOR', dispatchAttempt: '0', requiredCapabilities: [],
                dependsOnTaskIds: [], liveSessionIds: [], updatedAt: '2026-08-20T00:00:00.000Z',
                failureCount: 0, lastFailureAt: null, failureAttributable: true, retryBackoffUntil: null,
            }],
        sessions: [], coordinatorSession: null, workspaces: [], runners: [], providers: [],
        actions: [], evidence: { branches: [], tests: [] },
        ...overrides,
    };
    const evaluation = {
        epoch: Date.parse('2026-04-25T00:00:00.000Z') / 1_000,
        dueTasks: { [(0, shared_1.uuidToBase62)(TASK)]: { runAtDue: true, retryBackoffExpired: true } },
    };
    const signals = [];
    return {
        v: 1,
        readAt: '2026-04-25T00:00:00.000Z',
        decisionInputHash: (0, project_decision_service_1.hashDecisionInput)({ world, evaluation, signals }),
        world,
        evaluation,
        signals,
    };
}
(0, node_test_1.test)('canonical decision hashing is independent of object insertion order and covers all inputs', () => {
    const a = input();
    const reordered = JSON.parse(JSON.stringify(a));
    reordered.world.project = Object.fromEntries(Object.entries(reordered.world.project).reverse());
    strict_1.default.equal((0, project_decision_service_1.hashDecisionInput)(reordered), a.decisionInputHash);
    strict_1.default.equal((0, project_decision_service_1.canonicalJson)({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
    const changed = input({
        project: { ...a.world.project, configRevision: '8' },
    });
    strict_1.default.notEqual(changed.decisionInputHash, a.decisionInputHash);
    const signalled = input();
    signalled.signals.push({
        eventId: (0, shared_1.uuidToBase62)('00000000-0000-7000-8000-000000001105'),
        kind: 'user.manual_trigger', dedupeKey: 'manual:one',
    });
    strict_1.default.notEqual((0, project_decision_service_1.hashDecisionInput)(signalled), a.decisionInputHash);
});
(0, node_test_1.test)('the same frozen input replays to a byte-identical deterministic outcome', () => {
    const frozen = input();
    const options = {
        decisionId: DECISION,
        consumedEventIds: [(0, shared_1.uuidToBase62)('00000000-0000-7000-8000-000000001106')],
    };
    const first = (0, project_decision_service_1.planProjectDecision)(frozen, options);
    const replay = (0, project_decision_service_1.planProjectDecision)(JSON.parse(JSON.stringify(frozen)), options);
    strict_1.default.equal((0, project_decision_service_1.canonicalJson)(replay), (0, project_decision_service_1.canonicalJson)(first));
    strict_1.default.deepEqual(first, {
        v: 1,
        reconcileId: (0, shared_1.uuidToBase62)(DECISION),
        fencingToken: '4',
        decisionInputHash: frozen.decisionInputHash,
        configRevision: '7',
        runStateBefore: 'PLANNING',
        runStateAfter: 'PLANNING',
        decidedBy: 'ORCHESTRATOR',
        reason: 'planning requires coordinator decision',
        actions: [], authorizations: [], blockersOpened: [], blockersCleared: [],
        aggregations: [], aggregationCycleTaskIds: [],
        nextWakeAt: '2026-04-25T00:01:00.000Z',
        nextWakeReason: 'planning requires coordinator decision',
        consumedEventIds: options.consumedEventIds,
    });
    strict_1.default.equal((0, shared_1.base62ToUuid)(first.reconcileId), DECISION);
});
(0, node_test_1.test)('tampered or stale input cannot be planned under its old hash', () => {
    const stale = input();
    stale.world.tasks[0].status = 'DONE';
    strict_1.default.throws(() => (0, project_decision_service_1.planProjectDecision)(stale, { decisionId: DECISION }), /input hash mismatch/);
});
(0, node_test_1.test)('authorization input and output are replayable parts of the durable Decision outcome', () => {
    const frozen = input();
    const authorization = (0, project_authorization_service_1.createProjectAuthorizationAudit)({
        v: 1,
        sourceDecisionInputHash: frozen.decisionInputHash,
        idempotencyKey: 'pc:v1:project:acceptance:1',
        evaluatedAt: frozen.readAt,
        action: 'RUN_PROJECT_ACCEPTANCE',
        requiredPermission: 'COORDINATE',
        project: {
            id: frozen.world.project.id,
            status: 'OPEN',
            coordinatorEnabled: true,
            automationPolicy: 'GUARDED_AUTO',
            configRevision: frozen.world.project.configRevision,
            inFlightTasks: 0,
            maxConcurrentTasks: 3,
            coordinatorSessionsStartedLast24h: 0,
            sessionBudgetPerDay: null,
        },
        principal: {
            agentId: 'coordinator', coordinatorAgentId: 'coordinator', memberRole: 'COORDINATOR',
            agentEnabled: true, agentDeleted: false, canCoordinate: true,
            canCreateTasks: true, canDelegate: true,
        },
        approval: { state: 'NONE', targetIdempotencyKey: null },
    });
    const planned = (0, project_decision_service_1.planProjectDecision)(frozen, { decisionId: DECISION, authorizations: [authorization] });
    strict_1.default.equal(planned.authorizations[0].result.decision, 'REQUIRE_APPROVAL');
    strict_1.default.equal(planned.authorizations[0].result.reasonCode, 'POLICY_REQUIRES_APPROVAL');
    const tampered = structuredClone(authorization);
    tampered.result.decision = 'ALLOW';
    strict_1.default.throws(() => (0, project_decision_service_1.planProjectDecision)(frozen, { decisionId: DECISION, authorizations: [tampered] }), /does not replay/);
});
(0, node_test_1.test)('run state is a pure function of the frozen session and verification facts', () => {
    const planning = input();
    const executing = input({
        sessions: [{
                id: (0, shared_1.uuidToBase62)('00000000-0000-7000-8000-000000001107'),
                taskId: (0, shared_1.uuidToBase62)(TASK), workspaceId: null, assignedRunnerId: null,
                runStatus: 'RUNNING', provider: 'codex', model: null, permissionMode: null, effort: null,
                createdAt: '2026-04-25T00:00:00.000Z',
                startedAt: null, finishedAt: null, completedAt: null, deletedAt: null,
            }],
    });
    const verifying = input({
        tasks: [{ ...planning.world.tasks[0], verifiesTaskId: (0, shared_1.uuidToBase62)(TASK) }],
    });
    const settled = input({ project: { ...planning.world.project, status: 'DONE' } });
    strict_1.default.equal((0, project_decision_service_1.planProjectDecision)(planning, { decisionId: DECISION }).runStateAfter, 'PLANNING');
    strict_1.default.equal((0, project_decision_service_1.planProjectDecision)(executing, { decisionId: DECISION }).runStateAfter, 'EXECUTING');
    strict_1.default.equal((0, project_decision_service_1.planProjectDecision)(verifying, { decisionId: DECISION }).runStateAfter, 'AWAITING_VERIFICATION');
    strict_1.default.equal((0, project_decision_service_1.planProjectDecision)(settled, { decisionId: DECISION }).runStateAfter, 'SETTLED');
});
//# sourceMappingURL=project-decision.service.spec.js.map