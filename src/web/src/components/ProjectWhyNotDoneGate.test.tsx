// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CriterionLandingReason, ProjectOpenItemRow, SessionWaitingKind } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  ProjectWhyNotDoneCard,
  SessionProjectSettlementCard,
  settlementHeldOnProject,
  type SettlementProjectDocument,
} from './ProjectSettlementCard';
import {
  PROJECT_DONE_COPY,
  WHY_NOT_DONE_NOT_MET,
  projectWhyNotDoneTally,
  type ProjectDoneCriterion,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * What "looks finished" means, and the tally the old card counts in — neither of which a
 * conversation draws any more.
 *
 * `settlementHeldOnProject` is the condition "Why is this project not done?" was asked of: OPEN and
 * started, every stated criterion met by its work, no task IN_PROGRESS, and a projection that does
 * not call it done — the owner's ruling of 2026-10-06 09:29Z, which put back the condition the card
 * had before 0f47238c1. The owner's ruling of 2026-10-07 04:20Z then took the question out of the
 * conversation altogether: NOTHING is drawn in that state, or in any other OPEN one — see
 * `ProjectDoneConversation.test.tsx`, which draws the conversation state by state, and the three
 * drawings that stay: the owner's card while a DONE_REQUEST or this conversation's own receipt
 * stands, Orbit's DONE as the old card's terminal state, the owner's DONE as its receipt.
 *
 * The condition and the tally are kept because the components that state them are (the projection
 * card's own hold, the terminal card's tally), which is what the cases below are about; the tally
 * adds up: each met criterion where its work is, each unmet one as "not met", never by its landing
 * lane. The native clients hold the same rule and words (`ProjectWhyNotDoneGateTests.swift`,
 * `ProjectDoneConversationTests.swift`, `ProjectDoneCopyParityTests.swift`).
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

/** A started OPEN project whose every criterion is met, none of whose tasks is running, and whose
 *  projection still withholds — one merge Orbit never saw. The project the card is for; each case
 *  below changes one fact of it. */
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

/** The antd migration the owner reported on 2026-10-06: started, OPEN, six criteria and every one
 *  of them Not met yet — whose coordinator conversation carried the card all the same, with "Ask
 *  the coordinator to handle it" on it. */
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

/** The same facts without the unified read's counts: the older projection's card. */
function older(doc: Doc): Doc {
  const { counts: _counts, ...projection } = doc.derivedDone!;
  return { ...doc, derivedDone: projection as Doc['derivedDone'] };
}

const held = (doc: Doc | null | undefined): boolean =>
  settlementHeldOnProject(doc as unknown as SettlementProjectDocument | null | undefined);

describe('what “looks finished” means', () => {
  it('holds of a started OPEN project with every criterion met, nothing running, and the read not done', () => {
    expect(held(finished())).toBe(true);
    // Only IN_PROGRESS holds it back: work that is not running is the projection's to explain.
    expect(held(finished({ tasksByStatus: { DONE: 4, OPEN: 1, FAILED: 1 } }))).toBe(true);
    expect(held(finished({ tasksByStatus: {} }))).toBe(true);
  });

  it('holds of nothing with a criterion still unmet — the antd migration the owner reported', () => {
    expect(held(antdMigration())).toBe(false);
    const oneUnmet = finished({}, [criterion('c1', true, null), criterion('c2', false, 'CODELESS')]);
    expect(held(oneUnmet)).toBe(false);
  });

  it('holds of nothing while a task is IN_PROGRESS, every criterion met or not', () => {
    expect(held(finished({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } }))).toBe(false);
  });

  it.each<[string, Doc | null | undefined]>([
    ['a project nobody has started', finished({ startedAt: null })],
    ['a read that does not say whether it started', finished({ startedAt: undefined })],
    ['a project that is not OPEN', finished({ status: 'CANCELLED' })],
    ['a project with no criteria', finished({}, [])],
    ['a project the unified read already calls done', finished({
      derivedDone: { ...finished().derivedDone!, status: 'DONE', done: true, withheld: [] },
    })],
    ['a read that has not answered', null],
  ])('holds of nothing for %s', (_, doc) => {
    expect(held(doc)).toBe(false);
  });

  it('holds the older projection to the same condition, counts or no counts', () => {
    expect(held(older(finished()))).toBe(true);
    expect(held(older(antdMigration()))).toBe(false);
    expect(held(older(finished({ tasksByStatus: { IN_PROGRESS: 2 } })))).toBe(false);
  });
});

/** Where each part of the tally sums to: the head, and the parts after it. */
function addsUp(tally: string): { head: number; parts: number } {
  const [head, ...parts] = tally.split(' · ').map((part) => Number.parseInt(part, 10));
  return { head: head!, parts: parts.reduce((total, n) => total + n, 0) };
}

describe('the tally under the card', () => {
  it('counts unmet criteria as not met, never by their landing lane — the line the owner reported', () => {
    const reported = finished({}, [
      criterion('r1', true, null),
      criterion('r2', true, null),
      criterion('r3', false, 'ON_PROJECT_BRANCH'),
      criterion('r4', false, 'NO_RECEIPT'),
      criterion('r5', false, 'NO_RECEIPT'),
      criterion('r6', false, 'CODELESS'),
      criterion('r7', false, 'CODELESS'),
      criterion('r8', false, 'CODELESS'),
    ]);
    // What it said: "8 criteria · 2 met · 2 on main · 1 on the project branch · 2 merged outside
    // Orbit · 3 no code to land", while six of the eight were Not met yet.
    expect(projectWhyNotDoneTally(reported.derivedDone)).toBe('8 criteria · 2 on main · 6 not met');
    const html = renderToStaticMarkup(<ProjectWhyNotDoneCard project={reported} />);
    expect(html).toContain('8 criteria · 2 on main · 6 not met');
    expect(html).not.toContain('2 merged outside Orbit');
    expect(html).not.toContain('3 no code to land');
  });

  it('keeps the landing reasons of met criteria, and an unmet criterion on main is not met', () => {
    const mixed = finished({}, [
      criterion('m1', true, null),
      criterion('m2', true, 'IN_FLIGHT'),
      criterion('m3', true, 'ON_PROJECT_BRANCH'),
      criterion('m4', true, 'NO_RECEIPT'),
      criterion('m5', true, 'NOTHING_TO_LAND'),
      criterion('m6', true, 'CODELESS'),
      criterion('m7', false, null),
    ]);
    expect(projectWhyNotDoneTally(mixed.derivedDone)).toBe(
      '7 criteria · 1 on main · 1 in flight · 1 on the project branch · 1 merged outside Orbit'
      + ' · 1 nothing to land · 1 no code to land · 1 not met',
    );
    // The card this gate draws has every criterion met, so nothing on it reads "not met".
    expect(projectWhyNotDoneTally(finished().derivedDone)).toBe('2 criteria · 1 on main · 1 merged outside Orbit');
    expect(projectWhyNotDoneTally(undefined)).toBe('');
  });

  it('adds up to the criteria, whatever they are', () => {
    const fixtures = [
      finished(),
      antdMigration(),
      finished({}, [criterion('x1', false, 'IN_FLIGHT'), criterion('x2', true, 'IN_FLIGHT'), criterion('x3', true, null)]),
      finished({}, [criterion('y1', true, 'NOTHING_TO_LAND'), criterion('y2', true, 'CODELESS')]),
    ];
    for (const doc of fixtures) {
      const tally = projectWhyNotDoneTally(doc.derivedDone);
      const total = doc.derivedDone!.criteria.length;
      expect(addsUp(tally), tally).toEqual({ head: total, parts: total });
      const unmet = doc.derivedDone!.criteria.filter((answer) => !answer.satisfied).length;
      expect(tally.includes(`${unmet} ${WHY_NOT_DONE_NOT_MET}`), tally).toBe(unmet > 0);
    }
  });

  it('says not met in the words the native clients copy', () => {
    expect(WHY_NOT_DONE_NOT_MET).toBe('not met');
    expect(PROJECT_DONE_COPY.notMet).toBe(WHY_NOT_DONE_NOT_MET);
  });
});

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
const RECORD = {
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
  const whyCard = (): Element | null => node?.querySelector('.project-why-not-done') ?? null;

  it('draws nothing for a project with a criterion still unmet — no card, no Ask the coordinator', async () => {
    server.document = antdMigration();
    await mount();
    expect(text()).not.toContain(PROJECT_DONE_COPY.whyHeading);
    expect(text()).not.toContain(PROJECT_DONE_COPY.askCoordinator);
    expect(node!.querySelector('.project-settlement')).toBeNull();
  });

  it('draws nothing while a task is IN_PROGRESS, every criterion met', async () => {
    server.document = finished({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } });
    await mount();
    expect(text()).not.toContain(PROJECT_DONE_COPY.whyHeading);
    expect(node!.querySelector('.project-settlement')).toBeNull();
  });

  it('draws nothing for a project that looks finished while the read is not done — the state it was asked in', async () => {
    // Where the card used to be up, with its tally and its two groups (2026-10-06 → 2026-10-07).
    expect(held(server.document)).toBe(true);
    await mount();
    expect(whyCard()).toBeNull();
    expect(node!.querySelector('.project-settlement')).toBeNull();
    expect(text()).not.toContain(PROJECT_DONE_COPY.whyHeading);
    expect(text()).not.toContain(PROJECT_DONE_COPY.needsYourCall);
    expect(text()).not.toContain(PROJECT_DONE_COPY.askCoordinator);
    // Not the owner's card in its place either: nobody asked, and nothing was recorded.
    expect(text()).not.toContain(PROJECT_DONE_COPY.heading);
  });

  it('draws nothing as a task starts or a criterion stops being met, and nothing when they stop again', async () => {
    await mount();
    expect(whyCard()).toBeNull();

    for (const document of [
      finished({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } }),
      finished(),
      finished({}, [criterion('c1', true, null), criterion('c2', false, 'NO_RECEIPT')]),
      finished(),
    ]) {
      server.document = document;
      await act(async () => {
        await qc!.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
      });
      await read();
      expect(whyCard(), 'the old question was drawn again').toBeNull();
      expect(node!.querySelector('.project-settlement')).toBeNull();
      expect(text()).not.toContain(PROJECT_DONE_COPY.heading);
    }
  });

  describe('the three drawings that stay', () => {
    it('draws the closeout card for a DONE_REQUEST, even on a project with every criterion unmet', async () => {
      server.document = antdMigration({ tasksByStatus: { IN_PROGRESS: 2 } });
      server.openItems = DONE_REQUEST;
      await mount('DONE_REQUEST');
      await until(() => text().includes(PROJECT_DONE_COPY.heading), 'the closeout card');
      expect(text()).toContain(PROJECT_DONE_COPY.askedByCoordinator);
      expect(text()).toContain(PROJECT_DONE_COPY.notYet);
      expect(whyCard()).toBeNull();
    });

    it('keeps this conversation’s own receipt once the owner records it done', async () => {
      server.document = antdMigration();
      server.openItems = DONE_REQUEST;
      await mount('DONE_REQUEST');
      await until(() => text().includes(PROJECT_DONE_COPY.recordAsDoneAnyway), 'the record press');
      const press = [...node!.querySelectorAll<HTMLButtonElement>('.project-done-card button')]
        .find((button) => button.textContent?.includes(PROJECT_DONE_COPY.recordAsDoneAnyway));
      await act(async () => {
        press!.click();
      });
      await until(() => text().includes(PROJECT_DONE_COPY.receiptPrefix), 'the local receipt');
      expect(server.writes).toEqual([`POST /projects/${PROJECT}/done`]);
      // The request is answered and the read still says OPEN with criteria unmet: the receipt the
      // press left stays, and nothing asks why the project is not done.
      await read();
      expect(text()).toContain(PROJECT_DONE_COPY.receiptPrefix);
      expect(whyCard()).toBeNull();
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
      expect(whyCard()).toBeNull();
    });
  });
});
