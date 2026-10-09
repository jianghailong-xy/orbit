// A07c: what the A07c composer journeys (ComposerStackDeviceTest) read from the stack's own server, made through its real API —
// no database writes, nothing that leaves this host:
//   seed  a configured key OpenCode can run ("DeepSeek", on Claude Code; its endpoint a closed loopback port) and a shared pool of
//         two OpenAI-format keys ("A07c shared pool"); two runners registered through the runner API, which `run` speaks for:
//         "a07c-engines" with its workspace and a Codex session there, and "a07c-pool" with its workspace and a session on the
//         shared pool, which it claims through the runner's own claim (the claim is where the server picks the pool's key). On
//         the stack's own runner (fake-claude): a session the weekly-limit sentence stopped (A07C-QUOTA), one whose turn failed
//         (A07C-FAIL), and one that sent a Markdown and a text file. Ids go to seed.json under `a07c`; the two runners' tokens to
//         a07c-runners.json (0600).
//   run   both runners' heartbeats every 10 s. a07c-engines: Claude Code, Codex, Antigravity, Kimi and OpenCode installed; two
//         accounts of Claude Code and of Codex; Antigravity on a Google sign-in that lapsed; Codex Default holding reset credits
//         (2 unless A07C_CREDITS says) — and its part in a reset the app asks for (docs/codex-rate-limit-reset-contract.md §6):
//         the consume answered `reset`, then the refresh with one credit fewer. a07c-pool: Codex only.
//   refresh  a new weekly-limit session and a new failed one in place of those a run answered (seed.json updated).
//   dump  what the server now says of those runners, providers, pools, sessions and reset operations, as JSON (to argv[3]).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { S, API, call, login, readSeed, seedFile } from './lib.mjs';

const H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const isoSeconds = (ms) => iso(ms).replace(/\.\d{3}Z$/, 'Z');
const tokens = `${S}/a07c-runners.json`;
// A configured key's endpoint: a closed loopback port, so neither the server nor the runner's engine reaches anybody's API.
const ENDPOINT = 'http://127.0.0.1:9/a07c-no-endpoint';
const FINGERPRINT = `cxa1_${createHash('sha256').update('a07c-codex-default').digest('hex').slice(0, 32)}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, read, { timeoutMs = 180_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── what the two runners report ───────────────────────────────────────────────────────────────────────────────────────────
const leaseOwner = randomUUID();
let sequence = 0;
let credits = Number(process.env.A07C_CREDITS ?? 2);
const resetBlock = () => ({
  protocolVersion: 1, support: 'SUPPORTED', accountFingerprint: FINGERPRINT,
  rateLimitResetCredits: { availableCount: credits, credits: Array.from({ length: credits }, (_, i) => ({
    id: `rlrc_a07c_${i + 1}`, resetType: 'codexRateLimits', status: 'available', grantedAt: isoSeconds(-(10 + i) * D),
    expiresAt: isoSeconds((20 + 20 * i) * D), title: 'Earned reset', description: 'Resets your current Codex usage limits.' })) },
  fetchedAt: iso(0), generation: leaseOwner, sequence: ++sequence,
});
const codex = (accounts) => ({ engine: 'codex', installed: true, version: 'codex-cli 0.158.0', auth: 'yes', accounts });
const runners = {
  'a07c-engines': {
    caps: ['codex-rate-limit-reset-v1', 'codex-account-move/v1', 'claude-account-move/v1', 'antigravity-google-login/v1'],
    providers: 'claude,codex,antigravity,kimi,opencode',
    engines: () => [
      { engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes', accounts: [
        { id: 'default', auth: 'yes', home: '/home/a07c/.claude' },
        { id: 'a07c0001', name: 'Work', auth: 'yes', home: '/home/a07c/.orbit/claude-accounts/a07c0001' }] },
      codex([{ id: 'default', auth: 'yes', home: '/home/a07c/.codex' },
        { id: 'a07c0002', name: 'Team', auth: 'yes', home: '/home/a07c/.orbit/codex-accounts/a07c0002' }]),
      { engine: 'antigravity', installed: true, version: '1.3.0', auth: 'no', authSource: 'google', accounts: [
        { id: 'default', auth: 'no', home: '/home/a07c/.orbit/antigravity/google' }] },
      { engine: 'kimi', installed: true, version: '1.40.0', auth: 'yes' },
      { engine: 'opencode', installed: true, version: '1.0.150', auth: 'yes' },
    ],
    planUsage: () => ({
      claude: { provider: 'claude', fetchedAt: iso(0), fiveHour: { utilization: 12, resetsAt: iso(3 * H) }, sevenDay: { utilization: 30, resetsAt: iso(4 * D) },
        accounts: { a07c0001: { provider: 'claude', fiveHour: { utilization: 57, resetsAt: iso(2 * H) }, sevenDay: { utilization: 44, resetsAt: iso(3 * D) } } } },
      codex: { provider: 'codex', fetchedAt: iso(0), primary: { utilization: 23, windowDurationMins: 300, resetsAt: iso(4 * H) },
        secondary: { utilization: 41, windowDurationMins: 10080, resetsAt: iso(5 * D) }, rateLimitReset: resetBlock(),
        accounts: { a07c0002: { provider: 'codex', primary: { utilization: 64, windowDurationMins: 300, resetsAt: iso(H) } } } },
    }),
  },
  'a07c-pool': { caps: [], providers: 'codex', engines: () => [codex([{ id: 'default', auth: 'yes', home: '/home/a07c/.codex' }])] },
};
const headers = (name) => ({ 'x-orbit-runner-capabilities': runners[name].caps.join(','), 'x-orbit-runner-os': 'linux',
  'x-orbit-supported-providers': runners[name].providers });
const heartbeat = (name, token) => call('POST', '/runner/heartbeat', token, { status: 'ONLINE', idleCapacity: 4, version: '0.1.230',
  runsAsRoot: false, leaseOwner, draining: false, engines: runners[name].engines(),
  ...(runners[name].planUsage ? { planUsage: runners[name].planUsage() } : {}) }, headers(name));

/** a07c-engines' part in a reset: the consume answered `reset`, then the refresh with the block read after it (§6.3, §6.4). */
async function relay(token, command, log) {
  const answer = (body) => call('POST', '/runner/codex-rate-limit-reset-result', token, { protocolVersion: 1, operationId: command.operationId,
    leaseOwner: command.leaseOwner, claimGeneration: command.claimGeneration, ...body });
  let phase = command.phase;
  if (phase === 'CONSUME') {
    const consumed = await answer({ phase, kind: 'CONSUME_OUTCOME', outcome: 'reset', observedAccountFingerprint: FINGERPRINT });
    log(`consume ${command.operationId} -> ${JSON.stringify(consumed)}`);
    if (consumed.disposition === 'APPLIED') credits = Math.max(0, credits - 1);
    if (consumed.next !== 'REFRESH') return;
    phase = 'REFRESH';
  }
  if (phase === 'REFRESH') {
    const refreshed = await answer({ phase, kind: 'REFRESHED', rateLimitReset: resetBlock() });
    log(`refresh ${command.operationId} -> ${JSON.stringify(refreshed)} (credits now ${credits})`);
  }
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2];
const owner = await login('owner');
const seed = readSeed();
const state = (d) => d.runStatus ?? d.status;
const detail = (id) => call('GET', `/sessions/${id}`, owner);
const session = (body) => call('POST', '/sessions', owner, { workspaceId: seed.workspace.id, ...body });
/** On the stack's own runner: a session the weekly-limit sentence stopped, its retry armed, and one whose turn failed. */
async function stoppedSessions() {
  const quota = await session({ title: 'A07c weekly limit', prompt: 'A07C-QUOTA: summarize the release notes' });
  const fail = await session({ title: 'A07c failed turn', prompt: 'A07C-FAIL: draft the changelog' });
  const armed = await until('the weekly limit to arm the retry', async () => { const d = await detail(quota.id); return d.retryAt && state(d) === 'AWAITING_INPUT' ? d : null; });
  const failed = await until('the failed turn to settle', async () => { const d = await detail(fail.id); return ['FAILED', 'AWAITING_INPUT'].includes(state(d)) && d.numTurns > 0 ? d : null; });
  return { quota: { id: quota.id, title: 'A07c weekly limit', retryAt: armed.retryAt }, fail: { id: fail.id, title: 'A07c failed turn', status: state(failed) } };
}

if (mode === 'seed') {
  const deepseek = await call('POST', '/providers/mine', owner, { label: 'DeepSeek', runtime: 'claude', baseUrl: ENDPOINT,
    apiKey: `sk-a07c-${randomUUID()}`, models: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }], defaultModel: 'deepseek-chat' });
  const shared = await call('POST', '/providers/shared-pools', owner, { label: 'A07c shared pool' });
  for (const label of ['Team key A', 'Team key B']) {
    await call('POST', `/providers/shared-pools/${shared.id}/keys`, owner, { label, apiKey: `sk-a07c${randomBytes(16).toString('hex')}` });
  }
  const pool = await call('GET', `/providers/shared-pools/${shared.id}`, owner);

  const registered = {};
  const workspaces = {};
  for (const name of Object.keys(runners)) {
    const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
    registered[name] = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: `${name}-host`, version: '0.1.230', maxConcurrent: 4 });
    await heartbeat(name, registered[name].runnerToken);
    workspaces[name] = await call('POST', '/workspaces', owner, { name, description: 'A07c: a runner that reports what the composer reads (no engine runs here)',
      runnerId: registered[name].runnerId, workDir: `/srv/${name}`, enableWorktree: false, defaultMergeTarget: 'main' });
  }
  writeFileSync(tokens, JSON.stringify(registered, null, 2), { mode: 0o600 });
  // Registration answers with the runner's UUID; every owner read names it by its public id.
  const listed = await call('GET', '/runners', owner);
  const runnerId = (name) => listed.find((r) => r.name === name).id;

  // On the runner's own Codex sign-in (Default): the account its reset credits belong to.
  const codexSession = await call('POST', '/sessions', owner, { workspaceId: workspaces['a07c-engines'].id, title: 'A07c Codex reset',
    prompt: 'A07c: the Codex reset card', provider: 'codex', codexAccount: 'default' });
  const pooled = await call('POST', '/sessions', owner, { workspaceId: workspaces['a07c-pool'].id, title: 'A07c shared pool',
    prompt: 'A07c: a session on the shared pool', provider: pool.slug });
  // The claim is where the server picks the pool's key (poolKeyId). What it hands the runner is not kept or printed.
  await until('a07c-pool to claim the pool session', async () => {
    const res = await fetch(`${API}/runner/sessions/claim`, { headers: { authorization: `Bearer ${registered['a07c-pool'].runnerToken}`, ...headers('a07c-pool') } });
    const job = res.ok ? JSON.parse((await res.text()) || 'null') : null;
    return job?.sessionId ? job.sessionId : null;
  }, { timeoutMs: 120_000, everyMs: 1_000 });
  const stopped = await stoppedSessions();
  const upload = async (name, mime, text) => {
    const form = new FormData();
    form.append('file', new Blob([text], { type: mime }), name);
    const res = await fetch(`${API}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form });
    if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const notes = await upload('release-notes.md', 'text/markdown', '# Release notes\n\n- **Fixed** the retry door\n- Added the reset card\n');
  const log = await upload('build.log', 'text/plain', '> Task :app:test\nBUILD SUCCESSFUL in 4m\n3 actionable tasks\n');
  const files = await session({ title: 'A07c files', prompt: 'A07c: two files attached', attachmentIds: [notes.id, log.id] });

  await until('the files session to answer', async () => state(await detail(files.id)) === 'AWAITING_INPUT');
  const onPool = await detail(pooled.id);
  seed.a07c = {
    enginesRunner: { id: runnerId('a07c-engines'), name: 'a07c-engines' },
    enginesWorkspace: { id: workspaces['a07c-engines'].id, name: workspaces['a07c-engines'].name },
    poolRunner: { id: runnerId('a07c-pool'), name: 'a07c-pool' },
    keys: { deepseek: { id: deepseek.id, slug: deepseek.slug, label: deepseek.label } },
    sharedPool: { id: pool.id, slug: pool.slug, label: pool.label, keys: (pool.keys ?? []).map((k) => ({ id: k.id, label: k.label })) },
    sessions: { codex: { id: codexSession.id, title: 'A07c Codex reset' },
      pool: { id: pooled.id, title: 'A07c shared pool', poolKeyId: onPool.poolKeyId ?? null, status: state(onPool) },
      ...stopped,
      files: { id: files.id, title: 'A07c files', attachments: [notes.id, log.id] } },
    how: 'a07c-stack.mjs seed: POST /providers/mine, /providers/shared-pools(+keys), /runner/register, /runner/heartbeat, /workspaces, ' +
      'GET /runner/sessions/claim, POST /attachments, /sessions',
  };
  writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  console.log(JSON.stringify(seed.a07c, null, 2));
} else if (mode === 'refresh') {
  Object.assign(seed.a07c.sessions, await stoppedSessions());
  writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  console.log(JSON.stringify(seed.a07c.sessions, null, 2));
} else if (mode === 'run') {
  const registered = JSON.parse(readFileSync(tokens, 'utf8'));
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  log(`leaseOwner ${leaseOwner}, ${credits} reset credits`);
  for (;;) {
    for (const name of Object.keys(runners)) {
      try {
        const answer = await heartbeat(name, registered[name].runnerToken);
        const command = answer?.codexRateLimitResetRequest;
        if (command) await relay(registered[name].runnerToken, command, log);
      } catch (error) { log(`${name} heartbeat: ${error.message}`); }
    }
    await sleep(10_000);
  }
} else if (mode === 'dump') {
  const a07c = seed.a07c;
  const runnerNames = [a07c.enginesRunner.name, a07c.poolRunner.name, seed.runner?.name];
  const sessions = {};
  for (const [key, row] of Object.entries(a07c.sessions)) sessions[key] = await call('GET', `/sessions/${row.id}`, owner);
  const out = { at: new Date().toISOString(), runners: (await call('GET', '/runners', owner)).filter((r) => runnerNames.includes(r.name)),
    providers: await call('GET', '/providers', owner), sharedPools: await call('GET', '/providers/shared-pools', owner), sessions,
    codexRateLimitReset: await call('GET', `/runners/${a07c.enginesRunner.id}/codex-rate-limit-reset`, owner).catch((error) => ({ error: error.message })) };
  writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(out, null, 2) + '\n');
} else {
  console.error('usage: node a07c-stack.mjs seed|refresh|run|dump [out.json]');
  process.exit(2);
}
