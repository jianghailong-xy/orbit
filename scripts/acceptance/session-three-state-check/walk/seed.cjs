// Seed the walk's owner and its seven sessions on a real apiserver.
// usage: (. <walk>/env && node seed.cjs <tip checkout> <walk dir>)
// The owner is made through the real POST /api/auth/bootstrap; everything else is a Prisma write shaped like
// src/apiserver/src/sessions/session-payloads.fixture.ts (buildWorld), but owned by that owner so the console shows it.
// Writes <walk>/pw (the owner's password, mode 600) and <walk>/seed.json (case label -> session id, runner id).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [tip, walk] = process.argv.slice(2);
if (!tip || !walk) throw new Error('usage: seed.cjs <tip checkout> <walk dir>');
const api = path.join(tip, 'src/apiserver');
const { prismaClientFor } = require(path.join(api, 'build/prisma/prisma-client.js'));
const { RunStatus, RunnerStatus, SessionDispatchOrigin } = require(require.resolve('@prisma/client', { paths: [api] }));

const MINUTE = 60_000;
const EMAIL = 'walk-owner@example.com';
const BASE = `http://127.0.0.1:${process.env.PORT}/api`;

// The seven cases of the walk, newest first in the list (createdAt steps back a minute each).
const CASES = [
  { key: 'held-idle', title: 'walk held idle', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED' } },
  {
    key: 'job-no-turn', title: 'walk job with no turn', status: RunStatus.AWAITING_INPUT,
    row: {
      lastTurnOutcome: 'ANSWERED',
      runningBgShells: ['bgj_walk'],
      runningBgJobs: ['bgj_walk'],
      runningBgJobActivity: { bgj_walk: Date.now() - 30_000 },
    },
  },
  {
    key: 'approval', title: 'walk waiting on approval', status: RunStatus.RUNNING,
    arm: (db, _owner, id) => db.approval.create({
      data: { sessionId: id, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `toolu_${id}` },
    }),
  },
  {
    key: 'on-hold', title: 'walk on hold', status: RunStatus.PENDING,
    row: { error: 'Account paused until 2099-01-01T00:00:00.000Z', lastTurnOutcome: 'ANSWERED' },
  },
  { key: 'failed-turn', title: 'walk failed turn', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'engine exited' } },
  { key: 'ended', title: 'walk released by End', status: RunStatus.CANCELLED, row: { endReason: 'ended', lastTurnOutcome: 'ANSWERED' } },
  {
    key: 'task-finished', title: 'walk task run finished', status: RunStatus.SUCCEEDED,
    row: { endReason: 'task_done', lastTurnOutcome: 'ANSWERED' }, task: true,
  },
];
const RELEASED = new Set([RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]);

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const db = prismaClientFor(process.env.DATABASE_URL);
  const pwFile = path.join(walk, 'pw');
  let password;
  // The server says whether its first account still has to be made; a pw file left from an earlier stack does not.
  const setup = await (await fetch(`${BASE}/auth/setup-status`)).json();
  if (setup.needsSetup) {
    password = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
    await post('/auth/bootstrap', { email: EMAIL, name: 'Walk Owner', password });
  } else {
    password = fs.readFileSync(pwFile, 'utf8').trim();
  }
  // The real sign-in, as the console does it: proves the account signs in before the browser tries.
  const login = await post('/auth/login', { email: EMAIL, password });
  if (!login || typeof login !== 'object') throw new Error('login returned nothing');
  const owner = await db.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } });

  const runnerId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'walk-runner', tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: 'walk-agent', enabled: true } });

  const ids = {};
  let n = 0;
  for (const c of CASES) {
    const id = crypto.randomUUID();
    n += 1;
    let taskId;
    if (c.task) {
      const task = await db.task.create({
        data: {
          title: 'walk task (finished)', ownerId: owner.id, creatorType: 'USER', creatorId: owner.id,
          completionCriterion: 'EXECUTABLE', status: 'DONE', assigneeId: workspaceId,
        },
        select: { id: true },
      });
      taskId = task.id;
    }
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId,
        title: c.title, prompt: 'hello', provider: 'claude', status: c.status,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * MINUTE), numTurns: 1,
        createdAt: new Date(Date.now() - n * MINUTE),
        ...(RELEASED.has(c.status) ? { finishedAt: new Date() } : {}),
        ...(taskId ? { taskId } : {}),
        ...c.row,
      },
    });
    await c.arm?.(db, owner.id, id);
    ids[c.key] = { id, title: c.title, ...(taskId ? { taskId } : {}) };
  }
  fs.writeFileSync(path.join(walk, 'seed.json'), JSON.stringify({ ownerEmail: EMAIL, runnerId, workspaceId, cases: ids }, null, 2));
  console.log(`seeded ${Object.keys(ids).length} sessions for ${EMAIL}`);
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
