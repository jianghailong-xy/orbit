// A fresh stack's owner, runner and workspaces, through the real HTTP API (no database writes):
//   R2913_STACK=a|b node bootstrap.mjs <runner-binary-name> <repo>[:<extra-branch>] ...
// POST /auth/bootstrap (the owner; password random, kept in <stack>/accounts.json 0600), an enrollment token,
// `orbit register --token` with that runner binary through the logging proxy, the runner started, then one
// workspace per repo (stack.sh repo makes the bare origin and the runner's clone; the runner's probe reports
// the workspace's repoUrl). Ids go to <stack>/state.json.
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { API, SD, call, login, readState, saveState, stack, until } from './lib.mjs';

const [bin, ...repos] = process.argv.slice(2);
if (!bin || !repos.length) throw new Error('usage: node bootstrap.mjs <runner-bin> <repo>[:<branch>] ...');
const state = readState();

if (!state.owner) {
  const owner = { email: 'owner@r2913.test', name: 'R29-13 Owner', password: randomBytes(18).toString('base64url') };
  const boot = await call('POST', '/auth/bootstrap', undefined, owner);
  writeFileSync(`${SD}/accounts.json`, JSON.stringify({ api: API, owner: { ...owner, id: boot.user.id } }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(`${SD}/accounts.json`, 0o600);
  state.owner = { id: boot.user.id, email: owner.email };
  saveState(state);
}
const T = await login();

if (!state.runner) {
  const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 'r2913-runner' });
  stack('repo', '_root');
  process.stdout.write(stack('register', enroll.token, bin));
  process.stdout.write(stack('start-runner', bin));
  const runner = await until('the runner to come online', async () => (await call('GET', '/runners', T)).find((r) => r.online), { timeoutMs: 120_000 });
  state.runner = { id: runner.id, name: runner.name, version: runner.version, binary: bin };
  saveState(state);
  console.log('runner', state.runner);
}

state.workspaces ??= {};
for (const spec of repos) {
  const [name, branch] = spec.split(':');
  if (state.workspaces[name]) continue;
  const [work] = stack('repo', name, ...(branch ? [branch] : [])).trim().split(' ');
  const ws = await call('POST', '/workspaces', T, {
    name: `r2913-${name}`, description: `R29-13 e2e repository ${name} (fake engine: no model is ever called)`,
    runnerId: state.runner.id, workDir: work, enableWorktree: true, defaultMergeTarget: 'main',
  });
  const repoUrl = (await until(`the runner to report ${name}'s origin`, async () => {
    const w = (await call('GET', '/workspaces', T)).find((x) => x.id === ws.id);
    return w?.repoUrl ? w : null;
  }, { timeoutMs: 300_000, everyMs: 3_000 })).repoUrl;
  state.workspaces[name] = { id: ws.id, workDir: work, repoUrl };
  saveState(state);
  console.log('workspace', name, state.workspaces[name]);
}
console.log(JSON.stringify(state, null, 1));
