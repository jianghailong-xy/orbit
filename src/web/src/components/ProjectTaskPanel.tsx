import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import { projectTaskPath, useCloseProjectTask, useOpenProjectTask } from '../lib/projectTaskRoute';
import { deleteTask } from '../lib/taskDeletion';
import { useToast } from '../lib/toast';
import { TaskDetailPanel } from './TaskDetailPanel';

/**
 * One of a project's tasks, open over the project's page (`/projects/:id/tasks/:taskId`).
 *
 * The Tasks page's panel as it is — the same component, the same reads, the same actions. What
 * differs is what stands behind it and where ✕ goes: the project's page, which ✕ goes back to
 * (lib/projectTaskRoute), and a dependency opened from inside the panel opens over the same page.
 *
 * A task that turns out to live somewhere else — a dependency in another project, a stale or
 * hand-edited address — is sent where it lives instead of being drawn over the wrong project: its
 * own project's page, or the Tasks page for a task filed under no project.
 */
export function ProjectTaskPanel({ projectId, taskId }: { projectId: string; taskId: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const openTask = useOpenProjectTask(projectId);
  const close = useCloseProjectTask(projectId);
  // The panel's own read, under its own key: the two are one request and one cache entry.
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api<any>(`/tasks/${taskId}`) });
  const remove = useMutation({
    mutationFn: deleteTask,
    onSuccess: async () => {
      // Closed first, the way the Tasks page's panel closes on its own delete: the address must
      // not go on naming a task that no longer exists.
      close();
      qc.removeQueries({ queryKey: ['task', taskId], exact: true });
      message.success('Task deleted');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['project', projectId] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        // Deleting a prerequisite removes dependency edges from other task details.
        qc.invalidateQueries({ queryKey: ['task'] }),
      ]);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Undefined until the read answers; null for a task filed under no project.
  const home = task.data ? (task.data.project?.id ?? null) : undefined;
  if (home !== undefined && routeId(home) !== projectId) {
    return (
      <Navigate replace to={home ? projectTaskPath(home, taskId) : `/tasks/${encodeURIComponent(taskId)}`} />
    );
  }
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
