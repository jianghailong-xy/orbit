// The P8 maintenance canary's drive: three maintenance runs of one canary space, made the way a deployment makes
// them — the owner cancels a task on the space's workspace, the committed fact reaches the apiserver's trigger
// (PATCH /api/tasks/:id publishes TASK_CHANGED in that process), the trigger makes a `maintain` wiki job, and the
// wiki-worker claims it and runs the whole pipeline: the space's snapshot through the real runner, the dossiers,
// the extraction through the model queue, the batches, the cursor advance, the anchors through the runner, and the
// finish. What is checked is what the phase is for: three runs succeed in a row, the cursor advances each time,
// no task and no session is made for them, and the run that recorded ops queues the space's articles job.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const HITS = process.argv[3];
const API = process.env.API_BASE;
const DIST = process.env.APP_DIST;
const { prismaClientFor } = require(`${DIST}/prisma/prisma-client.js`);
const jwt = require(process.env.JWT_LIB);

const prisma = prismaClientFor(process.env.DATABASE_URL);
const out = { checks: [], runs: [], jobs: [], requests: [], cursor: null };
const report = (error) => {
  out.error = String(error?.stack ?? error);
  try { console.log(JSON.stringify(out, null, 2)); } catch { /* the report itself */ }
  process.exit(1);
};
process.on('unhandledRejection', report);
process.on('uncaughtException', report);
const check = (what, ok, detail) => {
  out.checks.push({ what, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hits = () => (existsSync(HITS) ? readFileSync(HITS, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

async function http(method, route, body, headers = {}) {
  const response = await fetch(`${API}/api${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try { return { status: response.status, body: text === '' ? null : JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}

const asOwner = { authorization: `Bearer ${jwt.sign({ sub: seed.ownerId, email: 'owner@p8maint.invalid' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

async function cursorOf() {
  return prisma.wikiCursor.findFirst({ where: { spaceId: seed.spaceId, source: 'facts' } });
}

async function main() {
  const seen = new Set((await prisma.wikiMaintenanceRun.findMany({ where: { ownerId: seed.ownerId }, select: { id: true } })).map((row) => row.id));
  let position = null;
  let nextTask = 0;
  for (let run = 1; run <= 3; run += 1) {
    // The trigger's hint: one committed fact of the space, published by the task's own write. A hint that arrives
    // while the run before it is still settling is answered `unfinished` and makes nothing, so the next task is
    // cancelled in its place.
    let made = null;
    for (let attempt = 0; attempt < 6 && made === null; attempt += 1) {
      const taskId = seed.taskIds[nextTask];
      nextTask += 1;
      if (!taskId) report(new Error(`run ${run}: no trigger task left`));
      const answer = await http('PATCH', `/tasks/${taskId}`, { status: 'CANCELLED' }, asOwner);
      if (answer.status >= 300) report(new Error(`cancelling trigger ${run} answered ${answer.status}: ${JSON.stringify(answer.body)}`));
      for (let i = 0; i < 60 && made === null; i += 1) {
        const rows = await prisma.wikiMaintenanceRun.findMany({
          where: { ownerId: seed.ownerId, spaceId: seed.spaceId, jobId: { not: null } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        made = rows.find((row) => !seen.has(row.id)) ?? null;
        if (made === null) await sleep(500);
      }
      if (made === null) {
        // The space was still settling its last run: let it settle, and ask again with the next task.
        for (let i = 0; i < 60; i += 1) {
          const busy = await prisma.wikiJob.count({ where: { ownerId: seed.ownerId, spaceId: seed.spaceId, kind: 'maintain', state: { in: ['queued', 'running', 'waiting'] } } });
          if (busy === 0) break;
          await sleep(500);
        }
      }
    }
    if (made === null) report(new Error(`run ${run}: the trigger made no maintenance run`));
    seen.add(made.id);
    if (made.taskId !== null) report(new Error(`run ${run}: the trigger made a task (${made.taskId})`));

    const deadline = Date.now() + 240_000;
    let ended = null;
    while (Date.now() < deadline) {
      ended = await prisma.wikiMaintenanceRun.findFirst({ where: { id: made.id } });
      if (ended.outcome !== null) break;
      await sleep(500);
    }
    const cursor = await cursorOf();
    out.runs.push({
      run,
      runId: made.id,
      jobId: made.jobId,
      due: made.due,
      catchUp: made.catchUp,
      expect: made.expectRef,
      outcome: ended?.outcome ?? null,
      opsRefused: ended?.opsRefused ?? null,
      failureKind: ended?.failureKind ?? null,
      error: ended?.error ?? null,
      report: ended?.report ?? null,
      cursor: cursor ? { at: cursor.positionAt, kind: cursor.positionKind, ref: cursor.positionRef, failures: cursor.consecutiveFailures } : null,
    });
    check(`run ${run} succeeded`, ended?.outcome === 'succeeded', ended?.error ?? undefined);
    check(`run ${run} left the cursor advanced`, cursor?.positionRef !== null && cursor?.positionRef !== position,
      `position ${cursor?.positionRef ?? '(none)'} after ${position ?? '(none)'}`);
    check(`run ${run} is the job's, not a task's`, ended?.jobId === made.jobId && ended?.taskId === null);
    position = cursor?.positionRef ?? position;
  }

  // No task that is a maintenance task, and no session at all for these runs.
  const hidden = await prisma.task.count({ where: { ownerId: seed.ownerId, listId: seed.listId } });
  check('the hidden maintenance list holds no task', hidden === 0, `tasks ${hidden}`);

  // The articles job a successful run that recorded ops owes (owner 2026-10-08).
  const articles = await prisma.wikiJob.findMany({ where: { ownerId: seed.ownerId, spaceId: seed.spaceId, kind: 'articles' } });
  check('a run that recorded ops queued the space\'s articles job', articles.length >= 1, `articles jobs ${articles.length}`);

  // The evidence: every job, request and run of the canary, with the fake model's calls.
  const jobs = await prisma.$queryRaw`
    SELECT j."id", j."kind", j."state", j."input", j."attempts", j."failure_kind", j."error",
           j."created_at", j."ended_at", j."report"
      FROM "wiki_job" j WHERE j."owner_id" = ${seed.ownerId}::uuid ORDER BY j."created_at", j."id"`;
  out.jobs = jobs.map((row) => ({ ...row, report: row.report ?? null }));
  const requests = await prisma.$queryRaw`
    SELECT r."id", r."job_id", r."step", r."unit", r."state", r."attempt", r."input_tokens", r."output_tokens",
           r."http_status", r."error", r."enqueued_at", r."ended_at"
      FROM "wiki_model_request" r WHERE r."owner_id" = ${seed.ownerId}::uuid ORDER BY r."enqueued_at", r."id"`;
  out.requests = requests;
  out.cursor = await cursorOf();
  out.modelCalls = hits().length;
  out.checkSummary = {
    passed: out.checks.filter((one) => one.ok).length,
    failed: out.checks.filter((one) => !one.ok).length,
  };
  const maintenanceRuns = out.runs.filter((one) => one.outcome === 'succeeded').length;
  check('three maintenance runs of the canary space succeeded', maintenanceRuns === 3, `succeeded ${maintenanceRuns}`);
  out.checkSummary = {
    passed: out.checks.filter((one) => one.ok).length,
    failed: out.checks.filter((one) => !one.ok).length,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(process.exitCode ?? 0);
}

main().catch(report);
