import type { PermissionModeChangeCause, SessionPermissionModeChange } from '@orbit/shared';

/**
 * A session's mode facts as the apiserver answers them, for the tests of the running-mode states
 * (docs/mocks/permission-mode-actual). scripts/permission-mode-actual-stack/fixture-diff.mjs holds
 * these to a real response of this checkout's apiserver on PostgreSQL:
 *  - a change is exactly { fromMode, toMode, cause, client, at, seq }: `at` an ISO instant with
 *    milliseconds; `client` the app for OWNER_PICK, 'orbit' for ORBIT_CHANGE (the setconfig turn's
 *    sender), null for every other cause (sessions/actual-permission-mode.ts); `seq` the order it was
 *    recorded in (migration 1810), left out by a test that reads a server older than that;
 *  - the session's actualPermissionMode is its newest change's toMode, and actualPermissionModeAt that
 *    change's instant: one statement writes both (recordActualPermissionMode), each with its own
 *    clock_timestamp(), so the server's session stamp can read up to a millisecond earlier;
 *  - the detail carries the changes, oldest first; an Open list row carries the two facts only.
 */
export function modeChange(
  cause: PermissionModeChangeCause,
  toMode: string,
  fromMode: string | null,
  at: string,
  client?: string | null,
  seq?: number,
): SessionPermissionModeChange {
  return {
    fromMode, toMode, cause, client: client ?? (cause === 'ORBIT_CHANGE' ? 'orbit' : null), at,
    ...(seq !== undefined ? { seq } : {}),
  };
}

/** The mode facts a session row carries beside its intent, as the newest change wrote them. */
export function modeFacts(changes: readonly SessionPermissionModeChange[]): {
  actualPermissionMode: string | null;
  actualPermissionModeAt: string | null;
} {
  const newest = changes.at(-1);
  return { actualPermissionMode: newest?.toMode ?? null, actualPermissionModeAt: newest?.at ?? null };
}

/** The detail of a live wiki chat on Claude Code (GET /sessions/:id), the fields the chat panel reads:
 *  fixture-diff.mjs holds these keys and their kinds to the real answer. */
export function wikiChatDetail(
  chat: {
    id: string;
    title: string;
    workspace: { id: string; name: string };
    assignedRunnerId: string;
    model: string;
    permissionMode: string;
    /** A turn of the chat is open; else it waits for the owner. */
    running?: boolean;
  },
  changes: readonly SessionPermissionModeChange[],
) {
  const { running, ...own } = chat;
  const state = running ? 'RUNNING' : 'AWAITING_INPUT';
  return {
    ...own,
    engine: 'claude',
    provider: 'claude',
    status: state,
    runState: state,
    lifecycleState: 'OPEN',
    deletedAt: null,
    numTurns: 2,
    ...modeFacts(changes),
    permissionModeChanges: [...changes],
  };
}
