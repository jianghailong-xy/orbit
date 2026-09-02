/**
 * 0225 against real PostgreSQL and over real HTTP: the startup-context table is gone, and the door
 * it used to break — `session_send` — answers instead of refusing.
 *
 * Its sibling `session-current-work-startup-removal.spec.ts` carries the halves decided by reading
 * the tree. These are the ones that need rows and a listening socket, because no source scan can
 * tell "the gate is gone" from "the gate is gone and the send now 500s somewhere else".
 *
 * The whole point of the removal is here: POST /runner/sessions/:id/turns is the endpoint the MCP
 * `session_send` tool reaches, it used to hard-code `intent: 'CURRENT_WORK'`, and the rollout gate
 * answered that with 503 SESSION_TURN_PROTOCOL_DISABLED on every deployment there is. Below it is
 * asked to message a session that is AWAITING_INPUT — the exact case that could not be recovered —
 * and it must deliver rather than refuse.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { sha256 } from '../common/crypto.util';
import { SessionsService } from './sessions.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { RunnerSessionAuthGuard } from '../runner-api/runner-session-auth.guard';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { ServiceTokenAuthorizer } from '../runner-api/service-token.authorizer';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionAttemptService } from '../projects/session-attempt.service';

const PG_URL = process.env.COORDINATOR_PG_URL;
const pgTest = (name: string, body: () => Promise<void>) =>
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the send removal suite' },
    body);

const OWNER_ID = '81111111-1111-4111-8111-111111111111';
const RUNNER_ID = '82222222-2222-4222-8222-222222222222';
const RUNNER_TOKEN = 'startup-removal-runner-token';
const PARKED_SESSION_ID = '83333333-3333-4333-8333-333333333333';
const LIVE_SESSION_ID = '84444444-4444-4444-8444-444444444444';
const LIVE_TURN_ID = '85555555-5555-4555-8555-555555555555';
const SEEDING_SESSION_ID = '86666666-6666-4666-8666-666666666666';
const ATTACHMENT_ID = '87777777-7777-4777-8777-777777777777';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let chargedSteers: string[] = [];

async function connect(): Promise<void> {
  if (admin) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL!);
  await prisma.$connect();
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'startup-removal@example.test', 'removal', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at, capabilities)
     VALUES ($1::uuid, 'startup-removal', $2::uuid, $3, 'ONLINE', clock_timestamp(), '{}'::text[])`,
    [RUNNER_ID, OWNER_ID, sha256(RUNNER_TOKEN)],
  );
}

test.after(async () => {
  try {
    if (admin) {
      await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
    }
  } finally {
    await prisma?.$disconnect();
    await admin?.end();
  }
});

/** The real orchestration door, with only what it READS doubled. */
async function withSendDoor(
  body: (send: (sessionId: string, payload: unknown) => Promise<{
    status: number;
    body: Record<string, unknown>;
  }>) => Promise<void>,
): Promise<void> {
  const sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
      publishSessionUpdated: () => undefined,
    } as never,
  );
  @Module({
    controllers: [RunnerSessionsController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: PrismaService, useValue: prisma },
      { provide: ServiceTokenAuthorizer, useValue: { verify: async () => null } },
      {
        provide: RunnerOrchestrationAuthorizer,
        useValue: { assert: async () => undefined },
      },
      { provide: MergeReceiptService, useValue: {} },
      {
        provide: SessionAttemptService,
        useValue: {
          // The orchestration send is budgeted as a steer. Recorded rather than stubbed away, so a
          // change that stops charging it fails here instead of silently uncapping the verb.
          chargeSteer: async (_ownerId: string, sessionId: string) => {
            chargedSteers.push(sessionId);
          },
        },
      },
      RunnerSessionAuthGuard,
    ],
  })
  class SendModule {}

  const app = await NestFactory.create(SendModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    await body(async (sessionId, payload) => {
      const response = await fetch(`${base}/api/runner/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text };
      }
      return { status: response.status, body: parsed };
    });
  } finally {
    await app.close();
  }
}

// ── (a)(g) the catalogue ───────────────────────────────────────────────────────────────────────

pgTest('(a)(g) the startup table is gone and conversation_turn is not', async () => {
  await connect();
  const relations = await admin.query<{ fragment: string | null; turn: string | null }>(
    `SELECT to_regclass('public.conversation_turn_startup_fragment')::text AS fragment,
            to_regclass('public.conversation_turn')::text AS turn`,
  );
  assert.equal(relations.rows[0].fragment, null,
    'conversation_turn_startup_fragment must not exist');
  assert.equal(relations.rows[0].turn, 'conversation_turn',
    'conversation_turn is a production table and must survive');

  const attachmentColumns = (await admin.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attachment'`,
  )).rows.map((row) => row.column_name);
  assert.ok(!attachmentColumns.includes('startup_fragment_id'),
    'attachment must not still point at the dropped table');
  assert.ok(attachmentColumns.includes('turn_id'), 'attachments still belong to a turn');

  // The live-turn half of the protocol is deliberately untouched by this removal.
  const turnColumns = (await admin.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversation_turn'`,
  )).rows.map((row) => row.column_name);
  for (const column of ['send_intent', 'target_turn_id', 'delivery_status']) {
    assert.ok(turnColumns.includes(column), `conversation_turn.${column} must survive`);
  }

  // Nothing may still reference the dropped table from the catalogue either.
  const dangling = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_constraint
      WHERE conname LIKE '%startup_fragment%' OR conname = 'attachment_single_message_owner_check'`,
  );
  assert.equal(dangling.rows[0].n, '0');
});

// ── (d)(e) session_send answers a session that is waiting, instead of 503 ──────────────────────

pgTest('(d)(e) session_send delivers to an AWAITING_INPUT session and never answers 503',
  async () => {
    await connect();
    chargedSteers = [];
    await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [PARKED_SESSION_ID]);
    await admin.query(
      `INSERT INTO "session"(
         id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
         provider_builtin, status, num_turns, updated_at
       ) VALUES (
         $1::uuid, 'parked', 'opening prompt', $2::uuid, $2::uuid, $3::uuid, 'claude',
         TRUE, 'AWAITING_INPUT', 1, clock_timestamp()
       )`,
      [PARKED_SESSION_ID, OWNER_ID, RUNNER_ID],
    );
    await admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, answered_at
       ) VALUES (gen_random_uuid(), $1::uuid, 1, $2, 'message', 'opening prompt', 'ANSWERED',
                 clock_timestamp())`,
      [PARKED_SESSION_ID, SessionsService.initialTurnClientId(PARKED_SESSION_ID)],
    );

    await withSendDoor(async (send) => {
      const answer = await send(PARKED_SESSION_ID, {
        message: 'the obligation is still open — pick it back up',
        clientTurnId: 'startup-removal-parked-1',
      });
      // The removal's whole condition, stated as the predicate it failed on 2026-09-01.
      assert.notEqual(answer.status, 503,
        `session_send answered 503: ${JSON.stringify(answer.body)}`);
      assert.doesNotMatch(JSON.stringify(answer.body), /SESSION_TURN_PROTOCOL_DISABLED/);
      assert.ok(answer.status >= 200 && answer.status < 300,
        `session_send answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.kind, 'message');
      assert.equal(answer.body.placement, 'accepted');

      // Delivered, not merely accepted: the row is durable and the session is schedulable again.
      const stored = await admin.query<{ content: string; kind: string; status: string }>(
        `SELECT content, kind, status FROM "conversation_turn"
          WHERE session_id = $1::uuid AND client_turn_id = $2`,
        [PARKED_SESSION_ID, 'startup-removal-parked-1'],
      );
      assert.deepEqual(stored.rows, [{
        content: 'the obligation is still open — pick it back up',
        kind: 'message',
        status: 'PENDING',
      }]);
      const session = await admin.query<{ status: string }>(
        `SELECT status::text AS status FROM "session" WHERE id = $1::uuid`,
        [PARKED_SESSION_ID],
      );
      assert.equal(session.rows[0].status, 'PENDING',
        'a parked session must be woken by the send, not left waiting');
      assert.deepEqual(chargedSteers, [PARKED_SESSION_ID],
        'the orchestration send must still be charged as a steer');

      // A retry of a call whose answer was never seen replays its receipt rather than sending
      // twice — the property the clientTurnId exists for, and the one a removal could break.
      const retry = await send(PARKED_SESSION_ID, {
        message: 'the obligation is still open — pick it back up',
        clientTurnId: 'startup-removal-parked-1',
      });
      assert.equal(retry.status, answer.status);
      assert.equal(retry.body.turnId, answer.body.turnId);
      const copies = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "conversation_turn"
          WHERE session_id = $1::uuid AND client_turn_id = $2`,
        [PARKED_SESSION_ID, 'startup-removal-parked-1'],
      );
      assert.equal(copies.rows[0].n, '1');
    });
  });

pgTest('(e) the same door writes into the turn a live session is already running', async () => {
  await connect();
  chargedSteers = [];
  await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [LIVE_SESSION_ID]);
  await admin.query(
    `INSERT INTO "session"(
       id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
       provider_builtin, status, num_turns, updated_at
     ) VALUES (
       $1::uuid, 'live', 'opening prompt', $2::uuid, $2::uuid, $3::uuid, 'claude',
       TRUE, 'RUNNING', 1, clock_timestamp()
     )`,
    [LIVE_SESSION_ID, OWNER_ID, RUNNER_ID],
  );
  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status, delivered_at,
       lease_deadline_at
     ) VALUES ($1::uuid, $2::uuid, 1, $3, 'message', 'opening prompt', 'IN_FLIGHT',
               clock_timestamp(), clock_timestamp() + interval '5 minutes')`,
    [LIVE_TURN_ID, LIVE_SESSION_ID, SessionsService.initialTurnClientId(LIVE_SESSION_ID)],
  );

  await withSendDoor(async (send) => {
    const answer = await send(LIVE_SESSION_ID, {
      message: 'you are going the wrong way',
      clientTurnId: 'startup-removal-live-1',
    });
    assert.notEqual(answer.status, 503);
    assert.ok(answer.status >= 200 && answer.status < 300,
      `session_send answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.kind, 'steer');
    assert.equal(answer.body.placement, 'steer');
    const stored = await admin.query<{ kind: string; sendIntent: string | null }>(
      `SELECT kind, send_intent AS "sendIntent" FROM "conversation_turn"
        WHERE session_id = $1::uuid AND client_turn_id = $2`,
      [LIVE_SESSION_ID, 'startup-removal-live-1'],
    );
    assert.deepEqual(stored.rows, [{ kind: 'steer', sendIntent: null }]);
    assert.deepEqual(chargedSteers, [LIVE_SESSION_ID]);
  });
});

// ── (f) starting a session, and the context that rides with its opening turn ───────────────────

pgTest('(f) a session still starts: its seeded opening turn keeps its prompt and attachments',
  async () => {
    await connect();
    await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [SEEDING_SESSION_ID]);
    await admin.query(
      `INSERT INTO "session"(
         id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
         provider_builtin, status, num_turns, updated_at
       ) VALUES (
         $1::uuid, 'seeding', 'the opening prompt', $2::uuid, $2::uuid, $3::uuid, 'claude',
         TRUE, 'RUNNING', 0, clock_timestamp()
       )`,
      [SEEDING_SESSION_ID, OWNER_ID, RUNNER_ID],
    );
    // A compose-page upload: owned, scoped to the session, not yet on any turn.
    await admin.query(
      `INSERT INTO "attachment"(id, owner_id, session_id, mime_type, size_bytes, file_name, data)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'image/png', 3, 'shot.png', '\\x010203'::bytea)`,
      [ATTACHMENT_ID, OWNER_ID, SEEDING_SESSION_ID],
    );

    const sessions = new SessionsService(
      prisma as never,
      { notifySessionQueued: () => undefined } as never,
      {
        notifyInbox: () => undefined,
        publishQueuedTurnsChanged: () => undefined,
        publishSessionUpdated: () => undefined,
      } as never,
    );
    const queued = await sessions.createTurn(OWNER_ID, SEEDING_SESSION_ID, {
      clientTurnId: 'startup-removal-follow-up',
      content: 'and then do this',
    });
    assert.equal(queued.kind, 'message');

    const seeded = await admin.query<{ content: string; status: string }>(
      `SELECT content, status FROM "conversation_turn"
        WHERE session_id = $1::uuid AND client_turn_id = $2`,
      [SEEDING_SESSION_ID, SessionsService.initialTurnClientId(SEEDING_SESSION_ID)],
    );
    assert.deepEqual(seeded.rows, [{ content: 'the opening prompt', status: 'PENDING' }]);
    const linked = await admin.query<{ turnId: string | null }>(
      `SELECT turn_id AS "turnId" FROM "attachment" WHERE id = $1::uuid`,
      [ATTACHMENT_ID],
    );
    assert.ok(linked.rows[0].turnId, 'the compose-page upload must ride with the opening turn');

    // ...and the runner receives exactly that: the prompt it was seeded with and the image that
    // came with it. This is the envelope assembly the startup fragments used to be spliced into.
    const runnerApi = new RunnerApiController(
      prisma as never,
      { notifySessionQueued: () => undefined } as never,
      {
        notifyInbox: () => undefined,
        publish: () => undefined,
        publishSessionUpdated: () => undefined,
        publishQueuedTurnsChanged: () => undefined,
      } as never,
      {} as never,
      {} as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    );
    const dequeue = (runnerApi as unknown as {
      dequeueTurn: (
        sessionId: string,
        runnerId: string,
        leaseGeneration: null,
        acceptsSteer: boolean,
        declaredCapabilities: readonly string[],
      ) => Promise<{
        turnId: string;
        content?: string;
        attachments?: Array<{ id: string }>;
      } | null>;
    }).dequeueTurn.bind(runnerApi);
    const delivered = await dequeue(SEEDING_SESSION_ID, RUNNER_ID, null, true, []);
    assert.ok(delivered, 'the seeded opening turn must be deliverable');
    assert.match(delivered.content ?? '', /the opening prompt/);
    assert.deepEqual((delivered.attachments ?? []).map((a) => a.id), [ATTACHMENT_ID]);
  });
