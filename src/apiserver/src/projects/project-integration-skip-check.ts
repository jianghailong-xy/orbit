import {
  IntegrationRetryDecision,
  IntegrationRetryFacts,
  decideIntegrationRetry,
} from './project-integration-retry';
import { landingFailureClass } from './project-integration-job';

/**
 * `integration_skip_merge_check`: a project's coordinator queues ONE landing again with the merge
 * check NOT RUN — `integration_retry` plus the one semantic that the check is skipped rather than
 * run — and only with the account owner's yes on a confirmation card
 * (`docs/project-integration-line-contract.md` §2.4 J-S5).
 *
 * WHY THIS DOOR EXISTS. A red merge check can be about the check and not about the delivery: on
 * 2026-10-07 the check of project 34bZ3i4AvgJaaoaw5E9tH failed on this very machine because the
 * runner's shell has no GNU timeout and bash 3.2 has no `mapfile`, so the check command itself
 * cannot pass here whatever the work does. The three doors that existed were all wrong for it:
 * `task_reopen` sends back work that is not at fault, `integration_retry` runs the same command
 * against the same machine and is red again by construction, and handing the item to the owner asks
 * them to decide the landing rather than the check — and the check COMMAND is the owner's to change
 * (§8.2), which is exactly the decision a skip is asking for.
 *
 * WHAT IT IS NOT. It is not a way to pass a check: the check does not run, and every record of that
 * landing says so — the job row carries `skippedMergeCheck` with the reason and the person who
 * approved it, and any exception item the landing goes on to open carries the same. It is not a
 * setting: only the one generation queued here skips anything, the project's `mergeCheckCommand` is
 * untouched, and the next landing and every promotion check run as they always did. And it is not
 * the coordinator's alone: the card is the account owner's, and without an answered card the door
 * refuses and queues nothing.
 *
 * This module is the part with no I/O: the codes, and the one decision over facts the caller read
 * under the task row lock. `ProjectOpenItemService.skipIntegrationMergeCheck` reads them and does
 * the writes.
 */

/** The card every skip is approved on. The runner files it under this name
 *  (`src/runner-go/mcp.go`'s own constant), and a card filed under any other name does not open
 *  this door — the two spellings are one string, checked here. */
export const INTEGRATION_SKIP_CHECK_TOOL_NAME = 'orbit_integration_skip_merge_check';

/** The acting session is not the conversation this project is coordinated from. 403, as for a rerun. */
export { INTEGRATION_RETRY_COORDINATOR_ONLY as INTEGRATION_SKIP_CHECK_COORDINATOR_ONLY } from './project-integration-retry';

/** The task is not filed under the project the call names. 403, as for a rerun. */
export const INTEGRATION_SKIP_CHECK_NOT_THIS_PROJECT = 'INTEGRATION_SKIP_CHECK_NOT_THIS_PROJECT';
/** The landing did not stop on a check, so there is no check to skip. 409. */
export const INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE = 'INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE';
/** Nobody answered the card: no approval, one still pending, or one the owner declined. 403. */
export const INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED = 'INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED';
/** The card the owner answered is about another landing than the one this call names. 403. */
export const INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED = 'INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED';

/** The longest reason a skip carries — the same bound the rerun's reason has, which it is written
 *  beside on the same row and on the same item. */
export const MAX_INTEGRATION_SKIP_REASON = 2_000;

/**
 * The confirmation card this skip was approved on, as the service read it: the row the runner filed
 * through `askBeforeCreate`, looked up by the id the runner handed back.
 *
 * It is read rather than believed. A caller that named no card, or a card that is still PENDING, or
 * one the owner declined with a reason, or one raised by another conversation or about another
 * landing, is refused below — so what the record ends up holding is an approval somebody really
 * gave, and not a sentence an agent put in a body.
 */
export interface SkipCheckApprovalFacts {
  id: string;
  /** What the card was filed under; only `INTEGRATION_SKIP_CHECK_TOOL_NAME` opens this door. */
  toolName: string;
  /** `approval.status`: ALLOWED, PENDING, DENIED or ABANDONED. */
  status: string;
  /** The conversation the card was filed for — the authority here, as it is for every ask. */
  sessionId: string;
  /** The card's own input, as the runner wrote it: which project and which task it asked about. */
  input: { projectId?: unknown; taskId?: unknown } | null;
  /** The person who answered it, when the row names one. */
  decidedById: string | null;
}

/** What the decision is taken over: a rerun's facts, plus the landing it is about and its card. */
export interface IntegrationSkipCheckFacts extends IntegrationRetryFacts {
  /** Which landing this is about — what the card has to have asked about, and what a refusal names. */
  projectId: string;
  taskId: string;
  /** The conversation pressing the door; null on the account owner's own channel. */
  actingSessionId?: string | null;
  /** The card, or null when the caller named none. Required on the coordinator channel. */
  approval?: SkipCheckApprovalFacts | null;
}

/** A skip is a rerun, decided by the same rules and carrying the same answer. */
export type IntegrationSkipCheckDecision = IntegrationRetryDecision;

/** The refusal member of the decision union: what a caller can read the status and the body off. */
export type IntegrationSkipCheckRefusal = Extract<IntegrationSkipCheckDecision, { ok: false }>;

function refuse(
  status: 403 | 409,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): IntegrationSkipCheckRefusal {
  return { ok: false, status, body: { code, message, ...detail } };
}

/**
 * Whether the coordinator may queue this landing again with its merge check not run, and what the
 * generation it queues skips.
 *
 * The order is the order a reader needs the answer in, and every question but the first is
 * `integration_retry`'s own — asked through the same function, so the two doors refuse a task that
 * is not DONE, a landing already in flight, a failure whose item is the account owner's, a project
 * that is not Automatic and a conversation that does not coordinate this project in one wording that
 * cannot drift between them.
 *
 * THE FIRST QUESTION IS THE ONE THIS DOOR ADDS. A skip answers a CHECK — a command that ran on the
 * combined tree and whose result nobody accepts (CHECK_FAILED, including the check the runner killed
 * at its budget: CHECK_TIMED_OUT). A landing that stopped anywhere else is refused here and pointed
 * at the door that does answer it: a CONFLICT is the branch's and only a branch that changed answers
 * it, an ERROR is the machinery's and running the same landing again may well come out differently
 * (`integration_retry`, which this module does not replace), and a landing that already landed has
 * nothing left to do.
 *
 * THE LAST QUESTION IS THE OWNER'S. On the coordinator channel the card is required, and it is read
 * for five things: it exists, it is ALLOWED, a PERSON answered it (a standing rule's auto-allow has
 * no decider on the row and is refused — this question is asked afresh each time and no rule answers
 * it), it was raised by the conversation that is asking, and it asked about THIS project and THIS
 * task. Anything else is refused and nothing is queued — the door is not a way for a coordinator to
 * skip a check by saying so. The account owner's own channel is the other way round and needs no
 * card: they are the person the card would ask, so their press IS the approval, and the row records
 * them as the one who gave it.
 */
export function decideIntegrationSkipCheck(facts: IntegrationSkipCheckFacts): IntegrationSkipCheckDecision {
  const newest = facts.newestLanding;
  const landing = newest && newest.state !== 'QUEUED' && newest.state !== 'RUNNING'
    ? landingFailureClass(newest)
    : null;
  if (landing === 'ERROR') {
    return refuse(409, INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE,
      'this task\'s newest landing ended in ERROR: the integration machinery stopped rather than a '
      + 'check disagreeing, so there is no check to skip — the checks never got a result to be '
      + 'accepted or not. Run the landing again (integration_retry) and say what changed; a failure '
      + 'of the machinery is one the same landing may well not meet twice.',
      { newestLanding: { jobId: newest!.id, generation: newest!.generation, state: newest!.state } });
  }

  const decision = decideIntegrationRetry(facts);
  if (!decision.ok) return decision;

  const requester = facts.requester ?? 'COORDINATOR';
  if (requester === 'OWNER') return decision;
  const refusal = cardRefusal(facts);
  if (refusal) return refusal;
  return decision;
}

/**
 * Whether a string is the shape of a card id this deployment issues.
 *
 * Read before the row is looked up, not instead of looking it up: an approval id is a uuid, and one
 * that is not would reach a `uuid` column and come back as a 500 from the database rather than as
 * the refusal it is. A caller that wrote a word here made a mistake worth naming, not an incident.
 */
export function isApprovalId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** The refusal for a card id that is not one: nothing is looked up, nothing is queued. */
export function notAnApprovalId(approvalId: string): IntegrationSkipCheckRefusal {
  return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED,
    `"${approvalId}" is not the id of a confirmation card: the id is the one the tool that raised `
    + 'the card returned once the account owner had answered it. Nothing was looked up and nothing '
    + 'was queued.',
    { approvalId });
}

/** Why the card this call named does not open the door, or null when it does. */
function cardRefusal(facts: IntegrationSkipCheckFacts): IntegrationSkipCheckDecision | null {
  const approval = facts.approval ?? null;
  if (!approval) {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED,
      'skipping a merge check needs the account owner\'s yes on a confirmation card, and no card '
      + 'was named. Ask for one first — the tool that raises it returns the card\'s id once they have '
      + 'answered — and call again with it. Nothing is queued until they have.',
      { approvalId: null });
  }
  if (approval.toolName !== INTEGRATION_SKIP_CHECK_TOOL_NAME) {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED,
      `the card named was filed as ${approval.toolName}, not ${INTEGRATION_SKIP_CHECK_TOOL_NAME}: it `
      + 'is an answer to some other question, and this door is opened by the skip card alone.',
      { approvalId: approval.id, toolName: approval.toolName });
  }
  if (approval.status !== 'ALLOWED') {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED,
      approval.status === 'PENDING'
        ? 'the card is still waiting for the account owner: nothing is skipped until they answer it.'
        : `the account owner answered this card ${approval.status.toLowerCase()}, and no is an answer: `
          + 'the landing stands as it failed, with its checks unrun-and-failed as they are.',
      { approvalId: approval.id, status: approval.status });
  }
  // A card ALLOWED with no decider was answered by a rule, not by a person: a workspace's standing
  // grant, or the start card reviewing a create (`runner-api.controller.ts#createApproval`). Those
  // are answers to questions of a different shape — "this workspace may always do that kind of
  // thing" — and this question is asked afresh every time: whether THIS landing may go on with the
  // check the account owner is looking at. So the name on the row is required, and an auto-answer
  // is not one.
  if (approval.decidedById === null) {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED,
      'the card was allowed by a standing rule rather than answered by the account owner, and a skip '
      + 'is their own decision each time: no rule about this tool may stand in for it. Ask them, and '
      + 'call again with the card they answer themselves.',
      { approvalId: approval.id, decidedById: null });
  }
  if (facts.actingSessionId && approval.sessionId !== facts.actingSessionId) {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED,
      'the card named was filed for another conversation, and a card is the asking conversation\'s: '
      + 'raise your own and answer it with the account owner.',
      { approvalId: approval.id, approvalSessionId: approval.sessionId });
  }
  const input = approval.input ?? {};
  if (input.projectId !== facts.projectId || input.taskId !== facts.taskId) {
    return refuse(403, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED,
      'the card named was raised about another project or another task, so what the account owner '
      + 'approved is not this landing. Raise the card for the landing you mean to skip.',
      { approvalId: approval.id, projectId: facts.projectId, taskId: facts.taskId });
  }
  return null;
}
