// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { newRunRequestToken } from '../lib/runRequestToken';
import {
  ProjectReadyToRun,
  resumePausedListMutationOptions,
  runReadyTaskMutationOptions,
} from './ProjectReadyToRun';

vi.mock('../api', () => ({ api: vi.fn() }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const RUNNING_SESSION_ID = '00000000-0000-7000-8000-000000000051';
const QUEUED_SESSION_ID = '00000000-0000-7000-8000-000000000052';

const ITEM = (
  title: string,
  downstreamBlocked: number | null,
  i: number,
  runState: 'READY' | 'QUEUED' | 'RUNNING' | 'PAUSED' = 'READY',
  pausedList: {
    id: string;
    title: string;
    readyCount: number;
    autoRunReadyCount: number;
  } | null = null,
  sessionId: string | null = null,
) => ({
  taskId: `task-${i}`,
  title,
  status: 'OPEN',
  runState,
  sessionId,
  pausedList,
  downstreamBlocked,
});

const READY = {
  readyCount: 7,
  queuedCount: 0,
  runningCount: 0,
  pausedCount: 0,
  items: [
    ITEM('Backend: blocking-root endpoint', 30, 1),
    ITEM('Backend: panorama buckets', 27, 2),
    ITEM('Web: topological task list', 26, 3),
    ITEM('Web: coordinator activity feed', 25, 4),
    ITEM('Assembly: wire the panorama cards', 0, 5),
  ],
  impactTruncated: null,
};

const ACTIVE = {
  readyCount: 2,
  queuedCount: 1,
  runningCount: 1,
  pausedCount: 0,
  items: [
    ITEM('Run in progress', 31, 11, 'RUNNING', null, RUNNING_SESSION_ID),
    ITEM('Waiting for a runner', 29, 12, 'QUEUED', null, QUEUED_SESSION_ID),
    ITEM('Ready behind both', 18, 13),
  ],
  impactTruncated: null,
};

let container: HTMLDivElement;
let root: Root;
let currentPath = '';

function RouteProbe() {
  currentPath = useLocation().pathname;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Popconfirm measures its portal before painting; jsdom has no layout observer of its own.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  apiMock.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  currentPath = '';
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // Popconfirm renders outside the component root.
  document.body.innerHTML = '';
});

async function mount(node: ReactElement): Promise<QueryClient> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <QueryClientProvider client={client}>
          <RouteProbe />
          {node}
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await tick();
  return client;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const rows = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="ready-task-row"]'));

describe('ProjectReadyToRun', () => {
  it('shows an actionable ready queue without the old chart/table control', async () => {
    apiMock.mockResolvedValue(READY);
    await mount(<ProjectReadyToRun projectId="p1" />);

    const text = container.textContent ?? '';
    expect(text).toContain('Run queue');
    expect(text).not.toContain('Ready to run');
    expect(text).toContain('7 ready · sorted by work unblocked');
    expect(rows()).toHaveLength(5);
    for (const item of READY.items) {
      expect(text).toContain(item.title);
      expect(container.querySelector(`[aria-label="Run ${item.title}"]`)).not.toBeNull();
    }
    expect(text.match(/Prerequisites complete/g)).toHaveLength(5);
    expect(text).toContain('Unblocks 30 tasks');
    expect(text).toContain('Unblocks 0 tasks');
    expect(text).toContain('Ready tasks can start now.');

    expect(text).not.toContain('Table view');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-testid="blocking-bar"]')).toBeNull();
    expect(apiMock).toHaveBeenCalledWith('/projects/p1/panorama/ready?limit=5');
  });

  it('keeps active tasks in the queue and opens their work Sessions', async () => {
    apiMock.mockResolvedValue(ACTIVE);
    await mount(<ProjectReadyToRun projectId="p1" />);

    const text = container.textContent ?? '';
    expect(text).toContain('1 running · 1 queued · 2 ready · ready tasks sorted by work unblocked');
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Run in progress'),
      expect.stringContaining('Waiting for a runner'),
      expect.stringContaining('Ready behind both'),
    ]);
    expect(text).toContain('Work in progress');
    expect(text).toContain('Waiting for runner');
    const runningSession = container.querySelector<HTMLElement>(
      '[aria-label="Open session for Run in progress"]',
    );
    const queuedSession = container.querySelector<HTMLElement>(
      '[aria-label="Open session for Waiting for a runner"]',
    );
    expect(runningSession).not.toBeNull();
    expect(queuedSession).not.toBeNull();
    expect(container.querySelector('[aria-label="Run Run in progress"]')).toBeNull();
    expect(container.querySelector('[aria-label="Run Waiting for a runner"]')).toBeNull();
    expect(container.querySelector('[aria-label="Run Ready behind both"]')).not.toBeNull();
    expect(text).toContain(
      'Active tasks stay here until their run ends. Ready tasks can start now.',
    );

    await click(runningSession!);
    expect(currentPath).toBe(`/sessions/${encodeId(RUNNING_SESSION_ID)}`);
  });

  it('clicking Run posts one named trigger and holds the row in Starting while it is pending', async () => {
    let finishRun!: (value: unknown) => void;
    const pendingRun = new Promise((resolve) => {
      finishRun = resolve;
    });
    let reads = 0;
    const afterStart = {
      ...READY,
      readyCount: 6,
      queuedCount: 1,
      pausedCount: 0,
      items: [
        {
          ...READY.items[0],
          runState: 'QUEUED' as const,
          sessionId: QUEUED_SESSION_ID,
        },
        ...READY.items.slice(1, 5),
      ],
    };
    apiMock.mockImplementation((path: string) => {
      if (path.includes('/execute')) return pendingRun as Promise<never>;
      reads += 1;
      return Promise.resolve((reads === 1 ? READY : afterStart) as never);
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Run Backend: blocking-root endpoint"]',
    );
    expect(button).not.toBeNull();
    await click(button!);
    await tick();

    // AntD replaces the button node when its loading icon mounts, so assert against the live node
    // rather than the pre-click reference that may now be detached from the document.
    const startingButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Run Backend: blocking-root endpoint"]',
    );
    expect(startingButton?.disabled).toBe(true);
    expect(startingButton?.textContent).toContain('Starting');
    const execute = apiMock.mock.calls.find(([path]) => path === '/tasks/task-1/execute');
    expect(execute?.[1]).toEqual({
      method: 'POST',
      body: { triggerId: expect.any(String) },
    });

    finishRun({});
    await tick();
    await tick();
    expect(toast.success).toHaveBeenCalledWith('Run started');
    expect(container.textContent).toContain('Backend: blocking-root endpoint');
    expect(
      container.querySelector('[aria-label="Open session for Backend: blocking-root endpoint"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Run Backend: blocking-root endpoint"]'),
    ).toBeNull();
  });

  it('keeps a runnable leaf visible when it unblocks no downstream tasks', async () => {
    apiMock.mockResolvedValue({
      readyCount: 1,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      items: [ITEM('Ship the leaf', 0, 8)],
      impactTruncated: null,
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(container.textContent).toContain('Ship the leaf');
    expect(container.textContent).toContain('Unblocks 0 tasks');
    expect(container.querySelector('[aria-label="Run Ship the leaf"]')).not.toBeNull();
  });

  it('keeps Run available when only the impact closure was skipped', async () => {
    apiMock.mockResolvedValue({
      readyCount: 1,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      items: [ITEM('Ready on a huge project', null, 9)],
      impactTruncated: { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: 2000 },
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(container.textContent).toContain('Impact ranking not computed');
    expect(container.textContent).toContain('Ready now');
    expect(container.querySelector('[aria-label="Run Ready on a huge project"]')).not.toBeNull();
  });

  it('shows the first paused-list candidates with a real resume action instead of an empty state', async () => {
    const pausedList = {
      id: 'list-1',
      title: 'FineWeb downloads',
      readyCount: 6112,
      autoRunReadyCount: 0,
    };
    const paused = {
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 6112,
      items: Array.from({ length: 5 }, (_, index) =>
        ITEM(`Download parquet ${index + 1}`, null, 40 + index, 'PAUSED', pausedList),
      ),
      impactTruncated: { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: 2000 },
    };
    const resumed = {
      ...paused,
      readyCount: 6112,
      pausedCount: 0,
      items: paused.items.map((item) => ({
        ...item,
        runState: 'READY' as const,
        pausedList: null,
      })),
    };
    let listResumed = false;
    apiMock.mockImplementation((path: string) => {
      if (path === '/task-lists/list-1') {
        listResumed = true;
        return Promise.resolve({} as never);
      }
      return Promise.resolve((listResumed ? resumed : paused) as never);
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    const text = container.textContent ?? '';
    expect(text).toContain('0 ready · 6112 ready in paused lists');
    expect(text).toContain('stable order');
    expect(rows()).toHaveLength(5);
    expect(text.match(/List paused · FineWeb downloads/g)).toHaveLength(5);
    expect(text.match(/Ready after resume/g)).toHaveLength(5);
    expect(
      container.querySelectorAll(
        '[aria-label^="Resume list FineWeb downloads for Download parquet"]',
      ),
    ).toHaveLength(5);
    expect(container.querySelector('[aria-label^="Run Download parquet"]')).toBeNull();
    expect(text).toContain('resume their task list to make Run available');

    const firstResume = container.querySelector<HTMLElement>(
      '[aria-label="Resume list FineWeb downloads for Download parquet 1"]',
    );
    expect(firstResume).not.toBeNull();
    await click(firstResume!);
    expect(document.body.textContent).toContain('Resume “FineWeb downloads”?');
    expect(document.body.textContent).toContain(
      'This removes the pause from the entire list. 6112 otherwise-ready tasks will become eligible.',
    );
    expect(document.body.textContent).toContain(
      'Other automatic or scheduled work in the list can also dispatch once resumed.',
    );

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '.ant-popconfirm .ant-btn-primary',
    );
    expect(confirm).not.toBeNull();
    await click(confirm!);
    await tick();
    await tick();

    expect(apiMock).toHaveBeenCalledWith('/task-lists/list-1', {
      method: 'PATCH',
      body: {
        paused: false,
        note: 'Resumed from the project Run queue',
      },
    });
    expect(toast.success).toHaveBeenCalledWith('Task list resumed');
    expect(container.querySelector('[aria-label="Run Download parquet 1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label^="Resume list FineWeb downloads"]')).toBeNull();
  });

  it('warns when resuming a paused list can immediately release auto-run work', async () => {
    apiMock.mockResolvedValue({
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 5,
      items: [
        ITEM('Merge one WARC', null, 50, 'PAUSED', {
          id: 'list-auto',
          title: 'Automatic merge',
          readyCount: 5,
          autoRunReadyCount: 5,
        }),
      ],
      impactTruncated: null,
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    const resume = container.querySelector<HTMLElement>(
      '[aria-label="Resume list Automatic merge for Merge one WARC"]',
    );
    await click(resume!);
    expect(document.body.textContent).toContain(
      '5 are configured to auto-run and may start immediately.',
    );
  });

  it('explains an empty ready queue instead of claiming nothing blocks anything', async () => {
    apiMock.mockResolvedValue({
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      items: [],
      impactTruncated: null,
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain(
      'No tasks are ready, running, or otherwise ready inside a paused task list',
    );
    expect(container.textContent).toContain('assigned workspace');
  });

  it('treats a malformed item collection as empty', async () => {
    apiMock.mockResolvedValue({
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      items: {},
      impactTruncated: null,
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain(
      'No tasks are ready, running, or otherwise ready inside a paused task list',
    );
  });

  it('renders loading and isolated read-error states', async () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    await mount(<ProjectReadyToRun projectId="p1" />);
    expect(container.querySelector('.ant-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('No tasks are ready, running');

    await act(async () => root.unmount());
    container.remove();
    apiMock.mockRejectedValue(new Error('Internal server error'));
    await mount(<ProjectReadyToRun projectId="p1" />);
    expect(container.textContent).toContain('Run queue could not be read');
    expect(container.textContent).toContain('Internal server error');
    expect(container.textContent).toContain('Run queue');
  });
});

describe('resumePausedListMutationOptions', () => {
  it('resumes the whole list with an audit note and refreshes project and task views', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    qc.setQueryData(['project', 'project-1', 'panorama', 'ready', 5], READY);
    qc.setQueryData(['tasks', 'page'], { items: [] });
    qc.setQueryData(['task-lists'], []);
    apiMock.mockResolvedValue({});
    const message = { success: vi.fn(), error: vi.fn() };
    const observer = new MutationObserver(qc, {
      ...resumePausedListMutationOptions(qc, message, 'project-1'),
      retry: false,
    });

    await observer.mutate({ listId: 'list-1' });

    expect(apiMock).toHaveBeenCalledWith('/task-lists/list-1', {
      method: 'PATCH',
      body: {
        paused: false,
        note: 'Resumed from the project Run queue',
      },
    });
    expect(message.success).toHaveBeenCalledWith('Task list resumed');
    expect(qc.getQueryState(['project', 'project-1', 'panorama', 'ready', 5])?.isInvalidated).toBe(
      true,
    );
    expect(qc.getQueryState(['tasks', 'page'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['task-lists'])?.isInvalidated).toBe(true);
  });
});

describe('runReadyTaskMutationOptions', () => {
  it('uses the supplied trigger and invalidates the task, task lists, and project', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    qc.setQueryData(['task', 'task-1'], { id: 'task-1' });
    qc.setQueryData(['tasks', 'page'], { items: [] });
    qc.setQueryData(['project', 'project-1', 'panorama', 'ready', 5], READY);
    apiMock.mockResolvedValue({});
    const message = { success: vi.fn(), error: vi.fn() };
    const observer = new MutationObserver(qc, {
      ...runReadyTaskMutationOptions(qc, message, 'project-1', 'task-1'),
      retry: false,
    });
    const triggerId = newRunRequestToken();

    await observer.mutate({ triggerId });

    expect(apiMock).toHaveBeenCalledWith('/tasks/task-1/execute', {
      method: 'POST',
      body: { triggerId },
    });
    expect(message.success).toHaveBeenCalledWith('Run started');
    expect(qc.getQueryState(['task', 'task-1'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['tasks', 'page'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['project', 'project-1', 'panorama', 'ready', 5])?.isInvalidated).toBe(
      true,
    );
  });
});
