import { TransactionSurface } from '../common/prisma-transaction-surface';

/**
 * Exactly the members this function reaches, and therefore exactly what a double for it has to
 * supply. `conversationTurn.findMany` was, on one day, missing from a hand-written double and cost
 * a full acceptance round to find; naming it here is what makes the next omission a compile error
 * instead.
 */
export type CurrentWorkSteerTransaction = TransactionSurface<{
  conversationTurn: ['findMany', 'updateMany'];
}>;

export const CURRENT_WORK_TARGET_COMPLETED = 'CURRENT_WORK_TARGET_COMPLETED';
export const CURRENT_WORK_INTERRUPTED = 'CURRENT_WORK_INTERRUPTED';
export const CURRENT_WORK_SESSION_ENDED = 'CURRENT_WORK_SESSION_ENDED';
export const CURRENT_WORK_SESSION_FINALIZED = 'CURRENT_WORK_SESSION_FINALIZED';
export const CURRENT_WORK_SESSION_REAPED = 'CURRENT_WORK_SESSION_REAPED';
export const CURRENT_WORK_RUNTIME_REJECTED = 'CURRENT_WORK_RUNTIME_REJECTED';

interface TerminalizeOptions {
  targetTurnIds?: readonly string[];
  /** Exact runner-flushed target completion and runner-loss teardown may settle a leased row when
   * no strict acknowledged receipt exists. User interrupt/live-end passes false and settles only
   * PENDING rows because an acknowledgement may still be buffered in the resident process. */
  includeInFlight?: boolean;
  /** A vanished runner cannot prove whether a leased input crossed the engine-read boundary.
   * Exact target completion leaves this unset because the v1 runner flushes ACK before complete. */
  inFlightOutcome?: 'FAILED' | 'UNCONFIRMED';
  code: string;
  reason: string;
}

export interface CurrentWorkTerminalization {
  terminalizedTurnIds: string[];
  targetTurnIds: string[];
}

interface RuntimeDeliveryEvent {
  type: string;
  turnId?: string | null;
  payload?: unknown;
}

/** Exact runtime receipts accepted by the durable CURRENT_WORK protocol. Enqueued/written USER
 * events only paint progress; they are not proof that the engine consumed the authored input. */
export function acknowledgedRuntimeTurnIds(
  events: readonly RuntimeDeliveryEvent[],
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { delivery?: unknown; turnId?: unknown } | null;
    if (payload?.delivery !== 'acknowledged') continue;
    if (event.type === 'user' && typeof event.turnId === 'string') {
      ids.add(event.turnId);
    } else if (event.type === 'user_delivery' && typeof payload.turnId === 'string') {
      ids.add(payload.turnId);
    }
  }
  return [...ids];
}

/**
 * Settle explicit CURRENT_WORK steers that have no durable runtime acknowledgement.
 *
 * The receipt lives on `conversation_turn`; this function intentionally does not allocate a
 * `run_event.seq`. That namespace belongs to the resident runner, which may already have its next
 * seq buffered outside PostgreSQL. The runner flushes USER before turn-complete, and event ingest
 * stamps `deliveryAcknowledgedAt` while holding this same Session lock. Therefore an unacknowledged
 * row at an exact completion boundary is safe to fail even when dequeue had committed. At a
 * runner-loss boundary, a leased row instead becomes UNCONFIRMED: absence of an ACK is not proof
 * that the engine did not read it.
 */
export async function terminalizePendingCurrentWorkSteers(
  tx: CurrentWorkSteerTransaction,
  sessionId: string,
  options: TerminalizeOptions,
): Promise<CurrentWorkTerminalization> {
  const statuses = options.includeInFlight ? ['PENDING', 'IN_FLIGHT'] : ['PENDING'];
  const rows = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      kind: 'steer',
      status: { in: statuses },
      sendIntent: 'CURRENT_WORK',
      deliveryStatus: null,
      ...(options.targetTurnIds ? { targetTurnId: { in: [...options.targetTurnIds] } } : {}),
    },
    orderBy: { seq: 'asc' },
    select: { id: true, targetTurnId: true, status: true },
  });
  const candidates = rows.filter(
    (row): row is (typeof rows)[number] & { targetTurnId: string } => row.targetTurnId != null,
  );
  if (candidates.length > 0) {
    const now = new Date();
    const outcomes: Array<'FAILED' | 'UNCONFIRMED'> = ['FAILED', 'UNCONFIRMED'];
    for (const outcome of outcomes) {
      const ids = candidates
        .filter((row) =>
          row.status === 'IN_FLIGHT'
            ? (options.inFlightOutcome ?? 'FAILED') === outcome
            : outcome === 'FAILED',
        )
        .map((row) => row.id);
      if (ids.length === 0) continue;
      await tx.conversationTurn.updateMany({
        where: {
          sessionId,
          id: { in: ids },
          kind: 'steer',
          status: { in: statuses },
          sendIntent: 'CURRENT_WORK',
          deliveryStatus: null,
        },
        data: {
          status: 'ANSWERED',
          answeredAt: now,
          deliveryStatus: outcome,
          deliveryFailureCode: options.code,
          deliveryFailureReason: options.reason,
          deliveryTerminalAt: now,
        },
      });
    }
  }
  return {
    terminalizedTurnIds: candidates.map((row) => row.id),
    targetTurnIds: [...new Set(candidates.map((row) => row.targetTurnId))],
  };
}
