#!/usr/bin/env node
// Writes src/link-gateway/testdata/b1-hints.json: the NATS subject and message the apiserver publishes for each kind of
// runner link hint, as its own encoder writes them (src/apiserver/src/realtime/runner-hints.ts, runnerHintSubject and
// runnerHintMessage). The link gateway decodes every message strictly (src/link-gateway/hints_test.go), and the
// apiserver's spec holds the encoder to the same file (src/apiserver/src/realtime/runner-hints.spec.ts), so a field
// renamed on either side turns one of them red.
//
//   npx tsc -p src/apiserver/tsconfig.json     # or npm run build -w @orbit/apiserver
//   node scripts/runner-link/gen-hint-fixtures.mjs
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = path.join(repo, 'src/apiserver/dist/realtime/runner-hints.js');
if (!existsSync(compiled)) {
  console.error(`missing ${compiled}: build the apiserver first (npx tsc -p src/apiserver/tsconfig.json)`);
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { runnerHintSubject, runnerHintMessage } = require(compiled);

const runnerId = '0190a0b0-0000-7000-8000-000000000001';
const sessionId = '0190a0b0-0000-7000-8000-0000000000a1';
const cases = [
  ['claim: a session is queued for the runner', { claim: {} }],
  ['commands: something its heartbeat delivers is waiting', { commands: {} }],
  ['inbox: a message is waiting in one of its sessions', { inbox: { sessionId } }],
].map(([name, hint]) => ({ name, runnerId, hint, subject: runnerHintSubject(runnerId), message: runnerHintMessage(hint) }));

const out = path.join(repo, 'src/link-gateway/testdata/b1-hints.json');
writeFileSync(out, `${JSON.stringify({
  generatedBy: 'scripts/runner-link/gen-hint-fixtures.mjs, with src/apiserver/src/realtime/runner-hints.ts',
  cases,
}, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(repo, out)}`);
for (const c of cases) console.log(`  ${c.subject} ${c.message}`);
