import { useMemo, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';
import type { TranscriptInsert } from './Transcript';
import { schedulePath, scheduleRunSessionPath } from '../lib/schedules';
import { useScheduleChatHost } from '../lib/scheduleChatHost';
import { pressRunNow, runNowOffers } from '../lib/scheduledChatOffers';
import { scheduleErrorText } from './ScheduleCards';

export const RUN_NOW_COPY = {
  button: 'Run now',
  started: 'Started',
  openRun: 'open run',
} as const;

/** The Run now button the agent offered (board scheduled-chat 01 ③): pressed by the person, then Started with a link. */
export function RunNowOffer({ scheduleId }: { scheduleId: string }): JSX.Element | null {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The agent's text can echo anything, so the link only names a schedule: the button is drawn for one of this
  // account's schedules in the page's list, titled by the server's list, and never for one that has ended.
  const schedule = useScheduleChatHost()?.find(scheduleId) ?? null;
  const press = useMutation({
    mutationFn: () => pressRunNow(scheduleId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  });
  if (!schedule || schedule.state === 'ENDED') return null;
  const run = press.data?.run;
  const error = scheduleErrorText(press.error);
  return (
    <div className="c-run sched-run-now" data-run-now={scheduleId}>
      <div className="sched-run-now-offer">
        <span className="sched-run-now-title">{schedule.title}</span>
        <Button
          size="small"
          variant="primary"
          disabled={press.isPending || press.isSuccess}
          onClick={() => press.mutate()}
        >
          {`▶ ${RUN_NOW_COPY.button}`}
        </Button>
      </div>
      {run ? (
        <div className="sched-run-now-started" role="status">
          <span aria-hidden="true">✓</span>
          <span>{RUN_NOW_COPY.started} · </span>
          <button
            type="button"
            className="sched-link"
            onClick={() => navigate(scheduleRunSessionPath(run) ?? schedulePath(scheduleId))}
          >
            {RUN_NOW_COPY.openRun}
          </button>
        </div>
      ) : null}
      {error ? <div className="sched-error" role="alert">{error}</div> : null}
    </div>
  );
}

/** The offers the conversation made, drawn after the message that made them. */
export function useRunNowInserts(
  sessionId: string | null,
  events: ReadonlyArray<{ seq: number; type?: string; ts?: string; payload?: unknown }>,
): TranscriptInsert[] {
  return useMemo(
    () =>
      sessionId
        ? runNowOffers(events).map((offer) => ({
            anchor: offer.seq,
            moment: offer.at,
            key: `schedule-run-now:${offer.seq}:${offer.scheduleId}`,
            element: <RunNowOffer scheduleId={offer.scheduleId} />,
          }))
        : [],
    [sessionId, events],
  );
}
