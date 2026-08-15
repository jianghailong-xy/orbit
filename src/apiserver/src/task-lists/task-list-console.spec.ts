import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { TaskListsService } from './task-lists.service';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const OWNER = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';

interface Bound {
  /** The session the list currently points at, if any. */
  session?: { id: string; deletedAt: Date | null } | null;
  foremanWorkspaceId?: string | null;
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
  const prisma = {
    taskList: {
      findFirst: async () => list,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return { ...list, ...data };
      },
    },
  } as never;
  const sessions = {
    create: async (...args: any[]) => {
      created.push(args);
      return { id: 'session-new' };
    },
  } as never;
  const service = new TaskListsService(prisma, { publishForUser() {} } as never, sessions);
  return {
    created,
    written,
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
      update: async () => {
        order.push('bind');
        return {};
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
