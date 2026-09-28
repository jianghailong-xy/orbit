/**
 * A shared pool's keys on real PostgreSQL (migration 0321) — what putting an organization/project OpenAI
 * key in does with it, and who may touch it after:
 *
 *  (a) A key is checked for its shape — an OpenAI key, not an Anthropic one and not an admin key — and a
 *      refusal never repeats what was typed.
 *  (b) At rest the key is ciphertext under PROVIDER_SECRET_KEY and nothing else; every answer names it
 *      `sk-…` and its last four characters.
 *  (c) A key goes into a pool once: a second add, by anyone, is refused by its fingerprint and says who
 *      put it in; another pool takes it.
 *  (d) Its contributor, and only they, changes its label, its share cap and its switch.
 *  (e) OpenAI's 401 marks it INVALID (SharedPoolsService.markKeyInvalid, the gateway's to call), and
 *      only its contributor or an admin replaces it — a replacement is checked like a new key, and the
 *      key is ACTIVE again.
 *  (f) No answer of any route the controller declares — refusals included — no broadcast and no log line
 *      carries a key in the clear, a stored ciphertext or a fingerprint.
 *
 * Everything between the rows and the answers is production code: SharedPoolsController behind real
 * HTTP with main.ts's pipe, interceptors and filter, SharedPoolsService and ProvidersService. Only the
 * check of a person's signed token is a stand-in. It only adds rows, and refuses to run anywhere but the
 * disposable server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { LoggerService, Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
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
import { RealtimeService } from '../realtime/realtime.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { decryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import { SharedPoolsController } from './shared-pools.controller';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'shared-pool-keys-spec';

/** Every key this spec types, well-formed or not: none may come back out anywhere. */
const TYPED = new Set<string>();
const typed = (key: string) => (TYPED.add(key), key);
const hex = () => randomUUID().replace(/-/g, '');
const openaiKey = () => typed(`sk-proj-${hex()}${hex()}`);

/** Every broadcast the code under test makes. */
const broadcasts: unknown[][] = [];
const realtime = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'then' ? undefined : (...args: unknown[]) => void broadcasts.push([String(key), ...args]),
  },
) as RealtimeService;

/** Every line the server logs while this spec runs. */
const logged: string[] = [];
const recordingLogger: LoggerService = {
  log: (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
  error: (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')),
  warn: (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
  debug: (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
  verbose: (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
  fatal: (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
};

interface Person {
  name: string;
  id: string;
  email: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const email = `${name}-${id}@shared-pool-keys.invalid`;
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  return { name, id, email };
}

/** Every route the controller declares, as `METHOD path/with/:params`. */
function routesOf(controller: new (...args: never[]) => unknown): string[] {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    if (typeof handler !== 'function' || name === 'constructor') return [];
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (path === undefined) return [];
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
    return [`${method} ${[prefix, path].filter((part) => part && part !== '/').join('/')}`];
  });
}

const doorsOver: { pools: unknown; prisma: unknown } = { pools: null, prisma: null };

@Module({
  controllers: [SharedPoolsController],
  providers: [
    { provide: SharedPoolsService, useFactory: () => doorsOver.pools },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class Doors {}

async function openDoors() {
  const app = await NestFactory.create(Doors, { logger: recordingLogger, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

interface Answer {
  method: string;
  route: string;
  who: string;
  status: number;
  text: string;
  json: any;
}

const suite = URL ? test : test.skip;

suite("a shared pool's keys: in once, at rest encrypted, out nowhere — on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const providers = new ProvidersService(prisma, realtime, new ProviderPlanUsageService(realtime));
  const pools = new SharedPoolsService(prisma, realtime, providers);
  doorsOver.pools = pools;
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    await db.$disconnect();
    await client.end();
  });

  /** Every ciphertext and fingerprint a key row has held while this spec ran, replaced ones included. */
  const ciphertexts = new Set<string>();
  const fingerprints = new Set<string>();
  const track = async () => {
    for (const row of await db.poolApiKey.findMany({ select: { secretEncrypted: true, keyFingerprint: true } })) {
      ciphertexts.add(row.secretEncrypted);
      fingerprints.add(row.keyFingerprint);
    }
  };
  const names = new Map<string, string>();
  const answers: Answer[] = [];
  async function ask(
    bearer: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    route: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<Answer> {
    const path = route.replace(/:(\w+)/g, (_, param: string) => params[param] ?? assert.fail(`no ${param} for ${route}`));
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
    const answer = { method, route, who: names.get(bearer) ?? bearer, status: response.status, text, json };
    answers.push(answer);
    await track();
    return answer;
  }
  async function call(expected: number, ...args: Parameters<typeof ask>): Promise<Answer> {
    const answer = await ask(...args);
    assert.equal(answer.status, expected, `${answer.method} ${answer.route} as ${answer.who} → ${answer.status}: ${answer.text}`);
    return answer;
  }

  const ann = await person(db, 'Ann');
  const adam = await person(db, 'Adam');
  const mia = await person(db, 'Mia');
  const max = await person(db, 'Max');
  const otto = await person(db, 'Otto');
  for (const p of [ann, adam, mia, max, otto]) names.set(p.id, p.name);

  const ROOT = 'providers/shared-pools';
  const created = await call(201, ann.id, 'POST', ROOT, {}, { label: 'Team Codex' });
  const poolId = toUuid(String(created.json.id));
  const pool = { id: poolId };
  for (const [who, role] of [[adam, 'ADMIN'], [mia, 'MEMBER'], [max, 'MEMBER']] as const) {
    await call(201, ann.id, 'POST', `${ROOT}/:id/people`, pool, { email: who.email, role });
  }
  const keyRow = (id: string) => db.poolApiKey.findUniqueOrThrow({ where: { id } });
  const keyIn = (answer: Answer, id: string) =>
    (answer.json.keys as Array<{ id: string }>).find((key) => toUuid(key.id) === id) as any;
  const rowsOf = (who: Person) => db.poolApiKey.findMany({ where: { poolId, contributorId: who.id } });

  await t.test('(a) a key is checked for its shape, and a refusal does not repeat what was typed', async () => {
    for (const bad of [
      typed('not-a-key'),
      typed(`sk-ant-oat01-${hex()}${hex()}`),
      typed(`sk-admin-${hex()}${hex()}`),
      typed('sk-short'),
      typed(`sk-proj-${hex()} ${hex()}`),
    ]) {
      const refused = await call(400, mia.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Mia', apiKey: bad });
      assert.equal(refused.json.code, 'POOL_KEY_FORMAT', refused.text);
      assert.equal(refused.text.includes(bad), false, 'the refusal repeated the key');
    }
    await call(400, mia.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Mia', apiKey: '' });
    assert.deepEqual(await rowsOf(mia), [], 'a refused key was written');
    // Whitespace around a pasted key is not part of it.
    const key = openaiKey();
    const added = await call(201, mia.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Mia', apiKey: `  ${key}\n` });
    const [row] = await rowsOf(mia);
    assert.equal(decryptSecret(row.secretEncrypted), key);
    assert.equal(keyIn(added, row.id).fingerprint, `sk-…${key.slice(-4)}`);
  });

  await t.test('(b) at rest a key is ciphertext and nothing else; every answer names it sk-… and its last four', async () => {
    const key = openaiKey();
    const added = await call(201, ann.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Ann · team', apiKey: key, shareCap: 40 });
    const [row] = await rowsOf(ann);
    assert.equal(decryptSecret(row.secretEncrypted), key);
    assert.notEqual(row.secretEncrypted, key);
    assert.equal(row.keyFingerprint, sha256(key));
    assert.equal(row.keyHint, key.slice(-4));
    const shown = keyIn(added, row.id);
    assert.deepEqual(
      {
        label: shown.label,
        fingerprint: shown.fingerprint,
        state: shown.state,
        enabled: shown.enabled,
        shareCap: shown.shareCap,
        contributor: [toUuid(shown.contributor.userId), shown.contributor.name, shown.contributor.you],
      },
      {
        label: 'Ann · team',
        fingerprint: `sk-…${key.slice(-4)}`,
        state: 'ACTIVE',
        enabled: true,
        shareCap: 40,
        contributor: [ann.id, 'Ann', true],
      },
    );
    // No table holds the key in the clear: every row of every table, read as text.
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    assert.ok(tables.some((table) => table.name === 'pool_api_key'), 'the sweep did not read pool_api_key');
    for (const { name } of tables) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" AS r WHERE strpos(r::text, $1) > 0`,
        [key],
      );
      assert.equal(rows[0].n, 0, `${name} holds the key in the clear`);
    }
  });

  await t.test('(c) a key goes into a pool once — a second add by anyone is refused by its fingerprint, naming who put it in; another pool takes it', async () => {
    const key = openaiKey();
    await call(201, mia.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Mia · second', apiKey: key });
    for (const [who, attempt] of [[mia, key], [ann, key], [max, ` ${key} `]] as const) {
      const refused = await call(409, who.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'again', apiKey: attempt });
      assert.equal(refused.json.code, 'POOL_KEY_DUPLICATE', refused.text);
      assert.match(refused.json.message, /Mia put it in/);
    }
    assert.equal(await db.poolApiKey.count({ where: { poolId, keyFingerprint: sha256(key) } }), 1);
    const other = await call(201, ann.id, 'POST', ROOT, {}, { label: 'Other team' });
    const otherId = toUuid(String(other.json.id));
    await call(201, ann.id, 'POST', `${ROOT}/:id/keys`, { id: otherId }, { label: 'Same key, other pool', apiKey: key });
    assert.equal(await db.poolApiKey.count({ where: { keyFingerprint: sha256(key) } }), 2);
  });

  await t.test("(d) a key's label, share cap and switch are its contributor's to change, and nobody else's", async () => {
    const [mine] = await rowsOf(mia);
    const at = { id: poolId, keyId: mine.id };
    const before = await keyRow(mine.id);
    await call(403, ann.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { label: 'Taken over', enabled: false, shareCap: 0 });
    await call(403, max.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { label: 'Taken over', enabled: false, shareCap: 0 });
    await call(404, otto.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { label: 'Taken over', enabled: false, shareCap: 0 });
    assert.deepEqual(await keyRow(mine.id), before);

    const changed = await call(200, mia.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { label: 'Mia · capped', shareCap: 25, enabled: false });
    assert.deepEqual(
      (({ label, shareCap, enabled }) => ({ label, shareCap, enabled }))(keyIn(changed, mine.id)),
      { label: 'Mia · capped', shareCap: 25, enabled: false },
    );
    const cleared = await call(200, mia.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { shareCap: null, enabled: true });
    assert.deepEqual(
      (({ label, shareCap, enabled }) => ({ label, shareCap, enabled }))(keyIn(cleared, mine.id)),
      { label: 'Mia · capped', shareCap: null, enabled: true },
    );
    // A cap is whole dollars, and not below nothing.
    await call(400, mia.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { shareCap: -1 });
    await call(400, mia.id, 'PATCH', `${ROOT}/:id/keys/:keyId`, at, { shareCap: 2.5 });
  });

  await t.test('(e) a 401 marks a key INVALID; only its contributor or an admin replaces it, and it is ACTIVE again', async () => {
    const [mine] = await rowsOf(mia);
    const at = { id: poolId, keyId: mine.id };
    assert.equal(await pools.markKeyInvalid(mine.id), true);
    assert.equal(await pools.markKeyInvalid(mine.id), false, 'a key already INVALID was marked again');
    assert.equal(await pools.markKeyInvalid(randomUUID()), false);
    const seen = await call(200, max.id, 'GET', `${ROOT}/:id`, pool);
    assert.equal(keyIn(seen, mine.id).state, 'INVALID');

    const invalid = await keyRow(mine.id);
    await call(403, max.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: openaiKey() });
    await call(404, otto.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: openaiKey() });
    assert.deepEqual(await keyRow(mine.id), invalid, 'somebody other than its contributor or an admin replaced it');

    // Her own replacement — checked like a new key first.
    await call(400, mia.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: typed(`sk-ant-api03-${hex()}${hex()}`) });
    const [annKey] = await rowsOf(ann);
    const annSecret = decryptSecret(annKey.secretEncrypted);
    const taken = await call(409, mia.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: annSecret });
    assert.equal(taken.json.code, 'POOL_KEY_DUPLICATE');
    assert.equal(taken.text.includes(annSecret), false);
    assert.deepEqual(await keyRow(mine.id), invalid);

    const hers = openaiKey();
    const replaced = await call(200, mia.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: hers });
    let row = await keyRow(mine.id);
    assert.deepEqual(
      { state: row.state, secret: decryptSecret(row.secretEncrypted), fingerprint: row.keyFingerprint, contributor: row.contributorId },
      { state: 'ACTIVE', secret: hers, fingerprint: sha256(hers), contributor: mia.id },
    );
    assert.equal(keyIn(replaced, mine.id).fingerprint, `sk-…${hers.slice(-4)}`);
    assert.equal(keyIn(replaced, mine.id).state, 'ACTIVE');

    // An admin who did not put it in replaces it too — and it stays hers.
    assert.equal(await pools.markKeyInvalid(mine.id), true);
    const theirs = openaiKey();
    await call(200, adam.id, 'PUT', `${ROOT}/:id/keys/:keyId/secret`, at, { apiKey: theirs });
    row = await keyRow(mine.id);
    assert.deepEqual(
      { state: row.state, secret: decryptSecret(row.secretEncrypted), contributor: row.contributorId },
      { state: 'ACTIVE', secret: theirs, contributor: mia.id },
    );
  });

  await t.test('(f) the rest of the doors, so every route has answered: the list, a person added, a role, removals, leaving, deleting', async () => {
    await call(200, mia.id, 'GET', ROOT, {});
    await call(404, otto.id, 'GET', `${ROOT}/:id`, pool);
    await call(200, adam.id, 'PATCH', `${ROOT}/:id`, pool, { ownKeyFirst: false });
    await call(200, adam.id, 'PATCH', `${ROOT}/:id/people/:userId`, { id: poolId, userId: max.id }, { role: 'ADMIN' });
    await call(201, max.id, 'POST', `${ROOT}/:id/keys`, pool, { label: 'Max', apiKey: openaiKey() });
    const [maxKey] = await rowsOf(max);
    await call(403, mia.id, 'DELETE', `${ROOT}/:id/keys/:keyId`, { id: poolId, keyId: maxKey.id });
    await call(200, ann.id, 'DELETE', `${ROOT}/:id/keys/:keyId`, { id: poolId, keyId: maxKey.id });
    await call(200, ann.id, 'DELETE', `${ROOT}/:id/people/:userId`, { id: poolId, userId: max.id });
    await call(201, mia.id, 'POST', `${ROOT}/:id/leave`, pool);
    await call(403, ann.id, 'POST', `${ROOT}/:id/leave`, pool);
    await call(200, ann.id, 'DELETE', `${ROOT}/:id`, pool);
    await call(404, ann.id, 'GET', `${ROOT}/:id`, pool);
  });

  await t.test('(f) …and no answer, refusal, broadcast or log line of any of them carries a key, a ciphertext or a fingerprint', async () => {
    const declared = routesOf(SharedPoolsController);
    assert.equal(declared.length, 13, `read ${declared.length} routes off the controller`);
    const swept = new Set(answers.map((answer) => `${answer.method} ${answer.route}`));
    assert.deepEqual(declared.filter((route) => !swept.has(route)), [], 'routes whose answers were never checked');
    assert.ok(TYPED.size >= 10 && ciphertexts.size >= 6 && fingerprints.size >= 6, 'the sweep had almost nothing to look for');

    const leaksIn = (text: string): string[] => {
      const found: string[] = [];
      if ([...TYPED].some((key) => text.includes(key))) found.push('a typed key');
      if ([...ciphertexts].some((ciphertext) => text.includes(ciphertext))) found.push('a stored ciphertext');
      if ([...fingerprints].some((fingerprint) => text.includes(fingerprint))) found.push('a fingerprint');
      if (/"(?:apiKey|secretEncrypted|keyFingerprint)"\s*:/.test(text)) found.push('a key field');
      return found;
    };
    // The check sees each of them where there is one.
    const [someKey] = [...TYPED].slice(-1);
    const [someCiphertext] = [...ciphertexts];
    const [someFingerprint] = [...fingerprints];
    assert.deepEqual(leaksIn(JSON.stringify({ apiKey: someKey })), ['a typed key', 'a key field']);
    assert.deepEqual(leaksIn(`${someCiphertext} ${someFingerprint}`), ['a stored ciphertext', 'a fingerprint']);

    const leaks = answers.flatMap((answer) => {
      const found = leaksIn(answer.text);
      return found.length ? [`${answer.method} /api/${answer.route} as ${answer.who} → ${answer.status}: ${found.join(', ')}`] : [];
    });
    assert.deepEqual(leaks, [], 'answers carrying a key');
    assert.deepEqual(broadcasts.filter((broadcast) => leaksIn(JSON.stringify(broadcast)).length > 0), [], 'broadcasts carrying a key');
    assert.ok(broadcasts.length > 0, 'nothing was broadcast, so the check above read nothing');
    assert.deepEqual(logged.filter((line) => leaksIn(line).length > 0), [], 'log lines carrying a key');
    assert.ok(logged.length > 0, 'nothing was logged, so the check above read nothing');
  });
});
