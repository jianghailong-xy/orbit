import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import {
  ArgumentsHost,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpServer,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { transientDbConflictBody, uuidToBase62 } from '@orbit/shared';

import { sha256 } from '../common/crypto.util';
import { MachineProtocol } from '../common/machine-protocol';
import { isRunnerLinkCall, markRunnerLinkCall } from '../common/runner-link-call';
import {
  DATABASE_UNAVAILABLE_CODE,
  RETRY_AFTER_MS_HEADER,
  RunnerLinkErrorFilter,
} from '../common/runner-link-error.filter';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { AdmitsLinkCallItself, RunnerAuthGuard } from './runner-auth.guard';
import {
  AFTER_SEQ_PENDING_CODE,
  parseRunnerLinkRequest,
  runnerLinkCallListener,
  RUNNER_LINK_TOKEN_HEADER,
} from './runner-link-call';
import { readRunnerLink, runnerLinkCredential, signRunnerLinkToken, type RunnerLinkConfig } from './runner-link-token';

/**
 * Runner link calls without a database (runner-link-call.ts): the internal listener's door, the
 * link's request headers, RunnerAuthGuard's link branch, and the error boundary every link call's
 * refusal and failure leaves through. The routes themselves, over a real PostgreSQL and a socket
 * that drops answers, are runner-link-call.pg.spec.ts.
 */

const GATEWAY_TOKEN = 'a-gateway-secret-that-is-long-enough-for-the-check';

function linkConfig(): RunnerLinkConfig {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const state = readRunnerLink({
    signingKey: Buffer.from(pem, 'utf8').toString('base64'),
    linkUrl: 'wss://link.orbit.invalid',
    gatewayToken: GATEWAY_TOKEN,
  });
  assert.ok(state.config, `the test link did not configure: ${state.problems.join('; ')}`);
  return state.config;
}

// ── the internal listener's door ─────────────────────────────────────────────────────────────────

/** One request through the door: what the app behind it saw, and what the door answered itself. */
function knock(config: RunnerLinkConfig, url: string, authorization?: string) {
  const req = { url, headers: authorization === undefined ? {} : { authorization } } as unknown as IncomingMessage;
  let reached: IncomingMessage | undefined;
  const answer: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    writeHead: (status: number) => {
      answer.status = status;
      return res;
    },
    end: (body: string) => {
      answer.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  runnerLinkCallListener(config, (request) => {
    reached = request;
  })(req, res);
  return { reached, answer, req };
}

test('the internal listener takes only the gateway, and only for the runner routes', () => {
  const config = linkConfig();

  const passed = knock(config, '/api/runner/sessions/claim', `Bearer ${GATEWAY_TOKEN}`);
  assert.equal(passed.reached, passed.req, 'the request reaches the app');
  assert.equal(isRunnerLinkCall(passed.req), true, 'marked a link call on its way in');

  for (const authorization of [undefined, 'Bearer not-the-gateway', `Basic ${GATEWAY_TOKEN}`]) {
    const refused = knock(config, '/api/runner/sessions/claim', authorization);
    assert.equal(refused.reached, undefined, `${authorization ?? 'no credential'} reached the app`);
    assert.equal(refused.answer.status, 401);
    assert.equal(refused.answer.body?.code, 'RUNNER_LINK_GATEWAY_UNAUTHORIZED');
    assert.equal(refused.answer.body?.retryable, false);
    assert.equal(isRunnerLinkCall(refused.req), false);
  }

  for (const url of ['/api/tasks', '/api/runnerx/sessions/claim', '/runner/sessions/claim', '/']) {
    const elsewhere = knock(config, url, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(elsewhere.reached, undefined, `${url} reached the app`);
    assert.equal(elsewhere.answer.status, 404);
    assert.equal(elsewhere.answer.body?.code, 'RUNNER_LINK_ROUTE_UNKNOWN');
  }
});

test('nothing but the internal listener makes a request a link call', () => {
  assert.equal(isRunnerLinkCall({ headers: { 'x-orbit-runner-link-token': 'x' } }), false);
  assert.equal(isRunnerLinkCall(null), false);
  const request = {};
  markRunnerLinkCall(request);
  assert.equal(isRunnerLinkCall(request), true);
  assert.deepEqual(Object.keys(request), [], 'a symbol, not a field a body or a header could spell');
});

// ── the link's own request fields ────────────────────────────────────────────────────────────────

test('a link call names its request id and the events it waits for', () => {
  const sessionId = randomUUID();
  assert.deepEqual(parseRunnerLinkRequest({}), { requestId: null, afterSeq: null });
  assert.deepEqual(
    parseRunnerLinkRequest({
      'x-orbit-link-request-id': 'rq:01HZX-7.a_b',
      'x-orbit-link-session-id': sessionId,
      'x-orbit-link-after-seq': '42',
    }),
    { requestId: 'rq:01HZX-7.a_b', afterSeq: { sessionId, seq: 42 } },
  );
  // Either spelling of the session, as every id position takes it.
  assert.deepEqual(
    parseRunnerLinkRequest({ 'x-orbit-link-session-id': uuidToBase62(sessionId), 'x-orbit-link-after-seq': '7' }).afterSeq,
    { sessionId, seq: 7 },
  );
  // 0 waits for nothing, and then no session is needed.
  assert.equal(parseRunnerLinkRequest({ 'x-orbit-link-after-seq': '0' }).afterSeq, null);

  const refused = (headers: Record<string, string>, code: string) =>
    assert.throws(() => parseRunnerLinkRequest(headers), (error: HttpException) => {
      assert.equal(error.getStatus(), 400);
      assert.equal((error.getResponse() as { code?: string }).code, code);
      return true;
    });
  refused({ 'x-orbit-link-request-id': '' }, 'RUNNER_LINK_BAD_REQUEST_ID');
  refused({ 'x-orbit-link-request-id': 'two words' }, 'RUNNER_LINK_BAD_REQUEST_ID');
  refused({ 'x-orbit-link-request-id': 'x'.repeat(129) }, 'RUNNER_LINK_BAD_REQUEST_ID');
  refused({ 'x-orbit-link-after-seq': '5' }, 'RUNNER_LINK_BAD_AFTER_SEQ');
  refused({ 'x-orbit-link-after-seq': '5', 'x-orbit-link-session-id': 'not an id' }, 'RUNNER_LINK_BAD_AFTER_SEQ');
  refused({ 'x-orbit-link-after-seq': '-1', 'x-orbit-link-session-id': sessionId }, 'RUNNER_LINK_BAD_AFTER_SEQ');
  refused({ 'x-orbit-link-after-seq': '2147483648', 'x-orbit-link-session-id': sessionId }, 'RUNNER_LINK_BAD_AFTER_SEQ');
});

// ── RunnerAuthGuard's link branch ────────────────────────────────────────────────────────────────

@MachineProtocol()
class MachineDoor {
  @AdmitsLinkCallItself()
  admitsItself(): void {}
}
class AgentDoor {}

interface GuardFixture {
  config: RunnerLinkConfig;
  runnerId: string;
  ownerId: string;
  leaseOwner: string;
  token: string;
  /** What the after_seq read answers: no row is a session of another runner. */
  stored: Array<{ stored: boolean }>;
  disabledAt: Date | null;
  tokenHash: string;
}

function guardFixture(): GuardFixture {
  const config = linkConfig();
  const runnerId = randomUUID();
  const ownerId = randomUUID();
  const leaseOwner = randomUUID();
  const tokenHash = sha256('the runner token');
  const { token } = signRunnerLinkToken(
    config,
    { runnerId, ownerId, cellId: 'cell-1', leaseOwner, credential: runnerLinkCredential(tokenHash) },
    new Date(),
  );
  return { config, runnerId, ownerId, leaseOwner, token, stored: [{ stored: true }], disabledAt: null, tokenHash };
}

function guardOf(fixture: GuardFixture, link: 'on' | 'off' | 'absent' = 'on') {
  const prisma = {
    runner: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === fixture.runnerId
          ? { id: fixture.runnerId, ownerId: fixture.ownerId, tokenHash: fixture.tokenHash, owner: { disabledAt: fixture.disabledAt } }
          : null,
      findFirst: async () => assert.fail('a link call looked the runner up by a runner token'),
    },
    managedRunner: { findUnique: async () => null },
    $queryRaw: async () => fixture.stored,
  };
  const state = link === 'absent' ? undefined : { config: link === 'on' ? fixture.config : null, problems: [] };
  return new RunnerAuthGuard(prisma as never, state);
}

function contextOf(
  request: Record<string, unknown>,
  controller: object = MachineDoor,
  handler?: (...args: never[]) => unknown,
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function linkRequest(headers: Record<string, string>): Record<string, unknown> {
  const request: Record<string, unknown> = { headers };
  markRunnerLinkCall(request);
  return request;
}

async function refusedWith(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  await assert.rejects(promise, (error: HttpException) => {
    assert.equal(error.getStatus(), status);
    if (code) assert.equal((error.getResponse() as { code?: string }).code, code);
    return true;
  });
}

test('a link call is the runner its link token names, with the process the token was minted for', async () => {
  const fixture = guardFixture();
  const requestId = 'claim-1';
  const sessionId = randomUUID();
  const request = linkRequest({
    [RUNNER_LINK_TOKEN_HEADER]: fixture.token,
    'x-orbit-link-request-id': requestId,
    'x-orbit-link-session-id': sessionId,
    'x-orbit-link-after-seq': '9',
    'x-orbit-link-gateway-id': 'orbit-link-gateway',
  });
  assert.equal(await guardOf(fixture).canActivate(contextOf(request)), true);
  assert.equal((request.runner as { id: string }).id, fixture.runnerId);
  assert.deepEqual(request.runnerLink, {
    leaseOwner: fixture.leaseOwner, requestId, afterSeq: { sessionId, seq: 9 }, gatewayId: 'orbit-link-gateway',
  });
  assert.equal(request.managedRunnerInstance, undefined);
});

test('a link call is refused without a token the link vouches for, and off the machine protocol', async () => {
  const fixture = guardFixture();
  const withToken = (token: string) => linkRequest({ [RUNNER_LINK_TOKEN_HEADER]: token });

  await refusedWith(guardOf(fixture).canActivate(contextOf(linkRequest({}))), 401, 'RUNNER_LINK_TOKEN_REFUSED');
  await refusedWith(guardOf(fixture).canActivate(contextOf(withToken(`${fixture.token}x`))), 401, 'RUNNER_LINK_TOKEN_REFUSED');
  // Signed by another link's key.
  const stranger = signRunnerLinkToken(
    linkConfig(),
    { runnerId: fixture.runnerId, ownerId: fixture.ownerId, cellId: 'cell-1', leaseOwner: fixture.leaseOwner, credential: runnerLinkCredential(fixture.tokenHash) },
    new Date(),
  ).token;
  await refusedWith(guardOf(fixture).canActivate(contextOf(withToken(stranger))), 401, 'RUNNER_LINK_TOKEN_REFUSED');
  // Expired an hour and a minute ago.
  const expired = signRunnerLinkToken(
    fixture.config,
    { runnerId: fixture.runnerId, ownerId: fixture.ownerId, cellId: 'cell-1', leaseOwner: fixture.leaseOwner, credential: runnerLinkCredential(fixture.tokenHash) },
    new Date(Date.now() - 61 * 60_000),
  ).token;
  await refusedWith(guardOf(fixture).canActivate(contextOf(withToken(expired))), 401, 'RUNNER_LINK_TOKEN_REFUSED');

  // The runner's credential was replaced since the token was minted: revoked here at once.
  const rotated = { ...fixture, tokenHash: sha256('a rotated runner token') };
  await refusedWith(guardOf(rotated).canActivate(contextOf(withToken(fixture.token))), 401, 'RUNNER_LINK_TOKEN_REVOKED');
  // Deleted.
  const deleted = { ...fixture, runnerId: randomUUID() };
  await refusedWith(guardOf(deleted).canActivate(contextOf(withToken(fixture.token))), 401, 'RUNNER_LINK_TOKEN_REVOKED');
  // A disabled account's runner, as over HTTPS.
  await refusedWith(
    guardOf({ ...fixture, disabledAt: new Date() }).canActivate(contextOf(withToken(fixture.token))),
    403,
    'ACCOUNT_DISABLED',
  );

  // The agent tool API under /api/runner stays on HTTPS (D14).
  await refusedWith(
    guardOf(fixture).canActivate(contextOf(withToken(fixture.token), AgentDoor)),
    404,
    'RUNNER_LINK_ROUTE_NOT_ON_LINK',
  );
  // A process whose link is off, or a guard built without it, takes no link call at all.
  await refusedWith(guardOf(fixture, 'off').canActivate(contextOf(withToken(fixture.token))), 404, 'RUNNER_LINK_NOT_CONFIGURED');
  await refusedWith(guardOf(fixture, 'absent').canActivate(contextOf(withToken(fixture.token))), 404, 'RUNNER_LINK_NOT_CONFIGURED');
});

test('a route that admits link calls itself is handed the token\'s word and reads nothing; a bad token is still refused', async () => {
  const fixture = guardFixture();
  const reads: string[] = [];
  const guard = guardOf(fixture);
  const prisma = (guard as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
  prisma.runner.findUnique = async () => void reads.push('runner');
  prisma.managedRunner.findUnique = async () => void reads.push('managedRunner');
  const admitsItself = MachineDoor.prototype.admitsItself;
  const request = linkRequest({ [RUNNER_LINK_TOKEN_HEADER]: fixture.token, 'x-orbit-link-gateway-id': 'orbit-link-gateway' });
  assert.equal(await guard.canActivate(contextOf(request, MachineDoor, admitsItself)), true);
  assert.equal(reads.length, 0, 'the route admits the caller in its own statement (link-heartbeat.ts)');
  assert.deepEqual(request.runner, { id: fixture.runnerId, ownerId: fixture.ownerId });
  assert.deepEqual(request.runnerLink, {
    leaseOwner: fixture.leaseOwner,
    requestId: null,
    afterSeq: null,
    gatewayId: 'orbit-link-gateway',
    admission: { credential: runnerLinkCredential(fixture.tokenHash), ownerId: fixture.ownerId },
  });
  // The token itself is checked as for every link call.
  await refusedWith(
    guard.canActivate(contextOf(linkRequest({ [RUNNER_LINK_TOKEN_HEADER]: `${fixture.token}x` }), MachineDoor, admitsItself)),
    401,
    'RUNNER_LINK_TOKEN_REFUSED',
  );
  // Over HTTPS the route is the guard's like any other: it reads the runner by its token.
  const https = { headers: { authorization: 'Bearer the runner token' } };
  prisma.runner.findFirst = async () => {
    reads.push('runner by token');
    return { id: fixture.runnerId, ownerId: fixture.ownerId, tokenHash: fixture.tokenHash, owner: { disabledAt: null } };
  };
  assert.equal(await guard.canActivate(contextOf(https, MachineDoor, admitsItself)), true);
  assert.deepEqual(reads, ['runner by token', 'managedRunner']);
});

test('a link call waiting for events not yet stored is refused before its route runs, as retryable', async () => {
  const fixture = guardFixture();
  const request = () =>
    linkRequest({
      [RUNNER_LINK_TOKEN_HEADER]: fixture.token,
      'x-orbit-link-session-id': randomUUID(),
      'x-orbit-link-after-seq': '12',
    });
  fixture.stored = [{ stored: false }];
  await assert.rejects(guardOf(fixture).canActivate(contextOf(request())), (error: HttpException) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(
      { ...(error.getResponse() as Record<string, unknown>), message: undefined },
      {
        statusCode: 503,
        error: 'Service Unavailable',
        code: AFTER_SEQ_PENDING_CODE,
        message: undefined,
        afterSeq: 12,
        retryable: true,
        retryAfterMs: 250,
      },
    );
    return true;
  });
  // Another runner's session.
  fixture.stored = [];
  await refusedWith(guardOf(fixture).canActivate(contextOf(request())), 403);
});

test('a request over HTTPS is the runner its runner token names, whatever link headers it carries', async () => {
  const fixture = guardFixture();
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === sha256('the runner token')
          ? { id: fixture.runnerId, ownerId: fixture.ownerId, tokenHash: fixture.tokenHash, owner: { disabledAt: null } }
          : null,
      findUnique: async () => assert.fail('an HTTPS request was read as a link call'),
    },
    managedRunner: { findUnique: async () => null },
    $queryRaw: async () => assert.fail('an HTTPS request waited for events'),
  };
  const request: Record<string, unknown> = {
    headers: {
      authorization: 'Bearer the runner token',
      [RUNNER_LINK_TOKEN_HEADER]: fixture.token,
      'x-orbit-link-request-id': 'claim-1',
      'x-orbit-link-session-id': randomUUID(),
      'x-orbit-link-after-seq': '12',
    },
  };
  const guard = new RunnerAuthGuard(prisma as never, { config: fixture.config, problems: [] });
  assert.equal(await guard.canActivate(contextOf(request, AgentDoor)), true);
  assert.equal((request.runner as { id: string }).id, fixture.runnerId);
  assert.equal(request.runnerLink, undefined);
});

// ── the error boundary ───────────────────────────────────────────────────────────────────────────

const CLIENT_VERSION = '7.9.1';

/** A raw query PostgreSQL failed with `sqlstate`, wrapped the way Prisma 7 wraps it. */
function rawQueryFailed(sqlstate: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlstate}\`. Message: \`SELECT secret\``, {
    code: 'P2010',
    clientVersion: CLIENT_VERSION,
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: sqlstate, originalMessage: 'SELECT secret' } } },
  });
}

/** Prisma's own codes for a pool that handed out no connection, and a transaction that could not start. */
const prismaCode = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool', {
    code,
    clientVersion: CLIENT_VERSION,
  });

interface Served {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** The object the last filter in the chain was handed. */
  handed: unknown;
}

/** One exception through main.ts's chain, with a recording filter where the id filter sits. */
function serve(exception: unknown, linkCall: boolean): Served {
  const headers: Record<string, string> = {};
  const response = { getHeader: (name: string) => headers[name.toLowerCase()] };
  const adapter = {
    isHeadersSent: () => false,
    setHeader: (_res: unknown, name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as HttpServer;
  let handed: unknown;
  const last = { catch: (error: unknown) => (handed = error) };
  const request: Record<string, unknown> = { method: 'POST', route: { path: '/api/runner/sessions/:id/turn-complete' } };
  if (linkCall) markRunnerLinkCall(request);
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new TransientDbConflictFilter(new RunnerLinkErrorFilter(last, adapter), adapter).catch(exception, host);
  const answer = handed instanceof HttpException ? handed : undefined;
  return {
    status: answer?.getStatus() ?? 500,
    body: (answer?.getResponse() as Record<string, unknown>) ?? {},
    headers,
    handed,
  };
}

test('a database resource fault answers a link call with a retryable 503, and HTTPS as before', () => {
  for (const fault of [
    prismaCode('P2024'),
    prismaCode('P2028'),
    rawQueryFailed('08006'),
    rawQueryFailed('53300'),
    rawQueryFailed('57P01'),
    rawQueryFailed('57014'),
    rawQueryFailed('58030'),
  ]) {
    const label = String((fault.meta as { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined)
      ?.driverAdapterError?.cause?.originalCode ?? fault.code);
    const link = serve(fault, true);
    assert.equal(link.status, 503, `${label} over the link`);
    assert.equal(link.body.code, DATABASE_UNAVAILABLE_CODE, label);
    assert.equal(link.body.retryable, true, label);
    assert.equal(link.body.retryAfterMs, 2000, label);
    assert.equal(link.headers['retry-after'], '2', label);
    assert.equal(link.headers[RETRY_AFTER_MS_HEADER.toLowerCase()], '2000', label);
    assert.doesNotMatch(JSON.stringify(link.body), /secret|connection pool/, `${label}: the driver's words leaked`);

    // Over HTTPS the same fault is handed on unchanged, to become the 500 it always was.
    const https = serve(fault, false);
    assert.equal(https.handed, fault, `${label} over HTTPS`);
    assert.deepEqual(https.headers, {});
  }
});

test("a rolled-back transaction answers a link call with the conflict boundary's 503, completed", () => {
  const conflict = rawQueryFailed('40P01');
  const link = serve(conflict, true);
  assert.equal(link.status, 503);
  assert.deepEqual(link.body, { ...transientDbConflictBody(), retryAfterMs: 1000 });
  assert.equal(link.headers['retry-after'], '1');
  assert.equal(link.headers[RETRY_AFTER_MS_HEADER.toLowerCase()], '1000');

  const https = serve(conflict, false);
  assert.deepEqual(https.body, transientDbConflictBody(), 'HTTPS gets the shared body as it is');
  assert.equal(https.headers[RETRY_AFTER_MS_HEADER.toLowerCase()], undefined);
});

test("every refusal a link call gets says its code and whether to send it again; HTTPS' are untouched", () => {
  const closed = new ConflictException('session is no longer open');
  const link = serve(closed, true);
  assert.equal(link.status, 409);
  assert.deepEqual(link.body, {
    statusCode: 409,
    error: 'Conflict',
    message: 'session is no longer open',
    code: 'CONFLICT',
    retryable: false,
  });
  assert.deepEqual(link.headers, {}, 'no retry hint on a refusal that will not change');
  assert.equal(serve(closed, false).handed, closed, 'over HTTPS the identical object goes on');

  // A body's own code and verdict are kept.
  const coded = serve(new HttpException({ code: 'TASK_RUN_REQUEST_IN_PROGRESS', message: 'ask again', retryable: true }, 409), true);
  assert.equal(coded.body.code, 'TASK_RUN_REQUEST_IN_PROGRESS');
  assert.equal(coded.body.retryable, true);
  // A string body, and a status that is worth another try.
  const plain = serve(new HttpException('too many', 429), true);
  assert.deepEqual(plain.body, { statusCode: 429, message: 'too many', code: 'TOO_MANY_REQUESTS', retryable: true });

  // A bug is the 500 it always was, worth another try; a failure the data decided is not.
  const bug = serve(new TypeError('undefined is not a function'), true);
  assert.equal(bug.status, 500);
  assert.equal(bug.body.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(bug.body.retryable, true);
  assert.doesNotMatch(JSON.stringify(bug.body), /undefined is not a function/);
  const duplicate = serve(rawQueryFailed('23505'), true);
  assert.equal(duplicate.status, 500);
  assert.equal(duplicate.body.retryable, false);
});
