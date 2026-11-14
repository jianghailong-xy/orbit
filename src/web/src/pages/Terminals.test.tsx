// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitingOnYouPage } from './WaitingOnYouPage';
import { TerminalsPage } from './TerminalsPage';
import { resetSnoozesForTest } from '../lib/ownerRequests';
import { fullDate, untilLine } from '../lib/accessTokens';
import { ago } from '../lib/watches';
import type { Terminal, TerminalRequest } from '../lib/terminals';

/**
 * The approve-terminal card (docs/terminal-session-design.md, board 2 marker 7) where the owner's other cards are —
 * the Waiting on you inbox and its count — and Settings → Terminals with Revoke.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const REQUEST: TerminalRequest = {
  id: 'req1', userCode: '7KQ-4MZ', machineName: 'dev-laptop', runnerId: 'run1', createdAt: at(-MINUTE), expiresAt: at(9 * MINUTE),
};

const LAPTOP: Terminal = {
  id: 'term1', machineName: 'dev-laptop', runnerId: 'run1', createdAt: at(-2 * DAY), approvedAt: at(-2 * DAY),
  lastUsedAt: at(-3 * MINUTE), expiresAt: at(28 * DAY),
};
const HPC: Terminal = {
  id: 'term2', machineName: 'HPC', runnerId: 'run2', createdAt: at(-DAY), approvedAt: at(-DAY), lastUsedAt: null, expiresAt: at(29 * DAY),
};

let requests: TerminalRequest[] = [];
let terminals: Terminal[] = [];

beforeEach(() => {
  localStorage.clear();
  resetSnoozesForTest();
  toast.success.mockReset();
  toast.error.mockReset();
  requests = [REQUEST];
  terminals = [LAPTOP, HPC];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (path === '/terminals/requests') return { requests } as never;
    if (path === '/terminals') return { terminals } as never;
    if (method === 'POST' && path.startsWith('/terminals/requests/')) {
      requests = [];
      return { id: REQUEST.id, status: path.endsWith('/approve') ? 'APPROVED' : 'DENIED' } as never;
    }
    if (method === 'DELETE' && path.startsWith('/terminals/')) {
      const id = path.slice('/terminals/'.length);
      terminals = terminals.filter((terminal) => terminal.id !== id);
      return { id } as never;
    }
    if (path === '/projects/sidebar') return [] as never;
    if (path.startsWith('/owner-requests')) return { requests: [] } as never;
    throw new Error(`unexpected ${method} ${path}`);
  });
});

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

async function render(element: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

const button = (within: ParentNode, label: string) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label);

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('the approve-terminal card', () => {
  it('is in the Open inbox for a pending request, in the owner card frame, and counted', async () => {
    await render(<WaitingOnYouPage />);
    const card = host.querySelector<HTMLElement>('.owner-request-card[data-kind="TERMINAL"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.owner-request-waiting')?.textContent).toBe('Waiting on you');
    expect(card!.querySelector('.owner-request-title')?.textContent).toBe('Approve a terminal?');
    expect([...card!.querySelectorAll('.owner-request-why p')].map((p) => p.textContent)).toEqual([
      'Terminal on dev-laptop · code 7KQ-4MZ',
      'It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it in Settings → Terminals.',
    ]);
    expect([...card!.querySelectorAll('.card-actions button')].map((b) => b.textContent)).toEqual(['Deny', 'Approve']);
    expect(host.querySelector('.owner-inbox-count')?.textContent).toBe('1');
    expect(host.querySelector('.owner-inbox-empty')).toBeNull();
  });

  it('Approve posts the decision and the card leaves once the requests are read again', async () => {
    await render(<WaitingOnYouPage />);
    await click(button(host, 'Approve'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/requests/req1/approve', { method: 'POST' });
    await vi.waitFor(() => expect(host.querySelector('[data-kind="TERMINAL"]')).toBeNull());
    expect(host.querySelector('.owner-inbox-empty')?.textContent).toBe('Nothing is waiting on you.');
  });

  it('Deny posts the other decision', async () => {
    await render(<WaitingOnYouPage />);
    await click(button(host, 'Deny'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/requests/req1/deny', { method: 'POST' });
    await vi.waitFor(() => expect(host.querySelector('[data-kind="TERMINAL"]')).toBeNull());
  });

  it('draws nothing when no request is pending', async () => {
    requests = [];
    await render(<WaitingOnYouPage />);
    expect(host.querySelector('[data-kind="TERMINAL"]')).toBeNull();
  });
});

describe('Settings → Terminals', () => {
  it('lists each live terminal: machine, approved, last used, expires, and Revoke', async () => {
    await render(<TerminalsPage />);
    const now = Date.now();
    const rows = [...host.querySelectorAll('.terminals-row')];
    expect(rows.map((row) => [...row.querySelectorAll('.terminals-machine, .terminals-sub, button')].map((n) => n.textContent))).toEqual([
      ['dev-laptop', `Approved ${fullDate(LAPTOP.approvedAt)}`, `Last used ${ago(LAPTOP.lastUsedAt, now)}`,
        `Expires ${fullDate(LAPTOP.expiresAt)} · ${untilLine(LAPTOP.expiresAt, now)}`, 'Revoke'],
      ['HPC', `Approved ${fullDate(HPC.approvedAt)}`, 'Never used', `Expires ${fullDate(HPC.expiresAt)} · ${untilLine(HPC.expiresAt, now)}`, 'Revoke'],
    ]);
  });

  it('Revoke asks, deletes the terminal, and the list no longer shows it', async () => {
    await render(<TerminalsPage />);
    const laptop = host.querySelector('[data-testid="terminal-term1"]')!;
    await click(button(laptop, 'Revoke'));
    expect(apiMock).not.toHaveBeenCalledWith('/terminals/term1', { method: 'DELETE' });
    const asked = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (d) => document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent === 'Revoke the terminal on dev-laptop?',
    );
    expect(asked).toBeTruthy();
    await click(button(asked!, 'Revoke'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/term1', { method: 'DELETE' });
    expect(toast.success).toHaveBeenCalledWith('Terminal revoked');
    await vi.waitFor(() => expect(host.querySelector('[data-testid="terminal-term1"]')).toBeNull());
    expect([...host.querySelectorAll('.terminals-machine')].map((n) => n.textContent)).toEqual(['HPC']);
  });

  it('says so when no terminal is signed in', async () => {
    terminals = [];
    await render(<TerminalsPage />);
    expect(host.querySelector('.terminals-empty')?.textContent).toBe('No terminals are signed in.');
  });
});
