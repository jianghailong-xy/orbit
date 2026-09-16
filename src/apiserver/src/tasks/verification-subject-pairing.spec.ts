/**
 * The pairing rule: a VERIFICATION subject and the check that settles it are ONE write.
 *
 * What it is for. A task declaring the subject shape has no work of its own to run — `execute`
 * refuses it and auto-dispatch passes it by — and it is settled only by a PASS that a separate task
 * pointing at it records. Nothing on the server files that task: `fileVerification` has no callers,
 * and no sweep creates checks. So a subject written on its own waits for something nobody is going
 * to do, which is what the eleven rows that motivated this cost: zero sessions each, several of
 * them OPEN for weeks. The rule is stated where the write happens, and it is one rule: the check
 * comes in the SAME call, or the row is not written.
 *
 * Three things are held apart below, deliberately.
 *
 *   - The predicate, as a decision over items: a subject, a sibling that verifies it, a work row,
 *     a verifier, a row no label can point at. Nothing here touches a service.
 *   - The doors, against a write fixture. "Refused before writing" is asserted as the only thing
 *     that can prove it — the transaction was never opened, no lock was taken, no row was created —
 *     because a refusal that happens after the first INSERT and rolls back is a weaker promise.
 *   - The refusal's words, which are the whole of what a caller has to act on: both ways out.
 */

import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import {
  VERIFICATION_SUBJECT_NEEDS_VERIFIER_ACTION,
  VERIFICATION_SUBJECT_NEEDS_VERIFIER_CODE,
  verificationSubjectNeedsVerifierRefusal,
  verificationSubjectUnpaired,
} from './task-completion-criterion';
import type { CreateTaskBatchItemDto } from './dto';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const CHECKER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SUBJECT_TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Written = { id: string; data: Record<string, unknown> };

/**
 * A write fixture that records the two things a refusal has to leave untouched: rows, and the
 * transaction they would have been written in. Everything else answers "a row you own", so the path
 * under test is reached rather than blocked by an unrelated ownership check.
 */
function makeService() {
  const created: Written[] = [];
  const calls: string[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      calls.push(/FOR UPDATE/i.test(renderRawQuery(args).text) ? 'lock' : 'query');
      return [];
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `task-${created.length}`, status: 'OPEN', ...data };
        created.push({ id: row.id, data });
        return row;
      },
    },
    taskDependency: {
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      calls.push('transaction');
      return fn(tx);
    },
    workspace: {
      findFirst: async ({ where }: { where?: { id?: string } } = {}) =>
        ({ id: where?.id ?? CHECKER, name: 'a workspace' }),
      findMany: async () => [],
    },
    taskList: { findFirst: async () => ({ id: 'list-1' }), findMany: async () => [] },
    modelProvider: { findFirst: async () => ({ slug: 'custom' }), findMany: async () => [] },
    project: {
      findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      findMany: async () => [],
    },
    projectHandoffApproval: { findFirst: async () => null },
    session: { findFirst: async () => null },
    task: { count: async () => 0, findMany: async () => [] },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishTaskChanged: () => {},
    publishForUser: () => {},
  } as never);
  return { service, created, calls };
}

/** The shape the rule is about: settled by an independent verdict, with no work of its own. */
const subjectShape = (over: Partial<CreateTaskBatchItemDto> = {}): CreateTaskBatchItemDto => ({
  title: '完成门禁：X 通过独立 Claude QA',
  projectId: PROJECT,
  completionCriterion: 'VERIFICATION',
  completionPolicy: 'VERIFICATION_PASSED',
  ...over,
});

/** The body of a 400, or a failed assertion saying what arrived instead. Nest wraps a plain message
 *  into the same shape the structured refusals are thrown in, so one reader serves both. */
function refusalBody(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof BadRequestException, `expected a 400, got ${String(error)}`);
  const body = error.getResponse();
  assert.ok(typeof body === 'object' && body !== null, `400 without a structured body: ${body}`);
  return body as Record<string, unknown>;
}

// ---- the predicate ------------------------------------------------------------------------------

test('the rule reads the subject shape, not the word VERIFICATION', () => {
  const subject = {
    ref: 'gate',
    completionCriterion: 'VERIFICATION' as const,
    completionPolicy: 'VERIFICATION_PASSED' as const,
    verifiesTaskId: null,
    verifiesRef: null,
  };

  // Nothing in the call points at it: this is the row that can never settle.
  assert.equal(verificationSubjectUnpaired(subject, []), true);
  assert.equal(verificationSubjectUnpaired(subject, [{ ref: 'other' }]), true);
  // A sibling naming it by ref is the pairing, and the only thing that makes it paired.
  assert.equal(verificationSubjectUnpaired(subject, [{ ref: 'check', verifiesRef: 'gate' }]), false);
  // A row with no ref cannot be named by anything in the same call, so it is never paired.
  assert.equal(
    verificationSubjectUnpaired({ ...subject, ref: null }, [{ ref: 'check', verifiesRef: 'gate' }]),
    true,
  );

  // Not the shape: a verifier points at its subject, by id or by ref.
  assert.equal(verificationSubjectUnpaired({ ...subject, verifiesTaskId: SUBJECT_TASK }, []), false);
  assert.equal(verificationSubjectUnpaired({ ...subject, verifiesRef: 'gate' }, []), false);
  // A work row runs: "no work of its own" is the policy's axis, not the criterion's.
  assert.equal(verificationSubjectUnpaired({ ...subject, completionPolicy: 'MANUAL' }, []), false);
  // And a row settled by something else entirely is not this rule's business.
  assert.equal(
    verificationSubjectUnpaired({ ...subject, completionCriterion: 'EXECUTABLE' }, []), false,
  );
  assert.equal(
    verificationSubjectUnpaired({ ref: null }, []),
    false,
    'an undeclared row resolves to EVIDENCE_JUDGMENT, which is not a subject',
  );
});

test('the refusal names both ways out, and is the rule rather than a restatement of it', () => {
  const subject = {
    ref: 'gate',
    completionCriterion: 'VERIFICATION' as const,
    completionPolicy: 'VERIFICATION_PASSED' as const,
  };
  const refusal = verificationSubjectNeedsVerifierRefusal(subject, []);
  assert.ok(refusal, 'a subject nothing verifies must be refused');
  assert.equal(refusal.code, VERIFICATION_SUBJECT_NEEDS_VERIFIER_CODE);
  assert.equal(refusal.kind, 'REFUSAL');
  assert.equal(refusal.requiredAction, VERIFICATION_SUBJECT_NEEDS_VERIFIER_ACTION);
  // The remedy is what a caller can do in this call, and the second clause is the escape for a row
  // that does have work of its own.
  assert.match(refusal.message, /verification: \{ title, assigneeId \}/);
  assert.match(refusal.message, /completionPolicy MANUAL/);

  // Paired, a work row, and a verifier: no refusal, because the predicate said so.
  assert.equal(
    verificationSubjectNeedsVerifierRefusal(subject, [{ ref: 'check', verifiesRef: 'gate' }]), null,
  );
  assert.equal(
    verificationSubjectNeedsVerifierRefusal({ ...subject, completionPolicy: 'MANUAL' }, []), null,
  );
});

// ---- the single door ----------------------------------------------------------------------------

test('a single subject with no verifier is refused before the transaction opens', async () => {
  const { service, created, calls } = makeService();

  const body = refusalBody(await service.create(OWNER, subjectShape()).catch((e) => e));
  assert.equal(body.code, VERIFICATION_SUBJECT_NEEDS_VERIFIER_CODE);
  assert.equal(body.kind, 'REFUSAL');
  assert.equal(body.requiredAction, VERIFICATION_SUBJECT_NEEDS_VERIFIER_ACTION);

  // The half a rolled-back transaction cannot prove: nothing was even attempted.
  assert.deepEqual(created, [], 'a refused create writes no row at all');
  assert.deepEqual(calls, [], 'a refused create opens no transaction and takes no lock');
});

test('a single subject created with its verifier writes both rows in one call', async () => {
  const { service, created, calls } = makeService();

  const receipt = (await service.create(
    OWNER,
    subjectShape({
      verification: { title: '[VERIFY] 完成门禁：X 通过独立 Claude QA', assigneeId: CHECKER },
    }),
  )) as unknown as { id: string; verification: { id: string; status: string } };

  assert.deepEqual(created.map((row) => row.data.title), [
    '完成门禁：X 通过独立 Claude QA',
    '[VERIFY] 完成门禁：X 通过独立 Claude QA',
  ]);
  const [gateRow, checkRow] = created.map((row) => row.data);
  // The subject keeps the declaration it was written with, and gains no link of its own.
  assert.equal(gateRow.completionCriterion, 'VERIFICATION');
  assert.equal(gateRow.completionPolicy, 'VERIFICATION_PASSED');
  assert.equal(gateRow.verifiesTaskId, undefined);
  assert.equal(gateRow.projectId, PROJECT);
  // The check is a verifier: it points at the subject, and its criterion is the relation.
  assert.equal(checkRow.verifiesTaskId, receipt.id);
  assert.equal(checkRow.completionCriterion, 'VERIFICATION');
  // Its policy is left to the column's own default (MANUAL): a verifier IS work of its own, and the
  // only thing that makes it a check is the link back to the subject.
  assert.notEqual(checkRow.completionPolicy, 'VERIFICATION_PASSED');
  assert.equal(checkRow.projectId, PROJECT);
  assert.equal(checkRow.assigneeId, CHECKER);
  // One transaction for the pair, and the receipt says which row settles it.
  assert.equal(calls.filter((call) => call === 'transaction').length, 1);
  assert.equal(receipt.id, created[0].id);
  assert.deepEqual(receipt.verification, { id: created[1].id, status: 'OPEN' });
});

test('the sub-object is the surface of the batch path, not a second writer', async () => {
  const viaSingle = makeService();
  const viaBatch = makeService();

  await viaSingle.service.create(OWNER, subjectShape({ verification: { title: '[VERIFY] gate' } }));
  await viaBatch.service.createMany(OWNER, {
    tasks: [
      { ...subjectShape(), ref: 'pair-subject' },
      {
        title: '[VERIFY] gate',
        projectId: PROJECT,
        ref: 'pair-check',
        verifiesRef: 'pair-subject',
        completionCriterion: 'VERIFICATION',
      },
    ],
  });

  // The same two rows either way: the single door IS the batch write, not a copy of it that can
  // drift on the next field added to a task.
  assert.deepEqual(
    viaSingle.created.map((row) => row.data),
    viaBatch.created.map((row) => row.data),
  );
});

test('a task cannot be both the check and the subject that hands it a verifier', async () => {
  const { service, created, calls } = makeService();
  const error = await service
    .create(
      OWNER,
      subjectShape({ verifiesTaskId: SUBJECT_TASK, verification: { title: '[VERIFY] x' } }),
    )
    .catch((e) => e);

  assert.match(String(refusalBody(error).message), /cannot be used together/);
  assert.deepEqual(created, []);
  assert.deepEqual(calls, []);
});

// ---- the batch door -----------------------------------------------------------------------------

test('a plan whose subject nothing verifies is refused before the transaction opens', async () => {
  const { service, created, calls } = makeService();

  const body = refusalBody(
    await service
      .createMany(OWNER, { tasks: [subjectShape({ ref: 'gate' })] })
      .catch((e) => e),
  );
  assert.equal(body.code, VERIFICATION_SUBJECT_NEEDS_VERIFIER_CODE);
  assert.equal(body.itemIndex, 0, 'a batch refusal says which item it is about');

  assert.deepEqual(created, []);
  assert.deepEqual(calls, []);
});

test('the same plan is written whole once its check is an item of it', async () => {
  const { service, created } = makeService();

  const rows = await service.createMany(OWNER, {
    tasks: [
      { ...subjectShape(), ref: 'gate' },
      {
        title: '[VERIFY] 完成门禁：X',
        projectId: PROJECT,
        ref: 'check',
        verifiesRef: 'gate',
        completionCriterion: 'VERIFICATION',
      },
    ],
  });

  assert.equal(created.length, 2);
  assert.equal(created[1].data.verifiesTaskId, rows[0].id);
  assert.equal(rows[0].ref, 'gate');
  assert.equal(rows[1].ref, 'check');
});

test("a batch item cannot carry the single door's sub-object", async () => {
  const { service, created, calls } = makeService();

  const error = await service
    .createMany(OWNER, { tasks: [subjectShape({ verification: { title: '[VERIFY] x' } })] })
    .catch((e) => e);

  // Silently dropping it would file the very row this rule exists to refuse.
  assert.match(String(refusalBody(error).message), /verifiesRef/);
  assert.deepEqual(created, []);
  assert.deepEqual(calls, []);
});

test("a dry run reports the unpaired subject in the plan's own vocabulary, and writes nothing", async () => {
  const { service, created, calls } = makeService();

  const preview = await service.previewPlan(OWNER, {
    tasks: [subjectShape({ ref: 'gate' })],
    dryRun: true,
  });

  assert.equal(preview.refused, true);
  assert.equal(preview.wouldWrite, 0);
  assert.deepEqual(
    preview.findings
      .filter((finding) => finding.code === 'PLAN_VERIFICATION_SUBJECT_UNPAIRED')
      .map((finding) => [finding.index, finding.dimension, finding.severity]),
    [[0, 'HIERARCHY', 'REFUSE']],
  );
  assert.deepEqual(created, []);
  assert.deepEqual(calls, []);
});
