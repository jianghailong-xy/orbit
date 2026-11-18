// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';

/**
 * A task forked from a session (docs/task-fork-from-session-design.md §2.3) says where its checkout
 * came from: the panel draws the server's `forkSource` sentence verbatim under the task's meta row,
 * and draws nothing when the field is null or — on an older server — absent.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  // The panel's own reads (runners, providers, the dependency graph…) are not this file's subject.
  api: vi.fn(() => new Promise(() => {})),
}));
const { TaskDetailPanel } = await import('./TaskDetailPanel');

const TASK = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4f01');
const SOURCE = 'Forked from session «Refactor the claim path» at 5555555 (includes uncommitted changes)';
const DETAIL = {
  id: TASK,
  title: 'Split the claim path',
  status: 'OPEN',
  description: 'What to do.',
  attachments: [],
  comments: [],
  sessions: [],
  dependsOn: [],
  dependedOnBy: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(over: Record<string, unknown>): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  client.setQueryData(['task', TASK], { ...DETAIL, ...over });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TaskDetailPanel taskId={TASK} onOpenTask={() => {}} onClose={() => {}} onDelete={() => {}} deleting={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the task panel’s SOURCE line', { timeout: 60_000 }, () => {
  it('draws the server’s sentence verbatim under the meta row', async () => {
    const panel = await mount({ forkSource: SOURCE });
    expect(panel.querySelector('.tdp-head .tdp-fork-source')?.textContent).toBe(SOURCE);
  });

  it('draws nothing when the task was not forked', async () => {
    const panel = await mount({ forkSource: null });
    expect(panel.querySelector('.tdp-title')?.textContent).toBe('Split the claim path');
    expect(panel.querySelector('.tdp-fork-source')).toBeNull();
  });

  it('draws nothing when an older server leaves the field out', async () => {
    const panel = await mount({});
    expect(panel.querySelector('.tdp-title')?.textContent).toBe('Split the claim path');
    expect(panel.querySelector('.tdp-fork-source')).toBeNull();
  });
});
