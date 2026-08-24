import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  COORDINATOR_WAKE_EVENTS,
  SETTLED_TASK_STATUSES,
  WAKE_KEY_VERSION,
  attemptBudgetSpentFact,
  attemptEndedUnsettledFact,
  criterionReadyFact,
  criterionSubjectId,
  isSettledTaskStatus,
  projectTasksSettledFact,
  settlementVersion,
  wakeIdempotencyKey,
} from './coordinator-wake';

/**
 * Unit T2's pure half: what a wake fact IS, and what makes two deliveries of one the same.
 *
 * Everything the database decides — one row per fact, a refusal releasing the key, the claim
 * happening before the authorization — is asserted against a real PostgreSQL in
 * `coordinator-wake.pg.spec.ts`, because a fake client cannot have a partial unique index.
 */

const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const TASK = '00000000-0000-7000-8000-0000000000b1';
const SESSION_ONE = '00000000-0000-7000-8000-0000000000c1';
const SESSION_TWO = '00000000-0000-7000-8000-0000000000c2';

test('the key is a total function of the fact and carries nothing else', () => {
  const fact = attemptEndedUnsettledFact({
    projectId: PROJECT,
    taskId: TASK,
    taskStatus: 'FAILED',
    sessionId: SESSION_ONE,
  })!;
  assert.equal(
    wakeIdempotencyKey(fact),
    `${WAKE_KEY_VERSION}:ATTEMPT_ENDED_UNSETTLED:TASK:${TASK}:${SESSION_ONE}`,
  );

  // `detail` is what a reader wants and what no decision may depend on: two facts that differ only
  // there are one fact. This is `project_blocker` BL7's rule, applied to the key it warns about.
  const noisier = { ...fact, detail: { taskStatus: 'OPEN', observedBy: 'somebody else' } };
  assert.equal(wakeIdempotencyKey(noisier), wakeIdempotencyKey(fact));

  // And the project is not in it either — the subject already names it or is a uuid.
  const elsewhere = { ...fact, projectId: '00000000-0000-7000-8000-0000000000a2' };
  assert.equal(wakeIdempotencyKey(elsewhere), wakeIdempotencyKey(fact));
});

test('two attempts on one task are two facts, and one attempt redelivered is one', () => {
  const first = attemptEndedUnsettledFact({
    projectId: PROJECT,
    taskId: TASK,
    taskStatus: 'FAILED',
    sessionId: SESSION_ONE,
  })!;
  const again = attemptEndedUnsettledFact({
    projectId: PROJECT,
    taskId: TASK,
    // The task's own status moved between the two deliveries of the SAME attempt's end. It is not
    // in the key, so this is still one fact — which is the point: the version is the attempt.
    taskStatus: 'OPEN',
    sessionId: SESSION_ONE,
  })!;
  const second = attemptEndedUnsettledFact({
    projectId: PROJECT,
    taskId: TASK,
    taskStatus: 'FAILED',
    sessionId: SESSION_TWO,
  })!;

  assert.equal(wakeIdempotencyKey(again), wakeIdempotencyKey(first));
  assert.notEqual(wakeIdempotencyKey(second), wakeIdempotencyKey(first));
});

test('a task that settled is not a fact anybody has to judge', () => {
  for (const status of SETTLED_TASK_STATUSES) {
    assert.equal(
      attemptEndedUnsettledFact({
        projectId: PROJECT,
        taskId: TASK,
        taskStatus: status,
        sessionId: SESSION_ONE,
      }),
      null,
      `${status} is settled, so the session ending on it is the ordinary end of a run`,
    );
  }
  // FAILED is deliberately NOT settled: it is the single most important thing to wake anybody for.
  assert.equal(isSettledTaskStatus('FAILED'), false);
  assert.ok(
    attemptEndedUnsettledFact({
      projectId: PROJECT,
      taskId: TASK,
      taskStatus: 'FAILED',
      sessionId: SESSION_ONE,
    }),
  );
});

test('an exhausted attempt wakes once, whichever dimension it crossed', () => {
  const wall = attemptBudgetSpentFact({
    projectId: PROJECT,
    taskId: TASK,
    sessionId: SESSION_ONE,
    dimension: 'WALL_CLOCK',
  });
  const steers = attemptBudgetSpentFact({
    projectId: PROJECT,
    taskId: TASK,
    sessionId: SESSION_ONE,
    dimension: 'COORDINATOR_STEERS',
  });
  // One attempt that crosses two lines has spent its budget once. Putting the dimension in the key
  // would wake the coordinator once per line, over one attempt that has already stopped.
  assert.equal(wakeIdempotencyKey(steers), wakeIdempotencyKey(wall));
  assert.deepEqual(wall.detail, { sessionId: SESSION_ONE, dimension: 'WALL_CLOCK' });

  // It is still a different fact from that attempt's END, because the event is in the key.
  const ended = attemptEndedUnsettledFact({
    projectId: PROJECT,
    taskId: TASK,
    taskStatus: 'OPEN',
    sessionId: SESSION_ONE,
  })!;
  assert.notEqual(wakeIdempotencyKey(ended), wakeIdempotencyKey(wall));
});

test('the settlement version is the (taskId, status) pairs and nothing else', () => {
  const tasks = [
    { taskId: 'b2', status: 'DONE' },
    { taskId: 'b1', status: 'CANCELLED' },
  ];
  // Row order is the planner's business, so it must not be the fact's identity.
  assert.equal(settlementVersion(tasks), settlementVersion([...tasks].reverse()));
  assert.match(settlementVersion(tasks), /^[0-9a-f]{64}$/);

  // A status that moved is a different world; anything else about the task is not in the digest at
  // all, which is the property `task.updated_at` could not have.
  assert.notEqual(
    settlementVersion([{ taskId: 'b1', status: 'DONE' }, { taskId: 'b2', status: 'DONE' }]),
    settlementVersion(tasks),
  );
  assert.notEqual(settlementVersion(tasks), settlementVersion(tasks.slice(0, 1)));
});

test('a project settles only when every task did, and never when it has none', () => {
  assert.equal(projectTasksSettledFact(PROJECT, []), null, 'an empty project has not finished');
  assert.equal(
    projectTasksSettledFact(PROJECT, [
      { taskId: 'b1', status: 'DONE' },
      { taskId: 'b2', status: 'FAILED' },
    ]),
    null,
    'a FAILED task is work in progress as far as this event is concerned',
  );

  const settled = projectTasksSettledFact(PROJECT, [
    { taskId: 'b1', status: 'DONE' },
    { taskId: 'b2', status: 'CANCELLED' },
  ])!;
  assert.equal(settled.subjectType, 'PROJECT');
  assert.equal(settled.subjectId, PROJECT);
  assert.equal(
    wakeIdempotencyKey(settled),
    `${WAKE_KEY_VERSION}:PROJECT_TASKS_SETTLED:PROJECT:${PROJECT}:${settled.subjectVersion}`,
  );

  // Reopening a task and settling it DIFFERENTLY is a new fact, and wakes again.
  const later = projectTasksSettledFact(PROJECT, [
    { taskId: 'b1', status: 'DONE' },
    { taskId: 'b2', status: 'DONE' },
  ])!;
  assert.notEqual(wakeIdempotencyKey(later), wakeIdempotencyKey(settled));
});

test('a criterion is ready only when every task serving it is DONE', () => {
  const key = 'b3f4c000a5e9d01bd5cfa6078b57cdb0';
  assert.equal(criterionReadyFact(PROJECT, key, []), null);
  assert.equal(
    criterionReadyFact(PROJECT, key, [
      { taskId: 'b1', status: 'DONE' },
      { taskId: 'b2', status: 'CANCELLED' },
    ]),
    null,
    'a cancelled task serves no criterion — settled is not the predicate here',
  );

  const ready = criterionReadyFact(PROJECT, key, [{ taskId: 'b1', status: 'DONE' }])!;
  assert.equal(ready.subjectId, criterionSubjectId(PROJECT, key));
  // The criterion key is a content hash of the criterion's words, so two projects stating the same
  // criterion share it. The project id in the subject is what keeps them two facts.
  const elsewhere = criterionReadyFact('00000000-0000-7000-8000-0000000000a2', key, [
    { taskId: 'b1', status: 'DONE' },
  ])!;
  assert.notEqual(wakeIdempotencyKey(elsewhere), wakeIdempotencyKey(ready));
});

test('the events this unit knows about are the four the migration accepts', () => {
  const sql = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/0173_project_coordinator_wake/migration.sql'),
    'utf8',
  );
  const check = /"event" IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(check, 'migration 0173 no longer constrains the event column');
  const accepted = [...check[1].matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]).sort();
  assert.deepEqual(
    accepted,
    [...COORDINATOR_WAKE_EVENTS].sort(),
    'a wake event was added in one place only — the CHECK and the closed set have to move together',
  );
});

/**
 * Project acceptance criterion 3, as a grep: the wake path is not allowed to have a clock.
 *
 * "Wake the coordinator periodically so it can have a think" is the loop this whole unit replaces,
 * and it comes back because it is convenient. The subject is the two production files this unit
 * adds, checked verbatim and not with comments stripped — they name no timer even in prose, so
 * `grep -n 'setInterval\|@Interval\|@Cron' src/projects/coordinator-wake*.ts` (minus this spec,
 * which has to spell what it forbids) is empty on a plain read.
 */
test('nothing on the wake path is reachable from a timer', () => {
  const HERE = path.resolve(__dirname, '../..', 'src/projects');
  for (const file of ['coordinator-wake.ts', 'coordinator-wake.service.ts']) {
    const source = readFileSync(path.join(HERE, file), 'utf8');
    for (const forbidden of ['setInterval', '@Interval', '@Cron']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} reaches for ${forbidden} — a wake is a committed fact, never a clock`,
      );
    }
  }
});
