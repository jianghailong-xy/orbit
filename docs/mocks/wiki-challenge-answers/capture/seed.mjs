// Seed the private stack with the four entries of task 34snwipJZpZ7fBMfDPhqH and the session-filed challenges of
// changeset 34so6smHP5ywNOPjvYbqa, word for word (data/propose-calls.json, read from task A's own transcript).
// Steps: owner, runner, workspace, session; the two tasks and the tool call the challenges cite (DB rows with the
// production ids); the space; the entries (the owner's own adds, as production holds them now); the challenges
// through the runner door as the session.  usage: node seed.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { call, save, state, S } from './api.mjs';
const WT = '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70';
const require = createRequire(`${WT}/src/apiserver/package.json`);
const { toUuid, uuidToBase62 } = require(`${WT}/src/shared/dist/index.js`);
const { prismaClientFor } = require(`${WT}/src/apiserver/dist/prisma/prisma-client.js`);
const DATA = '/mnt/data/tmp/34tDf8/data';
const calls = JSON.parse(fs.readFileSync(`${DATA}/propose-calls.json`, 'utf8'));
const challenge = calls.find((c) => c.id === 'toolu_012CKdwtMgVJxjCQ3SVYyAwk').input;
const evidence = JSON.parse(fs.readFileSync(`${DATA}/toolu_01R7D9vx6BsYBFBUJ1CnJbE9.json`, 'utf8'));
const prod = JSON.parse(fs.readFileSync(`${DATA}/entries.json`, 'utf8'));

const st = state();
if (!st.accessToken) {
  const login = await call('POST', '/auth/bootstrap', { email: 'owner@orbit.test', name: 'wikova', password: 'orbit-board-34tDf8' }, { as: 'none' });
  save({ accessToken: login.accessToken, refreshToken: login.refreshToken, userId: login.user?.id });
}
if (!state().runnerToken) {
  const enroll = await call('POST', '/runners/enrollment-tokens', {});
  const reg = await call('POST', '/runner/register', { enrollmentToken: enroll.token, name: 'workstation-gpu', hostname: 'workstation', version: '0.1.270' }, { as: 'none' });
  save({ runnerId: reg.runnerId, runnerToken: reg.runnerToken });
}
if (!state().workspaceId) {
  const ws = await call('POST', '/workspaces', { name: 'orbit-develop', runnerId: state().runnerId, workDir: '/root/orbit' });
  save({ workspaceId: ws.id });
}
const db = prismaClientFor(process.env.DATABASE_URL);
const owner = await db.user.findFirstOrThrow({ where: { email: 'owner@orbit.test' } });
if (!state().sessionId) {
  // Task A's session, as the challenges' changeset names it: a session this runner hosts.
  const session = await db.session.create({ data: {
    id: toUuid('5vD9EcdOwXQIktLuv8GaOn'), ownerId: owner.id, workspaceId: toUuid(state().workspaceId),
    assignedRunnerId: toUuid(state().runnerId),
    title: 'Task: A · wiki 条目可信度：改正三条错条目，让修复提交触发对旧坑的复查', status: 'AWAITING_INPUT',
    prompt: 'Start the task “A · wiki 条目可信度：改正三条错条目，让修复提交触发对旧坑的复查”.', creatorId: owner.id,
  } });
  save({ sessionId: uuidToBase62(session.id) });
}
// The records the challenges cite, under their production ids.
const tasks = [
  { id: '34arC4nkg2GFimsK7UmyF', title: 'apiserver：Open 列表按数据版本短路 ETag，未变时不再序列化', status: 'DONE',
    description: fs.readFileSync(`${DATA}/task-34arC4nkg2GFimsK7UmyF.txt`, 'utf8') },
  { id: '34snwipJZpZ7fBMfDPhqH', title: 'A · wiki 条目可信度：改正三条错条目，让修复提交触发对旧坑的复查', status: 'OPEN',
    description: fs.readFileSync(`${DATA}/task-34snwipJZpZ7fBMfDPhqH.txt`, 'utf8') },
];
for (const t of tasks) {
  const id = toUuid(t.id);
  if (await db.task.findUnique({ where: { id } })) continue;
  await db.task.create({ data: { id, ownerId: owner.id, title: t.title, description: t.description, status: t.status,
    creatorType: 'AGENT', creatorId: owner.id, completionCriterion: 'EVIDENCE_JUDGMENT' } });
}
const sessionUuid = toUuid(state().sessionId);
if (!(await db.toolCall.findFirst({ where: { toolUseId: 'toolu_01R7D9vx6BsYBFBUJ1CnJbE9' } }))) {
  await db.toolCall.create({ data: { sessionId: sessionUuid, name: 'Bash', toolUseId: 'toolu_01R7D9vx6BsYBFBUJ1CnJbE9',
    input: evidence.input, output: evidence.output } });
}
if (!state().spaceId) {
  const space = await call('POST', '/wiki/spaces', { title: 'orbit', slug: 'orbit' });
  save({ spaceId: space.id });
  await call('POST', `/wiki/spaces/${space.id}/workspaces`, { workspaceId: state().workspaceId });
}
// The entries, as the owner's own adds (applied at once). Production's ids cannot be taken by an add, so the
// mapping from production id to this stack's id is kept in seed.json.
const ids = { ...(state().entryIds ?? {}) };
for (const e of prod) {
  if (ids[e.id]) continue;
  const anchors = (e.anchors ?? []).map((a) => (a.type === 'commit' ? { type: 'commit', sha: a.sha } : { type: a.type, path: a.path, ...(a.symbol ? { symbol: a.symbol } : {}) }));
  const answer = await call('POST', `/wiki/spaces/${state().spaceId}/changesets`, {
    rationale: `seed: ${e.title}`, idempotencyKey: `seed-${e.id}`,
    ops: [{ op: 'add', entry: { kind: e.kind, title: e.title, summary: e.summary, fields: e.fields, topics: e.topics, aliases: e.aliases, anchors } }],
  });
  const op = (answer.ops ?? [])[0];
  if (!op?.entryId) throw new Error(`add of ${e.id} did not apply: ${JSON.stringify(answer).slice(0, 800)}`);
  ids[e.id] = op.entryId;
  save({ entryIds: ids });
}
await db.$disconnect();
console.log(JSON.stringify({ ...state(), accessToken: undefined, refreshToken: undefined, runnerToken: undefined }, null, 1));
