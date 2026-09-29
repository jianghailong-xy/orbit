/**
 * The codex sign-in and the credential it leaves, on real PostgreSQL (migration 0323,
 * docs/codex-shared-pool-design.md §2.4–§2.5 read in this direction).
 *
 * The whole state machine is driven end to end here, against a stand-in for the CLI rather than the real
 * `codex`: the stand-in prints exactly what `codex login --device-auth` prints, waits in ITS CODEX_HOME
 * for the approval the person would give in a browser, and then leaves the `auth.json` a finished login
 * leaves. Everything between those two points is production code — the spawn, the throwaway CODEX_HOME,
 * the scrape, the deadline, the tree the CLI runs in — and only the token STRINGS are fixtures.
 *
 * What it holds to:
 *   * the state machine: start → PENDING (the page and the code) → the owner approves → CONFIRMED; the
 *     deadline running out → EXPIRED; a cancel → CANCELLED. Each of the last two takes the child with it
 *     and removes the directory the CLI was writing into;
 *   * at rest: the access and refresh tokens are ONLY ever ciphertext under PROVIDER_SECRET_KEY, and the
 *     plaintext is nowhere in the row;
 *   * what comes back out: an account is its email and `…AB12` — never the account id, never a token,
 *     never the ciphertext, asserted on the serialized answer;
 *   * one login per pool: the same account again is a 409, and so is a different one while an account is
 *     signed in; a SIGNED_OUT account is signed in AGAIN (the same row, not a second);
 *   * the fence: the database refuses a login naming anybody but the pool's owner, and every door here
 *     answers another owner's pool exactly as one that does not exist.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { CodexLoginService } from './codex-login.service';
import { decryptSecret } from './provider-crypto';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

/** What every stored token is encrypted under; any secret does in a throwaway database. */
process.env.PROVIDER_SECRET_KEY ??= 'codex-login-pg-spec';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`;

/** One ChatGPT account as a login leaves it: an id, an email, a plan, and its two tokens. */
function account(over: Partial<{ accountId: string; email: string; plan: string; exp: number; suffix: string }> = {}) {
  const accountId = over.accountId ?? randomUUID();
  const suffix = over.suffix ?? randomUUID().slice(0, 8);
  const exp = over.exp ?? Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60;
  const email = over.email ?? 'owner@example.invalid';
  const plan = over.plan ?? 'plus';
  const access = jwt({ email, exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } });
  return {
    accountId,
    access,
    refresh: `rt-${suffix}-${randomUUID()}`,
    email,
    plan,
    /** What the stored `expires_at` has to be: the access token's own claim. */
    expiresAt: new Date(exp * 1000),
  };
}

interface FakeCli {
  bin: string;
  /** The CODEX_HOME this stand-in was handed, as it reported it on starting — what it was given, and
   *  what is left of it afterwards. Waits for the line: the CLI is spawned, not awaited. */
  home: () => Promise<string>;
  /** The environment the stand-in was given, as `env` printed it — what this server does NOT hand a child. */
  childEnv: () => Promise<string>;
}

/**
 * A stand-in for `codex login --device-auth`: the CLI's own output (the page, then the one-time code
 * under the line that announces it), a wait for the approval — which the real CLI does by polling the
 * authorization server, and this one by watching for a file in the CODEX_HOME it was handed — and then
 * the `auth.json` a finished login leaves, before exiting 0.
 */
async function fakeCli(dir: string, code: string, login: ReturnType<typeof account>): Promise<FakeCli> {
  // One file per stand-in: two of them running in this spec must not read each other's homes.
  const homesFile = join(dir, `home-${randomUUID()}.txt`);
  const auth = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: login.access,
      access_token: login.access,
      refresh_token: login.refresh,
      account_id: login.accountId,
    },
    last_refresh: new Date().toISOString(),
  });
  const envFile = join(dir, `env-${randomUUID()}.txt`);
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$CODEX_HOME" >> ${JSON.stringify(homesFile)}
env > ${JSON.stringify(envFile)}
printf '\\r\\nWelcome to Codex [v0.146.0]\\r\\n\\r\\n'
printf '1. Open this link in your browser and sign in to your account\\r\\n   https://auth.openai.com/codex/device\\r\\n\\r\\n'
printf '2. Enter this one-time code (expires in 15 minutes)\\r\\n   ${code}\\r\\n\\r\\n'
while [ ! -f "$CODEX_HOME/approve" ]; do sleep 0.05; done
cat > "$CODEX_HOME/auth.json" <<'AUTHJSON'
${auth}
AUTHJSON
exit 0
`;
  const bin = join(dir, `codex-${randomUUID()}`);
  await writeFile(bin, script, { mode: 0o755 });
  return {
    bin,
    home: async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const line = (await readFile(homesFile, 'utf8').catch(() => '')).split('\n').find((entry) => entry !== '');
        if (line) return line;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return assert.fail('the stand-in never reported the CODEX_HOME it ran in');
    },
    childEnv: () => readFile(envFile, 'utf8').catch(() => ''),
  };
}

const suite = PG_URL ? test : test.skip;

suite('the codex sign-in and its credential, on real PostgreSQL', { timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const published: string[] = [];
  const realtime = {
    publishForUser: (userId: string, _type: unknown, id: string) => {
      published.push(`${userId}:${id}`);
    },
    publishForAllUsers: () => undefined,
  };
  const service = new CodexLoginService(prisma as unknown as PrismaService, realtime as never);
  t.after(() => service.onModuleDestroy());

  const work = await mkdtemp(join(tmpdir(), 'codex-login-pg-spec-'));
  const env = process.env.CODEX_LOGIN_BIN;
  t.after(() => {
    if (env === undefined) delete process.env.CODEX_LOGIN_BIN;
    else process.env.CODEX_LOGIN_BIN = env;
  });

  const newUser = async (label: string) => {
    const id = randomUUID();
    await prisma.user.create({
      data: { id, email: `${label}-${id}@codex-login.invalid`, name: label, passwordHash: 'x' },
    });
    return id;
  };
  const newPool = async (ownerId: string, engine = 'codex', label = 'Mine') => {
    const id = randomUUID();
    await prisma.providerPool.create({
      data: { id, slug: `codex-login-${randomUUID()}`, label, ownerId, engine, shared: false },
    });
    return id;
  };

  const owner = await newUser('owner');
  const stranger = await newUser('stranger');
  const pool = await newPool(owner);

  /** The pool's rows as the database holds them — the only place a token may be found. */
  const rows = (poolId = pool) => prisma.poolCodexLogin.findMany({ where: { poolId }, orderBy: { accountId: 'asc' } });

  /** Poll until the login reaches `want`; a terminal status other than `want` is returned as it is. */
  async function pollTo(poolId: string, want: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const answer = await service.poll(owner, poolId);
      if (answer.status === want || (answer.status !== 'PENDING' && answer.status !== want)) return answer;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return assert.fail(`the login never reached ${want}`);
  }
  /** Drive a whole login: start it, approve it, and take the answer the first poll after approval gives. */
  async function signIn(login: ReturnType<typeof account>, poolId = pool) {
    const cli = await fakeCli(work, `ZXHO-K06HC`, login);
    process.env.CODEX_LOGIN_BIN = cli.bin;
    const started = await service.start(owner, poolId);
    assert.equal(started.status, 'PENDING');
    const home = await cli.home();
    await writeFile(join(home, 'approve'), 'yes');
    const answer = await pollTo(poolId, 'CONFIRMED');
    return { answer, home, cli };
  }

  await t.test('the CLI is started in a directory of its own, and the person is shown the page and the code', async () => {
    const cli = await fakeCli(work, 'WXYZ4-8K2QP', account());
    process.env.CODEX_LOGIN_BIN = cli.bin;
    const started = await service.start(owner, pool);
    assert.equal(started.status, 'PENDING');
    assert.equal(started.userCode, 'WXYZ4-8K2QP');
    assert.equal(started.verificationUrl, 'https://auth.openai.com/codex/device');
    assert.ok(new Date(started.expiresAt).getTime() > Date.now(), 'the code is already expired');

    // The directory it was handed is empty before it starts: nothing to copy a login out of.
    const home = await cli.home();
    assert.ok(home.startsWith(tmpdir()), `the CLI ran in ${home}`);
    assert.deepEqual(await readFile(join(home, 'auth.json'), 'utf8').catch(() => null), null);

    // Before the owner approves, nothing is stored and the code is still the answer.
    const pending = await service.poll(owner, pool);
    assert.deepEqual(
      { status: pending.status, userCode: pending.userCode, account: pending.account },
      { status: 'PENDING', userCode: 'WXYZ4-8K2QP', account: null },
    );
    assert.deepEqual(await rows(), []);

    // The owner gives up on it instead: the attempt ends, and the child goes with it.
    const cancelled = await service.cancel(owner, pool);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.deepEqual(await rows(), [], 'a cancelled attempt stored something');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(home), false, 'the CLI’s directory was left behind');
    assert.equal((await service.poll(owner, pool)).status, 'NONE');
  });

  await t.test('the owner approves: the credential is stored encrypted, and the answer names the account by its email and four characters', async () => {
    const login = account({ email: 'owner@codex-login.invalid', plan: 'pro' });
    const { answer, home, cli } = await signIn(login);

    assert.equal(answer.status, 'CONFIRMED');
    const { linkedAt, ...accountView } = answer.account!;
    assert.deepEqual(accountView, {
      state: 'ACTIVE',
      email: 'owner@codex-login.invalid',
      plan: 'pro',
      fingerprint: `…${login.accountId.slice(-4)}`,
      lastError: null,
      expiresAt: login.expiresAt.toISOString(),
      usage: null,
      usageUnavailable: 'no quota has been read for this account yet',
      spentUntil: null,
    });
    assert.ok(!Number.isNaN(Date.parse(linkedAt)), `linkedAt is not a time: ${linkedAt}`);

    // What the CLI was given: its own CODEX_HOME, and none of this server's secrets — the master key that
    // decrypts every credential here is in this process's environment and in no child's.
    const childEnv = await cli.childEnv();
    assert.match(childEnv, /CODEX_HOME=/u);
    for (const secret of ['PROVIDER_SECRET_KEY', 'DATABASE_URL']) {
      assert.equal(childEnv.includes(secret), false, `the CLI was handed ${secret}`);
    }

    // What a response carries: never the account id, never a token, never the ciphertext.
    const stored = (await rows())[0];
    const serialized = JSON.stringify(answer);
    for (const secret of [login.accountId, login.access, login.refresh, stored.accessTokenEnc, stored.refreshTokenEnc]) {
      assert.equal(serialized.includes(secret), false, `the answer carried ${secret.slice(0, 16)}…`);
    }

    // At rest: only ciphertext, under the same key every other credential of this server uses.
    assert.notEqual(stored.accessTokenEnc, login.access);
    assert.notEqual(stored.refreshTokenEnc, login.refresh);
    assert.equal(stored.accessTokenEnc.split(':').length, 3, 'not iv:tag:ciphertext');
    assert.equal(decryptSecret(stored.accessTokenEnc), login.access);
    assert.equal(decryptSecret(stored.refreshTokenEnc), login.refresh);
    assert.deepEqual(
      { state: stored.state, email: stored.email, plan: stored.plan, userId: stored.userId, accountId: stored.accountId },
      { state: 'ACTIVE', email: 'owner@codex-login.invalid', plan: 'pro', userId: owner, accountId: login.accountId },
    );
    // The plaintext auth.json is gone with the directory the CLI was working in.
    assert.equal(existsSync(home), false, 'the CLI’s directory was left behind');
    // And the page that lists the pool is told to re-read it.
    assert.ok(published.some((entry) => entry === `${owner}:${pool}`), 'no provider-changed was published');
  });

  await t.test('the same account a second time is refused — by the flow before it, and by the database under it', async () => {
    const held = (await rows())[0];
    const again = account({ accountId: held.accountId, email: held.email ?? undefined });
    const cli = await fakeCli(work, 'AB12-CD34', again);
    process.env.CODEX_LOGIN_BIN = cli.bin;
    await service.start(owner, pool);
    const home = await cli.home();
    await writeFile(join(home, 'approve'), 'yes');

    await assert.rejects(
      () => pollTo(pool, 'CONFIRMED'),
      (e: unknown) => {
        assert.ok(e instanceof Error, String(e));
        const refusal = e as { getResponse?: () => unknown };
        const body = refusal.getResponse?.() as { code?: string } | undefined;
        assert.equal(body?.code, 'POOL_CODEX_ACCOUNT_DUPLICATE', String(e));
        return true;
      },
    );
    assert.equal((await rows()).length, 1, 'a second row was written for the same account');

    // The flow's own check is not the fence: the primary key refuses the duplicate whatever writes it.
    await assert.rejects(
      sql.query(
        `INSERT INTO pool_codex_login (pool_id, user_id, account_id, access_token_enc, refresh_token_enc,
           expires_at, state, updated_at)
         VALUES ($1, $2, $3, 'x', 'y', now() + interval '1 day', 'ACTIVE', now())`,
        [pool, owner, held.accountId],
      ),
      (e: unknown) => (e as { constraint?: string }).constraint === 'pool_codex_login_pkey',
    );
  });

  await t.test('a refused account is signed in again, on the same row — only its owner can do it, and it is still one login', async () => {
    const held = (await rows())[0];
    const before = held.expiresAt.toISOString();
    const signedInAgain = account({ accountId: held.accountId, email: held.email ?? undefined, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, suffix: 'again' });

    // The gateway's door, on an upstream 401 (P3-b): the account is out until its owner signs in again.
    assert.equal(await service.markSignedOut(pool, 'your authentication token has been invalidated'), true);
    assert.equal(await service.markSignedOut(pool, 'again'), false, 'a signed-out account moved twice');
    const out = (await rows())[0];
    assert.deepEqual({ state: out.state, lastError: out.lastError }, {
      state: 'SIGNED_OUT',
      lastError: 'your authentication token has been invalidated',
    });

    const { answer } = await signIn(signedInAgain);
    assert.equal(answer.status, 'CONFIRMED');
    const after = await rows();
    assert.equal(after.length, 1, 'the sign-in again wrote a second row');
    assert.deepEqual(
      { accountId: after[0].accountId, state: after[0].state, lastError: after[0].lastError },
      { accountId: held.accountId, state: 'ACTIVE', lastError: null },
    );
    assert.notEqual(after[0].expiresAt.toISOString(), before, 'the account kept the expiry of the tokens it replaced');
    assert.equal(decryptSecret(after[0].accessTokenEnc), signedInAgain.access);
  });

  await t.test('a different account while one is signed in is refused: one login per pool, and signing out is what changes it', async () => {
    const other = account({ email: 'second@codex-login.invalid' });
    const cli = await fakeCli(work, 'EF56-GH78', other);
    process.env.CODEX_LOGIN_BIN = cli.bin;
    await service.start(owner, pool);
    const home = await cli.home();
    await writeFile(join(home, 'approve'), 'yes');
    await assert.rejects(
      () => pollTo(pool, 'CONFIRMED'),
      (e: unknown) => ((e as { getResponse?: () => { code?: string } }).getResponse?.().code === 'POOL_CODEX_ACCOUNT_TAKEN'),
    );
    assert.equal((await rows()).length, 1);

    // The owner signs the account out; the pool now holds nothing, and the login list says so.
    assert.deepEqual(await service.signOut(owner, pool), { removed: 1 });
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await service.signOut(owner, pool), { removed: 0 });
  });

  await t.test('the deadline takes the attempt with it: EXPIRED, no row, no child, no directory', async () => {
    const ttl = process.env.CODEX_LOGIN_TTL_MS;
    process.env.CODEX_LOGIN_TTL_MS = '300';
    try {
      const cli = await fakeCli(work, 'IJ90-KL12', account());
      process.env.CODEX_LOGIN_BIN = cli.bin;
      await service.start(owner, pool);
      const home = await cli.home();
      const answer = await pollTo(pool, 'EXPIRED');
      assert.equal(answer.status, 'EXPIRED');
      assert.equal(answer.account, null);
      assert.deepEqual(await rows(), []);
      assert.equal(existsSync(home), false, 'the CLI’s directory was left behind');
      assert.equal((await service.poll(owner, pool)).status, 'NONE');
    } finally {
      if (ttl === undefined) delete process.env.CODEX_LOGIN_TTL_MS;
      else process.env.CODEX_LOGIN_TTL_MS = ttl;
    }
  });

  await t.test('a CLI that cannot be started is refused at the start, not left as a code nobody has', async () => {
    process.env.CODEX_LOGIN_BIN = join(work, 'no-such-codex');
    await assert.rejects(
      () => service.start(owner, pool),
      (e: unknown) => {
        assert.ok(e instanceof ServiceUnavailableException, String(e));
        assert.equal((e.getResponse() as { code: string }).code, 'CODEX_LOGIN_NO_CHALLENGE');
        assert.match(e.message, /could not be started/u);
        return true;
      },
    );
    assert.deepEqual(await rows(), []);
    assert.equal((await service.poll(owner, pool)).status, 'NONE');
  });

  await t.test('a login belongs to the pool’s owner, and to nobody else — at every door', async () => {
    const login = account();
    const { answer } = await signIn(login);
    assert.equal(answer.status, 'CONFIRMED');

    for (const door of [
      () => service.start(stranger, pool),
      () => service.poll(stranger, pool),
      () => service.cancel(stranger, pool),
      () => service.signOut(stranger, pool),
    ]) {
      await assert.rejects(door, (e: unknown) => e instanceof NotFoundException, 'a stranger reached the login');
    }
    // The account is untouched by any of that.
    assert.equal((await rows()).length, 1);

    // A Claude pool of the owner's own holds no ChatGPT login, and a pool nobody made is nobody's: the
    // same answer for both, which is what "as if it did not exist" means.
    const claudePool = await newPool(owner, 'claude');
    await assert.rejects(() => service.start(owner, claudePool), (e: unknown) => e instanceof NotFoundException);
    await assert.rejects(() => service.start(owner, randomUUID()), (e: unknown) => e instanceof NotFoundException);
  });

  await t.test('the database refuses a login naming anybody but the pool’s owner', async () => {
    await assert.rejects(
      sql.query(
        `INSERT INTO pool_codex_login (pool_id, user_id, account_id, access_token_enc, refresh_token_enc,
           expires_at, state, updated_at)
         VALUES ($1, $2, $3, 'x', 'y', now() + interval '1 day', 'ACTIVE', now())`,
        [pool, stranger, randomUUID()],
      ),
      (e: unknown) => (e as { constraint?: string }).constraint === 'pool_codex_login_pool_id_user_id_fkey',
    );
    // And the state is a closed set: nothing writes a third one.
    await assert.rejects(
      sql.query(
        `INSERT INTO pool_codex_login (pool_id, user_id, account_id, access_token_enc, refresh_token_enc,
           expires_at, state, updated_at)
         VALUES ($1, $2, $3, 'x', 'y', now() + interval '1 day', 'EXPIRED', now())`,
        [pool, owner, randomUUID()],
      ),
      (e: unknown) => (e as { constraint?: string }).constraint === 'pool_codex_login_state_check',
    );
    // Deleting the pool takes its login with it (the fence is the only owner of that row).
    const doomed = await newPool(owner);
    await prisma.poolCodexLogin.create({
      data: {
        poolId: doomed, userId: owner, accountId: randomUUID(), accessTokenEnc: 'x', refreshTokenEnc: 'y',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.providerPool.delete({ where: { id: doomed } });
    assert.equal(await prisma.poolCodexLogin.count({ where: { poolId: doomed } }), 0);
  });
});
