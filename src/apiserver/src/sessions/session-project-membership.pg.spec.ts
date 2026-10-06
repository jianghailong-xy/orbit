import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, type Prisma, ProjectStatus } from '@prisma/client';
import { ControlEventType, type SessionProjectMembership, uuidToBase62 } from '@orbit/shared';
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
 * The membership contract in docs/session-list-projects-design.md §2/§3.1/§3.2, against the migrated
 * PostgreSQL and the real list/detail HTTP routes and session.updated summary builder:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-project-membership.pg.spec.ts
 *
 * Only bearer verification and collaborators these reads never call are substituted. Fixtures
 * use fresh owners and ids; the production membership SQL is never replaced by a test query.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// Match the application bootstrap: details spread Session's BIGINT columns into JSON.
BigInt.prototype.toJSON = function () { return this.toString(); };

type Role = SessionProjectMembership['role'];
type DirectRole = Exclude<Role, 'CHILD'>;

interface SessionRow {
  id: string;
  projectMembership?: SessionProjectMembership | null;
  projectId?: string | null;
  projectTitle?: string | null;
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
  project: { id: string; title: string; status: ProjectStatus };
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
    // LISTEN connection or lifecycle startup to exercise toControlEvent/buildSessionSummary.
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
              return { sub, email: `${sub}@membership.invalid` };
            },
          },
        },
      ],
    })
    class MembershipModule {}

    const app = await NestFactory.create(MembershipModule, { logger: false, abortOnError: false });
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
    data: { id: ownerId, email: `${ownerId}@membership.invalid`, name: label, passwordHash: 'x' },
  });
  const bearer = `bearer-${ownerId}`;
  h.bearers.set(bearer, ownerId);
  const project = await h.db.project.create({ data: { ownerId, title: `${label} project` } });
  return { h, ownerId, bearer, project };
}

async function session(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
  const row = await w.h.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, title: 'membership session', prompt: 'p',
      status: 'AWAITING_INPUT', dispatchOrigin: 'USER', ...fields,
    },
  });
  return row.id;
}

async function task(w: World, projectId: string | null = w.project.id): Promise<string> {
  const row = await w.h.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: 'membership task',
      projectId, completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  return row.id;
}

async function wake(w: World, sessionId: string, status = 'SESSION_OPENED'): Promise<void> {
  await w.h.db.projectCoordinatorWake.create({
    data: {
      id: randomUUID(), projectId: w.project.id, sessionId, status, event: 'PROJECT_TASKS_SETTLED',
      subjectType: 'PROJECT', subjectId: w.project.id, subjectVersion: randomUUID(),
      idempotencyKey: `membership:${randomUUID()}`,
    },
  });
}

async function directSession(
  w: World,
  role: DirectRole,
  fields: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const taskId = role === 'TASK' || role === 'CONTEXT' ? await task(w) : null;
  const id = await session(w, {
    ...(role === 'TASK' ? { taskId } : {}),
    ...(role === 'CONTEXT' ? { contextTaskId: taskId } : {}),
    ...fields,
  });
  if (role === 'COORDINATOR') {
    await w.h.db.project.update({ where: { id: w.project.id }, data: { coordinatorSessionId: id } });
  }
  if (role === 'JUDGMENT') await wake(w, id);
  return id;
}

async function read(w: World, path: string): Promise<unknown> {
  const response = await fetch(`${w.h.base}/api${path}`, {
    headers: { authorization: `Bearer ${w.bearer}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

/** All three readers, including the real session.updated publication's control-plane path. */
async function assertEverywhere(w: World, sessionId: string, role: Role | null): Promise<void> {
  const id = uuidToBase62(sessionId);
  const rows = await read(w, '/sessions') as SessionRow[];
  const listed = rows.find((row) => row.id === id);
  assert.ok(listed, 'GET /sessions omitted the fixture');
  const detail = await read(w, `/sessions/${id}`) as SessionRow;
  const updated = firstValueFrom(w.h.realtime.streamForUser(w.ownerId).pipe(
    filter((event) => event.type === ControlEventType.SESSION_UPDATED && event.sessionId === sessionId),
    timeout(5_000),
  ));
  w.h.realtime.publishSessionUpdated(sessionId);
  // This is the same public-id boundary the HTTP control-plane stream applies.
  const pushed = addTwins((await updated).data, true) as unknown as SessionRow;
  const expected = role === null ? null : addTwins({
    projectId: w.project.id, projectTitle: w.project.title, projectStatus: w.project.status, role,
  }, true);
  for (const [surface, row] of [['list', listed], ['detail', detail], ['push', pushed]] as const) {
    assert.deepEqual(row.projectMembership, expected, `${surface} membership`);
    // These old fields continue to mean only "the project this session coordinates".
    assert.equal(row.projectId, role === 'COORDINATOR' ? uuidToBase62(w.project.id) : null,
      `${surface} coordinator projectId`);
    assert.equal(row.projectTitle, role === 'COORDINATOR' ? w.project.title : null,
      `${surface} coordinator projectTitle`);
  }
  assert.deepEqual(listed.projectMembership, detail.projectMembership, 'list/detail differ');
  assert.deepEqual(detail.projectMembership, pushed.projectMembership, 'detail/push differ');
}

const DIRECT_ROLES: readonly DirectRole[] = ['COORDINATOR', 'TASK', 'CONTEXT', 'JUDGMENT'];

for (const role of DIRECT_ROLES) {
  test(`${role} membership agrees in list, detail and session.updated; legacy fields stay coordinator-only`, { skip }, async () => {
    const w = await world(role);
    const id = await directSession(w, role);
    await assertEverywhere(w, id, role);
  });
}

for (const rootRole of DIRECT_ROLES) {
  test(`CHILD inherits its ${rootRole} root's project across all three readers`, { skip }, async () => {
    const w = await world(`child-${rootRole}`);
    const rootId = await directSession(w, rootRole);
    await w.h.db.session.update({ where: { id: rootId }, data: { rootSessionId: rootId } });
    await assertEverywhere(w, rootId, rootRole);
    const id = await session(w, { rootSessionId: rootId, parentSessionId: rootId, spawnDepth: 1 });
    await assertEverywhere(w, id, 'CHILD');
    const grandchild = await session(w, { rootSessionId: rootId, parentSessionId: id, spawnDepth: 2 });
    await assertEverywhere(w, grandchild, 'CHILD');
  });
}

test('unrelated sessions, project-less tasks/context and children of unrelated roots have null membership', { skip }, async () => {
  const w = await world('unrelated');
  const unrelated = await session(w);
  await assertEverywhere(w, unrelated, null);
  const taskId = await task(w, null);
  await assertEverywhere(w, await session(w, { taskId }), null);
  await assertEverywhere(w, await session(w, { contextTaskId: taskId }), null);
  await assertEverywhere(w, await session(w, { rootSessionId: unrelated, parentSessionId: unrelated }), null);
});

for (const lowerRole of ['TASK', 'CONTEXT', 'JUDGMENT'] as const) {
  test(`COORDINATOR wins over ${lowerRole} for a different project`, { skip }, async () => {
    const w = await world(`priority-${lowerRole}`);
    const other = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'lower-priority project' } });
    const lowerWorld = { ...w, project: other };
    const id = await directSession(lowerWorld, lowerRole);
    await w.h.db.project.update({ where: { id: w.project.id }, data: { coordinatorSessionId: id } });
    await assertEverywhere(w, id, 'COORDINATOR');
  });
}

for (const higherRole of ['TASK', 'CONTEXT'] as const) {
  test(`${higherRole} wins over JUDGMENT for a different project`, { skip }, async () => {
    const w = await world(`priority-${higherRole}`);
    const id = await directSession(w, higherRole);
    const other = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'wake project' } });
    await wake({ ...w, project: other }, id);
    await assertEverywhere(w, id, higherRole);
  });
}

for (const ownRole of DIRECT_ROLES) {
  test(`a child's own ${ownRole} membership wins over its root's different project`, { skip }, async () => {
    const w = await world(`own-${ownRole}`);
    const other = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'root project' } });
    const rootId = await directSession({ ...w, project: other }, 'COORDINATOR');
    const id = await directSession(w, ownRole, { rootSessionId: rootId, parentSessionId: rootId, spawnDepth: 1 });
    await assertEverywhere(w, id, ownRole);
  });
}

for (const link of ['taskId', 'contextTaskId'] as const) {
  test(`${link} without a project falls through to CHILD, then JUDGMENT`, { skip }, async () => {
    const w = await world(`projectless-${link}`);
    const rootId = await directSession(w, 'COORDINATOR');
    const projectlessTaskId = await task(w, null);
    const id = await session(w, {
      [link]: projectlessTaskId, rootSessionId: rootId, parentSessionId: rootId, spawnDepth: 1,
    });
    await assertEverywhere(w, id, 'CHILD');
    const other = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'judgment project' } });
    const judgmentWorld = { ...w, project: other };
    await wake(judgmentWorld, id);
    await assertEverywhere(judgmentWorld, id, 'JUDGMENT');
  });
}

test('a DELIVERED wake does not make its session a JUDGMENT member', { skip }, async () => {
  const w = await world('delivered-wake');
  const id = await session(w);
  await wake(w, id, 'DELIVERED');
  await assertEverywhere(w, id, null);
});

test('a replaced coordinator has null membership and null legacy coordinator fields', { skip }, async () => {
  const w = await world('replaced-coordinator');
  const oldId = await directSession(w, 'COORDINATOR');
  const newId = await session(w);
  await w.h.db.project.update({ where: { id: w.project.id }, data: { coordinatorSessionId: newId } });
  await assertEverywhere(w, oldId, null);
  await assertEverywhere(w, newId, 'COORDINATOR');
});

test('projectStatus is the current project status on every surface', { skip }, async () => {
  const w = await world('project-status');
  const id = await directSession(w, 'CONTEXT');
  await assertEverywhere(w, id, 'CONTEXT');
  w.project = await w.h.db.project.update({
    where: { id: w.project.id }, data: { status: ProjectStatus.CANCELLED },
  });
  await assertEverywhere(w, id, 'CONTEXT');
});

test('projectId lists every membership role across workspaces with the ordinary row shape, order and limit', { skip }, async () => {
  const w = await world('project-list');
  const first = await w.h.db.workspace.create({ data: { ownerId: w.ownerId, name: 'first workspace' } });
  const second = await w.h.db.workspace.create({ data: { ownerId: w.ownerId, name: 'second workspace' } });
  const coordinator = await directSession(w, 'COORDINATOR', {
    workspaceId: first.id, pinnedAt: new Date('2026-01-01'), lastTurnAt: new Date('2026-01-01'),
  });
  const memberIds = [coordinator];
  for (const [index, role] of (['TASK', 'CONTEXT', 'JUDGMENT'] as const).entries()) {
    memberIds.push(await directSession(w, role, {
      workspaceId: second.id, lastTurnAt: new Date(`2026-01-0${index + 2}`),
    }));
  }
  memberIds.push(await session(w, {
    workspaceId: second.id, rootSessionId: coordinator, parentSessionId: coordinator,
    spawnDepth: 1, lastTurnAt: new Date('2026-01-05'),
  }));
  await session(w, { workspaceId: second.id, pinnedAt: new Date(), lastTurnAt: new Date() });
  const other = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'other project' } });
  await directSession({ ...w, project: other }, 'TASK', {
    workspaceId: first.id, rootSessionId: coordinator, parentSessionId: coordinator, spawnDepth: 1,
  });

  const ids = memberIds.map(uuidToBase62);
  const ordinary = await read(w, '/sessions?view=open') as SessionRow[];
  const expected = ordinary.filter((row) => ids.includes(row.id));
  assert.deepEqual(expected.map((row) => row.id), [ids[0], ...ids.slice(1).reverse()]);
  for (const projectId of [w.project.id, uuidToBase62(w.project.id)]) {
    assert.deepEqual(await read(w, `/sessions?projectId=${projectId}&view=open`), expected);
    assert.deepEqual(await read(w, `/sessions?projectId=${projectId}&view=open&limit=2`), expected.slice(0, 2));
  }
});

test('projectId keeps open and completed lifecycle filters and completed ordering', { skip }, async () => {
  const w = await world('project-list-views');
  const coordinator = await directSession(w, 'COORDINATOR');
  const completed = await directSession(w, 'TASK', {
    completedAt: new Date('2026-01-03'), lastTurnAt: new Date('2026-01-01'),
  });
  const archived = await directSession(w, 'CONTEXT', {
    archivedAt: new Date('2026-01-02'), lastTurnAt: new Date('2026-01-05'), pinnedAt: new Date(),
  });
  await directSession(w, 'JUDGMENT', { deletedAt: new Date() });
  await directSession(w, 'TASK', { completedAt: new Date(), deletedAt: new Date() });
  await session(w);
  await session(w, { completedAt: new Date() });

  const path = `/sessions?projectId=${uuidToBase62(w.project.id)}`;
  const open = await read(w, `${path}&view=open`) as SessionRow[];
  assert.deepEqual(open.map((row) => row.id), [uuidToBase62(coordinator)]);
  assert.deepEqual(await read(w, path), open);
  const done = await read(w, `${path}&view=completed`) as SessionRow[];
  assert.deepEqual(done.map((row) => row.id), [completed, archived].map(uuidToBase62));
  const ordinary = await read(w, '/sessions?view=completed') as SessionRow[];
  assert.deepEqual(done, ordinary.filter((row) => row.projectMembership?.projectId === uuidToBase62(w.project.id)));
  assert.deepEqual(await read(w, `${path}&view=completed&limit=1`), done.slice(0, 1));
});

test('projectId returns an empty list for another owner or an unknown project', { skip }, async () => {
  const w = await world('project-list-owner');
  const other = await world('project-list-other-owner');
  await directSession(w, 'COORDINATOR');
  await directSession(other, 'COORDINATOR');
  const ownSession = await session(w);
  // A session owner's filter alone is insufficient: membership links can name another owner's project.
  await wake({ ...w, project: other.project }, ownSession);
  for (const projectId of [other.project.id, uuidToBase62(other.project.id), randomUUID()]) {
    for (const view of ['open', 'completed']) {
      assert.deepEqual(await read(w, `/sessions?projectId=${projectId}&view=${view}`), []);
    }
  }
  assert.equal((await read(other, `/sessions?projectId=${uuidToBase62(other.project.id)}`) as SessionRow[]).length, 1);
});
