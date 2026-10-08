// The P8 maintenance canary's fixture, written with this branch's own Prisma client: an owner; a machine whose
// config this branch's runner binary starts from; a workspace reading a checkout of this repository; a space with
// maintenance on (manual review, so its ops wait for the owner and no verdict is asked), bound to the workspace and
// carrying the checkout's repository identity. Then twenty-five settled sessions, each with one owner turn carrying
// the words the fake model quotes, and three open tasks on the workspace to cancel as the triggers. Every id is
// generated here, into a throwaway database.
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
  const ownerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `maintain-${ownerId}@canary.invalid`, name: 'maintenance canary', passwordHash: 'x' } });

  const runnerId = randomUUID();
  const runnerToken = `runner-${randomUUID()}`;
  await prisma.runner.create({ data: { id: runnerId, name: 'p8-maintain-runner', ownerId, tokenHash: createHash('sha256').update(runnerToken).digest('hex') } });
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: 'p8-maintain-checkout', ownerId, runnerId, workDir: checkout, env: {} } });
  const listId = randomUUID();
  await prisma.taskList.create({ data: { id: listId, ownerId, title: 'Wiki maintenance', hidden: true, maxConcurrent: 1 } });

  const origin = execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const rootCommitSha = execFileSync('git', ['-C', checkout, 'rev-list', '--max-parents=0', 'origin/main'], { encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter(Boolean).pop();
  const spaceId = randomUUID();
  await prisma.wikiSpace.create({ data: {
    id: spaceId, ownerId, slug: `maintain-${spaceId.slice(0, 8)}`, title: 'Maintenance space (P8)',
    repoUrlNorm: normalizeRepoUrl(origin), rootCommitSha,
    settings: { reviewMode: 'manual', maintenance: { enabled: true, workspaceId, listId, provider: 'claude' } },
  } });
  await prisma.wikiSpaceWorkspace.create({ data: { spaceId, ownerId, workspaceId } });

  // Twenty-five settled sessions of the space, ten minutes old: past the settle grace, and far inside the day.
  const sessionIds = [];
  for (let i = 0; i < 25; i += 1) {
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
    sessionIds.push(sessionId);
  }

  // Six open tasks on the space's workspace: cancelling one is a committed fact, and the trigger's hint — the
  // extra ones are for a hint that arrives while the run before it is still settling.
  const taskIds = [];
  for (let i = 0; i < 6; i += 1) {
    const taskId = randomUUID();
    await prisma.task.create({ data: {
      id: taskId, title: `canary trigger ${i}`, ownerId, creatorType: 'USER', creatorId: ownerId,
      assigneeId: workspaceId, completionCriterion: 'EVIDENCE_JUDGMENT',
    } });
    taskIds.push(taskId);
  }

  const home = process.env.RUNNER_HOME;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    serverUrl: process.env.API_BASE, runnerId, runnerToken, name: 'p8-maintain-runner', labels: [], maxConcurrent: 2, workDir: checkout,
  }), { mode: 0o600 });

  console.log(JSON.stringify({ ownerId, runnerId, runnerToken, workspaceId, listId, spaceId, sessionIds, taskIds, origin, rootCommitSha }));
  await prisma.$disconnect();
}

main().catch((error) => { console.error(error); process.exit(1); });
