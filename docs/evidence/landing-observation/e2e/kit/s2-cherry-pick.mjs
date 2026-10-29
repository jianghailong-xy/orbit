// Scenario 2 (contract §10.9 test 2, §10.8, project criterion 2): in an AGENT_PUSH project, the agent pushes a
// cherry-pick of its work (a different commit carrying the same change) and the task branch keeps the original.
// The observation does not see the delivered commit on main but `git cherry` says every change is there:
// LANDING_UNOBSERVED (APPLIED_AS_OTHER_COMMITS) for the coordinator, D held by J9 with the rewritten message.
// The coordinator (the fake engine, through the real orbit MCP server in its own session) then:
//   1. open_item_resolve on it          -> refused OPEN_ITEM_HAS_ITS_OWN_DOOR
//   2. integration_observe (with reason) -> queued, the item marked as handled, re-observed, still not seen, no 2nd item
//   3. merge_receipt naming the commit on main -> RESOLVED / LANDED, and D starts by itself (J10).
//   R2913_STACK=a node s2-cherry-pick.mjs
import { readFileSync } from 'node:fs';
import {
  SD, apiLogSince, attempt, call, evidence, execute, getTask, gitIn, logSize, logSince, login, mcpAnswer, origin, psql, readState,
  saveState, sendTurn, until, waitTask, wireSince,
} from './lib.mjs';
import { dumpProject } from './queries.mjs';

const ev = evidence('s2-cherry-pick');
const state = readState();
const T = await login();
const ws = state.workspaces.s2;
const TITLE = 'S2 AGENT_PUSH: the agent pushes a cherry-pick';
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const P = `(select id from project where title = '${TITLE}')`;

let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Show that work pushed as a different commit is put in front of the coordinator, and what its doors do.',
  instructions: 'R29-13 scenario 2. The fake engine pushes a cherry-pick of its work to the line; the coordinator is the fake engine too, driven by E2E-MCP lines.',
  acceptanceCriteriaItems: [{ text: 'The work is on main', verificationMethod: 'git cherry on the origin' }],
  coordinatorEnabled: true, maxConcurrentTasks: 2, workspaceId: ws.id,
});
await call('PATCH', `/projects/${p.id}/integration`, T, { line: 'MAIN', upstreamRef: 'refs/heads/main', deliveryMode: 'AGENT_PUSH' });
p = await call('GET', `/projects/${p.id}`, T);
const key = p.acceptanceCriteriaItems[0].key;
const taskBody = (title, directive, extra) => ({
  projectId: p.id, assigneeId: ws.id, title, criterionKey: key, description: `E2E-DO: ${directive}`,
  acceptanceCriteria: 'The run left its work file in the worktree.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  ...extra,
});
const C = await call('POST', '/tasks', T, taskBody('S2-C: push a cherry-pick of the work to main', 'push-cherry-pick', { autoRunWhenReady: false }));
const D = await call('POST', '/tasks', T, taskBody('S2-D: waits for S2-C to be on main', 'push-upstream', { dependsOnTaskIds: [C.id], autoRunWhenReady: true }));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'MAIN', upstreamRef: 'refs/heads/main', automatic: true,
  maxConcurrentTasks: 2, mergeCheckCommand: null, deliveryMode: 'AGENT_PUSH',
});
p = await call('GET', `/projects/${p.id}`, T);
const coord = p.coordinatorSessionId;
state.s2 = { projectId: p.id, title: TITLE, C: C.id, D: D.id, coordinatorSessionId: coord };
saveState(state);
ev.say(`project ${p.id} started (AGENT_PUSH, MAIN line main, Automatic), coordinator session ${coord}`);
await until('the coordinator session to be live', async () => {
  const s = await call('GET', `/sessions/${coord}`, T);
  return ['AWAITING_INPUT', 'RUNNING', 'IDLE'].includes(s.status) ? s : null;
}, { timeoutMs: 180_000 });

await execute(T, C.id);
const cDone = await waitTask(T, C.id, ['DONE', 'FAILED'], 'S2-C to finish');
check('S2-C is DONE', cDone.status === 'DONE');
const cSession = cDone.sessions?.[0];
const fakeRecs = logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cWork = fakeRecs.find((r) => r.kind === 'task-work' && r.task === C.id);
const picked = cWork?.pushCherryPick?.picked;
ev.say(`fake engine for S2-C: work ${cWork?.commit} on ${cWork?.taskBranch}; pushed cherry-pick ${picked} onto main (was ${cWork?.pushCherryPick?.lineTipBefore})`);
const mainNow = gitIn(origin('s2'), 'rev-parse', 'refs/heads/main');
check('origin main is the cherry-pick, not the task\'s commit', mainNow === picked && picked !== cWork?.commit, `main ${mainNow}`);

const frozen = await until('S2-C\'s delivered identity', async () => { const t = await getTask(T, C.id); return t.deliveredSha ? t : null; }, { timeoutMs: 240_000 });
check('delivered_sha = the task branch\'s commit (not the cherry-pick)', frozen.deliveredSha === cWork?.commit, frozen.deliveredSha);

// LANDING_UNOBSERVED for the coordinator.
const item = await until('LANDING_UNOBSERVED to open', async () => {
  const items = await call('GET', `/projects/${p.id}/open-items`, T);
  return [...(items.withCoordinator ?? []), ...(items.needsYou ?? [])].find((i) => i.kind === 'LANDING_UNOBSERVED') ?? null;
}, { timeoutMs: 300_000, everyMs: 3_000 });
ev.say(`open item ${item.itemId}: ${item.kind} "${item.title}" assignee ${item.assignee}`);
ev.file('item-opened.json', item);
const row = psql(`select assignee, dedupe_key, payload->>'reason' as reason, payload->>'deliveredSha' as delivered from project_open_item where project_id = ${P} and kind = 'LANDING_UNOBSERVED'`);
check('LANDING_UNOBSERVED reason APPLIED_AS_OTHER_COMMITS, assigned to the COORDINATOR', /COORDINATOR/.test(row) && /APPLIED_AS_OTHER_COMMITS/.test(row), row.split('\n')[2]?.trim());
check('its title names the branch and the task', item.title === `Not on main yet: ${C.title}`, item.title);

// J9 holds D, and says what it waits for.
const j9 = await attempt('POST', `/tasks/${D.id}/execute`, T, { triggerId: crypto.randomUUID() });
ev.say(`starting S2-D by hand while S2-C is unobserved: ${JSON.stringify(j9).slice(0, 600)}`);
const j9Text = JSON.stringify(j9.body ?? '');
check('J9 refuses S2-D and names "Not on main yet"', !j9.ok && j9Text.includes('is not on main yet') && j9Text.includes('Not on main yet'), j9Text.slice(0, 300));

// The coordinator's doors, through its own session's MCP server.
const ask = async (id, tool, args) => {
  await sendTurn(T, coord, `E2E-MCP ${id} ${tool} ${JSON.stringify(args)}`);
  const ans = await mcpAnswer(id);
  ev.say(`coordinator ${tool}: ${ans.isError ? 'ERROR ' : ''}${ans.text.slice(0, 700).replace(/\n/g, ' ')}`);
  return ans;
};
const resolveTry = await ask('s2-resolve', 'open_item_resolve', { projectId: p.id, itemId: item.itemId, note: 'Trying to close it by hand.' });
check('open_item_resolve refused OPEN_ITEM_HAS_ITS_OWN_DOOR', resolveTry.isError && resolveTry.text.includes('OPEN_ITEM_HAS_ITS_OWN_DOOR'));

const obsBefore = psql(`select count(*) from project_integration_job where project_id = ${P} and kind = 'OBSERVE_LANDING'`).split('\n')[2].trim();
const observe = await ask('s2-observe', 'integration_observe', { projectId: p.id, reason: 'The agent says it pushed; look at main again.' });
check('integration_observe queued an observation', !observe.isError && /"queued":\s*(true|false)/.test(observe.text), observe.text.match(/"jobId":\s*"[^"]+"/)?.[0]);
const handling = psql(`select handling_reason, handling_job_id is not null as has_job from project_open_item where project_id = ${P} and kind = 'LANDING_UNOBSERVED'`);
ev.say(`while it runs: ${handling.split('\n')[2]?.trim()}`);
check('the item records the handling (H1) with the reason', handling.includes('look at main again'));
await until('the re-observation to answer', () => {
  const n = psql(`select count(*) from project_integration_job where project_id = ${P} and kind = 'OBSERVE_LANDING' and state in ('OBSERVED','ERROR')`).split('\n')[2].trim();
  return Number(n) > Number(obsBefore) ? n : null;
}, { timeoutMs: 300_000, everyMs: 3_000 });
const afterObserve = psql(`select state, resolution, count(*) over () as items from project_open_item where project_id = ${P} and kind = 'LANDING_UNOBSERVED'`);
check('still not seen: the one item stays OPEN, no second item', /OPEN/.test(afterObserve) && /\|\s+1\s*$/m.test(afterObserve), afterObserve.split('\n')[2]?.trim());

// merge_receipt naming the commit on main.
const receipt = await ask('s2-receipt', 'merge_receipt', {
  sessionId: cSession.id, result: 'ALREADY_MERGED', sourceSha: picked, targetBranch: 'main',
  message: 'S2-C reached main as a cherry-pick; this is the commit on main that carries it.',
});
check('merge_receipt recorded', !receipt.isError, receipt.text.slice(0, 200).replace(/\n/g, ' '));
const resolved = await until('the item to be RESOLVED', () => {
  const r = psql(`select state, resolution, resolved_by from project_open_item where project_id = ${P} and kind = 'LANDING_UNOBSERVED'`);
  return /RESOLVED/.test(r) ? r : null;
}, { timeoutMs: 120_000 });
check('LANDING_UNOBSERVED RESOLVED / LANDED', /RESOLVED\s*\|\s*LANDED/.test(resolved), resolved.split('\n')[2]?.trim());
const dRun = await until('S2-D to start by itself', async () => {
  const t = await getTask(T, D.id);
  return t.sessions?.length ? t : null;
}, { timeoutMs: 240_000 });
check('S2-D started by itself (J10)', !!dRun.sessions?.length, `session ${dRun.sessions?.[0]?.id}`);
const dDone = await waitTask(T, D.id, ['DONE', 'FAILED'], 'S2-D to finish');
check('S2-D is DONE', dDone.status === 'DONE');

dumpProject(ev, TITLE, 'S2 final');
ev.file('api-final.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T),
  tasks: { C: await getTask(T, C.id), D: await getTask(T, D.id) },
  openItems: await call('GET', `/projects/${p.id}/open-items`, T),
  receipts: { C: await call('GET', `/sessions/${cSession.id}/merge-receipts`, T) }, j9,
});
ev.file('origin-s2.txt', gitIn(origin('s2'), 'log', '--format=%H %P %s%n%b', '--all') + '\n\n'
  + gitIn(origin('s2'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') + '\n');
ev.file('runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev.file('runner-wire.jsonl', wireSince(marks.wire, (r) => r.kind !== 'heartbeat' || r.integrationJobs).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev.file('apiserver.log', apiLogSince(marks.api));
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `SCENARIO 2: ${failed.length} check(s) FAILED` : `SCENARIO 2: all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
void readFileSync;
