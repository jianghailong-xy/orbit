// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import {
  ACCEPTANCE_CHANGED_SINCE_CONFIRMED,
  ACCEPTANCE_CONFIRM_LABEL,
  ACCEPTANCE_CONFIRMED,
  ACCEPTANCE_NOBODY_SAID_DONE,
  ACCEPTANCE_NOT_STARTED,
  ACCEPTANCE_RECEIPT_HEADING,
  ACCEPTANCE_SHOW_LESS_LABEL,
  ACCEPTANCE_START_LABEL,
  ACCEPTANCE_START_NOT_READ,
  ACCEPTANCE_STARTED,
  CONFIRMATION_NOT_RECORDED,
  CONFIRMATION_UNREAD_EXPLANATION,
  SessionAcceptanceConfirmationCard,
  acceptanceConfirmationStaleExplanation,
  acceptanceConfirmedLine,
  acceptanceReadLabel,
  type ConfirmationCriterion,
} from './AcceptanceConfirmationCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { shortSeal } from './CriteriaDecisionCard';

/**
 * The settlement confirmation card, wired to its two reads and its door, in the states a coordinator
 * conversation meets it in.
 *
 * What is asserted is what the native console does (`ConsoleModel.settlementHeldOnConfirmation`,
 * OrbitKit `AcceptanceConfirmations`): a card exactly when an OPEN project states criteria, holds at
 * least one task and has nobody's confirmation on that set — whether or not any criterion is met by
 * its work, which is the move this card was rewritten for — and none otherwise; a delivered card
 * stays, and goes stale in place; a press sends the version standing now, and a refusal re-reads
 * before the button comes back. Every "none" is asserted on a fixture that goes on to draw the card
 * once the one fact under test changes, so an empty pane is never a card that was not going to draw
 * anyway.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34LWcmLItBx6ytdO26XXF';
const CURRENT = `4fc57753a6ec${'0'.repeat(52)}`;
const PRIOR = `6b1d02e4c8a1${'1'.repeat(52)}`;
const MOVED = `9c4f7a1bb001${'2'.repeat(52)}`;
const STANDING_PATH = `/projects/${PROJECT}/acceptance/confirmation`;

type State = StandardSetConfirmationStanding['state'];

/** The standing of a three-criterion set. A confirmation on record names `PRIOR` when it is stale. */
function standingOf(state: State, digest = CURRENT): StandardSetConfirmationStanding {
  const material = [1, 2, 3].map((n) => ({ definitionId: `c${n}`, revision: 1, contentHash: `h${n}` }));
  return {
    state,
    confirmed: state === 'CONFIRMED',
    currentVersion: { digest, material },
    confirmation:
      state === 'UNCONFIRMED'
        ? null
        : {
            criteriaDigest: state === 'CONFIRMED' ? digest : PRIOR,
            criteriaMaterial: material,
            confirmedAt: '2026-09-11T03:00:00.000Z',
            confirmedById: 'owner',
          },
  };
}

/** Criteria in stated order, each met (`true`), unmet (`false`) or not answered for (`undefined`). */
function criteriaOf(...met: Array<boolean | undefined>): ConfirmationCriterion[] {
  return met.map((satisfied, index) => ({
    id: `c${index + 1}`,
    ordinal: index + 1,
    text: `condition ${index + 1} holds`,
    ...(satisfied === undefined ? {} : { satisfied }),
  }));
}

/** The plan as this card now meets it: written, and not one line of it done yet. */
const NONE_MET = criteriaOf(false, false, false);

const TITLE = 'move the confirmation to the start';

/** The project document, as much of it as the card reads. `coordinatorEnabled` is left out by
 *  default because that is how a new project reads: off. The task count is not left out: a project
 *  whose plan is written holds work, and the empty count is the shape the card was taught to wait
 *  through — so it is a case of its own below rather than what every fixture here happens to be. */
function documentOf(criteria: ConfirmationCriterion[] | undefined, status = 'OPEN'): ProjectDocument {
  return {
    title: TITLE,
    status,
    coordinatorEnabled: false,
    _count: { tasks: 1 },
    acceptanceCriteriaItems: criteria,
  };
}

type ProjectDocument = {
  title?: string;
  status?: string;
  coordinatorEnabled?: boolean;
  /** How many tasks the project holds — `_count.tasks`, as `/projects/:id` serves it. */
  _count?: { tasks?: number };
  acceptanceCriteriaItems?: ConfirmationCriterion[];
};

/** A body, an Error for the read failing, or a function for a read that answers when told to. */
type Answer<T> = T | Error | (() => Promise<T>);

const server: {
  standing: Answer<StandardSetConfirmationStanding>;
  document: Answer<ProjectDocument>;
  door: (criteriaDigest: string) => Promise<StandardSetConfirmationStanding>;
} = {
  standing: standingOf('UNCONFIRMED'),
  document: documentOf(NONE_MET),
  door: async () => standingOf('CONFIRMED'),
};

/** Every request the cards made, in order: `GET <path>`, or `POST <path> <digest sent>`. */
const requests: string[] = [];
const presses = (): string[] => requests.filter((request) => request.startsWith('POST'));
const standingReads = (): number => requests.filter((request) => request === `GET ${STANDING_PATH}`).length;

function answer<T>(value: Answer<T>): Promise<T> {
  if (value instanceof Error) return Promise.reject(value);
  if (typeof value === 'function') return (value as () => Promise<T>)();
  return Promise.resolve(value);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  server.standing = standingOf('UNCONFIRMED');
  server.document = documentOf(NONE_MET);
  server.door = async () => standingOf('CONFIRMED');
  requests.length = 0;
  armed.length = 0;
  vi.mocked(api).mockImplementation((async (
    path: string,
    init?: { method?: string; body?: { criteriaDigest?: string } },
  ) => {
    if (init?.method === 'POST' && path.endsWith('/acceptance/confirmation')) {
      const digest = init.body?.criteriaDigest ?? '';
      requests.push(`POST ${path} ${digest}`);
      return server.door(digest);
    }
    requests.push(`GET ${path}`);
    if (path.endsWith('/acceptance/confirmation')) return answer(server.standing);
    if (path.startsWith('/projects/')) return answer(server.document);
    throw new Error(`nothing is stubbed at ${path}`);
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

/** Every plan the card handed to the composer, in order: what the page would arm the bar with. */
const armed: Array<{ projectId: string; criteriaDigest: string; projectTitle: string; criteria: string[] }> = [];

/** A pane per conversation, each holding the card for the project it coordinates — `null` for a
 *  conversation that coordinates none. */
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
            <SessionAcceptanceConfirmationCard
              projectId={projectId}
              onChatAbout={(plan) => armed.push(plan)}
            />
          </section>
        ))}
      </QueryClientProvider>,
    );
  });
  return { node, qc };
}

const cardsIn = (node: ParentNode): HTMLElement[] => [
  ...node.querySelectorAll<HTMLElement>('.settlement-card'),
];
/** The record a confirmation leaves. A class of its own rather than a card: nothing on it is
 *  pressable, so nothing that asks a question may be counted as one of these. */
const receiptsIn = (node: ParentNode): HTMLElement[] => [
  ...node.querySelectorAll<HTMLElement>('.settlement-receipt'),
];
const receiptLineOf = (receipt: HTMLElement): string =>
  receipt.querySelector('.settlement-receipt-line')?.textContent ?? '';
const receiptStampOf = (receipt: HTMLElement): string =>
  receipt.querySelector('.settlement-receipt-stamp')?.textContent ?? '';
const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
  ...card.querySelectorAll<HTMLButtonElement>('.settlement-card-actions button'),
];
const labelsOf = (card: HTMLElement): Array<string | null> => actionsOf(card).map((b) => b.textContent);
/** The criteria as they are on screen right now — no toggle pressed. */
const criteriaOn = (card: HTMLElement): string[] => [
  ...card.querySelectorAll('.settlement-card-criteria li'),
].map((row) => row.textContent ?? '');
const staleOf = (card: HTMLElement): string | null =>
  card.querySelector('.settlement-card-stale')?.textContent ?? null;
const metaOf = (card: HTMLElement): string =>
  card.querySelector('.settlement-card-meta')?.textContent ?? '';
/** The meta line's fields, one at a time: `toContain` cannot tell "started" from "not started", so
 *  each field is compared as the whole field it is. */
const metaFieldsOf = (card: HTMLElement): string[] => metaOf(card).split(' · ');

/** The reading control. Deliberately not looked up among the actions: it is not one. */
const readToggle = (card: HTMLElement): HTMLButtonElement => {
  const found = card.querySelector<HTMLButtonElement>('.settlement-card-read');
  if (!found) throw new Error('the card offers no way to read the criteria in full');
  return found;
};

function action(card: HTMLElement, label: string): HTMLButtonElement {
  const found = actionsOf(card).find((button) => button.textContent === label);
  if (!found) {
    throw new Error(`no "${label}" on the card; it offers ${actionsOf(card).map((b) => `"${b.textContent}"`).join(', ')}`);
  }
  return found;
}

/** React Query hands every change to the card on its notify scheduler — a later task — and `act`
 *  drains only microtasks, so every turn waits for a hand-off of its own on that same scheduler.
 *  It runs after every hand-off queued before it, so the card has drawn them all when the turn
 *  ends, however that scheduler is timed. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 200 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

/** Both reads have answered — or failed — and that answer has been handed to the card. */
async function readsLanded(qc: QueryClient): Promise<void> {
  const landed = (queryKey: readonly unknown[]): boolean => {
    const state = qc.getQueryState(queryKey);
    return state !== undefined && state.status !== 'pending' && state.fetchStatus === 'idle';
  };
  await until(
    () => landed(acceptanceConfirmationKey(PROJECT)) && landed(['project', PROJECT]),
    'both reads to answer',
  );
  for (let n = 0; n < 5; n += 1) await turn();
}

/** Both reads come round again, as the card's poll brings them. */
async function reread(qc: QueryClient): Promise<void> {
  await act(async () => {
    await qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(PROJECT) });
    await qc.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
  });
  await readsLanded(qc);
}

/** A coordinator conversation whose card has arrived and can be answered. */
async function delivered(): Promise<{ node: HTMLElement; qc: QueryClient; card: () => HTMLElement }> {
  const { node, qc } = await mount(PROJECT);
  await until(() => cardsIn(node).length > 0, 'the card to be delivered');
  const card = (): HTMLElement => {
    const [only] = cardsIn(node);
    if (!only) throw new Error('the card is not on the page');
    return only;
  };
  // The primary action, whichever word it carries for this project: `Start the project` for one
  // that is not running, `Confirm the criteria` for one that is.
  expect(actionsOf(card())[0]?.disabled, 'the delivered card cannot be answered').toBe(false);
  return { node, qc, card };
}

describe('whether a coordinator conversation is drawn the card', () => {
  it.each<State>(['UNCONFIRMED', 'STALE'])(
    'draws exactly one while the set is %s and NOT ONE criterion is met, through every re-read',
    async (state) => {
      server.standing = standingOf(state);
      server.document = documentOf(NONE_MET);
      const { node, qc } = await mount(PROJECT);
      await until(() => cardsIn(node).length > 0, 'the card to be drawn');
      for (let round = 0; round < 3; round += 1) await reread(qc);
      expect(cardsIn(node)).toHaveLength(1);
    },
  );

  /**
   * The move this card exists for: the question is asked while the plan is written and nothing has
   * run. Five criteria, every one of them unmet, the set not empty and nobody has confirmed it — the
   * card is there; confirmed, it is not. `satisfied` is not in the condition at all, which the third
   * case holds by flipping every one of them to met and asking for the same card.
   */
  it.each<[string, ConfirmationCriterion[]]>([
    ['not one of the 5 stated criteria is met', criteriaOf(false, false, false, false, false)],
    ['the read answered for none of the 5', criteriaOf(undefined, undefined, undefined, undefined, undefined)],
    ['every one of the 5 is met', criteriaOf(true, true, true, true, true)],
  ])('draws one on an OPEN project stating 5 criteria nobody has confirmed while %s', async (_, criteria) => {
    server.document = documentOf(criteria);
    const { node } = await mount(PROJECT);
    await until(() => cardsIn(node).length === 1, 'the card to be drawn before any work has run');
    // The set is not empty and it is all five: what a press would bind is what is on the card.
    expect(criteriaOn(cardsIn(node)[0]!)).toEqual(criteria.map((item) => item.text));
  });

  /**
   * THE PRESS NEEDS SOMETHING TO START, AND THE PLAN ALONE IS NOT IT.
   *
   * `project_create` returns before the coordinator has filed anything: the criteria are stated,
   * the project is OPEN, nobody has confirmed — and the card arrived at exactly that moment, into
   * the middle of the sentence that was still deciding how to split the work, offering to start a
   * project whose every press would have started nothing. The task count is the fourth fact, and it
   * is the one that gives the verb an object. `_count.tasks` counts everything filed under the
   * project, settled work included: whether any of it MAY run is the dispatcher's question.
   */
  it.each<[string, ProjectDocument]>([
    ['holds no task at all', { ...documentOf(NONE_MET), _count: { tasks: 0 } }],
    ['holds no task the read counted', { ...documentOf(NONE_MET), _count: {} }],
    // A read that did not say is read as none, unlike `coordinatorEnabled` beside it: this one
    // GATES an action rather than labelling the project, and a gate nobody can establish stays shut.
    ['does not say how many tasks it holds',
      { title: TITLE, status: 'OPEN', coordinatorEnabled: false, acceptanceCriteriaItems: NONE_MET }],
  ])('draws none while the project %s, and one once a task is filed', async (_, document) => {
    server.standing = standingOf('UNCONFIRMED');
    server.document = document;
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a project with nothing filed under it was offered a start').toHaveLength(0);

    // The same project with one task filed: this fact and not a card that was never going to draw.
    server.document = documentOf(NONE_MET);
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  /** The other half of the same condition, on the same five unmet criteria: confirmed is started,
   *  and a started project is asked nothing. */
  it('draws none for the same 5 unmet criteria once the set is CONFIRMED', async () => {
    server.standing = standingOf('CONFIRMED');
    server.document = documentOf(criteriaOf(false, false, false, false, false));
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a project already started was asked to start again').toHaveLength(0);

    // And the same reads saying it is no longer confirmed bring it back, so the empty pane above
    // was this fact and not a card that was never going to draw.
    server.standing = standingOf('STALE');
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it('draws none in a conversation that coordinates no project, beside one that does on the same reads', async () => {
    const { node } = await mount(null, PROJECT);
    const [ordinary, coordinator] = [...node.querySelectorAll('section')];
    await until(() => cardsIn(coordinator!).length === 1, 'the coordinator conversation to draw its card');
    expect(cardsIn(ordinary!), 'a conversation with no project was drawn the card').toHaveLength(0);
    expect(requests.filter((request) => request.includes('/projects//')), 'a read was made for no project')
      .toEqual([]);
  });

  it.each<[string, ProjectDocument]>([
    ['states no criteria', documentOf([])],
    ['carries no criteria at all', documentOf(undefined)],
    ['is no longer OPEN', documentOf(NONE_MET, 'DONE')],
    ['does not say where it stands', { title: TITLE, acceptanceCriteriaItems: NONE_MET }],
  ])('draws none while the project %s, and one once it is an OPEN project stating criteria', async (_, document) => {
    server.document = document;
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a plan that is not there was put to the owner as what done means').toHaveLength(0);

    server.document = documentOf(NONE_MET);
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });
});

/**
 * The meta line's two middle fields, which are two facts and are read off two documents.
 *
 * Every fixture above builds a project made a moment ago, and in one of those "nobody has confirmed
 * it" and "nobody has started it" are the same sentence — which is exactly why the card could say
 * one while meaning the other for as long as it did. Only a project that was already here separates
 * them, and on 2026-09-18 seven OPEN projects were in that state: the coordinator handing work out,
 * and not one confirmation ever recorded. The card called every one of them "not started".
 */
describe('where the meta line says the project stands', () => {
  it('says started — not "not started" — for a started project whose criteria nobody ever confirmed', async () => {
    server.standing = standingOf('UNCONFIRMED');
    server.document = { ...documentOf(NONE_MET), coordinatorEnabled: true };
    const { qc, card } = await delivered();

    expect(metaOf(card()), 'a project that is handing work out was called not started')
      .not.toContain(ACCEPTANCE_NOT_STARTED);
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_STARTED);
    // And the thing that IS true of it — that nobody has ever said what done means here — is said
    // in its own field rather than being folded into the one above.
    expect(metaFieldsOf(card())[3]).toBe(ACCEPTANCE_NOBODY_SAID_DONE);

    // The same unconfirmed standing with the coordinator off is a new project's normal state. So
    // the word moved with `coordinatorEnabled` and with nothing else: the standing never changed.
    server.document = documentOf(NONE_MET);
    await reread(qc);
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_NOT_STARTED);
    expect(metaFieldsOf(card())[3]).toBe(ACCEPTANCE_NOBODY_SAID_DONE);
  });

  /** The other half: the fourth field is the standing's alone, and the third never moves with it.
   *  The card is delivered unconfirmed and the standing moved under it, because a CONFIRMED set is
   *  never delivered a card of its own — it is one that went stale in place. */
  it.each<[State, string]>([
    ['UNCONFIRMED', ACCEPTANCE_NOBODY_SAID_DONE],
    ['STALE', ACCEPTANCE_CHANGED_SINCE_CONFIRMED],
    ['CONFIRMED', ACCEPTANCE_CONFIRMED],
  ])('says a %s set as "%s" while the project stays started throughout', async (state, asked) => {
    server.document = { ...documentOf(NONE_MET), coordinatorEnabled: true };
    const { qc, card } = await delivered();
    server.standing = standingOf(state);
    await reread(qc);

    expect(metaFieldsOf(card())[3]).toBe(asked);
    expect(metaFieldsOf(card())[2], 'the confirmation moved the project’s own field')
      .toBe(ACCEPTANCE_STARTED);
  });

  /** A project this browser could not read is neither started nor not: a failed read is not an
   *  answer, which is the rule the rest of this card already keeps. */
  it('says neither once the project document stops answering', async () => {
    const { qc, card } = await delivered();
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_NOT_STARTED);

    server.document = new Error('503 on the document');
    await reread(qc);
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_START_NOT_READ);
  });
});

/**
 * A read that failed, the way the native console treats one: it never delivers a card
 * (`settlementHeldOnConfirmation` needs an answerable standing and stated criteria) and it never
 * takes a delivered one away. What a delivered card SAYS after a failed re-read is OrbitKit's rule
 * for a standing it does not have: nothing to confirm, and why.
 */
describe('when a read fails', () => {
  it.each<[string, () => void]>([
    ['the confirmation standing', () => { server.standing = new Error('503 on the standing'); }],
    ['the project document', () => { server.document = new Error('503 on the document'); }],
  ])('draws no card while %s cannot be read, and one once it can', async (_, fail) => {
    fail();
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a card was offered off a read that failed').toHaveLength(0);

    server.standing = standingOf('UNCONFIRMED');
    server.document = documentOf(NONE_MET);
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it('keeps a delivered card when a re-read fails, offering nothing to confirm and saying why', async () => {
    const { node, qc, card } = await delivered();
    server.standing = new Error('503 on the standing');
    await reread(qc);
    expect(cardsIn(node), 'the delivered card went away with the read').toHaveLength(1);
    expect(staleOf(card())).toBe(CONFIRMATION_UNREAD_EXPLANATION);
    expect(action(card(), ACCEPTANCE_START_LABEL).disabled, 'an unread card still offers a confirmation')
      .toBe(true);

    // The failed read was the reason: the next read that answers gives the button back.
    server.standing = standingOf('UNCONFIRMED');
    await reread(qc);
    expect(action(card(), ACCEPTANCE_START_LABEL).disabled).toBe(false);
  });
});

describe('a delivered card that can no longer be answered', () => {
  it.each<[string, (qc: QueryClient) => Promise<void>]>([
    [
      'the next read says the set was confirmed at another end',
      async (qc) => {
        server.standing = standingOf('CONFIRMED');
        await reread(qc);
      },
    ],
    [
      'a confirmed standing lands on the key the card reads, from elsewhere in this tab',
      async (qc) => {
        await act(async () => {
          qc.setQueryData(acceptanceConfirmationKey(PROJECT), standingOf('CONFIRMED'));
        });
      },
    ],
  ])('goes stale in place when %s: confirm disabled, the reason on the card, no press reaching the door', async (_, confirmElsewhere) => {
    const { node, qc, card } = await delivered();
    await confirmElsewhere(qc);
    await until(() => staleOf(card()) !== null, 'the card to say why it can no longer be answered');

    expect(cardsIn(node)).toHaveLength(1);
    expect(staleOf(card())).toBe(acceptanceConfirmationStaleExplanation(standingOf('CONFIRMED')));
    expect(staleOf(card())).toContain(shortSeal(CURRENT));
    const confirm = action(card(), ACCEPTANCE_START_LABEL);
    expect(confirm.disabled, 'a set confirmed elsewhere is still offered for confirming').toBe(true);
    await act(async () => {
      confirm.click();
    });
    expect(presses(), 'a press on the stale card reached the door').toEqual([]);
    // Reading the set and talking about it write nothing, and stay available as on the native card,
    // where neither is ever disabled.
    expect(readToggle(card()).disabled).toBe(false);
    expect(action(card(), OWNER_SEND_BACK_ACTION).disabled).toBe(false);
  });

  it('sends the version it is drawn from, and when the door says that version moved, re-reads before offering the next', async () => {
    server.standing = standingOf('STALE');
    const { card } = await delivered();
    let release: (next: StandardSetConfirmationStanding) => void = () => {};
    server.door = async () => {
      // The criteria were edited between the render and the press: the door refuses, and the
      // standing's next read answers only when this test lets it.
      server.standing = () =>
        new Promise<StandardSetConfirmationStanding>((resolve) => {
          release = resolve;
        });
      throw new Error('PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED: the criteria changed first');
    };
    const readsBefore = standingReads();

    await act(async () => {
      action(card(), ACCEPTANCE_START_LABEL).click();
    });
    await until(() => presses().length === 1, 'the press to reach the door');
    // The version standing when the card was drawn — not the one a stale confirmation named.
    expect(presses()).toEqual([`POST ${STANDING_PATH} ${CURRENT}`]);

    await until(() => standingReads() > readsBefore, 'the refusal to read the standing again');
    // The refusal and the re-read it sets off run in the press's own microtasks, so that read can be
    // on record before React Query has handed the card the press at all. A turn first: the button
    // read is then the card that has been handed everything the press set off.
    await turn();
    expect(action(card(), ACCEPTANCE_START_LABEL).disabled, 'the button came back before the re-read did')
      .toBe(true);

    await act(async () => {
      release(standingOf('UNCONFIRMED', MOVED));
    });
    await until(() => !action(card(), ACCEPTANCE_START_LABEL).disabled, 'the re-read to give the button back');
    expect(card().querySelector('.settlement-card-meta')?.textContent).toContain(shortSeal(MOVED));
    const refusal = card().querySelector('.settlement-card-error')?.textContent ?? '';
    expect(refusal).toContain(CONFIRMATION_NOT_RECORDED);
    expect(refusal).toContain('PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');

    server.standing = standingOf('UNCONFIRMED', MOVED);
    server.door = async () => standingOf('CONFIRMED', MOVED);
    await act(async () => {
      action(card(), ACCEPTANCE_START_LABEL).click();
    });
    await until(() => presses().length === 2, 'the second press to reach the door');
    expect(presses()[1]).toBe(`POST ${STANDING_PATH} ${MOVED}`);
  });
});

describe('the two actions, reading the set, and starting the project', () => {
  /**
   * Two, and the reading toggle is neither of them. There was a third — the one that put the
   * question down — which meant "ask me once the work settles" at the end of a project and means
   * waiting for nothing before one has begun. The equality below is what keeps it from growing back
   * under any name: it names both labels and their order, so a third action of any wording fails.
   */
  it('offers exactly two actions — start, and the one word every card uses for handing a reply to the composer', async () => {
    const { card } = await delivered();
    expect(labelsOf(card()), 'the card grew a third answer').toEqual([
      ACCEPTANCE_START_LABEL,
      OWNER_SEND_BACK_ACTION,
    ]);
    expect(actionsOf(card())).toHaveLength(2);
    // Neither action carries a subtitle: two lines beside one is the bug `ApprovalCards.swift`
    // records, and both buttons ask `CardAction` for their size rather than naming one.
    for (const button of actionsOf(card())) {
      expect(button.className).toContain('card-action');
      expect(button.querySelectorAll('*'), 'an action grew a second line').toHaveLength(0);
    }
  });

  /** Criterion: the criteria are readable without pressing anything. The toggle takes the clamp
   *  off the text that is already there — it does not fetch it, and it is not an action. */
  it('shows every criterion before anything is pressed, and reads them whole on the toggle', async () => {
    const stated = criteriaOf(false, false, false);
    server.document = documentOf([stated[2]!, stated[0]!, stated[1]!]);
    const { card } = await delivered();

    const visible = ['condition 1 holds', 'condition 2 holds', 'condition 3 holds'];
    expect(criteriaOn(card()), 'the criteria were folded away behind a control').toEqual(visible);
    const list = card().querySelector('.settlement-card-criteria')!;
    expect(list.className, 'the criteria were already unfolded').not.toContain('is-open');

    const read = readToggle(card());
    expect(read.textContent).toBe(acceptanceReadLabel(3));
    expect(read.getAttribute('aria-expanded')).toBe('false');
    expect(read.getAttribute('aria-controls')).toBe(list.id);
    expect(actionsOf(card()), 'the reading toggle was put in the action row').toHaveLength(2);

    await act(async () => {
      read.click();
    });
    expect(card().querySelector('.settlement-card-criteria')!.className).toContain('is-open');
    expect(criteriaOn(card()), 'unfolding the criteria changed which ones are there').toEqual(visible);
    expect(readToggle(card()).textContent).toBe(ACCEPTANCE_SHOW_LESS_LABEL);

    await act(async () => {
      readToggle(card()).click();
    });
    expect(card().querySelector('.settlement-card-criteria')!.className).not.toContain('is-open');
    expect(criteriaOn(card())).toEqual(visible);
  });

  /**
   * Chat about this hands the plan to the bottom composer and presses nothing. What separates it
   * from the card going away is the point: the card stays, and starting the project is still the
   * other way out of it.
   */
  it('hands the plan to the composer, leaves the card up with start still live, and writes nothing', async () => {
    const { node, card } = await delivered();
    await act(async () => {
      action(card(), OWNER_SEND_BACK_ACTION).click();
    });

    expect(armed, 'the composer was not armed, or armed more than once').toHaveLength(1);
    expect(armed[0]).toEqual({
      projectId: PROJECT,
      criteriaDigest: CURRENT,
      projectTitle: TITLE,
      criteria: NONE_MET.map((item) => item.text),
    });
    expect(cardsIn(node), 'the card went away when it handed the reply over').toHaveLength(1);
    expect(action(card(), ACCEPTANCE_START_LABEL).disabled, 'starting the project went dead with it')
      .toBe(false);
    expect(presses(), 'handing a reply to the composer reached the door').toEqual([]);
    // No box grew inside the card: the sentence is typed in the one composer at the bottom.
    expect(card().querySelectorAll('textarea, input')).toHaveLength(0);
  });

  it('sends the version it is drawn from and reaches the door with nothing else on the way', async () => {
    const { node, qc, card } = await delivered();
    await act(async () => {
      action(card(), ACCEPTANCE_START_LABEL).click();
    });
    await until(() => receiptsIn(node).length === 1, 'the record the press left');

    expect(presses()).toEqual([`POST ${STANDING_PATH} ${CURRENT}`]);
    expect(qc.getQueryData(acceptanceConfirmationKey(PROJECT))).toEqual(standingOf('CONFIRMED'));
  });
});

/**
 * THE RECORD A CONFIRMATION LEAVES, AND WHERE IT COMES FROM.
 *
 * The answer used to be this window's own state: a line printed on the card by the mutation that
 * pressed it. A reload took the decision out of the conversation it was made in — the same defect
 * the three other receipts were fixed for (`decisionReceipt.ts`) — so what is asserted here is that
 * the record is drawn from the READ: on screen with nothing pressed in this window, and again after
 * the reads come round. Every fixture below goes on to show the empty case filling in once the read
 * says something, so a missing record is never a pane that was not going to draw anyway.
 */
describe('the record a confirmation leaves', () => {
  const confirmed = (): StandardSetConfirmationStanding => standingOf('CONFIRMED');
  /** The seal the fixture's record names: the one a stale set was signed on, not the one standing. */
  const signedSeal = shortSeal(PRIOR);

  it('is drawn from the read: on screen with nothing pressed here, and again after a re-read', async () => {
    // A set confirmed at ANOTHER end — or a moment ago, on another device: nothing here pressed it.
    server.standing = confirmed();
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);

    expect(cardsIn(node), 'a confirmed set is not a question, so no card').toHaveLength(0);
    const [receipt] = receiptsIn(node);
    expect(receipt, 'the reload took the decision out of the conversation').toBeTruthy();
    expect(receiptLineOf(receipt!)).toBe(acceptanceConfirmedLine(confirmed().confirmation!));
    expect(receiptLineOf(receipt!)).toContain(shortSeal(CURRENT));
    expect(receiptStampOf(receipt!)).toContain('by you at');
    expect(receipt!.querySelectorAll('button'), 'a record is not a question').toHaveLength(0);
    expect(presses(), 'a record was drawn without anybody pressing anything here').toEqual([]);

    // And the read coming round again redraws the same record rather than losing it.
    await reread(qc);
    expect(receiptsIn(node)).toHaveLength(1);
    expect(receiptLineOf(receiptsIn(node)[0]!)).toBe(acceptanceConfirmedLine(confirmed().confirmation!));
  });

  it('names the version that was SIGNED, where the card beside it names the one standing now', async () => {
    server.standing = standingOf('STALE');
    const { node, qc, card } = await delivered();
    await reread(qc);

    // Two rows, two facts: the record of what somebody agreed to, and the question about what
    // nobody has agreed to yet.
    expect(receiptsIn(node)).toHaveLength(1);
    expect(cardsIn(node)).toHaveLength(1);
    expect(receiptLineOf(receiptsIn(node)[0]!)).toContain(signedSeal);
    expect(receiptLineOf(receiptsIn(node)[0]!)).not.toContain(shortSeal(CURRENT));
    expect(metaOf(card())).toContain(ACCEPTANCE_CHANGED_SINCE_CONFIRMED);
    expect(metaOf(card())).toContain(shortSeal(CURRENT));
    expect(actionsOf(card()), 'the question is still pressable').toHaveLength(2);
  });

  it('gives way to the record when the press was made HERE, and keeps the card when it was not', async () => {
    const { node, card } = await delivered();
    await act(async () => {
      action(card(), ACCEPTANCE_START_LABEL).click();
    });
    await until(() => receiptsIn(node).length === 1, 'the record of the press');

    expect(cardsIn(node), 'the answered card is still on screen beside its record').toHaveLength(0);
    expect(receiptLineOf(receiptsIn(node)[0]!))
      .toBe(acceptanceConfirmedLine(standingOf('CONFIRMED').confirmation!));
    expect(receiptStampOf(receiptsIn(node)[0]!)).toContain('by you at');
  });

  /** The heading is the family's, so the fourth record reads as the same kind of thing as the
   *  three Orbit already draws into a conversation. */
  it('is headed the way the other three receipts are', async () => {
    server.standing = confirmed();
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(receiptsIn(node)[0]?.querySelector('.settlement-card-heading')?.textContent)
      .toBe(ACCEPTANCE_RECEIPT_HEADING);
  });
});

/**
 * A PROJECT THAT IS ALREADY RUNNING IS NOT A PROJECT THIS CARD CAN START.
 *
 * `Start the project` names an act that is not available to it and a state it is not in: it was
 * handing work out before this card arrived, and what the press does is re-confirm the plan it is
 * running on. The same fact decides the paragraph under it — "Once this starts" describes a
 * beginning that happened some other day — and the meta line's third field, which is why all three
 * move together or not at all. `coordinatorEnabled` is the whole of it, read off the project.
 */
describe('a project that is already handing work out', () => {
  it('is asked to confirm rather than to start, and is never called unstarted', async () => {
    server.standing = standingOf('STALE');
    server.document = { ...documentOf(NONE_MET), coordinatorEnabled: true };
    const { node, qc, card } = await delivered();

    expect(labelsOf(card()), 'a running project was offered a start').toEqual([
      ACCEPTANCE_CONFIRM_LABEL,
      OWNER_SEND_BACK_ACTION,
    ]);
    expect(labelsOf(card())).not.toContain(ACCEPTANCE_START_LABEL);
    // The meta line says where the PROJECT stands off `coordinatorEnabled`, and where the
    // CONFIRMATION stands off the standing. Both are said, and neither is inferred from the other.
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_STARTED);
    expect(metaOf(card())).not.toContain(ACCEPTANCE_NOT_STARTED);
    expect(metaFieldsOf(card())[3]).toBe(ACCEPTANCE_CHANGED_SINCE_CONFIRMED);
    // The paragraph, in the project's own tense: it is not starting.
    const explains = card().querySelector('.settlement-card-explains')?.textContent ?? '';
    expect(explains).not.toContain('Once this starts');
    expect(explains).toContain('Once this is confirmed');

    // And the same standing on a project that is NOT running still says start — the word follows
    // the project and not the confirmation.
    server.document = documentOf(NONE_MET);
    await reread(qc);
    expect(labelsOf(card())[0]).toBe(ACCEPTANCE_START_LABEL);
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_NOT_STARTED);
  });

  /** A read that did not answer is not a project known to be running, and not one known to be
   *  stopped: the card keeps its own word rather than guessing a tense for a project nobody read. */
  it('keeps the card’s own word for a project nobody could read', async () => {
    const { qc, card } = await delivered();
    server.document = new Error('503 on the document');
    await reread(qc);
    expect(metaFieldsOf(card())[2]).toBe(ACCEPTANCE_START_NOT_READ);
    expect(labelsOf(card())[0]).toBe(ACCEPTANCE_START_LABEL);
  });
});
