import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import { projectTaskPath } from '../lib/projectTaskRoute';
import { TaskListView } from './TaskListView';

/**
 * The Tasks page's routes — `/tasks`, `/tasks/:id`, `/lists/:key` — and the one place a task's
 * address decides which page it opens over.
 *
 * Every link to a task in the app arrives at `/tasks/:id`: a chat reference, a notification, a card
 * in a conversation, a pasted URL. A task filed under a project is sent to its project's page
 * (lib/projectTaskRoute). The Tasks page's browsing views are the tasks outside projects — it says
 * so above its rows — so opening a project's task over them opens it over a list it is not in, with
 * ✕ landing on that list.
 *
 * A scope somebody picked is another matter: a named list, or one conversation's tasks
 * (`?createdIn=`), shows its members whoever filed them, and a task opened from it stays over it.
 * "No list" (`?list=none`) is a browsing view like every task, so it is not one of those.
 *
 * All three routes render this same component, so the list underneath is one instance across them:
 * opening and closing a task does not remount it (TaskListView's own panel rule). Only an arrival —
 * the page mounted on a task's address — waits for that task's read before drawing, or the list
 * would flash and then give way to the project's page. The read is the panel's own (`['task', id]`),
 * so whichever page opens already has it.
 */
export function TaskRoute() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const taskId = routeId(id);
  const list = search.get('list');
  const browsing = !((list != null && list !== 'none') || search.has('createdIn'));
  const task = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api<any>(`/tasks/${taskId}`),
    enabled: Boolean(taskId) && browsing,
  });
  const settled = task.isSuccess || task.isError;
  const [arriving, setArriving] = useState(() => Boolean(taskId) && browsing);
  useEffect(() => {
    if (arriving && settled) setArriving(false);
  }, [arriving, settled]);

  const projectId = browsing ? (task.data?.project?.id as string | undefined) : undefined;
  if (taskId && projectId) return <Navigate replace to={projectTaskPath(projectId, taskId)} />;
  if (arriving && !settled) {
    return (
      <main className="app-main">
        <div className="app-view app-view--doc" style={{ display: 'grid', placeItems: 'center' }}>
          <Spin />
        </div>
      </main>
    );
  }
  return <TaskListView />;
}
