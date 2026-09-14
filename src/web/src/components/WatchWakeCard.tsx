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

/**
 * A turn a watch queued into this session (lib/watches `parseWatchWake`), drawn as the watch's rather
 * than as a message the user typed: what happened, what changed, and a way to the watch. The words the
 * agent read stay one click away exactly as it read them — a native disclosure, so they still open in
 * a static export.
 */
export function WatchWakeCard({
  wake,
  text,
  seq,
  ts,
  linkable,
  undelivered,
}: {
  wake: WatchWake;
  text: string;
  seq: number;
  ts?: string;
  /** False where the Following page is out of reach: a static export. */
  linkable: boolean;
  /** The runner has not confirmed the engine received the turn. */
  undelivered: boolean;
}) {
  const changed = wake.changedTargets.slice(0, SHOWN_CHANGES);
  const more = wake.changedTargets.length - changed.length;
  return (
    <div className="watch-wake-wrap">
      <div className={`watch-wake is-${wake.kind.toLowerCase()}`} data-seq={seq}>
        <div className="watch-wake-title">
          <EyeOutlined /> {TITLE[wake.kind]}
        </div>
        <div className="watch-wake-why">
          {wake.kind === 'MATCHED'
            ? wake.reason
              ? describeReason(wake.reason)
              : 'Its condition held.'
            : WHY[wake.kind]}
        </div>
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
      </div>
    </div>
  );
}
