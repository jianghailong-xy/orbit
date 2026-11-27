// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { hoverTooltip } from '../test/tooltipHover';
import { TaskListView } from './TaskListView';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
  openTaskListConsole: () => new Promise(() => {}),
}));

const LIST_ID = encodeId('00000000-0000-7000-8000-000000000001');

describe('a scheduled task’s start, on hover', () => {
  it('says it starts once, on the reader’s clock, and gives the exact instant', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const at = '2026-09-01T01:00:00.000Z';
    const row = {
      id: encodeId('00000000-0000-7000-8000-000000000002'), title: 'Download shard 000', status: 'OPEN',
      running: false, queued: false, blocked: false, dependencyState: 'NONE', assignee: null, runAt: at,
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['task-lists'], [{ id: LIST_ID, title: 'FineWeb Parquet' }]);
    qc.setQueryData(['tasks', 'page', { filter: 'ALL', query: '', listId: LIST_ID }], {
      pages: [{ items: [row], nextCursor: null, total: 1 }],
      pageParams: [null],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/lists/${LIST_ID}?filter=ALL`]}>
          <Routes><Route path="/lists/:key" element={<TaskListView />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    const local = new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(await hoverTooltip(container.querySelector('time.task-run-at')!))
      .toBe(`Starts once, at ${local} in your own time zone (${at})`);
    await act(async () => root.unmount());
    container.remove();
    qc.clear();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
});
