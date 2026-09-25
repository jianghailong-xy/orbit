// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer of a run the platform has already replaced.
 *
 * The reported path: a task's run dies on a 429, `rearmEndedAutoRuns` starts another one two
 * seconds later on a different provider, and the person is still looking at the dead one. What
 * they do next — switch provider, type, send — used to end in a 409 printed in English with the
 * message undelivered. What is asserted here is the whole of what replaced it: the message is
 * carried to the run that has the task and the reader is taken there; a refusal that cannot be
 * routed says what happened in words with the run one click away; a pick that would mean ENDING
 * the run that is going is asked about and stops nothing until it is answered.
 *
 * Mounted for real, because every one of those is a claim about what the composer SENDS, and a
 * component test that stubbed the send would be asserting its own stub.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    // The send re-reads the row before it posts — a cached terminal decision is never enough to
    // POST /resume from — so this door is on the path too.
    getSession: vi.fn(),
    resumeSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, resumeSession } =
  await import('../api');
const { ApiError } = await import('../api');
const apiMock = vi.mocked(api);
const resumeMock = vi.mocked(resumeSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
const {
  KEEP_IT_RUNNING,
  OPEN_THE_RUN,
  STOP_AND_CONTINUE,
  TASK_RUN_HANDED_OVER_TITLE,
  TASK_RUN_HELD_TITLE,
  TASK_RUN_SWITCH_TITLE,
} = await import('../lib/taskRunHandoff');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000b1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
/** The dead run the reader is looking at. */
const DEAD_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');
/** The run the platform started in its place, which holds the task. */
const LIVE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b4');
const TASK_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b5');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const DEAD_SESSION = {
  id: DEAD_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  taskId: TASK_PUBLIC,
  title: '执行任务：修 login 跳转',
  status: 'FAILED',
  provider: 'claude',
  numTurns: 12,
  retryAt: null,
  retryAttempts: 0,
  // Ended, with its context still on the runner: the row a resume revives.
  startedAt: '2026-09-18T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-09-18T01:10:00Z',
  updatedAt: '2026-09-18T01:18:00Z',
};

/** Its replacement: same task, still going. This is what makes the task's run "not you". */
const LIVE_SESSION = {
  ...DEAD_SESSION,
  id: LIVE_PUBLIC,
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-18T01:18:02Z',
  updatedAt: '2026-09-18T01:18:02Z',
};

const HELD_MESSAGE =
  `task ${TASK_PUBLIC} could not be started: session ${LIVE_PUBLIC} (RUNNING) holds its execution `
  + 'claim. Let that run reach a terminal status of its own, then start the task again';

const heldRefusal = () =>
  new ApiError(HELD_MESSAGE, 409, 'TASK_ALREADY_RUNNING', {
    code: 'TASK_ALREADY_RUNNING',
    message: HELD_MESSAGE,
    taskId: TASK_PUBLIC,
    conflictingSessionId: LIVE_PUBLIC,
    conflictingSessionStatus: 'RUNNING',
    retryable: true,
  });

const confirmationRefusal = () =>
  new ApiError('…English about execution claims…', 409, 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED', {
    code: 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED',
    message: '…English about execution claims…',
    confirmationRequired: true,
    confirm: { field: 'stopSessionId', value: LIVE_PUBLIC },
    runningProvider: 'claude',
    requestedProvider: 'deepseek',
    taskId: TASK_PUBLIC,
    conflictingSessionId: LIVE_PUBLIC,
    conflictingSessionStatus: 'RUNNING',
    retryable: false,
  });

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

const TAIL = [
  { seq: 11, type: 'user', payload: { text: '继续干活' } },
  { seq: 12, type: 'assistant', payload: { text: 'API Error: 429 rate limit' } },
];

describe('sending into a run the platform has already replaced', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let path = '';

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const composer = (): HTMLTextAreaElement => {
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea');
    if (!box) throw new Error(`no composer on screen:\n${mounted().innerHTML.slice(0, 1500)}`);
    return box;
  };
  /** The composer's own block — never the transcript card's, which answers its own press. */
  const handoff = (): HTMLElement | null =>
    mounted().querySelector<HTMLElement>('.run-handoff:not(.chat-quota-handoff)');
  const providerNote = (): string =>
    mounted().querySelector<HTMLElement>('.composer-provider-note')?.textContent ?? '';
  /** Every button/link inside the handoff block, by the words on it. */
  const handoffActions = (): HTMLElement[] =>
    Array.from(handoff()?.querySelectorAll<HTMLElement>('button, a') ?? []);
  const pressHandoff = async (label: string): Promise<void> => {
    const target = handoffActions().find((el) => el.textContent === label);
    if (!target) {
      throw new Error(
        `no "${label}" on the handoff block; it offers `
        + JSON.stringify(handoffActions().map((el) => el.textContent)),
      );
    }
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const type = async (text: string): Promise<void> => {
    const box = composer();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const sendButton = (): HTMLButtonElement => {
    const button = mounted().querySelector<HTMLButtonElement>(
      'button[aria-label="Send"], button[aria-label="Add to current work"]',
    );
    if (!button) throw new Error(`no Send on screen:\n${mounted().innerHTML.slice(0, 1500)}`);
    return button;
  };

  const send = async (): Promise<void> => {
    await act(async () => {
      sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  /** The router's current location, so "took the reader there" is readable. */
  function Probe() {
    path = useLocation().pathname;
    return null;
  }

  const mount = async (): Promise<void> => {
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: TAIL, hasMore: false } as never);
    const nextClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const nextContainer = document.createElement('div');
    const nextRoot = createRoot(nextContainer);
    client = nextClient;
    container = nextContainer;
    root = nextRoot;
    document.body.appendChild(nextContainer);
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${DEAD_PUBLIC}`]}>
            <AntApp>
              <Probe />
              <Routes>
                <Route path="*" element={<WorkspaceView runner={RUNNER} />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.composer-box textarea')).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    path = '';
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    resumeMock.mockReset();
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async (id: string) =>
      (id === LIVE_PUBLIC ? LIVE_SESSION : DEAD_SESSION) as never,
    );
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '继续干活' });
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    apiMock.mockImplementation((p: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/providers') {
        // A configured provider borrowing the claude runtime — claude ↔ deepseek is a switch the
        // platform allows (same runtime), which is what makes this pick offerable at all.
        return reply([
          { slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', models: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }], defaultModel: 'deepseek-chat' },
        ]);
      }
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (p.startsWith(`/sessions/${DEAD_PUBLIC}`)) {
        if (p.includes('/events/page')) return reply({ events: TAIL, hasMore: false });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        if (p.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(DEAD_SESSION);
      }
      if (p.startsWith(`/sessions/${LIVE_PUBLIC}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        if (p.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(LIVE_SESSION);
      }
      if (p.startsWith('/sessions')) return reply([DEAD_SESSION, LIVE_SESSION]);
      if (p.includes('/owner-confirmation')) {
        return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      }
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
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
      document.body.innerHTML = '';
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  const pickProvider = async (label: string, pill?: HTMLElement): Promise<HTMLElement> => {
    // `.ant-select-content`, not `.ant-select-selector`: antd 6 renamed its private DOM classes.
    // A test that picks TWICE has to hold the `.ant-select` around it: the first pick changes the
    // text this finds the control by, and it is still the same control.
    const root = pill ?? Array.from(
      mounted().querySelectorAll<HTMLElement>('.composer-pills .ant-select'),
    ).find((el) => el.textContent?.toLowerCase().includes('claude'));
    const selector = root?.querySelector<HTMLElement>('.ant-select-content');
    if (!root || !selector) {
      throw new Error(
        'no provider pill on the composer; pills say '
        + JSON.stringify(
          Array.from(mounted().querySelectorAll('.composer-pills .ant-select')).map(
            (el) => el.textContent,
          ),
        ),
      );
    }
    await act(async () => {
      selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await vi.waitFor(
        () => expect(document.querySelectorAll('.ant-select-item-option').length).toBeGreaterThan(1),
        { timeout: 20_000, interval: 20 },
      );
    });
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('.ant-select-item-option'),
    ).find((el) => el.textContent?.includes(label));
    if (!option) {
      throw new Error(
        `no "${label}" option; the pill offers `
        + JSON.stringify(
          Array.from(document.querySelectorAll('.ant-select-item-option')).map((el) => el.textContent),
        ),
      );
    }
    await act(async () => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    return root;
  };

  it('says when a provider pick takes effect, while the pick still stands', async () => {
    // A run keeps its provider for its whole life, so a pick made while one is going cannot touch
    // it — it lands on the next turn. That timing is the whole content of the notice, and what
    // the four-second `Model → DeepSeek` it replaced never said. The run that is going is this
    // task's OTHER session: the one the platform started when this one died.
    await mount();
    expect(providerNote()).toBe('');

    await pickProvider('DeepSeek');

    await act(async () => {
      await vi.waitFor(() => expect(providerNote()).not.toBe(''), { timeout: 20_000, interval: 20 });
    });
    const note = providerNote();
    expect(note).toContain('deepseek');
    expect(note).toContain('claude');
    expect(note.toLowerCase()).toContain('next');
    // It is not a four-second flash: nothing removes it while the pick stands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_500));
    });
    expect(providerNote()).toBe(note);
  });

  it('leaves the reader alone when the pick is the provider the live run is already on', async () => {
    // The other half of the confirmation, and the half a bug would hide in: a pick that is NOT a
    // switch must not become a question. The task's run in flight is on claude, and so is the run
    // the reader is looking at — so picking claude back is picking what is already running. The
    // composer says nothing, and nothing about stopping a run is ever put in front of the reader.
    resumeMock.mockResolvedValue({
      turnId: 't-3', seq: 5, kind: 'message', placement: 'queued', routedToSessionId: LIVE_PUBLIC,
    } as never);
    await mount();

    // Two picks, because a select does not report a click on the value it is already showing: the
    // first is a real switch and says so, which is what makes the second one's silence mean
    // something rather than "no pick was ever made".
    const pill = await pickProvider('DeepSeek');
    await act(async () => {
      await vi.waitFor(() => expect(providerNote()).not.toBe(''), { timeout: 20_000, interval: 20 });
    });
    await pickProvider('Claude', pill);
    expect(providerNote()).toBe('');

    await type('继续干活');
    await send();

    // The pick LANDED: the resume names claude, the provider the run in flight is on.
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0][2]).toMatchObject({ provider: 'claude' });
    // Nothing was asked and nothing was authorised: the send carries no `stopSessionId` — the one
    // field that can ever stop a run — and no confirmation is on screen.
    expect(resumeMock.mock.calls[0][6]).toBeUndefined();
    expect(mounted().querySelector('.run-handoff[data-conflict="CONFIRM_SWITCH"]')).toBeNull();
  });

  it('carries the message to the run that has the task, and takes the reader there', async () => {
    // Contract §2.1: the server routed it, and says so by naming where it landed.
    resumeMock.mockResolvedValue({
      turnId: 't-1', seq: 3, kind: 'message', placement: 'queued', routedToSessionId: LIVE_PUBLIC,
    } as never);
    await mount();
    await type('继续干活');
    await send();

    expect(resumeMock).toHaveBeenCalledTimes(1);
    // The message was sent from the session the reader had open — the routing is the server's.
    expect(resumeMock.mock.calls[0][0]).toBe(DEAD_PUBLIC);
    expect(resumeMock.mock.calls[0][1]).toBe('继续干活');
    // Taken there, rather than told about it: the run working on their message is where they
    // wanted to be all along.
    expect(path).toBe(`/sessions/${encodeId(LIVE_PUBLIC)}`);
    await act(async () => {
      await vi.waitFor(() => expect(handoff()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    expect(handoff()!.textContent).toContain(TASK_RUN_HANDED_OVER_TITLE);
    // It is a success, so the composer is cleared: the message WAS sent.
    expect(composer().value).toBe('');
  });

  it('says what happened in words, not in the server’s English, when it cannot be routed', async () => {
    // A message carrying files is not routed (§2.4: attachments are anchored to their session),
    // and this is the refusal that comes back.
    resumeMock.mockRejectedValue(heldRefusal());
    await mount();
    await type('继续干活');
    await send();

    await act(async () => {
      await vi.waitFor(() => expect(handoff()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    const shown = handoff()!.textContent ?? '';
    expect(shown).toContain(TASK_RUN_HELD_TITLE);
    expect(shown).not.toContain('execution claim');
    expect(shown).not.toContain('terminal status');
    expect(shown).not.toContain(LIVE_PUBLIC);
    // The way out is a real link to the run that has it.
    const open = handoffActions().find((el) => el.textContent === OPEN_THE_RUN);
    expect(open).toBeDefined();
    expect(open!.getAttribute('href')).toBe(`/sessions/${encodeId(LIVE_PUBLIC)}`);
    // Nothing was delivered, so the draft is still the reader's.
    expect(composer().value).toBe('继续干活');
  });

  it('asks before stopping the run that is going, and stops nothing until it is answered', async () => {
    resumeMock.mockRejectedValue(confirmationRefusal());
    await mount();
    await type('继续干活');
    await send();

    await act(async () => {
      await vi.waitFor(() => expect(handoff()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    expect(handoff()!.textContent).toContain(TASK_RUN_SWITCH_TITLE);
    // Both providers named: that is the choice being made. Neither is the server's sentence.
    expect(handoff()!.textContent).toContain('claude');
    expect(handoff()!.textContent).toContain('deepseek');
    expect(handoff()!.textContent).not.toContain('English about execution claims');
    // THE ASSERTION THIS EXISTS FOR: the send that was refused carried no authorisation to stop
    // anything, and none has been given yet.
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0][6]).toBeUndefined();

    // Declining leaves the run alone and sends nothing more.
    await pressHandoff(KEEP_IT_RUNNING);
    expect(handoff()).toBeNull();
    expect(resumeMock).toHaveBeenCalledTimes(1);
  });

  it('stops that one run, and only on the reader’s word, naming the run they were shown', async () => {
    resumeMock.mockRejectedValueOnce(confirmationRefusal());
    resumeMock.mockResolvedValueOnce({
      turnId: 't-2', seq: 4, kind: 'message', placement: 'accepted',
    } as never);
    await mount();
    await type('继续干活');
    await send();

    await act(async () => {
      await vi.waitFor(() => expect(handoff()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    await pressHandoff(STOP_AND_CONTINUE);

    expect(resumeMock).toHaveBeenCalledTimes(2);
    const confirmed = resumeMock.mock.calls[1];
    // It names the run the reader was shown, so a claim that changed hands in between asks again
    // rather than being stopped on a confirmation about somebody else's run.
    expect(confirmed[6]).toBe(LIVE_PUBLIC);
    // Same message, same idempotency key: answering the question is not a second send.
    expect(confirmed[1]).toBe('继续干活');
    expect(confirmed[5]).toBe(resumeMock.mock.calls[0][5]);
  });
});
