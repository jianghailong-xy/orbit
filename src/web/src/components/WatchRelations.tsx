import { useMemo, useState } from 'react';
import { EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Popover } from 'antd';
import { Link } from 'react-router-dom';
import type { WatchView } from '@orbit/shared';
import { watchesQuery } from '../lib/queries';
import {
  ago,
  describeCondition,
  describeProgress,
  expiryLabel,
  isLiveWatch,
  progressOf,
  watchBucket,
  watchHref,
  watchProblem,
  watchStateCopy,
  watchesFollowedBy,
  watchesFollowing,
} from '../lib/watches';
import { WatchCard } from './WatchCard';
import { WatchEditorModal } from './WatchEditor';
import { ObserverLink, WatchStatePill, useNow } from './WatchParts';

const rowsOf = (data: unknown): WatchView[] => (Array.isArray(data) ? (data as WatchView[]) : []);

/** One watch on one line, where it is shown beside what it relates to rather than on its own. */
export function WatchRow({ watch }: { watch: WatchView }) {
  const now = useNow();
  const problem = watchProblem(watch);
  const expiry = isLiveWatch(watch) ? expiryLabel(watch, now) : null;
  return (
    <div className={`watch-row${problem ? ` tone-${problem.tone}` : ''}`} data-watch-id={watch.id}>
      <WatchStatePill state={watch.state} />
      <div className="watch-row-main">
        <div className="watch-row-condition">{describeCondition(watch.predicate, watch.targets)}</div>
        <div className="watch-row-sub">
          {problem ? (
            problem.title
          ) : watch.action === 'NOTIFY_USER' ? (
            'Then notify you'
          ) : (
            <>
              Then resume{' '}
              {watch.observerSessionId ? (
                <ObserverLink sessionId={watch.observerSessionId} />
              ) : (
                'the waiting session'
              )}
            </>
          )}
          {` · ${describeProgress(progressOf(watch))} · checked ${ago(watch.lastEvaluatedAt, now)}`}
          {expiry ? ` · expires ${expiry.text}` : ''}
        </div>
      </div>
      <Link className="watch-row-open" to={watchHref(watch.id)}>
        Open
      </Link>
    </div>
  );
}

function WatchRowList({ watches }: { watches: readonly WatchView[] }) {
  return (
    <div className="watch-row-list">
      {watches.map((w) => (
        <WatchRow key={w.id} watch={w} />
      ))}
    </div>
  );
}

/**
 * A task's Followed by: the live watches that name it, and the way to follow it. Ended ones are only
 * counted here; their history is read on the Following page.
 */
export function TaskFollowedBy({ taskId }: { taskId: string }) {
  const watchesQ = useQuery(watchesQuery());
  const [following, setFollowing] = useState(false);
  const related = useMemo(
    () => watchesFollowedBy(rowsOf(watchesQ.data), 'TASK', taskId),
    [watchesQ.data, taskId],
  );
  const live = related.filter(isLiveWatch);
  const ended = related.filter((w) => !isLiveWatch(w));
  const endedTab = ended.some((w) => watchBucket(w) === 'attention') ? 'attention' : 'history';
  return (
    <section className="tdp-section watch-relations" aria-label="Followed by">
      <div className="tdp-section-title watch-relations-title">
        <span>Followed by ({live.length})</span>
        <Button size="small" icon={<EyeOutlined />} onClick={() => setFollowing(true)}>
          Follow task
        </Button>
      </div>
      {watchesQ.isPending ? (
        <div className="tdp-muted">Loading watches…</div>
      ) : watchesQ.isError ? (
        <div className="tdp-muted">Couldn’t load watches.</div>
      ) : live.length === 0 ? (
        <div className="tdp-muted">Nothing is watching this task.</div>
      ) : (
        <WatchRowList watches={live} />
      )}
      {ended.length > 0 && (
        <Link className="watch-relations-more" to={`/following?tab=${endedTab}`}>
          {ended.length} ended {ended.length === 1 ? 'watch' : 'watches'}
        </Link>
      )}
      {following && (
        <WatchEditorModal
          mode={{ kind: 'create', targets: [{ kind: 'TASK', id: taskId }] }}
          onClose={() => setFollowing(false)}
        />
      )}
    </section>
  );
}

const targetNoun = (watches: readonly WatchView[], count: number): string => {
  const kinds = new Set(watches.flatMap((w) => w.targets.map((t) => t.targetKind)));
  const noun = kinds.size !== 1 ? 'target' : kinds.has('TASK') ? 'task' : 'session';
  return count === 1 ? noun : `${noun}s`;
};

/**
 * A session's two relations, in its header: Following — the live watches it is the observer of, so
 * what it is waiting on — and Followed by — the live watches that name it. Each opens its watch rows;
 * Follow creates a watch on this session.
 */
export function SessionWatchBadges({ sessionId }: { sessionId: string }) {
  const watchesQ = useQuery(watchesQuery());
  const [following, setFollowing] = useState(false);
  const rows = rowsOf(watchesQ.data);
  const waitingOn = watchesFollowing(rows, sessionId).filter(isLiveWatch);
  const watchedBy = watchesFollowedBy(rows, 'SESSION', sessionId).filter(isLiveWatch);
  const targets = new Set(
    waitingOn.flatMap((w) => w.targets.map((t) => `${t.targetKind}:${t.targetResourceId}`)),
  ).size;
  return (
    <span className="watch-badges">
      {waitingOn.length > 0 && (
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="This session is waiting on"
          content={<WatchRowList watches={waitingOn} />}
        >
          <button type="button" className="watch-chip">
            <EyeOutlined /> Following {targets} {targetNoun(waitingOn, targets)}
          </button>
        </Popover>
      )}
      {watchedBy.length > 0 && (
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="Watches on this session"
          content={<WatchRowList watches={watchedBy} />}
        >
          <button type="button" className="watch-chip is-quiet">
            Followed by {watchedBy.length}
          </button>
        </Popover>
      )}
      <button
        type="button"
        className="watch-chip is-action"
        title="Follow this session: be notified, or resume another session, when it reaches a condition"
        onClick={() => setFollowing(true)}
      >
        Follow
      </button>
      {following && (
        <WatchEditorModal
          mode={{ kind: 'create', targets: [{ kind: 'SESSION', id: sessionId }] }}
          onClose={() => setFollowing(false)}
        />
      )}
    </span>
  );
}

/**
 * Above the composer: the watches this session is waiting on, while any is live. One line until it is
 * opened, then the full cards. Its own strip on purpose — a watch is not a process, and contract §9.2
 * keeps it out of the Background processes tray beside it.
 */
export function SessionWatchStrip({ sessionId }: { sessionId: string }) {
  const watchesQ = useQuery(watchesQuery());
  const now = useNow();
  const [open, setOpen] = useState(false);
  const waitingOn = watchesFollowing(rowsOf(watchesQ.data), sessionId).filter(isLiveWatch);
  if (waitingOn.length === 0) return null;
  const [first] = waitingOn;
  const summary =
    waitingOn.length === 1
      ? [
          describeCondition(first.predicate, first.targets),
          first.state === 'PAUSED'
            ? watchStateCopy(first.state).label.toLowerCase()
            : describeProgress(progressOf(first)),
          `checked ${ago(first.lastEvaluatedAt, now)}`,
        ].join(' · ')
      : waitingOn.map((w) => describeCondition(w.predicate, w.targets)).join(' · ');
  return (
    <div className={`watch-strip${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="watch-strip-row"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EyeOutlined className="watch-strip-ico" />
        <span className="watch-strip-title">
          Waiting on {waitingOn.length === 1 ? 'a watch' : `${waitingOn.length} watches`}
        </span>
        <span className="watch-strip-summary">{summary}</span>
        <span className="watch-strip-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="watch-strip-list">
          {waitingOn.map((w) => (
            <WatchCard key={w.id} watch={w} />
          ))}
        </div>
      )}
    </div>
  );
}
