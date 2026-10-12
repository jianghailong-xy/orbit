// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectOpenItemRow, SessionWaitingKind } from '@orbit/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ProjectDoneCard, ProjectDoneDialog, SessionProjectSettlementCard } from './ProjectSettlementCard';
import {
  PROJECT_DONE_COPY,
  orbitCheckedOpenItemCount,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * The three places the web closeout read the project differently from the native clients:
 * an Orbit-recorded DONE draws the Why-not-done terminal in the coordinator conversation after a
 * refresh, Orbit checked leaves out only the DONE_REQUEST under review (a START_REQUEST still
 * counts), and the receipt is drawn only for a project whose status is DONE.
 */
vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34Y7My8sqhKLWtmCQYv1l';
const MINUTE = 60 * 1000;

const counts = () => ({
  criteria: 2,
  met: 2,
  landed: 2,
  onMain: 2,
  byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 },
});

function doc(over: Partial<ProjectDoneDocument> & { startedAt?: string | null } = {}): ProjectDoneDocument & { startedAt?: string | null } {
  return {
    id: PROJECT,
    title: 'Closeout',
    status: 'OPEN',
    startedAt: '2026-10-01T00:00:00.000Z',
    acceptanceCriteriaItems: [
      { id: 'c1', ordinal: 1, text: 'The web fix is on main' },
      { id: 'c2', ordinal: 2, text: 'The live check was completed' },
    ],
    derivedDone: {
      status: 'DONE',
      done: true,
      withheld: [],
      confirmation: 'CONFIRMED',
      criteria: [
        { definitionId: 'c1', satisfied: true, landing: 'LANDED', landingReason: null },
        { definitionId: 'c2', satisfied: true, landing: 'LANDED', landingReason: null },
      ],
      counts: counts(),
    },
    doneBy: null,
    doneAt: null,
    acceptedGaps: [],
    ...over,
  };
}

const orbitDone = (doneBy: ProjectDoneDocument['doneBy']) => doc({
  status: 'DONE',
  doneBy,
  doneAt: '2026-10-05T11:00:00.000Z',
});

function row(over: Partial<ProjectOpenItemRow>): ProjectOpenItemRow {
  return {
    itemId: 'item',
    kind: 'TASK_FAILED',
    title: 'Item',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'OWNER_DECISION' as ProjectOpenItemRow['assigneeReason'],
    waitingSince: new Date(Date.now() - 5 * MINUTE).toISOString(),
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
    ...over,
  };
}

const request = { criteriaDigest: 'digest-1', judgment: 'The goal is met.', gaps: [] };
const doneRow = () => row({ itemId: 'done-1', kind: 'DONE_REQUEST', doneRequest: request });
const startRow = () => row({ itemId: 'start-1', kind: 'START_REQUEST' });

let root: Root | null = null;
let node: HTMLElement | null = null;
let qc: QueryClient | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  node?.remove();
  node = null;
  await qc?.cancelQueries();
  qc?.clear();
  qc = null;
  vi.mocked(api).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(document: ProjectDoneDocument, openItems: Record<string, unknown>, element: ReactNode): Promise<void> {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path.endsWith('/open-items')) return openItems;
    if (path.includes('/acceptance/confirmation')) {
      return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
    }
    return document;
  }) as unknown as typeof api);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  node = window.document.createElement('div');
  window.document.body.appendChild(node);
  const tree = createRoot(node);
  root = tree;
  const client = qc;
  await act(async () => {
    tree.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  for (let n = 0; n < 20; n += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
    });
  }
}

const session = (waitingKind: SessionWaitingKind | null = null) => (
  <SessionProjectSettlementCard projectId={PROJECT} waitingKind={waitingKind} />
);
const dialog = (project: ProjectDoneDocument) => (
  <ProjectDoneDialog projectId={PROJECT} open onClose={() => {}} project={project} />
);
const text = (): string => window.document.body.textContent ?? '';
const noItems = { needsYou: [], withCoordinator: [], doneRequest: null };

describe('an Orbit-recorded DONE in the coordinator conversation', () => {
  it.each([['DERIVED' as const], [null]])('draws This project is done · recorded by Orbit after a refresh (doneBy %s)', async (doneBy) => {
    await mount(orbitDone(doneBy), noItems, session());
    const card = window.document.querySelector('.project-why-not-done.is-settled');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.project-settlement-heading')?.textContent).toBe(PROJECT_DONE_COPY.thisProjectIsDone);
    expect(card?.querySelector('.criteria-provenance')?.textContent).toBe(PROJECT_DONE_COPY.recordedByOrbit);
    expect(text()).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
  });

  it('keeps the owner’s persistent receipt for an owner-recorded DONE', async () => {
    await mount(orbitDone('OWNER'), noItems, session());
    expect(text()).toContain(PROJECT_DONE_COPY.receiptPrefix);
    expect(window.document.querySelector('.project-why-not-done')).toBeNull();
  });
});

describe('Orbit checked leaves out only the DONE_REQUEST under review', () => {
  it('counts a START_REQUEST and every needsYou/withCoordinator row', () => {
    const view = {
      needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' })],
      withCoordinator: [row({ itemId: 'x1', kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR' })],
      startRequest: startRow(),
      doneRequest: doneRow(),
    };
    expect(orbitCheckedOpenItemCount(view)).toBe(3);
    expect(orbitCheckedOpenItemCount({ needsYou: [], withCoordinator: [], startRequest: startRow(), doneRequest: null })).toBe(1);
  });

  it('excludes nothing when the owner opens it without a DONE_REQUEST', () => {
    const view = {
      needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' }), row({ itemId: 'stray', kind: 'DONE_REQUEST' })],
      withCoordinator: [],
      doneRequest: null,
    };
    expect(orbitCheckedOpenItemCount(view)).toBe(2);
  });

  it('draws the same count on the conversation card', async () => {
    await mount(
      doc({ derivedDone: { ...doc().derivedDone!, status: 'OPEN', done: false, withheld: ['CRITERION_UNLANDED'] } }),
      { needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' })], withCoordinator: [], startRequest: startRow(), doneRequest: doneRow() },
      session('DONE_REQUEST'),
    );
    expect(text()).toContain(PROJECT_DONE_COPY.heading);
    expect(text()).toContain('2 open items');
  });

  it('draws the same count in the project page dialog', async () => {
    const project = doc({ derivedDone: { ...doc().derivedDone!, status: 'OPEN', done: false, withheld: ['CRITERION_UNLANDED'] } });
    await mount(
      project,
      { needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' })], withCoordinator: [], startRequest: startRow(), doneRequest: doneRow() },
      dialog(project),
    );
    expect(text()).toContain(PROJECT_DONE_COPY.heading);
    expect(text()).toContain('2 open items');
  });
});

describe('the receipt follows the project status only', () => {
  const openButDerivedDone = () => doc({ status: 'OPEN', doneBy: null });

  it('draws the closeout card, not a receipt, for an OPEN project whose derived read says done', () => {
    const html = renderToStaticMarkup(<ProjectDoneCard project={openButDerivedDone()} onRecordDone={() => {}} />);
    expect(html).toContain(PROJECT_DONE_COPY.heading);
    expect(html).toContain(PROJECT_DONE_COPY.recordAsDone);
    expect(html).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
    expect(html).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
  });

  it('draws the closeout card for an OPEN project with a leftover non-owner doneBy', () => {
    const html = renderToStaticMarkup(
      <ProjectDoneCard project={doc({ status: 'OPEN', doneBy: 'DERIVED', doneAt: '2026-10-04T00:00:00.000Z' })} doneRequest={request} onRecordDone={() => {}} />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.notYet);
    expect(html).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
  });

  it('draws the closeout card in the conversation for an OPEN, derived-done project', async () => {
    await mount(openButDerivedDone(), { ...noItems, doneRequest: doneRow() }, session('DONE_REQUEST'));
    expect(text()).toContain(PROJECT_DONE_COPY.notYet);
    expect(text()).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
  });

  it('draws the closeout card in the dialog for an OPEN, derived-done project', async () => {
    const project = openButDerivedDone();
    await mount(project, noItems, dialog(project));
    expect(text()).toContain(PROJECT_DONE_COPY.recordAsDone);
    expect(text()).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
  });

  it('draws This project is done · recorded by Orbit for a DONE project not recorded by the owner', () => {
    const html = renderToStaticMarkup(<ProjectDoneCard project={orbitDone('DERIVED')} />);
    expect(html).toContain(`${PROJECT_DONE_COPY.thisProjectIsDone} · ${PROJECT_DONE_COPY.recordedByOrbit}`);
    expect(html).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
  });
});
