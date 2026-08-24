// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRunRequestToken } from '../lib/runRequestToken';
import {
  ProjectReadyToRun,
  runReadyTaskMutationOptions,
} from './ProjectReadyToRun';

vi.mock('../api', () => ({ api: vi.fn() }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const { api } = await import('../api');
const apiMock = vi.mocked(api);

const ITEM = (title: string, downstreamBlocked: number | null, i: number) => ({
  taskId: `task-${i}`,
  title,
  status: 'OPEN',
  downstreamBlocked,
});

const READY = {
  readyCount: 7,
  items: [
    ITEM('Backend: blocking-root endpoint', 30, 1),
    ITEM('Backend: panorama buckets', 27, 2),
    ITEM('Web: topological task list', 26, 3),
    ITEM('Web: coordinator activity feed', 25, 4),
    ITEM('Assembly: wire the panorama cards', 0, 5),
  ],
  impactTruncated: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(node: ReactElement): Promise<QueryClient> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
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
    expect(text).toContain('Ready to run');
    expect(text).toContain('7 tasks · sorted by work unblocked');
    expect(rows()).toHaveLength(5);
    for (const item of READY.items) {
      expect(text).toContain(item.title);
      expect(container.querySelector(`[aria-label="Run ${item.title}"]`)).not.toBeNull();
    }
    expect(text.match(/Prerequisites complete/g)).toHaveLength(5);
    expect(text).toContain('Unblocks 30 tasks');
    expect(text).toContain('Unblocks 0 tasks');
    expect(text).toContain('All prerequisites are complete. Run a task to start it now.');

    expect(text).not.toContain('Table view');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-testid="blocking-bar"]')).toBeNull();
    expect(apiMock).toHaveBeenCalledWith('/projects/p1/panorama/ready?limit=5');
  });

  it('clicking Run posts one named trigger and holds the row in Starting while it is pending', async () => {
    let finishRun!: (value: unknown) => void;
    const pendingRun = new Promise((resolve) => {
      finishRun = resolve;
    });
    apiMock.mockImplementation((path: string) =>
      path.includes('/execute') ? (pendingRun as Promise<never>) : Promise.resolve(READY as never),
    );
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
  });

  it('keeps a runnable leaf visible when it unblocks no downstream tasks', async () => {
    apiMock.mockResolvedValue({
      readyCount: 1,
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
      items: [ITEM('Ready on a huge project', null, 9)],
      impactTruncated: { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: 2000 },
    });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(container.textContent).toContain('Impact ranking not computed');
    expect(container.textContent).toContain('Ready now');
    expect(container.querySelector('[aria-label="Run Ready on a huge project"]')).not.toBeNull();
  });

  it('explains an empty ready queue instead of claiming nothing blocks anything', async () => {
    apiMock.mockResolvedValue({ readyCount: 0, items: [], impactTruncated: null });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('No tasks are ready to run');
    expect(container.textContent).toContain('assigned workspace');
  });

  it('treats a malformed item collection as empty', async () => {
    apiMock.mockResolvedValue({ readyCount: 0, items: {}, impactTruncated: null });
    await mount(<ProjectReadyToRun projectId="p1" />);

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('No tasks are ready to run');
  });

  it('renders loading and isolated read-error states', async () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    await mount(<ProjectReadyToRun projectId="p1" />);
    expect(container.querySelector('.ant-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('No tasks are ready to run');

    await act(async () => root.unmount());
    container.remove();
    apiMock.mockRejectedValue(new Error('Internal server error'));
    await mount(<ProjectReadyToRun projectId="p1" />);
    expect(container.textContent).toContain('Ready tasks could not be read');
    expect(container.textContent).toContain('Internal server error');
    expect(container.textContent).toContain('Ready to run');
  });
});

describe('runReadyTaskMutationOptions', () => {
  it('uses the supplied trigger and invalidates the task, task lists, and project', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
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
    expect(
      qc.getQueryState(['project', 'project-1', 'panorama', 'ready', 5])?.isInvalidated,
    ).toBe(true);
  });
});
