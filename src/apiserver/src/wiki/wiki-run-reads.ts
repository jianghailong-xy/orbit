import { Injectable, NotFoundException } from '@nestjs/common';
import type { WikiChangesetCounts, WikiReviewMode, WikiRevertPlan } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHANGESET_SELECT,
  ENTRY_SELECT,
  changesetView,
  entryView,
  verificationView,
  WikiRefusalError,
  type ChangesetRow,
  type EntryRow,
} from './wiki.service';

/**
 * The reads that let the owner take back ANY run, not only one with something still waiting in Review
 * (criterion 8; contract `reviewModes.run`): one changeset by its id, counted, with what Revert run…
 * would undo now — and, for an entry's page, where its current revision came from.
 *
 * THE GAP THEY CLOSE. Review lists a changeset only while an op of it waits for the owner, and the
 * timeline lists ops, not the changesets they came in. So the clients could only tie an op to its run
 * — fold it into one row, open its page, revert it — while the run still had a card in Review, and an
 * Automatic run, which draws no spot check by default, left nothing there to open once its verdicts
 * applied it. A run that nobody could open was a run nobody could take back.
 *
 * READS ONLY, and every one of them the owner's: another account's changeset or entry is the plain 404
 * every tenancy check answers, and the run read refuses a request that carries a session header
 * (WIKI_OWNER_CHANNEL_ONLY) the way the revert it leads to does. They write nothing, so nothing here is
 * in the write inventory.
 */
@Injectable()
export class WikiRunReads {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /api/wiki/changesets/:id` (contract `reviewModes.run.read`): the changeset as Review would
   * show it, with the entries its ops name as they stand now, what it did counted, and whether a revert
   * would take anything back — worked out by the same rules `WikiService.revertChangeset` applies, so
   * the page offers Revert run… exactly when the revert would do something.
   */
  async changeset(ownerId: string, changesetId: string, actingSessionId: string | null): Promise<Record<string, unknown>> {
    if (actingSessionId) {
      throw new WikiRefusalError({
        code: 'WIKI_OWNER_CHANNEL_ONLY',
        message:
          'a run\'s page is the account owner\'s, read through an owner channel with no acting session: what a run '
            + 'applied is what wiki_search and wiki_get return, and taking it back is the owner\'s.',
      });
    }
    const row = await this.prisma.wikiChangeset.findFirst({ where: { id: changesetId, ownerId }, select: CHANGESET_SELECT });
    if (!row) throw new NotFoundException('no such changeset');
    const named = [...new Set(row.ops.flatMap((op) => [op.entryId, op.resultEntryId]).filter((id): id is string => id !== null))];
    const entries = named.length === 0
      ? []
      : await this.prisma.wikiEntry.findMany({ where: { ownerId, id: { in: named } }, orderBy: { id: 'asc' }, select: ENTRY_SELECT });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    // A run reverted once answers every later revert with the first (idempotency key `revert:<id>`):
    // nothing more can be taken back, whatever its entries have done since.
    const reverted = await this.prisma.wikiChangeset.findFirst({
      where: { ownerId, idempotencyKey: `revert:${row.id}` },
      select: { id: true },
    });
    const plan = reverted ? { adds: 0, amends: 0 } : revertPlan(row.ops, byId);
    const revertible = plan.adds + plan.amends > 0;
    return {
      ...changesetView(row),
      appliedByMode: runMode(row.ops),
      entries: entries.map(entryView),
      counts: runCounts(row.ops, byId),
      revertible,
      revert: revertible ? plan : null,
    };
  }
}

/**
 * Where an entry's current revision came from (contract `reviewModes.run.entry`): the changeset whose
 * op wrote it, the review mode that applied that op, and the verdict it was applied on. What the mark
 * bar under an entry's head says second — `Checked by <model>: <verdict>` — for every entry, not only
 * one whose op still waits in Review as a spot check.
 *
 * Read through the revision's `changeset_op_id`, a history snapshot with no foreign key: a revision no
 * op wrote (the owner's Confirm writes its own) answers null for all three.
 */
export async function entryAppliedBy(
  prisma: Pick<PrismaService, 'wikiEntryRevision' | 'wikiChangesetOp'>,
  ownerId: string,
  entry: Pick<EntryRow, 'id' | 'currentRevision'>,
): Promise<{ changesetId: string | null; appliedByMode: string | null; verification: Record<string, unknown> | null }> {
  const revision = await prisma.wikiEntryRevision.findFirst({
    where: { entryId: entry.id, ownerId, revision: entry.currentRevision },
    select: { changesetOpId: true },
  });
  const op = revision?.changesetOpId
    ? await prisma.wikiChangesetOp.findFirst({
        where: { id: revision.changesetOpId, ownerId },
        select: {
          changesetId: true,
          appliedByMode: true,
          verificationVerdict: true,
          verificationReason: true,
          verificationModel: true,
          verifiedAt: true,
          verificationDuplicateOf: true,
          verificationEvidence: true,
        },
      })
    : null;
  return {
    changesetId: op?.changesetId ?? null,
    appliedByMode: op?.appliedByMode ?? null,
    verification: op ? verificationView(op) : null,
  };
}

type RunOp = ChangesetRow['ops'][number];

/** The review mode that applied any op of a run — a verdict's `automatic` over `tiered` — or null. */
export function runMode(ops: readonly Pick<RunOp, 'appliedByMode'>[]): Exclude<WikiReviewMode, 'manual'> | null {
  if (ops.some((op) => op.appliedByMode === 'automatic')) return 'automatic';
  if (ops.some((op) => op.appliedByMode === 'tiered')) return 'tiered';
  return null;
}

/** Whether an op's effect stands from its changeset itself: its mode applied it, or it needed nobody. */
function opApplied(op: Pick<RunOp, 'decision' | 'appliedByMode' | 'spotCheck'>): boolean {
  if (op.decision === 'auto_applied') return true;
  if (op.appliedByMode === null) return false;
  return (op.decision === 'pending' && op.spotCheck) || op.decision === 'accepted' || op.decision === 'edited';
}

/**
 * What a run did, counted (contract `reviewModes.run.counts`). An applied add or amend counts toward
 * Auto or Unreviewed by its entry as it stands NOW — active, still at the revision the op wrote, with
 * that trust — so a run whose entries the owner has since confirmed, rejected, edited or reverted
 * stops claiming marks it no longer put there.
 */
export function runCounts(
  ops: readonly RunOp[],
  entries: ReadonlyMap<string, Pick<EntryRow, 'status' | 'trust' | 'currentRevision'>>,
): WikiChangesetCounts {
  const counts: WikiChangesetCounts = { applied: 0, auto: 0, unreviewed: 0, rejectedByCheck: 0, toReview: 0 };
  for (const op of ops) {
    if (op.decision === 'pending') counts.toReview += 1;
    if (op.decision === 'rejected' && (op.verificationVerdict === 'unsupported' || op.verificationVerdict === 'duplicate')) {
      counts.rejectedByCheck += 1;
    }
    if (!opApplied(op)) continue;
    counts.applied += 1;
    if (op.op !== 'add' && op.op !== 'amend') continue;
    const entry = entries.get((op.op === 'add' ? (op.resultEntryId ?? op.entryId) : op.entryId) ?? '');
    if (entry?.status !== 'active' || entry.currentRevision !== (op.resultRevision ?? entry.currentRevision)) continue;
    if (entry.trust === 'auto') counts.auto += 1;
    if (entry.trust === 'unreviewed') counts.unreviewed += 1;
  }
  return counts;
}

/**
 * What `WikiService.revertChangeset` would undo if it ran now (contract `reviewModes.revert`), by its
 * own rules: of the ops the mode applied that nobody has answered, each add whose entry is still active
 * is withdrawn, and each entry an amend changed goes back — unless it left active, or changed again
 * after the run's last amend of it. What it skips is not counted, so the Revert dialog's numbers are
 * the revert's.
 */
export function revertPlan(
  ops: readonly RunOp[],
  entries: ReadonlyMap<string, Pick<EntryRow, 'status' | 'currentRevision'>>,
): WikiRevertPlan {
  const undone = ops.filter(
    (op) => op.appliedByMode !== null && (op.decision === 'auto_applied' || (op.decision === 'pending' && op.spotCheck)),
  );
  let adds = 0;
  for (const op of undone) {
    if (op.op === 'add' && op.resultEntryId && entries.get(op.resultEntryId)?.status === 'active') adds += 1;
  }
  const lastAmend = new Map<string, number>();
  for (const op of undone) {
    if (op.op !== 'amend' || !op.entryId) continue;
    lastAmend.set(op.entryId, Math.max(lastAmend.get(op.entryId) ?? 0, op.resultRevision ?? 0));
  }
  let amends = 0;
  for (const [entryId, to] of lastAmend) {
    const entry = entries.get(entryId);
    if (entry?.status === 'active' && entry.currentRevision === to) amends += 1;
  }
  return { adds, amends };
}
