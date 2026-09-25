// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://orbit.wikova.com/s/Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedEvent, SharedSession, SharedTask } from '../api';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { encodeId } from '../lib/idCodec';
import { taskLinkResolver } from '../lib/publicLinks';
import { TASK_START_OPEN_TASK } from '../lib/taskStartCard';
import { SharedLinkPage } from './SharedLinkPage';
import { SharedSessionPage } from './SharedSessionPage';
import * as rows from './SharedSessionPage.fixtures';

/**
 * A task link's pages (docs/share-links-design.md §7; mock 05, left half), mounted whole on the
 * routes that serve them: `/s/<token>` — which reads the link once and draws the task's page — and
 * `/s/<token>/c/<run>` for a run the link opens. What is held here: the blocks come in the order the
 * app's own task panel draws them; every link on them goes where the link's scope says (the task
 * and its runs to this link's pages, everything else — the project, other tasks, other sessions —
 * as words, never into the app); a dependency in another project is a number; and the owner's
 * Preview is flagged so it is not counted.
 *
 * The task is the one the mock drew, T6 of 「Claude 账号池」, with its real ids and its real run.
 */

// The app panel is rendered statically below; its own reads never resolve there.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const TOKEN = 'Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa';
const SHARE = `/api/shared/${TOKEN}`;
const TASK = encodeId('01a0702b-242d-74ed-8c72-75d49d5b498b');
const PROJECT = encodeId('01a07006-33b5-764d-ad26-26958a4bbcd9');
const RUN = encodeId('eb4677c5-44c5-5257-8bbb-02e7da5fbbd2');
const COORDINATOR = encodeId('01a06fff-ff20-7638-b8ed-56be3c7741a2');
const T3B = encodeId('01a0702b-1111-7000-8000-000000000001');
const T7 = encodeId('01a0702b-2222-7000-8000-000000000002');
const INPUT = encodeId('01a0702b-3333-7000-8000-000000000003');

/** What every piece of prose on the page links to: the task, its run, and three things outside the
 *  link — its project, another task, and the coordinator's conversation. */
const REFERENCES =
  `See [this task](orbit-task:${TASK}), [its run](orbit-session:${RUN}), ` +
  `[the project](orbit-project:${PROJECT}), [T3b](orbit-task:${T3B}) and [the coordinator](orbit-session:${COORDINATOR}).`;

/** GET /shared/:token for the task, every layer on (share-links/public-task.ts's projection). */
function taskRoot(layers: { commentsAndFiles: boolean; conversations: boolean }) {
  const root: SharedTask = {
    id: TASK,
    title: 'T6 安全边界：跨 owner、准入与凭据不外泄的回归断言',
    status: 'DONE',
    outcome: 'DONE',
    supersededBy: null,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    createdAt: '2026-09-05T08:00:00.000Z',
    project: { title: 'Claude 账号池：按订阅配额均衡派发' },
    description: `本任务属于项目「Claude 账号池：按订阅配额均衡派发」。\n\n${REFERENCES}`,
    acceptanceCriteria: '新增的安全边界断言全部为绿，且每一条都附一次阴性对照的记录。',
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    dependencies: {
      prerequisites: [{ id: T3B, title: 'T3b 放开池 slug 的写入口', status: 'DONE' }],
      dependents: [{ id: T7, title: 'T7 合并边界', status: 'IN_PROGRESS' }],
      prerequisitesInOtherProjects: 1,
      dependentsInOtherProjects: 0,
    },
    runs: [
      {
        state: 'SUCCEEDED',
        startedAt: '2026-09-25T02:12:20.000Z',
        endedAt: '2026-09-25T03:23:13.000Z',
        durationMs: 4_253_000,
        ...(layers.conversations ? { sessionId: RUN } : {}),
      },
    ],
    ...(layers.commentsAndFiles
      ? {
          comments: [
            { author: 'Owner', body: 'Please keep the negative controls.', createdAt: '2026-09-25T02:00:00.000Z' },
            { author: 'orbit', body: `**T6 交付说明**\n\n${REFERENCES}`, createdAt: '2026-09-25T03:17:00.000Z' },
          ],
          inputs: [
            { id: INPUT, fileName: 'boundary.png', mimeType: 'image/png', sizeBytes: 2048, createdAt: '2026-09-05T08:00:00.000Z' },
          ],
        }
      : {}),
  };
  return { kind: 'TASK', include: { ...layers, toolOutput: true }, sharedAt: '2026-09-25T04:00:00.000Z', root };
}

/** GET /shared/:token/sessions/:run — the transcript's shape, plus the task it is a run of. */
function run(events: SharedEvent[]): SharedSession {
  return {
    title: rows.T6_RUN.title,
    workspaceName: 'orbit',
    status: 'SUCCEEDED',
    runStatus: 'SUCCEEDED',
    sessionState: 'COMPLETED',
    runState: 'SUCCEEDED',
    lifecycleState: 'COMPLETED',
    filingState: 'COMPLETED',
    createdAt: rows.T6_RUN.createdAt,
    events,
    hasMore: true,
    task: { id: TASK, title: 'T6 安全边界：跨 owner、准入与凭据不外泄的回归断言', runs: [{ sessionId: RUN }] },
  };
}

const RUN_EVENTS: SharedEvent[] = [
  { ...rows.TASK_STARTED, seq: 202 },
  { type: 'assistant', payload: { text: REFERENCES }, turnId: null, ts: '2026-09-25T02:13:00.000Z', seq: 203 },
];

let container: HTMLDivElement;
let root: Root;
let requests: string[];
let rootAnswer: unknown;

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'shared link not found' }) }) as Response;

/** The link's routes, as SharedController serves them. */
function share(url: string): Response {
  const u = new URL(url, window.location.origin);
  if (u.pathname === SHARE) return okJson(rootAnswer);
  if (u.pathname === `${SHARE}/sessions/${RUN}`) return okJson(run(RUN_EVENTS));
  if (u.pathname === `${SHARE}/sessions/${RUN}/events`) return okJson({ events: [], hasMore: false });
  return notFound();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  rootAnswer = taskRoot({ commentsAndFiles: true, conversations: true });
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
  for (let i = 0; i < 6; i++) {
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
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The page's blocks, top to bottom. */
const blocks = () => [...container.querySelectorAll<HTMLElement>('[data-block]')].map((el) => el.dataset.block);
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
const linkNamed = (text: string) =>
  [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)?.getAttribute('href') ?? null;
/** Links into the app: each of them ends at the sign-in page for whoever reads a public page. */
const appHrefs = () => hrefs().filter((href) => /^\/(tasks|projects|sessions|following|settings)\b/.test(href));

/**
 * The app task panel's own blocks, in the order it draws them — read off the panel itself, with the
 * same task's owner read in its cache — as the public page names them.
 */
function appPanelBlocks(): string[] {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } } });
  qc.setQueryData(['task', TASK], {
    id: TASK,
    title: 'T6',
    status: 'DONE',
    description: 'What to do.',
    acceptanceCriteria: 'What done is.',
    attachments: [{ id: INPUT, fileName: 'boundary.png', mimeType: 'image/png', sizeBytes: 2048, createdAt: '2026-09-05T08:00:00.000Z' }],
    sessions: [{ id: RUN, title: 'Run', status: 'SUCCEEDED', createdAt: '2026-09-25T02:12:20.000Z', workspace: { name: 'orbit' } }],
    comments: [{ id: 'c1', authorName: 'orbit', body: 'Delivered.', createdAt: '2026-09-25T03:17:00.000Z' }],
    dependsOn: [{ dependsOnTask: { id: T3B, title: 'T3b', status: 'DONE' } }],
    dependedOnBy: [{ task: { id: T7, title: 'T7', status: 'OPEN' } }],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDetailPanel taskId={TASK} onOpenTask={() => {}} onClose={() => {}} onDelete={() => {}} deleting={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const PUBLIC_NAME: Record<string, string> = {
    Dependencies: 'dependencies',
    Description: 'description',
    Acceptance: 'acceptance',
    Inputs: 'inputs',
    Runs: 'runs',
    Comments: 'comments',
  };
  return [...html.matchAll(/class="tdp-section-title">([^<(]+)/g)]
    .map((m) => PUBLIC_NAME[m[1].trim()])
    .filter((name): name is string => name != null);
}

describe('a task link’s public page', { timeout: 60_000 }, () => {
  it('reads the link once and draws its blocks in the app task panel’s order', async () => {
    await mount(`/s/${TOKEN}`);
    expect(requests).toEqual([`${SHARE}?limit=200&maxPayload=2048`]);
    expect(container.querySelector('h1')?.textContent).toBe('T6 安全边界：跨 owner、准入与凭据不外泄的回归断言');

    // The header first — how it ended, how that is judged, when — then the panel's own blocks in the
    // panel's own order: the app draws the same task's blocks, and the page must agree with it.
    const panel = appPanelBlocks();
    expect(panel).toEqual(['dependencies', 'description', 'acceptance', 'inputs', 'runs', 'comments']);
    expect(blocks()).toEqual(['header', ...panel]);
    const header = container.querySelector('[data-block="header"]')!.textContent;
    expect(header).toContain('Done');
    expect(header).toContain('Judged by · submitted evidence');
    expect(header).toContain('Created Sep 5');
  });

  it('without its layers: no comments, no files, and no way into a run', async () => {
    rootAnswer = taskRoot({ commentsAndFiles: false, conversations: false });
    await mount(`/s/${TOKEN}`);
    expect(blocks()).toEqual(['header', 'dependencies', 'description', 'acceptance', 'runs']);
    const runs = container.querySelector('[data-block="runs"]')!;
    expect(runs.textContent).toContain('Conversation not shared');
    expect(runs.querySelector('a')).toBeNull();
    // The run is not the link's to open, so prose naming it is words too.
    expect(linkNamed('its run')).toBeNull();
    expect(appHrefs()).toEqual([]);
  });

  it('sends every link where the link’s scope says: the task and its run here, the rest as words', async () => {
    await mount(`/s/${TOKEN}`);
    // The run row, and the description and comment that name the task, its run and three things the
    // link does not share.
    expect(linkNamed('View conversation ›')).toBe(`/s/${TOKEN}/c/${RUN}`);
    const description = container.querySelector('[data-block="description"]')!;
    const inDescription = (text: string) =>
      [...description.querySelectorAll('a')].find((a) => a.textContent === text)?.getAttribute('href') ?? null;
    expect(inDescription('this task')).toBe(`/s/${TOKEN}`);
    expect(inDescription('its run')).toBe(`/s/${TOKEN}/c/${RUN}`);
    for (const outside of ['the project', 'T3b', 'the coordinator']) {
      expect(inDescription(outside)).toBeNull();
      expect(description.textContent).toContain(outside);
    }
    // Its dependencies are named — they share its project — but a task link does not open them.
    const dependencies = container.querySelector('[data-block="dependencies"]')!;
    expect(dependencies.textContent).toContain('T3b 放开池 slug 的写入口');
    expect(dependencies.textContent).toContain('T7 合并边界');
    expect(dependencies.querySelector('a')).toBeNull();
    // Nothing on the page links into the app.
    expect(appHrefs()).toEqual([]);
  });

  it('counts a dependency in another project, and names none', async () => {
    await mount(`/s/${TOKEN}`);
    const dependencies = container.querySelector('[data-block="dependencies"]')!.textContent;
    expect(dependencies).toContain('3 connected · 2 upstream · 1 downstream');
    expect(dependencies).toContain('1 prerequisite in another project');
  });

  it('signs comments as the link shows them, and folds the earlier ones', async () => {
    await mount(`/s/${TOKEN}`);
    const comments = container.querySelector('[data-block="comments"]')!;
    expect(comments.textContent).toContain('orbit');
    expect(comments.textContent).not.toContain('Owner');
    const more = [...comments.querySelectorAll('button')].find((b) => b.textContent === 'Show 1 earlier comment')!;
    await act(async () => {
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(comments.textContent).toContain('Owner');
    expect(comments.textContent).toContain('Please keep the negative controls.');
  });

  it('passes the owner’s Preview on, so it is not counted as a visit', async () => {
    await mount(`/s/${TOKEN}?preview=1`);
    expect(requests).toEqual([`${SHARE}?limit=200&maxPayload=2048&preview=1`]);
    expect(blocks()[0]).toBe('header');
  });
});

describe('a run of a shared task (/s/<token>/c/<run>)', { timeout: 60_000 }, () => {
  it('reads the run under the link, with the task › Run · date breadcrumb and the task’s scope', async () => {
    await mount(`/s/${TOKEN}/c/${RUN}`);
    expect(requests[0]).toBe(`${SHARE}/sessions/${RUN}?limit=200&maxPayload=2048`);
    const crumbs = [...container.querySelectorAll('.share-crumbs > *')].filter((el) => !el.classList.contains('share-crumb-sep'));
    const day = new Date(rows.T6_RUN.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    expect(crumbs.map((el) => el.textContent)).toEqual(['T6 安全边界：跨 owner、准入与凭据不外泄的回归断言', `Run · ${day}`]);
    expect(crumbs[0].getAttribute('href')).toBe(`/s/${TOKEN}`);
    // The Task started card opens the task's page on this link; its project is words.
    expect(linkNamed(TASK_START_OPEN_TASK)).toBe(`/s/${TOKEN}`);
    expect(linkNamed('this task')).toBe(`/s/${TOKEN}`);
    expect(linkNamed('its run')).toBe(`/s/${TOKEN}/c/${RUN}`);
    for (const outside of ['the project', 'T3b', 'the coordinator']) expect(linkNamed(outside)).toBeNull();
    expect(appHrefs()).toEqual([]);
  });
});

describe('taskLinkResolver', () => {
  it('opens the task and the runs the link shares, in either id spelling, and nothing else', () => {
    const resolve = taskLinkResolver(TOKEN, { taskId: '01a0702b-242d-74ed-8c72-75d49d5b498b', runSessionIds: [RUN] });
    expect(resolve({ kind: 'task', id: TASK })).toBe(`/s/${TOKEN}`);
    expect(resolve({ kind: 'session', id: 'eb4677c5-44c5-5257-8bbb-02e7da5fbbd2' })).toBe(`/s/${TOKEN}/c/${RUN}`);
    expect(resolve({ kind: 'session', id: COORDINATOR })).toBeNull();
    expect(resolve({ kind: 'task', id: T3B })).toBeNull();
    expect(resolve({ kind: 'project', id: PROJECT })).toBeNull();
    // A run the link does not open (Conversations off) is words as well.
    expect(taskLinkResolver(TOKEN, { taskId: TASK, runSessionIds: [] })({ kind: 'session', id: RUN })).toBeNull();
  });
});
