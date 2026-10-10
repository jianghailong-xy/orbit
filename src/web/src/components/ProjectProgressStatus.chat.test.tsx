// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OpenItemChat, OpenItemFacts, ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemAsCard, openItemChatBanner, openItemChatContext } from './ProjectProgressStatus';
import {
  CHAT_ABOUT_INTENT,
  CHAT_ABOUT_THIS,
  CHAT_REFUSAL_LABEL,
  EXCEPTION_CHAT_PREFIX,
  PAUSE_CHAT_PREFIX,
  itemChat,
  type CoordinatorChatSubject,
} from '../lib/coordinatorChat';

/**
 * "Chat about this" on the exception cards a coordinator conversation draws (contract §4.7, §4.8):
 * a task's landing and a merge into main — the item that names no task — with the coordinator,
 * being handled by its rerun, the owner's once the clock handed it over, handled, and superseded.
 *
 * What is held: every one of those cards carries the press, live wherever the server offers the
 * chat and disabled WITH the server's reason where it does not; the press arms the host's composer
 * in the coordinator conversation and opens that conversation anywhere else; it is drawn apart from
 * the doors and changes none of them, and it sends no request of its own; and what it carries names
 * the project, the item, what failed and where its handling stands.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34Y7My8sqhKLWtmCQYv1l';
const COORDINATOR = '34Y7Myo7G89Vk0fVpelbt';
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const REASON = 'the merge check’s baseline was repaired; the red was the baseline’s';

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function facts(over: Partial<OpenItemFacts> = {}): OpenItemFacts {
  return {
    task: null,
    targetRef: 'project/34Y7My8sqhKLWtmCQYv1l',
    targetSha: 'c'.repeat(40),
    files: [],
    nothingLanded: true,
    check: {
      name: 'MERGE_CHECK',
      command: 'npm test && go test ./...',
      expectedExitCode: 0,
      exitCode: 1,
      timedOut: false,
      durationMs: 26 * MINUTE,
      outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.45s)\nFAIL',
    },
    branchUnchanged: true,
    errorCode: null,
    failure: null,
    ...over,
  };
}

function chat(over: Partial<OpenItemChat> = {}): OpenItemChat {
  return { sessionId: COORDINATOR, stage: 'WITH_COORDINATOR', refusal: null, ...over };
}

/** Task-scoped: a task's landing that failed its combined-tree check, with the coordinator. */
const LANDING: ProjectOpenItemRow = {
  itemId: '34ZLandingItem0000001',
  kind: 'INTEGRATION_CHECK_FAILED',
  title: 'Checks failed on the combined tree: ③ 实现所有者收尾门与 Done 优先语义',
  detailLine: 'MERGE_CHECK exited 1 on the combined tree; the project branch did not move',
  assignee: 'COORDINATOR',
  assigneeReason: 'DEFAULT',
  waitingSince: at(30 * MINUTE),
  escalateAt: new Date(NOW + 90 * MINUTE).toISOString(),
  escalatedAt: null,
  taskId: '34Y7Utvsd47A14DjMzIzD',
  sessionId: '34Y7UtvsdSession00001',
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(29 * MINUTE) },
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  question: null,
  facts: facts({ task: { id: '34Y7Utvsd47A14DjMzIzD', title: '③ 实现所有者收尾门与 Done 优先语义' } }),
  handling: null,
  outcome: null,
  chat: chat(),
};

const HANDLING_LANDING: ProjectOpenItemRow = {
  ...LANDING,
  handling: {
    sessionId: COORDINATOR,
    userId: null,
    reason: REASON,
    startedAt: at(4 * MINUTE),
    jobId: '34ZRerunJob0000000001',
    jobKind: 'LAND_TASK',
    generation: 2,
    state: 'RUNNING',
  },
  chat: chat({ stage: 'HANDLING' }),
};

/** Task-scoped, the owner's: the third failure of a task, which the clock handed over. */
const ESCALATED_TASK: ProjectOpenItemRow = {
  ...LANDING,
  itemId: '34ZTaskFailedItem0001',
  kind: 'TASK_FAILED',
  title: 'Task failed: P5.1 实现游戏 Route Handlers',
  detailLine: 'the acceptance command exited 1 where 0 was declared',
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: at(3 * HOUR),
  escalateAt: null,
  escalatedAt: at(HOUR),
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
  facts: facts({
    task: { id: '34Y7Utvsd47A14DjMzIzD', title: 'P5.1 实现游戏 Route Handlers' },
    targetRef: null,
    targetSha: null,
    nothingLanded: false,
    check: null,
    branchUnchanged: false,
    failure: { how: 'ACCEPTANCE_EXIT_MISMATCH', exitCode: 1, expectedExitCode: 0, attempt: 2, limit: 3 },
  }),
  chat: chat({ stage: 'WITH_OWNER' }),
};

/** Promotion-scoped: the merge of the project branch into main its MERGE_CHECK blocked. */
const PROMOTION: ProjectOpenItemRow = {
  ...LANDING,
  itemId: '34ZPromotionItem00001',
  title: 'Checks failed on the combined tree: merging the project branch into main',
  taskId: null,
  sessionId: null,
  promotionId: '34ZPromotion000000001',
  actions: ['REVIEW'],
  facts: facts({ targetRef: 'main' }),
};

const HANDLING_PROMOTION: ProjectOpenItemRow = {
  ...PROMOTION,
  handling: {
    sessionId: COORDINATOR,
    userId: null,
    reason: 'main’s merge-check baseline was repaired',
    startedAt: at(MINUTE),
    jobId: '34ZRecheckJob00000001',
    jobKind: 'CHECK_PROMOTION',
    generation: 2,
    state: 'QUEUED',
  },
  chat: chat({ stage: 'HANDLING' }),
};

/** Promotion-scoped, the owner's: what the merge card reads as "It is yours · waiting". While there
 *  is a coordinator to ask, the server gives it the way back to it beside the merge card (§4.7). */
const ESCALATED_PROMOTION: ProjectOpenItemRow = {
  ...PROMOTION,
  actions: ['ASK_COORDINATOR_AGAIN', 'REVIEW'],
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: at(3 * HOUR),
  escalateAt: null,
  escalatedAt: at(HOUR),
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  chat: chat({ stage: 'WITH_OWNER' }),
};

function settled(
  row: ProjectOpenItemRow,
  outcome: NonNullable<ProjectOpenItemRow['outcome']>,
  ended: Partial<OpenItemChat>,
): ProjectOpenItemRow {
  return {
    ...row,
    escalateAt: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    handling: null,
    outcome,
    chat: chat(ended),
  };
}

const HANDLED_LANDING = settled(LANDING, {
  state: 'RESOLVED',
  resolution: 'HANDLED',
  resolvedBy: 'COORDINATOR',
  resolvedBySessionId: COORDINATOR,
  resolvedByUserId: null,
  resolvedAt: at(12 * MINUTE),
  note: REASON,
  jobId: '34ZRerunJob0000000001',
  supersededByItemId: null,
}, { stage: 'HANDLED' });

const SUPERSEDED_PROMOTION = settled(PROMOTION, {
  state: 'SUPERSEDED',
  resolution: 'RETRIED',
  resolvedBy: 'COORDINATOR',
  resolvedBySessionId: COORDINATOR,
  resolvedByUserId: null,
  resolvedAt: at(2 * MINUTE),
  note: 'main’s merge-check baseline was repaired',
  jobId: '34ZRecheckJob00000001',
  supersededByItemId: '34ZPromotionItem00002',
}, { stage: 'SUPERSEDED', refusal: 'SUPERSEDED' });

/** The pause only the owner can lift: an open item too, and the native ends chat about it. */
const PAUSE: ProjectOpenItemRow = {
  ...LANDING,
  itemId: '34ZFusePausedItem0001',
  kind: 'FUSE_PAUSED',
  title: 'The coordinator paused itself',
  detailLine: '30 self-started turns today, of a limit of 30',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  escalateAt: null,
  taskId: null,
  sessionId: null,
  fuseEpisodeId: '34ZFuseEpisode0000001',
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['RESUME'],
  facts: null,
  chat: chat({ stage: 'WITH_OWNER' }),
};

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function card(row: ProjectOpenItemRow, onChat?: (subject: CoordinatorChatSubject) => void): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client()}>
        <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} onChat={onChat} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The card's chat press, which lives in a row of its own. */
function chatPress(html: string): HTMLButtonElement | null {
  return parse(html).querySelector<HTMLButtonElement>('.project-open-item-chat button');
}

const LIVE = {
  'task landing, with the coordinator': LANDING,
  'task landing, being handled': HANDLING_LANDING,
  'task, escalated to the owner': ESCALATED_TASK,
  'merge into main, with the coordinator': PROMOTION,
  'merge into main, being handled': HANDLING_PROMOTION,
  'merge into main, escalated to the owner': ESCALATED_PROMOTION,
  'task landing, handled': HANDLED_LANDING,
  'the pause': PAUSE,
};

describe('every exception card carries the conversation about it', () => {
  for (const [what, row] of Object.entries(LIVE)) {
    it(`${what}: a live Chat about this`, () => {
      const press = chatPress(card(row, () => undefined));
      expect(press?.textContent).toBe(CHAT_ABOUT_THIS);
      expect(press?.disabled, 'drawn dead').toBe(false);
    });
  }

  it('superseded: disabled, and says the chat belongs to the item that replaced it', () => {
    const html = card(SUPERSEDED_PROMOTION, () => undefined);
    expect(chatPress(html)?.disabled).toBe(true);
    expect(parse(html).querySelector('.project-open-item-chat')?.textContent)
      .toContain(CHAT_REFUSAL_LABEL.SUPERSEDED);
    // …and the way to that item is still on the card.
    expect(html).toContain('href="#open-item-34ZPromotionItem00002"');
  });

  it('refused with the server’s reason where the message has nowhere to go', () => {
    const none = card({ ...ESCALATED_TASK, chat: chat({ sessionId: null, stage: 'WITH_OWNER', refusal: 'NO_COORDINATOR' }) });
    expect(chatPress(none)?.disabled).toBe(true);
    expect(none).toContain(CHAT_REFUSAL_LABEL.NO_COORDINATOR);

    const down = card({ ...LANDING, chat: chat({ refusal: 'COORDINATOR_UNAVAILABLE' }) }, () => undefined);
    expect(chatPress(down)?.disabled, 'a composer of its own does not overrule the server').toBe(true);
    expect(down).toContain(CHAT_REFUSAL_LABEL.COORDINATOR_UNAVAILABLE);
  });

  it('is no door: drawn apart from the action row, which is exactly what it was', () => {
    const doors = (row: ProjectOpenItemRow) =>
      [...parse(card(row, () => undefined)).querySelectorAll('.project-open-item-actions > *')]
        .map((press) => press.textContent?.trim());
    expect(doors(ESCALATED_TASK)).toEqual([
      'Ask the coordinator again',
      'Open task session',
      'Cancel task',
      'Mark as handled',
    ]);
    expect(doors(LANDING)).toEqual(['Open task session', 'Retry', 'Open coordinator', 'Cancel task']);
    // The candidate's item is the way back to the coordinator and the merge card's way in — no
    // retry, no merge, here, and the chat beside them rather than among them.
    expect(doors(ESCALATED_PROMOTION)).toEqual(['Ask the coordinator again', 'Review', 'Mark as handled']);
    for (const row of Object.values(LIVE)) {
      expect(doors(row)).not.toContain(CHAT_ABOUT_THIS);
    }
  });
});

describe('what the press does', () => {
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

  function Location(): JSX.Element {
    const location = useLocation();
    return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
  }

  async function pressChat(): Promise<void> {
    const press = host.querySelector<HTMLButtonElement>('.project-open-item-chat button');
    if (!press) throw new Error('no Chat about this');
    await act(async () => press.click());
  }

  it('in the coordinator conversation, hands the host the item — for the task and for the merge — and asks no door anything', async () => {
    for (const row of [ESCALATED_TASK, ESCALATED_PROMOTION]) {
      const onChat = vi.fn();
      await act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={client()}>
              <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} onChat={onChat} />
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await pressChat();
      expect(onChat).toHaveBeenCalledTimes(1);
      expect(onChat).toHaveBeenCalledWith({ kind: 'item', row });
    }
    expect(apiMock, 'the chat pressed a door').not.toHaveBeenCalled();
  });

  it('without a composer of its own, opens the coordinator conversation carrying the item', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/elsewhere']}>
          <QueryClientProvider client={client()}>
            <Routes>
              <Route path="/elsewhere" element={<ItemAsCard projectId={PROJECT_ID} row={ESCALATED_TASK} now={NOW} />} />
              <Route path="/sessions/:id" element={<Location />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await pressChat();
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
      `/sessions/${COORDINATOR}?intent=${CHAT_ABOUT_INTENT}&item=${ESCALATED_TASK.itemId}`,
    );
    expect(apiMock, 'the chat pressed a door').not.toHaveBeenCalled();
  });
});

describe('what the coordinator is told', () => {
  it('a task that became the owner’s: the project, the item, what failed, where it stands, and the ids', () => {
    const context = openItemChatContext({
      projectTitle: 'Wikids',
      projectId: PROJECT_ID,
      row: ESCALATED_TASK,
      now: NOW,
    });
    expect(context.split('\n')[0]).toBe('About the exception in “Wikids”:');
    expect(context).toContain(ESCALATED_TASK.title);
    expect(context).toContain(ESCALATED_TASK.detailLine);
    expect(context).toContain('Task: P5.1 实现游戏 Route Handlers');
    expect(context).toContain('How: the acceptance command exited 1 (expected 0)');
    expect(context).toContain('Retries: attempt 2 of 3 in this chain');
    expect(context).toContain('Where it stands: the owner’s now — no one acted on it for 2h');
    expect(context).toContain(
      `(project ${PROJECT_ID} · open item ${ESCALATED_TASK.itemId} · task ${ESCALATED_TASK.taskId} · `
        + `waiting since ${ESCALATED_TASK.waitingSince})`,
    );
  });

  it('a merge into main being re-checked: the rerun in flight, the coordinator’s reason, and the candidate', () => {
    const context = openItemChatContext({
      projectTitle: 'Wikids',
      projectId: PROJECT_ID,
      row: HANDLING_PROMOTION,
      now: NOW,
    });
    expect(context).toContain('Check: npm test && go test ./... · exit 1 after 26m');
    expect(context).toContain(
      'Where it stands: being handled — the re-check of the merge into main — generation 2 is queued · asked 1m ago',
    );
    expect(context).toContain('The coordinator’s reason: main’s merge-check baseline was repaired');
    expect(context).toContain(`promotion ${HANDLING_PROMOTION.promotionId}`);
    expect(context).not.toContain(' · task ');
  });

  it('names the merge being re-checked by the project’s main branch, main as before', () => {
    const stands = (main?: string) =>
      openItemChatContext({ projectTitle: 'Wikids', projectId: PROJECT_ID, row: HANDLING_PROMOTION, now: NOW, main })
        .split('\n')
        .find((line) => line.startsWith('Where it stands: '));
    expect(stands('master')).toBe(
      'Where it stands: being handled — the re-check of the merge into master — generation 2 is queued · asked 1m ago',
    );
    // Main by name, and a host that names none.
    for (const main of ['main', undefined]) {
      expect(stands(main), String(main)).toBe(
        'Where it stands: being handled — the re-check of the merge into main — generation 2 is queued · asked 1m ago',
      );
    }
  });

  it('escalated while its rerun runs: says both — the rerun in flight, and that it is the owner’s now', () => {
    const both: ProjectOpenItemRow = {
      ...HANDLING_LANDING,
      assignee: 'OWNER',
      assigneeReason: 'ESCALATED',
      waitingSince: at(130 * MINUTE),
      escalateAt: null,
      escalatedAt: at(10 * MINUTE),
      chat: chat({ stage: 'HANDLING' }),
    };
    expect(
      openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row: both, now: NOW }),
    ).toContain(
      'Where it stands: being handled — the rerun of the landing — generation 2 is running · asked '
        + '4m ago; the owner’s now — no one acted on it for 2h',
    );
  });

  it('with the coordinator, handled, and the pause: each says where it stands in its own words', () => {
    const stands = (row: ProjectOpenItemRow) =>
      openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row, now: NOW })
        .split('\n')
        .find((line) => line.startsWith('Where it stands: '));
    expect(stands(LANDING)).toBe(
      'Where it stands: waiting on the coordinator for 30m — it goes to the owner in 1h 30m',
    );
    expect(stands(HANDLED_LANDING)).toBe(
      'Where it stands: handled by the coordinator 12m ago — the rerun of the landing landed',
    );
    expect(stands(PAUSE)).toBe(
      'Where it stands: the coordinator stopped itself, and only the owner can lift it',
    );
    expect(openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row: PAUSE, now: NOW }))
      .toMatch(/^About the pause:/);
  });

  it('the owner’s own rerun or close (0380): says it was the owner’s, not the coordinator’s', () => {
    const OWNER = 'user-owner';
    const told = (row: ProjectOpenItemRow) =>
      openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row, now: NOW });
    const stands = (row: ProjectOpenItemRow) =>
      told(row).split('\n').find((line) => line.startsWith('Where it stands: '));
    const byOwner = { resolvedBy: 'USER' as const, resolvedByUserId: OWNER, resolvedBySessionId: null };

    const rerunning: ProjectOpenItemRow = {
      ...HANDLING_PROMOTION,
      handling: { ...HANDLING_PROMOTION.handling!, sessionId: null, userId: OWNER },
    };
    expect(told(rerunning)).toContain('The owner’s reason: main’s merge-check baseline was repaired');
    expect(told(rerunning)).not.toContain('The coordinator’s reason');

    expect(stands({ ...HANDLED_LANDING, outcome: { ...HANDLED_LANDING.outcome!, ...byOwner } })).toBe(
      'Where it stands: handled by the owner 12m ago — the rerun of the landing landed',
    );
    expect(stands({
      ...HANDLED_LANDING,
      outcome: { ...HANDLED_LANDING.outcome!, ...byOwner, jobId: null },
    })).toBe('Where it stands: handled by the owner 12m ago — closed by hand, with its reason');
    expect(stands({ ...SUPERSEDED_PROMOTION, outcome: { ...SUPERSEDED_PROMOTION.outcome!, ...byOwner } })).toBe(
      'Where it stands: superseded — the owner’s rerun failed again, and a new item took its place',
    );
    // The coordinator's own endings read as they did.
    expect(stands(SUPERSEDED_PROMOTION)).toBe(
      'Where it stands: superseded — the coordinator’s rerun failed again, and a new item took its place',
    );
  });

  it('a delivery under review: the stray files and the declaration they strayed from, as the card draws them', () => {
    const review: ProjectOpenItemRow = {
      ...LANDING,
      kind: 'DELIVERY_REVIEW',
      title: 'Changed files it didn’t declare: ③ 实现所有者收尾门与 Done 优先语义',
      detailLine: '2 files outside its declaration · src/shared/src/project-done.ts · +1',
      facts: facts({
        task: { id: '34Y7Utvsd47A14DjMzIzD', title: '③ 实现所有者收尾门与 Done 优先语义' },
        files: ['src/shared/src/project-done.ts', 'src/apiserver/src/projects/project-done-request.ts'],
        check: null,
        review: {
          reason: 'OUTSIDE_DECLARED_SCOPE',
          declaredPaths: ['src/apiserver/src/projects/project-owner-done.pg.spec.ts'],
        },
      }),
    };
    const context = openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row: review, now: NOW });
    expect(context).toContain('Files: src/shared/src/project-done.ts · src/apiserver/src/projects/project-done-request.ts');
    expect(context).toContain('Declared: src/apiserver/src/projects/project-owner-done.pg.spec.ts');
    expect(openItemChatContext({
      projectTitle: null,
      projectId: PROJECT_ID,
      row: { ...review, facts: { ...review.facts!, review: { reason: 'OUTSIDE_DECLARED_SCOPE', declaredPaths: [] } } },
      now: NOW,
    })).toContain('Declared: no paths');
    expect(openItemChatContext({ projectTitle: null, projectId: PROJECT_ID, row: LANDING, now: NOW }))
      .not.toContain('Declared:');
  });

  it('says in the bar which item the message is about', () => {
    expect(openItemChatBanner(ESCALATED_TASK)).toBe(`${EXCEPTION_CHAT_PREFIX}${ESCALATED_TASK.title}`);
    expect(openItemChatBanner(PAUSE)).toBe(`${PAUSE_CHAT_PREFIX}${PAUSE.title}`);
  });
});

describe('from a server that predates the chat', () => {
  it('reads the stage off the row, refuses only the superseded one, and goes where the item was delivered', () => {
    const old = ({ chat: _chat, ...row }: ProjectOpenItemRow): ProjectOpenItemRow => row;
    expect(itemChat(old(LANDING))).toEqual({ sessionId: COORDINATOR, stage: 'WITH_COORDINATOR', refusal: null });
    expect(itemChat(old(HANDLING_PROMOTION)).stage).toBe('HANDLING');
    expect(itemChat(old(ESCALATED_TASK))).toEqual({ sessionId: null, stage: 'WITH_OWNER', refusal: null });
    expect(itemChat(old(HANDLED_LANDING)).stage).toBe('HANDLED');
    expect(itemChat(old(SUPERSEDED_PROMOTION))).toEqual({
      sessionId: null,
      stage: 'SUPERSEDED',
      refusal: 'SUPERSEDED',
    });
    // In the coordinator conversation the host's composer is where it goes; anywhere else an item
    // with no address says there is none.
    expect(chatPress(card(old(ESCALATED_TASK), () => undefined))?.disabled).toBe(false);
    const nowhere = card(old(ESCALATED_TASK));
    expect(chatPress(nowhere)?.disabled).toBe(true);
    expect(nowhere).toContain(CHAT_REFUSAL_LABEL.NO_COORDINATOR);
  });
});
