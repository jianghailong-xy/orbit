// Third project, appended to seed.json by seed.mjs's caller: an AUTOMATIC project (coordinator enabled) whose one task
// serves a criterion while arguing it does not apply. When that work lands on the project branch but not on main,
// the server's wake disposition (projects/wake-disposition.service.ts, CRITERION_EXEMPTION_ARGUED) raises a real
// HUMAN_DECISION_REQUIRED blocker. A landing ends that blocker (resolvedBy AUTO), so this project's merge check is a
// fixture that FAILS on that delivery's tree (`test ! -f A11_STACK_NOTES.md`): the work stays unlanded, the blocker
// stays open, and the failed landing check is a real INTEGRATION_CHECK_FAILED item too.
// Everything through the real API; nothing written to the database directly.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { S, call, login, HttpError } from './lib.mjs';

const seed = JSON.parse(readFileSync(`${S}/seed.json`, 'utf8'));
const T = await login('owner');
const ws = seed.workspace.id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BRANCH = 'refs/heads/project/a11-blocker-check';
const CHECK = 'test ! -f A11_STACK_NOTES.md';  // fixture: fails once the exemption delivery is merged

let p = await call('POST', '/projects', T, {
  title: 'A11 Automatic project (blocker)',
  goal: 'Show a server-raised blocker: a delivery that argues one of its criteria does not apply.',
  instructions: 'Automatic: the coordinator runs this project. The exemption needs the owner\'s ruling.',
  acceptanceCriteriaItems: [
    { text: 'The user guide covers the new pages', verificationMethod: 'The owner reads the guide' },
    { text: 'The sandbox README still exists', verificationMethod: 'test -f README.md' },
  ],
  coordinatorEnabled: true,
  maxConcurrentTasks: 1,
  workspaceId: ws,
});
await call('PATCH', `/projects/${p.id}/integration`, T, {
  line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main', mergeCheckCommand: CHECK, mergeCheckTimeoutSeconds: 120,
});
p = await call('GET', `/projects/${p.id}`, T);
const task = await call('POST', '/tasks', T, {
  projectId: p.id, assigneeId: ws, autoRunWhenReady: false,
  title: 'Skip the user guide for this release', description: 'Serves criterion 1 while arguing it does not apply.',
  criterionKey: p.acceptanceCriteriaItems[0].key, labels: ['docs'],
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f A11_STACK_NOTES.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
  completionCriterionOverrideReason: 'Criterion 1 does not apply: this release adds no user-visible page.',
});
const conf = await call('GET', `/projects/${p.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${p.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'PROJECT_BRANCH', projectBranchName: BRANCH,
  automatic: true, maxConcurrentTasks: 1, mergeCheckCommand: CHECK,
});
try { await call('POST', `/tasks/${task.id}/execute`, T, { triggerId: randomUUID() }); } catch (e) { if (!(e instanceof HttpError)) throw e; }

let blockers = [];
let t = null;
for (let i = 0; i < 60 && blockers.length === 0; i++) {
  await sleep(4000);
  const cur = await call('GET', `/projects/${p.id}`, T);
  blockers = cur.blockers?.open ?? [];
  t = await call('GET', `/tasks/${task.id}`, T);
  if (i % 5 === 0) console.log(new Date().toISOString().slice(11, 19), 'task', t.status, 'blockers', blockers.length);
}
if (blockers.length) {
  await sleep(60_000);  // a landing would end it within ~20s; prove it stays
  blockers = (await call('GET', `/projects/${p.id}`, T)).blockers?.open ?? [];
  t = await call('GET', `/tasks/${task.id}`, T);
}
const items = await call('GET', `/projects/${p.id}/open-items`, T);
const promo = await call('GET', `/projects/${p.id}/promotions/current`, T).catch(() => null);
seed.projects.automatic = {
  id: p.id, title: p.title, startedAt: started.startedAt, settings: started.settings, coordinatorSessionId: p.coordinatorSessionId,
  tasks: { exemption: { id: task.id, title: task.title, status: t?.status } },
  blockers: blockers.map((b) => ({ id: b.id, kind: b.kind, owner: b.owner, recovery: b.recovery, requiredAction: b.requiredAction, subject: `${b.subjectType}:${b.subjectId}` })),
  openItems: [...items.needsYou, ...items.withCoordinator].map((i) => ({ id: i.itemId, kind: i.kind, title: i.title, assignee: i.assignee })),
  promotion: promo?.promotionId ? { id: promo.promotionId, state: promo.state } : null,
  how: 'POST /api/projects (+workspace) → PATCH integration → task with criterionKey + completionCriterionOverrideReason → POST start (automatic) → real run',
};
seed.refused = seed.refused.filter((r) => r.what !== 'blocker (server-raised)');
if (!blockers.length) seed.refused.push({ what: 'blocker (automatic project)', why: 'no blocker within 240s' });
writeFileSync(`${S}/seed.json`, JSON.stringify(seed, null, 2) + '\n');
console.log(JSON.stringify(seed.projects.automatic, null, 1));
