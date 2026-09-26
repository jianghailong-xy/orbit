import { isDerivedUuid } from '../projects/project-dispatch-identity';
import { OPEN_ITEM_TURN_PREFIX, OWNER_ANSWER_TURN_PREFIX } from '../projects/project-open-item';
import { PROJECT_STARTED_TURN_PREFIX } from '../projects/project-started';
import { BACKGROUND_WAKE_TURN_PREFIX } from '../runner-api/background-job-wake';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';
import { TASK_RUN_TURN_PREFIX } from '../tasks/task-run-identity';
import { WATCH_TURN_KEY_PREFIX } from './watch-turn-key';

/**
 * Whether the control plane wrote this turn itself, rather than filing a message somebody sent.
 *
 * Every turn Orbit queues on its own account is keyed in a namespace of its own: a watch's wake, a
 * background job's or a due wakeup's, an exception item's delivery, the owner's answer as it is told
 * to a coordinator, a project's start, a task run's brief and each acceptance round. A coordinator's
 * wake delivery and a criteria decision's reply are keyed by `derivedUuid`, which no client mints.
 * Any other key is one the sender chose — the account owner's client, or an agent.
 *
 * The clients read it where they hand a turn's words back to the composer: a turn taken off the
 * queue unrun gives back what somebody typed, and nobody typed these (web `restorableQueuedText`,
 * OrbitKit `ComposerLogic.restorableText`).
 */
export function isOrbitAuthoredTurn(clientTurnId: string | null | undefined): boolean {
  if (!clientTurnId) return false;
  // Listed at the call rather than at load: `project-started` imports the sessions service, which
  // imports this, and a constant read mid-cycle is `undefined`.
  const prefixes = [
    WATCH_TURN_KEY_PREFIX,
    BACKGROUND_WAKE_TURN_PREFIX,
    OPEN_ITEM_TURN_PREFIX,
    OWNER_ANSWER_TURN_PREFIX,
    PROJECT_STARTED_TURN_PREFIX,
    TASK_RUN_TURN_PREFIX,
    TASK_ACCEPTANCE_CLIENT_TURN_PREFIX,
  ];
  return prefixes.some((prefix) => clientTurnId.startsWith(prefix)) || isDerivedUuid(clientTurnId);
}
