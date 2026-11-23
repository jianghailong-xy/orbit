// Add the control session beside the seven: a plain RUNNING turn (stored RUNNING, no approval, no job), the shape
// the approval case has minus its approval. Its expected word is "Running" (WorkspaceView statusLabel: generating).
// usage: (. <walk>/env && node seed-control.cjs <tip checkout> <walk dir>)   after seed.cjs; appends to seed.json.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: seed-control.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));
const { RunStatus, SessionDispatchOrigin } = require(require.resolve('@prisma/client', { paths: [api] }));

async function main() {
  const seedFile = path.join(walk, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  if (seed.cases['control-running']) { console.log('control already seeded'); return; }
  const db = prismaClientFor(process.env.DATABASE_URL);
  const owner = await db.user.findUniqueOrThrow({ where: { email: seed.ownerEmail }, select: { id: true } });
  const id = crypto.randomUUID();
  const title = 'walk running turn (control)';
  await db.session.create({
    data: {
      id, ownerId: owner.id, creatorId: owner.id, workspaceId: seed.workspaceId, assignedRunnerId: seed.runnerId,
      title, prompt: 'hello', provider: 'claude', status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * 60_000), numTurns: 1,
      createdAt: new Date(Date.now() - 8 * 60_000),
    },
  });
  seed.cases['control-running'] = { id, title, control: true };
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  console.log('seeded the control session');
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
