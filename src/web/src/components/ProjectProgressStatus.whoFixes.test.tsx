// @vitest-environment jsdom
import type { JSX } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLifecycleState, type OpenItemFacts, type ProjectOpenItemRow } from '@orbit/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ALREADY_SETTLED,
  BRANCH_UNCHANGED_LINE,
  ASK_AGAIN_ONCE_BACK,
  CANCEL_TASK_SETTLED_CONSEQUENCE,
  CHAT_FIRST_LINK,
  CLOSES_BY_ITSELF,
  ESCALATED_REACHABLE_HEADING,
  ESCALATED_UNREACHABLE_HEADING,
  FIX_IT_MYSELF,
  ItemAsCard,
  MARK_HANDLED_SETTLED_CONSEQUENCE,
  WHO_FIXES_IT,
  askAgainFreshClock,
  coordinatorRowNote,
  coordinatorRowPresses,
  coordinatorRowSentence,
  readCoordinatorCause,
  whoFixesHeading,
  type CoordinatorCause,
} from './ProjectProgressStatus';
import type { CoordinatorStatus } from './ProjectCoordinatorCard';
import { CHANGE_COPY } from '../lib/coordinatorWorkspace';
import { CHAT_ABOUT_THIS } from '../lib/coordinatorChat';
import { projectCoordinatorStatusQuery, projectDetailsQuery, workspacesQuery } from '../lib/queries';

/**
 * The owner exception card organised around "Who fixes it?" (board
 * docs/mocks/owner-exception-who-fixes, D1–D4 = A): the heading and the coordinator row for every
 * cause board part 6 tabulates, the two-step repair, the chat link, the one clock, the hand-over's
 * lead, the line about how it ends and the folded Details.
 */

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const PROJECT_ID = '35aK2xQm8LrT0vHcE1pZq';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const FILES = [
  'src/webhooks/sender.ts',
  'src/webhooks/sender.test.ts',
  'src/webhooks/retry-policy.ts',
  'src/queue/backoff.ts',
  'src/queue/backoff.test.ts',
  'src/config/defaults.ts',
  'docs/webhooks.md',
  'package.json',
  'package-lock.json',
];

function facts(over: Partial<OpenItemFacts> = {}): OpenItemFacts {
  return {
    task: { id: '35aTask00000000000001', title: 'Retry failed webhook deliveries' },
    targetRef: 'refs/heads/project/35aK2xQm8LrT0vHcE1pZq',
    targetSha: '9f3c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
    files: FILES,
    nothingLanded: false,
    check: null,
    branchUnchanged: false,
    errorCode: null,
    failure: null,
    ...over,
  };
}

/** Board ②'s escalated merge conflict: 3h 1m waiting, 2h 56m of it with the coordinator. */
function conflict(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '35aItem0000000000000001',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict: Retry failed webhook deliveries',
    detailLine: '9 files conflict with project/35aK2xQm',
    assignee: 'OWNER',
    assigneeReason: 'ESCALATED',
    waitingSince: at(3 * HOUR + MINUTE),
    escalateAt: null,
    escalatedAt: at(5 * MINUTE),
    taskId: '35aTask00000000000001',
    sessionId: '35aSession000000000001',
    landingSessionId: '35aLanding00000000001',
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: '35aCoord0000000000001', at: at(3 * HOUR) },
    actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'OPEN_LANDING', 'CANCEL_TASK'],
    question: null,
    facts: facts(),
    chat: { sessionId: '35aCoord0000000000001', stage: 'WITH_OWNER', refusal: null },
    coordinatorUnreachable: false,
    ...over,
  };
}

const UNREACHABLE: Partial<ProjectOpenItemRow> = {
  actions: ['OPEN_TASK_SESSION', 'OPEN_LANDING', 'CANCEL_TASK'],
  coordinatorUnreachable: true,
  chat: { sessionId: '35aCoord0000000000001', stage: 'WITH_OWNER', refusal: 'COORDINATOR_UNAVAILABLE' },
};

function status(
  state: CoordinatorStatus['state'],
  over: { refusalDetail?: CoordinatorStatus['openability']['refusalDetail']; completed?: boolean } = {},
): CoordinatorStatus {
  return {
    projectId: PROJECT_ID,
    readAt: new Date(NOW).toISOString(),
    state,
    coordination: {
      sessionId: state === 'NEVER_OPENED' ? null : '35aCoord0000000000001',
      sessionIdAbsentReason: null,
      session: state === 'LIVE'
        ? {
            id: '35aCoord0000000000001',
            title: 'Coordinator',
            runStatus: 'FAILED',
            runState: 'FAILED',
            lifecycleState: over.completed ? SessionLifecycleState.COMPLETED : SessionLifecycleState.OPEN,
            filingState: 'OPEN',
            endReason: null,
            startedAt: null,
            finishedAt: null,
            completedAt: null,
            deletedAt: null,
            engineTurnActive: false,
            pendingApprovals: 0,
          } as unknown as NonNullable<CoordinatorStatus['coordination']['session']>
        : null,
      sessionAbsentReason: null,
      coordinatorGeneration: '0',
      workspaceId: state === 'NEVER_OPENED' ? null : '35aWorkspace0000000001',
      workspaceIdAbsentReason: null,
      workspaceName: state === 'NEVER_OPENED' ? null : 'mac-mini',
      workspaceNameAbsentReason: null,
      agentId: null,
      agentIdAbsentReason: null,
      agentName: null,
      agentNameAbsentReason: null,
    },
    openability: {
      canOpen: state !== 'UNAVAILABLE',
      willCreate: false,
      refusalCode: state === 'UNAVAILABLE' ? 'COORDINATOR_UNAVAILABLE' : null,
      refusalDetail: over.refusalDetail ?? null,
      refusalCodeAbsentReason: null,
      requiredAction: null,
      requiredActionAbsentReason: null,
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: null,
        workspaceName: null,
        workspaceNameAbsentReason: null,
        agentId: null,
        agentName: null,
        fixed: true,
      },
    },
  };
}

function seeded(
  coordinator: CoordinatorStatus | null,
  workspaces: Array<{ id: string; enabled?: boolean; runnerId?: string | null }> = [],
): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectDetailsQuery(PROJECT_ID).queryKey, {
    id: PROJECT_ID,
    title: 'Checkout v2',
    exceptionEscalationSeconds: 7_200,
  } as { id: string; title: string });
  if (coordinator) qc.setQueryData(projectCoordinatorStatusQuery(PROJECT_ID).queryKey, coordinator);
  qc.setQueryData(workspacesQuery().queryKey, workspaces);
  return qc;
}

function card(row: ProjectOpenItemRow, qc: QueryClient = seeded(null), onChat?: () => void): JSX.Element {
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} onChat={onChat} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function dom(row: ProjectOpenItemRow, qc?: QueryClient, onChat?: () => void): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(card(row, qc, onChat)), 'text/html');
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const coordinatorRow = (doc: Document) => doc.querySelector('[data-who="coordinator"]');
const youRow = (doc: Document) => doc.querySelector('[data-who="you"]');
const buttons = (el: Element | null) => [...(el?.querySelectorAll('button') ?? [])].map((b) => ({
  label: text(b),
  primary: b.className.includes('primary'),
  link: b.className.includes('link') || b.className.includes('quiet') || b.className.includes('chat-first'),
}));

/** Board part 6, one row per cause: the heading, the status sentence, and the row's presses. */
const PART_6: Array<{
  cause: CoordinatorCause;
  row: ProjectOpenItemRow;
  qc: () => QueryClient;
  heading: string;
  sentence: string;
  presses: string[];
  leads: string | null;
}> = [
  {
    cause: 'WORKSPACE_DISABLED',
    row: conflict(UNREACHABLE),
    qc: () => seeded(status('LIVE'), [{ id: '35aWorkspace0000000001', enabled: false, runnerId: 'r1' }]),
    heading: 'Now yours — the coordinator can’t take messages',
    sentence: 'Its workspace mac-mini is disabled, so it can’t take messages.',
    presses: ['Enable mac-mini', CHANGE_COPY.button],
    leads: 'Enable mac-mini',
  },
  {
    cause: 'WORKSPACE_TRASHED',
    row: conflict(UNREACHABLE),
    qc: () => seeded(status('UNAVAILABLE', { refusalDetail: 'WORKSPACE_TRASHED' })),
    heading: 'Now yours — the coordinator can’t take messages',
    sentence: 'Its workspace mac-mini is in Trash, so it can’t take messages.',
    presses: ['Restore mac-mini', CHANGE_COPY.button],
    leads: 'Restore mac-mini',
  },
  {
    cause: 'WORKSPACE_UNBOUND',
    row: conflict(UNREACHABLE),
    qc: () => seeded(status('UNAVAILABLE', { refusalDetail: 'WORKSPACE_UNBOUND' })),
    heading: 'Now yours — the coordinator can’t take messages',
    sentence: 'Its workspace mac-mini isn’t bound to a runner.',
    presses: ['Bind mac-mini to a runner', CHANGE_COPY.button],
    leads: 'Bind mac-mini to a runner',
  },
  {
    cause: 'RUNNER_DOWN',
    row: conflict(UNREACHABLE),
    qc: () => seeded(status('LIVE'), [{ id: '35aWorkspace0000000001', enabled: true, runnerId: 'r1' }]),
    heading: 'Now yours — the coordinator can’t take messages',
    sentence: 'Its runner is offline. Ask again comes back here as soon as it is.',
    presses: [CHANGE_COPY.button],
    leads: null,
  },
  {
    cause: 'COORDINATOR_ENDED',
    row: conflict({ ...UNREACHABLE, assigneeReason: 'COORDINATOR_ENDED' }),
    qc: () => seeded(status('LIVE', { completed: true })),
    heading: 'Now yours — the coordinator conversation ended',
    sentence: 'Its conversation was completed.',
    presses: ['Start a new coordinator'],
    leads: 'Start a new coordinator',
  },
  {
    cause: 'NO_COORDINATOR',
    row: conflict({
      ...UNREACHABLE,
      assigneeReason: 'NO_COORDINATOR',
      chat: { sessionId: null, stage: 'WITH_OWNER', refusal: 'NO_COORDINATOR' },
    }),
    qc: () => seeded(status('NEVER_OPENED')),
    heading: 'Now yours — this project has no coordinator',
    sentence: 'This project isn’t coordinated.',
    presses: ['Set up a coordinator…'],
    leads: 'Set up a coordinator…',
  },
  {
    cause: 'ESCALATED',
    row: conflict(),
    qc: () => seeded(null),
    heading: 'Now yours — the coordinator didn’t get to it',
    sentence: 'Reachable. It had this for 2h 56m and didn’t get to it.',
    presses: ['Ask the coordinator again', CHAT_FIRST_LINK],
    leads: 'Ask the coordinator again',
  },
  {
    cause: 'HANDED_OVER',
    row: conflict({ assigneeReason: 'HANDED_OVER', handoverNote: 'The conflict is in your retry policy' }),
    qc: () => seeded(null),
    heading: 'Now yours — the coordinator handed it over',
    sentence: 'It handed this to you on purpose.',
    presses: ['Ask the coordinator again', CHAT_FIRST_LINK],
    leads: null,
  },
];

describe('board part 6: the heading and the coordinator row follow the live cause', () => {
  for (const c of PART_6) {
    it(`${c.cause}: “${c.heading}” · “${c.sentence}” · ${c.presses.join(' / ')}`, () => {
      const doc = dom(c.row, c.qc(), () => {});
      const node = doc.querySelector('.project-open-item-card');
      expect(node?.getAttribute('data-cause')).toBe(c.cause);
      expect(text(doc.querySelector('.project-open-item-heading'))).toBe(c.heading);
      expect(text(coordinatorRow(doc)?.querySelector('.project-open-item-who-status'))).toBe(c.sentence);
      const presses = buttons(coordinatorRow(doc)?.querySelector('.project-open-item-who-presses') ?? null);
      expect(presses.map((p) => p.label)).toEqual(c.presses);
      expect(presses.find((p) => p.primary)?.label ?? null).toBe(c.leads);
      // The pure reading says the same thing as the drawn card.
      expect(whoFixesHeading(c.cause)).toBe(c.heading);
    });
  }

  it('the workspace name is drawn in bold inside the sentence', () => {
    const doc = dom(conflict(UNREACHABLE), PART_6[0].qc());
    expect(text(coordinatorRow(doc)?.querySelector('.project-open-item-who-status b'))).toBe('mac-mini');
  });

  it('without a status read yet, the row alone decides — and never claims a workspace it has not read', () => {
    expect(readCoordinatorCause(conflict(UNREACHABLE)).cause).toBe('RUNNER_DOWN');
    expect(readCoordinatorCause(conflict({ ...UNREACHABLE, assigneeReason: 'COORDINATOR_ENDED' })).cause)
      .toBe('COORDINATOR_ENDED');
    expect(readCoordinatorCause(conflict({ ...UNREACHABLE, coordinatorUnreachable: false })).cause)
      .toBe('COORDINATOR_ENDED');
    const disabledNoName = { cause: 'WORKSPACE_DISABLED' as const, workspaceId: null, workspaceName: null };
    expect(coordinatorRowSentence(conflict(), disabledNoName)).toBe('Its workspace is disabled, so it can’t take messages.');
    expect(coordinatorRowPresses(disabledNoName)).toEqual([{ kind: 'CHANGE_WORKSPACE', tier: 'secondary' }]);
  });

  it('a hand-over with no note still says it was on purpose', () => {
    expect(coordinatorRowSentence(conflict({ assigneeReason: 'HANDED_OVER' }), {
      cause: 'HANDED_OVER', workspaceId: null, workspaceName: null,
    })).toBe('It handed this to you on purpose.');
  });

  it('Ask again’s note names the project’s own window, as the board does, and keeps the door’s sentence without it', () => {
    const reachable = dom(conflict());
    expect(text(coordinatorRow(reachable)?.querySelector('.project-open-item-consequence')))
      .toBe('It goes back to the coordinator with a fresh 2h clock.');
    const reading = { cause: 'ESCALATED' as const, workspaceId: null, workspaceName: null };
    expect(coordinatorRowNote(conflict(), reading, null))
      .toBe('It goes back to the coordinator with a fresh escalation clock.');
    expect(askAgainFreshClock(5_400)).toBe('It goes back to the coordinator with a fresh 1h 30m clock.');
  });

  it('the reachable ESCALATED heading carries no number', () => {
    expect(ESCALATED_REACHABLE_HEADING).not.toMatch(/\d/);
    expect(ESCALATED_UNREACHABLE_HEADING).toBe('Now yours — the coordinator can’t take messages');
  });
});

describe('D1–D4 = A', () => {
  it('D1: a repair press repairs the coordinator only — Ask again is not drawn until it is back', () => {
    const doc = dom(conflict(UNREACHABLE), PART_6[0].qc());
    const all = buttons(doc.querySelector('.project-open-item-card')).map((b) => b.label);
    expect(all).toContain('Enable mac-mini');
    expect(all).not.toContain('Ask the coordinator again');
    expect(text(coordinatorRow(doc))).toContain(ASK_AGAIN_ONCE_BACK);
    // Once the server reads it askable, the same card is the reachable one, in place.
    const back = dom(conflict(), PART_6[0].qc());
    expect(back.querySelector('.project-open-item-card')?.getAttribute('data-cause')).toBe('ESCALATED');
    expect(buttons(coordinatorRow(back)).map((b) => b.label)).toContain('Ask the coordinator again');
  });

  it('D2: no greyed Chat about this when unreachable; “or Chat about this first” beside Ask again when reachable', () => {
    const unreachable = renderToStaticMarkup(card(conflict(UNREACHABLE), PART_6[0].qc()));
    expect(unreachable).not.toContain(CHAT_ABOUT_THIS);
    expect(unreachable).not.toContain('disabled=""');
    const reachable = dom(conflict(), seeded(null), () => {});
    const labels = buttons(coordinatorRow(reachable)).map((b) => b.label);
    expect(labels).toEqual(['Ask the coordinator again', 'or Chat about this first']);
    expect(reachable.querySelector('.project-open-item-chat')).toBeNull();
  });

  it('D3: one clock — the total wait from waitingSince at the top right, and no footer', () => {
    const doc = dom(conflict());
    expect(text(doc.querySelector('.project-open-item-head .project-open-item-clock'))).toBe('waiting 3h 1m');
    expect(doc.querySelector('.project-open-item-foot')).toBeNull();
    const html = renderToStaticMarkup(card(conflict()));
    expect(html).not.toContain('Owner: you');
    expect(html).not.toContain('came to the owner');
  });

  it('D4: HANDED_OVER leads with “You · Fix it myself”; ESCALATED still leads with Ask again', () => {
    const handed = dom(conflict({ assigneeReason: 'HANDED_OVER' }));
    const rows = [...handed.querySelectorAll('.project-open-item-who-row')].map((r) => r.getAttribute('data-who'));
    expect(rows).toEqual(['you', 'coordinator']);
    expect(buttons(youRow(handed))[0]).toMatchObject({ label: FIX_IT_MYSELF, primary: true });
    expect(buttons(coordinatorRow(handed))[0]).toMatchObject({ label: 'Ask the coordinator again', primary: false });

    const escalated = dom(conflict());
    expect([...escalated.querySelectorAll('.project-open-item-who-row')].map((r) => r.getAttribute('data-who')))
      .toEqual(['coordinator', 'you']);
    expect(buttons(coordinatorRow(escalated))[0]).toMatchObject({ label: 'Ask the coordinator again', primary: true });
    expect(buttons(youRow(escalated))[0]).toMatchObject({ label: FIX_IT_MYSELF, primary: false });
  });
});

describe('board part 2: the card around them', () => {
  it('heading, subline, WHO FIXES IT?, the line about how it ends, Details folded, Already settled?', () => {
    const doc = dom(conflict());
    expect(text(doc.querySelector('.project-open-item-subline')))
      .toBe('Merge conflict · Retry failed webhook deliveries → Checkout v2');
    expect(text(doc.querySelector('.project-open-item-who-label'))).toBe(WHO_FIXES_IT);
    expect(text(youRow(doc))).toContain('Opens the task session. Fix the conflict there and push to the task branch.');
    expect(text(doc.querySelector('.project-open-item-closes'))).toBe(`✓ ${CLOSES_BY_ITSELF}`);
    expect(text(doc.querySelector('.project-open-item-details-toggle'))).toBe('▸Details · 9 files · Open landing');
    // Folded: none of the raw facts are on the card.
    expect(doc.body.textContent).not.toContain('src/webhooks/sender.ts');
    expect(doc.body.textContent).not.toContain('After a fix');
    expect(doc.body.textContent).not.toContain('refs/heads/');
    const settled = doc.querySelector('.project-open-item-settled');
    expect(text(settled?.querySelector('.project-open-item-settled-label'))).toBe(ALREADY_SETTLED);
    expect(text(settled)).toContain(MARK_HANDLED_SETTLED_CONSEQUENCE);
    expect(text(settled)).toContain(CANCEL_TASK_SETTLED_CONSEQUENCE);
    expect(buttons(settled ?? null).map((b) => b.label)).toEqual(['Mark as handled', 'Cancel task']);
    expect(settled?.querySelector('.is-danger')).not.toBeNull();
  });

  it('“Closes by itself” only on an integration item with a task branch', () => {
    for (const kind of ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] as const) {
      expect(dom(conflict({ kind })).querySelector('.project-open-item-closes'), kind).not.toBeNull();
    }
    expect(dom(conflict({ kind: 'TASK_FAILED' })).querySelector('.project-open-item-closes')).toBeNull();
    expect(dom(conflict({ kind: 'DELIVERY_REVIEW' })).querySelector('.project-open-item-closes')).toBeNull();
    // A candidate's failed check has no task branch to push a fix to.
    expect(
      dom(conflict({ kind: 'INTEGRATION_CHECK_FAILED', taskId: null, promotionId: '35aPromo0000000000001' }))
        .querySelector('.project-open-item-closes'),
    ).toBeNull();
  });

  it('Details unfolds into Into (project + short ref, as the board draws project/35aK2xQm…), five files and “and 4 more”, Came to you, Open landing', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(card(conflict())));
    const toggle = host.querySelector<HTMLButtonElement>('.project-open-item-details-toggle')!;
    await act(async () => toggle.click());
    const body = text(host.querySelector('.project-open-item-details-body'));
    expect(body).toContain('Checkout v2’s branch project/35aK2xQm… at 9f3c2e1');
    expect(body).toContain('Files (9)');
    expect(body).toContain(
      'src/webhooks/sender.ts · src/webhooks/sender.test.ts · src/webhooks/retry-policy.ts · src/queue/backoff.ts · src/queue/backoff.test.ts and 4 more',
    );
    expect(body).not.toContain('src/config/defaults.ts');
    expect(body).toContain('Came to you');
    expect(body).toContain('after 2h 56m with the coordinator');
    expect(body).toContain('Open landing — every attempt, step by step');
    expect(body).not.toContain('After a fix');
    await act(async () => root.unmount());
    host.remove();
  });
});

/** The facts of a failed check as the server serves them: `branchLine` is its sentence, by job kind. */
const RED_CHECK = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
  durationMs: 4 * HOUR, outputTail: '',
} as NonNullable<OpenItemFacts['check']>;
const PROJECT_LINE = 'unchanged — the project branch did not move, and nothing reached main';
const CANDIDATE_LINE = 'unchanged — this task’s branch did not move, and nothing on it reached main';

/** A failed check's card, with Details unfolded: the text of its Branch row. */
async function branchRowOf(row: ProjectOpenItemRow): Promise<string> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(card(row)));
  await act(async () => host.querySelector<HTMLButtonElement>('.project-open-item-details-toggle')!.click());
  const rows = [...host.querySelectorAll('.project-open-item-details-body .project-open-item-fact')];
  const found = rows.find((r) => text(r.querySelector('.criteria-decision-k')) === 'Branch');
  const branch = found ? `Branch ${text(found.querySelector('.criteria-decision-v'))}` : '';
  await act(async () => root.unmount());
  host.remove();
  return branch;
}

describe('the Branch fact says what is true for the job the check failed in', () => {
  const promotion = (branchLine: string | undefined) => conflict({
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: merging the project branch into main',
    taskId: null,
    promotionId: '35aPromo0000000000001',
    facts: facts({ task: null, targetRef: null, targetSha: null, files: [], check: RED_CHECK, branchUnchanged: true, branchLine }),
  });

  it('a project-branch promotion check: the project branch did not move and nothing reached main', async () => {
    const line = await branchRowOf(promotion(PROJECT_LINE));
    expect(line).toBe(`Branch ${PROJECT_LINE}`);
    expect(line).not.toContain('passed on its own branch');
  });

  it('a TASK_BRANCH promotion candidate: that task’s branch and main', async () => {
    const line = await branchRowOf(promotion(CANDIDATE_LINE));
    expect(line).toBe(`Branch ${CANDIDATE_LINE}`);
    expect(line).not.toContain('passed on its own branch');
  });

  it('a LAND_TASK check keeps the task-branch sentence', async () => {
    const row = conflict({
      kind: 'INTEGRATION_CHECK_FAILED',
      facts: facts({ check: RED_CHECK, branchUnchanged: true, branchLine: BRANCH_UNCHANGED_LINE }),
    });
    expect(await branchRowOf(row)).toBe(
      'Branch unchanged — the task passed on its own branch; it fails only on the combined tree',
    );
  });

  it('a server older than branchLine leaves the task-branch sentence, and an unchanged-less item draws no row', async () => {
    expect(await branchRowOf(promotion(undefined))).toBe(`Branch ${BRANCH_UNCHANGED_LINE}`);
    const none = conflict({ kind: 'INTEGRATION_CHECK_FAILED', facts: facts({ check: RED_CHECK }) });
    expect(await branchRowOf(none)).toBe('');
  });
});
