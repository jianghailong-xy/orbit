import { useMutation, useQueryClient } from '@tanstack/react-query';
import { matchPath, useLocation } from 'react-router-dom';
import { deleteTask } from '../lib/taskDeletion';
import { encodeId } from '../lib/idCodec';
import { rememberTaskRunSidebar } from '../lib/taskRunSidebar';
import { useCloseTaskOverPage, useOpenTaskOverPage } from '../lib/taskInPlace';
import { useToast } from '../lib/toast';
import { TASK_COLUMN_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { TaskDetailPanel } from './TaskDetailPanel';

/**
 * A task open over whichever page its link was pressed on (`?task=<id>`, lib/taskInPlace) — the
 * project page's panel as it is, lying over the page the same way (`.project-task-panel`). ✕ goes
 * back to the page; a dependency opened from inside the panel opens over the same page.
 *
 * Over a conversation on a wide window it is a column beside it instead (docs/mocks/session-task-column,
 * owner 2026-11-26): the conversation narrows and stays readable, header and all. Docked, the panel is the
 * task run sidebar's compact arrangement (docs/task-run-sidebar-design.md), and closing it in the task's own
 * run conversation is remembered there (lib/taskRunSidebar).
 */
export function TaskOverPagePanel({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const openTask = useOpenTaskOverPage();
  const close = useCloseTaskOverPage();
  const { pathname } = useLocation();
  const hereSessionId = matchPath('/sessions/:id', pathname)?.params.id ?? null;
  const roomy = useMediaQuery(TASK_COLUMN_QUERY);
  const docked = hereSessionId != null && roomy;
  // ✕ in one of the task's own runs is that conversation's choice: it stays closed there until opened again.
  const closePanel = () => {
    const runs = qc.getQueryData<{ sessions?: Array<{ id: string }> }>(['task', taskId])?.sessions ?? [];
    if (hereSessionId && runs.some((run) => encodeId(run.id) === encodeId(hereSessionId))) {
      rememberTaskRunSidebar(hereSessionId, true);
    }
    close();
  };
  const remove = useMutation({
    mutationFn: deleteTask,
    onSuccess: async () => {
      close();
      qc.removeQueries({ queryKey: ['task', taskId], exact: true });
      message.success('Task deleted');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['task'] }),
      ]);
    },
    onError: (e: Error) => message.error(e.message),
  });
  return (
    <div className={`project-task-panel${docked ? ' is-docked' : ''}`}>
      <TaskDetailPanel
        docked={docked}
        compact={docked}
        hereSessionId={hereSessionId}
        taskId={taskId}
        onOpenTask={openTask}
        onClose={closePanel}
        onDelete={() => remove.mutate(taskId)}
        deleting={remove.isPending}
      />
    </div>
  );
}
