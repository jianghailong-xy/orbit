import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { TaskListsService } from './task-lists.service';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
/** What that list is called everywhere the agent can see it, `tasklist_get` included. */
const LIST_PUBLIC_ID = uuidToBase62(LIST_ID);
const OWNER = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';

interface Bound {
  /** The session the list currently points at, if any. */
  session?: { id: string; deletedAt: Date | null } | null;
  foremanWorkspaceId?: string | null;
  /** This list's tasks, as assignee -> count, for the borrow-a-workspace fallback. */
  assignees?: Array<{ id: string; count: number; deleted?: boolean }>;
  /** Somebody else binds this session id between our read and our write. */
  raceWinner?: string;
}

function makeService(bound: Bound = {}) {
  const created: any[][] = [];
  const written: Record<string, unknown>[] = [];
  const list = {
    id: LIST_ID,
    title: 'FineWeb CC-MAIN-2025-26',
    ownerSessionId: bound.session?.id ?? null,
    foremanWorkspaceId:
      bound.foremanWorkspaceId === undefined ? 'workspace-foreman' : bound.foremanWorkspaceId,
    ownerSession: bound.session ?? null,
  };
  let bindings = 0;
  const prisma = {
    taskList: {
      findFirst: async () => (bindings > 0 && bound.raceWinner ? { ...list, ownerSessionId: bound.raceWinner } : list),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return { ...list, ...data };
      },
      // A compare-and-swap: it writes only while the pointer still holds what the caller read.
      // Modelled honestly — a stub that always reported success would make the race test pass
      // with the swap replaced by an unconditional update, which is the bug itself.
      updateMany: async ({ where, data }: any) => {
        bindings += 1;
        const current = bound.raceWinner ?? list.ownerSessionId;
        if (where.ownerSessionId !== current) return { count: 0 };
        written.push(data);
        return { count: 1 };
      },
    },
    task: {
      // Honours the deleted-assignee filter the service passes. A stub that ignored it would make
      // the guard's own test pass with the guard deleted — and borrowing a deleted workspace
      // produces a console that can never be opened, which is the failure this exists to prevent.
      groupBy: async ({ where }: any) => {
        const wantAlive = where?.assignee?.deletedAt === null;
        return (bound.assignees ?? [])
          .filter((a) => !(wantAlive && a.deleted))
          .sort((x, y) => y.count - x.count)
          .map((a) => ({ assigneeId: a.id, _count: { _all: a.count } }));
      },
    },
  } as never;
  const ended: string[] = [];
  const sessions = {
    create: async (...args: any[]) => {
      created.push(args);
      return { id: 'session-new' };
    },
    end: async (_owner: string, id: string) => {
      ended.push(id);
      return { ok: true };
    },
  } as never;
  const service = new TaskListsService(prisma, { publishForUser() {} } as never, sessions);
  return {
    created,
    written,
    ended,
    open: (workspaceId?: string) => service.console(OWNER, LIST_ID, workspaceId),
  };
}

test('a list with no console opens one and remembers it', async () => {
  const f = makeService();

  const result = await f.open();

  assert.equal(result.created, true);
  assert.equal(result.sessionId, 'session-new');
  assert.deepEqual(f.written, [{ ownerSessionId: 'session-new' }]);
});

test('returning to a list returns to the same conversation', async () => {
  // The reason the binding exists at all: the reasoning behind every earlier policy change is in
  // that conversation, and a fresh session each time throws it away.
  const f = makeService({ session: { id: 'session-existing', deletedAt: null } });

  const result = await f.open();

  assert.deepEqual(result, { sessionId: 'session-existing', created: false });
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.written, []);
});

test('a trashed console is replaced', async () => {
  // Deleting the conversation is deliberate; reviving it out of Trash behind the user's back
  // would undo that. Opening a new one is the honest response.
  const f = makeService({ session: { id: 'session-trashed', deletedAt: new Date() } });

  const result = await f.open();

  assert.equal(result.created, true);
  assert.deepEqual(f.written, [{ ownerSessionId: 'session-new' }]);
});

test('a console whose session was deleted outright is replaced', async () => {
  // The FK is SET NULL, so a hard delete leaves the pointer empty rather than dangling.
  const f = makeService({ session: null });

  const result = await f.open();

  assert.equal(result.created, true);
});

test('an explicit workspace wins over the foreman default', async () => {
  const f = makeService();

  await f.open('workspace-explicit');

  assert.equal(f.created[0][1].workspaceId, 'workspace-explicit');
});

test('with no foreman it borrows the workspace its tasks already run in', async () => {
  // The button was unusable without this: a foreman is opt-in and rarely set, so seven of this
  // deployment's eight lists had nothing to fall back on and every click returned 400.
  const f = makeService({
    foremanWorkspaceId: null,
    assignees: [{ id: 'workspace-busy', count: 9 }, { id: 'workspace-few', count: 2 }],
  });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, 'workspace-busy');
});

test('an explicit workspace still wins over everything', async () => {
  const f = makeService({ assignees: [{ id: 'workspace-busy', count: 9 }] });

  await f.open('workspace-explicit');

  assert.equal(f.created[0][1].workspaceId, 'workspace-explicit');
});

test('a foreman still wins over the borrowed one', async () => {
  const f = makeService({ assignees: [{ id: 'workspace-busy', count: 9 }] });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, 'workspace-foreman');
});

test('a deleted workspace is never borrowed', async () => {
  // sessions.create filters on deletedAt, so borrowing one yields a console that cannot open —
  // the same shape as the six verifications filed against a deleted workspace earlier.
  const f = makeService({
    foremanWorkspaceId: null,
    assignees: [{ id: 'workspace-gone', count: 9, deleted: true }, { id: 'workspace-alive', count: 1 }],
  });

  await f.open();

  assert.equal(f.created[0][1].workspaceId, 'workspace-alive');
});

test('with no workspace anywhere it asks rather than guesses', async () => {
  const f = makeService({ foremanWorkspaceId: null });

  await assert.rejects(
    () => f.open(),
    (e: unknown) => e instanceof BadRequestException,
  );
  assert.deepEqual(f.created, []);
});

test('the opening message points at the standing-instructions lever', async () => {
  // Editing task descriptions one at a time is the obvious move and the wrong one: this
  // deployment's 27,706 descriptions collapse to one instruction materialised that many times.
  const f = makeService();

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  assert.match(prompt, /不要逐个改任务描述/);
  // And it must not start editing on its own — the console reports, the human decides.
  assert.match(prompt, /不要自行改动任何东西/);
  assert.match(prompt, /带上 note 说明原因/);
});

test('the id it carries is the public one, not the uuid the column holds', async () => {
  // Prose is the boundary PublicIdInterceptor does not cover: it rewrites response fields, and
  // this id lives in a message body. Left as a uuid it is the one id in the whole conversation
  // spelled differently from every other — `tasklist_get` answers base62 — so the console cannot
  // tell the list it was told about from the list it just read.
  const f = makeService();

  await f.open();

  const prompt: string = f.created[0][1].prompt;
  assert.ok(prompt.includes(LIST_PUBLIC_ID), prompt);
  assert.equal(prompt.includes(LIST_ID), false, 'the raw uuid reached the agent');
});

test('the binding is written only after the session exists', async () => {
  // Otherwise a failed create leaves the list pointing at a session that was never made, and
  // every later visit resolves to a dangling id instead of opening a working console.
  const order: string[] = [];
  const prisma = {
    taskList: {
      findFirst: async () => ({
        id: LIST_ID,
        title: 'L',
        ownerSessionId: null,
        foremanWorkspaceId: 'workspace-foreman',
        ownerSession: null,
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
      return { id: 'session-new' };
    },
  } as never;
  const service = new TaskListsService(prisma, { publishForUser() {} } as never, sessions);

  await service.console(OWNER, LIST_ID);

  assert.deepEqual(order, ['create', 'bind']);
});

test('the summary attributes failures, and always reports every bucket', async () => {
  // Every bucket present even at zero: a caller reading `failuresByCause.quota` must not have to
  // distinguish "no quota failures" from "this server is too old to say", and an absent key is
  // how that distinction gets lost.
  const sessions = [
    { error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage" },
    { error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage" },
    { error: 'runner offline' },
    { error: null },
  ];
  const prisma = {
    taskList: {
      findFirst: async () => ({
        id: LIST_ID,
        title: 'L',
        instructions: null,
        paused: false,
        maxConcurrent: null,
        foremanWorkspaceId: null,
        foremanStallMinutes: null,
        verifyOnDone: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    task: { groupBy: async () => [] },
    session: {
      count: async () => 0,
      aggregate: async () => ({ _max: { createdAt: null } }),
      findMany: async () => sessions,
    },
    taskListRevision: { aggregate: async () => ({ _max: { version: null } }) },
    taskListEvent: { findMany: async () => [] },
  } as never;
  const service = new TaskListsService(prisma, { publishForUser() {} } as never, {} as never);

  const summary = await service.summary(OWNER, LIST_ID);

  assert.deepEqual(summary.failuresByCause, {
    quota: 2,
    infrastructure: 1,
    contentFilter: 0,
    unattributed: 1,
  });
});


test('two people opening the console at once land in the same conversation', async () => {
  // Both read it unbound, both create, both write. Before the swap the last writer won and the
  // other's session was left created, bound to nothing, sitting in the workspace forever — and
  // the two people were talking to different consoles about the same list.
  const f = makeService({ raceWinner: 'session-theirs' });

  const out = await f.open();

  assert.equal(out.sessionId, 'session-theirs');
  assert.equal(out.created, false);
});

test('the session that lost the race is ended, not left running', async () => {
  const f = makeService({ raceWinner: 'session-theirs' });

  await f.open();

  assert.deepEqual(f.ended, ['session-new']);
});

test('the winner writes the pointer exactly once', async () => {
  const f = makeService({ foremanWorkspaceId: 'workspace-foreman' });

  const out = await f.open();

  assert.equal(out.created, true);
  assert.deepEqual(f.written, [{ ownerSessionId: 'session-new' }]);
  assert.deepEqual(f.ended, []);
});
