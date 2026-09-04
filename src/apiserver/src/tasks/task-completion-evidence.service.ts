import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CreatorType, Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  ImportLegacyTaskCommentEvidenceDto,
  TaskCompletionEvidenceDto,
  TaskEvidenceDecisionDto,
  TaskLegacyEvidenceImportDto,
} from './dto';
import {
  EVIDENCE_DECISIONS,
  EvidenceDecisionValue,
  assertCriterionUnmoved,
  assertCurrentEvidenceRevision,
  assertIndependentDecidingSession,
  decisionNote,
} from './task-evidence-decision';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';
import {
  EvidenceCitation,
  EvidenceCriterionMatch,
  evidenceCriterionMatch,
  parseEvidenceEnvelope,
  resolveEvidenceCitations,
} from './task-evidence-envelope';
import { TasksService } from './tasks.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { completionEvidenceRevisedFact } from '../projects/completion-input';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

export interface CompletionEvidenceActor {
  type: CreatorType;
  id: string;
}

export interface SubmitCompletionEvidence {
  sourceSessionId: string;
  evidence: JsonObject;
  idempotencyKey?: string;
}

export interface DecideCompletionEvidence {
  /** The run making the call. It is checked against this task's work, never trusted as authority. */
  decidingSessionId: string;
  /** Which version is being answered, as the decimal string `revision` is returned in. */
  evidenceRevision: string;
  decision: EvidenceDecisionValue;
  note?: string;
}

export interface CompletionCriterionSnapshotInput {
  title: string;
  projectId: string | null;
  status: TaskStatus;
  completionCriterion: TaskCompletionCriterionValue;
  acceptanceCriteria: string | null;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  completionPolicy: string;
  verifiesTaskId: string | null;
}

interface LockedCriterionTask extends CompletionCriterionSnapshotInput {}

interface BackfillCandidate extends LockedCriterionTask {
  id: string;
  evidenceId: string;
}

/** Normalize only representations JSON treats as the same fact; array order and whitespace stay evidence. */
export function normalizeCompletionEvidence(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BadRequestException('evidence must contain finite JSON numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizeCompletionEvidence);
  if (typeof value === 'object') {
    const input = value as JsonObject;
    const output: JsonObject = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) throw new BadRequestException('evidence must be JSON');
      output[key] = normalizeCompletionEvidence(input[key]);
    }
    return output;
  }
  throw new BadRequestException('evidence must be JSON');
}

/** JSON.stringify does not sort object keys, so the digest uses its own canonical encoder. */
export function canonicalCompletionJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalCompletionJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalCompletionJson(object[key])}`
  )).join(',')}}`;
}

export function completionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalCompletionJson(value)).digest('hex');
}

export function completionCriterionSnapshot(task: CompletionCriterionSnapshotInput): JsonObject {
  return normalizeCompletionEvidence({
    schemaVersion: 1,
    completionCriterion: task.completionCriterion,
    acceptanceCriteria: task.acceptanceCriteria,
    executableAcceptance: task.acceptanceCommand === null
      ? null
      : {
          command: task.acceptanceCommand,
          expectedExitCode: task.acceptanceExpectedExitCode,
        },
    completionPolicy: task.completionPolicy,
    verifiesTaskId: task.verifiesTaskId,
  }) as JsonObject;
}

const evidenceInclude = {
  idempotencyKeys: {
    orderBy: { idempotencyKey: 'asc' as const },
    select: { idempotencyKey: true },
  },
  legacyImport: true,
} satisfies Prisma.TaskCompletionEvidenceInclude;

type EvidenceRow = Prisma.TaskCompletionEvidenceGetPayload<{ include: typeof evidenceInclude }>;

function legacyImportResponse(row: EvidenceRow['legacyImport']): TaskLegacyEvidenceImportDto | null {
  if (!row) return null;
  return {
    id: row.id,
    sourceCommentId: row.sourceCommentId,
    sourceSessionId: row.sourceSessionId,
    sourceAuthorType: row.sourceAuthorType,
    sourceAuthorId: row.sourceAuthorId,
    sourceCreatedAt: row.sourceCreatedAt,
    sourceDigest: row.sourceDigest,
    structuredEvidenceDigest: row.structuredEvidenceDigest,
    importedById: row.importedById,
    importedAt: row.importedAt,
    idempotencyKey: row.idempotencyKey,
    reviewNote: row.reviewNote,
    devicePolicy: row.devicePolicy,
  };
}

interface EvidenceReceipt {
  citations: EvidenceCitation[];
  criterionMatch: EvidenceCriterionMatch;
}

function response(row: EvidenceRow, receipt?: EvidenceReceipt): TaskCompletionEvidenceDto {
  return {
    id: row.id,
    taskId: row.taskId,
    actorType: row.actorType,
    actorId: row.actorId,
    submittedAt: row.submittedAt,
    sourceSessionId: row.sourceSessionId,
    sourceAttemptId: row.sourceAttemptId,
    criterionRevision: row.criterionRevision,
    criterion: row.criterion as JsonObject,
    evidence: row.evidence as JsonObject,
    evidenceDigest: row.evidenceDigest,
    revision: row.revision.toString(),
    idempotencyKeys: row.idempotencyKeys.map(({ idempotencyKey }) => idempotencyKey),
    legacyImport: legacyImportResponse(row.legacyImport),
    citations: receipt?.citations ?? null,
    criterionMatch: receipt?.criterionMatch ?? null,
  };
}

const decisionInclude = {
  evidence: { select: { revision: true } },
} satisfies Prisma.TaskEvidenceDecisionInclude;

type DecisionRow = Prisma.TaskEvidenceDecisionGetPayload<{ include: typeof decisionInclude }>;

function decisionResponse(row: DecisionRow): TaskEvidenceDecisionDto {
  return {
    id: row.id,
    taskId: row.taskId,
    evidenceId: row.evidenceId,
    evidenceRevision: row.evidence.revision.toString(),
    criterionRevision: row.criterionRevision,
    evidenceDigest: row.evidenceDigest,
    decision: row.decision,
    note: row.note,
    decidedAt: row.decidedAt,
    decidedByType: row.decidedByType,
    decidedById: row.decidedById,
    decidingSessionId: row.decidingSessionId,
  };
}

/**
 * N10's append-only completion-evidence ledger.
 *
 * Since 2026-09-02 it is only a ledger. The judgment request each revision used to raise, the
 * device delivery that request filed, and the decision that closed it were removed with the rest
 * of the judgment machinery; nothing here derives a Task status or names a consumer. Submitting
 * evidence is still how a run records what it produced, and the rows are still immutable and
 * append-only, so a rebuilt implementation reads the same ledger.
 */
@Injectable()
export class TaskCompletionEvidenceService {
  private readonly logger = new Logger(TaskCompletionEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly completionInputs?: CompletionInputRouter,
  ) {}

  async submit(ownerId: string, taskId: string, actor: CompletionEvidenceActor, input: SubmitCompletionEvidence) {
    if (!UUID_RE.test(actor.id) || !Object.values(CreatorType).includes(actor.type)) {
      throw new BadRequestException('evidence actor is invalid');
    }
    if (!UUID_RE.test(input.sourceSessionId)) throw new BadRequestException('sourceSessionId is invalid');
    if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) {
      throw new BadRequestException('evidence must be a JSON object');
    }

    const normalizedEvidence = normalizeCompletionEvidence(input.evidence) as JsonObject;
    // Layer 1, outside the transaction: a shape refusal reads no row, so it need not hold the
    // Task mutex to be decided. Parsed from the NORMALIZED object because that is what gets
    // stored and digested, so the command layer 3 compares is the one a later reader will find.
    const envelope = parseEvidenceEnvelope(normalizedEvidence);
    const evidenceDigest = completionDigest(normalizedEvidence);
    const idempotencyKey = input.idempotencyKey?.trim().normalize('NFC');
    if (input.idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 200)) {
      throw new BadRequestException('idempotencyKey must contain 1 to 200 characters');
    }

    const committed = await withTransactionRetry(this.prisma, async (tx) => {
      // One Task mutex serialises revision allocation, stable-fact dedupe and retry-key binding.
      const [task] = await tx.$queryRaw<LockedCriterionTask[]>(Prisma.sql`
        SELECT "title", "project_id" AS "projectId", "status",
               "completion_criterion"::text AS "completionCriterion",
               "acceptance_criteria" AS "acceptanceCriteria",
               "acceptance_command" AS "acceptanceCommand",
               "acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
               "completion_policy"::text AS "completionPolicy",
               "verifies_task_id" AS "verifiesTaskId"
          FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
         FOR UPDATE
      `);
      if (!task) throw new NotFoundException('task not found');

      // Source Session status never gates the fact: RUNNING, AWAITING_INPUT and terminal source
      // Sessions submit the same evidence. Task.status is read only to decide whether the evidence
      // still raises an actionable question; a DONE Task keeps the evidence and closes the request
      // under an audited rule in this same transaction.
      const sourceSession = await tx.session.findFirst({
        where: { id: input.sourceSessionId, ownerId, taskId },
        select: { id: true },
      });
      if (!sourceSession) throw new NotFoundException('source session for task not found');
      const sourceAttempt = await tx.taskAttempt.findUnique({
        where: { sessionId: sourceSession.id },
        select: { id: true },
      });

      // Layers 2 and 3, ahead of the retry-key lookup so a replayed submission is answered with
      // the same receipt a first one gets. Both read only rows already inside this transaction's
      // scope, and both refuse by throwing, so nothing below runs for a refused envelope.
      const citations = await resolveEvidenceCitations(tx, { ownerId, taskId }, envelope);
      const criterionMatch = await evidenceCriterionMatch(tx, task.projectId, envelope.criterion);
      const receipt: EvidenceReceipt = { citations, criterionMatch };

      if (idempotencyKey) {
        const replay = await tx.taskCompletionEvidenceIdempotency.findFirst({
          where: { taskId, idempotencyKey },
          include: { evidence: { include: evidenceInclude } },
        });
        if (replay) {
          const sameRequest = replay.evidence.actorType === actor.type
            && replay.evidence.actorId === actor.id
            && replay.evidence.sourceSessionId === sourceSession.id
            && replay.evidence.evidenceDigest === evidenceDigest;
          if (!sameRequest) {
            throw new ConflictException('idempotencyKey is already bound to different completion evidence');
          }
          return {
            evidence: response(replay.evidence, receipt),
            evidenceRow: replay.evidence,
            projectId: task.projectId,
          };
        }
      }

      const criterion = completionCriterionSnapshot(task);
      const criterionRevision = completionDigest(criterion);
      let evidence = await tx.taskCompletionEvidence.findFirst({
        where: {
          taskId,
          actorType: actor.type,
          actorId: actor.id,
          sourceSessionId: sourceSession.id,
          criterionRevision,
          evidenceDigest,
        },
        include: evidenceInclude,
      });

      if (!evidence) {
        const latest = await tx.taskCompletionEvidence.aggregate({
          where: { taskId },
          _max: { revision: true },
        });
        evidence = await tx.taskCompletionEvidence.create({
          data: {
            id: randomUUID(),
            taskId,
            ownerId,
            actorType: actor.type,
            actorId: actor.id,
            sourceSessionId: sourceSession.id,
            sourceAttemptId: sourceAttempt?.id,
            criterionRevision,
            criterion: criterion as Prisma.InputJsonObject,
            evidence: normalizedEvidence as Prisma.InputJsonObject,
            evidenceDigest,
            revision: (latest._max.revision ?? 0n) + 1n,
          },
          include: evidenceInclude,
        });
      }

      if (idempotencyKey) {
        await tx.taskCompletionEvidenceIdempotency.create({
          data: { id: randomUUID(), taskId, idempotencyKey, evidenceId: evidence.id },
        });
        evidence = await tx.taskCompletionEvidence.findUniqueOrThrow({
          where: { id: evidence.id },
          include: evidenceInclude,
        });
      }
      return {
        evidence: response(evidence, receipt),
        evidenceRow: evidence,
        projectId: task.projectId,
      };
    }, loggedRetry(this.logger, 'taskCompletionEvidence.submit'));

    // The revision itself is the trigger. A source Session may still be RUNNING or
    // AWAITING_INPUT and sibling Tasks may still be OPEN: none of those lifecycle/collection
    // facts appears in this route or its key.
    if (committed.projectId && this.completionInputs) {
      await this.completionInputs.route(
        completionEvidenceRevisedFact({
          projectId: committed.projectId,
          taskId,
          revision: committed.evidenceRow.revision.toString(),
          criterionRevision: committed.evidenceRow.criterionRevision,
          evidenceDigest: committed.evidenceRow.evidenceDigest,
        }),
        // The wake's stored consumer vocabulary, unchanged: the label is what these rows have
        // always said and what the CHECK still accepts. Nothing derives a judgment request from
        // this fact any more — see COMPLETION_INPUT_CONSUMERS.
        'JUDGMENT_REQUEST_DERIVER',
      );
    }
    return committed.evidence;
  }

  /**
   * Convert one user-reviewed historical comment into a structured evidence revision.
   *
   * Nothing calls this method while listing or creating comments. The caller has to identify one
   * immutable source, supply the structured fact they found in it, and leave an audit note. The
   * source body itself is never parsed or treated as an instruction by this path.
   *
   * The completion-evidence envelope deliberately does NOT apply here. This path converts a
   * historical comment, and a comment written in 2026-08 cites no `tool_call` id — demanding one
   * would make every legacy fact unimportable, which is the opposite of what this door is for.
   * What stands in for the citation is the receipt: the reviewed source, its digest, and the
   * account owner's name on it.
   */
  async importLegacyComment(
    ownerId: string,
    taskId: string,
    actor: CompletionEvidenceActor,
    input: ImportLegacyTaskCommentEvidenceDto,
  ) {
    if (actor.type !== CreatorType.USER || !UUID_RE.test(actor.id) || actor.id !== ownerId) {
      throw new BadRequestException('legacy evidence import requires the account owner');
    }
    if (!UUID_RE.test(input.sourceCommentId)) throw new BadRequestException('sourceCommentId is invalid');
    if (!UUID_RE.test(input.sourceSessionId)) throw new BadRequestException('sourceSessionId is invalid');
    if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) {
      throw new BadRequestException('evidence must be a JSON object');
    }
    const idempotencyKey = input.idempotencyKey?.trim().normalize('NFC');
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new BadRequestException('idempotencyKey must contain 1 to 200 characters');
    }
    const reviewNote = input.reviewNote?.trim().normalize('NFC');
    if (!reviewNote || reviewNote.length > 4_000) {
      throw new BadRequestException('reviewNote must contain 1 to 4000 characters');
    }
    const structuredEvidence = normalizeCompletionEvidence(input.evidence) as JsonObject;
    const structuredEvidenceDigest = completionDigest(structuredEvidence);
    const devicePolicy = input.devicePush === true ? 'IMMEDIATE' : 'IN_APP_ONLY';

    const committed = await withTransactionRetry(this.prisma, async (tx) => {
      // Rank 10, before the Task mutex. The immutable import receipt later references this User;
      // taking the FK-equivalent lock now prevents that child INSERT from acquiring owner late.
      await tx.$queryRaw`
        SELECT "id" FROM "user"
         WHERE "id" = ${ownerId}::uuid
         FOR KEY SHARE`;
      const [task] = await tx.$queryRaw<LockedCriterionTask[]>(Prisma.sql`
        SELECT "title", "project_id" AS "projectId", "status",
               "completion_criterion"::text AS "completionCriterion",
               "acceptance_criteria" AS "acceptanceCriteria",
               "acceptance_command" AS "acceptanceCommand",
               "acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
               "completion_policy"::text AS "completionPolicy",
               "verifies_task_id" AS "verifiesTaskId"
          FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
         FOR UPDATE
      `);
      if (!task) throw new NotFoundException('task not found');

      const sourceComment = await tx.taskComment.findFirst({
        where: { id: input.sourceCommentId, taskId },
        select: {
          id: true,
          authorType: true,
          authorId: true,
          body: true,
          createdAt: true,
        },
      });
      if (!sourceComment) throw new NotFoundException('source comment for task not found');
      const sourceSession = await tx.session.findFirst({
        where: { id: input.sourceSessionId, ownerId, taskId },
        select: { id: true },
      });
      if (!sourceSession) throw new NotFoundException('source session for task not found');
      const sourceAttempt = await tx.taskAttempt.findUnique({
        where: { sessionId: sourceSession.id },
        select: { id: true },
      });

      // Hash the exact stored UTF-8 bytes. Normalization belongs to the reviewed structure, never
      // to the historical source whose identity the receipt must preserve.
      const sourceDigest = createHash('sha256').update(sourceComment.body, 'utf8').digest('hex');
      const evidenceDocument = normalizeCompletionEvidence({
        schemaVersion: 1,
        source: {
          type: 'TASK_COMMENT',
          sourceCommentId: sourceComment.id,
          sourceSessionId: sourceSession.id,
          sourceAuthorType: sourceComment.authorType,
          sourceAuthorId: sourceComment.authorId,
          sourceCreatedAt: sourceComment.createdAt.toISOString(),
          sourceDigest,
        },
        reviewedEvidence: structuredEvidence,
      }) as JsonObject;
      const evidenceDigest = completionDigest(evidenceDocument);

      const existingImports = await tx.taskLegacyEvidenceImport.findMany({
        where: {
          taskId,
          OR: [
            { sourceCommentId: sourceComment.id },
            { idempotencyKey },
          ],
        },
        include: { evidence: { include: evidenceInclude } },
      });
      if (existingImports.length > 1) {
        throw new ConflictException('legacy source and idempotencyKey are bound to different imports');
      }
      const existing = existingImports[0];
      if (existing) {
        const exactReplay = existing.sourceCommentId === sourceComment.id
          && existing.sourceSessionId === sourceSession.id
          && existing.sourceAuthorType === sourceComment.authorType
          && existing.sourceAuthorId === sourceComment.authorId
          && existing.sourceCreatedAt.getTime() === sourceComment.createdAt.getTime()
          && existing.sourceDigest === sourceDigest
          && existing.structuredEvidenceDigest === structuredEvidenceDigest
          && existing.importedById === actor.id
          && existing.idempotencyKey === idempotencyKey
          && existing.reviewNote === reviewNote
          && existing.devicePolicy === devicePolicy
          && existing.evidence.evidenceDigest === evidenceDigest;
        if (!exactReplay) {
          throw new ConflictException('legacy source or idempotencyKey is already bound to a different import');
        }
        return { evidence: response(existing.evidence) };
      }

      const occupiedKey = await tx.taskCompletionEvidenceIdempotency.findFirst({
        where: { taskId, idempotencyKey },
        select: { id: true },
      });
      if (occupiedKey) {
        throw new ConflictException('idempotencyKey is already bound to different completion evidence');
      }

      const criterion = completionCriterionSnapshot(task);
      const criterionRevision = completionDigest(criterion);
      const duplicateFact = await tx.taskCompletionEvidence.findFirst({
        where: {
          taskId,
          actorType: CreatorType.USER,
          actorId: actor.id,
          sourceSessionId: sourceSession.id,
          criterionRevision,
          evidenceDigest,
        },
        select: { id: true },
      });
      if (duplicateFact) {
        throw new ConflictException('legacy structured evidence already exists without this import receipt');
      }
      const latest = await tx.taskCompletionEvidence.aggregate({
        where: { taskId },
        _max: { revision: true },
      });
      let evidence = await tx.taskCompletionEvidence.create({
        data: {
          id: randomUUID(),
          taskId,
          ownerId,
          actorType: CreatorType.USER,
          actorId: actor.id,
          sourceSessionId: sourceSession.id,
          sourceAttemptId: sourceAttempt?.id,
          criterionRevision,
          criterion: criterion as Prisma.InputJsonObject,
          evidence: evidenceDocument as Prisma.InputJsonObject,
          evidenceDigest,
          revision: (latest._max.revision ?? 0n) + 1n,
        },
        include: evidenceInclude,
      });
      await tx.taskCompletionEvidenceIdempotency.create({
        data: { id: randomUUID(), taskId, idempotencyKey, evidenceId: evidence.id },
      });
      await tx.taskLegacyEvidenceImport.create({
        data: {
          id: randomUUID(),
          taskId,
          ownerId,
          evidenceId: evidence.id,
          sourceCommentId: sourceComment.id,
          sourceSessionId: sourceSession.id,
          sourceAuthorType: sourceComment.authorType,
          sourceAuthorId: sourceComment.authorId,
          sourceCreatedAt: sourceComment.createdAt,
          sourceDigest,
          structuredEvidenceDigest,
          importedById: actor.id,
          idempotencyKey,
          reviewNote,
          devicePolicy,
        },
      });
      evidence = await tx.taskCompletionEvidence.findUniqueOrThrow({
        where: { id: evidence.id },
        include: evidenceInclude,
      });
      return { evidence: response(evidence) };
    }, loggedRetry(this.logger, 'taskCompletionEvidence.importLegacyComment'));

    return committed.evidence;
  }

  /**
   * Record one independent session's decision about one version of this task's evidence.
   *
   * It writes one row and nothing else. No Task status, no Session state, no comment, no
   * notification, and none of the delivery machinery migration 0228 removed: a CONFIRM here is the
   * durable fact that an independent run read this exact evidence and found it sufficient, and
   * turning that fact into a status is a separate step that does not exist yet. SEND_BACK writes
   * the same one row with its note; the task is untouched, so it stays OPEN waiting for the next
   * revision — the absence of a write is the whole of "keep going".
   *
   * The four checks run in the order authority, subject, standard: may this caller answer at all,
   * is it answering the version that is actually open, and is the standard it is answering still
   * the one stated. A refusal at any of them writes nothing.
   */
  async decide(
    ownerId: string,
    taskId: string,
    actor: CompletionEvidenceActor,
    input: DecideCompletionEvidence,
  ) {
    if (!UUID_RE.test(actor.id) || !Object.values(CreatorType).includes(actor.type)) {
      throw new BadRequestException('evidence actor is invalid');
    }
    if (!UUID_RE.test(input.decidingSessionId)) throw new BadRequestException('decidingSessionId is invalid');
    if (!EVIDENCE_DECISIONS.includes(input.decision)) {
      throw new BadRequestException(`decision must be one of ${EVIDENCE_DECISIONS.join(', ')}`);
    }
    if (!/^\d{1,19}$/.test(input.evidenceRevision)) {
      throw new BadRequestException('evidenceRevision must be the decimal revision being answered');
    }
    const answered = BigInt(input.evidenceRevision);
    // Outside the transaction: a missing note reads no row, so it need not hold the Task mutex.
    const note = decisionNote(input.decision, input.note);

    return withTransactionRetry(this.prisma, async (tx) => {
      // The same Task mutex submission takes. It is what makes check 1 a compare-and-set: a
      // concurrent submission cannot allocate a new revision between the read below and the write.
      const [task] = await tx.$queryRaw<{ projectId: string | null }[]>(Prisma.sql`
        SELECT "project_id" AS "projectId"
          FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
         FOR UPDATE
      `);
      if (!task) throw new NotFoundException('task not found');

      const decidingSession = await tx.session.findFirst({
        where: { id: input.decidingSessionId, ownerId },
        select: { id: true, taskId: true },
      });
      if (!decidingSession) throw new NotFoundException('deciding session not found');
      await assertIndependentDecidingSession(tx, { ownerId, taskId }, decidingSession);

      const latest = await tx.taskCompletionEvidence.findFirst({
        where: { taskId },
        orderBy: { revision: 'desc' },
        select: { id: true, revision: true, criterionRevision: true, evidenceDigest: true, evidence: true },
      });
      if (!latest) throw new NotFoundException('this task has no completion evidence to decide');
      assertCurrentEvidenceRevision(answered, latest.revision);
      await assertCriterionUnmoved(tx, task.projectId, latest.evidence);

      // One decision per version. A second answer to the same one is a replay when it says the
      // same thing and a refusal when it does not — never a second row.
      const existing = await tx.taskEvidenceDecision.findFirst({
        where: { taskId, evidenceId: latest.id },
        include: decisionInclude,
      });
      if (existing) {
        const sameDecision = existing.decision === input.decision
          && existing.note === note
          && existing.decidedByType === actor.type
          && existing.decidedById === actor.id
          && existing.decidingSessionId === decidingSession.id;
        if (!sameDecision) {
          throw new ConflictException({
            code: 'EVIDENCE_JUDGMENT_ALREADY_DECIDED',
            message:
              `revision ${latest.revision} of this task's evidence was already decided ` +
              `${existing.decision}; nothing was written. A version is answered once, and the way ` +
              'to raise a different answer is to decide the next revision',
            requiredAction: 'DECIDE_THE_NEXT_EVIDENCE_REVISION',
          });
        }
        return decisionResponse(existing);
      }

      const written = await tx.taskEvidenceDecision.create({
        data: {
          id: randomUUID(),
          taskId,
          ownerId,
          evidenceId: latest.id,
          // The binding, and the reason no column had to be added anywhere: these two travel with
          // the evidence id into one composite foreign key, so the row cannot outlive the exact
          // content it claims to have judged.
          criterionRevision: latest.criterionRevision,
          evidenceDigest: latest.evidenceDigest,
          decision: input.decision,
          note,
          decidedByType: actor.type,
          decidedById: actor.id,
          decidingSessionId: decidingSession.id,
        },
        include: decisionInclude,
      });
      return decisionResponse(written);
    }, loggedRetry(this.logger, 'taskCompletionEvidence.decide'));
  }

  async list(ownerId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, ownerId }, select: { id: true } });
    if (!task) throw new NotFoundException('task not found');
    const rows = await this.prisma.taskCompletionEvidence.findMany({
      where: { taskId },
      orderBy: { revision: 'asc' },
      include: evidenceInclude,
    });
    // Not `map(response)`: the receipt parameter would receive the array index.
    return rows.map((row) => response(row));
  }
}
