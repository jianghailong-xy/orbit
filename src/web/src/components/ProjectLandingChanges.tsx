import { useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ProjectLandingCheckValue, ProjectSettingChangeView, ProjectTaskExemptValue } from '@orbit/shared';
import { ApiError, api } from '../api';
import { encodeId } from '../lib/idCodec';
import { CHANGES_COPY, LANDING_CHECK_ORIGIN_COPY, changesRowLabel, revertFailureLine, revertedLine } from '../lib/landingCheck';
import { ago } from '../lib/watches';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * The coordinator's changes to the landing check (revision 42 part two, board 05, rulings D6 and D7):
 * a row in Settings, `3 changes ›`, that opens the list. Everything it draws is a field of
 * `project_get.settingChanges`; whether Revert is offered is the server's `revertible`.
 */

const isLandingValue = (value: ProjectSettingChangeView['oldValue']): value is ProjectLandingCheckValue => 'none' in value;

function ValueText({ value }: { value: ProjectSettingChangeView['oldValue'] }): JSX.Element {
  if (isLandingValue(value)) {
    if (value.none) return <>{CHANGES_COPY.NO_CHECK}</>;
    return value.command ? <code className="project-change-code">{value.command}</code> : <>{CHANGES_COPY.USES_MERGE_CHECK}</>;
  }
  return <>{(value as ProjectTaskExemptValue).exempt ? CHANGES_COPY.EXEMPT : CHANGES_COPY.NOT_EXEMPT}</>;
}

function ChangeRow({ change, projectId, now, onRevert }: {
  change: ProjectSettingChangeView;
  projectId: string;
  now: number;
  onRevert: (change: ProjectSettingChangeView) => void;
}): JSX.Element {
  const task = change.field === 'TASK_LANDING_CHECK_EXEMPT';
  const origin = change.origin === 'COORDINATOR' ? LANDING_CHECK_ORIGIN_COPY.COORDINATOR
    : change.origin === 'CARD' ? LANDING_CHECK_ORIGIN_COPY.CARD : LANDING_CHECK_ORIGIN_COPY.OWNER;
  return (
    <li className={`project-change-row${change.revertedAt ? ' is-reverted' : ''}`} data-change-id={change.id}>
      <div className="project-change-what">
        {task ? CHANGES_COPY.CHECK_EXEMPT : CHANGES_COPY.LANDING_CHECK}
        {task && change.taskId ? (
          <> · <Link to={`/projects/${encodeURIComponent(encodeId(projectId))}/tasks/${encodeURIComponent(encodeId(change.taskId))}`}>Open task</Link></>
        ) : null}
      </div>
      <div className="project-change-body">
        <div className="project-change-values">
          <s><ValueText value={change.oldValue} /></s>
          <span aria-hidden="true"> → </span>
          <b><ValueText value={change.newValue} /></b>
        </div>
        {change.reason ? <div className="project-change-reason">{change.reason}</div> : null}
      </div>
      <div className="project-change-who">
        <span className={`project-landing-badge is-${change.origin.toLowerCase()}`}>{origin}</span>
        <span className="project-change-when">{ago(change.createdAt, now)}</span>
        {change.revertedAt ? <div className="project-change-reverted">{revertedLine(ago(change.revertedAt, now))}</div> : null}
      </div>
      <div className="project-change-action">
        {change.revertible ? (
          <Button danger size="small" onClick={() => onRevert(change)}>{CHANGES_COPY.REVERT}</Button>
        ) : change.origin !== 'COORDINATOR' ? (
          <span className="project-change-note">{CHANGES_COPY.YOUR_CHANGE_NOTHING}</span>
        ) : null}
      </div>
    </li>
  );
}

/** The list itself, with the confirmation a Revert asks first. */
export function CoordinatorChanges({ projectId, changes }: { projectId: string; changes: readonly ProjectSettingChangeView[] }): JSX.Element {
  const qc = useQueryClient();
  const [confirm, confirmation] = useConfirm();
  const [failure, setFailure] = useState<string | null>(null);
  const revert = useMutation({
    mutationFn: (change: ProjectSettingChangeView) => api(
      `/projects/${encodeURIComponent(projectId)}/setting-changes/${encodeURIComponent(change.id)}/revert`, { method: 'POST' },
    ),
    onSettled: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
  const ask = async (change: ProjectSettingChangeView) => {
    setFailure(null);
    const what: ReactNode = (
      <>
        {change.field === 'LANDING_CHECK' ? CHANGES_COPY.LANDING_CHECK : CHANGES_COPY.CHECK_EXEMPT} goes back from{' '}
        <b><ValueText value={change.newValue} /></b> to <ValueText value={change.oldValue} />.
        <div className="project-change-consequence">{CHANGES_COPY.CONFIRM_CONSEQUENCE}</div>
      </>
    );
    await confirm({
      title: CHANGES_COPY.CONFIRM_TITLE,
      description: what,
      confirmText: CHANGES_COPY.REVERT,
      cancelText: CHANGES_COPY.CANCEL,
      danger: true,
      onConfirm: async () => {
        try {
          await revert.mutateAsync(change);
        } catch (error) {
          setFailure(revertFailureLine(error instanceof ApiError ? error.code : undefined));
        }
      },
    });
  };
  const now = Date.now();
  return (
    <section className="project-changes" aria-label={CHANGES_COPY.TITLE}>
      <div className="project-changes-title">{CHANGES_COPY.TITLE}</div>
      <div className="project-integration-setting-hint">{CHANGES_COPY.INTRO}</div>
      {changes.length === 0 ? <div className="project-integration-setting-hint">{CHANGES_COPY.EMPTY}</div> : (
        <ul className="project-changes-list">
          {changes.map((change) => <ChangeRow key={change.id} change={change} projectId={projectId} now={now} onRevert={ask} />)}
        </ul>
      )}
      {failure ? <div className="start-card-warn">{failure}</div> : null}
      {confirmation}
    </section>
  );
}

/** Settings' one row into the list (D6): hidden while the server lists no change, since there is nothing to open. */
export function ProjectChangesRow({ projectId, changes }: { projectId: string; changes?: readonly ProjectSettingChangeView[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!changes || changes.length === 0) return null;
  return (
    <div className="project-integration-setting project-changes-entry">
      <button type="button" className="project-changes-row" data-row-focus="" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="project-integration-setting-label">{CHANGES_COPY.TITLE}</span>
        <span className="project-changes-count">{changesRowLabel(changes.length)} ›</span>
      </button>
      {open ? <CoordinatorChanges projectId={projectId} changes={changes} /> : null}
    </div>
  );
}
