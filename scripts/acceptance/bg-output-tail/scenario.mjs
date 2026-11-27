// The owner reads a running bg_run job's newest lines through GET /sessions/:id/background/jobs/:jobId/tail, on the
// isolated stack run.sh brings up. The fake engine starts one real job with bg_run through the session's own
// `orbit mcp`: it prints a coloured line every second. The owner allows its card and reads the tail twice, five seconds
// apart, as a client polls a card on screen: the second read's newest line is later than the first's, and neither has
// colour codes or more than 40 lines. Then an unknown id is refused, the agent kills the job, and its tail is read once
// more from the runner's file, now `killed`.
import { attempt, call, evidence, login, readState, sendTurn, until } from '../landing-measured/lib.mjs';
import { mcpAnswer } from '../landing-measured/lib.mjs';
import { randomUUID } from 'node:crypto';

const { say, file } = evidence('bg-output-tail');
const state = readState();
const T = await login();
const ws = state.workspaces?.bgtail;
if (!ws) throw new Error('no bgtail workspace: run bootstrap.mjs bgtail first');
const failures = [];
const check = (name, ok, detail) => {
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const run = randomUUID().slice(0, 8);
const command = `for i in $(seq 1 600); do printf '\\033[1;32mtick %d\\033[0m of the e2e job\\n' "$i"; sleep 1; done`;
const session = await call('POST', '/sessions', T, {
  workspaceId: ws.id, permissionMode: 'auto', engine: 'claude', title: `bg output tail ${run}`,
  prompt: `E2E-MCP tail-${run} bg_run ${JSON.stringify({ command, kind: 'job', wakeOnExit: true, description: 'output tail e2e: a tick a second' })}`,
});
say(`session ${session.id}`);
const jobId = /"jobId":\s*"(bgj_[0-9a-f]+)"/.exec((await mcpAnswer(`tail-${run}`)).text ?? '')?.[1];
say(`bg_run job ${jobId}`);
if (!jobId) throw new Error('bg_run did not answer with a job id');

// The session's agent asks before a background job starts: the owner allows the job's card.
const card = await until(`the card for ${jobId}`, async () =>
  (await call('GET', `/sessions/${session.id}/approvals`, T)).find((a) => a.backgroundJobId === jobId && a.status === 'PENDING'),
{ timeoutMs: 60_000 }).catch(() => null);
if (card) {
  await call('POST', `/sessions/${session.id}/approvals/${card.id}/decision`, T, { behavior: 'allow' });
  say(`allowed the card for ${jobId}`);
}
await until('the job to be listed running', async () =>
  (await call('GET', `/sessions/${session.id}/background`, T)).find((row) => row.shellId === jobId && row.status === 'running'),
{ timeoutMs: 60_000 });

const tail = (query = '') => attempt('GET', `/sessions/${session.id}/background/jobs/${jobId}/tail${query}`, T);
const tickOf = (line) => Number(/^tick (\d+) of the e2e job$/.exec(line ?? '')?.[1] ?? NaN);
const clean = (lines) => lines.every((line) => !line.includes('\x1b') && !/\[\d+(;\d+)*m/.test(line));

// Wait until it has written a few lines, then read as a client would with the card on screen.
const first = await until('the job to have written three ticks', async () => {
  const read = await tail();
  return read.ok && read.answer.lines.length >= 3 ? read : null;
}, { timeoutMs: 60_000 });
file('tail-1.json', first.answer);
const firstNewest = tickOf(first.answer.lines.at(-1));
say(`read 1 at ${first.answer.readAt}: ${first.answer.lines.length} lines, newest ${JSON.stringify(first.answer.lines.at(-1))}, ${first.answer.outputBytes} bytes`);
check('read 1: the running job answers its newest lines', first.answer.status === 'running' && first.answer.exitCode === null && Number.isFinite(firstNewest),
  JSON.stringify({ status: first.answer.status, newest: first.answer.lines.at(-1) }));
check('read 1: no colour codes', clean(first.answer.lines));

await new Promise((resolve) => setTimeout(resolve, 5_000)); // the client's pace while the card is on screen
const second = await tail('?lines=100');
file('tail-2.json', second);
const secondNewest = tickOf(second.answer?.lines.at(-1));
say(`read 2 at ${second.answer?.readAt}: ${second.answer?.lines.length} lines, newest ${JSON.stringify(second.answer?.lines.at(-1))}, ${second.answer?.outputBytes} bytes`);
check('read 2: the output grew, and the newest line is later', second.ok && secondNewest > firstNewest && second.answer.outputBytes > first.answer.outputBytes,
  `tick ${firstNewest} → ${secondNewest}, ${first.answer.outputBytes} → ${second.answer?.outputBytes} bytes`);
check('read 2: lines=100 answers at most 40 lines, all of them clean', second.ok && second.answer.lines.length <= 40 && clean(second.answer.lines));
check('read 2: within 8 KB', second.ok && Buffer.byteLength(second.answer.lines.join('\n'), 'utf8') <= 8192);

const unknown = await attempt('GET', `/sessions/${session.id}/background/jobs/bgj_000000000000/tail`, T);
check('an unknown job is 404 BACKGROUND_JOB_NOT_FOUND', unknown.status === 404 && unknown.body?.code === 'BACKGROUND_JOB_NOT_FOUND', JSON.stringify(unknown));
const bad = await attempt('GET', `/sessions/${session.id}/background/jobs/${jobId}/tail?lines=0`, T);
check('lines=0 is 400 INVALID_TAIL_LINES', bad.status === 400 && bad.body?.code === 'INVALID_TAIL_LINES', JSON.stringify(bad));

// The job ends; its session is still on the runner, so the runner still answers from the job's file.
await sendTurn(T, session.id, `E2E-MCP tailkill-${run} bg_kill ${JSON.stringify({ jobId })}`);
await mcpAnswer(`tailkill-${run}`);
const ended = await until('the killed job\'s tail', async () => {
  const read = await tail();
  return read.ok && read.answer.status === 'killed' ? read : null;
}, { timeoutMs: 60_000 });
file('tail-ended.json', ended.answer);
say(`read after the end: status ${ended.answer.status}, newest ${JSON.stringify(ended.answer.lines.at(-1))}`);
check('an ended job answers from the runner\'s file', tickOf(ended.answer.lines.at(-1)) >= secondNewest);

file('checks.json', { session: session.id, jobId, failures });
say(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
