import { useSyncExternalStore } from 'react';

/**
 * The project sessions page a conversation has open: the column beside it wider, the list behind it on a
 * phone. A list's own address keeps it as `?project=` (and `view=completed`); a conversation's address
 * does not (owner 2026-11-25), so a copied `/sessions/<id>` opens the same way anywhere. While a
 * conversation is open the page lives here, where the console and the sidebar both read it.
 * `project` is the encoded id, as the address spells it.
 */
export interface ConversationProjectPage {
  project: string;
  completed: boolean;
}

// Kept for the tab, so a reload keeps the page as `?project=` used to; a link opened in another tab
// starts without one.
const STORAGE_KEY = 'orbit.conversationProjectPage';

const read = (): ConversationProjectPage | null => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as ConversationProjectPage | null;
    return typeof parsed?.project === 'string' ? { project: parsed.project, completed: parsed.completed === true } : null;
  } catch {
    return null;
  }
};

let current: ConversationProjectPage | null = read();
const listeners = new Set<() => void>();

export function setConversationProjectPage(next: ConversationProjectPage | null): void {
  if (current?.project === next?.project && current?.completed === next?.completed) return;
  current = next;
  try {
    if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser that refuses storage keeps the page for this load only.
  }
  for (const listener of listeners) listener();
}

/** The page as it stands, for code outside React. */
export const conversationProjectPage = (): ConversationProjectPage | null => current;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useConversationProjectPage = (): ConversationProjectPage | null =>
  useSyncExternalStore(subscribe, () => current, () => null);
