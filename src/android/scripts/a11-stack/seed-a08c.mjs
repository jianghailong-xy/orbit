// A08c: the two cards the Android A08c journeys answer on the stack's own server, filed through the runner's doors the way its
// MCP tools file them (src/runner-go/mcp.go), from the main project's coordinator session with the stack runner's token:
//   batch: `orbit_task_batch` — the tasks and the server's own preview of them (POST /runner/tasks/batch-preview), as
//          `askBeforeBatch` files it. One task first and two that wait on it: two levels, the second two in parallel.
//   merge: `orbit_project_update_integration` — the project as the runner reads it, what its merge check is now and what it
//          would become, as `projectMergeCheckCard` files it.
// Both are read the way a runner-hosted CLI reads its card (`askBeforeCreate` with ORBIT_BG_JOB_ID): they name a background
// job, and the runner reports that job running in the session's event stream, so the server keeps them answerable while no turn
// is in flight (sessions/abandoned-approvals.ts, `readByLiveBackgroundJob`) — the stack's engine never holds a turn open. A runner
// report carries the session's lease generation, which no API returns: the caller reads it from the stack's own database and
// passes A08C_LEASE_OWNER. Ids go to seed.json under `a08c`; finish-a08c.mjs plays the runner's part after the owner answers and
// ends the job. HTTP only, loopback only.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { S, call, login, readSeed, seedFile } from './lib.mjs';

const seed = readSeed();
const runner = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8')).runnerToken;
const main = seed.projects.main;
const session = main.coordinatorSessionId;
const ws = seed.workspace.id;
const stamp = Date.now().toString(36);
const lease = process.env.A08C_LEASE_OWNER || undefined;
const owner = await login('owner');
const nextSeq = async () => Math.max(0, ...(await call('GET', `/sessions/${session}/events/page?tail=1`, owner)).events.map((e) => e.seq)) + 1;
const job = `bgj_${randomBytes(6).toString('hex')}`;
const command = 'orbit task create-batch … && orbit project update … (A08c stack check)';
await call('POST', `/runner/sessions/${session}/events`, runner, { leaseOwner: lease, events: [{ seq: await nextSeq(), type: 'background_task',
  ts: new Date().toISOString(), payload: { shellId: job, toolUseId: job, status: 'running', kind: 'job', command, outputPath: '', idleMs: 0 } }] });
const item = (ref, title, after) => ({
  ref, title: `A08c ${title} (${stamp})`, description: `Batch-create card check on the isolated stack (${stamp}).`,
  projectId: main.id, assigneeId: ws, completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: `${title}: its check passes.`,
  ...(after.length ? { dependsOnRefs: after } : {}),
});
const tasks = [item('rule', 'shared reminder rule', []), item('web', 'web reminders', ['rule']), item('ios', 'iOS reminders', ['rule'])];
const preview = await call('POST', '/runner/tasks/batch-preview', runner, { tasks }, { 'x-orbit-agent-id': ws, 'x-orbit-session-id': session });
const batch = await call('POST', `/runner/sessions/${session}/approvals`, runner,
  { toolName: 'orbit_task_batch', input: { tasks, preview }, toolUseId: `a08c-batch-${stamp}`, backgroundJobId: job });

const project = await call('GET', `/runner/projects/${main.id}`, runner);
const proposed = `test -f README.md && test -f A08C-${stamp}.md`;
const input = {
  projectId: main.id, projectTitle: project.title,
  currentMergeCheckCommand: project.integration?.mergeCheckCommand ?? null,
  currentMergeCheckTimeoutSeconds: project.integration?.mergeCheckTimeoutSeconds ?? null,
  mergeCheckCommand: proposed,
};
const merge = await call('POST', `/runner/sessions/${session}/approvals`, runner,
  { toolName: 'orbit_project_update_integration', input, toolUseId: `a08c-merge-${stamp}`, backgroundJobId: job });
// What the owner's app reads: the cards the server says are still being asked.
const asked = (await call('GET', `/sessions/${session}/approvals?status=PENDING`, owner)).map((a) => a.id);

seed.a08c = {
  sessionId: session, projectId: main.id, projectTitle: project.title, stamp, job: { id: job, command },
  batch: { approvalId: batch.id, status: batch.status, tasks, preview },
  merge: { approvalId: merge.id, status: merge.status, input },
  how: 'POST /runner/tasks/batch-preview, then POST /runner/sessions/:id/approvals (orbit_task_batch); GET /runner/projects/:id, then POST /runner/sessions/:id/approvals (orbit_project_update_integration); runner token',
};
writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');
console.log(JSON.stringify({ session, job, batch: batch.id, taskCount: preview.taskCount, merge: merge.id, from: input.currentMergeCheckCommand, to: proposed,
  pendingAsked: asked }));
