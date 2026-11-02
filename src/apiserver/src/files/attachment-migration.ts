import { NotFoundException, type Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FilesService } from './files.service';

/**
 * How attachments from before Orbit Files leave Postgres (docs/orbit-files-design.md §2.1), in the two steps the
 * account owner decided on 2026-11-02:
 *
 *   copy   Automatic and reversible: `AttachmentCopyAtBoot`, in the background after a start. A row's bytes go into the
 *          file store and the row names them (`sha256`), and `data` stays, so an older apiserver, which reads `data`
 *          alone, still reads every row.
 *   clear  Manual and one-way: `attachment-migration.cli.ts clear`. A copied row's `data` goes NULL once its bytes have
 *          been read back from the store. No older apiserver can read such a row, which is why a person chooses when.
 *
 * Neither step keeps any state but the rows: `sha256` says a row is copied, `data` that it is not cleared. So either can
 * stop at any instant, and running it again carries on from where the rows say and writes nothing to a row already done.
 * Readers see neither step: FilesService.open takes the bytes from whichever side has them.
 */

/** What the migration may take in one go, and how long the copy leaves the server alone afterwards. */
export interface MigrationLimits {
  /** Rows in a batch. */
  rows: number;
  /**
   * Bytes in a batch, by `size_bytes`; a row larger than this is a batch of its own. Rows are read and stored one at a
   * time, so what the copy holds in memory is one row whatever this says: a batch is how much work comes between pauses.
   */
  bytes: number;
  /** The pause after a batch. */
  pauseMs: number;
  /** The pause after a failure, and before the walk goes round again for what it left behind. */
  retryMs: number;
  /**
   * The room kept on the disk under the files directory, which is usually Postgres's disk: filling it would stop uploads
   * and the database. Both steps can: the copy holds these bytes twice until the clear, and starts by itself on the first
   * start after an upgrade, and the clear writes about as much WAL as the bytes it removes, because the first change to a
   * page after a checkpoint logs the whole page, and the archive keeps that WAL. The same 2 GiB the backup sidecar leaves
   * (ORBIT_BACKUP_MIN_FREE_MB).
   */
  minFreeBytes: number;
}

export const MIGRATION_LIMITS: MigrationLimits = {
  rows: 100,
  bytes: 64 * 1024 * 1024,
  pauseMs: 1_000,
  retryMs: 60_000,
  minFreeBytes: 2 * 1024 * 1024 * 1024,
};

export interface RowsAndBytes {
  rows: number;
  bytes: number;
}

/** Where the bytes of every attachment are. */
export interface AttachmentCounts {
  /** Only in `data`: the copy has not reached these. */
  waiting: RowsAndBytes;
  /** In the store and still in `data`: copied, not cleared. */
  copied: RowsAndBytes;
  /** Only in the store: cleared, or uploaded since Orbit Files. */
  storeOnly: RowsAndBytes;
}

/** A row the clear left as it was, and why. */
export interface ClearRefusal {
  id: string;
  sha256: string;
  reason: string;
}

export interface ClearResult {
  cleared: RowsAndBytes;
  refused: number;
  /** Why it stopped before the last row, when it did. */
  stopped?: string;
}

const amount = ({ rows, bytes }: RowsAndBytes) => `${rows} (${bytes} bytes)`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What became of a row the clear went to, when it is not a refusal: its `data` went, or the row or its `data` already had. */
const CLEARED = Symbol('cleared');
const GONE = Symbol('gone');

export class AttachmentMigration {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly log: Pick<Logger, 'log' | 'warn'>,
    private readonly limits: MigrationLimits = MIGRATION_LIMITS,
  ) {}

  /** Whether any row waits for the copy. Cheap enough for every start: at worst it reads the table's rows, not their bytes, which are kept apart. */
  async copyIsDue(): Promise<boolean> {
    return (await this.prisma.attachment.findFirst({ where: { sha256: null }, select: { id: true } })) !== null;
  }

  /**
   * Copy until no row waits, or `signal` stops it, one batch at a time, with a line of progress after each.
   *
   * A walk by id, so that a row that fails is passed over rather than stopping the rows after it. The walk goes round
   * again for what it left behind, which is that row, or one written behind it: resending a message copies its
   * attachment under a new id. Whatever stops it, the pause is `retryMs`, so a store that is down costs a row a minute.
   *
   * Every apiserver that starts with rows waiting does this, and they agree: a row copied twice is the same row
   * (FilesService.referenceOf). That is the work twice over for as long as the copy lasts, in return for no process
   * waiting on another, which is how a lock would leave a restarted process idle behind one with nothing to copy.
   */
  async copy(signal: AbortSignal): Promise<void> {
    const copied: RowsAndBytes = { rows: 0, bytes: 0 };
    let after: string | undefined;
    while (!signal.aborted) {
      let pause = this.limits.pauseMs;
      try {
        // Nothing is lost by waiting: a row not copied is read from `data`. A bucket is not this disk.
        const short = this.files.config.storage === 'local' ? await this.diskIsShort() : null;
        if (short) throw new Error(short);
        const batch = await this.nextBatch(after);
        for (const row of batch) {
          after = row.id;
          if (await this.copyRow(row.id)) {
            copied.rows += 1;
            copied.bytes += row.sizeBytes;
          }
        }
        const left = await this.total({ sha256: null });
        this.log.log(`attachment copy: ${amount(copied)} copied this run, ${amount(left)} left`);
        if (left.rows === 0) return;
        if (batch.length === 0) {
          after = undefined;
          pause = this.limits.retryMs;
        }
      } catch (error) {
        this.log.warn(`attachment copy: stopped at row ${after ?? 'none'}: ${messageOf(error)}`);
        pause = this.limits.retryMs;
      }
      await sleep(pause, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  /** What to say when the disk under the files directory is down to the room it keeps; null when it is not. */
  private async diskIsShort(): Promise<string | null> {
    const free = await this.files.freeBytes();
    if (free >= this.limits.minFreeBytes) return null;
    return `the disk under the files directory has ${free} bytes free, and this leaves it ${this.limits.minFreeBytes}`;
  }

  /** The next rows of the walk: as many as the limits allow, and always the first, however large it is. */
  private async nextBatch(after: string | undefined): Promise<{ id: string; sizeBytes: number }[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { sha256: null, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: this.limits.rows,
      select: { id: true, sizeBytes: true },
    });
    const batch: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += row.sizeBytes;
      if (batch.length > 0 && bytes > this.limits.bytes) break;
      batch.push(row);
    }
    return batch;
  }

  /** One row's bytes kept and named, which is what a dispatch does the first time it copies an old input. False if it has been deleted. */
  private async copyRow(id: string): Promise<boolean> {
    try {
      await this.files.referenceOf({ id, sha256: null });
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  async counts(): Promise<AttachmentCounts> {
    return {
      waiting: await this.total({ sha256: null }),
      copied: await this.total({ sha256: { not: null }, data: { not: null } }),
      storeOnly: await this.total({ data: null }),
    };
  }

  private async total(where: Prisma.AttachmentWhereInput): Promise<RowsAndBytes> {
    const { _count, _sum } = await this.prisma.attachment.aggregate({ where, _count: { _all: true }, _sum: { sizeBytes: true } });
    return { rows: _count._all, bytes: _sum.sizeBytes ?? 0 };
  }

  /**
   * Clear `data` on every copied row whose bytes the store really holds, one row at a time, telling `refused` of each
   * row it leaves. Rows the copy has not reached are not looked at. A row written behind the walk waits for the next run.
   * Stops, with the rows it has done, when the disk is short of room. It asks before every row, whichever store is in use:
   * what fills that disk here is Postgres's WAL.
   */
  async clear(refused: (refusal: ClearRefusal) => void): Promise<ClearResult> {
    const result: ClearResult = { cleared: { rows: 0, bytes: 0 }, refused: 0 };
    let after: string | undefined;
    for (;;) {
      const rows = await this.prisma.attachment.findMany({
        where: { sha256: { not: null }, data: { not: null }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: this.limits.rows,
        select: { id: true, sizeBytes: true, sha256: true, blob: { select: { storage: true, sizeBytes: true } } },
      });
      if (rows.length === 0) return result;
      for (const row of rows) {
        const short = await this.diskIsShort();
        if (short) return { ...result, stopped: short };
        // Both are set: the `where` asks for a sha256, and attachment_sha256_fkey gives it its file_blob.
        const sha256 = row.sha256!;
        const outcome = (await this.storeRefuses(sha256, row.blob!)) ?? (await this.clearRow(row.id, sha256));
        if (outcome === CLEARED) {
          result.cleared.rows += 1;
          result.cleared.bytes += row.sizeBytes;
        } else if (outcome !== GONE) {
          result.refused += 1;
          refused({ id: row.id, sha256, reason: outcome });
        }
      }
      after = rows[rows.length - 1].id;
      this.log.log(`attachment clear: ${amount(result.cleared)} cleared this run, ${result.refused} refused`);
    }
  }

  /** Why the store does not vouch for these bytes, having read every one of them back; null when it does. */
  private async storeRefuses(sha256: string, blob: { storage: string; sizeBytes: number }): Promise<string | null> {
    try {
      const held = await this.files.readBack({ sha256, storage: blob.storage });
      if (!held) return `the ${blob.storage} file store does not hold these bytes`;
      if (held.sha256 === sha256 && held.sizeBytes === blob.sizeBytes) return null;
      return `the ${blob.storage} file store holds other bytes under this name: ${held.sizeBytes} bytes, sha256 ${held.sha256}`;
    } catch (error) {
      return `the ${blob.storage} file store could not be read: ${messageOf(error)}`;
    }
  }

  /**
   * Clear one row whose store has vouched for `sha256`, or say why not. The same statement proves that `data` is those
   * bytes, because a row whose `data` is anything else would lose it for good: Postgres hashes it where it is, rather
   * than this process reading it in.
   */
  private async clearRow(id: string, sha256: string): Promise<string | typeof CLEARED | typeof GONE> {
    const cleared = await this.prisma.$executeRaw`
      UPDATE attachment SET data = NULL
      WHERE id = ${id}::uuid AND sha256 = ${sha256} AND encode(pg_catalog.sha256(data), 'hex') = ${sha256}`;
    if (cleared === 1) return CLEARED;
    const left = await this.prisma.attachment.count({ where: { id, sha256, data: { not: null } } });
    return left === 0 ? GONE : 'its data in Postgres does not hash to this sha256';
  }
}
