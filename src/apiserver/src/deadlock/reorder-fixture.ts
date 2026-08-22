import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import type { PlanStep, ScenarioSpec } from './pg-barrier';

/**
 * The multi-row write whose lock order the caller chooses: a sidebar reorder.
 *
 * `WorkspacesService.reorder` and `RunnersService.reorderRunners` both take a list of ids in the
 * order a person dragged them into and write a position onto every one. Nothing about that order
 * is shared with any other request, and two people rearranging one sidebar — or one person on two
 * devices — routinely produce reversed lists. Writing in the caller's order therefore took the
 * same rows in opposite orders, which is a textbook two-party deadlock with no trigger, no foreign
 * key and no lock anybody would think to look for in it.
 *
 * This fixture is the measurement, in both directions:
 *
 *  - `unorderedReorderScenario` replays the pre-fix statements — each party in its own drag order
 *    — and is expected to produce 40P01. It is the CONTROL: without it, a passing post-fix run
 *    proves only that the barrier failed to make anything happen.
 *  - `orderedReorderScenario` replays what the code issues today — every party in id order — and
 *    is expected to have every party commit, from either arrival order.
 *
 * The two differ in exactly one respect: the sequence the same three UPDATEs are issued in. Same
 * rows, same values, same transactions.
 */

export interface ReorderFixtureIds {
  label: string;
  ownerId: string;
  runnerId: string;
  /** Sorted ascending, so "id order" and "array order" are the same thing for this array. */
  workspaceIds: string[];
}

/** Ids for one round. The workspace ids are SORTED so the plans can be written against indexes. */
export function newReorderFixtureIds(label: string, count = 3): ReorderFixtureIds {
  return {
    label,
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceIds: Array.from({ length: count }, () => randomUUID()).sort(),
  };
}

export async function seedReorderFixture(client: Client, ids: ReorderFixtureIds): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "user" ("id", "email", "name", "password_hash")
       VALUES ($1::uuid, $2, $3, 'x')`,
      [ids.ownerId, `${ids.label}-${ids.ownerId}@reorder.invalid`, ids.label],
    );
    await client.query(
      `INSERT INTO "runner" ("id", "owner_id", "name", "token_hash", "status")
       VALUES ($1::uuid, $2::uuid, $3, 'x', 'ONLINE'::runner_status)`,
      [ids.runnerId, ids.ownerId, `${ids.label}-runner`],
    );
    for (const [index, id] of ids.workspaceIds.entries()) {
      await client.query(
        `INSERT INTO "workspace" ("id", "owner_id", "name", "runner_id", "position")
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)`,
        [id, ids.ownerId, `${ids.label}-w${index}`, ids.runnerId, index],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function cleanupReorderFixture(client: Client, ids: ReorderFixtureIds): Promise<void> {
  await client.query(`DELETE FROM "workspace" WHERE "owner_id" = $1::uuid`, [ids.ownerId]);
  await client.query(`DELETE FROM "runner" WHERE "owner_id" = $1::uuid`, [ids.ownerId]);
  await client.query(`DELETE FROM "user" WHERE "id" = $1::uuid`, [ids.ownerId]);
}

const SET_POSITION = 'UPDATE "workspace" SET "position" = $2 WHERE "id" = $1::uuid';

/** The positions each party wants: one drags the last workspace to the front, the other the first. */
export function requestedOrders(ids: ReorderFixtureIds): { forward: string[]; reversed: string[] } {
  const forward = [...ids.workspaceIds];
  return { forward, reversed: [...forward].reverse() };
}

/** `id -> position` for a requested order, which is what the endpoint actually stores. */
export function positionsFor(order: string[]): Map<string, number> {
  return new Map(order.map((id, position) => [id, position]));
}

function writes(party: string, order: string[], positions: Map<string, number>): PlanStep[] {
  return order.map((id, index) => ({
    op: 'run' as const,
    party,
    label: `${party}${index + 1} set-position ${id.slice(0, 4)}`,
    sql: SET_POSITION,
    values: [id, positions.get(id)],
  }));
}

/**
 * The pre-fix shape: each party writes in the order its own caller sent.
 *
 * The plan is the minimum that closes a ring. `forward` takes the FIRST row and stops; `reversed`
 * takes the LAST row and then asks for the first, which `forward` holds; `forward` then asks for
 * the last, which `reversed` holds. Nothing here sleeps: the barrier advances only once
 * PostgreSQL reports the waiter parked on the expected backend.
 */
export function unorderedReorderScenario(ids: ReorderFixtureIds): ScenarioSpec {
  const { forward, reversed } = requestedOrders(ids);
  const forwardPositions = positionsFor(forward);
  const reversedPositions = positionsFor(reversed);
  const first = forward[0];
  const last = forward[forward.length - 1];
  return {
    name: 'reorder/unordered-both-directions',
    parties: [
      // The victim is a configured detector threshold, not a race: only this backend's deadlock
      // check runs inside the plan, so it is the one that finds the cycle.
      { name: 'forward', deadlockTimeout: '100ms' },
      { name: 'reversed', deadlockTimeout: '30s' },
    ],
    plan: [
      { op: 'run', party: 'forward', label: 'F1 hold-first', sql: SET_POSITION,
        values: [first, forwardPositions.get(first)] },
      { op: 'run', party: 'reversed', label: 'R1 hold-last', sql: SET_POSITION,
        values: [last, reversedPositions.get(last)] },
      { op: 'block', party: 'reversed', label: 'R2 want-first', sql: SET_POSITION,
        values: [first, reversedPositions.get(first)], blockedBy: ['forward'] },
      { op: 'block', party: 'forward', label: 'F2 want-last', sql: SET_POSITION,
        values: [last, forwardPositions.get(last)], blockedBy: ['reversed'] },
      { op: 'settle', party: 'forward' },
      { op: 'finish', party: 'forward', action: 'COMMIT' },
      { op: 'settle', party: 'reversed' },
      { op: 'finish', party: 'reversed', action: 'COMMIT' },
    ],
  };
}

export type ReorderArrival = 'forward-first' | 'reversed-first';
export const REORDER_ARRIVALS: readonly ReorderArrival[] = ['forward-first', 'reversed-first'];

/**
 * What the endpoint issues today: both parties write in ID order, whatever order they were asked
 * for. The positions each stores are still its caller's.
 *
 * Whichever party arrives first holds the first row; the other blocks on it ONCE and then runs to
 * completion behind it. A wait, not a cycle, from either direction.
 */
export function orderedReorderScenario(
  ids: ReorderFixtureIds,
  arrival: ReorderArrival,
): ScenarioSpec {
  const { forward, reversed } = requestedOrders(ids);
  const ordered = [...ids.workspaceIds];
  const forwardPositions = positionsFor(forward);
  const reversedPositions = positionsFor(reversed);
  const leader = arrival === 'forward-first' ? 'forward' : 'reversed';
  const follower = arrival === 'forward-first' ? 'reversed' : 'forward';
  const leaderPositions = leader === 'forward' ? forwardPositions : reversedPositions;
  const followerPositions = follower === 'forward' ? forwardPositions : reversedPositions;
  const [head, ...rest] = ordered;
  return {
    name: `reorder/ordered-${arrival}`,
    parties: [
      { name: 'forward', deadlockTimeout: '100ms' },
      { name: 'reversed', deadlockTimeout: '100ms' },
    ],
    plan: [
      ...writes(leader, ordered, leaderPositions),
      // The follower's first statement is the only place it can wait, because from here on the
      // leader holds every row it wants and holds them in the same order it wants them.
      { op: 'block', party: follower, label: `${follower}1 set-position ${head.slice(0, 4)}`,
        sql: SET_POSITION, values: [head, followerPositions.get(head)], blockedBy: [leader] },
      { op: 'finish', party: leader, action: 'COMMIT' },
      { op: 'settle', party: follower },
      ...writes(follower, rest, followerPositions),
      { op: 'finish', party: follower, action: 'COMMIT' },
    ],
  };
}
