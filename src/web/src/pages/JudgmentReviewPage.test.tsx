// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { judgmentReviewPath, type JudgmentReview } from '../lib/judgments';
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
    title: 'Make human sign-off accessible',
    objective: 'A person can complete the normal HUMAN_SIGNOFF criterion without searching.',
    status: 'OPEN',
    projectId: PROJECT,
    projectTitle: 'N13 review',
    acceptanceCriteria: 'The 390 and 430 pixel flows have no horizontal overflow.',
    completionCriterion: 'HUMAN_SIGNOFF',
  },
  criterion: {
    schemaVersion: 1,
    completionCriterion: 'HUMAN_SIGNOFF',
    acceptanceCriteria: 'The 390 and 430 pixel flows have no horizontal overflow.',
  },
  evidence: {
    id: EVIDENCE,
    revision: '3',
    digest: DIGEST,
    submittedAt: '2026-08-26T07:59:00.000Z',
    actorType: 'AGENT',
    actorId: ACTOR,
    actorName: 'N13 implementer',
    sourceSessionId: SESSION,
    sourceAttemptId: null,
    structured: {
      commit: '0123456789abcdef',
      testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, passed: 2670 },
      viewports: [{ width: 390, height: 844 }, { width: 430, height: 932 }],
    },
    commit: '0123456789abcdef',
    testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, passed: 2670 },
  },
  currentEvidence: { id: EVIDENCE, revision: '3', digest: DIGEST, requestId: REQUEST },
  history: [{
    id: EVIDENCE,
    revision: '3',
    digest: DIGEST,
    submittedAt: '2026-08-26T07:59:00.000Z',
    actorType: 'AGENT',
    actorId: ACTOR,
    actorName: 'N13 implementer',
    criterion: { completionCriterion: 'HUMAN_SIGNOFF' },
    structured: { commit: '0123456789abcdef', commands: [{ exitCode: 0 }] },
    commit: '0123456789abcdef',
    testSummary: { exitCode: 0 },
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
        { id: TASK, title: 'Make human sign-off accessible', status: 'OPEN', dependencyState: 'NONE' },
        { id: DEPENDENT, title: 'Ship the next task', status: 'OPEN', dependencyState: 'BLOCKED' },
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
});

describe('human evidence review', () => {
  it('shows criterion, current identity, provenance, structured evidence and history', async () => {
    apiMock.mockResolvedValue(baseReview);
    await mount();

    expect(container.textContent).toContain('Task objective');
    expect(container.textContent).toContain(baseReview.task.objective);
    expect(container.textContent).toContain(baseReview.task.acceptanceCriteria);
    expect(container.textContent).toContain('HUMAN_SIGNOFF');
    expect(container.textContent).toContain('Current evidence revision');
    expect(container.textContent).toContain('r3');
    expect(container.textContent).toContain(DIGEST);
    expect(container.textContent).toContain('N13 implementer');
    expect(container.textContent).toContain('0123456789abcdef');
    expect(container.textContent).toContain('npm test -w @orbit/web');
    expect(container.textContent).toContain('Evidence history');
    expect(container.textContent).toContain('Revision 3');
    expect(container.textContent).toContain('Ship the next task');
    expect((document.activeElement as HTMLElement)?.textContent).toContain('Review evidence');

    const textarea = container.querySelector('#judgment-decision-note') as HTMLTextAreaElement;
    expect(container.querySelector(`label[for="${textarea.id}"]`)).toBeTruthy();
    expect(button('签字通过').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);
  });

  it('binds the exact request/digest, disables duplicate presses, then re-reads derived state', async () => {
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
    const note = 'Reviewed this exact digest, commit and both mobile test outputs.';
    await typeNote(note);

    const approve = button('签字通过');
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
    expect(container.textContent).toContain('Signed off');
    expect(container.textContent).toContain('Task statusDONE');
    expect(container.textContent).toContain('RequestDECIDED · PASS');
    expect(container.textContent).toContain('SignalClosed');
    expect(container.textContent).toContain('BlockerClosed');
    expect(container.textContent).toContain('READY');
    expect(apiMock.mock.calls.filter(([path, options]) =>
      path === `/judgments/${REQUEST}` && !options?.method).length).toBeGreaterThan(1);
  });

  it('keeps the original stale refusal inline and refreshes to the replacement revision', async () => {
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
    await typeNote('This click raced a newer evidence submission.');
    await act(async () => button('签字通过').click());
    await flush();
    await flush();

    const inline = container.querySelector('.judgment-inline-error') as HTMLElement;
    expect(inline).toBeTruthy();
    expect(inline.textContent).toContain(refusal);
    expect(document.activeElement).toBe(inline);
    expect(container.textContent).toContain('Superseded');
    expect(container.textContent).toContain('Open current evidence r4');
    expect(container.textContent).toContain(NEW_DIGEST);
    expect(button('签字通过').disabled).toBe(true);
    expect(button('要求补充证据').disabled).toBe(true);

    await act(async () => button('Dismiss').click());
    await flush();
    expect(container.querySelector('.judgment-inline-error')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Open current evidence r4');
  });
});
