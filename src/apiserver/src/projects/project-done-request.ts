import { createHash } from 'node:crypto';

import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import type {
  AcceptedGap,
  DoneRequest,
  DoneRequestGap,
  OpenItemKind,
  ProjectDoneFinding,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import {
  IN_FLIGHT_JOB_STATES,
  LANDING_JOB_KINDS,
  LANDING_REASON_SERVING_WORK_SELECT,
  criterionLandingReason,
  type CriterionLandingReason,
} from './criterion-landing-reason';
import {
  criteriaFromDefinitions,
  criterionKeyOf,
  standardSetVersion,
  type StatedAcceptanceCriterion,
} from './project-acceptance';
import {
  criterionLanding,
  readLandingBranches,
  taskHasNothingToLand,
  taskLanding,
  type CriterionLanding,
} from './project-criterion-landing';
import { readCriterionSatisfaction } from './project-criterion-satisfaction';
import { START_REQUEST_KIND } from './project-start-request';

/**
 * A coordinator asking its owner to record the project done (`project_request_done`), and the
 * owner's answer.
 *
 * The request is an open item of its own kind, `DONE_REQUEST`, with the owner on it from birth: the
 * coordinator's call, every gap Orbit cannot prove, and the seal of the criteria it was made about
 * (`DoneRequest`, `@orbit/shared`). It is what the owner's "Is this project done?" card is drawn
 * from. The owner answers it on `POST /projects/:id/done` (`ProjectAcceptanceService.
 * recordProjectDone`), which writes the project's DONE and resolves the request in one transaction
 * (`answerDoneRequests`), and refuses with nothing written when the request is no longer open or
 * the criteria have moved since it was made.
 *
 * WHAT HAS TO BE TRUE FIRST. The project is checked before anything is filed, in
 * `task-plan-preflight`'s shape, as the start request is (`project-start-request.ts`): `REFUSE`
 * findings stop the request (409 `DONE_REQUEST_NOT_READY`, every finding at once) — a criterion its
 * work has not met, work still running, queued or IN_PROGRESS, an open item waiting on the owner, a
 * landing or a merge into main queued or running — and `WARN` findings are filed with it: every
 * criterion not LANDED, with why (`criterion-landing-reason.ts`). `doneReadiness` is pure, and the
 * facts it reads are `readDoneState`'s.
 *
 * ONE AT A TIME, AND ONLY WHILE IT IS TRUE. A project holds at most one open request (the dedupe
 * key every request shares, under 0278's partial unique index on OPEN items). A newer request
 * supersedes the one open, and so does the project moving under it: a request names the seal of the
 * criteria and a digest of the tasks, their runs, where each criterion's work has landed and the
 * landings in flight, and one whose project has moved since is superseded the next time it is read
 * (`supersedeStaleDoneRequest`) — and refused at the owner's press before that. So nobody is shown
 * "Is this project done?" about a project that is no longer the one the coordinator checked.
 */

export const DONE_REQUEST_KIND = 'DONE_REQUEST';
/** Every request of a project shares this key, so at most one of them is OPEN (0278's index). */
export const DONE_REQUEST_DEDUPE_KEY = 'DONE_REQUEST';
/** The item's title: the card's own question. */
export const DONE_REQUEST_TITLE = 'Is this project done?';

/** Only the conversation a project is coordinated from may ask to record it done. */
export const DONE_REQUEST_COORDINATOR_ONLY = 'DONE_REQUEST_COORDINATOR_ONLY';
export const DONE_REQUEST_NOT_READY = 'DONE_REQUEST_NOT_READY';
/** The owner's Not yet… door can only end an OPEN DONE_REQUEST. */
export const DONE_REQUEST_NOT_OPEN = 'DONE_REQUEST_NOT_OPEN';
/** Validation code shared by the DTO-facing and direct service-facing doors. */
export const DONE_REQUEST_DECLINE_NOTE_REQUIRED = 'DONE_REQUEST_DECLINE_NOTE_REQUIRED';

/** Bounds on what a request carries: a call is a sentence or two, and a gap is read on a card. */
export const MAX_DONE_REQUEST_JUDGMENT = 2_000;
export const MAX_DONE_REQUEST_GAPS = 100;
export const MAX_DONE_REQUEST_GAP_TITLE = 200;
export const MAX_DONE_REQUEST_GAP_TEXT = 2_000;
export const MAX_DONE_REQUEST_EVIDENCE_REFS = 20;
export const MAX_DONE_REQUEST_EVIDENCE_REF = 500;
/** The owner's explanation is a card-sized sentence, not an unbounded report. */
export const MAX_DONE_REQUEST_DECLINE_NOTE = 2_000;

/** One criterion, as the check reads it. */
export interface DoneStateCriterion {
  stated: StatedAcceptanceCriterion;
  satisfied: boolean;
  /** The work holding it unmet, as the satisfaction lane names it; empty when nothing is filed. */
  heldUpBy: Array<{ taskId: string; title: string }>;
  landing: CriterionLanding;
  /** Why it is not LANDED (`criterion-landing-reason.ts`); null when it is. */
  reason: CriterionLandingReason | null;
  /** The serving work that has something to land and is not on the upstream. */
  heldOffLanded: Array<{ taskId: string; title: string }>;
}

/** One task of the project, as the check reads it. */
export interface DoneStateTask {
  id: string;
  title: string;
  status: TaskStatus;
  criterionDefinitionId: string | null;
  /** A run of it is going, or waiting for a runner — never the asking conversation's own. */
  run: 'RUNNING' | 'QUEUED' | null;
}

/** Everything the check and the digest read: the project as it stands. */
export interface DoneState {
  criteria: DoneStateCriterion[];
  /** Every task of the project, cancelled ones included, oldest first. */
  tasks: DoneStateTask[];
  /** The open items waiting on the owner, oldest first — this kind's own excepted. */
  ownerItems: Array<{ itemId: string; kind: OpenItemKind; title: string }>;
  /** The landings and merges into main queued or running, oldest first. */
  jobs: Array<{ integrationJobId: string; kind: string; state: string; taskId: string | null }>;
  criteriaDigest: string;
  stateDigest: string;
}

/**
 * The project as a done request reads it, once.
 *
 * `askingSessionId` is the conversation the request is (or was) made from: its own run is not work
 * in flight, since asking is what it is doing. The criteria, their landing and its reasons come out
 * of one read of the serving work — the landing lane's own select, spread by
 * `LANDING_REASON_SERVING_WORK_SELECT` — so a reason can never be about a different landing than
 * the one it explains; whether each criterion is met is the satisfaction lane's answer, the one
 * `derivedDone` folds.
 */
export async function readDoneState(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  askingSessionId: string | null,
): Promise<DoneState> {
  const definitions = await tx.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      text: true,
      verificationMethod: true,
      completionCriterionOverrideReason: true,
      revision: true,
      contentHash: true,
      servingTasks: {
        where: { ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { ...LANDING_REASON_SERVING_WORK_SELECT, title: true },
      },
    },
  });
  const stated = criteriaFromDefinitions(definitions);
  const satisfaction = new Map(
    (await readCriterionSatisfaction(tx, ownerId, projectId)).map((row) => [row.definitionId, row]),
  );
  const branches = await readLandingBranches(tx, projectId);
  const landing = new Map(
    criterionLanding(definitions, branches).map((row) => [row.definitionId, row.landing]),
  );
  const jobs = (await tx.projectIntegrationJob.findMany({
    where: {
      projectId,
      ownerId,
      kind: { in: [...LANDING_JOB_KINDS] },
      state: { in: [...IN_FLIGHT_JOB_STATES] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, state: true, taskId: true },
  })).map((job) => ({
    integrationJobId: job.id,
    kind: job.kind,
    state: job.state,
    taskId: job.taskId,
  }));

  const criteria = stated.map((criterion): DoneStateCriterion => {
    const definition = definitions.find((row) => row.id === criterion.definitionId)!;
    const met = satisfaction.get(criterion.definitionId);
    const landed = landing.get(criterion.definitionId) ?? ('UNKNOWN' satisfies CriterionLanding);
    const heldUpBy = new Map<string, string>();
    for (const unmet of met?.unmet ?? []) {
      for (const task of unmet.heldUpBy) heldUpBy.set(task.taskId, task.title);
    }
    return {
      stated: criterion,
      satisfied: met?.satisfied ?? false,
      heldUpBy: [...heldUpBy].map(([taskId, title]) => ({ taskId, title })),
      landing: landed,
      reason: landed === 'LANDED'
        ? null
        : criterionLandingReason(
          { landing: landed, servingTasks: definition.servingTasks },
          branches,
          jobs.map((job) => ({ kind: job.kind, taskId: job.taskId })),
        ) ?? 'NO_RECEIPT',
      heldOffLanded: landed === 'LANDED'
        ? []
        : definition.servingTasks
          .filter((task) => !taskHasNothingToLand(task)
            && taskLanding(task.mergeReceipts, branches) !== 'ON_UPSTREAM')
          .map((task) => ({ taskId: task.id, title: task.title })),
    };
  });

  const rows = await tx.task.findMany({
    where: { projectId, ownerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, status: true, criterionDefinitionId: true },
  });
  // Joined through the task rather than listed by id: a project's task count is unbounded, and an
  // IN list of every id would be a statement with as many parameters.
  const runs = await tx.session.findMany({
    where: {
      ownerId,
      status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      task: { projectId },
      ...(askingSessionId ? { id: { not: askingSessionId } } : {}),
    },
    select: { taskId: true, status: true },
  });
  const running = new Set(
    runs.filter((run) => run.status === RunStatus.RUNNING).map((run) => run.taskId),
  );
  const queued = new Set(
    runs.filter((run) => run.status === RunStatus.PENDING).map((run) => run.taskId),
  );
  const tasks = rows.map((task): DoneStateTask => ({
    ...task,
    run: running.has(task.id) ? 'RUNNING' : queued.has(task.id) ? 'QUEUED' : null,
  }));

  const ownerItems = (await tx.projectOpenItem.findMany({
    where: {
      projectId,
      ownerId,
      state: 'OPEN',
      assignee: 'OWNER',
      kind: { not: DONE_REQUEST_KIND },
      // A start request left open beside a start asks nobody anything (`project-list-attention.ts`).
      NOT: { kind: START_REQUEST_KIND, project: { startedAt: { not: null } } },
    },
    orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, title: true },
  })).map((item) => ({ itemId: item.id, kind: item.kind as OpenItemKind, title: item.title }));

  return {
    criteria,
    tasks,
    ownerItems,
    jobs,
    criteriaDigest: standardSetVersion(stated).digest,
    stateDigest: doneStateDigest(criteria, tasks, jobs),
  };
}

/**
 * What a done request was made about, apart from the criteria themselves: every task by its id, its
 * status, the criterion it serves and whether a run of it is going; every criterion by whether it is
 * met, where its work has landed and why not; and the landings in flight. Sorted, so the digest is a
 * property of the project and not of the order it was read in. A task filed, reopened, cancelled or
 * started, a receipt recorded, a landing queued or finished — each is a different state.
 */
export function doneStateDigest(
  criteria: readonly DoneStateCriterion[],
  tasks: readonly DoneStateTask[],
  jobs: DoneState['jobs'],
): string {
  const state = {
    version: 1,
    tasks: tasks
      .map((task) => `${task.id}:${task.status}:${task.criterionDefinitionId ?? ''}:${task.run ?? ''}`)
      .sort(),
    criteria: criteria
      .map((criterion) => `${criterion.stated.definitionId}:${criterion.satisfied ? 1 : 0}:`
        + `${criterion.landing}:${criterion.reason ?? ''}`)
      .sort(),
    jobs: jobs.map((job) => `${job.integrationJobId}:${job.state}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const criterionRef = (criterion: DoneStateCriterion) => ({
  key: criterion.stated.key,
  ordinal: criterion.stated.ordinal,
  text: criterion.stated.text,
});

/** What a criterion not LANDED is waiting on, and what the coordinator can do about it. */
const UNLANDED: Record<CriterionLandingReason, (ordinal: number) => [string, string]> = {
  IN_FLIGHT: (n) => [
    `criterion ${n} is not on main yet: a landing of its work, or a merge into main, is queued or `
      + 'running',
    'Wait for it to finish; Orbit reads the landing again when it does.',
  ],
  ON_PROJECT_BRANCH: (n) => [
    `criterion ${n}'s work is on the project branch and not yet on main`,
    'It reaches main when the project branch is merged into main. If the owner should record the '
      + 'project done before that, name it as a gap with what you checked.',
  ],
  NOTHING_TO_LAND: (n) => [
    `criterion ${n}'s work made no commits of its own, so there is nothing to land and no merge for a `
      + 'receipt to record',
    'Name it as a gap: why Orbit cannot prove it, and what you checked instead.',
  ],
  NO_RECEIPT: (n) => [
    `Orbit holds no merge receipt putting criterion ${n}'s work on main`,
    'If it is on main by a path Orbit did not see, name it as a gap with what you checked; if it is '
      + 'not, land it first.',
  ],
  CODELESS: (n) => [
    `criterion ${n}'s work ran no branch, so nothing of it can land`,
    'Name it as a gap: why Orbit cannot prove it, and what you checked instead.',
  ],
};

/**
 * Every finding about recording this project done, refusals first and each group in a fixed order —
 * the same project and gaps read twice give the same list.
 */
export function doneReadiness(
  state: DoneState,
  gaps: ReadonlyArray<Pick<AcceptedGap, 'criterionKey'>>,
): ProjectDoneFinding[] {
  const refusals: ProjectDoneFinding[] = [];
  const warnings: ProjectDoneFinding[] = [];
  const finding = (
    severity: ProjectDoneFinding['severity'],
    code: ProjectDoneFinding['code'],
    message: string,
    requiredAction: string,
    about: Partial<Pick<ProjectDoneFinding, 'criterion' | 'reason' | 'tasks' | 'items' | 'jobs'>> = {},
  ): void => {
    (severity === 'REFUSE' ? refusals : warnings).push({
      severity,
      code,
      message,
      requiredAction,
      criterion: about.criterion ?? null,
      reason: about.reason ?? null,
      tasks: about.tasks ?? [],
      items: about.items ?? [],
      jobs: about.jobs ?? [],
    });
  };

  if (state.criteria.length === 0) {
    finding('REFUSE', 'DONE_NO_CRITERIA',
      'this project states no acceptance criteria, so there is nothing to record it done against',
      'State what would settle the project as acceptanceCriteriaItems (project_update), then ask '
        + 'again.');
  }
  for (const criterion of state.criteria) {
    if (criterion.satisfied) continue;
    const ordinal = criterion.stated.ordinal;
    finding('REFUSE', 'DONE_CRITERION_UNSATISFIED',
      criterion.heldUpBy.length > 0
        ? `criterion ${ordinal} is not met: ${count(criterion.heldUpBy.length, 'task', 'tasks')} `
          + 'serving it has not settled'
        : `criterion ${ordinal} is not met: no task serves it`,
      criterion.heldUpBy.length > 0
        ? 'Settle the work named here — each task by its own completion criterion — then ask again.'
        : `File a task for it, or point one at it: criterionKey ${criterion.stated.key} on task_create `
          + 'or task_update.',
      { criterion: criterionRef(criterion), tasks: criterion.heldUpBy });
  }
  const moving = state.tasks.filter(
    (task) => task.run !== null || task.status === TaskStatus.IN_PROGRESS,
  );
  if (moving.length > 0) {
    finding('REFUSE', 'DONE_TASKS_IN_FLIGHT',
      `${count(moving.length, 'task is', 'tasks are')} still running, queued for a runner or `
        + 'IN_PROGRESS, so the project is still moving',
      'Let them finish (task_await), or cancel the ones no longer wanted, then ask again.',
      { tasks: moving.map((task) => ({ taskId: task.id, title: task.title })) });
  }
  if (state.ownerItems.length > 0) {
    finding('REFUSE', 'DONE_OWNER_ITEMS_OPEN',
      `${count(state.ownerItems.length, 'item is', 'items are')} waiting on the owner, and a project `
        + 'is not recorded done over them',
      'Have each one answered or handled — or withdraw a question of your own with '
        + 'open_item_resolve — then ask again.',
      { items: state.ownerItems });
  }
  if (state.jobs.length > 0) {
    finding('REFUSE', 'DONE_INTEGRATION_IN_FLIGHT',
      `${count(state.jobs.length, 'landing or merge into main is',
        'landings or merges into main are')} queued or running, so where the work ends up is not `
        + 'settled yet',
      'Wait for them to finish — Orbit reads the landing again when they do — then ask again.',
      { jobs: state.jobs });
  }

  const named = new Set(gaps.map((gap) => gap.criterionKey));
  for (const criterion of state.criteria) {
    if (criterion.landing === 'LANDED') continue;
    const reason = criterion.reason ?? 'NO_RECEIPT';
    const [message, requiredAction] = UNLANDED[reason](criterion.stated.ordinal);
    finding('WARN', 'DONE_CRITERION_UNLANDED',
      named.has(criterion.stated.key) ? message : `${message}; none of the gaps names it`,
      requiredAction,
      { criterion: criterionRef(criterion), reason, tasks: criterion.heldOffLanded });
  }
  return [...refusals, ...warnings];
}

/**
 * The gaps as the request files them, or the first thing wrong with them, by index — a shape the
 * owner's card cannot draw is refused before anything is read. Every part of a gap is trimmed and
 * required but its title; a criterion key may be the key `project_get` gives or the definition's
 * uuid, and is filed as the key. Several gaps may name one criterion.
 */
export function normalizeDoneRequestGaps(
  given: unknown,
): { gaps: DoneRequestGap[] } | { problem: string } {
  if (!Array.isArray(given)) {
    return { problem: 'gaps must be an array: one entry per thing Orbit cannot prove, or [] for none' };
  }
  if (given.length > MAX_DONE_REQUEST_GAPS) {
    return { problem: `at most ${MAX_DONE_REQUEST_GAPS} gaps` };
  }
  const gaps: DoneRequestGap[] = [];
  for (const [index, raw] of given.entries()) {
    const gap = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = (field: string, max: number, required: boolean): string | null | undefined => {
      const value = gap[field];
      if (value === undefined || value === null) return required ? null : undefined;
      if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return null;
      return value.trim();
    };
    const at = `gaps[${index}]`;
    const criterionKey = text('criterionKey', 64, true);
    if (!criterionKey) {
      return { problem: `${at}.criterionKey is required: the key of the criterion it is about, as `
        + 'project_get gives it' };
    }
    const title = text('title', MAX_DONE_REQUEST_GAP_TITLE, false);
    if (title === null) {
      return { problem: `${at}.title, when given, is a few words (at most `
        + `${MAX_DONE_REQUEST_GAP_TITLE} characters)` };
    }
    const whyNotProven = text('whyNotProven', MAX_DONE_REQUEST_GAP_TEXT, true);
    if (!whyNotProven) {
      return { problem: `${at}.whyNotProven is required: why Orbit cannot prove this criterion (at `
        + `most ${MAX_DONE_REQUEST_GAP_TEXT} characters)` };
    }
    const coordinatorChecked = text('coordinatorChecked', MAX_DONE_REQUEST_GAP_TEXT, true);
    if (!coordinatorChecked) {
      return { problem: `${at}.coordinatorChecked is required: what you checked instead (at most `
        + `${MAX_DONE_REQUEST_GAP_TEXT} characters)` };
    }
    const refs = gap.evidenceRefs;
    const evidenceRefs = Array.isArray(refs)
      ? refs.filter((ref): ref is string => typeof ref === 'string').map((ref) => ref.trim())
      : [];
    if (!Array.isArray(refs) || evidenceRefs.length !== refs.length || evidenceRefs.length === 0
      || evidenceRefs.length > MAX_DONE_REQUEST_EVIDENCE_REFS
      || evidenceRefs.some((ref) => !ref || ref.length > MAX_DONE_REQUEST_EVIDENCE_REF)) {
      return { problem: `${at}.evidenceRefs is required: 1 to ${MAX_DONE_REQUEST_EVIDENCE_REFS} `
        + 'references to where that evidence is — a task, a comment, a commit, a URL' };
    }
    gaps.push({
      criterionKey: criterionKeyOf(criterionKey),
      ...(title ? { title } : {}),
      whyNotProven,
      coordinatorChecked,
      evidenceRefs,
    });
  }
  return { gaps };
}

/** The line under the item's title, in the project page's words. */
export function doneRequestDetailLine(request: DoneRequest): string {
  return `The coordinator asked · ${count(request.gaps.length, 'gap', 'gaps')} it couldn’t prove`;
}

/**
 * What the coordinator receives when the owner presses Not yet… .
 *
 * This is deliberately built from the request snapshot and the settled note, rather than from a
 * later project read.  The card may be answered after the project moved, and the useful context is
 * exactly what the coordinator asked the owner to judge: its judgment, every gap and every warning.
 * Keeping the rendering deterministic also lets the item/session turn key make a replay byte-for-
 * byte identical to the first delivery.
 */
export function doneRequestDeclineMessage(
  request: DoneRequest,
  note: string,
  declinedAt: Date,
): string {
  const gaps = request.gaps.length > 0
    ? request.gaps.map((gap, index) => {
      const title = gap.title ? ` — ${gap.title}` : '';
      const evidence = gap.evidenceRefs?.length
        ? ` Evidence: ${gap.evidenceRefs.join(', ')}`
        : '';
      return `${index + 1}. [${gap.criterionKey}]${title}: ${gap.whyNotProven ?? 'not proven'} `
        + `Coordinator checked: ${gap.coordinatorChecked ?? 'not recorded'}.${evidence}`;
    }).join('\n')
    : 'None recorded.';
  const warnings = request.warnings?.length
    ? request.warnings.map((warning, index) => {
      const criterion = warning.criterion
        ? ` [${warning.criterion.key}] ${warning.criterion.text}`
        : '';
      const reason = warning.reason ? ` (${warning.reason})` : '';
      const tasks = warning.tasks?.length
        ? ` Tasks: ${warning.tasks.map((task) => `${task.taskId} — ${task.title}`).join('; ')}`
        : '';
      const items = warning.items?.length
        ? ` Items: ${warning.items.map((item) => `${item.itemId} — ${item.title}`).join('; ')}`
        : '';
      const jobs = warning.jobs?.length
        ? ` Jobs: ${warning.jobs.map((job) => `${job.integrationJobId} — ${job.kind} (${job.state})`).join('; ')}`
        : '';
      return `${index + 1}. [${warning.severity}/${warning.code}] ${warning.message}`
        + `${criterion}${reason} Next: ${warning.requiredAction}${tasks}${items}${jobs}`;
    }).join('\n')
    : 'None.';
  return [
    `From Orbit · owner says not yet for “${DONE_REQUEST_TITLE}”.`,
    `What’s missing before it’s done? ${note}`,
    `Coordinator judgment: ${request.judgment}`,
    'Gaps the coordinator named:',
    gaps,
    'Warnings on the card:',
    warnings,
    'After the missing work is complete, call project_request_done again.',
    `Answered at ${declinedAt.toISOString()}.`,
  ].join('\n');
}

/**
 * What has moved under a request since it was made, in a reader's words — empty while it still
 * describes the project. A request filed without the check (no `stateDigest`) is held to its seal
 * alone.
 */
export async function doneRequestMoved(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  request: { payload: Prisma.JsonValue; askedBySessionId: string | null },
): Promise<string[]> {
  const asked = request.payload as unknown as Partial<DoneRequest> | null;
  const state = await readDoneState(tx, ownerId, projectId, request.askedBySessionId);
  return [
    ...(asked?.criteriaDigest !== state.criteriaDigest ? ['criteria'] : []),
    ...(asked?.stateDigest !== undefined && asked.stateDigest !== state.stateDigest
      ? ['tasks, their runs or where their work has landed']
      : []),
  ];
}

/**
 * Supersede this project's open done request if the project has moved under it: its criteria, its
 * tasks or their runs, or where the work has landed — or it is no longer OPEN.
 *
 * Called by every read that puts a request in front of somebody, before it reads the items, so the
 * card is never drawn for a project that is not the one the coordinator checked. One conditional
 * statement: whatever else ended the request first — a newer request, the owner's DONE — leaves it
 * alone, since only an OPEN row matches.
 */
export async function supersedeStaleDoneRequest(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
): Promise<boolean> {
  const open = await prisma.projectOpenItem.findFirst({
    where: { projectId, ownerId, kind: DONE_REQUEST_KIND, state: 'OPEN' },
    select: { id: true, payload: true, askedBySessionId: true, project: { select: { status: true } } },
  });
  if (!open) return false;
  let note: string;
  if (open.project.status !== 'OPEN') {
    note = `the project is ${open.project.status} now, so there is nothing left to ask`;
  } else {
    const moved = await doneRequestMoved(
      prisma as unknown as Prisma.TransactionClient, ownerId, projectId, open,
    );
    if (moved.length === 0) return false;
    note = `the project changed after the request: its ${moved.join(' and ')}`;
  }
  const superseded = await prisma.projectOpenItem.updateMany({
    where: { id: open.id, state: 'OPEN' },
    data: {
      state: 'SUPERSEDED',
      resolvedAt: new Date(),
      resolvedBy: 'PLATFORM',
      resolutionNote: note,
    },
  });
  return superseded.count > 0;
}

/**
 * WHICH OF THESE PROJECTS ARE READY TO CLOSE: OPEN, and holding the request its coordinator filed
 * (`DONE_REQUEST`, `project_request_done`) — the projects whose coordinator conversation draws the
 * "Is this project done?" card, and whose row says "Ready to close" (`sessionWaitingKind`).
 *
 * One read. A request whose project has since moved is still OPEN here until the next read of the
 * open items supersedes it — the read that puts the card in front of the owner — exactly as a start
 * request's badge is (`projectsReadyToStart`).
 */
export async function projectsReadyToClose(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectIds: readonly string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const requests = await tx.projectOpenItem.findMany({
    where: {
      ownerId,
      projectId: { in: [...projectIds] },
      kind: DONE_REQUEST_KIND,
      state: 'OPEN',
      project: { status: 'OPEN' },
    },
    select: { projectId: true },
  });
  return new Set(requests.map((request) => request.projectId));
}

/**
 * The owner's DONE answers the request: the one the card named, or — when the owner records the
 * project done without being asked — whichever is open, since a project recorded done has nothing
 * left to ask. Resolved APPROVED, by the owner, at the record's own instant, with the gaps they
 * accepted as the answer. A participant of `recordProjectDone`'s transaction, after its project
 * lock and the request's.
 */
export async function answerDoneRequests(
  tx: Prisma.TransactionClient,
  answer: {
    ownerId: string;
    projectId: string;
    requestId: string | null;
    at: Date;
    acceptedGaps: readonly AcceptedGap[];
  },
): Promise<void> {
  await tx.projectOpenItem.updateMany({
    where: {
      projectId: answer.projectId,
      kind: DONE_REQUEST_KIND,
      state: 'OPEN',
      ...(answer.requestId !== null ? { id: answer.requestId } : {}),
    },
    data: {
      state: 'RESOLVED',
      resolution: 'APPROVED',
      resolvedAt: answer.at,
      resolvedBy: 'USER',
      resolvedByUserId: answer.ownerId,
      answer: answer.acceptedGaps as unknown as Prisma.InputJsonValue,
    },
  });
}
