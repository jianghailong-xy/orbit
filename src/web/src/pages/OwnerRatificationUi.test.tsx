// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';
import { OwnerRatificationSummary } from '../components/OwnerRatificationSummary';
import { encodeId } from '../lib/idCodec';
import { attentionChipOf, attentionReasonOf, attentionSectionOf } from '../lib/projectAttention';
import {
  ownerRatificationPath,
  ownerRatificationReviewPath,
  splitOwnerRatificationCapability,
  type OwnerRatificationPrivateRead,
  type OwnerRatificationReference,
} from '../lib/ownerRatification';
import { JudgmentInboxPage } from './JudgmentInboxPage';
import { OwnerRatificationReviewPage } from './OwnerRatificationReviewPage';
import { ProjectDetailPage, ProjectsPage } from './ProjectsPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  restoreSession: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return { ProjectDependencyGraph: () => createElement('div', { 'data-testid': 'graph' }) };
});

const apiMock = vi.mocked(api);
const PROJECT = encodeId('019fcda0-d021-72a2-a914-2f4de38f4a01');
const REQUEST = encodeId('019fcda0-d021-72a2-a914-2f4de38f4a02');
const OTHER_REQUEST = encodeId('019fcda0-d021-72a2-a914-2f4de38f4a03');
const OWNER = encodeId('019fcda0-d021-72a2-a914-2f4de38f4a04');
const TASK = encodeId('019fcda0-d021-72a2-a914-2f4de38f4a05');
const CONTRACT = 'a'.repeat(64);
const OBLIGATION = 'b'.repeat(64);
const OBLIGATION_REVISION = 'c'.repeat(64);
const BINDING = 'd'.repeat(64);
const CTA = '019fcda0-d021-72a2-a914-2f4de38f4aff';

const reference: OwnerRatificationReference = {
  kind: 'OWNER_RATIFICATION',
  status: 'PENDING',
  projectId: PROJECT,
  projectTitle: 'Canonical Owner decision',
  decisionRequestId: REQUEST,
  requestRevision: '7',
  obligationId: OBLIGATION,
  obligationRevision: OBLIGATION_REVISION,
  obligationSource: 'AUTO_DISPATCH',
  contractDigest: CONTRACT,
  contractRevision: '11',
  reason: 'OWNER_RATIFICATION_REQUIRED',
  reasonCode: 'OWNER_RATIFICATION_REQUIRED',
  owner: 'OWNER',
  ownerId: OWNER,
  evaluatedThroughWatermark: '29',
  createdAt: '2026-08-29T01:00:00.000Z',
  expiresAt: '2099-09-05T01:00:00.000Z',
  expired: false,
  linkedObligations: [{
    obligationId: OBLIGATION,
    obligationRevision: OBLIGATION_REVISION,
    bindingDigest: BINDING,
    evaluatedThroughWatermark: '29',
    taskId: TASK,
    reasonCode: 'OWNER_RATIFICATION_REQUIRED',
  }],
};

const criteria = Array.from({ length: 14 }, (_, index) => ({
  semanticHash: String(index + 1).padStart(64, '0'),
  text: `验收标准 ${index + 1}：只能由 fixture 证明`,
}));

const review: OwnerRatificationPrivateRead = {
  projectId: PROJECT,
  projectTitle: reference.projectTitle,
  owner: 'OWNER',
  ownerId: OWNER,
  budgetDigest: '1'.repeat(64),
  contractDigest: CONTRACT,
  contractRevision: '11',
  evaluationPlanDigest: '2'.repeat(64),
  evaluationPlanRevision: '4',
  permissionDigest: '3'.repeat(64),
  recipientDigest: '4'.repeat(64),
  riskPolicyDigest: '5'.repeat(64),
  ratified: false,
  ratification: null,
  semanticContract: {
    goal: '在 guarded authority 内自动完成项目，且所有副作用可审计。',
    criteria,
    criteriaTrust: criteria.map((criterion) => ({
      semanticHash: criterion.semanticHash,
      completionCriterion: 'EXECUTABLE',
    })),
    riskBoundary: {
      automationPolicy: 'GUARDED_AUTO',
      authorizationRevision: '9',
      convergenceThresholds: null,
      unboundedAuthorizedBy: null,
    },
    permissions: {
      coordinatorEnabled: true,
      maxConcurrentTasks: 3,
      authorizationRevision: '9',
    },
    recipients: { ownerId: OWNER, coordinatorAgentIds: [], members: [] },
    budget: { sessionBudgetPerDay: null, attemptBudget: null, authorizationRevision: '9' },
  },
  evaluationPlan: { commands: [], environment: { instructions: 'fixture only' } },
  decisionRequest: {
    id: REQUEST,
    contractDigest: CONTRACT,
    ctaToken: CTA,
    expiresAt: reference.expiresAt,
    payload: {},
    reasonCode: reference.reasonCode,
    requestGeneration: reference.requestRevision,
    semanticDiff: { changedFields: ['permissions', 'budget'] },
    status: 'PENDING',
  },
  latestDecision: null,
  decisionSurface: {
    reference,
    semanticContract: {} as never,
    evaluationPlan: { commands: [] },
    semanticDiff: { changedFields: ['permissions', 'budget'] },
    impact: 'exact contract only',
    impacts: {
      APPROVE: '批准 exact digest，并仅在 guarded envelope 内自动续跑。',
      DENY: '不批准；自动副作用执行保持关闭。',
    },
    recommendation: '审阅 semantic diff 后，只批准当前 exact digest。',
    noActionConsequence: '自动副作用执行保持关闭。',
    whyNotAgent: 'Agent 或 runner 不能批准自己的 goal、risk、permission 或 budget。',
    resumeAfterDecision: 'APPROVE 后 persistent wake 自动重新进入 guarded admission。',
    options: ['APPROVE', 'DENY'],
  },
};
review.decisionSurface!.semanticContract = review.semanticContract;

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function projectRow() {
  return {
    id: PROJECT,
    title: reference.projectTitle,
    status: 'OPEN',
    goal: 'The guarded goal',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T01:00:00.000Z',
    _count: { tasks: 1 },
    buckets: { running: 1, ready: 0, blocked: 0, done: 0, cancelled: 0 },
    lastActivityAt: '2026-08-29T01:01:00.000Z',
    attention: {
      userBlockers: 0,
      coordinatorBlockers: 0,
      systemBlockers: 0,
      maxSeverity: null,
      attentionSinceAt: null,
      nextCheckAt: null,
    },
    ownerRatification: reference,
    tasksByStatus: { OPEN: 1 },
    acceptance: { total: 14, passed: 0, lastRunAt: null, criteria: [] },
    acceptanceCriteria: criteria.map((criterion) => criterion.text).join('\n'),
    instructions: null,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

async function flush(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function mount(path = ownerRatificationReviewPath(PROJECT, REQUEST)): Promise<void> {
  queryClient = client();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/judgments/owner-ratification/:projectId/:requestId"
              element={<OwnerRatificationReviewPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

function button(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  expect(found).toBeTruthy();
  return found as HTMLButtonElement;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  apiMock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  queryClient?.clear();
  container?.remove();
  root = undefined;
  queryClient = undefined;
  container = undefined;
});

describe('Owner Ratification canonical UI', () => {
  it('renders one identical secret-free identity in /judgments, Project Attention and detail', () => {
    const inboxClient = client();
    inboxClient.setQueryData(['judgments', 'open'], { total: 0, items: [] });
    inboxClient.setQueryData(['project-acceptance', 'pending'], { total: 0, items: [] });
    inboxClient.setQueryData(['owner-ratification', 'pending'], { total: 1, items: [reference] });
    const inbox = renderToStaticMarkup(
      <QueryClientProvider client={inboxClient}>
        <MemoryRouter><JudgmentInboxPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    const projectsClient = client();
    projectsClient.setQueryData(['projects', 'OPEN'], [projectRow()]);
    const attention = renderToStaticMarkup(
      <QueryClientProvider client={projectsClient}>
        <MemoryRouter><ProjectsPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    const detailClient = client();
    detailClient.setQueryData(['project', PROJECT], projectRow());
    const detail = renderToStaticMarkup(
      <QueryClientProvider client={detailClient}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
          <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const directDetail = renderToStaticMarkup(
      <MemoryRouter><OwnerRatificationSummary reference={reference} /></MemoryRouter>,
    );
    for (const html of [inbox, attention, detail, directDetail]) {
      expect(html).toContain(`data-decision-request-id="${REQUEST}"`);
      expect(html).toContain(`data-obligation-id="${OBLIGATION}"`);
      expect(html).toContain(`data-obligation-revision="${OBLIGATION_REVISION}"`);
      expect(html).toContain(`data-contract-digest="${CONTRACT}"`);
      expect(html).toContain('data-reason="OWNER_RATIFICATION_REQUIRED"');
      expect(html).toContain('data-owner="OWNER"');
      expect(html).toContain('data-evaluated-through-watermark="29"');
      expect(html).not.toContain(CTA);
    }
    expect(attention).toContain('data-section="attention"');
    expect(attention).toContain('Owner Ratification · Needs you · r7');
    expect(attention).toContain('Request r7');
    expect(attentionReasonOf(projectRow() as never, Date.parse('2026-08-29T02:00:00Z')))
      .toBe('owner-ratification');
    expect(attentionSectionOf(projectRow() as never, Date.parse('2026-08-29T02:00:00Z')))
      .toBe('attention');
    expect(attentionChipOf(projectRow() as never, Date.parse('2026-08-29T02:00:00Z'))?.text)
      .toContain('Owner Ratification');
    inboxClient.clear();
    projectsClient.clear();
    detailClient.clear();
  });

  it('shows all 14 criteria and the complete guarded decision envelope without exposing CTA', async () => {
    apiMock.mockResolvedValue(review);
    await mount();

    expect(apiMock).toHaveBeenCalledWith(ownerRatificationPath(PROJECT));
    expect(container!.querySelectorAll('.owner-ratification-criteria li')).toHaveLength(14);
    expect(container!.textContent).toContain('验收标准 14');
    expect(container!.textContent).toContain('Semantic diff');
    expect(container!.textContent).toContain('permissions');
    expect(container!.textContent).toContain('GUARDED_AUTO');
    expect(container!.textContent).toContain('maxConcurrent=3');
    expect(container!.textContent).toContain('未声明有限额度（null；不等于 Owner 已授权无限额度）');
    expect(container!.textContent).toContain('Agent 或 runner 不能批准自己的 goal');
    expect(container!.textContent).toContain('APPROVE');
    expect(container!.textContent).toContain('DENY');
    expect(container!.textContent).toContain('不作为后果');
    expect(container!.textContent).toContain('到期时间');
    expect(container!.textContent).toContain('决定后自动续跑');
    expect(container!.innerHTML).not.toContain(CTA);
    expect(JSON.stringify(queryClient!.getQueryCache().getAll().map((item) => item.state.data)))
      .not.toContain(CTA);
    expect(ownerRatificationReviewPath(PROJECT, REQUEST)).not.toContain(CTA);
    const split = splitOwnerRatificationCapability(review);
    expect(split.ctaToken).toBe(CTA);
    expect(JSON.stringify(split.review)).not.toContain(CTA);
    expect(button('APPROVE exact digest').disabled).toBe(true);
    expect(button('DENY — 保持执行关闭').disabled).toBe(true);
    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.tabIndex).toBe(0);
  });

  it('submits APPROVE once with exact request/digest/CTA and an idempotency key', async () => {
    let resolvePost!: (value: Record<string, unknown>) => void;
    const post = new Promise<Record<string, unknown>>((resolve) => { resolvePost = resolve; });
    apiMock.mockImplementation((path, options) => {
      if (!options?.method) return Promise.resolve(review) as Promise<never>;
      return post as Promise<never>;
    });
    await mount();
    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    await flush();
    const approve = button('APPROVE exact digest');
    expect(approve.disabled).toBe(false);
    await act(async () => {
      approve.click();
      approve.click();
    });
    const posts = apiMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(ownerRatificationPath(PROJECT));
    expect(posts[0]![1]?.body).toMatchObject({
      decision: 'APPROVE',
      decisionRequestId: REQUEST,
      ctaToken: CTA,
      expectedContractDigest: CONTRACT,
    });
    expect((posts[0]![1]?.body as { idempotencyKey: string }).idempotencyKey)
      .toMatch(/^owner-ratification:web:v1:/);
    await act(async () => resolvePost({ automaticResume: { scheduled: true, rearmedWakeups: 1 } }));
    await flush();
    expect(container!.textContent).toContain('APPROVE 已提交');
    expect(container!.textContent).toContain('自动重新进入 GUARDED_AUTO admission');
    expect(container!.innerHTML).not.toContain(CTA);
  });

  it('retries an uncertain network result with the same idempotency key', async () => {
    let postCount = 0;
    apiMock.mockImplementation((_path, options) => {
      if (!options?.method) return Promise.resolve(review) as Promise<never>;
      postCount += 1;
      if (postCount === 1) return Promise.reject(new TypeError('network'));
      return Promise.resolve({ automaticResume: { scheduled: true } }) as Promise<never>;
    });
    await mount();
    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    await act(async () => button('APPROVE exact digest').click());
    await flush();
    expect(container!.textContent).toContain('网络结果未知');
    const firstBody = apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')[0]![1]!.body;
    await act(async () => button('使用同一幂等键重试 APPROVE').click());
    await flush();
    const postBodies = apiMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => options!.body as { idempotencyKey: string });
    expect(postBodies).toHaveLength(2);
    expect(postBodies[1]!.idempotencyKey)
      .toBe((firstBody as { idempotencyKey: string }).idempotencyKey);
  });

  it('submits DENY through the same exact owner channel', async () => {
    apiMock.mockImplementation((_path, options) => options?.method === 'POST'
      ? Promise.resolve({ decision: 'DENY', duplicate: false, automaticResume: { scheduled: false } }) as Promise<never>
      : Promise.resolve(review) as Promise<never>);
    await mount();
    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    await act(async () => button('DENY — 保持执行关闭').click());
    await flush();
    const posts = apiMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]?.body).toMatchObject({
      decision: 'DENY',
      decisionRequestId: REQUEST,
      ctaToken: CTA,
      expectedContractDigest: CONTRACT,
    });
    expect(container!.textContent).toContain('DENY 已提交');
    expect(container!.textContent).toContain('自动副作用执行保持关闭');
    expect(container!.innerHTML).not.toContain(CTA);
  });

  it('recovers a committed decision from a network-ambiguous reload', async () => {
    const recovered = structuredClone(review);
    recovered.decisionRequest = null;
    recovered.decisionSurface = null;
    recovered.latestDecision = {
      decisionRequestId: REQUEST,
      contractDigest: CONTRACT,
      decision: 'DENY',
      status: 'DENIED',
      decidedAt: '2026-08-29T03:00:00.000Z',
      decidedByType: 'OWNER',
    };
    apiMock.mockResolvedValue(recovered);
    await mount();
    expect(container!.textContent).toContain('DENY 已提交');
    expect(container!.textContent).not.toContain('OWNER_DECISION_STALE');
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('fails closed locally after expiry and keeps native controls keyboard/mobile reachable', async () => {
    const expired = structuredClone(review);
    expired.decisionSurface!.reference.expiresAt = '2020-01-01T00:00:00.000Z';
    expired.decisionRequest!.expiresAt = '2020-01-01T00:00:00.000Z';
    apiMock.mockResolvedValue(expired);
    await mount();
    expect(container!.textContent).toContain('OWNER_DECISION_CTA_EXPIRED');
    expect(button('APPROVE exact digest').disabled).toBe(true);
    expect(button('DENY — 保持执行关闭').disabled).toBe(true);

    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.tabIndex).toBe(0);
    expect(button('APPROVE exact digest').tagName).toBe('BUTTON');
    const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*owner-ratification-envelope-grid/);
    expect(css).toMatch(/\.judgment-decision-actions \.ant-btn[\s\S]*min-height: 44px/);
    expect(css).toMatch(/\.owner-ratification-summary-action:focus-visible/);
  });

  it('fails closed for stale tabs, spent CTAs and cross-owner reads', async () => {
    const stale = structuredClone(review);
    stale.decisionSurface!.reference.decisionRequestId = OTHER_REQUEST;
    stale.decisionRequest!.id = OTHER_REQUEST;
    apiMock.mockResolvedValueOnce(stale);
    await mount();
    expect(container!.textContent).toContain('OWNER_DECISION_STALE');
    expect(button('APPROVE exact digest').disabled).toBe(true);
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);

    await act(async () => root!.unmount());
    queryClient!.clear();
    container!.remove();
    root = undefined;
    container = undefined;
    queryClient = undefined;

    apiMock.mockReset();
    apiMock.mockRejectedValue(new ApiError('hidden', 404, undefined, {}));
    await mount();
    expect(container!.textContent).toContain('NOT_AVAILABLE_TO_OWNER');
    expect(container!.textContent).not.toContain('hidden');
    expect(container!.querySelectorAll('button')).toHaveLength(0);
  });
});
