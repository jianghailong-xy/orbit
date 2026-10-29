// Scenario 3 (contract §10.9 tests 4 and 6, §10.5 O-L5/O-L6, project criterion 3): a PLATFORM project on a MAIN
// line. Task branches are never published by anyone.
//   F  — the agent pushes its work straight to main anyway (E2E-UPSTREAM). Its TASK_BRANCH candidate carries
//        source_sha = delivered_sha, the check goes to the source runner with sourceSha and answers ALREADY_LANDED:
//        a receipt (detail.observed + integrationJobId), the candidate SUPERSEDED (M-T13), LANDED_WITHOUT_CONFIRMATION
//        for the owner, and never BLOCKED. F2 (depends on F) starts by itself.
//   E  — the agent only commits. The check by commit (no fetch of the unpublished branch, so no
//        SOURCE_BRANCH_MISSING) answers READY; the owner confirms; LAND_PROMOTION lands the commit; MERGED receipt;
//        E2 (depends on E) starts by itself.
//   R2913_STACK=a node s3-platform.mjs
import {
  SD, apiLogSince, attempt, call, evidence, execute, getTask, gitIn, logSize, logSince, login, origin, psql, readState,
  saveState, until, waitTask, wireSince,
} from './lib.mjs';
import { dumpProject } from './queries.mjs';

const ev = evidence('s3-platform');
const state = readState();
const T = await login();
const REPO = process.env.S3_REPO || 's3';
const ws = state.workspaces[REPO];
// S3_RUN tags the title when the scenario runs again on a stack that already has it (titles key the queries).
const TITLE = `S3 PLATFORM: each candidate is named by its commit${process.env.S3_RUN ? ` (${process.env.S3_RUN})` : ''}`;
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const P = `(select id from project where title = '${TITLE}')`;
const taskId = (title) => `(select id from task where project_id = ${P} and title = '${title.replace(/'/g, "''")}')`;
// The first row's value, or '' when there is none (psql prints "(0 rows)" where a value would be).
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };

let p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Show a PLATFORM MAIN line naming each candidate by its commit, and a check that finds the work already on main.',
  instructions: 'R29-13 scenario 3. Nobody publishes a task branch. F pushes its work to main itself; E only commits.',
  acceptanceCriteriaItems: [{ text: 'The work is on main', verificationMethod: 'git merge-base --is-ancestor on the origin' }],
  maxConcurrentTasks: 2, workspaceId: ws.id,
});
await call('PATCH', `/projects/${p.id}/integration`, T, { line: 'MAIN', upstreamRef: 'refs/heads/main', mergeCheckCommand: 'test -f README.md' });
p = await call('GET', `/projects/${p.id}`, T);
const key = p.acceptanceCriteriaItems[0].key;
const taskBody = (title, description, extra) => ({
  projectId: p.id, assigneeId: ws.id, title, criterionKey: key, description,
  acceptanceCriteria: 'The run left its work file in the worktree.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  ...extra,
});
const F = await call('POST', '/tasks', T, taskBody('S3-F: pushes its work straight to main', 'E2E-UPSTREAM: origin/main\nE2E-DO: push-upstream', { autoRunWhenReady: false }));
const F2 = await call('POST', '/tasks', T, taskBody('S3-F2: starts once S3-F is on main', 'E2E-DO: commit', { dependsOnTaskIds: [F.id], autoRunWhenReady: true }));
const E = await call('POST', '/tasks', T, taskBody('S3-E: only commits; the platform lands it', 'E2E-DO: commit', { autoRunWhenReady: false }));
const E2 = await call('POST', '/tasks', T, taskBody('S3-E2: starts once S3-E has landed', 'E2E-DO: commit', { dependsOnTaskIds: [E.id], autoRunWhenReady: true }));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'MAIN', upstreamRef: 'refs/heads/main', automatic: false,
  maxConcurrentTasks: 2, mergeCheckCommand: 'test -f README.md',
});
p = await call('GET', `/projects/${p.id}`, T);
state.s3 = { projectId: p.id, title: TITLE, F: F.id, F2: F2.id, E: E.id, E2: E2.id };
saveState(state);
ev.say(`project ${p.id} started: line ${p.integration.line}, deliveryMode ${p.integration.deliveryMode} (never chosen: ${p.integration.deliveryModeChosenAt === null}), Automatic off`);
check('the project is PLATFORM by default', p.integration.deliveryMode === 'PLATFORM');

// ── F: pushed straight to main, then checked ────────────────────────────────────────────────────────
await execute(T, F.id);
const fDone = await waitTask(T, F.id, ['DONE', 'FAILED'], 'S3-F to finish');
check('S3-F is DONE', fDone.status === 'DONE');
const fake = () => logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fWork = fake().find((r) => r.kind === 'task-work' && r.task === F.id);
ev.say(`fake engine for S3-F: committed ${fWork?.commit} on ${fWork?.taskBranch}, pushed it to ${fWork?.remote}/${fWork?.branch} (${fWork?.pushTargetFrom})`);
check('origin main is F\'s commit; no task branch on the origin', gitIn(origin(REPO), 'rev-parse', 'refs/heads/main') === fWork?.commit
  && !gitIn(origin(REPO), 'for-each-ref', '--format=%(refname)', 'refs/heads').includes('orbit/task'));
const fCandidate = await until('S3-F\'s candidate to be named by its commit', () => {
  const r = row(`select source_sha from project_promotion where task_id = ${taskId(F.title)} and source_sha is not null`);
  return r || null;
}, { timeoutMs: 240_000 });
check('candidate source_sha = delivered_sha (O-L5)', fCandidate === fWork?.commit, fCandidate);
const fCheck = await until('S3-F\'s check to answer', () => {
  const r = row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j where j.kind = 'CHECK_PROMOTION' and j.promotion_id = (select id from project_promotion where task_id = ${taskId(F.title)} order by created_at limit 1) and j.finished_at is not null`);
  return r || null;
}, { timeoutMs: 300_000, everyMs: 3_000 });
ev.say(`S3-F's CHECK_PROMOTION answered: ${fCheck}`);
check('the check answered ALREADY_LANDED', fCheck.startsWith('ALREADY_LANDED'), fCheck);
const fPromotion = row(`select state || ' ' || coalesce(blocked_reason, '-') from project_promotion where task_id = ${taskId(F.title)} order by created_at limit 1`);
check('the candidate is SUPERSEDED, not BLOCKED', fPromotion.startsWith('SUPERSEDED'), fPromotion);
const fReceipt = row(`select result || ' ' || target_branch || ' ' || recorded_by || ' ' || source_sha || ' ' || detail::text from session_merge_receipt where task_id = ${taskId(F.title)}`);
check('a receipt: ALREADY_MERGED on main, by the RUNNER, detail.observed + integrationJobId', /^ALREADY_MERGED main RUNNER/.test(fReceipt)
  && fReceipt.includes('"observed": true') && fReceipt.includes('integrationJobId') && fReceipt.includes(fWork?.commit), fReceipt);
const lwc = await until('LANDED_WITHOUT_CONFIRMATION to open', async () => {
  const items = await call('GET', `/projects/${p.id}/open-items`, T);
  return [...(items.needsYou ?? []), ...(items.withCoordinator ?? [])].find((i) => i.kind === 'LANDED_WITHOUT_CONFIRMATION') ?? null;
}, { timeoutMs: 60_000 });
ev.file('lwc-item.json', lwc);
check('LANDED_WITHOUT_CONFIRMATION is the owner\'s, titled for the task', lwc.assignee === 'OWNER' && lwc.title === `Reached main without your confirmation: ${F.title}`, `${lwc.assignee}: ${lwc.title}`);
check('it offers Accept', JSON.stringify(lwc).includes('ACCEPT'), (lwc.actions ?? lwc.primaryAction ?? '') && JSON.stringify(lwc.actions ?? lwc.primaryAction));
const f2Run = await until('S3-F2 to start by itself', async () => { const t = await getTask(T, F2.id); return t.sessions?.length ? t : null; }, { timeoutMs: 240_000 });
check('S3-F2 started by itself (J9 released by the check\'s receipt, J10)', !!f2Run.sessions?.length, `session ${f2Run.sessions?.[0]?.id}`);
await waitTask(T, F2.id, ['DONE', 'FAILED'], 'S3-F2 to finish');

// ── E: only committed; checked and landed by its commit ─────────────────────────────────────────────
await execute(T, E.id);
const eDone = await waitTask(T, E.id, ['DONE', 'FAILED'], 'S3-E to finish');
check('S3-E is DONE', eDone.status === 'DONE');
const eWork = fake().find((r) => r.kind === 'task-work' && r.task === E.id);
ev.say(`fake engine for S3-E: committed ${eWork?.commit} on ${eWork?.taskBranch}; pushed nothing`);
const eCandidate = await until('S3-E\'s candidate to be named by its commit', () => row(`select source_sha from project_promotion where task_id = ${taskId(E.title)} and source_sha is not null`) || null, { timeoutMs: 240_000 });
check('S3-E\'s candidate source_sha = its commit', eCandidate === eWork?.commit, eCandidate);
const eCheck = await until('S3-E\'s check to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j where j.kind = 'CHECK_PROMOTION' and j.promotion_id = (select id from project_promotion where task_id = ${taskId(E.title)} order by created_at limit 1) and j.finished_at is not null`) || null, { timeoutMs: 400_000, everyMs: 3_000 });
ev.say(`S3-E's CHECK_PROMOTION answered: ${eCheck}`);
check('the check by commit answered READY (no SOURCE_BRANCH_MISSING for the unpublished branch)', eCheck.startsWith('READY'), eCheck);
const eWire = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'CHECK_PROMOTION' && j.sourceSha === eWork?.commit));
check('the runner was handed the check with sourceSha = the commit (wire log)', eWire.length > 0, eWire[0]?.integrationJobs?.map((j) => `${j.kind} ${j.promotionSourceKind} ${j.sourceRef} sourceSha=${j.sourceSha}`).join('; '));
const ePromotionId = row(`select id from project_promotion where task_id = ${taskId(E.title)} order by created_at limit 1`);
const ePromotionState = row(`select state from project_promotion where id = '${ePromotionId}'`);
ev.say(`S3-E's candidate ${ePromotionId}: ${ePromotionState}`);
const confirm = await attempt('POST', `/projects/${p.id}/promotions/${ePromotionId}/confirm`, T, { sourceSha: eCandidate });
ev.say(`owner confirms S3-E's candidate: ${JSON.stringify(confirm).slice(0, 400)}`);
check('the owner\'s confirmation is accepted', confirm.ok, confirm.ok ? '' : JSON.stringify(confirm.body).slice(0, 300));
const eLand = await until('S3-E\'s LAND_PROMOTION to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') || ' ' || coalesce(j.landed_sha, '-') from project_integration_job j where j.kind = 'LAND_PROMOTION' and j.promotion_id = '${ePromotionId}' and j.finished_at is not null`) || null, { timeoutMs: 400_000, everyMs: 3_000 });
ev.say(`S3-E's LAND_PROMOTION answered: ${eLand}`);
check('LAND_PROMOTION landed it', /^(LANDED|MERGED)/.test(eLand), eLand);
const landWire = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'LAND_PROMOTION'));
check('the runner was handed the landing with sourceSha = the commit (wire log)', landWire.some((r) => r.integrationJobs.some((j) => j.kind === 'LAND_PROMOTION' && j.sourceSha === eWork?.commit)));
const eReceipt = row(`select result || ' ' || target_branch || ' ' || recorded_by from session_merge_receipt where task_id = ${taskId(E.title)}`);
check('a MERGED receipt on main', /^MERGED main/.test(eReceipt), eReceipt);
const e2Run = await until('S3-E2 to start by itself', async () => { const t = await getTask(T, E2.id); return t.sessions?.length ? t : null; }, { timeoutMs: 240_000 });
check('S3-E2 started by itself after the landing (J10)', !!e2Run.sessions?.length, `session ${e2Run.sessions?.[0]?.id}`);
await waitTask(T, E2.id, ['DONE', 'FAILED'], 'S3-E2 to finish');

// Nothing BLOCKED, no SOURCE_BRANCH_MISSING anywhere.
const blocked = row(`select count(*) from project_promotion where project_id = ${P} and state = 'BLOCKED'`);
check('no candidate BLOCKED', blocked === '0', blocked);
const sbm = row(`select count(*) from project_integration_job where project_id = ${P} and error_code = 'SOURCE_BRANCH_MISSING'`);
check('no SOURCE_BRANCH_MISSING', sbm === '0', sbm);
const fetchedTaskBranch = logSince(`${SD}/logs/runner.log`, marks.runner).split('\n').filter((l) => /fetch/i.test(l) && /orbit\/task-s3/.test(l));
check('the runner log shows no fetch of a task branch', fetchedTaskBranch.length === 0, fetchedTaskBranch.slice(0, 2).join(' | '));

dumpProject(ev, TITLE, 'S3 final');
ev.file('api-final.json', {
  project: await call('GET', `/projects/${p.id}`, T), integration: await call('GET', `/projects/${p.id}/integration`, T),
  tasks: Object.fromEntries(await Promise.all(Object.entries({ F, F2, E, E2 }).map(async ([k, t]) => [k, await getTask(T, t.id)]))),
  openItems: await call('GET', `/projects/${p.id}/open-items`, T),
  promotionsMerged: await call('GET', `/projects/${p.id}/promotions/merged`, T).catch((e) => String(e)),
});
ev.file(`origin-${REPO}.txt`, gitIn(origin(REPO), 'log', '--format=%H %P %s', '--all') + '\n\n'
  + gitIn(origin(REPO), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') + '\n');
ev.file('runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev.file('runner-wire.jsonl', wireSince(marks.wire, (r) => r.kind !== 'heartbeat' || r.integrationJobs).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev.file('fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev.file('apiserver.log', apiLogSince(marks.api));
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `SCENARIO 3: ${failed.length} check(s) FAILED` : `SCENARIO 3: all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
