import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { readFileSync } from 'node:fs';
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
