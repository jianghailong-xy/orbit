import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersion } from './open-list-version';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * The Open list answers 304 from `readOpenListVersion` without building the list, so the version
 * must move whenever the list would read differently. Each case changes one thing the list row
 * shows — through Prisma, through raw SQL that leaves `updated_at` alone, or only by the clock
 * passing a threshold — and asserts that the list really changed (so the case means something)
 * and that the version, and the ETag the controller sends, changed with it. The door itself is
 * driven too: a matching If-None-Match is answered without the list being read.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

interface Fixture {
  db: PrismaClient;
  sessions: SessionsService;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  /** A conversation mid-turn, the kind that can hold an approval card. */
  sessionId: string;
  /** A second, settled conversation. */
  otherId: string;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const prisma = db as unknown as PrismaService;
  const sessions = new SessionsService(
    prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const otherId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `olv-${ownerId}@open-list-version.invalid`, name: 'olv', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olv-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'olv-workspace', enabled: true } });
  for (const [id, status] of [[sessionId, RunStatus.RUNNING], [otherId, RunStatus.SUCCEEDED]] as const) {
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: `olv ${id}`,
        prompt: 'olv', provider: 'claude', providerBuiltin: true, status, startedAt: new Date(),
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
  }
  return { db, sessions, ownerId, runnerId, workspaceId, sessionId, otherId };
}

/** The Open list as the clients receive it. */
async function openList(f: Fixture): Promise<string> {
  return JSON.stringify(await f.sessions.list(f.ownerId, { view: 'open' }));
}

/** One GET of the Open list through the controller, as the clients poll it. */
async function poll(f: Fixture, ifNoneMatch?: string) {
  let listed = 0;
  const service = new Proxy(f.sessions, {
    get(target, key, receiver) {
      if (key === 'list') {
        return (...args: Parameters<SessionsService['list']>) => {
          listed += 1;
          return target.list(...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const controller = new SessionsController(service, {} as never, {} as never, {} as never, {} as never, {} as never);
  const headers: Record<string, string> = {};
  let status = 200;
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: (code: number) => { status = code; return res; },
    end: () => res,
  };
  const body = await controller.list(
    { userId: f.ownerId } as never,
    undefined, undefined, undefined, undefined, 'open', undefined, undefined, undefined, ifNoneMatch, res as never,
  );
  return { etag: headers.etag, body, listed, status };
}

/** Assert that `change` moves the list, the version and the ETag, and that an unchanged poll is a hit. */
async function changes(f: Fixture, label: string, change: () => Promise<unknown>): Promise<void> {
  const before = await poll(f);
  const listBefore = await openList(f);
  const hit = await poll(f, before.etag);
  assert.equal(hit.status, 304, `${label}: an unchanged list was not answered from the version`);
  assert.equal(hit.body, undefined);
  assert.equal(hit.listed, 0, `${label}: an unchanged list was built anyway`);
  await change();
  assert.notEqual(await openList(f), listBefore, `${label}: the change did not reach the list (the case proves nothing)`);
  const after = await poll(f, before.etag);
  assert.notEqual(after.etag, before.etag, `${label}: the list changed but its ETag did not`);
  assert.equal(after.status, 200, `${label}: a changed list was answered 304`);
  assert.equal(after.listed, 1, `${label}: a changed list was not rebuilt`);
  assert.ok(after.body, `${label}: a changed list was not sent`);
}

test('an unchanged Open list keeps its version and is answered without being read', { skip }, async (t) => {
  const f = await fixture(t);
  const first = await poll(f);
  assert.match(first.etag, /^W\/"ol1-[A-Za-z0-9_-]+"$/);
  assert.equal(first.listed, 1);
  assert.equal(await readOpenListVersion(f.db as never, f.ownerId), await readOpenListVersion(f.db as never, f.ownerId));
  const second = await poll(f, first.etag);
  assert.equal(second.etag, first.etag);
  assert.equal(second.status, 304);
  assert.equal(second.listed, 0);
  assert.equal(second.body, undefined);
});

test('every source the Open list row shows moves its version', { skip }, async (t) => {
  const f = await fixture(t);
  const { db } = f;
  await changes(f, 'session title (Prisma)', () =>
    db.session.update({ where: { id: f.sessionId }, data: { title: 'renamed' } }));
  await changes(f, 'retry_at by raw SQL, updated_at untouched', () =>
    db.$executeRaw`UPDATE session SET retry_at = now() + interval '1 hour' WHERE id = ${f.otherId}::uuid`);
  await changes(f, 'a new session', () => db.session.create({
    data: {
      ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.workspaceId, title: 'new', prompt: 'new',
      status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  }));
  await changes(f, 'a session completed', () =>
    db.session.update({ where: { id: f.otherId }, data: { completedAt: new Date() } }));
  await changes(f, 'workspace renamed', () =>
    db.workspace.update({ where: { id: f.workspaceId }, data: { name: 'renamed workspace' } }));
  await changes(f, 'runner heartbeat', () =>
    db.runner.update({ where: { id: f.runnerId }, data: { lastHeartbeatAt: new Date(Date.now() + 1_000) } }));
  const tag = await db.sessionTag.create({ data: { ownerId: f.ownerId, name: 'olv-tag', color: '#ff0000' } });
  await changes(f, 'tag linked', () => db.sessionTagLink.create({ data: { sessionId: f.sessionId, tagId: tag.id } }));
  await changes(f, 'tag renamed', () => db.sessionTag.update({ where: { id: tag.id }, data: { name: 'olv-tag-2' } }));
  await changes(f, 'pending approval', () => db.approval.create({
    data: { sessionId: f.sessionId, toolName: 'Bash', input: {}, toolUseId: `toolu_${randomUUID()}` },
  }));
  await changes(f, 'share link', () => db.shareLink.create({
    data: { ownerId: f.ownerId, sessionId: f.sessionId, token: randomUUID() },
  }));
  const task = await db.task.create({
    data: {
      ownerId: f.ownerId, title: 'olv task', creatorType: 'USER', creatorId: f.ownerId,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await changes(f, 'session given a task', () =>
    db.session.update({ where: { id: f.sessionId }, data: { taskId: task.id } }));
  await changes(f, 'task renamed', () => db.task.update({ where: { id: task.id }, data: { title: 'olv task 2' } }));
  const project = await db.project.create({ data: { ownerId: f.ownerId, title: 'olv project' } });
  await changes(f, 'session made a coordinator', () =>
    db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: f.sessionId } }));
  await changes(f, 'project renamed', () =>
    db.project.update({ where: { id: project.id }, data: { title: 'olv project 2' } }));
  // A merge approval on the coordinator's row names the project's main branch
  // (`ownerItems[].mainBranch`), read off its binding: binding a repository and moving its main
  // branch both change the row.
  const now = new Date();
  await changes(f, 'owner item', () => db.projectOpenItem.create({
    data: {
      projectId: project.id, ownerId: f.ownerId, kind: 'PROMOTION_APPROVAL', state: 'OPEN', assignee: 'OWNER',
      assigneeReason: 'DEFAULT', dedupeKey: `olv:${project.id}`, title: 'Approve merge to main',
      payload: {}, waitingSince: now, assignedAt: now,
    },
  }));
  await changes(f, 'repository bound', () => db.projectCodebase.create({
    data: {
      ownerId: f.ownerId, projectId: project.id, canonicalRepoUrl: `https://github.com/example/olv-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  }));
  await changes(f, 'main branch moved by raw SQL, updated_at untouched', () =>
    db.$executeRaw`UPDATE project_codebase SET upstream_ref = 'refs/heads/master',
      integration_ref = 'refs/heads/master' WHERE project_id = ${project.id}::uuid`);
});

test('a threshold the clock passes moves the version with no write', { skip }, async (t) => {
  const f = await fixture(t);
  // The runner's heartbeat ages out on the JS clock the capability check uses.
  const now = Date.now();
  assert.notEqual(
    await readOpenListVersion(f.db as never, f.ownerId, now),
    await readOpenListVersion(f.db as never, f.ownerId, now + 91_000),
    'a runner going offline by the clock alone did not move the version',
  );
  // A background job going quiet, which takes it out of the row's runningBgJobCount.
  await f.db.$executeRaw`UPDATE session SET running_bg_jobs = ARRAY['bgj_quiet'],
    running_bg_job_activity = ${JSON.stringify({ bgj_quiet: now - 599_000 })}::jsonb WHERE id = ${f.sessionId}::uuid`;
  assert.notEqual(
    await readOpenListVersion(f.db as never, f.ownerId, now),
    await readOpenListVersion(f.db as never, f.ownerId, now + 2_000),
    'a job going quiet by the clock alone did not move the version',
  );
  // A share link expiring on Postgres' clock, which `listRows` decides `shared` on.
  await f.db.$executeRaw`INSERT INTO share_link (id, owner_id, session_id, token, expires_at)
    VALUES (gen_random_uuid(), ${f.ownerId}::uuid, ${f.sessionId}::uuid, ${randomUUID()}, now() + interval '1500 milliseconds')`;
  const before = await poll(f);
  const listBefore = await openList(f);
  await sleep(2_000);
  assert.notEqual(await openList(f), listBefore, 'the link did not expire in the list');
  const after = await poll(f, before.etag);
  assert.notEqual(after.etag, before.etag, 'an expired share link left the ETag alone');
  assert.equal(after.listed, 1);
});

test("another account's writes leave this account's version alone", { skip }, async (t) => {
  const mine = await fixture(t);
  const theirs = await fixture(t);
  const before = await readOpenListVersion(mine.db as never, mine.ownerId);
  await theirs.db.session.update({ where: { id: theirs.sessionId }, data: { title: 'theirs' } });
  assert.equal(await readOpenListVersion(mine.db as never, mine.ownerId), before);
});
