/**
 * §13.7's merge receipt against a real PostgreSQL, through the service every door goes through.
 *
 * The case this unit exists for is the last one here: a branch merged with `git merge --ff-only`
 * in an agent's own worktree. Before this table, that left `merge_status` NULL and `branch_merged`
 * false permanently — Orbit's Merge button was the only code that ever wrote them — so the control
 * plane's honest answer to "did this task's work land" was "no idea", forever, about every branch
 * that actually landed.
 *
 * The four scenarios acceptance names are each a test: a success, a conflict, a duplicate report,
 * and a branch that was already merged before anybody asked. All four have to leave exactly one
 * row per merge, and the row has to be checkable against the repository afterwards.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { MergeReceiptService } from './merge-receipt.service';
import { TaskCheckpointService } from '../projects/task-checkpoint.service';
import { ConvergenceLedgerService } from '../projects/convergence-ledger.service';
import { mergeReceiptIdempotencyKey } from './merge-receipt';
import { prismaClientFor } from '../prisma/prisma-client';
import { ratifyProjectForPgTest } from '../projects/project-ratification-test-helper';

const URL = process.env.COORDINATOR_PG_URL;

const SRC = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const TGT_BEFORE = '1111111111111111111111111111111111111111';
const TGT_AFTER = '2222222222222222222222222222222222222222';
const BASE = '3333333333333333333333333333333333333333';

interface World {
  ownerId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc25c.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await ratifyProjectForPgTest(db, ownerId, projectId, label);
  await db.task.create({
    data: { id: taskId, ownerId, title: label, creatorType: 'USER', creatorId: ownerId, projectId },
  });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, taskId,
      title: label, prompt: 'p', status: RunStatus.SUCCEEDED,
      branch: 'orbit/25c-work', isolationStatus: 'worktree',
    },
  });
  return { ownerId, projectId, taskId, sessionId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "session_merge_receipt", "project_action",
             "project_runtime", "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return '';
}

const suite = URL ? test : test.skip;

suite('merge receipts, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  const receipts = new MergeReceiptService(db as unknown as PrismaService);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  await t.test('a successful merge is recorded with everything needed to re-check it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'merged');

    const { receipt, created } = await receipts.record(
      w.ownerId,
      w.sessionId,
      {
        result: 'MERGED',
        sourceSha: SRC.toUpperCase(),
        targetBranch: 'feat/project',
        targetShaBefore: TGT_BEFORE,
        targetShaAfter: TGT_AFTER,
        rebaseBaseSha: BASE,
        detail: { command: 'git merge --ff-only orbit/25c-work' },
      },
      'AGENT',
    );

    assert.equal(created, true);
    assert.equal(receipt.result, 'MERGED');
    assert.equal(receipt.landed, true);
    // Case-normalised, so two spellings of one commit are one commit.
    assert.equal(receipt.sourceSha, SRC);
    assert.equal(receipt.targetShaBefore, TGT_BEFORE);
    assert.equal(receipt.targetShaAfter, TGT_AFTER);
    assert.equal(receipt.rebaseBaseSha, BASE);
    assert.equal(receipt.rebaseBaseShaAbsentReason, null);
    // The source branch defaults to the session's own, which is what makes the CLI call short.
    assert.equal(receipt.sourceBranch, 'orbit/25c-work');
    // Every address the audit joins on.
    assert.equal(receipt.sessionId, w.sessionId);
    assert.equal(receipt.taskId, w.taskId);
    assert.equal(receipt.projectId, w.projectId);
    assert.equal(receipt.recordedBy, 'AGENT');

    // ...and the columns every client already reads stop being blank. THIS is the fix.
    const session = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(session.mergeStatus, 'merged');
    assert.equal(session.branchMerged, true);
    assert.equal(session.mergeTarget, 'feat/project');
    assert.equal(session.mergedSourceSha, SRC);
    assert.ok(session.mergedAt);
    assert.equal(session.mergeError, null);
  });

  await t.test('reporting the same merge again returns the first receipt, not a second row', async () => {
    await emptyWorld(client);
    const w = await world(db, 'duplicate');
    const input = {
      result: 'MERGED' as const,
      sourceSha: SRC,
      targetBranch: 'feat/project',
      targetShaAfter: TGT_AFTER,
    };
    const first = await receipts.record(w.ownerId, w.sessionId, input, 'AGENT');
    // Same merge, reported after the target moved on — still the same merge.
    const second = await receipts.record(
      w.ownerId,
      w.sessionId,
      { ...input, targetShaAfter: BASE, targetShaBefore: TGT_AFTER },
      'USER',
    );
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.receipt.id, first.receipt.id);
    // The FIRST report is what stands: a receipt is a statement about a moment.
    assert.equal(second.receipt.targetShaAfter, TGT_AFTER);
    assert.equal(second.receipt.recordedBy, 'AGENT');
    const { receipts: all } = await receipts.list(w.ownerId, w.sessionId);
    assert.equal(all.length, 1);
  });

  await t.test('an externally merged branch records ALREADY_MERGED, and it counts as landed', async () => {
    await emptyWorld(client);
    const w = await world(db, 'already');
    const before = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    // The state this whole table was built for: nothing ever wrote these.
    assert.equal(before.mergeStatus, null);
    assert.equal(before.branchMerged, null);

    const { receipt } = await receipts.record(
      w.ownerId,
      w.sessionId,
      {
        result: 'ALREADY_MERGED',
        sourceSha: SRC,
        targetBranch: 'feat/project',
        targetShaAfter: TGT_AFTER,
        rebaseBaseSha: BASE,
        detail: { command: 'git merge-base --is-ancestor' },
      },
      'AGENT',
    );
    assert.equal(receipt.result, 'ALREADY_MERGED');
    assert.equal(receipt.landed, true);
    const after = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(after.mergeStatus, 'merged');
    assert.equal(after.branchMerged, true);

    // A DIFFERENT result about the same merge is a different receipt: "it was already there" and
    // "this call moved it" are not the same claim and must not collapse into one row.
    const upgraded = await receipts.record(
      w.ownerId,
      w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    assert.equal(upgraded.created, true);
    assert.notEqual(upgraded.receipt.id, receipt.id);
  });

  await t.test('a conflict is recorded with its paths, and does not claim the branch landed', async () => {
    await emptyWorld(client);
    const w = await world(db, 'conflict');
    const { receipt } = await receipts.record(
      w.ownerId,
      w.sessionId,
      {
        result: 'CONFLICT',
        sourceSha: SRC,
        targetBranch: 'feat/project',
        targetShaBefore: TGT_BEFORE,
        conflicts: ['src/apiserver/src/tasks/tasks.service.ts', 'src/web/src/App.tsx'],
        detail: { message: 'CONFLICT (content): Merge conflict in tasks.service.ts' },
      },
      'AGENT',
    );
    assert.equal(receipt.landed, false);
    assert.deepEqual(receipt.conflicts, [
      'src/apiserver/src/tasks/tasks.service.ts',
      'src/web/src/App.tsx',
    ]);
    const session = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(session.mergeStatus, 'conflict');
    assert.equal(session.branchMerged, null, 'a conflict claims nothing about the target');
    assert.match(String(session.mergeError), /Merge conflict/);
  });

  await t.test('an unverifiable claim is refused rather than stored', async () => {
    await emptyWorld(client);
    const w = await world(db, 'refuse');
    assert.match(
      await message(() =>
        receipts.record(w.ownerId, w.sessionId, {
          result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project',
        }, 'AGENT'),
      ),
      /must name targetShaAfter/,
    );
    assert.match(
      await message(() =>
        receipts.record(w.ownerId, w.sessionId, {
          result: 'ERROR', sourceSha: '97a10ae', targetBranch: 'feat/project',
        }, 'AGENT'),
      ),
      /40-character/,
    );
    assert.match(
      await message(() =>
        receipts.record(w.ownerId, w.sessionId, {
          result: 'MERGED', sourceSha: SRC, targetBranch: '  ', targetShaAfter: TGT_AFTER,
        }, 'AGENT'),
      ),
      /targetBranch is required/,
    );
    const { receipts: all } = await receipts.list(w.ownerId, w.sessionId);
    assert.equal(all.length, 0);
    const session = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(session.mergeStatus, null, 'a refusal writes nothing at all');
  });

  await t.test('another tenant cannot see or write a receipt for this session', async () => {
    await emptyWorld(client);
    const w = await world(db, 'tenant');
    const stranger = await world(db, 'stranger');
    await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    assert.match(
      await message(() =>
        receipts.record(stranger.ownerId, w.sessionId, {
          result: 'ERROR', sourceSha: SRC, targetBranch: 'feat/project',
        }, 'AGENT'),
      ),
      /session not found/,
    );
    assert.match(await message(() => receipts.list(stranger.ownerId, w.sessionId)), /session not found/);
  });

  await t.test('a receipt is append-only, even to raw SQL', async () => {
    await emptyWorld(client);
    const w = await world(db, 'immutable');
    const { receipt } = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    await assert.rejects(
      () => client.query(`UPDATE "session_merge_receipt" SET "result" = 'ERROR' WHERE "id" = $1`, [receipt.id]),
      /MERGE_RECEIPT_IMMUTABLE/,
    );
    await assert.rejects(
      () => client.query(`UPDATE "session_merge_receipt" SET "source_sha" = $2 WHERE "id" = $1`, [receipt.id, BASE]),
      /MERGE_RECEIPT_IMMUTABLE/,
    );
    // Deleting the task must still work: an immutability guard that turns into a referential
    // deadlock is the failure mode the exemption in 0128 exists to avoid.
    await client.query(`DELETE FROM "task" WHERE "id" = $1`, [w.taskId]);
    const { receipts: all } = await receipts.list(w.ownerId, w.sessionId);
    assert.equal(all.length, 1);
    assert.equal(all[0].taskId, null);
    assert.equal(all[0].projectId, w.projectId, 'the project survives the task');
    assert.equal(all[0].sourceSha, SRC, 'and the evidence is unchanged');
  });

  await t.test('an in-flight Orbit merge is not overwritten by a receipt', async () => {
    await emptyWorld(client);
    const w = await world(db, 'pending');
    const operationId = randomUUID();
    await db.session.update({
      where: { id: w.sessionId },
      data: { mergeStatus: 'pending', mergeOperationId: operationId, mergeTarget: 'main' },
    });
    const { created } = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    assert.equal(created, true, 'the durable half is written either way');
    const session = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    // The fence the runner echoes back is intact: a receipt may not cancel a merge still running.
    assert.equal(session.mergeStatus, 'pending');
    assert.equal(session.mergeOperationId, operationId);
    assert.equal(session.mergeTarget, 'main');
  });

  await t.test('the derived key is what the CLI would derive, so neither door double-writes', async () => {
    await emptyWorld(client);
    const w = await world(db, 'key');
    const { receipt } = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    assert.equal(
      receipt.idempotencyKey,
      mergeReceiptIdempotencyKey({
        sessionId: w.sessionId, sourceSha: SRC, targetBranch: 'feat/project', result: 'MERGED',
      }),
    );
    // An explicit key is honoured, and collides with itself.
    const a = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'ERROR', sourceSha: SRC, targetBranch: 'main', idempotencyKey: 'run-42' },
      'RUNNER',
    );
    const b = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'ERROR', sourceSha: BASE, targetBranch: 'develop', idempotencyKey: 'run-42' },
      'RUNNER',
    );
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.receipt.id, a.receipt.id);
  });

  await t.test('every id a receipt hands back is a task/session/project address', async () => {
    await emptyWorld(client);
    const w = await world(db, 'ids');
    const { receipt } = await receipts.record(
      w.ownerId, w.sessionId,
      { result: 'MERGED', sourceSha: SRC, targetBranch: 'feat/project', targetShaAfter: TGT_AFTER },
      'AGENT',
    );
    // The three ids are the fields PublicIdInterceptor twins on the way out (`id`, `sessionId`,
    // `taskId`, `projectId` are all classified). What is checked here is that they hold real
    // UUIDs — a value the interceptor cannot encode is one that leaks out raw.
    for (const value of [receipt.id, receipt.sessionId, receipt.taskId, receipt.projectId]) {
      assert.equal(typeof uuidToBase62(String(value)), 'string');
    }
    // ...and that nothing else in the row is a bare uuid a reader might mistake for one.
    assert.equal(receipt.idempotencyKey.length, 64, 'the key is a digest, not an id');
  });

  // ---------------------------------------------------------------------------------------------
  // `[K6]` §7: what changes once the work behind a receipt has a checkpoint.
  // ---------------------------------------------------------------------------------------------

  /** Put a task under `[K2]`'s management and give it one `ACCEPTED` checkpoint at `sha`. */
  async function checkpointed(w: World, sha: string): Promise<string> {
    const svc = new TaskCheckpointService(
      db as unknown as PrismaService,
      new ConvergenceLedgerService(db as unknown as PrismaService),
    );
    const tree = sha.replace(/./g, 'b');
    const recorded = await svc.record({
      ownerId: w.ownerId,
      taskId: w.taskId,
      scopeRevision: 1,
      commit: { branch: 'orbit/25c-work', commitSha: sha, treeSha: tree, baseSha: BASE },
      evidence: { suite: 'apiserver', treeSha: tree, passed: 10, failed: 0, skipped: 0 },
      artifact: null,
      recordedBy: 'WORKER',
    });
    assert.equal(typeof recorded === 'string' ? recorded : recorded.kind, 'ACCEPTED');
    return (recorded as { checkpointId: string }).checkpointId;
  }

  await t.test('§7: a landing that is not the verified commit is refused, and the attempt is not', async () => {
    await emptyWorld(client);
    const w = await world(db, 'gate');
    await checkpointed(w, SRC);

    // The branch committed past the commit the suite ran on. Those commits carry no evidence.
    assert.match(
      await message(() =>
        receipts.record(w.ownerId, w.sessionId, {
          result: 'MERGED', sourceSha: TGT_AFTER, targetBranch: 'main', targetShaAfter: TGT_AFTER,
        }, 'AGENT'),
      ),
      /BRANCH_TIP_MISMATCH/,
    );
    // A second measurement that disagrees with the recorded one is refused too.
    assert.match(
      await message(() =>
        receipts.record(w.ownerId, w.sessionId, {
          result: 'MERGED', sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
          evidenceDigest: '1'.repeat(64),
        }, 'AGENT'),
      ),
      /TEST_EVIDENCE_MISMATCH/,
    );
    // But a CONFLICT about the very commit the gate refuses is still recorded. It is the truth
    // about an attempt somebody made, and swallowing it would delete the audit of the thing the
    // gate exists to prevent.
    const conflict = await receipts.record(w.ownerId, w.sessionId, {
      result: 'CONFLICT', sourceSha: TGT_AFTER, targetBranch: 'main', conflicts: ['src/a.ts'],
    }, 'AGENT');
    assert.equal(conflict.created, true);

    // And the verified commit lands.
    const ok = await receipts.record(w.ownerId, w.sessionId, {
      result: 'MERGED', sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
    }, 'AGENT');
    assert.equal(ok.created, true);
    assert.equal(ok.receipt.landed, true);

    // The earlier CONFLICT is untouched: two events, two rows, neither rewritten.
    const { receipts: all } = await receipts.list(w.ownerId, w.sessionId);
    assert.equal(all.length, 2);
    const kept = all.find((r) => r.id === conflict.receipt.id);
    assert.equal(kept?.result, 'CONFLICT');
    assert.deepEqual(kept?.conflicts, ['src/a.ts']);
  });

  await t.test('CP4: one landing is one receipt even when a second session reports it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cp4');
    const checkpointId = await checkpointed(w, SRC);
    // A second session on the same task — a takeover, or a recovery on another runner. Keyed by
    // session this is two receipts for one landing; keyed by the checkpoint it is one fact.
    const second = randomUUID();
    const original = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    await db.session.create({
      data: {
        id: second, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: original.workspaceId,
        taskId: w.taskId, title: 'takeover', prompt: 'p', status: RunStatus.SUCCEEDED,
        branch: 'orbit/25c-work', isolationStatus: 'worktree',
      },
    });

    const input = {
      result: 'MERGED' as const, sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
    };
    const first = await receipts.record(w.ownerId, w.sessionId, input, 'AGENT');
    assert.equal(first.created, true);
    assert.equal(first.receipt.checkpointId, checkpointId);
    // The response was lost; the same session asks again.
    const retry = await receipts.record(w.ownerId, w.sessionId, input, 'AGENT');
    assert.equal(retry.created, false);
    assert.equal(retry.receipt.id, first.receipt.id);
    // ...and the takeover reports it too.
    const takeover = await receipts.record(w.ownerId, second, input, 'RUNNER');
    assert.equal(takeover.created, false, 'a second session minted a second receipt for one landing');
    assert.equal(takeover.receipt.id, first.receipt.id);
    assert.equal(takeover.receipt.sessionId, w.sessionId, 'the original report is what stands');
  });

  await t.test('CP4: a caller-supplied key cannot fragment one checkpoint-bound landing', async () => {
    await emptyWorld(client);
    const w = await world(db, 'crossdoor');
    const checkpointId = await checkpointed(w, SRC);

    // The agent door with its OWN key — the shape a CLI or a script legitimately uses, and the one
    // that used to win. The runner door derives the checkpoint key unconditionally, so a caller
    // key surviving here is a second row in the unique index for one landing.
    const custom = await receipts.record(w.ownerId, w.sessionId, {
      result: 'MERGED', sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
      idempotencyKey: 'run-42',
    }, 'AGENT');
    assert.equal(custom.created, true);
    assert.notEqual(custom.receipt.idempotencyKey, 'run-42', 'the caller key won');
    // Nothing is lost: what was asked for is on the row, so an audit can see why it is not the key.
    assert.equal((custom.receipt.detail as { callerIdempotencyKey?: string }).callerIdempotencyKey, 'run-42');

    // Now the runner door reports the same landing, deriving the key the way it always does.
    await MergeReceiptService.fromRunnerMergeResult(db as unknown as PrismaClient, {
      ownerId: w.ownerId, sessionId: w.sessionId, taskId: w.taskId, projectId: w.projectId,
      result: 'MERGED', sourceBranch: 'orbit/25c-work', sourceSha: SRC, targetBranch: 'main',
      targetShaBefore: TGT_BEFORE, targetShaAfter: TGT_AFTER, rebaseBaseSha: null, conflicts: [],
      message: null, operationId: null, checkpointId,
    });

    const { receipts: all } = await receipts.list(w.ownerId, w.sessionId);
    assert.equal(all.length, 1, 'the two doors wrote two rows for one landing');
    assert.equal(all[0].id, custom.receipt.id);

    // And the agent door asking a third time, with a THIRD key, still lands on the same row.
    const again = await receipts.record(w.ownerId, w.sessionId, {
      result: 'MERGED', sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
      idempotencyKey: 'run-43',
    }, 'AGENT');
    assert.equal(again.created, false);
    assert.equal(again.receipt.id, custom.receipt.id);
    assert.equal((await receipts.list(w.ownerId, w.sessionId)).receipts.length, 1);
  });

  await t.test("§13.7: an external receipt does not cancel a merge that is still running", async () => {
    await emptyWorld(client);
    const w = await world(db, 'fence');
    const checkpointId = await checkpointed(w, SRC);
    const operationId = randomUUID();
    // Orbit's own merge is in flight: `pending` carries the operation fence the runner echoes back.
    await db.session.update({
      where: { id: w.sessionId },
      data: { mergeStatus: 'pending', mergeOperationId: operationId, mergeTarget: 'main' },
    });

    const { created, receipt } = await receipts.record(w.ownerId, w.sessionId, {
      result: 'ALREADY_MERGED', sourceSha: SRC, targetBranch: 'main', targetShaAfter: TGT_AFTER,
    }, 'AGENT');

    // The durable half never depends on the transient half: the receipt is written either way.
    assert.equal(created, true);
    assert.equal(receipt.landed, true);
    assert.equal(receipt.checkpointId, checkpointId);
    // The fence is intact — the in-flight operation still owns the session.
    const session = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(session.mergeStatus, 'pending');
    assert.equal(session.mergeOperationId, operationId);
    assert.equal(session.branchMerged, null, 'the projection jumped the fence');
    assert.equal(session.mergedSourceSha, null);
  });
});
