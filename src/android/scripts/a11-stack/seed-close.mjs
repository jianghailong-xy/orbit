// A11c: what the owner answers on the stack's own server (run after seed-start.mjs; setup.sh seed runs it).
//   closeAsked, closeDecline: coordinated projects whose one criterion is met (its task the owner confirmed), each with its
//     coordinator's "Is this project done?" filed the way `project_request_done` files it — the stack runner's token and that
//     coordinator session (POST /runner/projects/:id/done-requests) — with one gap the coordinator checked by hand.
//   crossFrom → crossTo: two of crossFrom's tasks its coordinator asked to move into crossTo the way `task_update` asks
//     (PATCH /runner/tasks/:id with projectId + handoff, X-Orbit-Session-Id), both waiting for the owner's answer.
//   runQueue: a started manual project with one task set to start by hand, ready (the page's Run).
// HTTP only, loopback only (lib.mjs); ids are added to seed.json under projects.closeAsked / closeDecline / crossFrom /
// crossTo / runQueue.
import { readFileSync, writeFileSync } from 'node:fs';
import { API, S, call, HttpError, login, readSeed, seedFile } from './lib.mjs';

const seed = readSeed();
const T = await login('owner');
const ws = seed.workspace.id;
const runnerToken = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8')).runnerToken;
const save = () => writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');
const OWNER_OK = { completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF' };
const asCoordinator = (sessionId) => ({ 'x-orbit-session-id': sessionId });

// ── close-out: the coordinator asks whether the project is done ────────────────────────────────────
async function closing(title) {
  const project = await call('POST', '/projects', T, {
    title, goal: 'Publish the A11c release notes to the internal testers.',
    instructions: 'A11c close-out check on the isolated stack.',
    acceptanceCriteriaItems: [{ text: 'The release notes are published', verificationMethod: 'The owner confirms the publishing task' }],
    maxConcurrentTasks: 1, workspaceId: ws,
  });
  const key = (await call('GET', `/projects/${project.id}`, T)).acceptanceCriteriaItems[0].key;
  const task = await call('POST', '/tasks', T, {
    projectId: project.id, assigneeId: ws, title: 'Publish the release notes', criterionKey: key, autoRunWhenReady: false, ...OWNER_OK,
  });
  await call('POST', `/tasks/${task.id}/owner-confirmation`, T, { decision: 'CONFIRM', note: 'Published for the A11c check.' });
  const coordinator = await call('POST', `/projects/${project.id}/coordinator`, T, { workspaceId: ws });
  const request = await call('POST', `/runner/projects/${project.id}/done-requests`, runnerToken, {
    judgment: 'The goal is met: the release notes are published. I read the published page myself.',
    gaps: [{
      criterionKey: key, title: 'Published page',
      whyNotProven: 'Publishing happens outside the repository, so no merge records it.',
      coordinatorChecked: 'the testers’ notes page lists this release', evidenceRefs: ['notes-page'],
    }],
  }, asCoordinator(coordinator.sessionId));
  return {
    id: project.id, title: project.title, criterionKey: key, taskId: task.id, coordinatorSessionId: coordinator.sessionId,
    request: { itemId: request.itemId, state: request.state, warnings: (request.warnings ?? []).map((w) => w.code) },
    how: 'owner-confirmed task, POST /projects/:id/coordinator, then POST /runner/projects/:id/done-requests (runner token + X-Orbit-Session-Id)',
  };
}
seed.projects.closeAsked = await closing('A11c Release notes (asked to close)');
seed.projects.closeDecline = await closing('A11c Release notes (not yet)');
save();

// ── crossings: a coordinator asks to move two of its tasks into another project ─────────────────────
const crossTo = await call('POST', '/projects', T, {
  title: 'A11c Android launch', goal: 'Launch the Android client to internal testers.',
  instructions: 'A11c crossings check: the target of two move requests.',
  acceptanceCriteriaItems: [{ text: 'Testers have the build', verificationMethod: 'The owner confirms the launch' }], maxConcurrentTasks: 1,
});
const crossFrom = await call('POST', '/projects', T, {
  title: 'A11c Runner hardening', goal: 'Keep the runner up through restarts.',
  instructions: 'A11c crossings check: its coordinator asks to move two tasks to the launch.',
  acceptanceCriteriaItems: [{ text: 'The runner survives a restart', verificationMethod: 'The owner confirms the restart drill' }],
  maxConcurrentTasks: 1, workspaceId: ws,
});
const fromCoordinator = await call('POST', `/projects/${crossFrom.id}/coordinator`, T, { workspaceId: ws });
const moved = {};
for (const [key, title] of [['approve', 'A11c tester checklist'], ['refuse', 'A11c store screenshots']]) {
  const task = await call('POST', '/tasks', T, { projectId: crossFrom.id, assigneeId: ws, title, autoRunWhenReady: false, ...OWNER_OK });
  // Filing the request is not a write of the task: the door answers 403 with the crossing it filed, and moves nothing.
  let filed;
  try {
    await call('PATCH', `/runner/tasks/${task.id}`, runnerToken, { projectId: crossTo.id, handoff: { reason: `${title} belongs to the launch` } },
      asCoordinator(fromCoordinator.sessionId));
    throw new Error(`moving ${task.id} was written instead of asked`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 403) throw e;
    filed = JSON.parse(e.body);
  }
  if (!filed.handoffId || filed.handoffState !== 'PENDING') throw new Error(`no pending crossing for ${task.id}: ${JSON.stringify(filed).slice(0, 400)}`);
  moved[key] = { taskId: task.id, title, handoffId: filed.handoffId, code: filed.code ?? null };
}
seed.projects.crossFrom = { id: crossFrom.id, title: crossFrom.title, coordinatorSessionId: fromCoordinator.sessionId };
seed.projects.crossTo = { id: crossTo.id, title: crossTo.title, moves: moved,
  how: 'PATCH /runner/tasks/:id {projectId, handoff} from crossFrom\'s coordinator (runner token + X-Orbit-Session-Id) → 403 with the PENDING crossing' };
save();

// ── run queue: one task set to start by hand, ready ─────────────────────────────────────────────────
const queue = await call('POST', '/projects', T, {
  title: 'A11c Run queue', goal: 'Run the tester build by hand.', instructions: 'A11c Run check: started manually, nothing runs by itself.',
  acceptanceCriteriaItems: [{ text: 'The tester build is made', verificationMethod: 'test -f A11_STACK_NOTES.md after the build task' }], maxConcurrentTasks: 1,
});
const queueKey = (await call('GET', `/projects/${queue.id}`, T)).acceptanceCriteriaItems[0].key;
const queued = await call('POST', '/tasks', T, {
  projectId: queue.id, assigneeId: ws, title: 'Make the tester build', description: 'Run by hand from the project page (A11c); the fake engine appends to A11_STACK_NOTES.md.',
  criterionKey: queueKey, autoRunWhenReady: false, acceptanceCriteria: 'A11_STACK_NOTES.md exists in the run\'s worktree when the run ends.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f A11_STACK_NOTES.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
});
const digest = (await call('GET', `/projects/${queue.id}/acceptance/confirmation`, T)).currentVersion.digest;
await call('POST', `/projects/${queue.id}/start`, T, { criteriaDigest: digest, line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null });
const ready = await call('GET', `/projects/${queue.id}/panorama/ready?limit=5`, T);
seed.projects.runQueue = { id: queue.id, title: queue.title, taskId: queued.id, manualReady: ready.manualReady?.count ?? null };
save();
console.log(JSON.stringify({ api: API, closeAsked: seed.projects.closeAsked.request, closeDecline: seed.projects.closeDecline.request,
  crossings: moved, runQueue: seed.projects.runQueue }, null, 1));
