import { Fragment, useEffect, useState } from 'react';
import { CheckSquareOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  createdTasksCountLine,
  SESSION_CREATED_TASKS_COPY as COPY,
  sessionTaskCard,
  toUuid,
  type SessionCreatedTaskCounts,
  type WatchView,
} from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { pageHref } from '../lib/orbitLink';
import { sessionCreatedTasksQuery, watchesQuery } from '../lib/queries';
import { isLiveWatch, stripStaleLine, waitsBeyondTasks, watchedTasks, watchesFollowing } from '../lib/watches';
import { TaskStatusPill } from './TaskStatusPill';
import { relTime } from './Transcript';
import { useNow } from './WatchParts';

/**
 * The session's Tasks card, above the composer between Background processes and the branch bar: the
 * tasks this session's agent created (`GET /sessions/:id/created-tasks`) and the tasks its live
 * watches wait on, one row each, folded to one line and opened to a list — so a task a confirmation
 * card filed does not scroll out of reach with the conversation. A watched row carries an eye
 * (orange while its watch goes unchecked) and comes first; one created elsewhere says so where its
 * age would be. Drawn in the Background processes tray's own shell (`.bg-tray`) with the task list's
 * status pill; the mock is docs/mocks/session-tasks-watch-merge-ios.png.
 *
 * The created rows are drawn as served. The server has already sorted them and drawn a task another
 * one took over as the one doing the work, with `replaces` naming the original, and its tallies count
 * those same rows — so re-sorting or re-reading them here is how the pills and the sentence would
 * stop agreeing. `sessionTaskCard` only lifts the watched ones to the top.
 */
export function SessionCreatedTasksStrip({
  sessionId,
  openRequest = 0,
}: {
  sessionId: string;
  /** Bumped to open the list from elsewhere on the page — the start card's "View tasks". */
  openRequest?: number;
}) {
  const { data } = useQuery(sessionCreatedTasksQuery(sessionId));
  const watchesQ = useQuery(watchesQuery());
  const now = useNow();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  const waitingOn = watchesFollowing(rowsOf(watchesQ.data), sessionId).filter(isLiveWatch);
  // Nothing created or waited on, nothing drawn. Once something is, the row stays — finished or
  // not, it is the list of what this conversation produced.
  const card = sessionTaskCard(data, watchedTasks(waitingOn, now));
  if (!card) return null;
  // A watch the Watching strip doesn't draw says here when nobody is checking it.
  const staleLines = [
    ...new Set(
      waitingOn
        .filter((w) => !waitsBeyondTasks(w))
        .map((w) => stripStaleLine(w, now))
        .filter((line): line is string => line !== null),
    ),
  ];
  // One task is named rather than counted, as the Watching row names its one target.
  const single = card.counts.total === 1 && card.rows.length === 1 ? card.rows[0] : undefined;
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`bg-tray${open ? ' bg-open' : ''}`}>
      <div className="bg-tray-row" onClick={toggle}>
        <CheckSquareOutlined className="bg-tray-ico" />
        <span className="bg-tray-title ct-head">{COPY.title}</span>
        {single ? (
          <>
            <span className="ct-one" title={single.title}>
              {single.title}
            </span>
            {single.watched && <WatchEye stale={single.stale} />}
            {single.standing && <TaskStatusPill {...single.standing} />}
          </>
        ) : (
          <>
            {card.watching > 0 && (
              <span className={`ct-watching${card.stale ? ' is-stale' : ''}`} title="Watched by this session">
                <EyeOutlined /> {card.watching}
              </span>
            )}
            <span className="bg-tray-count ct-count">
              <CountLine counts={card.counts} />
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
          aria-label={open ? 'Hide tasks' : 'Show tasks'}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <>
          <div className="ct-list">
            {staleLines.map((line) => (
              <div key={line} className="watch-say">
                <span className="watch-say-stale">{line}</span>
              </div>
            ))}
            {card.rows.map((row) => (
              <Link key={row.id} className="ct-row" to={pageHref({ kind: 'task', id: toUuid(row.id) })}>
                <span className="ct-pill">{row.standing && <TaskStatusPill {...row.standing} />}</span>
                <span className="ct-eye">{row.watched && <WatchEye stale={row.stale} />}</span>
                <span className="ct-title" title={row.title}>
                  {row.title}
                  {row.replaces && (
                    <span className="ct-replaces">{` · ${COPY.replacesPrefix}${row.replaces.title}`}</span>
                  )}
                </span>
                <span className="ct-age">{row.createdAt ? relTime(row.createdAt) : COPY.elsewhere}</span>
                <span className="ct-caret">›</span>
              </Link>
            ))}
          </div>
          {/* Only watched tasks, none created here: nothing for the links to open. */}
          {data && data.total > 0 && (
            <div className="ct-foot">
              <Link to={`/tasks?createdIn=${encodeId(sessionId)}`}>{COPY.viewAll}</Link>
              {data.projects.map((project) => (
                <Link
                  key={project.id}
                  to={pageHref({ kind: 'project', id: toUuid(project.id) })}
                  title={project.title}
                >
                  {COPY.openProject}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const rowsOf = (data: unknown): WatchView[] => (Array.isArray(data) ? (data as WatchView[]) : []);

/** A watched row's eye: this session waits on the task; orange while that watch goes unchecked. */
function WatchEye({ stale }: { stale: boolean }) {
  return <EyeOutlined className={`ct-eye-ico${stale ? ' is-stale' : ''}`} aria-label="Watching" />;
}

/** The shared sentence, with its `N failed` part in red. The Watching strip writes it too. */
export function CountLine({ counts }: { counts: SessionCreatedTaskCounts }) {
  const failed = `${counts.failed} failed`;
  return (
    <>
      {createdTasksCountLine(counts)
        .split(' · ')
        .map((part, index) => (
          <Fragment key={part}>
            {index > 0 && ' · '}
            {part === failed ? <span className="ct-failed">{part}</span> : part}
          </Fragment>
        ))}
    </>
  );
}
