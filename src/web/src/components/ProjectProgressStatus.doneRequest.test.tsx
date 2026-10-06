// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectOpenItemRow, ProjectOpenItemsView } from '@orbit/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOpenItems } from './ProjectProgressStatus';
import { projectOpenItemsQuery } from '../lib/queries';
import { PROJECT_DONE_COPY } from '../lib/projectDone';

/**
 * Open items on the project page, for the two ways a project gets recorded done: the coordinator's
 * DONE_REQUEST, which is waiting on the owner and counts, and the owner's own "Record as done…",
 * which nobody is waiting on — a grey hint, counted nowhere.
 */
vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34Y7My8sqhKLWtmCQYv1l';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const MINUTE = 60 * 1000;

const doneRow: ProjectOpenItemRow = {
  itemId: 'done-1',
  kind: 'DONE_REQUEST',
  title: 'Is this project done?',
  detailLine: 'The coordinator asked',
  assignee: 'OWNER',
  assigneeReason: 'OWNER_DECISION' as ProjectOpenItemRow['assigneeReason'],
  waitingSince: new Date(NOW - 25 * MINUTE).toISOString(),
  escalateAt: null,
  escalatedAt: null,
  taskId: null,
  sessionId: null,
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: [],
  question: null,
  facts: null,
  doneRequest: { criteriaDigest: 'd', judgment: 'Done.', gaps: [] },
};

function paint(items: ProjectOpenItemsView, onRecordDone?: () => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, items);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ProjectOpenItems
          projectId={PROJECT_ID}
          now={NOW}
          started
          onReviewDone={() => {}}
          onRecordDone={onRecordDone}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Record as done… in Open items', () => {
  it('is a grey hint the owner can press, and is not counted as needing them', () => {
    const html = paint({ needsYou: [], withCoordinator: [], doneRequest: null }, () => {});

    expect(html).toContain(PROJECT_DONE_COPY.recordAsDoneRow);
    expect(html).toMatch(/class="project-open-item-row[^"]*\bis-hint\b[^"]*"[^>]*data-kind="DONE"/);
    expect(html).toContain('0 need you · 0 with the coordinator · oldest first');
  });

  it('gives way to the coordinator’s request, which counts once with its wait', () => {
    const html = paint({ needsYou: [], withCoordinator: [], doneRequest: doneRow }, () => {});

    expect(html).not.toContain(PROJECT_DONE_COPY.recordAsDoneRow);
    expect(html).toContain('data-kind="DONE_REQUEST"');
    expect(html).toContain('waiting 25m');
    expect(html).toContain('1 need you · 0 with the coordinator · oldest first');
  });
});
