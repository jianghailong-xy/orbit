// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOpenItemRow, ProjectStartRequest, StartProjectRequestBody } from '@orbit/shared';
import { api, ApiError } from '../api';
import { MOBILE_QUERY } from '../lib/useMediaQuery';
import { revealSettlementCard } from './DecisionRail';
import type { StandardSetConfirmationStanding } from '../lib/acceptanceConfirmation';
import {
  READY_TO_START,
  RUN_AUTOMATIC_HINT_MAIN,
  RUN_AUTOMATIC_HINT_PROJECT_BRANCH,
  RUN_AUTOMATIC_OFF,
  RUN_AUTOMATIC_OFF_MAIN,
  RUN_AUTOMATIC_ON_CHECKED,
  RUN_AUTOMATIC_ON_MAIN,
  RUN_AUTOMATIC_ON_UNCHECKED,
  RUN_LINE_MAIN_HINT,
  RUN_LINE_PROJECT_BRANCH_HINT,
  RUN_MERGE_CHECK_HINT,
  RUN_MERGE_CHECK_NONE_SAYS,
  START_CHAT_PLACEHOLDER,
  START_NOT_RECORDED,
  START_OPENS_COORDINATOR,
  START_PROJECT_ACTION,
  START_PROJECT_TITLE,
  START_REQUEST_GONE,
  START_VIEW_TASKS,
  planLevels,
  planTaskLabel,
  planTaskRest,
  runAutomaticSays,
  runSettingsLine,
  shortBranch,
  startAskedLine,
  startBarCaption,
  startComesToYou,
  startExplanation,
  startHowItRunsNote,
  startNobodyAskedLine,
  startPageRow,
  startPlanHead,
  startWithin,
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
import {
  ProjectStartDialog,
  SessionStartProjectCard,
  startBody,
  startDraftOf,
  startPlanView,
} from './StartProjectCard';

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
    // Filed empty since 2026-10-07: the check's warnings are the coordinator's.
    warnings: [],
    ...over,
  };
}

/** A warning an older server filed with a request, which the card no longer draws. */
const LEGACY_WARNING: ProjectStartRequest['warnings'][number] = {
  severity: 'WARN',
  code: 'START_CRITERION_CODELESS_UNDECLARED',
  message: 'criterion 1 is served only by work that looks like it produces no code',
  requiredAction: 'Declare the tasks that produce no code codeless',
  criterion: null,
  tasks: [],
};

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

/** The plan of the mock: A, then B and C, then D after B, then E after C and D — four tasks settled on
 *  their evidence and the last one, the go-live, confirmed by the owner. */
const GRAPH = {
  marks: [
    ['task-a', 'A · 提醒规则做成两端共用的真源', 'EVIDENCE_JUDGMENT'],
    ['task-b', 'B · OrbitKit：提醒规则、文案、DTO 与接口', 'EVIDENCE_JUDGMENT'],
    ['task-c', 'C · web：Runners 列表与 runner 详情页', 'EVIDENCE_JUDGMENT'],
    ['task-d', 'D · iOS/macOS：Runners 列表、Add Runner、Edit', 'EVIDENCE_JUDGMENT'],
    ['task-e', 'E · 上线', 'OWNER_CONFIRMED'],
  ].map(([id, title, completionCriterion]) => ({
    kind: 'TASK', id, taskId: id, title, status: 'OPEN', parentTaskId: null, completionCriterion, autoRunWhenReady: true,
  })),
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
  coordinatorSessionId: 'coordinator-1',
  exceptionEscalationSeconds: 7_200,
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
let narrow = false;

function answer<T>(value: Answer<T>): Promise<T> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

beforeEach(() => {
  narrow = false;
  startedCalls = 0;
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
  // The merge check's box grows with its command (antd's autoSize), which watches its own size.
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow && query === MOBILE_QUERY, media: query, onchange: null,
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

let startedCalls = 0;

async function mount(
  options: { router?: boolean; bare?: boolean; dialog?: boolean; onViewTasks?: () => void } = {},
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
        {options.dialog ? (
          <ProjectStartDialog projectId={PROJECT} asked open onClose={() => { startedCalls += 1; }} />
        ) : options.bare ? (
          <SessionStartProjectCard projectId={PROJECT} bare onStarted={() => { startedCalls += 1; }} />
        ) : options.router ? (
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
  expect(node.querySelector('.review-card-preview')).toBeNull();
  expect(node.contains(cardIn(node))).toBe(true);
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
  const row = [...card.querySelectorAll<HTMLElement>('.start-card-row')]
    .find((each) => each.querySelector('.start-card-row-head > span:first-child')?.textContent === label);
  if (!row) throw new Error(`no "${label}" row`);
  return row;
};
const comesToYou = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.start-card-comes li')].map((li) => li.textContent ?? '');
const levelsOf = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.start-card-level')].map((li) => li.textContent ?? '');

/** Types into a field the way the browser does: the native setter, then the event React reads. */
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The merge check, opened from its row: the command's own box. */
async function mergeCheckBox(card: HTMLElement): Promise<HTMLTextAreaElement> {
  const row = settingRow(card, 'Merge check');
  if (!row.querySelector('textarea')) {
    await act(async () => {
      row.querySelector<HTMLButtonElement>('.start-card-row-button')!.click();
    });
  }
  return settingRow(card, 'Merge check').querySelector<HTMLTextAreaElement>('textarea')!;
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
    expect(READY_TO_START).toBe('Ready to start');
    expect(RUN_LINE_PROJECT_BRANCH_HINT).toBe(
      'Recommended when tasks depend on each other: they land here first and are checked together.');
    expect(RUN_LINE_MAIN_HINT).toBe('For a single task or an urgent fix. Every merge into main asks you.');
    // How it runs after the start (the project page) keeps its longer sentences.
    expect(RUN_AUTOMATIC_HINT_PROJECT_BRANCH).toBe(
      'The coordinator runs it for you: it decides when each task is done, handles conflicts and failed '
      + 'checks, and merges the branch into main once the merge check passes — with a receipt you can '
      + 'revert. The criteria and anything irreversible stay yours.');
    expect(RUN_AUTOMATIC_HINT_MAIN).toContain(
      'Merging into main always asks you — a project that lands directly on main never merges by itself.');
    expect(RUN_MERGE_CHECK_HINT).toBe(
      'Runs on the combined tree before anything lands — on the project branch and again before main.');
    expect(startExplanation(4)).toBe(
      'Orbit derives done from these 4 criteria and nothing else. If they change later, it asks you to '
      + 'confirm the new version — the project keeps running.');
    expect(START_CHAT_PLACEHOLDER).toBe('What should change before it starts?');
    expect(acceptancePlanChangePlaceholder('START')).toBe(START_CHAT_PLACEHOLDER);
    expect(acceptancePlanChangePlaceholder()).toBe(ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER);
  });

  it('says who asked, what Automatic means for the line and the check, and whose settings these are', () => {
    expect(startAskedLine('56m ago')).toBe('The coordinator asked 56m ago');
    expect(startNobodyAskedLine(true)).toBe('Nobody asked yet');
    expect(startNobodyAskedLine(false)).toBe('Nobody asked yet · no coordinator yet');
    expect(runAutomaticSays(true, 'PROJECT_BRANCH', true)).toBe(RUN_AUTOMATIC_ON_CHECKED);
    expect(RUN_AUTOMATIC_ON_CHECKED).toBe(
      'The coordinator decides when each task is done and merges into main once the merge check passes '
      + '— with a receipt you can revert.');
    expect(runAutomaticSays(true, 'PROJECT_BRANCH', false)).toBe(RUN_AUTOMATIC_ON_UNCHECKED);
    expect(RUN_AUTOMATIC_ON_UNCHECKED).toContain('merges into main by itself');
    expect(runAutomaticSays(true, 'MAIN', true)).toBe(RUN_AUTOMATIC_ON_MAIN);
    expect(runAutomaticSays(false, 'PROJECT_BRANCH', true)).toBe(RUN_AUTOMATIC_OFF);
    expect(RUN_AUTOMATIC_OFF).toBe('You decide when each task is done and when the branch goes into main.');
    expect(runAutomaticSays(false, 'MAIN', false)).toBe(RUN_AUTOMATIC_OFF_MAIN);
    expect(START_OPENS_COORDINATOR).toBe(
      'This project has no coordinator yet. Orbit opens one where its tasks run when it starts.');
    expect(RUN_MERGE_CHECK_NONE_SAYS).toBe('Work lands once it rebases cleanly.');
    expect(startHowItRunsNote(true, true)).toBe(
      'Automatic is on by default (the coordinator suggested off). The rest is the coordinator’s '
      + 'suggestion. You can change any of these later on the project page.');
    expect(startHowItRunsNote(true, false)).toBe(
      'Automatic is on by default. The rest is the coordinator’s suggestion. You can change any of these '
      + 'later on the project page.');
    expect(startHowItRunsNote(false, false)).toBe(
      'Automatic is on by default. You can change any of these later on the project page.');
  });

  it('says under Start what pressing it does', () => {
    expect(startBarCaption({ opensCoordinator: false, startsNow: ['P1a'], criteria: 7, seal: '7c1e9a42' }))
      .toBe('Starts P1a now · confirms these 7 criteria · seal 7c1e9a42');
    expect(startBarCaption({ opensCoordinator: true, startsNow: ['P1a'], criteria: 7, seal: '7c1e9a42' }))
      .toBe('Opens a coordinator · starts P1a now · confirms these 7 criteria');
    expect(startBarCaption({ opensCoordinator: false, startsNow: [], criteria: 1, seal: 'abc' }))
      .toBe('Confirms this criterion · seal abc');
    expect(startBarCaption({ opensCoordinator: false, startsNow: ['A', 'B', 'C'], criteria: 2, seal: 'abc' }))
      .toBe('Starts A, B and C now · confirms these 2 criteria · seal abc');
  });

  it('writes the settings line the way the receipts do', () => {
    expect(shortBranch('refs/heads/project/34WvwUS8YMXfOfWbMqVuu')).toBe('project/34Wvw…');
    expect(shortBranch('refs/heads/release/next')).toBe('release/next');
    expect(runSettingsLine(requestOf().settings))
      .toBe('project/34Wvw… · Automatic on · 3 tasks at a time · merge check set');
    expect(runSettingsLine({ line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null }))
      .toBe('Directly into main · Automatic off · 1 task at a time · no merge check');
  });
});

describe('what still comes to the owner', () => {
  const p10 = [{ label: 'P10', title: '本部署切换到服务端执行' }];
  it('is, with Automatic on, the tasks they confirm, the criteria and what the coordinator cannot resolve', () => {
    expect(startComesToYou({
      automatic: true, line: 'PROJECT_BRANCH', ownerConfirmed: p10, evidenceJudged: 11, escalationSeconds: 7_200,
    })).toEqual([
      { text: 'P10 · 本部署切换到服务端执行', detail: 'you confirm it' },
      { text: 'Any change to the criteria', detail: null },
      { text: 'Problems it can’t resolve within 2 h', detail: null },
    ]);
    // Directly into main, every merge asks the owner whoever runs the project.
    expect(startComesToYou({
      automatic: true, line: 'MAIN', ownerConfirmed: [], evidenceJudged: 0, escalationSeconds: 1_800,
    }).map((item) => item.text)).toEqual([
      'Each merge into main', 'Any change to the criteria', 'Problems it can’t resolve within 30 min',
    ]);
  });

  it('is, with Automatic off, every decision the coordinator would have made', () => {
    expect(startComesToYou({
      automatic: false, line: 'PROJECT_BRANCH', ownerConfirmed: p10, evidenceJudged: 11, escalationSeconds: 7_200,
    })).toEqual([
      { text: 'Whether each task is done', detail: '11 reviews' },
      { text: 'P10 · 本部署切换到服务端执行', detail: 'you confirm it' },
      { text: 'Problems along the way', detail: 'conflicts, failed checks' },
      { text: 'Merging the branch into main', detail: null },
      { text: 'Any change to the criteria', detail: null },
    ]);
    expect(startComesToYou({
      automatic: false, line: 'MAIN', ownerConfirmed: [], evidenceJudged: 0, escalationSeconds: 7_200,
    })[0]).toEqual({ text: 'Whether each task is done', detail: null });
  });

  it('counts the tasks the owner confirms once there are more than a list should name', () => {
    const many = ['A', 'B', 'C', 'D'].map((label) => ({ label, title: `${label} task` }));
    expect(startComesToYou({
      automatic: true, line: 'PROJECT_BRANCH', ownerConfirmed: many, evidenceJudged: 0, escalationSeconds: 7_200,
    })[0]).toEqual({ text: '4 tasks you confirm', detail: null });
    expect(startWithin(7_200)).toBe('2 h');
    expect(startWithin(5_400)).toBe('2 h');
    expect(startWithin(600)).toBe('10 min');
  });
});

describe('the plan by level', () => {
  it('names each task by the marker its title opens with, and by its title when it has none', () => {
    expect(planTaskLabel('A · 提醒规则做成两端共用的真源')).toBe('A');
    expect(planTaskLabel('① 服务端 · 开工门')).toBe('①');
    expect(planTaskLabel('B：OrbitKit 接口')).toBe('B');
    expect(planTaskLabel('12) wire the card')).toBe('12');
    expect(planTaskLabel('Fix login redirect')).toBe('Fix login redirect');
    // "A new card" opens with a word, not a marker.
    expect(planTaskLabel('A new card for the start')).toBe('A new card for the start');
    expect(planTaskLabel('x'.repeat(40))).toBe(`${'x'.repeat(23)}…`);
    // A capital, one or two digits and at most one small letter is a code; a space after it is enough.
    expect(planTaskLabel('P1 Web：合并 Runners 与 Providers 为 Infrastructure 页')).toBe('P1');
    expect(planTaskLabel('P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链')).toBe('P5');
    expect(planTaskLabel('D12. wire the card')).toBe('D12');
    expect(planTaskLabel('P1a · wiki-worker 服务骨架与 System model 客户端')).toBe('P1a');
    expect(planTaskLabel('P12c: the third part')).toBe('P12c');
    expect(planTaskLabel('v2 API changes')).toBe('v2 API changes');
    expect(planTaskLabel('P123 three')).toBe('P123 three');
    expect(planTaskLabel('P1ab two letters')).toBe('P1ab two letters');
    // The rest of a title, once the plan names it by its label.
    expect(planTaskRest('P1a · wiki-worker 服务骨架', 'P1a')).toBe('wiki-worker 服务骨架');
    expect(planTaskRest('B：OrbitKit 接口', 'B')).toBe('OrbitKit 接口');
    expect(planTaskRest('Fix login redirect', 'Fix login redirect')).toBe('Fix login redirect');
  });

  it('puts each task one level after the deepest of what it waits on', () => {
    const tasks = GRAPH.marks.map((mark) => ({
      id: mark.id,
      title: mark.title,
      after: GRAPH.edges.filter((edge) => edge.targetMarkId === mark.id).map((edge) => edge.sourceMarkId),
      completionCriterion: mark.completionCriterion,
      autoRunWhenReady: mark.autoRunWhenReady,
    }));
    expect(planLevels(tasks).map((level) => level.map((task) => task.label))).toEqual([['A'], ['B', 'C'], ['D'], ['E']]);
    expect(planLevels(tasks)[0]?.[0]).toMatchObject({ label: 'A', now: true, you: false });
    expect(planLevels(tasks)[3]?.[0]).toMatchObject({ label: 'E', now: false, you: true });
    // A task set to start by hand does not start with the project.
    expect(planLevels([{ id: 'x', title: 'X · one', after: [], autoRunWhenReady: false }])[0]?.[0]?.now).toBe(false);
    // A prerequisite outside the plan — settled work, another project — waits on nothing here.
    expect(planLevels([{ id: 'x', title: 'X · one', after: ['elsewhere'] }])).toHaveLength(1);
    expect(startPlanHead(5, 4)).toBe('Plan · 5 tasks in 4 levels');
    expect(startPlanHead(1)).toBe('Plan · 1 task');
  });

  it('reads the plan off the graph: its levels, who confirms what, and what starts now', () => {
    const view = startPlanView(GRAPH, 0);
    expect(view.count).toBe(5);
    expect(view.levels?.map((level) => level.map((task) => task.label))).toEqual([['A'], ['B', 'C'], ['D'], ['E']]);
    expect(view.ownerConfirmed).toEqual([{ label: 'E', title: '上线' }]);
    expect(view.evidenceJudged).toBe(4);
    expect(view.startsNow).toEqual(['A']);
    // A folded plan is too big to list: it says how many, and nothing about their order.
    const folded = startPlanView({ ...GRAPH, folded: true, taskCount: 900 }, 0);
    expect(folded).toMatchObject({ count: 900, levels: null, ownerConfirmed: [], startsNow: [] });
  });
});

describe('what a press sends', () => {
  it('opens with Automatic on whatever the coordinator suggested', () => {
    const suggestedOff = requestOf({ settings: { ...requestOf().settings, automatic: false } });
    expect(startDraftOf(suggestedOff.settings)).toEqual({
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: 'cd src/web && npx tsc -b && npx vitest run',
    });
  });

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
  it('asks in order: who asks, what done is, how it runs and what comes to the owner, the plan, and Start', async () => {
    const { card } = await delivered();
    expect(card().querySelector('.settlement-card-heading')?.textContent).toBe(START_PROJECT_TITLE);
    expect(card().querySelector('.criteria-provenance')?.textContent).toBe(PROVENANCE_LABEL);
    // Who is asking, and in their own words.
    expect(card().querySelector('.start-card-project')?.textContent).toBe(TITLE);
    expect(card().querySelector('.settlement-card-meta')?.textContent).toBe(startAskedLine('just now'));
    expect(card().querySelector('.start-card-quote-text')?.textContent)
      .toBe('B and C both build on A — one branch checks them together before main.');
    // The three sections, in the order of the questions they answer.
    expect(sections(card())).toEqual(['Done when · 4 criteria', 'How it runs', 'Plan · 5 tasks in 4 levels']);
    // Every criterion is on the card before anything is pressed, clamped until read in full, and
    // what starting binds the project to under them.
    expect([...card().querySelectorAll('.settlement-card-criteria li')].map((li) => li.textContent))
      .toEqual(CRITERIA.map((c) => c.text));
    expect(card().querySelector('.settlement-card-read')?.textContent).toBe(acceptanceReadLabel(4));
    expect(card().querySelector('.start-card-note')?.textContent).toBe(startExplanation(4));
    // Automatic on, what it means with this merge check, and what still comes to the owner.
    const automatic = settingRow(card(), 'Automatic');
    expect(automatic.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(automatic.textContent).toContain(RUN_AUTOMATIC_ON_CHECKED);
    expect(automatic.textContent).not.toContain(START_OPENS_COORDINATOR);
    expect(comesToYou(card())).toEqual([
      'E · 上线 · you confirm it',
      'Any change to the criteria',
      'Problems it can’t resolve within 2 h',
    ]);
    // The three settings that can change later, one row each.
    expect(settingRow(card(), 'Tasks land on').querySelector('.ant-select-content')?.getAttribute('title'))
      .toBe('A project branch');
    expect(settingRow(card(), 'Merge check').querySelector('.start-card-row-value')?.textContent).toBe('Set ›');
    expect(settingRow(card(), 'At most').querySelector<HTMLInputElement>('input')?.value).toBe('3');
    expect(settingRow(card(), 'At most').textContent).toContain('tasks at a time');
    expect(card().querySelectorAll('.start-card-note')[1]?.textContent).toBe(startHowItRunsNote(true, false));
    // The plan by level: what starts now, what runs side by side, and who confirms the last one.
    expect(levelsOf(card())).toEqual([
      '1A提醒规则做成两端共用的真源Now',
      '2B · C2 in parallel',
      '3DiOS/macOS：Runners 列表、Add Runner、Edit',
      '4E上线You',
    ]);
    // No warning of the ready check, and no check line: they are the coordinator's.
    expect(card().querySelector('.start-card-warn')).toBeNull();
    expect(card().querySelector('.start-card-checked')).toBeNull();
    // Start, and the line saying what it does.
    expect(actionsOf(card()).map(labelOf)).toEqual([START_PROJECT_ACTION, OWNER_SEND_BACK_ACTION]);
    expect(card().querySelector('.start-card-caption')?.textContent)
      .toBe(`Starts A now · confirms these 4 criteria · seal ${shortSeal(SEAL)}`);
    // The primary action shows Enter; Chat about this has no shortcut.
    expect(action(card(), START_PROJECT_ACTION).querySelector('.approval-kbd')?.textContent).toBe(ENTER_HINT);
    expect(action(card(), OWNER_SEND_BACK_ACTION).querySelector('.approval-kbd')).toBeNull();
  });

  it('opens with Automatic on when the coordinator suggested off, and says so beside it', async () => {
    server.row = rowOf('item-1', requestOf({ settings: { ...requestOf().settings, automatic: false } }));
    const { card } = await delivered();
    expect(settingRow(card(), 'Automatic').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(card().querySelectorAll('.start-card-note')[1]?.textContent).toBe(startHowItRunsNote(true, true));
  });

  it('draws none of the warnings an older request was filed with', async () => {
    server.row = rowOf('item-1', requestOf({ warnings: [LEGACY_WARNING] }));
    const { card } = await delivered();
    expect(card().textContent).not.toContain(LEGACY_WARNING.message);
    expect(card().querySelector('.start-card-warn')).toBeNull();
  });

  it('lists what comes to the owner with Automatic off, and says an empty merge check plainly', async () => {
    const { card } = await delivered();
    await act(async () => {
      settingRow(card(), 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    expect(settingRow(card(), 'Automatic').textContent).toContain(RUN_AUTOMATIC_OFF);
    expect(comesToYou(card())).toEqual([
      'Whether each task is done · 4 reviews',
      'E · 上线 · you confirm it',
      'Problems along the way · conflicts, failed checks',
      'Merging the branch into main',
      'Any change to the criteria',
    ]);
    // Back on: an empty merge check is a choice like any other — None, what it means, nothing amber.
    await act(async () => {
      settingRow(card(), 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await type(await mergeCheckBox(card()), '');
    await act(async () => {
      settingRow(card(), 'Merge check').querySelector<HTMLButtonElement>('.start-card-row-button')!.click();
    });
    expect(settingRow(card(), 'Merge check').querySelector('.start-card-row-value')?.textContent).toBe('None ›');
    expect(settingRow(card(), 'Merge check').textContent).toContain(RUN_MERGE_CHECK_NONE_SAYS);
    expect(settingRow(card(), 'Automatic').textContent).toContain(RUN_AUTOMATIC_ON_UNCHECKED);
    expect(card().querySelector('.is-warn, .start-card-warn')).toBeNull();
  });

  it('opens the tasks it names where the page keeps them, or links to the project when it keeps none', async () => {
    const opened: number[] = [];
    const { card } = await delivered({ onViewTasks: () => opened.push(1) });
    const view = card().querySelector<HTMLButtonElement>('.start-card-plan button.start-card-link')!;
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
    expect(card().querySelector('.start-card-plan button.start-card-link')).toBeNull();
  });
});

describe('which start row a page draws', () => {
  it('draws the request once asked, the owner’s own Start… once the read says nobody asked, and nothing else', () => {
    const row = rowOf('item-1');
    expect(startPageRow(false, { startRequest: row })).toEqual({ kind: 'asked', row });
    expect(startPageRow(false, { startRequest: null })).toEqual({ kind: 'own' });
    // A read still on its way is not a project nobody asked about, nor is a read that does not say.
    expect(startPageRow(false, undefined)).toBeNull();
    expect(startPageRow(null, { startRequest: null })).toBeNull();
    expect(startPageRow(true, { startRequest: row })).toBeNull();
  });
});

describe('the card answered over the project’s sessions page', () => {
  it('draws the same request bare — no review around it, no Chat about this — and says once it went through', async () => {
    const { node } = await mount({ bare: true });
    await until(() => cardIn(node) !== null && cardIn(node)!.querySelector('.start-card-plan span') !== null, 'the card');
    expect(document.querySelector('.review-card-preview')).toBeNull();
    expect(actionsOf(cardIn(node)!).map(labelOf)).toEqual([START_PROJECT_ACTION]);
    await act(async () => {
      action(cardIn(node)!, START_PROJECT_ACTION).click();
    });
    await until(() => bodies.length === 1, 'the press to reach the door');
    expect(bodies[0]?.requestId).toBe('item-1');
    await until(() => startedCalls === 1, 'the page to be told the start went through');
  });

  it('says the request no longer stands, rather than drawing an empty dialog', async () => {
    server.row = null;
    const { node } = await mount({ bare: true });
    await until(() => node.textContent?.includes(START_REQUEST_GONE) ?? false, 'the sentence that says so');
    expect(cardIn(node)).toBeNull();
  });

  it.each([[false, '.start-card-dialog'], [true, '.start-card-sheet']] as const)(
    'puts the card up as a dialog on a wide screen and a sheet on a phone (phone=%s)', async (phone, shell) => {
      narrow = phone;
      await mount({ dialog: true });
      await until(() => document.querySelector(`${shell} .start-card`) !== null, `the card in ${shell}`);
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
    expect(settingRow(card(), 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
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
    expect(settingRow(card(), 'Tasks land on').querySelector('.ant-select-content')?.getAttribute('title'))
      .toBe('Directly into main');
    expect(card().querySelector('.start-card-quote-text')?.textContent).toBe('a single fix');
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
    narrow = true;
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
    await type(await mergeCheckBox(cardIn(node)!), 'npm run my-check');
    await act(async () => { document.querySelector<HTMLButtonElement>('.review-card-dialog [aria-label="Close"]')!.click(); });
    await key();
    expect(bodies).toEqual([]);
    await act(async () => { node.querySelector<HTMLButtonElement>('.review-card-preview')!.click(); });
    expect((await mergeCheckBox(cardIn(node)!)).value).toBe('npm run my-check');
    await act(async () => { action(cardIn(node)!, START_PROJECT_ACTION).click(); });
    await until(() => bodies.length === 1, 'the start decision');
    expect(bodies[0]).toMatchObject({ mergeCheckCommand: 'npm run my-check', requestId: 'item-1' });
  });
});
