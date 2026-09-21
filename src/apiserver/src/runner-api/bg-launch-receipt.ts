/**
 * Did a background launch actually happen? Read off the one pair the record keeps of it: the
 * tool_call row, which carries the tool_use's name+input and its result's text.
 *
 * `Session.runningBgShells` — the set behind "N background processes running" on the session list —
 * is maintained from launches, and the fold used to take the tool_use alone as proof one occurred.
 * It is not proof. The runner's `orbit hook bg-guard` refuses `Bash(run_in_background)` outright
 * (runner-go hook_bg_guard.go), and a launch can fail on its way up for its own reasons; either way
 * the pair is a tool_use plus a result that names no shell. No process exists, so no terminal
 * <task-notification> ever arrives for it — the runner only retires the shells it registered
 * (runner-go background.go) — and the id stayed in the set for good.
 *
 * What confirms a launch is its own receipt, and the wording here is not invented: each one is the
 * receipt the code that already reads it keys on, so a result that merely looks like a launch is
 * not one, and a reworded receipt is a change in those files rather than a second copy here.
 */

import { BG_ID_RE, toolResultText } from '@orbit/shared';

/** The two tool_use shapes that put an id in the set: a background Bash, and a Monitor. */
export type BgLaunchKind = 'shell' | 'monitor';

/**
 * Which kind of launch a call is, or null for every other tool. Deliberately the same two shapes
 * the fold counts (a Bash carrying `run_in_background`, and Monitor, which has no such flag because
 * backgrounding is all it does) — a call that is not one of them has no launch to confirm.
 */
export function bgLaunchKind(name: string, input: unknown): BgLaunchKind | null {
  if (name === 'Monitor') return 'monitor';
  const runInBackground =
    (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}).run_in_background;
  return name === 'Bash' && runInBackground === true ? 'shell' : null;
}

/**
 * Does this result text say the process started?
 *
 *   * a shell: Claude's "Command running in background with ID: <id>. …" receipt — the same match
 *     the tray's derivation requires before it will list a shell at all
 *     (@orbit/shared background.ts BG_ID_RE).
 *   * a Monitor: its start receipt ("Monitor started (task …, timeout 2400000ms | expires in … |
 *     persistent …)"), anchored the way runner-go's `monitorStarted` anchors it — the receipt is
 *     the whole result, and a result that merely quotes one is not a watcher starting.
 */
export function bgLaunchConfirmed(kind: BgLaunchKind, content: unknown): boolean {
  const text = toolResultText(content);
  return kind === 'monitor' ? MONITOR_STARTED.test(text) : BG_ID_RE.test(text);
}

/** runner-go background.go `monitorStarted`, reduced to what this side asks of it. */
const MONITOR_STARTED = /^Monitor started \(task /;
