/**
 * Complete on a finished project's row (docs/session-list-projects-design.md §3.6), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-sessions-complete.pg.spec.ts
 *
 * `POST /projects/:id/sessions/complete` moves a DONE or CANCELLED project's coordinator and its
 * members still in Open, in every workspace, to Completed — each the way its own Complete moves it —
 * and answers how many moved. An OPEN project is refused, another owner's project is a 404, and a
 * request carrying a session header is refused: the press is the owner's. Whatever is not a member
 * in Open — a landing container, a member already Completed or in Trash, a session of another
 * project or of none — is left exactly as it was.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Harness {
  server: Apiserver;
  sql: Client;
  db: PrismaClient;
  jwt: JwtService;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const secret = `project-sessions-complete-${randomUUID()}`;
    const server = await startApiserver(URL!, secret);
    return { server, sql, db: prismaClientFor(URL!), jwt: new JwtService({ secret }) };
  })();
  return harness;
}

after(async () => {
  const h = await harness?.catch(() => undefined);
  if (!h) return;
  await h.server.stop();
  await h.db.$disconnect();
  await h.sql.end();
});

/** One account, signed in the way the apps are: a login, with no session header. */
interface Owner {
  h: Harness;
  id: string;
  bearer: string;
}

async function owner(label: string): Promise<Owner> {
  const h = await boot();
  const id = randomUUID();
  const email = `${label}-${id}@project-sessions-complete.invalid`;
  await h.db.user.create({ data: { id, email, name: label, passwordHash: 'x' } });
  return { h, id, bearer: await h.jwt.signAsync({ sub: id, email }) };
}

async function workspace(o: Owner, name: string): Promise<string> {
  return (await o.h.db.workspace.create({ data: { ownerId: o.id, name } })).id;
}

async function project(o: Owner, title: string): Promise<string> {
  return (await o.h.db.project.create({ data: { ownerId: o.id, title } })).id;
}

async function task(o: Owner, projectId: string): Promise<string> {
  const row = await o.h.db.task.create({
    data: {
      ownerId: o.id, creatorType: 'USER', creatorId: o.id, title: 'a task of the project',
      projectId, completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  return row.id;
}

async function session(o: Owner, fields: Partial<Prisma.SessionUncheckedCreateInput>): Promise<string> {
  const row = await o.h.db.session.create({
    data: {
      ownerId: o.id, creatorId: o.id, title: 'a session', prompt: 'p',
      status: 'AWAITING_INPUT', dispatchOrigin: 'USER', ...fields,
    },
  });
  return row.id;
}

/** The project's coordinator, running in `workspaceId`: the session and both pointers to it. */
async function coordinator(
  o: Owner,
  projectId: string,
  workspaceId: string,
  fields: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const id = await session(o, { title: 'the coordinator', workspaceId, ...fields });
  await o.h.db.project.update({
    where: { id: projectId },
    data: { coordinatorSessionId: id, coordinatorWorkspaceId: workspaceId },
  });
  return id;
}

/** A one-shot judgment session the coordinator opened for the project (a JUDGMENT member). */
async function judgment(o: Owner, projectId: string, workspaceId: string): Promise<string> {
  const id = await session(o, { title: 'a judgment', workspaceId });
  await o.h.db.projectCoordinatorWake.create({
    data: {
      id: randomUUID(), projectId, sessionId: id, status: 'SESSION_OPENED', event: 'PROJECT_TASKS_SETTLED',
      subjectType: 'PROJECT', subjectId: projectId, subjectVersion: randomUUID(),
      idempotencyKey: `sessions-complete:${randomUUID()}`,
    },
  });
  return id;
}

/** The platform's container for one landing of the project's task (contract §2.9 LS1): a member,
 *  role LANDING, that is not the owner's to complete. */
async function landing(o: Owner, projectId: string): Promise<string> {
  const codebase = await o.h.db.projectCodebase.create({
    data: {
      ownerId: o.id, projectId,
      canonicalRepoUrl: `https://github.com/example/sessions-complete-${projectId}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  });
  const id = await session(o, {
    title: 'Land this', sessionKind: 'LANDING', provider: 'orbit', providerBuiltin: true, startsTaskWork: false,
  });
  await o.h.db.projectLanding.create({
    data: {
      id: randomUUID(), projectId, ownerId: o.id, codebaseId: codebase.id,
      subject: 'TASK', taskId: await task(o, projectId), episode: 1, sessionId: id,
    },
  });
  return id;
}

async function settle(o: Owner, projectId: string, status: 'DONE' | 'CANCELLED'): Promise<void> {
  await o.h.db.project.update({
    where: { id: projectId },
    data: status === 'DONE' ? { status, doneBy: 'OWNER', doneAt: new Date() } : { status },
  });
}

/** The press, as a client makes it: the project's public id in the path, and `headers` beside the login. */
function press(o: Owner, projectId: string, headers: Record<string, string> = {}): Promise<Reply> {
  return call(o.h.server, 'POST', `/api/projects/${uuidToBase62(projectId)}/sessions/complete`, o.bearer, undefined, headers);
}

/** What a Complete changes on a session, with the `end` control turns queued for its runner. */
async function snapshot(o: Owner, ids: string[]) {
  const rows = await o.h.db.session.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, status: true, endReason: true, cancelRequestedAt: true, finishedAt: true,
      completedAt: true, archivedAt: true, deletedAt: true,
    },
  });
  const ends = await o.h.db.conversationTurn.findMany({
    where: { sessionId: { in: ids }, kind: 'end' },
    select: { sessionId: true, status: true },
  });
  return new Map(rows.map((row) => [row.id, {
    ...row,
    endTurns: ends.filter((turn) => turn.sessionId === row.id).map((turn) => turn.status),
  }]));
}

async function assertUntouched(o: Owner, before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  assert.deepEqual(await snapshot(o, [...before.keys()]), before, 'a session that is not to move moved');
}

/** The ids `GET /sessions?projectId=` lists in `view`, the read the project's page makes. */
async function listed(o: Owner, projectId: string, view: 'open' | 'completed'): Promise<string[]> {
  const reply = await call(o.h.server, 'GET', `/api/sessions?projectId=${uuidToBase62(projectId)}&view=${view}`, o.bearer);
  assert.equal(reply.status, 200, reply.text);
  return (reply.json as Array<{ id: string }>).map((row) => row.id).sort();
}

const publicIds = (ids: string[]) => ids.map(uuidToBase62).sort();

test('DONE: the coordinator and every member still in Open, in every workspace, move to Completed the way Complete moves each, and the answer says how many', { skip, timeout: 300_000 }, async () => {
  const o = await owner('done');
  const here = await workspace(o, 'where the coordinator runs');
  const elsewhere = await workspace(o, 'another workspace');
  const projectId = await project(o, 'a project that is done');

  // The members still in Open, one of each role and run state.
  const coordinatorId = await coordinator(o, projectId, here);
  const running = await session(o, { title: 'running its task', workspaceId: elsewhere, status: 'RUNNING', taskId: await task(o, projectId) });
  const queued = await session(o, { title: 'queued for its task', workspaceId: elsewhere, status: 'PENDING', taskId: await task(o, projectId) });
  const finished = await session(o, { title: 'ran and finished', workspaceId: elsewhere, status: 'SUCCEEDED', contextTaskId: await task(o, projectId) });
  const child = await session(o, { title: 'a sub-agent of the coordinator', workspaceId: here, rootSessionId: coordinatorId, parentSessionId: coordinatorId, spawnDepth: 1 });
  const judged = await judgment(o, projectId, here);
  const live = [coordinatorId, running, child, judged];
  const members = [...live, queued, finished];

  // Members that are not in Open, a landing container, and sessions of another project and of none.
  const completedAt = new Date('2026-11-01T00:00:00Z');
  const alreadyCompleted = await session(o, { title: 'completed before', workspaceId: elsewhere, status: 'SUCCEEDED', taskId: await task(o, projectId), endReason: 'task_done', completedAt, archivedAt: completedAt });
  const inTrash = await session(o, { title: 'in Trash', workspaceId: elsewhere, contextTaskId: await task(o, projectId), deletedAt: new Date() });
  const landingId = await landing(o, projectId);
  const otherProject = await project(o, 'another project');
  const otherMember = await session(o, { title: 'a member of another project', workspaceId: here, taskId: await task(o, otherProject) });
  const nobodys = await session(o, { title: 'an ordinary session', workspaceId: here });
  const untouched = await snapshot(o, [alreadyCompleted, inTrash, landingId, otherMember, nobodys]);
  const finishedBefore = (await snapshot(o, [finished])).get(finished)!;

  await settle(o, projectId, 'DONE');
  assert.deepEqual(await listed(o, projectId, 'open'), publicIds(members), 'the Open members the press is about');

  const reply = await press(o, projectId);
  assert.equal(reply.status, 201, reply.text);
  assert.deepEqual(reply.json, { completed: members.length });

  const after = await snapshot(o, members);
  for (const id of members) {
    const row = after.get(id)!;
    assert.ok(row.completedAt, `${id} is not in Completed`);
    assert.deepEqual(row.archivedAt, row.completedAt, `${id}: the compatibility mirror`);
    assert.equal(row.deletedAt, null);
  }
  // Still running or waiting for input: ended as Complete ends one — the end asked of its runner, an
  // `end` control turn queued for it, and the reason recorded.
  for (const id of live) {
    const row = after.get(id)!;
    assert.equal(row.endReason, 'completed', `${id} end reason`);
    assert.ok(row.cancelRequestedAt, `${id}: no end was asked of its runner`);
    assert.deepEqual(row.endTurns, ['PENDING'], `${id}: one end turn queued`);
  }
  // Never ran: settled at once, as Complete settles a queued session.
  const settledQueued = after.get(queued)!;
  assert.equal(settledQueued.status, 'CANCELLED');
  assert.equal(settledQueued.endReason, 'completed');
  assert.ok(settledQueued.finishedAt);
  assert.deepEqual(settledQueued.endTurns, []);
  // Already over: only filed, its run and its reason left as they were.
  assert.deepEqual(
    { ...after.get(finished)!, completedAt: null, archivedAt: null },
    { ...finishedBefore, completedAt: null, archivedAt: null },
  );

  await assertUntouched(o, untouched);
  assert.deepEqual(await listed(o, projectId, 'open'), [], 'nothing of the project is left in Open');
  assert.deepEqual(
    await listed(o, projectId, 'completed'),
    publicIds([...members, alreadyCompleted]),
    'the project\'s Completed view holds what moved beside what was there',
  );

  // Pressed again, nothing is left to move.
  const again = await press(o, projectId);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json, { completed: 0 });
  assert.deepEqual(await snapshot(o, members), after, 'a second press changed what the first moved');
});

test('CANCELLED: the coordinator and the members still in Open move too, wherever they run', { skip, timeout: 300_000 }, async () => {
  const o = await owner('cancelled');
  const here = await workspace(o, 'where the coordinator runs');
  const elsewhere = await workspace(o, 'another workspace');
  const projectId = await project(o, 'a project called off');
  const coordinatorId = await coordinator(o, projectId, here);
  const member = await session(o, { title: 'a task run elsewhere', workspaceId: elsewhere, taskId: await task(o, projectId) });
  await settle(o, projectId, 'CANCELLED');

  const reply = await press(o, projectId);
  assert.equal(reply.status, 201, reply.text);
  assert.deepEqual(reply.json, { completed: 2 });
  for (const [id, row] of await snapshot(o, [coordinatorId, member])) {
    assert.ok(row.completedAt, `${id} is not in Completed`);
    assert.equal(row.endReason, 'completed');
  }
  assert.deepEqual(await listed(o, projectId, 'open'), []);
});

test('an OPEN project is refused PROJECT_STILL_OPEN, and nothing moves', { skip, timeout: 300_000 }, async () => {
  const o = await owner('open');
  const here = await workspace(o, 'where the coordinator runs');
  const elsewhere = await workspace(o, 'another workspace');
  const projectId = await project(o, 'a project still running');
  const coordinatorId = await coordinator(o, projectId, here);
  const member = await session(o, { title: 'a task run elsewhere', workspaceId: elsewhere, status: 'RUNNING', taskId: await task(o, projectId) });
  const before = await snapshot(o, [coordinatorId, member]);

  const reply = await press(o, projectId);
  assert.equal(reply.status, 409, reply.text);
  assert.equal(reply.json.code, 'PROJECT_STILL_OPEN');
  await assertUntouched(o, before);

  // Reopened after it was done, it is OPEN again, and refused again.
  await settle(o, projectId, 'DONE');
  await o.h.db.project.update({ where: { id: projectId }, data: { status: 'OPEN', doneBy: null, doneAt: null } });
  const reopened = await press(o, projectId);
  assert.equal(reopened.status, 409, reopened.text);
  assert.equal(reopened.json.code, 'PROJECT_STILL_OPEN');
  await assertUntouched(o, before);
});

test("another owner's finished project is a 404, as one that does not exist is, and nothing of theirs moves", { skip, timeout: 300_000 }, async () => {
  const o = await owner('asker');
  const stranger = await owner('stranger');
  const theirWorkspace = await workspace(stranger, 'their workspace');
  const theirProject = await project(stranger, 'their finished project');
  const theirCoordinator = await coordinator(stranger, theirProject, theirWorkspace);
  const theirMember = await session(stranger, { title: 'their task run', workspaceId: theirWorkspace, taskId: await task(stranger, theirProject) });
  await settle(stranger, theirProject, 'DONE');
  const before = await snapshot(stranger, [theirCoordinator, theirMember]);

  for (const projectId of [theirProject, randomUUID()]) {
    const reply = await press(o, projectId);
    assert.equal(reply.status, 404, reply.text);
  }
  await assertUntouched(stranger, before);

  // Their own press moves them, so the 404 above was about whose project it is.
  const theirs = await press(stranger, theirProject);
  assert.equal(theirs.status, 201, theirs.text);
  assert.deepEqual(theirs.json, { completed: 2 });
});

test('a request carrying a session header is refused PROJECT_SESSIONS_COMPLETE_OWNER_ONLY, and nothing moves', { skip, timeout: 300_000 }, async () => {
  const o = await owner('agent');
  const here = await workspace(o, 'where the coordinator runs');
  const projectId = await project(o, 'a project that is done');
  const coordinatorId = await coordinator(o, projectId, here);
  const member = await session(o, { title: 'a task run', workspaceId: here, taskId: await task(o, projectId) });
  await settle(o, projectId, 'DONE');
  const before = await snapshot(o, [coordinatorId, member]);

  // The coordinator itself asking, by either spelling of its id: an agent session's request.
  for (const header of [uuidToBase62(coordinatorId), coordinatorId]) {
    const reply = await press(o, projectId, { 'x-orbit-session-id': header });
    assert.equal(reply.status, 403, reply.text);
    assert.equal(reply.json.code, 'PROJECT_SESSIONS_COMPLETE_OWNER_ONLY');
  }
  await assertUntouched(o, before);

  // The same login without the header is the owner's press.
  const owners = await press(o, projectId);
  assert.equal(owners.status, 201, owners.text);
  assert.deepEqual(owners.json, { completed: 2 });
});
