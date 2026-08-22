import { Tooltip } from 'antd';
import { Link } from 'react-router-dom';

/**
 * §13.8: what happened to each @-mention a comment made.
 *
 * Shown under the comment rather than in a panel of its own, because the question it answers is
 * about THAT comment: "did the agent I named ever get this?". Before the delivery ledger the answer
 * lived in one apiserver's log, and the visible outcome of a mention nobody could deliver was a
 * comment that looked posted and an agent that never replied.
 *
 * Only the states worth a reader's attention are drawn. DELIVERED is the expected case and says
 * nothing useful once it has happened; a comment written before the ledger existed
 * (`deliveries` absent) is deliberately blank rather than labelled "delivered", because nobody
 * recorded that it was.
 */
export interface MentionDelivery {
  id: string;
  workspaceId: string;
  status: 'PENDING' | 'DELIVERING' | 'SESSION_CREATED' | 'QUEUED' | 'DELIVERED' | 'BLOCKED' | 'DEAD';
  attempts: number;
  errorCode: string | null;
  requiredAction: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  targetSessionId: string | null;
}

/** What each state means to somebody reading a thread, in the fewest words that stay true. */
const LABEL: Record<MentionDelivery['status'], string> = {
  // Nothing has gone wrong and nothing has arrived yet. Worth one quiet word, because a mention
  // that shows nothing at all is indistinguishable from one that was never made.
  PENDING: 'sending…',
  DELIVERING: 'sending…',
  SESSION_CREATED: 'sending…',
  // The strongest claim that is true: durably queued, and the agent has not read it yet.
  QUEUED: 'queued',
  // Shown, quietly. "It arrived, and here is where" is the answer somebody opening a thread is
  // usually looking for, and the session link is what turns it into somewhere to go.
  DELIVERED: 'delivered',
  BLOCKED: 'not delivered yet',
  DEAD: 'not delivered',
};

export function MentionDeliveryNotes({
  deliveries,
  mentions,
  agents,
}: {
  deliveries?: MentionDelivery[];
  /** The comment's own mention list, used only to tell "no mentions" from "not tracked". */
  mentions?: string[];
  agents: Array<{ id: string; name?: string | null }>;
}) {
  const shown = deliveries ?? [];
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
  // A comment that mentioned somebody but carries no ledger rows was written before §13.8 existed
  // (`mention_delivery_version` 0) and delivered by the inline loop, which recorded nothing.
  // Neither "delivered" nor "failed" was ever established, so the honest label is that nobody
  // knows — said once for the comment rather than per mention.
  if (shown.length === 0) {
    if (!mentions?.length) return null;
    return (
      <div className="tdp-mention-deliveries">
        <Tooltip title="This comment predates mention delivery tracking, so whether these agents received it was never recorded.">
          <span className="tdp-mention-delivery tdp-mention-delivery-untracked">
            delivery not tracked
          </span>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="tdp-mention-deliveries">
      {shown.map((delivery) => {
        // The reason and the remedy, in that order — a status without "what would clear this" is
        // the spinner problem with extra steps.
        const detail = [delivery.requiredAction, delivery.lastError].filter(Boolean).join(' — ');
        const label = (
          <>
            @{nameOf(delivery.workspaceId)}: {LABEL[delivery.status]}
            {delivery.errorCode ? ` (${delivery.errorCode})` : ''}
          </>
        );
        const body = (
          <span
            className={`tdp-mention-delivery tdp-mention-delivery-${delivery.status.toLowerCase()}`}
          >
            {/* Where it landed, when it landed anywhere. A status with nowhere to go is a status
                somebody has to go and find the session for by hand. */}
            {delivery.targetSessionId ? (
              <Link to={`/sessions/${delivery.targetSessionId}`}>{label}</Link>
            ) : (
              label
            )}
          </span>
        );
        return detail ? (
          <Tooltip key={delivery.id} title={detail}>
            {body}
          </Tooltip>
        ) : (
          <span key={delivery.id}>{body}</span>
        );
      })}
    </div>
  );
}
