import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { RunnerStatus, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';

/**
 * The single-task create card's "Create and start", from the owner's press to the runner's poll.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/approval-start-after-create.pg.spec.ts
 *
 * WHAT IS REAL: a PostgreSQL with 0456 applied, single-create cards filed through the runner's own door
 * (`RunnerApiController.createApproval`, declaring or not that the runner acts on Create and start), the
 * owner's decision route (`SessionsService.decideApproval`) and the runner's long-poll
 * (`RunnerApiController.pollApproval`), whose answer is what the runner acts on. The stored choice is
 * read back off `approval.start_after_create` itself, so the claim is the database's answer and not
 * the service's return value.
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

interface Fixture {
  ownerId: string;
  runnerId: string;
  sessionId: string;
}

/** One owner, their runner, a workspace on it and a conversation that asks the cards. */
async function conversation(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@start-after-create.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: label, prompt: label, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  return { ownerId, runnerId, sessionId };
}

/** A card. A single create is filed through the runner's door with the body it is about to send, by a
 *  runner that declares — unless `accepts` is false — that it acts on Create and start; any other card
 *  is a row as its asker filed it. */
async function card(stack: Stack, f: Fixture, toolName: string, accepts = true): Promise<string> {
  if (toolName === 'orbit_task_create') {
    const filed = await stack.api.createApproval({ id: f.runnerId, ownerId: f.ownerId } as never, f.sessionId, {
      toolName,
      input: { title: 'Fix login redirect', completionCriterion: 'EVIDENCE_JUDGMENT' },
      ...(accepts ? { acceptsStartAfterCreate: true } : {}),
    });
    return filed.id;
  }
  const row = await stack.db.approval.create({
    data: { sessionId: f.sessionId, toolName, input: { title: 'something else' } },
  });
  return row.id;
}

/** What the database holds for one card. */
async function stored(stack: Stack, id: string): Promise<{ status: string; start: boolean }> {
  const { rows } = await stack.sql.query<{ status: string; start: boolean }>(
    'SELECT status, start_after_create AS start FROM approval WHERE id = $1', [id],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

/** Whether the stored card says its runner acts on Create and start. */
async function accepting(stack: Stack, id: string): Promise<string | null> {
  const { rows } = await stack.sql.query<{ accepts: string | null }>(
    `SELECT input->>'acceptsStartAfterCreate' AS accepts FROM approval WHERE id = $1`, [id],
  );
  return rows[0]?.accepts ?? null;
}

/** The runner's read of one card. A link read answers at once, so a card still PENDING says so
 *  instead of holding the long-poll window open. */
function poll(stack: Stack, f: Fixture, id: string) {
  return stack.api.pollApproval({ id: f.runnerId, ownerId: f.ownerId } as never, f.sessionId, id, {} as never);
}

test('Create and start is stored with the yes and read back by the runner', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await conversation(stack, 'start');
    const id = await card(stack, f, 'orbit_task_create');
    // Filed through the door, the card says what its runner declared.
    assert.equal(await accepting(stack, id), 'true');

    await stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow', startAfterCreate: true });

    assert.deepEqual(await stored(stack, id), { status: 'ALLOWED', start: true });
    const answer = await poll(stack, f, id);
    assert.equal(answer.status, 'ALLOWED');
    assert.equal(answer.behavior, 'allow');
    assert.equal(answer.startAfterCreate, true);
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
});

test('the plain yes reads exactly as before: no start, and no key on the poll', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await conversation(stack, 'plain');
    const id = await card(stack, f, 'orbit_task_create');

    await stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow' });

    assert.deepEqual(await stored(stack, id), { status: 'ALLOWED', start: false });
    const answer = await poll(stack, f, id);
    assert.equal(answer.status, 'ALLOWED');
    assert.equal('startAfterCreate' in answer, false);
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
});

test('a refusal, and every other card, refuse a start and leave the card unanswered', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await conversation(stack, 'refused');
    const refusals: Array<{ toolName: string; behavior: 'allow' | 'deny' }> = [
      { toolName: 'orbit_task_create', behavior: 'deny' },
      { toolName: 'orbit_task_batch', behavior: 'allow' },
      { toolName: 'orbit_project_create', behavior: 'allow' },
      { toolName: 'Bash', behavior: 'allow' },
    ];
    for (const { toolName, behavior } of refusals) {
      const id = await card(stack, f, toolName);
      await assert.rejects(
        stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior, startAfterCreate: true }),
        (error: unknown) => error instanceof BadRequestException,
        `${toolName} ${behavior}`,
      );
      // Refused before anything was written: the card is still a question, and still on screen.
      assert.deepEqual(await stored(stack, id), { status: 'PENDING', start: false }, `${toolName} ${behavior}`);
      assert.equal((await poll(stack, f, id)).status, 'PENDING', `${toolName} ${behavior}`);
    }
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
});

test('a card filed by a runner that would only create the task refuses a start', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await conversation(stack, 'older');
    // A runner that predates Create and start files the card without declaring it.
    const id = await card(stack, f, 'orbit_task_create', false);
    assert.equal(await accepting(stack, id), null);

    await assert.rejects(
      stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow', startAfterCreate: true }),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.deepEqual(await stored(stack, id), { status: 'PENDING', start: false });

    // Its plain yes still answers it, exactly as before.
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow' });
    assert.deepEqual(await stored(stack, id), { status: 'ALLOWED', start: false });
    assert.equal('startAfterCreate' in (await poll(stack, f, id)), false);
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
});

test('a late Create and start on a card already answered changes nothing', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await conversation(stack, 'late');
    const id = await card(stack, f, 'orbit_task_create');

    await stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow' });
    // A second device pressing Create and start after the first answered: only the first decision
    // on a PENDING card applies, so the runner, which may already have created the task, is never
    // told to start it after the fact.
    await stack.sessions.decideApproval(f.ownerId, f.sessionId, id, { behavior: 'allow', startAfterCreate: true });

    assert.deepEqual(await stored(stack, id), { status: 'ALLOWED', start: false });
    assert.equal('startAfterCreate' in (await poll(stack, f, id)), false);
  } finally {
    await stack.db.$disconnect();
    await stack.sql.end();
  }
});
