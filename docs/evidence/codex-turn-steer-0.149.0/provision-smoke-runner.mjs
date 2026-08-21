// Provision a foreground-only Runner and workspace for the live smokes without touching the
// Runner that owns the verification Session. The enrollment credential is passed in memory and
// never printed. Required: ORBIT_SMOKE_RUNNER_BIN, ORBIT_SMOKE_RUNNER_HOME,
// ORBIT_SMOKE_OWNER_PUBLIC_ID (or another smoke-lib auth method).

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { base, smokeApi } from './smoke-lib.mjs';

const binary = process.env.ORBIT_SMOKE_RUNNER_BIN;
const runnerHome = process.env.ORBIT_SMOKE_RUNNER_HOME;
if (!binary || !runnerHome) throw new Error('ORBIT_SMOKE_RUNNER_BIN and ORBIT_SMOKE_RUNNER_HOME are required');
const suffix = process.env.ORBIT_SMOKE_RUNNER_SUFFIX || basename(runnerHome).split('.').at(-1);
const runnerName = `codex-steer-6r-${suffix}`;
const workspaceName = `${runnerName}-workspace`;
const workDir = process.cwd();
const { api } = await smokeApi();

const enrollment = await api('/runners/enrollment-tokens', {
  method: 'POST',
  body: JSON.stringify({ label: runnerName, ttlHours: 1 }),
});
const registration = spawnSync(
  binary,
  [
    'register',
    '--server',
    base,
    '--token',
    enrollment.token,
    '--name',
    runnerName,
    '--max-concurrent',
    '3',
    '--workdir',
    workDir,
    '--no-service',
    '--no-auto-install-engines',
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORBIT_HOME: runnerHome,
      ORBIT_NO_SELFUPDATE: '1',
      ORBIT_NO_ENGINE_UPDATE: '1',
    },
    maxBuffer: 10 * 1024 * 1024,
  },
);
if (registration.status !== 0) {
  throw new Error(`runner registration failed: ${registration.stderr || registration.stdout}`);
}

const runners = await api('/runners');
const runner = runners.find((candidate) => candidate.name === runnerName);
if (!runner) throw new Error(`registered runner ${runnerName} was not returned by GET /runners`);
const workspace = await api('/workspaces', {
  method: 'POST',
  body: JSON.stringify({
    name: workspaceName,
    description: 'Ephemeral 6R Codex turn/steer verification workspace',
    runnerId: runner.id,
    workDir,
    enabled: true,
    enableWorktree: true,
    enableOrchestration: false,
    autoInitGit: false,
  }),
});

console.log(
  'SMOKE_RUNNER_PROVISIONED=' +
    JSON.stringify({
      runnerId: runner.id,
      runnerName,
      workspaceId: workspace.publicId || workspace.id,
      workspaceName,
      runnerHome,
      binary,
      sourceWorkDir: workDir,
    }),
);
