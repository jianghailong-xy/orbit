import { useContext, useState, type ReactNode } from 'react';
import { PlayCircleFilled, SafetyCertificateOutlined } from '@ant-design/icons';
import type { TaskStartCard as Card } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import {
  TASK_START_AUTO_LABEL,
  TASK_START_CRITERIA_HEADING,
  TASK_START_HIDE_COMMAND,
  TASK_START_HIDE_DETAILS,
  TASK_START_INSTRUCTIONS_HEADING,
  TASK_START_JUDGED_BY,
  TASK_START_LABEL,
  TASK_START_OPEN_TASK,
  TASK_START_RAW_SUMMARY,
  TASK_START_SHOW_COMMAND,
  TASK_START_SHOW_DETAILS,
  taskStartFoldsDescription,
  taskStartHasDetails,
  taskStartJudgedHow,
} from '../lib/taskStartCard';
import { AppLink } from './AppLink';
import { ExportCtx, MD, relTime } from './Transcript';

/**
 * The turn that starts a task's run, drawn as the task it was built from — instead of the whole
 * brief in the account owner's own bubble.
 *
 * The brief is written for the AGENT: the task's description and criteria, then four steps of
 * protocol about which tools to call and which statuses never to write. A person reading the
 * conversation wants the first half and none of the second, so the card draws the task (its title,
 * its project, the start of its description, how it will be judged) and folds the rest behind Show
 * details. The protocol is not on the card at all: the brief is one disclosure away at the bottom,
 * verbatim.
 *
 * Drawn from the payload the control plane recorded beside the echo (`taskStart`, read by
 * lib/taskStartCard), never out of the brief's text.
 */
export function TaskStartCard({
  card,
  text,
  seq,
  ts,
  undelivered,
  attachments,
  attached,
}: {
  card: Card;
  /** The brief the agent was handed, verbatim — the record this card is drawn from. */
  text: string;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The task's inputs the turn carried (images, files), drawn under the description. */
  attachments?: ReactNode;
  /** Whatever else delivery appended to the same turn, as its own folded entry. */
  attached?: ReactNode;
}) {
  // An export is read on paper, where nothing can be opened: it gets the card open.
  const exporting = useContext(ExportCtx) != null;
  const [shown, setShown] = useState(false);
  const [wholeCommand, setWholeCommand] = useState(false);
  const open = shown || exporting;
  const judged = card.completionCriterion ? TASK_START_JUDGED_BY[card.completionCriterion] : null;
  const how = taskStartJudgedHow(card);
  const command = card.completionCriterion === 'EXECUTABLE' ? card.acceptanceCommand : null;
  const taskPublic = routeId(card.taskId);
  const taskHref = taskPublic ? `/tasks/${encodeURIComponent(taskPublic)}` : null;
  const projectPublic = card.project ? routeId(card.project.id) : null;
  const projectHref = projectPublic ? `/projects/${encodeURIComponent(projectPublic)}` : null;
  return (
    <div className="tsc-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes, the
          way it names every other card that is nobody's message. */}
      <div className="tsc" data-seq={seq} data-sticky-label={TASK_START_LABEL} data-sticky-text={card.title}>
        <div className="tsc-head">
          <span className="tsc-mark"><PlayCircleFilled /></span>
          <span>{TASK_START_LABEL}</span>
          {card.auto && <span className="tsc-auto">{TASK_START_AUTO_LABEL}</span>}
        </div>
        <div className="tsc-title">{card.title}</div>
        {card.project && (
          <div className="tsc-where">
            Project{' '}
            {projectHref ? <AppLink to={projectHref}>{card.project.title}</AppLink> : card.project.title}
          </div>
        )}
        {card.description && (
          <div className={`tsc-desc${!open && taskStartFoldsDescription(card) ? ' is-folded' : ''}`}>
            <MD breaks>{card.description}</MD>
          </div>
        )}
        {attachments}
        {open && card.acceptanceCriteria && (
          <>
            <div className="tsc-section">{TASK_START_CRITERIA_HEADING}</div>
            {/* As written, the way the task page shows it: criteria are checks, not documents, and
                their globs (`RunnerEngines*`) and paths read as emphasis when parsed as Markdown. */}
            <div className="tsc-body tsc-plain">{card.acceptanceCriteria}</div>
          </>
        )}
        {open && card.listInstructions && (
          <>
            <div className="tsc-section">{TASK_START_INSTRUCTIONS_HEADING}</div>
            <div className="tsc-body"><MD breaks>{card.listInstructions}</MD></div>
          </>
        )}
        {judged && (
          <div className="tsc-judged">
            <div className="tsc-judged-line"><SafetyCertificateOutlined /> {judged}</div>
            {how && <div className="tsc-judged-how">{how}</div>}
            {command && (
              <pre className={`tsc-command${open && wholeCommand ? '' : open ? ' is-clamped' : ' is-one-line'}`}>
                {command}
              </pre>
            )}
            {command && open && !exporting && (
              <button type="button" className="tsc-more" onClick={() => setWholeCommand(!wholeCommand)}>
                {wholeCommand ? TASK_START_HIDE_COMMAND : TASK_START_SHOW_COMMAND}
              </button>
            )}
          </div>
        )}
        <div className="tsc-links">
          {taskStartHasDetails(card) && !exporting && (
            <button type="button" className="tsc-more" onClick={() => setShown(!shown)}>
              {shown ? TASK_START_HIDE_DETAILS : TASK_START_SHOW_DETAILS}
            </button>
          )}
          {taskHref && <AppLink to={taskHref}>{TASK_START_OPEN_TASK}</AppLink>}
        </div>
        <div className="tsc-meta">
          Task {taskPublic ?? card.taskId}
          {ts ? ` · ${relTime(ts)}` : ''}
        </div>
        {undelivered && (
          <div className="tsc-undelivered">The session has not confirmed it received this.</div>
        )}
        {attached}
        <details className="tsc-raw" open={exporting || undefined}>
          <summary>{TASK_START_RAW_SUMMARY}</summary>
          <pre>{text}</pre>
        </details>
      </div>
    </div>
  );
}
