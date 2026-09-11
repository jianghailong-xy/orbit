// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import {
  ACCEPTANCE_CONFIRM_LABEL,
  ACCEPTANCE_HIDE_CRITERIA_LABEL,
  ACCEPTANCE_NOT_YET_LABEL,
  CONFIRMATION_NOT_RECORDED,
  CONFIRMATION_UNREAD_EXPLANATION,
  SessionAcceptanceConfirmationCard,
  acceptanceConfirmationStaleExplanation,
  acceptanceConfirmedLine,
  acceptanceReadLabel,
  type ConfirmationCriterion,
} from './AcceptanceConfirmationCard';
import { shortSeal } from './CriteriaDecisionCard';

/**
 * The settlement confirmation card, wired to its two reads and its door, in the states a coordinator
 * conversation meets it in.
 *
 * What is asserted is what the native console does (`ConsoleModel.settlementHeldOnConfirmation`,
 * OrbitKit `AcceptanceConfirmations`): a card exactly when the standing can be answered, criteria are
 * stated and every one is met by its work, and none otherwise; a delivered card stays, and goes stale
 * in place; a press sends the version standing now, and a refusal re-reads before the button comes
 * back. Every "none" is asserted on a fixture that goes on to draw the card once the one fact under
 * test changes, so an empty pane is never a card that was not going to draw anyway.
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

const ALL_MET = criteriaOf(true, true, true);

/** A body, an Error for the read failing, or a function for a read that answers when told to. */
type Answer<T> = T | Error | (() => Promise<T>);

const server: {
  standing: Answer<StandardSetConfirmationStanding>;
  document: Answer<{ acceptanceCriteriaItems?: ConfirmationCriterion[] }>;
  door: (criteriaDigest: string) => Promise<StandardSetConfirmationStanding>;
} = {
  standing: standingOf('UNCONFIRMED'),
  document: { acceptanceCriteriaItems: ALL_MET },
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
  server.document = { acceptanceCriteriaItems: ALL_MET };
  server.door = async () => standingOf('CONFIRMED');
  requests.length = 0;
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
            <SessionAcceptanceConfirmationCard projectId={projectId} />
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
const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
  ...card.querySelectorAll<HTMLButtonElement>('.settlement-card-actions button'),
];
const staleOf = (card: HTMLElement): string | null =>
  card.querySelector('.settlement-card-stale')?.textContent ?? null;

function action(card: HTMLElement, label: string): HTMLButtonElement {
  const found = actionsOf(card).find((button) => button.textContent === label);
  if (!found) {
    throw new Error(`no "${label}" on the card; it offers ${actionsOf(card).map((b) => `"${b.textContent}"`).join(', ')}`);
  }
  return found;
}

/** React Query hands a settled result over on a macrotask and `act` drains only microtasks, so
 *  every turn yields one. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  expect(action(card(), ACCEPTANCE_CONFIRM_LABEL).disabled, 'the delivered card cannot be answered').toBe(false);
  return { node, qc, card };
}

/** Generous, because a busy host can stretch the turns these wait on well past vitest's 5s default. */
const SLOW = { timeout: 30_000 };

describe('whether a coordinator conversation is drawn the card', SLOW, () => {
  it.each<State>(['UNCONFIRMED', 'STALE'])(
    'draws exactly one while the set is %s and every stated criterion is met, through every re-read',
    async (state) => {
      server.standing = standingOf(state);
      const { node, qc } = await mount(PROJECT);
      await until(() => cardsIn(node).length > 0, 'the card to be drawn');
      for (let round = 0; round < 3; round += 1) await reread(qc);
      expect(cardsIn(node)).toHaveLength(1);
    },
  );

  it('draws none in a conversation that coordinates no project, beside one that does on the same reads', async () => {
    const { node } = await mount(null, PROJECT);
    const [ordinary, coordinator] = [...node.querySelectorAll('section')];
    await until(() => cardsIn(coordinator!).length === 1, 'the coordinator conversation to draw its card');
    expect(cardsIn(ordinary!), 'a conversation with no project was drawn the card').toHaveLength(0);
    expect(requests.filter((request) => request.includes('/projects//')), 'a read was made for no project')
      .toEqual([]);
  });

  it('draws none while the set is already confirmed, and one when the same reads say it no longer is', async () => {
    server.standing = standingOf('CONFIRMED');
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a set already confirmed was put to the owner again').toHaveLength(0);

    server.standing = standingOf('STALE');
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it.each<[string, ConfirmationCriterion[]]>([
    ['one criterion is not met by its work', criteriaOf(true, false, true)],
    ['the read did not answer for one criterion', criteriaOf(true, undefined, true)],
  ])('draws none while %s, and one once every criterion is met', async (_, criteria) => {
    server.document = { acceptanceCriteriaItems: criteria };
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'the card was offered before every criterion was met').toHaveLength(0);

    server.document = { acceptanceCriteriaItems: ALL_MET };
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it.each<[string, { acceptanceCriteriaItems?: ConfirmationCriterion[] }]>([
    ['states no criteria', { acceptanceCriteriaItems: [] }],
    ['carries no criteria at all', {}],
  ])('draws none while the project %s, and one once it states criteria that are met', async (_, document) => {
    server.document = document;
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'an empty set was put to the owner as what done means').toHaveLength(0);

    server.document = { acceptanceCriteriaItems: ALL_MET };
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });
});

/**
 * A read that failed, the way the native console treats one: it never delivers a card
 * (`settlementHeldOnConfirmation` needs an answerable standing and stated criteria) and it never
 * takes a delivered one away. What a delivered card SAYS after a failed re-read is OrbitKit's rule
 * for a standing it does not have: nothing to confirm, and why.
 */
describe('when a read fails', SLOW, () => {
  it.each<[string, () => void]>([
    ['the confirmation standing', () => { server.standing = new Error('503 on the standing'); }],
    ['the project document', () => { server.document = new Error('503 on the document'); }],
  ])('draws no card while %s cannot be read, and one once it can', async (_, fail) => {
    fail();
    const { node, qc } = await mount(PROJECT);
    await readsLanded(qc);
    expect(cardsIn(node), 'a card was offered off a read that failed').toHaveLength(0);

    server.standing = standingOf('UNCONFIRMED');
    server.document = { acceptanceCriteriaItems: ALL_MET };
    await reread(qc);
    expect(cardsIn(node)).toHaveLength(1);
  });

  it('keeps a delivered card when a re-read fails, offering nothing to confirm and saying why', async () => {
    const { node, qc, card } = await delivered();
    server.standing = new Error('503 on the standing');
    await reread(qc);
    expect(cardsIn(node), 'the delivered card went away with the read').toHaveLength(1);
    expect(staleOf(card())).toBe(CONFIRMATION_UNREAD_EXPLANATION);
    expect(action(card(), ACCEPTANCE_CONFIRM_LABEL).disabled, 'an unread card still offers a confirmation')
      .toBe(true);

    // The failed read was the reason: the next read that answers gives the button back.
    server.standing = standingOf('UNCONFIRMED');
    await reread(qc);
    expect(action(card(), ACCEPTANCE_CONFIRM_LABEL).disabled).toBe(false);
  });
});

describe('a delivered card that can no longer be answered', SLOW, () => {
  it.each<[string, (qc: QueryClient) => Promise<void>]>([
    [
      'the next read says the set was confirmed at another end',
      async (qc) => {
        server.standing = standingOf('CONFIRMED');
        await reread(qc);
      },
    ],
    [
      'the project page in this tab confirms it, on the key both surfaces read',
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
    const confirm = action(card(), ACCEPTANCE_CONFIRM_LABEL);
    expect(confirm.disabled, 'a set confirmed elsewhere is still offered for confirming').toBe(true);
    await act(async () => {
      confirm.click();
    });
    expect(presses(), 'a press on the stale card reached the door').toEqual([]);
    // Reading the set and putting the question down write nothing, and stay available as on the
    // native card, where both are never disabled.
    expect(action(card(), acceptanceReadLabel(3)).disabled).toBe(false);
    expect(action(card(), ACCEPTANCE_NOT_YET_LABEL).disabled).toBe(false);
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
      action(card(), ACCEPTANCE_CONFIRM_LABEL).click();
    });
    await until(() => presses().length === 1, 'the press to reach the door');
    // The version standing when the card was drawn — not the one a stale confirmation named.
    expect(presses()).toEqual([`POST ${STANDING_PATH} ${CURRENT}`]);

    await until(() => standingReads() > readsBefore, 'the refusal to read the standing again');
    expect(action(card(), ACCEPTANCE_CONFIRM_LABEL).disabled, 'the button came back before the re-read did')
      .toBe(true);

    await act(async () => {
      release(standingOf('UNCONFIRMED', MOVED));
    });
    await until(() => !action(card(), ACCEPTANCE_CONFIRM_LABEL).disabled, 'the re-read to give the button back');
    expect(card().querySelector('.settlement-card-meta')?.textContent).toContain(shortSeal(MOVED));
    const refusal = card().querySelector('.settlement-card-error')?.textContent ?? '';
    expect(refusal).toContain(CONFIRMATION_NOT_RECORDED);
    expect(refusal).toContain('PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');

    server.standing = standingOf('UNCONFIRMED', MOVED);
    server.door = async () => standingOf('CONFIRMED', MOVED);
    await act(async () => {
      action(card(), ACCEPTANCE_CONFIRM_LABEL).click();
    });
    await until(() => presses().length === 2, 'the second press to reach the door');
    expect(presses()[1]).toBe(`POST ${STANDING_PATH} ${MOVED}`);
  });
});

describe('reading the set, putting the question down, and confirming', SLOW, () => {
  it('opens the criteria it would confirm, in their stated order, and folds them away again', async () => {
    server.document = { acceptanceCriteriaItems: [ALL_MET[2]!, ALL_MET[0]!, ALL_MET[1]!] };
    const { card } = await delivered();
    expect(card().querySelector('.settlement-card-criteria')).toBeNull();

    const read = action(card(), acceptanceReadLabel(3));
    expect(read.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      read.click();
    });
    const list = card().querySelector('.settlement-card-criteria');
    expect([...(list?.querySelectorAll('li') ?? [])].map((row) => row.textContent)).toEqual([
      'condition 1 holds',
      'condition 2 holds',
      'condition 3 holds',
    ]);
    const hide = action(card(), ACCEPTANCE_HIDE_CRITERIA_LABEL);
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(hide.getAttribute('aria-controls')).toBe(list?.id);

    await act(async () => {
      hide.click();
    });
    expect(card().querySelector('.settlement-card-criteria')).toBeNull();
  });

  it('puts the question down on Not yet, and writes nothing', async () => {
    const { node, card } = await delivered();
    await act(async () => {
      action(card(), ACCEPTANCE_NOT_YET_LABEL).click();
    });
    expect(cardsIn(node)).toHaveLength(0);
    expect(presses()).toEqual([]);
  });

  it('keeps a confirmation pressed here as recorded here, on the key the project page reads', async () => {
    const { qc, card } = await delivered();
    await act(async () => {
      action(card(), ACCEPTANCE_CONFIRM_LABEL).click();
    });
    await until(() => card().querySelector('.settlement-card-recorded') !== null, 'the door’s answer on the card');

    expect(presses()).toEqual([`POST ${STANDING_PATH} ${CURRENT}`]);
    expect(card().querySelector('.settlement-card-recorded')?.textContent)
      .toBe(acceptanceConfirmedLine(standingOf('CONFIRMED')));
    // Not "confirmed at another end": this is the end it was confirmed at.
    expect(staleOf(card())).toBeNull();
    expect(actionsOf(card())).toEqual([]);
    expect(qc.getQueryData(acceptanceConfirmationKey(PROJECT))).toEqual(standingOf('CONFIRMED'));
  });
});
