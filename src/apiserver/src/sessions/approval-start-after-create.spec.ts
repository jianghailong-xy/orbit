import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';

// The single-task create card's "Create and start": a second yes that also starts the task the
// create writes. These pin where the owner may give it — an allow of an `orbit_task_create` card and
// nowhere else — and that the runner reads it back off its poll only when it was given. The same
// path over a real PostgreSQL is approval-start-after-create.pg.spec.ts.

type Written = { where: unknown; data: Record<string, unknown> };

/** A card of `toolName`; a single create is filed by a runner that acts on the choice unless `accepts`
 *  is false (the server records it on the card as `input.acceptsStartAfterCreate`). */
function makeService(toolName: string, accepts = true) {
  const writes: Written[] = [];
  const prisma = {
    session: { findFirst: async () => ({ id: 's1', workspaceId: null, sessionKind: 'CONVERSATION' }) },
    approval: {
      updateMany: async (args: Written) => {
        writes.push(args);
        return { count: 1 };
      },
      findFirst: async () => ({
        id: 'a1', sessionId: 's1', toolName, input: accepts ? { acceptsStartAfterCreate: true } : {},
        toolUseId: null, backgroundJobId: null,
        status: 'ALLOWED', message: null, createdAt: new Date(), decidedAt: new Date(),
      }),
    },
  } as never;
  const realtime = { publish: () => {} } as never;
  return { service: new SessionsService(prisma, {} as never, realtime), writes };
}

test('Create and start on a single task create card is stored with the yes', async () => {
  const { service, writes } = makeService('orbit_task_create');
  await service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow', startAfterCreate: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.status, 'ALLOWED');
  assert.equal(writes[0].data.startAfterCreate, true);
});

test('a plain yes, and an explicit false, store no start', async () => {
  for (const decision of [{ behavior: 'allow' as const }, { behavior: 'allow' as const, startAfterCreate: false }]) {
    const { service, writes } = makeService('orbit_task_create');
    await service.decideApproval('owner-1', 's1', 'a1', decision);
    assert.equal(writes[0].data.startAfterCreate, false, JSON.stringify(decision));
  }
  // false is the plain answer on any card, so it is no reason to refuse one.
  const { service, writes } = makeService('Bash');
  await service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow', startAfterCreate: false });
  assert.equal(writes[0].data.startAfterCreate, false);
});

test('a refusal cannot carry a start, and writes nothing', async () => {
  const { service, writes } = makeService('orbit_task_create');
  await assert.rejects(
    service.decideApproval('owner-1', 's1', 'a1', { behavior: 'deny', startAfterCreate: true }),
    (error: unknown) => error instanceof BadRequestException && /goes only with "allow"/.test(error.message),
  );
  assert.deepEqual(writes, []);
});

test('every card that does not create one task refuses a start, and writes nothing', async () => {
  for (const toolName of ['orbit_task_batch', 'orbit_project_create', 'orbit_dag_change', 'Bash', 'AskUserQuestion']) {
    const { service, writes } = makeService(toolName);
    await assert.rejects(
      service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow', startAfterCreate: true }),
      (error: unknown) => error instanceof BadRequestException
        && error.message.includes('applies only to a single task create card')
        && error.message.includes(toolName),
      toolName,
    );
    assert.deepEqual(writes, [], toolName);
  }
});

test('a card whose runner would only create the task refuses a start, and writes nothing', async () => {
  const { service, writes } = makeService('orbit_task_create', false);
  await assert.rejects(
    service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow', startAfterCreate: true }),
    (error: unknown) => error instanceof BadRequestException && /predates it/.test(error.message),
  );
  assert.equal(writes.length, 0);
  // Its plain yes is still the plain yes.
  await service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow' });
  assert.equal(writes[0].data.startAfterCreate, false);
});

test('a start that is not a boolean is refused', async () => {
  const { service, writes } = makeService('orbit_task_create');
  await assert.rejects(
    service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow', startAfterCreate: 'yes' } as never),
    /startAfterCreate must be a boolean/,
  );
  assert.deepEqual(writes, []);
});

/** What a card is stored with, as the runner's door files it (the private `cardInput`). */
function filedInput(toolName: string, input: Record<string, unknown>, accepts: boolean) {
  const api = new RunnerApiController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return (api as unknown as {
    cardInput(owner: string, tool: string, raw: unknown, asker: unknown, accepts: boolean): Promise<Record<string, unknown>>;
  }).cardInput('owner-1', toolName, input, { runnerId: 'r1', sessionId: 's1' }, accepts);
}

test('a single create card records that its runner acts on Create and start, and only then', async () => {
  const body = { title: 'Fix login redirect', completionCriterion: 'EVIDENCE_JUDGMENT' };
  assert.equal((await filedInput('orbit_task_create', body, true)).acceptsStartAfterCreate, true);
  // A runner that does not say so is a runner that would only create the task.
  assert.equal('acceptsStartAfterCreate' in (await filedInput('orbit_task_create', body, false)), false);
  // It is the server's statement about the asker, so the asker's own input cannot make it…
  const forged = await filedInput('orbit_task_create', { ...body, acceptsStartAfterCreate: true }, false);
  assert.equal('acceptsStartAfterCreate' in forged, false);
  assert.equal(forged.title, 'Fix login redirect');
  // …and no other card carries it, whatever its asker says.
  assert.equal('acceptsStartAfterCreate' in (await filedInput('orbit_project_create', { title: 'P' }, true)), false);
});

/** The runner's long-poll over one decided row. */
async function poll(row: Record<string, unknown>) {
  const prisma = {
    session: { findUnique: async () => ({ id: 's1', ownerId: 'owner-1', assignedRunnerId: 'r1', sessionKind: 'CONVERSATION' }) },
    approval: { findFirst: async () => ({ id: 'a1', sessionId: 's1', message: null, answers: null, rememberRule: null, ...row }) },
  } as never;
  const api = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
  return api.pollApproval({ id: 'r1', ownerId: 'owner-1' } as never, 's1', 'a1');
}

test('the runner reads the start off its poll only when the owner chose it', async () => {
  const started = await poll({ status: 'ALLOWED', startAfterCreate: true });
  assert.equal(started.status, 'ALLOWED');
  assert.equal(started.behavior, 'allow');
  assert.equal(started.startAfterCreate, true);

  // Every other answer reads exactly as it did before the column existed: no key at all.
  for (const row of [{ status: 'ALLOWED', startAfterCreate: false }, { status: 'DENIED', startAfterCreate: false }]) {
    const answer = await poll(row);
    assert.equal('startAfterCreate' in answer, false, JSON.stringify(row));
  }
});
