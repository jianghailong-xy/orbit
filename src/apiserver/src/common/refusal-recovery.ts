import {
  RecoveryActor,
  RecoveryDisposition,
  RecoveryEffect,
  RecoveryResource,
  RecoveryRetryPolicy,
  RecoveryUserConfirmation,
  PROJECT_REOPEN_TOOL,
  uuidToBase62,
} from '@orbit/shared';

/**
 * The `recovery` block (docs/recovery-contract.md §2) for the Project and Task refusals an agent most
 * often meets, stated by the server instead of left to a client's inference.
 *
 * This table is the wire contract. `contracts/project-task-refusals.contract.json` is its published
 * copy, and `refusal-recovery.spec.ts` holds the two equal. Each entry names the code, the status it is
 * served with, the doors that serve it, what the caller does next (`recovery`), and which body fields
 * name the rows it is about (`resources`, read in order, first match first).
 *
 * The block is attached at the exception boundary (`attachRefusalRecovery`, called from
 * `PublicIdExceptionFilter`), not at each throw site: there are many throw sites, and a block that
 * every new one had to remember would be forgotten by the next one. A body that already carries a
 * `recovery` block keeps its own.
 *
 * WHAT IT NEVER DOES: add a fact the body did not already carry. `resources` are read only from id
 * fields the throw site put in the body, so a 404, a cross-tenant id or an authentication refusal
 * names nothing more than it did before. None of those codes is in this table.
 */

export interface RefusalRecoveryStated {
  effect: RecoveryEffect;
  retryPolicy: RecoveryRetryPolicy;
  actionCode: string | null;
  actor: RecoveryActor;
  userConfirmation: RecoveryUserConfirmation;
  disposition: RecoveryDisposition;
}

export interface RefusalRecoveryEntry {
  code: string;
  /** Narrows the entry to one legacy `requiredAction` token: one code can answer several rules. */
  requiredAction?: string;
  status: number;
  endpoints: string[];
  /** When it is served, for people. */
  when: string;
  recovery: RefusalRecoveryStated;
  /** [resource type, body field path], in the order the next step reads them. */
  resources: Array<[string, string]>;
  /** The agent tool the next step is, served on the body as `nextTool` beside the block. */
  nextTool?: string;
}

const NONE = { effect: 'NONE', userConfirmation: 'NOT_REQUIRED' } as const;

const TASK_START = ['POST /tasks/:id/execute', 'POST /runner/tasks/:id/execute'];
const TASK_WRITE = ['POST /runner/tasks', 'PATCH /runner/tasks/:id', 'POST /runner/tasks/batch-create'];
const DEPENDENCY_ADD = ['POST /tasks/:id/dependencies', 'POST /runner/tasks/:id/dependencies'];
const CROSSING = [...TASK_WRITE, 'POST /projects/:id/handoffs/:handoffId/decision'];

const SCOPE_RESOURCES: Array<[string, string]> = [
  ['PROJECT', 'scope.projectId'],
  ['PROJECT', 'target.projectId'],
  ['TASK', 'taskId'],
];
const CROSSING_RESOURCES: Array<[string, string]> = [
  ['CROSSING', 'handoffId'],
  ['TASK', 'taskId'],
  ['PROJECT', 'target.projectId'],
];

export const REFUSAL_RECOVERY: readonly RefusalRecoveryEntry[] = [
  {
    code: 'STALE_CONFIG_REVISION',
    status: 409,
    endpoints: ['PATCH /projects/:id', 'PATCH /runner/projects/:id'],
    when: 'The write stated expectedConfigRevision and the project has moved past it.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'REREAD_AND_DECIDE', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: [['PROJECT', 'projectId']],
  },
  {
    code: 'PROJECT_SCOPE_MISMATCH',
    requiredAction: 'RE_DERIVE_SCOPE',
    status: 403,
    endpoints: TASK_WRITE,
    when: 'The scope token the write carried does not agree with the server (R2).',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'REREAD_AND_DECIDE', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: SCOPE_RESOURCES,
  },
  {
    code: 'PROJECT_SCOPE_MISMATCH',
    requiredAction: 'YIELD_TO_CURRENT_SCOPE',
    status: 403,
    endpoints: TASK_WRITE,
    when: 'This session holds no scope for the project the write is about (R5, or a declaring session that is not this account\'s).',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'STAND_DOWN', actor: 'CALLER', disposition: 'STOP' },
    resources: SCOPE_RESOURCES,
  },
  {
    code: 'PROJECT_SCOPE_MISMATCH',
    requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF',
    status: 403,
    endpoints: TASK_WRITE,
    when: 'The write aims at a project this session does not coordinate and declares no crossing (R6, R7).',
    recovery: {
      ...NONE, retryPolicy: 'NEVER', actionCode: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF', actor: 'CALLER', disposition: 'AUTOMATIC',
    },
    resources: SCOPE_RESOURCES,
  },
  {
    code: 'COORDINATOR_GENERATION_MOVED',
    status: 409,
    endpoints: TASK_WRITE,
    when: 'The coordination scope was handed to a newer coordinator after this write was composed (R3).',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'STAND_DOWN', actor: 'SYSTEM', disposition: 'STOP' },
    resources: SCOPE_RESOURCES,
  },
  {
    code: 'UNMAPPED_PROJECT_WORK',
    status: 403,
    endpoints: TASK_WRITE,
    when: 'The write files work under no project, and a coordinator may not pick one (R4).',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
    resources: SCOPE_RESOURCES,
  },
  {
    code: 'PROJECT_REOPEN_REQUIRED',
    status: 403,
    endpoints: [...TASK_WRITE, 'POST /projects/:id/handoffs/:handoffId/decision'],
    when: 'A settled (DONE or CANCELLED) project stands at an end of the write (R8).',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER', disposition: 'HUMAN' },
    resources: [['PROJECT', 'target.projectId'], ['PROJECT', 'projectId'], ['PROJECT', 'scope.projectId'], ['TASK', 'taskId']],
    nextTool: PROJECT_REOPEN_TOOL,
  },
  {
    code: 'MOVE_TASK_SERVES_SETTLED_CRITERION',
    status: 403,
    endpoints: CROSSING,
    when: 'The task to move serves an acceptance criterion of a settled project (R8B).',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER', disposition: 'HUMAN' },
    resources: [['PROJECT', 'scope.projectId'], ['TASK', 'taskId']],
    nextTool: PROJECT_REOPEN_TOOL,
  },
  {
    code: 'CROSS_PROJECT_APPROVAL_REQUIRED',
    status: 409,
    endpoints: TASK_WRITE,
    when: 'A declared crossing was filed as a request; the account owner\'s confirmation applies it (R10).',
    recovery: {
      effect: 'NONE', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER',
      userConfirmation: 'REQUIRED', disposition: 'CONFIRM_THEN_RUN',
    },
    resources: CROSSING_RESOURCES,
  },
  {
    code: 'APPROVAL_PENDING',
    status: 409,
    endpoints: TASK_WRITE,
    when: 'The same crossing is already waiting for the account owner (R11).',
    recovery: {
      effect: 'NONE', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER',
      userConfirmation: 'REQUIRED', disposition: 'CONFIRM_THEN_RUN',
    },
    resources: CROSSING_RESOURCES,
  },
  {
    code: 'APPROVAL_EXPIRED',
    status: 409,
    endpoints: CROSSING,
    when: 'The owner\'s yes expired before it was applied (R13); only a new request, answered again, moves the task.',
    recovery: {
      effect: 'NONE', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER',
      userConfirmation: 'REQUIRED', disposition: 'CONFIRM_THEN_RUN',
    },
    resources: CROSSING_RESOURCES,
  },
  {
    code: 'APPROVAL_DENIED',
    status: 409,
    endpoints: CROSSING,
    when: 'The account owner refused the crossing (R12): the work stays at home.',
    recovery: {
      ...NONE, retryPolicy: 'NEVER', actionCode: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF', actor: 'COORDINATOR', disposition: 'AUTOMATIC',
    },
    resources: CROSSING_RESOURCES,
  },
  {
    code: 'APPROVAL_TARGET_MISMATCH',
    status: 409,
    endpoints: CROSSING,
    when: 'The approval named does not answer this write\'s crossing (R9).',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: CROSSING_RESOURCES,
  },
  {
    code: 'PROJECT_NOT_EMPTY',
    status: 409,
    endpoints: ['DELETE /projects/:id', 'DELETE /runner/projects/:id'],
    when: 'The project still holds tasks. Moving or deleting them is the owner\'s decision, never a side effect of the delete.',
    recovery: {
      effect: 'NONE', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER',
      userConfirmation: 'REQUIRED', disposition: 'CONFIRM_THEN_RUN',
    },
    resources: [['PROJECT', 'projectId']],
  },
  {
    code: 'DEPENDENCY_SELF',
    status: 400,
    endpoints: DEPENDENCY_ADD,
    when: 'The edge names the same task at both ends.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'DEPENDENCY_CYCLE',
    status: 400,
    endpoints: [...DEPENDENCY_ADD, 'PATCH /tasks/:id', 'PATCH /runner/tasks/:id'],
    when: 'The edge (or the replacement prerequisite set) would close a cycle in the owner\'s graph.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'READ_GRAPH_AND_REPLAN', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: [['TASK', 'taskId'], ['TASK', 'dependsOnTaskId']],
  },
  {
    code: 'DEPENDENCY_DUPLICATE',
    status: 409,
    endpoints: DEPENDENCY_ADD,
    when: 'The edge already exists; nothing was written.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'READ_GRAPH_AND_REPLAN', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: [['TASK', 'taskId'], ['TASK', 'dependsOnTaskId']],
  },
  {
    code: 'TASK_RETIRED',
    status: 409,
    endpoints: TASK_START,
    when: 'The task (or the task it verifies) was superseded or abandoned: its work is done elsewhere or not at all.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'STAND_DOWN', actor: 'CALLER', disposition: 'STOP' },
    resources: [['TASK', 'supersededByTaskId'], ['TASK', 'taskId']],
  },
  {
    code: 'TASK_AGGREGATE_ONLY',
    status: 409,
    endpoints: TASK_START,
    when: 'The task is completed by its subtasks or its verifier and has no work of its own to run.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'STAND_DOWN', actor: 'CALLER', disposition: 'STOP' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'TASK_PREREQUISITES_INCOMPLETE',
    status: 400,
    endpoints: TASK_START,
    when: 'A prerequisite is still open or running.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'SYSTEM', disposition: 'WAIT' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'TASK_PREREQUISITE_NOT_LANDED',
    status: 400,
    endpoints: TASK_START,
    when: 'Every prerequisite is DONE, and one has not reached its line yet.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'SYSTEM', disposition: 'WAIT' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'TASK_PREREQUISITE_FAILED',
    status: 400,
    endpoints: TASK_START,
    when: 'A prerequisite was cancelled, or a check on one did not pass: waiting changes nothing.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'READ_GRAPH_AND_REPLAN', actor: 'COORDINATOR', disposition: 'AUTOMATIC' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'TASK_LIST_PAUSED',
    status: 400,
    endpoints: TASK_START,
    when: 'The task\'s list is paused; resuming it is the owner\'s.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
    resources: [['TASK', 'taskId'], ['LIST', 'listId']],
  },
  {
    code: 'TASK_NO_ASSIGNEE',
    status: 400,
    endpoints: TASK_START,
    when: 'The task has no responsible agent.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'ASSIGN_AGENT', actor: 'CALLER', disposition: 'AUTOMATIC' },
    resources: [['TASK', 'taskId']],
  },
  {
    code: 'TASK_ASSIGNEE_NO_RUNNER',
    status: 400,
    endpoints: TASK_START,
    when: 'The responsible agent is bound to no runner; binding one is a workspace change the owner makes.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
    resources: [['TASK', 'taskId'], ['AGENT', 'assigneeId']],
  },
  {
    code: 'PROJECT_PAUSED',
    status: 409,
    endpoints: ['POST /runner/tasks/:id/execute'],
    when: 'The task\'s project is paused by its owner.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
    resources: [['TASK', 'taskId'], ['PROJECT', 'projectId']],
  },
  {
    code: 'PROJECT_NOT_STARTED',
    status: 409,
    endpoints: ['POST /runner/tasks/:id/execute'],
    when: 'The task\'s project has not been started by its owner.',
    recovery: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'COORDINATOR', disposition: 'HUMAN' },
    resources: [['PROJECT', 'projectId'], ['TASK', 'taskId']],
  },
  {
    code: 'PROJECT_CANCELLED',
    status: 409,
    endpoints: TASK_START,
    when: 'The task\'s project was cancelled.',
    recovery: { ...NONE, retryPolicy: 'NEVER', actionCode: 'STAND_DOWN', actor: 'USER', disposition: 'STOP' },
    resources: [['PROJECT', 'projectId'], ['TASK', 'taskId']],
  },
];

/** What a plan finding that is not in the table above means: change the plan. */
const PLAN_FINDING_DEFAULT: RefusalRecoveryStated = {
  ...NONE, retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', actor: 'CALLER', disposition: 'AUTOMATIC',
};

/** Plan findings whose fix is not the caller's to make. */
const PLAN_FINDINGS: Readonly<Record<string, RefusalRecoveryStated>> = {
  PLAN_ASSIGNEE_HAS_NO_RUNNER: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
  PLAN_BUDGET_ADMITS_NOTHING: { ...NONE, retryPolicy: 'AFTER_STATE_CHANGE', actionCode: null, actor: 'USER', disposition: 'HUMAN' },
};

/** Most restrictive first: the plan as a whole is as stuck as its stuckest finding. */
export const DISPOSITION_SEVERITY: readonly RecoveryDisposition[] = ['STOP', 'HUMAN', 'CONFIRM_THEN_RUN', 'WAIT', 'AUTOMATIC'];

function entryFor(code: string, requiredAction: unknown): RefusalRecoveryEntry | undefined {
  return REFUSAL_RECOVERY.find((e) => e.code === code && e.requiredAction === requiredAction)
    ?? REFUSAL_RECOVERY.find((e) => e.code === code && e.requiredAction === undefined)
    // A code whose entries are all narrowed, met with a token none of them names: the first one is
    // still a truer answer than inference, and every narrowed variant shares the effect NONE.
    ?? REFUSAL_RECOVERY.find((e) => e.code === code);
}

function at(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function publicId(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return uuidToBase62(value);
  } catch {
    // Already public (base62), or a caller-chosen key: handed on as it is.
    return value;
  }
}

function resourcesOf(body: Record<string, unknown>, paths: ReadonlyArray<[string, string]>): RecoveryResource[] {
  const out: RecoveryResource[] = [];
  for (const [type, path] of paths) {
    const id = publicId(at(body, path));
    if (id && !out.some((r) => r.type === type && r.id === id)) out.push({ type, id });
  }
  return out;
}

/** The stated block for one coded body, or null when the table does not cover its code. */
export function refusalRecoveryFor(body: Record<string, unknown>): (RefusalRecoveryStated & { resources: RecoveryResource[] }) | null {
  if (typeof body.code !== 'string') return null;
  const entry = entryFor(body.code, body.requiredAction);
  if (!entry) return null;
  return { ...entry.recovery, resources: resourcesOf(body, entry.resources) };
}

/** The stated block for one plan finding (its code is a scope code or a `PLAN_*` code). */
export function planFindingRecovery(code: string, requiredAction?: string): RefusalRecoveryStated {
  const entry = entryFor(code, requiredAction);
  return entry?.recovery ?? PLAN_FINDINGS[code] ?? PLAN_FINDING_DEFAULT;
}

/**
 * Add the stated `recovery` block to a refusal body, in place. A body that states its own keeps it,
 * and a body whose code the table does not cover is left exactly as it was.
 */
export function attachRefusalRecovery(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const obj = body as Record<string, unknown>;
  // The tool the next step is (a settled project's PROJECT_REOPEN_REQUIRED names project_request_reopen), beside a
  // block the body stated or the table's.
  const nextTool = typeof obj.code === 'string' ? entryFor(obj.code, obj.requiredAction)?.nextTool : undefined;
  if (nextTool && !('nextTool' in obj)) obj.nextTool = nextTool;
  if ('recovery' in obj) return;
  const recovery = refusalRecoveryFor(obj);
  if (recovery) obj.recovery = recovery;
}

const STATUS_ERROR: Readonly<Record<number, string>> = { 400: 'Bad Request', 403: 'Forbidden', 409: 'Conflict' };

/**
 * A coded refusal body in the shape Nest serves (`statusCode`, `error`, `message`) plus its code and
 * the ids it is about. The message is the one the door always served, so a client that matches on it
 * keeps matching.
 */
export function codedRefusal(
  status: 400 | 403 | 409,
  code: string,
  message: string,
  ids: Record<string, string | number | null | undefined> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { statusCode: status, error: STATUS_ERROR[status], code, message };
  for (const [key, value] of Object.entries(ids)) if (value !== undefined && value !== null) body[key] = value;
  return body;
}
