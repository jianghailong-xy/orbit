// One owner answer through the real decide door, its answer recorded. usage: node decide.mjs <prod-entry-id> <action> <out-file>
import fs from 'node:fs';
import { call, state } from './api.mjs';
const [prod, action, outFile] = process.argv.slice(2);
const st = state();
const review = await call('GET', '/wiki/review');
const entryId = st.entryIds[prod];
for (const cs of review) for (const op of cs.ops) {
  if (op.entryId === entryId && op.decision === 'pending') {
    const answer = await call('POST', `/wiki/changesets/${cs.id}/decide`, { decisions: [{ opId: op.id, action }] });
    fs.writeFileSync(outFile, JSON.stringify(answer, null, 1));
    console.log(action, prod, '->', answer.ops.find((o) => o.id === op.id)?.decision);
    process.exit(0);
  }
}
console.log('no pending op for', prod); process.exit(1);
