/**
 * What the /providers page reads about account pools, over real HTTP on real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/provider-pool-usage.pg.spec.ts
 *
 * - GET /api/providers/pools carries every member's own quota (its PlanUsageSnapshot, read with that
 *   member's credential), where each member stands, which member a session starting now would run on,
 *   and — once every member that can run is spent — the earliest of their resets.
 * - GET /api/providers/mine says, row by row, why a provider may not join a pool.
 * - None of it carries a key: each response is searched, as text, for the `sk-ant` prefix every
 *   Anthropic credential starts with.
 *
 * Real: the controller, the validation pipe and public-id interceptor main.ts installs, ProvidersService,
 * and the quota cache (ProviderPlanUsageService), fed through `fetch` as the usage endpoint answers. Only
 * the network and the JWT check are replaced — a bearer token names its caller.
 *
 * It only adds rows, under ids of its own, and refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OAUTH_USAGE_URL } from './plan-usage';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'provider-pool-usage-spec';

const ANTHROPIC = 'https://api.anthropic.com';
const HOUR = 60 * 60 * 1000;
/** Every Anthropic credential, subscription or metered, starts with this. */
const KEY_PREFIX = 'sk-ant';

/** What the usage endpoint answers for each key: a body, or a status it refuses with. */
const usageAnswers = new Map<string, unknown>();
const usageEndpoint = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const key = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const answer = String(input) === OAUTH_USAGE_URL ? usageAnswers.get(key) : undefined;
  if (typeof answer === 'number') return new Response('{"error":{"message":"refused"}}', { status: answer });
  return answer === undefined
    ? new Response('unavailable', { status: 500 })
    : new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;

/** The endpoint's body for a 5-hour window at `utilization`, resetting at `resetsAt`. */
const fiveHour = (utilization: number, resetsAt: Date) => ({
  five_hour: { utilization, resets_at: resetsAt.toISOString() },
});

const realtime = new Proxy({}, {
  get: (_target, key) => (key === 'then' ? undefined : () => undefined),
}) as RealtimeService;

interface Member {
  id: string;
  slug: string;
  label: string;
  presetSlug: string | null;
  enabled: boolean;
  planUsage: { fiveHour?: { utilization: number; resetsAt?: string } } | null;
  state: string;
  resetsAt: string | null;
  next: boolean;
}
interface Pool {
  id: string;
  slug: string;
  label: string;
  resetsAt: string | null;
  members: Member[];
}
interface MineRow {
  id: string;
  label: string;
  poolRefusal: { reason: string; message: string } | null;
}

async function openDoor(providers: ProvidersService, prisma: PrismaService) {
  @Module({
    controllers: [ProvidersController],
    providers: [
      { provide: ProvidersService, useValue: providers },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class ProvidersDoorModule {}

  const app = await NestFactory.create(ProvidersDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  /** One GET as `caller`: the body as sent, and parsed. */
  const get = async <T>(caller: string, path: string): Promise<{ text: string; json: T }> => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${caller}` } });
    const text = await response.text();
    assert.equal(response.status, 200, `${path}: ${text}`);
    return { text, json: JSON.parse(text) as T };
  };
  return { get, close: () => app.close() };
}

const suite = URL ? test : test.skip;

suite('what the providers page reads about account pools, over HTTP on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realFetch = globalThis.fetch;
  const usage = new ProviderPlanUsageService(realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const door = await openDoor(providers, prisma);
  // Installed after the door is up: the requests below go to it through the real fetch, and only the
  // usage endpoint is answered from the table above.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    String(input) === OAUTH_USAGE_URL
      ? usageEndpoint(input as string, init as { headers?: Record<string, string> })
      : realFetch(input as string, init)) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await door.close();
    await db.$disconnect();
    await sql.end();
  });

  const newOwner = async (label: string) => {
    const id = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@pool-usage.invalid`, name: label, passwordHash: 'x' } });
    await db.runner.create({
      data: { id: runnerId, ownerId: id, name: `${label}-runner`, tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE, maxConcurrent: 4 },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId: id, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
    });
    return { id, runnerId, workspaceId };
  };
  const alice = await newOwner('alice');
  const bob = await newOwner('bob');

  const keys: string[] = [];
  /** A provider connected the way the /providers form connects one, and the key it holds. */
  const connect = async (ownerId: string, label: string, key: string, baseUrl = ANTHROPIC) => {
    keys.push(key);
    const row = await providers.create(
      ownerId,
      baseUrl === ANTHROPIC ? { label, baseUrl, apiKey: key, presetSlug: 'anthropic' } : { label, baseUrl, apiKey: key, runtime: 'claude' },
    );
    return { id: row.id, slug: row.slug, key };
  };
  const subscription = () => `sk-ant-oat01-${randomUUID()}`;
  /** Fill the quota cache the way a first read of the picker does, and wait for it to land. */
  const warm = async (id: string) => usage.refresh(await db.modelProvider.findUniqueOrThrow({ where: { id } }));
  const pub = (id: string) => uuidToBase62(id);
  /** No credential, and nothing that holds one, anywhere in a response. */
  const assertKeyless = (text: string, what: string) => {
    assert.equal(text.includes(KEY_PREFIX), false, `${what} carries an ${KEY_PREFIX}… credential`);
    for (const key of keys) assert.equal(text.includes(key), false, `${what} carries a stored key`);
    for (const field of ['apiKeyEnc', 'apiKey', 'baseUrl']) {
      assert.equal(text.includes(`"${field}"`), false, `${what} carries ${field}`);
    }
  };

  const now = Date.now();
  const work = await connect(alice.id, 'Work', subscription());
  const home = await connect(alice.id, 'Home', subscription());
  const spent = await connect(alice.id, 'Spent', subscription());
  const silent = await connect(alice.id, 'Silent', subscription());
  const refused = await connect(alice.id, 'Refused', subscription());
  usageAnswers.set(work.key, fiveHour(70, new Date(now + 2 * HOUR)));
  usageAnswers.set(home.key, fiveHour(20, new Date(now + 3 * HOUR)));
  usageAnswers.set(spent.key, fiveHour(100, new Date(now + HOUR)));
  // `silent` gets no answer: an endpoint that has nothing to say about it, so nothing is reported.
  usageAnswers.set(refused.key, 401);
  const pool = await providers.createPool(alice.id, {
    label: 'Claude accounts',
    providerIds: [work.id, home.id, spent.id, silent.id, refused.id],
  });
  for (const member of [work, home, spent, silent, refused]) await warm(member.id);
  // A session generating on Work right now, through the pool.
  await db.session.create({
    data: {
      title: 'pooled',
      prompt: 'hello',
      status: RunStatus.RUNNING,
      ownerId: alice.id,
      creatorId: alice.id,
      workspaceId: alice.workspaceId,
      assignedRunnerId: alice.runnerId,
      provider: pool.slug,
      providerBuiltin: false,
      poolMemberProviderId: work.id,
      usesRuntimeDefaultModel: true,
    },
  });

  await t.test('(1) every member carries its own quota, and where it stands', async () => {
    const { text, json } = await door.get<Pool[]>(alice.id, '/api/providers/pools');
    assert.equal(json.length, 1);
    const [served] = json;
    assert.equal(served.id, pub(pool.id), 'the pool is addressed by its public id');
    const byLabel = new Map(served.members.map((member) => [member.label, member]));
    assert.deepEqual([...byLabel.keys()].sort(), ['Home', 'Refused', 'Silent', 'Spent', 'Work']);
    assert.equal(byLabel.get('Work')!.id, pub(work.id));

    // Each member's own PlanUsageSnapshot, read with its own credential — four accounts, four answers.
    assert.equal(byLabel.get('Work')!.planUsage?.fiveHour?.utilization, 70);
    assert.equal(byLabel.get('Home')!.planUsage?.fiveHour?.utilization, 20);
    assert.equal(byLabel.get('Spent')!.planUsage?.fiveHour?.utilization, 100);
    assert.equal(byLabel.get('Silent')!.planUsage, null);
    assert.equal(byLabel.get('Refused')!.planUsage, null);

    assert.deepEqual(Object.fromEntries(served.members.map((member) => [member.label, member.state])), {
      Work: 'RUNNING',
      Home: 'AVAILABLE',
      Spent: 'SPENT',
      // Not reported is last in line, not idle at 0%.
      Silent: 'NO_QUOTA',
      // Refused once is refused for good: not available, whatever it last said.
      Refused: 'REFUSED',
    });
    assert.equal(byLabel.get('Spent')!.resetsAt, new Date(now + HOUR).toISOString());
    assert.equal(byLabel.get('Home')!.resetsAt, null);
    assert.equal(served.resetsAt, null, 'a pool with room is not waiting on any reset');

    // The member a session starting now runs on: Home, with the most room — not Work, which is busier,
    // and not an average of the members, which no one account is at.
    assert.deepEqual(served.members.filter((member) => member.next).map((member) => member.label), ['Home']);
    assertKeyless(text, 'GET /providers/pools');
  });

  await t.test('(2) once every member is spent, the pool resumes at the EARLIEST member reset', async () => {
    const first = await connect(alice.id, 'Frees first', subscription());
    const last = await connect(alice.id, 'Frees last', subscription());
    usageAnswers.set(first.key, fiveHour(100, new Date(now + HOUR)));
    usageAnswers.set(last.key, fiveHour(100, new Date(now + 4 * HOUR)));
    const spentPool = await providers.createPool(alice.id, { label: 'All spent', providerIds: [last.id, first.id] });
    await warm(first.id);
    await warm(last.id);

    const { text, json } = await door.get<Pool[]>(alice.id, '/api/providers/pools');
    const served = json.find((row) => row.id === pub(spentPool.id))!;
    assert.equal(served.resetsAt, new Date(now + HOUR).toISOString(), 'the earliest, not the latest');
    assert.deepEqual(
      Object.fromEntries(served.members.map((member) => [member.label, [member.state, member.resetsAt, member.next]])),
      {
        'Frees first': ['SPENT', new Date(now + HOUR).toISOString(), false],
        'Frees last': ['SPENT', new Date(now + 4 * HOUR).toISOString(), false],
      },
    );
    assertKeyless(text, 'GET /providers/pools (all spent)');
  });

  await t.test('(3) the key list says, row by row, why a provider may not join a pool', async () => {
    const metered = await connect(alice.id, 'Metered', `sk-ant-api03-${randomUUID()}`);
    const proxy = await connect(alice.id, 'Proxy', subscription(), 'https://api.deepseek.com/anthropic');
    const { text, json } = await door.get<MineRow[]>(alice.id, '/api/providers/mine');
    const verdict = (id: string) => json.find((row) => row.id === pub(id))?.poolRefusal;
    assert.deepEqual(verdict(metered.id), {
      reason: 'NOT_SUBSCRIPTION_TOKEN',
      message: 'Metered API key — no 5-hour window',
    });
    assert.deepEqual(verdict(proxy.id), {
      reason: 'NOT_ANTHROPIC_ENDPOINT',
      message: 'Endpoint is not api.anthropic.com',
    });
    assert.equal(verdict(work.id), null);
    assert.equal(verdict(silent.id), null, 'no quota reported yet is no reason to refuse');
    // The verdicts are the write's own: what the list says it refuses, the write does refuse.
    await assert.rejects(providers.addPoolMember(alice.id, pool.id, metered.id), /Metered API key/);
    await assert.rejects(providers.addPoolMember(alice.id, pool.id, proxy.id), /api\.anthropic\.com/);
    // The key list is the owner's management view and names each endpoint, but never a credential.
    assert.equal(text.includes(KEY_PREFIX), false, `GET /providers/mine carries an ${KEY_PREFIX}… credential`);
    for (const key of keys) assert.equal(text.includes(key), false, 'GET /providers/mine carries a stored key');
    assert.equal(text.includes('"apiKeyEnc"'), false);

    const picker = await door.get<unknown[]>(alice.id, '/api/providers');
    assertKeyless(picker.text, 'GET /providers');
  });

  await t.test("(4) another owner reads none of it", async () => {
    const { json } = await door.get<Pool[]>(bob.id, '/api/providers/pools');
    assert.deepEqual(json, []);
    const mine = await door.get<MineRow[]>(bob.id, '/api/providers/mine');
    assert.deepEqual(mine.json, []);
  });
});
