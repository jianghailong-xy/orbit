// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSettings } from '@orbit/shared';
import type { SessionDetail } from '../api';

// The drawer against a control plane stubbed at the api seam: what the session detail carries, and what
// each control asks the server to do.
const api = vi.hoisted(() => ({
  getShareLink: vi.fn(),
  putShareLink: vi.fn(),
  turnOffShareLink: vi.fn(),
  patchSessionSettings: vi.fn(),
  restartSession: vi.fn(),
  getSession: vi.fn(),
  api: vi.fn(),
}));
vi.mock('../api', () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
// A native select stands in for the Base UI one, whose popup this suite is not about.
vi.mock('./ui/Select', () => ({
  Select: ({ options, value, onValueChange, disabled, ...aria }: {
    options: { value: string; label: string }[]; value: string | null; onValueChange: (v: string | null) => void;
    disabled?: boolean; 'aria-label'?: string;
  }) => (
    <select aria-label={aria['aria-label']} value={value ?? ''} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import { SessionSettingsDrawer } from './SessionSettingsDrawer';

const ID = '019ed8aa-e82e-7b01-9a1f-75af5720abaa';

const SETTINGS: SessionSettings = {
  env: { DEBUG: 'orbit:*' },
  workspaceEnv: { NODE_OPTIONS: '--max-old-space-size=6144', GOCACHE: '/mnt/data/gocache' },
  notifyTurnFinished: 'inherit',
  notifyNeedsYou: 'inherit',
  muted: false,
  envPendingRestart: false,
};

function detail(over: Partial<SessionDetail> = {}, settings: Partial<SessionSettings> = {}): SessionDetail {
  return {
    id: ID,
    assignedRunnerId: 'r1',
    status: 'AWAITING_INPUT',
    runStatus: 'AWAITING_INPUT',
    engine: 'claude',
    branch: 'orbit/session-settings-684ed6',
    createdAt: '2026-09-28T20:00:00.000Z',
    runtimeSessionId: '7a1b2c3d-0000-4000-8000-00ab03def5c4',
    engineVersion: '2.4.1',
    usage: { inputTokens: 190_000, outputTokens: 108_000, cacheReadTokens: 1_500_000, cacheCreationTokens: 20_000, costUsd: 4.37, numTurns: 23 },
    settings: { ...SETTINGS, ...settings },
    ...over,
  } as SessionDetail;
}

/** Lets the query cache's batched notifications (a timer) and pending promises reach React. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let qc: QueryClient;

async function mount(d: SessionDetail): Promise<void> {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['session', ID], d);
  qc.setQueryData(['user', 'me'], { preferences: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={qc}>
        <SessionSettingsDrawer
          open
          onClose={() => {}}
          sessionId={ID}
          sessionTags={[{ id: 't1', name: 'web', color: '#3370ff', isSystem: false, position: 0 }]}
          tagLibrary={[
            { id: 't1', name: 'web', color: '#3370ff', isSystem: false, position: 0 },
            { id: 't2', name: 'needs review', color: '#f5a623', isSystem: false, position: 1 },
          ]}
          onToggleTag={onToggleTag}
          tagsSaving={false}
          engineName="Claude Code"
          runnerName="HPC"
          accountLabel="Claude · Max (account 2)"
        />
      </QueryClientProvider>,
    ),
  );
  // The drawer opens through Base UI's portal and frames: wait for it, as a slow machine may take a while.
  for (let i = 0; i < 100 && !document.body.querySelector('.ss-info'); i += 1) await settle();
  await settle();
}

const onToggleTag = vi.fn();
const body = () => document.body;
const button = (name: string) =>
  [...body().querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);
const select = (label: string) => body().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const switchOf = (label: string) => body().querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  for (const fn of [...Object.values(api), ...Object.values(toast), onToggleTag]) fn.mockReset();
  api.getShareLink.mockResolvedValue({ link: null });
  // A refetch after a write answers with the detail as the cache holds it.
  api.getSession.mockImplementation(async () => qc.getQueryData(['session', ID]));
  api.patchSessionSettings.mockImplementation(async (_id: string, patch: Partial<SessionSettings>) => ({ ...SETTINGS, ...patch }));
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SessionSettingsDrawer', () => {
  it('draws Session, Environment, Notifications and Info, and nothing the composer offers', async () => {
    await mount(detail());
    const titles = [...body().querySelectorAll('.ss-section-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Session', 'Environment', 'Notifications', 'Info']);
    const text = body().textContent ?? '';
    expect(text).toContain('Applies when the engine next starts');
    expect(text).toContain('iOS and Android');
    expect(text).toContain('Claude Code 2.4.1');
    expect(text).toContain('Claude · Max (account 2)');
    expect(text).toContain('1.82M');
    expect(text).toContain('in 1.71M · out 108K · cache 1.52M');
    expect(text).toContain('$4.37');
    expect(text).toContain('23 turns');
    expect(text).toContain('…00ab03def5c4');
    // Workspace rows read as inherited; the session's own one is editable and removable.
    expect([...body().querySelectorAll('.ss-env-row.inherited')].map((r) => r.textContent)).toEqual([
      'NODE_OPTIONS--max-old-space-size=6144Workspace',
      'GOCACHE/mnt/data/gocacheWorkspace',
    ]);
    expect(button('Remove DEBUG')).toBeTruthy();
    for (const composerWord of ['Model', 'Permission mode', 'Effort', 'Fast mode', 'Provider']) {
      expect(text).not.toContain(composerWord);
    }
  });

  it('sends the whole env map when a variable is added, removed or Compact at changes', async () => {
    await mount(detail());
    await act(async () => button('Add variable')!.click());
    const name = body().querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const value = body().querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const set = (input: HTMLInputElement, v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      set(name, 'LOG_LEVEL');
      set(value, 'trace');
    });
    await act(async () => {
      value.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.patchSessionSettings).toHaveBeenLastCalledWith(ID, { env: { DEBUG: 'orbit:*', LOG_LEVEL: 'trace' } });

    await act(async () => button('Remove DEBUG')!.click());
    expect(api.patchSessionSettings).toHaveBeenLastCalledWith(ID, { env: { LOG_LEVEL: 'trace' } });

    await act(async () => {
      const s = select('Compact at');
      s.value = '500000';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.patchSessionSettings).toHaveBeenLastCalledWith(ID, {
      env: { LOG_LEVEL: 'trace', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' },
    });
  });

  it('puts the env back and says so when the save fails', async () => {
    api.patchSessionSettings.mockRejectedValue(new Error('nope'));
    await mount(detail());
    await act(async () => button('Remove DEBUG')!.click());
    await settle();
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the setting", 'nope');
    expect(button('Remove DEBUG')).toBeTruthy();
    expect((qc.getQueryData(['session', ID]) as SessionDetail).settings!.env).toEqual({ DEBUG: 'orbit:*' });
  });

  it('labels the restart by whether a turn is running, and shows none when nothing is owed', async () => {
    await mount(detail());
    expect(button('Restart')).toBeUndefined();
    expect(body().querySelector('.ss-restart')).toBeNull();
    await act(async () => root!.unmount());
    document.body.innerHTML = '';

    await mount(detail({}, { envPendingRestart: true }));
    expect(button('Restart')).toBeTruthy();
    expect(body().textContent).toContain('Restart starts the engine again with the new variables');
    api.restartSession.mockResolvedValue({ queued: true, afterTurn: false });
    await act(async () => button('Restart')!.click());
    expect(api.restartSession).toHaveBeenCalledWith(ID);
    await act(async () => root!.unmount());
    document.body.innerHTML = '';

    await mount(detail({ status: 'RUNNING', runStatus: 'RUNNING' }, { envPendingRestart: true }));
    expect(button('Restart after this turn')).toBeTruthy();
    expect(body().textContent).toContain('A turn is running.');
  });

  it('writes the notification choices and the mute switch', async () => {
    await mount(detail());
    expect([...select('When a turn finishes').options].map((o) => o.textContent)).toEqual([
      'As in Settings (Notify)',
      'Notify',
      "Don't notify",
    ]);
    await act(async () => {
      const s = select('When it needs you');
      s.value = 'off';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.patchSessionSettings).toHaveBeenLastCalledWith(ID, { notifyNeedsYou: 'off' });
    // Optimistic: the select already reads the new choice.
    await settle();
    expect(select('When it needs you').value).toBe('off');
    await act(async () => switchOf('Mute this session').click());
    expect(api.patchSessionSettings).toHaveBeenLastCalledWith(ID, { muted: true });
  });

  it('turns the public link on and off, and shows it with Copy while it is live', async () => {
    api.putShareLink.mockResolvedValue({ token: 'k3Rw9Tq2abc', state: 'ACTIVE' });
    api.turnOffShareLink.mockResolvedValue({});
    await mount(detail());
    expect(switchOf('Public link').getAttribute('aria-checked')).toBe('false');
    expect(body().textContent).toContain('Off · only you can open this session');

    await act(async () => switchOf('Public link').click());
    await settle();
    expect(api.putShareLink).toHaveBeenCalledWith('SESSION', ID, {});
    expect(switchOf('Public link').getAttribute('aria-checked')).toBe('true');
    expect(body().querySelector('.ss-link-url')?.textContent).toContain('/s/k3Rw9Tq2abc');
    expect(button('Copy')).toBeTruthy();

    await act(async () => switchOf('Public link').click());
    await settle();
    expect(api.turnOffShareLink).toHaveBeenCalledWith('SESSION', ID);
    expect(body().querySelector('.ss-link')).toBeNull();
  });

  it('removes a label with its × through the same tag toggle as the ⋯ menu', async () => {
    await mount(detail());
    await act(async () => button('Remove web')!.click());
    expect(onToggleTag).toHaveBeenCalledWith('t1');
  });
});
