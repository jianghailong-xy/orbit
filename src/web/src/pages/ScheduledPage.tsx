import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CONDITION_KEEPS_AWAKE_LINE,
  SCHEDULE_COPY,
  scheduleAllowedText,
  scheduleCircle,
  scheduleDateText,
  scheduleFill,
  scheduleHistoryWho,
  scheduleRecordText,
  scheduleRenamedText,
  scheduleRowCircle,
  scheduleRowLine,
  scheduleRuleRepeats,
  scheduleRuleText,
  scheduleCollapseMissed,
  scheduleEndText,
  scheduleMissedText,
  scheduleRunCircle,
  scheduleRunLine,
  scheduleRunOfText,
  scheduleTimeline,
  scheduleUsageText,
  scheduleWhenText,
  type ConditionEventView,
  type ScheduleChangeRecord,
  type ScheduleCircleView,
  type ScheduleCreateCard,
  type ScheduleDraftAnswer,
  type ScheduleListRow,
  type ScheduleRunView,
  type ScheduleTimelineGroup,
  type ScheduleTimelineItem,
  type ScheduleView,
} from '@orbit/shared';
import { api } from '../api';
import {
  scheduleChangePath,
  scheduleClock,
  scheduleDetailQuery,
  awaitDraftFrom,
  putRenameAnswer,
  renameSchedule,
  scheduleDraftsQuery,
  scheduleRecordUndoable,
  scheduleRunSessionPath,
  schedulesQuery,
  undoScheduleRecord,
  viewerTimezone,
} from '../lib/schedules';
import type { SessionReach } from '../lib/sessionReach';
import { ownerRequestsQuery } from '../lib/queries';
import { sameResourceId } from '../lib/watches';
import { isTypingTarget } from '../lib/helpDrawer';
import { OwnerRequestCard } from '../components/OwnerRequestCard';
import { isScheduleWaitingKind } from '../components/ScheduleWaitingCard';
import { isConditionWaitingKind } from '../components/ConditionWaitingCard';
import {
  CONDITION_COPY,
  conditionCantRead,
  conditionEveryText,
  conditionEventText,
  conditionFiringLines,
  conditionGauge,
  conditionQuery,
  conditionRowReading,
  conditionScheduleLine,
  conditionTaskLine,
  readingAgeText,
  readingText,
  type ConditionScheduleList,
  type ScheduleWaitingTask,
} from '../lib/conditions';
import { GaugeIcon, runFindingFacts, scheduleErrorText, ScheduleCreateCardView } from '../components/ScheduleCards';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { RenameField } from '../components/RenameField';
import { Menu } from '../components/ui/Menu';
import { Switch } from '../components/ui/Switch';
import { Tooltip } from '../components/ui/Tooltip';
import '../components/Scheduled.css';

const C = SCHEDULE_COPY;
const K = CONDITION_COPY;
const REPEAT = '↻';
const LAST_WORKSPACE_KEY = 'orbit:scheduled-quick-add-workspace';

interface WorkspaceRow {
  id: string;
  name: string;
}

/** A sentence sent from the quick-add line whose card has not come back yet: drawn as a draft at once. */
interface PendingDraft {
  sessionId: string;
  text: string;
  workspaceId: string;
}

type Selection =
  | { kind: 'schedule'; id: string }
  | { kind: 'draft'; id: string }
  | { kind: 'pending'; sessionId: string }
  | null;

/** A pick from a row's menu, which the inspector it opens carries out. */
type RowAsk = { id: string; action: 'run' | 'pause' | 'resume' | 'rename' | 'delete' };

function selectionOf(params: URLSearchParams): Selection {
  const id = params.get('id');
  if (id) return { kind: 'schedule', id };
  const draft = params.get('draft');
  if (draft) return { kind: 'draft', id: draft };
  const pending = params.get('pending');
  return pending ? { kind: 'pending', sessionId: pending } : null;
}

/** The circle at the left of a row. */
function Circle({ view }: { view: ScheduleCircleView }): JSX.Element {
  return (
    <span className="sched-circle" data-circle={view.circle} aria-hidden="true">
      {view.mark === 'check' ? '✓' : view.mark === 'alert' ? '!' : view.mark === 'clock' ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2.5V6l2.3 1.4" />
        </svg>
      ) : null}
    </span>
  );
}

function RowLine({ repeats, text, end }: { repeats: boolean; text: string; end?: string | null }): JSX.Element {
  return (
    <>
      <div className="sched-row-line">
        {repeats ? <span className="sched-repeat" aria-hidden="true">{REPEAT}</span> : null}
        {text}
      </div>
      {end ? <div className="sched-row-line sched-row-end">{end}</div> : null}
    </>
  );
}

interface RowView {
  key: string;
  circle: ScheduleCircleView;
  title: string;
  line: string;
  /** The planned end, on its own line so it is never the part that is cut off. */
  end?: string | null;
  repeats: boolean;
  time: string;
  cls: string;
  selected: boolean;
  onSelect: () => void;
  /** A row that never shows as selected (a past run, a task that opens elsewhere): Up/Down step over it. */
  noCursor?: true;
  /** The schedule a right-click on the row opens the menu of; absent on a draft's row and a task's. */
  schedule?: ScheduleListRow;
  /** A condition's row: the gauge in place of the circle, and the newest reading and its age in place of a time. */
  gauge?: 'waiting' | 'cant-read';
  reading?: { value: string | null; age: string };
}

function Row({ row, onMenu }: { row: RowView; onMenu?: (event: ReactMouseEvent, schedule: ScheduleListRow) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`sched-row${row.cls}${row.selected ? ' is-selected' : ''}`}
      data-row-focus=""
      aria-pressed={row.selected}
      data-row={row.key}
      onClick={row.onSelect}
      onContextMenu={onMenu && row.schedule ? (event) => onMenu(event, row.schedule!) : undefined}
    >
      {row.gauge ? (
        <span className="sched-gauge" data-gauge={row.gauge}><GaugeIcon /></span>
      ) : <Circle view={row.circle} />}
      <span className="sched-row-body">
        <span className="sched-row-text">
          <span className="sched-row-title">{row.title}</span>
          <RowLine repeats={row.repeats} text={row.line} end={row.end} />
        </span>
        {row.circle.tag ? <span className="sched-tag" data-tone={row.circle.tag.tone}>{row.circle.tag.text}</span> : null}
        {row.reading ? (
          <span className="sched-row-time sched-row-reading" data-reading="">
            {row.reading.value ? <b>{row.reading.value}</b> : null}
            {row.reading.value ? C.separator : null}
            {row.reading.age}
          </span>
        ) : <span className="sched-row-time">{row.time}</span>}
      </span>
    </button>
  );
}

/** A schedule's planned end for its row's own line: "until Nov 25", "3 runs left"; null without an end. */
function endOf(schedule: Pick<ScheduleListRow, 'endAt' | 'maxRuns' | 'runsLeft'>, now: Date, timezone: string): string | null {
  return scheduleEndText(schedule, now, timezone);
}

const OPEN_CIRCLE: ScheduleCircleView = { circle: 'open', mark: null, tag: null };

/** A group as the page draws it: the timeline's, or the conditions' own. */
interface Section {
  key: string;
  title: string;
  subtitle: string | null;
  rows: RowView[];
}

export function ScheduledPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const timezone = viewerTimezone();
  const workspaceFilter = params.get('workspace');
  const showPastRuns = params.get('past') === '1';
  const selection = selectionOf(params);

  const list = useQuery(schedulesQuery(workspaceFilter));
  const drafts = useQuery(scheduleDraftsQuery());
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    meta: { entities: ['workspace', 'checkout'] },
    queryFn: () => api<WorkspaceRow[]>('/workspaces'),
  });
  // One read draws the whole timeline: the rows, the runs of the shown window and their findings (the list's
  // timeline part). A schedule's detail is read only when it is opened in the inspector.
  const schedules = useMemo(() => list.data?.schedules ?? [], [list.data]);
  // The tasks that start when their condition holds (condition-triggers ④), listed beside the WHEN schedules.
  const waitingTasks = useMemo(() => (list.data as ConditionScheduleList | undefined)?.waitingTasks ?? [], [list.data]);

  const [pending, setPending] = useState<PendingDraft[]>([]);
  const draftCards = useMemo(
    () => (drafts.data?.drafts ?? []).filter((card) =>
      !workspaceFilter || sameResourceId(card.runsIn.workspaceId, workspaceFilter)),
    [drafts.data, workspaceFilter],
  );
  // A sentence's draft row stands until the agent's card for it comes back.
  const pendingRows = pending.filter((p) =>
    !(drafts.data?.drafts ?? []).some((card) => card.askedBySessionId && sameResourceId(card.askedBySessionId, p.sessionId)));

  // A scheduled task's items (failed, held, a run's approval, a run's wider envelope) and a condition's (it cannot be
  // read, or a task's has not held in 30 days) are drawn whole here, newest first, each a card with its own doors
  // (board docs/mocks/scheduled-tasks/web/02-board.png ④). There is no Waiting on you page
  // (docs/mocks/waiting-on-you-removal); the run's session draws the same card where it was filed.
  const openRequests = useQuery(ownerRequestsQuery('open'));
  const scheduleItems = (openRequests.data?.requests ?? [])
    .filter((request) => (isScheduleWaitingKind(request.kind) || isConditionWaitingKind(request.kind)) && request.state === 'PENDING')
    .filter((request) => !workspaceFilter
      || schedules.some((schedule) => request.scheduleId && sameResourceId(schedule.id, request.scheduleId))
      || (isConditionWaitingKind(request.kind) && !!request.workspaceId && sameResourceId(request.workspaceId, workspaceFilter)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const now = new Date();
  const runs = list.data?.runs ?? [];
  const placed = new Map(runs.map((run) => [run.id, run]));
  const groups = scheduleTimeline({ schedules, runs, drafts: draftCards, showPastRuns, now, timezone });

  const select = (next: Selection) => {
    const p = new URLSearchParams(params);
    p.delete('id');
    p.delete('draft');
    p.delete('pending');
    if (next?.kind === 'schedule') p.set('id', next.id);
    if (next?.kind === 'draft') p.set('draft', next.id);
    if (next?.kind === 'pending') p.set('pending', next.sessionId);
    setParams(p, { replace: true });
  };
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    setParams(p, { replace: true });
  };

  const rowOf = (group: ScheduleTimelineGroup, item: ReturnType<typeof scheduleCollapseMissed>[number]): RowView => {
    if (item.kind === 'MISSED') {
      const first = item.runs[0]!;
      return {
        key: `missed:${first.id}`,
        schedule: item.schedule,
        circle: scheduleRunCircle(first, { newFinding: false }),
        title: item.schedule.title,
        line: scheduleMissedText(item.runs, timezone),
        repeats: false,
        time: scheduleClock(item.at, timezone),
        cls: ' is-past',
        selected: false,
        onSelect: () => select({ kind: 'schedule', id: item.schedule.id }),
        noCursor: true,
      };
    }
    if (item.kind === 'DRAFT') {
      const card = item.card;
      return {
        key: `draft:${card.id}`,
        circle: scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 0 }, { draft: true }),
        title: card.title,
        line: scheduleRowLine(
          { rule: card.when.rule, workspaceName: card.runsIn.workspaceName, accessLevel: card.may.accessLevel, state: 'ACTIVE', heldReason: null },
          { draft: true },
        ),
        repeats: scheduleRuleRepeats(card.when.rule),
        time: scheduleClock(item.at, timezone),
        cls: ' is-draft',
        selected: selection?.kind === 'draft' && selection.id === card.id,
        onSelect: () => select({ kind: 'draft', id: card.id }),
      };
    }
    const schedule = item.schedule;
    const selected = selection?.kind === 'schedule' && sameResourceId(selection.id, schedule.id);
    const onSelect = () => select({ kind: 'schedule', id: schedule.id });
    if (item.kind === 'RUN') {
      const run = item.run;
      const underWay = run.state === 'QUEUED' || run.state === 'RUNNING' || run.state === 'AWAITING_APPROVAL';
      const facts = { newFinding: placed.get(run.id)?.newFinding ?? false, notified: placed.get(run.id)?.notified ?? false };
      const minutes = run.state === 'RUNNING' && run.startedAt
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(run.startedAt)) / 60_000))
        : null;
      return {
        key: `run:${run.id}`,
        schedule,
        circle: scheduleRunCircle(run, { newFinding: facts.newFinding }),
        title: schedule.title,
        line: underWay
          ? scheduleRowLine(schedule, { agentName: schedule.agentName, runningMinutes: minutes })
          : scheduleRunLine(run, { notified: facts.notified }),
        end: underWay ? endOf(schedule, now, timezone) : null,
        repeats: underWay && scheduleRuleRepeats(schedule.rule),
        time: scheduleClock(run.plannedAt, timezone),
        cls: underWay ? '' : ' is-past',
        selected: false,
        onSelect,
        noCursor: true,
      };
    }
    const inPaused = group.key === 'PAUSED';
    return {
      key: `${group.key}:${schedule.id}`,
      schedule,
      circle: scheduleRowCircle(schedule, runs),
      title: schedule.title,
      line: scheduleRowLine(schedule, {
        agentName: schedule.agentName,
        pausedAt: schedule.pausedAt ? new Date(schedule.pausedAt) : null,
        timezone,
      }),
      end: endOf(schedule, now, timezone),
      repeats: scheduleRuleRepeats(schedule.rule),
      time: item.at && !inPaused ? scheduleClock(item.at, timezone) : '',
      cls: inPaused ? ' is-paused' : '',
      selected,
      onSelect,
    };
  };

  // A WHEN schedule that is on and fine waits for its condition: it has no time, so the timeline places it nowhere,
  // and it gets a group of its own above Today. One that cannot be read is there too, tagged Can't read.
  const nowMs = now.getTime();
  const conditionScheduleRow = (schedule: ScheduleListRow, cantRead: boolean): RowView => ({
    key: `CONDITION:${schedule.id}`,
    schedule,
    circle: cantRead ? { circle: 'open', mark: null, tag: { tone: 'held', text: K.cantRead } } : scheduleRowCircle(schedule, runs),
    title: schedule.title,
    line: conditionScheduleLine(schedule),
    repeats: true,
    time: '',
    cls: '',
    selected: selection?.kind === 'schedule' && sameResourceId(selection.id, schedule.id),
    onSelect: () => select({ kind: 'schedule', id: schedule.id }),
    gauge: cantRead ? 'cant-read' : 'waiting',
    reading: !cantRead && schedule.condition ? conditionRowReading(schedule.condition, nowMs) : undefined,
  });
  const conditionTaskRow = (task: ScheduleWaitingTask, cantRead: boolean): RowView => ({
    key: `CONDITION:task:${task.id}`,
    circle: cantRead ? { circle: 'open', mark: null, tag: { tone: 'held', text: K.cantRead } } : OPEN_CIRCLE,
    title: task.title,
    line: conditionTaskLine(task),
    repeats: false,
    time: '',
    cls: '',
    selected: false,
    onSelect: () => navigate(`/tasks/${encodeURIComponent(task.id)}`),
    noCursor: true,
    gauge: cantRead ? 'cant-read' : 'waiting',
    reading: cantRead ? undefined : conditionRowReading(task.condition, nowMs),
  });
  const waitingWhen = schedules.filter((s) => s.rule.kind === 'WHEN' && s.state === 'ACTIVE');
  // Can't read first: the rows that need the owner lead the group.
  const waitingRows = [
    ...waitingWhen.filter((s) => conditionCantRead(s.condition)).map((s) => conditionScheduleRow(s, true)),
    ...waitingTasks.filter((t) => conditionCantRead(t.condition)).map((t) => conditionTaskRow(t, true)),
    ...waitingWhen.filter((s) => !conditionCantRead(s.condition)).map((s) => conditionScheduleRow(s, false)),
    ...waitingTasks.filter((t) => !conditionCantRead(t.condition)).map((t) => conditionTaskRow(t, false)),
  ];
  const sections: Section[] = groups.map((group) => ({
    key: group.key,
    title: group.title,
    subtitle: group.subtitle,
    rows: scheduleCollapseMissed(group.items).map((item) => rowOf(group, item)),
  }));
  if (waitingRows.length) {
    sections.unshift({
      key: 'CONDITION', title: K.group, subtitle: String(waitingRows.length), rows: waitingRows,
    });
  }

  const workspaceName = (id: string | null) =>
    workspaces.data?.find((w) => sameResourceId(w.id, id ?? ''))?.name ?? null;
  const pendingRowViews: RowView[] = pendingRows.map((p) => ({
    key: `pending:${p.sessionId}`,
    circle: scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 0 }, { draft: true }),
    title: p.text,
    line: [workspaceName(p.workspaceId), C.row.draft].filter(Boolean).join(C.separator),
    repeats: false,
    time: '',
    cls: ' is-draft',
    selected: selection?.kind === 'pending' && selection.sessionId === p.sessionId,
    onSelect: () => select({ kind: 'pending', sessionId: p.sessionId }),
  }));
  // The rows Up/Down step through, top to bottom as drawn.
  const cursorRows = [...sections.flatMap((section) => section.rows), ...pendingRowViews].filter((row) => !row.noCursor);

  // Up/Down move the selection to the row above or below, as a click on it would, and stop at the ends. Skipped
  // while typing, while a menu or dialog is open, and when something else already took the key.
  const cursorRef = useRef(cursorRows);
  cursorRef.current = cursorRows;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      const rows = cursorRef.current;
      if (rows.length === 0) return;
      const down = e.key === 'ArrowDown';
      const cur = rows.findIndex((row) => row.selected);
      const next = cur === -1 ? (down ? 0 : rows.length - 1) : cur + (down ? 1 : -1);
      if (next < 0 || next >= rows.length) return;
      e.preventDefault();
      const row = rows[next]!;
      row.onSelect();
      const el = document.querySelector<HTMLElement>(`.sched-row[data-row="${CSS.escape(row.key)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const filterLabel = workspaceFilter ? (workspaceName(workspaceFilter) ?? C.page.allWorkspaces) : C.page.allWorkspaces;
  const empty = list.isSuccess && schedules.length === 0 && waitingTasks.length === 0 && draftCards.length === 0
    && pendingRows.length === 0;

  const selectedSchedule = selection?.kind === 'schedule'
    ? schedules.find((s) => sameResourceId(s.id, selection.id)) ?? null
    : null;
  const selectedDraft = selection?.kind === 'draft'
    ? (drafts.data?.drafts ?? []).find((card) => card.id === selection.id) ?? null
    : null;
  const selectedPending = selection?.kind === 'pending'
    ? pending.find((p) => p.sessionId === selection.sessionId) ?? null
    : null;
  // The card for a sentence came back: its draft row takes over the selection.
  useEffect(() => {
    if (selection?.kind !== 'pending') return;
    const card = (drafts.data?.drafts ?? []).find((c) =>
      c.askedBySessionId && sameResourceId(c.askedBySessionId, selection.sessionId));
    if (card) select({ kind: 'draft', id: card.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.data, selection?.kind === 'pending' ? selection.sessionId : null]);

  // A right-click on a schedule's row: its menu, where the pointer is. A pick opens the schedule in the inspector,
  // which does what was picked.
  const [rowMenu, setRowMenu] = useState<{ schedule: ScheduleListRow; x: number; y: number } | null>(null);
  const [ask, setAsk] = useState<RowAsk | null>(null);
  const openRowMenu = (event: ReactMouseEvent, schedule: ScheduleListRow) => {
    event.preventDefault();
    setRowMenu({ schedule, x: event.clientX, y: event.clientY });
  };
  const pick = (schedule: ScheduleListRow, action: RowAsk['action']) => {
    setRowMenu(null);
    select({ kind: 'schedule', id: schedule.id });
    // On the next task: the menu's point is gone with it, so nothing comes back to take focus from Rename…'s field.
    window.setTimeout(() => setAsk({ id: schedule.id, action }), 0);
  };

  const [quickText, setQuickText] = useState('');
  const [inspectorWidth, startInspectorResize, inspectorResizing] = useInspectorWidth();
  const quickAdd = (
    <QuickAdd
      text={quickText}
      onText={setQuickText}
      workspaces={workspaces.data ?? []}
      initialWorkspaceId={workspaceFilter}
      onSent={(draft) => {
        setPending((rows) => [...rows, draft]);
        awaitDraftFrom(draft.sessionId);
        void qc.invalidateQueries({ queryKey: ['schedules', 'drafts'] });
        select({ kind: 'pending', sessionId: draft.sessionId });
      }}
    />
  );

  return (
    <div
      className={`sched-page${inspectorResizing ? ' is-resizing' : ''}`}
      style={inspectorWidth != null ? ({ '--sched-inspector-width': `${inspectorWidth}px` } as CSSProperties) : undefined}
    >
      <div className="sched-list">
        <header className="sched-head">
          <h1>{C.page.title}</h1>
          <span className="sched-total" data-schedule-total="">{schedules.length + waitingTasks.length}</span>
        </header>
        {empty && !workspaceFilter ? (
          <>
            <p className="sched-lead">{C.empty.lead}</p>
            {quickAdd}
            <ul className="sched-examples" data-schedule-examples="">
              {C.empty.examples.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => setQuickText(example)}>
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="sched-tools">
              <Menu
                trigger={<button type="button" className="sched-chip" data-schedule-filter="">{`${filterLabel} ▾`}</button>}
                items={[
                  { key: 'all', label: C.page.allWorkspaces, selected: !workspaceFilter, onSelect: () => setParam('workspace', null) },
                  ...(workspaces.data ?? []).map((w) => ({
                    key: w.id,
                    label: w.name,
                    selected: workspaceFilter === w.id,
                    onSelect: () => setParam('workspace', w.id),
                  })),
                ]}
              />
              <label className="sched-past-toggle">
                <Switch
                  size="small"
                  checked={showPastRuns}
                  onCheckedChange={(on) => setParam('past', on ? '1' : null)}
                  aria-label={C.page.showPastRuns}
                />
                {C.page.showPastRuns}
              </label>
            </div>
            {scheduleItems.length > 0 ? (
              <div className="sched-waiting-list" data-schedule-waiting="">
                {scheduleItems.map((request) => <OwnerRequestCard key={request.id} request={request} now={now.getTime()} />)}
              </div>
            ) : null}
            {sections.map((section) => (
              <section key={`${section.key}:${section.title}`} className="sched-group" data-group={section.key}>
                <h2>{section.title}{section.subtitle ? <small>{section.subtitle}</small> : null}</h2>
                {section.rows.map((row) => <Row key={row.key} row={row} onMenu={openRowMenu} />)}
              </section>
            ))}
            {pendingRowViews.map((row) => <Row key={row.key} row={row} />)}
            {quickAdd}
          </>
        )}
      </div>
      {selectedSchedule || selectedDraft || selectedPending ? (
        <div className="sched-resizer" data-schedule-resizer="" onMouseDown={startInspectorResize} />
      ) : null}
      {selectedSchedule ? (
        <ScheduleInspector
          key={selectedSchedule.id}
          schedule={selectedSchedule}
          ask={ask && sameResourceId(ask.id, selectedSchedule.id) ? ask : null}
          onAsked={() => setAsk(null)}
        />
      ) : selectedDraft ? (
        <DraftInspector
          card={selectedDraft}
          onOpenConversation={() => selectedDraft.askedBySessionId && navigate(`/sessions/${encodeURIComponent(selectedDraft.askedBySessionId)}`)}
        />
      ) : selectedPending ? (
        <aside className="sched-inspector" data-schedule-inspector="pending">
          <div className="sched-block sched-card-sub">{`“${selectedPending.text}”`}</div>
          <div className="sched-buttons">
            <Button onClick={() => navigate(`/sessions/${encodeURIComponent(selectedPending.sessionId)}`)}>
              {C.actions.openConversation}
            </Button>
          </div>
        </aside>
      ) : null}
      {rowMenu ? (
        <Menu
          open
          nativeButton={false}
          onOpenChange={(open) => { if (!open) setRowMenu(null); }}
          trigger={<span className="sched-menu-point" style={{ left: rowMenu.x, top: rowMenu.y }} />}
          items={[
            { key: 'run', label: C.actions.runNow, onSelect: () => pick(rowMenu.schedule, 'run') },
            rowMenu.schedule.state === 'PAUSED' || rowMenu.schedule.state === 'HELD'
              ? { key: 'resume', label: C.actions.resume, onSelect: () => pick(rowMenu.schedule, 'resume') }
              : { key: 'pause', label: C.actions.pause, onSelect: () => pick(rowMenu.schedule, 'pause') },
            { key: 'rename', label: C.actions.rename, onSelect: () => pick(rowMenu.schedule, 'rename') },
            {
              key: 'change',
              label: C.actions.change,
              onSelect: () => navigate(scheduleChangePath(rowMenu.schedule.id)),
            },
            { type: 'separator', key: 'separator' },
            { key: 'delete', label: C.actions.delete, danger: true, onSelect: () => pick(rowMenu.schedule, 'delete') },
          ]}
        />
      ) : null}
    </div>
  );
}

// The inspector's width is dragged by its left edge and kept in this browser; null until the first drag (CSS default).
const INSPECTOR_WIDTH_KEY = 'orbit.scheduleInspectorWidth';
const INSPECTOR_WIDTH = { min: 320, max: 900, listMin: 360 } as const;

function useInspectorWidth(): [number | null, (event: ReactMouseEvent<HTMLElement>) => void, boolean] {
  const [width, setWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    return stored > 0 && Number.isFinite(stored) ? Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, stored)) : null;
  });
  const [resizing, setResizing] = useState(false);
  const startResize = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const inspector = event.currentTarget.nextElementSibling;
    const list = event.currentTarget.previousElementSibling;
    const startWidth = inspector?.getBoundingClientRect().width ?? 400;
    // The list beside it keeps at least listMin; a list already narrower than that never shrinks further.
    const listWidth = list?.getBoundingClientRect().width ?? Infinity;
    const max = Math.max(startWidth, Math.min(INSPECTOR_WIDTH.max, startWidth + listWidth - INSPECTOR_WIDTH.listMin));
    let latest = startWidth;
    const onMove = (ev: MouseEvent) => {
      // It sits on the right: dragging left widens it.
      latest = Math.round(Math.min(max, Math.max(INSPECTOR_WIDTH.min, startWidth + startX - ev.clientX)));
      setWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      try {
        localStorage.setItem(INSPECTOR_WIDTH_KEY, String(latest));
      } catch {
        // Storage unavailable: the width lasts this page.
      }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizing(true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  return [width, startResize, resizing];
}

/** The line at the end of the list: one sentence and the workspace it goes to (board 1/2 ③ ⑤). Not a form. */
function QuickAdd({ text, onText: setText, workspaces, initialWorkspaceId, onSent }: {
  text: string;
  onText: (text: string) => void;
  workspaces: WorkspaceRow[];
  initialWorkspaceId: string | null;
  onSent: (draft: PendingDraft) => void;
}): JSX.Element {
  const [chosen, setChosen] = useState<string | null>(() => initialWorkspaceId ?? localStorage.getItem(LAST_WORKSPACE_KEY));
  const workspace = workspaces.find((w) => sameResourceId(w.id, chosen ?? '')) ?? workspaces[0] ?? null;
  const send = useMutation({
    mutationFn: (body: { workspaceId: string; text: string }) =>
      api<ScheduleDraftAnswer>('/schedules/drafts', { method: 'POST', body }),
    onSuccess: (answer, body) => {
      localStorage.setItem(LAST_WORKSPACE_KEY, body.workspaceId);
      setText('');
      onSent({ sessionId: answer.sessionId, text: body.text, workspaceId: body.workspaceId });
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const sentence = text.trim();
    if (!sentence || !workspace || send.isPending) return;
    send.mutate({ workspaceId: workspace.id, text: sentence });
  };
  const error = scheduleErrorText(send.error);
  return (
    <>
      <div className={`sched-add${text ? ' is-typing' : ''}`} data-schedule-add="">
        <span className="sched-add-plus" aria-hidden="true">+</span>
        <input
          className="sched-add-input"
          value={text}
          placeholder={C.quickAdd.placeholder}
          aria-label={C.quickAdd.placeholder}
          disabled={send.isPending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {workspaces.length > 0 ? (
          <Menu
            trigger={<button type="button" className="sched-chip" data-schedule-add-workspace="">{`${workspace?.name ?? ''} ▾`}</button>}
            items={workspaces.map((w) => ({
              key: w.id,
              label: w.name,
              selected: workspace?.id === w.id,
              onSelect: () => setChosen(w.id),
            }))}
          />
        ) : null}
        {text ? <span className="sched-add-hint">{C.quickAdd.hint}</span> : null}
      </div>
      {error ? <div className="sched-error" role="alert">{error}</div> : null}
    </>
  );
}

/** A draft's inspector (board 1/2 ④): what was typed, the create card, and its conversation. */
function DraftInspector({ card, onOpenConversation }: { card: ScheduleCreateCard; onOpenConversation: () => void }): JSX.Element {
  return (
    <aside className="sched-inspector" data-schedule-inspector="draft">
      <h2 className="sched-inspector-title is-draft">{card.title}</h2>
      <div className="sched-inspector-meta">
        {scheduleFill(C.inspector.draftMeta, { workspace: card.runsIn.workspaceName ?? card.runsIn.text })}
      </div>
      <div className="sched-block sched-card-sub">{`“${card.intent}”`}</div>
      <ScheduleCreateCardView card={card} layout="panel" onOpenConversation={card.askedBySessionId ? onOpenConversation : undefined} />
    </aside>
  );
}

type HistoryEntry =
  | { kind: 'run'; at: string; run: ScheduleRunView }
  | { kind: 'record'; at: string; record: ScheduleChangeRecord }
  | { kind: 'condition'; at: string; event: ConditionEventView; run: ScheduleRunView | null }
  | { kind: 'missed'; at: string; runs: ScheduleRunView[] };

/** The condition's events the history shows (§9): each firing, with the run it started, and each re-arm. */
const HISTORY_EVENTS: ReadonlySet<string> = new Set(['FIRED', 'READY_AGAIN']);

/**
 * A WHEN schedule's Condition and How it checks blocks (condition-triggers ⑥): the newest reading, its age and where it
 * stands against the firing and re-arm lines; then the interval, the runner, the command and when it was approved.
 */
function ConditionBlocks({ schedule, condition, now, timezone }: {
  schedule: ScheduleView;
  condition: ReturnType<typeof useConditionRead>;
  now: Date;
  timezone: string;
}): JSX.Element | null {
  if (schedule.rule.kind !== 'WHEN') return null;
  const rule = schedule.rule.condition;
  const unit = condition?.unit ?? rule.unit;
  const lastValue = condition?.lastValue ?? schedule.condition?.lastValue ?? null;
  const lastAt = condition?.lastReadAt ?? condition?.lastSampleAt ?? schedule.condition?.lastSampleAt ?? null;
  const compare = condition?.compare ?? { op: rule.compare.op, value: rule.compare.value };
  const rearm = condition ? condition.rearm : rule.rearm;
  const gauge = conditionGauge({ compare, rearm, unit, lastValue });
  const lines = conditionFiringLines({
    compare,
    holdSeconds: condition?.holdSeconds ?? rule.holdSeconds,
    rearm,
    unit,
    repeatSeconds: condition ? condition.repeatSeconds : rule.repeatSeconds,
  });
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <>
      <div className="sched-section">{K.sections.condition}</div>
      <div className="sched-block" data-inspector-block="condition">
        <div className="cond-reading">
          <span className="sched-big">{lastValue === null ? '—' : readingText(lastValue, unit)}</span>
          <span className="sched-label">{scheduleFill(K.checked, { age: readingAgeText(lastAt, now.getTime()) })}</span>
        </div>
        {gauge ? (
          <div className="cond-bar" data-condition-bar="">
            <span className="cond-bar-track">
              {gauge.value !== null ? <span className="cond-bar-fill" style={{ width: pct(gauge.value) }} /> : null}
              {gauge.rearm !== null ? <span className="cond-bar-mark is-rearm" style={{ left: pct(gauge.rearm) }} /> : null}
              {gauge.fire !== null ? <span className="cond-bar-mark is-fire" style={{ left: pct(gauge.fire) }} /> : null}
            </span>
            <span className="cond-bar-labels">
              {gauge.rearm !== null && rearm?.value != null ? (
                <span className="is-rearm" style={{ left: pct(gauge.rearm) }}>{readingText(rearm.value, unit)}</span>
              ) : null}
              {gauge.fire !== null && compare.value != null ? (
                <span className="is-fire" style={{ left: pct(gauge.fire) }}>{readingText(compare.value, unit)}</span>
              ) : null}
            </span>
          </div>
        ) : null}
        <div className="sched-label" data-condition-firing="">{lines.firing}</div>
        {lines.repeat ? <div className="sched-label" data-condition-repeat="">{lines.repeat}</div> : null}
      </div>
      <div className="sched-section">{K.sections.howItChecks}</div>
      <div className="sched-block" data-inspector-block="checks">
        <div>{conditionEveryText(condition?.intervalSeconds ?? rule.intervalSeconds, condition?.runnerName)}</div>
        <code className="sched-command">{condition?.probe.command ?? rule.command}</code>
        {condition ? (
          <div className="sched-label">{scheduleFill(K.approved, { date: scheduleDateText(new Date(condition.approvedAt), timezone) })}</div>
        ) : null}
        {condition?.keepsWorkspaceAwake ? <div className="sched-label" data-condition-awake="">{CONDITION_KEEPS_AWAKE_LINE}</div> : null}
      </div>
    </>
  );
}

/** A WHEN schedule's condition, read whole: its samples and events. */
function useConditionRead(schedule: Pick<ScheduleView, 'rule' | 'condition'>) {
  const id = schedule.rule.kind === 'WHEN' ? (schedule.rule.conditionId ?? schedule.condition?.id ?? null) : null;
  return useQuery({ ...conditionQuery(id ?? ''), enabled: Boolean(id) }).data ?? null;
}

function capitalFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const LATE_MS = 15 * 60_000;

/** A schedule's inspector (board 1/2 ②): read-back, next and last run, its doors, and what it has done. */
function ScheduleInspector({ schedule, ask, onAsked }: {
  schedule: ScheduleListRow;
  ask: RowAsk | null;
  onAsked: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const timezone = viewerTimezone();
  const now = new Date();
  const detailQ = useQuery(scheduleDetailQuery(schedule.id));
  const detail = detailQ.data;
  const s = detail?.schedule ?? schedule;
  const lastRun = detail?.lastRun ?? schedule.lastRun;
  const condition = useConditionRead(s);
  const isWhen = s.rule.kind === 'WHEN';
  // The conversation the words were said in, by its title. Its own key: the session detail's read goes through the
  // same door, but this needs the title alone.
  const asked = useQuery({
    queryKey: ['schedules', 'asked-in', s.createdFromSessionId] as const,
    meta: { entities: ['session'], sessionReach: { session: s.createdFromSessionId ?? '' } satisfies SessionReach },
    queryFn: () => api<{ title?: string | null }>(`/sessions/${encodeURIComponent(s.createdFromSessionId!)}`),
    enabled: Boolean(s.createdFromSessionId),
    staleTime: 300_000,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const control = useMutation({
    mutationFn: (door: 'run' | 'pause' | 'resume' | 'delete') =>
      door === 'delete'
        ? api(`/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        : api(`/schedules/${encodeURIComponent(s.id)}/${door}`, { method: 'POST' }),
    onSettled: invalidate,
  });
  const undo = useMutation({ mutationFn: undoScheduleRecord, onSettled: invalidate });
  // Delete asks first. The menu closes on its press; the dialog is drawn here, outside the menu's popover.
  const [confirm, confirmation] = useConfirm();
  const askDelete = () => void confirm({
    title: scheduleFill(C.deleteConfirm.title, { title: s.title }),
    description: C.deleteConfirm.body,
    confirmText: C.deleteConfirm.confirm,
    cancelText: C.deleteConfirm.cancel,
    danger: true,
    onConfirm: () => control.mutateAsync('delete'),
  });
  // Rename… (§8.4): the title is a field in place while it is being named. This holds the name the field opened with:
  // leaving it as it was saves nothing, even if the schedule was renamed elsewhere meanwhile.
  const [renaming, setRenaming] = useState<string | null>(null);
  const startRename = () => setRenaming(s.title);
  const rename = useMutation({
    mutationFn: (title: string) => renameSchedule(s.id, title),
    onSuccess: (answer) => putRenameAnswer(qc, answer),
    onSettled: invalidate,
  });
  // The ⋯ opens the field once its menu has handed focus back to the button: opened any sooner, that focus return
  // blurs, and so closes, the field.
  const moreButton = useRef<HTMLButtonElement>(null);
  const renameFromMore = () => {
    const button = moreButton.current;
    if (!button) return startRename();
    if (document.activeElement === button) button.blur();
    button.addEventListener('focus', startRename, { once: true });
  };
  // What a row's menu picked, once: the ref holds it against the effect running twice (StrictMode).
  const handled = useRef<RowAsk | null>(null);
  useEffect(() => {
    if (!ask || handled.current === ask) return;
    handled.current = ask;
    if (ask.action === 'rename') startRename();
    else if (ask.action === 'delete') void askDelete();
    else control.mutate(ask.action);
    onAsked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);
  const error = scheduleErrorText(control.error) ?? scheduleErrorText(undo.error) ?? scheduleErrorText(rename.error);

  const lastFacts = lastRun ? runFindingFacts(detail, lastRun) : { newFinding: false, notified: false };
  const meta = [
    scheduleRuleText(s.rule, 'long'),
    s.timezone,
    s.workspaceName,
    C.access[s.accessLevel].label,
  ].filter(Boolean).join(C.separator);

  // A firing names the run it started: that run is drawn on the Fired line, not again on a line of its own.
  const events = (condition?.events ?? []).filter((event) => HISTORY_EVENTS.has(event.kind));
  const runOf = (event: ConditionEventView) => (event.runId
    ? (detail?.recentRuns ?? []).find((run) => sameResourceId(run.id, event.runId!)) ?? null
    : null);
  const folded = events.map(runOf).filter((run): run is ScheduleRunView => run !== null);
  const history: HistoryEntry[] = [
    ...(detail?.recentRuns ?? [])
      .filter((run) => !folded.includes(run))
      .map((run) => ({ kind: 'run' as const, at: run.startedAt ?? run.plannedAt, run })),
    ...(detail?.history ?? []).map((record) => ({ kind: 'record' as const, at: record.createdAt, record })),
    ...events.map((event) => ({ kind: 'condition' as const, at: event.at, event, run: runOf(event) })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    // Consecutive missed slots, with nothing else between them, read as one line.
    .reduce<HistoryEntry[]>((out, entry) => {
      const last = out[out.length - 1];
      if (entry.kind === 'run' && entry.run.state === 'MISSED') {
        if (last?.kind === 'missed') last.runs.push(entry.run);
        else if (last?.kind === 'run' && last.run.state === 'MISSED') out[out.length - 1] = { kind: 'missed', at: last.at, runs: [last.run, entry.run] };
        else out.push(entry);
      } else out.push(entry);
      return out;
    }, []);

  // Change… (§8.2): the schedule's change conversation — the open one, or Orbit's opening for a new one.
  const change = () => navigate(scheduleChangePath(s.id));

  const endLine = scheduleEndText(s, now, timezone);
  // The end is the agent's to change, like every other part of a schedule: the composer opens with the ask.
  const askChange = (template: string) => navigate(`/workspaces/${encodeURIComponent(s.workspaceId)}/new`, {
    state: { composerText: scheduleFill(template, { title: s.title }) },
  });

  return (
    <aside className="sched-inspector" data-schedule-inspector="schedule">
      {renaming !== null ? (
        <RenameField
          label={C.history.fields.title}
          title={renaming}
          onDone={(title) => {
            setRenaming(null);
            if (title && title !== renaming.trim()) rename.mutate(title);
          }}
        />
      ) : (
        <h2 className="sched-inspector-title">
          <Tooltip content={C.actions.rename} side="bottom" align="start">
            <button type="button" className="sched-title" onClick={startRename}>
              {s.title}
            </button>
          </Tooltip>
        </h2>
      )}
      <div className="sched-inspector-meta">
        {scheduleRuleRepeats(s.rule) ? <span className="sched-repeat" aria-hidden="true">{REPEAT}</span> : null}
        {meta}
      </div>
      {endLine ? (
        <div className="sched-block" data-inspector-block="end">
          <span className="sched-label">{C.end.endLabel}</span>
          {C.separator}
          {endLine}
          {' '}
          <button type="button" className="sched-link" onClick={() => askChange(C.end.extendAsk)}>
            {C.end.extend}
          </button>
          {' '}
          <button type="button" className="sched-link" onClick={() => askChange(C.end.removeAsk)}>
            {C.end.remove}
          </button>
        </div>
      ) : null}
      {isWhen ? <ConditionBlocks schedule={s} condition={condition} now={now} timezone={timezone} /> : null}
      <div className="sched-block" data-inspector-block="next" hidden={isWhen}>
        <div className="sched-label">{C.inspector.nextRun}</div>
        <div className="sched-big">{s.nextDueAt ? scheduleWhenText(new Date(s.nextDueAt), now, timezone) : '—'}</div>
        {lastRun ? (
          <div data-inspector-block="last">
            <span className="sched-label">{C.inspector.last}</span>
            {C.separator}
            {scheduleWhenText(new Date(lastRun.startedAt ?? lastRun.plannedAt), now, timezone)}
            {C.separator}
            {scheduleRunLine(lastRun, { notified: lastFacts.notified })}
          </div>
        ) : null}
      </div>
      <div className="sched-buttons" data-inspector-block="doors">
        <Button size="small" variant="primary" disabled={control.isPending} onClick={() => control.mutate('run')}>
          {C.actions.runNow}
        </Button>
        {s.state === 'PAUSED' || s.state === 'HELD' ? (
          <Button size="small" disabled={control.isPending} onClick={() => control.mutate('resume')}>{C.actions.resume}</Button>
        ) : (
          <Button size="small" disabled={control.isPending} onClick={() => control.mutate('pause')}>{C.actions.pause}</Button>
        )}
        <Button size="small" onClick={change}>{C.actions.change}</Button>
        <Menu
          align="end"
          trigger={<Button ref={moreButton} size="small" className="sched-more" aria-label={C.actions.delete}>{'⋯'}</Button>}
          items={[
            { key: 'rename', label: C.actions.rename, onSelect: renameFromMore },
            { type: 'separator', key: 'separator' },
            { key: 'delete', label: C.actions.delete, danger: true, onSelect: askDelete },
          ]}
        />
      </div>
      {confirmation}
      {error ? <div className="sched-error" role="alert">{error}</div> : null}

      <div className="sched-section">{C.inspector.whatItDoes}</div>
      <div className="sched-block" data-inspector-block="does">{detail?.readBack ?? s.intent}</div>

      <div className="sched-section">{C.inspector.whatWasAsked}</div>
      <div className="sched-block" data-inspector-block="asked">
        {s.intent}
        {s.createdFromSessionId ? (
          <div className="sched-label">
            {(() => {
              const sentence = scheduleFill(C.inspector.yourWordsIn, {
                session: '\u0000',
                date: scheduleDateText(new Date(s.createdAt), timezone),
              });
              const [before, after] = sentence.split('\u0000');
              return (
                <>
                  {before}
                  <button
                    type="button"
                    className="sched-link"
                    onClick={() => navigate(`/sessions/${encodeURIComponent(s.createdFromSessionId!)}`)}
                  >
                    {asked.data?.title ?? C.inspector.session}
                  </button>
                  {after}
                </>
              );
            })()}
          </div>
        ) : null}
      </div>

      {s.note ? (
        <>
          <div className="sched-section">{C.inspector.notesForNextRun}</div>
          <div className="sched-block" data-inspector-block="note">
            {s.note}
            {lastRun ? (
              <div className="sched-label">
                {scheduleFill(C.inspector.leftByRunOf, { date: scheduleDateText(new Date(lastRun.plannedAt), timezone) })}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="sched-section">{C.inspector.thisMonth}</div>
      <div className="sched-block" data-inspector-block="month">
        <b>{detail ? scheduleUsageText(detail.usage) : ''}</b>
        <div className="sched-label">{scheduleAllowedText(s.envelope ?? s)}</div>
      </div>

      <div className="sched-section">{C.inspector.history}</div>
      <div className="sched-block sched-history" data-inspector-block="history">
        {history.map((entry) => {
          if (entry.kind === 'missed') {
            return (
              <div key={`missed:${entry.runs[0]!.id}`} className="sched-history-row" data-history="missed">
                <span className="sched-history-when">{scheduleWhenText(new Date(entry.at), now, timezone)}</span>
                <span className="sched-history-what" data-tone="failed">{scheduleMissedText(entry.runs, timezone)}</span>
              </div>
            );
          }
          if (entry.kind === 'condition') {
            const { event, run } = entry;
            const path = run ? scheduleRunSessionPath(run) : null;
            const ruleCondition = s.rule.kind === 'WHEN' ? s.rule.condition : null;
            return (
              <div key={`condition:${event.kind}:${event.at}`} className="sched-history-row" data-history="condition">
                <span className="sched-history-when">{scheduleWhenText(new Date(entry.at), now, timezone)}</span>
                <span className="sched-history-what">
                  {conditionEventText(event, {
                    unit: condition?.unit ?? ruleCondition?.unit ?? null,
                    holdSeconds: condition?.holdSeconds ?? ruleCondition?.holdSeconds ?? 0,
                  })}
                  {run ? (
                    <>
                      {C.separator}
                      {path ? (
                        <button type="button" className="sched-link" onClick={() => navigate(path)}>
                          {capitalFirst(scheduleRunOfText(run, timezone))}
                        </button>
                      ) : capitalFirst(scheduleRunOfText(run, timezone))}
                    </>
                  ) : null}
                </span>
                <span className="sched-who" data-who={run ? 'RUN' : 'CONDITION'}>{run ? K.history.run : K.history.condition}</span>
              </div>
            );
          }
          if (entry.kind === 'run') {
            const { run } = entry;
            const facts = runFindingFacts(detail, run);
            const view = scheduleRunCircle(run, { newFinding: facts.newFinding });
            const late = run.startedAt && Date.parse(run.startedAt) - Date.parse(run.plannedAt) > LATE_MS;
            const failed = run.state === 'FAILED' || run.state === 'MISSED' || run.state === 'HELD';
            const what = failed
              ? scheduleRunLine(run)
              : [view.tag?.text ?? C.runStates[run.state], run.key].filter(Boolean).join(' ');
            const path = scheduleRunSessionPath(run);
            return (
              <div key={`run:${run.id}`} className="sched-history-row" data-history="run">
                <span className="sched-history-when">{scheduleWhenText(new Date(entry.at), now, timezone)}</span>
                <span className="sched-history-what" data-tone={view.tag?.tone}>
                  {what}
                  {late ? `${C.separator}${C.inspector.late}` : ''}
                  {path ? (
                    <>
                      {C.separator}
                      <button type="button" className="sched-link" onClick={() => navigate(path)}>{C.inspector.session}</button>
                    </>
                  ) : null}
                </span>
              </div>
            );
          }
          const { record } = entry;
          const who = scheduleHistoryWho(record);
          return (
            <div key={`rev:${record.revision}`} className="sched-history-row" data-history="revision">
              <span className="sched-history-when">{scheduleWhenText(new Date(entry.at), now, timezone)}</span>
              <span className="sched-history-what">
                {scheduleRenamedText(record) ?? scheduleRecordText(record)}
                {record.askedText ? (
                  // Asked in the schedule's change conversation (§8.2): the person's words, and the way back to them.
                  <span className="sched-history-asked">
                    “{record.askedText}”
                    {record.sessionId ? (
                      <>
                        {C.separator}
                        <button type="button" className="sched-link" onClick={() => navigate(`/sessions/${encodeURIComponent(record.sessionId!)}`)}>
                          {C.changeConversation.conversation}
                        </button>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span className="sched-who" data-who={who.who}>{who.text}</span>
              {scheduleRecordUndoable(record) ? (
                <button type="button" className="sched-link" disabled={undo.isPending} onClick={() => undo.mutate(record)}>
                  {C.actions.undo}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
