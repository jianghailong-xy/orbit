// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectTaskPanel } from './ProjectTaskPanel';

/**
 * Where a task open over its project's page goes when it closes, and where a task that is not this
 * project's goes instead of being drawn over it.
 *
 * The panel itself is the Tasks page's (TaskDetailPanel) and has its own suites; what is this unit's
 * is the address around it, so the panel here is a stand-in with nothing but its ✕.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./TaskDetailPanel', () => ({
  TaskDetailPanel: ({ onClose }: { onClose: () => void }) => (
    <button type="button" aria-label="Close" onClick={onClose}>
      ✕
    </button>
  ),
}));

const PROJECT = encodeId('0195c0de-0000-7000-8000-000000000001');
const OTHER = encodeId('0195c0de-0000-7000-8000-000000000002');
const TASK = encodeId('0195c0de-0000-7000-8000-0000000000a1');

let container: HTMLDivElement;
let root: Root | null = null;
let at: { path: string; type: string } | null = null;

function Probe() {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    at = { path: location.pathname, type };
  }, [location, type]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  at = null;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
});

async function mount(
  entries: Array<string | { pathname: string; state: unknown }>,
  task?: Record<string, unknown>,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (task) qc.setQueryData(['task', TASK], task);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <Probe />
          <Routes>
            <Route path="/projects/:id" element={<p>project page</p>} />
            <Route
              path="/projects/:id/tasks/:taskId"
              element={<ProjectTaskPanel projectId={PROJECT} taskId={TASK} />}
            />
            <Route path="/tasks/:id" element={<p>tasks page</p>} />
            <Route path="/elsewhere" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const close = async () => {
  const button = container.querySelector('[aria-label="Close"]');
  expect(button, 'the panel’s ✕').toBeTruthy();
  await act(async () => {
    (button as HTMLElement).click();
  });
};

describe('ProjectTaskPanel', () => {
  it('closes back to the page it was opened from — the entry underneath, not a new one', async () => {
    await mount([
      `/projects/${PROJECT}`,
      { pathname: `/projects/${PROJECT}/tasks/${TASK}`, state: { projectTaskOverPage: true } },
    ]);
    await close();
    expect(at).toEqual({ path: `/projects/${PROJECT}`, type: 'POP' });
  });

  it('closes onto the project’s page in place of the task when it was opened from elsewhere', async () => {
    // A link pasted in, a chat reference: there is no project page underneath to go back to.
    await mount(['/elsewhere', `/projects/${PROJECT}/tasks/${TASK}`]);
    await close();
    expect(at).toEqual({ path: `/projects/${PROJECT}`, type: 'REPLACE' });
  });

  it('sends a task filed under another project to that project’s page', async () => {
    await mount([`/projects/${PROJECT}/tasks/${TASK}`], { id: TASK, project: { id: OTHER, title: 'Other' } });
    expect(at).toEqual({ path: `/projects/${OTHER}/tasks/${TASK}`, type: 'REPLACE' });
  });

  it('sends a task filed under no project to the Tasks page', async () => {
    await mount([`/projects/${PROJECT}/tasks/${TASK}`], { id: TASK, project: null });
    expect(at).toEqual({ path: `/tasks/${TASK}`, type: 'REPLACE' });
  });

  it('stays over this project’s page for this project’s own task', async () => {
    await mount([`/projects/${PROJECT}/tasks/${TASK}`], { id: TASK, project: { id: PROJECT, title: 'This' } });
    expect(at).toEqual({ path: `/projects/${PROJECT}/tasks/${TASK}`, type: 'POP' });
    expect(container.querySelector('.project-task-panel [aria-label="Close"]')).toBeTruthy();
  });
});
