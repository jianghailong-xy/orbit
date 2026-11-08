import type { Prisma } from '@prisma/client';
import type { WikiChatWorkspace, WikiSpaceWorkspaceRow, WikiSpaceWorkspaces } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { normalizeRepoUrl } from './wiki.service';

/**
 * Which workspaces are in a wiki (contract `space.binding`, docs/mocks/wiki/38-workspaces).
 *
 * A WORKSPACE ON A SPACE'S REPOSITORY IS IN THAT SPACE, unless its owner left it out. That is read here from
 * `workspace.repo_url` rather than written into `wiki_space_workspace`, so there is no writer to miss: a workspace
 * joins the moment its repository is known, however that came about (the form, the CLI, the runner's directory
 * probe), and a space made after its workspaces has them all. The row, when there is one, is what the owner or a
 * session said, and it outranks the repository: `left_out_at` keeps a workspace out, and a workspace with no
 * repository is in the space its row names.
 */

type Db = PrismaService | Prisma.TransactionClient;

/** A live workspace of the owner's, with the repository it is on when that says anything. */
interface OwnerWorkspace {
  id: string;
  name: string;
  repository: string | null;
  runner: string | null;
}

const repositoryOf = (repoUrl: string | null): string | null => (repoUrl ? normalizeRepoUrl(repoUrl) : null);

/**
 * Every row the owner's workspaces have, whatever space in use it names. A row naming a wiki in Trash says nothing while it
 * is there (contract `space.trash`): its workspace is where its repository puts it, or in no wiki, and the row speaks again
 * if the wiki is restored before the workspace joins another.
 */
async function rowsOf(db: Db, ownerId: string) {
  return db.wikiSpaceWorkspace.findMany({
    where: { ownerId, space: { deletedAt: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { spaceId: true, workspaceId: true, leftOutAt: true },
  });
}

/**
 * The workspaces in each of the owner's spaces: the ones a row keeps there, then the live ones on its repository
 * that no row speaks for. A row whose workspace is gone counts as it always has, so what a deleted workspace did
 * stays part of its space; `live` narrows the rows to workspaces that still exist.
 */
export async function wikiWorkspacesOfSpaces(
  db: Db,
  ownerId: string,
  spaces: ReadonlyArray<{ id: string; repoUrlNorm: string | null }>,
  { live = false }: { live?: boolean } = {},
): Promise<Map<string, string[]>> {
  const [rows, workspaces] = await Promise.all([
    rowsOf(db, ownerId),
    db.workspace.findMany({ where: { ownerId, deletedAt: null }, select: { id: true, repoUrl: true } }),
  ]);
  const exists = new Set(workspaces.map((workspace) => workspace.id));
  const spoken = new Set(rows.map((row) => row.workspaceId));
  const onRepository = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const repository = repositoryOf(workspace.repoUrl);
    if (repository === null || spoken.has(workspace.id)) continue;
    onRepository.set(repository, [...(onRepository.get(repository) ?? []), workspace.id]);
  }
  return new Map(spaces.map((space) => {
    const kept = rows
      .filter((row) => row.spaceId === space.id && row.leftOutAt === null && (!live || exists.has(row.workspaceId)))
      .map((row) => row.workspaceId);
    return [space.id, [...kept, ...(space.repoUrlNorm ? onRepository.get(space.repoUrlNorm) ?? [] : [])]];
  }));
}

const byName = (a: { id: string; name: string }, b: { id: string; name: string }) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * Wiki settings' Workspaces card (contract `space.workspaces`): the live workspaces on the space's repository or
 * named by a row of it, each in or left out, by name so a row stays where it is when its switch moves; and the ones
 * `Add workspace…` offers, which have no repository and are in no wiki.
 */
export async function wikiSpaceWorkspaces(
  db: Db,
  ownerId: string,
  space: { id: string; repoUrlNorm: string | null },
): Promise<WikiSpaceWorkspaces> {
  const [rows, listed] = await Promise.all([
    rowsOf(db, ownerId),
    db.workspace.findMany({
      where: { ownerId, deletedAt: null },
      select: { id: true, name: true, repoUrl: true, runner: { select: { name: true, displayName: true } } },
    }),
  ]);
  const workspaces: OwnerWorkspace[] = listed.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    repository: repositoryOf(workspace.repoUrl),
    runner: workspace.runner?.displayName || workspace.runner?.name || null,
  }));
  const rowOf = new Map(rows.map((row) => [row.workspaceId, row]));
  const shown = (workspace: OwnerWorkspace, inWiki: boolean): WikiSpaceWorkspaceRow => ({
    id: workspace.id,
    name: workspace.name,
    runner: workspace.runner,
    inWiki,
  });
  const here: WikiSpaceWorkspaceRow[] = [];
  const addable: WikiSpaceWorkspaceRow[] = [];
  for (const workspace of workspaces) {
    const row = rowOf.get(workspace.id);
    if (row?.spaceId === space.id) here.push(shown(workspace, row.leftOutAt === null));
    else if (!row && space.repoUrlNorm !== null && workspace.repository === space.repoUrlNorm) here.push(shown(workspace, true));
    else if (workspace.repository === null && (!row || row.leftOutAt !== null)) addable.push(shown(workspace, false));
  }
  return { workspaces: here.sort(byName), addable: addable.sort(byName) };
}

/** A workspace a space's chats may run in, with what the chat's create reads of it besides what the panel shows. */
export interface WikiChatChoice extends WikiChatWorkspace {
  /** The remote its folder is on, as the runner reported it; the chat's SOURCE identity (SR54). */
  repoUrl: string | null;
}

/**
 * The workspaces a space's chats may run in (contract `chat.workspace.eligible`, `chat.list.choices`): the ones in
 * the space (`wikiSpaceWorkspaces`, by name, as Wiki settings lists them) that are not deleted and run their sessions
 * in worktrees of their own — a chat never runs in a shared checkout — and are switched on, since a session cannot
 * start in one that is off. Each says whether its runner is online by the runners list's own rule.
 */
export async function wikiChatChoices(
  db: Db,
  ownerId: string,
  space: { id: string; repoUrlNorm: string | null },
): Promise<WikiChatChoice[]> {
  const { workspaces } = await wikiSpaceWorkspaces(db, ownerId, space);
  const inWiki = workspaces.filter((workspace) => workspace.inWiki);
  if (inWiki.length === 0) return [];
  const rows = await db.workspace.findMany({
    where: { ownerId, deletedAt: null, id: { in: inWiki.map((workspace) => workspace.id) } },
    select: { id: true, enableWorktree: true, enabled: true, repoUrl: true, runner: { select: { status: true, ...RUNNER_BEATS } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return inWiki.flatMap((workspace) => {
    const row = byId.get(workspace.id);
    if (!row?.enableWorktree || row.enabled === false) return [];
    return [{ id: workspace.id, name: workspace.name, runner: workspace.runner, online: runnerIsOnline(row.runner), repoUrl: row.repoUrl }];
  });
}
