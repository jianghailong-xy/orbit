import { useState, type ReactNode } from 'react';
import { PlayCircleFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { ProjectStartedCard as Started } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { relTime } from './Transcript';

/**
 * The message telling a coordinator its project was started, drawn as a card — instead of a screen
 * of prose inside the reader's own bubble (design: docs/mocks/project-started-card.png).
 *
 * The prose is written for the AGENT: tool names, ids, `autoRunWhenReady`. A person watching the
 * conversation needs three facts from it — how the project was started, which project, and which of
 * its tasks now wait on the coordinator — and this draws those from the payload the control plane
 * recorded beside the turn (`ProjectStartedCard`, read by lib/projectStarted). The words the agent
 * read are one disclosure away at the foot, as on the exception item's card (`OpenItemDeliveryCard`),
 * whose shape this is, in the brand tone: nothing here failed.
 *
 * Every word is shared with the native card (OrbitKit `ProjectStartedCard`), and
 * `ProjectStartedCopyParityTests.swift` reads the declarations below to hold the two to it.
 */

/** The card's name for each way a project is started. */
export const PROJECT_STARTED_LABEL = 'Project started';
export const PROJECT_SWITCHED_ON_LABEL = 'Project switched on';
/** The chip beside it: what the press was. */
export const PROJECT_STARTED_KIND_CONFIRMATION = 'Criteria confirmed';
export const PROJECT_STARTED_KIND_SWITCH = 'Automatic on';
/** What the card says when no task waits on the coordinator. */
export const PROJECT_STARTED_NONE_HELD = 'Every open task starts on its own.';
export const PROJECT_STARTED_NOTIFICATION = 'a notification, not an interruption';
export const PROJECT_STARTED_TOLD = 'What the coordinator was told';
export const PROJECT_STARTED_SHOW_FEWER = 'Show fewer';
/** How many waiting tasks the card lists before folding the rest away. */
export const PROJECT_STARTED_TASKS_SHOWN = 3;

export function projectStartedLabel(by: Started['by']): string {
  return by === 'CONFIRMATION' ? PROJECT_STARTED_LABEL : PROJECT_SWITCHED_ON_LABEL;
}

export function projectStartedKind(by: Started['by']): string {
  return by === 'CONFIRMATION' ? PROJECT_STARTED_KIND_CONFIRMATION : PROJECT_STARTED_KIND_SWITCH;
}

/** The line over the waiting tasks. */
export function projectStartedHeldLead(count: number): string {
  return count === 1
    ? `1 task is set to start by hand, so it waits for the coordinator:`
    : `${count} tasks are set to start by hand, so they wait for the coordinator:`;
}

/** Who started it and how, as the foot line opens. */
export function projectStartedBy(card: Pick<Started, 'by' | 'criteriaCount'>): string {
  if (card.by === 'SWITCH') return `Switched on by you`;
  if (card.criteriaCount === null) return `Started by you`;
  return card.criteriaCount === 1
    ? `Started by you, confirming 1 criterion`
    : `Started by you, confirming ${card.criteriaCount} criteria`;
}

export function projectStartedShowMore(count: number): string {
  return `Show ${count} more`;
}

/** The waiting tasks beyond the ones the message listed, which only the project page names. */
export function projectStartedMoreInProject(count: number): string {
  return `${count} more in the project ↗`;
}

export function ProjectStartedCard({
  card,
  text,
  seq,
  ts,
  undelivered = false,
  queued,
}: {
  card: Started;
  /** The words the agent was handed, verbatim — the record this card is drawn from. */
  text: string;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The queue's own line, while the turn still waits behind a running one. */
  queued?: ReactNode;
}) {
  const [allTasks, setAllTasks] = useState(false);
  const label = projectStartedLabel(card.by);
  const tasks = allTasks ? card.held : card.held.slice(0, PROJECT_STARTED_TASKS_SHOWN);
  const folded = card.held.length - PROJECT_STARTED_TASKS_SHOWN;
  const unlisted = card.heldCount - card.held.length;
  // Out of a payload read defensively, so through the codec that degrades on a spelling it does
  // not know instead of the one that throws: a card must not take the transcript down with it.
  const projectPublic = routeId(card.projectId);
  const projectHref = projectPublic ? `/projects/${encodeURIComponent(projectPublic)}` : null;
  return (
    <div className="psc-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes, as
          it does an exception item's card: it is nobody's message, so it has no text of its own. */}
      <div
        className={`psc${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={label}
        data-sticky-text={card.projectTitle}
      >
        <div className="psc-head">
          <span className="psc-mark"><PlayCircleFilled /></span>
          <span>{label}</span>
          <span className="psc-kind">{projectStartedKind(card.by)}</span>
        </div>
        <div className="psc-title">{card.projectTitle}</div>
        {card.heldCount === 0 ? (
          <div className="psc-lead">{PROJECT_STARTED_NONE_HELD}</div>
        ) : (
          <>
            <div className="psc-lead">{projectStartedHeldLead(card.heldCount)}</div>
            {tasks.length > 0 && (
              <ul className="psc-tasks">
                {tasks.map((task) => {
                  const taskPublic = routeId(task.id);
                  return (
                    <li key={task.id}>
                      {taskPublic
                        ? <Link to={`/tasks/${encodeURIComponent(taskPublic)}`}>{task.title}</Link>
                        : task.title}
                    </li>
                  );
                })}
              </ul>
            )}
            {folded > 0 && (
              <button className="psc-more" onClick={() => setAllTasks(!allTasks)}>
                {allTasks ? PROJECT_STARTED_SHOW_FEWER : projectStartedShowMore(folded)}
              </button>
            )}
            {unlisted > 0 && projectHref && (allTasks || folded <= 0) && (
              <div className="psc-unlisted">
                <Link to={projectHref}>{projectStartedMoreInProject(unlisted)}</Link>
              </div>
            )}
          </>
        )}
        <div className="psc-meta">
          {projectStartedBy(card)} · {PROJECT_STARTED_NOTIFICATION}
          {ts ? ` · ${relTime(ts)}` : ''}
        </div>
        {undelivered && (
          <div className="psc-undelivered">The session has not confirmed it received this.</div>
        )}
        <details className="psc-raw">
          <summary>{PROJECT_STARTED_TOLD}</summary>
          <pre>{text}</pre>
        </details>
        {queued && <div className="psc-queued">{queued}</div>}
      </div>
    </div>
  );
}
