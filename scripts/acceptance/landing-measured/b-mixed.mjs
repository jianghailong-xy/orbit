// Project B (contract §12.15 P-M1, P-C1, P-C2, P-R1): a mixed project on a PROJECT_BRANCH line with a merge check.
// Some tasks commit and some do not; the coordinator sets the landing check with no owner card and exempts one
// committing task with a reason:
//
//   M1 commits                    -> lands with the landing check          M5 runs a command (after M1), no commit
//   M2 commits, EXEMPT            -> lands with its acceptance only (TASK_EXEMPT)
//   M3 runs a command, no commit  -> no landing                            M4 commits (after M3) -> landing check
//
// Expect: only M1, M2, M4 have LAND_TASK jobs; M2's records LANDING_CHECK skipped TASK_EXEMPT with the reason and its
// TASK_ACCEPTANCE ran; M1's and M4's ran the landing check; the change records exist; main moved only by a promotion
// whose check ran the merge check.
//   node b-mixed.mjs
import { dumpProject, P as projectBy } from './queries.mjs';
import {
  SD, call, evidence, getTask, gitIn, logSince, logSize, login, mcpAnswer, origin, psql, readState, saveState, sendTurn,
  sleep, until, execute,
} from './lib.mjs';

const ev = evidence('b-mixed');
const state = readState();
const T = await login();
const REPO = 'lm-mixed';
const ws = state.workspaces[REPO];
const RUN = process.env.LM_RUN || new Date().toISOString().replace(/\D/g, '').slice(4, 14);
const TITLE = `LM42-B mixed: three tasks commit, two do not, one exempt (${RUN})`;
const OUT = `${SD}/ops-out`;
const BRANCH = `refs/heads/lm42/mixed-${RUN}`;
const MERGE_CHECK = 'echo "LM42 merge check on $(git rev-parse HEAD)"; test -f README.md';
const LANDING_CHECK = 'echo "LM42 landing check on $(git rev-parse HEAD)"; ls E2E_WORK_*.md';
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const P = projectBy(TITLE);
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const rows = (sql) => psql(sql).split('\n').slice(2).filter((l) => l.includes('|')).map((l) => l.split('|').map((c) => c.trim()));
const fakeMark = logSize(`${SD}/logs/fake-claude.jsonl`);
const mainBefore = gitIn(origin(REPO), 'rev-parse', 'refs/heads/main');

ev.say(`run ${RUN}: project "${TITLE}" in workspace ${ws.id}; origin main is ${mainBefore}`);
let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Land the committing work on the project branch, then on main behind the merge check; the rest only runs commands.',
  instructions: 'Revision 42 part two e2e, project B.',
  acceptanceCriteriaItems: [{ text: 'The committed work is on main and every check ran', verificationMethod: 'the origin and the job rows' }],
  maxConcurrentTasks: 2, workspaceId: ws.id,
});
const coord = p.coordinatorSessionId;
check('the project opened its coordinator in the repository workspace', !!coord, `coordinator session ${coord}`);
const key = p.acceptanceCriteriaItems[0].key;
const commitBody = { acceptanceCriteria: 'The run left its work file.', completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60 };
const opsBody = (report) => ({ acceptanceCriteria: 'The command\'s report exists and it exited 0.', completionCriterion: 'EXECUTABLE',
  acceptanceCommand: `grep -qx 'exit 0' ${OUT}/${report}.out`, acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60 });
const spec = {
  M1: { title: 'M1 commits; the landing check runs', commit: true, deps: [], auto: false },
  M2: { title: 'M2 commits; exempt from the landing check', commit: true, deps: [], auto: false },
  M3: { title: 'M3 runs a command; commits nothing', commit: false, cmd: 'git log --oneline -1', deps: [], auto: false },
  M4: { title: 'M4 commits after M3', commit: true, deps: ['M3'], auto: true },
  M5: { title: 'M5 runs a command after M1; commits nothing', commit: false, cmd: 'git status --short --branch', deps: ['M1'], auto: true },
};
const ids = {};
for (const [k, s] of Object.entries(spec)) {
  const report = `${k.toLowerCase()}-${RUN}`;
  const t = await call('POST', '/tasks', T, {
    projectId: p.id, assigneeId: ws.id, title: `${s.title} (${RUN})`, criterionKey: key,
    description: s.commit ? `Task ${k}: commit the work.\nE2E-DO: commit` : `Task ${k}: run and report; change nothing.\nE2E-RUN ${report}: ${s.cmd}`,
    ...(s.commit ? commitBody : opsBody(report)),
    dependsOnTaskIds: s.deps.map((d) => ids[d]), autoRunWhenReady: s.auto,
  });
  ids[k] = t.id;
}
const committing = ['M1', 'M2', 'M4'];
ev.say(`tasks: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(' ')}`);
state.b = { projectId: p.id, title: TITLE, run: RUN, coordinatorSessionId: coord, tasks: ids };
saveState(state);

await until('the coordinator session to be live', async () => {
  const s = await call('GET', `/sessions/${coord}`, T);
  return ['AWAITING_INPUT', 'RUNNING', 'IDLE'].includes(s.status) ? s : null;
}, { timeoutMs: 180_000 });
const coordinatorCall = async (id, tool, args) => {
  const callId = `B-${id}-${RUN}`;
  const sent = Date.now();
  await sendTurn(T, coord, `E2E-MCP ${callId} ${tool} ${JSON.stringify(args)}`);
  const ans = await mcpAnswer(callId);
  ev.say(`coordinator ${tool} (${((Date.now() - sent) / 1000).toFixed(1)} s): ${ans.isError ? 'ERROR ' : ''}${ans.text.slice(0, 900).replace(/\n/g, ' ')}`);
  ev.file(`mcp-${id}.json`, ans);
  let body = null;
  try { body = JSON.parse(ans.text); } catch { /* text */ }
  return { ...ans, body, entity: body?.entity ?? body };
};
const cardsFromCoordinator = () => row(`select count(*) from approval where session_id = (select coordinator_session_id from project where id = ${P})`);

// The coordinator asks to start on a project branch with a merge check; the owner starts it from the request.
const rs = await coordinatorCall('request-start', 'project_request_start', {
  projectId: p.id, line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  mergeCheckCommand: MERGE_CHECK, automatic: true, maxConcurrentTasks: 2,
  why: 'Three tasks commit and two only run commands; the project branch collects the commits behind the merge check.',
});
check('project_request_start with a project branch and a merge check is accepted', !rs.isError, rs.text.slice(0, 200));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: MERGE_CHECK,
  requestId: rs.entity?.itemId ?? rs.entity?.itemPublicId ?? rs.entity?.id,
});
ev.file('start-answer.json', started);
check('the owner started it on the project branch', started.settings?.line === 'PROJECT_BRANCH', JSON.stringify(started.settings));
const cardsBefore = cardsFromCoordinator();

// P-C1: the coordinator sets the landing check itself. No card: the answer comes back in the same call.
const lc = await coordinatorCall('landing-check', 'project_update', {
  projectId: p.id, integration: { landingCheckCommand: LANDING_CHECK, landingCheckReason: 'Every landing on the project branch must carry a work file; main keeps its merge check.' },
});
check('the coordinator\'s landing-check write is accepted', !lc.isError, lc.text.slice(0, 300));
const pg = await call('GET', `/projects/${p.id}`, T);
const landingCheck = pg.integration?.landingCheck;
ev.file('project-after-landing-check.json', pg.integration);
check('project_get: the landing check is the coordinator\'s, set by its session', landingCheck?.command === LANDING_CHECK
  && landingCheck?.setBy === 'COORDINATOR', JSON.stringify(landingCheck));
const cb = rows(`select landing_check_command, landing_check_set_by, landing_check_set_by_session_id, landing_check_set_at, merge_check_command from project_codebase where project_id = ${P}`);
check('project_codebase: landing_check_set_by COORDINATOR with the coordinator\'s session', cb.length === 1 && cb[0][1] === 'COORDINATOR' && !!cb[0][2], JSON.stringify(cb));

// P-C2: the coordinator exempts M2 with a reason.
const EXEMPT_REASON = 'M2 only adds a work file the landing check already reads; its own acceptance covers it.';
const ex = await coordinatorCall('exempt-m2', 'task_update', { taskId: ids.M2, landingCheckExempt: true, landingCheckExemptReason: EXEMPT_REASON });
check('the coordinator\'s exemption of M2 is accepted', !ex.isError, ex.text.slice(0, 300));
const m2 = rows(`select landing_check_exempt, landing_check_exempt_reason, landing_check_exempt_by_session_id from task where id = (select id from task where project_id = ${P} and title like 'M2 %')`);
check('task row: M2 exempt, with the reason and the coordinator\'s session', m2[0]?.[0] === 't' && m2[0]?.[1] === EXEMPT_REASON && !!m2[0]?.[2], JSON.stringify(m2));
const cardsAfter = cardsFromCoordinator();
check('neither write raised a card (approval rows from the coordinator session unchanged)', cardsAfter === cardsBefore, `${cardsBefore} -> ${cardsAfter}`);
const changes = rows(`select field, origin, reason, written_by_session_id is not null from project_setting_change where project_id = ${P} order by created_at`);
check('two change records: LANDING_CHECK and TASK_LANDING_CHECK_EXEMPT, both COORDINATOR with a reason and a session',
  changes.length === 2 && changes[0][0] === 'LANDING_CHECK' && changes[1][0] === 'TASK_LANDING_CHECK_EXEMPT'
  && changes.every((c) => c[1] === 'COORDINATOR' && c[2] && c[3] === 't'), JSON.stringify(changes));

// Run the roots; the dependents start by themselves.
for (const k of ['M1', 'M2', 'M3']) await execute(T, ids[k]);
const all = Object.keys(ids);
await until('all five tasks to be DONE', async () => {
  const ts = await Promise.all(all.map((k) => getTask(T, ids[k])));
  const failedTask = ts.find((t) => t.status === 'FAILED');
  if (failedTask) throw new Error(`${failedTask.title} FAILED`);
  return ts.every((t) => t.status === 'DONE');
}, { timeoutMs: 900_000, everyMs: 3_000 });
check('all five tasks are DONE', true);
await until('the three landings to finish', () => {
  const n = row(`select count(*) from project_integration_job where project_id = ${P} and kind = 'LAND_TASK' and finished_at is not null`);
  return Number(n) >= 3 ? n : null;
}, { timeoutMs: 600_000, everyMs: 3_000 });

// Landing jobs: only for the committing tasks.
const land = rows(`select t.title, j.state, j.checks::text from project_integration_job j join task t on t.id = j.task_id
  where j.project_id = ${P} and j.kind = 'LAND_TASK' order by j.created_at`);
const landedTitles = land.map((r) => r[0].split(' ')[0]).sort();
check('LAND_TASK jobs exist for exactly M1, M2, M4', JSON.stringify(landedTitles) === JSON.stringify(committing), landedTitles.join(', '));
check('every LAND_TASK LANDED', land.every((r) => r[1] === 'LANDED'), land.map((r) => `${r[0].split(' ')[0]} ${r[1]}`).join(', '));
const jobsForNonCommitting = row(`select count(*) from project_integration_job where project_id = ${P} and task_id in (select id from task where project_id = ${P} and (title like 'M3 %' or title like 'M5 %'))`);
check('no integration job of any kind for M3 or M5', jobsForNonCommitting === '0', jobsForNonCommitting);
const noCommit = rows(`select title, delivered_sha = delivered_base_sha from task where project_id = ${P} order by title`);
check('delivered identity: M3 and M5 delivered no commit, M1 M2 M4 did', noCommit.every((r) => (r[1] === 't') === /^M[35] /.test(r[0])), JSON.stringify(noCommit));
const checksOf = (k) => JSON.parse(land.find((r) => r[0].startsWith(`${k} `))?.[2] ?? '[]');
for (const k of ['M1', 'M4']) {
  const c = checksOf(k);
  const lcRun = c.find((x) => x.name === 'LANDING_CHECK');
  check(`${k}: the landing check ran (exit 0, its command, not skipped)`, !!lcRun && !lcRun.skipped && lcRun.exitCode === 0 && lcRun.command === LANDING_CHECK
    && /LM42 landing check on/.test(lcRun.outputTail ?? ''), JSON.stringify(lcRun)?.slice(0, 300));
  check(`${k}: its acceptance ran too`, c.some((x) => x.name === 'TASK_ACCEPTANCE' && x.exitCode === 0), c.map((x) => x.name).join(','));
}
const m2Checks = checksOf('M2');
const m2Skip = m2Checks.find((x) => x.name === 'LANDING_CHECK');
check('M2: LANDING_CHECK skipped TASK_EXEMPT with the coordinator\'s reason', m2Skip?.skipped === 'TASK_EXEMPT' && m2Skip?.reason === EXEMPT_REASON, JSON.stringify(m2Skip));
check('M2: its own acceptance ran (TASK_ACCEPTANCE exit 0)', m2Checks.some((x) => x.name === 'TASK_ACCEPTANCE' && x.exitCode === 0 && !x.skipped), m2Checks.map((x) => `${x.name}:${x.skipped ?? x.exitCode}`).join(','));
check('M2: the landing check never ran (no LANDM42 landing-check output in its job)', !JSON.stringify(m2Checks).includes('LM42 landing check on'));

// Main: reached only through promotions, each checked by the merge check before it moved main. Automatic may promote
// more than once (a candidate is made after a landing whenever the criteria read satisfied), so every one is checked.
const mergedPromos = () => rows(`select id, merged_sha, source_sha from project_promotion where project_id = ${P} and state = 'MERGED' order by decided_at`);
// The three LAND_TASKs have finished (above): the project branch's tip is the last one's landing.
const tip = row(`select landed_sha from project_integration_job where project_id = ${P} and kind = 'LAND_TASK' and state = 'LANDED' order by finished_at desc limit 1`);
const tipMerged = () => { const r = mergedPromos(); return r.some((x) => x[2] === tip) ? r : null; };
let promos = await until('a promotion of the project branch\'s tip to merge', tipMerged, { timeoutMs: 120_000, everyMs: 3_000 }).catch(() => null);
let promotionPath = 'Automatic: candidates were made after landings, checked and merged without a press';
if (!promos) {
  const rp = await coordinatorCall('request-promotion', 'integration_request_promotion', { projectId: p.id, reason: 'Every task is DONE and landed on the project branch.' });
  check('integration_request_promotion is accepted', !rp.isError, rp.text.slice(0, 300));
  promotionPath = 'the coordinator requested the promotion; Automatic checked and merged it';
  promos = await until('the requested promotion to merge', tipMerged, { timeoutMs: 600_000, everyMs: 3_000 });
}
ev.say(`promotions: ${promotionPath}; ${promos.length} merged: ${promos.map((x) => `${x[1]} (from ${x[2]})`).join(', ')}; the project branch's last landing ${tip}`);
const mainAfter = gitIn(origin(REPO), 'rev-parse', 'refs/heads/main');
check('origin main is the last promotion\'s merge', mainAfter === promos.at(-1)[1] && mainAfter !== mainBefore, `${mainBefore} -> ${mainAfter}`);
const firstParents = gitIn(origin(REPO), 'rev-list', '--first-parent', '--reverse', `${mainBefore}..${mainAfter}`).split('\n').filter(Boolean);
check('every first-parent commit main gained is a promotion\'s merge, in order', JSON.stringify(firstParents) === JSON.stringify(promos.map((x) => x[1])),
  `main gained ${firstParents.join(' ')}; promotions merged ${promos.map((x) => x[1]).join(' ')}`);
for (const [id, merged] of promos) {
  const pj = rows(`select kind, state, checks::text, finished_at, landed_sha, skip_merge_check from project_integration_job
    where promotion_id = '${id}' and kind in ('CHECK_PROMOTION', 'LAND_PROMOTION') order by created_at`);
  const ready = pj.filter((j) => j[0] === 'CHECK_PROMOTION' && j[1] === 'READY').at(-1);
  const mc = ready ? JSON.parse(ready[2]).find((x) => x.name === 'MERGE_CHECK') : null;
  const landJob = pj.find((j) => j[0] === 'LAND_PROMOTION' && j[4] === merged);
  check(`promotion ${merged.slice(0, 10)}: its check ran the merge check (exit 0) and finished before the LAND_PROMOTION that moved main`,
    !!mc && mc.exitCode === 0 && mc.command === MERGE_CHECK && /LM42 merge check on/.test(mc.outputTail ?? '')
    && !!landJob && landJob[5] === 'f' && landJob[3] > ready[3], `${JSON.stringify(mc)?.slice(0, 200)}; land ${landJob?.[3]} after check ${ready?.[3]}`);
}
const skipped = row(`select count(*) from project_integration_job where project_id = ${P} and skip_merge_check`);
check('no job of the project skipped the merge check', skipped === '0', skipped);
check('the last promotion carries the project branch\'s last landing', promos.at(-1)[2] === tip, tip);
const mainLog = gitIn(origin(REPO), 'log', '--format=%H %P %s', 'refs/heads/main');
// Recorded, not checked: for each promotion, the committing tasks whose landing was queued only after the candidate was
// made (their DONE came while their run was still open, so P-M1 queued the landing at the run's finish).
ev.query('B — promotions against landings queued after them', `select pp.merged_sha, pp.created_at as candidate_made, t.title as task,
  j.created_at as landing_queued, s.finished_at as task_run_finished
from project_promotion pp join project_integration_job j on j.project_id = pp.project_id and j.kind = 'LAND_TASK' and j.created_at > pp.created_at
join task t on t.id = j.task_id join session s on s.task_id = t.id and s.starts_task_work
where pp.project_id = ${P} and pp.state = 'MERGED' order by pp.created_at, j.created_at`, true);
for (const k of committing) {
  const sha = row(`select delivered_sha from task where id = (select id from task where project_id = ${P} and title like '${k} %')`);
  const onMain = (() => { try { gitIn(origin(REPO), 'merge-base', '--is-ancestor', sha, mainAfter); return true; } catch { return false; } })();
  const fileOnMain = gitIn(origin(REPO), 'ls-tree', '--name-only', mainAfter).split('\n').includes(`E2E_WORK_${ids[k]}.md`);
  check(`${k}'s work file is on main`, fileOnMain, `delivered ${sha}; commit itself an ancestor of main: ${onMain}`);
}

dumpProject(ev, TITLE, 'B final');
ev.query('B — the coordinator session\'s approvals (cards)', `select tool_name, status, created_at from approval where session_id = (select coordinator_session_id from project where id = ${P}) order by created_at`, true);
ev.file(`origin-${REPO}.txt`, `${mainLog}\n\n${gitIn(origin(REPO), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')}\n`);
const fake = logSince(`${SD}/logs/fake-claude.jsonl`, fakeMark).split('\n').filter(Boolean).map((l) => JSON.parse(l));
ev.file('fake-claude.jsonl', fake.map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('api-final.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T).catch((e) => String(e)),
  tasks: Object.fromEntries(await Promise.all(all.map(async (k) => [k, await getTask(T, ids[k])]))),
});
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `PROJECT B: ${failed.length} of ${checks.length} check(s) FAILED` : `PROJECT B: all ${checks.length} checks passed`);
await sleep(100);
process.exit(failed.length ? 1 : 0);
