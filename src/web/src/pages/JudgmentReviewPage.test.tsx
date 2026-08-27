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
  kind: 'HUMAN_SIGNOFF',
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
  signoff: null,
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
    objective: 'A person can complete the normal HUMAN_SIGNOFF criterion without searching.',
    status: 'OPEN',
    projectId: PROJECT,
    projectTitle: 'N15 review',
    acceptanceCriteria: '1. prose must not be parsed\n2. this stays raw context',
    completionCriterion: 'HUMAN_SIGNOFF',
  },
  criterion: {
    schemaVersion: 1,
    marker: CRITERION_RAW_MARKER,
    completionCriterion: 'HUMAN_SIGNOFF',
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
    task: { id: TASK, resultingStatus: 'DONE', basis: 'HUMAN_SIGNOFF' },
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
    criterion: { completionCriterion: 'HUMAN_SIGNOFF', marker: CRITERION_RAW_MARKER },
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
    signoff: {
      id: encodeId('019fcda0-d021-72a2-a914-2f4de38f4811'),
      signedById: ACTOR,
      signedByName: 'Human owner',
      signedAt: '2026-08-26T08:10:00.000Z',
      evidence: 'Reviewed the exact revision and both viewport results.',
    },
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

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let clipboardWrite: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<void> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[judgmentReviewPath(REQUEST)]}>
          <Routes>
            <Route path="/judgments/:id" element={<JudgmentReviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found as HTMLButtonElement;
}

function details(label: string): HTMLDetailsElement {
  const found = [...container.querySelectorAll('details')].find((candidate) =>
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
  await flush();
}

async function typeNote(value: string): Promise<void> {
  const textarea = container.querySelector('#judgment-decision-note') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
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
  if (root) await act(async () => root.unmount());
  client?.clear();
  container?.remove();
  vi.unstubAllGlobals();
  delete (window.navigator as Navigator & { clipboard?: Clipboard }).clipboard;
});

describe('criterion-driven human evidence review', () => {
  it('starts with task/currentness, evidence identity, then criterion cards without JSON dumps', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();

    expect(container.textContent).toContain('审阅完成证据');
    expect(container.textContent).toContain(baseReview.task.title);
    expect(container.textContent).toContain('人工签字（HUMAN_SIGNOFF）');
    expect(container.textContent).toContain('当前版本 · 待审批');
    expect(container.textContent).toContain('证据 r3');
    expect(container.textContent).toContain('current r3');
    expect(container.textContent).toContain('N15 implementer');
    expect(container.textContent).toContain('0123456789ab…');
    expect(container.textContent).toContain(shortDigest(DIGEST));
    expect(container.textContent).toContain(CRITERION_ONE);
    expect(container.textContent).toContain(CRITERION_TWO);
    expect(container.textContent).toContain('提交者结论');
    expect(container.textContent).toContain('声称通过（PASS）');
    expect(container.textContent).toContain('2/2 项提交者声称通过');
    expect(container.querySelectorAll('.judgment-criterion-card')).toHaveLength(2);
    expect(container.querySelector('.judgment-criterion-card img')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('schemaVersion');
    expect(container.textContent).not.toContain(FULL_OUTPUT_MARKER);
    expect(container.textContent).not.toContain(TEST_SUMMARY_MARKER);
    expect(container.textContent).not.toContain(CRITERION_RAW_MARKER);

    const identity = container.querySelector('.judgment-evidence-identity') as HTMLElement;
    const criteria = container.querySelector('.judgment-criteria') as HTMLElement;
    expect(identity.compareDocumentPosition(criteria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const firstCard = container.querySelector('.judgment-criterion-card') as HTMLElement;
    expect(firstCard.textContent).not.toContain('账户所有者已批准');
    expect((document.activeElement as HTMLElement)?.textContent).toContain('审阅完成证据');

    const textarea = container.querySelector('#judgment-decision-note') as HTMLTextAreaElement;
    expect(container.querySelector(`label[for="${textarea.id}"]`)).toBeTruthy();
    expect(textarea.required).toBe(true);
    expect(button('批准此证据版本').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);

    await act(async () => button('复制完整 digest').click());
    expect(clipboardWrite).toHaveBeenCalledWith(DIGEST);
  });

  it('lazily reveals related commands, full output, and exact raw audit JSON', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();

    expect(container.textContent).not.toContain('npm test -w @orbit/web');
    await toggleDetails('查看关联命令与产物（2）');
    expect(container.textContent).toContain('npm test -w @orbit/web');
    expect(container.textContent).toContain('exit 0');
    expect(container.textContent).toContain('390x844 overflow=false');
    expect(container.textContent).toContain('after-390x844.png');
    expect(container.textContent).not.toContain(FULL_OUTPUT_MARKER);

    await toggleDetails('查看完整原始输出');
    expect(container.textContent).toContain(FULL_OUTPUT_MARKER);
    expect(container.querySelector('.judgment-audit-panel pre')).toBeNull();

    await toggleDetails('技术与审计详情 · 原始 JSON');
    const raw = [...container.querySelectorAll('.judgment-audit-panel .judgment-json')];
    expect(raw).toHaveLength(4);
    expect(raw[0].textContent).toBe(JSON.stringify(baseReview.criterion, null, 2));
    expect(raw[1].textContent).toBe(JSON.stringify(baseReview.evidence.structured, null, 2));
    expect(raw[2].textContent).toBe(JSON.stringify(baseReview.evidence.testSummary, null, 2));
    expect(raw[3].textContent).toBe(JSON.stringify(baseReview.history, null, 2));

    await act(async () => button('复制structured evidence 原始 JSON').click());
    expect(clipboardWrite).toHaveBeenCalledWith(JSON.stringify(baseReview.evidence.structured, null, 2));
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

    expect(container.textContent).toContain('此 evidence 暂不能按判据展示');
    expect(container.textContent).toContain('不会拆解 acceptanceCriteria 散文');
    expect(container.querySelector('.judgment-criterion-card')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('SHOULD_NOT_SPLIT');

    await act(async () => button('通用审计查看器').click());
    await flush();
    expect(container.querySelectorAll('.judgment-audit-panel .judgment-json')).toHaveLength(4);
    expect(container.textContent).toContain('SHOULD_NOT_SPLIT');
  });

  it('renders only the server-authored approval impact and never predicts downstream readiness', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();

    const impact = container.querySelector('.judgment-impact') as HTMLElement;
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

    const impact = container.querySelector('.judgment-impact') as HTMLElement;
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
    await flush();
    expect(approve.disabled).toBe(true);
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
    await flush();
    await flush();
    expect(container.textContent).toContain('账户所有者已批准');
    const impact = container.querySelector('.judgment-impact') as HTMLElement;
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
    await flush();
    await flush();

    const postCall = apiMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(postCall[1]?.body).toEqual({
      requestId: REQUEST,
      evidenceDigest: DIGEST,
      action: 'REQUEST_MORE_EVIDENCE',
      note,
    });
    expect(container.textContent).toContain('等待补充证据');
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
    await flush();
    await flush();

    const inline = container.querySelector('.judgment-inline-error') as HTMLElement;
    expect(inline).toBeTruthy();
    expect(inline.textContent).toContain(refusal);
    expect(document.activeElement).toBe(inline);
    expect(container.textContent).toContain('已被新版本替代');
    expect(container.textContent).toContain('打开 current evidence r4');
    expect(container.textContent).toContain(shortDigest(NEW_DIGEST));
    expect(button('批准此证据版本').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);

    await act(async () => button('关闭错误').click());
    await flush();
    expect(container.querySelector('.judgment-inline-error')).toBeNull();
    expect(document.activeElement?.textContent).toContain('打开 current evidence r4');
  });

  it('keeps history human-readable and collapsed until requested', async () => {
    apiMock.mockResolvedValue(approvedReview());
    await mount();

    expect(container.querySelector('.judgment-history-entry')).toBeNull();
    expect(details('历史版本').open).toBe(false);
    await toggleDetails('历史版本');
    expect(container.textContent).toContain('证据 r3');
    expect(container.textContent).toContain('决定说明：Reviewed the exact revision');
    expect(container.querySelector('.judgment-history pre')).toBeNull();
    expect(button('批准此证据版本').disabled).toBe(true);
  });
});
