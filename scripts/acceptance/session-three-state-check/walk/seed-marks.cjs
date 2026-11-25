// Add the sessions whose marks the seven cases and the controls do not show, for the display walk (walk-marks.mjs):
//   interrupted     held, its last turn stopped                       -> Idle + Interrupted
//   will-resume     parked, a retry armed (the server's ARMED_RETRY)  -> Idle + Will resume (waitingOn WAKE)
//   retrying        released by a failed turn, a retry armed          -> Idle + Retrying
//   runner-offline  released by a failed turn, error "runner offline" -> Idle + Failed (no Disconnected mark)
// usage: (. <walk>/env && node seed-marks.cjs <tip checkout> <walk dir>)   after seed.cjs; appends to seed.json and
// skips a case already there.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: seed-marks.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));
const { RunStatus, SessionDispatchOrigin } = require(require.resolve('@prisma/client', { paths: [api] }));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CASES = [
  { key: 'interrupted', title: 'walk interrupted turn', minutesAgo: 11, status: RunStatus.INTERRUPTED, row: { lastTurnOutcome: 'INTERRUPTED' } },
  {
    key: 'will-resume', title: 'walk will resume', minutesAgo: 12, status: RunStatus.AWAITING_INPUT,
    row: { lastTurnOutcome: 'ANSWERED', retryAt: new Date(Date.now() + DAY) },
  },
  {
    key: 'retrying', title: 'walk retrying failure', minutesAgo: 13, status: RunStatus.FAILED,
    row: { lastTurnOutcome: 'FAILED', error: 'provider overloaded', retryAt: new Date(Date.now() + DAY), finishedAt: new Date() },
  },
  {
    key: 'runner-offline', title: 'walk runner offline', minutesAgo: 14, status: RunStatus.FAILED,
    row: { lastTurnOutcome: 'FAILED', error: 'runner offline', finishedAt: new Date() },
  },
];

async function main() {
  const seedFile = path.join(walk, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const db = prismaClientFor(process.env.DATABASE_URL);
  const owner = await db.user.findUniqueOrThrow({ where: { email: seed.ownerEmail }, select: { id: true } });
  for (const c of CASES) {
    if (seed.cases[c.key]) { console.log(`${c.key} already seeded`); continue; }
    const id = crypto.randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId: seed.workspaceId, assignedRunnerId: seed.runnerId,
        title: c.title, prompt: 'hello', provider: 'claude', status: c.status,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * MINUTE), numTurns: 1,
        createdAt: new Date(Date.now() - c.minutesAgo * MINUTE),
        ...c.row,
      },
    });
    seed.cases[c.key] = { id, title: c.title };
    console.log(`seeded ${c.key}`);
  }
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
