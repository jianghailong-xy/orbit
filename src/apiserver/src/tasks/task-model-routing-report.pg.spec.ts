import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Prisma, type Task } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { TaskModelRoutingReportController } from './task-model-routing-report.controller';
import { TaskModelRoutingReportService, type ModelRoutingReportGroup } from './task-model-routing-report.service';

const PG_URL = process.env.COORDINATOR_PG_URL;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const CODEX = 'gpt-6.1';
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);
type Report = { shadow: ModelRoutingReportGroup[]; applied: ModelRoutingReportGroup[] };

test('model-routing report aggregates actual runs, first-run task cohorts and only the authenticated owner', {
  skip: !PG_URL, concurrency: 1, timeout: 120_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(PG_URL);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    await db.$disconnect();
    await sql.end();
  });

  const owner = randomUUID();
  const otherOwner = randomUUID();
  // Both accounts have smart model selection on, as an account whose runs were routed has.
  for (const id of [owner, otherOwner]) {
    await db.user.create({
      data: { id, email: `${id}@routing-report.invalid`, name: 'report', passwordHash: 'h', preferences: { modelRouting: true } },
    });
  }
  const agent = await db.workspace.create({ data: { ownerId: owner, name: 'first agent' } });
  const laterAgent = await db.workspace.create({ data: { ownerId: owner, name: 'later agent' } });
  const otherAgent = await db.workspace.create({ data: { ownerId: otherOwner, name: 'other owner agent' } });

  async function task(data: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
    const completionCriterion = data.completionCriterion ?? 'EXECUTABLE';
    return db.task.create({ data: {
      ownerId: owner, creatorType: 'USER', creatorId: owner, title: 'report task', status: 'DONE',
      completionCriterion, acceptanceCommand: completionCriterion === 'EXECUTABLE' ? 'true' : null,
      acceptanceExpectedExitCode: completionCriterion === 'EXECUTABLE' ? 0 : null,
      assigneeId: agent.id, ...data,
    } });
  }
  async function run(subject: Task, seconds: number, duration: number | null, data: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    return db.session.create({ data: {
      ownerId: subject.ownerId, creatorId: subject.ownerId, title: 'report run', prompt: 'report', taskId: subject.id,
      workspaceId: subject.ownerId === owner ? agent.id : otherAgent.id, startsTaskWork: true,
      provider: 'claude', model: OPUS, effort: 'low', status: 'SUCCEEDED', createdAt: at(seconds),
      finishedAt: duration === null ? null : at(seconds + duration), ...data,
    } });
  }
  async function route(subject: Task, sessionId: string | null, seconds: number, data: Partial<Prisma.TaskRouteDecisionUncheckedCreateInput> = {}) {
    return db.taskRouteDecision.create({ data: {
      ownerId: subject.ownerId, taskId: subject.id, requestToken: randomUUID(), sessionId, createdAt: at(seconds),
      policyVersion: 1, level: 'S', applied: false, provider: 'claude', model: SONNET, effort: 'low',
      baseline: {}, features: {}, reasons: [], ...data,
    } });
  }
  async function tokens(sessionId: string, count: number) {
    await db.llmUsage.create({ data: { sessionId, model: CODEX, inputTokens: count, costUsd: 999 } });
  }
  async function decision(subject: Task, sessionId: string, seconds: number, value: 'CONFIRM' | 'SEND_BACK') {
    const revision = BigInt(await db.taskCompletionEvidence.count({ where: { taskId: subject.id } })) + 1n;
    const fact = await db.taskCompletionEvidence.create({ data: {
      taskId: subject.id, ownerId: subject.ownerId, actorType: 'AGENT', actorId: agent.id, sourceSessionId: sessionId,
      criterionRevision: 'a'.repeat(64), criterion: {}, evidence: {}, evidenceDigest: String(revision).padStart(64, '0'), revision,
    } });
    await db.taskEvidenceDecision.create({ data: {
      ownerId: subject.ownerId, taskId: subject.id, evidenceId: fact.id,
      criterionRevision: fact.criterionRevision, evidenceDigest: fact.evidenceDigest, decision: value,
      note: 'fixture judgment', decidedAt: at(seconds), decidedByType: 'AGENT', decidedById: agent.id,
      decidingSessionId: randomUUID(),
    } });
  }
  async function verifier(subject: Task, seconds: number, verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE') {
    return task({ verifiesTaskId: subject.id, verdict, updatedAt: at(seconds), completionCriterion: 'EVIDENCE_JUDGMENT' });
  }

  const firstPass = await task();
  const first = await run(firstPass, 100, 10, { costUsd: 1 });
  await route(firstPass, first.id, 100);
  await db.llmUsage.createMany({ data: [
    { sessionId: first.id, model: OPUS, inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUsd: 900 },
    { sessionId: first.id, model: SONNET, inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUsd: 900 },
  ] });
  await verifier(firstPass, 120, 'PASS');
  await decision(firstPass, first.id, 125, 'CONFIRM');
  // A read-only/salvage session predating run 1 is neither an attempt nor part of its cost.
  const conversation = await run(firstPass, 1, 1, { startsTaskWork: false, status: 'FAILED', costUsd: 100_000 });
  await tokens(conversation.id, 100_000);
  await route(firstPass, conversation.id, 1);
  await verifier(firstPass, 20, 'FAIL');
  await decision(firstPass, conversation.id, 30, 'SEND_BACK');

  const retried = await task();
  const failed = await run(retried, 200, 30, { status: 'FAILED', error: 'acceptance command exited 1; expected 0', costUsd: 2 });
  await route(retried, failed.id, 200);
  await tokens(failed.id, 200);
  // Both later rejection signals belong to the failed first run and do not inflate its count.
  await verifier(retried, 240, 'FAIL');
  await decision(retried, failed.id, 245, 'SEND_BACK');
  const escalated = await run(retried, 300, 50, { effort: 'high', costUsd: 3 });
  await route(retried, escalated.id, 300, { policyVersion: 2, level: 'L', applied: true, model: OPUS, effort: 'high' });
  await tokens(escalated.id, 300);
  const quota = await run(retried, 400, 5, {
    workspaceId: laterAgent.id, provider: 'codex', model: CODEX, status: 'FAILED', error: "You've HIT YOUR USAGE LIMIT",
  });
  await tokens(quota.id, 400);
  const completed = await run(retried, 500, 15, { workspaceId: laterAgent.id, provider: 'codex', model: CODEX });
  await tokens(completed.id, 500);
  // Current task assignment cannot change which Agent ran the first sample.
  await db.task.update({ where: { id: retried.id }, data: { assigneeId: laterAgent.id } });

  const rejected = await task({ completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED' });
  const rejectedRun = await run(rejected, 600, 20, { costUsd: 3 });
  await route(rejected, rejectedRun.id, 600);
  await tokens(rejectedRun.id, 290);
  await verifier(rejected, 630, 'FAIL');
  await verifier(rejected, 635, 'FAIL');

  const unfinished = await task({ status: 'OPEN', completionCriterion: 'EVIDENCE_JUDGMENT' });
  const unfinishedRun = await run(unfinished, 700, 40, { costUsd: 100 });
  await route(unfinished, unfinishedRun.id, 700);
  await tokens(unfinishedRun.id, 10_000);
  await verifier(unfinished, 745, 'INCONCLUSIVE');
  await decision(unfinished, unfinishedRun.id, 750, 'SEND_BACK');

  // The first run predates routing. Its later decision is a run sample, never a task cohort.
  const legacy = await task();
  const beforeRouting = await run(legacy, 50, 5, { status: 'FAILED', costUsd: 9 });
  await tokens(beforeRouting.id, 999);
  const legacyRetry = await run(legacy, 800, 60, { costUsd: 9 });
  await route(legacy, legacyRetry.id, 800);
  await tokens(legacyRetry.id, 999);

  const applied = await task();
  const appliedRun = await run(applied, 900, 12, { costUsd: 2 });
  await route(applied, appliedRun.id, 900, { applied: true, model: OPUS });
  await tokens(appliedRun.id, 500);
  const quotaOnly = await task({ status: 'FAILED' });
  const quotaOnlyRun = await run(quotaOnly, 920, 10, { status: 'FAILED', error: "You've HIT YOUR WEEKLY LIMIT" });
  await route(quotaOnly, quotaOnlyRun.id, 920, { applied: true });
  await tokens(quotaOnlyRun.id, 700);

  const unroutedFailed = await task({ status: 'FAILED' });
  const unroutedFailedRun = await run(unroutedFailed, 1000, 8, { provider: 'codex-pool', model: CODEX, status: 'FAILED', error: null });
  await route(unroutedFailed, unroutedFailedRun.id, 1000, { policyVersion: 2, level: null });
  await tokens(unroutedFailedRun.id, 800);
  const unroutedDone = await task();
  const unroutedDoneRun = await run(unroutedDone, 1020, 16, { provider: 'codex-pool', model: CODEX });
  await route(unroutedDone, unroutedDoneRun.id, 1020, { policyVersion: 2, level: null });
  await db.llmUsage.create({ data: {
    sessionId: unroutedDoneRun.id, model: CODEX, inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 500,
  } });
  const pending = await task({ status: 'IN_PROGRESS' });
  const pendingRun = await run(pending, 1100, null, { status: 'PENDING', provider: 'codex', model: null });
  await route(pending, pendingRun.id, 1100, { policyVersion: 3, level: 'M' });

  // Same policy/tier, a different actual model; the route's suggestion is not the grouping key.
  const sonnet = await task();
  const sonnetRun = await run(sonnet, 1200, 2, { model: SONNET });
  await route(sonnet, sonnetRun.id, 1200, { model: OPUS });
  // Same policy/tier/model, a different provider slug.
  const pool = await task();
  const poolRun = await run(pool, 1250, 4, { provider: 'claude-pool' });
  await route(pool, poolRun.id, 1250);

  const foreign = await task({ ownerId: otherOwner, creatorId: otherOwner, assigneeId: otherAgent.id });
  const foreignRun = await run(foreign, 1300, 100, { costUsd: 10_000 });
  await route(foreign, foreignRun.id, 1300);
  await tokens(foreignRun.id, 1_000_000);
  // session_id has no FK; owner checks must survive dangling and mismatched associations.
  await route(firstPass, null, 1400);
  await route(firstPass, randomUUID(), 1400);
  await route(firstPass, foreignRun.id, 1400);
  await route(firstPass, sonnetRun.id, 1400);
  await route(foreign, foreignRun.id, 1400, { ownerId: owner });
  await route(firstPass, first.id, 1400, { ownerId: otherOwner });

  @Module({
    imports: [JwtModule.register({ secret: 'routing-report-spec' })],
    controllers: [TaskModelRoutingReportController],
    providers: [TaskModelRoutingReportService, JwtAuthGuard, { provide: PrismaService, useValue: db }],
  })
  class ReportModule {}
  app = await NestFactory.create(ReportModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/tasks/model-routing/report`;
  const jwt = app.get(JwtService);
  const bearer = (id: string) => `Bearer ${jwt.sign({ sub: id })}`;
  async function get(query = '', id = owner) {
    const response = await fetch(`${base}${query}`, { headers: { authorization: bearer(id) } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body as Report;
  }
  function group(report: Report, mode: keyof Report, policyVersion: number, level: string | null, provider: string, model: string | null) {
    const found = report[mode].filter((row) => row.policyVersion === policyVersion && row.level === level && row.provider === provider && row.model === model);
    assert.equal(found.length, 1, JSON.stringify({ mode, policyVersion, level, provider, model, report }));
    return found[0];
  }

  await t.test('shadow uses actual models; first cohorts own later failures and all-run cost, without usage/judgment fan-out', async () => {
    const report = await get();
    assert.equal(report.shadow.length, 5);
    assert.equal(report.applied.length, 2);
    assert.deepEqual(group(report, 'shadow', 1, 'S', 'claude', OPUS), {
      policyVersion: 1, level: 'S', provider: 'claude', model: OPUS, sampleCount: 5,
      taskCount: 4, completedTaskCount: 3, firstPassTaskCount: 1, firstPassRate: 0.25,
      averageFailureCount: 0.75, tokensPerCompletedTask: 600, costUsdPerCompletedTask: 3, usageUnknownCompletedTaskCount: 0, durationP50Ms: 30_000,
    });
    assert.deepEqual(group(report, 'applied', 2, 'L', 'claude', OPUS), {
      policyVersion: 2, level: 'L', provider: 'claude', model: OPUS, sampleCount: 1,
      taskCount: 0, completedTaskCount: 0, firstPassTaskCount: 0, firstPassRate: null,
      averageFailureCount: null, tokensPerCompletedTask: null, costUsdPerCompletedTask: null, usageUnknownCompletedTaskCount: 0, durationP50Ms: 50_000,
    });
    assert.equal(group(report, 'shadow', 1, 'S', 'claude', SONNET).sampleCount, 1);
    assert.equal(group(report, 'shadow', 1, 'S', 'claude-pool', OPUS).sampleCount, 1);
  });
  await t.test('applied and shadow stay separate; quota failures do not count; even-sample p50 interpolates', async () => {
    assert.deepEqual(group(await get(), 'applied', 1, 'S', 'claude', OPUS), {
      policyVersion: 1, level: 'S', provider: 'claude', model: OPUS, sampleCount: 2,
      taskCount: 2, completedTaskCount: 1, firstPassTaskCount: 1, firstPassRate: 0.5,
      averageFailureCount: 0, tokensPerCompletedTask: 500, costUsdPerCompletedTask: 2, usageUnknownCompletedTaskCount: 0, durationP50Ms: 11_000,
    });
  });
  await t.test('NULL level retains the control group, including Codex cached tokens and null-error failures', async () => {
    assert.deepEqual(group(await get(), 'shadow', 2, null, 'codex-pool', CODEX), {
      policyVersion: 2, level: null, provider: 'codex-pool', model: CODEX, sampleCount: 2,
      taskCount: 2, completedTaskCount: 1, firstPassTaskCount: 1, firstPassRate: 0.5,
      averageFailureCount: 0.5, tokensPerCompletedTask: 800, costUsdPerCompletedTask: 0, usageUnknownCompletedTaskCount: 0, durationP50Ms: 12_000,
    });
  });
  await t.test('unfinished runs with no usage, completion or finish time return defined counts and NULL ratios', async () => {
    assert.deepEqual(group(await get(), 'shadow', 3, 'M', 'codex', null), {
      policyVersion: 3, level: 'M', provider: 'codex', model: null, sampleCount: 1,
      taskCount: 1, completedTaskCount: 0, firstPassTaskCount: 0, firstPassRate: 0,
      averageFailureCount: 0, tokensPerCompletedTask: null, costUsdPerCompletedTask: null, usageUnknownCompletedTaskCount: 0, durationP50Ms: null,
    });
  });
  await t.test('since is inclusive and never reclassifies a later run as the first', async () => {
    const report = await get(`?since=${encodeURIComponent(at(300).toISOString())}`);
    const start = group(report, 'shadow', 1, 'S', 'claude', OPUS);
    assert.equal(start.sampleCount, 3);
    assert.equal(start.taskCount, 2);
    assert.equal(start.completedTaskCount, 1);
    assert.equal(start.firstPassRate, 0);
    assert.equal(start.averageFailureCount, 1);
    assert.equal(start.tokensPerCompletedTask, 290);
    assert.equal(start.costUsdPerCompletedTask, 3);
    assert.equal(start.durationP50Ms, 40_000);
    assert.equal(group(report, 'applied', 2, 'L', 'claude', OPUS).sampleCount, 1);
    assert.deepEqual(await get(`?since=${encodeURIComponent(at(2000).toISOString())}`), { shadow: [], applied: [] });
  });
  await t.test('agentId accepts public ids and UUIDs, uses the run Agent, and keeps later Agent costs in the original cohort', async () => {
    const all = await get();
    assert.deepEqual(await get(`?agentId=${uuidToBase62(agent.id)}`), all);
    assert.deepEqual(await get(`?agentId=${agent.id}`), all);
    assert.deepEqual(await get(`?agentId=${laterAgent.id}`), { shadow: [], applied: [] });
    assert.deepEqual(await get(`?agentId=${otherAgent.id}`), { shadow: [], applied: [] });
    assert.deepEqual(await get(`?agentId=${randomUUID()}`), { shadow: [], applied: [] });
  });
  await t.test('another owner gets only their real decision, never mismatched owner/task/session associations', async () => {
    const report = await get('', otherOwner);
    assert.equal(report.shadow.length, 1);
    assert.equal(report.applied.length, 0);
    assert.deepEqual(group(report, 'shadow', 1, 'S', 'claude', OPUS), {
      policyVersion: 1, level: 'S', provider: 'claude', model: OPUS, sampleCount: 1,
      taskCount: 1, completedTaskCount: 1, firstPassTaskCount: 1, firstPassRate: 1,
      averageFailureCount: 0, tokensPerCompletedTask: 1_000_000, costUsdPerCompletedTask: 10_000, usageUnknownCompletedTaskCount: 0, durationP50Ms: 100_000,
    });
  });
  await t.test('HTTP authentication and filter validation are enforced and repeated GETs do not mutate data', async () => {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { authorization: 'Bearer invalid' } })).status, 401);
    for (const query of ['?since=invalid', '?since=', '?agentId=invalid!']) {
      const response = await fetch(`${base}${query}`, { headers: { authorization: bearer(owner) } });
      assert.equal(response.status, 400, await response.text());
    }
    const snapshot = async () => Promise.all([
      db.taskRouteDecision.findMany({ orderBy: { id: 'asc' } }), db.session.findMany({ orderBy: { id: 'asc' } }),
      db.task.findMany({ orderBy: { id: 'asc' } }), db.llmUsage.findMany({ orderBy: { id: 'asc' } }),
      db.taskEvidenceDecision.findMany({ orderBy: { id: 'asc' } }),
    ]);
    const before = await snapshot();
    assert.deepEqual(await get(), await get());
    assert.deepEqual(await snapshot(), before);
  });
});
