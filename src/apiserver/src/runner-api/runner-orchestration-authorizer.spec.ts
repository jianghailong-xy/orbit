import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RunStatus } from '@prisma/client';
import {
  createRunnerOrchestrationJwt,
  ORCHESTRATION_CREDENTIAL_INVALID_CODE,
  ORCHESTRATION_CREDENTIAL_MISSING_CODE,
  RUNNER_ORCHESTRATION_TOKEN_TTL_SECONDS,
  RunnerOrchestrationAuthorizer,
} from './runner-orchestration-authorizer';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1', version: '0.1.80' } as never;
const SESSION_ID = 'caller-session';
const CREDENTIAL = 'signed-session-credential';
const VALID_CLAIMS = {
  sub: SESSION_ID,
  runnerId: 'runner-1',
  purpose: 'runner-orchestration',
};

function isCredentialError(
  error: unknown,
  code: string,
  message: string,
): boolean {
  if (!(error instanceof ForbiddenException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: string }).code === code &&
    (response as { message?: string }).message === message
  );
}

function makeAuthorizer(options: {
  result?: { id: string } | null;
  claims?: Record<string, unknown>;
  verifyError?: Error;
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
      events.push('sign');
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
  return {
    authorizer: new RunnerOrchestrationAuthorizer(prisma as never, jwt as never),
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
        expiresIn: RUNNER_ORCHESTRATION_TOKEN_TTL_SECONDS,
      },
    },
  ]);
});

test('orchestration credentials have the explicit 15-minute lifetime', async () => {
  const jwt = createRunnerOrchestrationJwt({
    get: (key: string) => (key === 'JWT_SECRET' ? 'test-secret-at-least-32-bytes-long' : undefined),
  } as never);
  const token = await new RunnerOrchestrationAuthorizer({} as never, jwt).issue(
    'runner-1',
    SESSION_ID,
  );
  const claims = jwt.decode(token) as Record<string, unknown>;
  assert.equal(claims.sub, SESSION_ID);
  assert.equal(claims.aud, 'orbit-runner-orchestration');
  assert.equal(
    Number(claims.exp) - Number(claims.iat),
    RUNNER_ORCHESTRATION_TOKEN_TTL_SECONDS,
  );
});

test('the fallback signing key is domain-derived and rejected by normal access-token JWT', async () => {
  const rootSecret = 'shared-root-secret-at-least-32-bytes-long';
  const orchestrationJwt = createRunnerOrchestrationJwt({
    get: (key: string) => (key === 'JWT_SECRET' ? rootSecret : undefined),
  } as never);
  const token = await new RunnerOrchestrationAuthorizer({} as never, orchestrationJwt).issue(
    'runner-1',
    SESSION_ID,
  );

  await assert.doesNotReject(() =>
    orchestrationJwt.verifyAsync(token, { audience: 'orbit-runner-orchestration' }),
  );
  await assert.rejects(() => new JwtService({ secret: rootSecret }).verifyAsync(token));
});

test('an explicit orchestration secret overrides the derived signing key', async () => {
  const rootSecret = 'shared-root-secret-at-least-32-bytes-long';
  const dedicatedSecret = 'dedicated-orchestration-secret-at-least-32-bytes';
  const dedicatedJwt = createRunnerOrchestrationJwt({
    get: (key: string) =>
      key === 'RUNNER_ORCHESTRATION_JWT_SECRET'
        ? dedicatedSecret
        : key === 'JWT_SECRET'
          ? rootSecret
          : undefined,
  } as never);
  const derivedJwt = createRunnerOrchestrationJwt({
    get: (key: string) => (key === 'JWT_SECRET' ? rootSecret : undefined),
  } as never);
  const token = await new RunnerOrchestrationAuthorizer({} as never, dedicatedJwt).issue(
    'runner-1',
    SESSION_ID,
  );

  await assert.doesNotReject(() =>
    new JwtService({ secret: dedicatedSecret }).verifyAsync(token, {
      audience: 'orbit-runner-orchestration',
    }),
  );
  await assert.rejects(() =>
    derivedJwt.verifyAsync(token, { audience: 'orbit-runner-orchestration' }),
  );
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
      isCredentialError(
        error,
        ORCHESTRATION_CREDENTIAL_MISSING_CODE,
        'missing orchestration credential',
      ),
  );
  assert.deepEqual(second.verifyCalls, []);
  assert.deepEqual(second.lookups, []);
});

test('reissue signs only after the runner still owns an eligible live session', async () => {
  const { authorizer, events, lookups, signCalls } = makeAuthorizer();
  assert.equal(await authorizer.reissue(RUNNER, SESSION_ID), CREDENTIAL);
  assert.deepEqual(events, ['database', 'sign']);
  assert.deepEqual(lookups, [
    {
      id: SESSION_ID,
      ownerId: 'owner-1',
      assignedRunnerId: 'runner-1',
      deletedAt: null,
      cancelRequestedAt: null,
      status: {
        in: [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.AWAITING_INPUT,
          RunStatus.INTERRUPTED,
        ],
      },
      agent: { enableOrchestration: true, deletedAt: null },
    },
  ]);
  assert.equal(signCalls.length, 1);
});

test('reissue denies a session that fails any live ownership or agent guard', async () => {
  const { authorizer, signCalls } = makeAuthorizer({ result: null });
  await assert.rejects(
    () => authorizer.reissue(RUNNER, SESSION_ID),
    (error: unknown) =>
      error instanceof ForbiddenException &&
      error.message === 'orchestration is not enabled for this session',
  );
  assert.deepEqual(signCalls, []);
});

test('assert verifies the credential before applying the open-session database predicate, including PENDING', async () => {
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
        in: [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.AWAITING_INPUT,
          RunStatus.INTERRUPTED,
        ],
      },
      agent: { enableOrchestration: true, deletedAt: null },
    },
  ]);
});

test('assert rechecks live session state on every request, even for the same credential', async () => {
  const { authorizer, events, lookups } = makeAuthorizer();
  await authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL);
  await authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL);
  assert.deepEqual(events, ['verify', 'database', 'verify', 'database']);
  assert.equal(lookups.length, 2);
});

test('assert fails closed on an invalid signature before querying the session', async () => {
  const { authorizer, lookups } = makeAuthorizer({ verifyError: new Error('bad signature') });
  await assert.rejects(
    () => authorizer.assert(RUNNER, SESSION_ID, CREDENTIAL),
    (error: unknown) =>
      isCredentialError(
        error,
        ORCHESTRATION_CREDENTIAL_INVALID_CODE,
        'invalid orchestration credential',
      ),
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
        isCredentialError(
          error,
          ORCHESTRATION_CREDENTIAL_INVALID_CODE,
          'invalid orchestration credential',
        ),
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
