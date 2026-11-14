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
  /** The runner is stopping, not updating (docs/mocks/runner-stopping): no Later, no Update Now. */
  stopping: boolean;
  /** The runner reports phase `restarting` (an Update Now, or a drain that ended): no turn is waited
   *  for any more, so the popover lists none and offers no Later. */
  restarting: boolean;
}

export const RUNNER_UPDATE_INDICATOR_BODY = 'It installs once these turns finish. Nothing is lost — waiting work starts right after.';
export const RUNNER_UPDATE_INDICATOR_BODY_RESTARTING = 'It is restarting into the new version. Waiting work starts right after.';
/** Restarting for the owner's Update Now, which interrupted turns: `… 5 interrupted turns continue once it is back, …` */
export function runnerUpdateIndicatorRestartingInterrupted(turns: number): string {
  const continues = turns === 1 ? '1 interrupted turn continues' : `${turns} interrupted turns continue`;
  return `It is restarting into the new version. ${continues} once it is back, and waiting work starts right after.`;
}
/** The body for a runner that is stopping rather than updating (docs/mocks/runner-stopping). */
export const RUNNER_STOPPING_INDICATOR_BODY = 'It stops once these turns finish. Nothing is lost — waiting work starts once it is back.';
export const RUNNER_STOPPING_INDICATOR_BODY_NOW = 'It is stopping now. Waiting work starts once it is back.';
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
  // A runner restarting waits for no turn: Update Now interrupted them, and its report then carries no
  // turnsInFlight, so the reader's named turns must not stand in for it.
  const restarting = report?.phase === 'restarting';
  // The runner's own count covers every turn in flight; the reader's named turns are the nearest from one that sends none.
  const turns = restarting ? 0 : report?.turnsInFlight ?? runner.updateTurns?.length ?? 0;
  const version = report?.targetVersion ?? null;
  if (waiting.stopping === true) {
    return {
      pill: turns > 0 ? `${machine} stopping · ${counted(turns, 'turn', 'turns')} left` : `${machine} stopping`,
      short: turns > 0 ? String(turns) : '',
      title: `${machine} is stopping`,
      body: turns > 0 ? RUNNER_STOPPING_INDICATOR_BODY : RUNNER_STOPPING_INDICATOR_BODY_NOW,
      waits: runnerUpdateIndicatorWaits(waiting),
      stopping: true,
      restarting: false,
    };
  }
  return {
    pill: turns > 0 ? `${machine} updating · ${counted(turns, 'turn', 'turns')} left` : `${machine} restarting`,
    short: turns > 0 ? String(turns) : '',
    // Restarting reads as the runner page's Update card does: `Restarting into 0.1.261…`.
    title: restarting
      ? version ? `${machine} is restarting into ${version}` : `${machine} is restarting`
      : version ? `${machine} is updating to ${version}` : `${machine} is updating`,
    body: turns > 0
      ? RUNNER_UPDATE_INDICATOR_BODY
      : report?.interruptedTurns
        ? runnerUpdateIndicatorRestartingInterrupted(report.interruptedTurns)
        : RUNNER_UPDATE_INDICATOR_BODY_RESTARTING,
    waits: runnerUpdateIndicatorWaits(waiting),
    stopping: false,
    restarting,
  };
}
