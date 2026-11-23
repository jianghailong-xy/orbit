import { normalizeRunFailure } from '@orbit/shared';

/** The session columns a run's failure classification is stored in (docs/routing-account-health-design.md §5.1). */
export interface RunFailureColumns {
  failureKind: string | null;
  failureScope: string | null;
  failureSaid: string | null;
  admissionFailure: boolean | null;
}

/** The columns of a session with no failure on record: what a revive writes beside `error: null`. */
export const CLEARED_RUN_FAILURE: RunFailureColumns = {
  failureKind: null,
  failureScope: null,
  failureSaid: null,
  admissionFailure: null,
};

/**
 * The failure columns a run's end writes in the statement that writes its `error`: what the runner's engine adapter
 * classified, or nulls. Only a failed end keeps them, as only a failed end keeps `error`'s meaning. An older runner
 * sends neither field, so its failures are stored with nulls and read through the legacy markers (runFailureKind).
 */
export function runFailureColumns(
  body: { failure?: unknown; admission?: unknown },
  failed: boolean,
): RunFailureColumns {
  if (!failed) return CLEARED_RUN_FAILURE;
  const failure = normalizeRunFailure(body.failure);
  return {
    failureKind: failure?.kind ?? null,
    failureScope: failure?.scope ?? null,
    failureSaid: failure?.said ?? null,
    admissionFailure: typeof body.admission === 'boolean' ? body.admission : null,
  };
}
