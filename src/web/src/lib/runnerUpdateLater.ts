import type { RunnerSelfUpdatePostponeRequest, RunnerSelfUpdatePostponeResponse } from '@orbit/shared';
import { api } from '../api';
import {
  RUNNER_UPDATE_LATER_HOUR,
  RUNNER_UPDATE_LATER_TOMORROW,
  RUNNER_UPDATE_LATER_TONIGHT,
  runnerUpdateLaterUntil,
} from './runnerCopy';
import { runnerUpdateClock } from './runnerUpdateCard';

/** The three Later choices (docs/runner-update-drain-design.md §2, D1), in the reader's own zone. */
export type RunnerUpdateLaterKey = 'hour' | 'tonight' | 'tomorrow';

export interface RunnerUpdateLaterOption {
  key: RunnerUpdateLaterKey;
  label: string;
  /** The clock time beside the label: `until 12:57`, `02:00`, `09:00`. */
  detail: string;
  until: Date;
}

/** In 1 hour; tonight, the next 02:00; tomorrow, 09:00 on the next calendar day — all local. */
export function runnerUpdateLaterTimes(now: Date): Record<RunnerUpdateLaterKey, Date> {
  const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0);
  if (tonight.getTime() <= now.getTime()) tonight.setDate(tonight.getDate() + 1);
  return {
    hour: new Date(now.getTime() + 3_600_000),
    tonight,
    tomorrow: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0),
  };
}

export function runnerUpdateLaterOptions(now: Date): RunnerUpdateLaterOption[] {
  const at = runnerUpdateLaterTimes(now);
  const clock = (d: Date) => runnerUpdateClock(d.toISOString());
  return [
    { key: 'hour', label: RUNNER_UPDATE_LATER_HOUR, detail: runnerUpdateLaterUntil(clock(at.hour)), until: at.hour },
    { key: 'tonight', label: RUNNER_UPDATE_LATER_TONIGHT, detail: clock(at.tonight), until: at.tonight },
    { key: 'tomorrow', label: RUNNER_UPDATE_LATER_TOMORROW, detail: clock(at.tomorrow), until: at.tomorrow },
  ];
}

/** The reader's IANA zone, which the server caps `until` in (D2). */
export function readerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** POST /runners/:id/self-update/postpone. */
export function postponeRunnerUpdate(runnerId: string, until: Date): Promise<RunnerSelfUpdatePostponeResponse> {
  const body: RunnerSelfUpdatePostponeRequest = { until: until.toISOString(), timeZone: readerTimeZone() };
  return api<RunnerSelfUpdatePostponeResponse>(`/runners/${runnerId}/self-update/postpone`, {
    method: 'POST',
    body,
  });
}
