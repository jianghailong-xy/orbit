// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  ProjectSettlementCard,
  SETTLEMENT_CONFIRM_ACTION,
  SETTLEMENT_DELEGATE_ACTION,
  SETTLEMENT_DELEGATE_HINT,
  SETTLEMENT_HEADING,
  SETTLEMENT_PREVIEW,
  SETTLEMENT_RULE,
  SETTLEMENT_SETTLED_BODY,
  SETTLEMENT_SETTLED_PROVENANCE,
  SETTLEMENT_SETTLED_TITLE,
  SessionProjectSettlementCard,
  projectSettlementContext,
  settlementBlockExplanation,
  settlementBlockTitle,
  settlementCriterionFacts,
  settlementExplains,
  settlementHeldOnProject,
  settlementMeta,
  settlementTally,
  type SettlementClause,
  type SettlementCriterionAnswer,
  type SettlementProjectDocument,
} from './ProjectSettlementCard';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import { ENTER_HINT, SHORTCUT_HINT } from './CardHotkey';
import { acceptanceConfirmationKey } from '../lib/acceptanceConfirmation';

/**
 * The card that explains why a project the server has NOT recorded done is not done.
 *
 * What is asserted is the derivation's own answer rendered, and the two things this file must
 * never do with it: restate a predicate the server already decided (which criteria trip which
 * clause travels on `withheld`), and offer a press that cannot change anything. The condition is
 * asserted on both sides — every "no card" case is a fixture that then draws one once the fact
 * under test changes, so an empty pane is never mistaken for a card that was never going to draw.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const TITLE = 'Orbit 原生 Watch';
const PROJECT = '34DGqqkpCEVavXwRLFWKU';

function criterion(
  over: Partial<SettlementCriterionAnswer> & { definitionId: string },
): SettlementCriterionAnswer {
  return {
    satisfied: true,
    landing: 'LANDED',
    independence: 'INDEPENDENT',
    conflicts: [],
    remedy: null,
    withheld: [],
    ...over,
  };
}

/** A project whose criteria are all met and landed, and whose set nobody has confirmed: one
 *  clause withheld, and it is the clause that has a door. */
function projectOf(over: Partial<SettlementProjectDocument> = {}): SettlementProjectDocument {
  const criteria = [
    criterion({ definitionId: 'c1' }),
    criterion({ definitionId: 'c2' }),
    criterion({ definitionId: 'c3', withheld: ['STANDARD_SET_UNCONFIRMED'] }),
  ];
  return {
    title: TITLE,
    status: 'OPEN',
    acceptanceCriteriaItems: [
      { id: 'c1', ordinal: 1, text: 'condition one holds' },
      { id: 'c2', ordinal: 2, text: 'condition two holds' },
      { id: 'c3', ordinal: 3, text: 'condition three holds' },
    ],
    tasksByStatus: { DONE: 4 },
    derivedDone: {
      status: 'OPEN',
      done: false,
      withheld: ['STANDARD_SET_UNCONFIRMED'],
      // The confirmation clause is not about any one criterion; the row list for it is empty by
      // construction, and the projection says so by leaving every criterion counting.
      criteria: criteria.map((row) => ({ ...row, withheld: [] })),
      confirmation: 'UNCONFIRMED',
    },
    ...over,
  };
}

/** A project held by the criterion-side clauses, three and five criteria long. */
function unlanded(over: Partial<SettlementProjectDocument> = {}): SettlementProjectDocument {
  const criteria = [1, 2, 3, 4, 5].map((n) => criterion({
    definitionId: `u${n}`,
    landing: 'UNKNOWN',
    withheld: ['CRITERION_UNLANDED'],
  }));
  return {
    title: TITLE,
    status: 'OPEN',
    acceptanceCriteriaItems: criteria.map((row, index) => ({
      id: row.definitionId,
      ordinal: index + 1,
      text: `condition ${index + 1} holds`,
    })),
    tasksByStatus: { DONE: 9 },
    derivedDone: {
      status: 'OPEN',
      done: false,
      withheld: ['CRITERION_UNLANDED'],
      criteria,
      confirmation: 'CONFIRMED',
    },
    ...over,
  };
}

const card = (
  project: SettlementProjectDocument,
  over: Partial<Parameters<typeof ProjectSettlementCard>[0]> = {},
): string => renderToStaticMarkup(
  <ProjectSettlementCard
    project={project}
    standing={null}
    settled={false}
    onConfirm={() => {}}
    onDelegate={() => {}}
    {...over}
  />,
);

describe('the copy', () => {
  /** The card's sentences are a spec rather than a draft, so they are pinned as literals: a test
   *  that asserted each constant against itself would go green on any rewording at all. */
  it('asks the question the projection answers, and names its two presses', () => {
    expect(SETTLEMENT_HEADING).toBe('Why is this project not done?');
    expect(SETTLEMENT_CONFIRM_ACTION).toBe('Confirm the criteria');
    // Not `OWNER_SEND_BACK_ACTION`: this card hands the work to the agent that owns the project,
    // and says so, rather than putting the same facts in a composer for the reader to send.
    expect(SETTLEMENT_DELEGATE_ACTION).toBe('Ask the coordinator to handle it');
    expect(SETTLEMENT_RULE).toBe(
      'Orbit records a project done by itself — no press, no agent — when every stated criterion '
      + 'is met by work that has landed and counts, under a criteria set you have confirmed.',
    );
    expect(SETTLEMENT_SETTLED_TITLE).toBe('Orbit recorded this project done.');
    expect(SETTLEMENT_DELEGATE_HINT).toContain('sends the card’s own facts into this conversation');
  });

  it('says how many of those conditions do not hold, in the singular and the plural', () => {
    expect(settlementExplains(['CRITERION_UNLANDED']))
      .toBe(`${SETTLEMENT_RULE} One of those does not hold here.`);
    expect(settlementExplains(['CRITERION_UNLANDED', 'STANDARD_SET_UNCONFIRMED']))
      .toBe(`${SETTLEMENT_RULE} 2 of those do not hold here.`);
  });

  it('names what the project is, and that Orbit has not recorded it done', () => {
    expect(settlementMeta(projectOf())).toBe(
      `${TITLE} · every stated criterion has been met by the work filed under it, and Orbit has `
      + 'not recorded it done',
    );
  });

  it('counts the set, and what is still open under it only when there is something to count', () => {
    expect(settlementTally(unlanded())).toBe(
      '5 stated criteria · 5 settled by the work filed under them · 5 with no merge receipt',
    );
    expect(settlementTally(unlanded({ tasksByStatus: { DONE: 9, FAILED: 2, OPEN: 1 } })))
      .toContain('· 3 task still unsettled, 2 ended FAILED');
  });

  it('reads the two facts off the criterion, and never calls a missing receipt a landing', () => {
    expect(settlementCriterionFacts(criterion({ definitionId: 'c', landing: 'LANDED' })))
      .toBe('Settled · Landed');
    expect(settlementCriterionFacts(criterion({ definitionId: 'c', landing: 'UNKNOWN' })))
      .toBe('Settled · No receipt');
    expect(settlementCriterionFacts(criterion({ definitionId: 'c', landing: 'ON_INTEGRATION_LINE' })))
      .toBe('Settled · On the integration line');
    expect(settlementCriterionFacts(criterion({ definitionId: 'c', satisfied: false })))
      .toBe('Not settled · Landed');
  });

  it('counts the criteria that trip a clause, and marks the two clauses that are about the project', () => {
    expect(settlementBlockTitle('CRITERION_UNLANDED', 1)).toBe('1 criterion has no merge receipt proving it landed');
    expect(settlementBlockTitle('CRITERION_UNLANDED', 5)).toBe('5 criteria have no merge receipt proving they landed');
    expect(settlementBlockTitle('STANDARD_SET_UNCONFIRMED', 0))
      .toBe('the criteria on record have not been confirmed in their current wording');
  });

  /** Every clause the server can name has words here: a clause this file cannot say is a card that
   *  either goes silent about what is withholding settlement or invents a reading of its own. */
  it('has a title and an explanation for every clause the projection can report', () => {
    const clauses: SettlementClause[] = [
      'NO_CRITERIA_STATED', 'CRITERION_UNSATISFIED', 'CRITERION_UNLANDED',
      'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE', 'STANDARD_SET_UNCONFIRMED',
    ];
    for (const clause of clauses) {
      expect(settlementBlockTitle(clause, 3)).not.toBe('');
      expect(settlementBlockExplanation(clause)).not.toBe('');
    }
  });
});

describe('whether a project is held on the question', () => {
  it('holds a project that looks finished and whose projection withholds settlement', () => {
    expect(settlementHeldOnProject(unlanded())).toBe(true);
  });

  it.each<[string, SettlementProjectDocument]>([
    ['a server that serves no projection', projectOf({ derivedDone: undefined })],
    ['a project recorded done', projectOf({ status: 'DONE' })],
    ['a projection that withholds nothing', projectOf({
      derivedDone: { status: 'DONE', done: true, withheld: [], criteria: [], confirmation: 'CONFIRMED' },
    })],
    ['a criterion the work has not met', projectOf({
      derivedDone: {
        status: 'OPEN',
        done: false,
        withheld: ['CRITERION_UNSATISFIED'],
        criteria: [criterion({ definitionId: 'c1', satisfied: false, withheld: ['CRITERION_UNSATISFIED'] })],
        confirmation: 'CONFIRMED',
      },
    })],
    ['a task running under it', projectOf({ tasksByStatus: { DONE: 4, IN_PROGRESS: 1 } })],
    ['no criteria at all', projectOf({
      derivedDone: { status: 'OPEN', done: false, withheld: ['NO_CRITERIA_STATED'], criteria: [], confirmation: 'CONFIRMED' },
    })],
  ])('holds nothing for %s', (_, document) => {
    expect(settlementHeldOnProject(document)).toBe(false);
  });

  it('holds nothing for a read that did not answer', () => {
    expect(settlementHeldOnProject(null)).toBe(false);
    expect(settlementHeldOnProject(undefined)).toBe(false);
    expect(settlementHeldOnProject({ title: TITLE })).toBe(false);
  });
});

describe('the card', () => {
  it('leads with the rule and the count, over the clause that does not hold', () => {
    const markup = card(unlanded());
    expect(markup).toContain(SETTLEMENT_HEADING);
    expect(markup).toContain(PROVENANCE_LABEL);
    expect(markup).toContain(`${SETTLEMENT_RULE} One of those does not hold here.`);
    expect(markup).toContain('5 criteria have no merge receipt proving they landed');
    expect(markup).toContain('Settled · No receipt');
  });

  /** The grouping is the SERVER's: each criterion carries the clauses it trips, and a client that
   *  decided membership itself would be a second statement of the projection's rule. */
  it('groups the criteria the way the projection grouped them, not by re-reading the facts', () => {
    const project = unlanded();
    // A criterion whose landing is UNKNOWN — every fact says it trips CRITERION_UNLANDED — but
    // which the projection did NOT put in that clause. The card must follow the projection.
    project.derivedDone!.criteria = [
      criterion({ definitionId: 'u1', landing: 'UNKNOWN', withheld: [] }),
      criterion({ definitionId: 'u2', landing: 'LANDED', withheld: ['CRITERION_UNLANDED'] }),
    ];
    project.acceptanceCriteriaItems = [
      { id: 'u1', ordinal: 1, text: 'condition one holds' },
      { id: 'u2', ordinal: 2, text: 'condition two holds' },
    ];
    const markup = card(project);
    expect(markup).toContain('condition two holds');
    expect(markup).not.toContain('condition one holds');
  });

  it('folds the criteria past the third behind a reading control', () => {
    const folded = card(unlanded());
    expect(folded).toContain(`>Show all 5<`);
    expect((folded.match(/Settled · No receipt/g) ?? []).length).toBe(SETTLEMENT_PREVIEW);

    const opened = card(unlanded(), {});
    expect(opened).not.toContain('condition five holds');
  });

  it('says what would clear the clause, and quotes the server for the one whose repair it names', () => {
    const project = unlanded();
    expect(card(project)).toContain('land the branch, or record the merge with merge_receipt');

    const authored = projectOf({
      derivedDone: {
        status: 'OPEN',
        done: false,
        withheld: ['CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'],
        criteria: [criterion({
          definitionId: 'c3',
          independence: 'AUTHORED_BY_ITS_OWN_EVIDENCE',
          conflicts: [{ sessionId: 's1', taskId: 't1', taskTitle: '补自更新 E2E 配方' }],
          remedy: { requiredAction: 'ASSIGN_AN_INDEPENDENT_VERIFICATION_TASK', instruction: 'file a VERIFICATION task against this criterion’s work' },
          withheld: ['CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'],
        })],
        confirmation: 'CONFIRMED',
      },
    });
    const markup = card(authored);
    expect(markup).toContain('file a VERIFICATION task against this criterion’s work');
    expect(markup).toContain('补自更新 E2E 配方');
  });

  /** Neither press is "done": the confirmation is the derivation's second input and is offered only
   *  when that is the clause withholding settlement, while the hand-over is offered for every
   *  withheld clause — work is what the conversation this card is drawn in is for. */
  it('offers the confirmation press only for the clause it clears, and the hand-over press always', () => {
    expect(card(projectOf())).toContain(SETTLEMENT_CONFIRM_ACTION);
    expect(card(unlanded())).not.toContain(SETTLEMENT_CONFIRM_ACTION);
    expect(card(unlanded())).toContain(SETTLEMENT_DELEGATE_ACTION);
  });

  it('offers the hand-over press for the clause whose clearing is stating the goal itself', () => {
    const markup = card(projectOf({
      derivedDone: {
        status: 'OPEN',
        done: false,
        withheld: ['NO_CRITERIA_STATED'],
        criteria: [],
        confirmation: 'CONFIRMED',
      },
    }));
    expect(markup).toContain('this project states no criteria');
    expect(markup).toContain(SETTLEMENT_DELEGATE_ACTION);
    // Nothing here asks the reader for a set to confirm: this project has none to stand behind.
    expect(markup).not.toContain(SETTLEMENT_CONFIRM_ACTION);
  });

  it('holds the press while the standing is unreadable or already confirmed', () => {
    expect(card(projectOf(), { standing: null })).toContain('disabled');
    expect(card(projectOf(), {
      standing: {
        state: 'CONFIRMED',
        confirmed: true,
        currentVersion: { digest: 'd', material: [] },
        confirmation: null,
      },
    })).toContain('disabled');
  });

  it('draws the settled state once the projection stops withholding', () => {
    const markup = card(projectOf(), { settled: true });
    expect(markup).toContain(SETTLEMENT_SETTLED_TITLE);
    expect(markup).toContain(SETTLEMENT_SETTLED_BODY);
    expect(markup).toContain(SETTLEMENT_SETTLED_PROVENANCE);
    // The heading belongs to the state: a card the derivation has stopped withholding under must
    // not go on asking why the project is not done, which is what it said on screen while its own
    // body said the opposite.
    expect(markup).not.toContain(SETTLEMENT_HEADING);
    // And once, not twice: the receipt was the body's bold lead-in before it became the heading.
    expect((markup.match(/Orbit recorded this project done/g) ?? []).length).toBe(1);
    // Nothing to press, and nothing withheld to explain.
    expect(markup).not.toContain(SETTLEMENT_CONFIRM_ACTION);
    expect(markup).not.toContain(SETTLEMENT_DELEGATE_ACTION);
    expect(markup).not.toContain('does not hold here');
  });

  it('shows the door’s refusal rather than swallowing it', () => {
    const markup = card(projectOf(), { error: new Error('CONFIRMATION_VERSION_MOVED') });
    expect(markup).toContain('CONFIRMATION_VERSION_MOVED');
  });

  it('carries the blocked criteria and what clears them into what the composer would send', () => {
    const context = projectSettlementContext(unlanded());
    expect(context).toContain(TITLE);
    expect(context).toContain('1. condition 1 holds — Settled · No receipt');
    expect(context).toContain('blocked by CRITERION_UNLANDED');
    expect(context).toContain('land the branch');
  });
});

/** The card as the conversation meets it: wired to the project read and to the confirmation door. */
describe('the wired card', () => {
  type Recorded = { method: string; path: string; body: unknown; init: unknown };
  const recorded: Recorded[] = [];
  const writes = (): Recorded[] => recorded.filter((request) => request.method !== 'GET');

  const server: { document: SettlementProjectDocument | Error } = { document: projectOf() };
  /** What the press handed the conversation, in the order it did: the card writes nothing itself. */
  const delegated: Array<{ facts: string }> = [];

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let client: QueryClient | null = null;

  beforeEach(() => {
    server.document = projectOf();
    recorded.length = 0;
    delegated.length = 0;
    vi.mocked(api).mockImplementation((async (
      path: string,
      init?: { method?: string; body?: unknown },
    ) => {
      recorded.push({ method: init?.method ?? 'GET', path, body: init?.body, init: init ?? {} });
      if (init?.method === 'POST') return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'd', material: [] }, confirmation: null };
      if (path.includes('/acceptance/confirmation')) {
        return { state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
      }
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
              <SessionProjectSettlementCard projectId={projectId} onDelegate={(talk) => delegated.push(talk)} />
            </section>
          ))}
        </QueryClientProvider>,
      );
    });
    return { node, qc };
  }

  const cardsIn = (node: ParentNode): HTMLElement[] => [
    ...node.querySelectorAll<HTMLElement>('.project-settlement'),
  ];
  const buttons = (card: HTMLElement): HTMLButtonElement[] => [
    ...card.querySelectorAll<HTMLButtonElement>('.project-settlement-actions button'),
  ];
/** What a control draws INSIDE itself to say which key presses it, or nothing. */
  const hintOn = (button: HTMLElement): string | null =>
    button.querySelector('.approval-kbd')?.textContent ?? null;

  /** One keypress, as the browser delivers it: on the window, with whatever focus is standing. */
  async function key(init: KeyboardEventInit = {}): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      );
    });
    await turn();
  }

  /** The words ON a button. The card draws its key inside the button it presses, as a span of its
   *  own (`CardHotkey.ts`): what the control does is the label, and what presses it is not. */
  const labelOf = (button: HTMLButtonElement): string => {
    const hint = button.querySelector<HTMLElement>('.approval-kbd');
    const text = button.textContent ?? '';
    return (hint?.textContent ? text.replace(hint.textContent, '') : text).trim();
  };

  const action = (card: HTMLElement, label: string): HTMLButtonElement => {
    const found = buttons(card).find((button) => labelOf(button) === label);
    if (!found) throw new Error(`no "${label}" on the card`);
    return found;
  };

  async function delivered(): Promise<{ node: HTMLElement; qc: QueryClient; card: () => HTMLElement }> {
    const { node, qc } = await mount(PROJECT);
    await until(() => cardsIn(node).length > 0, 'the card to be delivered');
    const card = (): HTMLElement => {
      const [only] = cardsIn(node);
      if (!only) throw new Error('the card is not on the page');
      return only;
    };
    return { node, qc, card };
  }

  it('draws none in a conversation that coordinates no project, beside one that does', async () => {
    const { node } = await mount(null, PROJECT);
    const [ordinary, coordinator] = [...node.querySelectorAll('section')];
    await until(() => cardsIn(coordinator!).length === 1, 'the coordinator conversation to draw its card');
    expect(cardsIn(ordinary!)).toHaveLength(0);
    expect(recorded.filter((request) => request.path.includes('/projects//'))).toEqual([]);
  });

  it.each<[string, SettlementProjectDocument]>([
    ['a server that serves no projection', projectOf({ derivedDone: undefined })],
    ['a project already recorded done', projectOf({ status: 'DONE' })],
    ['a projection that withholds nothing', projectOf({
      derivedDone: { status: 'DONE', done: true, withheld: [], criteria: [], confirmation: 'CONFIRMED' },
    })],
  ])('draws nothing for %s, and one once that changes', async (_, document) => {
    server.document = document;
    const { node, qc } = await mount(PROJECT);
    await turn();
    await turn();
    expect(cardsIn(node)).toHaveLength(0);

    server.document = projectOf();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
    });
    await until(() => cardsIn(node).length === 1, 'the card to be delivered');
  });

  it('reads the confirmation standing only when that is the clause holding settlement', async () => {
    const { node, qc } = await delivered();
    await until(
      () => qc.getQueryState(acceptanceConfirmationKey(PROJECT))?.fetchStatus === 'idle',
      'the standing read',
    );
    expect(recorded.some((r) => r.path.includes('/acceptance/confirmation'))).toBe(true);

    recorded.length = 0;
    server.document = unlanded();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
    });
    await until(() => node.textContent!.includes('no merge receipt proving'), 'the held card');
    expect(recorded.some((r) => r.path.includes('/acceptance/confirmation'))).toBe(false);
  });

  it('confirms the criteria at their own door, carrying the version it read and no session', async () => {
    const { card } = await delivered();
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(() => writes().length > 0, 'the press to reach the door');
    const [press] = writes();
    expect(press!.method).toBe('POST');
    expect(press!.path).toBe(`/projects/${PROJECT}/acceptance/confirmation`);
    expect(press!.body).toEqual({ criteriaDigest: 'digest-1' });
    expect(JSON.stringify(press)).not.toMatch(/session/i);
  });

  /** The state a press used to be replaced by is read back now: it survives a reload, which an
   *  in-memory receipt did not. */
  it('stays on the page when the projection stops withholding, and says so', async () => {
    const { node, qc, card } = await delivered();
    server.document = projectOf({
      derivedDone: { status: 'DONE', done: true, withheld: [], criteria: [], confirmation: 'CONFIRMED' },
    });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project', PROJECT], exact: true });
    });
    await until(() => card().textContent!.includes(SETTLEMENT_SETTLED_TITLE), 'the settled state');
    expect(cardsIn(node)).toHaveLength(1);
  });

  it('hands the card’s own facts to the conversation, and leaves the card answerable', async () => {
    const { node, card } = await delivered();
    await act(async () => {
      action(card(), SETTLEMENT_DELEGATE_ACTION).click();
    });
    expect(delegated).toHaveLength(1);
    // The facts ARE the message: they name the project they are about, so nothing else has to.
    expect(delegated[0]!.facts).toContain(TITLE);
    expect(delegated[0]!.facts).toContain('Orbit has not recorded it done');
    // The card is not an answer to anything, so it stays — with its own press still live.
    expect(cardsIn(node)).toHaveLength(1);
    expect(writes(), 'the press wrote something itself').toEqual([]);
  });

  it('takes the keyboard: the bare key confirms at the door and the chord hands the work over', async () => {
    const { card } = await delivered();

    // One card asking, so it holds the keys — and each control says which key presses it, on the
    // control itself: a shortcut nobody can see is a shortcut nobody has.
    expect(hintOn(action(card(), SETTLEMENT_CONFIRM_ACTION))).toBe(ENTER_HINT);
    expect(hintOn(action(card(), SETTLEMENT_DELEGATE_ACTION))).toBe(SHORTCUT_HINT);

    // The chord first, because it leaves the card standing: it hands the facts over and writes
    // nothing, exactly as the button does.
    await key({ metaKey: true });
    expect(delegated, 'the facts were not handed over, or handed over twice').toHaveLength(1);
    expect(delegated[0]!.facts).toContain('Orbit has not recorded it done');
    expect(writes(), 'the chord wrote something').toEqual([]);

    // And the bare key is the press itself: the same door, and the version the card read.
    await key();
    await until(() => writes().length > 0, 'the key to reach the door');
    const [press] = writes();
    expect(press!.method).toBe('POST');
    expect(press!.path).toBe(`/projects/${PROJECT}/acceptance/confirmation`);
    expect(press!.body).toEqual({ criteriaDigest: 'digest-1' });
  });

  it('shows a refusal on the card rather than eating it', async () => {
    vi.mocked(api).mockImplementation((async (
      path: string,
      init?: { method?: string },
    ) => {
      if (init?.method === 'POST') throw new Error('CONFIRMATION_VERSION_MOVED');
      if (path.includes('/acceptance/confirmation')) {
        return { state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
      }
      return projectOf();
    }) as unknown as typeof api);
    const { card } = await delivered();
    await act(async () => {
      action(card(), SETTLEMENT_CONFIRM_ACTION).click();
    });
    await until(
      () => card().textContent!.includes('CONFIRMATION_VERSION_MOVED'),
      'the refusal to reach the card',
    );
  });
});
