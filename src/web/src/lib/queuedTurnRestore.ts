import { parseBackgroundWake } from './backgroundWake';
import { wakeupsOnly } from './bgJobCard';
import { parseSubagentFinished } from './subagentFinished';
import { parseWatchWake } from './watches';

/** What of a queued turn decides whether its words go back to the composer. */
export interface QueuedTurnOrigin {
  content: string;
  authoredByOrbit?: true;
  openItemDelivery?: unknown;
  projectStarted?: unknown;
  sessionMessage?: unknown;
}

/**
 * Whether a turn taken off the queue unrun — withdrawn, or dropped by a Stop — hands its words back to
 * the composer: only when the reader typed them. Not a turn the control plane says it wrote itself
 * (`authoredByOrbit`: an acceptance round, a task's brief, a coordinator's delivery …), not the
 * wakes and deliveries the queue draws as their cards, which say so by their shape where the server
 * predates that flag, and not another Orbit session's message (`sessionMessage`): somebody typed
 * that, but not the reader. Handed back, those put text written for the agent — or by another one —
 * in the composer as though the reader had typed it, one press from being sent again in their name.
 *
 * The same rule on iOS and macOS: OrbitKit's `ComposerLogic.restorableText`.
 */
export function returnsToComposer(turn: QueuedTurnOrigin): boolean {
  return !turn.authoredByOrbit
    && !turn.openItemDelivery
    && !turn.projectStarted
    && !turn.sessionMessage
    && !parseWatchWake(turn.content)
    && !parseBackgroundWake(turn.content)
    && !parseSubagentFinished(turn.content);
}

/**
 * Whether a queued turn is a wake a watch queued, which is withdrawn rather than cancelled: the watch
 * dead-letters it and never sends it again (WorkspaceView's `QueuedTurnMeta`, `withdrawWake`). Never
 * another Orbit session's message, whatever its words look like — they are that session's to choose,
 * and the transcript draws it as their message first.
 */
export function isQueuedWatchWake(turn: QueuedTurnOrigin): boolean {
  return !turn.sessionMessage && parseWatchWake(turn.content) !== null;
}

/**
 * The SubAgent runs a queued turn tells the agent ended (`<orbit-subagent-finished>`), or none for any other
 * turn. Each run's card says the turn is waiting and offers `Don't send` (SubagentCardEnd); the queued tail
 * draws it only when it also carries a background job's news, which is that tail's to show.
 */
export function queuedSubagentWake(turn: QueuedTurnOrigin): { runIds: string[]; alone: boolean } | null {
  if (turn.sessionMessage) return null;
  const wake = parseSubagentFinished(turn.content);
  if (!wake) return null;
  // A job's news beside it draws nothing in the tail either (`queuedJobWake`); a wakeup coming due still does.
  return { runIds: wake.runs.map((run) => run.runId), alone: wakeupsOnly(parseBackgroundWake(wake.rest)) === null };
}
