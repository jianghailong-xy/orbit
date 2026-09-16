// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  APPROVE_LABEL,
  SessionCriteriaDecisionCard,
  type CriteriaDecisionResult,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
  type SettledCriteriaDecision,
} from './CriteriaDecisionCard';

/**
 * What an answered proposal leaves where it was answered: a card that gives way to the read, and a
 * receipt that outlives the page.
 *
 * The card kept the answer in the window that pressed it, so a reload took the decision out of the
 * conversation altogether — the account owner's report, 2026-09-16: approved, refreshed, gone. The
 * receipt is now drawn by `WorkspaceView` from the answer the read publishes (`settled`), which is
 * what these two halves pin: that the press hands the door's reply on for that receipt to carry, and
 * that the card is not drawn beside it.
 *
 * The press goes through the wired card and the mocked `api` the way it goes through the real one:
 * the pending read draws the card, the button posts to the decision door, and the door's response
 * — here carrying a reply to the proposing session — is what the press contributes.
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

/** The answer as the read publishes it once the door has recorded one. */
function answered(): SettledCriteriaDecision {
  return {
    intentId: INTENT,
    decision: 'APPROVE',
    decidedAt: '2026-09-13T05:42:00.000Z',
    baseSeal: SEAL,
    resultingSeal: 'f'.repeat(64),
  };
}

function queue(rows: PendingCriteriaDecisionRow[], settled: SettledCriteriaDecision[] = []):
PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-13T05:42:00.000Z',
    projectId: PROJECT,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    decidableCount: rows.length,
    pending: rows,
    settled,
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
  it('hands the door’s answer on, and gives way to the receipt the read publishes', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let decided = false;
    const posts: string[] = [];
    let readsSinceDecided = 0;
    const handedOn: CriteriaDecisionResult[] = [];
    vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path === DECISION_PATH) {
        posts.push(path);
        decided = true;
        return DECIDED;
      }
      if (path === PENDING_PATH) {
        if (decided) readsSinceDecided += 1;
        // The read that comes back names the answer, which is what the transcript's receipt is
        // drawn from — and the proposal itself is not a question any more.
        return decided ? queue([], [answered()]) : queue([held()]);
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
        <SessionCriteriaDecisionCard
          projectId={PROJECT}
          onDecided={(result) => handedOn.push(result)}
        />
      </QueryClientProvider>,
    ));
    await until(() => approveButton(node) !== null, 'the card to offer its answer');

    await act(async () => {
      approveButton(node)!.click();
    });
    await until(() => readsSinceDecided > 0, 'the pending read to come back without the proposal');
    await until(() => !qc.isFetching(), 'that read to settle');

    expect(posts).toEqual([DECISION_PATH]);
    // The door's own response, reply and all, is what the press contributes: the read publishes the
    // outcome and its seals, and the window that pressed is the only one handed the destination.
    expect(handedOn).toEqual([DECIDED]);
    // The card is gone: its question is answered, and the receipt for it is in the conversation.
    await until(() => node.querySelectorAll('.criteria-decision').length === 0,
      'the card to give way to the receipt');
    expect(approveButton(node), 'an answered proposal still offers an answer').toBeNull();
    expect(node.querySelector('.is-stale')).toBeNull();
  });
});

