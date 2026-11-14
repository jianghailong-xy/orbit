import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  COORDINATOR_HANDOFF_COPY as COPY,
  COORDINATOR_HANDOFF_PROMPT_HEAD,
  COORDINATOR_HANDOFF_SECTIONS,
  type CoordinatorHandoffView,
  type CoordinatorPendingWait,
  type SessionCoordinatorHandoff,
  type SessionCoordinatorHandoffReceived,
} from '@orbit/shared';
import { api } from '../api';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Popover } from './ui/Popover';
import './CoordinatorHandoff.css';

/**
 * Compact and Start a new coordinator in the composer's Context popover (board 01), and what Start
 * a new coordinator does in the conversation (board 02, docs/coordinator-handoff.md).
 */

/** Board 01's copy, verbatim. */
export const CONTEXT_ACTIONS_COPY = {
  compact: 'Compact',
  compactDetail: 'Summarize earlier turns and keep going here.',
  compactWhileRunning: 'Available when this turn ends.',
  startCoordinator: 'Start a new coordinator',
  startCoordinatorDetail: 'This one writes a handoff note, then the project continues in a fresh conversation.',
  startCoordinatorWhileRunning: 'Begins after this turn ends: a handoff note, then a fresh conversation.',
} as const;

/** From this fill on, Compact leads the popover (board 01 ①): the ring turns amber at the same point. */
export const COMPACT_LEAD_PCT = 75;

export type CoordinatorHandoffAction = 'handoff' | 'skip' | 'cancel' | 'retry';

export function coordinatorHandoffRequest(projectId: string, action: CoordinatorHandoffAction): Promise<CoordinatorHandoffView> {
  const base = `/projects/${encodeURIComponent(projectId)}/coordinator/handoff`;
  return api<CoordinatorHandoffView>(action === 'handoff' ? base : `${base}/${action}`, { method: 'POST', body: {} });
}

export function coordinatorPendingWaits(projectId: string): Promise<CoordinatorPendingWait[]> {
  return api<CoordinatorPendingWait[]>(`/projects/${encodeURIComponent(projectId)}/coordinator/pending-waits`);
}

/** The note turn's prompt is the platform's, not a message from the owner: the transcript leaves it out. */
export function isCoordinatorHandoffPrompt(text: string): boolean {
  return text.startsWith(COORDINATOR_HANDOFF_PROMPT_HEAD);
}

/** A wait as the dialog and the moved-waits list name it; a paused one says so. */
export const pendingWaitLabel = (wait: CoordinatorPendingWait): string => (wait.paused ? `${wait.label} (paused)` : wait.label);

// ── icons (board 01/02) ───────────────────────────────────────────────────────────────────────────
const svg = (children: ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? undefined : 'currentColor'}
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const CompactIcon = () => svg(<><path d="M4 9h16M4 15h16" /><path d="M9 4l3 3 3-3M9 20l3-3 3 3" /></>);
const HandoffIcon = () => svg(<><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" /><path d="M3 12h11M10 8l4 4-4 4" /></>);
const NoteIcon = () => svg(<><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></>);
const WaitIcon = () => svg(<><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 1.5M9 2.5h6" /></>);
const ErrorIcon = () => svg(<path d="M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21zm0 5c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1s-1-.4-1-1v-6c0-.6.4-1 1-1zm0 11.2a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />, true);

// ── 01: the popover's action area ─────────────────────────────────────────────────────────────────

export interface ContextActionsProps {
  /** Present where the session's engine advertises `compact`. */
  compact?: { onCompact: () => void };
  /** Present only in a project's current, non-completed coordinator. */
  startCoordinator?: { onStart: () => void };
  /** A turn is running: Compact waits for it, Start a new coordinator runs after it. */
  running: boolean;
  /** The window's fill, for Compact's lead styling. */
  pct: number;
  /** Close the popover once an action is picked. */
  onPicked?: () => void;
}

export function ContextActions({ compact, startCoordinator, running, pct, onPicked }: ContextActionsProps) {
  if (!compact && !startCoordinator) return null;
  const lead = !!compact && !running && pct >= COMPACT_LEAD_PCT;
  return (
    <div className="ctx-acts">
      {compact && (
        <button type="button" className={`ctx-act${lead ? ' lead' : ''}`} disabled={running}
          onClick={() => { onPicked?.(); compact.onCompact(); }}>
          <span className="ctx-act-ic"><CompactIcon /></span>
          <span className="ctx-act-tx">
            <b>{CONTEXT_ACTIONS_COPY.compact}</b>
            <span className={running ? 'why' : undefined}>
              {running ? CONTEXT_ACTIONS_COPY.compactWhileRunning : CONTEXT_ACTIONS_COPY.compactDetail}
            </span>
          </span>
        </button>
      )}
      {startCoordinator && (
        <button type="button" className="ctx-act" onClick={() => { onPicked?.(); startCoordinator.onStart(); }}>
          <span className="ctx-act-ic"><HandoffIcon /></span>
          <span className="ctx-act-tx">
            <b>{CONTEXT_ACTIONS_COPY.startCoordinator}</b>
            <span>{running ? CONTEXT_ACTIONS_COPY.startCoordinatorWhileRunning : CONTEXT_ACTIONS_COPY.startCoordinatorDetail}</span>
          </span>
        </button>
      )}
    </div>
  );
}

// ── 02-1: confirm ─────────────────────────────────────────────────────────────────────────────────

/** The confirm body with the project's title in bold, wherever the sentence puts it. */
function confirmBody(projectTitle: string, running: boolean): ReactNode {
  const mark = '\u0000';
  const [before, after] = (running ? COPY.confirmBodyWhileRunning : COPY.confirmBody)(mark).split(mark);
  return <>{before}<b>{projectTitle}</b>{after}</>;
}

export function CoordinatorHandoffConfirm({
  projectId,
  projectTitle,
  running,
  onClose,
  onHandOver,
}: {
  projectId: string;
  projectTitle: string;
  running: boolean;
  onClose: () => void;
  onHandOver: () => Promise<unknown>;
}) {
  const waitsQ = useQuery({
    queryKey: ['project', projectId, 'coordinator', 'pending-waits'],
    queryFn: () => coordinatorPendingWaits(projectId),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waits = Array.isArray(waitsQ.data) ? waitsQ.data : [];
  const handOver = async () => {
    setBusy(true);
    setError(null);
    try {
      await onHandOver();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      busy={busy}
      closable={!busy}
      width={440}
      className="handoff-confirm"
      title={COPY.confirmTitle}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{COPY.cancel}</Button>
          <Button variant="primary" loading={busy} onClick={() => void handOver()}>{COPY.handOver}</Button>
        </>
      }
    >
      <p className="handoff-confirm-body">{confirmBody(projectTitle, running)}</p>
      <ul className="handoff-facts">
        <li>
          <NoteIcon />
          <span><b>{COPY.noteRowTitle}</b><span className="sub">{COPY.noteRowDetail}</span></span>
        </li>
        {waits.length > 0 && (
          <li>
            <WaitIcon />
            <span>
              <b>{COPY.waitsRowTitle(waits.length)}</b>
              <span className="sub">{waits.map(pendingWaitLabel).join(' · ')}</span>
            </span>
          </li>
        )}
      </ul>
      {error && <div className="orbit-confirm-error" role="alert">{error}</div>}
    </Dialog>
  );
}

// ── 02-2: the outgoing coordinator writing its note ───────────────────────────────────────────────

/** m:ss since `since`, ticking. */
function Clock({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const start = Date.parse(since);
  const secs = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return <span className="handoff-clock">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>;
}

export function CoordinatorHandoffProgress({
  handoff,
  compacting,
  busy,
  onSkip,
  onCancel,
}: {
  handoff: SessionCoordinatorHandoff;
  /** The engine is compacting while it writes: the row says so and the clock keeps running. */
  compacting?: boolean;
  busy?: boolean;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const writing = handoff.state === 'WRITING';
  return (
    <div className="handoff-sys brand" role="status" data-handoff-state={handoff.state}>
      <span className="handoff-spin" aria-hidden="true" />
      <span className="grow">
        {writing ? (
          <>
            {compacting ? COPY.compacting : COPY.writing}
            <Clock since={handoff.startedAt} />
            <span className="row">
              <Button size="small" disabled={busy} onClick={onSkip}>{COPY.skipNote}</Button>
              <Button size="small" disabled={busy} onClick={onCancel}>{COPY.cancelHandover}</Button>
            </span>
          </>
        ) : (
          COPY.handingOver
        )}
      </span>
    </div>
  );
}

// ── 02-5: the note was not written ────────────────────────────────────────────────────────────────

export function CoordinatorHandoffFailure({
  handoff,
  busy,
  onRetry,
  onSkip,
  onKeep,
}: {
  handoff: SessionCoordinatorHandoff;
  busy?: boolean;
  onRetry: () => void;
  onSkip: () => void;
  onKeep: () => void;
}) {
  // The new coordinator could not be opened, and this one is already completed: only the handover
  // without a note can still work.
  const replaceFailed = handoff.failureCode === 'REPLACE_FAILED';
  return (
    <div className="handoff-sys err" role="alert" data-handoff-state="FAILED">
      <ErrorIcon />
      <span className="grow">
        {handoff.failureReason ?? ''}
        <span className="row">
          {!replaceFailed && <Button size="small" disabled={busy} onClick={onRetry}>{COPY.tryAgain}</Button>}
          <Button size="small" disabled={busy} onClick={onSkip}>{COPY.handOverWithoutNote}</Button>
          {!replaceFailed && <Button size="small" disabled={busy} onClick={onKeep}>{COPY.keepThisCoordinator}</Button>}
        </span>
      </span>
    </div>
  );
}

// ── 02-4: the outgoing conversation, handed over ──────────────────────────────────────────────────

export function CoordinatorHandedOverBanner({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className="handoff-ended" role="status">
      <span className="grow">{COPY.handedOver}</span>
      {onOpen && <Button size="small" variant="primary" onClick={onOpen}>{COPY.openIt}</Button>}
    </div>
  );
}

// ── 02-3: the successor's opening ─────────────────────────────────────────────────────────────────

export interface HandoffNoteSection {
  title: string;
  items: string[];
}

const plainLine = (line: string): string => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
const headingOf = (line: string): { title: string; rest: string } | null => {
  const bare = line.replace(/^\s*#+\s*/, '').replace(/\*\*/g, '').trim();
  for (const title of COORDINATOR_HANDOFF_SECTIONS) {
    if (bare.toLowerCase() === title.toLowerCase() || bare.toLowerCase() === `${title.toLowerCase()}:`) return { title, rest: '' };
    if (bare.toLowerCase().startsWith(`${title.toLowerCase()}:`)) return { title, rest: bare.slice(title.length + 1).trim() };
  }
  return null;
};

/** The note's four sections, as the card titles them; null when the note does not use them. */
export function handoffNoteSections(note: string): HandoffNoteSection[] | null {
  const sections: HandoffNoteSection[] = [];
  for (const raw of note.split('\n')) {
    if (!raw.trim()) continue;
    const heading = headingOf(raw);
    if (heading) {
      sections.push({ title: heading.title, items: heading.rest ? [heading.rest] : [] });
      continue;
    }
    const last = sections[sections.length - 1];
    if (!last) return null;
    last.items.push(plainLine(raw));
  }
  return sections.length > 0 ? sections : null;
}

const timeOf = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export function CoordinatorHandoffReceivedCard({
  received,
  onOpenPrevious,
}: {
  received: SessionCoordinatorHandoffReceived;
  onOpenPrevious?: () => void;
}) {
  const sections = received.note ? handoffNoteSections(received.note) : null;
  const when = timeOf(received.handedOverAt);
  const waits = Array.isArray(received.movedWaits) ? received.movedWaits : [];
  return (
    <div className="handoff-received">
      <div className="handoff-card" aria-label={COPY.noteCardTitle}>
        <div className="handoff-card-h">
          <HandoffIcon />
          <span>
            <b>Handoff</b> from{' '}
            <a role="link" tabIndex={0} onClick={onOpenPrevious}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenPrevious?.(); }}>the previous coordinator</a>
            {when && ` · ${when}`}
          </span>
        </div>
        {received.note && (
          <div className="handoff-card-b">
            {sections ? sections.map((s) => (
              <section key={s.title}>
                <h5>{s.title}</h5>
                {s.items.length > 0 && <ul>{s.items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
              </section>
            )) : <p className="handoff-card-plain">{received.note}</p>}
          </div>
        )}
      </div>
      {waits.length > 0 && (
        <Popover
          title={null}
          side="bottom"
          align="start"
          trigger={
            <button type="button" className="handoff-chip">
              <WaitIcon />
              {COPY.waitsMovedHere(waits.length)}
            </button>
          }
        >
          <ul className="handoff-chip-list">
            {waits.map((w) => <li key={w.id}>{pendingWaitLabel(w)}</li>)}
          </ul>
        </Popover>
      )}
    </div>
  );
}
