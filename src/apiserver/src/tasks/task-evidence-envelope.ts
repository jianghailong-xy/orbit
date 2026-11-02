import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import type { ImageSize } from '../files/image-size';
import { testReportLine, type TestReportSummary } from '../files/test-report';

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
 *     boundary violation, not weak evidence. A FILE citation that finds nothing is refused too,
 *     because the digest binds its bytes (`resolveEvidenceCitations`).
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
export const EVIDENCE_CHECK_KINDS = ['TOOL_CALL', 'COMMIT', 'ARTIFACT', 'FILE'] as const;
export type EvidenceCheckKind = (typeof EVIDENCE_CHECK_KINDS)[number];

export interface EvidenceCheck {
  kind: EvidenceCheckKind;
  ref: string;
  /** TOOL_CALL only: what the submitter says the cited call ran. Checked byte for byte. */
  command?: string;
  /** TOOL_CALL only: what the submitter says it did. `true` over an `isError` row is refused. */
  succeeded?: boolean;
  /**
   * FILE only, and only the server writes it (`bindCitedFiles`): the bytes this citation is bound to, which the evidence
   * digest covers. A submission carrying it is refused: a hash the submitter typed binds nothing.
   */
  sha256?: string;
  /** FILE only, written beside `sha256`: an image's size in pixels, as its own header states it. */
  width?: number;
  height?: number;
}

export interface EvidenceEnvelope {
  claim: string;
  /**
   * The stated standard this evidence is measured against, quoted by key AND by text.
   *
   * `key` says WHICH standard and `text` says what it said (`evidenceCriterionMatch`). For a task
   * that declares one of its project's criteria the key is the one `project_get` prints beside THAT
   * criterion — it has to name the declared one, not any of the project's — and the text has to be
   * its current wording. For any other task — in NO project, or filed under one without declaring a
   * criterion — there is nothing to select: such a task has exactly one standard, its own
   * `acceptanceCriteria`, so the convention is the task's own public id, which is what submitters
   * already write, and only the text is checked. The field is required in both cases because the
   * envelope has no optional halves; what changes is only whether anything reads the key.
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
  /** The cited row as a person reads it, or null when the ref is already the readable thing.
   *  See `citationLabel`. */
  label: string | null;
  /** A resolved FILE citation only: the bytes it is bound to. */
  sha256?: string;
  /** A resolved FILE citation of an image only: its size in pixels. */
  width?: number;
  height?: number;
  /**
   * A resolved FILE citation of a test report (`file_upload --as test-report`) only: what it says, for a card to show. Read
   * off the row, so it is here after the file has expired. It is derived from the bytes `sha256` binds and stays out of the
   * check, so it is no part of the evidence digest.
   */
  testReport?: TestReportSummary;
}

export interface EvidenceCriterionMatch {
  key: string;
  text: string;
  /** Whether the quoted text is still what the standard this task is held to says today. */
  matchesLive: boolean;
}

/** What the criterion lane reads off the task: where this task's stated standard lives. A task
 * that declares one of its project's criteria (`criterionDefinitionId`) is held to that criterion;
 * any other task — in no project, or in one without a declaration — has its own
 * `acceptanceCriteria` and nothing else. Passed in rather than read here because both callers hold
 * the row already, under the Task mutex in the two that write. */
export interface CriterionStandingTask {
  projectId: string | null;
  /** `Task.criterionDefinitionId`: the project criterion this task declares it serves, or null. */
  criterionDefinitionId: string | null;
  /** `Task.criterionRevision`: that criterion's revision when it was declared. Deleting the
   * criterion nulls only the id (0232's ON DELETE SET NULL), so this is what still says the task
   * declared one; clearing `criterionKey` empties both. */
  criterionRevision: number | null;
  acceptanceCriteria: string | null;
}

/** Whether the live standard is a project criterion rather than the task's own criteria. The one
 * branch the match and the refusal's wording both take, so the two cannot answer differently.
 *
 * A declaration whose criterion was deleted is still a declaration — 0232 reads
 * `criterion_definition_id IS NULL AND criterion_revision IS NOT NULL` as exactly that — so it
 * stays on the project lane, where it has no live text at all (`liveCriterionText`). On the task's
 * own lane, criteria repeating the deleted wording would pass a quote of a standard the project no
 * longer states. */
export function heldToProjectCriterion(
  task: CriterionStandingTask,
): task is CriterionStandingTask & { projectId: string } {
  return task.projectId !== null
    && (task.criterionDefinitionId !== null || task.criterionRevision !== null);
}

/** Whether `key` names the project criterion this task declares — the one criterion of its project
 * it is held to. Another criterion of the project is not its standard, however live. */
export function quotesDeclaredCriterion(task: CriterionStandingTask, key: string): boolean {
  const definitionId = definitionIdFromKey(key);
  return definitionId !== null && task.criterionDefinitionId !== null
    && definitionId.toLowerCase() === task.criterionDefinitionId.toLowerCase();
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
const STORED_FILE_CHECK_FIELDS = [...CHECK_FIELDS, 'height', 'sha256', 'width'];

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
export function parseEvidenceEnvelope(
  evidence: unknown,
  /** `stored` reads what the server saved, where a FILE check holds what a submitter may not write. */
  origin: 'submitted' | 'stored' = 'submitted',
): EvidenceEnvelope {
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
    const fields = origin === 'stored' && object.kind === 'FILE' ? STORED_FILE_CHECK_FIELDS : CHECK_FIELDS;
    requireNoUnknownFields(object, path, fields);
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
    if (typeof object.sha256 === 'string') check.sha256 = object.sha256;
    if (typeof object.width === 'number' && typeof object.height === 'number') {
      check.width = object.width;
      check.height = object.height;
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

/**
 * The stored envelope, or null when this evidence predates it.
 *
 * Layer 1 is reused rather than re-implemented: what a card may show is exactly what a submission
 * had to be for it to be accepted. The catch is not a shrug — a legacy import is deliberately
 * exempt from the envelope, so its row still belongs in the queue and simply has less to render.
 */
export function storedEvidenceEnvelope(evidence: unknown): EvidenceEnvelope | null {
  try {
    return parseEvidenceEnvelope(evidence, 'stored');
  } catch {
    return null;
  }
}

interface CitationScope {
  ownerId: string;
  taskId: string;
}

/** What a FILE citation found: an attachment row, which is a file or a folder bundle's manifest. */
interface CitedFile {
  id: string;
  /** Null on a pasted image. */
  name: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** On a manifest, what its folder holds. */
  bundle: { fileCount: number; totalBytes: number } | null;
  testReport: TestReportSummary | null;
}

type FoundRow = {
  found: true;
  toolCall?: { name: string; input: unknown; isError: boolean };
  file?: CitedFile;
};

type ResolvedRow = FoundRow | { found: false; foreign: boolean };

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
    select: { name: true, input: true, isError: true },
  });
  if (owned) {
    return {
      found: true,
      toolCall: { name: owned.name, input: owned.input, isError: owned.isError },
    };
  }
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

/**
 * FILE. An attachment row of this owner's: kept by one of this task's sessions, or attached to the task itself. A folder
 * bundle is its manifest's row, whose sha256 binds every file it lists (`FileBundleManifest`). Whose a row is can be read
 * off the row, so this takes one query where the other resolvers take two.
 *
 * A row with no sha256 has no bytes to bind and is not found. Only a row from before Orbit Files could be one, and saving
 * a citation gives such a row its sha256 first (`FilesService.prepareCitedFiles`).
 */
async function resolveFile(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  ref: string,
): Promise<ResolvedRow> {
  const id = rowIdOf(ref);
  const row = id === null ? null : await tx.attachment.findFirst({
    where: { id, ownerId: scope.ownerId },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      sha256: true,
      fileBundleId: true,
      sessionId: true,
      taskId: true,
      testReportSummary: true,
      session: { select: { taskId: true } },
    },
  });
  if (!row?.sha256) return { found: false, foreign: false };
  if (row.taskId !== scope.taskId && row.session?.taskId !== scope.taskId) return { found: false, foreign: true };
  const folder = row.fileBundleId === row.id
    ? await tx.attachment.aggregate({
      where: { sessionId: row.sessionId, fileBundleId: row.id, id: { not: row.id } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    })
    : null;
  return {
    found: true,
    file: {
      id: row.id,
      name: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      bundle: folder && { fileCount: folder._count._all, totalBytes: folder._sum.sizeBytes ?? 0 },
      testReport: row.testReportSummary as unknown as TestReportSummary | null,
    },
  };
}

const RESOLVERS: Record<
  EvidenceCheckKind,
  (tx: Prisma.TransactionClient, scope: CitationScope, ref: string) => Promise<ResolvedRow>
> = {
  TOOL_CALL: resolveToolCall,
  COMMIT: resolveCommit,
  ARTIFACT: resolveArtifact,
  FILE: resolveFile,
};

const MAX_LABEL_COMMAND = 60;
const MAX_LABEL_FILE_NAME = 80;

/** One line, at most `max` long: a heredoc, a multi-line script or a file name with a newline in it would otherwise
 * put the rest of itself into a list item sized for a sentence. */
function labelLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "412 KB", "3.4 MB": the way `formatFileSize` on the web states a size, so a label and a card agree. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * `shot.png · 412 KB · image/png · 1280×800`, for a folder bundle `9 files · 1.8 MB`, and for a test report
 * `report.json · 12 KB · application/json · Playwright · 46 passed · 0 failed · 2 skipped`.
 */
function fileLabel(file: CitedFile, check: EvidenceCheck): string {
  if (file.bundle) {
    const { fileCount, totalBytes } = file.bundle;
    return `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${fileSize(totalBytes)}`;
  }
  return [
    ...(file.name ? [labelLine(file.name, MAX_LABEL_FILE_NAME)] : []),
    fileSize(file.sizeBytes),
    file.mimeType,
    ...(check.width && check.height ? [`${check.width}×${check.height}`] : []),
    ...(file.testReport ? [testReportLine(file.testReport)] : []),
  ].join(' · ');
}

/**
 * The cited row as a PERSON reads it, or null when there is nothing better than the ref.
 *
 * A `toolu_` id is a handle for the server — it is what pairs a call to its result — and a card
 * that prints twelve of them beside the word `resolved` is asking its reader to take the word on
 * faith: the id is not clickable, not comparable to anything else on screen, and says nothing
 * about what was run. The name and the command are on the row the resolver has already fetched
 * for layer 3, so this costs no query.
 *
 * A file's id says even less than a `toolu_` one, so a FILE citation is labelled too (`fileLabel`). Its row costs no
 * query here either, and the image size on the check is why none of this reads the file store.
 *
 * Null for an UNRESOLVED citation on purpose: no row was found, so the ref is genuinely all
 * anybody has. Null for the other kinds too — a commit sha and an artifact ref are already the
 * readable thing, and inventing a second spelling for them would be a label that says less.
 */
function citationLabel(row: FoundRow, check: EvidenceCheck): string | null {
  if (row.file) return fileLabel(row.file, check);
  if (!row.toolCall) return null;
  const command = citedCommand(row.toolCall.input);
  if (command === null) return row.toolCall.name;
  const line = labelLine(command, MAX_LABEL_COMMAND);
  return line === '' ? row.toolCall.name : `${row.toolCall.name} · ${line}`;
}

/** A citation that resolved. A file's is spelled by its public id whichever spelling `check` used. */
function resolvedCitation(check: EvidenceCheck, row: FoundRow): EvidenceCitation {
  const citation: EvidenceCitation = {
    kind: check.kind,
    ref: row.file ? uuidToBase62(row.file.id) : check.ref,
    resolved: true,
    reason: null,
    label: citationLabel(row, check),
  };
  if (row.file) citation.sha256 = row.file.sha256;
  if (row.file && check.width && check.height) {
    citation.width = check.width;
    citation.height = check.height;
  }
  if (row.file?.testReport) citation.testReport = row.file.testReport;
  return citation;
}

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
 *
 * Except a FILE citation, which is refused alone: the evidence digest binds the cited bytes, so a citation that finds no
 * bytes would be stored as a promise of a file nobody can hold it to. `images` is what the file store said about the
 * cited images, read before this transaction (`FilesService.prepareCitedFiles`).
 */
export async function resolveEvidenceCitations(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  envelope: EvidenceEnvelope,
  images: ReadonlyMap<string, ImageSize>,
): Promise<EvidenceCitation[]> {
  const citations: EvidenceCitation[] = [];
  for (const [index, submitted] of envelope.checks.entries()) {
    const row = await RESOLVERS[submitted.kind](tx, scope, submitted.ref);
    const check = row.found && row.file ? { ...submitted, ...images.get(row.file.id) } : submitted;
    if (!row.found) {
      if (row.foreign) {
        refuseCitation(
          'EVIDENCE_CITATION_OUT_OF_SCOPE',
          `evidence.checks[${index}] cites a ${check.kind} recorded under another task; nothing was `
          + 'written. Evidence for this task cites rows produced under this task',
          'CITE_THIS_TASKS_OWN_ROWS',
        );
      }
      if (check.kind === 'FILE') {
        refuseCitation(
          'EVIDENCE_FILE_NOT_FOUND',
          `evidence.checks[${index}] cites no file of this task; nothing was written. A FILE citation binds the file's `
          + 'bytes into the evidence, so it has to name a file or folder bundle uploaded in one of this task\'s sessions '
          + 'or attached to this task',
          'CITE_THIS_TASKS_OWN_ROWS',
        );
      }
      citations.push({
        kind: check.kind,
        ref: check.ref,
        resolved: false,
        reason: `no ${check.kind} of this task matches this reference`,
        label: null,
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
    citations.push(resolvedCitation(check, row));
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
 * The evidence as it is stored and digested: what was submitted, with each FILE check naming the file by its public id
 * and holding the sha256 of its bytes, and the size of an image. So the digest binds the bytes, as it binds a commit by
 * its sha, and two spellings of one file are one fact. All of it is a function of the bytes, so resubmitting the same
 * evidence digests the same.
 *
 * Evidence with no FILE check comes back as the object it was: nothing about it changes.
 */
export function bindCitedFiles(
  evidence: Record<string, unknown>,
  citations: ReadonlyArray<EvidenceCitation>,
): Record<string, unknown> {
  if (!citations.some((citation) => citation.kind === 'FILE')) return evidence;
  return {
    ...evidence,
    checks: (evidence.checks as Record<string, unknown>[]).map((check, index) => {
      const { kind, ref, sha256, width, height } = citations[index];
      return kind === 'FILE' ? { ...check, ref, sha256, ...(width ? { width, height } : {}) } : check;
    }),
  };
}

/** The attachment rows these checks cite, by id. */
export function citedFileIds(checks: ReadonlyArray<EvidenceCheck>): string[] {
  return checks.flatMap((check) => {
    const id = check.kind === 'FILE' ? rowIdOf(check.ref) : null;
    return id ? [id] : [];
  });
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
    citations.push(row.found
      ? resolvedCitation(check, row)
      : {
        kind: check.kind,
        ref: check.ref,
        resolved: false,
        reason: row.foreign
          ? `this ${check.kind} is recorded under another task`
          : `no ${check.kind} of this task matches this reference`,
        label: null,
      });
  }
  return citations;
}

/** One file a decider is told of: what it is, and the id `file_fetch` takes. */
export interface CitedFileLine {
  id: string;
  label: string;
}

export function citedFileLines(citations: ReadonlyArray<EvidenceCitation>): CitedFileLine[] {
  return citations.flatMap((citation) => (
    citation.kind === 'FILE' && citation.label ? [{ id: citation.ref, label: citation.label }] : []
  ));
}

/** The FILE citations of a stored revision, as `citedFileLines` tells of them. */
export async function describeCitedFiles(
  tx: Prisma.TransactionClient,
  scope: CitationScope,
  evidence: unknown,
): Promise<CitedFileLine[]> {
  const checks = storedEvidenceEnvelope(evidence)?.checks.filter((check) => check.kind === 'FILE') ?? [];
  return citedFileLines(await describeEvidenceCitations(tx, scope, checks));
}

/**
 * What a revision's decider reads about its files (docs/orbit-files-design.md §2.7): each one, and the call that fetches
 * it. Listed rather than delivered, because the p90 of evidence is 142 files and a judgment usually wants a few.
 */
export function citedFilesBlock(files: ReadonlyArray<CitedFileLine>): string {
  return [
    'The files this revision cites. file_fetch saves one into your uploads directory, outside the repository; a folder '
    + 'bundle (“N files”) saves its manifest and lists its files, each with an id of its own to fetch.',
    ...files.map(({ id, label }) => `- ${label}: file_fetch (id: ${id})`),
  ].join('\n');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The row a public id names, or the UUID itself; null for anything else. */
function rowIdOf(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref;
  try {
    const id = base62ToUuid(ref);
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The stated criterion a key names, as `project_get` spells it: the Base62 public id of the
 * definition row (`criterionKeyOf`). A raw UUID is accepted for the same row. */
export function definitionIdFromKey(key: string): string | null {
  return rowIdOf(key);
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
 *
 * WHICH OF THE TWO IS DECIDED BY THE DECLARATION, NOT BY THE FILING
 * -----------------------------------------------------------------
 * Being filed under a project does not make one of its criteria this task's standard; declaring it
 * does (`criterionKey`, stored as `criterionDefinitionId`). A project task that declares none states
 * exactly one standard, its own `acceptanceCriteria`, the same as a task in no project. Branching on
 * the filing instead held such a task to a table of criteria it never chose: quoting its own
 * criteria was refused as moved at every revision, and the only quote that passed was some other
 * criterion of the project's, borrowed as a wrapper. A declared task is held to the criterion it
 * declares: the key has to name that criterion (`quotesDeclaredCriterion`) and the quote is held
 * to its current wording. Resolving whatever key the quote carried instead let any other live
 * criterion of the project stand in for the declared one — the same wrapper, borrowed by a task
 * that did declare. One whose declared criterion has since been deleted stays declared
 * (`heldToProjectCriterion`) and has no live text: the standard it declared is gone, and neither
 * its own column nor another criterion of the project is that standard.
 */
async function liveCriterionText(
  tx: Prisma.TransactionClient,
  task: CriterionStandingTask,
  key: string,
): Promise<string | null> {
  if (heldToProjectCriterion(task)) {
    if (task.criterionDefinitionId === null || !quotesDeclaredCriterion(task, key)) return null;
    const live = await tx.projectAcceptanceCriterionDefinition.findFirst({
      where: { id: task.criterionDefinitionId, projectId: task.projectId },
      select: { text: true },
    });
    return live ? live.text : null;
  }
  // The key is not resolved here, and deliberately: a task that declares no project criterion has
  // one standard rather than a table of them, so there is nothing for a key to select. What
  // submitters write today is the task's own public id (`evidence.criterion.key` may not be
  // blank), and that keeps working because nothing reads it — this lane binds to the TEXT, exactly
  // as the project lane does.
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
