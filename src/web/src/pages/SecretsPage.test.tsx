// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsPage } from './SecretsPage';
import type { SavedSecret, SecretGrant } from '../lib/accountSecrets';

/**
 * Settings → Secrets (project "Secrets management page", mockup secrets-page-mockup.png): each state a copy on a
 * machine reads as, Revoke and Cancel on it, and the Saved section's Add, Replace and Delete (with and without
 * revoking the copies made from it).
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
// The page writes a time for today and a date otherwise, so the fixtures hang off a fixed local noon, and
// the page reads that clock too: from the real clock, "saved 10 minutes ago" fell on yesterday from local
// midnight to 00:10 and the row read a date where the test expects a time.
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const at = (ms: number) => new Date(NOW + ms).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function grant(n: number, extra: Partial<SecretGrant>): SecretGrant {
  return {
    id: `g${n}`,
    requestId: `r${n}`,
    label: `Secret ${n}`,
    exposure: 'ENV',
    envName: `KEY_${n}`,
    filePath: null,
    runner: { id: 'run1', name: 'HPC', online: true, lastHeartbeatAt: at(-20_000) },
    sessionId: uuid(n),
    sessionTitle: `Session ${n}`,
    taskId: null,
    taskTitle: null,
    taskScoped: false,
    state: 'ACTIVE',
    endReason: null,
    removalNote: null,
    createdAt: at(-10 * MINUTE),
    fetchedAt: null,
    deliveredAt: null,
    expiresAt: at(3 * DAY),
    removedAt: null,
    savedSecretId: null,
    deliveryHint: null,
    ...extra,
  };
}

const ACTIVE = grant(1, { label: 'QA GHP2 password', envName: 'QA_GHP2_PASSWORD', savedSecretId: 's1', sessionTitle: 'QA pass: P2 checkout' });
const NOT_FETCHED = grant(2, {
  label: 'Feishu app secret', exposure: 'FILE', envName: null, filePath: '~/.config/feishu/secret', state: 'PENDING_DELIVERY',
  deliveryHint: { reason: 'NOT_FETCHED', since: at(-6 * MINUTE) },
});
const FETCHED = grant(3, {
  state: 'PENDING_DELIVERY', fetchedAt: at(-2 * MINUTE), deliveryHint: { reason: 'FETCHED_NOT_ACKED', since: at(-2 * MINUTE) },
});
const OFFLINE = grant(4, {
  runner: { id: 'run2', name: 'workstation-gpu', online: false, lastHeartbeatAt: at(-12 * MINUTE) },
  state: 'PENDING_DELIVERY', deliveryHint: { reason: 'RUNNER_OFFLINE', since: at(-12 * MINUTE) },
});
const REMOVING = grant(5, { state: 'REMOVING', endReason: 'REVOKED' });
const UNCONFIRMED = grant(6, {
  label: 'Staging DB password', runner: { id: null, name: 'old-laptop', online: false, lastHeartbeatAt: null },
  taskId: uuid(60), taskTitle: 'Migrate staging schema', taskScoped: true,
  state: 'REMOVED', endReason: 'RUNNER_DELETED', removedAt: at(-2 * DAY),
});
const REMOVED = grant(7, { label: 'Old token', state: 'REMOVED', endReason: 'TASK_ENDED', removedAt: at(-3 * DAY) });

const SAVED_QA: SavedSecret = {
  id: 's1', label: 'QA GHP2 password', createdAt: at(-10 * DAY), updatedAt: at(-10 * DAY), lastUsedAt: at(-10 * MINUTE),
  liveCopies: { count: 1, runnerNames: ['HPC'] },
};
const SAVED_IDLE: SavedSecret = {
  id: 's2', label: 'OpenRouter key', createdAt: at(-20 * DAY), updatedAt: at(-20 * DAY), lastUsedAt: null,
  liveCopies: { count: 0, runnerNames: [] },
};

let grants: SecretGrant[] = [];
let saved: SavedSecret[] = [];

beforeEach(() => {
  // Only Date: the page's waits and the test's own waitFor keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  toast.success.mockReset();
  toast.error.mockReset();
  grants = [ACTIVE, NOT_FETCHED, FETCHED, OFFLINE, REMOVING, UNCONFIRMED, REMOVED];
  saved = [SAVED_QA, SAVED_IDLE];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method === 'GET' && path === '/account-secrets/grants?removed=30d') return { grants } as never;
    if (method === 'GET' && path === '/account-secrets') return { secrets: saved } as never;
    if (method === 'POST' && path.startsWith('/account-secrets/grants/')) {
      const id = path.split('/')[3];
      grants = grants.map((g) => (g.id === id ? { ...g, state: 'REMOVING', endReason: 'REVOKED' } : g));
      return undefined as never;
    }
    if (method === 'POST' && path === '/account-secrets') return { id: 's9' } as never;
    if (method === 'PUT' || method === 'DELETE') return undefined as never;
    throw new Error(`unexpected ${method} ${path}`);
  });
});

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  vi.useRealTimers();
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

async function type(input: HTMLInputElement | null | undefined, value: string) {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

const section = (name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
const row = (id: string) => host.querySelector<HTMLTableRowElement>(`tr[data-grant="${id}"]`);
/** A row's cells as they read, whitespace collapsed. */
const cells = (r: HTMLTableRowElement | null) =>
  [...(r?.cells ?? [])].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const methodCalls = (method: string) => apiMock.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === method);

describe('Settings → Secrets: On machines now', () => {
  it('heads the page and counts live copies and the one needing attention', async () => {
    await render(<SecretsPage />);
    expect(host.querySelector('.settings-header-title')?.textContent).toBe('Secrets');
    expect(section('On machines now').querySelector('.secrets-count')?.textContent).toBe('5 live · 1 needs attention');
  });

  it('reads an Active copy: where it came from, exposure, machine, used-by link, expiry, and Revoke', async () => {
    await render(<SecretsPage />);
    const [secret, exposed, machine, usedBy, state, actions] = cells(row('g1'));
    expect(secret).toMatch(/^QA GHP2 passwordfrom saved · \d\d:\d\d$/);
    expect(exposed).toBe('env QA_GHP2_PASSWORD');
    expect(machine).toBe('HPC');
    expect(usedBy).toBe('QA pass: P2 checkoutsession · ends with session');
    expect(row('g1')!.querySelector('a')?.getAttribute('href')).toMatch(/^\/sessions\/[0-9A-Za-z]+$/);
    expect(state).toMatch(/^Activeexpires [A-Z][a-z]{2} \d+, \d\d:\d\d$/);
    expect(actions).toBe('Revoke');
  });

  it('says why a copy is waiting for delivery, for each of the three reasons, and offers Cancel', async () => {
    await render(<SecretsPage />);
    expect(cells(row('g2'))[1]).toBe('file ~/.config/feishu/secret');
    expect(cells(row('g2'))[4]).toMatch(/^Waiting for deliveryHPC hasn't fetched it for 6 minLast heartbeat .+ ago$/);
    expect(cells(row('g3'))[4]).toMatch(/^Waiting for deliveryHPC fetched it 2 min ago but hasn't confirmed itLast heartbeat .+ ago$/);
    expect(cells(row('g4'))[4]).toBe('Waiting for deliveryworkstation-gpu is offlineLast heartbeat 12 min ago');
    for (const id of ['g2', 'g3', 'g4']) expect(cells(row(id))[5]).toBe('Cancel');
  });

  it('reads a copy being removed, with no action', async () => {
    await render(<SecretsPage />);
    expect(cells(row('g5'))[4]).toBe('RemovingRevokedWaiting for HPC to delete it');
    expect(cells(row('g5'))[5]).toBe('');
  });

  it('reads REMOVED + RUNNER_DELETED as Removal unconfirmed, names the deleted machine, and warns to rotate', async () => {
    await render(<SecretsPage />);
    const r = cells(row('g6'));
    expect(r[2]).toBe('old-laptop (deleted)');
    expect(r[3]).toBe('Migrate staging schematask');
    expect(r[4]).toMatch(/^Removal unconfirmedRunner deleted [A-Z][a-z]{2} \d+$/);
    expect(row('g6')!.querySelector('.orbit-badge-red')).not.toBeNull();
    expect(row('g6')!.querySelector('a')?.getAttribute('href')).toMatch(/^\/tasks\//);
    expect(host.querySelector('.secrets-warning')?.textContent).toBe(
      '⚠ One copy on old-laptop could not be confirmed removed: the runner was deleted before it checked in. Rotate Staging DB password if that machine is not yours anymore.',
    );
  });

  it('hides removed copies until Show removed (30 days) is on, then shows the end reason', async () => {
    await render(<SecretsPage />);
    expect(row('g7')).toBeNull();
    await click(button(host, 'Show removed (30 days)'));
    expect(cells(row('g7'))[4]).toMatch(/^RemovedTask ended · [A-Z][a-z]{2} \d+$/);
    expect(cells(row('g7'))[5]).toBe('');
  });

  it('filters by machine', async () => {
    await render(<SecretsPage />);
    expect([...section('On machines now').querySelectorAll('.secrets-chips button')].map((b) => b.textContent))
      .toEqual(['All machines', 'HPC', 'workstation-gpu', 'old-laptop']);
    await click(button(host, 'workstation-gpu'));
    expect([...host.querySelectorAll('tr[data-grant]')].map((r) => r.getAttribute('data-grant'))).toEqual(['g4']);
  });

  it('Revoke ends a live copy through the grant route, and the row reads again as Removing', async () => {
    await render(<SecretsPage />);
    await click(button(row('g1')!, 'Revoke'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/grants/g1/revoke', { method: 'POST' });
    await vi.waitFor(() => expect(cells(row('g1'))[4]).toBe('RemovingRevokedWaiting for HPC to delete it'));
    expect(toast.success).toHaveBeenCalledWith('Copy revoked', '“QA GHP2 password” on HPC.');
  });

  it('Cancel ends an undelivered copy through the same route', async () => {
    await render(<SecretsPage />);
    await click(button(row('g2')!, 'Cancel'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/grants/g2/revoke', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Delivery cancelled', '“Feishu app secret” on HPC.');
  });

  it('never shows a value: no request is made to read one back', async () => {
    await render(<SecretsPage />);
    expect(apiMock.mock.calls.map(([path]) => path).sort()).toEqual(['/account-secrets', '/account-secrets/grants?removed=30d']);
  });
});

describe('Settings → Secrets: Saved', () => {
  const savedRow = (id: string) => host.querySelector<HTMLTableRowElement>(`tr[data-saved="${id}"]`);

  it('lists label, saved, last used and live copies', async () => {
    await render(<SecretsPage />);
    const qa = cells(savedRow('s1'));
    expect(qa[0]).toBe('QA GHP2 password');
    expect(qa[1]).toMatch(/^[A-Z][a-z]{2} \d+$/);
    expect(qa[2]).toMatch(/^Today, \d\d:\d\d$|^[A-Z][a-z]{2} \d+$/);
    expect(qa[3]).toBe('1 · HPC');
    expect(qa[4]).toBe('ReplaceDelete');
    expect(cells(savedRow('s2')).slice(2, 4)).toEqual(['Never', 'None']);
    expect(section('Saved').querySelector('.secrets-count')?.textContent).toBe('2');
  });

  it('Add secret posts the label and the typed value, which is never shown back', async () => {
    await render(<SecretsPage />);
    await click(button(host, 'Add secret'));
    const inputs = dialog()!.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[1].type).toBe('password');
    await type(inputs[0], '  New key ');
    await type(inputs[1], 'sk-canary-123456');
    await click(button(dialog()!, 'Save'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets', { method: 'POST', body: { label: 'New key', value: 'sk-canary-123456' } });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(host.textContent).not.toContain('sk-canary-123456');
  });

  it('Replace puts the new value', async () => {
    await render(<SecretsPage />);
    await click(button(savedRow('s2')!, 'Replace'));
    expect(dialog()!.textContent).toContain('Replace “OpenRouter key”');
    await type(dialog()!.querySelector('input'), 'sk-new-value-999');
    await click(button(dialog()!, 'Replace'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/s2', { method: 'PUT', body: { value: 'sk-new-value-999' } });
  });

  it('Delete with live copies offers "Also revoke the 1 live copy", checked, and revokes them', async () => {
    await render(<SecretsPage />);
    await click(button(savedRow('s1')!, 'Delete'));
    const d = dialog()!;
    expect(d.textContent).toContain('Delete “QA GHP2 password”?');
    expect(d.textContent).toContain('Agents will no longer be offered it under “Use saved”. 1 copy made from it is still on HPC.');
    expect(d.textContent).toContain('The session “QA pass: P2 checkout” will lose QA_GHP2_PASSWORD within about 30 s.');
    const box = d.querySelector<HTMLElement>('[aria-label="Also revoke the 1 live copy"]');
    expect(box?.getAttribute('aria-checked')).toBe('true');
    await click(button(d, 'Delete'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/s1?revokeCopies=true', { method: 'DELETE' });
  });

  it('Delete with "Also revoke" unchecked leaves the copies', async () => {
    await render(<SecretsPage />);
    await click(button(savedRow('s1')!, 'Delete'));
    const box = dialog()!.querySelector<HTMLElement>('[aria-label="Also revoke the 1 live copy"]');
    await click(box);
    expect(box?.getAttribute('aria-checked')).toBe('false');
    await click(button(dialog()!, 'Delete'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/s1', { method: 'DELETE' });
    expect(methodCalls('DELETE')).toHaveLength(1);
  });

  it('Delete with no live copies asks nothing about copies', async () => {
    await render(<SecretsPage />);
    await click(button(savedRow('s2')!, 'Delete'));
    expect(dialog()!.textContent).not.toContain('Also revoke');
    await click(button(dialog()!, 'Delete'));
    expect(apiMock).toHaveBeenCalledWith('/account-secrets/s2', { method: 'DELETE' });
  });
});
