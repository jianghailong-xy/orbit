import {
  CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES,
  CODEX_RATE_LIMIT_RESET_ENUMS,
  type CodexRateLimitResetConsumeOutcome,
  type CodexRateLimitResetNextStep,
  type CodexRateLimitResetOperationStatus,
  type CodexRateLimitResetPhase,
  type CodexRateLimitResetResultKind,
  type CodexResetSnapshotOrder,
} from '@orbit/shared';

/**
 * Codex rate-limit reset telemetry, control-plane half (docs/codex-rate-limit-reset-runbook.md): one line per
 * thing that happens to an operation, `codex-reset {json}`, keyed by the operationId the runner's own lines
 * carry (src/runner-go/codex_rate_limit_reset_log.go), so the two halves read as one history.
 *
 * STAGES
 *   admission  a confirmation became an operation, was replayed, or was refused;
 *   delivery   a heartbeat claimed, took over or settled an operation;
 *   consume    a CONSUME-phase result was applied, restated or refused;
 *   refresh    a REFRESH-phase result was, and what became of the block it carried;
 *   receipt    the answer a result got.
 *
 * WHAT A LINE MAY SAY
 *   Every field is checked against what it may hold: ids by their UUID shape, the process by the first eight
 *   hex digits of its leaseOwner, states and codes by the contract's own vocabulary, events and reasons as
 *   short words, an error by its code or class name. A value that fails its check, or that contains a secret
 *   the caller names (the operation's provider key), is written "[redacted]", and a key that is not a field is
 *   dropped. No field holds a message, a request body, a fingerprint, an account id, a token or an environment
 *   value, so none of those can be passed.
 */

export type CodexResetLogStage = 'admission' | 'delivery' | 'consume' | 'refresh' | 'receipt';

export interface CodexResetLogFields {
  event: string;
  operationId?: string | null;
  runnerId?: string | null;
  /** A runner process's leaseOwner, written as its first eight hex digits. */
  process?: string | null;
  phase?: CodexRateLimitResetPhase | null;
  claimGeneration?: number | null;
  kind?: CodexRateLimitResetResultKind | null;
  outcome?: CodexRateLimitResetConsumeOutcome | null;
  /** A result, refusal, rejection or failure code of the contract. */
  code?: string | null;
  disposition?: 'APPLIED' | 'DUPLICATE' | 'REFUSED' | null;
  from?: CodexRateLimitResetOperationStatus | null;
  status?: CodexRateLimitResetOperationStatus | null;
  next?: CodexRateLimitResetNextStep | null;
  order?: CodexResetSnapshotOrder | null;
  reason?: string | null;
  replayed?: boolean | null;
  /** An error's code (a Prisma code, a SQLSTATE) or its class name; never its message. */
  error?: string | null;
}

export const CODEX_RESET_LOG_REDACTED = '[redacted]';

const STAGES: readonly string[] = ['admission', 'delivery', 'consume', 'refresh', 'receipt'];
const DISPOSITIONS: readonly string[] = ['APPLIED', 'DUPLICATE', 'REFUSED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD = /^[a-z][a-z0-9_]{0,47}$/;
const ERROR = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODES: ReadonlySet<string> = new Set([
  ...CODEX_RATE_LIMIT_RESET_ENUMS.refusalCode,
  ...CODEX_RATE_LIMIT_RESET_ENUMS.resultCode,
  ...CODEX_RATE_LIMIT_RESET_ENUMS.resultRejection,
  ...CODEX_RATE_LIMIT_RESET_ENUMS.failureCode,
]);

/**
 * The line for `fields` at `stage`, every value checked as the header says. `secrets` are values no line may
 * contain: a field holding one is redacted whatever else it passes.
 */
export function codexResetLogLine(
  stage: CodexResetLogStage,
  fields: CodexResetLogFields,
  secrets: ReadonlyArray<string | null | undefined> = [],
): string {
  const hidden = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 8);
  const line: Record<string, string | number | boolean> = {};
  const text = (key: string, value: unknown, allowed: (value: string) => boolean, written = (value: string) => value) => {
    if (value === undefined || value === null || value === '') return;
    line[key] =
      typeof value === 'string' && allowed(value) && !hidden.some((secret) => value.includes(secret))
        ? written(value)
        : CODEX_RESET_LOG_REDACTED;
  };
  const member = (values: readonly string[]) => (value: string) => values.includes(value);

  text('stage', stage, member(STAGES));
  text('event', fields.event, (value) => WORD.test(value));
  text('operationId', fields.operationId, (value) => UUID.test(value));
  text('runnerId', fields.runnerId, (value) => UUID.test(value));
  text('process', fields.process, (value) => UUID.test(value), (value) => value.slice(0, 8));
  text('phase', fields.phase, member(CODEX_RATE_LIMIT_RESET_ENUMS.phase));
  if (fields.claimGeneration !== undefined && fields.claimGeneration !== null) {
    line.claimGeneration =
      Number.isSafeInteger(fields.claimGeneration) && fields.claimGeneration >= 0 ? fields.claimGeneration : CODEX_RESET_LOG_REDACTED;
  }
  text('kind', fields.kind, member(CODEX_RATE_LIMIT_RESET_ENUMS.resultKind));
  text('outcome', fields.outcome, member(CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES));
  text('code', fields.code, (value) => CODES.has(value));
  text('disposition', fields.disposition, member(DISPOSITIONS));
  text('from', fields.from, member(CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus));
  text('status', fields.status, member(CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus));
  text('next', fields.next, member(CODEX_RATE_LIMIT_RESET_ENUMS.nextStep));
  text('order', fields.order, member(CODEX_RATE_LIMIT_RESET_ENUMS.snapshotOrder));
  text('reason', fields.reason, (value) => WORD.test(value));
  if (fields.replayed !== undefined && fields.replayed !== null) line.replayed = fields.replayed === true;
  text('error', fields.error, (value) => ERROR.test(value));
  return `codex-reset ${JSON.stringify(line)}`;
}

/** What names an error in a line: a string `code` it carries (Prisma, PostgreSQL), else its class name. */
export function codexResetErrorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return (error as Error | null)?.name ?? 'Error';
}
