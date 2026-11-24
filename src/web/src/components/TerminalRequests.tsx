import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useLocation, useNavigate } from 'react-router-dom';
import { routeId } from '../lib/idCodec';
import {
  MACHINE_TERMINALS_HINT,
  REVOKE,
  REVOKE_TERMINAL_DETAIL,
  TERMINALS_TITLE,
  TERMINAL_REQUESTS_ANCHOR,
  TERMINAL_REQUEST_LASTS,
  TERMINALS_NEEDS_YOU,
  TERMINALS_TO_APPROVE,
  approveTerminalsTitle,
  approvedLine,
  expiresLine,
  lastUsedLine,
  liveTerminalRequests,
  machineTerminals,
  revokeTerminalTitle,
  terminalRequestsPath,
  terminalRequestsQuery,
  terminalsNeedsYouDetail,
  terminalsQuery,
  type Terminal,
  type TerminalRequest,
} from '../lib/terminals';
import { useToast } from '../lib/toast';
import { ago } from '../lib/watches';
import { SettingsCard, SettingsRow, SettingsSection } from './settings/SettingsBlocks';
import { TerminalApproveCard } from './TerminalApproveCard';
import { Button } from './ui/Button';
import { Popconfirm } from './ui/Popconfirm';

/*
 * Where a terminal asking to be approved is drawn (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html):
 * its machine's page, in a section under the title, and a Needs you row at the top of the session list that opens
 * that section. The card and what its buttons do are main's TerminalApproveCard, unchanged.
 */

/** How long the Needs you row lights the card it opened (the settings search's flash). */
const FLASH_MS = 2000;

/** The requests still answerable now, oldest first, drawn again at the next deadline so a card folds on time. */
export function useLiveTerminalRequests(): TerminalRequest[] {
  const requests = useQuery(terminalRequestsQuery()).data?.requests ?? [];
  const [now, setNow] = useState(() => Date.now());
  const live = liveTerminalRequests(requests, now);
  const next = Math.min(...live.map((request) => Date.parse(request.expiresAt)));
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  return live;
}

/**
 * The machine page's "Terminals to approve": one card per request on this machine, oldest first. Nothing at all
 * when none waits (no heading over an empty section). Opened at `#terminal-requests`, it scrolls into view and the
 * oldest card is lit for a moment.
 */
export function TerminalRequestsSection({ runnerId }: { runnerId: string }): JSX.Element | null {
  const requests = useLiveTerminalRequests().filter((request) => routeId(request.runnerId) === routeId(runnerId));
  const { hash, key } = useLocation();
  const wanted = hash === `#${TERMINAL_REQUESTS_ANCHOR}`;
  const first = requests[0]?.id;
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || !first) return undefined;
    document.getElementById(TERMINAL_REQUESTS_ANCHOR)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    setLit(first);
    const unlight = setTimeout(() => setLit(null), FLASH_MS);
    return () => clearTimeout(unlight);
    // Once per arrival: a card that leaves does not light the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key, first != null]);
  if (requests.length === 0) return null;
  const now = Date.now();
  return (
    <div id={TERMINAL_REQUESTS_ANCHOR} className="machine-terminal-requests">
      <SettingsSection
        title={TERMINALS_TO_APPROVE}
        className="machine-section-terminal-requests"
        action={<span className="machine-section-note">{TERMINAL_REQUEST_LASTS}</span>}
      >
        <div className="machine-terminal-cards">
          {requests.map((request) => (
            <TerminalApproveCard key={request.id} request={request} now={now} lit={lit === request.id} />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}

/**
 * The machine page's Terminals (docs/mocks/terminals-on-machine-page/01-board.html ②③): this machine's approved
 * terminals, newest first, each with Revoke, which asks first. Nothing at all when the machine has none. A revoked
 * terminal leaves the list once it is read again; an approved card's terminal joins it the same way.
 */
export function MachineTerminalsSection({ runnerId }: { runnerId: string }): JSX.Element | null {
  const qc = useQueryClient();
  const message = useToast();
  const list = useQuery(terminalsQuery());
  const revoke = useMutation({
    mutationFn: (terminal: Terminal) => api(`/terminals/${encodeURIComponent(terminal.id)}`, { method: 'DELETE' }),
    onSuccess: () => message.success('Terminal revoked'),
    onError: (e: Error) => message.error("Couldn't revoke the terminal", e.message),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['terminals'] });
    },
  });
  const terminals = machineTerminals(list.data?.terminals ?? [], runnerId);
  if (terminals.length === 0) return null;
  const now = Date.now();
  return (
    <SettingsSection title={TERMINALS_TITLE} description={MACHINE_TERMINALS_HINT} className="machine-section-terminals">
      <SettingsCard>
        {terminals.map((terminal) => (
          <SettingsRow
            key={terminal.id}
            anchor={`terminal-${terminal.id}`}
            title={approvedLine(terminal)}
            description={`${lastUsedLine(terminal, now)} · ${expiresLine(terminal, now)}`}
            control={
              <Popconfirm
                trigger={
                  <Button size="small" danger loading={revoke.isPending && revoke.variables?.id === terminal.id}>
                    {REVOKE}
                  </Button>
                }
                title={revokeTerminalTitle(terminal.machineName)}
                description={REVOKE_TERMINAL_DETAIL}
                confirmText={REVOKE}
                danger
                cancelText="Cancel"
                onConfirm={() => revoke.mutate(terminal)}
              />
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * The session list's Needs you row: "Approve a terminal" over its machine and code, or "Approve 2 terminals" over
 * where they wait, and how long the oldest has waited. It opens the oldest one's machine page on its section.
 * Drawn in the shape of the project page's Landings row, not a look of its own.
 */
export function TerminalsNeedsYouRow(): JSX.Element | null {
  const requests = useLiveTerminalRequests();
  const navigate = useNavigate();
  if (requests.length === 0) return null;
  const oldest = requests[0];
  return (
    <section className="session-project-landings terminal-needs-you" aria-label={TERMINALS_NEEDS_YOU}>
      <div className="session-section-head">{TERMINALS_NEEDS_YOU}</div>
      <button
        type="button"
        className="session-row session-project-merge-row session-project-landing-row"
        data-terminal-requests={requests.length}
        onClick={() => navigate(terminalRequestsPath(routeId(oldest.runnerId) ?? oldest.runnerId))}
      >
        <span className="session-project-landing-mark terminal-needs-you-mark" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4" />
          </svg>
        </span>
        <span className="session-project-merge-row-body">
          <span className="session-project-merge-row-head">
            <span className="session-project-merge-row-title">{approveTerminalsTitle(requests.length)}</span>
            <span className="session-time">{ago(oldest.createdAt, Date.now())}</span>
          </span>
          <span className="session-project-merge-row-detail session-preview tone-approval">
            {terminalsNeedsYouDetail(requests)}
          </span>
        </span>
      </button>
    </section>
  );
}
