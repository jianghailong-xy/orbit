import { Prisma } from '@prisma/client';

import {
  criteriaFromDefinitions,
  standardSetVersion,
  type AcceptanceCriterionDefinitionLike,
} from './project-acceptance';
import { START_REQUEST_KIND } from './project-start-request';

/**
 * WHICH OF THESE PROJECTS ARE WAITING FOR THEIR OWNER TO CONFIRM THE STANDARD SET.
 *
 * The fourth thing the "needs you" count learns about (`owner-decision-signal.ts`): a project whose
 * plan is written and whose confirmation card is sitting in its coordinator conversation unanswered
 * put no signal anywhere, so the conversation's row read like an ordinary idle reply — the same
 * hole the criteria decision had before it was counted there, and the same one the file's header
 * records ("it stayed dark while a real criteria decision sat").
 *
 * IT COUNTS EXACTLY THE CARDS THE CONFIRMATION CARD DRAWS. The facts are the card's own
 * (`settlementHeldOnConfirmation`, in `AcceptanceConfirmationCard.tsx` and `ConsoleModel.swift`):
 * the project is OPEN and STARTED, it states criteria, it holds at least one task, and the set
 * standing now has not been confirmed — the "Confirm the new criteria?" card once it moved, the
 * older confirmation card for a project nobody ever confirmed. A project that has not been started
 * is asked by its start card instead, and only once its coordinator has asked
 * (`projectsReadyToStart` below): a plan with tasks and no request draws no card any more, so it
 * lights nothing. Anything else is a question with no card to answer it, and a badge that opens
 * nothing is worse than a dark one. `satisfied` is deliberately absent for the card's reason: the
 * question is not about what the criteria currently hold.
 *
 * The digest is computed here rather than read off a stored flag, for the reason `project-acceptance
 * .ts` gives for the standing itself: a confirmation counts while, and only while, it names the
 * version that stands, and an edit cannot leave a stale confirmation behind because there is nothing
 * to forget. So this is the same comparison the door's own read makes, over the same two tables,
 * with `standardSetVersion` and `criteriaFromDefinitions` — the identity of a set is computed by the
 * one function that defines it, never re-spelled here.
 */
export async function projectsAwaitingStandardSetConfirmation(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectIds: readonly string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();

  // Started ones only: an unstarted project's criteria are confirmed by the start itself, on the
  // start card, which `projectsReadyToStart` counts.
  const open = await tx.project.findMany({
    where: { id: { in: [...projectIds] }, ownerId, status: 'OPEN', startedAt: { not: null } },
    select: { id: true },
  });
  const ids = open.map((project) => project.id);
  if (ids.length === 0) return new Set();

  // Three reads whatever the number of projects, the shape `countPendingEvidenceJudgments` next
  // door uses and for the same reason: the count is per page of the session list, and a per-project
  // read would be one round trip per row of it.
  const definitions = await tx.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: { in: ids } },
    orderBy: [{ ordinal: 'asc' }],
    select: {
      id: true,
      projectId: true,
      ordinal: true,
      text: true,
      verificationMethod: true,
      completionCriterionOverrideReason: true,
      revision: true,
      contentHash: true,
    },
  });
  // The newest confirmation per project, in the door's own order: `id` is uuid(7), so it breaks a
  // tie inside one stored millisecond in the order the rows were written rather than arbitrarily —
  // the same clause `ProjectAcceptanceService.latestConfirmation` orders by, because a different tie
  // break here and there would be two answers to "which version was confirmed".
  const confirmations = await tx.projectStandardSetConfirmation.findMany({
    where: { projectId: { in: ids }, ownerId },
    orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
    select: { projectId: true, criteriaDigest: true },
  });
  // The fourth fact, off `project_task_status_count` (0282) rather than a tally of the project's
  // tasks: one row per status a project actually has, maintained by statement triggers, where the
  // relation aggregate is a pass over every task row — for this deployment's one project of 109,872
  // tasks that is the whole cost of the read (`ProjectsService.get` records the measurement).
  const withTasks = await tx.projectTaskStatusCount.findMany({
    where: { projectId: { in: ids }, count: { gt: 0 } },
    select: { projectId: true },
  });

  const stated = new Map<string, AcceptanceCriterionDefinitionLike[]>();
  for (const definition of definitions) {
    const rows = stated.get(definition.projectId) ?? [];
    rows.push(definition);
    stated.set(definition.projectId, rows);
  }
  const confirmedDigest = new Map<string, string>();
  for (const confirmation of confirmations) {
    if (!confirmedDigest.has(confirmation.projectId)) {
      confirmedDigest.set(confirmation.projectId, confirmation.criteriaDigest);
    }
  }

  const awaiting = new Set<string>();
  for (const { projectId } of withTasks) {
    const criteria = criteriaFromDefinitions(stated.get(projectId) ?? []);
    if (criteria.length === 0) continue;
    if (confirmedDigest.get(projectId) === standardSetVersion(criteria).digest) continue;
    awaiting.add(projectId);
  }
  return awaiting;
}

/**
 * WHICH OF THESE PROJECTS ARE READY TO START: not started, OPEN, and holding the request its
 * coordinator filed (`START_REQUEST`, `project_request_start`) — exactly the projects whose
 * coordinator conversation draws the "Start this project?" card. The row says so in words of its
 * own ("Ready to start", `sessionWaitingKind`), which is why these are counted apart from the
 * confirmations above rather than folded into them.
 *
 * One read. A request whose plan has since moved is still OPEN here until the next read of the
 * open items supersedes it (`supersedeStaleStartRequest`) — the read that puts the card in front of
 * the owner, so a badge that outlives its request does so only until the conversation is opened.
 */
export async function projectsReadyToStart(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectIds: readonly string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const requests = await tx.projectOpenItem.findMany({
    where: {
      ownerId,
      projectId: { in: [...projectIds] },
      kind: START_REQUEST_KIND,
      state: 'OPEN',
      project: { status: 'OPEN', startedAt: null },
    },
    select: { projectId: true },
  });
  return new Set(requests.map((request) => request.projectId));
}
