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
/** The user door may only answer an integration item assigned to the account owner. 403. */
export const INTEGRATION_RETRY_OWNER_ONLY = 'INTEGRATION_RETRY_OWNER_ONLY';
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
  /** Which side is pressing the door; omitted means the historical coordinator decision. */
  requester?: 'COORDINATOR' | 'OWNER';
  /** The project's Automatic switch (`coordinator_enabled`). */
  coordinatorEnabled: boolean;
  taskStatus: string;
  /** The task's newest LAND_TASK, by generation; null when it never had one. `phase` is where it
   *  stopped: a CONFLICT at MAIN_SYNC is the line's, and its refusal says what resolves that one. */
  newestLanding: {
    id: string; generation: number; state: string; checks: unknown; phase?: string | null;
    /** RUNNING, and its runner has said nothing past the job's limit (§1.6 `inFlightJobs`). */
    timedOut?: boolean;
  } | null;
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
      /**
       * The open items the rerun will be HANDLING: the coordinator's own, about this failure. They stay
       * OPEN while the rerun is in flight and are ended by its result (§4.7 H1–H4) — HANDLED when it
       * lands or passes, SUPERSEDED by the new item when it fails again — never at the moment it is
       * asked for, because nobody knows yet which of the two it will be.
       */
      handle: string[];
      /** The rerun replaces a RUNNING landing that timed out, which the door ends first (J-T9). */
      endsTimedOutJob?: boolean;
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
  // A landing whose runner stopped reporting past its limit will not end by itself (§2.2 J-T9): the
  // retry ends it as the ERROR it is, and reruns it like any other.
  const timedOut = newest.state === 'RUNNING' && newest.timedOut === true;
  if (!timedOut && (newest.state === 'QUEUED' || newest.state === 'RUNNING')) {
    return refuse(409, INTEGRATION_RETRY_IN_FLIGHT,
      `generation ${newest.generation} of this task's landing is already ${newest.state}: nothing new is `
      + 'queued beside it. Wait for its result — if it fails, its own item reaches you; if its runner '
      + 'stops reporting past its limit, it can be retried then.',
      { newestLanding: landing });
  }
  const failureClass: LandingFailureClass | null = timedOut ? 'ERROR' : landingFailureClass(newest);
  if (!isRetryableLandingFailure(failureClass)) {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE,
      notRetryable(newest.state, failureClass, newest.phase ?? null), {
        newestLanding: { ...landing, failureClass },
      });
  }

  const requester = facts.requester ?? 'COORDINATOR';
  if (requester === 'OWNER') {
    const mine = facts.openItems.filter((item) => item.assignee === 'OWNER');
    // A timed-out landing has no item to be anybody's yet, and it is the owner's project: their press
    // is the decision.
    if (mine.length === 0 && !timedOut) return ownerOnlyRefusal('failed landing');
    if (facts.ownerBlockers.length > 0) {
      return refuse(409, INTEGRATION_RETRY_OWNER_BLOCKER,
        'the account owner has an open blocker about this task waiting on their decision. Running the '
        + 'landing again before that blocker is resolved would answer it for them: resolve the blocker '
        + 'first.', { blockerIds: facts.ownerBlockers.map((blocker) => blocker.id) });
    }
    return {
      ok: true,
      retryOfJobId: newest.id,
      failureClass,
      handle: mine.map((item) => item.id),
      ...(timedOut ? { endsTimedOutJob: true } : {}),
    };
  }
  const owned = ownerItemRefusal(facts.openItems, 'failed landing');
  if (owned) return owned;
  if (facts.ownerBlockers.length > 0) {
    return refuse(409, INTEGRATION_RETRY_OWNER_BLOCKER,
      'the account owner has an open blocker about this task waiting on their decision '
      + `(${[...new Set(facts.ownerBlockers.map((blocker) => blocker.kind))].join(', ')}). Landing the `
      + 'work again before they decide would answer it for them: wait for the blocker to be resolved.',
      { blockerIds: facts.ownerBlockers.map((blocker) => blocker.id) });
  }
  const mine = facts.openItems.filter((item) => item.assignee === 'COORDINATOR');
  if (mine.length === 0 && !facts.coordinatorEnabled) return notAutomaticRefusal('a failed landing');
  return {
    ok: true,
    retryOfJobId: newest.id,
    failureClass,
    handle: mine.map((item) => item.id),
    ...(timedOut ? { endsTimedOutJob: true } : {}),
  };
}

/** What a blocked candidate's re-check is decided over, read in the retry's own transaction under the
 *  candidate's row lock. */
export interface PromotionRetryFacts {
  /** Which side is pressing the door; omitted means the historical coordinator decision. */
  requester?: 'COORDINATOR' | 'OWNER';
  /** The project's Automatic switch (`coordinator_enabled`). */
  coordinatorEnabled: boolean;
  /** Where the candidate is (`project_promotion.state`). */
  promotionState: string;
  /** The candidate's newest job — its check, or its landing — or null when it never had one. */
  newestJob: { id: string; kind: string; generation: number; state: string; checks: unknown } | null;
  /** The candidate's OPEN `INTEGRATION_*` items. */
  openItems: ReadonlyArray<{ id: string; kind: string; assignee: string; assigneeReason: string }>;
}

/**
 * Whether the coordinator may run a blocked candidate's check again (§4.7 H1) — the door for an item
 * about a merge into main, which names no task and so had no way back for the coordinator at all: it
 * waited, escalated, and sat in front of the owner (the MERGE_CHECK of 34Y7My8sqhKLWtmCQYv1l on
 * 2026-10-02).
 *
 * The same three questions a task's landing is asked, asked of the candidate: is it blocked by a
 * failure a rerun can answer, is that failure still the coordinator's, and may the coordinator decide
 * it. What it reruns is the CHECK, whichever of the candidate's jobs failed: a passing check is what
 * makes a candidate mergeable again, and the merge stays exactly as authorized as it was — the
 * owner's card, or the Automatic setting's own rule over a clean result (M-T11). So this door can
 * bring a candidate back to the question and never answers it; a candidate that already passed and
 * is waiting on the owner is refused here, because the only thing left to do with it is theirs.
 */
export function decidePromotionRetry(facts: PromotionRetryFacts): IntegrationRetryDecision {
  const newest = facts.newestJob;
  if (newest && (newest.state === 'QUEUED' || newest.state === 'RUNNING')) {
    return refuse(409, INTEGRATION_RETRY_IN_FLIGHT,
      `this candidate's ${newest.kind} (generation ${newest.generation}) is already ${newest.state}: `
      + 'nothing new is queued beside it. Wait for its result — if it fails, its own item reaches you.',
      { newestJob: { jobId: newest.id, kind: newest.kind, generation: newest.generation, state: newest.state } });
  }
  if (facts.promotionState !== 'BLOCKED') {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE, candidateNotBlocked(facts.promotionState),
      { promotionState: facts.promotionState });
  }
  if (newest === null) {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE,
      'this candidate has no check or landing on record, so there is no failure to run again.',
      { newestJob: null });
  }
  const failureClass: LandingFailureClass | null = landingFailureClass(newest);
  if (!isRetryableLandingFailure(failureClass)) {
    return refuse(409, INTEGRATION_RETRY_NOT_APPLICABLE, failureClass === 'CONFLICT'
      ? 'this candidate stopped on a CONFLICT with the upstream, and checking the same commits again '
        + 'conflicts the same way: only a project branch that changed answers one. File a task that '
        + 'resolves it on the project branch — its landing makes the next candidate by itself, and that '
        + 'one is checked again.'
      : `this candidate's newest ${newest.kind} is ${newest.state}, which is not a failure a rerun `
        + 'answers: only CHECK_FAILED, CHECK_TIMED_OUT and ERROR are run again.',
    { newestJob: { jobId: newest.id, kind: newest.kind, generation: newest.generation, state: newest.state, failureClass } });
  }
  const requester = facts.requester ?? 'COORDINATOR';
  if (requester === 'OWNER') {
    const mine = facts.openItems.filter((item) => item.assignee === 'OWNER');
    if (mine.length === 0) return ownerOnlyRefusal('blocked merge into main');
    return {
      ok: true,
      retryOfJobId: newest.id,
      failureClass,
      handle: mine.map((item) => item.id),
    };
  }
  const owned = ownerItemRefusal(facts.openItems, 'blocked merge into main');
  if (owned) return owned;
  const mine = facts.openItems.filter((item) => item.assignee === 'COORDINATOR');
  if (mine.length === 0 && !facts.coordinatorEnabled) return notAutomaticRefusal('a blocked merge into main');
  return {
    ok: true,
    retryOfJobId: newest.id,
    failureClass,
    handle: mine.map((item) => item.id),
  };
}

/** Why a candidate that is not BLOCKED has nothing for this door to do, and what answers it. */
function candidateNotBlocked(state: string): string {
  switch (state) {
    case 'READY':
      return 'this candidate passed its checks and is waiting on the account owner\'s "Merge to main": '
        + 'there is no failed check to run again, and confirming the merge is theirs.';
    case 'CHECKING':
    case 'CONFIRMED':
    case 'RECHECKING':
      return `this candidate is ${state}: it is being checked or merged now, and its result reaches you `
        + 'if it fails.';
    default:
      return `this candidate is ${state}, so nothing will merge it any more and there is nothing to run `
        + 'again. The next landing on the project branch makes a new candidate by itself.';
  }
}

/**
 * An open item about this failure that is the account owner's makes running it again their decision —
 * escalated because nobody acted in time, or theirs from birth in a project that is not Automatic.
 */
function ownerItemRefusal(
  openItems: IntegrationRetryFacts['openItems'],
  failure: string,
): IntegrationRetryRefusal | null {
  const owners = openItems.filter((item) => item.assignee !== 'COORDINATOR');
  if (owners.length === 0) return null;
  const reasons = [...new Set(owners.map((item) => item.assigneeReason))];
  return refuse(409, INTEGRATION_RETRY_OWNER_ITEM,
    `this ${failure} is the account owner's: an open item about it is assigned to them `
    + `(${reasons.join(', ')}) — ${ownerItemWhy(reasons)} Running it again is their decision; they `
    + 'can hand the item back to you with "Ask the coordinator again", and then it is yours.',
    { itemIds: owners.map((item) => item.id), assigneeReasons: reasons });
}

/** No item about it was handed to the coordinator, and the switch that would have is off. */
function notAutomaticRefusal(failure: string): IntegrationRetryRefusal {
  return refuse(403, INTEGRATION_RETRY_NOT_AUTOMATIC,
    `this project is not Automatic, so ${failure} is the account owner's to decide and nothing `
    + 'about this one has been handed to you. Ask them (ask_owner), or let them hand you the item.');
}

/** The user door is scoped to the exception card in front of the account owner. */
function ownerOnlyRefusal(failure: string): IntegrationRetryRefusal {
  return refuse(403, INTEGRATION_RETRY_OWNER_ONLY,
    `this ${failure} is not assigned to the account owner. The owner retry door only answers an `
    + 'open owner item; use the project coordinator\'s integration_retry door for a coordinator item.');
}

/** Why a landing that ended this way is not run again, and what answers it instead. */
function notRetryable(state: string, failureClass: LandingFailureClass | null, phase: string | null): string {
  if (failureClass === 'CONFLICT' && phase === 'MAIN_SYNC') {
    // §3.1 M3: the line's conflict, not the task's work — the item's own message says the same.
    return 'this task\'s newest landing stopped at MAIN_SYNC: absorbing the upstream into the project '
      + 'branch conflicted before any of the task\'s commits were looked at, so running it again meets '
      + 'the same conflict, and so does sending the task back to redo its work. Absorb the upstream on '
      + 'the project line first: the task\'s source branch gets a merge commit of the project branch tip '
      + 'and the upstream tip, conflicts resolved, and nothing else (task_comment saying the run does '
      + 'only that, then task_reopen). With both tips in the source, its next landing skips the main sync '
      + 'and lands by J-S4 MERGE.';
  }
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
  if (reasons.includes('HANDED_OVER')) {
    return 'the coordinator handed it over because it could not settle it itself.';
  }
  if (reasons.includes('ESCALATED')) {
    return 'it escalated to them because it waited longer than the project\'s escalation window.';
  }
  if (reasons.includes('NO_COORDINATOR')) {
    return 'the project is not Automatic, so it was theirs from the moment it was opened.';
  }
  return 'it reached them because there was nobody else to hand it to.';
}
