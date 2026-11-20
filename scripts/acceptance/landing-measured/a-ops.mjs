// Project A (contract §12.15 P-M1, P-M2): an operations-shaped project. A workspace bound to a repository (worktrees on,
// so every run gets a branch and looks like a "code task" to the old rules), a start request from its coordinator with
// no line, and seven tasks in three dependency layers whose runs execute commands and commit nothing:
//
//   layer 1   A1-disk          A2-inventory        D1-line (checks out another commit detached)
//               |      \          |                  |
//   layer 2   B1-log    B2-status  (B2 needs A1 and A2)
//               \        /    \                     |
//   layer 3     C1-summary     C2-uname   (C1 needs B1 and B2, C2 needs B2 and D1)
//
// D1 is the verification run of 2026-11-20: it runs `git checkout --detach` of a commit its base does not have — the
// line pushed to origin just before — and commits nothing, so the runner reports changed_files as the diff from its base
// to that commit while its own branch never moves. P-M1's first reading took that diff for work elsewhere.
//
// Expect: the project runs to done, project_integration_job has zero rows for it, no project_codebase row, and each
// dependent starts on its prerequisites' DONE (no landing in between to wait for).
//   node a-ops.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpProject, P as projectBy } from './queries.mjs';
import {
  SD, call, evidence, getTask, logSince, logSize, login, mcpAnswer, psql, readState, saveState, sendTurn, sleep, until,
} from './lib.mjs';

const ev = evidence('a-ops');
const state = readState();
const T = await login();
const ws = state.workspaces['lm-ops'];
const RUN = process.env.LM_RUN || new Date().toISOString().replace(/\D/g, '').slice(4, 14);
const TITLE = `LM42-A operations: seven tasks in three layers, nothing committed (${RUN})`;
const OUT = `${SD}/ops-out`;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const P = projectBy(TITLE);
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const fakeMark = logSize(`${SD}/logs/fake-claude.jsonl`);

ev.say(`run ${RUN}: project "${TITLE}" in workspace ${ws.id} (${ws.workDir}, origin ${ws.repoUrl})`);

// The line D1 checks out: one commit on origin that the workspace's main (every run's base) does not have.
const LINE = `lm42-line-${RUN}`;
{
  const clone = mkdtempSync(join(tmpdir(), 'lm42-line-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=LM42 E2E', '-c', 'user.email=e2e@lm42.test', ...args],
    { cwd: clone, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: clone, GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    g('clone', '-q', `${SD}/origin/lm-ops.git`, '.');
    g('checkout', '-q', '-b', LINE);
    writeFileSync(join(clone, 'LINE.md'), `# the project line of run ${RUN}\n`);
    g('add', 'LINE.md');
    g('commit', '-qm', `the project line of run ${RUN}`);
    g('push', '-q', 'origin', `HEAD:refs/heads/${LINE}`);
    ev.say(`pushed ${LINE} at ${g('rev-parse', 'HEAD').trim()} to origin, one commit past main`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}
let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Run seven operational checks against the repository in dependency order; nothing is changed or committed.',
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
  D1: { title: 'D1 line: check out the project line detached and verify it', detach: `origin/${LINE}`, deps: [] },
  B1: { title: 'B1 log: the last commit on the checkout', cmd: 'git log --oneline -1', deps: ['A1'] },
  B2: { title: 'B2 status: branch and cleanliness', cmd: 'git status --short --branch', deps: ['A1', 'A2'] },
  C1: { title: 'C1 summary: the README the checks read', cmd: 'head -1 README.md', deps: ['B1', 'B2'] },
  C2: { title: 'C2 host: the kernel the checks ran on', cmd: 'uname -sr', deps: ['B2', 'D1'] },
};
const ids = {};
for (const [k, s] of Object.entries(spec)) {
  const report = `${k.toLowerCase()}-${RUN}`;
  const t = await call('POST', '/tasks', T, {
    projectId: p.id, assigneeId: ws.id, title: `${s.title} (${RUN})`, criterionKey: key,
    description: s.detach
      ? `Verification ${k}. Run \`git checkout --detach ${s.detach}\`, verify it and report; commit nothing.\nE2E-DETACH ${report}: ${s.detach}`
      : `Operations check ${k}. Run it and report; change nothing in the repository.\nE2E-RUN ${report}: ${s.cmd}`,
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
await until('all seven tasks to be DONE', async () => {
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
check('all seven tasks are DONE', true, all.map((k) => `${k} ${seen[k].done}`).join(', '));

// Each dependent's first run against its prerequisites. Two edges are measured:
//  - the prerequisite's DONE, as this script saw it (polled once a second, so the real DONE is at most ~1 s earlier);
//  - the prerequisite's work session finishing (session.finished_at), the edge §12.15 P-M1 decides on when the DONE
//    came while that session was still open ("work still moving", §10.5 O-L4 3).
const firstRun = Object.fromEntries(psql(`select distinct on (s.task_id) t.title, s.created_at, s.finished_at
  from session s join task t on t.id = s.task_id where t.project_id = ${P} and s.starts_task_work
  order by s.task_id, s.created_at`).split('\n').slice(2).filter((l) => l.includes('|'))
  .map((l) => l.split('|').map((c) => c.trim())).map(([title, created, finished]) => [title.split(' ')[0],
    { created: new Date(created.replace(' ', 'T') + 'Z'), finished: new Date(finished.replace(' ', 'T') + 'Z') }]));
const timing = psql(`with first_run as (
  select distinct on (s.task_id) s.task_id, s.created_at, s.dispatch_origin, s.run_source
  from session s join task t on t.id = s.task_id where t.project_id = ${P} and s.starts_task_work
  order by s.task_id, s.created_at),
finished as (
  select s.task_id, max(s.finished_at) as finished_at
  from session s join task t on t.id = s.task_id where t.project_id = ${P} and s.starts_task_work group by s.task_id)
select dt.title as dependent, pt.title as prerequisite, f.finished_at as prerequisite_run_finished, fr.created_at as dependent_started,
  round(extract(epoch from fr.created_at - f.finished_at)::numeric, 3) as after_finish_seconds, fr.dispatch_origin, fr.run_source
from task_dependency td join task dt on dt.id = td.task_id join task pt on pt.id = td.depends_on_task_id
join first_run fr on fr.task_id = td.task_id join finished f on f.task_id = td.depends_on_task_id
where dt.project_id = ${P} order by dt.title, pt.title`);
ev.appendFile('queries.txt', `\n### dependents against their prerequisites' work session finishing  (${new Date().toISOString()})\n${timing}`);
const edges = Object.entries(spec).flatMap(([k, s]) => s.deps.map((d) => [k, d]));
const edgeRows = edges.map(([k, d]) => ({
  dependent: k, prerequisite: d,
  prerequisiteDoneSeen: seen[d].done, prerequisiteRunFinished: firstRun[d].finished.toISOString(),
  dependentStarted: firstRun[k].created.toISOString(),
  afterDoneSeenSeconds: (firstRun[k].created - new Date(seen[d].done)) / 1000,
  afterRunFinishedSeconds: (firstRun[k].created - firstRun[d].finished) / 1000,
}));
ev.file('edges.json', edgeRows);
ev.appendFile('queries.txt', `\n### the seven edges: DONE as polled vs the work session finishing  (${new Date().toISOString()})\n${edgeRows.map((e) =>
  `${e.dependent} <- ${e.prerequisite}: prerequisite DONE seen ${e.prerequisiteDoneSeen}, its run finished ${e.prerequisiteRunFinished}, dependent started ${e.dependentStarted} (${e.afterDoneSeenSeconds.toFixed(3)} s after the DONE was seen, ${e.afterRunFinishedSeconds.toFixed(3)} s after the run finished)`).join('\n')}\n`);
check('every one of the 7 edges: the dependent started after its prerequisite was DONE and its run finished',
  edgeRows.length === 7 && edgeRows.every((e) => e.afterDoneSeenSeconds >= -1.5 && e.afterRunFinishedSeconds >= 0),
  edgeRows.map((e) => `${e.dependent}<-${e.prerequisite} ${e.afterDoneSeenSeconds.toFixed(1)}/${e.afterRunFinishedSeconds.toFixed(3)}`).join(', '));
// The last prerequisite to settle is what releases a dependent (J10); with nothing to land there is nothing else to
// wait for, so the dependent's run follows that edge at once.
const release = Object.entries(spec).filter(([, s]) => s.deps.length).map(([k, s]) => {
  const last = Math.max(...s.deps.map((d) => firstRun[d].finished.getTime()));
  const lastDone = Math.max(...s.deps.map((d) => new Date(seen[d].done).getTime()));
  return { k, afterFinish: (firstRun[k].created - last) / 1000, afterDone: (firstRun[k].created - lastDone) / 1000 };
});
check('each of the 4 dependents started within 2 s of its last prerequisite\'s run finishing (no landing in between)',
  release.length === 4 && release.every((r) => r.afterFinish >= 0 && r.afterFinish < 2), release.map((r) => `${r.k} ${r.afterFinish.toFixed(3)} s`).join(', '));
ev.say(`measured, not checked: each dependent started ${release.map((r) => `${r.k} ${r.afterDone.toFixed(1)} s`).join(', ')} after its last prerequisite's DONE was seen — the DONE came while that prerequisite's session was still open, so P-M1 decided at the session's finish`);

// The project to done: Orbit records it by itself when it can prove every criterion; else the coordinator asks.
let done = await until('the project to be DONE by itself', async () => {
  const x = await call('GET', `/projects/${p.id}`, T);
  return x.status === 'DONE' ? x : null;
}, { timeoutMs: 90_000, everyMs: 3_000 }).catch(() => null);
let donePath = 'recorded by Orbit';
if (!done) {
  const rdId = `A-request-done-${RUN}`;
  await sendTurn(T, coord, `E2E-MCP ${rdId} project_request_done ${JSON.stringify({
    projectId: p.id, judgment: 'All seven operational checks ran in order and wrote their reports; nothing was to land.', gaps: [],
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
const reported = row(`select string_agg(split_part(t.title, ' ', 1), ',') from session s join task t on t.id = s.task_id where t.project_id = ${P} and jsonb_typeof(s.changed_files) = 'array' and jsonb_array_length(s.changed_files) > 0`);
check('only D1\'s run reported changed files: the diff from its base to the line it checked out', reported === 'D1', reported);
const d1Own = row(`select count(*) from session s join task t on t.id = s.task_id where t.project_id = ${P} and split_part(t.title, ' ', 1) = 'D1' and s.starts_task_work and s.branch_sha = s.base_sha and s.worktree_dirty is not true`);
check('and D1\'s own branch never moved past its base, with a clean checkout (branch_sha = base_sha)', Number(d1Own) >= 1, d1Own);
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
const detached = fake.filter((r) => r.kind === 'detach-work');
check('and one verification turn that checked out the line detached, committed nothing and left the worktree clean',
  detached.length === 1 && detached.every((r) => r.ok && r.headAfter !== r.headBefore && r.branchAfter === 'HEAD' && r.worktreeStatus === ''),
  detached.map((r) => `${r.runs?.[0]?.key} ${r.ok ? `${r.headBefore?.slice(0, 10)} -> ${r.headAfter?.slice(0, 10)}` : r.error}`).join('; '));
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
