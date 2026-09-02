import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CreatorType, Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  ImportLegacyTaskCommentEvidenceDto,
  TaskCompletionEvidenceDto,
  TaskLegacyEvidenceImportDto,
} from './dto';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';
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

function response(row: EvidenceRow): TaskCompletionEvidenceDto {
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
            evidence: response(replay.evidence),
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
        evidence: response(evidence),
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

  async list(ownerId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, ownerId }, select: { id: true } });
    if (!task) throw new NotFoundException('task not found');
    const rows = await this.prisma.taskCompletionEvidence.findMany({
      where: { taskId },
      orderBy: { revision: 'asc' },
      include: evidenceInclude,
    });
    return rows.map(response);
  }
}
