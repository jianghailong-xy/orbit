import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PG_ADAPTER_OPTIONS } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { fixtureFacts } from '../test-support/session-word';

/**
 * `GET /sessions/project-placement` (SessionsService.projectPlacement), against the migrated
 * PostgreSQL and the real HTTP route: the one read a workspace list places its project rows with,
 * where it used to make one or two `GET /sessions?projectId=` a project (task 351B8WhZqwkFMvG0iH2bE).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/project-placement.pg.spec.ts
 *
 * Every statement the client sends is counted (Prisma's query events), so "one read" is checked as
 * a fixed number of statements however many projects it names, not only as one request.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

BigInt.prototype.toJSON = function () { return this.toString(); };

interface Harness {
  app: INestApplication;
  base: string;
  sql: Client;
  db: PrismaClient;
  statements: string[];
  bearers: Map<string, string>;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const statements: string[] = [];
    const db = new PrismaClient({
      adapter: new PrismaPg(URL!, PG_ADAPTER_OPTIONS),
      log: [{ emit: 'event', level: 'query' }],
    });
    (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void })
      .$on('query', (q) => statements.push(q.query));
    const prisma = db as unknown as PrismaService;
    const bearers = new Map<string, string>();
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
              return { sub, email: `${sub}@placement.invalid` };
            },
          },
        },
      ],
    })
    class PlacementModule {}

    const app = await NestFactory.create(PlacementModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new PublicIdInterceptor());
    await app.listen(0, '127.0.0.1');
    return { app, base: await app.getUrl(), sql, db, statements, bearers };
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

interface Owner { h: Harness; ownerId: string; bearer: string; workspaceA: string; workspaceB: string }

async function owner(label: string): Promise<Owner> {
  const h = await boot();
  const ownerId = randomUUID();
  await h.db.user.create({ data: { id: ownerId, email: `${ownerId}@placement.invalid`, name: label, passwordHash: 'x' } });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  const runnerId = randomUUID();
  await h.db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: 'ONLINE', capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  const workspace = async (name: string) => (await h.db.workspace.create({
    data: { ownerId, runnerId, name: `${label} ${name}`, enabled: true },
  })).id;
  return { h, ownerId, bearer, workspaceA: await workspace('A'), workspaceB: await workspace('B') };
}

async function session(o: Owner, fields: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
  const row = await o.h.db.session.create({
    data: {
      ownerId: o.ownerId, creatorId: o.ownerId, title: 'placement session', prompt: 'p',
      turnState: null, dispatchOrigin: 'USER', workspaceId: o.workspaceA, ...fixtureFacts(fields),
    },
  });
  return row.id;
}

type Coordinator = 'open' | 'completed' | 'trashed' | 'absent';

interface Fixture {
  projectId: string;
  coordinator: Coordinator;
  coordinatorId: string | null;
  /** Its Open members besides the coordinator: one ordinary, and one waiting on the owner. */
  members: string[];
  waitingId: string;
}

/** A project with one ordinary Open member, one Open member waiting on an approval, one Completed
 *  member, and the coordinator `kind` says. The coordinator runs in workspace B, the members in A. */
async function project(o: Owner, kind: Coordinator, i: number): Promise<Fixture> {
  const p = await o.h.db.project.create({ data: { ownerId: o.ownerId, title: `placement ${kind} ${i}` } });
  const task = async () => (await o.h.db.task.create({
    data: {
      ownerId: o.ownerId, creatorType: 'USER', creatorId: o.ownerId, title: `t${i}`,
      projectId: p.id, completionCriterion: 'OWNER_CONFIRMED',
    },
  })).id;
  const ordinary = await session(o, { taskId: await task() });
  const waitingId = await session(o, { taskId: await task(), turnState: 'IN_FLIGHT'});
  await o.h.db.approval.create({ data: { sessionId: waitingId, toolName: 'Bash', input: { command: 'ls' } } });
  // Released, so with finished_at and its cause (session_release_fact_chk, 1401/1402).
  await session(o, {
    taskId: await task(), completedAt: new Date(), turnState: null, finishedAt: new Date(), 
  });
  let coordinatorId: string | null = null;
  if (kind !== 'absent') {
    coordinatorId = await session(o, {
      title: `coordinator ${i}`, workspaceId: o.workspaceB,
      ...(kind === 'completed'
        ? { completedAt: new Date(), status: 'SUCCEEDED', finishedAt: new Date()}
        : {}),
      ...(kind === 'trashed' ? { deletedAt: new Date() } : {}),
    });
    await o.h.db.project.update({ where: { id: p.id }, data: { coordinatorSessionId: coordinatorId } });
  }
  return { projectId: p.id, coordinator: kind, coordinatorId, members: [ordinary, waitingId], waitingId };
}

const KINDS: Coordinator[] = ['open', 'completed', 'absent', 'trashed'];

async function projects(o: Owner, count: number): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (let i = 0; i < count; i += 1) out.push(await project(o, KINDS[i % KINDS.length], i));
  return out;
}

interface PlacementRow {
  id: string;
  workspace?: { id: string } | null;
  projectMembership?: { projectId: string; role: string } | null;
  pendingApprovals?: number;
  lifecycleState?: string;
}
interface Placement { projectId: string; coordinator: PlacementRow | null; waiting: PlacementRow[]; sessionCount: number }

async function placement(
  o: Owner,
  ids: readonly string[],
  view = 'open',
  headers: Record<string, string> = {},
): Promise<{ status: number; etag: string | null; body: { projects: Placement[] } | null; statements: number }> {
  const before = o.h.statements.length;
  const qs = new URLSearchParams({ projectIds: ids.map(uuidToBase62).join(','), view });
  const response = await fetch(`${o.h.base}/api/sessions/project-placement?${qs}`, {
    headers: { authorization: `Bearer ${o.bearer}`, ...headers },
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    body: text ? JSON.parse(text) : null,
    statements: o.h.statements.length - before,
  };
}

function assertPlacement(o: Owner, fixtures: readonly Fixture[], answer: { projects: Placement[] }): void {
  assert.deepEqual(answer.projects.map((p) => p.projectId), fixtures.map((f) => uuidToBase62(f.projectId)),
    'one answer a project, in the order asked');
  for (const [i, f] of fixtures.entries()) {
    const got = answer.projects[i];
    const shows = f.coordinator === 'open' || f.coordinator === 'completed';
    if (!shows) {
      assert.equal(got.coordinator, null, `${f.coordinator} coordinator of project ${i} was answered`);
    } else {
      assert.ok(got.coordinator, `${f.coordinator} coordinator of project ${i} was not answered`);
      assert.equal(got.coordinator.id, uuidToBase62(f.coordinatorId!));
      assert.equal(got.coordinator.workspace?.id, uuidToBase62(o.workspaceB), 'the coordinator’s workspace');
      assert.deepEqual(
        { projectId: got.coordinator.projectMembership?.projectId, role: got.coordinator.projectMembership?.role },
        { projectId: uuidToBase62(f.projectId), role: 'COORDINATOR' },
      );
      assert.equal(got.coordinator.lifecycleState, f.coordinator === 'open' ? 'OPEN' : 'COMPLETED');
    }
    assert.deepEqual(got.waiting.map((row) => row.id), [uuidToBase62(f.waitingId)], `project ${i}'s waiting member`);
    assert.equal(got.waiting[0].pendingApprovals, 1);
    // Its two Open members, and an Open or Completed coordinator; never the Completed member or a trashed one.
    assert.equal(got.sessionCount, 2 + (shows ? 1 : 0), `project ${i}'s session count`);
  }
}

test('each project’s coordinator — Open, Completed, trashed or none — in one read', { skip }, async () => {
  const o = await owner('mix');
  const fixtures = await projects(o, 8);
  const answer = await placement(o, fixtures.map((f) => f.projectId));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assertPlacement(o, fixtures, answer.body!);
});

test('a fixed number of statements, whatever the number of projects', { skip }, async () => {
  const o = await owner('scale');
  const fixtures = await projects(o, 24);
  const few = await placement(o, fixtures.slice(0, 4).map((f) => f.projectId));
  const many = await placement(o, fixtures.map((f) => f.projectId));
  assert.equal(few.status, 200);
  assert.equal(many.status, 200);
  assertPlacement(o, fixtures, many.body!);
  assert.ok(few.statements > 0, 'no statement was counted');
  assert.equal(many.statements, few.statements,
    `24 projects took ${many.statements} statements where 4 took ${few.statements}`);
  // The per-project read this replaces: one request (and its statements) a project, and again in Completed.
  const before = o.h.statements.length;
  for (const f of fixtures) {
    const r = await fetch(`${o.h.base}/api/sessions?projectId=${uuidToBase62(f.projectId)}&view=open`, {
      headers: { authorization: `Bearer ${o.bearer}` },
    });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.ok(o.h.statements.length - before > many.statements,
    'the per-project reads took no more statements than the one placement read');
});

test('another owner’s project, or an id that names none, is left out', { skip }, async () => {
  const o = await owner('mine');
  const other = await owner('theirs');
  const [mine] = await projects(o, 1);
  const [theirs] = await projects(other, 1);
  const answer = await placement(o, [mine.projectId, theirs.projectId, randomUUID()]);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body!.projects.map((p) => p.projectId), [uuidToBase62(mine.projectId)]);
});

test('the Completed view counts and names the Completed members, and still finds an Open coordinator', { skip }, async () => {
  const o = await owner('completed');
  const [f] = await projects(o, 1);
  const answer = await placement(o, [f.projectId], 'completed');
  assert.equal(answer.status, 200);
  const [got] = answer.body!.projects;
  assert.equal(got.coordinator?.id, uuidToBase62(f.coordinatorId!));
  assert.deepEqual(got.waiting, [], 'a Completed member waits on nobody here');
  assert.equal(got.sessionCount, 2, 'the Completed member and the Open coordinator');
});

test('answers 304 to a read that names its ETag, and 200 once a coordinator moves', { skip }, async () => {
  const o = await owner('etag');
  const fixtures = await projects(o, 3);
  const ids = fixtures.map((f) => f.projectId);
  const first = await placement(o, ids);
  assert.equal(first.status, 200);
  assert.ok(first.etag, 'no ETag');
  const again = await placement(o, ids, 'open', { 'if-none-match': first.etag!, 'cache-control': 'no-cache' });
  assert.equal(again.status, 304);
  await o.h.db.session.update({ where: { id: fixtures[0].coordinatorId! }, data: { workspaceId: o.workspaceA } });
  const moved = await placement(o, ids, 'open', { 'if-none-match': first.etag! });
  assert.equal(moved.status, 200);
  assert.equal(moved.body!.projects[0].coordinator?.workspace?.id, uuidToBase62(o.workspaceA));
});

test('the per-project read keeps its shape for older clients', { skip }, async () => {
  const o = await owner('legacy');
  const [f] = await projects(o, 1);
  const r = await fetch(`${o.h.base}/api/sessions?projectId=${uuidToBase62(f.projectId)}&view=open`, {
    headers: { authorization: `Bearer ${o.bearer}` },
  });
  assert.equal(r.status, 200);
  const rows = await r.json() as PlacementRow[];
  assert.ok(Array.isArray(rows), 'the per-project read is still a plain array');
  assert.deepEqual(new Set(rows.map((row) => row.id)),
    new Set([...f.members, f.coordinatorId!].map(uuidToBase62)));
});

test('refuses an unknown view', { skip }, async () => {
  const o = await owner('view');
  const answer = await placement(o, [randomUUID()], 'trash');
  assert.equal(answer.status, 400);
});
