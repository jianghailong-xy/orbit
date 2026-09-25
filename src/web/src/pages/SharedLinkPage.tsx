import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { getSharedProjectTask, type SharedRoot } from '../api';
import { SharedProjectPage } from './SharedProjectPage';
import { SharedLoading, sharedRootQuery, SharedSessionPage, SharedUnavailable } from './SharedSessionPage';
import { SharedTaskPage } from './SharedTaskPage';

/**
 * `/s/<token>`: read what the link opens, once, and draw the page for its root — a project's page,
 * a task's page, or a session's conversation (SharedSessionPage, which finds this same read already
 * answered). The owner's Preview arrives as `?preview=1` and is passed on, so looking at one's own
 * link before handing it out is not counted as somebody opening it.
 */
export function SharedLinkPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const { data, isLoading, isError } = useQuery(sharedRootQuery(token, params.get('preview') === '1'));
  if (isLoading) return <SharedLoading />;
  if (isError || !data) return <SharedUnavailable />;
  const root = data as SharedRoot;
  if (root.kind === 'PROJECT') return <SharedProjectPage token={token} data={root} />;
  if (root.kind === 'TASK') return <SharedTaskPage token={token} data={root} />;
  return <SharedSessionPage />;
}

/**
 * `/s/<token>/t/<id>`: one of a project link's tasks, drawn as a task link draws its task, inside
 * the project's scope — the breadcrumb leads back to the project, and its links go where the
 * project link sends them. Anything the link does not open is the same page a dead link shows. Not
 * counted as a view: only the project page is. One page per task, like a conversation's.
 */
export function SharedProjectTaskRoute() {
  const { token = '', taskId = '' } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared', token, 't', taskId],
    queryFn: () => getSharedProjectTask(token, taskId),
    enabled: !!token && !!taskId,
    retry: false,
    staleTime: Infinity,
  });
  if (isLoading) return <SharedLoading />;
  if (isError || !data) return <SharedUnavailable />;
  return <SharedTaskPage key={taskId} token={token} data={data} scope={data.scope} />;
}
