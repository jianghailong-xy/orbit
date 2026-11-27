import { Prisma } from '@prisma/client';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { sessionHeldSql } from './session-release';
import { SPAWN_TREE_RUNNER_RESERVE } from './session-scheduling';

/**
 * The spawn-tree cap, as SQL, in one place.
 *
 * Two callers need to agree on it exactly: the claim queue, which uses it to decide whether a
 * queued session may take a slot, and the session list, which uses it to tell a waiting user
 * *why* their session has not started. Written twice they would drift, and the failure is
 * silent and expensive — the UI would confidently name the wrong gate, which is worse than the
 * "Waiting for a free slot" it replaced. So both compose these fragments instead.
 *
 * Every fragment takes its table aliases as raw SQL because the two queries name the session
 * table differently, and neither may bind an alias as a parameter.
 *
 * An active turn, the one thing that holds a slot, is the turn state IN_FLIGHT (what RUNNING said), and a turn still
 * owed is QUEUED or IN_FLIGHT (PENDING or RUNNING), read through sessions/session-turn-state.ts
 * (docs/session-status-retirement-plan.md §1.4). `phase` is never read here: it is RUNNING for a background job too.
 */
const inFlight = (alias: string): Prisma.Sql => Prisma.sql`${sessionTurnStateSql(alias)} = 'IN_FLIGHT'`;

/**
 * How many active turns a spawn tree currently holds, NOT counting supervisors.
 *
 * A supervisor — a session with a child still queued or running — is exempt because
 * session_create(wait) blocks the parent's tool call while the parent stays RUNNING. Charging
 * it against the cap its own child must draw from is a thread-pool deadlock: fill the cap with
 * waiters and no child is ever claimable, every wait times out, and each parent is handed back
 * a child still sitting in PENDING as though the work were merely slow. The NOT EXISTS is
 * precisely that blocking condition, so the exemption covers exactly the rows that can
 * deadlock and releases itself the moment the child settles.
 *
 * `sessionAlias` is the row whose tree is being measured.
 */
export function treeActiveTurns(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(
    SELECT count(*) FROM "session" tree
    WHERE tree."root_session_id" = ${s}."root_session_id"
      AND ${inFlight('tree')}
      AND NOT EXISTS (
        SELECT 1 FROM "session" child
        WHERE child."parent_session_id" = tree.id
          AND ${sessionTurnStateSql('child')} IN ('QUEUED', 'IN_FLIGHT')
      )
  )`;
}

/**
 * The most active turns one tree may hold on a runner.
 *
 * A share of that machine's capacity rather than an absolute count: the scarce resource is a
 * slot on this runner, and a fixed number knows nothing about how many there are — the same
 * constant is meaningless on a 2-slot runner and absurdly tight on a 64-slot one.
 *
 * Deliberately generous, because it is not what produces fairness. Claim order is (a tree
 * already holding slots is picked last), and unlike a ceiling that is work-conserving. The
 * ceiling only guarantees what ordering cannot: a newcomer gets a first slot without waiting
 * out someone else's long turn.
 *
 * `runnerIdSql` is however the calling query names the runner — a bound id in the claim, a
 * joined column in the list.
 */
export function treeCeiling(runnerIdSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`GREATEST(
    1,
    (SELECT r."max_concurrent" FROM "runner" r WHERE r.id = ${runnerIdSql})
      - ${SPAWN_TREE_RUNNER_RESERVE}
  )`;
}

/** Active turns already held on a runner. A slot is an active turn, not a warm process. */
export function runnerActiveTurns(runnerIdSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    SELECT count(*) FROM "session" active
    WHERE active."assigned_runner_id" = ${runnerIdSql}
      -- Held, beside the turn state, so a runner's held rows are the access path (session_runner_held_idx).
      AND ${sessionHeldSql('active')}
      AND ${inFlight('active')}
  )`;
}

/**
 * Sessions on a runner that run no turn but hold one of its slots through a background job: open
 * (held), not IN_FLIGHT, and named by the runner's last beat (runner_presence.background_job_session_ids,
 * migration 0780; runners/runner-background-holders.ts). The runner itself admits against turns
 * plus these (src/runner-go/session_pool.go), so a count of turns alone reads a full machine as
 * having room. The queued explanation reads it, and so does Run now's overflow claim, which may go
 * past the limit only up to max + burst of what the runner admits against; the ordinary claim gate
 * counts turns, and the runner holds back its claims by itself. Ask it only of a runner known to be online: a
 * stale presence row still names the holders of its last beat.
 */
export function runnerBackgroundHeldSessions(runnerIdSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    SELECT count(*) FROM "session" held
    WHERE held."assigned_runner_id" = ${runnerIdSql}
      AND ${sessionHeldSql('held')}
      AND ${sessionTurnStateSql('held')} IS DISTINCT FROM 'IN_FLIGHT'
      AND held.id = ANY(
        SELECT unnest(p."background_job_session_ids") FROM "runner_presence" p
         WHERE p."runner_id" = ${runnerIdSql}
      )
  )`;
}

/** Active turns already held by a batch run. Same active-turn semantics, user-chosen cap. */
export function batchActiveTurns(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(
    SELECT count(*) FROM "session" ba
    WHERE ba."batch_id" = ${s}."batch_id"
      AND ${inFlight('ba')}
  )`;
}

/** Whether session `alias` holds a Run now pass whose turn is still queued: what the overflow claim takes it on. */
export function overCapacityPassPendingSql(alias: string): Prisma.Sql {
  const s = Prisma.raw(alias);
  return Prisma.sql`(${s}."over_capacity_turn_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "conversation_turn" pass
     WHERE pass."id" = ${s}."over_capacity_turn_id"
       AND pass."session_id" = ${s}."id"
       AND pass."status" = 'PENDING'
  ))`;
}
