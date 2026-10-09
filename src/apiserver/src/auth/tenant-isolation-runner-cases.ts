import { evidence, type Tenant, type TenantRequest } from './tenant-isolation-cases';

/**
 * The tenant isolation census, second half (docs/google-sign-in-design.md §5.6, §11 T2). The first
 * half (tenant-isolation-cases.ts) holds every door a person's sign-in opens; this one holds the
 * doors a runner credential opens, and the doors nothing opens at all.
 *
 * Open sign-up lets a stranger register a machine of their own. That machine's runner token, a
 * service token minted for it, and the orchestration credential each of its sessions is handed are
 * then the stranger's to aim wherever they like — at another account's sessions, tasks, projects,
 * wiki, jobs. The share links' doors need no credential at all: the token in the URL is the whole
 * capability, and a stranger holds tokens of their own links.
 *
 * Listed here, each exactly once, as for the first half:
 *   - every route behind RunnerAuthGuard or RunnerSessionAuthGuard whose path names something
 *     (RUNNER_ISOLATION_CASES, or RUNNER_ISOLATION_BY_HAND with the reading that proves it);
 *   - every id such a route's request carries in its query, its headers or its body
 *     (RUNNER_ISOLATION_FIELD_CASES, or RUNNER_ISOLATION_FIELDS_BY_HAND for one that names nothing of
 *     anybody's) — decoded or not, since the machine protocol sends raw UUIDs nothing decodes, and
 *     whether the body is declared by a class or only by a TypeScript type; a body whose type says
 *     nothing (`Record<string, unknown>`, `unknown`) says by hand which ids it reads
 *     (RUNNER_OPAQUE_BODIES);
 *   - every route behind no account guard at all: the share links' doors (SHARED_ISOLATION_CASES,
 *     or SHARED_BY_HAND for a route that names nothing but its link) and every other one
 *     (PUBLIC_ROUTES, with why it reaches no account's object).
 * `tenant-isolation-census.spec.ts` holds all of it to the routes the app mounts, both ways.
 *
 * What a case is held to, in `tenant-isolation-runner.pg.spec.ts`: B sends the request on A's
 * objects with each credential the route serves — B's own — and is answered exactly as the same
 * request with an id that names nothing, and nothing that names anything of A's is written. A then
 * sends the very same request with its own credential and is answered by the route: not 401, 403
 * or 404, and not what an id that names nothing is answered — so the request reaches the object,
 * and B's answer is the account's doing rather than a request nobody could get through.
 */

/**
 * The credentials of B's own a request is sent with:
 *   - `runner`: the machine's runner token, and nothing else — a headless caller (a shell, a bridge);
 *   - `session`: the runner token on behalf of one of the machine's own sessions — X-Orbit-Session-Id
 *     and the orchestration credential the control plane issued that session, as `orbit mcp` sends
 *     them from inside a running agent;
 *   - `service`: a service token minted for the machine, with every scope, pinned to the account's
 *     workspace on it (RunnerSessionAuthGuard's routes only).
 */
export type RunnerCredential = 'runner' | 'session' | 'service';

/** One account's objects as the runner gate's cases name them: the first half's, and these. */
export interface RunnerTenant extends Tenant {
  runner: RunnerObjects;
}

/**
 * What only the runner gate addresses, on the account's own machine (`runnerId`). Sessions are
 * open on that machine unless said otherwise, one per state a door needs — and one per door that
 * ends or rewrites its session, so that no case takes away what another one asks for.
 */
export interface RunnerObjects {
  /** The session the `session` credential speaks for; also the observer of `watchId`. No case touches it. */
  callingSessionId: string;
  /** The coordinator of the account's project (`projectId`), which the coordinator's doors name in their header. */
  coordinatorSessionId: string;
  /** A session coordinating nothing yet: one a project can be created in. */
  newCoordinatorSessionId: string;
  /** RUNNING, with an engine session id (`runtimeSessionId`): the machine protocol's ordinary session. */
  machineSessionId: string;
  /** Its engine's session id, a UUID — what an imported Claude transcript is named by. */
  runtimeSessionId: string;
  /** An open session whose machine was deregistered: no runner at all. */
  orphanSessionId: string;
  /** RUNNING, no inbox lease. */
  takeoverSessionId: string;
  /** RUNNING, its inbox leased to `leaseOwner` at `leaseGeneration`. */
  activateSessionId: string;
  leaseOwner: string;
  leaseGeneration: string;
  /** RUNNING, an interrupt waiting in its inbox. */
  inboxSessionId: string;
  /** RUNNING, the shell turn `shellTurnId` in flight. */
  turnSessionId: string;
  shellTurnId: string;
  /** RUNNING, to be finalized and completed. */
  finalizeSessionId: string;
  completeSessionId: string;
  /** Of `machineSessionId`: a file it holds, an approval already allowed, a file request waiting on it. */
  sessionAttachmentId: string;
  allowedApprovalId: string;
  artifactRequestId: string;
  /** An integration job, and a Codex reset operation, the machine holds the claim of (`leaseOwner`, generation 1). */
  integrationJobId: string;
  codexOperationId: string;
  /**
   * The task that integration job lands: one of the project's own, not `projectTaskId`, whose one
   * in-flight landing is the first half's queued job. No case names it; it is here so that the write
   * trap counts it among A's ids, as it counted `projectTaskId` while the job landed that.
   */
  landingTaskId: string;
  /** A wiki repository operation of the machine's, claimed by it the same way (migration 0402). */
  wikiRepoOpId: string;
  /** A service token of the machine's, to be revoked. */
  spareServiceTokenId: string;
  /** A request from another of the account's sessions to `callingSessionId`, waiting for its reply. */
  replyRequestId: string;
  /** Live sessions for the lifecycle verbs, one each. */
  interruptSessionId: string;
  endSessionId: string;
  completedSessionId: string;
  deletedSessionId: string;
  archivedSessionId: string;
  /** Open items of the project assigned to its coordinator: one to resolve, one to hand over. */
  coordinatorItemId: string;
  handOverItemId: string;
  /** A watch `callingSessionId` observes. */
  watchId: string;
  /** The account's own model providers, by the slug the runner door names them by. */
  providerSlug: string;
  spareProviderSlug: string;
  /** A task filed in the account's list (`listId`). */
  listTaskId: string;
  /** A verification task of the account's, and the task it verifies — no verdict yet. */
  verifierTaskId: string;
  verifiedTaskId: string;
  /** A task confirmed by its owner, its run, the request that run raised, and the session reviewing it. */
  confirmTaskId: string;
  confirmRunSessionId: string;
  confirmRequestId: string;
  reviewerSessionId: string;
  /** Wiki: a session in a workspace bound to the space, and the space's maintaining session. */
  wikiSessionId: string;
  wikiMaintainerSessionId: string;
  wikiPlanJobId: string;
  /** An import job of the space (server execution P5, contract `import.server`), ended, to be read back. */
  wikiImportJobId: string;
  /** An op of a changeset `wikiSessionId` proposed, waiting for its verdict. */
  wikiVerifyingOpId: string;
  /** An op of an ended session's changeset, waiting for the maintenance run to adopt its verdict. */
  wikiAdoptableOpId: string;
  /** Shared: a session link's root with a file in it; a task link's root with a run and a file; a project link's. */
  sharedSessionId: string;
  sharedSessionAttachmentId: string;
  sharedTaskId: string;
  sharedTaskRunSessionId: string;
  sharedTaskAttachmentId: string;
  sharedProjectId: string;
  sharedProjectTaskId: string;
  sharedProjectRunSessionId: string;
  sharedProjectAttachmentId: string;
}

export interface RunnerCase {
  /** Which of B's credentials the route is sent with: every one it serves. */
  as: readonly RunnerCredential[];
  /** The request, on `of`'s objects; where its body names somewhere to put something, the caller's own (`mine`). */
  request: (of: RunnerTenant, mine: RunnerTenant) => TenantRequest;
  /** Path params naming something that lives under another param of the same path. */
  nested?: readonly string[];
}

export interface RunnerFieldCase {
  as: readonly RunnerCredential[];
  /** B's own request (`mine`), with `of`'s object in the field the case is keyed by and nowhere else. */
  request: (of: RunnerTenant, mine: RunnerTenant) => TenantRequest;
  /** Other fields the same object of `of`'s must appear in for the request to be well formed. */
  alongside?: readonly string[];
  /**
   * A row of `of`'s — `[table, id]` — that another transaction of A's holds while B's request is
   * answered (a run starting on a task, an edit), named for a field the route locks rows by. B's
   * request must be answered at once and as an id that names nothing is, without taking or waiting
   * for A's row.
   */
  heldRow?: (of: RunnerTenant) => readonly [table: string, id: string];
}

const RUNNER = ['runner'] as const;
const SESSION = ['session'] as const;

/** The header the runner door names its calling session in. */
const calling = (sessionId: string) => ({ 'x-orbit-session-id': sessionId });
/** Another account's session in the calling session's place on a request of the caller's own. */
const fromTheirSession = (
  as: readonly RunnerCredential[],
  own: (mine: RunnerTenant) => TenantRequest,
  theirs: (of: RunnerTenant) => string = (of) => of.runner.callingSessionId,
): RunnerFieldCase => ({
  as,
  request: (of, mine) => {
    const request = own(mine);
    return { ...request, headers: { ...request.headers, 'x-orbit-session-id': theirs(of) } };
  },
});
/** The same, for the workspace a write is attributed to (`X-Orbit-Workspace-Id`, and its pre-rename name). */
const fromTheirWorkspace = (header: 'x-orbit-workspace-id' | 'x-orbit-agent-id', own: (mine: RunnerTenant) => TenantRequest): RunnerFieldCase => ({
  as: RUNNER,
  request: (of, mine) => {
    const request = own(mine);
    return { ...request, headers: { ...request.headers, [header]: of.workspaceId } };
  },
});

/** A task as a runner files one: run by hand, accepted by an exit code. */
const taskBody = (extra: Record<string, unknown> = {}) => ({
  title: 'filed by the census',
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
  autoRunWhenReady: false,
  ...extra,
});
const watchBody = (taskId: string) => ({
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  targets: [{ kind: 'TASK', id: taskId }],
});
/** A run's heartbeat, as one process of the machine sends it. */
const heartbeat = (extra: Record<string, unknown> = {}) => ({
  status: 'ONLINE',
  idleCapacity: 1,
  leaseOwner: '11111111-1111-4111-8111-11111111c0de',
  ...extra,
});
const LEASE = '11111111-1111-4111-8111-111111111111';
/** The key the platform files the turn that hands `of`'s open item to its coordinator under (project-open-item.ts). */
const openItemTurnKey = (of: RunnerTenant) => `open-item:v1:${of.runner.coordinatorItemId}:1`;
const SHA = 'a'.repeat(40);

// ── The paths ────────────────────────────────────────────────────────────────────────────────────

export const RUNNER_ISOLATION_CASES: Readonly<Record<string, RunnerCase>> = {
  // ── the machine protocol: jobs and operations the machine holds ─────────────────────────────────
  'POST /runner/integration-jobs/:jobId/progress': {
    as: RUNNER,
    request: (of) => ({ params: { jobId: of.runner.integrationJobId }, body: { claimGeneration: '1', leaseOwner: of.runner.leaseOwner, phase: 'CHECK' } }),
  },
  // With the claim's own lease owner and generation: a machine that learned them is still not A's.
  'POST /runner/integration-jobs/:jobId/result': {
    as: RUNNER,
    request: (of) => ({
      params: { jobId: of.runner.integrationJobId },
      body: { claimGeneration: '1', leaseOwner: of.runner.leaseOwner, state: 'ERROR', errorCode: 'FETCH_FAILED' },
    }),
  },

  // ── the wiki's repository operations (migration 0402) ────────────────────────────────────────────
  // With the claim's own lease owner and generation, as the integration queue's are above: a machine
  // that learned them is still not A's, and every one of the three writes is a compare-and-set on that
  // claim rather than a write by an id.
  'POST /runner/wiki/repo-ops/:id/progress': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.wikiRepoOpId }, body: { claimGeneration: 1, leaseOwner: of.runner.leaseOwner } }),
  },
  'POST /runner/wiki/repo-ops/:id/fragments': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.wikiRepoOpId },
      body: { claimGeneration: 1, leaseOwner: of.runner.leaseOwner, sha: SHA, index: 0, total: 1, content: '{"census":true}' },
    }),
  },
  'POST /runner/wiki/repo-ops/:id/result': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.wikiRepoOpId },
      body: { claimGeneration: 1, leaseOwner: of.runner.leaseOwner, state: 'failed', error: 'refused by the census' },
    }),
  },

  // ── the machine protocol: the sessions it hosts ─────────────────────────────────────────────────
  'POST /runner/sessions/:id/source/pin': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { baseSha: SHA } }) },
  'POST /runner/sessions/:id/takeover-leases': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.takeoverSessionId }, body: { leaseOwner: LEASE } }),
  },
  // With the lease's own owner and generation, as above.
  'POST /runner/sessions/:id/activate-leases': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.activateSessionId },
      body: { leaseOwner: of.runner.leaseOwner, leaseGeneration: of.runner.leaseGeneration },
    }),
  },
  'POST /runner/sessions/:id/release-leases': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: {} }) },
  'POST /runner/sessions/:id/orchestration-credential': { as: RUNNER, request: (of) => ({ params: { id: of.runner.callingSessionId } }) },
  'GET /runner/sessions/:id/inbox': { as: RUNNER, request: (of) => ({ params: { id: of.runner.inboxSessionId } }) },
  'GET /runner/sessions/:id/attachments/:attId': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, attId: of.runner.sessionAttachmentId } }),
    nested: ['attId'],
  },
  'POST /runner/sessions/:id/attachments': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, file: { name: 'census.txt', type: 'text/plain', content: 'census' } }),
  },
  'POST /runner/sessions/:id/artifacts/result': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { requestId: of.runner.artifactRequestId, status: 'missing' } }),
  },
  'POST /runner/sessions/:id/approvals': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { toolName: 'Bash', input: { command: 'ls' } } }),
  },
  'GET /runner/sessions/:id/approvals/:approvalId': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, approvalId: of.runner.allowedApprovalId } }),
    nested: ['approvalId'],
  },
  'POST /runner/sessions/:id/background-wake': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId },
      body: {
        wakeId: 'census-job:exit', jobId: 'census-job', trigger: 'exit', kind: 'shell', command: 'make', status: 'completed',
        exitCode: 0, outputPath: '/tmp/census-job.log', outputOffset: 0, outputSize: 0, outputExcerpt: '',
      },
    }),
  },
  'POST /runner/sessions/:id/scheduled-wakeup': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { delaySeconds: 120, reason: 'the census' } }),
  },
  'POST /runner/sessions/:id/naming': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { replaces: 'not its title', title: 'named by the census' } }),
  },
  'POST /runner/sessions/:id/turn-complete': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.turnSessionId }, body: { turnId: of.runner.shellTurnId, status: 'SUCCEEDED' } }),
  },
  'POST /runner/sessions/:id/events': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { events: [] } }) },
  'POST /runner/sessions/:id/finalize': { as: RUNNER, request: (of) => ({ params: { id: of.runner.finalizeSessionId }, body: { status: 'CANCELLED' } }) },
  'POST /runner/sessions/:id/complete': { as: RUNNER, request: (of) => ({ params: { id: of.runner.completeSessionId }, body: { status: 'CANCELLED' } }) },
  'POST /runner/sessions/:id/import-result': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { ok: true } }) },
  'POST /runner/sessions/:id/merge-result': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { status: 'error', message: 'the census' } }),
  },
  'POST /runner/sessions/:id/commit-result': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { status: 'nochange' } }) },
  'POST /runner/sessions/:id/diff': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { worktreeDirty: false } }) },
  'GET /runner/sessions/:id/meta': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId } }) },
  'GET /runner/sessions/:id/events': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId } }) },

  // ── sessions, from a shell, a bridge's service token, or another session ─────────────────────────
  'GET /runner/sessions/:id': { as: ['runner', 'service', 'session'], request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /runner/sessions/:id/turns': {
    as: ['runner', 'service', 'session'],
    request: (of) => ({ params: { id: of.sessionId }, body: { message: 'from the census' } }),
  },
  'POST /runner/session-requests/:id/reply': {
    as: SESSION,
    request: (of) => ({ params: { id: of.runner.replyRequestId }, body: { message: 'answered by the census' } }),
  },
  'POST /runner/sessions/:id/interrupt': { as: SESSION, request: (of) => ({ params: { id: of.runner.interruptSessionId }, body: {} }) },
  'POST /runner/sessions/:id/merge': { as: SESSION, request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'POST /runner/sessions/:id/merge-receipts': {
    as: ['runner', 'session'],
    request: (of) => ({
      params: { id: of.sessionId },
      body: { result: 'MERGED', sourceBranch: 'census', sourceSha: SHA, targetBranch: 'main', targetShaAfter: 'b'.repeat(40) },
    }),
  },
  'GET /runner/sessions/:id/merge-receipts': { as: ['runner', 'session'], request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /runner/sessions/:id/end': { as: SESSION, request: (of) => ({ params: { id: of.runner.endSessionId } }) },
  'POST /runner/sessions/:id/complete-session': { as: SESSION, request: (of) => ({ params: { id: of.runner.completedSessionId } }) },
  'DELETE /runner/sessions/:id': { as: SESSION, request: (of) => ({ params: { id: of.runner.deletedSessionId } }) },
  'POST /runner/sessions/:id/archive': { as: SESSION, request: (of) => ({ params: { id: of.runner.archivedSessionId } }) },

  // ── tasks and lists ─────────────────────────────────────────────────────────────────────────────
  'GET /runner/tasks/:id/attribution': { as: RUNNER, request: (of) => ({ params: { id: of.taskId } }) },
  'GET /runner/tasks/:id': { as: RUNNER, request: (of) => ({ params: { id: of.taskId } }) },
  'GET /runner/tasks/:id/dependency-graph': { as: RUNNER, request: (of) => ({ params: { id: of.taskId } }) },
  'PATCH /runner/tasks/:id': { as: RUNNER, request: (of) => ({ params: { id: of.taskId }, body: { title: 'renamed by the census' } }) },
  'DELETE /runner/tasks/:id': { as: RUNNER, request: (of) => ({ params: { id: of.spare.taskId } }) },
  'POST /runner/tasks/:id/execute': { as: RUNNER, request: (of) => ({ params: { id: of.taskId }, body: {} }) },
  'POST /runner/tasks/:id/dependencies': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.taskId }, body: { dependsOnTaskId: mine.dependencyTaskId } }),
  },
  'DELETE /runner/tasks/:id/dependencies/:dependsOnTaskId': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.taskId, dependsOnTaskId: of.dependencyTaskId } }),
    nested: ['dependsOnTaskId'],
  },
  'POST /runner/tasks/:id/comments': { as: RUNNER, request: (of) => ({ params: { id: of.taskId }, body: { body: 'from the census' } }) },
  'GET /runner/task-lists/:id': { as: RUNNER, request: (of) => ({ params: { id: of.listId } }) },
  'PATCH /runner/task-lists/:id': { as: RUNNER, request: (of) => ({ params: { id: of.listId }, body: { title: 'renamed by the census' } }) },
  'DELETE /runner/task-lists/:id': { as: RUNNER, request: (of) => ({ params: { id: of.spare.listId } }) },
  'POST /runner/task-lists/:id/dag-preview': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.listId }, body: { ops: [{ op: 'add', taskId: of.runner.listTaskId, dependsOnTaskId: of.dependencyTaskId }] } }),
  },
  'POST /runner/task-lists/:id/dag-apply': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.listId }, body: { ops: [{ op: 'add', taskId: of.runner.listTaskId, dependsOnTaskId: of.dependencyTaskId }] } }),
  },
  'POST /runner/tasks/:taskId/evidence': {
    as: RUNNER,
    request: (of) => ({
      params: { taskId: of.evidenceTaskId },
      headers: calling(of.evidenceSessionId),
      body: { evidence: evidence('submitted by the census') },
    }),
  },
  'POST /runner/tasks/:taskId/evidence/decision': {
    as: RUNNER,
    request: (of) => ({
      params: { taskId: of.evidenceTaskId },
      headers: calling(of.sessionId),
      body: { decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' },
    }),
  },
  'GET /runner/tasks/:taskId/evidence': { as: RUNNER, request: (of) => ({ params: { taskId: of.evidenceTaskId } }) },
  'POST /runner/tasks/:taskId/owner-confirmation/claim': { as: RUNNER, request: (of) => ({ params: { taskId: of.runner.confirmTaskId } }) },
  'POST /runner/tasks/:taskId/owner-confirmation/review': {
    as: RUNNER,
    request: (of) => ({
      params: { taskId: of.runner.confirmTaskId },
      headers: calling(of.runner.reviewerSessionId),
      body: { requestId: of.runner.confirmRequestId, judgment: 'the census' },
    }),
  },
  'POST /runner/tasks/:taskId/owner-confirmation/return': {
    as: RUNNER,
    request: (of) => ({
      params: { taskId: of.runner.confirmTaskId },
      headers: calling(of.runner.reviewerSessionId),
      body: { requestId: of.runner.confirmRequestId, reason: 'the census', problems: [{ text: 'the census' }] },
    }),
  },
  'GET /runner/tasks/:id/progress': { as: RUNNER, request: (of) => ({ params: { id: of.taskId } }) },
  'POST /runner/tasks/:id/progress': { as: RUNNER, request: (of) => ({ params: { id: of.taskId }, body: { phase: 'census' } }) },

  // ── projects ────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/projects/:id/coordinator/ensure': { as: SESSION, request: (of) => ({ params: { id: of.projectId } }) },
  'POST /runner/projects/:id/coordinator/messages': {
    as: SESSION,
    request: (of) => ({ params: { id: of.projectId }, body: { message: 'from the census' } }),
  },
  'GET /runner/projects/:id': { as: RUNNER, request: (of) => ({ params: { id: of.projectId } }) },
  'POST /runner/projects/:id/acceptance/merge-evidence': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.projectId }, body: { requirementId: 'census', targetBranch: 'refs/heads/main', contentHash: 'd'.repeat(64) } }),
  },
  'GET /runner/projects/:id/handoffs': { as: RUNNER, request: (of) => ({ params: { id: of.projectId } }) },
  'PATCH /runner/projects/:id': { as: RUNNER, request: (of) => ({ params: { id: of.projectId }, body: { title: 'renamed by the census' } }) },
  'POST /runner/projects/:id/blockers/:blockerId/resolve': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.projectId, blockerId: of.blockerId }, body: { reason: 'the census' } }),
    nested: ['blockerId'],
  },
  // The coordinator's doors: the header names the project's coordinator — the caller's own.
  'POST /runner/projects/:id/owner-questions': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.projectId }, headers: calling(mine.runner.coordinatorSessionId), body: { question: 'Which first?' } }),
  },
  'POST /runner/projects/:id/start-requests': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, why: 'the census' },
    }),
  },
  'POST /runner/projects/:id/done-requests': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.projectId }, headers: calling(mine.runner.coordinatorSessionId), body: { judgment: 'Done.', gaps: [] } }),
  },
  'POST /runner/projects/:id/open-items/:itemId/resolve': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, itemId: of.runner.coordinatorItemId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { note: 'the census' },
    }),
    nested: ['itemId'],
  },
  'POST /runner/projects/:id/open-items/:itemId/hand-over': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, itemId: of.runner.handOverItemId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { note: 'the census' },
    }),
    nested: ['itemId'],
  },
  'POST /runner/projects/:id/tasks/:taskId/integration/retry': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, taskId: of.projectTaskId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
    nested: ['taskId'],
  },
  'POST /runner/projects/:id/tasks/:taskId/integration/skip-merge-check': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, taskId: of.projectTaskId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
    nested: ['taskId'],
  },
  'POST /runner/projects/:id/promotions/:promotionId/integration/retry': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, promotionId: of.promotionId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
    nested: ['promotionId'],
  },
  'DELETE /runner/projects/:id': { as: RUNNER, request: (of) => ({ params: { id: of.spare.projectId } }) },

  // ── watches, service tokens, workspaces, providers ───────────────────────────────────────────────
  'GET /runner/watches/:id': { as: RUNNER, request: (of, mine) => ({ params: { id: of.runner.watchId }, headers: calling(mine.runner.callingSessionId) }) },
  'PATCH /runner/watches/:id': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.runner.watchId }, headers: calling(mine.runner.callingSessionId), body: { ttlSeconds: 3600 } }),
  },
  'POST /runner/watches/:id/cancel': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.runner.watchId }, headers: calling(mine.runner.callingSessionId) }),
  },
  'POST /runner/watches/:id/release': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.runner.watchId }, headers: calling(mine.runner.callingSessionId) }),
  },
  'DELETE /runner/service-tokens/:id': { as: RUNNER, request: (of) => ({ params: { id: of.runner.spareServiceTokenId } }) },
  'PATCH /runner/workspaces/:id': { as: SESSION, request: (of) => ({ params: { id: of.workspaceId }, body: { description: 'renamed by the census' } }) },
  'PATCH /runner/agents/:id': { as: SESSION, request: (of) => ({ params: { id: of.workspaceId }, body: { description: 'renamed by the census' } }) },
  'PATCH /runner/providers/:slug': { as: RUNNER, request: (of) => ({ params: { slug: of.runner.providerSlug }, body: { label: 'renamed by the census' } }) },
  'DELETE /runner/providers/:slug': { as: RUNNER, request: (of) => ({ params: { slug: of.runner.spareProviderSlug } }) },

  // ── the wiki: a session the space's workspace runs, or the session maintaining the space ─────────
  'GET /runner/wiki/spaces/:id/verifications': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/verifications': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiSessionId),
      body: { verdicts: [{ opId: of.runner.wikiVerifyingOpId, verdict: 'supported', reason: 'the census', model: 'census' }] },
    }),
  },
  'POST /runner/wiki/spaces/:id/verifications/request': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/notes': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId), body: { path: 'census.md', text: 'A census note.' } }),
  },
  'POST /runner/wiki/spaces/:id/imports': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiSessionId),
      body: { ops: [{ op: 'challenge', entryId: of.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true },
    }),
  },
  'GET /runner/wiki/spaces/:id/import': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/import-jobs': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiSessionId),
      body: { id: '00000000-0000-4000-8000-0000000a5e1b', maxOps: 1, notes: [{ noteId: '00000000-0000-4000-8000-0000000a5e1c', file: 'census.md', date: '2026-10-08' }] },
    }),
  },
  'GET /runner/wiki/spaces/:id/import-jobs/:jobId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId, jobId: of.runner.wikiImportJobId }, headers: calling(mine.runner.wikiSessionId) }),
    nested: ['jobId'],
  },
  'GET /runner/wiki/entries/:id': { as: RUNNER, request: (of, mine) => ({ params: { id: of.wikiEntryId }, headers: calling(mine.runner.wikiSessionId) }) },
  'GET /runner/wiki/spaces/:id/dossiers': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/cursor': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { outcome: 'failed', error: 'the census' },
    }),
  },
  'GET /runner/wiki/spaces/:id/anchors': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/anchor-checks': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { ref: SHA, entries: [{ entryId: of.wikiEntryId, revision: 1, checks: [{ index: 0, type: 'path', state: 'verified' }] }] },
    }),
  },
  'POST /runner/wiki/spaces/:id/article-plan': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'GET /runner/wiki/spaces/:id/articles/:slug/input': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId, slug: of.wikiTopicSlug }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/articles/:slug': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId, slug: of.wikiTopicSlug },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { entrySetSha256: 'e'.repeat(64), articles: [{ part: 0, kind: 'article', title: 'Census', markdown: 'The census holds.', notes: [] }] },
    }),
  },
  'GET /runner/wiki/spaces/:id/plan': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/plan/drafts': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId), body: {} }),
  },
  'POST /runner/wiki/spaces/:id/plan/proposals': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId), body: {} }),
  },
  'GET /runner/wiki/spaces/:id/plan/job': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/plan/job/progress': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId), body: { attempt: 1 } }),
  },
  'POST /runner/wiki/spaces/:id/plan/job/finish': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { outcome: 'failed', error: 'the census' },
    }),
  },
  // Headless: a job's id is the whole question.
  'GET /runner/wiki/spaces/:id/plan/check': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.wikiSpaceId }, query: { jobId: of.runner.wikiPlanJobId } }),
  },
  'GET /runner/wiki/spaces/:id/plan/materials': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'GET /runner/wiki/spaces/:id/maintenance/docs': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/docs/withdrawals': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { repoSha: SHA, paths: [{ path: 'census.txt', change: 'deleted' }] },
    }),
  },
  'GET /runner/wiki/spaces/:id/docs': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'GET /runner/wiki/spaces/:id/docs/:slug': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId, slug: of.wikiDocSlug }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'GET /runner/wiki/spaces/:id/docs/:slug/material': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId, slug: of.wikiDocSlug },
      query: { section: 'intro' },
      headers: calling(mine.runner.wikiMaintainerSessionId),
    }),
  },
  'POST /runner/wiki/spaces/:id/docs/:slug': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId, slug: of.wikiDocSlug },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { planVersion: 1, repoSha: SHA, sections: [{ key: 'intro', materialSha256: 'f'.repeat(64), markdown: 'The census holds.', footnotes: [] }] },
    }),
  },
  'GET /runner/wiki/spaces/:id/maintenance/run': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/changesets': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { ops: [{ op: 'challenge', entryId: of.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true },
    }),
  },
  'GET /runner/wiki/spaces/:id/maintenance/verifications': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/verifications': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { verdicts: [{ opId: of.runner.wikiAdoptableOpId, verdict: 'supported', reason: 'the census', model: 'census' }] },
    }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/advance': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiMaintainerSessionId), body: { to: 'wc1.census' } }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/finish': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { outcome: 'failed', error: 'the census' },
    }),
  },
  // Headless: the space and the cursor the check is about are the whole question.
  'GET /runner/wiki/spaces/:id/maintenance/check': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.wikiSpaceId },
      query: {
        expect: `wc1.${Buffer.from(JSON.stringify({ s: of.wikiSpaceId, p: ['2026-01-01T00:00:00.000Z', 'session_settled', 'census'] })).toString('base64url')}`,
      },
    }),
  },
};

/** Runner-gate routes the census cannot stand up, each with why and the reading that proves it. */
export const RUNNER_ISOLATION_BY_HAND: Readonly<Record<string, string>> = {
  'POST /runner/tasks/:taskId/owner-confirmation':
    'refused 403 to every caller — the owner\'s own machine included — before the task or anything else is read: only '
    + 'the account owner confirms, through the app (task-owner-confirmation.service.ts:205 → '
    + 'task-owner-confirmation.ts:94); the owner\'s door is POST /tasks/:taskId/owner-confirmation, which the first '
    + 'half sends',
};

// ── Ids a request carries in its query, headers or body ────────────────────────────────────────────

/** The fields CreateTaskDto carries by id, on POST /runner/tasks and on each item of a batch or its preview. */
const taskCreateFieldCases = (route: string, wrap: (task: object) => object, where: string) => ({
  [`${route} body ${where}attachmentIds[]`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ attachmentIds: [of.attachmentId] })) }) },
  [`${route} body ${where}assigneeId`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ assigneeId: of.workspaceId })) }) },
  [`${route} body ${where}listId`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ listId: of.listId })) }) },
  [`${route} body ${where}projectId`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ projectId: of.projectId })) }) },
  [`${route} body ${where}fixesOpenItemId`]: {
    as: RUNNER,
    request: (of: RunnerTenant, mine: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ projectId: mine.projectId, fixesOpenItemId: of.openItemId })) }),
  },
  [`${route} body ${where}parentTaskId`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ parentTaskId: of.taskId })) }) },
  [`${route} body ${where}verifiesTaskId`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ verifiesTaskId: of.taskId })) }) },
  [`${route} body ${where}verification.assigneeId`]: {
    as: RUNNER,
    request: (of: RunnerTenant) => ({
      params: {},
      body: wrap({
        title: 'checked by the census',
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
        verification: { title: 'the census checks it', assigneeId: of.workspaceId },
      }),
    }),
  },
  [`${route} body ${where}supersedesTaskId`]: {
    as: RUNNER,
    request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ supersedesTaskId: of.spare.taskId })) }),
    heldRow: (of: RunnerTenant) => ['task', of.spare.taskId] as const,
  },
  [`${route} body ${where}dependsOnTaskIds[]`]: { as: RUNNER, request: (of: RunnerTenant) => ({ params: {}, body: wrap(taskBody({ dependsOnTaskIds: [of.dependencyTaskId] })) }) },
}) satisfies Record<string, RunnerFieldCase>;

/** The task filters by id, as the runner's list doors take them. */
const taskFilterCases = (route: string, filters: ReadonlyArray<'projectId' | 'listId'>) =>
  Object.fromEntries(filters.map((filter) => [`${route} query ${filter}`, {
    as: RUNNER,
    request: (of: RunnerTenant) => ({ params: {}, query: { [filter]: filter === 'projectId' ? of.projectId : of.listId } }),
  }])) as Record<string, RunnerFieldCase>;

/** The routes RunnerSessionsController serves in-session, as a field case of the calling session's header. */
const ownSessionRequests: Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> = {
  'POST /runner/sessions': (mine) => ({ params: {}, body: { prompt: 'opened by the census', workspaceId: mine.workspaceId } }),
  'GET /runner/sessions': () => ({ params: {} }),
  'GET /runner/sessions/search': () => ({ params: {}, query: { q: 'census' } }),
  'GET /runner/sessions/:id': (mine) => ({ params: { id: mine.sessionId } }),
  'POST /runner/sessions/:id/turns': (mine) => ({ params: { id: mine.sessionId }, body: { message: 'from the census' } }),
  'POST /runner/session-requests/:id/reply': (mine) => ({ params: { id: mine.runner.replyRequestId }, body: { message: 'answered by the census' } }),
  'POST /runner/sessions/:id/interrupt': (mine) => ({ params: { id: mine.runner.interruptSessionId }, body: {} }),
  'POST /runner/sessions/:id/merge': (mine) => ({ params: { id: mine.sessionId }, body: {} }),
  'POST /runner/sessions/:id/end': (mine) => ({ params: { id: mine.runner.endSessionId } }),
  'POST /runner/sessions/:id/complete-session': (mine) => ({ params: { id: mine.runner.completedSessionId } }),
  'DELETE /runner/sessions/:id': (mine) => ({ params: { id: mine.runner.deletedSessionId } }),
  'POST /runner/sessions/:id/archive': (mine) => ({ params: { id: mine.runner.archivedSessionId } }),
  'GET /runner/workspaces': () => ({ params: {} }),
  'GET /runner/agents': () => ({ params: {} }),
  'POST /runner/workspaces': () => ({ params: {}, body: { name: 'census workspace' } }),
  'POST /runner/agents': () => ({ params: {}, body: { name: 'census agent' } }),
  'PATCH /runner/workspaces/:id': (mine) => ({ params: { id: mine.workspaceId }, body: { description: 'renamed by the census' } }),
  'PATCH /runner/agents/:id': (mine) => ({ params: { id: mine.workspaceId }, body: { description: 'renamed by the census' } }),
  'POST /runner/projects/:id/coordinator/ensure': (mine) => ({ params: { id: mine.projectId } }),
  'POST /runner/projects/:id/coordinator/messages': (mine) => ({ params: { id: mine.projectId }, body: { message: 'from the census' } }),
};

/** The coordinator's doors of a project, as a field case of the coordinator's header. */
const coordinatorRequests: Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> = {
  'POST /runner/projects/:id/owner-questions': (mine) => ({ params: { id: mine.projectId }, body: { question: 'Which first?' } }),
  'POST /runner/projects/:id/start-requests': (mine) => ({
    params: { id: mine.projectId },
    body: { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, why: 'the census' },
  }),
  'POST /runner/projects/:id/done-requests': (mine) => ({ params: { id: mine.projectId }, body: { judgment: 'Done.', gaps: [] } }),
  'POST /runner/projects/:id/open-items/:itemId/resolve': (mine) => ({
    params: { id: mine.projectId, itemId: mine.runner.coordinatorItemId },
    body: { note: 'the census' },
  }),
  'POST /runner/projects/:id/open-items/:itemId/hand-over': (mine) => ({
    params: { id: mine.projectId, itemId: mine.runner.handOverItemId },
    body: { note: 'the census' },
  }),
  'POST /runner/projects/:id/tasks/:taskId/integration/retry': (mine) => ({
    params: { id: mine.projectId, taskId: mine.projectTaskId },
    body: { reason: 'the census' },
  }),
  'POST /runner/projects/:id/tasks/:taskId/integration/skip-merge-check': (mine) => ({
    params: { id: mine.projectId, taskId: mine.projectTaskId },
    body: { reason: 'the census' },
  }),
  'POST /runner/projects/:id/promotions/:promotionId/integration/retry': (mine) => ({
    params: { id: mine.projectId, promotionId: mine.promotionId },
    body: { reason: 'the census' },
  }),
};

/** The doors a watch's observer calls, as a field case of the observer's header. */
const observerRequests: Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> = {
  'POST /runner/watches': (mine) => ({ params: {}, body: watchBody(mine.taskId) }),
  'GET /runner/watches': () => ({ params: {} }),
  'GET /runner/watches/:id': (mine) => ({ params: { id: mine.runner.watchId } }),
  'PATCH /runner/watches/:id': (mine) => ({ params: { id: mine.runner.watchId }, body: { ttlSeconds: 3600 } }),
  'POST /runner/watches/:id/cancel': (mine) => ({ params: { id: mine.runner.watchId } }),
  'POST /runner/watches/:id/release': (mine) => ({ params: { id: mine.runner.watchId } }),
};

/** The wiki's doors, as a field case of the header that names the calling session. */
const wikiRequests = (maintained: boolean): Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> =>
  Object.fromEntries(Object.entries(RUNNER_ISOLATION_CASES)
    .filter(([route]) => route.startsWith('GET /runner/wiki') || route.startsWith('POST /runner/wiki'))
    .filter(([, kase]) => {
      const sent = kase.request(SPELLED_MINE, SPELLED_MINE).headers?.['x-orbit-session-id'];
      return sent === (maintained ? 'mine.runner.wikiMaintainerSessionId' : 'mine.runner.wikiSessionId');
    })
    .map(([route, kase]) => [route, (mine: RunnerTenant) => kase.request(mine, mine)]));

/** A tenant whose every object reads as its own path, to tell which session a case names. */
const SPELLED_MINE: RunnerTenant = (function spell(prefix: string): RunnerTenant {
  return new Proxy({} as RunnerTenant, {
    get: (_, key) => (key === 'runner' || key === 'spare' ? spell(`${prefix}${String(key)}.`) : `${prefix}${String(key)}`),
  });
})('mine.');

export const RUNNER_ISOLATION_FIELD_CASES: Readonly<Record<string, RunnerFieldCase>> = {
  // ── the machine protocol ────────────────────────────────────────────────────────────────────────
  'POST /runner/heartbeat body supervisedSessionIds[]': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ supervisedSessionIds: [of.runner.machineSessionId] }) }),
  },
  'POST /runner/heartbeat body sessions[].sessionId': {
    as: RUNNER,
    request: (of) => ({
      params: {},
      body: heartbeat({ sessions: [{ sessionId: of.runner.machineSessionId, isolationStatus: 'worktree', changedFiles: [], worktreeDirty: true }] }),
    }),
  },
  'POST /runner/heartbeat body expiredCommitErrors[].sessionId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ expiredCommitErrors: [{ sessionId: of.runner.machineSessionId, operationId: LEASE }] }) }),
  },
  'POST /runner/heartbeat body agentDirProbes[].agentId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ agentDirProbes: [{ agentId: of.workspaceId, exists: true, isGitRepo: false }] }) }),
  },
  // B's own claim of an operation of its own, but A's operation named.
  'POST /runner/codex-rate-limit-reset-result body operationId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: {},
      body: {
        protocolVersion: 1, operationId: of.runner.codexOperationId, leaseOwner: mine.runner.leaseOwner, claimGeneration: 1,
        phase: 'CONSUME', kind: 'CONSUME_RETRYING', code: 'PROVIDER_ERROR',
      },
    }),
    heldRow: (of) => ['codex_rate_limit_reset_operation', of.runner.codexOperationId] as const,
  },
  'POST /runner/sessions/:id/artifacts/result body requestId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.runner.machineSessionId }, body: { requestId: of.runner.artifactRequestId, status: 'missing' } }),
  },
  'POST /runner/sessions/:id/artifacts/result body attachmentId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { requestId: mine.runner.artifactRequestId, status: 'uploaded', attachmentId: of.runner.sessionAttachmentId },
    }),
  },
  'POST /runner/sessions/:id/turn-complete body turnId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.runner.turnSessionId }, body: { turnId: of.runner.shellTurnId, status: 'SUCCEEDED' } }),
  },
  'POST /runner/sessions/:id/events body events[].turnId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { events: [{ seq: 1, type: 'user', ts: '2026-10-07T00:00:00.000Z', turnId: of.runner.shellTurnId, payload: { text: 'echo' } }] },
    }),
  },
  // What a run's events name in their payloads (RUNNER_OPAQUE_BODIES, below).
  'POST /runner/sessions/:id/events body events[].payload.taskId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { events: [{ seq: 1, type: 'task_changed', ts: '2026-10-07T00:00:00.000Z', payload: { taskId: of.taskId } }] },
    }),
  },
  'POST /runner/sessions/:id/events body events[].payload.taskIds[]': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { events: [{ seq: 1, type: 'task_changed', ts: '2026-10-07T00:00:00.000Z', payload: { taskIds: [of.taskId] } }] },
    }),
  },
  'POST /runner/sessions/:id/events body events[].payload.turnId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { events: [{ seq: 1, type: 'user_delivery', ts: '2026-10-07T00:00:00.000Z', payload: { delivery: 'acknowledged', turnId: of.runner.shellTurnId } }] },
    }),
  },
  'POST /runner/sessions/worktrees-removable body ids[]': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: { ids: [of.runner.orphanSessionId] } }),
  },

  // ── sessions ────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/sessions body workspaceId': {
    as: ['service', 'session'],
    request: (of) => ({ params: {}, body: { prompt: 'opened by the census', workspaceId: of.workspaceId } }),
  },
  'POST /runner/sessions body agentId': {
    as: ['service', 'session'],
    request: (of) => ({ params: {}, body: { prompt: 'opened by the census', agentId: of.workspaceId } }),
  },
  'POST /runner/sessions/import body workspaceId': {
    as: ['runner', 'service'],
    request: (of) => ({ params: {}, body: { claudeSessionId: '00000000-0000-4000-8000-0000000c1a0f', workspaceId: of.workspaceId } }),
  },
  // A transcript another account already imported — its engine session id, which a stranger may know.
  // Titled, so that what the two imports are answered with is not told apart by a title spelled from the id.
  'POST /runner/sessions/import body claudeSessionId': {
    as: ['runner', 'service'],
    request: (of, mine) => ({
      params: {},
      body: { claudeSessionId: of.runner.runtimeSessionId, workspaceId: mine.workspaceId, title: 'imported by the census' },
    }),
  },
  'GET /runner/sessions query parentSessionId': {
    as: ['runner', 'service', 'session'],
    request: (of) => ({ params: {}, query: { parentSessionId: of.sessionId } }),
  },
  // A message's key, as the platform's own keys spell an object of the account's in it: the key of the
  // turn that hands an open item to its coordinator is `open-item:v1:<item id>:<generation>`.
  'POST /runner/sessions/:id/turns body clientTurnId': {
    as: ['runner', 'service', 'session'],
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { message: 'from the census', clientTurnId: openItemTurnKey(of) } }),
  },
  'POST /runner/sessions/:id/interrupt body clientTurnId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.runner.interruptSessionId }, body: { message: 'from the census', clientTurnId: openItemTurnKey(of) } }),
  },
  ...Object.fromEntries(Object.entries(ownSessionRequests).map(([route, own]) => [`${route} header x-orbit-session-id`, fromTheirSession(SESSION, own)])),

  // ── tasks and lists ─────────────────────────────────────────────────────────────────────────────
  ...taskCreateFieldCases('POST /runner/tasks', (task) => task, ''),
  ...taskCreateFieldCases('POST /runner/tasks/batch-create', (task) => ({ tasks: [task] }), 'tasks[].'),
  ...taskCreateFieldCases('POST /runner/tasks/batch-preview', (task) => ({ tasks: [task] }), 'tasks[].'),
  'POST /runner/tasks header x-orbit-session-id': fromTheirSession(RUNNER, () => ({ params: {}, body: taskBody() })),
  'POST /runner/tasks header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', () => ({ params: {}, body: taskBody() })),
  'POST /runner/tasks header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', () => ({ params: {}, body: taskBody() })),
  'POST /runner/tasks/batch-create header x-orbit-session-id': fromTheirSession(RUNNER, () => ({ params: {}, body: { tasks: [taskBody()] } })),
  'POST /runner/tasks/batch-create header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', () => ({ params: {}, body: { tasks: [taskBody()] } })),
  'POST /runner/tasks/batch-create header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', () => ({ params: {}, body: { tasks: [taskBody()] } })),
  ...taskFilterCases('GET /runner/tasks', ['projectId', 'listId']),
  ...taskFilterCases('GET /runner/tasks/labels', ['listId']),
  ...taskFilterCases('GET /runner/tasks/page', ['projectId', 'listId']),
  'POST /runner/tasks/batch-pin body taskIds[]': { as: RUNNER, request: (of, mine) => ({ params: {}, body: { taskIds: [mine.taskId, of.taskId], model: 'census' } }) },
  'POST /runner/tasks/batch-pin body projectId': { as: RUNNER, request: (of) => ({ params: {}, body: { projectId: of.projectId, model: 'census' } }) },
  'POST /runner/tasks/batch-pin body listId': { as: RUNNER, request: (of) => ({ params: {}, body: { listId: of.listId, model: 'census' } }) },
  'PATCH /runner/tasks/:id body assigneeId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { assigneeId: of.workspaceId } }) },
  'PATCH /runner/tasks/:id body listId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { listId: of.listId } }) },
  'PATCH /runner/tasks/:id body projectId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { projectId: of.projectId } }) },
  'PATCH /runner/tasks/:id body fixesOpenItemId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.projectTaskId }, body: { fixesOpenItemId: of.openItemId } }),
  },
  'PATCH /runner/tasks/:id body parentTaskId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { parentTaskId: of.taskId } }) },
  'PATCH /runner/tasks/:id body dependsOnTaskIds[]': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { dependsOnTaskIds: [mine.dependencyTaskId, of.dependencyTaskId] } }),
  },
  // With a verdict: the one write that takes the subject's row before it reads it.
  'PATCH /runner/tasks/:id body verifiesTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.runner.verifierTaskId }, body: { verifiesTaskId: of.runner.verifiedTaskId, verdict: 'FAIL' } }),
    heldRow: (of) => ['task', of.runner.verifiedTaskId] as const,
  },
  'PATCH /runner/tasks/:id body supersededByTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { supersededByTaskId: of.taskId } }),
  },
  'PATCH /runner/tasks/:id header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.taskId }, body: { title: 'renamed by the census' } })),
  'POST /runner/tasks/:id/execute header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.taskId }, body: {} })),
  'POST /runner/tasks/:id/dependencies body dependsOnTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { dependsOnTaskId: of.dependencyTaskId } }),
  },
  'POST /runner/tasks/:id/comments body mentions[]': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { body: 'from the census', mentions: [of.workspaceId] } }),
  },
  'POST /runner/tasks/:id/comments header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.taskId }, body: { body: 'from the census' } })),
  'POST /runner/tasks/:id/comments header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', (mine) => ({ params: { id: mine.taskId }, body: { body: 'from the census' } })),
  'POST /runner/tasks/:id/comments header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', (mine) => ({ params: { id: mine.taskId }, body: { body: 'from the census' } })),
  'PATCH /runner/task-lists/:id body foremanWorkspaceId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.listId }, body: { foremanWorkspaceId: of.workspaceId } }),
  },
  'PATCH /runner/task-lists/:id header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.listId }, body: { title: 'renamed by the census' } })),
  'PATCH /runner/task-lists/:id header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', (mine) => ({ params: { id: mine.listId }, body: { title: 'renamed by the census' } })),
  'PATCH /runner/task-lists/:id header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', (mine) => ({ params: { id: mine.listId }, body: { title: 'renamed by the census' } })),
  'POST /runner/task-lists/:id/dag-preview body ops[].taskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.listId }, body: { ops: [{ op: 'add', taskId: of.runner.listTaskId, dependsOnTaskId: mine.dependencyTaskId }] } }),
  },
  'POST /runner/task-lists/:id/dag-preview body ops[].dependsOnTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.listId }, body: { ops: [{ op: 'add', taskId: mine.runner.listTaskId, dependsOnTaskId: of.dependencyTaskId }] } }),
  },
  'POST /runner/task-lists/:id/dag-apply body ops[].taskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.listId }, body: { ops: [{ op: 'add', taskId: of.runner.listTaskId, dependsOnTaskId: mine.dependencyTaskId }] } }),
  },
  'POST /runner/task-lists/:id/dag-apply body ops[].dependsOnTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.listId }, body: { ops: [{ op: 'add', taskId: mine.runner.listTaskId, dependsOnTaskId: of.dependencyTaskId }] } }),
  },
  'POST /runner/tasks/:taskId/evidence header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { taskId: mine.evidenceTaskId }, body: { evidence: evidence('submitted by the census') } }),
    (of) => of.evidenceSessionId,
  ),
  'POST /runner/tasks/:taskId/evidence header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', (mine) => ({
    params: { taskId: mine.evidenceTaskId }, headers: calling(mine.evidenceSessionId), body: { evidence: evidence('submitted by the census') },
  })),
  'POST /runner/tasks/:taskId/evidence header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', (mine) => ({
    params: { taskId: mine.evidenceTaskId }, headers: calling(mine.evidenceSessionId), body: { evidence: evidence('submitted by the census') },
  })),
  'POST /runner/tasks/:taskId/evidence/decision header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { taskId: mine.evidenceTaskId }, body: { decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' } }),
    (of) => of.sessionId,
  ),
  'POST /runner/tasks/:taskId/evidence/decision header x-orbit-workspace-id': fromTheirWorkspace('x-orbit-workspace-id', (mine) => ({
    params: { taskId: mine.evidenceTaskId }, headers: calling(mine.sessionId), body: { decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' },
  })),
  'POST /runner/tasks/:taskId/evidence/decision header x-orbit-agent-id': fromTheirWorkspace('x-orbit-agent-id', (mine) => ({
    params: { taskId: mine.evidenceTaskId }, headers: calling(mine.sessionId), body: { decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' },
  })),
  'POST /runner/tasks/:taskId/owner-confirmation/claim header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { taskId: mine.runner.confirmTaskId } }),
    (of) => of.runner.confirmRunSessionId,
  ),
  'POST /runner/tasks/:taskId/owner-confirmation/review header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { taskId: mine.runner.confirmTaskId }, body: { requestId: mine.runner.confirmRequestId, judgment: 'the census' } }),
    (of) => of.runner.reviewerSessionId,
  ),
  'POST /runner/tasks/:taskId/owner-confirmation/review body requestId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { taskId: mine.runner.confirmTaskId },
      headers: calling(mine.runner.reviewerSessionId),
      body: { requestId: of.runner.confirmRequestId, judgment: 'the census' },
    }),
  },
  'POST /runner/tasks/:taskId/owner-confirmation/return header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({
      params: { taskId: mine.runner.confirmTaskId },
      body: { requestId: mine.runner.confirmRequestId, reason: 'the census', problems: [{ text: 'the census' }] },
    }),
    (of) => of.runner.reviewerSessionId,
  ),
  'POST /runner/tasks/:taskId/owner-confirmation/return body requestId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { taskId: mine.runner.confirmTaskId },
      headers: calling(mine.runner.reviewerSessionId),
      body: { requestId: of.runner.confirmRequestId, reason: 'the census', problems: [{ text: 'the census' }] },
    }),
  },

  // ── projects ────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/projects body workspaceId': {
    as: SESSION,
    request: (of) => ({ params: {}, body: { title: 'census project', workspaceId: of.workspaceId } }),
  },
  'POST /runner/projects header x-orbit-session-id': fromTheirSession(
    RUNNER,
    () => ({ params: {}, body: { title: 'census project' } }),
    (of) => of.runner.newCoordinatorSessionId,
  ),
  'PATCH /runner/projects/:id body acceptanceCriteriaItems[].id': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.projectId },
      body: {
        acceptanceCriteriaItems: [
          { id: mine.projectCriterionId, text: 'the census holds', verificationMethod: 'the census' },
          { id: of.projectCriterionId, text: 'the census holds elsewhere', verificationMethod: 'the census' },
        ],
      },
    }),
  },
  // The session an edit of the criteria is attributed to — an edit that changes them, so there is one.
  'PATCH /runner/projects/:id header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({
    params: { id: mine.projectId },
    body: { acceptanceCriteriaItems: [{ id: mine.projectCriterionId, text: 'the census holds, as reworded', verificationMethod: 'the census' }] },
  })),
  'POST /runner/projects/:id/coordinator/messages body clientTurnId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.projectId }, body: { message: 'from the census', clientTurnId: openItemTurnKey(of) } }),
  },
  'POST /runner/projects/:id/owner-questions body blocksTaskIds[]': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { question: 'Which first?', blocksTaskIds: [of.projectTaskId] },
    }),
  },
  // The card the owner answered the skip on: B's own landing, A's approval.
  'POST /runner/projects/:id/tasks/:taskId/integration/skip-merge-check body approvalId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.projectId, taskId: mine.projectTaskId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census', approvalId: of.runner.allowedApprovalId },
    }),
  },
  ...Object.fromEntries(Object.entries(coordinatorRequests).map(([route, own]) => [
    `${route} header x-orbit-session-id`,
    fromTheirSession(RUNNER, own, (of) => of.runner.coordinatorSessionId),
  ])),

  // ── watches, service tokens, workspaces, notifications ───────────────────────────────────────────
  'POST /runner/watches body targets[].id': {
    as: RUNNER,
    request: (of, mine) => ({ params: {}, headers: calling(mine.runner.callingSessionId), body: watchBody(of.taskId) }),
  },
  ...Object.fromEntries(Object.entries(observerRequests).map(([route, own]) => [`${route} header x-orbit-session-id`, fromTheirSession(RUNNER, own)])),
  'POST /runner/service-tokens body workspaceId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: { scopes: ['session:get'], ttlSeconds: 3600, workspaceId: of.workspaceId } }),
  },
  'POST /runner/service-tokens body agentId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: { scopes: ['session:get'], ttlSeconds: 3600, agentId: of.workspaceId } }),
  },
  'POST /runner/workspaces body runnerId': { as: SESSION, request: (of) => ({ params: {}, body: { name: 'census workspace', runnerId: of.runnerId } }) },
  'POST /runner/agents body runnerId': { as: SESSION, request: (of) => ({ params: {}, body: { name: 'census agent', runnerId: of.runnerId } }) },
  'PATCH /runner/workspaces/:id body runnerId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.workspaceId }, body: { runnerId: of.runnerId } }),
  },
  'PATCH /runner/agents/:id body runnerId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.workspaceId }, body: { runnerId: of.runnerId } }),
  },
  'POST /runner/notify header x-orbit-session-id': fromTheirSession(RUNNER, () => ({ params: {}, body: { message: 'from the census' } })),

  // ── the wiki ────────────────────────────────────────────────────────────────────────────────────
  'GET /runner/wiki/search header x-orbit-session-id': fromTheirSession(RUNNER, () => ({ params: {}, query: { q: 'census' } }), (of) => of.runner.wikiSessionId),
  'POST /runner/wiki/changesets body spaceId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: {},
      body: { spaceId: of.wikiSpaceId, ops: [{ op: 'challenge', entryId: mine.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true },
    }),
  },
  'POST /runner/wiki/changesets header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: {}, body: { ops: [{ op: 'challenge', entryId: mine.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true } }),
    (of) => of.runner.wikiSessionId,
  ),
  'POST /runner/wiki/spaces/:id/imports body spaceId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.wikiSpaceId },
      headers: calling(mine.runner.wikiSessionId),
      body: { spaceId: of.wikiSpaceId, ops: [{ op: 'challenge', entryId: mine.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true },
    }),
  },
  'POST /runner/wiki/spaces/:id/maintenance/changesets body spaceId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.wikiSpaceId },
      headers: calling(mine.runner.wikiMaintainerSessionId),
      body: { spaceId: of.wikiSpaceId, ops: [{ op: 'challenge', entryId: mine.wikiEntryId, reason: 'the census challenges it' }], rationale: 'the census', dryRun: true },
    }),
  },
  'GET /runner/wiki/spaces/:id/plan/check query jobId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.wikiSpaceId }, query: { jobId: of.runner.wikiPlanJobId } }),
  },
  // The two headless doors take a calling session too, and then hold it to the space's maintainer.
  'GET /runner/wiki/spaces/:id/plan/check header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { id: mine.wikiSpaceId }, query: { jobId: mine.runner.wikiPlanJobId } }),
    (of) => of.runner.wikiMaintainerSessionId,
  ),
  'GET /runner/wiki/spaces/:id/maintenance/check header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => RUNNER_ISOLATION_CASES['GET /runner/wiki/spaces/:id/maintenance/check'].request(mine, mine),
    (of) => of.runner.wikiMaintainerSessionId,
  ),
  ...Object.fromEntries(Object.entries(wikiRequests(false)).map(([route, own]) => [
    `${route} header x-orbit-session-id`,
    fromTheirSession(RUNNER, own, (of) => of.runner.wikiSessionId),
  ])),
  ...Object.fromEntries(Object.entries(wikiRequests(true)).map(([route, own]) => [
    `${route} header x-orbit-session-id`,
    fromTheirSession(RUNNER, own, (of) => of.runner.wikiMaintainerSessionId),
  ])),
};

/**
 * The plan-usage snapshot a heartbeat reports, wherever it nests: provider-side names of rate-limit
 * buckets and credits, kept on the reporting machine's own row and read back only through it.
 */
const PLAN_USAGE_IDS = ['limitId', 'rateLimits[].limitId', 'rateLimitReset.rateLimitResetCredits.credits[].id', 'buckets[].id'];
const planUsageReadings = Object.fromEntries(
  ['planUsage.', 'planUsage.claude.', 'planUsage.codex.', 'planUsage.kimi.', 'planUsage.antigravity.', 'engines[].planUsage.']
    .flatMap((at) => PLAN_USAGE_IDS.map((id) => [
      `POST /runner/heartbeat body ${at}${id}`,
      'a provider\'s own name for one of its rate-limit buckets or credits, not an Orbit row: stored as the reporting '
        + 'machine\'s own plan usage and read back only through that machine (runner-api.controller.ts:1085)',
    ])),
);

/** Ids a runner-gate request carries that name nothing of an account's to reach, with why and where. */
export const RUNNER_ISOLATION_FIELDS_BY_HAND: Readonly<Record<string, string>> = {
  // ── the wiki's import on the server ──────────────────────────────────────────────────────────────
  'POST /runner/wiki/spaces/:id/import-jobs body id':
    'the id the command names for the job it is making: the insert does nothing when the id is taken, and the job '
    + 'answered is read back by (id, the caller\'s owner, the path\'s space, kind import), so another account\'s job '
    + 'under that id is neither read nor written (wiki-import-jobs.ts:115)',
  // ── the machine protocol: tokens the machine or the engine makes up, and the machine's own snapshots ──
  'POST /runner/heartbeat body expiredCommitErrors[].operationId':
    'the commit attempt token the server minted for one of the machine\'s own sessions: compared only in the update '
    + 'scoped to that session on this runner (runner-api.controller.ts:1255)',
  'POST /runner/heartbeat body commands[].agentId':
    'part of the slash-command catalogue the machine reports about itself, stored on its own row and read back only '
    + 'through it (runner-api.controller.ts:1024)',
  'POST /runner/heartbeat body skills[].agentId':
    'part of the skills catalogue the machine reports about itself, stored on its own row beside the commands '
    + '(runner-api.controller.ts:1024)',
  ...planUsageReadings,
  'POST /runner/heartbeat body engines[].accounts[].id':
    'an engine account\'s directory on that machine (`default` or eight hex digits), stored in its own engine health '
    + '(runner-api.controller.ts:1046)',
  'POST /runner/heartbeat body repos[].agentIds[]':
    'which of the machine\'s checkouts serve which workspace, kept as its own repo-health snapshot and read only '
    + 'through a workspace of its own (runner-api.controller.ts:1075)',
  'POST /runner/codex-rate-limit-reset-result body rateLimitReset.rateLimitResetCredits.credits[].id':
    'a provider\'s credit id inside a reset result, which a REFRESHED result stores as the reporting machine\'s own '
    + 'plan usage (codex-reset-relay.ts:211)',
  'POST /runner/claude-history-result body transcripts[].claudeSessionId':
    'a transcript file on the reporting machine, stored as that machine\'s own history scan (runner-api.controller.ts:1707)',
  'POST /runner/sessions/:id/approvals body toolUseId':
    'the engine\'s id for one tool call, a key only within the session the path names (runner-api.controller.ts:3867)',
  'POST /runner/sessions/:id/approvals body backgroundJobId':
    'the id the machine gave one of its own processes, stored on the approval of the session the path names '
    + '(runner-api.controller.ts:3900)',
  'POST /runner/sessions/:id/background-wake body wakeId':
    'the machine\'s key for one wake of one of its jobs, made into a turn key of the session the path names '
    + '(runner-api.controller.ts:4094)',
  'POST /runner/sessions/:id/background-wake body jobId':
    'the id the machine gave one of its own processes, looked up only among the session\'s own wakes '
    + '(background-job-wake.ts:147)',
  'POST /runner/sessions/:id/turn-complete body runtimeSessionId':
    'the engine\'s own id for its conversation, stored on the session the path names; the one reader that compared it '
    + 'across accounts, the transcript import, compares within the account (sessions.service.ts:1449)',
  'POST /runner/sessions/:id/finalize body claudeSessionId':
    'the engine\'s own id for its conversation, under its older name, stored as the next field is '
    + '(runner-api.controller.ts:6151)',
  'POST /runner/sessions/:id/finalize body runtimeSessionId':
    'the engine\'s own id for its conversation, stored on the session the path names (runner-api.controller.ts:6151)',
  'POST /runner/sessions/:id/complete body claudeSessionId':
    'as finalize\'s: complete is finalize under another name (runner-api.controller.ts:6151)',
  'POST /runner/sessions/:id/complete body runtimeSessionId':
    'as finalize\'s: complete is finalize under another name (runner-api.controller.ts:6151)',
  'POST /runner/sessions/:id/merge-result body operationId':
    'the merge attempt token the server minted for the session the path names, compared only with that locked row '
    + '(runner-api.controller.ts:6554)',
  'POST /runner/sessions/:id/merge-result body recovery.previewId':
    'compared only with the recovery the session the path names has stored (runner-api.controller.ts:6582)',
  'POST /runner/sessions/:id/commit-result body operationId':
    'the commit attempt token the server minted for the session the path names, compared only with that locked row '
    + '(runner-api.controller.ts:6789)',
  // A run event's payload (RUNNER_OPAQUE_BODIES).
  'POST /runner/sessions/:id/events body events[].payload.sessionId':
    'an init event\'s engine conversation id, stored on the session the path names as its runtime id '
    + '(runtime-init.ts:17); see turn-complete\'s runtimeSessionId',
  'POST /runner/sessions/:id/events body events[].payload.id':
    'the engine\'s id for one tool call, matched only within the session the path names (runner-api.controller.ts:5723)',
  'POST /runner/sessions/:id/events body events[].payload.toolUseId':
    'the engine\'s id for one tool call, matched only within the session the path names (runner-api.controller.ts:5746)',
  'POST /runner/sessions/:id/events body events[].payload.parentToolUseId':
    'the engine\'s id for the tool call a sub-agent\'s event belongs to, read only to tell its text from the main '
    + 'conversation\'s (runner-api.controller.ts:5549)',

  // ── sessions ────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/sessions/import header x-orbit-session-id':
    'any calling session at all refuses the import before anything is read: it is a shell\'s door '
    + '(runner-sessions.controller.ts:222)',
    
  // ── tasks ───────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/tasks/:id/execute body triggerId':
    'an idempotency key the caller makes up for one press: it keys only the caller\'s own run receipt '
    + '(tasks.service.ts:12768)',
  'POST /runner/tasks/:taskId/owner-confirmation body requestId':
    'never read: this door refuses every caller before reading anything (task-owner-confirmation.service.ts:205)',
  'POST /runner/tasks/:taskId/owner-confirmation body reviewRecordId':
    'never read: this door refuses every caller before reading anything (task-owner-confirmation.service.ts:205)',
  'POST /runner/tasks/:taskId/owner-confirmation header x-orbit-session-id':
    'never looked up: this door refuses every caller before reading anything (task-owner-confirmation.service.ts:205)',

  // ── projects ────────────────────────────────────────────────────────────────────────────────────
  'POST /runner/projects body coordinatorAgentId':
    'the account owner\'s to set: refused to every machine before anything is read (runner-projects.controller.ts:600)',
  'PATCH /runner/projects/:id body coordinatorAgentId':
    'the account owner\'s to set: refused to every machine before anything is read (runner-projects.controller.ts:600)',
  'POST /runner/projects body acceptanceCriteriaItems[].evidenceTaskId':
    'a removed field: any value is refused by validation, before the handler (projects/dto.ts:171)',
  'PATCH /runner/projects/:id body acceptanceCriteriaItems[].evidenceTaskId':
    'a removed field: any value is refused by validation, before the handler (projects/dto.ts:171)',
    'POST /runner/projects/:id/acceptance/merge-evidence body requirementId':
    'a name the evidence is filed under, matched only within the project the path names, which is locked under its '
    + 'owner first (project-acceptance.service.ts:868)',
  'POST /runner/projects/:id/owner-questions body clientQuestionId':
    'the coordinator\'s own key for one question, a dedupe key within the project the path names '
    + '(project-open-item.service.ts:686)',
  // The skip door's `approvalId` is sent by the census itself (RUNNER_ISOLATION_FIELD_CASES above): a real case is
  // the stronger registration, and the census refuses a key registered both ways.

  // ── the wiki: what a Record body carries (RUNNER_OPAQUE_BODIES) ─────────────────────────────────────
  'POST /runner/wiki/spaces/:id/articles/:slug body articles[].entries[]':
    'never looked up: an article keeps only the ids that are entries of the topic being written, and drops the rest '
    + '(wiki-articles.ts:1028)',
  'POST /runner/wiki/spaces/:id/plan/drafts body docs[].sections[].sources.sessions.projects[]':
    'looked up among the account\'s own projects only; one that is not is refused as no project of this account '
    + '(wiki-plan.ts:1159)',
  'POST /runner/wiki/spaces/:id/plan/proposals body facts[].id':
    'looked up among the space\'s own entries and the account\'s own sessions only; another is refused as no entry '
    + 'or session of this account (wiki-plan.ts:1590)',
  'POST /runner/wiki/spaces/:id/docs/:slug body sections[].footnotes[].viaEntryId':
    'looked up among the space\'s own entries only; another is refused as not an entry of this space '
    + '(wiki-docs.ts:1127)',
  'POST /runner/wiki/spaces/:id/docs/:slug body sections[].footnotes[].ref':
    'read through the account\'s own sources only; a record of another account is no record, kept as an '
    + 'unresolved footnote (wiki-docs.ts:1251)',
};

/**
 * Bodies, or parts of bodies, declared with a type that names no fields (`Record<string, unknown>`,
 * `unknown`), keyed `<route> body <where>`: which ids the code reads there — each then a field like
 * any other — and the reading, with file:line, of what it reads.
 */
export const RUNNER_OPAQUE_BODIES: Readonly<Record<string, { reads: readonly string[]; reading: string }>> = {
  'POST /runner/wiki/repo-ops/:id/result body result.*': {
    reads: [],
    reading: 'the runner\'s own answer — a snapshot\'s index, a read\'s text, a diff\'s paths, an anchor\'s states — '
      + 'stored as it is on the operation it holds and never dereferenced (wiki-worker/wiki-repo-ops.ts:436, the row '
      + 'the result is written to)',
  },
  'POST /runner/integration-jobs/:jobId/result body errorDetail.*': {
    reads: [],
    reading: 'the runner\'s own account of a failure, stored as it is on the job it holds and never dereferenced '
      + '(integration-job-relay.ts:896)',
  },
  'POST /runner/sessions/:id/source/pin body refusal.detail.*': {
    reads: [],
    reading: 'stored as it is on the session the path names, beside the refusal code (session-source.ts:520)',
  },
  'POST /runner/sessions/:id/approvals body input': {
    reads: [],
    reading: 'the tool call\'s own input, shown on the approval card; what it is read for — a project-create card\'s '
      + 'reviews and a task-create preview — is read under the session\'s own owner (runner-api.controller.ts:3879, :3976)',
  },
  'POST /runner/sessions/:id/events body events[].payload.*': {
    reads: [
      'body events[].payload.taskId',
      'body events[].payload.taskIds[]',
      'body events[].payload.turnId',
      'body events[].payload.sessionId',
      'body events[].payload.id',
      'body events[].payload.toolUseId',
      'body events[].payload.parentToolUseId',
    ],
    reading: 'a run event\'s payload as the engine wrote it; what the handler reads of it by id is the task a '
      + '`task_changed` names, the turn a `user_delivery` acknowledges, the init event\'s engine id and the tool-call '
      + 'ids (runner-api.controller.ts:5549, :5723, :5746)',
  },
  'POST /runner/tasks/:taskId/owner-confirmation/review body *': {
    reads: ['body requestId'],
    reading: 'parsed field by field; the one id is the request under review, read with the task and its owner '
      + '(owner-confirmation-review.service.ts:639)',
  },
  'POST /runner/tasks/:taskId/owner-confirmation/return body *': {
    reads: ['body requestId'],
    reading: 'parsed as the review\'s is; the one id is the request being returned (owner-confirmation-review.service.ts:639)',
  },
  'POST /runner/sessions/:id/turns body expectReply': {
    reads: [],
    reading: 'a flag, refused unless it is a boolean (sessions/session-request.ts:131)',
  },
  'POST /runner/sessions/:id/turns body replyOptions': {
    reads: [],
    reading: 'the reply\'s option labels: text, no id (sessions/session-request.ts:143)',
  },
  'POST /runner/sessions/:id/turns body replyWithinSeconds': {
    reads: [],
    reading: 'a number of seconds (sessions/session-request.ts:144)',
  },
  'POST /runner/workspaces body (the body)': {
    reads: ['body runnerId'],
    reading: 'whitelisted field by field; the one id is the runner the workspace runs on (runner-agents.controller.ts:106)',
  },
  'POST /runner/agents body (the body)': {
    reads: ['body runnerId'],
    reading: 'the same body under the workspaces\' pre-rename name (runner-agents.controller.ts:106)',
  },
  'PATCH /runner/workspaces/:id body (the body)': {
    reads: ['body runnerId'],
    reading: 'whitelisted as on create; the one id is the runner to move it to (runner-agents.controller.ts:127)',
  },
  'PATCH /runner/agents/:id body (the body)': {
    reads: ['body runnerId'],
    reading: 'the same body under the workspaces\' pre-rename name (runner-agents.controller.ts:127)',
  },
  'POST /runner/wiki/spaces/:id/articles/:slug body *': {
    reads: ['body articles[].entries[]'],
    reading: 'an article as the local model wrote it; the ids are the entries it was written from (wiki-articles.ts:1028)',
  },
  'POST /runner/wiki/spaces/:id/plan/drafts body *': {
    reads: ['body docs[].sections[].sources.sessions.projects[]'],
    reading: 'a plan draft; the ids are the projects a section\'s session sources are drawn from (wiki-plan.ts:484, :1159)',
  },
  'POST /runner/wiki/spaces/:id/plan/proposals body *': {
    reads: ['body facts[].id'],
    reading: 'a proposal to change the plan; the ids are the entries and sessions its facts cite (wiki-plan.ts:1590)',
  },
  'POST /runner/wiki/spaces/:id/plan/job/progress body *': {
    reads: [],
    reading: 'an attempt number, or document counts — no id (wiki-plan.ts:1762)',
  },
  'POST /runner/wiki/spaces/:id/plan/job/finish body *': {
    reads: [],
    reading: 'an outcome, a version of the space\'s own plan and the job\'s report — no id of anything else (wiki-plan.ts:1804)',
  },
  'POST /runner/wiki/spaces/:id/maintenance/docs/withdrawals body *': {
    reads: [],
    reading: 'a commit and file paths of the space\'s repository — no id (wiki-docs.ts:1026)',
  },
  'POST /runner/wiki/spaces/:id/docs/:slug body *': {
    reads: ['body sections[].footnotes[].viaEntryId', 'body sections[].footnotes[].ref'],
    reading: 'a document\'s sections; the ids are a footnote\'s via entry and the record it cites (wiki-docs.ts:1127, :1251)',
  },
};

// ── The share links' doors ────────────────────────────────────────────────────────────────────────

/** A share link of the account's, by what it shares. */
export type SharedLinkKind = 'session' | 'task' | 'project';

export interface SharedCase {
  /**
   * The request through a link of each kind that serves the route, on `of`'s objects under that
   * link — the token is `link`'s.
   */
  through: Partial<Record<SharedLinkKind, (of: RunnerTenant, token: string) => TenantRequest>>;
  /** Where the object under the link sits in the request: a path param, or `query path`. */
  under: readonly string[];
}

/** A run of what a link shares — the task's, or one of the project's tasks' — by the kind of link. */
const runThrough = (path: (sessionId: string, token: string) => TenantRequest) => ({
  task: (of: RunnerTenant, token: string) => path(of.runner.sharedTaskRunSessionId, token),
  project: (of: RunnerTenant, token: string) => path(of.runner.sharedProjectRunSessionId, token),
});

export const SHARED_ISOLATION_CASES: Readonly<Record<string, SharedCase>> = {
  'GET /shared/:token/tasks/:taskId': {
    through: { project: (of, token) => ({ params: { token, taskId: of.runner.sharedProjectTaskId } }) },
    under: ['taskId'],
  },
  'GET /shared/:token/sessions/:sessionId': {
    through: runThrough((sessionId, token) => ({ params: { token, sessionId } })),
    under: ['sessionId'],
  },
  'GET /shared/:token/sessions/:sessionId/events': {
    through: runThrough((sessionId, token) => ({ params: { token, sessionId } })),
    under: ['sessionId'],
  },
  'GET /shared/:token/sessions/:sessionId/events/:seq': {
    through: runThrough((sessionId, token) => ({ params: { token, sessionId, seq: 1 } })),
    under: ['sessionId'],
  },
  'GET /shared/:token/attachments/:id': {
    through: {
      session: (of, token) => ({ params: { token, id: of.runner.sharedSessionAttachmentId } }),
      task: (of, token) => ({ params: { token, id: of.runner.sharedTaskAttachmentId } }),
      project: (of, token) => ({ params: { token, id: of.runner.sharedProjectAttachmentId } }),
    },
    under: ['id'],
  },
  // A legacy artifact path names the session it was uploaded under: the link's own is the only one it may.
  'GET /shared/:token/artifacts': {
    through: {
      session: (of, token) => ({ params: { token }, query: { path: `/census/.orbit/uploads/${of.runner.sharedSessionId}/census.txt` } }),
    },
    under: ['query path'],
  },
};

/** Routes and fields of the share links' doors that name nothing but the link, with why and where. */
export const SHARED_BY_HAND: Readonly<Record<string, string>> = {
  'GET /shared/:token':
    'names nothing but its link: the token is found among ACTIVE links and what it opens is that link\'s own root '
    + '(share-links.service.ts:281); `limit`, `maxPayload` and `preview` are numbers and a flag',
  'GET /shared/:token/events':
    'a page of the link\'s own session — `before` and `limit` are numbers, and any link that is not a session\'s is '
    + 'the one 404 (shared.controller.ts:196)',
  'GET /shared/:token/events/:seq':
    'a position in the link\'s own session\'s transcript, not an object: read WHERE session_id = the link\'s '
    + '(sessions.service.ts:3719)',
  'GET /shared/:token/docs/:slug':
    'a document slug of the link\'s own wiki space, not an object a caller can name: the space is the link\'s '
    + '(share-links.service.ts:378), and the slug is looked up among that space\'s own written documents — any '
    + 'other is the one 404 (public-wiki.ts:155)',
};

/**
 * Every other route behind no account guard, and why it reaches no account's object: each takes no
 * id at all, only a secret that is itself the credential — and a secret that matches nothing is
 * answered alike whoever made the one that does.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  'GET /health':
    'a constant `{status:"ok"}` that touches no table — health/health.controller.ts:27',
  'ALL /gw/codex':
    'the Codex pools\' gateway: its one credential is a gateway session token, found by its hash and bound to the '
    + '(pool, person, session) it was issued for, so a token reaches only the session it belongs to; the path is '
    + 'the upstream API\'s, with no Orbit id in it — pool-gateway.controller.ts:37, pool-gateway.service.ts:278, '
    + 'pool-login-gateway.service.ts:282',
  'ALL /gw/codex/{*path}':
    'the same gateway, for every path under it; one outside its list is refused before anything is forwarded — '
    + 'pool-gateway.controller.ts:46',
  'POST /auth/login':
    'email and password; finds the one user by email and answers a wrong pair as an unknown one — auth.service.ts:32',
  'GET /auth/methods':
    'which sign-in methods the deployment offers; reads the one sign-in setting, nobody\'s object — '
    + 'sign-in-providers.service.ts:80',
  'GET /auth/setup-status':
    'whether any user exists yet (a count) — auth.service.ts:52',
  'POST /auth/bootstrap':
    'the first-run setup: refused once any user exists, so it can only ever create the first account — '
    + 'auth.service.ts:64',
  'POST /auth/refresh':
    'the refresh token is the credential, found by its hash; it mints tokens only for the user it was issued to — '
    + 'auth.service.ts:125',
  'POST /auth/logout':
    'revokes the refresh token found by its hash, and answers an unknown one alike — auth.service.ts:152',
  'POST /access-tokens/device/start':
    'opens an `orbit login` request: writes a new row of its own and names no existing object — '
    + 'pat-device-login.service.ts:59',
  'POST /access-tokens/device/poll':
    'the device code is the credential, found by its hash; it hands over only the token the request\'s own '
    + 'approver decided — pat-device-login.service.ts:93',
  'GET /auth/google/start':
    'starts a Google sign-in flow of its own (a new row, a browser cookie); takes no id — google-login.service.ts:277',
  'GET /auth/google/callback':
    'Google\'s return: the state is found by its hash and must match the browser cookie the start set — '
    + 'google-login.service.ts:390',
  'POST /auth/google/exchange':
    'the ticket is found by its hash and must come with the code verifier of the flow that made it — '
    + 'google-login.service.ts:455',
  'POST /runner/register':
    'the one-time enrollment token is the credential, found by its hash; the runner it makes or renews belongs to '
    + 'that token\'s owner — runner-api.controller.ts:802, :813',
  'POST /runner/device/start':
    'opens a runner device sign-in: writes a new enrollment row of its own and names no existing object — '
    + 'runner-api.controller.ts:893',
  'POST /runner/device/poll':
    'the device code is the credential, found by its hash; it hands over only the runner the request\'s own '
    + 'approver made — runner-api.controller.ts:865',
  'POST /managed-runner/admission':
    'the managed runner admission webhook, called by the Kubernetes API server: its credential is the bearer token '
    + 'whose SHA-256 the managed runner profile holds (404 with the feature off) — managed-runner-admission.controller.ts:56; '
    + 'its body is an AdmissionReview whose ids are Kubernetes UIDs and names, and it reads only the managed_runner '
    + 'rows owning the claims the reviewed Pod names, in the configured cluster and namespace, answering allowed or '
    + 'not — managed-runner-admission.controller.ts:97',
};
