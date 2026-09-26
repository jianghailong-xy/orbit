import { parseBackgroundWake } from './backgroundWake';
import { parseWatchWake } from './watches';

/** What of a queued turn decides whether its words go back to the composer. */
export interface QueuedTurnOrigin {
  content: string;
  authoredByOrbit?: true;
  openItemDelivery?: unknown;
  projectStarted?: unknown;
}

/**
 * Whether a turn taken off the queue unrun — withdrawn, or dropped by a Stop — hands its words back to
 * the composer: only when somebody typed them. Not a turn the control plane says it wrote itself
 * (`authoredByOrbit`: an acceptance round, a task's brief, a coordinator's delivery …), and not the
 * wakes and deliveries the queue draws as their cards, which say so by their shape where the server
 * predates that flag. Handed back, those put text written for the agent in the composer as though the
 * reader had typed it, one press from being sent again in their name.
 *
 * The same rule on iOS and macOS: OrbitKit's `ComposerLogic.restorableText`.
 */
export function returnsToComposer(turn: QueuedTurnOrigin): boolean {
  return !turn.authoredByOrbit
    && !turn.openItemDelivery
    && !turn.projectStarted
    && !parseWatchWake(turn.content)
    && !parseBackgroundWake(turn.content);
}
