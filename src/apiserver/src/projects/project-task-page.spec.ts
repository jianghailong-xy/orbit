import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { Query } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { TaskStatus } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT_ID = '00000000-0000-7000-8000-0000000000a2';
const PARENT_ID = '00000000-0000-7000-8000-0000000000b1';

/** A task row as the page's select returns it: the tree fields plus the child tally. */
function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `task ${id.slice(-2)}`,
    status: TaskStatus.OPEN,
    parentTaskId: null,
    acceptanceCriteria: null,
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    dueDate: null,
    runAt: null,
    assignee: null,
    _count: { children: 0 },
    ...overrides,
  };
}

/**
 * A ProjectsService whose project lookup succeeds and whose task reads are recorded. `tasks` is
 * what `findMany` returns; `parent` is what the parentId check finds (null = no such task in this
 * owner's copy of this project).
 */
function serviceWith(opts: {
  tasks?: unknown[];
  parent?: unknown;
  project?: unknown;
  graph?: unknown[];
  onFindMany?: (args: any) => void;
} = {}) {
  const calls: {
    findMany: any[];
    parentWhere: any[];
    graph: any[];
    overlays: any[];
    failureCoordination: any[];
  } = {
    findMany: [],
    parentWhere: [],
    graph: [],
    overlays: [],
    failureCoordination: [],
  };
  const service = new ProjectsService({
    project: { findFirst: async () => ('project' in opts ? opts.project : { id: PROJECT_ID }) },
    // The dependency pass. What its SQL actually computes is a property of PostgreSQL and is
    // proved against a real one in `project-task-dependency-fields.pg.spec.ts`; what is checked
    // here is the part that is this file's subject — that it happens once per page and that its
    // answer reaches the rows.
    $queryRaw: async (...args: unknown[]) => {
      const sql = args[0];
      const rendered = renderRawQuery(args).text;
      if (rendered.includes('"unmetCount"')) {
        calls.graph.push(sql);
        return opts.graph ?? [];
      }
      if (rendered.includes('failure_continuation_obligation')) {
        calls.failureCoordination.push(sql);
        return [];
      }
      // taskPage also reads the canonical work-state overlay through the same Prisma raw-query
      // door. Keep that independent read visible without mislabelling it as a second graph walk.
      calls.overlays.push(sql);
      return [];
    },
    task: {
      findFirst: async (args: any) => {
        calls.parentWhere.push(args.where);
        return 'parent' in opts ? opts.parent : { id: PARENT_ID };
      },
      findMany: async (args: any) => {
        calls.findMany.push(args);
        opts.onFindMany?.(args);
        // Projected through the `select` the service asked for, the way Prisma would. A stub that
        // hands back whatever the fixture holds makes every "the page returns X" assertion pass
        // whether or not X was selected at all — so a column dropped from the select would be
        // caught only by the shape test below, and never by the tests about what a client reads.
        return (opts.tasks ?? []).map((task) =>
          Object.fromEntries(
            Object.entries(task as Record<string, unknown>).filter(([k]) => k in args.select),
          ),
        );
      },
    },
  } as never, {} as never);
  return { service, calls };
}

// ── The level boundary, which is the whole point of the endpoint ──────────────────────────────

test('with no parentId the page is the project’s top level, never a subtask', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID);

  // All three at once: the owner, the project, and the level. A query missing any one of them is
  // either cross-tenant, cross-project, or the flattened whole-project read this endpoint exists
  // to not be.
  assert.deepEqual(calls.findMany[0].where, {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    parentTaskId: null,
  });
  assert.deepEqual(calls.findMany[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  // No parent was named, so nothing needed resolving.
  assert.deepEqual(calls.parentWhere, []);
});

test('with a parentId the page is that task’s direct children, and only those', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID, { parentId: PARENT_ID });

  assert.deepEqual(calls.findMany[0].where, {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    parentTaskId: PARENT_ID,
  });
  // `parentTaskId` equality, not a descendant walk: a grandchild is a page of its own parent.
  assert.equal('OR' in calls.findMany[0].where, false);
});

// ── Whose parent, and in which project ────────────────────────────────────────────────────────

test('the parent is resolved by owner AND project in one query', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID, { parentId: PARENT_ID });

  assert.deepEqual(calls.parentWhere[0], { id: PARENT_ID, ownerId: OWNER_ID, projectId: PROJECT_ID });
});

test('a parent in another project is a 404, and reads no tasks', async () => {
  // The row exists, but not with this project's id on it — so the scoped lookup finds nothing.
  const { service, calls } = serviceWith({ parent: null });

  await assert.rejects(
    () => service.taskPage(OWNER_ID, PROJECT_ID, { parentId: PARENT_ID }),
    (e: any) => e.status === 404 && /parent task not found/.test(e.message),
  );
  assert.deepEqual(calls.findMany, []);
});

test('a parent in another account is the same 404, worded the same way', async () => {
  const { service } = serviceWith({ parent: null });

  await assert.rejects(
    () => service.taskPage(OTHER_OWNER_ID, PROJECT_ID, { parentId: PARENT_ID }),
    // Identical to the cross-project refusal on purpose: which kind of "not in this tree" it was
    // is a fact about another account's contents.
    (e: any) => e.status === 404 && /parent task not found/.test(e.message),
  );
});

test('an unknown or someone else’s project keeps the project-not-found semantics', async () => {
  const { service, calls } = serviceWith({ project: null });

  await assert.rejects(
    () => service.taskPage(OWNER_ID, OTHER_PROJECT_ID),
    (e: any) => e.status === 404 && /project not found/.test(e.message),
  );
  // Refused before anything is read, and before a parentId could be resolved against it.
  assert.deepEqual(calls.findMany, []);
  assert.deepEqual(calls.parentWhere, []);
});

// ── status ────────────────────────────────────────────────────────────────────────────────────

test('a status narrows the level, case-insensitively', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID, { status: 'in_progress' });

  assert.equal(calls.findMany[0].where.status, TaskStatus.IN_PROGRESS);
});

test('an unsettable status is a 400 naming the ones that exist', async () => {
  const { service, calls } = serviceWith();

  for (const status of ['NOPE', 'RUNNABLE', 'RUNNING', 'ONGOING']) {
    await assert.rejects(
      () => service.taskPage(OWNER_ID, PROJECT_ID, { status }),
      (e: any) => e.status === 400 && /status must be one of .*OPEN/.test(e.message),
      `${status} must be refused`,
    );
  }
  assert.deepEqual(calls.findMany, []);
});

test('an absent or blank status filters nothing', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID, { status: '   ' });

  assert.equal('status' in calls.findMany[0].where, false);
});

// ── limit ─────────────────────────────────────────────────────────────────────────────────────

test('limit defaults to the task page size and asks for one row over it', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID);
  await service.taskPage(OWNER_ID, PROJECT_ID, { limit: '25' });

  assert.equal(calls.findMany[0].take, 101);
  // The extra row is what decides `nextCursor` without a second count over the level.
  assert.equal(calls.findMany[1].take, 26);
});

test('a limit outside the bounds is a 400, not a clamp', async () => {
  const { service, calls } = serviceWith();

  for (const limit of ['0', '-1', '201', '1.5', 'abc', '']) {
    await assert.rejects(
      () => service.taskPage(OWNER_ID, PROJECT_ID, { limit }),
      (e: any) => e.status === 400 && /limit must be an integer from 1 to 200/.test(e.message),
      `limit=${limit} must be refused`,
    );
  }
  assert.equal(calls.findMany.length, 0);
});

test('the largest allowed limit is accepted', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID, { limit: 200 });

  assert.equal(calls.findMany[0].take, 201);
});

// ── cursor ────────────────────────────────────────────────────────────────────────────────────

test('a malformed cursor is a 400, never a Prisma error', async () => {
  const { service, calls } = serviceWith();

  const malformed = [
    'not-base64!!',
    Buffer.from('{"createdAt":"nonsense","id":"' + PARENT_ID + '"}').toString('base64url'),
    // A well-formed date with an id that is not a uuid: this is the one that would otherwise reach
    // PostgreSQL and come back as a 500 from a `::uuid` cast.
    Buffer.from('{"createdAt":"2026-08-01T12:00:00.000Z","id":"../etc"}').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
  ];
  for (const cursor of malformed) {
    await assert.rejects(
      () => service.taskPage(OWNER_ID, PROJECT_ID, { cursor }),
      (e: any) => e.status === 400 && /invalid task cursor/.test(e.message),
      `cursor ${cursor} must be refused`,
    );
  }
  assert.equal(calls.findMany.length, 0);
});

test('a cursor keeps the level’s scope and adds only the position', async () => {
  const at = new Date('2026-08-01T12:00:00.000Z');
  const { service, calls } = serviceWith({ tasks: [row('00000000-0000-7000-8000-0000000000c9')] });

  const first = await service.taskPage(OWNER_ID, PROJECT_ID, { limit: 1 });
  assert.equal(first.nextCursor, null, 'a page that did not fill has nowhere to continue');

  const cursor = Buffer.from(
    JSON.stringify({ createdAt: at.toISOString(), id: '00000000-0000-7000-8000-0000000000c9' }),
  ).toString('base64url');
  await service.taskPage(OWNER_ID, PROJECT_ID, { cursor, parentId: PARENT_ID });

  // The scope is not weakened by paging: the second page is still this owner, this project, this
  // level — with the cursor as an additional bound rather than a replacement for them.
  assert.deepEqual(calls.findMany[1].where.AND[0], {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    parentTaskId: PARENT_ID,
  });
  assert.deepEqual(calls.findMany[1].where.AND[1], {
    OR: [
      { createdAt: { lt: at } },
      { createdAt: at, id: { lt: '00000000-0000-7000-8000-0000000000c9' } },
    ],
  });
});

/**
 * The tie-break, driven end to end against a fake table that applies the same predicate
 * PostgreSQL would. Six tasks share one `createdAt` — the shape a batch create produces — so a
 * page boundary lands inside the tied group, which is exactly where a `createdAt`-only cursor
 * repeats rows and drops others.
 */
test('paging a level whose rows share a createdAt loses nothing and repeats nothing', async () => {
  const at = new Date('2026-08-01T12:00:00.000Z');
  const older = new Date('2026-07-31T09:00:00.000Z');
  const table = [
    row('00000000-0000-7000-8000-0000000000d1', { createdAt: at }),
    row('00000000-0000-7000-8000-0000000000d2', { createdAt: at }),
    row('00000000-0000-7000-8000-0000000000d3', { createdAt: at }),
    row('00000000-0000-7000-8000-0000000000d4', { createdAt: at }),
    row('00000000-0000-7000-8000-0000000000d5', { createdAt: at }),
    row('00000000-0000-7000-8000-0000000000d6', { createdAt: older }),
  ];

  const service = new ProjectsService({
    project: { findFirst: async () => ({ id: PROJECT_ID }) },
    $queryRaw: async () => [],
    task: {
      findMany: async (args: any) => {
        const bound = args.where.AND?.[1]?.OR;
        const matches = table.filter((t) => {
          if (!bound) return true;
          const [byTime, byId] = bound;
          return t.createdAt < byTime.createdAt.lt || (+t.createdAt === +byId.createdAt && t.id < byId.id.lt);
        });
        matches.sort((a, b) => +b.createdAt - +a.createdAt || (a.id < b.id ? 1 : -1));
        return matches.slice(0, args.take);
      },
    },
  } as never, {} as never);

  const seen: string[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result: any = await service.taskPage(OWNER_ID, PROJECT_ID, { limit: 2, cursor: cursor ?? undefined });
    seen.push(...result.items.map((t: any) => t.id));
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  // Every row exactly once, newest first, ties broken by descending id — and the walk ended by
  // running out of rows rather than by hitting the loop's guard.
  assert.equal(cursor, null, 'the last page must report no continuation');
  assert.deepEqual(seen, [
    '00000000-0000-7000-8000-0000000000d5',
    '00000000-0000-7000-8000-0000000000d4',
    '00000000-0000-7000-8000-0000000000d3',
    '00000000-0000-7000-8000-0000000000d2',
    '00000000-0000-7000-8000-0000000000d1',
    '00000000-0000-7000-8000-0000000000d6',
  ]);
  assert.equal(new Set(seen).size, seen.length);
});

// ── The row is a row, not a task detail ───────────────────────────────────────────────────────

test('a page row carries the tree’s fields and none of the heavy ones', async () => {
  const { service, calls } = serviceWith({
    tasks: [
      row('00000000-0000-7000-8000-0000000000e1', {
        parentTaskId: PARENT_ID,
        acceptanceCriteria: 'the migration applies to an empty database',
        dueDate: new Date('2026-09-01T00:00:00.000Z'),
        assignee: { id: '00000000-0000-7000-8000-0000000000f1', name: 'builder' },
        _count: { children: 3 },
      }),
    ],
  });

  const { items } = await service.taskPage(OWNER_ID, PROJECT_ID, { parentId: PARENT_ID });

  const select = calls.findMany[0].select;
  for (const field of [
    'id',
    'title',
    'status',
    'parentTaskId',
    'acceptanceCriteria',
    'createdAt',
    'updatedAt',
    'dueDate',
    // Both instants, and they are not the same question: `dueDate` is when the work is wanted by,
    // `runAt` is when it starts on its own. This select is independent of TASK_LIST_SELECT, so a
    // column added there does not arrive here — and a schedule the task API accepts but the
    // project tree cannot read back looks to a client exactly like a write that was lost.
    'runAt',
  ]) {
    assert.equal(select[field], true, `${field} belongs on a tree row`);
  }
  assert.deepEqual(select.assignee, { select: { id: true, name: true } });

  // The first screen of a tree is titles and status. Everything here is either unbounded
  // (comments, sessions, children) or large and unread by a row (description).
  for (const heavy of ['description', 'comments', 'sessions', 'children']) {
    assert.equal(heavy in select, false, `${heavy} must not be selected for a tree row`);
  }

  assert.equal(items[0].childCount, 3);
  assert.equal('_count' in items[0], false, 'the tally is reported as childCount');
  assert.equal('description' in items[0], false);
});

test('a scheduled row reads its schedule back, as a UTC instant', async () => {
  // The gap this closes: a schedule set through the task API was stored and then unreadable here,
  // because this select is its own list and had only `dueDate`. A client could write the field and
  // never see it again, which is indistinguishable from the write having failed.
  const runAt = new Date('2026-09-01T09:00:00.000Z');
  const { service } = serviceWith({
    tasks: [
      row('00000000-0000-7000-8000-0000000000e1', {
        runAt,
        dueDate: new Date('2026-09-30T00:00:00.000Z'),
      }),
    ],
  });

  const { items } = await service.taskPage(OWNER_ID, PROJECT_ID);

  assert.deepEqual(items[0].runAt, runAt);
  // Independent of the deadline, and not confused with it: a task can be scheduled without one
  // and given one without a schedule.
  assert.deepEqual(items[0].dueDate, new Date('2026-09-30T00:00:00.000Z'));
  // What the client actually receives. Nest JSON-serialises the Date, and the stored instant is
  // UTC, so "9am" cannot arrive as somebody's local wall clock.
  assert.equal(JSON.parse(JSON.stringify(items[0])).runAt, '2026-09-01T09:00:00.000Z');
});

test('an unscheduled row reads back as null rather than going missing', async () => {
  const { service } = serviceWith({ tasks: [row('00000000-0000-7000-8000-0000000000e2')] });

  const { items } = await service.taskPage(OWNER_ID, PROJECT_ID);

  // The overwhelming majority of rows. `null` is the answer "not scheduled"; an absent key would
  // leave a client unable to tell that from "this endpoint does not report schedules".
  assert.equal('runAt' in items[0], true);
  assert.equal(items[0].runAt, null);
});

test('childCount is a counted aggregate, scoped like the page it would open', async () => {
  const { service, calls } = serviceWith();

  await service.taskPage(OWNER_ID, PROJECT_ID);

  // `_count`, not `children: true` — the difference between one integer per row and every subtask
  // of every row on the page, which is the fan-out the level-at-a-time read exists to avoid.
  assert.deepEqual(calls.findMany[0].select._count, {
    select: { children: { where: { ownerId: OWNER_ID, projectId: PROJECT_ID } } },
  });
  assert.equal(calls.findMany[0].select.children, undefined);
  assert.equal(calls.findMany[0].include, undefined);
});

// ── The dependency fields ─────────────────────────────────────────────────────────────────────

test('every row carries all four dependency fields, and the graph is read once per page', async () => {
  const waiting = '00000000-0000-7000-8000-0000000000a7';
  const alone = '00000000-0000-7000-8000-0000000000a8';
  const { service, calls } = serviceWith({
    tasks: [row(waiting), row(alone)],
    // Only one of the two rows comes back from the graph pass — the other stands for a row the
    // query had nothing to say about, which must still read as "nothing is holding this back"
    // rather than as a row missing half its keys.
    graph: [
      {
        id: waiting,
        unmetCount: 2,
        blocksCount: 5,
        topoLevel: 3,
        prerequisiteCount: 4,
        terminalCount: 0,
        doneCount: 2,
      },
    ],
  });

  const { items } = await service.taskPage(OWNER_ID, PROJECT_ID);

  const shown = (task: unknown) => {
    const { unmetCount, blocksCount, topoLevel, dependencyState } = task as any;
    return { unmetCount, blocksCount, topoLevel, dependencyState };
  };
  // Two prerequisites still open and none of them terminal: waiting, not broken.
  assert.deepEqual(shown(items[0]), {
    unmetCount: 2,
    blocksCount: 5,
    topoLevel: 3,
    dependencyState: 'BLOCKED',
  });
  for (const field of ['unmetCount', 'blocksCount', 'topoLevel', 'dependencyState']) {
    assert.equal(field in (items[1] as any), true, `${field} must be on every row`);
  }
  assert.deepEqual(shown(items[1]), {
    unmetCount: 0,
    blocksCount: 0,
    topoLevel: 0,
    dependencyState: 'READY',
  });
  // One pass for the page, not one per row — the whole reason the level is computed in SQL.
  assert.equal(calls.graph.length, 1);
  assert.equal(calls.overlays.length, 1, 'the separate work-state overlay is still read once');
  assert.equal(
    calls.failureCoordination.length,
    1,
    'the canonical failure overlay is read once for the whole page',
  );
});

test('a page with no rows reads no graph at all', async () => {
  const { service, calls } = serviceWith({ tasks: [] });

  const { items } = await service.taskPage(OWNER_ID, PROJECT_ID);

  assert.deepEqual(items, []);
  assert.deepEqual(calls.graph, []);
});

test('the tallies decide the state by the rule the task list already uses', async () => {
  const id = '00000000-0000-7000-8000-0000000000a9';
  const tallies = (over: Record<string, number>) => ({
    id,
    unmetCount: 0,
    blocksCount: 0,
    topoLevel: 0,
    prerequisiteCount: 0,
    terminalCount: 0,
    doneCount: 0,
    ...over,
  });
  const cases: Array<[Record<string, number>, string]> = [
    // No prerequisites is not a fourth word here: nothing is holding the row back, so READY.
    [{}, 'READY'],
    [{ prerequisiteCount: 2, doneCount: 2 }, 'READY'],
    [{ prerequisiteCount: 2, doneCount: 1 }, 'BLOCKED'],
    // A cancelled prerequisite is not "unmet" — it will never be met — so it escalates even
    // though every other prerequisite is done.
    [{ prerequisiteCount: 2, doneCount: 1, terminalCount: 1 }, 'BLOCKED_FAILED'],
  ];

  for (const [over, expected] of cases) {
    const { service } = serviceWith({ tasks: [row(id)], graph: [tallies(over)] });
    const { items } = await service.taskPage(OWNER_ID, PROJECT_ID);
    assert.equal((items[0] as any).dependencyState, expected, JSON.stringify(over));
  }
});

// ── The route ─────────────────────────────────────────────────────────────────────────────────

test('the controller resolves parentId through PublicIdPipe', () => {
  class Probe {
    probe(@Query('q') _q: string) {}
  }
  const queryKind = Number(
    Object.keys(
      Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as Record<string, unknown>,
    )[0].split(':')[0],
  );
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ProjectsController, 'taskPage') as Record<
    string,
    { data?: unknown; pipes?: unknown[] }
  >;

  // A parent id arrives as the base62 short form `parentTaskId` is encoded as on the way out, so
  // without the pipe it reaches a `::uuid` column as a 500 the caller cannot act on.
  const parent = Object.entries(args).find(
    ([key, a]) => Number(key.split(':')[0]) === queryKind && a.data === 'parentId',
  );
  assert.ok(parent, 'taskPage must accept parentId as a query parameter');
  assert.ok(
    (parent[1].pipes ?? []).some((p) => p === PublicIdPipe || p instanceof PublicIdPipe),
    'parentId must resolve through PublicIdPipe',
  );
});
