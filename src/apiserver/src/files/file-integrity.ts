import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';
import { messageOf, type FileStorage } from './file-store';
import { fileGraceMs } from './file-retention';
import { FilesService } from './files.service';

/** How often the timer looks at the clock. The scrub itself runs once a week, in a fixed slot. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most recent weekly scrub slot at or before `now`: Sunday 03:00 UTC (docs/drive-technical-design.md §10.3
 * item 5). Computed from the clock alone, so a restart neither causes a scrub nor delays one.
 */
export function scrubSlotAtOrBefore(now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let slot = midnight - now.getUTCDay() * DAY_MS + 3 * 60 * 60 * 1000;
  if (slot > now.getTime()) slot -= 7 * DAY_MS;
  return new Date(slot);
}
const STORAGES: readonly FileStorage[] = ['local', 's3'];

/** What `files orphans` found in one store. */
export interface OrphanReport {
  storage: FileStorage;
  /** Objects listed in the store. */
  scanned: number;
  /** Objects no `file_blob` row names that are older than the grace period: the ones that may go. */
  orphans: number;
  orphanBytes: number;
  /** Objects no row names that are younger than the grace period: left alone, because a restore to a newer point could name them. */
  withinGrace: number;
  /** Sha256 of up to the first 100 orphans. */
  sample: string[];
  /** Orphans removed; always 0 unless `remove` was asked for. */
  removed: number;
  removedBytes: number;
}

/** A blob `files verify` found wrong. */
export interface VerifyProblem {
  sha256: string;
  storage: string;
  problem: 'missing' | 'mismatch';
  /** Drive versions whose chunks include it. */
  driveVersions: number;
  /** Attachment rows that name it. */
  attachments: number;
}

export interface VerifyReport {
  checked: number;
  /** Blobs whose bytes were read back and hashed (`deep`). */
  hashed: number;
  problems: VerifyProblem[];
}

/**
 * `files orphans`, `files verify` and the weekly scrub (docs/drive-technical-design.md §10.3, §2.4). The retention
 * sweep works from `file_blob` rows only, so an object a restored database no longer names is invisible to it; and it trusts
 * that the bytes a row names are in the store, which a lost disk or bucket makes untrue.
 */
@Injectable()
export class FileIntegrity implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('FileIntegrity');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {}

  /** The slot the last scrub answered, or the one in force at boot: a boot after a slot has passed does not owe it. */
  private doneSlot = 0;

  onApplicationBootstrap(): void {
    this.doneSlot = scrubSlotAtOrBefore(new Date()).getTime();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** The timer's check, as of `now`: scrubs once when a slot has come that no scrub has answered. Returns whether it started one. */
  tick(now: Date = new Date()): boolean {
    if (this.leader && !this.leader.leads()) return false;
    if (this.running) return false;
    const slot = scrubSlotAtOrBefore(now).getTime();
    if (slot <= this.doneSlot) return false;
    this.doneSlot = slot;
    this.running = this.scrub(now)
      .catch((error) => this.logger.error(`the scrub stopped and runs again next week: ${messageOf(error)}`))
      .finally(() => {
        this.running = undefined;
      });
    return true;
  }

  /** The running scrub, for a spec to wait on. */
  settled(): Promise<unknown> {
    return this.running ?? Promise.resolve();
  }

  /** Verify stored bytes and report orphans on the weekly schedule. Both checks are read-only. */
  async scrub(now: Date = new Date()): Promise<VerifyReport> {
    const report = await this.verify();
    for (const p of report.problems) {
      this.logger.warn(
        `scrub: ${p.problem} ${p.sha256} (${p.storage}): ${p.driveVersions} drive version(s), ${p.attachments} attachment(s)`,
      );
    }
    this.logger.log(
      `scrub verify: checked ${report.checked}, read back ${report.hashed}, problems ${report.problems.length}; report only`,
    );
    for (const r of await this.orphans({ now })) {
      this.logger.log(
        `scrub (${r.storage}): ${r.scanned} object(s), ${r.orphans} orphan(s) older than the grace period (${r.orphanBytes} bytes), `
          + `${r.withinGrace} younger; nothing removed`,
      );
    }
    return report;
  }

  /**
   * Objects in each store that no `file_blob` row names. Only those older than the grace period count as orphans. With
   * `remove`, those go; without it nothing is written or deleted. A row naming an object makes it no orphan, whether or not
   * the row says its bytes are deleted: that is the sweep's case.
   */
  async orphans(options: { now?: Date; remove?: boolean } = {}): Promise<OrphanReport[]> {
    const now = options.now ?? new Date();
    const cutoff = now.getTime() - fileGraceMs(this.files.config);
    const reports: OrphanReport[] = [];
    for (const storage of STORAGES) {
      const store = this.files.storeOf(storage);
      if (!store) continue;
      const report: OrphanReport = { storage, scanned: 0, orphans: 0, orphanBytes: 0, withinGrace: 0, sample: [], removed: 0, removedBytes: 0 };
      let page: Array<{ sha256: string; sizeBytes: number; modifiedAt: Date }> = [];
      const flush = async () => {
        const named = new Set(
          (await this.prisma.fileBlob.findMany({ where: { sha256: { in: page.map((o) => o.sha256) } }, select: { sha256: true } })).map((b) => b.sha256),
        );
        for (const object of page) {
          if (named.has(object.sha256)) continue;
          if (object.modifiedAt.getTime() > cutoff) {
            report.withinGrace += 1;
            continue;
          }
          report.orphans += 1;
          report.orphanBytes += object.sizeBytes;
          if (report.sample.length < 100) report.sample.push(object.sha256);
          if (options.remove) {
            // Asked again just before the delete: a row that appeared since names it after all.
            if (await this.prisma.fileBlob.findUnique({ where: { sha256: object.sha256 }, select: { sha256: true } })) continue;
            await store.remove(object.sha256);
            report.removed += 1;
            report.removedBytes += object.sizeBytes;
          }
        }
        page = [];
      };
      for await (const object of store.list()) {
        report.scanned += 1;
        page.push(object);
        if (page.length >= 500) await flush();
      }
      if (page.length > 0) await flush();
      reports.push(report);
    }
    return reports;
  }

  /**
   * Every blob whose bytes should be in a store (`bytes_deleted_at` unset): is it there, and, with `deep` (the default), do
   * the bytes read back hash to the sha256 that names them. Drive chunks are blobs, so this covers them; `driveVersions` says
   * how many drive versions each problem breaks.
   */
  async verify(options: { deep?: boolean } = {}): Promise<VerifyReport> {
    const deep = options.deep ?? true;
    const report: VerifyReport = { checked: 0, hashed: 0, problems: [] };
    let after = '';
    for (;;) {
      const blobs = await this.prisma.fileBlob.findMany({
        where: { bytesDeletedAt: null, sha256: { gt: after } },
        orderBy: { sha256: 'asc' },
        take: 500,
        select: { sha256: true, storage: true },
      });
      if (blobs.length === 0) return report;
      for (const { sha256, storage } of blobs) {
        report.checked += 1;
        const store = this.files.storeOf(storage);
        let problem: VerifyProblem['problem'] | null = null;
        if (!store) problem = 'missing';
        else if (deep) {
          const content = await store.open(sha256);
          if (!content) problem = 'missing';
          else {
            const hash = createHash('sha256');
            for await (const chunk of content) hash.update(chunk as Buffer);
            report.hashed += 1;
            if (hash.digest('hex') !== sha256) problem = 'mismatch';
          }
        } else if (!(await store.has(sha256))) problem = 'missing';
        if (!problem) continue;
        report.problems.push({
          sha256,
          storage,
          problem,
          driveVersions: (await this.prisma.driveVersionChunk.findMany({ where: { sha256 }, distinct: ['versionId'], select: { versionId: true } })).length,
          attachments: await this.prisma.attachment.count({ where: { sha256 } }),
        });
      }
      after = blobs[blobs.length - 1]!.sha256;
    }
  }
}
