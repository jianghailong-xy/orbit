/**
 * The Codex rate-limit reset relay as the control plane runs it: the command a heartbeat hands one
 * runner process, and the receipt a result from it gets (docs/codex-rate-limit-reset-contract.md §6.2,
 * §6.3, §6.5). The runner half is src/runner-go/codex_rate_limit_reset_relay.go.
 *
 * Nothing is decided here. The contract's pure functions decide — `decideCodexResetDispatch` for a
 * heartbeat, `applyCodexResetResult` for a result — against the operation row as it stands under its
 * row lock, and `CodexRateLimitResetRepository.transition` writes what they decided only after
 * `codexResetTransitionViolations` found nothing wrong with it (0255's guard trigger refuses the same
 * moves again). This file is the wiring between those and the two runner routes.
 *
 * DELIVERY, RECEIPT, OUTCOME
 * ==========================
 * Three different things, and none of them is stored as another:
 *   * A DELIVERY is one heartbeat response carrying a command. Only a delivery that changes who holds
 *     the claim writes — the first claim, or the takeover of a claim older than claimTakeoverAfterMs —
 *     and handing the holder its command again writes nothing. A response lost on the way is simply
 *     sent again on the next heartbeat, and an apiserver restart loses nothing: the claim is on the
 *     row, not in this process.
 *   * A RECEIPT is the 200 answer to one result: APPLIED when it moved the row, DUPLICATE when it only
 *     restated a fact the row already records, from whichever claim. A runner that lost the answer
 *     sends the same bytes again and is told the same thing. Every other answer is a refusal, and the
 *     claim that sent the result stops.
 *   * The OUTCOME is the operation's settled checkpoints. After it nothing lands on the row at all; a
 *     late result is a DUPLICATE when it restates the outcome and OPERATION_SETTLED when it does not.
 *
 * The provider idempotency key leaves the row only inside a CONSUME command, copied there by
 * `codexResetCommand`. Nothing here generates, replaces or logs one.
 */
import { Logger } from '@nestjs/common';
import {
  applyCodexResetResult,
  codexRateLimitResetOf,
  codexResetResultViolations,
  decideCodexResetDispatch,
  type CodexRateLimitResetCommand,
  type CodexRateLimitResetResultRefusal,
  type CodexRateLimitResetResultRejection,
  type CodexRateLimitResetResultRequest,
  type CodexRateLimitResetResultResponse,
  type CodexResetDispatch,
  type CodexResetHeartbeat,
  type CodexResetResultApplication,
  type PlanUsage,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { CodexRateLimitResetRepository } from '../runners/codex-rate-limit-reset.repository';
import { storeRefreshedCodexResetBlock } from './codex-reset-plan-usage';

const logger = new Logger('CodexRateLimitResetRelay');

/** The HTTP status each refusal of a result is answered with (§6.3). */
export const CODEX_RESET_RESULT_REFUSAL_STATUS: Readonly<Record<CodexRateLimitResetResultRejection, 400 | 404 | 409>> = {
  INVALID_RESULT: 400,
  OPERATION_NOT_FOUND: 404,
  STALE_CLAIM: 409,
  OPERATION_SETTLED: 409,
  PHASE_MISMATCH: 409,
  OUTCOME_CONFLICT: 409,
  ACCOUNT_MISMATCH: 409,
};

/** What POST /runner/codex-rate-limit-reset-result answers: a receipt, or a refusal. */
export type CodexResetResultAnswer =
  | { status: 200; body: CodexRateLimitResetResultResponse }
  | { status: 400 | 404 | 409; body: CodexRateLimitResetResultRefusal };

/**
 * One heartbeat's pass over its runner's active operations, oldest first. Each is expired, settled for
 * an account change, claimed, taken over or left alone, as `decideCodexResetDispatch` says for the
 * process THIS heartbeat speaks for and the block stored after its planUsage compare-and-set. Resolves
 * the command a claim holds for that process, or undefined. At most one can: a command needs the stored
 * block's account, and 0255's in-flight index allows one active operation per runner and account.
 */
export async function dispatchCodexResetCommand(
  prisma: PrismaService,
  heartbeat: Omit<CodexResetHeartbeat, 'rateLimitReset' | 'now'>,
): Promise<CodexRateLimitResetCommand | undefined> {
  const operations = new CodexRateLimitResetRepository(prisma);
  const active = await operations.activeIdsOfRunner(heartbeat.runnerId);
  if (active.length === 0) return undefined;
  const runner = await prisma.runner.findUnique({ where: { id: heartbeat.runnerId }, select: { planUsage: true } });
  const rateLimitReset = codexRateLimitResetOf(runner?.planUsage as PlanUsage | null | undefined);
  let command: CodexRateLimitResetCommand | undefined;
  for (const id of active) {
    const seen: { decision?: CodexResetDispatch; wrote?: boolean } = {};
    await operations.transition(id, (current) => {
      const decision = decideCodexResetDispatch(current, { ...heartbeat, rateLimitReset, now: new Date() });
      seen.decision = decision;
      seen.wrote = decision.kind !== 'NONE' && decision.operation !== current;
      return decision.kind === 'NONE' ? null : decision.operation;
    });
    const { decision } = seen;
    if (decision?.kind === 'DELIVER') command = decision.command;
    if (seen.wrote && decision?.kind === 'SETTLE') {
      logger.log(`codex reset ${id}: settled ${decision.operation.failureCode} at a heartbeat of runner ${heartbeat.runnerId}`);
    }
    if (seen.wrote && decision?.kind === 'DELIVER') {
      logger.log(`codex reset ${id}: ${decision.command.phase} claim ${decision.command.claimGeneration} for process ${decision.command.leaseOwner}`);
    }
  }
  return command;
}

/**
 * One result from runner `runnerId`, applied to its operation under the row lock. The block of a
 * REFRESHED result then goes to Runner.planUsage through the snapshot compare-and-set — on a DUPLICATE
 * too, so the resend of a result whose store failed still gets it there, and never over a newer block.
 */
export async function receiveCodexResetResult(
  prisma: PrismaService,
  runnerId: string,
  body: unknown,
): Promise<CodexResetResultAnswer> {
  if (codexResetResultViolations(body).length > 0) return refused('INVALID_RESULT', runnerId);
  const result = body as CodexRateLimitResetResultRequest;
  const seen: { application?: CodexResetResultApplication } = {};
  const operation = await new CodexRateLimitResetRepository(prisma).transition(result.operationId, (current) => {
    const application = applyCodexResetResult(current, runnerId, result, new Date());
    seen.application = application;
    return application.kind === 'APPLIED' ? application.operation : null;
  });
  const { application } = seen;
  if (!operation || !application) return refused('OPERATION_NOT_FOUND', runnerId, result);
  if (application.kind === 'REJECTED') return refused(application.rejection, runnerId, result);
  logger.log(
    `codex reset ${result.operationId}: ${result.kind} of claim ${result.claimGeneration} ${application.kind}, ` +
      `now ${application.response.status}, next ${application.response.next}`,
  );
  if (result.kind === 'REFRESHED' && result.rateLimitReset) {
    await storeRefreshedCodexResetBlock(prisma, runnerId, result.rateLimitReset, result.leaseOwner);
  }
  return { status: 200, body: application.response };
}

function refused(
  code: CodexRateLimitResetResultRejection,
  runnerId: string,
  result?: CodexRateLimitResetResultRequest,
): CodexResetResultAnswer {
  const about = result ? `${result.operationId}: ${result.kind} of claim ${result.claimGeneration}` : 'a malformed result';
  logger.warn(`codex reset ${about} from runner ${runnerId} refused: ${code}`);
  return { status: CODEX_RESET_RESULT_REFUSAL_STATUS[code], body: { code } };
}
