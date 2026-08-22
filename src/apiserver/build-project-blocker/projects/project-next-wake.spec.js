"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = require("node:test");
const project_blocker_1 = require("./project-blocker");
const project_next_wake_1 = require("./project-next-wake");
const REPO = node_path_1.default.resolve(__dirname, '../../../..');
const SOURCE = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'src/apiserver/src/projects/project-next-wake.ts'), 'utf8');
const EPOCH = Math.floor(Date.parse('2026-08-20T00:00:00.000Z') / 1_000);
const EPOCH_MS = EPOCH * 1_000;
const PROJECT = 'PPPPPPPPPPPPPPPPPPPPPP';
// ── W5 clause 1: the candidate table ────────────────────────────────────────────────────────
(0, node_test_1.test)('W5-1: each of the seven clauses produces the frozen (source, subjectType, subjectId)', () => {
    const candidates = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        blockers: [
            projection('PROVIDER_UNAVAILABLE', { id: 'b1', nextCheckAt: at(120_000) }),
            projection('TEST_FAILED', { id: 'b2', escalatedAt: null }),
        ],
        tasks: [
            { id: 't1', retryBackoffUntil: at(30_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
            { id: 't2', retryBackoffUntil: null, runAt: at(90_000), retryBackoffExpired: true, runAtDue: false },
        ],
        hasInFlightSession: true,
        runStateAfter: 'PLANNING',
        rateLimitedTurnWindows: [{ reasonCode: 'MANUAL', windowEndsAt: at(45_000) }],
    }));
    strict_1.default.deepEqual(candidates.map((c) => [c.source, c.subjectType, c.subjectId]).sort(), [
        [1, 'BLOCKER', 'b1'],
        [2, 'BLOCKER', 'b1'],
        [2, 'BLOCKER', 'b2'],
        [3, 'TASK', 't1'],
        [4, 'TASK', 't2'],
        [5, 'PROJECT', PROJECT],
        [6, 'PROJECT', PROJECT],
        [7, 'TURN_WINDOW', 'MANUAL'],
    ].sort());
    // Clause 1 covers TIME and EVENT only; TEST_FAILED is HUMAN, so it has no recovery poll — only
    // the escalation alarm of clause 2.
    strict_1.default.deepEqual(candidates.filter((c) => c.source === 1).map((c) => c.subjectId), ['b1']);
});
(0, node_test_1.test)('W5-1: an escalated blocker stops contributing an alarm, and a HUMAN one stops entirely', () => {
    const escalated = projection('TEST_FAILED', { id: 'b1', escalatedAt: at(-60_000) });
    strict_1.default.deepEqual((0, project_next_wake_1.collectProjectWakeCandidates)(input({ blockers: [escalated] })), []);
});
(0, node_test_1.test)('W5-1: clauses 3 and 4 produce one candidate per task, not one for the earliest', () => {
    const candidates = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        tasks: [
            { id: 't1', retryBackoffUntil: at(60_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
            { id: 't2', retryBackoffUntil: at(60_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
            { id: 't3', retryBackoffUntil: at(10_000), runAt: null, retryBackoffExpired: true, runAtDue: true },
        ],
    }));
    // Two at the same instant, and the expired one contributes nothing.
    strict_1.default.deepEqual(candidates.map((c) => c.subjectId), ['t1', 't2']);
});
(0, node_test_1.test)('W5-1: clause 7 only fires while a request is actually being held', () => {
    const held = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        rateLimitedTurnWindows: [{ reasonCode: 'MANUAL', windowEndsAt: at(30_000) }],
    }));
    strict_1.default.equal(held[0].reason, 'manual trigger rate-limited');
    strict_1.default.deepEqual((0, project_next_wake_1.collectProjectWakeCandidates)(input({})).filter((c) => c.source === 7), []);
});
// ── W5 clause 2: one total order ────────────────────────────────────────────────────────────
(0, node_test_1.test)('W5-2: the order is (at, source, subjectType, subjectId), byte-wise on the last key', () => {
    const a = candidate({ at: at(10_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' });
    const later = candidate({ at: at(20_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' });
    const higherSource = candidate({ at: at(10_000), source: 2, subjectType: 'BLOCKER', subjectId: 'a' });
    const otherType = candidate({ at: at(10_000), source: 1, subjectType: 'TASK', subjectId: 'a' });
    const otherId = candidate({ at: at(10_000), source: 1, subjectType: 'BLOCKER', subjectId: 'b' });
    strict_1.default.ok((0, project_next_wake_1.compareWakeCandidates)(a, later) < 0);
    strict_1.default.ok((0, project_next_wake_1.compareWakeCandidates)(a, higherSource) < 0);
    strict_1.default.ok((0, project_next_wake_1.compareWakeCandidates)(a, otherType) < 0);
    strict_1.default.ok((0, project_next_wake_1.compareWakeCandidates)(a, otherId) < 0);
    // BLOCKER < PROJECT < TASK < TURN_WINDOW, alphabetically, as the contract freezes it.
    const types = ['TURN_WINDOW', 'TASK', 'PROJECT', 'BLOCKER'];
    strict_1.default.deepEqual(types.map((subjectType) => candidate({ subjectType }))
        .sort(project_next_wake_1.compareWakeCandidates)
        .map((c) => c.subjectType), ['BLOCKER', 'PROJECT', 'TASK', 'TURN_WINDOW']);
});
(0, node_test_1.test)('W5-2a: two same-instant candidates in ONE source are decided, in every permutation', () => {
    // The exact counterexample `PC-CX-39` names: a provider blocker and a runner blocker both due at
    // 60s. Under `(at, source)` alone the winner — and therefore `nextWakeReason` — came down to
    // array order.
    const table = [
        candidate({ at: at(60_000), source: 1, subjectType: 'BLOCKER', subjectId: 'aaa', reason: 'recheck PROVIDER_UNAVAILABLE' }),
        candidate({ at: at(60_000), source: 1, subjectType: 'BLOCKER', subjectId: 'bbb', reason: 'recheck NO_MATCHING_RUNNER' }),
        candidate({ at: at(60_000), source: 3, subjectType: 'TASK', subjectId: 'ccc', reason: 'task retry backoff expires' }),
    ];
    const expected = JSON.stringify((0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table));
    for (const order of permutations(table)) {
        strict_1.default.equal(JSON.stringify((0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, order)), expected, 'the answer and the audit table must be byte-identical under every traversal order');
    }
    const chosen = (0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table);
    strict_1.default.equal(chosen.nextWakeReason, 'recheck PROVIDER_UNAVAILABLE');
});
(0, node_test_1.test)('W5-4: the whole table is audited, sorted, and losers are recorded rather than dropped', () => {
    const decision = (0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, [
        candidate({ at: at(90_000), source: 4, subjectType: 'TASK', subjectId: 'z' }),
        candidate({ at: at(30_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' }),
    ]);
    strict_1.default.equal(decision.candidates.length, 2);
    strict_1.default.deepEqual(decision.candidates.map((c) => c.at), [at(30_000), at(90_000)]);
    strict_1.default.equal(decision.nextWakeAt, at(30_000));
    strict_1.default.equal(decision.flooredBy, null);
});
// ── W5 clause 3: the floor ──────────────────────────────────────────────────────────────────
(0, node_test_1.test)('W3: every remaining-window value has a legal answer, and the floor never loses', () => {
    // §10.4's own measurable form. `remaining` is how much of a 60s rate-limit window is left when
    // this pass evaluates; the last five seconds are where "at most the deadline" and "at least
    // now + 5s" had no common solution before W5 (`PC-CX-35`).
    for (const remaining of [0, 1, 2, 4, 5, 6, 59]) {
        const nextAttemptAt = EPOCH_MS + remaining * 1_000;
        const decision = (0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'PLANNING' }, [
            candidate({
                at: new Date(nextAttemptAt).toISOString(),
                source: 7,
                subjectType: 'TURN_WINDOW',
                subjectId: 'MANUAL',
                reason: 'manual trigger rate-limited',
            }),
        ]);
        const wake = Date.parse(decision.nextWakeAt);
        strict_1.default.ok(wake >= EPOCH_MS + project_next_wake_1.PROJECT_WAKE_FLOOR_MS, `W3 lower bound at remaining=${remaining}`);
        strict_1.default.ok(wake <= nextAttemptAt + project_next_wake_1.PROJECT_WAKE_FLOOR_MS, `I18-C upper bound at remaining=${remaining}`);
        // The reason always stays the winner's: it answers "what am I waking for", not "am I on time".
        strict_1.default.equal(decision.nextWakeReason, 'manual trigger rate-limited');
        strict_1.default.equal(decision.flooredBy, remaining < 5 ? 'W3' : null);
    }
});
(0, node_test_1.test)('W3: the floor is measured from the frozen epoch, never from a second clock', () => {
    // `PC-CX-40`: reading `now()` here would give one serialized `decisionInput` two legal answers
    // depending on how long the pass took to reach this line. The guard is structural — the module
    // may not read a clock at all — because a timing test could pass by being fast.
    const clockReads = SOURCE.match(/Date\.now\(\)|new Date\(\s*\)/g) ?? [];
    strict_1.default.deepEqual(clockReads, [], 'the wake algorithm must read no clock but `evaluation.epoch`');
    const table = [candidate({ at: at(1_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' })];
    const first = (0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table);
    strict_1.default.equal(first.nextWakeAt, at(project_next_wake_1.PROJECT_WAKE_FLOOR_MS));
    strict_1.default.equal(JSON.stringify((0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table)), JSON.stringify(first), 'same input, same answer, whenever it runs');
});
// ── N-null and N-mask ───────────────────────────────────────────────────────────────────────
(0, node_test_1.test)('N-null: SETTLED stops the clock', () => {
    const decision = (0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'SETTLED' }, [
        candidate({ at: at(60_000) }),
    ]);
    strict_1.default.equal(decision.nextWakeAt, null);
    strict_1.default.equal(decision.nextWakeReason, null);
});
(0, node_test_1.test)('N-null: the only other legal stop is every open blocker HUMAN and already escalated', () => {
    const escalated = [
        projection('TEST_FAILED', { id: 'b1', escalatedAt: at(-60_000) }),
        projection('AWAITING_USER_APPROVAL', { id: 'b2', escalatedAt: at(-60_000) }),
    ];
    const candidates = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        blockers: escalated,
        runStateAfter: 'AWAITING_HUMAN',
    }));
    strict_1.default.deepEqual(candidates, []);
    strict_1.default.equal((0, project_next_wake_1.chooseProjectWake)({ epoch: EPOCH, runStateAfter: 'AWAITING_HUMAN' }, candidates).nextWakeAt, null);
    // One un-escalated row is enough to keep it ticking — that alarm is the whole reason a project
    // waiting on a person still has a clock.
    const mixed = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        blockers: [...escalated, projection('WHO_NOT_IN_TEAM', { id: 'b3' })],
        runStateAfter: 'AWAITING_HUMAN',
    }));
    strict_1.default.equal(mixed.length, 1);
    strict_1.default.equal(mixed[0].source, 2);
});
(0, node_test_1.test)('I5: a state no clause names still gets a wake instead of a silent stop', () => {
    // AWAITING_VERIFICATION with nothing in flight matches no clause today. A NULL there is the
    // defect §10.2 W4 would catch five minutes later; this records a wake instead.
    const candidates = (0, project_next_wake_1.collectProjectWakeCandidates)(input({ runStateAfter: 'AWAITING_VERIFICATION' }));
    strict_1.default.equal(candidates.length, 1);
    strict_1.default.equal(candidates[0].reason, 'verification may settle');
    strict_1.default.equal(candidates[0].at, at(project_next_wake_1.PROJECT_WAKE_FALLBACK_MS));
    // And it never runs when anything else produced a candidate.
    const withWork = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        runStateAfter: 'AWAITING_VERIFICATION',
        hasInFlightSession: true,
    }));
    strict_1.default.deepEqual(withWork.map((c) => c.source), [5]);
});
(0, node_test_1.test)('N-mask: a USER blocker cannot stop the clock of the SYSTEM blockers it masks', () => {
    const candidates = (0, project_next_wake_1.collectProjectWakeCandidates)(input({
        // The masking USER row and the masked SYSTEM row, together — I4b says the second is still open.
        blockers: [
            projection('TEST_FAILED', { id: 'human', escalatedAt: at(-60_000) }),
            projection('PROVIDER_UNAVAILABLE', { id: 'system', nextCheckAt: at(300_000) }),
        ],
        runStateAfter: 'AWAITING_HUMAN',
    }));
    strict_1.default.deepEqual(candidates.map((c) => [c.source, c.subjectId]), [[1, 'system'], [2, 'system']], 'an approval blocker must not freeze every provider blocker in the same project');
});
// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function input(overrides) {
    return {
        epoch: EPOCH,
        projectId: PROJECT,
        runStateAfter: 'BLOCKED',
        blockers: [],
        tasks: [],
        hasInFlightSession: false,
        rateLimitedTurnWindows: [],
        ...overrides,
    };
}
function projection(kind, overrides = {}) {
    const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
    return {
        id: null,
        kind,
        owner: policy.owner,
        recovery: policy.recovery,
        dedupeKey: (0, project_blocker_1.projectBlockerDedupeKey)(kind, 'TASK', 'task'),
        subjectType: 'TASK',
        subjectId: 'task',
        firstSeenAt: at(0),
        nextCheckAt: at(policy.pollMs ?? policy.escalateMs),
        escalatedAt: null,
        requiredAction: policy.requiredAction,
        conditionVersion: '0'.repeat(64),
        lifecycleGeneration: '1',
        ...overrides,
    };
}
function candidate(overrides = {}) {
    return {
        at: at(60_000),
        source: 1,
        subjectType: 'BLOCKER',
        subjectId: 'a',
        reason: 'recheck',
        ...overrides,
    };
}
function at(offsetMs) {
    return new Date(EPOCH_MS + offsetMs).toISOString();
}
function permutations(items) {
    if (items.length <= 1)
        return [[...items]];
    return items.flatMap((item, at) => permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]));
}
//# sourceMappingURL=project-next-wake.spec.js.map