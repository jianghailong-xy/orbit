import { parseTaskProgress, type TaskProgress } from '@orbit/shared';

/**
 * How far each background sub-agent and workflow has got, from the broadcast-only `task_progress`
 * events (runner-go claude_task_progress.go), keyed by the launching Agent/Workflow call's tool_use
 * id. Like `tool_output`, each event restates the whole picture, so an event replaces its entry
 * rather than adding to it, and none of them ever enters the persisted transcript. The task's end —
 * a durable `background_task` — carries its last progress itself, so the live entry is dropped then
 * and the transcript's own event answers from there on.
 */
export type LiveTaskProgress = ReadonlyMap<string, TaskProgress>;

export type SessionLiveTaskProgress = {
  sessionId: string | null;
  progress: LiveTaskProgress;
};

export const EMPTY_LIVE_TASK_PROGRESS: LiveTaskProgress = new Map();

type ProgressEvent = { type: string; payload?: Record<string, unknown> | null };

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);

/** Apply one SSE event to the live progress map. */
export function reduceLiveTaskProgress(current: LiveTaskProgress, event: ProgressEvent): LiveTaskProgress {
  const payload = event.payload ?? {};
  if (event.type === 'task_progress') {
    const progress = parseTaskProgress(payload);
    if (!progress) return current;
    const next = new Map(current);
    next.set(progress.toolUseId, progress);
    return next;
  }
  if (event.type === 'background_task' && TERMINAL.has(String(payload.status ?? ''))) {
    const id = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    if (!id || !current.has(id)) return current;
    const next = new Map(current);
    next.delete(id);
    return next.size > 0 ? next : EMPTY_LIVE_TASK_PROGRESS;
  }
  // A resumed runtime is a new process: whatever it had running died with the old one.
  if (event.type === 'system' && payload.subtype === 'resumed' && current.size > 0) {
    return EMPTY_LIVE_TASK_PROGRESS;
  }
  return current;
}

/**
 * The progress each finished task ended with, read off the transcript's own durable
 * `background_task` events — what a card shows once the live frames are gone, and after a reload.
 */
export function endedTaskProgress(
  events: ReadonlyArray<{ type: string; payload?: unknown }>,
): ReadonlyMap<string, TaskProgress> {
  const ended = new Map<string, TaskProgress>();
  for (const ev of events) {
    if (ev.type !== 'background_task') continue;
    const progress = parseTaskProgress((ev.payload as { progress?: unknown } | null)?.progress);
    if (progress) ended.set(progress.toolUseId, progress);
  }
  return ended;
}
