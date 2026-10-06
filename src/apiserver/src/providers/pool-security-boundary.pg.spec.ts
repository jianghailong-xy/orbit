/**
 * Account pools' security boundary on real PostgreSQL, written as regressions of their own rather than as
 * side effects of the specs that built pools (provider-pool, pool-claim-selection, pool-provider-doors).
 * Each is a property nothing downstream asks about again once it slips:
 *
 *  (A) A personal account pool resolves only for its owner's sessions. Another owner naming its slug gets
 *      none of its tokens, at every door that accepts a provider slug or builds an engine's environment —
 *      and what is asserted is what each door RESOLVED: the row it wrote or did not write, the
 *      environment it handed out. Never the wording of a refusal.
 *  (C) No browser-visible providers or pool payload carries a credential. Every route the providers
 *      controllers declare is called, refusals included, and no body holds `sk-ant`, a stored
 *      ciphertext or a key field. The owner's own reveal route, which exists to return a key, is the
 *      positive control that shows the check can see one. A person the owner added to a pool of her
 *      ChatGPT accounts (migration 0358) reads those accounts — since 2026-10-03 they run their sessions
 *      too (pool-credential-select.ts), so the pool's page names each one's email, plan, `…AB12`, quota
 *      and why OpenAI refused it — and OpenAI's own id of an account is named to nobody, her included.
 *      Their session on the pool says nothing of an account either, and no push carries one.
 *  (D) The key never lands in an agent's env (Workspace.env), nor anywhere else at rest: it is
 *      decrypted at the claim, into the job env alone.
 *  (E) A ChatGPT account in a Codex pool runs the sessions of everyone in it — its owner's, and those of
 *      the people the owner added (2026-10-03). At every door that builds their session's engine — the
 *      claim, a restarted runner's reclaim, a provider-switch reload — they get a person's token and never
 *      a login pool's (no `pool_login_token` row of theirs; 0324's fence holds the login table to the
 *      owner), their session names the account, and through the real gateway their token reaches ChatGPT's
 *      Codex backend on it, with the account's live access token in place. A session row naming an account
 *      the pool no longer holds is refused there, with nothing sent anywhere — the gateway reads the
 *      pool's own rows, not the session's. The same three doors for the owner are the positive control:
 *      a login pool token, and the same backend on the same account.
 *
 * (B) — the usage probe and pool admission — needs no database: pool-security-boundary.spec.ts.
 *
 * Every refusal is paired with the same request made for the owner, which has to go through, so a door
 * that refused everything could not pass. Everything between the rows and the answers is production
 * code: the providers controllers — the shared pools' among them — behind real HTTP, with the global pipe,
 * interceptors and filter main.ts installs; SessionsService, TasksService, ProvidersService,
 * SharedPoolsService, QueueService, RunnerApiController and the quota cache (ProviderPlanUsageService); for
 * (E), the pool gateway's controller and both its services, behind main.ts's own body parsers. Only the
 * network the server calls out on (`fetch`, and in (E) a recorder standing where OpenAI's API and ChatGPT's
 * Codex backend stand — POOL_GATEWAY_UPSTREAM and POOL_LOGIN_UPSTREAM, which nothing in production can
 * change), the codex CLI a ChatGPT sign-in starts, and the check of a person's signed token are stand-ins.
 *
 * It only adds rows, under ids and slugs of its own, and refuses to run anywhere but the disposable
 * server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunStatus, RunnerStatus, type ModelProvider, type Prisma } from '@prisma/client';
import { toUuid, uuidToBase62, type ClaimedSession } from '@orbit/shared';
import { json, urlencoded } from 'express';
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
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { accountPoolRuntime } from './custom-provider';
import { OAUTH_USAGE_URL } from './plan-usage';
import { ProviderPlanUsageService } from './plan-usage.service';
import { outsideThePoolGateway, PoolGatewayController } from './pool-gateway.controller';
import { PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { PoolLoginLedger } from './pool-login-ledger';
import { PoolUsageLedger } from './pool-usage-ledger';
import { encryptSecret } from './provider-crypto';
import { ProvidersController } from './providers.controller';
import { CodexLoginService } from './codex-login.service';
import { ProvidersService } from './providers.service';
import { SharedPoolsController } from './shared-pools.controller';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts keys and the code under test decrypts them; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-security-boundary-spec';

const ANTHROPIC = 'https://api.anthropic.com';

/** Every plaintext key this spec makes: none may reach a browser payload, an agent's env or a table. */
const KEYS = new Set<string>();
const minted = (key: string) => (KEYS.add(key), key);
const subscription = () => minted(`sk-ant-oat01-${randomUUID()}`);
const metered = () => minted(`sk-ant-api03-${randomUUID()}`);

/** What the usage endpoint answers for each key. A key with no answer gets a 500: nothing to read. */
const usageAnswers = new Map<string, unknown>();

/** The endpoint's body for a 5-hour window at `utilization`, resetting in two hours. */
function fiveHour(utilization: number) {
  return { five_hour: { utilization, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } };
}

/** The network the server calls out on: the usage endpoint, and nothing else that answers. */
const serverNetwork = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const key = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const body = String(input) === OAUTH_USAGE_URL ? usageAnswers.get(key) : undefined;
  return body === undefined
    ? new Response('unavailable', { status: 500 })
    : new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

/** How this spec itself reaches the doors it opens — kept before `serverNetwork` replaces the global. */
const realFetch = globalThis.fetch;

/** Every broadcast the code under test makes: (C) reads what would have reached a client's stream. */
const broadcasts: unknown[][] = [];
const realtime = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'then' ? undefined : (...args: unknown[]) => void broadcasts.push([String(key), ...args]),
  },
) as RealtimeService;

/** A runner and the agent (workspace) bound to it. */
interface Machine {
  label: string;
  runnerId: string;
  /** The runner's bearer token, for the runner-facing door. */
  runnerToken: string;
  workspaceId: string;
}

/** What each agent's env was configured with, by workspace id — all (D) accepts finding there after. */
const configuredEnv = new Map<string, Record<string, string>>();

async function machine(db: PrismaClient, ownerId: string, label: string): Promise<Machine> {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerToken = `pool-security-runner-${randomUUID()}`;
  const env = { ORBIT_POOL_SECURITY_AGENT: label };
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(runnerToken),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}`, env },
  });
  configuredEnv.set(workspaceId, env);
  return { label, runnerId, runnerToken, workspaceId };
}

async function person(db: PrismaClient, label: string, role = 'MEMBER'): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@pool-security.invalid`, name: label, passwordHash: 'x', role },
  });
  return id;
}

interface Account {
  row: ModelProvider;
  /** The plaintext key, which only the job env of its owner's own sessions may ever carry. */
  key: string;
}

/** One of `ownerId`'s own Claude credentials — by default a subscription on api.anthropic.com, the only
 *  kind a pool admits. */
async function account(db: PrismaClient, ownerId: string, label: string, key = subscription()): Promise<Account> {
  const row = await db.modelProvider.create({
    data: { slug: `pool-security-${randomUUID()}`, label, runtime: 'claude', baseUrl: ANTHROPIC, apiKeyEnc: encryptSecret(key), ownerId },
  });
  return { row, key };
}

const pub = (account: Account) => uuidToBase62(account.row.id);

/**
 * A session row on `provider`, written straight into the table — which is the only way another owner's
 * pool gets onto one, since every door refuses to write it there (A2). Built-in only for `claude`.
 */
async function sessionOn(
  db: PrismaClient,
  ownerId: string,
  at: Machine,
  provider: string,
  status: RunStatus,
  started = false,
): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'pool security',
      prompt: 'hello',
      status,
      ownerId,
      creatorId: ownerId,
      workspaceId: at.workspaceId,
      assignedRunnerId: at.runnerId,
      provider,
      providerBuiltin: provider === 'claude',
      model: 'claude-opus-5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      // What an engine that has run leaves behind: what a live one is re-spawned from, and what a
      // terminal one needs to be revivable at all.
      ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return session.id;
}
const queued = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.PENDING);
/** An engine up and idle on `provider` — what a provider switch re-spawns and a restarted runner reclaims. */
const live = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.AWAITING_INPUT, true);
/** A run that ended but can be revived. */
const ended = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.FAILED, true);

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

/** `value` as the text it would go over the wire as. Rows carry BIGINT columns, which main.ts serializes. */
const wire = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** A credential in a response body: the key in the clear, a stored ciphertext, or a field named for one. */
function credentialsIn(text: string, ciphertexts: Iterable<string>): string[] {
  const found: string[] = [];
  if (/sk-ant/i.test(text)) found.push('an sk-ant key');
  for (const ciphertext of ciphertexts) {
    if (text.includes(ciphertext)) {
      found.push('a stored ciphertext');
      break;
    }
  }
  if (/"apiKey(?:Enc)?"\s*:/.test(text)) found.push('a key field');
  return found;
}

/**
 * What a door did with a request, without reading why: the assertions on another owner's pool are about
 * what the door resolved and wrote, and a refusal is only checked AFTER that — never by its wording.
 */
async function settle(request: Promise<unknown>): Promise<'went through' | 'refused'> {
  try {
    await request;
    return 'went through';
  } catch {
    return 'refused';
  }
}

/** Every route the given controllers declare, as `METHOD path/with/:params`. */
function routesOf(...controllers: Array<new (...args: never[]) => unknown>): string[] {
  return controllers.flatMap((controller) => {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) return [];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      return [`${method} ${[prefix, path].filter((part) => part && part !== '/').join('/')}`];
    });
  });
}

/** The tables holding any of this spec's keys in the clear, read row by row as text. */
async function tablesHoldingAKey(client: Client): Promise<string[]> {
  const { rows: tables } = await client.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  // The sweep has to have read the tables a key could land in, or its empty answer means nothing.
  const names = tables.map((t) => t.name);
  for (const table of ['workspace', 'session', 'conversation_turn', 'run_event', 'model_provider', 'provider_pool']) {
    assert.ok(names.includes(table), `the sweep did not read ${table}`);
  }
  const holding: string[] = [];
  for (const name of names) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" AS r WHERE strpos(lower(r::text), 'sk-ant') > 0`,
    );
    if (rows[0].n > 0) holding.push(name);
  }
  return holding;
}

/** What the providers doors are built around; set before Nest builds them. */
const doorsOver: {
  providers: ProvidersService | null;
  login: CodexLoginService | null;
  pools: SharedPoolsService | null;
  prisma: unknown;
} = {
  providers: null,
  login: null,
  pools: null,
  prisma: null,
};

@Module({
  controllers: [ProvidersController, AdminProvidersController, RunnerProvidersController, SharedPoolsController],
  providers: [
    { provide: ProvidersService, useFactory: () => doorsOver.providers },
    // The ChatGPT sign-in's own controller dependency (migration 0323). The REAL service: (C) sweeps
    // every route the controller declares, these five included, and a stub answering 500 would be a
    // route whose body nobody checked.
    { provide: CodexLoginService, useFactory: () => doorsOver.login },
    // The pool page's doors (migrations 0321, 0358), which the people an owner adds to a pool read it
    // through — the REAL service, for the same reason.
    { provide: SharedPoolsService, useFactory: () => doorsOver.pools },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    JwtAuthGuard,
    AdminRoleGuard,
    RunnerAuthGuard,
    Reflector,
    // A person is whoever their bearer names: what a verified token would say, with the user id as the token.
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class ProviderDoors {}

/** The doors, up and reachable, with main.ts's own layers around every handler. */
async function openDoors() {
  const app = await NestFactory.create(ProviderDoors, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

/** One request the recorder standing where OpenAI's API and ChatGPT's Codex backend stand was sent. */
interface Upstreamed {
  path: string;
  authorization: string | undefined;
  /** `ChatGPT-Account-ID`: which ChatGPT account a request to the backend went out on. */
  account: string | undefined;
}

/** A Responses stream that completes at once: all the gateway has to pass back. */
const COMPLETED_STREAM = [
  { type: 'response.created', response: { id: 'resp_spec', status: 'in_progress' } },
  {
    type: 'response.completed',
    response: {
      id: 'resp_spec', status: 'completed', model: 'gpt-5.5', output: [],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 },
    },
  },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const headerOf = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The Codex pools' gateway, up and reachable behind main.ts's own body parsers — the real controller and
 * both its services — with a recorder where OpenAI's API (`/v1`) and ChatGPT's Codex backend
 * (`/backend-api/codex`) stand. `send` is a request codex makes on a session token, and what of it
 * reached either upstream.
 */
async function openGateway(
  prisma: PrismaService,
  realtime: RealtimeService,
  pools: SharedPoolsService,
  logins: CodexLoginService,
) {
  const seen: Upstreamed[] = [];
  const recorder: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        authorization: headerOf(req.headers, 'authorization'),
        account: headerOf(req.headers, 'chatgpt-account-id'),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(COMPLETED_STREAM);
    });
  });
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
  const keys = new PoolGatewayService(prisma, pools, new PoolUsageLedger(prisma), `${upstream}/v1`);
  const accounts = new PoolLoginGatewayService(
    prisma, logins, new PoolLoginLedger(prisma), realtime, `${upstream}/backend-api/codex`, `${upstream}/oauth/token`,
  );
  @Module({
    controllers: [PoolGatewayController],
    providers: [
      { provide: PoolGatewayService, useValue: keys },
      { provide: PoolLoginGatewayService, useValue: accounts },
    ],
  })
  class GatewayDoors {}
  const app = await NestFactory.create(GatewayDoors, { bodyParser: false, logger: false, abortOnError: false });
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    /** One `POST /responses` codex sends with `token`: the answer, and every request it made upstream. */
    async send(token: string) {
      const from = seen.length;
      const response = await realFetch(`${base}/api/gw/codex/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'hello', stream: true }),
      });
      const text = await response.text();
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
      } catch {
        /* a stream: no refusal in it */
      }
      return { status: response.status, code, upstream: seen.slice(from) };
    },
    async close() {
      await app.close();
      await new Promise((resolve) => recorder.close(resolve));
    },
  };
}

/** One HTTP exchange with the doors, as a browser (or, for `runner/…`, a runner) had it. */
interface Answer {
  method: string;
  /** The route as the controller declares it, `:params` and all. */
  route: string;
  path: string;
  who: string;
  expected: number;
  status: number;
  text: string;
  json: any;
}

const suite = URL ? test : test.skip;

suite("account pools' security boundary, on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  globalThis.fetch = serverNetwork;

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );
  doorsOver.providers = providers;
  doorsOver.login = new CodexLoginService(prisma, realtime);
  doorsOver.pools = new SharedPoolsService(prisma, realtime, providers);
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  /** Every ciphertext a provider row — or a pool's ChatGPT login (migration 0323), or an OpenAI API key in a
   *  pool (migration 0321) — has held while this spec ran, rotated and deleted ones included. */
  const ciphertexts = new Set<string>();
  const track = async () => {
    for (const row of await db.modelProvider.findMany({ select: { apiKeyEnc: true } })) ciphertexts.add(row.apiKeyEnc);
    for (const row of await db.poolCodexLogin.findMany({ select: { accessTokenEnc: true, refreshTokenEnc: true } })) {
      ciphertexts.add(row.accessTokenEnc);
      ciphertexts.add(row.refreshTokenEnc);
    }
    for (const row of await db.poolApiKey.findMany({ select: { secretEncrypted: true } })) ciphertexts.add(row.secretEncrypted);
  };
  const names = new Map<string, string>();
  const answers: Answer[] = [];
  /** Ask a door, as `bearer`, and keep the answer for (C) — whose status is checked there, after the
   *  body: a 500 is no evidence, but a leak has to be reported as the leak it is. */
  async function ask(
    bearer: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    route: string,
    params: Record<string, string>,
    body: unknown,
    expected: number,
  ): Promise<Answer> {
    const path = route.replace(/:(\w+)/g, (_, param: string) => params[param] ?? assert.fail(`no ${param} for ${route}`));
    const response = await realFetch(`${doors.base}/api/${path}`, {
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
      /* not JSON: the text alone is checked */
    }
    const answer = { method, route, path, who: names.get(bearer) ?? bearer, expected, status: response.status, text, json };
    answers.push(answer);
    await track();
    return answer;
  }
  const statusOf = (answer: Answer) => `${answer.method} /api/${answer.path} as ${answer.who} → ${answer.status}: ${answer.text}`;
  /** `ask`, for a caller that goes on to use the answer: it has to be the one expected. */
  async function call(...args: Parameters<typeof ask>): Promise<Answer> {
    const answer = await ask(...args);
    assert.equal(answer.status, answer.expected, statusOf(answer));
    return answer;
  }

  /** The runner asking for work — which has to be `sessionId`. */
  async function claim(runnerId: string, sessionId: string): Promise<ClaimedSession> {
    const claimed = await queue.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    return claimed;
  }
  /** The runner's inbox poll, until it is handed the reload a provider switch queued. */
  async function dequeueReload(sessionId: string, runnerId: string) {
    const dequeue = (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn.bind(runnerApi);
    for (let polls = 0; polls < 4; polls += 1) {
      const turn = await dequeue(sessionId, runnerId, null);
      assert.ok(turn, 'the inbox handed out nothing');
      if (turn.kind === 'reload') return turn;
    }
    throw new Error('the inbox never handed out the reload');
  }
  const token = (env: Record<string, string> | undefined) => env?.ANTHROPIC_AUTH_TOKEN;
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { provider: true, status: true, poolMemberProviderId: true },
    });

  const alice = await person(db, 'alice');
  const bob = await person(db, 'bob');
  const admin = await person(db, 'admin', 'ADMIN');
  names.set(alice, 'alice').set(bob, 'bob').set(admin, 'an admin');
  const aliceHome = await machine(db, alice, 'alice-home');
  const bobHome = await machine(db, bob, 'bob-home');
  names.set(aliceHome.runnerToken, "alice's runner").set(bobHome.runnerToken, "bob's runner");

  // Alice's two subscriptions, Personal with the most 5-hour room; Bob's one.
  const work = await account(db, alice, 'Work');
  const personal = await account(db, alice, 'Personal');
  const theirs = await account(db, bob, 'Theirs');
  /** Every key of Alice's a pool of hers could hand out. None may reach anything of Bob's. */
  const hers = [work, personal];
  const herKeysIn = (value: unknown) => hers.filter((a) => wire(value).includes(a.key)).map((a) => a.row.label);
  usageAnswers.set(work.key, fiveHour(45));
  usageAnswers.set(personal.key, fiveHour(12));
  usageAnswers.set(theirs.key, fiveHour(30));
  // Every door reads the quota cache and never waits on the network, so the numbers go in first.
  await Promise.all([work, personal, theirs].map((a) => usage.refresh(a.row)));
  assert.equal(usage.snapshot(personal.row)?.fiveHour?.utilization, 12);
  await track();

  // Both pools made through the browser's own door, so (C) reads those answers too.
  async function poolOver(ownerId: string, label: string, members: Account[]) {
    await call(ownerId, 'POST', 'providers/pools', {}, { label, providerIds: members.map(pub) }, 201);
    return db.providerPool.findFirstOrThrow({ where: { ownerId, label }, select: { id: true, slug: true } });
  }
  const alicePool = await poolOver(alice, 'Claude accounts', hers);
  const bobPool = await poolOver(bob, 'His accounts', [theirs]);

  await t.test("(A1) another owner's pool slug resolves to nothing — accountPoolRuntime and resolvePoolMember themselves", async () => {
    // Positive control: for its owner, the slug is a Claude pool, and a session of hers resolves to a member.
    assert.equal(await accountPoolRuntime(db, alice, alicePool.slug), 'claude');
    const herSession = await live(db, alice, aliceHome, alicePool.slug);
    const chosen = await queue.resolvePoolMember(db, { id: herSession, ownerId: alice, poolMemberProviderId: null }, alicePool.slug);
    assert.equal(chosen?.id, personal.row.id);

    assert.equal(await accountPoolRuntime(db, bob, alicePool.slug), null, 'the write doors resolve her pool for him');
    const hisSession = await live(db, bob, bobHome, alicePool.slug);
    const resolved = await queue.resolvePoolMember(db, { id: hisSession, ownerId: bob, poolMemberProviderId: null }, alicePool.slug);
    assert.equal(resolved, null, `the claim resolves her pool for him, to ${resolved?.label}`);
    assert.equal((await recorded(hisSession)).poolMemberProviderId, null);
  });

  await t.test("(A2) a session opens on its owner's own pool, and on another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-opens');
    const own = await sessions.create(bob, { prompt: 'hello', title: 'on his pool', workspaceId: at.workspaceId, provider: bobPool.slug });
    assert.equal((await recorded(own.id)).provider, bobPool.slug);

    const attempt = await settle(
      sessions.create(bob, { prompt: 'hello', title: 'on her pool', workspaceId: at.workspaceId, provider: alicePool.slug }),
    );
    assert.deepEqual(
      await db.session.findMany({ where: { workspaceId: at.workspaceId, provider: alicePool.slug }, select: { id: true } }),
      [],
      'a session of his was written on her pool',
    );
    assert.equal(attempt, 'refused');
  });

  await t.test("(A2) a live session switches onto its owner's own pool, and onto another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-switches');
    const session = await live(db, bob, at, 'claude');

    const attempt = await settle(sessions.updateConfig(bob, session, { provider: alicePool.slug }));
    assert.equal((await recorded(session)).provider, 'claude', 'his session was moved onto her pool');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session } }), 0, 'a reload was queued onto her pool');
    assert.equal(attempt, 'refused');

    await sessions.updateConfig(bob, session, { provider: bobPool.slug });
    assert.equal((await recorded(session)).provider, bobPool.slug);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session, kind: 'reload' } }), 1);
  });

  await t.test("(A2) an ended session revives onto its owner's own pool, and onto another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-revives');
    const session = await ended(db, bob, at, 'claude');

    const attempt = await settle(
      sessions.resume(bob, session, { clientTurnId: randomUUID(), content: 'again', provider: alicePool.slug }),
    );
    assert.deepEqual(
      { ...(await recorded(session)), turns: await db.conversationTurn.count({ where: { sessionId: session } }) },
      { provider: 'claude', status: RunStatus.FAILED, poolMemberProviderId: null, turns: 0 },
      'his session was revived onto her pool',
    );
    assert.equal(attempt, 'refused');

    await sessions.resume(bob, session, { clientTurnId: randomUUID(), content: 'again', provider: bobPool.slug });
    const revived = await recorded(session);
    assert.equal(revived.provider, bobPool.slug);
    assert.equal(revived.status, RunStatus.PENDING);
  });

  await t.test("(A2) a task pins its owner's own pool, and another owner's pool not at all", async () => {
    const title = `pinned ${randomUUID()}`;
    const pinned = await tasks.create(bob, { title, provider: bobPool.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, bobPool.slug);

    const created = await settle(tasks.create(bob, { title: `${title} on hers`, provider: alicePool.slug, ...TASK_CHECK } as never));
    const repinned = await settle(tasks.update(bob, pinned.id, { provider: alicePool.slug }));
    assert.deepEqual(
      await db.task.findMany({ where: { ownerId: bob, provider: alicePool.slug }, select: { title: true } }),
      [],
      'a task of his was pinned to her pool',
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, bobPool.slug);
    assert.deepEqual({ created, repinned }, { created: 'refused', repinned: 'refused' });
  });

  await t.test("(A2) the provider list an agent reads names its owner's own pool, and another owner's not at all", async () => {
    const slugs = (answer: Answer) => (answer.json as Array<{ slug: string }>).map((p) => p.slug);
    const his = slugs(await call(bobHome.runnerToken, 'GET', 'runner/providers', {}, undefined, 200));
    assert.ok(his.includes(bobPool.slug), 'his own pool is missing from his list');
    assert.equal(his.includes(alicePool.slug), false, 'her pool is on his list');
    const theirs_ = slugs(await call(aliceHome.runnerToken, 'GET', 'runner/providers', {}, undefined, 200));
    assert.ok(theirs_.includes(alicePool.slug), 'her own pool is missing from her list');
    assert.equal(theirs_.includes(bobPool.slug), false, 'his pool is on her list');
  });

  await t.test("(A2) a mention of an agent that last ran on its owner's own pool opens a session there, and on another owner's pool none", async () => {
    // Two agents of Bob's: one whose project last ran on his pool, one whose last session names hers —
    // a row no door writes, put there by hand as a stale or forged history would be.
    const ownAgent = await machine(db, bob, 'bob-mentioned-own');
    const herAgent = await machine(db, bob, 'bob-mentioned-hers');
    await sessionOn(db, bob, ownAgent, bobPool.slug, RunStatus.SUCCEEDED, true);
    const forged = await sessionOn(db, bob, herAgent, alicePool.slug, RunStatus.SUCCEEDED, true);
    const task = await tasks.create(bob, { title: `mentions ${randomUUID()}`, ...TASK_CHECK } as never);
    const comment = await db.taskComment.create({
      data: {
        taskId: task.id,
        authorType: 'USER',
        authorId: bob,
        body: 'have a look at this',
        mentions: [ownAgent.workspaceId, herAgent.workspaceId],
        mentionDeliveryVersion: 1,
      },
      select: { id: true },
    });

    await tasks.deliverMentions();

    const deliveries = await db.taskCommentMentionDelivery.findMany({
      where: { commentId: comment.id },
      select: { workspaceId: true, status: true, errorCode: true, targetSessionId: true },
    });
    const to = (at: Machine) => deliveries.find((d) => d.workspaceId === at.workspaceId);
    const own = to(ownAgent);
    assert.equal(own?.status, 'SESSION_CREATED', JSON.stringify(own));
    assert.equal((await recorded(own!.targetSessionId!)).provider, bobPool.slug);

    const toHers = to(herAgent);
    assert.ok(toHers, 'no delivery was made for the second mention');
    assert.deepEqual(
      (await db.session.findMany({ where: { workspaceId: herAgent.workspaceId }, select: { id: true } })).map((s) => s.id),
      [forged],
      'the mention opened a session on her pool',
    );
    assert.equal(toHers.targetSessionId, null, 'the mention was bound to a session');
    assert.equal(toHers.errorCode, 'PROVIDER_UNAVAILABLE');
  });

  await t.test("(A3) the claim hands another owner's session none of the pool's tokens, whether it names the pool or a member", async () => {
    // Positive control: his own pool dispatches with his own key.
    const ownAt = await machine(db, bob, 'bob-claims-own');
    const own = await queued(db, bob, ownAt, bobPool.slug);
    assert.equal(token((await claim(ownAt.runnerId, own)).agent.env), theirs.key);

    const poolAt = await machine(db, bob, 'bob-claims-her-pool');
    const onPool = await queued(db, bob, poolAt, alicePool.slug);
    const claimed = await claim(poolAt.runnerId, onPool);
    assert.deepEqual(herKeysIn(claimed), [], 'her key is in what his runner was handed');
    // Exactly the agent's own env: the Claude default, with nothing resolved for the slug.
    assert.deepEqual(claimed.agent.env, configuredEnv.get(poolAt.workspaceId));
    assert.equal((await recorded(onPool)).poolMemberProviderId, null);

    const memberAt = await machine(db, bob, 'bob-claims-her-member');
    const onMember = await queued(db, bob, memberAt, personal.row.slug);
    const direct = await claim(memberAt.runnerId, onMember);
    assert.deepEqual(herKeysIn(direct), [], 'her key is in what his runner was handed');
    assert.deepEqual(direct.agent.env, configuredEnv.get(memberAt.workspaceId));
  });

  await t.test("(A3) a restarted runner's reclaim rebuilds another owner's session with none of the pool's tokens", async () => {
    const at = await machine(db, bob, 'bob-reclaims');
    const own = await live(db, bob, at, bobPool.slug);
    const onHers = await live(db, bob, at, alicePool.slug);
    const reclaimed = (await runnerApi.reclaim({ id: at.runnerId, ownerId: bob })).sessions;
    const rebuilt = (id: string) => reclaimed.find((s) => s.sessionId === id);

    assert.equal(token(rebuilt(own)?.agent.env), theirs.key, 'his own pool session was not rebuilt on his key');
    assert.ok(rebuilt(onHers), 'the session on her pool was left out of the reclaim, so it says nothing');
    assert.deepEqual(herKeysIn(rebuilt(onHers)), [], 'her key is in what his runner was handed');
    assert.deepEqual(rebuilt(onHers)?.agent.env, configuredEnv.get(at.workspaceId));
    assert.equal((await recorded(onHers)).poolMemberProviderId, null);
  });

  await t.test("(A3) a provider-switch reload re-spawns another owner's session with none of the pool's tokens", async () => {
    // Positive control: a switch onto his own pool re-spawns on his own key.
    const ownAt = await machine(db, bob, 'bob-reloads-own');
    const own = await live(db, bob, ownAt, 'claude');
    await sessions.updateConfig(bob, own, { provider: bobPool.slug });
    assert.equal(token((await dequeueReload(own, ownAt.runnerId)).env), theirs.key);

    // Past the door — the row and the queued reload written by hand, as nothing in the product can.
    const at = await machine(db, bob, 'bob-reloads-hers');
    const onHers = await live(db, bob, at, alicePool.slug);
    await db.conversationTurn.create({
      data: {
        sessionId: onHers,
        seq: 1,
        clientTurnId: randomUUID(),
        kind: 'reload',
        content: JSON.stringify({ provider: alicePool.slug }),
        status: 'PENDING',
      },
    });
    const reload = await dequeueReload(onHers, at.runnerId);
    assert.deepEqual(herKeysIn(reload), [], 'her key is in what his runner was handed');
    // Exactly the agent's own env: nothing was resolved for the slug at all.
    assert.deepEqual(reload.env, configuredEnv.get(at.workspaceId));
    assert.equal((await recorded(onHers)).poolMemberProviderId, null);
  });

  await t.test("(E) a person added to a pool of one's own ChatGPT accounts runs on its account too — a person's token, no login token of theirs, the gateway reaching the ChatGPT backend on that account; the owner's same three as the positive control", async () => {
    const owner = await person(db, 'codex-owner');
    const member = await person(db, 'codex-member');
    names.set(owner, 'the codex pool owner').set(member, 'a person in her codex pool');
    const pools = new SharedPoolsService(prisma, realtime, providers);
    // Her Codex pool, made through the browser's door — with her ADMIN row in it — and the ChatGPT account
    // she signed in, as the sign-in stores one.
    await call(owner, 'POST', 'providers/pools', {}, { label: 'Codex Pool', engine: 'codex' }, 201);
    const pool = await db.providerPool.findFirstOrThrow({
      where: { ownerId: owner, label: 'Codex Pool' },
      select: { id: true, slug: true },
    });
    const accountId = `acct-${randomUUID()}`;
    const login = { access: `codex-access-${randomUUID()}`, refresh: `codex-refresh-${randomUUID()}` };
    const stored = await db.poolCodexLogin.create({
      data: {
        poolId: pool.id, userId: owner, accountId, email: 'codex-owner@codex-login.invalid', plan: 'pro',
        accessTokenEnc: encryptSecret(login.access), refreshTokenEnc: encryptSecret(login.refresh),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    // The person, by the email of their Orbit account, and one API key — the owner's.
    const { email } = await db.user.findUniqueOrThrow({ where: { id: member }, select: { email: true } });
    await pools.addPerson(owner, pool.id, { email });
    const apiKey = `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    await pools.addKey(owner, pool.id, { label: 'orbit-org-1', apiKey });
    const key = await db.poolApiKey.findFirstOrThrow({ where: { poolId: pool.id }, select: { id: true, secretEncrypted: true } });
    /** What none of the doors may hand a runner: the account's tokens, in the clear or as stored, and the key. */
    const secrets = [login.access, login.refresh, stored.accessTokenEnc, stored.refreshTokenEnc, apiKey, key.secretEncrypted];
    const secretsIn = (value: unknown) => secrets.filter((secret) => wire(value).includes(secret));

    /** A session of `who`'s on `provider`, written into the table — as an engine that has run, unless queued;
     *  `naming` an account as a row written by hand, or carried over from elsewhere, would. */
    const codexSession = async (who: string, at: Machine, provider: string, status: RunStatus, naming: string | null) =>
      (await db.session.create({
        data: {
          title: 'codex pool', prompt: 'hello', status, ownerId: who, creatorId: who,
          workspaceId: at.workspaceId, assignedRunnerId: at.runnerId,
          provider, providerBuiltin: provider === 'codex', model: 'gpt-5.5', permissionMode: 'default',
          usesRuntimeDefaultModel: true, poolCodexAccountId: naming,
          ...(status === RunStatus.PENDING ? {} : { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() }),
        },
        select: { id: true },
      })).id;

    /** What each door that builds an engine handed `who`'s runner for a session on the pool: the claim, a
     *  restarted runner's reclaim, and the reload a switch onto the pool re-spawns with. */
    async function threeDoors(who: string, label: string, naming: string | null) {
      const claimAt = await machine(db, who, `${label}-claims`);
      const queuedOn = await codexSession(who, claimAt, pool.slug, RunStatus.PENDING, naming);
      const claimed = await claim(claimAt.runnerId, queuedOn);

      const reclaimAt = await machine(db, who, `${label}-reclaims`);
      const liveOn = await codexSession(who, reclaimAt, pool.slug, RunStatus.AWAITING_INPUT, naming);
      const reclaimed = (await runnerApi.reclaim({ id: reclaimAt.runnerId, ownerId: who })).sessions
        .find((s) => s.sessionId === liveOn);
      assert.ok(reclaimed, 'the session on the pool was left out of the reclaim');

      const reloadAt = await machine(db, who, `${label}-reloads`);
      const switched = await codexSession(who, reloadAt, 'codex', RunStatus.AWAITING_INPUT, naming);
      await sessions.updateConfig(who, switched, { provider: pool.slug });
      const reload = await dequeueReload(switched, reloadAt.runnerId);

      return [
        { door: 'claim', at: claimAt, sessionId: queuedOn, payload: claimed as unknown, env: claimed.agent.env },
        { door: 'reclaim', at: reclaimAt, sessionId: liveOn, payload: reclaimed as unknown, env: reclaimed.agent.env },
        { door: 'reload', at: reloadAt, sessionId: switched, payload: reload as unknown, env: reload.env },
      ];
    }
    const onPool = (sessionId: string) =>
      db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { poolCodexAccountId: true, poolKeyId: true } });

    const gateway = await openGateway(prisma, realtime, pools, doorsOver.login!);
    try {
      // The person: every door lands on her account — it runs their sessions too — on a person's token,
      // with no login pool token of theirs anywhere.
      const theirs = await threeDoors(member, 'codex-member', accountId);
      for (const { door, at, sessionId, payload, env } of theirs) {
        const token = env?.OPENAI_API_KEY ?? '';
        assert.match(token, /^orbit-gw-[A-Za-z0-9_-]{43}$/, `${door}: not a person's token`);
        assert.ok(env?.OPENAI_BASE_URL?.endsWith('/api/gw/codex'), `${door}: not the gateway`);
        assert.deepEqual(env, { ...configuredEnv.get(at.workspaceId), OPENAI_BASE_URL: env?.OPENAI_BASE_URL, OPENAI_API_KEY: token }, door);
        assert.deepEqual(secretsIn(payload), [], `${door}: the runner was handed a credential of the pool`);
        assert.equal(
          await db.poolLoginToken.count({ where: { OR: [{ userId: member }, { sessionId }] } }),
          0,
          `${door}: a login pool token of the person's`,
        );
        assert.deepEqual(await onPool(sessionId), { poolCodexAccountId: accountId, poolKeyId: null }, `${door}: the session's credential`);
        // Through the gateway: ChatGPT's Codex backend on her account — the account's own access token and
        // id put in place, never anything of the key's — and nothing sent anywhere else.
        const sent = await gateway.send(token);
        assert.equal(sent.status, 200, `${door}: ${sent.code}`);
        assert.deepEqual(sent.upstream, [
          { path: '/backend-api/codex/responses', authorization: `Bearer ${login.access}`, account: accountId },
        ], door);
      }
      // A session row naming an account the pool no longer holds is refused, with nothing sent: the row is
      // no way in — the gateway reads the pool's own rows for the account it sends on.
      const [{ sessionId: gone, env: goneEnv }] = theirs;
      const held = await db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId: pool.id, accountId } } });
      await db.poolCodexLogin.delete({ where: { poolId_accountId: { poolId: pool.id, accountId } } });
      const refused = await gateway.send(goneEnv!.OPENAI_API_KEY!);
      assert.deepEqual({ status: refused.status, code: refused.code, upstream: refused.upstream }, {
        status: 403, code: 'orbit_pool_login_missing', upstream: [],
      });
      // Back, field by field — the row as the sign-in stored it, its ciphertexts included.
      await db.poolCodexLogin.create({
        data: {
          poolId: pool.id, userId: owner, accountId: held.accountId, email: held.email, plan: held.plan,
          accessTokenEnc: held.accessTokenEnc, refreshTokenEnc: held.refreshTokenEnc,
          expiresAt: held.expiresAt, state: held.state, lastError: held.lastError, spentUntil: held.spentUntil,
          ...(held.usage === null ? {} : { usage: held.usage as Prisma.InputJsonValue, usageReadAt: held.usageReadAt }),
        },
      });
      // …and no login pool token can name the person at all: 0324's fence to the pool's owner stands.
      await assert.rejects(
        db.poolLoginToken.create({
          data: { tokenHash: `pool-security-${randomUUID()}`, poolId: pool.id, userId: member, sessionId: gone, expiresAt: new Date(Date.now() + 60_000) },
        }),
        'a login pool token naming the person was stored',
      );
      assert.equal(await db.poolLoginToken.count({ where: { userId: member } }), 0);

      // The positive control: the owner's same three doors land on her account, on a login pool token, and
      // reach the ChatGPT backend on that account.
      for (const { door, sessionId, payload, env } of await threeDoors(owner, 'codex-owner', null)) {
        const token = env?.OPENAI_API_KEY ?? '';
        assert.match(token, /^orbit-gwl-/, `${door}: not a login pool token`);
        assert.deepEqual(secretsIn(payload), [], `${door}: the runner was handed a credential of the pool`);
        assert.equal(await db.poolLoginToken.count({ where: { userId: owner, sessionId } }) > 0, true, `${door}: no login pool token`);
        assert.deepEqual(await onPool(sessionId), { poolCodexAccountId: accountId, poolKeyId: null }, `${door}: the session's credential`);
        const sent = await gateway.send(token);
        assert.equal(sent.status, 200, `${door}: ${sent.code}`);
        assert.deepEqual(sent.upstream, [
          { path: '/backend-api/codex/responses', authorization: `Bearer ${login.access}`, account: accountId },
        ], door);
      }
    } finally {
      await gateway.close();
    }
  });

  await t.test("(C) no providers or pool response carries a credential — every route, refusals included; only the owner's own reveal does", async () => {
    const meteredRow = await account(db, alice, 'Metered', metered());
    await track();
    // The pickers, the management lists and the pools, for both owners; the vendor catalogue.
    for (const person_ of [alice, bob]) {
      await ask(person_, 'GET', 'providers', {}, undefined, 200);
      await ask(person_, 'GET', 'providers/mine', {}, undefined, 200);
      await ask(person_, 'GET', 'providers/pools', {}, undefined, 200);
    }
    await ask(alice, 'GET', 'providers/presets', {}, undefined, 200);
    // A shared provider, which only an admin manages and whose key nobody reads back.
    const shared = await ask(admin, 'POST', 'admin/providers', {}, { label: `Shared ${randomUUID()}`, baseUrl: ANTHROPIC, apiKey: subscription() }, 201);
    const sharedId = String(shared.json.id);
    await ask(admin, 'GET', 'admin/providers', {}, undefined, 200);
    await ask(bob, 'GET', 'admin/providers', {}, undefined, 403);
    // The one body that exists to carry a key: its owner's own, on the reveal route.
    const reveal = await ask(alice, 'GET', 'providers/mine/:id/key', { id: pub(personal) }, undefined, 200);
    // …and on that route nobody gets anyone else's: another owner's provider, a pool, a shared provider.
    await ask(bob, 'GET', 'providers/mine/:id/key', { id: pub(personal) }, undefined, 404);
    await ask(alice, 'GET', 'providers/mine/:id/key', { id: uuidToBase62(alicePool.id) }, undefined, 404);
    await ask(alice, 'GET', 'providers/mine/:id/key', { id: sharedId }, undefined, 404);
    // A key typed into the connect form is probed with, not echoed.
    await ask(alice, 'POST', 'providers/test', {}, { baseUrl: ANTHROPIC, apiKey: subscription(), model: 'claude-opus-5', runtime: 'claude' }, 201);
    // One of her own connected, its key rotated, then deleted.
    const spare = await ask(alice, 'POST', 'providers/mine', {}, { label: 'Spare', baseUrl: ANTHROPIC, apiKey: subscription() }, 201);
    const spareId = String(spare.json.id);
    await ask(alice, 'PATCH', 'providers/mine/:id', { id: spareId }, { apiKey: subscription() }, 200);
    // A pool made, refused a metered key, refused to another owner, added to, emptied and deleted.
    const scratch = await ask(alice, 'POST', 'providers/pools', {}, { label: 'Scratch', providerIds: [spareId] }, 201);
    const scratchId = String(scratch.json.id);
    await ask(alice, 'POST', 'providers/pools', {}, { label: 'With a metered key', providerIds: [pub(meteredRow)] }, 400);
    await ask(bob, 'POST', 'providers/pools', {}, { label: 'With her key', providerIds: [pub(personal)] }, 404);
    await ask(alice, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(work) }, 201);
    await ask(alice, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(meteredRow) }, 400);
    await ask(bob, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(theirs) }, 404);
    // A member paused and resumed by her (migration 0374); another owner finds no pool to pause it in.
    const scratchMember = { id: scratchId, memberId: pub(work) };
    await ask(alice, 'POST', 'providers/pools/:id/members/:memberId/pause', scratchMember, { durationMinutes: 60 }, 201);
    await ask(alice, 'POST', 'providers/pools/:id/members/:memberId/pause', scratchMember, { durationMinutes: null }, 201);
    await ask(bob, 'POST', 'providers/pools/:id/members/:memberId/pause', scratchMember, { durationMinutes: 60 }, 404);
    await ask(alice, 'DELETE', 'providers/pools/:id/members/:providerId', { id: scratchId, providerId: pub(work) }, undefined, 200);
    await ask(alice, 'DELETE', 'providers/pools/:id', { id: scratchId }, undefined, 200);
    // A pool of hers on Codex, which runs on one ChatGPT login this server holds and signs in itself
    // (migration 0323), with that login written straight into the table: the four routes that read or
    // change the account answer her, another owner gets the 404 a pool that does not exist gets, and no
    // body among them repeats either token — both ciphertexts are in `ciphertexts` from here on.
    const codexPool = await ask(alice, 'POST', 'providers/pools', {}, { label: 'My ChatGPT', engine: 'codex' }, 201);
    const codexPoolId = String(codexPool.json.id);
    const codexTokens = { access: `codex-access-${randomUUID()}`, refresh: `codex-refresh-${randomUUID()}` };
    await db.poolCodexLogin.create({
      data: {
        poolId: toUuid(codexPoolId),
        userId: alice,
        accountId: randomUUID(),
        email: 'owner@codex-login.invalid',
        plan: 'plus',
        accessTokenEnc: encryptSecret(codexTokens.access),
        refreshTokenEnc: encryptSecret(codexTokens.refresh),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await track();
    const loginPage = await ask(alice, 'GET', 'providers/pools/:id', { id: codexPoolId }, undefined, 200);
    await ask(bob, 'GET', 'providers/pools/:id', { id: codexPoolId }, undefined, 404);
    await ask(alice, 'GET', 'providers/pools/:id/codex-login', { id: codexPoolId }, undefined, 200);
    await ask(bob, 'GET', 'providers/pools/:id/codex-login', { id: codexPoolId }, undefined, 404);
    await ask(alice, 'DELETE', 'providers/pools/:id/codex-login', { id: codexPoolId }, undefined, 200);
    // The sign-in door on a pool that holds no login of that kind: a Claude pool of hers is not a login
    // pool, so it answers as no pool at all — and nothing is spawned for a request it refuses.
    await ask(alice, 'POST', 'providers/pools/:id/codex-login', { id: uuidToBase62(alicePool.id) }, undefined, 404);
    await ask(alice, 'DELETE', 'providers/pools/:id/codex-login/account', { id: codexPoolId }, undefined, 200);
    // The positive half: the page really does name that account, so the sweep above is checking bodies
    // that carry something rather than four 404s — and what it names it by is the email and the masked
    // account id, never the pair the tokens are in.
    assert.deepEqual(
      { email: loginPage.json.login?.email, state: loginPage.json.login?.state, plan: loginPage.json.login?.plan },
      { email: 'owner@codex-login.invalid', state: 'ACTIVE', plan: 'plus' },
      'the pool page reads the account it runs on',
    );
    assert.equal(loginPage.json.login?.fingerprint.length, 5, 'an account is named by its last four characters');
    assert.deepEqual(
      [codexTokens.access, codexTokens.refresh].filter((token) => loginPage.text.includes(token)),
      [],
      'the pool page carried a token in the clear',
    );
    await ask(alice, 'DELETE', 'providers/mine/:id', { id: spareId }, undefined, 200);
    // The runner's doors onto the same rows (`orbit provider create|update|delete`): one of hers
    // connected from her machine, its key rotated and the row deleted by the slug the list shows —
    // and another owner's runner, naming that slug, turned away as if it did not exist.
    const fromRunner = await ask(
      aliceHome.runnerToken,
      'POST',
      'runner/providers',
      {},
      { label: 'From her runner', baseUrl: ANTHROPIC, apiKey: subscription(), models: [{ value: 'claude-opus-5', label: 'Opus 5' }] },
      201,
    );
    const bySlug = { slug: String(fromRunner.json.slug) };
    await ask(aliceHome.runnerToken, 'PATCH', 'runner/providers/:slug', bySlug, { apiKey: subscription() }, 200);
    await ask(bobHome.runnerToken, 'PATCH', 'runner/providers/:slug', bySlug, { apiKey: subscription() }, 404);
    await ask(bobHome.runnerToken, 'DELETE', 'runner/providers/:slug', bySlug, undefined, 404);
    await ask(aliceHome.runnerToken, 'DELETE', 'runner/providers/:slug', bySlug, undefined, 200);
    await ask(admin, 'PATCH', 'admin/providers/:id', { id: sharedId }, { apiKey: subscription() }, 200);
    await ask(admin, 'DELETE', 'admin/providers/:id', { id: sharedId }, undefined, 200);

    // The check sees a key where there is one: the reveal, caught as exactly that.
    assert.deepEqual(credentialsIn(reveal.text, ciphertexts), ['an sk-ant key', 'a key field']);
    const leaks = answers
      .filter((answer) => answer !== reveal)
      .flatMap((answer) => {
        const found = credentialsIn(answer.text, ciphertexts);
        return found.length ? [`${answer.method} /api/${answer.route} as ${answer.who} → ${answer.status}: ${found.join(', ')}`] : [];
      });
    assert.deepEqual(leaks, [], 'responses carrying a credential');
    const pushed = broadcasts.filter((broadcast) => credentialsIn(wire(broadcast), ciphertexts).length > 0);
    assert.deepEqual(pushed, [], 'broadcasts carrying a credential');
    // And each was the answer its request should get: a body checked is only evidence if it is that one.
    assert.deepEqual(answers.filter((answer) => answer.status !== answer.expected).map(statusOf), []);
    assert.equal(reveal.json.apiKey, personal.key);
  });

  await t.test("(C) a person she added to a pool of her ChatGPT accounts reads them at any route as she does — they run their sessions too (2026-10-03) — bar OpenAI's own id of an account, which no response names to anyone", async () => {
    const owner = await person(db, 'chatgpt-owner');
    const member = await person(db, 'chatgpt-member');
    const ownerAt = await machine(db, owner, 'chatgpt-owner');
    const memberAt = await machine(db, member, 'chatgpt-member');
    names
      .set(owner, 'the ChatGPT pool owner')
      .set(member, 'a person in her ChatGPT pool')
      .set(ownerAt.runnerToken, "the ChatGPT pool owner's runner")
      .set(memberAt.runnerToken, "her ChatGPT pool person's runner");
    const poolKeys: string[] = [];
    const openaiKey = () => {
      const key = `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
      poolKeys.push(key);
      return key;
    };

    // Her Codex pool, made through the browser's door, and two ChatGPT accounts in it as the sign-in and the
    // pool gateway leave them: one running, with the quota the backend's last answer carried; one OpenAI
    // signed out, with its words for why. Each value a page could show of them is one nothing else here
    // prints, so finding it in a body is finding the account.
    const made = await call(owner, 'POST', 'providers/pools', {}, { label: 'Codex Pool', engine: 'codex' }, 201);
    const pool = await db.providerPool.findUniqueOrThrow({
      where: { id: toUuid(String(made.json.id)) },
      select: { id: true, slug: true },
    });
    const resetsIn = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const accounts = [
      {
        accountId: `acct-${randomUUID()}-QZ7Y`,
        email: `running-${randomUUID()}@chatgpt-account.invalid`,
        plan: `plan-${randomUUID()}`,
        state: 'ACTIVE',
        lastError: null,
        usage: {
          provider: 'codex',
          primary: { utilization: 6, resetsAt: resetsIn(2), windowDurationMins: 300 },
          secondary: { utilization: 97, resetsAt: resetsIn(80), windowDurationMins: 10080 },
        },
      },
      {
        accountId: `acct-${randomUUID()}-WX5V`,
        email: `signed-out-${randomUUID()}@chatgpt-account.invalid`,
        plan: `plan-${randomUUID()}`,
        state: 'SIGNED_OUT',
        lastError: `Your refresh token was revoked ${randomUUID()}`,
        usage: null,
      },
    ];
    const tokens: string[] = [];
    for (const { usage, ...account } of accounts) {
      const pair = { access: `codex-access-${randomUUID()}`, refresh: `codex-refresh-${randomUUID()}` };
      tokens.push(pair.access, pair.refresh);
      await db.poolCodexLogin.create({
        data: {
          ...account,
          ...(usage ? { usage, usageReadAt: new Date() } : {}),
          poolId: pool.id,
          userId: owner,
          accessTokenEnc: encryptSecret(pair.access),
          refreshTokenEnc: encryptSecret(pair.refresh),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }
    /** What a page shows of each account — its owner's to read and nobody else's. */
    const onlyHers = accounts.flatMap((account) => [
      { what: 'an email', value: account.email },
      { what: 'a plan', value: account.plan },
      { what: 'a fingerprint', value: `…${account.accountId.slice(-4)}` },
      ...(account.usage
        ? [account.usage.primary, account.usage.secondary].map((window) => ({ what: 'a quota', value: window.resetsAt }))
        : []),
      ...(account.lastError ? [{ what: 'a last error', value: account.lastError }] : []),
      // OpenAI's own id of the account, which no response names, hers included.
      { what: 'an account id', value: account.accountId },
    ]);
    const readIn = (text: string) => onlyHers.filter(({ value }) => text.includes(value)).map(({ what }) => what);
    const signedIn = () =>
      db.poolCodexLogin.findMany({
        where: { poolId: pool.id },
        orderBy: { accountId: 'asc' },
        select: { accountId: true, state: true },
      });
    const before = await signedIn();
    await track();

    // The person, by the email of their Orbit account, and one API key of hers: what they run on.
    const { email: memberEmail } = await db.user.findUniqueOrThrow({ where: { id: member }, select: { email: true } });
    const at = { id: uuidToBase62(pool.id) };
    await call(owner, 'POST', 'providers/shared-pools/:id/people', at, { email: memberEmail }, 201);
    await call(owner, 'POST', 'providers/shared-pools/:id/keys', at, { label: 'orbit-org-1', apiKey: openaiKey() }, 201);

    // Their session on it, opened through the session door, claimed by their runner and read back as their
    // session pages read it.
    const opened = await sessions.create(member, { prompt: 'hello', title: 'on her pool', workspaceId: memberAt.workspaceId, provider: pool.slug });
    const theirSession = {
      claimed: await claim(memberAt.runnerId, opened.id),
      read: await sessions.get(member, opened.id),
      listed: await sessions.list(member, { workspaceId: memberAt.workspaceId }),
    };

    // A sign-in she starts runs a stand-in for the codex CLI, which prints its page and code and waits:
    // nothing here reaches OpenAI.
    const work = await mkdtemp(join(tmpdir(), 'pool-security-codex-'));
    const cli = join(work, 'codex');
    await writeFile(
      cli,
      `#!/usr/bin/env bash
printf '1. Open this link in your browser and sign in to your account\\r\\n   https://auth.openai.com/codex/device\\r\\n\\r\\n'
printf '2. Enter this one-time code (expires in 15 minutes)\\r\\n   POOL-5PEC1\\r\\n\\r\\n'
exec sleep 300
`,
      { mode: 0o755 },
    );
    const bin = process.env.CODEX_LOGIN_BIN;
    process.env.CODEX_LOGIN_BIN = cli;

    type Who = 'person' | 'owner';
    const asked: Record<Who, Answer[]> = { person: [], owner: [] };
    /**
     * Every route the providers controllers declare, asked by `who` — at her pool wherever one takes a
     * pool's id or slug — in an order that leaves the pool standing to the end: the reads; her pool where a
     * provider's id or slug goes; what each of them makes of their own; her pool's rules, people and keys;
     * and last, what takes something out of it. The two doors that delete a pool are asked about one the
     * asker made just before: asked about hers, they would refuse the person as every door below that would
     * change it does — and for her, delete it before the rest of the sweep had read it.
     */
    async function sweep(who: Who) {
      const bearer = who === 'person' ? member : owner;
      const runner = who === 'person' ? memberAt.runnerToken : ownerAt.runnerToken;
      const by = (forThePerson: number, forHer: number) => (who === 'person' ? forThePerson : forHer);
      const them = { ...at, userId: uuidToBase62(member) };
      const from = answers.length;

      // The pickers, the management lists, the catalogue, her pool's two pages, and a sign-in on it started,
      // polled and given up — each their own attempt since migration 0371, so the person starts one of
      // theirs here exactly as she does hers.
      await ask(bearer, 'GET', 'providers', {}, undefined, 200);
      await ask(bearer, 'GET', 'providers/mine', {}, undefined, 200);
      await ask(bearer, 'GET', 'providers/presets', {}, undefined, 200);
      await ask(bearer, 'GET', 'providers/pools', {}, undefined, 200);
      await ask(bearer, 'GET', 'providers/shared-pools', {}, undefined, 200);
      await ask(runner, 'GET', 'runner/providers', {}, undefined, 200);
      await ask(bearer, 'GET', 'admin/providers', {}, undefined, 403);
      await ask(bearer, 'GET', 'providers/pools/:id', at, undefined, by(404, 200));
      await ask(bearer, 'GET', 'providers/shared-pools/:id', at, undefined, 200);
      await ask(bearer, 'POST', 'providers/pools/:id/codex-login', at, undefined, 201);
      await ask(bearer, 'GET', 'providers/pools/:id/codex-login', at, undefined, 200);
      await ask(bearer, 'DELETE', 'providers/pools/:id/codex-login', at, undefined, 200);

      // Her pool where a provider's id or slug goes — a pool is no provider, to either of them — and its
      // members, which a Codex pool has none of.
      await ask(bearer, 'GET', 'providers/mine/:id/key', at, undefined, 404);
      await ask(bearer, 'PATCH', 'providers/mine/:id', at, { label: 'Renamed' }, 404);
      await ask(bearer, 'DELETE', 'providers/mine/:id', at, undefined, 404);
      await ask(bearer, 'POST', 'providers/pools/:id/members', at, { providerId: at.id }, 404);
      await ask(bearer, 'DELETE', 'providers/pools/:id/members/:providerId', { ...at, providerId: at.id }, undefined, by(404, 200));
      await ask(bearer, 'PATCH', 'admin/providers/:id', at, { label: 'Renamed' }, 403);
      await ask(bearer, 'DELETE', 'admin/providers/:id', at, undefined, 403);
      await ask(runner, 'PATCH', 'runner/providers/:slug', { slug: pool.slug }, { label: 'Renamed' }, 404);
      await ask(runner, 'DELETE', 'runner/providers/:slug', { slug: pool.slug }, undefined, 404);

      // What each of them makes of their own.
      await ask(bearer, 'POST', 'providers/test', {}, { baseUrl: ANTHROPIC, apiKey: subscription(), model: 'claude-opus-5', runtime: 'claude' }, 201);
      await ask(bearer, 'POST', 'providers/mine', {}, { label: 'Own', baseUrl: ANTHROPIC, apiKey: subscription() }, 201);
      await ask(
        runner,
        'POST',
        'runner/providers',
        {},
        { label: 'Own, from a runner', baseUrl: ANTHROPIC, apiKey: subscription(), models: [{ value: 'claude-opus-5', label: 'Opus 5' }] },
        201,
      );
      await ask(bearer, 'POST', 'admin/providers', {}, { label: 'Shared', baseUrl: ANTHROPIC, apiKey: subscription() }, 403);
      const ownPool = await ask(bearer, 'POST', 'providers/pools', {}, { label: 'Own pool', engine: 'codex' }, 201);
      await ask(bearer, 'DELETE', 'providers/pools/:id', { id: String(ownPool.json?.id) }, undefined, 200);
      const ownShared = await ask(bearer, 'POST', 'providers/shared-pools', {}, { label: 'Own shared pool' }, 201);
      await ask(bearer, 'DELETE', 'providers/shared-pools/:id', { id: String(ownShared.json?.id) }, undefined, 200);

      // Her pool's rules and people: hers to change.
      await ask(bearer, 'PATCH', 'providers/shared-pools/:id', at, { membersCanAdd: true }, by(403, 200));
      await ask(bearer, 'POST', 'providers/shared-pools/:id/people', at, { email: memberEmail }, by(403, 201));
      await ask(bearer, 'PATCH', 'providers/shared-pools/:id/people/:userId', them, { role: 'MEMBER' }, by(403, 200));
      // A key of their own put in, renamed, given a new secret and taken out: each answer the pool as they read it.
      const label = `the ${who}'s key`;
      const added = await ask(bearer, 'POST', 'providers/shared-pools/:id/keys', at, { label, apiKey: openaiKey() }, 201);
      const keyId = (added.json?.keys as Array<{ id: string; label: string }> | undefined)?.find((key) => key.label === label)?.id;
      const key = { ...at, keyId: String(keyId) };
      await ask(bearer, 'PATCH', 'providers/shared-pools/:id/keys/:keyId', key, { label: `${label}, renamed` }, 200);
      await ask(bearer, 'PUT', 'providers/shared-pools/:id/keys/:keyId/secret', key, { apiKey: openaiKey() }, 200);
      await ask(bearer, 'DELETE', 'providers/shared-pools/:id/keys/:keyId', key, undefined, 200);
      // Her running account paused and resumed (migration 0374), addressed by its `…AB12` as her page names
      // it: hers to pause, as the one who signed it in and the pool's admin; the person, who signed none of
      // hers in, is refused.
      const running = { ...at, memberId: encodeURIComponent(`login:…${accounts[0].accountId.slice(-4)}`) };
      await ask(bearer, 'POST', 'providers/pools/:id/members/:memberId/pause', running, { durationMinutes: 60 }, by(403, 201));
      await ask(bearer, 'POST', 'providers/pools/:id/members/:memberId/pause', running, { durationMinutes: null }, by(403, 201));

      // Last, what takes something out of her pool: an account — an admin's alone, so the person, who
      // signed none of hers in, is refused rather than not found (migration 0371) — the person, and the
      // person themselves.
      await ask(bearer, 'DELETE', 'providers/pools/:id/codex-login/account', at, undefined, by(403, 200));
      await ask(bearer, 'DELETE', 'providers/shared-pools/:id/people/:userId', them, undefined, by(403, 200));
      await ask(bearer, 'POST', 'providers/shared-pools/:id/leave', at, undefined, by(201, 403));
      asked[who] = answers.slice(from);
    }

    try {
      await sweep('person');
      // Nothing the person was refused took anything of hers: both accounts are there, as they were.
      assert.deepEqual(await signedIn(), before, 'a door the person was refused at changed her accounts');
      await sweep('owner');
    } finally {
      if (bin === undefined) delete process.env.CODEX_LOGIN_BIN;
      else process.env.CODEX_LOGIN_BIN = bin;
      await rm(work, { recursive: true, force: true });
    }

    // Their session read says nothing of her accounts — which account it runs on is not a session field to
    // anyone — and nothing pushed to them names one either.
    assert.deepEqual(readIn(wire(theirSession)), [], 'what their session on her pool says of her ChatGPT accounts');
    assert.deepEqual(
      broadcasts.filter((broadcast) => broadcast.includes(member)).flatMap((broadcast) => readIn(wire(broadcast))),
      [],
      'what was pushed to the person of her ChatGPT accounts',
    );
    // The person's pages read the accounts as hers do: each email, plan, `…AB12`, quota and last error is in
    // an answer they got — that is what the pool's page shows them now.
    const answered = (who: Who, method: string, route: string) =>
      asked[who].find((answer) => answer.method === method && answer.route === route)?.json;
    const seenByPerson = new Set(
      asked.person.flatMap((answer) => onlyHers.filter(({ value }) => answer.text.includes(value)).map(({ what }) => what)),
    );
    assert.deepEqual(
      onlyHers.filter((item) => !seenByPerson.has(item.what)).map(({ what }) => what),
      accounts.map(() => 'an account id'),
      'what the person did not read of her ChatGPT accounts',
    );
    // Both of them, and a pool the person made with no account in it: `logins` is the accounts themselves,
    // and empties of them where there are none.
    const pageOne = answered('person', 'GET', 'providers/shared-pools/:id') as { logins?: Array<{ email: string | null }> };
    assert.deepEqual(
      pageOne.logins?.map((account) => account.email).sort(),
      accounts.map((account) => account.email).sort(),
    );
    const listed = (answered('person', 'GET', 'providers/shared-pools') as Array<{ id: string; logins: unknown[] }>)
      .find((p) => p.id === at.id);
    assert.equal(listed?.logins?.length, accounts.length);
    assert.deepEqual(answered('person', 'POST', 'providers/shared-pools')?.logins, []);

    // The positive control: her own same requests read every one of those too — and no request of either of
    // them names OpenAI's id of an account, which is nobody's to read.
    for (const who of ['owner', 'person'] as const) {
      const shown = new Set(asked[who].flatMap((answer) => onlyHers.filter(({ value }) => answer.text.includes(value))));
      assert.deepEqual(
        onlyHers.filter((item) => !shown.has(item)).map(({ what, value }) => `${what}: ${value}`),
        accounts.map((account) => `an account id: ${account.accountId}`),
        `what the ${who}'s requests did not read of her ChatGPT accounts`,
      );
    }

    // No answer to either of them carries a credential: a token of her accounts or an OpenAI key, in the
    // clear or as stored.
    const secrets = [...tokens, ...poolKeys];
    assert.deepEqual(
      [...asked.person, ...asked.owner].flatMap((answer) => {
        const found = [
          ...credentialsIn(answer.text, ciphertexts),
          ...secrets.filter((secret) => answer.text.includes(secret)).map(() => 'a token or a key in the clear'),
        ];
        return found.length ? [`${answer.method} /api/${answer.route} as ${answer.who} → ${answer.status}: ${found.join(', ')}`] : [];
      }),
      [],
      'responses carrying a credential',
    );
    // Each was the answer its request should get, and each of them asked every route there is.
    assert.deepEqual([...asked.person, ...asked.owner].filter((answer) => answer.status !== answer.expected).map(statusOf), []);
    const declared = routesOf(ProvidersController, AdminProvidersController, RunnerProvidersController, SharedPoolsController);
    for (const who of ['person', 'owner'] as const) {
      const swept = new Set(asked[who].map((answer) => `${answer.method} ${answer.route}`));
      assert.deepEqual(declared.filter((route) => !swept.has(route)), [], `routes the ${who} never asked`);
    }
  });

  await t.test('(C) …and those responses are every route the providers controllers declare', () => {
    const declared = routesOf(ProvidersController, AdminProvidersController, RunnerProvidersController, SharedPoolsController);
    assert.ok(declared.length >= 18, `read only ${declared.length} routes off the controllers`);
    const swept = new Set(answers.map((answer) => `${answer.method} ${answer.route}`));
    assert.deepEqual(
      declared.filter((route) => !swept.has(route)),
      [],
      'routes whose responses were never checked for a credential — call them in (C)',
    );
  });

  await t.test("(D) the key is decrypted into the job env at the claim, and lands nowhere at rest: not an agent's env, not any table", async () => {
    // Positive control: the claim does carry it — Personal's, the most 5-hour room — beside the agent's own env.
    const at = await machine(db, alice, 'alice-claims');
    const session = await queued(db, alice, at, alicePool.slug);
    const claimed = await claim(at.runnerId, session);
    assert.equal(token(claimed.agent.env), personal.key);
    assert.equal(claimed.agent.env?.ORBIT_POOL_SECURITY_AGENT, at.label);
    // Rotated, the next claim carries the new key: decrypted from the row at the claim, kept nowhere.
    const rotated = subscription();
    await providers.update(alice, personal.row.id, { apiKey: rotated });
    await db.session.update({ where: { id: session }, data: { status: RunStatus.PENDING } });
    assert.equal(token((await claim(at.runnerId, session)).agent.env), rotated);

    // Every agent this spec made holds exactly the env it was configured with, after every door above.
    const agents = await db.workspace.findMany({
      where: { id: { in: [...configuredEnv.keys()] } },
      select: { id: true, name: true, env: true },
    });
    assert.equal(agents.length, configuredEnv.size);
    for (const agent of agents) assert.deepEqual(agent.env, configuredEnv.get(agent.id), `${agent.name}'s env`);

    // The sweep sees a key where one lands: planted in an agent's env, in a transaction rolled back.
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE workspace SET env = jsonb_build_object('ANTHROPIC_AUTH_TOKEN', $1::text) WHERE id = $2::uuid`, [
        rotated,
        at.workspaceId,
      ]);
      assert.deepEqual(await tablesHoldingAKey(client), ['workspace']);
    } finally {
      await client.query('ROLLBACK');
    }
    // A provider's key is at rest as ciphertext only; nothing else holds one at all.
    assert.deepEqual(await tablesHoldingAKey(client), [], 'tables holding a key in the clear');
  });
});
