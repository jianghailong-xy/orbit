import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type { SharedRoot } from '../api';
import { SharedLoading, sharedRootQuery, SharedSessionPage, SharedUnavailable } from './SharedSessionPage';
import { SharedTaskPage } from './SharedTaskPage';

/**
 * `/s/<token>`: read what the link opens, once, and draw the page for its root — a task's page, or a
 * session's conversation (SharedSessionPage, which finds this same read already answered). The
 * owner's Preview arrives as `?preview=1` and is passed on, so looking at one's own link before
 * handing it out is not counted as somebody opening it.
 */
export function SharedLinkPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const { data, isLoading, isError } = useQuery(sharedRootQuery(token, params.get('preview') === '1'));
  if (isLoading) return <SharedLoading />;
  if (isError || !data) return <SharedUnavailable />;
  const root = data as SharedRoot;
  if (root.kind === 'TASK') return <SharedTaskPage token={token} data={root} />;
  return <SharedSessionPage />;
}
