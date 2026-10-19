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
  'COORDINATOR_QUESTION',
  'FUSE_PAUSED',
  'START_REQUEST',
  'DONE_REQUEST',
  'DELIVERY_REVIEW',
] as const;
export type OpenItemDoorTodoType = (typeof OPEN_ITEM_DOOR_TODO_TYPES)[number];

export const OPEN_ITEM_DOOR_SOURCE_JOBS = [
  'LAND_TASK',
  'MAIN_SYNC',
  'CHECK_PROMOTION',
  'LAND_PROMOTION',
  'TASK_FAILURE',
  'DIRECT',
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

/**
 * There are no unresolved cells in the matrix.  Keep the export for callers that used the census
 * before the conflict-specific doors were added; an empty tuple makes a newly introduced hole fail
 * the census instead of being silently accepted.
 */
export const KNOWN_GAPS = [] as const;
export type OpenItemDoorKnownGap = (typeof KNOWN_GAPS)[number];

export const KNOWN_GAP_DESCRIPTIONS: Readonly<Record<OpenItemDoorKnownGap, string>> = {};

export type OpenItemDoorKind = 'MCP' | 'ROUTE';
export type OpenItemDoorCapability =
  | 'ANSWER'
  | 'ASK_OWNER'
  | 'CANCEL'
  | 'DECIDE'
  | 'HANDOFF'
  | 'LOOKUP'
  | 'REPAIR'
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

/** Ask the account owner only when the next step is genuinely their decision. */
const askOwner = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'ask-owner',
  'ask_owner',
  'MCP',
  'ASK_OWNER',
  [],
  { mcp: 'ask_owner', resolving: false },
);

/** The owner's press that answers a coordinator's request to start the project. */
const startProject = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'project-start',
  'project_start',
  'ROUTE',
  'DECIDE',
  ['APPROVED'],
  { route: '/projects/:id/start' },
);

/** The owner's press that records a coordinator's request to finish the project. */
const finishProject = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'project-done',
  'project_done',
  'ROUTE',
  'DECIDE',
  ['APPROVED'],
  { route: '/projects/:id/done' },
);

/** File concrete repair work against this item. The item deliberately stays open: linking the
 * task is progress, while the task's result (or another item-specific door) decides its ending. */
const createFixTask = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'task-create-fix',
  'task_create',
  'MCP',
  'REPAIR',
  [],
  {
    mcp: 'task_create',
    route: '/runner/tasks',
    resolving: false,
  },
);

/** The first half of the MAIN_SYNC repair recipe.  It is deliberately non-resolving: the comment
 * records why the next run is different, while `task_reopen` below is the door that changes the
 * task's generation. */
const commentOnTask = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'task-comment',
  'task_comment',
  'MCP',
  'REPAIR',
  [],
  {
    mcp: 'task_comment',
    resolving: false,
  },
);

/** File the concrete sync task that resolves a promotion MERGE conflict on the project branch. */
const createSyncTask = (holder: OpenItemDoorAssignee): OpenItemDoor => door(
  holder,
  'task-create-sync',
  'task_create',
  'MCP',
  'REPAIR',
  ['SUCCESSOR_FILED'],
  {
    mcp: 'task_create',
    route: '/runner/tasks',
    resolving: true,
  },
);

function reopenTask(holder: OpenItemDoorAssignee, action?: OpenItemAction): OpenItemDoor {
  return door(holder, 'task-reopen', 'task_reopen', 'MCP', 'RERUN', ['RETRIED'], {
    action,
    mcp: 'task_reopen',
    route: '/runner/tasks/:id',
  });
}

function retryTask(holder: OpenItemDoorAssignee, resolving: boolean): OpenItemDoor[] {
  const owner = holder === 'OWNER';
  return [door(holder, 'integration-retry-task', 'integration_retry', owner ? 'ROUTE' : 'MCP', 'RERUN', ['RETRIED'], {
    action: 'RETRY',
    mcp: owner ? undefined : 'integration_retry',
    route: owner
      ? '/projects/:id/tasks/:taskId/integration/retry'
      : '/runner/projects/:id/tasks/:taskId/integration/retry',
    resolving,
  })];
}

/** The candidate's re-check. Only a failure a rerun answers has this door: a CONFLICT has none, so
 * no cell that holds one lists it (`decidePromotionRetry` refuses a conflict with 409). */
function retryPromotion(holder: OpenItemDoorAssignee): OpenItemDoor[] {
  const owner = holder === 'OWNER';
  return [door(holder, 'integration-retry-promotion', 'integration_retry', owner ? 'ROUTE' : 'MCP', 'RERUN', ['RETRIED'], {
    action: 'RETRY',
    mcp: owner ? undefined : 'integration_retry',
    route: owner
      ? '/projects/:id/promotions/:promotionId/integration/retry'
      : '/runner/projects/:id/promotions/:promotionId/integration/retry',
    resolving: true,
  })];
}

function taskRepair(holder: OpenItemDoorAssignee, action?: OpenItemAction): OpenItemDoor[] {
  return [
    reopenTask(holder, action),
    door(holder, 'task-create', 'task_create', 'MCP', 'RERUN', ['SUCCESSOR_FILED'], {
      action,
      mcp: 'task_create',
      route: '/runner/tasks',
    }),
  ];
}

function taskFailureDoors(holder: OpenItemDoorAssignee): OpenItemDoor[] {
  const owner = holder === 'OWNER';
  return [
    // Run the task again — the step this cell's RETRY is. The coordinator's door is the
    // `task_start` tool; the owner's is their own route, the same press Run now makes, because an
    // agent's tool is not a door the owner holds and a card must not lead with a press its holder
    // cannot make (§4.7). Both clients send this cell's RETRY through whichever of the two the
    // row's holder owns; every other cell keeps the integration reruns.
    door(holder, 'task-start', 'task_start', owner ? 'ROUTE' : 'MCP', 'RERUN', ['RETRIED'], {
      action: 'RETRY',
      mcp: owner ? undefined : 'task_start',
      route: owner ? '/tasks/:id/execute' : '/runner/tasks/:id/execute',
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

/**
 * The landing session of the attempt this item is about (§2.9 LS1): a LOOKUP, so it resolves
 * nothing — it opens the conversation that owns the landing and the failure is read there. The two
 * holders open it their own way: the coordinator calls `session_get` (the runner route the tool
 * answers on), and the owner's own route is their client's session page.
 */
function openLanding(holder: OpenItemDoorAssignee): OpenItemDoor {
  const owner = holder === 'OWNER';
  return door(holder, 'open-landing', 'session_get', owner ? 'ROUTE' : 'MCP', 'LOOKUP', [], {
    action: 'OPEN_LANDING',
    mcp: owner ? undefined : 'session_get',
    route: owner ? '/sessions/:id' : '/runner/sessions/:id',
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
  if (input.kind === 'COORDINATOR_QUESTION' || input.kind === 'FUSE_PAUSED'
      || input.kind === 'START_REQUEST' || input.kind === 'DONE_REQUEST') return 'DIRECT';
  if (input.kind === 'DELIVERY_REVIEW') return 'LAND_TASK';
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

  if (todoType === 'COORDINATOR_QUESTION') {
    doors.push(answer(assignee));
    return doors;
  }
  if (todoType === 'FUSE_PAUSED') {
    doors.push(resume(assignee));
    return doors;
  }
  if (todoType === 'START_REQUEST') {
    // Requests are owner-owned from birth.  The coordinator row is kept out of the table (see
    // buildTable) rather than inventing a hand-over path for a card that is already the owner's.
    doors.push(startProject(assignee));
    return doors;
  }
  if (todoType === 'DONE_REQUEST') {
    doors.push(finishProject(assignee));
    return doors;
  }
  if (todoType === 'DELIVERY_REVIEW') {
    // An unlanded delivery is a task-shaped review.  Its source is represented as LAND_TASK so the
    // same retry/rework distinctions remain visible in the matrix, while its todoType stays
    // explicit and therefore cannot disappear from the census when a new kind is added.
    if (assignee === 'COORDINATOR') doors.push(openCoordinator(assignee), openTaskSession(assignee));
    else doors.push(askAgain(assignee), openTaskSession(assignee));
    if (failureClass !== 'CONFLICT') doors.push(...retryTask(assignee, true));
    // `task_comment` is the send-back's first half — the review's own message tells the coordinator
    // to write there what has to change, then `task_reopen` — so this cell carries it too.
    doors.push(...taskRepair(assignee), cancelTask(assignee, false), commentOnTask(assignee),
      handClose(assignee));
    return doors;
  }

  if (todoType === 'PROMOTION_APPROVAL') {
    // A READY candidate is decided by its own promotion card.  It is not an integration retry, but
    // the confirm/decline/cancel route is a real resolving door for this row.
    doors.push(review(assignee, true));
    doors.push(handClose(assignee), handOver(assignee));
    return doors;
  }
  if (todoType === 'TASK_FAILED') {
    if (assignee === 'COORDINATOR') doors.push(openCoordinator(assignee));
    if (assignee === 'OWNER') doors.push(askAgain(assignee));
    doors.push(openTaskSession(assignee), createFixTask(assignee), ...taskFailureDoors(assignee),
      handClose(assignee), handOver(assignee));
    return doors;
  }
  if (!isIntegration(todoType)) return [handClose(assignee), handOver(assignee)];

  // The coordinator and owner use the same integration_retry decision.  A conflict is different:
  // replaying the same source cannot repair it, so the table names the concrete branch-changing
  // operation that does.
  if (promotionFailure) {
    // A conflict answers to a branch that changed, and the re-check refuses it: the door is not in
    // this cell at all, so neither `actions` nor the message can offer a press that would 409.
    if (failureClass !== 'CONFLICT') doors.push(...retryPromotion(assignee));
    doors.push(review(assignee, false));
    if (assignee === 'COORDINATOR') doors.push(askOwner(assignee));
    if (assignee === 'OWNER') doors.push(askAgain(assignee));
    if (failureClass === 'CONFLICT') doors.push(createSyncTask(assignee));
    doors.push(createFixTask(assignee), handClose(assignee), handOver(assignee), openLanding(assignee));
    return doors;
  }

  if (sourceJob === 'MAIN_SYNC' && failureClass === 'CONFLICT' && assignee === 'COORDINATOR') {
    // The conflict belongs to the project line.  The coordinator records the narrow re-open recipe
    // before changing the task generation; sending the task back to redo its own work is not the
    // remedy for a conflict that happened before that work was examined.
    // `reopenTask` carries no RETRY action: on a conflict that press is the rerun the server
    // refuses, and the card's way in is `Open task session` (§4.7, mock 7's rule 1).
    doors.push(openCoordinator(assignee), openTaskSession(assignee), commentOnTask(assignee),
      reopenTask(assignee), cancelTask(assignee, false));
  } else if ((sourceJob === 'LAND_TASK' || sourceJob === 'MAIN_SYNC') && assignee === 'COORDINATOR') {
    // Revision 13: what only the owner can decide while the coordinator handles the item is asked,
    // and the item stays the coordinator's (§4.6, §4.7) — the same door the candidate's cells have.
    doors.push(openCoordinator(assignee), openTaskSession(assignee), askOwner(assignee));
    if (failureClass === 'CONFLICT') {
      // A conflict's rework doors stay doors — the message's recipe names them — but none of them
      // wears the RETRY action, whose press is the landing rerun a conflict is refused.
      doors.push(...taskRepair(assignee));
    } else {
      doors.push(...retryTask(assignee, true));
      // These are the task-level rework doors named by the message. They resolve by reopening or
      // replacing the task even though they are not one of the compact OpenItemAction buttons.
      doors.push(...taskRepair(assignee));
    }
    doors.push(cancelTask(assignee, false));
  } else if (assignee === 'OWNER') {
    doors.push(askAgain(assignee), openTaskSession(assignee),
      cancelTask(assignee, sourceJob !== 'LAND_TASK'));
    if (failureClass === 'CONFLICT') {
      doors.push(...taskRepair(assignee));
    } else if (sourceJob === 'LAND_TASK' || sourceJob === 'MAIN_SYNC') {
      doors.push(...retryTask(assignee, true));
    }
  }
  doors.push(createFixTask(assignee), handClose(assignee), handOver(assignee), openLanding(assignee));
  return doors;
}

function buildTable(): OpenItemDoorCell[] {
  const cells: OpenItemDoorCell[] = [];
  const integrationKinds = OPEN_ITEM_DOOR_TODO_TYPES.filter(isIntegration);
  for (const todoType of integrationKinds) {
    for (const sourceJob of OPEN_ITEM_DOOR_SOURCE_JOBS.filter((job) => job !== 'TASK_FAILURE' && job !== 'DIRECT')) {
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
  // These kinds are not integration failures, but they are still open items and must participate
  // in the same census.  They have one meaningful source/failure sentinel because neither
  // dimension exists on the row itself.  Owner-only request cards are registered only for OWNER;
  // the direct table above remains the compatibility lookup for their action projection.
  for (const todoType of ['COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST'] as const) {
    const assignees = todoType === 'START_REQUEST' || todoType === 'DONE_REQUEST'
      ? (['OWNER'] as const)
      : OPEN_ITEM_DOOR_ASSIGNEES;
    for (const assignee of assignees) {
      cells.push({ todoType, sourceJob: 'DIRECT', failureClass: 'ERROR', assignee,
        doors: doorsForCell({ todoType, sourceJob: 'DIRECT', failureClass: 'ERROR', assignee }) });
    }
  }
  for (const assignee of OPEN_ITEM_DOOR_ASSIGNEES) {
    cells.push({ todoType: 'DELIVERY_REVIEW', sourceJob: 'LAND_TASK', failureClass: 'ERROR', assignee,
      doors: doorsForCell({ todoType: 'DELIVERY_REVIEW', sourceJob: 'LAND_TASK', failureClass: 'ERROR', assignee }) });
  }
  return cells;
}

/** The complete capability table for every source/type pairing that can actually open a row.
 * Impossible pairings (for example TASK_FAILED from a landing job) are not cells to hand to a
 * person, so they are intentionally absent rather than silently inventing a door for them. */
export const OPEN_ITEM_DOOR_TABLE: readonly OpenItemDoorCell[] = buildTable();

export function knownGapsForCell(cell: Pick<OpenItemDoorCell,
  'todoType' | 'sourceJob' | 'failureClass' | 'assignee'>): OpenItemDoorKnownGap[] {
  // Kept as a function so the census API remains source-compatible.  Every current cell has a
  // resolving door; a future gap must be added deliberately and made visible in the spec.
  void cell;
  return [];
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

/** Whether the row's payload names the landing session its attempt belongs to (§2.9 LS1). */
function hasLandingSession(input: OpenItemDoorInput): boolean {
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = (payload as { landingSessionId?: unknown }).landingSessionId;
  return typeof value === 'string' && value !== '';
}

/**
 * The projection's last step: append `OPEN_LANDING` to an integration row's actions when the row
 * names a landing session and its cell holds an implemented door for it.
 *
 * The list is hardcoded and filtered by action and holder like every other action, so the
 * `implemented` check is this one action's extra rule: the door exists in every integration cell
 * from the day it is registered, and a matrix row that later turns it off must not leave a press
 * that opens nothing. The census rows carry no `landingSessionId`, which is exactly why that
 * filter has to be said here rather than left to the table's own checks.
 */
export function appendOpenLanding(
  actions: readonly OpenItemAction[],
  input: OpenItemDoorInput,
  doors: readonly OpenItemDoor[],
  assignee: OpenItemDoorAssignee,
): OpenItemAction[] {
  if (!hasLandingSession(input) || !isIntegration(normalizeTodo(input.kind) ?? 'INTEGRATION_ERROR')) {
    return [...actions];
  }
  const held = doors.some((candidate) => candidate.action === 'OPEN_LANDING'
    && candidate.holder === assignee && candidate.implemented);
  return held ? [...actions, 'OPEN_LANDING'] : [...actions];
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
    const actions: OpenItemAction[] = isIntegration(normalizeTodo(input.kind) ?? 'INTEGRATION_ERROR')
      ? ['ASK_COORDINATOR_AGAIN', 'RETRY', 'REVIEW']
      : ['ASK_COORDINATOR_AGAIN', 'REVIEW'];
    return appendOpenLanding(actions.filter((action) =>
      (action !== 'ASK_COORDINATOR_AGAIN' || (assignee === 'OWNER' && input.askable))
      && doors.some((candidate) => candidate.action === action && candidate.holder === assignee)),
    input, doors, assignee);
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
    : ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'];
  return appendOpenLanding(actions.filter((action) =>
    (action !== 'ASK_COORDINATOR_AGAIN' || input.askable)
    && doors.some((candidate) => candidate.action === action && candidate.holder === assignee)),
  input, doors, assignee);
}

/**
 * The executable names the prose may use: the doors THIS cell really has, and null for every door
 * it does not. There is deliberately no fallback to a literal name — a name the cell does not hold
 * is a press the server would refuse (a rerun of a conflict, a retry of a landing that is not a
 * failed landing), and the message builders omit the sentence instead of writing one out.
 *
 * The messages are written for the COORDINATOR whatever the row's own assignee: an item that has
 * become the owner's is read back to the coordinator as what it may ask for, never as a door held
 * by somebody else.
 */
export interface OpenItemDoorMessageNames {
  retryMcp: string | null;
  resolveMcp: string | null;
  askOwnerMcp: string | null;
  handOverMcp: string | null;
  taskCommentMcp: string | null;
  taskStartMcp: string | null;
  taskCreateMcp: string | null;
  taskUpdateMcp: string | null;
  taskReopenMcp: string | null;
  taskGetMcp: string | null;
}

export function openItemDoorMessageNames(input: OpenItemDoorInput): OpenItemDoorMessageNames {
  const doors = doorsForOpenItem({ ...input, assignee: 'COORDINATOR' });
  const named = (mcp: string): string | null =>
    doors.find((candidate) => candidate.implemented && candidate.mcp === mcp)?.mcp ?? null;
  return {
    retryMcp: named('integration_retry'),
    resolveMcp: named('open_item_resolve'),
    askOwnerMcp: named('ask_owner'),
    handOverMcp: named('open_item_hand_over'),
    taskCommentMcp: named('task_comment'),
    taskStartMcp: named('task_start'),
    taskCreateMcp: named('task_create'),
    taskUpdateMcp: named('task_update'),
    taskReopenMcp: named('task_reopen'),
    taskGetMcp: named('task_get'),
  };
}
