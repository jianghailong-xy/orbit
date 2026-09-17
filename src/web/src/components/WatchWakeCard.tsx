import type { ReactNode } from 'react';
import { EyeOutlined } from '@ant-design/icons';
import { ago, describeReason, linkId, targetHref, watchHref, type WatchWake } from '../lib/watches';
import { SameOriginLink } from './SameOriginLink';

/** How many changed targets the card names before "+N more". */
const SHOWN_CHANGES = 5;

const TITLE: Record<WatchWake['kind'], string> = {
  MATCHED: 'Watch triggered',
  EXPIRED: 'Watch expired',
  REVOKED: 'Watch stopped: access lost',
  UNRESOLVABLE: 'Watch stopped: every target is gone',
};

const WHY: Record<Exclude<WatchWake['kind'], 'MATCHED'>, string> = {
  EXPIRED: 'Its deadline passed before its condition held. It will not wake this session again.',
  REVOKED: 'This account can no longer read one of its targets, so it reports nothing about them.',
  UNRESOLVABLE: 'Every target it watched was deleted, so its condition can never be decided.',
};

/** What happened, at a glance. */
function watchWakeTitle(kind: WatchWake['kind']): string {
  return TITLE[kind];
}

/** Why the watch queued this turn: a Match's own account of the condition, or the sentence one of
 *  the three ends is. The sticky bar at the top of the transcript reads it too, so the turn it
 *  names says the same there as on the card it points at. */
function watchWakeWhy(wake: WatchWake): string {
  if (wake.kind !== 'MATCHED') return WHY[wake.kind];
  return wake.reason ? describeReason(wake.reason) : 'Its condition held.';
}

/**
 * A turn a watch queued into this session (lib/watches `parseWatchWake`), drawn as the watch's rather
 * than as a message the user typed: what happened, what changed, and a way to the watch. The words the
 * agent read stay one click away exactly as it read them — a native disclosure, so they still open in
 * a static export.
 *
 * The queued tail draws the same card while the wake still waits behind the running turn, with the
 * queue's status line at its foot, so it keeps its shape when a runner takes it.
 */
export function WatchWakeCard({
  wake,
  text,
  seq,
  ts,
  linkable,
  undelivered,
  queued,
}: {
  wake: WatchWake;
  text: string;
  /** Unset while the wake is still queued: it is no event yet, so ⌘F has nothing to land on. */
  seq?: number;
  ts?: string;
  /** False where the Following page is out of reach: a static export. */
  linkable: boolean;
  /** The runner has not confirmed the engine received the turn. */
  undelivered: boolean;
  /** The queued tail's status line, while the wake still waits for its turn. */
  queued?: ReactNode;
}) {
  const changed = wake.changedTargets.slice(0, SHOWN_CHANGES);
  const more = wake.changedTargets.length - changed.length;
  return (
    <div className="watch-wake-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes: it
          scans for user bubbles and would otherwise either skip the wake (naming an earlier
          question instead, and scrolling to it) or, as iOS did, call it the person's own. */}
      <div
        className={`watch-wake is-${wake.kind.toLowerCase()}${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={watchWakeTitle(wake.kind)}
        data-sticky-text={watchWakeWhy(wake)}
      >
        <div className="watch-wake-title">
          <EyeOutlined /> {watchWakeTitle(wake.kind)}
        </div>
        <div className="watch-wake-why">{watchWakeWhy(wake)}</div>
        {changed.length > 0 && (
          <ul className="watch-wake-changed">
            {changed.map((t) => (
              <li key={`${t.kind}:${t.id}`}>
                {t.kind === 'SESSION' ? 'Session' : 'Task'}{' '}
                <SameOriginLink href={targetHref(t.kind, t.id)}>{linkId(t.id)}</SameOriginLink>
                {t.status ? ` is now ${t.status}` : ''}
              </li>
            ))}
            {more > 0 && <li>+{more} more</li>}
          </ul>
        )}
        <div className="watch-wake-meta">
          Queued by a watch, not typed by you
          {wake.generation !== null ? ` · generation ${wake.generation}` : ''}
          {ts ? ` · ${ago(ts, Date.now())}` : ''}
        </div>
        {undelivered && (
          <div className="watch-wake-undelivered">The session has not confirmed it received this.</div>
        )}
        {linkable && (
          <div className="watch-wake-links">
            <SameOriginLink href={watchHref(wake.watchId)}>View watch</SameOriginLink>
          </div>
        )}
        <details className="watch-wake-raw">
          <summary>What the agent received</summary>
          <pre>{text}</pre>
        </details>
        {queued && <div className="watch-wake-queued">{queued}</div>}
      </div>
    </div>
  );
}
