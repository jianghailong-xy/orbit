import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunnerStatus, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { AUTO_ALLOWED_MESSAGE } from '../common/permission-rules';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerApiController } from './runner-api.controller';

/**
 * A Codex session's MCP consent cards, from the runner's filing to the owner's answer and back.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/approval-mcp-consent.pg.spec.ts
 *
 * WHAT IS REAL: a PostgreSQL with the approval table's unique key on (session_id, tool_use_id), cards
 * filed through the runner's own door (`RunnerApiController.createApproval`), the owner's decision route
 * (`SessionsService.decideApproval`) and the runner's read of the answer
 * (`RunnerApiController.pollApproval`). What is stored is read back with SQL.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  sql: Client;
  sessions: SessionsService;
  api: RunnerApiController;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db, sql,
    sessions: new SessionsService(prisma, queue, realtime),
    api: new RunnerApiController(
      prisma, queue, realtime, { notifyApprovalRequest: async () => undefined } as never, {} as never, {} as never,
    ),
  };
}

async function withStack(run: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await connect();
  try {
    await run(stack);
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  sessionId: string;
}

/** One owner, their runner, a workspace on it and a conversation on `engine`. */
async function conversation(stack: Stack, label: string, engine = 'codex'): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@mcp-consent.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
  const sessionId = await anotherSession(stack, { ownerId, runnerId, workspaceId }, engine);
  return { ownerId, runnerId, workspaceId, sessionId };
}

async function anotherSession(
  stack: Stack,
  f: Pick<Fixture, 'ownerId' | 'runnerId' | 'workspaceId'>,
  engine = 'codex',
): Promise<string> {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId, title: 'consent', prompt: 'consent', provider: engine, engine,
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  return sessionId;
}

/** A card as the runner files one. */
function file(stack: Stack, f: Fixture, sessionId: string, toolName: string, toolUseId?: string) {
  return stack.api.createApproval({ id: f.runnerId, ownerId: f.ownerId } as never, sessionId, {
    toolName,
    input: { message: `Allow the orbit MCP server to run tool "${toolName}"?` },
    ...(toolUseId === undefined ? {} : { toolUseId }),
  });
}

/** What the runner reads back for one card. */
function poll(stack: Stack, f: Fixture, sessionId: string, id: string) {
  return stack.api.pollApproval({ id: f.runnerId, ownerId: f.ownerId } as never, sessionId, id, {} as never);
}

/** The workspace's standing rules, as stored. */
async function rules(stack: Stack, f: Fixture): Promise<string[]> {
  const { rows } = await stack.sql.query<{ tool_name: string }>(
    'SELECT tool_name FROM workspace_permission_rule WHERE workspace_id = $1 ORDER BY tool_name', [f.workspaceId],
  );
  return rows.map((row) => row.tool_name);
}

test('cards filed with an empty id are each a card of their own, and each answer is its own', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'empty-id');
    // Three times the same call, as a runner that has no id for it sends it.
    const first = await file(stack, f, f.sessionId, 'mcp__orbit', '');
    const second = await file(stack, f, f.sessionId, 'mcp__orbit', '');
    const third = await file(stack, f, f.sessionId, 'mcp__orbit', '');
    assert.equal(new Set([first.id, second.id, third.id]).size, 3);
    for (const card of [first, second, third]) assert.equal(card.status, 'PENDING');

    const { rows } = await stack.sql.query<{ none: boolean }>(
      'SELECT tool_use_id IS NULL AS none FROM approval WHERE session_id = $1', [f.sessionId],
    );
    assert.deepEqual(rows.map((row) => row.none), [true, true, true]);

    await stack.sessions.decideApproval(f.ownerId, f.sessionId, first.id, { behavior: 'allow' });
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, second.id, { behavior: 'deny', message: 'not this one' });
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, third.id, { behavior: 'allow' });
    assert.equal((await poll(stack, f, f.sessionId, first.id)).status, 'ALLOWED');
    const refused = await poll(stack, f, f.sessionId, second.id);
    assert.equal(refused.status, 'DENIED');
    assert.equal(refused.message, 'not this one');
    assert.equal((await poll(stack, f, f.sessionId, third.id)).status, 'ALLOWED');
  });
});

test('a resend of a named card finds that card, and another name is another card', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'named');
    const first = await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-1:mcp_consent:0');
    const resent = await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-1:mcp_consent:0');
    assert.equal(resent.id, first.id);

    await stack.sessions.decideApproval(f.ownerId, f.sessionId, first.id, { behavior: 'allow' });
    const next = await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-1:mcp_consent:1');
    const nextProcess = await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-2:mcp_consent:0');
    assert.equal(new Set([first.id, next.id, nextProcess.id]).size, 3);
    // The yes went to the card it was given on.
    assert.equal(next.status, 'PENDING');
    assert.equal(nextProcess.status, 'PENDING');
  });
});

test('"always allow" on one tool answers that tool and no other, bg_run included', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'one-tool');
    const asked = await file(stack, f, f.sessionId, 'mcp__orbit__bg_list', 'process-1:mcp_consent:0');
    assert.equal(asked.status, 'PENDING');
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, asked.id, {
      behavior: 'allow',
      rememberRules: [{ toolName: 'mcp__orbit__bg_list' }],
    });
    assert.deepEqual(await rules(stack, f), ['mcp__orbit__bg_list']);

    // In this session and in a later one of the workspace.
    const later = await anotherSession(stack, f);
    let id = 1;
    for (const sessionId of [f.sessionId, later]) {
      const same = await file(stack, f, sessionId, 'mcp__orbit__bg_list', `process-1:mcp_consent:${id++}`);
      assert.equal(same.status, 'ALLOWED');
      const answer = await poll(stack, f, sessionId, same.id);
      assert.equal(answer.status, 'ALLOWED');
      assert.equal(answer.message, AUTO_ALLOWED_MESSAGE);

      for (const other of ['mcp__orbit__bg_run', 'mcp__orbit__bg_kill', 'mcp__orbit__task_list', 'mcp__acme__bg_list']) {
        const card = await file(stack, f, sessionId, other, `process-1:mcp_consent:${id++}`);
        assert.equal(card.status, 'PENDING', other);
      }
    }
  });
});

test('a card that names only a server takes its answer and leaves no rule', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'server-card');
    const card = await file(stack, f, f.sessionId, 'mcp__orbit', '');
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, card.id, {
      behavior: 'allow',
      rememberRules: [{ toolName: 'mcp__orbit' }],
    });
    assert.equal((await poll(stack, f, f.sessionId, card.id)).status, 'ALLOWED');
    assert.deepEqual(await rules(stack, f), []);

    assert.equal((await file(stack, f, f.sessionId, 'mcp__orbit', '')).status, 'PENDING');
    assert.equal((await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-1:mcp_consent:0')).status, 'PENDING');
  });
});

test('a rule already stored for a whole server answers no card', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'stored-server-rule');
    await stack.db.workspacePermissionRule.create({
      data: { workspaceId: f.workspaceId, toolName: 'mcp__orbit', ruleContent: '' },
    });
    // The card an installed runner files, and the card a current one does.
    assert.equal((await file(stack, f, f.sessionId, 'mcp__orbit', '')).status, 'PENDING');
    assert.equal((await file(stack, f, f.sessionId, 'mcp__orbit', '')).status, 'PENDING');
    assert.equal((await file(stack, f, f.sessionId, 'mcp__orbit__bg_run', 'process-1:mcp_consent:0')).status, 'PENDING');
  });
});

test('other engines: a tool rule still answers their cards, and claude still matches its own', { skip }, async () => {
  await withStack(async (stack) => {
    const f = await conversation(stack, 'other-engines');
    await stack.db.workspacePermissionRule.create({
      data: { workspaceId: f.workspaceId, toolName: 'mcp__orbit__bg_run', ruleContent: '' },
    });
    const expected: [string, string][] = [['cursor', 'ALLOWED'], ['antigravity', 'ALLOWED'], ['kimi', 'ALLOWED'], ['claude', 'PENDING']];
    for (const [engine, status] of expected) {
      const sessionId = await anotherSession(stack, f, engine);
      const named = await file(stack, f, sessionId, 'mcp__orbit__bg_run', `${engine}-call-1`);
      assert.equal(named.status, status, engine);
      assert.equal((await file(stack, f, sessionId, 'mcp__orbit__bg_list', `${engine}-call-2`)).status, 'PENDING', engine);
    }
  });
});
