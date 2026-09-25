// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://orbit.wikova.com/s/Qm4kT9vR2mT7wLp4sYb8nZc1eHf6uJaB"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SharedEvent,
  SharedProject,
  SharedProjectTaskPage,
  SharedProjectTaskRow,
  SharedSession,
  SharedTask,
} from '../api';
import { PROJECT_PAGE_BLOCKS } from '../components/ProjectPageBlocks';
import { encodeId } from '../lib/idCodec';
import { projectLinkResolver } from '../lib/publicLinks';
import { ProjectDetailPage } from './ProjectsPage';
import { SharedLinkPage, SharedProjectTaskRoute } from './SharedLinkPage';
import { SharedSessionPage } from './SharedSessionPage';

/**
 * A project link's pages (docs/share-links-design.md §1, §7; mocks 04 and 07), mounted whole on the
 * routes that serve them: `/s/<token>` — the project's page — `/s/<token>/t/<id>` for one of its
 * tasks, and `/s/<token>/c/<id>` for a run or the coordinator. What is held here:
 *
 *  - the page keeps the app project page's seven public blocks in the app's own order, and none of
 *    the other nine — the app's order is read off the app page itself, rendered from the same
 *    project, not off a list this file keeps;
 *  - with Task pages, the task graph and the task list open the project's tasks at /s/<token>/t/<id>;
 *    without, they name them as words; with Conversations, the Work overview and the prose open the
 *    coordinator's conversation;
 *  - the criteria read as the app's card reads them, in its words, with no branch named;
 *  - a task page and a run's page lead back through the project — Project › Task › Run;
 *  - no link on any of them goes into the app;
 *  - a phone gets the app's phone reading.
 */

// The app page is rendered statically below; its own reads never resolve there.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));
// React Flow measures its canvas with a ResizeObserver jsdom does not have, so the canvas is not
// mounted here. What decides where a node goes is the node, and each task mark is drawn by the
// canvas's own node component, under whatever resolver the page provides.
vi.mock('../components/ProjectDependencyGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ProjectDependencyGraph')>();
  const { createElement } = await import('react');
  const { ReactFlowProvider } = await import('@xyflow/react');
  const TaskNode = actual.NODE_TYPES.projectDependencyTask as unknown as (props: object) => null;
  return {
    ...actual,
    ProjectDependencyGraph: ({ data }: { data?: { marks: Array<{ kind: string; id: string }> } }) =>
      createElement(
        'div',
        { 'data-testid': 'project-dependency-graph' },
        createElement(
          ReactFlowProvider,
          null,
          ...(data?.marks ?? [])
            .filter((mark) => mark.kind === 'TASK')
            .map((mark) =>
              createElement(TaskNode, {
                key: mark.id,
                id: mark.id,
                data: { task: mark, hasIncoming: false, hasOutgoing: false, vertical: false, waitingOn: 0 },
              }),
            ),
        ),
      ),
  };
});
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const TOKEN = 'Qm4kT9vR2mT7wLp4sYb8nZc1eHf6uJaB';
const SHARE = `/api/shared/${TOKEN}`;
const PROJECT = encodeId('01a06f00-0000-7000-8000-000000000001');
const T1 = encodeId('01a06f00-0000-7000-8000-0000000000a1');
const T2 = encodeId('01a06f00-0000-7000-8000-0000000000a2');
const T3 = encodeId('01a06f00-0000-7000-8000-0000000000a3');
const T4 = encodeId('01a06f00-0000-7000-8000-0000000000a4');
/** A task in another project, which the goal names. */
const ELSEWHERE = encodeId('01a06f00-0000-7000-8000-0000000000b1');
const COORDINATOR = encodeId('01a06f00-0000-7000-8000-0000000000c1');
/** T3's run. */
const RUN = encodeId('01a06f00-0000-7000-8000-0000000000c2');

const TITLE = 'Claude 账号池：按订阅配额均衡派发';
const TASK_TITLES: Record<string, string> = {
  [T1]: 'T1 池身份与迁移',
  [T2]: 'T2 选择器纯函数',
  [T3]: 'T3 claim 接线',
  [T4]: 'T4 刹车让路',
};
const PROJECT_BRANCH = `project/${PROJECT}`;

/** What every piece of prose on these pages links to: one of the project's tasks, a task in another
 *  project, the coordinator's conversation and the project itself. */
const REFERENCES =
  `See [T1](orbit-task:${T1}), [another project's task](orbit-task:${ELSEWHERE}), ` +
  `[the coordinator](orbit-session:${COORDINATOR}) and [the project](orbit-project:${PROJECT}).`;

function row(id: string, over: Partial<SharedProjectTaskRow>): SharedProjectTaskRow {
  return {
    id,
    title: TASK_TITLES[id],
    status: 'OPEN',
    workState: 'BLOCKED',
    landing: null,
    dependencyState: 'READY',
    landingWaitCount: 0,
    topoLevel: 0,
    unmetCount: 0,
    blocksCount: 0,
    childCount: 0,
    ...over,
  };
}

type Layers = { taskPages: boolean; commentsAndFiles: boolean; conversations: boolean };

/** GET /shared/:token for the project (share-links/public-project.ts's projection). */
function projectRoot(layers: Layers, criteriaCount = 3) {
  const include = {
    taskPages: layers.taskPages,
    commentsAndFiles: layers.taskPages && layers.commentsAndFiles,
    conversations: layers.taskPages && layers.conversations,
    toolOutput: true,
  };
  const criteria: SharedProject['criteria'] = [
    { ordinal: 1, text: '同一 owner 的多行 Anthropic 订阅 provider 可以归入一个池。', verificationMethod: 'The pg spec passes.', satisfied: true, landing: 'ON_MAIN', heldUpBy: [] },
    { ordinal: 2, text: '派发时选中的凭据是池内窗口占用最低的那一行。', verificationMethod: null, satisfied: true, landing: 'NOT_ON_MAIN_YET', heldUpBy: [] },
    { ordinal: 3, text: '客户端能看到池内每个成员各自的窗口占用。', verificationMethod: null, satisfied: false, landing: 'NO_MERGE_RECEIPT', heldUpBy: [{ id: T3, title: TASK_TITLES[T3], status: 'OPEN' }] },
  ];
  for (let ordinal = 4; ordinal <= criteriaCount; ordinal++) {
    criteria.push({ ordinal, text: `Criterion ${ordinal}.`, verificationMethod: null, satisfied: false, landing: 'NO_MERGE_RECEIPT', heldUpBy: [] });
  }
  const root: SharedProject = {
    id: PROJECT,
    title: TITLE,
    status: 'OPEN',
    createdAt: '2026-09-05T08:00:00.000Z',
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    taskCount: 4,
    overview: {
      buckets: {
        running: 1, ready: 0, blocked: 1, awaitingVerification: 0, done: 2, failed: 0, cancelled: 0,
        integrating: 0, onIntegrationLine: 1, onUpstream: 1, doneNotIntegrated: 0, waitingForLanding: 0,
      },
      shape: { taskCount: 4, edgeCount: 3, ratio: 0.75, maxDepth: 3, form: 'chain' },
      integrationLine: 'PROJECT_BRANCH',
    },
    ...(include.conversations ? { coordinator: { sessionId: COORDINATOR } } : {}),
    goal: `把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份。\n\n${REFERENCES}`,
    graph: {
      marks: [
        { kind: 'TASK', id: T1, taskId: T1, title: TASK_TITLES[T1], status: 'DONE', parentTaskId: null, running: false, queued: false, workState: 'DONE' },
        { kind: 'TASK', id: T2, taskId: T2, title: TASK_TITLES[T2], status: 'DONE', parentTaskId: null, running: false, queued: false, workState: 'DONE' },
        { kind: 'TASK', id: T3, taskId: T3, title: TASK_TITLES[T3], status: 'OPEN', parentTaskId: null, running: true, queued: false, workState: 'RUNNING' },
        { kind: 'TASK', id: T4, taskId: T4, title: TASK_TITLES[T4], status: 'OPEN', parentTaskId: null, running: false, queued: false, workState: 'BLOCKED' },
      ],
      edges: [
        { sourceMarkId: T1, targetMarkId: T2 },
        { sourceMarkId: T2, targetMarkId: T3 },
        { sourceMarkId: T3, targetMarkId: T4 },
      ],
      taskCount: 4,
      folded: false,
      truncated: false,
      limits: { maxTasks: 50_000, maxMarks: 500 },
    },
    chain: {
      current: { id: T3, title: TASK_TITLES[T3], status: 'OPEN' },
      next: { id: T4, title: TASK_TITLES[T4], status: 'OPEN' },
    },
    criteria,
    tasks: {
      items: [
        row(T4, { dependencyState: 'BLOCKED', topoLevel: 3, unmetCount: 1 }),
        row(T3, { workState: 'RUNNING', topoLevel: 2, blocksCount: 1 }),
        row(T2, { status: 'DONE', workState: 'DONE', landing: 'ON_PROJECT_BRANCH', topoLevel: 1, blocksCount: 1 }),
        row(T1, { status: 'DONE', workState: 'DONE', landing: 'ON_MAIN', blocksCount: 1 }),
      ],
      hasMore: false,
    },
  };
  const scope = {
    projectId: PROJECT,
    tasks: layers.taskPages ? [T4, T3, T2, T1].map((id) => ({ id })) : [],
    conversations: include.conversations ? [{ id: COORDINATOR }, { id: RUN }] : [],
  };
  return { kind: 'PROJECT' as const, include, sharedAt: '2026-09-25T08:00:00.000Z', root, scope };
}

/** GET /shared/:token/tasks/T3: the task link's projection of it, with the project link's scope. */
function taskPage(layers: Layers): SharedProjectTaskPage {
  const { include, scope } = projectRoot(layers);
  const root: SharedTask = {
    id: T3,
    title: TASK_TITLES[T3],
    status: 'OPEN',
    outcome: 'OPEN',
    supersededBy: null,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    createdAt: '2026-09-05T08:00:00.000Z',
    project: { title: TITLE },
    description: `Wire the claim.\n\n${REFERENCES}`,
    acceptanceCriteria: 'The claim picks the loosest member.',
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    dependencies: {
      prerequisites: [{ id: T2, title: TASK_TITLES[T2], status: 'DONE' }],
      dependents: [{ id: T4, title: TASK_TITLES[T4], status: 'OPEN' }],
      prerequisitesInOtherProjects: 1,
      dependentsInOtherProjects: 0,
    },
    runs: [
      {
        state: 'RUNNING',
        startedAt: '2026-09-25T07:00:00.000Z',
        endedAt: null,
        durationMs: null,
        ...(include.conversations ? { sessionId: RUN } : {}),
      },
    ],
  };
  return { include, root, scope };
}

/** GET /shared/:token/sessions/:id under the project link: a run of T3, or the coordinator. */
function conversation(of: 'run' | 'coordinator'): SharedSession {
  const events: SharedEvent[] = [
    { type: 'assistant', payload: { text: REFERENCES }, turnId: null, ts: '2026-09-25T07:01:00.000Z', seq: 2 },
  ];
  return {
    title: of === 'run' ? 'Run of T3' : 'Claude 账号池 coordinator',
    workspaceName: 'orbit',
    status: 'RUNNING',
    runStatus: 'RUNNING',
    sessionState: 'RUNNING',
    runState: 'RUNNING',
    lifecycleState: 'OPEN',
    filingState: 'OPEN',
    createdAt: '2026-09-25T07:00:00.000Z',
    events,
    hasMore: false,
    project: { title: TITLE },
    task: of === 'run' ? { id: T3, title: TASK_TITLES[T3], runs: [{ sessionId: RUN }] } : null,
    scope: projectRoot({ taskPages: true, commentsAndFiles: false, conversations: true }).scope,
  };
}

let container: HTMLDivElement;
let root: Root;
let requests: string[];
let layers: Layers;
let criteriaCount: number;

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'shared link not found' }) }) as Response;

/** The link's routes, as SharedController serves them. */
function share(url: string): Response {
  const u = new URL(url, window.location.origin);
  if (u.pathname === SHARE) return okJson(projectRoot(layers, criteriaCount));
  if (u.pathname === `${SHARE}/tasks/${T3}` && layers.taskPages) return okJson(taskPage(layers));
  if (u.pathname === `${SHARE}/sessions/${RUN}`) return okJson(conversation('run'));
  if (u.pathname === `${SHARE}/sessions/${COORDINATOR}`) return okJson(conversation('coordinator'));
  return notFound();
}

/** A phone answers the app's phone breakpoints; a desktop answers none of them. */
function stubViewport(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && /max-width: (560|600|640|960)px/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  layers = { taskPages: true, commentsAndFiles: false, conversations: false };
  criteriaCount = 3;
  stubViewport(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return share(url);
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/s/:token" element={<SharedLinkPage />} />
            <Route path="/s/:token/c/:sessionId" element={<SharedSessionPage />} />
            <Route path="/s/:token/t/:taskId" element={<SharedProjectTaskRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The graph is behind a lazy() boundary; wait until it has been drawn rather than its fallback. */
async function graphDrawn() {
  await vi.waitFor(() => expect(container.querySelector('[data-testid="project-dependency-graph"]')).not.toBeNull(), {
    timeout: 20_000,
    interval: 50,
  });
  await settle();
}

/** The page's blocks, top to bottom, as the page marks them. */
const blocks = () =>
  [...container.querySelectorAll<HTMLElement>('[data-project-block]')].map((el) => el.dataset.projectBlock);
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
const linkNamed = (text: string) =>
  [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)?.getAttribute('href') ?? null;
/** Links into the app: each of them ends at the sign-in page for whoever reads a public page. */
const appHrefs = () => hrefs().filter((href) => /^\/(tasks|projects|sessions|following|settings|workspaces|providers)\b/.test(href));
const crumbs = () =>
  [...container.querySelectorAll('.share-crumbs .share-crumb')].map((el) => ({
    label: el.textContent,
    to: el.getAttribute('href'),
  }));

/**
 * The app project page's own blocks, in the order it draws them — read off the page itself, with
 * the same project's owner document in its cache, not off PROJECT_PAGE_BLOCKS.
 */
function appPageBlocks(): string[] {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['project', PROJECT], {
    id: PROJECT,
    title: TITLE,
    status: 'OPEN',
    goal: 'The goal.',
    instructions: 'What the agents are told.',
    createdAt: '2026-09-05T08:00:00.000Z',
    updatedAt: '2026-09-25T08:00:00.000Z',
    _count: { tasks: 4 },
    tasksByStatus: { OPEN: 2, DONE: 2 },
    coordinatorEnabled: true,
    configRevision: '1',
    acceptanceCriteriaItems: [],
    blockers: { open: [], resolved: [], resolvedCount: 0 },
    integration: { line: 'PROJECT_BRANCH', ref: PROJECT_BRANCH, upstreamRef: 'main' },
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return [...html.matchAll(/data-project-block="([^"]+)"/g)].map((m) => m[1]);
}

const PUBLIC_BLOCKS = PROJECT_PAGE_BLOCKS.filter((block) => block.public).map((block) => block.key);
const OWNER_BLOCKS = PROJECT_PAGE_BLOCKS.filter((block) => !block.public).map((block) => block.key);

describe('a project link’s public page', { timeout: 60_000 }, () => {
  it('keeps the app project page’s seven blocks in the app’s order, and none of the other nine', async () => {
    // The app page, as its owner reads it: every one of its sixteen blocks, in the order it draws them.
    const app = appPageBlocks();
    expect(app).toEqual(PROJECT_PAGE_BLOCKS.map((block) => block.key));

    await mount(`/s/${TOKEN}`);
    expect(requests).toEqual([`${SHARE}?limit=200&maxPayload=2048`]);
    // The public page: the app's order with the owner's blocks taken out, and nothing moved.
    expect(blocks()).toEqual(app.filter((key) => (PUBLIC_BLOCKS as readonly string[]).includes(key)));
    expect(blocks()).toEqual(['header', 'work-overview', 'goal', 'task-graph', 'chain-progress', 'acceptance-criteria', 'tasks']);
    for (const key of OWNER_BLOCKS) {
      expect(container.querySelector(`[data-project-block="${key}"]`), key).toBeNull();
    }
    // …and nothing an owner acts with: the header's presses, the banners, the New task door.
    const text = container.textContent ?? '';
    for (const owners of [
      'Record as done', 'Record as cancelled', 'Delete project', 'New task', 'Instructions',
      'Dispatch needs attention', 'Check providers', 'Ready to wrap up', 'Copy link', 'Copy as Markdown',
    ]) {
      expect(text, owners).not.toContain(owners);
    }
    expect(container.querySelectorAll('button.ant-btn-primary, .ant-btn-dangerous')).toHaveLength(0);
  });

  it('draws each block from the link: the header, the overview, the goal, the chain and the tasks in their bands', async () => {
    await mount(`/s/${TOKEN}`);
    const header = container.querySelector('[data-project-block="header"]')!.textContent!;
    expect(container.querySelector('h2')?.textContent).toBe(TITLE);
    expect(header).toContain('Open');
    expect(header).toContain('4 tasks');
    expect(header).toContain('Started Sep 5');
    expect(header).toContain('Last activity 1m ago');

    const overview = container.querySelector('[data-project-block="work-overview"]')!.textContent!;
    for (const lane of ['Running', 'Ready', 'Waiting', 'Integrating', 'On project branch', 'On main']) {
      expect(overview).toContain(lane);
    }
    expect(overview).toContain('4 tasks · 3 dependencies');
    expect(container.querySelector('[data-project-block="goal"]')!.textContent).toContain('可派发的池身份');
    expect(container.querySelector('[data-project-block="chain-progress"]')!.textContent).toContain('Step 3 / 4 · T3 claim 接线');

    // The Tasks block in the app's bands: what is running, what waits, what landed — each row with
    // no acceptance excerpt, and a landed row naming no branch.
    const bands = [...container.querySelectorAll<HTMLElement>('[data-topo-group]')].map((el) => el.dataset.topoGroup);
    expect(bands).toEqual(['running', 'level-3', 'landed']);
    const tasks = container.querySelector('[data-project-block="tasks"]')!.textContent!;
    expect(tasks).toContain('On the project branch');
    expect(tasks).toContain('On main');
    expect(tasks).toContain('waits 1');
    expect(tasks).not.toContain(PROJECT_BRANCH);
    expect(tasks).not.toContain('No acceptance criteria set');
  });

  it('with Task pages, the task graph and the task list open the project’s tasks at /s/<token>/t/<id>', async () => {
    await mount(`/s/${TOKEN}`);
    await graphDrawn();
    const graphLinks = [...container.querySelectorAll('[data-testid="project-dependency-graph"] a')].map((a) => a.getAttribute('href'));
    expect(graphLinks).toEqual([T1, T2, T3, T4].map((id) => `/s/${TOKEN}/t/${id}`));
    const listLinks = [...container.querySelectorAll('[data-project-block="tasks"] a.share-project-task')].map((a) => a.getAttribute('href'));
    expect(listLinks).toEqual([T3, T4, T2, T1].map((id) => `/s/${TOKEN}/t/${id}`));
    // The task holding a criterion open, and the goal's reference to one of the project's tasks.
    expect(linkNamed(TASK_TITLES[T3] + '')).toBe(`/s/${TOKEN}/t/${T3}`);
    expect(linkNamed('T1')).toBe(`/s/${TOKEN}/t/${T1}`);
    expect(linkNamed('the project')).toBe(`/s/${TOKEN}`);
    // Outside the link — another project's task, the coordinator with Conversations off — words.
    expect(linkNamed('another project\'s task')).toBeNull();
    expect(linkNamed('the coordinator')).toBeNull();
    expect(container.textContent).toContain('the coordinator');
    expect(container.textContent).not.toContain('Coordinator conversation');
    expect(container.textContent).toContain('Click a task to open its page.');
    expect(appHrefs()).toEqual([]);
  });

  it('without Task pages, the graph and the list name the tasks without opening them', async () => {
    layers = { taskPages: false, commentsAndFiles: true, conversations: true };
    await mount(`/s/${TOKEN}`);
    await graphDrawn();
    expect(hrefs().filter((href) => href.includes('/t/'))).toEqual([]);
    const graph = container.querySelector('[data-testid="project-dependency-graph"]')!;
    expect(graph.querySelectorAll('a')).toHaveLength(0);
    for (const id of [T1, T2, T3, T4]) expect(graph.textContent).toContain(TASK_TITLES[id]);
    expect(container.querySelector('[data-project-block="tasks"]')!.textContent).toContain(TASK_TITLES[T4]);
    // Comments & files and Conversations sit under Task pages: off with it, whatever they say.
    expect(container.textContent).not.toContain('Coordinator conversation');
    expect(container.textContent).not.toContain('Click a task to open its page.');
    expect(appHrefs()).toEqual([]);
  });

  it('with Conversations, the Work overview and the prose open the coordinator’s conversation', async () => {
    layers = { taskPages: true, commentsAndFiles: false, conversations: true };
    await mount(`/s/${TOKEN}`);
    expect(linkNamed('Coordinator conversation ›')).toBe(`/s/${TOKEN}/c/${COORDINATOR}`);
    expect(linkNamed('the coordinator')).toBe(`/s/${TOKEN}/c/${COORDINATOR}`);
    expect(appHrefs()).toEqual([]);
  });

  it('reads the criteria as the app’s card does — in its words, with no branch named', async () => {
    await mount(`/s/${TOKEN}`);
    const card = container.querySelector('[data-project-block="acceptance-criteria"]')!;
    const rows = [...card.querySelectorAll('.acceptance-row')].map((el) => el.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(card.textContent).toContain('3 criteria stated. Whether one is met is read off the work filed under it');
    expect(rows[0]).toContain('Met by its work');
    expect(rows[0]).toContain('on main');
    expect(rows[1]).toContain('on the project branch · not on main yet');
    expect(rows[2]).toContain('Not met by its work');
    // The task holding it, and how it stands — not the action its owner would take.
    expect(rows[2]).toContain(TASK_TITLES[T3]);
    expect(rows[2]).toContain('Open');
    expect(card.textContent).not.toContain('needs evidence submitted');
    expect(card.textContent).not.toContain(PROJECT_BRANCH);
    // How it is checked, behind the card's own disclosure.
    expect(card.textContent).toContain('How it\'s checked');
  });

  it('a task page under the link leads back to the project, and its links go where the project link sends them', async () => {
    layers = { taskPages: true, commentsAndFiles: false, conversations: true };
    await mount(`/s/${TOKEN}/t/${T3}`);
    expect(requests).toEqual([`${SHARE}/tasks/${T3}`]);
    expect(container.querySelector('h1')?.textContent).toBe(TASK_TITLES[T3]);
    // Project › Task.
    expect(crumbs()).toEqual([
      { label: TITLE, to: `/s/${TOKEN}` },
      { label: TASK_TITLES[T3], to: null },
    ]);
    expect(linkNamed(TASK_TITLES[T2])).toBe(`/s/${TOKEN}/t/${T2}`);
    expect(linkNamed(TASK_TITLES[T4])).toBe(`/s/${TOKEN}/t/${T4}`);
    expect(linkNamed('View conversation ›')).toBe(`/s/${TOKEN}/c/${RUN}`);
    expect(linkNamed('the coordinator')).toBe(`/s/${TOKEN}/c/${COORDINATOR}`);
    expect(linkNamed('another project\'s task')).toBeNull();
    expect(container.textContent).toContain('1 prerequisite in another project');
    expect(appHrefs()).toEqual([]);
  });

  it('a task page the link does not open is the page a dead link shows', async () => {
    layers = { taskPages: false, commentsAndFiles: false, conversations: false };
    await mount(`/s/${TOKEN}/t/${T3}`);
    expect(container.textContent).toContain('This shared link isn’t available');
  });

  it('a run’s page reads Project › Task › Run, and the coordinator’s Project › Coordinator', async () => {
    await mount(`/s/${TOKEN}/c/${RUN}`);
    expect(crumbs()).toEqual([
      { label: TITLE, to: `/s/${TOKEN}` },
      { label: TASK_TITLES[T3], to: `/s/${TOKEN}/t/${T3}` },
      { label: 'Run · Sep 25', to: null },
    ]);
    expect(linkNamed('T1')).toBe(`/s/${TOKEN}/t/${T1}`);
    expect(linkNamed('the coordinator')).toBe(`/s/${TOKEN}/c/${COORDINATOR}`);
    expect(appHrefs()).toEqual([]);

    act(() => root.unmount());
    root = createRoot(container);
    await mount(`/s/${TOKEN}/c/${COORDINATOR}`);
    expect(crumbs()).toEqual([
      { label: TITLE, to: `/s/${TOKEN}` },
      { label: 'Coordinator', to: null },
    ]);
    expect(appHrefs()).toEqual([]);
  });

  it('on a phone, reads as the app’s phone page: four criteria, then the rest behind one button', async () => {
    stubViewport(true);
    criteriaCount = 7;
    await mount(`/s/${TOKEN}`);
    expect(blocks()).toEqual(['header', 'work-overview', 'goal', 'task-graph', 'chain-progress', 'acceptance-criteria', 'tasks']);
    const card = container.querySelector('[data-project-block="acceptance-criteria"]')!;
    expect(card.querySelectorAll('.acceptance-row')).toHaveLength(4);
    expect(card.textContent).toContain('View all 7 criteria');
  });
});

describe('projectLinkResolver', () => {
  it('sends the project, its tasks and its conversations to the link’s pages, and nothing else anywhere', () => {
    const resolve = projectLinkResolver(TOKEN, { projectId: PROJECT, taskIds: [T1, T3], sessionIds: [RUN] });
    expect(resolve({ kind: 'project', id: PROJECT })).toBe(`/s/${TOKEN}`);
    expect(resolve({ kind: 'task', id: T1 })).toBe(`/s/${TOKEN}/t/${T1}`);
    expect(resolve({ kind: 'session', id: RUN })).toBe(`/s/${TOKEN}/c/${RUN}`);
    // Either spelling of an id is the same object.
    expect(resolve({ kind: 'task', id: '01a06f00-0000-7000-8000-0000000000a3' })).toBe(`/s/${TOKEN}/t/${T3}`);
    expect(resolve({ kind: 'task', id: T2 })).toBeNull();
    expect(resolve({ kind: 'task', id: ELSEWHERE })).toBeNull();
    expect(resolve({ kind: 'session', id: COORDINATOR })).toBeNull();
    expect(resolve({ kind: 'project', id: ELSEWHERE })).toBeNull();
  });
});
