import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CreatorType, Prisma, TaskJudgmentRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { TaskCompletionEvidenceDto, TaskJudgmentRequestDto } from './dto';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';
import { routeTaskJudgment } from './task-judgment-request';
import { TasksService } from './tasks.service';
import { JudgmentDeliveryService } from '../push/judgment-delivery.service';

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
} satisfies Prisma.TaskCompletionEvidenceInclude;

type EvidenceRow = Prisma.TaskCompletionEvidenceGetPayload<{ include: typeof evidenceInclude }>;

type JudgmentRequestRow = Prisma.TaskJudgmentRequestGetPayload<Record<string, never>>;

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
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedByType: row.decidedByType,
    decidedById: row.decidedById,
    decision: row.decision,
    supersededAt: row.supersededAt,
    supersededById: row.supersededById,
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
          const request = await this.requestForEvidenceFact(tx, taskId, replay.evidence);
          return { evidence: response(replay.evidence, request), request };
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
      return { evidence: response(evidence, request), request };
    }, loggedRetry(this.logger, 'taskCompletionEvidence.submit'));

    // VERIFICATION owns a distinct task whose id is the request id. Filing/dispatch is after the
    // evidence transaction so a runner failure cannot erase the request; a replay converges on the
    // same deterministic task instead of minting another one.
    if (committed.request.kind === 'VERIFICATION' && this.tasks) {
      // File the new carrier first. Retiring old carriers afterwards means a project never has a
      // transient "all verifier tasks settled" view between evidence versions. Both operations
      // are replay-safe: the carrier id is the request id, and retirement writes CANCELLED only
      // to tasks whose durable request is already SUPERSEDED.
      if (committed.request.status === TaskJudgmentRequestStatus.OPEN) {
        await this.tasks.ensureJudgmentVerification(
          ownerId,
          taskId,
          committed.request.id,
          committed.request.evidenceDigest,
        );
      }
      await this.tasks.retireSupersededJudgmentVerifications(ownerId, taskId);
    }
    if (committed.request.kind === 'HUMAN_SIGNOFF'
      && committed.request.status === TaskJudgmentRequestStatus.OPEN) {
      // The trigger already committed the inbox/outbox rows. This is only the low-latency nudge;
      // startup recovery and the persisted nextAttemptAt remain the guarantee if this process dies
      // between COMMIT and this line.
      this.deliveries?.kick();
    }
    return committed.evidence;
  }

  private async requestForEvidenceFact(
    tx: Prisma.TransactionClient,
    taskId: string,
    evidence: EvidenceRow,
    lockedTask?: LockedCriterionTask,
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
