/**
 * Unit L4: the one place a cross-project crossing is asked about, answered and spent.
 *
 * `project-handoff.ts` decides the rules; this is the only code that reads or writes the row they
 * are about. Everything here is fail-closed and owner-scoped: a project the caller does not own is
 * not "not open", it is not there, and a crossing naming it is refused before any world is read.
 *
 * THE ROW IS THE AUTHORITY, SO EVERY PATH RE-DERIVES IT
 * ----------------------------------------------------
 * A lookup by key is not a proof of authority. `crossing_key` is unique per owner, and a row can
 * arrive under one from somewhere this code did not write it — a repair script, a mixed-version
 * binary, a restored backup, a raw INSERT. So every path that is about to TREAT a row as authority
 * checks the whole canonical tuple against what the caller is actually doing (`assertAuthority`),
 * and checks the row against ITSELF: a row whose columns do not reproduce the key it is filed under
 * was not written by this contract, and it is refused rather than obeyed. That is the same
 * discipline `TasksService.idempotencyWinner` applies to an idempotency key, for the same reason —
 * the paths a fault or an attacker can reach on purpose are exactly the ones a happy path skips.
 *
 * THE THREE MOMENTS
 * -----------------
 *   - **declare** files the question, in ONE transaction that takes the owner row, then both
 *     project rows sorted, then reads and writes the approval. The policy that decides WHO may
 *     accept is re-derived under those locks and the coordinator generation is re-checked there,
 *     so a project switched to GUARDED_AUTO, accepted, or rotated between the read and the insert
 *     cannot be auto-accepted by a decision made against the world before it moved.
 *   - **decide** is the user's, and only the user's (§7 RB2 — the target project's coordinator is
 *     not the approver). A compare-and-set on the state it was read in, so two clicks produce one
 *     answer and one 409 rather than an answer that depends on timing. Re-approving a live yes
 *     writes nothing at all: it is a stable read-back, not a second decision, so nobody can extend
 *     their own deadline by clicking approve again.
 *   - **spend** runs INSIDE the caller's transaction as one compare-and-set that pins every column
 *     of the authority tuple. A second application updates no row and throws, which aborts the
 *     caller's transaction and takes the task it was about to write with it. That is exactly-once
 *     expressed as a property of the row rather than as a sequence somebody has to get right.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { uuidToBase62 } from '@orbit/shared';

import { orderedIds } from '../common/lock-order';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  HANDOFF_APPROVAL_TTL_MS,
  decideHandoffAcceptance,
  handoffApprovalOf,
  handoffDependentDigest,
  handoffCrossingKey,
  handoffPayloadDigest,
  nextHandoffState,
  sessionTriggerEvent,
  type HandoffAcceptanceDecision,
  type HandoffKind,
  type HandoffRequestIdentity,
  type HandoffStoredState,
} from './project-handoff';
import type { HandoffApproval } from './project-scope-decision';

/** The columns every read below needs. Spelled once so no caller invents a narrower read. */
const HANDOFF_SELECT = {
  id: true,
  ownerId: true,
  fromProjectId: true,
  toProjectId: true,
  kind: true,
  subjectTaskId: true,
  payloadDigest: true,
  crossingKey: true,
  state: true,
  title: true,
  reason: true,
  requestedBySessionId: true,
  requestedAt: true,
  decidedBy: true,
  decidedByUserId: true,
  decidedAt: true,
  expiresAt: true,
  appliedTaskId: true,
  appliedAt: true,
} as const;

export interface HandoffRow {
  id: string;
  ownerId: string;
  fromProjectId: string;
  toProjectId: string;
  kind: string;
  subjectTaskId: string | null;
  payloadDigest: string;
  crossingKey: string;
  state: string;
  title: string;
  reason: string | null;
  requestedBySessionId: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  appliedTaskId: string | null;
  appliedAt: Date | null;
}

/**
 * Everything that has to be true of a row before it may authorise anything.
 *
 * Not a subset and not a convenience: `crossing_key` alone is a lookup, and a lookup that returned
 * a row with another `from`, another `kind` or another asker would be an authorization derived from
 * a hash collision, a legacy row or a forgery.
 */
export interface HandoffAuthority {
  ownerId: string;
  fromProjectId: string;
  toProjectId: string;
  kind: HandoffKind;
  subjectTaskId: string | null;
  payloadDigest: string;
  crossingKey: string;
  /** The session that asked — the same session the source evidence in the digest names. */
  requestedBySessionId: string;
}

/** What a crossing IS, before it is looked up or filed. */
export interface HandoffDeclaration {
  fromProjectId: string;
  toProjectId: string;
  kind: HandoffKind;
  subjectTaskId: string | null;
  /**
   * DEPEND_ON_TASK only: the task being made to WAIT, when it already exists. Null when this plan
   * is about to create it — then `identity` is what names it, which is why the digest binds the
   * dependent's whole plan rather than a row id that does not exist yet.
   */
  dependentTaskId?: string | null;
  /** Every field of the write this answer would authorise, plus where the work was noticed. */
  identity: HandoffRequestIdentity;
  /** Display only. */
  title: string;
  reason?: string | null;
  requestedBySessionId: string;
}

/**
 * The coordination scope the declaring session held when the caller admitted this write.
 *
 * Presented, not trusted — exactly as §2 SC3 says a scope token is. It is re-derived under the
 * project lock inside `declare`, so a rotation that commits between the caller's admission and the
 * insert refuses the declaration instead of filing a question in the name of a scope that has moved.
 */
export interface HandoffScopeClaim {
  projectId: string;
  generation: string;
}

export interface HandoffAnswer {
  row: HandoffRow;
  /** The same row, in the shape L1's decision function reads. */
  approval: HandoffApproval;
  /** True when this call is what filed the question. */
  filed: boolean;
}

/** A read client: the plain Prisma service, or the caller's transaction. */
type HandoffReadClient = Pick<Prisma.TransactionClient, 'projectHandoffApproval'>;

@Injectable()
export class ProjectHandoffService {
  private readonly log = new Logger(ProjectHandoffService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The canonical authority tuple of a declaration, as everything below spells it. */
  authorityOf(ownerId: string, declaration: HandoffDeclaration): HandoffAuthority {
    // A dependency's payload is WHO is being made to wait — by id when that task exists, by its
    // whole plan when this batch is about to create it. Everything else is filed or moved, and its
    // payload is the plan itself. Two digests because they answer two different questions, one
    // function because both have to be recomputed identically at the moment the yes is spent.
    const payloadDigest = declaration.kind === 'DEPEND_ON_TASK'
      ? handoffDependentDigest({
          taskId: declaration.dependentTaskId ?? null,
          identity: declaration.identity,
        })
      : handoffPayloadDigest(declaration.identity);
    return {
      ownerId,
      fromProjectId: declaration.fromProjectId,
      toProjectId: declaration.toProjectId,
      kind: declaration.kind,
      subjectTaskId: declaration.subjectTaskId,
      payloadDigest,
      crossingKey: handoffCrossingKey({
        ownerId,
        fromProjectId: declaration.fromProjectId,
        toProjectId: declaration.toProjectId,
        kind: declaration.kind,
        subjectTaskId: declaration.subjectTaskId,
        payloadDigest,
      }),
      requestedBySessionId: declaration.requestedBySessionId,
    };
  }

  /**
   * A row is refused unless it reproduces the key it is filed under.
   *
   * Says nothing about the row it refused beyond the SHAPE of the disagreement: the caller has not
   * been shown to be entitled to it, and naming its ends or its asker would leak exactly what this
   * branch exists to protect (the same rule `idempotencyWinner` follows).
   */
  private assertSelfConsistent(row: HandoffRow): void {
    const rebuilt = handoffCrossingKey({
      ownerId: row.ownerId,
      fromProjectId: row.fromProjectId,
      toProjectId: row.toProjectId,
      kind: row.kind as HandoffKind,
      subjectTaskId: row.subjectTaskId,
      payloadDigest: row.payloadDigest,
    });
    if (rebuilt !== row.crossingKey) {
      throw new ConflictException(
        `handoff approval ${uuidToBase62(row.id)} does not describe the crossing it is filed under `
        + '— it was not written by this contract and authorises nothing; nothing was written',
      );
    }
  }

  /** The row, checked against what the caller is actually about to do. */
  private assertAuthority(row: HandoffRow, expected: HandoffAuthority): void {
    this.assertSelfConsistent(row);
    const mismatch = (why: string): never => {
      throw new ConflictException(
        `handoff approval ${uuidToBase62(row.id)} is an answer about a different crossing (${why}) `
        + '— nothing was written; declare this crossing and ask for it',
      );
    };
    if (row.ownerId !== expected.ownerId) mismatch('different account');
    if (row.fromProjectId !== expected.fromProjectId) mismatch('different source project');
    if (row.toProjectId !== expected.toProjectId) mismatch('different target project');
    if (row.kind !== expected.kind) mismatch('different kind of crossing');
    if ((row.subjectTaskId ?? null) !== (expected.subjectTaskId ?? null)) mismatch('different subject');
    if (row.payloadDigest !== expected.payloadDigest) mismatch('different plan or source');
    if (row.crossingKey !== expected.crossingKey) mismatch('different crossing');
    if (row.requestedBySessionId !== expected.requestedBySessionId) mismatch('different asker');
  }

  private answerOf(row: HandoffRow, now: Date, filed = false): HandoffAnswer {
    return {
      row,
      approval: handoffApprovalOf(
        {
          fromProjectId: row.fromProjectId,
          toProjectId: row.toProjectId,
          kind: row.kind as HandoffKind,
          subjectTaskId: row.subjectTaskId,
          state: row.state as HandoffStoredState,
          expiresAt: row.expiresAt,
          appliedTaskId: row.appliedTaskId,
        },
        now,
      ),
      filed,
    };
  }

  /**
   * The answer that exists for a crossing, or null — verified against the full authority tuple.
   *
   * `db` so a caller can ask inside its own transaction, where the answer has to be the one its
   * writes will see.
   */
  async answerFor(
    db: HandoffReadClient,
    authority: HandoffAuthority,
    now: Date,
  ): Promise<HandoffAnswer | null> {
    const row = (await db.projectHandoffApproval.findFirst({
      where: { ownerId: authority.ownerId, crossingKey: authority.crossingKey },
      select: HANDOFF_SELECT,
    })) as HandoffRow | null;
    if (!row) return null;
    this.assertAuthority(row, authority);
    return this.answerOf(row, now);
  }

  /**
   * File the question, or find the one already standing.
   *
   * ONE transaction, and every fact it decides on is DERIVED inside it from rows this server owns.
   * That is the correction that matters: a declaration arrives as a claim about who is asking, which
   * project the work is leaving, which task it was noticed on and which event filed it — and a claim
   * is exactly what the incident behind this whole unit was made of. Binding those four into the
   * payload digest makes them tamper-evident BETWEEN the question and the answer; it does not make
   * them true. So none of them is believed here. Each is re-derived from the session row, the
   * project rows and the task rows read under the locks below, and the submitted value is only ever
   * COMPARED — a mismatch is a refusal with nothing written, not a correction.
   *
   * Concretely, this is what stops the coordinator of a third project C — which the same owner
   * owns, so every ownership check passes — from declaring "A hands work to B, noticed on A's task
   * T, filed by A's session S". Its derived scope is C, and C is not A.
   *
   * The lock order is the canonical one (`common/lock-order.ts`), non-decreasing and sorted where
   * there is more than one row: owner (10, the mode the insert's own foreign key would take
   * anyway), the declaring session (30, KEY SHARE — enough that it cannot be deleted underneath the
   * derivation, weak enough that it never blocks a reader), both projects (40, NO KEY UPDATE — the
   * mode a status or policy write takes, which is the point), the tasks the declaration names (50),
   * and the approval row itself (60). Session before project because that is the order the
   * canonical table states, and this transaction is not the place to invent a second one.
   *
   * The insert is `ON CONFLICT DO NOTHING` plus a verified read-back rather than create-and-catch:
   * the answer to "did somebody else just file this" has to be the row, not an error class, and the
   * P2002 shape a driver adapter reports is not something to build an identity on.
   */
  async declare(
    ownerId: string,
    declaration: HandoffDeclaration,
    scope: HandoffScopeClaim,
    now: Date,
  ): Promise<HandoffAnswer> {
    const authority = this.authorityOf(ownerId, declaration);
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerId}::uuid FOR KEY SHARE`;
      // FOR SHARE, not FOR KEY SHARE. What is derived from this row is `task_id` — which project
      // a worker session is acting for — and that is not a key column, so an ordinary
      // `UPDATE session SET task_id = …` takes FOR NO KEY UPDATE, which KEY SHARE does not
      // conflict with. A lock that does not conflict with the write it is protecting against is a
      // comment, not a lock: the binding could move between the derivation below and the INSERT,
      // and the row would be filed under a scope that had already changed hands.
      await tx.$queryRaw`
        SELECT "id" FROM "session"
        WHERE "id" = ${declaration.requestedBySessionId}::uuid
        FOR SHARE`;
      const projectIds = orderedIds([declaration.fromProjectId, declaration.toProjectId]);
      await tx.$queryRaw`
        SELECT "id" FROM "project"
        WHERE "id" = ANY(${projectIds}::uuid[])
        ORDER BY "id"
        FOR NO KEY UPDATE`;
      const taskIds = orderedIds([
        declaration.subjectTaskId,
        declaration.dependentTaskId,
        declaration.identity.source.taskId,
      ]);
      if (taskIds.length) {
        // FOR SHARE for the same reason as the session above: every question asked of these rows is
        // about `project_id`, a non-key column, and a concurrent move takes FOR NO KEY UPDATE. This
        // is also the mode the Project authorization adapter already takes on `task` at this rank,
        // so it introduces no new edge — only ordering the acquisition, sorted, in one statement.
        await tx.$queryRaw`
          SELECT "id" FROM "task"
          WHERE "id" = ANY(${taskIds}::uuid[])
          ORDER BY "id"
          FOR SHARE`;
      }

      await this.assertDeclarationIsDerivable(tx, ownerId, declaration, scope);

      const existing = await this.answerFor(tx, authority, now);
      if (existing) return existing;

      const acceptance = await this.acceptanceUnderLock(tx, ownerId, declaration);
      const decided = acceptance.acceptedBy === 'POLICY';
      const state: HandoffStoredState = decided ? 'APPROVED' : 'PENDING';
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "project_handoff_approval" (
          "id", "owner_id", "from_project_id", "to_project_id", "kind", "subject_task_id",
          "payload_digest", "crossing_key", "state", "title", "reason",
          "requested_by_session_id", "requested_at",
          "decided_by", "decided_by_user_id", "decided_at", "expires_at",
          "applied_task_id", "applied_at", "created_at", "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${ownerId}::uuid, ${declaration.fromProjectId}::uuid,
          ${declaration.toProjectId}::uuid, ${declaration.kind},
          ${declaration.subjectTaskId}::uuid,
          ${authority.payloadDigest}, ${authority.crossingKey}, ${state}, ${declaration.title},
          ${declaration.reason ?? null}, ${declaration.requestedBySessionId}::uuid, ${now},
          ${decided ? 'POLICY' : null}, NULL, ${decided ? now : null},
          ${decided ? new Date(now.getTime() + HANDOFF_APPROVAL_TTL_MS) : null},
          NULL, NULL, ${now}, ${now}
        )
        ON CONFLICT ("owner_id", "crossing_key") DO NOTHING
      `);
      // Read back unconditionally, whether this statement inserted or lost: what the caller needs
      // is the answer that now stands, and a loser reporting its own intended state would announce
      // a PENDING question the user may already have answered. Verified like any other read — the
      // row this transaction is handed is authority for the write that follows.
      const filed = await this.answerFor(tx, authority, now);
      if (!filed) {
        throw new Error(`failed to file handoff approval for crossing ${authority.crossingKey}`);
      }
      return { ...filed, filed: true };
    }, loggedRetry(this.log, 'projectHandoff.declare'));
  }

  /**
   * Everything the declaration CLAIMS, re-derived from the rows and compared.
   *
   * Order matters here the way §4's order does: the scope answer comes first, because a declaration
   * made from outside the source project's scope is not a declaration with a bad field — it is
   * somebody else asking, and telling them about the subject task would be answering a question
   * they were not entitled to ask.
   */
  private async assertDeclarationIsDerivable(
    tx: Prisma.TransactionClient,
    ownerId: string,
    declaration: HandoffDeclaration,
    scope: HandoffScopeClaim,
  ): Promise<void> {
    const refuseScope = (why: string): never => {
      throw new ForbiddenException({
        code: 'PROJECT_SCOPE_MISMATCH',
        message:
          `this crossing cannot be declared from here (${why}) — nothing was written; declare it `
          + 'from the project the work is leaving',
        requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF',
      });
    };

    const session = await tx.session.findFirst({
      where: { id: declaration.requestedBySessionId, ownerId },
      select: {
        id: true,
        taskId: true,
        task: { select: { id: true, projectId: true } },
        coordinatorForProject: { select: { id: true } },
      },
    });
    // A session id that does not resolve under this owner is an agent with no scope at all (§4 R5),
    // never an absent one: reading it as "no session" would make this a USER write, which is the one
    // principal this contract exempts.
    if (!session) refuseScope('the declaring session is not this account\'s');
    const coordinatesProject = !!session!.coordinatorForProject;
    const derivedSourceProjectId =
      session!.coordinatorForProject?.id ?? session!.task?.projectId ?? null;
    // §4 R3 BEFORE R6, and the order is the whole difference between two answers that mean opposite
    // things. A session that was ADMITTED under a scope and now derives a different one — or none
    // at all — was rotated away, and R3's answer is "yield, do not retry". Reading that as a scope
    // mismatch would tell a session that has lost its authority to try again, which is the one
    // instruction a takeover must never produce.
    if (derivedSourceProjectId !== scope.projectId) {
      throw new ConflictException({
        code: 'COORDINATOR_GENERATION_MOVED',
        message:
          'this session no longer holds the coordination scope it was admitted under; nothing was '
          + 'written and the scope that holds it now will decide again',
        requiredAction: 'YIELD_TO_CURRENT_SCOPE',
      });
    }
    if (derivedSourceProjectId !== declaration.fromProjectId) {
      refuseScope('it names a source project this session does not hold');
    }

    // The four provenance columns the target task will carry, derived exactly as
    // `TasksService.resolveOwnedSession` derives them — one rule, one spelling, no drift.
    const source = declaration.identity.source;
    if ((source.projectId ?? null) !== derivedSourceProjectId) {
      refuseScope('its source evidence names another project');
    }
    if ((source.sessionId ?? null) !== session!.id) {
      refuseScope('its source evidence names another session');
    }
    if ((source.taskId ?? null) !== (session!.taskId ?? null)) {
      refuseScope('its source evidence names a task this session is not executing');
    }
    const derivedTriggerEvent = sessionTriggerEvent({
      coordinatesProject,
      executesTask: !!session!.taskId,
    });
    if ((source.triggerEvent ?? null) !== derivedTriggerEvent) {
      refuseScope('its source evidence names an event this session did not produce');
    }

    // The generation the caller was admitted under, re-read under the project lock. A rotation
    // advances it (0113's `project_coordinator_rotation_count`), so this is the takeover answer for
    // the declaration itself: the session that asked is no longer the one holding the scope.
    const scopeProject = await tx.project.findFirst({
      where: { id: derivedSourceProjectId!, ownerId },
      select: {
        id: true,
        coordinatorSessionId: true,
        runtime: { select: { coordinatorGeneration: true } },
      },
    });
    if (!scopeProject) refuseScope('the source project is not this account\'s');
    if (String(scopeProject!.runtime?.coordinatorGeneration ?? 0n) !== scope.generation) {
      throw new ConflictException({
        code: 'COORDINATOR_GENERATION_MOVED',
        message:
          'the coordination scope this crossing was declared under has moved; nothing was written '
          + 'and the scope that holds it now will decide again',
        requiredAction: 'YIELD_TO_CURRENT_SCOPE',
      });
    }
    if (coordinatesProject && scopeProject!.coordinatorSessionId !== session!.id) {
      throw new ConflictException({
        code: 'COORDINATOR_GENERATION_MOVED',
        message:
          'this session no longer coordinates the project it is declaring from; nothing was written',
        requiredAction: 'YIELD_TO_CURRENT_SCOPE',
      });
    }
    // A worker session declares from the project of the task it is executing, and only while that
    // is still where the task is filed.
    if (!coordinatesProject && (session!.task?.projectId ?? null) !== derivedSourceProjectId) {
      refuseScope('the task this session executes is no longer filed under that project');
    }

    // The subject, where the kind has one. WHICH end it must belong to is the kind's whole meaning:
    // a MOVE takes a task OUT of the source, a dependency waits ON work in the target. A declaration
    // that gets this backwards is incoherent rather than unauthorised, so it is a 400 — and nothing
    // is written either way.
    if (declaration.dependentTaskId) {
      const dependent = await tx.task.findFirst({
        where: { id: declaration.dependentTaskId, ownerId },
        select: { id: true, projectId: true },
      });
      if (!dependent || (dependent.projectId ?? null) !== declaration.fromProjectId) {
        throw new BadRequestException(
          'the task that would be made to wait is not filed under the project this crossing leaves',
        );
      }
    }
    if (declaration.subjectTaskId) {
      const subject = await tx.task.findFirst({
        where: { id: declaration.subjectTaskId, ownerId },
        select: { id: true, projectId: true },
      });
      const expected = declaration.kind === 'MOVE_TASK'
        ? declaration.fromProjectId
        : declaration.toProjectId;
      if (!subject || (subject.projectId ?? null) !== expected) {
        throw new BadRequestException(
          declaration.kind === 'MOVE_TASK'
            ? 'the task being handed over is not filed under the project it would be leaving'
            : 'the prerequisite this crossing waits on is not filed under the project it names',
        );
      }
    }
  }

  /**
   * §4 R-p under the locks this transaction already holds: who may accept this work.
   *
   * Read after `assertDeclarationIsDerivable`, so by the time this runs the asker has been shown to
   * be who they say they are. What is left is the two projects' statuses and policies — read from
   * the rows under the rank-40 lock, never from anything the caller said about them, which is what
   * makes an auto-acceptance a fact about the world at the instant of the insert rather than about
   * the world when the caller started.
   */
  private async acceptanceUnderLock(
    tx: Prisma.TransactionClient,
    ownerId: string,
    declaration: HandoffDeclaration,
  ): Promise<HandoffAcceptanceDecision> {
    const ends = await tx.project.findMany({
      where: { id: { in: [declaration.fromProjectId, declaration.toProjectId] }, ownerId },
      select: { id: true, status: true, automationPolicy: true },
    });
    const from = ends.find((row) => row.id === declaration.fromProjectId);
    const to = ends.find((row) => row.id === declaration.toProjectId);
    if (!from || !to) throw new ForbiddenException('project not found');
    return decideHandoffAcceptance(
      { status: from.status as 'OPEN' | 'DONE' | 'CANCELLED', automationPolicy: from.automationPolicy },
      { status: to.status as 'OPEN' | 'DONE' | 'CANCELLED', automationPolicy: to.automationPolicy },
    );
  }

  /** One recorded answer, by id, under this owner — refused if it does not describe itself. */
  async get(ownerId: string, id: string, now: Date): Promise<HandoffAnswer> {
    const row = (await this.prisma.projectHandoffApproval.findFirst({
      where: { id, ownerId },
      select: HANDOFF_SELECT,
    })) as HandoffRow | null;
    if (!row) throw new NotFoundException('handoff approval not found');
    this.assertSelfConsistent(row);
    return this.answerOf(row, now);
  }

  /**
   * What has been asked and answered about one project, in both directions.
   *
   * Both directions on purpose: the target project's people are the ones being asked to take work,
   * and the source project's are the ones waiting on the answer. A list showing one direction would
   * leave one of them looking at a queue that never mentions what they are blocked on.
   */
  async listForProject(
    ownerId: string,
    projectId: string,
    options: { state?: HandoffStoredState; limit?: number } = {},
  ): Promise<HandoffRow[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');
    return (await this.prisma.projectHandoffApproval.findMany({
      where: {
        ownerId,
        OR: [{ fromProjectId: projectId }, { toProjectId: projectId }],
        ...(options.state ? { state: options.state } : {}),
      },
      // Unit L7: the two ends by NAME as well as by id. A queue of crossings that showed only ids
      // asks a person to approve work moving between two things they cannot read, and "which
      // project is 3CuIHiS" is not a question the page should send them somewhere else to answer.
      // The ids stay — they are what the decision is made against and what the public-id filter
      // renders — and the titles are added beside them. What the crossing is ABOUT is already on
      // the row: `title` is the plan's own title, bound into the digest the approval authorises.
      select: {
        ...HANDOFF_SELECT,
        fromProject: { select: { title: true, status: true } },
        toProject: { select: { title: true, status: true, acceptanceEpoch: true } },
      },
      orderBy: { requestedAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 200),
    })).map((row) => ({
      ...row,
      // BigInt has no JSON spelling, and the epoch is what says whether the landing project has
      // been reopened since this crossing was asked about.
      toProject: row.toProject
        ? { ...row.toProject, acceptanceEpoch: String(row.toProject.acceptanceEpoch) }
        : row.toProject,
    })) as unknown as HandoffRow[];
  }

  /**
   * The user's answer.
   *
   * Three properties, and each of them is a way this could go wrong:
   *
   *   - The transition is checked against `project-handoff.ts` first, so the refusal says WHICH
   *     move was illegal. A denied crossing has no legal move at all: §6 gives `ABANDONED` one exit
   *     and it is the user filing the work themselves under R1, not this row coming back to life
   *     wearing the requester and the moment of a question that was answered no.
   *   - Approving a live yes writes NOTHING. It is the same answer, so it is a stable read-back —
   *     the decider, the moment and the expiry stay byte-identical. Without this, "approve" twice
   *     would be a way to extend an authorization's deadline indefinitely without ever making a
   *     second decision, which is an expiry that can always be outrun.
   *   - The write is a compare-and-set on the state that was read, so two clicks produce one answer
   *     and one 409 rather than an answer that depends on timing.
   */
  async decide(
    ownerId: string,
    userId: string,
    id: string,
    decision: 'APPROVE' | 'DENY',
    now: Date,
  ): Promise<HandoffAnswer> {
    const { row } = await this.get(ownerId, id, now);
    const state = row.state as HandoffStoredState;
    const next = nextHandoffState(state, decision);
    if (!next) {
      throw new ConflictException(
        `handoff approval ${uuidToBase62(row.id)} is ${state} and cannot be ${decision}D; `
        + (state === 'DENIED'
          ? 'a refused crossing stays refused — file the work yourself if you have changed your mind'
          : 'a spent approval authorised one crossing and is finished'),
      );
    }
    if (next === state) return this.get(ownerId, id, now);
    const approved = next === 'APPROVED';
    const updated = await this.prisma.projectHandoffApproval.updateMany({
      where: { id: row.id, ownerId, state },
      data: {
        state: next,
        decidedBy: 'USER',
        decidedByUserId: userId,
        decidedAt: now,
        expiresAt: approved ? new Date(now.getTime() + HANDOFF_APPROVAL_TTL_MS) : null,
        updatedAt: now,
      },
    });
    if (!updated.count) {
      throw new ConflictException(
        `handoff approval ${uuidToBase62(row.id)} was answered by somebody else while you were `
        + 'deciding; re-read it before answering again',
      );
    }
    return this.get(ownerId, id, now);
  }

  /**
   * Spend the yes, inside the caller's transaction — the `APPLY` half of §6.
   *
   * One statement, and every condition that makes this row authority is IN it: the owner, both
   * ends, the kind, the subject, the payload, the crossing, the session that asked, the state, the
   * unspent-ness and the expiry. Anything less would be a spend authorised by a lookup.
   *
   * `expiresAt` is re-checked here and not only at admission: a transaction can be open for a long
   * time, and a yes that expired while it was running has expired.
   *
   * WHEN THE COMPARE-AND-SET FINDS NOTHING
   * --------------------------------------
   * Two very different things look identical from here — a second application, and this same
   * application arriving twice because the first response was lost — so the row is re-read and they
   * are told apart by the one fact that distinguishes them: WHICH task the yes was spent on. Spent
   * on the task this call is writing, it is this call, already done; anything else is a second
   * crossing wearing the first one's approval, and it is refused with nothing written. The re-read
   * is verified against the full authority tuple like every other read here, so a row that arrived
   * from somewhere this code did not write it cannot answer "already done".
   */
  async spend(
    tx: Prisma.TransactionClient,
    authority: HandoffAuthority,
    handoffId: string,
    taskId: string,
    now: Date,
    /**
     * The generation the caller was admitted under, when it holds a scope. Compared for a yes the
     * POLICY gave: an automatic acceptance is a standing instruction from the owner about the world
     * as it stands, and a scope that has rotated away is not the one that instruction was about.
     */
    expectedSourceGeneration?: string,
  ): Promise<void> {
    await this.assertStandingAtEffect(tx, authority, handoffId, expectedSourceGeneration);
    const spent = await tx.$executeRaw(Prisma.sql`
      UPDATE "project_handoff_approval"
         SET "state" = 'APPLIED',
             "applied_task_id" = ${taskId}::uuid,
             "applied_at" = ${now},
             "updated_at" = ${now}
       WHERE "id" = ${handoffId}::uuid
         AND "owner_id" = ${authority.ownerId}::uuid
         AND "from_project_id" = ${authority.fromProjectId}::uuid
         AND "to_project_id" = ${authority.toProjectId}::uuid
         AND "kind" = ${authority.kind}
         AND "subject_task_id" IS NOT DISTINCT FROM ${authority.subjectTaskId}::uuid
         AND "payload_digest" = ${authority.payloadDigest}
         AND "crossing_key" = ${authority.crossingKey}
         AND "requested_by_session_id" = ${authority.requestedBySessionId}::uuid
         AND "state" = 'APPROVED'
         AND "applied_task_id" IS NULL
         AND "expires_at" > ${now}
    `);
    if (spent === 1) return;
    const row = (await tx.projectHandoffApproval.findFirst({
      where: { id: handoffId, ownerId: authority.ownerId },
      select: HANDOFF_SELECT,
    })) as HandoffRow | null;
    if (row && row.state === 'APPLIED' && row.appliedTaskId === taskId) {
      // The same spend, seen twice: a redelivered turn, a retried transaction, a lost response.
      // Verified before it is believed — an APPLIED row pointing at this task but describing
      // another crossing is not this call's earlier attempt.
      this.assertAuthority(row, authority);
      return;
    }
    throw new ConflictException(
      `handoff approval ${uuidToBase62(handoffId)} is no longer a live, unspent yes for this exact `
      + 'crossing — nothing was written; re-read it and ask again',
    );
  }

  /**
   * A yes the POLICY gave, re-derived at the moment it is spent.
   *
   * A user's yes is a decision about a crossing and stands until it expires or they take it back.
   * An automatic one is not a decision at all — it is the owner's standing instruction that these
   * two projects may hand work to each other unattended, and that instruction is a fact about the
   * world RIGHT NOW. Between the declaration and the spend either end can be moved to
   * GUARDED_AUTO, accepted, cancelled, or have its coordination rotated away; every one of those
   * withdraws the instruction, and none of them touches the row, so nothing else would notice.
   *
   * Read under the caller's own rank-40 locks — both ends are in the project set its fence takes —
   * so what is read here cannot change before the write it authorises.
   */
  private async assertStandingAtEffect(
    tx: Prisma.TransactionClient,
    authority: HandoffAuthority,
    handoffId: string,
    expectedSourceGeneration?: string,
  ): Promise<void> {
    const row = (await tx.projectHandoffApproval.findFirst({
      where: { id: handoffId, ownerId: authority.ownerId },
      select: HANDOFF_SELECT,
    })) as HandoffRow | null;
    // A missing or foreign row is the compare-and-set's answer to give, not this one's: it says
    // "nothing was written" with the shape of the disagreement, and saying it twice differently is
    // how two callers end up with two ideas of what went wrong.
    if (!row || row.decidedBy !== 'POLICY') return;
    this.assertAuthority(row, authority);
    const ends = await tx.project.findMany({
      where: {
        id: { in: [authority.fromProjectId, authority.toProjectId] },
        ownerId: authority.ownerId,
      },
      select: {
        id: true,
        status: true,
        automationPolicy: true,
        runtime: { select: { coordinatorGeneration: true } },
      },
    });
    const from = ends.find((end) => end.id === authority.fromProjectId);
    const to = ends.find((end) => end.id === authority.toProjectId);
    const stillAutomatic = from && to && decideHandoffAcceptance(
      { status: from.status as 'OPEN' | 'DONE' | 'CANCELLED', automationPolicy: from.automationPolicy },
      { status: to.status as 'OPEN' | 'DONE' | 'CANCELLED', automationPolicy: to.automationPolicy },
    ).acceptedBy === 'POLICY';
    if (!stillAutomatic) {
      throw new ConflictException({
        code: 'CROSS_PROJECT_APPROVAL_REQUIRED',
        message:
          'this crossing was accepted automatically because both projects were on AUTO and open, '
          + 'and one of them no longer is — nothing was written; ask a person for this one',
        requiredAction: 'AWAIT_HANDOFF_APPROVAL',
      });
    }
    if (expectedSourceGeneration !== undefined
        && String(from!.runtime?.coordinatorGeneration ?? 0n) !== expectedSourceGeneration) {
      throw new ConflictException({
        code: 'COORDINATOR_GENERATION_MOVED',
        message:
          'the coordination scope this automatic acceptance was given to has moved; nothing was '
          + 'written and the scope that holds it now will decide again',
        requiredAction: 'YIELD_TO_CURRENT_SCOPE',
      });
    }
  }

  /**
   * Several crossings spent by one transaction, in one order.
   *
   * Sorted by id, exactly as every multi-row acquisition in this codebase is (§8.6 LO2): a batch
   * that files three tasks each waiting on a different project takes three of these rows, and two
   * such batches naming the same approvals in opposite item orders would otherwise be able to
   * deadlock on them. Item order is the caller's; id order is everybody's.
   */
  async spendAll(
    tx: Prisma.TransactionClient,
    spends: ReadonlyArray<{ authority: HandoffAuthority; handoffId: string; taskId: string }>,
    now: Date,
    expectedSourceGeneration?: string,
  ): Promise<void> {
    const ordered = [...spends].sort((a, b) => (a.handoffId < b.handoffId ? -1 : a.handoffId > b.handoffId ? 1 : 0));
    for (const spend of ordered) {
      await this.spend(
        tx, spend.authority, spend.handoffId, spend.taskId, now, expectedSourceGeneration,
      );
    }
  }
}
