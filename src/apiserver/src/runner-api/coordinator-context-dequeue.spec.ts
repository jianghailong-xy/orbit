import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider, uuidToBase62, type RunInboxResponse } from '@orbit/shared';
import {
  buildCoordinatorDeliveryContextKey,
  buildCoordinatorDeliveryInstructions,
  buildCoordinatorOpening,
} from '../projects/coordinator-opening';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import {
  RunnerApiController,
  SESSION_CLAUDE_COORDINATOR_CONTEXT_V1,
  SESSION_CODEX_COORDINATOR_CONTEXT_V1,
} from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_GENERATION = '55555555-5555-4555-8555-555555555555';
const PROJECT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Crawl',
};

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
  acceptsSteer?: boolean,
  declaredCapabilities?: readonly string[],
) => Promise<RunInboxResponse | null>;

function harness(options: {
  kind?: 'message' | 'steer';
  content?: string;
  prompt?: string;
  titleBeforeProjectManagement?: string | null;
  project?: typeof PROJECT | null;
  started?: boolean;
  contextEpoch?: number;
  contextAckKey?: string | null;
  turnContextKey?: string | null;
  clientTurnId?: string;
  provider?: AgentProvider;
}) {
  const sessionReads: unknown[] = [];
  const turnUpdates: unknown[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return [{
          id: SESSION_ID,
          inboxLeaseGeneration: LEASE_GENERATION,
          inboxLeaseOwner: null,
          status: RunStatus.RUNNING,
          ownerId: OWNER_ID,
          provider: options.provider ?? AgentProvider.CLAUDE,
          providerBuiltin: true,
        }];
      }
      if (/FROM "inbox_lease_generation"/.test(sql)) {
        return [{ generation: LEASE_GENERATION }];
      }
      if (/UPDATE "conversation_turn"/.test(sql)) {
        return [{
          id: 'turn-1',
          seq: 2,
          kind: options.kind ?? 'message',
          content: options.content ?? 'Please implement the crawler.',
          clientTurnId: options.clientTurnId ?? 'client-turn-1',
          coordinatorContextKey: options.turnContextKey ?? null,
        }];
      }
      return [];
    },
    session: {
      findUnique: async (args: unknown) => {
        sessionReads.push(args);
        return {
          ownerId: OWNER_ID,
          prompt: options.prompt ?? 'Explore the corpus first.',
          titleBeforeProjectManagement:
            options.titleBeforeProjectManagement === undefined
              ? 'Explore the corpus'
              : options.titleBeforeProjectManagement,
          coordinatorContextEpoch: options.contextEpoch ?? 0,
          coordinatorContextAckKey: options.contextAckKey ?? null,
          coordinatorForProject: options.project === undefined ? PROJECT : options.project,
        };
      },
    },
    conversationTurn: {
      updateMany: async (args: unknown) => {
        turnUpdates.push(args);
        return { count: 1 };
      },
    },
    runEvent: {
      findFirst: async () => options.started ? { id: 'event-1' } : null,
    },
    attachment: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  return {
    dequeue: (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.bind(controller),
    sessionReads,
    turnUpdates,
  };
}

function sparseDequeue(
  dequeue: Dequeue,
  capability = SESSION_CLAUDE_COORDINATOR_CONTEXT_V1,
) {
  return dequeue(
    SESSION_ID,
    RUNNER_ID,
    LEASE_GENERATION,
    false,
    [capability],
  );
}

for (const kind of ['message', 'steer'] as const) {
  test(`a legacy runner keeps the coordinator role on every delivered ${kind}`, async () => {
    const original = 'Please implement the crawler.';
    const { dequeue, sessionReads } = harness({ kind, content: original });

    const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

    assert.ok(turn?.content?.startsWith(original));
    assert.ok(
      turn?.content?.includes(buildCoordinatorDeliveryInstructions(PROJECT.id)),
    );
    assert.match(turn?.content ?? '', /<\/orbit_project_coordinator_context>$/);
    assert.deepEqual(
      (sessionReads[0] as { select: { coordinatorForProject: unknown } }).select
        .coordinatorForProject,
      { select: { id: true } },
    );
    assert.equal(
      (sessionReads[0] as { select: { titleBeforeProjectManagement: unknown } }).select
        .titleBeforeProjectManagement,
      true,
    );
  });
}

test('a lifecycle-capable runner attaches and stamps a promoted coordinator once', async () => {
  const original = 'Please implement the crawler.';
  const { dequeue, turnUpdates } = harness({ content: original });

  const turn = await sparseDequeue(dequeue);

  assert.ok(turn?.content?.startsWith(original));
  assert.match(turn?.content ?? '', /<orbit_project_coordinator_context>/);
  assert.deepEqual(turnUpdates, [{
    where: { id: 'turn-1', sessionId: SESSION_ID, status: 'IN_FLIGHT' },
    data: {
      coordinatorContextKey: buildCoordinatorDeliveryContextKey(
        PROJECT.id,
        LEASE_GENERATION,
        0,
      ),
    },
  }]);
});

test('an acknowledged coordinator context is not repeated on the next warm turn', async () => {
  const content = 'What changed?';
  const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
  const { dequeue, turnUpdates } = harness({ content, contextAckKey });

  assert.equal((await sparseDequeue(dequeue))?.content, content);
  assert.deepEqual(turnUpdates, []);
});

test('Codex uses the same sparse lifecycle only with its provider-matched capability', async () => {
  const content = 'What changed?';
  const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
  const { dequeue, turnUpdates } = harness({
    content,
    contextAckKey,
    provider: AgentProvider.CODEX,
  });

  assert.equal(
    (await sparseDequeue(dequeue, SESSION_CODEX_COORDINATOR_CONTEXT_V1))?.content,
    content,
  );
  assert.deepEqual(turnUpdates, []);
});

test('a lifecycle capability for another runtime cannot suppress legacy delivery', async () => {
  const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
  const { dequeue } = harness({ contextAckKey, provider: AgentProvider.CODEX });

  const turn = await sparseDequeue(dequeue, SESSION_CLAUDE_COORDINATOR_CONTEXT_V1);

  assert.match(turn?.content ?? '', /<orbit_project_coordinator_context>/);
});

for (const provider of [AgentProvider.KIMI, AgentProvider.OPENCODE]) {
  test(`${provider} stays on correctness-first delivery without a compaction contract`, async () => {
    const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
    const { dequeue } = harness({ contextAckKey, provider });

    const turn = await dequeue(
      SESSION_ID,
      RUNNER_ID,
      LEASE_GENERATION,
      false,
      [
        SESSION_CLAUDE_COORDINATOR_CONTEXT_V1,
        SESSION_CODEX_COORDINATOR_CONTEXT_V1,
      ],
    );

    assert.match(turn?.content ?? '', /<orbit_project_coordinator_context>/);
  });
}

test('a new engine generation invalidates the previous acknowledgement', async () => {
  const oldLease = '66666666-6666-4666-8666-666666666666';
  const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, oldLease, 0);
  const { dequeue } = harness({ contextAckKey });

  assert.match((await sparseDequeue(dequeue))?.content ?? '', /<orbit_project_coordinator_context>/);
});

test('a compaction epoch invalidates the previous acknowledgement', async () => {
  const contextAckKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
  const { dequeue, turnUpdates } = harness({ contextAckKey, contextEpoch: 42 });

  assert.match((await sparseDequeue(dequeue))?.content ?? '', /<orbit_project_coordinator_context>/);
  assert.equal(
    (turnUpdates[0] as { data: { coordinatorContextKey: string } }).data.coordinatorContextKey,
    buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 42),
  );
});

test('a lost inbox response reattaches context when the same turn is leased again', async () => {
  const contextKey = buildCoordinatorDeliveryContextKey(PROJECT.id, LEASE_GENERATION, 0);
  const { dequeue, turnUpdates } = harness({ turnContextKey: contextKey });

  assert.match((await sparseDequeue(dequeue))?.content ?? '', /<orbit_project_coordinator_context>/);
  assert.deepEqual(turnUpdates, [], 'the existing turn stamp is reused');
});

test('a capable steer neither repeats nor consumes the top-level context marker', async () => {
  const content = 'Also check robots.txt';
  const { dequeue, turnUpdates } = harness({ kind: 'steer', content });

  assert.equal((await sparseDequeue(dequeue))?.content, content);
  assert.deepEqual(turnUpdates, []);
});

test('delivery keeps the project-page coordinator boundaries without repeating its mutable title', () => {
  const opening = buildCoordinatorOpening(PROJECT.title, PROJECT.id);
  const delivered = buildCoordinatorDeliveryInstructions(PROJECT.id);

  assert.equal(delivered.slice(delivered.indexOf('\n\n')), opening.slice(opening.indexOf('\n\n')));
  assert.match(delivered, new RegExp(uuidToBase62(PROJECT.id)));
  assert.doesNotMatch(delivered, new RegExp(PROJECT.title));
  assert.match(delivered, /不是用来替它干活/);
  assert.match(delivered, /先读再说/);
  assert.match(delivered, /账号所有者通道记录/);
  assert.match(delivered, /直接指挥 runner，都不在你手上/);
});

test('a project-page coordinator does not receive a duplicate of its opening', async () => {
  const content = 'What changed since yesterday?';
  const { dequeue } = harness({
    content,
    prompt: buildCoordinatorOpening(PROJECT.title, PROJECT.id),
    titleBeforeProjectManagement: null,
  });

  assert.equal((await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION))?.content, content);
});

test('a capable project-page opening is stamped without appending a duplicate', async () => {
  const opening = buildCoordinatorOpening(PROJECT.title, PROJECT.id);
  const { dequeue, turnUpdates } = harness({
    content: opening,
    prompt: opening,
    titleBeforeProjectManagement: null,
    clientTurnId: `initial-${SESSION_ID}`,
  });

  assert.equal((await sparseDequeue(dequeue))?.content, opening);
  assert.equal(turnUpdates.length, 1);
});

test('a dedicated coordinator is restored after its runtime context changes', async () => {
  const opening = buildCoordinatorOpening(PROJECT.title, PROJECT.id);
  const content = 'Continue after restart';
  const { dequeue } = harness({
    content,
    prompt: opening,
    titleBeforeProjectManagement: null,
  });

  assert.match((await sparseDequeue(dequeue))?.content ?? '', /<orbit_project_coordinator_context>/);
});

test('an ordinary session receives exactly the message the user sent', async () => {
  const content = 'Please implement the crawler.';
  const { dequeue } = harness({ content, project: null });

  assert.equal((await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION))?.content, content);
});

test('promotion provenance wins even if the old prompt happened to contain the opening marker', async () => {
  const content = 'Please implement the crawler.';
  const { dequeue } = harness({
    content,
    prompt: buildCoordinatorOpening(PROJECT.title, PROJECT.id),
  });

  assert.match(
    (await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION))?.content ?? '',
    /<orbit_project_coordinator_context>/,
  );
});

test('a re-delivered promoted turn keeps the coordinator role around its continuation nudge', async () => {
  const { dequeue } = harness({ started: true });

  const content = (await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION))?.content ?? '';

  assert.match(content, /^\[系统\]/);
  assert.match(content, /<\/orbit_project_coordinator_context>$/);
  assert.match(content, /runner 重启而中断/);
  assert.match(content, /不是用来替它干活/);
});
