import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

// `[K6]` §7 at the merge-result door: the server decides, and it fails closed.
//
// The gate the runner enforces reads `requiredSourceSha` off the command — and an older runner
// never reads that field, while a broken one can ignore it. Either would then report a merge of
// some other commit, and what used to happen next is the whole defect: the projection was written
// (`branch_merged`, `merged_source_sha`), then a receipt was written, and because no checkpoint
// matched the reported commit the receipt carried a NULL `checkpoint_id` — precisely the shape
// migration 0152's acceptance trigger has to let through, because that is what an old replica
// legitimately writes. An unverified tip landed as a fact, with every guard technically doing its
// job.
//
// So these drive the door with a runner that does not cooperate, and assert the two things that
// matter: the claim is refused with a typed reason, and NOTHING is written — not the projection,
// not the receipt, not a task read.

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const CHECKPOINT_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const LEASE_OWNER = '77777777-7777-4777-8777-777777777777';

const VERIFIED = 'a'.repeat(40);
const UNVERIFIED = 'c'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);

interface Harness {
  controller: RunnerApiController;
  sessionWrites: Array<Record<string, unknown>>;
  receiptWrites: unknown[];
  taskReads: number;
}

/**
 * A prisma whose raw reads answer in the order `mergeResult` makes them: the locked session row,
 * then — only when the report claims a landing — `managedTaskRevision`, then the authorised
 * checkpoint.
 */
function harness(opts: {
  managed?: boolean;
  checkpoint?: { id: string; kind: string; commitSha: string } | null;
  mergeCheckpointId?: string | null;
  taskId?: string | null;
}): Harness {
  const sessionWrites: Array<Record<string, unknown>> = [];
  const receiptWrites: unknown[] = [];
  let taskReads = 0;
  const answers: unknown[][] = [
    [
      {
        status: RunStatus.SUCCEEDED,
        inboxLeaseOwner: null,
        mergeStatus: 'pending',
        mergeOperationId: OPERATION_ID,
        mergeOperationOwner: LEASE_OWNER,
        ownerId: OWNER_ID,
        taskId: opts.taskId === undefined ? TASK_ID : opts.taskId,
        branch: 'orbit/k6',
        mergeTarget: 'main',
        mergeCheckpointId:
          opts.mergeCheckpointId === undefined ? CHECKPOINT_ID : opts.mergeCheckpointId,
      },
    ],
    (opts.managed ?? true) ? [{ scopeRevision: 1 }] : [],
    opts.checkpoint === null ? [] : [opts.checkpoint ?? { id: CHECKPOINT_ID, kind: 'ACCEPTED', commitSha: VERIFIED }],
  ];
  let call = 0;
  const tx = {
    $queryRaw: async () => answers[call++] ?? [],
    session: {
      update: async (write: { data: Record<string, unknown> }) => {
        sessionWrites.push(write.data);
      },
    },
    task: {
      findUnique: async () => {
        taskReads++;
        return { projectId: null };
      },
    },
    sessionMergeReceipt: {
      createMany: async (args: unknown) => {
        receiptWrites.push(args);
        return { count: 1 };
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) };
  return {
    controller: new RunnerApiController(
      prisma as never,
      { notifySessionQueued: () => undefined } as never,
      { notifyInbox: () => undefined, publish: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _s: unknown, c?: string) => c } as never,
    ),
    sessionWrites,
    receiptWrites,
    get taskReads() {
      return taskReads;
    },
  };
}

function report(h: Harness, over: Record<string, unknown>) {
  return h.controller.mergeResult({ id: RUNNER_ID }, SESSION_ID, {
    operationId: OPERATION_ID,
    leaseOwner: LEASE_OWNER,
    status: 'merged',
    mergedSha: TARGET_SHA,
    targetBranch: 'main',
    targetShaBefore: TARGET_SHA,
    ...over,
  } as never);
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ConflictException, `expected a typed refusal, got ${String(e)}`);
    return String((e as Error).message);
  }
  return '';
}

test('an old runner that names no source cannot land verified work by omission', async () => {
  // The mixed-version case with nothing malicious in it: a runner too old to send `sourceSha` at
  // all. The previous behaviour skipped the RECEIPT here (nothing checkable to write) and wrote
  // the projection anyway — the same fail-open by a quieter route, and one no reader could spot,
  // because the session simply said the branch had merged.
  const h = harness({});
  assert.match(await refusal(() => report(h, { sourceSha: undefined })), /BRANCH_TIP_MISMATCH/);
  assert.deepEqual(h.sessionWrites, [], 'a refused landing moved the session');
  assert.deepEqual(h.receiptWrites, [], 'a refused landing wrote a receipt');
  assert.equal(h.taskReads, 0, 'a refused landing did work on the way to writing one');
});

test('a runner that ignored requiredSourceSha cannot land an unverified commit', async () => {
  const h = harness({});
  const message = await refusal(() => report(h, { sourceSha: UNVERIFIED }));
  assert.match(message, /BRANCH_TIP_MISMATCH/);
  // The refusal names both commits: which one arrived, and which one this merge was authorised for.
  assert.match(message, new RegExp(UNVERIFIED));
  assert.match(message, new RegExp(VERIFIED));
  assert.deepEqual(h.sessionWrites, []);
  assert.deepEqual(h.receiptWrites, []);
});

test('the verified commit lands, and the receipt names the checkpoint the SERVER authorised', async () => {
  const h = harness({});
  await report(h, { sourceSha: VERIFIED });
  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].branchMerged, true);
  assert.equal(h.sessionWrites[0].mergedSourceSha, VERIFIED);
  assert.equal(h.receiptWrites.length, 1);
  const row = (h.receiptWrites[0] as { data: Array<Record<string, unknown>> }).data[0];
  assert.equal(row.result, 'MERGED');
  // Not looked up FROM the reported sha: that lookup returns null for exactly the report that most
  // needs refusing, and a null is what makes 0152's acceptance trigger stand down.
  assert.equal(row.checkpointId, CHECKPOINT_ID);
});

test('a managed merge with no authorised checkpoint fails closed', async () => {
  // The queue-time gate would not have authorised one, so a landing claiming otherwise is not a
  // landing this server asked for — whatever produced it.
  const h = harness({ mergeCheckpointId: null, checkpoint: null });
  assert.match(await refusal(() => report(h, { sourceSha: VERIFIED })), /NO_CHECKPOINT/);
  assert.deepEqual(h.sessionWrites, []);
  assert.deepEqual(h.receiptWrites, []);
});

test('an authorisation pointing at red work is refused however it got there', async () => {
  const h = harness({ checkpoint: { id: CHECKPOINT_ID, kind: 'WIP_RED', commitSha: VERIFIED } });
  assert.match(await refusal(() => report(h, { sourceSha: VERIFIED })), /CHECKPOINT_NOT_ACCEPTED/);
  assert.deepEqual(h.sessionWrites, []);
});

test('a conflict or an error is never refused — it is the truth about an attempt', async () => {
  // Refusing these would delete the audit of the very thing the gate exists to prevent, AND wedge
  // the operation: a runner whose only honest report is rejected has nothing left to say, and the
  // merge stays `pending` for ever.
  for (const status of ['conflict', 'error'] as const) {
    const h = harness({});
    await report(h, { status, sourceSha: UNVERIFIED, mergedSha: undefined });
    assert.equal(h.sessionWrites.length, 1, status);
    assert.equal(h.sessionWrites[0].mergeStatus, status);
    assert.equal(h.sessionWrites[0].branchMerged, undefined, 'a failure claimed the branch landed');
    assert.equal(h.receiptWrites.length, 1, `${status} lost its receipt`);
  }
});

test('unmanaged work is untouched by any of it', async () => {
  // Project AC11: every merge Orbit records today runs through this door, and none of them has a
  // checkpoint. A gate that refused them would take the feature out on deployment.
  const h = harness({ managed: false, mergeCheckpointId: null, checkpoint: null });
  await report(h, { sourceSha: UNVERIFIED });
  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].branchMerged, true);
  assert.equal(h.receiptWrites.length, 1);
  const row = (h.receiptWrites[0] as { data: Array<Record<string, unknown>> }).data[0];
  assert.equal(row.checkpointId, null);
});

test('a session with no task at all takes the same untouched path', async () => {
  const h = harness({ taskId: null, mergeCheckpointId: null, checkpoint: null });
  await report(h, { sourceSha: UNVERIFIED });
  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].branchMerged, true);
});
