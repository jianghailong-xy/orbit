/**
 * A TALKED CURSOR CLI SESSION THAT FOLLOWS ITS WORKSPACE IS HANDED WHAT ITS WORKSPACE WAS EDITED TO — WITH ITS
 * CONVERSATION, FOR THE RUNNER TO HOLD IT TO THE ONE IT WAS OPENED ON.
 *
 * D5 (owner, 2026-10-17): until two real identities show that Cursor continues a conversation under another,
 * only a Cursor CLI session that has not talked moves to another account or key. P6b refused every door that
 * moves one (cursor-account-move.pg.spec.ts). A session that follows its workspace — session.cursor_account
 * NULL, or the workspace's own CURSOR_API_KEY — has no door: editing the workspace is what moves it. The
 * runner keeps the identity its conversation was opened on in the session's record and refuses a start on
 * another (runner cursor_identity_pin.go, TestCursorIdentityPin*). What the runner reads is the claim, and on
 * real PostgreSQL (project P6b follow-up) this is what the claim says:
 *
 *   (1) A talked session that follows its workspace's account is handed the account the workspace was edited
 *       to — Default included — and its conversation, the runtimeSessionId it opened, to continue: the claim
 *       the runner refuses, as nothing here stops it. The session's own column stays empty.
 *   (2) The same for the key its workspace's env carries: the edited key, and the conversation.
 *   (3) A session that has not talked is handed the workspace's new account and no conversation: the runner
 *       opens one there.
 *   (4) Another engine's session is handed what its workspace was edited to, with its conversation, as
 *       before: a Kimi Code session goes on to its runner, which carries its conversation over itself.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/cursor-identity-pin.pg.spec.ts
 *
 * Production code throughout: WorkspacesService, SessionsService and QueueService. Not destructive: every id
 * is freshly generated and every assertion is scoped to the rows it made.
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
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = 'c41e0b7a';
const OTHER = 'd52f1c8b';
const CURSOR_HOME = (id: string) => `/root/.orbit/cursor-accounts/${id}`;
const KIMI_HOME = (id: string) => `/root/.orbit/kimi-accounts/${id}`;
const DIR_VAR = 'ORBIT_CURSOR_ACCOUNT_DIR';
/** The workspace's own Cursor keys: the one a session talked on, and the one the workspace was edited to. */
const FIRST_KEY = 'key_p6b-follow-up-first-1c7e2a90';
const EDITED_KEY = 'key_p6b-follow-up-edited-5b3d8f61';
/** A runner of this version: runs Cursor CLI and keeps its accounts, and carries a Kimi Code conversation
 *  to another of its accounts — but no Cursor CLI one (no cursor-account-move/v1). */
const CAPABILITIES = ['provider:cursor', 'cursor-account-login/v1', 'cursor-account-remove/v1', 'kimi-account-move/v1'];
/** A claim from a runner that runs every engine, Cursor CLI's included. */
const CURRENT = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE,
  AgentProvider.ANTIGRAVITY, AgentProvider.DSH, AgentProvider.CURSOR,
];

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
      { id: WORK, name: 'Work', home: CURSOR_HOME(WORK), auth: 'yes' },
      { id: OTHER, name: 'Other', home: CURSOR_HOME(OTHER), auth: 'yes' },
    ],
  },
  {
    engine: 'kimi',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.kimi-code', auth: 'yes' },
      { id: WORK, name: 'Work', home: KIMI_HOME(WORK), auth: 'yes' },
      { id: OTHER, name: 'Other', home: KIMI_HOME(OTHER), auth: 'yes' },
    ],
  },
];

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('P6b follow-up a Cursor CLI session’s claim across a workspace edit, on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const workspaces = new WorkspacesService(prisma);
  const claims = new RealQueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string };
  /** An owner, a runner of this version with Default, Work and Other signed in, and a workspace on it. */
  async function machine(label: string, workspace: Partial<Prisma.WorkspaceUncheckedCreateInput>): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@cursor-identity-pin.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: CAPABILITIES,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/cursor-identity-pin', ...workspace },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A built-in session of `engine` on the machine that follows its workspace (no account of its own), ended
   *  after `numTurns` turns: with the conversation its engine opened when it talked. */
  async function ended(m: Machine, engine: AgentProvider, numTurns: number) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId: m.workspaceId,
        assignedRunnerId: m.runnerId,
        title: `${engine} session`,
        prompt: 'fix the flaky test',
        provider: engine,
        providerBuiltin: true,
        engine,
        model: engine === AgentProvider.CURSOR ? 'default[]' : null,
        usesRuntimeDefaultModel: true,
        permissionMode: PermissionMode.ACCEPT_EDITS,
        status: RunStatus.FAILED,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        finishedAt: new Date(),
        numTurns,
        runtimeSessionId: numTurns > 0 ? randomUUID() : null,
      },
    });
    return id;
  }

  /** The person's next message revives the session, and its runner claims it: what that claim hands over. A
   *  revived session goes to a runner that takes over its supervisor, as every runner of this version does. */
  async function nextClaim(m: Machine, id: string) {
    await sessions.resume(m.ownerId, id, { content: 'go on', clientTurnId: randomUUID() } as never);
    const claimed = await claims.claimSessionForRunner({ id: m.runnerId, supportedProviders: CURRENT }, 0, true);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, id);
    return { env: claimed.agent.env ?? {}, runtimeSessionId: claimed.runtimeSessionId ?? null, provider: claimed.agent.provider };
  }

  const columns = async (id: string) =>
    (await sql.query(
      'SELECT runtime_session_id, cursor_account, cursor_account_pinned, kimi_account FROM "session" WHERE id = $1::uuid',
      [id],
    )).rows[0] as { runtime_session_id: string | null; cursor_account: string | null; cursor_account_pinned: boolean; kimi_account: string | null };

  await t.test('P6b follow-up a talked Cursor CLI session that follows its workspace is handed the account the workspace was edited to, with its conversation', async () => {
    for (const [edit, want] of [[OTHER, CURSOR_HOME(OTHER)], ['default', undefined]] as const) {
      const m = await machine(`talked-account-${edit}`, { cursorAccount: WORK });
      const id = await ended(m, AgentProvider.CURSOR, 2);
      const conversation = (await columns(id)).runtime_session_id;
      assert.equal((await columns(id)).cursor_account, null, 'the session follows its workspace');

      await workspaces.update(m.ownerId, m.workspaceId, { cursorAccount: edit });
      const claim = await nextClaim(m, id);
      assert.equal(claim.provider, AgentProvider.CURSOR);
      assert.equal(claim.env[DIR_VAR], want, `the claim names the account the workspace was edited to (${edit})`);
      assert.equal(claim.runtimeSessionId, conversation, 'the claim carries the conversation it talked in, to continue');
      assert.deepEqual(
        { account: (await columns(id)).cursor_account, pinned: (await columns(id)).cursor_account_pinned },
        { account: null, pinned: false },
        'the session still follows its workspace: nothing here moved it, and nothing here stops it',
      );
    }
  });

  await t.test('P6b follow-up a talked Cursor CLI session is handed the key its workspace’s env was edited to, with its conversation', async () => {
    const m = await machine('talked-key', { env: { CURSOR_API_KEY: FIRST_KEY, WORKSPACE_NOTE: 'kept' } });
    const id = await ended(m, AgentProvider.CURSOR, 1);
    const conversation = (await columns(id)).runtime_session_id;

    await workspaces.update(m.ownerId, m.workspaceId, { env: { CURSOR_API_KEY: EDITED_KEY, WORKSPACE_NOTE: 'kept' } });
    const claim = await nextClaim(m, id);
    assert.equal(claim.env.CURSOR_API_KEY, EDITED_KEY, 'the claim carries the key the workspace was edited to');
    assert.equal(claim.env.ORBIT_CURSOR_API_KEY, undefined, 'no key of Orbit’s own: the workspace’s is the one the CLI gets');
    assert.equal(claim.env[DIR_VAR], undefined);
    assert.equal(claim.runtimeSessionId, conversation, 'the claim carries the conversation it talked in, to continue');
  });

  await t.test('P6b follow-up a Cursor CLI session that has not talked is handed the workspace’s new account and no conversation', async () => {
    const m = await machine('unspoken', { cursorAccount: WORK });
    const id = await ended(m, AgentProvider.CURSOR, 0);

    await workspaces.update(m.ownerId, m.workspaceId, { cursorAccount: OTHER });
    const claim = await nextClaim(m, id);
    assert.equal(claim.env[DIR_VAR], CURSOR_HOME(OTHER), 'it follows its workspace');
    assert.equal(claim.runtimeSessionId, null, 'no conversation to continue: the runner opens one there');
  });

  await t.test('P6b follow-up another engine’s session is handed what its workspace was edited to, as before', async () => {
    const m = await machine('kimi', { kimiAccount: WORK });
    const id = await ended(m, AgentProvider.KIMI, 2);
    const conversation = (await columns(id)).runtime_session_id;

    await workspaces.update(m.ownerId, m.workspaceId, { kimiAccount: OTHER });
    const claim = await nextClaim(m, id);
    assert.equal(claim.provider, AgentProvider.KIMI);
    assert.equal(claim.env.KIMI_CODE_HOME, KIMI_HOME(OTHER), 'a Kimi Code session follows its workspace to Other');
    assert.equal(claim.runtimeSessionId, conversation, 'with its conversation, which its runner carries over (kimi-account-move/v1)');
    assert.equal(claim.env[DIR_VAR], undefined);
    assert.equal((await columns(id)).kimi_account, null);
  });
});
