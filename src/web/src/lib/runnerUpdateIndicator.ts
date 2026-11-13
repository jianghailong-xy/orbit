import type { RunnerDrainWaiting, RunnerSelfUpdate, RunnerUpdateTurn } from '@orbit/shared';

/**
 * The update indicator (docs/mocks/runner-update-indicator): a quiet pill at the top right of the conversation
 * header while this runner drains for its update AND something of the reader's waits on it, opening a popover with
 * the whole story. The server sends `drainWaiting` on GET /runners only then, so its presence is the whole condition.
 */
export interface UpdateIndicatorRunner {
  id: string;
  selfUpdate?: RunnerSelfUpdate | null;
  updateTurns?: RunnerUpdateTurn[];
  drainWaiting?: RunnerDrainWaiting | null;
}

export interface RunnerUpdateIndicator {
  /** `HPC updating · 5 turns left`, or `HPC restarting` once no turn is left. */
  pill: string;
  /** The narrow pill: the turns left, or nothing once the runner restarts. */
  short: string;
  /** `HPC is updating to 0.1.257` */
  title: string;
  body: string;
  /** `10 sessions and 19 messages of yours wait for it.` */
  waits: string;
}

export const RUNNER_UPDATE_INDICATOR_BODY = 'It installs once these turns finish. Nothing is lost — waiting work starts right after.';
export const RUNNER_UPDATE_INDICATOR_BODY_RESTARTING = 'It is restarting into the new version. Waiting work starts right after.';
/** How many of the reader's turns the popover names; the rest read `and 2 more`. */
export const RUNNER_UPDATE_INDICATOR_TURNS_SHOWN = 3;

function counted(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

export function runnerUpdateIndicatorMore(count: number): string {
  return `and ${count} more`;
}

export function runnerUpdateIndicatorOpen(machine: string): string {
  return `Open ${machine}`;
}

/** `10 sessions and 19 messages of yours wait for it.`, `1 message of yours waits for it.` */
export function runnerUpdateIndicatorWaits(waiting: RunnerDrainWaiting): string {
  const parts: string[] = [];
  if (waiting.sessions > 0) parts.push(counted(waiting.sessions, 'session', 'sessions'));
  if (waiting.messages > 0) parts.push(counted(waiting.messages, 'message', 'messages'));
  const verb = waiting.sessions + waiting.messages === 1 ? 'waits' : 'wait';
  return `${parts.join(' and ')} of yours ${verb} for it.`;
}

/** The indicator for this runner, or null when it is not draining or nothing of the reader's waits on it. */
export function runnerUpdateIndicator(runner: UpdateIndicatorRunner, machine: string): RunnerUpdateIndicator | null {
  const waiting = runner.drainWaiting;
  if (!waiting || waiting.sessions + waiting.messages <= 0) return null;
  const report = runner.selfUpdate ?? null;
  // The runner's own count covers every turn in flight; the reader's named turns are the nearest from one that sends none.
  const turns = report?.turnsInFlight ?? runner.updateTurns?.length ?? 0;
  const version = report?.targetVersion ?? null;
  return {
    pill: turns > 0 ? `${machine} updating · ${counted(turns, 'turn', 'turns')} left` : `${machine} restarting`,
    short: turns > 0 ? String(turns) : '',
    title: version ? `${machine} is updating to ${version}` : `${machine} is updating`,
    body: turns > 0 ? RUNNER_UPDATE_INDICATOR_BODY : RUNNER_UPDATE_INDICATOR_BODY_RESTARTING,
    waits: runnerUpdateIndicatorWaits(waiting),
  };
}
