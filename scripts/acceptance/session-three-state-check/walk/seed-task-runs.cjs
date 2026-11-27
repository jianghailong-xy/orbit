// Add one task with two runs for the task panel's run badges: a run that finished the work (SUCCEEDED,
// end reason task_done) and a later run queued on hold (PENDING, a paused account's hold notice). The task was
// reopened after the first run, so it is IN_PROGRESS with the second run queued.
// usage: (. <walk>/env && node seed-task-runs.cjs <tip checkout> <walk dir>)   after seed.cjs; appends to seed.json.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: seed-task-runs.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));
const { RunStatus, SessionDispatchOrigin } = require(require.resolve('@prisma/client', { paths: [api] }));

const MINUTE = 60_000;

async function main() {
  const seedFile = path.join(walk, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  if (seed.tasks?.['two-runs']) { console.log('task with two runs already seeded'); return; }
  const db = prismaClientFor(process.env.DATABASE_URL);
  const owner = await db.user.findUniqueOrThrow({ where: { email: seed.ownerEmail }, select: { id: true } });
  const task = await db.task.create({
    data: {
      title: 'walk task with two runs', ownerId: owner.id, creatorType: 'USER', creatorId: owner.id,
      completionCriterion: 'EXECUTABLE', status: 'IN_PROGRESS', assigneeId: seed.workspaceId,
    },
    select: { id: true },
  });
  const base = {
    ownerId: owner.id, creatorId: owner.id, workspaceId: seed.workspaceId, assignedRunnerId: seed.runnerId,
    prompt: 'hello', provider: 'claude', dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1,
    taskId: task.id, startsTaskWork: true,
  };
  const runs = {
    finished: {
      title: 'walk two runs: finished run',
      row: {
        status: RunStatus.SUCCEEDED, endReason: 'task_done', lastTurnOutcome: 'ANSWERED',
        startedAt: new Date(Date.now() - 50 * MINUTE), finishedAt: new Date(Date.now() - 30 * MINUTE),
        createdAt: new Date(Date.now() - 50 * MINUTE),
      },
    },
    'on-hold': {
      title: 'walk two runs: on-hold run',
      row: {
        status: RunStatus.PENDING, error: 'Account paused until 2099-01-01T00:00:00.000Z',
        createdAt: new Date(Date.now() - 10 * MINUTE),
      },
    },
  };
  const out = {};
  for (const [key, run] of Object.entries(runs)) {
    const id = crypto.randomUUID();
    await db.session.create({ data: { id, ...base, title: run.title, ...run.row } });
    out[key] = { id, title: run.title };
  }
  seed.tasks = { ...(seed.tasks ?? {}), 'two-runs': { id: task.id, title: 'walk task with two runs', runs: out } };
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  console.log('seeded the task with two runs');
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
