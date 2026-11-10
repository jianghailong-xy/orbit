import type { ProjectOpenItemsView } from '@orbit/shared';
import { DONE_REQUEST_STALE_HEADING, staleDoneRequest } from '../lib/projectDone';

export function ProjectStaleDoneRow({ view }: { view: ProjectOpenItemsView | null | undefined }) {
  const detail = staleDoneRequest(view);
  if (!detail) return null;
  return <div className="session-project-page-card" role="note" style={{ background: 'var(--bg-sunken)', padding: 12, borderRadius: 12 }}>
    <strong>{DONE_REQUEST_STALE_HEADING}</strong>
    <div style={{ color: 'var(--text-2)', marginTop: 4 }}>{detail}</div>
  </div>;
}
