// Sample data for the new-user onboarding boards. Clock: the repo fixtures freeze it at 2026-09-28T12:00Z.
import { readFileSync } from 'node:fs';
const T = '/mnt/data/tmp/runner-res-mock/tree';
const FX = JSON.parse(readFileSync(`${T}/src/shared/src/managed-runner-states.fixture.json`, 'utf8'));
export const NOW = Date.parse('2026-09-28T12:00:00.000Z');
export const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const st = (name) => {
  const s = FX.states.find((x) => x.name === name);
  if (!s) throw new Error('no state ' + name);
  return s.status;
};
export const MR = {
  preparing: st('preparing: starting'),
  model: st('model unavailable: started without a signed-in runtime'),
  available: st('available'),
};
export const RID = MR.model.runnerId, WID = MR.model.workspaceId;
const checked = { status: 'checked', at: ago(6), okAt: ago(6) };
const eng = (engine, version, auth) => ({
  engine, installed: true, auth, version, update: checked,
  accounts: [{ id: 'default', name: 'Default', home: `/var/lib/orbit/home/.${engine}`, auth }],
});
const runner = (over) => ({
  id: RID, name: 'managed-mia', displayName: null, hostname: 'orbit-managed-mia', version: '0.1.250',
  online: true, status: 'ONLINE', activeSessions: 0, lastHeartbeatAt: ago(0.3), minFreeDiskMb: null, runsAsRoot: false,
  capabilities: ['dir-probe/v1', 'create-workdir/v1'], labels: [], registerDir: null, maxConcurrent: 4,
  enrolledAt: ago(2), reposRoot: '/var/lib/orbit/home/orbit-repos',
  selfUpdate: { state: 'enabled', installDir: '/usr/local/bin' }, commands: [], skills: [], install: null,
  engines: [eng('claude', '2.1.302', 'no'), eng('codex', '0.164.0', 'no')], ...over,
});
export const R_OFF = runner({ online: false, status: 'OFFLINE', lastHeartbeatAt: null, engines: null });
export const R_OUT = runner({});
export const R_IN = runner({ engines: [eng('claude', '2.1.302', 'yes'), eng('codex', '0.164.0', 'no')] });
export const WS = (r) => ({
  id: WID, name: 'default', runnerId: r.id, runner: { id: r.id, name: r.name, displayName: null },
  createdAt: ago(2), position: null, lastProvider: null, provider: null, model: null, effort: null,
  workDir: '/var/lib/orbit/home/orbit-repos/default', enableWorktree: true, enabled: true, env: null, repoUrl: null,
  workDirExists: true, workDirIsGit: true, workDirProbedAt: ago(1),
});
export const LOGIN_IDLE = { status: null, engine: null, url: null, userCode: null, message: null };
export function fleetRoutes({ runners, workspaces, managed }) {
  const counts = workspaces.map((w) => ({ workspaceId: w.id, active: 0, running: 0, jobs: 0, needsYou: 0 }));
  const r = {
    'GET /api/runners': runners, 'GET /api/workspaces': workspaces, 'GET /api/sessions/counts': counts,
    'GET /api/sessions': [], 'GET /api/providers': [], 'GET /api/providers/pools': [], 'GET /api/providers/shared-pools': [],
    'GET /api/session-tags': [], 'GET /api/session-folders': [],
    'GET /api/projects/sidebar': [], 'GET /api/wiki/spaces': [], 'GET /api/projects': [],
    ...Object.fromEntries(runners.map((x) => [`GET /api/runners/${x.id}`, x])),
    ...Object.fromEntries(runners.map((x) => [`GET /api/runners/${x.id}/login`, LOGIN_IDLE])),
  };
  if (managed) {
    r['GET /api/auth/capabilities'] = { managedRunners: { enabled: true, contractVersion: 1 } };
    r['GET /api/managed-runner'] = managed;
  }
  return r;
}
