import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, type Task } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { AttemptSpend } from '../projects/attempt-budget';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { TaskModelRoutingReportService, type ModelRoutingReportGroup } from './task-model-routing-report.service';

const PG_URL = process.env.COORDINATOR_PG_URL;
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

/**
 * F1: DeepSeek Harness turns report no cost or tokens, so its sessions keep `cost_usd` 0 and no usage
 * rows. The model-routing report and the attempt budget read that as unknown — never $0 / 0 tokens —
 * while every engine that measured its usage reads exactly as before.
 */
test('F1 dsh usage is unknown in the routing report and attempt budget', {
  skip: !PG_URL, concurrency: 1, timeout: 120_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(PG_URL);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });

  const owner = randomUUID();
  await db.user.create({
    data: { id: owner, email: `${owner}@dsh-usage.invalid`, name: 'dsh usage', passwordHash: 'h', preferences: { modelRouting: true } },
  });
  const agent = await db.workspace.create({ data: { ownerId: owner, name: 'dsh usage agent' } });
  const harnessSlug = `deepseek-harness-${owner.slice(0, 8)}`;
  const claudeOnDeepseekSlug = `deepseek-${owner.slice(0, 8)}`;
  await db.modelProvider.create({ data: {
    slug: harnessSlug, label: 'DeepSeek Harness', runtime: 'dsh', baseUrl: 'https://api.deepseek.com', apiKeyEnc: 'x', ownerId: owner,
  } });
  await db.modelProvider.create({ data: {
    slug: claudeOnDeepseekSlug, label: 'DeepSeek', runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: 'x', ownerId: owner,
  } });

  async function task(data: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
    return db.task.create({ data: {
      ownerId: owner, creatorType: 'USER', creatorId: owner, title: 'dsh usage task', status: 'DONE',
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, assigneeId: agent.id, ...data,
    } });
  }
  async function run(subject: Task, seconds: number, data: Partial<Prisma.SessionUncheckedCreateInput>) {
    const session = await db.session.create({ data: {
      ownerId: owner, creatorId: owner, title: 'dsh usage run', prompt: 'run', taskId: subject.id, workspaceId: agent.id,
      startsTaskWork: true, provider: 'claude', model: 'm', effort: 'low', status: 'SUCCEEDED', numTurns: 2,
      createdAt: at(seconds), finishedAt: at(seconds + 10), ...data,
    } });
    await db.taskRouteDecision.create({ data: {
      ownerId: owner, taskId: subject.id, requestToken: randomUUID(), sessionId: session.id, createdAt: at(seconds),
      policyVersion: 1, level: 'M', applied: false, provider: 'claude', model: 'm', effort: 'low', baseline: {}, features: {}, reasons: [],
    } });
    return session;
  }

  // Native Harness and a configured Harness key: no cost, no usage rows.
  const native = await run(await task(), 100, { provider: 'dsh', providerBuiltin: true, model: 'dsh-model' });
  const configured = await run(await task(), 200, { provider: harnessSlug, model: 'dsh-model' });
  // Harness and a measured engine on one completed task: the task's spend is unknown as a whole.
  const mixedTask = await task();
  await run(mixedTask, 300, { provider: 'dsh', providerBuiltin: true, model: 'dsh-mixed' });
  const mixedClaude = await run(mixedTask, 400, { model: 'claude-mixed', costUsd: 2 });
  await db.llmUsage.create({ data: { sessionId: mixedClaude.id, model: 'claude-mixed', inputTokens: 100, outputTokens: 50 } });
  // Measured engines: Claude with cost and tokens, Codex with tokens and a reported $0, and the
  // existing DeepSeek preset that borrows Claude Code.
  const claude = await run(await task(), 500, { model: 'claude-known', costUsd: 1.5 });
  await db.llmUsage.create({ data: { sessionId: claude.id, model: 'claude-known', inputTokens: 300, outputTokens: 200 } });
  const codex = await run(await task(), 600, { provider: 'codex', model: 'codex-known' });
  await db.llmUsage.create({ data: { sessionId: codex.id, model: 'codex-known', inputTokens: 700 } });
  const borrowed = await run(await task(), 700, { provider: claudeOnDeepseekSlug, model: 'deepseek-claude' });
  // A Harness build that did report usage is measured, not unknown.
  const reportingHarness = await run(await task(), 800, { provider: 'dsh', providerBuiltin: true, model: 'dsh-reporting', costUsd: 0.25 });
  await db.llmUsage.create({ data: { sessionId: reportingHarness.id, model: 'dsh-reporting', inputTokens: 40 } });

  const report = await new TaskModelRoutingReportService(db as unknown as PrismaService).read(owner);
  const group = (provider: string, model: string): ModelRoutingReportGroup => {
    const found = report.shadow.filter((row) => row.provider === provider && row.model === model);
    assert.equal(found.length, 1, JSON.stringify(report));
    return found[0];
  };
  const usage = ({ tokensPerCompletedTask, costUsdPerCompletedTask, usageUnknownCompletedTaskCount }: ModelRoutingReportGroup) =>
    ({ tokensPerCompletedTask, costUsdPerCompletedTask, usageUnknownCompletedTaskCount });

  const attempts = new SessionAttemptService(db as unknown as PrismaService, null as never);
  const spend = (sessionId: string): Promise<AttemptSpend> =>
    (attempts as unknown as { measure: (tx: unknown, attempt: unknown, now: Date) => Promise<AttemptSpend> })
      .measure(db, { sessionId, ownerId: owner, createdAt: at(0), coordinatorSteers: 0 }, at(1000));

  await t.test('F1 routing report marks dsh usage unknown instead of $0 and 0 tokens', async () => {
    const unknown = { tokensPerCompletedTask: null, costUsdPerCompletedTask: null, usageUnknownCompletedTaskCount: 1 };
    assert.deepEqual(usage(group('dsh', 'dsh-model')), unknown);
    assert.deepEqual(usage(group(harnessSlug, 'dsh-model')), unknown);
    // The mixed task's first run is Harness; its whole cohort's spend is unknown.
    assert.deepEqual(usage(group('dsh', 'dsh-mixed')), unknown);
  });

  await t.test('F1 routing report keeps measured engines unchanged', async () => {
    assert.deepEqual(usage(group('claude', 'claude-known')),
      { tokensPerCompletedTask: 500, costUsdPerCompletedTask: 1.5, usageUnknownCompletedTaskCount: 0 });
    assert.deepEqual(usage(group('codex', 'codex-known')),
      { tokensPerCompletedTask: 700, costUsdPerCompletedTask: 0, usageUnknownCompletedTaskCount: 0 });
    assert.deepEqual(usage(group(claudeOnDeepseekSlug, 'deepseek-claude')),
      { tokensPerCompletedTask: 0, costUsdPerCompletedTask: 0, usageUnknownCompletedTaskCount: 0 });
    assert.deepEqual(usage(group('dsh', 'dsh-reporting')),
      { tokensPerCompletedTask: 40, costUsdPerCompletedTask: 0.25, usageUnknownCompletedTaskCount: 0 });
  });

  await t.test('F1 attempt budget spend leaves dsh cost unmeasured', async () => {
    for (const id of [native.id, configured.id]) {
      const measured = await spend(id);
      assert.equal(measured.costMicros, null);
      assert.equal(measured.turns, 2);
    }
  });

  await t.test('F1 attempt budget spend keeps measured costs including zero', async () => {
    assert.equal((await spend(claude.id)).costMicros, 1_500_000);
    assert.equal((await spend(codex.id)).costMicros, 0);
    assert.equal((await spend(borrowed.id)).costMicros, 0);
    assert.equal((await spend(reportingHarness.id)).costMicros, 250_000);
  });
});
