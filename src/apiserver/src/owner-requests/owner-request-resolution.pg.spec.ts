/**
 * AN OWNER REQUEST'S ENDING STARTS ONE TURN IN THE SESSION THAT ASKED (migration 0504).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/owner-request-resolution.pg.spec.ts
 *
 * The ending writes an OWNER_REQUEST `watch_delivery` row in its own transaction, and the Watch delivery worker turns
 * it into a turn through `SessionsService.createTurn`, the queue every sent message takes. The cases use those real
 * collaborators against a real PostgreSQL.
 *
 * THE CASES
 * =========
 *   (a) per terminal state — DONE, DECLINED, EXPIRED, WITHDRAWN — the asking session receives exactly one turn under
 *       `owner-request:<id>:resolved` whose JSON payload names the request, its kind, the outcome and the reason;
 *       draining again, two workers racing, and a redelivery after a lost acknowledgement all leave it at one;
 *   (b) a DECISION's turn carries the option the owner chose;
 *   (c) a SECRET's turn names only where the secret goes (name, env var or file path), never a value — not even one
 *       the owner pasted into the answer text — in each of the four endings;
 *   (d) an asking session whose engine is gone (AWAITING_INPUT, nothing running) still gets the turn, queued for the
 *       next runner slot; an asking session whose run is over is not revived, and the delivery is a dead letter;
 *   (e) an ending that is refused (already ended) writes no second delivery;
 *   (f) the schema holds it: an OWNER_REQUEST row names its request and nothing else, and a request has one delivery.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import { ownerRequestTurnClientId, type OwnerRequestFiling } from './owner-request';
import { OwnerRequestsService } from './owner-requests.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const HOUR = 3_600_000;

type Ending = 'DONE' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
const ENDINGS: readonly Ending[] = ['DONE', 'DECLINED', 'EXPIRED', 'WITHDRAWN'];

/** What only the owner holds. It must never reach a turn. */
const SECRET_VALUE = 'sk_test_51NeverInATurn0123456789abcdef';

interface TurnRow {
  clientTurnId: string;
  kind: string;
  status: string;
  sendIntent: string | null;
  content: string | null;
}

test('owner requests: an ending starts exactly one turn in the asking session', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const clients: PrismaClient[] = [];
  const pool = (): PrismaClient => {
    const client = prismaClientFor(url);
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) await client.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const queue = { notifySessionQueued: () => undefined };
  const realtime = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => undefined) });
  const push = { notifyOwnerRequest: async () => undefined, notifyWatchMatched: async () => undefined } as unknown as PushService;

  /** One replica's delivery worker: its own pool and the real sessions service. Never started: a case drains it. */
  const worker = (): WatchDeliveryService => {
    const db = pool() as unknown as PrismaService;
    return new WatchDeliveryService(db, new SessionsService(db, queue as never, realtime as never), push, {
      retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: HOUR,
    });
  };

  const db = pool();
  const service = new OwnerRequestsService(db as unknown as PrismaService, push);
  const delivery = worker();

  const ownerId = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'owner requests','h')`,
    [ownerId, `${ownerId}@owner-request-resolution.invalid`]);
  const runnerId = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'owner requests',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
    [runnerId, ownerId],
  );

  /** A session that has run: started on the runner, with a runtime behind it. */
  const session = async (status: string): Promise<string> => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                             "provider","provider_builtin","num_turns","started_at","runtime_session_id")
       VALUES ($1,'asking session','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
      [id, ownerId, status, runnerId, `runtime-${id}`],
    );
    return id;
  };

  const turnsOn = async (sessionId: string): Promise<TurnRow[]> => (await sql.query<TurnRow>(
    `SELECT "client_turn_id" AS "clientTurnId", "kind", "status", "send_intent" AS "sendIntent", "content"
       FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  )).rows;

  const deliveriesOf = async (requestId: string) => (await sql.query<{ id: string; state: string; kind: string; lastError: string | null }>(
    `SELECT "id", "state", "kind", "last_error" AS "lastError" FROM "watch_delivery" WHERE "owner_request_id" = $1`,
    [requestId],
  )).rows;

  /** The JSON block a resolution turn ends with. */
  const payloadOf = (content: string | null): Record<string, unknown> => {
    const match = /```json\n([\s\S]*)\n```$/.exec(content ?? '');
    assert.ok(match, `the turn carries a JSON payload: ${content}`);
    return JSON.parse(match[1]) as Record<string, unknown>;
  };

  const file = (askingSessionId: string, filing: Partial<OwnerRequestFiling> & Pick<OwnerRequestFiling, 'kind'>) =>
    service.file(ownerId, askingSessionId, {
      title: `a ${filing.kind} request`,
      why: 'the task cannot go on without it',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      ...filing,
    } as OwnerRequestFiling);

  /** Ends a PENDING request the way production does. */
  const end = async (askingSessionId: string, id: string, ending: Ending, done: { option?: number; text?: string } = { text: 'done it' }) => {
    switch (ending) {
      case 'DONE': return service.complete(ownerId, id, done);
      case 'DECLINED': return service.decline(ownerId, id, 'not this week');
      case 'WITHDRAWN': return service.withdraw(ownerId, askingSessionId, id, 'found another way');
      case 'EXPIRED': {
        await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
        assert.ok((await service.expireDue(new Date())).includes(id));
        return service.get(ownerId, id);
      }
    }
  };

  const REASONS: Record<Ending, string | null> = {
    DONE: null, DECLINED: 'not this week', EXPIRED: null, WITHDRAWN: 'found another way',
  };

  /** The one resolution turn on a session, after every redelivery a case puts it through. */
  const theOneTurn = async (sessionId: string, requestId: string): Promise<TurnRow> => {
    const turns = (await turnsOn(sessionId)).filter((turn) => turn.clientTurnId.startsWith('owner-request:'));
    assert.equal(turns.length, 1, `exactly one resolution turn: ${JSON.stringify(turns)}`);
    assert.equal(turns[0].clientTurnId, ownerRequestTurnClientId(requestId));
    return turns[0];
  };

  await t.test('(a) each terminal state starts exactly one turn with the structured payload', async () => {
    for (const ending of ENDINGS) {
      const asker = await session('RUNNING');
      const request = await file(asker, { kind: 'CONFIRM', title: `Ship it? (${ending})` });
      assert.deepEqual(await deliveriesOf(request.id), [], 'nothing is delivered while the request is PENDING');
      await end(asker, request.id, ending);

      const rows = await deliveriesOf(request.id);
      assert.equal(rows.length, 1, `${ending}: one delivery written with the ending`);
      assert.equal(rows[0].kind, 'OWNER_REQUEST');

      const results = await delivery.drain();
      assert.deepEqual(results.filter((r) => r.deliveryId === rows[0].id).map((r) => r.outcome), ['DELIVERED']);
      // Again, two workers racing, and a redelivery after an acknowledgement that never landed: still one turn.
      assert.deepEqual((await delivery.drain()).filter((r) => r.deliveryId === rows[0].id), []);
      await sql.query(`UPDATE "watch_delivery" SET "state" = 'PENDING', "delivered_at" = NULL, "next_attempt_at" = now() WHERE "id" = $1`, [rows[0].id]);
      const raced = (await Promise.all([worker().drain(), worker().drain()])).flat().filter((r) => r.deliveryId === rows[0].id);
      assert.ok(raced.some((r) => r.outcome === 'DELIVERED'), `${ending}: the redelivery is acknowledged: ${JSON.stringify(raced)}`);
      assert.equal((await deliveriesOf(request.id))[0].state, 'DELIVERED');

      const turn = await theOneTurn(asker, request.id);
      assert.equal(turn.kind, 'message');
      assert.equal(turn.sendIntent, 'NEXT_TURN');
      assert.match(turn.content ?? '', new RegExp(`^Orbit owner request ${request.id} \\(CONFIRM\\) ended ${ending}: `));
      const payload = payloadOf(turn.content);
      assert.equal(payload.requestId, request.id);
      assert.equal(payload.kind, 'CONFIRM');
      assert.equal(payload.outcome, ending);
      assert.equal(payload.title, `Ship it? (${ending})`);
      assert.equal(payload.reason, REASONS[ending], `${ending}: the reason the owner or the session gave`);
      assert.equal(typeof payload.resolvedAt, 'string');
      if (ending === 'DONE') assert.equal(payload.answerText, 'done it');
      else assert.equal('answerText' in payload, false);
    }
  });

  await t.test('(b) a DECISION carries the option the owner chose', async () => {
    const asker = await session('RUNNING');
    const request = await file(asker, { kind: 'DECISION', options: [{ label: 'Redis' }, { label: 'Postgres' }], recommendedOption: 0 });
    await end(asker, request.id, 'DONE', { option: 1, text: 'one database is enough' });
    await delivery.drain();
    const payload = payloadOf((await theOneTurn(asker, request.id)).content);
    assert.equal(payload.outcome, 'DONE');
    assert.deepEqual(payload.chosenOption, { index: 1, label: 'Postgres' });
    assert.equal(payload.answerText, 'one database is enough');
  });

  await t.test('(c) a SECRET names where it goes and never carries a value, in every ending', async () => {
    for (const ending of ENDINGS) {
      for (const destination of [{ envVar: 'STRIPE_KEY' }, { filePath: '/home/runner/.stripe/key' }]) {
        const asker = await session('RUNNING');
        const request = await file(asker, {
          kind: 'SECRET',
          title: 'Stripe test key',
          secretSpec: { name: 'Stripe test key', runnerId, ...destination },
        });
        // The owner pastes the value into the answer box: it must still not reach the turn.
        await end(asker, request.id, ending, { text: `here it is: ${SECRET_VALUE}` });
        await delivery.drain();
        const turn = await theOneTurn(asker, request.id);
        assert.equal((turn.content ?? '').includes(SECRET_VALUE), false, `${ending}: the secret value reached the turn`);
        assert.equal((turn.content ?? '').includes('sk_test_'), false);
        const payload = payloadOf(turn.content);
        assert.equal(payload.kind, 'SECRET');
        assert.equal(payload.outcome, ending);
        assert.deepEqual(payload.secret, { name: 'Stripe test key', ...destination });
        assert.equal('answerText' in payload, false);
        assert.equal(payload.reason, REASONS[ending]);
      }
    }
  });

  await t.test('(d) an idle session whose engine is gone gets the turn; an ended one is not revived', async () => {
    const idle = await session('AWAITING_INPUT');
    const request = await file(idle, { kind: 'CONFIRM' });
    await end(idle, request.id, 'DONE');
    await delivery.drain();
    const turn = await theOneTurn(idle, request.id);
    assert.equal(turn.status, 'PENDING', 'queued for the next runner slot, as any sent message is');
    const { rows: [after] } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [idle]);
    assert.equal(after.status, 'PENDING', 'the session is due to be dispatched again to run it');

    const ended = await session('RUNNING');
    const late = await file(ended, { kind: 'CONFIRM' });
    await sql.query(`UPDATE "session" SET "status" = 'INTERRUPTED', "end_reason" = 'ended' WHERE "id" = $1`, [ended]);
    await end(ended, late.id, 'DECLINED');
    await delivery.drain();
    assert.deepEqual((await turnsOn(ended)).filter((turn) => turn.clientTurnId.startsWith('owner-request:')), []);
    const [row] = await deliveriesOf(late.id);
    assert.equal(row.state, 'DEAD_LETTER');
    assert.match(row.lastError ?? '', /^OBSERVER_SESSION_ENDED:/);
  });

  await t.test('(e) a refused ending writes no second delivery', async () => {
    const asker = await session('RUNNING');
    const request = await file(asker, { kind: 'CONFIRM' });
    await end(asker, request.id, 'DONE');
    await assert.rejects(end(asker, request.id, 'DECLINED'), ConflictException);
    await assert.rejects(end(asker, request.id, 'WITHDRAWN'), ConflictException);
    await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [request.id]);
    assert.equal((await service.expireDue(new Date())).includes(request.id), false);
    assert.equal((await deliveriesOf(request.id)).length, 1);
    await delivery.drain();
    await theOneTurn(asker, request.id);
  });

  await t.test('(f) an OWNER_REQUEST delivery names its request alone, and a request has one', async () => {
    const asker = await session('RUNNING');
    const request = await file(asker, { kind: 'CONFIRM' });
    await end(asker, request.id, 'DONE');
    const insert = (columns: Record<string, unknown>) => {
      const row: Record<string, unknown> = { id: randomUUID(), action: 'RESUME_SESSION', kind: 'OWNER_REQUEST', ...columns };
      const names = Object.keys(row);
      return sql.query(
        `INSERT INTO "watch_delivery" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    await assert.rejects(insert({ owner_request_id: request.id }), /watch_delivery_owner_request_key/, 'a request ends once, so it has one delivery');
    await assert.rejects(insert({}), /watch_delivery_owner_request_chk/, 'an OWNER_REQUEST delivery names its request');
    await assert.rejects(insert({ owner_request_id: request.id, action: 'NOTIFY_USER' }), /watch_delivery_kind_shape_chk/, 'it is a turn owed to the asking session');
    await assert.rejects(insert({ kind: 'MATCH', owner_request_id: request.id }), /watch_delivery_(kind_shape|owner_request)_chk/, 'only an OWNER_REQUEST row names a request');
    assert.equal((await deliveriesOf(request.id)).length, 1);
  });
});
