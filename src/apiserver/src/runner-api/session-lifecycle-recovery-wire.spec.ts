/**
 * Session lifecycle and spawn backpressure refusals, over real HTTP, as an agent's `orbit mcp` meets them
 * (docs/recovery-contract.md §11).
 *
 * The runner's session doors (`RunnerSessionsController`) are mounted with the real session guard, the real
 * orchestration authorizer (a credential it issued itself), the global pipe, interceptors and filters
 * main.ts installs, and a real SessionsService over a stub database. Each state is reached through the
 * route an agent calls. Spawn admission, the authorizer and the merge run their own code; the resume, send
 * and interrupt doors are handed the refusal their service throws (the same builders, from
 * session-recovery.ts), because what is asserted here is what crosses the wire.
 *
 * Every case asserts, on the answer as the client reads it: the stable `code`, `owner`, `retryable` and
 * `retryAfterSeconds`, the blocker references in `recovery.resources`, the action code, and — read back
 * through the contract parser in @orbit/shared — the actor, the retry policy and that no automatic resend
 * is offered where none may be.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { parseRecovery, uuidToBase62, type RecoveryEnvelope } from '@orbit/shared';

import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerLinkErrorFilter } from '../common/runner-link-error.filter';
import { SPAWN_TREE_OUTSTANDING } from '../common/session-scheduling';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { EngineSignedOutConflict } from '../sessions/engine-signin-preflight';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { nextTurnStartingRefusal, resumeBlockedRefusal } from '../sessions/session-recovery';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { RUNNER_ORCHESTRATION_JWT, RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { RunnerSessionAuthGuard } from './runner-session-auth.guard';
import { RunnerSessionsController } from './runner-sessions.controller';
import { ServiceTokenAuthorizer } from './service-token.authorizer';

const RUNNER = { id: randomUUID(), ownerId: randomUUID() };
const CALLER = randomUUID();
const ROOT = randomUUID();
const TARGET = randomUUID();
const TOKEN = `runner-token-${randomUUID()}`;
const BLOCKERS = [randomUUID(), randomUUID()];
const WORKSPACES = [randomUUID(), randomUUID()];
/** A workspace whose machine is a managed runner, and that runner. */
const MANAGED_WORKSPACE = randomUUID();
const MANAGED_RUNNER = randomUUID();

/** What the stub database answers; each case sets what it needs. */
const world = {
  callerLive: true,
  orchestrationOn: true,
  parentDepth: 0,
  outstanding: 0,
  startedThisHour: 0,
  oldestInWindow: new Date(),
  workspaces: [] as string[],
  /** What the managed-runner demand hook answers (managed-runner-demand.ts demandAnswer). */
  managed: { managed: false, comingBack: false } as Record<string, unknown>,
};

function reset(): void {
  Object.assign(world, {
    callerLive: true, orchestrationOn: true, parentDepth: 1, outstanding: 0, startedThisHour: 0,
    oldestInWindow: new Date(), workspaces: [], managed: { managed: false, comingBack: false },
  });
}

const prefs = () => (world.orchestrationOn ? {} : { enableOrchestration: false });

const prisma: Record<string, unknown> = {
  runner: { findFirst: async () => ({ ...RUNNER, owner: { disabledAt: null } }) },
  managedRunner: { findUnique: async () => null },
  session: {
    findFirst: async ({ where, select, include }: { where: Record<string, unknown>; select?: Record<string, unknown>; include?: unknown }) => {
      // The authorizer's live-caller read.
      if (where.assignedRunnerId) return world.callerLive ? { id: where.id, owner: { preferences: prefs() } } : null;
      // The engine-row guard in front of a merge.
      if (select?.sessionKind) return { sessionKind: null };
      // resume()'s read of the session it revives: an ended run whose machine is the managed runner,
      // offline (no heartbeat for a day).
      if (include && where.id === TARGET) {
        return {
          id: TARGET, ownerId: RUNNER.ownerId, sessionKind: null, status: 'SUCCEEDED', finishedAt: new Date(), endReason: null,
          wikiChatSpaceId: null, taskId: null, startsTaskWork: false, provider: 'claude', engine: null,
          numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date(Date.now() - 86_400_000),
          cancelRequestedAt: null, deletedAt: null, completedAt: null, archivedAt: null,
          assignedRunnerId: MANAGED_RUNNER,
          assignedRunner: { id: MANAGED_RUNNER, status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 86_400_000) },
        };
      }
      // The oldest spawn in the rate window.
      if (select?.createdAt) return { createdAt: world.oldestInWindow };
      // The parent of a spawn.
      return {
        id: where.id, rootSessionId: ROOT, spawnDepth: world.parentDepth, workspaceId: randomUUID(),
        permissionMode: null, engine: null, owner: { preferences: prefs() },
      };
    },
    count: async ({ where }: { where: { createdAt?: unknown } }) =>
      where.createdAt !== undefined ? world.startedThisHour : world.outstanding,
    findMany: async () => BLOCKERS.map((id) => ({ id })),
    update: async () => ({}),
  },
  workspace: {
    findMany: async () => world.workspaces.map((id) => ({ id })),
    // The machine a named workspace runs on: only MANAGED_WORKSPACE names one here.
    findFirst: async ({ where }: { where: { id?: string } }) =>
      where.id === MANAGED_WORKSPACE ? { runnerId: MANAGED_RUNNER, name: 'managed' } : null,
  },
  user: { findUnique: async () => null },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
};

const sessions = new SessionsService(prisma as never, { notifyRunnerWake: () => undefined } as never, {} as never);
const lent = sessions as unknown as Record<string, unknown>;
// Who may reach whom is session-reach.ts's, tested there; every caller here may.
lent.assertMayReach = async () => undefined;
// A merge queues under its row lock (queueMerge, tested by session-merge-fence.spec.ts); here it is queued.
lent.queueMerge = async () => ({ outcome: 'workspace', operationId: 'op-wire', queuedOn: null });
// The managed-runner demand hook (MANAGED_RUNNER_DEMAND): what the manager last recorded for a runner.
lent.managedDemand = { requested: async () => world.managed };
/** What the resume/send/interrupt/create doors are handed to throw, per case. */
let thrown: () => Error = () => new Error('unset');
lent.resume = async () => { throw thrown(); };
lent.createTurn = async () => { throw thrown(); };
lent.interrupt = async () => { throw thrown(); };

const jwt = new JwtService({ secret: 'wire-test-secret' });
const authorizer = new RunnerOrchestrationAuthorizer(prisma as never, jwt);

let app: INestApplication;
let base: string;
let credential: string;

test.before(async () => {
  @Module({
    controllers: [RunnerSessionsController],
    providers: [
      RunnerSessionAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: ServiceTokenAuthorizer, useValue: { verify: async () => null } },
      { provide: SessionsService, useValue: sessions },
      { provide: RUNNER_ORCHESTRATION_JWT, useValue: jwt },
      { provide: RunnerOrchestrationAuthorizer, useValue: authorizer },
      { provide: MergeReceiptService, useValue: {} },
      { provide: SessionAttemptService, useValue: { chargeSteer: async () => undefined, assertMayEndSession: async () => undefined } },
    ],
  })
  class WireModule {}
  app = await NestFactory.create(WireModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(
    new TransientDbConflictFilter(new RunnerLinkErrorFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter), httpAdapter),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  credential = await authorizer.issue(RUNNER.id, CALLER);
});

test.after(async () => {
  await app?.close();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base.replace('[::1]', '127.0.0.1')}/api/runner/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-orbit-session-id': CALLER,
      'x-orbit-session-token': credential,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
}

/** An id as the wire spells it: the public-id filter answers every id in Base62. */
const wire = (id: string) => uuidToBase62(id);
/** A resource as the wire spells it: the public-id layer adds `publicId` beside every `id`. */
const wireResource = (r: { type: string; id: string }) => ({ type: r.type, id: wire(r.id), publicId: wire(r.id) });

/** The action classes an agent tells apart (docs/recovery-contract.md §11.1). */
const CLASS_OF_ACTION: Record<string, string> = {
  WAIT_FOR_SESSIONS: 'WAIT',
  POLL_STATE: 'POLL',
  RETURN_TO_PARENT: 'RETURN_TO_PARENT',
  CREATE_REPLACEMENT: 'CREATE_REPLACEMENT',
  AWAIT_USER_FIX: 'USER_FIX',
  AWAIT_SYSTEM_FIX: 'SYSTEM_FIX',
  STOP_LOOP: 'STOP_LOOP',
  RETRY: 'RETRY',
  FIX_REQUEST: 'FIX_REQUEST',
};

/**
 * What the agent does with each code (docs/recovery-contract.md §11.2): the disposition the server
 * states, and the one the contract rules derive from the other fields alone.
 */
const DISPOSITION_OF_CODE: Record<string, string> = {
  ORCHESTRATION_DISABLED: 'HUMAN',
  CALLER_SESSION_NOT_LIVE: 'STOP',
  SPAWN_DEPTH_LIMIT: 'STOP',
  SPAWN_TREE_OUTSTANDING_LIMIT: 'WAIT',
  SPAWN_TREE_RATE_LIMIT: 'STOP',
  WORKSPACE_NAME_AMBIGUOUS: 'AUTOMATIC',
  WORKSPACE_NAME_NOT_FOUND: 'AUTOMATIC',
  ENGINE_SIGNED_OUT: 'HUMAN',
  MANAGED_RUNNER_FAILED: 'HUMAN',
  RUNNER_DISK_BELOW_FLOOR: 'HUMAN',
  SESSION_TRASHED: 'HUMAN',
  SESSION_ENDING: 'WAIT',
  SESSION_NOT_TERMINAL: 'WAIT',
  SESSION_NOT_STARTED: 'AUTOMATIC',
  SESSION_MISSING_CONTEXT: 'AUTOMATIC',
  SESSION_NO_RUNNER: 'AUTOMATIC',
  SESSION_RUNNER_OFFLINE: 'WAIT',
  SESSION_ENDED: 'AUTOMATIC',
  SESSION_NEXT_TURN_STARTING: 'AUTOMATIC',
};

interface Expected {
  status: number;
  code: string;
  owner: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
  resources: Array<{ type: string; id: string }>;
  actionCode: string;
  class: string;
  policy: RecoveryEnvelope['retry']['policy'];
}

function assertRefusal(answer: { status: number; text: string; body: Record<string, any> }, want: Expected): RecoveryEnvelope {
  const { body } = answer;
  assert.equal(answer.status, want.status, answer.text);
  assert.equal(body.code, want.code);
  assert.equal(body.owner, want.owner);
  assert.equal(body.retryable, want.retryable);
  assert.equal(body.retryAfterSeconds ?? null, want.retryAfterSeconds);
  assert.equal(body.requiredAction, want.actionCode);
  assert.deepEqual(body.recovery.resources, want.resources.map(wireResource));
  assert.equal(body.recovery.actionCode, want.actionCode);
  assert.equal(CLASS_OF_ACTION[body.recovery.actionCode], want.class);
  // And as the contract parser reads it: the stated block survives normalization unchanged.
  const env = parseRecovery({ source: 'HTTP', status: answer.status, body: answer.text })!;
  assert.equal(env.code, want.code);
  assert.equal(env.effect, 'NONE');
  assert.equal(env.retry.policy, want.policy);
  assert.equal(env.retry.afterSeconds, want.policy === 'NEVER' ? null : want.retryAfterSeconds);
  assert.equal(env.actor, want.owner);
  assert.equal(env.actionCode, want.actionCode);
  assert.equal(env.userConfirmation, 'NOT_REQUIRED');
  assert.equal(body.recovery.disposition, DISPOSITION_OF_CODE[want.code], want.code);
  assert.equal(env.disposition, DISPOSITION_OF_CODE[want.code], want.code);
  const { disposition: _stated, ...unstated } = body.recovery;
  const derived = parseRecovery({ source: 'HTTP', status: answer.status, body: JSON.stringify({ ...body, recovery: unstated }) })!;
  assert.equal(derived.disposition, DISPOSITION_OF_CODE[want.code], `${want.code}: the rules alone`);
  return env;
}

/** No automatic resend may come out of a refusal that waits, stops, or needs a person. */
function assertNoAutomaticResend(env: RecoveryEnvelope): void {
  assert.notEqual(env.retry.policy, 'SAFE');
  assert.notEqual(env.retry.policy, 'SAME_REQUEST_ID');
  assert.ok(env.actionCode !== 'RETRY' && env.actionCode !== 'RETRY_SAME_REQUEST', String(env.actionCode));
}

const spawn = (dto: Record<string, unknown> = {}) => call('POST', 'sessions', { prompt: 'do the work', ...dto });

test('orchestration switched off: the account owner switches it on; the agent is not offered a way past it', async () => {
  reset();
  world.orchestrationOn = false;
  const env = assertRefusal(await spawn(), {
    status: 403, code: 'ORCHESTRATION_DISABLED', owner: 'USER', retryable: false, retryAfterSeconds: null,
    resources: [{ type: 'SESSION', id: CALLER }], actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE',
  });
  assertNoAutomaticResend(env);
});

test('a caller that is no longer a live session stops', async () => {
  reset();
  world.callerLive = false;
  const env = assertRefusal(await spawn(), {
    status: 403, code: 'CALLER_SESSION_NOT_LIVE', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: [{ type: 'SESSION', id: CALLER }], actionCode: 'STOP_LOOP', class: 'STOP_LOOP', policy: 'NEVER',
  });
  assertNoAutomaticResend(env);
});

test('spawn depth limit: return to the parent, and the same spawn is never offered again', async () => {
  reset();
  world.parentDepth = 5;
  const answer = await spawn();
  const env = assertRefusal(answer, {
    status: 403, code: 'SPAWN_DEPTH_LIMIT', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: [{ type: 'SESSION', id: CALLER }, { type: 'SESSION', id: ROOT }], actionCode: 'RETURN_TO_PARENT',
    class: 'RETURN_TO_PARENT', policy: 'NEVER',
  });
  assert.equal(answer.body.spawnDepth, 5);
  assert.equal(answer.body.maxSpawnDepth, 5);
  assertNoAutomaticResend(env);
});

test('unfinished tree cap: wait on the named sessions, never on a timer', async () => {
  reset();
  world.outstanding = SPAWN_TREE_OUTSTANDING;
  const answer = await spawn();
  const env = assertRefusal(answer, {
    status: 429, code: 'SPAWN_TREE_OUTSTANDING_LIMIT', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: BLOCKERS.map((id) => ({ type: 'SESSION', id })), actionCode: 'WAIT_FOR_SESSIONS', class: 'WAIT',
    policy: 'AFTER_STATE_CHANGE',
  });
  assert.equal(answer.body.outstanding, SPAWN_TREE_OUTSTANDING);
  assert.equal(answer.body.limit, SPAWN_TREE_OUTSTANDING);
  assert.equal(answer.body.rootSessionId, wire(ROOT));
  // A 429 alone would read as SAFE (contract §3 rule 6): the stated policy is what keeps it from a resend loop.
  assertNoAutomaticResend(env);
});

test('hourly rate: stop the loop; the wait it names is when the window would admit one, not a resend', async () => {
  reset();
  world.startedThisHour = 60;
  world.oldestInWindow = new Date(Date.now() - 50 * 60_000);
  const answer = await spawn();
  const after = answer.body.retryAfterSeconds as number;
  assert.ok(after > 9 * 60 && after <= 10 * 60, String(after));
  const env = assertRefusal(answer, {
    status: 429, code: 'SPAWN_TREE_RATE_LIMIT', owner: 'CALLER', retryable: false, retryAfterSeconds: after,
    resources: [{ type: 'SESSION', id: ROOT }], actionCode: 'STOP_LOOP', class: 'STOP_LOOP', policy: 'AFTER_STATE_CHANGE',
  });
  assert.equal(answer.body.startedThisHour, 60);
  assertNoAutomaticResend(env);
});

test('workspace name that matches two: fix the request with one of the named workspaces', async () => {
  reset();
  world.workspaces = WORKSPACES;
  const answer = await spawn({ workspaceName: 'twin' });
  assertRefusal(answer, {
    status: 400, code: 'WORKSPACE_NAME_AMBIGUOUS', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: WORKSPACES.map((id) => ({ type: 'WORKSPACE', id })), actionCode: 'FIX_REQUEST', class: 'FIX_REQUEST', policy: 'NEVER',
  });
  assert.equal(answer.body.message, 'multiple workspaces named "twin"; use workspaceId');
});

test('workspace name that matches none: fix the request', async () => {
  reset();
  assertRefusal(await spawn({ workspaceName: 'nobody' }), {
    status: 400, code: 'WORKSPACE_NAME_NOT_FOUND', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: [], actionCode: 'FIX_REQUEST', class: 'FIX_REQUEST', policy: 'NEVER',
  });
});

test('engine signed out: a person signs it in; the runner is the blocker', async () => {
  reset();
  // create() throws this after spawn admission (sessions.service.ts, signedOutEngineRefusal).
  lent.assertChildModeOrNarrow = async () => undefined;
  lent.resolveDefaultEffort = async () => undefined;
  lent.create = async () => { throw new EngineSignedOutConflict('claude', 'Claude is signed out on runner "m"', RUNNER.id); };
  try {
    const answer = await spawn();
    const env = assertRefusal(answer, {
      status: 409, code: 'ENGINE_SIGNED_OUT', owner: 'USER', retryable: false, retryAfterSeconds: null,
      resources: [{ type: 'RUNNER', id: RUNNER.id }], actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE',
    });
    // The typed refusal's own fields are kept.
    assert.equal(answer.body.engine, 'claude');
    assert.equal(answer.body.runnerId, wire(RUNNER.id));
    assertNoAutomaticResend(env);
  } finally {
    delete lent.assertChildModeOrNarrow;
    delete lent.resolveDefaultEffort;
    delete lent.create;
  }
});

const RESUME_CASES: Array<[string, Omit<Expected, 'status' | 'code'>]> = [
  ['TRASHED', { owner: 'USER', retryable: false, retryAfterSeconds: null, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE' }],
  ['ENDING', { owner: 'SYSTEM', retryable: false, retryAfterSeconds: 5, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'POLL_STATE', class: 'POLL', policy: 'AFTER_STATE_CHANGE' }],
  ['NOT_TERMINAL', { owner: 'SYSTEM', retryable: false, retryAfterSeconds: 5, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'POLL_STATE', class: 'POLL', policy: 'AFTER_STATE_CHANGE' }],
  ['NOT_STARTED', { owner: 'CALLER', retryable: false, retryAfterSeconds: null, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'CREATE_REPLACEMENT', class: 'CREATE_REPLACEMENT', policy: 'NEVER' }],
  ['MISSING_CONTEXT', { owner: 'CALLER', retryable: false, retryAfterSeconds: null, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'CREATE_REPLACEMENT', class: 'CREATE_REPLACEMENT', policy: 'NEVER' }],
  ['NO_RUNNER', { owner: 'CALLER', retryable: false, retryAfterSeconds: null, resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'CREATE_REPLACEMENT', class: 'CREATE_REPLACEMENT', policy: 'NEVER' }],
  ['RUNNER_OFFLINE', { owner: 'SYSTEM', retryable: false, retryAfterSeconds: 60, resources: [{ type: 'SESSION', id: TARGET }, { type: 'RUNNER', id: RUNNER.id }], actionCode: 'AWAIT_SYSTEM_FIX', class: 'SYSTEM_FIX', policy: 'AFTER_STATE_CHANGE' }],
];

for (const [reason, want] of RESUME_CASES) {
  test(`session_send with resumeIfEnded, ${reason}: SESSION_${reason}`, async () => {
    reset();
    thrown = () => resumeBlockedRefusal(reason as never, TARGET, RUNNER.id);
    const answer = await call('POST', `sessions/${TARGET}/turns`, { message: 'continue', resumeIfEnded: true });
    const env = assertRefusal(answer, { status: 409, code: `SESSION_${reason}`, ...want });
    assert.equal(answer.body.resumeBlockedReason, reason, 'the session-state reason rides along unchanged');
    assert.equal(answer.body.sessionId, wire(TARGET));
    assertNoAutomaticResend(env);
  });
}

test('session_send to a session in Trash: SESSION_TRASHED, the same code as the resume door', async () => {
  reset();
  thrown = () => SessionNotSendable.trashed(TARGET);
  const answer = await call('POST', `sessions/${TARGET}/turns`, { message: 'hello' });
  assertNoAutomaticResend(assertRefusal(answer, {
    status: 409, code: 'SESSION_TRASHED', owner: 'USER', retryable: false, retryAfterSeconds: null,
    resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE',
  }));
  assert.equal(answer.body.message, 'the session is in Trash; restore it before sending a message');
});

test('session_send to an ended session without resumeIfEnded: SESSION_ENDED, fix the request', async () => {
  reset();
  thrown = () => SessionNotSendable.ended(TARGET);
  assertRefusal(await call('POST', `sessions/${TARGET}/turns`, { message: 'hello' }), {
    status: 409, code: 'SESSION_ENDED', owner: 'CALLER', retryable: false, retryAfterSeconds: null,
    resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'FIX_REQUEST', class: 'FIX_REQUEST', policy: 'NEVER',
  });
});

test('interrupt while the next turn is starting: retry the same call shortly', async () => {
  reset();
  thrown = () => nextTurnStartingRefusal(TARGET);
  const answer = await call('POST', `sessions/${TARGET}/interrupt`, { message: 'stop and do this' });
  const env = assertRefusal(answer, {
    status: 409, code: 'SESSION_NEXT_TURN_STARTING', owner: 'SYSTEM', retryable: true, retryAfterSeconds: 2,
    resources: [{ type: 'SESSION', id: TARGET }], actionCode: 'RETRY', class: 'RETRY', policy: 'SAFE',
  });
  assert.equal(env.retry.afterSeconds, 2);
});

test('an asynchronous merge answers a pending receipt, and session_get-shaped next step', async () => {
  reset();
  const answer = await call('POST', `sessions/${TARGET}/merge`, {});
  assert.equal(answer.status, 201, answer.text);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.outcome, 'PENDING');
  assert.equal(answer.body.mergeStatus, 'pending');
  assert.equal(answer.body.operationId, 'op-wire');
  assert.equal(answer.body.receipt, null);
  assert.equal(answer.body.receiptAbsentReason, 'MERGE_STILL_RUNNING');
  assert.equal(answer.body.sessionId, wire(TARGET));
  assert.deepEqual(answer.body.next, {
    actionCode: 'POLL_STATE',
    afterSeconds: 30,
    resources: [wireResource({ type: 'SESSION', id: TARGET })],
  });
});

test('the Merge button keeps its byte-for-byte { ok: true }', async () => {
  reset();
  assert.deepEqual(await sessions.mergeToMain(RUNNER.ownerId, TARGET), { ok: true });
});

// ── The workspace's machine: a managed runner that failed, or one still coming up ──────────────────
// The production state behind "the workspace is CLONING / FAILED": the managed runner a workspace runs
// on (docs/managed-runner-design.md). These run the real spawn and resume code; only the database and
// the manager's recorded state are stubbed.

const FAILED_RUNNER = {
  managed: true, comingBack: false, state: 'FAILED',
  reason: { code: 'PVC_MISSING', message: 'the data volume is gone', retryable: false }, retryAfter: null,
};

test('spawn into a workspace whose managed runner FAILED: refused before a child exists; a person repairs it', async () => {
  reset();
  world.managed = FAILED_RUNNER;
  let created = 0;
  lent.create = async () => { created++; throw new Error('a child was created'); };
  try {
    const answer = await spawn({ workspaceId: MANAGED_WORKSPACE });
    const env = assertRefusal(answer, {
      status: 409, code: 'MANAGED_RUNNER_FAILED', owner: 'USER', retryable: false, retryAfterSeconds: null,
      resources: [{ type: 'WORKSPACE', id: MANAGED_WORKSPACE }, { type: 'RUNNER', id: MANAGED_RUNNER }],
      actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE',
    });
    assert.equal(answer.body.managementState, 'FAILED');
    assert.deepEqual(answer.body.managedReason, FAILED_RUNNER.reason);
    assert.equal(answer.body.workspaceId, wire(MANAGED_WORKSPACE));
    assert.equal(created, 0, 'nothing is queued onto a machine that will not come back');
    assertNoAutomaticResend(env);
  } finally {
    delete lent.create;
  }
});

test('spawn into a workspace whose managed runner is still coming up: accepted, and the answer says it waits', async () => {
  reset();
  const retryAfter = new Date(Date.now() + 90_000);
  world.managed = { managed: true, comingBack: true, state: 'PROVISIONING', reason: null, retryAfter };
  const child = randomUUID();
  lent.assertChildModeOrNarrow = async () => undefined;
  lent.resolveDefaultEffort = async () => undefined;
  lent.create = async () => ({
    id: child, status: 'PENDING', runStatus: 'PENDING', sessionState: 'PENDING', runState: 'PENDING',
    lifecycleState: 'OPEN', filingState: 'OPEN', title: 'child', workspaceId: MANAGED_WORKSPACE, engine: 'claude', provider: 'claude',
  });
  try {
    const answer = await spawn({ workspaceId: MANAGED_WORKSPACE });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.id, wire(child));
    const after = answer.body.runnerState.retryAfterSeconds as number;
    assert.ok(after >= 85 && after <= 90, String(after));
    assert.deepEqual(answer.body.runnerState, {
      code: 'MANAGED_RUNNER_STARTING', owner: 'SYSTEM', runnerId: wire(MANAGED_RUNNER), managementState: 'PROVISIONING',
      retryAfterSeconds: after,
      // The public-id interceptor's companion of every `runnerId` on a success answer.
      runnerPublicId: wire(MANAGED_RUNNER),
    });
    assert.deepEqual(answer.body.next, {
      actionCode: 'POLL_STATE', afterSeconds: after,
      resources: [wireResource({ type: 'SESSION', id: child }), wireResource({ type: 'RUNNER', id: MANAGED_RUNNER })],
    });
    assert.equal(CLASS_OF_ACTION[answer.body.next.actionCode], 'POLL');
  } finally {
    delete lent.assertChildModeOrNarrow;
    delete lent.resolveDefaultEffort;
    delete lent.create;
  }
});

test('session_send with resumeIfEnded onto a FAILED managed runner: the real resume names a person, not "wait for it"', async () => {
  reset();
  world.managed = { ...FAILED_RUNNER, state: 'FENCING', reason: null };
  // The real SessionsService.resume, not the double the other resume cases are handed.
  delete lent.resume;
  try {
    const answer = await call('POST', `sessions/${TARGET}/turns`, { message: 'continue', resumeIfEnded: true });
    const env = assertRefusal(answer, {
      status: 409, code: 'MANAGED_RUNNER_FAILED', owner: 'USER', retryable: false, retryAfterSeconds: null,
      resources: [{ type: 'SESSION', id: TARGET }, { type: 'RUNNER', id: MANAGED_RUNNER }],
      actionCode: 'AWAIT_USER_FIX', class: 'USER_FIX', policy: 'AFTER_STATE_CHANGE',
    });
    assert.equal(answer.body.managementState, 'FENCING');
    assert.equal(answer.body.sessionId, wire(TARGET));
    assertNoAutomaticResend(env);
  } finally {
    lent.resume = async () => { throw thrown(); };
  }
});
