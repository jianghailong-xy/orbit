// The server's own guestRow and sharedHead for the 23 cases of the cross-client display check: the payload fixture's cases
// plus the board's cases it does not seed, written as real rows and read back through the tip's guest services
// (sessions/session-payloads.fixture.ts). Android's GuestDisplayRowsTest reads the result, guest-payloads.json.
//   DATABASE_URL=<throwaway, migrated> node make-guest-payloads.cjs    (apiserver built: tsc -p tsconfig.test.json)
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const api = path.resolve(__dirname, '../../../../src/apiserver');
const fixture = require(path.join(api, 'build/sessions/session-payloads.fixture.js'));
const { RunStatus } = require(require.resolve('@prisma/client', { paths: [api] }));

const tomorrow = () => new Date(Date.now() + 24 * 3600_000);
const bg = (ids, jobs) => ({
  runningBgShells: ids,
  ...(jobs ? { runningBgJobs: ids, runningBgJobActivity: Object.fromEntries(ids.map((i) => [i, Date.now() - 30_000])) } : {}),
});
const approval = (db, _owner, sessionId) => db.approval.create({
  data: { sessionId, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `toolu_${sessionId}` },
});

fixture.FIXTURE_CASES.push(
  { label: 'ended, runner never confirmed', status: RunStatus.FAILED, row: { endReason: 'ended', error: 'cancel not honored', lastTurnOutcome: 'FAILED' } },
  { label: 'old plain row stored SUCCEEDED', status: RunStatus.SUCCEEDED, row: { lastTurnOutcome: 'ANSWERED' } },
  { label: 'ending after an interrupted turn', status: RunStatus.INTERRUPTED, row: { endReason: 'ended', lastTurnOutcome: 'INTERRUPTED', cancelRequestedAt: tomorrow() } },
  { label: 'parked, engine started its own turn', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', engineTurnActive: true } },
  { label: 'parked, sub-agent running', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', runningSubagents: ['sub_walk'] } },
  { label: 'parked, background process left up', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', ...bg(['sh_walk'], false) } },
  { label: 'parked, retry armed', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', retryAt: tomorrow() } },
  { label: 'failed, retry armed', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'provider overloaded', retryAt: tomorrow() } },
  { label: 'failed, runner offline', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'runner offline' } },
  { label: 'approval beside a background job', status: RunStatus.RUNNING, row: bg(['bgj_walk2'], true), arm: approval },
  {
    label: 'interrupted, a process up, retry armed', status: RunStatus.INTERRUPTED,
    row: { lastTurnOutcome: 'INTERRUPTED', retryAt: tomorrow(), ...bg(['sh_walk3'], false) },
  },
);

async function main() {
  const stack = fixture.connect(process.env.DATABASE_URL);
  const world = await fixture.buildWorld(stack.db, 'guest');
  const payloads = await fixture.readPayloads(stack, world);
  const rows = fixture.FIXTURE_CASES.map((c) => ({
    name: c.label, guestRow: payloads.get(c.label).guestRow, sharedHead: payloads.get(c.label).sharedHead,
  }));
  const out = path.join(__dirname, 'guest-payloads.json');
  fs.writeFileSync(out, JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1) + '\n');
  console.log(`${rows.length} cases -> ${out}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
