// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CriteriaChangesSinceConfirmed } from '@orbit/shared';
import { api, ApiError } from '../api';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import {
  CRITERIA_CHANGE_CHAT_PLACEHOLDER,
  CRITERIA_CHANGE_EXPLAINS,
  CRITERIA_CHANGE_TITLE,
  CRITERIA_CHANGE_WHAT_CHANGED,
  confirmedChangesKey,
  criteriaChangeConfirmLabel,
  criteriaChangeMeta,
  criteriaChangeShowAll,
  criteriaChangeUnchanged,
} from '../lib/projectStart';
import {
  ACCEPTANCE_SHOW_LESS_LABEL,
  CONFIRMATION_NOT_RECORDED,
  SessionAcceptanceConfirmationCard,
  acceptancePlanChangeContext,
  acceptancePlanChangePlaceholder,
  type SettlementPlanChat,
} from './AcceptanceConfirmationCard';
import { ENTER_HINT } from './CardHotkey';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { SessionCriteriaChangeCard, criteriaChangeCounts, criteriaChangeHeld } from './CriteriaChangeCard';

/**
 * "Confirm the new criteria?" — a started project whose criteria moved after the owner confirmed
 * them, asked about what moved: the added criterion as New, the tightened check as Stricter with the
 * one it replaced, the rest numbered, and the whole set one toggle away. The project keeps running;
 * the press confirms the version standing now and leaves what it confirmed for the receipt.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const PROJECT = '34WvwUS8YMXfOfWbMqVuu';
const CURRENT = `7d1e03a9c2f4${'0'.repeat(52)}`;
const PRIOR = `3a9f00c1b2d4${'1'.repeat(52)}`;
const MOVED = `9c4f7a1bb001${'2'.repeat(52)}`;
const TITLE = 'Runner 页整页改版（iOS/macOS + web）';
const STARTED_AT = '2026-09-29T08:26:00.000Z';

const CRITERIA = [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, ordinal: n, text: `condition ${n} holds` }));
const NEW_TEXT = 'macOS：设置 → Runners 与 iOS 同结构（同一套 OrbitKit 视图），截图与 ios-list.png 并排提交';
const STRICTER = 'EXECUTABLE';
const WAS = 'HUMAN';

/** The mock's two changes: criterion 5 added, criterion 2's check made stricter, 1, 3, 4 as signed. */
function changesOf(over: Partial<CriteriaChangesSinceConfirmed> = {}): CriteriaChangesSinceConfirmed {
  return {
    added: [{ key: 'k5', ordinal: 5, text: NEW_TEXT }],
    stricter: [{ key: 'k2', ordinal: 2, verificationMethod: STRICTER, confirmedVerificationMethod: WAS }],
    revised: [],
    removed: [],
    unchanged: [1, 3, 4],
    ...over,
  };
}

/** A set of five standing now over a confirmation of four. */
function standingOf(
  state: StandardSetConfirmationStanding['state'] = 'STALE',
  changes: CriteriaChangesSinceConfirmed | null = changesOf(),
  digest = CURRENT,
): StandardSetConfirmationStanding {
  const material = CRITERIA.map((c) => ({ definitionId: c.id, revision: 1, contentHash: `h${c.ordinal}` }));
  return {
    state,
    confirmed: state === 'CONFIRMED',
    currentVersion: { digest, material },
    confirmation: {
      criteriaDigest: state === 'CONFIRMED' ? digest : PRIOR,
      criteriaMaterial: material.slice(0, 4),
      confirmedAt: '2026-09-29T08:26:00.000Z',
      confirmedById: 'owner',
      startedWith: null,
    },
    changesSinceConfirmed: state === 'CONFIRMED' ? { ...changesOf(), added: [], stricter: [], unchanged: [1, 2, 3, 4, 5] } : changes,
    changesSinceConfirmedAbsentReason: null,
  };
}

const documentOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: TITLE,
  status: 'OPEN',
  coordinatorEnabled: true,
  startedAt: STARTED_AT,
  _count: { tasks: 6 },
  acceptanceCriteriaItems: CRITERIA,
  ...over,
});

const server: {
  standing: StandardSetConfirmationStanding;
  document: Record<string, unknown>;
  door: (digest: string) => Promise<StandardSetConfirmationStanding>;
} = { standing: standingOf(), document: documentOf(), door: async () => standingOf('CONFIRMED') };

const presses: string[] = [];
const armed: SettlementPlanChat[] = [];
const reports: Array<boolean | string | null> = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  server.standing = standingOf();
  server.document = documentOf();
  server.door = async () => standingOf('CONFIRMED');
  presses.length = 0;
  armed.length = 0;
  reports.length = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: { criteriaDigest?: string } }) => {
    if (init?.method === 'POST' && path === `/projects/${PROJECT}/acceptance/confirmation`) {
      presses.push(init.body?.criteriaDigest ?? '');
      return server.door(init.body?.criteriaDigest ?? '');
    }
    if (path === `/projects/${PROJECT}/acceptance/confirmation`) return server.standing;
    if (path === `/projects/${PROJECT}`) return server.document;
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

async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 300 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

async function mount(router = false): Promise<{ node: HTMLElement; qc: QueryClient }> {
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
        {router ? (
          <SessionAcceptanceConfirmationCard
            projectId={PROJECT}
            onOpenQuestion={(question) => reports.push(question)}
            onChatAbout={(plan) => armed.push(plan)}
          />
        ) : (
          <SessionCriteriaChangeCard
            projectId={PROJECT}
            onOpen={(open) => reports.push(open)}
            onChatAbout={(plan) => armed.push(plan)}
          />
        )}
      </QueryClientProvider>,
    );
  });
  return { node, qc };
}

const cardIn = (node: ParentNode): HTMLElement | null => node.querySelector<HTMLElement>('.criteria-change-card');

async function delivered() {
  const { node, qc } = await mount();
  await until(() => cardIn(node) !== null, 'the card');
  const card = (): HTMLElement => {
    const found = cardIn(node);
    if (!found) throw new Error('the card is not on the page');
    return found;
  };
  return { node, qc, card };
}

async function reread(qc: QueryClient): Promise<void> {
  await act(async () => {
    await qc.invalidateQueries();
  });
  for (let n = 0; n < 10; n += 1) await turn();
}

function labelOf(button: HTMLButtonElement): string {
  const hint = button.querySelector<HTMLElement>('.approval-kbd');
  const text = button.textContent ?? '';
  return (hint?.textContent ? text.replace(hint.textContent, '') : text).trim();
}
const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
  ...card.querySelectorAll<HTMLButtonElement>('.settlement-card-actions button'),
];
const rowsOf = (card: HTMLElement): string[][] =>
  [...card.querySelectorAll('.criteria-change-list li')].map((li) => [
    li.querySelector('.criteria-change-mark')?.textContent ?? '',
    li.querySelector('.criteria-change-kind')?.textContent ?? '',
    li.querySelector('.criteria-change-text')?.firstChild?.textContent ?? '',
    li.querySelector('.criteria-change-was')?.textContent ?? '',
  ]);

async function key(init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  });
  await turn();
}

describe('the words, as the copy table has them', () => {
  it('says the card, what changed, and the rest in the owner-approved sentences', () => {
    expect(CRITERIA_CHANGE_TITLE).toBe('Confirm the new criteria?');
    expect(CRITERIA_CHANGE_WHAT_CHANGED).toBe('What changed');
    expect(CRITERIA_CHANGE_EXPLAINS).toBe(
      'The project keeps running. Orbit marks it done only against criteria you’ve confirmed, so until '
      + 'you confirm these it stays open even if every task finishes.');
    expect(criteriaChangeMeta(TITLE, 4, 5, '7d1e03a9c2f4'))
      .toBe(`${TITLE} · running · 4 → 5 criteria · seal 7d1e03a9c2f4`);
    expect(criteriaChangeUnchanged([1, 3, 4], 0)).toBe('1, 3, 4 unchanged');
    expect(criteriaChangeUnchanged([1, 3], 1)).toBe('1, 3 unchanged · 1 removed');
    expect(criteriaChangeShowAll(5)).toBe('Show all 5');
    expect(criteriaChangeConfirmLabel(5)).toBe('Confirm 5 criteria');
    expect(criteriaChangeConfirmLabel(1)).toBe('Confirm 1 criterion');
    expect(CRITERIA_CHANGE_CHAT_PLACEHOLDER).toBe('What should change about these?');
    expect(acceptancePlanChangePlaceholder('CRITERIA_CHANGE')).toBe(CRITERIA_CHANGE_CHAT_PLACEHOLDER);
    // What a press leaves for the receipt: "— 1 new, 1 stricter".
    expect(criteriaChangeCounts(changesOf())).toBe('1 new, 1 stricter');
    expect(criteriaChangeCounts(changesOf({ revised: [{ key: 'k3', ordinal: 3, text: 't' }], removed: ['k9'] })))
      .toBe('1 new, 1 stricter, 1 changed, 1 removed');
    // A running project's context does not say no work has started against it.
    const context = acceptancePlanChangeContext({
      projectTitle: TITLE, criteriaDigest: CURRENT, criteria: ['alpha'], question: 'CRITERIA_CHANGE',
    });
    expect(context).toContain('while the project keeps running');
    expect(context).not.toContain('no work has started');
  });
});

describe('when the card is drawn', () => {
  const held = (standing: StandardSetConfirmationStanding | null, document: Record<string, unknown> | null) =>
    criteriaChangeHeld(standing, document as never);

  it('asks a started, open project whose set moved in a way the server can list — and nothing else', () => {
    expect(held(standingOf(), documentOf())).toBe(true);
    // Every fact on its own closes it.
    expect(held(null, documentOf()), 'a standing that could not be read').toBe(false);
    expect(held(standingOf('CONFIRMED'), documentOf()), 'a set confirmed as it stands').toBe(false);
    expect(held(standingOf('UNCONFIRMED', null), documentOf()), 'a set nobody ever confirmed').toBe(false);
    expect(held(standingOf('STALE', null), documentOf()), 'a moved set the server cannot list').toBe(false);
    expect(held(standingOf(), documentOf({ startedAt: null })), 'a project nobody has started').toBe(false);
    expect(held(standingOf(), documentOf({ startedAt: undefined })), 'a read that does not say').toBe(false);
    expect(held(standingOf(), documentOf({ status: 'DONE' })), 'a project that is not open').toBe(false);
    expect(held(standingOf(), documentOf({ acceptanceCriteriaItems: [] })), 'no criteria').toBe(false);
    expect(held(standingOf(), documentOf({ _count: { tasks: 0 } })), 'no work').toBe(false);
    expect(held(standingOf(), null), 'a project that could not be read').toBe(false);
  });

  it('is the one settlement card the router draws for it, and says which question it is', async () => {
    const { node } = await mount(true);
    await until(() => cardIn(node) !== null, 'the change card');
    expect(node.querySelectorAll('.settlement-card'), 'the moved set was asked about twice').toHaveLength(1);
    await until(() => reports.includes('CRITERIA_CHANGE'), 'the router to report the change question');
  });
});

describe('what the card says', () => {
  it('lists what changed and numbers the rest, the way the mock does', async () => {
    const { card } = await delivered();
    expect(card().querySelector('.settlement-card-heading')?.textContent).toBe(CRITERIA_CHANGE_TITLE);
    expect(card().querySelector('.criteria-provenance')?.textContent).toBe(PROVENANCE_LABEL);
    expect(card().querySelector('.settlement-card-meta')?.textContent)
      .toBe(criteriaChangeMeta(TITLE, 4, 5, shortSeal(CURRENT)));
    expect(card().querySelector('.criteria-change-list')?.getAttribute('aria-label')).toBe(CRITERIA_CHANGE_WHAT_CHANGED);
    expect(rowsOf(card())).toEqual([
      ['+', '5 · New', NEW_TEXT, ''],
      ['↑', '2 · Stricter check', STRICTER, `was: ${WAS}`],
    ]);
    expect(card().querySelector('.criteria-change-rest')?.textContent).toBe('1, 3, 4 unchanged · Show all 5');
    expect(card().querySelector('.settlement-card-explains')?.textContent).toBe(CRITERIA_CHANGE_EXPLAINS);
    expect(actionsOf(card()).map(labelOf)).toEqual(['Confirm 5 criteria', OWNER_SEND_BACK_ACTION]);
    expect(actionsOf(card())[0]!.querySelector('.approval-kbd')?.textContent).toBe(ENTER_HINT);
    expect(actionsOf(card())[1]!.querySelector('.approval-kbd')).toBeNull();
    // No start anywhere on it: the project is running, and nothing on the card says otherwise.
    expect(card().textContent).not.toContain('Start');
  });

  it('shows every criterion on the toggle, and folds them away again', async () => {
    const { card } = await delivered();
    expect(card().querySelector('.settlement-card-criteria')).toBeNull();
    const toggle = card().querySelector<HTMLButtonElement>('.criteria-change-rest .settlement-card-read')!;
    await act(async () => {
      toggle.click();
    });
    expect([...card().querySelectorAll('.settlement-card-criteria li')].map((li) => li.textContent))
      .toEqual(CRITERIA.map((c) => c.text));
    expect(toggle.textContent).toBe(ACCEPTANCE_SHOW_LESS_LABEL);
    await act(async () => {
      toggle.click();
    });
    expect(card().querySelector('.settlement-card-criteria')).toBeNull();
  });

  it('lists a change an approved proposal landed as changed, and counts what is gone, never as unchanged', async () => {
    server.standing = standingOf('STALE', changesOf({
      stricter: [],
      revised: [{ key: 'k2', ordinal: 2, text: 'condition 2, reworded' }],
      removed: ['k6'],
      unchanged: [1, 3, 4],
    }));
    const { card } = await delivered();
    expect(rowsOf(card())).toEqual([
      ['+', '5 · New', NEW_TEXT, ''],
      ['~', '2 · Changed', 'condition 2, reworded', ''],
    ]);
    expect(card().querySelector('.criteria-change-rest')?.textContent)
      .toBe('1, 3, 4 unchanged · 1 removed · Show all 5');
  });
});

describe('the press', () => {
  it('confirms the version it is drawn from, leaves what it confirmed for the receipt, and goes', async () => {
    const { node, qc, card } = await delivered();
    await act(async () => {
      actionsOf(card())[0]!.click();
    });
    await until(() => cardIn(node) === null, 'the answered card to go');
    expect(presses).toEqual([CURRENT]);
    expect(qc.getQueryData(confirmedChangesKey(PROJECT, CURRENT))).toBe('1 new, 1 stricter');
    expect(qc.getQueryData<StandardSetConfirmationStanding>(acceptanceConfirmationKey(PROJECT))?.state).toBe('CONFIRMED');
    await until(() => reports[reports.length - 1] === false, 'the page to be told');
  });

  it('confirms on Enter and leaves Chat about this without a shortcut', async () => {
    const { node } = await delivered();
    await key({ ctrlKey: true });
    await key({ metaKey: true });
    expect(armed).toEqual([]);
    expect(presses, 'the chord reached the door').toEqual([]);
    expect(cardIn(node), 'the chord removed the card').not.toBeNull();

    await key();
    await until(() => presses.length === 1, 'the bare key to confirm');
    expect(presses).toEqual([CURRENT]);
  });

  it('says a refusal over the door’s own words and lists what stands after the re-read', async () => {
    server.door = async () => {
      server.standing = standingOf('STALE', changesOf({
        added: [
          { key: 'k5', ordinal: 5, text: NEW_TEXT },
          { key: 'k6', ordinal: 6, text: 'condition 6 holds' },
        ],
      }), MOVED);
      throw new ApiError('The acceptance criteria changed after the version being confirmed was read.', 409,
        'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');
    };
    const { card } = await delivered();
    await act(async () => {
      actionsOf(card())[0]!.click();
    });
    await until(() => card().querySelector('.settlement-card-error') !== null, 'the refusal to be said');
    expect(card().querySelector('.settlement-card-error')?.textContent).toContain(CONFIRMATION_NOT_RECORDED);
    await until(() => rowsOf(card()).length === 3, 'the re-read to list what stands now');
    expect(card().querySelector('.settlement-card-meta')?.textContent).toContain(shortSeal(MOVED));
    expect(actionsOf(card())[0]!.disabled).toBe(false);

    server.door = async () => standingOf('CONFIRMED', null, MOVED);
    await act(async () => {
      actionsOf(card())[0]!.click();
    });
    await until(() => presses.length === 2, 'the second press');
    expect(presses[1]).toBe(MOVED);
  });

  it('goes when the set is confirmed at another end, leaving the record to the conversation', async () => {
    const { node, qc } = await delivered();
    server.standing = standingOf('CONFIRMED');
    await reread(qc);
    await until(() => cardIn(node) === null, 'the card to go');
    expect(presses).toEqual([]);
  });
});
