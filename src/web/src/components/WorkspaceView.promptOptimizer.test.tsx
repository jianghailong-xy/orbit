// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The prompt optimizer in the session composer (docs/prompt-optimizer-design.md, board
 * docs/mocks/prompt-optimizer/01-board.png, frames 2–6): ✦ Optimize beside Send, the suggestion card
 * above the composer, the box changed only by Use / Edit, then use, Undo, the failure line, and
 * D2: with Translation on the card opens in the owner's language and Use inserts that; an unedited send carries
 * the optimizer's prompt as `optimizedTranslation` (without Translation, `skipTranslation`).
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    retryTurnTranslation: vi.fn(),
    sendTurnAsWritten: vi.fn(),
    retryReplyTranslation: vi.fn(),
    optimizePrompt: vi.fn(),
    sendTurn: vi.fn(),
    uploadAttachment: vi.fn(),
    listApprovals: vi.fn(),
    decideApproval: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns, listApprovals, decideApproval, retryTurnTranslation, sendTurnAsWritten, optimizePrompt, sendTurn, uploadAttachment } =
  await import('../api');
const optimizeMock = vi.mocked(optimizePrompt);
const sendMock = vi.mocked(sendTurn);
const { ToastViewport } = await import('./ToastViewport');
const { clearToasts } = await import('../lib/toastStore');
const apiMock = vi.mocked(api);
const seedMock = vi.mocked(getSessionEventPage);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000021';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000022';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000023';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;


const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const PARKED = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Flaky socket test',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  engineTurnActive: false,
  pendingApprovals: 0,
  provider: 'claude',
  createdAt: '2026-10-08T03:00:00Z',
  updatedAt: '2026-10-08T03:05:00Z',
};
let session: Record<string, unknown> = PARKED;
let preferences: Record<string, unknown> = {};
let translationAvailable = true;
let promptOptimizerAvailable = true;
let queue: unknown[] = [];
let approvals: unknown[] = [];
let locations: string[] = [];
let stored: Record<string, string> = {};

const SEED = [
  { seq: 10, type: 'user', payload: { text: 'fix the flaky socket test' }, turnId: 'turn-1', ts: '2026-10-08T03:04:00Z' },
  { seq: 11, type: 'assistant', payload: { text: 'Fixed: the retry now waits for the socket to close.' }, turnId: 'turn-1', ts: '2026-10-08T03:04:50Z' },
  { seq: 12, type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId: 'turn-1', ts: '2026-10-08T03:04:51Z' },
];

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {
    this.closed = true;
  }
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const box = (): HTMLTextAreaElement => mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;


/** Every place the router has been, written down on each render. */
function LocationProbe() {
  const at = useLocation();
  locations.push(`${at.pathname}${at.hash}`);
  return null;
}

const waitForUi = async (assertion: () => void): Promise<void> => {
  // Off while waiting, as in WorkspaceView.streamOrder.test.tsx: renders queued inside an
  // in-flight act callback are not flushed until it settles.
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};


beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  session = PARKED;
  preferences = { translationEnabled: true, translationLanguage: 'zh-Hans', promptOptimizer: true };
  translationAvailable = true;
  promptOptimizerAvailable = true;
  approvals = [];
  vi.mocked(listApprovals).mockImplementation((async () => approvals) as never);
  vi.mocked(decideApproval).mockReset();
  vi.mocked(decideApproval).mockImplementation((async () => ({})) as never);
  optimizeMock.mockReset();
  optimizeMock.mockImplementation(async () => RESULT);
  sendMock.mockReset();
  sendMock.mockImplementation(async () => ({ turnId: 'turn-9', seq: 20, kind: 'message', placement: 'accepted' }) as never);
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(uploadAttachment).mockImplementation(async () => ({ id: 'att-1' }));
  queue = [];
  locations = [];
  vi.mocked(listQueuedTurns).mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue as never);
  vi.mocked(retryTurnTranslation).mockReset();
  vi.mocked(retryTurnTranslation).mockImplementation(async (_s, turnId) => ({
    turnId,
    translation: { state: 'TRANSLATING', from: 'zh-Hans', original: 'x' },
  }));
  vi.mocked(sendTurnAsWritten).mockReset();
  vi.mocked(sendTurnAsWritten).mockImplementation(async (_s, turnId) => ({
    turnId,
    translation: { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: 'x' },
  }));
  stored = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  seedMock.mockReset();
  seedMock.mockImplementation(async () => ({ events: SEED, hasMore: false }));
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences, translationAvailable, promptOptimizerAvailable });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith('/sessions/') && path.includes('/events/page')) return reply({ events: SEED, hasMore: false });
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(session);
    }
    if (path.startsWith('/sessions')) return reply([session]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    clearToasts();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[SESSION_PATH]}>
          <WorkspaceView runner={RUNNER} />
          <LocationProbe />
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const DRAFT = 'fix the login redirect bug, it goes to the wrong page after sign in';
const OPTIMIZED =
  'After signing in, users land on the wrong page. The redirect target is meant to come from the returnTo query parameter.';
const GLOSS = 'GLOSS-IN-READER-LANGUAGE';
const RESULT = {
  segments: [
    { text: 'After signing in, users land on the wrong page. ', added: false },
    { text: 'The redirect target is meant to come from the returnTo query parameter.', added: true },
  ],
  text: OPTIMIZED,
  language: 'en' as const,
  gloss: GLOSS,
  contextUsed: [
    { kind: 'TURNS' as const, count: 6 },
    { kind: 'RECAP' as const },
    { kind: 'PROJECT' as const, title: 'Auth cleanup' },
    { kind: 'WIKI' as const, count: 2 },
  ],
};

const optimizeButton = (): HTMLButtonElement | null => mounted().querySelector<HTMLButtonElement>('.composer-optimize');
const card = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.composer-optimized');
const failed = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.composer-optimize-failed');
const cardButton = (label: string): HTMLButtonElement =>
  [...(card() ?? failed())!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.replace(b.querySelector('kbd')?.textContent ?? '', '').trim() === label,
  )!;

async function typeDraft(value: string): Promise<void> {
  const ta = box();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(target: HTMLElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

/** Mounted on the parked session, the composer drawn, the draft typed and ✦ Optimize offered. */
async function ready(draft = DRAFT): Promise<void> {
  await mount();
  await waitForUi(() => expect(box()).toBeTruthy());
  await typeDraft(draft);
  await waitForUi(() => expect(optimizeButton()?.disabled).toBe(false));
}

async function tab(): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => {
    box().dispatchEvent(event);
  });
  return event;
}

async function openCard(): Promise<void> {
  await act(async () => optimizeButton()!.click());
  await waitForUi(() => expect(card()).toBeTruthy());
}

async function send(): Promise<void> {
  const button = mounted().querySelector<HTMLButtonElement>('.composer-send')!;
  await waitForUi(() => expect(button.disabled).toBe(false));
  await act(async () => button.click());
  await waitForUi(() => expect(sendMock).toHaveBeenCalled());
}

describe('✦ Optimize (frame 2)', () => {
  it('sits just left of Send once there is a draft, a ✦ icon named by its label', async () => {
    await ready();
    const button = optimizeButton()!;
    expect(button.textContent).toBe('✦');
    expect(button.getAttribute('aria-label')).toBe('Optimize this draft');
    const send = mounted().querySelector('.composer-send')!;
    expect(button.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps its slot but is disabled while the box is empty, so the toolbar never shifts', async () => {
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(true));
    await typeDraft('   ');
    expect(optimizeButton()!.disabled).toBe(true);
    await key(box(), { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });
    expect(optimizeMock).not.toHaveBeenCalled();
  });

  it('is shown for an account that never set the switch (absent = on)', async () => {
    preferences = { translationEnabled: true };
    await ready();
  });

  it('is hidden with the switch off (promptOptimizer: false)', async () => {
    preferences = { translationEnabled: true, promptOptimizer: false };
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    await typeDraft(DRAFT);
    await waitForUi(() => expect(box().value).toBe(DRAFT));
    expect(optimizeButton()).toBeNull();
  });

  it('is hidden on a server without a DeepSeek key, whatever the switch says', async () => {
    promptOptimizerAvailable = false;
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    await typeDraft(DRAFT);
    await waitForUi(() => expect(box().value).toBe(DRAFT));
    expect(optimizeButton()).toBeNull();
  });

  it('is disabled in shell mode and for a draft that is only a /command', async () => {
    await ready();
    await typeDraft('!ls -la');
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(true));
    await typeDraft('/compact');
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(true));
    await typeDraft('/review the login page');
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(false));
  });
});

describe('Optimizing… (frame 3)', () => {
  it('sends the draft with the session, shows the busy state, and pressing again cancels', async () => {
    let signal: AbortSignal | undefined;
    optimizeMock.mockImplementation((_body, s) => {
      signal = s;
      return new Promise(() => {});
    });
    await ready();
    await act(async () => optimizeButton()!.click());
    expect(optimizeMock).toHaveBeenCalledWith({ draft: DRAFT, sessionId: SESSION_PUBLIC }, expect.anything());
    expect(optimizeButton()!.getAttribute('aria-label')).toBe('Optimizing… press to cancel');
    expect(optimizeButton()!.querySelector('.composer-optimize-spin')).toBeTruthy();
    // The draft stays editable while it works.
    expect(box().disabled).toBe(false);
    await act(async () => optimizeButton()!.click());
    expect(signal?.aborted).toBe(true);
    expect(optimizeButton()!.getAttribute('aria-label')).toBe('Optimize this draft');
    expect(card()).toBeNull();
    expect(box().value).toBe(DRAFT);
  });

  it('Tab in the box presses it, and says so to the eye and to a screen reader', async () => {
    await ready();
    // The app's tooltip, not the browser's `title`, names the shortcut.
    expect(optimizeButton()!.hasAttribute('title')).toBe(false);
    await act(async () => { optimizeButton()!.focus(); await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Optimize this draft · Tab ·');
    await act(async () => { box().focus(); });
    const hint = document.getElementById(box().getAttribute('aria-describedby')!);
    expect(hint?.textContent).toBe('Press Tab to optimize this draft.');
    expect((await tab()).defaultPrevented).toBe(true);
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(optimizeMock).toHaveBeenCalledTimes(1);
    expect(box().value).toBe(DRAFT);
  });

  it('Tab moves focus as before on a draft ✦ cannot take', async () => {
    await ready();
    await typeDraft('/compact');
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(true));
    expect((await tab()).defaultPrevented).toBe(false);
    expect(box().getAttribute('aria-describedby')).toBeNull();
    expect(optimizeMock).not.toHaveBeenCalled();
  });

  it('while it works, Tab moves focus and asks nothing more', async () => {
    optimizeMock.mockImplementation(() => new Promise(() => {}));
    await ready();
    expect((await tab()).defaultPrevented).toBe(true);
    await waitForUi(() => expect(optimizeButton()!.getAttribute('aria-label')).toBe('Optimizing… press to cancel'));
    expect((await tab()).defaultPrevented).toBe(false);
    expect(optimizeMock).toHaveBeenCalledTimes(1);
  });

  it('after Esc, Tab on the same draft moves focus; an edit gives Tab back to the optimizer', async () => {
    await ready();
    await tab();
    await waitForUi(() => expect(card()).toBeTruthy());
    await key(box(), { key: 'Escape' });
    expect(card()).toBeNull();
    expect((await tab()).defaultPrevented).toBe(false);
    expect(optimizeMock).toHaveBeenCalledTimes(1);
    await typeDraft(`${DRAFT} today`);
    expect((await tab()).defaultPrevented).toBe(true);
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(optimizeMock).toHaveBeenCalledTimes(2);
  });

  it('Tab, Tab: optimize, then use; a third Tab on the text it put there moves focus', async () => {
    await ready();
    await tab();
    await waitForUi(() => expect(card()).toBeTruthy());
    expect((await tab()).defaultPrevented).toBe(true);
    expect(box().value).toBe(GLOSS);
    expect(card()).toBeNull();
    expect((await tab()).defaultPrevented).toBe(false);
    expect(optimizeMock).toHaveBeenCalledTimes(1);
  });

  it('⌘⇧O (or Ctrl⇧O) presses it', async () => {
    await ready();
    await key(box(), { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(optimizeMock).toHaveBeenCalledTimes(1);
  });
});

describe('the suggestion card (frame 4)', () => {
  it('shows the optimized prompt with its additions tinted and the Used: chips, leaving the box untouched', async () => {
    optimizeMock.mockImplementation(async () => ({ ...RESULT, gloss: undefined }));
    await ready();
    await openCard();
    expect(card()!.textContent).toContain('Optimized prompt');
    expect(card()!.textContent).toContain(OPTIMIZED);
    const added = [...card()!.querySelectorAll('.composer-optimized-added')].map((m) => m.textContent);
    expect(added).toEqual(['The redirect target is meant to come from the returnTo query parameter.']);
    const chips = [...card()!.querySelectorAll('.composer-optimized-chip')].map((c) => c.textContent);
    expect(card()!.textContent).toContain('Used:');
    expect(chips).toEqual(["this session's last 6 turns", 'session recap', 'project "Auth cleanup" goal', '2 wiki entries']);
    expect(card()!.textContent).toContain('Esc dismisses · your draft is kept');
    expect(box().value).toBe(DRAFT);
  });

  it('with Translation on, opens in the owner\'s language and says what the agent receives', async () => {
    await ready();
    await openCard();
    expect(card()!.textContent).toContain(GLOSS);
    expect(card()!.textContent).not.toContain(OPTIMIZED);
    expect(card()!.textContent).toContain('The agent receives the English version.');
  });

  it('"Show in <language>" flips to the prompt the agent receives and back', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Show in English').click());
    expect(card()!.textContent).toContain(OPTIMIZED);
    expect(card()!.textContent).not.toContain(GLOSS);
    await act(async () => cardButton('Show in Chinese (Simplified)').click());
    expect(card()!.textContent).toContain(GLOSS);
  });

  it('"Show in" names the agent language the prompt was written in, not English', async () => {
    optimizeMock.mockImplementation(async () => ({ ...RESULT, language: 'ja' }));
    await ready();
    await openCard();
    expect(card()!.textContent).toContain('The agent receives the Japanese version.');
    await act(async () => cardButton('Show in Japanese').click());
    expect(card()!.textContent).toContain(OPTIMIZED);
    await act(async () => cardButton('Show in Chinese (Simplified)').click());
    expect(card()!.textContent).toContain(GLOSS);
  });

  it('offers no "Show in" without a gloss', async () => {
    optimizeMock.mockImplementation(async () => ({ ...RESULT, gloss: undefined }));
    await ready();
    await openCard();
    expect(card()!.textContent).not.toContain('Show in');
    expect(card()!.textContent).not.toContain('The agent receives');
  });

  it('Use replaces the draft only on the press, keeps attachments, and offers Undo', async () => {
    await ready();
    const input = mounted().querySelector<HTMLInputElement>('.composer-box input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'notes.txt', { type: 'text/plain' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForUi(() => expect(mounted().querySelector('.composer-file, .composer-attach')).toBeTruthy());
    await openCard();
    expect(box().value).toBe(DRAFT);
    await act(async () => cardButton('Use').click());
    expect(box().value).toBe(GLOSS);
    expect(card()).toBeNull();
    expect(mounted().querySelector('.composer-file, .composer-attach')).toBeTruthy();
    await waitForUi(() => expect(document.body.textContent).toContain('Draft replaced with the optimized prompt'));
    const undo = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Undo')!;
    await act(async () => undo.click());
    await waitForUi(() => expect(box().value).toBe(DRAFT));
  });

  it('stays on a reply to a question card, tells the optimizer the question, and what Use puts in the box answers the card', async () => {
    approvals = [{
      id: encodeId('0195c0de-0000-7000-8000-000000000081'),
      sessionId: SESSION_PUBLIC,
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_q1',
      status: 'PENDING',
      createdAt: '2026-10-08T03:05:00Z',
      input: { questions: [{ question: 'Which way?', header: 'Runner full', multiSelect: false,
        options: [{ label: 'Yes', description: 'Go ahead' }, { label: 'No', description: 'Leave it' }] }] },
    }];
    session = { ...PARKED, status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', engineTurnActive: true, pendingApprovals: 1 };
    await mount();
    let chat: HTMLButtonElement | undefined;
    await waitForUi(() => {
      chat = [...mounted().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Chat about this'));
      expect(chat).toBeTruthy();
    });
    await act(async () => chat!.click());
    await waitForUi(() => expect(mounted().querySelector('.composer-replyto-text')).toBeTruthy());
    await typeDraft(DRAFT);
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(false));
    await openCard();
    expect(optimizeMock.mock.calls[0]![0]).toMatchObject({
      draft: DRAFT,
      replyingTo: 'Runner full: Which way?\n- Yes: Go ahead\n- No: Leave it',
    });
    await act(async () => cardButton('Use').click());
    expect(box().value).toBe(GLOSS);
    const button = mounted().querySelector<HTMLButtonElement>('.composer-send')!;
    await waitForUi(() => expect(button.disabled).toBe(false));
    await act(async () => button.click());
    await waitForUi(() => expect(vi.mocked(decideApproval)).toHaveBeenCalled());
    const [, approvalId, behavior, message] = vi.mocked(decideApproval).mock.calls[0]!;
    expect([approvalId, behavior, message]).toEqual([encodeId('0195c0de-0000-7000-8000-000000000081'), 'deny', GLOSS]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('Edit, then use replaces the draft and puts the caret at the end', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Edit, then use').click());
    expect(box().value).toBe(GLOSS);
    await waitForUi(() => expect(document.activeElement).toBe(box()));
    expect(box().selectionStart).toBe(GLOSS.length);
  });

  it('⌘Z in the box after Use puts the owner\'s draft back', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Use').click());
    expect(box().value).toBe(GLOSS);
    await key(box(), { key: 'z', metaKey: true });
    expect(box().value).toBe(DRAFT);
  });

  it('× dismisses and keeps the draft', async () => {
    await ready();
    await openCard();
    await act(async () => card()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
    expect(card()).toBeNull();
    expect(box().value).toBe(DRAFT);
  });

  it('Tab in the box is Use: the draft is replaced and Undo is offered', async () => {
    await ready();
    await openCard();
    expect(cardButton('Use').querySelector('kbd')?.textContent).toBe('Tab');
    expect(cardButton('Use').getAttribute('aria-keyshortcuts')).toBe('Tab');
    expect(card()!.textContent).toContain('Tab uses it · Esc dismisses · your draft is kept');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => {
      box().dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(box().value).toBe(GLOSS);
    expect(card()).toBeNull();
    await waitForUi(() => expect(document.body.textContent).toContain('Draft replaced with the optimized prompt'));
  });

  it('Shift+Tab and a modified Tab leave the card alone', async () => {
    await ready();
    await openCard();
    for (const init of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      await key(box(), { key: 'Tab', ...init });
      expect(card()).toBeTruthy();
      expect(box().value).toBe(DRAFT);
    }
  });

  it('Esc dismisses and keeps the draft', async () => {
    await ready();
    await openCard();
    await key(box(), { key: 'Escape' });
    expect(card()).toBeNull();
    expect(box().value).toBe(DRAFT);
  });

  it('closes once Enter sends the draft it was about', async () => {
    await ready();
    await openCard();
    await key(box(), { key: 'Enter' });
    await waitForUi(() => expect(sendMock).toHaveBeenCalled());
    await waitForUi(() => expect(box().value).toBe(''));
    expect(card()).toBeNull();
  });

  it('a send while it works drops the answer that comes back', async () => {
    let answer: (value: typeof RESULT) => void = () => {};
    optimizeMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await ready();
    await act(async () => optimizeButton()!.click());
    await send();
    await waitForUi(() => expect(box().value).toBe(''));
    await act(async () => answer(RESULT));
    expect(card()).toBeNull();
  });

  it('Try again asks again', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Try again').click());
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(optimizeMock).toHaveBeenCalledTimes(2);
  });

  it('says "Based on an earlier draft" when the draft changed while it worked', async () => {
    let answer: (value: typeof RESULT) => void = () => {};
    optimizeMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await ready();
    await act(async () => optimizeButton()!.click());
    await typeDraft(`${DRAFT} and the logout page`);
    await act(async () => answer(RESULT));
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(card()!.textContent).toContain('Based on an earlier draft');
    // Use asks nothing more: it takes the suggestion.
    await act(async () => cardButton('Use').click());
    expect(box().value).toBe(GLOSS);
  });
});

describe('failure (frame 6)', () => {
  it('shows the line with Try again, the draft untouched', async () => {
    optimizeMock.mockImplementationOnce(async () => {
      throw new Error('PROMPT_OPTIMIZATION_FAILED');
    });
    await ready();
    await act(async () => optimizeButton()!.click());
    await waitForUi(() => expect(failed()).toBeTruthy());
    expect(failed()!.textContent).toContain("Couldn't optimize this draft.");
    expect(box().value).toBe(DRAFT);
    await act(async () => cardButton('Try again').click());
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(failed()).toBeNull();
    expect(optimizeMock).toHaveBeenCalledTimes(2);
  });
});

describe('the send of the optimized text (D2)', () => {
  const optimizedOf = (): unknown => sendMock.mock.calls.at(-1)?.[6];

  it('with Translation on, sends the owner-language text with the optimizer\'s prompt as its translation', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Use').click());
    await send();
    expect(sendMock.mock.calls.at(-1)?.[1]).toBe(GLOSS);
    expect(optimizedOf()).toEqual({ optimizedTranslation: OPTIMIZED });
  });

  it('without a reading copy, sends the optimized text as written', async () => {
    optimizeMock.mockImplementation(async () => ({ ...RESULT, gloss: undefined }));
    await ready();
    await openCard();
    await act(async () => cardButton('Use').click());
    await send();
    expect(sendMock.mock.calls.at(-1)?.[1]).toBe(OPTIMIZED);
    expect(optimizedOf()).toEqual({ skipTranslation: true });
  });

  it('carries nothing once the owner edits the inserted text', async () => {
    await ready();
    await openCard();
    await act(async () => cardButton('Use').click());
    await typeDraft(`${GLOSS} Also check the logout page.`);
    await send();
    expect(optimizedOf()).toBeUndefined();
  });

  it('carries nothing for the owner\'s own draft, or after Undo', async () => {
    await ready();
    await send();
    expect(optimizedOf()).toBeUndefined();
    sendMock.mockClear();
    await typeDraft(DRAFT);
    await waitForUi(() => expect(optimizeButton()?.disabled).toBe(false));
    await openCard();
    await act(async () => cardButton('Use').click());
    await key(box(), { key: 'z', metaKey: true });
    expect(box().value).toBe(DRAFT);
    await send();
    expect(optimizedOf()).toBeUndefined();
  });
});
