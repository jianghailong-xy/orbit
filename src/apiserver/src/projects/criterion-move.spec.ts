/**
 * The done card's "Move to a follow-up…" (`criterion-move.ts`, `ProjectsService.moveCriterion`).
 *
 * Two layers. The planner is pure, so every refusal is put to it directly with the one fact that
 * causes it. The door is then driven end to end over an in-memory store standing in for the
 * transaction: the criterion and its open tasks reach an existing project and a new one, the
 * DONE task stays, A's seal moves and its confirmation moves with it, the move is recorded, and A's
 * done-check — `doneReadiness` over A's criteria as the satisfaction lane reads them from the store —
 * stops naming the criterion. Every refusal the door raises answers with its code and writes nothing.
 * `criterion-move.pg.spec.ts` runs the same door against PostgreSQL.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpException, Logger } from '@nestjs/common';
import type { DoneState, MoveCriterionRefusal } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import {
  planCriterionMove,
  CRITERION_MOVED_ACTIVITY,
  type CriterionMoveFacts,
} from './criterion-move';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';
import { readCriterionSatisfaction } from './project-criterion-satisfaction';
import { doneReadiness } from './project-done-request';
import { ProjectsService } from './projects.service';

const OWNER = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const T_OPEN = '00000000-0000-4000-8000-000000000101';
const T_FAILED = '00000000-0000-4000-8000-000000000102';
const T_DONE = '00000000-0000-4000-8000-000000000103';
const T_MET = '00000000-0000-4000-8000-000000000104';
const T_OTHER = '00000000-0000-4000-8000-000000000105';
const ITEM = '00000000-0000-4000-8000-000000000201';

// The door's post-commit edges (landing settlement, the derived-status re-projection) read tables
// this store does not model; each logs and costs the move nothing, which is what they are for.
Logger.overrideLogger(['error']);

// ── the planner ─────────────────────────────────────────────────────────────────────────────────

function facts(over: Partial<CriterionMoveFacts> = {}): CriterionMoveFacts {
  return {
    source: { id: A, status: 'OPEN' },
    target: { id: B, status: 'OPEN' },
    criterion: { id: C2, satisfied: false },
    servingTasks: [
      { id: T_OPEN, title: 'open work', status: 'OPEN' },
      { id: T_FAILED, title: 'failed work', status: 'FAILED' },
      { id: T_DONE, title: 'done work', status: 'DONE' },
    ],
    liveRuns: [],
    landings: [],
    dependencies: [],
    links: [],
    fixes: [],
    openItems: [],
    ...over,
  };
}

function refusalOf(input: CriterionMoveFacts): MoveCriterionRefusal | null {
  const decided = planCriterionMove(input);
  return 'refusal' in decided ? decided.refusal.code : null;
}

test('the plan moves what is not DONE or CANCELLED, keeps the rest, and takes TASK_FAILED items along', () => {
  const decided = planCriterionMove(facts({
    servingTasks: [
      { id: T_OPEN, title: 'open', status: 'OPEN' },
      { id: T_FAILED, title: 'failed', status: 'FAILED' },
      { id: T_DONE, title: 'done', status: 'DONE' },
      { id: T_OTHER, title: 'cancelled', status: 'CANCELLED' },
    ],
    openItems: [{ id: ITEM, kind: 'TASK_FAILED', taskId: T_FAILED }],
    // A settled prerequisite staying behind waits on nothing: the edge is kept.
    dependencies: [{
      task: { id: T_OPEN, projectId: A, status: 'OPEN' },
      dependsOn: { id: T_MET, projectId: A, status: 'DONE' },
    }],
  }));
  assert.ok('plan' in decided);
  assert.deepEqual(decided.plan.movedTaskIds, [T_OPEN, T_FAILED]);
  assert.deepEqual(decided.plan.keptTaskIds, [T_DONE, T_OTHER]);
  assert.deepEqual(decided.plan.movedOpenItemIds, [ITEM]);
});

test('each refusal answers with its own code', () => {
  const cases: Array<[MoveCriterionRefusal, Partial<CriterionMoveFacts>]> = [
    ['CRITERION_MOVE_SOURCE_NOT_OPEN', { source: { id: A, status: 'DONE' } }],
    ['CRITERION_MOVE_TARGET_NOT_OPEN', { target: { id: B, status: 'CANCELLED' } }],
    ['CRITERION_MOVE_CRITERION_MET', { criterion: { id: C2, satisfied: true } }],
    ['CRITERION_MOVE_TASK_RUNNING', { liveRuns: [{ taskId: T_OPEN, sessionId: ITEM, status: 'AWAITING_INPUT' }] }],
    ['CRITERION_MOVE_TASK_LANDING', { landings: [{ taskId: T_FAILED, jobId: ITEM }] }],
    ['CRITERION_MOVE_DEPENDENCY_CROSSES', {
      dependencies: [{
        task: { id: T_OTHER, projectId: A, status: 'OPEN' },
        dependsOn: { id: T_OPEN, projectId: A, status: 'OPEN' },
      }],
    }],
    ['CRITERION_MOVE_DEPENDENCY_CROSSES', {
      dependencies: [{
        task: { id: T_OPEN, projectId: A, status: 'OPEN' },
        dependsOn: { id: T_OTHER, projectId: A, status: 'IN_PROGRESS' },
      }],
    }],
    ['CRITERION_MOVE_LINK_CROSSES', {
      links: [{ taskId: T_OPEN, kind: 'PARENT', other: { id: T_OTHER, projectId: A } }],
    }],
    // A DONE serving task stays, so a check of a moving task by it crosses too.
    ['CRITERION_MOVE_LINK_CROSSES', {
      links: [{ taskId: T_OPEN, kind: 'VERIFIED_BY', other: { id: T_DONE, projectId: A } }],
    }],
    ['CRITERION_MOVE_LINK_CROSSES', { fixes: [{ taskId: T_OPEN, itemId: ITEM }] }],
    ['CRITERION_MOVE_TASK_ITEM_OPEN', { openItems: [{ id: ITEM, kind: 'INTEGRATION_CONFLICT', taskId: T_OPEN }] }],
  ];
  for (const [code, over] of cases) {
    assert.equal(refusalOf(facts(over)), code, `${code}: ${JSON.stringify(over)}`);
  }
  // None of those facts refuses when it is about a task that does not move.
  assert.equal(refusalOf(facts({ liveRuns: [{ taskId: T_DONE, sessionId: ITEM, status: 'RUNNING' }] })), null);
  assert.equal(refusalOf(facts({ landings: [{ taskId: T_DONE, jobId: ITEM }] })), null);
  assert.equal(refusalOf(facts({
    openItems: [{ id: ITEM, kind: 'INTEGRATION_CONFLICT', taskId: T_DONE }],
  })), null);
  // A link to a task in the destination, or between two moving tasks, crosses nothing.
  assert.equal(refusalOf(facts({
    links: [
      { taskId: T_OPEN, kind: 'PARENT', other: { id: T_OTHER, projectId: B } },
      { taskId: T_OPEN, kind: 'SUBTASK', other: { id: T_FAILED, projectId: A } },
    ],
  })), null);
  // A TASK_FAILED item the task fixes moves with it, so the fix link moves too.
  assert.equal(refusalOf(facts({
    openItems: [{ id: ITEM, kind: 'TASK_FAILED', taskId: T_FAILED }],
    fixes: [{ taskId: T_OPEN, itemId: ITEM }],
  })), null);
  // A new project (no target row) is OPEN by birth.
  assert.equal(refusalOf(facts({ target: null })), null);
});

// ── the door, over an in-memory store ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Store {
  project: Row[];
  projectAcceptanceCriterionDefinition: Row[];
  task: Row[];
  session: Row[];
  projectIntegrationJob: Row[];
  taskDependency: Row[];
  projectOpenItem: Row[];
  projectStandardSetConfirmation: Row[];
  activity: Row[];
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return (wanted as Row[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date)) {
      const filter = wanted as Row;
      if ('in' in filter) return (filter.in as unknown[]).includes(value);
      if ('notIn' in filter) return !(filter.notIn as unknown[]).includes(value);
      if ('not' in filter) return value !== filter.not;
      return true; // a relation filter (`project: { ownerId }`): every row here is the owner's
    }
    return value === wanted;
  });
}

function world(): Store {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 10, n));
  const task = (id: string, over: Row): Row => ({
    id, ownerId: OWNER, projectId: A, title: id, status: 'OPEN', completionCriterion: 'EXECUTABLE',
    criterionDefinitionId: null, criterionRevision: null, parentTaskId: null, verifiesTaskId: null,
    supersededByTaskId: null, fixesOpenItemId: null, verdict: null, createdAt: at(Number(id.slice(-2))),
    ...over,
  });
  const definition = (id: string, ordinal: number, text: string): Row => ({
    id, projectId: A, ordinal, text, verificationMethod: 'read it', completionCriterionOverrideReason: null,
    revision: 1, contentHash: text.padEnd(64, '0').slice(0, 64),
  });
  const definitions = [definition(C1, 1, 'the first holds'), definition(C2, 2, 'the second holds')];
  const sealBefore = standardSetVersion(criteriaFromDefinitions(definitions as never));
  return {
    project: [
      { id: A, ownerId: OWNER, status: 'OPEN', title: 'A' },
      { id: B, ownerId: OWNER, status: 'OPEN', title: 'B' },
    ],
    projectAcceptanceCriterionDefinition: [
      ...definitions,
      { ...definition('00000000-0000-4000-8000-0000000000b9', 1, 'B already states this'), projectId: B },
    ],
    task: [
      task(T_MET, { status: 'DONE', criterionDefinitionId: C1, criterionRevision: 1 }),
      task(T_OPEN, { criterionDefinitionId: C2, criterionRevision: 1 }),
      task(T_FAILED, { status: 'FAILED', criterionDefinitionId: C2, criterionRevision: 1 }),
      task(T_DONE, { status: 'DONE', criterionDefinitionId: C2, criterionRevision: 1 }),
    ],
    session: [],
    projectIntegrationJob: [],
    taskDependency: [],
    projectOpenItem: [{
      id: ITEM, ownerId: OWNER, projectId: A, kind: 'TASK_FAILED', state: 'OPEN', taskId: T_FAILED,
      assignee: 'OWNER', title: 'failed work failed',
    }],
    projectStandardSetConfirmation: [{
      id: 'confirmation-1', projectId: A, criteriaDigest: sealBefore.digest, confirmedAt: at(0),
    }],
    activity: [],
  };
}

/** The serving-task shape the satisfaction lane selects, from a stored task. */
const servingShape = (row: Row): Row => ({
  ...row, verifiedBy: [], verifies: null, completionEvidence: [],
});

function delegate(store: Store, name: keyof Store) {
  const rows = () => store[name];
  return {
    findMany: async (args: { where?: Row; select?: Row; orderBy?: unknown } = {}) =>
      rows().filter((row) => matches(row, args.where)).map((row): Row => {
        if (name === 'projectAcceptanceCriterionDefinition' && args.select && 'servingTasks' in args.select) {
          return {
            ...row,
            servingTasks: store.task
              .filter((task) => task.criterionDefinitionId === row.id)
              .map(servingShape),
          };
        }
        if (name === 'taskDependency') {
          return {
            ...row,
            task: store.task.find((task) => task.id === row.taskId),
            dependsOnTask: store.task.find((task) => task.id === row.dependsOnTaskId),
          };
        }
        return { ...row };
      }).sort((x: Row, y: Row) =>
        name === 'projectAcceptanceCriterionDefinition' ? (x.ordinal as number) - (y.ordinal as number) : 0),
    findFirst: async (args: { where?: Row; orderBy?: unknown } = {}) => {
      const found = rows().filter((row) => matches(row, args.where));
      if (name === 'projectStandardSetConfirmation') {
        found.sort((x, y) => (y.confirmedAt as Date).getTime() - (x.confirmedAt as Date).getTime());
      }
      return found[0] ? { ...found[0] } : null;
    },
    aggregate: async (args: { where?: Row }) => ({
      _max: {
        ordinal: rows().filter((row) => matches(row, args.where))
          .reduce<number | null>((max, row) => Math.max(max ?? 0, row.ordinal as number), null),
      },
    }),
    update: async (args: { where: Row; data: Row }) => {
      const row = rows().find((candidate) => matches(candidate, args.where));
      assert.ok(row, `${name}.update found no row`);
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where?: Row; data: Row }) => {
      const hit = rows().filter((row) => matches(row, args.where));
      for (const row of hit) Object.assign(row, args.data);
      return { count: hit.length };
    },
    create: async (args: { data: Row }) => {
      const { runtime: _runtime, ...data } = args.data;
      const row: Row = {
        id: `00000000-0000-4000-8000-${String(rows().length + 1).padStart(12, 'e')}`,
        confirmedAt: new Date(Date.UTC(2026, 10, 11, 12, rows().length)),
        status: 'OPEN',
        ...data,
      };
      rows().push(row);
      return { ...row };
    },
  };
}

function prismaOver(store: Store, options: { busy?: boolean } = {}) {
  const tx = {
    ...Object.fromEntries((Object.keys(store) as Array<keyof Store>).map((name) => [name, delegate(store, name)])),
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      if (text.includes('FROM "project"')) {
        const ids = values.find(Array.isArray) as string[];
        return store.project.filter((project) => ids.includes(project.id as string)).map(({ id }) => ({ id }));
      }
      if (text.includes('FROM "task"') && options.busy) {
        throw Object.assign(new Error('could not obtain lock on row in relation "task"'), { code: '55P03' });
      }
      return [];
    },
  };
  return {
    ...tx,
    // One attempt, writing straight into the store: a refusal must therefore be raised before the
    // first write for "nothing was written" to hold, which is what the refusal cases below check.
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;
}

/** A's done-check, read from the store the way `readDoneState` reads it, with every criterion landed. */
async function doneCheckOfA(store: Store) {
  const prisma = prismaOver(store);
  const definitions = store.projectAcceptanceCriterionDefinition.filter((row) => row.projectId === A);
  const satisfaction = new Map((await readCriterionSatisfaction(prisma, OWNER, A))
    .map((row) => [row.definitionId, row]));
  const stated = criteriaFromDefinitions(definitions as never);
  const state: DoneState = {
    criteria: stated.map((criterion) => {
      const met = satisfaction.get(criterion.definitionId)!;
      return {
        stated: criterion,
        satisfied: met.satisfied,
        heldUpBy: met.unmet.flatMap((unmet) => unmet.heldUpBy.map(({ taskId, title }) => ({ taskId, title }))),
        landing: 'LANDED',
        reason: null,
        heldOffLanded: [],
      };
    }),
    tasks: store.task.filter((row) => row.projectId === A).map((row) => ({
      id: row.id as string, title: row.title as string, status: row.status as never,
      criterionDefinitionId: row.criterionDefinitionId as string | null, run: null,
    })),
    ownerItems: store.projectOpenItem
      .filter((item) => item.projectId === A && item.state === 'OPEN' && item.assignee === 'OWNER')
      .map((item) => ({ itemId: item.id as string, kind: item.kind as never, title: item.title as string })),
    jobs: [],
    criteriaDigest: standardSetVersion(stated).digest,
    stateDigest: '',
  };
  return doneReadiness(state, []);
}

const service = (store: Store, options: { busy?: boolean } = {}) =>
  new ProjectsService(prismaOver(store, options));

test('into an existing project: the criterion and its open tasks move, the DONE one stays, A is done-ready', async () => {
  const store = world();
  const before = await doneCheckOfA(store);
  assert.deepEqual(before.map((finding) => finding.code), ['DONE_CRITERION_UNSATISFIED', 'DONE_OWNER_ITEMS_OPEN']);
  assert.equal(before[0].criterion?.text, 'the second holds');
  const sealBefore = store.projectStandardSetConfirmation[0].criteriaDigest;

  const result = await service(store).moveCriterion(OWNER, A, C2, { toProjectId: B });

  assert.equal(result.toProjectId, B);
  assert.equal(result.createdProject, false);
  assert.deepEqual(result.movedTaskIds, [T_OPEN, T_FAILED]);
  assert.deepEqual(result.keptTaskIds, [T_DONE]);
  assert.deepEqual(result.movedOpenItemIds, [ITEM]);

  // The definition row itself, at the end of B's order; its words and revision untouched.
  const moved = store.projectAcceptanceCriterionDefinition.find((row) => row.id === C2)!;
  assert.equal(moved.projectId, B);
  assert.equal(moved.ordinal, 2);
  assert.equal(moved.revision, 1);
  // The open tasks with it, still declaring it; the DONE one stays and serves nothing now.
  const taskRow = (id: string) => store.task.find((row) => row.id === id)!;
  assert.equal(taskRow(T_OPEN).projectId, B);
  assert.equal(taskRow(T_OPEN).criterionDefinitionId, C2);
  assert.equal(taskRow(T_FAILED).projectId, B);
  assert.equal(taskRow(T_DONE).projectId, A);
  assert.equal(taskRow(T_DONE).criterionDefinitionId, null);
  assert.equal(taskRow(T_DONE).criterionRevision, 1, 'the declaration reads as one whose criterion is gone');
  assert.equal(store.projectOpenItem[0].projectId, B, 'the TASK_FAILED item went with its task');

  // A's criteria revision: a new seal, recorded with the old one, and the confirmation carried to it.
  assert.notEqual(result.fromCriteriaDigest.after, result.fromCriteriaDigest.before);
  assert.equal(result.fromCriteriaDigest.before, sealBefore);
  const sealAfter = standardSetVersion(criteriaFromDefinitions(
    store.projectAcceptanceCriterionDefinition.filter((row) => row.projectId === A) as never)).digest;
  assert.equal(result.fromCriteriaDigest.after, sealAfter);
  const confirmations = store.projectStandardSetConfirmation.filter((row) => row.projectId === A);
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[1].criteriaDigest, sealAfter);
  assert.equal(store.activity.length, 1);
  assert.equal(store.activity[0].type, CRITERION_MOVED_ACTIVITY);
  assert.deepEqual(
    (store.activity[0].payload as Row).fromCriteriaDigestAfter, sealAfter);

  // A's done-check no longer names the criterion, and with the rest met there is nothing in the way.
  assert.deepEqual(await doneCheckOfA(store), []);
});

test('into a new project: created with the title and goal given, and it receives the criterion', async () => {
  const store = world();
  const result = await service(store).moveCriterion(OWNER, A, C2, {
    newProject: { title: '  Follow-up: the second  ', goal: 'Finish the second' },
  });
  assert.equal(result.createdProject, true);
  const created = store.project.find((row) => row.id === result.toProjectId)!;
  assert.ok(created && created.id !== A && created.id !== B);
  assert.equal(created.title, 'Follow-up: the second');
  assert.equal(created.goal, 'Finish the second');
  assert.equal(created.ownerId, OWNER);
  const moved = store.projectAcceptanceCriterionDefinition.find((row) => row.id === C2)!;
  assert.equal(moved.projectId, created.id);
  assert.equal(moved.ordinal, 1);
  assert.deepEqual(
    store.task.filter((row) => row.projectId === created.id).map((row) => row.id), [T_OPEN, T_FAILED]);
  assert.deepEqual(await doneCheckOfA(store), []);
});

async function refusedWith(
  store: Store,
  run: (projects: ProjectsService) => Promise<unknown>,
  options: { busy?: boolean } = {},
): Promise<{ status: number; code: string }> {
  const snapshot = JSON.stringify(store);
  const error = await run(service(store, options)).then(
    () => assert.fail('the move was not refused'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof HttpException, String(error));
  assert.equal(JSON.stringify(store), snapshot, 'a refusal writes nothing');
  return { status: error.getStatus(), code: (error.getResponse() as { code: string }).code };
}

test('the door refuses each case with its code and writes nothing', async () => {
  const move = (body: Parameters<ProjectsService['moveCriterion']>[3], criterion = C2) =>
    (projects: ProjectsService) => projects.moveCriterion(OWNER, A, criterion, body);

  const cases: Array<[MoveCriterionRefusal | 'CRITERION_MOVE_OWNER_ONLY', number, (store: Store) => void,
    (projects: ProjectsService) => Promise<unknown>, { busy?: boolean }?]> = [
    ['CRITERION_MOVE_TARGET_REQUIRED', 400, () => {}, move({})],
    ['CRITERION_MOVE_TARGET_REQUIRED', 400, () => {}, move({ toProjectId: B, newProject: { title: 'x' } })],
    ['CRITERION_MOVE_TARGET_REQUIRED', 400, () => {}, move({ newProject: { title: '   ' } })],
    ['CRITERION_MOVE_SAME_PROJECT', 400, () => {}, move({ toProjectId: A })],
    ['CRITERION_MOVE_OWNER_ONLY', 403, () => {},
      (projects) => projects.moveCriterion(OWNER, A, C2, { toProjectId: B }, ITEM)],
    ['CRITERION_MOVE_SOURCE_NOT_OPEN', 409, (s) => { s.project[0].status = 'CANCELLED'; }, move({ toProjectId: B })],
    ['CRITERION_MOVE_TARGET_NOT_OPEN', 409, (s) => { s.project[1].status = 'DONE'; }, move({ toProjectId: B })],
    ['CRITERION_MOVE_CRITERION_MET', 409, () => {}, move({ toProjectId: B }, C1)],
    ['CRITERION_MOVE_TASK_RUNNING', 409, (s) => {
      s.session.push({ id: 's1', ownerId: OWNER, taskId: T_OPEN, status: 'RUNNING', deletedAt: null });
    }, move({ toProjectId: B })],
    ['CRITERION_MOVE_TASK_LANDING', 409, (s) => {
      s.projectIntegrationJob.push({ id: 'j1', ownerId: OWNER, taskId: T_FAILED, kind: 'LAND_TASK', state: 'QUEUED' });
    }, move({ toProjectId: B })],
    ['CRITERION_MOVE_DEPENDENCY_CROSSES', 409, (s) => {
      s.task.push({ ...s.task[1], id: T_OTHER, criterionDefinitionId: null, criterionRevision: null });
      s.taskDependency.push({ taskId: T_OTHER, dependsOnTaskId: T_OPEN });
    }, move({ toProjectId: B })],
    ['CRITERION_MOVE_LINK_CROSSES', 409, (s) => {
      s.task.push({ ...s.task[1], id: T_OTHER, criterionDefinitionId: null, criterionRevision: null });
      s.task[1].parentTaskId = T_OTHER;
    }, move({ toProjectId: B })],
    ['CRITERION_MOVE_TASK_ITEM_OPEN', 409, (s) => {
      s.projectOpenItem.push({
        id: 'i2', ownerId: OWNER, projectId: A, kind: 'INTEGRATION_CONFLICT', state: 'OPEN', taskId: T_OPEN,
        assignee: 'COORDINATOR',
      });
    }, move({ toProjectId: B })],
    ['CRITERION_MOVE_BUSY', 409, () => {}, move({ toProjectId: B }), { busy: true }],
  ];
  for (const [code, status, arrange, run, options] of cases) {
    const store = world();
    arrange(store);
    const answer = await refusedWith(store, run, options);
    assert.deepEqual(answer, { status, code }, code);
  }
});
