// Scenario 4, phase A — BEFORE the deploy (stack b: the 0.1.239 apiserver at 18dfe8f1c and the 0.1.239 release
// runner). Production's 10-28 shape, made by that code itself rather than written into the database: a MAIN-line
// project whose upstream is a feature branch, agents that commit in their worktree and push HEAD to the feature
// branch (their task branches are never published), PLATFORM by default (that server has no delivery mode).
//   T1, T2, T6  -> TASK_BRANCH candidates whose checks answer ERROR / SOURCE_BRANCH_MISSING -> BLOCKED
//   T3          -> its agent records its own receipt (merge_receipt): the project's only receipt; its candidate is
//                  BLOCKED the same way, and T6 (depends on T3) can start
//   T4          -> its agent also published the task branch, so its check answers ALREADY_LANDED -> BLOCKED too
//   T5          -> depends on T1 and T2: J9 refuses it although their commits are on the feature branch
// The coordinator then closes its INTEGRATION_ERROR items as handled, as 10-28's coordinator did. No name or id of
// the external project is used anywhere: the branch is feature/release-2 and every title is made up.
//   R2913_STACK=b node s4a-old-world.mjs
import {
  SD, apiLogSince, attempt, call, evidence, execute, getTask, gitIn, logSize, logSince, login, mcpAnswer, origin, psql,
  readState, saveState, sendTurn, until, uuid, waitTask, wireSince,
} from './lib.mjs';
import { dumpProject } from './queries.mjs';

const ev = evidence('s4-backfill');
const state = readState();
const T = await login();
const ws = state.workspaces.s4;
const TITLE = 'S4 MAIN line: agents push to feature/release-2';
const LINE = 'feature/release-2';
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ phase: 'A', name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} [A] ${name}${detail ? ` — ${detail}` : ''}`); };
const P = `(select id from project where title = '${TITLE}')`;
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };

ev.say(`phase A (before the deploy): apiserver ${state.server ?? 'old'} 18dfe8f1c, runner ${state.runner.binary} ${state.runner.version}`);
let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Ship release 2 on its feature branch.',
  instructions: `Work only on ${LINE}. Commit and push to ${LINE} when each piece is done.`,
  acceptanceCriteriaItems: [{ text: 'Release 2 is on its feature branch', verificationMethod: 'git log on the feature branch' }],
  coordinatorEnabled: true, maxConcurrentTasks: 2, workspaceId: ws.id,
});
await call('PATCH', `/projects/${p.id}/integration`, T, { line: 'MAIN', upstreamRef: `refs/heads/${LINE}`, mergeCheckCommand: 'test -f README.md' });
p = await call('GET', `/projects/${p.id}`, T);
const key = p.acceptanceCriteriaItems[0].key;
const body = (title, directives, extra = {}) => ({
  projectId: p.id, assigneeId: ws.id, title, criterionKey: key,
  description: `E2E-UPSTREAM: origin/${LINE}\nE2E-DO: ${directives}`,
  acceptanceCriteria: 'The run left its work file in the worktree.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  autoRunWhenReady: false, ...extra,
});
const t = {};
t.T1 = await call('POST', '/tasks', T, body('S4-T1: the API endpoint', 'push-upstream'));
t.T2 = await call('POST', '/tasks', T, body('S4-T2: the storage layer', 'push-upstream'));
t.T3 = await call('POST', '/tasks', T, body('S4-T3: the settings page (records its own receipt)', 'push-upstream merge-receipt'));
t.T4 = await call('POST', '/tasks', T, body('S4-T4: the migration (also publishes its branch)', 'push-upstream push-task-branch'));
t.T5 = await call('POST', '/tasks', T, body('S4-T5: the release notes (needs T1 and T2)', 'push-upstream', { dependsOnTaskIds: [t.T1.id, t.T2.id], autoRunWhenReady: true }));
t.T6 = await call('POST', '/tasks', T, body('S4-T6: the settings tests (needs T3)', 'push-upstream', { dependsOnTaskIds: [t.T3.id], autoRunWhenReady: true }));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'MAIN', upstreamRef: `refs/heads/${LINE}`, automatic: true,
  maxConcurrentTasks: 2, mergeCheckCommand: 'test -f README.md',
});
p = await call('GET', `/projects/${p.id}`, T);
state.s4 = { projectId: p.id, title: TITLE, line: LINE, coordinatorSessionId: p.coordinatorSessionId, tasks: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { id: v.id, title: v.title }])) };
saveState(state);
ev.say(`project ${p.id} started: MAIN line on ${LINE}, Automatic, coordinator ${p.coordinatorSessionId}`);

for (const k of ['T1', 'T2', 'T3', 'T4']) {
  await execute(T, t[k].id);
  const done = await waitTask(T, t[k].id, ['DONE', 'FAILED'], `${k} to finish`);
  check(`${k} is DONE`, done.status === 'DONE');
}
const fake = logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'task-work');
for (const r of fake) ev.say(`fake engine: task ${r.task} committed ${r.commit} on ${r.taskBranch}${r.rebasedOnto ? ` (rebased onto ${r.rebasedOnto.slice(0, 10)})` : ''}; pushed to ${r.remote}/${r.branch}${r.pushTaskBranch ? '; published its task branch' : ''}${r.mergeReceipt ? `; merge_receipt ${r.mergeReceipt.isError ? 'ERROR' : 'ok'}` : ''}`);
const t6 = await until('T6 to start by itself (T3 has a receipt)', async () => { const x = await getTask(T, t.T6.id); return x.sessions?.length ? x : null; }, { timeoutMs: 300_000 });
check('T6 started by itself after T3\'s own receipt', !!t6.sessions?.length);
await waitTask(T, t.T6.id, ['DONE', 'FAILED'], 'T6 to finish');

const candidates = await until('five candidates to be BLOCKED', () => {
  const n = row(`select count(*) from project_promotion where project_id = ${P} and state = 'BLOCKED'`);
  return Number(n) >= 5 ? n : null;
}, { timeoutMs: 600_000, everyMs: 5_000 });
check('five TASK_BRANCH candidates BLOCKED', candidates === '5');
const reasons = psql(`select t.title, p.state, p.blocked_reason, j.state as check_state, j.error_code from project_promotion p join task t on t.id = p.task_id left join project_integration_job j on j.id = p.check_job_id where p.project_id = ${P} order by t.title`);
ev.say(`candidates:\n${reasons}`);
check('four answered SOURCE_BRANCH_MISSING, one ALREADY_LANDED', (reasons.match(/SOURCE_BRANCH_MISSING/g) ?? []).length === 4 && /BLOCKED\s*\|\s*ALREADY_LANDED/.test(reasons));
const receipts = row(`select count(*) from session_merge_receipt where project_id = ${P}`);
check('the project has exactly one receipt (T3\'s agent\'s)', receipts === '1', receipts);
const onLine = Object.values(t).filter((x) => x !== t.T5).map((x) => fake.find((r) => r.task === x.id)?.commit).filter(Boolean)
  .every((sha) => { try { gitIn(origin('s4'), 'merge-base', '--is-ancestor', sha, `refs/heads/${LINE}`); return true; } catch { return false; } });
check(`every DONE task's commit is on ${LINE}`, onLine);
const j9 = await attempt('POST', `/tasks/${t.T5.id}/execute`, T, { triggerId: uuid() });
ev.say(`starting T5 by hand: ${JSON.stringify(j9).slice(0, 500)}`);
check('J9 refuses T5 although T1 and T2 are on the line', !j9.ok && JSON.stringify(j9.body).includes('has not landed'), JSON.stringify(j9.body).slice(0, 240));

// The coordinator closes its INTEGRATION_ERROR items as handled (10-28: six of them).
const items = await call('GET', `/projects/${p.id}/open-items`, T);
const errors = [...(items.withCoordinator ?? []), ...(items.needsYou ?? [])].filter((i) => i.kind === 'INTEGRATION_ERROR');
ev.say(`open items before: ${[...(items.withCoordinator ?? []), ...(items.needsYou ?? [])].map((i) => `${i.kind}/${i.assignee}`).join(', ')}`);
let n = 0;
for (const item of errors) {
  const id = `s4a-handled-${++n}`;
  await sendTurn(T, p.coordinatorSessionId, `E2E-MCP ${id} open_item_resolve ${JSON.stringify({ projectId: p.id, itemId: item.itemId, note: `Handled: the code is already on ${LINE}.` })}`);
  const ans = await mcpAnswer(id);
  ev.say(`coordinator open_item_resolve ${item.itemId}: ${ans.isError ? 'ERROR ' : ''}${ans.text.slice(0, 160).replace(/\n/g, ' ')}`);
}
check('the coordinator closed its INTEGRATION_ERROR items as HANDLED', errors.length > 0
  && row(`select count(*) from project_open_item where project_id = ${P} and kind = 'INTEGRATION_ERROR' and resolution = 'HANDLED'`) === String(errors.length), `${errors.length} items`);
const t5 = await getTask(T, t.T5.id);
check('T5 is still waiting', t5.status === 'OPEN' && !t5.sessions?.length, `${t5.status}`);

dumpProject(ev, TITLE, 'S4 phase A (0.1.239, before the deploy)', { old: true });
ev.file('a-api.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T),
  tasks: Object.fromEntries(await Promise.all(Object.entries(t).map(async ([k, v]) => [k, await getTask(T, v.id)]))),
  openItems: await call('GET', `/projects/${p.id}/open-items`, T), j9,
});
ev.file('a-origin-s4.txt', gitIn(origin('s4'), 'log', '--format=%H %P %s', '--all') + '\n\n'
  + gitIn(origin('s4'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') + '\n');
ev.file('a-runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev.file('a-runner-wire.jsonl', wireSince(marks.wire, (r) => r.kind !== 'heartbeat' || r.integrationJobs).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('a-fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev.file('a-apiserver.log', apiLogSince(marks.api));
ev.file('a-checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `SCENARIO 4 phase A: ${failed.length} check(s) FAILED` : `SCENARIO 4 phase A: all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
