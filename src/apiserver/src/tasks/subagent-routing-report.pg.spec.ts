import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { uuidToBase62, type SubagentReportGroup, type SubagentRoutingReport, type WorkflowReportGroup } from '@orbit/shared';
import { Client } from 'pg';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { SubagentRoutingReportService } from './subagent-routing-report.service';
import { TaskModelRoutingReportController } from './task-model-routing-report.controller';
import { TaskModelRoutingReportService } from './task-model-routing-report.service';

/**
 * The routing report's SubAgents and Workflows views (GET /tasks/model-routing/report/subagents; docs/subagent-design.md
 * §7, docs/subagent-workflow-design.md §8 P4, board docs/mocks/subagent-workflow/08-report.html):
 *   1. Workflows by name: runs, still running, calls, calls that ended without finishing, cost and the median duration
 *      of ended runs, all counted from the workflow's calls' SubAgent runs, never the runner's own counters.
 *   2. Every workflow call is a SubAgent run of the SubAgents view, under the tier, provider and model routing picked:
 *      the two views' workflow call counts are equal under every filter.
 *   3. SubAgents by pick: runs, ended, done, cost, moved on after a limit, no size; named and not-routed picks.
 *   4. `since` dates a workflow call by its workflow's start; `agentId` is the parent session's Agent.
 *   5. Only the authenticated owner's rows, joined through sessions of theirs; filters validated; reads only.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
// Model ids no seeded provider row lists, so each label below comes from the fixture that names it, or is the id.
const HAIKU = 'haiku-report-fixture';
const OPUS = 'parent-model-fixture';
const DEEPSEEK = 'deepseek-report-fixture';
const FLASH = 'named-model-fixture';
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1) + seconds * 1000);

test('the routing report reads SubAgents by pick and workflows by name, counting each workflow call once in both', {
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
  for (const id of [owner, otherOwner]) {
    await db.user.create({ data: { id, email: `${id}@subagent-report.invalid`, name: 'report', passwordHash: 'h' } });
  }
  const agent = await db.workspace.create({ data: { ownerId: owner, name: 'first agent' } });
  const laterAgent = await db.workspace.create({ data: { ownerId: owner, name: 'later agent' } });
  const otherAgent = await db.workspace.create({ data: { ownerId: otherOwner, name: 'other owner agent' } });
  const session = (ownerId: string, workspaceId: string) => db.session.create({ data: {
    ownerId, creatorId: ownerId, title: 'parent', prompt: 'parent', workspaceId, provider: 'claude', model: OPUS,
  } });
  const parent = await session(owner, agent.id);
  const laterParent = await session(owner, laterAgent.id);
  const foreignParent = await session(otherOwner, otherAgent.id);

  // How the account names things: an own DeepSeek key with its model list, and a runner catalogue naming Haiku.
  const ds = `ds-${randomUUID().slice(0, 8)}`;
  await db.modelProvider.create({ data: {
    ownerId: owner, slug: ds, label: 'DeepSeek', runtime: 'claude', baseUrl: 'https://api.deepseek.invalid',
    apiKeyEnc: 'fixture', models: [{ value: DEEPSEEK, label: 'DeepSeek Chat' }],
  } });
  await db.runner.create({ data: {
    ownerId: owner, name: 'report runner', tokenHash: `subagent-report-${randomUUID()}`, lastHeartbeatAt: at(0),
    modelCatalog: { claude: [{ value: HAIKU, label: 'Haiku 5.5', priority: 0 }] },
  } });

  type Pick = { level: string | null; tierSource: string; provider: string; model: string };
  const S_HAIKU: Pick = { level: 'S', tierSource: 'size', provider: 'claude', model: HAIKU };
  const S_HAIKU_DEFAULT: Pick = { ...S_HAIKU, tierSource: 'type-default' };
  const M_DEEPSEEK: Pick = { level: 'M', tierSource: 'size', provider: ds, model: DEEPSEEK };
  const decision = (pick: Pick, extra: Record<string, unknown> = {}) => ({
    ...pick, optimizeFor: 'balance', engine: 'claude', effort: null, reasons: [], candidates: [], policyVersion: 'p4',
    applied: true, ...extra,
  });
  const attempt = (pick: Pick, outcome: string) => ({
    engine: 'claude', provider: pick.provider, model: pick.model, effort: null, attempt: 1, outcome, startedAt: at(0).toISOString(),
  });
  let tools = 0;
  async function run(
    sessionId: string, seconds: number, pick: Pick, status: string, costUsd: number,
    data: Partial<Prisma.SubagentRunUncheckedCreateInput> = {},
  ) {
    return db.subagentRun.create({ data: {
      ownerId: owner, sessionId, toolUseId: `toolu_report_${++tools}`, type: 'general', definitionSource: 'builtin',
      status, costUsd, decision: decision(pick), attempts: [attempt(pick, status)], createdAt: at(seconds),
      endedAt: status === 'RUNNING' ? null : at(seconds + 30), ...data,
    } });
  }
  async function workflow(
    sessionId: string, name: string, seconds: number, endedAfter: number | null,
    data: Partial<Prisma.SubagentWorkflowRunUncheckedCreateInput> = {},
  ) {
    const script = `export const meta = { name: '${name}' }`;
    return db.subagentWorkflowRun.create({ data: {
      ownerId: owner, sessionId, toolUseId: `toolu_workflow_${++tools}`, name, script,
      scriptSha256: createHash('sha256').update(script).digest('hex'), status: endedAfter === null ? 'RUNNING' : 'DONE',
      createdAt: at(seconds), endedAt: endedAfter === null ? null : at(seconds + endedAfter), ...data,
    } });
  }
  async function call(
    flow: { id: string; sessionId: string; toolUseId: string; createdAt: Date }, index: number, pick: Pick,
    status: string, costUsd: number, data: Partial<Prisma.SubagentRunUncheckedCreateInput> = {},
  ) {
    const seconds = (flow.createdAt.getTime() - at(0).getTime()) / 1000 + index + 1;
    return run(flow.sessionId, seconds, pick, status, costUsd, {
      workflowRunId: flow.id, callIndex: index, toolUseId: `${flow.toolUseId}#${index}`, label: `call ${index}`, phase: 'Review', ...data,
    });
  }

  // delegate calls of the first Agent's session
  await run(parent.id, 100, M_DEEPSEEK, 'DONE', 1);
  // A pick whose account hit its limit: the run moved on to Sonnet and failed there, and still counts under Haiku.
  await run(parent.id, 110, S_HAIKU_DEFAULT, 'FAILED', 0.5, {
    decision: decision(S_HAIKU_DEFAULT, { runModel: 'sonnet-report-fixture', moves: ['Moved to sonnet-report-fixture on claude'] }),
    attempts: [attempt(S_HAIKU, 'USAGE_LIMIT'), { ...attempt(S_HAIKU, 'FAILED'), model: 'sonnet-report-fixture', attempt: 2 }],
  });
  await run(parent.id, 120, { level: null, tierSource: 'named-model', provider: ds, model: FLASH }, 'DONE', 0.2);
  await run(parent.id, 130, { level: null, tierSource: 'not-routed', provider: 'claude', model: OPUS }, 'RUNNING', 0);
  await run(parent.id, 140, S_HAIKU, 'DONE', 0.3);
  await run(parent.id, 5000, M_DEEPSEEK, 'DONE', 0.05);

  // review-changes, twice on the first Agent: ended after 400 s, and still running. The runner's own counters on
  // the ended one are wrong on purpose: the report counts the calls' runs.
  const reviewA = await workflow(parent.id, 'review-changes', 1000, 400, {
    description: 'Review the diff', costUsd: 42, callsDone: 99, callsFailed: 0,
  });
  await call(reviewA, 0, M_DEEPSEEK, 'DONE', 0.5);
  await call(reviewA, 1, S_HAIKU_DEFAULT, 'FAILED', 0.25);
  await call(reviewA, 2, S_HAIKU, 'DONE', 0.25);
  const reviewB = await workflow(parent.id, 'review-changes', 2000, null, { description: 'Review the scheduler diff' });
  await call(reviewB, 0, S_HAIKU, 'RUNNING', 0);
  await call(reviewB, 1, M_DEEPSEEK, 'STOPPED', 0.1);
  // triage: a script error after 60 s, then a run of 100 s with an empty description and no calls.
  const triageA = await workflow(parent.id, 'triage', 3000, 60, { status: 'FAILED', description: 'Sort flaky specs', error: 'boom' });
  await call(triageA, 0, S_HAIKU, 'INTERRUPTED', 0);
  await call(triageA, 1, S_HAIKU, 'DONE', 0.4);
  await workflow(parent.id, 'triage', 3500, 100, { description: '' });
  // review-changes once more, on the later Agent.
  const reviewC = await workflow(laterParent.id, 'review-changes', 4000, 10, { description: 'Review the release diff' });
  await call(reviewC, 0, S_HAIKU, 'DONE', 1);
  // A workflow that started early and made its one call late: the call is dated by its workflow.
  const early = await workflow(parent.id, 'early', 500, 4600);
  await call(early, 0, S_HAIKU, 'DONE', 0.7, { createdAt: at(5000) });

  // Another owner's rows, and rows that claim the owner but hang off another owner's session.
  await db.subagentRun.create({ data: {
    ownerId: otherOwner, sessionId: foreignParent.id, toolUseId: 'toolu_foreign', type: 'general', definitionSource: 'builtin',
    status: 'DONE', costUsd: 1000, decision: decision(S_HAIKU), createdAt: at(100),
  } });
  await db.subagentWorkflowRun.create({ data: {
    ownerId: otherOwner, sessionId: foreignParent.id, toolUseId: 'toolu_foreign_workflow', name: 'foreign', script: 'x',
    scriptSha256: 'x', status: 'DONE', createdAt: at(100), endedAt: at(110),
  } });
  await run(foreignParent.id, 150, S_HAIKU, 'DONE', 500);
  await workflow(foreignParent.id, 'review-changes', 1500, 5);

  @Module({
    imports: [JwtModule.register({ secret: 'subagent-report-spec' })],
    controllers: [TaskModelRoutingReportController],
    providers: [TaskModelRoutingReportService, SubagentRoutingReportService, JwtAuthGuard, { provide: PrismaService, useValue: db }],
  })
  class ReportModule {}
  app = await NestFactory.create(ReportModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/tasks/model-routing/report/subagents`;
  const jwt = app.get(JwtService);
  const bearer = (id: string) => `Bearer ${jwt.sign({ sub: id })}`;
  async function get(query = '', id = owner) {
    const response = await fetch(`${base}${query}`, { headers: { authorization: bearer(id) } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body as SubagentRoutingReport;
  }
  const key = (group: SubagentReportGroup) => `${group.tier} ${group.provider} ${group.model}`;
  const cents = <T extends { costUsd: number }>(row: T) => ({ ...row, costUsd: Math.round(row.costUsd * 100) / 100 });
  // The invariant the board's note 5 names: the Workflows view's calls are the SubAgents view's workflow calls.
  function assertCallsCountedOnce(report: SubagentRoutingReport) {
    const workflowCalls = report.workflows.reduce((sum, row) => sum + row.calls, 0);
    assert.equal(report.subagents.reduce((sum, row) => sum + row.workflowCalls, 0), workflowCalls);
    return workflowCalls;
  }

  await t.test('workflows by name: runs, running, calls, failed calls and cost from the calls, median of ended runs', async () => {
    const report = await get();
    assert.deepEqual(report.workflows.map(cents), [
      { name: 'review-changes', description: 'Review the release diff', runs: 3, running: 1, calls: 6, failedCalls: 2, costUsd: 2.1, durationP50Ms: 205_000 },
      { name: 'triage', description: 'Sort flaky specs', runs: 2, running: 0, calls: 2, failedCalls: 1, costUsd: 0.4, durationP50Ms: 80_000 },
      { name: 'early', description: null, runs: 1, running: 0, calls: 1, failedCalls: 0, costUsd: 0.7, durationP50Ms: 4_600_000 },
    ] satisfies WorkflowReportGroup[]);
  });

  await t.test('every workflow call is counted in the SubAgent figures, under the pick, with delegate runs', async () => {
    const report = await get();
    assert.deepEqual(report.subagents.map(key), [`S claude ${HAIKU}`, `M ${ds} ${DEEPSEEK}`, `named ${ds} ${FLASH}`, `not-routed claude ${OPUS}`]);
    assert.deepEqual(report.subagents.map(cents), [
      { tier: 'S', provider: 'claude', providerLabel: 'Claude Code', model: HAIKU, modelLabel: 'Haiku 5.5',
        runs: 9, workflowCalls: 7, ended: 8, done: 5, costUsd: 3.4, movedOn: 1, noSize: 2 },
      { tier: 'M', provider: ds, providerLabel: 'DeepSeek', model: DEEPSEEK, modelLabel: 'DeepSeek Chat',
        runs: 4, workflowCalls: 2, ended: 4, done: 3, costUsd: 1.65, movedOn: 0, noSize: 0 },
      { tier: 'named', provider: ds, providerLabel: 'DeepSeek', model: FLASH, modelLabel: FLASH,
        runs: 1, workflowCalls: 0, ended: 1, done: 1, costUsd: 0.2, movedOn: 0, noSize: 0 },
      { tier: 'not-routed', provider: 'claude', providerLabel: 'Claude Code', model: OPUS, modelLabel: OPUS,
        runs: 1, workflowCalls: 0, ended: 0, done: 0, costUsd: 0, movedOn: 0, noSize: 0 },
    ] satisfies SubagentReportGroup[]);
    // Every run of the owner's own sessions, once: 6 delegate calls and the 9 workflow calls.
    assert.equal(report.subagents.reduce((sum, row) => sum + row.runs, 0), 15);
    assert.equal(assertCallsCountedOnce(report), 9);
  });

  await t.test('agentId is the parent session\'s Agent, by public id or UUID, and both views agree under it', async () => {
    const first = await get(`?agentId=${uuidToBase62(agent.id)}`);
    assert.deepEqual(await get(`?agentId=${agent.id}`), first);
    assert.deepEqual(first.workflows.map(cents)[0], {
      name: 'review-changes', description: 'Review the scheduler diff', runs: 2, running: 1, calls: 5, failedCalls: 2, costUsd: 1.1, durationP50Ms: 400_000,
    });
    assert.deepEqual(cents(first.subagents[0]), {
      tier: 'S', provider: 'claude', providerLabel: 'Claude Code', model: HAIKU, modelLabel: 'Haiku 5.5',
      runs: 8, workflowCalls: 6, ended: 7, done: 4, costUsd: 2.4, movedOn: 1, noSize: 2,
    });
    assert.equal(assertCallsCountedOnce(first), 8);
    const later = await get(`?agentId=${laterAgent.id}`);
    assert.deepEqual(later.workflows.map(cents), [
      { name: 'review-changes', description: 'Review the release diff', runs: 1, running: 0, calls: 1, failedCalls: 0, costUsd: 1, durationP50Ms: 10_000 },
    ]);
    assert.deepEqual(later.subagents.map((row) => [key(row), row.runs, row.workflowCalls]), [[`S claude ${HAIKU}`, 1, 1]]);
    assert.deepEqual(await get(`?agentId=${otherAgent.id}`), { subagents: [], workflows: [] });
    assert.deepEqual(await get(`?agentId=${randomUUID()}`), { subagents: [], workflows: [] });
  });

  await t.test('since is inclusive and dates a workflow call by its workflow\'s start', async () => {
    const report = await get(`?since=${encodeURIComponent(at(3500).toISOString())}`);
    assert.deepEqual(report.workflows.map(cents), [
      { name: 'review-changes', description: 'Review the release diff', runs: 1, running: 0, calls: 1, failedCalls: 0, costUsd: 1, durationP50Ms: 10_000 },
      { name: 'triage', description: null, runs: 1, running: 0, calls: 0, failedCalls: 0, costUsd: 0, durationP50Ms: 100_000 },
    ]);
    // The early workflow's call, made at 5000 s, is out with its workflow; the delegate call at 5000 s is in.
    assert.deepEqual(report.subagents.map((row) => [key(row), row.runs, row.workflowCalls]), [
      [`S claude ${HAIKU}`, 1, 1], [`M ${ds} ${DEEPSEEK}`, 1, 0],
    ]);
    assert.equal(assertCallsCountedOnce(report), 1);
    const late = await get(`?since=${encodeURIComponent(at(4500).toISOString())}`);
    assert.deepEqual(late.workflows, []);
    assert.deepEqual(late.subagents.map((row) => [key(row), row.runs, row.workflowCalls]), [[`M ${ds} ${DEEPSEEK}`, 1, 0]]);
  });

  await t.test('another owner reads only their own rows, through their own sessions', async () => {
    const theirs = await get('', otherOwner);
    assert.deepEqual(theirs.workflows.map((row) => [row.name, row.runs, row.calls]), [['foreign', 1, 0]]);
    assert.deepEqual(theirs.subagents.map((row) => [key(row), row.runs, row.costUsd]), [[`S claude ${HAIKU}`, 1, 1000]]);
  });

  await t.test('authentication and filters are enforced, and reading writes nothing', async () => {
    assert.equal((await fetch(base)).status, 401);
    for (const query of ['?since=invalid', '?since=', '?agentId=invalid!']) {
      const response = await fetch(`${base}${query}`, { headers: { authorization: bearer(owner) } });
      assert.equal(response.status, 400, await response.text());
    }
    const snapshot = () => Promise.all([
      db.subagentRun.findMany({ orderBy: { id: 'asc' } }), db.subagentWorkflowRun.findMany({ orderBy: { id: 'asc' } }),
    ]);
    const before = await snapshot();
    assert.deepEqual(await get(), await get());
    assert.deepEqual(await snapshot(), before);
  });
});
