// The P8 maintenance canary's drive, and the record it leaves (JSON on stdout, and in the file given as argv[4]):
//
//   1. account A's space, three maintenance runs made the way a deployment makes them — the owner cancels a task on
//      the space's workspace, the committed fact reaches the apiserver's trigger (PATCH /api/tasks/:id publishes
//      TASK_CHANGED in that process), the trigger makes a `maintain` wiki job, and the wiki-worker claims it and
//      runs the whole pipeline. For each: the run row, the job row, the cursor before and after, the ops it
//      recorded, and the report it left.
//   2. the same account's task and session counts before and after: the runs must add none of either.
//   3. the articles job a run that recorded ops owes (owner 2026-10-08): the wiki_job row.
//   4. account B, which holds NO provider row at all: the owner's own PATCH turns its maintenance on — a space
//      whose provider no maintenance run could start on — and one run of it completes.
//   5. the published runner's own door, for account A: `orbit wiki maintain` and the run-context, dossier and
//      cursor routes answer 409 WIKI_SERVER_EXECUTES and ask the model nothing.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const HITS = process.argv[3];
const OUT = process.argv[4];
const API = process.env.API_BASE;
const DIST = process.env.APP_DIST;
const SHARED = process.env.SHARED_DIST;
const ORBIT_BIN = process.env.ORBIT_BIN ?? 'orbit';
const RUNNER_HOME = process.env.RUNNER_HOME;
const { prismaClientFor } = require(`${DIST}/prisma/prisma-client.js`);
const { uuidToBase62 } = require(`${SHARED}/index.js`);
const jwt = require(process.env.JWT_LIB);

const prisma = prismaClientFor(process.env.DATABASE_URL);
const out = { checks: [], runs: [], jobs: [], requests: [], counts: {}, providerless: {}, door: {}, model: {} };
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

const ownerHeaders = (ownerId) => ({
  authorization: `Bearer ${jwt.sign({ sub: ownerId, email: `owner-${ownerId.slice(0, 8)}@p8maint.invalid` }, process.env.JWT_SECRET, { expiresIn: '1h' })}`,
});

const cursorOf = (spaceId) => prisma.wikiCursor.findFirst({ where: { spaceId, source: 'facts' } });
const positionOf = (row) => (row ? { at: row.positionAt, kind: row.positionKind, ref: row.positionRef, failures: row.consecutiveFailures } : null);

/** How many tasks and sessions an account holds, and of the tasks how many are in a space's hidden list. */
async function countsOf(ownerId, listId) {
  return {
    tasks: await prisma.task.count({ where: { ownerId } }),
    tasksInHiddenList: listId === null ? null : await prisma.task.count({ where: { ownerId, listId } }),
    sessions: await prisma.session.count({ where: { ownerId } }),
    providers: await prisma.modelProvider.count({ where: { ownerId } }).catch(() => -1),
    providerPools: await prisma.providerPool.count({ where: { ownerId } }).catch(() => -1),
  };
}

/**
 * Fire one hint for a space — the owner cancels a task on the space's workspace — and wait for the `maintain` run
 * it makes, then for the run the worker ends. A hint that arrives while the run before it is still settling is
 * answered `unfinished` and makes nothing, so the next task is cancelled in its place.
 */
async function runOnce(spaceId, triggerTasks, seen, ownerId, label) {
  let made = null;
  for (let attempt = 0; attempt < 6 && made === null; attempt += 1) {
    const taskId = triggerTasks.shift();
    if (!taskId) report(new Error(`${label}: no trigger task left`));
    const answer = await http('PATCH', `/tasks/${taskId}`, { status: 'CANCELLED' }, ownerHeaders(ownerId));
    if (answer.status >= 300) report(new Error(`${label}: cancelling a trigger answered ${answer.status}: ${JSON.stringify(answer.body)}`));
    for (let i = 0; i < 60 && made === null; i += 1) {
      const rows = await prisma.wikiMaintenanceRun.findMany({ where: { ownerId, spaceId, jobId: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      made = rows.find((row) => !seen.has(row.id)) ?? null;
      if (made === null) await sleep(500);
    }
    if (made === null) {
      for (let i = 0; i < 60; i += 1) {
        const busy = await prisma.wikiJob.count({ where: { ownerId, spaceId, kind: 'maintain', state: { in: ['queued', 'running', 'waiting'] } } });
        if (busy === 0) break;
        await sleep(500);
      }
    }
  }
  if (made === null) report(new Error(`${label}: the trigger made no maintenance run`));
  seen.add(made.id);
  if (made.taskId !== null) report(new Error(`${label}: the trigger made a task (${made.taskId})`));
  const deadline = Date.now() + 240_000;
  let ended = made;
  while (ended.outcome === null && Date.now() < deadline) {
    await sleep(500);
    ended = await prisma.wikiMaintenanceRun.findFirst({ where: { id: made.id } });
  }
  const job = await prisma.wikiJob.findFirst({ where: { id: made.jobId } });
  return { made, ended, job };
}

async function main() {
  const t0 = Date.now();
  const before = { A: await countsOf(seed.ownerA, seed.listA), B: await countsOf(seed.ownerB, null) };
  const seen = new Set((await prisma.wikiMaintenanceRun.findMany({ where: { ownerId: seed.ownerA }, select: { id: true } })).map((row) => row.id));
  const triggers = [...seed.tasksA];

  // ── 1. three runs of account A, with the cursor before and after each ────────────────────────────
  let position = await cursorOf(seed.spaceA);
  for (let run = 1; run <= 3; run += 1) {
    const beforeCursor = positionOf(position);
    const { made, ended, job } = await runOnce(seed.spaceA, triggers, seen, seed.ownerA, `run ${run}`);
    position = await cursorOf(seed.spaceA);
    const runReport = ended.report ?? {};
    const ops = runReport.ops ?? {};
    out.runs.push({
      run,
      runId: made.id,
      jobId: made.jobId,
      jobState: job?.state ?? null,
      jobAttempts: job?.attempts ?? null,
      taskId: ended.taskId,
      due: made.due,
      catchUp: made.catchUp,
      expectAt: made.expectAt,
      outcome: ended.outcome,
      opsRefused: ended.opsRefused,
      failureKind: ended.failureKind,
      error: ended.error,
      ops: { recorded: ops.recorded ?? null, proposed: ops.proposed ?? null, heldBackByBreaker: ops.heldBackByBreaker ?? null },
      report: runReport,
      cursorBefore: beforeCursor,
      cursorAfter: positionOf(position),
    });
    check(`run ${run}: a maintain job succeeded`, job?.state === 'succeeded' && ended.outcome === 'succeeded', ended.error ?? undefined);
    check(`run ${run}: no task was made for it`, ended.taskId === null);
    check(`run ${run}: the cursor advanced`,
      beforeCursor?.ref !== positionOf(position)?.ref,
      `${beforeCursor?.ref ?? '(none)'} -> ${positionOf(position)?.ref ?? '(none)'}`);
  }

  // ── 2. the counts: the runs add no task and no session ───────────────────────────────────────────
  const after = { A: await countsOf(seed.ownerA, seed.listA), B: await countsOf(seed.ownerB, null) };
  out.counts = {
    accountA: {
      before: before.A, after: after.A,
      tasksAdded: after.A.tasks - before.A.tasks,
      sessionsAdded: after.A.sessions - before.A.sessions,
      tasksInHiddenListAdded: after.A.tasksInHiddenList - before.A.tasksInHiddenList,
    },
    accountB: { before: before.B, after: after.B, tasksAdded: after.B.tasks - before.B.tasks, sessionsAdded: after.B.sessions - before.B.sessions },
    windowSeconds: Math.round((Date.now() - t0) / 1000),
  };
  check('account A: the three runs made no task', out.counts.accountA.tasksAdded === 0, JSON.stringify(out.counts.accountA));
  check('account A: the three runs made no session', out.counts.accountA.sessionsAdded === 0, JSON.stringify(out.counts.accountA));
  check('account A: the hidden maintenance list gained no task',
    out.counts.accountA.tasksInHiddenListAdded === 0, JSON.stringify(out.counts.accountA));
  check('account B holds no provider row of any kind', before.B.providers === 0 && before.B.providerPools === 0,
    `providers ${before.B.providers}, pools ${before.B.providerPools}`);

  // ── 3. the articles job a run that recorded ops owes ─────────────────────────────────────────────
  const articles = await prisma.wikiJob.findMany({ where: { ownerId: seed.ownerA, spaceId: seed.spaceA, kind: 'articles' }, orderBy: [{ createdAt: 'asc' }] });
  out.articlesJobs = articles.map((job) => ({
    id: job.id, state: job.state, input: job.input, priority: job.priority,
    createdAt: job.createdAt, endedAt: job.endedAt, failureKind: job.failureKind, error: job.error,
  }));
  const afterOpsRun = out.runs.filter((one) => (one.ops.recorded ?? 0) > 0 && one.catchUp === null && one.outcome === 'succeeded');
  check('a run succeeded, recorded ops and was not behind, and a queued articles job exists for the space',
    afterOpsRun.length >= 1 && articles.length >= 1,
    `runs with ops ${afterOpsRun.length}, articles jobs ${articles.length}: ${JSON.stringify(out.articlesJobs[0] ?? null)}`);

  // ── 4. account B: no provider row at all, maintenance turned on by the owner's own PATCH ─────────
  const patch = await http('PATCH', `/wiki/spaces/${seed.spaceB}`, {
    maintenance: { enabled: true, workspaceId: seed.workspaceB, lookbackDays: 7 },
  }, ownerHeaders(seed.ownerB));
  const spaceB = await prisma.wikiSpace.findFirst({ where: { id: seed.spaceB } });
  const settingsB = (spaceB?.settings ?? {});
  out.providerless.patch = { status: patch.status, body: patch.body, maintenance: settingsB.maintenance ?? null };
  check('account B (no provider row): the owner PATCH turns maintenance on',
    patch.status < 300 && settingsB.maintenance?.enabled === true,
    `status ${patch.status}, settings ${JSON.stringify(settingsB.maintenance ?? null)}`);
  const seenB = new Set();
  const runB = await runOnce(seed.spaceB, [...seed.tasksB], seenB, seed.ownerB, 'providerless run');
  out.providerless.run = {
    runId: runB.made.id, jobId: runB.made.jobId, jobState: runB.job?.state ?? null, outcome: runB.ended.outcome,
    opsRefused: runB.ended.opsRefused, failureKind: runB.ended.failureKind, error: runB.ended.error,
    taskId: runB.ended.taskId, cursor: positionOf(await cursorOf(seed.spaceB)), report: runB.ended.report ?? null,
  };
  check('account B: its run succeeded with no provider row in the account',
    runB.ended.outcome === 'succeeded' && runB.job?.state === 'succeeded', runB.ended.error ?? undefined);
  check('account B: its run made no task', runB.ended.taskId === null);
  out.counts.accountB.afterRun = await countsOf(seed.ownerB, null);
  out.counts.accountB.sessionsAddedByRun = out.counts.accountB.afterRun.sessions - after.B.sessions;
  out.counts.accountB.tasksAddedByRun = out.counts.accountB.afterRun.tasks - after.B.tasks;
  check('account B: its run made no task and no session',
    out.counts.accountB.tasksAddedByRun === 0 && out.counts.accountB.sessionsAddedByRun === 0,
    JSON.stringify(out.counts.accountB));

  // ── 5. the published runner's door: 409, and no model call ───────────────────────────────────────
  const modelCallsBefore = hits().length;
  const base = uuidToBase62(seed.spaceA);
  const asRunner = { 'x-runner-token': seed.runnerToken, 'x-orbit-session-id': seed.maintenanceSession };
  const cli = spawnSync(ORBIT_BIN, ['wiki', 'maintain', '--space', base, '--json'], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ORBIT_HOME: RUNNER_HOME, ORBIT_NO_SELFUPDATE: '1', ORBIT_NO_ENGINE_UPDATE: '1', ORBIT_SESSION_ID: seed.maintenanceSession },
  });
  out.door = {
    runner: spawnSync(ORBIT_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    maintain: {
      argv: `${ORBIT_BIN} wiki maintain --space ${base} --json`,
      status: cli.status,
      stdout: (cli.stdout ?? '').trim().slice(0, 800),
      stderr: (cli.stderr ?? '').trim().slice(0, 800),
    },
  };
  for (const [what, method, route, body] of [
    ['runContext', 'GET', `/runner/wiki/spaces/${seed.spaceA}/maintenance/run`, undefined],
    ['dossiers', 'GET', `/runner/wiki/spaces/${seed.spaceA}/dossiers`, undefined],
    ['cursor', 'POST', `/runner/wiki/spaces/${seed.spaceA}/cursor`, { to: 'wc1.invalid', outcome: 'failed' }],
  ]) {
    const answer = await http(method, route, body, asRunner);
    out.door[what] = { status: answer.status, body: answer.body };
    check(`the runner's ${what} route answers 409 WIKI_SERVER_EXECUTES`, answer.status === 409 && answer.body?.code === 'WIKI_SERVER_EXECUTES',
      `${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`);
  }
  const modelCallsAfter = hits().length;
  out.model = { callsBefore: modelCallsBefore, callsAfter: modelCallsAfter, callsDuringDoorChecks: modelCallsAfter - modelCallsBefore, total: modelCallsAfter };
  check('the door checks asked the model nothing', modelCallsAfter === modelCallsBefore, JSON.stringify(out.model));
  check('the published runner\'s `orbit wiki maintain` was refused',
    cli.status !== 0 && `${cli.stdout ?? ''}${cli.stderr ?? ''}`.includes('WIKI_SERVER_EXECUTES'),
    `exit ${cli.status}: ${(cli.stdout ?? '').concat(cli.stderr ?? '').trim().slice(0, 300)}`);

  // ── the evidence rows ────────────────────────────────────────────────────────────────────────────
  const jobs = await prisma.$queryRaw`
    SELECT j."id", j."owner_id", j."space_id", j."kind", j."state", j."input", j."priority", j."attempts", j."failure_kind",
           j."error", j."created_at", j."ended_at", j."report"
      FROM "wiki_job" j WHERE j."owner_id" = ${seed.ownerA}::uuid OR j."owner_id" = ${seed.ownerB}::uuid
     ORDER BY j."created_at", j."id"`;
  out.jobs = jobs;
  const requests = await prisma.$queryRaw`
    SELECT r."id", r."job_id", r."owner_id", r."step", r."unit", r."state", r."attempt", r."input_tokens", r."output_tokens",
           r."http_status", r."error", r."enqueued_at", r."ended_at"
      FROM "wiki_model_request" r WHERE r."owner_id" = ${seed.ownerA}::uuid OR r."owner_id" = ${seed.ownerB}::uuid
     ORDER BY r."enqueued_at", r."id"`;
  out.requests = requests;
  out.requestSummary = requests.reduce((all, row) => {
    const key = `${row.step}/${row.state}`;
    all[key] = (all[key] ?? 0) + 1;
    return all;
  }, {});
  out.runsTotal = { maintain: out.jobs.filter((job) => job.kind === 'maintain').length, articles: out.jobs.filter((job) => job.kind === 'articles').length };
  out.cursor = { accountA: positionOf(await cursorOf(seed.spaceA)), accountB: positionOf(await cursorOf(seed.spaceB)) };
  check('three maintain jobs succeeded in a row', out.runs.filter((one) => one.outcome === 'succeeded').length === 3,
    JSON.stringify(out.runs.map((one) => [one.run, one.jobId, one.outcome])));
  out.checkSummary = { passed: out.checks.filter((one) => one.ok).length, failed: out.checks.filter((one) => !one.ok).length };
  const text = JSON.stringify(out, null, 2);
  if (OUT) writeFileSync(OUT, `${text}\n`);
  console.log(text);
  process.exit(process.exitCode ?? 0);
}

main().catch(report);
