// A11c: a landing whose runner stopped reporting, for the landing row's jobs and their Retry (`setup.sh stuck`, on its own:
// about 15 minutes, and it leaves the stack runner STOPPED until `setup.sh unstick`).
// A started project on its own branch whose merge check takes a minute and a half; its one task runs for real on the stack
// runner and is DONE; while its landing is in that check the runner is sent SIGSTOP — it keeps the claim and stops
// heartbeating — and this waits until the server's integration view calls the job timed out and retryable: the claim lease
// (INTEGRATION_CLAIM_STALE_MS, 10 min) plus the check's own timeout of silence. A Retry pressed while the runner is stopped
// queues the task's next landing generation, which waits for the runner (SIGCONT).
// HTTP only (lib.mjs) but for the one signal; ids go to seed.json under projects.landingStuck.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { API, S, call, login, readSeed, seedFile } from './lib.mjs';

const seed = readSeed();
const T = await login('owner');
const ws = seed.workspace.id;
const save = () => writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, { timeoutMs, everyMs }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

const BRANCH = 'refs/heads/project/a11c-landing-stuck';
const CHECK = 'sleep 90; test -f README.md';
const project = await call('POST', '/projects', T, {
  title: 'A11c Landing that stopped reporting', goal: 'Land the sprint notes on the project branch.',
  instructions: 'A11c Retry check: its landing\'s runner is stopped mid-check on purpose.',
  acceptanceCriteriaItems: [{ text: 'The sprint notes are on the project branch', verificationMethod: 'test -f A11_STACK_NOTES.md on the branch' }],
  // The workspace is where the project's repository is read from (a project branch needs one); the manual start below
  // turns the coordinator it opens off again.
  maxConcurrentTasks: 1, workspaceId: ws,
});
await call('PATCH', `/projects/${project.id}/integration`, T, {
  line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  mergeCheckCommand: CHECK, mergeCheckTimeoutSeconds: 120, exceptionEscalationSeconds: 3600,
});
const key = (await call('GET', `/projects/${project.id}`, T)).acceptanceCriteriaItems[0].key;
const task = await call('POST', '/tasks', T, {
  projectId: project.id, assigneeId: ws, title: 'Write the landing notes', description: 'Appends to A11_STACK_NOTES.md (the fake engine does).',
  criterionKey: key, autoRunWhenReady: false, acceptanceCriteria: 'A11_STACK_NOTES.md exists in the run\'s worktree when the run ends.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f A11_STACK_NOTES.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
});
const digest = (await call('GET', `/projects/${project.id}/acceptance/confirmation`, T)).currentVersion.digest;
await call('POST', `/projects/${project.id}/start`, T, {
  criteriaDigest: digest, line: 'PROJECT_BRANCH', projectBranchName: BRANCH, automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: CHECK,
});
await call('POST', `/tasks/${task.id}/execute`, T, { triggerId: randomUUID() });
await until('the task to be DONE', async () => (await call('GET', `/tasks/${task.id}`, T)).status === 'DONE', { timeoutMs: 180_000, everyMs: 2_000 });
const jobs = async () => (await call('GET', `/projects/${project.id}/integration`, T)).inFlightJobs ?? [];
const checking = await until('its landing to reach the merge check', async () =>
  (await jobs()).find((j) => j.kind === 'LAND_TASK' && j.state === 'RUNNING' && j.phase === 'CHECK'), { timeoutMs: 300_000, everyMs: 1_000 });
const runner = Number(readFileSync(`${S}/runner.pid`, 'utf8').trim());
process.kill(runner, 'SIGSTOP');
console.log(`· runner ${runner} stopped while job ${checking.jobId} is in its check`);
seed.projects.landingStuck = { id: project.id, title: project.title, taskId: task.id, jobId: checking.jobId, runnerStopped: runner, timedOut: false };
save();
const stuck = await until('the server to call the landing timed out', async () =>
  (await jobs()).find((j) => j.jobId === checking.jobId && j.timedOut && j.retryable), { timeoutMs: 25 * 60_000, everyMs: 15_000 });
seed.projects.landingStuck = {
  id: project.id, title: project.title, taskId: task.id, jobId: stuck.jobId, generation: stuck.generation, limitSeconds: stuck.limitSeconds,
  phase: stuck.phase, runnerStopped: runner,
  how: 'PROJECT_BRANCH line with a 90 s merge check; the task ran DONE on the stack runner; SIGSTOP to the runner during CHECK; waited for timedOut+retryable',
};
save();
console.log(JSON.stringify({ api: API, landingStuck: seed.projects.landingStuck }, null, 1));
