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
 *   * A DELIVERY is one heartbeat response carrying a command. A delivery to the process holding the claim
 *     renews the claim (claimedAt), so a live holder is never taken over; the first claim and the takeover of a
 *     claim left unrenewed for claimTakeoverAfterMs write the claim itself. A response lost on the way is simply
 *     sent again on the next heartbeat, and an apiserver restart loses nothing: the claim is on the row, not in
 *     this process.
 *   * A RECEIPT is the 200 answer to one result: APPLIED when it moved the row, DUPLICATE when it only
 *     restated a fact the row already records, from whichever claim. A runner that lost the answer
 *     sends the same bytes again and is told the same thing. Every other answer is a refusal, and the
 *     claim that sent the result stops.
 *   * The OUTCOME is the operation's settled checkpoints. After it nothing lands on the row at all; a
 *     late result is a DUPLICATE when it restates the outcome and OPERATION_SETTLED when it does not.
 *
 * TELEMETRY
 * =========
 * Each decision is counted (runners/codex-reset-metrics.ts) and each one that matters to an operation's history is
 * a `codex-reset` line keyed by its operationId (runners/codex-reset-log.ts): claims, takeovers and settlements at
 * the delivery stage; every result at the consume or refresh stage and its answer at the receipt stage. A renewal
 * is counted but not logged, since the holder's every heartbeat makes one. A refused result that reports a spent
 * credit the operation does not record, or contradicts its outcome, is also an anomaly: counted and logged at warn,
 * for the runbook's manual reconciliation.
 *
 * The provider idempotency key leaves the row only inside a CONSUME command, copied there by
 * `codexResetCommand`. Nothing here generates, replaces or logs one: every line is told to redact it.
 */
import { Logger } from '@nestjs/common';
import {
  CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS,
  applyCodexResetResult,
  codexRateLimitResetOf,
  codexResetOperationPhase,
  codexResetOperationStatus,
  codexResetResultViolations,
  decideCodexResetDispatch,
  isCodexResetUuid,
  type CodexRateLimitResetCommand,
  type CodexRateLimitResetOperationState,
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
import { codexResetLogLine, type CodexResetLogFields } from '../runners/codex-reset-log';
import {
  countCodexResetAnomaly,
  countCodexResetDispatch,
  countCodexResetResult,
  countCodexResetSettlement,
  type CodexResetAnomaly,
} from '../runners/codex-reset-metrics';
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

type DispatchHeartbeat = Omit<CodexResetHeartbeat, 'rateLimitReset' | 'now'>;

/**
 * One heartbeat's pass over its runner's active operations, oldest first. Each is expired, settled for
 * an account change, claimed, renewed, taken over or left alone, as `decideCodexResetDispatch` says for the
 * process THIS heartbeat speaks for and the block stored after its planUsage compare-and-set. Resolves
 * the command a claim holds for that process, or undefined. At most one can: a command needs the stored
 * block's account, and 0255's in-flight index allows one active operation per runner and account.
 */
export async function dispatchCodexResetCommand(
  prisma: PrismaService,
  heartbeat: DispatchHeartbeat,
): Promise<CodexRateLimitResetCommand | undefined> {
  const operations = new CodexRateLimitResetRepository(prisma);
  const active = await operations.activeIdsOfRunner(heartbeat.runnerId);
  if (active.length === 0) return undefined;
  const runner = await prisma.runner.findUnique({ where: { id: heartbeat.runnerId }, select: { planUsage: true } });
  const rateLimitReset = codexRateLimitResetOf(runner?.planUsage as PlanUsage | null | undefined);
  let command: CodexRateLimitResetCommand | undefined;
  for (const id of active) {
    const seen: { before?: CodexRateLimitResetOperationState; decision?: CodexResetDispatch } = {};
    await operations.transition(id, (current) => {
      const decision = decideCodexResetDispatch(current, { ...heartbeat, rateLimitReset, now: new Date() });
      seen.before = current;
      seen.decision = decision;
      return decision.kind === 'NONE' ? null : decision.operation;
    });
    const { before, decision } = seen;
    if (!before || !decision) continue;
    if (decision.kind === 'DELIVER') command = decision.command;
    observeDispatch(heartbeat, before, decision);
  }
  return command;
}

/** Counts what one heartbeat did to one operation, and logs a claim, a takeover or a settlement. */
function observeDispatch(heartbeat: DispatchHeartbeat, before: CodexRateLimitResetOperationState, decision: CodexResetDispatch): void {
  const phase = codexResetOperationPhase(before);
  if (decision.kind === 'NONE') {
    countCodexResetDispatch('none', phase, decision.reason);
    return;
  }
  const after = decision.operation;
  const fields: CodexResetLogFields = {
    event: '',
    operationId: after.id,
    runnerId: heartbeat.runnerId,
    phase,
    from: codexResetOperationStatus(before),
    status: codexResetOperationStatus(after),
  };
  if (decision.kind === 'SETTLE') {
    countCodexResetDispatch('settled', phase, after.failureCode);
    countCodexResetSettlement(fields.status ?? null, after.failureCode);
    logger.log(
      codexResetLogLine('delivery', { ...fields, event: 'settled', process: heartbeat.leaseOwner, code: after.failureCode }, [
        after.providerIdempotencyKey,
      ]),
    );
    return;
  }
  const taken = before.claimLeaseOwner === null ? 'claimed' : before.claimLeaseOwner === after.claimLeaseOwner ? 'renewed' : 'taken_over';
  countCodexResetDispatch(taken, phase);
  if (taken === 'renewed') return;
  logger.log(
    codexResetLogLine(
      'delivery',
      { ...fields, event: taken, process: after.claimLeaseOwner, claimGeneration: after.claimGeneration },
      [after.providerIdempotencyKey],
    ),
  );
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
  if (codexResetResultViolations(body).length > 0) return refused('INVALID_RESULT', runnerId, body);
  const result = body as CodexRateLimitResetResultRequest;
  const seen: { before?: CodexRateLimitResetOperationState; application?: CodexResetResultApplication } = {};
  const operation = await new CodexRateLimitResetRepository(prisma).transition(result.operationId, (current) => {
    const application = applyCodexResetResult(current, runnerId, result, new Date());
    seen.before = current;
    seen.application = application;
    return application.kind === 'APPLIED' ? application.operation : null;
  });
  const { before, application } = seen;
  if (!operation || !before || !application) return refused('OPERATION_NOT_FOUND', runnerId, result);
  if (application.kind === 'REJECTED') return refused(application.rejection, runnerId, result, before);

  const { response } = application;
  const secrets = [before.providerIdempotencyKey];
  const fields = resultFields(runnerId, result);
  countCodexResetResult(result.kind, application.kind, result.outcome ?? result.code ?? null);
  if (application.kind === 'APPLIED' && before.completedAt === null && application.operation.completedAt !== null) {
    countCodexResetSettlement(response.status, application.operation.failureCode);
  }
  logger.log(
    codexResetLogLine(
      stageOf(result),
      {
        ...fields,
        event: application.kind === 'APPLIED' ? 'applied' : 'restated',
        outcome: result.outcome,
        code: result.code,
        from: codexResetOperationStatus(before),
        status: response.status,
      },
      secrets,
    ),
  );
  logger.log(
    codexResetLogLine('receipt', { ...fields, event: 'answered', disposition: application.kind, status: response.status, next: response.next }, secrets),
  );
  if (result.kind === 'REFRESHED' && result.rateLimitReset) {
    const stored = await storeRefreshedCodexResetBlock(prisma, runnerId, result.rateLimitReset, result.leaseOwner);
    logger.log(codexResetLogLine('refresh', { ...fields, event: stored ? 'snapshot_stored' : 'snapshot_kept' }, secrets));
  }
  return { status: 200, body: response };
}

function stageOf(result: Pick<CodexRateLimitResetResultRequest, 'phase'>): 'consume' | 'refresh' {
  return result.phase === 'REFRESH' ? 'refresh' : 'consume';
}

function resultFields(runnerId: string, result: CodexRateLimitResetResultRequest): CodexResetLogFields {
  return {
    event: '',
    operationId: result.operationId,
    runnerId,
    process: result.leaseOwner,
    phase: result.phase,
    claimGeneration: result.claimGeneration,
    kind: result.kind,
  };
}

/**
 * The refusal of a result, counted and logged. `before` is the operation the result named, when there was one; a
 * result naming another runner's operation is logged as not found and says nothing of that operation.
 */
function refused(
  code: CodexRateLimitResetResultRejection,
  runnerId: string,
  body: unknown,
  before?: CodexRateLimitResetOperationState,
): CodexResetResultAnswer {
  const secrets = [before?.providerIdempotencyKey];
  if (code === 'INVALID_RESULT') {
    const named = (body as { operationId?: unknown } | null)?.operationId;
    countCodexResetResult(null, 'REFUSED', code);
    logger.warn(
      codexResetLogLine('receipt', { event: 'refused', operationId: isCodexResetUuid(named) ? named : null, runnerId, code }, secrets),
    );
    return { status: CODEX_RESET_RESULT_REFUSAL_STATUS[code], body: { code } };
  }
  const result = body as CodexRateLimitResetResultRequest;
  const fields = resultFields(runnerId, result);
  const own = before !== undefined && before.runnerId === runnerId ? before : undefined;
  countCodexResetResult(result.kind, 'REFUSED', code);
  logger.warn(
    codexResetLogLine(
      stageOf(result),
      { ...fields, event: 'refused', outcome: result.outcome, code: result.code, from: own && codexResetOperationStatus(own) },
      secrets,
    ),
  );
  logger.warn(codexResetLogLine('receipt', { ...fields, event: 'refused', code }, secrets));
  const anomaly = own ? anomalyOf(code, result) : null;
  if (anomaly) {
    countCodexResetAnomaly(anomaly);
    logger.warn(
      codexResetLogLine(
        stageOf(result),
        { ...fields, event: 'anomaly', reason: anomaly, outcome: result.outcome, code, from: own && codexResetOperationStatus(own) },
        secrets,
      ),
    );
  }
  return { status: CODEX_RESET_RESULT_REFUSAL_STATUS[code], body: { code } };
}

/**
 * What a refused result says that its operation does not show. A consumed outcome refused as OPERATION_SETTLED
 * names a credit spent behind an operation that settled without it (UNRESOLVED or NOT_ATTEMPTED: one reporting
 * the same key's spend would have been a DUPLICATE); from a stale claim it is benign once the current claim
 * records the same key's alreadyRedeemed. OUTCOME_CONFLICT contradicts the recorded outcome either way.
 */
function anomalyOf(rejection: CodexRateLimitResetResultRejection, result: CodexRateLimitResetResultRequest): CodexResetAnomaly | null {
  if (rejection === 'OUTCOME_CONFLICT') return 'outcome_conflict';
  const consumed = result.kind === 'CONSUME_OUTCOME' && result.outcome !== undefined && CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[result.outcome].consumed;
  if (!consumed) return null;
  if (rejection === 'OPERATION_SETTLED') return 'consumed_outcome_after_settlement';
  if (rejection === 'STALE_CLAIM') return 'consumed_outcome_from_stale_claim';
  return null;
}
