import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../push/push.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { ListEventsService } from '../task-lists/list-events.service';

/**
 * `POST /api/runner/sessions/:id/source/pin` over real HTTP.
 *
 * Everything this route depends on lives outside TypeScript's reach and none of it is exercised by
 * calling the method directly: that the path is registered at all and is not shadowed by the
 * sibling controller's `sessions/:id`, that the runner token guard runs in front of it, that
 * `PublicIdPipe` accepts BOTH spellings of a session id (the runner sends raw UUIDs; every other
 * client sends Base62), that a refusal comes back as its intended status rather than a 500, and
 * that the response interceptor leaves a 40-hex commit alone — the one field in this payload that
 * looks id-shaped and must never be rewritten.
 *
 * Mounted with the same global pipe and interceptors `main.ts` installs, and with the REAL guard,
 * because the configuration is half the behaviour being asserted.
 */

const RUNNER = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222' };
const OTHER_RUNNER_SESSION = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SHA = 'a'.repeat(40);
const TOKEN = 'runner-token';

interface Written {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function stubPrisma(options: { updated: number; after: Record<string, unknown> }) {
  const writes: Written[] = [];
  const prisma = {
    // The real guard runs against this: the token is hashed and looked up, exactly as in production.
    runner: { findFirst: async () => RUNNER },
    session: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.id === SESSION && where.assignedRunnerId === RUNNER.id
          ? { sourceState: 'SELECTED', sourceBaseSha: null }
          : null,
      updateMany: async (args: Written) => {
        writes.push(args);
        return { count: options.updated };
      },
      findUniqueOrThrow: async () => options.after,
    },
  };
  return { prisma: prisma as unknown as PrismaService, writes };
}

async function mount(prisma: PrismaService) {
  @Module({
    controllers: [RunnerApiController],
    providers: [
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: {} },
      { provide: RealtimeService, useValue: { publishSessionUpdated: () => {} } },
      { provide: PushService, useValue: {} },
      { provide: RunnerOrchestrationAuthorizer, useValue: {} },
      { provide: ReferenceExpansionService, useValue: {} },
      { provide: ListEventsService, useValue: {} },
    ],
  })
  class WireModule {}

  // `abortOnError: false` matters here: Nest's default is to log the failure and call
  // process.exit(1), and with the logger off that is a silent exit — the test file reports "failed"
  // with no reason at all. Off, a bootstrap problem arrives as an exception this test can print.
  const app = await NestFactory.create(WireModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  return app;
}

async function pin(
  base: string,
  sessionId: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/runner/sessions/${sessionId}/source/pin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('a runner freezes its resolution over HTTP, in either id spelling', async (t) => {
  const { prisma, writes } = stubPrisma({
    updated: 1,
    after: {
      sourceState: 'PINNED',
      sourceBaseSha: SHA,
      sourceResolvedAt: new Date('2026-08-26T00:00:00.000Z'),
      sourceResolvedByRunnerId: RUNNER.id,
      sourceRefusalCode: null,
    },
  });
  const app = await mount(prisma);
  const base = await app.getUrl();
  t.after(() => app.close());

  const raw = await pin(base, SESSION, { baseSha: SHA });
  assert.equal(raw.status, 200);
  assert.equal(raw.body.state, 'PINNED');
  assert.equal(raw.body.wonRace, true);
  // The one field that looks id-shaped and is not. A commit SHA rewritten into "somebody's Base62"
  // would be a baseline the runner cannot check out, reported as success.
  assert.equal(raw.body.baseSha, SHA);
  assert.equal(raw.body.resolvedByRunnerId, RUNNER.id);
  assert.deepEqual(writes.at(-1)?.data.sourceState, 'PINNED');
  assert.deepEqual(writes.at(-1)?.where.sourceBaseSha, null);

  // The runner sends raw UUIDs; every other client sends Base62. Both have to name the same row,
  // or this endpoint is reachable from exactly one of the two doors this API has.
  const base62 = await pin(base, uuidToBase62(SESSION), { baseSha: SHA });
  assert.equal(base62.status, 200);
  assert.equal(base62.body.baseSha, SHA);
});

test('the pin route refuses before it writes, and says which refusal it is', async (t) => {
  const { prisma, writes } = stubPrisma({ updated: 0, after: { sourceState: 'SELECTED' } });
  const app = await mount(prisma);
  const base = await app.getUrl();
  t.after(() => app.close());

  assert.equal((await pin(base, SESSION, { baseSha: SHA }, null)).status, 401);
  // 400, not 500: an abbreviated SHA is a request this API refuses on purpose, and a caller has to
  // be able to tell "you sent something wrong" from "we broke".
  assert.equal((await pin(base, SESSION, { baseSha: 'a1b2c3d' })).status, 400);
  assert.equal((await pin(base, SESSION, {})).status, 400);
  assert.equal(
    (await pin(base, SESSION, { refusal: { code: 'SOURCE_PROTOCOL_UNSUPPORTED' } })).status,
    400,
  );
  // Another machine's session: 403, and nothing written.
  assert.equal((await pin(base, OTHER_RUNNER_SESSION, { baseSha: SHA })).status, 403);
  assert.deepEqual(writes, [], 'a refused request reached the database');
});

test('losing the race is a 200 carrying the winner\'s pin, not an error', async (t) => {
  // SR30. The loser has to keep running — it is about to build a worktree on the frozen commit —
  // so this cannot be a conflict status. What it must NOT be is a success carrying the loser's own
  // answer, which is why `wonRace` is on the wire at all.
  const winner = 'b'.repeat(40);
  const { prisma } = stubPrisma({
    updated: 0,
    after: {
      sourceState: 'PINNED',
      sourceBaseSha: winner,
      sourceResolvedAt: new Date('2026-08-26T00:00:00.000Z'),
      sourceResolvedByRunnerId: '55555555-5555-4555-8555-555555555555',
      sourceRefusalCode: null,
    },
  });
  const app = await mount(prisma);
  const base = await app.getUrl();
  t.after(() => app.close());

  const lost = await pin(base, SESSION, { baseSha: SHA });
  assert.equal(lost.status, 200);
  assert.equal(lost.body.wonRace, false);
  assert.equal(lost.body.baseSha, winner);
});
