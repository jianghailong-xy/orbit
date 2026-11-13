import type { RunnerDrainWaiting, RunnerSelfUpdate, RunnerUpdateTurn } from '@orbit/shared';

/**
 * The workspace banner (docs/runner-update-drain-design.md §3.4, D3; board 3 ⑥): one line at the top of the
 * conversation pane while this runner drains for its update AND something of the reader's waits on it. The server
 * sends `drainWaiting` on GET /runners only then, so its presence is the whole condition. The apiserver's drain push
 * (common/runner-drain-waiting.ts) says the same sentence.
 */
export interface DrainBannerRunner {
  id: string;
  selfUpdate?: RunnerSelfUpdate | null;
  updateTurns?: RunnerUpdateTurn[];
  drainWaiting?: RunnerDrainWaiting | null;
}

export interface RunnerDrainBanner {
  /** Which drain this is: × hides the banner for this key only, so the next drain shows it again. */
  drainKey: string;
  text: string;
  /** The runner is stopping, not updating: the banner offers only ×. */
  stopping: boolean;
}

function counted(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * `studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.`, or for a runner that
 * is stopping (board runner-stopping ②) `HPC is stopping — 1 message is waiting for 2 turns to finish.`
 */
export function runnerDrainBannerText(machine: string, targetVersion: string | null, waiting: RunnerDrainWaiting, turns: number): string {
  const stopping = waiting.stopping === true;
  const updating = stopping
    ? `${machine} is stopping`
    : targetVersion ? `${machine} is updating to ${targetVersion}` : `${machine} is updating`;
  const parts: string[] = [];
  if (waiting.sessions > 0) parts.push(counted(waiting.sessions, 'session', 'sessions'));
  if (waiting.messages > 0) parts.push(counted(waiting.messages, 'message', 'messages'));
  const verb = waiting.sessions + waiting.messages === 1 ? 'is' : 'are';
  const until = turns > 0
    ? `waiting for ${counted(turns, 'turn', 'turns')} to finish`
    : stopping ? 'waiting for it to come back' : 'waiting for it to restart';
  return `${updating} — ${parts.join(' and ')} ${verb} ${until}.`;
}

/** The banner for this runner, or null when it is not draining or nothing of the reader's waits on it. */
export function runnerDrainBanner(runner: DrainBannerRunner, machine: string): RunnerDrainBanner | null {
  const waiting = runner.drainWaiting;
  if (!waiting || waiting.sessions + waiting.messages <= 0) return null;
  const report = runner.selfUpdate ?? null;
  // The runner's own count covers every turn in flight; the reader's named turns are the nearest from one that sends none.
  const turns = report?.turnsInFlight ?? runner.updateTurns?.length ?? 0;
  return {
    // A stop is its own drain: × on an update's banner does not hide the stop's, nor the other way round.
    drainKey: waiting.stopping === true ? `${runner.id}:stopping` : `${runner.id}:${report?.drainingSince ?? report?.targetVersion ?? ''}`,
    text: runnerDrainBannerText(machine, report?.targetVersion ?? null, waiting, turns),
    stopping: waiting.stopping === true,
  };
}
