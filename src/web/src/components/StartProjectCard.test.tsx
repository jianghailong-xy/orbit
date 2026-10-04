// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOpenItemRow, ProjectStartRequest, StartProjectRequestBody } from '@orbit/shared';
import { api, ApiError } from '../api';
import { revealSettlementCard } from './DecisionRail';
import type { StandardSetConfirmationStanding } from '../lib/acceptanceConfirmation';
import {
  READY_TO_START,
  RUN_AUTOMATIC_HINT_MAIN,
  RUN_AUTOMATIC_HINT_PROJECT_BRANCH,
  RUN_LINE_MAIN_HINT,
  RUN_LINE_PROJECT_BRANCH_HINT,
  RUN_MERGE_CHECK_HINT,
  RUN_NO_MERGE_CHECK_WARNING,
  START_CHAT_PLACEHOLDER,
  START_NOT_RECORDED,
  START_PROJECT_ACTION,
  START_PROJECT_TITLE,
  START_REQUEST_GONE,
  START_SUGGESTED_BY_COORDINATOR,
  START_VIEW_TASKS,
  planOrderLine,
  planTaskLabel,
  repositoryLabel,
  runSettingsLine,
  shortBranch,
  startByHandWarning,
  startCardMeta,
  startCheckedLine,
  startExplanation,
} from '../lib/projectStart';
import {
  ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER,
  SessionAcceptanceConfirmationCard,
  acceptancePlanChangePlaceholder,
  acceptanceReadLabel,
  type SettlementPlanChat,
} from './AcceptanceConfirmationCard';
import { ENTER_HINT } from './CardHotkey';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { SessionStartProjectCard, startBody, startPlanView } from './StartProjectCard';

/**
 * "Start this project?" — drawn on the coordinator's request and never inferred, pressed once at
 * the start door with the settings on the card, and stale in place when the request it was drawn
 * for no longer stands.
 *
 * The words are asserted as the constants `lib/projectStart.ts` declares, and those constants
 * against the copy table where the sentence is the claim: OrbitKit's parity tests read the same
 * file, so a sentence drifting there would drift at three ends at once.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const PROJECT = '34WvwUS8YMXfOfWbMqVuu';
const SEAL = `c2b4e16c4b59${'0'.repeat(52)}`;
const MOVED = `9c4f7a1bb001${'2'.repeat(52)}`;
const TITLE = 'Runner 页整页改版（iOS/macOS + web）';
const STARTED_AT = '2026-09-29T08:26:00.000Z';

const CRITERIA = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, ordinal: n, text: `condition ${n} holds` }));

function standingOf(digest = SEAL): StandardSetConfirmationStanding {
  const material = CRITERIA.map((c) => ({ definitionId: c.id, revision: 1, contentHash: `h${c.ordinal}` }));
  return {
    state: 'UNCONFIRMED',
    confirmed: false,
    currentVersion: { digest, material },
    confirmation: null,
    changesSinceConfirmed: null,
    changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
  };
}

function requestOf(over: Partial<ProjectStartRequest> = {}): ProjectStartRequest {
  return {
    settings: {
      line: 'PROJECT_BRANCH',
      projectBranchName: `refs/heads/project/${PROJECT}`,
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: 'cd src/web && npx tsc -b && npx vitest run',
    },
    why: 'B and C both build on A — one branch checks them together before main.',
    criteriaDigest: SEAL,
    planDigest: 'p'.repeat(64),
    repository: 'https://github.com/jianghailong-xy/orbit.git',
    warnings: [
      {
        severity: 'WARN',
        code: 'START_TASKS_START_BY_HAND',
        message: '4 tasks are set to start by hand (autoRunWhenReady=false): they wait for the coordinator even after the project starts',
        requiredAction: 'Set autoRunWhenReady …',
        criterion: null,
        tasks: ['task-b', 'task-c', 'task-d', 'task-e'].map((taskId) => ({ taskId, title: taskId })),
      },
    ],
    ...over,
  };
}

function rowOf(itemId: string, request: ProjectStartRequest = requestOf()): ProjectOpenItemRow {
  return {
    itemId,
    kind: 'START_REQUEST',
    title: START_PROJECT_TITLE,
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    waitingSince: new Date(Date.now() - 2_000).toISOString(),
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    question: null,
    facts: null,
    startRequest: request,
  };
}

/** The plan of the mock: A, then B and C, then D after B, then E after C and D. */
const GRAPH = {
  marks: [
    ['task-a', 'A · 提醒规则做成两端共用的真源'],
    ['task-b', 'B · OrbitKit：提醒规则、文案、DTO 与接口'],
    ['task-c', 'C · web：Runners 列表与 runner 详情页'],
    ['task-d', 'D · iOS/macOS：Runners 列表、Add Runner、Edit'],
    ['task-e', 'E · 上线'],
  ].map(([id, title]) => ({ kind: 'TASK', id, taskId: id, title, status: 'OPEN', parentTaskId: null })),
  edges: [
    ['task-a', 'task-b'],
    ['task-a', 'task-c'],
    ['task-b', 'task-d'],
    ['task-c', 'task-e'],
    ['task-d', 'task-e'],
  ].map(([sourceMarkId, targetMarkId]) => ({ sourceMarkId, targetMarkId })),
  taskCount: 5,
  folded: false,
  truncated: false,
  limits: { maxTasks: 500, maxMarks: 500 },
};

type Answer<T> = T | Error;

const server: {
  standing: Answer<StandardSetConfirmationStanding>;
  document: Answer<Record<string, unknown>>;
  row: ProjectOpenItemRow | null;
  door: (body: StartProjectRequestBody) => Promise<unknown>;
} = {
  standing: standingOf(),
  document: {},
  row: null,
  door: async () => ({}),
};

const documentOf = (startedAt: string | null = null): Record<string, unknown> => ({
  title: TITLE,
  status: 'OPEN',
  coordinatorEnabled: false,
  startedAt,
  _count: { tasks: 5 },
  acceptanceCriteriaItems: CRITERIA,
});

const requests: string[] = [];
const bodies: StartProjectRequestBody[] = [];
const armed: SettlementPlanChat[] = [];
const reports: Array<boolean | string | null> = [];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function answer<T>(value: Answer<T>): Promise<T> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

beforeEach(() => {
  server.standing = standingOf();
  server.document = documentOf();
  server.row = rowOf('item-1');
  server.door = async () => {
    // A start the door took: the project is started, the request answered.
    server.document = documentOf(STARTED_AT);
    server.row = null;
    return {};
  };
  requests.length = 0;
  bodies.length = 0;
  armed.length = 0;
  reports.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: StartProjectRequestBody }) => {
    if (init?.method === 'POST' && path === `/projects/${PROJECT}/start`) {
      requests.push(`POST ${path}`);
      bodies.push(init.body!);
      return server.door(init.body!);
    }
    requests.push(`GET ${path}`);
    if (path === `/projects/${PROJECT}/acceptance/confirmation`) return answer(server.standing);
    if (path === `/projects/${PROJECT}/open-items`) {
      return { needsYou: [], withCoordinator: [], startRequest: server.row };
    }
    if (path === `/projects/${PROJECT}/dependency-graph`) return GRAPH;
    if (path === `/projects/${PROJECT}`) return answer(server.document);
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
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** React Query hands every change on its own scheduler; a turn waits for one hand-off of its own. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 300 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

async function mount(
  options: { router?: boolean; onViewTasks?: () => void } = {},
): Promise<{ node: HTMLElement; qc: QueryClient }> {
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
        {options.router ? (
          <SessionAcceptanceConfirmationCard
            projectId={PROJECT}
            onOpenQuestion={(question) => reports.push(question)}
            onChatAbout={(plan) => armed.push(plan)}
          />
        ) : (
          <SessionStartProjectCard
            projectId={PROJECT}
            onOpen={(open) => reports.push(open)}
            onChatAbout={(plan) => armed.push(plan)}
            onViewTasks={options.onViewTasks}
          />
        )}
      </QueryClientProvider>,
    );
  });
  return { node, qc };
}

const cardIn = (_node: ParentNode): HTMLElement | null => document.querySelector<HTMLElement>('.start-card');

async function delivered(options: { onViewTasks?: () => void } = {}) {
  const { node, qc } = await mount(options);
  await until(() => cardIn(node) !== null && (cardIn(node)!.querySelector('.start-card-plan span') !== null), 'the card and its plan');
  await act(async () => { node.querySelector<HTMLButtonElement>('.review-card-preview')!.click(); });
  const card = (): HTMLElement => {
    const found = cardIn(node);
    if (!found) throw new Error('the card is not on the page');
    return found;
  };
  return { node, qc, card };
}

/** Every read coming round again, as the card's polls bring them. */
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
function action(card: HTMLElement, label: string): HTMLButtonElement {
  const found = actionsOf(card).find((button) => labelOf(button) === label);
  if (!found) throw new Error(`no "${label}" on the card`);
  return found;
}
const sections = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.start-card-section')].map((section) => section.textContent ?? '');
const settingRow = (card: HTMLElement, label: string): HTMLElement => {
  const row = [...card.querySelectorAll<HTMLElement>('.project-integration-setting')]
    .find((each) => each.querySelector('.project-integration-setting-label')?.textContent === label);
  if (!row) throw new Error(`no "${label}" row`);
  return row;
};

/** Types into an input the way the browser does: the native setter, then the event React reads. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  });
  await turn();
}

// ── the words ───────────────────────────────────────────────────────────────────────────────

describe('the words, as the copy table has them', () => {
  it('says the card, the lines and Automatic in the owner-approved sentences', () => {
    expect(START_PROJECT_TITLE).toBe('Start this project?');
    expect(START_PROJECT_ACTION).toBe('Start the project');
    expect(START_SUGGESTED_BY_COORDINATOR).toBe('suggested by the coordinator');
    expect(READY_TO_START).toBe('Ready to start');
    expect(RUN_LINE_PROJECT_BRANCH_HINT).toBe(
      'Recommended when tasks depend on each other: they land here first and are checked together.');
    expect(RUN_LINE_MAIN_HINT).toBe('For a single task or an urgent fix. Every merge into main asks you.');
    expect(RUN_AUTOMATIC_HINT_PROJECT_BRANCH).toBe(
      'The coordinator runs it for you: it decides when each task is done, handles conflicts and failed '
      + 'checks, and merges the branch into main once the merge check passes — with a receipt you can '
      + 'revert. The criteria and anything irreversible stay yours.');
    // Directly into main, the merging half is the copy table's replacement for it.
    expect(RUN_AUTOMATIC_HINT_MAIN).toContain(
      'Merging into main always asks you — a project that lands directly on main never merges by itself.');
    expect(RUN_AUTOMATIC_HINT_MAIN).not.toContain('merges the branch into main');
    expect(RUN_MERGE_CHECK_HINT).toBe(
      'Runs on the combined tree before anything lands — on the project branch and again before main.');
    expect(startExplanation(4)).toBe(
      'Orbit derives done from these 4 criteria and nothing else. If they change later, it asks you to '
      + 'confirm the new version — the project keeps running.');
    expect(START_CHAT_PLACEHOLDER).toBe('What should change before it starts?');
    expect(acceptancePlanChangePlaceholder('START')).toBe(START_CHAT_PLACEHOLDER);
    expect(acceptancePlanChangePlaceholder()).toBe(ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER);
  });

  it('writes the meta line, the check and the settings line the way the mock does', () => {
    expect(startCardMeta(TITLE, 'just now', 'c2b4e16c4b59'))
      .toBe(`${TITLE} · asked by the coordinator · just now · seal c2b4e16c4b59`);
    expect(startCardMeta(TITLE, null, 'c2b4e16c4b59')).toBe(`${TITLE} · seal c2b4e16c4b59`);
    expect(repositoryLabel('https://github.com/jianghailong-xy/orbit.git')).toBe('jianghailong-xy/orbit');
    expect(repositoryLabel('ssh://github.com/jianghailong-xy/orbit')).toBe('jianghailong-xy/orbit');
    expect(startCheckedLine('https://github.com/jianghailong-xy/orbit'))
      .toBe('Orbit checked the plan: every criterion has a task serving it · every task has a runner · repository jianghailong-xy/orbit');
    expect(startCheckedLine(null))
      .toBe('Orbit checked the plan: every criterion has a task serving it · every task has a runner');
    expect(shortBranch('refs/heads/project/34WvwUS8YMXfOfWbMqVuu')).toBe('project/34Wvw…');
    expect(shortBranch('refs/heads/release/next')).toBe('release/next');
    expect(runSettingsLine(requestOf().settings))
      .toBe('project/34Wvw… · Automatic on · 3 tasks at a time · merge check set');
    expect(runSettingsLine({ line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null }))
      .toBe('Directly into main · Automatic off · 1 task at a time · no merge check');
  });
});

describe('the plan in one line', () => {
  it('names each task by the marker its title opens with, and by its title when it has none', () => {
    expect(planTaskLabel('A · 提醒规则做成两端共用的真源')).toBe('A');
    expect(planTaskLabel('① 服务端 · 开工门')).toBe('①');
    expect(planTaskLabel('B：OrbitKit 接口')).toBe('B');
    expect(planTaskLabel('12) wire the card')).toBe('12');
    expect(planTaskLabel('Fix login redirect')).toBe('Fix login redirect');
    // "A new card" opens with a word, not a marker.
    expect(planTaskLabel('A new card for the start')).toBe('A new card for the start');
    expect(planTaskLabel('x'.repeat(40))).toBe(`${'x'.repeat(23)}…`);
  });

  it('says the mock’s plan the way the mock does', () => {
    const tasks = GRAPH.marks.map((mark) => ({
      id: mark.id,
      title: mark.title,
      after: GRAPH.edges.filter((edge) => edge.targetMarkId === mark.id).map((edge) => edge.sourceMarkId),
    }));
    expect(planOrderLine(tasks)).toBe('A starts now · B, C after A · D after B · E after C and D');
    // Two tasks nothing waits on start together; order within a step is the order they were filed.
    expect(planOrderLine([
      { id: 'x', title: 'X · one', after: [] },
      { id: 'y', title: 'Y · two', after: [] },
      { id: 'z', title: 'Z · three', after: ['y', 'x'] },
    ])).toBe('X, Y start now · Z after X and Y');
    // A prerequisite outside the plan — settled work, another project — waits on nothing here.
    expect(planOrderLine([{ id: 'x', title: 'X · one', after: ['elsewhere'] }])).toBe('X starts now');
  });

  it('says the tasks set to start by hand by their names, and leaves the merge check to its row', () => {
    expect(startByHandWarning(['B', 'C', 'D', 'E']))
      .toBe('B, C, D and E are set to start by hand — they wait for the coordinator even after the project starts.');
    expect(startByHandWarning(['B']))
      .toBe('B is set to start by hand — it waits for the coordinator even after the project starts.');
    const view = startPlanView(GRAPH, requestOf({
      warnings: [
        ...requestOf().warnings,
        { severity: 'WARN', code: 'START_NO_MERGE_CHECK', message: 'no merge check', requiredAction: '', criterion: null, tasks: [] },
      ],
    }), 0);
    expect(view.count).toBe(5);
    expect(view.warnings).toEqual([startByHandWarning(['B', 'C', 'D', 'E'])]);
    // A folded plan is too big for one line: it says how many and nothing about their order.
    const folded = startPlanView({ ...GRAPH, folded: true, taskCount: 900 }, requestOf(), 0);
    expect(folded).toMatchObject({ count: 900, order: null });
  });
});

describe('what a press sends', () => {
  it('sends the seal it was asked about, every setting as the card shows it, and the request', () => {
    const request = requestOf();
    expect(startBody(request, {
      line: 'PROJECT_BRANCH', automatic: false, maxConcurrentTasks: 5, mergeCheckCommand: '  npm test  ',
    }, 'item-1')).toEqual({
      criteriaDigest: SEAL,
      line: 'PROJECT_BRANCH',
      projectBranchName: `refs/heads/project/${PROJECT}`,
      automatic: false,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'npm test',
      requestId: 'item-1',
    });
    // Directly into main names no branch — the door refuses one — and a blank check is none.
    expect(startBody(request, {
      line: 'MAIN', automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: '   ',
    }, 'item-1')).toEqual({
      criteriaDigest: SEAL,
      line: 'MAIN',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: null,
      requestId: 'item-1',
    });
  });
});

// ── the card, wired ─────────────────────────────────────────────────────────────────────────

describe('when the card is drawn', () => {
  it('draws nothing for a plan nobody asked to start, however ready it looks, and the card once asked', async () => {
    server.row = null;
    const { node, qc } = await mount();
    await until(() => requests.includes(`GET /projects/${PROJECT}/open-items`), 'the open items to be read');
    for (let n = 0; n < 10; n += 1) await turn();
    expect(cardIn(node), 'a card was inferred from the plan').toBeNull();

    server.row = rowOf('item-1');
    await reread(qc);
    await until(() => cardIn(node) !== null, 'the card once the coordinator asked');
  });

  it('draws nothing for a project already started, and never asks for its open items', async () => {
    server.document = documentOf(STARTED_AT);
    const { node } = await mount();
    await until(() => requests.includes(`GET /projects/${PROJECT}`), 'the project to be read');
    for (let n = 0; n < 10; n += 1) await turn();
    expect(cardIn(node)).toBeNull();
    expect(requests).not.toContain(`GET /projects/${PROJECT}/open-items`);
  });

  it('tells the page it is on screen, and the router tells it which question that is', async () => {
    const { node } = await mount({ router: true });
    await until(() => cardIn(node) !== null, 'the card');
    await until(() => reports.includes('START'), 'the router to report the start question');
    expect(document.querySelectorAll('.settlement-card'), 'another settlement card was drawn beside it').toHaveLength(1);
  });
});

describe('what the card says', () => {
  it('is the mock’s card: meta, Done when, Plan, How it runs, the check, and two actions', async () => {
    const { card } = await delivered();
    expect(card().querySelector('.settlement-card-heading')?.textContent).toBe(START_PROJECT_TITLE);
    expect(card().querySelector('.criteria-provenance')?.textContent).toBe(PROVENANCE_LABEL);
    expect(card().querySelector('.settlement-card-meta')?.textContent)
      .toBe(startCardMeta(TITLE, 'just now', shortSeal(SEAL)));
    // The three sections, in the mock's order, each with its count.
    expect(sections(card())).toEqual([
      'Done when · 4 criteria',
      'Plan · 5 tasks',
      `How it runs${START_SUGGESTED_BY_COORDINATOR}`,
    ]);
    // Every criterion is on the card before anything is pressed, clamped until read in full.
    expect([...card().querySelectorAll('.settlement-card-criteria li')].map((li) => li.textContent))
      .toEqual(CRITERIA.map((c) => c.text));
    expect(card().querySelector('.settlement-card-read')?.textContent).toBe(acceptanceReadLabel(4));
    // The plan's order, the way to its tasks, and the check's warning in the owner's words.
    expect(card().querySelector('.start-card-plan')?.textContent)
      .toBe(`A starts now · B, C after A · D after B · E after C and D${START_VIEW_TASKS}`);
    expect([...card().querySelectorAll('.start-card-plan ~ .start-card-warn')].map((w) => w.textContent))
      .toEqual([`⚠ ${startByHandWarning(['B', 'C', 'D', 'E'])}`]);
    // How it runs, as the coordinator suggested it.
    const land = settingRow(card(), 'Tasks land on');
    expect(land.querySelector<HTMLInputElement>('input[value="PROJECT_BRANCH"]')?.checked).toBe(true);
    expect(land.querySelector('.start-card-branch')?.textContent).toBe(`project/${PROJECT}`);
    expect(land.textContent).toContain(RUN_LINE_PROJECT_BRANCH_HINT);
    expect(land.textContent).toContain(RUN_LINE_MAIN_HINT);
    const automatic = settingRow(card(), 'Automatic');
    expect(automatic.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(automatic.textContent).toContain(RUN_AUTOMATIC_HINT_PROJECT_BRANCH);
    expect(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')?.value).toBe('3');
    expect(settingRow(card(), 'At most').textContent).toContain('tasks at a time');
    expect(settingRow(card(), 'Merge check').querySelector<HTMLInputElement>('input')?.value)
      .toBe('cd src/web && npx tsc -b && npx vitest run');
    expect(card().querySelector('.start-card-note')?.textContent)
      .toBe('Coordinator: “B and C both build on A — one branch checks them together before main.”');
    expect(card().querySelector('.start-card-checked')?.textContent)
      .toBe(`✓${startCheckedLine('https://github.com/jianghailong-xy/orbit.git')}`);
    expect(card().querySelector('.settlement-card-explains')?.textContent).toBe(startExplanation(4));
    expect(actionsOf(card()).map(labelOf)).toEqual([START_PROJECT_ACTION, OWNER_SEND_BACK_ACTION]);
    // The primary action shows Enter; Chat about this has no shortcut.
    expect(action(card(), START_PROJECT_ACTION).querySelector('.approval-kbd')?.textContent).toBe(ENTER_HINT);
    expect(action(card(), OWNER_SEND_BACK_ACTION).querySelector('.approval-kbd')).toBeNull();
  });

  it('changes the Automatic sentence with the line, and marks the merge check only where it would be missed', async () => {
    const { card } = await delivered();
    const mergeCheck = (): HTMLElement => settingRow(card(), 'Merge check');
    expect(mergeCheck().className).not.toContain('is-warn');

    // Nothing to run on the combined tree, with Automatic merging the branch: the row warns.
    await type(mergeCheck().querySelector<HTMLInputElement>('input')!, '');
    expect(mergeCheck().className).toContain('is-warn');
    expect(mergeCheck().textContent).toContain(RUN_NO_MERGE_CHECK_WARNING);

    // Directly into main, Automatic never merges by itself: the sentence says so, and the warning goes.
    await act(async () => {
      settingRow(card(), 'Tasks land on').querySelector<HTMLInputElement>('input[value="MAIN"]')!.click();
    });
    expect(settingRow(card(), 'Automatic').textContent).toContain(RUN_AUTOMATIC_HINT_MAIN);
    expect(settingRow(card(), 'Automatic').textContent).not.toContain(RUN_AUTOMATIC_HINT_PROJECT_BRANCH);
    expect(mergeCheck().className).not.toContain('is-warn');

    // Back on the branch with Automatic off: nothing merges by itself, so nothing warns either.
    await act(async () => {
      settingRow(card(), 'Tasks land on').querySelector<HTMLInputElement>('input[value="PROJECT_BRANCH"]')!.click();
    });
    expect(mergeCheck().className).toContain('is-warn');
    await act(async () => {
      settingRow(card(), 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    expect(settingRow(card(), 'Automatic').textContent).toContain('Off');
    expect(mergeCheck().className).not.toContain('is-warn');
  });

  it('opens the tasks it names where the page keeps them, or links to the project when it keeps none', async () => {
    const opened: number[] = [];
    const { card } = await delivered({ onViewTasks: () => opened.push(1) });
    const view = card().querySelector<HTMLButtonElement>('button.start-card-link')!;
    expect(view.textContent).toBe(START_VIEW_TASKS);
    await act(async () => {
      view.click();
    });
    expect(opened).toEqual([1]);
  });

  it('links to the project’s tasks when the page keeps none of them', async () => {
    const { card } = await delivered();
    const link = card().querySelector<HTMLAnchorElement>('a.start-card-link');
    expect(link?.textContent).toBe(START_VIEW_TASKS);
    expect(new URL(link!.href, window.location.href).pathname).toBe(`/projects/${PROJECT}`);
    expect(card().querySelector('button.start-card-link')).toBeNull();
  });
});

describe('the press', () => {
  it('starts the project with the settings on the card and the request it answers, and goes', async () => {
    const { node, card } = await delivered();
    // The owner changes two settings from the suggestion before pressing.
    await type(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')!, '5');
    await act(async () => {
      settingRow(card(), 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await act(async () => {
      action(card(), START_PROJECT_ACTION).click();
    });
    await until(() => bodies.length === 1, 'the press to reach the door');
    expect(bodies[0]).toEqual({
      criteriaDigest: SEAL,
      line: 'PROJECT_BRANCH',
      projectBranchName: `refs/heads/project/${PROJECT}`,
      automatic: false,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'cd src/web && npx tsc -b && npx vitest run',
      requestId: 'item-1',
    });
    // The question is answered: the card goes, and the record is the conversation's to draw.
    await until(() => cardIn(node) === null, 'the answered card to go');
    await until(() => reports[reports.length - 1] === false, 'the page to be told');
  });

  it('keeps Start dead while the number of tasks is not one the door would take', async () => {
    const { card } = await delivered();
    await type(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')!, '');
    expect(action(card(), START_PROJECT_ACTION).disabled).toBe(true);
    await key();
    expect(bodies, 'the key started a project with no number of tasks').toEqual([]);
    await type(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')!, '2');
    expect(action(card(), START_PROJECT_ACTION).disabled).toBe(false);
  });

  it('starts on Enter and leaves Chat about this without a shortcut', async () => {
    const { card } = await delivered();
    await key({ metaKey: true });
    await key({ ctrlKey: true });
    expect(armed).toEqual([]);
    expect(bodies, 'the chord reached the door').toEqual([]);
    expect(card().querySelectorAll('textarea'), 'a text box grew inside the card').toHaveLength(0);

    await key();
    await until(() => bodies.length === 1, 'the bare key to press Start');
    expect(bodies[0]?.requestId).toBe('item-1');
  });

  it('says a refusal over the door’s own words, re-reads, and goes stale when the request no longer stands', async () => {
    server.door = async () => {
      // The criteria moved under the card: the request is superseded by the next read.
      server.standing = standingOf(MOVED);
      server.row = null;
      throw new ApiError(
        'The acceptance criteria changed after the version being confirmed was read.',
        409,
        'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED',
      );
    };
    const { card } = await delivered();
    await act(async () => {
      action(card(), START_PROJECT_ACTION).click();
    });
    await until(() => card().querySelector('.settlement-card-error') !== null, 'the refusal to be said');
    const refusal = card().querySelector('.settlement-card-error')?.textContent ?? '';
    expect(refusal).toContain(START_NOT_RECORDED);
    expect(refusal).toContain('The acceptance criteria changed');
    await until(() => card().querySelector('.settlement-card-stale')?.textContent === START_REQUEST_GONE,
      'the card to say its request no longer stands');
    // Still on screen, with nothing to start and the conversation still open to it.
    expect(action(card(), START_PROJECT_ACTION).disabled).toBe(true);
    expect(action(card(), OWNER_SEND_BACK_ACTION).disabled).toBe(false);
    expect(settingRow(card(), 'Merge check').querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('goes stale when the criteria moved past the seal it was asked about, before any press', async () => {
    const { qc, card } = await delivered();
    server.standing = standingOf(MOVED);
    await reread(qc);
    await until(() => card().querySelector('.settlement-card-stale')?.textContent === START_REQUEST_GONE,
      'the card to say its request no longer stands');
    expect(action(card(), START_PROJECT_ACTION).disabled).toBe(true);
    await key();
    expect(bodies).toEqual([]);
  });

  it('takes a new request with its own suggestions, whatever was edited on the old one', async () => {
    const { qc, card } = await delivered();
    await type(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')!, '9');
    server.row = rowOf('item-2', requestOf({
      settings: { line: 'MAIN', automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: null },
      why: 'a single fix',
    }));
    await reread(qc);
    await until(() => settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')?.value === '2',
      'the new suggestion to replace the edit');
    expect(settingRow(card(), 'Tasks land on').querySelector<HTMLInputElement>('input[value="MAIN"]')?.checked).toBe(true);
    expect(card().querySelector('.start-card-note')?.textContent).toBe('Coordinator: “a single fix”');
    await act(async () => {
      action(card(), START_PROJECT_ACTION).click();
    });
    await until(() => bodies.length === 1, 'the press');
    expect(bodies[0]).toMatchObject({ line: 'MAIN', maxConcurrentTasks: 2, requestId: 'item-2' });
    expect(bodies[0]).not.toHaveProperty('projectBranchName');
  });
});

describe('the compact project preview', () => {
  it('holds no shortcut until opened and keeps edited settings across close and reopen', async () => {
    const { node } = await mount();
    await until(() => node.querySelector('.review-card-preview') !== null, 'the preview');
    const preview = node.querySelector<HTMLElement>('#settlement-preview')!;
    preview.scrollIntoView = vi.fn();
    await key();
    expect(bodies).toEqual([]);
    await act(async () => { expect(revealSettlementCard()).toBe(true); });
    expect(preview.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
    expect(document.querySelector('.review-card-dialog[data-open]')).not.toBeNull();
    expect(bodies).toEqual([]);
    const field = () => settingRow(cardIn(node)!, 'Merge check').querySelector<HTMLInputElement>('input')!;
    await type(field(), 'npm run my-check');
    await act(async () => { document.querySelector<HTMLButtonElement>('.review-card-dialog [aria-label="Close"]')!.click(); });
    await key();
    expect(bodies).toEqual([]);
    await act(async () => { node.querySelector<HTMLButtonElement>('.review-card-preview')!.click(); });
    expect(field().value).toBe('npm run my-check');
    await act(async () => { action(cardIn(node)!, START_PROJECT_ACTION).click(); });
    await until(() => bodies.length === 1, 'the start decision');
    expect(bodies[0]).toMatchObject({ mergeCheckCommand: 'npm run my-check', requestId: 'item-1' });
  });
});
