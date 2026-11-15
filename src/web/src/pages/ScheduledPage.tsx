import { useEffect, useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  SCHEDULE_COPY,
  scheduleAllowedText,
  scheduleCircle,
  scheduleDateText,
  scheduleFill,
  scheduleHistoryWho,
  scheduleRecordText,
  scheduleRowLine,
  scheduleRuleRepeats,
  scheduleRuleText,
  scheduleRunCircle,
  scheduleRunLine,
  scheduleTimeline,
  scheduleUsageText,
  scheduleWhenText,
  type ScheduleChangeRecord,
  type ScheduleCircleView,
  type ScheduleCreateCard,
  type ScheduleDraftAnswer,
  type ScheduleListRow,
  type ScheduleRunView,
  type ScheduleTimelineGroup,
  type ScheduleTimelineItem,
} from '@orbit/shared';
import { api } from '../api';
import {
  scheduleClock,
  scheduleDetailQuery,
  scheduleDraftsQuery,
  scheduleRecordUndoable,
  scheduleRunSessionPath,
  schedulesQuery,
  undoScheduleRecord,
  viewerTimezone,
} from '../lib/schedules';
import { sameResourceId } from '../lib/watches';
import { runFindingFacts, scheduleErrorText, ScheduleCreateCardView } from '../components/ScheduleCards';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Menu } from '../components/ui/Menu';
import { Switch } from '../components/ui/Switch';
import '../components/Scheduled.css';

const C = SCHEDULE_COPY;
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
      {view.mark === 'check' ? '✓' : view.mark === 'alert' ? '!' : null}
    </span>
  );
}

function RowLine({ repeats, text }: { repeats: boolean; text: string }): JSX.Element {
  return (
    <div className="sched-row-line">
      {repeats ? <span className="sched-repeat" aria-hidden="true">{REPEAT}</span> : null}
      {text}
    </div>
  );
}

interface RowView {
  key: string;
  circle: ScheduleCircleView;
  title: string;
  line: string;
  repeats: boolean;
  time: string;
  cls: string;
  selected: boolean;
  onSelect: () => void;
}

function Row({ row }: { row: RowView }): JSX.Element {
  return (
    <button
      type="button"
      className={`sched-row${row.cls}${row.selected ? ' is-selected' : ''}`}
      aria-pressed={row.selected}
      data-row={row.key}
      onClick={row.onSelect}
    >
      <Circle view={row.circle} />
      <span className="sched-row-body">
        <span className="sched-row-text">
          <span className="sched-row-title">{row.title}</span>
          <RowLine repeats={row.repeats} text={row.line} />
        </span>
        {row.circle.tag ? <span className="sched-tag" data-tone={row.circle.tag.tone}>{row.circle.tag.text}</span> : null}
        <span className="sched-row-time">{row.time}</span>
      </span>
    </button>
  );
}

const OPEN_CIRCLE: ScheduleCircleView = { circle: 'open', mark: null, tag: null };

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
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api<WorkspaceRow[]>('/workspaces') });
  // One read draws the whole timeline: the rows, the runs of the shown window and their findings (the list's
  // timeline part). A schedule's detail is read only when it is opened in the inspector.
  const schedules = useMemo(() => list.data?.schedules ?? [], [list.data]);

  const [pending, setPending] = useState<PendingDraft[]>([]);
  const draftCards = useMemo(
    () => (drafts.data?.drafts ?? []).filter((card) =>
      !workspaceFilter || sameResourceId(card.runsIn.workspaceId, workspaceFilter)),
    [drafts.data, workspaceFilter],
  );
  // A sentence's draft row stands until the agent's card for it comes back.
  const pendingRows = pending.filter((p) =>
    !(drafts.data?.drafts ?? []).some((card) => card.askedBySessionId && sameResourceId(card.askedBySessionId, p.sessionId)));

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

  const rowOf = (group: ScheduleTimelineGroup, item: ScheduleTimelineItem): RowView => {
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
        circle: scheduleRunCircle(run, { newFinding: facts.newFinding }),
        title: schedule.title,
        line: underWay
          ? scheduleRowLine(schedule, { agentName: schedule.agentName, runningMinutes: minutes })
          : scheduleRunLine(run, { notified: facts.notified }),
        repeats: underWay && scheduleRuleRepeats(schedule.rule),
        time: scheduleClock(run.plannedAt, timezone),
        cls: underWay ? '' : ' is-past',
        selected: false,
        onSelect,
      };
    }
    const inNeeds = group.key === 'NEEDS_YOU';
    const inPaused = group.key === 'PAUSED';
    const circle = inNeeds || inPaused ? scheduleCircle(schedule) : OPEN_CIRCLE;
    const failing = inNeeds && schedule.state === 'ACTIVE' && schedule.lastRun;
    return {
      key: `${group.key}:${schedule.id}`,
      circle,
      title: schedule.title,
      line: scheduleRowLine(schedule, {
        agentName: schedule.agentName,
        pausedAt: schedule.pausedAt ? new Date(schedule.pausedAt) : null,
        timezone,
      }),
      repeats: scheduleRuleRepeats(schedule.rule),
      time: failing && schedule.lastRun
        ? scheduleWhenText(new Date(schedule.lastRun.plannedAt), now, timezone)
        : item.at && !inNeeds && !inPaused ? scheduleClock(item.at, timezone) : '',
      cls: inPaused ? ' is-paused' : '',
      selected,
      onSelect,
    };
  };

  const workspaceName = (id: string | null) =>
    workspaces.data?.find((w) => sameResourceId(w.id, id ?? ''))?.name ?? null;
  const filterLabel = workspaceFilter ? (workspaceName(workspaceFilter) ?? C.page.allWorkspaces) : C.page.allWorkspaces;
  const empty = list.isSuccess && schedules.length === 0 && draftCards.length === 0 && pendingRows.length === 0;

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

  const [quickText, setQuickText] = useState('');
  const quickAdd = (
    <QuickAdd
      text={quickText}
      onText={setQuickText}
      workspaces={workspaces.data ?? []}
      initialWorkspaceId={workspaceFilter}
      onSent={(draft) => {
        setPending((rows) => [...rows, draft]);
        void qc.invalidateQueries({ queryKey: ['schedules', 'drafts'] });
        select({ kind: 'pending', sessionId: draft.sessionId });
      }}
    />
  );

  return (
    <div className="sched-page">
      <div className="sched-list">
        <header className="sched-head">
          <h1>{C.page.title}</h1>
          <span className="sched-total" data-schedule-total="">{schedules.length}</span>
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
            {groups.map((group) => (
              <section key={`${group.key}:${group.title}`} className="sched-group" data-group={group.key}>
                <h2>{group.title}{group.subtitle ? <small>{group.subtitle}</small> : null}</h2>
                {group.items.map((item) => {
                  const row = rowOf(group, item);
                  return <Row key={row.key} row={row} />;
                })}
              </section>
            ))}
            {pendingRows.map((p) => (
              <Row
                key={`pending:${p.sessionId}`}
                row={{
                  key: `pending:${p.sessionId}`,
                  circle: scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 0 }, { draft: true }),
                  title: p.text,
                  line: [workspaceName(p.workspaceId), C.row.draft].filter(Boolean).join(C.separator),
                  repeats: false,
                  time: '',
                  cls: ' is-draft',
                  selected: selection?.kind === 'pending' && selection.sessionId === p.sessionId,
                  onSelect: () => select({ kind: 'pending', sessionId: p.sessionId }),
                }}
              />
            ))}
            {quickAdd}
          </>
        )}
      </div>
      {selectedSchedule ? (
        <ScheduleInspector key={selectedSchedule.id} schedule={selectedSchedule} />
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
    </div>
  );
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
  | { kind: 'record'; at: string; record: ScheduleChangeRecord };

const LATE_MS = 15 * 60_000;

/** A schedule's inspector (board 1/2 ②): read-back, next and last run, its doors, and what it has done. */
function ScheduleInspector({ schedule }: { schedule: ScheduleListRow }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const timezone = viewerTimezone();
  const now = new Date();
  const detailQ = useQuery(scheduleDetailQuery(schedule.id));
  const detail = detailQ.data;
  const s = detail?.schedule ?? schedule;
  const lastRun = detail?.lastRun ?? schedule.lastRun;
  // The conversation the words were said in, by its title. Its own key: the session detail's read goes through the
  // same door, but this needs the title alone.
  const asked = useQuery({
    queryKey: ['schedules', 'asked-in', s.createdFromSessionId] as const,
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
  const error = scheduleErrorText(control.error) ?? scheduleErrorText(undo.error);

  const lastFacts = lastRun ? runFindingFacts(detail, lastRun) : { newFinding: false, notified: false };
  const meta = [
    scheduleRuleText(s.rule, 'long'),
    s.timezone,
    s.workspaceName,
    C.access[s.accessLevel].label,
  ].filter(Boolean).join(C.separator);

  const history: HistoryEntry[] = [
    ...(detail?.recentRuns ?? []).map((run) => ({ kind: 'run' as const, at: run.startedAt ?? run.plannedAt, run })),
    ...(detail?.history ?? []).map((record) => ({ kind: 'record' as const, at: record.createdAt, record })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const change = () => navigate(`/workspaces/${encodeURIComponent(s.workspaceId)}/new`, {
    state: { composerText: `${s.title}: ` },
  });

  return (
    <aside className="sched-inspector" data-schedule-inspector="schedule">
      <h2 className="sched-inspector-title">{s.title}</h2>
      <div className="sched-inspector-meta">
        {scheduleRuleRepeats(s.rule) ? <span className="sched-repeat" aria-hidden="true">{REPEAT}</span> : null}
        {meta}
      </div>
      <div className="sched-block" data-inspector-block="next">
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
          trigger={<Button size="small" className="sched-more" aria-label={C.actions.delete}>{'⋯'}</Button>}
          items={[{ key: 'delete', label: C.actions.delete, danger: true, onSelect: askDelete }]}
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
              <span className="sched-history-what">{scheduleRecordText(record)}</span>
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
