import { Prisma } from '@prisma/client';
import type { ModelUsage, TurnCompleteRequest } from '@orbit/shared';

/**
 * A Claude turn books its own cost and tokens (task 34sjn2yQvNJg1JhQIARvd).
 *
 * Claude Code's `total_cost_usd` and `modelUsage` are running totals of its process, and a process
 * started with `--resume` restores what its transcript last saved and goes on counting. Measured on
 * 2.1.318 with a scripted model: a process saves its totals only when it exits on its own (EOF,
 * SIGTERM), and the runner stops one with SIGKILL when it recycles, reloads or drains it, so what a
 * new process restores is often older than the totals the process before it reported, and zero when
 * the transcript saved nothing (one Orbit rebuilt from events). turn-complete used to add the total
 * to `session.cost_usd` every turn and write it as a new `usage` row.
 *
 * A turn's own share is its totals less what they are measured from:
 *
 *  - The completion before it, from the same engine process: the session holds those totals as they
 *    were booked (`engine_usage_totals`). Exact, and kept with the turn it books, so a runner that
 *    restarts loses nothing and a completion settled without its reports leaves them in place for
 *    the next one to book.
 *  - The first completion of a process, from what that process restored, which the runner reads from
 *    the transcript the CLI is about to resume, the way the CLI reads it (`runningTotals.restored`).
 *    Exact whether the totals carried on, went back to an older save, or started from zero. Spend
 *    a process made after its last completion (a prompt suggestion, a turn the engine ran by itself)
 *    is booked by none: the next process's own count starts above it or without it.
 *  - From a runner too old to name its process, the totals booked last whatever process reported
 *    them, and for a session nothing was booked for under this rule, what the last `usage` rows
 *    written before it hold (running totals, as they were then). Exact while the process lives; a
 *    process that restored less than that books its first turn short. Never twice.
 *
 * A difference is never below zero, so whatever moved a count backwards books short, not twice. A
 * re-posted completion books nothing at all: turn-complete's acknowledgement matches it to no turn.
 */

/** One model's counts that are booked. */
const COUNTS = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'costUSD'] as const;

/** session.engine_usage_totals: an engine's running totals as booked. */
export interface BookedRunningTotals {
  /** The engine process they are totals of: `runningTotals.process`, null from a runner that names none. */
  process: string | null;
  costUsd: number;
  modelUsage: Record<string, ModelUsage>;
}

/** What a completion's running totals are measured from. */
export interface RunningTotalsBase {
  costUsd: unknown;
  modelUsage: Record<string, Partial<Record<(typeof COUNTS)[number], unknown>>>;
}

const NOTHING: RunningTotalsBase = { costUsd: 0, modelUsage: {} };

/** Whether a completion reports running totals (Claude Code's) rather than its turn's own numbers. */
export function reportsRunningTotals(dto: TurnCompleteRequest): boolean {
  return dto.modelUsage != null || dto.runningTotals != null;
}

/** What this completion's running totals are measured from. `stored` is the session's engine_usage_totals. */
export async function runningTotalsBase(
  tx: Prisma.TransactionClient,
  sessionId: string,
  dto: TurnCompleteRequest,
  stored: Prisma.JsonValue | null,
): Promise<RunningTotalsBase> {
  const booked = readBooked(stored);
  if (dto.runningTotals) {
    return booked && booked.process === dto.runningTotals.process
      ? booked
      : dto.runningTotals.restored ?? NOTHING;
  }
  return booked ?? (await totalsBookedBeforeThisRule(tx, sessionId)) ?? NOTHING;
}

/** The turn's own cost. */
export function ownCost(reported: number | undefined, base: RunningTotalsBase): number {
  const own = less(reported ?? 0, base.costUsd);
  return typeof own === 'number' ? own : 0;
}

/**
 * Each model's own counts. A model with none of its own this turn is left out, so a row holds what
 * the turn spent. A count that is not a number passes through as it came, for the row's write to
 * refuse as it always has.
 */
export function ownModelUsage(reported: Record<string, ModelUsage>, base: RunningTotalsBase): Record<string, ModelUsage> {
  const own: Record<string, ModelUsage> = {};
  for (const [model, totals] of Object.entries(reported)) {
    const from = base.modelUsage?.[model] ?? {};
    const counts = Object.fromEntries(
      COUNTS.map((count) => [count, less(totals[count], from[count])]),
    ) as unknown as ModelUsage;
    if (COUNTS.some((count) => counts[count] !== 0 && counts[count] !== undefined)) own[model] = counts;
  }
  return own;
}

/** What the session holds once this completion is booked: its totals, and whose they are. */
export function bookedAfter(dto: TurnCompleteRequest): Prisma.InputJsonValue {
  const modelUsage: Record<string, Record<string, unknown>> = {};
  for (const [model, totals] of Object.entries(dto.modelUsage ?? {})) {
    modelUsage[model] = Object.fromEntries(COUNTS.map((count) => [count, totals[count] ?? 0]));
  }
  const booked = { process: dto.runningTotals?.process ?? null, costUsd: dto.costUsd ?? 0, modelUsage };
  return booked as Prisma.InputJsonValue;
}

/** `total` less `from`, never below zero. Something other than a number is left as it is. */
function less(total: unknown, from: unknown): unknown {
  if (typeof total !== 'number') return total;
  return Math.max(0, total - (typeof from === 'number' && Number.isFinite(from) ? from : 0));
}

function readBooked(stored: Prisma.JsonValue | null): BookedRunningTotals | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const { process, costUsd, modelUsage } = stored as Record<string, unknown>;
  if (typeof costUsd !== 'number' || !modelUsage || typeof modelUsage !== 'object') return null;
  return {
    process: typeof process === 'string' ? process : null,
    costUsd,
    modelUsage: modelUsage as Record<string, ModelUsage>,
  };
}

/**
 * The running totals the last completion before this rule booked: each model's latest `usage`
 * row, which held the totals as reported. Null for a session with none.
 */
async function totalsBookedBeforeThisRule(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<RunningTotalsBase | null> {
  const rows = await tx.$queryRaw<Array<{
    model: string; inputTokens: bigint; outputTokens: bigint;
    cacheCreationInputTokens: bigint; cacheReadInputTokens: bigint; costUsd: number;
  }>>(latestRowPerModel(Prisma.sql`session_id = ${sessionId}::uuid`));
  if (rows.length === 0) return null;
  const modelUsage: RunningTotalsBase['modelUsage'] = {};
  let costUsd = 0;
  for (const row of rows) {
    modelUsage[row.model] = {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
      cacheReadInputTokens: Number(row.cacheReadInputTokens),
      costUSD: row.costUsd,
    };
    costUsd += row.costUsd;
  }
  return { costUsd, modelUsage };
}

/** Each model's latest `usage` row among those `where` selects: what a running total last said. */
function latestRowPerModel(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (model) model,
           input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           cache_creation_input_tokens AS "cacheCreationInputTokens",
           cache_read_input_tokens AS "cacheReadInputTokens", cost_usd AS "costUsd"
      FROM usage
     WHERE ${where}
     ORDER BY model, created_at DESC, id DESC`;
}

/** A session's tokens over all its turns, as `GET /sessions/:id` answers them. */
export interface SessionTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * A session's tokens, read from its `usage` rows in one statement. A row written since this rule
 * holds its turn's own counts and is summed. A Claude row written before it (before migration 0478
 * applied, which shipped with it) held the process's running totals as they were then, so each
 * model counts only its latest such row, the same base the first completion under this rule
 * measured its own share from (totalsBookedBeforeThisRule): a naive SUM would count every turn
 * again on each later one. Other engines always wrote a turn's own numbers, so `runningTotals`
 * (does this session's engine report running totals) is false for them and every row is summed.
 */
export async function sessionTokenTotals(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  sessionId: string,
  runningTotals: boolean,
): Promise<SessionTokenTotals> {
  const legacy = runningTotals
    ? Prisma.sql`created_at < (SELECT max(finished_at) FROM "_prisma_migrations"
                                WHERE migration_name = '0478_session_engine_usage_totals')`
    : Prisma.sql`false`;
  const [row] = await db.$queryRaw<Array<Record<keyof SessionTokenTotals, bigint | null>>>(Prisma.sql`
    WITH counted AS (
      SELECT input_tokens AS "inputTokens", output_tokens AS "outputTokens",
             cache_creation_input_tokens AS "cacheCreationInputTokens",
             cache_read_input_tokens AS "cacheReadInputTokens"
        FROM usage
       WHERE session_id = ${sessionId}::uuid AND (${legacy}) IS NOT TRUE
      UNION ALL
      SELECT "inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"
        FROM (${latestRowPerModel(Prisma.sql`session_id = ${sessionId}::uuid AND (${legacy}) IS TRUE`)}) legacy
    )
    SELECT sum("inputTokens")::bigint AS "inputTokens", sum("outputTokens")::bigint AS "outputTokens",
           sum("cacheReadInputTokens")::bigint AS "cacheReadTokens",
           sum("cacheCreationInputTokens")::bigint AS "cacheCreationTokens"
      FROM counted`);
  return {
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(row?.cacheCreationTokens ?? 0),
  };
}
