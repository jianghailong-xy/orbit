import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { WAITING_ON_YOU } from '../lib/ownerRequests';
import {
  APPROVE,
  APPROVE_TERMINAL_DETAIL,
  APPROVE_TERMINAL_TITLE,
  DENY,
  terminalRequestLine,
  type TerminalRequest,
} from '../lib/terminals';
import { ago } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { Alert } from './ui/Alert';
import './OwnerRequest.css';

/**
 * A terminal asking to be approved (docs/terminal-session-design.md, board 2 marker 7), drawn as the owner request
 * card is: the same frame, header and action row, no look of its own. Approve mints the terminal's credential for 30
 * days; Deny tells the terminal so. Either way the request leaves the list it was read from.
 */
export function TerminalApproveCard({ request, now = Date.now() }: { request: TerminalRequest; now?: number }): JSX.Element {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (to: 'approve' | 'deny') =>
      api(`/terminals/requests/${encodeURIComponent(request.id)}/${to}`, { method: 'POST' }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['terminals'] });
    },
  });
  return (
    <section className="owner-request-card" id={`terminal-request-${request.id}`} data-kind="TERMINAL">
      <header className="owner-request-head">
        <span className="owner-request-dot" aria-hidden="true" />
        <span className="owner-request-waiting">{WAITING_ON_YOU}</span>
        <span className="owner-request-age">{`Asked ${ago(request.createdAt, now)}`}</span>
      </header>
      <div className="owner-request-body">
        <div className="owner-request-title-row">
          <h3 className="owner-request-title">{APPROVE_TERMINAL_TITLE}</h3>
        </div>
        <div className="owner-request-why">
          <p>{terminalRequestLine(request.machineName, request.userCode)}</p>
          <p>{APPROVE_TERMINAL_DETAIL}</p>
        </div>
        {decide.isError ? (
          <Alert type="error" title="That was not recorded" description={(decide.error as Error).message} />
        ) : null}
        <CardActions className="owner-request-actions">
          <CardActionButton disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
            {DENY}
          </CardActionButton>
          <CardActionButton tone="primary" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
            {APPROVE}
          </CardActionButton>
        </CardActions>
      </div>
    </section>
  );
}
