import { createContext, useContext, type ReactNode } from 'react';
import { CloseCircleFilled, EyeOutlined, RightOutlined } from '@ant-design/icons';
import { describeReason, linkId, targetHref, watchHref, type WatchWake } from '../lib/watches';
import { SameOriginLink } from './SameOriginLink';
import { relTime } from './Transcript';

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

type ChangedTarget = WatchWake['changedTargets'][number];

/**
 * The title this page holds for a target the wake names, by either spelling of its id — the wake
 * spells it as a UUID. The console provides it from what it has already read: the watches (the
 * server names each watch's targets) and this conversation's Tasks card. The shared page and an
 * export provide none, so their rows name the target by id.
 */
export const WatchWakeNamesCtx = createContext<((watchId: string, target: ChangedTarget) => string | undefined) | null>(
  null,
);

/** What happened, at a glance. */
function watchWakeTitle(kind: WatchWake['kind']): string {
  return TITLE[kind];
}

/** Why the watch queued this turn: a Match's own account of the condition, or the sentence one of
 *  the three ends is. */
function watchWakeWhy(wake: WatchWake): string {
  if (wake.kind !== 'MATCHED') return WHY[wake.kind];
  return wake.reason ? describeReason(wake.reason) : 'Its condition held.';
}

/** A target the line draws in its error tone: one the watch saw fail. A watch that ran out or lost
 *  its targets is not a failure — nothing it watched went wrong. */
const isFailed = (target: ChangedTarget) => target.status === 'FAILED';

/** What the line names after its title: the one target that moved — by its title alone, or by its
 *  kind and the end of its id where this page holds no title — or how many moved, in the noun the
 *  Watching strip counts in (`targetNoun`). Nothing when none did. */
function lineName(wake: WatchWake, name: string | undefined): string | null {
  const changed = wake.changedTargets;
  if (changed.length === 1) {
    return name || `${changed[0].kind === 'SESSION' ? 'Session' : 'Task'} ${linkId(changed[0].id).slice(-8)}`;
  }
  if (changed.length === 0) return null;
  const kinds = new Set(changed.map((t) => t.kind));
  const noun = kinds.size !== 1 ? 'target' : kinds.has('TASK') ? 'task' : 'session';
  return `${changed.length} ${noun}s`;
}

/** The word the line closes on: the one target's status, or how many of several failed. */
function lineStatus(wake: WatchWake): string | null {
  const changed = wake.changedTargets;
  if (changed.length === 1) return changed[0].status || null;
  const failed = changed.filter(isFailed);
  return failed.length > 0 ? `${failed.length} of ${changed.length} failed` : null;
}

/** One target the wake reports moved, by the title this page holds for it, linking to it. */
function ChangedRows({
  targets,
  more,
  name,
}: {
  targets: ChangedTarget[];
  more: number;
  name: (t: ChangedTarget) => string | undefined;
}) {
  return (
    <ul className="watch-wake-changed">
      {targets.map((t) => (
        <li key={`${t.kind}:${t.id}`} className={isFailed(t) ? 'is-failed' : undefined}>
          {t.kind === 'SESSION' ? 'Session' : 'Task'}{' '}
          <SameOriginLink href={targetHref(t.kind, t.id)}>{name(t) ?? linkId(t.id)}</SameOriginLink>
          {t.status ? ` is now ${t.status}` : ''}
        </li>
      ))}
      {more > 0 && <li>+{more} more</li>}
    </ul>
  );
}

/**
 * A turn a watch queued into this session (lib/watches `parseWatchWake`), drawn as one event line in
 * the agent's stream — the grammar a background job's news already uses (BackgroundWakeCard), in that
 * line's classes under a root of its own — rather than as a card on the reader's side of the
 * conversation. The card sat where
 * the reader's own messages sit, in a tint, so the reply the agent carried on with read as two
 * answers with somebody cutting in between them.
 *
 * It is no anchor for the sticky bar (no `data-sticky-label`): the bar keeps naming the question
 * the answer around it belongs to. Why it fired, each target that moved, who queued it, the way to
 * the watch and what the agent read open beneath it, behind a native disclosure so they still open
 * in a static export. A target that failed stays loud: the line takes the error tone, and where
 * several moved the failed ones stay in view while the fold is closed.
 *
 * The queued tail draws the same line while the wake waits behind the running turn, dashed, with the
 * queue's status line under it, so it keeps its shape when a runner takes it.
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
  const names = useContext(WatchWakeNamesCtx);
  const name = (t: ChangedTarget) => names?.(wake.watchId, t);
  const changed = wake.changedTargets;
  const failed = changed.some(isFailed);
  const title = lineName(wake, changed.length === 1 ? name(changed[0]) : undefined);
  const closing = lineStatus(wake);
  // The failures that stay out of the fold where several moved — a lone one is the line itself.
  const failures = changed.length > 1 ? changed.filter(isFailed) : [];
  return (
    <div className={`watch-wake ${failed ? 'is-failed' : 'is-ok'}${queued ? ' is-queued' : ''}`} data-seq={seq}>
      <details className="bgwake-fold">
        <summary className="bgwake-row">
          <span className="bgwake-mark">{failed ? <CloseCircleFilled /> : <EyeOutlined />}</span>
          <span className="bgwake-title">{watchWakeTitle(wake.kind)}</span>
          {title && <span className="bgwake-name">{title}</span>}
          {closing && <span className="bgwake-status">{closing}</span>}
          {ts && <span className="bgwake-time">{relTime(ts)}</span>}
          <span className="bgwake-details-label">
            详情
            <RightOutlined className="bgwake-caret" />
          </span>
        </summary>
        <div className="bgwake-body">
          <div className="watch-wake-why">{watchWakeWhy(wake)}</div>
          {changed.length > 0 && (
            <ChangedRows targets={changed.slice(0, SHOWN_CHANGES)} more={changed.length - SHOWN_CHANGES} name={name} />
          )}
          <div className="bgwake-meta">
            Queued by a watch, not typed by you
            {wake.generation !== null ? ` · generation ${wake.generation}` : ''}
          </div>
          {linkable && (
            <div className="watch-wake-links">
              <SameOriginLink href={watchHref(wake.watchId)}>View watch</SameOriginLink>
            </div>
          )}
          <details className="bgwake-raw">
            <summary>What the agent received</summary>
            <pre>{text}</pre>
          </details>
        </div>
      </details>
      {/* The fold lists every target, these among them; closed, the failures stay in view. */}
      {failures.length > 0 && (
        <div className="watch-wake-failures">
          <ChangedRows targets={failures.slice(0, SHOWN_CHANGES)} more={failures.length - SHOWN_CHANGES} name={name} />
        </div>
      )}
      {undelivered && <div className="bgwake-undelivered">The session has not confirmed it received this.</div>}
      {queued && <div className="bgwake-queued">{queued}</div>}
    </div>
  );
}
