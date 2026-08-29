// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  projectAcceptanceOverviewPath,
  projectAcceptanceReviewPath,
  projectAcceptanceVerdictPath,
  type ProjectAcceptanceOverview,
  type ProjectAcceptanceRun,
} from '../lib/projectAcceptance';
import { ownerRatificationReviewPath } from '../lib/outcomeSurfaces';
import { ProjectAcceptanceReviewPage } from './ProjectAcceptanceReviewPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const PROJECT = encodeId('019fcda0-d021-72a2-a914-2f4de38f4901');
const RUN = encodeId('019fcda0-d021-72a2-a914-2f4de38f4902');
const CRITERION_A = encodeId('019fcda0-d021-72a2-a914-2f4de38f4903');
const CRITERION_B = encodeId('019fcda0-d021-72a2-a914-2f4de38f4904');
const DEFINITION_A = encodeId('019fcda0-d021-72a2-a914-2f4de38f4905');
const DEFINITION_B = encodeId('019fcda0-d021-72a2-a914-2f4de38f4906');
const TASK = encodeId('019fcda0-d021-72a2-a914-2f4de38f4907');
const SESSION = encodeId('019fcda0-d021-72a2-a914-2f4de38f4908');

const run: ProjectAcceptanceRun = {
  id: RUN,
  projectId: PROJECT,
  attempt: '4',
  evidenceVersion: '4',
  acceptanceEpoch: '0',
  verdict: null,
  decidedBy: 'COORDINATOR_AGENT',
  inputDigest: 'a'.repeat(64),
  resultDigest: null,
  supersededAt: null,
  supersededReason: null,
  startedAt: '2026-08-27T08:00:00.000Z',
  completedAt: null,
  conclusions: [],
  criteria: [
    {
      id: CRITERION_A,
      ordinal: 1,
      criterionKey: 'criterion-a',
      criterionId: DEFINITION_A,
      definitionRevision: 2,
      criterionText: '自动派发确实发生',
      verificationMethod: '运行 coordinator pg spec，并要求退出码为 0。',
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'npm test -w @orbit/apiserver',
      acceptanceExpectedExitCode: 0,
      verdict: 'PASS',
      summary: 'Command exited 0; expected 0',
      evidence: { command: 'npm test -w @orbit/apiserver', actualExitCode: 0 },
      evidenceTaskId: TASK,
      evidenceSessionId: SESSION,
      decidedAt: null,
    },
    {
      id: CRITERION_B,
      ordinal: 2,
      criterionKey: 'criterion-b',
      criterionId: DEFINITION_B,
      definitionRevision: 1,
      criterionText: '没有新增定时器',
      verificationMethod: '运行 grep 断言与对应 spec。',
      completionCriterion: 'HUMAN_SIGNOFF',
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
      verdict: null,
      summary: null,
      evidence: {},
      evidenceTaskId: null,
      evidenceSessionId: null,
      decidedAt: null,
    },
  ],
};

const overview: ProjectAcceptanceOverview = {
  projectId: PROJECT,
  projectTitle: 'N20 project-level acceptance',
  status: 'OPEN',
  criteria: run.criteria.map((criterion) => ({
    ordinal: criterion.ordinal,
    criterionId: criterion.criterionId,
    criterionKey: criterion.criterionKey,
    criterionText: criterion.criterionText,
    verificationMethod: criterion.verificationMethod,
    completionCriterion: criterion.completionCriterion,
    acceptanceCommand: criterion.acceptanceCommand,
    acceptanceExpectedExitCode: criterion.acceptanceExpectedExitCode,
    evidenceTaskId: criterion.evidenceTaskId,
    completionCriterionOverrideReason: null,
  })),
  acceptanceDigest: 'b'.repeat(64),
  criteriaDigest: 'c'.repeat(64),
  criteriaConfirmation: {
    confirmed: true,
    criteriaDigest: 'c'.repeat(64),
    confirmation: {
      id: encodeId('019fcda0-d021-72a2-a914-2f4de38f4909'),
      criteriaDigest: 'c'.repeat(64),
      confirmedByType: 'USER',
      confirmedById: encodeId('019fcda0-d021-72a2-a914-2f4de38f4910'),
      actingSessionId: null,
      confirmedAt: '2026-08-27T07:59:00.000Z',
    },
  },
  runs: [run],
  runsEmptyReason: null,
  audit: [],
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
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
        <MemoryRouter initialEntries={[projectAcceptanceReviewPath(PROJECT, RUN)]}>
          <Routes>
            <Route
              path="/judgments/project-acceptance/:projectId/:runId"
              element={<ProjectAcceptanceReviewPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

function submitButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('提交 1 条人工判定'),
  );
  expect(found).toBeTruthy();
  return found as HTMLButtonElement;
}

async function choose(cardIndex: number, verdict: string): Promise<void> {
  const card = container.querySelectorAll('.project-acceptance-criterion-card')[cardIndex];
  const found = [...card.querySelectorAll('button')].find((candidate) => candidate.textContent === verdict);
  expect(found).toBeTruthy();
  await act(async () => (found as HTMLButtonElement).click());
  await flush();
}

async function typeInput(selector: string, value: string): Promise<void> {
  const input = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  container?.remove();
});

describe('project acceptance review', () => {
  it('shows assertion, verificationMethod, current verdict and supporting evidence per criterion', async () => {
    apiMock.mockResolvedValue(overview);
    await mount();

    expect(apiMock).toHaveBeenCalledWith(projectAcceptanceOverviewPath(PROJECT));
    expect(container.textContent).toContain('项目验收判定');
    expect(container.textContent).toContain('N20 project-level acceptance');
    expect(container.textContent).toContain('自动派发确实发生');
    expect(container.textContent).toContain('运行 coordinator pg spec，并要求退出码为 0。');
    expect(container.textContent).toContain('没有新增定时器');
    expect(container.textContent).toContain('运行 grep 断言与对应 spec。');
    expect(container.textContent).toContain('当前 verdictUNDECIDED');
    expect(container.textContent).toContain(TASK);
    expect(container.textContent).toContain(SESSION);
    expect(container.textContent).toContain('npm test -w @orbit/apiserver');
    expect(container.textContent).toContain('退出码0');
    expect(container.querySelectorAll('.project-acceptance-criterion-card')).toHaveLength(2);
    expect(container.querySelector('.project-acceptance-audit')?.hasAttribute('open')).toBe(false);
  });

  it('requires only HUMAN_SIGNOFF and leaves automatic criteria read-only', async () => {
    apiMock.mockResolvedValue(overview);
    await mount();

    expect(container.textContent).toContain('人工标准已回答 0/1；尚有 1 条');
    expect(container.textContent).toContain('还需回答判据：2');
    expect(container.textContent).toContain('EXECUTABLE 由服务端自动求值');
    expect(container.querySelectorAll('.project-acceptance-criterion-card')[0]
      .querySelectorAll('.project-acceptance-verdict-option')).toHaveLength(0);
    expect(submitButton().disabled).toBe(true);

    await choose(1, 'FAIL');
    expect(container.textContent).toContain('人工标准已回答 1/1；尚有 0 条');
    expect(container.textContent).toContain('全部判据已回答');
    expect(submitButton().disabled).toBe(false);
    expect(apiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('POSTs the exact run with all criterion verdicts and evidence, then re-reads server truth', async () => {
    let current = overview;
    const completedRun: ProjectAcceptanceRun = {
      ...run,
      verdict: 'INCONCLUSIVE',
      completedAt: '2026-08-27T08:10:00.000Z',
      criteria: run.criteria.map((criterion) => criterion.completionCriterion === 'HUMAN_SIGNOFF'
        ? {
            ...criterion,
            verdict: 'INCONCLUSIVE',
            decidedAt: '2026-08-27T08:10:00.000Z',
          }
        : criterion),
    };
    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        current = { ...overview, runs: [completedRun] };
        return Promise.resolve(completedRun) as Promise<never>;
      }
      if (path === projectAcceptanceOverviewPath(PROJECT)) {
        return Promise.resolve(current) as Promise<never>;
      }
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount();
    await choose(1, 'INCONCLUSIVE');
    await typeInput(`#project-acceptance-criterion-2-task`, TASK);
    await typeInput(`#project-acceptance-criterion-2-session`, SESSION);
    await typeInput(`#project-acceptance-criterion-2-command`, 'rg -n setInterval src/apiserver/src/projects');
    await typeInput(`#project-acceptance-criterion-2-exit`, '1');
    await typeInput(`#project-acceptance-criterion-2-summary`, '没有足够证据判定为 PASS。');

    await act(async () => submitButton().click());
    await flush();
    await flush();

    const post = apiMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(post[0]).toBe(projectAcceptanceVerdictPath(PROJECT, RUN));
    const body = post[1]?.body as { criteria: Array<Record<string, unknown>> };
    expect(body.criteria).toHaveLength(1);
    expect(body.criteria[0]).toEqual({
      ordinal: 2,
      criterionId: DEFINITION_B,
      criterionKey: 'criterion-b',
      verdict: 'INCONCLUSIVE',
      summary: '没有足够证据判定为 PASS。',
      evidence: { command: 'rg -n setInterval src/apiserver/src/projects', exitCode: 1 },
      evidenceTaskId: TASK,
      evidenceSessionId: SESSION,
    });
    expect(container.textContent).toContain('此项目验收已由服务端推导为 INCONCLUSIVE');
    expect(submitButton().disabled).toBe(false, 'append-only human conclusions may be revised');
    expect(apiMock.mock.calls.filter(([path, options]) =>
      path === projectAcceptanceOverviewPath(PROJECT) && !options?.method).length).toBeGreaterThan(1);
  });

  it('routes an unratified contract to the separate Owner Ratification authority flow', async () => {
    const current: ProjectAcceptanceOverview = {
      ...overview,
      criteriaConfirmation: {
        confirmed: false,
        criteriaDigest: overview.criteriaDigest,
        confirmation: null,
      },
    };
    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === projectAcceptanceOverviewPath(PROJECT)) {
        return Promise.resolve(current) as Promise<never>;
      }
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount();

    expect(container.textContent).toContain('当前项目合约尚未 Owner Ratification');
    expect(container.textContent).toContain('Owner Ratification 是项目合约的价值与授权决定');
    expect(submitButton().disabled).toBe(true);
    const ratificationLink = [...container.querySelectorAll('a')].find((link) =>
      link.textContent?.includes('前往 Owner Ratification')) as HTMLAnchorElement;
    expect(ratificationLink.getAttribute('href')).toBe(ownerRatificationReviewPath(PROJECT));
    expect(apiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
});
