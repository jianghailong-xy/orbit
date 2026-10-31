import {
  CREATE_WORKDIR_CAPABILITY,
  DIR_PROBE_CAPABILITY,
  type DirProbe,
  type LoginEngine,
  type NewWorkspaceRequest,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { encodeId } from './idCodec';
import {
  SETUP_FOUND_PREFIX,
  SETUP_NOT_GIT,
  setupCouldNotCheck,
  setupGit,
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

/** The name the app labels a machine with everywhere. */
export const machineName = (runner: { name: string; displayName?: string | null }): string =>
  runner.displayName || runner.name;

/** Rule 9: the machines that get a Set up row, in the runner list's order. Online, with no workspace
 *  of this account on them: an offline one is already what Machines & models says needs you. */
export function machinesToSetUp<R extends { id: string; online?: boolean }>(
  runners: readonly R[],
  workspaces: readonly OrderableWorkspace[],
): R[] {
  const taken = new Set(workspaces.map(workspaceRunnerId));
  return runners.filter((runner) => runner.online && !taken.has(runner.id));
}

/** Whether the directory `orbit register` ran in is worth asking about: the two answers a path can give
 *  on its face are left unasked. `undefined` when there is nothing to ask. */
export function registerDirToProbe(registerDir: string | null | undefined): string | undefined {
  const dir = registerDir?.trim().replace(/(?<=.)\/+$/, '');
  return !dir || dir === '~' || dir === '/' ? undefined : dir;
}

/** Rule 2: a checked register directory is offered only when it is a folder that exists and is neither
 *  the home directory nor the root. The installer runs where the terminal stands, which is usually
 *  home, and all of home is no default. */
export function isOfferedFolder(probe: DirProbe | null | undefined): probe is DirProbe {
  return !!probe && !probe.error && probe.exists && probe.isDir && !probe.isHome && probe.path !== '/';
}

export type FolderChoice = 'suggested' | 'new' | 'other';

/** Rule 2 again: the register directory leads when it is a git repository; otherwise a new folder. The
 *  rest is what a machine that can't make one leaves. */
export function defaultFolderChoice(suggested: DirProbe | null, offersNewFolder: boolean): FolderChoice {
  if (suggested?.isGit) return 'suggested';
  if (offersNewFolder) return 'new';
  return suggested ? 'suggested' : 'other';
}

/** Whether a machine can be asked about a path at all, and whether it can make a new folder: the
 *  capabilities it declares (§2, §3.1 of the contract), and for a new folder the Repos Folder it goes in. */
export const answersDirProbe = (runner: { capabilities?: string[] }): boolean =>
  !!runner.capabilities?.includes(DIR_PROBE_CAPABILITY);
export const makesNewFolders = (runner: { capabilities?: string[]; reposRoot?: string | null }): boolean =>
  !!runner.capabilities?.includes(CREATE_WORKDIR_CAPABILITY) && !!runner.reposRoot?.trim();

/** Whether a machine too old to answer gets there by itself: not one that reports its updater off, or
 *  unable to write where it is installed. One too old to report anything still updates itself. */
export const updatesItself = (runner: { selfUpdate?: { state?: string } | null }): boolean =>
  runner.selfUpdate?.state !== 'disabledByEnv' && runner.selfUpdate?.state !== 'dirNotWritable';

/** `newFolder`'s rule on the server (§3.1): one path segment, nothing a shell or a path could read
 *  anything into. */
export function isValidNewFolder(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

/** Where a new folder lands: `<reposRoot>/<name>`, as the server joins it. */
export function newFolderPath(reposRoot: string, name: string): string {
  const separator = reposRoot.includes('\\') && !reposRoot.includes('/') ? '\\' : '/';
  return `${reposRoot.replace(/[/\\]+$/, '')}${separator}${name}`;
}

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

/** The folder step's answer, once the person has pressed Use this folder. */
export type PickedFolder =
  | { kind: 'existing'; path: string; note: string }
  | { kind: 'new'; name: string; path: string };

/** What POST /sessions is told. An existing folder is sent as the runner resolved it: a typed `~` is
 *  the runner's to expand, and a workspace's workDir is not. */
export const newWorkspaceOf = (folder: PickedFolder): NewWorkspaceRequest =>
  folder.kind === 'new' ? { newFolder: folder.name } : { workDir: folder.path };

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
