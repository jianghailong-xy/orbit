// A07d: what the A07d DeepSeek Harness journeys (DshStackDeviceTest) read from the stack's own server, made through its real API —
// no database writes, nothing that leaves this host:
//   seed  a DeepSeek key ("DeepSeek", preset deepseek, its endpoint a closed loopback port, so neither the server nor any engine
//         reaches DeepSeek); two runners registered through the runner API, which `run` speaks for: "a07d-dsh", whose DeepSeek
//         Harness is installed and ready, with its workspace, and "a07d-dsh-old", whose Harness is a version Orbit doesn't support.
//         On a07d-dsh, two sessions on the key and the `dsh` engine (provider/engine contract §6.1), which a07d-dsh claims: one asks
//         an approval (Bash `git status`); the other fails its turn with DeepSeek's real 401 sentence, as the runner words it.
//         Ids go to seed.json under `a07d`; the runners' tokens to a07d-runners.json (0600).
//   run   both runners' heartbeats every 10 s, and a07d-dsh-old's part in an install of Harness the app asks for: `installing`
//         with the relay's words, then — A07D_INSTALL_SECONDS later (default 60) — `done`, its Harness now a supported version.
//   dump  what the server now says of those runners, the key, the sessions and the approval, as JSON (to argv[3]).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { S, API, call, login, readSeed, seedFile } from './lib.mjs';

const tokens = `${S}/a07d-runners.json`;
// The key's endpoint: a closed loopback port. A preset `deepseek` row is a DeepSeek key whatever its endpoint (contract §2.1).
const ENDPOINT = 'http://127.0.0.1:9/a07d-no-endpoint';
// What the runner says when DeepSeek refuses the key (runner dsh_health.go, iOS 13720e241's real 401).
const REJECTED = 'DSH_CREDENTIAL_INVALID: dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ' +
  '****0000 is invalid (request_id: 64d2f58d-15e2-4744-aafd-d463abb21741)';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const iso = () => new Date().toISOString();

async function until(what, read, { timeoutMs = 120_000, everyMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── what the two runners report ───────────────────────────────────────────────────────────────────────────────────────────
// One process speaks for both runners, under one lease owner kept with their tokens: to the server `run` is the process that
// claimed the sessions, not a restarted one whose sessions it would take back.
const leaseOwner = process.argv[2] !== 'seed' && existsSync(tokens) ? JSON.parse(readFileSync(tokens, 'utf8')).leaseOwner : randomUUID();
const harness = (version, compatible) => ({ engine: 'dsh', installed: true, version, auth: 'unknown',
  dsh: { versionCompatible: compatible, credentialPresent: false, modelCatalogReadable: false, requestValidation: 'unknown',
    sandboxEnforcement: 'unknown' } });
const claude = { engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes' };
let oldInstalled = false;
const runners = {
  'a07d-dsh': { engines: () => [claude, harness('0.2.0-rc.2', true)] },
  'a07d-dsh-old': { engines: () => [claude, oldInstalled ? harness('0.2.0-rc.2', true) : harness('0.1.9', false)] },
};
const headers = { 'x-orbit-runner-capabilities': '', 'x-orbit-runner-os': 'linux', 'x-orbit-supported-providers': 'claude,dsh' };
const heartbeat = (name, token) => call('POST', '/runner/heartbeat', token, { status: 'ONLINE', idleCapacity: 4, version: '0.1.230',
  runsAsRoot: false, leaseOwner, draining: false, engines: runners[name].engines() }, headers);

// ── commands ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2];
const owner = await login('owner');
const seed = readSeed();
const state = (d) => d.runStatus ?? d.status;
const detail = (id) => call('GET', `/sessions/${id}`, owner);

/** One claim through the runner's own door, as the runner long-polls it: the session it hands out, by its runner-side id and
 * title, or null. Only those are kept: what it hands the runner (the key among them) is neither kept nor printed. */
async function claim(token) {
  const res = await fetch(`${API}/runner/sessions/claim`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const job = res.ok ? JSON.parse((await res.text()) || 'null') : null;
  return job?.sessionId ? { sessionId: job.sessionId, title: job.title, owner: job.leaseOwner ?? null } : null;
}
/** The session's opening turn, as the runner takes it (runner transport.go, session.go): this process takes over the leases the
 * claim saw ([owner], none for a session never run), activates a fresh inbox generation, and is handed the turn — whose id
 * completes it. */
async function openingTurn(token, sessionId, owner) {
  await call('POST', `/runner/sessions/${sessionId}/takeover-leases`, token, { leaseOwner, expectedLeaseOwner: owner }, headers);
  const generation = randomUUID();
  await call('POST', `/runner/sessions/${sessionId}/activate-leases`, token, { leaseGeneration: generation, leaseOwner }, headers);
  return until(`the opening turn of ${sessionId}`, async () => {
    const turn = await call('GET', `/runner/sessions/${sessionId}/inbox?acceptsSteer=1&leaseGeneration=${generation}`, token, undefined, headers);
    return turn?.turnId || null;
  }, { timeoutMs: 60_000, everyMs: 2_000 });
}

if (mode === 'seed') {
  const key = await call('POST', '/providers/mine', owner, { label: 'DeepSeek', presetSlug: 'deepseek', runtime: 'claude', baseUrl: ENDPOINT,
    apiKey: `sk-a07d-${randomUUID()}` });
  const registered = {};
  for (const name of Object.keys(runners)) {
    const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
    registered[name] = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: `${name}-host`, version: '0.1.230', maxConcurrent: 4 });
    await heartbeat(name, registered[name].runnerToken);
  }
  writeFileSync(tokens, JSON.stringify({ ...registered, leaseOwner }, null, 2), { mode: 0o600 });
  const workspace = await call('POST', '/workspaces', owner, { name: 'a07d-dsh', description: 'A07d: a runner whose DeepSeek Harness is ready (no engine runs here)',
    runnerId: registered['a07d-dsh'].runnerId, workDir: '/srv/a07d-dsh', enableWorktree: false, defaultMergeTarget: 'main' });
  // Registration answers with the runner's UUID; every owner read names it by its public id.
  const listed = await call('GET', '/runners', owner);
  const runnerId = (name) => listed.find((r) => r.name === name).id;

  const token = registered['a07d-dsh'].runnerToken;
  const sessions = {};
  for (const [name, title, prompt] of [['approval', 'A07d Harness approval', 'A07d: check the tree before the release'],
    ['rejected', 'A07d Harness rejected key', 'A07d: summarize the failing test']]) {
    const created = await call('POST', '/sessions', owner, { workspaceId: workspace.id, title, prompt, engine: 'dsh', provider: key.slug });
    // The runner's door names a session by its UUID, the owner's by its public id: the claim is matched by its title.
    const claimed = await until(`a07d-dsh to claim "${title}"`, () => claim(token));
    if (claimed.title !== title) throw new Error(`claimed "${claimed.title}", made "${title}"`);
    sessions[name] = { id: created.id, runnerId: claimed.sessionId, owner: claimed.owner, title, prompt };
  }
  await heartbeat('a07d-dsh', token);
  for (const row of Object.values(sessions)) row.turnId = await openingTurn(token, row.runnerId, row.owner);
  // The approval session: the permission prompt the runner's bridge files, and the user's words before it.
  const asking = sessions.approval;
  await call('POST', `/runner/sessions/${asking.runnerId}/events`, token, { leaseOwner, events: [
    { seq: 1, type: 'user', ts: iso(), turnId: asking.turnId, payload: { text: asking.prompt } }] });
  const approval = await call('POST', `/runner/sessions/${asking.runnerId}/approvals`, token,
    { toolName: 'Bash', input: { command: 'git status', description: 'Show the working tree status' }, toolUseId: `a07d-${randomUUID()}` });
  asking.approvalId = approval.id;
  // The rejected session: the user's words, then the runner's error line, then the failed turn.
  const rejected = sessions.rejected;
  await call('POST', `/runner/sessions/${rejected.runnerId}/events`, token, { leaseOwner, events: [
    { seq: 1, type: 'user', ts: iso(), turnId: rejected.turnId, payload: { text: rejected.prompt } },
    { seq: 2, type: 'error', ts: iso(), turnId: rejected.turnId, payload: { message: REJECTED } }] });
  // The ACP session the runner opened is the session's context, as the runner reports it: what a resume (a Retry) needs.
  await call('POST', `/runner/sessions/${rejected.runnerId}/turn-complete`, token, { turnId: rejected.turnId, leaseOwner, status: 'FAILED',
    error: REJECTED, runtimeSessionId: `a07d-acp-${randomUUID()}` });

  seed.a07d = {
    runner: { id: runnerId('a07d-dsh'), name: 'a07d-dsh' },
    oldRunner: { id: runnerId('a07d-dsh-old'), name: 'a07d-dsh-old' },
    workspace: { id: workspace.id, name: workspace.name },
    key: { id: key.id, slug: key.slug, label: key.label },
    sessions: Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { id: v.id, runnerId: v.runnerId, title: v.title,
      ...(v.approvalId ? { approvalId: v.approvalId } : {}) }])),
    how: 'a07d-stack.mjs seed: POST /providers/mine, /runners/enrollment-tokens, /runner/register, /runner/heartbeat, /workspaces, ' +
      '/sessions {engine:"dsh"}, GET /runner/sessions/claim, POST /runner/sessions/:id/approvals|events|turn-complete',
  };
  writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  for (const [k, v] of Object.entries(sessions)) {
    const d = await detail(v.id);
    console.log(`${k}: ${v.id} engine=${d.engine} provider=${d.provider} model=${JSON.stringify(d.model)} status=${state(d)}`);
  }
  console.log(JSON.stringify(seed.a07d, null, 2));
} else if (mode === 'run') {
  const registered = JSON.parse(readFileSync(tokens, 'utf8'));
  const installSeconds = Number(process.env.A07D_INSTALL_SECONDS ?? 60);
  const log = (line) => console.log(`${iso()} ${line}`);
  log(`leaseOwner ${leaseOwner}`);
  let installing = null;
  for (;;) {
    for (const name of Object.keys(runners)) {
      const token = registered[name].runnerToken;
      try {
        const answer = await heartbeat(name, token);
        const request = answer?.installRequest;
        if (request && name === 'a07d-dsh-old' && !installing) {
          log(`${name} installRequest ${JSON.stringify(request)}`);
          await call('POST', '/runner/install-result', token, { status: 'installing', message: 'Installing DeepSeek Harness 0.2.0-rc.2…' });
          installing = Date.now();
        }
        if (installing && name === 'a07d-dsh-old' && Date.now() - installing > installSeconds * 1000) {
          oldInstalled = true;
          await call('POST', '/runner/install-result', token, { status: 'done', message: 'DeepSeek Harness 0.2.0-rc.2 installed' });
          log(`${name} install done`);
          installing = null;
        }
      } catch (error) { log(`${name} heartbeat: ${error.message}`); }
    }
    await sleep(10_000);
  }
} else if (mode === 'dump') {
  const a07d = seed.a07d;
  const names = [a07d.runner.name, a07d.oldRunner.name];
  const sessions = {};
  for (const [k, row] of Object.entries(a07d.sessions)) sessions[k] = await call('GET', `/sessions/${row.id}`, owner);
  const registered = JSON.parse(readFileSync(tokens, 'utf8'));
  const out = { at: iso(), runners: (await call('GET', '/runners', owner)).filter((r) => names.includes(r.name)),
    providers: await call('GET', '/providers', owner), sessions,
    approvals: await call('GET', `/sessions/${a07d.sessions.approval.id}/approvals`, owner),
    // What the runner's bridge is told of the decision — remember rules included, when any were sent.
    approvalForRunner: await call('GET', `/runner/sessions/${a07d.sessions.approval.runnerId}/approvals/${a07d.sessions.approval.approvalId}`,
      registered['a07d-dsh'].runnerToken).catch((error) => ({ error: error.message })),
    workspace: await call('GET', `/workspaces/${a07d.workspace.id}`, owner),
    events: await call('GET', `/sessions/${a07d.sessions.rejected.id}/events/page?limit=20`, owner).catch((error) => ({ error: error.message })) };
  writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(out, null, 2) + '\n');
} else {
  console.error('usage: node a07d-stack.mjs seed|run|dump [out.json]');
  process.exit(2);
}
