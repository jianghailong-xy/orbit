import {
  LandingFailureClass,
  RetryableLandingFailureClass,
  isRetryableLandingFailure,
  landingFailureClass,
} from './project-integration-job';

/**
 * `integration_retry`: a project's coordinator runs one of its failed landings again
 * (`docs/project-integration-line-contract.md` §2.3 J-T1b).
 *
 * WHY THIS DOOR EXISTS. A DONE task whose landing stopped at a red check, a check that ran out of
 * time or an integration error has no way back onto the line: the platform never reruns a landing by
 * itself (J5), and `task_start` runs the TASK again — a new session on a new branch — without ever
 * queueing another landing of the work it already finished. On 2026-10-01 that left three DONE tasks
 * of project 34Y7My8sqhKLWtmCQYv1l stopped at generation 1 with nothing in flight and nobody able to
 * move them, and everything downstream waiting on a landing that was never going to be asked for.
 *
 * This module is the part with no I/O: the codes, and the one decision over facts the caller read
 * under the task row lock. `ProjectOpenItemService.retryIntegration` reads them and does the writes.
 */

/** Only the conversation the project is coordinated from may rerun one of its landings. 403. */
export const INTEGRATION_RETRY_COORDINATOR_ONLY = 'INTEGRATION_RETRY_COORDINATOR_ONLY';
/** A rerun nobody explained is the silent retry J5 refuses. 400. */
export const INTEGRATION_RETRY_REASON_REQUIRED = 'INTEGRATION_RETRY_REASON_REQUIRED';
/** The task is not filed under the project the call names. 403. */
export const INTEGRATION_RETRY_NOT_THIS_PROJECT = 'INTEGRATION_RETRY_NOT_THIS_PROJECT';
/** The project is not Automatic and nobody handed this failure to the coordinator. 403. */
export const INTEGRATION_RETRY_NOT_AUTOMATIC = 'INTEGRATION_RETRY_NOT_AUTOMATIC';
/** An open item about this landing is the account owner's — escalated, or theirs from birth. 409. */
export const INTEGRATION_RETRY_OWNER_ITEM = 'INTEGRATION_RETRY_OWNER_ITEM';
/** The account owner has an open blocker about this task waiting on their decision. 409. */
export const INTEGRATION_RETRY_OWNER_BLOCKER = 'INTEGRATION_RETRY_OWNER_BLOCKER';
/** A landing of this task is already queued or running. 409. */
export const INTEGRATION_RETRY_IN_FLIGHT = 'INTEGRATION_RETRY_IN_FLIGHT';
/** There is no failed landing of a DONE task to run again. 409. */
export const INTEGRATION_RETRY_NOT_APPLICABLE = 'INTEGRATION_RETRY_NOT_APPLICABLE';

/** Longest reason a rerun carries — the same bound as the hand-close's note it is written beside. */
export const MAX_INTEGRATION_RETRY_REASON = 2_000;

/** What the decision is taken over, read in the retry's own transaction under the task row. */
export interface IntegrationRetryFacts {
  /** The project's Automatic switch (`coordinator_enabled`). */
  coordinatorEnabled: boolean;
  taskStatus: string;
  /** The task's newest LAND_TASK, by generation; null when it never had one. */
  newestLanding: { id: string; generation: number; state: string; checks: unknown } | null;
  /** The task's OPEN `INTEGRATION_*` items. */
  openItems: ReadonlyArray<{ id: string; kind: string; assignee: string; assigneeReason: string }>;
  /** The task's open `project_blocker` episodes that wait on the account owner. */
  ownerBlockers: ReadonlyArray<{ id: string; kind: string }>;
}

/** A refusal, in the shape the service throws it: the status, and the body the caller reads. */
export interface IntegrationRetryRefusal {
  ok: false;
  status: 403 | 409;
  body: { code: string; message: string } & Record<string, unknown>;
}

export type IntegrationRetryDecision =
  | {
      ok: true;
      retryOfJobId: string;
      failureClass: RetryableLandingFailureClass;
      /** The open items the rerun supersedes: the coordinator's own, about this landing. */
      supersede: string[];
    }
  | IntegrationRetryRefusal;

function refuse(
  status: 403 | 409,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): IntegrationRetryRefusal {
  return { ok: false, status, body: { code, message, ...detail } };
}

/**
 * Whether the coordinator may run this task's landing again, and what it would rerun.
 *
 * The order is the order a reader needs the answer in: is there a failed landing of a finished task
 * at all, is it still the coordinator's to decide, and is the coordinator allowed to decide it.
 *
 * WHO DECIDES A FAILED LANDING. An open item about it names its assignee, and that is the answer:
 * the coordinator's item is the coordinator's to rerun, and an item that is the account owner's —
 * escalated because nobody acted in time, or the owner's from birth in a project that is not
 * Automatic — is theirs. With no open item (the coordinator closed it by hand, as it did for task ③
 * of 34Y7My8sqhKLWtmCQYv1l while the merge check was being repaired), the Automatic switch answers:
 * it is the owner's standing grant that the coordinator carries the project's landings. An item the
 * owner handed back to the coordinator ("Ask the coordinator again") is the coordinator's whatever
 * the switch says — the press is the owner putting that one decision in front of it, which is the
 * reading `ProjectOpenItemService.deliver` gives the same press.
 */
export function decideIntegrationRetry(facts: IntegrationRetryFacts): IntegrationRetryDecision {
  if (facts.taskStatus !== 'DONE') {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE,
      `this task is ${facts.taskStatus}, not DONE. A landing delivers a finished task's work, so there `
      + 'is no finished delivery to land again: let the task finish first, and its DONE queues the '
      + 'landing by itself.',
      { taskStatus: facts.taskStatus });
  }
  const newest = facts.newestLanding;
  if (newest === null) {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE,
      'this task has never had a landing on this project\'s integration line, so there is none to run '
      + 'again. A project that lands straight into main offers its tasks as merge candidates instead.',
      { newestLanding: null });
  }
  const landing = { jobId: newest.id, generation: newest.generation, state: newest.state };
  if (newest.state === 'QUEUED' || newest.state === 'RUNNING') {
    return refuse(409, INTEGRATION_RETRY_IN_FLIGHT,
      `generation ${newest.generation} of this task's landing is already ${newest.state}: nothing new is `
      + 'queued beside it. Wait for its result — if it fails, its own item reaches you.',
      { newestLanding: landing });
  }
  const failureClass: LandingFailureClass | null = landingFailureClass(newest);
  if (!isRetryableLandingFailure(failureClass)) {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE, notRetryable(newest.state, failureClass), {
      newestLanding: { ...landing, failureClass },
    });
  }

  const owners = facts.openItems.filter((item) => item.assignee !== 'COORDINATOR');
  if (owners.length > 0) {
    const reasons = [...new Set(owners.map((item) => item.assigneeReason))];
    return refuse(409, INTEGRATION_RETRY_OWNER_ITEM,
      'this failed landing is the account owner\'s: an open item about it is assigned to them '
      + `(${reasons.join(', ')}) — ${ownerItemWhy(reasons)} Running it again is their decision; they `
      + 'can hand the item back to you with "Ask the coordinator again", and then it is yours.',
      { itemIds: owners.map((item) => item.id), assigneeReasons: reasons });
  }
  if (facts.ownerBlockers.length > 0) {
    return refuse(409, INTEGRATION_RETRY_OWNER_BLOCKER,
      'the account owner has an open blocker about this task waiting on their decision '
      + `(${[...new Set(facts.ownerBlockers.map((blocker) => blocker.kind))].join(', ')}). Landing the `
      + 'work again before they decide would answer it for them: wait for the blocker to be resolved.',
      { blockerIds: facts.ownerBlockers.map((blocker) => blocker.id) });
  }
  const mine = facts.openItems.filter((item) => item.assignee === 'COORDINATOR');
  if (mine.length === 0 && !facts.coordinatorEnabled) {
    return refuse(403, INTEGRATION_RETRY_NOT_AUTOMATIC,
      'this project is not Automatic, so a failed landing is the account owner\'s to decide and nothing '
      + 'about this one has been handed to you. Ask them (ask_owner), or let them hand you the item.');
  }
  return {
    ok: true,
    retryOfJobId: newest.id,
    failureClass,
    supersede: mine.map((item) => item.id),
  };
}

/** Why a landing that ended this way is not run again, and what answers it instead. */
function notRetryable(state: string, failureClass: LandingFailureClass | null): string {
  if (failureClass === 'CONFLICT') {
    return 'this task\'s newest landing ended in a CONFLICT, and running the same commits again '
      + 'conflicts the same way: only a branch that changed answers a conflict. Send the task back '
      + '(task_reopen) to be reworked against the line as it is now, or file a successor '
      + '(task_create with supersedesTaskId).';
  }
  switch (state) {
    case 'LANDED':
    case 'ALREADY_LANDED':
      return `this task's newest landing is ${state}: its work is on the line already, so there is `
        + 'nothing to land again.';
    case 'NOTHING_TO_LAND':
      return 'this task\'s newest landing found nothing of the task\'s own on the branch it was '
        + 'handed (NOTHING_TO_LAND). That is not a failure this door reruns: if the work has since '
        + 'moved to another branch, send the task back (task_reopen) so its next DONE queues that one.';
    default:
      return `this task's newest landing is ${state}, which is not a failure a rerun answers: only `
        + 'CHECK_FAILED, CHECK_TIMED_OUT and ERROR are run again.';
  }
}

/** What each way an item reaches the owner means, for the one sentence a refusal gives it. */
function ownerItemWhy(reasons: readonly string[]): string {
  if (reasons.includes('ESCALATED')) {
    return 'it escalated to them because it waited longer than the project\'s escalation window.';
  }
  if (reasons.includes('NO_COORDINATOR')) {
    return 'the project is not Automatic, so it was theirs from the moment it was opened.';
  }
  return 'it reached them because there was nobody else to hand it to.';
}
