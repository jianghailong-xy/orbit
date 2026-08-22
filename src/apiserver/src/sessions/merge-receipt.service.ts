import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MERGE_RECEIPT_MAX_CONFLICTS,
  MergeReceiptRecorder,
  MergeReceiptResult,
  MergeReceiptRow,
  mergeReceiptIdempotencyKey,
  mergeReceiptRow,
  mergeStatusForResult,
  normalizeSha,
  resultLanded,
} from './merge-receipt';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

export interface RecordMergeReceiptInput {
  result: MergeReceiptResult;
  sourceBranch?: string | null;
  sourceSha: string;
  targetBranch: string;
  targetShaBefore?: string | null;
  targetShaAfter?: string | null;
  rebaseBaseSha?: string | null;
  conflicts?: string[] | null;
  detail?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

/**
 * The merge receipt writer and reader (contract §13.7).
 *
 * A service of its own rather than four more methods on `SessionsService` (4,000 lines) because
 * everything here is one narrow question — "did this branch land, and can that be re-checked" —
 * and because three different callers write it: the user API, the runner's own merge-result path,
 * and an agent recording a merge it made itself in its worktree.
 *
 * The third caller is the one this exists for. `session.merge_status` is written by exactly one
 * code path, Orbit's Merge button; a branch merged the way these branches actually get merged left
 * that column NULL and `branch_merged` false permanently, so the control plane's honest answer to
 * "did this task's work land" was "no idea". The receipt is the durable record, and the projection
 * below is what makes the existing columns stop lying.
 */
@Injectable()
export class MergeReceiptService {
  private readonly logger = new Logger(MergeReceiptService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Record one merge. Idempotent by MR4's key: the same merge reported twice returns the FIRST
   * receipt with `created: false`, so a retrying caller (or two callers racing) leaves one row.
   *
   * `recordedBy` is provenance and is chosen by the caller's own boundary — an agent cannot claim
   * to be the runner, because the parameter is not in the request body.
   */
  async record(
    ownerId: string,
    sessionId: string,
    input: RecordMergeReceiptInput,
    recordedBy: MergeReceiptRecorder,
    tx?: Prisma.TransactionClient,
  ): Promise<{ receipt: ReturnType<typeof mergeReceiptRow>; created: boolean }> {
    const run = async (db: Prisma.TransactionClient) => {
      const session = await db.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { id: true, branch: true, taskId: true, mergeStatus: true, task: { select: { projectId: true } } },
      });
      if (!session) throw new NotFoundException('session not found');

      const sourceBranch = (input.sourceBranch ?? session.branch ?? '').trim();
      const targetBranch = (input.targetBranch ?? '').trim();
      if (sourceBranch === '') {
        throw new BadRequestException(
          'sourceBranch is required — this session has no recorded branch to fall back to',
        );
      }
      if (targetBranch === '') throw new BadRequestException('targetBranch is required');

      let sourceSha: string | null;
      let targetShaBefore: string | null;
      let targetShaAfter: string | null;
      let rebaseBaseSha: string | null;
      try {
        sourceSha = normalizeSha(input.sourceSha, 'sourceSha');
        targetShaBefore = normalizeSha(input.targetShaBefore, 'targetShaBefore');
        targetShaAfter = normalizeSha(input.targetShaAfter, 'targetShaAfter');
        rebaseBaseSha = normalizeSha(input.rebaseBaseSha, 'rebaseBaseSha');
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      if (!sourceSha) throw new BadRequestException('sourceSha is required');
      // The database says this too (0128's merged_target_check); said here as well so the caller
      // gets the reason rather than a constraint name.
      if (input.result === 'MERGED' && !targetShaAfter) {
        throw new BadRequestException(
          'a MERGED receipt must name targetShaAfter — a merge that cannot say where the target ' +
            'ended up is a claim, not a receipt',
        );
      }
      const conflicts =
        input.result === 'CONFLICT'
          ? (input.conflicts ?? []).map((p) => String(p)).slice(0, MERGE_RECEIPT_MAX_CONFLICTS)
          : [];

      const idempotencyKey =
        (input.idempotencyKey ?? '').trim() ||
        mergeReceiptIdempotencyKey({ sessionId, sourceSha, targetBranch, result: input.result });

      const existing = await db.sessionMergeReceipt.findFirst({
        where: { sessionId, idempotencyKey },
      });
      if (existing) {
        return { receipt: mergeReceiptRow(existing as unknown as MergeReceiptRow), created: false };
      }

      const created = await db.sessionMergeReceipt.create({
        data: {
          ownerId,
          sessionId,
          taskId: session.taskId,
          // Denormalised from the task at write time so a project's acceptance read is one indexed
          // lookup and stays answerable after the task is re-filed or deleted.
          projectId: session.task?.projectId ?? null,
          result: input.result,
          sourceBranch,
          sourceSha,
          targetBranch,
          targetShaBefore,
          targetShaAfter,
          rebaseBaseSha,
          conflicts,
          recordedBy,
          detail: (input.detail ?? {}) as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });

      // Make the columns every client already reads stop being blank (MR5).
      //
      // Skipped while an Orbit merge is in flight: `pending` carries the operation fence the
      // runner echoes back, and overwriting it here would let a receipt cancel a merge that is
      // still running. The receipt is recorded either way — the durable half never depends on
      // whether the transient half could be updated.
      if (session.mergeStatus !== 'pending') {
        const landed = resultLanded(input.result);
        await db.session.update({
          where: { id: sessionId },
          data: {
            mergeStatus: mergeStatusForResult(input.result),
            mergeTarget: targetBranch,
            mergeError: landed ? null : (MergeReceiptService.errorText(input) ?? null),
            mergedAt: landed ? created.createdAt : null,
            ...(landed ? { branchMerged: true, mergedSourceSha: sourceSha } : {}),
          },
        });
      }

      return { receipt: mergeReceiptRow(created as unknown as MergeReceiptRow), created: true };
    };

    if (tx) return run(tx);
    // Retried whole, but only on the branch that OWNS the transaction. When a caller passes `tx`
    // this is part of THEIR unit of work and theirs to re-run — a nested retry would re-run a
    // closure inside a transaction the server has already thrown away. The receipt is keyed by
    // `idempotencyKey`, computed above and outside, so every attempt writes the same row.
    return withTransactionRetry(this.prisma, run, loggedRetry(this.logger, 'sessionMergeReceipt.record'));
  }

  /** One session's receipts, newest first. */
  async list(ownerId: string, sessionId: string, limit = 50) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const rows = await this.prisma.sessionMergeReceipt.findMany({
      where: { sessionId, ownerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return {
      sessionId,
      receipts: rows.map((r) => mergeReceiptRow(r as unknown as MergeReceiptRow)),
      receiptsEmptyReason: rows.length > 0 ? null : ('NO_MERGE_RECORDED' as const),
    };
  }

  /** A receipt for a runner-reported merge outcome, written from inside the runner's own
   *  transaction so a recorded merge and the session state it produced commit together. */
  static async fromRunnerMergeResult(
    tx: Prisma.TransactionClient,
    args: {
      ownerId: string;
      sessionId: string;
      taskId: string | null;
      projectId: string | null;
      result: MergeReceiptResult;
      sourceBranch: string;
      sourceSha: string;
      targetBranch: string;
      targetShaBefore: string | null;
      targetShaAfter: string | null;
      rebaseBaseSha: string | null;
      conflicts: string[];
      message: string | null;
      operationId: string | null;
    },
  ): Promise<void> {
    const idempotencyKey = mergeReceiptIdempotencyKey({
      sessionId: args.sessionId,
      sourceSha: args.sourceSha,
      targetBranch: args.targetBranch,
      result: args.result,
    });
    // createMany + skipDuplicates rather than a find-then-create: the runner retries a merge result
    // on redelivery, and the unique index is the thing that has to decide, not a read that raced.
    await tx.sessionMergeReceipt.createMany({
      data: [
        {
          ownerId: args.ownerId,
          sessionId: args.sessionId,
          taskId: args.taskId,
          projectId: args.projectId,
          result: args.result,
          sourceBranch: args.sourceBranch,
          sourceSha: args.sourceSha,
          targetBranch: args.targetBranch,
          targetShaBefore: args.targetShaBefore,
          targetShaAfter: args.targetShaAfter,
          rebaseBaseSha: args.rebaseBaseSha,
          // 0128 refuses paths on any non-CONFLICT result: a merge that succeeded has none, and a
          // list attached to one would be a leftover from the attempt before it.
          conflicts: args.result === 'CONFLICT'
            ? args.conflicts.slice(0, MERGE_RECEIPT_MAX_CONFLICTS)
            : [],
          recordedBy: 'RUNNER',
          detail: {
            source: 'merge-result',
            ...(args.message ? { message: args.message } : {}),
            ...(args.operationId ? { operationId: args.operationId } : {}),
          } as Prisma.InputJsonValue,
          idempotencyKey,
        },
      ],
      skipDuplicates: true,
    });
  }

  private static errorText(input: RecordMergeReceiptInput): string | null {
    const detail = input.detail ?? {};
    const message = (detail as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    if (input.result === 'CONFLICT' && (input.conflicts ?? []).length > 0) {
      return `conflict in ${(input.conflicts ?? []).length} path(s)`;
    }
    return null;
  }

}
