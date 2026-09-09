import type { PrismaService } from '../prisma/prisma.service';

/**
 * "Did the session that wrote this criterion also produce the evidence being counted for it?" —
 * a fifth fact about a stated criterion, served BESIDE the other three rather than folded into
 * them.
 *
 * WHAT THIS REPLACES, AND WHY THE OLD SHAPE COULD NOT WORK
 * -------------------------------------------------------
 * The separation of duties this answers — "the person being examined must not write their own
 * exam" — was until now expressed as an IDENTITY gate: `refuseHumanOnlyAction` refuses a criteria
 * edit from `session.dispatch_origin = 'PROJECT_COORDINATOR'` and lets everything else through as
 * NON_JUDGMENT. That gate cannot prove what this rule needs, and its own header says so:
 * NON_JUDGMENT "is expressly not evidence that a human held the authenticated credential"
 * (`coordinator-authority.ts`). A classification of one session ROLE answers a question about
 * roles; it does not answer "was this ruler moved by the same conversation whose work is being
 * measured by it", because every ordinary agent session — the ones that do the work — is
 * NON_JUDGMENT too, and passes.
 *
 * "Are these two session ids the same?" is a different question, and it is one the database can
 * answer. Migration 0251 supplied the half that was missing: `project_criteria_authorship` records
 * which conversation wrote each `(definitionId, revision)`. The other half was already here —
 * a criterion's evidence is the work filed against it, and that work runs in sessions. So this
 * lane is an equality between two committed facts, with no inference about who was at a keyboard.
 *
 * WHY PER CRITERION, AND NOT PER PROJECT
 * -------------------------------------
 * The comparison is scoped to ONE criterion's own evidence. A session that wrote criterion A and
 * did the work for criterion B has not marked its own homework: B is measured by a ruler that
 * session did not move, and A is measured by work that session did not do. Widening the
 * comparison to "any session that touched this project" would withhold DONE from every project
 * whose criteria and work were produced by the same team of conversations, which is every project
 * here, and a rule that never lets anything through has stopped being a rule.
 *
 * WHY AN UNKNOWN AUTHOR IS NOT A VIOLATION
 * ----------------------------------------
 * `authoredBySessionId` is NULL for two different facts, which 0251 keeps apart with
 * `authoredByType` for exactly this reason: `USER` is the owner writing through their own
 * authenticated door, and `SYSTEM` is the backfill — nobody knows. Neither can make this
 * predicate TRUE, because the predicate needs a session on both sides of an equality, and neither
 * is treated as making it FALSE either:
 *
 *   * `USER` is the case the whole rule exists to protect. The owner stating what they want is
 *     the one authorship that is never a conflict of interest.
 *   * `SYSTEM` is an absence of evidence. Reading it as a violation would withhold DONE from
 *     every criterion written before 0251, with no repair available short of rewriting each one —
 *     which is the failure 0251's own header names when it explains why the two are not one row.
 *     This is the same rule the landing lane states about a missing receipt, applied in the
 *     direction the evidence points: what cannot be established is not asserted.
 *
 * So there is no third value here. The answer is an equality that either holds or does not, and
 * a criterion whose author is unknown is reported as INDEPENDENT rather than as a fourth kind of
 * doubt this projection would then have to teach every reader about.
 *
 * WHAT IS NOT DROPPED
 * -------------------
 * A criterion that does not count is NAMED, with the sessions and the work that collide and with
 * what would make it count again. "Does not count" implemented as a silent filter would settle a
 * project against a SMALLER standard set than the one its owner confirmed, and would tell nobody:
 * the reader would see a green project and a criterion that had simply stopped being mentioned.
 * So the criterion stays in the projection's list, carries its own answer, and withholds DONE —
 * and the remedy is a sentence a card can render rather than something a reader has to know.
 */
export type CriterionIndependence =
  /** No session both wrote the version of this criterion that stands today and produced the
   *  evidence being counted for it. */
  | 'INDEPENDENT'
  /** One did. The criterion does not count towards settlement while that is true. */
  | 'AUTHORED_BY_ITS_OWN_EVIDENCE';

/** One session that wrote this criterion AND produced evidence for it, and the work it did. */
export interface CriterionAuthorshipConflict {
  /** The conversation on both sides of the equality. */
  sessionId: string;
  /** The task serving this criterion that the same conversation ran. */
  taskId: string;
  taskTitle: string;
}

/**
 * What would make a criterion count again — the same shape `taskCompletionRequiredAction` serves,
 * for the same reason: a rule that withholds something must say what satisfies it, or the reader
 * is left to guess between rewriting the criterion, redoing the work, and giving up.
 */
export interface CriterionIndependenceRemedy {
  requiredAction: string;
  instruction: string;
}

/**
 * The one repair, stated once so a card, a strip and this lane's own spec quote the same sentence
 * rather than three drifting paraphrases of it.
 *
 * It names the repair that is actually available. Rewriting the criterion from another session
 * would move the ruler AFTER the evidence, which is the thing the seal exists to refuse; undoing
 * the work is not a repair at all. What remains is a second pair of eyes on the work itself: an
 * independent verification task, run by a session that did not write this criterion, whose PASS
 * is the evidence the criterion is then measured by.
 */
export function criterionIndependenceRemedy(): CriterionIndependenceRemedy {
  return {
    requiredAction: 'ASSIGN_AN_INDEPENDENT_VERIFICATION_TASK',
    instruction:
      'file a VERIFICATION task against this criterion’s work and let a session that did not '
      + 'write the criterion conclude it; its PASS is evidence this criterion’s author did not '
      + 'produce. Rewriting the criterion instead would move the ruler after the evidence, which '
      + 'is what the standard-set seal already refuses',
  };
}

/** One criterion's answer, addressed the way the satisfaction and landing lanes address theirs. */
export interface CriterionIndependenceAnswer {
  definitionId: string;
  independence: CriterionIndependence;
  /** Every collision found. Empty exactly when `independence` is `INDEPENDENT`. */
  conflicts: CriterionAuthorshipConflict[];
  /** Null exactly when the criterion already counts. */
  remedy: CriterionIndependenceRemedy | null;
}

/** One piece of work serving a criterion, as this lane needs it: who ran it, and enough to name
 *  it to a reader who has to go and do something about it. */
export interface IndependenceServingTask {
  id: string;
  title: string;
  /** The sessions that EXECUTE this task — `Session.taskId`, which is what "produced the
   *  evidence" means for every one of the three completion criteria: the command ran there, the
   *  verification concluded there, the evidence was submitted from there. */
  sessions: ReadonlyArray<{ id: string }>;
}

/** The rows the fold needs: one criterion's identity, the version that stands today, and its
 *  serving work. Kept structural so the fold is testable without Prisma. */
export interface CriterionWithAuthorshipFacts {
  id: string;
  /** Compared against the authorship row's, because authorship is per VERSION: the session that
   *  wrote revision 1 has not written the revision 2 that stands now. */
  revision: number;
  servingTasks: ReadonlyArray<IndependenceServingTask>;
}

/** One row of 0251's table, as this lane reads it. */
export interface RecordedCriterionAuthorship {
  definitionId: string;
  revision: number;
  /** Non-null only for `AGENT`; see the header for why the other two are not violations. */
  authoredBySessionId: string | null;
}

/**
 * The fold: a criterion counts unless the session that wrote the version standing today is also
 * one of the sessions that ran the work being counted for it.
 *
 * Every collision is reported and not just the first, for the reason every lane here reports
 * every clause: a reader who fixes the one task they were shown and comes back to find a second
 * has learned nothing from the first answer.
 */
export function criterionIndependence(
  definitions: ReadonlyArray<CriterionWithAuthorshipFacts>,
  authorship: ReadonlyArray<RecordedCriterionAuthorship>,
): CriterionIndependenceAnswer[] {
  const authorOf = new Map(
    authorship.map((row) => [`${row.definitionId}@${row.revision}`, row.authoredBySessionId]),
  );
  return definitions.map((definition) => {
    const author = authorOf.get(`${definition.id}@${definition.revision}`) ?? null;
    const conflicts: CriterionAuthorshipConflict[] = [];
    if (author !== null) {
      for (const task of definition.servingTasks) {
        if (task.sessions.some((session) => session.id === author)) {
          conflicts.push({ sessionId: author, taskId: task.id, taskTitle: task.title });
        }
      }
    }
    const independent = conflicts.length === 0;
    return {
      definitionId: definition.id,
      independence: independent ? 'INDEPENDENT' : 'AUTHORED_BY_ITS_OWN_EVIDENCE',
      conflicts,
      remedy: independent ? null : criterionIndependenceRemedy(),
    };
  });
}

/**
 * Every criterion this project states, and whether the version standing today was written by a
 * session that is also producing its evidence.
 *
 * Two statements, neither of them per criterion or per task: the definitions with their serving
 * work's sessions, and this project's authorship rows. They cannot be one — 0251 puts no foreign
 * key on `definition_id`, deliberately, so that "who wrote it" survives the criterion being
 * deleted — so the join is made here, on `(definitionId, revision)`, over rows the criteria
 * themselves are the starting point of. The orphans a deleted criterion leaves behind are
 * therefore unreachable, which is the property that choice was made for.
 */
export async function readCriterionIndependence(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition' | 'projectCriteriaAuthorship'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionIndependenceAnswer[]> {
  const [definitions, authorship] = await Promise.all([
    prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId, project: { ownerId } },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        revision: true,
        servingTasks: {
          where: { ownerId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, title: true, sessions: { select: { id: true } } },
        },
      },
    }),
    prisma.projectCriteriaAuthorship.findMany({
      where: { projectId, ownerId },
      select: { definitionId: true, revision: true, authoredBySessionId: true },
    }),
  ]);
  return criterionIndependence(definitions, authorship);
}
