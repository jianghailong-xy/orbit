// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOpenItemRow, ProjectPromotionView } from '@orbit/shared';
import {
  BLOCKERS_DECIDED_TOO,
  CANCEL_MERGE,
  MERGE_TO_MAIN,
  MERGING,
  NOTHING_TO_DO,
  NOT_NOW,
  OPEN_COORDINATOR,
  ProjectPromotion,
  ProjectPromotionCard,
  type PromotionProjectView,
} from './ProjectPromotionCard';
import { FROM_ORBIT } from './ProjectProgressStatus';

/**
 * The card that asks the account owner to merge a project branch into main (mock 4,
 * `docs/mocks/project-progress/04-merge-to-main.html`; contract §3.3, §3.6, §7.5).
 *
 * The four states are one card, and each is a different question: A asks, B says it is happening
 * without you, C is a receipt, D says it cannot happen yet and who is on it. What each must say is
 * asserted here in the words the mock uses, and so is the one thing a card like this must never get
 * wrong — a press that cannot succeed is disabled rather than lit and refused.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const PROMOTION_ID = '3fFMHLbE7JTsr3vHFOzIDM';
const SESSION_ID = '34OAa5LxnQ1JXpUOfN21W';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

/** The tasks mock 4's Tasks row lists, in the order the row carries them (§3.6). */
const TASK_TITLES = [
  '后台作业不再阻塞 merge/commit，merge/commit 前也不驱逐 engine',
  'runner 发版重启杀掉 runner 托管作业：有的记成 drain_cap',
  'runner 托管作业在 session 结束路径上被杀仍无终态事件',
  'warmEngineTTL 改回 4 小时',
];

/** A candidate the checks passed on: state A, and the base every other state is a variation of. */
function promotion(over: Partial<ProjectPromotionView> = {}): ProjectPromotionView {
  return {
    promotionId: PROMOTION_ID,
    state: 'READY',
    sourceKind: 'PROJECT_BRANCH',
    sourceRef: 'project/bg-jobs',
    sourceSha: '58f3a4709c1f4c2c0b0a9a1f3d7e5b6c8d9e0f12',
    upstreamRef: 'main',
    commitsAhead: 7,
    filesChanged: 18,
    taskIds: [
      '34OEE9DwfWYjo3aRFuBgo',
      '34OEE9Ftd7jJEDjbB347f',
      '34OEE9JPCk5honx7CQZSm',
      '34OEE9TjocXaJeuD11UVz',
    ],
    tasks: [
      { taskId: '34OEE9DwfWYjo3aRFuBgo', title: TASK_TITLES[0]! },
      { taskId: '34OEE9Ftd7jJEDjbB347f', title: TASK_TITLES[1]! },
      { taskId: '34OEE9JPCk5honx7CQZSm', title: TASK_TITLES[2]! },
      { taskId: '34OEE9TjocXaJeuD11UVz', title: TASK_TITLES[3]! },
    ],
    checks: [
      {
        name: 'MERGE_CHECK',
        command: 'cd src/runner-go && go test -count=1 ./...',
        expectedExitCode: 0,
        exitCode: 0,
        timedOut: false,
        durationMs: 6 * MINUTE + 12 * 1000,
        outputTail: 'ok  	orbit/runner\n',
      },
    ],
    conflicts: [],
    upstreamShaChecked: '9a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    // Mock 4's `main` row: the branch absorbed main 12 minutes ago, with nothing conflicting.
    upstream: { syncedAt: at(12 * MINUTE), conflicts: false },
    landsTreeSha: '58f3a4700000000000000000000000000000abcd',
    landsAs: 'MERGE_COMMIT',
    askedAt: at(2 * HOUR + 10 * MINUTE),
    recheckedAt: null,
    recheck: null,
    merged: null,
    ...over,
  };
}

/** The project document the card reads its criteria tally and its open-task count from (M8). */
function project(over: Partial<PromotionProjectView> = {}): PromotionProjectView {
  return {
    acceptanceCriteriaItems: [
      { ordinal: 1, satisfied: true, landing: 'ON_INTEGRATION_LINE' },
      { ordinal: 2, satisfied: true, landing: 'ON_INTEGRATION_LINE' },
      { ordinal: 3, satisfied: true, landing: 'ON_INTEGRATION_LINE' },
      { ordinal: 4, satisfied: false },
      { ordinal: 5, satisfied: false },
      { ordinal: 6, satisfied: false },
    ],
    tasksByStatus: { OPEN: 3, DONE: 4 },
    ...over,
  };
}

/** The open item the blocked card reads who-has-it and when-it-escalates from (§4.8). */
function blockedItem(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '4BLRNxGq7TOI1lIiOh4g1j',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict — project/bg-jobs cannot absorb main',
    detailLine: '2 files conflict with main · nothing landed',
    assignee: 'COORDINATOR',
    assigneeReason: 'DEFAULT',
    waitingSince: at(12 * MINUTE),
    escalateAt: new Date(NOW + 2 * HOUR).toISOString(),
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: PROMOTION_ID,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: SESSION_ID, at: at(12 * MINUTE) },
    actions: ['OPEN_COORDINATOR'],
    question: null,
    // A conflict's payload would carry its files and its target; this card draws the item only for
    // the way in it offers, so the block is not what is under test here.
    facts: null,
    ...over,
  };
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function markup(ui: JSX.Element): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client()}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

function card(
  view: ProjectPromotionView,
  over: { item?: ProjectOpenItemRow | null; project?: PromotionProjectView | null } = {},
): string {
  return markup(
    <ProjectPromotionCard
      projectId={PROJECT_ID}
      promotion={view}
      item={over.item ?? null}
      project={over.project === undefined ? project() : over.project}
      now={NOW}
    />,
  );
}

describe('state A — the checks passed and it is waiting on you', () => {
  it('says what merging would bring into main, and that it is Orbit asking', () => {
    const html = card(promotion());
    expect(html).toContain('Merge project/bg-jobs into main?');
    expect(html).toContain(FROM_ORBIT);
    expect(html).toContain('project/bg-jobs');
    expect(html).toContain('7 commits ahead of main');
  });

  it('lists the tasks this merge would bring in, by title, in the row’s own order', () => {
    const html = card(promotion());
    expect(html).toContain('4 landed on the branch');
    for (const title of TASK_TITLES) {
      expect(html).toContain(title);
    }
    const positions = TASK_TITLES.map((title) => html.indexOf(title));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('says when the branch last absorbed main, and that nothing conflicted', () => {
    const html = card(promotion());
    expect(html).toContain('synced 12m ago');
    expect(html).toContain('no conflicts');
    expect(html).not.toContain('checked against');
  });

  it('falls back to the commit the check ran against when it has never absorbed main', () => {
    const html = card(promotion({ upstream: { syncedAt: null, conflicts: false } }));
    expect(html).toContain('checked against');
    expect(html).toContain('9a1b2c3');
    expect(html).toContain('no conflicts');
    expect(html).not.toContain('synced');
  });

  it('says the checks passed on the combined tree, with the command and what it took', () => {
    const html = card(promotion());
    expect(html).toContain('Passed on the combined tree');
    expect(html).toContain('cd src/runner-go &amp;&amp; go test -count=1 ./...');
    expect(html).toContain('6m 12s');
    expect(html).toContain('no conflicts');
  });

  it('says merging does not close the project, and how many criteria this branch met', () => {
    const html = card(promotion());
    expect(html).toContain('3 of 6 met on this branch');
    expect(html).toContain('merging does not close the project');
  });

  it('says exactly which tree lands and how', () => {
    const html = card(promotion());
    expect(html).toContain('exactly the tested tree');
    expect(html).toContain('58f3a47');
    expect(html).toContain('as a merge commit');
    expect(html).toContain('18 files');
  });

  it('offers both answers, neither of them disabled, and says how long it has asked', () => {
    const html = card(promotion());
    expect(html).toContain(MERGE_TO_MAIN);
    expect(html).toContain(NOT_NOW);
    expect(html).not.toContain('disabled');
    expect(html).toContain('asked 2h 10m ago');
  });

  it('lists the blockers merging would decide along with it (B5)', () => {
    const html = card(
      promotion(),
      {
        project: project({
          blockers: {
            open: [
              {
                id: '288WS8lN2ycrqaSCZtlscB',
                kind: 'AWAITING_USER_APPROVAL',
                owner: 'USER',
                severity: 'CRITICAL',
                requiredAction: 'decide whether to accept these files',
                subjectType: 'TASK',
                subjectId: '34OEE9Ftd7jJEDjbB347f',
                subjectTitle: 'blocker 可见、带理由解除、条件消失后自动解除',
                criterionOrdinal: 3,
                criterionRevision: 1,
                detail: { reason: 'OUTSIDE_DECLARED_SCOPE' },
                firstSeenAt: at(3 * HOUR),
                resolvedAt: null,
                resolvedBy: null,
                resolutionNote: null,
              },
            ],
          },
        }),
      },
    );
    expect(html).toContain('1 blocker open on the tasks this brings in');
    expect(html).toContain(BLOCKERS_DECIDED_TOO);
    expect(html).toContain('Changed files it didn’t declare');
    expect(html).toContain('blocker 可见、带理由解除、条件消失后自动解除');
  });

  it('leaves the blockers row out when none of them is on a task this brings in', () => {
    const html = card(
      promotion(),
      {
        project: project({
          blockers: {
            open: [
              {
                id: '5ZaG7YFZ2sECMxvIJKzpL8',
                kind: 'AWAITING_USER_APPROVAL',
                owner: 'USER',
                severity: 'CRITICAL',
                requiredAction: 'decide',
                subjectType: 'TASK',
                // A task this candidate does not carry.
                subjectId: '34RDG2wELFdz9UfJ3cRGV',
                subjectTitle: 'another task entirely',
                criterionOrdinal: null,
                criterionRevision: null,
                detail: {},
                firstSeenAt: at(3 * HOUR),
                resolvedAt: null,
                resolvedBy: null,
                resolutionNote: null,
              },
            ],
          },
        }),
      },
    );
    expect(html).not.toContain('open on the tasks this brings in');
  });

  it('says a fast-forward lands as one, for a task branch on a main-line project', () => {
    const html = card(promotion({ sourceKind: 'TASK_BRANCH', landsAs: 'FAST_FORWARD' }));
    expect(html).toContain('by fast-forward');
    expect(html).not.toContain('as a merge commit');
  });
});

describe('state B — you confirmed it and main moved since the check', () => {
  const rechecking = promotion({
    state: 'RECHECKING',
    recheckedAt: at(2 * MINUTE),
    recheck: { upstreamMovedBy: 1, startedAt: at(2 * MINUTE), typicalMs: 6 * MINUTE + 12 * 1000 },
  });

  it('says how far main moved, and how long a check like this one takes', () => {
    const html = card(rechecking);
    expect(html).toContain('Merging project/bg-jobs into main…');
    expect(html).toContain('main moved 1 commit since the check');
    expect(html).toContain('re-checking the combined tree');
    expect(html).toContain('(2m of ~6m)');
  });

  it('counts the commits main moved in the plural', () => {
    const html = card(promotion({
      state: 'RECHECKING',
      recheckedAt: at(2 * MINUTE),
      recheck: { upstreamMovedBy: 3, startedAt: at(2 * MINUTE), typicalMs: 6 * MINUTE },
    }));
    expect(html).toContain('main moved 3 commits since the check');
  });

  it('says less rather than inventing a count or a typical the runner never reported', () => {
    const html = card(promotion({
      state: 'RECHECKING',
      recheckedAt: at(2 * MINUTE),
      recheck: { upstreamMovedBy: null, startedAt: at(2 * MINUTE), typicalMs: null },
    }));
    expect(html).toContain('main moved since the check');
    expect(html).toContain('(2m so far)');
    expect(html).not.toContain('commit');
  });

  it('says there is nothing for you to do', () => {
    expect(card(rechecking)).toContain(NOTHING_TO_DO);
  });

  it('cannot be merged again, and can be called back', () => {
    const html = card(rechecking);
    expect(html).toContain(MERGING);
    expect(html).toContain(CANCEL_MERGE);
    // The one that says "it is happening" is the one that cannot be pressed.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Merging/);
  });

  it('draws a confirmed merge that has not had to re-check as the same card', () => {
    const html = card(promotion({ state: 'CONFIRMED' }));
    expect(html).toContain('Merging project/bg-jobs into main…');
    expect(html).toContain(MERGING);
    expect(html).not.toContain('main moved since the check');
  });
});

describe('state C — it merged, and the card is the receipt', () => {
  const merged = promotion({
    state: 'MERGED',
    merged: {
      sha: '324cf003a7b8c9d0e1f2a3b4c5d6e7f809a1b2c3',
      byUserId: '2p7QMFOwEGtL5oaTxZHihm',
      at: at(2 * MINUTE),
    },
  });

  it('is a receipt: the commit, who merged it and when', () => {
    const html = card(merged);
    expect(html).toContain('Merged into main');
    expect(html).toContain('324cf00');
    expect(html).toContain('merge of project/bg-jobs');
    expect(html).toContain('by you');
    expect(html).toContain('2m ago');
  });

  it('says what is on main now, and that the branch keeps going', () => {
    const html = card(merged);
    expect(html).toContain('4 tasks');
    expect(html).toContain('project/bg-jobs keeps going — 3 tasks still open');
  });

  it('asks for nothing: a receipt has no presses', () => {
    expect(card(merged)).not.toContain('<button');
  });
});

describe('state D — it cannot merge yet, and somebody is on it', () => {
  const blocked = promotion({
    state: 'BLOCKED',
    conflicts: ['src/runner-go/session_pool.go', 'src/apiserver/prisma/schema.prisma'],
  });

  it('says why, in files', () => {
    const html = card(blocked, { item: blockedItem() });
    expect(html).toContain('project/bg-jobs can’t merge into main yet');
    expect(html).toContain('2 files conflict');
    expect(html).toContain('src/runner-go/session_pool.go');
    expect(html).toContain('src/apiserver/prisma/schema.prisma');
  });

  it('says who has it, how long, and what happens next', () => {
    const html = card(blocked, { item: blockedItem() });
    expect(html).toContain('The coordinator is resolving it');
    expect(html).toContain('12m');
    expect(html).toContain('goes to you');
    expect(html).toContain('Merge project/bg-jobs into main?');
  });

  it('cannot be merged: the press that would fail is disabled, not lit', () => {
    const html = card(blocked, { item: blockedItem() });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Merge to main/);
    expect(html).toContain(OPEN_COORDINATOR);
  });

  it('says the checks failed when that is why, rather than inventing a conflict', () => {
    const html = card(
      promotion({
        state: 'BLOCKED',
        conflicts: [],
        checks: [
          {
            name: 'MERGE_CHECK',
            command: 'cd src/runner-go && go test -count=1 ./...',
            expectedExitCode: 0,
            exitCode: 1,
            timedOut: false,
            durationMs: 5 * MINUTE + 40 * 1000,
            outputTail: 'FAIL\torbit/runner\t340.2s\n',
          },
        ],
      }),
      { item: blockedItem({ kind: 'INTEGRATION_CHECK_FAILED' }) },
    );
    expect(html).toContain('Checks failed on the combined tree');
    expect(html).toContain('cd src/runner-go &amp;&amp; go test -count=1 ./...');
    expect(html).not.toContain('files conflict');
  });

  it('still says it cannot merge when no item has been filed for it yet', () => {
    const html = card(blocked, { item: null });
    expect(html).toContain('project/bg-jobs can’t merge into main yet');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Merge to main/);
  });
});

describe('what the card refuses to draw', () => {
  it('draws nothing while the checks are still running: nobody is being asked anything', () => {
    expect(card(promotion({ state: 'CHECKING', askedAt: null }))).toBe('');
  });

  it('draws nothing for a candidate that was declined, cancelled or superseded', () => {
    for (const state of ['DECLINED', 'CANCELLED', 'SUPERSEDED'] as const) {
      expect(card(promotion({ state }))).toBe('');
    }
  });

  it('leaves out the criteria tally rather than guessing it from a document it has not read', () => {
    const html = card(promotion(), { project: null });
    expect(html).toContain('Merge project/bg-jobs into main?');
    expect(html).not.toContain('met on this branch');
  });
});

describe('the presses', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiMock.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function draw(ui: JSX.Element) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client()}>{ui}</QueryClientProvider>
        </MemoryRouter>,
      );
    });
  }

  /**
   * How long a wait is given before it gives up, in wall clock. The budget a file's waits have is
   * the 30s test timeout (vite.config.ts); this sits inside it, so a wait that is never satisfied
   * still fails, and fails naming what never appeared.
   */
  const UNTIL_MS = 10_000;

  /**
   * Wait for what the render is supposed to show, by the clock rather than by a count of ticks. A
   * tick is one turn of the event loop and costs whatever the machine charges for it, and 50 of them
   * cost no time at all exactly when the wait has nothing to flush — measured on the CI that reds
   * this file: 50 ticks in 0ms, with a `setTimeout(0)` armed before the first of them still unfired
   * when the last ran out. What a read needs is time, so every turn here hands the event loop a
   * macrotask — which is where a read lands: react-query notifies its subscribers through
   * `setTimeout`, and a real door answers on a macrotask too.
   */
  async function until(held: () => boolean, what: string) {
    const deadline = Date.now() + UNTIL_MS;
    for (;;) {
      if (held()) return;
      if (Date.now() >= deadline) {
        throw new Error(`never became true within ${UNTIL_MS}ms: ${what}`);
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function press(label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll('button')].find((element) =>
      element.textContent?.includes(label),
    );
    if (!button) throw new Error(`no ${label} button`);
    return button;
  }

  it('confirms the candidate it drew, and names the SHA it was drawn from', async () => {
    apiMock.mockResolvedValue({ ...promotion(), state: 'CONFIRMED' });
    await draw(
      <ProjectPromotionCard
        projectId={PROJECT_ID}
        promotion={promotion()}
        item={null}
        project={project()}
        now={NOW}
      />,
    );
    await act(async () => press(MERGE_TO_MAIN).click());
    await until(() => apiMock.mock.calls.length > 0, 'the confirm');

    expect(apiMock.mock.calls[0]![0]).toBe(
      `/projects/${PROJECT_ID}/promotions/${PROMOTION_ID}/confirm`,
    );
    expect(apiMock.mock.calls[0]![1]).toEqual({
      method: 'POST',
      body: { sourceSha: promotion().sourceSha },
    });
  });

  it('declines at the decline door, which merges nothing', async () => {
    apiMock.mockResolvedValue({ ...promotion(), state: 'DECLINED' });
    await draw(
      <ProjectPromotionCard
        projectId={PROJECT_ID}
        promotion={promotion()}
        item={null}
        project={project()}
        now={NOW}
      />,
    );
    await act(async () => press(NOT_NOW).click());
    await until(() => apiMock.mock.calls.length > 0, 'the decline');

    expect(apiMock.mock.calls[0]![0]).toBe(
      `/projects/${PROJECT_ID}/promotions/${PROMOTION_ID}/decline`,
    );
    expect(apiMock.mock.calls[0]![1]).toEqual({ method: 'POST', body: {} });
  });

  it('calls a confirmed merge back at the cancel door', async () => {
    apiMock.mockResolvedValue({ ...promotion(), state: 'CANCELLED' });
    await draw(
      <ProjectPromotionCard
        projectId={PROJECT_ID}
        promotion={promotion({ state: 'CONFIRMED' })}
        item={null}
        project={project()}
        now={NOW}
      />,
    );
    await act(async () => press(CANCEL_MERGE).click());
    await until(() => apiMock.mock.calls.length > 0, 'the cancel');

    expect(apiMock.mock.calls[0]![0]).toBe(
      `/projects/${PROJECT_ID}/promotions/${PROMOTION_ID}/cancel`,
    );
  });

  it('says so when the door refuses, and leaves the card pressable', async () => {
    apiMock.mockRejectedValue(new Error('this card was drawn from an older candidate'));
    await draw(
      <ProjectPromotionCard
        projectId={PROJECT_ID}
        promotion={promotion()}
        item={null}
        project={project()}
        now={NOW}
      />,
    );
    await act(async () => press(MERGE_TO_MAIN).click());
    await until(
      () => host.textContent!.includes('this card was drawn from an older candidate'),
      'the refusal',
    );
    expect(host.textContent).toContain('was not merged');
  });

  it('asks the door nothing for a session that coordinates no project', async () => {
    await draw(<ProjectPromotion projectId={null} now={NOW} />);
    expect(apiMock).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });

  it('reads the candidate, the item and the project, and draws the card from them', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith('/promotions/current')) return promotion() as never;
      if (path.endsWith('/open-items')) return { needsYou: [], withCoordinator: [] } as never;
      return project() as never;
    });
    await draw(<ProjectPromotion projectId={PROJECT_ID} now={NOW} />);
    await until(
      () => host.textContent!.includes('Merge project/bg-jobs into main?'),
      'the card',
    );
    expect(apiMock.mock.calls.map((call) => call[0])).toContain(
      `/projects/${PROJECT_ID}/promotions/current`,
    );
  });

  it('waits for a door that answers on a macrotask, not within a count of ticks', async () => {
    // The same three reads one macrotask later, which is when a real door answers: this one is a
    // fetch. `mockResolvedValue` answers on a microtask, and that is the whole reason a wait counted
    // in ticks ever reached a read here — the ticks it spent on one still in flight cost no time at
    // all (measured on the CI that reds these files: 50 ticks in 0ms), so the budget ran out before
    // the answer was even due.
    apiMock.mockImplementation(async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (path.endsWith('/promotions/current')) return promotion() as never;
      if (path.endsWith('/open-items')) return { needsYou: [], withCoordinator: [] } as never;
      return project() as never;
    });
    await draw(<ProjectPromotion projectId={PROJECT_ID} now={NOW} />);
    await until(
      () => host.textContent!.includes('Merge project/bg-jobs into main?'),
      'the card',
    );
    expect(host.textContent).toContain('project/bg-jobs');
  });
});
