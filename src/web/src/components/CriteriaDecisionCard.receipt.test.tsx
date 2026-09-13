// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  APPROVE_LABEL,
  CRITERIA_DECISION_HEADING,
  REPLY_SENT_TO_SESSION,
  SessionCriteriaDecisionCard,
  type CriteriaDecisionResult,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
} from './CriteriaDecisionCard';

/**
 * A card pressed in this window gives way to its receipt, in its own place — the half a static
 * render of the receipt cannot reach.
 *
 * The door now answers the session that proposed the change and says where that answer went. The
 * reader who pressed learns it from the receipt: the card's head stays, and one line under it says
 * what was recorded and that the proposing session was sent it. Until then the pressed card was
 * simply dropped from the window, which told the reader nothing about the session still waiting.
 *
 * The press goes through the wired card and the mocked `api` the way it goes through the real one:
 * the pending read draws the card, the button posts to the decision door, and the door's response
 * — here carrying a reply to the proposing session — is what the receipt is drawn from.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34ODoUKJGEsfbgcJDGS4q';
const INTENT = '4TdXP1ChQx7vLmN3pR5sT8';
const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';
const SESSION_TITLE = '执行任务：改写项目硬约束 1、3 与判据 2';
const PENDING_PATH = `/projects/${PROJECT}/acceptance/criteria-decisions/pending`;
const DECISION_PATH = `/projects/${PROJECT}/acceptance/criteria-decisions/${INTENT}`;

/** A proposal that adds one criterion — decidable, as a fresh one is. */
function held(): PendingCriteriaDecisionRow {
  const wording = {
    text: 'the reply names the criteria that moved',
    verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  };
  return {
    intentId: INTENT,
    projectId: PROJECT,
    commitToken: `token-${INTENT}`,
    actionDigest: 'a'.repeat(64),
    filedAt: '2026-09-13T05:30:00.000Z',
    ageSeconds: 12 * 60,
    baselineSeal: SEAL,
    currentSeal: SEAL,
    proposed: [{ id: null, ordinal: 1, ...wording }],
    diff: {
      entries: [{
        change: 'NEW',
        definitionId: null,
        ordinal: 1,
        proposed: wording,
        onRecord: null,
        changed: [],
        rewrites: [],
      }],
      sameCount: 0,
      changedCount: 0,
      newCount: 1,
      removedCount: 0,
    },
    supersededIntentId: null,
    decidability: { decidable: true, refusal: null, requiredAction: null },
  };
}

function queue(rows: PendingCriteriaDecisionRow[]): PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-13T05:42:00.000Z',
    projectId: PROJECT,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    decidableCount: rows.length,
    pending: rows,
  };
}

/** The door's answer, with the reply it sent to the session that proposed the change. */
const DECIDED: CriteriaDecisionResult = {
  intentId: INTENT,
  decision: 'APPROVE',
  decidedAt: '2026-09-13T05:42:00.000Z',
  baseSeal: SEAL,
  resultingSeal: 'f'.repeat(64),
  applied: true,
  reply: {
    channel: 'SESSION',
    sessionId: '4loVMXEZpNVNZAWLb9Wq4D',
    sessionTitle: SESSION_TITLE,
    turnId: '2kQ7xVb9LmN3pR5sT8wYz',
    sentAt: '2026-09-13T05:42:01.000Z',
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  client?.clear();
  client = null;
  vi.mocked(api).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The live Approve button, or null once there is none to press. */
function approveButton(node: HTMLElement): HTMLButtonElement | null {
  return [...node.querySelectorAll('button')]
    .find((button) => button.textContent === APPROVE_LABEL && !button.disabled) ?? null;
}

/**
 * Lets reads land and cards re-derive until `done` holds. React Query hands a settled result over
 * on a macrotask, and `act` alone drains only microtasks, so every turn yields one.
 */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 50 && !done(); turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(done(), `waited for ${what}`).toBe(true);
}

describe('a criteria card answered in this window', () => {
  it('is replaced where it stood by a receipt saying the proposing session was sent the answer', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let decided = false;
    const posts: string[] = [];
    let readsSinceDecided = 0;
    vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path === DECISION_PATH) {
        posts.push(path);
        decided = true;
        return DECIDED;
      }
      if (path === PENDING_PATH) {
        if (decided) readsSinceDecided += 1;
        return queue(decided ? [] : [held()]);
      }
      throw new Error(`nothing is stubbed at ${init?.method ?? 'GET'} ${path}`);
    }) as unknown as typeof api);

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const node = document.createElement('div');
    document.body.appendChild(node);
    container = node;
    const tree = createRoot(node);
    root = tree;
    const qc = client;
    await act(async () => tree.render(
      <QueryClientProvider client={qc}>
        <SessionCriteriaDecisionCard projectId={PROJECT} />
      </QueryClientProvider>,
    ));
    await until(() => approveButton(node) !== null, 'the card to offer its answer');

    await act(async () => {
      approveButton(node)!.click();
    });
    await until(
      () => node.querySelector('.criteria-decision-receipt') !== null,
      'the receipt to replace the card',
    );
    expect(posts).toEqual([DECISION_PATH]);

    const cards = [...node.querySelectorAll('.criteria-decision')];
    expect(cards.map((card) => card.id), 'one receipt, at the card’s own address')
      .toEqual([`criteria-decision-${INTENT}`]);
    const [card] = cards;
    expect(card.querySelector('.criteria-decision-heading')?.textContent)
      .toBe(CRITERIA_DECISION_HEADING);
    const line = card.querySelector('.criteria-decision-receipt')?.textContent ?? '';
    expect(line).toContain('✓ Approved by you at');
    expect(line).toContain(REPLY_SENT_TO_SESSION);
    expect(line).toContain(`(${SESSION_TITLE})`);
    expect(approveButton(node), 'a receipt offers no answer').toBeNull();

    // The press invalidated the pending read, and the proposal is gone from it. The card this
    // window answered stays a receipt rather than going stale into "answered at another end".
    await until(() => readsSinceDecided > 0, 'the pending read to come back without the proposal');
    await until(() => !qc.isFetching(), 'that read to settle');
    expect([...node.querySelectorAll('.criteria-decision')].map((each) => each.id))
      .toEqual([`criteria-decision-${INTENT}`]);
    expect(node.querySelector('.criteria-decision-receipt')?.textContent).toBe(line);
    expect(node.querySelector('.is-stale')).toBeNull();
  });
});
