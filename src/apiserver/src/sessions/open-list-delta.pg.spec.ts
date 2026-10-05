import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, type Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
 * `GET /sessions?view=open&since=` against the migrated PostgreSQL and the real list route — each
 * way a row can change between two polls, read through the same query the whole list comes from:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/open-list-delta.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

BigInt.prototype.toJSON = function () { return this.toString(); };

type Row = { id: string; title: string };
type Delta =
  | { full: true; sessions: Row[]; cursor: string }
  | { full: false; upserts: Row[]; removedIds: string[]; order?: string[]; cursor: string };

interface Harness {
  app: INestApplication;
  base: string;
  sql: Client;
  db: PrismaClient;
  bearers: Map<string, string>;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db = prismaClientFor(URL!);
    const bearers = new Map<string, string>();
    const sessions = new SessionsService(db as unknown as PrismaService, {} as never, {} as never);

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
              return { sub, email: `${sub}@open-delta.invalid` };
            },
          },
        },
      ],
    })
    class OpenDeltaModule {}

    const app = await NestFactory.create(OpenDeltaModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new PublicIdInterceptor());
    await app.listen(0, '127.0.0.1');
    return { app, base: await app.getUrl(), sql, db, bearers };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const h = await harness;
  await h.app.close();
  await h.db.$disconnect();
  await h.sql.end();
});

async function owner() {
  const h = await boot();
  const ownerId = randomUUID();
  await h.db.user.create({
    data: { id: ownerId, email: `${ownerId}@open-delta.invalid`, name: 'open delta', passwordHash: 'x' },
  });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  const session = async (title: string, fields: Partial<Prisma.SessionUncheckedCreateInput> = {}) =>
    (await h.db.session.create({
      data: {
        ownerId, creatorId: ownerId, title, prompt: 'p', status: 'AWAITING_INPUT',
        dispatchOrigin: 'USER', ...fields,
      },
    })).id;
  const read = async (path: string) => {
    const response = await fetch(`${h.base}/api${path}`, { headers: { authorization: `Bearer ${bearer}` } });
    const body = await response.json();
    assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const since = (cursor: string) => read(`/sessions?view=open&since=${encodeURIComponent(cursor)}`) as Promise<Delta>;
  return { h, session, read, since };
}

function delta(answer: Delta) {
  assert.equal(answer.full, false, `expected a delta, got ${JSON.stringify(answer)}`);
  return answer as Extract<Delta, { full: false }>;
}

test('an empty since is the whole list, the same rows the plain read returns', { skip }, async () => {
  const o = await owner();
  await o.session('one');
  await o.session('two');
  const plain = await o.read('/sessions?view=open') as Row[];
  const answer = await o.since('');
  assert.equal(answer.full, true);
  assert.deepEqual(answer.full && answer.sessions, plain);
  assert.ok(answer.cursor);
});

test('an unchanged list is an empty delta', { skip }, async () => {
  const o = await owner();
  await o.session('one');
  const { cursor } = await o.since('');
  assert.deepEqual(await o.since(cursor), { full: false, upserts: [], removedIds: [], cursor });
});

test('a new session arrives as an upsert at the head of the order', { skip }, async () => {
  const o = await owner();
  await o.session('old', { createdAt: new Date(Date.now() - 60_000) });
  const { cursor } = await o.since('');
  const id = uuidToBase62(await o.session('new'));
  const answer = delta(await o.since(cursor));
  assert.deepEqual(answer.upserts.map((r) => [r.id, r.title]), [[id, 'new']]);
  assert.deepEqual(answer.removedIds, []);
  assert.equal(answer.order?.[0], id);
});

test('a changed field arrives as an upsert of that row only', { skip }, async () => {
  const o = await owner();
  const changed = await o.session('before');
  await o.session('untouched');
  const { cursor } = await o.since('');
  await o.h.db.session.update({ where: { id: changed }, data: { title: 'after' } });
  const answer = delta(await o.since(cursor));
  assert.deepEqual(answer.upserts.map((r) => [r.id, r.title]), [[uuidToBase62(changed), 'after']]);
  assert.deepEqual(answer.removedIds, []);
  assert.equal(answer.order, undefined);
});

test('a deleted session arrives as a removed id', { skip }, async () => {
  const o = await owner();
  const gone = await o.session('gone');
  await o.session('kept');
  const { cursor } = await o.since('');
  await o.h.db.session.delete({ where: { id: gone } });
  const answer = delta(await o.since(cursor));
  assert.deepEqual(answer.upserts, []);
  assert.deepEqual(answer.removedIds, [uuidToBase62(gone)]);
});

test('a session that leaves Open — completed or put in the trash — arrives as a removed id', { skip }, async () => {
  const o = await owner();
  const completed = await o.session('completed');
  const trashed = await o.session('trashed');
  await o.session('kept');
  const { cursor } = await o.since('');
  await o.h.db.session.update({ where: { id: completed }, data: { completedAt: new Date() } });
  await o.h.db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
  const answer = delta(await o.since(cursor));
  assert.deepEqual(answer.upserts, []);
  assert.deepEqual(new Set(answer.removedIds), new Set([uuidToBase62(completed), uuidToBase62(trashed)]));
});

test('a cursor the server does not hold asks for the whole list', { skip }, async () => {
  const o = await owner();
  await o.session('one');
  const plain = await o.read('/sessions?view=open') as Row[];
  const answer = await o.since('stale-or-from-before-a-restart');
  assert.equal(answer.full, true);
  assert.deepEqual(answer.full && answer.sessions, plain);
  assert.ok(answer.cursor);
});

test('without since, the Open list is still the plain array older clients read', { skip }, async () => {
  const o = await owner();
  await o.session('one');
  assert.ok(Array.isArray(await o.read('/sessions?view=open')));
});
