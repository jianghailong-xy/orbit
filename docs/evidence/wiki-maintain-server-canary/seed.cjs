// The P8 maintenance canary's fixture, written with this branch's own Prisma client:
//
//   account A — an owner; the machine this branch's runner binary starts from; a workspace reading a checkout of
//   this repository; a space with maintenance ON (manual review, so its ops wait for the owner), bound to the
//   workspace and carrying the checkout's repository identity; 25 settled sessions, each with one owner turn
//   carrying the words the fake model quotes; six open tasks on the workspace to cancel as the triggers; and one
//   maintenance session (a task in the space's hidden list, with a session on the machine) for the route checks.
//
//   account B — an owner with NO provider row of any kind; a space whose maintenance is OFF and names a provider
//   no maintenance session could start on ('claude', the machine's own sign-in); ITS OWN machine (a second runner
//   under its own account, as a deployment of that account would have) reading its own checkout; and 25 settled
//   sessions of its own. The canary turns its maintenance on through the owner's own PATCH and runs one run to its
//   end.
//
// Every id is generated here, into a throwaway database.
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const DIST = process.env.APP_DIST;
const { prismaClientFor } = require(`${DIST}/prisma/prisma-client.js`);
const { normalizeRepoUrl } = require(`${DIST}/wiki/wiki.service.js`);

const TURN = 'the upload test fails with connect ECONNREFUSED 127.0.0.1:9000';

async function main() {
  const prisma = prismaClientFor(process.env.DATABASE_URL);
  const checkout = process.env.CHECKOUT;
  const origin = execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const repoUrlNorm = normalizeRepoUrl(origin);
  const rootCommitSha = execFileSync('git', ['-C', checkout, 'rev-list', '--max-parents=0', 'origin/main'], { encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter(Boolean).pop();

  // ── account A: the machine, the checkout and the space the three runs are of ──────────────────────
  const ownerA = randomUUID();
  await prisma.user.create({ data: { id: ownerA, email: `maintain-${ownerA}@canary.invalid`, name: 'maintenance canary', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const runnerToken = `runner-${randomUUID()}`;
  await prisma.runner.create({ data: { id: runnerId, name: 'p8-maintain-runner', ownerId: ownerA, tokenHash: createHash('sha256').update(runnerToken).digest('hex') } });
  const workspaceA = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceA, name: 'p8-maintain-checkout', ownerId: ownerA, runnerId, workDir: checkout, env: {} } });
  const listA = randomUUID();
  await prisma.taskList.create({ data: { id: listA, ownerId: ownerA, title: 'Wiki maintenance', hidden: true, maxConcurrent: 1 } });
  const spaceA = randomUUID();
  await prisma.wikiSpace.create({ data: {
    id: spaceA, ownerId: ownerA, slug: `maintain-${spaceA.slice(0, 8)}`, title: 'Maintenance space (P8)',
    repoUrlNorm, rootCommitSha,
    settings: { reviewMode: 'manual', maintenance: { enabled: true, workspaceId: workspaceA, listId: listA, provider: 'claude' } },
  } });
  await prisma.wikiSpaceWorkspace.create({ data: { spaceId: spaceA, ownerId: ownerA, workspaceId: workspaceA } });
  const sessionsA = await settledSessions(prisma, ownerA, workspaceA, runnerId, 25);
  const tasksA = await triggerTasks(prisma, ownerA, workspaceA, 6, 'canary trigger');
  // A maintenance session of account A, on the machine, as one the runner path made before the switch: its task
  // ENDED, so it holds the hidden list no more (`maintenance.job.trigger.notMade`) — the space's server path is
  // free to run — while the session is still a maintenance run of the space for the door's own test.
  const maintenanceTask = randomUUID();
  await prisma.task.create({ data: {
    id: maintenanceTask, title: 'Wiki maintenance: Maintenance space (P8)', ownerId: ownerA, creatorType: 'USER', creatorId: ownerA,
    listId: listA, assigneeId: workspaceA, status: 'CANCELLED', completionCriterion: 'OWNER_CONFIRMED',
  } });
  const maintenanceSession = randomUUID();
  await prisma.session.create({ data: {
    id: maintenanceSession, title: 'Wiki maintenance run', prompt: 'orbit wiki maintain', ownerId: ownerA, creatorId: ownerA,
    workspaceId: workspaceA, assignedRunnerId: runnerId, taskId: maintenanceTask, dispatchOrigin: 'USER', status: 'AWAITING_INPUT',
  } });

  // ── account B: no provider row at all, maintenance off, a space on the same machine ───────────────
  const ownerB = randomUUID();
  await prisma.user.create({ data: { id: ownerB, email: `maintain-${ownerB}@canary.invalid`, name: 'providerless canary', passwordHash: 'x' } });
  // Its own machine: a runner of its own account, and a checkout of its own (the same commit, read separately, so
  // two runners never fetch into one working tree).
  const runnerB = randomUUID();
  const runnerTokenB = `runner-${randomUUID()}`;
  await prisma.runner.create({ data: { id: runnerB, name: 'p8-maintain-runner-b', ownerId: ownerB, tokenHash: createHash('sha256').update(runnerTokenB).digest('hex') } });
  const checkoutB = `${checkout}-b`;
  execFileSync('git', ['clone', '-q', origin, checkoutB]);
  const workspaceB = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceB, name: 'p8-maintain-checkout-b', ownerId: ownerB, runnerId: runnerB, workDir: checkoutB, env: {} } });
  const spaceB = randomUUID();
  await prisma.wikiSpace.create({ data: {
    id: spaceB, ownerId: ownerB, slug: `maintain-${spaceB.slice(0, 8)}`, title: 'Providerless space (P8)',
    repoUrlNorm, rootCommitSha,
    // No list yet, and a provider no maintenance run could start on: the owner's PATCH makes it runnable.
    settings: { reviewMode: 'manual', maintenance: { enabled: false, provider: 'claude' } },
  } });
  await prisma.wikiSpaceWorkspace.create({ data: { spaceId: spaceB, ownerId: ownerB, workspaceId: workspaceB } });
  const sessionsB = await settledSessions(prisma, ownerB, workspaceB, runnerB, 25);
  const tasksB = await triggerTasks(prisma, ownerB, workspaceB, 4, 'providerless trigger');

  for (const [home, id, token, name, dir] of [
    [process.env.RUNNER_HOME, runnerId, runnerToken, 'p8-maintain-runner', checkout],
    [process.env.RUNNER_HOME_B, runnerB, runnerTokenB, 'p8-maintain-runner-b', checkoutB],
  ]) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      serverUrl: process.env.API_BASE, runnerId: id, runnerToken: token, name, labels: [], maxConcurrent: 2, workDir: dir,
    }), { mode: 0o600 });
  }

  console.log(JSON.stringify({
    ownerA, runnerId, runnerToken, workspaceA, listA, spaceA, sessionsA, tasksA, maintenanceTask, maintenanceSession,
    ownerB, runnerB, runnerTokenB, workspaceB, checkoutB, spaceB, sessionsB, tasksB, origin, rootCommitSha,
  }));
  await prisma.$disconnect();
}

/** `count` settled sessions of a space, ten to thirty-five minutes old, each with one owner turn. */
async function settledSessions(prisma, ownerId, workspaceId, runnerId, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const sessionId = randomUUID();
    const at = new Date(Date.now() - (10 + i) * 60_000);
    await prisma.$executeRaw`
      INSERT INTO "session"("id","title","prompt","owner_id","creator_id","workspace_id","assigned_runner_id",
                            "status","last_turn_at","dispatch_origin","created_at","updated_at")
      VALUES (${sessionId}::uuid, ${`canary session ${i}`}, 'p', ${ownerId}::uuid, ${ownerId}::uuid, ${workspaceId}::uuid,
              ${runnerId}::uuid, 'SUCCEEDED', ${at}::timestamptz, 'USER', ${at}::timestamptz, now())`;
    await prisma.$executeRaw`
      INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","content","status","kind","send_intent","created_at")
      VALUES (${randomUUID()}::uuid, ${sessionId}::uuid, 1, ${randomUUID()}::uuid, ${TURN}, 'ANSWERED', 'message', 'NEXT_TURN', ${at}::timestamptz)`;
    ids.push(sessionId);
  }
  return ids;
}

/** `count` open tasks on a space's workspace: cancelling one is a committed fact, and the trigger's hint. */
async function triggerTasks(prisma, ownerId, workspaceId, count, title) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const taskId = randomUUID();
    await prisma.task.create({ data: {
      id: taskId, title: `${title} ${i}`, ownerId, creatorType: 'USER', creatorId: ownerId,
      assigneeId: workspaceId, completionCriterion: 'EVIDENCE_JUDGMENT',
    } });
    ids.push(taskId);
  }
  return ids;
}

main().catch((error) => { console.error(error); process.exit(1); });
