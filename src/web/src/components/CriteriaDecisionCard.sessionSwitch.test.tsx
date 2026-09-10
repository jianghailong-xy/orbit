// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  CRITERIA_DECISION_HEADING,
  CRITERIA_DECISION_STALE_HEADING,
  SessionCriteriaDecisionCard,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
} from './CriteriaDecisionCard';

/**
 * The delivered card across a switch from one project's conversation to another's — the case no
 * render of a single session can reach.
 *
 * `SessionCriteriaDecisionCard` remembers the address of every proposal it has shown, so a question
 * answered in another window goes stale in place instead of vanishing mid-read. That memory is
 * right only while the instance belongs to ONE conversation, and WorkspaceView is not remounted
 * between sessions (App.tsx: every `sessions/:id` shares one layout route). Unkeyed, an address
 * remembered in P1's coordinator conversation is looked up in P2's read, found nowhere, and drawn
 * in P2's conversation as "This decision is no longer yours to make" — about a proposal nobody in
 * P2 was ever asked. The mount keys the card by the session on screen, and that key is the fix.
 *
 * WHY THE HARNESS READS WorkspaceView.tsx
 * ---------------------------------------
 * The view needs a router, a runner and a live session before it renders anything, so the pane
 * below is a stand-in: one tree that stays mounted while the session under it changes, as the
 * view's does. What it must not stand in for is the fix. It takes the card's key from
 * WorkspaceView's own element, so taking the key off that element makes the second case DRAW the
 * ghost card rather than only fail a text scan — a key restated here could never go red.
 *
 * The first case is the positive control, on the same fixture: the card that must not follow the
 * reader into P2 is really drawn in P1, so its absence in P2 cannot be a card that never drew. And
 * P2 holds a proposal of its own, so the absence is asserted in a pane that has read P2's queue and
 * drawn from it, not in one still waiting for the read.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const P1 = '34MPiBgZ80YpSKt0lmTQA';
const P2 = '34LWcmLItBx6ytdO26XXF';

interface OpenSession {
  id: string;
  projectId: string | null;
}

/** P1's coordinator conversation, and one of P2's. */
const P1_COORDINATOR: OpenSession = { id: '2kQ7xVb9LmN3pR5sT8wYz', projectId: P1 };
const P2_SESSION: OpenSession = { id: '5hJ2dF6gK9nM1qW4eR7tY', projectId: P2 };

/** The proposal held in P1, and the one held in P2. */
const I1 = '7f3a91c2-1d4e-4a6b-8c9d-0e1f2a3b4c5d';
const I2 = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';

/** A proposal held against `projectId` that adds one criterion — decidable, as a fresh one is. */
function held(projectId: string, intentId: string, text: string): PendingCriteriaDecisionRow {
  const wording = { text, verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null };
  return {
    intentId,
    projectId,
    commitToken: `token-${intentId}`,
    actionDigest: 'a'.repeat(64),
    filedAt: '2026-09-10T14:00:00.000Z',
    ageSeconds: 5 * 60,
    baselineSeal: SEAL,
    currentSeal: SEAL,
    proposed: [{ id: null, ordinal: 1, ...wording }],
    diff: {
      entries: [
        {
          change: 'NEW',
          definitionId: null,
          ordinal: 1,
          proposed: wording,
          onRecord: null,
          changed: [],
          rewrites: [],
        },
      ],
      sameCount: 0,
      changedCount: 0,
      newCount: 1,
      removedCount: 0,
    },
    supersededIntentId: null,
    decidability: { decidable: true, refusal: null, requiredAction: null },
  };
}

function queue(projectId: string, rows: PendingCriteriaDecisionRow[]): PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-10T14:05:00.000Z',
    projectId,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    decidableCount: rows.filter((each) => each.decidability.decidable).length,
    pending: rows,
  };
}

/** Each project's pending read, at the path `pendingCriteriaDecisionsQuery` asks for it. */
const READS: Record<string, PendingCriteriaDecisionQueue> = {
  [`/projects/${P1}/acceptance/criteria-decisions/pending`]:
    queue(P1, [held(P1, I1, 'the merge boundary may be called green without running it')]),
  [`/projects/${P2}/acceptance/criteria-decisions/pending`]:
    queue(P2, [held(P2, I2, 'the pg spec may be skipped')]),
};

/** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
function workspaceViewSource(): string {
  const found = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
    .map((each) => resolve(process.cwd(), each))
    .find(existsSync);
  if (!found) throw new Error(`WorkspaceView.tsx is not under ${process.cwd()}`);
  return readFileSync(found, 'utf8');
}

/**
 * The key WorkspaceView mounts the card with, as the expression written on its element — or null
 * when the element carries none, which leaves one instance for every session the view shows.
 */
function mountedKey(): string | null {
  const source = workspaceViewSource();
  const at = source.indexOf('<SessionCriteriaDecisionCard');
  expect(at, 'WorkspaceView does not mount the card at all').toBeGreaterThan(-1);
  // Once: a second, keyed mount would satisfy this scan while the first one stayed unkeyed.
  expect(source.split('<SessionCriteriaDecisionCard').length - 1).toBe(1);
  const element = source.slice(at, source.indexOf('/>', at));
  return /\bkey=\{([^}]*)\}/u.exec(element)?.[1]?.trim() ?? null;
}

/**
 * The conversation pane as WorkspaceView composes it, for the session on screen. `selectedId` is
 * that session's id; any other key expression is one this harness would be guessing at.
 */
function pane(qc: QueryClient, session: OpenSession): JSX.Element {
  const key = mountedKey();
  expect([null, 'selectedId'], `WorkspaceView keys the card with {${key}}`).toContain(key);
  return (
    <QueryClientProvider client={qc}>
      <SessionCriteriaDecisionCard
        key={key === 'selectedId' ? session.id : undefined}
        projectId={session.projectId}
      />
    </QueryClientProvider>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const clients: QueryClient[] = [];

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  for (const qc of clients.splice(0)) qc.clear();
  vi.mocked(api).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The view, mounted once: `open` shows another session in the same tree, as navigation does. */
function workspace(): { node: HTMLElement; open: (session: OpenSession) => Promise<void> } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api).mockImplementation((async (path: string) => {
    const read = READS[path];
    if (!read) throw new Error(`nothing is stubbed at ${path}`);
    return read;
  }) as unknown as typeof api);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  clients.push(qc);
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  const tree = createRoot(node);
  root = tree;
  return {
    node,
    open: async (session) => {
      await act(async () => tree.render(pane(qc, session)));
    },
  };
}

/** The DOM id a card is drawn under: its proposal's address. */
function cardOf(intentId: string): string {
  return `criteria-decision-${intentId}`;
}

/** Every card on screen, by address, in render order. */
function drawn(node: HTMLElement): string[] {
  return [...node.querySelectorAll('.criteria-decision')].map((card) => card.id);
}

/** What one card's heading says: the question, or that it is no longer the reader's to answer. */
function headingOf(node: HTMLElement, intentId: string): string | null {
  return (
    node.querySelector(`[id="${cardOf(intentId)}"] .criteria-decision-heading`)?.textContent ?? null
  );
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

describe('the criteria card when the view moves from one project’s conversation to another’s', () => {
  it('draws P1’s held proposal in P1’s coordinator conversation', async () => {
    // The positive control, on the fixture the next case navigates away from.
    const view = workspace();
    await view.open(P1_COORDINATOR);
    await until(() => drawn(view.node).length > 0, 'P1’s read to be drawn');
    expect(drawn(view.node)).toEqual([cardOf(I1)]);
    expect(headingOf(view.node, I1)).toBe(CRITERIA_DECISION_HEADING);
  });

  it('draws none of P1’s proposals in P2’s conversation, only P2’s own', async () => {
    const view = workspace();
    await view.open(P1_COORDINATOR);
    await until(() => drawn(view.node).includes(cardOf(I1)), 'P1’s proposal in P1’s conversation');

    await view.open(P2_SESSION);
    // P2's own card is the proof that P2's read came back and the pane drew from it, so what is
    // asserted under it is about cards derived against P2's queue, not ones still waiting on it.
    await until(() => drawn(view.node).includes(cardOf(I2)), 'P2’s proposal in P2’s conversation');
    expect(drawn(view.node), 'a proposal of P1’s is drawn in P2’s conversation')
      .toEqual([cardOf(I2)]);
    expect(view.node.textContent).not.toContain(CRITERIA_DECISION_STALE_HEADING);
  });

  it('is keyed by the session on screen, on the element WorkspaceView mounts it with', () => {
    // The pane above takes its key from this same element; this case names the reason when it
    // goes. Read as text, as `WorkspaceView.decisionStrip.test.tsx` reads the strip's mount, because
    // the view will not render without a router, a runner and a live session.
    expect(mountedKey(), 'WorkspaceView mounts the card with no key').toBe('selectedId');
  });
});
