import { describe, expect, it } from 'vitest';
import type { DirProbe, RunnerEngineHealth } from '@orbit/shared';
import { encodeId } from './idCodec';
import {
  answersDirProbe,
  defaultFolderChoice,
  firstEngineOn,
  folderName,
  folderVerdict,
  installedLogins,
  isOfferedFolder,
  isValidNewFolder,
  machineDraftPath,
  machineName,
  machinesToSetUp,
  makesNewFolders,
  newFolderPath,
  newWorkspaceOf,
  registerDirToProbe,
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
});

describe('rule 9: which machines get a Set up row', () => {
  const austin = { id: 'austin', online: true };
  const hpc = { id: 'hpc', online: true };
  const gone = { id: 'gone', online: false };

  it('an online machine with no workspace on it', () => {
    expect(machinesToSetUp([austin, hpc], [{ id: 'w', createdAt: '', runnerId: 'hpc' }])).toEqual([austin]);
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

describe('rule 2: the folder orbit register ran in is a suggestion', () => {
  it('is not asked about when the path alone is the answer, or when there is none', () => {
    for (const dir of [null, undefined, '', '   ', '~', '/', '~/', '//', ' ~ ']) {
      expect(registerDirToProbe(dir), String(dir)).toBeUndefined();
    }
  });

  it('is asked about as it was reported, tidied', () => {
    expect(registerDirToProbe('/home/orbit/code/app')).toBe('/home/orbit/code/app');
    expect(registerDirToProbe(' ~/code/app/ ')).toBe('~/code/app');
    expect(registerDirToProbe('relative/dir')).toBe('relative/dir');
  });

  it('is offered only when it is a folder that is there, and neither home nor the root', () => {
    expect(isOfferedFolder(probe())).toBe(true);
    expect(isOfferedFolder(probe({ isGit: false, branch: null }))).toBe(true);
    expect(isOfferedFolder(probe({ exists: false, isDir: false }))).toBe(false);
    expect(isOfferedFolder(probe({ isDir: false }))).toBe(false);
    expect(isOfferedFolder(probe({ isHome: true }))).toBe(false);
    expect(isOfferedFolder(probe({ path: '/' }))).toBe(false);
    expect(isOfferedFolder(probe({ error: 'permission denied' }))).toBe(false);
    expect(isOfferedFolder(null)).toBe(false);
    expect(isOfferedFolder(undefined)).toBe(false);
  });

  it('is the default only when it is a git repository; otherwise a new folder is', () => {
    expect(defaultFolderChoice(probe(), true)).toBe('suggested');
    expect(defaultFolderChoice(probe({ isGit: false }), true)).toBe('new');
    expect(defaultFolderChoice(null, true)).toBe('new');
  });

  it('on a machine that can’t make a folder, what is left', () => {
    expect(defaultFolderChoice(probe({ isGit: false }), false)).toBe('suggested');
    expect(defaultFolderChoice(null, false)).toBe('other');
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

  it('lands under the machine’s Repos Folder, however that was reported', () => {
    expect(newFolderPath('/home/orbit/orbit-repos', 'app')).toBe('/home/orbit/orbit-repos/app');
    expect(newFolderPath('/home/orbit/orbit-repos/', 'app')).toBe('/home/orbit/orbit-repos/app');
    expect(newFolderPath('C:\\Users\\orbit\\orbit-repos', 'app')).toBe('C:\\Users\\orbit\\orbit-repos\\app');
    expect(newFolderPath('/home/orbit/orbit-repos', '')).toBe('/home/orbit/orbit-repos/');
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
