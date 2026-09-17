import { Link } from 'react-router-dom';
import type { ReferencedTask } from '../lib/referencedTask';
import { TaskStatusPill } from './TaskStatusPill';

/**
 * The tasks a person named with `#`, as cards rather than as the block's own plain-text table
 * (lib/referencedTask `parseReferencedTasks`).
 *
 * It stays inside the folded entry under their words — the block is context appended to their
 * message, not a turn of its own, so it never becomes a card of the transcript's own the way a wake
 * does (BackgroundWakeCard). What changes is only what opening the fold shows.
 *
 * The one thing worth the most here is the id: it sits in the block's opening tag, where a reader
 * could see it and not click it. A card's title is the link, so the task they referenced is one
 * click from the message that referenced it.
 *
 * Every value is the block's own — the status name, what the status line says after it, the list
 * and the assignee, and how the last run came out. Only the counting is this end's own words, since
 * "共 1 次" is a sentence rather than a value; OrbitKit says it in exactly the same ones
 * (`ReferencedTaskNote`, held there by ReferencedTaskCopyParityTests).
 */
export function ReferencedTaskNote({ tasks }: { tasks: ReferencedTask[] }) {
  return (
    <ul className="reftask">
      {tasks.map((task) => (
        <li className="reftask-task" key={task.id}>
          <div className="reftask-head">
            <TaskStatusPill status={task.status} />
            {/* `DONE · 验收任务`: what kind of task it is, which its lifecycle does not say. */}
            {task.suffixes.map((suffix) => (
              <span className="reftask-suffix" key={suffix}>
                {suffix}
              </span>
            ))}
            {/* The title is the row, and the row is the link — the id is under it for reading. */}
            <Link className="reftask-title" to={`/tasks/${task.id}`}>
              {task.title}
            </Link>
            {outcome(task) && <span className="reftask-outcome">{outcome(task)}</span>}
          </div>
          <div className="reftask-meta">{meta(task)}</div>
        </li>
      ))}
    </ul>
  );
}

/** How the last run came out, in the block's own words. Nothing for a task nothing has run. */
function outcome(task: ReferencedTask): string {
  return task.runs === 0 ? '' : task.lastRun;
}

/** "34OEE9MQXMEm0h0Ptm1GG · (无列表) · orbit · 1 run" — the ids, under the title they belong to. */
function meta(task: ReferencedTask): string {
  return `${task.id} · ${task.list} · ${task.assignee} · ${runs(task)}`;
}

/**
 * "1 run", or "1 run, 0 with turns" where they differ.
 *
 * The second number is the evidence question the block answers up front — a session that exists and
 * has never taken a turn is the difference between work that stalled and work that was never done —
 * and it is worth a reader's attention exactly when it does not match the first.
 */
function runs(task: ReferencedTask): string {
  if (task.runs === 0) return 'never run';
  const counted = task.runs === 1 ? '1 run' : `${task.runs} runs`;
  return task.executed === task.runs ? counted : `${counted}, ${task.executed} with turns`;
}
