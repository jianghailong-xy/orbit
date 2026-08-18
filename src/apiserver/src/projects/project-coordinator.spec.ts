import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
/** What that project is called everywhere the agent can see it, `project_get` included. */
const PROJECT_PUBLIC_ID = uuidToBase62(PROJECT_ID);

const SESSION_NEW = 'session-new';
const SESSION_BOUND = 'session-bound';
const SESSION_THEIRS = 'session-theirs';
const WORKSPACE_TASKS = 'workspace-tasks';
const WORKSPACE_OTHER = 'workspace-other';

interface Bound {
  /** The session the project currently points at, if any, and whether it is in Trash. */
  session?: { id: string; deletedAt: Date | null } | null;
  /** The pointer column itself, when it has to differ from `session` — a hard-deleted session
   *  leaves it NULL (the FK is SET NULL), which is not the same row as a trashed one. */
  coordinatorSessionId?: string | null;
  coordinatorWorkspaceId?: string | null;
  /** This project's tasks as assignee -> count, for the borrow-a-workspace fallback. */
  assignees?: Array<{ id: string; count: number; deleted?: boolean }>;
  /** Somebody else binds this while our create is in flight, so our swap finds a pointer that is
   *  no longer what we read. */
  raceWinner?: string;
  /** ...and then theirs is deleted before we look it up, emptying the pointer (the FK is SET
   *  NULL). The swap has already failed, so there is nothing to adopt and nothing we bound.
   *
   *  Note this is the ONLY way to reach that branch: bound-and-unbound-before-our-swap leaves the
   *  pointer holding exactly what we read, so the swap succeeds and the binding is honestly ours. */
  winnerVanishes?: boolean;
  /** ...or theirs is put in Trash before we look it up: a pointer that leads nowhere anyone can go. */
  winnerTrashed?: boolean;
  /** Workspaces that still exist but are soft-deleted, which is what `sessions.create` refuses. */
  deletedWorkspaces?: string[];
  /** The project is not this caller's, or does not exist. */
  missing?: boolean;
  /** sessions.create rejects. */
  createFails?: Error;
  /** Discarding the losing session rejects. */
  discardFails?: Error;
}

/**
 * The project row is modelled as MUTABLE state, and `updateMany` as a real compare-and-swap
 * against it. A stub that always reported success would let every test here pass with the swap
 * replaced by an unconditional update — which is the bug the swap exists to prevent, and it does
 * not show up as a failure anywhere else.
 *
 * The race is applied inside `sessions.create`, because that is the window it actually happens in:
 * this call reads the pointer, spends a long time creating a session, and writes afterwards.
 */
function makeService(bound: Bound = {}) {
  const state = {
    coordinatorSessionId:
      bound.coordinatorSessionId !== undefined
        ? bound.coordinatorSessionId
        : (bound.session?.id ?? null),
    coordinatorWorkspaceId:
      bound.coordinatorWorkspaceId !== undefined
        ? bound.coordinatorWorkspaceId
        : (bound.session ? WORKSPACE_TASKS : null),
  };
  const created: any[][] = [];
  const written: Record<string, unknown>[] = [];
  const swaps: any[] = [];
  const ended: string[] = [];
  const removed: string[] = [];

  const readProject = () => {
    if (bound.missing) return null;
    const id = state.coordinatorSessionId;
    const session =
      id === null
        ? null
        : id === bound.session?.id
          ? bound.session
          : // bound by whoever won the race, and possibly trashed since
            { id, deletedAt: bound.winnerTrashed ? new Date() : null };
    return {
      id: PROJECT_ID,
      title: 'Ship the coordinator',
      coordinatorSessionId: id,
      coordinatorWorkspaceId: state.coordinatorWorkspaceId,
      coordinatorSession: session,
    };
  };

  const prisma = {
    project: {
      findFirst: async () => readProject(),
      updateMany: async ({ where, data }: any) => {
        swaps.push(where);
        if (where.ownerId !== OWNER_ID) return { count: 0 }; // the write carries its own tenant scope
        // A `where` with no pointer predicate is an unconditional UPDATE, and is modelled as one.
        // Otherwise a swap that stopped being a swap would show up as a stub mismatch — every
        // condition failing against `undefined` — instead of as the two-winners bug it is.
        const conditional = 'coordinatorSessionId' in where;
        if (conditional && where.coordinatorSessionId !== state.coordinatorSessionId) {
          if (bound.winnerVanishes) {
            state.coordinatorSessionId = null;
            state.coordinatorWorkspaceId = null;
          }
          return { count: 0 };
        }
        state.coordinatorSessionId = data.coordinatorSessionId;
        state.coordinatorWorkspaceId = data.coordinatorWorkspaceId;
        written.push(data);
        return { count: 1 };
      },
    },
    task: {
      // Honours the deleted-assignee filter the service passes. A stub that ignored it would make
      // that guard's own test pass with the guard deleted — and borrowing a deleted workspace
      // yields a coordinator that can never be opened at all.
      groupBy: async ({ where }: any) => {
        const wantAlive = where?.assignee?.deletedAt === null;
        return (bound.assignees ?? [])
          .filter((a) => !(wantAlive && a.deleted))
          .sort((x, y) => y.count - x.count)
          .map((a) => ({ assigneeId: a.id, _count: { _all: a.count } }));
      },
    },
    workspace: {
      // Honours `deletedAt: null` and the owner, for the same reason: a stub that answered "yes,
      // it's there" to everything would make the liveness check's test pass with the check gone.
      findFirst: async ({ where }: any) => {
        const alive =
          where.deletedAt === null ? !(bound.deletedWorkspaces ?? []).includes(where.id) : true;
        return alive && where.ownerId === OWNER_ID ? { id: where.id } : null;
      },
    },
  } as never;

  const sessions = {
    create: async (...args: any[]) => {
      if (bound.createFails) throw bound.createFails;
      created.push(args);
      if (bound.raceWinner) {
        state.coordinatorSessionId = bound.raceWinner;
        state.coordinatorWorkspaceId = WORKSPACE_OTHER;
      }
      return { id: SESSION_NEW };
    },
    // Present so that a service still reaching for `end` is visible as "ended but not removed"
    // rather than as a crash, which would be indistinguishable from any other stub gap.
    end: async (_owner: string, id: string) => {
      ended.push(id);
      return { ok: true };
    },
    remove: async (_owner: string, id: string) => {
      if (bound.discardFails) throw bound.discardFails;
      removed.push(id);
      return { ok: true };
    },
  } as never;

  const service = new ProjectsService(prisma, sessions);
  return {
    created,
    written,
    swaps,
    ended,
    removed,
    state,
    open: (workspaceId?: string) => service.coordinator(OWNER_ID, PROJECT_ID, workspaceId),
  };
}

// ── Opening one, and coming back to it ────────────────────────────────────────────────────────

test('a project with no coordinator opens one and remembers where', async () => {
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 4 }] });

  const result = await f.open();

  assert.deepEqual(result, {
    sessionId: SESSION_NEW,
    created: true,
    workspaceId: WORKSPACE_TASKS,
  });
  // Both columns in one write: a session id with no record of where it was opened cannot answer
  // the question the next request asks of it.
  assert.deepEqual(f.written, [
    { coordinatorSessionId: SESSION_NEW, coordinatorWorkspaceId: WORKSPACE_TASKS },
  ]);
});

test('coming back to the project comes back to the same conversation', async () => {
  // The reason the binding exists at all: everything decided in that conversation is in it, and a
  // fresh session each time throws the reasoning away.
  const f = makeService({ session: { id: SESSION_BOUND, deletedAt: null } });

  const result = await f.open();

  assert.deepEqual(result, {
    sessionId: SESSION_BOUND,
    created: false,
    workspaceId: WORKSPACE_TASKS,
  });
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.written, []);
});

test('two calls in a row leave exactly one binding', async () => {
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  const first = await f.open();
  const second = await f.open();

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(f.created.length, 1, 'the second call must not open a second session');
  assert.equal(f.written.length, 1);
});

test('a FAILED coordinator is reused, not replaced', async () => {
  // FAILED is a terminal state Orbit revives with a new turn. Replacing one would abandon the
  // history for a session that is one message away from carrying on.
  const f = makeService({ session: { id: SESSION_BOUND, deletedAt: null } });

  const result = await f.open();

  assert.equal(result.created, false);
  assert.deepEqual(f.created, []);
});

// ── Replacing one that is genuinely gone ──────────────────────────────────────────────────────

test('a trashed coordinator is replaced', async () => {
  // Deleting the conversation is deliberate; reviving it out of Trash behind the user's back
  // would undo that. Opening a new one is the honest response.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
  });

  const result = await f.open();

  assert.equal(result.created, true);
  assert.equal(result.sessionId, SESSION_NEW);
  assert.deepEqual(f.written, [
    { coordinatorSessionId: SESSION_NEW, coordinatorWorkspaceId: WORKSPACE_TASKS },
  ]);
});

test('the swap that replaces a trashed coordinator is conditioned on the trashed id', async () => {
  // Not on "still null". The pointer this call read is what it swaps against, so one branch
  // covers both the never-bound and the replaced-because-trashed cases — and a third party who
  // replaced it first still wins.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
  });

  const result = await f.open();

  assert.deepEqual(result, {
    sessionId: SESSION_THEIRS,
    created: false,
    workspaceId: WORKSPACE_OTHER,
  });
  assert.deepEqual(f.written, [], 'the losing swap must not have written');
});

test('a coordinator whose session was deleted outright is replaced', async () => {
  // The FK is SET NULL, so a hard delete empties the pointer rather than leaving it dangling.
  const f = makeService({
    coordinatorSessionId: null,
    coordinatorWorkspaceId: WORKSPACE_TASKS,
    session: null,
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
  });

  const result = await f.open();

  assert.equal(result.created, true);
  assert.equal(result.sessionId, SESSION_NEW);
});

// ── Two at once ───────────────────────────────────────────────────────────────────────────────

test('two requests at once land in one conversation, and only one binding survives', async () => {
  // Both read it unbound, both create, both write. Without the swap the last writer won and the
  // other's session was left created, bound to nothing, sitting in the workspace forever — with
  // two people talking to different coordinators about the same project.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
  });

  const result = await f.open();

  assert.deepEqual(result, {
    sessionId: SESSION_THEIRS,
    created: false,
    workspaceId: WORKSPACE_OTHER,
  });
  assert.equal(f.state.coordinatorSessionId, SESSION_THEIRS);
  assert.deepEqual(f.written, []);
});

test('the session that lost the race is discarded, never left running', async () => {
  // An unreferenced session still holding a runner slot is the one outcome that is never
  // acceptable here — it is a live agent nobody can see, in a workspace nobody pointed it at.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
  });

  await f.open();

  assert.deepEqual(f.removed, [SESSION_NEW]);
});

test('the loser goes to Trash, not merely to a finished state in Open', async () => {
  // `end` would leave a session nobody can reach sitting in the Open list, looking exactly like a
  // real coordinator; the soft delete ends the runtime the same way AND takes it out of the list.
  // Nothing is destroyed — the transcript stays and it is restorable.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
  });

  await f.open();

  assert.deepEqual(f.removed, [SESSION_NEW]);
  assert.deepEqual(f.ended, [], 'ending it is not enough — it stays in Open');
  assert.deepEqual(f.written, []);
});

test('a discard that fails is reported, never reported as success', async () => {
  // The entire reason the loser is discarded is that an unreferenced live session must not exist.
  // Swallowing the failure would return `created: false` and a perfectly usable winner id in
  // exactly the case where that guarantee was NOT met — the one outcome nobody could detect.
  const boom = new Error('runner unreachable');
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
    discardFails: boom,
  });

  await assert.rejects(() => f.open(), boom);
});

test('the winner writes the pointer exactly once and discards nothing', async () => {
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  const result = await f.open();

  assert.equal(result.created, true);
  assert.equal(f.written.length, 1);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.ended, []);
});

test('a swap lost with nothing to adopt is a 409, and still cleans up', async () => {
  // Somebody bound one, our swap lost to it, and theirs was gone before we could adopt it.
  // Reporting `created: true` here would name a binding that does not exist, and returning our own
  // session would be a coordinator the project does not point at.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
    winnerVanishes: true,
  });

  await assert.rejects(
    () => f.open(),
    (e: unknown) => e instanceof ConflictException,
  );
  assert.deepEqual(f.removed, [SESSION_NEW], 'the orphan must be discarded even on the error path');
});

test('a winner that has since been trashed is not handed back', async () => {
  // The pointer is set, but it leads into Trash — the caller would get an id it cannot open and a
  // `created: false` insisting that was the answer. Transient, so it says to try again: the next
  // call sees a trashed binding and replaces it through the ordinary path.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
    winnerTrashed: true,
  });

  await assert.rejects(
    () => f.open(),
    (e: unknown) => e instanceof ConflictException,
  );
  assert.deepEqual(f.removed, [SESSION_NEW]);
});

test('losing the race to a coordinator in another workspace is still a 409', async () => {
  // The same request, one moment earlier, would have been refused for naming a workspace the
  // coordinator does not run in. Losing a race must not turn that refusal into a silent adoption:
  // whether the binding was already there or arrived while we were creating is invisible to the
  // caller, and the answer cannot depend on it.
  const f = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS, // the winner binds WORKSPACE_OTHER
  });

  await assert.rejects(
    () => f.open(WORKSPACE_TASKS),
    (e: unknown) => e instanceof ConflictException,
  );
  // Cleanup first, then the refusal: a 409 must not be a way to leak a session either.
  assert.deepEqual(f.removed, [SESSION_NEW]);
  assert.equal(f.state.coordinatorSessionId, SESSION_THEIRS);
});

test('the conflict reads the same whether it was noticed before or after the race', async () => {
  const sequential = makeService({ session: { id: SESSION_BOUND, deletedAt: null } });
  const raced = makeService({
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
    raceWinner: SESSION_THEIRS,
  });

  const first = await sequential.open(WORKSPACE_OTHER).catch((e: Error) => e.message);
  const second = await raced.open(WORKSPACE_TASKS).catch((e: Error) => e.message);

  assert.equal(first, second, 'two wordings would read as two different rules');
});

test('the swap carries the owner, not just the project id', async () => {
  // It is a WRITE. The read above already established ownership, so this narrows nothing today —
  // it is what keeps the write tenant-scoped if that read is ever moved, cached or refactored.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  assert.equal(f.swaps[0].ownerId, OWNER_ID);
  assert.equal(f.swaps[0].id, PROJECT_ID);
});

// ── Where it runs ─────────────────────────────────────────────────────────────────────────────

test('an explicit workspace wins over the borrowed one', async () => {
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 9 }] });

  const result = await f.open(WORKSPACE_OTHER);

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_OTHER);
  assert.equal(result.workspaceId, WORKSPACE_OTHER);
});

test('a replacement reopens where the coordinator ran before', async () => {
  // The reason `coordinatorWorkspaceId` is stored at all. Trashing a coordinator and asking for
  // another is the most ordinary path there is, and jumping straight to the busiest assignee would
  // MOVE the coordinator on it — silently, which is the exact migration the 409 exists to refuse.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    coordinatorWorkspaceId: WORKSPACE_OTHER,
    // Busier, and still not where this project's coordinator belongs.
    assignees: [{ id: WORKSPACE_TASKS, count: 99 }],
  });

  const result = await f.open();

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_OTHER);
  assert.equal(result.workspaceId, WORKSPACE_OTHER);
});

test('an explicit workspace still wins over the remembered one', async () => {
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    coordinatorWorkspaceId: WORKSPACE_OTHER,
  });

  await f.open(WORKSPACE_TASKS);

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_TASKS);
});

test('a remembered workspace that has been deleted is not reused', async () => {
  // Workspaces are SOFT-deleted, so the FK's SET NULL never fires for one and the column goes on
  // naming a workspace `sessions.create` refuses. Preferring it blindly would turn every
  // replacement on this project into a 403 with the fallback sitting right there unused.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    coordinatorWorkspaceId: WORKSPACE_OTHER,
    deletedWorkspaces: [WORKSPACE_OTHER],
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
  });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_TASKS);
});

test('a first coordinator has nothing remembered and borrows as before', async () => {
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_TASKS);
});

// A project an agent just recorded from inside a session: no coordinator yet, and NO TASKS to
// borrow an assignee from. It is openable anyway, because `create` stored where the session that
// recorded it was running.
//
// This is the whole reason that default exists. Without it, the first thing anyone could do with a
// brand-new project was fail to open its coordinator — and the workaround was to file an assigned
// task purely so a workspace could be borrowed, which makes a project's viability depend on work
// nobody has decided on yet. `assignees: []` is deliberate: if this ever falls through to the task
// fallback, there is nothing there and the call is a 400 rather than a quietly different workspace.
test('a project created in a session opens its coordinator with no tasks at all', async () => {
  const f = makeService({ coordinatorWorkspaceId: WORKSPACE_OTHER, assignees: [] });

  const result = await f.open();

  assert.deepEqual(result, {
    sessionId: SESSION_NEW,
    created: true,
    workspaceId: WORKSPACE_OTHER,
  });
  assert.equal(f.created[0][1].workspaceId, WORKSPACE_OTHER);
});

test('with no explicit workspace it opens where the project’s work already runs', async () => {
  const f = makeService({
    assignees: [
      { id: WORKSPACE_OTHER, count: 2 },
      { id: WORKSPACE_TASKS, count: 9 },
    ],
  });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_TASKS);
});

test('a deleted workspace is never borrowed', async () => {
  // sessions.create filters on deletedAt, so borrowing one produces a coordinator that cannot be
  // opened — a 403 in place of the 400 that would at least have said what to do.
  const f = makeService({
    assignees: [
      { id: WORKSPACE_OTHER, count: 9, deleted: true },
      { id: WORKSPACE_TASKS, count: 1 },
    ],
  });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, WORKSPACE_TASKS);
});

test('with no workspace anywhere it asks rather than guesses', async () => {
  const f = makeService();

  await assert.rejects(
    () => f.open(),
    (e: unknown) => e instanceof BadRequestException,
  );
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.written, []);
});

// ── Asking for a coordinator somewhere else ───────────────────────────────────────────────────

test('a second workspace for an existing coordinator is a conflict, not a move', async () => {
  // Silently re-pointing would strand the conversation the project was actually steered from, and
  // the caller would have no way to tell it happened. Moving one is its own decision.
  const f = makeService({ session: { id: SESSION_BOUND, deletedAt: null } });

  await assert.rejects(
    () => f.open(WORKSPACE_OTHER),
    (e: unknown) => e instanceof ConflictException,
  );
  assert.deepEqual(f.created, [], 'a conflict must not leave a session behind');
  assert.deepEqual(f.written, []);
  assert.equal(f.state.coordinatorSessionId, SESSION_BOUND);
  assert.equal(f.state.coordinatorWorkspaceId, WORKSPACE_TASKS);
});

test('naming the workspace it is already in is the ordinary idempotent answer', async () => {
  const f = makeService({ session: { id: SESSION_BOUND, deletedAt: null } });

  const result = await f.open(WORKSPACE_TASKS);

  assert.deepEqual(result, {
    sessionId: SESSION_BOUND,
    created: false,
    workspaceId: WORKSPACE_TASKS,
  });
});

test('a workspace deleted since the binding is not a conflict', async () => {
  // The FK is SET NULL, so where it ran is simply not known any more. "Different from something
  // we cannot name" is not a conflict a caller could act on, and returning the coordinator it has
  // re-points nothing.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: null },
    coordinatorWorkspaceId: null,
  });

  const result = await f.open(WORKSPACE_OTHER);

  assert.deepEqual(result, { sessionId: SESSION_BOUND, created: false, workspaceId: null });
  assert.deepEqual(f.created, []);
});

test('a trashed coordinator may be replaced in a different workspace', async () => {
  // There is no live coordinator to be in conflict with — the conflict rule protects a
  // conversation that still exists, not the memory of one that was thrown away.
  const f = makeService({
    session: { id: SESSION_BOUND, deletedAt: new Date() },
    coordinatorWorkspaceId: WORKSPACE_TASKS,
  });

  const result = await f.open(WORKSPACE_OTHER);

  assert.equal(result.created, true);
  assert.equal(result.workspaceId, WORKSPACE_OTHER);
});

// ── Failure must not half-bind ────────────────────────────────────────────────────────────────

test('the binding is written only after the session exists', async () => {
  // Otherwise a failed create leaves the project pointing at a session that was never made, and
  // every later visit resolves a dangling id instead of opening a working coordinator.
  const order: string[] = [];
  const prisma = {
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        title: 'P',
        coordinatorSessionId: null,
        coordinatorWorkspaceId: null,
        coordinatorSession: null,
      }),
      updateMany: async () => {
        order.push('bind');
        return { count: 1 };
      },
    },
  } as never;
  const sessions = {
    create: async () => {
      order.push('create');
      return { id: SESSION_NEW };
    },
  } as never;

  await new ProjectsService(prisma, sessions).coordinator(OWNER_ID, PROJECT_ID, WORKSPACE_TASKS);

  assert.deepEqual(order, ['create', 'bind']);
});

test('a session that fails to create leaves the project untouched', async () => {
  const boom = new Error('workspace is disabled');
  const f = makeService({ createFails: boom, assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await assert.rejects(() => f.open(), boom);

  assert.deepEqual(f.written, []);
  assert.equal(f.state.coordinatorSessionId, null);
  assert.equal(f.state.coordinatorWorkspaceId, null);
});

test('a create that fails on a replacement leaves the old pointer alone', async () => {
  // The trashed id is still what the project holds. Clearing it first "to make room" would lose
  // the only record of which conversation this project used to have.
  const trashed = { id: SESSION_BOUND, deletedAt: new Date() };
  const f = makeService({
    session: trashed,
    createFails: new Error('workspace not found'),
    assignees: [{ id: WORKSPACE_TASKS, count: 1 }],
  });

  await assert.rejects(() => f.open());

  assert.equal(f.state.coordinatorSessionId, SESSION_BOUND);
  assert.deepEqual(f.written, []);
});

// ── Whose project it is ───────────────────────────────────────────────────────────────────────

test('a project that is not the caller’s is a 404, and opens nothing', async () => {
  // The same answer an id that does not exist gets: saying which kind of absent it was would
  // report on somebody else's account.
  const f = makeService({ missing: true });

  await assert.rejects(
    () => f.open(WORKSPACE_TASKS),
    (e: unknown) => e instanceof NotFoundException,
  );
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.written, []);
});

test('the project is resolved by owner before anything is created', async () => {
  const wheres: any[] = [];
  const prisma = {
    project: {
      findFirst: async (args: any) => {
        wheres.push(args.where);
        return null;
      },
    },
  } as never;

  await assert.rejects(
    () =>
      new ProjectsService(prisma, {} as never).coordinator(OWNER_ID, PROJECT_ID, WORKSPACE_TASKS),
    (e: unknown) => e instanceof NotFoundException,
  );
  assert.deepEqual(wheres, [{ id: PROJECT_ID, ownerId: OWNER_ID }]);
});

// ── What the coordinator is told ──────────────────────────────────────────────────────────────

test('the opening message names the project and carries its id', async () => {
  // The agent reading it has no idea which project it is in. The id is the only thing in the
  // message that ties the conversation back to a row.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  const { title, prompt } = f.created[0][1];
  assert.ok(title.includes('Ship the coordinator'), title);
  assert.ok(prompt.includes('Ship the coordinator'), prompt);
  assert.ok(prompt.includes(PROJECT_PUBLIC_ID), prompt);
});

test('the id it carries is the public one, not the uuid the column holds', async () => {
  // Prose is the boundary PublicIdInterceptor does not cover: it rewrites response fields, and
  // this id lives in a message body. Left as a uuid it is the one id in the whole conversation
  // spelled differently from every other — `project_get` answers base62 — so the coordinator
  // cannot tell the project it was told about from the project it just read.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  assert.ok(prompt.includes(PROJECT_PUBLIC_ID), prompt);
  assert.equal(prompt.includes(PROJECT_ID), false, 'the raw uuid reached the agent');
});

test('the opening message sends the coordinator to read before it decides anything', async () => {
  // Neither the goal nor the acceptance criteria is repeated in a task's description, so a
  // coordinator that starts by editing has nothing to have based the edit on. Both reads are
  // named, and both come before the writes are mentioned — ordering is the instruction here, not
  // decoration.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  const read = prompt.indexOf('project_get');
  const scope = prompt.indexOf('task_list');
  const write = prompt.indexOf('project_update');
  assert.ok(read >= 0, `prompt never names project_get: ${prompt}`);
  assert.ok(scope >= 0, `prompt never names task_list: ${prompt}`);
  assert.ok(write >= 0, `prompt never names project_update: ${prompt}`);
  assert.ok(read < write && scope < write, `prompt puts writing before reading: ${prompt}`);
  // The task scope is this project's, which is what the id it carries is for — a coordinator that
  // read every task in the account would report on work that is not its own.
  assert.match(prompt, /task_list（projectId/);
});

test('the opening message tells the coordinator it may act when asked to', async () => {
  // `project_get`, the task tools and now `project_update` all reach a runner. The older wording
  // told the one session built to coordinate a project to assume it could change nothing, so the
  // agent handed the authority was the agent instructed not to use it.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  for (const tool of ['project_update', 'task_create', 'task_update', 'task_start']) {
    assert.ok(prompt.includes(tool), `prompt never offers ${tool}: ${prompt}`);
  }
  // Settling the project is part of the authority, and the point of naming it: a finished project
  // left OPEN is what happens when nobody believes they may say so.
  assert.match(prompt, /DONE \/ CANCELLED/);
  // And the old blanket denial is gone, not merely outnumbered.
  assert.equal(prompt.includes('不要假设'), false, `prompt still denies the tools: ${prompt}`);
});

test('the opening message still promises no tool a runner cannot reach', async () => {
  // Listing or deleting projects, opening another coordinator and driving a runner directly are
  // none of them exposed. Naming one would spend the first turn hunting for it, and then report
  // confidently from whatever it found instead.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  for (const absent of ['project_list', 'project_delete', 'project_coordinator', 'session_create']) {
    assert.equal(prompt.includes(absent), false, `prompt promises ${absent}`);
  }
});

test('coordinating is named as distinct from doing the work', async () => {
  // A coordinator that implements the tasks itself is one session doing what a project full of
  // them exists to spread out — and it does so holding none of their context.
  const f = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await f.open();

  assert.match(f.created[0][1].prompt, /不是用来替它干活的/);
});

test('the title and the prompt are stable across calls', async () => {
  // Nothing time-varying in either: two projects with the same title and id produce the same
  // opening, so a diff of two coordinators shows what actually differs.
  const a = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });
  const b = makeService({ assignees: [{ id: WORKSPACE_TASKS, count: 1 }] });

  await a.open();
  await b.open();

  assert.equal(a.created[0][1].title, b.created[0][1].title);
  assert.equal(a.created[0][1].prompt, b.created[0][1].prompt);
});

test('a long project title is cut to a title, not passed through whole', async () => {
  const prisma = {
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        title: 'x'.repeat(500),
        coordinatorSessionId: null,
        coordinatorWorkspaceId: null,
        coordinatorSession: null,
      }),
      updateMany: async () => ({ count: 1 }),
    },
  } as never;
  const created: any[] = [];
  const sessions = {
    create: async (_owner: string, dto: any) => {
      created.push(dto);
      return { id: SESSION_NEW };
    },
  } as never;

  await new ProjectsService(prisma, sessions).coordinator(OWNER_ID, PROJECT_ID, WORKSPACE_TASKS);

  assert.ok(created[0].title.length <= 80, `title was ${created[0].title.length} chars`);
});

// ── Two real calls, actually interleaved ──────────────────────────────────────────────────────
//
// Everything above drives ONE call and injects the other side of the race by mutating the row
// mid-flight. That is the right tool for the branches — it can put the pointer in states a second
// caller could not produce on demand (trashed winner, vanished winner, a winner in another
// workspace) — but it proves nothing about two callers both going read → create → swap, because
// there is only ever one caller.
//
// This one runs both. Barriers pin the interleaving that matters (neither may read after the other
// has bound; neither may swap before both sessions exist), so the ordering under test is the one
// intended rather than whatever the event loop happened to do that run. Which of the two wins is
// still up to the scheduler — so every assertion below is written against the winner the row
// actually ended up naming, not against a call chosen in advance. That is what makes it
// deterministic in what it claims while staying honest about what it cannot control.

/** A rendezvous `parties` callers must all reach before any continues. It rejects rather than
 *  hanging: a service that stopped creating a session would otherwise stall the whole run instead
 *  of failing this one test with a legible reason. */
function barrier(parties: number, label: string) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        gate,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`only ${arrived}/${parties} callers reached ${label}`)),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function concurrentFixture() {
  // The one mutable row both callers contend for.
  const row: { coordinatorSessionId: string | null; coordinatorWorkspaceId: string | null } = {
    coordinatorSessionId: null,
    coordinatorWorkspaceId: null,
  };
  const readsSeen: (string | null)[] = [];
  const swaps: any[] = [];
  const creates: string[] = [];
  const removed: string[] = [];
  const ended: string[] = [];

  const bothRead = barrier(2, 'the first read');
  const bothCreated = barrier(2, 'sessions.create');
  let minted = 0;

  const prisma = {
    project: {
      findFirst: async () => {
        // Snapshot at read time, like a real read: the value returned is the one that was there
        // when the query ran, not whatever the row holds by the time the caller looks at it.
        const seen = { ...row };
        readsSeen.push(seen.coordinatorSessionId);
        // Only the two opening reads rendezvous. The third is the loser looking up the winner,
        // which must see the row as it is by then.
        if (readsSeen.length <= 2) await bothRead();
        return {
          id: PROJECT_ID,
          title: 'Ship the coordinator',
          coordinatorSessionId: seen.coordinatorSessionId,
          coordinatorWorkspaceId: seen.coordinatorWorkspaceId,
          coordinatorSession: seen.coordinatorSessionId
            ? { id: seen.coordinatorSessionId, deletedAt: null }
            : null,
        };
      },
      // A real compare-and-swap: there is NO await between the compare and the set, so the two
      // callers cannot interleave inside it — exactly the guarantee `UPDATE ... WHERE` gives.
      // Whichever microtask arrives second sees what the first wrote and is refused.
      //
      // A `where` carrying no pointer predicate is an unconditional UPDATE and is applied as one,
      // so a swap that stops being a swap fails this test as two winners rather than as a stub
      // that happened to compare against `undefined`.
      updateMany: async ({ where, data }: any) => {
        swaps.push(where);
        if (where.ownerId !== OWNER_ID) return { count: 0 };
        const conditional = 'coordinatorSessionId' in where;
        if (conditional && row.coordinatorSessionId !== where.coordinatorSessionId) {
          return { count: 0 };
        }
        row.coordinatorSessionId = data.coordinatorSessionId;
        row.coordinatorWorkspaceId = data.coordinatorWorkspaceId;
        return { count: 1 };
      },
    },
    task: { groupBy: async () => [] },
    workspace: { findFirst: async ({ where }: any) => ({ id: where.id }) },
  } as never;

  const sessions = {
    create: async () => {
      const id = `session-${'AB'[minted] ?? minted}`;
      minted += 1;
      creates.push(id);
      // Both sessions exist before either binding is attempted, which is the case that produces a
      // stranded session if the swap is not a swap.
      await bothCreated();
      return { id };
    },
    end: async (_owner: string, id: string) => {
      ended.push(id);
      return { ok: true };
    },
    remove: async (_owner: string, id: string) => {
      removed.push(id);
      return { ok: true };
    },
  } as never;

  const service = new ProjectsService(prisma, sessions);
  return {
    row,
    readsSeen,
    swaps,
    creates,
    removed,
    ended,
    openTwice: () =>
      Promise.all([
        service.coordinator(OWNER_ID, PROJECT_ID, WORKSPACE_TASKS),
        service.coordinator(OWNER_ID, PROJECT_ID, WORKSPACE_TASKS),
      ]),
  };
}

test('two concurrent calls both open a session, and the project keeps exactly one', async () => {
  const f = concurrentFixture();

  const [a, b] = await f.openTwice();

  // Both really went read → create → swap: two reads that each found nothing, two distinct
  // sessions, two swap attempts. Any of these at 1 would mean the test proved nothing.
  assert.deepEqual(f.readsSeen.slice(0, 2), [null, null], 'both had to read it unbound');
  assert.equal(f.creates.length, 2);
  assert.notEqual(f.creates[0], f.creates[1], 'the two sessions must be distinguishable');
  assert.equal(f.swaps.length, 2, 'both had to attempt the binding');
  assert.deepEqual(
    f.swaps.map((w) => w.coordinatorSessionId),
    [null, null],
    'both had to swap against the unbound pointer they read — an absent predicate is no swap',
  );

  // One binding survives, and it is one of the two that were actually created.
  const winner = f.row.coordinatorSessionId;
  assert.ok(winner && f.creates.includes(winner), `row bound ${winner}`);
  assert.equal(f.row.coordinatorWorkspaceId, WORKSPACE_TASKS);

  // And both callers are told about that one — which is the entire promise of the endpoint.
  assert.equal(a.sessionId, winner);
  assert.equal(b.sessionId, winner);
  assert.deepEqual([a.created, b.created].sort(), [false, true], 'exactly one created it');
});

test('the concurrent loser is soft-removed and the winner is left alone', async () => {
  const f = concurrentFixture();

  await f.openTwice();

  const winner = f.row.coordinatorSessionId;
  const loser = f.creates.find((id) => id !== winner);
  assert.deepEqual(f.removed, [loser], 'exactly the loser, exactly once');
  assert.equal(f.removed.includes(winner as string), false, 'the winner must survive its own race');
  assert.deepEqual(f.ended, [], 'discarded to Trash, not merely ended into Open');
});

test('two concurrent calls naming the same workspace do not conflict', async () => {
  // The loser adopts the winner and passes the cross-workspace check on the way, because both
  // asked for the same place. Promise.all resolving at all is the assertion: a 409 here would mean
  // asking twice for a coordinator in one workspace could fail purely on timing.
  const f = concurrentFixture();

  const [a, b] = await f.openTwice();

  assert.equal(a.workspaceId, WORKSPACE_TASKS);
  assert.equal(b.workspaceId, WORKSPACE_TASKS);
});
