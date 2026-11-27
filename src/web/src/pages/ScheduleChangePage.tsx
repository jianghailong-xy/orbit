import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { SCHEDULE_COPY, scheduleFill } from '@orbit/shared';
import { ScheduleChangeOpeningView, scheduleErrorText } from '../components/ScheduleCards';
import { Button } from '../components/ui/Button';
import { openScheduleChange, scheduleChangeQuery } from '../lib/schedules';
import '../components/Scheduled.css';

const T = SCHEDULE_COPY.changeConversation;

/**
 * A schedule's Change… (docs/scheduled-tasks-design.md §8.2, board 03-change ③): Orbit's opening and a composer, before
 * any session exists. The person's first words open the change conversation, and the page gives way to it. A schedule
 * with a change conversation still open goes straight there.
 */
export function ScheduleChangePage(): JSX.Element | null {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const change = useQuery(scheduleChangeQuery(id));
  const [text, setText] = useState('');
  const openSession = (sessionId: string) => navigate(`/sessions/${encodeURIComponent(sessionId)}`, { replace: true });
  const send = useMutation({
    mutationFn: (words: string) => openScheduleChange(id, words),
    onSuccess: (answer) => openSession(answer.sessionId),
  });

  const open = change.data?.sessionId;
  useEffect(() => {
    if (open) openSession(open);
    // openSession is a fresh closure each render; the session id is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (change.isError) return <div className="sched-change-draft"><span className="sched-error" role="alert">{scheduleErrorText(change.error)}</span></div>;
  if (!change.data || open) return null;
  const { opening } = change.data;
  const words = text.trim();
  const submit = () => {
    if (words && !send.isPending) send.mutate(words);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const error = scheduleErrorText(send.error);
  return (
    <div className="sched-change-draft" data-schedule-change-draft={opening.scheduleId}>
      <h1>{scheduleFill(T.title, { title: opening.title })}</h1>
      <div className="sched-change-draft-body">
        <ScheduleChangeOpeningView opening={opening} />
      </div>
      {error ? <span className="sched-error" role="alert">{error}</span> : null}
      <div className="sched-change-composer">
        <textarea
          autoFocus
          rows={1}
          value={text}
          placeholder={T.placeholder}
          aria-label={T.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button size="small" variant="primary" disabled={!words || send.isPending} onClick={submit} aria-label="Send">↑</Button>
      </div>
    </div>
  );
}
