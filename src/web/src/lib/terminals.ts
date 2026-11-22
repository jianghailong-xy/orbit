import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { fullDate, untilLine } from './accessTokens';
import { routeId } from './idCodec';
import { streamPoll } from './listBudget';
import { ago } from './watches';

/**
 * The owner's terminals (docs/terminal-session-design.md, "The terminal credential"): a machine where
 * `orbit` asks to be approved, the card that approves it, and its machine's Terminals section with Revoke. The
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
  'It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it on this machine\'s page in Settings.';
export const DENY = 'Deny';
export const APPROVE = 'Approve';

/** "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye. */
export const terminalRequestLine = (machineName: string, code: string): string =>
  `Terminal on ${machineName} · code ${code}`;

export const TERMINALS_TITLE = 'Terminals';
export const TERMINALS_HINT =
  'Terminals where you typed orbit and approved it. Each one can start sessions on its machine and answer their approval cards until it expires.';
export const NO_TERMINALS = 'No terminals are signed in.';
/** The machine page's Terminals section (docs/mocks/terminals-on-machine-page/01-board.html ②). */
export const MACHINE_TERMINALS_HINT =
  'Terminals on this machine where you typed orbit and approved it. Each one can start sessions here and answer their approval cards until it expires.';
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
    meta: { entities: ['terminal'] },
    queryFn: () => api<{ requests: TerminalRequest[] }>('/terminals/requests'),
    refetchInterval: streamPoll(20_000),
    retry: false,
  });

/** The account's live terminals, which each machine page filters to its own. */
export const terminalsQuery = () =>
  queryOptions({
    queryKey: ['terminals', 'list'] as const,
    meta: { entities: ['terminal'] },
    queryFn: () => api<{ terminals: Terminal[] }>('/terminals'),
    retry: false,
  });

/** One machine's terminals, newest approval first (board ②). */
export const machineTerminals = (terminals: readonly Terminal[], runnerId: string): Terminal[] =>
  terminals
    .filter((terminal) => routeId(terminal.runnerId) === routeId(runnerId))
    .sort((a, b) => Date.parse(b.approvedAt) - Date.parse(a.approvedAt) || b.id.localeCompare(a.id));

/* ── Where a waiting terminal is drawn (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html) ──────────────
   The card lives on its machine's page, under the title; the session list's Needs you row points at it. */

/** The machine page's section of approve cards, and its note. */
export const TERMINALS_TO_APPROVE = 'Terminals to approve';
export const TERMINAL_REQUEST_LASTS = 'A request lasts 10 minutes';
/** The anchor the Needs you row and its link land on. */
export const TERMINAL_REQUESTS_ANCHOR = 'terminal-requests';
/** What a press says once the server recorded it (board ② choice 3). */
export const TERMINAL_APPROVED = 'Terminal approved';
export const TERMINAL_DENIED = 'Terminal denied';
/** The session list's section over the row. */
export const TERMINALS_NEEDS_YOU = 'Needs you';

/**
 * The requests still answerable at `now`, oldest first: the server's own rule (`expiresAt > now`), so a card
 * folds at its deadline rather than at the next read (board ② choice 4). The server's 404 stays the fallback.
 */
export const liveTerminalRequests = (requests: readonly TerminalRequest[], now: number): TerminalRequest[] =>
  requests
    .filter((request) => Date.parse(request.expiresAt) > now)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));

/** "Approve a terminal", or "Approve 2 terminals" (board ③ choice 5). */
export const approveTerminalsTitle = (count: number): string =>
  count === 1 ? 'Approve a terminal' : `Approve ${count} terminals`;

/**
 * The Needs you row's second line: one request names its machine and code ("dev-laptop · code 7KQ-4MZ"); several
 * on one machine count ("dev-laptop · 2 waiting"); several machines are named, oldest first ("dev-laptop, build-box").
 */
export function terminalsNeedsYouDetail(requests: readonly TerminalRequest[]): string {
  if (requests.length === 1) return `${requests[0].machineName} · code ${requests[0].userCode}`;
  const machines = [...new Set(requests.map((request) => request.machineName))];
  return machines.length === 1 ? `${machines[0]} · ${requests.length} waiting` : machines.join(', ');
}

/** Where the row and its link land: the oldest request's machine page, on the section. */
export const terminalRequestsPath = (runnerId: string): string =>
  `/settings/machines/${runnerId}#${TERMINAL_REQUESTS_ANCHOR}`;
