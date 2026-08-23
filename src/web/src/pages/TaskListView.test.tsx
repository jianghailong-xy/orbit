import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { newRunRequestToken } from '../lib/runRequestToken';
import { TaskListView, batchRunMutationOptions, runRowMutationOptions } from './TaskListView';

// The component reaches for the network on mount; these tests seed the cache instead and assert
// on what gets rendered from it, so nothing should ever be fetched. Partial, because the detail
// panel this view imports pulls other exports out of the same module at import time.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
  openTaskListConsole: () => new Promise(() => {}),
}));

const LIST_UUID = '00000000-0000-7000-8000-000000000001';
const LIST_ID = encodeId(LIST_UUID);

const task = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id: encodeId(`00000000-0000-7000-8000-00000000000${id}`),
  title,
  status: 'OPEN',
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
  ...over,
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
  active?: unknown,
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
  // The "Happening now" strip is fetched outside the paged list — running work sits at the far
  // end of a newest-first pagination — so pinning a row means seeding its own query.
  if (active) qc.setQueryData(['tasks', 'active', LIST_ID], active);
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

/**
 * A scheduled start is the one thing on a row whose correct answer depends on WHERE the reader
 * is, so every render below runs in a pinned zone rather than the machine's own — otherwise the
 * suite would pass in UTC, where local and UTC agree and the bug this guards is invisible, and
 * fail everywhere else. Node re-reads `process.env.TZ` on the next Date/Intl call, so setting it
 * around one synchronous render is enough; restoring it keeps the rest of the file in the host's.
 */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const SHANGHAI = 'Asia/Shanghai'; // UTC+8 year-round
const NEW_YORK = 'America/New_York'; // UTC-4 in September — and a day behind 01:00Z

/** The clipped suffix inside the marker, matched exactly as it is rendered — so an assertion
 *  about it fails if the class that hides it is ever renamed out from under the stylesheet. */
const NOTE_OPEN = '<span class="task-run-at-note">';

/**
 * Every `<time>` on the page, split into what a reader sees, what a screen reader hears and what
 * a machine parses.
 *
 * Attributes by NAME rather than by substring: React's static renderer spells the prop out as
 * `dateTime`, while HTML parses attribute names case-insensitively — so a browser sees `datetime`
 * either way, and pinning one casing into every assertion would break on a renderer change that
 * changes nothing a reader or a machine can observe.
 */
function timeTags(html: string): {
  instant: string;
  label: string;
  hover: string;
  visible: string;
  clipped: string;
  announced: string;
}[] {
  const note = new RegExp(`${NOTE_OPEN}([\\s\\S]*?)</span>`, 'i');
  return [...html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)].map((el) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(el[1])?.[1] ?? '';
    const inner = el[2];
    const strip = (s: string) => s.replace(/<[^>]*>/g, '');
    return {
      instant: attr('datetime'),
      // `aria-label` in full: a bare `label` would match the tail of `aria-label` too, and an
      // assertion that cannot tell the two apart proves nothing about what is on the element.
      label: attr('aria-label'),
      hover: attr('title'),
      // What a sighted reader gets: the element's text with the clipped suffix taken back out.
      visible: strip(inner.replace(note, '')),
      clipped: note.exec(inner)?.[1] ?? '',
      // What name-from-content computes: every text node in the element, in order.
      announced: strip(inner),
    };
  });
}

/** Each row's title cell, cut at the sibling column that follows it — so an assertion about
 *  what sits beside a title cannot be satisfied by markup from somewhere else on the page. */
const titleCells = (html: string): string[] =>
  html.match(/<div class="task-title-cell">[\s\S]*?<div class="(?:task-creator|row-actions)"/g) ?? [];

/** The sortable column headings, in order — the list's columns, named. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<div class="col-head sortable[^"]*">([^<]*)/g)].map((m) => m[1]);

/** The list view in a pinned zone: `paged` rows in the table, `active` rows in the pinned strip. */
function rowsIn(
  tz: string,
  rows: { paged?: ReturnType<typeof task>[]; active?: ReturnType<typeof task>[] },
) {
  const paged = rows.paged ?? [];
  return inTimeZone(tz, () =>
    renderList(
      { items: paged, nextCursor: null, total: paged.length },
      [{ id: LIST_ID, title: 'FineWeb Parquet' }],
      undefined,
      rows.active ? { items: rows.active, total: rows.active.length, truncated: false } : undefined,
    ),
  );
}

describe('a task that starts on a schedule, on its row in the list', () => {
  const AT = '2026-09-01T01:00:00.000Z';
  /** The same reading `scheduledStart` produces, computed independently of the row. */
  const localAt = (tz: string) =>
    inTimeZone(tz, () =>
      new Date(AT).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );

  it('writes the start on the reader’s own clock, not the stored UTC one', () => {
    const html = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt: AT })] });

    const [shown] = timeTags(html);
    expect(shown.visible).toBe(`Starts ${localAt(SHANGHAI)}`);
    // 01:00Z is 09:00 in Shanghai. A row that printed the payload — or formatted in a fixed zone
    // — would say 1:00 AM, which is the wrong hour for everyone outside that one zone.
    expect(shown.visible).not.toContain(AT);
    expect(shown.visible).not.toBe(`Starts ${localAt('UTC')}`);
    // To the minute, so "soon" is a judgement the reader can actually make.
    expect(shown.visible).toMatch(/\d:\d{2}/);
  });

  it('renders one stored instant differently for readers in different zones', () => {
    // The assertion that cannot be satisfied by accident: one instant, two zones, and at this one
    // it is not even the same DAY — 01:00Z on the 1st is the previous evening in New York. A row
    // that printed the UTC string would render identically in both, whatever zone the host is in.
    const scheduled = [task('1', 'Download shard 000', { runAt: AT })];
    const shanghai = timeTags(rowsIn(SHANGHAI, { paged: scheduled }))[0];
    const newYork = timeTags(rowsIn(NEW_YORK, { paged: scheduled }))[0];

    // Both name the identical instant to a machine...
    expect(shanghai.instant).toBe(AT);
    expect(newYork.instant).toBe(AT);
    // ...while what a person reads rolls back to the previous day in New York only.
    expect(newYork.visible).toBe(`Starts ${localAt(NEW_YORK)}`);
    expect(newYork.visible).not.toBe(shanghai.visible);
    expect(newYork.visible).toMatch(/31/);
    expect(shanghai.visible).not.toMatch(/31/);
  });

  it('carries one canonical UTC instant in dateTime, whatever spelling the payload used', () => {
    // The same moment, written three ways. The machine-readable half normalizes to one string, so
    // anything comparing, sorting or re-parsing it sees one spelling rather than the wire's.
    for (const wire of [AT, '2026-09-01T09:00:00+08:00', '2026-09-01T01:00:00Z']) {
      const html = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt: wire })] });
      expect(timeTags(html)[0].instant).toBe(AT);
      expect(timeTags(html)[0].visible).toBe(`Starts ${localAt(SHANGHAI)}`);
    }
  });

  it('says the task STARTS, and never reads a due date as one', () => {
    // `runAt` is what the server dispatches on; `dueDate` is a deadline nothing acts on. The row
    // has deliberately never shown the second, and this marker must not be where it leaks in.
    const html = rowsIn(SHANGHAI, {
      paged: [task('1', 'Download shard 000', { runAt: AT, dueDate: '2026-09-30T00:00:00.000Z' })],
    });

    expect(timeTags(html)[0].visible).toMatch(/^Starts /);
    expect(timeTags(html)[0].instant).toBe(AT);
    expect(html).not.toContain('Due');
    expect(html).not.toContain('2026-09-30');

    // And a deadline on its own schedules nothing, so it marks nothing.
    const dueOnly = rowsIn(SHANGHAI, {
      paged: [task('1', 'Download shard 000', { dueDate: '2026-09-30T00:00:00.000Z' })],
    });
    expect(timeTags(dueOnly)).toHaveLength(0);
    expect(dueOnly).not.toContain('Starts');
  });

  it('completes the announcement in real text, not in an attribute', () => {
    const html = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt: AT })] });
    const [shown] = timeTags(html);

    // Not `aria-label`: `<time>` maps to the `generic` role, and ARIA prohibits naming `generic`,
    // so a label there is not a name a browser is obliged to expose — the same objection that
    // rules out leaning on `title`. Text content carries no such caveat.
    expect(shown.label).toBe('');
    expect(html).not.toMatch(/<time\b[^>]*aria-label/i);

    // The two questions the visible marker cannot answer — does it repeat, and whose clock is it
    // written on — answered in text, inside the same element.
    expect(shown.clipped).toContain('once');
    expect(shown.clipped).toMatch(/your own time zone/i);
    // Purely a SUFFIX: name-from-content concatenates the element's text in order, so it adds
    // what is missing instead of making a screen reader hear the date twice.
    expect(shown.clipped).not.toContain('Starts');
    expect(shown.clipped).not.toContain(localAt(SHANGHAI));
    expect(shown.announced).toBe(`${shown.visible}${shown.clipped}`);
    expect(shown.announced).toBe(`Starts ${localAt(SHANGHAI)}, once, in your own time zone`);

    // Clipped by that one class and nothing else — no `aria-hidden`, no `hidden`, which would
    // take it out of the accessibility tree along with the pixels and defeat the whole point.
    expect(html).toContain(NOTE_OPEN);
    expect(html).not.toMatch(/<span class="task-run-at-note"[^>]/i);

    // The hover text stays, and stays useful: it is the one place the exact instant appears for a
    // sighted reader, which a to-the-minute local rendering rounds off.
    expect(shown.hover).toContain('once');
    expect(shown.hover).toMatch(/your own time zone/i);
    expect(shown.hover).toContain(localAt(SHANGHAI));
    expect(shown.hover).toContain(AT);
  });

  it('clips that suffix out of the pixels rather than out of the page', () => {
    // The one assertion here that cannot be made against a render: whether the note is *visible*
    // is decided by a stylesheet a static renderer never applies. Left untested, the sentence
    // written for screen readers could start appearing on every scheduled row — visibly, in the
    // middle of a 44px table — with the whole suite still green.
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const rule = /\.task-run-at-note \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/width:\s*1px/);
    // Never these two: both take the text out of the accessibility tree along with the pixels,
    // which is the exact failure this whole approach exists to avoid.
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });

  it('marks nothing at all without a usable start, and never says "Invalid Date"', () => {
    // Absent, null, cleared and garbled alike. Most tasks are unscheduled, so a marker on every
    // row would bury the few that are not — and `new Date('nonsense')` renders to the literal
    // words "Invalid Date" on screen, with a NaN behind it.
    for (const runAt of [undefined, null, '', '   ', 'not a date', '2026-13-01T00:00:00.000Z']) {
      const html = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt })] });

      expect(timeTags(html)).toHaveLength(0);
      expect(html).not.toContain('Starts');
      expect(html).not.toContain('Invalid Date');
      expect(html).not.toContain('NaN');
      // The row is otherwise untouched: it still renders everything it always did.
      expect(html).toContain('>Download shard 000<');
    }
  });

  it('leaves the title whole, truncating, and still the row’s own tooltip', () => {
    // The marker sits BESIDE the title, never inside it: `.task-title` is the element that
    // ellipses and that carries the full title as its hover text, so folding a schedule into it
    // would spend the title's width — and its tooltip — on the schedule.
    const long = '[FineWeb][CC-MAIN-2025-26] 004_00040.parquet';
    const html = rowsIn(SHANGHAI, { paged: [task('1', long, { runAt: AT })] });

    expect(html).toContain(`<span class="task-title" title="${long}">${long}</span>`);
    const [cell] = titleCells(html);
    expect(cell).toContain('class="task-run-at"');
    // After the title, so the cell's whole shrink goes to the title beside it.
    expect(cell.indexOf('</span>')).toBeLessThan(cell.indexOf('<time'));
  });

  it('adds no column, in either the assignee or the no-assignee layout', () => {
    // The marker rides inside the title cell precisely so the grid template — and with it the
    // fixed 44px row the windowing arithmetic is built on — stay exactly as they were.
    const uniform = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt: AT })] });
    const mixed = rowsIn(SHANGHAI, {
      paged: [
        task('1', 'Download shard 000', { runAt: AT, assignee: { id: 'w1', name: 'alpha' } }),
        task('2', 'Download shard 001', { assignee: { id: 'w2', name: 'beta' } }),
      ],
    });

    // Every task unassigned is one assignee for all of them, so that column is dropped...
    expect(uniform).toContain('orbit-tasklist no-assignee');
    expect(headings(uniform)).toEqual(['Status', 'Task']);
    // ...and two different assignees bring it back. Neither layout grew a third or a fourth.
    expect(mixed).not.toContain('no-assignee');
    expect(headings(mixed)).toEqual(['Status', 'Task', 'Assignee']);
    // The marker is on the scheduled row in both, and only on the scheduled row.
    expect(timeTags(uniform)).toHaveLength(1);
    expect(timeTags(mixed)).toHaveLength(1);
    expect(titleCells(mixed)[0]).toContain('class="task-run-at"');
    expect(titleCells(mixed)[1]).not.toContain('task-run-at');
  });

  it('keeps the row itself clickable, selectable and hover-actioned', () => {
    const html = rowsIn(SHANGHAI, { paged: [task('1', 'Download shard 000', { runAt: AT })] });

    // The click target, the multi-select checkbox, the status pill and the hover actions are all
    // still on a scheduled row: the marker is a sibling of the title, not a replacement for any
    // of them.
    expect(html).toContain('class="task-row clickable"');
    expect(html).toContain('class="task-check"');
    expect(html).toContain('class="task-status-cell"');
    expect(html).toContain('class="row-actions"');
    expect(html).toContain('aria-label="Delete Download shard 000"');
  });

  it('marks a pinned “Happening now” row through the very same render path', () => {
    // One row in the strip and one in the table below it, scheduled for the same instant. The
    // strip is fed by its own query but rendered by the same `renderRow`, so the proof that there
    // is no second implementation is that the two markers come out byte-for-byte identical.
    const html = rowsIn(SHANGHAI, {
      active: [task('9', 'Nightly ingest', { runAt: AT, status: 'IN_PROGRESS' })],
      paged: [task('1', 'Download shard 000', { runAt: AT })],
    });

    expect(html).toContain('Happening now');
    const cells = titleCells(html);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain('Nightly ingest');
    expect(cells[1]).toContain('Download shard 000');

    const markers = timeTags(html);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toEqual(markers[1]);
    expect(markers[0].instant).toBe(AT);
    expect(markers[0].visible).toBe(`Starts ${localAt(SHANGHAI)}`);
    // ...and the first of them really is in the pinned strip, above the table.
    expect(html.indexOf('Happening now')).toBeLessThan(html.indexOf('<time'));
    expect(html.indexOf('<time')).toBeLessThan(html.indexOf('Download shard 000'));
  });
});


/**
 * What Run — from a row, or from the bulk modal — leaves stale.
 *
 * A run the server ACCEPTS consumes that task's one-shot `runAt` and starts a session, so every
 * cached view of it is now wrong: the row itself, every task list and count, and the Project page
 * that shows the same task with its start. These rows come from the global list, which is the only
 * place a run can cross projects — so the project half is the half that used to be missed.
 *
 * Driven through a `MutationObserver` against a seeded cache, because these live behind a button
 * and a modal that a static render cannot press.
 */
describe('what a Run from the task list refreshes', () => {
  const T1 = 'aaa11111';
  const T2 = 'bbb22222';
  const T3 = 'ccc33333';
  const UNFILED = 'ddd44444';
  const PROJ_A = 'projAAA1';
  const PROJ_B = 'projBBB2';
  const PROJ_C = 'projCCC3';
  const SCHEDULED_AT = '2026-09-01T01:00:00.000Z';

  /** Every view a started run touches, plus a project and an index that must be left alone. */
  function seededCache() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const id of [T1, T2, T3, UNFILED])
      qc.setQueryData(['task', id], { id, runAt: SCHEDULED_AT });
    qc.setQueryData(['tasks', 'page', { filter: 'ALL', query: '', listId: null }], { pages: [] });
    qc.setQueryData(['tasks', 'counts', null, []], counts);
    qc.setQueryData(['project', PROJ_A], { id: PROJ_A });
    qc.setQueryData(['project', PROJ_A, 'tasks', 'root'], { items: [] });
    qc.setQueryData(['project', PROJ_A, 'tasks', 'children', 'parent62'], { items: [] });
    qc.setQueryData(['project', PROJ_B], { id: PROJ_B });
    qc.setQueryData(['project', PROJ_B, 'tasks', 'root'], { items: [] });
    qc.setQueryData(['project', PROJ_C], { id: PROJ_C });
    qc.setQueryData(['project', PROJ_C, 'tasks', 'root'], { items: [] });
    qc.setQueryData(['projects'], []);
    return qc;
  }

  const invalidatedIn = (qc: QueryClient) => (key: unknown[]) =>
    qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;

  /** Spies in place of the real toast, which needs a router and a portal. */
  const toast = () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() });

  /** One turn of the queue — enough for a settled promise chain to run. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const runResult = (over: Record<string, unknown> = {}) => ({
    dispatched: 2,
    failed: [],
    skipped: [],
    ...over,
  });

  it('starts the row’s own run, and refreshes its task, the lists and its project', async () => {
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({});

    const observer = new MutationObserver(qc, {
      ...runRowMutationOptions(qc, message),
      retry: false,
    });
    // The click draws the name; the mutation carries it as a variable and does not touch it.
    const triggerId = newRunRequestToken();
    await observer.mutate({ id: T1, projectId: PROJ_A, triggerId });

    // The request the row has always sent, now carrying the name of THIS press — which is what
    // makes an automatic resend below this line the same run rather than a second one.
    expect(vi.mocked(api)).toHaveBeenCalledWith(`/tasks/${T1}/execute`, {
      method: 'POST',
      body: { triggerId },
    });
    expect(message.success).toHaveBeenCalledWith('Run started');
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', T1])).toBe(true);
    expect(invalidated(['tasks', 'page', { filter: 'ALL', query: '', listId: null }])).toBe(true);
    expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
    // The project page, whichever level of its tree happens to be cached.
    expect(invalidated(['project', PROJ_A])).toBe(true);
    expect(invalidated(['project', PROJ_A, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', PROJ_A, 'tasks', 'children', 'parent62'])).toBe(true);
    // And nothing that never held this task.
    expect(invalidated(['project', PROJ_B])).toBe(false);
    expect(invalidated(['project', PROJ_B, 'tasks', 'root'])).toBe(false);
    expect(invalidated(['projects'])).toBe(false);
    expect(invalidated(['task', T2])).toBe(false);
  });

  it('refreshes no project for a row filed under none', async () => {
    // Most tasks are not in a project. Refetching one here would be work done for a page that
    // has never contained this row.
    for (const none of [null, undefined]) {
      const qc = seededCache();
      vi.mocked(api).mockClear();
      vi.mocked(api).mockResolvedValueOnce({});
      const observer = new MutationObserver(qc, {
        ...runRowMutationOptions(qc, toast()),
        retry: false,
      });
      await observer.mutate({ id: UNFILED, projectId: none });

      const invalidated = invalidatedIn(qc);
      expect(invalidated(['task', UNFILED])).toBe(true);
      expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
      for (const project of [PROJ_A, PROJ_B, PROJ_C]) {
        expect(invalidated(['project', project])).toBe(false);
        expect(invalidated(['project', project, 'tasks', 'root'])).toBe(false);
      }
    }
  });

  it('refreshes nothing when the row’s run is refused', async () => {
    // A refused run consumes no schedule and starts nothing, so a row redrawn as though it had
    // is the one report that would be wrong.
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error('no runner available'));

    const observer = new MutationObserver(qc, {
      ...runRowMutationOptions(qc, message),
      retry: false,
    });
    await observer
      .mutate({ id: T1, projectId: PROJ_A, triggerId: newRunRequestToken() })
      .catch(() => {});

    expect(observer.getCurrentResult().isError).toBe(true);
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', T1])).toBe(false);
    expect(invalidated(['tasks', 'page', { filter: 'ALL', query: '', listId: null }])).toBe(false);
    expect(invalidated(['project', PROJ_A])).toBe(false);
    expect(invalidated(['project', PROJ_A, 'tasks', 'root'])).toBe(false);
    // The reason reaches the reader whole, through the existing toast path.
    expect(message.error).toHaveBeenCalledWith('no runner available');
    expect(message.success).not.toHaveBeenCalled();
  });

  it('sends a NEW name when the reader presses again over a failed run', async () => {
    // The boundary this whole mechanism turns on. A press that failed left no run to be idempotent
    // WITH, and a second press is a person deciding to run the task again — answering it from the
    // failed press's receipt would answer a question nobody asked. Nothing remembers the failed
    // name, because the name is drawn at the CLICK and carried down as a variable: there is no
    // state between two clicks that could make them agree.
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error('no runner available'));
    vi.mocked(api).mockResolvedValueOnce({});

    const options = { ...runRowMutationOptions(qc, message), retry: false };
    await new MutationObserver(qc, options)
      .mutate({ id: T1, projectId: PROJ_A, triggerId: newRunRequestToken() })
      .catch(() => {});
    await new MutationObserver(qc, options)
      .mutate({ id: T1, projectId: PROJ_A, triggerId: newRunRequestToken() });

    const names = vi
      .mocked(api)
      .mock.calls.map(([, init]) => (init as { body: { triggerId: string } }).body.triggerId);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it('draws the name at the CLICK, not inside the request', () => {
    // WHERE it is drawn is the whole design, and it is not expressible as a type. Drawn inside
    // `mutationFn` it would be redrawn by react-query's own retry, so one press could reach the
    // server twice under two names; drawn once and remembered ACROSS presses, a deliberate second
    // press would be answered from the first one's receipt and never run. Both failures are
    // invisible to every other test here, so the wiring itself is pinned.
    const source = readFileSync(new URL('./TaskListView.tsx', import.meta.url), 'utf8');
    expect(source).toContain('triggerId: newRunRequestToken() }');
    expect(source).toContain('triggerId: newRunRequestToken(),');
    // ...and nowhere below the click: the mutations only ever destructure what they were handed.
    expect(source).not.toMatch(/mutationFn[\s\S]{0,400}newRunRequestToken/);
  });

  it('refreshes every project the batch came from, and sends only ids', async () => {
    const qc = seededCache();
    const message = toast();
    const dismiss = vi.fn();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce(runResult({ dispatched: 3 }));

    const observer = new MutationObserver(qc, {
      ...batchRunMutationOptions(qc, message, dismiss),
      retry: false,
    });
    // Two rows in one project, one in another, and one filed under none.
    const pressToken = newRunRequestToken();
    await observer.mutate({
      tasks: [
        { id: T1, projectId: PROJ_A },
        { id: T2, projectId: PROJ_A },
        { id: T3, projectId: PROJ_B },
        { id: UNFILED, projectId: null },
      ],
      maxConcurrent: 3,
      triggerId: pressToken,
    });

    // The project each row came from is local knowledge; the endpoint takes ids, a limit, and the
    // name of this press, and this body has nothing else in it.
    expect(vi.mocked(api)).toHaveBeenCalledWith('/tasks/batch-execute', {
      method: 'POST',
      body: { taskIds: [T1, T2, T3, UNFILED], maxConcurrent: 3, triggerId: pressToken },
    });
    const invalidated = invalidatedIn(qc);
    for (const id of [T1, T2, T3, UNFILED]) expect(invalidated(['task', id])).toBe(true);
    expect(invalidated(['tasks', 'page', { filter: 'ALL', query: '', listId: null }])).toBe(true);
    expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
    expect(invalidated(['project', PROJ_A])).toBe(true);
    expect(invalidated(['project', PROJ_A, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', PROJ_A, 'tasks', 'children', 'parent62'])).toBe(true);
    expect(invalidated(['project', PROJ_B])).toBe(true);
    expect(invalidated(['project', PROJ_B, 'tasks', 'root'])).toBe(true);
    // A project no selected row belonged to, and the index whose counts a run does not move.
    expect(invalidated(['project', PROJ_C])).toBe(false);
    expect(invalidated(['project', PROJ_C, 'tasks', 'root'])).toBe(false);
    expect(invalidated(['projects'])).toBe(false);
    // The modal closes and the selection drops, as before.
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(message.success).toHaveBeenCalledWith('Triggered 3 task(s)');
  });

  it('still tallies what was skipped, and refreshes the whole submitted set', async () => {
    // The response counts what it started but never names it, so a partial batch refreshes the
    // superset: a few rows that did not move, rather than a consumed schedule left on screen.
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce(
      runResult({
        dispatched: 1,
        failed: [{}],
        skipped: [{ reason: 'already running' }, { reason: 'already running' }],
      }),
    );

    const observer = new MutationObserver(qc, {
      ...batchRunMutationOptions(qc, message, vi.fn()),
      retry: false,
    });
    await observer.mutate({
      tasks: [
        { id: T1, projectId: PROJ_A },
        { id: T2, projectId: PROJ_A },
        { id: T3, projectId: PROJ_B },
      ],
      maxConcurrent: 2,
    });

    expect(message.success).toHaveBeenCalledWith(
      'Triggered 1 task(s), 1 failed, 2 skipped (already running \u00d72)',
    );
    const invalidated = invalidatedIn(qc);
    for (const id of [T1, T2, T3]) expect(invalidated(['task', id])).toBe(true);
    expect(invalidated(['project', PROJ_A])).toBe(true);
    expect(invalidated(['project', PROJ_B])).toBe(true);
  });

  it('refreshes nothing when the batch dispatched nothing', async () => {
    // Every row was skipped: no `runAt` was spent and no session started, so each refetch this
    // could trigger would redraw precisely what is already on screen.
    const qc = seededCache();
    const message = toast();
    const dismiss = vi.fn();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce(
      runResult({ dispatched: 0, skipped: [{ reason: 'no assignee' }] }),
    );

    const observer = new MutationObserver(qc, {
      ...batchRunMutationOptions(qc, message, dismiss),
      retry: false,
    });
    await observer.mutate({
      tasks: [
        { id: T1, projectId: PROJ_A },
        { id: T3, projectId: PROJ_B },
      ],
      maxConcurrent: 2,
    });

    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', T1])).toBe(false);
    expect(invalidated(['tasks', 'page', { filter: 'ALL', query: '', listId: null }])).toBe(false);
    expect(invalidated(['tasks', 'counts', null, []])).toBe(false);
    expect(invalidated(['project', PROJ_A])).toBe(false);
    expect(invalidated(['project', PROJ_B])).toBe(false);
    // ...while the modal still closes, the selection still drops, and the warning still says why.
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(message.warning).toHaveBeenCalledWith(
      'Triggered 0 task(s), 1 skipped (no assignee)',
    );
    expect(message.success).not.toHaveBeenCalled();
  });

  it('refreshes nothing when the batch request itself is refused', async () => {
    const qc = seededCache();
    const message = toast();
    const dismiss = vi.fn();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error('Too many tasks'));

    const observer = new MutationObserver(qc, {
      ...batchRunMutationOptions(qc, message, dismiss),
      retry: false,
    });
    await observer.mutate({ tasks: [{ id: T1, projectId: PROJ_A }], maxConcurrent: 1 }).catch(() => {});

    expect(observer.getCurrentResult().isError).toBe(true);
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', T1])).toBe(false);
    expect(invalidated(['project', PROJ_A])).toBe(false);
    expect(message.error).toHaveBeenCalledWith('Too many tasks');
    // The modal stays open on a refusal, so the reader can read it and try again.
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('stays pending until those views have actually refetched', async () => {
    // Otherwise the modal's Run button leaves its loading state the instant the server answers
    // and before a single query has refetched — enabled again, over the rows it just spent.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: () => void;
    const refetching = new Promise<void>((resolve) => {
      release = resolve;
    });
    qc.setQueryData(['project', PROJ_A, 'tasks', 'root'], { items: [] });
    // An ACTIVE observer, because an invalidation only refetches a query something is watching —
    // a Project page open in another tab is exactly that.
    const watcher = new QueryObserver(qc, {
      queryKey: ['project', PROJ_A, 'tasks', 'root'],
      queryFn: async () => {
        await refetching;
        return { items: [] };
      },
      refetchOnMount: false,
    });
    const unsubscribe = watcher.subscribe(() => {});
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce(runResult({ dispatched: 1 }));

    const observer = new MutationObserver(qc, {
      ...batchRunMutationOptions(qc, toast(), vi.fn()),
      retry: false,
    });
    const landed = observer.mutate({
      tasks: [{ id: T1, projectId: PROJ_A }],
      maxConcurrent: 1,
    });

    // The batch-execute POST is long done; the project page has not caught up.
    await tick();
    await tick();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().isPending).toBe(true);

    release();
    await landed;
    expect(observer.getCurrentResult().isPending).toBe(false);
    unsubscribe();
  });

  it('hands each mutation the row’s own project, not the current selection', () => {
    // The one binding no render and no mutation can show: which project id the view reads off a
    // row. Taken from the row itself so it cannot go stale — a poll between the click and the
    // server's answer can change what is selected, and `selectedRows` is read at click time for
    // the same reason.
    const source = readFileSync(new URL('./TaskListView.tsx', import.meta.url), 'utf8');
    expect(source).toContain('runOne.mutate({ id: r.id, projectId: r.projectId, triggerId:');
    expect(source).toContain(
      "tasks: selectedRows.map((r: any) => ({ id: r.id as string, projectId: r.projectId })),",
    );
  });
});
