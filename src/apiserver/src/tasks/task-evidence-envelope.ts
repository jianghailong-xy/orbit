import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid } from '@orbit/shared';

/**
 * The four-field envelope `task_evidence_submit` writes, and the three layers that check it.
 *
 * Before this, `evidence` was any JSON object at all. That made every submission accepted and
 * none of them checkable: no card could render a stable field, and a reader had nothing to hold
 * on to but prose the submitter wrote about their own work.
 *
 * The envelope is deliberately four fields and no fifth. What is checked is only what can be
 * reconciled against rows the system ALREADY has:
 *
 *  1. **Shape** — the four fields are present and are of the stated types. Nothing more; this
 *     layer never reads the database and never judges content.
 *  2. **Resolution** — every citation is looked up under this owner and this task, and at least
 *     one has to come back. This is the load-bearing layer: a claim with no handle is a report,
 *     not evidence. A citation that resolves to a row of this owner's under ANOTHER task is
 *     refused outright rather than reported unresolved — borrowing another task's work is a
 *     boundary violation, not weak evidence.
 *  3. **Consistency** — a declared command must equal the cited `tool_call.input.command`
 *     byte for byte, and declaring success over a `tool_call` that recorded `isError` is refused.
 *
 * What this deliberately does NOT check is exit codes: `tool_call` has no exit-code column, only
 * `isError`, and the code itself sits unparsed inside `output` text. Work whose answer really is
 * an exit code belongs to EXECUTABLE acceptance, which runs the command itself.
 *
 * `output` is likewise not part of the envelope: it participates in the evidence digest, where
 * whitespace and array order are significant (`normalizeCompletionEvidence`), so copying it in
 * would roll the revision for reformatting alone — and Orbit already stores it on the cited row.
 */

/** Every kind here has a resolver below. Adding a member without one is how an enum grows a
 * member that is declared and never implemented, which is the disease this envelope exists to
 * treat — so the resolver comes first and the member second. */
export const EVIDENCE_CHECK_KINDS = ['TOOL_CALL', 'COMMIT', 'ARTIFACT'] as const;
export type EvidenceCheckKind = (typeof EVIDENCE_CHECK_KINDS)[number];

export interface EvidenceCheck {
  kind: EvidenceCheckKind;
  ref: string;
  /** TOOL_CALL only: what the submitter says the cited call ran. Checked byte for byte. */
  command?: string;
  /** TOOL_CALL only: what the submitter says it did. `true` over an `isError` row is refused. */
  succeeded?: boolean;
}

export interface EvidenceEnvelope {
  claim: string;
  /**
   * The stated standard this evidence is measured against, quoted by key AND by text.
   *
   * `key` says WHICH standard and `text` says what it said, and only the text is ever checked
   * (`evidenceCriterionMatch`). For a task filed under a project the key is one of the keys
   * `project_get` prints beside that project's criteria. For a task in NO project there is nothing
   * to select — such a task has exactly one standard, its own `acceptanceCriteria` — so the
   * convention is the task's own public id, which is what submitters already write, and no key
   * resolves to anything either way. The field is required in both cases because the envelope has
   * no optional halves; what changes is only whether anything looks the key up.
   */
  criterion: { key: string; text: string };
  checks: EvidenceCheck[];
  gaps: string[];
}

export interface EvidenceCitation {
  kind: EvidenceCheckKind;
  ref: string;
  resolved: boolean;
  /** Why an unresolved citation did not resolve; null once it did. */
  reason: string | null;
}

export interface EvidenceCriterionMatch {
  key: string;
  text: string;
  /** Whether the quoted text is still what the standard this task is held to says today. */
  matchesLive: boolean;
}

/** What the criterion lane reads off the task: where this task's stated standard lives. A task in
 * a project quotes one of the project's criteria; a task in no project has its own
 * `acceptanceCriteria` and nothing else. Passed in rather than read here because both callers hold
 * the row already, under the Task mutex in the two that write. */
export interface CriterionStandingTask {
  projectId: string | null;
  acceptanceCriteria: string | null;
}

const MAX_CLAIM = 2_000;
const MAX_CRITERION_KEY = 200;
const MAX_CRITERION_TEXT = 4_000;
const MAX_CHECKS = 50;
const MAX_REF = 500;
const MAX_COMMAND = 4_000;
const MAX_GAPS = 50;
const MAX_GAP = 1_000;

const ENVELOPE_FIELDS = ['claim', 'checks', 'criterion', 'gaps'];
const CRITERION_FIELDS = ['key', 'text'];
const CHECK_FIELDS = ['command', 'kind', 'ref', 'succeeded'];

function refuseShape(why: string): never {
  throw new BadRequestException({
    code: 'EVIDENCE_ENVELOPE_INVALID',
    message: `evidence must be the completion-evidence envelope: ${why}`,
    requiredAction: 'SUBMIT_THE_FOUR_FIELD_ENVELOPE',
  });
}

function refuseCitation(code: string, message: string, requiredAction: string): never {
  throw new BadRequestException({ code, message, requiredAction });
}

function requireText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') refuseShape(`${path} must be a string`);
  const text = value as string;
  if (text.trim() === '') refuseShape(`${path} must not be blank`);
  if (text.length > max) refuseShape(`${path} must be at most ${max} characters`);
  return text;
}

function requireExactFields(value: unknown, path: string, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuseShape(`${path} must be a JSON object`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const missing = fields.filter((field) => !keys.includes(field));
  if (missing.length > 0) refuseShape(`${path} is missing ${missing.join(', ')}`);
  return object;
}

function requireNoUnknownFields(
  object: Record<string, unknown>,
  path: string,
  fields: string[],
): void {
  const unknown = Object.keys(object).filter((key) => !fields.includes(key)).sort();
  if (unknown.length > 0) {
    refuseShape(`${path} carries ${unknown.join(', ')}, and the envelope has no field for that`);
  }
}

/**
 * Layer 1. Types and presence only — it reads no row and decides nothing about the content.
 *
 * Run it against the NORMALIZED evidence, which is what actually gets stored and digested, so the
 * command layer 3 compares is the same text a later reader will find in the ledger.
 */
export function parseEvidenceEnvelope(evidence: unknown): EvidenceEnvelope {
  const root = requireExactFields(evidence, 'evidence', ENVELOPE_FIELDS);
  requireNoUnknownFields(root, 'evidence', ENVELOPE_FIELDS);

  const claim = requireText(root.claim, 'evidence.claim', MAX_CLAIM);

  const criterionObject = requireExactFields(root.criterion, 'evidence.criterion', CRITERION_FIELDS);
  requireNoUnknownFields(criterionObject, 'evidence.criterion', CRITERION_FIELDS);
  const criterion = {
    key: requireText(criterionObject.key, 'evidence.criterion.key', MAX_CRITERION_KEY),
    text: requireText(criterionObject.text, 'evidence.criterion.text', MAX_CRITERION_TEXT),
  };

  if (!Array.isArray(root.checks)) refuseShape('evidence.checks must be an array');
  if (root.checks.length > MAX_CHECKS) {
    refuseShape(`evidence.checks must contain at most ${MAX_CHECKS} entries`);
  }
  const checks = root.checks.map((entry, index) => {
    const path = `evidence.checks[${index}]`;
    const object = requireExactFields(entry, path, ['kind', 'ref']);
    requireNoUnknownFields(object, path, CHECK_FIELDS);
    const kind = object.kind;
    if (typeof kind !== 'string' || !(EVIDENCE_CHECK_KINDS as readonly string[]).includes(kind)) {
      refuseShape(`${path}.kind must be one of ${EVIDENCE_CHECK_KINDS.join(', ')}`);
    }
    const check: EvidenceCheck = {
      kind: kind as EvidenceCheckKind,
      ref: requireText(object.ref, `${path}.ref`, MAX_REF),
    };
    // The two consistency declarations are about a tool call and only a tool call: a commit and an
    // artifact have no command and no isError, so accepting the words there would be accepting a
    // declaration nothing can ever contradict.
    if (object.command !== undefined) {
      if (check.kind !== 'TOOL_CALL') refuseShape(`${path}.command is only meaningful on a TOOL_CALL`);
      check.command = requireText(object.command, `${path}.command`, MAX_COMMAND);
    }
    if (object.succeeded !== undefined) {
      if (check.kind !== 'TOOL_CALL') refuseShape(`${path}.succeeded is only meaningful on a TOOL_CALL`);
      if (typeof object.succeeded !== 'boolean') refuseShape(`${path}.succeeded must be a boolean`);
      check.succeeded = object.succeeded;
    }
    return check;
  });

  if (!Array.isArray(root.gaps)) refuseShape('evidence.gaps must be an array');
  if (root.gaps.length > MAX_GAPS) {
    refuseShape(`evidence.gaps must contain at most ${MAX_GAPS} entries`);
  }
  // An empty array is a statement, not an omission: it says this evidence leaves nothing
  // unestablished. That is why the field is required even when there is nothing to put in it.
  const gaps = root.gaps.map((gap, index) => requireText(gap, `evidence.gaps[${index}]`, MAX_GAP));

  return { claim, criterion, checks, gaps };
}

interface CitationScope {
  ownerId: string;
  taskId: string;
}

type ResolvedRow =
  | { found: true; toolCall?: { input: unknown; isError: boolean } }
  | { found: false; foreign: boolean };

/** TOOL_CALL. The handle is the tool_use id the runtime assigned, which is what pairs a call to
 * its result (`tool_call.tool_use_id`); the row it names carries the input and the error flag the
 * consistency layer needs. */
async function resolveToolCall(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  ref: string,
): Promise<ResolvedRow> {
  const owned = await tx.toolCall.findFirst({
    where: { toolUseId: ref, session: { ownerId: scope.ownerId, taskId: scope.taskId } },
    select: { input: true, isError: true },
  });
  if (owned) return { found: true, toolCall: { input: owned.input, isError: owned.isError } };
  // Asked separately, and only within this owner: "does this id exist somewhere else of MINE" is
  // answerable without reading another account, and one query ordered the other way round could
  // report a foreign row while an in-scope one existed.
  const foreign = await tx.toolCall.findFirst({
    where: { toolUseId: ref, session: { ownerId: scope.ownerId } },
    select: { id: true },
  });
  return { found: false, foreign: !!foreign };
}

/** COMMIT. The two places Orbit records a commit FOR a task: the checkpoint it verified and the
 * merge receipt that says the branch landed. Both are owner- and task-scoped rows. */
async function resolveCommit(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  ref: string,
): Promise<ResolvedRow> {
  const checkpoint = await tx.taskCheckpoint.findFirst({
    where: { ownerId: scope.ownerId, taskId: scope.taskId, commitSha: ref },
    select: { id: true },
  });
  if (checkpoint) return { found: true };
  const receipt = await tx.sessionMergeReceipt.findFirst({
    where: { ownerId: scope.ownerId, taskId: scope.taskId, sourceSha: ref },
    select: { id: true },
  });
  if (receipt) return { found: true };
  const foreignCheckpoint = await tx.taskCheckpoint.findFirst({
    where: { ownerId: scope.ownerId, commitSha: ref },
    select: { id: true },
  });
  if (foreignCheckpoint) return { found: false, foreign: true };
  const foreignReceipt = await tx.sessionMergeReceipt.findFirst({
    where: { ownerId: scope.ownerId, sourceSha: ref },
    select: { id: true },
  });
  return { found: false, foreign: !!foreignReceipt };
}

/** ARTIFACT. The portable artifact a checkpoint names (`task_checkpoint.artifact_ref`) — the one
 * artifact row in the schema, and the only one a second machine could fetch. */
async function resolveArtifact(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  ref: string,
): Promise<ResolvedRow> {
  const owned = await tx.taskCheckpoint.findFirst({
    where: { ownerId: scope.ownerId, taskId: scope.taskId, artifactRef: ref },
    select: { id: true },
  });
  if (owned) return { found: true };
  const foreign = await tx.taskCheckpoint.findFirst({
    where: { ownerId: scope.ownerId, artifactRef: ref },
    select: { id: true },
  });
  return { found: false, foreign: !!foreign };
}

const RESOLVERS: Record<
  EvidenceCheckKind,
  (tx: Prisma.TransactionClient, scope: CitationScope, ref: string) => Promise<ResolvedRow>
> = {
  TOOL_CALL: resolveToolCall,
  COMMIT: resolveCommit,
  ARTIFACT: resolveArtifact,
};

function citedCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : null;
}

/**
 * Layers 2 and 3, in that order, over every check.
 *
 * Returns one citation per check, in the submitted order, so the receipt can tell the submitter
 * WHICH handle held and which did not. An unresolved citation is reported rather than refused —
 * a submission is refused only when NONE of them resolved, because that is the case where the
 * envelope claims something with nothing to check it against.
 */
export async function resolveEvidenceCitations(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  envelope: EvidenceEnvelope,
): Promise<EvidenceCitation[]> {
  const citations: EvidenceCitation[] = [];
  for (const [index, check] of envelope.checks.entries()) {
    const row = await RESOLVERS[check.kind](tx, scope, check.ref);
    if (!row.found) {
      if (row.foreign) {
        refuseCitation(
          'EVIDENCE_CITATION_OUT_OF_SCOPE',
          `evidence.checks[${index}] cites a ${check.kind} recorded under another task; nothing was `
          + 'written. Evidence for this task cites rows produced under this task',
          'CITE_THIS_TASKS_OWN_ROWS',
        );
      }
      citations.push({
        kind: check.kind,
        ref: check.ref,
        resolved: false,
        reason: `no ${check.kind} of this task matches this reference`,
      });
      continue;
    }
    if (check.command !== undefined) {
      const actual = citedCommand(row.toolCall?.input);
      if (actual !== check.command) {
        refuseCitation(
          'EVIDENCE_CITATION_COMMAND_MISMATCH',
          `evidence.checks[${index}].command is not what the cited tool call ran; nothing was `
          + 'written. Quote the recorded command exactly or cite the call that ran this one',
          'QUOTE_THE_CITED_COMMAND_EXACTLY',
        );
      }
    }
    if (check.succeeded === true && row.toolCall?.isError) {
      refuseCitation(
        'EVIDENCE_CITATION_CONTRADICTS_TOOL_RESULT',
        `evidence.checks[${index}] declares success over a tool call Orbit recorded as failed; `
        + 'nothing was written',
        'DO_NOT_CLAIM_SUCCESS_OVER_A_FAILED_TOOL_CALL',
      );
    }
    citations.push({ kind: check.kind, ref: check.ref, resolved: true, reason: null });
  }

  if (!citations.some((citation) => citation.resolved)) {
    refuseCitation(
      'EVIDENCE_NO_RESOLVABLE_CITATION',
      'no citation in this envelope resolves to a row of this task; nothing was written. Evidence '
      + 'is a claim plus a handle somebody else can pull — without one it is a report',
      'CITE_THIS_TASKS_OWN_ROWS',
    );
  }
  return citations;
}

/**
 * Layer 2 again, as a READ: what each citation resolves to right now, reported and never refused.
 *
 * Submitting and reading are different moments and this is the difference. At submission a
 * citation that names another task's row is a boundary violation and the whole envelope is
 * rejected; here the envelope is already stored and immutable, and the only question left is which
 * of its handles a reader can still pull. So every outcome is a sentence rather than an exception:
 * a row that has since been deleted, or a task whose sessions have been reassigned, makes a
 * citation stop resolving, and a decider being shown that is the point of showing citations at all.
 */
export async function describeEvidenceCitations(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  checks: ReadonlyArray<EvidenceCheck>,
): Promise<EvidenceCitation[]> {
  const citations: EvidenceCitation[] = [];
  for (const check of checks) {
    const row = await RESOLVERS[check.kind](tx, scope, check.ref);
    citations.push({
      kind: check.kind,
      ref: check.ref,
      resolved: row.found,
      reason: row.found
        ? null
        : row.foreign
          ? `this ${check.kind} is recorded under another task`
          : `no ${check.kind} of this task matches this reference`,
    });
  }
  return citations;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The stated criterion a key names, as `project_get` spells it: the Base62 public id of the
 * definition row (`criterionKeyOf`). A raw UUID is accepted for the same row. */
function definitionIdFromKey(key: string): string | null {
  if (UUID_RE.test(key)) return key;
  try {
    const id = base62ToUuid(key);
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function comparableCriterionText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

/**
 * The live stated standard this quote is held against, or null when the task states none.
 *
 * TWO SOURCES, BECAUSE A TASK HAS A STANDARD WHETHER OR NOT IT IS IN A PROJECT
 * ---------------------------------------------------------------------------
 * A task filed under a project quotes one of that project's criteria, and the live text is the
 * definition row the key names. A task in NO project has exactly one stated standard and it is its
 * own `acceptanceCriteria` column — a persistent field, editable through `task_update` for the
 * whole life of the task, and already the text such a submission quotes verbatim.
 *
 * Until this branch existed the second case read nothing at all: `definitionIdFromKey` was skipped
 * for a task with no project, so the live text was unconditionally null and every such quote was
 * reported as not matching. Downstream that false was spent as "the standard moved", which is a
 * different sentence from "nothing was ever consulted" and the only one of the two that was true.
 */
async function liveCriterionText(
  tx: Prisma.TransactionClient,
  task: CriterionStandingTask,
  key: string,
): Promise<string | null> {
  if (task.projectId) {
    const definitionId = definitionIdFromKey(key);
    const live = definitionId
      ? await tx.projectAcceptanceCriterionDefinition.findFirst({
          where: { id: definitionId, projectId: task.projectId },
          select: { text: true },
        })
      : null;
    return live ? live.text : null;
  }
  // The key is not resolved here, and deliberately: a task in no project has one standard rather
  // than a table of them, so there is nothing for a key to select. What submitters write today is
  // the task's own public id (`evidence.criterion.key` may not be blank), and that keeps working
  // because nothing reads it — this lane binds to the TEXT, exactly as the project lane does.
  const stated = task.acceptanceCriteria;
  return stated && comparableCriterionText(stated) !== '' ? stated : null;
}

/**
 * Whether the criterion the envelope quotes is still worded that way.
 *
 * Reported, never refused. A stale quote is worth telling the submitter about — it means they are
 * arguing against wording that has since moved — but the criterion lane is not the load-bearing
 * one here, and refusing on it would make an edit to a project's criteria retroactively invalidate
 * evidence that was true when it was written.
 *
 * One predicate, and the reason it takes the task row rather than a project id: the submission
 * path reports what it returns and the decision door refuses on it, so a second implementation of
 * "is this quote still live" is a queue promising decisions the door refuses.
 */
export async function evidenceCriterionMatch(
  tx: Prisma.TransactionClient,
  task: CriterionStandingTask,
  criterion: { key: string; text: string },
): Promise<EvidenceCriterionMatch> {
  const live = await liveCriterionText(tx, task, criterion.key);
  return {
    key: criterion.key,
    text: criterion.text,
    matchesLive: live !== null && comparableCriterionText(live) === comparableCriterionText(criterion.text),
  };
}
