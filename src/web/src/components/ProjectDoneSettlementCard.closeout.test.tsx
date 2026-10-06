// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectOpenItemRow, SessionWaitingKind } from '@orbit/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ProjectDoneCard, ProjectWhyNotDoneCard, SessionProjectSettlementCard } from './ProjectSettlementCard';
import {
  PROJECT_DONE_COPY,
  orbitCheckedOpenItemCount,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * The closeout read model as the coordinator conversation and the project page draw it: the owner's
 * DONE receipt survives a refresh, a reopened project is not read as DONE off a leftover `doneBy`,
 * Why-not-done is asked only of a started OPEN project whose criteria are all met (the rest of that
 * gate is `ProjectWhyNotDoneGate.test.tsx`'s), the request's wait is its own `waitingSince`, Orbit
 * checked does not count the request it is reviewing, and an unmet criterion is labelled as unmet
 * work rather than by its landing lane.
 */
vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34Y7My8sqhKLWtmCQYv1l';
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

const counts = (over: Partial<Record<string, number>> = {}) => ({
  criteria: 2,
  met: 2,
  landed: 1,
  onMain: 1,
  byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 1, CODELESS: 0, ...over },
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
      status: 'OPEN',
      done: false,
      withheld: ['CRITERION_UNLANDED'],
      confirmation: 'CONFIRMED',
      criteria: [
        { definitionId: 'c1', satisfied: true, landing: 'LANDED', landingReason: null },
        { definitionId: 'c2', satisfied: true, landing: 'UNKNOWN', landingReason: 'NO_RECEIPT' },
      ],
      counts: counts(),
    },
    doneBy: null,
    doneAt: null,
    acceptedGaps: [],
    ...over,
  };
}

const ownerDone = (): ProjectDoneDocument => doc({
  status: 'DONE',
  doneBy: 'OWNER',
  doneAt: '2026-10-05T11:00:00.000Z',
  acceptedGaps: [{ criterionKey: 'c2', title: 'The live check was completed', whyNotProven: 'No receipt.' }],
});

function row(over: Partial<ProjectOpenItemRow>): ProjectOpenItemRow {
  return {
    itemId: 'item',
    kind: 'TASK_FAILED',
    title: 'Item',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'OWNER_DECISION' as ProjectOpenItemRow['assigneeReason'],
    waitingSince: new Date(NOW - 5 * MINUTE).toISOString(),
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
const doneRow = (waitedMs: number, now = NOW) => row({
  itemId: 'done-1',
  kind: 'DONE_REQUEST',
  waitingSince: new Date(now - waitedMs).toISOString(),
  doneRequest: request,
});

describe('the owner DONE receipt and the current project status', () => {
  it('does not read a reopened project as DONE off a leftover doneBy', () => {
    const reopened = doc({ status: 'OPEN', doneBy: 'OWNER', doneAt: '2026-10-04T00:00:00.000Z' });
    const html = renderToStaticMarkup(
      <ProjectDoneCard project={reopened} doneRequest={request} onRecordDone={() => {}} />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.heading);
    expect(html).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
  });

  it('still draws the receipt for an owner-recorded DONE', () => {
    const html = renderToStaticMarkup(<ProjectDoneCard project={ownerDone()} />);
    expect(html).toContain(PROJECT_DONE_COPY.receiptPrefix);
    expect(html).toContain(`${PROJECT_DONE_COPY.recordedByYou} · 1 ${PROJECT_DONE_COPY.gapsAccepted}`);
  });
});

describe('the request’s wait', () => {
  it('is read off DONE_REQUEST.waitingSince on the owner card, not written as just now', () => {
    const html = renderToStaticMarkup(
      <ProjectDoneCard
        project={doc()}
        doneRequest={request}
        requestWaitingSince={new Date(NOW - 25 * MINUTE).toISOString()}
        now={NOW}
        onRecordDone={() => {}}
      />,
    );
    expect(html).toContain(`${PROJECT_DONE_COPY.askedByCoordinator} · waiting 25m`);
    expect(html).not.toContain('just now');
  });

  it('is read off DONE_REQUEST.waitingSince beside Needs your call', () => {
    const html = renderToStaticMarkup(
      <ProjectWhyNotDoneCard project={doc()} openItems={{ doneRequest: doneRow(2 * 60 * MINUTE) }} now={NOW} onReview={() => {}} />,
    );
    expect(html).toContain(PROJECT_DONE_COPY.needsYourCall);
    expect(html).toContain(`${PROJECT_DONE_COPY.openItemsDoneRequest.toLowerCase()} · waiting 2h`);
    expect(html).not.toContain('just now');
  });
});

describe('Orbit checked', () => {
  it('does not count the DONE_REQUEST under review, and keeps every other open item', () => {
    const view = {
      needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' }), doneRow(MINUTE)],
      withCoordinator: [row({ itemId: 'x1', kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR' })],
      doneRequest: doneRow(MINUTE),
    };
    expect(orbitCheckedOpenItemCount(view)).toBe(2);
    expect(orbitCheckedOpenItemCount({ needsYou: [], withCoordinator: [], doneRequest: doneRow(MINUTE) })).toBe(0);
    expect(orbitCheckedOpenItemCount(undefined)).toBe(0);
  });
});

describe('Why-not-done labels for unmet criteria', () => {
  it('names unmet work as not met yet, not by a landing lane that reads as finished', () => {
    const project = doc({
      derivedDone: {
        status: 'OPEN',
        done: false,
        withheld: ['CRITERION_UNSATISFIED'],
        confirmation: 'CONFIRMED',
        criteria: [
          { definitionId: 'c1', satisfied: false, landing: 'UNKNOWN', landingReason: 'NO_RECEIPT' },
          { definitionId: 'c2', satisfied: false, landing: 'UNKNOWN', landingReason: 'CODELESS' },
        ],
        counts: { criteria: 2, met: 0, landed: 0, onMain: 0, byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 1, CODELESS: 1 } },
      },
    });
    const html = renderToStaticMarkup(<ProjectWhyNotDoneCard project={project} now={NOW} />);
    expect(html).toContain(PROJECT_DONE_COPY.waitingOnWork);
    expect(html).not.toContain(PROJECT_DONE_COPY.needsYourCall);
    const states = [...html.matchAll(/class="project-why-item-state">([^<]*)</g)].map((m) => m[1]);
    expect(states).toEqual([PROJECT_DONE_COPY.notMetYet, PROJECT_DONE_COPY.notMetYet]);
    expect(html).not.toContain(PROJECT_DONE_COPY.mergedOutsideOrbit);
    expect(html).not.toContain('No code to land');
    expect(html).not.toContain(PROJECT_DONE_COPY.waitingDetail);
  });

  it('keeps the landing lane for met criteria: in flight waits, no receipt needs your call', () => {
    const project = doc({
      derivedDone: {
        status: 'OPEN',
        done: false,
        withheld: ['CRITERION_UNLANDED'],
        confirmation: 'CONFIRMED',
        criteria: [
          { definitionId: 'c1', satisfied: true, landing: 'ON_INTEGRATION_LINE', landingReason: 'IN_FLIGHT' },
          { definitionId: 'c2', satisfied: true, landing: 'UNKNOWN', landingReason: 'NO_RECEIPT' },
        ],
        counts: counts({ IN_FLIGHT: 1 }),
      },
    });
    const html = renderToStaticMarkup(<ProjectWhyNotDoneCard project={project} now={NOW} />);
    const states = [...html.matchAll(/class="project-why-item-state">([^<]*)</g)].map((m) => m[1]);
    expect(states).toEqual(['In flight', PROJECT_DONE_COPY.mergedOutsideOrbit]);
    expect(html).toContain(PROJECT_DONE_COPY.waitingDetail);
    expect(html).toContain(PROJECT_DONE_COPY.needsCallDetail);
  });
});

describe('the coordinator conversation’s closeout card', () => {
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

  async function mount(
    document: ProjectDoneDocument,
    openItems: Record<string, unknown>,
    waitingKind: SessionWaitingKind | null = null,
  ): Promise<HTMLElement> {
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
      tree.render(
        <QueryClientProvider client={client}>
          <SessionProjectSettlementCard projectId={PROJECT} waitingKind={waitingKind} />
        </QueryClientProvider>,
      );
    });
    for (let n = 0; n < 20; n += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
      });
    }
    return node;
  }

  it('keeps the owner’s DONE receipt after a refresh, with no request and no local receipt', async () => {
    const view = await mount(ownerDone(), { needsYou: [], withCoordinator: [], doneRequest: null });
    expect(view.textContent).toContain(PROJECT_DONE_COPY.receiptPrefix);
    expect(view.textContent).not.toContain(PROJECT_DONE_COPY.whyHeading);
  });

  it('asks Why-not-done of a started OPEN project whose criteria are all met', async () => {
    const view = await mount(doc(), { needsYou: [], withCoordinator: [], doneRequest: null });
    expect(view.textContent).toContain(PROJECT_DONE_COPY.whyHeading);
  });

  it('asks nothing of a project nobody has started', async () => {
    const view = await mount(doc({ startedAt: null }), { needsYou: [], withCoordinator: [], doneRequest: null });
    expect(view.textContent).not.toContain(PROJECT_DONE_COPY.whyHeading);
  });

  it('asks nothing of a project with no criteria', async () => {
    const view = await mount(
      doc({
        acceptanceCriteriaItems: [],
        derivedDone: {
          status: 'OPEN',
          done: false,
          withheld: ['NO_CRITERIA'],
          confirmation: 'UNCONFIRMED',
          criteria: [],
          counts: { criteria: 0, met: 0, landed: 0, onMain: 0, byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 } },
        },
      }),
      { needsYou: [], withCoordinator: [], doneRequest: null },
    );
    expect(view.textContent).not.toContain(PROJECT_DONE_COPY.whyHeading);
  });

  it('asks nothing of a project that is not OPEN', async () => {
    const view = await mount(doc({ status: 'CANCELLED' }), { needsYou: [], withCoordinator: [], doneRequest: null });
    expect(view.textContent).not.toContain(PROJECT_DONE_COPY.whyHeading);
  });

  it('times the request by its waitingSince and leaves it out of Orbit checked', async () => {
    const view = await mount(
      doc(),
      {
        needsYou: [row({ itemId: 'q1', kind: 'COORDINATOR_QUESTION' })],
        withCoordinator: [],
        doneRequest: doneRow(25 * MINUTE, Date.now()),
      },
      'DONE_REQUEST',
    );
    expect(view.textContent).toContain(PROJECT_DONE_COPY.heading);
    expect(view.textContent).toContain(`${PROJECT_DONE_COPY.askedByCoordinator} · waiting 25m`);
    expect(view.textContent).not.toContain('just now');
    expect(view.textContent).toContain('1 open item');
    expect(view.textContent).not.toContain('2 open items');
  });
});
