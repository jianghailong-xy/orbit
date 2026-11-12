import type { RunnerSelfUpdate, RunnerSelfUpdatePhase, RunnerUpdateTurn } from '@orbit/shared';
import {
  RUNNER_LINE_SEPARATOR,
  RUNNER_UPDATE_AVAILABLE_BODY,
  RUNNER_UPDATE_DRAINING_BODY_NO_SINCE,
  RUNNER_UPDATE_RESTARTING_BODY,
  RUNNER_UPDATE_TAG_AVAILABLE,
  RUNNER_UPDATE_TAG_DRAINING,
  RUNNER_UPDATE_TAG_POSTPONED,
  RUNNER_UPDATE_TAG_RESTARTING,
  RUNNER_UPDATE_TURN,
  RUNNER_UPDATE_TURNS,
  RUNNER_UPDATE_UNTITLED_TURN,
  runnerUpdateAvailableTitle,
  runnerUpdateDrainingBody,
  runnerUpdateDrainingTitle,
  runnerUpdatePostponedBody,
  runnerUpdatePostponedTitle,
  runnerUpdateRestartingTitle,
  runnerUpdateTurnRunning,
  runnerUpdateWaitedHours,
  runnerUpdateWaitedHoursMinutes,
  runnerUpdateWaitedMinutes,
  runnerUpdateWaitingFor,
  runnerUpdateWaitingForOf,
} from './runnerCopy';

/** The runner page's Update card (docs/runner-update-drain-design.md §3.5, board 4). */
export interface RunnerUpdateCard {
  phase: RunnerSelfUpdatePhase;
  /** `warn` for the phases that hold work back or restart it; `quiet` for the others. */
  tone: 'warn' | 'quiet';
  title: string;
  tag: string;
  body: string;
  /** Draining only: the turns it waits for and how long, with the share of them already done. */
  progress?: { label: string; done: number };
  /** Draining only: the reader's turns it waits for, longest-running first — title, and how long
   *  each has run (`running 1 h 52 min`, none when the server has no start for it). */
  turns?: Array<{ id: string; title: string; running: string | null }>;
}

/** How long it has waited: `38 min`, `1 h 52 min`, `2 h`. */
export function runnerUpdateWaited(minutes: number): string {
  if (minutes < 60) return runnerUpdateWaitedMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? runnerUpdateWaitedHoursMinutes(hours, rest) : runnerUpdateWaitedHours(hours);
}

/** The draining card's progress line: `Waiting for 2 of 8 turns · 38 min`. */
export function runnerUpdateProgressLabel(left: number, of: number | null, waited: string | null): string {
  const unit = (of ?? left) === 1 ? RUNNER_UPDATE_TURN : RUNNER_UPDATE_TURNS;
  const count = of !== null ? runnerUpdateWaitingForOf(left, of, unit) : runnerUpdateWaitingFor(left, unit);
  return waited ? count + RUNNER_LINE_SEPARATOR + waited : count;
}

/** The clock time the card names: `09:58`. */
export function runnerUpdateClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * The card a runner's report calls for, or null: no phase (nothing waiting, or a runner too old to
 * say, which keeps About's wording) or no version to name.
 */
export function runnerUpdateCard(
  report: RunnerSelfUpdate | null | undefined,
  nowMs: number,
  updateTurns?: RunnerUpdateTurn[],
): RunnerUpdateCard | null {
  const phase = report?.phase;
  const version = report?.targetVersion;
  if (!phase || !version) return null;
  switch (phase) {
    case 'available':
      return {
        phase,
        tone: 'quiet',
        title: runnerUpdateAvailableTitle(version),
        tag: RUNNER_UPDATE_TAG_AVAILABLE,
        body: RUNNER_UPDATE_AVAILABLE_BODY,
      };
    case 'draining': {
      const left = report.turnsInFlight ?? 0;
      const of = report.turnsAtDrain ? Math.max(report.turnsAtDrain, left) : null;
      const waited = report.drainingSince
        ? runnerUpdateWaited(Math.max(0, Math.floor((nowMs - Date.parse(report.drainingSince)) / 60_000)))
        : null;
      return {
        phase,
        tone: 'warn',
        title: runnerUpdateDrainingTitle(version),
        tag: RUNNER_UPDATE_TAG_DRAINING,
        body: report.availableSince
          ? runnerUpdateDrainingBody(version, runnerUpdateClock(report.availableSince))
          : RUNNER_UPDATE_DRAINING_BODY_NO_SINCE,
        progress: { label: runnerUpdateProgressLabel(left, of, waited), done: of ? (of - left) / of : 0 },
        turns: (updateTurns ?? []).map((turn) => ({
          id: turn.id,
          title: turn.title?.trim() || RUNNER_UPDATE_UNTITLED_TURN,
          running: turn.startedAt
            ? runnerUpdateTurnRunning(runnerUpdateWaited(Math.max(0, Math.floor((nowMs - Date.parse(turn.startedAt)) / 60_000))))
            : null,
        })),
      };
    }
    case 'restarting':
      return {
        phase,
        tone: 'warn',
        title: runnerUpdateRestartingTitle(version),
        tag: RUNNER_UPDATE_TAG_RESTARTING,
        body: RUNNER_UPDATE_RESTARTING_BODY,
      };
    case 'postponed': {
      if (!report.postponedUntil) return null;
      const until = runnerUpdateClock(report.postponedUntil);
      return {
        phase,
        tone: 'quiet',
        title: runnerUpdatePostponedTitle(version, until),
        tag: RUNNER_UPDATE_TAG_POSTPONED,
        body: runnerUpdatePostponedBody(until),
      };
    }
  }
}
