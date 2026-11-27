import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectOpenItemService } from '../projects/project-open-item.service';
import type { ProjectPromotionService } from '../projects/project-promotion.service';
import type { PushService } from '../push/push.service';
import type { MergeReceiptService } from '../sessions/merge-receipt.service';
import { followWikiDocsAfterReceipts } from '../wiki/wiki-docs-follow';
import type { IntegrationResultAftermath } from './integration-job-relay';

/** What delivers a committed job result's consequences. Each is optional, as it is on the doors that hold them. */
export interface IntegrationAftermathDoors {
  prisma: PrismaService;
  logger: Pick<Logger, 'warn'>;
  promotions?: Pick<ProjectPromotionService, 'considerCandidate'>;
  mergeReceipts?: Pick<MergeReceiptService, 'deliverProjectFactsAfterCommit'>;
  openItems?: Pick<ProjectOpenItemService, 'deliverForItems'>;
  push?: Pick<PushService, 'notifyOwnerItem'>;
}

/**
 * What follows a committed job result, whichever door wrote it: a runner's result route, a release that ended a job
 * (J-T12), or the pull request door landing a job GitHub merged (docs/design/protected-branch-landing.md §4.2 J-T15).
 * Every step announces rows that are already committed, so a failure is logged and never raised, and each is
 * re-derivable by the next receipt or the 60-second sweep if the process dies first.
 */
export async function deliverIntegrationAftermath(
  doors: IntegrationAftermathDoors,
  after: IntegrationResultAftermath | null,
  openItemId: string | null,
): Promise<void> {
  if (!after) return;
  if (after.considerPromotionProjectId) {
    // M-F1 / M-F4, after the commit and from the committed rows: "the queue is empty" is only
    // true of rows that landed, and this job's own is one of them. The service logs and swallows
    // its own failures — a candidate not made now is made by the next landing.
    //
    // BEFORE the facts below, and that order is the closing guardrail's (D5): the merge into
    // the upstream this queues is work still in flight, and a settled project whose last
    // landing has just finished must be read with it queued. Read a moment earlier, the project
    // looks finished while its work is about to go to the upstream — the gap a judgment once
    // filed a needless "merge into main" task in (`project-looks-finished.ts`).
    await doors.promotions?.considerCandidate(after.considerPromotionProjectId);
  }
  // J10: the receipt is the fact the tasks downstream were waiting for, and the item is what
  // somebody has to look at. Both are announcements of rows that are already committed, so a
  // failure here is logged and never raised — the result was taken either way.
  await doors.mergeReceipts
    ?.deliverProjectFactsAfterCommit(after.projectId, after.landedTaskIds ?? after.landedTaskId, {
      observed: after.observed === true,
      // §7.6 V12: a LANDED_WITHOUT_CONFIRMATION this result opened — O-R3 of an observation, the
      // deploy-time pass's one item per project, or a check that saw the work on main (O-L6).
      ownerItemIds: after.ownerItemIds,
    })
    .catch((error) => doors.logger.warn(`integration landing facts not delivered: ${(error as Error)?.message}`));
  // A landing into main — a task's on a MAIN line, or a project's promotion — is a fact the wiki follows (contract
  // `docs.follow.triggers.landing`): the receipts the result wrote, after the commit, logged and never raised.
  if ((after.receiptIds?.length ?? 0) > 0) await followWikiDocsAfterReceipts(doors.prisma, after.receiptIds ?? []);
  if (after.openItemIds.length > 0) {
    await doors.openItems?.deliverForItems(after.openItemIds)
      .catch((error) => doors.logger.warn(`integration exception item not delivered: ${(error as Error)?.message}`));
  }
  // §7.6 V12 / criterion 13: the merge approval this result may have opened is one of the four
  // things only the account owner can answer, so their devices are told. Handed the item id
  // rather than a decision: which items reach a phone is `notifyOwnerItem`'s to decide, and the
  // exception items opened above — still the coordinator's — answer null there and send nothing.
  if (openItemId) {
    void doors.push?.notifyOwnerItem(openItemId);
  }
}
