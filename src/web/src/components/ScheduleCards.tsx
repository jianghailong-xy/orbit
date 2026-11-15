import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  SCHEDULE_COPY,
  scheduleChangeLineText,
  scheduleCostsParts,
  scheduleCreateWhen,
  scheduleEnvelopeNote,
  scheduleEnvelopeSides,
  scheduleEnvelopeTitle,
  scheduleKeepLabel,
  scheduleReportedText,
  scheduleRunLine,
  scheduleRunOfText,
  scheduleRunStripText,
  scheduleRunsInText,
  type ScheduleCard,
  type ScheduleChangeRecord,
  type ScheduleCreateCard,
  type ScheduleDecisionAnswer,
  type ScheduleDetailResponse,
  type ScheduleEnvelope,
  type ScheduleEnvelopeCard,
  type ScheduleEnvelopeLines,
  type ScheduleRule,
  type ScheduleRunView,
  type ScheduleView,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import {
  scheduleDetailQuery,
  scheduleRecordUndoable,
  schedulePath,
  sessionScheduleCardsQuery,
  undoScheduleRecord,
  viewerTimezone,
} from '../lib/schedules';
import { sameResourceId } from '../lib/watches';
import { Button } from './ui/Button';
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
  return (
    <section className="sched-card" data-schedule-card="create" data-state={card.state}>
      <div className="sched-card-head"><CalendarIcon />{C.createCard.title}</div>
      {layout === 'chat' ? <div className="sched-card-title">{card.title}</div> : null}
      <div className="sched-card-readback">{card.readBack}</div>
      <dl className="sched-card-facts">
        <dt>{C.createCard.when}</dt>
        <dd>
          {layout === 'panel' ? (
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
      <div className="sched-card-note">{C.createCard.notice}</div>
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
  return (
    <section className="sched-card is-widen" data-schedule-card="envelope" data-state={card.state}>
      <div className="sched-card-head"><WarnIcon />{scheduleEnvelopeTitle(title, widens, askedName)}</div>
      <dl className="sched-card-facts">
        {sides.now ? (
          <>
            <dt>{C.envelopeCard.now}</dt>
            <dd data-fact="now"><SideText {...sides.now} bold={false} /></dd>
          </>
        ) : null}
        <dt>{C.envelopeCard.asked}</dt>
        <dd data-fact="asked"><SideText {...sides.asked} bold /></dd>
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
function withTitleBold(text: string, title: string): ReactNode {
  const at = title ? text.indexOf(title) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<b>{title}</b>{text.slice(at + title.length)}</>;
}

/**
 * A change's record where the session made it (board 2/2 ② ③ ⑤): what changed, with Undo and Open. Undo goes through
 * the door the record names; one already undone keeps its line without the door.
 */
export function ScheduleRecordLine({ record }: { record: ScheduleChangeRecord }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
      <span>{withTitleBold(scheduleChangeLineText(record), record.title)}</span>
      <span className="sched-record-doors">
        {record.undo ? (
          <button type="button" className="sched-link" disabled={!undoable || undo.isPending} onClick={() => undo.mutate()}>
            {C.actions.undo}
          </button>
        ) : null}
        <button type="button" className="sched-link" onClick={() => navigate(schedulePath(record.scheduleId))}>
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
}

/**
 * The schedule and run a run's session belongs to, read from the session alone: its schedule-cards answer names the
 * run it serves however old (`run`), and the run names its schedule. Nothing else is searched.
 */
export function useScheduleRunOfSession(sessionId: string | null | undefined): ScheduleRunOfSession | null {
  const cards = useQuery({ ...sessionScheduleCardsQuery(sessionId ?? ''), enabled: Boolean(sessionId) });
  const run = sessionId ? cards.data?.run ?? null : null;
  const detail = useQuery({ ...scheduleDetailQuery(run?.scheduleId ?? ''), enabled: Boolean(run) });
  if (!run || !detail.data) return null;
  return { schedule: detail.data.schedule, run, detail: detail.data };
}

/** Scheduled › Codex stable check › run of Nov 13 (board 2/2 ⑤ ⑥). */
export function ScheduleRunCrumb({ of }: { of: ScheduleRunOfSession }): JSX.Element {
  return (
    <div className="sched-crumb" data-schedule-crumb="">
      <Link to="/scheduled">{C.runSession.crumb}</Link>
      {' › '}
      <Link to={schedulePath(of.schedule.id)}>{of.schedule.title}</Link>
      {' › '}
      {scheduleRunOfText(of.run, viewerTimezone())}
    </div>
  );
}

/** The strip at the top of a run's session. */
export function ScheduleRunStrip({ of }: { of: ScheduleRunOfSession }): JSX.Element {
  return (
    <div className="sched-strip" data-schedule-strip="">
      <CalendarIcon />
      <span>{scheduleRunStripText(of.run, of.schedule.accessLevel, viewerTimezone())}</span>
    </div>
  );
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
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  run: ScheduleRunOfSession | null,
): TranscriptInsert[] {
  const cards = useQuery({ ...sessionScheduleCardsQuery(sessionId ?? ''), enabled: Boolean(sessionId) });
  return useMemo(() => {
    if (!sessionId) return [];
    const inserts: TranscriptInsert[] = [];
    // A run's strip leads, and its report comes before the change lines after the same event (board 2/2 ⑤).
    if (run) {
      inserts.push({ anchor: 'head', moment: '', key: 'schedule-run-strip', element: <ScheduleRunStrip of={run} /> });
      const last = events.reduce<number | null>((max, e) => (max === null || e.seq > max ? e.seq : max), null);
      const at = run.run.endedAt ? decisionReceiptAnchor(events, run.run.endedAt) : null;
      const anchor = at === null || at === 'head' ? last : at;
      if (anchor !== null && ENDED_STATES.includes(run.run.state)) {
        inserts.push({ anchor, moment: run.run.endedAt ?? '', key: `schedule-run-report:${run.run.id}`, element: <ScheduleRunReport of={run} /> });
      }
    }
    // Cards and change lines in the order they happened, so two after the same event read as they were made.
    const said = [
      ...(cards.data?.cards ?? []).map((card) => ({
        at: card.createdAt, key: `schedule-card:${card.id}`, element: <ScheduleCardView card={card} />,
      })),
      ...(cards.data?.records ?? []).map((record) => ({
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
  }, [sessionId, events, cards.data, run]);
}
