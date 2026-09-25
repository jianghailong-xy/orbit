// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import type { PendingDecisionQueue, PendingDecisionRow } from './DecisionRail';
import {
  DECISION_CONFIRM_ACTION,
  DECISION_SEND_BACK_LABEL,
  DECISION_SENDING_BACK_PREFIX,
} from './EvidenceDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * The evidence card's second answer where the person meets it: `Chat about this` arms the ONE
 * composer at the bottom of the page and presses nothing, and the send that follows answers the
 * judgment instead of starting a turn.
 *
 * The card's own spec settles what it draws and that it hands the row over. What only the real view
 * can show is that the handoff lands on the composer, that the card survives it with its confirm
 * still live, and that the typed sentence ends at the decision door — as SEND_BACK + note, from the
 * session the card is drawn in — rather than as a message to the agent. A test that stubbed the send
 * would be asserting its own stub, so `WorkspaceView` is mounted for real.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // Both call the module-local `api`, so replacing the exported one alone would not reach them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listApprovals: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000061';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000062');
const COORDINATOR_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000063');
const PROJECT_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000064');
const TASK_PUBLIC = '34RbuNXw8QaZQj2wxuG6hJ';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const COORDINATOR = {
  id: COORDINATOR_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: PROJECT_PUBLIC,
  title: 'coordinating the evidence',
  status: 'RUNNING',
  runStatus: 'RUNNING',
  runState: 'RUNNING',
  engineTurnActive: false,
  provider: 'claude',
  createdAt: '2026-09-19T03:00:00Z',
  updatedAt: '2026-09-19T03:10:00Z',
};

/** One version of one task's evidence, waiting on this session — decidable and independent, which
 *  is the pair of facts the card's own filter keeps. */
const ROW: PendingDecisionRow = {
  taskId: TASK_PUBLIC,
  title: '清掉 runner-go 的死常量 projectStatusJSON',
  projectId: PROJECT_PUBLIC,
  criterion: { key: 'P1j4o9DGjyjzmqoCr1cLQ', text: '删除之后，五处全部为零' },
  evidenceRevision: '2',
  ageSeconds: 600,
  claim: '函数体、约束、索引、视图、触发器五处已全部为零。',
  gaps: ['仓库全域还留着历史迁移与注释。'],
  citations: [{ kind: 'TOOL_CALL', ref: 'toolu_held', resolved: true, reason: null, label: 'Bash · grep' }],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
};

const QUEUE: PendingDecisionQueue = {
  decidingSessionId: COORDINATOR_PUBLIC,
  count: 1,
  oldestAgeSeconds: 600,
  pending: [ROW],
  waitingOnYou: [],
};

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

/** Every write the page made, as path + body, so "where the sentence went" is readable. */
const writes: Array<{ path: string; body: unknown }> = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const count = (selector: string): number => mounted().querySelectorAll(selector).length;

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  writes.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({
    events: [
      { seq: 1, type: 'assistant', payload: { text: 'coordinator opening' }, turnId: 'turn-1', ts: '2026-09-19T03:10:00Z' },
    ],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (options?.method === 'POST') {
      writes.push({ path, body: options.body });
      // The door's receipt, in the shape the caller reads back.
      return reply({
        taskId: ROW.taskId,
        evidenceRevision: ROW.evidenceRevision,
        decision: 'SEND_BACK',
        note: (options.body as { note?: string } | undefined)?.note ?? null,
        decidedAt: '2026-09-19T03:20:00.000Z',
      });
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      return reply({ id: PROJECT_PUBLIC, title: 'the dead constant', status: 'OPEN', coordinatorEnabled: true, acceptanceCriteriaItems: [] });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/open-items`) {
      return reply({ needsYou: [], withCoordinator: [] });
    }
    // The two reads the cards beside this one derive from. Empty and already confirmed: this file
    // is about the evidence card's handoff, and an unstubbed read here would break the pane by
    // being unstubbed rather than by being wrong.
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      return reply({
        readAt: '2026-09-19T03:10:00.000Z',
        projectId: PROJECT_PUBLIC,
        count: 0,
        oldestAgeSeconds: null,
        decidableCount: 0,
        pending: [],
      });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      return reply({
        state: 'CONFIRMED',
        confirmed: true,
        currentVersion: { digest: 'seal', material: [] },
        confirmation: null,
      });
    }
    if (path.startsWith('/users/me')) {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${COORDINATOR_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(COORDINATOR);
    }
    if (path.startsWith('/sessions')) return reply([COORDINATOR]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) return reply(QUEUE);
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
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
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(): Promise<void> {
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
        <MemoryRouter initialEntries={[`/sessions/${COORDINATOR_PUBLIC}`]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(count('.evidence-decision:not(.evidence-decision-receipt)')).toBe(1);
  });
}

const card = (): HTMLElement =>
  mounted().querySelector<HTMLElement>('.evidence-decision:not(.evidence-decision-receipt)')!;

/** The words ON a button. A card that holds the keyboard draws its key inside the button it
 *  presses (`CardHotkey.ts`), as a span of its own: what the control does is the label, and what
 *  presses it is not. */
const labelOf = (button: HTMLButtonElement): string => {
  const hint = button.querySelector<HTMLElement>('.approval-kbd');
  const text = button.textContent ?? '';
  return (hint?.textContent ? text.replace(hint.textContent, '') : text).trim();
};

/** The card's own actions, by the words on them. */
const cardActions = (): Array<{ label: string; button: HTMLButtonElement }> =>
  [...card().querySelectorAll<HTMLButtonElement>('button.card-action')].map((button) => ({
    label: labelOf(button),
    button,
  }));

const composer = (): HTMLTextAreaElement =>
  mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;

async function type(text: string): Promise<void> {
  const box = composer();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send(): Promise<void> {
  // The composer's own send, under either of the two words it wears: a task-bound session posts as
  // "Add to current work" rather than as a next turn.
  const button = mounted().querySelector<HTMLButtonElement>(
    'button[aria-label="Send"], button[aria-label="Add to current work"]',
  );
  if (!button) throw new Error('no Send on screen');
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('Chat about this on the evidence card', { timeout: 60_000 }, () => {
  it('arms the composer with this version, keeps the card up with Confirm done live, and reaches no door', async () => {
    await mount();

    expect(cardActions().map((action) => action.label)).toEqual([
      DECISION_CONFIRM_ACTION,
      OWNER_SEND_BACK_ACTION,
    ]);
    expect(count('.composer-replyto'), 'the composer was already armed').toBe(0);
    // No box grew inside the card: the place a reason is typed is the composer this press arms.
    expect(card().querySelectorAll('textarea, input')).toHaveLength(0);

    await act(async () => {
      cardActions()[1]!.button.click();
    });

    await waitForUi(() => {
      expect(count('.composer-replyto')).toBe(1);
    });
    expect(mounted().querySelector('.composer-replyto-text')?.textContent)
      .toBe(`${DECISION_SENDING_BACK_PREFIX}${ROW.title}`);
    expect(composer().placeholder).toBe(DECISION_SEND_BACK_LABEL);

    // The card is still there and its own way out is still live, and arming wrote nothing.
    expect(count('.evidence-decision:not(.evidence-decision-receipt)')).toBe(1);
    expect(cardActions()[0]!.button.disabled, 'Confirm done went dead with the handoff').toBe(false);
    expect(writes, 'arming the composer wrote something').toEqual([]);
  });

  it('sends the typed reason to the decision door as this session’s SEND_BACK, and starts no turn', async () => {
    await mount();
    await act(async () => {
      cardActions()[1]!.button.click();
    });
    await waitForUi(() => {
      expect(count('.composer-replyto')).toBe(1);
    });

    await type('把 pg spec 跑一遍，贴出改前先红的输出');
    await send();
    await waitForUi(() => {
      expect(writes).toHaveLength(1);
    });

    // The door's own body: which version, decided FROM this session — the door runs its
    // independence check on that session, so a browser is never the answerer.
    expect(writes[0]).toEqual({
      path: `/tasks/${ROW.taskId}/evidence/decision`,
      body: {
        decidingSessionId: COORDINATOR_PUBLIC,
        evidenceRevision: ROW.evidenceRevision,
        decision: 'SEND_BACK',
        note: '把 pg spec 跑一遍，贴出改前先红的输出',
      },
    });
    // And it is not a message: no turn was started, and the bar is down again.
    expect(writes.filter((write) => write.path.includes('/turns'))).toEqual([]);
    expect(count('.composer-replyto')).toBe(0);
    expect(composer().value).toBe('');
  });
});
