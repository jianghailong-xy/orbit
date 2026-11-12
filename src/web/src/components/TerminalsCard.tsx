import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
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
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Popconfirm } from './ui/Popconfirm';

/**
 * Settings → Terminals (docs/terminal-session-design.md, "The terminal credential"): every live terminal, by its
 * machine, when it was approved, last used and when it expires, each with Revoke. A revoked terminal leaves the list.
 */
export function TerminalsCard(): JSX.Element {
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
    <Card title={TERMINALS_TITLE} style={{ marginTop: 16 }}>
      <p className="terminals-hint">{TERMINALS_HINT}</p>
      {list.isSuccess && terminals.length === 0 ? <p className="terminals-empty">{NO_TERMINALS}</p> : null}
      {terminals.length > 0 ? (
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
      ) : null}
    </Card>
  );
}
