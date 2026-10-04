import type { OpenItemAction } from '@orbit/shared';

/**
 * The capability matrix for an open item.
 *
 * This file deliberately does not import `project-open-item.ts`: the row reader and the matrix
 * are peers, not two layers of one another.  Keeping the matrix independent lets the delivery
 * code, the route census, and the tests all ask the same question without making a service import
 * a transaction module (or vice versa).
 */

export const OPEN_ITEM_DOOR_TODO_TYPES = [
  'INTEGRATION_CONFLICT',
  'INTEGRATION_CHECK_FAILED',
  'INTEGRATION_ERROR',
  'TASK_FAILED',
  'PROMOTION_APPROVAL',
] as const;
export type OpenItemDoorTodoType = (typeof OPEN_ITEM_DOOR_TODO_TYPES)[number];

export const OPEN_ITEM_DOOR_SOURCE_JOBS = [
  'LAND_TASK',
  'MAIN_SYNC',
  'CHECK_PROMOTION',
  'LAND_PROMOTION',
  'TASK_FAILURE',
] as const;
export type OpenItemDoorSourceJob = (typeof OPEN_ITEM_DOOR_SOURCE_JOBS)[number];

export const OPEN_ITEM_DOOR_FAILURE_CLASSES = [
  'CONFLICT',
  'CHECK_FAILED',
  'CHECK_TIMED_OUT',
  'ERROR',
] as const;
export type OpenItemDoorFailureClass = (typeof OPEN_ITEM_DOOR_FAILURE_CLASSES)[number];

export const OPEN_ITEM_DOOR_ASSIGNEES = ['COORDINATOR', 'OWNER'] as const;
export type OpenItemDoorAssignee = (typeof OPEN_ITEM_DOOR_ASSIGNEES)[number];

/** Stable names for the three intentional holes in this first matrix. */
export const KNOWN_GAPS = [
  'PROMOTION_ITEMS_BOTH_ASSIGNEES',
  'MAIN_SYNC_CONFLICT_COORDINATOR',
  'OWNER_LAND_TASK_RERUN',
] as const;
export type OpenItemDoorKnownGap = (typeof KNOWN_GAPS)[number];

export const KNOWN_GAP_DESCRIPTIONS: Readonly<Record<OpenItemDoorKnownGap, string>> = {
  PROMOTION_ITEMS_BOTH_ASSIGNEES:
    'promotion-class integration items have no resolving door for either assignee until promotion_recheck lands',
  MAIN_SYNC_CONFLICT_COORDINATOR:
    'a MAIN_SYNC conflict has no resolving coordinator door until the conflict-specific repair path lands',
  OWNER_LAND_TASK_RERUN:
    'an owner-assigned LAND_TASK item has no rerun door; the owner can only ask back or stop the task',
};

export type OpenItemDoorKind = 'MCP' | 'ROUTE';
export type OpenItemDoorCapability =
  | 'ANSWER'
  | 'CANCEL'
  | 'DECIDE'
  | 'HANDOFF'
  | 'LOOKUP'
  | 'RESOLVE'
  | 'RERUN'
  | 'RESUME';

/** One executable door named by a matrix cell. */
export interface OpenItemDoor {
  /** A stable id for tests and future additions; `name` is the user-facing executable name. */
  id: string;
  name: string;
  kind: OpenItemDoorKind;
  mcp?: string;
  route?: string;
  holder: OpenItemDoorAssignee;
  action?: OpenItemAction;
  capability: OpenItemDoorCapability;
  /** The resolutions this door can produce, not merely the HTTP outcome. */
  outcomes: readonly string[];
  /** HANDLED and WITHDRAWN are intentionally not resolving doors (§4.8). */
  resolving: boolean;
  /** False is used only for a named future door, so the gap remains testable. */
  implemented: boolean;
}

export interface OpenItemDoorCell {
  todoType: OpenItemDoorTodoType;
  sourceJob: OpenItemDoorSourceJob;
  failureClass: OpenItemDoorFailureClass;
  assignee: OpenItemDoorAssignee;
  doors: readonly OpenItemDoor[];
}

export interface OpenItemDoorInput {
  kind: string;
  assignee: string;
  taskId?: string | null;
  promotionId?: string | null;
  fuseEpisodeId?: string | null;
  askable?: boolean;
  sourceJob?: string | null;
  failureClass?: string | null;
  phase?: string | null;
  jobKind?: string | null;
  payload?: unknown;
}

/** The two non-failure item kinds have no landing source, but their presses still belong in the
 * same capability registry. Keeping them here means the action projection has one table lookup
 * instead of a second switch that can drift from the matrix. */
export interface OpenItemDirectDoorCell {
  kind: 'COORDINATOR_QUESTION' | 'FUSE_PAUSED';
  assignee: OpenItemDoorAssignee;
  doors: readonly OpenItemDoor[];
}

const RESOLVING_OUTCOMES = new Set(['LANDED', 'RETRIED', 'TASK_DONE', 'TASK_CLOSED',
  'SUCCESSOR_FILED', 'PROMOTION_MOVED_ON', 'APPROVED', 'DECLINED', 'ANSWERED', 'RESUMED']);

function door(
  holder: OpenItemDoorAssignee,
  id: string,
  name: string,
  kind: OpenItemDoorKind,
  capability: OpenItemDoorCapability,
  outcomes: readonly string[],
  options: {
    action?: OpenItemAction;
    mcp?: string;
    route?: string;
    implemented?: boolean;
    resolving?: boolean;
  } = {},
): OpenItemDoor {
  return {
    id,
    name,
    kind,
    holder,
    action: options.action,
    mcp: options.mcp,
    route: options.route,
    capability,
    outcomes,
    resolving: options.resolving ?? outcomes.some((outcome) => RESOLVING_OUTCOMES.has(outcome)),
    implemented: options.implemented ?? true,
  };
}

const handClose = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'open-item-resolve',
  'open_item_resolve',
  'MCP',
  'RESOLVE',
  ['HANDLED'],
  {
    action: undefined,
    mcp: 'open_item_resolve',
    route: '/runner/projects/:id/open-items/:itemId/resolve',
    resolving: false,
  },
);

const handOver = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'open-item-hand-over',
  'open_item_hand_over',
  'MCP',
  'HANDOFF',
  [],
  {
    mcp: 'open_item_hand_over',
    route: '/runner/projects/:id/open-items/:itemId/hand-over',
    implemented: true,
    resolving: false,
  },
);

function retryTask(holder: OpenItemDoorAssignee, resolving: boolean): OpenItemDoor[] {
  return [door(holder, 'integration-retry-task', 'integration_retry', 'MCP', 'RERUN', ['RETRIED'], {
    action: holder === 'COORDINATOR' ? 'RETRY' : undefined,
    mcp: 'integration_retry',
    route: '/runner/projects/:id/tasks/:taskId/integration/retry',
    resolving,
  })];
}

function retryPromotion(holder: OpenItemDoorAssignee, resolving: boolean): OpenItemDoor[] {
  return [door(holder, 'integration-retry-promotion', 'integration_retry', 'MCP', 'RERUN', ['RETRIED'], {
    action: undefined,
    mcp: 'integration_retry',
    route: '/runner/projects/:id/promotions/:promotionId/integration/retry',
    resolving,
  })];
}

function taskRepair(holder: OpenItemDoorAssignee, action?: OpenItemAction): OpenItemDoor[] {
  return [
    door(holder, 'task-reopen', 'task_reopen', 'MCP', 'RERUN', ['RETRIED'], {
      action,
      mcp: 'task_reopen',
      route: '/runner/tasks/:id',
    }),
    door(holder, 'task-create', 'task_create', 'MCP', 'RERUN', ['SUCCESSOR_FILED'], {
      action,
      mcp: 'task_create',
      route: '/runner/tasks',
    }),
  ];
}

function taskFailureDoors(holder: OpenItemDoorAssignee): OpenItemDoor[] {
  return [
    door(holder, 'task-start', 'task_start', 'MCP', 'RERUN', ['RETRIED'], {
      action: 'RETRY',
      mcp: 'task_start',
      route: '/runner/tasks/:id/execute',
    }),
    door(holder, 'task-create', 'task_create', 'MCP', 'RERUN', ['SUCCESSOR_FILED'], {
      action: 'RETRY',
      mcp: 'task_create',
      route: '/runner/tasks',
    }),
    door(holder, 'task-update-cancel', 'task_update', 'MCP', 'CANCEL', ['TASK_CLOSED'], {
      action: 'CANCEL_TASK',
      mcp: 'task_update',
      route: '/runner/tasks/:id',
    }),
  ];
}

function cancelTask(holder: OpenItemDoorAssignee, resolving: boolean): OpenItemDoor {
  return door(holder, 'task-update-cancel', 'task_update', 'MCP', 'CANCEL', ['TASK_CLOSED'], {
    action: 'CANCEL_TASK',
    mcp: 'task_update',
    route: '/runner/tasks/:id',
    resolving,
  });
}

function review(holder: OpenItemDoorAssignee, resolving: boolean): OpenItemDoor {
  return door(holder, 'promotion-review', 'promotion review', 'ROUTE', 'DECIDE',
    resolving ? ['APPROVED', 'DECLINED', 'PROMOTION_MOVED_ON'] : [], {
      action: 'REVIEW',
      route: '/projects/:id/promotions/:promotionId/{confirm|decline|cancel}',
      resolving,
    });
}

function askAgain(holder: OpenItemDoorAssignee): OpenItemDoor {
  return door(holder, 'ask-coordinator-again', 'return-to-coordinator', 'ROUTE', 'LOOKUP', [], {
    action: 'ASK_COORDINATOR_AGAIN',
    route: '/projects/:id/open-items/:itemId/return-to-coordinator',
    resolving: false,
  });
}

function openTaskSession(holder: OpenItemDoorAssignee): OpenItemDoor {
  return door(holder, 'open-task-session', 'task_get', 'MCP', 'LOOKUP', [], {
    action: 'OPEN_TASK_SESSION',
    mcp: 'task_get',
    route: '/runner/tasks/:id',
    resolving: false,
  });
}

function openCoordinator(holder: OpenItemDoorAssignee): OpenItemDoor {
  return door(holder, 'open-coordinator', 'project_get', 'MCP', 'LOOKUP', [], {
    action: 'OPEN_COORDINATOR',
    mcp: 'project_get',
    route: '/runner/projects/:id',
    resolving: false,
  });
}

function answer(holder: OpenItemDoorAssignee): OpenItemDoor {
  return door(holder, 'answer-question', 'open_item_answer', 'ROUTE', 'ANSWER', ['ANSWERED'], {
    action: 'ANSWER',
    route: '/projects/:id/open-items/:itemId/answer',
  });
}

function resume(holder: OpenItemDoorAssignee): OpenItemDoor {
  return door(holder, 'resume-fuse', 'fuse_resume', 'ROUTE', 'RESUME', ['RESUMED'], {
    action: 'RESUME',
    route: '/projects/:id/fuse/:episodeId/resume',
  });
}

function directDoorTable(): OpenItemDirectDoorCell[] {
  return (['COORDINATOR_QUESTION', 'FUSE_PAUSED'] as const).flatMap((kind) =>
    OPEN_ITEM_DOOR_ASSIGNEES.map((assignee) => ({
      kind,
      assignee,
      doors: [kind === 'COORDINATOR_QUESTION' ? answer(assignee) : resume(assignee)],
    })));
}

export const OPEN_ITEM_DIRECT_DOOR_TABLE: readonly OpenItemDirectDoorCell[] = directDoorTable();

function normalizeTodo(kind: string): OpenItemDoorTodoType | null {
  return (OPEN_ITEM_DOOR_TODO_TYPES as readonly string[]).includes(kind)
    ? kind as OpenItemDoorTodoType
    : null;
}

function normalizeAssignee(assignee: string): OpenItemDoorAssignee {
  return assignee === 'OWNER' ? 'OWNER' : 'COORDINATOR';
}

export function sourceJobForOpenItem(input: OpenItemDoorInput): OpenItemDoorSourceJob | null {
  const phase = input.phase ?? (input.payload && typeof input.payload === 'object'
    ? (input.payload as { phase?: unknown }).phase : null);
  const jobKind = input.jobKind ?? (input.payload && typeof input.payload === 'object'
    ? (input.payload as { jobKind?: unknown }).jobKind : null);
  if (input.sourceJob && (OPEN_ITEM_DOOR_SOURCE_JOBS as readonly string[]).includes(input.sourceJob)) {
    return input.sourceJob as OpenItemDoorSourceJob;
  }
  if (input.kind === 'TASK_FAILED') return 'TASK_FAILURE';
  if (jobKind === 'CHECK_PROMOTION' || jobKind === 'PROMOTION_CHECK') return 'CHECK_PROMOTION';
  if (jobKind === 'LAND_PROMOTION' || jobKind === 'PROMOTION_LAND') return 'LAND_PROMOTION';
  // A promotion can also report that it was in MAIN_SYNC, but its source job is still the
  // promotion. MAIN_SYNC is the special source only for a task landing whose conflict happened
  // while it absorbed the upstream.
  if (phase === 'MAIN_SYNC' || phase === 'SYNC') return 'MAIN_SYNC';
  if (jobKind === 'LAND_TASK') return 'LAND_TASK';
  if (input.promotionId) return 'CHECK_PROMOTION';
  if (input.taskId) return 'LAND_TASK';
  return null;
}

export function failureClassForOpenItem(input: OpenItemDoorInput): OpenItemDoorFailureClass {
  const fromPayload = input.payload && typeof input.payload === 'object'
    ? (input.payload as { failureClass?: unknown }).failureClass : null;
  const value = input.failureClass ?? (typeof fromPayload === 'string' ? fromPayload : null);
  return (OPEN_ITEM_DOOR_FAILURE_CLASSES as readonly string[]).includes(value ?? '')
    ? value as OpenItemDoorFailureClass
    : 'ERROR';
}

function isIntegration(todoType: OpenItemDoorTodoType): boolean {
  return todoType === 'INTEGRATION_CONFLICT'
    || todoType === 'INTEGRATION_CHECK_FAILED'
    || todoType === 'INTEGRATION_ERROR';
}

function isPromotionSource(sourceJob: OpenItemDoorSourceJob): boolean {
  return sourceJob === 'CHECK_PROMOTION' || sourceJob === 'LAND_PROMOTION';
}

/** Build the doors for one matrix cell.  Action-only doors remain listed even when they are not
 * resolving: they preserve the current UI contract while making the distinction explicit. */
export function doorsForCell(cell: Pick<OpenItemDoorCell,
  'todoType' | 'sourceJob' | 'failureClass' | 'assignee'>): OpenItemDoor[] {
  const { todoType, sourceJob, failureClass, assignee } = cell;
  const doors: OpenItemDoor[] = [];
  const promotionFailure = isIntegration(todoType) && isPromotionSource(sourceJob);

  if (todoType === 'PROMOTION_APPROVAL') {
    // Promotion decision/recheck doors are deliberately one of T4's initial gaps.  The existing
    // REVIEW action is still shown, but this matrix does not call it a resolving exception door
    // until the promotion-specific capability is added.
    doors.push(review(assignee, false));
    doors.push(handClose(assignee), handOver(assignee));
    return doors;
  }
  if (todoType === 'TASK_FAILED') {
    if (assignee === 'COORDINATOR') doors.push(openCoordinator(assignee));
    if (assignee === 'OWNER') doors.push(askAgain(assignee));
    doors.push(openTaskSession(assignee), ...taskFailureDoors(assignee),
      handClose(assignee), handOver(assignee));
    return doors;
  }
  if (!isIntegration(todoType)) return [handClose(assignee), handOver(assignee)];

  // The promotion-specific recheck door is T5/T14 work.  Keep today's generic retry named for
  // the message, but non-resolving in these cells so the initial four-gap contract is honest.
  if (promotionFailure) {
    doors.push(...retryPromotion(assignee, false));
    doors.push(review(assignee, false));
    if (assignee === 'OWNER') doors.push(askAgain(assignee));
    doors.push(handClose(assignee), handOver(assignee));
    return doors;
  }

  if (sourceJob === 'MAIN_SYNC' && failureClass === 'CONFLICT' && assignee === 'COORDINATOR') {
    // The existing UI still exposes the ordinary task controls, but none repairs this conflict.
    doors.push(openCoordinator(assignee), openTaskSession(assignee), cancelTask(assignee, false));
  } else if (sourceJob === 'LAND_TASK' && assignee === 'COORDINATOR') {
    doors.push(openCoordinator(assignee), openTaskSession(assignee));
    if (failureClass === 'CONFLICT') {
      doors.push(...taskRepair(assignee, 'RETRY'));
    } else {
      doors.push(...retryTask(assignee, true));
      // These are the task-level rework doors named by the message. They resolve by reopening or
      // replacing the task even though they are not one of the compact OpenItemAction buttons.
      doors.push(...taskRepair(assignee));
    }
    doors.push(cancelTask(assignee, false));
  } else if (sourceJob === 'MAIN_SYNC' && assignee === 'COORDINATOR') {
    doors.push(openCoordinator(assignee), openTaskSession(assignee), ...taskRepair(assignee));
    doors.push(cancelTask(assignee, false));
  } else if (assignee === 'OWNER') {
    doors.push(askAgain(assignee), openTaskSession(assignee),
      cancelTask(assignee, sourceJob !== 'LAND_TASK'));
    // The third known gap is the missing owner rerun, not the existing way back to a coordinator.
  }
  doors.push(handClose(assignee), handOver(assignee));
  return doors;
}

function buildTable(): OpenItemDoorCell[] {
  const cells: OpenItemDoorCell[] = [];
  const integrationKinds = OPEN_ITEM_DOOR_TODO_TYPES.filter(isIntegration);
  for (const todoType of integrationKinds) {
    for (const sourceJob of OPEN_ITEM_DOOR_SOURCE_JOBS.filter((job) => job !== 'TASK_FAILURE')) {
      for (const failureClass of OPEN_ITEM_DOOR_FAILURE_CLASSES) {
        for (const assignee of OPEN_ITEM_DOOR_ASSIGNEES) {
          cells.push({ todoType, sourceJob, failureClass, assignee,
            doors: doorsForCell({ todoType, sourceJob, failureClass, assignee }) });
        }
      }
    }
  }
  for (const failureClass of OPEN_ITEM_DOOR_FAILURE_CLASSES) {
    for (const assignee of OPEN_ITEM_DOOR_ASSIGNEES) {
      cells.push({ todoType: 'TASK_FAILED', sourceJob: 'TASK_FAILURE', failureClass, assignee,
        doors: doorsForCell({ todoType: 'TASK_FAILED', sourceJob: 'TASK_FAILURE', failureClass, assignee }) });
      for (const sourceJob of ['CHECK_PROMOTION', 'LAND_PROMOTION'] as const) {
        cells.push({ todoType: 'PROMOTION_APPROVAL', sourceJob, failureClass, assignee,
          doors: doorsForCell({ todoType: 'PROMOTION_APPROVAL', sourceJob, failureClass, assignee }) });
      }
    }
  }
  return cells;
}

/** The complete capability table for every source/type pairing that can actually open a row.
 * Impossible pairings (for example TASK_FAILED from a landing job) are not cells to hand to a
 * person, so they are intentionally absent rather than silently inventing a door for them. */
export const OPEN_ITEM_DOOR_TABLE: readonly OpenItemDoorCell[] = buildTable();

export function knownGapsForCell(cell: Pick<OpenItemDoorCell,
  'todoType' | 'sourceJob' | 'failureClass' | 'assignee'>): OpenItemDoorKnownGap[] {
  const gaps: OpenItemDoorKnownGap[] = [];
  if ((isIntegration(cell.todoType) && isPromotionSource(cell.sourceJob))
      || (cell.todoType === 'PROMOTION_APPROVAL' && isPromotionSource(cell.sourceJob))) {
    gaps.push('PROMOTION_ITEMS_BOTH_ASSIGNEES');
  }
  if (isIntegration(cell.todoType)
      && cell.sourceJob === 'MAIN_SYNC'
      && cell.failureClass === 'CONFLICT'
      && cell.assignee === 'COORDINATOR') {
    gaps.push('MAIN_SYNC_CONFLICT_COORDINATOR');
  }
  if (isIntegration(cell.todoType)
      && cell.sourceJob === 'LAND_TASK'
      && cell.assignee === 'OWNER') {
    gaps.push('OWNER_LAND_TASK_RERUN');
  }
  return gaps;
}

export function cellForOpenItem(input: OpenItemDoorInput): OpenItemDoorCell | null {
  const todoType = normalizeTodo(input.kind);
  const sourceJob = sourceJobForOpenItem(input);
  if (!todoType || !sourceJob) return null;
  const failureClass = failureClassForOpenItem(input);
  const assignee = normalizeAssignee(input.assignee);
  return OPEN_ITEM_DOOR_TABLE.find((cell) => cell.todoType === todoType
    && cell.sourceJob === sourceJob
    && cell.failureClass === failureClass
    && cell.assignee === assignee) ?? null;
}

/** One lookup for both the Cartesian failure table and the two direct item rows. */
export function doorsForOpenItem(input: OpenItemDoorInput): readonly OpenItemDoor[] {
  const directKind = input.fuseEpisodeId
    ? 'FUSE_PAUSED'
    : input.kind === 'COORDINATOR_QUESTION' ? 'COORDINATOR_QUESTION' : null;
  if (directKind) {
    return OPEN_ITEM_DIRECT_DOOR_TABLE.find((cell) => cell.kind === directKind
      && cell.assignee === normalizeAssignee(input.assignee))?.doors ?? [];
  }
  return cellForOpenItem(input)?.doors ?? [];
}

/** The action projection consumed by `project-open-item.ts`; order is the long-standing UI order. */
export function openItemActionsFromDoors(input: OpenItemDoorInput): OpenItemAction[] {
  const assignee = normalizeAssignee(input.assignee);
  const directDoors = doorsForOpenItem(input);
  if (input.fuseEpisodeId || input.kind === 'COORDINATOR_QUESTION') {
    return directDoors
      .filter((candidate) => candidate.action !== undefined)
      .map((candidate) => candidate.action as OpenItemAction);
  }

  if (input.promotionId) {
    const doors = directDoors.length > 0
      ? directDoors
      : [review(assignee, false), ...(assignee === 'OWNER' ? [askAgain(assignee)] : [])];
    const actions: OpenItemAction[] = ['ASK_COORDINATOR_AGAIN', 'REVIEW'];
    return actions.filter((action) => (action !== 'ASK_COORDINATOR_AGAIN' || (assignee === 'OWNER' && input.askable))
      && doors.some((candidate) => candidate.action === action && candidate.holder === assignee));
  }
  if (!input.taskId) return [];
  const doors = directDoors.length > 0
    ? directDoors
    : doorsForCell({
        todoType: 'INTEGRATION_CHECK_FAILED',
        sourceJob: 'LAND_TASK',
        failureClass: 'ERROR',
        assignee,
      });
  const actions: OpenItemAction[] = assignee === 'COORDINATOR'
    ? ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK']
    : ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'];
  return actions.filter((action) => (action !== 'ASK_COORDINATOR_AGAIN' || input.askable)
    && doors.some((candidate) => candidate.action === action && candidate.holder === assignee));
}

/** Select the executable names used in the prose.  It intentionally includes a non-resolving
 * retry name: the current message contract explains why that door cannot accept a conflict. */
export function openItemDoorMessageNames(input: OpenItemDoorInput): {
  retryMcp: string;
  resolveMcp: string;
  taskStartMcp: string;
  taskCreateMcp: string;
  taskUpdateMcp: string;
  taskReopenMcp: string;
  taskGetMcp: string;
} {
  const doors = doorsForOpenItem({ ...input, assignee: 'COORDINATOR' });
  const named = (mcp: string, fallback: string): string =>
    doors.find((candidate) => candidate.mcp === mcp)?.mcp ?? fallback;
  const retry = doors.find((candidate) => candidate.mcp === 'integration_retry');
  const resolve = doors.find((candidate) => candidate.mcp === 'open_item_resolve');
  return {
    retryMcp: retry?.mcp ?? 'integration_retry',
    resolveMcp: resolve?.mcp ?? 'open_item_resolve',
    taskStartMcp: named('task_start', 'task_start'),
    taskCreateMcp: named('task_create', 'task_create'),
    taskUpdateMcp: named('task_update', 'task_update'),
    taskReopenMcp: named('task_reopen', 'task_reopen'),
    taskGetMcp: named('task_get', 'task_get'),
  };
}
