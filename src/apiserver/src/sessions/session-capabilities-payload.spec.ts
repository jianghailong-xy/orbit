import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SESSION_MERGE_RECOVERY_V1 } from '@orbit/shared';
import { SessionsService } from './sessions.service';
import { noSessionRequests } from '../test-support/prisma-transaction-double';

const NOW = new Date();

function sessionRow() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: RunStatus.CANCELLED,
    title: 'Dormant session',
    createdAt: NOW,
    lastTurnAt: NOW,
    startedAt: NOW,
    numTurns: 1,
    costUsd: 0,
    error: null,
    endReason: 'ended',
    cancelRequestedAt: NOW,
    runtimeSessionId: 'runtime-1',
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    source: 'user',
    provider: 'claude',
    model: null,
    permissionMode: null,
    effort: null,
    lastAssistantText: null,
    lastToolUse: null,
    lastUserText: null,
    mergeStatus: null,
    // The SOURCE columns, as migration 0231 leaves them on every session that resolves no baseline:
    // NOT NULL DEFAULT 'UNBOUND', both refusal keys null.
    sourceState: 'UNBOUND',
    sourceRefusalCode: null,
    sourceRefusalDetail: null,
    pinnedAt: null,
    tags: [],
    tagLinks: [],
    runningBgCount: 0,
    // The raw shell ids, which the list reads (and never ships) to decide whether a card is still
    // being asked — `approval.background_job_id` versus this set, so the mapper needs the ids and
    // not the cardinality beside them.
    runningBgShells: [],
    // The two columns the list's `runningBgJobCount` is derived from: the live job set, and when each
    // of those jobs last produced output. The count is not one of the row's columns any more — which
    // jobs still count is a fact about `now` (background-job-activity.ts), so the mapper decides it.
    runningBgJobs: [],
    runningBgJobActivity: {},
    runningSubagentCount: 0,
    // The detail's newest merge-repair child, which this session has none of.
    children: [],
    workspaceId: null,
    workspaceName: null,
    workspaceModel: null,
    workspace: null,
    runnerId: '22222222-2222-4222-8222-222222222222',
    runnerName: 'runner',
    runnerStatus: 'ONLINE',
    runnerLastHeartbeatAt: NOW,
    assignedRunnerId: '22222222-2222-4222-8222-222222222222',
    assignedRunner: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'runner',
      status: 'ONLINE',
      lastHeartbeatAt: NOW,
      capabilities: [] as string[],
    },
    taskId: null,
    taskTitle: null,
    projectId: '33333333-3333-4333-8333-333333333333',
    projectTitle: 'Project Atlas',
  };
}

test('UI list and detail payloads include the same derived capabilities', async () => {
  const row = sessionRow();
  const prisma = {
    $queryRaw: async () => [row],
    session: {
      findFirst: async () => ({
        ...row,
        // The detail counts the ids it spreads beside the count the list computes in the mapper.
        runningBgJobs: [],
        runningBgJobActivity: {},
        // The include's own shape (`sessions.service.ts#get`): the project, and its primary
        // codebase — never a bare project, since `codebases` is a to-many relation and comes back
        // as an array. The integration line is derived from it.
        coordinatorForProject: {
          id: row.projectId,
          title: row.projectTitle,
          codebases: [{ integrationRef: 'refs/heads/project/atlas' }],
        },
        titleManagedByProject: true,
        titleBeforeProjectManagement: 'Dormant session',
      }),
      // Which of the rows are runs of a task, for the evidence cards of dispatched tasks a run can
      // hold (`tasks/pending-evidence-judgments.ts#countDispatchedEvidenceJudgments`): none.
      findMany: async () => [],
    },
    // The list's `pendingApprovals` is blocked tool calls plus the owner decisions each row is the
    // surface for (`projects/owner-decision-signal.ts`). This row coordinates nothing and no
    // OWNER_CONFIRMED run is waiting on it, so the second half is empty and the capabilities below
    // are unaffected either way.
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    // …the evidence of tasks it dispatched outside any project (`tasks/evidence-review.ts`), none…
    task: { findMany: async () => [] },
    // …and the four owner items a project can be waiting on its owner for (§7.6 V13),
    // which these fixtures have none of either.
    sessionRequest: noSessionRequests(),
    projectOpenItem: { findMany: async () => [] },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const [listed] = await service.list('owner-1', { view: 'active' });
  const detail = await service.get('owner-1', row.id);

  const expected = {
    canSend: true,
    canResume: true,
    resumeBlockedReason: null,
    canComplete: true,
    canArchive: true,
    canRestore: false,
  };
  assert.deepEqual(listed.capabilities, expected);
  assert.deepEqual(detail.capabilities, expected);
  assert.equal(detail.mergeRecoverySupported, false);
  assert.deepEqual(
    [listed.projectId, listed.projectTitle, detail.projectId, detail.projectTitle],
    [row.projectId, row.projectTitle, row.projectId, row.projectTitle],
  );
  // The coordinator's own project line, read out of the codebase the include carries.
  assert.equal(detail.projectIntegrationRef, 'project/atlas');
  assert.equal('titleManagedByProject' in detail, false);
  assert.equal('titleBeforeProjectManagement' in detail, false);
});

/**
 * A REFUSED RUN IS A FACT ABOUT THE ROW, NOT A SECOND REQUEST.
 *
 * The card a person sees when a run never started reads `sourceState` / `sourceRefusalCode` /
 * `sourceRefusalDetail` off the session it is drawn for — and the list is where it is drawn: a run
 * a runner refused before spawning anything produces no transcript event and no status a row can
 * interpret, so a task somebody dispatched looks like a task nothing happened to. That is the wall
 * the native clients named (2026-10-07): the read carried none of the three, so the refusal code,
 * the ref the runner could not resolve and the `fixAction` that says what to do about it were
 * reachable only from the runner's own claim projection, which no owner-side client ever sees.
 *
 * Asserted on both halves of the read, plus the SQL: the mapper could copy a column the query never
 * asked for and the result would be an `undefined` no client can tell from a null.
 */
test('the session list and detail carry the SOURCE snapshot the never-started card reads', async () => {
  const detail = {
    ref: 'refs/heads/project/atlas',
    refAuthority: 'REMOTE',
    remoteName: 'origin',
    stderr: "fatal: couldn't find remote ref refs/heads/project/atlas",
    fixAction: 'FIX_REF',
  };
  const refused = {
    ...sessionRow(),
    sourceState: 'REFUSED',
    sourceRefusalCode: 'BASE_REF_NOT_FOUND',
    sourceRefusalDetail: detail,
  };
  const statements: string[] = [];
  const prisma = {
    $queryRaw: async (query: { sql?: string }) => {
      if (query?.sql) statements.push(query.sql);
      return [refused];
    },
    session: {
      findFirst: async () => ({ ...refused, coordinatorForProject: null }),
      findMany: async () => [],
    },
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    task: { findMany: async () => [] },
    sessionRequest: noSessionRequests(),
    projectOpenItem: { findMany: async () => [] },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const [listed] = await service.list('owner-1', {});
  assert.deepEqual(
    [listed.sourceState, listed.sourceRefusalCode, listed.sourceRefusalDetail],
    ['REFUSED', 'BASE_REF_NOT_FOUND', detail],
  );
  // The projection asks for all three — `source_refusal_detail` in particular, which is read by
  // nothing else on this side of the API.
  const projected = statements.filter((sql) => sql.includes('FROM session s'));
  assert.equal(projected.length, 1, 'the list row is one query');
  for (const alias of ['sourceState', 'sourceRefusalCode', 'sourceRefusalDetail']) {
    assert.match(projected[0]!, new RegExp(`s\\.${alias.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}\\s+AS "${alias}"`));
  }

  const one = await service.get('owner-1', refused.id);
  assert.deepEqual(
    [one.sourceState, one.sourceRefusalCode, one.sourceRefusalDetail],
    ['REFUSED', 'BASE_REF_NOT_FOUND', detail],
  );
});

/**
 * The control this whole feature's cardinality turns on: every Legacy session — which is every
 * session that resolves no code baseline — reads `UNBOUND` with both refusal keys present and null.
 * The keys are not omitted, because a client folding a row it holds has to be able to CLEAR a
 * refusal, and "nothing was ever refused here" arriving as an absent key is indistinguishable from
 * an older server that never knew the field.
 */
test('a session that resolves no SOURCE reports UNBOUND with null refusal keys', async () => {
  const plain = sessionRow();
  const prisma = {
    // The list row and the membership reads both come through $queryRaw; only the first is the row.
    $queryRaw: async (query: { sql?: string }) =>
      (query?.sql?.includes('FROM session s') ? [plain] : [{ projectMembership: null }]),
    session: {
      findFirst: async () => ({ ...plain, coordinatorForProject: null }),
      findMany: async () => [],
    },
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    task: { findMany: async () => [] },
    sessionRequest: noSessionRequests(),
    projectOpenItem: { findMany: async () => [] },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const [listed] = await service.list('owner-1', {});
  const one = await service.get('owner-1', plain.id);
  for (const row of [listed, one]) {
    assert.equal(row.sourceState, 'UNBOUND');
    assert.ok(Object.hasOwn(row, 'sourceRefusalCode'));
    assert.equal(row.sourceRefusalCode, null);
    assert.ok(Object.hasOwn(row, 'sourceRefusalDetail'));
    assert.equal(row.sourceRefusalDetail, null);
  }
});

test('merge recovery is offered only by a capable assigned runner', async () => {
  for (const capabilities of [[], [SESSION_MERGE_RECOVERY_V1]]) {
    const row = sessionRow();
    row.assignedRunner.capabilities = capabilities;
    const service = new SessionsService({
      $queryRaw: async () => [{ projectMembership: null }],
      session: { findFirst: async () => row },
    } as never, {} as never, {} as never);
    const detail = await service.get('owner-1', row.id);
    assert.equal(detail.mergeRecoverySupported, capabilities.length > 0);
  }
  const row = sessionRow();
  const service = new SessionsService({
    $queryRaw: async () => [{ projectMembership: null }],
    session: { findFirst: async () => ({ ...row, assignedRunner: null }) },
  } as never, {} as never, {} as never);
  assert.equal((await service.get('owner-1', row.id)).mergeRecoverySupported, false);
});

test('session detail resolves the embedded workspace key against its actual runner', async () => {
  const row = sessionRow();
  const runner = {
    ...row.assignedRunner, displayName: 'HPC', version: '0.1.210', capabilities: ['provider:antigravity'],
    engines: [{ engine: 'antigravity', installed: true, version: '1.2.3', auth: 'no' }],
  };
  const workspace = { id: 'workspace-1', runnerId: 'a-different-runner', env: { GEMINI_API_KEY: '' } };
  const service = new SessionsService({
    $queryRaw: async () => [{ projectMembership: null }],
    session: { findFirst: async () => ({ ...row, assignedRunner: runner, workspace }) },
  } as never, {} as never, {} as never);
  let detail = await service.get('owner-1', row.id);
  assert.deepEqual(detail.workspace?.antigravityKeyAvailableByRunner, { [runner.id]: false });
  assert.deepEqual(detail.assignedRunner?.antigravity, {
    supported: true, installed: true, version: '1.2.3', envKeyAvailable: false, authSource: null, googleLogin: 'needs_update',
  });
  workspace.env.GEMINI_API_KEY = 'test-workspace-key';
  detail = await service.get('owner-1', row.id);
  assert.deepEqual(detail.workspace?.antigravityKeyAvailableByRunner, { [runner.id]: true });
  workspace.env.GEMINI_API_KEY = '';
  runner.engines[0].auth = 'yes';
  detail = await service.get('owner-1', row.id);
  assert.deepEqual(detail.workspace?.antigravityKeyAvailableByRunner, { [runner.id]: true });
});

test('session detail says which credential the runner runs built-in Antigravity on', async () => {
  const row = sessionRow();
  const runner = {
    ...row.assignedRunner, displayName: 'HPC', version: '0.1.211',
    capabilities: ['provider:antigravity', 'antigravity-google-login/v1'],
    engines: [{ engine: 'antigravity', installed: true, version: '1.2.16', auth: 'yes', authSource: 'google' }],
  };
  const workspace = { id: 'workspace-1', runnerId: runner.id, env: null };
  const service = new SessionsService({
    $queryRaw: async () => [{ projectMembership: null }],
    session: { findFirst: async () => ({ ...row, assignedRunner: runner, workspace }) },
  } as never, {} as never, {} as never);
  const detail = await service.get('owner-1', row.id);
  // Signed in with Google and no key anywhere: the engine is offered, labelled by its source.
  assert.deepEqual(detail.workspace?.antigravityKeyAvailableByRunner, { [runner.id]: true });
  assert.deepEqual(detail.assignedRunner?.antigravity, {
    supported: true, installed: true, version: '1.2.16', envKeyAvailable: true, authSource: 'google', googleLogin: 'available',
  });
});
