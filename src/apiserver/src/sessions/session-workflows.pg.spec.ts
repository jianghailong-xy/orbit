/**
 * An Orbit workflow as clients read it (docs/subagent-workflow-design.md §5), held against the production apiserver —
 * `build/main.js`, the whole AppModule behind JwtAuthGuard and RunnerAuthGuard — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. The parent's runner opens two workflows, two calls of the first and
 * one delegate call through its doors (runner-subagents.controller.ts), as `orbit mcp` does; the owner reads
 * `GET /sessions/:id/workflows` and `GET /sessions/:id/subagents` as every client does:
 *
 *   (1) opened, before any call: each workflow with every field of WorkflowRunView, RUNNING, nothing counted yet,
 *       its limit or none, and never its script, args or result;
 *   (2) both calls running: each call's run carries workflowRunId (the workflow's id, as the client is handed it),
 *       callIndex, label and phase, and the delegate call's run beside them null in all four;
 *   (3) one call DONE and one FAILED, the workflow still running: its calls done and failed and its cost are counted
 *       from them, and the other workflow's from none of them;
 *   (4) the workflow ended: DONE, with what the runner reported for it, endedAt set and no error, its calls' runs
 *       unchanged;
 *   and another account reading either is answered 404, as an id that names nothing is.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-workflows.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62, type SubagentRunView, type WorkflowRunView } from '@orbit/shared';
import { type PrismaClient, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'session-workflows-spec';
const RUN = randomUUID().slice(0, 8);

/** Every field a client reads of a workflow, as WorkflowRunView lists them. */
const WORKFLOW_FIELDS = [
  'id', 'toolUseId', 'name', 'description', 'phases', 'status', 'callsDone', 'callsFailed', 'costUsd', 'maxCostUsd',
  'error', 'createdAt', 'endedAt',
] as const;
const fieldsOf = (view: object) =>
  Object.fromEntries(WORKFLOW_FIELDS.map((key) => [key, (view as Record<string, unknown>)[key]]));

test('a session\'s Orbit workflows and their calls, as clients read them before and after the workflow ends', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const person = async (label: string) => {
    const id = randomUUID();
    const email = `workflows-${label}-${RUN}-${id}@session-workflows.invalid`;
    await db.user.create({ data: { id, email, name: `${label} ${RUN}`, passwordHash: 'x' } });
    return { id, email };
  };
  const owner = await person('owner');
  const stranger = await person('stranger');

  // The parent's machine, with the catalogue SubAgent routing picks a model from, and the credential its doors take.
  const runnerId = randomUUID();
  const runnerToken = `session-workflows-${runnerId}`;
  await db.runner.create({
    data: {
      id: runnerId, name: `workflows-${RUN}`, ownerId: owner.id, tokenHash: sha256(runnerToken),
      modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', priority: 0 }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', priority: 2 }] },
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: `workflows-${RUN}`, enabled: true } });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId,
      title: 'review the parser', prompt: 'review the parser', provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
      effort: 'high', turnState: null, numTurns: 1, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
    },
  });

  const jwtSecret = `session-workflows-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const [ownerLogin, strangerLogin] = await Promise.all([owner, stranger].map((p) => jwt.signAsync({ sub: p.id, email: p.email })));
  server = await startApiserver(url, jwtSecret);

  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  const runnerDoor = async (method: string, path: string, body: unknown, what: string) =>
    ok(await call(server!, method, `/api/runner/sessions/${sessionId}${path}`, runnerToken, body), what);
  // As a client addresses the session: by its public id.
  const session = uuidToBase62(sessionId);
  const read = async () => ({
    workflows: ok(await call(server!, 'GET', `/api/sessions/${session}/workflows`, ownerLogin), 'reading the workflows') as WorkflowRunView[],
    runs: ok(await call(server!, 'GET', `/api/sessions/${session}/subagents`, ownerLogin), 'reading the SubAgent runs') as SubagentRunView[],
  });
  const runOf = (runs: SubagentRunView[], toolUseId: string) => {
    const found = runs.find((r) => r.toolUseId === toolUseId);
    assert.ok(found, `no run for ${toolUseId} in ${JSON.stringify(runs.map((r) => r.toolUseId))}`);
    return found;
  };

  // ── (1) Two workflows open: one with a description, phases and a cost limit, one with none of them. ──
  const review = {
    toolUseId: 'toolu_workflow_review', name: 'review-parser', description: 'Review the parser by part', phases: ['Review', 'Verify'],
    script: "export const meta = { name: 'review-parser', description: 'Review the parser by part' }\nreturn 1",
    args: { parts: ['lexer', 'grammar'] }, maxCostUsd: 5,
  };
  const reviewOpened = await runnerDoor('POST', '/workflows', review, 'opening the review workflow');
  assert.equal(reviewOpened.status, 'RUNNING');
  const reviewId = toUuid(reviewOpened.workflowRunId);
  const scanOpened = await runnerDoor('POST', '/workflows', { toolUseId: 'toolu_workflow_scan', name: 'scan', script: 'return 1' }, 'opening the scan workflow');
  const scanId = toUuid(scanOpened.workflowRunId);
  const rowOf = (id: string) => db.subagentWorkflowRun.findUniqueOrThrow({ where: { id } });
  const [reviewRow, scanRow] = [await rowOf(reviewId), await rowOf(scanId)];

  const opened = await read();
  assert.deepEqual(opened.workflows.map(fieldsOf), [
    {
      id: uuidToBase62(reviewId), toolUseId: 'toolu_workflow_review', name: 'review-parser', description: 'Review the parser by part',
      phases: ['Review', 'Verify'], status: 'RUNNING', callsDone: 0, callsFailed: 0, costUsd: 0, maxCostUsd: 5, error: null,
      createdAt: reviewRow.createdAt.toISOString(), endedAt: null,
    },
    {
      id: uuidToBase62(scanId), toolUseId: 'toolu_workflow_scan', name: 'scan', description: null, phases: [], status: 'RUNNING',
      callsDone: 0, callsFailed: 0, costUsd: 0, maxCostUsd: null, error: null, createdAt: scanRow.createdAt.toISOString(), endedAt: null,
    },
  ], 'both workflows, oldest first, with every field; no limit reads as null');
  for (const view of opened.workflows) {
    for (const hidden of ['script', 'scriptSha256', 'args', 'result', 'ownerId', 'sessionId']) {
      assert.equal(hidden in view, false, `a client is not handed the workflow's ${hidden}`);
    }
  }
  assert.deepEqual(opened.runs, [], 'no call has started');

  // ── (2) The review's two calls start, and a delegate call's run beside them. ──
  const delegate = await runnerDoor('POST', '/subagents', {
    toolUseId: 'toolu_delegate', type: 'explore', definitionSource: 'builtin', description: 'Find every caller',
  }, 'opening the delegate call');
  const callOf = (index: number, label: string, phase: string) => runnerDoor('POST', '/subagents', {
    toolUseId: `toolu_workflow_review#${index}`, type: 'general', definitionSource: 'builtin', description: label,
    workflowRunId: reviewOpened.workflowRunId, callIndex: index, label, phase,
  }, `opening call ${index}`);
  const lexer = await callOf(0, 'Lexer', 'Review');
  const grammar = await callOf(1, 'Grammar', 'Verify');
  assert.equal(lexer.status, 'RUNNING');
  assert.equal(grammar.status, 'RUNNING');

  const running = await read();
  const callFields = (run: SubagentRunView) => [run.workflowRunId, run.callIndex, run.label, run.phase, run.status];
  assert.deepEqual(callFields(runOf(running.runs, 'toolu_workflow_review#0')), [uuidToBase62(reviewId), 0, 'Lexer', 'Review', 'RUNNING']);
  assert.deepEqual(callFields(runOf(running.runs, 'toolu_workflow_review#1')), [uuidToBase62(reviewId), 1, 'Grammar', 'Verify', 'RUNNING']);
  assert.deepEqual(callFields(runOf(running.runs, 'toolu_delegate')), [null, null, null, null, 'RUNNING'],
    "a delegate call's run is no workflow's");
  assert.equal(runOf(running.runs, 'toolu_workflow_review#0').workflowRunId, running.workflows[0].id,
    'a call names its workflow by the id the client reads the workflow by');
  assert.deepEqual(running.workflows.map((w) => [w.status, w.callsDone, w.callsFailed, w.costUsd]), [['RUNNING', 0, 0, 0], ['RUNNING', 0, 0, 0]],
    'nothing counted while both calls run');

  // ── (3) One call finishes and one fails; the workflow runs on. ──
  ok(await call(server, 'PATCH', `/api/runner/sessions/${sessionId}/subagents/${lexer.runId}`, runnerToken, {
    status: 'DONE', resultSummary: 'Two findings in the lexer.', costUsd: 0.25,
  }), 'ending the lexer call');
  ok(await call(server, 'PATCH', `/api/runner/sessions/${sessionId}/subagents/${grammar.runId}`, runnerToken, {
    status: 'FAILED', resultSummary: 'The SubAgent failed: the grammar file is missing.', costUsd: 0.5,
  }), 'ending the grammar call');

  const counted = await read();
  assert.deepEqual(
    counted.workflows.map((w) => [w.toolUseId, w.status, w.callsDone, w.callsFailed, w.costUsd, w.endedAt]),
    [['toolu_workflow_review', 'RUNNING', 1, 1, 0.75, null], ['toolu_workflow_scan', 'RUNNING', 0, 0, 0, null]],
    "a running workflow counts its own calls' ends and spend, and the other workflow none of them",
  );
  const lexerRun = runOf(counted.runs, 'toolu_workflow_review#0');
  assert.deepEqual([lexerRun.status, lexerRun.costUsd, lexerRun.resultSummary, lexerRun.callIndex], ['DONE', 0.25, 'Two findings in the lexer.', 0]);
  assert.ok(lexerRun.endedAt, "the call's run has ended");
  assert.deepEqual(callFields(runOf(counted.runs, 'toolu_workflow_review#1')), [uuidToBase62(reviewId), 1, 'Grammar', 'Verify', 'FAILED']);

  // ── (4) The workflow ends, reported as the runner reports a finished script: an empty error, and its one wake. ──
  const ended = ok(await call(server, 'PATCH', `/api/runner/sessions/${sessionId}/workflows/${reviewId}`, runnerToken, {
    status: 'DONE', result: '{"findings":2}', error: '', costUsd: 0.75, callsDone: 1, callsFailed: 1, wake: true,
  }), 'ending the review workflow');
  assert.equal(ended.applied, true);

  const after = await read();
  const endedRow = await rowOf(reviewId);
  assert.ok(endedRow.endedAt);
  assert.deepEqual(fieldsOf(after.workflows[0]), {
    id: uuidToBase62(reviewId), toolUseId: 'toolu_workflow_review', name: 'review-parser', description: 'Review the parser by part',
    phases: ['Review', 'Verify'], status: 'DONE', callsDone: 1, callsFailed: 1, costUsd: 0.75, maxCostUsd: 5, error: null,
    createdAt: reviewRow.createdAt.toISOString(), endedAt: endedRow.endedAt.toISOString(),
  }, 'the ended workflow reads what the runner reported, with its end');
  assert.deepEqual(after.workflows.slice(1).map(fieldsOf), opened.workflows.slice(1).map(fieldsOf), 'the other workflow is as it was');
  assert.deepEqual(
    after.runs.filter((r) => r.workflowRunId).sort((a, b) => a.callIndex! - b.callIndex!).map(callFields),
    [[uuidToBase62(reviewId), 0, 'Lexer', 'Review', 'DONE'], [uuidToBase62(reviewId), 1, 'Grammar', 'Verify', 'FAILED']],
    "its calls' runs keep their workflow fields after it ends",
  );

  // ── Another account reads neither, and is answered as for a session that does not exist. ──
  const nobody = uuidToBase62(randomUUID());
  for (const route of ['workflows', 'subagents']) {
    const theirs = await call(server, 'GET', `/api/sessions/${session}/${route}`, strangerLogin);
    const none = await call(server, 'GET', `/api/sessions/${nobody}/${route}`, ownerLogin);
    assert.equal(theirs.status, 404, `another account's read of ${route}: ${theirs.text}`);
    assert.equal(none.status, 404, `a session that does not exist, ${route}: ${none.text}`);
    assert.equal(theirs.json?.message, none.json?.message, 'the same answer');
  }
  assert.equal(delegate.status, 'RUNNING');
});
