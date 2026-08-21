import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button, Input, Typography } from 'antd';
import { useId, useState } from 'react';
import { api } from '../api';
import { useToast } from '../lib/toast';
import {
  RUN_AT_IMPOSSIBLE,
  canSaveTaskSchedule,
  refreshTaskScheduleViews,
  runAtIso,
  runAtLocalValue,
  runAtProblem,
  scheduledStart,
} from '../lib/taskSchedule';

/** Only the two toast calls a write makes. Narrow on purpose: the options below can then be built
 *  in a test with a pair of spies rather than the whole toast surface, which needs a router. */
export type WriteToast = Pick<ReturnType<typeof useToast>, 'success' | 'error'>;

/**
 * The two writes the "Start at" field makes, as options a `useMutation` — or a test's
 * `MutationObserver` — can be handed directly.
 *
 * `PATCH /tasks/:id` reads `runAt` three ways and this control uses exactly two of them: an ISO
 * instant schedules or reschedules, and `null` cancels. The third — leaving the field out — means
 * "change nothing", which is why cancelling has to be its own action rather than a consequence of
 * an empty box.
 *
 * Built as a function rather than written inline in the component because everything that happens
 * AFTER the server answers — the toast, the refresh, and the deliberate absence of both on
 * failure — is otherwise behind a button no static render can press.
 */
export function taskScheduleMutations(
  qc: QueryClient,
  message: WriteToast,
  taskId: string,
  projectId?: string | null,
) {
  // Returned from both `onSuccess`, never fired and forgotten: the mutation stays pending until
  // the views it refreshed have actually refetched, so the controls cannot re-enable themselves
  // over a schedule the write has already replaced.
  const refresh = (): Promise<void> => refreshTaskScheduleViews(qc, taskId, projectId);

  return {
    save: {
      mutationFn: (local: string) => {
        const runAt = runAtIso(local);
        // Throws rather than sends. A value the reader picked that cannot be converted must not
        // become a PATCH with `runAt` quietly missing: that request succeeds and changes nothing,
        // so the panel would report a saved schedule and go on showing the old one.
        if (!runAt) throw new Error(RUN_AT_IMPOSSIBLE);
        return api(`/tasks/${taskId}`, { method: 'PATCH', body: { runAt } });
      },
      onSuccess: () => {
        message.success('Start time saved');
        return refresh();
      },
      // The toast and nothing else. Refreshing here would refetch a task whose schedule never
      // moved; the schedule stays on screen, the edit stays in the box, and this button is the
      // retry. Nothing optimistic anywhere, for the same reason.
      onError: (e: Error) => message.error(e.message),
    },
    cancel: {
      // Explicit `null`, never an omitted field: absence is "leave the schedule alone" to the
      // server, which is the one change this action must not make.
      mutationFn: () => api(`/tasks/${taskId}`, { method: 'PATCH', body: { runAt: null } }),
      onSuccess: () => {
        message.success('Scheduled start cancelled');
        return refresh();
      },
      onError: (e: Error) => message.error(e.message),
    },
  };
}

/**
 * Everything the "Start at" field puts on screen, as a function of the state it is in.
 *
 * Presentational and separate from the mutations above it, because every state worth checking —
 * a schedule shown in the reader's zone, an impossible draft refused inline, a save in flight —
 * is then one render away, rather than behind a control a static render cannot press.
 */
export function TaskScheduleFields({
  draft,
  current,
  scheduled,
  scheduledLocal,
  savePending,
  cancelPending,
  onDraft,
  onSave,
  onCancel,
}: {
  /** The control's own value: `YYYY-MM-DDTHH:mm[:ss]` on the VIEWER's wall clock, never UTC. */
  draft: string;
  /** The same spelling of the schedule the SERVER holds — what an unedited draft equals. */
  current: string;
  /** Whether the server holds a start AT ALL, readable or not — what Cancel exists to clear. */
  scheduled: boolean;
  /** That start as the reader reads it. Absent on an unscheduled task, and absent too on a stored
   *  value this control cannot parse, which is a state the reader has to be able to get out of. */
  scheduledLocal?: string | null;
  savePending: boolean;
  cancelPending: boolean;
  onDraft: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Generated rather than written in: two panels are never open at once today, but a fixed id
  // would silently point a second label at the first one's input if one ever were.
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  // Recomputed from the draft on every render rather than held in state: a copy could go stale
  // against the value the control is actually showing.
  const issue = runAtProblem(draft);
  const pending = savePending || cancelPending;

  return (
    <div className="tdp-field tdp-schedule">
      {/* A real <label>, not the styled span the read-only fields use: this one names a control,
          and a name a screen reader can reach is the difference between "Start at" and "edit
          text, blank". */}
      <label className="tdp-field-label" htmlFor={inputId}>
        Start at
      </label>
      <div className="tdp-schedule-body">
        <Input
          id={inputId}
          type="datetime-local"
          size="small"
          // Seconds are part of the value, so the control has to be able to show and collect them
          // — at the default step it offers only minutes, and a schedule stored at :30 would come
          // back rounded the moment anyone touched the field.
          step={1}
          value={draft}
          disabled={pending}
          status={issue ? 'error' : undefined}
          aria-invalid={issue ? true : undefined}
          // `aria-invalid` says only THAT something is wrong. The hint is always announced with
          // the field; the reason joins it when there is one, rather than replacing it.
          aria-describedby={issue ? `${hintId} ${errorId}` : hintId}
          onChange={(e) => onDraft(e.target.value)}
        />
        <div className="tdp-schedule-actions">
          <Button
            size="small"
            type="primary"
            loading={savePending}
            // An empty, impossible or untouched draft has nothing to send — see
            // canSaveTaskSchedule for why each of those is a refusal rather than a request.
            disabled={pending || !canSaveTaskSchedule(draft, current)}
            onClick={onSave}
          >
            Save schedule
          </Button>
          {/* Offered whenever the server holds a start, INCLUDING one this control cannot read.
              A value that cannot be parsed is exactly the case with no other way out: the box
              shows nothing to edit, so without this the reader is left with a task the server
              will still act on and no control that touches it. Absent only on a task that has no
              schedule at all, where it would be a button that does nothing. */}
          {scheduled && (
            <Button size="small" loading={cancelPending} disabled={pending} onClick={onCancel}>
              Cancel schedule
            </Button>
          )}
        </div>
        {issue && (
          <div id={errorId} role="alert" className="tdp-schedule-error">
            {issue}
          </div>
        )}
        {/* A datetime-local shows no placeholder, so the three things the control cannot say for
            itself are said here: whose clock it reads, that the start fires once, and — on a task
            that has one — that Run now is a way of losing it. That last sentence is the whole
            reason this is in the panel rather than only in the header button's tooltip: a reader
            deciding between the two is looking here. */}
        <Typography.Text id={hintId} type="secondary" className="tdp-schedule-hint">
          {scheduledLocal
            ? `Starts once, on ${scheduledLocal}, in your own time zone. Run now starts immediately and clears this scheduled start.`
            : scheduled
              ? // Stored, unreadable, and still live as far as the server is concerned. Said
                // plainly rather than hidden behind an empty box that would read as "unscheduled",
                // and it names both ways out — the only two this control has.
                'A start is scheduled that this control cannot read. Cancel schedule clears it, or pick a time to replace it.'
              : 'Optional, in your own time zone. The task starts once, at that time.'}
        </Typography.Text>
      </div>
    </div>
  );
}

/**
 * The panel's "Start at" field: the draft the reader is editing, and the two writes it can make.
 *
 * Editing is DRAFT-first. The control writes to local state only, and nothing reaches the server
 * until Save is pressed — because a datetime-local emits a value on nearly every keystroke, and
 * half of those are partial: typing 2027 into the year passes through 0002, a year that is both a
 * valid instant and one nobody meant. Auto-saving would schedule several of them on the way.
 *
 * The draft re-syncs when the SERVER's schedule changes, and only then. The panel polls itself
 * every few seconds while a run is live, and re-deriving on each of those would wipe out whatever
 * is half-typed; comparing against the value the draft was last taken from is what tells a real
 * change from a repeat of the same answer.
 *
 * Nothing here is optimistic. A failed Save or Cancel leaves both the cache and the control
 * exactly as they were, so the schedule stays on screen, the reader's edit stays in the box, and
 * the same button is the retry — the alternative is a panel showing a schedule cleared that the
 * server still holds, which is the state the next sweep would act on.
 *
 * Exported on its own because the panel around it needs a task, its comments, its sessions and its
 * dependency graph in cache before it renders at all; this needs a task id and an instant.
 */
export function TaskScheduleEditor({
  taskId,
  runAt,
  projectId,
}: {
  taskId: string;
  /** The schedule the SERVER holds, as `/tasks/:id` returned it. */
  runAt?: string | null;
  /** The project whose task pages show this task's start, when it is filed under one. */
  projectId?: string | null;
}) {
  const qc = useQueryClient();
  const message = useToast();

  const current = runAtLocalValue(runAt);
  const [draft, setDraft] = useState(current);
  const [syncedFrom, setSyncedFrom] = useState(current);
  if (syncedFrom !== current) {
    setSyncedFrom(current);
    setDraft(current);
  }

  const writes = taskScheduleMutations(qc, message, taskId, projectId);
  const save = useMutation(writes.save);
  const cancel = useMutation(writes.cancel);

  return (
    <TaskScheduleFields
      draft={draft}
      current={current}
      // Two different questions, and on a stored value this control cannot parse they have
      // different answers: there IS a schedule, and it has no reading to show.
      scheduled={Boolean(runAt)}
      scheduledLocal={scheduledStart(runAt)?.local}
      savePending={save.isPending}
      cancelPending={cancel.isPending}
      onDraft={setDraft}
      onSave={() => save.mutate(draft)}
      onCancel={() => cancel.mutate()}
    />
  );
}
