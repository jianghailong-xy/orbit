import { ConflictException } from '@nestjs/common';
import { STEER_WITHDRAW_ERRORS, type SteerWithdrawOutcome } from '@orbit/shared';
import { TransactionSurface } from '../common/prisma-transaction-surface';

/**
 * Taking back a steer the engine has not read yet.
 *
 * A message sent while a turn runs is written into that turn (a steer). Claude reads it into the
 * conversation only at its next tool boundary, and until then it waits in the CLI's own queue, from
 * which the CLI can drop it and say whether it did (runner-go/claude_withdraw.go). So a withdrawal of
 * a steer the runner already holds is a question for the engine, asked through the runner:
 * DELETE /sessions/:id/turns/:turnId files a `withdraw` turn naming the steer, the inbox hands it
 * over mid-turn like an interrupt, and the runner completes it with what the engine answered. That
 * completion is the only thing that removes the steer, and the outcome is written onto the withdraw
 * turn for the request that filed it, which is waiting on it.
 */

/** How long a withdraw turn stays deliverable. One the runner has not taken by then is past the
 *  point the request that filed it waits to, and a withdrawal performed after the person was told
 *  it did not happen would take their words out of the conversation with nobody holding them. */
export const STEER_WITHDRAW_DELIVERY_WINDOW_MS = 8_000;

/** How long that request waits for the outcome: the delivery window, the runner's own bound on the
 *  engine's answer (claudeWithdrawTimeout, 5 s), and room for the completion to arrive. */
export const STEER_WITHDRAW_WAIT_MS = 15_000;

export const STEER_WITHDRAW_POLL_MS = 100;

/** A withdraw turn's `content`: the steer it is about, and — once the runner has completed it — what
 *  came of it. */
export interface SteerWithdrawRequest {
  turnId: string;
  outcome?: SteerWithdrawOutcome;
  reason?: string;
}

const OUTCOMES: ReadonlySet<string> = new Set<SteerWithdrawOutcome>([
  'withdrawn',
  'already_read',
  'not_waiting',
  'failed',
]);

export function steerWithdrawContent(turnId: string): string {
  return JSON.stringify({ turnId });
}

export function readSteerWithdrawRequest(content: string | null | undefined): SteerWithdrawRequest | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { turnId, outcome, reason } = parsed as Record<string, unknown>;
  if (typeof turnId !== 'string' || turnId === '') return null;
  return {
    turnId,
    ...(typeof outcome === 'string' && OUTCOMES.has(outcome) ? { outcome: outcome as SteerWithdrawOutcome } : {}),
    ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
  };
}

/** What the runner reported, read strictly: anything it did not name as an outcome is a failure,
 *  so a newer runner's word this control plane does not know can never remove a message. */
export function steerWithdrawOutcome(result: string | undefined): SteerWithdrawOutcome {
  return result && OUTCOMES.has(result) ? (result as SteerWithdrawOutcome) : 'failed';
}

export type SteerWithdrawalTransaction = TransactionSurface<{
  conversationTurn: ['deleteMany', 'updateMany'];
}>;

/**
 * Settle one `withdraw` turn's completion, inside turnComplete's Session transaction.
 *
 * `withdrawn` means the engine dropped the message unread, so the steer's row goes — the way a
 * cancelled queued message's does, its attachments with it — while it is still the in-flight,
 * unacknowledged steer the withdrawal was filed against. Every other outcome leaves the steer
 * exactly where it was. Either way the outcome is written back onto the withdraw turn, once: a
 * completion retried after its answer was lost finds it settled and changes nothing.
 */
export async function settleSteerWithdrawal(
  tx: SteerWithdrawalTransaction,
  sessionId: string,
  withdrawTurn: { id: string; content: string | null },
  report: { result?: string; error?: string },
): Promise<boolean> {
  const request = readSteerWithdrawRequest(withdrawTurn.content);
  if (!request || request.outcome) return false;
  const outcome = steerWithdrawOutcome(report.result);
  if (outcome === 'withdrawn') {
    await tx.conversationTurn.deleteMany({
      where: { id: request.turnId, sessionId, kind: 'steer', status: 'IN_FLIGHT', deliveryStatus: null },
    });
  }
  const reason = report.error?.trim();
  await tx.conversationTurn.updateMany({
    where: { id: withdrawTurn.id, sessionId, kind: 'withdraw' },
    data: {
      content: JSON.stringify({ turnId: request.turnId, outcome, ...(reason ? { reason } : {}) }),
    },
  });
  return true;
}

/**
 * What the person who asked hears. `withdrawn` is the one success; the rest refuse with a code the
 * clients branch on (STEER_WITHDRAW_ERRORS) and a sentence saying where the message is now.
 */
export function steerWithdrawAnswer(answer: SteerWithdrawRequest): { ok: true; withdrawn: true } {
  switch (answer.outcome) {
    case 'withdrawn':
      return { ok: true, withdrawn: true };
    case 'already_read':
      throw new ConflictException({
        code: STEER_WITHDRAW_ERRORS.ALREADY_READ,
        message: 'Claude has already read this message, so it can no longer be withdrawn.',
      });
    case 'not_waiting':
      throw new ConflictException({
        code: STEER_WITHDRAW_ERRORS.ALREADY_READ,
        message: 'This message is no longer waiting to be read, so it can no longer be withdrawn.',
      });
    default:
      throw new ConflictException({
        code: STEER_WITHDRAW_ERRORS.NOT_WITHDRAWABLE,
        message: answer.reason
          ? `Couldn't withdraw this message: ${answer.reason}.`
          : "Couldn't withdraw this message.",
      });
  }
}
