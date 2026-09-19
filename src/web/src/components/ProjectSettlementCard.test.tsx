// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  ProjectSettlementCard,
  SETTLEMENT_CHAT_HINT,
  SETTLEMENT_CONFIRM_ACTION,
  SETTLEMENT_CONFIRMED,
  SETTLEMENT_CONFIRMED_NOTE,
  SETTLEMENT_EXPLAINS,
  SETTLEMENT_HEADING,
  SETTLEMENT_NOT_RECORDED,
  SETTLEMENT_PREVIEW,
  SETTLEMENT_SHOW_LESS,
  SETTLEMENT_STALE,
  SessionProjectSettlementCard,
  projectSettlementContext,
  settlementCriterionFacts,
  settlementHeldOnProject,
  settlementMeta,
  settlementReadLabel,
  settlementTally,
  type SettlementCriterion,
  type SettlementProjectDocument,
} from './ProjectSettlementCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';

/**
 * The project settlement card: the closing question, in the coordinator conversation, at the moment
 * the work filed under a project has met every criterion it states.
 *
 * What is asserted is the condition and the two things the card may never do with it. The condition
 * is deliberately strict — an OPEN project, criteria stated, EVERY one of them met, and no task
 * IN_PROGRESS — because the failure mode is a card that sits under every project forever asking
 * "is this done?", so every "no card" here is asserted on a fixture that then draws one once the
 * single fact under test changes. And a criterion with no merge receipt never disables the primary
 * action: the count is something the reader is told, not something that takes the decision off
 * them.
 *
 * The press is asserted at the wire, not at a callback: `PATCH /projects/:id` with
 * `{status: 'DONE'}` and nothing naming a session, which is the one shape the status door accepts
 * from a conversation (`PROJECT_STATUS_NOT_SESSION_WRITABLE` for every other).
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34LWcmLItBx6ytdO26XXF';
const TITLE = 'move the confirmation to the start';
const PATH = `/projects/${PROJECT}`;

/** Criteria in stated order, each met (`true`), unmet (`false`) or not answered for (`undefined`). */
function criteriaOf(...met: Array<boolean | undefined>): SettlementCriterion[] {
  return met.map((satisfied, index) => ({
    id: `c${index + 1}`,
    ordinal: index + 1,
    text: `condition ${index + 1} holds`,
    landing: 'LANDED',
    ...(satisfied === undefined ? {} : { satisfied }),
  }));
}

/** A project whose every criterion is met and nothing is running: the card's own condition. */
function projectOf(over: Partial<SettlementProjectDocument> = {}): SettlementProjectDocument {
  return {
    title: TITLE,
    status: 'OPEN',
    acceptanceCriteriaItems: criteriaOf(true, true, true),
    tasksByStatus: {},
    ...over,
  };
}

describe('the copy', () => {
  /** The card's sentences are a spec rather than a draft, so they are pinned as literals: a test
   *  that asserted each constant against itself would go green on any rewording at all. */
  it('asks the question, and names its two actions, in exactly these words', () => {
    expect(SETTLEMENT_HEADING).toBe('Is this project done?');
    expect(SETTLEMENT_CONFIRM_ACTION).toBe('Confirm the project is done');
    expect(OWNER_SEND_BACK_ACTION).toBe('Chat about this');
    expect(SETTLEMENT_CHAT_HINT).toBe(
      '“Chat about this” hands the card’s own facts to the composer below, so you can say what is '
      + 'still missing instead of confirming.',
    );
    expect(SETTLEMENT_EXPLAINS).toBe(
      'Nothing decides this for you. Confirming it is a claim you are making about the goal, not a '
      + 'conclusion Orbit reached — so here is everything Orbit can put beside it. Confirming the '
      + 'project done neither closes nor stops the work still filed under it.',
    );
    expect(SETTLEMENT_STALE).toBe(
      'This project was recorded as done at another end. Nothing here was pressed.',
    );
    expect(SETTLEMENT_CONFIRMED).toBe('Confirmed done · by you, from this conversation.');
    expect(SETTLEMENT_CONFIRMED_NOTE).toBe(
      'The project is recorded DONE; the work filed under it is untouched.',
    );
    expect(SETTLEMENT_SHOW_LESS).toBe('Show less');
    expect(settlementReadLabel(5)).toBe('Show all 5 criteria');
  });

  /** The card and the reply it arms may only state what the project document carries, and this
   *  document carries no running count but the status tally. Both said "nothing is running under
   *  it" until 2026-09-19, off a `buckets.running` that `GET /projects/:id` never serves — so the
   *  claim was unbackable in every render, and false over live work. */
  it('claims nothing about what is running, which this read cannot see', () => {
    const project = projectOf({ tasksByStatus: { IN_PROGRESS: 2, OPEN: 1 } });
    expect(settlementMeta(project)).not.toMatch(/running/i);
    expect(projectSettlementContext(project)).not.toMatch(/running/i);
  });

  it('says what the project is and what was counted, as one sentence each', () => {
    expect(settlementMeta(projectOf())).toBe(
      `${TITLE} · every stated criterion has been met by the work filed under it`,
    );
    expect(settlementTally(projectOf())).toBe(
      '3 stated criteria · 3 settled by the work filed under them · 0 with no merge receipt',
    );
  });
});

describe('whether a project is held on the settlement question', () => {
  it('holds an OPEN project whose every stated criterion is met with nothing running', () => {
    expect(settlementHeldOnProject(projectOf())).toBe(true);
  });

  it.each<[string, SettlementProjectDocument]>([
    ['a criterion nobody has answered for', projectOf({ acceptanceCriteriaItems: criteriaOf(true, undefined, true) })],
    ['a criterion the derivation says does not hold', projectOf({ acceptanceCriteriaItems: criteriaOf(true, false, true) })],
    ['a task IN_PROGRESS under it', projectOf({ tasksByStatus: { IN_PROGRESS: 1 } })],
    ['the project recorded done', projectOf({ status: 'DONE' })],
    ['the project recorded cancelled', projectOf({ status: 'CANCELLED' })],
    ['a read that does not say where it stands', projectOf({ status: undefined })],
    ['no criteria stated', projectOf({ acceptanceCriteriaItems: [] })],
    ['no criteria in the read at all', projectOf({ acceptanceCriteriaItems: undefined })],
  ])('holds nothing while the project has %s', (_, project) => {
    expect(settlementHeldOnProject(project)).toBe(false);
  });

  it('holds nothing for a project that could not be read', () => {
    expect(settlementHeldOnProject(null)).toBe(false);
    expect(settlementHeldOnProject(undefined)).toBe(false);
  });
});

/** The facts column and the tally, which are the two things a reader is deciding on. */
describe('what the card says about each criterion', () => {
  it.each<[SettlementCriterion['landing'], boolean | undefined, string]>([
    ['LANDED', true, 'Settled · Landed'],
    ['UNKNOWN', true, 'Settled · No receipt'],
    ['UNKNOWN', false, 'Not settled · No receipt'],
    ['LANDED', undefined, 'No settlement answer · Landed'],
  ])('says a %s criterion met=%s as "%s"', (landing, satisfied, expected) => {
    const [criterion] = criteriaOf(satisfied);
    expect(settlementCriterionFacts({ ...criterion!, landing })).toBe(expected);
  });

  it('counts the set, and what is still open under it only when there is something to count', () => {
    // All three met, one of them with no receipt: the tally says both numbers.
    const one = projectOf({
      acceptanceCriteriaItems: [
        { ...criteriaOf(true, true, true)[0]!, landing: 'UNKNOWN' },
        ...criteriaOf(true, true, true).slice(1),
      ],
      tasksByStatus: { DONE: 4, CANCELLED: 1 },
    });
    expect(settlementTally(one)).toBe(
      '3 stated criteria · 3 settled by the work filed under them · 1 with no merge receipt',
    );

    // Unfinished work rides along, and FAILED is counted in both halves of that sentence: it is a
    // run's own report that it stopped short, so the work under it is still outstanding.
    expect(settlementTally({ ...one, tasksByStatus: { DONE: 4, FAILED: 2, IN_PROGRESS: 1 } })).toBe(
      '3 stated criteria · 3 settled by the work filed under them · 1 with no merge receipt'
      + ' · 3 task still unsettled, 2 ended FAILED',
    );

    // Nothing outstanding under it, and no tally at all: both are ways of having nothing to say,
    // and neither may come out as "0 task still unsettled, 0 ended FAILED".
    expect(settlementTally(one)).not.toContain('still unsettled');
    expect(settlementTally({ ...one, tasksByStatus: undefined })).not.toContain('still unsettled');
  });
});

describe('what the card draws', () => {
  const card = (
    project: SettlementProjectDocument,
    over: Partial<ComponentProps<typeof ProjectSettlementCard>> = {},
  ): string =>
    renderToStaticMarkup(
      <ProjectSettlementCard
        project={project}
        onConfirm={() => {}}
        onChatAbout={() => {}}
        {...over}
      />,
    );

  it('heads the question, says what it is about, and carries the facts column', () => {
    const markup = card(projectOf({
      acceptanceCriteriaItems: [
        { ...criteriaOf(true, true, true)[0]!, landing: 'UNKNOWN' },
        ...criteriaOf(true, true, true).slice(1),
      ],
    }));
    expect(markup).toContain(SETTLEMENT_HEADING);
    expect(markup).toContain(PROVENANCE_LABEL);
    expect(markup).toContain(
      `${TITLE} · every stated criterion has been met by the work filed under it`,
    );
    expect(markup).toContain('Settled · Landed');
    expect(markup).toContain('Settled · No receipt');
    expect(markup).toContain(SETTLEMENT_EXPLAINS);
  });

  it('offers the claim in exactly these words, with the hint under the row they sit in', () => {
    expect(SETTLEMENT_CONFIRM_ACTION).toBe('Confirm the project is done');
    const markup = card(projectOf());
    expect(markup).toContain(`>${SETTLEMENT_CONFIRM_ACTION}</button>`);
    expect(markup).toContain(`>${OWNER_SEND_BACK_ACTION}</button>`);
    expect(markup).toContain(SETTLEMENT_CHAT_HINT);
  });

  /** Three rows and the rest behind one press: what the reader is checking is the fact column
   *  beside each line, so three of them make the point and the fourth is not a fifth row. */
  it('folds everything past the third criterion, and says how many there are', () => {
    const criteria = criteriaOf(true, true, true, true, true);
    const markup = card(projectOf({ acceptanceCriteriaItems: criteria }));
    const rows = markup.match(/class="project-settlement-text"/g) ?? [];
    expect(rows).toHaveLength(SETTLEMENT_PREVIEW);
    expect(settlementReadLabel(criteria.length)).toBe('Show all 5 criteria');
    expect(markup).toContain('Show all 5 criteria');
    // A set that fits has nothing to toggle, and no control appears offering to show it.
    expect(card(projectOf())).not.toContain('Show all 3 criteria');
  });

  /** Nothing decides this for the reader, and the press is a claim rather than a conclusion: a
   *  criterion with no receipt does not disable the action, however many of them there are. */
  it('leaves the claim pressable while every criterion is short of a merge receipt', () => {
    const markup = card(projectOf({
      acceptanceCriteriaItems: criteriaOf(true, true, true)
        .map((c) => ({ ...c, landing: 'UNKNOWN' as const })),
      tasksByStatus: { OPEN: 2, FAILED: 1 },
    }));
    const actions = markup.match(/<button[^>]*class="card-action[^"]*"[^>]*>/g) ?? [];
    expect(actions).toHaveLength(2);
    for (const tag of actions) expect(tag).not.toContain('disabled');
    expect(markup).toContain('3 with no merge receipt');
    expect(markup).toContain('3 task still unsettled, 1 ended FAILED');
  });

  it('records done at another end: both actions dead, the card and its facts still there', () => {
    const markup = card(projectOf({ status: 'DONE' }));
    expect(markup).toContain(SETTLEMENT_STALE);
    expect(markup).toContain('Settled · Landed');
    const actions = markup.match(/<button[^>]*class="card-action[^"]*"[^>]*>/g) ?? [];
    expect(actions).toHaveLength(2);
    for (const tag of actions) expect(tag).toContain('disabled');
  });

  it('leaves the receipt where a press made here was answered, and no actions under it', () => {
    const markup = card(projectOf(), { confirmed: true });
    expect(markup).toContain(SETTLEMENT_CONFIRMED);
    expect(markup).toContain(SETTLEMENT_CONFIRMED_NOTE);
    expect(markup).not.toContain('card-action');
    expect(markup).not.toContain(SETTLEMENT_STALE);
  });

  it('shows the door’s refusal rather than swallowing it', () => {
    const markup = card(projectOf(), { error: new Error('PROJECT_STATUS_NOT_SESSION_WRITABLE') });
    expect(markup).toContain(SETTLEMENT_NOT_RECORDED);
    expect(markup).toContain('PROJECT_STATUS_NOT_SESSION_WRITABLE');
  });

  it('carries the criteria and their facts into what the composer would send', () => {
    const context = projectSettlementContext(projectOf({
      acceptanceCriteriaItems: [
        { ...criteriaOf(true, true, true)[0]!, landing: 'UNKNOWN' },
        ...criteriaOf(true, true, true).slice(1),
      ],
    }));
    expect(context).toContain(TITLE);
    expect(context).toContain('1. condition 1 holds — Settled · No receipt');
    expect(context).toContain('2. condition 2 holds — Settled · Landed');
    expect(context).toContain('3 stated criteria · 3 settled by the work filed under them · 1 with no merge receipt');
  });
});

/** The card as the conversation meets it: wired to the project read and to the status door. */
describe('the wired card', () => {
  type Recorded = {
    method: string;
    path: string;
    body: unknown;
    /** The whole init, so an assertion can say what did NOT ride with the request. */
    init: unknown;
  };

  const recorded: Recorded[] = [];
  const writes = (): Recorded[] => recorded.filter((request) => request.method !== 'GET');

  const server: { document: SettlementProjectDocument | Error } = { document: projectOf() };
  const armed: Array<{ projectId: string; projectTitle: string; facts: string }> = [];

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let client: QueryClient | null = null;

  beforeEach(() => {
    server.document = projectOf();
    recorded.length = 0;
    armed.length = 0;
    vi.mocked(api).mockImplementation((async (
      path: string,
      init?: { method?: string; body?: unknown },
    ) => {
      recorded.push({ method: init?.method ?? 'GET', path, body: init?.body, init: init ?? {} });
      if (init?.method === 'PATCH') return { id: PROJECT };
      if (server.document instanceof Error) throw server.document;
      return server.document;
    }) as unknown as typeof api);
  });

  afterEach(async () => {
    const mounted = root;
    root = null;
    if (mounted) await act(async () => mounted.unmount());
    container?.remove();
    container = null;
    await client?.cancelQueries();
    client?.clear();
    client = null;
    vi.mocked(api).mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  /** React Query hands the card every change on its notify scheduler — a later task — and `act`
   *  drains only microtasks, so every turn waits for a hand-off of its own. */
  async function turn(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
    });
  }

  async function until(done: () => boolean, what: string): Promise<void> {
    for (let n = 0; n < 200 && !done(); n += 1) await turn();
    expect(done(), `waited for ${what}`).toBe(true);
  }

  async function mount(...conversations: Array<string | null>): Promise<{ node: HTMLElement; qc: QueryClient }> {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
    client = qc;
    const node = document.createElement('div');
    document.body.appendChild(node);
    container = node;
    const tree = createRoot(node);
    root = tree;
    await act(async () => {
      tree.render(
        <QueryClientProvider client={qc}>
          {conversations.map((projectId, index) => (
            <section key={index}>
              <SessionProjectSettlementCard
                projectId={projectId}
                onChatAbout={(talk) => armed.push(talk)}
              />
            </section>
          ))}
        </QueryClientProvider>,
      );
    });
    return { node, qc };
  }

  /** The read has answered — or failed — and that answer has been handed to the card. */
  async function readLanded(qc: QueryClient): Promise<void> {
    await until(() => {
      const state = qc.getQueryState(['project', PROJECT]);
      return state !== undefined && state.status !== 'pending' && state.fetchStatus === 'idle';
    }, 'the read to answer');
    for (let n = 0; n < 5; n += 1) await turn();
  }

  /** The read comes round again, as the card's poll brings it. */
  async function reread(qc: QueryClient): Promise<void> {
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
    });
    await readLanded(qc);
  }

  const cardsIn = (node: ParentNode): HTMLElement[] => [
    ...node.querySelectorAll<HTMLElement>('.project-settlement'),
  ];
  const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
    ...card.querySelectorAll<HTMLButtonElement>('.project-settlement-actions button'),
  ];
  const action = (card: HTMLElement, label: string): HTMLButtonElement => {
    const found = actionsOf(card).find((button) => button.textContent === label);
    if (!found) {
      throw new Error(
        `no "${label}" on the card; it offers ${actionsOf(card).map((b) => `"${b.textContent}"`).join(', ')}`,
      );
    }
    return found;
  };
  const factsOn = (card: HTMLElement): string[] => [
    ...card.querySelectorAll('.project-settlement-facts'),
  ].map((row) => row.textContent ?? '');

  async function delivered(): Promise<{ node: HTMLElement; qc: QueryClient; card: () => HTMLElement }> {
    const { node, qc } = await mount(PROJECT);
    await until(() => cardsIn(node).length > 0, 'the card to be delivered');
    const card = (): HTMLElement => {
      const [only] = cardsIn(node);
      if (!only) throw new Error('the card is not on the page');
      return only;
    };
    expect(action(card(), SETTLEMENT_CONFIRM_ACTION).disabled, 'the delivered card cannot be answered').toBe(false);
    return { node, qc, card };
  }

  it.each<[string, SettlementProjectDocument]>([
    ['a criterion nobody has answered for', projectOf({ acceptanceCriteriaItems: criteriaOf(true, undefined, true) })],
    ['a task still IN_PROGRESS under it', projectOf({ tasksByStatus: { IN_PROGRESS: 2 } })],
    ['the project already recorded done', projectOf({ status: 'DONE' })],
    ['no criteria stated at all', projectOf({ acceptanceCriteriaItems: [] })],
    ['a read carrying no criteria', projectOf({ acceptanceCriteriaItems: undefined })],
  ])('draws nothing while the project has %s, and one once it does not', async (_, document) => {
    server.document = document;
    const { node, qc } = await mount(PROJECT);
    await readLanded(qc);
    expect(cardsIn(node), 'a project that is not settled was asked whether it is done').toHaveLength(0);

    // The same conversation and the same read, with the one fact under test changed: so the empty
    // pane above was that fact and not a card that was never going to draw.
    server.document = projectOf();
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it('draws none in a conversation that coordinates no project, beside one that does on the same read', async () => {
    const { node } = await mount(null, PROJECT);
    const [ordinary, coordinator] = [...node.querySelectorAll('section')];
    await until(() => cardsIn(coordinator!).length === 1, 'the coordinator conversation to draw its card');
    expect(cardsIn(ordinary!), 'a conversation with no project was drawn the card').toHaveLength(0);
    expect(recorded.filter((request) => request.path.includes('/projects//')), 'a read for no project')
      .toEqual([]);
  });

  it('stays where it was put when the project is recorded done at another end', async () => {
    const { card, qc } = await delivered();
    expect(card().querySelector('.project-settlement-stale')).toBeNull();

    server.document = projectOf({ status: 'DONE' });
    await reread(qc);
    expect(card().querySelector('.project-settlement-stale')?.textContent).toBe(SETTLEMENT_STALE);
    expect(factsOn(card()), 'the facts it was read for went with the stale line').toEqual([
      'Settled · Landed',
      'Settled · Landed',
      'Settled · Landed',
    ]);
  });

  it('writes the claim at the status door: PATCH /projects/:id, {status:DONE}, nothing naming a session', async () => {
    const { card } = await delivered();
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(() => writes().length > 0, 'the press to reach the door');

    const [press] = writes();
    expect(press!.method).toBe('PATCH');
    expect(press!.path).toBe(PATH);
    expect(press!.body).toEqual({ status: 'DONE' });
    // Nothing about a session goes with it: the door refuses this write from a session
    // (`PROJECT_STATUS_NOT_SESSION_WRITABLE`) and lets through the browser's credential alone.
    expect(JSON.stringify(press)).not.toMatch(/session/i);
  });

  it('leaves the receipt where the actions were, and draws no action under it', async () => {
    const { card } = await delivered();
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(
      () => card().querySelector('.project-settlement-recorded') !== null,
      'the receipt to appear',
    );
    expect(card().querySelector('.project-settlement-recorded')?.textContent)
      .toContain(SETTLEMENT_CONFIRMED);
    expect(card().querySelector('.project-settlement-recorded')?.textContent)
      .toContain(SETTLEMENT_CONFIRMED_NOTE);
    expect(actionsOf(card()), 'an action outlived the answer it made').toEqual([]);
    // The card is still the card: the receipt replaced the actions, not the facts.
    expect(factsOn(card())).toHaveLength(3);
  });

  /** The card reads the project page's own entry rather than a key of its own — one cache, so the
   *  status tag, the list and this card move together — and a press refreshes the two keys the
   *  project page's own press refreshes. */
  it('reads and refreshes the project page’s own two keys', async () => {
    const { card, qc } = await delivered();
    expect(qc.getQueryData(['project', PROJECT]), 'the card reads a key of its own').toEqual(projectOf());

    const invalidated: unknown[] = [];
    const spy = vi.spyOn(qc, 'invalidateQueries').mockImplementation((async (filters) => {
      invalidated.push(filters?.queryKey);
    }) as typeof qc.invalidateQueries);
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(() => invalidated.length >= 2, 'both keys to be invalidated');
    expect(invalidated).toEqual([['project', PROJECT], ['projects']]);
    spy.mockRestore();
  });

  it('shows a refusal on the card rather than eating it', async () => {
    const { card } = await delivered();
    vi.mocked(api).mockImplementation((async () => {
      throw new Error('PROJECT_STATUS_NOT_SESSION_WRITABLE: a session cannot write this');
    }) as unknown as typeof api);
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(
      () => card().querySelector('.project-settlement-error') !== null,
      'the refusal to be shown',
    );
    const shown = card().querySelector('.project-settlement-error')?.textContent ?? '';
    expect(shown).toContain(SETTLEMENT_NOT_RECORDED);
    expect(shown).toContain('PROJECT_STATUS_NOT_SESSION_WRITABLE');
    expect(action(card(), SETTLEMENT_CONFIRM_ACTION).disabled, 'the way back was taken away').toBe(false);
  });

  it('hands the card’s own facts to the composer, and leaves the card answerable', async () => {
    const { card } = await delivered();
    await act(async () => {
      action(card(), OWNER_SEND_BACK_ACTION).click();
    });
    const [talk] = armed;
    expect(talk?.projectId).toBe(PROJECT);
    expect(talk?.projectTitle).toBe(TITLE);
    expect(talk?.facts).toContain('1. condition 1 holds — Settled · Landed');
    expect(talk?.facts).toContain('3 stated criteria · 3 settled by the work filed under them · 0 with no merge receipt');
    expect(writes(), 'talking about it wrote something').toEqual([]);
    expect(action(card(), SETTLEMENT_CONFIRM_ACTION).disabled).toBe(false);
  });

  /** The folding is a reading control on the card and writes nothing. */
  it('unfolds the rest of the criteria on one press, and folds them back', async () => {
    server.document = projectOf({ acceptanceCriteriaItems: criteriaOf(true, true, true, true, true) });
    const { card } = await delivered();
    expect(factsOn(card())).toHaveLength(SETTLEMENT_PREVIEW);

    const toggle = (): HTMLButtonElement => {
      const found = card().querySelector<HTMLButtonElement>('.project-settlement-read');
      if (!found) throw new Error('the card offers no way to read the rest');
      return found;
    };
    expect(toggle().textContent).toBe('Show all 5 criteria');
    await act(async () => {
      toggle().click();
    });
    expect(factsOn(card())).toHaveLength(5);
    expect(toggle().textContent).toBe(SETTLEMENT_SHOW_LESS);
    await act(async () => {
      toggle().click();
    });
    expect(factsOn(card())).toHaveLength(SETTLEMENT_PREVIEW);
  });
});
