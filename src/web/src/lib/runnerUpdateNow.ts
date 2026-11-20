import { RUNNER_UPDATE_RESUME_NOTE, SELF_UPDATE_NOW_V1, type RunnerSelfUpdateNowRequest, type RunnerSelfUpdateNowResponse } from '@orbit/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { Runner } from '../components/TasksSidePanel';
import { api } from '../api';
import {
  RUNNER_UPDATE_INTERRUPTED,
  RUNNER_UPDATE_NOW_CONFIRM,
  RUNNER_UPDATE_NOW_CONFIRM_ONE,
  RUNNER_UPDATE_UNTITLED_TURN,
  runnerUpdateInterruptedTo,
  runnerUpdateNowBodyMany,
  runnerUpdateNowBodyNone,
  runnerUpdateNowBodyOne,
  runnerUpdateNowConfirmMany,
  runnerUpdateTurnRunning,
} from './runnerCopy';
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

/**
 * The press is one timestamp the runner's next heartbeat takes, and its report (phase `restarting`) the
 * answer: once taken, the runners are read again this often, for up to the wait, so the Update card
 * turns to Restarting without a reload.
 */
export const RUNNER_UPDATE_NOW_ANSWER_POLL_MS = 2_000;
export const RUNNER_UPDATE_NOW_ANSWER_WAIT_MS = 30_000;

/** Whether the runner has answered an Update Now: it no longer reports a release waiting, or is gone. */
export function runnerUpdateNowAnswered(runner: Pick<Runner, 'capabilities' | 'selfUpdate'> | undefined): boolean {
  return !runner || !runnerTakesUpdateNow(runner);
}

/** Read the runners again until `runnerId` answers its Update Now, for up to the wait. */
export async function awaitRunnerUpdateNowAnswer(
  qc: QueryClient,
  runnerId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const runner = () => qc.getQueryData<Runner[]>(['runners'])?.find((r) => r.id === runnerId);
  for (let waited = 0; waited < RUNNER_UPDATE_NOW_ANSWER_WAIT_MS && !runnerUpdateNowAnswered(runner()); waited += RUNNER_UPDATE_NOW_ANSWER_POLL_MS) {
    await sleep(RUNNER_UPDATE_NOW_ANSWER_POLL_MS);
    await qc.refetchQueries({ queryKey: ['runners'] });
  }
}

/** Whether a user turn is the one Orbit sent to continue a turn the owner's Update Now cut (D4). */
export function isRunnerUpdateResume(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`);
}

/** The confirmation's first paragraph, by how many turns it interrupts. */
export function runnerUpdateNowBody(version: string, turns: number): string {
  if (turns === 0) return runnerUpdateNowBodyNone(version);
  return turns === 1 ? runnerUpdateNowBodyOne(version) : runnerUpdateNowBodyMany(version);
}

/** The red button: `Interrupt 2 Turns and Update`; with nothing running, `Update Now`. */
export function runnerUpdateNowConfirm(turns: number): string {
  if (turns === 0) return RUNNER_UPDATE_NOW_CONFIRM;
  return turns === 1 ? RUNNER_UPDATE_NOW_CONFIRM_ONE : runnerUpdateNowConfirmMany(turns);
}

/** The transcript's line for an interrupt the owner's Update Now made, naming the release where the runner did. */
export function runnerUpdateInterruptedLine(version: string | null): string {
  return version ? runnerUpdateInterruptedTo(version) : RUNNER_UPDATE_INTERRUPTED;
}
