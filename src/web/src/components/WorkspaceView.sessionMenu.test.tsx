// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

// These helpers call the module-local api(), so intercept the lifecycle writes by name.
vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  api: vi.fn(), getSession: vi.fn(), getSessionEventPage: vi.fn(),
  completeSession: vi.fn(), restoreSession: vi.fn(), deleteSession: vi.fn(),
  purgeSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), getShareLink: vi.fn(),
  renameSession: vi.fn(),
}));
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null, saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
const uuid = (n: number) => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const RUNNER_ID = uuid(961);
const WORKSPACE_ID = encodeId(uuid(962));
const OPEN_ID = encodeId(uuid(963));
const TARGET_ID = encodeId(uuid(964));
const RUNNER = {
  id: RUNNER_ID, name: 'desktop-runner', online: true, maxConcurrent: 2, activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
type Scope = 'open' | 'completed' | 'trash';
const session = (id: string, title: string) => ({
  id, title, workspaceId: WORKSPACE_ID, workspace: { id: WORKSPACE_ID, name: 'orbit' },
  runnerId: RUNNER_ID, provider: 'claude', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN', createdAt: '2026-10-01T10:00:00Z',
  lastTurnAt: '2026-10-03T09:00:00Z', pinnedAt: null as string | null,
  capabilities: { canComplete: true, canRestore: true }, shared: false,
});
let rows: ReturnType<typeof session>[];
let location = '';
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

function LocationProbe() {
  location = useLocation().pathname;
  return null;
}

// React 19 holds renders inside an unfinished act callback. Wait outside it, then flush effects.
async function until(assertion: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try { await vi.waitFor(assertion, { timeout: 10_000, interval: 20 }); }
  finally { env.IS_REACT_ACT_ENVIRONMENT = previous; }
  await act(async () => {});
}
async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
function row(id: string): HTMLElement {
  const title = id === OPEN_ID ? 'Open conversation' : 'Menu target';
  const found = [...container!.querySelectorAll<HTMLElement>('.session-row')].find(
    (el) => el.querySelector('.session-title')?.textContent === title,
  );
  if (!found) throw new Error(`Missing session row: ${title}`);
  return found;
}
const menu = (): HTMLElement | null =>
  document.querySelector('.session-row-menu:not(.ant-dropdown-hidden) .ant-dropdown-menu');
function item(label: string): HTMLElement | undefined {
  return [...(menu()?.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item') ?? [])].find(
    (el) => el.textContent?.trim().startsWith(label),
  );
}
async function openMenu(id = TARGET_ID): Promise<void> {
  await click(row(id).querySelector('button[aria-label="More actions"]'));
  await until(() => expect(menu()).not.toBeNull());
}
async function chord(modifier: 'metaKey' | 'ctrlKey' = 'metaKey', repeat = false): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'd', [modifier]: true, repeat, bubbles: true, cancelable: true });
  await act(async () => { window.dispatchEvent(event); });
  return event;
}
async function mount(scope: Scope = 'open'): Promise<void> {
  if (scope !== 'open') rows[1].lifecycleState = scope === 'trash' ? 'TRASH' : 'COMPLETED';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={[`/sessions/${OPEN_ID}`]}>
          <AntApp><WorkspaceView runner={RUNNER} /><LocationProbe /></AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await until(() => expect(row(OPEN_ID)).toBeTruthy());
  if (scope !== 'open') {
    await click(container.querySelector('.session-scope-menu'));
    const label = scope === 'trash' ? 'Trash' : 'Completed';
    const scopeItem = () => [...document.querySelectorAll<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')]
      .find((el) => el.textContent?.trim() === label);
    await until(() => expect(scopeItem()).toBeTruthy());
    await click(scopeItem());
  }
  await until(() => expect(row(TARGET_ID)).toBeTruthy());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rows = [session(OPEN_ID, 'Open conversation'), session(TARGET_ID, 'Menu target')];
  location = '';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)', media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  for (const name of ['completeSession', 'restoreSession', 'deleteSession', 'purgeSession', 'pinSession', 'unpinSession', 'renameSession'] as const) {
    vi.mocked(apiModule[name]).mockReset();
    vi.mocked(apiModule[name]).mockResolvedValue({});
  }
  vi.mocked(apiModule.completeSession).mockImplementation(async (id) => {
    rows = rows.filter((s) => s.id !== id);
    return {};
  });
  vi.mocked(apiModule.renameSession).mockImplementation(async (id, title) => {
    rows = rows.map((s) => (s.id === id ? { ...s, title } : s));
    return {};
  });
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async (id) => rows.find((s) => s.id === id) as never);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getShareLink).mockReset();
  vi.mocked(apiModule.getShareLink).mockResolvedValue({ link: null, counts: { messages: 2, toolCalls: 0 } });
  vi.mocked(apiModule.api).mockReset();
  vi.mocked(apiModule.api).mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') return reply({ id: 'user-1', name: 'Reader', email: 'reader@example.com', preferences: {} });
    if (path === '/workspaces') return reply([{ id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID, lastProvider: 'claude' }]);
    if (path.startsWith('/sessions?')) {
      const scope = new URLSearchParams(path.split('?')[1]).get('view') ?? 'open';
      return reply(rows.filter((s) => s.lifecycleState === (scope === 'trash' ? 'TRASH' : scope.toUpperCase())));
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) return reply({ decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] });
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  if (client) { await client.cancelQueries(); client.clear(); }
  root = null;
  client = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the session row More actions menu', () => {
  it.each([
    ['open', ['Complete', 'Pin', 'Rename…', 'Share…', 'Move…', 'Delete']],
    ['completed', ['Move to Open', 'Pin', 'Rename…', 'Share…', 'Move…', 'Delete']],
    ['trash', ['Move to Open', 'Delete Permanently…']],
  ] as const)('contains the iOS swipe actions for %s', async (scope, expected) => {
    await mount(scope);
    expect(row(TARGET_ID).querySelectorAll('.session-actions button')).toHaveLength(1);
    await openMenu();
    const labels = [...menu()!.querySelectorAll('.ant-dropdown-menu-item')].map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector('kbd')?.remove();
      return copy.textContent!.trim();
    });
    expect(labels).toEqual(expected);
    if (scope === 'open') expect(item('Complete')?.querySelector('kbd')?.textContent).toMatch(/^(⌘D|Ctrl D)$/);
    else expect(menu()!.querySelector('kbd')).toBeNull();
  });

  it.each(['metaKey', 'ctrlKey'] as const)('completes the menu row with %s+D, then the selected row after the menu closes', async (modifier) => {
    await mount();
    await openMenu();
    expect(location).toBe(`/sessions/${OPEN_ID}`);
    expect((await chord(modifier)).defaultPrevented).toBe(true);
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
    await until(() => expect(menu()).toBeNull());
    expect(location).toBe(`/sessions/${OPEN_ID}`);
    // Holding the same chord after the menu disappears must not spill onto the open conversation.
    expect((await chord(modifier, true)).defaultPrevented).toBe(true);
    expect(apiModule.completeSession).toHaveBeenCalledTimes(1);
    await chord(modifier);
    await until(() => expect(apiModule.completeSession).toHaveBeenNthCalledWith(2, OPEN_ID));
  });

  it('consumes the shortcut for a disabled menu action without completing the selected row', async () => {
    rows[1].capabilities.canComplete = false;
    await mount();
    await openMenu();
    expect(item('Complete')?.getAttribute('aria-disabled')).toBe('true');
    await click(item('Complete'));
    expect((await chord()).defaultPrevented).toBe(true);
    expect(apiModule.completeSession).not.toHaveBeenCalled();
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('Escape closes the menu and returns the shortcut to the open conversation', async () => {
    await mount();
    const trigger = row(TARGET_ID).querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
    await openMenu();
    await until(() => expect(menu()!.contains(document.activeElement)).toBe(true));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
      }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    await chord();
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledExactlyOnceWith(OPEN_ID));
  });

  it('arrow keys move within the menu without switching the open conversation', async () => {
    await mount();
    await openMenu();
    // rc-menu excludes zero-size nodes from arrow navigation; jsdom has no layout engine.
    for (const el of menu()!.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')) {
      Object.defineProperty(el, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 200, 32) });
    }
    await until(() => expect(document.activeElement).toBe(item('Complete')));
    for (const [key, keyCode, label] of [['ArrowDown', 40, 'Pin'], ['ArrowUp', 38, 'Complete']] as const) {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
          key, keyCode, which: keyCode, bubbles: true, cancelable: true,
        }));
      });
      await until(() => expect(document.activeElement).toBe(item(label)));
      expect(location).toBe(`/sessions/${OPEN_ID}`);
    }
    expect(apiModule.completeSession).not.toHaveBeenCalled();
  });

  it.each(['completed', 'trash'] as const)('does not apply Complete to a %s menu', async (scope) => {
    await mount(scope);
    await openMenu();
    expect((await chord()).defaultPrevented).toBe(true);
    expect(apiModule.completeSession).not.toHaveBeenCalled();
    expect(apiModule.restoreSession).not.toHaveBeenCalled();
  });

  it('clicking Complete applies to the menu row without changing the open conversation', async () => {
    await mount();
    await openMenu();
    await click(item('Complete'));
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('unpins the menu row without navigating to it', async () => {
    rows[1].pinnedAt = '2026-10-03T08:00:00Z';
    await mount();
    await openMenu();
    await click(item('Unpin'));
    await until(() => expect(apiModule.unpinSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
    expect(apiModule.pinSession).not.toHaveBeenCalled();
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('opens Share for the menu row without navigating to it', async () => {
    await mount();
    await openMenu();
    await click(item('Share…'));
    await until(() => expect(apiModule.getShareLink).toHaveBeenCalledWith('SESSION', TARGET_ID));
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('deletes the menu row without deleting the open conversation', async () => {
    await mount();
    await openMenu();
    await click(item('Delete'));
    await until(() => expect(apiModule.deleteSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('moves a completed menu row back to Open', async () => {
    await mount('completed');
    await openMenu();
    await click(item('Move to Open'));
    await until(() => expect(apiModule.restoreSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
    expect(apiModule.completeSession).not.toHaveBeenCalled();
  });

  it('requires confirmation before permanently deleting the Trash menu row', async () => {
    await mount('trash');
    await openMenu();
    await click(item('Delete Permanently'));
    await until(() => expect(document.querySelector('.ant-modal-confirm')).not.toBeNull());
    expect(apiModule.purgeSession).not.toHaveBeenCalled();
    await click(document.querySelector('.ant-modal-confirm .ant-btn-primary'));
    await until(() => expect(apiModule.purgeSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID));
  });
});

describe('Rename… on a session row', () => {
  const field = (): HTMLInputElement | null =>
    container!.querySelector<HTMLInputElement>('.session-row.renaming input');
  const titles = (): string[] =>
    [...container!.querySelectorAll('.session-row .session-title')].map((el) => el.textContent ?? '');
  async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function press(el: Element, key: 'Enter' | 'Escape'): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }
  async function startRename(): Promise<HTMLInputElement> {
    await openMenu();
    await click(item('Rename…'));
    await until(() => expect(field()).not.toBeNull());
    return field()!;
  }

  it('puts the whole title, selected, in a field in the row; Return saves it trimmed, once', async () => {
    await mount();
    const input = await startRename();
    expect(input.value).toBe('Menu target');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Menu target'.length]);
    expect(input.maxLength).toBe(200);
    expect(row(OPEN_ID)).toBeTruthy();
    await type(input, '  Release checklist  ');
    await press(input, 'Enter');
    await until(() => expect(apiModule.renameSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID, 'Release checklist'));
    await until(() => expect(field()).toBeNull());
    expect(titles()).toContain('Release checklist');
    expect(location).toBe(`/sessions/${OPEN_ID}`);
  });

  it('saves an unchanged title too, as the header editor does', async () => {
    await mount();
    await press(await startRename(), 'Enter');
    await until(() => expect(apiModule.renameSession).toHaveBeenCalledExactlyOnceWith(TARGET_ID, 'Menu target'));
  });

  it('Escape, or an emptied field, keeps the title and sends nothing', async () => {
    await mount();
    let input = await startRename();
    await type(input, 'Something else');
    await press(input, 'Escape');
    await until(() => expect(field()).toBeNull());
    expect(titles()).toContain('Menu target');
    input = await startRename();
    await type(input, '   ');
    await press(input, 'Enter');
    await until(() => expect(field()).toBeNull());
    expect(titles()).toContain('Menu target');
    expect(apiModule.renameSession).not.toHaveBeenCalled();
  });

  it('a press on the row around the field keeps the field and does not open the row', async () => {
    await mount();
    const input = await startRename();
    const renamed = container!.querySelector<HTMLElement>('.session-row.renaming')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { renamed.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    await click(renamed);
    expect(field()).toBe(input);
    expect(location).toBe(`/sessions/${OPEN_ID}`);
    expect(apiModule.renameSession).not.toHaveBeenCalled();
  });

  it("the open conversation's More actions offers Rename…, which opens the title editor", async () => {
    await mount();
    await click(container!.querySelector('.workspace-header button[title="More actions"]'));
    const rename = () => [...document.querySelectorAll<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')]
      .find((el) => el.textContent?.trim() === 'Rename…');
    await until(() => expect(rename()).toBeTruthy());
    await click(rename());
    await until(() => expect(container!.querySelector('.workspace-name-input')).not.toBeNull());
    const input = container!.querySelector<HTMLInputElement>('.workspace-name-input')!;
    expect(input.value).toBe('Open conversation');
    expect(document.activeElement).toBe(input);
    await type(input, 'Renamed in the header');
    await press(input, 'Enter');
    await until(() => expect(apiModule.renameSession).toHaveBeenCalledExactlyOnceWith(OPEN_ID, 'Renamed in the header'));
  });
});
