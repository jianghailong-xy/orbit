import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { SESSION_MERGE_RECOVERY_V1, type MergeRecovery } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;

(URL ? test : test.skip)('merge recovery survives queue, heartbeat, result persistence and local-only retry on PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await client.end(); });
  await verifyCoordinatorPgIdentity(client);
  const ownerId = randomUUID(), runnerId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID();
  const leaseOwner = randomUUID();
  await db.user.create({ data: { id: ownerId, name: 'test', email: `${ownerId}@pcc-recovery.invalid`, passwordHash: 'test' } });
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'test', tokenHash: randomUUID(),
    status: RunnerStatus.ONLINE, capabilities: [SESSION_MERGE_RECOVERY_V1] } });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'test', workDir: '/repo' } });
  await db.session.create({ data: { id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
    title: 'test', prompt: 'test', status: RunStatus.SUCCEEDED, branch: 'orbit/recovery-test', isolationStatus: 'worktree' } });
  const realtime = new RealtimeService(db as never, {} as never);
  const queue = { notifySessionQueued() {} };
  const sessions = new SessionsService(db as never, queue as never, realtime as never);
  const api = new RunnerApiController(db as never, queue as never, realtime as never,
    {} as never, {} as never, {} as never, {} as never);
  const reviewed: MergeRecovery = {
    code: 'READY', targetBranch: 'develop', previewId: 'reviewed', repoRoot: '/repo',
    sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
    candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), patch: 'complete candidate diff',
    check: { status: 'unconfigured' },
  };
  await sessions.mergeToMain(ownerId, sessionId, 'develop', undefined, { recoveryAction: 'preview' });
  assert.deepEqual(await realtime.drainMergeRequests(runnerId, leaseOwner, false), []);
  const [preview] = await realtime.drainMergeRequests(runnerId, leaseOwner, true);
  assert.equal(preview.recoveryAction, 'preview');
  await api.mergeResult({ id: runnerId }, sessionId, {
    status: 'error', operationId: preview.operationId, leaseOwner,
    sourceSha: reviewed.sourceSha, targetBranch: 'develop', recovery: reviewed,
  });
  assert.deepEqual((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).mergeRecovery, reviewed);
  assert.equal(await db.sessionMergeReceipt.count({ where: { sessionId } }), 0);
  await assert.rejects(() => sessions.mergeToMain(ownerId, sessionId, 'develop', undefined,
    { recoveryAction: 'apply', previewId: 'stale' }), ConflictException);

  await sessions.mergeToMain(ownerId, sessionId, 'develop', undefined, { recoveryAction: 'apply', previewId: 'reviewed' });
  const [apply] = await realtime.drainMergeRequests(runnerId, leaseOwner, true);
  assert.deepEqual(apply.recovery, reviewed);
  await assert.rejects(() => api.mergeResult({ id: runnerId }, sessionId, {
    status: 'merged', operationId: apply.operationId, leaseOwner, sourceSha: reviewed.sourceSha,
    targetBranch: 'develop', mergedSha: reviewed.candidateSha,
    recovery: { ...reviewed, code: 'DONE', candidateSha: 'f'.repeat(40) },
  }), ConflictException);
  assert.equal(await db.sessionMergeReceipt.count({ where: { sessionId } }), 0);

  const partial = { ...reviewed, code: 'LOCAL_SYNC_PENDING' };
  await api.mergeResult({ id: runnerId }, sessionId, {
    status: 'merged', operationId: apply.operationId, leaseOwner, sourceSha: reviewed.sourceSha,
    targetBranch: 'develop', mergedSha: reviewed.candidateSha, targetShaBefore: reviewed.remoteSha,
    rebaseBaseSha: reviewed.remoteSha, recovery: partial, message: 'local edits block checkout',
  });
  const landed = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(landed.branchMerged, true);
  assert.equal(landed.mergeError, 'local edits block checkout');
  assert.deepEqual(landed.mergeRecovery, partial);
  assert.equal(await db.sessionMergeReceipt.count({ where: { sessionId, result: 'MERGED' } }), 1);

  await sessions.mergeToMain(ownerId, sessionId, 'develop', undefined, { recoveryAction: 'sync-local', previewId: 'reviewed' });
  const [sync] = await realtime.drainMergeRequests(runnerId, leaseOwner, true);
  assert.equal(sync.recoveryAction, 'sync-local');
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).branchMerged, true);
  await api.mergeResult({ id: runnerId }, sessionId, {
    status: 'merged', operationId: sync.operationId, leaseOwner, sourceSha: reviewed.sourceSha,
    targetBranch: 'develop', mergedSha: reviewed.candidateSha, recovery: { ...reviewed, code: 'DONE' },
  });
  const settled = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(settled.mergeRecovery, null);
  assert.equal(settled.mergeError, null);
  assert.equal(settled.branchMerged, true);
  assert.equal(settled.mergedAt?.getTime(), landed.mergedAt?.getTime());
  assert.equal(settled.baseSha, landed.baseSha);
  assert.equal(await db.sessionMergeReceipt.count({ where: { sessionId } }), 1, 'local sync must not duplicate a landing');
});
