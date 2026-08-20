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

import type { ProjectDecisionInput } from './project-decision.service';

/**
 * §4.2 guard 5 / §7.5's shared definition of a session that is still going.
 *
 * One definition, here, because the two clauses that read it must agree: a coordinator session that
 * counts as live is one §7.5 must NOT rotate, and a task session that counts as live is one §4.2
 * reads as EXECUTING. `AWAITING_INPUT` and `INTERRUPTED` are live on purpose — both are resumable,
 * and rotating away from a conversation somebody paused would destroy the thing they paused.
 */
export const PROJECT_LIVE_SESSION_STATUSES: readonly string[] = [
  'PENDING',
  'RUNNING',
  'AWAITING_INPUT',
  'INTERRUPTED',
];

export function isLiveSessionStatus(status: string): boolean {
  return PROJECT_LIVE_SESSION_STATUSES.includes(status);
}

/** Why this project needs a new coordination run. Closed set; it enters the action audit. */
export type CoordinatorRotationTrigger =
  /** The project names no coordinator session at all — a first binding, or one that was cleared. */
  | 'NO_COORDINATOR_SESSION'
  /** The pointer names a row this snapshot cannot see (hard-deleted between two reads). */
  | 'COORDINATOR_SESSION_MISSING'
  /** In Trash. §7.5's "被用户删除" — reviving it would undo a deliberate deletion. */
  | 'COORDINATOR_SESSION_DELETED'
  /** Ended normally (`SUCCEEDED` / `CANCELLED`) — §8.4's `session.ended`. */
  | 'COORDINATOR_SESSION_ENDED'
  /** Died (`FAILED`) — §8.4's "Coordinator Session 在 turn 中途死". */
  | 'COORDINATOR_SESSION_FAILED';

/** Why a needed rotation may not happen. Each maps onto §11.2's `COORDINATOR_UNAVAILABLE`. */
export type CoordinatorRotationRefusal =
  | 'COORDINATION_WORKSPACE_MISSING'
  | 'COORDINATION_WORKSPACE_UNAVAILABLE'
  | 'COORDINATOR_NOT_ASSIGNED'
  | 'COORDINATOR_NOT_IN_TEAM'
  | 'COORDINATOR_AGENT_DISABLED';

export type CoordinatorSessionPlan =
  /**
   * The snapshot predates migration 0126 and carries no rotation baseline. A decision captured then
   * was made by a binary that never rotated, so replaying it must produce what it produced — not
   * today's rules applied to yesterday's world (the same discipline `world.blockers` follows).
   */
  | { status: 'UNSUPPORTED' }
  /** Out of the loop (§5.5 EV3's predicate). Nothing is rotated for a project nobody is running. */
  | { status: 'OUT_OF_LOOP' }
  /** Never bound and nothing to bind from. A fresh project is not a broken one (§11.2). */
  | { status: 'UNBOUND' }
  | { status: 'HEALTHY'; sessionId: string }
  | {
    status: 'ROTATE';
    trigger: CoordinatorRotationTrigger;
    /** The generation the NEW run will be, i.e. the epoch of its permanent action key (§8.2 GE1). */
    generation: string;
    /** Base62, or null when the project names none. History, for the audit. */
    fromSessionId: string | null;
    /** Base62. §7.5 落点固定: the new run opens here or not at all. */
    landingWorkspaceId: string;
    coordinatorAgentId: string;
  }
  | {
    status: 'UNAVAILABLE';
    trigger: CoordinatorRotationTrigger;
    reason: CoordinatorRotationRefusal;
    fromSessionId: string | null;
    landingWorkspaceId: string | null;
  };

/**
 * §8.2's key for a rotation. The epoch is `coordinator_generation + 1` — the generation the run
 * being opened WILL be — which is the one counter in this system that a rotation advances and
 * nothing ever moves back (0113 maintains it in the database, from two committed facts).
 *
 * `projectId` is the raw UUID, not Base62: a permanent key is an internal identity, and re-encoding
 * it would change every historical action's name the day the codec changes (§8.2).
 */
export function rotateCoordinatorSessionIdempotencyKey(
  projectId: string,
  generation: bigint | string,
): string {
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
export function planCoordinatorSessionRotation(
  input: ProjectDecisionInput,
): CoordinatorSessionPlan {
  if (input.world.runtime.coordinatorSessionId === undefined) return { status: 'UNSUPPORTED' };

  const project = input.world.project;
  if (project.status !== 'OPEN' || !project.coordinatorEnabled) return { status: 'OUT_OF_LOOP' };

  const current = input.world.coordinatorSession;
  const trigger = rotationTrigger(project.coordinatorSessionId, current);
  if (!trigger) return { status: 'HEALTHY', sessionId: current!.id };

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

  return {
    status: 'ROTATE',
    trigger,
    generation: String(BigInt(input.world.runtime.coordinatorGeneration) + 1n),
    fromSessionId: project.coordinatorSessionId,
    landingWorkspaceId: landing,
    coordinatorAgentId: agentId,
  };
}

/** Null when the current run is still going, else why it is not. */
function rotationTrigger(
  pointer: string | null,
  current: ProjectDecisionInput['world']['coordinatorSession'],
): CoordinatorRotationTrigger | null {
  if (pointer === null) return 'NO_COORDINATOR_SESSION';
  if (!current) return 'COORDINATOR_SESSION_MISSING';
  if (current.deletedAt) return 'COORDINATOR_SESSION_DELETED';
  if (isLiveSessionStatus(current.runStatus)) return null;
  return current.runStatus === 'FAILED'
    ? 'COORDINATOR_SESSION_FAILED'
    : 'COORDINATOR_SESSION_ENDED';
}
