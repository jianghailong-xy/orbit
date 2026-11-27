// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProjectAcceptanceCard } from './ProjectAcceptanceCard';
import { ProjectReadyToRun } from './ProjectReadyToRun';
import { receiptClock } from './CriteriaDecisionCard';
import { ProjectTasks, projectTaskWorkLabel } from '../pages/ProjectsPage';
import { criterionLandingHalfSentence } from '../lib/projectDone';
import { projectReadyToRunQuery } from '../lib/queries';

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => undefined)) }));

/**
 * The shared cases (src/shared/src/project-page-labels.fixture.json) that OrbitKit and Android are
 * proved against too: the landing half-sentence (D2 A), the receipt moment (D4 A), and the stalled
 * and start-by-hand row labels (G4, G5).
 */
type Fixture = {
  landing: {
    main: string;
    cases: { name: string; criterion: { satisfied: boolean; landing: string; landingReason: string | null }; expected: string | null }[];
  };
  receiptTime: { now: string; timeZone: string; locale: string; cases: { name: string; at: string; expected: string }[] };
  taskRows: {
    cases: {
      name: string;
      task: Record<string, unknown>;
      runQueue: Record<string, unknown> | null;
      taskRow: string;
      runQueueRow: string | null;
    }[];
  };
};
const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../shared/src/project-page-labels.fixture.json'), 'utf8'),
) as Fixture;

const PROJECT = '0195c0de-0000-7000-8000-0000000000aa';

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } } });
}

function paint(qc: QueryClient, node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowFor(html: string, text: string): string {
  const row = (html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? []).find((r) => r.includes(text));
  if (row === undefined) throw new Error(`no row rendered for "${text}"`);
  return row;
}

const words = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&');

describe('landing half-sentence from landingReason (shared fixture)', () => {
  it.each(fixture.landing.cases)('$name', ({ criterion, expected }) => {
    expect(criterionLandingHalfSentence(
      { satisfied: criterion.satisfied, landingReason: criterion.landingReason as never },
      fixture.landing.main,
    )).toBe(expected);
  });

  it('the project page draws each case from the done read joined onto its criteria', () => {
    const cases = fixture.landing.cases;
    const qc = client();
    qc.setQueryData(['project', PROJECT], {
      id: PROJECT,
      integration: { ref: 'project/p', upstreamRef: fixture.landing.main },
      acceptanceCriteriaItems: cases.map((c, i) => ({
        id: `c-${i}`, ordinal: i + 1, text: `Criterion case ${c.name}`, revision: 1,
        satisfied: c.criterion.satisfied, unmet: [], landing: c.criterion.landing,
      })),
      derivedDone: {
        nonCode: false,
        criteria: cases.map((c, i) => ({ definitionId: `c-${i}`, landingReason: c.criterion.landingReason })),
      },
    });
    // Fewer cases than the card's preview limit (12), so every case is a row.
    const html = paint(qc, <ProjectAcceptanceCard projectId={PROJECT} />);
    for (const c of cases) {
      const row = rowFor(html, `Criterion case ${c.name}`);
      const landing = row.match(/<span class="acceptance-landing[^"]*">([\s\S]*?)<\/span>/);
      if (c.expected === null) {
        expect(landing, c.name).toBeNull();
      } else {
        expect(landing?.[1], c.name).toBe(c.expected);
        expect(row).not.toContain('no merge receipt either way');
      }
    }
  });
});

describe('receiptClock (shared fixture)', () => {
  const { now, timeZone, locale } = fixture.receiptTime;
  it.each(fixture.receiptTime.cases)('$name', ({ at, expected }) => {
    expect(receiptClock(at, new Date(now), { timeZone, locale })).toBe(expected);
  });
});

describe('stalled and start-by-hand row labels (shared fixture)', () => {
  const task = (i: number, over: Record<string, unknown>) => ({
    id: `task-${i}`, title: `Task case ${i}`, status: 'OPEN', parentTaskId: null,
    createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
    childCount: 0, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'READY',
    verificationState: null, ...over,
  });
  const cases = fixture.taskRows.cases;

  it.each(cases)('$name: the task row label', (c) => {
    expect(projectTaskWorkLabel(task(0, c.task) as never)?.text).toBe(c.taskRow);
  });

  it('the project page task rows carry them', () => {
    const qc = client();
    qc.setQueryData(['project', PROJECT, 'tasks', 'root'], {
      items: cases.map((c, i) => task(i, c.task)), nextCursor: null,
    });
    const html = paint(qc, <ProjectTasks projectId={PROJECT} />);
    cases.forEach((c, i) => {
      expect(words(rowFor(html, `Task case ${i}`)), c.name).toContain(c.taskRow);
    });
  });

  it('the run queue rows carry them', () => {
    const queued = cases.flatMap((c, i) => (c.runQueue ? [{ c, i }] : []));
    expect(queued.length).toBeGreaterThan(0);
    const qc = client();
    qc.setQueryData(projectReadyToRunQuery(PROJECT).queryKey, {
      readyCount: 0, queuedCount: 0, runningCount: queued.length, pausedCount: 0, impactTruncated: null,
      items: queued.map(({ c, i }) => ({
        taskId: `task-${i}`, title: `Task case ${i}`, status: 'OPEN', sessionId: `0195c0de-0000-7000-8000-00000000010${i}`,
        pausedList: null, downstreamBlocked: 0, ...c.runQueue,
      })),
    });
    const html = paint(qc, <ProjectReadyToRun projectId={PROJECT} />);
    for (const { c, i } of queued) {
      const row = words(rowFor(html, `Task case ${i}`));
      expect(row, c.name).toContain(c.runQueueRow);
      if (!c.task.runStalled) expect(row).not.toContain('no output');
    }
  });
});
