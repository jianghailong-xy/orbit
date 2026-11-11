import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MessageOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SessionMessageCard as Card } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { sessionRequestQuery } from '../lib/queries';
import {
  SESSION_REQUEST_ASKS,
  SESSION_REQUEST_DUE,
  SESSION_REQUEST_STATE_LABEL,
  formatReplyBy,
} from '../lib/sessionRequest';
import {
  SESSION_MESSAGE_FROM,
  SESSION_MESSAGE_NOT_YOU,
  SESSION_MESSAGE_OPEN_TASK,
  SESSION_MESSAGE_UNDELIVERED,
  sessionMessageSticky,
  sessionMessageTitle,
} from '../lib/sessionMessage';
import { AppLink } from './AppLink';
import { ExportCtx, MD, REVEAL_EVENT, relTime } from './Transcript';

/**
 * Another Orbit session's message, drawn as "From [that session]" — instead of the account owner's
 * own bubble.
 *
 * `session_send` and `project_send` write a turn into this conversation that the owner did not type.
 * The words are the sending agent's and are drawn as they were sent; what the card adds is who sent
 * them: the session's title, which opens it, the agent it runs as, and the task it runs, from the
 * payload the control plane recorded beside the echo (`sessionMessage`, lib/sessionMessage). The
 * block delivery appended to tell the recipient the same thing rides inside, folded, with anything
 * else delivery appended.
 *
 * Every word is shared with the native card (OrbitKit `SessionMessageCard`), and
 * `SessionMessageCopyParityTests.swift` reads lib/sessionMessage.ts to hold the two to it.
 */
export function SessionMessageCard({
  card,
  text,
  seq,
  ts,
  undelivered,
  attached,
  queued,
}: {
  card: Card;
  /** The sending agent's words, as the recipient was handed them. */
  text: string;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** What delivery appended to the same turn, as its own folded entry. */
  attached?: ReactNode;
  /** The queue's own line, while the message still waits to be delivered (WorkspaceView's queued
   *  tail): the card it will be once a runner takes it, with how it stands and Cancel at its foot. */
  queued?: ReactNode;
}) {
  // An export is read on paper, where nothing can be unfolded: it gets the whole message.
  const exporting = useContext(ExportCtx) != null;
  const [expanded, setExpanded] = useState(false);
  // A message taller than SESSION_MESSAGE_CLAMP_FROM lines shows its first SESSION_MESSAGE_CLAMP_LINES
  // and a "Show more" (design: docs/mocks/session-message-clamp/, approved 2026-11-11). Measured, not
  // counted: real task-run messages run 500–3,000 characters over 10–40 lines, so a character cut
  // (6,000 until then) never fired on the ones that filled a screen.
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tall = useTallBody(bodyRef, !exporting);
  const clamped = tall && !expanded && !exporting;
  // A find that lands in the hidden part opens it, as it opens a steps line (SessionFind).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const reveal = () => setExpanded(true);
    el.addEventListener(REVEAL_EVENT, reveal);
    return () => el.removeEventListener(REVEAL_EVENT, reveal);
  }, []);
  const title = sessionMessageTitle(card);
  const sessionPublic = routeId(card.fromSessionId);
  const sessionHref = sessionPublic ? `/sessions/${encodeURIComponent(sessionPublic)}` : null;
  const taskPublic = card.fromTaskId ? routeId(card.fromTaskId) : null;
  const taskHref = taskPublic ? `/tasks/${encodeURIComponent(taskPublic)}` : null;
  const sticky = sessionMessageSticky(card, text);
  return (
    <div className="smc-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes, the
          way it names every other turn the owner did not type. */}
      <div
        ref={rootRef}
        className={`smc${queued ? ' is-queued' : ''}${clamped ? ' is-clamped' : ''}`}
        data-seq={seq}
        data-sticky-label={sticky.label}
        data-sticky-text={sticky.text}
      >
        <div className="smc-head">
          <span className="smc-mark"><MessageOutlined /></span>
          <span>{SESSION_MESSAGE_FROM}</span>
          {sessionHref ? (
            <AppLink className="smc-from" to={sessionHref}>{title}</AppLink>
          ) : (
            <span className="smc-from">{title}</span>
          )}
          {card.fromAgentName && <span className="smc-agent">{card.fromAgentName}</span>}
        </div>
        {text && (
          <div ref={bodyRef} className={`smc-body${clamped ? ' is-clamped' : ''}`}>
            <MD breaks>{text}</MD>
          </div>
        )}
        {tall && !exporting && (
          <button type="button" className="smc-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? SESSION_MESSAGE_SHOW_LESS : SESSION_MESSAGE_SHOW_MORE}
          </button>
        )}
        <div className="smc-meta">
          {SESSION_MESSAGE_NOT_YOU}
          {ts ? ` · ${relTime(ts)}` : ''}
          {taskHref && (
            <>
              {' · '}
              <AppLink to={taskHref}>{SESSION_MESSAGE_OPEN_TASK}</AppLink>
            </>
          )}
        </div>
        {card.requestId && (exporting
          ? <div className="smc-request"><span className="smc-request-asks">{SESSION_REQUEST_ASKS}</span></div>
          : <SessionRequestStatus requestId={card.requestId} />)}
        {undelivered && <div className="smc-undelivered">{SESSION_MESSAGE_UNDELIVERED}</div>}
        {attached}
        {queued && <div className="smc-queued">{queued}</div>}
      </div>
    </div>
  );
}

/** Lines a long message shows while folded, and how many lines make it long enough to fold. */
export const SESSION_MESSAGE_CLAMP_LINES = 8;
export const SESSION_MESSAGE_CLAMP_FROM = 12;
export const SESSION_MESSAGE_SHOW_MORE = 'Show more';
export const SESSION_MESSAGE_SHOW_LESS = 'Show less';

/**
 * Whether the body runs past SESSION_MESSAGE_CLAMP_FROM lines, by its rendered height against its own
 * line height, re-measured as the width changes. With no layout to read (an export, a test DOM), it is
 * never tall, so the message shows whole.
 */
function useTallBody(ref: RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(el).lineHeight) || 0;
      setTall(line > 0 && el.scrollHeight > line * SESSION_MESSAGE_CLAMP_FROM);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return tall;
}

/**
 * The request a message is, as it stands now: "Asked for a reply · due 18:00", and its state — waiting,
 * or which of the five outcomes it came to. Read live (`GET /session-requests/:id`), because the card
 * is stored once and the state moves; refreshed by every session event and, while it waits, by a poll.
 * Read-only on purpose: the owner does not answer for the session (contract §9.3).
 */
export function SessionRequestStatus({ requestId }: { requestId: string }) {
  const request = useQuery(sessionRequestQuery(requestId));
  const view = request.data;
  return (
    <div className="smc-request" data-state={view?.state}>
      <span className="smc-request-asks">{SESSION_REQUEST_ASKS}</span>
      {view?.replyBy && view.state === 'OPEN' && (
        <span className="smc-request-due">{` · ${SESSION_REQUEST_DUE} ${formatReplyBy(view.replyBy)}`}</span>
      )}
      {view && (
        <span className={`smc-request-state smc-request-state-${view.state.toLowerCase()}`}>
          {SESSION_REQUEST_STATE_LABEL[view.state]}
        </span>
      )}
    </div>
  );
}
