import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import { TasksService } from './tasks.service';

/**
 * The idempotency winner, and what makes a found row THIS request's earlier attempt.
 *
 * `idempotency_key` is one unique column shared by every subsystem that writes a task — §13.2's
 * defect filer and §7.3's verification filing both key rows in it under their own templates — so
 * "a row exists under this key" is not "this request already ran". Four facts decide it: the owner,
 * the operation, the normalised payload and the session that asked. A row failing any of them is a
 * typed 409 with nothing written.
 *
 * The reason this file exists as well as `task-idempotency.spec.ts`: there are FOUR paths that can
 * find a winner — the pre-read, the batch's find-or-create, the single create's P2002 read-back and
 * the batch's supersession reconstruction — and the last two are the concurrent ones. A validator
 * the happy path runs and the race path skips is a validator that only ever guards the case nobody
 * was attacking, so every case below is asserted on the RACE path as well as the sequential one.
 */

const OWNER = '00000000-0000-7000-8000-000000000b01';
const OTHER_OWNER = '00000000-0000-7000-8000-000000000b02';
const SESSION = '00000000-0000-7000-8000-000000000b03';
const OTHER_SESSION = '00000000-0000-7000-8000-000000000b04';
const TURN = '00000000-0000-7000-8000-000000000b05';
const WINNER_ID = '00000000-0000-7000-8000-000000000b06';
const PREDECESSOR = '00000000-0000-7000-8000-000000000b07';

/**
 * `TasksService.taskIdempotencyKey`'s preimage, so a fixture can answer `findUnique` truthfully.
 *
 * `task-create` and NOT the TypeScript spelling of the operation. Every key already committed was
 * hashed over this byte, and a key template that changes with a rename is a template that finds no
 * winner for any turn that spans the upgrade — one silent duplicate per in-flight turn, per deploy.
 * This spelling IS the compatibility test: every case below looks the row up the way a row written
 * by the previous binary is filed.
 */
const FROZEN_OPERATION_TAG = 'task-create';

function keyFor(title: string, description = ''): string {
  return createHash('sha256')
    .update(JSON.stringify([FROZEN_OPERATION_TAG, SESSION, TURN, title.trim(), description.trim()]))
    .digest('hex');
}

type Row = Record<string, unknown>;

/** A row that IS this request's earlier attempt: same owner, same session, same payload. */
function legitimateWinner(title = 'work', description?: string | null): Row {
  return {
    id: WINNER_ID,
    ownerId: OWNER,
    creatorSessionId: SESSION,
    title,
    description: description ?? null,
    idempotencyKey: keyFor(title, description ?? ''),
    projectId: null,
  };
}

interface FixtureOptions {
  /** Rows visible from the start — the SEQUENTIAL replay, where the pre-read finds the winner. */
  rows?: (key: string) => Row | null;
  /**
   * Rows that become visible only once an INSERT has been attempted — the RACE.
   *
   * Modelled this way rather than by counting lookups, because counting is how a race test quietly
   * stops being one: a single create asks once before the INSERT and a batch asks twice (the
   * pre-read AND the find-or-create inside its transaction), so a fixture tuned to "miss the first
   * call" hands the batch its winner before `create` is ever reached — no INSERT, no P2002, no
   * read-back, and a green test for a path that never ran. Here nothing is visible until this
   * write actually tries to insert, which is exactly when the winner would have committed.
   */
  appearsOnInsert?: (key: string) => Row | null;
}

function fixture(options: FixtureOptions = {}) {
  const { rows = () => null, appearsOnInsert } = options;
  const writes: Row[] = [];
  const inserts: Row[] = [];
  const task = {
    findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
      const visible = rows(where.idempotencyKey);
      if (visible) return visible;
      if (appearsOnInsert && inserts.length) return appearsOnInsert(where.idempotencyKey);
      return null;
    },
    // The predecessor as the WINNER left it: already superseded by the row that won the index.
    // SU7-c reads this to decide whether a replay may stand in for the link it claimed.
    findFirst: async () => ({
      id: PREDECESSOR,
      ownerId: OWNER,
      projectId: null,
      status: 'OPEN',
      supersededByTaskId: WINNER_ID,
      terminalReason: 'SUPERSEDED',
    }),
    create: async ({ data }: { data: Row }) => {
      inserts.push(data);
      if (appearsOnInsert) {
        // The index firing is the winner becoming visible: one event, seen from this side.
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['idempotency_key'] },
        });
      }
      writes.push(data);
      return { ...data, id: WINNER_ID, parentTaskId: null, verifiesTaskId: null };
    },
  };
  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    // No project anywhere in this file: the scope contract is another spec's subject, and a write
    // that names no project is not on its write surface at all.
    project: { findFirst: async () => null, findMany: async () => [] },
    taskList: { findMany: async () => [] },
    session: {
      findFirst: async () => ({ id: SESSION, taskId: null, task: null, coordinatorForProject: null }),
    },
    conversationTurn: { findFirst: async () => ({ id: TURN }) },
    task,
    taskDependency: { createMany: async () => ({ count: 0 }) },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged: () => undefined,
    publishForUser: () => undefined,
  } as never);
  return { service, writes, inserts };
}

const AGENT = { type: CreatorType.AGENT, id: OWNER };

async function conflictOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
    const body = error.getResponse() as { message?: string } | string;
    return typeof body === 'string' ? body : (body.message ?? '');
  }
  throw new assert.AssertionError({ message: 'the write was not refused' });
}

const create = (service: TasksService, dto: Record<string, unknown> = {}) =>
  service.create(OWNER, { title: 'work', ...dto } as never, AGENT, SESSION);

// ── the sequential path: the pre-read ───────────────────────────────────────────────────────

test('a legitimate replay returns the first row and writes nothing', async () => {
  const first = legitimateWinner();
  const { service, writes } = fixture({ rows: () => first });

  const replay = await create(service);

  assert.equal((replay as { id: string }).id, WINNER_ID);
  assert.deepEqual(writes, []);
});

// The whole reason this is a 409 and not a miss: `idempotency_key` is unique across the table, so
// treating a foreign row as "nothing here" sends this write into an INSERT that can only fail on
// the index — a raw driver error where an answer was owed. Returning it would be worse.
test('a key held by another account is refused, and says nothing about the row', async () => {
  const foreign = { ...legitimateWinner(), ownerId: OTHER_OWNER };
  const { service, writes } = fixture({ rows: () => foreign });

  const message = await conflictOf(() => create(service));


  assert.match(message, /different account/);
  assert.doesNotMatch(message, new RegExp(WINNER_ID));
  assert.doesNotMatch(message, /work/);
  assert.deepEqual(writes, []);
});

// A row under our key whose payload is not ours was written by something other than this request —
// a repair script, a raw fault, another operation reusing the column. It cannot stand in for it.
test('a key holding a different payload is refused', async () => {
  const impostor = { ...legitimateWinner(), title: 'something else entirely' };
  const { service, writes } = fixture({ rows: () => impostor });

  assert.match(await conflictOf(() => create(service)), /different operation or payload/);
  assert.deepEqual(writes, []);
});

test('a key holding a different session is refused', async () => {
  const impostor = { ...legitimateWinner(), creatorSessionId: OTHER_SESSION };
  const { service, writes } = fixture({ rows: () => impostor });

  assert.match(await conflictOf(() => create(service)), /different session/);
  assert.deepEqual(writes, []);
});

// The operation is an input to the key, not a literal at the call site, which is what lets the
// winner be REBUILT and compared. A row filed under a key another operation's template produced —
// §13.2's defect filer and §7.3's verification filing both write this column — is not this write.
test('a row filed under another operation\'s key template is refused', async () => {
  const otherOperation = {
    ...legitimateWinner(),
    idempotencyKey: `pc:v1:some-project:file-verification-task:${WINNER_ID}:3`,
  };
  const { service, writes } = fixture({ rows: () => otherOperation });

  assert.match(await conflictOf(() => create(service)), /different operation or payload/);
  assert.deepEqual(writes, []);
});

// ── the concurrent path: the single create's P2002 read-back ────────────────────────────────
//
// The pre-read MISSES (call 1) and the row appears before the INSERT — the interleaving the index
// exists for. Everything above has to hold here too, and this is the path that used to skip it.

/** Every key resolves to `row` once this write has tried to insert, and to nothing before. */
const raced = (row: Row | null) => () => row;

/**
 * The guard that keeps a race test a race test.
 *
 * If the winner is visible too early the write never reaches its INSERT, the index never fires, and
 * the read-back under test never runs — while the assertions above it still pass, because the
 * sequential path returns the same row. Every case below asserts an INSERT was actually attempted,
 * so "this covers the concurrent path" is a fact about the run rather than a claim in a comment.
 */
function assertRaced(inserts: Row[]): void {
  assert.ok(inserts.length > 0,
    'no INSERT was attempted — the winner was visible before the write reached the index, so the '
      + 'P2002 read-back never ran and this case is not testing the concurrent path');
}

test('a P2002 read-back returns the winner when the winner really is this write', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced(legitimateWinner()),
  });

  const replay = await create(service);

  assertRaced(inserts);
  assert.equal((replay as { id: string }).id, WINNER_ID);
  assert.deepEqual(writes, [], 'the losing attempt rolled back and wrote nothing');
});

test('a P2002 read-back refuses a row belonging to another account', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), ownerId: OTHER_OWNER }),
  });

  const message = await conflictOf(() => create(service));

  assertRaced(inserts);

  assert.match(message, /different account/);
  assert.doesNotMatch(message, new RegExp(WINNER_ID));
  assert.deepEqual(writes, []);
});

test('a P2002 read-back refuses a row whose payload is not this write\'s', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), title: 'not what was asked for' }),
  });

  assert.match(await conflictOf(() => create(service)), /different operation or payload/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

test('a P2002 read-back refuses a row written by another session', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), creatorSessionId: OTHER_SESSION }),
  });

  assert.match(await conflictOf(() => create(service)), /different session/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

// ── the concurrent path: the batch's supersession reconstruction ────────────────────────────
//
// Reached only when a batch claiming a supersession loses the index. It returns rows IN PLACE of
// the batch's own result, so a row it fails to validate is handed straight back to the caller as
// that item's task.

const batch = (service: TasksService) =>
  service.createMany(
    OWNER,
    { tasks: [{ title: 'work', supersedesTaskId: PREDECESSOR }] } as never,
    AGENT,
    SESSION,
  );

/** The ordinary shape: no supersession, nothing special — the one that had no authority at all. */
const plainBatch = (service: TasksService, titles = ['work']) =>
  service.createMany(
    OWNER,
    { tasks: titles.map((title) => ({ title })) } as never,
    AGENT,
    SESSION,
  );

test('the batch reconstruction returns the winner when it really is this write', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced(legitimateWinner()),
  });

  const rows = await batch(service);

  assertRaced(inserts);
  assert.deepEqual(rows.map((row) => row.id), [WINNER_ID]);
  assert.deepEqual(writes, []);
});

test('the batch reconstruction refuses a row belonging to another account', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), ownerId: OTHER_OWNER }),
  });

  const message = await conflictOf(() => batch(service));

  assertRaced(inserts);

  assert.match(message, /different account/);
  assert.doesNotMatch(message, new RegExp(WINNER_ID));
  assert.deepEqual(writes, []);
});

test('the batch reconstruction refuses a row whose payload is not this item\'s', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), title: 'a different item entirely' }),
  });

  assert.match(await conflictOf(() => batch(service)), /different operation or payload/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

// ── the ordinary batch, which had no concurrent authority at all ────────────────────────────
//
// The reconstruction used to be gated on `hasSupersessions`, so a plain batch that lost the index
// fell straight through to the FK translator and surfaced the constraint as an error. The one shape
// a caller could have retried safely was the one told to give up.

test('a plain batch that loses the index returns its validated winners', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced(legitimateWinner()),
  });

  const rows = await plainBatch(service);

  assertRaced(inserts);
  assert.deepEqual(rows.map((row) => row.id), [WINNER_ID]);
  assert.deepEqual(writes, []);
});

test('a plain batch refuses a foreign row exactly as a single create does', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), ownerId: OTHER_OWNER }),
  });

  const message = await conflictOf(() => plainBatch(service));

  assertRaced(inserts);

  assert.match(message, /different account/);
  assert.doesNotMatch(message, new RegExp(WINNER_ID));
  assert.deepEqual(writes, []);
});

test('a plain batch refuses a row written by another session', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), creatorSessionId: OTHER_SESSION }),
  });

  assert.match(await conflictOf(() => plainBatch(service)), /different session/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

test('a plain batch refuses a row filed under another operation\'s key template', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({
      ...legitimateWinner(),
      idempotencyKey: `pc:v1:some-project:verdict:${WINNER_ID}:2`,
    }),
  });

  assert.match(await conflictOf(() => plainBatch(service)), /different operation or payload/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

test('a supersession batch refuses a row written by another session', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({ ...legitimateWinner(), creatorSessionId: OTHER_SESSION }),
  });

  assert.match(await conflictOf(() => batch(service)), /different session/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

test('a supersession batch refuses a row filed under another operation\'s key template', async () => {
  const { service, writes, inserts } = fixture({
    appearsOnInsert: raced({
      ...legitimateWinner(),
      idempotencyKey: `pc:v1:some-project:verdict:${WINNER_ID}:2`,
    }),
  });

  assert.match(await conflictOf(() => batch(service)), /different operation or payload/);
  assertRaced(inserts);
  assert.deepEqual(writes, []);
});

// All of them or none: a batch is all-or-nothing on the way in, and answering item by item on the
// way out would let a half-identified batch report half a success.
test('a batch identifiable only in part is a conflict, not a partial answer', async () => {
  const only = keyFor('a');
  const { service, writes, inserts } = fixture({
    appearsOnInsert: (key) => (key === only ? legitimateWinner('a') : null),
  });

  const message = await conflictOf(() => plainBatch(service, ['a', 'b']));

  assert.match(message, /cannot all be identified/);
  assert.deepEqual(writes, []);
});

// A P2002 with nothing of this batch under any of its keys was some OTHER constraint — a project
// FK, a supersession guard. Inventing a replay for it would report success for rows nobody wrote.
test('a P2002 that is not this batch\'s own keys surfaces as what it actually was', async () => {
  const { service, writes, inserts } = fixture({ appearsOnInsert: () => null });

  await assert.rejects(
    () => plainBatch(service),
    (error: unknown) => {
      assert.ok(!(error instanceof ConflictException)
        || !/cannot all be identified/.test(String((error.getResponse() as { message?: string }).message)),
        'a foreign constraint must not be reported as an unidentifiable replay');
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

// ── rolling upgrade ─────────────────────────────────────────────────────────────────────────

// The digest of a known input, spelled out, and asserted against the SERVICE rather than against
// this file's own helper: a row filed under this exact string has to be found. It is the only thing
// standing between a rename of the operation descriptor and every key in the table silently
// becoming unreachable.
const FROZEN_KEY_FOR_WORK = 'f6f6a3af6cd0e50881d10596504de22689cccd1873b33845f00d1b7721fc3347';

test('the key preimage is byte-frozen, so keys written by the previous binary still match', async () => {
  assert.equal(keyFor('work'), FROZEN_KEY_FOR_WORK, 'this file and the service disagree');
  const onDisk = { ...legitimateWinner(), idempotencyKey: FROZEN_KEY_FOR_WORK };
  const { service, writes } = fixture({
    rows: (key) => (key === FROZEN_KEY_FOR_WORK ? onDisk : null),
  });

  const replay = await create(service);

  assert.equal((replay as { id: string }).id, WINNER_ID,
    'the idempotency key template changed — every key already committed is now unreachable, and '
      + 'every turn redelivered across the upgrade will create duplicates');
  assert.deepEqual(writes, []);
});

test('a row committed before the upgrade is still this request\'s winner after it', async () => {
  // Written by the old binary: filed under the old preimage, with no knowledge of a descriptor.
  const preUpgrade = {
    id: WINNER_ID,
    ownerId: OWNER,
    creatorSessionId: SESSION,
    title: 'work',
    description: null,
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify(['task-create', SESSION, TURN, 'work', '']))
      .digest('hex'),
    projectId: null,
  };
  const { service, writes } = fixture({ rows: () => preUpgrade });

  const replay = await create(service);

  assert.equal((replay as { id: string }).id, WINNER_ID, 'the response-loss replay found its row');
  assert.deepEqual(writes, [], 'and did not create a second one');
});

// ── one validator, not four ─────────────────────────────────────────────────────────────────

// The property that keeps the four paths from drifting: exactly one place reads the column, and
// everything else asks it. A second `findUnique` on this key is a second answer to one question.
test('only one place in the service reads a task by idempotency key', () => {
  const source = readFileSync(path.join(__dirname, '../../src/tasks/tasks.service.ts'), 'utf8');
  const reads = source.match(/findUnique\(\{\s*where:\s*\{\s*idempotencyKey/g) ?? [];
  assert.equal(reads.length, 1,
    'every winner read must go through idempotencyWinner — a direct findUnique is a path that '
      + 'skips the owner, operation, payload and session checks');
});
