// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemChat, ProjectOpenItemRow, ProjectPromotionView } from '@orbit/shared';
import {
  IT_IS_YOURS,
  MERGE_TO_MAIN,
  OPEN_COORDINATOR,
  RESOLVING,
  SEE_THE_EXCEPTION,
  ProjectPromotion,
  ProjectPromotionCard,
  promotionChatBanner,
  promotionChatContext,
  type PromotionProjectView,
} from './ProjectPromotionCard';
import {
  CHAT_ABOUT_INTENT,
  CHAT_ABOUT_THIS,
  CHAT_REFUSAL_LABEL,
  MERGE_CHAT_PREFIX,
  type CoordinatorChatSubject,
} from '../lib/coordinatorChat';

/**
 * State D's conversation — the merge into main that cannot happen yet (contract §3.3, §4.8).
 *
 * The card used to end in one grey press: "It is yours · waiting 2h", disabled, and nothing beside
 * it. The reader was told the branch was theirs and given nothing to do about it. What is held
 * here: beside that press there is always the conversation about the candidate — `Chat about this`
 * into the coordinator conversation the server names for the item, live unless the server refuses
 * it, and then disabled WITH the reason beside it — plus the way to where its handling is shown.
 * And none of it is a door: the merge stays the disabled press, and no request leaves the card.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
// The card's content/decision contract is tested inline; real dialogs are covered in ReviewCard.test.tsx.
vi.mock('./ReviewCard', () => import('../test/inlineReviewCard'));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const PROMOTION_ID = '3fFMHLbE7JTsr3vHFOzIDM';
const ITEM_ID = '4BLRNxGq7TOI1lIiOh4g1j';
const COORDINATOR = '34OAa5LxnQ1JXpUOfN21W';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

/** A candidate a conflict with main blocked (state D). */
function blocked(over: Partial<ProjectPromotionView> = {}): ProjectPromotionView {
  return {
    promotionId: PROMOTION_ID,
    state: 'BLOCKED',
    sourceKind: 'PROJECT_BRANCH',
    sourceRef: 'project/bg-jobs',
    sourceSha: '58f3a4709c1f4c2c0b0a9a1f3d7e5b6c8d9e0f12',
    upstreamRef: 'main',
    commitsAhead: 7,
    filesChanged: 18,
    taskIds: ['34OEE9DwfWYjo3aRFuBgo'],
    tasks: [{ taskId: '34OEE9DwfWYjo3aRFuBgo', title: 'warmEngineTTL 改回 4 小时' }],
    checks: [],
    conflicts: ['src/runner-go/session_pool.go', 'src/apiserver/prisma/schema.prisma'],
    upstreamShaChecked: null,
    upstream: { syncedAt: at(12 * MINUTE), conflicts: true },
    landsTreeSha: null,
    landsAs: 'MERGE_COMMIT',
    askedAt: null,
    recheckedAt: null,
    recheck: null,
    decidedAt: at(2 * HOUR),
    merged: null,
    ...over,
  };
}

/** The item holding it: the promotion-scoped exception — about the candidate, and about no task. */
function item(over: Partial<ProjectOpenItemRow> = {}, chat?: Partial<OpenItemChat>): ProjectOpenItemRow {
  return {
    itemId: ITEM_ID,
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict — project/bg-jobs cannot absorb main',
    detailLine: '2 files conflict with main · nothing landed',
    assignee: 'COORDINATOR',
    assigneeReason: 'DEFAULT',
    waitingSince: at(2 * HOUR),
    escalateAt: new Date(NOW + HOUR).toISOString(),
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: PROMOTION_ID,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(2 * HOUR) },
    actions: ['REVIEW'],
    question: null,
    facts: null,
    chat: { sessionId: COORDINATOR, stage: 'WITH_COORDINATOR', refusal: null, ...chat },
    ...over,
  };
}

/** The same item once the clock handed it to the owner: "It is yours · waiting". */
function escalated(chat?: Partial<OpenItemChat>): ProjectOpenItemRow {
  return item(
    {
      assignee: 'OWNER',
      assigneeReason: 'ESCALATED',
      escalateAt: null,
      escalatedAt: at(HOUR),
      // An owner's item is delivered to nobody: the card cannot lean on a delivery to find the
      // coordinator, which is exactly how it came to have no way in at all.
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
      // The server's presses for it while there is a coordinator to ask (§4.7): the way back to it,
      // drawn on the item's own card, and the merge card.
      actions: ['ASK_COORDINATOR_AGAIN', 'REVIEW'],
    },
    { stage: 'WITH_OWNER', ...chat },
  );
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function card(
  view: ProjectPromotionView,
  over: {
    item?: ProjectOpenItemRow | null;
    project?: PromotionProjectView | null;
    onChat?: (subject: CoordinatorChatSubject) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client()}>
        <ProjectPromotionCard
          projectId={PROJECT_ID}
          promotion={view}
          item={over.item === undefined ? item() : over.item}
          project={over.project ?? null}
          now={NOW}
          onChat={over.onChat}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The press a reader would press, by its label, and whether it is live. */
function pressIn(html: string, label: string): HTMLButtonElement | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null;
}

function linkIn(html: string, label: string): HTMLAnchorElement | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('a')].find((a) => a.textContent?.trim() === label) ?? null;
}

describe('state D is never a grey press alone', () => {
  it('beside “It is yours · waiting”, a live Chat about this and the way to the coordinator', () => {
    const html = card(blocked(), { item: escalated() });
    // Whose it is still says so, on the press that cannot merge…
    expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${IT_IS_YOURS} · waiting 2h</button>`));
    expect(html).not.toContain(MERGE_TO_MAIN);
    // …and beside it, the conversation about it — live — and where its handling is shown.
    const chat = pressIn(html, CHAT_ABOUT_THIS);
    expect(chat, 'no Chat about this beside the press').not.toBeNull();
    expect(chat!.disabled, 'the chat is drawn dead').toBe(false);
    expect(linkIn(html, OPEN_COORDINATOR)?.getAttribute('href'))
      .toBe(`/sessions/${COORDINATOR}`);
  });

  it('the same beside “Coordinator is resolving it”, while the coordinator has it', () => {
    const html = card(blocked(), { item: item() });
    expect(html).toContain(`${RESOLVING} · 2h`);
    expect(pressIn(html, CHAT_ABOUT_THIS)?.disabled).toBe(false);
    expect(linkIn(html, OPEN_COORDINATOR)).not.toBeNull();
  });

  it('goes to the conversation the server names, not to wherever the item was last delivered', () => {
    // A coordinator replaced since the delivery: the chat follows the project's conversation now.
    const html = card(blocked(), {
      item: item({}, { sessionId: '34Y7Myo7G89Vk0fVpelbt' }),
    });
    expect(linkIn(html, OPEN_COORDINATOR)?.getAttribute('href'))
      .toBe('/sessions/34Y7Myo7G89Vk0fVpelbt');
  });

  it('says why beside a disabled chat when the project has no coordinator conversation', () => {
    const html = card(blocked(), {
      item: escalated({ sessionId: null, refusal: 'NO_COORDINATOR' }),
    });
    expect(pressIn(html, CHAT_ABOUT_THIS)?.disabled).toBe(true);
    expect(html).toContain(CHAT_REFUSAL_LABEL.NO_COORDINATOR);
    expect(linkIn(html, OPEN_COORDINATOR), 'a way in to nowhere').toBeNull();
  });

  it('says why when the coordinator conversation cannot take a message now', () => {
    const html = card(blocked(), {
      item: escalated({ refusal: 'COORDINATOR_UNAVAILABLE' }),
    });
    expect(pressIn(html, CHAT_ABOUT_THIS)?.disabled).toBe(true);
    expect(html).toContain(CHAT_REFUSAL_LABEL.COORDINATOR_UNAVAILABLE);
  });

  it('gives the reason a line of its own under the presses, rather than squeezing them', () => {
    // The row does not wrap for the presses; a refused chat's reason is the one thing that takes a
    // line of its own (`has-chat-refusal`), in the conversation as on the project page.
    for (const onChat of [undefined, () => undefined]) {
      const doc = new DOMParser().parseFromString(
        card(blocked(), { item: escalated({ refusal: 'COORDINATOR_UNAVAILABLE' }), onChat }),
        'text/html',
      );
      const row = doc.querySelector('.project-promotion-actions');
      expect(row?.classList.contains('has-chat-refusal')).toBe(true);
      expect(row?.querySelector('.project-promotion-chat-refusal')?.textContent)
        .toBe(CHAT_REFUSAL_LABEL.COORDINATOR_UNAVAILABLE);
    }
    const live = new DOMParser().parseFromString(card(blocked(), { item: escalated() }), 'text/html');
    expect(live.querySelector('.project-promotion-actions')?.classList.contains('has-chat-refusal'))
      .toBe(false);
  });

  it('with no item filed yet, takes the project’s own coordinator conversation — or says there is none', () => {
    const viaProject = card(blocked(), {
      item: null,
      project: { coordinatorSessionId: COORDINATOR },
    });
    expect(pressIn(viaProject, CHAT_ABOUT_THIS)?.disabled).toBe(false);
    expect(linkIn(viaProject, OPEN_COORDINATOR)?.getAttribute('href')).toBe(`/sessions/${COORDINATOR}`);

    const nowhere = card(blocked(), { item: null, project: null });
    expect(pressIn(nowhere, CHAT_ABOUT_THIS)?.disabled).toBe(true);
    expect(nowhere).toContain(CHAT_REFUSAL_LABEL.NO_COORDINATOR);
  });

  it('inside the coordinator conversation, points at the item’s own card rather than at itself', () => {
    const html = card(blocked(), { item: escalated(), onChat: () => undefined });
    expect(pressIn(html, CHAT_ABOUT_THIS)?.disabled).toBe(false);
    expect(linkIn(html, SEE_THE_EXCEPTION)?.getAttribute('href')).toBe(`#open-item-${ITEM_ID}`);
    expect(linkIn(html, OPEN_COORDINATOR)).toBeNull();
  });

  it('is state D’s alone: the asking, the merging and the merged cards keep the presses they had', () => {
    for (const state of ['READY', 'CONFIRMED', 'RECHECKING'] as const) {
      expect(card(blocked({ state, conflicts: [], decidedAt: null }), { item: null }))
        .not.toContain(CHAT_ABOUT_THIS);
    }
    expect(card(blocked({
      state: 'MERGED',
      conflicts: [],
      merged: { sha: '324cf0031a', byUserId: null, at: at(MINUTE), automatic: false, revert: null },
    }), { item: null })).not.toContain(CHAT_ABOUT_THIS);
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

  function press(label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} button`);
    return button;
  }

  /** Where the router is, drawn where a test can read it. */
  function Location(): JSX.Element {
    const location = useLocation();
    return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
  }

  it('in the coordinator conversation, arms that conversation’s composer with the candidate and its item — and asks no door anything', async () => {
    const onChat = vi.fn();
    const holding = escalated();
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client()}>
            <ProjectPromotionCard
              projectId={PROJECT_ID}
              promotion={blocked()}
              item={holding}
              project={null}
              now={NOW}
              onChat={onChat}
            />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => press(CHAT_ABOUT_THIS).click());

    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onChat).toHaveBeenCalledWith({ kind: 'promotion', promotion: blocked(), item: holding });
    expect(apiMock, 'the chat pressed a door').not.toHaveBeenCalled();
    // The merge is still the press nobody can make while the candidate is blocked.
    expect(press(`${IT_IS_YOURS} · waiting 2h`).disabled).toBe(true);
  });

  it('anywhere else, opens the coordinator conversation carrying the candidate, and asks no door anything', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
          <QueryClientProvider client={client()}>
            <Routes>
              <Route
                path="/projects/:id"
                element={
                  <ProjectPromotionCard
                    projectId={PROJECT_ID}
                    promotion={blocked()}
                    item={escalated()}
                    project={null}
                    now={NOW}
                  />
                }
              />
              <Route path="/sessions/:id" element={<Location />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => press(CHAT_ABOUT_THIS).click());

    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
      `/sessions/${COORDINATOR}?intent=${CHAT_ABOUT_INTENT}&promotion=${PROMOTION_ID}`,
    );
    expect(apiMock, 'the chat pressed a door').not.toHaveBeenCalled();
  });

  it('on the project page, where the card reads the candidate, its item and the project itself, does the same — and only reads', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith('/promotions/current')) return blocked() as never;
      if (path.endsWith('/open-items')) return { needsYou: [escalated()], withCoordinator: [] } as never;
      return { coordinatorSessionId: COORDINATOR } as never;
    });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
          <QueryClientProvider client={client()}>
            <Routes>
              <Route path="/projects/:id" element={<ProjectPromotion projectId={PROJECT_ID} now={NOW} />} />
              <Route path="/sessions/:id" element={<Location />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    const deadline = Date.now() + 10_000;
    while (!host.textContent?.includes(`${IT_IS_YOURS} · waiting 2h`)) {
      if (Date.now() > deadline) throw new Error('the blocked card was never drawn');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    await act(async () => press(CHAT_ABOUT_THIS).click());

    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
      `/sessions/${COORDINATOR}?intent=${CHAT_ABOUT_INTENT}&promotion=${PROMOTION_ID}`,
    );
    expect(
      apiMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method),
      'the chat pressed a door',
    ).toEqual([]);
  });
});

describe('what the coordinator is told', () => {
  it('names the merge, the project, why it cannot happen, the item and where it stands — with the ids', () => {
    const context = promotionChatContext({
      projectTitle: 'Wikids',
      projectId: PROJECT_ID,
      promotion: blocked(),
      item: escalated(),
      now: NOW,
    });
    expect(context).toContain('About the merge of project/bg-jobs into main in “Wikids”');
    expect(context).toContain(
      'Why: 2 files conflict with main after syncing: src/runner-go/session_pool.go, src/apiserver/prisma/schema.prisma',
    );
    expect(context).toContain(
      'Exception: Merge conflict — project/bg-jobs cannot absorb main — 2 files conflict with main · nothing landed',
    );
    expect(context).toContain('Where it stands: the owner’s now — no one acted on it for 1h');
    expect(context).toContain(`project ${PROJECT_ID}`);
    expect(context).toContain(`promotion ${PROMOTION_ID}`);
    expect(context).toContain(`open item ${ITEM_ID}`);
  });

  it('says a failed check by its command, and a candidate with no item by saying so', () => {
    const context = promotionChatContext({
      projectTitle: null,
      projectId: PROJECT_ID,
      promotion: blocked({
        conflicts: [],
        checks: [{
          name: 'MERGE_CHECK',
          command: 'cd src/runner-go && go test ./...',
          expectedExitCode: 0,
          exitCode: 1,
          timedOut: false,
          durationMs: 5 * MINUTE,
          outputTail: 'FAIL\n',
        }],
      }),
      item: null,
      now: NOW,
    });
    expect(context).toContain('Why: checks failed on the combined tree: cd src/runner-go && go test ./... · exit 1');
    expect(context).toContain('Where it stands: no exception item has been filed for it yet');
    expect(context).not.toContain(' in “');
    expect(context).not.toContain('open item');
  });

  it('says what the bar is about in the card’s own heading', () => {
    expect(promotionChatBanner(blocked())).toBe(`${MERGE_CHAT_PREFIX}project/bg-jobs can’t merge into main yet`);
  });
});
