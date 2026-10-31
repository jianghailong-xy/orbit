// Scenario 4 phase C — the runner upgrade (stack b). The 0.1.239 runner is stopped and this branch's runner starts
// in its place: same ORBIT_HOME, same registration, same workspaces and worktrees, i.e. what a self-update does.
// It declares integration-observe/v1, claims the deploy round's observation and answers it:
//   * receipts (ALREADY_MERGED, detail.observed) for every DONE task whose commit is on feature/release-2 and that
//     had none, M-T13 retires their BLOCKED candidates, J9/J10 start T5 by itself;
//   * one LANDED_WITHOUT_CONFIRMATION for the project, UL:backfill:<projectId>, listing the tasks and receipts.
// Then: the owner retries S5-I's BLOCKED candidate (the 0.1.239 runner had answered SOURCE_BRANCH_MISSING): checked
// by its commit now, READY. And the apiserver is restarted once more: the pass finds nothing, writes nothing twice.
//   R2913_STACK=b node s4c-upgrade.mjs
import {
  SD, apiLogSince, attempt, call, evidence, getTask, gitIn, logSize, logSince, login, origin, psql, readState,
  saveState, stack, until, waitTask, wireSince,
} from './lib.mjs';
import { dumpProject } from './queries.mjs';

const ev4 = evidence('s4-backfill');
const ev5 = evidence('s5-old-runner');
const state = readState();
const T = await login();
const marks = {
  runner: logSize(`${SD}/logs/runner.log`), wire: logSize(`${SD}/logs/runner-wire.jsonl`),
  fake: logSize(`${SD}/logs/fake-claude.jsonl`), api: logSize(`${SD}/logs/apiserver.log`),
};
const checks4 = [];
const checks5 = [];
const check = (list, ev, phase, name, ok, detail = '') => { list.push({ phase, name, ok, detail }); ev.say(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${detail ? ` — ${detail}` : ''}`); };
const c4 = (...a) => check(checks4, ev4, 'C', ...a);
const c5 = (...a) => check(checks5, ev5, '5-after', ...a);
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const S4 = state.s4;
const P4 = `(select id from project where title = '${S4.title}')`;
const tid = (k) => `'${row(`select id from task where project_id = ${P4} and title = '${S4.tasks[k].title}'`)}'`;

ev4.say('phase C (the runner upgrade): stop the 0.1.239 runner, start this branch\'s runner with the same ORBIT_HOME');
ev4.say(stack('stop-runner').trim());
ev4.say(stack('start-runner', 'new').trim());
state.runner.binary = 'new';
saveState(state);
// The wire log since the mark can still hold the old runner's last heartbeat: wait for the first one from 0.1.240.
const hb = await until('a heartbeat from the upgraded runner', () => {
  const b = wireSince(marks.wire, (r) => r.kind === 'heartbeat' && r.status < 300 && r.version !== '0.1.239');
  return b.length ? b[0] : null;
}, { timeoutMs: 120_000, everyMs: 2_000 });
c4('the upgraded runner declares integration-observe/v1', hb.version === '0.1.240' && hb.declaresIntegrationObserve, `version ${hb.version}`);

const observed = await until('the deploy round\'s observation to answer', () => {
  const r = row(`select state || ' ' || coalesce(error_code, '-') from project_integration_job where project_id = ${P4} and kind = 'OBSERVE_LANDING' and generation = 1 and finished_at is not null`);
  return r || null;
}, { timeoutMs: 240_000, everyMs: 3_000 });
c4('the deploy round\'s OBSERVE_LANDING answered OBSERVED', observed.startsWith('OBSERVED'), observed);
const obsCmd = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'OBSERVE_LANDING')).flatMap((r) => r.integrationJobs);
ev4.file('c-observe-command.json', obsCmd);
c4('the claim named the four frozen tasks (T3 is already landed)', obsCmd[0]?.observeTasks?.length === 4, obsCmd[0]?.observeTasks?.map((x) => x.deliveredSha.slice(0, 10)).join(' '));

const receipts = psql(`select t.title, r.result, r.recorded_by, r.target_branch, r.detail from session_merge_receipt r join task t on t.id = r.task_id where r.project_id = ${P4} order by r.created_at`);
ev4.say(`receipts:\n${receipts}`);
const observedReceipts = row(`select count(*) from session_merge_receipt where project_id = ${P4} and recorded_by = 'RUNNER' and result = 'ALREADY_MERGED' and detail->>'observed' = 'true' and target_branch = '${S4.line}'`);
c4('four observed receipts (T1, T2, T4, T6) beside T3\'s own', observedReceipts === '4' && row(`select count(*) from session_merge_receipt where project_id = ${P4} and recorded_by <> 'RUNNER'`) === '1', `${observedReceipts} observed`);
const candidates = psql(`select t.title, p.state, p.blocked_reason, p.decided_at from project_promotion p join task t on t.id = p.task_id where p.project_id = ${P4} order by t.title`);
ev4.say(`candidates:\n${candidates}`);
const superseded = row(`select count(*) from project_promotion where project_id = ${P4} and state = 'SUPERSEDED' and task_id in (${tid('T1')}, ${tid('T2')}, ${tid('T4')}, ${tid('T6')})`);
c4('their four BLOCKED candidates are retired (SUPERSEDED, M-T13)', superseded === '4', superseded);
const t3Candidate = row(`select state || ' ' || coalesce(blocked_reason, '-') from project_promotion where task_id = ${tid('T3')}`);
ev4.say(`T3's candidate (its receipt predates it, and T3 was not waiting to be observed): ${t3Candidate}`);

const ul = await until('UL:backfill to open', () => row(`select dedupe_key || ' | ' || assignee || ' | ' || title from project_open_item where project_id = ${P4} and kind = 'LANDED_WITHOUT_CONFIRMATION'`) || null, { timeoutMs: 60_000 });
c4('one LANDED_WITHOUT_CONFIRMATION for the project, UL:backfill:<projectId>, the owner\'s', /^UL:backfill:[0-9a-f-]{36} \| OWNER \| Reached feature\/release-2 without your confirmation: 4 tasks$/.test(ul), ul);
c4('no per-task LANDED_WITHOUT_CONFIRMATION in the deploy round', row(`select count(*) from project_open_item where project_id = ${P4} and kind = 'LANDED_WITHOUT_CONFIRMATION'`) === '1');
const payload = row(`select payload::text from project_open_item where project_id = ${P4} and kind = 'LANDED_WITHOUT_CONFIRMATION'`);
c4('its payload lists the four tasks and their receipts (backfill: true)', payload.includes('"backfill": true') && (payload.match(/"receiptId"/g) ?? []).length === 4, payload.slice(0, 200));

const t5 = await until('T5 to start by itself', async () => { const x = await getTask(T, S4.tasks.T5.id); return x.sessions?.length ? x : null; }, { timeoutMs: 240_000 });
c4('T5 (needs T1 and T2) started by itself (J9 released, J10)', !!t5.sessions?.length, `session ${t5.sessions?.[0]?.id} at ${t5.sessions?.[0]?.createdAt}`);
c4('T5 is DONE', (await waitTask(T, S4.tasks.T5.id, ['DONE', 'FAILED'], 'T5 to finish')).status === 'DONE');
const items = await call('GET', `/projects/${state.s4.projectId}/open-items`, T);
ev4.file('c-open-items.json', items);

// What the owner reads once T5's own work has landed too (its candidate is checked by commit and answers
// ALREADY_LANDED, since the fake agent pushed it), and the owner's Accept on UL:backfill (§10.8: RESOLVED / ACCEPTED,
// resolved by USER).
await until('T5\'s own receipt', () => row(`select count(*) from session_merge_receipt where task_id = ${tid('T5')}`) === '1' || null, { timeoutMs: 240_000, everyMs: 3_000 });
const projectRow = await call('GET', '/projects', T).then((l) => (Array.isArray(l) ? l : l.items ?? l.projects ?? []).find((x) => x.id === state.s4.projectId));
const projectNow = await call('GET', `/projects/${state.s4.projectId}`, T);
ev4.file('c-owner-reads.json', {
  promotionsCurrent: await call('GET', `/projects/${state.s4.projectId}/promotions/current`, T).catch((e) => String(e)),
  listRowAttention: projectRow?.attention ?? null, blockersOpen: projectNow.blockers?.open ?? null,
  derivedDone: projectNow.derivedDone ?? null, criteria: projectNow.acceptanceCriteriaItems?.map((c) => ({ text: c.text, satisfied: c.satisfied, landing: c.landing })),
});
c4('T3\'s leftover candidate surfaces in no owner read (no blocker, no withheld criterion, not the current promotion)', (projectNow.blockers?.open ?? []).length === 0
  && (projectNow.derivedDone?.withheld ?? []).length === 0 && projectNow.acceptanceCriteriaItems?.every((c) => c.landing === 'LANDED'), t3Candidate);
const ulItem = [...(items.needsYou ?? []), ...(items.withCoordinator ?? [])].find((i) => i.kind === 'LANDED_WITHOUT_CONFIRMATION' && / tasks?$/.test(i.title) && !i.title.includes('S4-'));
const accepted = await attempt('POST', `/projects/${state.s4.projectId}/open-items/${ulItem?.itemId}/accept`, T, {});
ev4.say(`owner accepts UL:backfill: ${JSON.stringify(accepted).slice(0, 300)}`);
const ulAfter = row(`select state || ' ' || coalesce(resolution, '-') || ' ' || coalesce(resolved_by, '-') from project_open_item where project_id = ${P4} and dedupe_key like 'UL:backfill:%'`);
c4('the owner\'s Accept closes it RESOLVED / ACCEPTED by USER', accepted.ok && /^RESOLVED ACCEPTED USER/.test(ulAfter), ulAfter);

// ── S5-I: the candidate the old runner could not check, retried by the owner ───────────────────────────
const P5 = `(select id from project where title = '${state.s5.title}')`;
const iPromotion = row(`select id from project_promotion where project_id = ${P5} and task_id = (select id from task where project_id = ${P5} and title like 'S5-I:%') order by created_at limit 1`);
const iBefore = row(`select state || ' ' || coalesce(blocked_reason, '-') from project_promotion where id = '${iPromotion}'`);
ev5.say(`S5-I's candidate before the retry: ${iBefore}`);
const retry = await attempt('POST', `/projects/${state.s5.projectId}/promotions/${iPromotion}/integration/retry`, T, { reason: 'The runner is upgraded; check the delivered commit.' });
ev5.say(`owner retries it: ${JSON.stringify(retry).slice(0, 400)}`);
c5('the owner\'s retry is accepted', retry.ok, retry.ok ? '' : JSON.stringify(retry.body).slice(0, 300));
const iCheck = await until('the retried check to answer', () => row(`select j.state || ' ' || coalesce(j.error_code, '-') from project_integration_job j where j.promotion_id = '${iPromotion}' and j.kind = 'CHECK_PROMOTION' and j.retry_of_job_id is not null and j.finished_at is not null`) || null, { timeoutMs: 300_000, everyMs: 3_000 });
c5('checked by its commit on the upgraded runner: READY', iCheck.startsWith('READY'), iCheck);
const iCmd = wireSince(marks.wire, (r) => r.integrationJobs?.some((j) => j.kind === 'CHECK_PROMOTION')).flatMap((r) => r.integrationJobs.filter((j) => j.kind === 'CHECK_PROMOTION'));
ev5.file('i-retry-check-command.json', iCmd);
c5('the retried check was handed over with sourceSha', iCmd.some((j) => j.sourceSha && j.promotionSourceKind === 'TASK_BRANCH'), iCmd.map((j) => `sourceSha=${j.sourceSha}`).join('; '));

// ── idempotency: one more start ─────────────────────────────────────────────────────────────────────
const before = {
  observations: row(`select count(*) from project_integration_job where kind = 'OBSERVE_LANDING'`),
  ul: row(`select count(*) from project_open_item where dedupe_key like 'UL:backfill:%'`),
  receipts: row(`select count(*) from session_merge_receipt`),
};
const apiMark = logSize(`${SD}/logs/apiserver.log`);
ev4.say(stack('stop-api').trim());
ev4.say(stack('start-api', 'new').trim());
const again = apiLogSince(apiMark).split('\n').filter((l) => /LandingObservationBackfill|landing backfill/i.test(l));
ev4.say(`second start: ${again.join(' | ') || '(the pass logged nothing: nothing to freeze)'}`);
await until('the restarted apiserver to answer', async () => { try { await login(); return true; } catch { return false; } }, { timeoutMs: 60_000 });
const after = {
  observations: row(`select count(*) from project_integration_job where kind = 'OBSERVE_LANDING'`),
  ul: row(`select count(*) from project_open_item where dedupe_key like 'UL:backfill:%'`),
  receipts: row(`select count(*) from session_merge_receipt`),
};
c4('a second start writes nothing again (no observation, no second UL:backfill, no receipt)', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

dumpProject(ev4, S4.title, 'S4 phase C (this branch\'s apiserver and runner)');
dumpProject(ev5, state.s5.title, 'S5 after the runner upgrade');
ev4.file('c-api.json', {
  project: await call('GET', `/projects/${state.s4.projectId}`, T), integration: await call('GET', `/projects/${state.s4.projectId}/integration`, T),
  tasks: Object.fromEntries(await Promise.all(Object.entries(S4.tasks).map(async ([k, v]) => [k, await getTask(T, v.id)]))),
  openItems: await call('GET', `/projects/${state.s4.projectId}/open-items`, T),
});
ev4.file('c-origin-s4.txt', gitIn(origin('s4'), 'log', '--format=%H %P %s', '--all') + '\n\n'
  + gitIn(origin('s4'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') + '\n');
ev4.file('c-runner.log', logSince(`${SD}/logs/runner.log`, marks.runner));
ev4.file('c-runner-wire.jsonl', wireSince(marks.wire, (r) => r.kind !== 'heartbeat' || r.integrationJobs).map((r) => JSON.stringify(r)).join('\n') + '\n');
ev4.file('c-fake-claude.jsonl', logSince(`${SD}/logs/fake-claude.jsonl`, marks.fake));
ev4.file('c-apiserver.log', apiLogSince(marks.api));
ev4.file('c-checks.json', checks4);
ev5.file('checks-after-upgrade.json', checks5);
const failed = [...checks4, ...checks5].filter((c) => !c.ok);
ev4.say(failed.length ? `SCENARIO 4 phase C: ${failed.length} check(s) FAILED` : `SCENARIO 4 phase C: all ${checks4.length} checks passed`);
ev5.say(failed.length ? `SCENARIO 5 after the upgrade: ${failed.length} check(s) FAILED` : `SCENARIO 5 after the upgrade: all ${checks5.length} checks passed`);
process.exit(failed.length ? 1 : 0);
