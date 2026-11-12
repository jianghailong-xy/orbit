import { RunStatus, TaskStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { criterionStandingRefusal } from '../tasks/task-evidence-decision';
import {
  heldStandard,
  standardDigest,
  undecidableAddressees,
  undecidableEvidenceTurnId,
} from '../tasks/undecidable-evidence';
import {
  COORDINATOR_PAUSE_SELECT,
  type CoordinatorConversationState,
  conversationIsPaused,
  coordinatorHolds,
} from './coordinator-evidence-queue';
import {
  SESSION_ENDING_SELECT,
  conversationIsOver,
  openItemsNoLongerOwed,
  sessionHasEnded,
} from './project-open-item';

/**
 * EVERY PENDING ITEM HAS AN ADDRESSEE, AND WHEN IT WAS TOLD
 * (docs/evidence-always-has-an-addressee-design.md §4, criterion 4 of project 34w9J4ycWBHKATEW1R7Pr).
 *
 * For every unfinished task of a project, the one thing it waits on and who that is waiting for:
 *
 *   * EXCEPTION_ITEM — an open, still owed exception item about the task. Its assignee: the
 *     coordinator conversation (told when the item's turn was queued on it), or the owner (told when
 *     it became theirs, `assignedAt`: from then it is on their Needs-you list). An item owed to a
 *     coordinator the project does not have, or whose conversation is over, has nobody.
 *   * EVIDENCE — the latest evidence revision, unanswered. Decidable: wherever `coordinatorHolds`
 *     places it (held by the coordinator it was delivered to; waiting for the coordinator; else the
 *     owner's card). Undecidable (`criterionStandingRefusal`): whoever `undecidableAddressees` names —
 *     the live run, the Automatic coordinator, the owner — told when the shared undecidable path
 *     (`tellEvidenceUndecidable`) wrote that reader's turn under its key; the owner's Restart row is
 *     drawn from the moment it is theirs.
 *   * TASK_RUN — a run of the task whose conversation has not ended. It is its own addressee, told
 *     when it was started — unless it has reported no progress, taken no turn, and has no background
 *     job running and no wake-up waiting for the project's window (`exceptionEscalationSeconds`),
 *     in which case nobody is moving it.
 *   * DEPENDENCIES — an OPEN task with a prerequisite that is not DONE: the prerequisite's own
 *     addressee, followed down the chain. A prerequisite with nothing of its own pending is the
 *     platform's when it will be started by itself (auto-run, not held), and nobody's otherwise.
 *
 * An item is an ORPHAN when it has nobody, or its addressee was never told — except that what is
 * queued for a coordinator that is paused or in the middle of a turn is the existing queue's to hand
 * over (2026-11-08, `evidence-waits-for-coordinator-design.md`; this read changes no timing rule).
 * Something that changed under a moment ago is not judged yet (`ORPHAN_SETTLE_MS`): a delivery made
 * just after a commit is not a missing one.
 *
 * Each item carries `orphanKey`, naming the item and the state it is in, so whoever reports an
 * orphan can report it once: the same orphan in the same state has the same key, and a dependent
 * waiting on an orphan carries that orphan's key rather than one of its own.
 *
 * A pure read over a transaction client: it writes nothing and decides nothing.
 */

export const PENDING_ITEM_KINDS = ['EXCEPTION_ITEM', 'EVIDENCE', 'TASK_RUN', 'DEPENDENCIES'] as const;
export type PendingItemKind = (typeof PENDING_ITEM_KINDS)[number];

/** Who can move an item: a run of the task, the project's coordinator, the owner, or the platform's own dispatch. */
export type PendingAddresseeKind = 'RUN' | 'COORDINATOR' | 'OWNER' | 'PLATFORM';

/** Why an item has nobody. */
export type NoAddresseeReason =
  /** Owed to a coordinator, and the project has no coordinator conversation. */
  | 'NO_COORDINATOR'
  /** Owed to a coordinator conversation that is over. */
  | 'COORDINATOR_ENDED'
  /** The run has shown no sign of work for the project's window. */
  | 'RUN_QUIET'
  /** A prerequisite with nothing pending that nothing will start or finish by itself. */
  | 'PREREQUISITE_NOT_MOVING'
  /** The prerequisites lead back to the task itself. */
  | 'DEPENDENCY_CYCLE';

/** Why an item that has an addressee carries no `notifiedAt`. */
export type NotNotifiedReason =
  /** Queued for a coordinator that is paused or mid-turn: the existing queue hands it over. */
  | 'QUEUED'
  /** Nothing was ever written to the addressee about it. */
  | 'NEVER_TOLD';

export interface PendingAddressee {
  kind: PendingAddresseeKind;
  /** The conversation, for a RUN or a COORDINATOR. */
  sessionId: string | null;
}

export interface PendingItem {
  taskId: string;
  title: string;
  status: TaskStatus;
  kind: PendingItemKind;
  /** What the item is: the evidence revision, the exception item, the run, the prerequisite task. */
  subjectId: string;
  /** Since when the item has been in the state it is read in. */
  since: Date;
  addressee: PendingAddressee | null;
  addresseeAbsentReason: NoAddresseeReason | null;
  notifiedAt: Date | null;
  notifiedAtAbsentReason: NotNotifiedReason | 'NO_ADDRESSEE' | null;
  /** For DEPENDENCIES: the prerequisite whose item this one is waiting behind. */
  waitsOnTaskId: string | null;
  orphan: boolean;
  /** The item and its state, as the sweep keys its one report; shared by dependents of the same orphan. */
  orphanKey: string;
  /** What the item is, in a sentence. */
  detail: string;
  /** What would move it, in a sentence. */
  needed: string;
}

export interface PendingAddresseeRead {
  projectId: string;
  readAt: Date;
  items: PendingItem[];
}

/** How long a change of state is left to settle before an item without a delivery is called an orphan. */
export const ORPHAN_SETTLE_MS = 5 * 60_000;

const UNFINISHED: readonly TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.FAILED];
const UNSETTLED: readonly TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];
/** How far a dependency chain or a supersession chain is followed. */
const MAX_HOPS = 64;

const TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  projectId: true,
  completionCriterion: true,
  criterionDefinitionId: true,
  criterionRevision: true,
  acceptanceCriteria: true,
  autoRunWhenReady: true,
  dispatchHold: true,
  dispatchAttempt: true,
  supersededByTaskId: true,
  updatedAt: true,
  dependsOn: { select: { dependsOnTaskId: true } },
  progress: { select: { lastProgressAt: true } },
  completionEvidence: {
    orderBy: { revision: 'desc' },
    take: 1,
    select: {
      id: true,
      revision: true,
      criterionRevision: true,
      evidenceDigest: true,
      submittedAt: true,
      evidence: true,
      decisions: { select: { id: true }, take: 1 },
    },
  },
} satisfies Prisma.TaskSelect;
type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

const PROJECT_SELECT = {
  id: true,
  coordinatorEnabled: true,
  exceptionEscalationSeconds: true,
  coordinatorSession: { select: { id: true, ...COORDINATOR_PAUSE_SELECT } },
} satisfies Prisma.ProjectSelect;
type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

type CoordinatorSession = CoordinatorConversationState & { id: string };

/**
 * Whether what is owed to this coordinator conversation is the existing queue's to hand over: it is
 * paused (`conversationIsPaused`), or busy with a turn whose end delivers what waited for it.
 */
function coordinatorTakesItLater(session: CoordinatorSession): boolean {
  if (conversationIsPaused(session)) return true;
  return session.status !== RunStatus.AWAITING_INPUT && session.status !== RunStatus.INTERRUPTED;
}

function later(...dates: Array<Date | null | undefined>): Date {
  return new Date(Math.max(...dates.flatMap((date) => (date ? [date.getTime()] : []))));
}

function taskName(task: { id: string; title: string }): string {
  return `“${task.title}” (${uuidToBase62(task.id)})`;
}

/** The pending items of one project's unfinished tasks, or null when the project is not this owner's. */
export async function readPendingAddressees(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  readAt: Date = new Date(),
): Promise<PendingAddresseeRead | null> {
  const own = await tx.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } });
  if (!own) return null;
  const population = await tx.task.findMany({
    where: { ownerId, projectId, status: { in: [...UNFINISHED] } },
    select: TASK_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  // The prerequisites and successors the population reaches, wherever they are filed.
  const tasks = new Map<string, TaskRow>(population.map((task) => [task.id, task]));
  let frontier = population;
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop += 1) {
    const wanted = [...new Set(frontier.flatMap((task) => [
      ...task.dependsOn.map((edge) => edge.dependsOnTaskId),
      ...(task.supersededByTaskId ? [task.supersededByTaskId] : []),
    ]))].filter((id) => !tasks.has(id));
    if (wanted.length === 0) break;
    frontier = await tx.task.findMany({ where: { ownerId, id: { in: wanted } }, select: TASK_SELECT });
    for (const task of frontier) tasks.set(task.id, task);
  }
  const all = [...tasks.values()];
  const ids = all.map((task) => task.id);

  const projects = new Map<string, ProjectRow>((await tx.project.findMany({
    where: { ownerId, id: { in: [...new Set(all.flatMap((task) => (task.projectId ? [task.projectId] : [])))] } },
    select: PROJECT_SELECT,
  })).map((project) => [project.id, project]));
  const projectOf = (task: TaskRow) => (task.projectId ? projects.get(task.projectId) ?? null : null);

  // EXCEPTION_ITEM: open and still owed, oldest assignment first.
  const items = await tx.projectOpenItem.findMany({
    where: { ownerId, taskId: { in: ids }, state: 'OPEN' },
    select: {
      id: true,
      taskId: true,
      kind: true,
      title: true,
      assignee: true,
      assignedAt: true,
      deliveries: { where: { purpose: 'ITEM', returnedAt: null }, select: { sessionId: true, createdAt: true } },
    },
    orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
  });
  const gone = await openItemsNoLongerOwed(tx, items.map((item) => item.id));
  const itemOfTask = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (!gone.has(item.id) && item.taskId && !itemOfTask.has(item.taskId)) itemOfTask.set(item.taskId, item);
  }

  // EVIDENCE: the latest revision of an unsettled EVIDENCE_JUDGMENT task, with no decision on it.
  const unanswered = all.flatMap((task) => {
    const [latest] = task.completionEvidence;
    return task.completionCriterion === 'EVIDENCE_JUDGMENT' && UNSETTLED.includes(task.status)
      && latest && latest.decisions.length === 0
      ? [{ task, latest }]
      : [];
  });
  const places = await coordinatorHolds(tx, ownerId, unanswered, readAt);
  const standing = new Map<string, string>();
  for (const { task, latest } of unanswered) {
    const refusal = await criterionStandingRefusal(tx, task, latest.evidence);
    if (refusal) standing.set(task.id, refusal.reason);
  }
  const undecidable = unanswered.filter(({ task }) => standing.has(task.id));
  const undecidablePlaces = await undecidableAddressees(tx, ownerId, undecidable.map(({ task }) => task));
  const digests = new Map<string, string>();
  for (const { task } of undecidable) digests.set(task.id, standardDigest(await heldStandard(tx, task)));
  const undecidableTurns = undecidable.length === 0 ? [] : await tx.conversationTurn.findMany({
    where: {
      sessionId: {
        in: [...new Set([...undecidablePlaces.values()].flatMap((placed) => [
          ...placed.liveRunIds,
          ...(placed.coordinatorSessionId ? [placed.coordinatorSessionId] : []),
        ]))],
      },
      clientTurnId: {
        in: undecidable.flatMap(({ task, latest }) => [
          undecidableEvidenceTurnId('run', latest.id, digests.get(task.id)!),
          undecidableEvidenceTurnId('coordinator', latest.id, digests.get(task.id)!),
        ]),
      },
    },
    select: { sessionId: true, clientTurnId: true, createdAt: true },
  });
  const toldAt = (sessionIds: Iterable<string>, clientTurnId: string): Date | null => {
    const within = new Set(sessionIds);
    const times = undecidableTurns
      .filter((turn) => turn.clientTurnId === clientTurnId && within.has(turn.sessionId))
      .map((turn) => turn.createdAt.getTime());
    return times.length === 0 ? null : new Date(Math.min(...times));
  };

  // TASK_RUN: the task's work sessions that have not ended, and what says they are still working.
  const runs = (await tx.session.findMany({
    where: { ownerId, taskId: { in: ids }, startsTaskWork: true },
    select: { id: true, taskId: true, createdAt: true, lastTurnAt: true, runningBgJobs: true, ...SESSION_ENDING_SELECT },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })).filter((run) => !sessionHasEnded(run));
  const runIds = runs.map((run) => run.id);
  const waking = new Set(runIds.length === 0 ? [] : [
    ...(await tx.sessionScheduledWakeup.findMany({
      where: { sessionId: { in: runIds }, state: 'PENDING' }, select: { sessionId: true },
    })).map((row) => row.sessionId),
    ...(await tx.sessionWakeupLoop.findMany({
      where: { sessionId: { in: runIds }, state: 'ACTIVE' }, select: { sessionId: true },
    })).map((row) => row.sessionId),
  ]);

  type Own = Omit<PendingItem, 'taskId' | 'title' | 'status' | 'waitsOnTaskId' | 'orphan'>;

  const exceptionItem = (task: TaskRow): Own | null => {
    const item = itemOfTask.get(task.id);
    if (!item) return null;
    const base = {
      kind: 'EXCEPTION_ITEM' as const,
      subjectId: item.id,
      since: item.assignedAt,
      orphanKey: `EXCEPTION_ITEM:${item.id}:${item.assignedAt.getTime()}`,
      detail: `Exception item “${item.title}” (${item.kind}) about task ${taskName(task)} is open.`,
    };
    if (item.assignee === 'OWNER') {
      return {
        ...base,
        addressee: { kind: 'OWNER', sessionId: null },
        addresseeAbsentReason: null,
        notifiedAt: item.assignedAt,
        notifiedAtAbsentReason: null,
        needed: 'The account owner answers it on their Needs-you list.',
      };
    }
    const coordinator = projectOf(task)?.coordinatorSession ?? null;
    if (!coordinator || conversationIsOver(coordinator)) {
      return {
        ...base,
        addressee: null,
        addresseeAbsentReason: coordinator ? 'COORDINATOR_ENDED' : 'NO_COORDINATOR',
        notifiedAt: null,
        notifiedAtAbsentReason: 'NO_ADDRESSEE',
        needed: 'It is assigned to the coordinator, and there is no coordinator conversation that can read it: '
          + 'resolve it (open_item_resolve) or hand it to the owner (open_item_hand_over).',
      };
    }
    const delivered = item.deliveries.filter((delivery) => delivery.sessionId === coordinator.id)
      .map((delivery) => delivery.createdAt.getTime());
    return {
      ...base,
      addressee: { kind: 'COORDINATOR', sessionId: coordinator.id },
      addresseeAbsentReason: null,
      notifiedAt: delivered.length === 0 ? null : new Date(Math.min(...delivered)),
      notifiedAtAbsentReason: delivered.length > 0 ? null : coordinatorTakesItLater(coordinator) ? 'QUEUED' : 'NEVER_TOLD',
      needed: 'The coordinator works it through, resolves it (open_item_resolve) or hands it to the owner (open_item_hand_over).',
    };
  };

  const evidenceItem = (task: TaskRow): Own | null => {
    const row = unanswered.find((candidate) => candidate.task.id === task.id);
    if (!row) return null;
    const { latest } = row;
    const revision = latest.revision.toString();
    const coordinator = projectOf(task)?.coordinatorSession ?? null;
    const reason = standing.get(task.id);
    if (reason !== undefined) {
      const placed = undecidablePlaces.get(task.id)!;
      const digest = digests.get(task.id)!;
      const base = {
        kind: 'EVIDENCE' as const,
        subjectId: latest.id,
        since: latest.submittedAt,
        orphanKey: `EVIDENCE:${latest.id}:UNDECIDABLE:${digest}:${placed.addressee}`,
        detail: `Revision ${revision} of the completion evidence of task ${taskName(task)} has no decision, `
          + `and it cannot be decided: ${reason}.`,
        addresseeAbsentReason: null,
      };
      if (placed.addressee === 'RUN') {
        const liveRuns = [...placed.liveRunIds].sort();
        const notifiedAt = toldAt(liveRuns, undecidableEvidenceTurnId('run', latest.id, digest));
        return {
          ...base,
          addressee: { kind: 'RUN', sessionId: liveRuns[0]! },
          notifiedAt,
          notifiedAtAbsentReason: notifiedAt ? null : 'NEVER_TOLD',
          needed: `Only a run of the task can file a revision that can be decided. Its running session `
            + `(${liveRuns.map((id) => uuidToBase62(id)).join(', ')}) has to submit a new revision against the standard `
            + `the task is held to now (session_send it), or the task is started again (task_start).`,
        };
      }
      if (placed.addressee === 'COORDINATOR') {
        const notifiedAt = toldAt([placed.coordinatorSessionId!], undecidableEvidenceTurnId('coordinator', latest.id, digest));
        return {
          ...base,
          addressee: { kind: 'COORDINATOR', sessionId: placed.coordinatorSessionId },
          notifiedAt,
          notifiedAtAbsentReason: notifiedAt ? null : 'NEVER_TOLD',
          needed: 'The task has no running session to submit it again: start the task again (task_start) so a new run '
            + 'submits a revision against the standard it is held to now, or change the standard.',
        };
      }
      return {
        ...base,
        addressee: { kind: 'OWNER', sessionId: null },
        notifiedAt: latest.submittedAt,
        notifiedAtAbsentReason: null,
        needed: 'The account owner restarts the task from the pending row (Restart the task).',
      };
    }
    const place = places.get(task.id);
    const base = {
      kind: 'EVIDENCE' as const,
      subjectId: latest.id,
      since: latest.submittedAt,
      detail: `Revision ${revision} of the completion evidence of task ${taskName(task)} waits for a decision.`,
      addresseeAbsentReason: null,
    };
    if (place?.place === 'HELD') {
      return {
        ...base,
        orphanKey: `EVIDENCE:${latest.id}:DECIDABLE:COORDINATOR`,
        addressee: { kind: 'COORDINATOR', sessionId: place.sessionId },
        notifiedAt: place.deliveredAt,
        notifiedAtAbsentReason: null,
        needed: 'The coordinator decides it (task_evidence_decide).',
      };
    }
    if (place?.place === 'WAITING') {
      const queued = coordinator !== null && coordinator.id === place.coordinatorSessionId && coordinatorTakesItLater(coordinator);
      return {
        ...base,
        orphanKey: `EVIDENCE:${latest.id}:DECIDABLE:COORDINATOR`,
        addressee: { kind: 'COORDINATOR', sessionId: place.coordinatorSessionId },
        notifiedAt: null,
        notifiedAtAbsentReason: queued ? 'QUEUED' : 'NEVER_TOLD',
        needed: 'It is owed to the coordinator, which decides it (task_evidence_decide).',
      };
    }
    return {
      ...base,
      orphanKey: `EVIDENCE:${latest.id}:DECIDABLE:OWNER`,
      addressee: { kind: 'OWNER', sessionId: null },
      notifiedAt: latest.submittedAt,
      notifiedAtAbsentReason: null,
      needed: 'The account owner decides it on their pending evidence card.',
    };
  };

  const runItem = (task: TaskRow): Own | null => {
    if (!UNSETTLED.includes(task.status)) return null;
    const run = runs.find((candidate) => candidate.taskId === task.id);
    if (!run) return null;
    const windowSeconds = projectOf(task)?.exceptionEscalationSeconds ?? 0;
    const quietSince = later(task.progress?.lastProgressAt, run.lastTurnAt, run.createdAt);
    const working = run.runningBgJobs.length > 0 || waking.has(run.id)
      || readAt.getTime() - quietSince.getTime() < windowSeconds * 1_000;
    const detail = `Task ${taskName(task)} has a running session, ${uuidToBase62(run.id)}.`;
    if (working) {
      return {
        kind: 'TASK_RUN',
        subjectId: run.id,
        since: run.createdAt,
        orphanKey: `TASK_RUN:${run.id}:WORKING`,
        detail,
        addressee: { kind: 'RUN', sessionId: run.id },
        addresseeAbsentReason: null,
        notifiedAt: run.createdAt,
        notifiedAtAbsentReason: null,
        needed: 'The run carries on with the task.',
      };
    }
    return {
      kind: 'TASK_RUN',
      subjectId: run.id,
      since: quietSince,
      orphanKey: `TASK_RUN:${run.id}:QUIET:${quietSince.getTime()}`,
      detail: `${detail} It has reported no progress, taken no turn, and has no background job running and no wake-up `
        + `waiting since ${quietSince.toISOString()}.`,
      addressee: null,
      addresseeAbsentReason: 'RUN_QUIET',
      notifiedAt: null,
      notifiedAtAbsentReason: 'NO_ADDRESSEE',
      needed: `Find out what the run is waiting for (session_get, session_send ${uuidToBase62(run.id)}), `
        + 'or stop it and start the task again.',
    };
  };

  /** The task a prerequisite's work is carried by now: its successor chain's tail. */
  const carrier = (id: string): TaskRow | null => {
    let task = tasks.get(id) ?? null;
    for (let hop = 0; hop < MAX_HOPS && task?.supersededByTaskId && tasks.has(task.supersededByTaskId); hop += 1) {
      task = tasks.get(task.supersededByTaskId)!;
    }
    return task;
  };

  const memo = new Map<string, PendingItem | null>();
  const itemOf = (task: TaskRow, visiting: Set<string>): PendingItem | null => {
    if (memo.has(task.id)) return memo.get(task.id)!;
    const head = { taskId: task.id, title: task.title, status: task.status, waitsOnTaskId: null };
    const own = exceptionItem(task) ?? evidenceItem(task) ?? runItem(task);
    let found: PendingItem | null = null;
    if (own) {
      found = { ...head, ...own, orphan: false };
    } else if (task.status === TaskStatus.OPEN) {
      found = dependencyItem(task, visiting);
    }
    if (found) found.orphan = isOrphan(found, readAt);
    memo.set(task.id, found);
    return found;
  };

  const dependencyItem = (task: TaskRow, visiting: Set<string>): PendingItem | null => {
    const waiting = [...task.dependsOn.map((edge) => edge.dependsOnTaskId)].sort()
      .map((id) => carrier(id))
      .filter((prerequisite): prerequisite is TaskRow => prerequisite !== null && prerequisite.status !== TaskStatus.DONE);
    const [prerequisite] = waiting;
    if (!prerequisite) return null;
    const head = {
      taskId: task.id,
      title: task.title,
      status: task.status,
      kind: 'DEPENDENCIES' as const,
      subjectId: prerequisite.id,
      waitsOnTaskId: prerequisite.id,
      orphan: false,
    };
    const waitsLine = `Task ${taskName(task)} waits on its prerequisite ${taskName(prerequisite)}.`;
    if (visiting.has(prerequisite.id) || prerequisite.id === task.id) {
      return {
        ...head,
        since: task.updatedAt,
        addressee: null,
        addresseeAbsentReason: 'DEPENDENCY_CYCLE',
        notifiedAt: null,
        notifiedAtAbsentReason: 'NO_ADDRESSEE',
        orphanKey: `DEPENDENCIES:${task.id}:CYCLE`,
        detail: `${waitsLine} Its prerequisites lead back to it.`,
        needed: 'Remove a dependency so the chain can start (task_dependency_remove).',
      };
    }
    const behind = itemOf(prerequisite, new Set([...visiting, task.id]));
    if (behind) {
      return {
        ...head,
        since: behind.since,
        addressee: behind.addressee,
        addresseeAbsentReason: behind.addresseeAbsentReason,
        notifiedAt: behind.notifiedAt,
        notifiedAtAbsentReason: behind.notifiedAtAbsentReason,
        orphanKey: behind.orphanKey,
        detail: `${waitsLine} ${behind.detail}`,
        needed: behind.needed,
      };
    }
    if (prerequisite.status === TaskStatus.OPEN && prerequisite.autoRunWhenReady && !prerequisite.dispatchHold) {
      return {
        ...head,
        since: prerequisite.updatedAt,
        addressee: { kind: 'PLATFORM', sessionId: null },
        addresseeAbsentReason: null,
        notifiedAt: prerequisite.updatedAt,
        notifiedAtAbsentReason: null,
        orphanKey: `DEPENDENCIES:${prerequisite.id}:AUTO_RUN`,
        detail: `${waitsLine} The prerequisite starts by itself once it is ready and a slot is free.`,
        needed: 'Nothing: the platform starts the prerequisite.',
      };
    }
    const how = prerequisite.status === TaskStatus.OPEN
      ? 'it is not running and will not start by itself (auto-run is off or it is held)'
      : prerequisite.status === TaskStatus.IN_PROGRESS
        ? 'it is in progress with no running session'
        : `it is ${prerequisite.status} with nothing open about it`;
    return {
      ...head,
      since: prerequisite.updatedAt,
      addressee: null,
      addresseeAbsentReason: 'PREREQUISITE_NOT_MOVING',
      notifiedAt: null,
      notifiedAtAbsentReason: 'NO_ADDRESSEE',
      orphanKey: `DEPENDENCIES:${prerequisite.id}:${prerequisite.status}:${prerequisite.dispatchAttempt.toString()}`,
      detail: `${waitsLine} Nobody is moving the prerequisite: ${how}.`,
      needed: 'Start the prerequisite (task_start), replace it, or remove the dependency (task_dependency_remove).',
    };
  };

  return {
    projectId,
    readAt,
    items: population.flatMap((task) => {
      const item = itemOf(task, new Set());
      return item ? [item] : [];
    }),
  };
}

/** No addressee, or one never told, once the state it is in has had `ORPHAN_SETTLE_MS` to settle. */
function isOrphan(item: PendingItem, readAt: Date): boolean {
  if (readAt.getTime() - item.since.getTime() < ORPHAN_SETTLE_MS) return false;
  return item.addressee === null || item.notifiedAtAbsentReason === 'NEVER_TOLD';
}
