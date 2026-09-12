// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from './ApprovalPanel';
import type { ApprovalInfo } from '../api';
import { decisionRowKey, type PendingDecisionQueue, type PendingDecisionRow } from './DecisionRail';
import { DECISION_CONFIRM_ACTION, DECISION_SEND_BACK_ACTION } from './EvidenceDecisionCard';
import type { Runner } from './TasksSidePanel';

// The census at the bottom of this file mounts the real session page. It reaches the server through
// `api()`, and seeds its transcript through `getSessionEventPage` and its pending questions through
// `listApprovals` — both of which call the module's own `api` rather than the export, so all three
// are replaced. The cards above reach none of them.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listApprovals: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the page instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const seedMock = vi.mocked(getSessionEventPage);
const approvalsMock = vi.mocked(listApprovals);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const dagApproval = (over: Record<string, unknown> = {}): ApprovalInfo =>
  ({
    id: 'a1',
    toolName: 'orbit_dag_change',
    input: {
      listId: 'l1',
      note: '把 WARC 转换拆开并行跑，它不依赖去重完成。',
      preview: {
        listTitle: 'FineWeb CC-MAIN-2025-26',
        ops: [
          {
            op: 'remove',
            taskTitle: '[W 009/250] 000_00008.parquet → WARC',
            dependsOnTitle: '[D] 全局去重',
            noop: false,
          },
          { op: 'add', taskTitle: '[W 010/250] → WARC', dependsOnTitle: '[S] 采样校验', noop: true },
        ],
        changes: [
          { taskId: 't1', title: '[W 009/250] 000_00008.parquet → WARC', from: 'BLOCKED', to: 'NONE' },
        ],
        becomingRunnable: 40,
        becomingBlocked: 0,
        effectiveCount: 1,
        edgesBefore: 312,
        edgesAfter: 311,
      },
      ...(over.input as object),
    },
    ...over,
  }) as ApprovalInfo;

const render = (a: ApprovalInfo) => renderToStaticMarkup(<ApprovalPanel approval={a} onDecide={() => {}} />);

const batchApproval = (preview: Record<string, unknown>): ApprovalInfo =>
  ({ id: 'b1', toolName: 'orbit_task_batch', input: { preview } }) as ApprovalInfo;

describe('single create approval', () => {
  const create = (toolName: string, input: Record<string, unknown>): ApprovalInfo =>
    ({ id: 'c1', toolName, input }) as ApprovalInfo;

  it('names the task and shows what it is and what would settle it', () => {
    const html = render(
      create('orbit_task_create', {
        title: 'Fix login redirect',
        description: 'Users land on **/404** after signing in.',
        acceptanceCriteria: 'Signing in lands on /home',
        projectId: 'p1',
      }),
    );

    expect(html).toContain('Confirm: create task “Fix login redirect”?');
    expect(html).toContain('<strong>/404</strong>');
    expect(html).toContain('Done when');
    expect(html).toContain('Signing in lands on /home');
    expect(html).toContain('Create it');
    expect(html).toContain('Don&#x27;t create');
    // The raw tool name over a JSON dump is exactly what this card replaces.
    expect(html).not.toContain('orbit_task_create');
  });

  it('names the project and lists the criteria it states', () => {
    const html = render(
      create('orbit_project_create', {
        title: 'Checkout rewrite',
        goal: 'One-page checkout',
        acceptanceCriteriaItems: [{ text: 'p95 under 1s', verificationMethod: 'dashboard' }],
      }),
    );

    expect(html).toContain('Confirm: create project “Checkout rewrite”?');
    expect(html).toContain('One-page checkout');
    expect(html).toContain('<li>p95 under 1s</li>');
  });

  it('offers no standing yes', () => {
    // Every create is its own decision; "always allow" would switch the owner's rule off.
    for (const toolName of ['orbit_task_create', 'orbit_project_create']) {
      expect(render(create(toolName, { title: 't' }))).not.toContain('Always allow');
    }
    // The same render of an ordinary tool still offers it, so the absence above is the card's doing.
    expect(render(create('Read', { file_path: '/x' }))).toContain('Always allow');
  });
});

describe('batch create approval', () => {
  it('leads with how many actually start, not how many are written', () => {
    // Fifty tasks that wait on each other cost two runs; fifty independent ones cost fifty. The
    // titles look identical either way, which is the whole reason the counts come first.
    const html = render(batchApproval({ taskCount: 50, startingNow: 2, blocked: 48 }));

    expect(html).toContain('2 start running within the minute');
    expect(html).toContain('48 wait on a prerequisite');
    expect(html).toContain('create 50 tasks?');
  });

  it('says a root needs a manual start instead of promising it will run', () => {
    // The bug the real approval flow caught: the card claimed a task would start within the
    // minute, and it never did. Auto-run triggers on a prerequisite finishing, so a task with
    // none is never picked up — and every root of a fresh DAG is exactly that.
    const html = render(batchApproval({ taskCount: 50, startingNow: 0, needsManualStart: 50 }));

    expect(html).toContain('50 need a manual start');
    expect(html).toContain('0 start running within the minute');
  });

  it('separates tasks that cannot run from tasks that are merely waiting', () => {
    // Nothing finishing will release these — they sit until a person assigns them, and a batch
    // that is silently all of them did nothing at all.
    const html = render(batchApproval({ taskCount: 3, startingNow: 0, blocked: 0, notDispatchable: 3 }));

    expect(html).toContain('cannot run');
    expect(html).not.toContain('wait on a prerequisite');
  });

  it('shows a window of titles and counts the rest', () => {
    const html = render(
      batchApproval({
        taskCount: 40,
        startingNow: 1,
        tasks: [{ title: '[W 001/250] → WARC', dependsOnRefs: ['s0'] }],
        titlesTruncated: 39,
      }),
    );

    expect(html).toContain('[W 001/250] → WARC');
    expect(html).toContain('waits on 1');
    expect(html).toContain('+39 more');
  });

  it('draws the shape when the batch has one, and names it', () => {
    const html = render(
      batchApproval({
        taskCount: 3,
        startingNow: 0,
        needsManualStart: 1,
        blocked: 2,
        tasks: [
          { title: 'root', ref: 'r' },
          { title: 'left', ref: 'l', dependsOnRefs: ['r'] },
          { title: 'right', ref: 'x', dependsOnRefs: ['r'] },
        ],
      }),
    );

    expect(html).toContain('<svg');
    expect(html).toContain('2 in parallel after 1');
  });

  it('keeps the list when there is no shape to draw', () => {
    // Unrelated tasks have no structure; a row of disconnected boxes is a worse list than a list.
    const html = render(
      batchApproval({ taskCount: 2, startingNow: 0, tasks: [{ title: 'a' }, { title: 'b' }] }),
    );

    expect(html).not.toContain('<svg');
    expect(html).toContain('2 independent tasks');
    expect(html).toContain('a</span>');
  });

  it('offers no "always allow" — a standing yes to creating tasks is a blank cheque', () => {
    const html = render(batchApproval({ taskCount: 2, startingNow: 2 }));

    expect(html).not.toContain('Always allow');
    expect(html).toContain('Create them');
    expect(html).toContain('Create nothing');
  });
});

describe('DAG change approval', () => {
  it('leads with the consequence, which is the part the ops do not show', () => {
    // "remove 1 edge" is unremarkable until you know it releases 40 tasks, and the sweep starts
    // those within the minute. That number is the whole reason this is an approval.
    const html = render(dagApproval());

    expect(html).toContain('40 tasks become runnable');
    expect(html).toContain('start on the next sweep');
  });

  it('names the list being restructured in the question itself', () => {
    expect(render(dagApproval())).toContain('FineWeb CC-MAIN-2025-26');
  });

  it("shows the proposer's reason, since the edges alone cannot be judged", () => {
    expect(render(dagApproval())).toContain('把 WARC 转换拆开并行跑');
  });

  it('describes each edge in task titles, never ids', () => {
    const html = render(dagApproval());

    expect(html).toContain('[W 009/250] 000_00008.parquet → WARC');
    expect(html).toContain('no longer waits on');
    expect(html).toContain('[D] 全局去重');
    expect(html).not.toContain('orbit_dag_change');
  });

  it('marks an op that would change nothing', () => {
    expect(render(dagApproval())).toContain('already so');
  });

  it('offers no "always allow" — there is no repeatable form of this', () => {
    // Every batch releases a different set of tasks; a standing rule would be a blank cheque.
    const html = render(dagApproval());

    expect(html).not.toContain('Always allow');
    expect(html).toContain('Apply changes');
    expect(html).toContain('Leave the graph alone');
  });

  it('conjugates the singular case', () => {
    const html = render(
      dagApproval({
        input: { preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 1 } },
      }),
    );

    expect(html).toContain('1 task stops being runnable');
  });

  it('drops the edge caption when there are no edges to caption', () => {
    const html = render(
      dagApproval({
        input: { preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 0 } },
      }),
    );

    expect(html).not.toContain('Edges written');
  });

  it('does not call a task freed of its last prerequisite runnable', () => {
    // BLOCKED -> NONE reads like a release and is not one: nothing is left to trigger it.
    const html = render(
      dagApproval({
        input: {
          preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingManual: 3, becomingBlocked: 0 },
        },
      }),
    );

    expect(html).toContain('3 stop waiting, but now need a manual start');
    expect(html).not.toContain('become runnable');
  });

  it('says so plainly when a restructure moves no task', () => {
    const html = render(
      dagApproval({
        input: {
          preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 0 },
        },
      }),
    );

    expect(html).toContain('No task changes state');
  });

  it('still renders an ordinary tool approval as the raw input', () => {
    const html = renderToStaticMarkup(
      <ApprovalPanel
        approval={{ id: 'b1', toolName: 'Bash', input: { command: 'ls -la' } } as ApprovalInfo}
        onDecide={() => {}}
      />,
    );

    expect(html).toContain('Approve tool call: Bash');
    expect(html).toContain('ls -la');
  });
});

/**
 * One waiting completion decision, one entry: a census over the session page as it is composed.
 *
 * The page puts a completion decision in front of a reader in one place — Orbit's evidence card,
 * drawn from the pending read (`EvidenceDecisionCard.tsx`). The second entry used to come from
 * this file: an `AskUserQuestion` offering `Confirm completion` / `Send back` whose text named a
 * waiting row was taken for that decision and drawn with the same verdicts, and two entries for
 * one question raced on 2026-09-09. So this mounts the real `WorkspaceView` for a coordinator
 * conversation with one row waiting AND such a question pending, and counts what is on screen
 * rather than asking whether some function recognises something: the verdicts appear once, on the
 * evidence card, and the question is the ordinary form every question is.
 *
 * It has to be the real page. A card rendered on its own is handed only what a test passes it, so
 * it cannot see a page that hands the question the pending read again.
 */
describe('one waiting completion decision on the session page', { timeout: 30_000 }, () => {
  const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
  const WORKSPACE_ID = encodeId('0195c0de-0000-7000-8000-000000000042');
  const SESSION_ID = encodeId('0195c0de-0000-7000-8000-000000000043');
  const PROJECT_ID = encodeId('0195c0de-0000-7000-8000-000000000044');

  const RUNNER = {
    id: RUNNER_ID,
    name: 'mac-01',
    online: true,
    maxConcurrent: 2,
    activeSessions: 1,
    engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  } satisfies Runner;

  /** The project's coordinator conversation, mid-turn, so the question below is still live. */
  const COORDINATOR = {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    runnerId: RUNNER_ID,
    projectId: PROJECT_ID,
    title: 'coordinating the evidence card',
    status: 'RUNNING',
    runStatus: 'RUNNING',
    runState: 'RUNNING',
    engineTurnActive: true,
    provider: 'claude',
    createdAt: '2026-09-10T13:00:00Z',
    updatedAt: '2026-09-10T13:27:00Z',
  };

  /** The one row waiting, as the pending read publishes it to that conversation. */
  const WAITING: PendingDecisionRow = {
    taskId: encodeId('0195c0de-0000-7000-8000-000000000045'),
    title: '拆掉裁决卡特例',
    projectId: PROJECT_ID,
    criterion: { key: '7UuR4yLsKJnDBlj2lNSv7G', text: '同一条待决证据在 Web 上只有一个可操作的裁决入口' },
    evidenceRevision: '3',
    ageSeconds: 10 * 60,
    claim: '待决栏指向系统卡，问题卡不再被当成裁决卡。',
    gaps: [],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
  };

  const QUEUE: PendingDecisionQueue = {
    decidingSessionId: SESSION_ID,
    count: 1,
    oldestAgeSeconds: WAITING.ageSeconds,
    pending: [WAITING],
    waitingOnYou: [],
  };

  /**
   * A pending question about that same row, worded the way the coordinator's ask was: the two
   * answers, and the task and revision in its text. Everything a page would need to take it for
   * the decision is in it, which is what makes it the fixture.
   */
  const LOOKALIKE = {
    id: 'approval-lookalike',
    sessionId: SESSION_ID,
    toolName: 'AskUserQuestion',
    status: 'PENDING',
    createdAt: '2026-09-10T13:26:00Z',
    input: {
      questions: [{
        question:
          `${WAITING.claim}\n\n${WAITING.title} — task ${WAITING.taskId}, evidence rev ${WAITING.evidenceRevision}`,
        header: 'Completion',
        options: [
          { label: 'Confirm completion', description: 'This evidence settles the criterion it quotes.' },
          { label: 'Send back', description: 'It does not settle it.' },
        ],
        multiSelect: false,
      }],
    },
  } as ApprovalInfo;

  const VERDICTS = [DECISION_CONFIRM_ACTION, DECISION_SEND_BACK_ACTION];

  class FakeEventSource {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {}
    close() {}
  }

  const unstubbed: string[] = [];
  const scrolled: Element[] = [];
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    unstubbed.length = 0;
    scrolled.length = 0;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
    apiMock.mockReset();
    seedMock.mockReset();
    seedMock.mockImplementation(async () => ({ events: [], hasMore: false }));
    // Already pending when the page opens, as after a refresh or a deep link.
    approvalsMock.mockReset();
    approvalsMock.mockImplementation(async (sessionId: string) => (sessionId === SESSION_ID ? [LOOKALIKE] : []));
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (path.startsWith(`/sessions/${SESSION_ID}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/turns')) return reply([]);
        if (path.includes('/background')) return reply([]);
        if (path.includes('/diff')) return reply({ files: [] });
        return reply(COORDINATOR);
      }
      if (path.startsWith('/sessions')) return reply([COORDINATOR]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) return reply(QUEUE);
      if (path.startsWith(`/projects/${PROJECT_ID}/acceptance/criteria-decisions/pending`)) {
        return reply({ readAt: '2026-09-10T13:27:00Z', projectId: PROJECT_ID, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [] });
      }
      // The settlement card's two reads, which a coordinator conversation makes too: a project that
      // states no criteria, so that card stays off this page.
      if (path === `/projects/${PROJECT_ID}/acceptance/confirmation`) {
        return reply({ state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: 'a'.repeat(64), material: [] }, confirmation: null });
      }
      if (path === `/projects/${PROJECT_ID}`) return reply({ id: PROJECT_ID, acceptanceCriteriaItems: [] });
      if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      if (path === '/providers' || path === '/session-tags' || path === '/task-lists' || path === '/runners') return reply([]);
      unstubbed.push(path);
      return reply([]);
    });
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

  const waitForUi = async (assertion: () => void): Promise<void> => {
    await act(async () => {
      await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
    });
  };

  /** The question cards on the page — every approval card that is not one of Orbit's own. */
  const questionCards = (scope: HTMLElement): HTMLElement[] =>
    [...scope.querySelectorAll<HTMLElement>('.approval-card')].filter(
      (card) => !card.matches('.evidence-decision, .criteria-decision'),
    );

  /** Every control in scope labelled with one of the two verdicts, in document order. */
  const verdictControls = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll('button')]
      .map((button) => (button.textContent ?? '').trim())
      .filter((label) => VERDICTS.includes(label));

  async function sessionPage(): Promise<HTMLDivElement> {
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
          <MemoryRouter initialEntries={[`/sessions/${SESSION_ID}`]}>
            <AntApp>
              <WorkspaceView runner={RUNNER} />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // Both entries a reader could meet: the evidence card, drawn once the session row names its
    // project and the read is back, and the question, fetched behind the session-switch debounce.
    // Held until both are there, so nothing below is a census of a page still loading.
    await waitForUi(() => {
      expect(nextContainer.querySelector('.evidence-decision'), 'the evidence card was not drawn').not.toBeNull();
      expect(questionCards(nextContainer), 'the pending question never reached the page').toHaveLength(1);
    });
    expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
    return nextContainer;
  }

  it('puts one set of verdicts on the page, and it is the evidence card’s', async () => {
    const page = await sessionPage();
    const card = page.querySelector<HTMLElement>('.evidence-decision')!;

    // A census, not a search: every verdict control on the whole page, wherever it came from.
    expect(verdictControls(page), 'verdict controls on the session page').toEqual(VERDICTS);
    // All of them on the card drawn for the waiting row, and pressable there.
    expect(card.getAttribute('data-decision-row')).toBe(decisionRowKey(WAITING));
    expect(verdictControls(card)).toEqual(VERDICTS);
    for (const button of card.querySelectorAll<HTMLButtonElement>('button.card-action')) {
      expect(button.disabled, `${button.textContent} is on the card but cannot be pressed`).toBe(false);
    }
  });

  it('draws the question that reads like the verdict as the ordinary question form', async () => {
    const page = await sessionPage();
    const [question] = questionCards(page);

    // What every question gets: its own options as picks, a field to type an answer, and Submit.
    expect(
      [...question.querySelectorAll('.chat-q-opt-btn .chat-q-opt-label')].map((label) => label.textContent),
    ).toEqual(['Confirm completion', 'Send back']);
    expect(question.querySelector('input.chat-q-custom'), 'the typed-answer field is missing').not.toBeNull();
    expect([...question.querySelectorAll('button')].map((button) => button.textContent)).toContain('Submit');
    // And nothing of the decision: not its card, no handle for the rail, none of its verdicts.
    expect(question.classList.contains('decision-ask'), 'the question is drawn as a decision card').toBe(false);
    expect(question.querySelector('[data-decision-row]'), 'the question publishes a handle for the rail').toBeNull();
    expect(verdictControls(question)).toEqual([]);
  });

  it('points the pinned strip’s line at the evidence card', async () => {
    const page = await sessionPage();
    const lines = [...page.querySelectorAll<HTMLButtonElement>('.decision-strip-line')];
    expect(lines, 'the waiting row is not a line on this page').toHaveLength(1);

    scrolled.length = 0;
    await act(async () => {
      lines[0].click();
    });
    expect(scrolled).toEqual([page.querySelector('.evidence-decision')]);
  });
});
