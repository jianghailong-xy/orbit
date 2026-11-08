import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/** A spawnable parent whose tree is always admissible; create() is stubbed to capture its dto.
 *  `workspace` is the row the service-token path resolves its pin to (null for the spawn path,
 *  which never looks one up). */
function makeService(
  workspace: { id: string; name: string } | null = null,
  parentMode: string | null = null,
  accountDefault: string | null = null,
) {
  const createdDtos: Array<{ permissionMode?: string }> = [];
  const writes: unknown[] = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        rootSessionId: null,
        spawnDepth: 0,
        workspaceId: 'workspace-1',
        permissionMode: parentMode,
        engine: 'claude',
        owner: { preferences: accountDefault ? { defaultPermissionMode: accountDefault } : {} },
      }),
      update: async (write: unknown) => {
        writes.push(write);
        return {};
      },
      // Admission control has its own spec; keep every tree here spawnable.
      count: async () => 0,
    },
    user: { findUnique: async () => null },
    workspace: { findFirst: async () => workspace },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  (service as unknown as { create: SessionsService['create'] }).create = (async (
    _ownerId: string,
    dto: unknown,
  ) => {
    createdDtos.push(dto as { permissionMode?: string });
    return { id: 'spawned', status: RunStatus.PENDING, title: 'spawned', workspaceId: null };
  }) as SessionsService['create'];
  return { service, createdDtos, writes };
}

// The posture is a property of the run, and a spawned run is precisely the one nobody is watching:
// an orchestrator that knows its sub-task is read-only has to be able to say `plan` rather than
// inherit whatever the account defaults to.
test('a spawned session runs the permission mode the caller picked', async () => {
  const { service, createdDtos } = makeService();

  await service.spawnFromSession('owner', 'root', {
    prompt: 'audit the migration, change nothing',
    permissionMode: 'plan',
  });

  assert.equal(createdDtos[0].permissionMode, 'plan');
});

// Omitted stays omitted rather than being resolved here: create() materializes the account default
// onto the row, and a second fallback in this path would quietly outrank it.
test('omitting the mode leaves the account default to create()', async () => {
  const { service, createdDtos } = makeService();

  await service.spawnFromSession('owner', 'root', { prompt: 'ship it' });

  assert.equal(createdDtos[0].permissionMode, undefined);
});

// The same flag reaches the headless bridge (`orbit session create --permission-mode` outside any
// session), which is the least-watched caller of all — a mode dropped here would be invisible.
test('a service-token spawn also runs the mode the caller picked', async () => {
  const { service, createdDtos } = makeService({ id: 'workspace-1', name: 'nightly' });

  await service.spawnForServiceToken(
    'owner',
    { assignedRunnerId: 'runner-1', workspaceId: 'workspace-1', tokenId: 'token-1' },
    { prompt: 'nightly sweep', permissionMode: 'dontAsk' },
  );

  assert.equal(createdDtos[0].permissionMode, 'dontAsk');
});

// The caller is a model or a script, not a picker. An invented mode would be stored verbatim and
// only fail once the claim hands it to the CLI — on the session's first turn, far from the call
// that caused it. Both spawn paths answer the same way.
test('an invented permission mode is refused before a session exists', async () => {
  const { service, createdDtos } = makeService({ id: 'workspace-1', name: 'nightly' });
  const rejectsUnknownMode = (error: unknown) =>
    error instanceof BadRequestException && /unknown permissionMode "yolo"/.test(error.message);

  await assert.rejects(
    () => service.spawnFromSession('owner', 'root', { prompt: 'work', permissionMode: 'yolo' }),
    rejectsUnknownMode,
  );
  await assert.rejects(
    () =>
      service.spawnForServiceToken(
        'owner',
        { assignedRunnerId: 'runner-1', workspaceId: 'workspace-1', tokenId: 'token-1' },
        { prompt: 'work', permissionMode: 'yolo' },
      ),
    rejectsUnknownMode,
  );
  assert.deepEqual(createdDtos, [], 'nothing was created behind the refusal');
});

// The table in common/permission-mode.spec.ts is what is wider than what. These are what the door does
// about it: a mode the caller named is refused before anything is written, and with none named the
// account's default gives way to the parent's own mode, and the answer says so.
test('a wider mode named is refused, with what to do instead, and nothing is written', async () => {
  const { service, createdDtos, writes } = makeService(null, 'plan');

  await assert.rejects(
    () => service.spawnFromSession('owner', 'root', { prompt: 'work', permissionMode: 'bypassPermissions' }),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenException);
      const body = error.getResponse() as { code: string; message: string };
      assert.equal(body.code, 'PERMISSION_MODE_WIDER_THAN_SESSION');
      assert.match(body.message, /runs in "plan".*may not run in "bypassPermissions"/);
      assert.match(body.message, /Name a mode it may start \(plan\)/);
      assert.match(body.message, /ask the account owner/);
      return true;
    },
  );
  assert.deepEqual(createdDtos, [], 'no session was created');
  assert.deepEqual(writes, [], 'the parent did not join a tree');
});

test('a mode the parent may start goes through as named', async () => {
  const { service, createdDtos } = makeService(null, 'default');

  const answer = await service.spawnFromSession('owner', 'root', { prompt: 'work', permissionMode: 'dontAsk' });

  assert.equal(createdDtos[0].permissionMode, 'dontAsk');
  assert.equal(answer.permissionModeNote, undefined);
});

test('no mode named: a default wider than the parent gives way to the parent, and the answer says so', async () => {
  const { service, createdDtos } = makeService(null, 'default', 'auto');

  const answer = await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.equal(createdDtos[0].permissionMode, 'default');
  assert.equal(answer.permissionMode, 'default');
  assert.match(answer.permissionModeNote!, /Started in "default"/);
});

test('no mode named: a default the parent may start is left to create()', async () => {
  const { service, createdDtos } = makeService(null, 'default', 'plan');

  const answer = await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.equal(createdDtos[0].permissionMode, undefined);
  assert.equal(answer.permissionModeNote, undefined);
});

// `spawnForServiceToken` has no parent: the workspace pin on the token is the whole authorization.
test('a service-token spawn has no parent to be held to', async () => {
  const { service, createdDtos } = makeService({ id: 'workspace-1', name: 'nightly' }, 'plan');

  await service.spawnForServiceToken(
    'owner',
    { assignedRunnerId: 'runner-1', workspaceId: 'workspace-1', tokenId: 'token-1' },
    { prompt: 'nightly sweep', permissionMode: 'bypassPermissions' },
  );

  assert.equal(createdDtos[0].permissionMode, 'bypassPermissions');
});
