import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteTask } from '../lib/taskDeletion';
import { useCloseTaskOverPage, useOpenTaskOverPage } from '../lib/taskInPlace';
import { useToast } from '../lib/toast';
import { TaskDetailPanel } from './TaskDetailPanel';

/**
 * A task open over whichever page its link was pressed on (`?task=<id>`, lib/taskInPlace) — the
 * project page's panel as it is, lying over the page the same way (`.project-task-panel`). ✕ goes
 * back to the page; a dependency opened from inside the panel opens over the same page.
 */
export function TaskOverPagePanel({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const openTask = useOpenTaskOverPage();
  const close = useCloseTaskOverPage();
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
    <div className="project-task-panel">
      <TaskDetailPanel
        taskId={taskId}
        onOpenTask={openTask}
        onClose={close}
        onDelete={() => remove.mutate(taskId)}
        deleting={remove.isPending}
      />
    </div>
  );
}
