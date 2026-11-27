import { api } from '../api';
import type { SessionTagRef } from './sessionGrouping';

/** Replace the complete set of colored tags applied to one session. */
export const setSessionTags = (sessionId: string, tagIds: string[]): Promise<SessionTagRef[]> =>
  api(`/sessions/${sessionId}/tags`, { method: 'PUT', body: { tagIds } });

/** Add a tag to the owner's library (the Tags menu's Create "…"). */
export const createSessionTag = (name: string, color: string): Promise<SessionTagRef> =>
  api('/session-tags', { method: 'POST', body: { name, color } });

const RECENT_KEY = 'orbit.recentSessionTags';
const RECENT_KEPT = 5;

/** The tags this browser put on a session last, newest first (the Tags menu's Recent). */
export function recentSessionTagIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

export function rememberSessionTag(id: string): void {
  try {
    const next = [id, ...recentSessionTagIds().filter((other) => other !== id)].slice(0, RECENT_KEPT);
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recent is a convenience; a browser that keeps nothing simply shows none.
  }
}
