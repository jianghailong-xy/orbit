import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RecordTaskCheckpointDto } from './dto';
import { TaskCheckpointService } from './task-checkpoint.service';

// `[K6]`'s read and write face.
//
// Three things have to be true of it that the pg spec cannot show, because that one exercises SQL:
// a caller cannot name the KIND (§7's first row is a fact about a measurement, and a door that let
// a caller assert `ACCEPTED` would put every property below it on the caller's word); the ids a
// caller could hand back reach them in Base62; and the baseline the endpoint reports is the LATEST
// accepted checkpoint rather than whichever the client happens to filter to first.

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const ACCEPTED = '019fcdad-acd0-73f1-b83e-34c901525105';
const RED = '019fcdae-c039-76c2-bb7b-1a7c550f8e26';
const ATTEMPT = '019fcfea-9d8b-7303-8784-e1b3078faef3';

function row(over: Record<string, unknown>) {
  return {
    id: ACCEPTED,
    taskId: TASK,
    projectId: null,
    seq: 1n,
    kind: 'ACCEPTED',
    scopeRevision: 1,
    branch: 'orbit/k6',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
    evidenceDigest: 'd'.repeat(64),
    testEvidence: { suite: 'apiserver', passed: 10, failed: 0, skipped: 0 },
    artifactKind: null,
    artifactRef: null,
    artifactDigest: null,
    contentDigest: 'e'.repeat(64),
    recordedBy: 'WORKER',
    sessionId: null,
    attemptId: ATTEMPT,
    createdAt: new Date('2026-08-23T10:00:00.000Z'),
    ...over,
  };
}

function service(rows: unknown[]) {
  const prisma = { $queryRaw: async () => rows };
  return new TaskCheckpointService(prisma as never, {} as never);
}

function through<T>(body: T): Promise<T> {
  class Controller {}
  return lastValueFrom(
    new PublicIdInterceptor().intercept(
      { getClass: () => Controller } as never,
      { handle: () => of(body) } as never,
    ),
  ) as Promise<T>;
}

async function refusals(input: Partial<Record<string, unknown>>): Promise<string[]> {
  const dto = plainToInstance(RecordTaskCheckpointDto, {
    branch: 'orbit/k6',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
    scopeRevision: 1,
    ...input,
  });
  const errors = await validate(dto as object, { whitelist: false });
  return errors.map((e) => e.property);
}

test('§7: the write door has no field a caller could name the kind with', async () => {
  // The one property that makes every other one worth having. If `kind` were accepted here, a
  // caller could call a red tree `ACCEPTED` and the baseline rule, the merge gate and the audit
  // would all be resting on the word rather than on the evidence.
  const fields = Object.keys(
    plainToInstance(RecordTaskCheckpointDto, {
      branch: 'b', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
      scopeRevision: 1, kind: 'ACCEPTED', accepted: true,
    }) as object,
  );
  // `plainToInstance` copies unknown keys, so what is asserted is that the CLASS declares none of
  // them — the controller reads only its own properties, and neither name is one.
  const declared = Object.keys(
    plainToInstance(RecordTaskCheckpointDto, {
      branch: 'b', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
      scopeRevision: 1,
    }) as object,
  );
  assert.equal(declared.includes('kind'), false);
  assert.equal(declared.includes('accepted'), false);
  assert.ok(fields.includes('kind'), 'sanity: the plain object really did carry one');
});

test('MR1: an abbreviated object name never reaches the service', async () => {
  assert.deepEqual(await refusals({}), []);
  assert.deepEqual(await refusals({ commitSha: 'a1b2c3d' }), ['commitSha']);
  assert.deepEqual(await refusals({ treeSha: 'B'.repeat(40) }), ['treeSha'], 'uppercase is not the stored spelling');
  assert.deepEqual(await refusals({ baseSha: '' }), ['baseSha']);
  assert.deepEqual(await refusals({ scopeRevision: 0 }), ['scopeRevision']);
  assert.deepEqual(await refusals({ branch: '' }), ['branch']);
});

test('§7 CP6: the read states the baseline instead of leaving a client to re-derive it', async () => {
  // Newest first, and the newest is RED — which is the ordinary sequence (verify, then try
  // something). A client that took `checkpoints[0]` would start the next task from the experiment.
  const svc = service([
    row({ id: RED, seq: 3n, kind: 'WIP_RED', evidenceDigest: null, testEvidence: null,
          artifactKind: 'GIT_BUNDLE', artifactRef: 'bundle:k6:red', artifactDigest: 'f'.repeat(64) }),
    row({ id: ACCEPTED, seq: 2n }),
  ]);
  const checkpoints = await svc.list(OWNER, TASK);
  const baseline = checkpoints.find((c) => c.kind === 'ACCEPTED') ?? null;
  assert.equal(checkpoints[0].id, RED);
  assert.equal(baseline?.id, ACCEPTED);
  // BigInt columns cross the wire as numbers here, as `seq` is a small ordinal within one task.
  assert.equal(typeof checkpoints[0].seq, 'number');
});

test('every id the read hands back reaches a caller in Base62', async () => {
  const svc = service([row({})]);
  const body = await through({
    taskId: TASK,
    checkpoints: await svc.list(OWNER, TASK),
    baselineCheckpointId: ACCEPTED,
    baselineAbsentReason: null,
  });
  assert.equal(body.taskId, uuidToBase62(TASK));
  assert.equal(body.baselineCheckpointId, uuidToBase62(ACCEPTED));
  assert.equal(body.checkpoints[0].id, uuidToBase62(ACCEPTED));
  assert.equal(body.checkpoints[0].taskId, uuidToBase62(TASK));
  assert.equal(body.checkpoints[0].attemptId, uuidToBase62(ATTEMPT));
  // The digests are NOT ids and must not be twinned into something that no longer matches the
  // repository — the whole value of the row is that these are checkable against git afterwards.
  assert.equal(body.checkpoints[0].commitSha, 'a'.repeat(40));
  assert.equal(body.checkpoints[0].contentDigest, 'e'.repeat(64));
});

test('a task with nothing accepted says so, rather than returning a silent null', async () => {
  const svc = service([
    row({ id: RED, seq: 1n, kind: 'WIP_RED', evidenceDigest: null, testEvidence: null,
          artifactKind: 'GIT_BUNDLE', artifactRef: 'bundle:k6:red', artifactDigest: 'f'.repeat(64) }),
  ]);
  const checkpoints = await svc.list(OWNER, TASK);
  const baseline = checkpoints.find((c) => c.kind === 'ACCEPTED') ?? null;
  assert.equal(baseline, null);
  // `NO_ACCEPTED_CHECKPOINT` rather than a bare null: "there is none" and "this build does not
  // know" are different answers, and a caller deciding whether to start work needs which.
  const body = { baselineCheckpointId: null, baselineAbsentReason: 'NO_ACCEPTED_CHECKPOINT' };
  assert.equal(body.baselineAbsentReason, 'NO_ACCEPTED_CHECKPOINT');
});
