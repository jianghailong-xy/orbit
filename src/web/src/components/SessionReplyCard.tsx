import type { ReactNode } from 'react';
import { RollbackOutlined } from '@ant-design/icons';
import type { SessionReplyCard as Card } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import {
  SESSION_REPLY_CHOSE,
  SESSION_REPLY_FROM,
  SESSION_REPLY_LAST_WORDS,
  SESSION_REPLY_NEVER_SEEN,
  SESSION_REPLY_NOT_YOU,
  SESSION_REPLY_OPEN_REQUEST,
  SESSION_REPLY_OUTCOME_LABEL,
  SESSION_REPLY_YOU_ASKED,
  sessionReplySticky,
} from '../lib/sessionRequest';
import { sessionRecordHref } from '../lib/transcriptDeepLink';
import { AppLink } from './AppLink';
import { MD, relTime } from './Transcript';

/**
 * The outcomes of this session's own requests, handed back to it (docs/session-request-reply-contract.md
 * §4.2) — drawn as reply cards rather than as the owner's bubble, because nobody typed the turn: the
 * platform opened it to say what each request came to. One card per outcome the turn carried, from the
 * snapshot the control plane recorded beside the echo (`sessionReplies`, lib/sessionRequest), each
 * naming the session that was asked and opening the request where it sits in that session's
 * transcript. Read-only: there is nothing here for the owner to answer.
 *
 * Every word is shared with the native card (OrbitKit `SessionReplyCardView`), and
 * `SessionRequestCopyParityTests.swift` reads lib/sessionRequest.ts to hold the two to it.
 */
export function SessionReplyCards({
  cards,
  seq,
  ts,
  attached,
}: {
  cards: readonly Card[];
  seq?: number;
  ts?: string;
  /** What else delivery appended to the same turn, as its own folded entry. */
  attached?: ReactNode;
}) {
  const sticky = sessionReplySticky(cards);
  return (
    <div className="src-wrap" data-seq={seq} data-sticky-label={sticky.label} data-sticky-text={sticky.text}>
      {cards.map((card) => <SessionReplyCard key={card.requestId} card={card} ts={ts} />)}
      {attached}
    </div>
  );
}

export function SessionReplyCard({ card, ts }: { card: Card; ts?: string }) {
  const title = card.fromTitle.trim() || 'Untitled session';
  const sessionPublic = routeId(card.fromSessionId);
  const sessionHref = sessionPublic ? `/sessions/${encodeURIComponent(sessionPublic)}` : null;
  const turnPublic = card.requestTurnId ? routeId(card.requestTurnId) : null;
  const requestHref = sessionPublic
    ? (turnPublic ? sessionRecordHref(sessionPublic, turnPublic) : sessionHref)
    : null;
  return (
    <div className="src" data-outcome={card.outcome}>
      <div className="src-head">
        <span className="src-mark"><RollbackOutlined /></span>
        <span>{SESSION_REPLY_FROM}</span>
        {sessionHref ? <AppLink className="src-from" to={sessionHref}>{title}</AppLink> : <span className="src-from">{title}</span>}
        <span className={`src-outcome src-outcome-${card.outcome.toLowerCase()}`}>
          {SESSION_REPLY_OUTCOME_LABEL[card.outcome]}
        </span>
      </div>
      <div className="src-asked">
        <span className="src-label">{SESSION_REPLY_YOU_ASKED}</span> {card.requestPreview}
      </div>
      {card.replyOption != null && (
        <div className="src-chose">
          <span className="src-label">{SESSION_REPLY_CHOSE}</span> {card.replyOption}. {card.replyOptionLabel ?? ''}
        </div>
      )}
      {card.replyText && (
        <div className="src-body">
          <MD breaks>{card.replyText}</MD>
        </div>
      )}
      {card.outcome === 'UNDELIVERED' && <div className="src-note">{SESSION_REPLY_NEVER_SEEN}</div>}
      {card.outcome !== 'REPLIED' && card.excerpt && (
        <div className="src-excerpt">
          <div className="src-label">{SESSION_REPLY_LAST_WORDS}</div>
          <MD breaks>{card.excerpt}</MD>
        </div>
      )}
      <div className="src-meta">
        {SESSION_REPLY_NOT_YOU}
        {ts ? ` · ${relTime(ts)}` : ''}
        {requestHref && (
          <>
            {' · '}
            <AppLink to={requestHref}>{SESSION_REPLY_OPEN_REQUEST}</AppLink>
          </>
        )}
      </div>
    </div>
  );
}
