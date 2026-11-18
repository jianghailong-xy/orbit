// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectOpenItemRow, ProjectOpenItemsView } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_REVIEW_CONSEQUENCE,
  ItemAsCard,
  NEEDS_YOU_GROUP,
  ProjectOpenItems,
} from './ProjectProgressStatus';
import { projectOpenItemsQuery } from '../lib/queries';
import { encodeId } from '../lib/idCodec';

/**
 * The owner's item about evidence its coordinator has not decided (`EVIDENCE_UNDECIDED`, apiserver
 * migration 1110): it is in the project's Needs you, names the task, how long ago the revision was
 * submitted and that the coordinator has not decided it, and its Review opens the task's evidence.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34noHniU4wmCRkZJkR6df';
const TASK_ID = '34npQueueDrain0000001';
const NOW = Date.parse('2026-11-18T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** The row `GET /projects/:id/open-items` serves for it (`project-open-item.service.ts`). */
const UNDECIDED: ProjectOpenItemRow = {
  itemId: '4pEvidenceUndecided01',
  kind: 'EVIDENCE_UNDECIDED',
  title: 'Evidence waiting for a decision: Ship the queue drain',
  detailLine: 'Revision 1 was submitted 8 days ago, and the coordinator has not decided it.',
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: new Date(NOW - 8 * 24 * HOUR).toISOString(),
  escalateAt: null,
  escalatedAt: new Date(NOW - 8 * 24 * HOUR + 2 * HOUR).toISOString(),
  taskId: TASK_ID,
  sessionId: '1TtQueueDrainRun00001',
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['REVIEW', 'OPEN_TASK_SESSION'],
  requiredAction: 'The coordinator has not decided this evidence — review it, then confirm it or send it back.',
  primaryAction: 'REVIEW',
  question: null,
  facts: null,
  handling: null,
  outcome: null,
};

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const items: ProjectOpenItemsView = { needsYou: [UNDECIDED], withCoordinator: [] };
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, items);
  return qc;
}

function Where(): JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('EVIDENCE_UNDECIDED in the owner’s Needs you', () => {
  it('is listed under Needs you with the task, the age and the coordinator, and Review opens the evidence', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
          <QueryClientProvider client={client()}>
            <Routes>
              <Route path="/projects/:id" element={<ProjectOpenItems projectId={PROJECT_ID} now={NOW} />} />
              <Route path="/tasks/:id" element={<Where />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    const groups = [...container.querySelectorAll('.project-open-items-group')].map((node) => node.textContent);
    expect(groups).toContain(NEEDS_YOU_GROUP);
    expect(container.textContent).toContain('Evidence waiting for a decision: Ship the queue drain');

    const review = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Review');
    expect(review, 'the row draws a Review press').toBeTruthy();
    expect(review!.getAttribute('href')).toBe(`/tasks/${encodeURIComponent(encodeId(TASK_ID))}`);

    act(() => {
      review!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(container.querySelector('[data-testid="where"]')?.textContent)
      .toBe(`/tasks/${encodeId(TASK_ID)}`);
  });

  it('as a card, says how long ago it was submitted and that Review opens the task’s evidence', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client()}>
            <ItemAsCard projectId={PROJECT_ID} row={UNDECIDED} now={NOW} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain('Revision 1 was submitted 8 days ago, and the coordinator has not decided it.');
    expect(container.textContent).toContain(EVIDENCE_REVIEW_CONSEQUENCE);
    const review = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Review');
    expect(review?.getAttribute('href')).toBe(`/tasks/${encodeURIComponent(encodeId(TASK_ID))}`);
  });
});
