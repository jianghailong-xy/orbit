import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/** A spawnable parent whose tree is always admissible; create() is stubbed to capture its dto.
 *  `workspace` is the row the service-token path resolves its pin to (null for the spawn path,
 *  which never looks one up). */
function makeService(workspace: { id: string; name: string } | null = null) {
  const createdDtos: Array<{ permissionMode?: string }> = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        rootSessionId: 'root',
        spawnDepth: 0,
        workspace: { enableOrchestration: true },
      }),
      update: async () => ({}),
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
  return { service, createdDtos };
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
