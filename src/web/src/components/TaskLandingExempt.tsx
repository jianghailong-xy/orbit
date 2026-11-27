import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectSettingChangeView } from '@orbit/shared';
import { api } from '../api';
import { LANDING_CHECK_ORIGIN_COPY, TASK_EXEMPT_COPY } from '../lib/landingCheck';
import { projectDetailsQuery } from '../lib/queries';
import { ago } from '../lib/watches';
import { Button } from './ui/Button';

/**
 * The Landing check row of a task page's Landing section (revision 42 part two, board 04, ruling D5):
 * `Exempt`, the reason the task was exempted for, who marked it and when, and the owner's way to take
 * the exemption off. The flag and the reason are the task read's own `landingCheckExempt` and
 * `landingCheckExemptReason`; who and when are the newest record of that task's exemption in the
 * project's `settingChanges`, and are left out when the server lists none.
 */
export function TaskLandingExempt({ task }: {
  task: { id: string; projectId?: string | null; landingCheckExempt?: boolean; landingCheckExemptReason?: string | null };
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = useQuery({
    ...projectDetailsQuery(task.projectId ?? ''),
    enabled: Boolean(task.projectId) && task.landingCheckExempt === true,
  });
  const remove = useMutation({
    mutationFn: () => api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { landingCheckExempt: false } }),
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['task', task.id] }),
      qc.invalidateQueries({ queryKey: ['project', task.projectId] }),
    ]),
  });
  if (task.landingCheckExempt !== true) return null;
  const changes = (project.data as { settingChanges?: ProjectSettingChangeView[] } | undefined)?.settingChanges ?? [];
  const marked = changes.find((change) => change.field === 'TASK_LANDING_CHECK_EXEMPT' && change.taskId === task.id
    && (change.newValue as { exempt?: boolean }).exempt === true && change.revertedAt === null);
  const by = marked ? (marked.origin === 'COORDINATOR' ? LANDING_CHECK_ORIGIN_COPY.COORDINATOR
    : marked.origin === 'CARD' ? LANDING_CHECK_ORIGIN_COPY.CARD : LANDING_CHECK_ORIGIN_COPY.OWNER) : null;
  return (
    <div className="task-landing-exempt" data-task-exempt="true">
      <div className="task-landing-exempt-head">
        <span className="task-landing-exempt-label">{TASK_EXEMPT_COPY.LABEL}</span>
        <span className="project-landing-badge is-coordinator task-landing-exempt-badge">{TASK_EXEMPT_COPY.BADGE}</span>
      </div>
      {task.landingCheckExemptReason ? <div className="task-landing-exempt-reason">{task.landingCheckExemptReason}</div> : null}
      {marked && by ? (
        <div className="project-landing-origin">
          <span className={`project-landing-badge is-${marked.origin.toLowerCase()}`}>{by}</span>
          <span className="project-landing-origin-time">{`marked ${ago(marked.createdAt, Date.now())}`}</span>
        </div>
      ) : null}
      <Button size="small" loading={remove.isPending} onClick={() => remove.mutate()}>{TASK_EXEMPT_COPY.REMOVE}</Button>
    </div>
  );
}
