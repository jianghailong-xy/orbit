import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  TASK_CRITERION_CHANGE_REQUIRED_ACTION,
  TASK_CRITERION_CHANGE_UNEXPLAINED_CODE,
  readTaskCriterionChange,
} from './task-completion-criterion-change-guard';
import { TASK_COMPLETION_CRITERIA } from './task-completion-criterion';
import { TasksService } from './tasks.service';

/**
 * Changing what counts as done costs an explanation, and the explanation is kept.
 *
 * Orbit's two doors onto completion were tightened in opposite directions. Deciding a task's
 * evidence is fail-closed and unbypassable; REWRITING the criterion that decision answers to was
 * free. On 2026-09-05 a run refused by the first door walked through the second — two task_update
 * calls moved two tasks to EXECUTABLE, and afterwards the only column that had moved was
 * `updatedAt`. That change was agreed with the account owner, and nothing in the mechanism either
 * required the agreement or recorded it.
 *
 * What this file pins is a PRICE, not a wall. A mis-declared criterion is ordinary — the task that
 * precedes this one exists to repair one — so the change stays available to everybody it was
 * available to before, and gains one requirement: say why, in the same request. The reason is then
 * stored beside the criterion being left behind, where `task_get` returns it.
 */

const OWNER = '00000000-0000-7000-8000-00000000000a';
const TASK = '00000000-0000-7000-8000-00000000000b';
const SUBJECT = '00000000-0000-7000-8000-00000000000c';

/** Every field `loadDetail`'s include produces, so `get` and `update` read one in-memory row. */
function storedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK,
    ownerId: OWNER,
    title: 'Wire the thing',
    description: null,
    status: 'OPEN',
    projectId: null,
    listId: null,
    parentTaskId: null,
    labels: [],
    acceptanceCriteria: 'The wiring is right.',
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    acceptanceTimeoutSeconds: null,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    completionCriterionOverrideReason: null,
    completionPolicy: 'MANUAL',
    isForeman: false,
    verifiesTaskId: null,
    verdict: null,
    verdictRevision: 0n,
    supersededByTaskId: null,
    supersededAt: null,
    terminalReason: null,
    creatorSessionId: null,
    assignee: null,
    comments: [],
    attachments: [],
    sessions: [],
    creatorSession: null,
    dependsOn: [],
    dependedOnBy: [],
    supersedes: [],
    ...overrides,
  };
}

/**
 * One mutable row, driven through the real service.
 *
 * The point of going through `TasksService.update` rather than calling the guard directly is that
 * the door has to be ON THE WRITE PATH: a pure function that refuses in isolation while the service
 * writes anyway is the exact shape of the hole this closes. `writes` is what the database would
 * have been asked to change, so "the task was not written" is an assertion and not an inference.
 */
function updateFixture(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = storedTask(overrides);
  const writes: Array<Record<string, unknown>> = [];
  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    task: {
      findFirst: async () => ({ ...row }),
      findMany: async () => [],
      count: async () => 0,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const applied = Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        );
        writes.push(applied);
        Object.assign(row, applied);
        return { ...row };
      },
    },
    taskDependency: { findMany: async () => [] },
    taskCompletionEvidence: { findFirst: async () => null },
    taskList: { findMany: async () => [] },
    taskListEvent: { upsert: async () => ({}) },
    project: { findFirst: async () => null, findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    session: { findFirst: async () => null },
    workspace: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser() {}, publishTaskChanged() {},
  } as never);
  return {
    service,
    writes,
    row,
    update: (dto: Record<string, unknown>) => service.update(OWNER, TASK, dto as never),
    read: () => service.get(OWNER, TASK) as Promise<Record<string, unknown>>,
  };
}

/** The refusal body, or a failure that says what came back instead. */
async function refusalFrom(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let thrown: unknown;
  try {
    await call();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, 'the write was accepted; the change door did not refuse it');
  assert.ok(
    thrown instanceof BadRequestException,
    `expected a refusal, got ${(thrown as Error)?.constructor?.name}: ${(thrown as Error)?.message}`,
  );
  return (thrown as BadRequestException).getResponse() as Record<string, unknown>;
}

// ── 1. Creation is not a change ───────────────────────────────────────────────────────────────

/**
 * Declaring a criterion while creating a task states the contract for the first time; there is no
 * earlier one to have moved away from, and no reason to demand. All three peers, because a door
 * that quietly made one of them harder to declare would push callers onto the other two.
 */
test('declaring any criterion at creation is untouched by the change door', async () => {
  for (const criterion of TASK_COMPLETION_CRITERIA) {
    const rows: Array<Record<string, unknown>> = [];
    const task = {
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: TASK, status: 'OPEN', creatorSessionId: null, ...data };
        rows.push(row);
        return row;
      },
    };
    const prisma = {
      task,
      taskDependency: { createMany: async () => ({ count: 0 }) },
      project: { findMany: async () => [] },
      workspace: { findMany: async () => [] },
      modelProvider: { findMany: async () => [] },
      projectHandoffApproval: { findFirst: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        task, taskDependency: { createMany: async () => ({ count: 0 }) },
        $queryRaw: async () => [{ id: OWNER }],
      }),
    };
    const service = new TasksService(prisma as never, {} as never, {
      publishForUser: () => undefined,
    } as never);

    const created = await service.create(OWNER, {
      title: `declare ${criterion}`,
      completionCriterion: criterion,
      ...(criterion === 'EXECUTABLE'
        ? { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 }
        : {}),
      ...(criterion === 'VERIFICATION' ? { completionPolicy: 'VERIFICATION_PASSED' } : {}),
    } as never);

    assert.equal(created.completionCriterion, criterion, `${criterion} was declared as asked`);
    // No reason was sent and none was invented: creation writes no change record, so nothing
    // later reads this task as having been moved off a criterion it never had.
    assert.equal(created.completionCriterionOverrideReason ?? null, null, criterion);
    assert.equal(readTaskCriterionChange(created.completionCriterionOverrideReason), null);
    assert.equal(rows.length, 1, `${criterion} was written exactly once`);
  }
});

// ── 2. An unexplained change is refused, and writes nothing ───────────────────────────────────

test('changing an existing task\'s criterion with no reason is refused and writes nothing', async () => {
  const f = updateFixture();

  const refusal = await refusalFrom(() => f.update({
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  }));

  assert.equal(refusal.code, TASK_CRITERION_CHANGE_UNEXPLAINED_CODE);
  assert.equal(refusal.kind, 'REFUSAL');
  // The remedy, in the shape the doors beside this one answer with: a refusal that does not name
  // one is a wall, and a wall here is what the whole change is meant not to build.
  assert.equal(refusal.requiredAction, TASK_CRITERION_CHANGE_REQUIRED_ACTION);
  assert.equal(refusal.reasonField, 'completionCriterionOverrideReason');
  assert.deepEqual({ from: refusal.from, to: refusal.to },
    { from: 'EVIDENCE_JUDGMENT', to: 'EXECUTABLE' });

  // Refused BEFORE the transaction: not one column of the task moved, including the acceptance
  // pair the same request carried.
  assert.deepEqual(f.writes, []);
  assert.equal(f.row.completionCriterion, 'EVIDENCE_JUDGMENT');
  assert.equal(f.row.acceptanceCommand, null);
});

/**
 * The synonym, which is what makes this a door rather than a spelling rule.
 *
 * `EXECUTABLE` is reachable without ever naming it: sending the acceptance pair alone derives it.
 * A guard that watched only `dto.completionCriterion` would refuse the word and wave the identical
 * outcome through, and the cheapest path around completion would simply have moved one field over.
 */
test('deriving a different criterion from the acceptance pair alone is the same change', async () => {
  const f = updateFixture();

  const refusal = await refusalFrom(() => f.update({
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
  }));

  assert.equal(refusal.code, TASK_CRITERION_CHANGE_UNEXPLAINED_CODE);
  assert.deepEqual({ from: refusal.from, to: refusal.to },
    { from: 'EVIDENCE_JUDGMENT', to: 'EXECUTABLE' });
  assert.deepEqual(f.writes, []);
});

// ── 3. Explained, it happens — and stays readable ─────────────────────────────────────────────

test('the same change with a reason is made, and what it left plus why is read back', async () => {
  const f = updateFixture();
  const reason = 'This task has no project, so EVIDENCE_JUDGMENT had no live standard to judge '
    + 'against; the account owner agreed to settle it on the acceptance command instead.';

  const updated = await f.update({
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    completionCriterionOverrideReason: `  ${reason}  `,
  });

  // It happened. The door is a price, not a prohibition.
  assert.equal(updated.completionCriterion, 'EXECUTABLE');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].completionCriterion, 'EXECUTABLE');

  // And it is legible afterwards, which is the half `updatedAt` could never carry: the criterion
  // this task was moved OFF, the one it landed on, and the sentence somebody had to write.
  const read = await f.read();
  assert.deepEqual(read.completionCriterionChange, {
    from: 'EVIDENCE_JUDGMENT', to: 'EXECUTABLE', reason,
  });
  assert.equal(read.completionCriterion, 'EXECUTABLE');
  // Stored on the row itself, not derived from a second source, so any reader of the column sees
  // it — the parsed view above is a convenience over this one string.
  assert.equal(
    read.completionCriterionOverrideReason,
    `[criterion-change EVIDENCE_JUDGMENT->EXECUTABLE] ${reason}`,
  );
});

/** Every direction stays open: this must never become a one-way ratchet onto one criterion. */
test('the change is available in both directions, at the same price', async () => {
  const f = updateFixture({
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  });

  await refusalFrom(() => f.update({
    completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
  }));

  await f.update({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    completionCriterionOverrideReason: 'The command proved nothing about the question asked.',
  });

  const read = await f.read();
  assert.equal(read.completionCriterion, 'EVIDENCE_JUDGMENT');
  assert.deepEqual(read.completionCriterionChange, {
    from: 'EXECUTABLE',
    to: 'EVIDENCE_JUDGMENT',
    reason: 'The command proved nothing about the question asked.',
  });
});

// ── 4. Writing the value it already has is not a change ───────────────────────────────────────

/**
 * Restating a criterion is how idempotent clients write. Questioning it would tax every replayed
 * PATCH for a change nobody made, and would teach callers to keep a stock sentence on hand — which
 * is how an audit column fills up with prose that means nothing.
 */
test('re-sending the criterion a task already carries is not questioned', async () => {
  const f = updateFixture();

  const updated = await f.update({ completionCriterion: 'EVIDENCE_JUDGMENT', title: 'Renamed' });

  assert.equal(updated.completionCriterion, 'EVIDENCE_JUDGMENT');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].title, 'Renamed');
  // Nothing was recorded, because nothing changed.
  const read = await f.read();
  assert.equal(read.completionCriterionOverrideReason ?? null, null);
  assert.equal(read.completionCriterionChange, null);
});

/** An edit that never mentions the completion declaration is likewise none of this door's business. */
test('an edit that does not touch the declaration passes untouched', async () => {
  const f = updateFixture();

  await f.update({ title: 'Only the title' });

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].completionCriterion, undefined);
});

/**
 * The record has to survive writes that are not about it.
 *
 * Attaching a verifier role clears this column, because audit prose written for the criterion a
 * task used to carry stops describing the row. A change record never stops describing it — it is
 * the account of how this task came to carry what it carries — so a role attachment is not a
 * licence to erase it. Reachable without any criterion change: a VERIFICATION subject that gained
 * its criterion through the door above, later pointed at what it checks.
 */
test('attaching a verifier role does not erase a stored change record', async () => {
  const f = updateFixture({
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    completionCriterionOverrideReason:
      '[criterion-change EVIDENCE_JUDGMENT->VERIFICATION] no session was free to decide it',
  });

  await f.update({ verifiesTaskId: SUBJECT });

  const read = await f.read();
  assert.deepEqual(read.completionCriterionChange, {
    from: 'EVIDENCE_JUDGMENT',
    to: 'VERIFICATION',
    reason: 'no session was free to decide it',
  });
});

// ── 5. Blank is not a reason ──────────────────────────────────────────────────────────────────

/**
 * The empty string is the shape a caller gets for free — an unset shell variable, a cleared input,
 * a field defaulted to '' — so accepting it would make the whole door optional by accident rather
 * than on purpose. Whitespace is the same value typed by hand.
 */
test('a blank or whitespace-only reason is not a reason', async () => {
  for (const reason of ['', '   ', '\t\n  \n']) {
    const f = updateFixture();

    const refusal = await refusalFrom(() => f.update({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      completionCriterionOverrideReason: reason,
    }));

    assert.equal(refusal.code, TASK_CRITERION_CHANGE_UNEXPLAINED_CODE,
      `${JSON.stringify(reason)} was accepted as an explanation`);
    assert.equal(refusal.requiredAction, TASK_CRITERION_CHANGE_REQUIRED_ACTION);
    assert.deepEqual(f.writes, []);
    assert.equal(f.row.completionCriterion, 'EVIDENCE_JUDGMENT');
  }
});

// ── The record's own reading rules ────────────────────────────────────────────────────────────

/**
 * The change is stored in `completion_criterion_override_reason` rather than in a new column: that
 * column already means "audit prose about why this task carries the criterion it does", and a
 * second one would cost a migration, a DB-write inventory entry and a pass over the censuses that
 * enumerate this table. The marker is what keeps the two uses apart, and both criteria are read
 * back through the enum so free text shaped like a record cannot report a criterion nothing can
 * declare.
 */
test('only a well-formed record reads back as a change', () => {
  assert.deepEqual(
    readTaskCriterionChange('[criterion-change VERIFICATION->EXECUTABLE] the verifier never came'),
    { from: 'VERIFICATION', to: 'EXECUTABLE', reason: 'the verifier never came' },
  );
  // Ordinary creation prose — including prose that talks about criteria — is not a change record.
  assert.equal(readTaskCriterionChange(null), null);
  assert.equal(readTaskCriterionChange('EVIDENCE_JUDGMENT is deliberate here'), null);
  assert.equal(readTaskCriterionChange('[criterion-change EVIDENCE_JUDGMENT->EXECUTABLE]'), null);
  assert.equal(readTaskCriterionChange('[criterion-change MANUAL->EXECUTABLE] not a criterion'),
    null);
});
