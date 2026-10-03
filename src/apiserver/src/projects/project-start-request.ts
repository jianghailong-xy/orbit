import { createHash } from 'node:crypto';

import { Prisma, TaskStatus } from '@prisma/client';
import type {
  ProjectStartFinding,
  ProjectStartRequest,
  ProjectStartSettings,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import {
  criteriaFromDefinitions,
  standardSetVersion,
  type StatedAcceptanceCriterion,
} from './project-acceptance';
import { branchName } from './project-criterion-landing';
import { projectBranchRef, projectRepository } from './project-integration-line';

/**
 * A coordinator asking its owner to start the project (`project_request_start`).
 *
 * The request is an open item of its own kind, `START_REQUEST`, with the owner on it from birth: the
 * settings the coordinator suggests, why, and which plan it was made about. It is what the owner's
 * "Start this project?" card is drawn from, and the card appears only once there is one — never
 * inferred from a project merely having tasks.
 *
 * WHAT HAS TO BE TRUE FIRST. The plan is checked before anything is filed, in `task-plan-preflight`'s
 * shape: `REFUSE` findings stop the request (409 `START_REQUEST_NOT_READY`, every finding at once, so
 * a coordinator fixes the plan in one pass rather than one refusal at a time) and `WARN` findings are
 * filed with it, for the owner to read before pressing Start. `startReadiness` is pure, and the facts
 * it reads are `readStartPlan`'s.
 *
 * ONE AT A TIME, AND ONLY WHILE IT IS TRUE. A project holds at most one open request: the dedupe key
 * is the same for every request of a project, and the partial unique index on OPEN items makes that
 * a fact of the table rather than of the code. A newer request supersedes the one open
 * (`superseded_by_item_id` names it), and so does the plan moving under it: a request names the seal
 * of the criteria and a digest of the tasks and their edges, and one whose plan has changed since is
 * superseded the next time it is read (`supersedeStaleStartRequest`), so no owner is shown a card
 * about a plan that is no longer there. Starting the project answers whichever request is open
 * (`answerStartRequests`).
 */

export const START_REQUEST_KIND = 'START_REQUEST';
/** Every request of a project shares this key, so at most one of them is OPEN (0278's index). */
export const START_REQUEST_DEDUPE_KEY = 'START_REQUEST';
/** The item's title: the card's own question. */
export const START_REQUEST_TITLE = 'Start this project?';
export const MAX_START_REQUEST_WHY = 2_000;

/** Only the conversation a project is coordinated from may ask to start it. */
export const START_REQUEST_COORDINATOR_ONLY = 'START_REQUEST_COORDINATOR_ONLY';
export const START_REQUEST_NOT_READY = 'START_REQUEST_NOT_READY';

/** One task of the plan, as the check reads it. */
export interface StartPlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  autoRunWhenReady: boolean;
  criterionDefinitionId: string | null;
  completionPolicy: string;
  verifiesTaskId: string | null;
  parentTaskId: string | null;
  assignee: { runnerId: string | null; enabled: boolean } | null;
  /** What the codeless warning reads: the declaration, and the two fields that make a task LOOK
   *  like work that produces no code (`looksCodeless`). */
  codeless: boolean;
  completionCriterion: string;
  acceptanceCommand: string | null;
}

/** Everything the check and the digests read: the project's plan as it stands. */
export interface StartPlan {
  criteria: StatedAcceptanceCriterion[];
  /** Every task of the project that is not cancelled, oldest first. */
  tasks: StartPlanTask[];
  /** Every prerequisite edge of those tasks. */
  edges: Array<{ taskId: string; dependsOnTaskId: string }>;
  /** The repository the project would integrate into, or null (`projectRepository`). */
  repository: string | null;
  criteriaDigest: string;
  planDigest: string;
}

/**
 * The plan of one project, read once. Tasks that were cancelled are not part of it; every other
 * task is, whatever its state — a start request is about the work that is filed.
 */
export async function readStartPlan(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
): Promise<StartPlan> {
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
  const criteria = criteriaFromDefinitions(definitions);
  const tasks = await tx.task.findMany({
    where: { projectId, ownerId, status: { not: TaskStatus.CANCELLED } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
      status: true,
      autoRunWhenReady: true,
      criterionDefinitionId: true,
      completionPolicy: true,
      verifiesTaskId: true,
      parentTaskId: true,
      assignee: { select: { runnerId: true, enabled: true } },
      codeless: true,
      completionCriterion: true,
      acceptanceCommand: true,
    },
  });
  const edges = tasks.length === 0 ? [] : await tx.taskDependency.findMany({
    where: { taskId: { in: tasks.map((task) => task.id) } },
    select: { taskId: true, dependsOnTaskId: true },
  });
  return {
    criteria,
    tasks,
    edges,
    repository: await projectRepository(tx, ownerId, projectId),
    criteriaDigest: standardSetVersion(criteria).digest,
    planDigest: startPlanDigest(tasks, edges),
  };
}

/**
 * The plan a request was made about: each task by its id and the criterion it serves, and every
 * prerequisite edge — sorted, so the digest is a property of the plan and not of the order it was
 * read in. A task filed, cancelled, moved in or out, re-pointed at another criterion, or an edge
 * added or removed, is a different plan.
 */
export function startPlanDigest(
  tasks: ReadonlyArray<{ id: string; criterionDefinitionId: string | null }>,
  edges: ReadonlyArray<{ taskId: string; dependsOnTaskId: string }>,
): string {
  const plan = {
    version: 1,
    tasks: tasks.map((task) => `${task.id}:${task.criterionDefinitionId ?? ''}`).sort(),
    edges: edges.map((edge) => `${edge.taskId}>${edge.dependsOnTaskId}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/**
 * Whether a task is one somebody has to run: not DONE, not an independent-verification gate row
 * (`VERIFICATION_PASSED` with nothing it verifies) and not an aggregate parent — the rows
 * `manualRunnableTaskSql` never starts, because there is no work of their own to start.
 */
function runsWork(task: StartPlanTask, parents: ReadonlySet<string>): boolean {
  if (task.status === TaskStatus.DONE) return false;
  if (task.completionPolicy === 'VERIFICATION_PASSED' && !task.verifiesTaskId) return false;
  return task.completionPolicy === 'MANUAL' || !parents.has(task.id);
}

const taskRefs = (tasks: readonly StartPlanTask[]) =>
  tasks.map((task) => ({ taskId: task.id, title: task.title }));

/**
 * Whether a task LOOKS like work that produces no code: settled by the owner's confirmation, or by
 * an evidence judgment with no command to run — a rollout, a walkthrough, a review. A guess, which
 * is why what reads it only warns: an EVIDENCE_JUDGMENT task can be UI work whose evidence is
 * screenshots of the code it wrote.
 */
function looksCodeless(task: StartPlanTask): boolean {
  return task.completionCriterion === 'OWNER_CONFIRMED'
    || (task.completionCriterion === 'EVIDENCE_JUDGMENT' && !task.acceptanceCommand);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Every finding about starting this plan with these settings, refusals first and each group in a
 * fixed order — the same plan and settings read twice give the same list.
 */
export function startReadiness(
  plan: StartPlan,
  settings: ProjectStartSettings,
): ProjectStartFinding[] {
  const refusals: ProjectStartFinding[] = [];
  const warnings: ProjectStartFinding[] = [];
  const finding = (
    severity: ProjectStartFinding['severity'],
    code: ProjectStartFinding['code'],
    message: string,
    requiredAction: string,
    about: Partial<Pick<ProjectStartFinding, 'criterion' | 'tasks'>> = {},
  ): void => {
    (severity === 'REFUSE' ? refusals : warnings).push({
      severity,
      code,
      message,
      requiredAction,
      criterion: about.criterion ?? null,
      tasks: about.tasks ?? [],
    });
  };

  if (plan.criteria.length === 0) {
    finding('REFUSE', 'START_NO_CRITERIA',
      'this project states no acceptance criteria, so there is nothing to derive done from',
      'State what would settle the project as acceptanceCriteriaItems (project_update), then ask again.');
  }
  if (plan.tasks.length === 0) {
    finding('REFUSE', 'START_NO_TASKS',
      'this project has no tasks, so starting it would start nothing',
      'File the plan as tasks under this project (task_create or task_create_batch with its '
        + 'projectId), then ask again.');
  }
  const served = new Set(plan.tasks.map((task) => task.criterionDefinitionId));
  if (plan.tasks.length > 0) {
    for (const criterion of plan.criteria) {
      if (served.has(criterion.definitionId)) continue;
      finding('REFUSE', 'START_CRITERION_UNSERVED',
        `no task serves criterion ${criterion.ordinal}, so nothing would ever satisfy it`,
        `File a task for it, or point one at it: criterionKey ${criterion.key} on task_create or `
          + 'task_update.',
        { criterion: { key: criterion.key, ordinal: criterion.ordinal, text: criterion.text } });
    }
  }
  // A criterion whose landing rests only on work that looks codeless and does not say so. Work
  // declared codeless leaves the landing conjunction (§1.4); work that is not, and never has a
  // commit, can hold the criterion off LANDED — and the project off done — after everything is met,
  // which is how the rollout task of 2026-10-01 held its project. Only warned: the look is a guess.
  for (const criterion of plan.criteria) {
    const landing = plan.tasks.filter((task) =>
      task.criterionDefinitionId === criterion.definitionId && !task.codeless);
    if (landing.length === 0 || !landing.every(looksCodeless)) continue;
    finding('WARN', 'START_CRITERION_CODELESS_UNDECLARED',
      `criterion ${criterion.ordinal} is served only by work that looks like it produces no code `
        + '(OWNER_CONFIRMED, or EVIDENCE_JUDGMENT with no acceptance command) and none of it '
        + 'declares codeless: work with no commit to land can hold the criterion off LANDED, and '
        + 'the project off done',
      'Declare the tasks that produce no code codeless — codeless on task_create, or task_update '
        + 'with codeless and a codelessReason — and leave the ones that will commit code as they are.',
      {
        criterion: { key: criterion.key, ordinal: criterion.ordinal, text: criterion.text },
        tasks: taskRefs(landing),
      });
  }
  const parents = new Set(plan.tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  const running = plan.tasks.filter((task) => runsWork(task, parents));
  const unrunnable = running.filter((task) => !task.assignee?.runnerId || !task.assignee.enabled);
  if (unrunnable.length > 0) {
    finding('REFUSE', 'START_TASK_HAS_NO_RUNNER',
      `${count(unrunnable.length, 'task is', 'tasks are')} not assigned to an enabled workspace `
        + 'bound to a runner, so nothing would start them',
      'Assign each one to a workspace on a runner (task_update assigneeId), then ask again.',
      { tasks: taskRefs(unrunnable) });
  }
  const mergeCheck = settings.mergeCheckCommand?.trim() || null;
  if (!plan.repository && (settings.line === 'PROJECT_BRANCH' || mergeCheck)) {
    finding('REFUSE', 'START_REPOSITORY_UNKNOWN',
      settings.line === 'PROJECT_BRANCH'
        ? 'tasks are to land on a project branch, and this project names no repository to hold one: '
          + 'its coordination workspace has no recorded remote'
        : 'a merge check needs a repository to run on, and this project names none: its '
          + 'coordination workspace has no recorded remote',
      'Wait for the runner to detect origin, or set Repository URL in the coordination workspace '
        + 'settings. For a project without a repository, suggest line MAIN with no merge check.');
  }

  const byHand = running.filter((task) => !task.autoRunWhenReady);
  if (byHand.length > 0) {
    finding('WARN', 'START_TASKS_START_BY_HAND',
      `${count(byHand.length, 'task is', 'tasks are')} set to start by hand (autoRunWhenReady=false): `
        + 'they wait for the coordinator even after the project starts',
      'Set autoRunWhenReady on the ones Orbit should start by itself, or start them with task_start '
        + 'once the project has started.',
      { tasks: taskRefs(byHand) });
  }
  if (settings.automatic && settings.line === 'PROJECT_BRANCH' && !mergeCheck) {
    finding('WARN', 'START_NO_MERGE_CHECK',
      'Automatic is on and tasks land on a project branch with no merge check: the branch would '
        + 'merge into main with nothing run on the combined tree',
      'Suggest a mergeCheckCommand — the command that proves the combined tree works.');
  }
  return [...refusals, ...warnings];
}

/** The line under the item's title: the settings the coordinator suggests, in the card's words. */
export function startRequestDetailLine(projectId: string, request: ProjectStartRequest): string {
  const { settings } = request;
  const line = settings.line === 'MAIN'
    ? 'Directly into main'
    : branchName(settings.projectBranchName ?? projectBranchRef(projectId));
  return [
    line,
    `Automatic ${settings.automatic ? 'on' : 'off'}`,
    `${count(settings.maxConcurrentTasks, 'task', 'tasks')} at a time`,
    settings.mergeCheckCommand ? 'merge check set' : 'no merge check',
  ].join(' · ');
}

/**
 * Supersede this project's open start request if the plan it was made about has moved: the criteria
 * were edited, or a task or an edge was filed, cancelled or re-pointed since.
 *
 * Called by every read that puts a request in front of somebody, before it reads the items, so a
 * card is never drawn for a plan that is no longer there. One conditional statement: whatever else
 * ended the request first — a newer request, a start — leaves it alone, since only an OPEN row
 * matches.
 */
export async function supersedeStaleStartRequest(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
): Promise<boolean> {
  const open = await prisma.projectOpenItem.findFirst({
    where: { projectId, ownerId, kind: START_REQUEST_KIND, state: 'OPEN' },
    select: { id: true, payload: true },
  });
  if (!open) return false;
  const request = open.payload as unknown as ProjectStartRequest;
  const plan = await readStartPlan(prisma as unknown as Prisma.TransactionClient, ownerId, projectId);
  const moved = [
    ...(request.criteriaDigest !== plan.criteriaDigest ? ['criteria'] : []),
    ...(request.planDigest !== plan.planDigest ? ['tasks or their dependencies'] : []),
  ];
  if (moved.length === 0) return false;
  const superseded = await prisma.projectOpenItem.updateMany({
    where: { id: open.id, state: 'OPEN' },
    data: {
      state: 'SUPERSEDED',
      resolvedAt: new Date(),
      resolvedBy: 'PLATFORM',
      resolutionNote: `the plan changed after the request: its ${moved.join(' and ')}`,
    },
  });
  return superseded.count > 0;
}

/**
 * The start answers the request: every open start request of the project is resolved APPROVED, by
 * the owner, at the start's own instant — the one the card named, and any other, since a started
 * project has nothing left to ask. A participant of the start's transaction, after its project lock.
 */
export async function answerStartRequests(
  tx: Prisma.TransactionClient,
  answer: { ownerId: string; projectId: string; at: Date },
): Promise<void> {
  await tx.projectOpenItem.updateMany({
    where: { projectId: answer.projectId, kind: START_REQUEST_KIND, state: 'OPEN' },
    data: {
      state: 'RESOLVED',
      resolution: 'APPROVED',
      resolvedAt: answer.at,
      resolvedBy: 'USER',
      resolvedByUserId: answer.ownerId,
    },
  });
}
