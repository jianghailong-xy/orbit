// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { judgmentReviewPath, shortDigest, type JudgmentReview } from '../lib/judgments';
import { JudgmentReviewPage } from './JudgmentReviewPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const REQUEST = encodeId('019fcda0-d021-72a2-a914-2f4de38f4801');
const CURRENT_REQUEST = encodeId('019fcda0-d021-72a2-a914-2f4de38f4802');
const TASK = encodeId('019fcda0-d021-72a2-a914-2f4de38f4803');
const DEPENDENT = encodeId('019fcda0-d021-72a2-a914-2f4de38f4804');
const PROJECT = encodeId('019fcda0-d021-72a2-a914-2f4de38f4805');
const EVIDENCE = encodeId('019fcda0-d021-72a2-a914-2f4de38f4806');
const CURRENT_EVIDENCE = encodeId('019fcda0-d021-72a2-a914-2f4de38f4807');
const ACTOR = encodeId('019fcda0-d021-72a2-a914-2f4de38f4808');
const SESSION = encodeId('019fcda0-d021-72a2-a914-2f4de38f4809');
const DIGEST = 'a'.repeat(64);
const NEW_DIGEST = 'b'.repeat(64);
const CRITERION_ONE = '<img src=x onerror="window.__unsafe=true"> 两种手机视口不得横向滚动';
const CRITERION_TWO = '提交者 PASS 必须明确标成提交者结论';
const FULL_OUTPUT_MARKER = 'FULL_OUTPUT_ONLY_AFTER_SECOND_DISCLOSURE';
const TEST_SUMMARY_MARKER = 'TEST_SUMMARY_RAW_ONLY';
const CRITERION_RAW_MARKER = 'CRITERION_RAW_ONLY';

const request: JudgmentReview['request'] = {
  id: REQUEST,
  taskId: TASK,
  evidenceId: EVIDENCE,
  criterionRevision: 'c'.repeat(64),
  evidenceDigest: DIGEST,
  kind: 'EVIDENCE_JUDGMENT',
  recipientType: 'ACCOUNT_OWNER',
  recipientId: ACTOR,
  status: 'OPEN',
  createdAt: '2026-08-26T08:00:00.000Z',
  decidedAt: null,
  decidedByType: null,
  decidedById: null,
  decision: null,
  decisionNote: null,
  supersededAt: null,
  supersededById: null,
};

const structuredEvidence = {
  schemaVersion: 1,
  kind: 'TASK_COMPLETION_EVIDENCE',
  commit: '0123456789abcdef0123456789abcdef01234567',
  task: { criterionSnapshot: [CRITERION_ONE, CRITERION_TWO] },
  acceptanceCriteria: [
    {
      ordinal: 1,
      satisfied: true,
      explanation: 'Chromium 测量 document 与 app view 的 scrollWidth 等于 clientWidth。',
      evidenceRefs: ['mobile-check', 'mobile-artifact'],
    },
    {
      ordinal: 2,
      result: 'PASS',
      finding: '判据卡只显示“提交者声称通过”，不显示账户所有者已经批准。',
      commandIds: ['copy-check'],
    },
  ],
  verification: [
    {
      id: 'mobile-check',
      label: '移动视口回归',
      command: 'npm test -w @orbit/web',
      exitCode: 0,
      rawOutput: [
        'Test Files 95 passed',
        'Tests 1234 passed',
        '390x844 overflow=false',
        '430x932 overflow=false',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        FULL_OUTPUT_MARKER,
      ].join('\n'),
    },
    {
      id: 'copy-check',
      command: 'npm exec -w @orbit/web tsc -- -b --pretty false',
      exitCode: 0,
      rawOutputSummary: 'TypeScript exited 0 with no stdout.',
    },
  ],
  artifacts: [{
    id: 'mobile-artifact',
    name: 'after-390x844.png',
    sha256: 'f'.repeat(64),
    path: '/tmp/after-390x844.png',
  }],
};

const baseReview: JudgmentReview = {
  request,
  requestVersion: 1,
  inbox: {
    id: encodeId('019fcda0-d021-72a2-a914-2f4de38f4810'),
    deliveredAt: '2026-08-26T08:00:01.000Z',
    notificationDeepLink: `/tasks/${TASK}?judgmentRequest=${REQUEST}`,
    pushDelivery: null,
  },
  reviewState: 'ACTION_REQUIRED',
  isCurrent: true,
  task: {
    id: TASK,
    title: '把人工审批页改为判据驱动界面',
    objective: 'A person can complete the normal EVIDENCE_JUDGMENT criterion without searching.',
    status: 'OPEN',
    projectId: PROJECT,
    projectTitle: 'N15 review',
    acceptanceCriteria: '1. prose must not be parsed\n2. this stays raw context',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  },
  criterion: {
    schemaVersion: 1,
    marker: CRITERION_RAW_MARKER,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    acceptanceCriteria: 'The server criterion snapshot remains an indivisible JSON fact.',
  },
  evidence: {
    id: EVIDENCE,
    revision: '3',
    digest: DIGEST,
    submittedAt: '2026-08-26T07:59:00.000Z',
    actorType: 'AGENT',
    actorId: ACTOR,
    actorName: 'N15 implementer',
    sourceSessionId: SESSION,
    sourceAttemptId: null,
    structured: structuredEvidence,
    commit: structuredEvidence.commit,
    testSummary: {
      marker: TEST_SUMMARY_MARKER,
      command: 'npm test -w @orbit/web',
      exitCode: 0,
      passed: 1234,
    },
  },
  currentEvidence: { id: EVIDENCE, revision: '3', digest: DIGEST, requestId: REQUEST },
  approvalImpact: {
    authority: 'SERVER',
    action: 'PASS',
    conditionalOn: {
      requestId: REQUEST,
      evidenceDigest: DIGEST,
      requestStatus: 'OPEN',
      evidenceIsCurrent: true,
    },
    task: { id: TASK, resultingStatus: 'DONE', basis: 'EVIDENCE_JUDGMENT' },
    request: { id: REQUEST, resultingStatus: 'DECIDED', decision: 'PASS' },
    signal: { resultingOpen: false },
    blocker: { resultingOpen: false },
  },
  history: [{
    id: EVIDENCE,
    revision: '3',
    digest: DIGEST,
    submittedAt: '2026-08-26T07:59:00.000Z',
    actorType: 'AGENT',
    actorId: ACTOR,
    actorName: 'N15 implementer',
    criterion: { completionCriterion: 'EVIDENCE_JUDGMENT', marker: CRITERION_RAW_MARKER },
    structured: structuredEvidence,
    commit: structuredEvidence.commit,
    testSummary: { marker: TEST_SUMMARY_MARKER, exitCode: 0 },
    isCurrentEvidence: true,
    requests: [request],
  }],
  derived: {
    taskStatus: 'OPEN',
    openRequestId: REQUEST,
    signalOpen: true,
    blockerOpen: true,
    legacyOpenBlockerCount: 0,
    dependencyGraph: {
      nodes: [
        { id: TASK, title: '把人工审批页改为判据驱动界面', status: 'OPEN', dependencyState: 'NONE' },
        { id: DEPENDENT, title: '下游任务（不应在批准前被预测）', status: 'OPEN', dependencyState: 'BLOCKED' },
      ],
      edges: [{ sourceTaskId: TASK, targetTaskId: DEPENDENT }],
    },
  },
};

function approvedReview(): JudgmentReview {
  const decidedRequest: JudgmentReview['request'] = {
    ...request,
    status: 'DECIDED',
    decidedAt: '2026-08-26T08:10:00.000Z',
    decidedByType: 'USER',
    decidedById: ACTOR,
    decision: 'PASS',
    decisionNote: 'Reviewed the exact revision and both viewport results.',
  };
  return {
    ...baseReview,
    request: decidedRequest,
    reviewState: 'APPROVED',
    approvalImpact: null,
    history: [{ ...baseReview.history[0], requests: [decidedRequest] }],
    task: { ...baseReview.task, status: 'DONE' },
    derived: {
      ...baseReview.derived,
      taskStatus: 'DONE',
      openRequestId: null,
      signalOpen: false,
      blockerOpen: false,
      dependencyGraph: {
        ...baseReview.derived.dependencyGraph,
        nodes: baseReview.derived.dependencyGraph.nodes.map((node) =>
          node.id === TASK
            ? { ...node, status: 'DONE' }
            : { ...node, dependencyState: 'READY' }),
      },
    },
  };
}

function awaitingReview(): JudgmentReview {
  const decidedRequest: JudgmentReview['request'] = {
    ...request,
    status: 'DECIDED',
    decidedAt: '2026-08-26T08:10:00.000Z',
    decidedByType: 'USER',
    decidedById: ACTOR,
    decision: 'INCONCLUSIVE',
    decisionNote: '请补充完整焦点轨迹。',
  };
  return {
    ...baseReview,
    request: decidedRequest,
    reviewState: 'AWAITING_NEW_EVIDENCE',
    approvalImpact: null,
    history: [{ ...baseReview.history[0], requests: [decidedRequest] }],
    derived: { ...baseReview.derived, openRequestId: null, signalOpen: false, blockerOpen: false },
  };
}

function staleReview(): JudgmentReview {
  const staleRequest: JudgmentReview['request'] = {
    ...request,
    status: 'SUPERSEDED',
    supersededAt: '2026-08-26T08:05:00.000Z',
    supersededById: CURRENT_REQUEST,
  };
  return {
    ...baseReview,
    request: staleRequest,
    reviewState: 'SUPERSEDED',
    isCurrent: false,
    approvalImpact: null,
    currentEvidence: {
      id: CURRENT_EVIDENCE,
      revision: '4',
      digest: NEW_DIGEST,
      requestId: CURRENT_REQUEST,
    },
    history: [{ ...baseReview.history[0], isCurrentEvidence: false, requests: [staleRequest] }],
    derived: { ...baseReview.derived, openRequestId: CURRENT_REQUEST },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
let clipboardWrite: ReturnType<typeof vi.fn>;

function mountedContainer(): HTMLDivElement {
  if (!container) throw new Error('judgment review is not mounted');
  return container;
}

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 6_000, interval: 20 });
  });
}

async function mount(): Promise<void> {
  const nextClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      // The client is cleared explicitly in afterEach; Infinity prevents a mutation GC timer from
      // being scheduled between React's observer unmount and that deterministic teardown.
      mutations: { retry: false, gcTime: Infinity },
    },
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
        <MemoryRouter initialEntries={[judgmentReviewPath(REQUEST)]}>
          <Routes>
            <Route path="/judgments/:id" element={<JudgmentReviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(nextContainer.querySelector('.judgment-review-page')).not.toBeNull();
    expect(nextContainer.querySelector('.judgment-task-title')?.textContent).toBe(baseReview.task.title);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...mountedContainer().querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found as HTMLButtonElement;
}

function details(label: string): HTMLDetailsElement {
  const found = [...mountedContainer().querySelectorAll('details')].find((candidate) =>
    candidate.querySelector(':scope > summary')?.textContent?.includes(label),
  );
  expect(found, `details ${label}`).toBeTruthy();
  return found as HTMLDetailsElement;
}

async function toggleDetails(label: string): Promise<void> {
  const target = details(label);
  await act(async () => target.querySelector(':scope > summary')!.dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  ));
  await waitForUi(() => expect(target.open).toBe(true));
}

async function typeNote(value: string): Promise<void> {
  const textarea = mountedContainer().querySelector('#judgment-decision-note') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForUi(() => {
    expect(textarea.value).toBe(value);
    expect(button('批准此证据版本').disabled).toBe(false);
    expect(button('要求补充证据').disabled).toBe(false);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
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
    try {
      if (mountedClient) {
        await mountedClient.cancelQueries();
        mountedClient.clear();
      }
    } finally {
      mountedNode?.remove();
      vi.unstubAllGlobals();
      delete (window.navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  }
});

// Cold clean-CI scheduling put the first real DOM/AntD case at 5.610s (1.980s standalone).
// Keep this suite-local 8s ceiling around the 6s observable UI wait; no global timeout or sleep.
describe('criterion-driven human evidence review', { timeout: 8_000 }, () => {
  it('starts with task/currentness, evidence identity, then criterion cards without JSON dumps', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();
    const page = mountedContainer();

    expect(page.textContent).toContain('审阅完成证据');
    expect(page.textContent).toContain(baseReview.task.title);
    expect(page.textContent).toContain('人工签字（EVIDENCE_JUDGMENT）');
    expect(page.textContent).toContain('当前版本 · 待审批');
    expect(page.textContent).toContain('证据 r3');
    expect(page.textContent).toContain('current r3');
    expect(page.textContent).toContain('N15 implementer');
    expect(page.textContent).toContain('0123456789ab…');
    expect(page.textContent).toContain(shortDigest(DIGEST));
    expect(page.textContent).toContain(CRITERION_ONE);
    expect(page.textContent).toContain(CRITERION_TWO);
    expect(page.textContent).toContain('提交者结论');
    expect(page.textContent).toContain('声称通过（PASS）');
    expect(page.textContent).toContain('2/2 项提交者声称通过');
    expect(page.querySelectorAll('.judgment-criterion-card')).toHaveLength(2);
    expect(page.querySelector('.judgment-criterion-card img')).toBeNull();
    expect(page.querySelector('pre')).toBeNull();
    expect(page.textContent).not.toContain('schemaVersion');
    expect(page.textContent).not.toContain(FULL_OUTPUT_MARKER);
    expect(page.textContent).not.toContain(TEST_SUMMARY_MARKER);
    expect(page.textContent).not.toContain(CRITERION_RAW_MARKER);

    const identity = page.querySelector('.judgment-evidence-identity') as HTMLElement;
    const criteria = page.querySelector('.judgment-criteria') as HTMLElement;
    expect(identity.compareDocumentPosition(criteria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const firstCard = page.querySelector('.judgment-criterion-card') as HTMLElement;
    expect(firstCard.textContent).not.toContain('账户所有者已批准');
    expect((document.activeElement as HTMLElement)?.textContent).toContain('审阅完成证据');

    const textarea = page.querySelector('#judgment-decision-note') as HTMLTextAreaElement;
    expect(page.querySelector(`label[for="${textarea.id}"]`)).toBeTruthy();
    expect(textarea.required).toBe(true);
    expect(button('批准此证据版本').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);

    await act(async () => button('复制完整 digest').click());
    await waitForUi(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(DIGEST);
      expect(page.querySelector('[aria-label="复制完整 digest已复制"]')).not.toBeNull();
    });
  });

  it('lazily reveals related commands, full output, and exact raw audit JSON', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();
    const page = mountedContainer();

    expect(page.textContent).not.toContain('npm test -w @orbit/web');
    await toggleDetails('查看关联命令与产物（2）');
    await waitForUi(() => expect(page.textContent).toContain('npm test -w @orbit/web'));
    expect(page.textContent).toContain('exit 0');
    expect(page.textContent).toContain('390x844 overflow=false');
    expect(page.textContent).toContain('after-390x844.png');
    expect(page.textContent).not.toContain(FULL_OUTPUT_MARKER);

    await toggleDetails('查看完整原始输出');
    await waitForUi(() => expect(page.textContent).toContain(FULL_OUTPUT_MARKER));
    expect(page.querySelector('.judgment-audit-panel pre')).toBeNull();

    await toggleDetails('技术与审计详情 · 原始 JSON');
    await waitForUi(() => {
      expect(page.querySelectorAll('.judgment-audit-panel .judgment-json')).toHaveLength(4);
    });
    const raw = [...page.querySelectorAll('.judgment-audit-panel .judgment-json')];
    expect(raw).toHaveLength(4);
    expect(raw[0].textContent).toBe(JSON.stringify(baseReview.criterion, null, 2));
    expect(raw[1].textContent).toBe(JSON.stringify(baseReview.evidence.structured, null, 2));
    expect(raw[2].textContent).toBe(JSON.stringify(baseReview.evidence.testSummary, null, 2));
    expect(raw[3].textContent).toBe(JSON.stringify(baseReview.history, null, 2));

    await act(async () => button('复制structured evidence 原始 JSON').click());
    await waitForUi(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(JSON.stringify(baseReview.evidence.structured, null, 2));
      expect(page.querySelector('[aria-label="复制structured evidence 原始 JSON已复制"]')).not.toBeNull();
    });
  });

  it('uses an explicit compatibility fallback without parsing prose or inventing conclusions', async () => {
    const unsupported: JudgmentReview = {
      ...baseReview,
      evidence: {
        ...baseReview.evidence,
        structured: {
          schemaVersion: 99,
          acceptanceCriteria: 'SHOULD_NOT_SPLIT 1. one\n2. two',
          verdict: 'PASS',
        },
      },
    };
    apiMock.mockResolvedValue(unsupported);
    await mount();
    const page = mountedContainer();

    expect(page.textContent).toContain('此 evidence 暂不能按判据展示');
    expect(page.textContent).toContain('不会拆解 acceptanceCriteria 散文');
    expect(page.querySelector('.judgment-criterion-card')).toBeNull();
    expect(page.querySelector('pre')).toBeNull();
    expect(page.textContent).not.toContain('SHOULD_NOT_SPLIT');

    await act(async () => button('通用审计查看器').click());
    await waitForUi(() => {
      expect(page.querySelectorAll('.judgment-audit-panel .judgment-json')).toHaveLength(4);
      expect(page.textContent).toContain('SHOULD_NOT_SPLIT');
    });
  });

  it('renders only the server-authored approval impact and never predicts downstream readiness', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();

    const impact = mountedContainer().querySelector('.judgment-impact') as HTMLElement;
    expect(impact.querySelector('[data-authority="SERVER"]')).toBeTruthy();
    expect(impact.textContent).toContain('派生为 DONE');
    expect(impact.textContent).toContain('DECIDED · PASS');
    expect(impact.textContent).toContain('signal关闭');
    expect(impact.textContent).toContain('blocker关闭');
    expect(impact.textContent).toContain('不预估下游任务');
    expect(impact.textContent).not.toContain('下游任务（不应在批准前被预测）');
    expect(impact.textContent).not.toContain('READY');
  });

  it('shows no predicted effects when a rolling-upgrade response has no authoritative preview', async () => {
    apiMock.mockResolvedValue({ ...baseReview, approvalImpact: undefined });
    await mount();

    const impact = mountedContainer().querySelector('.judgment-impact') as HTMLElement;
    expect(impact.querySelector('[data-testid="no-authoritative-impact"]')).toBeTruthy();
    expect(impact.textContent).not.toContain('派生为 DONE');
    expect(impact.textContent).not.toContain('DECIDED · PASS');
    expect(impact.textContent).not.toContain('下游任务（不应在批准前被预测）');
  });

  it('binds exact request/digest, disables duplicate presses, then re-reads server facts', async () => {
    let current = baseReview;
    let release!: () => void;
    const pending = new Promise<JudgmentReview>((resolve) => {
      release = () => {
        current = approvedReview();
        resolve(current);
      };
    });
    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return pending as Promise<never>;
      if (path === `/judgments/${REQUEST}`) return Promise.resolve(current) as Promise<never>;
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount();
    const note = '已核对 exact digest、commit 与两个手机视口输出。';
    await typeNote(note);

    const approve = button('批准此证据版本');
    expect(approve.disabled).toBe(false);
    await act(async () => approve.click());
    await waitForUi(() => {
      expect(approve.disabled).toBe(true);
      expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    });
    approve.click();
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);

    const postCall = apiMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(postCall[0]).toBe(`/judgments/${REQUEST}/decision`);
    expect(postCall[1]?.body).toEqual({
      requestId: REQUEST,
      evidenceDigest: DIGEST,
      action: 'PASS',
      note,
    });
    expect(apiMock.mock.calls.some(([path, options]) =>
      options?.method === 'PATCH' || String(path).includes('/status'))).toBe(false);

    await act(async () => release());
    await waitForUi(() => {
      expect(mountedContainer().textContent).toContain('账户所有者已批准');
      expect(apiMock.mock.calls.filter(([path, options]) =>
        path === `/judgments/${REQUEST}` && !options?.method).length).toBeGreaterThan(1);
    });
    const impact = mountedContainer().querySelector('.judgment-impact') as HTMLElement;
    expect(impact.textContent).toContain('taskDONE');
    expect(impact.textContent).toContain('requestDECIDED · PASS');
    expect(impact.textContent).toContain('signal已关闭');
    expect(impact.textContent).toContain('blocker已关闭');
    expect(impact.textContent).toContain('READY');
    expect(apiMock.mock.calls.filter(([path, options]) =>
      path === `/judgments/${REQUEST}` && !options?.method).length).toBeGreaterThan(1);
  });

  it('requests more evidence with the same binding and leaves the request read-only', async () => {
    let current = baseReview;
    apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        current = awaitingReview();
        return Promise.resolve(current) as Promise<never>;
      }
      if (path === `/judgments/${REQUEST}`) return Promise.resolve(current) as Promise<never>;
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount();
    const note = '请补充完整键盘焦点轨迹。';
    await typeNote(note);
    await act(async () => button('要求补充证据').click());
    await waitForUi(() => {
      expect(mountedContainer().textContent).toContain('等待补充证据');
      expect(button('批准此证据版本').disabled).toBe(true);
      expect(button('要求补充证据').disabled).toBe(true);
    });

    const postCall = apiMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(postCall[1]?.body).toEqual({
      requestId: REQUEST,
      evidenceDigest: DIGEST,
      action: 'REQUEST_MORE_EVIDENCE',
      note,
    });
    expect(mountedContainer().textContent).toContain('等待补充证据');
    expect(button('批准此证据版本').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);
  });

  it('keeps the original stale refusal inline and restores focus toward the current request', async () => {
    let current = baseReview;
    const refusal = 'This evidence version was superseded; refresh and review the current revision.';
    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        current = staleReview();
        return Promise.reject(new Error(refusal));
      }
      if (path === `/judgments/${REQUEST}`) return Promise.resolve(current) as Promise<never>;
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount();
    await typeNote('这个点击与新 evidence revision 发生竞争。');
    await act(async () => button('批准此证据版本').click());
    await waitForUi(() => {
      const error = mountedContainer().querySelector('.judgment-inline-error');
      expect(error?.textContent).toContain(refusal);
      expect(document.activeElement).toBe(error);
      expect(mountedContainer().textContent).toContain('打开 current evidence r4');
    });

    const inline = mountedContainer().querySelector('.judgment-inline-error') as HTMLElement;
    expect(inline).toBeTruthy();
    expect(inline.textContent).toContain(refusal);
    expect(document.activeElement).toBe(inline);
    expect(mountedContainer().textContent).toContain('已被新版本替代');
    expect(mountedContainer().textContent).toContain('打开 current evidence r4');
    expect(mountedContainer().textContent).toContain(shortDigest(NEW_DIGEST));
    expect(button('批准此证据版本').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);

    await act(async () => button('关闭错误').click());
    await waitForUi(() => {
      expect(mountedContainer().querySelector('.judgment-inline-error')).toBeNull();
      expect(document.activeElement?.textContent).toContain('打开 current evidence r4');
    });
  });

  it('keeps history human-readable and collapsed until requested', async () => {
    apiMock.mockResolvedValue(approvedReview());
    await mount();

    expect(mountedContainer().querySelector('.judgment-history-entry')).toBeNull();
    expect(details('历史版本').open).toBe(false);
    await toggleDetails('历史版本');
    await waitForUi(() => {
      expect(mountedContainer().querySelector('.judgment-history-entry')).not.toBeNull();
      expect(mountedContainer().textContent).toContain('决定说明：Reviewed the exact revision');
    });
    expect(mountedContainer().textContent).toContain('证据 r3');
    expect(mountedContainer().querySelector('.judgment-history pre')).toBeNull();
    expect(button('批准此证据版本').disabled).toBe(true);
  });
});
