import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { JudgmentRequestSummary } from '../components/JudgmentRequestSummary';
import { encodeId } from '../lib/idCodec';
import {
  judgmentInboxPath,
  judgmentRequestFromTaskDeepLink,
  judgmentReviewPath,
  type JudgmentInboxItem,
} from '../lib/judgments';
import {
  projectAcceptanceReviewPath,
  type ProjectAcceptanceInboxItem,
} from '../lib/projectAcceptance';
import { JudgmentInboxPage } from './JudgmentInboxPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

const REQUEST = encodeId('019fcda0-d021-72a2-a914-2f4de38f4701');
const TASK = encodeId('019fcda0-d021-72a2-a914-2f4de38f4702');
const PROJECT = encodeId('019fcda0-d021-72a2-a914-2f4de38f4703');
const EVIDENCE = encodeId('019fcda0-d021-72a2-a914-2f4de38f4704');
const RUN = encodeId('019fcda0-d021-72a2-a914-2f4de38f4707');
const DIGEST = 'a'.repeat(64);

const item: JudgmentInboxItem = {
  inboxItemId: encodeId('019fcda0-d021-72a2-a914-2f4de38f4705'),
  requestVersion: 1,
  deliveredAt: '2026-08-26T08:00:00.000Z',
  notificationDeepLink: `/tasks/${TASK}?judgmentRequest=${REQUEST}`,
  requestId: REQUEST,
  requestStatus: 'OPEN',
  decision: null,
  taskId: TASK,
  taskTitle: 'Review this exact accessible build',
  taskStatus: 'OPEN',
  projectId: PROJECT,
  projectTitle: 'N13 human review',
  evidenceId: EVIDENCE,
  evidenceRevision: '7',
  evidenceDigest: DIGEST,
  submittedAt: '2026-08-26T07:59:00.000Z',
  actorType: 'AGENT',
  actorId: encodeId('019fcda0-d021-72a2-a914-2f4de38f4706'),
  actorName: 'Implementation workspace',
  commit: '0123456789abcdef',
  testSummary: { command: 'npm test -w @orbit/web', exitCode: 0 },
  isCurrent: true,
  pushDelivery: null,
};

const projectItem: ProjectAcceptanceInboxItem = {
  runId: RUN,
  projectId: PROJECT,
  projectTitle: 'N20 project acceptance',
  projectStatus: 'OPEN',
  attempt: '4',
  startedAt: '2026-08-26T08:01:00.000Z',
  criterionCount: 10,
  answeredCount: 0,
  unansweredCount: 10,
  currentVerdict: 'UNDECIDED',
};

function cacheWith(key: unknown[], data: unknown): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  client.setQueryData(key, data);
  return client;
}

describe('human judgment entry points', () => {
  it('renders the global 待我判定 inbox as exact request/revision links', () => {
    const client = cacheWith(['judgments', 'open'], { total: 1, items: [item] });
    client.setQueryData(['project-acceptance', 'pending'], { total: 1, items: [projectItem] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <JudgmentInboxPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain('待我判定');
    expect(html).toContain('任务级 HUMAN_SIGNOFF 与项目级验收共用一个收件箱');
    expect(html).toContain('Review this exact accessible build');
    expect(html).toContain('Evidence</dt><dd>r7');
    expect(html).toContain('Implementation workspace');
    expect(html).toContain('0123456789abcdef');
    expect(html).toContain(`href="${judgmentReviewPath(REQUEST)}"`);
    expect(html).toContain('N20 project acceptance');
    expect(html).toContain('项目级验收');
    expect(html).toContain('attempt 4');
    expect(html).toContain('0/10 answered');
    expect(html).toContain(`href="${projectAcceptanceReviewPath(PROJECT, RUN)}"`);
  });

  it('embeds the same open request on project and task pages without a decision shortcut', () => {
    const renderSummary = (scope: { projectId?: string; taskId?: string }) => {
      const client = cacheWith(
        ['judgments', 'open', { projectId: scope.projectId ?? null, taskId: scope.taskId ?? null }],
        { total: 1, items: [item] },
      );
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <JudgmentRequestSummary {...scope} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    };
    for (const html of [renderSummary({ projectId: PROJECT }), renderSummary({ taskId: TASK })]) {
      expect(html).toContain('Review this exact accessible build');
      expect(html).toContain('Evidence r7');
      expect(html).toContain(`href="${judgmentReviewPath(REQUEST)}"`);
      expect(html).not.toContain('签字通过');
      expect(html).not.toContain('要求补充证据');
    }
  });

  it('preserves the exact request id from N12 notification deep links', () => {
    const rawRequest = '019fcda0-d021-72a2-a914-2f4de38f4701';
    expect(judgmentRequestFromTaskDeepLink(rawRequest)).toBe(REQUEST);
    expect(judgmentRequestFromTaskDeepLink(REQUEST)).toBe(REQUEST);
    expect(judgmentReviewPath(judgmentRequestFromTaskDeepLink(rawRequest)!)).toBe(
      judgmentReviewPath(REQUEST),
    );
  });

  it('builds scoped inbox requests without losing either project or task identity', () => {
    expect(judgmentInboxPath({ status: 'OPEN', projectId: PROJECT, taskId: TASK, limit: 5 }))
      .toBe(`/judgments?status=OPEN&projectId=${PROJECT}&taskId=${TASK}&limit=5`);
  });
});
