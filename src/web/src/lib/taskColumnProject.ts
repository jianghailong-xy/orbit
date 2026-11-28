import { useSyncExternalStore } from 'react';

/**
 * The project column a docked task stands in for (docs/mocks/right-panel-stack, owner 2026-11-28).
 *
 * Beside a conversation the right side holds one column. A task opened there takes the project
 * column's slot, as session settings do, and its head says what is under it: "‹ project" closes
 * the task and the project column comes back; ✕ closes both. The conversation (WorkspaceView)
 * knows the column and the task panel (AppShell) draws the link, so the two meet here.
 */
export interface TaskColumnProject {
  title: string;
  /** Fold the project column too: the task's ✕ empties the right side. */
  fold: () => void;
}

let current: TaskColumnProject | null = null;
const listeners = new Set<() => void>();

export function setTaskColumnProject(next: TaskColumnProject | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const read = (): TaskColumnProject | null => current;

export const useTaskColumnProject = (): TaskColumnProject | null => useSyncExternalStore(subscribe, read, read);
