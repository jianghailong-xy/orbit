import { isSessionLive, type SessionStateSource } from './sessionState';

interface SessionDetailPollingRow extends SessionStateSource {
  id: string;
}

/**
 * Detail is authoritative when it belongs to the current route. The list row is only a fallback
 * while detail loads; `keepPreviousData` may temporarily expose another session's detail.
 */
export function shouldPollSessionDetail(
  selectedId: string | null,
  detail?: SessionDetailPollingRow | null,
  listRow?: SessionDetailPollingRow | null,
): boolean {
  if (!selectedId) return false;
  if (detail?.id === selectedId) return isSessionLive(detail);
  return listRow?.id === selectedId ? isSessionLive(listRow) : false;
}
