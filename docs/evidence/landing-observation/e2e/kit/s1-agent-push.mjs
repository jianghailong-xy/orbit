// Scenario 1 (contract §10.9 test 1, project criterion 1): an AGENT_PUSH project on a MAIN line. Task A's run (the
// fake engine) commits in its worktree and `git push origin HEAD:main`, as the brief's O-L3 sentence tells it; the
// task branch is never pushed. A turns DONE -> its delivered identity is frozen -> OBSERVE_LANDING (O-T1) -> the
// runner observes the commit on main -> a receipt (ALREADY_MERGED, detail.observed) -> J9 lets B through and J10
// starts it, with no receipt, retry or open item written by anyone.
//   R2913_STACK=a node s1-agent-push.mjs
import {
  SD, apiLogSince, call, evidence, execute, getTask, gitIn, logSize, logSince, login, origin, psql, readState, saveState, until,
  waitTask, wireSince,
} from './lib.mjs';
import { readFileSync } from 'node:fs';
import { dumpProject } from './queries.mjs';

const ev = evidence('s1-agent-push');
const state = readState();
const T = await login();
const ws = state.workspaces.s1;
const TITLE = 'S1 AGENT_PUSH: the agent pushes to main';
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

ev.say(`stack ${process.env.R2913_STACK}: apiserver ${readFileSafe(`${SD}/api.server`)} / runner ${readFileSafe(`${SD}/runner.bin`)}`);
let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Show that work an agent pushes straight to main is seen there and lets its dependents start.',
  instructions: 'R29-13 scenario 1. The fake engine follows the brief: it pushes HEAD to the line and never pushes its task branch.',
  acceptanceCriteriaItems: [{ text: 'The work is on main', verificationMethod: 'git merge-base --is-ancestor on the origin' }],
  coordinatorEnabled: true, maxConcurrentTasks: 2, workspaceId: ws.id,
});
await call('PATCH', `/projects/${p.id}/integration`, T, { line: 'MAIN', upstreamRef: 'refs/heads/main', deliveryMode: 'AGENT_PUSH' });
p = await call('GET', `/projects/${p.id}`, T);
const key = p.acceptanceCriteriaItems[0].key;
const taskBody = (title, extra) => ({
  projectId: p.id, assigneeId: ws.id, title, criterionKey: key,
  description: 'E2E-DO: push-upstream',
  acceptanceCriteria: 'E2E_WORK.md exists in the run\'s worktree when the run ends.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f E2E_WORK.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  ...extra,
});
const A = await call('POST', '/tasks', T, taskBody('S1-A: write the work and push it to main', { autoRunWhenReady: false }));
const B = await call('POST', '/tasks', T, taskBody('S1-B: starts by itself once S1-A is seen on main', { dependsOnTaskIds: [A.id], autoRunWhenReady: true }));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'MAIN', upstreamRef: 'refs/heads/main', automatic: true,
  maxConcurrentTasks: 2, mergeCheckCommand: null, deliveryMode: 'AGENT_PUSH',
});
p = await call('GET', `/projects/${p.id}`, T);
state.s1 = { projectId: p.id, title: TITLE, A: A.id, B: B.id, coordinatorSessionId: p.coordinatorSessionId };
saveState(state);
ev.say(`project ${p.id} started: line ${p.integration.line}, upstream ${p.integration.upstreamRef}, deliveryMode ${p.integration.deliveryMode}, coordinator ${p.coordinatorSessionId}`);
check('delivery mode reads AGENT_PUSH on project_get', p.integration.deliveryMode === 'AGENT_PUSH', `deliveryModeChosenAt ${p.integration.deliveryModeChosenAt}`);

const mainBefore = gitIn(origin('s1'), 'rev-parse', 'refs/heads/main');
await execute(T, A.id);
ev.say(`S1-A ${A.id} executed; origin main was ${mainBefore}`);
const aDone = await waitTask(T, A.id, ['DONE', 'FAILED'], 'S1-A to finish');
check('S1-A is DONE', aDone.status === 'DONE');
const aSession = aDone.sessions?.[0];
ev.say(`S1-A ${aDone.status}; session ${aSession?.id}; task integration ${JSON.stringify(aDone.integration?.state)}`);

// The fake engine's own record of what it pushed.
const fakeRecs = logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const aWork = fakeRecs.find((r) => r.kind === 'task-work' && r.task === A.id);
ev.say(`fake engine for S1-A: committed ${aWork?.commit} on ${aWork?.taskBranch}, pushed to ${aWork?.remote}/${aWork?.branch} (target from ${aWork?.pushTargetFrom})`);
check('the brief named the push target (O-L3 sentence)', aWork?.pushTargetFrom === 'brief (O-L3)', `${aWork?.remote}/${aWork?.branch}`);
const mainAfterA = gitIn(origin('s1'), 'rev-parse', 'refs/heads/main');
check('origin main is the agent\'s commit', mainAfterA === aWork?.commit, mainAfterA);
const branchesOnOrigin = gitIn(origin('s1'), 'for-each-ref', '--format=%(refname)', 'refs/heads');
check('the task branch was never pushed', !branchesOnOrigin.includes('orbit/task'), branchesOnOrigin.replace(/\n/g, ', '));

// Identity frozen, observation, receipt.
const frozen = await until('S1-A\'s delivered identity', async () => {
  const t = await getTask(T, A.id);
  return t.deliveredSha ? t : null;
}, { timeoutMs: 240_000 });
check('delivered_sha frozen = the pushed commit', frozen.deliveredSha === aWork?.commit, `${frozen.deliveredSha} on ${frozen.deliveredBranch} at ${frozen.deliveredAt}`);
const obsRow = await until('an OBSERVE_LANDING for the project to answer', () => {
  const out = psql(`select state from project_integration_job where kind = 'OBSERVE_LANDING' and project_id = (select id from project where title = '${TITLE}') and state = 'OBSERVED'`);
  return out.includes('OBSERVED') ? out : null;
}, { timeoutMs: 300_000, everyMs: 3_000 });
ev.say('an OBSERVE_LANDING answered OBSERVED');
const receipts = await until('S1-A\'s receipt', async () => {
  const r = await call('GET', `/sessions/${aSession.id}/merge-receipts`, T);
  const list = Array.isArray(r) ? r : (r.receipts ?? r.items ?? []);
  return list.length ? list : null;
}, { timeoutMs: 120_000 });
const rA = receipts[0];
ev.say(`S1-A receipt: ${JSON.stringify(rA)}`);
check('receipt ALREADY_MERGED on main, recorded by the RUNNER, detail.observed', rA.result === 'ALREADY_MERGED' && rA.targetBranch === 'main'
  && rA.recordedBy === 'RUNNER' && rA.detail?.observed === true && rA.sourceSha === aWork?.commit, `source ${rA.sourceSha}`);

// J10: B starts by itself.
const bRun = await until('S1-B to start by itself', async () => {
  const t = await getTask(T, B.id);
  return t.sessions?.length || ['IN_PROGRESS', 'DONE'].includes(t.status) ? t : null;
}, { timeoutMs: 240_000 });
ev.say(`S1-B started by itself: status ${bRun.status}, session ${bRun.sessions?.[0]?.id} created ${bRun.sessions?.[0]?.createdAt}`);
check('S1-B was started without a person (J10)', !!bRun.sessions?.length);
const bDone = await waitTask(T, B.id, ['DONE', 'FAILED'], 'S1-B to finish');
check('S1-B is DONE', bDone.status === 'DONE');
await until('S1-B to be observed on main', async () => (await getTask(T, B.id)).integration?.state === 'ON_UPSTREAM', { timeoutMs: 300_000, everyMs: 3_000 }).catch(() => null);

// Nobody wrote anything by hand.
const items = await call('GET', `/projects/${p.id}/open-items`, T);
const openCount = (items.needsYou?.length ?? 0) + (items.withCoordinator?.length ?? 0);
check('no open item (needs-you or with the coordinator)', openCount === 0, JSON.stringify({ needsYou: items.needsYou?.length, withCoordinator: items.withCoordinator?.length }));
const manual = psql(`select count(*) from session_merge_receipt where project_id = (select id from project where title = '${TITLE}') and recorded_by <> 'RUNNER'`);
check('every receipt was recorded by the runner (no manual receipt)', /\n\s+0\n/.test(manual), manual.split('\n')[2]?.trim());
const retries = psql(`select count(*) from project_integration_job where project_id = (select id from project where title = '${TITLE}') and (retry_of_job_id is not null or retry_reason is not null)`);
check('no retried job', /\n\s+0\n/.test(retries), retries.split('\n')[2]?.trim());
const candidates = psql(`select count(*) from project_promotion where project_id = (select id from project where title = '${TITLE}')`);
check('AGENT_PUSH built no promotion candidate (O-L2)', /\n\s+0\n/.test(candidates), candidates.split('\n')[2]?.trim());

// Evidence: rows, API reads, logs.
dumpProject(ev, TITLE, 'S1 final');
ev.file('api-final.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T),
  tasks: { A: await getTask(T, A.id), B: await getTask(T, B.id) }, openItems: items,
  receipts: { A: receipts, B: await call('GET', `/sessions/${bDone.sessions?.[0]?.id}/merge-receipts`, T) },
  started,
});
ev.file('origin-s1.txt', gitIn(origin('s1'), 'log', '--format=%H %P %s', '--all') + '\n\n' + branchesOnOrigin + '\n');
ev.file('runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev.file('runner-wire.jsonl', wireSince(marks.wire, (r) => r.kind !== 'heartbeat' || r.integrationJobs).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev.file('apiserver.log', apiLogSince(marks.api));
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `SCENARIO 1: ${failed.length} check(s) FAILED` : `SCENARIO 1: all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return '?'; }
}
