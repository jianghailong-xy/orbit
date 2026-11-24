import { useRef, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import type { OwnerRequest } from '../lib/ownerRequests';
import { ownerRequestsQuery } from '../lib/queries';
import {
  PROJECT_REOPEN_COPY as COPY,
  askerLine,
  projectReopenPayloadOf,
  projectReopenProjectTitle,
  settledDate,
  waitingReopenRequests,
} from '../lib/projectReopen';
import { AppLink } from './AppLink';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, useDecisionCardKeys } from './CardHotkey';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import { Alert } from './ui/Alert';
import { Dialog } from './ui/Dialog';
import { Textarea } from './ui/Textarea';
import './SettingsChange.css';
import './ProjectReopen.css';

/**
 * A PROJECT_REOPEN owner request (docs/project-reopen-request-design.md §6.1, board 1 frame ②): the confirmation-card
 * look, as SETTINGS_CHANGE is — the title, when the project was settled with a link to it, the agent's reason, the
 * planned work under its own label, and two buttons: Reopen (Enter), which is the owner's
 * `POST /owner-requests/:id/reopen-project`, and Chat about this, which declines it with the reason typed. There is no
 * Always allow: every reopen asks. `viewedFromSessionId` is the conversation drawing it; outside the asking session
 * the card names who asked.
 */
export function ProjectReopenCard({ request, viewedFromSessionId }: {
  request: OwnerRequest;
  viewedFromSessionId?: string | null;
}): JSX.Element {
  const qc = useQueryClient();
  const anchor = useRef<HTMLDivElement>(null);
  const payload = projectReopenPayloadOf(request.payload);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const settle = () => {
    void qc.invalidateQueries({ queryKey: ['owner-requests'] });
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const reopen = useMutation({
    mutationFn: () =>
      api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/reopen-project`, { method: 'POST' }),
    onSettled: settle,
  });
  const decline = useMutation({
    mutationFn: (why: string) =>
      api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/decline`, { method: 'POST', body: { reason: why } }),
    onSettled: settle,
  });
  const answerable = !reopen.isPending && !decline.isPending && !declining;
  const keys = useDecisionCardKeys({ confirmEnabled: answerable, onConfirm: () => reopen.mutate(), anchor });

  if (reopen.data) return <ProjectReopenFolded request={reopen.data} />;
  if (decline.data) return <ProjectReopenFolded request={decline.data} />;

  const title = projectReopenProjectTitle(request);
  const asked = askerLine(request, viewedFromSessionId);
  const failure = (reopen.error ?? decline.error) as Error | null;
  return (
    <div ref={anchor} className="approval-card settings-change-card project-reopen-card" id={`owner-request-${request.id}`} data-kind="PROJECT_REOPEN">
      <div className="approval-head">{COPY.heading(title)}</div>
      <div className="approval-body is-plan settings-change-body">
        {payload ? (
          <div className="project-reopen-since">
            <span>
              {payload.statusAtAsk === 'CANCELLED'
                ? COPY.cancelledSince(settledDate(payload.settledAt))
                : COPY.doneSince(settledDate(payload.settledAt))}
            </span>
            <span className="settings-change-sep" aria-hidden="true">·</span>
            <AppLink to={`/projects/${encodeURIComponent(encodeId(payload.projectId))}`}>{COPY.openProject}</AppLink>
          </div>
        ) : null}
        {request.why ? <p className="settings-change-why">{COPY.agentSays(request.why)}</p> : null}
        {payload?.plannedWork ? (
          <>
            <div className="project-reopen-label">{COPY.plannedWork}</div>
            <p className="project-reopen-planned">{payload.plannedWork}</p>
          </>
        ) : null}
        <p className="settings-change-foot">{COPY.foot}</p>
        {asked ? <p className="settings-change-foot project-reopen-asked">{asked}</p> : null}
      </div>
      {failure ? <Alert type="error" title="That was not recorded" description={failure.message} /> : null}
      {declining ? (
        <div className="settings-change-decline">
          <Textarea
            value={reason}
            maxLength={2000}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={COPY.declinePlaceholder}
            aria-label="Reason for declining"
            onChange={(event) => setReason(event.target.value)}
          />
          <CardActions className="approval-actions">
            <CardActionButton
              tone="primary"
              disabled={!reason.trim() || decline.isPending}
              onClick={() => decline.mutate(reason.trim())}
            >
              {COPY.decline}
            </CardActionButton>
            <CardActionButton onClick={() => setDeclining(false)}>{COPY.keep}</CardActionButton>
          </CardActions>
        </div>
      ) : (
        <CardActions className="approval-actions">
          <CardActionButton tone="primary" disabled={!answerable} onClick={() => reopen.mutate()}>
            {COPY.reopen}
            {keys && <span className="approval-kbd">{ENTER_HINT}</span>}
          </CardActionButton>
          <CardActionButton disabled={!answerable} onClick={() => setDeclining(true)}>
            {COPY.chat}
          </CardActionButton>
        </CardActions>
      )}
    </div>
  );
}

/** An answered PROJECT_REOPEN card, folded to one line (board 2 frame ⑤): `Reopened “X” · time` or `Declined: reason`. */
export function ProjectReopenFolded({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  if (request.state === 'DECLINED') {
    return (
      <div className="settings-change-folded is-declined" id={`owner-request-${request.id}`} data-kind="PROJECT_REOPEN">
        <span>{COPY.declined(request.resolutionNote)}</span>
      </div>
    );
  }
  const when = request.resolvedAt ? decisionReceiptTime(request.resolvedAt, new Date(now)) : null;
  return (
    <div className="settings-change-folded is-done" id={`owner-request-${request.id}`} data-kind="PROJECT_REOPEN">
      <span>{`↺ ${COPY.reopened(projectReopenProjectTitle(request), when)}`}</span>
    </div>
  );
}

/**
 * The project page's row above the DONE header (board 2 frame ③): one line, who asked, and Review, which opens the
 * same card. Draws nothing while no request waits. The card is drawn once in this view: here, in the dialog.
 */
export function ProjectReopenRow({ projectId }: { projectId: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const requests = useQuery(ownerRequestsQuery('open'));
  const waiting = waitingReopenRequests(requests.data?.requests ?? [], projectId);
  if (waiting.length === 0) return null;
  const request = waiting[0];
  return (
    <>
      <div className="project-reopen-row" data-project-block="reopen-request">
        <div className="project-reopen-row-text">
          <span className="project-reopen-row-title">{COPY.rowTitle}</span>
          <span className="project-reopen-row-asked">{askerLine(request) ?? ''}</span>
        </div>
        <button type="button" className="project-reopen-review" onClick={() => setOpen(true)}>{COPY.review}</button>
      </div>
      <Dialog open={open} title={COPY.reviewTitle} onClose={() => setOpen(false)}>
        <ProjectReopenCard request={request} />
      </Dialog>
    </>
  );
}
