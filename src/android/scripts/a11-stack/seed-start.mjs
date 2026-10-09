// A11b: two projects nobody has started, for the start card on the stack's own server (run after seed.mjs; setup.sh seed
// runs it). Both carry the start card mock's plan — A; B and C; D after B; E, the go-live the owner confirms, after C and D —
// with every task on the stack workspace and serving a criterion, so Orbit's ready check passes.
//   startAsked: created coordinated on the stack workspace (POST /projects/:id/coordinator hands that coordinator back),
//               which files the start request the way its `project_request_start` MCP tool does — the stack runner's token
//               and that coordinator session (POST /runner/projects/:id/start-requests) — suggesting Automatic off, which
//               the card's note says.
//   startOwn:   nobody coordinates it; the owner's own Start… opens its first coordinator where its tasks run (Automatic on).
// HTTP only, loopback only (lib.mjs); ids are added to seed.json under projects.startAsked / projects.startOwn.
import { readFileSync, writeFileSync } from 'node:fs';
import { API, S, call, HttpError, login, readSeed, seedFile } from './lib.mjs';

const seed = readSeed();
const T = await login('owner');
const ws = seed.workspace.id;
const runnerToken = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8')).runnerToken;
const save = () => writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');

const CRITERIA = [
  { text: 'Reminders follow one rule on every client', verificationMethod: 'The shared rule fixture passes on web, iOS and Android' },
  { text: 'The go-live is confirmed by the owner', verificationMethod: 'The owner confirms the go-live task' },
];
// [label, title, settled by, waits on, serves criterion]
const PLAN = [
  ['A', 'A · 提醒规则做成两端共用的真源', 'EVIDENCE_JUDGMENT', [], 0],
  ['B', 'B · OrbitKit：提醒规则、文案、DTO 与接口', 'EVIDENCE_JUDGMENT', ['A'], 0],
  ['C', 'C · web：Runners 列表与 runner 详情页', 'EVIDENCE_JUDGMENT', ['A'], 0],
  ['D', 'D · iOS/macOS：Runners 列表、Add Runner、Edit', 'EVIDENCE_JUDGMENT', ['B'], 0],
  ['E', 'E · 上线', 'OWNER_CONFIRMED', ['C', 'D'], 1],
];

// `workspaceId` on the create opens the project's coordinator there (main's dto.ts); without it nobody coordinates the
// project until something opens one where its tasks run.
async function planned(title, coordinated) {
  const project = await call('POST', '/projects', T, {
    title, goal: 'Reminders that behave the same on every client, live for the owner\'s testers.',
    instructions: 'A11b start card check on the isolated stack: not started on purpose.',
    acceptanceCriteriaItems: CRITERIA, maxConcurrentTasks: 2, ...(coordinated ? { workspaceId: ws } : {}),
  });
  const doc = await call('GET', `/projects/${project.id}`, T);
  const ids = {};
  for (const [label, task, settledBy, after, serves] of PLAN) {
    ids[label] = (await call('POST', '/tasks', T, {
      projectId: project.id, assigneeId: ws, title: task, description: `Plan task ${label} of the A11b start card check.`,
      criterionKey: doc.acceptanceCriteriaItems[serves].key, dependsOnTaskIds: after.map((a) => ids[a]), autoRunWhenReady: true,
      completionCriterion: settledBy, ...(settledBy === 'OWNER_CONFIRMED' ? { ownerConfirmationReason: 'OWNER_TRADE_OFF' } : {}),
    })).id;
  }
  return { id: project.id, title: project.title, tasks: ids };
}

const asked = await planned('A11b Reminders everywhere (asked)', true);
const coordinator = await call('POST', `/projects/${asked.id}/coordinator`, T, { workspaceId: ws });
const why = 'B and C both build on A, and the go-live waits for both clients: one project branch checks them together before main.';
let request;
try {
  request = await call('POST', `/runner/projects/${asked.id}/start-requests`, runnerToken, {
    line: 'PROJECT_BRANCH', maxConcurrentTasks: 3, mergeCheckCommand: 'test -f README.md', automatic: false, why,
  }, { 'x-orbit-session-id': coordinator.sessionId });
} catch (e) {
  // A project branch needs a repository the ready check can name; main with no merge check never does.
  if (!(e instanceof HttpError && e.status === 409)) throw e;
  console.log('✗ project branch refused:', e.body.slice(0, 400));
  request = await call('POST', `/runner/projects/${asked.id}/start-requests`, runnerToken, {
    line: 'MAIN', maxConcurrentTasks: 3, mergeCheckCommand: null, automatic: false, why,
  }, { 'x-orbit-session-id': coordinator.sessionId });
}
seed.projects.startAsked = { ...asked, coordinatorSessionId: coordinator.sessionId,
  request: { itemId: request.itemId, state: request.state, settings: request.settings, warningsReturnedToCoordinator: (request.warnings ?? []).map((w) => w.code) },
  how: 'POST /projects/:id/coordinator, then POST /runner/projects/:id/start-requests (runner token + X-Orbit-Session-Id)' };
const own = await planned('A11b Reminders everywhere (own)', false);
seed.projects.startOwn = { ...own, coordinatorSessionId: (await call('GET', `/projects/${own.id}`, T)).coordinatorSessionId ?? null };
save();
console.log(JSON.stringify({ api: API, startAsked: seed.projects.startAsked.request, startOwn: own.id }, null, 1));
