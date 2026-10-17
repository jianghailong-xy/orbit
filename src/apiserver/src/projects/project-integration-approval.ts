import { toUuid } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { canonicalJson } from './canonical-json';

/**
 * The ONE card a session may change a project's merge check through, and what it has to say.
 *
 * An integration object carries two kinds of decision, and they are not the same decision:
 *
 *   - WHERE the work lands — `line`, `projectBranchName`, `upstreamRef`. Owner-only, card or no
 *     card: contract L5 gives the choice of a project's line to the account owner, and a
 *     confirmation card would be a way for an agent to talk them into it field by field.
 *   - WHAT is checked before it lands — `mergeCheckCommand`, `mergeCheckTimeoutSeconds`. This is
 *     the one an agent has a real reason to propose: it is the check that keeps failing on a tree
 *     the agent just built, and the session holding the failure is the one that knows what the
 *     command should be.
 *
 * So this half is card-gated rather than forbidden. The runner files a card
 * (`orbit_project_update_integration`, `runner-go/project_integration_approval.go`) naming the
 * project, what the check is now and what it would become; the account owner answers it; and the
 * write that follows carries the approval's id. {@link findMergeCheckApproval} is the server's half
 * — the check that the card exists, that a person answered it, and that what it authorised is
 * EXACTLY what is about to be written.
 *
 * WHY THE MATCH IS ON THE PROPOSAL AND NOT ON THE CARD'S EXISTENCE
 * ----------------------------------------------------------------
 * "This session has an approved card" is not the question. Two ways of getting that wrong are worth
 * naming, because both are ordinary rather than exotic:
 *
 *   - A card approved for ONE change is not a standing permission to change the field again. The
 *     comparison is over {@link mergeCheckProposalKey}, so a card that authorised "make the check
 *     `npm test`" authorises neither a later `npm run e2e` nor a later clearing of it. Re-sending
 *     the SAME value is allowed, because that is a retry of the write the owner already read.
 *   - A card approved for one PROJECT or one SESSION is not a yes to another. `projectId` is in the
 *     key, and the row is looked up by `sessionId`, so a card filed elsewhere is not found.
 *
 * The values are compared canonically ({@link canonicalJson}), so key order and a client that spells
 * the object differently are not a mismatch — but absent and null are, because "leave the timeout
 * alone" and "put the timeout back to its default" are two different writes. The id of the project
 * is resolved to its uuid before it is compared, for the reason {@link projectIdAsUuid} gives: the
 * two ends are handed it in different spellings, and which project a card is about is the question
 * rather than how the caller wrote it down.
 */

/** The tool name the runner files this card under; the server matches on it, so the two ends agree. */
export const PROJECT_INTEGRATION_APPROVAL_TOOL_NAME = 'orbit_project_update_integration';

/** The merge-check fields, in the spelling the DTO and the card both use. */
const MERGE_CHECK_FIELDS = ['mergeCheckCommand', 'mergeCheckTimeoutSeconds'] as const;

/** Where a project's work lands. No card authorises these; see the header. */
const INTEGRATION_LINE_FIELDS = ['line', 'projectBranchName', 'upstreamRef'] as const;

const MERGE_CHECK_FIELD_SET: ReadonlySet<string> = new Set(MERGE_CHECK_FIELDS);
const INTEGRATION_LINE_FIELD_SET: ReadonlySet<string> = new Set(INTEGRATION_LINE_FIELDS);

/** The keys an integration object actually NAMES, sorted so two spellings read the same. */
export function namedIntegrationFields(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).filter((key) => settings[key] !== undefined).sort();
}

export function isIntegrationLineField(key: string): boolean {
  return INTEGRATION_LINE_FIELD_SET.has(key);
}

export function isMergeCheckField(key: string): boolean {
  return MERGE_CHECK_FIELD_SET.has(key);
}

/**
 * The merge-check change a request (or a card) proposes: exactly the fields it names, so an absent
 * timeout stays absent rather than becoming a proposed null.
 */
export function mergeCheckProposal(settings: Record<string, unknown>): Record<string, unknown> {
  const proposal: Record<string, unknown> = {};
  for (const field of MERGE_CHECK_FIELDS) {
    if (settings[field] !== undefined) proposal[field] = settings[field];
  }
  return proposal;
}

/**
 * The project a card names — resolved to the uuid that names it — however the caller spelled it.
 *
 * WHICH SPELLING AN ID ARRIVES IN IS NOT PART OF WHAT A CARD AUTHORISED, and the two ends of this
 * comparison receive it in different ones. The CARD carries the id the CALLER wrote: the runner
 * files it with the string the agent passed to `project_update`, and the tool's own description
 * tells the agent that is "the project to update, as shown in its web UI URL (/projects/<id>)" —
 * the base62 public id (`34bZ3i4AvgJaaoaw5E9tH`). The REQUEST carries the uuid that route resolved
 * that id to, because `PublicIdPipe` decodes every id a caller supplies before the service sees it.
 * Comparing the two literally made a card the runner files match nothing at all: the owner answered
 * the question, and the write it was raised for was still refused. Both spellings name the same
 * project, so both resolve here and the comparison lands on WHICH project, not on how it is written.
 *
 * An id that resolves to neither spelling is kept as written. That is fail-closed rather than
 * lenient: the request side of the comparison is always a resolved uuid by the time it is compared,
 * so a card naming something undecodable covers nothing.
 */
function projectIdAsUuid(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return toUuid(value);
  } catch {
    return value;
  }
}

/**
 * What a card authorises, as one comparable string: the project named BESIDE the change, and
 * exactly that change. Canonically serialized, so the comparison cannot turn on key order — and
 * with the project resolved to its uuid, so it cannot turn on the spelling of the id either.
 *
 * The project is read out of the same object as the values, rather than passed in from the caller's
 * side of the comparison, and that is deliberate: a version that took the project as an argument
 * let a card filed about one project authorise a write to another whose merge check had the same
 * value, because the request's id was used for both sides. One object, one tuple.
 */
export function mergeCheckProposalKey(settings: unknown): string {
  const named = (settings ?? {}) as Record<string, unknown>;
  return canonicalJson({ projectId: projectIdAsUuid(named.projectId), ...mergeCheckProposal(named) });
}

/** The same key for a request, whose project id is in the URL rather than in the object. */
export function mergeCheckRequestKey(projectId: string, settings: unknown): string {
  return mergeCheckProposalKey({ ...((settings ?? {}) as Record<string, unknown>), projectId });
}

/** The card that let the write through: which one it was, and who answered it. */
export interface MergeCheckApproval {
  approvalId: string;
  /**
   * The account owner whose click allowed it. Never null: an auto-allowed card (a workspace's
   * standing rule, `runner-api.controller.ts`) is answered by the server rather than by a person,
   * and "the owner clicked it" is the whole of what this gate is.
   */
  decidedById: string;
}

/**
 * The card that authorises this exact change, or null when there is none.
 *
 * ALLOWED and answered by a person and filed for THIS session: a PENDING card is a question nobody
 * has answered, a DENIED one is an answer that says no, and an auto-allowed one was never put in
 * front of anybody. Then the proposal itself has to reproduce — see the header for why.
 *
 * The card is not consumed. Re-sending the change the owner already read is a retry (a lost
 * response, an engine that restarted), and the alternative — one write per approval — would turn
 * "the request went through but the answer was lost" into a change that can never be made without
 * interrupting the owner a second time with the question they just answered.
 */
export async function findMergeCheckApproval(
  prisma: Pick<PrismaService, 'approval'>,
  input: { projectId: string; sessionId: string; settings: Record<string, unknown> },
): Promise<MergeCheckApproval | null> {
  const wanted = mergeCheckRequestKey(input.projectId, input.settings);
  const cards = await prisma.approval.findMany({
    where: {
      sessionId: input.sessionId,
      toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
      status: 'ALLOWED',
      decidedById: { not: null },
    },
    select: { id: true, input: true, decidedById: true },
    // Newest first, so the row recorded as the provenance is the card the owner answered last —
    // and so the answer does not depend on the order the database happens to return rows in.
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
  });
  const covering = cards.find((card) => mergeCheckProposalKey(card.input) === wanted);
  if (!covering?.decidedById) return null;
  return { approvalId: covering.id, decidedById: covering.decidedById };
}

/**
 * What the write records about the card that let it through: who answered it, whose session asked,
 * and the change it authorised. It goes on the `activity` ledger — the same place a task's creation
 * and a project's refiling record how they came to be — rather than in a table of its own, and in
 * the SAME transaction as the write it is about, so a rolled-back write leaves no provenance
 * claiming it happened.
 *
 * The approval id is the load-bearing field: the card carries what the check was, what it becomes,
 * and who was asked, so the row does not have to repeat any of it to be auditable.
 */
export function mergeCheckAuditPayload(input: {
  projectId: string;
  sessionId: string;
  approval: MergeCheckApproval;
  settings: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    approvalId: input.approval.approvalId,
    approvedByUserId: input.approval.decidedById,
    requestedBySessionId: input.sessionId,
    ...mergeCheckProposal(input.settings),
  };
}

/** The `activity.type` the merge-check write is recorded under. */
export const MERGE_CHECK_AUDIT_TYPE = 'project.merge_check.changed';
