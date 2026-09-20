import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button, Input, Typography } from 'antd';
import { useId, useState } from 'react';
import { api } from '../api';
import { MD } from '../components/Transcript';
import type { WriteToast } from '../components/TaskScheduleEditor';
import { refreshTaskScheduleViews } from '../lib/taskSchedule';
import { useToast } from '../lib/toast';

/**
 * The task detail page's acceptance block: what "done" means for this task, and who decides it.
 *
 * Two fields, answering different questions. `acceptanceCriteria` is the prose — what a reader and
 * an agent have to be satisfied by — written the way the task description is written, so it is
 * rendered as Markdown the same way. `acceptanceCommand` with `acceptanceExpectedExitCode` is the
 * L0 pair: the server runs the command and reads its exit code, which settles the task with nobody
 * in the loop at all.
 *
 * The pair is one field in every sense that matters. The server re-derives the task's completion
 * criterion from the merged declaration — a command makes it EXECUTABLE, clearing it falls back to
 * evidence — so a write carrying half of it would leave a declaration nothing can satisfy. Hence
 * one Save, both values or neither, and a Save that stays shut until they agree.
 *
 * Blank is not a value. `""` and null would be two stored states for one intention, so every write
 * normalizes the way the server does for a project's goal and instructions
 * (`ProjectsService.blankToNull`): trim, and send null when nothing is left.
 *
 * The detail is presented as a panel over the task list — `TaskListView` mounts `TaskDetailPanel` —
 * so this module is the detail page's own home for the block that says what finishing it means.
 */

/** The three stored fields, as `/tasks/:id` returns them. */
export interface TaskAcceptanceValues {
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
}

/** The same three as the control holds them: text, because every one of the three is typed. */
export interface AcceptanceDraft {
  criteria: string;
  command: string;
  exitCode: string;
}

/** What a Save sends: the fields that moved, and only those. */
export interface AcceptancePatch {
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
}

export const ACCEPTANCE_EMPTY = 'No acceptance criteria set.';
export const ACCEPTANCE_PAIR_EMPTY = 'Not set — a person decides when this task is done.';
/** Why the pair is worth filling in at all — the sentence a reader is deciding in front of. */
export const ACCEPTANCE_AUTOMATIC_HINT =
  'Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand.';
export const ACCEPTANCE_PAIR_INCOMPLETE =
  'The command and the exit code that counts as done go together — fill in both.';
export const ACCEPTANCE_EXIT_CODE_NOT_AN_INTEGER = 'The exit code has to be a whole number.';

/**
 * The server's rule for an emptied field, kept identical to `ProjectsService.blankToNull`: the
 * value is stored as the writer typed it, and only an all-whitespace one becomes null. Trimming
 * what is stored instead would silently rewrite a criteria block someone indented on purpose.
 */
export function blankToNull(value: string): string | null {
  return value.trim() ? value : null;
}

/** What makes two drafts "the same edit" — for the Save button, and for the re-sync below. */
export function acceptanceKey(draft: AcceptanceDraft): string {
  return [draft.criteria, draft.command, draft.exitCode].join('\u0000');
}

/** The control's draft, taken from what the server holds. */
export function acceptanceDraftFrom(task: TaskAcceptanceValues | undefined): AcceptanceDraft {
  return {
    criteria: task?.acceptanceCriteria ?? '',
    command: task?.acceptanceCommand ?? '',
    exitCode: task?.acceptanceExpectedExitCode == null ? '' : String(task.acceptanceExpectedExitCode),
  };
}

/**
 * The one thing this form refuses, or null when it will send.
 *
 * Half a pair is the refusal worth having: the exit code alone names no command, and the command
 * alone is not a judgement. Everything else the server is left to answer itself — a command that
 * does not exist is discovered by running it, not by this control.
 */
export function acceptanceProblem(draft: AcceptanceDraft): string | null {
  const command = draft.command.trim();
  const exitCode = draft.exitCode.trim();
  if (!command && !exitCode) return null;
  if (!command || !exitCode) return ACCEPTANCE_PAIR_INCOMPLETE;
  return /^-?\d+$/.test(exitCode) ? null : ACCEPTANCE_EXIT_CODE_NOT_AN_INTEGER;
}

/** Whether two drafts hold the same pair — command and code, as the reader sees them. */
function samePair(a: AcceptanceDraft, b: AcceptanceDraft): boolean {
  return a.command.trim() === b.command.trim() && a.exitCode.trim() === b.exitCode.trim();
}

/**
 * Whether the reader changed anything. Whitespace on its own is not an edit: it cannot mean
 * anything to a command, and to the prose it is the difference between two identical paragraphs.
 */
export function acceptanceChanged(draft: AcceptanceDraft, current: AcceptanceDraft): boolean {
  return draft.criteria.trim() !== current.criteria.trim() || !samePair(draft, current);
}

/**
 * The request body for a Save: what moved, and nothing else.
 *
 * A field that did not move is left OUT rather than sent back as it stands, because the two are
 * not the same request. Any `acceptanceCommand` in the body — including a null repeating a null
 * already stored — makes the server re-derive the task's completion criterion from the merged
 * declaration, so a reader who edited only the prose would silently move an owner-confirmed task
 * onto the evidence path.
 *
 * The pair moves as one. A body carrying half of it would leave an exit code from a command the
 * reader just replaced, and clearing is the same statement in the other direction: both null, in
 * the one spelling the server reads as "this task is no longer judged by a command".
 */
export function acceptancePatch(draft: AcceptanceDraft, current: AcceptanceDraft): AcceptancePatch {
  const patch: AcceptancePatch = {};
  if (draft.criteria.trim() !== current.criteria.trim()) {
    patch.acceptanceCriteria = blankToNull(draft.criteria);
  }
  if (!samePair(draft, current)) {
    const command = blankToNull(draft.command);
    patch.acceptanceCommand = command;
    patch.acceptanceExpectedExitCode = command === null ? null : Number(draft.exitCode.trim());
  }
  return patch;
}

/** Untouched drafts have nothing to send; a draft the form refuses has nothing to say. */
export function canSaveAcceptance(draft: AcceptanceDraft, current: AcceptanceDraft): boolean {
  return acceptanceChanged(draft, current) && acceptanceProblem(draft) === null;
}

/**
 * The one write this block makes, as options a `useMutation` — or a test's `MutationObserver` —
 * can be handed directly, so what reaches the server is assertable without pressing a button.
 *
 * The refresh is the shared single-task one: an acceptance write moves the task's own detail, the
 * rows of the list it is in, and its project's pages, exactly as a schedule write does. It is
 * returned rather than fired and forgotten so the Save stays pending until the views have caught
 * up, the same reason every other write in the panel returns it.
 */
export function taskAcceptanceMutations(
  qc: QueryClient,
  message: WriteToast,
  taskId: string,
  projectId?: string | null,
) {
  return {
    save: {
      mutationFn: (patch: AcceptancePatch) =>
        api(`/tasks/${taskId}`, { method: 'PATCH', body: patch }),
      onSuccess: () => {
        message.success('Acceptance saved');
        return refreshTaskScheduleViews(qc, taskId, projectId);
      },
      // The toast and nothing else: the panel keeps showing what the server holds, the reader's
      // edit stays in the box, and this button is the retry.
      onError: (e: Error) => message.error(e.message),
    },
  };
}

/**
 * Everything this block puts on screen, as a function of the state it is in.
 *
 * Presentational and separate from the write above it for the same reason the schedule field's is:
 * the states worth checking — criteria rendered as prose, a pair shown as a pair, a refused draft
 * — are then one render away, rather than behind a button a static render cannot press.
 */
export function TaskAcceptanceFields({
  draft,
  problem,
  canSave,
  editing,
  saving,
  onEdit,
  onDraft,
  onSave,
  onCancel,
}: {
  /** What the control holds — in the read view, what the server holds. */
  draft: AcceptanceDraft;
  /** Why this draft will not be sent, or null. Shown only while editing. */
  problem: string | null;
  canSave: boolean;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onDraft: (next: AcceptanceDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Generated rather than written in: two panels are never open at once today, but a fixed id
  // would silently point a second label at the first one's input if one ever were.
  const criteriaId = useId();
  const commandId = useId();
  const exitCodeId = useId();
  const hintId = useId();
  const problemId = useId();
  const criteria = blankToNull(draft.criteria);
  const judged = blankToNull(draft.command) !== null && draft.exitCode.trim() !== '';
  const described = problem ? `${hintId} ${problemId}` : hintId;

  return (
    <>
      {editing ? (
        // A real <label>, spelling the same words the read view's heading does: this one names a
        // control, and a name a screen reader can reach is the difference between "Acceptance
        // criteria" and "edit text, blank".
        <>
          <label className="tdp-acceptance-label" htmlFor={criteriaId}>
            Acceptance criteria
          </label>
          <Input.TextArea
            id={criteriaId}
            className="tdp-acceptance-criteria-input"
            autoSize={{ minRows: 3, maxRows: 10 }}
            placeholder="What has to be true when this task is done"
            value={draft.criteria}
            disabled={saving}
            aria-describedby={described}
            onChange={(e) => onDraft({ ...draft, criteria: e.target.value })}
          />
        </>
      ) : (
        <>
          <div className="tdp-acceptance-head">
            <span className="tdp-acceptance-label">Acceptance criteria</span>
            {/* The control is opened rather than always standing open: prose typed straight into
                the panel would have to be saved on the way, and the reader's half-written
                sentence — "the suite passes, and" — is not an acceptance criterion. */}
            <Button size="small" onClick={onEdit}>
              Edit
            </Button>
          </div>
          {criteria ? (
            <div className="tdp-prose">
              <MD breaks>{criteria}</MD>
            </div>
          ) : (
            <Typography.Text type="secondary" className="tdp-acceptance-empty">
              {ACCEPTANCE_EMPTY}
            </Typography.Text>
          )}
        </>
      )}

      <div className="tdp-acceptance-head">
        <span className="tdp-acceptance-label">Automatic judgement</span>
      </div>
      {editing ? (
        <div className="tdp-acceptance-pair">
          <label className="tdp-acceptance-pair-label" htmlFor={commandId}>
            Command
          </label>
          <Input
            id={commandId}
            size="small"
            className="tdp-acceptance-command-input"
            placeholder="e.g. npm test -w @orbit/web"
            value={draft.command}
            disabled={saving}
            aria-describedby={described}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => onDraft({ ...draft, command: e.target.value })}
          />
          {/* A real <label>, not the styled span the read-only rows use: this one names a control,
              and "done when it exits" is the whole instruction the exit code needs. */}
          <label className="tdp-acceptance-pair-label" htmlFor={exitCodeId}>
            done when it exits
          </label>
          <Input
            id={exitCodeId}
            size="small"
            className="tdp-acceptance-exit-input"
            inputMode="numeric"
            placeholder="0"
            value={draft.exitCode}
            disabled={saving}
            aria-describedby={described}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => onDraft({ ...draft, exitCode: e.target.value })}
          />
        </div>
      ) : judged ? (
        <div className="tdp-acceptance-pair">
          <code className="tdp-acceptance-command">{draft.command.trim()}</code>
          <span className="tdp-acceptance-exit">
            done when it exits <code>{draft.exitCode.trim()}</code>
          </span>
        </div>
      ) : (
        <Typography.Text type="secondary" className="tdp-acceptance-empty">
          {ACCEPTANCE_PAIR_EMPTY}
        </Typography.Text>
      )}

      <Typography.Text id={hintId} type="secondary" className="tdp-acceptance-hint">
        {ACCEPTANCE_AUTOMATIC_HINT}
      </Typography.Text>
      {editing && problem && (
        <div id={problemId} role="alert" className="tdp-acceptance-error">
          {problem}
        </div>
      )}
      {editing && (
        <div className="tdp-acceptance-actions">
          <Button size="small" type="primary" loading={saving} disabled={saving || !canSave} onClick={onSave}>
            Save acceptance
          </Button>
          <Button size="small" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The block the panel renders: the draft the reader is editing, and the one write it can make.
 *
 * Editing is DRAFT-first, and the draft re-syncs when the SERVER's values change and only then —
 * the panel polls itself while a run is live, and re-deriving on each of those would wipe out
 * whatever is half-typed. Comparing against what the draft was last taken from is what tells a
 * real change from a repeat of the same answer.
 */
export function TaskAcceptance({
  taskId,
  task,
  projectId,
}: {
  taskId: string;
  /** The task as `/tasks/:id` returned it — the three fields this block reads and writes. */
  task?: TaskAcceptanceValues;
  /** The project whose pages show this task, when it is filed under one. */
  projectId?: string | null;
}) {
  const qc = useQueryClient();
  const message = useToast();

  const current = acceptanceDraftFrom(task);
  const currentKey = acceptanceKey(current);
  const [draft, setDraft] = useState(current);
  const [syncedFrom, setSyncedFrom] = useState(currentKey);
  const [editing, setEditing] = useState(false);
  if (syncedFrom !== currentKey) {
    setSyncedFrom(currentKey);
    setDraft(current);
  }

  const writes = taskAcceptanceMutations(qc, message, taskId, projectId);
  const save = useMutation(writes.save);

  return (
    <TaskAcceptanceFields
      draft={editing ? draft : current}
      problem={acceptanceProblem(draft)}
      canSave={canSaveAcceptance(draft, current)}
      editing={editing}
      saving={save.isPending}
      onEdit={() => setEditing(true)}
      onDraft={setDraft}
      onSave={() => save.mutate(acceptancePatch(draft, current))}
      onCancel={() => {
        setDraft(current);
        setEditing(false);
      }}
    />
  );
}
