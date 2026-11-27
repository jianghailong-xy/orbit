// The seed both builds are measured on: one workspace of one account with 1,500 Open sessions, ten folders and
// thirty projects of ten sessions each (a coordinator and nine task runs). It is the seed of
// src/apiserver/src/sessions/session-listing-scale.pg.spec.ts, with fixed ids, so every run writes the same rows.
//
//   node seed.mjs <built tree> <database url> <owner email> <facts.json>
//
// The Prisma client and pg are the given tree's. The owner account must already exist.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const SESSIONS = 1_500;
const FOLDERS = 10;
const PROJECTS = 30;
const MEMBERS = 9;

const [tree, url, email, out] = process.argv.slice(2);
const require = createRequire(join(tree, 'src/apiserver/package.json'));
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { uuidToBase62 } = require('@orbit/shared');

const db = new PrismaClient({ adapter: new PrismaPg(url) });
const id = (kind, n) => `0196f000-${String(kind).padStart(4, '0')}-7000-8000-${String(n).padStart(12, '0')}`;

const { id: ownerId } = await db.user.findUniqueOrThrow({ where: { email } });
const runnerId = id(1, 1);
await db.runner.create({
  data: {
    id: runnerId, ownerId, name: 'scale runner', tokenHash: 'scale-runner-token-hash',
    status: 'ONLINE', capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
  },
});
const workspaceId = id(2, 1);
await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'Scale workspace', enabled: true } });
const folders = [];
for (let i = 0; i < FOLDERS; i += 1) {
  folders.push(id(3, i + 1));
  await db.sessionFolder.create({ data: { id: folders[i], ownerId, workspaceId, name: `Folder ${String(i + 1).padStart(2, '0')}` } });
}

const t0 = Date.parse('2026-11-01T00:00:00.000Z');
const rows = [];
const base = (i, extra = {}) => {
  const at = new Date(t0 + i * 60_000);
  return {
    id: id(4, i + 1), ownerId, creatorId: ownerId, title: `Scale session ${i} — a title of ordinary length`,
    prompt: 'p', dispatchOrigin: 'USER', workspaceId, assignedRunnerId: runnerId, status: 'AWAITING_INPUT',
    createdAt: at, startedAt: at, lastTurnAt: at, listedAt: new Date(at.getTime() + 30_000),
    lastAssistantText: 'Recap: '.padEnd(400, 'x'),
    // Every row names the same columns: a column one row of a createMany leaves out is written NULL, not its default.
    folderId: null, pinnedAt: null, taskId: null, runningBgJobs: [], runningBgJobActivity: {},
    ...extra,
  };
};
// Thirty projects: a coordinator here (a third of them filed in a folder) and nine task runs each.
const coordinators = [];
for (let p = 0; p < PROJECTS; p += 1) {
  const projectId = id(5, p + 1);
  await db.project.create({ data: { id: projectId, ownerId, title: `Scale project ${p}` } });
  const coordinator = base(rows.length, { folderId: p % 3 === 0 ? folders[p % FOLDERS] : null, pinnedAt: p < 2 ? new Date(t0) : null });
  rows.push(coordinator);
  coordinators.push({ projectId, sessionId: coordinator.id });
  const tasks = Array.from({ length: MEMBERS }, (_, m) => ({
    id: id(6, p * 100 + m + 1), ownerId, creatorType: 'USER', creatorId: ownerId, title: `scale task ${p}.${m}`,
    projectId, completionCriterion: 'OWNER_CONFIRMED',
  }));
  await db.task.createMany({ data: tasks });
  for (const task of tasks) rows.push(base(rows.length, { taskId: task.id }));
}
// The rest: two fifths filed in folders, a few pinned, a few running or with a job in flight.
while (rows.length < SESSIONS) {
  const i = rows.length;
  rows.push(base(i, {
    folderId: i % 5 < 2 ? folders[i % FOLDERS] : null,
    pinnedAt: i % 97 === 0 ? new Date(t0) : null,
    ...(i % 61 === 0 ? { status: 'RUNNING' } : {}),
    ...(i % 67 === 0 ? { runningBgJobs: ['bgj_scale'], runningBgJobActivity: {} } : {}),
  }));
}
await db.session.createMany({ data: rows });
for (const { projectId, sessionId } of coordinators) {
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId: sessionId } });
}

const open = await db.session.count({ where: { ownerId, workspaceId } });
await db.$disconnect();
writeFileSync(out, JSON.stringify({
  seed: { openSessions: open, folders: FOLDERS, projects: PROJECTS, sessionsPerProject: MEMBERS + 1 },
  runnerId,
  workspaceId: uuidToBase62(workspaceId),
  // Idle sessions in no folder and no project: a watch names one as its observer.
  idleTitles: rows.filter((r, i) => i >= PROJECTS * (MEMBERS + 1) && !r.folderId && r.status === 'AWAITING_INPUT' && !r.runningBgJobs.length)
    .map((r) => ({ id: uuidToBase62(r.id), title: r.title })),
  // Rows the list draws under "Working" rather than under a date, among those that are rows of their own.
  workingTitles: rows.filter((r, i) => i >= PROJECTS * (MEMBERS + 1) && !r.folderId && !r.pinnedAt
    && (r.status === 'RUNNING' || r.runningBgJobs.length)).map((r) => r.title),
  // A running session: a watch on its turn settling stays live.
  runningId: uuidToBase62(rows.findLast((r) => r.status === 'RUNNING').id),
}, null, 2));
