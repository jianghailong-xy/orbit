import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { SettingsCard, SettingsHeader } from '../components/settings';
import { useToast } from '../lib/toast';
import {
  NO_TERMINALS,
  REVOKE,
  REVOKE_TERMINAL_DETAIL,
  TERMINALS_HINT,
  TERMINALS_TITLE,
  approvedLine,
  expiresLine,
  lastUsedLine,
  revokeTerminalTitle,
  terminalsQuery,
  type Terminal,
} from '../lib/terminals';
import { Button } from '../components/ui/Button';
import { Popconfirm } from '../components/ui/Popconfirm';

/**
 * Settings → Terminals (docs/terminal-session-design.md, "The terminal credential"): every live terminal, by its
 * machine, when it was approved, last used and when it expires, each with Revoke. A revoked terminal leaves the list.
 */
export function TerminalsPage(): JSX.Element {
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
  const now = Date.now();
  const terminals = list.data?.terminals ?? [];
  return (
    <div className="settings-page">
      <SettingsHeader title={TERMINALS_TITLE} description={TERMINALS_HINT} />
      {list.isSuccess && terminals.length === 0 ? <p className="terminals-empty">{NO_TERMINALS}</p> : null}
      {terminals.length > 0 ? (
        <SettingsCard>
        <ul className="terminals-list" aria-label={TERMINALS_TITLE}>
          {terminals.map((terminal) => (
            <li key={terminal.id} className="terminals-row" data-testid={`terminal-${terminal.id}`}>
              <div className="terminals-text">
                <div className="terminals-machine">{terminal.machineName}</div>
                <div className="terminals-sub">{approvedLine(terminal)}</div>
                <div className="terminals-sub">{lastUsedLine(terminal, now)}</div>
                <div className="terminals-sub">{expiresLine(terminal, now)}</div>
              </div>
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
            </li>
          ))}
        </ul>
        </SettingsCard>
      ) : null}
    </div>
  );
}
