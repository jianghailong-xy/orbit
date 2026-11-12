import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import type { OwnerRequest } from '../lib/ownerRequests';
import { Spinner } from '../components/ui/Spinner';

/**
 * The old Waiting on you address (`/waiting`). The inbox is gone: a request now shows on the row of
 * the session that filed it (docs/mocks/waiting-on-you-removal), so a link that names a request
 * (`?request=<id>`) opens that session, and any other — or a request this account cannot read —
 * lands where the bare root does, on the session list.
 */
export function OwnerRequestRedirect(): JSX.Element {
  const [params] = useSearchParams();
  const requestId = routeId(params.get('request'));
  const request = useQuery({
    queryKey: ['owner-request', requestId] as const,
    queryFn: () => api<OwnerRequest>(`/owner-requests/${encodeURIComponent(requestId!)}`),
    enabled: requestId !== null,
    retry: false,
  });
  if (requestId !== null && request.isPending) return <Spinner aria-busy="true" />;
  const sessionId = routeId(request.data?.askedBySessionId);
  return <Navigate to={sessionId ? `/sessions/${sessionId}` : '/'} replace />;
}
