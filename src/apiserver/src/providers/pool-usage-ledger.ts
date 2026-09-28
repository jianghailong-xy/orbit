import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { usageWindowStart } from './shared-pool';

/** One answer's worth of use of one key by one person. */
export interface PoolUsageEntry {
  poolId: string;
  keyId: string;
  userId: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** When it was used, which decides the month it counts in. */
  at: Date;
}

interface Pending {
  poolId: string;
  keyId: string;
  userId: string;
  windowStart: Date;
  inputTokens: bigint;
  outputTokens: bigint;
  costMicros: bigint;
}

/** How often what has gathered is written. */
export const POOL_USAGE_FLUSH_MS = 2_000;

/**
 * The shared pools' ledger as the pool gateway writes it (`pool_usage`: per key, per person, per calendar
 * month — migration 0321). An answer's use is added here, in memory, the moment its stream ends, and
 * written with everybody else's every POOL_USAGE_FLUSH_MS as ONE statement: the gateway holds no
 * database connection while a response streams, and a busy pool costs one write every two seconds rather
 * than one per answer (the connection-pool contention the design warns about).
 *
 * What is not written yet still counts: a share cap is checked against the table plus what is pending
 * here (`pendingOthersCostMicros`), so the batching delays no cap. A write that fails puts its rows back
 * to be tried with the next batch; a row whose key or person has gone by then is dropped by the write
 * itself rather than failing it. Per process, like the gateway it serves.
 */
@Injectable()
export class PoolUsageLedger implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PoolUsageLedger');
  private pending = new Map<string, Pending>();
  /** The batch being written: still counted by the cap checks until it is in the table. */
  private writing = new Map<string, Pending>();
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
  record(entry: PoolUsageEntry): void {
    if (entry.inputTokens <= 0 && entry.outputTokens <= 0 && entry.costMicros <= 0) return;
    add(this.pending, {
      poolId: entry.poolId,
      keyId: entry.keyId,
      userId: entry.userId,
      windowStart: usageWindowStart(entry.at),
      inputTokens: BigInt(Math.floor(entry.inputTokens)),
      outputTokens: BigInt(Math.floor(entry.outputTokens)),
      costMicros: BigInt(Math.floor(entry.costMicros)),
    });
  }

  /**
   * What everyone but `contributorId` has spent on `keyId` in the month `windowStart` opens that is not in
   * the table yet, in millionths of a dollar.
   */
  pendingOthersCostMicros(keyId: string, contributorId: string, windowStart: Date): number {
    let total = 0n;
    for (const rows of [this.pending, this.writing]) {
      for (const row of rows.values()) {
        if (row.keyId === keyId && row.userId !== contributorId && row.windowStart.getTime() === windowStart.getTime()) {
          total += row.costMicros;
        }
      }
    }
    return Number(total);
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
    if (this.pending.size === 0) return;
    this.writing = this.pending;
    this.pending = new Map();
    // Ordered, so two writers adding to the same rows take their locks in the same order.
    const rows = [...this.writing.values()].sort((a, b) =>
      a.keyId === b.keyId ? (a.userId === b.userId ? a.windowStart.getTime() - b.windowStart.getTime() : a.userId < b.userId ? -1 : 1) : a.keyId < b.keyId ? -1 : 1,
    );
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "pool_usage"
          ("pool_id", "key_id", "user_id", "window_start", "input_tokens", "output_tokens", "cost_micros", "updated_at")
        SELECT v.pool_id, v.key_id, v.user_id, v.window_start, v.input_tokens, v.output_tokens, v.cost_micros, now()
          FROM (VALUES ${Prisma.join(
            rows.map(
              (row) => Prisma.sql`(${row.poolId}::uuid, ${row.keyId}::uuid, ${row.userId}::uuid, ${row.windowStart}::date,
                ${row.inputTokens}::bigint, ${row.outputTokens}::bigint, ${row.costMicros}::bigint)`,
            ),
          )}) AS v (pool_id, key_id, user_id, window_start, input_tokens, output_tokens, cost_micros)
          JOIN "pool_api_key" k ON k.id = v.key_id AND k.pool_id = v.pool_id
          JOIN "user" u ON u.id = v.user_id
         ORDER BY v.key_id, v.user_id, v.window_start
        ON CONFLICT ("key_id", "user_id", "window_start") DO UPDATE SET
          "input_tokens" = "pool_usage"."input_tokens" + EXCLUDED."input_tokens",
          "output_tokens" = "pool_usage"."output_tokens" + EXCLUDED."output_tokens",
          "cost_micros" = "pool_usage"."cost_micros" + EXCLUDED."cost_micros",
          "updated_at" = now()`;
    } catch (e) {
      // Back into the next batch: the statement is all-or-nothing, so none of these rows was counted.
      for (const row of this.writing.values()) add(this.pending, row);
      this.log.warn(`pool usage write failed, ${rows.length} row(s) kept for the next: ${(e as Error).message}`);
    } finally {
      this.writing = new Map();
    }
  }
}

function add(into: Map<string, Pending>, row: Pending): void {
  const key = `${row.keyId}|${row.userId}|${row.windowStart.toISOString()}`;
  const held = into.get(key);
  if (!held) {
    into.set(key, { ...row });
    return;
  }
  held.inputTokens += row.inputTokens;
  held.outputTokens += row.outputTokens;
  held.costMicros += row.costMicros;
}
