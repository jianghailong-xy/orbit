import { evidence, type Tenant, type TenantRequest } from './tenant-isolation-cases';
import { underEveryDrivePrefix, underEveryRunnerDrivePrefix } from '../drive/drive-routes';

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
  /** An OPEN landing session of this account: the platform's container, on no runner (§2.9 LS6). */
  landingSessionId: string;
  /** RUNNING, no inbox lease. */
  takeoverSessionId: string;
  /** RUNNING, its inbox leased to `leaseOwner` at `leaseGeneration`. */
  activateSessionId: string;
  leaseOwner: string;
  leaseGeneration: string;
  /** RUNNING, an interrupt waiting in its inbox. */
  inboxSessionId: string;
  /** The inbox session's live lease generation, which an inbox fetch names. */
  inboxLeaseGeneration: string;
  /** RUNNING, the shell turn `shellTurnId` in flight. */
  turnSessionId: string;
  shellTurnId: string;
  /** RUNNING, to be finalized and completed. */
  finalizeSessionId: string;
  /**
   * Of `machineSessionId`: a file it holds, an approval already allowed, a file request waiting on it. The file is also
   * cited by `evidenceRevisionId`, so its doors are asked about the one kind of file that reaches past a session.
   */
  sessionAttachmentId: string;
  /** Of `machineSessionId`: a `file_upload` in no bundle yet, which is what a bundle is made of. */
  uploadedFileId: string;
  /** The evidence revision of `evidenceTaskId`: what `file_list` can be asked about. */
  evidenceRevisionId: string;
  /** A task the machine is running, in `runningTaskSessionId`: the one task that session's uploads may name. */
  runningTaskId: string;
  runningTaskSessionId: string;
  allowedApprovalId: string;
  /** Of `machineSessionId`: an ended SubAgent run, which a delegate call's `resumeOf` names. */
  subagentRunId: string;
  workflowRunId: string;
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
  /**
   * The task both items are failures of: one of the project's own that nothing is attempting, so that
   * both stay owed (`openItemOwed`) and the escalation tick's backstop leaves them open. No case names
   * it; it is here so that the write trap counts it among A's ids.
   */
  failedTaskId: string;
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
  /** Wiki: a session in a workspace bound to the space. */
  wikiSessionId: string;
  /** The help center's Ask (migration 0850): a session of this machine's in no workspace, with `help_ask` set. */
  helpAskSessionId: string;
  /** A SECRET grant to this machine, awaiting delivery, for the machine session's PENDING request (migration 0506). */
  secretGrantId: string;
  /** A grant of this machine being removed: what `removed` confirms. */
  removingSecretGrantId: string;
  /** An import job of the space (server execution P5, contract `import.server`), ended, to be read back. */
  wikiImportJobId: string;
  /**
   * The drive door (docs/drive-technical-design.md §4.2): a staging of this machine's on the account's drive
   * file holding chunk 0 (`driveChunkSha256`, content of this account's alone); another staging with nothing in it, which
   * a commit names; a commit's id; and two files of the drive folder, one to move and one to delete.
   */
  driveStagingId: string;
  driveCommitStagingId: string;
  driveChunkSha256: string;
  driveCommitId: string;
  driveMoveFileId: string;
  driveDeleteFileId: string;
  /** An agent's directory sync this machine opened and is still reporting into (docs/drive-directory-sync-design.md S4). */
  driveSyncId: string;
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

/** Entries keyed `METHOD /runner/drive/…`, each held under /runner/drive and its /runner/documents alias (drive/drive-routes.ts). */
const underEveryDoorPrefix = <T>(entries: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(entries).flatMap(([key, value]) => underEveryRunnerDrivePrefix(key).map((route) => [route, value])));
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
  // One chunk of a running check's output (contract §2.2 J-T4's output route, §2.9 LS2): fenced on
  // the claim it names, so a machine that learned A's claim is still not A's. A's own chunk is taken.
  // Secret delivery (docs/design/owner-request-secrets.md §4.2, §8.1): every door reads the grant by (id, the
  // authenticated runner, its owner), so another machine's grant — of this account or another — is the 404 of an id
  // that names nothing. A's own fetch hands over the value, its ack delivers it, its `removed` confirms the removal.
  'POST /runner/secret-grants/:id/fetch': { as: RUNNER, request: (of) => ({ params: { id: of.runner.secretGrantId } }) },
  'POST /runner/secret-grants/:id/ack': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.secretGrantId }, body: { outcome: 'DELIVERED' } }),
  },
  'POST /runner/secret-grants/:id/removed': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.removingSecretGrantId }, body: { note: 'census' } }),
  },
  'POST /runner/integration-jobs/:jobId/output': {
    as: RUNNER,
    request: (of) => ({
      params: { jobId: of.runner.integrationJobId },
      body: {
        claimGeneration: '1',
        leaseOwner: of.runner.leaseOwner,
        check: { name: 'MERGE_CHECK', index: 1 },
        seq: 0,
        text: 'census\n',
      },
    }),
  },
  // The claim given back, named as the result below names it. A's own release puts the job back in
  // the queue, after which the result is A's claim that moved on: both reach the job.
  'POST /runner/integration-jobs/:jobId/release': {
    as: RUNNER,
    request: (of) => ({ params: { jobId: of.runner.integrationJobId }, body: { claimGeneration: '1', leaseOwner: of.runner.leaseOwner } }),
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
  // A release names the generation and the owner it releases (400 otherwise, before anything is read).
  'POST /runner/sessions/:id/release-leases': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId },
      body: { leaseOwner: of.runner.leaseOwner, leaseGeneration: of.runner.leaseGeneration },
    }),
  },
  'POST /runner/sessions/:id/orchestration-credential': { as: RUNNER, request: (of) => ({ params: { id: of.runner.callingSessionId } }) },
  'GET /runner/sessions/:id/inbox': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.inboxSessionId }, query: { leaseGeneration: of.runner.inboxLeaseGeneration } }),
  },
  'GET /runner/sessions/:id/attachments/:attId': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, attId: of.runner.sessionAttachmentId } }),
    nested: ['attId'],
  },
  'POST /runner/sessions/:id/attachments': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, file: { name: 'census.txt', type: 'text/plain', content: 'census' } }),
  },
  'POST /runner/sessions/:id/files': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, file: { name: 'census.txt', type: 'text/plain', content: 'census' } }),
  },
  'GET /runner/sessions/:id/files/:fileId': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, fileId: of.runner.sessionAttachmentId } }),
    nested: ['fileId'],
  },
  'PUT /runner/sessions/:id/files/:fileId/pin': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, fileId: of.runner.sessionAttachmentId } }),
    nested: ['fileId'],
  },
  'DELETE /runner/sessions/:id/files/:fileId/pin': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId, fileId: of.runner.sessionAttachmentId } }),
    nested: ['fileId'],
  },
  'POST /runner/sessions/:id/file-bundles': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId },
      body: { name: 'census', files: [{ path: 'census.txt', id: of.runner.uploadedFileId }] },
    }),
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
  'POST /runner/sessions/:id/subagents': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId },
      body: { toolUseId: 'toolu_census_delegate', type: 'general', definitionSource: 'builtin' },
    }),
  },
  'POST /runner/sessions/:id/workflows': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId },
      body: { toolUseId: 'toolu_census_workflow', name: 'review', script: 'return 1' },
    }),
  },
  'PATCH /runner/sessions/:id/workflows/:workflowRunId': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.machineSessionId, workflowRunId: of.runner.workflowRunId },
      body: { status: 'DONE' },
    }),
    nested: ['workflowRunId'],
  },
  // The machine's own alert about a job of the session's (its agents' is POST /runner/notify, below): another account's
  // runner is refused it as for an id that names nothing, while the owner's is answered by the push channel.
  'POST /runner/sessions/:id/notify': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { message: 'from the census' } }),
  },
  'POST /runner/sessions/:id/scheduled-wakeup': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { delaySeconds: 120, reason: 'the census' } }),
  },
  'POST /runner/sessions/:id/naming': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { replaces: 'not its title', title: 'named by the census' } }),
  },
  // A session not on a Cursor key: its own runner is answered `recorded: false`, and nothing is
  // written. This one names the account's OPEN LANDING session, which is what the route's own
  // owner-scoped guard is held to: another account's runner must be answered exactly as it is for
  // an id that names nothing (no 409 that would confirm the landing exists), while the owner's
  // runner is answered SESSION_IS_PLATFORM_DRIVEN.
  'POST /runner/sessions/:id/cursor-key-check': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.landingSessionId }, body: { state: 'INVALID', keyFingerprint: '0123456789abcdef' } }),
  },
  'POST /runner/sessions/:id/turns/:turnId/suggestion': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.turnSessionId, turnId: of.runner.shellTurnId } }),
    nested: ['turnId'],
  },
  'POST /runner/sessions/:id/turn-complete': {
    as: RUNNER,
    request: (of) => ({ params: { id: of.runner.turnSessionId }, body: { turnId: of.runner.shellTurnId, status: 'SUCCEEDED' } }),
  },
  'POST /runner/sessions/:id/events': { as: RUNNER, request: (of) => ({ params: { id: of.runner.machineSessionId }, body: { events: [] } }) },
  'POST /runner/sessions/:id/finalize': { as: RUNNER, request: (of) => ({ params: { id: of.runner.finalizeSessionId }, body: { status: 'CANCELLED' } }) },
  // The release report of session-release/v1, declared as a runner declares it.
  'POST /runner/sessions/:id/release': {
    as: RUNNER,
    request: (of) => ({
      params: { id: of.runner.finalizeSessionId },
      headers: { 'x-orbit-runner-capabilities': 'session-release/v1' },
      body: {},
    }),
  },
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
  // Moved to its own workspace, out of no folder: nothing changes, so no case loses what it asks for.
  'POST /runner/sessions/:id/move': { as: SESSION, request: (of) => ({ params: { id: of.sessionId }, body: { workspaceId: of.workspaceId } }) },
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
  // The agent's read of the line. The header names a session of the project — the caller's own
  // coordinator — so B's own request reaches the route; on A's project it is the project's 404 that
  // answers first, exactly as an id that names nothing does.
  'GET /runner/projects/:id/integration': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
    }),
  },
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
  // A three-character quote: the door refuses it 400 only after it has found the project under the
  // runner's owner and the header as its coordinator, so the caller's own request is answered by the route.
  'POST /runner/projects/:id/rulings': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { ruling: 'Recorded by the census.', quote: 'abc', sourceTurnId: mine.projectId },
    }),
  },
  'POST /runner/projects/:id/start-requests': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, why: 'the census' },
    }),
  },
  // Any session may ask (design D1): the caller's own session asks about A's project, which the door reads under the
  // runner's owner and answers 404 before anything is filed.
  'POST /runner/projects/:id/reopen-requests': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { why: 'the census', plannedWork: 'the census' },
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
  // The coordinator's abandon (J-T10). The acting session is the project's current coordinator, as
  // on the retry doors above; the machine's own job is RUNNING and inside its lease, so the owner's
  // own press reaches the gate and is answered "lease live" rather than an id that names nothing.
  'POST /runner/projects/:id/integration/jobs/:jobId/abandon': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId, jobId: of.runner.integrationJobId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
    nested: ['jobId'],
  },
  // The coordinator's "look again" (§10.8): the acting session is the project's current coordinator, as
  // on the doors above, and the owner's own machine has an observation queued.
  'POST /runner/projects/:id/promotions/request': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId }, headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
  },
  'POST /runner/projects/:id/integration/observe': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      body: { reason: 'the census' },
    }),
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
  // An engine CLI installed on a runner of the account at an orchestrating session's request, and its relay read back.
  'POST /runner/runners/:id/engine-install': { as: SESSION, request: (of) => ({ params: { id: of.runnerId }, body: { engine: 'claude' } }) },
  'GET /runner/runners/:id/engine-install': { as: SESSION, request: (of) => ({ params: { id: of.runnerId } }) },
  // The spares: a delete takes them away. Each owner's goes on the card its calling session holds for it.
  'DELETE /runner/runners/:id': { as: SESSION, request: (of) => ({ params: { id: of.spare.runnerId } }) },
  'DELETE /runner/workspaces/:id': { as: SESSION, request: (of) => ({ params: { id: of.spare.workspaceId } }) },
  'PATCH /runner/providers/:slug': { as: RUNNER, request: (of) => ({ params: { slug: of.runner.providerSlug }, body: { label: 'renamed by the census' } }) },
  'DELETE /runner/providers/:slug': { as: RUNNER, request: (of) => ({ params: { slug: of.runner.spareProviderSlug } }) },

  // ── the wiki: a session the space's workspace runs ──────────────────────────────────────────────
  'GET /runner/wiki/spaces/:id/verifications': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/verifications/request': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, headers: calling(mine.runner.wikiSessionId) }),
  },
  'POST /runner/wiki/spaces/:id/notes': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      headers: calling(mine.runner.wikiSessionId),
      body: { path: 'census.md', text: 'A census note.', readBy: 'server' },
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
  // ── the runner drive door (docs/drive-technical-design.md §4.2, §4.4) ───────────────
  // A chunk only by a sha256 the caller's own versions or stagings name; a staging only of the caller's runner; a commit
  // id only within the caller's account.
  // Under /runner/drive and its /runner/documents alias.
  ...underEveryDoorPrefix<RunnerCase>({
    'GET /runner/drive/chunks/:sha256': { as: RUNNER, request: (of) => ({ params: { sha256: of.runner.driveChunkSha256 } }) },
    'PUT /runner/drive/stagings/:id/chunks/:idx': { as: RUNNER, request: (of) => ({ params: { id: of.runner.driveStagingId, idx: '1' } }) },
    'GET /runner/drive/stagings/:id/chunks/:idx': { as: RUNNER, request: (of) => ({ params: { id: of.runner.driveStagingId, idx: '0' } }) },
    'POST /runner/drive/stagings/:id/keepalive': { as: RUNNER, request: (of) => ({ params: { id: of.runner.driveStagingId }, body: { dirty: false } }) },
    'GET /runner/drive/commits/:commitId': { as: RUNNER, request: (of) => ({ params: { commitId: of.runner.driveCommitId } }) },
    // A sync is reported into only by the runner that opened it, in the caller's account.
    'PATCH /runner/drive/syncs/:id': { as: RUNNER, request: (of) => ({ params: { id: of.runner.driveSyncId }, body: { status: 'UPLOADING', filesDone: 1 } }) },
  }),
};

/** Runner-gate routes the census cannot stand up, each with why and the reading that proves it. */
export const RUNNER_ISOLATION_BY_HAND: Readonly<Record<string, string>> = {
  // Revision 42 (§12.7): a task's own work session reading its task's landing. The census's runner fixture has no
  // landing subject with a work session of its task, so A's own request could not be answered by the route here.
  'GET /runner/landings/:id':
    "the calling session is read by (id, the runner's owner, this runner, a work session of a task) and the landing by "
    + "(session id, the runner's owner, that task, its project) (sessions/sessions.service.ts:3454, 3463); anything else is "
    + "404 LANDING_NOT_THIS_SESSIONS_TASK and nothing is written; landing-fix-reads.pg.spec.ts case 5 sends its own landing, "
    + "another task's, another session's id, another runner and a session of no task",
  'GET /runner/help-ask/:read':
    ':read names one of four account reads, never an object; the reads answer only an Ask session found by (the session header, the runner\'s owner, this runner) and read only that owner\'s rows (help/help-ask-reads.ts:224); help-ask.pg.spec.ts 6 sends them from another machine and another account',
  // ── scheduled tasks: a session's schedule_* tools (runner-api/runner-schedules.controller.ts) ─────────
  'GET /runner/schedules/:id':
    "read by (id, the runner's owner) and nothing else, 404 for another account's id (schedules/schedule-reads.service.ts:98)",
  'PATCH /runner/schedules/:id':
    "the schedule is read FOR UPDATE by (id, the runner's owner) and nothing else, so another account's id answers 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedules.service.ts:889)",
  'POST /runner/schedules/:id/pause':
    "the schedule is read FOR UPDATE by (id, the runner's owner) and nothing else, so another account's id answers 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedules.service.ts:889)",
  'POST /runner/schedules/:id/resume':
    "the schedule is read FOR UPDATE by (id, the runner's owner) and nothing else, so another account's id answers 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedules.service.ts:889)",
  'POST /runner/schedules/:id/end':
    "the schedule is read FOR UPDATE by (id, the runner's owner) and nothing else, so another account's id answers 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedules.service.ts:889)",
  'DELETE /runner/schedules/:id':
    "the schedule is read FOR UPDATE by (id, the runner's owner) and nothing else, so another account's id answers 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedules.service.ts:889)",
  'POST /runner/schedules/:id/run':
    "the schedule is locked only when its owner is the runner's owner, else 404 SCHEDULE_NOT_FOUND before anything is written (schedules/schedule-runs.service.ts:888)",
  'GET /runner/conditions/:id':
    "read by (id, the runner's owner) and nothing else, 404 CONDITION_NOT_FOUND for another account's id (conditions/conditions.service.ts:445)",
  'POST /runner/schedule-runs/:id/stop':
    "the run's schedule is locked only when its owner is the runner's owner, else 404 SCHEDULE_RUN_NOT_FOUND before anything is written (schedules/schedule-runs.service.ts:717, :888)",
  'POST /runner/main-checkout/:id/snapshot':
    'the read is found by (id, the calling runner) only, so another machine\'s id answers 404 and nothing is stored (workspaces/main-checkout.service.ts:330); main-checkout.pg.spec.ts "the read goes through the runner" sends it from another runner',
  'POST /runner/main-checkout/:id/result':
    'the action is found by (id, the calling runner) only, 404 for another machine\'s, and every write after is keyed by that row (workspaces/main-checkout.service.ts:347)',
  // ── criteria met by confirmation (0545) ────────────────────────────────────────────────────────
  'POST /runner/projects/:id/criteria/:criterionId/confirmations': 'the criterion is read by (id, the project, the runner\'s owner as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244), and the acting session must be that project\'s coordinator (403 otherwise)',
  'POST /runner/projects/:id/criteria/:criterionId/confirmations/withdraw': 'the criterion is read by (id, the project, the runner\'s owner as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244), and the acting session must be that project\'s coordinator (403 otherwise)',
  'POST /runner/projects/:id/criteria/:criterionId/checks': 'the criterion is read by (id, the project, the runner\'s owner as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244), and the acting session must be that project\'s coordinator (403 otherwise)',
  'GET /runner/owner-requests/:id':
    'read by (id, the runner\'s owner) and nothing else, so another account\'s id answers 404 (owner-requests/owner-requests.service.ts:193); owner-requests.pg.spec.ts (f) sends it',
  'POST /runner/owner-requests/:id/withdraw':
    'the calling session must be one this runner hosts for its owner (runner-api/runner-owner-requests.controller.ts:100), the request is read by (id, that owner) (owner-requests/owner-requests.service.ts:193), and only the session that filed it may withdraw it (owner-requests/owner-requests.service.ts:233)',
  'PATCH /runner/sessions/:id/subagents/:runId':
    'the session must be one of the runner\'s owner that this runner hosts, else 404 as for an id that names nothing '
    + '(runner-api/runner-subagents.controller.ts:137), and the run is matched by (id, that session) only, on an end '
    + '(runner-api/runner-subagents.controller.ts:398) and on a RUNNING report owing a wake (recordWakeOwed, '
    + 'runner-api/runner-subagents.controller.ts:114); subagent-run.pg.spec.ts sends another account\'s session and run',
  'POST /runner/sessions/:id/subagents/:runId/fallback':
    'the session must be one of the runner\'s owner that this runner hosts, else 404 as for an id that names nothing '
    + '(runner-api/runner-subagents.controller.ts:137), and the run is matched by (id, that session) only '
    + '(runner-api/runner-subagents.controller.ts:303); subagent-fallback.pg.spec.ts sends another account\'s session and run',
  'POST /runner/sessions/:id/subagents/:runId/rating':
    'the session must be one of the runner\'s owner that this runner hosts, else 404 as for an id that names nothing '
    + '(runner-api/runner-subagents.controller.ts:213), and the run is matched by (id, that session) only, '
    + 'on the read and on the write (runner-api/subagent-rating.ts:52, runner-api/subagent-rating.ts:60); subagent-rating.pg.spec.ts sends '
    + 'another session of the same runner and another account\'s runner, and finds the rating unchanged',
  'POST /runner/subagent-runs/:runId/claim':
    'the run is read by id and refused 404 unless it is a remote run of the runner\'s own account, 403 '
    + 'SUBAGENT_RUN_NOT_TARGET unless this runner is its target_runner_id (runner-api/subagent-remote.ts:403); '
    + 'subagent-remote.pg.spec.ts sends another runner of the account',
  'POST /runner/subagent-runs/:runId/events':
    'the same check as the claim (runner-api/subagent-remote.ts:403) before anything is written; subagent-remote.pg.spec.ts '
    + 'sends the parent\'s runner, another runner of the account and another account\'s runner, and finds no event stored',
  'PATCH /runner/subagent-runs/:runId':
    'the same check as the claim (runner-api/subagent-remote.ts:403), then the end is written by (id, the run\'s own session); '
    + 'subagent-remote.pg.spec.ts sends another runner of the account',
  'GET /runner/sessions/:id/subagents/:runId/events':
    'the session must be one of the runner\'s owner that this runner hosts, else 404 (runner-api/runner-subagents.controller.ts:153), and the '
    + 'run is matched by (id, that session) only (runner-api/runner-subagents.controller.ts readRelayedSubagentEvents)',
  'POST /runner/sessions/:id/subagents/:runId/stop':
    'the session must be one of the runner\'s owner that this runner hosts, else 404 (runner-api/runner-subagents.controller.ts:153), and the '
    + 'run is matched by (id, that session) only (runner-api/runner-subagents.controller.ts stopRemoteSubagentRun)',
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
  // SR55: a fork of A's session, asked from B's own calling session on B's own runner. A fork is only ever of the
  // session making the call (tasks/task-fork.ts), so A's session is answered as an id that names nothing is.
  [`${route} body ${where}fork.sessionId`]: {
    as: RUNNER,
    request: (of: RunnerTenant, mine: RunnerTenant) => ({
      params: {},
      headers: calling(mine.runner.callingSessionId),
      body: wrap(taskBody({
        fork: { sessionId: of.runner.callingSessionId, sha: '5'.repeat(40), baseHead: '4'.repeat(40), includesUncommitted: true },
      })),
    }),
  },
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
  'POST /runner/sessions/import': (mine) => ({
    params: {},
    body: { claudeSessionId: '00000000-0000-4000-8000-0000000c1a0f', workspaceId: mine.workspaceId },
  }),
  'GET /runner/sessions': () => ({ params: {} }),
  'GET /runner/sessions/search': () => ({ params: {}, query: { q: 'census' } }),
  'GET /runner/sessions/:id': (mine) => ({ params: { id: mine.sessionId } }),
  'POST /runner/sessions/:id/turns': (mine) => ({ params: { id: mine.sessionId }, body: { message: 'from the census' } }),
  'POST /runner/session-requests/:id/reply': (mine) => ({ params: { id: mine.runner.replyRequestId }, body: { message: 'answered by the census' } }),
  'POST /runner/sessions/:id/interrupt': (mine) => ({ params: { id: mine.runner.interruptSessionId }, body: {} }),
  'POST /runner/sessions/:id/merge': (mine) => ({ params: { id: mine.sessionId }, body: {} }),
  'POST /runner/sessions/:id/end': (mine) => ({ params: { id: mine.runner.endSessionId } }),
  'POST /runner/sessions/:id/complete-session': (mine) => ({ params: { id: mine.runner.completedSessionId } }),
  'POST /runner/sessions/:id/move': (mine) => ({ params: { id: mine.sessionId }, body: { workspaceId: mine.workspaceId } }),
  'DELETE /runner/sessions/:id': (mine) => ({ params: { id: mine.runner.deletedSessionId } }),
  'POST /runner/sessions/:id/archive': (mine) => ({ params: { id: mine.runner.archivedSessionId } }),
  'GET /runner/workspaces': () => ({ params: {} }),
  'GET /runner/agents': () => ({ params: {} }),
  'POST /runner/workspaces': () => ({ params: {}, body: { name: 'census workspace' } }),
  'POST /runner/agents': () => ({ params: {}, body: { name: 'census agent' } }),
  'PATCH /runner/workspaces/:id': (mine) => ({ params: { id: mine.workspaceId }, body: { description: 'renamed by the census' } }),
  'PATCH /runner/agents/:id': (mine) => ({ params: { id: mine.workspaceId }, body: { description: 'renamed by the census' } }),
  'GET /runner/runners': () => ({ params: {} }),
  'POST /runner/runners/:id/engine-install': (mine) => ({ params: { id: mine.runnerId }, body: { engine: 'claude' } }),
  'GET /runner/runners/:id/engine-install': (mine) => ({ params: { id: mine.runnerId } }),
  'DELETE /runner/runners/:id': (mine) => ({ params: { id: mine.spare.runnerId } }),
  'DELETE /runner/workspaces/:id': (mine) => ({ params: { id: mine.spare.workspaceId } }),
  'POST /runner/projects/:id/coordinator/ensure': (mine) => ({ params: { id: mine.projectId } }),
  'POST /runner/projects/:id/coordinator/messages': (mine) => ({ params: { id: mine.projectId }, body: { message: 'from the census' } }),
};

/** The coordinator's doors of a project, as a field case of the coordinator's header. */
const coordinatorRequests: Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> = {
  'POST /runner/projects/:id/owner-questions': (mine) => ({ params: { id: mine.projectId }, body: { question: 'Which first?' } }),
  'POST /runner/projects/:id/rulings': (mine) => ({
    params: { id: mine.projectId },
    body: { ruling: 'Recorded by the census.', quote: 'abc', sourceTurnId: mine.projectId },
  }),
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
  'POST /runner/projects/:id/integration/jobs/:jobId/abandon': (mine) => ({
    params: { id: mine.projectId, jobId: mine.runner.integrationJobId },
    body: { reason: 'the census' },
  }),
  'POST /runner/projects/:id/promotions/request': (mine) => ({
    params: { id: mine.projectId }, body: { reason: 'the census' },
  }),
  'POST /runner/projects/:id/integration/observe': (mine) => ({
    params: { id: mine.projectId },
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
const wikiRequests = (): Readonly<Record<string, (mine: RunnerTenant) => TenantRequest>> =>
  Object.fromEntries(Object.entries(RUNNER_ISOLATION_CASES)
    .filter(([route]) => route.startsWith('GET /runner/wiki') || route.startsWith('POST /runner/wiki'))
    .filter(([, kase]) => kase.request(SPELLED_MINE, SPELLED_MINE).headers?.['x-orbit-session-id'] === 'mine.runner.wikiSessionId')
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
  // What a runner states is executing in a session is written only to a session assigned to it and leased to its process
  // (runners/runner-executing-sets.ts): another account's session under that id matches no row and is left as it is.
  'POST /runner/heartbeat body executing[].sessionId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ executing: [{ sessionId: of.runner.machineSessionId, jobs: [], shells: [], subagents: [], engineTurnActive: false }] }) }),
  },
  'POST /runner/heartbeat body expiredCommitErrors[].sessionId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ expiredCommitErrors: [{ sessionId: of.runner.machineSessionId, operationId: LEASE }] }) }),
  },
  'POST /runner/heartbeat body agentDirProbes[].agentId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ agentDirProbes: [{ agentId: of.workspaceId, exists: true, isGitRepo: false }] }) }),
  },
  // A clone report about A's workspace from B's runner moves nothing (github/github-workspace.service.ts applyCloneReports).
  'POST /runner/heartbeat body cloneReports[].workspaceId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: heartbeat({ cloneReports: [{ workspaceId: of.workspaceId, state: 'FAILED', error: 'census' }] }) }),
  },
  // A GitHub workspace's token (docs/github-workspace-design.md §5.4): only for a workspace on the calling runner. The
  // owner's own workspace is not from GitHub, which is 409; B naming A's is the 404 of an id that names nothing.
  'POST /runner/git-credential body workspaceId': {
    as: RUNNER,
    request: (of) => ({ params: {}, body: { workspaceId: of.workspaceId, host: 'github.com', path: 'census/none' } }),
  },
  // A delegate call resuming A's ended SubAgent run, from B's own session: looked up only among that session's runs.
  'POST /runner/sessions/:id/subagents body resumeOf': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { toolUseId: 'toolu_census_resume', type: 'general', definitionSource: 'builtin', resumeOf: of.runner.subagentRunId },
    }),
  },
  'POST /runner/sessions/:id/subagents body workflowRunId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: {
        toolUseId: 'toolu_census_workflow_call', type: 'general', definitionSource: 'builtin',
        workflowRunId: of.runner.workflowRunId, callIndex: 0,
      },
    }),
  },
  // What the link gateway's Welcome says of a process's sessions: B's own process, asking after A's leased session.
  'POST /runner/link/welcome body sessionIds[]': {
    as: RUNNER,
    request: (of, mine) => ({ params: {}, body: { leaseOwner: mine.runner.leaseOwner, sessionIds: [of.runner.activateSessionId] } }),
  },
  // A refused account removal of B's own runner, naming A's session as one using the account. Only sessions assigned to
  // the reporting runner are kept on its row (runner-api.controller.ts applyAccountRemoveResult), and the page reads
  // back only the viewer's on that runner (runners.service.ts accountRemoveSessionsOf): A's is answered and stored as
  // an id that names nothing.
  'POST /runner/account-remove-result body sessionIds[]': {
    as: RUNNER,
    request: (of) => ({
      params: {},
      body: { engine: 'codex', status: 'failed', message: 'in use', sessionIds: [of.runner.machineSessionId] },
    }),
  },
  'POST /runner/codex-account-remove-result body sessionIds[]': {
    as: RUNNER,
    request: (of) => ({
      params: {},
      body: { engine: 'codex', status: 'failed', message: 'in use', sessionIds: [of.runner.machineSessionId] },
    }),
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
  // The batch takeover: B's own process, taking A's session over among its own.
  'POST /runner/sessions/takeover-leases body sessions[].sessionId': {
    as: RUNNER,
    request: (of, mine) => ({ params: {}, body: { leaseOwner: mine.runner.leaseOwner, sessions: [{ sessionId: of.runner.takeoverSessionId }] } }),
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
  // The inventory a machine reports about its own checkouts. Another account's session named in it is
  // dropped before anything is stored: the machine is told about that session as it is about one that
  // names nothing, and no row of A's is written.
  'POST /runner/abandoned-checkouts body checkouts[].sessionId': {
    as: RUNNER,
    request: (of) => ({
      params: {},
      body: { checkouts: [{ sessionId: of.runner.machineSessionId, files: [], patches: [] }] },
    }),
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
    as: ['runner', 'service', 'session'],
    request: (of) => ({ params: {}, body: { claudeSessionId: '00000000-0000-4000-8000-0000000c1a0f', workspaceId: of.workspaceId } }),
  },
  // A transcript another account already imported — its engine session id, which a stranger may know.
  // Titled, so that what the two imports are answered with is not told apart by a title spelled from the id.
  'POST /runner/sessions/import body claudeSessionId': {
    as: ['runner', 'service', 'session'],
    request: (of, mine) => ({
      params: {},
      body: { claudeSessionId: of.runner.runtimeSessionId, workspaceId: mine.workspaceId, title: 'imported by the census' },
    }),
  },
  'GET /runner/sessions query parentSessionId': {
    as: ['runner', 'service', 'session'],
    request: (of) => ({ params: {}, query: { parentSessionId: of.sessionId } }),
  },
  // `file_list`: what the owner has under one task, one session or one evidence version. An id of another account's
  // is refused as one that names nothing, not answered as an empty list of it.
  'GET /runner/files query taskId': { as: RUNNER, request: (of) => ({ params: {}, query: { taskId: of.taskId } }) },
  'GET /runner/files query sessionId': { as: RUNNER, request: (of) => ({ params: {}, query: { sessionId: of.sessionId } }) },
  'GET /runner/files query evidenceId': { as: RUNNER, request: (of) => ({ params: {}, query: { evidenceId: of.runner.evidenceRevisionId } }) },
  // The only task an upload may name is the one its session is running: anyone else's is the same refusal as nothing.
  'POST /runner/sessions/:id/files body taskId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.runningTaskSessionId },
      file: { name: 'census.txt', type: 'text/plain', content: 'census' },
      fields: { taskId: of.runner.runningTaskId },
    }),
  },
  // A file of another account's is refused as a file that is not there, whatever session names it.
  'POST /runner/sessions/:id/file-bundles body files[].id': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.runner.machineSessionId },
      body: { name: 'census', files: [{ path: 'census.txt', id: of.runner.uploadedFileId }] },
    }),
  },
  // A message's key, as the platform's own keys spell an object of the account's in it: the key of the
  // turn that hands an open item to its coordinator is `open-item:v1:<item id>:<generation>`.
  'POST /runner/sessions/:id/turns body clientTurnId': {
    as: ['runner', 'service', 'session'],
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { message: 'from the census', clientTurnId: openItemTurnKey(of) } }),
  },
  'POST /runner/sessions/:id/move body workspaceId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { workspaceId: of.workspaceId } }),
  },
  'POST /runner/sessions/:id/move body folderId': {
    as: SESSION,
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { folderId: of.folderId } }),
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
  'POST /runner/tasks/batch-pin header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: {}, body: { taskIds: [mine.taskId], model: 'census' } })),
  'PATCH /runner/tasks/:id body assigneeId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { assigneeId: of.workspaceId } }) },
  'PATCH /runner/tasks/:id body listId': { as: RUNNER, request: (of, mine) => ({ params: { id: mine.taskId }, body: { listId: of.listId } }) },
  // Asked BEFORE the move below files the task into a project. A request carrying a session edits
  // work under that session's project scope (tasks/tasks-service.ts update), and a session on this
  // machine holds none: once the task belongs to a project, this same rename is refused
  // PROJECT_SCOPE_MISMATCH instead of answered by the route, which says nothing about tenancy —
  // the property this census is about. The move is the one case here that changes which scope a
  // later case is written under, so it runs last among the task's own edits.
  'PATCH /runner/tasks/:id header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.taskId }, body: { title: 'renamed by the census' } })),
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
  'POST /runner/tasks/:id/execute header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({ params: { id: mine.taskId }, body: {} })),
  'POST /runner/tasks/:id/dependencies body dependsOnTaskId': {
    as: RUNNER,
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { dependsOnTaskId: of.dependencyTaskId } }),
  },
  'POST /runner/tasks/:id/dependencies header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({
    params: { id: mine.taskId }, body: { dependsOnTaskId: mine.dependencyTaskId },
  })),
  // An edge that is not there: the answer is the task, and this one has no comment to name its tenant.
  'DELETE /runner/tasks/:id/dependencies/:dependsOnTaskId header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({
    params: { id: mine.dependencyTaskId, dependsOnTaskId: mine.taskId },
  })),
  'POST /runner/tasks/:id/progress header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({
    params: { id: mine.taskId }, body: { phase: 'census' },
  })),
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
  'POST /runner/task-lists/:id/dag-apply header x-orbit-session-id': fromTheirSession(RUNNER, (mine) => ({
    params: { id: mine.listId }, body: { ops: [{ op: 'add', taskId: mine.runner.listTaskId, dependsOnTaskId: mine.dependencyTaskId }] },
  })),
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
  // The job the read pages by: B reads its own project's line with A's job id in the query, and is
  // answered as if it named nothing — the candidate is resolved within the project and nowhere else.
  'GET /runner/projects/:id/integration query jobId': {
    as: RUNNER,
    request: (of, mine) => ({
      params: { id: mine.projectId },
      headers: calling(mine.runner.coordinatorSessionId),
      query: { jobId: of.runner.integrationJobId },
    }),
  },
  // The acting session itself: B reads its own project with A's coordinator in the header, and is
  // answered as with a session that names nothing.
  'GET /runner/projects/:id/integration header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { id: mine.projectId } }),
    (of) => of.runner.coordinatorSessionId,
  ),
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
  // The four help reads answer an Ask session of the runner's own (help/help-ask-reads.ts): another account's Ask in the
  // header is the 404 of an Ask that is not there.
  'GET /runner/help-ask/:read header x-orbit-session-id': fromTheirSession(
    RUNNER,
    (mine) => ({ params: { read: 'machines' }, headers: calling(mine.runner.helpAskSessionId) }),
    (of) => of.runner.helpAskSessionId,
  ),
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
  // A note about another account's entry: kept as the caller's own, and the entry answered as one that does not exist.
  'POST /runner/wiki/notes body corrects': {
    as: RUNNER,
    request: (of, mine) => ({
      params: {},
      headers: calling(mine.runner.wikiSessionId),
      body: { text: 'The census says this entry is wrong.', corrects: of.wikiEntryId },
    }),
  },
  'POST /runner/wiki/notes header x-orbit-session-id': fromTheirSession(
    RUNNER,
    () => ({ params: {}, body: { text: 'The census notes this.' } }),
    (of) => of.runner.wikiSessionId,
  ),
  // A wiki chat's rewrite card (contract `agentSurface.chat.draft`): drafted as another account's chat, refused as a
  // session this runner does not host; drafted in the caller's own chat, a card of its own.
  'POST /runner/wiki/drafts header x-orbit-session-id': fromTheirSession(
    RUNNER,
    () => ({
      params: {},
      body: { kind: 'rewrite', sections: [{ doc: 'census', section: 'census' }], reason: 'The census section lags behind main.', idempotencyKey: 'census-draft' },
    }),
    (of) => of.wikiChatId,
  ),
  // A wiki chat's read (contract `chat.read`): read as another account's chat, refused as a session this runner does not host.
  'GET /runner/wiki/read header x-orbit-session-id': fromTheirSession(RUNNER, () => ({ params: {} }), (of) => of.wikiChatId),
  // Another account's card is no card of this chat to replace: answered WIKI_SCHEMA at replaces, as one that names nothing.
  'POST /runner/wiki/drafts body replaces': {
    as: RUNNER,
    request: (of, mine) => ({
      params: {},
      headers: calling(mine.wikiChatId),
      body: {
        kind: 'rewrite',
        sections: [{ doc: 'census', section: 'census' }],
        reason: 'The census section lags behind main.',
        replaces: of.wikiChatDraftId,
        idempotencyKey: 'census-draft-replaces',
      },
    }),
  },
  // ── the runner drive door: an entry, a version or a staging of another account's is one that is not there ──
  ...underEveryDoorPrefix<RunnerFieldCase>({
    'GET /runner/drive/stat query id': { as: RUNNER, request: (of) => ({ params: {}, query: { id: of.driveFileId } }) },
    'GET /runner/drive/list query id': { as: RUNNER, request: (of) => ({ params: {}, query: { id: of.driveFolderId } }) },
    'GET /runner/drive/manifest query id': { as: RUNNER, request: (of) => ({ params: {}, query: { id: of.driveFileId } }) },
    'POST /runner/drive/stagings body entryId': { as: RUNNER, request: (of) => ({ params: {}, body: { entryId: of.driveFileId } }) },
    'POST /runner/drive/commit body entryId': {
      as: RUNNER,
      request: (of) => ({ params: {}, body: { commitId: 'census-commit-entry', entryId: of.driveFileId, mode: 'OVERWRITE', chunks: [] } }),
    },
    // An append built on another account's version, onto the caller's own file: a base that is not there.
    'POST /runner/drive/commit body baseVersionId': {
      as: RUNNER,
      request: (of, mine) => ({
        params: {},
        body: { commitId: 'census-commit-base', entryId: mine.driveFileId, mode: 'APPEND', baseVersionId: of.driveVersionId, chunks: [] },
      }),
    },
    'POST /runner/drive/commit body stagingId': {
      as: RUNNER,
      request: (of, mine) => ({
        params: {},
        body: { commitId: 'census-commit-staging', entryId: mine.driveFileId, mode: 'OVERWRITE', chunks: [], stagingId: of.runner.driveCommitStagingId },
      }),
    },
    'POST /runner/drive/rename body id': {
      as: RUNNER,
      request: (of) => ({ params: {}, body: { id: of.runner.driveMoveFileId, to: '/census moved by the runner.txt' } }),
    },
    'POST /runner/drive/utimens body id': {
      as: RUNNER,
      request: (of) => ({ params: {}, body: { id: of.driveFileId, mtime: '2020-01-02T03:04:05.000Z' } }),
    },
  }),
  // A's own request deletes its file, so this is held under /runner/drive alone; its /runner/documents alias is read by
  // hand (RUNNER_ISOLATION_FIELDS_BY_HAND).
  'POST /runner/drive/delete body id': { as: RUNNER, request: (of) => ({ params: {}, body: { id: of.runner.driveDeleteFileId } }) },
  ...Object.fromEntries(Object.entries(wikiRequests()).map(([route, own]) => [
    `${route} header x-orbit-session-id`,
    fromTheirSession(RUNNER, own, (of) => of.runner.wikiSessionId),
  ])),
};

/**
 * The plan-usage snapshot a heartbeat reports, wherever it nests: provider-side names of rate-limit
 * buckets, credits and reset grants, kept on the reporting machine's own row and read back only through it.
 */
const PLAN_USAGE_IDS = ['limitId', 'rateLimits[].limitId', 'rateLimitReset.rateLimitResetCredits.credits[].id', 'buckets[].id', 'resetGrants.grants[].id'];
const planUsageReadings = Object.fromEntries(
  ['planUsage.', 'planUsage.claude.', 'planUsage.codex.', 'planUsage.kimi.', 'planUsage.cursor.', 'planUsage.antigravity.', 'engines[].planUsage.']
    .flatMap((at) => PLAN_USAGE_IDS.map((id) => [
      `POST /runner/heartbeat body ${at}${id}`,
      'a provider\'s own name for one of its rate-limit buckets, credits or reset grants, not an Orbit row: stored as the reporting '
        + 'machine\'s own plan usage and read back only through that machine (runner-api.controller.ts:2167)',
    ])),
);

/** Ids a runner-gate request carries that name nothing of an account's to reach, with why and where. */
export const RUNNER_ISOLATION_FIELDS_BY_HAND: Readonly<Record<string, string>> = {
  // ── Push as me's credential door (docs/design/protected-branch-landing.md §5.2) ───────────────────────────
  'POST /runner/git-credential body jobId':
    "read only by (id, the runner's owner) and only when its source session's workspace is the named one, which is first "
    + "read by (id, the calling runner, its owner, not deleted) (github/push-as-me.service.ts:67, :113); another account's "
    + "job answers 403 PUSH_AS_ME_REFUSED, as an id that names nothing does, and nothing is written. pull-request-landing.pg.spec.ts "
    + 'case 11 sends it for another runner, lease and generation',
  'POST /runner/git-credential body sessionId':
    "read only by (id, the runner's owner) and only when it is a session of the named workspace on the calling runner "
    + "(github/push-as-me.service.ts:67, :136); another account's session answers 403 PUSH_AS_ME_REFUSED, as an id that names "
    + 'nothing does, and nothing is written. pull-request-landing.pg.spec.ts case 13 sends it with another operation',
  'POST /runner/git-credential body mergeOperationId':
    "compared with the merge operation of a session already found as the runner owner's own (github/push-as-me.service.ts:136); "
    + "it names nothing of its own, and one that is not that session's current operation answers 403 PUSH_AS_ME_REFUSED",
  'GET /runner/landings/:id header x-orbit-session-id':
    "the calling session is taken only as a work session of the runner's owner on this runner (sessions/sessions.service.ts:3454), "
    + 'so another account\'s session there finds nothing and the read answers 404 LANDING_NOT_THIS_SESSIONS_TASK, writing nothing; '
    + 'landing-fix-reads.pg.spec.ts case 5 sends it from another runner and as a session of no task',
  // ── the managed runner browser (docs/runner-browser-design.md §5) ─────────────────────────────────────
  'POST /runner/heartbeat body browser.holderSessionId':
    "the runner's own word about which of its sessions holds its browser, stored as text in the calling runner's own "
    + 'runner.browser_state (runner-api/runner-api.controller.ts:2285) and shown only to that runner\'s owner (managed-runners/browser-state.ts:122); no session is '
    + 'read, written or authorized by it, so another account\'s session id there names nothing of anybody\'s',
  // ── conditions (docs/condition-triggers-design.md §4.2) ──────────────────────────────────────────
  'POST /runner/heartbeat body conditionSamples[].conditionId':
    "taken only for a condition of the runner's owner whose workspace the calling runner serves, read in one statement "
    + 'before anything is written (conditions/conditions.service.ts:264) and again under the row lock; any other is '
    + 'refused and stored nowhere. conditions.pg.spec.ts heartbeat-refuses-foreign sends it from a machine of the same '
    + "owner and from another account's",
  // ── scheduled tasks ──────────────────────────────────────────────────────────────────────────────
  'POST /runner/schedules header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'PATCH /runner/schedules/:id header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedules/:id/pause header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedules/:id/resume header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedules/:id/run header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedules/:id/end header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'DELETE /runner/schedules/:id header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedule-runs/:id/stop header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'POST /runner/schedule-runs/report header x-orbit-session-id':
    "must be a session of the runner's owner that this runner hosts, else 403 before anything is read (runner-api/runner-schedules.controller.ts:174)",
  'PATCH /runner/schedules/:id body workspaceId':
    "read by (id, the runner's owner, not deleted) before anything is written; another account's workspace answers 404 WORKSPACE_NOT_FOUND (schedules/schedules.service.ts:899)",
  'POST /runner/main-checkout/:id/result body requestId':
    'never looked up: compared with the requestId of the row the calling runner\'s own id named, and refused 400 when it differs (workspaces/main-checkout.service.ts:745)',
  'POST /runner/main-checkout/:id/result body targetSessionId':
    'never looked up nor written anywhere it names: kept on the result as the runner reported it, and read only to title the line, by id, in the row\'s own initiating session\'s transaction (workspaces/main-checkout.service.ts:483)',
  // ── criteria met by confirmation (0545) ────────────────────────────────────────────────────────
  'POST /runner/projects/:id/criteria/:criterionId/confirmations header x-orbit-session-id': 'compared with the coordinator pointer of a project read by (id, the runner\'s owner): a session of another account is never that pointer, so it is refused 403 (projects/project-criterion-confirmation.service.ts:259)',
  'POST /runner/projects/:id/criteria/:criterionId/confirmations/withdraw header x-orbit-session-id': 'compared with the coordinator pointer of a project read by (id, the runner\'s owner): a session of another account is never that pointer, so it is refused 403 (projects/project-criterion-confirmation.service.ts:259)',
  'POST /runner/projects/:id/criteria/:criterionId/checks header x-orbit-session-id': 'compared with the coordinator pointer of a project read by (id, the runner\'s owner): a session of another account is never that pointer, so it is refused 403 (projects/project-criterion-confirmation.service.ts:259)',
  'POST /runner/projects/:id/criteria/:criterionId/confirmations body attachmentIds[]':
    'counted among the runner owner\'s own uploads before anything is written; one that is not answers 404 (projects/project-criterion-confirmation.service.ts:281)',
  'POST /runner/projects/:id/criteria/:criterionId/checks body workspaceId':
    'handed to TasksService.create as the check task\'s assignee, which reads the workspace by (id, the runner\'s owner) and refuses another account\'s 403 (tasks/tasks.service.ts:2606)',
  'POST /runner/criterion-checks/report header x-orbit-session-id':
    'the session is read by (id, the runner\'s owner), and the attempt it settles by (its task, that owner); another account\'s session finds nothing and answers 404 (projects/project-criterion-confirmation.service.ts:197)',
  'POST /runner/criterion-checks/report body attachmentIds[]':
    'counted among the runner owner\'s own uploads before anything is written; one that is not answers 404 (projects/project-criterion-confirmation.service.ts:281)',
  // ── terminal sign-in (0660) ───────────────────────────────────────────────────────────────────────
  'POST /runner/terminal-login/start header x-orbit-session-id':
    'never looked up: any non-blank value refuses the request 403 before anything is read or written (terminals/runner-terminal-login.controller.ts:41), since a terminal signs in as a person, not on behalf of a session; terminal-credential.pg.spec.ts (a) sends one',
  'POST /runner/terminal-login/poll header x-orbit-session-id':
    'never looked up: any non-blank value refuses the request 403 before anything is read (terminals/runner-terminal-login.controller.ts:41)',
  // ── owner requests (0503) ─────────────────────────────────────────────────────────────────────────
  'POST /runner/owner-requests body blocksTaskIds[]':
    'counted among the runner owner\'s own tasks before anything is written; one that is not answers 404 (owner-requests/owner-requests.service.ts:128); owner-requests.pg.spec.ts (f) sends another account\'s',
  'POST /runner/owner-requests body secretSpec.runnerId':
    'never used: the runner is the asking session\'s own (design §4.1), and any other one is refused 400 before anything is written (owner-requests/owner-secrets.service.ts:187); owner-requests.pg.spec.ts (c) sends another account\'s',
  'POST /runner/owner-requests body clientRequestId':
    'the caller\'s own idempotency key, unique per asking session, and read back only by (the runner\'s owner, the asking session, the key) (owner-requests/owner-requests.service.ts:169); it names nothing of anybody else\'s',
  'POST /runner/owner-requests body projectId':
    'counted among the runner owner\'s own projects before anything is written; one that is not answers 404 (owner-requests/owner-requests.service.ts:132); owner-requests.pg.spec.ts (f) sends another account\'s',
  'POST /runner/owner-requests header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-owner-requests.controller.ts:100); owner-requests.pg.spec.ts (f) sends another account\'s',
  'POST /runner/projects/:id/reopen-requests header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 before the project is read or anything is written (owner-requests/owner-requests.service.ts:719); the project is then read under that owner only, 404 for another account\'s (owner-requests/owner-requests.service.ts:586), and the card is filed under that owner',
  'POST /runner/settings-proposals header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 before anything is read or written (runner-api/runner-owner-requests.controller.ts:100); the proposal acts on that owner\'s own preferences only, and settings-proposals.pg.spec.ts (t) sends another account\'s session',
  'GET /runner/settings header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 before anything is read (runner-api/runner-owner-requests.controller.ts:100); the answer is that owner\'s own preferences, read by the runner\'s owner, never by the header, and settings-cli.pg.spec.ts sends another account\'s session',
  'POST /runner/owner-requests/:id/withdraw header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-owner-requests.controller.ts:100), and must be the session that filed the request (owner-requests/owner-requests.service.ts:233)',
  // ── the Orbit Cloud browser's agent tools ─────────────────────────────────────────────────────────
  'POST /runner/browser/sign-in-requests body clientRequestId':
    'the caller\'s own idempotency key, unique per asking session, and read back only by (the runner\'s owner, the asking session, the key) (owner-requests/owner-requests.service.ts:505, read at :309); it names nothing of anybody else\'s',
  'GET /runner/browser header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-browser.controller.ts:138), '
    + 'and what is read is that owner\'s own managed runner, found by the owner (managed-runners/browser-state.ts accountStatus); '
    + 'runner-browser-status.pg.spec.ts (3) sends another account\'s session both ways',
  'POST /runner/browser/clear header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-browser.controller.ts:138), '
    + 'and what is cleared is that owner\'s own managed runner, found by the owner (runner-api/runner-browser-clear-approval.ts '
    + 'accountBrowserRunner); runner-browser-clear-logins.pg.spec.ts (4) sends another account\'s session',
  'POST /runner/browser/clear body approvalId':
    'spent only when it names a card filed by the asking session, under orbit_browser_clear_logins, ALLOWED by a person, about '
    + 'that owner\'s managed runner and not spent before (runner-api/runner-browser-clear-approval.ts:86, the WHERE of claimBrowserClearApproval); '
    + 'anything else is 403 and nothing is sent; runner-browser-clear-logins.pg.spec.ts (4) sends another session\'s card',
  'POST /runner/browser/open header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-browser.controller.ts:138), '
    + 'and what is opened is that owner\'s own managed runner, found by the owner (managed-runners/browser-state.ts open); '
    + 'runner-browser-open.pg.spec.ts (3) sends another account\'s session both ways',
  'POST /runner/browser/sign-in-requests header x-orbit-session-id':
    'must be a session of the runner\'s owner that this runner hosts, else 403 (runner-api/runner-browser.controller.ts:138), '
    + 'and the runner must be that owner\'s own managed runner, else 403 BROWSER_SIGN_IN_NOT_ORBIT_CLOUD (runner-browser.controller.ts:138); '
    + 'the card is filed for that owner and session only (owner-requests/owner-requests.service.ts:467); '
    + 'runner-browser-sign-in.pg.spec.ts (3) sends another account\'s session both ways',
  // ── the wiki's import on the server ──────────────────────────────────────────────────────────────
  'POST /runner/wiki/spaces/:id/import-jobs body id':
    'the id the command names for the job it is making: the insert does nothing when the id is taken, and the job '
    + 'answered is read back by (id, the caller\'s owner, the path\'s space, kind import), so another account\'s job '
    + 'under that id is neither read nor written (wiki-import-jobs.ts:115)',
  // ── the machine protocol: tokens the machine or the engine makes up, and the machine's own snapshots ──
  'GET /runner/sessions/:id/inbox query runningTurnId':
    'which turn the polling process says it is running, read on a runner link call only: compared, for inequality, '
    + 'with the turns of the path\'s session, already locked as this runner\'s, so another account\'s turn under that '
    + 'id is neither read nor written (runner-api.controller.ts:4270)',
  'POST /runner/integration-jobs/:jobId/result body observations[].taskId':
    'a task the control plane itself listed in this claim\'s OBSERVE_LANDING command (§10.6 O-J2), read again only '
    + 'among the claiming job\'s own project\'s tasks of the job\'s owner, and answered for only while it still waits '
    + 'with the commit named: another account\'s task under that id is not found, and nothing of it is read or '
    + 'written (landing-observation-result.ts:155)',
  'POST /runner/integration-jobs/:jobId/result body unknownPushes[].jobId':
    'the earlier landing the control plane itself listed in this claim\'s command (J12), re-read only inside the '
    + 'reporting account and on the claiming job\'s own serial key: another account\'s job under that id is not '
    + 'found, and nothing of it is read or written (integration-job-relay.ts:1646)',
  'POST /runner/heartbeat body backgroundJobSessionIds[]':
    'only the ids of sessions assigned to the calling runner are kept on its own presence row, over HTTPS (runners/runner-background-holders.ts:35) and over the link (runner-api/link-heartbeat.ts:447); another account\'s session is dropped like an id that names nothing, and nothing of it is read back or answered; link-heartbeat.pg.spec.ts 14 sends another account\'s',
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
  'POST /runner/heartbeat body modelCatalog.*[].parameters[].id':
    'a Cursor CLI option id (`context`, `fast`, a model\'s effort) in the model catalogue the machine reports about '
    + 'itself, not an Orbit row: stored on the reporting runner\'s own row and read back only through that runner '
    + '(runner-api.controller.ts:1271)',
  'POST /runner/heartbeat body repos[].agentIds[]':
    'which of the machine\'s checkouts serve which workspace, kept as its own repo-health snapshot and read only '
    + 'through a workspace of its own (runner-api.controller.ts:1075)',
  'POST /runner/codex-rate-limit-reset-result body rateLimitReset.rateLimitResetCredits.credits[].id':
    'a provider\'s credit id inside a reset result, which a REFRESHED result stores as the reporting machine\'s own '
    + 'plan usage (codex-reset-relay.ts:211)',
  'POST /runner/claude-history-result body transcripts[].claudeSessionId':
    'a transcript file on the reporting machine, stored as that machine\'s own history scan (runner-api.controller.ts:1707)',
  'POST /runner/cursor-key-check-result body checkId':
    'the token an apiserver process minted for one Cursor key check it handed the reporting machine, held in its memory '
    + 'beside that machine: an answer naming a check handed to any other settles nothing, here or in the process it is '
    + 'taken to (cursor-key-check-relay.ts:180)',
  'POST /runner/sessions/:id/approvals body toolUseId':
    'the engine\'s id for one tool call, a key only within the session the path names (runner-api.controller.ts:3867)',
  'POST /runner/sessions/:id/approvals body backgroundJobId':
    'the id the machine gave one of its own processes, stored on the approval of the session the path names '
    + '(runner-api.controller.ts:3900)',
  // A remote SubAgent's runner keeping files under the parent session it does not host (5bc9c25f00): the run it names is
  // looked up only among the RUNNING runs of the session the path names that belong to the calling runner's account
  // and were handed to that runner, and the session is then read under the same account (sessionOfRemoteSubagent,
  // runner-api/subagent-remote.ts:659). Another account's run, or another account's session, is the same 403 as
  // naming no run. files/file-tools.pg.spec.ts (11) sends a run of another session, a runner it was not handed to and
  // an ended run.
  'POST /runner/sessions/:id/files query subagentRunId':
    'a SubAgent run looked up only among the calling account\'s RUNNING runs of the session the path names that were '
    + 'handed to this runner (runner-api/subagent-remote.ts:659); any other id, another account\'s run included, is '
    + 'the 403 of naming none; files/file-tools.pg.spec.ts (11)',
  'PUT /runner/sessions/:id/files/:fileId/pin query subagentRunId':
    'the same lookup as the upload\'s subagentRunId (runner-api/subagent-remote.ts:659), then the file is read within '
    + 'that session; files/file-tools.pg.spec.ts (11)',
  'DELETE /runner/sessions/:id/files/:fileId/pin query subagentRunId':
    'the same lookup as the upload\'s subagentRunId (runner-api/subagent-remote.ts:659), then the file is read within '
    + 'that session; files/file-tools.pg.spec.ts (11)',
  'POST /runner/sessions/:id/file-bundles query subagentRunId':
    'the same lookup as the upload\'s subagentRunId (runner-api/subagent-remote.ts:659); the bundle\'s files are read '
    + 'within that session; files/file-tools.pg.spec.ts (11)',
  'POST /runner/sessions/:id/approvals body subagentRunId':
    'a SubAgent run, looked up only among the runs of the session the path names, whose ownership the door checked '
    + 'first; any other id, another account\'s run included, is 404 (runner-api.controller.ts:5509); '
    + 'sessions/subagent-approvals.pg.spec.ts sends another session\'s run and another account\'s',
  'POST /runner/sessions/:id/subagents body toolUseId':
    'the engine\'s id for the delegate call, a key only within the session the path names '
    + '(runner-api/runner-subagents.controller.ts:110)',
  'POST /runner/sessions/:id/workflows body toolUseId':
    'the engine id for a workflow call, keyed only by the session in the path (runner-api/runner-subagents.controller.ts:225)',
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
  'POST /runner/sessions/:id/release body claudeSessionId':
    'the release report is the finalize with no status word, and reads this as the finalize reads it: the engine\'s own '
    + 'id for its conversation, under its older name, stored on the session the path names (runner-api.controller.ts:10308)',
  'POST /runner/sessions/:id/release body runtimeSessionId':
    'the release report is the finalize with no status word, and reads this as the finalize reads it: the engine\'s own '
    + 'id for its conversation, stored on the session the path names (runner-api.controller.ts:10308)',
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

  // ── tasks ───────────────────────────────────────────────────────────────────────────────────────
  'DELETE /runner/tasks/:id header x-orbit-session-id':
    'looked up only by the id and the caller\'s owner, so another account\'s session is not found and the request reads '
    + 'as one naming none, and the only task it can delete is the caller\'s own the path names. Read rather than sent: '
    + 'each send would take away the task the next one needs (verifier-write-authority.ts:88)',
  'DELETE /runner/task-lists/:id header x-orbit-session-id':
    'looked up only by the id and the caller\'s owner, so another account\'s session is not found and the request reads '
    + 'as one naming none, and the only list it can delete is the caller\'s own the path names. Read rather than sent: '
    + 'each send would take away the list the next one needs (session-reach.ts:167)',
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
  'POST /runner/projects/:id/owner-questions body forRunQuestion':
    'matches ownerId, toSessionId against the project coordinator, kind RUN_QUESTION and state OPEN before linking the request in the item transaction (project-open-item.service.ts:897)',
  'POST /runner/projects/:id/rulings body sourceTurnId':
    'read by (id, a session of the runner\'s owner) and then held to a conversation that coordinated the project the '
    + 'path names; another account\'s turn answers 404 PROJECT_RULING_TURN_NOT_FOUND before anything is written '
    + '(projects/project-ruling.ts:177; project-ruling.pg.spec.ts, another owner)',
  'POST /runner/projects/:id/rulings body supersedes':
    'matched by (id, the runner\'s owner, the project the path names, live) inside the write; another account\'s ruling '
    + 'answers 409 PROJECT_RULING_SUPERSEDES_NOT_LIVE and writes nothing (projects/project-ruling.ts:216; project-ruling.pg.spec.ts)',
  'POST /runner/projects/:id/owner-questions body clientQuestionId':
    'the coordinator\'s own key for one question, a dedupe key within the project the path names '
    + '(project-open-item.service.ts:686)',
  // ── the runner drive door: the writer's own keys ─────────────────────────────────────────────
  ...underEveryDoorPrefix({
    'POST /runner/drive/create body handleId':
      "the writer's own key for the handle that fills the new file, stored on its first version and compared only with a "
      + "later commit's handleId on that same entry of the caller's account (drive/drive.service.ts:703); nothing is looked up by it",
    'POST /runner/drive/commit body handleId':
      "compared only with the handle_id of the current version of the entry the commit names, an entry already found by "
      + "(id, the runner's owner) under FOR UPDATE (drive/drive.service.ts:703); nothing is looked up by it",
    'POST /runner/drive/commit body commitId':
      "the writer's own retry key, looked up and stored only by (the runner's owner, commitId) (drive/drive.service.ts:690), "
      + "so another account's commit id names nothing of anybody's here",
    // ── the runner drive door: who a write is recorded as coming from ─────────────────────────────
    'POST /runner/drive/create body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
    'POST /runner/drive/mkdir body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
    'POST /runner/drive/commit body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
    'POST /runner/drive/rename body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
    'POST /runner/drive/delete body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
    'POST /runner/drive/utimens body writer.sessionId':
      "a drive write's attribution (docs/drive-technical-design.md §3.6): kept only when it is a session of the "
      + "runner's owner assigned to the calling runner, read by (id, owner, runner) in the write's own transaction, and "
      + "stored as null otherwise (drive/drive.service.ts:1226); no session is read beyond that, written or authorized by it",
  }),
  // ── an agent's directory sync, reported for the owner's upload tray (docs/drive-directory-sync-design.md S4) ──
  ...underEveryDoorPrefix({
    'POST /runner/drive/syncs body sessionId':
      "the session a sync is shown under: kept only when it is a session of the runner's owner, read by (id, owner), and "
      + "stored as null otherwise (drive/drive-syncs.service.ts:95); only its title is shown back, to that owner",
    'PATCH /runner/drive/syncs/:id body destEntryId':
      "the destination folder's id, stored on the caller's own sync row and never looked up (drive/drive-syncs.service.ts:132); "
      + "it is shown only to the runner's owner, whose own read of another account's entry by that id is not found",
  }),
  'POST /runner/documents/delete body id':
    'the same handler as POST /runner/drive/delete, whose case above holds it across accounts: RunnerDriveController '
    + 'is one class mounted under both prefixes (drive/runner-drive.controller.ts:103, '
    + '@Controller(RUNNER_DRIVE_ROUTE_PREFIXES)), so the alias reaches the same lookup by (id, the runner\'s owner); the '
    + "case's own request deletes A's file, which a second run under /runner/documents would find already gone",
  // The skip door's `approvalId` is sent by the census itself (RUNNER_ISOLATION_FIELD_CASES above): a real case is
  // the stronger registration, and the census refuses a key registered both ways.
};

/**
 * Bodies, or parts of bodies, declared with a type that names no fields (`Record<string, unknown>`,
 * `unknown`), keyed `<route> body <where>`: which ids the code reads there — each then a field like
 * any other — and the reading, with file:line, of what it reads.
 */
export const RUNNER_OPAQUE_BODIES: Readonly<Record<string, { reads: readonly string[]; reading: string }>> = {
  ...underEveryDoorPrefix({
    'PUT /runner/drive/stagings/:id/chunks/:idx request': {
      reads: [],
      reading: 'the raw bytes of one drive chunk, streamed into a temporary file and hashed; read only after the staging the '
        + 'path names is found by (id, the runner\'s owner, this runner) (drive/runner-drive.controller.ts:213), and never '
        + 'parsed for anything',
    },
  }),
  'POST /runner/link-token request': {
    reads: [],
    reading: 'the whole request, for how it arrived: X-Orbit-Request-Host, X-Orbit-Request-Proto, X-Forwarded-For and '
      + 'X-Real-IP, none of them an id. They choose only the link address the answer names, for this runner\'s own token '
      + '(runner-api/runner-link-token.controller.ts:61, sameOriginLinkUrl in runner-link-token.ts)',
  },
  'POST /runner/subagent-runs/:runId/events body events[].payload.*': {
    reads: [],
    reading: 'a remote SubAgent child\'s own engine event, stored rewritten for its parent\'s stream: its tool ids '
      + '(id, toolUseId, parentToolUseId) are the engine\'s keys, prefixed with the run id and nested under the run\'s own '
      + 'delegate call, never looked up (runner-api/subagent-remote.ts:364)',
  },
  'POST /runner/wiki/repo-ops/:id/result body result.*': {
    reads: [],
    reading: 'the runner\'s own answer — a snapshot\'s index, a read\'s text, a diff\'s paths, an anchor\'s states — '
      + 'kept on the operation it holds or in that operation\'s space\'s caches, and never dereferenced '
      + '(wiki-worker/wiki-repo-ops.ts:412, the row the result is written to)',
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
      + 'reviews, a task-create preview, and the runner or workspace a delete card names — is read under the session\'s '
      + 'own owner (runner-api.controller.ts:3879, :3976; runner-delete-approval.ts:80, :123)',
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
  'POST /runner/wiki/drafts body (the body)': {
    reads: ['body replaces'],
    reading: 'read field by field (WikiChatDrafts.draftInChat, wiki/wiki-chat-drafts.ts:215): kind, sections (slugs and keys of '
      + 'the calling chat\'s own space), reason and idempotencyKey name no row; the one id is replaces, the card of the '
      + 'calling chat the new one replaces, read by (id, the caller\'s owner) and refused unless the calling chat drafted it. '
      + 'A plan card\'s change (C12) is gated as a proposal is (WikiPlans.resolve, wiki/wiki-plan.ts:1262): the projects '
      + 'its session conditions name are read among the caller\'s owner\'s own, by id or exact title, and its topics among '
      + 'the calling chat\'s space\'s, so another account\'s project is no project — a gate error, never a read of it',
  },
  'POST /runner/workspaces body (the body)': {
    reads: ['body runnerId'],
    reading: 'whitelisted field by field; the one id is the runner the workspace runs on (runner-agents.controller.ts:110)',
  },
  'POST /runner/agents body (the body)': {
    reads: ['body runnerId'],
    reading: 'the same body under the workspaces\' pre-rename name (runner-agents.controller.ts:110)',
  },
  'PATCH /runner/workspaces/:id body (the body)': {
    reads: ['body runnerId'],
    reading: 'whitelisted as on create; the one id is the runner to move it to (runner-agents.controller.ts:136)',
  },
  'PATCH /runner/agents/:id body (the body)': {
    reads: ['body runnerId'],
    reading: 'the same body under the workspaces\' pre-rename name (runner-agents.controller.ts:136)',
  },
  'GET /runner/region-check request': {
    reads: [],
    reading: 'the request\'s X-Real-IP, CF-IPCountry and cf-region-code headers and its socket\'s peer: where it came '
      + 'from, no id; what it answers is written onto the calling runner\'s own row (runner-api.controller.ts:1720, '
      + 'runners/runner-region.ts recordRegionCheck)',
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
  'GET /shared/:token/stream':
    'the link\'s own session pushed — `sinceSeq` and `maxPayload` are numbers, and any link that is not a session\'s is '
    + 'the one 404 before anything is read (shared/shared-stream.guard.ts:29, :39)',
  // By hand rather than a case: an answered request is a stream that never ends, which (2) of the runner census
  // would wait on forever. The guard asks what `:token/sessions/:sessionId/events` asks (openConversation) before
  // anything is read; viewer-stream.pg.spec.ts sends another link's token with this conversation in it.
  'GET /shared/:token/sessions/:sessionId/stream':
    'a conversation the link opens, pushed: SharedStreamGuard resolves the token, then asks whether the link opens '
    + '`sessionId` exactly as `GET /shared/:token/sessions/:sessionId/events` does (shared/shared-stream.guard.ts:37, '
    + 'share-links.service.ts:428), the one 404 otherwise, before the stream reads or subscribes to anything',
  'GET /shared/:token/events/:seq':
    'a position in the link\'s own session\'s transcript, not an object: read WHERE session_id = the link\'s '
    + '(sessions.service.ts:3719)',
  'GET /shared/:token/docs/:slug':
    'a document slug of the link\'s own wiki space, not an object a caller can name: the space is the link\'s '
    + '(share-links.service.ts:378), and the slug is looked up among that space\'s own written documents — any '
    + 'other is the one 404 (public-wiki.ts:155)',
  'GET /shared/:token/content':
    'names nothing but its link: the bytes are those of the version the link was pinned to, read for the link\'s own '
    + 'owner and entry (share-links.service.ts:480), and a Range is a window on them — nothing in the request names '
    + 'another object',
  'GET /shared/:token/card':
    'names nothing but its link: the token is resolved as `GET /shared/:token` resolves it, and the answer is that '
    + 'link\'s own kind and root title (share-links.service.ts:359)',
};

/**
 * Every other route behind no account guard, and why it reaches no account's object: each takes no
 * id at all, only a secret that is itself the credential — and a secret that matches nothing is
 * answered alike whoever made the one that does.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  // The same handler under /drive and its /documents alias (drive/drive-routes.ts).
  ...Object.fromEntries(underEveryDrivePrefix('GET /drive/dl/:token').map((route) => [route,
    'a download URL the owner\'s Files page minted (POST /drive/entries/:id/download-link, behind the owner\'s login): the '
    + 'token is the credential, signed with a key of its own and expiring in five minutes, and it names its owner, file '
    + 'and version itself; the version is read WHERE id, owner and file are the token\'s, and a forged, expired or stale '
    + 'one is the one 404 — drive-download-links.ts:78, :84; nothing in the request but the token names an object — '
    + 'drive.controller.ts:279'])),
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
  'ALL /gw/anthropic':
    'the Anthropic gateway for Claude Code on an OpenAI key: its one credential is an `orbit-gwk-` session token, '
    + 'found by its hash and bound to the (session, key, person) it was issued for, refused unless that session is '
    + 'still open on that key and engine and that key is still the person\'s own, so a token reaches only the session '
    + 'it belongs to; the path is the Anthropic API\'s, with no Orbit id in it — anthropic-gateway.controller.ts:25, '
    + 'anthropic-gateway.service.ts:94',
  'ALL /gw/anthropic/{*path}':
    'the same gateway, for every path under it; one outside its two paths is refused before anything is forwarded — '
    + 'anthropic-gateway.controller.ts:36',
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
  'POST /integrations/github/webhook':
    'GitHub\'s webhook deliveries (docs/design/protected-branch-landing.md §4.7): no session and no token; the credential '
    + 'is the HMAC-SHA256 of the raw bytes under the deployment\'s saved secret, compared in constant time before '
    + 'anything is read. It names no Orbit id: a delivery about a repository or installation no workspace was cloned '
    + 'through is dropped, and the one row it writes is the delivery\'s own, keyed by GitHub\'s delivery id. The pull '
    + 'requests it is about are read again from GitHub, never changed from the payload — github-webhook.ts:107, :125',
  'GET /integrations/github/callback':
    'GitHub\'s return: the flow is taken by its state\'s hash with one DELETE … RETURNING and must match the browser '
    + 'cookie /integrations/github/start set; it writes only the connection of the account that started that flow. '
    + 'Without a state it only redirects — github-connection.service.ts:151',
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
  'GET /runner/link-token/revocations':
    'the runner link gateway\'s door, protected by the gateway service secret: the bearer must be '
    + 'RUNNER_LINK_GATEWAY_TOKEN, compared in constant time (404 with the link off) — '
    + 'runner-link-token.controller.ts:61, runner-link-token.ts:241; it takes no id, and answers only the '
    + 'fingerprints of the runner credentials revoked within a token\'s lifetime, which name no account and no '
    + 'runner — runner-link-token.controller.ts:122',
  'POST /runner/link/events':
    'the runner link gateway\'s merged event call, served on the link\'s internal listener alone, which admits only the '
    + 'gateway, by its service secret (404 over HTTPS, and with the link off) — runner-link-events.controller.ts:34, '
    + 'runner-link-call.ts:188. It carries batches of many runners, and each batch is the runner\'s whose link token its '
    + 'connection carries, admitted as RunnerAuthGuard admits a link call: the token verified, the runner read with its '
    + 'credential, its owner and its managed instance — link-events.ts:420, :450. A batch is written only into a session '
    + 'assigned to that runner and leased to that process, locked under that fence before anything is written — '
    + 'runner-api.controller.ts:8961, :8950, :7041; any other batch is answered sendAlone with nothing written, and '
    + 'the gateway sends it to the events route, which refuses it there as it refuses any runner\'s call',
  'GET /runner/link/mode':
    'the runner link gateway\'s door, behind the same gateway service secret (RunnerLinkGatewayGuard, 404 with the '
    + 'link off) — runner-link-required.controller.ts:17, runner-link-token.controller.ts:61, runner-link-token.ts:241; '
    + 'it takes no id, reads nothing and answers one constant — runner-link-required.controller.ts:21',
  'GET /runner/wake':
    'the long poll this path was is gone. It answers every caller 426 UPGRADE_REQUIRED before it reads anything, for the '
    + 'runners of 0.1.246 that still ask once as they start — runner-api.controller.ts:3571',
  'GET /help':
    'the help article library\'s index, read from docs/help at boot and the same for every reader; the caller, when a '
    + 'credential comes with the request (JwtAuthGuard, help.controller.ts:26), decides only whether the admin '
    + 'category shows, by the caller\'s own role — help.controller.ts:50, :59',
  'GET /help/articles/:slug':
    'one article of the bundled library by its slug, a file name and no account\'s id; an admin-only article is the '
    + '404 of a missing one to anyone but an administrator — help.controller.ts:62, help-library.ts:181',
  'GET /help/search':
    'full-text search over the bundled library alone, under the index\'s visibility rule — help.controller.ts:71',
};
