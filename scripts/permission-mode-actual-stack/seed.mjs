// Seeds the running-mode stack on a fresh database through the server's own write paths, and writes state.json (0600) for
// capture.mjs. The owner's side is the stack's HTTP API: POST /auth/bootstrap, /runners/enrollment-tokens, /runner/register,
// /workspaces, /sessions, /sessions/:id/turns, and PATCH /sessions/:id/config with the app's x-orbit-client header. The
// runner's side is the production services (lib.mjs services(): this server takes runner calls only over the runner link).
// Every mode fact is the server's own record of what happened:
//   CLAIM              QueueService.claimSessionForRunner records the mode it hands the runner
//   ENGINE_REPORT      RunnerApiController.events: an Agent Tools report carrying Claude Code's settled mode
//   RUNNER_CORRECTION  the same ingest: a `permission_mode_corrected` system event
//   OWNER_PICK         PATCH /sessions/:id/config from an app, then the inbox's setconfig, acknowledged by turnComplete
//   ORBIT_CHANGE       SessionsService.updateConfig with origin ORBIT (TasksService.movePausedRunToPinnedModel's call), acked
//   RESPAWN            the ingest: `resumed`, then the re-spawned engine's report, in one batch
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { WT, agentToolsReport, call, fromApp, heartbeat, iso, services, sessionLease, sleep, until, writeState } from './lib.mjs';

// The owner API answers public ids; the services take UUIDs (@orbit/shared's codec, as built for this checkout).
const { toUuid } = createRequire(`${WT}/src/apiserver/dist/main.js`)('@orbit/shared');

const version = JSON.parse(readFileSync(`${WT}/package.json`, 'utf8')).version;
const OWNER = { email: 'owner@pma-stack.test', name: 'Mode Stack Owner', password: randomUUID() };
const boot = await call('POST', '/auth/bootstrap', undefined, OWNER);
const owner = boot.accessToken;
const state = { owner: { ...OWNER, id: boot.user.id, uuid: toUuid(boot.user.id) }, runners: {}, workspaces: {}, sessions: {} };
const log = (line) => console.log(`${iso()} ${line}`);
const { prisma, queue, sessions, api } = services();

// ── two runners: registered through the API, beating through the controller ───────────────────────────────────────────────
for (const [name, runsAsRoot] of [['workstation-gpu', false], ['root-runner', true]]) {
  const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
  const reg = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: `${name}-host`, version, maxConcurrent: 4 });
  state.runners[name] = { name, runnerId: reg.runnerId, runnerToken: reg.runnerToken, leaseOwner: randomUUID(), runsAsRoot, version };
  await heartbeat(api, state.runners[name]);
}
const listed = await call('GET', '/runners', owner);
for (const r of Object.values(state.runners)) {
  const row = listed.find((x) => x.name === r.name);
  r.publicId = row.id;
  log(`runner ${r.name}: ${row.id} online=${row.online} runsAsRoot=${row.runsAsRoot}`);
}
for (const r of Object.values(state.runners)) {
  const ws = await call('POST', '/workspaces', owner, {
    name: r.runsAsRoot ? 'orbit-root' : 'orbit', description: 'Running-mode stack (no engine runs here)',
    runnerId: r.publicId, workDir: `/srv/${r.name}/orbit`, enableWorktree: false, defaultMergeTarget: 'main',
  });
  state.workspaces[r.name] = { id: ws.id, name: ws.name };
}
writeState(state);

// ── a session, as its runner has it ────────────────────────────────────────────────────────────────────────────────────────
async function startSession(key, { runnerName = 'workstation-gpu', title, prompt, model, permissionMode, redeployedAsRoot = false, wikiChat = false }) {
  const r = state.runners[runnerName];
  // Bypass is refused at admission on a runner that runs as root: this one is made while its runner says it does not, and the
  // runner is redeployed as root before the claim — the case the claim's substitution exists for.
  if (redeployedAsRoot) await heartbeat(api, { ...r, runsAsRoot: false });
  // A wiki chat is made through its own door, and named by the owner as the panel's history names it.
  const created = wikiChat
    ? await call('POST', `/wiki/spaces/${state.wiki.spaceId}/chats`, owner, {
        workspaceId: state.wiki.workspaceId, content: prompt, clientTurnId: randomUUID(), model, permissionMode,
      }, fromApp('web'))
    : await call('POST', '/sessions', owner, {
        workspaceId: state.workspaces[runnerName].id, title, prompt, provider: 'claude', engine: 'claude', model, permissionMode,
      });
  const id = wikiChat ? created.sessionId : created.id;
  if (wikiChat) await call('PATCH', `/sessions/${id}`, owner, { title }, fromApp('web'));
  await heartbeat(api, r);
  const job = await queue.claimSessionForRunner({ id: r.runnerId });
  if (job?.sessionId !== toUuid(id)) throw new Error(`${runnerName} claimed ${JSON.stringify(job?.title)}, made "${title}"`);
  const s = { key, id, uuid: job.sessionId, runnerName, runnerId: r.runnerId, title, seq: 0 };
  (wikiChat ? state.wikiChats : state.sessions)[key] = s;
  const opening = await fetchTurn(s);
  log(`${key}: claimed (handed ${job.agent.permissionMode}), opening turn ${opening.turnId}`);
  writeState(state);
  return { s, turnId: opening.turnId };
}
async function fetchTurn(s, kind, { timeoutMs = 60_000 } = {}) {
  return until(`a${kind ? ` ${kind}` : ''} turn for "${s.title}"`, async () => {
    try {
      const turn = await api.inbox({ id: s.runnerId }, s.uuid, await sessionLease(prisma, s.uuid));
      return turn?.turnId && (!kind || turn.kind === kind) ? turn : null;
    } catch (error) {
      // A dequeue whose transaction outlived Prisma's 5 s under the host's load (P2028) is tried again, as the runner would.
      if (error?.code === 'P2028') return null;
      throw error;
    }
  }, { timeoutMs });
}
const events = (s, ...items) => api.events({ id: s.runnerId }, s.uuid, {
  events: items.map(([type, payload, turnId]) => ({ seq: ++s.seq, type, ts: iso(), ...(turnId ? { turnId } : {}), payload })),
});
const report = (s, mode, turnId) => events(s, ['system', { subtype: 'agent_tools', agentTools: agentToolsReport(mode) }, turnId]);
/** One exchange of the engine: the user's words as it echoes them, what happens meanwhile, its answer, the turn's end. */
async function exchange(s, turnId, userText, answer, meanwhile = []) {
  await events(s, ['user', { text: userText }, turnId]);
  await sleep(1100);
  for (const step of meanwhile) { await step(); await sleep(1100); }
  await events(s, ['assistant', { text: answer }, turnId], ['turn_end', {}, turnId]);
  await api.turnComplete({ id: s.runnerId }, s.uuid, { turnId, status: 'SUCCEEDED', result: answer });
  await sleep(1100);
}
/** A config change as the runner takes it: the setconfig the inbox hands over, acknowledged in runner-go's words. */
async function takeSetconfig(s) {
  const turn = await fetchTurn(s, 'setconfig');
  const carried = JSON.parse(turn.content ?? '{}');
  await api.turnComplete({ id: s.runnerId }, s.uuid, {
    turnId: turn.turnId, status: 'SUCCEEDED', subtype: 'setconfig',
    result: `applied to the running engine: ${carried.model ? `model "${carried.model}", ` : ''}permission mode "${carried.permissionMode}"`,
  });
  await sleep(1100);
  return carried;
}
/** The owner's change from an app: the real PATCH, then the runner taking it. */
async function ownerPicks(s, change, app, device) {
  await call('PATCH', `/sessions/${s.id}/config`, owner, change, fromApp(app, device));
  const carried = await takeSetconfig(s);
  log(`${s.key}: ${JSON.stringify(change)} from ${app}${device ? `/${device}` : ''} → the engine took ${carried.permissionMode}`);
}

const Q1 = 'Run the staging migration check and tell me what fails.';
const A1 = 'Ran it against staging: 14 of 14 checks passed. The slowest step was the index rebuild on `sessions` (41 s).';
const Q2 = 'Good. Now drop the old `runner_probe` table on staging.';
const A2 = 'Dropped it. Nothing else referenced it.';
/** The owner's next message. A session no process holds goes back to the queue with it (PENDING), and its runner claims it
 *  again, as a runner resumes an idle session; the inbox then hands the message over. */
const ownerSays = async (s, text) => {
  await call('POST', `/sessions/${s.id}/turns`, owner, { clientTurnId: randomUUID(), content: text }, fromApp('web'));
  const status = (await call('GET', `/sessions/${s.id}`, owner)).status;
  if (status === 'PENDING') {
    await heartbeat(api, state.runners[s.runnerName]);
    const job = await queue.claimSessionForRunner({ id: s.runnerId });
    if (job?.sessionId !== s.uuid) throw new Error(`the re-claim handed ${job?.sessionId ?? 'nothing'}, not "${s.title}"`);
    log(`${s.key}: re-claimed with the owner's message (handed ${job.agent.permissionMode})`);
  }
  return (await fetchTurn(s, 'message')).turnId;
};

// ① The engine runs in the Auto asked for: its claim and its report agree, so the claim is the only record.
{
  const { s, turnId } = await startSession('running', { title: 'Staging migration check', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
  await exchange(s, turnId, Q1, A1, [() => report(s, 'auto', turnId)]);
}

// ③ Every cause where it happened: Claude settles in Default and the runner corrects it; the owner changes the mode from the
// web, iOS and Android; Orbit moves the run to Haiku 4.5 (no Auto) and the owner moves it back; the engine is re-spawned,
// comes back in Default, and the runner corrects it again.
{
  const { s, turnId } = await startSession('history', { title: 'Drop the probe table', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
  await exchange(s, turnId, Q1, A1, [
    () => report(s, 'default', turnId),
    () => events(s, ['system', { subtype: 'permission_mode_corrected', mode: 'auto' }, turnId]),
  ]);
  await ownerPicks(s, { permissionMode: 'plan' }, 'web');
  await ownerPicks(s, { permissionMode: 'acceptEdits' }, 'ios', 'iphone');
  await ownerPicks(s, { permissionMode: 'auto' }, 'android');
  await exchange(s, await ownerSays(s, Q2), Q2, A2);
  // TasksService.movePausedRunToPinnedModel's own call: Orbit moves the run to its task's pinned model.
  await sessions.updateConfig(state.owner.uuid, s.uuid, { model: 'claude-haiku-4-5' }, undefined, { origin: 'ORBIT' });
  log(`history: Orbit moved the run to Haiku 4.5 → the engine took ${(await takeSetconfig(s)).permissionMode}`);
  await ownerPicks(s, { model: 'claude-opus-5-5' }, 'web');
  // The runner re-spawns Claude, which comes back below the Auto it was asked for, and the runner switches it back.
  await events(s, ['system', { subtype: 'resumed' }], ['system', { subtype: 'agent_tools', agentTools: agentToolsReport('default') }]);
  await sleep(1100);
  await events(s, ['system', { subtype: 'permission_mode_corrected', mode: 'auto' }]);
}

// ② A gap that lasts: the owner moves an Auto session to Haiku 4.5, which has no Auto; the engine takes Default.
{
  const { s, turnId } = await startSession('noAuto', { title: 'Tidy the changelog', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
  await exchange(s, turnId, Q1, A1, [() => report(s, 'auto', turnId)]);
  await ownerPicks(s, { model: 'claude-haiku-4-5' }, 'web');
}

// ② A claim-time substitution: Bypass asked for on a runner deployed as root, which Claude Code refuses; the claim hands Auto.
{
  const { s, turnId } = await startSession('rootBypass', {
    runnerName: 'root-runner', title: 'Rebuild the index', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'bypassPermissions',
    redeployedAsRoot: true,
  });
  await exchange(s, turnId, Q1, A1, [() => report(s, 'auto', turnId)]);
}

// ② The short gap: claimed in Auto, its first turn open; capture.mjs reports the engine's Default right before it shoots, so
// the runner's switch is still under way on screen, then re-spawns it into Auto for the shot after.
{
  const { s, turnId } = await startSession('correcting', { title: 'Check the staging index', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
  await events(s, ['user', { text: Q1 }, turnId]);
  s.openTurnId = turnId;
}
writeState(state);

// ── the Wiki's chats (components/WikiChatPanel.tsx): a space on the repository one workspace's folder is a clone of ─────────
{
  const REPO = 'https://github.com/pma-stack/orbit.git';
  const r = state.runners['workstation-gpu'];
  const ws = await call('POST', '/workspaces', owner, {
    name: 'orbit-wiki', description: 'Running-mode stack: the wiki chats’ folder', runnerId: r.publicId,
    workDir: '/srv/workstation-gpu/orbit-wiki', enableWorktree: true, defaultMergeTarget: 'main',
  });
  // The folder's remote, as the runner's probe reads it and its beat reports it.
  await heartbeat(api, r, { agentDirProbes: [{ agentId: toUuid(ws.id), exists: true, isGitRepo: true, workDir: '/srv/workstation-gpu/orbit-wiki', repoUrl: REPO }] });
  const space = await call('POST', '/wiki/spaces', owner, { title: 'orbit', repoUrl: REPO });
  state.wiki = { spaceId: space.id, slug: space.slug, workspaceId: ws.id };
  state.wikiChats = {};
  writeState(state);

  // ① Runs in the Auto asked for.
  {
    const { s, turnId } = await startSession('wikiRunning', { wikiChat: true, title: 'Why three heartbeats', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
    await exchange(s, turnId, Q1, A1, [() => report(s, 'auto', turnId)]);
  }
  // ③ Claude settles in Default and the runner corrects it; the owner moves the chat to Plan and back from two apps; the
  // owner moves it to Haiku 4.5, which has no Auto: ② the gap that lasts, with every change above it.
  {
    const { s, turnId } = await startSession('wikiNoAuto', { wikiChat: true, title: 'Runner offline: the check', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
    await exchange(s, turnId, Q1, A1, [
      () => report(s, 'default', turnId),
      () => events(s, ['system', { subtype: 'permission_mode_corrected', mode: 'auto' }, turnId]),
    ]);
    await ownerPicks(s, { permissionMode: 'plan' }, 'web');
    await ownerPicks(s, { permissionMode: 'auto' }, 'ios', 'iphone');
    await exchange(s, await ownerSays(s, Q2), Q2, A2);
    await ownerPicks(s, { model: 'claude-haiku-4-5' }, 'web');
  }
  // ② The short gap, as `correcting` above: its first turn open until capture.mjs reports the engine's Default.
  {
    const { s, turnId } = await startSession('wikiCorrecting', { wikiChat: true, title: 'Check the staging index', prompt: Q1, model: 'claude-opus-5-5', permissionMode: 'auto' });
    await events(s, ['user', { text: Q1 }, turnId]);
    s.openTurnId = turnId;
  }
  writeState(state);
}

for (const s of [...Object.values(state.sessions), ...Object.values(state.wikiChats)]) {
  const d = await call('GET', `/sessions/${s.id}`, owner);
  log(`${s.key}: intent ${d.permissionMode} · running ${d.actualPermissionMode} · model ${d.model} · ${d.permissionModeChanges?.length ?? 0} change(s): ${
    (d.permissionModeChanges ?? []).map((c) => `${c.cause}${c.client ? `(${c.client})` : ''} ${c.fromMode ?? '∅'}→${c.toMode}`).join(', ')}`);
}
await prisma.$disconnect();
process.exit(0);
