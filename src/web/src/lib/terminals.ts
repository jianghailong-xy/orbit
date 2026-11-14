import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { fullDate, untilLine } from './accessTokens';
import { streamPoll } from './listBudget';
import { ago } from './watches';

/**
 * The owner's terminals (docs/terminal-session-design.md, "The terminal credential"): a machine where
 * `orbit` asks to be approved, the card that approves it, and Settings → Terminals with Revoke. The
 * words here are the clients' one copy; the phones read them back (`TerminalsCopyParityTests`,
 * Android's `TerminalsCopyTest`).
 */

/** A terminal sign-in waiting for the owner: what the approve card shows. `GET /terminals/requests`. */
export interface TerminalRequest {
  id: string;
  userCode: string;
  machineName: string;
  runnerId: string;
  createdAt: string;
  expiresAt: string;
}

/** A live terminal: approved, not revoked, not expired. `GET /terminals`. */
export interface Terminal {
  id: string;
  machineName: string;
  runnerId: string;
  createdAt: string;
  approvedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export const APPROVE_TERMINAL_TITLE = 'Approve a terminal?';
export const APPROVE_TERMINAL_DETAIL =
  'It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it in Settings → Terminals.';
export const DENY = 'Deny';
export const APPROVE = 'Approve';

/** "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye. */
export const terminalRequestLine = (machineName: string, code: string): string =>
  `Terminal on ${machineName} · code ${code}`;

export const TERMINALS_TITLE = 'Terminals';
export const TERMINALS_HINT =
  'Terminals where you typed orbit and approved it. Each one can start sessions on its machine and answer their approval cards until it expires.';
export const NO_TERMINALS = 'No terminals are signed in.';
export const REVOKE = 'Revoke';
export const REVOKE_TERMINAL_DETAIL =
  'It stops working at once. Typing orbit there asks you to approve it again.';

/** "Revoke the terminal on dev-laptop?" */
export const revokeTerminalTitle = (machineName: string): string => `Revoke the terminal on ${machineName}?`;

/** "Approved Nov 12, 2026" */
export const approvedLine = (terminal: Pick<Terminal, 'approvedAt'>): string => `Approved ${fullDate(terminal.approvedAt)}`;

/** "Last used 3h ago", or "Never used". */
export const lastUsedLine = (terminal: Pick<Terminal, 'lastUsedAt'>, now: number): string =>
  terminal.lastUsedAt ? `Last used ${ago(terminal.lastUsedAt, now)}` : 'Never used';

/** "Expires Dec 12, 2026 · in 30 days" */
export const expiresLine = (terminal: Pick<Terminal, 'expiresAt'>, now: number): string =>
  `Expires ${fullDate(terminal.expiresAt)} · ${untilLine(terminal.expiresAt, now)}`;

/** The approve card's read. A server that predates terminals answers 404: no cards, not an error. */
export const terminalRequestsQuery = () =>
  queryOptions({
    queryKey: ['terminals', 'requests'] as const,
    queryFn: () => api<{ requests: TerminalRequest[] }>('/terminals/requests'),
    refetchInterval: streamPoll(20_000),
    retry: false,
  });

/** Settings → Terminals. */
export const terminalsQuery = () =>
  queryOptions({
    queryKey: ['terminals', 'list'] as const,
    queryFn: () => api<{ terminals: Terminal[] }>('/terminals'),
    retry: false,
  });
