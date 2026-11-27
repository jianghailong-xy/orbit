import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  SCHEDULE_COPY,
  SCHEDULE_RUN_STATUS_COPY,
  scheduleChangeLineText,
  scheduleChangeOpeningRows,
  scheduleCostsParts,
  scheduleCreateNotice,
  scheduleCreateWhen,
  scheduleDurationText,
  scheduleFill,
  scheduleEnvelopeNote,
  scheduleEnvelopeSides,
  scheduleEnvelopeTitle,
  scheduleKeepLabel,
  scheduleReportedText,
  scheduleRunLine,
  scheduleDidntRunText,
  scheduleQueuedFullText,
  scheduleRunNotStartedStripText,
  scheduleRunStatusKind,
  scheduleRunStripText,
  scheduleRunsInText,
  scheduleStartedOnText,
  type ScheduleCard,
  type ScheduleChangeOpening,
  type ScheduleChangeRecord,
  type ScheduleCreateCard,
  type ScheduleDecisionAnswer,
  type ScheduleDetailResponse,
  type ScheduleEnvelope,
  type ScheduleEnvelopeCard,
  type ScheduleEnvelopeLines,
  type ScheduleRule,
  type ScheduleRunSessionStatus,
  type ScheduleRunStatusKind,
  type ScheduleRunView,
  type SessionScheduleCardsResponse,
  type ScheduleView,
  type ScheduleWhenLines,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { CONDITION_COPY, conditionQuery, firingOfRun, readingText } from '../lib/conditions';
import { capacityHeldRunText, capacityHeldTag, capacityHeldWaited } from '../lib/queuedCapacity';
import {
  scheduleClock,
  scheduleDetailQuery,
  scheduleRecordUndoable,
  schedulePath,
  scheduleRunSessionPath,
  sessionScheduleCardsQuery,
  undoScheduleRecord,
  viewerTimezone,
} from '../lib/schedules';
import { sameResourceId } from '../lib/watches';
import { Button } from './ui/Button';
import { useScheduleChatHost } from '../lib/scheduleChatHost';
import type { TranscriptInsert } from './Transcript';
import './Scheduled.css';

const C = SCHEDULE_COPY;

/** The calendar of the boards' cards and lines. */
export function CalendarIcon(): JSX.Element {
  return (
    <svg className="sched-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.5h12M5.5 1.6v2.6M10.5 1.6v2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The gauge a condition's row, card and line carry in place of the circle or the calendar (condition-triggers ④). */
export function GaugeIcon(): JSX.Element {
  return (
    <svg className="sched-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.2 11.6a6 6 0 1 1 11.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 10.2 10.9 6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="10.4" r="1.2" fill="currentColor" />
    </svg>
  );
}

function WarnIcon(): JSX.Element {
  return (
    <svg className="sched-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.2v3.6M8 11.6v.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg className="sched-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m5.2 8.2 2 2 3.8-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A refusal's words: the server's own message for a card it withdrew (409 SCHEDULE_REQUEST_STALE), else the error's. */
export function scheduleErrorText(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    const message = error.body?.message;
    return typeof message === 'string' && message ? message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether Allow withdrew the card instead of applying it: shown, never retried. */
function isStale(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'SCHEDULE_REQUEST_STALE';
}

/** Allow (Create) or decline (Not now, Keep …) a card through the schedule-request doors. */
function useCardDecision(card: ScheduleCard) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: 'allow' | 'decline') => {
      const needsZone = decision === 'allow' && card.kind === 'CREATE' && !card.when.timezone;
      return api<ScheduleDecisionAnswer>(`/schedule-requests/${encodeURIComponent(card.id)}/${decision}`, {
        method: 'POST',
        body: needsZone ? { timezone: viewerTimezone() } : {},
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
    },
  });
}

/** "Check only · reads and reports, edits nothing", the label in bold. */
function MayText({ level }: { level: ScheduleCreateCard['may']['accessLevel'] }): JSX.Element {
  const access = C.access[level];
  return <><b>{access.label}</b>{C.separator}{access.detail}</>;
}

/**
 * A WHEN rule's When lines (condition-triggers ③): the condition with its hold, the condition itself in bold; the
 * re-arm and how it is checked; the repeat and the keeps-awake line when there are; then the command verbatim.
 */
function WhenConditionText({ lines, condition }: { lines: ScheduleWhenLines; condition: string }): JSX.Element {
  const bold = lines.text.startsWith(condition) ? condition : lines.text;
  return (
    <>
      <b>{bold}</b>{lines.text.slice(bold.length)}
      <div className="sched-card-sub" data-when-detail="">{lines.detail}</div>
      {lines.repeat ? <div className="sched-card-sub" data-when-repeat="">{lines.repeat}</div> : null}
      {lines.awake ? <div className="sched-card-sub" data-when-awake="">{lines.awake}</div> : null}
      <code className="sched-command" data-when-command="">{lines.command}</code>
    </>
  );
}

/** "Up to 7 runs a week, 30 min each", the runs in bold. */
function CostsText({ runsPerWeek, runLimitMinutes }: { runsPerWeek: number; runLimitMinutes: number }): JSX.Element {
  const parts = scheduleCostsParts(runsPerWeek, runLimitMinutes);
  return <>{parts.before}<b>{parts.emphasis}</b>{parts.after}</>;
}

/**
 * The create card (board 2/2 ①, and the draft's inspector in 1/2 ④): the read-back, When, Runs in, May, Costs and
 * Today, then Not now and Create. `layout: 'panel'` puts the first run under the rule, as the inspector does.
 */
export function ScheduleCreateCardView({ card, layout = 'chat', onOpenConversation }: {
  card: ScheduleCreateCard;
  layout?: 'chat' | 'panel';
  onOpenConversation?: () => void;
}): JSX.Element {
  const decide = useCardDecision(card);
  const now = new Date();
  const when = scheduleCreateWhen(card, now, viewerTimezone());
  const pending = card.state === 'PENDING' && !decide.isSuccess;
  const error = scheduleErrorText(decide.error);
  const condition = card.when.rule.kind === 'WHEN' && card.when.condition
    ? { lines: card.when.condition, text: card.when.rule.condition.text }
    : null;
  return (
    <section className="sched-card" data-schedule-card="create" data-state={card.state}>
      <div className="sched-card-head">{condition ? <GaugeIcon /> : <CalendarIcon />}{C.createCard.title}</div>
      {layout === 'chat' ? <div className="sched-card-title">{card.title}</div> : null}
      <div className="sched-card-readback">{card.readBack}</div>
      <dl className="sched-card-facts">
        <dt>{C.createCard.when}</dt>
        <dd data-fact="when">
          {condition ? <WhenConditionText lines={condition.lines} condition={condition.text} /> : layout === 'panel' ? (
            <>
              {[when.rule, when.zone].join(C.separator)}
              {when.firstRun ? <><br /><span className="sched-card-sub">{when.firstRun}</span></> : null}
            </>
          ) : when.text}
        </dd>
        <dt>{C.createCard.runsIn}</dt>
        <dd>{scheduleRunsInText(card.runsIn.workspaceName ?? card.runsIn.text, card.runsIn.engine)}</dd>
        <dt>{C.createCard.may}</dt>
        <dd data-fact="may"><MayText level={card.may.accessLevel} /></dd>
        <dt>{C.createCard.costs}</dt>
        <dd data-fact="costs"><CostsText runsPerWeek={card.costs.runsPerWeek} runLimitMinutes={card.costs.runLimitMinutes} /></dd>
        {card.today ? (
          <>
            <dt>{C.createCard.today}</dt>
            <dd data-fact="today">{card.today.text}</dd>
          </>
        ) : null}
      </dl>
      <div className="sched-card-note">{card.notice || scheduleCreateNotice(null)}</div>
      {error ? <div className="sched-card-error" role="alert">{error}</div> : null}
      {pending || onOpenConversation ? (
        <div className="sched-card-foot">
          {onOpenConversation ? (
            <button type="button" className="sched-link" onClick={onOpenConversation}>{C.actions.openConversation}</button>
          ) : null}
          {pending && !isStale(decide.error) ? (
            <>
              <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate('decline')}>{C.actions.notNow}</Button>
              <Button size="small" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate('allow')}>
                {C.actions.create}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function envelopeOf(lines: ScheduleEnvelopeLines): ScheduleEnvelope {
  return {
    workspaceId: lines.runsIn.workspaceId,
    accessLevel: lines.may.accessLevel,
    runsPerWeek: lines.costs.runsPerWeek,
    runLimitMinutes: lines.costs.runLimitMinutes,
  };
}

/** Now / Asked, the asked lead in bold: "Daily 10:00 · up to 7 runs a week, 30 min each". */
function SideText({ lead, detail, text, bold }: { lead: string; detail: string; text: string; bold: boolean }): JSX.Element {
  if (!bold || !lead || !text.startsWith(lead)) return <>{text}</>;
  return <><b>{lead}</b>{text.slice(lead.length, text.length - detail.length)}{detail}</>;
}

/**
 * The envelope card (board 2/2 ② ③): a change that grows what the schedule may do waits on it. Allow applies it;
 * Keep … declines.
 */
export function ScheduleEnvelopeCardView({ card }: { card: ScheduleEnvelopeCard }): JSX.Element {
  const decide = useCardDecision(card);
  const detail = useQuery({ ...scheduleDetailQuery(card.scheduleId ?? ''), enabled: Boolean(card.scheduleId) });
  const schedule = detail.data?.schedule;
  const widens = card.envelope.widens;
  const now = card.envelope.now ? envelopeOf(card.envelope.now) : null;
  const asked = envelopeOf(card.envelope.asked);
  const names: Record<string, string> = {};
  for (const lines of [card.envelope.now, card.envelope.asked]) {
    if (lines?.runsIn.workspaceName) names[lines.runsIn.workspaceId] = lines.runsIn.workspaceName;
  }
  const proposedRule = (card.proposed?.rule as ScheduleRule | undefined) ?? null;
  const sides = scheduleEnvelopeSides({
    widens,
    now,
    asked,
    ruleNow: schedule?.rule ?? null,
    ruleAsked: proposedRule,
    workspaceNames: names,
  });
  const title = card.title ?? schedule?.title ?? '';
  const askedName = names[asked.workspaceId];
  const nowName = now ? names[now.workspaceId] : undefined;
  const pending = card.state === 'PENDING' && !decide.isSuccess;
  const error = scheduleErrorText(decide.error);
  // A new probe command: both sides are the command verbatim, what was approved and what Allow would approve.
  const command = widens.includes('PROBE_COMMAND') && !widens.includes('ACCESS_LEVEL') && !widens.includes('WORKSPACE');
  const side = (s: typeof sides.asked, bold: boolean) => (command
    ? <code className="sched-command">{s.text}</code>
    : <SideText {...s} bold={bold} />);
  return (
    <section className="sched-card is-widen" data-schedule-card="envelope" data-state={card.state}>
      <div className="sched-card-head"><WarnIcon />{scheduleEnvelopeTitle(title, widens, askedName, asked.accessLevel)}</div>
      <dl className="sched-card-facts">
        {sides.now ? (
          <>
            <dt>{C.envelopeCard.now}</dt>
            <dd data-fact="now">{side(sides.now, false)}</dd>
          </>
        ) : null}
        <dt>{C.envelopeCard.asked}</dt>
        <dd data-fact="asked">{side(sides.asked, true)}</dd>
      </dl>
      <div className="sched-card-note">{scheduleEnvelopeNote(widens)}</div>
      {error ? <div className="sched-card-error" role="alert">{error}</div> : null}
      {pending && !isStale(decide.error) ? (
        <div className="sched-card-foot">
          <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate('decline')}>
            {scheduleKeepLabel(widens, now, nowName)}
          </Button>
          <Button size="small" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate('allow')}>
            {C.actions.allow}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function ScheduleCardView({ card, layout, onOpenConversation }: {
  card: ScheduleCard;
  layout?: 'chat' | 'panel';
  onOpenConversation?: () => void;
}): JSX.Element {
  return card.kind === 'CREATE'
    ? <ScheduleCreateCardView card={card} layout={layout} onOpenConversation={onOpenConversation} />
    : <ScheduleEnvelopeCardView card={card} />;
}

/** "Changed <b>Codex stable check</b>: time 10:00 → 09:00", the title in bold. */
function withTitleBold(text: string, title: string, onOpen?: () => void): ReactNode {
  const at = title ? text.indexOf(title) : -1;
  if (at < 0) return text;
  // In the Scheduled page's chat the name is the way to its row (board scheduled-chat 01 ①).
  const name = onOpen
    ? <button type="button" className="sched-link sched-record-name" data-schedule-name="" onClick={onOpen}><b>{title}</b></button>
    : <b>{title}</b>;
  return <>{text.slice(0, at)}{name}{text.slice(at + title.length)}</>;
}

/**
 * A change's record where the session made it (board 2/2 ② ③ ⑤): what changed, with Undo and Open. Undo goes through
 * the door the record names; one already undone keeps its line without the door.
 */
export function ScheduleRecordLine({ record }: { record: ScheduleChangeRecord }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const host = useScheduleChatHost();
  // In the Scheduled page's chat the schedule opens in the page's inspector; elsewhere it is the page's address.
  const open = () => (host ? host.openSchedule(record.scheduleId) : navigate(schedulePath(record.scheduleId)));
  const undo = useMutation({
    mutationFn: () => undoScheduleRecord(record),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
  const undoable = scheduleRecordUndoable(record) && !undo.isSuccess;
  const error = scheduleErrorText(undo.error);
  return (
    <div className={`sched-record${undoable ? '' : ' is-undone'}`} data-schedule-record={record.revision}>
      <CalendarIcon />
      <span>{withTitleBold(scheduleChangeLineText(record), record.title, host ? open : undefined)}</span>
      <span className="sched-record-doors">
        {record.undo ? (
          <button type="button" className="sched-link" disabled={!undoable || undo.isPending} onClick={() => undo.mutate()}>
            {C.actions.undo}
          </button>
        ) : null}
        <button type="button" className="sched-link" onClick={open}>
          {C.actions.open}
        </button>
      </span>
      {error ? <span className="sched-error" role="alert">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A run's session
// ---------------------------------------------------------------------------------------------------------------

export interface ScheduleRunOfSession {
  schedule: ScheduleView;
  run: ScheduleRunView;
  detail: ScheduleDetailResponse | undefined;
  /** Where the run stands for this session (its tries, its queue); null from a server before it. */
  status?: ScheduleRunSessionStatus | null;
  /** The card this session shows in place of the run's report and the composer, if any (board scheduled-run-not-started). */
  card?: ScheduleRunStatusKind | null;
}

/**
 * A conversation's schedule cards (`GET /sessions/:id/schedule-cards`), read once for the page: the session page reads
 * them here and hands the answer to the hooks below, so one observer reads them however many things they draw.
 */
export function useSessionScheduleCards(sessionId: string | null | undefined): SessionScheduleCardsResponse | undefined {
  const cards = useQuery({ ...sessionScheduleCardsQuery(sessionId ?? ''), enabled: Boolean(sessionId) });
  return sessionId ? cards.data : undefined;
}

/**
 * The schedule and run a run's session belongs to, read from the session alone: its schedule-cards answer
 * (`useSessionScheduleCards`) names the run it serves however old (`run`), and the run names its schedule. Nothing else
 * is searched.
 */
export function useScheduleRunOfSession(
  sessionId: string | null | undefined,
  cards: SessionScheduleCardsResponse | undefined,
): ScheduleRunOfSession | null {
  const run = sessionId ? cards?.run ?? null : null;
  const detail = useQuery({ ...scheduleDetailQuery(run?.scheduleId ?? ''), enabled: Boolean(run) });
  if (!run || !detail.data) return null;
  const status = cards?.runStatus ?? null;
  return { schedule: detail.data.schedule, run, detail: detail.data, status, card: scheduleRunStatusKind(run, status) };
}

/**
 * A run its condition started names the firing instead of a planned time (condition-triggers ⑤):
 * "Fired 03:12 · 90.4% for 10 min · Check only".
 */
export function scheduleRunFiringText(input: {
  run: Pick<ScheduleRunView, 'plannedAt'>;
  value: number | null;
  repeat: boolean;
  unit: string | null;
  holdSeconds: number;
  accessLevel: ScheduleView['accessLevel'];
  timezone: string;
}): string {
  const time = scheduleClock(input.run.plannedAt, input.timezone);
  const parts = [scheduleFill(input.repeat ? CONDITION_COPY.firedAgainAt : CONDITION_COPY.firedAt, { time })];
  if (input.value !== null) {
    parts.push(readingText(input.value, input.unit)
      + (input.holdSeconds > 0 ? scheduleFill(CONDITION_COPY.held, { duration: scheduleDurationText(input.holdSeconds) }) : ''));
  }
  parts.push(C.access[input.accessLevel].label);
  return parts.join(C.separator);
}

function ScheduleRunFiringStrip({ of }: { of: ScheduleRunOfSession }): JSX.Element {
  const rule = of.schedule.rule.kind === 'WHEN' ? of.schedule.rule : null;
  const id = rule?.conditionId ?? of.schedule.condition?.id ?? '';
  const condition = useQuery({ ...conditionQuery(id), enabled: Boolean(id) }).data;
  const firing = firingOfRun(condition, of.run.id);
  return (
    <div className="sched-strip is-condition" data-schedule-strip="condition">
      <GaugeIcon />
      <span>
        {scheduleRunFiringText({
          run: of.run,
          value: firing?.value ?? null,
          repeat: firing?.repeat ?? false,
          unit: condition?.unit ?? rule?.condition.unit ?? null,
          holdSeconds: condition?.holdSeconds ?? rule?.condition.holdSeconds ?? 0,
          accessLevel: of.schedule.accessLevel,
          timezone: viewerTimezone(),
        })}
      </span>
    </div>
  );
}

/** The strip at the top of a run's session. */
/**
 * A change conversation's head (§8.2, board 03-change ③): the strip naming the schedule, which opens it, and Orbit's
 * opening — the schedule as it was when the conversation was opened, and what can change at once or needs Allow.
 */
export function ScheduleChangeOpeningView({ opening }: { opening: ScheduleChangeOpening }): JSX.Element {
  const navigate = useNavigate();
  const T = C.changeConversation;
  return (
    <div className="sched-change-opening" data-schedule-change-opening="">
      <div className="sched-strip">
        <CalendarIcon />
        <span><b>{opening.title}</b>{C.separator}{opening.runsIn}</span>
        <button type="button" className="sched-link sched-strip-door" onClick={() => navigate(schedulePath(opening.scheduleId))}>
          {T.openInScheduled}
        </button>
      </div>
      <p>{withTitleBold(scheduleFill(T.lead, { title: opening.title }), opening.title)}</p>
      <dl className="sched-change-rows">
        {scheduleChangeOpeningRows(opening).map((row) => (
          <div key={row.label}><dt>{row.label}</dt><dd>{row.text}</dd></div>
        ))}
      </dl>
      <p>{T.tail}</p>
    </div>
  );
}

export function ScheduleRunStrip({ of }: { of: ScheduleRunOfSession }): JSX.Element {
  if (of.run.trigger === 'CONDITION') return <ScheduleRunFiringStrip of={of} />;
  return (
    <div className="sched-strip" data-schedule-strip="">
      <CalendarIcon />
      <span>
        {of.card
          ? scheduleRunNotStartedStripText(of.run, of.schedule.accessLevel, viewerTimezone())
          : scheduleRunStripText(of.run, of.schedule.accessLevel, viewerTimezone())}
      </span>
    </div>
  );
}

const RS = SCHEDULE_RUN_STATUS_COPY;

/** A clock that moves twice a minute, for the run card's waits counted in minutes. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** What the run card names that the run does not: the machine and the engine of this session. */
export interface ScheduleRunStatusNames {
  runner: string;
  engine: string;
}

/**
 * A run's session where the run did not get under way (board docs/mocks/scheduled-run-not-started ②③④, owner's B1):
 * in place of the run's report and the composer, what happened to the run and the doors that act on it.
 *
 *   * ② Didn't run: why, each try's time, when it gave up and the next run; Run now and Open schedule.
 *   * ③ Queued · runner full: the queue's own sentence, how long it has waited and when it gives up; Cancel run and
 *     Open schedule.
 *   * ④ Started on try N: why this try stopped; Open the run, to the session the run went on in.
 */
export function ScheduleRunStatusCard({ of, names }: { of: ScheduleRunOfSession; names: ScheduleRunStatusNames }): JSX.Element | null {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useMinuteNow();
  const { run, status, card } = of;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const runNow = useMutation({
    mutationFn: () => api<{ run: ScheduleRunView }>(`/schedules/${encodeURIComponent(run.scheduleId)}/run`, { method: 'POST' }),
    onSuccess: (answer) => {
      const path = scheduleRunSessionPath(answer.run);
      if (path) navigate(path);
    },
    onSettled: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api(`/schedule-runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST' }),
    onSettled: invalidate,
  });
  if (!status || !card) return null;
  const timezone = viewerTimezone();
  const openSchedule = (
    <Button className="sched-run-door" onClick={() => navigate(schedulePath(run.scheduleId))}>{RS.actions.openSchedule}</Button>
  );
  const error = scheduleErrorText(runNow.error) ?? scheduleErrorText(cancel.error);
  const errorLine = error ? <div className="sched-run-error" role="alert">{error}</div> : null;

  if (card === 'DIDNT_RUN') {
    const text = scheduleDidntRunText({ run, status, runner: names.runner, now: new Date(now), timezone });
    return (
      <div className="sched-run-card" data-schedule-run-card="DIDNT_RUN">
        <div className="sched-run-title"><span className="sched-run-dot" data-tone="muted" />{text.title}</div>
        <p className="sched-run-body">{text.reason}</p>
        <div className="sched-run-chips">
          {text.tries.map((time, i) => <span key={`${i}:${time}`} className="sched-run-chip">{time}</span>)}
        </div>
        {text.gaveUp ? <div className="sched-run-meta is-gave-up">{text.gaveUp}</div> : null}
        {text.next ? <div className="sched-run-meta">{text.next}</div> : null}
        <div className="sched-run-doors">
          <Button className="sched-run-door" variant="primary" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
            {RS.actions.runNow}
          </Button>
          {openSchedule}
        </div>
        {errorLine}
      </div>
    );
  }

  if (card === 'QUEUED_FULL' && status.queue) {
    const gate = { ...status.queue, lastTurnAt: status.queue.since };
    const text = scheduleQueuedFullText({
      tag: capacityHeldTag(gate),
      waited: capacityHeldWaited(gate, now),
      deadline: status.queue.deadline,
      now: new Date(now),
      timezone,
    });
    return (
      <div className="sched-run-card" data-schedule-run-card="QUEUED_FULL">
        <div className="sched-run-title"><span className="sched-run-dot" data-tone="waiting" />{text.title}</div>
        <p className="sched-run-body">{capacityHeldRunText(gate, names.runner)}</p>
        <div className="sched-run-meta">{text.waited}</div>
        <div className="sched-run-doors">
          <Button className="sched-run-door" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {RS.actions.cancelRun}
          </Button>
          {openSchedule}
        </div>
        {errorLine}
      </div>
    );
  }

  if (card === 'STARTED_ON') {
    const text = scheduleStartedOnText({ run, status, engine: names.engine, runner: names.runner, timezone });
    const path = scheduleRunSessionPath(run);
    if (!text || !path) return null;
    return (
      <div className="sched-run-card" data-schedule-run-card="STARTED_ON">
        <div className="sched-run-title"><span className="sched-run-dot" data-tone="started" />{text.title}</div>
        <p className="sched-run-body">{text.body}</p>
        <div className="sched-run-doors">
          <Button className="sched-run-door is-wide" variant="primary" onClick={() => navigate(path)}>
            {RS.actions.openRun}
          </Button>
        </div>
      </div>
    );
  }
  return null;
}

interface RunLink {
  url: string;
  title?: string | null;
}

function runLinks(links: unknown): RunLink[] {
  if (!Array.isArray(links)) return [];
  return links.filter((l): l is RunLink => Boolean(l) && typeof (l as RunLink).url === 'string'
    && /^https?:/i.test((l as RunLink).url));
}

/** Whether this run's finding was new, and whether the owner was told. */
export function runFindingFacts(detail: ScheduleDetailResponse | undefined, run: ScheduleRunView): { newFinding: boolean; notified: boolean } {
  const finding = run.key ? detail?.findings.find((f) => f.key === run.key) : undefined;
  const newFinding = Boolean(finding && finding.firstRunId && sameResourceId(finding.firstRunId, run.id));
  return { newFinding, notified: newFinding && Boolean(finding?.notifiedAt) };
}

const ENDED_STATES: readonly string[] = ['NO_CHANGE', 'CHANGED', 'FAILED', 'MISSED', 'SKIPPED', 'HELD', 'CANCELLED'];

/** What the run reported (board 2/2 ⑤ ⑥): its state, key and whether you were told, then its summary and links. */
export function ScheduleRunReport({ of }: { of: ScheduleRunOfSession }): JSX.Element | null {
  const { run } = of;
  if (!ENDED_STATES.includes(run.state)) return null;
  const failed = run.state !== 'NO_CHANGE' && run.state !== 'CHANGED';
  const facts = runFindingFacts(of.detail, run);
  const head = failed ? scheduleRunLine(run) : scheduleReportedText(run, { notified: facts.notified });
  const links = runLinks(run.links);
  return (
    <div className={`sched-report${failed ? ' is-failed' : ''}`} data-schedule-report="">
      <div className="sched-report-head">{failed ? <WarnIcon /> : <CheckIcon />}{head}</div>
      {!failed && run.summary ? <span>{run.summary}</span> : null}
      {links.map((link) => (
        <span key={link.url}>
          {' '}
          <a className="sched-link" href={link.url} target="_blank" rel="noreferrer">{link.title || link.url}</a>
        </span>
      ))}
    </div>
  );
}

/**
 * What a conversation draws of its scheduled tasks, where each happened: the cards it put up and the records of the
 * changes it made; and in a run's session, the strip at the head and the report after the last event.
 */
export function useSessionScheduleInserts(
  sessionId: string | null | undefined,
  cards: SessionScheduleCardsResponse | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  run: ScheduleRunOfSession | null,
  names: ScheduleRunStatusNames = { runner: '', engine: '' },
): TranscriptInsert[] {
  const { runner, engine } = names;
  return useMemo(() => {
    if (!sessionId) return [];
    const inserts: TranscriptInsert[] = [];
    // A run's strip leads, and its report comes before the change lines after the same event (board 2/2 ⑤).
    if (run) {
      inserts.push({ anchor: 'head', moment: '', key: 'schedule-run-strip', element: <ScheduleRunStrip of={run} /> });
      // A run that did not get under way here says what happened to it under the strip, and has no report of its own
      // (board scheduled-run-not-started ②③④).
      if (run.card) {
        inserts.push({
          anchor: 'head', moment: '', key: `schedule-run-card:${run.run.id}`,
          element: <ScheduleRunStatusCard of={run} names={{ runner, engine }} />,
        });
      }
      const last = events.reduce<number | null>((max, e) => (max === null || e.seq > max ? e.seq : max), null);
      const at = run.run.endedAt ? decisionReceiptAnchor(events, run.run.endedAt) : null;
      const anchor = at === null || at === 'head' ? last : at;
      if (!run.card && anchor !== null && ENDED_STATES.includes(run.run.state)) {
        inserts.push({ anchor, moment: run.run.endedAt ?? '', key: `schedule-run-report:${run.run.id}`, element: <ScheduleRunReport of={run} /> });
      }
    }
    // A change conversation opens with Orbit's message, before the person's first words (§8.2).
    const opening = cards?.change;
    if (opening) {
      inserts.push({ anchor: 'head', moment: '', key: 'schedule-change-opening', element: <ScheduleChangeOpeningView opening={opening} /> });
    }
    // Cards and change lines in the order they happened, so two after the same event read as they were made.
    const said = [
      ...(cards?.cards ?? []).map((card) => ({
        at: card.createdAt, key: `schedule-card:${card.id}`, element: <ScheduleCardView card={card} />,
      })),
      ...(cards?.records ?? []).map((record) => ({
        at: record.createdAt,
        key: `schedule-record:${record.scheduleId}:${record.revision}`,
        element: <ScheduleRecordLine record={record} />,
      })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const item of said) {
      const anchor = decisionReceiptAnchor(events, item.at);
      if (anchor === null) continue;
      inserts.push({ anchor, moment: item.at, key: item.key, element: item.element });
    }
    return inserts;
  }, [sessionId, events, cards, run, runner, engine]);
}
