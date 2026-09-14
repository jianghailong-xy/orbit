import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { uuidToBase62 } from '@orbit/shared';
import { assertLeavesFitTargets, parseRequestedPredicate } from '../watches/watch-request';
import { WatchesService } from '../watches/watches.service';
import { RunnerWatchesController, WATCH_RELEASE_OUTCOMES } from './runner-watches.controller';

/**
 * The agent door onto Watch (docs/watch-contract.md §13), with its collaborators stood in: who the door
 * lets in, whom a watch wakes, what an agent may read, and what a release takes back. The service it
 * calls is covered over real PostgreSQL by the watches/*.pg.spec.ts files; this file is about the door.
 */

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;
const CALLER = randomUUID();
const WATCH_ID = randomUUID();
const TOKEN = 'signed-session-credential';
const TASK_PREDICATE = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' };
const SESSION_PREDICATE = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' };

// From build/runner-api back to the repository root.
const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'));

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: WATCH_ID,
    observerType: 'SESSION',
    observerSessionId: CALLER,
    predicateVersion: 1,
    predicate: TASK_PREDICATE,
    mode: 'ONE_SHOT',
    action: 'RESUME_SESSION',
    state: 'ACTIVE',
    generation: 0,
    targets: [],
    matches: [],
    expiryDeliveries: [],
    ...overrides,
  };
}

function delivery(state: string, overrides: Record<string, unknown> = {}) {
  return { id: randomUUID(), action: 'RESUME_SESSION', state, attempts: 0, lastError: null, ...overrides };
}

function matched(deliveryState: string, action = 'RESUME_SESSION') {
  return view({
    state: 'MATCHED',
    generation: 1,
    action,
    matches: [{ id: randomUUID(), generation: 1, reason: 'ALL TASK_TERMINAL 1/1', deliveries: [delivery(deliveryState, { action })] }],
  });
}

interface HarnessOptions {
  /** Whether the calling session is one this runner hosts. */
  hosted?: boolean;
  orchestration?: boolean;
  /** What successive `watches.get` calls answer; the last one keeps answering. */
  views?: Array<Record<string, unknown>>;
  missing?: boolean;
  cancelConflicts?: boolean;
  turns?: Record<string, { id: string; status: string }>;
  withdrawConflicts?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sessionLookups: Array<Record<string, unknown>> = [];
  const views = [...(options.views ?? [view()])];
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer(...args);
    };
  const prisma = {
    session: {
      findFirst: async (query: { where: Record<string, unknown> }) => {
        sessionLookups.push(query.where);
        return options.hosted === false ? null : { id: query.where.id };
      },
    },
    conversationTurn: {
      findUnique: async (query: { where: { sessionId_clientTurnId: { sessionId: string; clientTurnId: string } } }) => {
        const { sessionId, clientTurnId } = query.where.sessionId_clientTurnId;
        calls.push({ method: 'conversationTurn.findUnique', args: [sessionId, clientTurnId] });
        return options.turns?.[clientTurnId] ?? null;
      },
    },
  };
  const watches = {
    create: record('watches.create', () => view()),
    list: record('watches.list', () => [view()]),
    get: record('watches.get', () => {
      if (options.missing) throw new NotFoundException('watch not found');
      return views.length > 1 ? views.shift() : views[0];
    }),
    update: record('watches.update', () => view()),
    cancel: record('watches.cancel', () => {
      if (options.cancelConflicts) throw new ConflictException({ message: 'a MATCHED watch cannot be cancelled', state: 'MATCHED' });
      return view({ state: 'CANCELLED' });
    }),
  };
  const sessions = {
    cancelQueuedTurn: record('sessions.cancelQueuedTurn', () => {
      if (options.withdrawConflicts) throw new ConflictException('message already started or not found');
      return { ok: true };
    }),
  };
  const orchestration = {
    assert: record('orchestration.assert', (_runner, sessionId) => {
      if (options.orchestration === false) throw new ForbiddenException('orchestration is not enabled for this session');
      return sessionId;
    }),
  };
  return {
    controller: new RunnerWatchesController(prisma as never, watches as never, sessions as never, orchestration as never),
    calls,
    sessionLookups,
    methods: () => calls.map((call) => call.method),
  };
}

type Route = {
  name: 'create' | 'list' | 'get' | 'update' | 'cancel' | 'release';
  path: string;
  method: RequestMethod;
  invoke: (controller: RunnerWatchesController, caller: string | undefined) => Promise<unknown>;
};

const ROUTES: Route[] = [
  {
    name: 'create',
    path: 'watches',
    method: RequestMethod.POST,
    invoke: (c, caller) =>
      c.create(RUNNER, caller, TOKEN, { predicateVersion: 1, predicate: TASK_PREDICATE, targets: [{ kind: 'TASK', id: randomUUID() }] }),
  },
  { name: 'list', path: 'watches', method: RequestMethod.GET, invoke: (c, caller) => c.list(RUNNER, caller, undefined) },
  { name: 'get', path: 'watches/:id', method: RequestMethod.GET, invoke: (c, caller) => c.get(RUNNER, caller, WATCH_ID) },
  {
    name: 'update',
    path: 'watches/:id',
    method: RequestMethod.PATCH,
    invoke: (c, caller) => c.update(RUNNER, caller, WATCH_ID, { ttlSeconds: 600 }),
  },
  { name: 'cancel', path: 'watches/:id/cancel', method: RequestMethod.POST, invoke: (c, caller) => c.cancel(RUNNER, caller, WATCH_ID) },
  { name: 'release', path: 'watches/:id/release', method: RequestMethod.POST, invoke: (c, caller) => c.release(RUNNER, caller, WATCH_ID) },
];

test('the agent watch door serves exactly the routes the contract names', () => {
  const prototype = RunnerWatchesController.prototype as unknown as Record<string, object>;
  for (const route of ROUTES) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, prototype[route.name]), route.path, route.name);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, prototype[route.name]), route.method, route.name);
  }
  // A cancel and a release change a watch that exists, so they answer 200 as the user door's cancel does.
  for (const name of ['cancel', 'release']) {
    assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, prototype[name]), 200, name);
  }
  assert.deepEqual(
    ROUTES.map((route) => `${RequestMethod[route.method]} /api/runner/${route.path}`).sort(),
    [...CONTRACT.agentSurface.runnerDoor.routes].sort(),
  );
  assert.deepEqual([...WATCH_RELEASE_OUTCOMES].sort(), Object.keys(CONTRACT.agentSurface.release.outcomes).sort());
});

test('every route refuses a request that names no calling session before it touches a watch', async () => {
  for (const route of ROUTES) {
    for (const caller of [undefined, '   ']) {
      const { controller, methods, sessionLookups } = harness();
      await assert.rejects(() => route.invoke(controller, caller), BadRequestException, route.name);
      assert.deepEqual(methods(), [], `${route.name} called a collaborator`);
      assert.deepEqual(sessionLookups, [], route.name);
    }
  }
});

test('every route refuses a session this runner does not host, looked up by owner, runner and liveness', async () => {
  for (const route of ROUTES) {
    const { controller, methods, sessionLookups } = harness({ hosted: false });
    await assert.rejects(() => route.invoke(controller, CALLER), ForbiddenException, route.name);
    assert.deepEqual(sessionLookups, [{ id: CALLER, ownerId: 'owner-1', assignedRunnerId: 'runner-1', deletedAt: null }], route.name);
    assert.deepEqual(methods(), [], `${route.name} called a collaborator`);
  }
});

test('the calling session is recognised in the base62 spelling the runner environment carries', async () => {
  const { controller, sessionLookups } = harness();
  await controller.get(RUNNER, uuidToBase62(CALLER), WATCH_ID);
  assert.equal(sessionLookups[0].id, CALLER);
});

test('a watch over tasks observes the calling session, wakes it by default and needs no orchestration credential', async () => {
  const { controller, calls, methods } = harness();
  const tasks = Array.from({ length: 7 }, () => ({ kind: 'TASK' as const, id: randomUUID() }));
  const predicate = CONTRACT.agentSurface.awaitPresets.task_await.until.ALL_TERMINAL_OR_ANY_FAILED;
  // A body that names another observer does not choose whom the watch wakes.
  const body = { predicateVersion: 1, predicate, targets: tasks, observerSessionId: randomUUID(), ttlSeconds: 3600, idempotencyKey: 'k-1' };
  await controller.create(RUNNER, CALLER, undefined, body as never);
  assert.deepEqual(methods(), ['watches.create']);
  assert.deepEqual(calls[0].args, [
    'owner-1',
    {
      predicateVersion: 1,
      predicate,
      targets: tasks,
      action: 'RESUME_SESSION',
      observerSessionId: CALLER,
      ttlSeconds: 3600,
      idempotencyKey: 'k-1',
    },
  ]);
});

test('an agent may ask for a notification to its person instead of a wake', async () => {
  const { controller, calls } = harness();
  await controller.create(RUNNER, CALLER, undefined, {
    predicateVersion: 1,
    predicate: TASK_PREDICATE,
    targets: [{ kind: 'TASK', id: randomUUID() }],
    action: 'NOTIFY_USER',
  });
  assert.equal((calls[0].args[1] as { action: string }).action, 'NOTIFY_USER');
});

test('a watch that names a session asks for the credential session_get asks for, and is not created without it', async () => {
  const targets = [{ kind: 'SESSION' as const, id: randomUUID() }];
  const refused = harness({ orchestration: false });
  await assert.rejects(
    () => refused.controller.create(RUNNER, CALLER, TOKEN, { predicateVersion: 1, predicate: SESSION_PREDICATE, targets }),
    ForbiddenException,
  );
  assert.deepEqual(refused.methods(), ['orchestration.assert']);

  const allowed = harness();
  await allowed.controller.create(RUNNER, CALLER, TOKEN, { predicateVersion: 1, predicate: SESSION_PREDICATE, targets });
  assert.deepEqual(allowed.methods(), ['orchestration.assert', 'watches.create']);
  assert.deepEqual(allowed.calls[0].args, [RUNNER, CALLER, TOKEN]);
});

test('reads are confined to the watches the calling session observes', async () => {
  const { controller, calls } = harness();
  await controller.list(RUNNER, CALLER, 'ACTIVE');
  await controller.get(RUNNER, CALLER, WATCH_ID);
  assert.deepEqual(
    calls.map((call) => [call.method, call.args]),
    [
      ['watches.list', ['owner-1', 'ACTIVE', { observerSessionId: CALLER }]],
      ['watches.get', ['owner-1', WATCH_ID, { observerSessionId: CALLER }]],
    ],
  );
});

test('an edit or a cancel reaches only a watch the calling session observes', async () => {
  const cases = [
    ['update', (c: RunnerWatchesController) => c.update(RUNNER, CALLER, WATCH_ID, { ttlSeconds: 600 }), 'watches.update'],
    ['cancel', (c: RunnerWatchesController) => c.cancel(RUNNER, CALLER, WATCH_ID), 'watches.cancel'],
  ] as const;
  for (const [name, invoke, write] of cases) {
    const foreign = harness({ missing: true });
    await assert.rejects(() => invoke(foreign.controller), NotFoundException, name);
    assert.deepEqual(foreign.methods(), ['watches.get'], `${name} wrote to a watch it could not read`);

    const own = harness();
    await invoke(own.controller);
    assert.deepEqual(own.methods(), ['watches.get', write], name);
    assert.deepEqual(own.calls[0].args, ['owner-1', WATCH_ID, { observerSessionId: CALLER }], name);
  }
});

test('release cancels a watch that is still waiting, and a cancelled watch wakes nobody', async () => {
  for (const state of ['ACTIVE', 'PAUSED']) {
    const { controller, methods } = harness({ views: [view({ state })] });
    const released = await controller.release(RUNNER, CALLER, WATCH_ID);
    assert.equal(released.outcome, 'CANCELLED', state);
    assert.equal(released.watch.state, 'CANCELLED', state);
    assert.deepEqual(methods(), ['watches.get', 'watches.cancel'], state);
  }
});

test('release withdraws the queued wake of a watch that matched while the cancel was deciding', async () => {
  const turnId = randomUUID();
  const key = `watch:${WATCH_ID}:1`;
  const { controller, calls, methods } = harness({
    views: [view(), matched('DELIVERED'), matched('DEAD_LETTER')],
    cancelConflicts: true,
    turns: { [key]: { id: turnId, status: 'PENDING' } },
  });
  const released = await controller.release(RUNNER, CALLER, WATCH_ID);
  assert.equal(released.outcome, 'WAKE_WITHDRAWN');
  assert.deepEqual(methods(), [
    'watches.get',
    'watches.cancel',
    'watches.get',
    'conversationTurn.findUnique',
    'sessions.cancelQueuedTurn',
    'watches.get',
  ]);
  assert.deepEqual(calls.find((call) => call.method === 'conversationTurn.findUnique')?.args, [CALLER, key]);
  // The owner's own withdrawal, which dead-letters the delivery in the transaction that deletes the turn.
  assert.deepEqual(calls.find((call) => call.method === 'sessions.cancelQueuedTurn')?.args, ['owner-1', CALLER, turnId]);
});

test('release says to ask again while the wake is not queued yet, and withdraws nothing', async () => {
  for (const state of ['PENDING', 'IN_FLIGHT']) {
    const { controller, methods } = harness({ views: [matched(state)] });
    assert.equal((await controller.release(RUNNER, CALLER, WATCH_ID)).outcome, 'WAKE_NOT_QUEUED', state);
    assert.ok(!methods().includes('sessions.cancelQueuedTurn'), state);
  }
});

test('release reports a wake a runner already took, before the read or during the withdrawal', async () => {
  const key = `watch:${WATCH_ID}:1`;
  const taken = harness({ views: [matched('DELIVERED')], turns: { [key]: { id: randomUUID(), status: 'IN_FLIGHT' } } });
  assert.equal((await taken.controller.release(RUNNER, CALLER, WATCH_ID)).outcome, 'ALREADY_WOKEN');
  assert.ok(!taken.methods().includes('sessions.cancelQueuedTurn'));

  const raced = harness({
    views: [matched('DELIVERED')],
    turns: { [key]: { id: randomUUID(), status: 'PENDING' } },
    withdrawConflicts: true,
  });
  assert.equal((await raced.controller.release(RUNNER, CALLER, WATCH_ID)).outcome, 'ALREADY_WOKEN');
});

test("release withdraws the one turn a watch's end owes, under that end's own key", async () => {
  const ends = [
    ['EXPIRED', 'EXPIRY', 'expired'],
    ['REVOKED', 'REVOKED', 'revoked'],
    ['UNRESOLVABLE', 'UNRESOLVABLE', 'unresolvable'],
  ] as const;
  for (const [state, kind, suffix] of ends) {
    const turnId = randomUUID();
    const { controller, calls } = harness({
      views: [view({ state, expiryDeliveries: [delivery('DELIVERED', { kind })] })],
      turns: { [`watch:${WATCH_ID}:${suffix}`]: { id: turnId, status: 'PENDING' } },
    });
    assert.equal((await controller.release(RUNNER, CALLER, WATCH_ID)).outcome, 'WAKE_WITHDRAWN', state);
    assert.deepEqual(calls.find((call) => call.method === 'sessions.cancelQueuedTurn')?.args, ['owner-1', CALLER, turnId], state);
  }
});

test('release owes nothing for a cancelled watch, a notification, or a wake already dead-lettered', async () => {
  const cases = [
    ['cancelled', view({ state: 'CANCELLED' })],
    ['notification', matched('DELIVERED', 'NOTIFY_USER')],
    ['dead letter', matched('DEAD_LETTER')],
  ] as const;
  for (const [label, watch] of cases) {
    const { controller, methods } = harness({ views: [watch] });
    assert.equal((await controller.release(RUNNER, CALLER, WATCH_ID)).outcome, 'NOTHING_OWED', label);
    assert.deepEqual(methods(), ['watches.get', 'watches.get'], label);
  }
});

test('WatchesService confines a read to one observer only when asked', async () => {
  const wheres: unknown[] = [];
  const prisma = {
    watch: {
      findFirst: async (query: { where: unknown }) => {
        wheres.push(query.where);
        return { id: WATCH_ID };
      },
      findMany: async (query: { where: unknown }) => {
        wheres.push(query.where);
        return [];
      },
    },
  };
  const service = new WatchesService(prisma as never);
  await service.get('owner-1', WATCH_ID);
  await service.get('owner-1', WATCH_ID, { observerSessionId: CALLER });
  await service.list('owner-1');
  await service.list('owner-1', 'MATCHED', { observerSessionId: CALLER });
  assert.deepEqual(wheres, [
    { id: WATCH_ID, ownerId: 'owner-1' },
    { id: WATCH_ID, ownerId: 'owner-1', observerSessionId: CALLER },
    { ownerId: 'owner-1' },
    { ownerId: 'owner-1', state: 'MATCHED', observerSessionId: CALLER },
  ]);
});

test('every await preset the contract gives agents is a predicate this server accepts for the targets it names', () => {
  const families = Object.entries<{ targetKind: 'TASK' | 'SESSION'; default: string; until: Record<string, unknown> }>(
    CONTRACT.agentSurface.awaitPresets,
  );
  assert.deepEqual(families.map(([tool]) => tool).sort(), ['session_await', 'task_await']);
  // Parsed under the grammar the agent tools send them in: runner-go's watchPredicateVersion.
  const toolsVersion = 1;
  for (const [tool, family] of families) {
    for (const [until, predicate] of Object.entries(family.until)) {
      const parsed = parseRequestedPredicate(predicate, toolsVersion);
      assert.deepEqual(parsed, predicate, `${tool} ${until} did not survive the request parser unchanged`);
      assert.doesNotThrow(() => assertLeavesFitTargets(parsed, [family.targetKind]), `${tool} ${until}`);
    }
  }
  const wait = CONTRACT.agentSurface.sessionCreateWait.watch.predicate;
  assert.doesNotThrow(() => assertLeavesFitTargets(parseRequestedPredicate(wait, toolsVersion), ['SESSION']));
});
