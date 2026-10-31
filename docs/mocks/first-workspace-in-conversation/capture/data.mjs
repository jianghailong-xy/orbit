// Sample data for the first-workspace boards. orbit@austin is the owner's real runner as runner_list
// reported it on 2026-10-31: online, 0.1.240, Linux, Claude Code + Codex installed and signed out,
// no workspace. The other machines stand in for an account that already works elsewhere.
// Clock: the repo fixtures freeze it at 2026-09-28T12:00Z.
import { uuidToBase62 } from '/var/tmp/first-ws-mock/today/src/shared/dist/index.js';

export const NOW = Date.parse('2026-09-28T12:00:00.000Z');
export const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);

export const IDS = {
  austin: id('a01'), hpc: id('a02'),
  wsOrbit: id('b01'), wsDocs: id('b02'), wsApp: id('b03'),
  session: id('c01'),
};

const checked = (min = 6) => ({ status: 'checked', at: ago(min), okAt: ago(min) });
const signedOut = (engine, version) => ({
  engine, installed: true, auth: 'no', version, update: checked(),
  accounts: [{ id: 'default', name: 'Default', home: engine === 'claude' ? '/home/orbit/.claude' : '/home/orbit/.codex', auth: 'no' }],
});
const signedIn = (engine, version) => ({
  engine, installed: true, auth: 'yes', version, update: checked(),
  accounts: [{ id: 'default', name: 'Default', home: engine === 'claude' ? '/root/.claude' : '/root/.codex', auth: 'yes' }],
});

const base = (over) => ({
  online: true, status: 'ONLINE', activeSessions: 0, lastHeartbeatAt: ago(0.3),
  minFreeDiskMb: null, runsAsRoot: false, capabilities: [], labels: [],
  selfUpdate: { state: 'enabled', installDir: '/usr/local/bin' }, commands: [], skills: [], install: null, ...over,
});

export const AUSTIN = base({
  id: IDS.austin, name: 'orbit@austin', displayName: null, hostname: 'austin', version: '0.1.240',
  maxConcurrent: 16, enrolledAt: ago(27), reposRoot: '/home/orbit/orbit-repos',
  engines: [signedOut('claude', '2.1.302'), signedOut('codex', '0.164.0')],
  // Prototype fields (the board's server column): where `orbit register` ran and what is there.
  homeDir: '/home/orbit', registerDir: '/home/orbit/code/app',
  registerDirProbe: { path: '/home/orbit/code/app', exists: true, isGit: true, branch: 'main' },
});
/** The common case: the installer ran in the home directory, so nothing is suggested. */
export const AUSTIN_HOME = { ...AUSTIN, registerDir: '/home/orbit', registerDirProbe: { path: '/home/orbit', exists: true, isGit: false } };
export const AUSTIN_OFFLINE = { ...AUSTIN, online: false, status: 'OFFLINE', lastHeartbeatAt: ago(14) };
/** The same machine once Claude Code is signed in (the proposal's later frames). */
export const AUSTIN_READY = { ...AUSTIN, engines: [signedIn('claude', '2.1.302'), signedOut('codex', '0.164.0')] };

export const HPC = base({
  id: IDS.hpc, name: 'workstation-gpu', displayName: 'HPC', hostname: 'workstation-gpu', version: '0.1.240',
  maxConcurrent: 16, enrolledAt: '2026-09-15T04:18:09Z', reposRoot: '/root/orbit-repos', activeSessions: 2,
  engines: [signedIn('claude', '2.1.302'), signedIn('codex', '0.164.0')],
});

const ws = (wid, name, runner, workDir, extra = {}) => ({
  id: wid, name, runnerId: runner.id, runner: { id: runner.id, name: runner.name, displayName: runner.displayName },
  createdAt: '2026-09-20T02:00:00Z', position: null, lastProvider: 'claude', provider: 'claude', model: null, effort: null,
  workDir, enableWorktree: true, enabled: true, env: null, repoUrl: null,
  workDirExists: true, workDirIsGit: true, workDirProbedAt: ago(1), ...extra,
});
export const WS_ORBIT = ws(IDS.wsOrbit, 'orbit', HPC, '/root/orbit');
export const WS_DOCS = ws(IDS.wsDocs, 'orbit-docs', HPC, '/root/orbit-docs');
/** The workspace the proposal creates on orbit@austin. */
export const WS_APP = ws(IDS.wsApp, 'app', AUSTIN_READY, '/home/orbit/code/app', { enableWorktree: false });

/** A brand-new account: one machine, nothing else. */
export const NEW_USER = { runners: [AUSTIN], workspaces: [] };
/** This account today: workspaces elsewhere, orbit@austin bare. */
export const EXISTING = { runners: [HPC, AUSTIN], workspaces: [WS_ORBIT, WS_DOCS] };

export function fleetRoutes({ runners, workspaces }) {
  const counts = workspaces.map((w) => ({ workspaceId: w.id, active: 0, running: 0, jobs: 0, needsYou: 0 }));
  return {
    'GET /api/runners': runners,
    'GET /api/workspaces': workspaces,
    'GET /api/sessions/counts': counts,
    'GET /api/sessions': [],
    'GET /api/providers': [],
    'GET /api/providers/pools': [],
    'GET /api/providers/shared-pools': [],
    'GET /api/session-tags': [],
    'GET /api/session-folders': [],
    ...Object.fromEntries(runners.map((r) => [`GET /api/runners/${r.id}`, r])),
    ...Object.fromEntries(runners.map((r) => [`GET /api/runners/${r.id}/login`, LOGIN_IDLE])),
    ...Object.fromEntries(runners.map((r) => [`GET /api/runners/${r.id}/probe-dir`, (req, url) => probeDir(url.searchParams.get('path'))])),
  };
}

export const LOGIN_IDLE = { status: null, engine: null, url: null, userCode: null, message: null };
export const LOGIN_AWAITING_CODE = {
  status: 'awaiting_code', engine: 'claude', message: null, userCode: null,
  url: 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference',
};
/** What the prototype's directory check answers on orbit@austin. */
export function probeDir(path) {
  const known = {
    '/home/orbit/code/app': { exists: true, isGit: true, branch: 'main' },
    '/home/orbit/code/api': { exists: true, isGit: true, branch: 'develop' },
    '/home/orbit/notes': { exists: true, isGit: false },
  };
  return { path, ...(known[path] ?? { exists: false, isGit: false }) };
}
