// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineTerminalsSection, TerminalRequestsSection, TerminalsNeedsYouRow } from '../components/TerminalRequests';
import { resetSnoozesForTest } from '../lib/ownerRequests';
import { fullDate, untilLine } from '../lib/accessTokens';
import { ago } from '../lib/watches';
import type { Terminal, TerminalRequest } from '../lib/terminals';

/**
 * The approve-terminal card (docs/terminal-session-design.md, board 2 marker 7) on its machine's page, the session
 * list's Needs you row that opens it (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html), and the machine
 * page's approved Terminals with Revoke (docs/mocks/terminals-on-machine-page/01-board.html).
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
/** Approved after LAPTOP on the same machine: listed above it. */
const LAPTOP_NEW: Terminal = {
  id: 'term3', machineName: 'dev-laptop', runnerId: 'run1', createdAt: at(-DAY), approvedAt: at(-DAY), lastUsedAt: null,
  expiresAt: at(29 * DAY),
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
      if (path.endsWith('/approve')) {
        terminals = [...terminals, { ...LAPTOP, id: 'term4', approvedAt: at(0), lastUsedAt: null, expiresAt: at(30 * DAY) }];
      }
      return { id: REQUEST.id, status: path.endsWith('/approve') ? 'APPROVED' : 'DENIED' } as never;
    }
    if (method === 'DELETE' && path.startsWith('/terminals/')) {
      const id = path.slice('/terminals/'.length);
      terminals = terminals.filter((terminal) => terminal.id !== id);
      return { id } as never;
    }
    if (path === '/projects/sidebar') return [] as never;
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

/** Where the app is: the path and hash a press navigated to. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.hash}</output>;
}

async function render(element: JSX.Element, at = '/') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[at]}>
          <Routes><Route path="*" element={<>{element}<Where /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
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

const where = () => host.querySelector('[data-testid="where"]')?.textContent;
const titles = () => [...host.querySelectorAll('.owner-request-card[data-kind="TERMINAL"] .owner-request-why p:first-child')]
  .map((p) => p.textContent);

describe('the machine page\'s Terminals to approve', () => {
  it('draws the card unchanged under its own heading, for this machine only', async () => {
    requests = [REQUEST, { ...REQUEST, id: 'req9', machineName: 'build-box', runnerId: 'run2', userCode: 'ZZZ-111' }];
    await render(<TerminalRequestsSection runnerId="run1" />);
    const section = host.querySelector<HTMLElement>('#terminal-requests');
    expect(section?.querySelector('.settings-section-title')?.textContent).toBe('Terminals to approve');
    expect(section?.querySelector('.machine-section-note')?.textContent).toBe('A request lasts 10 minutes');
    const cards = section!.querySelectorAll<HTMLElement>('.owner-request-card[data-kind="TERMINAL"]');
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.querySelector('.owner-request-waiting')?.textContent).toBe('Waiting on you');
    expect(card.querySelector('.owner-request-title')?.textContent).toBe('Approve a terminal?');
    expect([...card.querySelectorAll('.owner-request-why p')].map((p) => p.textContent)).toEqual([
      'Terminal on dev-laptop · code 7KQ-4MZ',
      'It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it on this machine\'s page in Settings.',
    ]);
    expect([...card.querySelectorAll('.card-actions button')].map((b) => b.textContent)).toEqual(['Deny', 'Approve']);
  });

  it('draws nothing at all when no request waits on this machine', async () => {
    requests = [{ ...REQUEST, runnerId: 'run2' }];
    await render(<TerminalRequestsSection runnerId="run1" />);
    expect(host.querySelector('#terminal-requests')).toBeNull();
    expect(host.textContent).not.toContain('Terminals to approve');
  });

  it('lists several oldest first', async () => {
    requests = [{ ...REQUEST, id: 'req2', userCode: 'R2T-9PX', createdAt: at(-30_000) }, REQUEST];
    await render(<TerminalRequestsSection runnerId="run1" />);
    expect(titles()).toEqual(['Terminal on dev-laptop · code 7KQ-4MZ', 'Terminal on dev-laptop · code R2T-9PX']);
  });

  it('Approve posts the decision, says so, and the section folds once the requests are read again', async () => {
    await render(<TerminalRequestsSection runnerId="run1" />);
    await click(button(host, 'Approve'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/requests/req1/approve', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Terminal approved');
    await vi.waitFor(() => expect(host.querySelector('#terminal-requests')).toBeNull());
  });

  it('Deny posts the other decision and says so', async () => {
    await render(<TerminalRequestsSection runnerId="run1" />);
    await click(button(host, 'Deny'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/requests/req1/deny', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Terminal denied');
    await vi.waitFor(() => expect(host.querySelector('[data-kind="TERMINAL"]')).toBeNull());
  });

  it('a refusal keeps the card and says what the server said', async () => {
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if ((options?.method ?? 'GET') === 'POST') {
        throw new Error('terminal sign-in not found or expired — run `orbit` in the terminal again');
      }
      if (path === '/terminals/requests') return { requests } as never;
      throw new Error(`unexpected ${path}`);
    });
    await render(<TerminalRequestsSection runnerId="run1" />);
    await click(button(host, 'Approve'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(host.querySelector('[data-kind="TERMINAL"]')?.textContent).toContain('That was not recorded');
    expect(host.querySelector('[data-kind="TERMINAL"]')?.textContent).toContain('run `orbit` in the terminal again');
  });

  it('folds a card at its deadline without another read', async () => {
    requests = [{ ...REQUEST, expiresAt: at(150) }];
    await render(<TerminalRequestsSection runnerId="run1" />);
    expect(host.querySelector('[data-kind="TERMINAL"]')).not.toBeNull();
    const reads = apiMock.mock.calls.length;
    await vi.waitFor(() => expect(host.querySelector('#terminal-requests')).toBeNull(), { timeout: 2000 });
    expect(apiMock.mock.calls.length).toBe(reads);
  });

  it('opened on #terminal-requests, it lights the oldest card', async () => {
    requests = [REQUEST, { ...REQUEST, id: 'req2', createdAt: at(-10_000) }];
    await render(<TerminalRequestsSection runnerId="run1" />, '/settings/machines/run1#terminal-requests');
    const cards = [...host.querySelectorAll('[data-kind="TERMINAL"]')];
    expect(cards.map((card) => card.classList.contains('is-lit'))).toEqual([true, false]);
  });

  it('opened plainly, nothing is lit', async () => {
    await render(<TerminalRequestsSection runnerId="run1" />, '/settings/machines/run1');
    expect(host.querySelector('.is-lit')).toBeNull();
  });
});

describe('the session list\'s Needs you row', () => {
  const row = () => host.querySelector<HTMLElement>('.terminal-needs-you');

  it('says one terminal, its machine and code, and opens its machine page on the section', async () => {
    await render(<TerminalsNeedsYouRow />);
    expect(row()?.querySelector('.session-section-head')?.textContent).toBe('Needs you');
    expect(row()?.querySelector('.session-project-merge-row-title')?.textContent).toBe('Approve a terminal');
    expect(row()?.querySelector('.session-project-merge-row-detail')?.textContent).toBe('dev-laptop · code 7KQ-4MZ');
    await click(row()?.querySelector('button'));
    expect(where()).toBe('/settings/machines/run1#terminal-requests');
  });

  it('counts several on one machine, and names several machines', async () => {
    requests = [REQUEST, { ...REQUEST, id: 'req2', createdAt: at(-10_000) }];
    await render(<TerminalsNeedsYouRow />);
    expect(row()?.querySelector('.session-project-merge-row-title')?.textContent).toBe('Approve 2 terminals');
    expect(row()?.querySelector('.session-project-merge-row-detail')?.textContent).toBe('dev-laptop · 2 waiting');
    act(() => root?.unmount());
    host.remove();
    requests = [{ ...REQUEST, id: 'req3', machineName: 'build-box', runnerId: 'run2', createdAt: at(-5 * MINUTE) }, REQUEST];
    await render(<TerminalsNeedsYouRow />);
    expect(row()?.querySelector('.session-project-merge-row-detail')?.textContent).toBe('build-box, dev-laptop');
    await click(row()?.querySelector('button'));
    expect(where()).toBe('/settings/machines/run2#terminal-requests');
  });

  it('is not drawn when nothing waits, or what waited has expired', async () => {
    requests = [{ ...REQUEST, expiresAt: at(-1) }];
    await render(<TerminalsNeedsYouRow />);
    expect(row()).toBeNull();
  });
});

describe('the machine page\'s Terminals', () => {
  const rows = () => [...host.querySelectorAll<HTMLElement>('.machine-section-terminals .settings-row')];
  const read = () => rows().map((row) => [
    row.dataset.settingAnchor,
    row.querySelector('.settings-row-title')?.textContent,
    row.querySelector('.settings-row-description')?.textContent,
    row.querySelector('button')?.textContent,
  ]);

  it('lists this machine\'s approved terminals newest first: approved, last used · expires, and Revoke', async () => {
    terminals = [LAPTOP, HPC, LAPTOP_NEW];
    await render(<MachineTerminalsSection runnerId="run1" />);
    const now = Date.now();
    const section = host.querySelector<HTMLElement>('.machine-section-terminals')!;
    expect(section.querySelector('.settings-section-title')?.textContent).toBe('Terminals');
    expect(section.textContent).toContain(
      'Terminals on this machine where you typed orbit and approved it. Each one can start sessions here and answer their approval cards until it expires.',
    );
    expect(read()).toEqual([
      ['terminal-term3', `Approved ${fullDate(LAPTOP_NEW.approvedAt)}`,
        `Never used · Expires ${fullDate(LAPTOP_NEW.expiresAt)} · ${untilLine(LAPTOP_NEW.expiresAt, now)}`, 'Revoke'],
      ['terminal-term1', `Approved ${fullDate(LAPTOP.approvedAt)}`,
        `Last used ${ago(LAPTOP.lastUsedAt, now)} · Expires ${fullDate(LAPTOP.expiresAt)} · ${untilLine(LAPTOP.expiresAt, now)}`, 'Revoke'],
    ]);
  });

  it('draws nothing at all when the machine has no approved terminal', async () => {
    terminals = [HPC];
    await render(<MachineTerminalsSection runnerId="run1" />);
    expect(host.querySelector('.machine-section-terminals')).toBeNull();
    expect(host.textContent).not.toContain('Terminals');
  });

  it('Revoke asks, deletes the terminal, says so, and the row leaves; the last one takes the section with it', async () => {
    await render(<MachineTerminalsSection runnerId="run1" />);
    const laptop = host.querySelector('[data-setting-anchor="terminal-term1"]')!;
    await click(button(laptop, 'Revoke'));
    expect(apiMock).not.toHaveBeenCalledWith('/terminals/term1', { method: 'DELETE' });
    const asked = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (d) => document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent === 'Revoke the terminal on dev-laptop?',
    );
    expect(asked).toBeTruthy();
    expect(asked!.textContent).toContain('It stops working at once. Typing orbit there asks you to approve it again.');
    await click(button(asked!, 'Revoke'));
    expect(apiMock).toHaveBeenCalledWith('/terminals/term1', { method: 'DELETE' });
    expect(toast.success).toHaveBeenCalledWith('Terminal revoked');
    await vi.waitFor(() => expect(host.querySelector('.machine-section-terminals')).toBeNull());
  });

  it('a refused Revoke keeps the row and says what the server said', async () => {
    const answer = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') throw new Error('Terminal not found');
      return answer(path, options as never);
    });
    await render(<MachineTerminalsSection runnerId="run1" />);
    await click(button(host.querySelector('[data-setting-anchor="terminal-term1"]')!, 'Revoke'));
    const asked = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
    await click(button(asked, 'Revoke'));
    expect(toast.error).toHaveBeenCalledWith("Couldn't revoke the terminal", 'Terminal not found');
    expect(host.querySelector('[data-setting-anchor="terminal-term1"]')).not.toBeNull();
  });

  it('approving a card on the page puts its terminal at the top of the list', async () => {
    terminals = [];
    await render(<><TerminalRequestsSection runnerId="run1" /><MachineTerminalsSection runnerId="run1" /></>);
    expect(host.querySelector('.machine-section-terminals')).toBeNull();
    await click(button(host, 'Approve'));
    await vi.waitFor(() => expect(read().map((row) => row[0])).toEqual(['terminal-term4']));
    expect(host.querySelector('#terminal-requests')).toBeNull();
  });
});
