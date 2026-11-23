// Put a fresh pending tool approval (Bash `npm test`) on one seeded case's session, as the payloads fixture's
// approval case does: a second card to press after the first was answered.
// usage: (. <walk>/env && node seed-approval.cjs <tip checkout> <walk dir> <case key>)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk, key] = process.argv.slice(2);
if (!tip || !walk || !key) throw new Error('usage: seed-approval.cjs <tip checkout> <walk dir> <case key>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));

async function main() {
  const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
  const c = seed.cases[key];
  if (!c) throw new Error(`no case ${key} in seed.json`);
  const db = prismaClientFor(process.env.DATABASE_URL);
  await db.approval.create({
    data: { sessionId: c.id, toolName: 'Bash', input: { command: 'npm test' }, toolUseId: `toolu_${crypto.randomUUID()}` },
  });
  console.log(`pending approval added to ${key}`);
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
