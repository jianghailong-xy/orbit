import { useSyncExternalStore } from 'react';

/**
 * A page asking the app sidebar to show as its icon rail for as long as it needs the width, without touching the
 * owner's own collapse choice (`orbit:sidebar-collapsed`). The Wiki asks while its chat is a column in a window
 * narrower than 1440 (board docs/mocks/wiki-rail 03 C2).
 */
let folded = false;
const listeners = new Set<() => void>();

export function setSidebarFolded(next: boolean): void {
  if (folded === next) return;
  folded = next;
  listeners.forEach((listener) => listener());
}

export function useSidebarFolded(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => folded,
    () => false,
  );
}

/** What is asked now, for a test. */
export const readSidebarFolded = (): boolean => folded;
