import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { pendingDecisionsQuery } from '../lib/queries';
import { newRunRequestToken, runRequestResend } from '../lib/runRequestToken';
import { Alert } from './ui/Alert';
import { CardActionButton, CardActions } from './CardAction';

/**
 * Restart the task: the one action the owner's pending row offers for evidence nobody else can move
 * (`ownerAction: 'RESTART_TASK'`, docs/evidence-always-has-an-addressee-design.md §3, D2 = A). The
 * revision cannot be decided, no run of the task is live to submit it again, and no coordinator was
 * told to act on it, so the owner starts the task and a new run files evidence against the standard
 * it is held to now.
 *
 * It is not a decision and it does not sit in `DecisionRail.tsx`, whose strip answers nothing: this
 * is a Run press, made at `POST /tasks/:taskId/evidence/:revision/restart`, which asks the server's
 * own placement again and refuses with 409 `EVIDENCE_RESTART_NOT_OFFERED` once the row is no longer
 * the owner's to move.
 *
 * The words are the contract the iOS/macOS and Android owner cards copy; their parity tests read
 * the declarations below.
 */
export const RESTART_TASK_OWNER_ACTION = 'RESTART_TASK';
export const EVIDENCE_RESTART_ACTION = 'Restart the task';
export const EVIDENCE_RESTART_EXPLANATION =
  'No run of this task is live to submit it again, and no coordinator was told to act on it. '
  + 'Restart the task and a new run will submit evidence against the standard it is held to now.';
export const EVIDENCE_RESTART_STARTED = 'Restarted: a new run will submit the evidence again.';
export const EVIDENCE_RESTART_REFUSED = 'Not restarted';
export const EVIDENCE_RESTART_STALE = 'Not restarted: this row is out of date';
export const EVIDENCE_RESTART_NOT_OFFERED = 'EVIDENCE_RESTART_NOT_OFFERED';

/** The press as data: the address the row was read at, and the Run press's own token. */
export function evidenceRestartRequest(
  row: { taskId: string; evidenceRevision: string },
  triggerId: string,
): { path: string; body: { triggerId: string } } {
  return {
    path: `/tasks/${encodeURIComponent(row.taskId)}/evidence/${encodeURIComponent(row.evidenceRevision)}/restart`,
    body: { triggerId },
  };
}

/** A refusal, said as staleness when the server's code means the row has moved on. */
export function evidenceRestartRefusal(error: Error): { stale: boolean; title: string } {
  const code = (error as { code?: unknown }).code;
  return code === EVIDENCE_RESTART_NOT_OFFERED
    ? { stale: true, title: EVIDENCE_RESTART_STALE }
    : { stale: false, title: EVIDENCE_RESTART_REFUSED };
}

/**
 * The sentence and the button, with the press's own busy, refused and started states. The read is
 * re-asked whichever way the server answered: a started task leaves the owner's group, and a
 * refusal means the read has moved.
 */
export function EvidenceRestartAction({
  row,
  sessionId,
}: {
  row: { taskId: string; evidenceRevision: string };
  /** The session whose pending read this row came from. */
  sessionId: string;
}): JSX.Element {
  const qc = useQueryClient();
  const restart = useMutation({
    ...runRequestResend,
    mutationFn: ({ triggerId }: { triggerId: string }) => {
      const request = evidenceRestartRequest(row, triggerId);
      return api(request.path, { method: 'POST', body: request.body });
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: pendingDecisionsQuery(sessionId).queryKey }),
  });
  const refusal = restart.error ? evidenceRestartRefusal(restart.error) : null;
  return (
    <div className="evidence-restart">
      <span className="orbit-typography">{EVIDENCE_RESTART_EXPLANATION}</span>
      {restart.error && refusal ? (
        <Alert
          className="evidence-restart-error"
          type={refusal.stale ? 'warning' : 'error'}
          title={refusal.title}
          description={restart.error.message}
        />
      ) : null}
      {restart.isSuccess ? (
        <div className="decision-ask-picked">{EVIDENCE_RESTART_STARTED}</div>
      ) : (
        <CardActions className="evidence-restart-actions">
          <CardActionButton
            tone="primary"
            disabled={restart.isPending}
            onClick={() => restart.mutate({ triggerId: newRunRequestToken() })}
          >
            {EVIDENCE_RESTART_ACTION}
          </CardActionButton>
        </CardActions>
      )}
    </div>
  );
}
