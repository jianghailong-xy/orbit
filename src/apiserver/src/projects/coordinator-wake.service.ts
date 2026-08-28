import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { WakeFact, wakeIdempotencyKey } from './coordinator-wake';

/**
 * The durable half of `coordinator-wake.ts`: one committed fact wakes a coordinator once.
 *
 * WHAT THIS UNIT IS, AND WHAT IT IS NOT
 * =====================================
 * It claims wakes. It does not open sessions, choose tasks, judge anything or hold a timer.
 * Producers derive a fact from rows they have already committed and hand it to `claim`; a durable
 * courier may retry that delivery on a clock, but the clock is never evidence and never changes
 * the fact's identity. Unit T3 turns a won claim into exactly one judgment session.
 *
 * THE ORDER, WHICH IS THE POINT
 * =============================
 *   1. the key is computed from the fact,
 *   2. the key is CLAIMED — one INSERT, `ON CONFLICT DO NOTHING`, so the database picks the winner,
 *   3. and only then is the wake authorized.
 *
 * Steps 2 and 3 are in that order because a gate that runs first makes the winner of a race depend
 * on the answer to a question about permission (2026-08-23, `TasksService.create`: the gate ran
 * before the idempotency lookup, a rotation moved the scope, and a retry of an already-committed
 * write could never read its own row back). The signature of `WakeAuthorizer` states the rule as a
 * type: it is handed the claim, so it cannot run before there is one.
 *
 * A REFUSAL MUST NOT BURN THE KEY
 * ===============================
 * The other half, and the more expensive accident. `project_action`'s key is a plain unique index,
 * so a refusal recorded against it is permanent: the next pass re-derives the same key, `ON
 * CONFLICT DO NOTHING` says `ALREADY_APPLIED`, and that fact can never wake anybody again —
 * `project-reconcile.service.ts` used to say so in as many words, "a turn key spent on a refusal
 * can never be claimed again", and the coordinator rotation path was welded shut by exactly this.
 *
 * So the unique index here is PARTIAL: `UNIQUE (idempotency_key) WHERE status <> 'REFUSED'`
 * (migration 0174). A refused row leaves the index and stays in the table, so the fact can be
 * delivered again and the refusal is still readable afterwards — "it silently did nothing" is not
 * a state this table can be in. The predicate is written negatively on purpose: any status added
 * later is inside the index by default, so a future `SETTLED` holds the key rather than releasing
 * it. Failing closed is the safe direction for an index whose job is to stop a second wake.
 *
 * WHEN A LOSER LOSES TO A CLAIM THAT IS THEN REFUSED
 * ==================================================
 * A delivery that lost the INSERT reports `ALREADY_AWAKE` without re-reading, and the holder it
 * lost to may go on to be refused a moment later — leaving that delivery's fact unclaimed. This is
 * deliberate and it is why wakes are DERIVED rather than queued: the producer re-derives the same
 * fact from the same committed rows on its next pass and wins the key that the refusal released.
 * Recovering it here instead would mean a read-then-write over a row somebody else still holds,
 * which is the shape that is never safe (`pg-unlocked-exclude-is-not-safe`).
 */

/** Why a wake was refused. The value is the caller's — unit T6 owns the closed set of them. */
export type WakeAuthorization = { allowed: true } | { allowed: false; refusalCode: string };

/** The claim the authorizer is handed. Its existence is the proof that step 2 already happened. */
export interface WakeClaim {
  wakeId: string;
  idempotencyKey: string;
}

export type WakeAuthorizer = (
  fact: WakeFact,
  claim: WakeClaim,
) => WakeAuthorization | Promise<WakeAuthorization>;

export type WakeOutcome =
  /** This delivery claimed the fact. Exactly one delivery of a given fact ever gets this. */
  | { outcome: 'WOKEN'; wakeId: string; idempotencyKey: string }
  /** Somebody else holds this fact. No wakeId, because reading one back would be that read. */
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  /** The claim was made and then released, so the same fact may be delivered again. */
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

/**
 * What an authorizer that threw is recorded as. A throw is not a decision, but leaving the claim
 * standing would weld the fact shut over a bug or a dropped connection — the precise outcome this
 * unit exists to prevent — so it releases the key and re-raises.
 */
export const WAKE_AUTHORIZATION_FAILED = 'WAKE_AUTHORIZATION_FAILED';

@Injectable()
export class CoordinatorWakeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deliver one committed fact. Idempotent by the fact's own identity, not by the caller's.
   *
   * Not a transaction, deliberately: the authorization step sits between the claim and the
   * release, and holding a row lock across a call whose duration this unit does not control is how
   * a fast path becomes a queue. Each statement is its own implicit transaction, and the partial
   * unique index — not a read — is what decides the winner.
   */
  async claim(fact: WakeFact, authorize: WakeAuthorizer): Promise<WakeOutcome> {
    // (1) Identity first, from the fact alone. Nothing below may move it.
    const idempotencyKey = wakeIdempotencyKey(fact);

    // (2) The winner, decided by the index.
    const wakeId = await this.insertClaim(fact, idempotencyKey);
    if (!wakeId) return { outcome: 'ALREADY_AWAKE', idempotencyKey };

    // (3) Authorization, which by now cannot influence who won.
    let decision: WakeAuthorization;
    try {
      decision = await authorize(fact, { wakeId, idempotencyKey });
    } catch (error) {
      await this.release(wakeId, WAKE_AUTHORIZATION_FAILED);
      throw error;
    }
    if (decision.allowed) return { outcome: 'WOKEN', wakeId, idempotencyKey };

    await this.release(wakeId, decision.refusalCode);
    return { outcome: 'REFUSED', wakeId, idempotencyKey, refusalCode: decision.refusalCode };
  }

  /**
   * One INSERT. Returns the new row's id, or null when the fact is already held.
   *
   * `RETURNING "id"` on an `ON CONFLICT DO NOTHING` is what makes "did I win" a fact this statement
   * reports rather than a second query's guess: a loser gets no row back at all. The `WHERE` in the
   * conflict target names the partial index (migration 0174) — without it PostgreSQL cannot infer
   * which index the conflict is about and refuses the statement.
   */
  private async insertClaim(fact: WakeFact, idempotencyKey: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "project_coordinator_wake" (
        "id", "project_id", "event", "subject_type", "subject_id", "subject_version",
        "idempotency_key", "status", "detail"
      ) VALUES (
        ${randomUUID()}::uuid, ${fact.projectId}::uuid, ${fact.event}, ${fact.subjectType},
        ${fact.subjectId}, ${fact.subjectVersion}, ${idempotencyKey}, 'CLAIMED',
        ${JSON.stringify(fact.detail ?? {})}::jsonb
      )
      ON CONFLICT ("idempotency_key") WHERE "status" <> 'REFUSED' DO NOTHING
      RETURNING "id"
    `);
    return rows[0]?.id ?? null;
  }

  /**
   * Let go of the key, and say why.
   *
   * A compare-and-set on `CLAIMED` rather than a blind update: a claim can only be released once,
   * and re-refusing a row that is already refused would rewrite the code it was refused with — the
   * one fact this row is kept for.
   *
   * Public because unit T3 releases too, and for the same reason this method exists: a wake that
   * won its key and then could not open a session must give the key back, or one bad minute in a
   * workspace welds that fact shut forever. One owner of the rule rather than two spellings of it
   * — the CAS on `CLAIMED` is also what makes T3's release and a refusal here mutually exclusive.
   */
  async release(wakeId: string, refusalCode: string): Promise<void> {
    await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: { status: 'REFUSED', refusalCode },
    });
  }

  /**
   * Bind a won fact to its non-session consumer. CONSUMED remains in the partial unique index, so
   * replay cannot consume the same immutable input twice.
   */
  async consume(wakeId: string, consumerType: string): Promise<boolean> {
    const consumedAt = new Date();
    const result = await this.prisma.projectCoordinatorWake.updateMany({
      where: { id: wakeId, status: 'CLAIMED' },
      data: { status: 'CONSUMED', consumerType, consumedAt },
    });
    return result.count === 1;
  }
}
