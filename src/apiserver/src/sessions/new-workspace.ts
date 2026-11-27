import { BadRequestException, ConflictException } from '@nestjs/common';
import { CREATE_WORKDIR_CAPABILITY, newFolderPath, newFolderRootFor } from '@orbit/shared';
import { runnerIsOnline, type RunnerBeats } from '../runners/runner-presence';

/**
 * The workspace POST /sessions makes with a session, read from the request (docs/first-workspace-contract.md §3): the
 * request names a machine and one folder on it, and the workspace, the session and its first message are made
 * together (SessionsService.createInNewWorkspace).
 */

/** What `newWorkspace` asks for, once read: on which machine, and a folder already there, a new one under its reposRoot,
 *  or a clone of a GitHub repository under it (docs/github-workspace-design.md §5.3). */
export type NewWorkspaceAsk = { runnerId: string } & (
  | { workDir: string; newFolder?: undefined; github?: undefined }
  | { newFolder: string; workDir?: undefined; github?: undefined }
  | { github: NewWorkspaceGithubAsk; workDir?: undefined; newFolder?: undefined }
);

/** `newWorkspace.github`, read: the repository by GitHub's id (a decimal string), and what was asked of it. */
export interface NewWorkspaceGithubAsk {
  repoId: string;
  ref: string | null;
  /** Null takes the repository's name once GitHub has said what it is. */
  folder: string | null;
}

/** What a GitHub workspace writes beside the ordinary columns (§5.3); absent for the other two sources. */
export interface NewWorkspaceClone {
  repoUrl: string;
  githubRepoId: bigint;
  githubInstallationId: bigint;
  cloneRef: string | null;
}

/** The workspace to make: on which machine, in which folder, under which name before a number is added. */
export interface NewWorkspaceTarget {
  runnerId: string;
  workDir: string;
  name: string;
  /** Made with `newFolder`: the runner makes workDir before the engine starts (the claim's createWorkDir). */
  autoCreateWorkDir: boolean;
  /** Made with `github`: the clone the runner is asked for, which holds the session until it is READY. */
  clone?: NewWorkspaceClone;
}

/** The longest working directory a new workspace takes: PATH_MAX on Linux. */
export const MAX_NEW_WORKSPACE_DIR = 4096;

/** One folder name the runner makes under its reposRoot: a single path segment, never `.` or `..`. */
const NEW_FOLDER = /^[A-Za-z0-9._-]{1,64}$/;

/** A GitHub repository id: a positive whole number, as GitHub's API gives it. */
const GITHUB_REPO_ID = /^[1-9][0-9]{0,17}$/;

/** A branch or tag name git would take (git check-ref-format, less what no clone ever needs), never an option. */
export function isCloneRef(ref: string): boolean {
  return (
    ref.length >= 1 && ref.length <= 255
    && /^[A-Za-z0-9._\/+=@-]+$/.test(ref)
    && !ref.startsWith('-') && !ref.startsWith('/') && !ref.endsWith('/') && !ref.endsWith('.') && !ref.endsWith('.lock')
    && !ref.includes('..') && !ref.includes('//') && !ref.includes('@{') && !ref.includes('\\') && ref !== '@'
  );
}

/** `name` as a folder by newFolder's rule, or null: the folder a GitHub workspace takes when the request names none. */
export function folderOfRepoName(name: string): string | null {
  const folder = name.slice(0, 64);
  return NEW_FOLDER.test(folder) && folder !== '.' && folder !== '..' ? folder : null;
}

/**
 * `newWorkspace` read and held to §3.1's 400s: an object naming exactly one of `workDir` and `newFolder`, in a body that
 * names no workspace of its own and names the machine. CreateSessionDto is an interface, so nothing upstream checked
 * any of it.
 */
export function readNewWorkspace(
  value: unknown,
  body: { workspaceId?: unknown; agentId?: unknown; assignedRunnerId?: unknown },
): NewWorkspaceAsk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('newWorkspace must be { workDir }, { newFolder } or { github }');
  }
  const { workDir, newFolder, github } = value as Record<string, unknown>;
  if ([workDir, newFolder, github].filter((source) => source !== undefined).length !== 1) {
    throw new BadRequestException('newWorkspace names exactly one of workDir, newFolder and github');
  }
  if (body.workspaceId || body.agentId) {
    throw new BadRequestException('newWorkspace makes the session\'s workspace: send it without workspaceId');
  }
  const runnerId = body.assignedRunnerId;
  if (typeof runnerId !== 'string' || !runnerId) {
    throw new BadRequestException('newWorkspace needs assignedRunnerId: the machine its folder is on');
  }
  if (github !== undefined) return { runnerId, github: readGithub(github) };
  if (workDir !== undefined) {
    const dir = typeof workDir === 'string' ? workDir.trim() : '';
    if (!dir || dir.length > MAX_NEW_WORKSPACE_DIR) {
      throw new BadRequestException(`newWorkspace.workDir must be a path of 1 to ${MAX_NEW_WORKSPACE_DIR} characters`);
    }
    return { runnerId, workDir: dir };
  }
  if (!isNewFolderName(newFolder)) {
    throw new BadRequestException(
      'newWorkspace.newFolder must be one folder name of 1 to 64 letters, digits, ".", "_" or "-", other than "." and ".."',
    );
  }
  return { runnerId, newFolder };
}

/** `github` held to §5.3's 400s: a repository id, and a ref and a folder each by its rule when given. `field` is where
 *  the body carried it, for the refusal to name: POST /sessions `newWorkspace.github`, POST /workspaces `github`. */
export function readGithub(value: unknown, field = 'newWorkspace.github'): NewWorkspaceGithubAsk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be { repoId, ref?, folder? }`);
  }
  const { repoId, ref, folder, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new BadRequestException(`${field} takes repoId, ref and folder, not ${Object.keys(rest).join(', ')}`);
  }
  const id = typeof repoId === 'number' && Number.isSafeInteger(repoId) ? String(repoId) : repoId;
  if (typeof id !== 'string' || !GITHUB_REPO_ID.test(id)) {
    throw new BadRequestException(`${field}.repoId must be the GitHub repository id, a positive whole number`);
  }
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || !isCloneRef(ref))) {
    throw new BadRequestException(`${field}.ref must be a branch or tag name`);
  }
  if (folder !== undefined && folder !== null
    && (typeof folder !== 'string' || !NEW_FOLDER.test(folder) || folder === '.' || folder === '..')) {
    throw new BadRequestException(
      `${field}.folder must be one folder name of 1 to 64 letters, digits, ".", "_" or "-", other than "." and ".."`,
    );
  }
  return { repoId: id, ref: typeof ref === 'string' ? ref : null, folder: typeof folder === 'string' ? folder : null };
}

/** One folder name the runner makes under its reposRoot: §3.1's rule, for a body that names one outside `newWorkspace`. */
export function isNewFolderName(value: unknown): value is string {
  return typeof value === 'string' && NEW_FOLDER.test(value) && value !== '.' && value !== '..';
}

/**
 * Where a new folder goes on this runner: @orbit/shared newFolderRootFor, the rule every client's setup card shows, with
 * `capabilities` read as [] until the runner has reported (a runner that declares nothing reads as unreported, as clients see it). A managed runner that has not reported yet makes it in its
 * image's home (MANAGED_RUNNER_HOME), so its first workspace can be made before it is up
 * (docs/managed-runner-no-default-workspace.md). Any other runner that cannot make one is the 409: too old to declare
 * `create-workdir/v1`, or without a reported reposRoot. Shared by POST /sessions and POST /workspaces.
 */
export function newFolderWorkDirOn(
  runner: {
    reposRoot: string | null;
    capabilities: readonly string[];
    capabilitiesReportedAt: Date | null;
    managedRunner?: { id: string } | null;
    status: string;
  } & RunnerBeats,
  folder: string,
): string {
  const capabilities = runner.capabilitiesReportedAt ? runner.capabilities : [];
  const root = newFolderRootFor({ managed: !!runner.managedRunner, up: runnerIsOnline(runner), reposRoot: runner.reposRoot, capabilities });
  if (root === null) {
    throw new ConflictException({
      code: 'NEW_FOLDER_UNSUPPORTED',
      message: capabilities.includes(CREATE_WORKDIR_CAPABILITY)
        ? 'This runner has not reported its Repos Folder, so it cannot make a new folder. Choose an existing folder.'
        : 'This runner is too old to make a new folder — update it, or choose an existing folder.',
    });
  }
  return newFolderPath(root, folder);
}

/** A workspace's name from its folder: the path's last segment, trailing separators aside; the path itself for `/`. */
export function folderNameOf(workDir: string): string {
  return workDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workDir;
}

/** `name`, or the first of `name 2`, `name 3`, … that none of `taken` already is (§3.2). */
export function freeWorkspaceName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}
