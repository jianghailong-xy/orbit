import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, Prisma } from '@prisma/client';
import { ControlEventType, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { filter, firstValueFrom, timeout } from 'rxjs';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { addTwins } from '../common/public-id-body';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * The recap delivery contract (0418), against the migrated PostgreSQL and the three readers the
 * recap has to reach: `GET /sessions` (list row), `GET /sessions/:id` (detail) and the control
 * plane's `session.updated` summary, built by the real `buildSessionSummary`.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-recap-delivery.pg.spec.ts
 *
 * Only bearer verification and collaborators these reads never call are substituted. Fixtures use
 * fresh owners and ids, and every value asserted is the fixture's own — a surface that dropped the
 * fields answers null, which none of the interesting values is.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// Match the application bootstrap: details spread Session's BIGINT columns into JSON.
BigInt.prototype.toJSON = function () { return this.toString(); };

interface RecapRow {
  id: string;
  lastAssistantText?: string | null;
  lastUserText?: string | null;
  recapText?: string | null;
  recapAt?: string | null;
}

interface Harness {
  app: INestApplication;
  base: string;
  sql: Client;
  db: PrismaClient;
  realtime: RealtimeService;
  bearers: Map<string, string>;
}

interface World {
  h: Harness;
  ownerId: string;
  bearer: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db = prismaClientFor(URL!);
    const prisma = db as unknown as PrismaService;
    const bearers = new Map<string, string>();
    // The real realtime instance stays outside Nest: the in-process stream does not need a
    // LISTEN connection or lifecycle startup to exercise buildSessionSummary.
    const realtime = new RealtimeService(prisma, { scheduleBadgeSync: () => undefined } as never);
    const sessions = new SessionsService(prisma, {} as never, realtime);

    @Module({
      controllers: [SessionsController],
      providers: [
        { provide: SessionsService, useValue: sessions },
        { provide: PrismaService, useValue: db },
        { provide: RealtimeService, useValue: {} },
        { provide: SessionTagsService, useValue: {} },
        { provide: MergeReceiptService, useValue: {} },
        { provide: AutoRetryService, useValue: {} },
        JwtAuthGuard,
        Reflector,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              const sub = bearers.get(token);
              if (!sub) throw new Error('not a bearer this run issued');
              return { sub, email: `${sub}@recap.invalid` };
            },
          },
        },
      ],
    })
    class RecapModule {}

    const app = await NestFactory.create(RecapModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new PublicIdInterceptor());
    await app.listen(0, '127.0.0.1');
    return { app, base: await app.getUrl(), sql, db, realtime, bearers };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const h = await harness;
  h.realtime.onModuleDestroy();
  await h.app.close();
  await h.db.$disconnect();
  await h.sql.end();
});

async function world(label: string): Promise<World> {
  const h = await boot();
  const ownerId = randomUUID();
  await h.db.user.create({
    data: { id: ownerId, email: `${ownerId}@recap.invalid`, name: label, passwordHash: 'x' },
  });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  return { h, ownerId, bearer };
}

async function session(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
  const row = await w.h.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, title: 'recap session', prompt: 'p',
      status: 'AWAITING_INPUT', dispatchOrigin: 'USER', ...fields,
    },
  });
  return row.id;
}

async function read(w: World, path: string): Promise<unknown> {
  const response = await fetch(`${w.h.base}/api${path}`, {
    headers: { authorization: `Bearer ${w.bearer}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

/** The three readers, including the real `session.updated` publication's control-plane path. */
async function readEverywhere(w: World, sessionId: string): Promise<Record<'list' | 'detail' | 'push', RecapRow>> {
  const id = uuidToBase62(sessionId);
  const rows = await read(w, '/sessions') as RecapRow[];
  const listed = rows.find((row) => row.id === id);
  assert.ok(listed, 'GET /sessions omitted the fixture');
  const detail = await read(w, `/sessions/${id}`) as RecapRow;
  const updated = firstValueFrom(w.h.realtime.streamForUser(w.ownerId).pipe(
    filter((event) => event.type === ControlEventType.SESSION_UPDATED && event.sessionId === sessionId),
    timeout(5_000),
  ));
  w.h.realtime.publishSessionUpdated(sessionId);
  // This is the same public-id boundary the HTTP control-plane stream applies.
  const pushed = addTwins((await updated).data, true) as unknown as RecapRow;
  return { list: listed, detail, push: pushed };
}

const RECAP = 'Refactored the drawer shadow; specs pass; next: merge.';
const RECAP_AT = new Date('2026-10-09T12:30:00.000Z');

test('the recap reaches the list row, the detail and the session.updated summary alike', { skip }, async () => {
  const w = await world('recap-delivery');
  const id = await session(w, {
    lastAssistantText: 'Filed the proposal.',
    lastUserText: 'file the proposal',
    recapText: RECAP,
    recapAt: RECAP_AT,
  });
  const { list, detail, push } = await readEverywhere(w, id);
  for (const [surface, row] of Object.entries({ list, detail, push })) {
    assert.equal(row.recapText, RECAP, `${surface} recap text`);
    assert.equal(row.recapAt, RECAP_AT.toISOString(), `${surface} recap timestamp`);
  }
  // The recap is the row's preferred line, not its only one: the reply previews ride with it, so a
  // list that folds the summary in does not fall back to previewing the turn before this one.
  assert.equal(push.lastAssistantText, 'Filed the proposal.');
  assert.equal(push.lastUserText, 'file the proposal');
  assert.equal(list.lastAssistantText, 'Filed the proposal.');
  assert.equal(detail.lastUserText, 'file the proposal');
});

test('a session no pass has recapped answers nulls on all three surfaces', { skip }, async () => {
  // Null as a value, the convention every clearing key in the summary follows: the surfaces have to
  // be able to say "no recap" so a client folding one in clears its own, and a recap-less session
  // still previews its last reply.
  const w = await world('recap-absent');
  const id = await session(w, { lastAssistantText: 'No recap for this one yet.' });
  const { list, detail, push } = await readEverywhere(w, id);
  for (const [surface, row] of Object.entries({ list, detail, push })) {
    for (const key of ['recapText', 'recapAt'] as const) {
      assert.equal(Object.hasOwn(row, key), true, `${surface} carries ${key}`);
      assert.equal(row[key], null, `${surface} ${key}`);
    }
    assert.equal(row.lastAssistantText, 'No recap for this one yet.', `${surface} preview`);
  }
});

test('a long reply is clipped to the same 200 characters in the push as in the list row', { skip }, async () => {
  // The summary is folded into a row verbatim, so the two have to agree on what that row says: a
  // preview that came back whole from the push would make the row change length on every event.
  const w = await world('recap-clip');
  const long = `${'a'.repeat(199)}😀${'b'.repeat(50)}`;
  const id = await session(w, { lastAssistantText: long });
  const { list, push } = await readEverywhere(w, id);
  assert.equal(list.lastAssistantText, `${'a'.repeat(199)}😀`);
  assert.equal(push.lastAssistantText, list.lastAssistantText);
});
