// A08c: after the owner answered the two seed-a08c.mjs cards on Android, the runner's part, as its MCP tools play it, and what
// the server then holds — read back as the owner:
//   the cards: GET /sessions/:id/approvals (status, decider, message);
//   batch:     allowed → POST /runner/tasks/batch-create with the same tasks (`createBatchWithApproval`), then each task read back;
//   merge:     a check the owner never saw is refused (PATCH /runner/projects/:id, another command), the one they allowed is
//              written (`updateProjectWithApproval`), and the project read back says which check it now runs.
// Prints one JSON report. HTTP only, loopback only (lib.mjs).
import { readFileSync } from 'node:fs';
import { S, call, HttpError, login, readSeed } from './lib.mjs';

const seed = readSeed();
const a = seed.a08c;
const owner = await login('owner');
const runner = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8')).runnerToken;
const as = { 'x-orbit-session-id': a.sessionId };
const refusal = async (fn) => { try { return { status: 200, body: await fn() }; } catch (e) { if (!(e instanceof HttpError)) throw e; return { status: e.status, body: e.body.slice(0, 400) }; } };

const cards = await call('GET', `/sessions/${a.sessionId}/approvals`, owner);
// The runner's door answers with the row's uuid and the owner's read with its public id: one id, two spellings.
const publicId = (id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  let n = BigInt('0x' + id.replace(/-/g, '')), out = '';
  while (n > 0n) { out = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[Number(n % 62n)] + out; n /= 62n; }
  return out;
};
const card = (id) => { const row = cards.find((c) => publicId(c.id) === publicId(id));
  return row && { id: row.id, toolName: row.toolName, status: row.status, decidedAt: row.decidedAt ?? null, message: row.message ?? null }; };
const report = { sessionId: a.sessionId, batch: { card: card(a.batch.approvalId) }, merge: { card: card(a.merge.approvalId) } };

if (report.batch.card?.status === 'ALLOWED') {
  const created = await call('POST', '/runner/tasks/batch-create', runner, { tasks: a.batch.tasks }, { 'x-orbit-agent-id': seed.workspace.id, ...as });
  const rows = Array.isArray(created) ? created : created.tasks ?? created.items ?? created.created ?? [];
  report.batch.created = [];
  for (const row of rows) {
    const t = await call('GET', `/tasks/${row.id}`, owner);
    report.batch.created.push({ id: t.id, ref: row.ref ?? null, title: t.title, projectId: t.projectId ?? t.project?.id ?? null,
      waitsOn: (t.dependsOn ?? []).map((d) => d.dependsOnTaskId) });
  }
}
const before = await call('GET', `/projects/${a.projectId}`, owner);
report.merge.before = before.integration?.mergeCheckCommand ?? null;
report.merge.unanswered = await refusal(() => call('PATCH', `/runner/projects/${a.projectId}`, runner,
  { integration: { mergeCheckCommand: 'npm run e2e' } }, as));
report.merge.answered = await refusal(() => call('PATCH', `/runner/projects/${a.projectId}`, runner,
  { integration: { mergeCheckCommand: a.merge.input.mergeCheckCommand } }, as));
if (report.merge.answered.status === 200) report.merge.answered.body = { integration: report.merge.answered.body?.integration ?? null };
report.merge.after = (await call('GET', `/projects/${a.projectId}`, owner)).integration?.mergeCheckCommand ?? null;
report.merge.proposed = a.merge.input.mergeCheckCommand;
// The job that read the cards ends, as the CLI's does once its answers are in (a terminal background_task, A08C_LEASE_OWNER as
// for the seed's running report).
const owner2 = await login('owner');
const seq = Math.max(0, ...(await call('GET', `/sessions/${a.sessionId}/events/page?tail=1`, owner2)).events.map((e) => e.seq)) + 1;
await call('POST', `/runner/sessions/${a.sessionId}/events`, runner, { leaseOwner: process.env.A08C_LEASE_OWNER || undefined, events: [{ seq,
  type: 'background_task', ts: new Date().toISOString(), payload: { shellId: a.job.id, toolUseId: a.job.id, status: 'completed', kind: 'job', exitCode: 0 } }] });
report.job = { id: a.job.id, ended: true };
console.log(JSON.stringify(report, null, 1));
