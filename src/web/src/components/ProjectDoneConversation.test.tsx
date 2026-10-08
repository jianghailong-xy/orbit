// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CriterionLandingReason, ProjectDoneRecord, ProjectOpenItemRow, SessionWaitingKind } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { SessionProjectSettlementCard } from './ProjectSettlementCard';
import {
  PROJECT_DONE_COPY,
  type ProjectDoneCriterion,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * What a coordinator conversation draws about closing a project — and what it no longer draws.
 *
 * "Why is this project not done?" is gone from the conversation: the owner's ruling of 2026-10-07
 * 04:20Z keeps the close-out request-driven, so a project nobody has asked about and nothing has
 * recorded draws NOTHING here — every state of it: every criterion met, one unmet, six unmet, a
 * task IN_PROGRESS, no criteria, a read without counts. The gaps, and the entries that act on them,
 * are the project page's Open items row and the Needs you hint (`ProjectProgressStatus.tsx`), which
 * this file leaves where they are.
 *
 * Three drawings stay, and each is asserted here with the words it puts on screen:
 *   • a DONE_REQUEST (or the row's Record as done…, or this conversation's own press) → "Is this
 *     project done?", whose press records the project and leaves its receipt;
 *   • status DONE recorded by Orbit → "This project is done · recorded by Orbit";
 *   • status DONE recorded by the owner → "You recorded this project done".
 *
 * The native clients hold the same rule and the same three drawings in
 * `ProjectDoneConversationTests.swift` and `ProjectWhyNotDoneGateTests.swift`, whose words
 * `ProjectDoneCopyParityTests` reads back against this source.
 */
vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34Y7My8sqhKLWtmCQYv1l';

type Doc = ProjectDoneDocument & { startedAt?: string | null; tasksByStatus?: Record<string, number> };

function criterion(
  definitionId: string,
  satisfied: boolean,
  landingReason: CriterionLandingReason | null,
): ProjectDoneCriterion {
  const landing = landingReason === null || landingReason === 'NOTHING_TO_LAND'
    ? 'LANDED'
    : landingReason === 'IN_FLIGHT' ? 'ON_INTEGRATION_LINE' : 'UNKNOWN';
  return { definitionId, satisfied, landing, landingReason };
}

/** The counts the server serves beside these answers (`derivedDoneCounts`). */
function countsOf(criteria: readonly ProjectDoneCriterion[]) {
  const byReason: Record<CriterionLandingReason, number> = {
    IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0,
  };
  let onMain = 0;
  for (const answer of criteria) {
    if (answer.landingReason === null) onMain += 1;
    else byReason[answer.landingReason] += 1;
  }
  return {
    criteria: criteria.length,
    met: criteria.filter((answer) => answer.satisfied).length,
    landed: criteria.filter((answer) => answer.landing === 'LANDED').length,
    onMain,
    byReason,
  };
}

/** A started OPEN project whose every criterion is met and none of whose tasks is running — the
 *  project the old card was drawn for. Each case below changes one fact of it. */
function finished(
  over: Partial<Doc> = {},
  criteria: readonly ProjectDoneCriterion[] = [criterion('c1', true, null), criterion('c2', true, 'NO_RECEIPT')],
): Doc {
  const withheld = [
    ...(criteria.some((answer) => !answer.satisfied) ? ['CRITERION_UNSATISFIED'] : []),
    ...(criteria.some((answer) => answer.landing !== 'LANDED') ? ['CRITERION_UNLANDED'] : []),
  ];
  return {
    id: PROJECT,
    title: 'Closeout',
    status: 'OPEN',
    startedAt: '2026-10-01T00:00:00.000Z',
    tasksByStatus: { DONE: 4 },
    acceptanceCriteriaItems: criteria.map((answer, index) => ({
      id: answer.definitionId,
      ordinal: index + 1,
      text: `criterion ${index + 1}`,
    })),
    derivedDone: {
      status: 'OPEN',
      done: false,
      withheld,
      confirmation: 'CONFIRMED',
      criteria,
      counts: countsOf(criteria),
    },
    doneBy: null,
    doneAt: null,
    acceptedGaps: [],
    ...over,
  };
}

/** Six criteria, every one of them Not met yet — the antd migration the owner reported on
 *  2026-10-06, which the conversation carried the card under. */
function antdMigration(over: Partial<Doc> = {}): Doc {
  return finished({ tasksByStatus: { DONE: 2, OPEN: 5 }, ...over }, [
    criterion('a1', false, 'NO_RECEIPT'),
    criterion('a2', false, 'NO_RECEIPT'),
    criterion('a3', false, 'CODELESS'),
    criterion('a4', false, 'CODELESS'),
    criterion('a5', false, 'ON_PROJECT_BRANCH'),
    criterion('a6', false, null),
  ]);
}

/** The same facts without the unified read's counts: the older projection, whose rule-sentence card
 *  used to stand in for the grouped one exactly where nothing is drawn now. */
function older(doc: Doc): Doc {
  const { counts: _counts, ...projection } = doc.derivedDone!;
  return { ...doc, derivedDone: projection as Doc['derivedDone'] };
}

function row(over: Partial<ProjectOpenItemRow>): ProjectOpenItemRow {
  return {
    itemId: 'item',
    kind: 'TASK_FAILED',
    title: 'Item',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'OWNER_DECISION' as ProjectOpenItemRow['assigneeReason'],
    waitingSince: new Date(Date.now() - 5 * 60_000).toISOString(),
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

const NO_ITEMS = { needsYou: [], withCoordinator: [], doneRequest: null };
const DONE_REQUEST = {
  needsYou: [],
  withCoordinator: [],
  doneRequest: row({
    itemId: 'done-1',
    kind: 'DONE_REQUEST',
    doneRequest: { criteriaDigest: 'digest-1', judgment: 'The goal is met.', gaps: [] },
  }),
};
const RECORD: ProjectDoneRecord = {
  projectId: PROJECT,
  status: 'DONE',
  doneBy: 'OWNER',
  doneAt: '2026-10-06T09:40:00.000Z',
  criteriaDigest: 'digest-1',
  acceptedGaps: [],
  requestId: 'done-1',
};

describe('the coordinator conversation', () => {
  const server: { document: Doc; openItems: Record<string, unknown>; writes: string[] } = {
    document: finished(),
    openItems: NO_ITEMS,
    writes: [],
  };
  let root: Root | null = null;
  let node: HTMLElement | null = null;
  let qc: QueryClient | null = null;

  beforeEach(() => {
    server.document = finished();
    server.openItems = NO_ITEMS;
    server.writes = [];
  });

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

  async function turn(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
    });
  }

  async function until(done: () => boolean, what: string): Promise<void> {
    for (let n = 0; n < 200 && !done(); n += 1) await turn();
    expect(done(), `waited for ${what}`).toBe(true);
  }

  /** Both reads answered, and then some: a card that is not drawn by now is not going to be. */
  async function read(): Promise<void> {
    await until(
      () => [['project', PROJECT], ['project', PROJECT, 'open-items']].every((key) => {
        const state = qc?.getQueryState(key);
        return state?.fetchStatus === 'idle' && state.status === 'success';
      }),
      'the project and its open items to be read',
    );
    for (let n = 0; n < 10; n += 1) await turn();
  }

  async function mount(waitingKind: SessionWaitingKind | null = null): Promise<HTMLElement> {
    vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method && init.method !== 'GET') {
        server.writes.push(`${init.method} ${path}`);
        if (path.endsWith('/done')) {
          // The request is answered: the open items no longer carry it.
          server.openItems = NO_ITEMS;
          return RECORD;
        }
        return {};
      }
      if (path.endsWith('/open-items')) return server.openItems;
      if (path.includes('/acceptance/confirmation')) {
        return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
      }
      return server.document;
    }) as unknown as typeof api);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
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
    await read();
    return node;
  }

  const text = (): string => node?.textContent ?? '';
  /** Nothing at all: not the old question's card, not the owner's, not the rule-sentence fallback. */
  const nothingDrawn = (): void => {
    expect(node!.querySelector('.project-settlement')).toBeNull();
    expect(node!.querySelector('.project-why-not-done')).toBeNull();
    expect(text()).not.toContain(PROJECT_DONE_COPY.whyHeading);
    expect(text()).not.toContain(PROJECT_DONE_COPY.askCoordinator);
    expect(text()).not.toContain(PROJECT_DONE_COPY.reviewDoneRequest);
  };

  describe('draws no why-not-done card, whatever the project looks like', () => {
    it('draws nothing for a project that looks finished and was never asked about', async () => {
      await mount();
      nothingDrawn();
      // It really is the state the old card was for: every criterion met, nothing running.
      expect(server.document.derivedDone!.criteria.every((answer) => answer.satisfied)).toBe(true);
      expect(server.document.tasksByStatus).toEqual({ DONE: 4 });
    });

    it('draws nothing for a project whose criteria are not met yet — the antd migration', async () => {
      server.document = antdMigration();
      await mount();
      nothingDrawn();
    });

    it('draws nothing for a project with one criterion unmet, or none stated at all', async () => {
      server.document = finished({}, [criterion('c1', true, null), criterion('c2', false, 'CODELESS')]);
      await mount();
      nothingDrawn();

      server.document = finished({
        acceptanceCriteriaItems: [],
        derivedDone: { status: 'OPEN', done: false, withheld: ['NO_CRITERIA_STATED'], confirmation: 'CONFIRMED', criteria: [], counts: countsOf([]) },
      });
      await mount();
      nothingDrawn();
    });

    it('draws nothing while a task is IN_PROGRESS, every criterion met', async () => {
      server.document = finished({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } });
      await mount();
      nothingDrawn();
    });

    it('draws nothing for the older projection either — the read without counts', async () => {
      // The rule-sentence card stood in for the grouped one exactly here; the native clients never
      // drew one for this read at all (`ProjectDone.slot`'s `counts` guard).
      server.document = older(finished());
      await mount();
      nothingDrawn();
    });

    it('draws nothing before the project is recorded, and asks nothing in the card’s place', async () => {
      await mount();
      expect(node!.querySelector('.project-done-card')).toBeNull();
      expect(text()).not.toContain(PROJECT_DONE_COPY.heading);
      expect(text()).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
      expect(text()).not.toContain(PROJECT_DONE_COPY.thisProjectIsDone);
    });

    it('takes nothing up and nothing down as the facts move', async () => {
      await mount();
      nothingDrawn();
      // Running, then stopped, then a criterion unmet, then met and finished again: the pane is
      // empty throughout, so there is no card left standing over a state it no longer describes.
      for (const document of [
        finished({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } }),
        finished(),
        antdMigration(),
        finished(),
        older(finished()),
      ]) {
        server.document = document;
        await act(async () => {
          await qc!.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
        });
        await read();
        nothingDrawn();
      }
    });
  });

  describe('the three drawings that stay', () => {
    it('draws the owner’s card for a DONE_REQUEST, whose press leaves its receipt', async () => {
      server.document = antdMigration({ tasksByStatus: { IN_PROGRESS: 2 } });
      server.openItems = DONE_REQUEST;
      await mount('DONE_REQUEST');
      await until(() => text().includes(PROJECT_DONE_COPY.heading), 'the owner card');
      expect(text()).toContain(PROJECT_DONE_COPY.askedByCoordinator);
      expect(text()).toContain(PROJECT_DONE_COPY.notYet);
      expect(text()).toContain(PROJECT_DONE_COPY.recordAsDoneAnyway);
      expect(node!.querySelector('.project-why-not-done')).toBeNull();

      const press = [...node!.querySelectorAll<HTMLButtonElement>('.project-done-card button')]
        .find((button) => button.textContent?.includes(PROJECT_DONE_COPY.recordAsDoneAnyway));
      await act(async () => {
        press!.click();
      });
      await until(() => text().includes(PROJECT_DONE_COPY.receiptPrefix), 'the local receipt');
      expect(server.writes).toEqual([`POST /projects/${PROJECT}/done`]);
      // The read still says OPEN with criteria unmet: the receipt the press left stays.
      await read();
      expect(text()).toContain(PROJECT_DONE_COPY.receiptPrefix);
      expect(node!.querySelector('.project-why-not-done')).toBeNull();
    });

    it('draws the owner’s card for the row’s Record as done…, with no request behind it', async () => {
      await mount('RECORD_AS_DONE');
      await until(() => text().includes(PROJECT_DONE_COPY.heading), 'the unasked owner card');
      expect(text()).toContain(PROJECT_DONE_COPY.noRequestMeta);
      expect(text()).not.toContain(PROJECT_DONE_COPY.askedByCoordinator);
    });

    it.each([['DERIVED' as const], [null]])('draws This project is done · recorded by Orbit for Orbit’s DONE (doneBy %s)', async (doneBy) => {
      server.document = finished({
        status: 'DONE',
        doneBy,
        doneAt: '2026-10-06T09:00:00.000Z',
        derivedDone: { ...finished().derivedDone!, status: 'DONE', done: true, withheld: [] },
      });
      await mount();
      const card = node!.querySelector('.project-why-not-done.is-settled');
      expect(card).not.toBeNull();
      expect(card?.querySelector('.project-settlement-heading')?.textContent).toBe(PROJECT_DONE_COPY.thisProjectIsDone);
      expect(card?.querySelector('.criteria-provenance')?.textContent).toBe(PROJECT_DONE_COPY.recordedByOrbit);
      expect(text()).not.toContain(PROJECT_DONE_COPY.receiptPrefix);
    });

    it('keeps the owner’s receipt for the owner’s DONE, criteria unmet or not', async () => {
      server.document = antdMigration({
        status: 'DONE',
        doneBy: 'OWNER',
        doneAt: '2026-10-06T09:00:00.000Z',
        acceptedGaps: [{ criterionKey: 'a1', title: 'criterion 1', whyNotProven: 'No receipt.' }],
      });
      await mount();
      expect(text()).toContain(PROJECT_DONE_COPY.receiptPrefix);
      expect(text()).toContain(`${PROJECT_DONE_COPY.recordedByYou} · 1 ${PROJECT_DONE_COPY.gapsAccepted}`);
      expect(node!.querySelector('.project-why-not-done')).toBeNull();
    });
  });
});
