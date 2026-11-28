/**
 * SETTINGS FROM A CONVERSATION, END TO END THROUGH THE BUILT `orbit` (docs/settings-from-conversation-design.md §7, §9
 * "Real binary").
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/settings-cli.pg.spec.ts
 *
 * The runner's CLI, built from this checkout (`go build` in src/runner-go), is run as a session of a real account
 * against the production apiserver (`node build/main.js`, every guard and pipe in front of a route) on a real,
 * migrated PostgreSQL. No runner process: the CLI reads its machine credential from a private ORBIT_HOME, and
 * ORBIT_SESSION_ID makes it act as the session.
 *
 * THE CASES
 * =========
 *   (1) `orbit settings get --json` reads every proposable key with its value in force, tier, title and
 *       orbit-settings: link, through `GET /runner/settings`;
 *   (2) `orbit settings propose --set … --why … --json` files a PENDING SETTINGS_CHANGE card with the server's title
 *       and `{ changes: [{ key, from, to, tier }] }`, and writes no preference;
 *   (3) the owner's `POST /owner-requests/:id/apply-settings`, with their sign-in, writes the preferences and settles
 *       the card DONE, and `orbit settings get` then reads the new values;
 *   (4) a proposal that widens agent reach, run with --receipt, is refused SETTING_OWNER_ONLY with the row's link in a
 *       receipt that says ok: false, and files nothing; one already in force is refused SETTINGS_ALREADY_SET;
 *   (5) a runner naming another account's session is refused 403 on both doors, and nothing of either account is read
 *       or written.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const REPO = path.resolve(__dirname, '../../../..');
const RUNNER_GO = path.join(REPO, 'src/runner-go');

const PREFERENCES = { theme: 'dark', enableOrchestration: false };

interface Account {
  ownerId: string;
  email: string;
  runnerToken: string;
  runnerId: string;
  sessionId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('orbit settings: propose files a card, the owner applies it, get reads the new value', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const scratch = mkdtempSync(path.join(tmpdir(), 'settings-cli-'));
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  // ── the CLI, built from this checkout ──────────────────────────────────────────────────────────────────────────
  const binary = path.join(scratch, 'orbit');
  const built = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile('go', ['build', '-o', binary, '.'], { cwd: RUNNER_GO, maxBuffer: 32 * 1024 * 1024 },
      (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr: String(stderr) }));
  });
  assert.equal(built.code, 0, `orbit did not build:\n${built.stderr}`);
  assert.ok(existsSync(binary), 'the build reported success and wrote no binary');

  const a = await account(db, 'a');
  const b = await account(db, 'b');
  const jwtSecret = `settings-cli-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: a.ownerId, email: a.email });
  server = await startApiserver(url, jwtSecret);
  const serverUrl = `http://127.0.0.1:${server.port}`;

  /** `orbit <args>` as the account's machine, acting as `session` (ORBIT_SESSION_ID, in its public form). */
  const homes = new Map<string, string>();
  const orbit = (acc: Account, args: string[], session = acc.sessionId) => {
    let home = homes.get(acc.ownerId);
    if (!home) {
      home = mkdtempSync(path.join(scratch, `home-${acc.ownerId.slice(0, 8)}-`));
      chmodSync(home, 0o700);
      const config = path.join(home, 'config.json');
      writeFileSync(config, JSON.stringify({
        serverUrl, runnerId: acc.runnerId, runnerToken: acc.runnerToken, name: 'settings-cli', labels: [], maxConcurrent: 1,
      }));
      chmodSync(config, 0o600);
      homes.set(acc.ownerId, home);
    }
    const run = spawnSync(binary, args, {
      env: { PATH: process.env.PATH, HOME: home, ORBIT_HOME: home, ORBIT_SESSION_ID: uuidToBase62(session) },
      encoding: 'utf8',
      timeout: 60_000,
    });
    console.log(`orbit ${args.join(' ')} → exit ${run.status}\n${run.stdout}${run.stderr}`);
    return run;
  };
  const json = (run: ReturnType<typeof orbit>) => {
    assert.equal(run.status, 0, `orbit failed: ${run.stderr}`);
    return JSON.parse(run.stdout) as Record<string, any>;
  };
  const settingOf = (doc: Record<string, any>, key: string) =>
    (doc.settings as Array<Record<string, unknown>>).find((setting) => setting.key === key);
  const cards = (acc: Account) => db.ownerRequest.findMany({
    where: { ownerId: acc.ownerId, kind: 'SETTINGS_CHANGE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, state: true, title: true, why: true, payload: true, askedBySessionId: true },
  });
  const preferences = async (acc: Account) =>
    ((await db.user.findUniqueOrThrow({ where: { id: acc.ownerId }, select: { preferences: true } })).preferences ?? {}) as Record<string, unknown>;

  await t.test('(1) orbit settings get reads every proposable key with its tier, title and link', () => {
    const doc = json(orbit(a, ['settings', 'get', '--json']));
    assert.deepEqual(settingOf(doc, 'translationEnabled'),
      { key: 'translationEnabled', tier: 1, value: false, title: settingOf(doc, 'translationEnabled')!.title, path: '/settings/general', link: 'orbit-settings:translationEnabled' });
    assert.equal(settingOf(doc, 'theme')!.value, 'dark');
    assert.deepEqual(
      { tier: settingOf(doc, 'enableOrchestration')!.tier, value: settingOf(doc, 'enableOrchestration')!.value, title: settingOf(doc, 'enableOrchestration')!.title },
      { tier: 3, value: false, title: 'Let sessions orchestrate' },
    );
    assert.equal(settingOf(doc, 'defaultEffort')!.tier, 2);
  });

  let requestId = '';
  await t.test('(2) orbit settings propose files a PENDING SETTINGS_CHANGE and writes no preference', async () => {
    const filed = json(orbit(a, ['settings', 'propose', '--set', 'translationEnabled=true', '--set', 'translationLanguage=ja',
      '--why', 'You asked to read replies in Japanese.', '--json']));
    assert.equal(filed.kind, 'SETTINGS_CHANGE');
    assert.equal(filed.state, 'PENDING');
    const rows = await cards(a);
    assert.equal(rows.length, 1);
    requestId = rows[0].id;
    assert.deepEqual(
      { state: rows[0].state, title: rows[0].title, why: rows[0].why, askedBySessionId: rows[0].askedBySessionId },
      { state: 'PENDING', title: 'Change 2 settings?', why: 'You asked to read replies in Japanese.', askedBySessionId: a.sessionId },
    );
    const changes = (rows[0].payload as { changes: Array<Record<string, unknown>> }).changes;
    assert.deepEqual(
      changes.map(({ key, to, tier }) => ({ key, to, tier })).sort((x, y) => String(x.key).localeCompare(String(y.key))),
      [{ key: 'translationEnabled', to: true, tier: 1 }, { key: 'translationLanguage', to: 'ja', tier: 1 }],
    );
    assert.deepEqual(await preferences(a), PREFERENCES);
  });

  await t.test('(3) the owner applies the card, and orbit settings get reads the new values', async () => {
    const applied = await call(server!, 'POST', `/api/owner-requests/${uuidToBase62(requestId)}/apply-settings`, login);
    assert.equal(applied.status, 200, `apply-settings answered ${applied.status}: ${applied.text}`);
    assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: requestId } })).state, 'DONE');
    const stored = await preferences(a);
    assert.equal(stored.translationEnabled, true);
    assert.equal(stored.translationLanguage, 'ja');
    assert.equal(stored.theme, 'dark');
    const doc = json(orbit(a, ['settings', 'get', '--json']));
    assert.equal(settingOf(doc, 'translationEnabled')!.value, true);
    assert.equal(settingOf(doc, 'translationLanguage')!.value, 'ja');
  });

  await t.test('(4) the refusals reach the CLI and its receipt, and file nothing', async () => {
    const widening = orbit(a, ['settings', 'propose', '--set', 'enableOrchestration=true', '--why', 'You asked for sub-sessions.', '--receipt']);
    assert.notEqual(widening.status, 0);
    const receipt = JSON.parse(widening.stdout) as Record<string, any>;
    assert.equal(receipt.ok, false);
    assert.equal(receipt.operation, 'settings_propose');
    assert.equal(receipt.outcome, 'refused');
    assert.equal(receipt.error.code, 'SETTING_OWNER_ONLY');
    assert.equal(receipt.error.httpStatus, 403);
    assert.match(receipt.error.message, /orbit-settings:enableOrchestration/);

    const already = orbit(a, ['settings', 'propose', '--set', 'theme=dark', '--why', 'You asked for the dark theme.', '--json']);
    assert.notEqual(already.status, 0);
    assert.match(already.stdout + already.stderr, /SETTINGS_ALREADY_SET/);
    assert.deepEqual((await cards(a)).map((row) => row.state), ['DONE']);
  });

  await t.test('(5) a runner naming another account\'s session is refused on both doors', async () => {
    const before = await preferences(b);
    for (const args of [['settings', 'get', '--json'], ['settings', 'propose', '--set', 'theme=light', '--why', 'x', '--json']]) {
      const run = orbit(a, args, b.sessionId);
      assert.notEqual(run.status, 0);
      assert.match(run.stdout + run.stderr, /names no session this runner hosts/);
    }
    assert.deepEqual(await cards(a).then((rows) => rows.length), 1);
    assert.deepEqual(await cards(b), []);
    assert.deepEqual(await preferences(b), before);
  });
});

async function account(db: PrismaClient, label: string): Promise<Account> {
  const ownerId = randomUUID();
  const email = `settings-cli-${label}-${ownerId}@settings-cli.invalid`;
  await db.user.create({
    data: {
      id: ownerId,
      email,
      name: 'The account owner',
      passwordHash: hashPassword('a-password'),
      preferences: PREFERENCES as Prisma.InputJsonValue,
    },
  });
  const runnerToken = `settings-cli-${randomUUID()}`;
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: `runner ${label}`, tokenHash: sha256(runnerToken), maxConcurrent: 1 } });
  const workspace = await db.workspace.create({ data: { id: randomUUID(), ownerId, runnerId, name: `settings ${label}`, enabled: true } });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId: workspace.id,
      assignedRunnerId: runnerId,
      title: 'Reading replies in Japanese',
      prompt: 'Reading replies in Japanese',
      provider: 'claude',
      turnState: 'IN_FLIGHT',
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
    },
  });
  return { ownerId, email, runnerToken, runnerId, sessionId };
}
