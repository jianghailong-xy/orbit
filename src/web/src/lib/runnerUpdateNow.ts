import { RUNNER_UPDATE_RESUME_NOTE, SELF_UPDATE_NOW_V1, type RunnerSelfUpdateNowRequest, type RunnerSelfUpdateNowResponse } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { api } from '../api';
import { RUNNER_UPDATE_UNTITLED_TURN, runnerUpdateTurnRunning } from './runnerCopy';
import { runnerUpdateWaited } from './runnerUpdateCard';

/** Whether this runner takes the owner's Update Now: it says it does, and has a release waiting. */
export function runnerTakesUpdateNow(runner: Pick<Runner, 'capabilities' | 'selfUpdate'>): boolean {
  const phase = runner.selfUpdate?.phase;
  return (runner.capabilities ?? []).includes(SELF_UPDATE_NOW_V1)
    && Boolean(runner.selfUpdate?.targetVersion)
    && (phase === 'available' || phase === 'draining' || phase === 'postponed');
}

/** The turns Update Now's confirmation names (board 3 ⑧): title, and how long each has run. */
export function runnerUpdateNowTurns(runner: Pick<Runner, 'updateTurns'>, nowMs: number): Array<{ id: string; title: string; running: string | null }> {
  return (runner.updateTurns ?? []).map((turn) => ({
    id: turn.id,
    title: turn.title?.trim() || RUNNER_UPDATE_UNTITLED_TURN,
    running: turn.startedAt
      ? runnerUpdateTurnRunning(runnerUpdateWaited(Math.max(0, Math.floor((nowMs - Date.parse(turn.startedAt)) / 60_000))))
      : null,
  }));
}

/** POST /runners/:id/self-update/now — the owner's explicit "interrupt these turns". */
export function updateRunnerNow(runnerId: string): Promise<RunnerSelfUpdateNowResponse> {
  const body: RunnerSelfUpdateNowRequest = { interruptTurns: true };
  return api<RunnerSelfUpdateNowResponse>(`/runners/${runnerId}/self-update/now`, { method: 'POST', body });
}

/** Whether a user turn is the one Orbit sent to continue a turn the owner's Update Now cut (D4). */
export function isRunnerUpdateResume(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`);
}
