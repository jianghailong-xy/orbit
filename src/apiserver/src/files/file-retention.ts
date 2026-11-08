import type { Prisma } from '@prisma/client';
import { citedFileIds, storedEvidenceEnvelope } from '../tasks/task-evidence-envelope';
import type { FilesConfig } from './file-store';

/**
 * How long a file an agent keeps with `file_upload` lasts (docs/orbit-files-design.md §2.8, decided 2026-11-02):
 *
 *   uploaded, and no evidence cites it                 14 days after the upload
 *   cited by the newest version, undecided             does not expire
 *   cited by a version that was sent back              30 days after the send-back
 *   cited by a version a newer one replaced            30 days after the newer one arrived
 *   cited by a confirmed version                       does not expire while the task exists
 *   its task deleted                                   then, or 14 days after the upload if that is later
 *   pinned                                             does not expire
 *
 * Where several apply, the latest wins. A file's folder counts as the file: a citation of a folder bundle holds its manifest
 * and every file in it. A confirmed version keeps holding its files after a later version replaces it, because a decision
 * was made on those exact bytes.
 *
 * `attachment.expires_at` holds the answer, NULL while evidence holds the row. `retention` is what says a row can expire at
 * all: only `file_upload` writes it, so a reply's image, a person's upload and a task's input never get a date.
 * `pinned_at` lies over the date without changing it (file-retention-sweep.ts tombstones no pinned row), so taking a pin
 * away needs no working out.
 *
 * What expiry does is the sweep's: a tombstone first, the bytes one grace period later, and never the row.
 */

/**
 * `attachment.retention` of a row `file_upload` wrote: an upload that expires unless evidence references it. A reply's image
 * and a person's upload come through doors of their own and stay NULL, which follows their session or task; this is what
 * tells the retention rules the two apart.
 */
export const FILE_UPLOAD_RETENTION = 'file_upload';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An upload no evidence cites. */
export const UPLOAD_RETENTION_MS = 14 * DAY_MS;

/** The files of a version that was sent back or replaced. */
export const LET_GO_RETENTION_MS = 30 * DAY_MS;

/** The shortest time between a tombstone and the bytes going (§6 item 3). */
export const MIN_GRACE_MS = 7 * DAY_MS;

/**
 * How long a file's bytes outlast its tombstone, and how long the off-host copy outlasts them: seven days, and never less
 * than a retained Postgres backup reaches back, so that restoring any of those backups finds every byte its rows name.
 */
export function fileGraceMs(config: Pick<FilesConfig, 'backupRetentionMs'>): number {
  return Math.max(MIN_GRACE_MS, config.backupRetentionMs ?? 0);
}

/**
 * The rows that keep their session in Trash past its 30 days, because a row goes with its session and its bytes follow: one
 * somebody pinned, of any kind, and an agent's file evidence cites that has no tombstone yet. A date does not let the session
 * go: the time left on it is the file's own, the 30 days a version gives what it let go of. A tombstone does, and the next
 * purge takes the row while evidence still cites it, leaving that evidence the sha256 it recorded. A row whose task was
 * deleted still names the version that went with it, so it holds its session until the sweep has dated and tombstoned it.
 */
export const KEEPS_SESSION_IN_TRASH: Prisma.AttachmentWhereInput = {
  OR: [
    { pinnedAt: { not: null } },
    { retention: FILE_UPLOAD_RETENTION, expiredAt: null, evidenceId: { not: null } },
  ],
};

/** What a session's Trash note says is holding it (`trashHoldOf`). */
export type TrashHold = 'PINNED_FILE' | 'CITED_FILE';

/**
 * Why the hourly purge is leaving this session in Trash, or null when nothing is, read with the purge's own rule so the two
 * cannot disagree. A session holding both says the pin: a pin ends only when somebody takes it away, and a citation can end
 * by itself, so the pin is what the reader can act on.
 */
export async function trashHoldOf(
  db: Pick<Prisma.TransactionClient, 'attachment'>,
  sessionId: string,
): Promise<TrashHold | null> {
  const held = await db.attachment.findFirst({
    where: { sessionId, ...KEEPS_SESSION_IN_TRASH },
    orderBy: { pinnedAt: { sort: 'desc', nulls: 'last' } },
    select: { pinnedAt: true },
  });
  if (!held) return null;
  return held.pinnedAt ? 'PINNED_FILE' : 'CITED_FILE';
}

/** The date an upload starts with, for the rows `file_upload` writes. */
export function uploadExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UPLOAD_RETENTION_MS);
}

/**
 * When a version of evidence stopped holding its files, or null while it still does. `next` is the version after it, when
 * there is one. A version answered once: only the newest can be answered, so a sent-back version is answered before any
 * later one replaces it.
 */
export function evidenceLetGoAt(
  decision: { decision: string; decidedAt: Date } | undefined,
  next: { submittedAt: Date } | undefined,
): Date | null {
  if (decision?.decision === 'CONFIRM') return null;
  if (decision?.decision === 'SEND_BACK') return decision.decidedAt;
  return next?.submittedAt ?? null;
}

/**
 * The date of a file an agent kept, from when each version citing it let go of it (null: holds it still). Null means evidence
 * holds it, and no version citing it means the 14 days it started with.
 */
export function citedFileExpiry(createdAt: Date, letGoAt: ReadonlyArray<Date | null>): Date | null {
  let latest = uploadExpiry(createdAt).getTime();
  for (const at of letGoAt) {
    if (at === null) return null;
    latest = Math.max(latest, at.getTime() + LET_GO_RETENTION_MS);
  }
  return new Date(latest);
}

/**
 * Work out again the date of every file this task's evidence cites, after a version arrived or was answered. It reads the
 * task's versions and their decisions as they stand, so it says the same however often it runs. The caller holds the task's
 * row, the lock `TaskCompletionEvidenceService` allocates a version and writes a decision under, so no version or decision
 * of this task can move while this reads them. A row with a tombstone keeps it: only a pin takes one away (`setPinned`).
 */
export async function settleCitedFileExpiry(
  tx: Prisma.TransactionClient,
  scope: { ownerId: string; taskId: string },
): Promise<void> {
  const { ownerId, taskId } = scope;
  const versions = await tx.taskCompletionEvidence.findMany({
    where: { taskId, ownerId },
    orderBy: { revision: 'asc' },
    select: {
      id: true,
      evidence: true,
      submittedAt: true,
      decisions: { take: 1, select: { decision: true, decidedAt: true } },
    },
  });
  if (versions.length === 0) return;
  // `evidence_id` names the newest version citing a row, and every version citing it belongs to this same task.
  const rows = await tx.attachment.findMany({
    where: { ownerId, retention: FILE_UPLOAD_RETENTION, expiredAt: null, evidenceId: { in: versions.map((version) => version.id) } },
    select: { id: true, createdAt: true, expiresAt: true, fileBundleId: true },
  });
  if (rows.length === 0) return;
  const fates = versions.map((version, index) => ({
    cited: new Set(citedFileIds(storedEvidenceEnvelope(version.evidence)?.checks ?? [])),
    letGoAt: evidenceLetGoAt(version.decisions[0], versions[index + 1]),
  }));
  const byDate = new Map<string, { expiresAt: Date | null; ids: string[] }>();
  for (const row of rows) {
    const citing = fates.filter(({ cited }) => cited.has(row.id) || (row.fileBundleId !== null && cited.has(row.fileBundleId)));
    const expiresAt = citedFileExpiry(row.createdAt, citing.map(({ letGoAt }) => letGoAt));
    if (expiresAt?.getTime() === row.expiresAt?.getTime()) continue;
    const key = expiresAt?.toISOString() ?? '';
    const group = byDate.get(key) ?? { expiresAt, ids: [] };
    group.ids.push(row.id);
    byDate.set(key, group);
  }
  for (const { expiresAt, ids } of byDate.values()) {
    await tx.attachment.updateMany({ where: { id: { in: ids }, expiredAt: null }, data: { expiresAt } });
  }
}
