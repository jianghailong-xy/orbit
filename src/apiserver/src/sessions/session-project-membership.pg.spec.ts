import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, Prisma, ProjectStatus } from '@prisma/client';
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
import { sessionInProjectSql, sessionProjectMembershipSql } from './session-project-membership';
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

/** The ids the list's projectId filter selects for `w`'s owner, over every lifecycle and behind the
 *  same ownership fence, two ways: the membership comparison the WHERE clause used to make, and
 *  sessionInProjectSql. Sorted, so they compare as sets. */
async function filterBothWays(w: World, projectId: string): Promise<{ before: string[]; now: string[] }> {
  const ids = async (predicate: Prisma.Sql) => (await w.h.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT s.id FROM session s
    WHERE s.owner_id = ${w.ownerId}::uuid
      AND EXISTS (SELECT 1 FROM project p WHERE p.id = ${projectId}::uuid AND p.owner_id = ${w.ownerId}::uuid)
      AND ${predicate}
  `)).map((row) => row.id).sort();
  return {
    before: await ids(Prisma.sql`(${sessionProjectMembershipSql('s')} ->> 'projectId')::uuid = ${projectId}::uuid`),
    now: await ids(sessionInProjectSql('s', projectId)),
  };
}

interface Members { open: string[]; completed: string[]; deleted?: string[] }

/** `projectId` selects exactly `expected` for `w`'s owner and the old and new filters agree; on the
 *  route, each view returns that view's own rows whose projectMembership names the project. */
async function assertProjectFilter(w: World, projectId: string, expected: Members): Promise<void> {
  const { before, now } = await filterBothWays(w, projectId);
  assert.deepEqual(now, before, 'sessionInProjectSql disagrees with the membership comparison it replaced');
  assert.deepEqual(now, [...expected.open, ...expected.completed, ...(expected.deleted ?? [])].sort(), 'members');
  for (const view of ['open', 'completed'] as const) {
    const ordinary = await read(w, `/sessions?view=${view}`) as SessionRow[];
    const byMembership = ordinary.filter((row) => row.projectMembership?.projectId === uuidToBase62(projectId));
    const listed = await read(w, `/sessions?projectId=${uuidToBase62(projectId)}&view=${view}`) as SessionRow[];
    assert.deepEqual(listed, byMembership, `${view}: rows differ from the list's own projectMembership`);
    assert.deepEqual(listed.map((row) => row.id).sort(), expected[view].map(uuidToBase62).sort(), `${view} members`);
  }
}

/** A project `w`'s owner does not own lists nothing, whatever the links of its sessions say. */
async function assertNoProjectRows(w: World, projectId: string): Promise<void> {
  assert.deepEqual(await filterBothWays(w, projectId), { before: [], now: [] });
  for (const view of ['open', 'completed'] as const) {
    assert.deepEqual(await read(w, `/sessions?projectId=${uuidToBase62(projectId)}&view=${view}`), []);
  }
}

const under = (root: string) => ({ rootSessionId: root, parentSessionId: root, spawnDepth: 1 });

test('projectId keeps every role and inheriting child, and leaves out sessions directly in another project even under its roots', { skip }, async () => {
  const w = await world('filter-precedence');
  const y = await w.h.db.project.create({ data: { ownerId: w.ownerId, title: 'filter-precedence other project' } });
  const inY = { ...w, project: y };
  const stranger = await world('filter-precedence-stranger');

  // X's members, one per direct role. Each also links to Y with a lower role, which loses: the
  // coordinator executes a Y task, the TASK and CONTEXT members hold an open Y judgment wake.
  const coordinator = await directSession(w, 'COORDINATOR', { taskId: await task(w, y.id) });
  await w.h.db.session.update({ where: { id: coordinator }, data: { rootSessionId: coordinator } });
  const taskMember = await directSession(w, 'TASK');
  await wake(inY, taskMember);
  const contextMember = await directSession(w, 'CONTEXT');
  await wake(inY, contextMember);
  const judgment = await directSession(w, 'JUDGMENT');
  // CHILD of each kind of root, a grandchild, one whose project-less task falls through to its
  // root, and children that have left Open.
  const children: string[] = [];
  for (const root of [coordinator, taskMember, contextMember, judgment]) children.push(await session(w, under(root)));
  children.push(await session(w, { rootSessionId: coordinator, parentSessionId: children[0], spawnDepth: 2 }));
  children.push(await session(w, { taskId: await task(w, null), ...under(coordinator) }));
  const completedChild = await session(w, { ...under(coordinator), completedAt: new Date() });
  const deletedChild = await session(w, { ...under(coordinator), deletedAt: new Date() });

  // Y's members, every one also a candidate of X: under X's roots, or holding an open X wake.
  const yMembers = [
    await directSession(inY, 'COORDINATOR', under(coordinator)),
    await directSession(inY, 'TASK', under(coordinator)),
    await directSession(inY, 'CONTEXT', under(taskMember)),
    await directSession(inY, 'JUDGMENT', under(judgment)),
  ];
  for (const role of ['TASK', 'CONTEXT'] as const) {
    const id = await directSession(inY, role);
    await wake(w, id);
    yMembers.push(id);
  }
  // Inherits Y from a root that itself sits under X's coordinator.
  yMembers.push(await session(w, under(yMembers[1])));

  // Linked to X, but nobody's member: a delivered wake, and a root of nothing pointing at itself.
  const delivered = await session(w);
  await wake(w, delivered, 'DELIVERED');
  const selfRooted = await session(w);
  await w.h.db.session.update({ where: { id: selfRooted }, data: { rootSessionId: selfRooted } });

  // Another owner's sessions whose membership names X, and that owner's own project.
  await wake(w, await session(stranger));
  await session(stranger, under(coordinator));
  const strangerCoordinator = await directSession(stranger, 'COORDINATOR');

  await assertProjectFilter(w, w.project.id, {
    open: [coordinator, taskMember, contextMember, judgment, ...children],
    completed: [completedChild],
    deleted: [deletedChild],
  });
  await assertProjectFilter(w, y.id, { open: yMembers, completed: [] });
  await assertProjectFilter(stranger, stranger.project.id, { open: [strangerCoordinator], completed: [] });
  await assertNoProjectRows(stranger, w.project.id);
  await assertNoProjectRows(w, stranger.project.id);
  await assertNoProjectRows(w, randomUUID());
});

/** mulberry32: seeded, so a failing seed replays exactly. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('on random membership graphs projectId matches the old comparison and a reference model', { skip }, async () => {
  // How often each role and each precedence situation came up, over all seeds: the graphs must
  // actually exercise what the filter has to get right.
  const seen = new Map<string, number>();
  const tally = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const w = await world(`random-${seed}`);
    const stranger = await world(`random-${seed}-stranger`);
    const projects = [w.project];
    for (const n of [1, 2]) {
      projects.push(await w.h.db.project.create({ data: { ownerId: w.ownerId, title: `random ${seed}.${n}` } }));
    }
    const projectOrNone = () => pick([...projects.map((p) => p.id), null]);

    // The reference model: what each session links to directly, and its root.
    const coordinatorOf = new Map<string, string>();
    const taskProjectOf = new Map<string, string | null>();
    const contextProjectOf = new Map<string, string | null>();
    const judgmentOf = new Map<string, string>();
    const rootOf = new Map<string, string>();
    const lifecycleOf = new Map<string, keyof Members>();
    const contextTasks: Array<{ id: string; projectId: string | null }> = [];
    for (const projectId of [...projects.map((p) => p.id), null]) contextTasks.push({ id: await task(w, projectId), projectId });

    const ids: string[] = [];
    for (let i = 0; i < 36; i++) {
      const fields: Partial<Prisma.SessionUncheckedCreateInput> = {};
      const link = pick(['none', 'none', 'task', 'context'] as const);
      let taskProject: string | null | undefined;
      let contextProject: string | null | undefined;
      if (link === 'task') {
        taskProject = projectOrNone();
        fields.taskId = await task(w, taskProject); // its own: a task has one live execution
      }
      if (link === 'context') {
        const about = pick(contextTasks);
        fields.contextTaskId = about.id;
        contextProject = about.projectId;
      }
      const rooting = random();
      if (rooting < 0.45 && ids.length > 0) fields.rootSessionId = pick(ids);
      const lifecycle = pick(['open', 'open', 'open', 'completed', 'deleted'] as const);
      if (lifecycle === 'completed') fields.completedAt = new Date();
      if (lifecycle === 'deleted') fields.deletedAt = new Date();
      const id = await session(w, fields);
      if (rooting >= 0.45 && rooting < 0.55) {
        await w.h.db.session.update({ where: { id }, data: { rootSessionId: id } });
        rootOf.set(id, id);
      } else if (fields.rootSessionId) {
        rootOf.set(id, fields.rootSessionId);
      }
      if (taskProject !== undefined) taskProjectOf.set(id, taskProject);
      if (contextProject !== undefined) contextProjectOf.set(id, contextProject);
      lifecycleOf.set(id, lifecycle);
      ids.push(id);
    }
    for (const project of projects) {
      if (random() >= 0.85) continue;
      const id = pick(ids.filter((candidate) => !coordinatorOf.has(candidate)));
      await w.h.db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: id } });
      coordinatorOf.set(id, project.id);
    }
    for (let i = 0; i < 10; i++) {
      const id = pick(ids);
      const project = pick(projects);
      // At most one open judgment wake per session (project_coordinator_wake_session_id_key).
      const status = judgmentOf.has(id) ? 'DELIVERED' : pick(['SESSION_OPENED', 'SESSION_OPENED', 'DELIVERED']);
      await wake({ ...w, project }, id, status);
      if (status === 'SESSION_OPENED') judgmentOf.set(id, project.id);
    }
    // Another owner's sessions that name these projects never show up for this owner.
    await wake({ ...w, project: pick(projects) }, await session(stranger));
    await session(stranger, under(pick(ids)));

    const direct = (id: string): string | null =>
      coordinatorOf.get(id) ?? taskProjectOf.get(id) ?? contextProjectOf.get(id) ?? judgmentOf.get(id) ?? null;
    const memberOf = (id: string): string | null => {
      const root = rootOf.get(id);
      return direct(id) ?? (root !== undefined && root !== id ? direct(root) : null);
    };
    for (const id of ids) {
      const own = direct(id);
      const links = [coordinatorOf.get(id), taskProjectOf.get(id), contextProjectOf.get(id), judgmentOf.get(id)];
      if (new Set(links.filter(Boolean)).size > 1) tally('own links name two projects');
      if (own === null) {
        tally(memberOf(id) === null ? 'no project' : 'CHILD');
        continue;
      }
      tally(coordinatorOf.has(id) ? 'COORDINATOR' : taskProjectOf.get(id) ? 'TASK' : contextProjectOf.get(id) ? 'CONTEXT' : 'JUDGMENT');
      const root = rootOf.get(id);
      if (root !== undefined && root !== id && direct(root) !== null && direct(root) !== own) {
        tally('own project differs from the root\'s');
      }
    }

    for (const project of projects) {
      const members = ids.filter((id) => memberOf(id) === project.id);
      const inLifecycle = (lifecycle: keyof Members) => members.filter((id) => lifecycleOf.get(id) === lifecycle);
      await assertProjectFilter(w, project.id, {
        open: inLifecycle('open'), completed: inLifecycle('completed'), deleted: inLifecycle('deleted'),
      });
    }
    await assertNoProjectRows(stranger, pick(projects).id);
  }
  for (const key of [
    'COORDINATOR', 'TASK', 'CONTEXT', 'JUDGMENT', 'CHILD', 'no project',
    'own links name two projects', 'own project differs from the root\'s',
  ]) {
    assert.ok((seen.get(key) ?? 0) > 0, `the random graphs never produced: ${key} (${JSON.stringify([...seen])})`);
  }
});
