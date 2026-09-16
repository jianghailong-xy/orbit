import { useMemo, useState } from 'react';
import { EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Popover } from 'antd';
import { Link } from 'react-router-dom';
import type { WatchView } from '@orbit/shared';
import { watchesQuery } from '../lib/queries';
import {
  SHOWN_TARGETS,
  STRIP_EARLIEST,
  STRIP_LABEL,
  STRIP_MANAGE,
  STRIP_THEN,
  STRIP_UNTIL,
  ago,
  describeCondition,
  describeProgress,
  expiryLabel,
  formatSpan,
  isLiveWatch,
  linkId,
  progressOf,
  thresholdOf,
  watchBucket,
  watchHref,
  watchProblem,
  watchesFollowedBy,
  watchesFollowing,
  type WatchThreshold,
} from '../lib/watches';
import { absTime } from './WatchCard';
import { WatchEditorModal } from './WatchEditor';
import { ObserverLink, WatchStatePill, WatchTargetLink, useNow, useTargetName } from './WatchParts';

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
 * What one watch's condition asks for, over the targets its leaf can read: every one of them, any
 * one of them, or a count in between. The count is the predicate's own — an ANY watch over four
 * targets is done after one — so the middle of the line says what the wait needs, not what it
 * covers: "all 4 tasks" is four waits, "any 1 of 4 tasks" is one of four.
 */
function thresholdLine(t: WatchThreshold, watches: readonly WatchView[]): string {
  const noun = targetNoun(watches, t.of);
  if (t.of === 0) return `no ${noun}`;
  if (t.needed === t.of) return `all ${t.of} ${noun}`;
  if (t.needed === 1) return `any 1 of ${t.of} ${noun}`;
  return `${t.needed} of ${t.of} ${noun}`;
}

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
 * Above the composer: the watches this session is waiting on, while any is live. Always one line
 * first — the same language as the Background processes tray beside it — naming the single target a
 * lone watch waits on, or counting the targets several watches cover, with the soonest deadline.
 * Opened, each watch's facts read as read-only rows: a wait is changed by talking to the agent, and
 * Pause/Stop live on the Following page. Its own strip on purpose — a watch is not a process, and
 * contract §9.2 keeps it out of the Background processes tray beside it.
 */
export function SessionWatchStrip({ sessionId }: { sessionId: string }) {
  const watchesQ = useQuery(watchesQuery());
  const now = useNow();
  const [open, setOpen] = useState(false);
  const waitingOn = watchesFollowing(rowsOf(watchesQ.data), sessionId).filter(isLiveWatch);
  // One line names the target only when there is one name to give: a lone watch over one target
  // that still exists. Anything else counts the distinct targets, so two watches over the same
  // task never read "2 targets".
  const live = waitingOn.flatMap((w) => w.targets.filter((t) => t.state !== 'GONE'));
  const targets = live.map((t) => `${t.targetKind}:${t.targetResourceId}`);
  const single = waitingOn.length === 1 && new Set(targets).size === 1 ? live[0] : null;
  const { name: singleName } = useTargetName(single?.targetKind ?? null, single?.targetResourceId ?? null);
  if (waitingOn.length === 0) return null;
  const deadline = Math.min(...waitingOn.map((w) => Date.parse(w.expiresAt)));
  const left = Number.isFinite(deadline) ? deadline - now : NaN;
  const time = Number.isFinite(left) ? (left <= 0 ? 'now' : `${formatSpan(left)} left`) : null;
  const targetCount = new Set(targets).size;
  const met = new Set(
    live.filter((t) => t.state === 'SATISFIED').map((t) => `${t.targetKind}:${t.targetResourceId}`),
  ).size;
  // What the wait is for: one watch over one target names it, one watch over several states the
  // threshold its own condition sets, and several watches — no one condition between them — count
  // the targets they cover.
  const targetLine = single
    ? (singleName ?? linkId(single.targetResourceId).slice(0, 8))
    : waitingOn.length === 1
      ? thresholdLine(thresholdOf(waitingOn[0].predicate, live), waitingOn)
      : `${targetCount} ${targetNoun(waitingOn, targetCount)}`;
  return (
    <div className={`watch-strip${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="watch-strip-row"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EyeOutlined className="watch-strip-ico" />
        <span className="watch-strip-title">{STRIP_LABEL}</span>
        <span className="watch-strip-target">{targetLine}</span>
        {time && (
          <span className="watch-strip-time">
            {waitingOn.length === 1 ? '' : STRIP_EARLIEST}
            <b className="watch-strip-met">{met}</b> met · {time}
          </span>
        )}
        <span className="watch-strip-caret">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div className="watch-strip-list">
          {waitingOn.map((w, index) => (
            <StripWatchBlock key={w.id} watch={w} now={now} showsThen={index === 0} />
          ))}
          <Link className="watch-strip-manage" to="/following">
            {STRIP_MANAGE}
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * One watch's facts in the opened strip, read-only: the rows are Until / Progress / Watching /
 * Then / Expires — what the wait is for first, so a reader with several watches open reads the
 * conditions before wading through the names they are over. Then — a constant for every strip
 * watch, since all of them resume this session — is said once, on the first. Progress carries the
 * evaluator's last look, so the strip keeps one fewer row than a card does.
 */
function StripWatchBlock({ watch, now, showsThen }: { watch: WatchView; now: number; showsThen: boolean }) {
  const expiry = expiryLabel(watch, now);
  const until = describeCondition(watch.predicate, watch.targets).replace(/^When /, '').replace(/^./, (c) => c.toUpperCase());
  // Capped the way the card caps its Watching row: a watch may name 200 targets, and all of them
  // flat pushes the rows this strip exists for out of the list's scroll box. What the condition has
  // already met goes first, so the three that survive are the ones worth the room — a stable sort,
  // so the watch's own order holds within each group.
  const targets = watch.targets
    .filter((t) => t.state !== 'GONE')
    .sort((a, b) => Number(a.state !== 'SATISFIED') - Number(b.state !== 'SATISFIED'));
  const shown = targets.slice(0, SHOWN_TARGETS);
  const hidden = targets.length - shown.length;
  return (
    <dl className="watch-facts watch-strip-block" data-watch-id={watch.id}>
      <dt>{STRIP_UNTIL}</dt>
      <dd>{until}</dd>
      <dt>Progress</dt>
      <dd>{`${describeProgress(progressOf(watch), thresholdOf(watch.predicate, watch.targets))} · checked ${ago(watch.lastEvaluatedAt, now)}`}</dd>
      <dt>Watching</dt>
      <dd className="watch-targets">
        {shown.map((t) => (
          <WatchTargetLink
            key={`${t.targetKind}:${t.targetResourceId}`}
            kind={t.targetKind}
            id={t.targetResourceId}
            // Only the satisfied ones are worded: a word on every unmet target is the Progress row
            // read out one row per target, which says nothing while they are all the same.
            state={t.state === 'SATISFIED' ? t.state : undefined}
          />
        ))}
        {hidden > 0 && (
          <Link className="watch-strip-more" to={watchHref(watch.id)}>
            +{hidden} more
          </Link>
        )}
      </dd>
      {showsThen && (
        <>
          <dt>Then</dt>
          <dd>{STRIP_THEN}</dd>
        </>
      )}
      <dt>Expires</dt>
      <dd>
        {expiry ? expiry.text : ''}
        {expiry && <span className="watch-muted"> · {absTime(watch.expiresAt)}</span>}
      </dd>
    </dl>
  );
}
