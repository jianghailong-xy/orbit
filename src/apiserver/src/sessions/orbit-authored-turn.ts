import { RUN_QUESTION_PREFIX } from './run-question';
import { derivedUuid, isDerivedUuid } from '../projects/project-dispatch-identity';
import { OPEN_ITEM_TURN_PREFIX, OWNER_ANSWER_TURN_PREFIX } from '../projects/project-open-item';
import { PROJECT_STARTED_TURN_PREFIX } from '../projects/project-started';
import { BACKGROUND_WAKE_TURN_PREFIX } from '../runner-api/background-job-wake';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';
import { TASK_RUN_TURN_PREFIX } from '../tasks/task-run-identity';
import {
  AUTO_RETRY_ORBIT_TURN_KEY_PREFIX,
  CONFIRMATION_RETURN_TURN_KEY_PREFIX,
  EVIDENCE_REVIEW_TURN_KEY_PREFIX,
  EVIDENCE_SEND_BACK_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX,
  SESSION_REPLY_TURN_KEY_PREFIX,
  WATCH_TURN_KEY_PREFIX,
} from './watch-turn-key';

/**
 * Whether the control plane wrote this turn itself, rather than filing a message somebody sent.
 *
 * Every turn Orbit queues on its own account is keyed in a namespace of its own: a watch's wake, a
 * background job's or a due wakeup's, an exception item's delivery, the owner's answer as it is told
 * to a coordinator, a project's start, a task run's brief, each acceptance round, the outcome of a
 * session's request handed back to it, a confirmation request's review on its three turns — to
 * its reviewer, a reviewer's return to the run, the owner's answers to the reviewer — an evidence
 * revision handed to the session that dispatched its task, and a send-back's note handed to the
 * run that submitted the revision, and the re-send of any of those after a failed turn
 * (`auto-retry:orbit:`; a re-send of somebody's own words keeps the bare `auto-retry:` key). A coordinator's
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
    RUN_QUESTION_PREFIX,
    'run-notify:v1:',
    WATCH_TURN_KEY_PREFIX,
    BACKGROUND_WAKE_TURN_PREFIX,
    OPEN_ITEM_TURN_PREFIX,
    OWNER_ANSWER_TURN_PREFIX,
    PROJECT_STARTED_TURN_PREFIX,
    TASK_RUN_TURN_PREFIX,
    TASK_ACCEPTANCE_CLIENT_TURN_PREFIX,
    SESSION_REPLY_TURN_KEY_PREFIX,
    OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX,
    CONFIRMATION_RETURN_TURN_KEY_PREFIX,
    OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX,
    EVIDENCE_REVIEW_TURN_KEY_PREFIX,
    EVIDENCE_SEND_BACK_TURN_KEY_PREFIX,
    AUTO_RETRY_ORBIT_TURN_KEY_PREFIX,
  ];
  return prefixes.some((prefix) => clientTurnId.startsWith(prefix)) || isDerivedUuid(clientTurnId);
}

/**
 * The key a session's opening prompt is filed under as its first turn (`SessionsService.initialTurnClientId`,
 * which answers this). Spelled here so the rule below needs no import of the sessions service.
 */
export function openingTurnKey(sessionId: string): string {
  return `initial-${sessionId}`;
}

/**
 * The id the opening turn is written with, whoever writes it (`SessionsService.insertTurnLocked`, the
 * claim's `QueueService.buildSession`): known from the session alone, so the active view can list the
 * opening under the id its echo will carry before any runner has laid the turn down, and a client that
 * drew it then sees the echo take that same row over rather than a second one appear.
 */
export function openingTurnId(sessionId: string): string {
  return derivedUuid(`conversation-turn:opening:${sessionId}`);
}

/**
 * `isOrbitAuthoredTurn` for a turn of a known session: also the opening of a session the platform
 * opened with a prompt of its own (`session.prompt_by_orbit`, migration 0493) — a project's
 * coordinator, a judgment, a task list's dispatch console, the reply to an @-mention. Their opening
 * shares the `initial-<id>` key with a person's own, so the key alone cannot say whose it is; the
 * column written when the session was made does (docs/session-list-projects-design.md §3.5).
 */
export function isOrbitAuthoredTurnOf(
  session: { id: string; promptByOrbit: boolean },
  clientTurnId: string | null | undefined,
): boolean {
  return isOrbitAuthoredTurn(clientTurnId)
    || (session.promptByOrbit && clientTurnId === openingTurnKey(session.id));
}
