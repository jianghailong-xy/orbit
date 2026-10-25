/**
 * The T3 follow-up on a real PostgreSQL (docs/provider-engine-contract.md §4.5, §10): the quota gate on a
 * key holding a Claude subscription token, the same gate on an API key, and the engine pin a crossing
 * binds. The sweep is driven as the service's one timer drives it, with one clock under each case's
 * control — `TasksService.now`, the instant the backoff and the quota gate decide against — so nothing
 * here waits on wall time. Named in scripts/test-provider-engine-followups.mjs; a missing server is a
 * failure, not a skip. Destructive: it seeds rows, so it runs only against a disposable server.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { HttpException } from '@nestjs/common';
import { CreatorType, Prisma, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { handoffPayloadDigest } from '../projects/project-handoff';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProvidersService } from '../providers/providers.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { QUOTA_BLIND_RETRY_BACKOFF_MS } from './task-retry-policy';
import { TasksService } from './tasks.service';

const PG_URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'provider-engine-followups-spec';
const SUBSCRIPTION_TOKEN = 'sk-ant-oat01-subscription';
const API_KEY = 'sk-ant-api03-metered';
/** Claude Code's refusal once the 5-hour window is spent — one of the usage-limit markers. */
const QUOTA_ERROR = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";
const MINUTE = 60_000;
const CLAUDE = AgentProvider.CLAUDE;

type World = { ownerId: string; workspaceId: string; projectId: string; prerequisiteId: string };
type Run = { id: string; status: RunStatus; engine: string | null; provider: string; createdAt: Date };

/** A write's typed refusal, as its body. */
async function refusalOf(write: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await write();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected a typed refusal, got ${String(error)}`);
    return error.getResponse() as Record<string, unknown>;
  }
  assert.fail('the write was not refused');
}

test('T3 follow-up on PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(PG_URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, realtime,
  );
  const handoffs = new ProjectHandoffService(prisma);
  const tasks = new TasksService(prisma, sessions, realtime, handoffs);
  const clock = { now: new Date() };
  (tasks as unknown as { now: () => Date }).now = () => clock.now;
  // No credential here reports a quota of its own.
  const providers = new ProvidersService(prisma, realtime, { snapshot: () => null } as never);

  async function account(label: string): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@followups.invalid`, name: label, passwordHash: 'x' } });
    return id;
  }
  /**
   * An owner's runner with Claude Code signed in, reporting `planUsage` (none when absent), its
   * workspace, a started project with no coordinator — so the dependency scan starts its tasks — and a
   * finished task for them to wait on.
   */
  async function world(label: string, planUsage?: Prisma.InputJsonValue): Promise<World> {
    const ownerId = await account(label);
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: label, tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE, maxConcurrent: 10,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
      engines: [{ engine: 'claude', installed: true, auth: 'yes' }] as Prisma.InputJsonValue,
      ...(planUsage ? { planUsage } : {}),
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: label, enabled: true } });
    await db.project.create({ data: {
      id: projectId, ownerId, title: label, coordinatorEnabled: false, maxConcurrentTasks: 10, startedAt: new Date(),
    } });
    await establishProjectContractForPgTest(db, ownerId, projectId, label);
    const prerequisite = await db.task.create({ data: {
      ownerId, projectId, assigneeId: workspaceId, title: 'done first', creatorType: CreatorType.USER,
      creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.DONE, autoRunWhenReady: false,
    } });
    return { ownerId, workspaceId, projectId, prerequisiteId: prerequisite.id };
  }
  /** A key connected through the door a person uses. */
  async function connect(ownerId: string, preset: 'anthropic' | 'deepseek', apiKey: string): Promise<string> {
    const baseUrl = preset === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/anthropic';
    const row = await providers.create(ownerId, {
      label: `${preset} ${randomUUID().slice(0, 6)}`, presetSlug: preset, baseUrl, apiKey,
    } as never) as { slug: string };
    return row.slug;
  }
  /** An OPEN auto-run task pinned to `pin`, whose one prerequisite is DONE: READY, so the sweep starts it. */
  async function readyTask(w: World, title: string, pin: { engine: string; provider: string }): Promise<string> {
    const task = await db.task.create({ data: {
      ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.workspaceId, title, creatorType: CreatorType.USER,
      creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN, autoRunWhenReady: true,
      ...pin,
    } });
    await db.taskDependency.create({ data: { taskId: task.id, dependsOnTaskId: w.prerequisiteId } });
    return task.id;
  }
  const runs = (taskId: string): Promise<Run[]> => db.session.findMany({
    where: { taskId, startsTaskWork: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, engine: true, provider: true, createdAt: true },
  });
  /** One pass of the ready sweep, as the service's timer runs it. */
  const sweep = () => (tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
  /** The run ends FAILED as the runner's /finalize leaves a usage limit with no retry of its own armed. */
  const killedByQuota = (run: Run) => db.session.update({
    where: { id: run.id }, data: { status: RunStatus.FAILED, error: QUOTA_ERROR, finishedAt: new Date() },
  });
  /** Why the sweep is not starting the task again, as the task read reports it. */
  async function skipped(ownerId: string, taskId: string) {
    const read = await tasks.get(ownerId, taskId) as unknown as {
      autoRunSkipped?: { code: string; sessionId: string | null; retryAt?: Date | null } | null;
    };
    return read.autoRunSkipped ?? null;
  }
  const brakeEnds = (run: Run) => new Date(run.createdAt.getTime() + QUOTA_BLIND_RETRY_BACKOFF_MS);

  await t.test('T3 follow-up: a task on a key holding a Claude subscription token that hits its usage limit waits out the brake a sign-in nobody reports gets, and is not re-dispatched every minute', async () => {
    // The runner reports no quota at all, so its own sign-in's brake is the flat one: the token's is too.
    const w = await world('subscription-brake');
    const token = await connect(w.ownerId, 'anthropic', SUBSCRIPTION_TOKEN);
    const onToken = await readyTask(w, 'on the subscription token', { engine: CLAUDE, provider: token });
    const onSignIn = await readyTask(w, 'on the runner sign-in', { engine: CLAUDE, provider: CLAUDE });
    clock.now = new Date();
    await sweep();
    const [tokenRun] = await runs(onToken);
    const [signInRun] = await runs(onSignIn);
    assert.ok(tokenRun && signInRun, 'the first sweep did not start both tasks');
    assert.deepEqual([tokenRun.engine, tokenRun.provider], [CLAUDE, token]);
    await killedByQuota(tokenRun);
    await killedByQuota(signInRun);

    // Every minute of the brake, as the timer sweeps: neither task starts again.
    for (let minutes = 1; minutes < QUOTA_BLIND_RETRY_BACKOFF_MS / MINUTE; minutes += 1) {
      clock.now = new Date(tokenRun.createdAt.getTime() + minutes * MINUTE);
      await sweep();
      assert.equal((await runs(onToken)).length, 1, `the token's task was re-dispatched ${minutes} min after its usage limit`);
      assert.equal((await runs(onSignIn)).length, 1, `the sign-in's task was re-dispatched ${minutes} min after its usage limit`);
    }
    // The read says until when, the same for both: the end of the blind brake, not a reset nobody reported.
    for (const [taskId, run] of [[onToken, tokenRun], [onSignIn, signInRun]] as const) {
      const read = await skipped(w.ownerId, taskId);
      assert.equal(read?.code, 'RETRY_BACKOFF');
      assert.equal(read?.sessionId, run.id);
      assert.deepEqual(read?.retryAt, brakeEnds(run));
    }

    // A second after the brake: each task runs once more, on the engine and credential it was pinned to.
    clock.now = new Date(Math.max(brakeEnds(tokenRun).getTime(), brakeEnds(signInRun).getTime()) + 1_000);
    await sweep();
    const tokenRuns = await runs(onToken);
    assert.equal(tokenRuns.length, 2, 'the token was not tried again once the brake ended');
    assert.deepEqual([tokenRuns[1].status, tokenRuns[1].engine, tokenRuns[1].provider], [RunStatus.PENDING, CLAUDE, token]);
    assert.equal((await runs(onSignIn)).length, 2, 'the sign-in was not tried again once the brake ended');
    assert.equal(await skipped(w.ownerId, onToken), null);
  });

  await t.test('T3 follow-up: a task on an API key is held neither by the runner report on its engine sign-in nor by its own usage-limit failure, as before', async () => {
    // Claude Code's week is spent on the runner: its own sign-in can start nothing until it resets.
    const resetsAt = new Date(Date.now() + 3 * 86_400_000);
    const w = await world('api-key-gate', {
      claude: { sevenDay: { utilization: 100, resetsAt: resetsAt.toISOString() } },
    } as Prisma.InputJsonValue);
    const apiKey = await connect(w.ownerId, 'anthropic', API_KEY);
    const token = await connect(w.ownerId, 'anthropic', SUBSCRIPTION_TOKEN);
    const onKey = await readyTask(w, 'on the API key', { engine: CLAUDE, provider: apiKey });
    const onToken = await readyTask(w, 'on the subscription token', { engine: CLAUDE, provider: token });
    const onSignIn = await readyTask(w, 'on the spent sign-in', { engine: CLAUDE, provider: CLAUDE });
    clock.now = new Date();
    await sweep();
    // The runner's numbers are its sign-in's: both keys start, and the sign-in waits for its reset.
    const [keyRun] = await runs(onKey);
    const [tokenRun] = await runs(onToken);
    assert.ok(keyRun, "a run on an API key was held by the runner's report on Claude Code's sign-in");
    assert.ok(tokenRun, "a run on a subscription token was held by the runner's report on Claude Code's sign-in");
    assert.deepEqual(await runs(onSignIn), [], 'a run on the spent sign-in was started anyway');

    // Both keys' runs are killed by a usage limit; the sweep's next pass comes a minute later.
    await killedByQuota(keyRun);
    await killedByQuota(tokenRun);
    clock.now = new Date(Math.max(keyRun.createdAt.getTime(), tokenRun.createdAt.getTime()) + MINUTE);
    await sweep();
    // The API key is not blind: its failure is no evidence about a window it does not have, and it is
    // tried again at once, as before.
    const keyRuns = await runs(onKey);
    assert.equal(keyRuns.length, 2, "the API key's usage-limit failure held its task back");
    assert.deepEqual([keyRuns[1].status, keyRuns[1].engine, keyRuns[1].provider], [RunStatus.PENDING, CLAUDE, apiKey]);
    assert.equal(await skipped(w.ownerId, onKey), null);
    // The subscription token beside it waits out its brake, and the sign-in still waits for its reset.
    assert.equal((await runs(onToken)).length, 1, 'the subscription token was re-dispatched a minute after its usage limit');
    assert.equal((await skipped(w.ownerId, onToken))?.code, 'RETRY_BACKOFF');
    assert.deepEqual(await runs(onSignIn), [], 'a run on the spent sign-in was started before its reset');
  });

  await t.test('T3 follow-up: a crossing binds the engine pin beside the provider pin, and the task lands on the engine and key that were approved', async () => {
    const ownerId = await account('crossing');
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const [projectA, projectB, sessionA] = [randomUUID(), randomUUID(), randomUUID()];
    await sql.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,'crossing','ONLINE',$3,now())`, [runnerId, ownerId, `x-${runnerId}`]);
    await sql.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,'crossing',$3,true,true)`, [workspaceId, ownerId, runnerId]);
    for (const id of [projectA, projectB]) {
      await sql.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,$3,true,now())`, [id, ownerId, `crossing ${id.slice(0, 4)}`]);
      await sql.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`, [id]);
    }
    // A's coordinator, inside a turn: what it files over the line is a crossing, asked of the owner.
    await sql.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id","provider","status",
         "dispatch_origin","updated_at")
       VALUES ($1,$2,$3,'coordinator of A','fixture',$2,'claude','RUNNING'::"run_status",
         'USER'::"session_dispatch_origin",now())`, [sessionA, ownerId, workspaceId]);
    await sql.query(
      `INSERT INTO "conversation_turn" ("id","session_id","seq","client_turn_id","kind","status")
       VALUES ($1,$2,1,'crossing-turn','message','IN_FLIGHT')`, [randomUUID(), sessionA]);
    await sql.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid', [projectA, sessionA]);
    // A DeepSeek key, which Claude Code, OpenCode and DeepSeek Harness all run.
    const deepseek = await connect(ownerId, 'deepseek', `sk-${randomUUID()}`);

    const title = 'run it on DeepSeek Harness';
    const file = (pins: Record<string, unknown>) => tasks.create(ownerId, {
      title, projectId: projectB, handoff: { reason: 'it belongs over there' }, ...pins,
    } as never, { type: CreatorType.AGENT, id: ownerId }, sessionA);
    const questions = async () => (await sql.query<{ id: string; state: string; payload_digest: string; applied_task_id: string | null }>(
      `SELECT "id","state","payload_digest","applied_task_id" FROM "project_handoff_approval"
        WHERE "owner_id" = $1::uuid ORDER BY "requested_at","id"`, [ownerId])).rows;
    const digestOn = (engine: string) => handoffPayloadDigest({
      plan: { title, engine, provider: deepseek },
      source: { projectId: projectA, taskId: null, sessionId: sessionA, triggerEvent: 'coordinator.session_filed' },
    });
    const inB = () => db.task.findMany({ where: { projectId: projectB }, select: { id: true } });

    // Asked on DeepSeek Harness: the question the owner answers binds that engine beside the key.
    const asked = await refusalOf(() => file({ engine: AgentProvider.DSH, provider: deepseek }));
    assert.equal(asked.code, 'APPROVAL_PENDING');
    const [question] = await questions();
    assert.equal(asked.handoffId, question.id);
    assert.equal(question.payload_digest, digestOn(AgentProvider.DSH));
    assert.notEqual(question.payload_digest, digestOn(CLAUDE));
    await handoffs.decide(ownerId, ownerId, question.id, 'APPROVE', new Date());

    // The same key on Claude Code is another run, so another question: the yes is not spent on it.
    const onClaude = await refusalOf(() => file({ engine: CLAUDE, provider: deepseek }));
    assert.equal(onClaude.code, 'APPROVAL_PENDING');
    assert.notEqual(onClaude.handoffId, question.id, 'a yes to DeepSeek Harness was offered for Claude Code');
    // The key named alone runs on its own engine, Claude Code: that question again, not a third.
    const alone = await refusalOf(() => file({ provider: deepseek }));
    assert.equal(alone.handoffId, onClaude.handoffId);
    assert.equal((await questions()).length, 2);
    assert.deepEqual(await inB(), [], 'a write the owner did not approve landed');

    // The approved write lands on the engine and the key it was approved on, and spends the yes.
    const landed = await file({ engine: AgentProvider.DSH, provider: deepseek }) as { id: string };
    assert.deepEqual(
      await db.task.findUniqueOrThrow({ where: { id: landed.id }, select: { projectId: true, engine: true, provider: true } }),
      { projectId: projectB, engine: AgentProvider.DSH, provider: deepseek },
    );
    const spent = (await questions()).find((row) => row.id === question.id);
    assert.equal(spent?.state, 'APPLIED');
    assert.equal(spent?.applied_task_id, landed.id);
  });
});
