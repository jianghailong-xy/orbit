// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIKI_CHAT_NEW_PARAM, WIKI_CHAT_NO_ATTACHMENTS } from '../lib/wikiChat';
import { modeChange as change, wikiChatDetail } from '../test/permissionModeFixtures';
import type { ChatOrigin } from './WikiChatPanel';

/**
 * The wiki chat panel's composer and conversation say a session's mode as the session page does
 * (docs/mocks/permission-mode-actual, the owner's A1, B1 and C1): the capsule is the mode the server recorded the
 * engine running in, a gap from the intent is marked and explained, each recorded change is a line where it happened,
 * and a pick is sent as picked. The real conversation and stream, over a fake API.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn(), updateSessionConfig: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { api, getSession, getSessionEventPage, updateSessionConfig } = await import('../api');
const apiMock = vi.mocked(api);
const { WikiChatPanel } = await import('./WikiChatPanel');

const ALL_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const RUNNER = {
  id: 'r1',
  name: 'workstation-gpu',
  online: true,
  runsAsRoot: false,
  modelCatalog: {
    claude: [
      { value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ALL_MODES },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5', permissionModes: ALL_MODES.filter((m) => m !== 'auto') },
    ],
  },
};
const WORKSPACE = { id: 'w1', name: 'orbit-wiki' };

const T0 = Date.parse('2026-11-27T05:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Change = ReturnType<typeof change>;

let detail: Record<string, unknown>;
let events: unknown[];
/** The row the new chat's workspace carries: its model decides what a new chat starts in. */
let workspaceModel: string;
/** What the panel sent: a new chat's create, and each config change of a running one. */
let creates: unknown[];
let configs: unknown[];

function chatDetail(model: string, changes: Change[], running = false): void {
  detail = wikiChatDetail(
    { id: 'S1chat', title: 'Why three heartbeats', workspace: WORKSPACE, assignedRunnerId: RUNNER.id, model, permissionMode: 'auto', running },
    changes,
  );
}

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

const origin: ChatOrigin = {
  copy: {
    history: 'Chats in this space',
    noHistory: 'No chats yet',
    emptyHint: 'Ask about this page.',
    emptyNote: '',
    placeholder: 'Ask about the wiki',
    noWorkspace: 'No workspace',
    chooseWorkspace: 'Choose where it runs',
  },
  listKey: ['wiki-chats'],
  create: async (body) => {
    creates.push(body);
    return { sessionId: 'S1chat' };
  },
  turnContext: () => undefined,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const capsule = (): HTMLElement | null => container.querySelector<HTMLElement>('.composer-toolbar [data-mode-gap]');
const capsuleText = (): string => capsule()?.closest('.orbit-choice-value')?.textContent?.trim() ?? '';
const waitForCapsule = (expected: string) =>
  act(async () => {
    await vi.waitFor(() => expect(capsuleText()).toBe(expected), { timeout: 20_000, interval: 20 });
  });

async function mount(chat: string, expected: string): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiChatPanel
            origin={origin}
            chat={chat}
            list={{ workspace: { ...WORKSPACE, runner: 'HPC', online: true, eligible: true }, choices: [{ ...WORKSPACE, runner: 'HPC', online: true }], chats: [] } as never}
            layout="wide"
            width={420}
            top={0}
            attachments={WIKI_CHAT_NO_ATTACHMENTS}
            dispatch={() => {}}
            onChat={() => {}}
            onClose={() => {}}
            onResize={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForCapsule(expected);
}

const press = async (el: Element) => {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
};
const found = async <T,>(read: () => T | undefined | null): Promise<T> => {
  for (let frame = 0; frame < 100; frame += 1) {
    const value = read();
    if (value) return value;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  throw new Error('not found');
};
const optionElements = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')];
async function openMode(): Promise<void> {
  await press(capsule()!.closest('[role="combobox"]')!);
  await found(() => optionElements().length > 0);
}
async function pickMode(label: string): Promise<void> {
  await openMode();
  await press(optionElements().find((o) => o.textContent?.trim().startsWith(label))!);
}
async function pickModel(label: string): Promise<void> {
  const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click(container.querySelector('.composer-model-chip')!);
  await click(await found(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((el) => el.textContent?.trim() === label)));
}
const checked = (): string | undefined =>
  document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')?.textContent?.trim();
const menuHead = (): string | undefined => document.querySelector('.orbit-select-header')?.textContent?.trim();

const lines = (): string[] =>
  [...container.querySelectorAll('.chat-mode-line')].map(
    (el) => `${el.querySelector('.chat-mode-line-text')?.textContent}${el.classList.contains('is-gap') ? ' (amber)' : ''}`,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  creates = [];
  configs = [];
  workspaceModel = 'claude-opus-5-5';
  chatDetail('claude-opus-5-5', [change('CLAIM', 'auto', null, at(1))]);
  events = [
    { seq: 1, type: 'user', turnId: 't1', ts: at(0), payload: { text: 'Why three heartbeats?' } },
    { seq: 2, type: 'assistant', turnId: 't1', ts: at(60), payload: { text: 'Two are the margin.' } },
    { seq: 3, type: 'user', turnId: 't2', ts: at(120), payload: { text: 'Good. Say so on the page.' } },
    { seq: 4, type: 'assistant', turnId: 't2', ts: at(200), payload: { text: 'Drafted.' } },
  ];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events, hasMore: false }) as never);
  vi.mocked(getSession).mockImplementation(async () => detail as never);
  vi.mocked(updateSessionConfig).mockReset();
  vi.mocked(updateSessionConfig).mockImplementation(async (_id, config) => {
    configs.push(config);
    return {} as never;
  });
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply({});
    if (path === '/users/me') return reply({ id: 'u1', preferences: {} });
    if (path === '/workspaces') return reply([{ ...WORKSPACE, runnerId: RUNNER.id, provider: 'claude', model: workspaceModel }]);
    if (path === '/runners') return reply([RUNNER]);
    if (path.startsWith('/sessions/S1chat')) {
      if (path.includes('/events/page')) return reply({ events, hasMore: false });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      return reply(detail);
    }
    return reply([]);
  }) as unknown as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    await client.cancelQueries();
    client.clear();
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the wiki chat says the mode the session is actually running in', { timeout: 60_000 }, () => {
  it('the capsule says the mode the engine runs in, unmarked, and the menu’s check is on it', async () => {
    await mount('S1chat', 'Auto');
    expect(capsule()?.dataset.modeGap).toBe('none');
    await openMode();
    expect(checked()).toBe('Auto');
    expect(menuHead()).toBeUndefined();
    expect(lines()).toEqual([]);
  });

  it('while the runner switches Claude back to Auto: "Default → Auto" with a spinner, and why', async () => {
    chatDetail('claude-opus-5-5', [change('CLAIM', 'auto', null, ago(6_000)), change('ENGINE_REPORT', 'default', 'auto', ago(4_000))], true);
    await mount('S1chat', 'Default → Auto');
    expect(capsule()?.dataset.modeGap).toBe('switching');
    expect(capsule()?.querySelector('.composer-mode-spin')).not.toBeNull();
    await openMode();
    expect(menuHead()).toBe('Running in Default. Claude started below the Auto you asked for; the runner is switching it to Auto now.');
    expect(checked()).toBe('Auto');
  });

  it('a lasting gap on a model with no Auto: "Default" with a dot, the reason, and the check on Auto', async () => {
    chatDetail('claude-haiku-4-5', [change('CLAIM', 'auto', null, at(1)), change('OWNER_PICK', 'default', 'auto', at(210), 'web')]);
    await mount('S1chat', 'Default');
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    expect(capsule()?.querySelector('.composer-mode-dot')).not.toBeNull();
    await openMode();
    expect(menuHead()).toBe('Running in Default. You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.');
    expect(checked()).toBe('Auto — not on Haiku 4.5, runs as Default');
  });

  it('the conversation records each change where it happened, with who or what made it', async () => {
    chatDetail('claude-haiku-4-5', [
      change('CLAIM', 'auto', null, at(1)),
      change('ENGINE_REPORT', 'default', 'auto', at(2)),
      change('RUNNER_CORRECTION', 'auto', 'default', at(4)),
      change('OWNER_PICK', 'plan', 'auto', at(70), 'ios'),
      change('OWNER_PICK', 'default', 'plan', at(210), 'web'),
    ]);
    await mount('S1chat', 'Default');
    await found(() => lines().length === 3);
    expect(lines()).toEqual([
      'Mode set back to Auto by the runner — Claude had started in Default',
      'Mode set to Plan by you, on iOS',
      'Mode now Default — you picked Haiku 4.5, which has no Auto (amber)',
    ]);
    const order = [...container.querySelectorAll('.chat-user, .chat-assistant, .chat-mode-line')].map((el) =>
      el.classList.contains('chat-mode-line') ? 'line' : 'message',
    );
    expect(order).toEqual(['message', 'line', 'message', 'line', 'message', 'message', 'line']);
  });

  it('picking a model with no Auto sends no mode: the intent stays Auto', async () => {
    await mount('S1chat', 'Auto');
    await pickModel('Haiku 4.5');
    await found(() => configs.length > 0);
    expect(configs).toEqual([{ model: 'claude-haiku-4-5' }]);
  });

  it('a pick travelling to the engine reads as switching, not as a gap that lasts', async () => {
    await mount('S1chat', 'Auto');
    // The server stores the pick at once; the engine has not reported it yet.
    detail = { ...detail, permissionMode: 'plan' };
    await pickMode('Plan');
    await waitForCapsule('Auto → Plan');
    expect(capsule()?.dataset.modeGap).toBe('switching');
    expect(configs).toEqual([{ permissionMode: 'plan' }]);
  });

  it('a new chat on a model with no Auto starts in Default and keeps Auto as the pick, which it sends as picked', async () => {
    workspaceModel = 'claude-haiku-4-5';
    await mount(WIKI_CHAT_NEW_PARAM, 'Default');
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    await openMode();
    expect(menuHead()).toBe('Starts in Default. Haiku 4.5 has no Auto; your pick stays Auto and applies on a model that has it.');
    expect(checked()).toBe('Auto — not on Haiku 4.5, starts in Default');
    await press(optionElements().find((o) => o.textContent?.trim() === 'Plan')!);
    await waitForCapsule('Plan');
    await pickMode('Auto');
    await waitForCapsule('Default');
    const box = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Which heartbeat?');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(await found(() => container.querySelector('.composer-toolbar button[aria-label="Send"]:not([disabled])')));
    await found(() => creates.length > 0);
    expect(creates[0]).toMatchObject({ content: 'Which heartbeat?', permissionMode: 'auto' });
  });
});
