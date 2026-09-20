import { Prisma } from '@prisma/client';
import type { SessionOwnerItem } from '@orbit/shared';

import { countPendingEvidenceJudgments } from '../tasks/pending-evidence-judgments';
import { readWaitingOwnerConfirmations } from '../tasks/owner-confirmation-read';
import { CRITERIA_WEAKENING_EFFECT_CLASS } from './criteria-weakening-intent';
import { stillUnanswered } from './criteria-pending-decisions';
import { ownerItemKind } from './project-open-item';
import { projectsAwaitingStandardSetConfirmation } from './standard-set-awaiting-confirmation';

/**
 * How many decisions only the ACCOUNT OWNER can take are waiting on each of their conversations,
 * and which conversation each of them is waiting on. A SIGNAL. Never a credential.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Needs you" on the session list was `approval.count({ status: 'PENDING' })` and nothing else, so
 * it was wrong in both directions at once. It stayed dark while a real criteria decision sat
 * unanswered — because the decision door deliberately writes no `Approval` row (§3 of this
 * project's instructions: that table has no project, action or digest column, and its `input` is
 * whatever the agent's own call said, so it can witness "somebody clicked an option on a tool call"
 * and never "somebody approved action D") — and it stayed lit for eight hours on an `AskUserQuestion`
 * whose tool call had been abandoned.
 *
 * The rule that keeps the Approval table out of the decision door is about AUTHORITY, and this is
 * not authority. Counting is not granting: what a count can be wrong about is whether the badge
 * lights, and the door re-reads every fact it needs under the project lock regardless of what any
 * badge said. So the count learns about owner decisions, and the door does not learn about the
 * count.
 *
 * WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------
 * A number and an address: how many, and the conversation to open. Nothing else — and in
 * particular NOT the proposal's one-time `commitToken`, which is the decision door's second key.
 * `readPendingCriteriaDecisions` (the shape this composes) never SELECTs that column at all;
 * `readPendingCriteriaDecisionsForOwner` is the one read that does, it is on the owner's own rail,
 * and this is not it. `sessions/needs-you-owner-decision.pg.spec.ts` case (3) walks whatever this
 * returns by FIELD NAME rather than by eye — paired with the owner read, where the same scan must
 * FIND one — so the day somebody widens the select for convenience the check that says why they
 * must not is already in front of them.
 *
 * WHERE THE COUNT LANDS
 * ---------------------
 * On the project's coordinator conversation, because that conversation's page is where the decision
 * cards are drawn (`CriteriaDecisionCard.tsx` and `EvidenceDecisionCard.tsx`, each from its own
 * pending read) and therefore the place a person who follows the badge arrives at an answerable
 * card. A project with no coordinator bound has nowhere to send them and is not counted: a lit badge
 * that opens nothing is worse than a dark one. Same reason the conversation has to be an OPEN one — a
 * badge is a "go here now", and here cannot be a conversation the owner filed away or threw out. The
 * question itself is not lost by that: it is a derived read of the ledger
 * (`criteria-pending-decisions.ts`, `pending-evidence-judgments.ts`), still returned by its own
 * read, and this only decides where the badge points.
 *
 * Three kinds land there: a held criteria proposal, a task's evidence revision waiting on a CONFIRM
 * or a SEND_BACK, and a project whose standard set nobody has confirmed. The second counts exactly
 * the rows the evidence card draws — decidable, decidable FROM the coordinator, and in the
 * coordinator's own project (`countPendingEvidenceJudgments`) — because a revision the door would
 * refuse from anyone is the submitter's to refile and puts no card here. The third is the same rule
 * once more (`projectsAwaitingStandardSetConfirmation`, which is the confirmation card's own four
 * facts): the card is drawn in this conversation and nobody has answered it, so the row lights. It
 * was the hole the criteria decision had before it was counted here — a plan written, a
 * confirmation waiting, and a session list that read it as an idle reply. The shape is a list of
 * counts per conversation rather than one number so each kind adds a source here and changes
 * nothing at either call site.
 *
 * A third kind lands somewhere else, for the same reason: an OWNER_CONFIRMED task whose run is
 * waiting for its owner to confirm it done is counted on the task's OWN session, because that is
 * where its confirmation card is drawn — in any project or none. It carries its kind, so the row
 * can say "Waiting for your confirmation" instead of the word an approval gets.
 */
/**
 * Which kind of question a signal counts. `PROJECT_DECISION` is a coordinator's: a held criteria
 * proposal or an evidence revision. `OWNER_CONFIRMATION` is an OWNER_CONFIRMED task's run waiting
 * for its owner to confirm it done or send it back, counted on the task's own session.
 *
 * `OWNER_ITEM` is the third: one of the four things a project waits on its owner in person for —
 * the merge they confirm, the question their coordinator asked, the exception that became theirs,
 * the pause they lift (contract §7.6 V13). It lands on the coordinator's conversation for the same
 * reason `PROJECT_DECISION` does: that is where the card is drawn. An item still with the
 * coordinator is not counted at all — somebody is already on it, and a badge about it would be
 * telling the owner to go do work that is being done (owner decision 10).
 */
export type OwnerDecisionKind = 'PROJECT_DECISION' | 'OWNER_CONFIRMATION' | 'OWNER_ITEM';

export interface OwnerDecisionSignal {
  /** The conversation to open: the project's bound coordinator, or the waiting task's own session.
   *  This is the whole "where". */
  sessionId: string;
  /** The project whose ruler or task is being decided; null for a task filed under no project. */
  projectId: string | null;
  /** How many owner decisions are waiting there. Always ≥ 1; a zero is simply not a row. */
  count: number;
  kind: OwnerDecisionKind;
  /** The owner items themselves, oldest first — only for `OWNER_ITEM`. The count alone can say
   *  that something is waiting; the Needs-you banner has to say WHICH of the four it is and open
   *  the card, and a client cannot re-derive either from a number (§7.6 V13). */
  items?: Array<SessionOwnerItem<Date>>;
}

/**
 * The owner decisions waiting on each of this owner's conversations: their coordinators' project
 * decisions, and the task sessions an owner confirmation is waiting on (`owner-confirmation-read.ts`,
 * which counts exactly the question the confirmation card in that session is drawn for).
 *
 * `sessionIds` narrows it to a page of the session list; omitting it asks about every conversation,
 * which is what the per-workspace tallies need. An empty array is a question with an empty answer,
 * and is answered without touching the database.
 */
export async function readOwnerDecisionSignals(
  tx: Prisma.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<OwnerDecisionSignal[]> {
  const sessionIds = scope?.sessionIds;
  if (sessionIds && sessionIds.length === 0) return [];
  const confirmations = await readWaitingOwnerConfirmations(tx, ownerId, scope);
  return [
    ...(await readProjectDecisionSignals(tx, ownerId, sessionIds)),
    ...(await readOwnerItemSignals(tx, ownerId, sessionIds)),
    ...confirmations.map((waiting) => ({
      sessionId: waiting.sessionId,
      projectId: waiting.projectId,
      count: 1,
      kind: 'OWNER_CONFIRMATION' as const,
    })),
  ];
}

/**
 * The project decisions waiting on each of this owner's coordinator conversations.
 *
 * Three queries for proposals whatever the number of projects: the coordinators, their filed
 * proposals, and the one that says which of those were answered. The per-project read next door
 * additionally computes a seal per project in order to say whether each proposal can be DECIDED
 * today; a count has no use for that — an undecidable proposal is still a question waiting on the
 * owner — so it is not paid for here. Evidence is the opposite case, as the header says, so its
 * count does ask the door's two checks of each unanswered revision; those are a handful at most.
 */
async function readProjectDecisionSignals(
  tx: Prisma.TransactionClient,
  ownerId: string,
  sessionIds: readonly string[] | undefined,
): Promise<OwnerDecisionSignal[]> {
  const coordinated = await tx.project.findMany({
    where: {
      ownerId,
      coordinatorSessionId: sessionIds ? { in: [...sessionIds] } : { not: null },
      // The Open scope, spelled the way `workspaceSessionCounts` spells it, because that is the
      // scope both counting reads live in. `archivedAt` is the legacy mirror of `completedAt` and
      // is named beside it for the same reason it is named there.
      coordinatorSession: { completedAt: null, archivedAt: null, deletedAt: null },
    },
    select: { id: true, coordinatorSessionId: true, coordinatorSession: { select: { taskId: true } } },
  });
  if (coordinated.length === 0) return [];

  const filed = await tx.projectRatifiedActionIntent.findMany({
    where: {
      ownerId,
      projectId: { in: coordinated.map((project) => project.id) },
      effectClass: CRITERIA_WEAKENING_EFFECT_CLASS,
    },
    select: { id: true, projectId: true, action: true },
  });
  const waiting = await stillUnanswered(tx, filed);

  const byProject = new Map<string, number>();
  for (const row of waiting) {
    if (row.projectId == null) continue;
    byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + 1);
  }
  const evidence = await countPendingEvidenceJudgments(
    tx,
    ownerId,
    coordinated.flatMap((project) => (project.coordinatorSessionId == null ? [] : [{
      projectId: project.id,
      session: { id: project.coordinatorSessionId, taskId: project.coordinatorSession?.taskId ?? null },
    }])),
  );
  for (const [projectId, count] of evidence) {
    byProject.set(projectId, (byProject.get(projectId) ?? 0) + count);
  }
  // And the confirmation card's own question, which is open for exactly one reason and closes for
  // exactly one — the set standing now is the one somebody signed.
  const awaitingConfirmation = await projectsAwaitingStandardSetConfirmation(
    tx,
    ownerId,
    coordinated.map((project) => project.id),
  );
  for (const projectId of awaitingConfirmation) {
    byProject.set(projectId, (byProject.get(projectId) ?? 0) + 1);
  }

  const signals: OwnerDecisionSignal[] = [];
  for (const project of coordinated) {
    const count = byProject.get(project.id) ?? 0;
    // The `!` the filter above already proved: a project reached by `coordinatorSessionId: in/not
    // null` has one. Spelled as a guard so the claim is checked rather than asserted.
    if (count > 0 && project.coordinatorSessionId != null) {
      signals.push({
        sessionId: project.coordinatorSessionId,
        projectId: project.id,
        count,
        kind: 'PROJECT_DECISION',
      });
    }
  }
  return signals;
}

/**
 * The four owner items open on each of this owner's coordinator conversations (§7.6 V13).
 *
 * One query. The scope is the coordinated projects' — an item is drawn on the project's own page
 * whatever happens, and this decides only whether a badge points at a conversation, so a project
 * with no coordinator bound, or one whose conversation the owner filed away, is not counted here
 * for the same reason a held proposal is not: a lit badge that opens nothing is worse than a dark
 * one. What is counted is decided by `ownerItemKind` and nothing else, so the count, the push and
 * the chip on the project list cannot come to disagree about which items are the owner's.
 */
async function readOwnerItemSignals(
  tx: Prisma.TransactionClient,
  ownerId: string,
  sessionIds: readonly string[] | undefined,
): Promise<OwnerDecisionSignal[]> {
  const rows = await tx.projectOpenItem.findMany({
    where: {
      ownerId,
      state: 'OPEN',
      assignee: 'OWNER',
      project: {
        coordinatorEnabled: true,
        coordinatorSessionId: sessionIds ? { in: [...sessionIds] } : { not: null },
        coordinatorSession: { completedAt: null, archivedAt: null, deletedAt: null },
      },
    },
    // Oldest first: the banner shows the one that has waited longest, and a stable order is what
    // keeps two reads of the same set from pointing at different cards.
    orderBy: { waitingSince: 'asc' },
    select: {
      id: true,
      kind: true,
      assignee: true,
      assigneeReason: true,
      title: true,
      waitingSince: true,
      projectId: true,
      project: { select: { coordinatorSessionId: true } },
    },
  });

  const bySession = new Map<string, OwnerDecisionSignal>();
  for (const row of rows) {
    const kind = ownerItemKind(row);
    const sessionId = row.project.coordinatorSessionId;
    if (kind === null || sessionId == null) continue;
    const signal = bySession.get(sessionId) ?? {
      sessionId,
      projectId: row.projectId,
      count: 0,
      kind: 'OWNER_ITEM' as const,
      items: [],
    };
    signal.count += 1;
    signal.items?.push({ itemId: row.id, kind, title: row.title, since: row.waitingSince });
    bySession.set(sessionId, signal);
  }
  return [...bySession.values()];
}

/**
 * The coordinator conversations carrying one of the four owner items, for the caller that needs the
 * conversations and not the items: `PushService.needsYouSessions` counts them on the APNs badge, so
 * the number a locked phone shows is the same one the session list, the menu bar and the banner
 * derive (§7.6 V13). Same query, same predicate as the signals above — `ownerItemKind` is the one
 * spelling of "this item is the owner's", so the badge cannot come to disagree with the card.
 */
export async function readOwnerItemSessionIds(
  tx: Prisma.TransactionClient,
  ownerId: string,
): Promise<string[]> {
  const signals = await readOwnerItemSignals(tx, ownerId, undefined);
  return signals.map((signal) => signal.sessionId);
}

/** What is waiting on the owner on one conversation: how many, of which kinds, and — for the four
 *  owner items — which ones, so the banner above a session list can name and open them. */
export interface OwnerDecisionsOnSession {
  count: number;
  kinds: ReadonlySet<OwnerDecisionKind>;
  ownerItems: Array<SessionOwnerItem<Date>>;
}

/** The same answer folded per conversation, which is what a session row wants. */
export async function readOwnerDecisionsBySession(
  tx: Prisma.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<Map<string, OwnerDecisionsOnSession>> {
  const folded = new Map<string, {
    count: number;
    kinds: Set<OwnerDecisionKind>;
    ownerItems: Array<SessionOwnerItem<Date>>;
  }>();
  for (const signal of await readOwnerDecisionSignals(tx, ownerId, scope)) {
    const entry = folded.get(signal.sessionId)
      ?? { count: 0, kinds: new Set<OwnerDecisionKind>(), ownerItems: [] };
    entry.count += signal.count;
    entry.kinds.add(signal.kind);
    entry.ownerItems.push(...(signal.items ?? []));
    folded.set(signal.sessionId, entry);
  }
  return folded;
}

/** The same answer folded to `sessionId → count`, which is what the counting reads want. */
export async function countOwnerDecisionsBySession(
  tx: Prisma.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<Map<string, number>> {
  const folded = await readOwnerDecisionsBySession(tx, ownerId, scope);
  return new Map([...folded].map(([sessionId, entry]) => [sessionId, entry.count]));
}

/**
 * The owner items on a row, with their instants in the wire's own format (§7.6 V13).
 *
 * Always an array, never absent: the clients fold a session summary into a row they already hold,
 * where an absent key means "unchanged" — so an item the owner just answered has to arrive as an
 * empty list, or the banner above their session list would keep pointing at a card that is gone.
 */
export function ownerItemsForRow(
  decisions: OwnerDecisionsOnSession | undefined,
): Array<SessionOwnerItem> {
  return (decisions?.ownerItems ?? []).map((item) => ({
    itemId: item.itemId,
    kind: item.kind,
    title: item.title,
    since: item.since.toISOString(),
  }));
}

/** The one waiting kind a session row names in words of its own. */
export type SessionWaitingKind = 'OWNER_CONFIRMATION';

/**
 * What a session row's `pendingApprovals` is counting, when one word says it better than
 * "approval": `OWNER_CONFIRMATION` when everything counted is an owner confirmation, so the row can
 * say "Waiting for your confirmation". Null otherwise — including when a tool call is blocked on the
 * same row, which is holding a turn open and is the more urgent thing to say.
 */
export function sessionWaitingKind(
  approvals: number,
  decisions: OwnerDecisionsOnSession | undefined,
): SessionWaitingKind | null {
  if (approvals > 0 || !decisions || decisions.count === 0) return null;
  for (const kind of decisions.kinds) {
    if (kind !== 'OWNER_CONFIRMATION') return null;
  }
  return 'OWNER_CONFIRMATION';
}
