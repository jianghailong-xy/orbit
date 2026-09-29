import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { POOL_USAGE_FLUSH_MS } from './pool-usage-ledger';

/** One answer's worth of use of a login pool's account by one session. */
export interface PoolLoginUsageEntry {
  poolId: string;
  accountId: string;
  sessionId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** When it was used, which decides the hour it counts in. */
  at: Date;
}

interface Pending {
  poolId: string;
  accountId: string;
  sessionId: string;
  windowStart: Date;
  requests: number;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  costMicros: bigint;
}

interface Reading {
  poolId: string;
  accountId: string;
  snapshot: PlanUsageSnapshot;
  at: Date;
}

/** The start of the UTC hour `at` falls in: a row of `pool_login_usage` is one session's hour. */
export function loginUsageWindowStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/**
 * The login pools' ledger as the pool gateway writes it (`pool_login_usage`: per session, per account,
 * per UTC hour — migration 0324), and the last window reading each account's answers carried
 * (`pool_codex_login.usage`). Both are added here, in memory, when an answer ends, and written every
 * POOL_USAGE_FLUSH_MS as ONE statement each: the gateway holds no database connection while a response
 * streams, and a busy session costs two writes every two seconds rather than one per answer — the shared
 * pools' ledger (PoolUsageLedger) for the same reason, on the same clock.
 *
 * A write that fails puts its rows back for the next batch. A row whose session or pool is gone by then
 * is dropped by the write itself rather than failing it; a reading older than the one stored changes
 * nothing. Per process, like the gateway it serves.
 */
@Injectable()
export class PoolLoginLedger implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PoolLoginLedger');
  private pending = new Map<string, Pending>();
  private readings = new Map<string, Reading>();
  private timer?: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, POOL_USAGE_FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Adds one answer's use. Nothing is written here. */
  record(entry: PoolLoginUsageEntry): void {
    add(this.pending, {
      poolId: entry.poolId,
      accountId: entry.accountId,
      sessionId: entry.sessionId,
      windowStart: loginUsageWindowStart(entry.at),
      requests: 1,
      inputTokens: BigInt(Math.max(0, Math.floor(entry.inputTokens))),
      cachedInputTokens: BigInt(Math.max(0, Math.floor(entry.cachedInputTokens))),
      outputTokens: BigInt(Math.max(0, Math.floor(entry.outputTokens))),
      costMicros: BigInt(Math.max(0, Math.floor(entry.costMicros))),
    });
  }

  /** Keeps the latest window reading of one account. Nothing is written here. */
  recordReading(poolId: string, accountId: string, snapshot: PlanUsageSnapshot, at: Date): void {
    const key = `${poolId}|${accountId}`;
    const held = this.readings.get(key);
    if (!held || held.at.getTime() <= at.getTime()) this.readings.set(key, { poolId, accountId, snapshot, at });
  }

  /** Writes everything gathered so far; one write at a time, and a call during one waits for it. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.write().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async write(): Promise<void> {
    const rows = [...this.pending.values()];
    const readings = [...this.readings.values()];
    this.pending = new Map();
    this.readings = new Map();
    if (rows.length > 0) {
      // Ordered, so two writers adding to the same rows take their locks in the same order.
      rows.sort((a, b) =>
        a.sessionId !== b.sessionId ? (a.sessionId < b.sessionId ? -1 : 1)
          : a.accountId !== b.accountId ? (a.accountId < b.accountId ? -1 : 1)
            : a.windowStart.getTime() - b.windowStart.getTime(),
      );
      try {
        await this.prisma.$executeRaw`
          INSERT INTO "pool_login_usage"
            ("pool_id", "account_id", "session_id", "window_start", "requests", "input_tokens",
             "cached_input_tokens", "output_tokens", "cost_micros", "updated_at")
          SELECT v.pool_id, v.account_id, v.session_id, v.window_start, v.requests, v.input_tokens,
                 v.cached_input_tokens, v.output_tokens, v.cost_micros, now()
            FROM (VALUES ${Prisma.join(
              rows.map(
                (row) => Prisma.sql`(${row.poolId}::uuid, ${row.accountId}::text, ${row.sessionId}::uuid,
                  ${row.windowStart}::timestamp(3), ${row.requests}::int, ${row.inputTokens}::bigint,
                  ${row.cachedInputTokens}::bigint, ${row.outputTokens}::bigint, ${row.costMicros}::bigint)`,
              ),
            )}) AS v (pool_id, account_id, session_id, window_start, requests, input_tokens,
                      cached_input_tokens, output_tokens, cost_micros)
            JOIN "provider_pool" p ON p.id = v.pool_id
            JOIN "session" s ON s.id = v.session_id
           ORDER BY v.session_id, v.account_id, v.window_start
          ON CONFLICT ("session_id", "account_id", "window_start") DO UPDATE SET
            "requests" = "pool_login_usage"."requests" + EXCLUDED."requests",
            "input_tokens" = "pool_login_usage"."input_tokens" + EXCLUDED."input_tokens",
            "cached_input_tokens" = "pool_login_usage"."cached_input_tokens" + EXCLUDED."cached_input_tokens",
            "output_tokens" = "pool_login_usage"."output_tokens" + EXCLUDED."output_tokens",
            "cost_micros" = "pool_login_usage"."cost_micros" + EXCLUDED."cost_micros",
            "updated_at" = now()`;
      } catch (e) {
        // Back into the next batch: the statement is all-or-nothing, so none of these rows was counted.
        for (const row of rows) add(this.pending, row);
        this.log.warn(`login pool usage write failed, ${rows.length} row(s) kept for the next: ${(e as Error).message}`);
      }
    }
    if (readings.length > 0) {
      readings.sort((a, b) => (a.poolId !== b.poolId ? (a.poolId < b.poolId ? -1 : 1) : a.accountId < b.accountId ? -1 : 1));
      try {
        await this.prisma.$executeRaw`
          UPDATE "pool_codex_login" l
             SET "usage" = v.usage, "usage_read_at" = v.read_at
            FROM (VALUES ${Prisma.join(
              readings.map(
                (reading) => Prisma.sql`(${reading.poolId}::uuid, ${reading.accountId}::text,
                  ${JSON.stringify(reading.snapshot)}::jsonb, ${reading.at}::timestamp(3))`,
              ),
            )}) AS v (pool_id, account_id, usage, read_at)
           WHERE l.pool_id = v.pool_id AND l.account_id = v.account_id
             AND (l.usage_read_at IS NULL OR l.usage_read_at <= v.read_at)`;
      } catch (e) {
        for (const reading of readings) this.recordReading(reading.poolId, reading.accountId, reading.snapshot, reading.at);
        this.log.warn(`login pool usage reading write failed, ${readings.length} kept for the next: ${(e as Error).message}`);
      }
    }
  }
}

function add(into: Map<string, Pending>, row: Pending): void {
  const key = `${row.sessionId}|${row.accountId}|${row.windowStart.toISOString()}`;
  const held = into.get(key);
  if (!held) {
    into.set(key, { ...row });
    return;
  }
  held.requests += row.requests;
  held.inputTokens += row.inputTokens;
  held.cachedInputTokens += row.cachedInputTokens;
  held.outputTokens += row.outputTokens;
  held.costMicros += row.costMicros;
}
