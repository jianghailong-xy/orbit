"use strict";
/**
 * §7.5 — the Coordinator SESSION as a rotatable, recoverable run record.
 *
 * The AGENT is the identity (`project_member.role = COORDINATOR`, migration 0113); the SESSION is
 * one run of it. This module answers one question about a frozen snapshot: does this project need a
 * new coordination run, and may it have one? It decides nothing about WHO or WHERE — §7.5 freezes
 * both ("轮换只换 Session"), so the answer is either "rotate, in the landing this project already
 * records" or "this project's coordinator is unavailable and its owner has to say where it lives".
 *
 * Pure, because everything downstream depends on it being replayable: the rotation's idempotency
 * key is derived from the generation this plan read, and §8.2 DA2's exactly-once argument is that
 * the same snapshot always computes the same key.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COORDINATOR_ROTATION_REASON_CODE = exports.PROJECT_LIVE_SESSION_STATUS_SQL = exports.PROJECT_LIVE_SESSION_STATUSES = void 0;
exports.isLiveSessionStatus = isLiveSessionStatus;
exports.rotateCoordinatorSessionIdempotencyKey = rotateCoordinatorSessionIdempotencyKey;
exports.planCoordinatorSessionRotation = planCoordinatorSessionRotation;
exports.rotationReasonCode = rotationReasonCode;
exports.rotationReasonDigest = rotationReasonDigest;
const node_crypto_1 = require("node:crypto");
/**
 * §4.2 guard 5 / §7.5's shared definition of a session that is still going.
 *
 * One definition, here, because the two clauses that read it must agree: a coordinator session that
 * counts as live is one §7.5 must NOT rotate, and a task session that counts as live is one §4.2
 * reads as EXECUTING. `AWAITING_INPUT` and `INTERRUPTED` are live on purpose — both are resumable,
 * and rotating away from a conversation somebody paused would destroy the thing they paused.
 */
exports.PROJECT_LIVE_SESSION_STATUSES = [
    'PENDING',
    'RUNNING',
    'AWAITING_INPUT',
    'INTERRUPTED',
];
function isLiveSessionStatus(status) {
    return exports.PROJECT_LIVE_SESSION_STATUSES.includes(status);
}
/**
 * The same four statuses as a SQL literal list, so a raw gate cannot quietly hold a fifth opinion.
 *
 * It had three. `project_reconcile` and the boot recovery scan asked for all four; the three
 * authorization counts — project concurrency, agent concurrency and §7.4 precondition 4's own
 * `hasLiveSession` — asked for `('PENDING', 'RUNNING')` only. A task paused at `AWAITING_INPUT`
 * therefore read as having no live session AT THE COMMIT POINT while every pure gate above read it
 * as occupied, and the disagreement is a second Session on a conversation somebody paused: the
 * partial unique index `session_task_execution_claim_idx` covers the same two statuses, so nothing
 * below the service would have refused it either.
 *
 * Interpolated as a literal rather than parameterised because it is a fixed list this file owns,
 * and because a gate is then greppable for the exact string.
 */
exports.PROJECT_LIVE_SESSION_STATUS_SQL = exports.PROJECT_LIVE_SESSION_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');
/**
 * §8.2's key for a rotation. The epoch is `coordinator_generation + 1` — the generation the run
 * being opened WILL be — which is the one counter in this system that a rotation advances and
 * nothing ever moves back (0113 maintains it in the database, from two committed facts).
 *
 * `projectId` is the raw UUID, not Base62: a permanent key is an internal identity, and re-encoding
 * it would change every historical action's name the day the codec changes (§8.2).
 */
function rotateCoordinatorSessionIdempotencyKey(projectId, generation) {
    return `pc:v1:${projectId}:rotate:${generation}`;
}
/**
 * What §7.5 says about this snapshot.
 *
 * The order of the clauses is the order the answers stop being useful in: out of the loop first (a
 * project nobody is running has no next run), then whether a run is needed at all, and only then
 * whether one is possible. Asking "is the landing usable" of a project whose coordinator is alive
 * and well would raise a blocker about a situation nobody is in.
 */
function planCoordinatorSessionRotation(input) {
    if (input.world.runtime.coordinatorSessionId === undefined)
        return { status: 'UNSUPPORTED' };
    const project = input.world.project;
    if (project.status !== 'OPEN' || !project.coordinatorEnabled)
        return { status: 'OUT_OF_LOOP' };
    const current = input.world.coordinatorSession;
    const trigger = rotationTrigger(project.coordinatorSessionId, current);
    if (!trigger)
        return { status: 'HEALTHY', sessionId: current.id };
    const landing = project.coordinatorWorkspaceId;
    // "This project has had a coordination RUN" — not "somebody chose its coordinator". WHO and WHERE
    // are independent chains (PAC R3), so an owner who named a coordinator agent and never bound a
    // coordination workspace has not LOST anything: nothing about the project is broken, its task
    // dispatch is unaffected, and a project-scoped blocker here would stop the work of every project
    // that has only ever been driven by hand. What can be lost is a RUN — the pointer names one, the
    // rotation baseline remembers one, or a rotation has been counted.
    const everCoordinated = project.coordinatorSessionId !== null
        || input.world.runtime.coordinatorSessionId !== null
        || input.world.runtime.coordinatorGeneration !== '0';
    if (!landing) {
        // A project that has never had a coordination run and records no landing has not been set up,
        // which is not a fault: §7.4 answers it where it bites, by refusing the first dispatch. A
        // project that HAS had one and lost its landing (the FK's SET NULL) is the §7.5 blocker — the
        // loop is forbidden to choose a new home for it, so its owner has to.
        return everCoordinated
            ? {
                status: 'UNAVAILABLE',
                trigger,
                reason: 'COORDINATION_WORKSPACE_MISSING',
                fromSessionId: project.coordinatorSessionId,
                landingWorkspaceId: null,
            }
            : { status: 'UNBOUND' };
    }
    const workspace = input.world.workspaces.find((row) => row.workspaceId === landing);
    if (!workspace || workspace.deletedAt || !workspace.enabled) {
        return {
            status: 'UNAVAILABLE',
            trigger,
            reason: 'COORDINATION_WORKSPACE_UNAVAILABLE',
            fromSessionId: project.coordinatorSessionId,
            landingWorkspaceId: landing,
        };
    }
    // WHO, asked separately from WHERE (PAC R3): the two are independent chains, and a rotation that
    // opened a run for an identity that may not act would be refused by §9's authorization anyway —
    // one pass later, having already made a session. Refusing here keeps the two answers the same.
    const agentId = project.coordinatorAgentId;
    if (!agentId) {
        return {
            status: 'UNAVAILABLE',
            trigger,
            reason: 'COORDINATOR_NOT_ASSIGNED',
            fromSessionId: project.coordinatorSessionId,
            landingWorkspaceId: landing,
        };
    }
    const seat = input.world.team.find((member) => member.agentId === agentId);
    if (!seat) {
        return {
            status: 'UNAVAILABLE',
            trigger,
            reason: 'COORDINATOR_NOT_IN_TEAM',
            fromSessionId: project.coordinatorSessionId,
            landingWorkspaceId: landing,
        };
    }
    if (seat.deletedAt || !seat.enabled) {
        return {
            status: 'UNAVAILABLE',
            trigger,
            reason: 'COORDINATOR_AGENT_DISABLED',
            fromSessionId: project.coordinatorSessionId,
            landingWorkspaceId: landing,
        };
    }
    // §7.6 TR3. Everything above answered "may this project have a run"; this answers "would another
    // one be a second look at the same world". The comparison is against the run the LAST rotation
    // opened, and only once that run is over — a rotation whose run is still going never gets here,
    // because a live coordinator is HEALTHY.
    const reasonDigest = rotationReasonDigest(input);
    const previous = lastAppliedRotation(input);
    if (previous && previous.reasonDigest === reasonDigest) {
        return {
            status: 'NO_PROGRESS',
            trigger,
            reasonDigest,
            lastRunSessionId: previous.resultSessionId,
            fromSessionId: project.coordinatorSessionId,
        };
    }
    return {
        status: 'ROTATE',
        trigger,
        generation: String(BigInt(input.world.runtime.coordinatorGeneration) + 1n),
        fromSessionId: project.coordinatorSessionId,
        landingWorkspaceId: landing,
        coordinatorAgentId: agentId,
        reasonDigest,
    };
}
/** The `reason_code` a rotation's ledger row carries, and the prefix TR3 reads it back through. */
exports.COORDINATOR_ROTATION_REASON_CODE = 'COORDINATOR_RUN_GONE';
function rotationReasonCode(reasonDigest) {
    return `${exports.COORDINATOR_ROTATION_REASON_CODE}:${reasonDigest}`;
}
/**
 * §7.6 TR1's digest, for a coordination RUN: what the coordinator would be looking at.
 *
 * Deliberately NOT the trigger. "The run ended" and "the run failed" are the same request for the
 * same work, and letting them differ would give a crash-loop a way to alternate its way past TR3.
 * What decides whether another run is worth opening is whether anything it could act on has moved:
 *
 *   * every task's status — the coordinator's whole subject matter;
 *   * every open blocker, WITH its lifecycle generation (§7.6's TR3 premise, PC-CX-24: a blocker
 *     that was resolved and came back is a new episode, not the old one still sitting there);
 *   * `configRevision` — an owner changing the policy, the cap or the budget is a new instruction.
 *
 * Nothing here advances with delivery count (PC-CX-10), so a redelivered event cannot manufacture
 * "the world changed". `COORDINATOR_NO_PROGRESS` itself is excluded for the reason a rule may not
 * be its own input: the row this digest DECIDES to open would otherwise change the digest, the
 * condition would go false on the next pass, the row would clear, and the loop would rotate again.
 */
function rotationReasonDigest(input) {
    // §13.6 SU6. The task projection was `id:status`, and supersession moves NEITHER of them — SU1's
    // whole point is that linking a successor writes no `status`. So a project whose last coordination
    // run ended, and whose work graph then changed only by an attempt being replaced, hashed to the
    // same digest and was told NO_PROGRESS: the coordinator would not rotate for a change that is
    // exactly the kind of change a coordinator exists to notice.
    //
    // The version is CONDITIONAL, and that is the mixed-version rule rather than a preference. A
    // decision captured before 0129 has no such columns on any of its tasks; hashing it at v2 with
    // two empty strings appended would give a different digest for the same recorded world, and TR3
    // compares this against a digest stored in an action row a previous binary wrote — every one of
    // those projects would rotate once, spuriously, on deploy. So a snapshot that carries the fields
    // is hashed at v2 and one that does not replays byte-identically at v1.
    const carriesSupersession = input.world.tasks.some((task) => 'terminalReason' in task || 'supersededByTaskId' in task);
    const facts = {
        v: carriesSupersession ? 2 : 1,
        reasonCode: exports.COORDINATOR_ROTATION_REASON_CODE,
        configRevision: input.world.project.configRevision,
        tasks: input.world.tasks
            .map((task) => (carriesSupersession
            // `supersededAt` is deliberately absent, the same decision the acceptance digest makes: it
            // is audit, not semantics, and nothing decides anything from it.
            ? `${task.id}:${task.status}:${task.terminalReason ?? ''}:${task.supersededByTaskId ?? ''}`
            : `${task.id}:${task.status}`))
            .sort(),
        blockers: (input.world.blockers ?? [])
            .filter((blocker) => blocker.kind !== 'COORDINATOR_NO_PROGRESS')
            .map((blocker) => `${blocker.dedupeKey}#${blocker.lifecycleGeneration}`)
            .sort(),
    };
    return (0, node_crypto_1.createHash)('sha256').update(canonical(facts)).digest('hex');
}
/** The most recent rotation this project actually applied, and the facts it was applied on. */
function lastAppliedRotation(input) {
    // `world.actions` arrives in commit order, so the last match is the most recent one.
    for (let i = input.world.actions.length - 1; i >= 0; i -= 1) {
        const action = input.world.actions[i];
        if (action.type !== 'ROTATE_COORDINATOR_SESSION' || action.status !== 'APPLIED')
            continue;
        const reasonCode = action.reasonCode ?? '';
        if (!reasonCode.startsWith(`${exports.COORDINATOR_ROTATION_REASON_CODE}:`))
            return null;
        return {
            reasonDigest: reasonCode.slice(exports.COORDINATOR_ROTATION_REASON_CODE.length + 1),
            resultSessionId: action.resultSessionId,
        };
    }
    return null;
}
/** Key-sorted JSON, the same shape `hashDecisionInput` canonicalizes with. */
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
/** Null when the current run is still going, else why it is not. */
function rotationTrigger(pointer, current) {
    if (pointer === null)
        return 'NO_COORDINATOR_SESSION';
    if (!current)
        return 'COORDINATOR_SESSION_MISSING';
    if (current.deletedAt)
        return 'COORDINATOR_SESSION_DELETED';
    if (isLiveSessionStatus(current.runStatus))
        return null;
    return current.runStatus === 'FAILED'
        ? 'COORDINATOR_SESSION_FAILED'
        : 'COORDINATOR_SESSION_ENDED';
}
//# sourceMappingURL=project-coordinator-session.js.map