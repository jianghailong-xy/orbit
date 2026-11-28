// A session with more mode changes than its detail carries, recorded through the server's own write paths on the seeded
// stack (run after seed.mjs), and its detail and older pages read back over HTTP and kept unedited for the clients' wire
// tests:
//   CLAIM              QueueService.claimSessionForRunner
//   OWNER_PICK         PATCH /sessions/:id/config from the web, iOS and Android, then the inbox's setconfig, acknowledged
//   ENGINE_REPORT and  RunnerApiController.events: batches of Claude's init-frame report (Default) and the runner's
//   RUNNER_CORRECTION  correction (Auto), four times each per batch: one ingest, a few milliseconds
// 1 claim + 6 picks + 13 batches of 8 = 111 changes: the detail carries the newest 50, the page before it 50 more, and the
// page before that the last 11 with hasMore false.
// The one write not made through those paths: each batch's eight rows are then stamped with the batch's first instant, as
// the pg spec does (actual-permission-mode.pg.spec.ts case 5). created_at keeps milliseconds only, and whether a burst lands
// inside one is the host's timing (one run here gave one such pair, the next none); stamped, every batch is the same
// transition four times at one moment, and both page boundaries (the 50th and 100th change from the newest) fall inside a
// batch, so a page can only continue from the right change by its seq.
//
//   node scripts/permission-mode-actual-stack/capture-paging.mjs <out dir>
// writes session-paging.json (GET /sessions/:id), session-paging-page-1.json and session-paging-page-2.json
// (GET /sessions/:id/permission-mode-changes?before=<the oldest seq held>), as the server answered them, pretty-printed.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { API, WT, agentToolsReport, call, fromApp, heartbeat, iso, readState, services, sessionLease, sleep, until } from './lib.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: capture-paging.mjs <out dir>');
mkdirSync(out, { recursive: true });
const { toUuid } = createRequire(`${WT}/src/apiserver/dist/main.js`)('@orbit/shared');
const state = readState();
const { accessToken: owner } = await call('POST', '/auth/login', undefined, { email: state.owner.email, password: state.owner.password });
const { prisma, queue, api } = services();
const r = state.runners['workstation-gpu'];
const log = (line) => console.log(`${iso()} ${line}`);

const title = 'Flip the flag back and forth';
const created = await call('POST', '/sessions', owner, {
  workspaceId: state.workspaces[r.name].id, title, prompt: 'Toggle the feature flag until the canary settles.',
  provider: 'claude', engine: 'claude', model: 'claude-opus-5-5', permissionMode: 'auto',
});
await heartbeat(api, r);
const job = await queue.claimSessionForRunner({ id: r.runnerId });
if (job?.title !== title) throw new Error(`the runner claimed ${JSON.stringify(job?.title)}, made "${title}"`);
const s = { id: created.id, uuid: job.sessionId ?? toUuid(created.id), seq: 0 };

const fetchTurn = (kind) => until(`a ${kind ?? 'first'} turn`, async () => {
  try {
    const turn = await api.inbox({ id: r.runnerId }, s.uuid, await sessionLease(prisma, s.uuid));
    return turn?.turnId && (!kind || turn.kind === kind) ? turn : null;
  } catch (error) {
    if (error?.code === 'P2028') return null;
    throw error;
  }
});
const events = (...items) => api.events({ id: r.runnerId }, s.uuid, {
  events: items.map(([type, payload, turnId]) => ({ seq: ++s.seq, type, ts: iso(), ...(turnId ? { turnId } : {}), payload })),
});
const opening = await fetchTurn();
await events(['user', { text: 'Toggle the feature flag until the canary settles.' }, opening.turnId]);
await events(['assistant', { text: 'Starting with the canary at 5%.' }, opening.turnId], ['turn_end', {}, opening.turnId]);
await api.turnComplete({ id: r.runnerId }, s.uuid, { turnId: opening.turnId, status: 'SUCCEEDED', result: 'Starting with the canary at 5%.' });

// The owner's picks from three apps, each taken by the runner as a setconfig.
for (const [mode, app, device] of [['plan', 'web'], ['auto', 'ios', 'iphone'], ['acceptEdits', 'android'], ['auto', 'web'],
  ['plan', 'ios', 'iphone'], ['auto', 'android']]) {
  await call('PATCH', `/sessions/${s.id}/config`, owner, { permissionMode: mode }, fromApp(app, device));
  const turn = await fetchTurn('setconfig');
  await api.turnComplete({ id: r.runnerId }, s.uuid, {
    turnId: turn.turnId, status: 'SUCCEEDED', subtype: 'setconfig', result: `applied to the running engine: permission mode "${mode}"`,
  });
  log(`picked ${mode} from ${app}`);
  await sleep(50);
}
// Thirteen batches, each in one ingest: Default reported and corrected to Auto, four times over.
const report = (mode) => ['system', { subtype: 'agent_tools', agentTools: agentToolsReport(mode) }];
const corrected = ['system', { subtype: 'permission_mode_corrected', mode: 'auto' }];
for (let batch = 0; batch < 13; batch += 1) {
  await events(...Array.from({ length: 4 }, () => [report('default'), corrected]).flat());
  await sleep(20);
}

const recorded = await prisma.sessionPermissionModeChange.findMany({
  where: { sessionId: s.uuid }, orderBy: { seq: 'asc' }, select: { id: true },
});
if (recorded.length !== 111) throw new Error(`recorded ${recorded.length} changes, not 111`);
for (let batch = 0; batch < 13; batch += 1) {
  const ids = recorded.slice(7 + batch * 8, 15 + batch * 8).map((row) => row.id);
  await prisma.$executeRaw`UPDATE "session_permission_mode_change" SET "created_at" =
    (SELECT min("created_at") FROM "session_permission_mode_change" WHERE "id" = ANY(${ids}::uuid[])) WHERE "id" = ANY(${ids}::uuid[])`;
}

// Read back as a client reads it: the detail, then the pages before its oldest change until none remain.
async function raw(path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${owner}`, ...fromApp('android') } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const detail = await raw(`/sessions/${s.id}`);
writeFileSync(`${out}/session-paging.json`, JSON.stringify(detail, null, 2) + '\n');
let oldest = detail.permissionModeChanges[0].seq;
let hasMore = detail.permissionModeChangesHasMore;
let total = detail.permissionModeChanges.length;
for (let page = 1; hasMore; page += 1) {
  const body = await raw(`/sessions/${s.id}/permission-mode-changes?before=${oldest}`);
  writeFileSync(`${out}/session-paging-page-${page}.json`, JSON.stringify(body, null, 2) + '\n');
  log(`page ${page} before=${oldest}: ${body.changes.length} change(s), hasMore ${body.hasMore}`);
  total += body.changes.length;
  oldest = body.changes[0]?.seq;
  hasMore = body.hasMore;
}
const ats = detail.permissionModeChanges.map((c) => c.at);
log(`detail: ${detail.permissionModeChanges.length} change(s), hasMore ${detail.permissionModeChangesHasMore}; ${total} in all; ` +
  `the detail holds ${new Set(ats).size} distinct instants`);
await prisma.$disconnect();
process.exit(0);
