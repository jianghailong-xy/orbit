// Refreshes seed.json → finalState from the live stack (statuses, open items, blockers, promotions). Read-only.
import { readFileSync, writeFileSync } from 'node:fs';
import { S, call, login } from './lib.mjs';
const seed = JSON.parse(readFileSync(`${S}/seed.json`, 'utf8'));
const T = await login('owner');
const st = async (id) => { const t = await call('GET', `/tasks/${id}`, T); return { id, title: t.title, status: t.status }; };
const fin = { at: new Date().toISOString(), tasks: {}, projects: {} };
for (const [k, t] of Object.entries(seed.tasks)) if (k !== 'memberTask') fin.tasks[k] = (await st(t.id)).status;
for (const [k, p] of Object.entries(seed.projects)) {
  const doc = await call('GET', `/projects/${p.id}`, T);
  const oi = await call('GET', `/projects/${p.id}/open-items`, T);
  const promo = await call('GET', `/projects/${p.id}/promotions/current`, T).catch(() => null);
  const page = await call('GET', `/projects/${p.id}/tasks/page?limit=200`, T);
  fin.projects[k] = {
    id: p.id, title: doc.title, status: doc.status, started: !!doc.startedAt, coordinatorEnabled: doc.coordinatorEnabled,
    tasks: page.items.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    openItems: [...oi.needsYou.map((i) => ({ ...i, where: 'needsYou' })), ...oi.withCoordinator.map((i) => ({ ...i, where: 'withCoordinator' }))]
      .map((i) => ({ id: i.itemId, kind: i.kind, title: i.title, assignee: i.assignee, assigneeReason: i.assigneeReason, where: i.where, taskId: i.taskId ?? null, promotionId: i.promotionId ?? null })),
    settledItems: oi.settled.map((i) => ({ id: i.itemId, kind: i.kind, title: i.title })),
    blockersOpen: (doc.blockers?.open ?? []).map((b) => ({ id: b.id, kind: b.kind, subject: `${b.subjectType}:${b.subjectId}` })),
    promotion: promo?.promotionId ? { id: promo.promotionId, state: promo.state, tasks: promo.taskIds } : null,
  };
}
seed.finalState = fin;
writeFileSync(`${S}/seed.json`, JSON.stringify(seed, null, 2) + '\n');
console.log(JSON.stringify(fin, null, 1));
