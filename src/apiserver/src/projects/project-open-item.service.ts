import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';

import {
  COORDINATOR_LEAD_KINDS,
  type DoneRequest,
  type OpenItemChat,
  type ProjectOpenItemRow,
  type OpenItemFacts,
  type OpenItemHandling,
  type OpenItemOutcome,
  type OpenItemWorkSession,
  type ProjectDoneNotReadyBody,
  type ProjectClosedQuestion,
  type ProjectDoneRequestDeclineBody,
  type ProjectDoneRequestDeclined,
  type ProjectDoneRequestFiled,
  type ProjectIntegrationJob,
  type ProjectStartNotReadyBody,
  type ProjectStartRequest,
  type ProjectStartRequestBody,
  type ProjectStartRequestFiled,
  type ProjectStartSettings,
  type ProjectRulingView,
  type RequestProjectDoneBody,
  type OwnerCardTranslation,
  type ProjectAccountWait,
  type ProjectSignInWait,
  type TaskSignInHold,
  RunEventType,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { recordProjectRuling, writeAutoRuling } from './project-ruling';
import { refuseProjectStatusWrite } from './coordinator-authority';
import { settleTaskSegmentAfterHandledItem } from './landing-session';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  COORDINATOR_QUESTION_FIELDS,
  DONE_REQUEST_FIELDS,
  START_REQUEST_FIELDS,
  queueOwnerCardTranslation,
  translatedInto,
  type CardFields,
} from '../sessions/card-translation';
import { translationLanguages, type TranslationLanguages } from '../sessions/turn-translation';
import { ownerWordsForAgent } from '../sessions/reply-translation';
import { EVIDENCE_UNDECIDED_KIND, evidenceUndecidedDetailLine } from './evidence-undecided';
import {
  AskedQuestion,
  CoordinatorQuestion,
  DELIVERY_REVIEW_KIND,
  INTEGRATION_ITEM_KINDS,
  LANDED_WITHOUT_CONFIRMATION_KIND,
  LANDING_LEASE_EXPIRED_KIND,
  LANDING_UNOBSERVED_KIND,
  MAX_OPEN_ITEM_RESOLUTION_NOTE,
  OpenItemAssignee,
  OpenItemAssigneeReason,
  OpenItemKind,
  OwnerAnswer,
  QuestionNotAskable,
  SESSION_ENDING_SELECT,
  TASK_FAILURE_CHAIN_LIMIT,
  conversationIsOver,
  coordinatorQuestion,
  deliveryReviewDetailLine,
  landingSessionIdOf,
  leaseFactsOf,
  markOpenItemsHandling,
  openItemActions,
  coordinatorUnreachable,
  openItemChat,
  openItemRequiredAction,
  readCoordinatorReach,
  outdatedRunnerOf,
  primaryAction,
  openItemFacts,
  type LandedFix,
  landingLineOf,
  openItemMessage,
  openItemOwed,
  inWorkSessionHands,
  readOpenItemWorkSessions,
  handBackLandingFix,
  type LandingFixReturnReason,
  OPEN_ITEM_WITH_WORK_SESSION,
  OPEN_ITEM_WITH_WORK_SESSION_MESSAGE,
  openItemVisible,
  openItemTurnId,
  openItemsNoLongerOwed,
  ownerAnswerMessage,
  ownerAnswerTurnId,
  questionDetailLine,
  sessionHasEnded,
} from './project-open-item';
import { escalatesAt } from './open-item-escalation.service';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from './coordinator-evidence-queue';
import { canonicalJson } from './canonical-json';
import { mainBranchOf, taskLandingSql } from './project-criterion-landing';
import { landingFixMessage, landingFixTurnId, readLandingFixFacts } from './landing-fix-turn';
import { platformTurnRevives } from '../sessions/platform-turn-revival';
import {
  DELIVERED_IDENTITY_CLEARED,
  LandingRetryFailureClass,
  SkippedMergeCheckRecord,
  endTimedOutLanding,
  enqueueForDoneTask,
  pushBoundaryPassed,
  RetryableLandingFailureClass,
  queueLandingRetry,
  readLandingSourceTip,
} from './project-integration-job';
import {
  ProjectIntegrationView,
  defaultProjectBranchOf,
  projectIntegrationView,
  readInFlightJobs,
  readProjectCodebase,
  readProjectIntegrationView,
  stopInFlightJob,
} from './project-integration-line';
import {
  INTEGRATION_STOP_NOT_APPLICABLE,
  INTEGRATION_STOP_OWNER_CHANNEL_ONLY,
  INTEGRATION_STOP_PUSHED,
} from './project-integration-abandon';
import {
  INTEGRATION_RETRY_COORDINATOR_ONLY,
  INTEGRATION_RETRY_IN_FLIGHT,
  INTEGRATION_RETRY_NOT_APPLICABLE,
  INTEGRATION_RETRY_NOT_THIS_PROJECT,
  INTEGRATION_RETRY_REASON_REQUIRED,
  MAX_INTEGRATION_RETRY_REASON,
  decideIntegrationRetry,
  decidePromotionRetry,
} from './project-integration-retry';
import {
  INTEGRATION_SKIP_CHECK_NOT_THIS_PROJECT,
  SKIP_CHECK_STOP_CAUSE,
  decideIntegrationSkipCheck,
  inFlightSkipRefusal,
  isApprovalId,
  notAnApprovalId,
} from './project-integration-skip-check';
import { requeuePromotionCheck, retireCandidateAfterHandledItem } from './project-promotion.service';
import {
  INTEGRATION_OBSERVE_COORDINATOR_ONLY,
  INTEGRATION_OBSERVE_REASON_REQUIRED,
  MAX_INTEGRATION_OBSERVE_REASON,
  hasPendingObservation,
  observableUnobservedItems,
  queueLandingObservation,
} from './landing-observation';
import { FusePausedPayload, fusePausedDetailLine } from './project-fuse';
import {
  START_REQUEST_COORDINATOR_ONLY,
  START_REQUEST_DEDUPE_KEY,
  START_REQUEST_KIND,
  START_REQUEST_NOT_READY,
  START_REQUEST_TITLE,
  readStartPlan,
  startReadiness,
  startRequestDetailLine,
  supersedeStaleStartRequest,
} from './project-start-request';
import { doorsForOpenItem, openItemDoorMessageNames, sourceJobForOpenItem } from './open-item-doors';
import { lineSyncDedupeKey } from './line-sync-hold';
import { uuidToBase62 } from '@orbit/shared';
import {
  DONE_REQUEST_COORDINATOR_ONLY,
  DONE_REQUEST_DECLINE_NOTE_REQUIRED,
  DONE_REQUEST_DEDUPE_KEY,
  DONE_REQUEST_KIND,
  DONE_REQUEST_NOT_READY,
  DONE_REQUEST_UNCHANGED_SINCE_DECLINE,
  DONE_REQUEST_NOT_OPEN,
  DONE_REQUEST_TITLE,
  MAX_DONE_REQUEST_DECLINE_NOTE,
  MAX_DONE_REQUEST_JUDGMENT,
  doneReadiness,
  doneRequestDeclineMessage,
  doneRequestDetailLine,
  normalizeDoneRequestGaps,
  readDoneState,
  supersedeStaleDoneRequest,
} from './project-done-request';
import { sessionHeldSql } from '../common/session-release';
import { IN_FLIGHT_JOB_STATES, IN_FLIGHT_JOB_STATES_SQL, isInFlightJobState } from './in-flight-job-states';

/**
 * Who is asking for an item to be put in front of the project's coordinator conversation.
 *
 * `AUTOMATIC` is the platform: an item the coordinator owes, a drain finding one owed, an item
 * opened for a conversation. `OWNER` is the account owner's own press — `returnToCoordinator`, the
 * card's "Ask the coordinator again". The two differ in exactly one place and for one reason, the
 * coordinator switch; `deliver` is where that is spelled out.
 */
export type DeliverAskedBy = 'AUTOMATIC' | 'OWNER';

/** Only the project's coordinator conversation may put a question to the owner (§5.2 R8). */
export const ASK_OWNER_COORDINATOR_ONLY = 'ASK_OWNER_COORDINATOR_ONLY';
/** A question that has been answered, withdrawn or superseded is not answered again (§4.7). */
export const OPEN_ITEM_NOT_OPEN = 'OPEN_ITEM_NOT_OPEN';
/** An item the coordinator is already carrying is not handed back to it (§4.7). */
export const OPEN_ITEM_ALREADY_COORDINATORS = 'OPEN_ITEM_ALREADY_COORDINATORS';
/** A project with no coordinator conversation — or one that has ended — has nobody to ask again
 *  (§4.7). */
export const OPEN_ITEM_NO_COORDINATOR = 'OPEN_ITEM_NO_COORDINATOR';
/** The item is not the coordinator's to close: an item assigned to the owner — an escalation, a
 *  question, a merge card, a pause — is theirs (§4.7). */
export const OPEN_ITEM_NOT_COORDINATOR_ITEM = 'OPEN_ITEM_NOT_COORDINATOR_ITEM';
/** Only the conversation an item is assigned to may close it by hand (§4.7), or the owner. */
export const OPEN_ITEM_COORDINATOR_ONLY = 'OPEN_ITEM_COORDINATOR_ONLY';
/** This kind is decided by a press of its own — confirming a merge, or resuming a paused project
 *  (§4.2, §4.7). */
export const OPEN_ITEM_HAS_ITS_OWN_DOOR = 'OPEN_ITEM_HAS_ITS_OWN_DOOR';
/** The explanation on a deliberate coordinator-to-owner hand-over is required. */
export const OPEN_ITEM_HAND_OVER_NOTE_REQUIRED = 'OPEN_ITEM_HAND_OVER_NOTE_REQUIRED';
/** A deliberate hand-over explanation is bounded like the other open-item prose. */
export const OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG = 'OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG';
/** Another item writer won the hand-over compare-and-set. */
export const OPEN_ITEM_HAND_OVER_RACE = 'OPEN_ITEM_HAND_OVER_RACE';
/** This kind is never delivered to a coordinator conversation, so it cannot be sent back to one
 *  (§4.6 X-E5, §4.4 X-D7): it is the owner's from birth, and the silence it reports is theirs. */
export const OPEN_ITEM_NOT_RETURNABLE = 'OPEN_ITEM_NOT_RETURNABLE';
/** O-X1 (§10.7): a task-landing integration item is not closed by hand while the wait it is about
 *  still stands — the task NOT_KNOWN and a dependent still waiting on it. */
export const OPEN_ITEM_CONDITION_STANDS = 'OPEN_ITEM_CONDITION_STANDS';
/** The owner's own door, refused to a request made from a session whatever it carries (§4.7). */
export const OPEN_ITEM_OWNER_ONLY = 'OPEN_ITEM_OWNER_ONLY';

function normalizedDoneRequestDeclineNote(given: ProjectDoneRequestDeclineBody | undefined): string {
  const note = typeof given?.note === 'string' ? given.note.trim() : '';
  if (!note) {
    throw new BadRequestException({
      code: DONE_REQUEST_DECLINE_NOTE_REQUIRED,
      message: 'note is required: say what is still missing before this project is done',
    });
  }
  if (note.length > MAX_DONE_REQUEST_DECLINE_NOTE) {
    throw new BadRequestException({
      code: DONE_REQUEST_DECLINE_NOTE_REQUIRED,
      message: `note is at most ${MAX_DONE_REQUEST_DECLINE_NOTE} characters`,
    });
  }
  return note;
}

function doneRequestDeclineNotOpen(): ConflictException {
  return new ConflictException({
    code: DONE_REQUEST_NOT_OPEN,
    message:
      'this done request is no longer an OPEN DONE_REQUEST for this project. A request gets one '
      + 'Not yet… answer, and nothing was written.',
  });
}

/**
 * The kinds this door ends, and what each ending is called (§4.2).
 *
 * The integration kinds come from the constant rather than being listed again, so a fifth
 * `INTEGRATION_*` state the pipeline can stop in does not arrive without a way to close it. The
 * kinds that are absent are absent on purpose: `PROMOTION_APPROVAL` is decided by confirming or
 * declining the merge and `FUSE_PAUSED` by resuming the project, and closing either by hand would
 * leave what it is about — a promotion nobody decided, a project standing still — with no card in
 * front of anybody. Revision 29's two (§10.7) are absent for the same reason: a
 * `LANDING_UNOBSERVED` ends with a fact about its task, and a `LANDED_WITHOUT_CONFIRMATION` with
 * the owner's Accept.
 */
const HAND_CLOSABLE_RESOLUTIONS: Readonly<Record<string, 'HANDLED' | 'WITHDRAWN'>> = {
  ...Object.fromEntries(INTEGRATION_ITEM_KINDS.map((kind) => [kind, 'HANDLED' as const])),
  TASK_FAILED: 'HANDLED',
  [DELIVERY_REVIEW_KIND]: 'HANDLED',
  // §4.6 X-E5: the owner's own ending for a claim whose job may already be gone — the silence is
  // theirs to judge as dealt with (the job's own terminal state is the platform's ending).
  [LANDING_LEASE_EXPIRED_KIND]: 'HANDLED',
  // §5.2 R12: a question is withdrawn, not handled, and who withdraws it is who asked it.
  COORDINATOR_QUESTION: 'WITHDRAWN',
};

/**
 * How many unread answers one binding delivers at most (§5.2 R11).
 *
 * A cap on the READ, not on the guarantee: an answer is redelivered only until a coordinator's engine
 * takes it, so the set drains itself; the next binding, or the next turn end, picks up the rest.
 */
const ANSWERS_RECONSIDERED_PER_BINDING = 50;

/** Revision 42 (§12.7): the row is in its task's own work session's hands — offered and not handed back. */
function heldBySession(row: Pick<OpenItemRow, 'workSession'>): boolean {
  return row.workSession != null && row.workSession.returnedAt === undefined;
}

/** One exception item, as a reader of the project sees it (§4.8). */
export interface OpenItemRow {
  itemId: string;
  kind: OpenItemKind;
  title: string;
  /** The one line under the title: what happened, in the words of the fact that opened it. */
  detailLine: string;
  assignee: OpenItemAssignee;
  assigneeReason: OpenItemAssigneeReason;
  waitingSince: Date;
  escalateAt: Date | null;
  escalatedAt: Date | null;
  handoverNote: string | null;
  taskId: string | null;
  /** Every task filed as a concrete fix for this item (one item may have several). */
  handledBy: Array<{ taskId: string; title: string; state: string }>;
  /** The attempt this item is about, when one is recorded: the run whose failure opened it. It is
   *  what the card's "Open task session" reaches, and a task can have had several. */
  sessionId: string | null;
  /** The landing session of the attempt this item is about (§2.9 LS1), recorded on its payload when
   *  the failure opened it; null for a payload an older build wrote and for the kinds that land
   *  nothing. `OPEN_LANDING` opens it. */
  landingSessionId: string | null;
  /** The integration job an X-E5 item is about (§4.6): `ABANDON` names it in its route, so the
   *  card cannot draw that press without it. Null for every other kind. */
  integrationJobId: string | null;
  /** That item's claim, as its card words the heading and the Abandon consequence (§4.6 revision
   *  23, J12): the runner's last report, the claim's protocol and whether it recorded a push. Null
   *  for every other kind. */
  lease: {
    lastReportAt: string | null;
    leaseExpiredAt: string | null;
    jobKind: string | null;
    generation: number | null;
    phase: string | null;
    step: string | null;
    claimGeneration: number | null;
    round: number | null;
    checkCount: number | null;
    runner: string | null;
    progressProtocol: string | null;
    pushReported: boolean;
  } | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  /** Where this item is on its way to the coordinator, or that it is not owed to one. */
  delivery: {
    state: 'NOT_REQUIRED' | 'PENDING' | 'QUEUED' | 'DELIVERED' | 'RETURNED';
    sessionId: string | null;
    at: Date | null;
  };
  /** Doors that exist today. An action nobody can perform is not offered. */
  actions: Array<
    | 'REVIEW'
    | 'OPEN_COORDINATOR'
    | 'OPEN_TASK_SESSION'
    | 'RETRY'
    | 'CANCEL_TASK'
    | 'ASK_COORDINATOR_AGAIN'
    | 'RESUME'
    | 'ANSWER'
    | 'OPEN_LANDING'
    | 'ABANDON'
    | 'ACCEPT'
    | 'OBSERVE'
  >;
  /** The server's one-sentence next step, optional for rolling-version readers. */
  requiredAction?: string;
  /** The first compact door for this row, when one exists. */
  primaryAction?:
    | 'REVIEW'
    | 'OPEN_COORDINATOR'
    | 'OPEN_TASK_SESSION'
    | 'RETRY'
    | 'CANCEL_TASK'
    | 'ASK_COORDINATOR_AGAIN'
    | 'RESUME'
    | 'ANSWER'
    | 'OPEN_LANDING'
    | 'ABANDON'
    | 'ACCEPT'
    | 'OBSERVE';
  /** What was asked, for a `COORDINATOR_QUESTION`; null for every other kind (§5.2, §4.8). */
  question: CoordinatorQuestion | null;
  /** The card's words in the owner's language (Settings › Translation); absent until translated. */
  translation?: OwnerCardTranslation;
  /** What a `START_REQUEST` asks — the "Start this project?" card's source; null for every other
   *  kind. */
  startRequest: ProjectStartRequest | null;
  /** What a `DONE_REQUEST` asks — the "Is this project done?" card's source; null for every other
   *  kind. */
  doneRequest: DoneRequest | null;
  /** What the item's payload holds, as the rows its card draws (§7.5); null when the payload is
   *  not a shape this build reads, which leaves the card drawing what it drew before. */
  facts: OpenItemFacts | null;
  /** K4: the measured baseline and the tasks held by its shared item. */
  baseline?: ProjectOpenItemRow['baseline'];
  heldTaskIds?: string[];
  /** The coordinator's rerun of it while that rerun is QUEUED or RUNNING (§4.7 H1), else null. */
  handling: OpenItemHandling<Date> | null;
  /** How it ended, on a row of `settled` (§4.7 H5); null on every open row. */
  outcome: OpenItemOutcome<Date> | null;
  /** "Chat about this": where its handling stands, and where a message about it goes (§4.8). */
  chat: OpenItemChat;
  /** Whether the project's coordinator can be neither asked again nor messaged right now
   *  (`coordinatorUnreachable`), read when the list is. An escalated item's heading says so instead
   *  of "no one acted on this". False on a settled row: nothing is asked of one. Optional for
   *  rolling-version readers, which read its absence as false. */
  coordinatorUnreachable?: boolean;
  /** The task's own work session the failure went to first (revision 42, §12.7), whether it still holds it or
   *  handed it back; null for an item never offered to one. */
  workSession: OpenItemWorkSession<Date> | null;
}

/** A question filed, as `ask_owner` answers its caller (§5.2 R7). */
export interface OpenItemAsked {
  itemId: string;
  state: 'OPEN';
}

/** A question answered, and where the answer went (§5.2 R10). */
export interface OpenItemAnswered {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'ANSWERED';
  /** Null when no conversation is coordinating the project: the answer waits for the next one. */
  delivery: { sessionId: string; turnId: string } | null;
}

/** An item the owner sent back to its project's coordinator (§4.7). */
export interface OpenItemReturned {
  itemId: string;
  assignee: 'COORDINATOR';
  /** The wait starts over, which is the whole of what "ask again" gives the coordinator. */
  waitingSince: Date;
  escalateAt: Date | null;
}

/** The durable result of a coordinator deliberately handing an open item to the owner. */
export interface OpenItemHandedOver {
  itemId: string;
  assignee: 'OWNER';
  assigneeReason: 'HANDED_OVER';
  handoverNote: string;
  handedOverAt: Date;
  handedOverBySessionId: string;
}

/** An item its assignee closed by hand, and what that ending is called (§4.7). */
export interface OpenItemResolved {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'HANDLED' | 'WITHDRAWN';
}

/** Work that reached the branch without the owner's confirmation, accepted by the owner (§10.8). */
export interface OpenItemAccepted {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'ACCEPTED';
}

/** A failed landing the coordinator ran again (§2.3 J-T1b), as `integration_retry` answers it. */
export interface IntegrationRetried {
  taskId: string;
  /** The generation this rerun queued, and the branch it will land. */
  jobId: string;
  generation: number;
  sourceRef: string;
  /** The landing session the queued generation belongs to (§2.9) — `session_get` by this id reads
   *  the landing. Pre-generated when the subject opened, so it is here before the row exists;
   *  null only for a generation written before 0436. */
  landingSessionId: string | null;
  /** The failed generation it reruns, and what that one failed of. */
  retryOfJobId: string;
  failureClass: LandingRetryFailureClass;
  reason: string;
  /** What this rerun does differently, when it is not the plain one: a MAIN_SYNC conflict whose
   *  branch now carries both tips lands by a merge (§3.1 M3). */
  message?: string;
  /** The coordinator's open items about the failed landing, now being handled by this rerun: OPEN
   *  until it ends, then HANDLED or superseded by its own failure's item (§4.7 H1–H3). Empty when
   *  none was open — it may already have been closed by hand. */
  handlingItemIds: string[];
}

/** The project's line looked at again (§10.8, O-T5), as `integration_observe` answers it. */
export interface IntegrationObserved {
  projectId: string;
  /** The OBSERVE_LANDING that will look: the one this press queued, or the one already queued. */
  jobId: string;
  generation: number;
  /** False when the press folded into the observation already queued (§10.4). */
  queued: boolean;
  reason: string;
  /** The asker's OPEN `LANDING_UNOBSERVED` items that observation can answer, now being handled by
   *  it (§4.7 H1): OPEN until it reports, closed LANDED by the receipt it writes when it sees the
   *  commit, and left as they were when it does not. */
  handlingItemIds: string[];
}

/**
 * A landing queued with its merge check not run (§2.4 J-S5), as `integration_skip_merge_check`
 * answers it: a rerun's answer plus the skip the generation carries, which is itself the record a
 * reader of that landing reads — and the same three facts any item it opens will carry.
 */
export interface IntegrationSkipChecked extends IntegrationRetried {
  /** The check that did not run, who approved skipping it, and the card it was approved on. */
  skippedCheck: SkippedMergeCheckRecord;
}

/**
 * The owner skipped the landing check of a landing that was still in flight (§2.4 J-S5): the
 * generation in flight was stopped, and the next one lands without the check.
 */
export interface InFlightLandingSkipped {
  taskId: string;
  /** The generation that was in flight, and was stopped for this. */
  stoppedJobId: string;
  /** QUEUED: the stopped generation ended on the spot and the one without the check is queued.
   *  STOPPING: its runner was asked to stop, and the one without the check is queued when it
   *  answers — unless that answer is that it landed. */
  state: 'QUEUED' | 'STOPPING';
  /** The generation without the check, once queued; null while STOPPING. */
  jobId: string | null;
  generation: number | null;
  landingSessionId: string | null;
  reason: string;
  skippedCheck: SkippedMergeCheckRecord;
}

/** A blocked candidate's check the coordinator ran again (§4.7 H1), as `integration_retry` with a
 *  `promotionId` answers it. */
export interface PromotionCheckRetried {
  promotionId: string;
  /** The check this rerun queued. */
  jobId: string;
  generation: number;
  /** The landing session of the round this check belongs to (§2.9), or null where no subject was
   *  opened for it (a candidate with no source session on a MAIN line). */
  landingSessionId: string | null;
  /** The failed job it reruns — the candidate's check or its landing — and what that one failed of. */
  retryOfJobId: string;
  failureClass: LandingRetryFailureClass;
  reason: string;
  /** The coordinator's open items about the candidate, now being handled by this check. */
  handlingItemIds: string[];
}

/** The integration view the owner's Retry answers with, and the landing session the rerun queued
 *  (§2.9). The generation is in the view as well; this says which landing it opened, so the press
 *  and the six doors that answer an `IntegrationRetried` all name one address. */
export interface IntegrationRetriedView extends ProjectIntegrationView {
  landingSessionId: string | null;
}

/** What the owner's LAND_TASK stop (J-T8) left the job as. */
export interface TaskIntegrationStop {
  taskId: string;
  jobId: string;
  /** CANCELLED: a queued generation ended on the spot. CANCELLING: a live claim was asked, and its
   *  runner answers (J-T12). ERROR: a claim already past its lease was ended with J12's code. */
  state: 'CANCELLED' | 'CANCELLING' | 'ERROR';
  /** J12's answer when the generation was ended on the spot; null when it was only asked. */
  errorCode: 'RUNNER_LOST' | 'PUSH_OUTCOME_UNKNOWN' | null;
}

/** The project's open exceptions, split by who is expected to act (§4.8), and the coordinator's
 *  open requests to start it and to record it done — beside them rather than among them
 *  (`ProjectOpenItemsView`) — plus what the coordinator closed in the last day (§4.7 H5) and the
 *  questions that have ended (§5.2 R10, R12). */
export interface ProjectOpenItems {
  needsYou: OpenItemRow[];
  withCoordinator: OpenItemRow[];
  /** "Being fixed by its session" (revision 42, §12.7): the landing failures in their task's own work session's
   *  hands — nobody's Needs you, and not the coordinator's yet. */
  withWorkSession: OpenItemRow[];
  startRequest: OpenItemRow | null;
  doneRequest: OpenItemRow | null;
  latestDoneRequestDecline: { note: string; declinedAt: Date } | null;
  latestDoneRequestSuperseded: { reason: string; supersededAt: Date } | null;
  settled: OpenItemRow[];
  closedQuestions: ProjectClosedQuestion<Date>[];
  /** The main branch a row's merge into main goes into; null with no repository bound. */
  mainBranch: string | null;
  /** The sign-ins the project's held tasks wait for, one per runner and engine (`projectSignInWaits`). */
  signIns: ProjectSignInWait[];
  /** The tasks held because no account can run them, as one row (`projectAccountWait`). */
  accountWait: ProjectAccountWait<Date> | null;
}

/** The hold of one task, as the project row needs it (TasksService.accountHolds). */
import type { ModelRoutingHold } from '../tasks/model-routing';
export interface AccountHoldRead {
  reason: string;
  until: string;
}

/**
 * The project's account holds as its one Needs you row: "N tasks wait for an account" over the sentence of the hold that
 * lifts first. Null when no task is held.
 */
export function projectAccountWait(holds: ReadonlyMap<string, AccountHoldRead>): ProjectAccountWait<Date> | null {
  if (holds.size === 0) return null;
  const first = [...holds.values()].sort((a, b) => a.until.localeCompare(b.until))[0];
  const n = holds.size;
  return {
    taskIds: [...holds.keys()],
    title: n === 1 ? '1 task waits for an account' : `${n} tasks wait for an account`,
    detailLine: first.reason,
    until: new Date(first.until),
  };
}

/** The one read of TasksService this service makes: the sweep's signed-out holds (TasksService.signInHolds). */
export interface SignInHoldReader {
  signInHolds(ownerId: string, scope: Prisma.Sql): Promise<Map<string, TaskSignInHold>>;
}

/**
 * The project's sign-in holds as its Needs you rows: one per runner and engine, its tasks in the order
 * the sweep offers them, "N tasks wait for a sign-in" over "Claude Code is signed out on mac".
 */
export function projectSignInWaits(holds: ReadonlyMap<string, TaskSignInHold>): ProjectSignInWait[] {
  const byPair = new Map<string, ProjectSignInWait>();
  for (const [taskId, hold] of holds) {
    const key = `${hold.runnerId}\u0000${hold.engine}`;
    let wait = byPair.get(key);
    if (!wait) {
      wait = {
        engine: hold.engine,
        engineLabel: hold.engineLabel,
        runnerId: hold.runnerId,
        runnerName: hold.runnerName,
        taskIds: [],
        title: '',
        detailLine: `${hold.engineLabel} is signed out on ${hold.runnerName}`,
      };
      byPair.set(key, wait);
    }
    wait.taskIds.push(taskId);
  }
  return [...byPair.values()].map((wait) => {
    const n = wait.taskIds.length;
    return { ...wait, title: n === 1 ? '1 task waits for a sign-in' : `${n} tasks wait for a sign-in` };
  });
}

/** How far back `settled` reaches, and how many it holds at most (§4.7 H5): enough for the card a
 *  conversation drew to be seen changing state, not a history of the project. */
const SETTLED_WITHIN_MS = 24 * 60 * 60 * 1_000;
const SETTLED_SHOWN = 20;

/** How many ended questions the read carries (§4.8): a count and not a window of days, because a
 *  question's record is drawn wherever it ended, and a quiet week must not take the last ones
 *  out of the conversation they were asked in. */
const CLOSED_QUESTIONS_SHOWN = 50;

/** The item stopped being owed to the coordinator while its turn was being written. */
class OpenItemNoLongerOwed extends Error {}

/** The item left the work session's hands, or its task left DONE, while the landing-fix turn was being
 *  written: nothing is delivered, and whatever moved it decides what happens next. */
class LandingFixNoLongerOwed extends Error {}

/** The work session ended some other way than with its task's DONE (§12.5 W6, R3): it is not revived. */
class LandingFixSessionEnded extends Error {}

export type { LandingFixReturnReason } from './project-open-item';

/**
 * The resume refusals (`session-recovery.ts`) that say the session cannot get its runner, or cannot be run again at all
 * (R3: the same runner or none): the round fails, TURN_FAILED. Trash and an end in progress are a person's, SESSION_ENDED.
 */
const RESUME_REFUSED_TURN_FAILED: ReadonlySet<string> = new Set([
  'NO_RUNNER', 'RUNNER_OFFLINE', 'NOT_STARTED', 'MISSING_CONTEXT', 'NOT_TERMINAL',
]);

/** How many times `offerLandingFix` offers a turn refused with a 409 that is no answer about the session (a row
 *  being written a moment), and how long it waits before the next, times the attempt, before handing it back. */
const LANDING_FIX_DELIVERY_ATTEMPTS = 3;
const LANDING_FIX_RETRY_MS = 200;

/** Which hand-back a refused landing-fix delivery is (W7, R3), or null for a refusal that is no answer about the
 *  session — a lock held a moment, a key with other words — which `offerLandingFix` retries, then hands back. */
function landingFixRefusalReturn(error: unknown): LandingFixReturnReason | null {
  if (error instanceof LandingFixSessionEnded || error instanceof SessionNotSendable || error instanceof NotFoundException) {
    return 'SESSION_ENDED';
  }
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse() as { code?: unknown; resumeBlockedReason?: unknown } | string;
  if (typeof body !== 'object' || body === null) return null;
  if (body.code === 'MANAGED_RUNNER_FAILED') return 'TURN_FAILED';
  if (typeof body.resumeBlockedReason !== 'string') return null;
  return RESUME_REFUSED_TURN_FAILED.has(body.resumeBlockedReason) ? 'TURN_FAILED' : 'SESSION_ENDED';
}

/** The open-item kinds whose card is translated for the owner (Settings › Translation), and which of the payload's
 *  fields are the agent's words (sessions/card-translation.ts). */
const TRANSLATED_ITEM_FIELDS: Readonly<Partial<Record<string, CardFields>>> = {
  COORDINATOR_QUESTION: COORDINATOR_QUESTION_FIELDS,
  START_REQUEST: START_REQUEST_FIELDS,
  DONE_REQUEST: DONE_REQUEST_FIELDS,
};

/** The fields translated on an open item's card: its kind's payload fields, and the coordinator's hand-over note
 *  (`handoverNote`, beside the payload) on an item handed to the owner. Undefined when nothing is translated. */
function itemTranslatedFields(kind: string, handoverNote: string | null | undefined): CardFields | undefined {
  const fields = TRANSLATED_ITEM_FIELDS[kind];
  if (!handoverNote?.trim()) return fields;
  return { ...fields, handoverNote: true };
}

/** W9 (revision 42, §12.5): the coordinator's and owner's resolve and retry doors refuse an item in its
 *  task's own work session's hands. */
function withWorkSession(): ConflictException {
  return new ConflictException({ code: OPEN_ITEM_WITH_WORK_SESSION, message: OPEN_ITEM_WITH_WORK_SESSION_MESSAGE });
}

/** The rows a hand-close may write: not offered to a work session, or handed back from it (W9). */
const NOT_WITH_WORK_SESSION = {
  OR: [{ workSessionOfferedAt: null }, { workSessionReturnedAt: { not: null } }],
} satisfies Prisma.ProjectOpenItemWhereInput;

/**
 * Exception items after the fact that opened them has committed: delivering them to the project's
 * coordinator, handing them to the owner when there is nobody to deliver to, closing them when the
 * task they are about has moved on, and reading them back
 * (`docs/project-integration-line-contract.md` §4.4, §4.8).
 *
 * WHY DELIVERY IS NOT A WAKE. An item is a durable row with an assignee; the turn is only how the
 * assignee is told. So it goes through `SessionsService.createTurn` (§0.3 G6) — the same door every
 * other turn takes — and not through the wake ledger: no idempotency key to spend, nothing to
 * refuse, and a busy conversation is not a refusal but a queue (§4.4 X-D3). A coordinator's own turn
 * ending is where anything still owed is handed over, which is the compensation point for a process
 * that died between the fact's commit and its delivery.
 *
 * Nothing here ever fails its caller: every method is called after somebody else's write has already
 * committed, and a delivery that could not be made is re-derived from the same rows at the next
 * chance rather than rolling back a task's failure.
 */
@Injectable()
export class ProjectOpenItemService {
  private readonly logger = new Logger(ProjectOpenItemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    /** Tells the owner's phone about the items that become theirs (§7.6 V12). `@Optional()` because
     *  a notification is one reader of an item and never a condition of filing one: a build without
     *  PushModule — every spec that assembles this service by hand — writes the same rows. */
    @Optional() private readonly push?: PushService,
    /** Tells the owner's clients to read the project's items again once a card's translation is stored.
     *  Optional for the reason `push` is: a translation is a reader of an item, never a condition of it. */
    @Optional() private readonly realtime?: RealtimeService,
    /** How the running server finds TasksService for the sign-in holds (`signIns`) without this module importing
     *  TasksModule, which imports this one's slices: resolved at call time, as MergeReceiptService resolves it. */
    @Optional() private readonly moduleRef?: ModuleRef,
    /** A pg fixture's own reader of the holds; the running server's is TasksService, through `moduleRef`. */
    @Optional() private readonly signInHoldReader?: SignInHoldReader,
  ) {}

  /**
   * The auto-run sweep's sign-in holds among the owner's tasks `scope` names (TasksService.signInHolds), for the
   * project's reads: none when no reader is reachable (a build without TasksModule).
   */
  async signInHolds(ownerId: string, scope: Prisma.Sql): Promise<Map<string, TaskSignInHold>> {
    let reader = this.signInHoldReader;
    if (!reader) {
      try {
        // Loaded at call time: tasks.service imports this file, so a static import would be a cycle
        // that leaves one of the two classes undefined while the other's metadata is written.
        const { TasksService } = await import('../tasks/tasks.service.js');
        reader = this.moduleRef?.get(TasksService, { strict: false });
      } catch {
        reader = undefined;
      }
    }
    return reader ? reader.signInHolds(ownerId, scope) : new Map();
  }

  /** `accountHold` of each of these tasks (TasksService.accountHoldsFor), for a project's task rows; none without a reader. */
  async accountHoldsFor(ownerId: string, taskIds: readonly string[]): Promise<Map<string, ModelRoutingHold>> {
    try {
      const { TasksService } = await import('../tasks/tasks.service.js');
      const tasks = this.moduleRef?.get(TasksService, { strict: false });
      return tasks ? await tasks.accountHoldsFor(ownerId, taskIds) : new Map();
    } catch {
      return new Map();
    }
  }

  /** The project's tasks held for an account (TasksService.accountHolds), one row; none when no reader is reachable. */
  private async accountWait(ownerId: string, projectId: string): Promise<ProjectAccountWait<Date> | null> {
    try {
      const { TasksService } = await import('../tasks/tasks.service.js');
      const tasks = this.moduleRef?.get(TasksService, { strict: false });
      return tasks ? projectAccountWait(await tasks.accountHolds(ownerId, projectId)) : null;
    } catch {
      return null;
    }
  }

  /** The project's sign-in waits, one per runner and engine. */
  private async signInWaits(ownerId: string, projectId: string): Promise<ProjectSignInWait[]> {
    return projectSignInWaits(await this.signInHolds(ownerId, Prisma.sql`t.project_id = ${projectId}::uuid`));
  }

  /**
   * §4.4 X-D4 (1): the transaction that opened items about these tasks has committed.
   *
   * Reads which items are actually owed rather than taking the caller's word for it, so a door that
   * reports "the task was reclaimed" without knowing whether an item was opened is still right.
   */
  async deliverForTasks(taskIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(taskIds);
    if (ids.length === 0) return;
    await this.guarded('deliverForTasks', async () => {
      const owed = await this.prisma.projectOpenItem.findMany({
        where: { taskId: { in: ids }, state: 'OPEN', assignee: 'COORDINATOR' },
        select: { id: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      for (const item of owed) await this.deliver(item.id);
      // The other half of "the assignee is always told": a failure opened with the OWNER on it
      // already — no coordinator to read it, the conversation ended, or the chain ran out (§4.5
      // X-C3) — is delivered to nobody, because a person is not a queue. Their devices are told
      // instead (§7.6 V12). Read the same way the deliveries above are: from the committed rows,
      // so a door that does not know whether it opened one is still right. A repeat is collapsed
      // on the item by APNs rather than stacking a second banner about one waiting thing.
      // Not a `LANDED_WITHOUT_CONFIRMATION`: it is no failure, and it is pushed exactly once, after
      // the commit of the receipt that opened it (`MergeReceiptService.deliverProjectFactsAfterCommit`).
      const mine = await this.prisma.projectOpenItem.findMany({
        where: {
          taskId: { in: ids }, state: 'OPEN', assignee: 'OWNER', kind: { not: LANDED_WITHOUT_CONFIRMATION_KIND },
          // W5: an item in the task's own work session's hands asks nothing of the owner yet.
          OR: [{ workSessionOfferedAt: null }, { workSessionReturnedAt: { not: null } }],
        },
        select: { id: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      for (const item of mine) void this.push?.notifyOwnerItem(item.id);
    });
  }

  /**
   * §4.4 X-D4 (1), for items whose caller is holding them by id.
   *
   * A promotion job names no task (§3.4 writes `task_id` NULL on purpose), so the item such a job
   * opens cannot be found by one — the caller that opened it is the only thing in the system that
   * knows it exists, and this is how it hands it over. Everything else is `deliverForTasks`: the
   * same re-derivation from committed rows, and the same delivery.
   */
  async deliverForItems(itemIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(itemIds);
    if (ids.length === 0) return;
    await this.guarded('deliverForItems', async () => {
      const owed = await this.prisma.projectOpenItem.findMany({
        where: {
          id: { in: ids },
          state: 'OPEN',
          // W5: an item handed to its task's own work session goes to that session (`deliver`'s seam).
          OR: [{ assignee: 'COORDINATOR' }, { workSessionOfferedAt: { not: null }, workSessionReturnedAt: null }],
        },
        select: { id: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      for (const item of owed) await this.deliver(item.id);
    });
  }

  /**
   * §4.4 X-D4 (3): a conversation's turn has just ended. If it is a project's coordinator, hand over
   * everything that project still owes it.
   *
   * This is the guarantee's backstop, and the reason an item does not depend on the next task write:
   * whatever was recorded while this conversation was busy — or while whoever recorded it died before
   * delivering — is queued here, on the committed fact of its turn ending.
   */
  async deliverOwedTo(sessionId: string): Promise<void> {
    await this.guarded('deliverOwedTo', async () => {
      const project = await this.prisma.project.findUnique({
        where: { coordinatorSessionId: sessionId },
        select: { id: true },
      });
      if (!project) return;
      await this.deliverOwed(project.id);
    });
  }

  /**
   * Everything this project owes its coordinator, delivered once each.
   *
   * Items whose task has meanwhile moved on are resolved first, so a coordinator bound to a project
   * with a long history is not handed a queue of answered questions.
   */
  async deliverOwed(projectId: string): Promise<void> {
    await this.guarded('deliverOwed', async () => {
      await this.deliverAnsweredQuestions(projectId);
      const owed = await this.prisma.projectOpenItem.findMany({
        where: { projectId, state: 'OPEN', assignee: 'COORDINATOR' },
        select: { id: true, assignedAt: true, taskId: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      if (owed.length === 0) return;
      await this.resolveByFact(owed.map((item) => item.taskId));
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      const sessionId = project?.coordinatorEnabled ? project.coordinatorSessionId : null;
      const sent = sessionId
        ? await this.prisma.projectOpenItemDelivery.findMany({
            where: {
              sessionId,
              purpose: 'ITEM',
              returnedAt: null,
              itemId: { in: owed.map((item) => item.id) },
            },
            select: { itemId: true, clientTurnId: true },
          })
        : [];
      const already = new Set(sent.map((delivery) => `${delivery.itemId}:${delivery.clientTurnId}`));
      for (const item of owed) {
        if (already.has(`${item.id}:${openItemTurnId(item.id, item.assignedAt)}`)) continue;
        await this.deliver(item.id);
      }
    });
  }

  /**
   * W6 (§12.5, revision 42, ruling R3): deliver the `landing-fix:v1:<jobId>` turn to the work session an
   * item was handed to. Reached after the hand-off's J-T7 transaction has committed, through every
   * delivery entry point (`deliverForItems` from the result route, `deliverOwed` as the backstop, and the
   * session's own finish, `offerLandingFixesTo`), in place of the coordinator's delivery.
   *
   * The turn is the carrier G6 names: `createTurn` with NEXT_TURN for a session that is still open, and
   * for one that ended because its task was done, the resume path `session_send`'s `resumeIfEnded` takes
   * (`SessionsService.resume`), which revives it first — `createTurn` refuses an ended session before its
   * hook runs. That is G6's one exception (`platformTurnRevives`): a session that ended any other way is
   * not revived, and the item is handed back with SESSION_ENDED (W7, `returnLandingFix`).
   *
   * In the transaction that writes the turn (`acceptLandingFix`), R2: the task's delivered identity is
   * cleared the way `task_reopen` clears it, so the finish of this session freezes it again from the work
   * as it then stands (§10.5 O-L4 3). The task stays DONE: no epoch, no attempt generation, no evidence,
   * no acceptance. The turn runs outside the project's task budget, which counts only tasks that are not
   * DONE; and it is the work session's, so none of the coordinator's spend (§6.1) moves for it.
   *
   * Once: the turn row under its key is the receipt, so a delivery that finds it writes nothing — a
   * session the turn revived, that ended again when its turn did, is not revived a second time.
   */
  async offerLandingFix(itemId: string, attempt = 1): Promise<void> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true, state: true, ownerId: true, projectId: true, taskId: true, title: true, payload: true,
        integrationJobId: true, workSessionId: true, workSessionOfferedAt: true, workSessionReturnedAt: true,
      },
    });
    if (!item || item.state !== 'OPEN' || !inWorkSessionHands(item)) return;
    if (!item.workSessionId || !item.integrationJobId) return;
    const sessionId = item.workSessionId;
    // W7: a task reopened, cancelled, replaced or moved to another project since is TASK_MOVED_ON, whichever door
    // moved it — the task-update transaction hands back what it sees, and this read is the backstop for the rest.
    if (await this.taskMovedOn(item.projectId, sessionId)) {
      await this.returnLandingFix(item.id, 'TASK_MOVED_ON');
      return;
    }
    const clientTurnId = landingFixTurnId(item.integrationJobId);
    const delivered = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
      select: { id: true },
    });
    if (delivered) return;
    const facts = await readLandingFixFacts(this.prisma, {
      integrationJobId: item.integrationJobId, title: item.title, payload: item.payload,
    });
    if (!facts) return;
    const content = landingFixMessage(facts);

    // The task is the work session's (W4 held it to the job's), which a MAIN line's candidate item names
    // only through its candidate.
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { taskId: true, finishedAt: true, endReason: true, deletedAt: true, cancelRequestedAt: true },
    });
    if (!session) {
      await this.returnLandingFix(item.id, 'SESSION_ENDED');
      return;
    }
    if (!session.taskId || (item.taskId !== null && item.taskId !== session.taskId)) return;
    const taskId = session.taskId;
    // Ending because its task is done (parked-session-end.ts): its finish is a moment away, and the
    // finish delivers this (`offerLandingFixesTo`), reviving it then.
    if (this.endingForItsDone(session)) return;
    const ended = session.finishedAt !== null || session.cancelRequestedAt !== null || session.deletedAt !== null;
    if (ended && !platformTurnRevives(clientTurnId, session)) {
      await this.returnLandingFix(item.id, 'SESSION_ENDED');
      return;
    }
    const turn = { clientTurnId, content, intent: 'NEXT_TURN' as const };
    const participateSendTransaction = (tx: Prisma.TransactionClient) =>
      this.acceptLandingFix(tx, { itemId: item.id, sessionId, taskId, clientTurnId });
    try {
      if (session.finishedAt !== null) {
        await this.sessions.resume(item.ownerId, sessionId, turn, { participateSendTransaction });
      } else {
        await this.sessions.createTurn(item.ownerId, sessionId, turn, { participateSendTransaction });
      }
    } catch (error) {
      if (error instanceof LandingFixNoLongerOwed) {
        // Its task left DONE while the turn was being written, or the item left the session's hands.
        if (await this.taskMovedOn(item.projectId, sessionId)) await this.returnLandingFix(item.id, 'TASK_MOVED_ON');
        return;
      }
      // R3: a session ended some other way, or in Trash, is SESSION_ENDED; one whose runner it cannot get, or that
      // cannot be run again, is TURN_FAILED. The identity was not cleared (the hook's write rolled back with the turn).
      const reason = landingFixRefusalReturn(error);
      if (reason) {
        // Read again: a session caught on its way to its DONE's end is revived at its finish instead.
        const now = await this.prisma.session.findUnique({
          where: { id: sessionId },
          select: { finishedAt: true, endReason: true, deletedAt: true, cancelRequestedAt: true },
        });
        if (now && this.endingForItsDone(now)) return;
        await this.returnLandingFix(item.id, now ? reason : 'SESSION_ENDED');
        return;
      }
      // A row being written right now (409): offered again from the top, a moment later.
      if (error instanceof ConflictException && attempt < LANDING_FIX_DELIVERY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, LANDING_FIX_RETRY_MS * attempt));
        return this.offerLandingFix(itemId, attempt + 1);
      }
      // Anything else — a conflict that outlasted its retries, a turn the session door refuses outright (a message over
      // its size limit), an error — is not delivered, and nothing would offer it again: the session has finished, and
      // the coordinator's turn ends never reach an item in the session's hands. So it is handed back now (TURN_FAILED),
      // with its escalation time, rather than held with no turn and every door refusing OPEN_ITEM_WITH_WORK_SESSION.
      this.logger.warn(`landing fix ${clientTurnId} was not delivered to ${sessionId}, handed back: `
        + `${error instanceof Error ? error.message : String(error)}`);
      await this.returnLandingFix(item.id, 'TURN_FAILED');
    }
  }

  /**
   * After a work session's finish has committed: every item in its hands, offered again — its finish is where an end in
   * progress is over — and every item the finish handed back from it (W7), delivered to the coordinator at once. A MAIN
   * line's item names no task, so `deliverForTasks` would not find it. TASK_MOVED_ON is delivered to nobody.
   */
  async offerLandingFixesTo(sessionId: string): Promise<void> {
    await this.guarded('offerLandingFixesTo', async () => {
      const items = await this.prisma.projectOpenItem.findMany({
        where: {
          state: 'OPEN', workSessionId: sessionId, workSessionOfferedAt: { not: null },
          OR: [
            { workSessionReturnedAt: null },
            { assignee: 'COORDINATOR', workSessionReturnReason: { not: 'TASK_MOVED_ON' } },
          ],
        },
        select: { id: true, assignedAt: true, workSessionReturnedAt: true },
        orderBy: { id: 'asc' },
      });
      for (const item of items) {
        if (item.workSessionReturnedAt === null) {
          await this.offerLandingFix(item.id);
          continue;
        }
        const sent = await this.prisma.projectOpenItemDelivery.findFirst({
          where: { itemId: item.id, purpose: 'ITEM', clientTurnId: openItemTurnId(item.id, item.assignedAt) },
          select: { itemId: true },
        });
        if (!sent) await this.deliver(item.id);
      }
    });
  }

  /**
   * Whether the task this work session ran has moved on from the failed landing it holds (W7, TASK_MOVED_ON): no longer
   * DONE (reopened, cancelled, failed), replaced by a successor, or no longer in the item's project.
   */
  private async taskMovedOn(projectId: string, sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { task: { select: { status: true, supersededByTaskId: true, projectId: true } } },
    });
    const task = session?.task;
    if (!task) return false;
    return task.status !== 'DONE' || task.supersededByTaskId !== null || task.projectId !== projectId;
  }

  private endingForItsDone(session: { finishedAt: Date | null; endReason: string | null; cancelRequestedAt: Date | null; deletedAt: Date | null }): boolean {
    return session.finishedAt === null && session.cancelRequestedAt !== null && session.deletedAt === null
      && session.endReason === 'task_done';
  }

  /**
   * The landing-fix turn's own write, inside `createTurn`'s (or `resume`'s) transaction, under the session
   * lock it holds and before the turn row: the item still in this session's hands and its task still DONE,
   * the session not ended some other way (R3: `resume` would revive those too), and R2 — the task's
   * delivered identity cleared, as `task_reopen` clears it, in the transaction the turn is written in. A
   * refusal rolls the revive and the turn back with it.
   */
  private async acceptLandingFix(
    tx: Prisma.TransactionClient,
    input: { itemId: string; sessionId: string; taskId: string; clientTurnId: string },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: input.sessionId },
      select: { finishedAt: true, endReason: true, deletedAt: true, cancelRequestedAt: true },
    });
    if (session.deletedAt !== null) throw new LandingFixSessionEnded();
    if (session.finishedAt !== null && !platformTurnRevives(input.clientTurnId, session)) {
      throw new LandingFixSessionEnded();
    }
    // The task row (rank 50) before the item (rank 60), after the session this transaction holds (rank 30).
    const cleared = await tx.task.updateMany({
      where: { id: input.taskId, status: 'DONE' },
      data: DELIVERED_IDENTITY_CLEARED,
    });
    if (cleared.count === 0) throw new LandingFixNoLongerOwed();
    const [held] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "project_open_item"
       WHERE "id" = ${input.itemId}::uuid
         AND "state" = 'OPEN'
         AND "work_session_id" = ${input.sessionId}::uuid
         AND "work_session_offered_at" IS NOT NULL
         AND "work_session_returned_at" IS NULL
       FOR NO KEY UPDATE`);
    if (!held) throw new LandingFixNoLongerOwed();
  }

  /**
   * W7's hand-back (§12.5, W-T5) for the facts that are no session's finish: W6's delivery refused — SESSION_ENDED for
   * a session gone, in Trash or ended some other way than with its task's DONE; TURN_FAILED for one whose runner it
   * cannot get (R3) — and a task that moved on, TASK_MOVED_ON. The item leaves the work session's hands
   * (`handBackLandingFix`: `work_session_returned_at`, the reason, `workSession` on the payload, `waiting_since` and
   * `escalate_at` from now) and is delivered to the coordinator by X-D4 at once — except TASK_MOVED_ON, which §4.2's
   * facts answer and nobody is told about.
   *
   * No identity to freeze again here: W6 clears it only in the transaction that writes the turn, so a refused delivery
   * never cleared it, and a session that got the turn hands back at its finish, whose settlement freezes it first
   * (`landAgainAfterLandingFix`).
   */
  async returnLandingFix(itemId: string, reason: LandingFixReturnReason): Promise<void> {
    const written = await withTransactionRetry(
      this.prisma,
      (tx) => handBackLandingFix(tx, { itemId, reason }),
      loggedRetry(this.logger, 'projectOpenItem.returnLandingFix'),
    );
    if (written && reason !== 'TASK_MOVED_ON') await this.deliver(itemId);
  }

  /**
   * Queue one item on the conversation that coordinates its project (§4.4 X-D1, X-D2).
   *
   * The conversation is read at THIS moment rather than when the item was opened: a project that
   * rotated its coordinator owes the item to the one it has now. A conversation that has ended, or a
   * project that no longer has one, means the item is the owner's — which is the same answer §4.3
   * gives when the item is opened, reached later. One that is only down (`conversationIsDown`)
   * keeps it, undelivered, until a turn of its own ends.
   */
  async deliver(itemId: string, askedBy: DeliverAskedBy = 'AUTOMATIC'): Promise<void> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        assignedAt: true,
        title: true,
        payload: true,
        taskId: true,
        promotionId: true,
        projectId: true,
        ownerId: true,
        handlingJobId: true,
        integrationJobId: true,
        workSessionOfferedAt: true,
        workSessionReturnedAt: true,
        workSessionReturnReason: true,
        project: { select: { coordinatorEnabled: true, coordinatorSessionId: true } },
      },
    });
    if (!item || item.state !== 'OPEN') return;
    // W7: handed back because its task moved on — reopened, cancelled or replaced. §4.2's facts answer it, and nobody
    // is told about it in the meantime.
    if (item.workSessionReturnReason === 'TASK_MOVED_ON') return;
    // Revision 42 (§12.5 W5, X-D4): an item in its task's own work session's hands is that session's,
    // not the coordinator's, until it is handed back (W7) — whoever asks, and whichever assignee the
    // item will have once it is handed back (W10: the hand-off does not read the Automatic switch).
    if (inWorkSessionHands(item)) {
      await this.offerLandingFix(item.id);
      return;
    }
    if (item.assignee !== 'COORDINATOR') return;
    // H1 is a live hand-off, not a second delivery. A terminal handling job deliberately falls
    // through (the item may need a fresh decision), but QUEUED/RUNNING rows stay out of every
    // coordinator delivery entry point, including an owner's explicit "ask again" press.
    if (item.handlingJobId) {
      const handling = await this.prisma.projectIntegrationJob.findUnique({
        where: { id: item.handlingJobId },
        select: { state: true },
      });
      if (handling && isInFlightJobState(handling.state)) return;
    }
    // THE SWITCH DECIDES AUTOMATIC HAND-OVERS, AND ONLY THOSE. `coordinatorEnabled` is the owner
    // saying the coordinator may not act on its own, and an item handed over by the platform is
    // exactly that. The owner's own press is not: it is that same person saying "put this one in
    // front of it", about one item, now — the authority is already theirs, and the switch stays
    // theirs to use. So the press needs the conversation to exist and nothing else, which is what
    // makes `ASK_COORDINATOR_AGAIN` a button rather than a treadmill: gated on the switch too, the
    // press would land back on the owner on the next line (`handToOwner`, below) and the item would
    // be exactly where it started — the clock the door's own comment used to refuse over.
    const sessionId = askedBy === 'OWNER' || item.project.coordinatorEnabled
      ? item.project.coordinatorSessionId
      : null;
    if (!sessionId) {
      // A TURN THAT IS ALREADY WRITTEN IS NOT THE PLATFORM REACHING FOR A COORDINATOR. The switch
      // decides THIS delivery; an item whose assignment has already been put in front of the
      // project's conversation is not one of those — its turn exists (queued, or read and answered),
      // and the consent that paid for it was spent when that turn was written: by the owner's own
      // press, or by an automatic hand-over made while the switch was on. Handing it back here is a
      // reader re-deciding an assignment nobody asked it to re-decide, and it is what made the press
      // a treadmill with a longer stride than the one `returnToCoordinator` closed: press → the
      // coordinator reads it → the next drain takes it back → press again (the account owner's
      // report, 2026-09-22: the exemption held in the press's own call and nowhere else).
      if (await this.carried(item.id, item.assignedAt, item.project.coordinatorSessionId)) return;
      await this.handToOwner(item.id, item.assignedAt, 'NO_COORDINATOR');
      return;
    }
    // A platform delivery must not disarm an existing retry or revive a failed run.
    const coordinator = await this.prisma.session.findUnique({
      where: { id: sessionId }, select: COORDINATOR_PAUSE_SELECT,
    });
    if (coordinator && conversationIsPaused(coordinator)) return;
    const clientTurnId = openItemTurnId(item.id, item.assignedAt);
    const fixed = await this.landedFixesOf(item.id, item.integrationJobId);
    try {
      const turn = await this.sessions.createTurn(item.ownerId, sessionId, {
        clientTurnId,
        content: openItemMessage({
          id: item.id,
          kind: item.kind,
          title: item.title,
          projectId: item.projectId,
          taskId: item.taskId,
          promotionId: item.promotionId,
          payload: item.payload,
          landedFixes: fixed.landedFixes,
          failedSourceSha: fixed.failedSourceSha,
          workSessionReturnReason: item.workSessionReturnReason,
        }),
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => this.acknowledgeDelivery(tx, {
          itemId: item.id,
          projectId: item.projectId,
          assignedAt: item.assignedAt,
          sessionId,
          clientTurnId,
        }),
      });
      // The turn the delivery row names. Written after the commit because the row is written inside
      // it, before the turn exists; a process that dies here leaves a delivery whose turn is found
      // by its key, which is what every read below uses anyway.
      await this.prisma.projectOpenItemDelivery.updateMany({
        where: { itemId: item.id, sessionId, purpose: 'ITEM', clientTurnId, turnId: null },
        data: { turnId: turn.turnId },
      });
    } catch (error) {
      if (error instanceof OpenItemNoLongerOwed) return;
      // SessionNotSendable is a ConflictException, so it is asked about first.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) {
        // Down is not over: a conversation whose run failed is still the one to read this once it is
        // retried, and its next turn's end is where it is told (§4.4 X-D4 3) — or, if it does not
        // come back, the clock hands the item over (§4.6 X-E1). Read again rather than taken from the
        // refusal, which says only that this turn could not be written.
        if (error instanceof SessionNotSendable) {
          const session = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: SESSION_ENDING_SELECT,
          });
          if (session && !conversationIsOver(session)) return;
        }
        await this.handToOwner(item.id, item.assignedAt, 'COORDINATOR_ENDED');
        return;
      }
      if (error instanceof ConflictException) {
        // The key is held by a turn with a different body — this item was already queued by a build
        // that worded it differently. It reached the conversation; saying it twice would not help.
        this.logger.warn(`open item ${item.id} is already queued on ${sessionId} under ${clientTurnId}`);
        return;
      }
      throw error;
    }
  }

  /**
   * The fixes of this item whose landing is in, and the commit the item's own failed landing was
   * handed (§4.4 X-D4 5). Read only from rows that no longer change — a fix task's id and its latest
   * landing job once that job has ended — so the same key words the same text (G6). A landing that
   * answered about a branch the work did not end on is followed by the generation it queued, so the
   * latest job is the one that counts; a `NOTHING_TO_LAND` counts only with the receipt it writes
   * when the task has no work of its own anywhere.
   */
  private async landedFixesOf(
    itemId: string,
    failedJobId: string | null,
  ): Promise<{ landedFixes: LandedFix[]; failedSourceSha: string | null }> {
    const fixes = await this.prisma.task.findMany({ where: { fixesOpenItemId: itemId }, select: { id: true } });
    if (fixes.length === 0) return { landedFixes: [], failedSourceSha: null };
    const jobs = await this.prisma.projectIntegrationJob.findMany({
      where: { taskId: { in: fixes.map((fix) => fix.id) }, kind: 'LAND_TASK' },
      orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true, taskId: true, state: true, targetRef: true, landedSha: true, receiptIds: true, finishedAt: true,
      },
    });
    const latest = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) if (job.taskId && !latest.has(job.taskId)) latest.set(job.taskId, job);
    const landedFixes = [...latest.values()]
      .filter((job) => job.state === 'LANDED' || job.state === 'ALREADY_LANDED'
        || (job.state === 'NOTHING_TO_LAND' && job.receiptIds.length > 0))
      .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
      .map((job) => ({
        taskId: job.taskId!,
        jobId: job.id,
        state: job.state,
        targetRef: job.targetRef,
        landedSha: job.landedSha,
      }));
    if (landedFixes.length === 0) return { landedFixes, failedSourceSha: null };
    const failed = failedJobId
      ? await this.prisma.projectIntegrationJob.findUnique({ where: { id: failedJobId }, select: { sourceSha: true } })
      : null;
    return { landedFixes, failedSourceSha: failed?.sourceSha ?? null };
  }

  /**
   * A coordinator puts a question to the account owner (§5.2 R7–R9).
   *
   * The question is a durable item with the owner on it, not a message: the tool returns as soon as
   * it is filed, the conversation goes on with whatever else it can do, and the answer arrives later
   * as a turn. So a coordinator that needs a decision it has no authority to make is neither blocked
   * nor forced to guess — and what it asked stays readable after the conversation itself is gone.
   *
   * Only the conversation this project is coordinated from may ask, because the question is filed in
   * the project's name and shown to the owner as the project asking. Any other session — a task's
   * own run, a coordinator of some other project — is refused rather than filed under a project it
   * does not speak for.
   *
   * The conversation, not the Automatic switch: a question is the coordinator asking the owner, not
   * acting for them, and the switch says how far the coordinator may act on its own. Before a
   * project starts is when a coordinator has the most to ask, and it asked nothing while this
   * required the switch — which a project that has not started need not have on.
   */
  async askOwner(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    asked: AskedQuestion & { clientQuestionId?: string },
  ): Promise<OpenItemAsked> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: {
        coordinatorSessionId: true,
        exceptionEscalationSeconds: true,
      },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    if (!asking || asking !== project.coordinatorSessionId) {
      throw new ForbiddenException({
        code: ASK_OWNER_COORDINATOR_ONLY,
        message:
          'only the conversation coordinating this project may put a question to its owner. A '
          + 'question is filed in the project’s name, so the session asking has to be the one the '
          + 'project points at.',
      });
    }
    let question: CoordinatorQuestion;
    try {
      question = coordinatorQuestion(asked);
    } catch (error) {
      if (error instanceof QuestionNotAskable) throw new BadRequestException(error.message);
      throw error;
    }
    // The tasks a question blocks are the account's own. Any other id is refused as one that names
    // nothing — and is never stored on the question, from where every coordinator rotation would read
    // whether that task is still open (`unsettledBlockedTasks`).
    if (question.blocksTaskIds.length > 0) {
      const own = await this.prisma.task.count({ where: { id: { in: question.blocksTaskIds }, ownerId } });
      if (own !== question.blocksTaskIds.length) {
        throw new NotFoundException('blocksTaskIds names a task this account does not have');
      }
    }
    // The caller's own key for this question, so a tool call retried after a lost response files
    // one question rather than asking the owner the same thing twice.
    const dedupeKey = `CQ:${asked.clientQuestionId?.trim() || randomKey()}`;
    const now = new Date();
    const created = await withTransactionRetry(this.prisma, async tx => {
      if (asked.forRunQuestion) {
        const request = await tx.sessionRequest.findFirst({ where: {
          id: asked.forRunQuestion, ownerId, toSessionId: asking, kind: 'RUN_QUESTION', state: 'OPEN',
        } });
        if (!request) throw new ConflictException({ code: 'RUN_QUESTION_NOT_OPEN', message: 'this run question is not open for this coordinator' });
      }
      const [created] = await tx.projectOpenItem.createManyAndReturn({
        data: [{
          projectId,
          ownerId,
          kind: 'COORDINATOR_QUESTION' satisfies OpenItemKind,
          state: 'OPEN',
          assignee: 'OWNER' satisfies OpenItemAssignee,
          // The owner is not who this ended up with; it is who it was always for.
          assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
          askedBySessionId: asking,
          dedupeKey,
          title: coordinatorQuestionTitle(question.question),
          payload: question as unknown as Prisma.InputJsonValue,
          waitingSince: now,
          assignedAt: now,
          // Nowhere to escalate to — it is already the owner's. The window becomes their one reminder.
          escalateAt: null,
          remindAt: new Date(now.getTime() + project.exceptionEscalationSeconds * 1_000),
        }],
        skipDuplicates: true,
        select: { id: true },
      });
      if (asked.forRunQuestion) {
        const item = created ?? await tx.projectOpenItem.findFirstOrThrow({ where: { projectId, dedupeKey, state: 'OPEN' }, select: { id: true } });
        const linked = await tx.sessionRequest.updateMany({ where: {
          id: asked.forRunQuestion, ownerId, toSessionId: asking, kind: 'RUN_QUESTION', state: 'OPEN',
        }, data: { escalatedItemId: item.id, replyBy: new Date(now.getTime() + 30 * 86400 * 1000) } });
        if (!linked.count) throw new ConflictException({ code: 'RUN_QUESTION_NOT_OPEN', message: 'this run question is no longer open' });
      }
      return created;
    }, loggedRetry(this.logger, 'projectOpenItem.askOwner'));
    if (created) {
      // R9: the question is filed and the owner is told, in that order and after the commit.
      void this.push?.notifyOwnerItem(created.id);
      // And translated for them in the background, when their translation is on (decision 1A).
      this.translateFiledItem(ownerId, projectId, created.id, 'question');
      return { itemId: created.id, state: 'OPEN' };
    }
    const already = await this.prisma.projectOpenItem.findFirst({
      where: { projectId, dedupeKey, state: 'OPEN' },
      select: { id: true },
    });
    if (already) return { itemId: already.id, state: 'OPEN' };
    // The key is held by a question that has since been answered. Asking again under a key that is
    // spent would file nothing and report success, so it is refused with the one thing to do about it.
    throw new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message: 'a question under this clientQuestionId was already answered; ask under a new one',
    });
  }

  /**
   * Queue the translation of one open item's card into the owner's language (sessions/card-translation.ts): stored
   * in `translation` while the item is still OPEN, and the project announced changed (`project.changed`, which
   * re-reads its open items) so clients swap the card in place. An item with nothing to translate (no
   * TRANSLATED_ITEM_FIELDS for its kind and no hand-over note), an item no longer open, or a translation of it into
   * that language already queued, translates nothing. Returns at once: true when it queued one.
   */
  /** After an item is filed: queue its card's translation when the owner's translation is on (decision 1A). Never
   *  awaited and never a reason the filing fails. */
  private translateFiledItem(ownerId: string, projectId: string, itemId: string, what: string): void {
    void translationLanguages(this.prisma, ownerId)
      .then((langs) => { if (langs) this.queueItemTranslation(ownerId, projectId, itemId, langs); })
      .catch((error: Error) => this.logger.warn(`translating ${what} ${itemId} failed to queue: ${error.message}`));
  }

  queueItemTranslation(ownerId: string, projectId: string, itemId: string, langs: TranslationLanguages): boolean {
    let note: string | null = null;
    return queueOwnerCardTranslation({
      key: `open-item:${itemId}`,
      read: async () => {
        const item = await this.prisma.projectOpenItem.findFirst({
          where: { id: itemId, ownerId, state: 'OPEN' },
          select: { kind: true, payload: true, translation: true, handoverNote: true },
        });
        if (!item) return null;
        // The coordinator's hand-over note is translated with the card, as `handoverNote`, on any kind.
        note = item.handoverNote;
        const fields = itemTranslatedFields(item.kind, note);
        if (!fields) return null;
        const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
        return { source: note ? { ...payload, handoverNote: note } : payload, fields, translation: item.translation };
      },
      // Stored only while the note is still the one translated: a hand-over while this ran queues its own.
      write: async (translation) => (await this.prisma.projectOpenItem.updateMany({
        where: { id: itemId, ownerId, state: 'OPEN', handoverNote: note },
        data: { translation: translation as unknown as Prisma.InputJsonValue },
      })).count > 0,
      published: () => this.realtime?.publishForUser(ownerId, RunEventType.PROJECT_CHANGED, projectId),
    }, langs);
  }

  /**
   * The coordinator asks the account owner to start the project (`project_request_start`,
   * `project-start-request.ts`).
   *
   * Filed and returned at once, like a question: the owner answers on the "Start this project?"
   * card, and the coordinator is told when the project starts (`project-started.ts`). Only the
   * conversation the project is coordinated from may ask — the conversation, not the Automatic
   * switch, which is one of the settings being asked for — and only before the project has started.
   *
   * One transaction under the project row (FOR NO KEY UPDATE, the lock the start door takes first):
   * a request and a start of the same project are ordered, so no request is filed about a project
   * that has just started. The plan is checked under it and a plan that is not ready is refused with
   * every finding, writing nothing; one that is ready supersedes the request already open, if any,
   * and files this one — unless it is that same request again, which writes nothing.
   *
   * The check's warnings are the COORDINATOR's, and only its: they come back in this answer and are
   * not filed with the request (the owner, 2026-10-07). Every one of them is about how the plan is
   * written — work that looks codeless, tasks set to start by hand, no merge check — which only the
   * coordinator can change, and a card that opened on a freshly planned project with a column of
   * warnings the owner could do nothing about was the experience being removed. So the stored
   * payload carries none, which is also what the two clients draw from.
   *
   * Automatic left out is on: the owner's card opens with it on whatever is sent, and a coordinator
   * that would keep it off says so in `why`. A main branch (`upstreamRef`) is kept as suggested, and
   * left out suggests none: the card then opens on this project's own choice, or this account's last
   * for the repository, or main (L6).
   */
  async requestStart(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    body: ProjectStartRequestBody,
  ): Promise<ProjectStartRequestFiled> {
    if (body.line === 'MAIN' && body.projectBranchName != null) {
      throw new BadRequestException(
        'a project that lands directly into main has no project branch to name',
      );
    }
    if (body.projectBranchName != null && body.projectBranchName === body.upstreamRef) {
      throw new BadRequestException('a project branch cannot be the upstream it integrates into');
    }
    const why = body.why?.trim();
    if (!why) {
      throw new BadRequestException(
        'why is required: the sentence the owner reads on the card about why the plan is ready',
      );
    }
    const settings: ProjectStartSettings = {
      ...(body.line !== undefined ? { line: body.line } : {}),
      ...(body.projectBranchName != null ? { projectBranchName: body.projectBranchName } : {}),
      ...(body.upstreamRef != null ? { upstreamRef: body.upstreamRef } : {}),
      automatic: body.automatic ?? true,
      maxConcurrentTasks: body.maxConcurrentTasks,
      ...(body.landingCheckCommand !== undefined ? { landingCheckCommand: body.landingCheckCommand } : {}),
      ...(body.landingCheckTimeoutSeconds !== undefined
        ? { landingCheckTimeoutSeconds: body.landingCheckTimeoutSeconds } : {}),
      mergeCheckCommand: body.mergeCheckCommand?.trim() || null,
      // Named or not named, never defaulted: a suggestion of the one-hour default and no suggestion
      // at all read the same on the card — an empty box says "one hour unless set" — so inventing
      // the number here would put a setting on the request that nobody chose.
      ...(body.mergeCheckTimeoutSeconds !== undefined
        ? { mergeCheckTimeoutSeconds: body.mergeCheckTimeoutSeconds }
        : {}),
    };
    const asking = actingSessionId?.trim();
    const filed = await withTransactionRetry(this.prisma, async (tx): Promise<ProjectStartRequestFiled> => {
      const [project] = await tx.$queryRaw<Array<{
        startedAt: Date | null;
        coordinatorSessionId: string | null;
      }>>(Prisma.sql`
        SELECT "started_at" AS "startedAt", "coordinator_session_id" AS "coordinatorSessionId"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');
      if (!asking || asking !== project.coordinatorSessionId) {
        throw new ForbiddenException({
          code: START_REQUEST_COORDINATOR_ONLY,
          message:
            'only the conversation coordinating this project may ask its owner to start it. The '
            + 'request is filed in the project’s name, so the session asking has to be the one the '
            + 'project points at.',
        });
      }
      if (project.startedAt) {
        throw new ConflictException({
          code: 'PROJECT_ALREADY_STARTED',
          startedAt: project.startedAt.toISOString(),
          message:
            'this project has already been started, so there is nothing to ask: nothing was filed. '
            + 'Its auto-run tasks start by themselves; start the ones set to start by hand with '
            + 'task_start.',
        });
      }
      const plan = await readStartPlan(tx, ownerId, projectId);
      const findings = startReadiness(plan, settings);
      const refusals = findings.filter((finding) => finding.severity === 'REFUSE');
      if (refusals.length > 0) {
        const notReady: ProjectStartNotReadyBody = {
          code: START_REQUEST_NOT_READY,
          message:
            `this plan is not ready to start: ${refusals.length} check`
            + `${refusals.length === 1 ? '' : 's'} refused it, and nothing was filed`,
          written: 0,
          findings,
        };
        throw new ConflictException(notReady);
      }
      const request: ProjectStartRequest = {
        settings,
        why,
        criteriaDigest: plan.criteriaDigest,
        planDigest: plan.planDigest,
        repository: plan.repository,
        // The coordinator's, returned below and not filed: see above.
        warnings: [],
      };
      const open = await tx.projectOpenItem.findFirst({
        where: { projectId, kind: START_REQUEST_KIND, state: 'OPEN' },
        select: { id: true, payload: true },
      });
      if (open && canonicalJson(open.payload) === canonicalJson(request)) {
        return {
          ...request,
          warnings: findings,
          itemId: open.id,
          state: 'OPEN',
          alreadyOpen: true,
          superseded: null,
        };
      }
      const now = new Date();
      // Named before either write, so the request it replaces can say which one did — a row that is
      // no longer OPEN is final (`project_open_item_terminal_guard`) and cannot be told afterwards.
      const itemId = randomUUID();
      if (open) {
        await tx.projectOpenItem.updateMany({
          where: { id: open.id, state: 'OPEN' },
          data: {
            state: 'SUPERSEDED',
            resolvedAt: now,
            resolvedBy: 'COORDINATOR',
            resolvedBySessionId: asking,
            supersededByItemId: itemId,
            resolutionNote: 'the coordinator asked again',
          },
        });
      }
      await tx.projectOpenItem.create({
        data: {
          id: itemId,
          projectId,
          ownerId,
          kind: START_REQUEST_KIND satisfies OpenItemKind,
          state: 'OPEN',
          assignee: 'OWNER' satisfies OpenItemAssignee,
          assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
          askedBySessionId: asking,
          dedupeKey: START_REQUEST_DEDUPE_KEY,
          title: START_REQUEST_TITLE,
          payload: request as unknown as Prisma.InputJsonValue,
          waitingSince: now,
          assignedAt: now,
          // The owner's from the start, so there is nobody to escalate to — and no reminder: the
          // card stays in front of them until they start the project or the plan moves.
          escalateAt: null,
        },
        select: { id: true },
      });
      return {
        ...request,
        warnings: findings,
        itemId,
        state: 'OPEN',
        alreadyOpen: false,
        superseded: open ? { itemId: open.id } : null,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.requestStart'));
    if (!filed.alreadyOpen) this.translateFiledItem(ownerId, projectId, filed.itemId, 'start request');
    return filed;
  }

  /**
   * The coordinator asks the account owner to record the project done (`project_request_done`,
   * `project-done-request.ts`).
   *
   * Filed and returned at once, like a start request: the owner answers on the "Is this project
   * done?" card. Only the conversation the project is coordinated from may ask, and only while the
   * project is OPEN.
   *
   * One transaction under the project row (FOR NO KEY UPDATE, the lock the owner's DONE takes
   * first): a request and the owner's record of the same project are ordered, so no request is filed
   * about a project that has just been recorded done. The project is checked under it, and one that
   * is not ready is refused with every finding, writing nothing; one that is supersedes the request
   * already open, if any, and files this one — unless it is that same request again, which writes
   * nothing.
   */
  async requestDone(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    body: RequestProjectDoneBody,
  ): Promise<ProjectDoneRequestFiled> {
    const judgment = typeof body.judgment === 'string' ? body.judgment.trim() : '';
    if (!judgment) {
      throw new BadRequestException(
        'judgment is required: your call on whether the project is done, in a sentence or two — the '
          + 'first thing the owner reads on the card',
      );
    }
    if (judgment.length > MAX_DONE_REQUEST_JUDGMENT) {
      throw new BadRequestException(`judgment is at most ${MAX_DONE_REQUEST_JUDGMENT} characters`);
    }
    const normalized = normalizeDoneRequestGaps(body.gaps);
    if ('problem' in normalized) throw new BadRequestException(normalized.problem);
    const { gaps } = normalized;
    const asking = actingSessionId?.trim();
    const filed = await withTransactionRetry(this.prisma, async (tx): Promise<ProjectDoneRequestFiled> => {
      const [project] = await tx.$queryRaw<Array<{
        status: string;
        coordinatorSessionId: string | null;
      }>>(Prisma.sql`
        SELECT "status"::text AS "status", "coordinator_session_id" AS "coordinatorSessionId"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');
      if (!asking || asking !== project.coordinatorSessionId) {
        throw new ForbiddenException({
          code: DONE_REQUEST_COORDINATOR_ONLY,
          message:
            'only the conversation coordinating this project may ask its owner to record it done. '
            + 'The request is filed in the project’s name, so the session asking has to be the one '
            + 'the project points at.',
        });
      }
      if (project.status !== 'OPEN') {
        throw new ConflictException(project.status === 'DONE'
          ? {
            code: 'PROJECT_ALREADY_DONE',
            message: 'this project is already recorded done, so there is nothing to ask: nothing was '
              + 'filed.',
          }
          : {
            code: 'PROJECT_CANCELLED',
            message: 'this project was cancelled, so there is nothing to ask: nothing was filed.',
          });
      }
      const state = await readDoneState(tx, ownerId, projectId, asking);
      const keys = new Set(state.criteria.map((criterion) => criterion.stated.key));
      const stray = gaps.findIndex((gap) => !keys.has(gap.criterionKey));
      if (stray >= 0) {
        throw new BadRequestException(
          `gaps[${stray}] names criterion ${gaps[stray].criterionKey}, which this project does not `
            + 'state: a gap is about one of the criteria project_get lists, by its key',
        );
      }
      const findings = doneReadiness(state, gaps);
      const refusals = findings.filter((finding) => finding.severity === 'REFUSE');
      if (refusals.length > 0) {
        const notReady: ProjectDoneNotReadyBody = {
          code: DONE_REQUEST_NOT_READY,
          message:
            `this project is not ready to be recorded done: ${refusals.length} check`
            + `${refusals.length === 1 ? '' : 's'} refused it, and nothing was filed`,
          written: 0,
          findings,
        };
        throw new ConflictException(notReady);
      }
      const declined = await tx.projectOpenItem.findFirst({
        where: { projectId, kind: DONE_REQUEST_KIND, state: 'RESOLVED', resolution: 'DECLINED' },
        orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
        select: { payload: true, resolutionNote: true },
      });
      const declinedRequest = declined?.payload as unknown as DoneRequest | undefined;
      if (declinedRequest?.stateDigest === state.stateDigest
        && declinedRequest.criteriaDigest === state.criteriaDigest) {
        throw new ConflictException({
          code: DONE_REQUEST_UNCHANGED_SINCE_DECLINE,
          message: `The owner said Not yet: "${declined!.resolutionNote}". `
            + 'Do the missing work first, then ask again once the project has changed and settled.',
          written: 0,
        });
      }
      const request = {
        criteriaDigest: state.criteriaDigest,
        stateDigest: state.stateDigest,
        judgment,
        gaps,
        warnings: findings,
      } satisfies DoneRequest;
      const open = await tx.projectOpenItem.findFirst({
        where: { projectId, kind: DONE_REQUEST_KIND, state: 'OPEN' },
        select: { id: true, payload: true },
      });
      if (open && canonicalJson(open.payload) === canonicalJson(request)) {
        return { ...request, itemId: open.id, state: 'OPEN', alreadyOpen: true, superseded: null };
      }
      const now = new Date();
      // Named before either write, so the request it replaces can say which one did — a row that is
      // no longer OPEN is final (`project_open_item_terminal_guard`) and cannot be told afterwards.
      const itemId = randomUUID();
      if (open) {
        await tx.projectOpenItem.updateMany({
          where: { id: open.id, state: 'OPEN' },
          data: {
            state: 'SUPERSEDED',
            resolvedAt: now,
            resolvedBy: 'COORDINATOR',
            resolvedBySessionId: asking,
            supersededByItemId: itemId,
            resolutionNote: 'the coordinator asked again',
          },
        });
      }
      await tx.projectOpenItem.create({
        data: {
          id: itemId,
          projectId,
          ownerId,
          kind: DONE_REQUEST_KIND satisfies OpenItemKind,
          state: 'OPEN',
          assignee: 'OWNER' satisfies OpenItemAssignee,
          assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
          askedBySessionId: asking,
          dedupeKey: DONE_REQUEST_DEDUPE_KEY,
          title: DONE_REQUEST_TITLE,
          payload: request as unknown as Prisma.InputJsonValue,
          waitingSince: now,
          assignedAt: now,
          // The owner's from the start, so there is nobody to escalate to — and no reminder: the
          // card stays in front of them until they answer it or the project moves under it.
          escalateAt: null,
        },
        select: { id: true },
      });
      return {
        ...request,
        itemId,
        state: 'OPEN',
        alreadyOpen: false,
        superseded: open ? { itemId: open.id } : null,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.requestDone'));
    if (!filed.alreadyOpen) this.translateFiledItem(ownerId, projectId, filed.itemId, 'done request');
    return filed;
  }

  /**
   * The account owner answers a question (§5.2 R10).
   *
   * The answer ends the item and is then told to whichever conversation coordinates the project NOW
   * — read after the answer has committed, so a project that rotated its coordinator while the owner
   * was deciding tells the one it has rather than the one that asked. Nothing here waits for the
   * delivery: the answer is written whether or not there is anybody to tell, and R11 tells the next
   * coordinator when there is one.
   */
  async answerOpenItem(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { option?: number; text?: string; sendAsWritten?: boolean },
  ): Promise<OpenItemAnswered> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId, kind: 'COORDINATOR_QUESTION' },
      select: { id: true, state: true, payload: true },
    });
    if (!item) throw new NotFoundException('question not found');
    const notOpen = (): ConflictException => new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message:
        'this question is no longer open. A question gets one answer: the first one is what the '
        + 'coordinator was told, and a second would replace an answer somebody already acted on.',
    });
    if (item.state !== 'OPEN') throw notOpen();
    const question = item.payload as unknown as CoordinatorQuestion;
    const text = given.text?.trim();
    const option = given.option ?? undefined;
    if (option === undefined && !text) {
      throw new BadRequestException('an answer needs an option or some text');
    }
    if (option !== undefined
      && (!Number.isInteger(option) || option < 0 || option >= (question.options?.length ?? 0))) {
      throw new BadRequestException('option must name one of the options this question offered');
    }
    // Settings › Translation: the owner's words reach the coordinator in the agent language, or the answer is
    // refused whole (422 TRANSLATION_FAILED) before anything is written. The option goes by index either way.
    const translation = text
      ? await ownerWordsForAgent(text, await translationLanguages(this.prisma, ownerId), given.sendAsWritten)
      : null;
    const answer: OwnerAnswer = {
      ...(option !== undefined ? { option } : {}),
      ...(text ? { text } : {}),
      ...(translation ? { translation } : {}),
      answeredByUserId: ownerId,
    };
    await withTransactionRetry(this.prisma, async tx => {
      const settled = await tx.projectOpenItem.updateMany({
        where: { id: itemId, state: 'OPEN' },
        data: {
          state: 'RESOLVED',
          resolution: 'ANSWERED',
          resolvedAt: new Date(),
          resolvedBy: 'USER',
          resolvedByUserId: ownerId,
          answer: answer as unknown as Prisma.InputJsonValue,
        },
      });
      if (settled.count === 0) throw notOpen();
      // An answered question is an owner ruling (coordinator handoff v2 §2), written with the answer.
      await writeAutoRuling(tx, ownerId, projectId, itemId, question, answer);
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { exceptionEscalationSeconds: true } });
      await tx.sessionRequest.updateMany({ where: { escalatedItemId: itemId, kind: 'RUN_QUESTION', state: 'OPEN' },
        data: { replyBy: new Date(Date.now() + project.exceptionEscalationSeconds * 1000) } });
      return settled;
    }, loggedRetry(this.logger, 'projectOpenItem.answerOpenItem'));
    return {
      itemId,
      state: 'RESOLVED',
      resolution: 'ANSWERED',
      delivery: await this.deliverAnswer(itemId),
    };
  }

  /**
   * `project_ruling_record`: the project's coordinator records an owner ruling given in one of its
   * turns (coordinator handoff v2 §2). The checks and the write are `project-ruling.ts`'s.
   */
  recordRuling(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    body: { ruling: string; quote: string; sourceTurnId: string; supersedes?: string | null },
  ): Promise<ProjectRulingView> {
    return recordProjectRuling(this.prisma, ownerId, projectId, actingSessionId, body);
  }

  /**
   * The account owner's "Not yet…" answer to a coordinator's done request.
   *
   * This is a separate owner door rather than another branch of `answerOpenItem`: a
   * `DONE_REQUEST` is not a coordinator question, and ending it is coupled to the same project
   * lock as `recordProjectDone`.  The project row is locked first and the request row second, so a
   * concurrent new request, stale-request supersession or Record as done is ordered before this
   * press.  Every refusal is before the first write and therefore leaves the item, the session
   * signal and the project list unchanged.
   */
  async declineDoneRequest(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: ProjectDoneRequestDeclineBody,
    actingSessionId?: string,
  ): Promise<ProjectDoneRequestDeclined> {
    // Keep the same authority boundary as POST /projects/:id/done.  In particular, a runner JWT
    // carrying an acting session is not turned into an owner press merely because this route writes
    // an item rather than `project.status`.
    const refusal = refuseProjectStatusWrite('DONE', actingSessionId);
    if (refusal) throw new ForbiddenException(refusal);
    const note = normalizedDoneRequestDeclineNote(given);
    // Settings › Translation: the note reaches the coordinator in the agent language, or the press is refused whole
    // (422 TRANSLATION_FAILED) before anything is written.
    const translation = await ownerWordsForAgent(note, await translationLanguages(this.prisma, ownerId), given.sendAsWritten);
    await withTransactionRetry(this.prisma, async (tx) => {
      // Rank 40: the same first lock as requestDone and recordProjectDone.
      const [project] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');

      // Rank 60: lock the exact item after the project.  Deliberately read by id alone and check
      // tenancy/kind/state in code so a foreign, non-DONE or terminal item is a 409 rather than a
      // cross-project 404, and so the check and the write share the same locked row.
      const [request] = await tx.$queryRaw<Array<{
        id: string;
        projectId: string;
        ownerId: string;
        kind: string;
        state: string;
      }>>(Prisma.sql`
        SELECT "id",
               "project_id" AS "projectId",
               "owner_id" AS "ownerId",
               "kind"::text AS "kind",
               "state"::text AS "state"
          FROM "project_open_item"
         WHERE "id" = ${itemId}::uuid
           FOR UPDATE`);
      if (!request
        || request.projectId !== projectId
        || request.ownerId !== ownerId
        || request.kind !== DONE_REQUEST_KIND
        || request.state !== 'OPEN') {
        throw doneRequestDeclineNotOpen();
      }

      const at = new Date();
      const written = await tx.projectOpenItem.updateMany({
        where: {
          id: itemId,
          projectId,
          ownerId,
          kind: DONE_REQUEST_KIND,
          state: 'OPEN',
        },
        data: {
          state: 'RESOLVED',
          resolution: 'DECLINED',
          resolvedAt: at,
          resolvedBy: 'USER',
          resolvedByUserId: ownerId,
          answer: { note, ...(translation ? { translation } : {}) } as unknown as Prisma.InputJsonValue,
          resolutionNote: note,
        },
      });
      if (written.count === 0) throw doneRequestDeclineNotOpen();
    }, loggedRetry(this.logger, 'projectOpenItem.declineDoneRequest'));

    // Delivery is deliberately after commit.  The item is the durable answer even when there is
    // no coordinator, and a coordinator rotation between the write and this read is told at its
    // current conversation rather than the one that originally asked.
    const delivery = await this.deliverDoneRequestDecline(itemId);
    return {
      itemId,
      state: 'RESOLVED',
      resolution: 'DECLINED',
      note,
      delivery,
    };
  }

  /**
   * The owner hands an escalated item back to the project's coordinator (§4.7).
   *
   * An item became the owner's because nobody acted on it — that is the whole of what an escalation
   * says — so this is the owner saying "try again", and it deliberately ends nothing: the item goes
   * back to the coordinator with the clock the project set for it RESTARTED. Keeping the deadline it
   * already had would hand it back already due to return, which is the same as not handing it back
   * at all, and `waiting_since` moves with it because the wait a reader is shown is the one running
   * now (§4.6 X-E2). `assigned_at` moves for the same kind of reason on the other side: a delivery's
   * turn key names the assignment it was made under, so the coordinator is told in a fresh turn
   * rather than under the key of the one it never answered (X-D2).
   *
   * The three refusals in front of the write are what keep the press honest. An item that is no
   * longer open has nothing left to hand over; an item the coordinator is already carrying is not
   * the owner's to send; and a project with no coordinator conversation — or one that has ended —
   * has nobody to put the item in front of, so the delivery would hand it straight back and the
   * press would be a circle.
   *
   * WHAT IT NO LONGER REFUSES, AND WHY. It used to refuse when `coordinatorEnabled` was off, on the
   * same argument. That argument is about AUTOMATIC hand-overs (`deliver` spells it out): an item
   * nobody pressed for belongs to the owner when the coordinator may not act. This press is not
   * that — it is the owner, who owns the switch, putting one item in front of their own
   * conversation — so the door asks for a conversation and the delivery carries the authority. The
   * alternative was a card whose press is refused, or a card that hides the press and leaves the
   * owner with nothing to do about an item that is theirs precisely because nobody else will take
   * it (the account owner's report, 2026-09-22).
   */
  async returnToCoordinator(
    ownerId: string,
    projectId: string,
    itemId: string,
  ): Promise<OpenItemReturned> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        project: {
          select: {
            coordinatorSessionId: true,
            coordinatorSession: { select: COORDINATOR_PAUSE_SELECT },
          },
        },
      },
    });
    if (!item) throw new NotFoundException('item not found');
    // §4.6 X-E5 with §4.4 X-D7: this item is never delivered to a coordinator conversation — it is
    // about a claim that stopped reporting, which no conversation can act on by reading it — so
    // there is nowhere to send it back to. Its doors are the owner's (abandon, open the landing,
    // close it by hand).
    if (item.kind === LANDING_LEASE_EXPIRED_KIND) {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_RETURNABLE,
        message:
          'this item is never delivered to a coordinator conversation: it is about a landing whose '
          + 'runner stopped reporting, and only the owner can abandon it, open its landing session, '
          + 'or close it by hand.',
      });
    }
    // §10.7: the owner's from birth and never delivered to a coordinator — it asks about authority,
    // which no conversation holds — so there is nowhere to send it either. Undoing the work is a
    // task the coordinator files when asked in "Chat about this", not this door.
    // 1110: the coordinator already had this evidence and did not decide it; the item is the owner's.
    // To ask the coordinator again, "Chat about this" sends it a message.
    if (item.kind === EVIDENCE_UNDECIDED_KIND) {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_RETURNABLE,
        message:
          'this item is never delivered to a coordinator conversation: the coordinator was already '
          + 'handed this evidence and has not decided it. Review the evidence and confirm it or send '
          + 'it back, or use Chat about this to ask the coordinator to decide.',
      });
    }
    if (item.kind === LANDED_WITHOUT_CONFIRMATION_KIND) {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_RETURNABLE,
        message:
          'this item is never delivered to a coordinator conversation: it asks the account owner to '
          + 'accept work that reached the branch without their confirmation, and only the owner can '
          + 'accept it. To undo the work instead, use Chat about this to have the coordinator file a '
          + 'task that reverts it.',
      });
    }
    if (item.state !== 'OPEN') {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_OPEN,
        message:
          'this item is no longer open: it ended when the work it was about moved on, so there is '
          + 'nothing left to hand back.',
      });
    }
    if (item.assignee !== 'OWNER') {
      throw new ConflictException({
        code: OPEN_ITEM_ALREADY_COORDINATORS,
        message:
          'this item is already the coordinator’s. Sending it back is for an item that came to the '
          + 'owner because nobody acted on it.',
      });
    }
    // The conversation, not the switch: this press is the owner's own authority, so a project whose
    // coordinator is switched off still has somewhere to put the item — what it needs is somebody to
    // put it in front of (`deliver`, which this ends by calling with `OWNER`). What the switch does
    // keep is every automatic hand-over: an item opened for a switched-off coordinator is the
    // owner's from the start, and this refusal is what it was always about — a project with NO
    // conversation at all, one that is over, or one that is permanently unreachable.
    const reach = await readCoordinatorReach(this.sessions, ownerId, item.project);
    if (!reach.askable) {
      throw new ConflictException({
        code: OPEN_ITEM_NO_COORDINATOR,
        message:
          'this project has no coordinator conversation that can be asked again right now — it has '
          + 'none, it has ended, or its runner is offline — so the item stays yours.',
      });
    }
    const now = new Date();
    // The new assignment has no deadline until its ITEM turn is taken.
    const escalateAt = null;
    const returned = await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN', assignee: 'OWNER' },
      data: {
        assignee: 'COORDINATOR',
        // Back where it started: nothing about it is anybody's exception now.
        assigneeReason: 'DEFAULT',
        assignedAt: now,
        waitingSince: now,
        escalateAt,
        escalatedAt: null,
      },
    });
    if (returned.count === 0) {
      // The same item somebody else moved between the read and the write — the press answered a
      // state that had already changed, so it is told to read again rather than reporting a
      // hand-back it did not make.
      throw new ConflictException({
        code: OPEN_ITEM_NOT_OPEN,
        message: 'this item changed while the press was being made — read the project again.',
      });
    }
    // §4.4 X-D4 (1), after the commit, and guarded: the item is the coordinator's from here whether
    // or not this process manages to tell it, and a delivery that fails is re-derived from the
    // committed row at the next drain point rather than costing the owner a 500.
    await this.guarded('returnToCoordinator', () => this.deliver(itemId, 'OWNER'));
    return { itemId, assignee: 'COORDINATOR', waitingSince: now, escalateAt };
  }

  /**
   * The project's coordinator deliberately hands an item to the account owner (§4.7).
   *
   * This is a distinct edge from the escalation clock and from the automatic hand-offs in
   * `handToOwner`: the coordinator is making a decision, so the explanation and the session that
   * made it are retained on the item.  The assignment is one compare-and-set.  A competing fact,
   * escalation or second press therefore cannot be reported as a hand-over it did not make.
   */
  async handOver(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { note: string },
    actor: { kind: 'SESSION'; sessionId: string },
  ): Promise<OpenItemHandedOver> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        assignedAt: true,
        taskId: true,
        promotionId: true,
        fuseEpisodeId: true,
        payload: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item) throw new NotFoundException('item not found');
    if (item.state !== 'OPEN') {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_OPEN,
        message: 'this item is no longer open, so there is nothing left to hand to the owner.',
      });
    }

    // The capability table is the allow-list for this door.  In particular, a question, pause,
    // promotion card or delivery review is not silently converted into an owner escalation just
    // because it happens to have an OWNER assignee in another path.
    const doorInput = {
      kind: item.kind,
      taskId: item.taskId,
      promotionId: item.promotionId,
      fuseEpisodeId: item.fuseEpisodeId,
      payload: item.payload,
    };
    const coordinatorDoor = doorsForOpenItem({ ...doorInput, assignee: 'COORDINATOR' })
      .find((candidate) => candidate.name === 'open_item_hand_over' && candidate.implemented);
    const ownerDoor = doorsForOpenItem({ ...doorInput, assignee: 'OWNER' })
      .find((candidate) => candidate.name === 'open_item_hand_over' && candidate.implemented);
    if (item.assignee !== 'COORDINATOR' || !coordinatorDoor || !ownerDoor) {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_COORDINATOR_ITEM,
        message:
          'this item is not the coordinator’s to hand over. Only an open item with the hand-over '
          + 'door may be deliberately given to the account owner.',
      });
    }

    const sessionId = actor.kind === 'SESSION' ? actor.sessionId?.trim() : '';
    if (!sessionId || sessionId !== item.project.coordinatorSessionId) {
      throw new ForbiddenException({
        code: OPEN_ITEM_COORDINATOR_ONLY,
        message:
          'only the conversation coordinating this project may hand an item to the account owner.',
      });
    }

    const note = typeof given?.note === 'string' ? given.note.trim() : '';
    if (!note) {
      throw new BadRequestException({
        code: OPEN_ITEM_HAND_OVER_NOTE_REQUIRED,
        message: 'a hand-over explanation is required.',
      });
    }
    if (note.length > MAX_OPEN_ITEM_RESOLUTION_NOTE) {
      throw new BadRequestException({
        code: OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG,
        message: `a hand-over explanation is at most ${MAX_OPEN_ITEM_RESOLUTION_NOTE} characters`,
      });
    }

    const [changed] = await this.prisma.$queryRaw<Array<{ handedOverAt: Date }>>(Prisma.sql`
      UPDATE "project_open_item" item
         SET "assignee" = 'OWNER', "assignee_reason" = 'HANDED_OVER',
             "assigned_at" = now(), "escalate_at" = NULL,
             "handover_note" = ${note}, "handed_over_at" = now(), "translation" = NULL,
             "handed_over_by_session_id" = ${sessionId}::uuid, "updated_at" = now()
       WHERE item."id" = ${item.id}::uuid
         AND item."project_id" = ${projectId}::uuid AND item."owner_id" = ${ownerId}::uuid
         AND item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR'
         AND item."assigned_at" = ${item.assignedAt.toISOString()}::timestamptz
         AND ${openItemOwed('item')}
       RETURNING item."handed_over_at" AS "handedOverAt"`);
    if (!changed) {
      throw new ConflictException({
        code: OPEN_ITEM_HAND_OVER_RACE,
        message: 'this item changed while it was being handed over; read the project again.',
      });
    }

    // The owner notification is deliberately after the CAS commit.  A failed push is harmless:
    // the committed OWNER row is re-discovered by the normal owner-item notification sweep.
    void this.push?.notifyOwnerItem(item.id);
    // The card is translated again with the note (decision 1A): its translation was cleared above.
    this.translateFiledItem(ownerId, projectId, item.id, 'handed-over item');
    return {
      itemId: item.id,
      assignee: 'OWNER',
      assigneeReason: 'HANDED_OVER',
      handoverNote: note,
      handedOverAt: changed.handedOverAt,
      handedOverBySessionId: sessionId,
    };
  }

  /**
   * The assignee closes an item it has handled, saying why (§4.7's "标记已处理"; §5.2 R12 for a
   * question).
   *
   * WHY THIS DOOR EXISTS. Every other ending of an item is a fact the platform can read for itself:
   * a task that moved on, a landing that happened, a promotion that was decided, an answer that came
   * back. The one it cannot is work that landed BY HAND — a coordinator that replayed a branch onto
   * the target itself, before the integration line was carrying it, or because the line is not what
   * moves that work. Nothing about that leaves a row the platform can read, and the branch tip it
   * landed from stops being an ancestor of anything the moment the replay is pushed, so the item
   * about it says "this did not land" and goes on saying it: the platform does not retry, and the
   * task never runs again. The assignee knows. So the assignee is given a way to say so, and what it
   * says is written down — who closed it, which conversation, when, and why.
   *
   * WHO PRESSES. The item's assignee, which is the whole of "只有当前负责人能关": for an item the
   * project's coordinator is carrying, the conversation the project is coordinated FROM — read at
   * this moment, so a project that rotated its coordinator is closed by the one it has — and, for
   * anything at all, the account owner through the door that takes their own credential. A question
   * is the one kind whose assignee does not end it: it is the owner's to answer, and the conversation
   * that ASKED it that may withdraw it (R12).
   *
   * WHAT IT REFUSES. An item that is not OPEN: an ending is final, both here and in the row's own
   * guard trigger (`project_open_item_terminal_guard`), and a second press would write its reason
   * over an ending somebody else's fact produced. A session that is not the item's: an item is a fact
   * about one project's work, not a general-purpose write. A press with no reason, because the reason
   * IS what this door adds — the platform could not verify the ending, so the sentence is the
   * evidence. And the two kinds that have a press of their own (see `HAND_CLOSABLE_RESOLUTIONS`).
   */
  async resolveOpenItem(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { note: string },
    /** Who is pressing. Named rather than inferred from a nullable session id: an owner's press and
     *  a conversation's are authorized differently, and a door that reached the owner's branch by
     *  OMITTING the session would be one any machine credential could open as the owner. */
    actor: { kind: 'OWNER' } | { kind: 'SESSION'; sessionId: string },
  ): Promise<OpenItemResolved> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        askedBySessionId: true,
        // Which landing segment the item is about (0436): the attempt it came from, and the task it
        // names. Read for the settlement edge below.
        taskId: true,
        integrationJobId: true,
        // The cell the refusals below name the doors of, and what O-X1 asks about.
        promotionId: true,
        payload: true,
        workSessionOfferedAt: true,
        workSessionReturnedAt: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item) throw new NotFoundException('item not found');
    const notOpen = (): ConflictException => new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message:
        'this item is no longer open. An ending is final: what it was about has already been '
        + 'answered by a fact or by somebody else, and a second press would write over that.',
    });
    if (item.state !== 'OPEN') throw notOpen();
    // W9 (revision 42): while the task's own work session is fixing it, nobody closes it by hand.
    if (inWorkSessionHands(item)) throw withWorkSession();
    const resolution = HAND_CLOSABLE_RESOLUTIONS[item.kind];
    if (!resolution) {
      throw new ConflictException({ code: OPEN_ITEM_HAS_ITS_OWN_DOOR, message: ownDoorRefusal(item) });
    }
    const note = given.note?.trim();
    if (!note) {
      throw new BadRequestException(
        'a reason is required: this door is how an ending the platform could not see gets written '
        + 'down, so the sentence you give is the whole of its evidence.',
      );
    }
    if (note.length > MAX_OPEN_ITEM_RESOLUTION_NOTE) {
      throw new BadRequestException(`a reason is at most ${MAX_OPEN_ITEM_RESOLUTION_NOTE} characters`);
    }

    let resolvedBy: 'USER' | 'COORDINATOR';
    let resolvedByUserId: string | null = null;
    let resolvedBySessionId: string | null = null;
    if (actor.kind === 'OWNER') {
      resolvedBy = 'USER';
      resolvedByUserId = ownerId;
    } else {
      const sessionId = actor.sessionId?.trim();
      if (item.kind === 'COORDINATOR_QUESTION') {
        // R12: the question is the owner's, and the conversation that asked it may take it back.
        if (!sessionId || item.askedBySessionId !== sessionId) {
          throw new ConflictException({
            code: OPEN_ITEM_NOT_COORDINATOR_ITEM,
            message:
              'this is a question, so it is not the coordinator\'s to close: the owner answers it, '
              + 'and the conversation that asked it is the one that may withdraw it.',
          });
        }
      } else {
        if (item.assignee !== 'COORDINATOR') {
          throw new ConflictException({
            code: OPEN_ITEM_NOT_COORDINATOR_ITEM,
            message:
              'this item is the account owner\'s — it is theirs because they were asked, or because '
              + 'nobody acted and it escalated to them. Closing it is their press.',
          });
        }
        // The conversation, not the switch — the reading `returnToCoordinator` and `deliver` spell
        // out (§4.7). An item arrives on a coordinator either by an automatic hand-over the switch
        // authorized or by the owner's own press, and once it is its assignee's, its assignee ends
        // it: an assignment that cannot be closed is an item with no ending but its clock. Gated on
        // the switch, an item handed to a switched-off coordinator could only be ended by the owner
        // — the dead end the press was made exempt from the switch to avoid.
        if (!sessionId || sessionId !== item.project.coordinatorSessionId) {
          throw new ForbiddenException({
            code: OPEN_ITEM_COORDINATOR_ONLY,
            message:
              'this item is the project\'s coordinator\'s to close, and this session is not the '
              + 'conversation the project is coordinated from. An item is closed by its assignee: '
              + 'that conversation, or the account owner.',
          });
        }
      }
      resolvedBy = 'COORDINATOR';
      resolvedBySessionId = sessionId!;
    }

    // O-X1 (§10.7): an item about a task's landing is not closed by hand while that landing is what
    // a dependent is still waiting on — the wait would be left with nobody in front of it (O5) — and
    // neither is the item a project's failing observations open (IE:observe) while a task of the
    // project waits to be observed. Read once, before the write; the doors the refusal names are this
    // item's cell's.
    if ((INTEGRATION_ITEM_KINDS as readonly string[]).includes(item.kind)
        && await landingConditionStands(this.prisma, projectId, item)) {
      throw new ConflictException({ code: OPEN_ITEM_CONDITION_STANDS, message: conditionStandsRefusal(item) });
    }

    const settled = await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN', ...NOT_WITH_WORK_SESSION },
      data: {
        state: 'RESOLVED',
        resolution,
        resolvedAt: new Date(),
        resolvedBy,
        resolvedByUserId,
        resolvedBySessionId,
        resolutionNote: note,
      },
    });
    if (settled.count === 0) {
      // Somebody else's fact, or another press, moved it between the read and the write — so the
      // press is told to read again rather than reporting a close it did not make.
      throw notOpen();
    }
    // M-T14: the last failure item about a BLOCKED task-branch candidate was closed by hand, so the
    // card about it ends too. Its own transaction, after the close committed; it re-reads the
    // candidate and the items still open about it.
    if (item.promotionId && (INTEGRATION_ITEM_KINDS as readonly string[]).includes(item.kind)) {
      await retireCandidateAfterHandledItem(this.prisma, { projectId, promotionId: item.promotionId })
        .catch((error) => this.logger.warn(
          `retiring candidate ${item.promotionId} after item ${itemId} closed failed: ${(error as Error)?.message ?? error}`));
    }
    // §2.9 LS3 rule 4: the segment's last OPEN integration item was closed by hand (a fix task was
    // filed for it), and the segment neither landed nor has an attempt still moving — so it settles
    // HANDLED. Its own transaction, after the close committed; the rule re-checks all of that under
    // the subject's lock.
    await settleTaskSegmentAfterHandledItem(this.prisma, { ownerId, projectId, itemId })
      .catch((error) => this.logger.warn(
        `landing settlement after item ${itemId} closed failed: ${(error as Error)?.message ?? error}`));
    return { itemId, state: 'RESOLVED', resolution };
  }

  /**
   * The account owner accepts work that reached the branch without their confirmation (§10.8): the
   * one door that ends a `LANDED_WITHOUT_CONFIRMATION`, as RESOLVED / ACCEPTED by the USER.
   *
   * The owner's own: a request made from a session is refused 403 whatever credential came with it
   * (the start door's rule), and the route takes no token (`@PatForbidden('OWNER_INTERACTIVE')`).
   * Accept answers this one kind; any other item is decided by its own doors. One compare-and-set on
   * the OPEN, still owed row, so a second press — or a fact that moved it meanwhile — is told it is no
   * longer open rather than reporting an Accept it did not make. Undoing the work is not a door: the
   * owner asks the coordinator for it in "Chat about this", and the coordinator files ordinary work.
   */
  async acceptOpenItem(
    ownerId: string,
    projectId: string,
    itemId: string,
    actingSessionId?: string,
  ): Promise<OpenItemAccepted> {
    if (actingSessionId?.trim()) {
      throw new ForbiddenException({
        code: OPEN_ITEM_OWNER_ONLY,
        message:
          'accepting work that reached the branch without the owner\'s confirmation is the account '
          + 'owner\'s own decision, so a request made from a session is refused whatever credential it '
          + 'carries.',
      });
    }
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: { id: true, kind: true, state: true },
    });
    if (!item) throw new NotFoundException('item not found');
    if (item.kind !== LANDED_WITHOUT_CONFIRMATION_KIND) {
      throw new ConflictException({
        code: OPEN_ITEM_HAS_ITS_OWN_DOOR,
        message:
          'Accept answers only an item about work that reached the branch without your confirmation; '
          + 'this item is decided by its own doors.',
      });
    }
    const notOpen = (): ConflictException => new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message:
        'this item is no longer open: it was accepted already, or its task was cancelled or replaced.',
    });
    if (item.state !== 'OPEN') throw notOpen();
    const [accepted] = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "project_open_item" item
         SET "state" = 'RESOLVED', "resolution" = 'ACCEPTED', "resolved_at" = now(),
             "resolved_by" = 'USER', "resolved_by_user_id" = ${ownerId}::uuid, "updated_at" = now()
       WHERE item."id" = ${itemId}::uuid
         AND item."project_id" = ${projectId}::uuid AND item."owner_id" = ${ownerId}::uuid
         AND item."kind" = ${LANDED_WITHOUT_CONFIRMATION_KIND} AND item."state" = 'OPEN'
         AND ${openItemOwed('item')}
       RETURNING item."id"`);
    if (!accepted) throw notOpen();
    return { itemId, state: 'RESOLVED', resolution: 'ACCEPTED' };
  }

  /**
   * Look at the project's line again (`integration_observe`, §10.8; §10.6 O-T5): queue one
   * OBSERVE_LANDING, or fold into the one already queued, as the conversation the project is
   * coordinated from or as the account owner.
   *
   * WHO MAY ASK. The project's current coordinator conversation, named by the acting session, and
   * nothing else on the runner door — a missing or blank header is not read as the account owner,
   * whose own press is the user door (`{ kind: 'OWNER' }`, which the owner's controller sends only
   * without an acting session). A reason is required, as on every integration door: it stays on the
   * items the observation handles.
   *
   * WHAT IT WRITES. One transaction. `queueLandingObservation` under the binding's lock (rank 55) —
   * the observation's own enqueue, which also ends a silent RUNNING one (J-T9) — then, by §4.7 H1,
   * the asker's OPEN `LANDING_UNOBSERVED` items whose task that observation will look at, marked as
   * being handled by it. They stay OPEN: the observation that sees a task's commit writes its landing
   * receipt, which closes the item LANDED (O-R1), and one that does not leaves it as it was. An
   * observation queues even with nothing waiting (O-T5); a project with no repository bound has no
   * line to look at and is refused, with nothing written.
   */
  async observeIntegration(
    ownerId: string,
    projectId: string,
    given: { reason?: unknown } | undefined,
    actor: { kind: 'OWNER' } | { kind: 'SESSION'; sessionId: string },
  ): Promise<IntegrationObserved> {
    const reason = observeReason(given);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { coordinatorSessionId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actor.kind === 'SESSION' ? actor.sessionId.trim() : null;
    if (actor.kind === 'SESSION' && (!asking || asking !== project.coordinatorSessionId)) {
      throw observeCoordinatorOnly();
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const queued = await queueLandingObservation(tx, { ownerId, projectId, trigger: 'OBSERVE_DOOR' });
      if (!queued) {
        throw new ConflictException({
          code: 'INTEGRATION_REPOSITORY_UNKNOWN',
          message: 'this project has no repository bound yet, so there is no line to look at. Its first '
            + 'landing binds one.',
        });
      }
      if (asking) {
        // Read again inside the transaction: the pointer can rotate while the call was on its way.
        const current = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { coordinatorSessionId: true },
        });
        if (current.coordinatorSessionId !== asking) throw observeCoordinatorOnly();
      }
      const handle = await observableUnobservedItems(tx, projectId, asking ? 'COORDINATOR' : 'OWNER');
      await markOpenItemsHandling(tx, handle, {
        jobId: queued.jobId,
        sessionId: asking,
        userId: asking ? null : ownerId,
        reason,
      });
      const job = await tx.projectIntegrationJob.findUniqueOrThrow({
        where: { id: queued.jobId },
        select: { generation: true },
      });
      return {
        projectId,
        jobId: queued.jobId,
        generation: job.generation,
        queued: queued.queued,
        reason,
        handlingItemIds: handle,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.observeIntegration'));
  }

  /**
   * The project's coordinator runs one of its failed landings again (`integration_retry`, §2.3
   * J-T1b) — the next generation of a DONE task's LAND_TASK, for a landing that stopped at a red check,
   * a check that ran out of time, or an integration error.
   *
   * WHY A REASON IS REQUIRED. Rerunning the same commits against the same checks is the cheapest way
   * to make a red go away without anybody deciding it was not the delivery's, which is the silent
   * retry the platform refuses to make (J5). So the caller says why this run will come out
   * differently — the merge check's baseline was repaired, the failure was the machinery's, the check
   * ran out of time — and the sentence is kept on the generation it queued and on every item it
   * handles.
   *
   * WHO MAY ASK. The conversation the project is coordinated from, read at this moment, and nothing
   * else on this door: a task's own run does not decide what happens to its landing, and a coordinator
   * of another project does not decide this one's. The account owner's say is the item: a failure
   * whose item is theirs is refused here (`decideIntegrationRetry` says how each case reads).
   *
   * WHAT IT WRITES. One transaction under the task row (FOR NO KEY UPDATE, the lock the DONE
   * transaction holds): the decision over the facts read under it, then exactly one new LAND_TASK
   * generation (`queueLandingRetry`) carrying what it reruns, why and who asked, then the
   * coordinator's open items about the failed landing marked as being HANDLED by that generation
   * (§4.7 H1) — still OPEN, because nobody knows yet whether it lands. A second call while that
   * generation is queued or running is refused — the lock orders two concurrent ones, and J3's index
   * would refuse the second row anyway. What happens next is the line's: a landing makes those items
   * HANDLED in the coordinator's name and continues to the project branch's merge check (§3.4), and a
   * failure supersedes them with its own item, classified, for whoever the project routes it to.
   *
   * A TIMED-OUT LANDING (§2.2 J-T9). A RUNNING newest landing whose runner has said nothing past its
   * limit is judged here by the read the job list draws (`readInFlightJobs`), and a retry of it first
   * ends it as `ERROR` — a compare-and-set on the heartbeat it was judged from, with J12's code for
   * the kind: `PUSH_OUTCOME_UNKNOWN` for a landing (its legacy claim cannot prove nothing was
   * pushed), `RUNNER_LOST` only where the claim's protocol can — then queues the next generation
   * like any other rerun. The account owner may press that one without an item of theirs: nothing
   * has opened one yet.
   */
  async retryIntegration(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string },
    actingSessionId: string | undefined,
    requester?: { userId: string },
    /** Refuse unless the task's newest landing is still this job — the job list's press names one. */
    expectJobId?: string,
  ): Promise<IntegrationRetried> {
    const reason = rerunReason(given);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { coordinatorSessionId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    const ownerRequester = requester?.userId ?? null;
    if (!ownerRequester && (!asking || asking !== project.coordinatorSessionId)) {
      throw rerunCoordinatorOnly();
    }
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('task not found');
    if (task.projectId !== projectId) {
      throw new ForbiddenException({
        code: INTEGRATION_RETRY_NOT_THIS_PROJECT,
        message:
          'this task is not filed under this project, and a project\'s coordinator runs only its own '
          + 'project\'s landings again. The task\'s own project, and its coordinator, decide this one.',
      });
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status" FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
           AND "project_id" = ${projectId}::uuid
         FOR NO KEY UPDATE`);
      if (!locked) throw new NotFoundException('task not found in this project');
      // Read again under the lock: the pointer can rotate, and the switch can move, while the call
      // was on its way here.
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      if (!ownerRequester && current.coordinatorSessionId !== asking) throw rerunCoordinatorOnly();
      const newestLanding = await tx.projectIntegrationJob.findFirst({
        where: { taskId, kind: 'LAND_TASK' },
        orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true, generation: true, state: true, checks: true, baselineRed: true, phase: true, sourceSha: true,
          serialKey: true,
        },
      });
      // docs/design/project-line-upstream-sync.md §4.2: a queued landing held behind the line-sync item goes ahead by
      // itself once the sync lands, and the refusal names that item.
      const lineSyncHold = newestLanding?.state === 'QUEUED'
        ? await tx.projectOpenItem.findFirst({
          where: { projectId, dedupeKey: lineSyncDedupeKey(newestLanding.serialKey), state: 'OPEN' },
          select: { id: true },
        })
        : null;
      if (expectJobId && newestLanding?.id !== expectJobId) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message: 'this task\'s landing has moved on since it was read: another generation is its newest '
            + 'now. Read the project again.',
        });
      }
      // Whether a RUNNING landing timed out, by the rule the job list draws it with (§1.6).
      const [silent] = newestLanding?.state === 'RUNNING'
        ? await readInFlightJobs(tx, projectId, newestLanding.id)
        : [];
      const openItems = await tx.projectOpenItem.findMany({
        where: { projectId, taskId, kind: { in: [...INTEGRATION_ITEM_KINDS] }, state: 'OPEN' },
        select: {
          id: true, kind: true, assignee: true, assigneeReason: true, integrationJobId: true, payload: true,
          workSessionOfferedAt: true, workSessionReturnedAt: true,
        },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      // W9 (revision 42): the task's own work session is fixing this landing; a rerun beside it would
      // be a second fixer of the same failure.
      if (openItems.some(inWorkSessionHands)) throw withWorkSession();
      const ownerBlockers = await tx.projectBlocker.findMany({
        where: { projectId, subjectType: 'TASK', subjectId: taskId, owner: 'USER', resolvedAt: null },
        select: { id: true, kind: true },
      });
      const baselineItem = openItems.find((item) => baselineFields(item.payload).baseline !== null);
      const baselineFailure = baselineItem?.integrationJobId
        ? await tx.projectIntegrationJob.findUniqueOrThrow({ where: { id: baselineItem.integrationJobId } })
        : null;
      const decision = decideIntegrationRetry({
        requester: ownerRequester ? 'OWNER' : 'COORDINATOR',
        coordinatorEnabled: current.coordinatorEnabled,
        taskStatus: locked.status,
        newestLanding: baselineFailure ?? (newestLanding && { ...newestLanding, timedOut: silent?.timedOut === true }),
        openItems,
        ownerBlockers,
        heldByLineSync: lineSyncHold ? { itemId: uuidToBase62(lineSyncHold.id) } : null,
        // §3.1 M3: only a MAIN_SYNC conflict reads the branch tips, and only facts already on record.
        ...(newestLanding?.state === 'CONFLICT' && newestLanding.phase === 'MAIN_SYNC'
          ? {
            sourceTips: {
              conflicted: newestLanding.sourceSha,
              current: await readLandingSourceTip(tx, { ownerId, projectId, taskId }),
            },
          }
          : {}),
      });
      if (!decision.ok) throw new HttpException(decision.body, decision.status);
      if (decision.endsTimedOutJob && (silent ? await endTimedOutLanding(tx, silent, 'RETRY') : null) === null) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_IN_FLIGHT,
          message: 'this landing\'s runner reported again while the retry was being decided, so it has not '
            + 'timed out any more. Read the project again.',
        });
      }

      if (baselineItem && baselineFailure) {
        const queued = await tx.projectIntegrationJob.findFirstOrThrow({
          where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' },
          orderBy: [{ generation: 'desc' }],
        });
        const landing = queued.landingId
          ? await tx.projectLanding.findUnique({ where: { id: queued.landingId }, select: { sessionId: true } })
          : null;
        const closed = await tx.projectOpenItem.updateMany({
          where: { id: baselineItem.id, state: 'OPEN' },
          data: { state: 'RESOLVED', resolution: 'RETRIED', resolvedAt: new Date(),
            resolvedBy: ownerRequester ? 'USER' : 'COORDINATOR',
            resolvedBySessionId: ownerRequester ? null : asking!, resolvedByUserId: ownerRequester,
            resolutionNote: reason },
        });
        if (closed.count === 0) throw new ConflictException('the baseline item is no longer open');
        return { taskId, jobId: queued.id, generation: queued.generation, sourceRef: queued.sourceRef,
          landingSessionId: landing?.sessionId ?? null, retryOfJobId: baselineFailure.id,
          failureClass: decision.failureClass, reason, handlingItemIds: [] };
      }
      const queued = await queueLandingRetry(tx, {
        ownerId,
        projectId,
        taskId,
        // A MAIN_SYNC conflict rerun after its branch moved is a new look at new commits, queued like
        // one: the retry columns' class check admits only the retryable failures (0344/0513), so the
        // row carries none, and who asked and why are kept on the items it handles below.
        ...(decision.failureClass === 'CONFLICT'
          ? { cause: 'RETRY' as const }
          : {
            retry: {
              ofJobId: decision.retryOfJobId,
              failureClass: decision.failureClass,
              reason,
              requestedBySessionId: ownerRequester ? undefined : asking!,
              requestedByUserId: ownerRequester ?? undefined,
            },
          }),
      });
      if (!queued) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message:
            'the landing could not be queued: the task has no work branch to hand the line, or the '
            + 'project no longer integrates on a branch of its own.',
        });
      }
      await markOpenItemsHandling(tx, decision.handle, {
        jobId: queued.jobId,
        sessionId: ownerRequester ? null : asking!,
        userId: ownerRequester,
        reason,
      });
      return {
        taskId,
        jobId: queued.jobId,
        generation: queued.generation,
        sourceRef: queued.sourceRef,
        landingSessionId: queued.landingSessionId,
        retryOfJobId: decision.retryOfJobId,
        failureClass: decision.failureClass,
        reason,
        ...(decision.message ? { message: decision.message } : {}),
        handlingItemIds: decision.handle,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.retryIntegration'));
  }

  /** The account owner's user-channel door for a failed task landing. */
  async retryIntegrationAsOwner(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string },
  ): Promise<IntegrationRetried> {
    return this.retryIntegration(ownerId, projectId, taskId, given, undefined, { userId: ownerId });
  }

  /**
   * The account owner's Retry on a job the integration view calls timed out — the press on the landing
   * row's job list (`POST /projects/:id/integration/jobs/:jobId/retry`, §2.2 J-T9).
   *
   * The job's own facts are the reason, so the server writes it; the rerun is `retryIntegration`, the
   * same door every landing retry goes through, held to this job by id. Answers with the integration
   * view read after it, which is what the list redraws from.
   */
  async retryTimedOutJobAsOwner(
    ownerId: string,
    projectId: string,
    jobId: string,
  ): Promise<IntegrationRetriedView> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { exceptionEscalationSeconds: true, title: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const [job] = await readInFlightJobs(this.prisma, projectId, jobId);
    if (!job) {
      throw new ConflictException({
        code: INTEGRATION_RETRY_NOT_APPLICABLE,
        message: 'this job is not in flight any more: it finished, or a retry already replaced it. Read '
          + 'the project again.',
      });
    }
    if (!job.retryable || !job.taskId) {
      throw new ConflictException(job.timedOut
        ? {
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message: 'only a task\'s landing can be retried after a timeout. A merge check or a merge into '
            + 'main that stopped reporting is not retried from here.',
        }
        : {
          code: INTEGRATION_RETRY_IN_FLIGHT,
          message: `this job's runner has reported within its limit, so it is still `
            + `${job.state === 'RUNNING' ? 'running' : 'queued'}: nothing is retried beside it.`,
        });
    }
    const retried = await this.retryIntegration(
      ownerId, projectId, job.taskId, { reason: timedOutRetryReason(job) }, undefined, { userId: ownerId }, jobId,
    );
    return {
      ...(await readProjectIntegrationView(this.prisma, projectId, projectIntegrationView(
        await readProjectCodebase(this.prisma, projectId),
        project.exceptionEscalationSeconds,
        { id: projectId, title: project.title },
      ))),
      landingSessionId: retried.landingSessionId,
    };
  }

  /**
   * The account owner's LAND_TASK stop (`POST /projects/:id/tasks/:taskId/integration/stop`, J-T8).
   *
   * WHAT IT DOES. A QUEUED generation ends `CANCELLED` here and now: it was never claimed, nothing
   * can have pushed, and a queued row with a stop request is never claimed. A RUNNING generation
   * inside its reporting window is only ASKED — `cancel_requested_at` — and its runner answers
   * CANCELLED through the result transaction (J-T12); the server must not claim a landing did not
   * happen while a push may be in flight. A RUNNING generation already silent past its limit (§7.2
   * V6, read by `readInFlightJobs`) is ended on the spot as `ERROR` with J12's code, by the same
   * compare-and-set every stop door uses (`stopInFlightJob`): a request written onto it would never
   * be collected, and it would hold its serial key for ever.
   *
   * WHAT IT REFUSES. A generation past the push boundary (J-T4) is not stopped at all: the merge
   * may already have happened, and only the runner's result can say so. With no queued or running
   * LAND_TASK there is nothing to stop. The door is the owner's alone — a coordinator stops its
   * work by reopening the task, which is J-T8's other trigger.
   *
   * THE DONE BEHIND A STOPPED GENERATION (J-T8, revision 24). A task reopened and written DONE
   * again while this generation was in flight could not queue its own generation (J3's one-inflight
   * index) and kept its `task_reopen_intent`. The generation has just stopped being live — whether
   * by ending CANCELLED or by being ended ERROR — so the deferred DONE is queued here, in this same
   * transaction, under the project binding (rank 55) taken before the job row (rank 60).
   */
  async stopTaskIntegrationAsOwner(
    ownerId: string,
    projectId: string,
    taskId: string,
    actingSessionId: string | undefined,
  ): Promise<TaskIntegrationStop> {
    if (actingSessionId?.trim()) {
      throw new ForbiddenException({
        code: INTEGRATION_STOP_OWNER_CHANNEL_ONLY,
        message:
          'the stop door is the account owner\'s, and an acting session has no way through it. A '
          + 'coordinator that wants work stopped reopens the task (task_reopen): its next DONE '
          + 'queues the generation the line should land.',
      });
    }
    return withTransactionRetry(this.prisma, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('project not found');
      const task = await tx.task.findFirst({
        where: { id: taskId, ownerId },
        select: { id: true, projectId: true },
      });
      if (!task || task.projectId !== projectId) {
        throw new NotFoundException('task not found in this project');
      }
      // J3 allows at most one in-flight LAND_TASK per task; the newest is the one that would be
      // stopped, and a task with none has nothing for this door.
      const landing = await tx.projectIntegrationJob.findFirst({
        where: { projectId, taskId, kind: 'LAND_TASK', state: { in: [...IN_FLIGHT_JOB_STATES] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true, state: true, phase: true, progressProtocol: true,
          pushReportedGeneration: true, claimGeneration: true,
        },
      });
      if (!landing) {
        throw new ConflictException({
          code: INTEGRATION_STOP_NOT_APPLICABLE,
          message: 'this task has no queued or running landing on this project\'s integration line, '
            + 'so there is nothing to stop. A task whose landing already finished is left as it '
            + 'finished: read the job list for what it answered.',
        });
      }
      // J-T4's boundary, read as a row fact for a v2 claim and from `phase` for a legacy one. A
      // generation past it may have pushed, and stopping it would claim otherwise.
      if (landing.state === 'RUNNING' && pushBoundaryPassed(landing)) {
        throw new ConflictException({
          code: INTEGRATION_STOP_PUSHED,
          message: 'this landing has passed the point where it may push — the server recorded its '
            + 'PUSH report, or a legacy claim reported PUSH or VERIFY — so the merge may already '
            + 'have happened. A stop cannot claim it did not: wait for its result, which is the fact.',
        });
      }
      // Rank 55 before the job row's rank-60 write, exactly as the result transaction takes it for
      // a stopped LAND_TASK: that is what orders this stop against a DONE queueing the next
      // generation, and it is why the deferred enqueue below can read the marker safely.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "project_codebase"
         WHERE "project_id" = ${projectId}::uuid AND "slot" = 'primary'
         FOR UPDATE`);
      const stoppedAt = new Date();
      const stopped = await stopInFlightJob(tx, {
        projectId,
        jobId: landing.id,
        now: stoppedAt,
        cause: 'STOP',
        actor: { type: 'OWNER', userId: ownerId },
      });
      if (stopped.outcome === 'NONE') {
        throw new ConflictException({
          code: INTEGRATION_STOP_NOT_APPLICABLE,
          message: 'this landing moved on while the stop was being decided — it was claimed, '
            + 'finished or stopped by another press. Read the job again.',
        });
      }
      if (stopped.outcome !== 'STOP_REQUESTED') {
        await this.queueDeferredDoneAfterStop(tx, ownerId, taskId);
      }
      return {
        taskId,
        jobId: landing.id,
        state: stopped.outcome === 'CANCELLED'
          ? 'CANCELLED'
          : stopped.outcome === 'ENDED' ? 'ERROR' : 'CANCELLING',
        errorCode: stopped.errorCode,
      } satisfies TaskIntegrationStop;
    }, loggedRetry(this.logger, 'projectOpenItem.stopTaskIntegrationAsOwner'));
  }

  /**
   * J-T8's deferred DONE (revision 24): a stopped generation releases the enqueue a second DONE was
   * owed. Read again here, inside the transaction that wrote the terminal state; nothing is queued
   * unless the marker is still there and the task is DONE at this instant.
   */
  private async queueDeferredDoneAfterStop(
    tx: Prisma.TransactionClient,
    ownerId: string,
    taskId: string,
  ): Promise<void> {
    const intent = await tx.taskReopenIntent.findFirst({
      where: { taskId }, select: { taskId: true },
    });
    if (!intent) return;
    const task = await tx.task.findFirst({ where: { id: taskId }, select: { status: true } });
    if (task?.status !== 'DONE') return;
    await enqueueForDoneTask(tx, ownerId, taskId);
  }

  /**
   * The project's coordinator queues one of its failed landings again with the merge check NOT RUN
   * (`integration_skip_merge_check`, §2.4 J-S5) — `retryIntegration` plus the one semantic, and only
   * with the account owner's yes on a confirmation card.
   *
   * WHY A SKIP AND NOT A RERUN. A red merge check can be about the check rather than the delivery:
   * the command runs on the machine the runner is on, and on 2026-10-07 that machine's bash had
   * neither `mapfile` nor a GNU `timeout`, so the check of project 34bZ3i4AvgJaaoaw5E9tH failed
   * whatever the work did. Rerunning it runs the same command again (integration_retry), sending the
   * work back blames work that is not at fault (task_reopen), and the check COMMAND is the account
   * owner's to change — so the decision "this landing goes on without that check" is the owner's, and
   * the card is where they make it.
   *
   * WHO MAY ASK, AND WHO MUST AGREE. The conversation the project is coordinated from, exactly as for
   * a rerun, plus an ALLOWED card raised by that same conversation about THIS project and THIS task
   * (`decideIntegrationSkipCheck` reads all four off the row, and a call naming none is refused with
   * nothing queued). The owner's own channel is the other way round: their press IS the approval, so
   * `skipIntegrationMergeCheckAsOwner` needs no card and records them as the one who gave it — which
   * is also what the CLI at a terminal does, where the caller is the person.
   *
   * WHAT IT WRITES. One transaction under the task row (FOR NO KEY UPDATE, the lock the DONE
   * transaction holds): the decision over the facts read under it, then exactly one new LAND_TASK
   * generation (`queueLandingRetry` with `skipMergeCheck`) carrying what it reruns, why, who approved
   * the skip and the card it was approved on, then the coordinator's open items about the failed
   * landing marked as being HANDLED by that generation (§4.7 H1) — still OPEN, because nobody knows
   * yet whether it lands. Nothing else changes: the project's `mergeCheckCommand` is not touched, the
   * generation after this one is queued without the flag, and promotion checks are not this door's at
   * all. The check is skipped, never passed: the row says so, and so does any item the landing goes
   * on to open.
   */
  // The coordinator's door only ever answers a failed landing; the owner's may also answer one in
  // flight (`skipInFlightLandingCheck`), so only the owner's call is typed with both answers.
  skipIntegrationMergeCheck(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string; approvalId?: string },
    actingSessionId: string | undefined,
  ): Promise<IntegrationSkipChecked>;
  skipIntegrationMergeCheck(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string; approvalId?: string },
    actingSessionId: string | undefined,
    requester: { userId: string },
  ): Promise<IntegrationSkipChecked | InFlightLandingSkipped>;
  async skipIntegrationMergeCheck(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string; approvalId?: string },
    actingSessionId: string | undefined,
    requester?: { userId: string },
  ): Promise<IntegrationSkipChecked | InFlightLandingSkipped> {
    const reason = rerunReason(given);
    const approvalId = typeof given?.approvalId === 'string' ? given.approvalId.trim() : '';
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { coordinatorSessionId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    const ownerRequester = requester?.userId ?? null;
    if (!ownerRequester && (!asking || asking !== project.coordinatorSessionId)) {
      throw rerunCoordinatorOnly();
    }
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('task not found');
    if (task.projectId !== projectId) {
      throw new ForbiddenException({
        code: INTEGRATION_SKIP_CHECK_NOT_THIS_PROJECT,
        message:
          'this task is not filed under this project, and a project\'s coordinator skips a check on '
          + 'its own project\'s landings. The task\'s own project, and its coordinator, decide this one.',
      });
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status" FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
           AND "project_id" = ${projectId}::uuid
         FOR NO KEY UPDATE`);
      if (!locked) throw new NotFoundException('task not found in this project');
      // Read again under the lock, as the rerun door does: the pointer can rotate while the call was
      // on its way here, and a card answered for one coordinator is not another's to spend.
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      if (!ownerRequester && current.coordinatorSessionId !== asking) throw rerunCoordinatorOnly();
      const newestLanding = await tx.projectIntegrationJob.findFirst({
        where: { taskId, kind: 'LAND_TASK' },
        orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, generation: true, state: true, checks: true, phase: true },
      });
      if (ownerRequester && newestLanding
        && isInFlightJobState(newestLanding.state)) {
        return this.skipInFlightLandingCheck(tx, {
          ownerId, projectId, taskId, taskStatus: locked.status, jobId: newestLanding.id, reason,
        });
      }
      const openItems = await tx.projectOpenItem.findMany({
        where: { projectId, taskId, kind: { in: [...INTEGRATION_ITEM_KINDS] }, state: 'OPEN' },
        select: { id: true, kind: true, assignee: true, assigneeReason: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      const ownerBlockers = await tx.projectBlocker.findMany({
        where: { projectId, subjectType: 'TASK', subjectId: taskId, owner: 'USER', resolvedAt: null },
        select: { id: true, kind: true },
      });
      // The card, read by the id the caller handed over. Read as the row it is rather than trusted as
      // a sentence: whether it was answered, by which conversation, and about which landing are all
      // facts on this row, and `decideIntegrationSkipCheck` refuses anything but an answered card
      // about this very task. An owner-channel call names none and needs none.
      //
      // Only among this account's own cards: another account's is no card here, refused as an id that
      // names nothing is, so a refusal never repeats what is on somebody else's row — its tool, its
      // answer, the conversation it was raised in (tenant-isolation-runner-cases.ts).
      //
      // An id that is not an id is refused here rather than looked up: an approval id is a uuid, and
      // anything else would reach a uuid column and come back as a 500 from the database.
      if (!ownerRequester && approvalId && !isApprovalId(approvalId)) {
        const refusal = notAnApprovalId(approvalId);
        throw new HttpException(refusal.body, refusal.status);
      }
      const approval = ownerRequester || !approvalId ? null : await tx.approval.findFirst({
        where: { id: approvalId, session: { ownerId } },
        select: {
          id: true, toolName: true, status: true, sessionId: true, input: true, decidedById: true,
        },
      });
      const decision = decideIntegrationSkipCheck({
        requester: ownerRequester ? 'OWNER' : 'COORDINATOR',
        coordinatorEnabled: current.coordinatorEnabled,
        taskStatus: locked.status,
        newestLanding,
        openItems,
        ownerBlockers,
        projectId,
        taskId,
        actingSessionId: ownerRequester ? null : asking!,
        approval: approval
          ? {
            id: approval.id,
            toolName: approval.toolName,
            status: approval.status,
            sessionId: approval.sessionId,
            input: (approval.input ?? null) as { projectId?: unknown; taskId?: unknown } | null,
            decidedById: approval.decidedById,
          }
          : null,
      });
      if (!decision.ok) throw new HttpException(decision.body, decision.status);

      // Whose yes this is, and it is always somebody: the owner's own press on their channel, or the
      // person the card names as its decider — the decision above refuses an ALLOWED card that names
      // nobody, so a skip is never recorded as approved by a rule. The last fallback is the account
      // owner, unreachable through this door and there so the row always carries a name.
      const approvedByUserId = ownerRequester ?? approval?.decidedById ?? ownerId;
      const queued = await queueLandingRetry(tx, {
        ownerId,
        projectId,
        taskId,
        retry: {
          ofJobId: decision.retryOfJobId,
          // Only `retryIntegration` hands a decision the branch tips, so only it can answer CONFLICT.
          failureClass: decision.failureClass as RetryableLandingFailureClass,
          reason,
          requestedBySessionId: ownerRequester ? undefined : asking!,
          requestedByUserId: ownerRequester ?? undefined,
        },
        skipMergeCheck: {
          reason,
          approvedByUserId,
          approvalId: approval?.id ?? null,
        },
      });
      if (!queued) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message:
            'the landing could not be queued: the task has no work branch to hand the line, or the '
            + 'project no longer integrates on a branch of its own.',
        });
      }
      await markOpenItemsHandling(tx, decision.handle, {
        jobId: queued.jobId,
        sessionId: ownerRequester ? null : asking!,
        userId: ownerRequester,
        reason,
      });
      return {
        taskId,
        jobId: queued.jobId,
        generation: queued.generation,
        sourceRef: queued.sourceRef,
        landingSessionId: queued.landingSessionId,
        retryOfJobId: decision.retryOfJobId,
        failureClass: decision.failureClass,
        reason,
        skippedCheck: {
          reason,
          approvedByUserId,
          approvalId: approval?.id ?? null,
        },
        handlingItemIds: decision.handle,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.skipIntegrationMergeCheck'));
  }

  /**
   * The account owner's user-channel door for skipping one landing's merge check — a failed one, as
   * the coordinator's card-gated door does, or one still in flight (`skipInFlightLandingCheck`).
   */
  async skipIntegrationMergeCheckAsOwner(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string },
  ): Promise<IntegrationSkipChecked | InFlightLandingSkipped> {
    return this.skipIntegrationMergeCheck(ownerId, projectId, taskId, given, undefined, { userId: ownerId });
  }

  /**
   * The owner's "Land without the check" on a landing still in flight (§2.4 J-S5): the same skip
   * as after a failed check, asked before the check has answered — the check is long, and the owner
   * has decided this landing does not wait for it.
   *
   * J3 allows one landing of a task in flight, so the generation in flight is stopped first, by the
   * stop every door uses (`stopInFlightJob`, J-T8). A QUEUED one, or one whose runner went silent
   * past its limit, ends on the spot, and the generation without the check is queued here. A live
   * claim is only ASKED, and the stop's own line carries the skip: the result transaction queues the
   * generation without the check once the runner has answered (`queueSkippedLandingAfterStop`).
   *
   * Refused when the landing is past the push (it may already have landed), already asked to stop,
   * already the generation without the check, or when the project runs no landing check at all —
   * the same rule (`inFlightSkipRefusal`) that decides whether the landing card offers the button.
   * The owner's press is the approval: no card, and the skip columns name them.
   */
  private async skipInFlightLandingCheck(
    tx: Prisma.TransactionClient,
    input: {
      ownerId: string; projectId: string; taskId: string; taskStatus: string; jobId: string; reason: string;
    },
  ): Promise<InFlightLandingSkipped> {
    const { ownerId, projectId, taskId, reason } = input;
    if (input.taskStatus !== 'DONE') {
      throw new ConflictException({
        code: INTEGRATION_RETRY_NOT_APPLICABLE,
        message: `this task is ${input.taskStatus}, not DONE, so its landing is about to be stopped `
          + 'anyway: its next DONE lands the work.',
      });
    }
    // Rank 55 before the job row's rank-60 write, as the stop door takes it: this orders the stop
    // against a result or a DONE that would queue the next generation.
    const [codebase] = await tx.$queryRaw<Array<{
      landingCheckCommand: string | null; landingCheckNone: boolean; mergeCheckCommand: string | null;
    }>>(Prisma.sql`
      SELECT "landing_check_command" AS "landingCheckCommand",
             "landing_check_none" AS "landingCheckNone",
             "merge_check_command" AS "mergeCheckCommand"
        FROM "project_codebase"
       WHERE "project_id" = ${projectId}::uuid AND "slot" = 'primary'
         FOR UPDATE`);
    const job = await tx.projectIntegrationJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true, kind: true, state: true, phase: true, cancelRequestedAt: true, skipMergeCheck: true,
        progressProtocol: true, pushReportedGeneration: true, claimGeneration: true,
      },
    });
    if (!job) throw new NotFoundException('landing not found');
    const refusal = inFlightSkipRefusal({
      ...job,
      landingCheckCommand: codebase?.landingCheckCommand ?? null,
      landingCheckNone: codebase?.landingCheckNone ?? false,
      mergeCheckCommand: codebase?.mergeCheckCommand ?? null,
    });
    if (refusal) throw new ConflictException(refusal);

    const skippedCheck = { reason, approvedByUserId: ownerId, approvalId: null };
    const stopped = await stopInFlightJob(tx, {
      projectId,
      jobId: job.id,
      now: new Date(),
      cause: SKIP_CHECK_STOP_CAUSE,
      actor: { type: 'OWNER', userId: ownerId },
      reason,
      data: { skip: { reason, approvedByUserId: ownerId } },
    });
    if (stopped.outcome === 'NONE') {
      throw new ConflictException({
        code: INTEGRATION_RETRY_NOT_APPLICABLE,
        message: 'this landing moved on while the skip was being decided — it was claimed, finished '
          + 'or stopped by another press. Read the landing again.',
      });
    }
    if (stopped.outcome === 'STOP_REQUESTED') {
      return {
        taskId, stoppedJobId: job.id, state: 'STOPPING',
        jobId: null, generation: null, landingSessionId: null, reason, skippedCheck,
      };
    }
    // A stopped generation releases the enqueue a reopened task's second DONE was owed (J-T8),
    // exactly as the stop door does; that generation is the new work's, and it runs the check.
    await this.queueDeferredDoneAfterStop(tx, ownerId, taskId);
    const queued = await queueLandingRetry(tx, {
      ownerId, projectId, taskId, skipMergeCheck: skippedCheck,
    });
    if (!queued) {
      throw new ConflictException({
        code: INTEGRATION_RETRY_NOT_APPLICABLE,
        message: 'the landing was stopped but could not be queued again: the task has no work branch '
          + 'to hand the line, the project no longer integrates on a branch of its own, or another '
          + 'landing of this task was queued first.',
      });
    }
    return {
      taskId, stoppedJobId: job.id, state: 'QUEUED',
      jobId: queued.jobId, generation: queued.generation, landingSessionId: queued.landingSessionId,
      reason, skippedCheck,
    };
  }

  /**
   * The project's coordinator runs a blocked candidate's check again (`integration_retry` with a
   * `promotionId`, §4.7 H1): the item about a merge into main that names no task, which until now had
   * no door the coordinator could answer it through — it waited, escalated on the clock, and sat in
   * front of the owner however little of it was theirs.
   *
   * The same door as a task's landing, held to the same rules: a reason, the conversation the project
   * is coordinated from, refused while anything about the candidate is in flight, refused for a
   * conflict, and refused when an item about it is the account owner's — escalated, or theirs from
   * birth in a project that is not Automatic (`decidePromotionRetry`). What it may rerun is the
   * candidate's CHECK and nothing past it: a check that passes puts the candidate back in front of
   * whoever confirms its merge — the owner's card, or the Automatic setting's own rule over a clean
   * result (M-T11) — and this door is neither.
   *
   * WHAT IT WRITES. One transaction under the candidate row (FOR NO KEY UPDATE, the lock every other
   * writer of a candidate takes by updating it): the decision over the facts read under it, then the
   * next CHECK_PROMOTION generation with the candidate back in CHECKING (`requeuePromotionCheck`), then
   * the coordinator's open items about the candidate marked as being handled by that check — still
   * OPEN until it reports. A check that passes makes them HANDLED in the coordinator's name; one that
   * fails again supersedes them with its own item.
   *
   * A TIMED-OUT CHECK (§2.2 J-T9). A newest check that is RUNNING but silent past its limit is judged
   * by the same read the job list draws (`readInFlightJobs`), and a retry of it first ends it as
   * `ERROR · RUNNER_LOST` — the compare-and-set on the heartbeat it was judged from — then requeues
   * the check like any other rerun, with the candidate readmitted from CHECKING as well as BLOCKED.
   * The account owner's door (`retryPromotionCheckAsOwner`) is this same method, held to the same
   * rules.
   */
  async retryPromotionCheck(
    ownerId: string,
    projectId: string,
    promotionId: string,
    given: { reason?: string },
    actingSessionId: string | undefined,
    requester?: { userId: string },
  ): Promise<PromotionCheckRetried> {
    const reason = rerunReason(given);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { coordinatorSessionId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    const ownerRequester = requester?.userId ?? null;
    if (!ownerRequester && (!asking || asking !== project.coordinatorSessionId)) {
      throw rerunCoordinatorOnly();
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ state: string }>>(Prisma.sql`
        SELECT "state" FROM "project_promotion"
         WHERE "id" = ${promotionId}::uuid AND "project_id" = ${projectId}::uuid
           AND "owner_id" = ${ownerId}::uuid
         FOR NO KEY UPDATE`);
      if (!locked) throw new NotFoundException('promotion not found in this project');
      // Read again under the lock: the pointer can rotate, and the switch can move, while the call
      // was on its way here.
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      if (!ownerRequester && current.coordinatorSessionId !== asking) throw rerunCoordinatorOnly();
      const newestJob = await tx.projectIntegrationJob.findFirst({
        where: { promotionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, kind: true, generation: true, state: true, checks: true },
      });
      // Whether a RUNNING check timed out, by the rule the job list draws it with (§1.6).
      const [silent] = newestJob?.state === 'RUNNING'
        ? await readInFlightJobs(tx, projectId, newestJob.id)
        : [];
      const openItems = await tx.projectOpenItem.findMany({
        where: { projectId, promotionId, kind: { in: [...INTEGRATION_ITEM_KINDS] }, state: 'OPEN' },
        select: {
          id: true, kind: true, assignee: true, assigneeReason: true,
          workSessionOfferedAt: true, workSessionReturnedAt: true,
        },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      // W9 (revision 42): a MAIN line's task-branch candidate whose failure its task's session is fixing.
      if (openItems.some(inWorkSessionHands)) throw withWorkSession();
      const decision = decidePromotionRetry({
        requester: ownerRequester ? 'OWNER' : 'COORDINATOR',
        coordinatorEnabled: current.coordinatorEnabled,
        promotionState: locked.state,
        newestJob: newestJob && { ...newestJob, timedOut: silent?.timedOut === true },
        openItems,
      });
      if (!decision.ok) throw new HttpException(decision.body, decision.status);
      if (decision.endsTimedOutJob && (silent ? await endTimedOutLanding(tx, silent, 'RECHECK') : null) === null) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_IN_FLIGHT,
          message: 'this check\'s runner reported again while the retry was being decided, so it has not '
            + 'timed out any more. Read the project again.',
        });
      }

      const queued = await requeuePromotionCheck(tx, {
        promotionId,
        retry: {
          ofJobId: decision.retryOfJobId,
          // Only `retryIntegration` hands a decision the branch tips, so only it can answer CONFLICT.
          failureClass: decision.failureClass as RetryableLandingFailureClass,
          reason,
          requestedBySessionId: ownerRequester ? undefined : asking!,
          requestedByUserId: ownerRequester ?? undefined,
        },
      });
      if (!queued) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message: 'the check could not be queued: this project no longer names the repository the '
            + 'candidate was made in.',
        });
      }
      await markOpenItemsHandling(tx, decision.handle, {
        jobId: queued.jobId,
        sessionId: ownerRequester ? null : asking!,
        userId: ownerRequester,
        reason,
      });
      return {
        promotionId,
        jobId: queued.jobId,
        generation: queued.generation,
        landingSessionId: queued.landingSessionId,
        retryOfJobId: decision.retryOfJobId,
        failureClass: decision.failureClass,
        reason,
        handlingItemIds: decision.handle,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.retryPromotionCheck'));
  }

  /** The account owner's user-channel door for a blocked promotion check. */
  async retryPromotionCheckAsOwner(
    ownerId: string,
    projectId: string,
    promotionId: string,
    given: { reason?: string },
  ): Promise<PromotionCheckRetried> {
    return this.retryPromotionCheck(ownerId, projectId, promotionId, given, undefined, { userId: ownerId });
  }

  /**
   * Tell the project's current coordinator what the owner answered (§5.2 R10, R11).
   *
   * Keyed by the question AND the conversation, which is what makes a rotation safe: every
   * generation is told once, a replay of the same generation's key returns the turn already written,
   * and a project with nobody coordinating it is told nothing until it has somebody.
   *
   * Told whether or not the project's Automatic switch is on, for the reason `askOwner` asks either
   * way: the answer is the owner's reply to a question the coordinator put, not a hand-over the
   * switch has to authorize.
   */
  private async deliverAnswer(itemId: string): Promise<{ sessionId: string; turnId: string } | null> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        ownerId: true,
        projectId: true,
        state: true,
        resolution: true,
        resolvedAt: true,
        payload: true,
        answer: true,
        askedBySessionId: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item || item.state !== 'RESOLVED' || item.resolution !== 'ANSWERED') return null;
    if (!item.answer || !item.resolvedAt) return null;
    const sessionId = item.project.coordinatorSessionId;
    if (!sessionId) return null;
    const clientTurnId = ownerAnswerTurnId(item.id, sessionId);
    const question = item.payload as unknown as CoordinatorQuestion;
    // §5.2 R11: told to a conversation that did not ask, it says who did and whether it still blocks.
    const redelivered = item.askedBySessionId && item.askedBySessionId !== sessionId
      ? { stillBlocks: await this.unsettledBlockedTasks(item.ownerId, question.blocksTaskIds) }
      : undefined;
    const content = ownerAnswerMessage(
      question,
      item.answer as unknown as OwnerAnswer,
      item.resolvedAt,
      redelivered,
    );
    try {
      const turn = await this.sessions.createTurn(item.ownerId, sessionId, {
        clientTurnId,
        content,
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => this.acknowledgeAnswer(tx, {
          itemId: item.id,
          projectId: item.projectId,
          sessionId,
          clientTurnId,
        }),
      });
      await this.prisma.projectOpenItemDelivery.updateMany({
        where: { itemId: item.id, sessionId, purpose: 'ANSWER', clientTurnId, turnId: null },
        data: { turnId: turn.turnId },
      });
      return { sessionId, turnId: turn.turnId };
    } catch (error) {
      // A conversation that has ended is not revived to be told, and a key already held by a turn
      // means this generation has it. Both leave the answer on the item for the next coordinator.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) return null;
      if (error instanceof ConflictException) {
        this.logger.warn(`the answer to ${item.id} is already queued on ${sessionId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Tell the current coordinator that the owner declined a done request.
   *
   * `project_open_item_delivery` only has ITEM and ANSWER purposes.  A Not yet… press is an
   * answer to the card, so it uses ANSWER with the shared owner-answer client-turn namespace; the
   * item id + session id pair remains the idempotency key and cannot collide with a
   * coordinator-question answer because those are different item rows.
   */
  private async deliverDoneRequestDecline(
    itemId: string,
  ): Promise<{ sessionId: string; turnId: string } | null> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        ownerId: true,
        projectId: true,
        state: true,
        resolution: true,
        resolvedAt: true,
        payload: true,
        answer: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item || item.state !== 'RESOLVED' || item.resolution !== 'DECLINED') return null;
    if (!item.answer || !item.resolvedAt) return null;
    const note = (item.answer as { note?: unknown }).note;
    if (typeof note !== 'string' || !note) return null;
    const sessionId = item.project.coordinatorSessionId;
    if (!sessionId) return null;
    // Reuse the owner-answer namespace used by deliverAnswer.  A DONE_REQUEST has its own item id,
    // so this remains an item/session key while the transcript layer correctly marks the turn as an
    // Orbit-authored answer rather than as a sender-typed message.
    const clientTurnId = ownerAnswerTurnId(item.id, sessionId);
    // The note as the coordinator reads it: its translation into the agent language when one was made.
    const translated = (item.answer as { translation?: { text?: unknown } }).translation?.text;
    const content = doneRequestDeclineMessage(
      item.payload as unknown as DoneRequest,
      typeof translated === 'string' && translated ? translated : note,
      item.resolvedAt,
    );
    try {
      const turn = await this.sessions.createTurn(item.ownerId, sessionId, {
        clientTurnId,
        content,
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => this.acknowledgeDoneRequestDecline(tx, {
          itemId: item.id,
          projectId: item.projectId,
          sessionId,
          clientTurnId,
        }),
      });
      await this.prisma.projectOpenItemDelivery.updateMany({
        where: { itemId: item.id, sessionId, purpose: 'ANSWER', clientTurnId, turnId: null },
        data: { turnId: turn.turnId },
      });
      return { sessionId, turnId: turn.turnId };
    } catch (error) {
      // The answer is already durable.  A coordinator that is gone or a key already held by a turn
      // is left for a future coordinator/read path, exactly as an answered question is.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) return null;
      if (error instanceof ConflictException) {
        this.logger.warn(`the done-request decline ${item.id} is already queued on ${sessionId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * §5.2 R11: a conversation has just become this project's coordinator. Tell it the answers no
   * coordinator has read: answered while nobody coordinated, or queued to a conversation that ended
   * before its engine took the turn (a turn is read once `delivered_at` is set; an ANSWERED turn
   * without it was drained, not read).
   *
   * Not an answer an earlier generation already read, however much work it still blocks: it was acted
   * on there, and each one replayed is a whole-context turn the new coordinator spends saying so (33
   * on one rotation, 2026-11-12; 29 on a workspace switch, 2026-11-18, one of them read by four
   * generations before). What a successor needs of those is in its opening's state digest
   * (coordinator-digest.ts, "Owner answers in force"), read once and never as a turn.
   */
  private async deliverAnsweredQuestions(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { coordinatorSessionId: true },
    });
    const sessionId = project?.coordinatorSessionId ?? null;
    if (!sessionId) return;
    const unread = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT i."id"
        FROM "project_open_item" i
       WHERE i."project_id" = ${projectId}::uuid
         AND i."kind" = 'COORDINATOR_QUESTION'
         AND i."state" = 'RESOLVED'
         AND i."resolution" = 'ANSWERED'
         AND NOT EXISTS (
               SELECT 1 FROM "project_open_item_delivery" d
                WHERE d."item_id" = i."id" AND d."purpose" = 'ANSWER' AND d."session_id" = ${sessionId}::uuid)
         AND NOT EXISTS (
               SELECT 1
                 FROM "project_open_item_delivery" d
                 JOIN "conversation_turn" t
                   ON t."session_id" = d."session_id" AND t."client_turn_id" = d."client_turn_id"
                WHERE d."item_id" = i."id" AND d."purpose" = 'ANSWER' AND t."delivered_at" IS NOT NULL)
       ORDER BY i."resolved_at" DESC, i."id" DESC
       LIMIT ${ANSWERS_RECONSIDERED_PER_BINDING}
    `);
    for (const item of unread.reverse()) await this.deliverAnswer(item.id);
  }

  /** The tasks of the account's among these that are still somebody's to do, as a message names them. */
  private async unsettledBlockedTasks(
    ownerId: string,
    taskIds: ReadonlyArray<string> | undefined,
  ): Promise<Array<{ title: string; status: string }>> {
    const ids = unique(taskIds ?? []);
    if (ids.length === 0) return [];
    return this.prisma.task.findMany({
      where: { id: { in: ids }, ownerId, status: { notIn: ['DONE', 'CANCELLED'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { title: true, status: true },
    });
  }

  /** The answer's own ledger row, written in the turn's transaction under the Session lock (G6). */
  private async acknowledgeAnswer(
    tx: Prisma.TransactionClient,
    delivery: { itemId: string; projectId: string; sessionId: string; clientTurnId: string },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: delivery.sessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (sessionHasEnded(session)) {
      throw new SessionNotSendable('the coordinator conversation has ended');
    }
    await tx.projectOpenItemDelivery.upsert({
      where: {
        itemId_sessionId_purpose: {
          itemId: delivery.itemId,
          sessionId: delivery.sessionId,
          purpose: 'ANSWER',
        },
      },
      create: {
        itemId: delivery.itemId,
        projectId: delivery.projectId,
        sessionId: delivery.sessionId,
        purpose: 'ANSWER',
        clientTurnId: delivery.clientTurnId,
      },
      update: { clientTurnId: delivery.clientTurnId },
    });
  }

  /** The Not yet… answer's delivery ledger row, written in the turn's Session transaction. */
  private async acknowledgeDoneRequestDecline(
    tx: Prisma.TransactionClient,
    delivery: { itemId: string; projectId: string; sessionId: string; clientTurnId: string },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: delivery.sessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (sessionHasEnded(session)) {
      throw new SessionNotSendable('the coordinator conversation has ended');
    }
    await tx.projectOpenItemDelivery.upsert({
      where: {
        itemId_sessionId_purpose: {
          itemId: delivery.itemId,
          sessionId: delivery.sessionId,
          purpose: 'ANSWER',
        },
      },
      create: {
        itemId: delivery.itemId,
        projectId: delivery.projectId,
        sessionId: delivery.sessionId,
        purpose: 'ANSWER',
        clientTurnId: delivery.clientTurnId,
      },
      update: { clientTurnId: delivery.clientTurnId },
    });
  }

  /**
   * Close the items of tasks that have moved on (§4.2), re-derived from committed rows.
   *
   * A failure is answered by what happens to the task, not by anybody reporting back: it is done, it
   * was cancelled, a successor took over, or it is being attempted again. Idempotent and safe to call
   * from any edge after a task write — an item nothing has answered is left exactly as it is.
   *
   * The integration items (§4.2's three `INTEGRATION_*` rows) are answered on this same axis but by
   * a narrower set of facts, and the second statement is that difference. DONE does not answer one:
   * a task is DONE to be integrated, and what a conflict is waiting for is the landing (J-T5). Being
   * attempted again does not answer one either: the task being carried to a new commit is not the
   * new generation §4.2 names, and an item that closed on every retry would close on the way to the
   * landing that is supposed to answer it. Cancelled and replaced are the two that do — nobody is
   * going to land a task that is gone — and they name the fact they saw the way the item's own door
   * table names it: `SUCCESSOR_FILED` when a successor took the task over (`taskRepair`'s
   * `task_create`), `TASK_CLOSED` when it was cancelled (`task_update`'s cancel).
   *
   * Revision 29's two (§10.7) are the fourth and fifth statements. A `LANDING_UNOBSERVED` is answered
   * by the task leaving the DONE delivery it is about — replaced, cancelled, declared codeless, sent
   * back — and by its landing, which its receipt's own transaction usually wrote first
   * (`resolveLandingUnobservedOnLanding`); a `LANDED_WITHOUT_CONFIRMATION` by the task being
   * cancelled or replaced, and otherwise only by the owner's Accept.
   */
  async resolveByFact(taskIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(taskIds);
    if (ids.length === 0) return;
    await this.guarded('resolveByFact', async () => {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."status" = 'DONE' THEN 'TASK_DONE'
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 WHEN t."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                 ELSE 'RETRIED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" = 'TASK_FAILED'
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."status" IN ('DONE', 'CANCELLED')
                OR t."superseded_by_task_id" IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM "session" s
                   WHERE s."task_id" = t."id"
                     AND s."starts_task_work"
                     AND ${sessionHeldSql('s')}
                     AND (s."id" IS DISTINCT FROM i."session_id"
                          -- The failing attempt itself is not "in flight" merely because the turn
                          -- that wrote FAILED is still running; a message written to it afterwards
                          -- is. That turn resumes the same session (auto-retry, a coordinator
                          -- continuing the work, the failure card's Retry), and without this the
                          -- item never closes and escalates to the owner instead.
                          OR EXISTS (
                            SELECT 1 FROM "conversation_turn" resumed_turn
                             WHERE resumed_turn."session_id" = s."id"
                               AND resumed_turn."kind" = 'message'
                               AND resumed_turn."created_at" > (i."waiting_since" AT TIME ZONE 'UTC')))))`);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 ELSE 'TASK_CLOSED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS.map((kind) => Prisma.sql`${kind}`))})
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND i."dedupe_key" NOT LIKE 'ICB:%'
           AND (t."status" = 'CANCELLED' OR t."superseded_by_task_id" IS NOT NULL)`);
      // A delivery review is answered when the task leaves the DONE delivery it describes. A
      // landing itself is handled by the receipt-aware wake service, while reopen/cancel/replace
      // are settled here so an exception cannot remain owed forever.
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 WHEN t."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                 ELSE 'RETRIED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" = ${DELIVERY_REVIEW_KIND}
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."status" <> 'DONE' OR t."superseded_by_task_id" IS NOT NULL)`);
      // §10.7: what a `LANDING_UNOBSERVED` waits on is the DONE delivery it is about reaching the
      // line; once the task is no longer that delivery, or its work landed, it is answered.
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 WHEN t."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                 WHEN t."codeless" THEN 'CODELESS'
                 WHEN t."status" <> 'DONE' THEN 'RETRIED'
                 ELSE 'LANDED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" = ${LANDING_UNOBSERVED_KIND}
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."superseded_by_task_id" IS NOT NULL
                OR t."status" <> 'DONE'
                OR t."codeless"
                OR (${Prisma.raw(taskLandingSql('t'))}) <> 'NOT_KNOWN')`);
      // §10.7: work that reached main without confirmation is the owner's to accept for as long as
      // its task stands; a task cancelled or replaced is gone, and so is the question.
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 ELSE 'TASK_CLOSED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" = ${LANDED_WITHOUT_CONFIRMATION_KIND}
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."status" = 'CANCELLED' OR t."superseded_by_task_id" IS NOT NULL)`);
    });
  }

  /**
   * The project's open exceptions, in the two groups a reader acts on (§4.8): what waits for the
   * owner, and what the coordinator is handling. Both oldest first, which is the order somebody
   * catching up wants them in. Only what is still owed (`openItemOwed`): an item about a candidate or
   * a task that has moved on is in front of nobody, whether or not anything has closed it yet.
   */
  async list(ownerId: string, projectId: string): Promise<ProjectOpenItems> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      // Read here rather than per row: whether this project has a conversation to hand an item
      // BACK to decides one press on every item it owns, and it is one project either way.
      select: {
        id: true,
        title: true,
        coordinatorSessionId: true,
        coordinatorSession: { select: COORDINATOR_PAUSE_SELECT },
      },
    });
    if (!project) throw new NotFoundException('project not found');
    // A start request whose plan has moved is superseded before the items are read, so the owner is
    // never shown a card about a plan that is no longer there (`project-start-request.ts`).
    await this.guarded('supersedeStaleStartRequest', async () => {
      await supersedeStaleStartRequest(this.prisma, ownerId, projectId);
    });
    // And a done request about a project that has moved since — its criteria, its tasks or where
    // their work has landed — for the same reason (`project-done-request.ts`).
    await this.guarded('supersedeStaleDoneRequest', async () => {
      await supersedeStaleDoneRequest(this.prisma, ownerId, projectId, this.sessions);
    });
    const reach = await readCoordinatorReach(this.sessions, ownerId, project);
    const { askable, coordinator } = reach;
    const unreachable = coordinatorUnreachable(reach);
    const open = await this.prisma.projectOpenItem.findMany({
      where: { projectId, state: 'OPEN' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        kind: true,
        title: true,
        payload: true,
        assignee: true,
        assigneeReason: true,
        waitingSince: true,
        escalateAt: true,
        escalatedAt: true,
        handoverNote: true,
        taskId: true,
        sessionId: true,
        integrationJobId: true,
        promotionId: true,
        fuseEpisodeId: true,
        assignedAt: true,
        translation: true,
        workSessionId: true,
        workSessionOfferedAt: true,
        workSessionReturnedAt: true,
        workSessionReturnReason: true,
        ...HANDLING_SELECT,
        deliveries: {
          where: { purpose: 'ITEM' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { sessionId: true, clientTurnId: true, returnedAt: true, createdAt: true },
        },
      },
    });
    const settled = await openItemsNoLongerOwed(this.prisma, open.map((row) => row.id));
    const hidden = open.some((row) => row.assignee === 'COORDINATOR')
      ? new Set((await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT item."id" FROM "project_open_item" item
           WHERE item."project_id" = ${projectId}::uuid AND item."state" = 'OPEN'
             AND NOT ${openItemVisible('item')}
             -- W9 (revision 42): an item in its task's own work session's hands is never delivered to
             -- the coordinator, and the coordinator and the owner still see it here, with Chat about this.
             AND NOT (item."work_session_offered_at" IS NOT NULL AND item."work_session_returned_at" IS NULL)`)).map((row) => row.id))
      : new Set<string>();
    const rows = open.filter((row) => !settled.has(row.id) && !hidden.has(row.id));
    const keys = rows.flatMap((row) => row.deliveries);
    await this.guarded('translateUntranslatedItems', async () => {
      await this.translateUntranslatedItems(ownerId, projectId, rows);
    });
    // §4.7 H5: what the coordinator closed in the last day — handled, or superseded by the item its
    // failed rerun opened — so the card a conversation drew for it is seen to end rather than vanish.
    // The coordinator's own kinds only: a question, a merge card, a pause and a request each have a
    // card of their own and a door that is not this one.
    const closed = await this.prisma.projectOpenItem.findMany({
      where: {
        projectId,
        kind: { in: [...COORDINATOR_LEAD_KINDS] },
        resolvedBy: { in: ['COORDINATOR', 'USER'] },
        resolvedAt: { gte: new Date(Date.now() - SETTLED_WITHIN_MS) },
        OR: [
          { state: 'RESOLVED', resolution: 'HANDLED' },
          { state: 'SUPERSEDED', resolution: 'RETRIED' },
        ],
      },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
      take: SETTLED_SHOWN,
      select: {
        id: true,
        kind: true,
        title: true,
        payload: true,
        assignee: true,
        assigneeReason: true,
        waitingSince: true,
        escalatedAt: true,
        handoverNote: true,
        taskId: true,
        sessionId: true,
        promotionId: true,
        fuseEpisodeId: true,
        state: true,
        resolution: true,
        resolvedAt: true,
        resolvedBy: true,
        resolvedByUserId: true,
        resolvedBySessionId: true,
        resolvedByJobId: true,
        resolutionNote: true,
        supersededByItemId: true,
        integrationJobId: true,
        workSessionId: true,
        workSessionOfferedAt: true,
        workSessionReturnedAt: true,
        workSessionReturnReason: true,
      },
    });
    // Revision 42 (§12.7): the task's own work session each offered item went to, and the rounds it asked for.
    const workSessions = await readOpenItemWorkSessions(this.prisma, [...rows, ...closed]);
    // Which reruns are still in flight: an item is being handled only while the job its coordinator
    // queued is QUEUED or RUNNING (§4.7 H1). A job that ended without a verdict on it — cancelled with
    // its candidate, or answered "nothing to land" — leaves the item open and no longer handled.
    const handlingJobIds = unique(rows.map((row) => row.handlingJobId));
    const inFlight = new Map((handlingJobIds.length > 0
      ? await this.prisma.projectIntegrationJob.findMany({
          where: { id: { in: handlingJobIds }, state: { in: [...IN_FLIGHT_JOB_STATES] } },
          select: { id: true, kind: true, generation: true, state: true },
        })
      : []).map((job) => [job.id, job]));
    // When each of the coordinator's items goes to the owner, as the clock decides it (§4.6): a
    // conversation still carrying one moves that moment on, so it is read here rather than taken
    // from the column the item was opened with — which would have the card say "due" about an item
    // that is not coming.
    const goesAt = new Map<string, Date | null>();
    if (rows.some((row) => row.assignee === 'COORDINATOR')) {
      const due = await this.prisma.$queryRaw<Array<{ id: string; at: Date | null }>>(Prisma.sql`
        SELECT item."id", ${escalatesAt('item')} AS "at"
          FROM "project_open_item" item
         WHERE item."project_id" = ${projectId}::uuid
           AND item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR'`);
      for (const row of due) goesAt.set(row.id, row.at);
    }
    // The tasks these items are about, read once for the whole page: the card's first row names
    // what the item is about, and a task's title is not a column of the item. A task that is gone
    // leaves the row undrawn rather than drawn empty.
    const taskIds = unique([...rows, ...closed].map((row) => row.taskId));
    const tasks = taskIds.length > 0
      ? await this.prisma.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true },
        })
      : [];
    const titles = new Map(tasks.map((task) => [task.id, task.title]));
    const handledTasks = [...rows, ...closed].length > 0
      ? await this.prisma.task.findMany({
          where: { fixesOpenItemId: { in: unique([...rows, ...closed].map((row) => row.id)) } },
          select: { id: true, title: true, status: true, fixesOpenItemId: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const handledBy = new Map<string, Array<{ taskId: string; title: string; state: string }>>();
    for (const task of handledTasks) {
      if (!task.fixesOpenItemId) continue;
      const list = handledBy.get(task.fixesOpenItemId) ?? [];
      list.push({ taskId: task.id, title: task.title, state: task.status });
      handledBy.set(task.fixesOpenItemId, list);
    }
    const turns = keys.length > 0
      ? await this.prisma.conversationTurn.findMany({
          where: {
            OR: keys.map((key) => ({ sessionId: key.sessionId, clientTurnId: key.clientTurnId })),
          },
          select: { sessionId: true, clientTurnId: true, deliveredAt: true },
        })
      : [];
    const deliveredAt = new Map(
      turns.map((turn) => [`${turn.sessionId}:${turn.clientTurnId}`, turn.deliveredAt]),
    );
    const codebase = await readProjectCodebase(this.prisma, projectId);
    const mainBranch = mainBranchOf(codebase);
    // Read now rather than filed with the request: the binding's own branch, once it has one, or the
    // name the project's title gives it today — what a start with no branch named would choose.
    const defaultProjectBranchName = defaultProjectBranchOf(codebase, project);
    // The owner's language, read only when a question's card is translated: its detail line is served
    // translated too, in that language alone.
    const langs = rows.some((row) => row.kind === 'COORDINATOR_QUESTION' && row.translation)
      ? await translationLanguages(this.prisma, ownerId)
      : null;
    const view = rows.map((row): OpenItemRow => {
      const [sent] = row.deliveries;
      const handed = sent ? deliveredAt.get(`${sent.sessionId}:${sent.clientTurnId}`) ?? null : null;
      const handling = handlingOf(row, inFlight);
      const question = row.kind === 'COORDINATOR_QUESTION'
        ? (row.payload as unknown as CoordinatorQuestion)
        : null;
      const startRequest: ProjectStartRequest | null = row.kind === START_REQUEST_KIND
        ? { ...(row.payload as unknown as ProjectStartRequest), defaultProjectBranchName }
        : null;
      const doneRequest = row.kind === DONE_REQUEST_KIND
        ? (row.payload as unknown as DoneRequest)
        : null;
      const title = row.taskId ? titles.get(row.taskId) : undefined;
      return {
        itemId: row.id,
        kind: row.kind as OpenItemKind,
        title: row.title,
        detailLine: question
          ? questionDetailLine(question)
          : startRequest
            ? startRequestDetailLine(startRequest, defaultProjectBranchName)
            : doneRequest
              ? doneRequestDetailLine(doneRequest)
              : detailLine(row.kind, row.payload),
        question,
        ...(row.translation
          ? { translation: withTranslatedDetailLine(question, row.translation as unknown as OwnerCardTranslation, langs) }
          : {}),
        startRequest,
        doneRequest,
        ...baselineFields(row.payload),
        facts: openItemFacts(
          row.kind,
          row.payload,
          row.taskId && title ? { id: row.taskId, title } : null,
          mainBranch,
        ),
        assignee: row.assignee as OpenItemAssignee,
        assigneeReason: row.assigneeReason as OpenItemAssigneeReason,
        waitingSince: row.waitingSince,
        // A live fix/handling session deliberately returns NULL from escalatesAt. Preserve that
        // NULL instead of falling back to the frozen column, so list readers and min() agree with
        // the sweep about an in-flight item.
        escalateAt: goesAt.has(row.id) ? goesAt.get(row.id)! : row.escalateAt,
        escalatedAt: row.escalatedAt,
        handoverNote: row.handoverNote,
        taskId: row.taskId,
        handledBy: handledBy.get(row.id) ?? [],
        sessionId: row.sessionId,
        landingSessionId: landingSessionIdOf(row.payload),
        // §4.6 X-E5: only this kind's item is about a job a press (`ABANDON`) names; every other
        // row keeps the field null, so no client sees an id it has no door for.
        integrationJobId: row.kind === LANDING_LEASE_EXPIRED_KIND ? row.integrationJobId : null,
        // And only that kind's card counts its heading and words its Abandon from a claim.
        lease: row.kind === LANDING_LEASE_EXPIRED_KIND ? leaseFactsOf(row.payload) : null,
        promotionId: row.promotionId,
        fuseEpisodeId: row.fuseEpisodeId,
        delivery: row.assignee !== 'COORDINATOR'
          ? { state: 'NOT_REQUIRED', sessionId: null, at: null }
          : !sent
            ? { state: 'PENDING', sessionId: null, at: null }
            : sent.returnedAt
              ? { state: 'RETURNED', sessionId: sent.sessionId, at: sent.returnedAt }
              : handed
                ? { state: 'DELIVERED', sessionId: sent.sessionId, at: handed }
                : { state: 'QUEUED', sessionId: sent.sessionId, at: sent.createdAt },
        // One derivation, shared with the card recorded beside an item's delivery
        // (`openItemActions`): the same row read twice must not offer two sets of doors. The
        // asking press is listed only while there is a conversation to ask (see `askable` above);
        // the card leaves it undrawn then, and the wait that ran into this escalation is the one
        // thing left to say.
        actions: openItemActions({
          kind: row.kind,
          assignee: row.assignee,
          taskId: row.taskId,
          promotionId: row.promotionId,
          fuseEpisodeId: row.fuseEpisodeId,
          askable,
          payload: row.payload,
          // W9: an item its task's own session holds offers no press here (`OPEN_ITEM_WORK_SESSION_DOOR_TABLE`).
          workSession: inWorkSessionHands(row),
        }),
        requiredAction: openItemRequiredAction({
          kind: row.kind,
          assignee: row.assignee,
          taskId: row.taskId,
          promotionId: row.promotionId,
          fuseEpisodeId: row.fuseEpisodeId,
          askable,
          payload: row.payload,
          state: 'OPEN',
          handledBy: handledBy.get(row.id) ?? [],
          handoverNote: row.handoverNote,
          mainBranch,
        }),
        primaryAction: primaryAction({
          kind: row.kind,
          assignee: row.assignee,
          taskId: row.taskId,
          promotionId: row.promotionId,
          fuseEpisodeId: row.fuseEpisodeId,
          askable,
          payload: row.payload,
          state: 'OPEN',
          handledBy: handledBy.get(row.id) ?? [],
          handoverNote: row.handoverNote,
          workSession: inWorkSessionHands(row),
        }),
        handling,
        outcome: null,
        chat: openItemChat({
          assignee: row.assignee,
          handling: handling != null,
          resolution: null,
          coordinator,
        }),
        coordinatorUnreachable: unreachable,
        workSession: workSessions.get(row.id) ?? null,
      };
    });
    const settledView = closed.map((row): OpenItemRow => {
      const title = row.taskId ? titles.get(row.taskId) : undefined;
      return {
        itemId: row.id,
        kind: row.kind as OpenItemKind,
        title: row.title,
        // §10.5 O-L8's line asks for something, and nothing is asked of a settled item.
        detailLine: outdatedRunnerOf(row.payload) ? '' : detailLine(row.kind, row.payload),
        question: null,
        startRequest: null,
        doneRequest: null,
        ...baselineFields(row.payload),
        facts: openItemFacts(
          row.kind,
          row.payload,
          row.taskId && title ? { id: row.taskId, title } : null,
          mainBranch,
        ),
        assignee: row.assignee as OpenItemAssignee,
        assigneeReason: row.assigneeReason as OpenItemAssigneeReason,
        waitingSince: row.waitingSince,
        escalateAt: null,
        escalatedAt: row.escalatedAt,
        handoverNote: row.handoverNote,
        taskId: row.taskId,
        handledBy: handledBy.get(row.id) ?? [],
        sessionId: row.sessionId,
        landingSessionId: landingSessionIdOf(row.payload),
        integrationJobId: null,
        lease: null,
        promotionId: row.promotionId,
        fuseEpisodeId: row.fuseEpisodeId,
        // Nobody is owed anything about a closed item, so nothing is on its way to anybody and
        // there is nothing to press.
        delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
        actions: [],
        requiredAction: openItemRequiredAction({
          kind: row.kind,
          assignee: row.assignee,
          taskId: row.taskId,
          promotionId: row.promotionId,
          fuseEpisodeId: row.fuseEpisodeId,
          payload: row.payload,
          state: row.state,
          handledBy: handledBy.get(row.id) ?? [],
          handoverNote: row.handoverNote,
        }),
        handling: null,
        outcome: {
          state: row.state as OpenItemOutcome['state'],
          resolution: row.resolution as OpenItemOutcome['resolution'],
          resolvedBy: row.resolvedBy as OpenItemOutcome['resolvedBy'],
          resolvedByUserId: row.resolvedByUserId,
          resolvedBySessionId: row.resolvedBySessionId,
          resolvedAt: row.resolvedAt!,
          note: row.resolutionNote,
          jobId: row.resolvedByJobId,
          supersededByItemId: row.supersededByItemId,
        },
        chat: openItemChat({
          assignee: row.assignee,
          handling: false,
          resolution: row.resolution as OpenItemOutcome['resolution'],
          coordinator,
        }),
        workSession: workSessions.get(row.id) ?? null,
      };
    });
    const latestRequest = await this.prisma.projectOpenItem.findFirst({
      where: { projectId, kind: DONE_REQUEST_KIND },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { state: true, resolution: true, resolvedBy: true, resolutionNote: true, resolvedAt: true },
    });
    return {
      latestDoneRequestSuperseded: latestRequest?.state === 'SUPERSEDED'
        && latestRequest.resolvedBy === 'PLATFORM' && latestRequest.resolvedAt
        && latestRequest.resolvedAt.getTime() > Date.now() - 24 * 60 * 60 * 1000
        ? { reason: latestRequest.resolutionNote!, supersededAt: latestRequest.resolvedAt }
        : null,
      latestDoneRequestDecline: latestRequest?.state === 'RESOLVED'
        && latestRequest.resolution === 'DECLINED' && latestRequest.resolvedAt
        ? { note: latestRequest.resolutionNote!, declinedAt: latestRequest.resolvedAt }
        : null,
      // Revision 42 (§12.7): an item in its task's own work session's hands is nobody's to act on yet — not the
      // owner's Needs you, and not among what the coordinator is handling — and is listed apart.
      needsYou: view.filter((row) => row.assignee === 'OWNER' && !heldBySession(row)
        && row.kind !== START_REQUEST_KIND && row.kind !== DONE_REQUEST_KIND),
      withCoordinator: view.filter((row) => row.assignee === 'COORDINATOR' && !heldBySession(row)),
      withWorkSession: view.filter(heldBySession),
      startRequest: view.find((row) => row.kind === START_REQUEST_KIND) ?? null,
      doneRequest: view.find((row) => row.kind === DONE_REQUEST_KIND) ?? null,
      settled: settledView,
      closedQuestions: await this.closedQuestions(projectId),
      mainBranch,
      signIns: await this.signInWaits(ownerId, projectId),
      accountWait: await this.accountWait(ownerId, projectId),
    };
  }

  /**
   * Decision 1A: an open item whose card is translated (TRANSLATED_ITEM_FIELDS, or a hand-over note) and that has no translation in the
   * owner's current language — translation was turned on after it was filed, or the language changed — gets one
   * queued as it is read. At most one per item and language is queued at a time (`queueItemTranslation`), so a
   * list read again while it runs queues nothing more; one already tried in this language, failed or not, is left.
   */
  private async translateUntranslatedItems(
    ownerId: string,
    projectId: string,
    rows: ReadonlyArray<{ id: string; kind: string; translation: unknown; handoverNote: string | null }>,
  ): Promise<void> {
    if (!rows.some((row) => itemTranslatedFields(row.kind, row.handoverNote))) return;
    const langs = await translationLanguages(this.prisma, ownerId);
    if (!langs) return;
    for (const row of rows) {
      if (itemTranslatedFields(row.kind, row.handoverNote) && !translatedInto(row.translation, langs)) {
        this.queueItemTranslation(ownerId, projectId, row.id, langs);
      }
    }
  }

  /**
   * The questions this project's coordinator asked that have ended, newest first (§4.8, §5.2 R10,
   * R12): answered by the owner, or withdrawn. Each carries the question as it was asked and what
   * became of it, so the card the conversation drew is drawn as the record it became — after a
   * relaunch, and on a device that never saw it open — instead of vanishing with the open row.
   *
   * Where the answer went is the first ANSWER delivery (§5.2 R11 may add one per later
   * coordinator); none yet is an answer still waiting for this project's next coordinator.
   */
  private async closedQuestions(projectId: string): Promise<ProjectClosedQuestion<Date>[]> {
    const rows = await this.prisma.projectOpenItem.findMany({
      where: {
        projectId,
        kind: 'COORDINATOR_QUESTION',
        state: 'RESOLVED',
        resolution: { in: ['ANSWERED', 'WITHDRAWN'] },
      },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
      take: CLOSED_QUESTIONS_SHOWN,
      select: {
        id: true,
        payload: true,
        createdAt: true,
        resolution: true,
        resolvedBy: true,
        resolvedAt: true,
        resolutionNote: true,
        answer: true,
        translation: true,
        deliveries: {
          where: { purpose: 'ANSWER' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { sessionId: true, createdAt: true },
        },
      },
    });
    return rows.map((row) => {
      const answered = row.resolution === 'ANSWERED';
      const answer = answered ? (row.answer as unknown as OwnerAnswer | null) : null;
      const [delivered] = row.deliveries;
      return {
        itemId: row.id,
        question: row.payload as unknown as CoordinatorQuestion,
        askedAt: row.createdAt,
        resolution: answered ? 'ANSWERED' : 'WITHDRAWN',
        resolvedBy: row.resolvedBy === 'COORDINATOR' ? 'COORDINATOR' : 'USER',
        resolvedAt: row.resolvedAt!,
        answer: answer ? { option: answer.option ?? null, text: answer.text ?? null } : null,
        delivery: answered && delivered
          ? { sessionId: delivered.sessionId, at: delivered.createdAt }
          : null,
        withdrawReason: answered ? null : row.resolutionNote,
        ...(row.translation ? { translation: row.translation as unknown as OwnerCardTranslation } : {}),
      };
    });
  }

  /**
   * The delivery's own ledger row, written in the turn's transaction under the Session lock (§0.3 G6).
   *
   * Three things are decided here rather than before the call, because here they are decided under
   * the lock that makes them true at the moment the turn is written: the conversation has not ended,
   * the item is still owed to the coordinator with the assignment this turn's key names, and the row
   * that records the delivery. A throw rolls the turn back with it.
   */
  private async acknowledgeDelivery(
    tx: Prisma.TransactionClient,
    delivery: {
      itemId: string;
      projectId: string;
      assignedAt: Date;
      sessionId: string;
      clientTurnId: string;
    },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: delivery.sessionId },
      select: COORDINATOR_PAUSE_SELECT,
    });
    if (sessionHasEnded(session) || conversationIsPaused(session)) {
      throw new SessionNotSendable('the coordinator conversation has ended');
    }
    const [owed] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count"
        FROM "project_open_item" item
       WHERE item."id" = ${delivery.itemId}::uuid
         AND item."state" = 'OPEN'
         AND item."assignee" = 'COORDINATOR'
         AND item."assigned_at" = ${delivery.assignedAt.toISOString()}::timestamptz
         AND NOT EXISTS (
           SELECT 1
             FROM "project_integration_job" handling
            WHERE handling."id" = item."handling_job_id"
              AND handling."state" IN ${IN_FLIGHT_JOB_STATES_SQL}
         )`);
    if ((owed?.count ?? 0) === 0) throw new OpenItemNoLongerOwed();
    // One row per item per conversation. A row that was taken back unrun is re-armed rather than
    // duplicated: the item is owed again, and this is the delivery that answers it.
    await tx.projectOpenItemDelivery.upsert({
      where: {
        itemId_sessionId_purpose: {
          itemId: delivery.itemId,
          sessionId: delivery.sessionId,
          purpose: 'ITEM',
        },
      },
      create: {
        itemId: delivery.itemId,
        projectId: delivery.projectId,
        sessionId: delivery.sessionId,
        purpose: 'ITEM',
        clientTurnId: delivery.clientTurnId,
      },
      update: {
        clientTurnId: delivery.clientTurnId,
        turnId: null,
        returnedAt: null,
        returnCode: null,
        createdAt: new Date(),
      },
    });
  }

  /**
   * Whether this assignment has already been put in front of that conversation (§4.4 X-D2).
   *
   * The ledger's own answer to "has anybody been told", and the one `deliver` asks before it decides
   * that an item the platform may not hand over belongs to the owner. The row is not a hope: it is
   * written inside `createTurn`'s transaction, so a live one under this item, this conversation and
   * this assignment is the turn itself — already queued or already read. `returnedAt: null` is the
   * other half of it: a delivery that was taken back is a delivery that was not made, and the item
   * goes wherever the switch says it goes.
   */
  private async carried(
    itemId: string,
    assignedAt: Date,
    sessionId: string | null,
  ): Promise<boolean> {
    if (!sessionId) return false;
    const carried = await this.prisma.projectOpenItemDelivery.count({
      where: {
        itemId,
        sessionId,
        purpose: 'ITEM',
        returnedAt: null,
        clientTurnId: openItemTurnId(itemId, assignedAt),
      },
    });
    return carried > 0;
  }

  /**
   * An item nobody's coordinator can read is the owner's (§4.4 X-D6) — while it is still owed
   * (`openItemOwed`). One about a candidate or a task that has moved on is nobody's: it stays where it
   * is, and the escalation tick's backstop closes it.
   */
  private async handToOwner(
    itemId: string,
    assignedAt: Date,
    reason: Extract<OpenItemAssigneeReason, 'NO_COORDINATOR' | 'COORDINATOR_ENDED'>,
  ): Promise<void> {
    const handed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "project_open_item" item
         SET "assignee" = 'OWNER', "assignee_reason" = ${reason}, "assigned_at" = now(),
             "escalate_at" = NULL, "updated_at" = now()
       WHERE item."id" = ${itemId}::uuid AND item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR'
         AND item."assigned_at" = ${assignedAt.toISOString()}::timestamptz
         AND ${openItemOwed('item')}`);
    // Only on the edge this call made: the compare-and-set above is what decides whether this
    // process is the one that handed the item over, and a second announcement of the same
    // handover is a second banner about one waiting thing.
    if (handed > 0) void this.push?.notifyOwnerItem(itemId);
  }

  /** Every entry point here runs after somebody else's commit, so none of them may cost it. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** The columns an item's handling is read from (§4.7 H1, migration 0368). */
const HANDLING_SELECT = {
  handlingJobId: true,
  handlingSessionId: true,
  handlingUserId: true,
  handlingReason: true,
  handlingStartedAt: true,
} as const;

/**
 * The coordinator's rerun of an item, while it is in flight — or null: never handled, or the job it
 * queued has already ended (in which case the result has either closed the item already, or ended
 * without a verdict on it and left it open, unhandled, for the coordinator to decide again).
 */
function handlingOf(
  row: {
    handlingJobId: string | null;
    handlingSessionId: string | null;
    handlingUserId: string | null;
    handlingReason: string | null;
    handlingStartedAt: Date | null;
  },
  inFlight: ReadonlyMap<string, { kind: string; generation: number; state: string }>,
): OpenItemHandling<Date> | null {
  const job = row.handlingJobId ? inFlight.get(row.handlingJobId) : undefined;
  if (!job || !row.handlingJobId || !row.handlingStartedAt) return null;
  return {
    sessionId: row.handlingSessionId,
    userId: row.handlingUserId,
    reason: row.handlingReason ?? '',
    startedAt: row.handlingStartedAt,
    jobId: row.handlingJobId,
    jobKind: job.kind as OpenItemHandling['jobKind'],
    generation: job.generation,
    state: job.state as OpenItemHandling['state'],
  };
}

/** What a timeout retry says it reruns and why, written from the job's own facts (≤ 2000 characters). */
function timedOutRetryReason(job: ProjectIntegrationJob<Date>, now = Date.now()): string {
  const silent = Math.max(0, Math.floor((now - (job.heartbeatAt ?? job.startedAt).getTime()) / 60_000));
  const runner = job.runnerName ? `runner ${job.runnerName}` : 'its runner';
  return `Retried by the account owner after a timeout: no report from ${runner} for ${silent} minutes `
    + `(limit ${Math.round((job.limitSeconds ?? 0) / 60)}), last step ${job.phase ?? 'none'}.`;
}

/**
 * The reason a rerun carries (J-T1b, §4.7 H1), trimmed and bounded — or the 400 the door answers
 * without one. A rerun nobody explained is the silent retry the platform refuses to make (J5), so the
 * sentence is required, and it is what the rerun's job and every item it handles keep.
 */
function rerunReason(given: { reason?: string } | undefined): string {
  const reason = typeof given?.reason === 'string' ? given.reason.trim() : '';
  if (!reason) {
    throw new BadRequestException({
      code: INTEGRATION_RETRY_REASON_REQUIRED,
      message:
        'a reason is required: say why running this landing again will come out differently. A '
        + 'rerun nobody explained is the silent retry the platform refuses to make.',
    });
  }
  if (reason.length > MAX_INTEGRATION_RETRY_REASON) {
    throw new BadRequestException({
      code: INTEGRATION_RETRY_REASON_REQUIRED,
      message: `a reason is at most ${MAX_INTEGRATION_RETRY_REASON} characters`,
    });
  }
  return reason;
}

/** The reason `integration_observe` keeps (§10.8), trimmed and bounded — or its one 400. */
function observeReason(given: { reason?: unknown } | undefined): string {
  const reason = typeof given?.reason === 'string' ? given.reason.trim() : '';
  if (!reason) {
    throw new BadRequestException({
      code: INTEGRATION_OBSERVE_REASON_REQUIRED,
      message:
        'a reason is required: say why the work may be on the line now — what changed since Orbit '
        + 'last looked. It stays on the items the observation handles.',
    });
  }
  if (reason.length > MAX_INTEGRATION_OBSERVE_REASON) {
    throw new BadRequestException({
      code: INTEGRATION_OBSERVE_REASON_REQUIRED,
      message: `a reason is at most ${MAX_INTEGRATION_OBSERVE_REASON} characters`,
    });
  }
  return reason;
}

/** Only the conversation the project is coordinated from asks for its line to be looked at. */
function observeCoordinatorOnly(): ForbiddenException {
  return new ForbiddenException({
    code: INTEGRATION_OBSERVE_COORDINATOR_ONLY,
    message:
      'only the conversation this project is coordinated from may ask for its line to be looked at '
      + 'again; the account owner asks on their own door.',
  });
}

/** Only the conversation the project is coordinated from reruns any of its integrations. */
function rerunCoordinatorOnly(): ForbiddenException {
  return new ForbiddenException({
    code: INTEGRATION_RETRY_COORDINATOR_ONLY,
    message:
      'only the conversation this project is coordinated from may run one of its landings again. '
      + 'A task\'s own run does not decide what happens to its landing, and the account owner\'s say '
      + 'is the item about it.',
  });
}

function unique(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** A key for a caller that sent none: one question per call, which is what asking once means. */
/** An item as the refusals below read it: the columns its door cell is keyed by. */
interface RefusedItem {
  kind: string;
  taskId: string | null;
  promotionId: string | null;
  payload: unknown;
}

/** The doors this item's cell holds, by the names the coordinator's messages use
 *  (`openItemDoorMessageNames`): a refusal names nothing the cell does not have. */
function messageDoorsOf(item: RefusedItem) {
  const payload = (item.payload ?? {}) as { phase?: string; jobKind?: string; failureClass?: string };
  return openItemDoorMessageNames({
    kind: item.kind,
    assignee: 'COORDINATOR',
    taskId: item.taskId,
    promotionId: item.promotionId,
    payload: item.payload,
    phase: payload.phase ?? null,
    jobKind: payload.jobKind ?? null,
    failureClass: payload.failureClass ?? null,
  });
}

/**
 * Why `open_item_resolve` does not end this kind (§4.2, §4.7), and what does. A merge card and a
 * pause have a press of their own; revision 29's two end with a fact (§10.7) — the work landing, the
 * task moving on — or the owner's Accept.
 */
function ownDoorRefusal(item: RefusedItem): string {
  if (item.kind === LANDING_UNOBSERVED_KIND) {
    const doors = messageDoorsOf(item);
    const line = landingLineOf(item.payload) ?? 'its line';
    const ways = [
      doors.mergeReceiptMcp == null ? null
        : `record the commit on ${line} that carries the work with ${doors.mergeReceiptMcp}`,
      doors.taskReopenMcp == null ? null : `send the task back to push it with ${doors.taskReopenMcp}`,
      doors.handOverMcp == null ? null : `hand the item to the account owner with ${doors.handOverMcp}`,
    ].filter((way): way is string => way != null);
    return `this item is not closed by hand: it ends when its task's work is on ${line}, or when the task `
      + 'is sent back, replaced, cancelled or declared codeless. Marking it handled would leave the tasks '
      + `waiting on that work with nobody in front of the wait.${ways.length > 0 ? ` To move it: ${ways.join('; ')}.` : ''}`;
  }
  if (item.kind === LANDED_WITHOUT_CONFIRMATION_KIND) {
    return 'this item is decided by the account owner\'s Accept on its card. Closing it here would leave '
      + 'the work that reached the branch without their confirmation with no decision recorded.';
  }
  return 'this item is decided by a press of its own: confirm or decline the merge on its card, or '
    + 'resume the project. Closing it here would leave what it is about undecided and with no '
    + 'card in front of anybody.';
}

/**
 * O-X1's condition (§10.7), from committed rows: the task this item's landing is about — its own,
 * or the one a `TASK_BRANCH` candidate offers — is still NOT_KNOWN (§1.4, `taskLandingSql`), and a
 * task that has not ended (neither DONE nor CANCELLED, nor replaced) depends on it. Either half gone
 * — the work landed, or nothing waits on it any more — and the item closes by hand as before.
 *
 * The item a project's failing observations open (`IE:observe`, §10.6 O-J4) is about no one task: it
 * is in front of somebody for every task of the project waiting to be observed, so its condition is
 * that any of them still waits (`landingPendingObservationSql`) — until each has landed, been
 * cancelled or replaced, or stopped being code work.
 */
async function landingConditionStands(
  prisma: PrismaService,
  projectId: string,
  item: RefusedItem,
): Promise<boolean> {
  if (baselineFields(item.payload).baseline) return false;
  if (observationFailureItem(item)) return hasPendingObservation(prisma, projectId);
  const [row] = await prisma.$queryRaw<Array<{ stands: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "task" waited_on
       WHERE waited_on."id" = COALESCE(
               ${item.taskId}::uuid,
               (SELECT candidate."task_id" FROM "project_promotion" candidate
                 WHERE candidate."id" = ${item.promotionId}::uuid
                   AND candidate."source_kind" = 'TASK_BRANCH'))
         AND (${Prisma.raw(taskLandingSql('waited_on'))}) = 'NOT_KNOWN'
         AND EXISTS (
           SELECT 1 FROM "task_dependency" waiting_edge
             JOIN "task" waiting ON waiting."id" = waiting_edge."task_id"
            WHERE waiting_edge."depends_on_task_id" = waited_on."id"
              AND waiting."status" NOT IN ('DONE', 'CANCELLED')
              AND waiting."superseded_by_task_id" IS NULL)
    ) AS "stands"`);
  return row?.stands === true;
}

/** Whether this is the item a project's failing observations open (§10.6 O-J4): the cell whose
 *  source job is OBSERVE_LANDING. */
function observationFailureItem(item: RefusedItem): boolean {
  return sourceJobForOpenItem({ ...item, assignee: 'COORDINATOR' }) === 'OBSERVE_LANDING';
}

/** O-X1's refusal: the wait still stands, and the doors of this item's cell that answer it — of
 *  `integration_retry`, `integration_observe`, `merge_receipt`, `task_reopen` and
 *  `open_item_hand_over`, only the ones the cell really has (§4.7 T17). */
function conditionStandsRefusal(item: RefusedItem): string {
  const doors = messageDoorsOf(item);
  const named = [doors.retryMcp, doors.observeMcp, doors.mergeReceiptMcp, doors.taskReopenMcp, doors.handOverMcp]
    .filter((name): name is string => name != null);
  if (observationFailureItem(item)) {
    return 'this item stands for the tasks of this project still waiting to be observed: until an observation '
      + 'of the line succeeds, their work is not recorded as landed, and this item is what puts that wait in '
      + 'front of somebody. Marking it handled would leave the wait with nobody in front of it.'
      + (named.length > 0 ? ` Move it with one of this item's doors: ${named.join(', ')}.` : '')
      + ' Once no task of the project waits to be observed any more, it closes by hand as before.';
  }
  return 'this item is about a task\'s landing, and the wait it is about still stands: the work is not on '
    + 'the line yet, and a task that depends on it is still waiting. Marking it handled would leave that '
    + 'wait with nobody in front of it.'
    + (named.length > 0 ? ` Move it with one of this item's doors: ${named.join(', ')}.` : '')
    + ' Once the work lands, or nothing waits on it any more, it closes by hand as before.';
}

/** A coordinator question's item title: Orbit's English prefix, then the agent's question. */
function coordinatorQuestionTitle(question: string): string {
  return `Coordinator asks: ${question}`;
}

function randomKey(): string {
  return randomUUID();
}

/**
 * A question's translation as the open-items read serves it: with `detailLine`, the question's detail line
 * built from the translated `ifUnanswered`, and `title`, the row's title built from the translated `question`,
 * when the translation is whole and in the owner's current language. "Blocks N tasks · If you don't answer:"
 * and "Coordinator asks: " stay Orbit's own English; only the agent's words are swapped in.
 */
function withTranslatedDetailLine(
  question: CoordinatorQuestion | null,
  translation: OwnerCardTranslation,
  langs: TranslationLanguages | null,
): OwnerCardTranslation {
  if (!question || translation.failed || !langs || !translatedInto(translation, langs)) return translation;
  return {
    ...translation,
    detailLine: questionDetailLine({ ...question, ifUnanswered: translation.ifUnanswered ?? question.ifUnanswered }),
    title: coordinatorQuestionTitle(translation.question ?? question.question),
  };
}

/** The line under an item's title, in the words of the fact (English: this is UI copy). */
function detailLine(kind: string, payload: unknown): string {
  // A pause writes its own, because what it has to say is not "something failed" but what the
  // coordinator spent, what is still running without it, and what resuming does and does not do.
  if (kind === 'FUSE_PAUSED') return fusePausedDetailLine(payload as FusePausedPayload);
  if (kind === LANDING_LEASE_EXPIRED_KIND) return leaseExpiredDetailLine(payload);
  if (kind === DELIVERY_REVIEW_KIND) return deliveryReviewDetailLine(payload);
  if (kind === LANDING_UNOBSERVED_KIND) return landingUnobservedDetailLine(payload);
  if (kind === LANDED_WITHOUT_CONFIRMATION_KIND) return landedWithoutConfirmationDetailLine(payload);
  if (kind === EVIDENCE_UNDECIDED_KIND) return evidenceUndecidedDetailLine(payload);
  // §10.5 O-L8: what the error code alone would have a reader conclude about the task is not so.
  const outdatedRunner = outdatedRunnerOf(payload);
  if (kind === 'INTEGRATION_ERROR' && outdatedRunner) {
    return `Runner ${outdatedRunner} is out of date: update it, then run this check again.`;
  }
  if (kind !== 'TASK_FAILED') return '';
  const failure = (payload ?? {}) as {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    chain?: { failuresInChain?: number; limit?: number };
  };
  const attempt = failure.chain?.failuresInChain ?? 1;
  const limit = failure.chain?.limit ?? TASK_FAILURE_CHAIN_LIMIT;
  const exit = failure.exitCode !== undefined
    ? ` · exit ${failure.exitCode}, expected ${failure.expectedExitCode ?? 0}`
    : '';
  return `${howInEnglish(failure.how)}${exit} · attempt ${attempt} of ${limit} in this chain`;
}

/** The line under a `LANDING_UNOBSERVED`'s title: what was seen, and the commit it is about. */
function landingUnobservedDetailLine(payload: unknown): string {
  const row = (payload ?? {}) as { reason?: unknown; deliveredSha?: unknown };
  const reading = row.reason === 'APPLIED_AS_OTHER_COMMITS' ? 'Its changes are there as other commits'
    : row.reason === 'WORK_ELSEWHERE' ? 'Its branch has no commits of its own'
      : row.reason === 'IDENTITY_UNKNOWN' ? 'Orbit could not tell which commit it delivered'
        : 'Its commit was not found on the line';
  const delivered = typeof row.deliveredSha === 'string' && row.deliveredSha
    ? ` · delivered ${row.deliveredSha.slice(0, 12)}`
    : '';
  return `${reading}${delivered}`;
}

/** The line under a `LANDED_WITHOUT_CONFIRMATION`'s title: the commit that reached the branch, and
 *  how Orbit knows. */
function landedWithoutConfirmationDetailLine(payload: unknown): string {
  const row = (payload ?? {}) as {
    sourceSha?: unknown; targetBranch?: unknown; observed?: unknown; receipts?: unknown;
  };
  // The deploy-time pass's one item per project (§10.9): the tasks it saw there, by title.
  if (Array.isArray(row.receipts)) {
    const titles = row.receipts
      .map((receipt) => (receipt as { title?: unknown } | null)?.title)
      .filter((title): title is string => typeof title === 'string' && title !== '');
    const branch = typeof row.targetBranch === 'string' && row.targetBranch ? row.targetBranch : 'the branch';
    const named = titles.slice(0, 3).join(', ');
    const more = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
    return `On ${branch}: ${named || 'its tasks\' work'}${more} · seen by Orbit`;
  }
  const sha = typeof row.sourceSha === 'string' && row.sourceSha ? row.sourceSha.slice(0, 12) : 'its commit';
  const branch = typeof row.targetBranch === 'string' && row.targetBranch ? row.targetBranch : 'the branch';
  return `${sha} is on ${branch} · ${row.observed === true ? 'seen by Orbit' : 'recorded by a merge receipt'}`;
}

/** The line under X-E5's title: which runner went quiet, and when it last said anything. */
function leaseExpiredDetailLine(payload: unknown): string {
  const row = (payload ?? {}) as { lastReportAt?: unknown; runner?: unknown };
  const runner = typeof row.runner === 'string' && row.runner ? `runner ${row.runner}` : 'the runner';
  const last = typeof row.lastReportAt === 'string' ? new Date(row.lastReportAt) : null;
  if (!last || Number.isNaN(last.getTime())) {
    return `No report from ${runner}, and the attempt is still running.`;
  }
  return `No report from ${runner} since ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

function howInEnglish(how: string | undefined): string {
  switch (how) {
    case 'ACCEPTANCE_EXIT_MISMATCH':
      return 'The acceptance command disagreed with what the task declared';
    case 'RUN_FAILED':
      return 'A turn of the run failed';
    case 'RUNNER_FINALIZED_FAILED':
      return 'The runner finished the run as failed';
    case 'REAPED_API_ERROR':
      return 'The run stopped on an API or sign-in error and was reaped';
    case 'ATTEMPT_LOST_RUNNER_OFFLINE':
      return 'Its runner went offline and the attempt was taken back';
    case 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED':
      return 'Its runtime never started and the attempt was taken back';
    case 'REPORTED_FAILED':
      return 'Somebody filed it as failed';
    default:
      return 'The task failed';
  }
}

/** K4 / §4.8. These mutable fields never enter openItemMessage (G6). */
function baselineFields(payload: unknown): {
  baseline: NonNullable<ProjectOpenItemRow['baseline']> | null;
  heldTaskIds: string[];
} {
  const value = payload as Pick<ProjectOpenItemRow, 'baseline' | 'heldTaskIds'> | null;
  return { baseline: value?.baseline ?? null, heldTaskIds: value?.heldTaskIds ?? [] };
}
