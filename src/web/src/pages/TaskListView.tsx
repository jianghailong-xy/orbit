import {
  CaretDownOutlined,
  CaretUpOutlined,
  DeleteOutlined,
  LockOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Spin,
  Tooltip,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { api, openTaskListConsole } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { TaskStatusPill } from '../components/TaskStatusPill';
import { deleteTask, deleteTasks } from '../lib/taskDeletion';
import {
  canDispatchTask,
  canStartTask,
  DEFAULT_TASK_FILTER,
  initialTaskFilter,
  rememberTaskFilter,
  matchesTaskFilter,
} from '../lib/taskFilters';
import { activeTasksQuery, labelSummaryQuery, taskCountsQuery } from '../lib/queries';
import type { LabelSummaryRow } from '../lib/taskPages';
import { taskPagePath, type TaskCounts, type TaskPage } from '../lib/taskPages';
import {
  anchorAt,
  dropAnchor,
  EMPTY_SELECTION,
  extendTo,
  selectAll,
  toggleOne,
} from '../lib/taskSelection';
import {
  compareTasksBy,
  DEFAULT_TASK_SORT_DIRECTION,
  DEFAULT_TASK_SORT_FIELD,
  readTaskSort,
  type TaskSortDirection,
  type TaskSortField,
  writeTaskSort,
} from '../lib/taskSorting';
import { useToast } from '../lib/toast';

// A checkbox is focusable but is not text entry, and clicking a row's checkbox leaves the
// focus sitting on it — so treating every <input> as "typing" would silence the whole list
// the moment the user checks their first row.
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color',
]);

// The list's keyboard shortcuts are bound on window, so they have to stand down whenever
// the user is actually typing somewhere.
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(target.type);
};

/**
 * Row geometry, in sync with `.task-row` in index.css.
 *
 * Fixed height is what makes windowing arithmetic rather than measurement: the first visible row
 * is `scrollTop / TASK_ROW_HEIGHT`, with no per-row observation and no layout thrash. If the row
 * height changes in CSS it has to change here too — the alternative is measuring every row, which
 * costs more than the whole optimisation saves.
 */
const TASK_ROW_HEIGHT = 44;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Covers the gap between a scroll event and the re-render that answers it, so fast scrolling
 * shows rows rather than blank space. Eight rows is ~350px, which a trackpad flick clears easily
 * — but it only has to survive one frame, not the whole gesture.
 */
const TASK_ROW_OVERSCAN = 8;

// What the header shows before the first page (which carries the scope-wide tallies) arrives.
const EMPTY_TASK_COUNTS: TaskCounts = {
  total: 0,
  open: 0,
  inProgress: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  running: 0,
  queued: 0,
  runnable: 0,
};

// Collapse a batch's per-task skip reasons into one countable summary
// ("Already running or queued ×2, No assignee ×1") for the result toast.
const tallyReasons = (skipped: { reason: string }[]): string => {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason)).join(', ');
};

// The task-list view: the task table (all tasks, or a single user list) plus its detail
// panel and batch-action modals. The task-list routes ("/tasks", "/lists/:key")
// render it, so all of its state is scoped to this component.

/**
 * Per-label progress: one row per batch, newest work included, all of it from a single
 * aggregate request.
 *
 * A table rather than a chart because 110 labels is far past the ~7 classes any colour scheme can
 * keep apart — past that the honest form is rows you can read and sort. Each row's meter is the
 * same one the page header already draws, so a batch and the whole scope are read the same way.
 */
function BatchesTable({
  rows,
  truncated,
  labelTotal,
  loading,
  onPick,
}: {
  rows: LabelSummaryRow[];
  truncated: boolean;
  labelTotal: number;
  loading: boolean;
  onPick: (label: string) => void;
}) {
  // Label order, not size order: these read as a progress table, and one whose rows reorder as
  // the work moves is one nobody can follow across two refreshes. For `CC-MAIN-yyyy-ww` it is
  // also chronological for free.
  const [sort, setSort] = useState<'label' | 'done' | 'remaining'>('label');
  const sorted = useMemo(() => {
    const copy = [...rows];
    if (sort === 'done') copy.sort((a, b) => b.done / b.total - a.done / a.total || a.label.localeCompare(b.label));
    else if (sort === 'remaining') copy.sort((a, b) => (b.total - b.done) - (a.total - a.done) || a.label.localeCompare(b.label));
    else copy.sort((a, b) => a.label.localeCompare(b.label));
    return copy;
  }, [rows, sort]);

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
        No labels here yet. Agents add them when they file a task.
      </div>
    );
  }

  const head = (key: typeof sort, text: string, className: string) => (
    <div
      className={`col-head ${className}${sort === key ? ' sorted' : ''}`}
      onClick={() => setSort(key)}
      role="button"
    >
      {text}
      {sort === key && <span className="batch-sort-caret">↓</span>}
    </div>
  );

  return (
    <div className="orbit-batchlist">
      <div className="col-head-row">
        {head('label', 'Label', 'batch-name')}
        <div className="col-head batch-meter">Progress</div>
        {head('done', 'Done', 'batch-num')}
        <div className="col-head batch-num">Total</div>
        {head('remaining', 'Left', 'batch-num')}
      </div>
      {sorted.map((row) => {
        const donePct = (row.done / row.total) * 100;
        const runPct = (row.inProgress / row.total) * 100;
        return (
          <div
            key={row.label}
            className="batch-row clickable"
            onClick={() => onPick(row.label)}
            title={`Show the ${row.total.toLocaleString()} tasks labelled ${row.label}`}
          >
            <div className="batch-name">{row.label}</div>
            <div className="batch-meter">
              <div className="task-progress-track">
                {/* A zero-width segment renders nothing at all — no sliver, and no gap either. */}
                {donePct > 0 && (
                  <span className="task-progress-seg done" style={{ width: `${donePct}%` }} />
                )}
                {runPct > 0 && (
                  <span
                    className="task-progress-seg ongoing"
                    style={{ width: `${runPct}%`, marginLeft: donePct > 0 ? 2 : 0 }}
                  />
                )}
              </div>
            </div>
            <div className="batch-num strong">{row.done.toLocaleString()}</div>
            <div className="batch-num">{row.total.toLocaleString()}</div>
            <div className="batch-num muted">{(row.total - row.done).toLocaleString()}</div>
          </div>
        );
      })}
      {truncated && (
        <div className="batch-truncated">
          Showing the {rows.length.toLocaleString()} largest of {labelTotal.toLocaleString()} labels.
        </div>
      )}
    </div>
  );
}

export function TaskListView() {
  const loc = useLocation();
  const message = useToast();
  const qc = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Multi-select for batch actions, keyed by task id, scoped to the visible rows. Carries
  // the anchor a Shift range is drawn from; see lib/taskSelection for the range semantics.
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const selectedIds = selection.ids;
  const [batchOpen, setBatchOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignWorkspaceId, setAssignWorkspaceId] = useState<string | null>(null);
  // Filter and sort live in the URL (?filter=…&sort=…&dir=…) so they survive a page
  // refresh and are shareable. A param is dropped when it equals its default, keeping
  // the URL clean for the initial view.
  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key: string, value: string, def: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === def) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  // The URL still owns the filter — it is what makes a view shareable — but with nothing in it
  // the last tab the user picked is what they get, not a fixed default.
  const filter = initialTaskFilter(searchParams.get('filter'));
  const setFilter = (v: string) => {
    rememberTaskFilter(v);
    // Compared against the static default, never against what was just stored: the stored value
    // is `v` by this point, so that comparison is always true and would strip `filter` from
    // every URL — leaving a shared link to resolve against whatever tab the *recipient* last
    // used. Any non-default tab stays spelled out in the URL and travels with it.
    setParam('filter', v, DEFAULT_TASK_FILTER);
  };
  // Which of the page's two views is showing. Tasks is the rows; Batches is the same scope
  // grouped by label. In the URL like every other bit of view state, so a batch table is
  // shareable and survives a refresh.
  const view = searchParams.get('view') === 'batches' ? 'batches' : 'tasks';
  const setView = (v: string) => setParam('view', v, 'tasks');
  // Labels are a scope, not a text match: they narrow the rows, the header bar and the tab
  // badges alike, because the server applies them before it counts. Comma-joined in the URL for
  // readability; sent as repeated params so a label containing a comma still round-trips.
  const labels = useMemo(() => {
    const raw = searchParams.get('labels') ?? '';
    return raw.split(',').map((l) => l.trim()).filter(Boolean);
  }, [searchParams]);
  const setLabels = (next: string[]) => setParam('labels', next.join(','), '');
  // Free-text filter over the visible rows' titles; lives in the URL (?q=…) like the rest
  // of the view state so it survives a refresh and is shareable.
  const query = searchParams.get('q') ?? '';
  const setQuery = (v: string) => setParam('q', v, '');
  // Client-side sort over the visible rows; status ascending is the default so live Running
  // tasks stay at the top. Column headers drive it: click cycles asc → desc → cleared (back
  // to the default status order). Field + direction are written in
  // one update so the two URL params never clobber each other.
  const { field: sortField, direction: sortDir } = readTaskSort(searchParams);
  const setSort = (field: TaskSortField, dir: TaskSortDirection) =>
    setSearchParams(
      (prev) => writeTaskSort(prev, field, dir),
      { replace: true },
    );
  const cycleSort = (field: TaskSortField) => {
    if (sortField !== field) setSort(field, 'asc');
    else if (sortDir === 'asc') setSort(field, 'desc');
    else setSort(DEFAULT_TASK_SORT_FIELD, DEFAULT_TASK_SORT_DIRECTION);
  };

  // /lists/<base62> renders a single user list instead of all tasks. routeId normalizes the
  // param to the public id the rest of the app holds; the server takes either spelling.
  // "/lists/none" is the virtual "未分组" view — tasks with no list. It isn't a real
  // list id, so skip decoding and scope the query with the server's own `none` sentinel.
  const listMatch = useMatch('/lists/:key');
  const isUnlisted = listMatch?.params.key === 'none';
  const listId = listMatch && !isUnlisted ? routeId(listMatch.params.key) : null;
  const isListView = !!listId;
  const scopeListId = isUnlisted ? 'none' : (listId ?? undefined);

  // Every view — all tasks, one user list, the unlisted bucket — pages through the same cursor
  // endpoint, which executes the status/title/list filters server-side, so even an owner with
  // tens of thousands of tasks downloads at most 200 rows per request. A single list used to be
  // fetched whole instead (GET /task-lists/:id embeds its tasks), which meant opening a 19k-task
  // list blocked the first paint on ~13MB of rows and then rendered every one of them. Poll only
  // the pages the user has actually loaded.
  const tasks = useInfiniteQuery({
    // `labels` only enters the key when there are any: react-query hashes the key with
    // JSON.stringify, which drops undefined-valued properties, so the unfiltered view keeps the
    // exact key it had before labels existed. Anything holding that key — a seeded cache, a
    // targeted invalidation — keeps matching it.
    queryKey: [
      'tasks',
      'page',
      { filter, query, listId: scopeListId ?? null, labels: labels.length ? labels : undefined },
    ],
    queryFn: ({ pageParam }) =>
      api<TaskPage>(
        taskPagePath({
          cursor: pageParam,
          limit: 200,
          status: filter,
          listId: scopeListId,
          labels,
          q: query,
          // Never the scope-wide block: that is its own request now, keyed by scope, so a tab
          // change is a cache hit rather than four aggregates over the whole task table. Page 1
          // still asks for `total`, which is the filtered count and does move with the tab and
          // the search box; later pages need neither.
          counts: pageParam ? 'none' : 'total',
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Polling refetches *every* page that has been loaded, so its cost grows with how far the
    // reader has scrolled — and with the window in place they can now scroll to 137 pages, which
    // would be 137 requests and ~31MB every interval. Past a handful of pages the list stops
    // polling itself: by then it is being read as history, and the part that has to stay live is
    // the pinned strip above it, which is bounded and refetches on its own every 5s.
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? [];
      if (pages.length > 5) return false;
      return pages.some((page) => page.items.some((t: any) => t.running || t.queued))
        ? 5_000
        : 15_000;
    },
  });
  const taskData = useMemo(
    () => (tasks.data?.pages ?? []).flatMap((page) => page.items),
    [tasks.data],
  );
  // The tallies have their own request, keyed by the scope they describe rather than by the tab.
  // They survive a tab change because nothing about them changed — no carrying, no cache trick,
  // just a query whose key says what it depends on.
  const taskCounts = useQuery(taskCountsQuery(scopeListId, labels));
  const taskPageCounts = taskCounts.data;
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api<any[]>('/workspaces') });
  // Feeds both the Batches table and the picker's options, so opening the picker costs no
  // request of its own and its entries can show what they would narrow to.
  // The work that is happening, fetched outside the paged list because it can never be in it:
  // tasks run oldest-first while the list is served newest-first, so the active ones sit at the
  // far end of the pagination — 550 pages down on this deployment. Only on the unfiltered tab;
  // Running and Failed already answer for themselves, and pinning a row above the tab that
  // exists to show it is just showing it twice.
  const activeTasks = useQuery({
    ...activeTasksQuery(scopeListId),
    enabled: view === 'tasks' && filter === 'ALL',
  });
  // Ranked by live state here, which is the one place that ranking is honest: the strip is the
  // complete set in scope (capped at 50 and reporting when it capped), not a page of it, so
  // "running first" is a statement about all of it rather than about what happened to load.
  const activeRows = useMemo(() => {
    if (filter !== 'ALL') return [];
    const items = activeTasks.data?.items ?? [];
    return [...items].sort((a: any, b: any) => compareTasksBy(a, b, 'status'));
  }, [activeTasks.data, filter]);
  const labelSummary = useQuery(labelSummaryQuery(scopeListId));
  const labelRows = labelSummary.data?.items ?? [];
  const hasLabels = labelRows.length > 0 || labels.length > 0;

  // The open list's own row, for the page title. Read off the lists index the sidebar already
  // holds — same key, so opening a list costs no request of its own — rather than the list
  // detail, whose whole payload is the tasks this view now pages through.
  const taskLists = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<{ id: string; title: string }[]>('/task-lists'),
  });
  const listRow = (taskLists.data ?? []).find((l) => l.id === listId);
  // An index with no such row means the list is gone — but only once it has been refetched for
  // *this* page view. The sidebar's copy can be up to 15s stale, and calling a list that was
  // created a second ago (over MCP, say, and deep-linked straight into) missing would be wrong.
  const listMissing = isListView && taskLists.isFetchedAfterMount && !listRow;
  // A /tasks/:id deep link (e.g. a session header's "回到任务") opens that task's detail
  // panel; routeId normalizes it to the public id TaskDetailPanel fetches by.
  const taskMatch = useMatch('/tasks/:id');
  const deepTaskId = taskMatch ? routeId(taskMatch.params.id) : null;
  // Switching lists/sections closes any open panel; a deep link opens its task instead.
  useEffect(() => setSelectedTaskId(deepTaskId), [listId, loc.pathname, deepTaskId]);
  // The selection is scoped to what's currently visible; reset it whenever that set
  // changes (different list/section, or a different status filter) to avoid running
  // tasks the user can no longer see.
  useEffect(() => setSelection(EMPTY_SELECTION), [listId, loc.pathname, filter]);
  // Re-sorting or re-searching keeps the selection — the rows are still there — but voids
  // the anchor: a range is defined by two rows' positions, which just moved under it.
  useEffect(() => setSelection(dropAnchor), [sortField, sortDir, query]);
  const pageTitle = isListView ? (listRow?.title ?? '') : isUnlisted ? 'No list' : 'Active';

  // ── The list's console ────────────────────────────────────────────────────────────────────
  //
  // One durable conversation per list, resolved or created server-side: going back to a list
  // goes back to the same conversation, with the reasoning behind every earlier policy change
  // still in it. Only offered on an actual list — "Active" and "No list" are views over tasks,
  // not campaigns with a policy to steer.
  const navigate = useNavigate();
  const [openingConsole, setOpeningConsole] = useState(false);
  const openConsole = async () => {
    if (!listId || openingConsole) return;
    setOpeningConsole(true);
    try {
      const { sessionId } = await openTaskListConsole(listId);
      navigate(`/sessions/${encodeId(sessionId)}`);
    } catch (e) {
      // The common cause is a list with no foreman and no workspace to fall back on, which the
      // server explains; surfacing its message beats a generic failure the user cannot act on.
      message.error(e instanceof Error ? e.message : 'Could not open the console');
      setOpeningConsole(false);
    }
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  // A deletion changes every task collection: the paged views (all, unlisted, one list) and
  // the sidebar's per-list counts.
  const invalidateAfterDelete = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      // Deleting a prerequisite removes dependency edges from other task details.
      qc.invalidateQueries({ queryKey: ['task'] }),
      qc.invalidateQueries({ queryKey: ['task-lists'] }),
    ]);

  const remove = useMutation({
    mutationFn: deleteTask,
    onSuccess: async (_res, id) => {
      // A row can be both checked and open in the detail panel. Do not leave either bit of
      // local UI state pointing at an entity which no longer exists.
      setSelection((prev) => {
        if (!prev.ids.has(id)) return prev;
        const ids = new Set(prev.ids);
        ids.delete(id);
        // The deleted row may have been the anchor; a range measured from it is meaningless.
        return { ids, anchor: null, base: null };
      });
      setSelectedTaskId((current) => (current === id ? null : current));
      qc.removeQueries({ queryKey: ['task', id], exact: true });
      message.success('Task deleted');
      await invalidateAfterDelete();
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Single-task run/retry from the row's hover actions; reuses the per-task execute the
  // detail panel uses. The backend validates assignee + runner and dedups an in-flight run,
  // so a stray double-click can't double-trigger.
  const runOne = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}/execute`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Run started');
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchRun = useMutation({
    mutationFn: (body: { taskIds: string[]; maxConcurrent: number }) =>
      api<{ dispatched: number; failed: unknown[]; skipped: { reason: string }[] }>(
        '/tasks/batch-execute',
        { method: 'POST', body },
      ),
    onSuccess: (res) => {
      setBatchOpen(false);
      setSelection(EMPTY_SELECTION);
      const parts = [`Triggered ${res.dispatched} task(s)`];
      if (res.failed.length) parts.push(`${res.failed.length} failed`);
      // A bare skip count leaves the user with no idea why nothing ran — the endpoint
      // reports a reason per task, so surface them tallied instead of dropping them.
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped (${tallyReasons(res.skipped)})`);
      message[res.dispatched ? 'success' : 'warning'](parts.join(', '));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchStop = useMutation({
    mutationFn: (body: { taskIds: string[] }) =>
      api<{ stopped: number; failed: unknown[]; tasks: number }>('/tasks/batch-stop', {
        method: 'POST',
        body,
      }),
    onSuccess: (res) => {
      setSelection(EMPTY_SELECTION);
      message[res.stopped ? 'success' : 'info'](
        res.stopped ? `Stopped ${res.stopped} run(s)` : 'No running tasks to stop',
      );
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchAssign = useMutation({
    mutationFn: (body: { taskIds: string[]; assigneeId: string | null }) =>
      api<{ updated: number }>('/tasks/batch-assign', { method: 'POST', body }),
    onSuccess: (res) => {
      setAssignOpen(false);
      setSelection(EMPTY_SELECTION);
      message.success(`Set assignee on ${res.updated} task(s)`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchDelete = useMutation({
    mutationFn: deleteTasks,
    onSuccess: async (res, ids) => {
      const deletedIds = new Set(ids);
      setSelection(EMPTY_SELECTION);
      setSelectedTaskId((current) => (current && deletedIds.has(current) ? null : current));
      for (const id of ids) qc.removeQueries({ queryKey: ['task', id], exact: true });
      message.success(`Deleted ${res.deleted} task${res.deleted === 1 ? '' : 's'}`);
      await invalidateAfterDelete();
    },
    // Keep the selection intact on failure so the user can inspect the error and retry.
    onError: (e: Error) => message.error(e.message),
  });

  // The rows currently shown, ordered by the selected sort field/direction. The server has
  // already narrowed the scope and the status filter; re-applying the filter here keeps a row
  // whose status changed under a poll from lingering in a tab it no longer belongs to.
  const visibleRows = useMemo(
    () => taskData.filter((t: any) => matchesTaskFilter(t, filter)),
    [taskData, filter],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q
      ? visibleRows.filter((r: any) => (r.title ?? '').toLowerCase().includes(q))
      : visibleRows;
    // Anything pinned above is removed here. On this deployment the two sets never overlap —
    // the active tasks sit 550 pages down — but that is a property of the data, not a guarantee,
    // and the same row twice reads as two tasks.
    const pinned = new Set(activeRows.map((r: any) => r.id));
    const filtered = pinned.size ? searched.filter((r: any) => !pinned.has(r.id)) : searched;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a: any, b: any) => dir * compareTasksBy(a, b, sortField));
  }, [visibleRows, query, sortField, sortDir, activeRows]);

  // Pull the next page when the end of the list comes into view, so a long list is read by
  // scrolling rather than by finding a button 200 rows down and clicking it 137 times.
  //
  // Rooted on .tasks-body because that is the element that scrolls — the viewport never moves,
  // so a document-rooted observer would never fire. The margin starts the fetch before the
  // sentinel is actually on screen, which is what makes continuous scrolling feel continuous
  // instead of stopping at every page boundary.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !tasks.hasNextPage || tasks.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void tasks.fetchNextPage();
      },
      { root: sentinel.closest('.tasks-body'), rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-armed after each page: the effect tears the observer down while a fetch is in flight
    // and sets it up again once the new rows have landed, so one page is requested at a time
    // even though the sentinel stays in view throughout.
  }, [tasks.hasNextPage, tasks.isFetchingNextPage, tasks.fetchNextPage, filter, query, view]);

  // The progress bar and the tab badges describe the whole scope, not the pages loaded so far,
  // so they can only come from the server. Page 1 always carries them (`counts=none` is sent
  // from page 2 on); until it lands — or if it fails — there is nothing to report.
  const counts = taskPageCounts ?? EMPTY_TASK_COUNTS;

  // When every visible task shares one assignee, the column is pure repetition: drop it and
  // surface the assignee once. `name` is null when all are unassigned (nothing to surface).
  const uniformAssignee = useMemo(() => {
    const names = new Set(taskData.map((t: any) => t.assignee?.name ?? null));
    return names.size === 1 ? { name: [...names][0] as string | null } : null;
  }, [taskData]);

  // The detail panel is a flex sibling that squeezes the list; with it open, drop the
  // assignee column too so the title keeps its width. Either condition hides the column.
  const panelOpen = selectedTaskId !== null;
  const showAssigneeCol = !uniformAssignee && !panelOpen;
  const filterOptions = useMemo(() => {
    const seg = (label: string, n: number, danger = false) => (
      <span className={`seg-opt${danger ? ' seg-opt--danger' : ''}`}>
        {label}
        <span className="seg-count">{n}</span>
      </span>
    );
    // Ordered as work moves through the system: everything, then what is waiting, then what
    // could start, then what is running, then how it ended. Each tab after the first is a
    // narrowing of the one before it (Ready is the unblocked part of Open, Running the part of
    // that which is in flight), so the row reads left to right as a pipeline rather than as an
    // arbitrary list.
    //
    // All leads because it is both the default and the superset. It used to sit second, behind
    // Ready — a leftover from when Ready was the default — which left the selected tab looking
    // like something the reader had picked rather than where the page opens.
    const opts = [
      { value: 'ALL', label: seg('All', counts.total) },
      { value: 'ONGOING', label: seg('Open', counts.open + counts.inProgress) },
      { value: 'RUNNABLE', label: seg('Ready', counts.runnable) },
      { value: 'RUNNING', label: seg('Running', counts.running) },
      { value: 'FAILED', label: seg('Failed', counts.failed, counts.failed > 0) },
      { value: 'DONE', label: seg('Done', counts.done) },
    ];
    // Cancelled is rare — only surface the tab once something's been cancelled (or while
    // it's the active filter, so a deep-linked CANCELLED view can still navigate away).
    if (counts.cancelled > 0 || filter === 'CANCELLED') {
      opts.push({ value: 'CANCELLED', label: seg('Cancelled', counts.cancelled) });
    }
    return opts;
  }, [counts, filter]);

  // ── Multi-select / batch-run derived state ──
  // The rows the batch actions operate on. This — not selection.ids — is what the bulk bar
  // counts: a polling refresh can drop a selected task out of the visible set (deleted, or
  // filtered away by a status change), and a count that includes those ghosts disagrees
  // with what Run/Delete would actually touch.
  const selectedRows = useMemo(
    () => rows.filter((r: any) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  const rowIds = useMemo(() => rows.map((r: any) => r.id as string), [rows]);
  const allSelected = rows.length > 0 && rows.every((r: any) => selectedIds.has(r.id));
  const someSelected = rows.some((r: any) => selectedIds.has(r.id));
  // What the batch will actually dispatch. This mirrors the endpoint's own skip rules
  // (see canDispatchTask) rather than only checking the assignee, so the modal's "will
  // run N" can't promise runs the backend is about to skip.
  const runnableRows = useMemo(() => selectedRows.filter(canDispatchTask), [selectedRows]);

  // Check/uncheck one row (it becomes the anchor), or — with Shift — draw the range from
  // the anchor to this row in the current sort order.
  const pickRow = (id: string, shift: boolean) =>
    setSelection((prev) => (shift ? extendTo(prev, id, rowIds) : toggleOne(prev, id)));
  const toggleAll = () => setSelection(allSelected ? EMPTY_SELECTION : selectAll(rowIds));
  const clearSelection = () => setSelection(EMPTY_SELECTION);

  const openBatch = () => {
    if (runnableRows.length === 0) {
      message.warning(
        'None of the selected tasks are ready to run (no assignee, no runner bound, unmet prerequisites, or already running)',
      );
      return;
    }
    // Batch concurrency is its own knob (it doesn't touch any runner's cap); default to
    // a sane few, never more than the number of tasks we're about to run.
    setConcurrency(Math.min(runnableRows.length, 3) || 1);
    setBatchOpen(true);
  };

  const openAssign = () => {
    // Pre-select the shared assignee when the whole selection already agrees, else blank.
    const ids = [...new Set(selectedRows.map((r: any) => r.assignee?.id ?? null))];
    setAssignWorkspaceId(ids.length === 1 ? ids[0] : null);
    setAssignOpen(true);
  };

  // Keyboard driving of the list. Up/Down step the cursor, opening each task like tabs —
  // the same selection a click drives; Shift+Up/Down extend the multi-selection as the
  // cursor moves; Space checks the cursor row; Cmd/Ctrl+A checks everything visible. All
  // skipped while typing, so the detail panel's comment box keeps its own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || isTypingTarget(e.target)) return;
      if (rows.length === 0) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelection(selectAll(rowIds));
        return;
      }
      if (e.key === ' ') {
        if (mod || e.shiftKey || !selectedTaskId) return;
        // Space scrolls the detail panel when the focus is inside it; don't steal that.
        if (document.activeElement?.closest('.task-detail-panel')) return;
        e.preventDefault();
        pickRow(selectedTaskId, false);
        return;
      }
      if (mod) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const cur = rows.findIndex((r: any) => r.id === selectedTaskId);
      let next: number;
      if (cur === -1) next = e.key === 'ArrowDown' ? 0 : rows.length - 1;
      else {
        next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= rows.length) return; // stop at the ends
      }
      e.preventDefault();
      const from = rows[cur === -1 ? next : cur].id;
      setSelection((prev) =>
        e.shiftKey
          ? // Grow from where the cursor already sits when no anchor has been set yet.
            extendTo(prev.anchor ? prev : anchorAt(prev, from), rows[next].id, rowIds)
          : // A plain move re-anchors, so a Shift-extend afterwards starts from here.
            anchorAt(prev, rows[next].id),
      );
      setSelectedTaskId(rows[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, rowIds, selectedTaskId]);

  // Esc clears a multi-selection first, and only falls through to the detail panel's own
  // Esc (a window listener too, but in the bubble phase) once there is none left.
  useEffect(() => {
    if (selectedRows.length === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedRows.length]);

  // Only the rows on screen are in the DOM. Everything below is arithmetic on a fixed row
  // height: the list holds its full length open with a spacer above and below the window, so the
  // scrollbar still describes the whole list while the node count stays flat. Measured before
  // this: 2,000 rows were 48.7k nodes and ~510MB of heap, and the list runs to 27,468.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowsStartRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, rowsTop: 0 });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      const start = rowsStartRef.current;
      // Where the rows begin inside the scroll container. Not a constant: the pinned strip and
      // the sticky header sit above them and both change height. Taken from the live geometry so
      // no layout number has to be duplicated in JS.
      const rowsTop = start
        ? start.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
        : 0;
      setViewport({ scrollTop: body.scrollTop, height: body.clientHeight, rowsTop });
    };
    measure();
    body.addEventListener('scroll', measure, { passive: true });
    // Catches window resizes and the pinned strip growing or shrinking under the rows.
    const resize = new ResizeObserver(measure);
    resize.observe(body);
    return () => {
      body.removeEventListener('scroll', measure);
      resize.disconnect();
    };
  }, [view, filter]);

  const windowed = useMemo(() => {
    const total = rows.length;
    if (total === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, rows: [] as any[] };
    // Before the first measurement the height is 0; render a screenful rather than nothing so
    // the first paint is never empty.
    const height = viewport.height || 900;
    const scrolledIn = Math.max(0, viewport.scrollTop - viewport.rowsTop);
    const start = Math.max(0, Math.floor(scrolledIn / TASK_ROW_HEIGHT) - TASK_ROW_OVERSCAN);
    const visible = Math.ceil(height / TASK_ROW_HEIGHT) + TASK_ROW_OVERSCAN * 2;
    const end = Math.min(total, start + visible);
    return {
      start,
      end,
      padTop: start * TASK_ROW_HEIGHT,
      padBottom: (total - end) * TASK_ROW_HEIGHT,
      rows: rows.slice(start, end),
    };
  }, [rows, viewport]);

  // Keep the highlighted row in view when arrowing through a long list. The row may not be in
  // the DOM at all now, so this scrolls by index instead of asking the element to scroll itself.
  useEffect(() => {
    if (!selectedTaskId) return;
    const body = bodyRef.current;
    if (!body) return;
    const index = rows.findIndex((r: any) => r.id === selectedTaskId);
    if (index < 0) return;
    const top = viewport.rowsTop + index * TASK_ROW_HEIGHT;
    const bottom = top + TASK_ROW_HEIGHT;
    // `block: 'nearest'` semantics: only move if the row is outside the viewport, and only far
    // enough to bring it in — arrowing down a list should not recentre it on every keystroke.
    if (top < body.scrollTop) body.scrollTop = top;
    else if (bottom > body.scrollTop + body.clientHeight) {
      body.scrollTop = bottom - body.clientHeight;
    }
    // Deliberately not re-running on scroll: this reacts to the selection moving, and viewport
    // is read for its geometry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, rows]);

  // A clickable column header that drives the sort. Active header shows a caret for the
  // direction; clicking cycles asc → desc → cleared (handled by cycleSort).
  const sortHead = (field: TaskSortField, label: string) => {
    const active = sortField === field;
    return (
      <div
        className={`col-head sortable${active ? ' active' : ''}`}
        onClick={() => cycleSort(field)}
      >
        {label}
        {active &&
          (sortDir === 'asc' ? (
            <CaretUpOutlined className="col-sort-caret" />
          ) : (
            <CaretDownOutlined className="col-sort-caret" />
          ))}
      </div>
    );
  };

  const renderRow = (r: any) => {
    // The workspace assigned to run the task (GET /tasks and the list view both include it).
    const assigneeName = r.assignee?.name ?? null;
    const selected = selectedTaskId === r.id;
    // Row-level run/retry: offered only for an actionable, runnable task that isn't busy,
    // blocked, or already done. FAILED reframes the same action as "Retry".
    const canRunRow = canStartTask(r);
    const isRetry = r.status === 'FAILED';
    return (
      <div
        className={`task-row clickable${selected ? ' selected' : ''}${
          selectedIds.has(r.id) ? ' checked' : ''
        }`}
        key={r.id}
        // Shift/Cmd-clicking the row body drives the multi-selection, the way a file list
        // does; a plain click still opens the task in the detail panel.
        onMouseDown={(e) => {
          // Shift-clicking would otherwise drag a native text selection across the list.
          if (e.shiftKey) e.preventDefault();
        }}
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) pickRow(r.id, e.shiftKey);
          else setSelectedTaskId(r.id);
        }}
      >
        <div
          className="task-check"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if (e.shiftKey) e.preventDefault();
          }}
        >
          <Checkbox
            checked={selectedIds.has(r.id)}
            onChange={(e) => pickRow(r.id, e.nativeEvent.shiftKey)}
          />
        </div>
        <div className="task-status-cell">
          <TaskStatusPill status={r.status} running={r.running} queued={r.queued} />
        </div>
        <div className="task-title-cell">
          <span className="task-title" title={r.title}>
            {r.title ?? ''}
          </span>
          {r.blocked ? (
            <Tooltip
              title={r.dependencyState === 'BLOCKED_FAILED' ? 'Prerequisite cancelled — resolve it' : 'Waiting for prerequisites'}
            >
              <LockOutlined
                style={{
                  fontSize: 12,
                  color: r.dependencyState === 'BLOCKED_FAILED' ? 'var(--error-solid)' : 'var(--text-3)',
                }}
              />
            </Tooltip>
          ) : null}
        </div>
        {showAssigneeCol && (
          <div className="task-creator">
            {assigneeName ? (
              <>
                <Avatar
                  size={22}
                  style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 11, flex: 'none' }}
                >
                  {assigneeName.trim().charAt(0).toUpperCase()}
                </Avatar>
                <span className="task-cell">{assigneeName}</span>
              </>
            ) : (
              <span className="task-cell">Unassigned</span>
            )}
          </div>
        )}
        <div className="row-actions">
          {canRunRow && (
            <Tooltip title={isRetry ? 'Retry' : 'Run'}>
              <Button
                size="small"
                type="text"
                icon={isRetry ? <ReloadOutlined /> : <PlayCircleOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  runOne.mutate(r.id);
                }}
              />
            </Tooltip>
          )}
          <Popconfirm
            title="Delete this task?"
            // A run in flight is stopped, not detached: with the task gone it has no way left to
            // finish, so leaving it would park it forever. Worth saying before the click.
            description="A run still in flight is stopped. This action cannot be undone."
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{
              danger: true,
              loading: remove.isPending && remove.variables === r.id,
            }}
            onConfirm={() => remove.mutate(r.id)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={`Delete ${r.title}`}
              loading={remove.isPending && remove.variables === r.id}
              disabled={remove.isPending && remove.variables !== r.id}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </div>
      </div>
    );
  };

  return (
    <>
      <main className="app-main">
        <div className="app-view app-view--doc app-view--tasks">
          {/* Title · progress · filters stay put; only the rows below them scroll. */}
          <div className="tasks-header">
            {/* Title and console share one line: `.page-title` is a block-level h1, so the
                button needs the row or it drops beneath the heading. */}
            <div className="tasks-title-row">
              <h1 className="page-title">{pageTitle}</h1>
              {isListView && (
                <Button
                  size="small"
                  onClick={openConsole}
                  loading={openingConsole}
                  title="Open the conversation this list is steered from"
                >
                  调度会话 ›
                </Button>
              )}
            </div>

            {hasLabels && (
              <Segmented
                className="tasks-viewswitch"
                size="small"
                value={view}
                onChange={(v) => setView(v as string)}
                options={[
                  { label: 'Tasks', value: 'tasks' },
                  { label: 'Batches', value: 'batches' },
                ]}
              />
            )}

            {counts.total > 0 && (
              <div className="task-progress">
                <div className="task-progress-track">
                  <span
                    className="task-progress-seg done"
                    style={{ width: `${(counts.done / counts.total) * 100}%` }}
                  />
                  <span
                    className="task-progress-seg ongoing"
                    style={{ width: `${(counts.running / counts.total) * 100}%` }}
                  />
                </div>
                <div className="task-progress-text">
                  Done <b>{counts.done}</b> / {counts.total}
                  <span className="sep">·</span>Open {counts.open + counts.inProgress}
                  {counts.running > 0 && (
                    <>
                      <span className="sep">·</span>Running {counts.running}
                    </>
                  )}
                  {counts.queued > 0 && (
                    <>
                      <span className="sep">·</span>Queued {counts.queued}
                    </>
                  )}
                  {counts.failed > 0 && (
                    <>
                      <span className="sep">·</span>Failed {counts.failed}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* The filter row belongs to the rows it filters. In Batches nothing below it is a
                task — a status tab there highlights a filter that changes nothing, and a label
                picker duplicates the table itself. */}
            <div className="tasks-toolbar" hidden={view === 'batches'}>
              {selectedRows.length > 0 ? (
                // Selection mode: the batch-action bar takes over the whole toolbar row so it
                // never has to share width with the filters (which made it wrap to a 2nd line).
                // Clear restores the filter toolbar.
                <div className="tasks-bulkbar">
                  <span className="tasks-bulkbar-count">{selectedRows.length} selected</span>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={openBatch}
                  >
                    Run
                  </Button>
                  <Popconfirm
                    title="Stop selected tasks?"
                    description="Cancels each selected task's running or queued run."
                    okText="Stop"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => batchStop.mutate({ taskIds: selectedRows.map((r: any) => r.id) })}
                  >
                    <Button size="small" danger icon={<StopOutlined />} loading={batchStop.isPending}>
                      Stop
                    </Button>
                  </Popconfirm>
                  <Button size="small" icon={<UserOutlined />} onClick={openAssign}>
                    Set assignee
                  </Button>
                  <Popconfirm
                    title={`Delete ${selectedRows.length} selected task${selectedRows.length === 1 ? '' : 's'}?`}
                    description="Runs still in flight are stopped. This action cannot be undone."
                    okText="Delete"
                    cancelText="Cancel"
                    okButtonProps={{ danger: true, loading: batchDelete.isPending }}
                    onConfirm={() => batchDelete.mutate(selectedRows.map((r: any) => r.id))}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      loading={batchDelete.isPending}
                    >
                      Delete
                    </Button>
                  </Popconfirm>
                  <Button type="text" size="small" onClick={clearSelection}>
                    Clear
                  </Button>
                </div>
              ) : (
                <>
                  <Segmented
                    options={filterOptions}
                    value={filter}
                    onChange={(v) => setFilter(v as string)}
                  />
                  <Input
                    className="tasks-search"
                    size="small"
                    allowClear
                    prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
                    placeholder="Search tasks"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {hasLabels && (
                    <Select
                      className="tasks-labelfilter"
                      size="small"
                      mode="multiple"
                      allowClear
                      // A picker, not a wall of chips: this deployment has 110 labels, and every
                      // one of them as a toggle would be wallpaper rather than a control.
                      showSearch
                      optionFilterProp="label"
                      maxTagCount={2}
                      placeholder="Labels"
                      value={labels}
                      onChange={(v) => setLabels(v as string[])}
                      options={labelRows.map((row) => ({
                        value: row.label,
                        label: row.label,
                        // The count is why one label is worth picking over another; showing it
                        // here saves a round trip through the table to find that out.
                        title: `${row.done}/${row.total} done`,
                      }))}
                      optionRender={(option) => {
                        const row = labelRows.find((r) => r.label === option.value);
                        return (
                          <span className="tasks-labelopt">
                            <span className="tasks-labelopt-name">{option.label}</span>
                            {row && <span className="tasks-labelopt-count">{row.total}</span>}
                          </span>
                        );
                      }}
                    />
                  )}
                  {uniformAssignee?.name && (
                    <span className="task-assignee-chip" style={{ marginLeft: 'auto' }}>
                      <Avatar
                        size={18}
                        style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 10, flex: 'none' }}
                      >
                        {uniformAssignee.name.trim().charAt(0).toUpperCase()}
                      </Avatar>
                      {uniformAssignee.name}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="tasks-body" ref={bodyRef}>
            {tasks.isLoading ? (
              <div style={{ padding: 48, textAlign: 'center' }}>
                <Spin />
              </div>
            ) : listMissing ? (
              <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
                This list could not be loaded.
              </div>
            ) : tasks.isError ? (
              <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
                Tasks could not be loaded.
              </div>
            ) : view === 'batches' ? (
              <BatchesTable
                rows={labelRows}
                truncated={labelSummary.data?.truncated ?? false}
                labelTotal={labelSummary.data?.labelTotal ?? 0}
                loading={labelSummary.isLoading}
                onPick={(label) => {
                  setLabels([label]);
                  setView('tasks');
                }}
              />
            ) : (
              <div className={`orbit-tasklist${showAssigneeCol ? '' : ' no-assignee'}`}>
                <div className="col-head-row">
                  <div className="col-head task-check">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={toggleAll}
                      disabled={rows.length === 0}
                    />
                  </div>
                  {sortHead('status', 'Status')}
                  {sortHead('title', 'Task')}
                  {showAssigneeCol && sortHead('assignee', 'Assignee')}
                </div>

                {activeRows.length > 0 && (
                  <div className="task-active-strip">
                    <div className="task-active-head">
                      <span className="task-active-title">Happening now</span>
                      <span className="task-active-hint">
                        {activeTasks.data?.truncated
                          ? `${activeRows.length} of ${(activeTasks.data?.total ?? 0).toLocaleString()} — open the Failed or Running tab for the rest`
                          : 'Running, queued, in progress or failed — pinned because the list below is ordered by creation time'}
                      </span>
                    </div>
                    {activeRows.map(renderRow)}
                  </div>
                )}

                {/* Marks where the rows start, so the window knows how much sits above them. */}
                <div ref={rowsStartRef} />
                {rows.length === 0 ? (
                  <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
                    {query.trim()
                      ? `No tasks match “${query.trim()}”.`
                      : filter === 'RUNNABLE'
                        ? 'No tasks are ready to run.'
                        : filter === 'RUNNING'
                          ? 'No tasks are running.'
                        : isListView
                        ? 'No tasks in this list yet.'
                        : isUnlisted
                          ? 'No tasks without a list yet.'
                          : 'No tasks yet.'}
                  </div>
                ) : (
                  <>
                    {/* The rows that are not rendered are still occupying their height, so the
                        scrollbar measures the list rather than the window onto it. */}
                    <div style={{ height: windowed.padTop }} aria-hidden />
                    {windowed.rows.map((r: any) => renderRow(r))}
                    <div style={{ height: windowed.padBottom }} aria-hidden />
                  </>
                )}
                {tasks.hasNextPage && (
                  // Also the scroll sentinel. The button stays because auto-loading is invisible
                  // when it works and unrecoverable when it doesn't: it shows how far in you are,
                  // and still loads the next page on click if the observer never fires.
                  <div className="tasks-loadmore" ref={loadMoreRef}>
                    <Button
                      loading={tasks.isFetchingNextPage}
                      onClick={() => tasks.fetchNextPage()}
                    >
                      {tasks.isFetchingNextPage ? 'Loading' : 'Load more'} ({taskData.length} of{' '}
                      {tasks.data?.pages[0]?.total ?? taskData.length})
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          summary={rows.find((r: any) => r.id === selectedTaskId)}
          onOpenTask={setSelectedTaskId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <Modal
        title="Run tasks"
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={() =>
          batchRun.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            maxConcurrent: concurrency,
          })
        }
        confirmLoading={batchRun.isPending}
        okText="Run"
        okButtonProps={{ disabled: runnableRows.length === 0 }}
      >
        <p style={{ marginTop: 0 }}>
          Will run <b>{runnableRows.length}</b> selected task(s)
          {selectedRows.length > runnableRows.length
            ? `, skipping ${selectedRows.length - runnableRows.length} that aren't ready (no assignee, no runner bound, unmet prerequisites, or already running)`
            : ''}
          .
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Concurrency</span>
          <InputNumber
            min={1}
            max={64}
            value={concurrency}
            onChange={(v) => setConcurrency(v ?? 1)}
            style={{ width: 96 }}
          />
          <span style={{ color: 'var(--text-3)' }}>tasks running at once</span>
        </div>
        <p style={{ marginTop: 10, marginBottom: 0, color: 'var(--text-3)', fontSize: 12 }}>
          All tasks are submitted at once; at most this many run concurrently in this batch, the rest queue and start as slots free up. This limit applies only to this batch and never changes any runner's own concurrency cap.
        </p>
      </Modal>

      <Modal
        title="Set assignee"
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={() =>
          batchAssign.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            assigneeId: assignWorkspaceId,
          })
        }
        confirmLoading={batchAssign.isPending}
        okText="OK"
      >
        <p style={{ marginTop: 0 }}>
          Set the assignee (responsible workspace) for <b>{selectedRows.length}</b> selected task(s).
        </p>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="Pick a workspace, leave empty to clear the assignee"
          value={assignWorkspaceId ?? undefined}
          onChange={(v) => setAssignWorkspaceId(v ?? null)}
          options={(workspaces.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
      </Modal>
    </>
  );
}
