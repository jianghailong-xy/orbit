import type { PrismaService } from '../prisma/prisma.service';

/**
 * T2: the criterion declarations 0232 stores, read back beside the criterion they name.
 *
 * `Task.criterionRevision` is a SNAPSHOT — the criterion's `revision` at the moment the work was
 * declared against it — and being able to disagree with the present is the whole of what a
 * snapshot is for. When it does disagree, this read MARKS the row, and does neither of the two
 * things that would make the disagreement disappear:
 *
 *   * not silent acceptance, which leaves work claiming to serve a condition whose words have
 *     since moved under it, with nothing anywhere saying so;
 *   * not silent detachment, which lets one typo correction throw every task filed under a
 *     criterion off it.
 *
 * So the mark is a visible STATE rather than a change: a stale row is still in its criterion's
 * list, still carries `criterionDefinitionId`, and is still work somebody filed on purpose. What
 * to do about it is a judgement, and this only makes the question askable.
 *
 * A read, and only a read. Nothing here gates a write, decides a status, or is consulted by
 * dispatch — 0229 said "The DONE gate is not replaced" and 0223 said the protection it removed
 * was "removed, not relocated"; a staleness gate would be exactly the equivalent protection under
 * another name. Its readers are the coordinator and the owner, who need to see what is still
 * missing, and (unit T3) the derivation of "this criterion is satisfied", whose third clause is
 * this same fact folded: every serving task declared the revision the criterion carries today.
 *
 * THE VOCABULARY IS NOT NEW
 * -------------------------
 * `criterionRevision` is what `TaskCompletionEvidence` has called this snapshot since 0178 and
 * what 0232 called it on `Task`; `stale` is what this codebase already calls a value measured
 * against something that has since moved (`COMPLETION_ACK_STALE`, `ACCEPTANCE_EVIDENCE_STALE`,
 * `STALE_CONFIG_REVISION`). The marker is those two words and no third one. A synonym invented
 * here would make the evidence card's "the ruler moved" and this one two signals to learn instead
 * of one, which is the same rule §12 E2 states for refusal codes.
 */

/** One task that says it serves a criterion, and whether it still says it about today's wording. */
export interface CriterionServingTask {
  taskId: string;
  title: string;
  status: string;
  /**
   * 0232's live relation, read from the task's own column rather than re-derived from the
   * criterion this row is grouped under. That is what lets "stale but still attached" be one fact
   * this read can be ASKED for: a marked row that had been quietly detached would show a null
   * here, and the difference between marking and detaching would not be observable at all.
   */
  criterionDefinitionId: string | null;
  /** 0232's snapshot: the criterion's `revision` when this work was declared against it. */
  criterionRevision: number | null;
  /** True when that snapshot is not the criterion's current `revision`. */
  criterionRevisionStale: boolean;
}

/** One stated criterion and the work filed under it. */
export interface CriterionDeclarations {
  definitionId: string;
  ordinal: number;
  /** What the criterion says TODAY — the number every snapshot above is compared against. */
  revision: number;
  servingTasks: CriterionServingTask[];
}

/** The definition rows the fold needs, kept structural so it is testable without Prisma. */
export interface CriterionWithServingTasks {
  id: string;
  ordinal: number;
  revision: number;
  servingTasks: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    criterionDefinitionId: string | null;
    criterionRevision: number | null;
  }>;
}

/**
 * The comparison, in one place.
 *
 * A missing snapshot counts as stale rather than as current: the pair is written together and
 * only together, so a row that has the relation without the revision cannot say which wording it
 * was filed against, and "unknown" is not "the one you are reading now".
 */
export function criterionDeclarations(
  definitions: ReadonlyArray<CriterionWithServingTasks>,
): CriterionDeclarations[] {
  return definitions.map((definition) => ({
    definitionId: definition.id,
    ordinal: definition.ordinal,
    revision: definition.revision,
    servingTasks: definition.servingTasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      criterionDefinitionId: task.criterionDefinitionId,
      criterionRevision: task.criterionRevision,
      criterionRevisionStale: task.criterionRevision !== definition.revision,
    })),
  }));
}

/**
 * Every criterion this project states, in the order it states them, with the work declared
 * against each.
 *
 * The relation is the join, so a criterion nobody serves comes back with an empty list rather
 * than not coming back — T3's first clause is that the empty case is not satisfied vacuously, and
 * it can only say so about a criterion it can see.
 */
export async function readCriterionDeclarations(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionDeclarations[]> {
  const definitions = await prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      revision: true,
      servingTasks: {
        where: { ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          title: true,
          status: true,
          criterionDefinitionId: true,
          criterionRevision: true,
        },
      },
    },
  });
  return criterionDeclarations(definitions);
}
