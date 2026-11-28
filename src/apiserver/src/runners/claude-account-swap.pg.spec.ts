/**
 * SET AS DEFAULT FOR CLAUDE CODE ACCOUNTS — THE SERVER'S HALF (docs/claude-default-swap-contract.md §5).
 *
 * The owner makes an added Claude account the Default on a runner; the runner swaps that account's login with the one
 * in ~/.claude, and Orbit's records of the two accounts follow them. On real PostgreSQL:
 *
 *   (1) A runner without claude-account-swap/v1 is refused in words the owner can act on, and so are `default`
 *       itself, an account the runner does not report, and another engine; a second ask while one is pending is
 *       refused too. A runner that stops declaring the capability while one is pending fails it at its heartbeat.
 *   (2) On done, every per-account record is swapped in one transaction: the runner's names, pauses and plan usage,
 *       its workspaces' account choices, and each session's account (its pin kept). Sessions on both accounts keep
 *       their account — an idle one, one that was mid-turn, an ended one, and one whose account nothing chose — and
 *       a live one gets the reload that starts its next turn in the account's new folder. A message that arrived
 *       while the swap was pending is held from the inbox and the claim, and delivered after, in the new folder.
 *       A redelivered done swaps nothing back.
 *   (3) A failed swap leaves every record unchanged, says why, and releases what it held. The owner can dismiss it,
 *       which clears only that account's failed swap, never a pending one.
 *   (4) "Default" is a slot's label, not a name: an unnamed Default lands in the added slot with no name, served as the
 *       former Default with the email the runner read there (none from a runner that sends none); a name the owner
 *       gives it is kept as theirs, and swapped back to Default it is called Default again. A renamed Default keeps its
 *       name through the swap, (2).
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/claude-account-swap.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { AgentProvider, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { CLAUDE_ACCOUNT_MOVE_V1 } from '../providers/account-move-capability';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { sessionLease } from '../test-support/dequeue-under-lease';
import { CLAUDE_ACCOUNT_SWAP_V1 } from './claude-account-swap';
import { RunnersService } from './runners.service';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { wordSql } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '5e1fa7b2';
const WORK_HOME = '/root/.orbit/claude-accounts/5e1fa7b2';
const LATER = '2099-01-01T08:00:00.000Z';
const CAPABILITIES = [CLAUDE_ACCOUNT_SWAP_V1, CLAUDE_ACCOUNT_MOVE_V1];

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'claude',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.claude', auth: 'yes' },
      { id: WORK, name: 'Work', home: WORK_HOME, auth: 'yes' },
    ],
  },
];

const USAGE: PlanUsage = {
  claude: {
    provider: AgentProvider.CLAUDE,
    fiveHour: { utilization: 11, resetsAt: LATER },
    sevenDay: { utilization: 22, resetsAt: LATER },
    accounts: {
      [WORK]: { provider: AgentProvider.CLAUDE, fiveHour: { utilization: 77, resetsAt: LATER }, sevenDay: { utilization: 88, resetsAt: LATER } },
    },
  },
} as PlanUsage;

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('Set as default for Claude Code accounts: the swap relay and the records that follow their account', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  const sessions = new SessionsService(prisma, queue, quiet);
  const runners = new RunnersService(prisma, quiet);
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  // The sessions service is optional on the controller; this spec hands it the real one, as Nest does.
  (api as unknown as { sessions: SessionsService }).sessions = sessions;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const drain = (runnerId: string, capabilities: string = CAPABILITIES.join(',')) =>
    (api as unknown as {
      drainClaudeAccountSwapRequest(runnerId: string, capabilities: string): Promise<{ account: string; attempt: string } | undefined>;
    }).drainClaudeAccountSwapRequest(runnerId, capabilities);
  const report = (runnerId: string, body: Record<string, unknown>) =>
    api.claudeAccountSwapResult({ id: runnerId }, body as never);
  const inbox = async (runnerId: string, sessionId: string) =>
    (await api.inbox({ id: runnerId }, sessionId, await sessionLease(db, sessionId))) as {
      turnId: string; kind: string; content?: string; env?: Record<string, string>;
    };
  const refused = async (call: Promise<unknown>, status: number, words: RegExp | null, what: string) => {
    await assert.rejects(call, (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), status, `${what}: ${err.message}`);
      if (words) assert.match(err.message ?? '', words, what);
      return true;
    });
  };

  /** An owner, a runner with Default and Work signed in, Default named and paused, and workspaces choosing each. */
  async function machine(label: string, capabilities = CAPABILITIES) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@swap.invalid`, name: 'The owner', passwordHash: 'x' } });
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
        maxConcurrent: 8,
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        planUsage: USAGE as unknown as Prisma.InputJsonValue,
        accountNames: { claude: { default: 'Personal' } },
        accountPauses: { claude: { default: LATER } },
      },
    });
    const workspace = async (name: string, claudeAccount: string | null) => {
      const id = randomUUID();
      await db.workspace.create({ data: { id, ownerId, runnerId, name: `${label}-${name}`, enabled: true, claudeAccount } });
      return id;
    };
    return {
      ownerId,
      runnerId,
      onDefault: await workspace('on-default', 'default'),
      onWork: await workspace('on-work', WORK),
      automatic: await workspace('automatic', null),
    };
  }
  type Machine = Awaited<ReturnType<typeof machine>>;

  async function session(m: Machine, workspaceId: string, status: RunStatus, extra: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId,
        assignedRunnerId: m.runnerId,
        title: 'claude session',
        prompt: 'fix the flaky test',
        provider: 'claude',
        providerBuiltin: true,
        turnState: turnStateOfWord(status),
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        numTurns: 2,
        ...extra,
        ...(status === RunStatus.SUCCEEDED || status === RunStatus.FAILED
          ? { finishedAt: extra.finishedAt ?? new Date()}
          : status === RunStatus.CANCELLED ? { finishedAt: extra.finishedAt ?? new Date()} : {}),
      },
    });
    return id;
  }
  const message = (m: Machine, sessionId: string, content: string) =>
    sessions.createTurn(m.ownerId, sessionId, { clientTurnId: randomUUID(), content });
  const statusOf = async (id: string) =>
    (await sql.query(`SELECT ${wordSql()} AS status FROM "session" WHERE id = $1::uuid`, [id])).rows[0].status as string;

  /**
   * Deliver what waits for `id` the way a runner takes it: a claim while the session is queued, then its inbox, a reload
   * answered as the runner answers one. Answers the message and the CLAUDE_CONFIG_DIR the engine was (re)started with —
   * by the claim or the reload — or `unchanged` when neither restarted it. `claims` collects every session claimed.
   */
  async function deliver(m: Machine, id: string, claims: Map<string, string | undefined>) {
    let dir: string | undefined | 'unchanged' = 'unchanged';
    for (let step = 0; step < 8; step++) {
      if ((await statusOf(id)) === 'PENDING') {
        const claimed = await queue.claimSessionForRunner({ id: m.runnerId });
        assert.ok(claimed, `a claim for ${id}`);
        claims.set(claimed!.sessionId, claimed!.agent.env?.CLAUDE_CONFIG_DIR);
        if (claimed!.sessionId === id) dir = claimed!.agent.env?.CLAUDE_CONFIG_DIR;
        continue;
      }
      const turn = await inbox(m.runnerId, id);
      if (turn.kind === 'reload' && turn.turnId) {
        dir = turn.env?.CLAUDE_CONFIG_DIR;
        await sql.query(`UPDATE "conversation_turn" SET status = 'ANSWERED' WHERE id = $1::uuid`, [turn.turnId]);
        continue;
      }
      return { turn, dir };
    }
    throw new Error(`nothing delivered for ${id}`);
  }

  /** Every record Orbit keys by the two account ids, as stored. */
  async function records(m: Machine, sessionIds: string[]) {
    const runner = (await sql.query(
      `SELECT account_names, account_pauses, plan_usage FROM "runner" WHERE id = $1::uuid`, [m.runnerId],
    )).rows[0];
    const workspaces = (await sql.query(
      `SELECT id::text, claude_account FROM "workspace" WHERE runner_id = $1::uuid ORDER BY id`, [m.runnerId],
    )).rows;
    const rows = (await sql.query(
      `SELECT id::text, claude_account, claude_account_pinned FROM "session" WHERE id = ANY($1::uuid[]) ORDER BY id`, [sessionIds],
    )).rows;
    return {
      names: runner.account_names,
      pauses: runner.account_pauses,
      planUsage: runner.plan_usage,
      workspaces: Object.fromEntries(workspaces.map((w: { id: string; claude_account: string | null }) => [w.id, w.claude_account])),
      sessions: Object.fromEntries(rows.map((s: { id: string; claude_account: string | null; claude_account_pinned: boolean }) =>
        [s.id, { account: s.claude_account, pinned: s.claude_account_pinned }])),
    };
  }
  const reloads = async (id: string) =>
    (await sql.query(`SELECT content FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload'`, [id])).rows;
  /** Claude's accounts as the runner page is served them: id, name, and the former Default's mark and email. */
  const claudeAccounts = async (m: Machine) => {
    const runner = (await runners.getRunner(m.ownerId, m.runnerId)) as unknown as { engines: RunnerEngineHealth[] | null };
    return (runner.engines?.find((e) => e.engine === 'claude')?.accounts ?? []).map((a) => ({
      id: a.id,
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.formerDefault !== undefined ? { formerDefault: a.formerDefault } : {}),
      ...(a.email !== undefined ? { email: a.email } : {}),
    }));
  };
  const served = async (m: Machine) =>
    ((await runners.getRunner(m.ownerId, m.runnerId)) as unknown as { claudeAccountSwap: unknown }).claudeAccountSwap;

  await t.test('(1) an old runner, Default itself, an unknown account and a second ask are refused', async () => {
    const old = await machine('old', [CLAUDE_ACCOUNT_MOVE_V1]);
    await refused(runners.setDefaultAccount(old.ownerId, old.runnerId, 'claude', WORK), 400, /Update the runner to set a default/, 'a runner without claude-account-swap/v1');
    const status = (await sql.query(`SELECT claude_account_swap_status FROM "runner" WHERE id = $1::uuid`, [old.runnerId])).rows[0];
    assert.equal(status.claude_account_swap_status, null, 'nothing was asked of the old runner');

    const m = await machine('refusals');
    await refused(runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', 'default'), 400, /already the Default/, 'Default itself');
    await refused(runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', 'c0ffee42'), 404, /not one this runner reports/, 'an unknown account');
    await refused(runners.setDefaultAccount(m.ownerId, m.runnerId, 'codex', WORK), 400, /Claude Code/, 'another engine');
    await refused(runners.setDefaultAccount(randomUUID(), m.runnerId, 'claude', WORK), 404, null, "another owner's runner");

    assert.deepEqual(await runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK), {
      account: WORK, status: 'pending', message: null, waitingOn: [], foreignProcesses: [],
    });
    await refused(runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK), 409, /already being set/, 'a second ask while pending');

    // A runner that no longer declares it would never answer: its heartbeat fails the swap at once, in the same words.
    assert.equal(await drain(m.runnerId, CLAUDE_ACCOUNT_MOVE_V1), undefined);
    const after = await served(m) as { status: string; message: string };
    assert.equal(after.status, 'failed');
    assert.match(after.message, /Update the runner to set a default/);
  });

  await t.test('(2) on done every record follows its account, sessions keep theirs, and a held message goes after', async () => {
    const m = await machine('done');
    // Sessions on both accounts: idle on Default (pinned), mid-turn on Work, ended on Default, one whose account came from
    // its workspace's choice, one on Default by nothing having chosen it, and one queued on Work.
    const idle = await session(m, m.onDefault, RunStatus.AWAITING_INPUT, { claudeAccount: 'default', claudeAccountPinned: true });
    const midTurn = await session(m, m.automatic, RunStatus.RUNNING, { claudeAccount: WORK, engineTurnActive: true });
    const ended = await session(m, m.onDefault, RunStatus.SUCCEEDED, { claudeAccount: 'default', claudeAccountPinned: true });
    const byWorkspace = await session(m, m.onWork, RunStatus.AWAITING_INPUT);
    const unchosen = await session(m, m.automatic, RunStatus.AWAITING_INPUT);
    const queued = await session(m, m.automatic, RunStatus.PENDING, { claudeAccount: WORK });
    const all = [idle, midTurn, ended, byWorkspace, unchosen, queued];
    const before = await records(m, all);

    const asked = await runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK);
    assert.equal(asked.status, 'pending');
    const command = await drain(m.runnerId);
    assert.ok(command, 'the heartbeat hands the swap over');
    assert.equal(command!.account, WORK);
    // The runner waits on the turn in progress, and says so; the page names it.
    assert.deepEqual(await report(m.runnerId, {
      account: WORK, attempt: command!.attempt, status: 'pending', waitingOn: [midTurn, randomUUID()],
      foreignProcesses: [{ pid: 4242, command: 'claude' }],
    }), { ok: true, applied: true });
    const pending = await served(m) as { status: string; waitingOn: Array<{ id: string }>; foreignProcesses: unknown[] };
    assert.equal(pending.status, 'pending');
    assert.deepEqual(pending.waitingOn.map((s) => s.id), [midTurn], 'only sessions of this runner are named');
    assert.deepEqual(pending.foreignProcesses, [{ pid: 4242, command: 'claude' }]);
    assert.equal((await drain(m.runnerId))?.attempt, command!.attempt, 'redelivered on every heartbeat while pending');

    // While pending: a message for the idle session is held from its inbox, and the queued one is not claimed.
    await message(m, idle, 'what did we change yesterday?');
    assert.equal((await inbox(m.runnerId, idle)).turnId, '', 'the message waits for the swap');
    assert.equal(await queue.claimSessionForRunner({ id: m.runnerId }), null, 'no session on either account is claimed');
    assert.deepEqual(await records(m, all), before, 'nothing moves while pending');

    // Done: everything keyed by the two ids is swapped.
    assert.deepEqual(await report(m.runnerId, {
      account: WORK, attempt: command!.attempt, status: 'done',
      now: { defaultAccountUuid: 'acct-work', accountAccountUuid: 'acct-personal', accountEmail: 'me@home.example' },
    }), { ok: true, applied: true });
    const after = await records(m, all);
    assert.deepEqual(after.names, {
      claude: { default: 'Work', [WORK]: 'Personal' },
      formerDefault: { claude: { [WORK]: 'me@home.example' } },
    }, 'names follow their account; the one the owner gave Default stays its name');
    assert.deepEqual(await claudeAccounts(m), [
      { id: 'default', name: 'Work' },
      { id: WORK, name: 'Personal', formerDefault: true, email: 'me@home.example' },
    ], 'served: the former Default by the name the owner gave it');
    assert.deepEqual(after.pauses, { claude: { [WORK]: LATER } }, 'the pause follows its account');
    assert.deepEqual(after.planUsage, {
      claude: {
        provider: AgentProvider.CLAUDE,
        fiveHour: { utilization: 77, resetsAt: LATER },
        sevenDay: { utilization: 88, resetsAt: LATER },
        accounts: {
          [WORK]: { provider: AgentProvider.CLAUDE, fiveHour: { utilization: 11, resetsAt: LATER }, sevenDay: { utilization: 22, resetsAt: LATER } },
        },
      },
    }, 'plan usage follows its account');
    assert.deepEqual(after.workspaces, { [m.onDefault]: WORK, [m.onWork]: 'default', [m.automatic]: null }, 'workspace choices follow');
    assert.deepEqual(after.sessions, {
      [idle]: { account: WORK, pinned: true },
      [midTurn]: { account: 'default', pinned: false },
      [ended]: { account: WORK, pinned: true },
      [byWorkspace]: { account: null, pinned: false },
      [unchosen]: { account: WORK, pinned: false },
      [queued]: { account: 'default', pinned: false },
    }, 'each session stays on its account, pin kept');
    assert.deepEqual(await served(m), { account: WORK, status: 'done', message: null, waitingOn: [], foreignProcesses: [] });

    // The live ones are reloaded into the new folder; the ended and the queued one need none. (The idle one, whose
    // message made it queued, is restarted by its claim instead, below.)
    for (const id of [midTurn, byWorkspace, unchosen]) {
      assert.deepEqual(await reloads(id), [{ content: JSON.stringify({ provider: 'claude' }) }], `reload for ${id}`);
    }
    assert.deepEqual(await reloads(ended), []);
    assert.deepEqual(await reloads(queued), []);

    // The owner lifts the pause of the account that was Default, which is now in Work's folder: lifting it there leaves no
    // pause at all, so none stayed on Default. (A paused account's sessions are not claimed; lifting it lets them go.)
    await runners.pauseAccount(m.ownerId, m.runnerId, 'claude', WORK, null);
    assert.deepEqual((await records(m, all)).pauses, { claude: {} });

    // The held message goes out now, and its engine starts in its account's new folder.
    const claims = new Map<string, string | undefined>();
    const delivered = await deliver(m, idle, claims);
    assert.equal(delivered.turn.kind, 'message');
    assert.equal(delivered.turn.content, 'what did we change yesterday?');
    assert.equal(delivered.dir, WORK_HOME, 'the next turn starts in the account’s new folder');
    // And the queued session is claimed too, onto Default — where its account is now.
    if (!claims.has(queued)) {
      const claimed = await queue.claimSessionForRunner({ id: m.runnerId });
      if (claimed) claims.set(claimed.sessionId, claimed.agent.env?.CLAUDE_CONFIG_DIR);
    }
    assert.ok(claims.has(queued), 'the queued session is claimed after the swap');
    assert.equal(claims.get(queued), undefined, 'on Default, where its account now is');

    // A redelivered done swaps nothing back.
    assert.deepEqual(await report(m.runnerId, { account: WORK, attempt: command!.attempt, status: 'done' }), { ok: true, applied: false });
    const again = await records(m, all);
    // (Its pause is the one the owner lifted above, not a swap back.)
    assert.deepEqual({ ...again, sessions: undefined, pauses: undefined }, { ...after, sessions: undefined, pauses: undefined });
    assert.deepEqual(again.pauses, { claude: {} });
    assert.equal(again.sessions[idle].account, WORK);
    assert.equal(again.sessions[midTurn].account, 'default');
  });

  await t.test('(3) a failed swap leaves every record unchanged and releases what it held', async () => {
    const m = await machine('failed');
    const idle = await session(m, m.onDefault, RunStatus.AWAITING_INPUT, { claudeAccount: 'default', claudeAccountPinned: true });
    const midTurn = await session(m, m.automatic, RunStatus.RUNNING, { claudeAccount: WORK, engineTurnActive: true });
    const queued = await session(m, m.onWork, RunStatus.PENDING, { claudeAccount: WORK });
    const all = [idle, midTurn, queued];
    const before = await records(m, all);

    await runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK);
    const command = (await drain(m.runnerId))!;
    await report(m.runnerId, { account: WORK, attempt: command.attempt, status: 'pending', waitingOn: [midTurn] });
    await message(m, idle, 'still there?');
    assert.equal((await inbox(m.runnerId, idle)).turnId, '');

    // A report about another attempt changes nothing.
    assert.deepEqual(await report(m.runnerId, { account: WORK, attempt: new Date(0).toISOString(), status: 'failed', message: 'x' }),
      { ok: true, applied: false });
    const reason = 'Rolled back: the Keychain refused the write — both logins are as they were.';
    assert.deepEqual(await report(m.runnerId, { account: WORK, attempt: command.attempt, status: 'failed', message: reason }),
      { ok: true, applied: true });
    assert.deepEqual(await records(m, all), before, 'every record is as it was');
    for (const id of all) assert.deepEqual(await reloads(id), [], 'nothing is reloaded');
    assert.deepEqual(await served(m), { account: WORK, status: 'failed', message: reason, waitingOn: [], foreignProcesses: [] });
    assert.equal(await drain(m.runnerId), undefined, 'a failed swap is no longer handed over');

    // What it held goes out, on the account it was on — once the owner lifts Default's pause, which stayed on Default.
    await runners.pauseAccount(m.ownerId, m.runnerId, 'claude', 'default', null);
    const claims = new Map<string, string | undefined>();
    const delivered = await deliver(m, idle, claims);
    assert.equal(delivered.turn.content, 'still there?', JSON.stringify(delivered));
    assert.ok(delivered.dir === undefined || delivered.dir === 'unchanged', `still on Default: ${delivered.dir}`);
    if (!claims.has(queued)) {
      const claimed = await queue.claimSessionForRunner({ id: m.runnerId });
      if (claimed) claims.set(claimed.sessionId, claimed.agent.env?.CLAUDE_CONFIG_DIR);
    }
    assert.equal(claims.get(queued), WORK_HOME, 'the queued session is claimed, still on Work');

    // The owner dismisses the failure: only that account's failed swap clears, and only for its owner.
    const beforeDismiss = await records(m, all);
    await runners.dismissSetDefaultFailure(m.ownerId, m.runnerId, 'claude', 'someone-else');
    assert.equal(((await served(m)) as { status: string }).status, 'failed', "another account's dismissal clears nothing");
    await refused(runners.dismissSetDefaultFailure(randomUUID(), m.runnerId, 'claude', WORK), 404, null, "another owner's runner");
    assert.deepEqual(await runners.dismissSetDefaultFailure(m.ownerId, m.runnerId, 'claude', WORK), { ok: true });
    assert.deepEqual(await served(m), { account: null, status: null, message: null, waitingOn: [], foreignProcesses: [] });
    assert.deepEqual(await records(m, all), beforeDismiss, 'dismissing touches no record');
    // A pending swap is never dismissed out from under the runner.
    await runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK);
    await runners.dismissSetDefaultFailure(m.ownerId, m.runnerId, 'claude', WORK);
    assert.equal(((await served(m)) as { status: string }).status, 'pending', 'a pending swap stays');
  });

  await t.test('(4) an unnamed Default is not called "Default" in the added slot: its email, else "Former default"', async () => {
    const swap = async (m: Machine, now: Record<string, unknown>) => {
      await runners.setDefaultAccount(m.ownerId, m.runnerId, 'claude', WORK);
      const command = (await drain(m.runnerId))!;
      assert.deepEqual(await report(m.runnerId, { account: WORK, attempt: command.attempt, status: 'done', now }),
        { ok: true, applied: true });
    };
    const unnamed = async (label: string) => {
      const m = await machine(label);
      await db.runner.update({ where: { id: m.runnerId }, data: { accountNames: Prisma.DbNull, accountPauses: Prisma.DbNull } });
      assert.deepEqual(await claudeAccounts(m), [{ id: 'default' }, { id: WORK, name: 'Work' }]);
      return m;
    };

    // A runner that read the former Default's email: no name is written for the slot, and the page is served the email.
    const m = await unnamed('unnamed');
    await swap(m, { defaultAccountUuid: 'acct-work', accountAccountUuid: 'acct-personal', accountEmail: ' me@home.example ' });
    const names = (await records(m, [])).names;
    assert.deepEqual(names, { claude: { default: 'Work' }, formerDefault: { claude: { [WORK]: 'me@home.example' } } });
    assert.ok(!JSON.stringify(names).includes('"Default"'), 'no "Default" is written as a name');
    assert.deepEqual(await claudeAccounts(m), [
      { id: 'default', name: 'Work' },
      // Not "Work": that is the name the runner keeps for the slot, which belongs to the account now in ~/.claude.
      { id: WORK, formerDefault: true, email: 'me@home.example' },
    ]);

    // The owner names it after the slot's own record ("Work"): that is now their name for it, kept as an alias.
    const renamed = await runners.renameAccount(m.ownerId, m.runnerId, 'claude', WORK, 'Work');
    assert.equal(renamed.name, 'Work');
    assert.deepEqual(await claudeAccounts(m), [
      { id: 'default', name: 'Work' },
      { id: WORK, name: 'Work', formerDefault: true, email: 'me@home.example' },
    ]);
    // Swapped back, it goes back to ~/.claude with the name the owner gave it, and the other account takes its own.
    await swap(m, { defaultAccountUuid: 'acct-personal', accountAccountUuid: 'acct-work', accountEmail: 'me@work.example' });
    assert.deepEqual(await claudeAccounts(m), [
      { id: 'default', name: 'Work' },
      { id: WORK, name: 'Work', formerDefault: true, email: 'me@work.example' },
    ]);

    // Never renamed and swapped back: Default is called Default again — it does not take its email to ~/.claude.
    const back = await unnamed('back');
    await swap(back, { defaultAccountUuid: 'acct-work', accountAccountUuid: 'acct-personal', accountEmail: 'me@home.example' });
    await swap(back, { defaultAccountUuid: 'acct-personal', accountAccountUuid: 'acct-work', accountEmail: 'me@work.example' });
    assert.deepEqual((await records(back, [])).names, {
      claude: { [WORK]: 'Work' }, formerDefault: { claude: { [WORK]: 'me@work.example' } },
    });
    assert.deepEqual(await claudeAccounts(back), [
      { id: 'default' },
      { id: WORK, name: 'Work', formerDefault: true, email: 'me@work.example' },
    ]);

    // A runner that sends no email (older, or a .claude.json that names none): the slot is marked with none, and the
    // clients call it "Former default".
    const old = await unnamed('no-email');
    await swap(old, { defaultAccountUuid: 'acct-work', accountAccountUuid: 'acct-personal' });
    assert.deepEqual((await records(old, [])).names, { claude: { default: 'Work' }, formerDefault: { claude: { [WORK]: '' } } });
    assert.deepEqual(await claudeAccounts(old), [{ id: 'default', name: 'Work' }, { id: WORK, formerDefault: true }]);
  });
});
