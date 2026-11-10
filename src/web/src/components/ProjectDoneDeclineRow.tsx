import './ProjectDoneDeclineRow.css';
import type { ProjectOpenItemsView } from '@orbit/shared';
import { DONE_DECLINE_HEADING, DONE_DECLINE_HINT, formatDoneDateTime, staleDoneRequest } from '../lib/projectDone';

export function ProjectDoneDeclineRow({ items }: { items?: ProjectOpenItemsView | null }) {
  const decline = items?.doneRequest ? null : items?.latestDoneRequestDecline;
  if (!decline || staleDoneRequest(items)) return null;
  return <div className="project-done-decline-row" role="note">
    <strong>{DONE_DECLINE_HEADING} · {formatDoneDateTime(decline.declinedAt)}</strong>
    <div>“{decline.note}” {DONE_DECLINE_HINT}</div>
  </div>;
}
