import { Prisma } from '@prisma/client';

import { CRITERIA_WEAKENING_EFFECT_CLASS } from './criteria-weakening-intent';
import { stillUnanswered } from './criteria-pending-decisions';

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
 * On the project's coordinator conversation, because that conversation is the surface the decision
 * is asked on (`coordinator-delivery.service.ts`, event `CRITERIA_DECISION_PENDING`) and therefore
 * the place a person who follows the badge arrives at an answerable card. A project with no
 * coordinator bound has nowhere to send them and is not counted: a lit badge that opens nothing is
 * worse than a dark one. Same reason the conversation has to be an OPEN one — a badge is a "go here
 * now", and here cannot be a conversation the owner filed away or threw out. The question itself is
 * not lost by that: it is a derived read of the ledger (`criteria-pending-decisions.ts`), still
 * returned by the project's own page, and this only decides where the badge points.
 *
 * `criteria decision` is today's only kind. The shape is a list of counts per conversation rather
 * than one number so the next kind of owner-only decision adds a source here and changes nothing at
 * either call site.
 */
export interface OwnerDecisionSignal {
  /** The conversation to open — the project's bound coordinator. This is the whole "where". */
  sessionId: string;
  /** The project whose ruler is being decided; the coordinator's own payload names it too. */
  projectId: string;
  /** How many owner decisions are waiting there. Always ≥ 1; a zero is simply not a row. */
  count: number;
}

/**
 * The owner decisions waiting on each of this owner's coordinator conversations.
 *
 * `sessionIds` narrows it to a page of the session list; omitting it asks about every project this
 * owner has a coordinator for, which is what the per-workspace tallies need. An empty array is a
 * question with an empty answer, and is answered without touching the database.
 *
 * Three queries whatever the number of projects: the coordinators, their filed proposals, and the
 * one that says which of those were answered. The per-project read next door additionally computes
 * a seal per project in order to say whether each proposal can be DECIDED today; a count has no use
 * for that — an undecidable proposal is still a question waiting on the owner — so it is not paid
 * for here.
 */
export async function readOwnerDecisionSignals(
  tx: Prisma.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<OwnerDecisionSignal[]> {
  const sessionIds = scope?.sessionIds;
  if (sessionIds && sessionIds.length === 0) return [];
  const coordinated = await tx.project.findMany({
    where: {
      ownerId,
      coordinatorSessionId: sessionIds ? { in: [...sessionIds] } : { not: null },
      // The Open scope, spelled the way `workspaceSessionCounts` spells it, because that is the
      // scope both counting reads live in. `archivedAt` is the legacy mirror of `completedAt` and
      // is named beside it for the same reason it is named there.
      coordinatorSession: { completedAt: null, archivedAt: null, deletedAt: null },
    },
    select: { id: true, coordinatorSessionId: true },
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
  if (waiting.length === 0) return [];

  const byProject = new Map<string, number>();
  for (const row of waiting) {
    if (row.projectId == null) continue;
    byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + 1);
  }
  const signals: OwnerDecisionSignal[] = [];
  for (const project of coordinated) {
    const count = byProject.get(project.id) ?? 0;
    // The `!` the filter above already proved: a project reached by `coordinatorSessionId: in/not
    // null` has one. Spelled as a guard so the claim is checked rather than asserted.
    if (count > 0 && project.coordinatorSessionId != null) {
      signals.push({ sessionId: project.coordinatorSessionId, projectId: project.id, count });
    }
  }
  return signals;
}

/** The same answer folded to `sessionId → count`, which is what the two counting reads want. */
export async function countOwnerDecisionsBySession(
  tx: Prisma.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<Map<string, number>> {
  const signals = await readOwnerDecisionSignals(tx, ownerId, scope);
  return new Map(signals.map((signal) => [signal.sessionId, signal.count]));
}
