import { Fragment, useEffect, useState } from 'react';
import { CheckSquareOutlined, EyeOutlined, LoadingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  createdTasksCountLine,
  SESSION_CREATED_TASKS_COPY as COPY,
  sessionTaskBand,
  sessionTaskCard,
  toUuid,
  type SessionCreatedTaskCounts,
  type SessionCreatedTasks,
  type WatchView,
} from '@orbit/shared';
import { pageHref } from '../lib/orbitLink';
import { watchesQuery } from '../lib/queries';
import { isLiveWatch, taskStaleLines, watchedTasks, watchesFollowing } from '../lib/watches';
import { TaskStatusPill } from './TaskStatusPill';
import { relTime } from './Transcript';
import { useNow } from './WatchParts';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from './ui/Tooltip';

/**
 * The session's Tasks card, above the composer between Background processes and the branch bar: the
 * tasks this session's agent created (`GET /sessions/:id/created-tasks`) and the tasks its live
 * watches wait on, directly or through their run sessions (`watchedTasks`), one row each, folded to
 * one line and opened to a list — so a task a confirmation card filed does not scroll out of reach
 * with the conversation. Folded past one task it reads as the Agents line does (`sessionTaskBand`):
 * the newest running task, or the count and the newest task, with that task's pill; a red
 * `N failed` leads while any failed. A watched row carries an eye
 * (orange while its watch goes unchecked) and comes first; one created elsewhere says so where its
 * age would be. Drawn in the Background processes tray's own shell (`.bg-tray`) with the task list's
 * status pill; the mock is docs/mocks/session-tasks-watch-merge-ios.png.
 *
 * The created rows are drawn as served. The server has already sorted them and drawn a task another
 * one took over as the one doing the work, with `replaces` naming the original, and its tallies count
 * those same rows — so re-sorting or re-reading them here is how the pills and the sentence would
 * stop agreeing. `sessionTaskCard` only lifts the watched ones to the top.
 *
 * The rows are the page's read (`sessionCreatedTasksQuery`, which the session page owns and hands in
 * as `tasks`), so the strip adds no read of its own: one read serves the page.
 */
export function SessionCreatedTasksStrip({
  sessionId,
  tasks: data,
  openRequest = 0,
}: {
  sessionId: string;
  /** The session's created tasks, as the page read them; undefined until that read answers. */
  tasks: SessionCreatedTasks | undefined;
  /** Bumped to open the list from elsewhere on the page — the start card's "View tasks". */
  openRequest?: number;
}) {
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
  const staleLines = taskStaleLines(waitingOn, now);
  // One task is named rather than counted, as the Watching row names its one target.
  const single = card.counts.total === 1 && card.rows.length === 1 ? card.rows[0] : undefined;
  // More than one: what is running, or the newest task and how it stands, as the Agents line says it.
  const band = sessionTaskBand(card);
  const pill = single ? single.standing : band?.row.standing;
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`bg-tray${open ? ' bg-open' : ''}`}>
      <div className="bg-tray-row" onClick={toggle}>
        <CheckSquareOutlined className="bg-tray-ico" />
        <span className="bg-tray-title ct-head">{COPY.title}</span>
        {single ? (
          <>
            <Tooltip content={single.title} truncatedOnly>
              <span className="ct-one">
                {single.title}
              </span>
            </Tooltip>
            {single.watched && <WatchEye stale={single.stale} />}
          </>
        ) : (
          <>
            {card.watching > 0 && (
              <Tooltip content="Watched by this session" delay={TEXT_TOOLTIP_DELAY_MS}>
                <span className={`ct-watching${card.stale ? ' is-stale' : ''}`}>
                  <EyeOutlined /> {card.watching}
                </span>
              </Tooltip>
            )}
            {band && (
              <>
                <Tooltip content={band.row.title} delay={TEXT_TOOLTIP_DELAY_MS}>
                  <span className="bg-tray-count ct-count">
                    {band.failed > 0 && (
                      <>
                        <span className="ct-failed">{`${band.failed} failed`}</span>
                        {' · '}
                      </>
                    )}
                    {band.text}
                  </span>
                </Tooltip>
              </>
            )}
          </>
        )}
        <span className="wt-spacer" />
        {/* The pill sits at the right edge, as the Agents line's failed count and the branch bar's state do. A running
            task shows the spinner alone, in the same column as the Agents and Background rows. */}
        {pill &&
          (pill.running ? (
            <LoadingOutlined spin className="chat-tool-status running" aria-label="Running" />
          ) : (
            <TaskStatusPill {...pill} />
          ))}
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
              <Link key={row.id} className="ct-row" data-row-focus="" to={pageHref({ kind: 'task', id: toUuid(row.id) })}>
                <span className="ct-pill">{row.standing && <TaskStatusPill {...row.standing} />}</span>
                <span className="ct-eye">{row.watched && <WatchEye stale={row.stale} />}</span>
                <Tooltip content={row.title} truncatedOnly>
                  <span className="ct-title">
                    {row.title}
                    {row.replaces && (
                      <span className="ct-replaces">{` · ${COPY.replacesPrefix}${row.replaces.title}`}</span>
                    )}
                  </span>
                </Tooltip>
                <span className="ct-age">{row.createdAt ? relTime(row.createdAt) : COPY.elsewhere}</span>
                <span className="ct-caret">›</span>
              </Link>
            ))}
          </div>
          {/* Only the projects its tasks belong to; none, and there is no foot. */}
          {data && data.projects.length > 0 && (
            <div className="ct-foot">
              {data.projects.map((project) => (
                <Tooltip key={project.id} content={project.title} align="start">
                  <Link
                    to={pageHref({ kind: 'project', id: toUuid(project.id) })}
                  >
                    {COPY.openProject}
                  </Link>
                </Tooltip>
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
