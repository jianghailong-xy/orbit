// The stack's runner and workspaces, through the real HTTP API (no database writes):
//   node bootstrap.mjs <repo> ...
// The owner is the one staging-up.sh seeded. An enrollment token, `orbit register --token` with this checkout's runner
// build, the runner started, then one workspace per repo (stack.sh repo makes the bare origin and the runner's clone;
// the runner's probe reports the workspace's repoUrl). Ids go to $LM_DIR/state.json.
import { call, login, readState, saveState, stack, until } from './lib.mjs';

const repos = process.argv.slice(2);
if (!repos.length) throw new Error('usage: node bootstrap.mjs <repo> ...');
const state = readState();
const T = await login();

const online = async () => (await call('GET', '/runners', T)).find((r) => r.name === 'lm42-runner' && r.online);
if (!state.runner || !(await until('the runner to be online', online, { timeoutMs: 60_000 }).catch(() => null))) {
  const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 'lm42-runner' });
  stack('repo', '_root');
  process.stdout.write(stack('register', enroll.token));
  process.stdout.write(stack('start-runner'));
  const runner = await until('the runner to come online', online, { timeoutMs: 120_000 });
  state.runner = { id: runner.id, name: runner.name, version: runner.version };
  state.workspaces = {};
  saveState(state);
  console.log('runner', state.runner);
}

state.workspaces ??= {};
for (const name of repos) {
  if (state.workspaces[name]) continue;
  const [work] = stack('repo', name).trim().split(' ');
  const ws = await call('POST', '/workspaces', T, {
    name: `lm42-${name}`, description: `revision 42 part two e2e repository ${name} (fake engine: no model is ever called)`,
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
