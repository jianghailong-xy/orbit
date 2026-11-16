import { useSyncExternalStore } from 'react';
import type { WorkspaceCloneState } from '@orbit/shared';
import { api } from '../api';

/**
 * A GitHub workspace's clone as this tab last heard it (docs/github-workspace-design.md §5.4, §8). The state is the
 * workspace's own column, read with the session detail; git's percentage is relayed by the realtime stream
 * (`agent.changed` with `clone`) and stored nowhere, so it lives here, for as long as the tab does.
 */
export interface CloneHeard {
  state: WorkspaceCloneState;
  progress: number | null;
}

const heard = new Map<string, CloneHeard>();
const listeners = new Set<() => void>();

const STATES: ReadonlySet<string> = new Set(['PENDING', 'CLONING', 'READY', 'FAILED']);

/** A relay's `clone` payload, or null for anything else. */
export function cloneOf(value: unknown): CloneHeard | null {
  if (!value || typeof value !== 'object') return null;
  const { state, progress } = value as { state?: unknown; progress?: unknown };
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  return {
    state: state as WorkspaceCloneState,
    progress: typeof progress === 'number' && Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null,
  };
}

/**
 * Record what the stream said about a workspace's clone. Answers whether its STATE moved (as opposed to its
 * percentage alone), which is when what the server stores — the detail's cloneState, a session's queued reason —
 * has to be read again. A percentage with no state change keeps the last one heard when it names none.
 */
export function hearClone(workspaceId: string, clone: CloneHeard): boolean {
  const before = heard.get(workspaceId);
  const progress = clone.progress ?? (before?.state === clone.state ? before.progress : null);
  heard.set(workspaceId, { state: clone.state, progress });
  for (const listener of listeners) listener();
  return before?.state !== clone.state;
}

/** For tests: forget everything heard. */
export function resetCloneHeard(): void {
  heard.clear();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What the stream last said about this workspace's clone, or null when it has said nothing yet. */
export function useCloneHeard(workspaceId: string | null | undefined): CloneHeard | null {
  return useSyncExternalStore(subscribe, () => (workspaceId ? heard.get(workspaceId) ?? null : null));
}

/**
 * Where a clone stands, from what the server stored (the detail's `cloneState`) and what the stream said since.
 * The stream is newer while the two agree on a live clone; a stored READY or FAILED is an end the stream cannot
 * walk back, except by a Retry, which the stream reports as PENDING.
 */
export function cloneNow(stored: string | null | undefined, live: CloneHeard | null): CloneHeard | null {
  if (!stored || !STATES.has(stored)) return live;
  if (!live) return { state: stored as WorkspaceCloneState, progress: null };
  if (stored === 'READY') return { state: 'READY', progress: null };
  return live;
}

/** POST /workspaces/:id/clone/retry (§5.3): a FAILED clone goes back to PENDING, and the runner is told. */
export function retryClone(workspaceId: string): Promise<{ id: string; cloneState: WorkspaceCloneState }> {
  return api(`/workspaces/${workspaceId}/clone/retry`, { method: 'POST', body: {} });
}

/** `https://github.com/<owner>/<name>.git` → `owner/name`; null for anything else. */
export function githubRepositoryOf(repoUrl: string | null | undefined): string | null {
  const match = repoUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl) : null;
  return match ? match[1]! : null;
}

/** Why a clone failed, said as the person can act on it (board 01, P5 frames). */
export type CloneFailure =
  | { kind: 'folderTaken' }
  | { kind: 'appRemoved' }
  | { kind: 'signInExpired' }
  | { kind: 'other' };

/** The three failures v1 names (board 01 note 14), read by pattern from the runner's or the server's English words;
 *  anything else is git's own words, shown as they are. */
export function cloneFailureOf(error: string | null | undefined): CloneFailure {
  const said = error ?? '';
  if (/already exists on /i.test(said)) return { kind: 'folderTaken' };
  // The control plane's own sentences, relayed by the runner (github-workspace.service.ts, github-connection.service.ts).
  if (/GitHub App is no longer installed/i.test(said)) return { kind: 'appRemoved' };
  if (/Connect GitHub in Settings/i.test(said)) return { kind: 'signInExpired' };
  return { kind: 'other' };
}
