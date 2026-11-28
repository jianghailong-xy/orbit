/**
 * The Drive page's activity view (project "Drive web: agent-first header, Agents panel and failure hand-off", board
 * frame 5, its Today / Yesterday part): what every session did to the owner's drive, and what the owner did, grouped by
 * session and by day. Answered by `GET /api/drive/activity` (apiserver drive/drive-activity.ts).
 */

/** What one line says was done: files written, put in Trash, moved, renamed, or copied in by a directory sync. */
export type DriveActivityOp = 'WROTE' | 'DELETED' | 'MOVED' | 'RENAMED' | 'SYNCED';

/**
 * What reverses a line, where an existing route can: a Drive chat's change group by
 * `POST /drive/chats/:sessionId/groups/:id/undo` (its group's `sessionId`), a Trash group by
 * `POST /drive/trash/groups/:id/restore`.
 */
export interface DriveActivityUndo {
  kind: 'CHANGE_GROUP' | 'TRASH_GROUP';
  id: string;
}

/** One line of a group: `count` items `op`'d in one folder, e.g. "Renamed 12 files in Books". */
export interface DriveActivityLine {
  op: DriveActivityOp;
  count: number;
  /** The folder, from the root (`/Books`); a sync's destination. Null when the folder has since been deleted for good. */
  folderPath: string | null;
  /** The bytes written, put in Trash or sent by a sync. */
  bytes?: number;
  undo?: DriveActivityUndo;
  /** A Drive chat's changes held for the owner's Apply past its turn's 200th: nothing is made yet. */
  held?: true;
  /** When its newest item was done. */
  at: string;
}

/** One session's drive work on one day, or the owner's own (`sessionId` null). */
export interface DriveActivityGroup {
  sessionId: string | null;
  sessionTitle: string | null;
  isDriveChat: boolean;
  /** When its newest line was done. */
  at: string;
  /** Newest first. */
  lines: DriveActivityLine[];
}

/**
 * One page, newest first. A page holds whole days of the `tz` the request named (UTC by default); the next is asked
 * for with `before=<nextBefore>`, null when there is nothing older.
 */
export interface DriveActivityPage {
  groups: DriveActivityGroup[];
  nextBefore: string | null;
}
