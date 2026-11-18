import { useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CONDITION_STILL_WAITING_KIND, CONDITION_STILL_WAITING_OPTIONS, CONDITION_WAITING_KIND } from '@orbit/shared';
import { api } from '../api';
import { CONDITION_COPY, conditionQuery } from '../lib/conditions';
import { KIND_TAGS, WAITING_ON_YOU, type OwnerRequest } from '../lib/ownerRequests';
import { schedulePath } from '../lib/schedules';
import { ago } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { scheduleErrorText } from './ScheduleCards';
import './OwnerRequest.css';
import './Scheduled.css';

export function isConditionWaitingKind(kind: string): boolean {
  return kind === CONDITION_WAITING_KIND || kind === CONDITION_STILL_WAITING_KIND;
}

interface Door {
  label: string;
  primary?: boolean;
  navigates?: boolean;
  run: () => Promise<unknown> | void;
}

/**
 * A condition's item in Waiting on you (condition-triggers ⑥, design §5.3 and §6.2), in the owner-request card's
 * frame: a condition that cannot be read, with Pause (a schedule's) and Look into it; and a task's condition that has
 * not held in 30 days, answered Keep waiting or Stop. The words are the server's own.
 */
export function ConditionWaitingCard({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const condition = useQuery({ ...conditionQuery(request.conditionId ?? ''), enabled: Boolean(request.conditionId) }).data;
  const [done, setDone] = useState(false);
  const act = useMutation({
    mutationFn: async (door: Door) => {
      await door.run();
    },
    onSuccess: (_answer, door) => {
      if (!door.navigates) setDone(true);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['conditions'] });
    },
  });
  const finish = (body: object = {}) =>
    api(`/owner-requests/${encodeURIComponent(request.id)}/done`, { method: 'POST', body });
  const scheduleId = condition?.scheduleId ?? null;
  const taskId = condition?.taskId ?? null;
  const lookIntoIt: Door = {
    label: CONDITION_COPY.actions.lookIntoIt,
    primary: true,
    navigates: true,
    run: () => {
      if (scheduleId) navigate(schedulePath(scheduleId));
      else if (taskId) navigate(`/tasks/${encodeURIComponent(taskId)}`);
    },
  };
  const doors: Door[] = request.kind === CONDITION_STILL_WAITING_KIND
    ? [
        { label: request.options?.[0]?.label ?? CONDITION_STILL_WAITING_OPTIONS[0], primary: true, run: () => finish({ option: 0 }) },
        { label: request.options?.[1]?.label ?? CONDITION_STILL_WAITING_OPTIONS[1], run: () => finish({ option: 1 }) },
      ]
    : [
        // Pausing a schedule settles the item: the owner chose to stop checking while it cannot be read.
        ...(scheduleId
          ? [{
              label: CONDITION_COPY.actions.pause,
              run: async () => {
                await api(`/schedules/${encodeURIComponent(scheduleId)}/pause`, { method: 'POST' });
                await finish();
              },
            }]
          : []),
        ...(scheduleId || taskId ? [lookIntoIt] : []),
      ];
  const error = scheduleErrorText(act.error);
  return (
    <section className="owner-request-card" id={`owner-request-${request.id}`} data-kind={request.kind}>
      <header className="owner-request-head">
        <span className="owner-request-dot" aria-hidden="true" />
        <span className="owner-request-waiting">{WAITING_ON_YOU}</span>
        <span className="owner-request-age">{ago(request.createdAt, now)}</span>
      </header>
      <div className="owner-request-body">
        <div className="owner-request-title-row">
          <h3 className="owner-request-title">{request.title}</h3>
          <span className="owner-request-kind">{KIND_TAGS[request.kind]}</span>
        </div>
        <div className="owner-request-why md"><p>{request.why}</p></div>
        {error ? <p className="sched-error" role="alert">{error}</p> : null}
        {doors.length > 0 && !done ? (
          <CardActions className="owner-request-actions">
            {doors.map((door) => (
              <CardActionButton
                key={door.label}
                tone={door.primary ? 'primary' : 'secondary'}
                disabled={act.isPending}
                onClick={() => act.mutate(door)}
              >
                {door.label}
              </CardActionButton>
            ))}
          </CardActions>
        ) : null}
      </div>
    </section>
  );
}
