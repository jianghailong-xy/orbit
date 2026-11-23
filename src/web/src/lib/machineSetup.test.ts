import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ManagedRunnerStatus, type DirProbe, type RunnerEngineHealth } from '@orbit/shared';
import { encodeId } from './idCodec';
import {
  answersDirProbe,
  firstEngineOn,
  folderName,
  folderVerdict,
  installedLogins,
  isConnecting,
  isValidNewFolder,
  machineDraftPath,
  isManagedRunner,
  machineName,
  machinesToSetUp,
  makesNewFolders,
  newFolderPath,
  newFolderPick,
  newFolderVerdict,
  newWorkspaceOf,
  updatesItself,
} from './machineSetup';
import { showsConversation } from './paneTransition';

/** The rules of a machine's first workspace, from docs/mocks/first-workspace-in-conversation/04-rules. */

const RUNNER = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69';

const probe = (over: Partial<DirProbe> = {}): DirProbe => ({
  path: '/home/orbit/code/app',
  exists: true,
  isDir: true,
  isGit: true,
  branch: 'main',
  isHome: false,
  freeBytes: 1024,
  ...over,
});

const engine = (name: string, auth: 'yes' | 'no' | 'unknown', installed = true) =>
  ({ engine: name, installed, auth }) as RunnerEngineHealth;

describe('a machine’s new session page', () => {
  it('has an address of its own, in the public spelling, that puts the conversation pane on a phone', () => {
    expect(machineDraftPath(RUNNER)).toBe(`/runners/${encodeId(RUNNER)}/new`);
    expect(machineDraftPath(RUNNER)).not.toContain(RUNNER);
    expect(showsConversation(machineDraftPath(RUNNER))).toBe(true);
    expect(showsConversation(`/runners/${encodeId(RUNNER)}`)).toBe(false);
  });

  it('names a machine the way the app does', () => {
    expect(machineName({ name: 'workstation-gpu', displayName: 'HPC' })).toBe('HPC');
    expect(machineName({ name: 'orbit@austin', displayName: null })).toBe('orbit@austin');
    expect(machineName({ name: 'orbit@austin', displayName: '' })).toBe('orbit@austin');
  });

  it("says Orbit Cloud for the row GET /runners marks managed, with no managed status yet; the owner's name still wins", () => {
    expect(machineName({ id: RUNNER, name: 'orbit-cloud', displayName: null, managed: true })).toBe('Orbit Cloud');
    expect(machineName({ id: RUNNER, name: 'orbit-cloud', displayName: 'Team cloud', managed: true })).toBe('Team cloud');
    expect(machineName({ id: 'r2', name: 'build-box', displayName: null, managed: false })).toBe('build-box');
    // An older server sends no flag: the managed status's runnerId still says which runner it is.
    expect(machineName({ id: RUNNER, name: 'orbit-cloud', displayName: null }, RUNNER)).toBe('Orbit Cloud');
    expect(isManagedRunner({ id: RUNNER, managed: true }, null)).toBe(true);
    expect(isManagedRunner({ id: 'r2', managed: false }, RUNNER)).toBe(false);
  });
});

describe('rule 9: which machines get a Set up row', () => {
  const austin = { id: 'austin', online: true };
  const hpc = { id: 'hpc', online: true };
  const gone = { id: 'gone', online: false };

  it('an online machine with no workspace on it', () => {
    expect(machinesToSetUp([austin, hpc], [{ id: 'w', createdAt: '', runnerId: 'hpc' }])).toEqual([austin]);
  });

  it('offers the managed machine while preparing or asleep, but still excludes ordinary offline machines', () => {
    const fixture = JSON.parse(readFileSync('../shared/src/managed-runner-states.fixture.json', 'utf8'));
    for (const sample of fixture.states) {
      const status = sample.status as ManagedRunnerStatus;
      const managed = { id: status.runnerId ?? 'unmapped', online: false };
      expect(machinesToSetUp([gone, managed], [], status)).toEqual(sample.setupState ? [managed] : []);
      expect(machinesToSetUp([managed], [{ id: 'w', createdAt: '', runnerId: managed.id }], status)).toEqual([]);
    }
  });

  it('not one that is offline, whatever it holds', () => {
    expect(machinesToSetUp([gone], [])).toEqual([]);
  });

  it('a workspace is read in either shape the payload carries its runner', () => {
    expect(machinesToSetUp([austin], [{ id: 'w', createdAt: '', runner: { id: 'austin' } }])).toEqual([]);
  });

  it('a config-only workspace is on no machine', () => {
    expect(machinesToSetUp([austin], [{ id: 'w', createdAt: '', runnerId: null }])).toEqual([austin]);
  });

  it('keeps the runner list’s order', () => {
    expect(machinesToSetUp([hpc, gone, austin], [])).toEqual([hpc, austin]);
  });
});

describe('what a machine declares', () => {
  it('is asked about a path only if it says it answers', () => {
    expect(answersDirProbe({ capabilities: ['dir-probe/v1'] })).toBe(true);
    expect(answersDirProbe({ capabilities: [] })).toBe(false);
    expect(answersDirProbe({})).toBe(false);
  });

  it('makes a new folder only if it says so and has reported where they go (contract §3.1)', () => {
    expect(makesNewFolders({ capabilities: ['create-workdir/v1'], reposRoot: '/home/orbit/orbit-repos' })).toBe(true);
    expect(makesNewFolders({ capabilities: ['create-workdir/v1'], reposRoot: null })).toBe(false);
    expect(makesNewFolders({ capabilities: ['create-workdir/v1'], reposRoot: '  ' })).toBe(false);
    expect(makesNewFolders({ capabilities: [], reposRoot: '/home/orbit/orbit-repos' })).toBe(false);
  });

  it('too old to answer, it gets there by itself unless its updater says it can’t', () => {
    expect(updatesItself({})).toBe(true);
    expect(updatesItself({ selfUpdate: null })).toBe(true);
    expect(updatesItself({ selfUpdate: { state: 'enabled' } })).toBe(true);
    expect(updatesItself({ selfUpdate: { state: 'disabledByEnv' } })).toBe(false);
    expect(updatesItself({ selfUpdate: { state: 'dirNotWritable' } })).toBe(false);
  });

  it('approved and never heard from, it is still connecting: offline with no heartbeat yet', () => {
    // What the server reads for a machine whose `orbit run` has not beaten yet (contract §2).
    expect(isConnecting({ online: false, lastHeartbeatAt: null })).toBe(true);
    expect(isConnecting({ online: false })).toBe(true);
  });

  it('heard from once, it is offline or online, never connecting', () => {
    expect(isConnecting({ online: false, lastHeartbeatAt: '2026-10-31T09:00:00Z' })).toBe(false);
    expect(isConnecting({ online: true, lastHeartbeatAt: '2026-10-31T09:00:00Z' })).toBe(false);
    // Online is its own heartbeat's word, whatever else the row has yet to carry.
    expect(isConnecting({ online: true, lastHeartbeatAt: null })).toBe(false);
  });
});

describe('rule 3: a new folder', () => {
  it('takes the names the server takes: one segment of 1–64 of [A-Za-z0-9._-], not . or ..', () => {
    for (const good of ['app', 'payments-api', 'a.b_c-1', '.hidden', 'x'.repeat(64)]) {
      expect(isValidNewFolder(good), good).toBe(true);
    }
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'with space', 'naïve', '~', 'x'.repeat(65)]) {
      expect(isValidNewFolder(bad), bad).toBe(false);
    }
  });

  it('lands under the root it is given, however that was reported', () => {
    expect(newFolderPath('/home/orbit/orbit-repos', 'app')).toBe('/home/orbit/orbit-repos/app');
    expect(newFolderPath('/home/orbit/orbit-repos/', 'app')).toBe('/home/orbit/orbit-repos/app');
    expect(newFolderPath('C:\\Users\\orbit\\orbit-repos', 'app')).toBe('C:\\Users\\orbit\\orbit-repos\\app');
    expect(newFolderPath('/home/orbit/orbit-repos', '')).toBe('/home/orbit/orbit-repos/');
  });

  const machine = 'orbit@austin';
  const at = (over: Partial<DirProbe>) =>
    probe({ path: '/home/orbit/orbit-repos/app', exists: false, isDir: false, isGit: false, branch: null, ...over });

  it('nothing there yet: it is made as the session starts', () => {
    expect(newFolderVerdict(at({}), machine)).toEqual({
      tone: 'ok',
      text: 'New folder · created as the session starts.',
      short: 'new folder · created as the session starts',
      usable: true,
    });
    expect(newFolderPick(at({}), 'app', '/home/orbit/orbit-repos', machine)).toEqual({
      kind: 'new',
      name: 'app',
      path: '/home/orbit/orbit-repos/app',
    });
  });

  it('a folder there already: used with what is in it, read and sent by its path like any folder', () => {
    const there = at({ exists: true, isDir: true, isGit: true, branch: 'main' });
    expect(newFolderVerdict(there, machine)).toEqual({
      tone: 'ok',
      text: 'Found · git repository · main',
      short: 'git repository · main',
      usable: true,
    });
    expect(newFolderPick(there, 'app', '/home/orbit/orbit-repos', machine)).toEqual({
      kind: 'existing',
      path: '/home/orbit/orbit-repos/app',
      note: 'git repository · main',
    });
    expect(newFolderVerdict(at({ exists: true, isDir: true }), machine).short).toBe(
      'not a git repository — sessions will share it instead of isolating.',
    );
  });

  it('a file there: no folder can be made over it, and it says why', () => {
    const file = at({ exists: true });
    expect(newFolderVerdict(file, machine)).toEqual({
      tone: 'bad',
      text: 'There’s already a file with this name on orbit@austin. Pick another name.',
      short: 'There’s already a file with this name on orbit@austin. Pick another name.',
      usable: false,
    });
    expect(newFolderPick(file, 'app', '/home/orbit/orbit-repos', machine)).toBeNull();
  });

  it('a look the runner could not take: nothing to pick on', () => {
    const failed = at({ error: 'permission denied' });
    expect(newFolderVerdict(failed, machine)).toMatchObject({
      tone: 'bad',
      text: 'Couldn’t check on orbit@austin: permission denied',
      usable: false,
    });
    expect(newFolderPick(failed, 'app', '/home/orbit/orbit-repos', machine)).toBeNull();
  });
});

describe('rule 4: how a checked path reads', () => {
  const machine = 'orbit@austin';

  it('a git repository names its branch', () => {
    expect(folderVerdict(probe(), machine)).toEqual({
      tone: 'ok',
      text: 'Found · git repository · main',
      short: 'git repository · main',
      usable: true,
    });
  });

  it('a detached HEAD has none to name', () => {
    expect(folderVerdict(probe({ branch: null }), machine).text).toBe('Found · git repository');
  });

  it('a folder that is no repository can be used, and says what that costs', () => {
    expect(folderVerdict(probe({ isGit: false, branch: null }), machine)).toEqual({
      tone: 'warn',
      text: 'Found · not a git repository — sessions will share it instead of isolating.',
      short: 'not a git repository — sessions will share it instead of isolating.',
      usable: true,
    });
  });

  it('what isn’t there can’t be used', () => {
    const verdict = folderVerdict(probe({ exists: false, isDir: false, isGit: false }), machine);
    expect(verdict).toMatchObject({ tone: 'bad', text: 'No such directory on orbit@austin.', usable: false });
  });

  it('nor a file, nor a path the runner could not look at', () => {
    expect(folderVerdict(probe({ isDir: false, isGit: false }), machine)).toMatchObject({
      text: 'That isn’t a directory on orbit@austin.',
      usable: false,
    });
    expect(folderVerdict(probe({ exists: false, error: 'permission denied' }), machine)).toMatchObject({
      text: 'Couldn’t check on orbit@austin: permission denied',
      usable: false,
    });
  });
});

describe('what POST /sessions is told', () => {
  it('a new folder by its name, an existing one by the path the runner resolved', () => {
    expect(newWorkspaceOf({ kind: 'new', name: 'app', path: '/home/orbit/orbit-repos/app' })).toEqual({ newFolder: 'app' });
    expect(newWorkspaceOf({ kind: 'existing', path: '/home/orbit/code/app', note: '' })).toEqual({
      workDir: '/home/orbit/code/app',
    });
  });

  it('the workspace name a folder gives, as the server derives it', () => {
    expect(folderName('/home/orbit/code/app')).toBe('app');
    expect(folderName('/home/orbit/code/app/')).toBe('app');
    expect(folderName('C:\\work\\app')).toBe('app');
    expect(folderName('/')).toBe('/');
  });
});

describe('which engine a machine’s first draft starts on', () => {
  it('one signed in, before one that isn’t', () => {
    expect(firstEngineOn([engine('claude', 'no'), engine('codex', 'yes')])).toBe('codex');
  });

  it('else the first it has', () => {
    expect(firstEngineOn([engine('claude', 'no', false), engine('codex', 'no')])).toBe('codex');
    expect(firstEngineOn([engine('codex', 'no'), engine('claude', 'no')])).toBe('claude');
  });

  it('else Claude Code, on a machine that has said nothing', () => {
    expect(firstEngineOn(null)).toBe('claude');
    expect(firstEngineOn([])).toBe('claude');
  });

  it('counts only what signs in: OpenCode and an engine that isn’t installed are not logins', () => {
    expect(installedLogins([engine('opencode', 'unknown'), engine('codex', 'no'), engine('kimi', 'no', false)])).toEqual([
      'codex',
    ]);
  });

  it('an answer of unknown is not a yes', () => {
    expect(firstEngineOn([engine('claude', 'unknown'), engine('codex', 'unknown')])).toBe('claude');
  });
});
