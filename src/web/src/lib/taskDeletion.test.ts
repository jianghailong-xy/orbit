import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({ api: apiMock }));

import { deleteTask, deleteTasks } from './taskDeletion';

describe('task deletion API client', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('deletes one task with the existing task endpoint', async () => {
    apiMock.mockResolvedValue({ ok: true });

    await expect(deleteTask('task-1')).resolves.toEqual({ ok: true });

    expect(apiMock).toHaveBeenCalledWith('/tasks/task-1', { method: 'DELETE' });
  });

  it('sends selected task ids to the batch-delete endpoint', async () => {
    apiMock.mockResolvedValue({ deleted: 2 });

    await expect(deleteTasks(['task-1', 'task-2'])).resolves.toEqual({ deleted: 2 });

    expect(apiMock).toHaveBeenCalledWith('/tasks/batch-delete', {
      method: 'POST',
      body: { taskIds: ['task-1', 'task-2'] },
    });
  });

  it('surfaces API failures for the mutation error handler', async () => {
    apiMock.mockRejectedValue(new Error('Delete failed'));

    let failure: unknown;
    try {
      await deleteTasks(['task-1']);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error('Delete failed'));
  });
});
