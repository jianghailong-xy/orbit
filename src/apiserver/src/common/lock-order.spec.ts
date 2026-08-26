import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { LOCK_ORDER, LOCK_ORDER_COMPATIBLE, LOCK_ORDER_EXCEPTIONS, orderedIds } from './lock-order';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const tasksService = read('src/tasks/tasks.service.ts');
const taskListsService = read('src/task-lists/task-lists.service.ts');
const runnerApi = read('src/runner-api/runner-api.controller.ts');
const workspacesService = read('src/workspaces/workspaces.service.ts');
const dispatchBoundary = read('prisma/migrations/0122_project_dispatch_boundary/migration.sql');
const acceptanceRun = read('prisma/migrations/0127_project_acceptance_run/migration.sql');
const acceptanceOnly = read('prisma/migrations/0178_project_done_gate_acceptance_only/migration.sql');
const dependencyRevision = read('prisma/migrations/0132_task_dependency_revision/migration.sql');

/**
 * Every statement in this repo that writes a `task` or `task_dependency` row, and what each one
 * does about the canonical lock order.
 *
 * This is the list the acceptance criteria calls a static inventory, and it is checked BOTH ways:
 * the scan below finds every write statement in the two services and fails on one that is not
 * here, and each entry's `holds` strings are asserted to appear in the method they claim to be in.
 * So a new Task write cannot be added without stating its lock plan, and a plan cannot be deleted
 * without the entry that names it going red.
 *
 * `holds` is what the method takes ahead of its writes; `note` is why that is the right set.
 */
const TASK_WRITE_SOURCES: ReadonlyArray<{
  file: 'tasks.service.ts' | 'task-lists.service.ts';
  method: string;
  statements: string[];
  holds: string[];
  note: string;
}> = [
  {
    file: 'tasks.service.ts',
    method: 'linkSupersededBy',
    statements: ['UPDATE "task"'],
    holds: ['await this.lockTaskForSupersessionWrite(tx, predecessorId);'],
    note:
      'The predecessor\'s retirement, reached from `create` and from `update`. Its own rank-50 lock ' +
      'is NOWAIT rather than blocking, which is the one place in this inventory where a lock is ' +
      'declined rather than waited for: the caller already holds the project (rank 40), so waiting ' +
      'here for a dispatch that holds the task and wants the project would be the cycle. Ranks 10 ' +
      'and 40 are taken by both callers before this runs.',
  },
  {
    file: 'tasks.service.ts',
    method: 'create',
    statements: ['task.create', 'taskDependency.createMany'],
    holds: [
      'await lockTaskLists(tx, [dto.listId]);',
      'await this.preLockCreatorSessions(tx, [sessionId], [dto.supersedesTaskId]);',
      'if (dto.supersedesTaskId && dto.projectId) {',
      'await this.refenceProjectScope(',
    ],
    note:
      'One INSERT, and it is inside the transaction now even when the create names no link — the ' +
      'unlocked `task.create` fallback is gone. Rank 10 only when it links (a plain create must ' +
      'not queue behind a DAG rewrite); 20 and 30 always, ahead of the INSERT whose foreign keys ' +
      'would otherwise take them mid-write, and rank 30 covers the PREDECESSOR\'s creator Session ' +
      'too when this create retires one, because that is a second `task` row this transaction ' +
      'writes. Rank 40 only in that same case: a plain create needs none, because the only `task` ' +
      'row it holds when project_acceptance_task_fact takes the project is one no other ' +
      'transaction can see, so it can never be the holding side of a project/task inversion — but ' +
      'the predecessor IS visible, so a supersession takes the project first.' +
      ' Unit L3 adds one more taker at that same rank 40, in the same mode and the same UUID order: the effect-time scope fence, which re-locks and re-reads the project a coordinator write was admitted under so a rotation cannot commit inside the window between the decision and the row. Same rank, same mode, no new edge.' +
      ' Unit L4 widens that one pass to every project the plan was ADMITTED against — the target, the scope a declared crossing derives its authority from, and the far end of every cross-project edge — and adds rank 15 (workspace, model_provider) ahead of the lists, because a plan is refused when its assignee is deleted or its provider disabled and both of those are non-key updates the FK lock does not conflict with.',
  },
  {
    file: 'tasks.service.ts',
    // Unit L7 split the public entry point from the pass that writes: `createMany` and
    // `previewPlan` both call `createManyPass`, which is where the locks and the rows are. The
    // inventory names the writer, not the name a caller types.
    method: 'createManyPass',
    statements: ['task.create', 'taskDependency.createMany'],
    holds: [
      'await this.lockDependencyGraph(tx, ownerId);',
      'lockTaskLists(tx, items.map((item) => item.listId))',
      'await this.preLockCreatorSessions(',
      'items.map((item) => item.supersedesTaskId),',
      'tx, ownerId, creatorSessionId, scopeWorld, scopeFences,',
      'await this.lockPlanExecutionIdentity(',
    ],
    note:
      'Rank 10 unconditionally: a batch writes several `task` rows in item order, which is not an ' +
      'order any other writer shares. Then 20 and 30, once for the whole batch — rank 30 over the ' +
      'creating Session AND every predecessor this batch retires, in one ordered statement.' +
      ' Unit L3 adds one more taker at that same rank 40, in the same mode and the same UUID order: the effect-time scope fence, which re-locks and re-reads the project a coordinator write was admitted under so a rotation cannot commit inside the window between the decision and the row. Same rank, same mode, no new edge.',
  },
  {
    file: 'tasks.service.ts',
    method: 'signoff',
    statements: ['task.update'],
    holds: [
      'await lockOwnerTaskGraph(tx, ownerId);',
      'FOR NO KEY UPDATE`;',
      'FOR UPDATE`;',
    ],
    note:
      'Rank 10 serializes graph/project moves; rank 40 locks the task\'s project when present; ' +
      'rank 50 locks the task before the rank-60 signoff/blocker children. The final status write ' +
      'targets that already-held row and only advances its rank-70 dispatch epoch, so event, ' +
      'blocker resolution and derived DONE commit as one descending unit.',
  },
  {
    file: 'tasks.service.ts',
    method: 'update',
    statements: [
      'task.update',
      'UPDATE "task"',
      'task.update',
      'task.updateMany',
      'taskDependency.deleteMany',
      'taskDependency.createMany',
    ],
    holds: [
      'if (restructures) await this.lockDependencyGraph(tx, ownerId);',
      'await lockTaskLists(tx, [dto.listId]);',
      'if (rewritesTaskRow) await this.preLockCreatorSessions(tx, [], [id]);',
      'const acceptanceProjects = touchesAcceptanceFacts || supersession',
      'tx, ownerId, actingSessionId, scopeWorld, [scopeFence], acceptanceProjects,',
    ],
    note:
      'The only Task write that can need all four ranks, and each is conditional on the write ' +
      'actually reaching that relation: 10 when it restructures, 20 when it re-files, 30 when it ' +
      'writes the task row twice (a supersession, which is its own statement beside task.update), ' +
      '40 when it names a column project_acceptance_task_fact_update is declared over. The N11 ' +
      'verdict path locks verifier and subject together at rank 50 before its final subject ' +
      'task.updateMany, then writes only rank-60 judgment facts.' +
      ' Unit L3 adds one more taker at that same rank 40, in the same mode and the same UUID order: the effect-time scope fence, which re-locks and re-reads the project a coordinator write was admitted under so a rotation cannot commit inside the window between the decision and the row. Same rank, same mode, no new edge. An agent edit inside a project therefore takes the ' +
      'transaction branch it used to skip: a fence outside the transaction it fences is one the ' +
      'rotation can commit past.',
  },
  {
    file: 'tasks.service.ts',
    method: 'fileVerification',
    statements: ['task.upsert', 'task.create'],
    holds: [],
    note:
      'A bare legacy INSERT, or N11\'s deterministic-id upsert whose conflict branch changes no ' +
      'columns. Neither has a creator Session or links. Same argument as create\'s rank-40 case: ' +
      'the new row is invisible to everyone else; replay touches only the already-identical row.',
  },
  {
    file: 'tasks.service.ts',
    method: 'dispatchStalledListForemen',
    statements: ['task.create'],
    holds: [],
    note: 'Identical shape to fileVerification: one INSERT, no links, no creator Session.',
  },
  {
    file: 'tasks.service.ts',
    method: 'applyDag',
    statements: ['taskDependency.deleteMany', 'taskDependency.createMany'],
    holds: ['await this.lockDependencyGraph(tx, ownerId);'],
    note:
      'Rank 10 and nothing else since 0132. A restructure writes only edges, and an edge write no ' +
      'longer re-writes its dependent Task, so there is no second write of a task row to ' +
      're-check task_creator_session_id_fkey against and no creator Session to pre-lock. The ' +
      'dispatch boundary it used to buy is task_dependency_revision, advanced at rank 70.',
  },
  {
    file: 'tasks.service.ts',
    method: 'addDependency',
    statements: ['taskDependency.create'],
    holds: ['await this.lockDependencyGraph(tx, ownerId);'],
    note: 'Rank 10 for the cycle check. The INSERT itself advances the revision at rank 70.',
  },
  {
    file: 'tasks.service.ts',
    method: 'removeDependency',
    statements: ['taskDependency.deleteMany'],
    holds: ['await this.lockDependencyGraph(tx, ownerId);'],
    note: 'The DELETE advances the same revision row as the INSERT, so it takes the same locks.',
  },
  {
    file: 'tasks.service.ts',
    method: 'deleteAndStopRuns',
    statements: ['task.deleteMany'],
    holds: [
      'await this.lockDependencyGraph(tx, ownerId);',
      'FROM "session"',
      'FOR NO KEY UPDATE`;',
      'FOR UPDATE`;',
    ],
    note:
      'The order\'s one declared exception (LOCK_ORDER_EXCEPTIONS): the task lock has to precede ' +
      'the run scan, so the cascade\'s `session` write is a rank-30 lock taken from inside rank 50. ' +
      'The attached runs are pre-locked at rank 30 and the projects at rank 40 so the ordinary ' +
      'case is in order, and rank 10 keeps any other Task write out of the race entirely.',
  },
  {
    file: 'tasks.service.ts',
    method: 'consumeRunAt',
    statements: ['task.updateMany'],
    holds: [],
    note:
      'One row, one statement, and `run_at` is in no trigger\'s column list — no project lock, no ' +
      'session lock, nothing to order. A conditional CAS on the row it names.',
  },
  {
    file: 'tasks.service.ts',
    method: 'clearFailedForRetry',
    statements: ['task.updateMany'],
    holds: [],
    note:
      'RESIDUAL. One row, one statement, but it writes `status`, so an AFTER trigger takes the ' +
      'project FOR NO KEY UPDATE while the row is held — the project/task inversion documented in ' +
      'docs/postgres-lock-order.md §6. Left as a single statement deliberately: the inversion is ' +
      'not resolvable from this side, and wrapping four of the fifteen single-statement status ' +
      'writers in transactions would buy the appearance of coverage rather than the property.',
  },
  {
    file: 'tasks.service.ts',
    method: 'batchAssign',
    statements: ['task.updateMany'],
    holds: ['await this.lockDependencyGraph(tx, ownerId);'],
    note:
      'A multi-row `task` write, so rank 10 (I1). `assignee_id` is in no trigger\'s column list, so ' +
      'there is no project or session lock to order after it.',
  },
  {
    file: 'task-lists.service.ts',
    method: 'writePolicy',
    statements: ['task.updateMany'],
    holds: ['await lockOwnerTaskGraph(tx, ownerId);', 'FROM "task_list"'],
    note:
      'Rank 10 then rank 20: a pause writes the list row and then every Task in it, which is the ' +
      'other side of the foreign key a Task re-filing takes at rank 20.',
  },
  {
    file: 'task-lists.service.ts',
    method: 'remove',
    statements: ['task.updateMany'],
    holds: ['await lockOwnerTaskGraph(tx, ownerId);'],
    note:
      'Two multi-row `task` writes — the disarm, and the Task.listId SET NULL the delete cascades ' +
      '— so rank 10, and both inside one transaction.',
  },
];

/** The statements the scan below counts as a Task write. */
const TASK_WRITE =
  /\b(?:tx|db|this\.prisma|prisma)\.(task|taskDependency)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b|UPDATE\s+"task"|DELETE\s+FROM\s+"task"|INSERT\s+INTO\s+"task"/;
const METHOD = /^ {2}(?:private |protected |public |static )*(?:async )?([A-Za-z0-9_]+)\s*\(/;
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']);

/**
 * Every Task write statement in one file, paired with the class method it sits in.
 *
 * Comment lines are skipped before the match. The comments in these files NAME the statements they
 * are about — "`tx.task.update` below takes the same row" — and counting those as writes would ask
 * the inventory to carry a lock plan for a sentence.
 */
function scanTaskWrites(source: string): Array<{ method: string; statement: string }> {
  const found: Array<{ method: string; statement: string }> = [];
  let method = '(top-level)';
  for (const line of source.split('\n')) {
    const declared = METHOD.exec(line);
    if (declared && !NOT_A_METHOD.has(declared[1])) method = declared[1];
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    const write = TASK_WRITE.exec(line);
    if (write) {
      found.push({
        method,
        statement: write[1] && write[2] ? `${write[1]}.${write[2]}` : write[0].trim(),
      });
    }
  }
  return found;
}

test('every Task write source is in the lock-order inventory', () => {
  const scanned = [
    ...scanTaskWrites(tasksService).map((w) => ({ file: 'tasks.service.ts' as const, ...w })),
    ...scanTaskWrites(taskListsService).map((w) => ({ file: 'task-lists.service.ts' as const, ...w })),
  ];
  const declared = TASK_WRITE_SOURCES.flatMap((s) =>
    s.statements.map((statement) => `${s.file}#${s.method}: ${statement}`),
  );
  // Sequence, not set: `update` writes the task row three times over and the count is the point —
  // it is what decides whether the creator-Session pre-lock is needed at all.
  assert.deepEqual(
    scanned.map((w) => `${w.file}#${w.method}: ${w.statement}`),
    declared,
    'a Task write appeared, moved or vanished — add it to TASK_WRITE_SOURCES with its lock plan, ' +
      'or remove the entry that no longer describes anything',
  );
});

test('each inventory entry holds what it says it holds', () => {
  const sources = { 'tasks.service.ts': tasksService, 'task-lists.service.ts': taskListsService };
  for (const entry of TASK_WRITE_SOURCES) {
    for (const held of entry.holds) {
      assert.ok(
        sources[entry.file].includes(held),
        `${entry.file}#${entry.method} claims to take \`${held}\` and no longer does`,
      );
    }
  }
});

/**
 * I3, statically: the runner transactions that hold a Session FOR UPDATE write that row once.
 *
 * Counting statements is the only thing a source scan can honestly do, so the count is declared
 * per method along with why the branches make it one write at run time. The measurement that the
 * invariant actually holds — that no `user`/`workspace`/`runner`/`task` lock appears — is
 * `lock-order.pg.spec.ts`, against a real server.
 */
const SESSION_WRITERS: ReadonlyArray<{ method: string; statements: number; note: string }> = [
  {
    method: 'events',
    statements: 1,
    note:
      'One, literally. It used to be up to eight — a telemetry write, a runtime-id fill, the ' +
      'preview denormalisation and one per background/sub-agent id — accumulated into `sessionData` ' +
      'and issued once at the end.',
  },
  {
    method: 'turnComplete',
    statements: 4,
    note:
      'Four spellings, one write on every path. The steer wake-up returns immediately after its ' +
      'own. The merge-state clear rides along with the park (one write), and is spelled out again ' +
      'on the two paths where the park wrote nothing — a duplicate ack, which returns before the ' +
      'park, and a park that matched no row, which leaves the tuple and its xmin alone. So the ' +
      'clear and the park are never both issued as writes in one transaction.',
  },
];

test('the runner Session writers issue one write per row', () => {
  const SESSION_WRITE = /\btx\.session\.(update|updateMany)\b|UPDATE\s+"session"/g;
  for (const writer of SESSION_WRITERS) {
    const start = runnerApi.indexOf(`  async ${writer.method}(`);
    assert.ok(start > 0, `${writer.method} is gone`);
    // Up to the next method declaration at class-body indentation.
    const rest = runnerApi.slice(start + 10);
    const end = rest.search(/\n {2}(?:private |@)/);
    const body = end > 0 ? rest.slice(0, end) : rest;
    assert.equal(
      body.match(SESSION_WRITE)?.length ?? 0,
      writer.statements,
      `${writer.method} changed how many statements can write its Session row — re-derive the ` +
        'one-write invariant (common/lock-order.ts, I3) before updating this number',
    );
  }
});

test('the declared order is a strict ranking with argued gaps', () => {
  const ranks = LOCK_ORDER.map((l) => l.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ranks must ascend');
  assert.equal(new Set(ranks).size, ranks.length, 'two relations cannot share a rank');
  // The three relations the order is stated over, and the two it deliberately leaves out, both
  // have to keep naming code that exists.
  assert.ok(LOCK_ORDER.some((l) => l.relation === 'session'));
  assert.ok(LOCK_ORDER.some((l) => l.relation === 'task'));
  assert.ok(LOCK_ORDER.some((l) => l.relation === 'project'));
  assert.equal(LOCK_ORDER_EXCEPTIONS.length, 2);
  assert.ok(LOCK_ORDER_COMPATIBLE.some((c) => c.relation === 'workspace'));
  assert.ok(LOCK_ORDER_COMPATIBLE.some((c) => c.relation === 'runner'));
});

test('the compatibility arguments still describe the code they are about', () => {
  // workspace: WorkspacesService.remove takes FOR UPDATE and then waits for nothing — its other
  // statements are an unlocked count and the update of the row it already holds.
  const remove = workspacesService.slice(workspacesService.indexOf('  async remove('));
  const body = remove.slice(0, remove.indexOf('\n  /**'));
  assert.match(body, /FROM "workspace"[\s\S]*FOR UPDATE/);
  assert.match(body, /tx\.projectMember\.count/);
  assert.equal(/FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)/g.exec(body.slice(body.indexOf('projectMember'))), null,
    'workspace delete took a second lock — its "cannot be in a cycle" argument no longer holds');

  // runner: nothing in these paths takes FOR UPDATE on a runner row.
  assert.equal(/FROM "runner"[^;]*FOR UPDATE/.test(runnerApi), false);
  assert.equal(/FROM "runner"[^;]*FOR UPDATE/.test(tasksService), false);
});

test('the triggers the order is derived from are still declared the way it assumes', () => {
  // Rank 70 is a relation of its own because an edge write advances it and the dispatch decision
  // reads the edge set under it — and because 0132 REMOVED the touch that used to serve as the
  // boundary, which is what took rank 30 off the pure edge paths.
  assert.equal(/CREATE TRIGGER "task_dependency_dispatch_touch"/.test(dependencyRevision), false);
  assert.match(dependencyRevision, /DROP TRIGGER "task_dependency_dispatch_touch" ON "task_dependency"/);
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    assert.match(
      dependencyRevision,
      new RegExp(`CREATE TRIGGER "task_dependency_revision_${event.toLowerCase()}"\\s+AFTER ${event} ON "task_dependency"`),
      `the ${event} half of the revision boundary is not declared the way rank 70 assumes`,
    );
  }
  // Statement-level with a transition table, which is what "once per Task per batch" means.
  assert.equal(/FOR EACH ROW EXECUTE FUNCTION "task_dependency_revision/.test(dependencyRevision), false);
  assert.match(dependencyRevision, /REFERENCING NEW TABLE AS new_edges/);
  // Sorted acquisition, in one statement, above the UPDATE that advances them.
  assert.match(dependencyRevision, /ORDER BY r\."task_id" FOR NO KEY UPDATE/);
  // Every Task has a row, or the empty edge set would have nothing to lock again.
  assert.match(dependencyRevision, /AFTER INSERT ON "task" REFERENCING NEW TABLE AS new_tasks/);
  assert.match(dependencyRevision, /INSERT INTO "task_dependency_revision" \("task_id"\) SELECT "id" FROM "task"/);
  // Rank 40 is below `session` because the capacity fence is a BEFORE trigger on a Session write,
  // and it is narrowed to the three columns that can move the live-claim set — which is what keeps
  // it out of a telemetry batch entirely.
  assert.match(dispatchBoundary, /CREATE TRIGGER "session_project_capacity_serialize_update"\s+BEFORE UPDATE OF "status", "task_id", "deleted_at" ON "session"/);
  // 0127 used to put rank 40 after a task status/verdict write. 0178 removes that edge because
  // task-list state is not a project-acceptance fact.
  assert.match(acceptanceRun, /CREATE TRIGGER project_acceptance_task_fact_update/);
  assert.match(acceptanceOnly, /DROP TRIGGER IF EXISTS "project_acceptance_task_fact_update" ON "task"/);
  assert.match(acceptanceOnly, /DROP TRIGGER IF EXISTS "task_acceptance_fact_lock_order_update" ON "task"/);
});

test('orderedIds is the total order the pre-locks depend on', () => {
  assert.deepEqual(orderedIds(['b', 'a', 'b', null, undefined, 'c']), ['a', 'b', 'c']);
  assert.deepEqual(orderedIds([]), []);
  // Two callers with the same set in different input orders must produce the same statement.
  const ids = ['3f', '0a', 'ff', '10'];
  assert.deepEqual(orderedIds(ids), orderedIds([...ids].reverse()));
});
