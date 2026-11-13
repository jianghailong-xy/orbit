import { createContext, useContext } from 'react';
import {
  MAIN_CHECKOUT_NOTICE_KINDS,
  type MainCheckoutActionKind,
  type MainCheckoutActionResult,
  type MainCheckoutChangedNotice,
  type MainCheckoutRepoHealth,
  type MainCheckoutResultNotice,
  namePaths,
} from '@orbit/shared';

/** A worktree session a Move can put the main checkout's files into (board 02②). */
export interface MainCheckoutTarget {
  id: string;
  title: string;
  branch: string;
  /** Running a turn: its worktree cannot take files until the turn ends. */
  busy: boolean;
}

/** What one console offers the main checkout's card, bar, result lines and drawer. Provided by the page that owns
 *  the session (WorkspaceView) or the workspace (WorkspaceSettingsPage); absent (null) on the shared page and the export,
 *  which then draw the text and no actions. */
export interface MainCheckoutHost {
  workspaceId: string;
  /** The session the console shows: where an action's result line is written, and the default Move target. */
  sessionId?: string;
  sessionTitle?: string;
  /** That session's worktree branch; absent for a Shared session. */
  sessionBranch?: string;
  /** The runner declares main-checkout-git/v1. Without it nothing here draws a button (contract §1). */
  actionsSupported: boolean;
  /** The checkout as the last heartbeat reported it (§4): the bar reads this. */
  health: MainCheckoutRepoHealth | null;
  /** Other worktree sessions of this workspace a Move can target. */
  targets: MainCheckoutTarget[];
  /** The action waiting for its answer, if any: every action button holds while it does. */
  inFlight: { requestId: string; kind: MainCheckoutActionKind } | null;
  openReview: (path?: string) => void;
  move: (input: { root: string; fingerprint: string; files: string[]; targetSessionId: string }) => void;
  rescue: (input: { root: string; fingerprint: string }) => void;
  push: () => void;
  cancel: (requestId: string) => void;
  /** Puts a prompt in the composer; nothing is sent. Absent where there is no composer. */
  askAgent?: (text: string) => void;
  /** Opens this workspace's new-session draft with a prompt in it; nothing is sent (the rescue line's link). */
  openNewSession?: (text: string) => void;
  /** Today's Clean up checkout (the CHECKOUT_BLOCKED line's link). */
  cleanUp?: () => void;
  /** Opens this session's own worktree diff (the move line's View changes). */
  viewChanges?: () => void;
}

export const MainCheckoutCtx = createContext<MainCheckoutHost | null>(null);

export function useMainCheckoutHost(): MainCheckoutHost | null {
  return useContext(MainCheckoutCtx);
}

/** The conversation on screen as a main-checkout card reads it to learn whether it was handled: every result line with
 *  its seq, and when each event was written. Provided by Transcript. */
export interface MainCheckoutTranscript {
  results: ReadonlyArray<{ seq: number; result: MainCheckoutActionResult }>;
  /** The event's `ts`, by seq; absent when the stream carried none. */
  writtenAt: ReadonlyMap<number, string>;
}

export const MainCheckoutResultsCtx = createContext<MainCheckoutTranscript>({ results: [], writtenAt: new Map() });

export function useMainCheckoutResults(): MainCheckoutTranscript {
  return useContext(MainCheckoutResultsCtx);
}

export function isMainCheckoutChanged(p: unknown): p is MainCheckoutChangedNotice {
  const n = p as Partial<MainCheckoutChangedNotice> | null;
  return !!n && n.noticeKind === MAIN_CHECKOUT_NOTICE_KINDS.changed && Array.isArray(n.files) && typeof n.root === 'string';
}

export function isMainCheckoutResult(p: unknown): p is MainCheckoutResultNotice {
  const n = p as Partial<MainCheckoutResultNotice> | null;
  return !!n && n.noticeKind === MAIN_CHECKOUT_NOTICE_KINDS.result && !!n.result && typeof n.notice === 'string';
}

// The prompts behind "Ask the agent …" (contract §9 leaves them to the client). They only fill the composer.

export function askAboutChangesPrompt(n: Pick<MainCheckoutChangedNotice, 'root' | 'branch' | 'files' | 'fileCount' | 'truncated'>): string {
  const where = n.branch ? `${n.root} (on ${n.branch})` : n.root;
  const count = `${n.truncated ? 'at least ' : ''}${n.fileCount} ${n.fileCount === 1 ? 'file' : 'files'}`;
  return (
    `During your last turn, ${count} changed in the main checkout ${where}, outside this session's worktree: ` +
    `${namePaths(n.files.map((f) => f.path))}. Find out where they came from and tell me whether they belong ` +
    `to this session's work. Don't move, commit or delete anything yet.`
  );
}

export function askCombinePrompt(r: MainCheckoutActionResult): string {
  const paths = namePaths(r.paths ?? []) || 'some files';
  return (
    `Moving ${paths} from the main checkout ${r.root} into this worktree was refused: this worktree changes the same lines. ` +
    `Combine the main checkout's version of ${(r.paths?.length ?? 0) === 1 ? 'that file' : 'those files'} with yours here, ` +
    `then tell me, so I can clean up the main checkout.`
  );
}

/** The first message of the session Save & clean's "Open in a new session" opens (the macOS client's words). */
export function rescueSessionPrompt(r: MainCheckoutActionResult): string {
  return (
    `The main checkout's uncommitted changes were saved to ${r.rescueBranch}. ` +
    'Look at what that branch holds compared with its parent and tell me what it contains.'
  );
}

export function askRebasePushPrompt(r: MainCheckoutActionResult): string {
  const branch = r.branch ?? 'the branch';
  const upstream = r.upstream ?? `origin/${r.branch ?? 'main'}`;
  return (
    `Pushing ${branch} from the main checkout ${r.root} to ${upstream} was rejected: ${upstream} has commits it doesn't. ` +
    `Rebase ${branch} in the main checkout onto ${upstream} and push it. Never force-push.`
  );
}
