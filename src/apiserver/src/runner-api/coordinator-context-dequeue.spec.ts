import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { uuidToBase62, type RunInboxResponse } from '@orbit/shared';
import {
  buildCoordinatorDeliveryInstructions,
  buildCoordinatorOpening,
} from '../projects/coordinator-opening';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Crawl',
};

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
) => Promise<RunInboxResponse | null>;

function harness(options: {
  kind?: 'message' | 'steer';
  content?: string;
  prompt?: string;
  titleBeforeProjectManagement?: string | null;
  project?: typeof PROJECT | null;
  started?: boolean;
}) {
  const sessionReads: unknown[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = (args[0] as readonly string[]).join('?');
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return [{
          id: SESSION_ID,
          inboxLeaseGeneration: null,
          inboxLeaseOwner: null,
          status: RunStatus.RUNNING,
          ownerId: OWNER_ID,
          provider: 'claude',
          providerBuiltin: true,
        }];
      }
      if (/UPDATE "conversation_turn"/.test(sql)) {
        return [{
          id: 'turn-1',
          seq: 2,
          kind: options.kind ?? 'message',
          content: options.content ?? 'Please implement the crawler.',
          clientTurnId: 'client-turn-1',
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
          coordinatorForProject: options.project === undefined ? PROJECT : options.project,
        };
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
  };
}

for (const kind of ['message', 'steer'] as const) {
  test(`a promoted coordinator receives its role on every delivered ${kind}`, async () => {
    const original = 'Please implement the crawler.';
    const { dequeue, sessionReads } = harness({ kind, content: original });

    const turn = await dequeue(SESSION_ID, RUNNER_ID, null);

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

  assert.equal((await dequeue(SESSION_ID, RUNNER_ID, null))?.content, content);
});

test('an ordinary session receives exactly the message the user sent', async () => {
  const content = 'Please implement the crawler.';
  const { dequeue } = harness({ content, project: null });

  assert.equal((await dequeue(SESSION_ID, RUNNER_ID, null))?.content, content);
});

test('promotion provenance wins even if the old prompt happened to contain the opening marker', async () => {
  const content = 'Please implement the crawler.';
  const { dequeue } = harness({
    content,
    prompt: buildCoordinatorOpening(PROJECT.title, PROJECT.id),
  });

  assert.match(
    (await dequeue(SESSION_ID, RUNNER_ID, null))?.content ?? '',
    /<orbit_project_coordinator_context>/,
  );
});

test('a re-delivered promoted turn keeps the coordinator role around its continuation nudge', async () => {
  const { dequeue } = harness({ started: true });

  const content = (await dequeue(SESSION_ID, RUNNER_ID, null))?.content ?? '';

  assert.match(content, /^\[系统\]/);
  assert.match(content, /<\/orbit_project_coordinator_context>$/);
  assert.match(content, /runner 重启而中断/);
  assert.match(content, /不是用来替它干活/);
});
