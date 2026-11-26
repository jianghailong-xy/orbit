// Add the plain running turns beside the seven: stored RUNNING, no approval, no job — the approval case's shape minus
// its approval. Two of them, because the console words a running turn by whether its engine has started
// (sessionIsStarting: RUNNING with `engineStartedAt` null):
//   control-running   engine not started yet -> "Starting" (the F7 control)
//   running-started   engine started a minute ago -> "Running"
// usage: (. <walk>/env && node seed-control.cjs <tip checkout> <walk dir>)   after seed.cjs; appends to seed.json and
// skips a case already there.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: seed-control.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));
const { RunStatus, SessionDispatchOrigin } = require(require.resolve('@prisma/client', { paths: [api] }));

const MINUTE = 60_000;
const CONTROLS = [
  { key: 'control-running', title: 'walk running turn (control)', minutesAgo: 8, row: {} },
  {
    key: 'running-started', title: 'walk running turn (engine started)', minutesAgo: 9,
    row: { lastTurnAt: new Date(Date.now() - 2 * MINUTE), engineStartedAt: new Date(Date.now() - MINUTE) },
  },
];

async function main() {
  const seedFile = path.join(walk, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const db = prismaClientFor(process.env.DATABASE_URL);
  const owner = await db.user.findUniqueOrThrow({ where: { email: seed.ownerEmail }, select: { id: true } });
  for (const c of CONTROLS) {
    if (seed.cases[c.key]) { console.log(`${c.key} already seeded`); continue; }
    const id = crypto.randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId: seed.workspaceId, assignedRunnerId: seed.runnerId,
        title: c.title, prompt: 'hello', provider: 'claude', status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * MINUTE), numTurns: 1,
        createdAt: new Date(Date.now() - c.minutesAgo * MINUTE),
        ...c.row,
      },
    });
    seed.cases[c.key] = { id, title: c.title, control: true };
    console.log(`seeded ${c.key}`);
  }
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
