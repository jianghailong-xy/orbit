import { api } from '../api';

export interface BatchDeleteTasksResult {
  deleted: number;
}

/** Delete one task from its row action. */
export const deleteTask = (taskId: string): Promise<{ ok: boolean }> =>
  api(`/tasks/${taskId}`, { method: 'DELETE' });

/** Delete the selected tasks in one atomic, owner-scoped request. */
export const deleteTasks = (taskIds: string[]): Promise<BatchDeleteTasksResult> =>
  api('/tasks/batch-delete', { method: 'POST', body: { taskIds } });
