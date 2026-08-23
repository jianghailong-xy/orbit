import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { TasksService } from './tasks.service';
import { derivedScopeToken } from '../projects/project-scope-admission';

/**
 * Unit L3 — the scope contract, wired.
 *
 * `project-scope-admission.spec.ts` proves the rules decide correctly. This file proves the three
 * things only the service can be wrong about:
 *
 *   - the write actually lands in the project the SERVER derived, not the one the caller named;
 *   - a refusal happens BEFORE anything is written, locked or retried — §0's incident is a batch of
 *     rows in the wrong project, and a gate that refuses after the insert has not prevented it;
 *   - the owner's own path is untouched, down to the queries it does not make (AC5).
 *
 * The scope is derived from the session row on every write and never cached, which is the whole of
 * AC3: a rotation, a restart and a takeover are not events this code has to hear about — they are
 * simply a different answer the next time it asks.
 */

const OWNER = '00000000-0000-7000-8000-000000000a01';
const COORDINATED = '00000000-0000-7000-8000-000000000a02';
const OTHER = '00000000-0000-7000-8000-000000000a03';
const SESSION = '00000000-0000-7000-8000-000000000a04';
const RUNNING_TASK = '00000000-0000-7000-8000-000000000a05';
const CREATED = '00000000-0000-7000-8000-000000000a06';

type SessionRow = {
  id: string;
  taskId: string | null;
  task: { projectId: string | null } | null;
  coordinatorForProject: { id: string } | null;
};

const COORDINATOR_OF_COORDINATED: SessionRow = {
  id: SESSION,
  taskId: null,
  task: null,
  coordinatorForProject: { id: COORDINATED },
};

/** A run executing a task inside COORDINATED: scoped by the work it is doing, not by a binding. */
const WORKER_IN_COORDINATED: SessionRow = {
  id: SESSION,
  taskId: RUNNING_TASK,
  task: { projectId: COORDINATED },
  coordinatorForProject: null,
};

/** The shape a rotated-away session has: it coordinates nothing and executes nothing. */
const ROTATED_AWAY: SessionRow = {
  id: SESSION,
  taskId: null,
  task: null,
  coordinatorForProject: null,
};

interface FixtureOptions {
  session?: SessionRow | null;
  /** `project_runtime.coordinator_generation` — the counter a rotation advances. */
  generation?: bigint;
  /** Statuses by project id. A project absent from here is one the read did not find. */
  status?: Record<string, string>;
  /** Rows already committed by THIS turn, by title — the replay cases (see `keyFor`). */
  winners?: Record<string, Record<string, unknown>>;
  turnId?: string | null;
}

const TURN = '00000000-0000-7000-8000-000000000a07';

/**
 * `TasksService.taskIdempotencyKey`'s template, so the fixture can answer `findUnique` the way the
 * database would. Pinned rather than reached into: if the template changes, the assertion below
 * fails here instead of every replay test quietly stopping to test replays.
 */
function keyFor(title: string, description = ''): string {
  return createHash('sha256')
    .update(JSON.stringify(['task-create', SESSION, TURN, title.trim(), description.trim()]))
    .digest('hex');
}

function fixture(options: FixtureOptions = {}) {
  const {
    session = COORDINATOR_OF_COORDINATED,
    generation = 4n,
    status = { [COORDINATED]: 'OPEN', [OTHER]: 'OPEN' },
    winners = {},
    turnId = null,
  } = options;
  // Completed the way the database always completes them: a task row has an owner, a creating
  // session and the key it is filed under, and the winner validator reads all three. A double that
  // omits them is modelling a row PostgreSQL cannot hold.
  const byKey = new Map(
    Object.entries(winners).map(([title, row]) => [keyFor(title), {
      ownerId: OWNER,
      creatorSessionId: SESSION,
      title,
      description: null,
      idempotencyKey: keyFor(title),
      ...row,
    }]),
  );
  const writes: Array<Record<string, unknown>> = [];
  const transactions: number[] = [];
  const projectFindMany: unknown[] = [];
  const sessionFindFirst: unknown[] = [];
  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions.push(1);
      return fn(prisma);
    },
    $queryRaw: async () => [],
    project: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        (status[where.id] ? { id: where.id, runtime: { coordinatorGeneration: generation } } : null),
      findMany: async (args: { where: { id: { in: string[] } } }) => {
        projectFindMany.push(args);
        return args.where.id.in
          .filter((id) => status[id])
          .map((id) => ({ id, status: status[id] }));
      },
    },
    taskList: { findMany: async () => [] },
    session: {
      findFirst: async (args: unknown) => {
        sessionFindFirst.push(args);
        return session;
      },
    },
    conversationTurn: { findFirst: async () => (turnId ? { id: turnId } : null) },
    task: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        byKey.get(where.idempotencyKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...data, id: CREATED, parentTaskId: null, verifiesTaskId: null };
      },
    },
    taskDependency: { createMany: async () => ({ count: 0 }) },
  };
  const realtime = { publishTaskChanged: () => undefined } as never;
  const service = new TasksService(prisma as never, {} as never, realtime);
  return { service, writes, transactions, projectFindMany, sessionFindFirst };
}

const AGENT = { type: CreatorType.AGENT, id: OWNER };

async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
    return error.getResponse() as Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'the write was not refused' });
}

async function observing<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.ORBIT_PROJECT_SCOPE_MODE;
  process.env.ORBIT_PROJECT_SCOPE_MODE = 'observe';
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.ORBIT_PROJECT_SCOPE_MODE;
    else process.env.ORBIT_PROJECT_SCOPE_MODE = before;
  }
}

// ── AC1: the incident, refused, with nothing left behind ────────────────────────────────────

test('a coordinator of one project filing into another is refused, and writes nothing', async () => {
  const { service, writes, transactions } = fixture();

  const body = await refusalOf(() => service.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  ));

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(body.rule, 'R7_UNDECLARED_CROSSING');
  assert.equal(body.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
  assert.deepEqual(body.scope, { projectId: COORDINATED });
  assert.deepEqual(body.target, { projectId: OTHER });
  // Zero side effects: no row, and no transaction was even opened — a refusal that has taken the
  // owner lock has already cost every other writer on this account.
  assert.deepEqual(writes, []);
  assert.deepEqual(transactions, []);
});

test('the same refusal is deterministic — the same world answers the same way every time', async () => {
  const answers: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { service } = fixture();
    answers.push(await refusalOf(() => service.create(
      OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
    )));
  }
  assert.equal(new Set(answers.map((a) => JSON.stringify(a))).size, 1);
});

// ── the binding: the server decides where the work is filed ─────────────────────────────────

test('a coordinator create that names no project is filed under the project it coordinates', async () => {
  const { service, writes } = fixture();

  await service.create(OWNER, { title: 'work' } as never, AGENT, SESSION);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].projectId, COORDINATED);
});

test('a run executing a task is scoped by that task\'s project, and files into it', async () => {
  const { service, writes } = fixture({ session: WORKER_IN_COORDINATED });

  await service.create(OWNER, { title: 'work' } as never, AGENT, SESSION);

  assert.equal(writes[0].projectId, COORDINATED);
});

test('a run executing a task cannot file into a different project', async () => {
  const { service, writes } = fixture({ session: WORKER_IN_COORDINATED });

  const body = await refusalOf(() => service.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  ));

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.deepEqual(writes, []);
});

// An agent session that coordinates nothing and executes nothing still writes ordinary,
// unattributed tasks exactly as it always has: no goal is involved, so no goal's count moves.
test('an unscoped agent session filing work under no project is untouched', async () => {
  const { service, writes } = fixture({ session: ROTATED_AWAY });

  await service.create(OWNER, { title: 'work' } as never, AGENT, SESSION);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].projectId, undefined);
});

// ── AC3: rotation, restart and takeover ─────────────────────────────────────────────────────

// The scope is re-derived from the session row on every write. A session the project no longer
// points at simply stops having one, without anything having to notice the rotation happened.
test('a session rotated away from its project can no longer write into it', async () => {
  const { service, writes } = fixture({ session: ROTATED_AWAY });

  const body = await refusalOf(() => service.create(
    OWNER, { title: 'work', projectId: COORDINATED } as never, AGENT, SESSION,
  ));

  assert.equal(body.rule, 'R5_NO_SCOPE');
  assert.equal(body.requiredAction, 'YIELD_TO_CURRENT_SCOPE');
  assert.deepEqual(writes, []);
});

// The generation is the half a still-bound session cannot see moving. Presenting the one it was
// started under is what makes a takeover legible as a takeover rather than as a mismatch.
test('a token carrying a superseded generation is told to yield, not to retry', async () => {
  const { service, writes } = fixture({ generation: 9n });

  const body = await refusalOf(() => service.create(
    OWNER,
    {
      title: 'work',
      projectId: COORDINATED,
      scopeToken: derivedScopeToken({ projectId: COORDINATED, generation: '4' }),
    } as never,
    AGENT,
    SESSION,
  ));

  assert.equal(body.code, 'COORDINATOR_GENERATION_MOVED');
  assert.equal(body.responsible, 'SYSTEM');
  assert.equal(body.blockerKind, null);
  assert.deepEqual(writes, []);
});

test('a token that agrees with the row it was derived from writes normally', async () => {
  const { service, writes } = fixture({ generation: 9n });

  await service.create(
    OWNER,
    {
      title: 'work',
      scopeToken: derivedScopeToken({ projectId: COORDINATED, generation: '9' }),
    } as never,
    AGENT,
    SESSION,
  );

  assert.equal(writes[0].projectId, COORDINATED);
});

// ── AC4: mixed versions ─────────────────────────────────────────────────────────────────────

// §8 CM1. A runner too old to carry a token is scoped exactly like a new one; downgrading buys no
// authority, and a session id that does not resolve becomes an agent with NO scope rather than an
// absent one — which would be the owner, whom §4 R1 exempts from everything here.
test('an old client with no token is scoped the same way, and an unknown session is not the owner', async () => {
  const { service: old, writes: oldWrites } = fixture();
  const oldBody = await refusalOf(() => old.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  ));

  const { service: unknown, writes: unknownWrites } = fixture({ session: null });
  const unknownBody = await refusalOf(() => unknown.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  ));

  assert.equal(oldBody.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(unknownBody.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(unknownBody.rule, 'R5_NO_SCOPE');
  assert.deepEqual(oldWrites, []);
  assert.deepEqual(unknownWrites, []);
});

// ── AC5: the explicit user path ─────────────────────────────────────────────────────────────

test('the owner files into any of their own projects, and pays no query for the boundary', async () => {
  const { service, writes, projectFindMany, sessionFindFirst } = fixture();

  await service.create(OWNER, { title: 'work', projectId: OTHER } as never);

  assert.equal(writes[0].projectId, OTHER);
  // R1 answers before any world is read, so the user's create issues neither of this unit's reads.
  assert.deepEqual(sessionFindFirst, []);
  assert.deepEqual(projectFindMany, []);
});

// ── §8 CM2: the observation phase ───────────────────────────────────────────────────────────

test('observe writes exactly what the caller asked for, and binds nothing', async () => {
  const { service, writes } = fixture();

  await observing(() => service.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  ));
  await observing(() => service.create(OWNER, { title: 'loose' } as never, AGENT, SESSION));

  assert.equal(writes[0].projectId, OTHER, 'observe refuses nothing');
  assert.equal(writes[1].projectId, undefined, 'observe binds nothing either');
});

// ── AC2: the batch is atomic, and a retry does not double up ────────────────────────────────

test('one out-of-scope item refuses the whole batch, before it is opened', async () => {
  const { service, writes, transactions } = fixture();

  const body = await refusalOf(() => service.createMany(
    OWNER,
    {
      tasks: [
        { title: 'a' },
        { title: 'b', projectId: OTHER },
        { title: 'c' },
      ],
    } as never,
    AGENT,
    SESSION,
  ));

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.deepEqual(writes, [], 'the items before the bad one must not be written');
  assert.deepEqual(transactions, []);
});

test('every item of an in-scope batch is filed under the derived project', async () => {
  const { service, writes } = fixture();

  await service.createMany(
    OWNER,
    { tasks: [{ title: 'a' }, { title: 'b', projectId: COORDINATED }] } as never,
    AGENT,
    SESSION,
  );

  assert.deepEqual(writes.map((row) => row.projectId), [COORDINATED, COORDINATED]);
});

// ── SC4: the winner is frozen, and the gate cannot re-decide it ─────────────────────────────
//
// All of these run in ENFORCE, which is where the ordering actually matters: in observe nothing is
// refused, so a gate placed before the winner lookup would look correct and still be wrong.

const COMMITTED_IN_A = { id: CREATED, projectId: COORDINATED, title: 'work' };

// The response-loss case. The first request committed under scope A and the answer never arrived;
// by the time the caller retries, the session has been rotated away and holds no scope at all. A
// gate ahead of the lookup refuses this with R5 — and the caller can then NEVER learn that its work
// exists, which is how one lost response becomes a duplicate task filed by hand.
test('after a lost response and a rotation, the same key still returns the row it committed', async () => {
  const { service, writes, transactions } = fixture({
    session: ROTATED_AWAY,
    turnId: TURN,
    winners: { work: COMMITTED_IN_A },
  });

  const replay = await service.create(OWNER, { title: 'work' } as never, AGENT, SESSION);

  assert.equal((replay as { id: string }).id, CREATED);
  assert.equal((replay as { projectId: string }).projectId, COORDINATED);
  assert.deepEqual(writes, [], 'a replay writes no second row');
  assert.deepEqual(transactions, []);
});

// The A/B counterexample the other way round. The retry's session now coordinates B, so a gate
// ahead of the lookup ADMITS it — for B — and the lookup then hands back the row from A: an
// admission whose answer contradicts its own result, and a caller told its work is in B when it is
// in A. Winner first, and the question is never asked.
test('a retry whose scope has drifted to another project still lands on the first row', async () => {
  const { service, writes } = fixture({
    session: { id: SESSION, taskId: null, task: null, coordinatorForProject: { id: OTHER } },
    turnId: TURN,
    winners: { work: COMMITTED_IN_A },
  });

  const replay = await service.create(OWNER, { title: 'work' } as never, AGENT, SESSION);

  assert.equal((replay as { projectId: string }).projectId, COORDINATED,
    'the committed project stands; the drifted scope does not rewrite it');
  assert.deepEqual(writes, [], 'nothing is written into the project the scope drifted to');
});

// Same drift, but the retry names the new project explicitly. It is still the same key, so it is
// still the same write — a retry is not a second chance at a project the first attempt did not take.
test('a retry naming a different project is still the same write, not a new one', async () => {
  const { service, writes } = fixture({
    session: { id: SESSION, taskId: null, task: null, coordinatorForProject: { id: OTHER } },
    turnId: TURN,
    winners: { work: COMMITTED_IN_A },
  });

  const replay = await service.create(
    OWNER, { title: 'work', projectId: OTHER } as never, AGENT, SESSION,
  );

  assert.equal((replay as { projectId: string }).projectId, COORDINATED);
  assert.deepEqual(writes, []);
});

// A key held by another tenant is not "no winner": the column is unique across the whole table, so
// treating it as a miss sends this write into an INSERT that can only fail on the index, and the
// caller gets a raw driver error instead of an answer. Returning the row would be worse.
test('a key that belongs to another account is a typed conflict, not a miss and not a read', async () => {
  const { service, writes } = fixture({
    turnId: TURN,
    winners: { work: { ...COMMITTED_IN_A, ownerId: '00000000-0000-7000-8000-0000000009ff' } },
  });

  await assert.rejects(
    () => service.create(OWNER, { title: 'work' } as never, AGENT, SESSION),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, `expected a conflict, got ${error}`);
      // Nothing about the other account travels back — not its id, not its task.
      assert.doesNotMatch(
        JSON.stringify(error.getResponse()),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

// The batch says the same thing item by item. Every item of this turn already committed, and the
// session has since been rotated away: nothing is refused, nothing is written, and the rows the
// first attempt created are what comes back.
test('a batch replayed after a rotation returns its own rows and writes nothing', async () => {
  const { service, writes, transactions } = fixture({
    session: ROTATED_AWAY,
    turnId: TURN,
    winners: {
      a: { id: CREATED, projectId: COORDINATED, title: 'a' },
      b: { id: RUNNING_TASK, projectId: COORDINATED, title: 'b' },
    },
  });

  const rows = await service.createMany(
    OWNER, { tasks: [{ title: 'a' }, { title: 'b' }] } as never, AGENT, SESSION,
  );

  assert.deepEqual(rows.map((row) => row.id), [CREATED, RUNNING_TASK]);
  assert.deepEqual(rows.map((row) => row.projectId), [COORDINATED, COORDINATED]);
  assert.deepEqual(writes, []);
  assert.deepEqual(transactions, [1], 'the batch still opens one transaction to read its winners');
});

// A replay is not a licence for the items beside it. The committed item comes back untouched; the
// NEW item is a new ownership claim and is refused, and the batch is all-or-nothing either way.
test('a replayed item does not admit a fresh out-of-scope item beside it', async () => {
  const { service, writes } = fixture({
    turnId: TURN,
    winners: { a: { id: CREATED, projectId: COORDINATED, title: 'a' } },
  });

  const body = await refusalOf(() => service.createMany(
    OWNER,
    { tasks: [{ title: 'a' }, { title: 'b', projectId: OTHER }] } as never,
    AGENT,
    SESSION,
  ));

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.deepEqual(writes, []);
});

// ── the update path ─────────────────────────────────────────────────────────────────────────

// `get` is stubbed rather than faked: it hydrates comments, sessions, dependencies and epochs, and
// reproducing that here would test the fixture. What this asserts is the gate, and the gate reads
// exactly one thing off the task — which project owns it.
function updateService(currentProjectId: string | null) {
  const built = fixture();
  const updates: unknown[] = [];
  (built.service as unknown as Record<string, unknown>).get = async (_owner: string, id: string) =>
    ({ id, projectId: currentProjectId, parentTaskId: null, verifiesTaskId: null });
  (built.service as unknown as { prisma: Record<string, unknown> }).prisma.task = {
    ...(built.service as unknown as { prisma: { task: Record<string, unknown> } }).prisma.task,
    update: async (args: unknown) => {
      updates.push(args);
      return { id: RUNNING_TASK };
    },
  };
  return { ...built, updates };
}

test('a coordinator may not edit a task that belongs to another project', async () => {
  const { service, updates } = updateService(OTHER);

  const body = await refusalOf(() => service.update(
    OWNER, RUNNING_TASK, { title: 'renamed' } as never, SESSION,
  ));

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(body.rule, 'R6_OUT_OF_SCOPE');
  assert.deepEqual(updates, []);
});

test('a coordinator may not move a task out of the project that counts it', async () => {
  const { service, updates } = updateService(COORDINATED);

  const body = await refusalOf(() => service.update(
    OWNER, RUNNING_TASK, { projectId: null } as never, SESSION,
  ));

  assert.equal(body.code, 'UNMAPPED_PROJECT_WORK');
  assert.equal(body.responsible, 'USER');
  assert.equal(body.blockerKind, 'AWAITING_USER_INPUT');
  assert.deepEqual(updates, []);
});
