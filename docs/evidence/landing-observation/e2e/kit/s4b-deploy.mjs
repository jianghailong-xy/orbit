// Scenario 4 phase B — THE DEPLOY — and scenario 5 (stack b). The 0.1.239 apiserver is stopped and this branch's is
// started on the same database (prisma migrate deploy brings it from 0451 to this branch's last migration), while
// the 0.1.239 release runner stays connected and is never restarted.
//   * The boot-time pass (LandingObservationBackfillAtBoot, §10.9) freezes the delivered identities of the DONE,
//     NOT_KNOWN tasks from their rows and queues one OBSERVE_LANDING for the project (trigger DEPLOY).
//   * Scenario 5: the old runner keeps heartbeating without integration-observe/v1, so that observation stays QUEUED
//     and is never handed to it. A PLATFORM project's new work takes the old path on that runner: its TASK_BRANCH
//     check is handed over WITHOUT sourceSha; with the branch published (H) the runner fetches it -> READY -> the
//     owner confirms -> LAND_PROMOTION -> MERGED, J9 lets H2 through; with the branch unpublished (I) it answers
//     SOURCE_BRANCH_MISSING, as it does today.
//   R2913_STACK=b node s4b-deploy.mjs
import {
  SD, apiLogSince, attempt, call, evidence, execute, getTask, gitIn, logSize, logSince, login, origin, psql, readState,
  saveState, sleep, stack, until, waitTask, wireSince,
} from './lib.mjs';
import { dumpProject } from './queries.mjs';

const ev4 = evidence('s4-backfill');
const ev5 = evidence('s5-old-runner');
const state = readState();
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks4 = [];
const checks5 = [];
const check = (list, ev, phase, name, ok, detail = '') => { list.push({ phase, name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${detail ? ` — ${detail}` : ''}`); };
const c4 = (...a) => check(checks4, ev4, 'B', ...a);
const c5 = (...a) => check(checks5, ev5, '5', ...a);
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const S4 = state.s4;
const P4 = `(select id from project where title = '${S4.title}')`;

// ── the deploy ──────────────────────────────────────────────────────────────────────────────────────
ev4.say('phase B (the deploy): stop the 0.1.239 apiserver, migrate, start this branch\'s apiserver; the 0.1.239 runner stays up');
ev4.say(stack('stop-api').trim());
const migrated = stack('migrate', 'new');
ev4.file('b-migrate.txt', logSince(`${SD}/logs/migrate-new.log`, 0));
ev4.say(`prisma migrate deploy (this branch): ${migrated.trim().split('\n').pop()}`);
ev4.say(stack('start-api', 'new').trim());
state.server = 'new';
saveState(state);
const T = await login();
const boot = apiLogSince(marks.api);
const backfillLines = boot.split('\n').filter((l) => /LandingObservationBackfill|landing backfill/i.test(l));
ev4.say(`boot: ${backfillLines.join(' | ') || '(no backfill line)'}`);
c4('the boot-time pass ran and froze finished work', backfillLines.some((l) => /landing backfill: 1 project/.test(l)), backfillLines.join(' | '));

const frozen = psql(`select title, status, delivered_sha is not null as frozen, delivered_branch from task where project_id = ${P4} order by title`);
ev4.say(`tasks after the pass:\n${frozen}`);
const frozenCount = row(`select count(*) from task where project_id = ${P4} and delivered_at is not null`);
// §10.9: the pass freezes the DONE code tasks that are NOT_KNOWN. T3 is not: its agent recorded a receipt (phase A),
// so it is already landed and keeps no delivered identity; T5 is not DONE.
c4('the four DONE, NOT_KNOWN tasks (T1, T2, T4, T6) have a delivered identity; T3 (landed by its own receipt) and T5 (OPEN) have none',
  frozenCount === '4' && row(`select string_agg(title, ',' order by title) from task where project_id = ${P4} and delivered_at is null`).startsWith('S4-T3') , frozenCount);
const queued = row(`select state || ' gen ' || generation || ' runner ' || coalesce(runner_id::text, '-') from project_integration_job where project_id = ${P4} and kind = 'OBSERVE_LANDING'`);
c4('one OBSERVE_LANDING queued for the project', queued.startsWith('QUEUED gen 1'), queued);
const trigger = row(`select e.data->>'trigger' from project_integration_job_event e join project_integration_job j on j.id = e.job_id where j.project_id = ${P4} and j.kind = 'OBSERVE_LANDING' and e.kind = 'ENQUEUED'`);
c4('its enqueue fact says trigger DEPLOY', trigger === 'DEPLOY', trigger);
c4('the BLOCKED candidates are untouched by the pass', row(`select count(*) from project_promotion where project_id = ${P4} and state = 'BLOCKED'`) === '5');
dumpProject(ev4, S4.title, 'S4 phase B (this branch\'s apiserver, the 0.1.239 runner still connected)');

// ── scenario 5: the old runner on the new apiserver ─────────────────────────────────────────────────
ev5.say(`stack b after the deploy: apiserver ${state.server}, runner ${state.runner.binary} (not restarted)`);
const beats = await until('three heartbeats from the old runner after the deploy', () => {
  const hb = wireSince(marks.wire, (r) => r.kind === 'heartbeat' && r.status < 300);
  return hb.length >= 3 ? hb : null;
}, { timeoutMs: 180_000, everyMs: 5_000 });
c5('the old runner heartbeats to the new apiserver without integration-observe/v1', beats.every((b) => b.version === '0.1.239' && b.declaresIntegrationJob && !b.declaresIntegrationObserve),
  `${beats.length} heartbeats, version ${beats[0]?.version}`);
const stillQueued = row(`select state || ' ' || coalesce(runner_id::text, '-') || ' ' || coalesce(claimed_at::text, '-') from project_integration_job where project_id = ${P4} and kind = 'OBSERVE_LANDING'`);
c5('the backfill\'s OBSERVE_LANDING stays QUEUED, unclaimed', stillQueued.startsWith('QUEUED - -'), stillQueued);

const ws = state.workspaces.s5;
const TITLE5 = 'S5 PLATFORM work on the 0.1.239 runner';
let p = await call('POST', '/projects', T, {
  title: TITLE5, goal: 'Show the old runner on the new apiserver: the paths it knows keep working.',
  instructions: 'R29-13 scenario 5. H publishes its task branch; I does not.',
  acceptanceCriteriaItems: [{ text: 'The work is on main', verificationMethod: 'git log on the origin' }],
  maxConcurrentTasks: 2, workspaceId: ws.id,
});
await call('PATCH', `/projects/${p.id}/integration`, T, { line: 'MAIN', upstreamRef: 'refs/heads/main', mergeCheckCommand: 'test -f README.md' });
p = await call('GET', `/projects/${p.id}`, T);
const key = p.acceptanceCriteriaItems[0].key;
const body = (title, directives, extra = {}) => ({
  projectId: p.id, assigneeId: ws.id, title, criterionKey: key, description: `E2E-DO: ${directives}`,
  acceptanceCriteria: 'The run left its work file in the worktree.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  autoRunWhenReady: false, ...extra,
});
const H = await call('POST', '/tasks', T, body('S5-H: publishes its task branch', 'push-task-branch'));
const H2 = await call('POST', '/tasks', T, body('S5-H2: starts once S5-H has landed', 'push-task-branch', { dependsOnTaskIds: [H.id], autoRunWhenReady: true }));
const I = await call('POST', '/tasks', T, body('S5-I: only commits (branch never published)', 'commit'));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'MAIN', upstreamRef: 'refs/heads/main', automatic: false,
  maxConcurrentTasks: 2, mergeCheckCommand: 'test -f README.md',
});
state.s5 = { projectId: p.id, title: TITLE5, H: H.id, H2: H2.id, I: I.id };
saveState(state);
const P5 = `(select id from project where title = '${TITLE5}')`;
const taskId = (title) => `(select id from task where project_id = ${P5} and title = '${title}')`;
const fake = () => logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'task-work');

await execute(T, H.id);
c5('S5-H is DONE', (await waitTask(T, H.id, ['DONE', 'FAILED'], 'S5-H to finish')).status === 'DONE');
const hWork = fake().find((r) => r.task === H.id);
ev5.say(`fake engine for S5-H: committed ${hWork?.commit} on ${hWork?.taskBranch}; published it (exit ${hWork?.pushTaskBranch?.exit})`);
const hCheck = await until('S5-H\'s check to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j join project_promotion pp on pp.id = j.promotion_id where pp.task_id = ${taskId(H.title)} and j.kind = 'CHECK_PROMOTION' and j.finished_at is not null`) || null, { timeoutMs: 400_000, everyMs: 3_000 });
c5('S5-H\'s check on the old runner answered READY', hCheck.startsWith('READY'), hCheck);
const hCmd = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'CHECK_PROMOTION')).flatMap((r) => r.integrationJobs.filter((j) => j.kind === 'CHECK_PROMOTION'));
ev5.file('h-check-command.json', hCmd);
c5('the CHECK_PROMOTION handed to the old runner carries no sourceSha (old shape: it fetches the branch)', hCmd.length > 0 && hCmd.every((j) => !('sourceSha' in j)),
  hCmd.map((j) => `${j.sourceRef} sourceSha=${j.sourceSha ?? '(absent)'}`).join('; '));
const hRowSha = row(`select coalesce(source_sha, '-') from project_promotion where task_id = ${taskId(H.title)}`);
c5('the candidate row itself is named by the delivered commit', hRowSha === hWork?.commit, hRowSha);
const hPromotion = row(`select id from project_promotion where task_id = ${taskId(H.title)}`);
const confirm = await attempt('POST', `/projects/${p.id}/promotions/${hPromotion}/confirm`, T, { sourceSha: hRowSha });
c5('the owner confirms S5-H\'s candidate', confirm.ok, confirm.ok ? '' : JSON.stringify(confirm.body).slice(0, 300));
const hLand = await until('S5-H\'s LAND_PROMOTION to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j where j.promotion_id = '${hPromotion}' and j.kind = 'LAND_PROMOTION' and j.finished_at is not null`) || null, { timeoutMs: 400_000, everyMs: 3_000 });
c5('LAND_PROMOTION on the old runner landed it', /^(LANDED|MERGED)/.test(hLand), hLand);
const landCmd = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'LAND_PROMOTION')).flatMap((r) => r.integrationJobs.filter((j) => j.kind === 'LAND_PROMOTION'));
ev5.file('h-land-command.json', landCmd);
const hReceipt = row(`select result || ' ' || target_branch || ' ' || recorded_by from session_merge_receipt where task_id = ${taskId(H.title)}`);
c5('a MERGED receipt on main', /^MERGED main/.test(hReceipt), hReceipt);
const h2 = await until('S5-H2 to start by itself', async () => { const x = await getTask(T, H2.id); return x.sessions?.length ? x : null; }, { timeoutMs: 240_000 });
c5('S5-H2 started by itself after the landing (J9, J10 unchanged for the old runner)', !!h2.sessions?.length);
await waitTask(T, H2.id, ['DONE', 'FAILED'], 'S5-H2 to finish');

await execute(T, I.id);
c5('S5-I is DONE', (await waitTask(T, I.id, ['DONE', 'FAILED'], 'S5-I to finish')).status === 'DONE');
const iCheck = await until('S5-I\'s check to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j join project_promotion pp on pp.id = j.promotion_id where pp.task_id = ${taskId(I.title)} and j.kind = 'CHECK_PROMOTION' and j.finished_at is not null`) || null, { timeoutMs: 400_000, everyMs: 3_000 });
c5('an unpublished branch still answers SOURCE_BRANCH_MISSING on the old runner (today\'s behaviour)', /SOURCE_BRANCH_MISSING/.test(iCheck), iCheck);
await sleep(35_000);
const neverObserve = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'OBSERVE_LANDING'));
c5('no OBSERVE_LANDING was ever handed to the old runner', neverObserve.length === 0, `${wireSince(marks.wire, (r) => r.kind === 'heartbeat').length} heartbeats since the deploy`);
const neverBySha = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'CHECK_PROMOTION' && 'sourceSha' in j));
c5('no CHECK_PROMOTION named by its commit was handed to the old runner', neverBySha.length === 0);
const p4Still = row(`select state || ' ' || coalesce(runner_id::text, '-') from project_integration_job where project_id = ${P4} and kind = 'OBSERVE_LANDING'`);
c5('S4\'s observation is still QUEUED after all of this', p4Still.startsWith('QUEUED -'), p4Still);

dumpProject(ev5, TITLE5, 'S5 (this branch\'s apiserver, the 0.1.239 runner)');
ev5.query('S5 — the S4 observation while only the old runner is connected', `select kind, generation, state, runner_id, claimed_at, created_at from project_integration_job where project_id = ${P4} and kind = 'OBSERVE_LANDING'`);
ev5.query('S5 — the runner row', `select name, version, status, last_heartbeat_at from runner`);
ev5.file('api.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T),
  tasks: { H: await getTask(T, H.id), H2: await getTask(T, H2.id), I: await getTask(T, I.id) },
  openItems: await call('GET', `/projects/${p.id}/open-items`, T), runners: await call('GET', '/runners', T),
});
ev5.file('origin-s5.txt', gitIn(origin('s5'), 'log', '--format=%H %P %s', '--all') + '\n\n'
  + gitIn(origin('s5'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') + '\n');
ev5.file('runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev5.file('runner-wire.jsonl', wireSince(marks.wire).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev5.file('fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev5.file('apiserver.log', apiLogSince(marks.api));
ev5.file('checks.json', checks5);
ev4.file('b-checks.json', checks4);
ev4.file('b-apiserver-boot.log', boot);
const failed = [...checks4, ...checks5].filter((c) => !c.ok);
ev4.say(failed.length ? `SCENARIO 4 phase B / SCENARIO 5: ${failed.length} check(s) FAILED` : `SCENARIO 4 phase B: all ${checks4.length} checks passed; SCENARIO 5: all ${checks5.length} checks passed`);
ev5.say(failed.length ? `SCENARIO 5 (with 4B): ${failed.length} check(s) FAILED` : `SCENARIO 5: all ${checks5.length} checks passed`);
process.exit(failed.length ? 1 : 0);
