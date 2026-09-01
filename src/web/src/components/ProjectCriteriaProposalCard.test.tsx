// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { encodeId } from '../lib/idCodec';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { ProjectCriteriaProposalCard, criteriaProposalPath, criteriaProposalDecisionPath } =
  await import('./ProjectCriteriaProposalCard');

const PROJECT_UUID = '0195c0de-0000-7000-8000-0000000000b1';
const PROJECT = encodeId(PROJECT_UUID);
const PROPOSAL = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const CONTRACT = 'a'.repeat(64);
const CARD_DIGEST = 'b'.repeat(64);
const NEXT_CARD_DIGEST = 'c'.repeat(64);

function read(cardDigest = CARD_DIGEST) {
  return {
    projectId: PROJECT,
    currentContractDigest: CONTRACT,
    ratified: true,
    effectiveCriteria: [{
      definitionId: 'd1', text: 'release DAG 全绿', completionCriterion: 'HUMAN_SIGNOFF',
    }],
    proposal: {
      id: PROPOSAL,
      cardDigest,
      reasonCode: 'GOAL_DECISION',
      status: 'PENDING',
      baseMatchesCurrentContract: true,
      card: {
        title: 'Change this project’s acceptance criteria?',
        headline: '1 of this project’s acceptance criteria change: 0 added, 0 removed, 1 retyped.',
        reason: 'GOAL_DECISION',
        whyNotAgent: '改这条等于我给自己挪考卷',
        options: [
          { value: 'APPROVE' as const, label: '应用这份标准并批准由此产生的契约' },
          { value: 'DENY' as const, label: '保留生效中的标准并记录这次拒绝' },
        ],
        impacts: { APPROVE: '按你看到的这一份原子应用', DENY: '什么都不变，拒绝会被记录' },
        recommendation: '逐条读完再决定',
        noActionConsequence: '不会有任何超时、重试或重复提交能替你应用它',
        cost: '批准会推进 contract digest',
        deadline: '这张卡片展示到 2026-09-08T00:00:00Z',
        resumeBehavior: '批准后被 OWNER_RATIFICATION_REQUIRED 挡住的工作会自动恢复',
      },
      semanticDiff: {
        changedCriteria: [{
          changeKind: 'MODIFIED' as const,
          definitionId: 'd1',
          summary: 'MODIFIED criterion release DAG 全绿',
          textChanged: false,
          completionCriterionChanged: true,
          verificationMethodChanged: true,
          text: { before: 'release DAG 全绿', after: 'release DAG 全绿' },
          completionCriterion: { before: 'HUMAN_SIGNOFF', after: 'VERIFICATION' },
          verificationMethod: { before: '发版负责人确认', after: '独立复核任务给出 PASS' },
        }],
        counts: { added: 0, removed: 0, modified: 1, unchanged: 0 },
        completionCriterionChanged: true,
        verificationMethodChanged: true,
      },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProjectCriteriaProposalCard projectId={PROJECT_UUID} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  apiMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

// The card is the whole point: a reader who cannot see that a criterion changed from
// HUMAN_SIGNOFF to VERIFICATION cannot consent to it, and "confirm?" would be exactly that.
it('renders the eight-item protocol and a per-criterion semantic diff', async () => {
  apiMock.mockResolvedValueOnce(read());
  await mount();

  const text = container.textContent ?? '';
  for (const line of [
    '改这条等于我给自己挪考卷',
    '按你看到的这一份原子应用',
    '什么都不变，拒绝会被记录',
    '逐条读完再决定',
    '不会有任何超时、重试或重复提交能替你应用它',
    '批准会推进 contract digest',
    '这张卡片展示到 2026-09-08T00:00:00Z',
    '批准后被 OWNER_RATIFICATION_REQUIRED 挡住的工作会自动恢复',
  ]) expect(text).toContain(line);
  expect(text).toContain('HUMAN_SIGNOFF → VERIFICATION');
  expect(text).toContain('发版负责人确认 → 独立复核任务给出 PASS');
  expect(text).toContain('GOAL_DECISION');
  // It says, on the card, that reading it has changed nothing.
  expect(text).toContain('提议本身没有改动任何东西');
  expect(container.querySelectorAll('button')).toHaveLength(2);
  expect(apiMock).toHaveBeenCalledWith(criteriaProposalPath(PROJECT_UUID));
});

it('submits the digest of the rendering it showed', async () => {
  apiMock.mockResolvedValueOnce(read());
  await mount();
  apiMock.mockResolvedValueOnce({ ok: true, status: 'APPLIED' });
  apiMock.mockResolvedValueOnce({ ...read(), proposal: null });

  await act(async () => {
    (container.querySelectorAll('button')[0] as HTMLButtonElement).click();
  });

  expect(apiMock).toHaveBeenCalledWith(criteriaProposalDecisionPath(PROJECT_UUID), {
    method: 'POST',
    body: {
      decision: 'APPROVE',
      proposalId: PROPOSAL,
      expectedCardDigest: CARD_DIGEST,
      idempotencyKey: `criteria-proposal:web:v1:${PROPOSAL}:APPROVE`,
    },
  });
  expect(container.textContent).toContain('已批准');
});

// Approve what you saw: a proposal the agent revised while this card was open is REFUSED, and the
// reader is shown the new one rather than told their click worked.
it('re-renders the current proposal when the one it showed went stale', async () => {
  apiMock.mockResolvedValueOnce(read());
  await mount();
  apiMock.mockRejectedValueOnce(new ApiError(
    'the criteria proposal card moved', 409, 'CRITERIA_PROPOSAL_CARD_STALE',
    { currentCardDigest: NEXT_CARD_DIGEST },
  ));
  const revised = read(NEXT_CARD_DIGEST);
  revised.proposal!.card.headline = '这是被改写之后的那一份';
  apiMock.mockResolvedValueOnce(revised);

  await act(async () => {
    (container.querySelectorAll('button')[0] as HTMLButtonElement).click();
  });

  const text = container.textContent ?? '';
  expect(text).toContain('提议在你阅读期间被改写了');
  expect(text).toContain('这是被改写之后的那一份');
  expect(text).not.toContain('已批准');
});

it('renders nothing when the owner has no proposal waiting', async () => {
  apiMock.mockResolvedValueOnce({ ...read(), proposal: null });
  await mount();
  expect(container.textContent).toBe('');
});
