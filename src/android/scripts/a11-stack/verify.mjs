// Checks the seeded A11 stack through its real API and prints one line per capability. Read-mostly: it changes one
// task's priority and back (to see the SSE frame), and files + resolves one extra exception on the main project
// ("Resolve check" task) so the owner's resolve door is exercised without touching the seeded open items.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { API, S, call, HttpError } from './lib.mjs';

const seed = JSON.parse(readFileSync(`${S}/seed.json`, 'utf8'));
const acct = JSON.parse(readFileSync(`${S}/accounts.json`, 'utf8'));
const results = [];
const ok = (what, detail) => { results.push(['OK  ', what, detail]); };
const bad = (what, detail) => { results.push(['FAIL', what, detail]); };
async function check(what, fn) {
  try { ok(what, String(await fn()).slice(0, 160)); } catch (e) { bad(what, (e instanceof HttpError ? `${e.status} ${e.body}` : String(e?.message ?? e)).slice(0, 220)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads an SSE stream until `match` returns true for a parsed `data:` frame or the timeout passes.
async function sse(path, token, match, timeoutMs, during) {
  const ac = new AbortController();
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let seen = 0; let hit = null;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (during) setTimeout(() => during().catch(() => {}), 500);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        seen++;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (match(j)) { hit = j; ac.abort(); break; }
      }
      if (hit) break;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return { hit, seen };
}

const login = await call('POST', '/auth/login', undefined, { email: acct.owner.email, password: acct.owner.password });
const T = login.accessToken;
await check('auth: login + refresh (rotating refresh token)', async () => {
  const r = await call('POST', '/auth/refresh', undefined, { refreshToken: login.refreshToken });
  return `login ok, refresh ok (new refresh token differs: ${r.refreshToken !== login.refreshToken})`;
});
const M = (await call('POST', '/auth/login', undefined, { email: acct.member.email, password: acct.member.password })).accessToken;
await check('auth: member login', async () => `member role ${(await call('GET', '/users/me', M)).role}`);

const triage = seed.tasks.triage.id;
await check('SSE /api/events delivers task.changed', async () => {
  const { hit, seen } = await sse('/events', T, (j) => j.type === 'task.changed', 15_000, async () => {
    await call('PATCH', `/tasks/${triage}`, T, { priority: 3 });
    await sleep(300);
    await call('PATCH', `/tasks/${triage}`, T, { priority: 2 });
  });
  if (!hit) throw new Error(`no task.changed frame (saw ${seen} frames)`);
  return `got ${hit.type} after a PATCH (frames seen: ${seen})`;
});
await check('SSE /api/sessions/:id/events replays a real run', async () => {
  const t = await call('GET', `/tasks/${seed.tasks.prereq.id}`, T);
  const sid = t.sessions?.[0]?.id;
  if (!sid) throw new Error('prerequisite has no session');
  const { hit, seen } = await sse(`/sessions/${sid}/events?sinceSeq=0`, T, (j) => typeof j.seq === 'number' && j.type === 'turn_end', 10_000);
  if (!hit && seen === 0) throw new Error('no frames');
  return `session ${sid}: ${seen} frames${hit ? ', incl. turn_end' : ''}`;
});
await check('tasks: page / counts / labels ("Sprint, one")', async () => {
  const labels = await call('GET', '/tasks/labels', T);
  const sprint = labels.items.find((l) => l.label === 'Sprint, one');
  if (!sprint) throw new Error('label missing');
  const page = await call('GET', `/tasks/page?limit=100&labels=${encodeURIComponent('Sprint, one')}`, T);
  return `label total ${sprint.total} (done ${sprint.done}); filtered page ${page.items.length} items`;
});
await check('tasks: lists + paused list refuses Run', async () => {
  const lists = await call('GET', '/task-lists', T);
  try { await call('POST', `/tasks/${seed.tasks.inPaused.id}/execute`, T, { triggerId: randomUUID() }); return 'paused list did NOT refuse'; } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return `${lists.length} lists; execute in paused list → ${e.status}`;
  }
});
await check('tasks: dependency graph', async () => {
  const g = await call('GET', `/tasks/${seed.tasks.dependent.id}/dependency-graph?direction=both&maxNodes=50`, T);
  return `nodes ${(g.nodes ?? []).length}, edges ${(g.edges ?? []).length}`;
});
await check('tasks: scheduled runAt kept', async () => `runAt ${(await call('GET', `/tasks/${seed.tasks.scheduled.id}`, T)).runAt}`);
await check('tasks: statuses', async () => Object.entries(seed.tasks).map(([k, t]) => `${k}=${t.status}`).join(' '));
await check('share: public task link', async () => {
  const r = await fetch(`${API}/shared/${seed.shareLinks.task.token}`);
  return `GET /api/shared/<token> (no auth) → ${r.status}`;
});

const P = seed.projects.main.id;
for (const [what, path] of [
  ['project: document', `/projects/${P}`], ['project: panorama', `/projects/${P}/panorama`],
  ['project: integration', `/projects/${P}/integration`], ['project: open-items', `/projects/${P}/open-items`],
  ['project: coordinator status', `/projects/${P}/coordinator/status`], ['project: dependency graph', `/projects/${P}/dependency-graph`],
  ['project: acceptance confirmation', `/projects/${P}/acceptance/confirmation`], ['project: share', `/projects/${P}/share`],
  ['project: tasks page', `/projects/${P}/tasks/page?limit=200`], ['project: promotions/current', `/projects/${P}/promotions/current`],
]) {
  await check(what, async () => {
    const j = await call('GET', path, T);
    if (path.endsWith('/open-items')) return `needsYou ${j.needsYou.map((i) => i.kind).join(',') || '-'} | withCoordinator ${j.withCoordinator.map((i) => i.kind).join(',') || '-'} | settled ${j.settled.length}`;
    if (path.endsWith('/coordinator/status')) return `state ${j.state}, session ${j.coordination?.session?.runStatus}/${j.coordination?.session?.lifecycleState}`;
    if (path.endsWith('/integration')) return `line ${j.line} ref ${j.ref} locked ${j.locked} queued ${j.queuedCount} check ${j.mergeCheckOnTip}`;
    if (path.endsWith('/promotions/current')) return j?.promotionId ? `promotion ${j.promotionId} state ${j.state} ${j.sourceRef}→${j.upstreamRef}` : 'none';
    if (path === `/projects/${P}`) return `status ${j.status}, started ${!!j.startedAt}, blockers open ${j.blockers?.open?.length ?? 0}`;
    return 'ok';
  });
}

// The owner's resolve door, on an exception of its own: a second failing run, then resolved by the owner.
await check('open items: real TASK_FAILED → owner resolve', async () => {
  const ws = seed.workspace.id;
  const t = await call('POST', '/tasks', T, { projectId: P, assigneeId: ws, autoRunWhenReady: false, title: 'Resolve check (verify.mjs)', description: 'A11-FAIL: fails on purpose; verify.mjs resolves its exception.', completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF' });
  await call('POST', `/tasks/${t.id}/execute`, T, { triggerId: randomUUID() });
  let item = null;
  for (let i = 0; i < 40 && !item; i++) {
    await sleep(2000);
    const oi = await call('GET', `/projects/${P}/open-items`, T);
    item = [...oi.needsYou, ...oi.withCoordinator].find((x) => x.taskId === t.id && x.kind === 'TASK_FAILED');
  }
  if (!item) throw new Error('no TASK_FAILED item appeared');
  const r = await call('POST', `/projects/${P}/open-items/${item.itemId}/resolve`, T, { note: 'Checked by verify.mjs; nothing to retry.' });
  return `item ${item.itemId} (${item.assignee}) resolved → ${JSON.stringify(r).slice(0, 80)}`;
});

const Q = seed.projects.notStarted.id;
await check('project 2: not started + start flow inputs', async () => {
  const p = await call('GET', `/projects/${Q}`, T);
  const c = await call('GET', `/projects/${Q}/acceptance/confirmation`, T);
  return `status ${p.status}, startedAt ${p.startedAt}, digest ${c.currentVersion.digest.slice(0, 12)}…`;
});
await check('member: cannot read the owner\'s project/task', async () => {
  const r1 = await call('GET', `/projects/${P}`, M).then(() => '200', (e) => e.status);
  const r2 = await call('GET', `/tasks/${seed.tasks.prereq.id}`, M).then(() => '200', (e) => e.status);
  return `project → ${r1}, task → ${r2}`;
});
await check('runner: online', async () => {
  const r = (await call('GET', '/runners', T)).find((x) => x.id === seed.runner.id);
  return `${r.name} online=${r.online} version=${r.version}`;
});

for (const [s, what, detail] of results) console.log(`${s} ${what.padEnd(48)} ${detail}`);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
