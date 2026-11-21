// The owner stops one running bg_run job through POST /sessions/:id/background/jobs/:jobId/stop, on the isolated stack
// run.sh brings up. The fake engine starts two real `sleep 600` jobs with bg_run (wakeOnExit) through the session's own
// `orbit mcp`, the owner allows each job's card, and stops the first; the agent kills the second with bg_kill. Checked: the stop's answer, the
// background list (killed, reason stopped_by_owner, not stoppable; the agent's kill keeps `requested`), the job's
// wake row, the wake block the runner delivered to the engine (it names the person), and a repeat stop (200 killed).
import { attempt, call, evidence, login, publicIdToUuid, readState, sendTurn, until } from '../landing-measured/lib.mjs';
import { mcpAnswer } from '../landing-measured/lib.mjs';
import { randomUUID } from 'node:crypto';

const { say, file, query } = evidence('bg-owner-stop');
const state = readState();
const T = await login();
const ws = state.workspaces?.bgstop;
if (!ws) throw new Error('no bgstop workspace: run bootstrap.mjs bgstop first');
const failures = [];
const check = (name, ok, detail) => {
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const run = randomUUID().slice(0, 8);
const job = (id, description) =>
  `E2E-MCP ${id} bg_run ${JSON.stringify({ command: 'sleep 600', kind: 'job', wakeOnExit: true, description })}`;
const session = await call('POST', '/sessions', T, {
  workspaceId: ws.id, permissionMode: 'auto', engine: 'claude', title: `bg owner stop ${run}`,
  prompt: [job(`stop-${run}`, 'owner stop e2e: the person stops this sleep'), job(`kill-${run}`, 'owner stop e2e: the agent kills this sleep')].join('\n'),
});
say(`session ${session.id}`);
const jobIdOf = (answer) => /"jobId":\s*"(bgj_[0-9a-f]+)"/.exec(answer.text ?? '')?.[1];
const stopped = jobIdOf(await mcpAnswer(`stop-${run}`));
const killed = jobIdOf(await mcpAnswer(`kill-${run}`));
say(`bg_run jobs: owner-stopped ${stopped}, agent-killed ${killed}`);
if (!stopped || !killed) throw new Error('bg_run did not answer with job ids');

// The session's agent asks before a background job starts (Default mode): the owner allows each job's card.
for (const jobId of [stopped, killed]) {
  const card = await until(`the card for ${jobId}`, async () =>
    (await call('GET', `/sessions/${session.id}/approvals`, T)).find((a) => a.backgroundJobId === jobId && a.status === 'PENDING'),
  { timeoutMs: 60_000 });
  await call('POST', `/sessions/${session.id}/approvals/${card.id}/decision`, T, { behavior: 'allow' });
  say(`allowed the card for ${jobId}`);
}

const list = async () => new Map((await call('GET', `/sessions/${session.id}/background`, T)).map((row) => [row.shellId, row]));
const running = await until('both jobs to be listed running', async () => {
  const rows = await list();
  return rows.get(stopped)?.status === 'running' && rows.get(killed)?.status === 'running' ? rows : null;
}, { timeoutMs: 60_000 });
check('a running job on this runner is stoppable', running.get(stopped).stoppable === true, JSON.stringify(running.get(stopped)));

const first = await attempt('POST', `/sessions/${session.id}/background/jobs/${stopped}/stop`, T);
file('stop-1.json', first);
check('the stop answers stopping', first.ok && first.answer.status === 'stopping', JSON.stringify(first));
const unknown = await attempt('POST', `/sessions/${session.id}/background/jobs/bgj_000000000000/stop`, T);
check('an unknown job is 404 BACKGROUND_JOB_NOT_FOUND', unknown.status === 404 && unknown.body?.code === 'BACKGROUND_JOB_NOT_FOUND', JSON.stringify(unknown));

await sendTurn(T, session.id, `E2E-MCP bgkill-${run} bg_kill ${JSON.stringify({ jobId: killed })}`);
await mcpAnswer(`bgkill-${run}`);

const ended = await until('both jobs to be listed killed', async () => {
  const rows = await list();
  return rows.get(stopped)?.status === 'killed' && rows.get(killed)?.status === 'killed' ? rows : null;
}, { timeoutMs: 120_000 });
file('background-after.json', [...ended.values()]);
const s = ended.get(stopped), k = ended.get(killed);
check('GET /background: the owner-stopped job is killed, reason stopped_by_owner, not stoppable',
  s.reason === 'stopped_by_owner' && s.stoppable === false, JSON.stringify({ status: s.status, reason: s.reason, stoppable: s.stoppable }));
check('GET /background: the agent-killed job keeps reason requested', k.reason === 'requested', JSON.stringify({ status: k.status, reason: k.reason }));

const again = await attempt('POST', `/sessions/${session.id}/background/jobs/${stopped}/stop`, T);
check('a repeat stop is idempotent: 200 killed', again.ok && again.answer.status === 'killed', JSON.stringify(again));
const other = await attempt('POST', `/sessions/${session.id}/background/jobs/${killed}/stop`, T);
check('a job the agent killed is 409 BACKGROUND_JOB_ENDED', other.status === 409 && other.body?.code === 'BACKGROUND_JOB_ENDED', JSON.stringify(other));

const sid = publicIdToUuid(session.id);
const wakes = query('wake rows', `select job_id, trigger, status, reason from background_job_wake where session_id = '${sid}' order by created_at`);
say(`wake rows:\n${wakes}`);
check('the owner-stopped job has an exit wake with reason stopped_by_owner',
  new RegExp(`${stopped}\\s*\\|\\s*exit\\s*\\|\\s*killed\\s*\\|\\s*stopped_by_owner`).test(wakes));
check('the agent\'s own bg_kill sent no exit wake', !new RegExp(`${killed}\\s*\\|\\s*exit`).test(wakes));

// The block the runner handed the engine for that exit wake, as the session's events carry it: not the output wake
// the card's answer sent before it.
const block = await until('the wake block to reach the engine', async () => {
  const page = await call('GET', `/sessions/${session.id}/events/page?tail=200`, T);
  const events = page.events ?? page;
  for (const ev of events) {
    const text = JSON.stringify(ev.payload ?? '');
    if (text.includes('<background-job-wake>') && text.includes(`${stopped}｜`) && text.includes('reason stopped_by_owner')) return JSON.parse(text);
  }
  return null;
}, { timeoutMs: 120_000 });
const blockText = typeof block === 'string' ? block : JSON.stringify(block);
file('wake-block.json', block);
const reasonLine = /ended｜killed｜reason stopped_by_owner \([^)]*\)/.exec(blockText)?.[0];
say(`wake block line: ${reasonLine}`);
check('the wake block says the person who owns the session stopped it', /the person who owns this session stopped it from the app/.test(blockText));

file('checks.json', { session: session.id, stopped, killed, failures });
say(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
