// A fresh stack's owner, runner and workspace, through the real HTTP API (no database writes):
//   node bootstrap.mjs
// POST /auth/bootstrap (the owner; password random, kept in $CAS_DIR/accounts.json 0600), an enrollment token,
// `orbit register --token` through the logging proxy, the runner started, then one workspace on a throwaway
// repository (stack.sh repo makes the bare origin and the runner's clone). Ids go to $CAS_DIR/state.json.
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { API, S, call, login, readState, saveState, stack, until } from './lib.mjs';

const state = readState();

if (!state.owner) {
  const owner = { email: 'owner@cas.test', name: 'E2E Owner', password: randomBytes(18).toString('base64url') };
  const boot = await call('POST', '/auth/bootstrap', undefined, owner);
  writeFileSync(`${S}/accounts.json`, JSON.stringify({ api: API, owner: { ...owner, id: boot.user.id } }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(`${S}/accounts.json`, 0o600);
  state.owner = { id: boot.user.id, email: owner.email };
  saveState(state);
}
const T = (await login()).accessToken;

if (!state.runner) {
  const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 'cas-e2e-runner' });
  stack('repo', '_root');
  process.stdout.write(stack('register', enroll.token));
  process.stdout.write(stack('start-runner'));
  const runner = await until('the runner to come online', async () => (await call('GET', '/runners', T)).find((r) => r.online), { timeoutMs: 120_000 });
  state.runner = { id: runner.id, name: runner.name, version: runner.version };
  saveState(state);
  console.log('runner', state.runner);
}

if (!state.workspace) {
  const [work] = stack('repo', 'app').trim().split(' ');
  const ws = await call('POST', '/workspaces', T, {
    name: 'cas-e2e', description: 'startNow / Create and start e2e (fake engine: no model is ever called)',
    runnerId: state.runner.id, workDir: work, enableWorktree: true, defaultMergeTarget: 'main',
  });
  const repoUrl = (await until('the runner to report the origin', async () => {
    const w = (await call('GET', '/workspaces', T)).find((x) => x.id === ws.id);
    return w?.repoUrl ? w : null;
  }, { timeoutMs: 300_000, everyMs: 3_000 })).repoUrl;
  state.workspace = { id: ws.id, workDir: work, repoUrl };
  saveState(state);
  console.log('workspace', state.workspace);
}
console.log(JSON.stringify(state, null, 1));
