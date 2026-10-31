import { BadRequestException } from '@nestjs/common';

/**
 * The workspace POST /sessions makes with a session, read from the request (docs/first-workspace-contract.md §3): the
 * request names a machine and one folder on it, and the workspace, the session and its first message are made
 * together (SessionsService.createInNewWorkspace).
 */

/** What `newWorkspace` asks for, once read: on which machine, and a folder already there or a new one under its reposRoot. */
export type NewWorkspaceAsk = { runnerId: string } & (
  | { workDir: string; newFolder?: undefined }
  | { newFolder: string; workDir?: undefined }
);

/** The workspace to make: on which machine, in which folder, under which name before a number is added. */
export interface NewWorkspaceTarget {
  runnerId: string;
  workDir: string;
  name: string;
  /** Made with `newFolder`: the runner makes workDir before the engine starts (the claim's createWorkDir). */
  autoCreateWorkDir: boolean;
}

/** The longest working directory a new workspace takes: PATH_MAX on Linux. */
export const MAX_NEW_WORKSPACE_DIR = 4096;

/** One folder name the runner makes under its reposRoot: a single path segment, never `.` or `..`. */
const NEW_FOLDER = /^[A-Za-z0-9._-]{1,64}$/;

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
    throw new BadRequestException('newWorkspace must be { workDir } or { newFolder }');
  }
  const { workDir, newFolder } = value as Record<string, unknown>;
  if ((workDir === undefined) === (newFolder === undefined)) {
    throw new BadRequestException('newWorkspace names exactly one of workDir and newFolder');
  }
  if (body.workspaceId || body.agentId) {
    throw new BadRequestException('newWorkspace makes the session\'s workspace: send it without workspaceId');
  }
  const runnerId = body.assignedRunnerId;
  if (typeof runnerId !== 'string' || !runnerId) {
    throw new BadRequestException('newWorkspace needs assignedRunnerId: the machine its folder is on');
  }
  if (workDir !== undefined) {
    const dir = typeof workDir === 'string' ? workDir.trim() : '';
    if (!dir || dir.length > MAX_NEW_WORKSPACE_DIR) {
      throw new BadRequestException(`newWorkspace.workDir must be a path of 1 to ${MAX_NEW_WORKSPACE_DIR} characters`);
    }
    return { runnerId, workDir: dir };
  }
  if (typeof newFolder !== 'string' || !NEW_FOLDER.test(newFolder) || newFolder === '.' || newFolder === '..') {
    throw new BadRequestException(
      'newWorkspace.newFolder must be one folder name of 1 to 64 letters, digits, ".", "_" or "-", other than "." and ".."',
    );
  }
  return { runnerId, newFolder };
}

/** A workspace's name from its folder: the path's last segment, trailing separators aside; the path itself for `/`. */
export function folderNameOf(workDir: string): string {
  return workDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workDir;
}

/** `<reposRoot>/<folder>`, with the separator the runner's own root is written with, and without doubling it. */
export function newFolderWorkDir(reposRoot: string, folder: string): string {
  const separator = reposRoot.includes('\\') && !reposRoot.includes('/') ? '\\' : '/';
  return `${reposRoot.replace(/[\\/]+$/, '')}${separator}${folder}`;
}

/** `name`, or the first of `name 2`, `name 3`, … that none of `taken` already is (§3.2). */
export function freeWorkspaceName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}
