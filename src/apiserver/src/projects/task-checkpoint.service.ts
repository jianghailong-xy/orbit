/**
 * `[K6]`: the one door a checkpoint comes through, and the reads the two merge gates stand on.
 *
 * `[K5]`'s finding service files a finding and its one consequence in one transaction because a
 * half-landed pair is worse than neither. A checkpoint is simpler and its transaction is small on
 * purpose: it writes one immutable row and nothing else. What it must NOT do is the thing that
 * makes a checkpoint worthless — decide its own kind from what the caller asserts. `planCheckpoint`
 * derives §7's kind from the evidence, this service supplies the task's CURRENT scope revision to
 * compare against, and migration 0152 refuses the shapes both of them could still get wrong.
 *
 * The reads matter as much as the write. "The latest accepted checkpoint" is the baseline every
 * later task starts from (§7's third column) and the value both gates are decided against, so it
 * is one indexed read ordered by `seq` — never by a clock two writers can tie on, and never
 * including a `WIP_RED` row, which is the whole of "可否成为后续任务的基线 = 否".
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { ScopeActor } from './convergence-contract';
import {
  CheckpointArtifact,
  CheckpointCommit,
  CheckpointKind,
  CheckpointRecordRefusal,
  CheckpointTestEvidence,
  MergeGateCheckpoint,
  MergeGateDecision,
  ReportedLandingDecision,
  authorizeReportedLanding,
  decideMergeGate,
  landedVerdict,
  planCheckpoint,
} from './task-checkpoint';

export interface RecordCheckpointInput {
  ownerId: string;
  taskId: string;
  /** FD4: the revision the recorder measured against. Compared with the task's, never trusted. */
  scopeRevision: number;
  commit: CheckpointCommit;
  evidence: CheckpointTestEvidence | null;
  artifact: CheckpointArtifact | null;
  recordedBy: ScopeActor;
  sessionId?: string | null;
  attemptId?: string | null;
}

export interface RecordCheckpointResult {
  checkpointId: string;
  kind: CheckpointKind;
  seq: number;
  /** True when CP1's content key already existed: nothing was written, and this is the original. */
  duplicate: boolean;
}

/** One checkpoint as every reader sees it. */
export interface CheckpointRow {
  id: string;
  taskId: string;
  projectId: string | null;
  seq: number;
  kind: CheckpointKind;
  scopeRevision: number;
  branch: string;
  commitSha: string;
  treeSha: string;
  baseSha: string;
  evidenceDigest: string | null;
  testEvidence: unknown;
  artifactKind: string | null;
  artifactRef: string | null;
  artifactDigest: string | null;
  contentDigest: string;
  recordedBy: string;
  sessionId: string | null;
  attemptId: string | null;
  createdAt: Date;
}

/**
 * What the API server can decide about a merge BEFORE anything touches a repository.
 *
 * `ALREADY_LANDED` is not one of §7's answers and is deliberately not a refusal: it is the answer
 * to a different question. §0's sibling incident is a merge that was requested twice — once by the
 * agent that performed it itself with a fast-forward, once by a click afterwards — and the second
 * request replayed twenty-two commits onto a target that already contained every one of them. The
 * only correct response to "merge work that is already there" is to hand back the receipt that says
 * so, and the expensive part of getting that wrong is that nothing about it looks wrong: the
 * conflicts it produces are real conflicts between a commit and itself.
 */
export type MergeDispatchDecision =
  | { decision: 'ALLOWED'; checkpointId: string | null; sourceSha: string | null }
  | { decision: 'ALREADY_LANDED'; receiptId: string; sourceSha: string; targetSha: string | null }
  | (MergeGateDecision & { decision: Exclude<MergeGateDecision['decision'], 'ALLOWED'> });

@Injectable()
export class TaskCheckpointService {
  private readonly logger = new Logger(TaskCheckpointService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: ConvergenceLedgerService,
  ) {}

  /**
   * §7 in, one immutable row out.
   *
   * The order inside the transaction is `[K2]`'s order, for `[K2]`'s reasons:
   *
   *  1. lock the task, which serialises every writer on it and makes step 3 a decision rather than
   *     a guess — the SAME rank-50 lock the ledger and the finding take, so a checkpoint can never
   *     interleave with a judgment about the task it belongs to;
   *  2. put the task under management if it is not already, so the composite foreign key has a
   *     revision row to point at. Without it the failure reads as a constraint violation rather
   *     than as "this task has no ledger yet";
   *  3. plan against the revision just read. The KIND comes out of the evidence here, never from
   *     the caller;
   *  4. look CP1's content key up. A redelivery, a takeover or a retry after a lost response
   *     returns the committed row having written nothing;
   *  5. insert, allocating `seq` as MAX + 1 under the lock taken in step 1.
   */
  async record(input: RecordCheckpointInput): Promise<RecordCheckpointResult | CheckpointRecordRefusal> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const state = await this.ledger.lockAndRead(tx, input.taskId, input.ownerId);
      if (!state.managed) {
        await this.ledger.ensureBaseline(tx, input.taskId, input.ownerId);
      }
      const [task] = await tx.$queryRaw<Array<{ projectId: string | null; scopeRevision: number; scopeHash: string }>>(
        Prisma.sql`
          SELECT t."project_id" AS "projectId",
                 t."scope_revision" AS "scopeRevision",
                 r."scope_hash" AS "scopeHash"
            FROM "task" t
            JOIN "task_scope_revision" r
              ON r."task_id" = t."id" AND r."revision" = t."scope_revision"
           WHERE t."id" = ${input.taskId}::uuid AND t."owner_id" = ${input.ownerId}::uuid
        `,
      );
      if (!task) return 'SCOPE_REVISION_MISMATCH' as const;

      const planned = planCheckpoint(
        {
          // A task filed outside any project still needs a project-scoped key; the owner is the
          // widest scope it has, and it is stable. Same substitution `[K5]`'s finding key makes.
          projectId: task.projectId ?? input.ownerId,
          taskId: input.taskId,
          scopeRevision: input.scopeRevision,
          commit: input.commit,
          evidence: input.evidence,
          artifact: input.artifact,
        },
        task.scopeRevision,
      );
      if (typeof planned === 'string') return planned;

      const [existing] = await tx.$queryRaw<Array<{ id: string; kind: string; seq: bigint }>>(
        Prisma.sql`
          SELECT "id", "kind", "seq" FROM "task_checkpoint" WHERE "dedup_key" = ${planned.dedupKey}
        `,
      );
      if (existing) {
        return {
          checkpointId: existing.id,
          kind: existing.kind as CheckpointKind,
          seq: Number(existing.seq),
          duplicate: true,
        };
      }

      const [next] = await tx.$queryRaw<Array<{ next: bigint }>>(Prisma.sql`
        SELECT coalesce(max("seq"), 0) + 1 AS "next"
          FROM "task_checkpoint" WHERE "task_id" = ${input.taskId}::uuid
      `);
      const seq = Number(next?.next ?? 1n);
      const [row] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "task_checkpoint" (
          "id", "task_id", "owner_id", "project_id", "seq",
          "scope_revision", "scope_hash", "kind",
          "branch", "commit_sha", "tree_sha", "base_sha",
          "evidence_digest", "test_evidence",
          "artifact_kind", "artifact_ref", "artifact_digest",
          "content_digest", "dedup_key", "recorded_by", "session_id", "attempt_id"
        ) VALUES (
          gen_random_uuid(), ${input.taskId}::uuid, ${input.ownerId}::uuid,
          ${task.projectId}::uuid, ${seq},
          ${task.scopeRevision}, ${task.scopeHash}, ${planned.kind},
          ${planned.commit.branch}, ${planned.commit.commitSha},
          ${planned.commit.treeSha}, ${planned.commit.baseSha},
          ${planned.evidenceDigest},
          ${planned.evidence === null ? null : (planned.evidence as unknown as Prisma.InputJsonValue)}::jsonb,
          ${planned.artifact?.kind ?? null}, ${planned.artifact?.ref ?? null},
          ${planned.artifact?.digest ?? null},
          ${planned.contentDigest}, ${planned.dedupKey}, ${input.recordedBy},
          ${input.sessionId ?? null}::uuid, ${input.attemptId ?? null}::uuid
        )
        RETURNING "id"
      `);
      return { checkpointId: row.id, kind: planned.kind, seq, duplicate: false };
    }, loggedRetry(this.logger, 'taskCheckpoint.record'));
  }

  /**
   * §7's third column: the baseline a later task may start from.
   *
   * Ordered by `seq` and filtered to `ACCEPTED` in the same statement, because those are the two
   * halves of one rule. Dropping the filter makes a red experiment the next task's starting point;
   * ordering by `createdAt` instead lets two checkpoints written in the same millisecond disagree
   * about which is latest, and the whole rule is the word "latest".
   */
  async latestAccepted(
    db: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    taskId: string,
  ): Promise<CheckpointRow | null> {
    return latestAcceptedCheckpoint(db, ownerId, taskId);
  }

  /** Every checkpoint of a task, newest first — the read the control surface and an audit share. */
  async list(ownerId: string, taskId: string, limit = 50): Promise<CheckpointRow[]> {
    const rows = await this.prisma.$queryRaw<Array<CheckpointDbRow>>(Prisma.sql`
      ${CHECKPOINT_SELECT}
       WHERE "task_id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
       ORDER BY "seq" DESC
       LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `);
    return rows.map(checkpointRow);
  }

  /**
   * The dispatch gate: everything that can be decided about a merge before a repository is touched.
   *
   * Two questions, in this order, and the order is the point. "Is it already there" comes FIRST,
   * because a source the target already contains needs no checkpoint, no evidence and no scope
   * comparison — there is nothing to merge, and every refusal below would be answering a question
   * nobody is asking. §0's sibling incident is exactly this order being absent: the request went
   * straight to a rebase from a base recorded days earlier.
   *
   * What it deliberately does NOT judge is `BRANCH_TIP_MISMATCH` and `TEST_EVIDENCE_MISMATCH`. The
   * API server has no repository and cannot see the branch tip, and a gate that guessed there would
   * be refusing on a value it made up. Those two are decided where the tip is a fact: by the runner,
   * against `requiredSourceSha`, and by `MergeReceiptService` when a caller claims a landing and
   * names the commit it landed.
   */
  async dispatchGate(
    db: Prisma.TransactionClient | PrismaService,
    args: { ownerId: string; sessionId: string; taskId: string | null; targetBranch: string },
  ): Promise<MergeDispatchDecision> {
    return mergeDispatchGate(db, args);
  }

  /**
   * The gate a caller that CLAIMS a landing is held to, where the commit is a stated fact.
   *
   * Returns `null` when §7 has no opinion — an unmanaged task, which is almost every merge. The
   * caller is refused only for a LANDED claim: a `CONFLICT` or an `ERROR` about a commit that
   * should never have been merged is still the truth about an attempt somebody made, and a gate
   * that swallowed it would delete the audit of the thing it exists to prevent.
   */
  async landingGate(
    db: Prisma.TransactionClient | PrismaService,
    args: {
      ownerId: string;
      taskId: string | null;
      sourceSha: string;
      evidenceDigest?: string | null;
    },
  ): Promise<MergeGateDecision | null> {
    return checkpointLandingGate(db, args);
  }

  /**
   * Is this task under convergence management at all?
   *
   * The same test `[K2]` defines: a task is managed exactly when it has a scope revision row. Every
   * task filed before this contract has none and is unaffected by all of it (project AC11).
   */
  private async managedTask(
    db: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    taskId: string,
  ): Promise<{ scopeRevision: number } | null> {
    return managedTaskRevision(db, ownerId, taskId);
  }
}

function gateShape(row: CheckpointRow): MergeGateCheckpoint {
  return {
    id: row.id,
    kind: row.kind,
    scopeRevision: row.scopeRevision,
    commitSha: row.commitSha,
    evidenceDigest: row.evidenceDigest,
  };
}

const CHECKPOINT_SELECT = Prisma.sql`
  SELECT "id", "task_id" AS "taskId", "project_id" AS "projectId", "seq", "kind",
         "scope_revision" AS "scopeRevision", "branch",
         "commit_sha" AS "commitSha", "tree_sha" AS "treeSha", "base_sha" AS "baseSha",
         "evidence_digest" AS "evidenceDigest", "test_evidence" AS "testEvidence",
         "artifact_kind" AS "artifactKind", "artifact_ref" AS "artifactRef",
         "artifact_digest" AS "artifactDigest", "content_digest" AS "contentDigest",
         "recorded_by" AS "recordedBy", "session_id" AS "sessionId",
         "attempt_id" AS "attemptId", "created_at" AS "createdAt"
    FROM "task_checkpoint"
`;

interface CheckpointDbRow extends Omit<CheckpointRow, 'seq' | 'kind'> {
  seq: bigint;
  kind: string;
}

function checkpointRow(row: CheckpointDbRow): CheckpointRow {
  return { ...row, seq: Number(row.seq), kind: row.kind as CheckpointKind };
}

/**
 * The §7 checkpoint a commit IS, if the control plane recorded one for it.
 *
 * A free function rather than a method because both merge-receipt writers need it and one of them
 * is static — the runner's path writes inside the transaction that also settles the session, and
 * giving it a service dependency would mean threading the container through a code path whose whole
 * value is that it commits with its caller.
 *
 * Joined on the COMMIT, which is the honest join: a receipt's `sourceSha` and a checkpoint's
 * `commitSha` are the same object name or they are about different work. Returns the newest, since
 * the same commit can be checkpointed twice — once red, then accepted once the suite went green.
 */
export async function checkpointIdForCommit(
  tx: Prisma.TransactionClient,
  args: { ownerId: string; taskId: string | null; commitSha: string | null },
): Promise<string | null> {
  if (!args.taskId || !args.commitSha) return null;
  const [row] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "task_checkpoint"
     WHERE "task_id" = ${args.taskId}::uuid
       AND "owner_id" = ${args.ownerId}::uuid
       AND "commit_sha" = ${args.commitSha}
       AND "kind" = 'ACCEPTED'
     ORDER BY "seq" DESC
     LIMIT 1
  `);
  return row?.id ?? null;
}

/** §7's third column as one indexed read: the latest ACCEPTED checkpoint, ordered by `seq`. */
export async function latestAcceptedCheckpoint(
  db: Prisma.TransactionClient | PrismaService,
  ownerId: string,
  taskId: string,
): Promise<CheckpointRow | null> {
  const [row] = await db.$queryRaw<Array<CheckpointDbRow>>(Prisma.sql`
    ${CHECKPOINT_SELECT}
     WHERE "task_id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid AND "kind" = 'ACCEPTED'
     ORDER BY "seq" DESC
     LIMIT 1
  `);
  return row ? checkpointRow(row) : null;
}

/** `[K2]`'s own test for "is this task under convergence management": does it have a revision row. */
export async function managedTaskRevision(
  db: Prisma.TransactionClient | PrismaService,
  ownerId: string,
  taskId: string,
): Promise<{ scopeRevision: number } | null> {
  const [row] = await db.$queryRaw<Array<{ scopeRevision: number }>>(Prisma.sql`
    SELECT t."scope_revision" AS "scopeRevision"
      FROM "task" t
      JOIN "task_scope_revision" r
        ON r."task_id" = t."id" AND r."revision" = t."scope_revision"
     WHERE t."id" = ${taskId}::uuid AND t."owner_id" = ${ownerId}::uuid
  `);
  return row ?? null;
}

/**
 * §7 CP3 against a stated commit — the gate a caller CLAIMING a landing is held to.
 *
 * A free function for the same reason `checkpointIdForCommit` is one: the merge-receipt writer
 * lives in the sessions module and must not take a dependency on the projects module to ask a
 * question that is three reads and a pure decision.
 *
 * `null` means §7 has no opinion: the task is not under convergence management, which is almost
 * every merge Orbit records (project AC11).
 */
export async function checkpointLandingGate(
  db: Prisma.TransactionClient | PrismaService,
  args: {
    ownerId: string;
    taskId: string | null;
    sourceSha: string;
    evidenceDigest?: string | null;
  },
): Promise<MergeGateDecision | null> {
  if (!args.taskId) return null;
  const task = await managedTaskRevision(db, args.ownerId, args.taskId);
  if (!task) return null;
  const checkpoint = await latestAcceptedCheckpoint(db, args.ownerId, args.taskId);
  return decideMergeGate(checkpoint ? gateShape(checkpoint) : null, {
    branchTipSha: args.sourceSha,
    taskScopeRevision: task.scopeRevision,
    evidenceDigest: args.evidenceDigest ?? null,
  });
}

export async function mergeDispatchGate(
  db: Prisma.TransactionClient | PrismaService,
  args: { ownerId: string; sessionId: string; taskId: string | null; targetBranch: string },
): Promise<MergeDispatchDecision> {
  const checkpoint = args.taskId ? await latestAcceptedCheckpoint(db, args.ownerId, args.taskId) : null;
  const task = args.taskId ? await managedTaskRevision(db, args.ownerId, args.taskId) : null;

  // The frozen full source SHA, from committed facts only: the verified commit when the work is
  // under convergence management, else the tip the last merge of this session froze.
  const [session] = await db.$queryRaw<Array<{ mergedSourceSha: string | null; branchMerged: boolean | null }>>(
    Prisma.sql`
      SELECT "merged_source_sha" AS "mergedSourceSha", "branch_merged" AS "branchMerged"
        FROM "session" WHERE "id" = ${args.sessionId}::uuid AND "owner_id" = ${args.ownerId}::uuid
    `,
  );
  const frozen =
    checkpoint?.commitSha ??
    (session?.branchMerged === true ? (session.mergedSourceSha ?? null) : null);

  if (frozen) {
    const [landed] = await db.$queryRaw<Array<{ id: string; targetShaAfter: string | null }>>(
      Prisma.sql`
        SELECT "id", "target_sha_after" AS "targetShaAfter"
          FROM "session_merge_receipt"
         WHERE "session_id" = ${args.sessionId}::uuid
           AND "owner_id" = ${args.ownerId}::uuid
           AND "target_branch" = ${args.targetBranch}
           AND "source_sha" = ${frozen}
           AND "result" IN ('MERGED', 'ALREADY_MERGED')
         ORDER BY "created_at" DESC, "id" DESC
         LIMIT 1
      `,
    );
    // A landed receipt naming this exact source in this exact target IS the proof the target
    // contains it — `targetShaAfter` is where the target stood once it did.
    if (landed && landedVerdict(frozen, landed.targetShaAfter, true) !== 'NOT_LANDED') {
      return {
        decision: 'ALREADY_LANDED',
        receiptId: landed.id,
        sourceSha: frozen,
        targetSha: landed.targetShaAfter,
      };
    }
  }

  // Not under convergence management: §7 has nothing to say, and project AC11 says such a
  // session keeps behaving exactly as it always did.
  if (!task) return { decision: 'ALLOWED', checkpointId: null, sourceSha: frozen };

  const gate = decideMergeGate(checkpoint ? gateShape(checkpoint) : null, {
    // The tip is unknown here, so the checkpoint's own commit is passed and the tip comparison is
    // vacuous BY CONSTRUCTION rather than by accident — see the method comment.
    branchTipSha: checkpoint?.commitSha ?? '',
    taskScopeRevision: task.scopeRevision,
    evidenceDigest: null,
  });
  if (gate.decision === 'ALLOWED') {
    return { decision: 'ALLOWED', checkpointId: gate.checkpointId, sourceSha: checkpoint?.commitSha ?? null };
  }
  return gate as MergeDispatchDecision;
}

/**
 * The server's own expectation for a reported landing, read inside the caller's transaction.
 *
 * `mergeCheckpointId` is what `mergeToMain` persisted when it authorised the operation, and it is
 * preferred over anything re-derived: re-reading "the latest accepted checkpoint" at result time
 * would judge the merge against work recorded AFTER it was dispatched. It is null only for an
 * operation queued by a build that predates this column, and then the current baseline is the
 * closest honest expectation — still fail-closed, because a managed task with no accepted
 * checkpoint refuses rather than waves through.
 */
export async function reportedLandingAuthority(
  db: Prisma.TransactionClient | PrismaService,
  args: {
    ownerId: string;
    taskId: string | null;
    mergeCheckpointId: string | null;
    sourceSha: string | null;
  },
): Promise<ReportedLandingDecision> {
  if (!args.taskId) return { decision: 'ALLOWED', checkpointId: null };
  const managed = (await managedTaskRevision(db, args.ownerId, args.taskId)) !== null;
  if (!managed) return { decision: 'ALLOWED', checkpointId: null };

  let expected: { id: string; kind: CheckpointKind; commitSha: string } | null = null;
  if (args.mergeCheckpointId) {
    const [row] = await db.$queryRaw<Array<{ id: string; kind: string; commitSha: string }>>(
      Prisma.sql`
        SELECT "id", "kind", "commit_sha" AS "commitSha" FROM "task_checkpoint"
         WHERE "id" = ${args.mergeCheckpointId}::uuid AND "owner_id" = ${args.ownerId}::uuid
      `,
    );
    expected = row ? { id: row.id, kind: row.kind as CheckpointKind, commitSha: row.commitSha } : null;
  } else {
    const latest = await latestAcceptedCheckpoint(db, args.ownerId, args.taskId);
    expected = latest ? { id: latest.id, kind: latest.kind, commitSha: latest.commitSha } : null;
  }
  return authorizeReportedLanding(expected, managed, args.sourceSha);
}
