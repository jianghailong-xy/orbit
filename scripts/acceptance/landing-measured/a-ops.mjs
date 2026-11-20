// Project A (contract §12.15 P-M1, P-M2): an operations-shaped project. A workspace bound to a repository (worktrees on,
// so every run gets a branch and looks like a "code task" to the old rules), a start request from its coordinator with
// no line, and six tasks in three dependency layers whose runs execute commands and commit nothing:
//
//   layer 1   A1-disk          A2-inventory
//               |      \          |
//   layer 2   B1-log    B2-status  (B2 needs A1 and A2)
//               \        /    \
//   layer 3     C1-summary     C2-uname   (C1 needs B1 and B2, C2 needs B2)
//
// Expect: the project runs to done, project_integration_job has zero rows for it, no project_codebase row, and each
// dependent starts on its prerequisites' DONE (no landing in between to wait for).
//   node a-ops.mjs
import { dumpProject, P as projectBy } from './queries.mjs';
import {
  SD, call, evidence, getTask, logSince, logSize, login, mcpAnswer, psql, readState, saveState, sendTurn, sleep, until,
} from './lib.mjs';

const ev = evidence('a-ops');
const state = readState();
const T = await login();
const ws = state.workspaces['lm-ops'];
const RUN = process.env.LM_RUN || new Date().toISOString().replace(/\D/g, '').slice(4, 14);
const TITLE = `LM42-A operations: six tasks in three layers, nothing committed (${RUN})`;
const OUT = `${SD}/ops-out`;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const P = projectBy(TITLE);
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const fakeMark = logSize(`${SD}/logs/fake-claude.jsonl`);

ev.say(`run ${RUN}: project "${TITLE}" in workspace ${ws.id} (${ws.workDir}, origin ${ws.repoUrl})`);
let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Run six operational checks against the repository in dependency order; nothing is changed or committed.',
  instructions: 'Revision 42 part two e2e, project A. Every task runs commands and writes its report outside the repository.',
  acceptanceCriteriaItems: [{ text: 'Every operational check ran and wrote its report', verificationMethod: 'each task\'s acceptance reads its report' }],
  maxConcurrentTasks: 3, workspaceId: ws.id,
});
const coord = p.coordinatorSessionId;
check('the project opened its coordinator in the repository workspace', !!coord, `coordinator session ${coord}`);
const key = p.acceptanceCriteriaItems[0].key;

const spec = {
  A1: { title: 'A1 disk: how full is the volume', cmd: 'df -P . | tail -1', deps: [] },
  A2: { title: 'A2 inventory: what the repository holds', cmd: 'git ls-files', deps: [] },
  B1: { title: 'B1 log: the last commit on the checkout', cmd: 'git log --oneline -1', deps: ['A1'] },
  B2: { title: 'B2 status: branch and cleanliness', cmd: 'git status --short --branch', deps: ['A1', 'A2'] },
  C1: { title: 'C1 summary: the README the checks read', cmd: 'head -1 README.md', deps: ['B1', 'B2'] },
  C2: { title: 'C2 host: the kernel the checks ran on', cmd: 'uname -sr', deps: ['B2'] },
};
const ids = {};
for (const [k, s] of Object.entries(spec)) {
  const report = `${k.toLowerCase()}-${RUN}`;
  const t = await call('POST', '/tasks', T, {
    projectId: p.id, assigneeId: ws.id, title: `${s.title} (${RUN})`, criterionKey: key,
    description: `Operations check ${k}. Run it and report; change nothing in the repository.\nE2E-RUN ${report}: ${s.cmd}`,
    acceptanceCriteria: 'The check\'s report exists and its command exited 0.',
    completionCriterion: 'EXECUTABLE', acceptanceCommand: `grep -qx 'exit 0' ${OUT}/${report}.out`,
    acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
    dependsOnTaskIds: s.deps.map((d) => ids[d]), autoRunWhenReady: true,
  });
  ids[k] = t.id;
}
ev.say(`tasks: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(' ')}`);
state.a = { projectId: p.id, title: TITLE, run: RUN, coordinatorSessionId: coord, tasks: ids };
saveState(state);

await until('the coordinator session to be live', async () => {
  const s = await call('GET', `/sessions/${coord}`, T);
  return ['AWAITING_INPUT', 'RUNNING', 'IDLE'].includes(s.status) ? s : null;
}, { timeoutMs: 180_000 });

// The coordinator asks to start with no line (P-M2), through its own session's orbit MCP server.
const rsId = `A-request-start-${RUN}`;
await sendTurn(T, coord, `E2E-MCP ${rsId} project_request_start ${JSON.stringify({
  projectId: p.id, automatic: true, maxConcurrentTasks: 3,
  why: 'Six operational checks in three layers; none of them changes the repository, so no line is proposed.',
})}`);
const rs = await mcpAnswer(rsId);
ev.say(`coordinator project_request_start (no line): ${rs.isError ? 'ERROR ' : ''}${rs.text.slice(0, 600).replace(/\n/g, ' ')}`);
check('project_request_start without a line is accepted', !rs.isError, rs.text.slice(0, 200));
const filed = JSON.parse(rs.text);
const filedEntity = filed.entity ?? filed;
const requestId = filedEntity.itemId ?? filedEntity.itemPublicId ?? filedEntity.id;
check('it raises no codeless warning', !(filedEntity.warnings ?? []).some((w) => /CODELESS/.test(w.code ?? '')),
  JSON.stringify(filedEntity.warnings ?? []));
check('filing the request wrote no project_codebase row', row(`select count(*) from project_codebase where project_id = ${P}`) === '0');

// The owner starts it from the request, with no line.
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: null, requestId,
});
ev.file('start-answer.json', started);
check('the owner\'s start names no line', !('line' in (started.settings ?? {})), JSON.stringify(started.settings));
check('no project_codebase row after the start', row(`select count(*) from project_codebase where project_id = ${P}`) === '0');

// Watch every task to DONE, once a second: when it was first seen DONE and when its first run was first seen.
const seen = {};
const all = Object.keys(ids);
await until('all six tasks to be DONE', async () => {
  for (const k of all) {
    const t = await getTask(T, ids[k]);
    seen[k] ??= {};
    if (t.sessions?.length && !seen[k].run) seen[k].run = new Date().toISOString();
    if (t.status === 'DONE' && !seen[k].done) seen[k].done = new Date().toISOString();
    if (t.status === 'FAILED') throw new Error(`${k} FAILED`);
  }
  return all.every((k) => seen[k].done);
}, { timeoutMs: 900_000, everyMs: 1_000 });
ev.file('seen.json', seen);
check('all six tasks are DONE', true, all.map((k) => `${k} ${seen[k].done}`).join(', '));

// Each dependent's first run against its prerequisites' DONE, from the rows: the DONE is the moment the prerequisite's
// run settled (the EXECUTABLE acceptance writes DONE as the run finishes); the dependent's run is its session row.
const timing = psql(`with first_run as (
  select distinct on (s.task_id) s.task_id, s.created_at, s.dispatch_origin, s.run_source
  from session s join task t on t.id = s.task_id where t.project_id = ${P} and s.starts_task_work
  order by s.task_id, s.created_at),
done_at as (
  select s.task_id, max(s.finished_at) as done_at
  from session s join task t on t.id = s.task_id where t.project_id = ${P} and s.starts_task_work group by s.task_id)
select dt.title as dependent, pt.title as prerequisite, d_at.done_at as prerequisite_done, fr.created_at as dependent_started,
  round(extract(epoch from fr.created_at - d_at.done_at)::numeric, 3) as gap_seconds, fr.dispatch_origin, fr.run_source
from task_dependency td join task dt on dt.id = td.task_id join task pt on pt.id = td.depends_on_task_id
join first_run fr on fr.task_id = td.task_id join done_at d_at on d_at.task_id = td.depends_on_task_id
where dt.project_id = ${P} order by dt.title, pt.title`);
ev.appendFile('queries.txt', `\n### dependents against their prerequisites' DONE  (${new Date().toISOString()})\n${timing}`);
const gaps = timing.split('\n').slice(2).filter((l) => l.includes('|')).map((l) => Number(l.split('|')[4]));
check('every one of the 6 edges: the dependent started after its prerequisite finished', gaps.length === 6 && gaps.every((g) => g >= 0), gaps.join(', '));
// The latest prerequisite of each dependent is what releases it (J10): its run comes within seconds of that DONE.
const releaseGap = psql(`with first_run as (
  select distinct on (s.task_id) s.task_id, s.created_at from session s join task t on t.id = s.task_id
  where t.project_id = ${P} and s.starts_task_work order by s.task_id, s.created_at),
done_at as (select s.task_id, max(s.finished_at) as done_at from session s join task t on t.id = s.task_id
  where t.project_id = ${P} and s.starts_task_work group by s.task_id)
select dt.title, round(extract(epoch from fr.created_at - max(d_at.done_at))::numeric, 3) as after_last_prerequisite_seconds
from task_dependency td join task dt on dt.id = td.task_id join first_run fr on fr.task_id = td.task_id
join done_at d_at on d_at.task_id = td.depends_on_task_id where dt.project_id = ${P}
group by dt.title, fr.created_at order by dt.title`);
ev.appendFile('queries.txt', `\n### each dependent against its LAST prerequisite's DONE  (${new Date().toISOString()})\n${releaseGap}`);
const release = releaseGap.split('\n').slice(2).filter((l) => l.includes('|')).map((l) => Number(l.split('|')[1]));
check('each of the 4 dependents started within 30 s of its last prerequisite\'s DONE (no landing to wait for)',
  release.length === 4 && release.every((g) => g >= 0 && g < 30), release.join(', '));

// The project to done: Orbit records it by itself when it can prove every criterion; else the coordinator asks.
let done = await until('the project to be DONE by itself', async () => {
  const x = await call('GET', `/projects/${p.id}`, T);
  return x.status === 'DONE' ? x : null;
}, { timeoutMs: 90_000, everyMs: 3_000 }).catch(() => null);
let donePath = 'recorded by Orbit';
if (!done) {
  const rdId = `A-request-done-${RUN}`;
  await sendTurn(T, coord, `E2E-MCP ${rdId} project_request_done ${JSON.stringify({
    projectId: p.id, judgment: 'All six operational checks ran in order and wrote their reports; nothing was to land.', gaps: [],
  })}`);
  const rd = await mcpAnswer(rdId);
  ev.say(`coordinator project_request_done: ${rd.isError ? 'ERROR ' : ''}${rd.text.slice(0, 600).replace(/\n/g, ' ')}`);
  check('project_request_done is accepted', !rd.isError, rd.text.slice(0, 300));
  const rdEntity = JSON.parse(rd.text).entity ?? JSON.parse(rd.text);
  ev.file('done-request.json', rdEntity);
  check('the done request warns of nothing unlanded', !(rdEntity.warnings ?? []).length, JSON.stringify(rdEntity.warnings ?? []));
  const conf2 = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
  const rec = await call('POST', `/projects/${p.id}/done`, T, {
    criteriaDigest: conf2.currentVersion.digest, acceptedGaps: [], requestId: rdEntity.itemId ?? rdEntity.itemPublicId ?? rdEntity.id,
  });
  ev.file('done-answer.json', rec);
  done = await call('GET', `/projects/${p.id}`, T);
  donePath = 'the owner confirmed the coordinator\'s done request';
}
check('the project is DONE', done.status === 'DONE', donePath);

// The rows.
const jobs = row(`select count(*) from project_integration_job where project_id = ${P}`);
check('project_integration_job has zero rows for the project', jobs === '0', jobs);
const cb = row(`select count(*) from project_codebase where project_id = ${P}`);
check('no project_codebase row', cb === '0', cb);
const notDone = row(`select count(*) from task where project_id = ${P} and status <> 'DONE'`);
check('every task DONE', notDone === '0', `${notDone} not DONE`);
const moved = row(`select count(*) from task where project_id = ${P} and (delivered_sha is null or delivered_sha <> delivered_base_sha)`);
check('every task delivered no commit of its own (delivered_sha = delivered_base_sha)', moved === '0', `${moved} differ`);
const reported = row(`select count(*) from session s join task t on t.id = s.task_id where t.project_id = ${P} and jsonb_typeof(s.changed_files) = 'array' and jsonb_array_length(s.changed_files) > 0`);
check('no run reported changed files', reported === '0', reported);
const landingItems = row(`select count(*) from project_open_item where project_id = ${P} and (kind like 'LANDING%' or kind like 'INTEGRATION%')`);
check('no landing or integration open item', landingItems === '0', landingItems);
const promos = row(`select count(*) from project_promotion where project_id = ${P}`);
check('no promotion candidate', promos === '0', promos);

dumpProject(ev, TITLE, 'A final');
ev.query('A — project row', `select id, title, status, started_at, non_code, coordinator_enabled, max_concurrent_tasks from project where id = ${P}`, true);
ev.query('A — the start request', `select kind, state, resolution, payload->'settings' as settings, created_at, resolved_at from project_open_item where project_id = ${P} and kind in ('START_REQUEST', 'DONE_REQUEST') order by created_at`, true);
const fake = logSince(`${SD}/logs/fake-claude.jsonl`, fakeMark).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ops = fake.filter((r) => r.kind === 'ops-work');
check('the fake engine ran six operations turns, each leaving HEAD where it was and the worktree clean',
  ops.length === 6 && ops.every((r) => r.ok && r.headAfter === r.headBefore && r.worktreeStatus === ''),
  ops.map((r) => `${r.runs?.[0]?.key} ${r.ok ? 'ok' : r.error}`).join('; '));
ev.file('fake-claude.jsonl', fake.map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('api-final.json', {
  project: await call('GET', `/projects/${p.id}`, T),
  tasks: Object.fromEntries(await Promise.all(all.map(async (k) => [k, await getTask(T, ids[k])]))),
});
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `PROJECT A: ${failed.length} of ${checks.length} check(s) FAILED` : `PROJECT A: all ${checks.length} checks passed`);
await sleep(100);
process.exit(failed.length ? 1 : 0);
