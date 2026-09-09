import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  COORDINATOR_WAKE_EVENTS,
  COORDINATOR_WAKE_STATUSES,
  RETIRED_COORDINATOR_WAKE_EVENTS,
  SETTLED_TASK_STATUSES,
  WAKE_KEY_VERSION,
  attemptBudgetSpentFact,
  attemptEndedUnsettledFact,
  criterionReadyFact,
  criterionSubjectId,
  isSettledTaskStatus,
  projectAcceptanceLandedFact,
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

/** One stated criterion as the two project-scoped facts report it, with the two dimensions moved. */
function reported(key: string, satisfied: boolean, landing: 'LANDED' | 'UNKNOWN') {
  return { key, text: `条件 ${key}`, satisfied, landing, serving: [] };
}

const SETTLED_PAIR = [
  { taskId: 'b1', status: 'DONE' },
  { taskId: 'b2', status: 'CANCELLED' },
];

test('acceptance lands only when every stated criterion is satisfied AND on the branch', () => {
  assert.equal(
    projectAcceptanceLandedFact(PROJECT, [], [reported('c1', true, 'LANDED')]), null,
    'an empty project has not finished its work — it has not been given any',
  );
  assert.equal(
    projectAcceptanceLandedFact(
      PROJECT,
      [{ taskId: 'b1', status: 'DONE' }, { taskId: 'b2', status: 'FAILED' }],
      [reported('c1', true, 'LANDED')],
    ),
    null,
    'a FAILED task is work in progress here too',
  );
  assert.equal(
    projectAcceptanceLandedFact(PROJECT, SETTLED_PAIR, []), null,
    '[].every is vacuously true: "these zero conditions express your goal" is unanswerable',
  );
  assert.equal(
    projectAcceptanceLandedFact(
      PROJECT, SETTLED_PAIR,
      [reported('c1', true, 'LANDED'), reported('c2', false, 'LANDED')],
    ),
    null,
    'a criterion nothing backs is not one to ask about',
  );
  assert.equal(
    projectAcceptanceLandedFact(
      PROJECT, SETTLED_PAIR,
      [reported('c1', true, 'LANDED'), reported('c2', true, 'UNKNOWN')],
    ),
    null,
    'one criterion off the branch is enough — the fact admits no partial landing',
  );

  const landed = projectAcceptanceLandedFact(
    PROJECT, SETTLED_PAIR,
    [reported('c1', true, 'LANDED'), reported('c2', true, 'LANDED')],
  )!;
  assert.equal(landed.event, 'PROJECT_ACCEPTANCE_LANDED');
  assert.equal(landed.subjectType, 'PROJECT');
  assert.equal(landed.subjectId, PROJECT);
  assert.equal(
    wakeIdempotencyKey(landed),
    `${WAKE_KEY_VERSION}:PROJECT_ACCEPTANCE_LANDED:PROJECT:${PROJECT}:${landed.subjectVersion}`,
  );
  // The roster's ORDER is the query planner's business, so it is not part of the identity.
  assert.equal(
    wakeIdempotencyKey(projectAcceptanceLandedFact(
      PROJECT, SETTLED_PAIR,
      [reported('c2', true, 'LANDED'), reported('c1', true, 'LANDED')],
    )!),
    wakeIdempotencyKey(landed),
  );
});

test('the settled fact and the landed one are two facts about one project, never one', () => {
  const criteria = [reported('c1', true, 'LANDED'), reported('c2', true, 'LANDED')];
  const settled = projectTasksSettledFact(PROJECT, SETTLED_PAIR, criteria)!;
  const landed = projectAcceptanceLandedFact(PROJECT, SETTLED_PAIR, criteria)!;

  // Same subject, same task set, two keys. A judgment already spent on the settled fact therefore
  // cannot spend the card's, which is the whole repair: the settled project reached its judgment
  // while one criterion was off the branch, and the card is still available afterwards.
  assert.equal(settled.subjectId, landed.subjectId);
  assert.notEqual(wakeIdempotencyKey(settled), wakeIdempotencyKey(landed));
  assert.notEqual(settled.subjectVersion, landed.subjectVersion);

  // And the version the card is keyed on is NOT the task settlement: the same settled task set
  // with a different roster is a different question to ask. This is the assertion that goes red if
  // the landing digest is ever dropped back to `settlementVersion`.
  const half = projectAcceptanceLandedFact(PROJECT, SETTLED_PAIR, [
    reported('c1', true, 'LANDED'),
  ])!;
  assert.notEqual(half.subjectVersion, landed.subjectVersion,
    'a roster that lost a criterion derives the key the fuller one already used');
  assert.notEqual(landed.subjectVersion, settled.subjectVersion);
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

test('the events this unit knows about are exactly those the latest migration accepts', () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      '../../prisma/migrations/0250_criteria_decision_pending_wake/migration.sql',
    ),
    'utf8',
  );
  const check = /"event" IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(check, 'migration 0250 no longer constrains the event column');
  const accepted = [...check[1].matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]).sort();
  assert.deepEqual(
    accepted,
    [...COORDINATOR_WAKE_EVENTS, ...RETIRED_COORDINATOR_WAKE_EVENTS].sort(),
    'a wake event was added in one place only — the CHECK, the closed set and the retired list '
    + 'have to move together',
  );
  // The retired half is retired: nothing in this unit may still emit one of those spellings.
  const here = path.resolve(__dirname, '../..', 'src/projects');
  const source = readFileSync(path.join(here, 'coordinator-wake.ts'), 'utf8');
  const emitting = readFileSync(path.join(here, 'completion-input.ts'), 'utf8');
  for (const retired of RETIRED_COORDINATOR_WAKE_EVENTS) {
    assert.doesNotMatch(emitting, new RegExp(`event: '${retired}'`),
      `${retired} is history and must not be written by a current path`);
    assert.ok(source.includes(retired), 'a retired spelling is named where it is retired');
  }
});

test('the ends this unit knows about are exactly those the latest migration accepts', () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      '../../prisma/migrations/0243_coordinator_wake_delivered/migration.sql',
    ),
    'utf8',
  );
  const check = /"status" IN \(([^)]*)\)/.exec(sql);
  assert.ok(check, 'migration 0243 no longer constrains the status column');
  const accepted = [...check[1].matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]).sort();
  assert.deepEqual(
    accepted,
    [...COORDINATOR_WAKE_STATUSES].sort(),
    'a wake terminal was added in one place only — the CHECK and the closed set have to move '
    + 'together, exactly as the event set and its own CHECK do',
  );

  // A terminal that may NAME a session is a second claim, and the same migration states it: two
  // ways to reach one (0175's judgment session, 0243's standing conversation) and no third.
  const named = /"session_id" IS NULL OR "status" IN \(([^)]*)\)/.exec(sql);
  assert.ok(named, 'migration 0243 no longer says which ends may name a session');
  assert.deepEqual(
    [...named[1].matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]).sort(),
    ['DELIVERED', 'SESSION_OPENED'],
  );
  // And the pointer's uniqueness is now partial over the first of them: many facts may name the
  // one standing conversation, no two may name one judgment session.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX[\s\S]*?"project_coordinator_wake_session_id_key"[\s\S]*?WHERE "status" = 'SESSION_OPENED'/,
  );
});

/**
 * Project acceptance criterion 3, as a grep: the fact reducer is not allowed to own a clock.
 *
 * "Wake the coordinator periodically so it can have a think" is the loop this whole unit replaces,
 * and it comes back because it is convenient. The subject is the two production files this unit
 * adds. A separately supervised courier may call it from a durable retry schedule; these files
 * must remain deterministic and cannot invent their own interval or scheduler.
 */
test('the wake fact reducer owns no timer', () => {
  const HERE = path.resolve(__dirname, '../..', 'src/projects');
  for (const file of ['coordinator-wake.ts', 'coordinator-wake.service.ts']) {
    const source = readFileSync(path.join(HERE, file), 'utf8');
    for (const forbidden of ['setInterval', '@Interval', '@Cron']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} owns ${forbidden} — a wake is a committed fact, not a clock`,
      );
    }
  }
});
