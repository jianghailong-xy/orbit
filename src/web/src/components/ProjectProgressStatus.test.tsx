// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CoordinatorFuseUsage, CoordinatorWakeups, ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorProgressRows,
  ProjectExceptionCards,
  ProjectOpenItems,
} from './ProjectProgressStatus';
import { projectOpenItemsQuery } from '../lib/queries';

/**
 * What a project still owes somebody, on the project page and in its coordinator's own conversation
 * (mocks 2 ②, 5 and 6 ①; contract §7.2 V5 / V7, §7.5).
 *
 * Static renders for what is drawn, because that is what these assertions are about: an item's
 * owner, how long it has waited, when it stops being the coordinator's, and which press it offers.
 * jsdom only for the one press that reaches a door — Resume.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function inFuture(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function item(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '3mZLAZL3OvQix77hxsBQYH',
    kind: 'TASK_FAILED',
    title: 'Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）',
    detailLine:
      'The acceptance command disagreed with what the task declared · exit 1, expected 0'
      + ' · attempt 2 of 3 in this chain',
    assignee: 'COORDINATOR',
    assigneeReason: 'DEFAULT',
    waitingSince: at(118 * MINUTE),
    escalateAt: inFuture(2 * MINUTE),
    escalatedAt: null,
    taskId: '34OEE9DwfWYjo3aRFuBgo',
    sessionId: '6XUcYl0KepT3lwbwsCe40k',
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: '34OAa5LxnQ1JXpUOfN21W', at: at(117 * MINUTE) },
    actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
    question: null,
    ...over,
  };
}

const CONFLICT = item({
  itemId: '4Cni9q41xFEqJovhFRs5a',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: runner 托管作业支持「事件发生时叫醒会话」',
  detailLine: '3 files conflict with project/bg-jobs · nothing landed',
  waitingSince: at(18 * MINUTE),
  escalateAt: inFuture(102 * MINUTE),
});

const CHECK_FAILED = item({
  itemId: '2Ae0EwGDfgvMRtD6k76fP0',
  kind: 'INTEGRATION_CHECK_FAILED',
  title: 'Checks failed on the combined tree: 核实 ScheduleWakeup 是否随 warm 回收丢失',
  detailLine: 'go test exited 1 after 5m 40s · TestScheduleWakeupSurvivesWarmEviction',
  waitingSince: at(5 * MINUTE),
  escalateAt: inFuture(115 * MINUTE),
});

const QUESTION = item({
  itemId: '6opx8CVdFgBrOcmNXo9J7Q',
  kind: 'COORDINATOR_QUESTION',
  title: 'Coordinator asks: start t4 first, or run t4 and t7 together?',
  detailLine: 'Blocks 2 tasks · If nobody answers: nothing starts',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  waitingSince: at(35 * MINUTE),
  escalateAt: null,
  taskId: null,
  sessionId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['ANSWER'],
  question: {
    question: 't4 and t7 both change session_pool.go. Which first?',
    options: [{ label: 'Start t4 first, then t7 once t4 lands' }, { label: 'Hold both' }],
    recommendedOption: 0,
    blocksTaskIds: ['34OEE9TjocXaJeuD11UVz', '34OEE9VaYqm6pXhYAEq8B'],
    ifUnanswered: 'nothing starts',
  },
});

const ESCALATED = item({
  itemId: 'Pamt8Lq7mr2MGZV41pKTo',
  kind: 'TASK_FAILED',
  title: 'Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）',
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: at(2 * HOUR + 6 * MINUTE),
  escalateAt: at(6 * MINUTE),
  escalatedAt: at(6 * MINUTE),
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  // What the server lists for an escalated task item (§4.7): the way back to the coordinator that
  // should have had it, the run, and stopping the task — and no `RETRY`, because the work is the
  // coordinator's to run again, not the owner's.
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
});

const PAUSED = item({
  itemId: '6fWujE4NBkVyzMWkL975oc',
  kind: 'FUSE_PAUSED',
  title: 'The coordinator paused itself',
  detailLine:
    'It started 31 turns on its own today — the limit is 30. '
    + 'Spent today: 31 self-started turns · 4 sessions opened · 0 retries on one chain. '
    + 'Tasks keep running and landing; task results, merges and your answers still reach it. '
    + '3 things it would have started are on hold, and they go out as soon as you resume. '
    + 'What it starts inside its own engine cannot be held: those turns are counted, not held.',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  waitingSince: at(4 * MINUTE),
  escalateAt: null,
  escalatedAt: null,
  taskId: null,
  sessionId: null,
  fuseEpisodeId: '5Grmtl4G1LatjDDEmX492i',
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['RESUME'],
});

const PROMOTION = item({
  itemId: 'GGONnllUvG4Ph8tADpZQZ',
  kind: 'PROMOTION_APPROVAL',
  title: 'Approve merge to main',
  detailLine: 'project/bg-jobs → main · 4 tasks · 7 commits · checks passed on the combined tree',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  waitingSince: at(2 * HOUR + 10 * MINUTE),
  escalateAt: null,
  taskId: null,
  sessionId: null,
  promotionId: '3fFMHLbE7JTsr3vHFOzIDM',
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['REVIEW'],
});

function client(items: { needsYou: ProjectOpenItemRow[]; withCoordinator: ProjectOpenItemRow[] }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, items);
  return qc;
}

function paint(
  items: { needsYou: ProjectOpenItemRow[]; withCoordinator: ProjectOpenItemRow[] },
  ui: (qc: QueryClient) => JSX.Element,
): string {
  const qc = client(items);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui(qc)}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const STANDING = {
  needsYou: [PROMOTION, QUESTION, ESCALATED],
  withCoordinator: [CONFLICT, CHECK_FAILED],
};

describe('ProjectOpenItems — the project page’s Open items card', () => {
  it('renders open items in two groups with owner, waiting time and escalation', () => {
    const html = paint(STANDING, () => <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />);

    expect(html).toContain('Open items');
    expect(html).toContain('3 need you · 2 with the coordinator · oldest first');

    // The two groups, in the order the card puts them in.
    expect(html.indexOf('Needs you')).toBeGreaterThan(-1);
    expect(html.indexOf('With the coordinator')).toBeGreaterThan(html.indexOf('Needs you'));

    // The owner's group: each row says it is theirs and how long it has been.
    expect(html).toContain('Approve merge to main');
    expect(html).toContain('project/bg-jobs → main · 4 tasks · 7 commits · checks passed');
    expect(html).toContain('waiting 2h 10m');
    expect(html).toContain('Coordinator asks: start t4 first, or run t4 and t7 together?');
    expect(html).toContain('waiting 35m');
    // An escalated item says WHEN it became the owner's, not merely that it is waiting.
    expect(html).toContain('escalated 6m ago');

    // The coordinator's group: how long it has had it, and when it stops being its problem.
    expect(html).toContain('Merge conflict: runner 托管作业支持「事件发生时叫醒会话」');
    expect(html).toContain('3 files conflict with project/bg-jobs · nothing landed');
    expect(html).toContain('18m · goes to you in 1h 42m');
    expect(html).toContain('5m · goes to you in 1h 55m');

    // Who has it, in the words the mock uses for each group.
    expect(html.match(/>You</g) ?? []).toHaveLength(3);
    expect(html.match(/>Coordinator</g) ?? []).toHaveLength(2);

    // The one press each row offers, from the server's own `actions` — never one with no door.
    // A row is a way in (§7.2 V5): the presses that WRITE are the card's, and a row leaves them
    // out, which is why these two appear on the cards below and nowhere here.
    expect(html).toContain('Answer');
    expect(html).toContain('Open coordinator');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Cancel task');
  });

  it('opens a merge approval on the card that decides it, rather than in the row', () => {
    const html = paint(STANDING, () => <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />);

    // The row is the way in: Review points at `ProjectPromotionCard`, which the page mounts below
    // this card and which is where what would land and what the checks came to are said (§7.5).
    expect(html).toContain('Review');
    expect(html).toContain('href="#promotion-3fFMHLbE7JTsr3vHFOzIDM"');
  });

  it('renders the pause card first', () => {
    const html = paint(
      { needsYou: [PROMOTION, PAUSED], withCoordinator: [CONFLICT] },
      () => <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />,
    );

    expect(html).toContain('The coordinator paused itself');
    expect(html).toContain('It started 31 turns on its own today — the limit is 30');
    expect(html).toContain('Resume');
    // Above everything else in the card, including the older item it is drawn beside.
    expect(html.indexOf('The coordinator paused itself')).toBeLessThan(
      html.indexOf('Approve merge to main'),
    );
    // And it is a card, not one of the rows: the pause is not counted into either group's tally.
    expect(html).toContain('1 need you · 1 with the coordinator · oldest first');
  });

  it('draws nothing while nothing is open', () => {
    expect(paint(
      { needsYou: [], withCoordinator: [] },
      () => <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />,
    )).toBe('');
  });
});

describe('ProjectExceptionCards — the same items in the coordinator’s conversation', () => {
  it('draws a card for each exception with its owner, waiting time and escalation', () => {
    const html = paint(
      { needsYou: [], withCoordinator: [CONFLICT, CHECK_FAILED, item()] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    );

    expect(html).toContain('Merge conflict: runner 托管作业支持「事件发生时叫醒会话」');
    expect(html).toContain('3 files conflict with project/bg-jobs · nothing landed');
    expect(html).toContain('Checks failed on the combined tree: 核实 ScheduleWakeup 是否随 warm 回收丢失');
    expect(html).toContain('go test exited 1 after 5m 40s');
    expect(html).toContain('Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）');
    expect(html).toContain('attempt 2 of 3 in this chain');

    // The footer every exception card carries (§7.5).
    expect(html).toContain('Owner: coordinator · waiting 18m · goes to the owner in 1h 42m');
    expect(html).toContain('Owner: coordinator · waiting 1h 58m · goes to the owner in 2m');

    // It says the platform filed it, in the mark the other Orbit-filed cards use.
    expect(html.match(/FROM ORBIT/g) ?? []).toHaveLength(3);
  });

  it('says an escalated item is now yours, and why', () => {
    const html = paint(
      { needsYou: [ESCALATED], withCoordinator: [] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    );

    expect(html).toContain('Now yours — no one acted on this for 2h');
    expect(html).toContain('Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）');
    expect(html).toContain('Owner: you · waiting 2h 6m');
    expect(html).not.toContain('goes to the owner');
  });

  it('gives each other way an item became yours its own heading', () => {
    const ended = { ...ESCALATED, assigneeReason: 'COORDINATOR_ENDED' as const };
    const chain = { ...ESCALATED, assigneeReason: 'CHAIN_LIMIT' as const };
    const handed = { ...ESCALATED, assigneeReason: 'HANDED_OVER' as const };
    const draw = (row: ProjectOpenItemRow) =>
      paint({ needsYou: [row], withCoordinator: [] }, () => (
        <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />
      ));

    expect(draw(ended)).toContain('Now yours — the coordinator conversation ended');
    expect(draw(chain)).toContain('Now yours — the 3rd failure in this chain');
    expect(draw(handed)).toContain('Now yours — the coordinator handed it over');
  });

  it('draws the pause card and nothing else when only the fuse is open', () => {
    const html = paint(
      { needsYou: [PAUSED], withCoordinator: [] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    );
    expect(html).toContain('The coordinator paused itself');
    expect(html).toContain('3 things it would have started are on hold');
    expect(html).toContain('Resume');
  });

  it('leaves a merge approval to its own card, the way it leaves a question to its own', () => {
    // Drawing it here too would be two cards about one merge, and the one that says what would
    // land is the other one.
    expect(paint(
      { needsYou: [PROMOTION], withCoordinator: [] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    )).toBe('');
  });

  it('draws nothing while nothing is open', () => {
    expect(paint(
      { needsYou: [], withCoordinator: [] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    )).toBe('');
  });
});

describe('the exception cards’ presses', () => {
  function card(row: ProjectOpenItemRow): string {
    return paint(
      row.assignee === 'OWNER'
        ? { needsYou: [row], withCoordinator: [] }
        : { needsYou: [], withCoordinator: [row] },
      () => <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />,
    );
  }

  it('offers a failed task’s three presses: retry it, open the run, or stop it', () => {
    const html = card(item());

    expect(html).toContain('Retry');
    expect(html).toContain('Open task session');
    expect(html).toContain('Cancel task');
  });

  it('sends an escalated item back to its coordinator rather than retrying its work', () => {
    const html = card(ESCALATED);

    expect(html).toContain('Ask the coordinator again');
    expect(html).toContain('Open task session');
    expect(html).toContain('Cancel task');
    // The work is the coordinator's to run again (§4.7) — the owner's press is to ask, which is
    // why the server lists no RETRY on an item it escalated.
    expect(html).not.toContain('Retry');
  });

  it('leaves out a press this row carries no target for', () => {
    // An item whose task is gone — no `taskId` to run or stop. It is still readable, and the two
    // presses that need a task are not drawn rather than drawn dead.
    const orphan = item({ taskId: null, sessionId: null });

    expect(card(orphan)).not.toContain('Retry');
    expect(card(orphan)).not.toContain('Cancel task');
  });
});

describe('CoordinatorProgressRows — wake-ups and the day’s self-started turns', () => {
  function rows(
    wakeups: CoordinatorWakeups,
    fuse: CoordinatorFuseUsage,
  ): string {
    return renderToStaticMarkup(
      <CoordinatorProgressRows wakeups={wakeups} fuse={fuse} now={NOW} />,
    );
  }

  /** What a reader reads, with the elements that colour it taken away: the state word is its own
   *  span so that a returned delivery can be amber, and a sentence is still one sentence. */
  function text(html: string): string {
    return html.replace(/<[^>]*>/g, '');
  }

  it('renders wake-up delivery and self-started usage on the coordinator card', () => {
    const html = rows(
      { state: 'DELIVERED', at: at(4 * MINUTE) },
      { selfStartedToday: 6, limit: 30, paused: false, episodeId: null },
    );

    expect(html).toContain('Wake-ups');
    expect(html).toContain('delivered');
    expect(html).toContain('last 4m ago');
    expect(html).toContain('Self-started today');
    expect(html).toContain('6 of 30');
    // The meter is the same number seen as a proportion, and it is bounded by the limit.
    expect(html).toContain('width:20%');
  });

  it('tells a queued wake-up from one that was handed back, and from none at all', () => {
    expect(text(rows(
      { state: 'QUEUED', at: at(90 * 1000) },
      { selfStartedToday: 0, limit: 30, paused: false, episodeId: null },
    ))).toContain('queued · 1m ago');

    const returned = rows(
      { state: 'RETURNED', at: at(12 * MINUTE) },
      { selfStartedToday: 0, limit: 30, paused: false, episodeId: null },
    );
    expect(text(returned)).toContain('returned · 12m ago');
    // The one of the four where a delivery did not happen is the one that is marked.
    expect(returned).toContain('is-returned');

    expect(text(rows(
      { state: 'NONE', at: null },
      { selfStartedToday: 0, limit: 30, paused: false, episodeId: null },
    ))).toContain('none yet');
  });

  it('says paused rather than a proportion while the fuse is open', () => {
    const html = rows(
      { state: 'DELIVERED', at: at(4 * MINUTE) },
      { selfStartedToday: 31, limit: 30, paused: true, episodeId: '5Grmtl4G1LatjDDEmX492i' },
    );
    expect(text(html)).toContain('31 of 30 · paused');
    // Bounded at the limit: a bar past its end would be a bar nobody can read a number off.
    expect(html).toContain('width:100%');
  });

  it('says a limit nobody set is no limit rather than drawing a full meter', () => {
    const html = rows(
      { state: 'NONE', at: null },
      { selfStartedToday: 12, limit: null, paused: false, episodeId: null },
    );
    expect(text(html)).toContain('12 · no limit');
    expect(html).not.toContain('project-coordinator-meter');
  });
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  apiMock.mockReset();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  const next = createRoot(node);
  root = next;
  await act(async () => next.render(ui));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** The `atLeast`-th button wearing this label, once there are that many — what a dialog needs when
 *  its own button repeats the label of the press that opened it. Bounded, and it waits for the
 *  document rather than for a fixed number of turns, which is what an animation frame or two of
 *  portal mounting costs on a machine that is busy. */
async function buttonAppears(label: string, atLeast: number): Promise<HTMLButtonElement | undefined> {
  const found = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll('button')).filter(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement[];
  for (let turn = 0; turn < 50; turn += 1) {
    const buttons = found();
    if (buttons.length >= atLeast) return buttons.at(-1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return undefined;
}

describe('FusePauseCard — resuming', () => {
  it('resumes through the project’s own fuse door and re-reads the items', async () => {
    // Routed by path: a blanket mock answers the items read with the resume receipt, and the card
    // under test disappears before it can be pressed.
    apiMock.mockImplementation(async (path: string) =>
      path.endsWith('/open-items')
        ? { needsYou: [PAUSED], withCoordinator: [] }
        : { episodeId: PAUSED.fuseEpisodeId, resumedAt: at(0) });
    const qc = client({ needsYou: [PAUSED], withCoordinator: [] });
    await mount(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await settle();

    const resume = button('Resume');
    expect(resume).toBeTruthy();
    await act(async () => resume!.click());
    await settle();

    expect(apiMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/fuse/${PAUSED.fuseEpisodeId}/resume`,
      { method: 'POST', body: {} },
    );
  });
});

describe('the exception cards’ presses, through their doors', () => {
  /** A card, mounted, with one of its presses already made — the write each press reaches is what
   *  these are about, so the read that draws the card is stubbed and nothing else is. */
  async function press(
    items: { needsYou: ProjectOpenItemRow[]; withCoordinator: ProjectOpenItemRow[] },
    label: string,
  ): Promise<void> {
    apiMock.mockImplementation(async (path: string) =>
      String(path).endsWith('/open-items') ? items : {});
    const qc = client(items);
    await mount(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <ProjectExceptionCards projectId={PROJECT_ID} now={NOW} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await settle();

    const trigger = button(label);
    expect(trigger).toBeTruthy();
    await act(async () => trigger!.click());
    await settle();
  }

  it('retries the task through the run door every other Run press uses', async () => {
    await press({ needsYou: [], withCoordinator: [item()] }, 'Retry');

    // One press, one `triggerId`, drawn where the press happened — the same request the task list
    // and the detail panel send, so a resend of it is one run rather than a second.
    expect(apiMock).toHaveBeenCalledWith(
      `/tasks/${item().taskId}/execute`,
      { method: 'POST', body: { triggerId: expect.any(String) } },
    );
  });

  it('asks before it cancels a task, and answers with the status write', async () => {
    await press({ needsYou: [], withCoordinator: [item()] }, 'Cancel task');

    // The press alone asks. Nothing has been written while the question stands.
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toEqual([]);

    // The confirm is the last 'Cancel task' in the document: the card's press, then the modal's
    // own button, which the portal puts after it. Waited for rather than counted in turns — a
    // dialog mounts into its portal a tick or two after the press, and how many is not something
    // this test should be pinning on a loaded box.
    const confirm = await buttonAppears('Cancel task', 2);
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    await settle();

    expect(apiMock).toHaveBeenCalledWith(
      `/tasks/${item().taskId}`,
      { method: 'PATCH', body: { status: 'CANCELLED' } },
    );
  });

  it('hands an escalated item back through the project’s own door', async () => {
    await press({ needsYou: [ESCALATED], withCoordinator: [] }, 'Ask the coordinator again');

    expect(apiMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/open-items/${ESCALATED.itemId}/return-to-coordinator`,
      { method: 'POST', body: {} },
    );
  });
});
