/**
 * A CURSOR CLI SESSION THAT HAS TALKED STAYS ON ITS ACCOUNT OR KEY — UNTIL A RUNNER CARRIES IT.
 *
 * Whether Cursor continues a conversation under another identity is not known yet
 * (docs/cursor-runtime-contract.md §13.2), and the owner decided D5 on 2026-10-17: until two real
 * identities show it does, only a Cursor CLI session that has not talked moves to another account or
 * key. A runner that has been shown to will declare cursor-account-move/v1; none does yet. On real
 * PostgreSQL (project P6b):
 *
 *   (1) A Cursor CLI session that has talked — a turn of it settled, Cursor opened its conversation,
 *       or its first turn is running — is refused another of its runner's accounts, live or ended,
 *       in words that say why, and nothing is written.
 *   (2) It is refused a Cursor key, the runner's sign-in and another key, live or revived — on the
 *       session's config and on the message that revives it — the same way.
 *   (3) One that has not talked moves to another account or key: waiting for its first claim, live,
 *       or ended before Cursor opened a conversation.
 *   (4) An older runner is refused the move of a talked session, whichever it is; only one that
 *       declares cursor-account-move/v1 is handed it. Every other engine keeps its own rule.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/cursor-account-move.pg.spec.ts
 *
 * Production code throughout: SessionsService and ProvidersService. Not destructive: every id is freshly
 * generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider, PermissionMode, type RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CURSOR_ACCOUNT_MOVE_V1, CURSOR_CONVERSATION_MOVE_REFUSAL } from '../providers/account-move-capability';
import { ProvidersService } from '../providers/providers.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'cursor-account-move-pg-spec';

const WORK = 'c41e0b7a';
/** The words a talked Cursor CLI session is refused another account or key in (T0 board, Web 6 ②). */
const REFUSAL = "Cursor CLI can't carry a conversation to another account or key yet. Start a new session to use a different one.";
/** What a runner too old to carry a conversation is told for every other engine. */
const CANNOT_MOVE =
  "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running";
/** A runner that runs Cursor CLI sessions and keeps nothing else of it (P1). */
const RUNS_CURSOR = ['provider:cursor'];
/** One that keeps Cursor CLI accounts too (P4b): what every runner of this version declares. */
const KEEPS_ACCOUNTS = [...RUNS_CURSOR, 'cursor-account-login/v1', 'cursor-account-remove/v1'];
/** One that has been shown to carry a Cursor CLI conversation to another identity — none is yet. */
const CARRIES = [...KEEPS_ACCOUNTS, CURSOR_ACCOUNT_MOVE_V1];

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
      { id: WORK, name: 'Work', home: `/root/.orbit/cursor-accounts/${WORK}`, auth: 'yes' },
    ],
  },
  {
    engine: 'kimi',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.kimi-code', auth: 'yes' },
      { id: WORK, name: 'Work', home: `/root/.orbit/kimi-accounts/${WORK}`, auth: 'yes' },
    ],
  },
];

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('P6b Cursor CLI account and key moves on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const providers = new ProvidersService(prisma, quiet, { snapshot: () => null } as never);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string; key: string; otherKey: string };
  /** An owner with two Cursor keys, a runner that runs Cursor CLI with Default and Work signed in, declaring
   *  `capabilities`, and a workspace on it that leaves the account to Orbit. */
  async function machine(label: string, capabilities: string[] = KEEPS_ACCOUNTS): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@cursor-account-move.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/cursor-account-move' },
    });
    const connect = async (name: string) => ((await providers.create(ownerId, {
      label: name, presetSlug: 'cursor-api', baseUrl: 'https://api2.cursor.sh', apiKey: `key_p6b${randomUUID().replace(/-/g, '')}`,
    } as never)) as unknown as { slug: string }).slug;
    return { ownerId, runnerId, workspaceId, key: await connect('Cursor'), otherKey: await connect('Cursor Team') };
  }

  /** The states a session can be in, as far as its conversation goes — each with its own ids. */
  type Facts = () => Partial<Prisma.SessionUncheckedCreateInput>;
  const TALKED = {
    /** Idle after a turn, Cursor's conversation id known. */
    idle: () => ({ status: RunStatus.AWAITING_INPUT, numTurns: 1, runtimeSessionId: randomUUID() }),
    /** Ended after two turns. */
    ended: () => ({ status: RunStatus.FAILED, numTurns: 2, runtimeSessionId: randomUUID(), finishedAt: new Date() }),
    /** Ended in the middle of its first turn: no turn settled, but Cursor opened its conversation. */
    endedMidTurn: () => ({ status: RunStatus.CANCELLED, numTurns: 0, runtimeSessionId: randomUUID(), finishedAt: new Date() }),
    /** Its first turn running, before Cursor reported the conversation it opened. */
    firstTurnRunning: () => ({ status: RunStatus.RUNNING, numTurns: 0, runtimeSessionId: null }),
  } satisfies Record<string, Facts>;
  const UNSPOKEN = {
    /** Waiting for its first claim. */
    pending: () => ({ status: RunStatus.PENDING, numTurns: 0, runtimeSessionId: null, startedAt: null }),
    /** Live, and nothing said to Cursor yet. */
    live: () => ({ status: RunStatus.AWAITING_INPUT, numTurns: 0, runtimeSessionId: null }),
    /** Ended before Cursor opened a conversation — its start refused, say, by a key Cursor rejects. */
    ended: () => ({ status: RunStatus.FAILED, numTurns: 0, runtimeSessionId: null, finishedAt: new Date() }),
  } satisfies Record<string, Facts>;

  /** A Cursor CLI session on the machine, in the state `facts` makes: on the runner's sign-in (Default)
   *  unless `extra` names a key. */
  async function cursorSession(m: Machine, facts: Facts, extra: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    const id = randomUUID();
    const onKey = typeof extra.provider === 'string' && extra.provider !== AgentProvider.CURSOR;
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId: m.workspaceId,
        assignedRunnerId: m.runnerId,
        title: 'cursor session',
        prompt: 'fix the flaky test',
        provider: AgentProvider.CURSOR,
        providerBuiltin: !onKey,
        engine: AgentProvider.CURSOR,
        model: 'default[]',
        usesRuntimeDefaultModel: true,
        permissionMode: PermissionMode.ACCEPT_EDITS,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        ...(onKey ? {} : { cursorAccount: 'default', cursorAccountPinned: false }),
        ...facts(),
        ...extra,
      },
    });
    return id;
  }

  /** What a refused switch must have left alone: the credential, the account, and the turns. */
  async function snapshot(id: string) {
    const session = (await sql.query(
      `SELECT provider, provider_builtin, cursor_account, cursor_account_pinned, kimi_account, kimi_account_pinned,
              status::text AS status
         FROM "session" WHERE id = $1::uuid`,
      [id],
    )).rows[0];
    const turns = (await sql.query(
      `SELECT kind, content, status::text AS status FROM "conversation_turn" WHERE session_id = $1::uuid ORDER BY seq`,
      [id],
    )).rows;
    return { session, turns };
  }
  const reloads = async (id: string) =>
    ((await sql.query(
      `SELECT content FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload' AND status = 'PENDING' ORDER BY seq`,
      [id],
    )).rows as Array<{ content: string }>).map((turn) => JSON.parse(turn.content) as Record<string, unknown>);
  const stored = (id: string) => db.session.findUniqueOrThrow({
    where: { id }, select: { provider: true, providerBuiltin: true, cursorAccount: true, cursorAccountPinned: true, status: true },
  });

  /** The switch is refused with 409 and `words`, and leaves the session exactly as it was. */
  async function refused(id: string, attempt: () => Promise<unknown>, words: string, what: string) {
    const before = await snapshot(id);
    try {
      await attempt();
    } catch (error) {
      const e = error as { getStatus?: () => number; message: string };
      assert.equal(e.getStatus?.(), 409, `${what}: ${e.message}`);
      assert.equal(e.message, words, what);
      assert.deepEqual(await snapshot(id), before, `${what}: a refused switch wrote something`);
      return;
    }
    assert.fail(`${what}: the switch was accepted`);
  }
  const revive = (m: Machine, id: string, dto: Record<string, unknown>) =>
    sessions.resume(m.ownerId, id, { content: 'go on', clientTurnId: randomUUID(), ...dto } as never);

  await t.test('P6b a talked Cursor CLI session is refused another account, and told why', async () => {
    const m = await machine('talked-account');
    for (const [state, facts] of Object.entries(TALKED)) {
      const id = await cursorSession(m, facts);
      await refused(id, () => sessions.switchAccount(m.ownerId, id, WORK), REFUSAL, `${state}: Work picked by hand`);
    }
    // The account it already runs on is no move: pinning it there is not refused.
    const idle = await cursorSession(m, TALKED.idle);
    await sessions.switchAccount(m.ownerId, idle, 'default');
    assert.deepEqual(
      { account: (await stored(idle)).cursorAccount, pinned: (await stored(idle)).cursorAccountPinned },
      { account: 'default', pinned: true },
    );
    assert.deepEqual(await reloads(idle), [], 'staying where it is re-spawns nothing');
  });

  await t.test('P6b a talked Cursor CLI session is refused a key, the runner’s sign-in and another key, live or revived', async () => {
    const m = await machine('talked-key');
    for (const [state, facts] of Object.entries(TALKED)) {
      const live = facts().status !== RunStatus.FAILED && facts().status !== RunStatus.CANCELLED;
      // The runner's sign-in → a key.
      const onLogin = await cursorSession(m, facts);
      // A key → the runner's sign-in, Default or a named account, and → another key.
      const onKey = await cursorSession(m, facts, { provider: m.key });
      if (live) {
        await refused(onLogin, () => sessions.updateConfig(m.ownerId, onLogin, { provider: m.key }), REFUSAL, `${state}: sign-in → key`);
        await refused(onKey, () => sessions.updateConfig(m.ownerId, onKey, { provider: 'cursor' }), REFUSAL, `${state}: key → sign-in`);
        await refused(onKey, () => sessions.updateConfig(m.ownerId, onKey, { provider: 'cursor', account: WORK }), REFUSAL, `${state}: key → Work`);
        await refused(onKey, () => sessions.updateConfig(m.ownerId, onKey, { provider: m.otherKey }), REFUSAL, `${state}: key → key`);
      } else {
        // Ended: the switch rides the message that revives it, as the failure card's Retry does too.
        await refused(onLogin, () => revive(m, onLogin, { provider: m.key }), REFUSAL, `${state}: revived sign-in → key`);
        await refused(onKey, () => revive(m, onKey, { provider: 'cursor' }), REFUSAL, `${state}: revived key → sign-in`);
        await refused(onKey, () => revive(m, onKey, { provider: 'cursor', account: WORK }), REFUSAL, `${state}: revived key → Work`);
        await refused(onKey, () => revive(m, onKey, { provider: m.otherKey }), REFUSAL, `${state}: revived key → key`);
      }
    }
    // What it already runs on is no switch: an ended one revives on its own key.
    const ended = await cursorSession(m, TALKED.ended, { provider: m.key });
    await revive(m, ended, { provider: m.key });
    assert.deepEqual(
      { provider: (await stored(ended)).provider, status: (await stored(ended)).status },
      { provider: m.key, status: RunStatus.PENDING },
    );
  });

  await t.test('P6b a Cursor CLI session that has not talked moves to another account or key', async () => {
    const m = await machine('unspoken');
    // Waiting for its first claim: the pick is stored for the claim, which reads it — nothing to re-spawn.
    const pending = await cursorSession(m, UNSPOKEN.pending);
    await sessions.switchAccount(m.ownerId, pending, WORK);
    assert.deepEqual(
      { account: (await stored(pending)).cursorAccount, pinned: (await stored(pending)).cursorAccountPinned },
      { account: WORK, pinned: true },
    );
    await sessions.updateConfig(m.ownerId, pending, { provider: m.key });
    assert.deepEqual(
      { provider: (await stored(pending)).provider, builtin: (await stored(pending)).providerBuiltin },
      { provider: m.key, builtin: false },
    );
    await sessions.updateConfig(m.ownerId, pending, { provider: m.otherKey });
    assert.equal((await stored(pending)).provider, m.otherKey);
    await sessions.updateConfig(m.ownerId, pending, { provider: 'cursor', account: 'default' });
    assert.deepEqual(
      {
        provider: (await stored(pending)).provider,
        builtin: (await stored(pending)).providerBuiltin,
        account: (await stored(pending)).cursorAccount,
      },
      { provider: 'cursor', builtin: true, account: 'default' },
    );
    assert.deepEqual(await reloads(pending), [], 'an unclaimed session has no engine to re-spawn');

    // Live: the engine is re-spawned on the new account or key, and opens its conversation there.
    const live = await cursorSession(m, UNSPOKEN.live);
    await sessions.switchAccount(m.ownerId, live, WORK);
    assert.equal((await stored(live)).cursorAccount, WORK);
    assert.deepEqual(await reloads(live), [{ provider: 'cursor' }]);
    const liveOnKey = await cursorSession(m, UNSPOKEN.live, { provider: m.key });
    await sessions.updateConfig(m.ownerId, liveOnKey, { provider: m.otherKey });
    assert.equal((await stored(liveOnKey)).provider, m.otherKey);
    assert.deepEqual((await reloads(liveOnKey)).map((reload) => reload.provider), [m.otherKey]);

    // Ended before Cursor opened a conversation: it revives on the key the message names, and an account
    // picked for it waits for the claim that runs it next.
    const ended = await cursorSession(m, UNSPOKEN.ended, { provider: m.key });
    await revive(m, ended, { provider: m.otherKey });
    assert.deepEqual(
      { provider: (await stored(ended)).provider, status: (await stored(ended)).status },
      { provider: m.otherKey, status: RunStatus.PENDING },
    );
    const endedOnLogin = await cursorSession(m, UNSPOKEN.ended);
    await sessions.switchAccount(m.ownerId, endedOnLogin, WORK);
    assert.deepEqual(
      { account: (await stored(endedOnLogin)).cursorAccount, status: (await stored(endedOnLogin)).status },
      { account: WORK, status: RunStatus.FAILED },
    );
    const endedToLogin = await cursorSession(m, UNSPOKEN.ended, { provider: m.key });
    await revive(m, endedToLogin, { provider: 'cursor', account: WORK });
    assert.deepEqual(
      {
        provider: (await stored(endedToLogin)).provider,
        account: (await stored(endedToLogin)).cursorAccount,
        pinned: (await stored(endedToLogin)).cursorAccountPinned,
      },
      { provider: 'cursor', account: WORK, pinned: true },
    );
  });

  await t.test('P6b an older runner is refused the move of a talked Cursor CLI session; only one that declares cursor-account-move/v1 is handed it', async () => {
    // Every runner in the field: one that runs Cursor CLI alone, and one that keeps its accounts too.
    for (const [label, capabilities] of [['runs-cursor', RUNS_CURSOR], ['keeps-accounts', KEEPS_ACCOUNTS]] as const) {
      const m = await machine(label, capabilities);
      const onLogin = await cursorSession(m, TALKED.idle);
      await refused(onLogin, () => sessions.updateConfig(m.ownerId, onLogin, { provider: m.key }), REFUSAL, `${label}: sign-in → key`);
      const onKey = await cursorSession(m, TALKED.ended, { provider: m.key });
      await refused(onKey, () => revive(m, onKey, { provider: m.otherKey }), REFUSAL, `${label}: revived key → key`);
    }
    const old = await machine('old-accounts');
    const talked = await cursorSession(old, TALKED.idle);
    await refused(talked, () => sessions.switchAccount(old.ownerId, talked, WORK), REFUSAL, 'keeps-accounts: Default → Work');

    // A runner that declares it is handed the move: the account, the key, and the revive.
    const carrying = await machine('carries', CARRIES);
    const moved = await cursorSession(carrying, TALKED.idle);
    await sessions.switchAccount(carrying.ownerId, moved, WORK);
    assert.equal((await stored(moved)).cursorAccount, WORK);
    assert.deepEqual(await reloads(moved), [{ provider: 'cursor' }]);
    const toKey = await cursorSession(carrying, TALKED.idle);
    await sessions.updateConfig(carrying.ownerId, toKey, { provider: carrying.key });
    assert.equal((await stored(toKey)).provider, carrying.key);
    assert.deepEqual((await reloads(toKey)).map((reload) => reload.provider), [carrying.key]);
    const revived = await cursorSession(carrying, TALKED.ended, { provider: carrying.key });
    await revive(carrying, revived, { provider: carrying.otherKey });
    assert.deepEqual(
      { provider: (await stored(revived)).provider, status: (await stored(revived)).status },
      { provider: carrying.otherKey, status: RunStatus.PENDING },
    );

    // Every other engine keeps its own rule: a Kimi Code session, said something or not, moves only on a
    // runner that declares kimi-account-move/v1, and is told so in its own words.
    for (const numTurns of [0, 2]) {
      const kimi = randomUUID();
      await db.session.create({
        data: {
          id: kimi, ownerId: old.ownerId, creatorId: old.ownerId, workspaceId: old.workspaceId, assignedRunnerId: old.runnerId,
          title: 'kimi session', prompt: 'fix the flaky test', provider: AgentProvider.KIMI, providerBuiltin: true,
          engine: AgentProvider.KIMI, status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
          startedAt: new Date(), numTurns, runtimeSessionId: numTurns ? randomUUID() : null, kimiAccount: 'default',
        },
      });
      await refused(kimi, () => sessions.switchAccount(old.ownerId, kimi, WORK), CANNOT_MOVE, `Kimi Code after ${numTurns} turns`);
    }
  });
});
