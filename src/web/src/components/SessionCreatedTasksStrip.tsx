import { Fragment, useState } from 'react';
import { CheckSquareOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  createdTasksCountLine,
  SESSION_CREATED_TASKS_COPY as COPY,
  toUuid,
  type SessionCreatedTaskCounts,
} from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { pageHref } from '../lib/orbitLink';
import { sessionCreatedTasksQuery } from '../lib/queries';
import { TaskStatusPill } from './TaskStatusPill';
import { relTime } from './Transcript';

/**
 * "Tasks created here", above the composer between Background processes and the branch bar: the
 * tasks this session's agent created (`GET /sessions/:id/created-tasks`), folded to one line and
 * opened to a list — so a task a confirmation card filed does not scroll out of reach with the
 * conversation. Drawn in the Background processes tray's own shell (`.bg-tray`) with the task
 * list's status pill; the mock is docs/mocks/session-created-tasks-strip-web.html.
 *
 * The rows are drawn as served. The server has already sorted them and drawn a task another one
 * took over as the one doing the work, with `replaces` naming the original, and its tallies count
 * those same rows — so re-sorting or re-reading them here is how the pills and the sentence would
 * stop agreeing.
 */
export function SessionCreatedTasksStrip({ sessionId }: { sessionId: string }) {
  const { data } = useQuery(sessionCreatedTasksQuery(sessionId));
  const [open, setOpen] = useState(false);
  // Nothing created, nothing drawn. Once something is, the row stays — finished or not, it is the
  // list of what this conversation produced.
  if (!data?.total) return null;
  // One task is named rather than counted, as the Watching row names its one target.
  const single = data.total === 1 ? data.items[0] : undefined;
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
            <TaskStatusPill status={single.status} running={single.running} queued={single.queued} />
          </>
        ) : (
          <span className="bg-tray-count ct-count">
            <CountLine counts={data} />
          </span>
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
            {data.items.map((row) => (
              <Link key={row.id} className="ct-row" to={pageHref({ kind: 'task', id: toUuid(row.id) })}>
                <span className="ct-pill">
                  <TaskStatusPill status={row.status} running={row.running} queued={row.queued} />
                </span>
                <span className="ct-title" title={row.title}>
                  {row.title}
                  {row.replaces && (
                    <span className="ct-replaces">{` · ${COPY.replacesPrefix}${row.replaces.title}`}</span>
                  )}
                </span>
                <span className="ct-age">{relTime(row.createdAt)}</span>
                <span className="ct-caret">›</span>
              </Link>
            ))}
          </div>
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
        </>
      )}
    </div>
  );
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
