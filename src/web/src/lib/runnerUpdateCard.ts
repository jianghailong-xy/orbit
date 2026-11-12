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
  runnerUpdateAvailableBodyQuiet,
  RUNNER_UNIT_MINUTE,
  RUNNER_UNIT_MINUTES,
  RUNNER_UPDATE_UNTITLED_TURN,
  runnerUpdateAvailableTitle,
  runnerUpdateDrainingBody,
  runnerUpdateDrainingTitle,
  runnerUpdatePostponedBody,
  runnerUpdatePostponedTitle,
  RUNNER_UPDATE_RESTARTING_BODY_ONE,
  RUNNER_UPDATE_RESUMED_ONE,
  runnerUpdateRestartingBodyMany,
  runnerUpdateRestartingTitle,
  runnerUpdateResumedMany,
  runnerUpdateTookMinutes,
  runnerUpdateTookMinutesSeconds,
  runnerUpdateTookSeconds,
  runnerUpdateUpdatedTook,
  runnerUpdateUpdatedTitle,
  runnerUpdateTurnRunning,
  runnerUpdateWaitedHours,
  runnerUpdateWaitedHoursMinutes,
  runnerUpdateWaitedMinutes,
  runnerUpdateWaitingFor,
  runnerUpdateWaitingForOf,
} from './runnerCopy';

/** The runner page's Update card (docs/runner-update-drain-design.md §3.5, board 4). */
export interface RunnerUpdateCard {
  /** The runner's phase, or `updated`: no release waiting, and one installed within the last day. */
  phase: RunnerSelfUpdatePhase | 'updated';
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

/** A runner's quiet window (selfUpdate.quietWindowSeconds) in whole minutes, at least one. */
export function runnerQuietMinutes(quietWindowSeconds: number): number {
  return Math.max(1, Math.round(quietWindowSeconds / 60));
}

function availableBodyQuiet(quietWindowSeconds: number): string {
  const minutes = runnerQuietMinutes(quietWindowSeconds);
  return runnerUpdateAvailableBodyQuiet(minutes, minutes === 1 ? RUNNER_UNIT_MINUTE : RUNNER_UNIT_MINUTES);
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
  if (!phase) return report ? updatedCard(report, nowMs) : null;
  if (!version) return null;
  switch (phase) {
    case 'available':
      return {
        phase,
        tone: 'quiet',
        title: runnerUpdateAvailableTitle(version),
        tag: RUNNER_UPDATE_TAG_AVAILABLE,
        // A runner that reports its quiet window waits for it; one that doesn't keeps the old wording.
        body: report.quietWindowSeconds ? availableBodyQuiet(report.quietWindowSeconds) : RUNNER_UPDATE_AVAILABLE_BODY,
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
        // After the owner's Update Now, the turns it interrupted continue once it is back.
        body: !report.interruptedTurns
          ? RUNNER_UPDATE_RESTARTING_BODY
          : report.interruptedTurns === 1 ? RUNNER_UPDATE_RESTARTING_BODY_ONE : runnerUpdateRestartingBodyMany(report.interruptedTurns),
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

/** How long the Updated card stays: a day, then About's Last Update says it (board 4). */
export const RUNNER_UPDATE_UPDATED_HOURS = 24;

/** How long the restart took: `34 s`, `1 min 12 s`, `2 min`. */
export function runnerUpdateTook(seconds: number): string {
  if (seconds < 60) return runnerUpdateTookSeconds(seconds);
  const rest = seconds % 60;
  return rest ? runnerUpdateTookMinutesSeconds(Math.floor(seconds / 60), rest) : runnerUpdateTookMinutes(Math.floor(seconds / 60));
}

/** `Took 34 s. 2 interrupted turns resumed.`; either half alone when the runner measured only that. */
export function runnerUpdateUpdatedBody(took: string | null, interruptedTurns: number): string {
  const parts: string[] = [];
  if (took) parts.push(runnerUpdateUpdatedTook(took));
  if (interruptedTurns === 1) parts.push(RUNNER_UPDATE_RESUMED_ONE);
  else if (interruptedTurns > 1) parts.push(runnerUpdateResumedMany(interruptedTurns));
  return parts.join(' ');
}

/**
 * The Updated card (board 4): the last update, for a day after it was installed — how long the
 * restart took and how many turns an Update Now interrupted for it, as far as the runner measured
 * them. After that About's Last Update says it. Null with no update recorded, or an older one.
 */
function updatedCard(report: RunnerSelfUpdate, nowMs: number): RunnerUpdateCard | null {
  const at = report.lastUpdatedAt ? Date.parse(report.lastUpdatedAt) : NaN;
  if (!report.lastUpdatedTo || Number.isNaN(at)) return null;
  if (nowMs - at > RUNNER_UPDATE_UPDATED_HOURS * 3_600_000 || at - nowMs > 60_000) return null;
  return {
    phase: 'updated',
    tone: 'quiet',
    title: runnerUpdateUpdatedTitle(report.lastUpdatedTo),
    tag: runnerUpdateClock(report.lastUpdatedAt!),
    body: runnerUpdateUpdatedBody(
      report.lastUpdateSeconds ? runnerUpdateTook(report.lastUpdateSeconds) : null,
      report.lastUpdateInterruptedTurns ?? 0,
    ),
  };
}
