import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { WAITING_ON_YOU } from '../lib/ownerRequests';
import {
  APPROVE,
  APPROVE_TERMINAL_DETAIL,
  APPROVE_TERMINAL_TITLE,
  DENY,
  TERMINAL_APPROVED,
  TERMINAL_DENIED,
  terminalRequestLine,
  type TerminalRequest,
} from '../lib/terminals';
import { useToast } from '../lib/toast';
import { ago } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { Alert } from './ui/Alert';
import './OwnerRequest.css';

/**
 * A terminal asking to be approved (docs/terminal-session-design.md, board 2 marker 7), drawn as the owner request
 * card is: the same frame, header and action row, no look of its own. Approve mints the terminal's credential for 30
 * days; Deny tells the terminal so. Either way the request leaves the list it was read from, and a short toast
 * says it was recorded: on the machine page's long list a card that just goes reads as a press that missed (board
 * 02 ②). [lit]: opened from the Needs you row, the card is outlined for a moment.
 */
export function TerminalApproveCard({ request, now = Date.now(), lit = false }: {
  request: TerminalRequest;
  now?: number;
  lit?: boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const message = useToast();
  const decide = useMutation({
    mutationFn: (to: 'approve' | 'deny') =>
      api(`/terminals/requests/${encodeURIComponent(request.id)}/${to}`, { method: 'POST' }),
    onSuccess: (_answer, to) => message.success(to === 'approve' ? TERMINAL_APPROVED : TERMINAL_DENIED),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['terminals'] });
    },
  });
  return (
    <section className={`owner-request-card${lit ? ' is-lit' : ''}`} id={`terminal-request-${request.id}`} data-kind="TERMINAL">
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
