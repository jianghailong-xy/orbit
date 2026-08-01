import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1', version: '0.1.80' } as never;
const SESSION_ID = 'caller-session';
const CREDENTIAL = 'signed-session-credential';
const VALID_CLAIMS = {
  sub: SESSION_ID,
  runnerId: 'runner-1',
  purpose: 'runner-orchestration',
};

function makeAuthorizer(options: {
  result?: { id: string } | null;
  claims?: Record<string, unknown>;
  verifyError?: Error;
  allowLegacy?: boolean;
} = {}) {
  const events: string[] = [];
  const lookups: Array<Record<string, unknown>> = [];
  const signCalls: Array<{ payload: unknown; options: unknown }> = [];
  const verifyCalls: Array<{ credential: string; options: unknown }> = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        events.push('database');
        lookups.push(where);
        return options.result === undefined ? { id: SESSION_ID } : options.result;
      },
    },
  };
  const jwt = {
    signAsync: async (payload: unknown, jwtOptions: unknown) => {
      signCalls.push({ payload, options: jwtOptions });
      return CREDENTIAL;
    },
    verifyAsync: async (credential: string, jwtOptions: unknown) => {
      events.push('verify');
      verifyCalls.push({ credential, options: jwtOptions });
      if (options.verifyError) throw options.verifyError;
      return options.claims ?? VALID_CLAIMS;
    },
  };
  const config = {
    get: (key: string) =>
      key === 'ORBIT_ALLOW_LEGACY_ORCHESTRATION' && options.allowLegacy ? 'true' : undefined,
  };
  return {
    authorizer: new RunnerOrchestrationAuthorizer(prisma as never, jwt as never, config as never),
    events,
    lookups,
    signCalls,
    verifyCalls,
  };
}

test('issue signs a runner/session-bound orchestration credential', async () => {
  const { authorizer, signCalls } = makeAuthorizer();
  assert.equal(await authorizer.issue('runner-1', SESSION_ID), CREDENTIAL);
  assert.deepEqual(signCalls, [
    {
      payload: { runnerId: 'runner-1', purpose: 'runner-orchestration' },
      options: {
        audience: 'orbit-runner-orchestration',
        subject: SESSION_ID,
      },
    },
  ]);
});

test('orchestration authorization requires both session context and its credential', async () => {
  const first = makeAuthorizer();
  await assert.rejects(
    () => first.authorizer.assert(RUNNER, undefined, CREDENTIAL),
    (error: unknown) =>
      error instanceof BadRequestException && error.message === 'missing session context',
  );
  assert.deepEqual(first.verifyCalls, []);
  assert.deepEqual(first.lookups, []);

  const second = makeAuthorizer();
  await assert.rejects(
    () => second.authorizer.assert(RUNNER, SESSION_ID, undefined),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'missing orchestration credential',
  );
  assert.deepEqual(second.verifyCalls, []);
  assert.deepEqual(second.lookups, []);
});

test('a server-controlled rollout flag lets 0.1.79 retain the live-session guard', async () => {
  const { authorizer, events, verifyCalls } = makeAuthorizer({ allowLegacy: true });
  const legacyRunner = { id: 'runner-1', ownerId: 'owner-1', version: '0.1.79' } as never;
  assert.equal(await authorizer.assert(legacyRunner, SESSION_ID, undefined), SESSION_ID);
  assert.deepEqual(events, ['database']);
  assert.deepEqual(verifyCalls, []);
});

test('the rollout bridge is off by default and never applies to credential-capable runners', async () => {
  const legacyRunner = { id: 'runner-1', ownerId: 'owner-1', version: '0.1.79' } as never;
  await assert.rejects(
    () => makeAuthorizer().authorizer.assert(legacyRunner, SESSION_ID, undefined),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'missing orchestration credential',
  );

  await assert.rejects(
    () => makeAuthorizer({ allowLegacy: true }).authorizer.assert(RUNNER, SESSION_ID, undefined),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'missing orchestration credential',
  );

  const olderRunner = { id: 'runner-1', ownerId: 'owner-1', version: '0.1.78' } as never;
  await assert.rejects(
    () =>
      makeAuthorizer({ allowLegacy: true }).authorizer.assert(
        olderRunner,
        SESSION_ID,
        undefined,
      ),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'missing orchestration credential',
  );
});

test('assert verifies the credential before applying the live-session database predicate', async () => {
  const { authorizer, events, verifyCalls, lookups } = makeAuthorizer();
  assert.equal(await authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL), SESSION_ID);
  assert.deepEqual(events, ['verify', 'database']);
  assert.deepEqual(verifyCalls, [
    {
      credential: CREDENTIAL,
      options: { audience: 'orbit-runner-orchestration' },
    },
  ]);
  assert.deepEqual(lookups, [
    {
      id: SESSION_ID,
      ownerId: 'owner-1',
      assignedRunnerId: 'runner-1',
      deletedAt: null,
      cancelRequestedAt: null,
      status: {
        in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED],
      },
      agent: { enableOrchestration: true, deletedAt: null },
    },
  ]);
});

test('assert fails closed on an invalid signature before querying the session', async () => {
  const { authorizer, lookups } = makeAuthorizer({ verifyError: new Error('bad signature') });
  await assert.rejects(
    () => authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'invalid orchestration credential',
  );
  assert.deepEqual(lookups, []);
});

test('assert rejects credentials bound to another purpose, session, or runner before querying', async () => {
  const invalidClaims = [
    { ...VALID_CLAIMS, purpose: 'access' },
    { ...VALID_CLAIMS, sub: 'another-session' },
    { ...VALID_CLAIMS, runnerId: 'another-runner' },
  ];
  for (const claims of invalidClaims) {
    const { authorizer, lookups } = makeAuthorizer({ claims });
    await assert.rejects(
      () => authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL),
      (error: unknown) =>
        error instanceof ForbiddenException && error.message === 'invalid orchestration credential',
    );
    assert.deepEqual(lookups, []);
  }
});

test('orchestration authorization fails closed when no current database row satisfies every guard', async () => {
  const { authorizer } = makeAuthorizer({ result: null });
  await assert.rejects(
    () => authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL),
    (error: unknown) =>
      error instanceof ForbiddenException &&
      error.message === 'orchestration is not enabled for this session',
  );
});
