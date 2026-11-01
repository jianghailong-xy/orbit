/**
 * THE CONTROL PLANE HOLDS AN ANTHROPIC-BOUND CLAUDE SESSION ON A RUNNER WHOSE CLAUDE CONNECTION TO ANTHROPIC IS IN A
 * REGION ANTHROPIC DOES NOT OFFER CLAUDE IN (docs/claude-region-check-contract.md §8–§12). On real PostgreSQL, through
 * the claim, the runner's finalize and turn-complete, session create, PATCH and move, and Claude's sign-in:
 *
 *   (1) The hold: Claude Code on its own sign-in, on an Anthropic key — by its preset, or by its anthropic.com endpoint
 *       alone — and on a Claude pool, bound for a blocked runner, stays QUEUED with the refusal sentence in
 *       session.error and is not claimed; Claude Code on a DeepSeek key on the same runner is claimed.
 *   (2) A runner that does not declare claude-region/v1 is never held, nor refused a create or a Claude sign-in,
 *       whatever its row says.
 *   (3) Each release lets the next claim take the session and clears the sentence: an allowed check, a blocked verdict
 *       24 hours old, a switch to a DeepSeek key on the PENDING session, and a move to a workspace on another machine —
 *       where the message it waited with is the turn the new runner is handed. A session queued for any other reason
 *       is refused the move with 'Stop the session first.'.
 *   (4) region_refused at spawn (finalize): the run goes back to the hold, not FAILED, with its message intact and its
 *       task untouched, and once released the claim hands the same message out. A refusal reported while the row reads
 *       allowed waits for the next check.
 *   (5) region_refused at delivery (turn-complete): the message goes back in the queue undelivered and the session to
 *       the hold; the runner is answered with the waiting status; a re-post changes nothing.
 *   (6) region_stopped: the stopped turn is answered and not replayed; the session rests AWAITING_INPUT with the stopped
 *       sentence and takes the next message, or waits under the hold when one is queued behind it — on turn-complete
 *       and on finalize alike.
 *   (7) New sessions: an Anthropic-bound Claude session for the blocked runner answers 409 with the code and board 04's
 *       sentence, and nothing is created; one on a DeepSeek key is created.
 *   (8) Claude's sign-in on the blocked runner is refused with board 04's sentence and nothing is recorded; one already
 *       pending is failed with that sentence by the heartbeat instead of handed out.
 *   (9) The push: over real checks, only the blocked check that takes blockedChecks to 2 is the confirmed flip — once per
 *       run of blocked checks, and never for a single one.
 *  (10) A task's run under model routing: Claude's own sign-in on the blocked runner is ruled out as a signed-out one
 *       is, and the run goes to an engine the owner allowed; on an allowed runner it stays on Claude.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/queue/claude-region-hold.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  CLAUDE_REGION_REFUSED_SUBTYPE,
  CLAUDE_REGION_STOPPED_SUBTYPE,
  CLAUDE_REGION_UNSUPPORTED,
  CLAUDE_REGION_V1,
  RunStatus as SharedRunStatus,
  claudeRegionRefusedError,
  claudeRegionStoppedError,
  type ClaimedSession,
  type ClaudeRegionCheckResponse,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { recordRegionCheck, regionFlipConfirmed } from '../runners/runner-region';
import { RunnersService } from '../runners/runners.service';
import { SESSION_MOVE_V1 } from '../sessions/session-move';
import { SessionsService } from '../sessions/sessions.service';
import { planTaskRunRoute, taskRouteReads } from '../tasks/task-route-decision';
import { QueueService } from './queue.service';

process.env.PROVIDER_SECRET_KEY ??= 'claude-region-hold-spec';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

type Answer = Pick<ClaudeRegionCheckResponse, 'verdict' | 'country' | 'regionCode' | 'name' | 'viaProxy'>;
const BLOCKED: Answer = { verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false };
const ALLOWED: Answer = { verdict: 'allowed', country: 'US', regionCode: null, name: 'United States', viaProxy: false };
const UNKNOWN: Answer = { verdict: 'unknown', country: null, regionCode: null, name: null, viaProxy: false };

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

interface Machine {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  /** {machine} in the sentences: the runner's name, since it has no display name. */
  name: string;
}

test('the region check holds Anthropic-bound Claude sessions, refuses them at create and sign-in, and lets go on its own', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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
  const runners = new RunnersService(prisma);
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    { notifyClaudeRegionBlocked: async () => undefined, notifyEngineSignedOut: async () => undefined } as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** A person, or the person `ownerId` already is, with a runner and a workspace on it. Claude is signed in there. */
  async function machine(label: string, opts: { capable?: boolean; ownerId?: string } = {}): Promise<Machine> {
    const ownerId = opts.ownerId ?? randomUUID();
    if (!opts.ownerId) {
      await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@region-hold.invalid`, name: 'The owner', passwordHash: 'x' } });
    }
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const name = `${label}-${RUN}`;
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        capabilities: opts.capable === false ? [SESSION_MOVE_V1] : [SESSION_MOVE_V1, CLAUDE_REGION_V1],
        capabilitiesReportedAt: new Date(),
        maxConcurrent: 8,
        engines: [{ engine: 'claude', installed: true, auth: 'yes' }] as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    return { ownerId, runnerId, workspaceId, name };
  }
  /** One check reaching the route (runners/runner-region.ts recordRegionCheck, runner.region's only writer). */
  const check = (m: Machine, answer: Answer) => recordRegionCheck(db, m.runnerId, answer, new Date());
  /** A configured key of `ownerId`'s that Claude Code runs on. */
  async function key(ownerId: string, kind: 'deepseek' | 'anthropic-preset' | 'anthropic-endpoint') {
    const slug = `${kind}-${randomUUID().slice(0, 8)}`;
    await db.modelProvider.create({
      data: {
        slug,
        label: kind,
        runtime: 'claude',
        ownerId,
        apiKeyEnc: encryptSecret(`sk-${randomUUID()}`),
        ...(kind === 'deepseek'
          ? { presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' }
          : kind === 'anthropic-preset'
            ? { presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com' }
            : { presetSlug: null, baseUrl: 'https://API.Anthropic.com./v1' }),
        models: [{ value: 'claude-sonnet-5-5', label: 'Sonnet' }, { value: 'deepseek-chat', label: 'DeepSeek' }] as unknown as Prisma.InputJsonValue,
        defaultModel: kind === 'deepseek' ? 'deepseek-chat' : 'claude-sonnet-5-5',
      },
    });
    return slug;
  }
  /** A Claude pool of `ownerId`'s with one Claude subscription in it. */
  async function claudePool(ownerId: string) {
    const member = await db.modelProvider.create({
      data: {
        slug: `pool-member-${randomUUID().slice(0, 8)}`, label: 'Subscription', runtime: 'claude',
        baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret(`sk-ant-oat01-${randomUUID()}`), ownerId,
      },
    });
    const pool = await db.providerPool.create({
      data: {
        slug: `claude-accounts-${randomUUID().slice(0, 8)}`, label: 'Claude accounts', ownerId,
        members: { createMany: { data: [{ providerId: member.id }] } },
      },
      select: { slug: true },
    });
    return pool.slug;
  }
  /** A session queued for `m`'s runner, waiting with one message: the prompt the claim seeds as its first turn. */
  async function queued(m: Machine, provider: string = AgentProvider.CLAUDE, extra: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId: m.workspaceId,
        assignedRunnerId: m.runnerId,
        title: `waiting ${provider}`,
        prompt: `the waiting message for ${id}`,
        provider,
        providerBuiltin: provider === AgentProvider.CLAUDE,
        engine: AgentProvider.CLAUDE,
        status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...extra,
      },
    });
    return id;
  }
  /** A session RUNNING on `m`'s runner with one message out on delivery. */
  async function running(m: Machine) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: m.ownerId, creatorId: m.ownerId, workspaceId: m.workspaceId, assignedRunnerId: m.runnerId,
        title: 'running claude', prompt: 'the first message', provider: AgentProvider.CLAUDE, providerBuiltin: true,
        engine: AgentProvider.CLAUDE, status: RunStatus.RUNNING, engineTurnActive: true, numTurns: 1,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), runClaimedAt: new Date(), runtimeSessionId: randomUUID(),
      },
    });
    const turn = await db.conversationTurn.create({
      data: {
        sessionId: id, seq: 1, clientTurnId: `initial-${id}`, kind: 'message', content: 'the first message',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID(),
      },
      select: { id: true },
    });
    return { id, turnId: turn.id };
  }
  const claim = (m: Machine): Promise<ClaimedSession | null> =>
    queue.claimSessionForRunner({ id: m.runnerId, supportedProviders: [AgentProvider.CLAUDE] }, 0, true);
  const row = (id: string) => db.session.findUniqueOrThrow({
    where: { id },
    select: { status: true, error: true, provider: true, assignedRunnerId: true, finishedAt: true, cancelRequestedAt: true, numTurns: true },
  });
  const turnsOf = (id: string) => db.conversationTurn.findMany({
    where: { sessionId: id }, orderBy: { seq: 'asc' }, select: { id: true, content: true, status: true, deliveredAt: true },
  });
  const dequeue = (id: string, m: Machine) => (api as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(id, m.runnerId, null);
  const refused = (m: Machine) => claudeRegionRefusedError(m.name, 'mainland China');

  // ── (1) the hold ─────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(1) an Anthropic-bound Claude session on a blocked runner stays QUEUED with the sentence; a DeepSeek one is claimed', async () => {
    const m = await machine('hold');
    await check(m, BLOCKED);
    const ownSignIn = await queued(m);
    const byPreset = await queued(m, await key(m.ownerId, 'anthropic-preset'));
    const byEndpoint = await queued(m, await key(m.ownerId, 'anthropic-endpoint'));
    const pool = await queued(m, await claudePool(m.ownerId));
    const deepseek = await queued(m, await key(m.ownerId, 'deepseek'));

    const claimed = await claim(m);
    assert.equal(claimed?.sessionId, deepseek, 'the DeepSeek-key session is the one claimed');
    assert.equal((await row(deepseek)).status, RunStatus.RUNNING);
    assert.equal(await claim(m), null, 'nothing else on the runner is claimed');
    for (const [what, id] of [['own sign-in', ownSignIn], ['Anthropic preset', byPreset], ['anthropic.com endpoint', byEndpoint], ['Claude pool', pool]] as const) {
      const held = await row(id);
      assert.equal(held.status, RunStatus.PENDING, `${what}: still queued`);
      assert.equal(held.error, refused(m), `${what}: the refusal sentence`);
      assert.ok(held.error?.startsWith(`${CLAUDE_REGION_UNSUPPORTED}: `));
    }
    // An unknown check keeps the decided verdict (③): still held.
    await check(m, UNKNOWN);
    assert.equal(await claim(m), null);
    assert.equal((await row(ownSignIn)).error, refused(m));
  });

  // ── (2) a runner without the capability ──────────────────────────────────────────────────────────────────────────
  await t.test('(2) a runner without claude-region/v1 is never held, refused a create or refused a Claude sign-in', async () => {
    const m = await machine('old-runner', { capable: false });
    await check(m, BLOCKED);
    assert.equal(((await db.runner.findUniqueOrThrow({ where: { id: m.runnerId } })).region as { verdict?: string })?.verdict, 'blocked',
      'its row says blocked');
    const id = await queued(m);
    assert.equal((await claim(m))?.sessionId, id);
    assert.equal((await row(id)).error, null);
    const created = await sessions.create(m.ownerId, { prompt: 'hello', workspaceId: m.workspaceId, provider: AgentProvider.CLAUDE });
    assert.ok(created.id);
    await runners.startLogin(m.ownerId, m.runnerId, { engine: 'claude' });
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: m.runnerId } })).loginStatus, 'pending');
  });

  // ── (3) releases ─────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(3a) an allowed check lets the claim through and clears the sentence', async () => {
    const m = await machine('allowed');
    await check(m, BLOCKED);
    const id = await queued(m);
    assert.equal(await claim(m), null);
    assert.equal((await row(id)).error, refused(m));
    await check(m, ALLOWED);
    assert.equal((await claim(m))?.sessionId, id);
    assert.deepEqual(await row(id).then((r) => [r.status, r.error]), [RunStatus.RUNNING, null]);
  });

  await t.test('(3b) a blocked verdict 24 hours old lets the claim through and clears the sentence', async () => {
    const m = await machine('stale');
    await check(m, BLOCKED);
    const id = await queued(m);
    assert.equal(await claim(m), null);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000 - 60_000).toISOString();
    await sql.query(
      `UPDATE "runner" SET "region" = jsonb_set("region", '{decidedAt}', to_jsonb($2::text)) WHERE id = $1::uuid`,
      [m.runnerId, dayAgo],
    );
    assert.equal((await claim(m))?.sessionId, id);
    assert.deepEqual(await row(id).then((r) => [r.status, r.error]), [RunStatus.RUNNING, null]);
  });

  await t.test('(3c) a switch to a DeepSeek key on the PENDING session lets the claim through and clears the sentence', async () => {
    const m = await machine('switch');
    await check(m, BLOCKED);
    const id = await queued(m);
    assert.equal(await claim(m), null);
    assert.equal((await row(id)).error, refused(m));
    const deepseek = await key(m.ownerId, 'deepseek');
    await sessions.updateConfig(m.ownerId, id, { provider: deepseek });
    assert.equal((await row(id)).status, RunStatus.PENDING, 'a PENDING session is only rewritten; the claim reads it');
    assert.equal((await claim(m))?.sessionId, id);
    assert.deepEqual(await row(id).then((r) => [r.status, r.error, r.provider]), [RunStatus.RUNNING, null, deepseek]);
  });

  await t.test('(3d) a move to another machine releases the hold, and the waiting message runs there', async () => {
    const from = await machine('move-from');
    const to = await machine('move-to', { ownerId: from.ownerId });
    await check(from, BLOCKED);
    await check(to, ALLOWED);
    const id = await queued(from);
    assert.equal(await claim(from), null);
    assert.equal((await row(id)).error, refused(from));
    // A session queued for any other reason must stop first.
    const busy = await queued(to);
    await assert.rejects(sessions.move(from.ownerId, busy, { workspaceId: from.workspaceId }), (error: { getStatus(): number; message: string }) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.message, 'Stop the session first.');
      return true;
    });
    await db.session.update({ where: { id: busy }, data: { status: RunStatus.CANCELLED } });

    const moves = await sessions.moveTargets(from.ownerId, id);
    assert.equal(moves.reason, null, 'the Move panel offers it');
    assert.equal(moves.needsEnd, false, 'and moves it as it is');
    await sessions.move(from.ownerId, id, { workspaceId: to.workspaceId });
    const moved = await row(id);
    assert.deepEqual([moved.status, moved.assignedRunnerId, moved.error], [RunStatus.PENDING, to.runnerId, null]);
    assert.equal(await claim(from), null, 'the machine it left has nothing to claim');
    assert.equal((await claim(to))?.sessionId, id);
    const turn = await dequeue(id, to);
    assert.equal(turn?.content, `the waiting message for ${id}`, 'the message it waited with is the turn handed out there');
  });

  // ── (4) region_refused at spawn ──────────────────────────────────────────────────────────────────────────────────
  await t.test('(4) region_refused at spawn returns the run to the hold, not FAILED, with its message intact', async () => {
    const m = await machine('spawn');
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId: m.ownerId, assigneeId: m.workspaceId, title: 'a task run on Claude', creatorType: 'AGENT',
        creatorId: m.workspaceId, provider: 'claude', status: 'IN_PROGRESS', completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never,
    });
    const id = await queued(m, AgentProvider.CLAUDE, { taskId, startsTaskWork: true });
    // Claimed while its row read allowed; the runner's own check before spawning answers blocked.
    await check(m, ALLOWED);
    assert.equal((await claim(m))?.sessionId, id);
    const [seed] = await turnsOf(id);
    assert.equal(seed.status, 'PENDING', 'the claim seeded the message, undelivered');
    await check(m, BLOCKED);
    const answer = await api.finalize({ id: m.runnerId }, id, {
      status: SharedRunStatus.FAILED,
      subtype: CLAUDE_REGION_REFUSED_SUBTYPE,
      error: refused(m),
    });
    assert.deepEqual(answer, { ok: true, keepCheckout: true });
    const held = await row(id);
    assert.deepEqual([held.status, held.error, held.finishedAt, held.cancelRequestedAt], [RunStatus.PENDING, refused(m), null, null]);
    assert.deepEqual((await turnsOf(id)).map((turn) => [turn.content, turn.status]), [[seed.content, 'PENDING']], 'its message intact');
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, 'IN_PROGRESS', 'its task is told nothing');
    assert.equal(await claim(m), null, 'held');
    // Released, the same message is the one handed out.
    await check(m, ALLOWED);
    assert.equal((await claim(m))?.sessionId, id);
    assert.equal((await row(id)).error, null);
    assert.equal((await dequeue(id, m))?.turnId, seed.id);
  });

  await t.test('(4b) a refusal reported while the row reads allowed waits for the next check', async () => {
    const m = await machine('refused-allowed');
    await check(m, ALLOWED);
    const id = await queued(m);
    assert.equal((await claim(m))?.sessionId, id);
    // Another proxy's check said allowed after the runner's own blocked answer: the row reads allowed.
    await api.finalize({ id: m.runnerId }, id, { status: SharedRunStatus.FAILED, subtype: CLAUDE_REGION_REFUSED_SUBTYPE, error: refused(m) });
    assert.equal(await claim(m), null, 'not claimed again until a check comes in');
    assert.equal((await row(id)).error, refused(m));
    await check(m, ALLOWED);
    assert.equal((await claim(m))?.sessionId, id);
    assert.equal((await row(id)).error, null);
  });

  // ── (5) region_refused at delivery ───────────────────────────────────────────────────────────────────────────────
  await t.test('(5) region_refused at delivery puts the message back in the queue and the session in the hold', async () => {
    const m = await machine('delivery');
    await check(m, BLOCKED);
    const { id, turnId } = await running(m);
    const report = { turnId, status: SharedRunStatus.FAILED, subtype: CLAUDE_REGION_REFUSED_SUBTYPE, error: refused(m), result: refused(m) };
    const answer = await api.turnComplete({ id: m.runnerId }, id, report);
    assert.deepEqual(answer, { ok: true, status: RunStatus.PENDING }, 'the waiting status, which ends the run on the runner');
    const held = await row(id);
    assert.deepEqual([held.status, held.error, held.cancelRequestedAt, held.numTurns], [RunStatus.PENDING, refused(m), null, 1]);
    assert.deepEqual((await turnsOf(id)).map((turn) => [turn.id, turn.status, turn.deliveredAt]), [[turnId, 'PENDING', null]]);
    // A re-post changes nothing.
    assert.deepEqual(await api.turnComplete({ id: m.runnerId }, id, report), { ok: true, status: RunStatus.PENDING });
    assert.deepEqual((await turnsOf(id)).map((turn) => turn.status), ['PENDING']);
    assert.equal(await claim(m), null, 'held');
    await check(m, ALLOWED);
    assert.equal((await claim(m))?.sessionId, id);
    assert.equal((await dequeue(id, m))?.turnId, turnId, 'the same message is delivered once released');
  });

  // ── (6) region_stopped ───────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(6) a region_stopped turn leaves the session resumable with the stopped sentence', async () => {
    const m = await machine('stopped');
    await check(m, BLOCKED);
    await check(m, BLOCKED);
    const stopped = claudeRegionStoppedError(m.name, 'mainland China');
    const { id, turnId } = await running(m);
    const answer = await api.turnComplete({ id: m.runnerId }, id, {
      turnId, status: SharedRunStatus.FAILED, subtype: CLAUDE_REGION_STOPPED_SUBTYPE, error: stopped, numTurns: 1, costUsd: 0.01,
    });
    assert.deepEqual(answer, { ok: true, status: RunStatus.AWAITING_INPUT });
    const rested = await row(id);
    assert.deepEqual([rested.status, rested.error, rested.cancelRequestedAt], [RunStatus.AWAITING_INPUT, stopped, null]);
    assert.deepEqual((await turnsOf(id)).map((turn) => turn.status), ['ANSWERED'], 'the stopped turn is not replayed');
    // Resumable: the next message queues it, and the hold decides.
    await sessions.createTurn(m.ownerId, id, { clientTurnId: randomUUID(), content: 'carry on' });
    assert.equal((await row(id)).status, RunStatus.PENDING);
    assert.equal(await claim(m), null);
    assert.equal((await row(id)).error, refused(m));

    // A message already queued behind the stop waits under the hold.
    const behind = await running(m);
    await db.conversationTurn.create({
      data: { sessionId: behind.id, seq: 2, clientTurnId: `turn-${randomUUID()}`, kind: 'message', content: 'and then this', status: 'PENDING' },
    });
    assert.deepEqual(
      await api.turnComplete({ id: m.runnerId }, behind.id, {
        turnId: behind.turnId, status: SharedRunStatus.FAILED, subtype: CLAUDE_REGION_STOPPED_SUBTYPE, error: stopped,
      }),
      { ok: true, status: RunStatus.PENDING },
    );
    assert.deepEqual(await row(behind.id).then((r) => [r.status, r.error]), [RunStatus.PENDING, stopped]);

    // Reported on finalize instead: the same rest, and the run's checkout is kept.
    const viaFinalize = await running(m);
    assert.deepEqual(
      await api.finalize({ id: m.runnerId }, viaFinalize.id, { status: SharedRunStatus.FAILED, subtype: CLAUDE_REGION_STOPPED_SUBTYPE, error: stopped }),
      { ok: true, keepCheckout: true },
    );
    const finalized = await row(viaFinalize.id);
    assert.deepEqual([finalized.status, finalized.error, finalized.finishedAt], [RunStatus.AWAITING_INPUT, stopped, null]);
    assert.deepEqual((await turnsOf(viaFinalize.id)).map((turn) => turn.status), ['ANSWERED']);
  });

  // ── (7) new sessions ─────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(7) an Anthropic-bound Claude session for the blocked runner is refused 409 with the code', async () => {
    const m = await machine('create');
    await check(m, BLOCKED);
    const before = await db.session.count({ where: { ownerId: m.ownerId } });
    for (const provider of [AgentProvider.CLAUDE, await key(m.ownerId, 'anthropic-preset')]) {
      await assert.rejects(
        sessions.create(m.ownerId, { prompt: 'hello', workspaceId: m.workspaceId, provider }),
        (error: { getStatus(): number; getResponse(): unknown }) => {
          assert.equal(error.getStatus(), 409);
          assert.deepEqual(error.getResponse(), {
            code: CLAUDE_REGION_UNSUPPORTED,
            message: `Claude Code can’t use Anthropic on ${m.name}: its connection is in mainland China, where Anthropic doesn’t offer Claude. Pick a key from another provider, or a workspace on another machine.`,
            runnerId: m.runnerId,
          });
          return true;
        },
      );
    }
    assert.equal(await db.session.count({ where: { ownerId: m.ownerId } }), before, 'nothing was created');
    const deepseek = await sessions.create(m.ownerId, { prompt: 'hello', workspaceId: m.workspaceId, provider: await key(m.ownerId, 'deepseek') });
    assert.equal((await row(deepseek.id)).status, RunStatus.PENDING);
  });

  // ── (8) Claude sign-in ───────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(8) a Claude sign-in on the blocked runner is refused with board 04’s sentence', async () => {
    const m = await machine('sign-in');
    const sentence = `Claude sign-in isn’t available on ${m.name}: its connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.`;
    // One already pending when the verdict turns: the heartbeat hands out none and fails it with the sentence.
    await runners.startLogin(m.ownerId, m.runnerId, { engine: 'claude' });
    await check(m, BLOCKED);
    const drain = (api as unknown as {
      drainLoginRequest(runnerId: string, capabilities: string | string[] | undefined): Promise<unknown>;
    }).drainLoginRequest.bind(api);
    assert.equal(await drain(m.runnerId, `${SESSION_MOVE_V1},${CLAUDE_REGION_V1}`), undefined, 'no login request goes out');
    const failed = await db.runner.findUniqueOrThrow({ where: { id: m.runnerId } });
    assert.deepEqual([failed.loginStatus, failed.loginMessage], ['failed', sentence]);
    // A new one is refused at once, and nothing is recorded.
    await db.runner.update({ where: { id: m.runnerId }, data: { loginStatus: null, loginMessage: null, loginAt: null } });
    await assert.rejects(runners.startLogin(m.ownerId, m.runnerId, { engine: 'claude' }), (error: { getStatus(): number; getResponse(): { message?: string } }) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().message, sentence);
      return true;
    });
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: m.runnerId } })).loginStatus, null);
  });

  // ── (9) the push ─────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('(9) the confirmed flip is the blocked check that takes blockedChecks to 2, once per run of them', async () => {
    const m = await machine('flip');
    const flips: boolean[] = [];
    // An unknown check right after the flip leaves the count at 2: it is not the flip again.
    for (const answer of [BLOCKED, UNKNOWN, BLOCKED, UNKNOWN, BLOCKED, ALLOWED, BLOCKED, BLOCKED, BLOCKED]) {
      flips.push(regionFlipConfirmed(answer.verdict, await check(m, answer)));
    }
    assert.deepEqual(flips, [false, false, true, false, false, false, false, true, false]);
  });

  // ── (10) a task's run under model routing ────────────────────────────────────────────────────────────────────────
  await t.test('(10) model routing rules Claude’s sign-in out on the blocked runner, as a signed-out one, and nowhere else', async () => {
    const ownerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `routing-${ownerId}@region-hold.invalid`, name: 'The owner', passwordHash: 'x', preferences: { modelRouting: true } },
    });
    const m = await machine('routing', { ownerId });
    await db.runner.update({
      where: { id: m.runnerId },
      data: {
        modelCatalog: {
          claude: [{ value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', priority: 0, permissionModes: ['default', 'auto'] }],
          codex: [{ value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', priority: 0, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }],
        },
        runtimeDefaultModels: { claude: 'claude-sonnet-5-5', codex: 'gpt-5.5-codex' },
        engines: [{ engine: 'claude', installed: true, auth: 'yes' }, { engine: 'codex', installed: true, auth: 'yes' }] as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.update({ where: { id: m.workspaceId }, data: { modelRouting: true, modelRoutingProviders: ['codex'] } });
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, assigneeId: m.workspaceId, title: 'a task its agent runs on Claude', creatorType: 'AGENT',
        creatorId: m.workspaceId, status: 'OPEN', completionCriterion: 'EVIDENCE_JUDGMENT', modelHint: 'M',
      } as never,
    });
    const route = () => planTaskRunRoute(taskRouteReads(prisma, ownerId), { id: taskId, modelHint: 'M' }, { id: m.workspaceId, runnerId: m.runnerId }, 'the work');
    const allowed = await route();
    assert.equal(allowed?.engine, AgentProvider.CLAUDE, `stays on its own engine where the region is fine: ${JSON.stringify(allowed?.reasons)}`);
    await check(m, BLOCKED);
    const blocked = await route();
    assert.equal(blocked?.engine, AgentProvider.CODEX, JSON.stringify(blocked?.reasons));
    assert.ok(blocked?.reasons.includes('Engine codex: claude can’t use Anthropic on this runner'), JSON.stringify(blocked?.reasons));
  });
});
