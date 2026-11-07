// File changeset 34so6smHP5ywNOPjvYbqa's four challenges as task A's session did (runner door, x-orbit-session-id),
// word for word, each entry id mapped to this stack's copy of it. usage: node challenge.mjs [backdate-minutes]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { call, save, state } from './api.mjs';
const WT = '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70';
const require = createRequire(`${WT}/src/apiserver/package.json`);
const { toUuid } = require(`${WT}/src/shared/dist/index.js`);
const { prismaClientFor } = require(`${WT}/src/apiserver/dist/prisma/prisma-client.js`);
const calls = JSON.parse(fs.readFileSync('/mnt/data/tmp/34tDf8/data/propose-calls.json', 'utf8'));
const which = process.argv[3] ?? 'toolu_012CKdwtMgVJxjCQ3SVYyAwk';
const input = calls.find((c) => c.id === which).input;
const st = state();
const ops = input.ops.map((op) => ({ ...op, entryId: st.entryIds[op.entryId] }));
const answer = await call('POST', '/runner/wiki/changesets',
  { spaceId: st.spaceId, rationale: input.rationale, idempotencyKey: `${input.idempotencyKey}-${Date.now()}`, ops },
  { as: 'runner', session: st.sessionId });
console.log(JSON.stringify(answer, null, 1).slice(0, 3000));
const minutes = Number(process.argv[2] ?? 0);
if (minutes > 0 && answer.changesetId) {
  const db = prismaClientFor(process.env.DATABASE_URL);
  const at = new Date(Date.now() - minutes * 60_000);
  await db.wikiChangeset.update({ where: { id: toUuid(answer.changesetId) }, data: { createdAt: at } });
  await db.$disconnect();
  console.log('backdated to', at.toISOString());
}
save({ [`changeset_${which}`]: answer.changesetId ?? answer.id });
