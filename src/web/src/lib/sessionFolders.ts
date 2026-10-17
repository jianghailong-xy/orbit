// Session folders and the Move dialog on the web (docs/session-folders-move-design.md §3–§5, §7).
// The rules are the native clients' — OrbitKit's `SessionFolderGrouping`, `SessionFolderCopy`,
// `SessionMoveCopy` and `SessionWorkspaceMove` — and the words are theirs verbatim, so a folder or a
// move reads the same on every client. Pure, so each rule is tested without mounting the console.
import type { SessionMoveFolder, SessionMoveTarget, SessionMoveTargets } from '@orbit/shared';
import { ApiError, type SessionFolder } from '../api';
import type { SessionListView } from './queries';

// ── The list ──

/** One folder's row at the top of a workspace's session list. The sessions filed in it don't
 *  appear outside it, so the row reports for them, by the rule the sidebar's Workspace row reports
 *  for a workspace (`WorkspaceRow`): how many wait on you at the far end, and on the folder itself a
 *  still dot while one runs, else a breathing one while a background job is in flight. */
export interface SessionFolderRow {
  folder: SessionFolder;
  /** How many of the list's sessions are filed in it — 0 for an empty folder in Open. */
  sessionCount: number;
  needsYou: number;
  running: boolean;
  jobs: boolean;
}

/** A workspace's list as it is drawn: the folder rows on top, then the sessions in no folder, which
 *  go on to the Pinned and time sections as the whole list did. */
export interface SessionFolderListing<T> {
  folders: SessionFolderRow[];
  sessions: T[];
}

/** What a folder row needs to know about one of its sessions, read off the same row glyph the list
 *  draws for it so a folder and its sessions can't disagree. `motion` is the glyph's: the spinner
 *  of a running session, the breathing terminal of a background job, or neither. */
export interface FolderSessionReadings<T> {
  needsYou: (session: T) => boolean;
  motion: (session: T) => 'spinner' | 'pulse' | null;
}

/** Whether this list shows folders at all. Trash is flat, and so is a list narrowed to or grouped by
 *  a tag: two groupings stacked on one list would leave a session with two places to be. */
export const listShowsFolders = (view: SessionListView, byTag: boolean): boolean =>
  view !== 'trash' && !byTag;

/** Folders by name as Finder orders names: case-insensitive, and digits by value, so "Sprint 2"
 *  comes before "Sprint 10". The id settles a tie, so two reads of the same folders agree. */
export const compareFolders = (a: { id: string; name: string }, b: { id: string; name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const foldersByName = <F extends { id: string; name: string }>(folders: readonly F[]): F[] =>
  [...folders].sort(compareFolders);

/**
 * Split one workspace's list for one view into folder rows and the sessions in no folder.
 *
 * Open shows every folder, the empty ones too; Completed only the folders a completed session is
 * in. A session whose folder isn't among `folders` — deleted since the list was fetched, or not
 * loaded yet — stays in the list rather than vanishing into a folder nobody can open. With the
 * Runner offline a folder draws no activity, as the workspace's own row draws none.
 */
export function sessionFolderListing<T extends { folderId?: string | null }>(
  sessions: readonly T[],
  folders: readonly SessionFolder[],
  opts: { view: SessionListView; byTag: boolean; runnerOffline?: boolean } & FolderSessionReadings<T>,
): SessionFolderListing<T> {
  if (!listShowsFolders(opts.view, opts.byTag)) return { folders: [], sessions: [...sessions] };
  const known = new Set(folders.map((f) => f.id));
  const filed = new Map<string, T[]>();
  const loose: T[] = [];
  for (const session of sessions) {
    const id = session.folderId;
    if (id && known.has(id)) {
      const inside = filed.get(id);
      if (inside) inside.push(session);
      else filed.set(id, [session]);
    } else {
      loose.push(session);
    }
  }
  const rows: SessionFolderRow[] = [];
  for (const folder of foldersByName(folders)) {
    const inside = filed.get(folder.id) ?? [];
    if (opts.view === 'completed' && inside.length === 0) continue;
    const motions = opts.runnerOffline ? [] : inside.map(opts.motion);
    rows.push({
      folder,
      sessionCount: inside.length,
      needsYou: inside.filter(opts.needsYou).length,
      running: motions.includes('spinner'),
      jobs: motions.includes('pulse'),
    });
  }
  return { folders: rows, sessions: loose };
}

/** What a folder's page lists: the sessions filed in it, in the order the list keeps them, so the
 *  page draws the same Pinned and time sections the list does. */
export const sessionsInFolder = <T extends { folderId?: string | null }>(
  sessions: readonly T[],
  folderId: string,
): T[] => sessions.filter((s) => s.folderId === folderId);

/** The name a new or renamed folder is asked for, as the server will store it: without the space
 *  around it. Null for a name of spaces alone, which the editor ignores. */
export const folderNameDraft = (draft: string): string | null => {
  const name = draft.trim();
  return name ? name : null;
};

// ── Words (OrbitKit's SessionFolderCopy / SessionMoveCopy, verbatim) ──

export const FOLDER_COPY = {
  newFolder: 'New Folder…',
  rename: 'Rename…',
  delete: 'Delete Folder…',
  deleteTitle: (name: string) => `Delete “${name}”?`,
  /** Names no number: the list that asks counts only the sessions in its own view (Open or
   *  Completed), while every session filed in the folder goes back to the list. */
  deleteMessage: 'Its sessions move back to the list. No session is deleted.',
  deleteConfirm: 'Delete',
  namePlaceholder: 'Name',
  editHint: 'Enter to save · Esc to cancel',
  back: (workspace: string) => `Back to ${workspace}`,
  more: 'Folder actions',
} as const;

export const MOVE_COPY = {
  title: 'Move',
  action: 'Move…',
  noFolder: 'No Folder',
  newFolder: 'New Folder…',
  folderGroup: (workspace: string) => `Folder in ${workspace}`,
  anotherWorkspaceGroup: 'Move to Another Workspace',
  runnerOffline: 'Runner offline',
  loadingWorkspaces: 'Loading workspaces…',
  ending: 'Ending the session…',
  moving: 'Moving…',
  endTimedOut: 'The session hasn’t finished ending, so it wasn’t moved. Try again once it has ended.',
} as const;

/** Why a request failed, in a clause: the server's own sentence when it gave one. */
const failureReason = (error: unknown): string => {
  const text = error instanceof Error ? error.message.trim().replace(/\.$/, '') : '';
  return text || 'something went wrong';
};

const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

/** A folder that wasn't created or renamed. A name the workspace already has is refused with a 409
 *  (the server's `UNIQUE (workspace_id, name)`) and said in so many words. */
export const folderNameFailure = (
  error: unknown,
  name: string,
  workspace: string,
  doing: 'created' | 'renamed',
): string =>
  isConflict(error)
    ? `There’s already a folder named “${name}” in ${workspace}. Choose another name.`
    : `The folder couldn’t be ${doing}: ${failureReason(error)}.`;

export const folderDeleteFailure = (error: unknown): string =>
  `The folder couldn’t be deleted: ${failureReason(error)}.`;

/** The toast once a session has gone into a folder — or, moved to No Folder, out of the one it
 *  was in. */
export const movedToFolderToast = (
  destination: { name: string } | null,
  origin: { name: string } | null,
): string =>
  destination
    ? `Moved to “${destination.name}”`
    : origin
      ? `Moved out of “${origin.name}”`
      : 'Moved out of its folder';

export const movedToWorkspaceToast = (workspace: string): string => `Moved to ${workspace}`;

// ── Move to Another Workspace (OrbitKit's SessionWorkspaceMoveLogic) ──

/** One row of the Move to Another Workspace group. */
export interface MoveTargetRow {
  target: SessionMoveTarget;
  /** The row opens the workspace's step: the session can leave its workspace, and go to this one. */
  enabled: boolean;
  /** The grey line under the name: `<Provider> · <runner>`, or why the session can't go there, in
   *  the server's words. An offline runner keeps the row open and carries its own pill. */
  detail: string;
}

/** The group's rows, in the order the server lists the workspaces. A workspace the server gives a
 *  reason for is greyed with that reason; when the session itself can't move (`reason` on the whole
 *  answer) every row is greyed and the group says why under it. */
export const moveTargetRows = (
  answer: SessionMoveTargets,
  providerName: (slug: string) => string,
): MoveTargetRow[] =>
  answer.targets.map((target) => ({
    target,
    enabled: answer.reason == null && target.reason == null,
    detail:
      target.reason ?? [providerName(target.provider), target.runnerName].filter(Boolean).join(' · '),
  }));

/** The folders a session can be filed in on a workspace's step: the ones the server listed, and any
 *  made from the step since (New Folder…), by name. */
export const moveTargetFolders = (
  target: SessionMoveTarget,
  made: readonly SessionMoveFolder[],
): SessionMoveFolder[] => {
  const listed = new Set(target.folders.map((f) => f.id));
  return foldersByName([...target.folders, ...made.filter((f) => !listed.has(f.id))]);
};

/** The sentence under a workspace step's folders: the runner the session goes to and how the
 *  conversation comes along, the directory the agent works in, and an away runner. */
export const moveTargetFooter = (target: SessionMoveTarget): string => {
  const runner = target.runnerName ? ` (${target.runnerName})` : '';
  const sentences: string[] = [];
  if (target.conversation === 'continues') {
    sentences.push(`Same runner${runner}. The conversation carries over as it is.`);
  } else if (target.conversation === 'rebuilt') {
    sentences.push(
      `Another runner${runner}. The conversation is rebuilt from Orbit’s record, its earlier parts summarized for the agent.`,
    );
  } else if (target.runnerName) {
    sentences.push(`It runs on ${target.runnerName}.`);
  }
  if (target.workDir) sentences.push(`The agent works in ${target.workDir} from your next message.`);
  if (!target.runnerOnline) {
    sentences.push(`${target.runnerName ?? 'The runner'} is offline: your next message waits for it.`);
  }
  return sentences.join(' ');
};

export const moveConfirmTitle = (target: SessionMoveTarget): string => `Move to ${target.name}?`;

/** The confirmation's paragraphs (§5.3): the conversation goes, the agent's memory of it is
 *  summarized when another runner rebuilds it, the changes stay on their branch in the old
 *  workspace — with how many aren't merged yet when some aren't — and an idle session ends first. */
export const moveConfirmParagraphs = (
  answer: SessionMoveTargets,
  target: SessionMoveTarget,
  fromWorkspace: string,
): string[] => {
  const paragraphs = [`The conversation moves with it. Your next message continues it in ${target.name}.`];
  if (target.conversation === 'rebuilt') {
    paragraphs.push('Earlier parts of the conversation are summarized for the agent.');
  }
  if (answer.branch && answer.changedFiles > 0) {
    const unmerged = answer.unmergedFiles;
    if (unmerged > 0) {
      const files = unmerged === 1 ? '1 changed file isn’t' : `${unmerged} changed files aren’t`;
      const they = unmerged === 1 ? 'It stays' : 'They stay';
      paragraphs.push(
        `${files} merged into ${answer.mergeTarget ?? 'main'} yet. ${they} on branch ${answer.branch} in ${fromWorkspace}.`,
      );
    } else {
      paragraphs.push(`Changes made so far stay on branch ${answer.branch} in ${fromWorkspace}.`);
    }
  }
  if (answer.needsEnd) paragraphs.push('The session ends first.');
  return paragraphs;
};

/** End and Move for a session that has to be ended first. */
export const moveConfirmAction = (answer: SessionMoveTargets): string =>
  answer.needsEnd ? 'End and Move' : 'Move';

/** The move's reason goes below the failed-action title. A refusal (409) is the server's own
 *  sentence, shown as it is; other failures also show only their reason. */
export const moveFailureText = (error: unknown): string =>
  (error instanceof Error && error.message.trim()) || 'something went wrong';

export const endFailureText = (error: unknown): string =>
  `The session couldn’t be ended, so it wasn’t moved: ${failureReason(error)}.`;

/** How long End and Move waits for the session to end, and how often it looks. Its runner commits
 *  what the session left uncommitted first, which can take a while on a large change. */
export const END_TIMEOUT_MS = 60_000;
export const END_POLL_MS = 1_000;

export type MovePhase = 'ending' | 'moving';

/**
 * Move a session to another workspace: end it first when `endingFirst` (End and Move), wait until
 * its run is over, then move it. The move itself only takes an ended session, and ending is when its
 * runner commits what it left uncommitted, so the wait is for the session to have ended — not for
 * the end request to be answered.
 *
 * An end the server refuses with a 409 is a session already ending or ended, so the wait goes on
 * from there; anything else stops the move with why. A status read that fails is only a missed look.
 * Returns null once moved, else the sentence to show.
 */
export async function runWorkspaceMove(steps: {
  endingFirst: boolean;
  end: () => Promise<unknown>;
  ended: () => Promise<boolean>;
  move: () => Promise<unknown>;
  phase?: (phase: MovePhase) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<string | null> {
  const sleep = steps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = steps.timeoutMs ?? END_TIMEOUT_MS;
  const interval = steps.intervalMs ?? END_POLL_MS;
  if (steps.endingFirst) {
    steps.phase?.('ending');
    try {
      await steps.end();
    } catch (error) {
      if (!isConflict(error)) return endFailureText(error);
    }
    let waited = 0;
    while (!(await steps.ended().catch(() => false))) {
      if (waited >= timeout) return MOVE_COPY.endTimedOut;
      await sleep(interval);
      waited += interval;
    }
  }
  steps.phase?.('moving');
  try {
    await steps.move();
  } catch (error) {
    return moveFailureText(error);
  }
  return null;
}
