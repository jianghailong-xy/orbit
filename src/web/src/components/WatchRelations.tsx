import { useMemo, useState } from 'react';
import { EyeOutlined, LoadingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WatchTargetView, WatchView } from '@orbit/shared';
import { watchesQuery } from '../lib/queries';
import {
  SESSION_TARGET_WORDS,
  STRIP_LABEL,
  STRIP_MANAGE,
  STRIP_OPEN_SESSION,
  STRIP_OPEN_TASK,
  ago,
  describeCondition,
  describeProgress,
  expiryLabel,
  isLiveWatch,
  progressOf,
  stripCounts,
  stripLine,
  stripStaleLine,
  targetHref,
  targetName,
  targetNoun,
  waitsBeyondTasks,
  watchBucket,
  watchHref,
  watchProblem,
  watchesFollowedBy,
  watchesFollowing,
} from '../lib/watches';
import { CountLine } from './SessionCreatedTasksStrip';
import { TaskStatusPill } from './TaskStatusPill';
import { WatchEditorModal } from './WatchEditor';
import { ObserverLink, WatchStatePill, useNow } from './WatchParts';
import { Button } from './ui/Button';
import { Popover } from './ui/Popover';

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
          side="bottom"
          align="start"
          title="This session is waiting on"
          popupClassName="watch-popover"
          trigger={
            <button type="button" className="watch-chip">
              <EyeOutlined /> Following {targets} {targetNoun(waitingOn, targets)}
            </button>
          }
        >
          <WatchRowList watches={waitingOn} />
        </Popover>
      )}
      {watchedBy.length > 0 && (
        <Popover
          side="bottom"
          align="start"
          title="Watches on this session"
          popupClassName="watch-popover"
          trigger={
            <button type="button" className="watch-chip is-quiet">
              Followed by {watchedBy.length}
            </button>
          }
        >
          <WatchRowList watches={watchedBy} />
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
 * Above the composer: the watches this session is waiting on beyond its tasks (a session, say), while
 * any is live — a task it waits on is an eye in the Tasks card instead — in the Background
 * processes tray's own shell (`.bg-tray`), so the stack above the composer reads as one system, the
 * way Tasks created here does. Always one line first: a lone target by name with where it stands, in
 * its own list's pill; several by what the wait needs, with Tasks created here's sentence over where
 * they stand. Opened, each watch lists its targets and only adds a freshness reminder when needed; a
 * lone target is already on the line, so it gets a way to it instead. Read-only: a wait is changed
 * by talking to the agent, and Pause/Stop live on the Following page. Its own card on purpose — a watch is not a
 * process, and contract §9.2 keeps it out of the Background processes tray beside it.
 */
export function SessionWatchStrip({ sessionId }: { sessionId: string }) {
  const watchesQ = useQuery(watchesQuery());
  const now = useNow();
  const [open, setOpen] = useState(false);
  // Only what waits beyond tasks: a task the session waits on is an eye in its Tasks card.
  const waitingOn = watchesFollowing(rowsOf(watchesQ.data), sessionId)
    .filter(isLiveWatch)
    .filter(waitsBeyondTasks);
  if (waitingOn.length === 0) return null;
  const { live, single, targetLine } = stripLine(waitingOn);
  const toggle = () => setOpen((o) => !o);
  return (
    <div className={`bg-tray watch-strip${open ? ' bg-open' : ''}`}>
      <div className="bg-tray-row" onClick={toggle}>
        <EyeOutlined className="bg-tray-ico" />
        <span className="bg-tray-title ct-head">{STRIP_LABEL}</span>
        {single ? (
          <>
            <span className="ct-one" title={targetName(single)}>
              {targetName(single)}
            </span>
            <WatchTargetPill target={single} />
          </>
        ) : (
          <>
            <span className="watch-strip-target">{targetLine}</span>
            <span className="bg-tray-count ct-count">
              <CountLine counts={stripCounts(live)} />
            </span>
          </>
        )}
        <span className="wt-spacer" />
        <button
          type="button"
          className="wt-expand"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-label={open ? 'Hide what this session waits on' : 'Show what this session waits on'}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <>
          <div className="ct-list">
            {waitingOn.map((w) => (
              <StripWatch key={w.id} watch={w} now={now} listsTargets={!single} />
            ))}
          </div>
          <div className="ct-foot">
            {single && (
              <Link to={targetHref(single.targetKind, single.targetResourceId)}>
                {single.targetKind === 'SESSION' ? STRIP_OPEN_SESSION : STRIP_OPEN_TASK}
              </Link>
            )}
            <Link to="/following">{STRIP_MANAGE}</Link>
          </div>
        </>
      )}
    </div>
  );
}

/** The session run states' pill colours, as the app's pills use them (index.css `.status-pill`). */
const SESSION_TARGET_TONE: Record<string, string> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  AWAITING_INPUT: 'todo',
  INTERRUPTED: 'cancelled',
  SUCCEEDED: 'done',
  FAILED: 'failed',
  ENDED: 'cancelled',
};

/**
 * Where a target itself stands, in the pill its own list uses: a task's `TaskStatusPill`, so one task
 * reads the same word and colour on this strip, in Tasks created here and in the task list; a session
 * by its run state, in its header's word. Nothing when the watch carries no standing for it.
 */
function WatchTargetPill({ target }: { target: WatchTargetView }) {
  const standing = target.targetStatus;
  if (!standing) return null;
  if (target.targetKind === 'TASK') {
    return <TaskStatusPill status={standing.status} running={standing.running} queued={standing.queued} />;
  }
  const tone = SESSION_TARGET_TONE[standing.status] ?? 'cancelled';
  return (
    <span className={`status-pill ${tone}`}>
      {tone === 'running' ? <LoadingOutlined spin /> : <span className="status-dot" />}
      {SESSION_TARGET_WORDS[standing.status] ?? standing.status}
    </span>
  );
}

/**
 * One watch in the opened strip: its targets and the line it adds when nobody is checking it; when
 * the line above names no one target, each target opens its own page. What
 * the condition has already met goes first, a stable sort, so the watch's own order holds within each
 * group.
 */
function StripWatch({ watch, now, listsTargets }: { watch: WatchView; now: number; listsTargets: boolean }) {
  const stale = stripStaleLine(watch, now);
  const targets = watch.targets
    .filter((t) => t.state !== 'GONE')
    .sort((a, b) => Number(a.state !== 'SATISFIED') - Number(b.state !== 'SATISFIED'));
  return (
    <div className="watch-strip-watch" data-watch-id={watch.id}>
      {stale && (
        <div className="watch-say">
          <span className="watch-say-stale">{stale}</span>
        </div>
      )}
      {listsTargets &&
        targets.map((t) => (
          <Link
            key={`${t.targetKind}:${t.targetResourceId}`}
            className="ct-row"
            to={targetHref(t.targetKind, t.targetResourceId)}
          >
            <span className="ct-pill">
              <WatchTargetPill target={t} />
            </span>
            <span className="ct-title" title={targetName(t)}>
              {targetName(t)}
            </span>
            <span className="ct-caret">›</span>
          </Link>
        ))}
    </div>
  );
}
