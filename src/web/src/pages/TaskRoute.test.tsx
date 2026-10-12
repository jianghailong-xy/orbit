// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { TaskRoute } from './TaskRoute';

/**
 * `/tasks/:id` sends a project's task to its project's page (lib/projectTaskRoute), and leaves the
 * Tasks page one instance across its routes while doing it.
 *
 * The list itself is a stand-in that counts its mounts: what this unit decides is which page opens
 * and whether the list underneath survives a task being opened over it — not what the list draws.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));
let listMounts = 0;
vi.mock('./TaskListView', () => ({
  TaskListView: () => {
    useEffect(() => {
      listMounts += 1;
    }, []);
    return <p data-testid="task-list">the Tasks page</p>;
  },
}));

const PROJECT = encodeId('0195c0de-0000-7000-8000-000000000001');
const TASK = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const LOOSE = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const LIST = encodeId('0195c0de-0000-7000-8000-00000000715e');

let container: HTMLDivElement;
let root: Root | null = null;
let path = '';
let go: ReturnType<typeof useNavigate> | null = null;

function Probe() {
  const location = useLocation();
  go = useNavigate();
  useEffect(() => {
    path = location.pathname + location.search;
  }, [location]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listMounts = 0;
  path = '';
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
});

async function mount(entry: string, seed: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [id, body] of Object.entries(seed)) qc.setQueryData(['task', id], body);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <Probe />
          <Routes>
            <Route path="/tasks" element={<TaskRoute />} />
            <Route path="/tasks/:id" element={<TaskRoute />} />
            <Route path="/lists/:key" element={<TaskRoute />} />
            <Route path="/projects/:id/tasks/:taskId" element={<p>the project page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const list = () => container.querySelector('[data-testid="task-list"]');

describe('TaskRoute', () => {
  it('opens a project’s task over its project’s page', async () => {
    await mount(`/tasks/${TASK}`, { [TASK]: { id: TASK, project: { id: PROJECT, title: 'P' } } });
    expect(path).toBe(`/projects/${PROJECT}/tasks/${TASK}`);
    expect(listMounts, 'the Tasks page never drew').toBe(0);
  });

  it('opens a task filed under no project over the Tasks page, as before', async () => {
    await mount(`/tasks/${LOOSE}`, { [LOOSE]: { id: LOOSE, project: null } });
    expect(path).toBe(`/tasks/${LOOSE}`);
    expect(list()).toBeTruthy();
  });

  it('leaves a project’s task over a list somebody picked, which lists it', async () => {
    // A named list shows its members whoever filed them, so the task is in the list behind it.
    await mount(`/tasks/${TASK}?list=${LIST}`, { [TASK]: { id: TASK, project: { id: PROJECT, title: 'P' } } });
    expect(path).toBe(`/tasks/${TASK}?list=${LIST}`);
    expect(list()).toBeTruthy();
  });

  it('still sends it on from "No list", a browsing view of the tasks outside projects', async () => {
    await mount(`/tasks/${TASK}?list=none`, { [TASK]: { id: TASK, project: { id: PROJECT, title: 'P' } } });
    expect(path).toBe(`/projects/${PROJECT}/tasks/${TASK}`);
  });

  it('draws nothing but a spinner on arrival until the task’s read says where it opens', async () => {
    await mount(`/tasks/${TASK}`);
    expect(list()).toBeNull();
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).toBeTruthy();
  });

  it('keeps the list one instance while tasks open and close over it', async () => {
    await mount('/tasks');
    expect(listMounts).toBe(1);
    // A row of the list opened: that task's read is still out, and the list must not give way.
    await act(async () => go!(`/tasks/${LOOSE}`, { replace: true }));
    expect(list()).toBeTruthy();
    await act(async () => go!('/tasks', { replace: true }));
    expect(listMounts).toBe(1);
  });
});
