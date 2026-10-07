import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PAT_PREFIX, type PatGrant, PatService } from '../auth/pat.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * `orbit session list` and `orbit session get` print, when they act as the person, what the runner
 * door answers them with (docs/personal-access-token-design.md §7.3): GET /sessions/compact and GET
 * /sessions/:id/compact are SessionsService.listForOrchestration and getForOrchestration on the user
 * door, behind a personal access token's `sessions:read`.
 *
 * Over real HTTP with the real controller and guard, for the two things a unit call cannot see: that
 * `compact` is not taken for a session id by the `:id` route beside it — the browser's read, which
 * would answer in another shape — and that a token is let in by the scope these routes declare and
 * kept out without it.
 */

const OWNER_ID = randomUUID();
const SESSION_ID = randomUUID();
const PARENT_ID = randomUUID();

const READER = `${PAT_PREFIX}reader-0123456789abcdefghijklmnopqrstuvwxyzABCD`;
const TASKS_ONLY = `${PAT_PREFIX}tasks-0123456789abcdefghijklmnopqrstuvwxyzABCDE`;
const grants = new Map<string, PatGrant>([
  [READER, { tokenId: 'pat-reader', userId: OWNER_ID, email: 'me@example.test', scopes: ['sessions:read'], workspaceIds: [] }],
  [TASKS_ONLY, { tokenId: 'pat-tasks', userId: OWNER_ID, email: 'me@example.test', scopes: ['tasks:read'], workspaceIds: [] }],
]);

/** The two orchestration reads, each answering as SessionsService does — and recording what it was asked. */
const compactRows = [{ id: SESSION_ID, title: 'a session', status: 'RUNNING', parentSessionId: PARENT_ID, lastTurnAt: null }];
const compactDetail = { id: SESSION_ID, title: 'a session', status: 'RUNNING', numTurns: 3, workspace: { id: 'w', name: 'w', model: null } };
const asked: string[] = [];

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this probe`);
};

const sessions = {
  listForOrchestration: async (ownerId: string, filters: { status?: string; parentSessionId?: string }) => {
    asked.push(`list ${ownerId} ${filters.status} ${filters.parentSessionId}`);
    return compactRows;
  },
  getForOrchestration: async (ownerId: string, id: string) => {
    asked.push(`get ${ownerId} ${id}`);
    return compactDetail;
  },
  get: refuse("the browser's :id read"),
  list: refuse("the browser's list"),
};

@Module({
  controllers: [SessionsController],
  providers: [
    { provide: SessionsService, useValue: sessions },
    { provide: PrismaService, useValue: {} },
    { provide: RealtimeService, useValue: {} },
    { provide: SessionTagsService, useValue: {} },
    { provide: MergeReceiptService, useValue: {} },
    { provide: AutoRetryService, useValue: {} },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    { provide: PatService, useValue: { verify: async (token: string) => grants.get(token) ?? null } },
  ],
})
class CompactDoorsModule {}

async function serve(t: { after: (fn: () => Promise<void>) => void }): Promise<(path: string, token: string) => Promise<{ status: number; body: unknown }>> {
  const app = await NestFactory.create(CompactDoorsModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return async (path, token) => {
    const response = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: JSON.parse(await response.text()) as unknown };
  };
}

test('GET /sessions/compact is the compact list a token with sessions:read reads, not a session id', async (t) => {
  asked.length = 0;
  const get = await serve(t);

  const listed = await get(`/sessions/compact?status=RUNNING&parentSessionId=${PARENT_ID}`, READER);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body, compactRows, 'the orchestration rows, as the runner door answers `session list`');
  // A status that is not one is dropped rather than handed to Prisma, as the runner door drops it.
  const unknownStatus = await get('/sessions/compact?status=SLEEPING', READER);
  assert.equal(unknownStatus.status, 200, JSON.stringify(unknownStatus.body));
  assert.deepEqual(asked, [`list ${OWNER_ID} RUNNING ${PARENT_ID}`, `list ${OWNER_ID} undefined undefined`],
    "the token's own user, the filters as sent, and never the browser's :id read");
});

test('GET /sessions/:id/compact is the compact detail, not the browser’s', async (t) => {
  asked.length = 0;
  const get = await serve(t);

  const detail = await get(`/sessions/${SESSION_ID}/compact`, READER);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body, compactDetail);
  assert.deepEqual(asked, [`get ${OWNER_ID} ${SESSION_ID}`]);
});

test('a token without sessions:read is refused both, and nothing is read', async (t) => {
  asked.length = 0;
  const get = await serve(t);

  for (const path of ['/sessions/compact', `/sessions/${SESSION_ID}/compact`]) {
    const refused = await get(path, TASKS_ONLY);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.body)}`);
    assert.equal((refused.body as { code?: string }).code, 'PAT_SCOPE_MISSING', path);
    assert.equal((refused.body as { scope?: string }).scope, 'sessions:read', path);
  }
  assert.deepEqual(asked, []);
});

test('the runner door answers `session list` and `session get` from the same two reads', async () => {
  asked.length = 0;
  const runner = new RunnerSessionsController(
    sessions as never,
    { assert: async () => 'caller-session' } as never,
    {} as never,
    {} as never,
  );
  const RUNNER = { id: 'runner-1', ownerId: OWNER_ID } as never;
  const listed = await runner.listSessions(RUNNER, undefined, 'caller-session', 'session-token', 'RUNNING', PARENT_ID);
  const detail = await runner.getSession(RUNNER, undefined, 'caller-session', 'session-token', SESSION_ID);
  assert.equal(listed, compactRows, 'one read answers both doors, so one shape is printed either way');
  assert.equal(detail, compactDetail);
  assert.deepEqual(asked, [`list ${OWNER_ID} RUNNING ${PARENT_ID}`, `get ${OWNER_ID} ${SESSION_ID}`]);
});
