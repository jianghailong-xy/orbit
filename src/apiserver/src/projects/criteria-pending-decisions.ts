import { Prisma } from '@prisma/client';

import {
  CRITERIA_WEAKENING_EFFECT_CLASS,
  type CriteriaWeakeningAction,
  type ProposedCriterion,
} from './criteria-weakening-intent';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';

/**
 * Which loosening proposals an account owner is being asked to decide, derived from the ledger
 * every time it is asked.
 *
 * A DERIVED READ, NOT A QUEUE
 * ---------------------------
 * `pending-evidence-judgments.ts` is the shape this copies, and copies for its reasons. There is no
 * row anywhere that says "this proposal is pending": `project_ratified_action_intent` has no status
 * column, and could not have one — a BEFORE UPDATE OR DELETE trigger (0195) refuses every write to
 * a filed row, which is the point, since the party proposing a looser ruler is the party that must
 * not be able to edit the proposal after it is read. So pending is a shape the committed rows
 * already have: a weakening intent of this project that no later proposal displaced and that
 * nothing has settled. Every one of those is a row somebody else wrote for their own reasons, so
 * this read cannot fall out of date with them, cannot be delivered twice, and cannot be lost.
 * Closing the conversation that was reading it changes none of them.
 *
 * THIS READ IS THE FLOOR UNDER THE COORDINATOR CARD
 * -------------------------------------------------
 * The primary surface for this question is a message in the project's coordinator conversation
 * (`coordinator-delivery.service.ts`, event `CRITERIA_DECISION_PENDING`). A card can be delivered
 * and never answered — the person is asleep, the engine abandons the tool call, the turn is
 * reclaimed — and none of those writes anything: the intent row stays unsettled, and the wake that
 * carried it is DELIVERED and goes on holding its idempotency key, so no second delivery is coming.
 * There is no retry clock on this path and deliberately so; the whole of that argument is
 * `coordinator-delivery.service.ts` §1.4, and it applies here word for word.
 *
 * Because pending is a shape the rows already have, the question an unanswered card left behind is
 * still here on the next read, and the answer written from here reaches the same door the card's
 * answer would have. That is the entire reason this read exists beside the card rather than instead
 * of it.
 *
 * WHY EACH ROW CARRIES A REASON RATHER THAN A FLAG
 * ------------------------------------------------
 * Same shape `criterionSatisfaction` and the evidence queue settled on: a reader who is told only
 * "no" cannot act. So a row that cannot be decided today still comes back, carrying the refusal the
 * decision door would give and the action that would clear it. What a reader must never be shown is
 * a card whose only lit button is refused every time it is pressed.
 *
 * NOTHING HERE GATES ANYTHING. It writes nothing and no status is derived from it.
 */

/**
 * The two refusals a decision on a pending proposal can meet, in the door's spelling.
 *
 * Stated HERE, in the read, and not in the door — because the read is what exists first and the
 * door (`criteria-decision-door.pg.spec.ts`, a sibling task) is to import these rather than spell
 * its own. One rule, one spelling: a queue that promises a decision the door refuses, or refuses
 * one the door would take, is the drift both of them exist to keep out.
 */
export const CRITERIA_DECISION_BASE_SEAL_MOVED = 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED';
export const CRITERIA_DECISION_ALREADY_SETTLED = 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED';

/** What clears a proposal whose baseline is no longer the ruler in force. */
export const CRITERIA_DECISION_REFILE_ACTION = 'REFILE_AGAINST_THE_CURRENT_STANDARD_SET';

/**
 * Whether a decision could be recorded about this proposal right now, and — when it could not —
 * why not.
 *
 * Only one refusal can reach a row this read returns, and it is `BASE_SEAL_MOVED`: a settled
 * proposal is not returned at all (see below), so `ALREADY_SETTLED` is a refusal the DOOR gives to
 * a caller holding a stale id rather than a state this read can report. It is named beside the
 * other for that reason — the two are the door's set, and a reader of this file should be able to
 * see which of them this read can and cannot produce.
 */
export interface CriteriaDecisionDecidability {
  /** True when the decision door would not refuse this proposal for want of a live baseline. */
  decidable: boolean;
  /** Null when decidable; otherwise the door's own code. */
  refusal: string | null;
  /** The action that would clear it, in the same vocabulary the refusal carries. */
  requiredAction: string | null;
}

/** One loosening proposal waiting for an answer, with everything the answer needs in it. */
export interface PendingCriteriaDecision {
  /** The proposal's address, which is what the proposer was told and what the door takes back. */
  intentId: string;
  projectId: string;
  /** Recomputable by anyone holding the request that made it — see `criteria-weakening-intent.ts`. */
  actionDigest: string;
  filedAt: Date;
  /** Age at `readAt`, in whole seconds, so "oldest" is the server's clock and not a browser's. */
  ageSeconds: number;
  /** The seal of the standard set this proposal was composed against. */
  baselineSeal: string;
  /** The seal of the standard set that stands NOW. Equal to `baselineSeal` when decidable. */
  currentSeal: string;
  /** What the edit asked for, exactly as the request stated it — the diff the decider judges. */
  proposed: ProposedCriterion[];
  /** The proposal this one displaced, or null when it displaced nothing. */
  supersededIntentId: string | null;
  decidability: CriteriaDecisionDecidability;
}

/**
 * What this project's owner is being asked about: the count, the oldest age, and the rows.
 *
 * A list rather than the single row the write path enforces, and deliberately: "one pending
 * proposal per project" is maintained by the supersession link the newer proposal writes, and a
 * read that returned `row | null` would be asserting that invariant instead of reporting it. If two
 * rows ever come back, that is the fact a reader needs to see rather than one this read picked
 * between.
 */
export interface PendingCriteriaDecisionQueue {
  readAt: Date;
  projectId: string;
  /** How many proposals are waiting for an answer: the length of `pending`. */
  count: number;
  /** The age of the oldest of them, or null when there is none. */
  oldestAgeSeconds: number | null;
  /** How many of them a decision could actually be recorded on today. */
  decidableCount: number;
  pending: PendingCriteriaDecision[];
}

/** The stored `action`, or null for a row whose JSONB is not one this reader understands. */
function storedAction(action: unknown): CriteriaWeakeningAction | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const candidate = action as Partial<CriteriaWeakeningAction>;
  const request = candidate.request;
  const baseline = candidate.baseline;
  if (!request || typeof request !== 'object' || !Array.isArray(request.proposed)) return null;
  if (!baseline || typeof baseline !== 'object' || typeof baseline.seal !== 'string') return null;
  return candidate as CriteriaWeakeningAction;
}

function ageSeconds(readAt: Date, filedAt: Date): number {
  return Math.max(0, Math.floor((readAt.getTime() - filedAt.getTime()) / 1000));
}

/**
 * Every proposal of this project that is still a question, oldest first, recomputed from the rows.
 *
 * THE THREE WAYS A ROW STOPS BEING A QUESTION, AND WHY TWO OF THEM VANISH AND ONE DOES NOT
 * ----------------------------------------------------------------------------------------
 *   * SETTLED — somebody answered it. The row is not returned at all, exactly as the evidence
 *     queue drops a revision that carries a decision: an answered question is not a question, and
 *     it has to disappear from EVERY reader's next read rather than from the one that happened to
 *     be listening.
 *   * SUPERSEDED — a later proposal about the same project replaced it. Also not returned, and for
 *     a stricter reason than "it is old": what the owner would be approving is not what anybody is
 *     asking for any more. Read off the supersession links themselves rather than off `created_at`,
 *     because two transactions can share a timestamp and "the newest row" would then be a coin toss
 *     where the invariant needs an answer.
 *   * THE BASE SEAL MOVED — the ruler this proposal was composed against is not the ruler in force.
 *     This one IS returned, undecidable, carrying the door's refusal and the action that clears it.
 *     Dropping it would leave the proposer's card silently blank, and the row is the only thing
 *     that can explain why the answer they were waiting for cannot be given.
 *
 * `EXISTS` rather than a join for the supersession: the question is whether ANY later row names
 * this one, and a join would multiply a row by the number of proposals that displaced it.
 */
export async function readPendingCriteriaDecisions(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  readAt: Date = new Date(),
): Promise<PendingCriteriaDecisionQueue> {
  const rows = await tx.projectRatifiedActionIntent.findMany({
    where: {
      ownerId,
      projectId,
      effectClass: CRITERIA_WEAKENING_EFFECT_CLASS,
    },
    select: { id: true, action: true, actionDigest: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const pending: PendingCriteriaDecision[] = [];
  if (rows.length > 0) {
    const settled = await settledIntentIds(tx, rows.map((row) => row.id));
    // Which proposals a later one displaced, folded from the same rows this read already holds
    // rather than asked of the database a second time: the supersession link is IN the action of
    // the row that did the displacing, so the answer is here already.
    const displaced = new Set<string>();
    for (const row of rows) {
      const action = storedAction(row.action);
      if (action?.supersedes) displaced.add(action.supersedes.intentId);
    }
    // The seal of the set in force, computed off the same rows and by the same function the
    // confirmation read path uses — so what this read calls "moved" is what a reader of
    // `GET /projects/:id/acceptance/confirmation` sees.
    const currentSeal = await currentStandardSetSeal(tx, projectId);

    for (const row of rows) {
      if (settled.has(row.id) || displaced.has(row.id)) continue;
      const action = storedAction(row.action);
      // A row whose JSONB this reader cannot make sense of is not silently dropped — dropping it
      // would make an unreadable proposal look like no proposal — but it has no diff to show and
      // no baseline to compare, so it comes back undecidable with the seal that stands.
      const baselineSeal = action?.baseline.seal ?? '';
      const moved = baselineSeal !== currentSeal;
      pending.push({
        intentId: row.id,
        projectId,
        actionDigest: row.actionDigest,
        filedAt: row.createdAt,
        ageSeconds: ageSeconds(readAt, row.createdAt),
        baselineSeal,
        currentSeal,
        proposed: action?.request.proposed ?? [],
        supersededIntentId: action?.supersedes?.intentId ?? null,
        decidability: {
          decidable: !moved,
          refusal: moved ? CRITERIA_DECISION_BASE_SEAL_MOVED : null,
          requiredAction: moved ? CRITERIA_DECISION_REFILE_ACTION : null,
        },
      });
    }
  }

  return {
    readAt,
    projectId,
    count: pending.length,
    oldestAgeSeconds: pending.length === 0 ? null : pending[0].ageSeconds,
    decidableCount: pending.filter((row) => row.decidability.decidable).length,
    pending,
  };
}

/**
 * "Somebody answered this proposal", as one SQL clause — the same sentence `settledIntentIds`
 * says, for the callers that have to ask it of the database inside a query rather than of rows
 * they already hold.
 *
 * IT IS EXPORTED SO THAT THERE IS ONE OF IT. The write path asks the same question from the other
 * side: before filing a proposal, `ProjectsService.pendingWeakeningProposal` has to know whether
 * the one already on record is still a question, and it asks that in raw SQL because the answer
 * has to be part of the `ORDER BY ... LIMIT 1` rather than a filter applied to whatever that
 * picked. Written out there as well as here, the two would be free to disagree about what
 * "answered" means — and the disagreement is not cosmetic: the read would stop showing a proposal
 * the write path still treats as pending, so the owner would have no card for a proposal that is
 * blocking the next edit. So the clause lives here, beside the definition it belongs to, and the
 * write path composes it.
 *
 * A FRAGMENT AND NOT A SECOND QUERY, deliberately: the caller runs one `$queryRaw` and must go on
 * running one. `intentAlias` is however the calling query names the intent row; it cannot be bound
 * as a parameter, so it is raw the way `common/session-tree-sql.ts` takes its aliases — every
 * caller passes a literal of its own.
 */
export function criteriaDecisionRecorded(intentAlias: string): Prisma.Sql {
  const i = Prisma.raw(intentAlias);
  return Prisma.sql`EXISTS (
           SELECT 1 FROM "project_criteria_decision" d WHERE d."intent_id" = ${i}."id")`;
}

/**
 * Which of these proposals have been answered — THE one place that sentence is defined.
 *
 * Today that is `project_ratified_action_commit`, whose primary key IS the intent id, so a proposal
 * carries at most one and the database rather than this function is what makes "answered twice"
 * impossible.
 *
 * IT IS INCOMPLETE, AND THE INCOMPLETENESS IS NAMED RATHER THAN HIDDEN. A REJECT has nowhere to
 * land on 0195's tables: the commit row expresses "this was committed" and nothing expresses "this
 * was turned down", so a rejected proposal would come back from this read as still pending. The
 * decision door's own table (`project_criteria_decision`, `docs/criteria-seal-design.md` §3.4)
 * is where that half lands, and it is in this tree now — this function is the single line that has
 * to learn about it, which is why the predicate is a function at all rather than a clause inlined
 * above. `criteriaDecisionRecorded` above is that same row as SQL, and is what the write path
 * already asks; the two say one thing the day this reads it too.
 */
async function settledIntentIds(
  tx: Prisma.TransactionClient,
  intentIds: readonly string[],
): Promise<Set<string>> {
  const commits = await tx.projectRatifiedActionCommit.findMany({
    where: { intentId: { in: [...intentIds] } },
    select: { intentId: true },
  });
  return new Set(commits.map((commit) => commit.intentId));
}

/** The seal of the standard set in force, read off the definition rows the trigger maintains. */
async function currentStandardSetSeal(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<string> {
  const definitions = await tx.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      text: true,
      verificationMethod: true,
      completionCriterionOverrideReason: true,
      revision: true,
      contentHash: true,
    },
  });
  return standardSetVersion(criteriaFromDefinitions(definitions)).digest;
}
