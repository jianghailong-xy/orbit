import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';
import { messageOf } from './file-store';
import { FilesService } from './files.service';
import { FILE_UPLOAD_RETENTION, UPLOAD_RETENTION_MS, fileGraceMs, offHostPruneAtFor } from './file-retention';

/** How often the sweep runs: a file's dates are in days, and nothing waits on it. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** How long after a start the first sweep runs, once the process has had time to take the singleton lock. */
const FIRST_SWEEP_DELAY_MS = 60 * 1000;

/** Rows one tombstone statement writes, and blobs one sweep deletes: a backlog goes over several runs, never in one go. */
const SWEEP_BATCH = 1000;

/** How long one blob's delete may hold its row: a local unlink is at once, and a bucket gets as long as it takes to answer. */
const DELETE_TRANSACTION_TIMEOUT_MS = 65_000;

/** How long a drive write may go untouched before its staging, and the chunks only it held, are let go. */
export const DRIVE_STAGING_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the drive keeps a commit's answer and a change-feed row (docs/drive-technical-design.md §1.1). */
export const DRIVE_FEED_KEEP_MS = 24 * 60 * 60 * 1000;

/** How long the drive keeps who moved or renamed an entry (drive_move, 1780), what the activity view reads. */
export const DRIVE_MOVE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** What one sweep did. */
export interface FileSweepResult {
  /**
   * Drive stagings removed because nothing had touched them for DRIVE_STAGING_IDLE_MS, and the files a replacing rename
   * removed (drive_removed_entry) kept that long for a handle still writing one.
   */
  stagingsRemoved: number;
  /**
   * Drive commit answers and change-feed rows removed because they were older than DRIVE_FEED_KEEP_MS, and drive_move rows
   * older than DRIVE_MOVE_KEEP_MS.
   */
  feedRowsRemoved: number;
  /** Rows given a date: those whose task was deleted, and those no date was ever written for. */
  dated: number;
  tombstoned: number;
  /** Blobs whose bytes went. */
  deleted: number;
  /** Blobs it left this time because it could not reach their store. */
  failed: number;
}

/**
 * Carries out §2.8's expiry (file-retention.ts says what the dates mean), in five steps, each of which can stop at any
 * instant and is carried on from by the next sweep:
 *
 *   0. A drive staging (docs/drive-technical-design.md §2.4), a write no commit has taken, is removed once
 *      nothing has touched it for seven days; its chunk rows go with it, and step 3 then finds what only they held. A
 *      drive commit's answer and a change-feed row go once they are a day old: a retried commit or a feed reader older
 *      than that starts again from the tree.
 *   1. A file its task's deletion let go of gets its date. Nothing else writes one then: the deletion takes the versions
 *      that held the row with it, whichever door or cascade it came through, and a row that evidence held has no date and
 *      names a version that is no longer there. Other rows of that task keep the date they have. An upload no evidence
 *      cites gets its date here too when none was written: one from before 0466, or from an older apiserver during a
 *      rolling upgrade.
 *   2. Every row past its date gets a tombstone (`expired_at`), and keeps everything else: its name, size, sha256, test
 *      summary and evidence. Nothing pinned, and nothing a door other than `file_upload` wrote.
 *   3. Bytes no live row names are marked `released_at`, and bytes a live row names again lose the mark. A drive chunk row,
 *      of a version or of a staging, is live for as long as it exists: drive content never expires, and stops holding
 *      only when the owner deletes it for good, which deletes the row.
 *   4. Bytes released for longer than the grace period go from their store (`bytes_deleted_at`), and the off-host copy may
 *      follow one grace period later (`off_host_prune_at`, scripts/pg-backup.sh). The row of a file_blob stays.
 *
 * Bytes are never deleted while an attachment row, or a drive chunk row, could still want them. Step 4 asks that under the
 * file_blob row's lock, which an attachment or drive chunk row naming these bytes needs in order to commit (its foreign key's
 * FOR KEY SHARE), which `store` needs
 * in order to stamp `last_referenced_at`, and which a pin takes before it lifts a tombstone. So once the question is answered
 * no new holder can appear until the bytes are gone and the row says so: an upload of the same content then finds them gone
 * and keeps them again. A row may be copied without `store` only while it has no tombstone, and that row holds the bytes.
 *
 * On the process that holds the singleton lock (realtime/control-plane-leader.ts). Its statements take rows a decision on
 * evidence may be writing, so the tombstone skips what is locked and comes back for it on the next sweep.
 */
@Injectable()
export class FileRetentionSweep implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('FileRetention');
  private readonly grace: number;
  private first?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    /** Which process sweeps. `@Optional()` for a spec that calls `sweep` itself. */
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {
    this.grace = fileGraceMs(files.config);
  }

  onApplicationBootstrap(): void {
    this.logger.log(`bytes of an expired file go ${Math.round(this.grace / (24 * 60 * 60 * 1000))} days after its tombstone`);
    this.first = setTimeout(() => this.tick(), FIRST_SWEEP_DELAY_MS);
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.first.unref();
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearTimeout(this.first);
    clearInterval(this.timer);
    await this.running;
  }

  /** The timer's run, on the process that sweeps. What goes wrong is said here, and the next run starts over. */
  private tick(): void {
    if (this.leader && !this.leader.leads()) return;
    if (this.running) return;
    this.running = this.sweep()
      .then((done) => {
        if (done.stagingsRemoved + done.feedRowsRemoved + done.dated + done.tombstoned + done.deleted + done.failed > 0) {
          this.logger.log(
            `removed ${done.stagingsRemoved} idle drive write(s) and ${done.feedRowsRemoved} old drive feed row(s), gave ${done.dated} file(s) a date, tombstoned ${done.tombstoned}, deleted the bytes of ${done.deleted}, and could `
              + `not reach the store of ${done.failed}`,
          );
        }
      })
      .catch((error) => this.logger.error(`the sweep stopped and runs again in an hour: ${messageOf(error)}`))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One sweep, as of `now`: a spec's clock, or the time it runs. */
  async sweep(now: Date = new Date()): Promise<FileSweepResult> {
    const stagingsRemoved = await this.removeIdleStagings(now);
    const feedRowsRemoved = await this.pruneDriveFeed(now);
    const dated = await this.dateUndatedFiles(now);
    const tombstoned = await this.tombstoneDue(now);
    await this.markReleased(now);
    const { deleted, failed } = await this.deleteReleased(now);
    return { stagingsRemoved, feedRowsRemoved, dated, tombstoned, deleted, failed };
  }

  /**
   * Step 0's second half: drive commit answers and change-feed rows older than a day, and moves older than 30 days, a
   * batch at a time.
   */
  private async pruneDriveFeed(now: Date): Promise<number> {
    const before = new Date(now.getTime() - DRIVE_FEED_KEEP_MS).toISOString();
    const movesBefore = new Date(now.getTime() - DRIVE_MOVE_KEEP_MS).toISOString();
    let total = 0;
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM drive_move
         WHERE id IN (SELECT id FROM drive_move WHERE at < ${movesBefore}::timestamptz LIMIT ${SWEEP_BATCH})`;
      total += removed;
      if (removed < SWEEP_BATCH) break;
    }
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM drive_commit
         WHERE (owner_id, commit_id) IN (
           SELECT owner_id, commit_id FROM drive_commit WHERE created_at < ${before}::timestamptz LIMIT ${SWEEP_BATCH}
         )`;
      total += removed;
      if (removed < SWEEP_BATCH) break;
    }
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM drive_change
         WHERE seq IN (SELECT seq FROM drive_change WHERE at < ${before}::timestamptz ORDER BY seq LIMIT ${SWEEP_BATCH})`;
      total += removed;
      if (removed < SWEEP_BATCH) return total;
    }
  }

  /** Step 0, a batch at a time. A staging a chunk is arriving for is skipped, and its touch moves it out of reach. */
  private async removeIdleStagings(now: Date): Promise<number> {
    const before = new Date(now.getTime() - DRIVE_STAGING_IDLE_MS).toISOString();
    let total = 0;
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM drive_staging
         WHERE id IN (
           SELECT id FROM drive_staging
            WHERE committed_at IS NULL
              AND touched_at < ${before}::timestamptz
            ORDER BY touched_at
            LIMIT ${SWEEP_BATCH}
            FOR UPDATE SKIP LOCKED
         )
           AND touched_at < ${before}::timestamptz`;
      total += removed;
      if (removed < SWEEP_BATCH) break;
    }
    // A file a replacing rename removed is kept for a handle still writing it as long as an untouched staging is (§3.2).
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM drive_removed_entry
         WHERE (owner_id, entry_id) IN (
           SELECT owner_id, entry_id FROM drive_removed_entry WHERE removed_at < ${before}::timestamptz LIMIT ${SWEEP_BATCH}
         )`;
      total += removed;
      if (removed < SWEEP_BATCH) return total;
    }
  }

  /**
   * Step 1, in two statements. A row evidence is citing right now is safe from the first because it re-reads `evidence_id`
   * once the citation commits, and from the second because only the row's own task can cite it, and that task is gone.
   */
  private async dateUndatedFiles(now: Date): Promise<number> {
    const uncited = await this.prisma.$executeRaw`
      UPDATE attachment
         SET expires_at = created_at + make_interval(secs => ${UPLOAD_RETENTION_MS / 1000})
       WHERE retention = ${FILE_UPLOAD_RETENTION}
         AND expires_at IS NULL
         AND expired_at IS NULL
         AND evidence_id IS NULL`;
    const ofDeletedTasks = await this.prisma.$executeRaw`
      UPDATE attachment AS a
         SET expires_at = GREATEST(a.created_at + make_interval(secs => ${UPLOAD_RETENTION_MS / 1000}), ${now.toISOString()}::timestamp)
       WHERE a.retention = ${FILE_UPLOAD_RETENTION}
         AND a.expires_at IS NULL
         AND a.expired_at IS NULL
         AND a.evidence_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM task_completion_evidence e WHERE e.id = a.evidence_id)`;
    return uncited + ofDeletedTasks;
  }

  /**
   * Step 2, a batch at a time. Locked before it is written, so that what is written is what was found due: a row evidence
   * has just come to hold is either skipped here or read with its new date. `::timestamp` drops the zone the ISO string
   * spells, which is UTC, as every date in these columns is.
   */
  private async tombstoneDue(now: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const written = await this.prisma.$executeRaw`
        UPDATE attachment
           SET expired_at = ${now.toISOString()}::timestamp
         WHERE id IN (
           SELECT id FROM attachment
            WHERE retention = ${FILE_UPLOAD_RETENTION}
              AND expires_at <= ${now.toISOString()}::timestamp
              AND expired_at IS NULL
              AND pinned_at IS NULL
            ORDER BY expires_at
            LIMIT ${SWEEP_BATCH}
            FOR UPDATE SKIP LOCKED
         )`;
      total += written;
      if (written < SWEEP_BATCH) return total;
    }
  }

  /**
   * Step 3. The grace period starts when a sweep first finds nothing holding the bytes, which is the sweep that tombstoned
   * the last row naming them, or the first after the last such row was deleted, whichever way that happened.
   */
  private async markReleased(now: Date): Promise<void> {
    await this.prisma.fileBlob.updateMany({
      where: {
        releasedAt: null,
        bytesDeletedAt: null,
        attachments: { none: { expiredAt: null } },
        driveVersionChunks: { none: {} },
        driveStagingChunks: { none: {} },
      },
      data: { releasedAt: now },
    });
    await this.prisma.fileBlob.updateMany({
      where: {
        releasedAt: { not: null },
        OR: [
          { attachments: { some: { expiredAt: null } } },
          { driveVersionChunks: { some: {} } },
          { driveStagingChunks: { some: {} } },
        ],
      },
      data: { releasedAt: null },
    });
  }

  /** Step 4: what is due, each in a transaction of its own. A store that fails costs that blob this sweep and nothing else. */
  private async deleteReleased(now: Date): Promise<{ deleted: number; failed: number }> {
    const cutoff = new Date(now.getTime() - this.grace);
    const due = await this.prisma.fileBlob.findMany({
      where: {
        bytesDeletedAt: null,
        releasedAt: { lte: cutoff },
        lastReferencedAt: { lte: cutoff },
        attachments: { none: { OR: [{ expiredAt: null }, { expiredAt: { gt: cutoff } }] } },
        driveVersionChunks: { none: {} },
        driveStagingChunks: { none: {} },
      },
      select: { sha256: true },
      take: SWEEP_BATCH,
    });
    let deleted = 0;
    let failed = 0;
    for (const { sha256 } of due) {
      try {
        if (await this.deleteBytes(sha256, now, cutoff)) deleted += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`the bytes ${sha256} stay until the next sweep: ${messageOf(error)}`);
      }
    }
    return { deleted, failed };
  }

  /**
   * One blob's bytes, asked again under its row's lock (see above: that lock is what keeps the answer true), in two statements
   * because the question has to see what committed while the lock was awaited, and one statement's snapshot is older than
   * its lock. Deleted before the row says so: a process killed between the two leaves a row whose bytes are gone, which the
   * next sweep finishes and an upload of the same content keeps again.
   */
  private deleteBytes(sha256: string, now: Date, cutoff: Date): Promise<boolean> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [blob] = await tx.$queryRaw<Array<{ storage: string }>>`
          SELECT storage FROM file_blob
           WHERE sha256 = ${sha256}
             AND bytes_deleted_at IS NULL
             AND released_at <= ${cutoff.toISOString()}::timestamp
             AND last_referenced_at <= ${cutoff.toISOString()}::timestamp
           FOR UPDATE`;
        if (!blob) return false;
        const holders = await tx.attachment.count({
          where: { sha256, OR: [{ expiredAt: null }, { expiredAt: { gt: cutoff } }] },
        });
        if (holders > 0) return false;
        if (await tx.driveVersionChunk.count({ where: { sha256 }, take: 1 })) return false;
        if (await tx.driveStagingChunk.count({ where: { sha256 }, take: 1 })) return false;
        const store = this.files.storeOf(blob.storage);
        if (!store) throw new Error(`this deployment has no ${blob.storage} store`);
        await store.remove(sha256);
        await tx.fileBlob.update({
          where: { sha256 },
          data: {
            bytesDeletedAt: now,
            // The sidecar prunes local blobs from its files copy and S3 blobs from its declared bucket mirror.
            offHostPruneAt: offHostPruneAtFor(blob.storage, this.files.config, now, this.grace),
          },
        });
        return true;
      },
      { ...loggedRetry(this.logger, 'fileRetention.deleteBytes'), transaction: { timeout: DELETE_TRANSACTION_TIMEOUT_MS } },
    );
  }
}
