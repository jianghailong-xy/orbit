// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  ownerRatificationPath,
  ownerRatificationReviewPath,
  ownerRatificationSessionInboxPath,
  type OwnerRatificationEligibility,
  type OwnerRatificationPrivateRead,
  type OwnerRatificationReference,
} from '../lib/ownerRatification';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), restoreSession: vi.fn(() => new Promise(() => {})) };
});

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { SessionOwnerRatificationCard } = await import('./SessionOwnerRatificationCard');
const { WorkspaceView } = await import('./WorkspaceView');
const { OwnerRatificationReviewPage } = await import('../pages/OwnerRatificationReviewPage');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-0000000000a2';
const SESSION_UUID = '0195c0de-0000-7000-8000-0000000000a3';
const SESSION = encodeId(SESSION_UUID);
const PROJECT = encodeId('0195c0de-0000-7000-8000-0000000000a4');
const REQUEST = encodeId('0195c0de-0000-7000-8000-0000000000a5');
const OWNER = encodeId('0195c0de-0000-7000-8000-0000000000a6');
const CONTRACT = 'a'.repeat(64);
const NEXT_CONTRACT = 'e'.repeat(64);
const CTA = '0195c0de-0000-7000-8000-0000000000ff';
const SESSION_PATH = `/sessions/${SESSION}`;

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
};

const DRAFTED = {
  goal: '在 guarded 授权内完成会话内起草的工作，并保留全部审计线索',
  criteria: [
    { text: '所有对外副作用都写入可审计的 run_event', completionCriterion: 'EXECUTABLE' },
    { text: 'Owner 在会话内确认过精确 contract digest', completionCriterion: 'HUMAN_SIGNOFF' },
    { text: '每条验收标准都能被独立复核', completionCriterion: 'VERIFICATION' },
  ],
};

function eligibility(digest = CONTRACT): OwnerRatificationEligibility {
  return {
    schemaVersion: 1,
    eligible: true,
    requiresOwnerNow: true,
    state: 'ACTIVE',
    reasonCode: 'OWNER_RATIFICATION_REQUIRED',
    reason: 'An OPEN Project has a canonical automatic action blocked on the exact current contract.',
    projectStatus: 'OPEN',
    bindingStatus: 'MISSING',
    currentContractDigest: digest,
    currentContractRevision: '3',
    decisionRequestId: REQUEST,
    requestGeneration: '2',
    requestRoutingState: 'ACTIONABLE',
    requestRoutingReasonCode: 'OWNER_RATIFICATION_BLOCKING_ACTION_OBSERVED',
    activationSource: 'AUTO_DISPATCH',
    linkedObligations: [],
  };
}

function reference(digest = CONTRACT): OwnerRatificationReference {
  return {
    kind: 'OWNER_RATIFICATION',
    status: 'PENDING',
    projectId: PROJECT,
    projectTitle: '会话里起草的项目',
    coordinatorSessionId: SESSION,
    decisionRequestId: REQUEST,
    requestRevision: '2',
    obligationId: 'b'.repeat(64),
    obligationRevision: 'c'.repeat(64),
    obligationSource: 'AUTO_DISPATCH',
    contractDigest: digest,
    contractRevision: '3',
    reason: eligibility(digest).reason,
    reasonCode: 'OWNER_RATIFICATION_REQUIRED',
    owner: 'OWNER',
    ownerId: OWNER,
    evaluatedThroughWatermark: '7',
    createdAt: '2026-08-30T01:00:00.000Z',
    expiresAt: '2099-09-05T01:00:00.000Z',
    expired: false,
    eligible: true,
    eligibility: eligibility(digest),
    linkedObligations: [],
  };
}

function privateRead(digest = CONTRACT, goal = DRAFTED.goal): OwnerRatificationPrivateRead {
  const criteria = DRAFTED.criteria.map((criterion, index) => ({
    semanticHash: String(index + 1).padStart(64, '0'),
    text: criterion.text,
  }));
  const semanticContract = {
    goal,
    criteria,
    criteriaTrust: criteria.map((criterion, index) => ({
      semanticHash: criterion.semanticHash,
      completionCriterion: DRAFTED.criteria[index]!.completionCriterion,
    })),
    riskBoundary: {
      automationPolicy: 'GUARDED_AUTO',
      convergenceThresholds: null,
      unboundedAuthorizedBy: null,
    },
    permissions: { coordinatorEnabled: true, maxConcurrentTasks: 3 },
    recipients: { ownerId: OWNER, coordinatorAgentIds: [], members: [] },
    budget: { sessionBudgetPerDay: null, attemptBudget: null },
  };
  const read: OwnerRatificationPrivateRead = {
    projectId: PROJECT,
    projectTitle: '会话里起草的项目',
    coordinatorSessionId: SESSION,
    owner: 'OWNER',
    ownerId: OWNER,
    budgetDigest: '1'.repeat(64),
    contractDigest: digest,
    contractRevision: '3',
    evaluationPlanDigest: '2'.repeat(64),
    evaluationPlanRevision: '1',
    permissionDigest: '3'.repeat(64),
    recipientDigest: '4'.repeat(64),
    riskPolicyDigest: '5'.repeat(64),
    ratified: false,
    ratification: null,
    eligibility: eligibility(digest),
    auditRequests: [],
    semanticContract,
    evaluationPlan: { commands: [], environment: { instructions: 'fixture only' } },
    decisionRequest: {
      id: REQUEST,
      contractDigest: digest,
      ctaToken: CTA,
      expiresAt: '2099-09-05T01:00:00.000Z',
      payload: {},
      reasonCode: 'OWNER_RATIFICATION_REQUIRED',
      requestGeneration: '2',
      semanticDiff: { changedFields: ['goal', 'criteria'] },
      status: 'PENDING',
    },
    latestDecision: null,
    decisionSurface: {
      reference: reference(digest),
      semanticContract,
      evaluationPlan: { commands: [] },
      semanticDiff: { changedFields: ['goal', 'criteria'] },
      impact: 'exact contract only',
      impacts: {
        APPROVE: '批准 exact digest，并仅在 guarded envelope 内自动续跑。',
        DENY: '不批准；自动副作用执行保持关闭。',
      },
      recommendation: '审阅 semantic diff 后，只批准当前 exact digest。',
      noActionConsequence: '自动副作用执行保持关闭，本会话起草的工作不会开始。',
      whyNotAgent: 'Agent 用 runner 凭证起草了它，凭证无法证明它忠实转写了你说的话。',
      resumeAfterDecision: 'APPROVE 后同事务重新武装 persistent wake，自动重新进入 guarded admission。',
      options: ['APPROVE', 'DENY'],
    },
  };
  return read;
}

const SESSION_ROW = {
  id: SESSION,
  title: '和 agent 一起规划这件事',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  sessionState: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  workspaceId: WORKSPACE_ID,
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  projectId: PROJECT,
  projectTitle: '会话里起草的项目',
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T01:00:00.000Z',
  pendingApprovals: 0,
  runningBgShells: [],
  runningSubagents: [],
  controlPlaneObligations: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

function node(): HTMLDivElement {
  if (!container) throw new Error('nothing is mounted');
  return container;
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => { await vi.waitFor(assertion, { timeout: 8_000, interval: 20 }); });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnMount: true, retryOnMount: false },
      mutations: { retry: false },
    },
  });
}

async function render(element: React.ReactNode, entry: string): Promise<void> {
  client = newClient();
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={[entry]}>
          <AntApp>
            {element}
            <LocationProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

function button(text: string): HTMLButtonElement {
  const found = [...node().querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  expect(found, `button ${text}`).toBeTruthy();
  return found as HTMLButtonElement;
}

/** Everything the owner is shown about the drafted contract, in a form two surfaces can be
 *  compared field-by-field with. */
function shownContract(scope: HTMLElement) {
  const identity = scope.querySelector<HTMLElement>('.judgment-evidence-identity');
  return {
    contractDigest: identity?.dataset.contractDigest ?? null,
    decisionRequestId: identity?.dataset.decisionRequestId ?? null,
    reason: identity?.dataset.reason ?? null,
    goal: scope.querySelector('[data-owner-ratification-goal]')?.textContent?.trim() ?? null,
    criteria: [...scope.querySelectorAll<HTMLElement>('.owner-ratification-criteria li')].map(
      (item) => [item.querySelector('span')?.textContent ?? '', item.dataset.completionCriterion ?? ''],
    ),
    envelopes: [...scope.querySelectorAll<HTMLElement>('.owner-ratification-envelope-grid article')]
      .map((article) => [article.dataset.envelope ?? '', article.querySelector('dl')?.textContent ?? '']),
    consequences: [...scope.querySelectorAll<HTMLElement>('.owner-ratification-consequences > div')]
      .map((row) => [row.dataset.consequence ?? '', row.textContent ?? '']),
    whyNotAgent:
      scope.querySelector('[data-owner-ratification-why-not-agent]')?.textContent?.trim() ?? null,
  };
}

function stubWorkspaceEndpoints(extra: (path: string, options?: { method?: string }) => unknown) {
  apiMock.mockImplementation(((path: string, options?: { method?: string }) => {
    const answered = extra(path, options);
    if (answered !== undefined) return answered as Promise<never>;
    if (path === '/users/me') {
      return Promise.resolve({
        id: 'user-1', email: 'owner@example.test', name: 'Owner',
        createdAt: '2026-01-01T00:00:00Z', preferences: {},
      }) as Promise<never>;
    }
    if (path === '/providers' || path === '/session-tags' || path === '/task-lists') {
      return Promise.resolve([]) as Promise<never>;
    }
    if (path === '/workspaces') {
      return Promise.resolve([{
        id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID,
        createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude',
      }]) as Promise<never>;
    }
    if (path.startsWith('/sessions?')) return Promise.resolve([SESSION_ROW]) as Promise<never>;
    if (path === `/sessions/${SESSION}`) return Promise.resolve(SESSION_ROW) as Promise<never>;
    if (path.startsWith('/sessions/')) return Promise.resolve({ events: [], items: [] }) as Promise<never>;
    return Promise.resolve([]) as Promise<never>;
  }) as never);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  vi.stubGlobal('localStorage', {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('EventSource', class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
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
    mountedNode?.remove();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('confirming an agent-drafted contract inside the conversation that drafted it', { timeout: 20_000 }, () => {
  it('renders the drafted contract in the session view itself, with no page to jump to', async () => {
    stubWorkspaceEndpoints((path) => {
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 1, items: [reference()] });
      }
      if (path === ownerRatificationPath(PROJECT)) return Promise.resolve(privateRead());
      return undefined;
    });
    await render(<WorkspaceView runner={RUNNER as never} />, SESSION_PATH);

    await waitForUi(() => {
      expect(node().querySelector('[data-session-owner-ratification]')).toBeTruthy();
    });
    const card = node().querySelector<HTMLElement>('[data-session-owner-ratification]')!;

    // (a) It is in THIS conversation's view, and reading it navigated nowhere.
    expect(card.dataset.sessionId).toBe(SESSION);
    expect(card.dataset.contractDigest).toBe(CONTRACT);
    expect(node().querySelector('[data-testid="location"]')?.textContent).toBe(SESSION_PATH);
    expect(apiMock).toHaveBeenCalledWith(ownerRatificationSessionInboxPath(SESSION));

    // (b) Five distinct classes of what the agent actually wrote.
    const shown = shownContract(card);
    expect(shown.goal).toContain(DRAFTED.goal);
    expect(shown.criteria).toEqual(DRAFTED.criteria.map((c) => [c.text, c.completionCriterion]));
    expect(Object.fromEntries(shown.envelopes).riskBoundary).toContain('GUARDED_AUTO');
    expect(Object.fromEntries(shown.envelopes).permissions).toContain('3');
    expect(Object.fromEntries(shown.envelopes).budget)
      .toContain('未声明有限额度（null；不等于 Owner 已授权无限额度）');
    expect(card.innerHTML).not.toContain(CTA);
  });

  it('shows nothing at all in a conversation that drafted no contract', async () => {
    stubWorkspaceEndpoints((path) => {
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 0, items: [] });
      }
      return undefined;
    });
    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);
    await flush();
    expect(node().querySelector('[data-session-owner-ratification]')).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith(ownerRatificationPath(PROJECT));
  });

  it('shows the standalone review page and the conversation card the same contract', async () => {
    apiMock.mockImplementation(((path: string) => {
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 1, items: [reference()] }) as Promise<never>;
      }
      if (path === ownerRatificationPath(PROJECT)) {
        return Promise.resolve(privateRead()) as Promise<never>;
      }
      return Promise.resolve([]) as Promise<never>;
    }) as never);

    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);
    await waitForUi(() => {
      expect(node().querySelector('.owner-ratification-criteria li')).toBeTruthy();
    });
    const fromConversation = shownContract(node());
    // The card links to the same request rather than replacing it.
    expect(node().querySelector<HTMLAnchorElement>('.session-owner-ratification-review-link')?.getAttribute('href'))
      .toBe(ownerRatificationReviewPath(PROJECT, REQUEST));
    await act(async () => root!.unmount());
    container!.remove();
    client!.clear();

    await render(
      <Routes>
        <Route
          path="/judgments/owner-ratification/:projectId/:requestId"
          element={<OwnerRatificationReviewPage />}
        />
      </Routes>,
      ownerRatificationReviewPath(PROJECT, REQUEST),
    );
    await waitForUi(() => {
      expect(node().querySelector('.owner-ratification-criteria li')).toBeTruthy();
    });
    const fromReviewPage = shownContract(node());

    // (i) Same digest, same content, same one-use CTA fence — neither surface shows the token.
    expect(fromConversation).toEqual(fromReviewPage);
    expect(fromConversation.contractDigest).toBe(CONTRACT);
    expect(node().innerHTML).not.toContain(CTA);
  });

  it('says why it is not the agent’s call, and what each option costs, risks and resumes', async () => {
    apiMock.mockImplementation(((path: string) => {
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 1, items: [reference()] }) as Promise<never>;
      }
      if (path === ownerRatificationPath(PROJECT)) {
        return Promise.resolve(privateRead()) as Promise<never>;
      }
      return Promise.resolve([]) as Promise<never>;
    }) as never);
    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);
    await waitForUi(() => {
      expect(node().querySelector('.owner-ratification-consequences')).toBeTruthy();
    });
    const shown = shownContract(node());
    const consequences = Object.fromEntries(shown.consequences);

    // (j) Six things acceptance criterion 8 requires, each asserted non-empty on its own.
    expect(shown.whyNotAgent).toContain('runner 凭证');
    expect([...node().querySelectorAll('.owner-ratification-option-grid article')].map(
      (article) => (article as HTMLElement).dataset.option,
    )).toEqual(['APPROVE', 'DENY']);
    expect(node().textContent).toContain('批准 exact digest，并仅在 guarded envelope 内自动续跑。');
    expect(consequences.recommendation).toContain('只批准当前 exact digest');
    expect(consequences.noAction).toContain('自动副作用执行保持关闭');
    expect(consequences.cost).toContain('sessionBudgetPerDay');
    expect(consequences.expiry?.length).toBeGreaterThan('到期时间'.length);
    expect(consequences.resume).toContain('自动重新进入 guarded admission');
  });

  it('submits the owner’s own decision and reports the work that resumes by itself', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        posts.push({ path, body: options.body as Record<string, unknown> });
        return Promise.resolve({
          decision: 'APPROVE',
          contractDigest: CONTRACT,
          automaticResume: { scheduled: true, rearmedWakeups: 2 },
        }) as Promise<never>;
      }
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 1, items: [reference()] }) as Promise<never>;
      }
      if (path === ownerRatificationPath(PROJECT)) {
        return Promise.resolve(privateRead()) as Promise<never>;
      }
      return Promise.resolve([]) as Promise<never>;
    }) as never);
    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);
    await waitForUi(() => { expect(node().querySelector('input[type="checkbox"]')).toBeTruthy(); });

    // (g) Nothing is submitted before a click, and the buttons stay closed until acknowledged.
    expect(posts).toHaveLength(0);
    expect(button('APPROVE exact digest').disabled).toBe(true);
    await act(async () => (node().querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await flush();

    // (c) One POST, on the reader's own authenticated connection, naming the rendered digest.
    const approve = button('APPROVE exact digest');
    await act(async () => { approve.click(); approve.click(); });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(ownerRatificationPath(PROJECT));
    expect(posts[0]!.body).toMatchObject({
      decision: 'APPROVE',
      decisionRequestId: REQUEST,
      ctaToken: CTA,
      expectedContractDigest: CONTRACT,
    });
    expect(String(posts[0]!.body.idempotencyKey)).toMatch(/^owner-ratification:session:v1:/);

    // (d) The card reports the committed rearm rather than promising a resume.
    await waitForUi(() => { expect(node().textContent).toContain('APPROVE 已提交'); });
    expect(node().textContent).toContain('重新武装了 2 个持久化 wake');
    expect(node().textContent).toContain('无需第二次点击');
    expect(node().innerHTML).not.toContain(CTA);
  });

  it('refuses a contract that changed after it was rendered, then re-renders the new one', async () => {
    let digest = CONTRACT;
    let goal = DRAFTED.goal;
    const posts: Array<Record<string, unknown>> = [];
    apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        posts.push(options.body as Record<string, unknown>);
        // The agent kept editing: the server refuses the digest the reader was shown.
        digest = NEXT_CONTRACT;
        goal = `${DRAFTED.goal}（agent 在渲染之后又改了一次）`;
        return Promise.reject(
          new ApiError('conflict', 409, 'OWNER_DECISION_STALE'),
        ) as Promise<never>;
      }
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({ total: 1, items: [reference(digest)] }) as Promise<never>;
      }
      if (path === ownerRatificationPath(PROJECT)) {
        return Promise.resolve(privateRead(digest, goal)) as Promise<never>;
      }
      return Promise.resolve([]) as Promise<never>;
    }) as never);
    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);
    await waitForUi(() => { expect(node().querySelector('input[type="checkbox"]')).toBeTruthy(); });
    await act(async () => (node().querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await flush();
    await act(async () => button('APPROVE exact digest').click());
    await flush();

    // (f) The submission carried the digest that was rendered, and it failed with a typed reason.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.expectedContractDigest).toBe(CONTRACT);
    await waitForUi(() => { expect(node().textContent).toContain('OWNER_DECISION_STALE'); });
    expect(node().textContent).toContain('契约或 request 已更新');

    // …and reloading re-renders what the contract actually became.
    await act(async () => button('载入当前 request').click());
    await waitForUi(() => {
      expect(node().querySelector<HTMLElement>('.judgment-evidence-identity')?.dataset.contractDigest)
        .toBe(NEXT_CONTRACT);
    });
    expect(node().textContent).toContain('agent 在渲染之后又改了一次');
    expect(node().querySelector('[data-session-owner-ratification]')?.getAttribute('data-contract-digest'))
      .toBe(NEXT_CONTRACT);
    // Re-rendering is not consent: still exactly one submission, and it was refused.
    expect(posts).toHaveLength(1);
  });

  it('never decides by itself: expiry, retries and repeats all leave the decision unmade', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const expired = privateRead();
    expired.decisionRequest!.expiresAt = '2020-01-01T00:00:00.000Z';
    expired.decisionSurface!.reference = {
      ...reference(), expiresAt: '2020-01-01T00:00:00.000Z', expired: true,
    };
    apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        posts.push(options.body as Record<string, unknown>);
        return Promise.reject(
          new ApiError('conflict', 409, 'OWNER_DECISION_CTA_EXPIRED'),
        ) as Promise<never>;
      }
      if (path === ownerRatificationSessionInboxPath(SESSION)) {
        return Promise.resolve({
          total: 1,
          items: [{ ...reference(), expiresAt: '2020-01-01T00:00:00.000Z', expired: true }],
        }) as Promise<never>;
      }
      if (path === ownerRatificationPath(PROJECT)) return Promise.resolve(expired) as Promise<never>;
      return Promise.resolve([]) as Promise<never>;
    }) as never);
    await render(<SessionOwnerRatificationCard sessionId={SESSION} />, SESSION_PATH);

    // (g)/(h) An expired capability is refused locally: the checkbox and both buttons stay shut,
    // repeated reloads keep refusing, and no decision is ever sent.
    await waitForUi(() => { expect(node().textContent).toContain('OWNER_DECISION_CTA_EXPIRED'); });
    expect((node().querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(button('APPROVE exact digest').disabled).toBe(true);
    expect(button('DENY — 保持执行关闭').disabled).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => button('载入当前 request').click());
      await flush();
    }
    await waitForUi(() => { expect(node().textContent).toContain('OWNER_DECISION_CTA_EXPIRED'); });
    expect(posts).toHaveLength(0);
    expect(node().textContent).not.toContain('APPROVE 已提交');
    expect(node().textContent).toContain('不会产生第二条 ratification');
  });
});
