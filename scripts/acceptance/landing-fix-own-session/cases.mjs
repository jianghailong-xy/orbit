// Revision 42 part one end to end (docs/project-integration-line-contract.md §12.1–§12.8, W4–W8), three cases in one
// project on a PROJECT_BRANCH line with a merge check and a landing check, Automatic on:
//
//   1. F1 and F2 both write SHARED-1.md from the same tip; whichever lands second conflicts. Its landing-fix turn goes
//      to its own session, which merges the line in, keeps both sides, commits and ends its turn: the next generation
//      lands, the item is RESOLVED / HANDLED by that session, and the coordinator gets no turn in between.
//   2. H1 and H2 do the same with SHARED-2.md, but the one that conflicts declines: it ends its fix turn without a
//      commit and says why. The item is handed back NO_NEW_COMMIT with those words, and the coordinator's turn quotes them.
//   3. Main gains LINE_RED.md, which the landing check refuses, and R lands after it: the combined tree is red and so is
//      the baseline without R (BASELINE_RED). The item is the coordinator's from the start; R's session gets no turn.
//
//   node cases.mjs        (run.sh runs it on the isolated stack; records under $LM_DIR/records/<run>/lfx-cases/)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import {
  SD, call, evidence, execute, getTask, gitIn, logSince, logSize, login, mcpAnswer, origin, psql, readState,
  saveState, sendTurn, sleep, until,
} from '../landing-measured/lib.mjs';
import { P as projectBy } from '../landing-measured/queries.mjs';

const ev = evidence('lfx-cases');
const state = readState();
const T = await login();
const REPO = 'lfx-line';
const ws = state.workspaces[REPO];
if (!ws) throw new Error(`no workspace ${REPO} in ${SD}/state.json: run bootstrap.mjs ${REPO} first`);
const RUN = process.env.LM_RUN || new Date().toISOString().replace(/\D/g, '').slice(4, 14);
const TITLE = `LFX42 landing fix by the task's own session: fixed, handed back, baseline red (${RUN})`;
const LINE = `lfx42/line-${RUN}`;
const BRANCH = `refs/heads/${LINE}`;
const MERGE_CHECK = 'echo "LFX42 merge check on $(git rev-parse HEAD)"; test -f README.md';
const LANDING_CHECK = 'echo "LFX42 landing check on $(git rev-parse HEAD)"; '
  + 'if [ -f LINE_RED.md ]; then echo "LINE_RED.md is on the line: refusing it"; exit 3; fi';
// fake-claude's DECLINE_WORDS: what the declining session says, byte for byte.
const DECLINE_WORDS = 'LFX42 decline: this conflict is with another task\'s line in the same file, and which line stays is '
  + 'not mine to decide, so I committed nothing. The coordinator should choose.';
const FIX_REASON = 'Fixed by the task\'s own session';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  ev.say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const P = projectBy(TITLE);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const row = (sql) => { const v = psql(sql).split('\n')[2]?.trim() ?? ''; return /^\(\d+ rows?\)$/.test(v) ? '' : v; };
const rows = (sql) => psql(sql).split('\n').slice(2).filter((l) => l.includes('|')).map((l) => l.split('|').map((c) => c.trim()));
const fakeMark = logSize(`${SD}/logs/fake-claude.jsonl`);
const COORD_TURNS = (from, to) => `select count(*) from conversation_turn where session_id = (select coordinator_session_id
  from project where id = ${P}) and created_at > ${lit(from)}::timestamptz${to ? ` and created_at <= ${lit(to)}::timestamptz` : ''}`;

ev.say(`run ${RUN}: project "${TITLE}" in workspace ${ws.id}; line ${BRANCH}`);
const p = await call('POST', '/projects', T, {
  title: TITLE,
  goal: 'Show that a landing failure goes first to the task\'s own session, and what happens when it cannot fix it.',
  instructions: 'Revision 42 part one e2e. Leave landing failures to the platform unless one is handed to you.',
  acceptanceCriteriaItems: [{ text: 'Every task\'s work is on the project branch, or its failure is with the coordinator', verificationMethod: 'the job and item rows' }],
  maxConcurrentTasks: 2, workspaceId: ws.id,
});
const coord = p.coordinatorSessionId;
check('the project opened its coordinator in the repository workspace', !!coord, `coordinator session ${coord}`);
const key = p.acceptanceCriteriaItems[0].key;
const accept = { acceptanceCriteria: 'The run left its work file.', completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'ls E2E_WORK_*.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60 };
const spec = {
  F1: { title: 'F1 writes SHARED-1.md; fixes its own landing', shared: 'SHARED-1.md', onfix: 'resolve', barrier: `pair1-${RUN}` },
  F2: { title: 'F2 writes SHARED-1.md; fixes its own landing', shared: 'SHARED-1.md', onfix: 'resolve', barrier: `pair1-${RUN}` },
  H1: { title: 'H1 writes SHARED-2.md; declines a landing fix', shared: 'SHARED-2.md', onfix: 'decline', barrier: `pair2-${RUN}` },
  H2: { title: 'H2 writes SHARED-2.md; declines a landing fix', shared: 'SHARED-2.md', onfix: 'decline', barrier: `pair2-${RUN}` },
  R: { title: 'R lands after main went red', onfix: 'resolve' },
};
const ids = {};
for (const [k, s] of Object.entries(spec)) {
  const lines = [`Task ${k}: commit the work.`, 'E2E-DO: commit'];
  if (s.shared) lines.push(`E2E-SHARED: ${s.shared}`);
  lines.push(`E2E-ONFIX: ${s.onfix}`);
  if (s.barrier) lines.push(`E2E-BARRIER ${s.barrier} 2`);
  const t = await call('POST', '/tasks', T, {
    projectId: p.id, assigneeId: ws.id, title: `${s.title} (${RUN})`, criterionKey: key, description: lines.join('\n'),
    ...accept, autoRunWhenReady: false,
  });
  ids[k] = t.id;
}
ev.say(`tasks: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(' ')}`);
state.lfx = { projectId: p.id, title: TITLE, run: RUN, coordinatorSessionId: coord, tasks: ids };
saveState(state);
const taskRow = (k) => `(select id from task where project_id = ${P} and title like ${lit(`${k} %`)})`;

await until('the coordinator session to be live', async () => {
  const s = await call('GET', `/sessions/${coord}`, T);
  return ['AWAITING_INPUT', 'RUNNING', 'IDLE'].includes(s.status) ? s : null;
}, { timeoutMs: 180_000 });
const coordinatorCall = async (id, tool, args) => {
  const callId = `LFX-${id}-${RUN}`;
  await sendTurn(T, coord, `E2E-MCP ${callId} ${tool} ${JSON.stringify(args)}`);
  const ans = await mcpAnswer(callId);
  ev.say(`coordinator ${tool}: ${ans.isError ? 'ERROR ' : ''}${ans.text.slice(0, 600).replace(/\n/g, ' ')}`);
  ev.file(`mcp-${id}.json`, ans);
  let body = null;
  try { body = JSON.parse(ans.text); } catch { /* text */ }
  return { ...ans, body, entity: body?.entity ?? body };
};

// ── the line: a project branch with a merge check, Automatic, and the coordinator's landing check ───────────────
const rs = await coordinatorCall('request-start', 'project_request_start', {
  projectId: p.id, line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  mergeCheckCommand: MERGE_CHECK, automatic: true, maxConcurrentTasks: 2,
  why: 'Five committing tasks land on a project branch behind a merge check.',
});
check('project_request_start with a project branch and a merge check is accepted', !rs.isError, rs.text.slice(0, 200));
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: MERGE_CHECK,
  requestId: rs.entity?.itemId ?? rs.entity?.itemPublicId ?? rs.entity?.id,
});
ev.file('start-answer.json', started);
check('the owner started it on the project branch, Automatic', started.settings?.line === 'PROJECT_BRANCH', JSON.stringify(started.settings));
const lc = await coordinatorCall('landing-check', 'project_update', {
  projectId: p.id, integration: { landingCheckCommand: LANDING_CHECK, landingCheckReason: 'The line must never carry LINE_RED.md.' },
});
check('the coordinator set the landing check', !lc.isError, lc.text.slice(0, 200));

/** The LAND_TASK jobs of a pair, with the session each was handed. */
const landJobs = (k) => rows(`select j.id, j.generation, j.state, coalesce(j.phase, ''), j.session_id, j.source_sha,
    coalesce(j.retry_requested_by_session_id::text, ''), coalesce(j.retry_reason, ''), coalesce(j.retry_failure_class, ''),
    to_char(j.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), array_to_string(j.conflicts, ','), j.baseline_red
  from project_integration_job j where j.task_id = ${taskRow(k)} and j.kind = 'LAND_TASK' order by j.generation`)
  .map(([id, generation, st, phase, session, source, retryBy, retryReason, retryClass, finished, conflicts, baselineRed]) => ({
    id, generation: Number(generation), state: st, phase, session, source, retryBy, retryReason, retryClass, finished,
    conflicts, baselineRed: baselineRed === 't',
  }));
const itemOf = (jobId) => rows(`select i.id, i.kind, i.state, i.assignee, coalesce(i.resolution, ''),
    coalesce(i.work_session_id::text, ''), coalesce(to_char(i.work_session_offered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    coalesce(to_char(i.work_session_returned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    coalesce(i.work_session_return_reason, ''), coalesce(i.resolved_by_session_id::text, ''),
    coalesce(i.payload->>'failureClass', ''), coalesce(i.escalate_at::text, '')
  from project_open_item i where i.integration_job_id = ${lit(jobId)}::uuid order by i.created_at`)
  .map(([id, kind, st, assignee, resolution, workSession, offeredAt, returnedAt, returnReason, resolvedBy, failureClass, escalateAt]) => ({
    id, kind, state: st, assignee, resolution, workSession, offeredAt, returnedAt, returnReason, resolvedBy, failureClass, escalateAt,
  }))[0] ?? null;
const fixTurns = (sessionId) => rows(`select client_turn_id, status, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    position('Orbit could not land your work' in coalesce(content, '')) > 0
  from conversation_turn where session_id = ${lit(sessionId)}::uuid and client_turn_id like 'landing-fix:v1:%' order by seq`)
  .map(([clientTurnId, st, createdAt, isFix]) => ({ clientTurnId, status: st, createdAt, isFix: isFix === 't' }));

async function runPair(a, b, what) {
  for (const k of [a, b]) await execute(T, ids[k]);
  await until(`${a} and ${b} to be DONE`, async () => {
    const ts = await Promise.all([a, b].map((k) => getTask(T, ids[k])));
    const failed = ts.find((t) => t.status === 'FAILED');
    if (failed) throw new Error(`${failed.title} FAILED`);
    return ts.every((t) => t.status === 'DONE');
  }, { timeoutMs: 600_000, everyMs: 3_000 });
  const bases = rows(`select t.title, s.base_sha from session s join task t on t.id = s.task_id
    where t.id in (${taskRow(a)}, ${taskRow(b)}) and s.starts_task_work order by s.created_at`);
  check(`${what}: ${a} and ${b} started from the same tip`, bases.length === 2 && bases[0][1] === bases[1][1], JSON.stringify(bases));
  const both = await until(`one of ${a}/${b} to land and the other to conflict`, () => {
    const ja = landJobs(a); const jb = landJobs(b);
    const conflicted = [[a, ja], [b, jb]].find(([, j]) => j[0]?.state === 'CONFLICT');
    const landed = [[a, ja], [b, jb]].find(([, j]) => j[0]?.state === 'LANDED');
    return conflicted && landed ? { conflicted: conflicted[0], landed: landed[0] } : null;
  }, { timeoutMs: 600_000, everyMs: 3_000 });
  ev.say(`${what}: ${both.landed} landed first; ${both.conflicted} conflicted`);
  return both;
}

// ── case 1: a conflict the task's own session fixes ─────────────────────────────────────────────────────────────
const c1 = await runPair('F1', 'F2', 'case 1');
const X = c1.conflicted;
const [x1] = landJobs(X);
check(`case 1: ${X}'s first landing is a CONFLICT on SHARED-1.md`, x1.state === 'CONFLICT' && ['REBASE', 'MERGE'].includes(x1.phase)
  && x1.conflicts.split(',').includes('SHARED-1.md'), `${x1.state} ${x1.phase} [${x1.conflicts}] job ${x1.id}`);
const x2 = await until(`${X}'s next generation to finish`, () => {
  const j = landJobs(X).find((g) => g.generation > x1.generation && g.finished);
  return j ?? null;
}, { timeoutMs: 600_000, everyMs: 3_000 }).catch(() => null);
const item1 = itemOf(x1.id);
const turns1 = fixTurns(x1.session);
check(`case 1: the item went to ${X}'s own work session (W5)`, item1?.kind === 'INTEGRATION_CONFLICT' && item1.workSession === x1.session
  && !!item1.offeredAt && !item1.returnedAt, JSON.stringify(item1));
check(`case 1: ${X}'s session got exactly the landing-fix:v1 turn of the failed job, answered (W6)`,
  turns1.length === 1 && turns1[0].clientTurnId === `landing-fix:v1:${x1.id}` && turns1[0].isFix && turns1[0].status === 'ANSWERED',
  JSON.stringify(turns1));
check(`case 1: the next generation LANDED, asked for by ${X}'s session with the fix reason, CONFLICT copied (W7, W-T2)`,
  x2?.state === 'LANDED' && x2.retryBy === x1.session && x2.retryReason === FIX_REASON && x2.retryClass === 'CONFLICT'
  && x2.source !== x1.source, JSON.stringify(x2));
if (x2) {
  const parents = gitIn(origin(REPO), 'rev-list', '--parents', '-n', '1', x2.source).split(' ').slice(1);
  check(`case 1: the fixed commit is ${X}'s own merge of the line onto its failed source`, parents.includes(x1.source),
    `${x2.source} has parents ${parents.join(' ')}`);
}
check(`case 1: the item is RESOLVED / HANDLED by ${X}'s session (W-T3)`, item1?.state === 'RESOLVED' && item1.resolution === 'HANDLED'
  && item1.resolvedBy === x1.session, JSON.stringify(item1));
const coordIn1 = x2 ? row(COORD_TURNS(x1.finished, x2.finished)) : 'n/a';
check('case 1: the coordinator got no turn between the conflict and the landing that fixed it', coordIn1 === '0',
  `${coordIn1} coordinator turns from ${x1.finished} to ${x2?.finished}`);
const lineFile = (() => { try { return gitIn(origin(REPO), 'show', `${BRANCH}:SHARED-1.md`); } catch (e) { return String(e.message).slice(0, 200); } })();
check('case 1: the project branch carries both tasks\' lines of SHARED-1.md',
  lineFile.split('\n').filter((l) => l.endsWith(': this line is the work of this task')).length === 2, JSON.stringify(lineFile));
check(`case 1: ${X} stayed DONE`, (await getTask(T, ids[X])).status === 'DONE');

// ── case 2: the session settles without a new commit; the item is handed back with what it said ────────────────
const c2 = await runPair('H1', 'H2', 'case 2');
const Y = c2.conflicted;
const [y1] = landJobs(Y);
check(`case 2: ${Y}'s first landing is a CONFLICT on SHARED-2.md`, y1.state === 'CONFLICT' && y1.conflicts.split(',').includes('SHARED-2.md'),
  `${y1.state} ${y1.phase} [${y1.conflicts}] job ${y1.id}`);
const item2 = await until(`${Y}'s item to be handed back`, () => { const i = itemOf(y1.id); return i?.returnedAt ? i : null; },
  { timeoutMs: 600_000, everyMs: 3_000 }).catch(() => itemOf(y1.id));
const turns2 = fixTurns(y1.session);
check(`case 2: ${Y}'s session got the landing-fix:v1 turn of the failed job, answered`,
  turns2.length === 1 && turns2[0].clientTurnId === `landing-fix:v1:${y1.id}` && turns2[0].status === 'ANSWERED', JSON.stringify(turns2));
check(`case 2: the item was handed back NO_NEW_COMMIT and is the coordinator's, OPEN (W7, W-T5)`, item2?.workSession === y1.session
  && !!item2.offeredAt && !!item2.returnedAt && item2.returnReason === 'NO_NEW_COMMIT' && item2.state === 'OPEN'
  && item2.assignee === 'COORDINATOR' && !!item2.escalateAt, JSON.stringify(item2));
const saidOnItem = row(`select (payload->'workSession'->>'lastMessage') = ${lit(DECLINE_WORDS)} from project_open_item where id = ${lit(item2?.id)}::uuid`);
check(`case 2: the item's payload carries what ${Y}'s session said, byte for byte`, saidOnItem === 't', `lastMessage matches: ${saidOnItem}`);
const coordQuote = await until('the coordinator to be handed the item with those words', () => {
  const n = row(`select count(*) from conversation_turn where session_id = (select coordinator_session_id from project where id = ${P})
    and created_at >= ${lit(item2.returnedAt)}::timestamptz and position(${lit(DECLINE_WORDS)} in coalesce(content, '')) > 0
    and position('handed back' in coalesce(content, '')) > 0`);
  return Number(n) > 0 ? n : null;
}, { timeoutMs: 300_000, everyMs: 3_000 }).catch(() => '0');
check('case 2: the coordinator got a turn after the hand-back quoting the session\'s words', Number(coordQuote) > 0, `${coordQuote} turn(s)`);
const y2 = landJobs(Y).filter((g) => g.generation > y1.generation);
check(`case 2: nothing was landed again for ${Y} (no next generation)`, y2.length === 0, JSON.stringify(y2));
const yDelivered = row(`select delivered_sha from task where id = ${taskRow(Y)}`);
check(`case 2: ${Y}'s delivered identity is frozen again on the failed job's source`, yDelivered === y1.source, `${yDelivered} vs ${y1.source}`);

// ── case 3: a baseline-red landing never reaches the task's session ──────────────────────────────────────────────
await until('no promotion of the project to be in motion', () => row(`select count(*) from project_promotion
  where project_id = ${P} and state in ('CHECKING', 'CONFIRMED', 'RECHECKING')`) === '0' || null, { timeoutMs: 300_000, everyMs: 3_000 }).catch(() => null);
const rig = `${SD}/rig-${RUN}`;
mkdirSync(rig, { recursive: true });
const rigGit = (...args) => execFileSync('git', ['-C', rig, '-c', 'user.name=LFX42 Rig', '-c', 'user.email=rig@lfx42.test', ...args], {
  encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: `${SD}/runner-userhome`, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
execFileSync('git', ['clone', '-q', '--branch', 'main', origin(REPO), rig], { env: { PATH: '/usr/bin:/bin', HOME: `${SD}/runner-userhome`, GIT_CONFIG_NOSYSTEM: '1' } });
execFileSync('/bin/sh', ['-c', `printf 'main went red: the landing check refuses this file\\n' > ${rig}/LINE_RED.md`]);
rigGit('add', 'LINE_RED.md');
rigGit('commit', '-qm', 'main gains LINE_RED.md (the e2e makes main red)');
rigGit('push', '-q', 'origin', 'HEAD:refs/heads/main');
const redMain = rigGit('rev-parse', 'HEAD');
ev.say(`case 3: origin main is now ${redMain}, carrying LINE_RED.md; the project branch is ${gitIn(origin(REPO), 'rev-parse', BRANCH)}`);
await execute(T, ids.R);
await until('R to be DONE', async () => {
  const t = await getTask(T, ids.R);
  if (t.status === 'FAILED') throw new Error('R FAILED');
  return t.status === 'DONE';
}, { timeoutMs: 600_000, everyMs: 3_000 });
const r1 = await until('R\'s landing to finish', () => landJobs('R').find((g) => g.finished) ?? null, { timeoutMs: 600_000, everyMs: 3_000 });
check('case 3: R\'s landing is CHECK_FAILED with baseline_red (BASELINE_RED)', r1.state === 'CHECK_FAILED' && r1.baselineRed,
  `${r1.state} baseline_red=${r1.baselineRed} job ${r1.id}`);
const rChecks = JSON.parse(row(`select checks::text from project_integration_job where id = ${lit(r1.id)}::uuid`) || '[]');
const combined = rChecks.find((c) => c.name === 'LANDING_CHECK' && c.scope !== 'BASELINE');
const baseline = rChecks.find((c) => c.name === 'LANDING_CHECK' && c.scope === 'BASELINE');
check('case 3: the landing check failed on the combined tree and on the baseline without R', combined?.exitCode === 3 && baseline?.exitCode === 3,
  `combined exit ${combined?.exitCode}, baseline exit ${baseline?.exitCode}`);
const item3 = itemOf(r1.id);
check('case 3: the item is BASELINE_RED and the coordinator\'s from the start, never offered to R\'s session', item3?.kind === 'INTEGRATION_CHECK_FAILED'
  && item3.failureClass === 'BASELINE_RED' && item3.assignee === 'COORDINATOR' && !item3.workSession && !item3.offeredAt, JSON.stringify(item3));
const coordRed = await until('the coordinator to get a turn about the red line', () => {
  const n = row(`${COORD_TURNS(r1.finished)} and (position('LINE_RED.md' in coalesce(content, '')) > 0
    or position(${lit(spec.R.title)} in coalesce(content, '')) > 0)`);
  return Number(n) > 0 ? n : null;
}, { timeoutMs: 300_000, everyMs: 3_000 }).catch(() => '0');
check('case 3: the coordinator got a turn about it', Number(coordRed) > 0, `${coordRed} turn(s) naming LINE_RED.md or R`);
await sleep(30_000); // room for a wrong delivery to show up before its absence is read
const rSession = r1.session;
const rTurnsAfter = row(`select count(*) from conversation_turn where session_id = ${lit(rSession)}::uuid
  and created_at > ${lit(r1.finished)}::timestamptz`);
check('case 3: R\'s session got no landing-fix turn and no turn at all after its landing', fixTurns(rSession).length === 0 && rTurnsAfter === '0',
  `landing-fix turns ${fixTurns(rSession).length}, turns after the landing ${rTurnsAfter}`);
const rSessionNow = rows(`select status, coalesce(end_reason, ''), finished_at is not null from session where id = ${lit(rSession)}::uuid`)[0];
check('case 3: R\'s session stayed ended by its task\'s DONE (not revived)', rSessionNow?.[1] === 'task_done' && rSessionNow?.[2] === 't', JSON.stringify(rSessionNow));

// ── records: read-only queries of the three tables, after the run ──────────────────────────────────────────────
const sess = (k) => `(select s.id from session s where s.task_id = ${taskRow(k)} and s.starts_task_work order by s.created_at limit 1)`;
ev.query('project_integration_job (LAND_TASK, every task)', `select t.title as task, j.id as job_id, j.generation, j.state, j.phase,
  j.conflicts, j.baseline_red, j.session_id, j.source_sha, j.landed_sha, j.retry_of_job_id, j.retry_failure_class, j.retry_reason,
  j.retry_requested_by_session_id, j.finished_at
from project_integration_job j join task t on t.id = j.task_id
where j.project_id = ${P} and j.kind = 'LAND_TASK' order by j.created_at`, true);
ev.query('project_integration_job (every job of the project, short)', `select j.kind, j.generation, j.state, t.title as task, j.created_at, j.finished_at
from project_integration_job j left join task t on t.id = j.task_id where j.project_id = ${P} order by j.created_at`);
ev.query('project_open_item (every item of the project)', `select i.kind, i.state, i.assignee, t.title as task, i.integration_job_id,
  i.payload->>'failureClass' as failure_class, i.work_session_id, i.work_session_offered_at, i.work_session_returned_at,
  i.work_session_return_reason, i.payload->'workSession' as work_session_payload, i.resolution, i.resolved_by_session_id,
  i.handling_session_id, i.escalate_at, i.created_at, i.resolved_at
from project_open_item i left join task t on t.id = i.task_id where i.project_id = ${P} order by i.created_at`, true);
for (const k of [X, Y, 'R']) {
  ev.query(`conversation_turn of ${k}'s work session`, `select t.seq, t.client_turn_id, t.kind, t.status, t.created_at, t.answered_at,
  left(t.content, 160) as content_head
from conversation_turn t where t.session_id = ${sess(k)} order by t.seq`, true);
}
ev.query('session rows of X, Y and R', `select t.title as task, s.id, s.status, s.end_reason, s.finished_at, s.base_sha, s.branch_sha,
  left(s.last_assistant_text, 200) as last_words
from session s join task t on t.id = s.task_id where s.id in (${sess(X)}, ${sess(Y)}, ${sess('R')}) order by t.title`, true);
ev.query('conversation_turn of the coordinator session', `select t.seq, t.client_turn_id, t.kind, t.status, t.created_at,
  left(replace(t.content, E'\\n', ' '), 220) as content_head,
  position(${lit(DECLINE_WORDS)} in coalesce(t.content, '')) > 0 as quotes_the_decline
from conversation_turn t where t.session_id = (select coordinator_session_id from project where id = ${P}) order by t.seq`, true);
ev.file(`origin-${REPO}.txt`, `${gitIn(origin(REPO), 'log', '--graph', '--format=%h %s', BRANCH, 'refs/heads/main')}\n\n`
  + `${gitIn(origin(REPO), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')}\n`);
const fake = logSince(`${SD}/logs/fake-claude.jsonl`, fakeMark).split('\n').filter(Boolean);
ev.file('fake-claude.jsonl', fake.join('\n') + '\n');
ev.file('checks.json', checks);
const failed = checks.filter((c) => !c.ok);
ev.say(failed.length ? `LFX42: ${failed.length} of ${checks.length} check(s) FAILED` : `LFX42: all ${checks.length} checks passed`);
await sleep(100);
process.exit(failed.length ? 1 : 0);
