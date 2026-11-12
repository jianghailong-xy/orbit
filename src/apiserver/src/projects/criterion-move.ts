import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62, type MoveCriterionRefusal } from '@orbit/shared';

import type { AuthCredential } from '../common/current-user.decorator';
import { IN_FLIGHT_JOB_STATES, LANDING_JOB_KINDS } from './criterion-landing-reason';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';
import { readCriterionSatisfaction } from './project-criterion-satisfaction';

/**
 * The done card's "Move to a follow-up…" (owner decision 2026-11-11): one unmet acceptance criterion
 * of project A, and its serving tasks that are not DONE or CANCELLED, moved to project B — an OPEN
 * project of the same owner, or one this move creates — in one transaction.
 *
 * WHAT MOVES IS THE DEFINITION ROW ITSELF. Its id, key and revision stay what they were, so every
 * moved task's declaration (`task.criterion_definition_id` / `criterion_revision`) is still current
 * in B, and evidence filed against it is still about the words it was filed against. A's stated
 * criteria lose the row and B's gain it, which is the criteria revision both sides record: the seal
 * of each set moves, and an `activity` row (`project.criterion_moved`) names both seals.
 *
 * DONE AND CANCELLED SERVING TASKS STAY WITH A and stop serving the criterion: their declaration is
 * cleared to `criterion_definition_id IS NULL AND criterion_revision IS NOT NULL`, which 0232 defines
 * as "declared a criterion that is no longer there". Left pointing at the moved row they would be
 * counted as B's serving work, and B's landing would read receipts of A's line.
 *
 * NO CONFIRMATION IS CARRIED, to either side (owner decision 2026-11-12). A's newest standard-set
 * confirmation names the seal the move started from, and the move leaves it there: A's reduced set
 * stands unconfirmed, so the derived-done projection withholds A (STANDARD_SET_UNCONFIRMED) and Orbit
 * does not record A done by itself when the moved criterion was its last unmet one. Recording that
 * is the owner's act — the done card's plain "Record as done", which stores `done_by = 'OWNER'`.
 * Nothing on that path reads the set's confirmation: `doneReadiness` has no finding for it, so the
 * done-check shows no refusal and no gap for it, and `recordProjectDone` neither refuses nor stores
 * one; an owner-recorded DONE is reopened only by the seal moving or a serving task reopening, never
 * by the confirmation. This is why the rule is here and not in the projection: the derived-done rules
 * stay what they are for every other path (the decision door, `decideCriteriaChange`, still carries
 * a confirmation through an edit the owner approved). B's is not carried either: B gained a criterion
 * nobody confirmed there.
 *
 * REFUSED, WITH NOTHING WRITTEN, when (in this order):
 *   - A is not OPEN (`CRITERION_MOVE_SOURCE_NOT_OPEN`) or B is not (`CRITERION_MOVE_TARGET_NOT_OPEN`);
 *   - the criterion is met (`CRITERION_MOVE_CRITERION_MET`) — the card offers the move only for an
 *     unmet one, and moving a met criterion would take back work A has finished;
 *   - a task that would move has a live run (`CRITERION_MOVE_TASK_RUNNING`): the same predicate as
 *     0389's `task_claimed_project_move_guard` — a session of it PENDING, RUNNING, AWAITING_INPUT or
 *     INTERRUPTED. A run belongs to the project it was started in; stop it, or let it finish;
 *   - a task that would move is being landed on A's line (`CRITERION_MOVE_TASK_LANDING`);
 *   - DEPENDENCIES: a task that would move depends on, or is depended on by, a task that stays in A
 *     and is not DONE or CANCELLED (`CRITERION_MOVE_DEPENDENCY_CROSSES`). Splitting open work across
 *     two projects would leave each waiting on a project that is not its own; the owner moves the
 *     other task too (by serving the same criterion) or removes the edge first. An edge whose other
 *     end is DONE or CANCELLED is kept: it waits on nothing any more. Edges to tasks of B, or of a
 *     third project, are kept as they are;
 *   - LINKS: a parent, subtask, check (verifies / verified by), supersession or fix link (the task
 *     fixes an open item that does not move with it) between a task that moves and a task or item
 *     that stays (`CRITERION_MOVE_LINK_CROSSES`) — the rules every task move meets
 *     (`assertHierarchyConsistent`, §13.6 SU3, the fix link's same-project rule);
 *   - OPEN ITEMS: an OPEN item about a task that would move that belongs to A — a landing on A's line,
 *     a question A's coordinator asked (`CRITERION_MOVE_TASK_ITEM_OPEN`). An OPEN `TASK_FAILED` item
 *     is about the task itself, so it moves with it and is B's to handle; left in A, it would hold
 *     A's done-check up (DONE_OWNER_ITEMS_OPEN) over work A no longer has;
 *   - a task that would move is locked by another writer right now (`CRITERION_MOVE_BUSY`).
 *
 * `planCriterionMove` decides all of it from facts read under the move's locks, and is pure.
 */

/** Open items that are about a task itself and so go where it goes. */
export const OPEN_ITEM_KINDS_MOVING_WITH_TASK: ReadonlySet<string> = new Set(['TASK_FAILED']);

/** The live-claim statuses 0389's guard refuses a project move over. */
export const LIVE_RUN_STATUSES = [
  RunStatus.PENDING,
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
] as const;

const SETTLED: ReadonlySet<string> = new Set([TaskStatus.DONE, TaskStatus.CANCELLED]);

export type CriterionMoveLinkKind =
  | 'PARENT'
  | 'SUBTASK'
  | 'VERIFIES'
  | 'VERIFIED_BY'
  | 'SUPERSEDED_BY'
  | 'SUPERSEDES';

export interface CriterionMoveFacts {
  source: { id: string; status: string };
  /** null: the move creates the destination, which is OPEN by birth. */
  target: { id: string; status: string } | null;
  criterion: { id: string; satisfied: boolean };
  /** Every task of the source project declaring the criterion. */
  servingTasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  /** Live sessions of serving tasks. */
  liveRuns: ReadonlyArray<{ taskId: string; sessionId: string; status: string }>;
  /** Landing jobs queued or running for serving tasks. */
  landings: ReadonlyArray<{ taskId: string; jobId: string }>;
  /** Dependency edges with a serving task at one end, with the other end's facts. */
  dependencies: ReadonlyArray<{
    task: { id: string; projectId: string | null; status: string };
    dependsOn: { id: string; projectId: string | null; status: string };
  }>;
  /** Hierarchy links with a serving task at one end, with the other end's facts. */
  links: ReadonlyArray<{
    taskId: string;
    kind: CriterionMoveLinkKind;
    other: { id: string; projectId: string | null };
  }>;
  /** Serving tasks that fix an open item, with the item. */
  fixes: ReadonlyArray<{ taskId: string; itemId: string }>;
  /** OPEN items about serving tasks. */
  openItems: ReadonlyArray<{ id: string; kind: string; taskId: string }>;
}

export interface CriterionMoveRefusalDetail {
  code: MoveCriterionRefusal;
  message: string;
  taskIds: string[];
  itemIds: string[];
}

export interface CriterionMovePlan {
  movedTaskIds: string[];
  keptTaskIds: string[];
  movedOpenItemIds: string[];
}

const b62 = (id: string) => {
  try {
    return uuidToBase62(id);
  } catch {
    return id;
  }
};
const names = (ids: readonly string[]) => [...new Set(ids)].map(b62).join(', ');

/** The move, or the first reason it cannot be made. Pure. */
export function planCriterionMove(
  facts: CriterionMoveFacts,
): { plan: CriterionMovePlan } | { refusal: CriterionMoveRefusalDetail } {
  const refuse = (
    code: MoveCriterionRefusal,
    message: string,
    taskIds: readonly string[] = [],
    itemIds: readonly string[] = [],
  ) => ({ refusal: { code, message, taskIds: [...new Set(taskIds)], itemIds: [...new Set(itemIds)] } });

  if (facts.source.status !== 'OPEN') {
    return refuse('CRITERION_MOVE_SOURCE_NOT_OPEN',
      `project ${b62(facts.source.id)} is ${facts.source.status}; reopen it before moving its criteria`);
  }
  if (facts.target && facts.target.status !== 'OPEN') {
    return refuse('CRITERION_MOVE_TARGET_NOT_OPEN',
      `project ${b62(facts.target.id)} is ${facts.target.status}, and a settled project takes no `
        + 'work until it is reopened; choose an open project or create a new one');
  }
  if (facts.criterion.satisfied) {
    return refuse('CRITERION_MOVE_CRITERION_MET',
      'this criterion is met, and only an unmet criterion is moved to a follow-up');
  }

  const moving = facts.servingTasks.filter((task) => !SETTLED.has(task.status));
  const movingIds = new Set(moving.map((task) => task.id));
  const kept = facts.servingTasks.filter((task) => SETTLED.has(task.status));

  const running = facts.liveRuns.filter((run) => movingIds.has(run.taskId));
  if (running.length > 0) {
    const ids = running.map((run) => run.taskId);
    return refuse('CRITERION_MOVE_TASK_RUNNING',
      `${names(ids)} ${ids.length === 1 ? 'has' : 'have'} a live run, and a run belongs to the `
        + 'project it was started in; stop it or let it finish, then move the criterion',
      ids);
  }
  const landing = facts.landings.filter((job) => movingIds.has(job.taskId));
  if (landing.length > 0) {
    const ids = landing.map((job) => job.taskId);
    return refuse('CRITERION_MOVE_TASK_LANDING',
      `${names(ids)} ${ids.length === 1 ? 'is' : 'are'} being landed on this project's line; `
        + 'wait for the landing to finish, then move the criterion',
      ids);
  }

  const stays = (other: { id: string; projectId: string | null }) =>
    !movingIds.has(other.id) && other.projectId === facts.source.id;
  // One end moves, the other stays behind in A with work still to do.
  const strands = (moves: { id: string }, other: { id: string; projectId: string | null; status: string }) =>
    movingIds.has(moves.id) && stays(other) && !SETTLED.has(other.status);
  const crossing = facts.dependencies.filter((edge) =>
    strands(edge.task, edge.dependsOn) || strands(edge.dependsOn, edge.task));
  if (crossing.length > 0) {
    return refuse('CRITERION_MOVE_DEPENDENCY_CROSSES',
      `the dependency ${crossing.map((edge) => `${b62(edge.task.id)} → ${b62(edge.dependsOn.id)}`)
        .join(', ')} would cross the two projects with open work at both ends; remove it, or have `
        + 'the other task serve this criterion too, then move it',
      crossing.flatMap((edge) => [edge.task.id, edge.dependsOn.id]));
  }

  const crossingLinks = facts.links.filter((link) => movingIds.has(link.taskId) && stays(link.other));
  const movingItemIds = new Set(facts.openItems
    .filter((item) => movingIds.has(item.taskId) && OPEN_ITEM_KINDS_MOVING_WITH_TASK.has(item.kind))
    .map((item) => item.id));
  const crossingFixes = facts.fixes.filter((fix) =>
    movingIds.has(fix.taskId) && !movingItemIds.has(fix.itemId));
  if (crossingLinks.length > 0 || crossingFixes.length > 0) {
    const said = [
      ...crossingLinks.map((link) => `${b62(link.taskId)} ${link.kind.toLowerCase().replace('_', ' ')} `
        + b62(link.other.id)),
      ...crossingFixes.map((fix) => `${b62(fix.taskId)} fixes item ${b62(fix.itemId)}`),
    ];
    return refuse('CRITERION_MOVE_LINK_CROSSES',
      `${said.join('; ')}: a parent, subtask, check, supersession or fix link would cross the two `
        + 'projects; detach it, then move the criterion',
      [...crossingLinks.flatMap((link) => [link.taskId, link.other.id]),
        ...crossingFixes.map((fix) => fix.taskId)],
      crossingFixes.map((fix) => fix.itemId));
  }

  const staying = facts.openItems.filter((item) =>
    movingIds.has(item.taskId) && !OPEN_ITEM_KINDS_MOVING_WITH_TASK.has(item.kind));
  if (staying.length > 0) {
    return refuse('CRITERION_MOVE_TASK_ITEM_OPEN',
      `${staying.map((item) => `${item.kind} ${b62(item.id)}`).join(', ')} about a task that would `
        + 'move belongs to this project; answer or resolve it first',
      staying.map((item) => item.taskId),
      staying.map((item) => item.id));
  }

  return {
    plan: {
      movedTaskIds: moving.map((task) => task.id),
      keptTaskIds: kept.map((task) => task.id),
      movedOpenItemIds: [...movingItemIds],
    },
  };
}

type Db = Prisma.TransactionClient;

/**
 * The facts `planCriterionMove` decides on, read under the move's locks. `targetId` null reads no
 * target: the move creates it.
 */
export async function readCriterionMoveFacts(
  tx: Db,
  ownerId: string,
  input: { sourceId: string; targetId: string | null; criterionId: string },
): Promise<CriterionMoveFacts | null> {
  const projects = await tx.project.findMany({
    where: { ownerId, id: { in: [input.sourceId, ...(input.targetId ? [input.targetId] : [])] } },
    select: { id: true, status: true },
  });
  const source = projects.find((project) => project.id === input.sourceId);
  const target = input.targetId ? projects.find((project) => project.id === input.targetId) : null;
  if (!source || target === undefined) return null;

  const satisfaction = await readCriterionSatisfaction(tx, ownerId, input.sourceId);
  const criterion = satisfaction.find((row) => row.definitionId === input.criterionId);
  if (!criterion) return null;

  const servingTasks = await tx.task.findMany({
    where: { ownerId, projectId: input.sourceId, criterionDefinitionId: input.criterionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
      status: true,
      parentTaskId: true,
      verifiesTaskId: true,
      supersededByTaskId: true,
      fixesOpenItemId: true,
    },
  });
  const ids = servingTasks.map((task) => task.id);
  const taskFacts = { id: true, projectId: true, status: true } as const;

  // One statement at a time: an interactive transaction runs its queries in turn anyway.
  const liveRuns = await tx.session.findMany({
    where: { ownerId, taskId: { in: ids }, deletedAt: null, status: { in: [...LIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true, status: true },
  });
  const landings = await tx.projectIntegrationJob.findMany({
    where: {
      ownerId,
      taskId: { in: ids },
      kind: { in: [...LANDING_JOB_KINDS] },
      state: { in: [...IN_FLIGHT_JOB_STATES] },
    },
    select: { id: true, taskId: true },
  });
  const edges = await tx.taskDependency.findMany({
    where: { OR: [{ taskId: { in: ids } }, { dependsOnTaskId: { in: ids } }] },
    select: { task: { select: taskFacts }, dependsOnTask: { select: taskFacts } },
  });
  const children = await tx.task.findMany({
    where: { ownerId, parentTaskId: { in: ids } },
    select: { ...taskFacts, parentTaskId: true },
  });
  const checks = await tx.task.findMany({
    where: { ownerId, verifiesTaskId: { in: ids } },
    select: { ...taskFacts, verifiesTaskId: true },
  });
  const replaced = await tx.task.findMany({
    where: { ownerId, supersededByTaskId: { in: ids } },
    select: { ...taskFacts, supersededByTaskId: true },
  });
  const openItems = await tx.projectOpenItem.findMany({
    where: { ownerId, state: 'OPEN', taskId: { in: ids } },
    select: { id: true, kind: true, taskId: true },
  });

  const referenced = [...new Set(servingTasks.flatMap((task) =>
    [task.parentTaskId, task.verifiesTaskId, task.supersededByTaskId].filter((id): id is string => !!id)))];
  const others = new Map((await tx.task.findMany({
    where: { ownerId, id: { in: referenced } },
    select: taskFacts,
  })).map((task) => [task.id, task]));
  const other = (id: string) => others.get(id) ?? { id, projectId: null };

  const links: Array<CriterionMoveFacts['links'][number]> = [];
  for (const task of servingTasks) {
    if (task.parentTaskId) links.push({ taskId: task.id, kind: 'PARENT', other: other(task.parentTaskId) });
    if (task.verifiesTaskId) links.push({ taskId: task.id, kind: 'VERIFIES', other: other(task.verifiesTaskId) });
    if (task.supersededByTaskId) {
      links.push({ taskId: task.id, kind: 'SUPERSEDED_BY', other: other(task.supersededByTaskId) });
    }
  }
  for (const child of children) links.push({ taskId: child.parentTaskId!, kind: 'SUBTASK', other: child });
  for (const check of checks) links.push({ taskId: check.verifiesTaskId!, kind: 'VERIFIED_BY', other: check });
  for (const attempt of replaced) {
    links.push({ taskId: attempt.supersededByTaskId!, kind: 'SUPERSEDES', other: attempt });
  }

  return {
    source: { id: source.id, status: source.status },
    target: target ? { id: target.id, status: target.status } : null,
    criterion: { id: input.criterionId, satisfied: criterion.satisfied },
    servingTasks: servingTasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    liveRuns: liveRuns.map((run) => ({ taskId: run.taskId!, sessionId: run.id, status: run.status })),
    landings: landings.map((job) => ({ taskId: job.taskId!, jobId: job.id })),
    dependencies: edges.map((edge) => ({ task: edge.task, dependsOn: edge.dependsOnTask })),
    links,
    fixes: servingTasks.flatMap((task) => task.fixesOpenItemId
      ? [{ taskId: task.id, itemId: task.fixesOpenItemId }]
      : []),
    openItems: openItems.map((item) => ({ id: item.id, kind: item.kind, taskId: item.taskId! })),
  };
}

/** The seal of a project's stated criteria, as every reader of it computes it. */
export async function criteriaSeal(tx: Db, projectId: string) {
  return standardSetVersion(criteriaFromDefinitions(
    await tx.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId },
      select: { id: true, ordinal: true, text: true, verificationMethod: true, revision: true, contentHash: true },
    }),
  ));
}

/** The activity row a move records, beside the two seals that make it a criteria revision. */
export const CRITERION_MOVED_ACTIVITY = 'project.criterion_moved';

/**
 * Apply a plan `planCriterionMove` returned, inside the transaction that read its facts and under
 * the same locks: the definition row to B (last in B's order), the moving tasks and their
 * TASK_FAILED items to B, the kept tasks' declaration cleared, and the activity row. No confirmation
 * row: A's reduced set is left for the owner (see the head of this file). Answers both seals of A.
 */
export async function writeCriterionMove(
  tx: Db,
  ownerId: string,
  move: { sourceId: string; targetId: string; criterionId: string; plan: CriterionMovePlan },
  credential?: AuthCredential,
): Promise<{ before: string; after: string }> {
  const { sourceId, targetId, criterionId, plan } = move;
  const before = await criteriaSeal(tx, sourceId);
  // The number the source's cards gave the criterion ("Criterion 4"), kept on the record: once it
  // has moved, nothing else remembers where in the source's list it stood.
  const sourceOrder = await tx.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: sourceId },
    orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const fromOrdinal = sourceOrder.findIndex((row) => row.id === criterionId) + 1;

  const last = await tx.projectAcceptanceCriterionDefinition.aggregate({
    where: { projectId: targetId },
    _max: { ordinal: true },
  });
  // `ordinal` and `project_id` only: the definition trigger moves `revision` on the words, and the
  // words do not change, so every declaration of this row stays current.
  await tx.projectAcceptanceCriterionDefinition.update({
    where: { id: criterionId },
    data: { projectId: targetId, ordinal: (last._max.ordinal ?? 0) + 1 },
  });

  if (plan.movedTaskIds.length > 0) {
    const moved = await tx.task.updateMany({
      where: { ownerId, projectId: sourceId, id: { in: plan.movedTaskIds } },
      data: { projectId: targetId },
    });
    if (moved.count !== plan.movedTaskIds.length) {
      throw new Error(`criterion move: ${moved.count} of ${plan.movedTaskIds.length} tasks moved under the held locks`);
    }
  }
  if (plan.keptTaskIds.length > 0) {
    await tx.task.updateMany({
      where: { ownerId, id: { in: plan.keptTaskIds }, criterionDefinitionId: criterionId },
      data: { criterionDefinitionId: null },
    });
  }
  if (plan.movedOpenItemIds.length > 0) {
    await tx.projectOpenItem.updateMany({
      where: { ownerId, projectId: sourceId, state: 'OPEN', id: { in: plan.movedOpenItemIds } },
      data: { projectId: targetId },
    });
  }

  // A's newest confirmation stays on the seal it named: carrying it to `after` would let the
  // projection record A done by itself, which is the owner's to record (see the head of this file).
  const after = await criteriaSeal(tx, sourceId);

  await tx.activity.create({
    data: {
      actorId: ownerId,
      type: CRITERION_MOVED_ACTIVITY,
      payload: {
        criterionDefinitionId: criterionId,
        fromProjectId: sourceId,
        toProjectId: targetId,
        fromOrdinal: fromOrdinal > 0 ? fromOrdinal : null,
        movedTaskIds: plan.movedTaskIds,
        keptTaskIds: plan.keptTaskIds,
        movedOpenItemIds: plan.movedOpenItemIds,
        fromCriteriaDigestBefore: before.digest,
        fromCriteriaDigestAfter: after.digest,
      },
      credentialKind: credential?.kind ?? null,
      credentialId: credential?.kind === 'PAT' ? credential.tokenId : null,
    },
  });
  return { before: before.digest, after: after.digest };
}
