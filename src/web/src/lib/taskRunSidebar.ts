/**
 * The task run sidebar's open/closed choice, remembered per conversation (docs/task-run-sidebar-design.md,
 * D2 = B): in a task's own run conversation the task is open beside it by default; closing it there is
 * remembered for that conversation, and opening it again forgets the close.
 *
 * One list in localStorage rather than a key per session, capped, so a long-lived browser does not
 * collect a key for every run it ever closed the task in.
 */
import { routeId } from './idCodec';

const KEY = 'orbit.taskRunSidebarClosed';
const CAP = 300;

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the task was closed in this conversation. */
export function taskRunSidebarClosed(sessionId: string): boolean {
  return read().includes(routeId(sessionId) ?? sessionId);
}

/** Remember that the task was closed (or opened again) in this conversation. */
export function rememberTaskRunSidebar(sessionId: string, closed: boolean): void {
  // Either spelling of the id names the same conversation.
  const key = routeId(sessionId) ?? sessionId;
  const rest = read().filter((id) => id !== key);
  const next = closed ? [...rest, key].slice(-CAP) : rest;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage forgets the choice; the sidebar then opens by default again.
  }
}
