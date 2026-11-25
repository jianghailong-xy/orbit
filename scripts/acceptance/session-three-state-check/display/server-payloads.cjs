// Seed the walk's database with the comparison table's cases as real rows, and write every payload kind of each as the
// tip's own server code builds it (sessions/session-payloads.fixture.ts: buildWorld + readPayloads — listRow, detail,
// sessionSummary, sessionEnded, linkPreview, guestRow, sharedHead, taskRun).
//   (. <walk>/env && node server-payloads.cjs <tip checkout> <walk dir>)     after the apiserver is up
// Writes <walk>/world.json (case -> session and task ids, runner, the owner's email) and <walk>/server-rows.json.
// The world's owner gets the password of the account the walk bootstraps, so the console shows these very rows.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: server-payloads.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const fixture = require(path.join(api, 'build/sessions/session-payloads.fixture.js'));
const { RunStatus } = require(require.resolve('@prisma/client', { paths: [api] }));

const DAY = 24 * 3600_000;
const tomorrow = () => new Date(Date.now() + DAY);
const bg = (ids, jobs) => ({
  runningBgShells: ids,
  ...(jobs ? { runningBgJobs: ids, runningBgJobActivity: Object.fromEntries(ids.map((i) => [i, Date.now() - 30_000])) } : {}),
});
const approval = (db, _owner, sessionId) => db.approval.create({
  data: { sessionId, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `toolu_${sessionId}` },
});

// The board's cases the server's fixture does not seed, and the marks no fixture case shows.
const CROSS = [
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
];
fixture.FIXTURE_CASES.push(...CROSS);

async function main() {
  const stack = fixture.connect(process.env.DATABASE_URL);
  const { db } = stack;
  const run = crypto.randomUUID().slice(0, 8);
  const world = await fixture.buildWorld(db, run);
  // The walk's bootstrapped account lends its password to the world's owner (a throwaway database).
  const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
  const bootstrap = await db.user.findUniqueOrThrow({ where: { email: seed.ownerEmail }, select: { passwordHash: true, role: true } });
  const owner = await db.user.update({ where: { id: world.ownerId }, data: { passwordHash: bootstrap.passwordHash } });
  const guest = await db.user.update({ where: { id: world.guestId }, data: { passwordHash: bootstrap.passwordHash } });
  const runner = await db.runner.findFirstOrThrow({ where: { ownerId: world.ownerId } });

  const payloads = await fixture.readPayloads(stack, world);
  const rows = [];
  const cases = {};
  for (const c of fixture.FIXTURE_CASES) {
    const id = world.ids.get(c.label);
    const task = await db.task.findUniqueOrThrow({ where: { id: world.taskIds.get(c.label) }, select: { id: true, title: true } });
    cases[c.label] = { sessionId: id, title: `payloads ${c.label}`, taskId: task.id, taskTitle: task.title, status: c.status };
    for (const kind of fixture.PAYLOAD_KINDS) {
      rows.push({ id: `${c.label}|${kind}`, name: c.label, kind, payload: payloads.get(c.label)[kind] });
    }
  }
  fs.writeFileSync(path.join(walk, 'world.json'), JSON.stringify({
    ownerEmail: owner.email, guestEmail: guest.email, ownerId: world.ownerId, runnerId: runner.id, cases,
  }, null, 2));
  fs.writeFileSync(path.join(walk, 'server-rows.json'),
    JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  console.log(`seeded ${Object.keys(cases).length} cases, ${rows.length} payloads`);
  await db.$disconnect();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
