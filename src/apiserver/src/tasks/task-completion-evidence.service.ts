import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CreatorType, Prisma, TaskJudgmentRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  ImportLegacyTaskCommentEvidenceDto,
  TaskCompletionEvidenceDto,
  TaskJudgmentRequestDto,
  TaskLegacyEvidenceImportDto,
} from './dto';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';
import { routeTaskJudgment } from './task-judgment-request';
import { TasksService } from './tasks.service';
import { JudgmentDeliveryService } from '../push/judgment-delivery.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import {
  completionEvidenceRevisedFact,
  humanSignoffRequestedFact,
  humanSignoffRequestSupersededFact,
} from '../projects/completion-input';

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

export interface TaskJudgmentBackfillInput {
  idempotencyKey: string;
  batchSize: number;
  pushTaskIds?: string[];
}

export interface TaskJudgmentBackfillResult {
  id: string;
  ownerId: string;
  actorType: CreatorType;
  actorId: string;
  idempotencyKey: string;
  inputDigest: string;
  batchSize: number;
  pushTaskIds: string[];
  selection: JsonObject;
  startedAt: Date;
  finishedAt: Date;
  scannedCount: number;
  requestCount: number;
  inboxCount: number;
  pushSelectedCount: number;
  pushSuppressedCount: number;
  durationMs: string;
}

interface RequestCreationOptions {
  origin?: 'LIVE_EVIDENCE' | 'LEGACY_IMPORT' | 'BACKFILL';
  devicePolicy?: 'IMMEDIATE' | 'IN_APP_ONLY';
  backfillBatchId?: string;
}

interface LockedCriterionTask {
  title: string;
  projectId: string | null;
  completionCriterion: TaskCompletionCriterionValue;
  acceptanceCriteria: string | null;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  completionPolicy: string;
  verifiesTaskId: string | null;
}

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

function criterionSnapshot(task: LockedCriterionTask): JsonObject {
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

type JudgmentRequestRow = Prisma.TaskJudgmentRequestGetPayload<Record<string, never>>;
type BackfillBatchRow = Prisma.TaskJudgmentBackfillBatchGetPayload<Record<string, never>>;

function backfillResponse(row: BackfillBatchRow): TaskJudgmentBackfillResult {
  if (!row.finishedAt || row.scannedCount === null || row.requestCount === null
    || row.inboxCount === null || row.pushSelectedCount === null
    || row.pushSuppressedCount === null || row.durationMs === null) {
    throw new ConflictException('judgment backfill batch has no committed result');
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    actorType: row.actorType,
    actorId: row.actorId,
    idempotencyKey: row.idempotencyKey,
    inputDigest: row.inputDigest,
    batchSize: row.batchSize,
    pushTaskIds: row.pushTaskIds,
    selection: row.selection as JsonObject,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    scannedCount: row.scannedCount,
    requestCount: row.requestCount,
    inboxCount: row.inboxCount,
    pushSelectedCount: row.pushSelectedCount,
    pushSuppressedCount: row.pushSuppressedCount,
    durationMs: row.durationMs.toString(),
  };
}

function requestResponse(row: JudgmentRequestRow): TaskJudgmentRequestDto {
  return {
    id: row.id,
    taskId: row.taskId,
    evidenceId: row.evidenceId,
    criterionRevision: row.criterionRevision,
    evidenceDigest: row.evidenceDigest,
    kind: row.kind,
    recipientType: row.recipientType,
    recipientId: row.recipientId,
    status: row.status,
    origin: row.origin,
    devicePolicy: row.devicePolicy,
    backfillBatchId: row.backfillBatchId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedByType: row.decidedByType,
    decidedById: row.decidedById,
    decision: row.decision,
    supersededAt: row.supersededAt,
    supersededById: row.supersededById,
  };
}

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

function response(row: EvidenceRow, request: JudgmentRequestRow): TaskCompletionEvidenceDto {
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
    judgmentRequest: requestResponse(request),
  };
}

/**
 * N10's append-only completion-evidence ledger.
 *
 * Its evidence/request transaction never writes the subject Task or source Session lifecycle.
 * Post-commit VERIFICATION delivery may create the current verifier carrier and retire a carrier
 * whose request the transaction just superseded; those carrier writes use TasksService's ordinary
 * lifecycle boundary and cannot suppress or reject the evidence fact itself.
 */
@Injectable()
export class TaskCompletionEvidenceService {
  private readonly logger = new Logger(TaskCompletionEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly deliveries?: JudgmentDeliveryService,
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
        SELECT "title", "project_id" AS "projectId",
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

      // No status appears in this read or any branch: RUNNING, AWAITING_INPUT and terminal source
      // Sessions submit the same fact. The only requirement is that this Session executes Task.
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
          const request = await this.requestForEvidenceFact(tx, taskId, replay.evidence, task);
          const superseded = await tx.taskJudgmentRequest.findMany({
            where: { supersededById: request.id },
          });
          return {
            evidence: response(replay.evidence, request),
            evidenceRow: replay.evidence,
            request,
            superseded,
            projectId: task.projectId,
          };
        }
      }

      const criterion = criterionSnapshot(task);
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
      const request = await this.requestForEvidenceFact(tx, taskId, evidence, task);
      const superseded = await tx.taskJudgmentRequest.findMany({
        where: { supersededById: request.id },
      });
      return {
        evidence: response(evidence, request),
        evidenceRow: evidence,
        request,
        superseded,
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
          requestId: committed.request.id,
          requestKind: committed.request.kind,
        }),
        'JUDGMENT_REQUEST_DERIVER',
      );
      // HUMAN_SIGNOFF is addressed to a person. These facts feed N12's inbox/delivery surface and
      // deliberately never call CoordinatorJudgmentService or SessionsService.
      if (committed.request.kind === 'HUMAN_SIGNOFF') {
        await this.completionInputs.route(
          humanSignoffRequestedFact({
            projectId: committed.projectId,
            taskId,
            requestId: committed.request.id,
            criterionRevision: committed.request.criterionRevision,
            evidenceDigest: committed.request.evidenceDigest,
            recipientId: committed.request.recipientId,
          }),
          'HUMAN_INBOX',
        );
      }
      for (const request of committed.superseded) {
        if (request.kind !== 'HUMAN_SIGNOFF') continue;
        await this.completionInputs.route(
          humanSignoffRequestSupersededFact({
            projectId: committed.projectId,
            taskId,
            requestId: request.id,
            evidenceDigest: request.evidenceDigest,
            supersededById: committed.request.id,
            replacementEvidenceDigest: committed.request.evidenceDigest,
          }),
          'HUMAN_INBOX',
        );
      }
    }

    await this.afterEvidenceCommit(ownerId, taskId, committed.request);
    return committed.evidence;
  }

  private async afterEvidenceCommit(
    ownerId: string,
    taskId: string,
    request: JudgmentRequestRow,
  ): Promise<void> {
    // VERIFICATION owns a distinct task whose id is the request id. Filing/dispatch is after the
    // evidence transaction so a runner failure cannot erase the request; a replay converges on the
    // same deterministic task instead of minting another one.
    if (request.kind === 'VERIFICATION' && this.tasks) {
      if (request.status === TaskJudgmentRequestStatus.OPEN) {
        await this.tasks.ensureJudgmentVerification(
          ownerId,
          taskId,
          request.id,
          request.evidenceDigest,
        );
      }
      await this.tasks.retireSupersededJudgmentVerifications(ownerId, taskId);
    }
    if (request.kind === 'HUMAN_SIGNOFF'
      && request.status === TaskJudgmentRequestStatus.OPEN
      && request.devicePolicy === 'IMMEDIATE') {
      // The trigger already committed the inbox/outbox rows. This is only the low-latency nudge;
      // startup recovery and the persisted nextAttemptAt remain the guarantee if this process dies
      // between COMMIT and this line.
      this.deliveries?.kick();
    }
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
        SELECT "title", "project_id" AS "projectId",
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
        const request = await tx.taskJudgmentRequest.findFirst({
          where: { evidenceId: existing.evidenceId, origin: 'LEGACY_IMPORT' },
        });
        if (!request) throw new ConflictException('legacy evidence import has no judgment request');
        return { evidence: response(existing.evidence, request), request };
      }

      const occupiedKey = await tx.taskCompletionEvidenceIdempotency.findFirst({
        where: { taskId, idempotencyKey },
        select: { id: true },
      });
      if (occupiedKey) {
        throw new ConflictException('idempotencyKey is already bound to different completion evidence');
      }

      const criterion = criterionSnapshot(task);
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
      const request = await this.requestForEvidenceFact(tx, taskId, evidence, task, {
        origin: 'LEGACY_IMPORT',
        devicePolicy,
      });
      return { evidence: response(evidence, request), request };
    }, loggedRetry(this.logger, 'taskCompletionEvidence.importLegacyComment'));

    await this.afterEvidenceCommit(ownerId, taskId, committed.request);
    return committed.evidence;
  }

  /**
   * File missing HUMAN_SIGNOFF requests for a bounded slice of tasks that already have evidence.
   * It deliberately cannot create evidence, and DONE/CANCELLED/no-evidence rows cannot enter the
   * candidate set. Every request gets a durable inbox row; device work is opt-in by task id.
   */
  async backfill(
    ownerId: string,
    actor: CompletionEvidenceActor,
    input: TaskJudgmentBackfillInput,
  ): Promise<TaskJudgmentBackfillResult> {
    if (!UUID_RE.test(ownerId) || !UUID_RE.test(actor.id)
      || !Object.values(CreatorType).includes(actor.type)) {
      throw new BadRequestException('backfill actor is invalid');
    }
    const idempotencyKey = input.idempotencyKey?.trim().normalize('NFC');
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new BadRequestException('idempotencyKey must contain 1 to 200 characters');
    }
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1_000) {
      throw new BadRequestException('batchSize must be an integer from 1 to 1000');
    }
    const pushTaskIds = [...new Set(input.pushTaskIds ?? [])].sort();
    if (pushTaskIds.some((id) => !UUID_RE.test(id))) {
      throw new BadRequestException('pushTaskIds must contain UUIDs');
    }
    const selection = normalizeCompletionEvidence({
      schemaVersion: 1,
      completionCriterion: 'HUMAN_SIGNOFF',
      statusNotIn: ['DONE', 'CANCELLED'],
      evidence: 'LATEST_REVISION',
      terminalReason: null,
      supersededByTaskId: null,
      request: 'MISSING_EXACT_FACT',
      order: 'TASK_ID_ASC',
      concurrency: 'FOR_UPDATE_SKIP_LOCKED',
    }) as JsonObject;
    const inputDigest = completionDigest(normalizeCompletionEvidence({
      ownerId,
      actorType: actor.type,
      actorId: actor.id,
      batchSize: input.batchSize,
      pushTaskIds,
      selection,
    }));
    const batchId = randomUUID();
    const startedAt = new Date();

    const committed = await withTransactionRetry(this.prisma, async (tx) => {
      const replay = await tx.taskJudgmentBackfillBatch.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
      });
      if (replay) {
        if (replay.inputDigest !== inputDigest
          || replay.actorType !== actor.type
          || replay.actorId !== actor.id) {
          throw new ConflictException('idempotencyKey is already bound to a different backfill');
        }
        return backfillResponse(replay);
      }

      const owner = await tx.user.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!owner) throw new NotFoundException('owner not found');
      if (actor.type === CreatorType.USER) {
        if (actor.id !== ownerId) throw new BadRequestException('user backfill actor must be the account owner');
      } else {
        const workspace = await tx.workspace.findFirst({
          where: { id: actor.id, ownerId },
          select: { id: true },
        });
        if (!workspace) throw new BadRequestException('agent backfill actor must belong to the account owner');
      }
      if (pushTaskIds.length > 0) {
        const ownedPushTasks = await tx.task.count({ where: { ownerId, id: { in: pushTaskIds } } });
        if (ownedPushTasks !== pushTaskIds.length) {
          throw new BadRequestException('pushTaskIds must identify tasks owned by this account');
        }
      }

      await tx.taskJudgmentBackfillBatch.create({
        data: {
          id: batchId,
          ownerId,
          actorType: actor.type,
          actorId: actor.id,
          idempotencyKey,
          inputDigest,
          batchSize: input.batchSize,
          pushTaskIds,
          selection: selection as Prisma.InputJsonObject,
          startedAt,
        },
      });

      const candidates = await tx.$queryRaw<BackfillCandidate[]>(Prisma.sql`
        SELECT task."id",
               evidence."id" AS "evidenceId",
               task."title",
               task."project_id" AS "projectId",
               task."completion_criterion"::text AS "completionCriterion",
               task."acceptance_criteria" AS "acceptanceCriteria",
               task."acceptance_command" AS "acceptanceCommand",
               task."acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
               task."completion_policy"::text AS "completionPolicy",
               task."verifies_task_id" AS "verifiesTaskId"
          FROM "task" task
          JOIN LATERAL (
            SELECT current_evidence."id", current_evidence."criterion_revision",
                   current_evidence."evidence_digest"
              FROM "task_completion_evidence" current_evidence
             WHERE current_evidence."task_id" = task."id"
             ORDER BY current_evidence."revision" DESC
             LIMIT 1
          ) evidence ON true
         WHERE task."owner_id" = ${ownerId}::uuid
           AND task."completion_criterion" = 'HUMAN_SIGNOFF'
           AND task."status"::text NOT IN ('DONE', 'CANCELLED')
           AND task."terminal_reason" IS NULL
           AND task."superseded_by_task_id" IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM "task_judgment_request" request
              WHERE request."task_id" = task."id"
                AND request."criterion_revision" = evidence."criterion_revision"
                AND request."evidence_digest" = evidence."evidence_digest"
                AND request."kind" = 'HUMAN_SIGNOFF'
           )
         ORDER BY task."id"
         FOR UPDATE OF task SKIP LOCKED
         LIMIT ${input.batchSize}
      `);

      const pushSet = new Set(pushTaskIds);
      const requestIds: string[] = [];
      for (const candidate of candidates) {
        const evidence = await tx.taskCompletionEvidence.findUniqueOrThrow({
          where: { id: candidate.evidenceId },
          include: evidenceInclude,
        });
        const request = await this.requestForEvidenceFact(tx, candidate.id, evidence, candidate, {
          origin: 'BACKFILL',
          devicePolicy: pushSet.has(candidate.id) ? 'IMMEDIATE' : 'IN_APP_ONLY',
          backfillBatchId: batchId,
        });
        requestIds.push(request.id);
      }

      const inboxCount = requestIds.length === 0 ? 0 : await tx.taskJudgmentInboxItem.count({
        where: { requestId: { in: requestIds } },
      });
      const pushSelectedCount = requestIds.length === 0 ? 0 : await tx.taskJudgmentPushDelivery.count({
        where: { requestId: { in: requestIds }, status: 'PENDING' },
      });
      const pushSuppressedCount = requestIds.length === 0 ? 0 : await tx.taskJudgmentPushDelivery.count({
        where: {
          requestId: { in: requestIds },
          status: 'CANCELLED',
          errorCode: 'POLICY_IN_APP_ONLY',
        },
      });
      const finishedAt = new Date();
      const durationMs = BigInt(Math.max(0, finishedAt.getTime() - startedAt.getTime()));
      const batch = await tx.taskJudgmentBackfillBatch.update({
        where: { id: batchId },
        data: {
          finishedAt,
          scannedCount: candidates.length,
          requestCount: requestIds.length,
          inboxCount,
          pushSelectedCount,
          pushSuppressedCount,
          durationMs,
        },
      });
      return backfillResponse(batch);
    }, loggedRetry(this.logger, 'taskCompletionEvidence.backfill'));

    if (committed.pushSelectedCount > 0) this.deliveries?.kick();
    return committed;
  }

  private async requestForEvidenceFact(
    tx: Prisma.TransactionClient,
    taskId: string,
    evidence: EvidenceRow,
    lockedTask?: LockedCriterionTask,
    options: RequestCreationOptions = {},
  ): Promise<JudgmentRequestRow> {
    const exact = await tx.taskJudgmentRequest.findFirst({
      where: {
        taskId,
        criterionRevision: evidence.criterionRevision,
        evidenceDigest: evidence.evidenceDigest,
        kind: lockedTask?.completionCriterion,
      },
    });
    // Replaying an older fact returns its terminal request. It must never reopen it or supersede
    // the current request merely because delivery order ran backwards.
    if (exact) return exact;

    const task = lockedTask ?? await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: {
        title: true,
        projectId: true,
        completionCriterion: true,
        acceptanceCriteria: true,
        acceptanceCommand: true,
        acceptanceExpectedExitCode: true,
        completionPolicy: true,
        verifiesTaskId: true,
      },
    });
    const requestId = randomUUID();
    const route = routeTaskJudgment(task.completionCriterion as TaskCompletionCriterionValue, {
      ownerId: evidence.ownerId,
      sourceSessionId: evidence.sourceSessionId,
      requestId,
    });
    const createdAt = new Date();
    const request = await tx.taskJudgmentRequest.create({
      data: {
        id: requestId,
        taskId,
        ownerId: evidence.ownerId,
        evidenceId: evidence.id,
        criterionRevision: evidence.criterionRevision,
        evidenceDigest: evidence.evidenceDigest,
        kind: route.kind,
        recipientType: route.recipientType,
        recipientId: route.recipientId,
        origin: options.origin ?? 'LIVE_EVIDENCE',
        devicePolicy: options.devicePolicy ?? 'IMMEDIATE',
        backfillBatchId: options.backfillBatchId,
        createdAt,
      },
    });

    // A substantive new digest replaces every older open question for this task. Criterion kind
    // changes do not leave the old consumer alive either: one evidence version has one owner.
    await tx.taskJudgmentRequest.updateMany({
      where: { taskId, id: { not: request.id }, status: TaskJudgmentRequestStatus.OPEN },
      data: {
        status: TaskJudgmentRequestStatus.SUPERSEDED,
        supersededAt: createdAt,
        supersededById: request.id,
      },
    });

    // Compatibility only. New HUMAN_SIGNOFF blockers/signals are SQL views of this request and
    // are therefore not inserted or independently maintained. Older rows raised by the parked-
    // attempt producer stop being open now that a real judgment path exists.
    if (task.projectId) {
      await tx.projectBlocker.updateMany({
        where: {
          projectId: task.projectId,
          kind: 'HUMAN_DECISION_REQUIRED',
          subjectType: 'TASK',
          subjectId: taskId,
          resolvedAt: null,
        },
        data: { resolvedAt: createdAt, resolvedBy: 'AUTO', updatedAt: createdAt },
      });
    }
    return request;
  }

  async list(ownerId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, ownerId }, select: { id: true } });
    if (!task) throw new NotFoundException('task not found');
    const rows = await this.prisma.taskCompletionEvidence.findMany({
      where: { taskId },
      orderBy: { revision: 'asc' },
      include: evidenceInclude,
    });
    const requests = await this.prisma.taskJudgmentRequest.findMany({ where: { taskId } });
    const byFact = new Map(requests.map((request) => [
      `${request.criterionRevision}:${request.evidenceDigest}`,
      request,
    ]));
    return rows.map((row) => response(
      row,
      byFact.get(`${row.criterionRevision}:${row.evidenceDigest}`)!,
    ));
  }

  async listRequests(ownerId: string, taskId: string): Promise<TaskJudgmentRequestDto[]> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('task not found');
    const requests = await this.prisma.taskJudgmentRequest.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return requests.map(requestResponse);
  }
}
