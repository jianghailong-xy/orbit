import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { TaskCompletionEvidenceDto } from './dto';

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
  };
}

/** N10's append-only completion-evidence ledger. It never writes Task or Session lifecycle state. */
@Injectable()
export class TaskCompletionEvidenceService {
  private readonly logger = new Logger(TaskCompletionEvidenceService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    return withTransactionRetry(this.prisma, async (tx) => {
      // One Task mutex serialises revision allocation, stable-fact dedupe and retry-key binding.
      const [task] = await tx.$queryRaw<LockedCriterionTask[]>(Prisma.sql`
        SELECT "acceptance_criteria" AS "acceptanceCriteria",
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
          return response(replay.evidence);
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
      return response(evidence);
    }, loggedRetry(this.logger, 'taskCompletionEvidence.submit'));
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
