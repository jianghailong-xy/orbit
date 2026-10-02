import { useContext, useState, type ReactNode } from 'react';
import { MessageOutlined } from '@ant-design/icons';
import type { SessionMessageCard as Card } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import {
  SESSION_MESSAGE_FROM,
  SESSION_MESSAGE_NOT_YOU,
  SESSION_MESSAGE_OPEN_TASK,
  SESSION_MESSAGE_UNDELIVERED,
  sessionMessageSticky,
  sessionMessageTitle,
} from '../lib/sessionMessage';
import { AppLink } from './AppLink';
import { ExportCtx, MD, USER_BUBBLE_TRUNCATE, relTime } from './Transcript';

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
}: {
  card: Card;
  /** The sending agent's words, as the recipient was handed them. */
  text: string;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** What delivery appended to the same turn, as its own folded entry. */
  attached?: ReactNode;
}) {
  // An export is read on paper, where nothing can be unfolded: it gets the whole message.
  const exporting = useContext(ExportCtx) != null;
  const [expanded, setExpanded] = useState(false);
  const long = text.length > USER_BUBBLE_TRUNCATE;
  const shown = long && !expanded && !exporting ? text.slice(0, USER_BUBBLE_TRUNCATE) : text;
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
      <div className="smc" data-seq={seq} data-sticky-label={sticky.label} data-sticky-text={sticky.text}>
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
        {shown && (
          <div className="smc-body">
            <MD breaks>{shown}</MD>
          </div>
        )}
        {long && !exporting && (
          <button type="button" className="smc-more" onClick={() => setExpanded(!expanded)}>
            {expanded
              ? 'Show less'
              : `Show ${(text.length - USER_BUBBLE_TRUNCATE).toLocaleString()} more characters`}
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
        {undelivered && <div className="smc-undelivered">{SESSION_MESSAGE_UNDELIVERED}</div>}
        {attached}
      </div>
    </div>
  );
}
