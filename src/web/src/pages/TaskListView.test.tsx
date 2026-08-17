import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { TaskListView } from './TaskListView';

// The component reaches for the network on mount; these tests seed the cache instead and assert
// on what gets rendered from it, so nothing should ever be fetched. Partial, because the detail
// panel this view imports pulls other exports out of the same module at import time.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => {}),
  openTaskListConsole: () => new Promise(() => {}),
}));

const LIST_UUID = '00000000-0000-7000-8000-000000000001';
const LIST_ID = encodeId(LIST_UUID);

const task = (id: string, title: string) => ({
  id: encodeId(`00000000-0000-7000-8000-00000000000${id}`),
  title,
  status: 'OPEN',
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
});

/**
 * The list view at `/lists/<id>`, with only the *paged* task query seeded. A view that still
 * fetched the list whole (GET /task-lists/:id, which embeds every task) would find nothing here
 * and render its empty state — which is what makes these assertions worth making.
 */
function renderList(
  page: unknown,
  lists: { id: string; title: string }[],
  scopeCounts?: unknown,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['task-lists'], lists);
  qc.setQueryData(['tasks', 'page', { filter: 'ALL', query: '', listId: LIST_ID }], {
    pages: [page],
    pageParams: [null],
  });
  // The tallies are their own query, keyed by scope rather than by tab — seeded separately here
  // for the same reason they exist separately in the app.
  if (scopeCounts) qc.setQueryData(['tasks', 'counts', LIST_ID, []], scopeCounts);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter initialEntries={[`/lists/${LIST_ID}?filter=ALL`]}>
          <Routes>
            <Route path="/lists/:key" element={<TaskListView />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

const counts = {
  total: 19702,
  open: 19700,
  inProgress: 0,
  done: 2,
  failed: 0,
  cancelled: 0,
  running: 0,
  queued: 0,
  runnable: 19700,
};

describe('opening one task list', () => {
  it('renders the first page of rows and offers the rest, instead of the whole list at once', () => {
    const html = renderList(
      {
        items: [task('1', 'Download shard 000'), task('2', 'Download shard 001')],
        nextCursor: 'cursor-2',
        total: counts.total,
        counts,
      },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
    );

    expect(html).toContain('Download shard 000');
    expect(html).toContain('Download shard 001');
    // The paging affordance is the whole point: a 19k-task list arrives 200 rows at a time.
    expect(html).toContain('Load more (2 of 19702)');
  });

  it('renders each title whole, however much boilerplate the rows share', () => {
    // The view used to strip the longest shared prefix off every row and show it once as a chip,
    // which turned "[FineWeb][CC-MAIN-2025-26] 004_00040.parquet" into a bare "004_00040.parquet".
    // A row must say what the task is actually called.
    const html = renderList(
      {
        items: [
          task('1', '[FineWeb][CC-MAIN-2025-26] 004_00040.parquet'),
          task('2', '[FineWeb][CC-MAIN-2025-26] 004_00041.parquet'),
          task('3', '[FineWeb][CC-MAIN-2025-26] 004_00042.parquet'),
        ],
        nextCursor: null,
        total: 3,
        counts: { ...counts, total: 3 },
      },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
    );

    // Anchored on the surrounding tags: the full title has always been in the row's `title=`
    // tooltip, so only asserting on the visible text node can tell the two behaviours apart.
    expect(html).toContain('>[FineWeb][CC-MAIN-2025-26] 004_00040.parquet<');
    expect(html).toContain('>[FineWeb][CC-MAIN-2025-26] 004_00042.parquet<');
  });

  it('titles the page from the lists index rather than the list detail', () => {
    const html = renderList(
      { items: [], nextCursor: null, total: 0, counts: { ...counts, total: 0 } },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
    );

    expect(html).toContain('FineWeb Parquet');
  });

  it('reports the whole list in its tallies, not just the page that has loaded', () => {
    // The progress line and the tab badges describe the scope. Counting the loaded rows instead
    // would tell someone with 19,702 tasks that they have 2.
    const html = renderList(
      {
        items: [task('1', 'Download shard 000'), task('2', 'Download shard 001')],
        nextCursor: 'cursor-2',
        total: counts.total,
      },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
      counts,
    );

    // Anchored on the elements that make the claim. A bare toContain('19702') passed even after
    // the progress bar stopped rendering entirely, because the "Load more (2 of 19702)" button
    // happens to carry the same number.
    expect(html).toMatch(/task-progress-text[^]*?19702/);
    expect(html).toMatch(/seg-count">19702</);
  });

  // Without its own query the tallies rode on the paged one, which is keyed by filter — so
  // switching tab emptied them and the progress bar vanished until the next page arrived.
  it('renders no tallies at all when only the page is known', () => {
    const html = renderList(
      {
        items: [task('1', 'Download shard 000')],
        nextCursor: null,
        total: counts.total,
      },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
    );

    expect(html).not.toContain('task-progress-text');
  });

  it('does not call a list missing on the strength of a stale index', () => {
    // The title comes from the lists index the sidebar holds, which can be up to 15s behind —
    // so a list created a moment ago (over MCP, and deep-linked straight into) is absent from it
    // while being perfectly real. Only an index refetched for this page view may condemn a list;
    // here nothing has been fetched at all, so the view must keep quiet. (The other side of that
    // guard — the message a genuinely deleted list gets — needs a fetch to happen after mount,
    // which a static render can't do.)
    const html = renderList({ items: [], nextCursor: null, total: 0, counts: { ...counts, total: 0 } }, []);

    expect(html).not.toContain('This list could not be loaded.');
  });
});
