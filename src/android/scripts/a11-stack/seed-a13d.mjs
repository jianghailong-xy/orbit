// A13d on A11's isolated real stack (A13dStackDeviceTest): what the app's pages read and write, made through the real API. Run from
// the checkout with the stack's environment (A11_STACK_DIR, A11_STACK_API_PORT); scripts/management-stack-device-test.sh does.
//   node seed-a13d.mjs seed   — three access tokens issued as the web issues them (one used once, one revoked), a DeepSeek key
//                                the server reads a balance for, and two runners registered through the real runner API
//   node seed-a13d.mjs reset  — back to the state a pass starts from (a pass revokes the laptop's token and removes a13d-spare)
//   node seed-a13d.mjs run    — heartbeat both runners every 3 s; a13d-kimi answers a Kimi sign-in start with the device step
//                                of the site the start names (as `kimi login --region` would), and every start is logged
//   node seed-a13d.mjs dump <file> — what the server says now (owner's token): runners, access tokens, preferences, own
//                                providers and each DeepSeek balance, a13d-kimi's sign-in relay, and the starts it was handed
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { S, call, login, readSeed } from './lib.mjs';
const state = `${S}/a13d-state.json`;
const starts = `${S}/a13d-starts.jsonl`;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600e3;

const runners = {
  // Kimi Code installed and signed in on kimi.com, on a runner that can be told a site and keeps Kimi accounts.
  'a13d-kimi': {
    hostname: 'kimi-host', os: 'linux', providers: 'claude,codex,kimi',
    caps: ['kimi-login-region/v1', 'kimi-account-login/v1', 'kimi-account-move/v1'],
    engines: () => [
      { engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes' },
      { engine: 'codex', installed: true, version: 'codex-cli 0.158.0', auth: 'no' },
      { engine: 'kimi', installed: true, version: '2.1.1', auth: 'yes', kimiRegion: 'mainland-cn',
        accounts: [{ id: 'default', auth: 'yes', home: '/home/ci/.kimi-code', kimiRegion: 'mainland-cn' }] }],
  },
  // A second machine, so the runners list has rows to reorder and one to remove.
  'a13d-spare': {
    hostname: 'spare-host', os: 'linux', providers: 'claude', caps: [],
    engines: () => [{ engine: 'claude', installed: true, version: '2.1.292 (Claude Code)', auth: 'yes' }],
  },
};

const mode = process.argv[2];
const owner = await login('owner');
const known = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};

if (mode === 'seed') {
  const seed = readSeed();
  const workspaceId = seed.workspaceId ?? seed.workspace?.id ?? (await call('GET', '/workspaces', owner))[0]?.id;
  const everything = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'sessions:read', 'sessions:write',
    'workspaces:read', 'workspaces:write', 'runners:read', 'wiki:read', 'wiki:write', 'events:read'];
  if (!known.tokens) {
    const laptop = await call('POST', '/access-tokens', owner, { name: 'a13d laptop', scopes: everything, expiresInDays: null });
    const ci = await call('POST', '/access-tokens', owner, { name: 'a13d ci', scopes: ['tasks:read', 'tasks:write', 'sessions:read'],
      workspaceIds: workspaceId ? [workspaceId] : undefined, expiresInDays: 90 });
    const old = await call('POST', '/access-tokens', owner, { name: 'a13d old phone', scopes: everything.filter((s) => s.endsWith(':read')), expiresInDays: 30 });
    // The laptop's token is used once, so its row says when and from where.
    await call('GET', '/pat/self', laptop.token);
    await call('DELETE', `/access-tokens/${old.id}`, owner);
    known.tokens = { laptop: laptop.id, ci: ci.id, old: old.id };
    console.log(`issued tokens ${JSON.stringify(known.tokens)}`);
  }
  if (!known.deepseek) {
    // A DeepSeek key that DeepSeek will not take: the server asks it, and says what it answered.
    const p = await call('POST', '/providers/mine', owner, { label: 'DeepSeek (a13d)', presetSlug: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-a13d-not-a-real-deepseek-key' });
    known.deepseek = p.id;
    console.log(`deepseek provider ${p.id}`);
  }
  known.runners ??= {};
  for (const [name, r] of Object.entries(runners)) {
    if (known.runners[name]) continue;
    const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
    known.runners[name] = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: r.hostname, version: '0.1.230', maxConcurrent: 2 });
    console.log(`registered ${name} ${known.runners[name].runnerId}`);
  }
  writeFileSync(state, JSON.stringify(known, null, 2));
  process.exit(0);
}

if (mode === 'reset') {
  // Each stack pass starts from the same state: an active, once-used "a13d laptop" token, both runners on the account, the
  // switch off. A pass revokes the token and removes a13d-spare, so a rerun needs them back.
  const everything = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'sessions:read', 'sessions:write',
    'workspaces:read', 'workspaces:write', 'runners:read', 'wiki:read', 'wiki:write', 'events:read'];
  const tokens = (await call('GET', '/access-tokens', owner)).tokens;
  for (const t of tokens.filter((t) => t.name === 'a13d laptop' && t.state === 'ACTIVE')) await call('DELETE', `/access-tokens/${t.id}`, owner);
  const laptop = await call('POST', '/access-tokens', owner, { name: 'a13d laptop', scopes: everything, expiresInDays: null });
  await call('GET', '/pat/self', laptop.token);
  known.tokens = { ...(known.tokens ?? {}), laptop: laptop.id };
  const names = (await call('GET', '/runners', owner)).map((r) => r.name);
  for (const name of Object.keys(runners)) {
    if (names.includes(name)) continue;
    const enroll = await call('POST', '/runners/enrollment-tokens', owner, { label: name });
    known.runners[name] = await call('POST', '/runner/register', undefined, { enrollmentToken: enroll.token, name, hostname: runners[name].hostname, version: '0.1.230', maxConcurrent: 2 });
    console.log(`registered ${name} again`);
  }
  await call('PATCH', '/users/me/preferences', owner, { modelRouting: false });
  // A sign-in left open by an earlier pass is cancelled, so the next one starts from the account's page.
  const kimi = (await call('GET', '/runners', owner)).find((r) => r.name === 'a13d-kimi');
  const relay = kimi && await call('GET', `/runners/${kimi.id}/login`, owner);
  if (relay?.status && !['cancelled', 'succeeded', 'failed'].includes(relay.status)) await call('DELETE', `/runners/${kimi.id}/login`, owner);
  writeFileSync(state, JSON.stringify(known, null, 2));
  process.exit(0);
}

if (mode === 'run') {
  for (;;) {
    for (const [name, r] of Object.entries(runners)) {
      const reg = known.runners?.[name];
      if (!reg) continue;
      let answer;
      try {
        answer = await call('POST', '/runner/heartbeat', reg.runnerToken, { status: 'ONLINE', idleCapacity: 2, version: '0.1.230', runsAsRoot: false, engines: r.engines() },
          { 'x-orbit-runner-capabilities': r.caps.join(','), 'x-orbit-runner-os': r.os, 'x-orbit-supported-providers': r.providers });
      } catch (e) { console.log(`${new Date().toISOString()} ${name} heartbeat refused: ${e.message.slice(0, 160)}`); continue; }
      const start = answer?.loginRequest;
      if (start?.action === 'start') {
        appendFileSync(starts, JSON.stringify({ at: new Date().toISOString(), runner: name, login: start }) + '\n');
        if (start.engine === 'kimi') {
          // What `kimi login --region <site>` prints: the device page of the site it was told, and a one-time code.
          const site = start.region === 'global' ? 'kimi.ai' : 'kimi.com';
          const code = start.region === 'global' ? 'Q2PF-8XWA' : '7K06-QP86';
          await call('POST', '/runner/login-result', reg.runnerToken, { status: 'awaiting_approval', userCode: code,
            url: `https://www.${site}/code/authorize_device?user_code=${code}`, attempt: start.attempt, ...(start.account ? { account: start.account } : {}) });
        }
      }
    }
    await new Promise((done) => setTimeout(done, 3_000));
  }
}

if (mode === 'dump') {
  const out = {};
  out.at = new Date().toISOString();
  out.runners = (await call('GET', '/runners', owner)).map((r) => ({ id: r.id, name: r.name, displayName: r.displayName, position: r.position,
    engines: (r.engines ?? []).filter((e) => e.engine === 'kimi') }));
  out.accessTokens = (await call('GET', '/access-tokens', owner)).tokens.map(({ id, name, tokenHint, state, scopes, workspaceIds, expiresAt, lastUsedAt, lastUsedIp, revokedAt, revokedReason }) =>
    ({ id, name, tokenHint, state, scopes, workspaceIds, expiresAt, lastUsedAt, lastUsedIp, revokedAt, revokedReason }));
  out.preferences = (await call('GET', '/users/me', owner)).preferences;
  out.providersMine = (await call('GET', '/providers/mine', owner)).map(({ id, slug, label, presetSlug, baseUrl, hasApiKey, runtime, defaultModel }) =>
    ({ id, slug, label, presetSlug, baseUrl, hasApiKey, runtime, defaultModel }));
  out.balances = {};
  for (const p of out.providersMine.filter((p) => p.presetSlug === 'deepseek' || p.presetSlug === 'deepseek-harness')) {
    out.balances[p.id] = await call('GET', `/providers/mine/${p.id}/balance`, owner);
  }
  const kimi = out.runners.find((r) => r.name === 'a13d-kimi');
  if (kimi) out.kimiLogin = await call('GET', `/runners/${kimi.id}/login`, owner);
  out.starts = existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}
console.error('usage: seed-a13d.mjs seed | reset | run | dump <file>');
process.exit(2);
