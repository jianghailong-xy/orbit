// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineSecrets } from './MachineSecrets';
import type { SecretGrant } from '../../lib/accountSecrets';

/**
 * A machine page's "Secrets on this machine" (project "Secrets management page"): Settings → Secrets' On machines
 * now table filtered to the one runner, Revoke and Cancel from it, and nothing at all while the runner has no copy.
 */

vi.mock('../../api', () => ({ api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../../lib/toast', () => ({ useToast: () => toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HPC = { id: 'run1', name: 'HPC', online: true, lastHeartbeatAt: at(-20_000) };
const GPU = { id: 'run2', name: 'workstation-gpu', online: true, lastHeartbeatAt: at(-20_000) };

function grant(n: number, extra: Partial<SecretGrant>): SecretGrant {
  return {
    id: `g${n}`, requestId: `r${n}`, label: `Secret ${n}`, exposure: 'ENV', envName: `KEY_${n}`, filePath: null,
    runner: HPC, sessionId: uuid(n), sessionTitle: `Session ${n}`, taskId: null, taskTitle: null, taskScoped: false,
    state: 'ACTIVE', endReason: null, removalNote: null, createdAt: at(-10 * MINUTE), fetchedAt: null, deliveredAt: null,
    expiresAt: at(3 * DAY), removedAt: null, savedSecretId: null, deliveryHint: null,
    ...extra,
  };
}

const ACTIVE = grant(1, { label: 'QA GHP2 password', envName: 'QA_GHP2_PASSWORD' });
const WAITING = grant(2, { state: 'PENDING_DELIVERY', deliveryHint: { reason: 'NOT_FETCHED', since: at(-6 * MINUTE) } });
const REMOVED = grant(3, { label: 'Old token', state: 'REMOVED', endReason: 'TASK_ENDED', removedAt: at(-3 * DAY) });
const ELSEWHERE = grant(4, { label: 'DeepSeek API key', runner: GPU });

let grants: SecretGrant[] = [];

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (method === 'GET' && path === '/account-secrets/grants?removed=30d') return { grants } as never;
    if (method === 'POST' && path.startsWith('/account-secrets/grants/')) {
      const id = path.split('/')[3];
      grants = grants.map((g) => (g.id === id ? { ...g, state: 'REMOVING', endReason: 'REVOKED' } : g));
      return undefined as never;
    }
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

async function render(runnerId: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter><MachineSecrets runnerId={runnerId} /></MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

const rowIds = () => [...host.querySelectorAll('tr[data-grant]')].map((r) => r.getAttribute('data-grant'));
const row = (id: string) => host.querySelector<HTMLTableRowElement>(`tr[data-grant="${id}"]`);
const button = (within: ParentNode | null, label: string) =>
  [...(within?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('Machine page: Secrets on this machine', () => {
  it("lists only this runner's copies, live first, removed behind the toggle, and links to Settings → Secrets", async () => {
    grants = [ACTIVE, WAITING, REMOVED, ELSEWHERE];
    await render('run1');
    expect(host.querySelector('.settings-section-title')?.textContent).toBe('Secrets on this machine');
    expect(rowIds()).toEqual(['g1', 'g2']);
    expect(host.querySelector('a[href="/settings/secrets"]')?.textContent).toBe('Settings → Secrets');
    expect(button(row('g1'), 'Revoke')).toBeTruthy();
    expect(button(row('g2'), 'Cancel')).toBeTruthy();
    await click(button(host, 'Show removed (30 days)'));
    expect(rowIds()).toEqual(['g1', 'g2', 'g3']);

    act(() => root?.unmount());
    host.remove();
    await render('run2');
    expect(rowIds()).toEqual(['g4']);
  });

  it('Revoke from this section ends the copy through the same route as Settings → Secrets', async () => {
    grants = [ACTIVE, ELSEWHERE];
    await render('run1');
    await click(button(row('g1'), 'Revoke'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/grants/g1/revoke', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Copy revoked', '“QA GHP2 password” on HPC.');
    expect(row('g1')?.textContent).toContain('Removing');
    expect(button(row('g1'), 'Revoke')).toBeUndefined();
  });

  it('shows while the runner has only removed copies, and is hidden when it has none', async () => {
    grants = [REMOVED, ELSEWHERE];
    await render('run1');
    expect(host.querySelector('.settings-section-title')?.textContent).toBe('Secrets on this machine');
    expect(rowIds()).toEqual([]);

    act(() => root?.unmount());
    host.remove();
    grants = [ELSEWHERE];
    await render('run1');
    expect(host.innerHTML).toBe('');
  });
});
