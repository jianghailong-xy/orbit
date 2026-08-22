import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { statusAfterTurnEnqueued } from '../common/session-scheduling';
import {
  ProjectAuthorizationService,
  ProjectAutomationPolicyValue,
} from './project-authorization.service';
import {
  ProjectActionApplyResult,
  ProjectActionEffectRefusal,
  ProjectReconcileLease,
  ProjectReconcileService,
  ProjectTurnExecutor,
} from './project-reconcile.service';
import { isLiveSessionStatus } from './project-coordinator-session';
import {
  PlannedCoordinatorTurn,
  coordinatorTurnGeneration,
  openCoordinatorTurnClientTurnId,
  openCoordinatorTurnIdempotencyKey,
} from './project-turn-reason';
import { buildCoordinatorTurnMessage } from './coordinator-opening';

export interface OpenCoordinatorTurnCommand {
  decisionId: string;
  /** §7.6's `OPEN` plan, ids in Base62 exactly as `planCoordinatorTurn` produced them. */
  planned: PlannedCoordinatorTurn;
}

export interface OpenCoordinatorTurnResult {
  action: ProjectActionApplyResult;
  /**
   * The durable turn this key names, read back from the ledger — this attempt's on `APPLIED`, and
   * the one an earlier attempt already committed on `ALREADY_APPLIED`. Null for a refusal, which
   * writes an audit row and no message. `rotate()` answers about its session the same way, and for
   * the same reason: a recovery probe asking "did this happen" wants what happened, not what THIS
   * call did.
   */
  turnId: string | null;
}

interface TurnRow {
  ownerId: string;
  coordinatorSessionId: string | null;
  coordinatorGeneration: bigint;
  seatAgentId: string | null;
  sourceDecisionInputHash: string;
  /** §9.2's policy, read in the SAME transaction that writes the turn (v1.18, `PC-CX-65`). */
  automationPolicy: ProjectAutomationPolicyValue;
}

interface CoordinatorRunRow {
  id: string;
  status: string;
  deletedAt: Date | null;
  cancelRequestedAt: Date | null;
  numTurns: number;
  prompt: string;
}

/**
 * §7.6 — the one path that turns a decided `OPEN_COORDINATOR_TURN` into something the coordinator
 * actually receives.
 *
 * Until this existed, §7.2's whole total order ended in a plan nobody claimed: `planCoordinatorTurn`
 * chose a reason, computed a digest and proposed an action, and the pass committed a decision that
 * said "wake the coordinator" while the coordinator was never woken. The ledger's `planned` gate is
 * one-directional on purpose (a claim must be in the plan; a plan nobody claims is not an error), so
 * the gap was silent — which is the same shape as the defect `PC-CX-63` closed one layer up.
 *
 * Four things commit together or not at all, and that is the whole design (AC1):
 *
 *   1. the `project_action` row under §8.2's permanent key, carrying `reason_code` — which is not
 *      decoration: §7.6 TR2-a's rate-limit window is anchored on the LATEST applied turn row of
 *      that `reasonCode`, so a row written without it leaves the window permanently unanchored and
 *      TR2 silently never rate-limits anything;
 *   2. the `conversation_turn` — an ordinary `message`, never a `steer` (see
 *      `buildCoordinatorTurnMessage` for why that distinction is load-bearing rather than stylistic);
 *   3. the Session's runnable status, because a turn queued onto a run that stays `AWAITING_INPUT`
 *      is a message no runner will ever claim a slot for;
 *   4. the events that caused it, consumed by the delivery transaction this runs inside (§5.4).
 *
 * Nothing here notifies anybody. §8.3 forbids it inside the transaction, and `announce` is the
 * post-commit half — a pure accelerator, because both wake paths it touches are long polls over a
 * durable read (`QueueService.claimSessionForRunner` and the runner inbox), so a notification that
 * never arrives costs at most five seconds (AC4).
 */
@Injectable()
export class ProjectCoordinatorTurnService
implements ProjectTurnExecutor, OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
    private readonly authorization: ProjectAuthorizationService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.reconciler.registerTurnExecutor(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /** §8.2's key, as the ledger stores it: internal project id, never the Base62 the plan carries. */
  idempotencyKey(projectId: string, generation: string, reasonDigest: string): string {
    return openCoordinatorTurnIdempotencyKey(projectId, generation, reasonDigest);
  }

  /** The audit face of a planned turn: Base62 throughout, no wall clock. */
  actionDetail(planned: PlannedCoordinatorTurn): Prisma.InputJsonValue {
    return {
      v: 1,
      reasonCode: planned.reasonCode,
      reasonDigest: planned.reasonDigest,
      turnFacts: planned.turnFacts,
      suppressedTurnReasons: planned.suppressed,
    } as unknown as Prisma.InputJsonValue;
  }

  /**
   * Post-commit only. Both branches are accelerators over a poll that would find the turn anyway:
   * a run parked at `PENDING` is found by `claimSessionForRunner`'s five-second retry, and a run
   * already `RUNNING` is found by the inbox long poll's own five-second re-read.
   */
  announce(sessionId: string, status: string): void {
    if (status === RunStatus.PENDING) this.queue.notifySessionQueued();
    else this.realtime.notifyInbox(sessionId);
    // No transcript event exists until the runner leases this turn, so every focused client is
    // told to re-read the durable queue — the same thing `SessionsService.createTurn` does.
    this.realtime.publishQueuedTurnsChanged(sessionId);
  }

  /**
   * The out-of-loop entry: one turn in a transaction of its own, for a holder that has a lease and
   * a decision but is not inside a reconcile pass. The loop does NOT come through here — it calls
   * `openInTransaction` inside its own commit — so this is for recovery and for the control
   * surface, and it shares every guard with the production path by sharing the effect.
   */
  async open(
    lease: ProjectReconcileLease,
    command: OpenCoordinatorTurnCommand,
    now = new Date(),
  ): Promise<OpenCoordinatorTurnResult> {
    const action = await this.reconciler.applyDecisionAction(
      lease,
      command.decisionId,
      {
        type: 'OPEN_COORDINATOR_TURN',
        idempotencyKey: this.idempotencyKey(
          lease.projectId,
          coordinatorTurnGeneration(command.planned.idempotencyKey) ?? '',
          command.planned.reasonDigest,
        ),
        // The PROJECT is the subject: a turn is a statement about this project's coordination, and
        // the conversation it lands in is where it was delivered, not what it is about.
        subject: { type: 'PROJECT', id: lease.projectId },
        detail: this.actionDetail(command.planned),
      },
      async (tx, actionId) => this.openInTransaction(tx, lease, command, actionId, now),
      now,
    );
    const delivered = await this.deliveredTurn(action.actionId);
    if (action.status === 'APPLIED' && delivered) {
      this.announce(delivered.sessionId, delivered.status);
    }
    return { action, turnId: delivered?.turnId ?? null };
  }

  /**
   * What the ledger committed, read back from the ledger rather than from anything in memory.
   *
   * `flushPendingTurns` asks the same question for the same reason a rotation's flush does: the
   * only thing that makes a turn real is its APPLIED row, and a transaction can still fail between
   * the effect and the COMMIT.
   */
  async deliveredTurn(
    actionId: string,
  ): Promise<{ sessionId: string; status: string; turnId: string } | null> {
    const rows = await this.prisma.$queryRaw<Array<{
      sessionId: string | null; status: string | null; turnId: string | null;
    }>>(Prisma.sql`
      SELECT "detail"->>'coordinatorSessionId' AS "sessionId",
             "detail"->>'sessionStatusAfter' AS "status",
             "detail"->>'conversationTurnId' AS "turnId"
        FROM "project_action"
       WHERE "id" = ${actionId}::uuid AND "status" = 'APPLIED'
         AND "type" = 'OPEN_COORDINATOR_TURN'
    `);
    const row = rows[0];
    if (!row?.sessionId || !row.status || !row.turnId) return null;
    return { sessionId: base62ToUuid(row.sessionId), status: row.status, turnId: row.turnId };
  }

  async openInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: OpenCoordinatorTurnCommand,
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal> {
    const planned = command.planned;
    // §8.6 LO1's order: `project` (already locked FOR NO KEY UPDATE by the ledger), then
    // `project_runtime`, then the coordination run. Nothing below re-reads the plan for a fact the
    // database can state (§6.3).
    const rows = await tx.$queryRaw<TurnRow[]>(Prisma.sql`
      SELECT p."owner_id" AS "ownerId",
             p."coordinator_session_id" AS "coordinatorSessionId",
             p."automation_policy"::text AS "automationPolicy",
             r."coordinator_generation" AS "coordinatorGeneration",
             seat."agent_id" AS "seatAgentId",
             d."decision_input_hash" AS "sourceDecisionInputHash"
        FROM "project_decision" d
        JOIN "project" p ON p."id" = d."project_id"
        JOIN "project_runtime" r ON r."project_id" = p."id"
        LEFT JOIN "project_member" seat
               ON seat."project_id" = p."id" AND seat."role" = 'COORDINATOR'
       WHERE d."id" = ${command.decisionId}::uuid
         AND d."project_id" = ${lease.projectId}::uuid
    `);
    const row = rows[0];
    if (!row) return refusal('PROJECT_NOT_OPEN');

    // §8.2 GE4: the epoch inside this key is the generation the SNAPSHOT read. A generation that
    // has moved means the run this turn was addressed to has already been replaced, and delivering
    // it into the successor would file one conversation's wake under another's name.
    const generation = coordinatorTurnGeneration(planned.idempotencyKey);
    if (generation === null || BigInt(generation) !== row.coordinatorGeneration) {
      return refusal('COORDINATOR_GENERATION_MOVED', {
        expectedGeneration: generation,
        actualGeneration: String(row.coordinatorGeneration),
      });
    }
    if (!row.coordinatorSessionId) return refusal('COORDINATOR_SESSION_MISSING');

    // FOR UPDATE, and this is the linearization point the whole unit turns on: `createTurn` and
    // the runner's `dequeueTurn` take this same row lock, so a turn cannot be allocated a seq
    // against a snapshot in which the run had not yet ended, and a run cannot end between the
    // liveness check below and the insert.
    const runs = await tx.$queryRaw<CoordinatorRunRow[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status", "deleted_at" AS "deletedAt",
             "cancel_requested_at" AS "cancelRequestedAt",
             "num_turns" AS "numTurns", "prompt"
        FROM "session" WHERE "id" = ${row.coordinatorSessionId}::uuid FOR UPDATE
    `);
    const run = runs[0];
    if (!run || run.deletedAt) {
      return refusal('COORDINATOR_SESSION_MISSING', {
        coordinatorSessionId: uuidToBase62(row.coordinatorSessionId),
        deleted: Boolean(run?.deletedAt),
      });
    }
    // TU7 re-asked of the committed row. A run that ended, or that somebody has asked to stop,
    // has nowhere to put a turn — §7.5's rotation goes first, and it is decided by the next pass
    // from the same facts, so nothing is lost by refusing here.
    if (!isLiveSessionStatus(run.status) || run.cancelRequestedAt) {
      return refusal('COORDINATOR_SESSION_NOT_LIVE', {
        coordinatorSessionId: uuidToBase62(run.id),
        runStatus: run.status,
        cancelRequested: Boolean(run.cancelRequestedAt),
      });
    }
    if (!row.seatAgentId) return refusal('COORDINATOR_NOT_ASSIGNED');

    // §9.2's matrix, through the same adapter every other gated action uses. A turn is
    // `COORDINATOR_ROUTINE`: allowed under GUARDED_AUTO and AUTO, an approval request under MANUAL
    // (§7.2 TU6 — the policy boundary is this existing row, not a new one).
    const audit = await this.authorization.authorizeInTransaction(tx, {
      ownerId: row.ownerId,
      projectId: lease.projectId,
      coordinatorAgentId: row.seatAgentId,
      idempotencyKey: this.idempotencyKey(lease.projectId, generation, planned.reasonDigest),
      action: 'OPEN_COORDINATOR_TURN',
      sourceDecisionInputHash: row.sourceDecisionInputHash,
      currentActionId: actionId,
    }, now);
    if (!audit) return refusal('PROJECT_NOT_OPEN');
    if (audit.result.decision !== 'ALLOW') {
      return refusal(audit.result.reasonCode, { authorization: audit });
    }

    // A coordination run that has never been claimed has no opening turn yet: `buildSession` lays
    // the prompt down at seq 1 when the runner claims it, and it decides whether to by looking for
    // this one fixed `client_turn_id`. Appending a turn ahead of it would make that claim collide
    // on `(session_id, seq)` and strand the run — so the prompt goes down first, under this same
    // lock, exactly as `SessionsService.ensurePromptSeeded` does before a follow-up.
    if (run.numTurns === 0) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "conversation_turn" (
          "id", "session_id", "seq", "client_turn_id", "kind", "content", "status", "created_at"
        )
        SELECT ${randomUUID()}::uuid, ${run.id}::uuid, COALESCE(MAX("seq"), 0) + 1,
               ${`initial-${run.id}`}, 'message', ${run.prompt}, 'PENDING', ${now}
          FROM "conversation_turn" WHERE "session_id" = ${run.id}::uuid
        ON CONFLICT ("session_id", "client_turn_id") DO NOTHING
      `);
    }

    const clientTurnId = openCoordinatorTurnClientTurnId(
      this.idempotencyKey(lease.projectId, generation, planned.reasonDigest),
    );
    const content = buildCoordinatorTurnMessage({
      reasonCode: planned.reasonCode,
      reasonDigest: planned.reasonDigest,
      turnFacts: planned.turnFacts,
      suppressed: planned.suppressed,
      // The row this transaction locked, not the one the snapshot froze: a message that told the
      // coordinator about a policy the project has since left would be wrong in the one paragraph
      // that says what it may do without asking.
      automationPolicy: row.automationPolicy,
      decisionId: uuidToBase62(command.decisionId),
      actionId: uuidToBase62(actionId),
    });
    // The second idempotency layer, and independent of the first: the ledger's key stops a second
    // CLAIM, and this one stops a second MESSAGE. A returning process, a retried transaction and a
    // takeover all converge on one row here even if the ledger were somehow re-entered.
    const inserted = await tx.$queryRaw<Array<{ id: string; seq: number }>>(Prisma.sql`
      INSERT INTO "conversation_turn" (
        "id", "session_id", "seq", "client_turn_id", "kind", "content", "status", "created_at"
      )
      SELECT ${randomUUID()}::uuid, ${run.id}::uuid,
             COALESCE(MAX("seq"), 0) + 1, ${clientTurnId},
             'message', ${content}, 'PENDING', ${now}
        FROM "conversation_turn" WHERE "session_id" = ${run.id}::uuid
      ON CONFLICT ("session_id", "client_turn_id") DO NOTHING
      RETURNING "id", "seq"
    `);
    const turn = inserted[0] ?? (await tx.$queryRaw<Array<{ id: string; seq: number }>>(Prisma.sql`
      SELECT "id", "seq" FROM "conversation_turn"
       WHERE "session_id" = ${run.id}::uuid AND "client_turn_id" = ${clientTurnId}
    `))[0];
    if (!turn) throw new Error(`failed to open Project coordinator turn ${clientTurnId}`);

    // Queueing work onto an idle run needs a fresh runner slot; a run that already holds one keeps
    // it, and the inbox delivers this message after the turn in flight finishes. One rule, shared
    // with every other producer of a turn (`statusAfterTurnEnqueued`).
    const statusAfter = statusAfterTurnEnqueued(run.status as RunStatus);
    const woken = await tx.$executeRaw(Prisma.sql`
      UPDATE "session"
         SET "status" = ${statusAfter}::"run_status", "last_turn_at" = ${now},
             "retry_at" = NULL, "updated_at" = ${now}
       WHERE "id" = ${run.id}::uuid AND "status" = ${run.status}::"run_status"
    `);
    // Compare-and-set on the value read under this transaction's row lock, so it cannot lose a
    // race: a zero means the lock did not hold, which is a broken invariant rather than a refusal,
    // and §8.5 C3's only legal answer to that is to roll the whole thing back.
    if (woken !== 1) {
      throw new Error(`Project coordination run ${run.id} moved under its row lock`);
    }

    // `result_session_id` is deliberately NOT used: it is unique, and this run is already the
    // result of the `ROTATE_COORDINATOR_SESSION` that opened it. The link lives in `detail`, which
    // is also where `flushPendingTurns` reads it back from.
    const delivery = {
      authorization: audit,
      coordinatorSessionId: uuidToBase62(run.id),
      conversationTurnId: turn.id,
      conversationTurnSeq: turn.seq,
      clientTurnId,
      sessionStatusBefore: run.status,
      sessionStatusAfter: statusAfter,
    };
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action"
         SET "reason_code" = ${planned.reasonCode},
             "detail" = "detail" || ${JSON.stringify(delivery)}::jsonb,
             "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
    `);
  }
}

function refusal(reasonCode: string, detail?: Record<string, unknown>): ProjectActionEffectRefusal {
  // Retryable means "this world may legally produce this turn again", not "try again now". A
  // generation that moved, a run that ended and a run that is live again all get re-decided from
  // facts on the next pass; a project that is not open, or a seat nobody fills, will not.
  const retryable = reasonCode === 'COORDINATOR_GENERATION_MOVED'
    || reasonCode === 'COORDINATOR_SESSION_MISSING'
    || reasonCode === 'COORDINATOR_SESSION_NOT_LIVE';
  return {
    status: 'REFUSED',
    refusalCode: reasonCode,
    reasonCode,
    detail: JSON.parse(JSON.stringify({
      ...(detail ?? {}),
      turnFailure: { v: 1, refusalCode: reasonCode, reasonCode, retryable },
    })) as Prisma.InputJsonValue,
  };
}
