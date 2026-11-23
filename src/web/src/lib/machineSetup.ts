import {
  cloneRootFor,
  CREATE_WORKDIR_CAPABILITY,
  managedSetupState,
  type ManagedRunnerStatus,
  DIR_PROBE_CAPABILITY,
  type DirProbe,
  type LoginEngine,
  type NewWorkspaceRequest,
  type RunnerEngineHealth,
  newFolderPath,
} from '@orbit/shared';
import { encodeId, routeId } from './idCodec';
import { MANAGED_RUNNER_LABEL } from './runnerCopy';
import {
  SETUP_FOUND_PREFIX,
  SETUP_NEW_FOLDER_DONE,
  SETUP_NEW_FOLDER_META,
  SETUP_NOT_GIT,
  setupCouldNotCheck,
  setupGit,
  setupNewFolderIsFile,
  setupNoSuchDirectory,
  setupNotADirectory,
} from './machineSetupCopy';
import { workspaceRunnerId, type OrderableWorkspace } from './workspaceOrder';

/**
 * A machine with no workspace: what its first one is made from (docs/first-workspace-contract.md and
 * rules 1–12 of docs/mocks/first-workspace-in-conversation/04-rules). The setup card, the sidebar's
 * Set up rows, the landing and the entries read these, so they cannot disagree about which machine is
 * meant or which folder is on offer. Pure: nothing here fetches or stores.
 */

/** A machine's own new session page. Its own address, because `/workspaces/:id` names a workspace and a
 *  machine with none has no workspace to name; `/workspaces/<runner>` redirects here (WorkspaceConsole). */
export const machineDraftPath = (runnerId: string): string => `/runners/${encodeId(runnerId)}/new`;

/** The name the app labels a machine with everywhere: the owner's own name for it, else Orbit Cloud for
 *  the account's managed runner (isManagedRunner — never its stored name), else the name it registered with. */
export const machineName = (
  runner: { id?: string; name?: string; displayName?: string | null; managed?: boolean },
  managedRunnerId?: string | null,
): string =>
  runner.displayName?.trim() || (isManagedRunner(runner, managedRunnerId) ? MANAGED_RUNNER_LABEL : (runner.name ?? ''));

/** Whether `runner` is the account's managed runner: its runner row says so (`managed`, RunnerRowIdentity),
 *  or — for an older server's row, or a runner nested in another answer — its id is `managedRunnerId`. */
export const isManagedRunner = (
  runner: { id?: string; managed?: boolean } | null | undefined,
  managedRunnerId: string | null | undefined,
): boolean =>
  runner?.managed === true || (!!runner?.id && !!managedRunnerId && routeId(runner.id) === routeId(managedRunnerId));

/** Machines without a workspace, in list order: online machines and managed machines accepting queued work. */
export function machinesToSetUp<R extends { id: string; online?: boolean }>(
  runners: readonly R[],
  workspaces: readonly OrderableWorkspace[],
  managedStatus?: ManagedRunnerStatus | null,
): R[] {
  const taken = new Set(workspaces.map(workspaceRunnerId));
  return runners.filter((runner) => (runner.online || managedSetupState(runner.id, managedStatus) !== null) && !taken.has(runner.id));
}

/** Whether a machine can be asked about a path at all, and whether it can make a new folder: the
 *  capabilities it declares (§2, §3.1 of the contract), and for a new folder the Repos Folder it goes in. */
export const answersDirProbe = (runner: { capabilities?: string[] }): boolean =>
  !!runner.capabilities?.includes(DIR_PROBE_CAPABILITY);
export const makesNewFolders = (runner: { capabilities?: string[]; reposRoot?: string | null }): boolean =>
  !!runner.capabilities?.includes(CREATE_WORKDIR_CAPABILITY) && !!runner.reposRoot?.trim();
/** Whether a machine clones a GitHub repository on request (docs/github-workspace-design.md §6): it declares
 *  clone-workdir/v1 and has reported the Repos Folder the clone goes in. POST /sessions refuses either missing. */
export const clonesRepositories = (runner: { capabilities?: string[]; reposRoot?: string | null }): boolean =>
  cloneRootFor(runner) !== null;

/** A path as the board writes it: the home folder as `~` (`/Users/austin/orbit-repos/x` → `~/orbit-repos/x`). */
export function homeShortPath(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~');
}

/** The folder a repository is cloned into by default, as the server derives it: its name, when that is a folder name. */
export function repositoryFolder(fullName: string): string {
  const name = fullName.split('/').pop() ?? '';
  return isValidNewFolder(name) ? name : '';
}

/** Whether a machine too old to answer gets there by itself: not one that reports its updater off, or
 *  unable to write where it is installed. One too old to report anything still updates itself. */
export const updatesItself = (runner: { selfUpdate?: { state?: string } | null }): boolean =>
  runner.selfUpdate?.state !== 'disabledByEnv' && runner.selfUpdate?.state !== 'dirNotWritable';

/** A machine approved a moment ago that has not connected yet: never heard from, so it reads offline and has
 *  declared nothing (contract §2). Not one too old to check folders, nor one that went away: it is waited for. */
export const isConnecting = (runner: { online?: boolean; lastHeartbeatAt?: string | null }): boolean =>
  runner.online !== true && runner.lastHeartbeatAt == null;

/** How often a machine's new session page reads the machine again while its card is up, as the native pages do:
 *  a sign-in landing or the machine going away moves the card by itself. One still connecting is read more often,
 *  so the folder step opens within seconds of its first heartbeat. */
export const SETUP_POLL_MS = 5_000;
export const SETUP_CONNECTING_POLL_MS = 2_000;

/** `newFolder`'s rule on the server (§3.1): one path segment, nothing a shell or a path could read
 *  anything into. */
export function isValidNewFolder(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

/** Where a new folder lands: `<root>/<name>`, as the server joins it. */
export { newFolderPath };

/** The workspace name a folder gives, as the server derives it (§3.2): its last segment. */
export function folderName(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;
}

/** How a checked path reads, and whether it may be used. Rule 4: what isn't there can't be picked; a
 *  folder that is not a git repository can, and says what that costs; a repository names its branch. */
export interface FolderVerdict {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  /** The same, as the folder's line once it is picked: without the "Found". */
  short: string;
  usable: boolean;
}

export function folderVerdict(probe: DirProbe, machine: string): FolderVerdict {
  const refused = (text: string): FolderVerdict => ({ tone: 'bad', text, short: text, usable: false });
  if (probe.error) return refused(setupCouldNotCheck(machine, probe.error));
  if (!probe.exists) return refused(setupNoSuchDirectory(machine));
  if (!probe.isDir) return refused(setupNotADirectory(machine));
  const short = probe.isGit ? setupGit(probe.branch) : SETUP_NOT_GIT;
  return { tone: probe.isGit ? 'ok' : 'warn', text: `${SETUP_FOUND_PREFIX}${short}`, short, usable: true };
}

/** What the folder step's name finds at `<root>/<name>`, asked before anything is sent. Nothing there is a new
 *  folder, made as the session starts; a directory is used as it stands, read as any folder is; a file can't
 *  become one. */
export function newFolderVerdict(probe: DirProbe, machine: string): FolderVerdict {
  const refused = (text: string): FolderVerdict => ({ tone: 'bad', text, short: text, usable: false });
  if (probe.error) return refused(setupCouldNotCheck(machine, probe.error));
  if (!probe.exists) return { tone: 'ok', text: SETUP_NEW_FOLDER_META, short: SETUP_NEW_FOLDER_DONE, usable: true };
  if (!probe.isDir) return refused(setupNewFolderIsFile(machine));
  return folderVerdict(probe, machine);
}

/** What Use this folder picks on that answer: a new folder while nothing is there, else the directory that is,
 *  which is then a folder like any other and is sent by its path. */
export function newFolderPick(probe: DirProbe, name: string, root: string, machine: string): PickedFolder | null {
  const verdict = newFolderVerdict(probe, machine);
  if (!verdict.usable) return null;
  return probe.exists
    ? { kind: 'existing', path: probe.path, note: verdict.short }
    : { kind: 'new', name, path: newFolderPath(root, name) };
}

/** A folder field's text that names a whole path (`/srv/app`, `~/code/app`) rather than one folder in the machine's home
 *  (docs/mocks/new-workspace-form, decision 2 A): the machine is asked about that path itself. */
export const isFolderPath = (typed: string): boolean => /^[~/]/.test(typed);

/** What Create workspace picks on a full path's answer: the directory as it stands. Nothing is made for a path outside
 *  the machine's home, so one that isn't there is refused as any folder is. */
export function folderPathPick(probe: DirProbe, machine: string): PickedFolder | null {
  const verdict = folderVerdict(probe, machine);
  return verdict.usable ? { kind: 'existing', path: probe.path, note: verdict.short } : null;
}

/** The folder step's answer, once the person has pressed Use this folder. */
export type PickedFolder =
  | { kind: 'existing'; path: string; note: string }
  | { kind: 'new'; name: string; path: string }
  /** A clone of one of the person's GitHub repositories into `<reposRoot>/<name>` (docs/github-workspace-design.md §5.3).
   *  `ref` null is the repository's default branch, which `defaultBranch` names. */
  | {
      kind: 'github';
      repoId: number;
      repository: string;
      private: boolean;
      defaultBranch: string;
      ref: string | null;
      name: string;
      path: string;
    };

/** What POST /sessions is told. An existing folder is sent as the runner resolved it: a typed `~` is
 *  the runner's to expand, and a workspace's workDir is not. */
export const newWorkspaceOf = (folder: PickedFolder): NewWorkspaceRequest =>
  folder.kind === 'new'
    ? { newFolder: folder.name }
    : folder.kind === 'github'
      ? { github: { repoId: folder.repoId, folder: folder.name, ...(folder.ref ? { ref: folder.ref } : {}) } }
      : { workDir: folder.path };

const LOGIN_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'kimi', 'antigravity', 'cursor'];

/** The login CLIs installed here, in the app's order. */
export const installedLogins = (engines: readonly RunnerEngineHealth[] | null | undefined): LoginEngine[] =>
  LOGIN_ENGINES.filter((engine) => engines?.find((e) => e.engine === engine)?.installed);

/** Which engine a machine's first draft starts on, with nothing picked: one that can run now, else one
 *  it has, else Claude Code, which is what a machine that has reported nothing yet will have. A card
 *  asking to sign Claude Code in beside a signed-in Codex would ask for what isn't needed. */
export function firstEngineOn(engines: readonly RunnerEngineHealth[] | null | undefined): LoginEngine {
  const installed = installedLogins(engines);
  return installed.find((engine) => engines?.find((e) => e.engine === engine)?.auth === 'yes') ?? installed[0] ?? 'claude';
}
