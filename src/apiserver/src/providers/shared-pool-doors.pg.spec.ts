/**
 * docs/codex-shared-pool-design.md §2.5 on real PostgreSQL, one case per row and every cell in it — with
 * "account" read as "key" throughout (migration 0321):
 *
 *   action                                                      admin           member            not in it
 *   (1) see the pool, pick it, open a session on it             yes             yes               as if it did not exist
 *   (2) put a key of one's own in                               yes             while the rule is on   no
 *   (3) remove a key                                            anyone's        only one's own    no
 *   (4) change the rules, add and remove people, delete it      yes             no                no
 *   (5) leave (one's own keys go too)                           — (refused)     yes               — (not found)
 *
 * Row (1) is asserted at every door that accepts a provider slug, not only the pool page: opening a
 * session, switching a live one, reviving an ended one, pinning a task (created and edited), answering an
 * @mention of an agent that last ran on the pool, and the provider list an agent reads. For the person
 * not in the pool each door is asserted on what it RESOLVED — the row it wrote or did not write — before
 * whether it refused. Every refusal is paired with the same request made by someone the table allows,
 * which has to go through, so a door that refused everything could not pass.
 *
 * Everything between the rows and the answers is production code: the shared-pool and runner-provider
 * controllers behind real HTTP, with the global pipe, interceptors and filter main.ts installs;
 * SharedPoolsService, ProvidersService, SessionsService, TasksService and QueueService. Only the check of a
 * person's signed token is a stand-in. It only adds rows, and refuses to run anywhere but the disposable
 * server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';
import { SharedPoolsController } from './shared-pools.controller';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
// The service encrypts the keys it is handed; any secret does in a throwaway database.
process.env.PROVIDER_SECRET_KEY ??= 'shared-pool-doors-spec';

/** An OpenAI project key's shape. Nothing here sends it anywhere. */
const openaiKey = () => `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** A person, with a runner and an agent (workspace) of their own bound to it. */
interface Person {
  name: string;
  id: string;
  email: string;
  runnerId: string;
  /** The runner's bearer token, for the runner-facing provider list. */
  runnerToken: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerToken = `shared-pool-doors-${randomUUID()}`;
  const email = `${name}-${id}@shared-pool-doors.invalid`;
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: sha256(runnerToken),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, email, runnerId, runnerToken, workspaceId };
}

/** Another agent of `owner`'s, on their runner — a project of its own, with its own history. */
async function agentOf(db: PrismaClient, owner: Person, label: string): Promise<string> {
  const workspaceId = randomUUID();
  await db.workspace.create({
    data: { id: workspaceId, ownerId: owner.id, runnerId: owner.runnerId, name: label, enabled: true, workDir: `/tmp/${label}` },
  });
  return workspaceId;
}

/** A session row written straight into the table: a project's history, an engine up, or a run that ended —
 *  and the only way the person not in the pool gets its slug onto a row, since every door refuses to. */
async function sessionOn(
  db: PrismaClient,
  owner: Person,
  provider: string,
  status: RunStatus,
  workspaceId = owner.workspaceId,
): Promise<string> {
  const builtin = provider === 'codex' || provider === 'claude';
  const session = await db.session.create({
    data: {
      title: 'shared pool doors',
      prompt: 'hello',
      status,
      ownerId: owner.id,
      creatorId: owner.id,
      workspaceId,
      assignedRunnerId: owner.runnerId,
      provider,
      providerBuiltin: builtin,
      model: 'gpt-5.5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      numTurns: 1,
      runtimeSessionId: randomUUID(),
      startedAt: new Date(),
    },
    select: { id: true },
  });
  return session.id;
}

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

/** What a door did with a request, read only after what it wrote. */
async function settle(request: Promise<unknown>): Promise<'went through' | 'refused'> {
  try {
    await request;
    return 'went through';
  } catch {
    return 'refused';
  }
}

const doorsOver: { pools: unknown; providers: unknown; prisma: unknown } = { pools: null, providers: null, prisma: null };

@Module({
  controllers: [SharedPoolsController, RunnerProvidersController],
  providers: [
    { provide: SharedPoolsService, useFactory: () => doorsOver.pools },
    { provide: ProvidersService, useFactory: () => doorsOver.providers },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    JwtAuthGuard,
    RunnerAuthGuard,
    Reflector,
    // A person is whoever their bearer names: what a verified token would say, with the user id as the token.
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class Doors {}

async function openDoors() {
  const app = await NestFactory.create(Doors, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

const suite = URL ? test : test.skip;

suite('a shared pool, door by door: every cell of §2.5, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const pools = new SharedPoolsService(prisma, realtime, providers);
  doorsOver.pools = pools;
  doorsOver.providers = providers;
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    await db.$disconnect();
    await client.end();
  });

  /** One HTTP exchange, as `bearer` (a person's id, or a runner's token). */
  async function ask(bearer: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    const response = await fetch(`${doors.base}/api/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, text, json, said: `${method} /api/${path} → ${response.status}: ${text}` };
  }
  /** `ask`, when the answer has to be this status. */
  async function call(expected: number, ...args: Parameters<typeof ask>) {
    const answer = await ask(...args);
    assert.equal(answer.status, expected, answer.said);
    return answer;
  }

  const ann = await person(db, 'Ann'); // made the pool: always an admin
  const adam = await person(db, 'Adam'); // made an admin by Ann
  const mia = await person(db, 'Mia'); // a member
  const max = await person(db, 'Max'); // a member
  const otto = await person(db, 'Otto'); // in no pool

  const created = await call(201, ann.id, 'POST', 'providers/shared-pools', { label: 'Team Codex' });
  const pool = { id: toUuid(String(created.json.id)), slug: String(created.json.slug) };
  const at = `providers/shared-pools/${pool.id}`;
  await call(201, ann.id, 'POST', `${at}/people`, { email: adam.email, role: 'ADMIN' });
  await call(201, ann.id, 'POST', `${at}/people`, { email: mia.email });
  await call(201, ann.id, 'POST', `${at}/people`, { email: max.email });
  // A key that can run, so every door below that takes the pool takes it for what it is.
  await call(201, ann.id, 'POST', `${at}/keys`, { label: 'Ann · team', apiKey: openaiKey() });

  const roleOf = async (who: Person) =>
    (await db.providerPoolPerson.findUnique({ where: { poolId_userId: { poolId: pool.id, userId: who.id } } }))?.role ?? null;
  const keysOf = (who: Person) => db.poolApiKey.findMany({ where: { poolId: pool.id, contributorId: who.id }, select: { id: true } });
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { provider: true, status: true } });

  await t.test('the pool as made: Ann its creator and an admin, Adam an admin, Mia and Max members, Otto not in it', async () => {
    assert.deepEqual(
      [await roleOf(ann), await roleOf(adam), await roleOf(mia), await roleOf(max), await roleOf(otto)],
      ['ADMIN', 'ADMIN', 'MEMBER', 'MEMBER', null],
    );
    const row = await db.providerPool.findUniqueOrThrow({ where: { id: pool.id } });
    assert.deepEqual(
      { engine: row.engine, shared: row.shared, ownerId: row.ownerId, membersCanAdd: row.membersCanAdd, ownKeyFirst: row.ownKeyFirst },
      { engine: 'codex', shared: true, ownerId: ann.id, membersCanAdd: true, ownKeyFirst: true },
    );
  });

  await t.test('(1) see it and pick it — admin ✓, member ✓; for a person not in it the pool does not exist', async () => {
    for (const [who, role] of [[ann, 'ADMIN'], [mia, 'MEMBER']] as const) {
      const listed = (await call(200, who.id, 'GET', 'providers/shared-pools')).json as Array<{ slug: string; viewerRole: string }>;
      assert.deepEqual(listed.map((p) => [p.slug, p.viewerRole]), [[pool.slug, role]], `${who.name}'s list`);
      assert.equal((await call(200, who.id, 'GET', at)).json.viewerRole, role);
      // The list an agent of theirs reads to learn which slugs it may pass as `provider`.
      const usable = (await call(200, who.runnerToken, 'GET', 'runner/providers')).json as Array<{ slug: string; runtime: string }>;
      assert.deepEqual(usable.filter((p) => p.slug === pool.slug), [{ slug: pool.slug, label: 'Team Codex', runtime: 'codex', engines: ['codex'], builtin: false }]);
    }
    assert.deepEqual((await call(200, otto.id, 'GET', 'providers/shared-pools')).json, []);
    const page = await call(404, otto.id, 'GET', at);
    // Not "forbidden": the answer for a pool one is not in is the answer for no pool at all.
    assert.equal((await call(404, otto.id, 'GET', `providers/shared-pools/${randomUUID()}`)).json.message, page.json.message);
    const his = (await call(200, otto.runnerToken, 'GET', 'runner/providers')).json as Array<{ slug: string }>;
    assert.equal(his.some((p) => p.slug === pool.slug), false, "the pool is on Otto's agent's provider list");
  });

  await t.test('(1) open a session on it — admin ✓, member ✓, a person not in it: no session is written', async () => {
    for (const who of [ann, mia]) {
      const opened = await sessions.create(who.id, { prompt: 'hello', title: 'on the pool', workspaceId: who.workspaceId, provider: pool.slug });
      assert.deepEqual(await recorded(opened.id), { provider: pool.slug, status: RunStatus.PENDING });
    }
    const attempt = await settle(
      sessions.create(otto.id, { prompt: 'hello', title: 'on their pool', workspaceId: otto.workspaceId, provider: pool.slug }),
    );
    assert.equal(await db.session.count({ where: { ownerId: otto.id, provider: pool.slug } }), 0, 'a session of his was written on the pool');
    assert.equal(attempt, 'refused');
  });

  await t.test('(1) switch a live session onto it, or revive an ended one there — member ✓; a person not in it: the session stays where it was', async () => {
    const live = await sessionOn(db, mia, 'codex', RunStatus.AWAITING_INPUT);
    await sessions.updateConfig(mia.id, live, { provider: pool.slug });
    assert.equal((await recorded(live)).provider, pool.slug);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: live, kind: 'reload' } }), 1);
    const ended = await sessionOn(db, mia, 'codex', RunStatus.FAILED);
    await sessions.resume(mia.id, ended, { clientTurnId: randomUUID(), content: 'again', provider: pool.slug });
    assert.deepEqual(await recorded(ended), { provider: pool.slug, status: RunStatus.PENDING });

    const hisLive = await sessionOn(db, otto, 'codex', RunStatus.AWAITING_INPUT);
    const switched = await settle(sessions.updateConfig(otto.id, hisLive, { provider: pool.slug }));
    assert.equal((await recorded(hisLive)).provider, 'codex', 'his session was moved onto the pool');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: hisLive } }), 0, 'a reload was queued onto the pool');
    const hisEnded = await sessionOn(db, otto, 'codex', RunStatus.FAILED);
    const revived = await settle(sessions.resume(otto.id, hisEnded, { clientTurnId: randomUUID(), content: 'again', provider: pool.slug }));
    assert.deepEqual(await recorded(hisEnded), { provider: 'codex', status: RunStatus.FAILED }, 'his session was revived onto the pool');
    assert.deepEqual({ switched, revived }, { switched: 'refused', revived: 'refused' });
  });

  await t.test('(1) pin a task to it, created or edited — member ✓; a person not in it: no task names it', async () => {
    const pinned = await tasks.create(mia.id, { title: `pinned ${randomUUID()}`, provider: pool.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, pool.slug);
    const later = await tasks.create(mia.id, { title: `pinned later ${randomUUID()}`, ...TASK_CHECK } as never);
    await tasks.update(mia.id, later.id, { provider: pool.slug });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: later.id } })).provider, pool.slug);

    const created_ = await settle(tasks.create(otto.id, { title: `his ${randomUUID()}`, provider: pool.slug, ...TASK_CHECK } as never));
    const his = await tasks.create(otto.id, { title: `his later ${randomUUID()}`, ...TASK_CHECK } as never);
    const repinned = await settle(tasks.update(otto.id, his.id, { provider: pool.slug }));
    assert.deepEqual(await db.task.findMany({ where: { ownerId: otto.id, provider: pool.slug }, select: { id: true } }), []);
    assert.deepEqual({ created: created_, repinned }, { created: 'refused', repinned: 'refused' });
  });

  await t.test('(1) an @mention of an agent that last ran on it is answered there — member ✓; a person not in it: held, no session', async () => {
    const hers = await agentOf(db, mia, 'mia-mentioned');
    await sessionOn(db, mia, pool.slug, RunStatus.SUCCEEDED, hers);
    // A history no door writes for him — put there by hand, as a stale or forged one would be.
    const his = await agentOf(db, otto, 'otto-mentioned');
    const forged = await sessionOn(db, otto, pool.slug, RunStatus.SUCCEEDED, his);
    const mention = async (owner: Person, agent: string) => {
      const task = await tasks.create(owner.id, { title: `mentions ${randomUUID()}`, ...TASK_CHECK } as never);
      return (await db.taskComment.create({
        data: { taskId: task.id, authorType: 'USER', authorId: owner.id, body: 'have a look', mentions: [agent], mentionDeliveryVersion: 1 },
        select: { id: true },
      })).id;
    };
    const toHer = await mention(mia, hers);
    const toHim = await mention(otto, his);

    await tasks.deliverMentions();

    const delivery = (commentId: string) =>
      db.taskCommentMentionDelivery.findFirstOrThrow({
        where: { commentId },
        select: { status: true, errorCode: true, targetSessionId: true },
      });
    const answered = await delivery(toHer);
    assert.equal(answered.status, 'SESSION_CREATED', JSON.stringify(answered));
    assert.equal((await recorded(answered.targetSessionId!)).provider, pool.slug);

    const held = await delivery(toHim);
    assert.deepEqual(
      (await db.session.findMany({ where: { workspaceId: his }, select: { id: true } })).map((s) => s.id),
      [forged],
      'the mention opened a session on the pool for him',
    );
    assert.equal(held.targetSessionId, null);
    assert.equal(held.errorCode, 'PROVIDER_UNAVAILABLE');
  });

  await t.test("(2) put a key of one's own in — admin ✓ always, member ✓ only while the rule is on, a person not in it: not found", async () => {
    const answer = await call(201, mia.id, 'POST', `${at}/keys`, { label: 'Mia', apiKey: openaiKey() });
    assert.equal((await keysOf(mia)).length, 1);
    assert.equal((answer.json.keys as Array<{ contributor: { you: boolean } }>).filter((k) => k.contributor.you).length, 1);

    await call(200, adam.id, 'PATCH', at, { membersCanAdd: false });
    const refused = await call(403, max.id, 'POST', `${at}/keys`, { label: 'Max', apiKey: openaiKey() });
    assert.match(refused.json.message, /admins/);
    assert.equal((await keysOf(max)).length, 0, 'a member put a key in while the rule was off');
    await call(201, adam.id, 'POST', `${at}/keys`, { label: 'Adam', apiKey: openaiKey() });
    assert.equal((await keysOf(adam)).length, 1, 'an admin could not put a key in while the rule was off');

    await call(404, otto.id, 'POST', `${at}/keys`, { label: 'Otto', apiKey: openaiKey() });
    assert.equal((await keysOf(otto)).length, 0);
    await call(200, adam.id, 'PATCH', at, { membersCanAdd: true });
    await call(201, max.id, 'POST', `${at}/keys`, { label: 'Max', apiKey: openaiKey() });
    assert.equal((await keysOf(max)).length, 1);
  });

  await t.test("(3) remove a key — admin: anyone's ✓; member: their own ✓, somebody else's ✗; a person not in it: not found", async () => {
    const [maxKey] = await keysOf(max);
    const [miaKey] = await keysOf(mia);
    const [annKey] = await keysOf(ann);
    await call(403, mia.id, 'DELETE', `${at}/keys/${annKey.id}`);
    await call(404, otto.id, 'DELETE', `${at}/keys/${annKey.id}`);
    assert.equal((await keysOf(ann)).length, 1, "a member or an outsider removed Ann's key");

    await call(200, mia.id, 'DELETE', `${at}/keys/${miaKey.id}`);
    assert.equal((await keysOf(mia)).length, 0);
    await call(200, adam.id, 'DELETE', `${at}/keys/${maxKey.id}`);
    assert.equal((await keysOf(max)).length, 0, "an admin could not remove a member's key");
  });

  await t.test('(4) change the rules — admin ✓; member ✗; a person not in it: not found', async () => {
    const rules = async () => {
      const row = await db.providerPool.findUniqueOrThrow({
        where: { id: pool.id },
        select: { label: true, membersCanAdd: true, membersCanAddAccounts: true, ownKeyFirst: true },
      });
      return row;
    };
    const before = await rules();
    await call(403, mia.id, 'PATCH', at, { ownKeyFirst: false, membersCanAdd: false, label: 'Mine now' });
    await call(404, otto.id, 'PATCH', at, { ownKeyFirst: false, membersCanAdd: false, label: 'Mine now' });
    assert.deepEqual(await rules(), before);
    const changed = await call(200, adam.id, 'PATCH', at, { ownKeyFirst: false });
    assert.equal(changed.json.ownKeyFirst, false);
    assert.deepEqual(await rules(), { ...before, ownKeyFirst: false });
    // The account rule is its own (migration 0371): an admin changes it, a member cannot, and neither rule
    // moves the other.
    await call(403, mia.id, 'PATCH', at, { membersCanAddAccounts: false });
    await call(200, adam.id, 'PATCH', at, { membersCanAddAccounts: false });
    assert.deepEqual(await rules(), { ...before, ownKeyFirst: false, membersCanAddAccounts: false });
    assert.equal((await call(200, ann.id, 'PATCH', at, { ownKeyFirst: true, membersCanAddAccounts: true })).json.membersCanAddAccounts, true);
    assert.deepEqual(await rules(), before);
  });

  await t.test('(4) add and remove people, and say who is an admin — admin ✓; member ✗; a person not in it: not found', async () => {
    const newcomer = await person(db, 'Nia');
    await call(403, mia.id, 'POST', `${at}/people`, { email: newcomer.email });
    await call(404, otto.id, 'POST', `${at}/people`, { email: newcomer.email });
    assert.equal(await roleOf(newcomer), null);
    await call(201, adam.id, 'POST', `${at}/people`, { email: newcomer.email });
    assert.equal(await roleOf(newcomer), 'MEMBER');

    await call(403, mia.id, 'PATCH', `${at}/people/${max.id}`, { role: 'ADMIN' });
    await call(404, otto.id, 'PATCH', `${at}/people/${max.id}`, { role: 'ADMIN' });
    assert.equal(await roleOf(max), 'MEMBER');
    await call(200, adam.id, 'PATCH', `${at}/people/${max.id}`, { role: 'ADMIN' });
    assert.equal(await roleOf(max), 'ADMIN');
    await call(200, ann.id, 'PATCH', `${at}/people/${max.id}`, { role: 'MEMBER' });
    // The pool's creator stays an admin, whoever asks.
    await call(403, adam.id, 'PATCH', `${at}/people/${ann.id}`, { role: 'MEMBER' });
    assert.equal(await roleOf(ann), 'ADMIN');

    await call(403, mia.id, 'DELETE', `${at}/people/${newcomer.id}`);
    await call(404, otto.id, 'DELETE', `${at}/people/${newcomer.id}`);
    assert.equal(await roleOf(newcomer), 'MEMBER');
    await call(403, adam.id, 'DELETE', `${at}/people/${ann.id}`);
    assert.equal(await roleOf(ann), 'ADMIN');
    // Removed, a person takes their keys with them.
    await call(201, newcomer.id, 'POST', `${at}/keys`, { label: 'Nia', apiKey: openaiKey() });
    await call(200, adam.id, 'DELETE', `${at}/people/${newcomer.id}`);
    assert.equal(await roleOf(newcomer), null);
    assert.equal((await keysOf(newcomer)).length, 0);
    await call(404, newcomer.id, 'GET', at);
  });

  await t.test('(4) delete the pool — admin ✓; member ✗; a person not in it: not found', async () => {
    const scratch = await call(201, ann.id, 'POST', 'providers/shared-pools', { label: 'Scratch' });
    const scratchId = toUuid(String(scratch.json.id));
    const there = `providers/shared-pools/${scratchId}`;
    await call(201, ann.id, 'POST', `${there}/people`, { email: adam.email, role: 'ADMIN' });
    await call(201, ann.id, 'POST', `${there}/people`, { email: mia.email });
    await call(201, mia.id, 'POST', `${there}/keys`, { label: 'Mia', apiKey: openaiKey() });

    await call(403, mia.id, 'DELETE', there);
    await call(404, otto.id, 'DELETE', there);
    assert.equal(await db.providerPool.count({ where: { id: scratchId } }), 1);
    await call(200, adam.id, 'DELETE', there);
    assert.equal(await db.providerPool.count({ where: { id: scratchId } }), 0);
    assert.equal(await db.providerPoolPerson.count({ where: { poolId: scratchId } }), 0);
    assert.equal(await db.poolApiKey.count({ where: { poolId: scratchId } }), 0);
    await call(404, mia.id, 'GET', there);
  });

  await t.test('(5) leave — member ✓, and their keys go with them; an admin does not leave; a person not in it: not found', async () => {
    await call(201, mia.id, 'POST', `${at}/keys`, { label: 'Mia again', apiKey: openaiKey() });
    assert.equal((await keysOf(mia)).length, 1);
    await call(201, mia.id, 'POST', `${at}/leave`);
    assert.equal(await roleOf(mia), null);
    assert.equal((await keysOf(mia)).length, 0, "Mia's key stayed behind her");
    await call(404, mia.id, 'GET', at);

    for (const admin of [ann, adam]) {
      await call(403, admin.id, 'POST', `${at}/leave`);
      assert.equal(await roleOf(admin), 'ADMIN');
    }
    await call(404, otto.id, 'POST', `${at}/leave`);
    assert.equal(await roleOf(otto), null);
  });
});
