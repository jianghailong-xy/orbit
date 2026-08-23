/**
 * Unit L6: the write half of the repair `project-ownership-refile.ts` decides.
 *
 * One transaction, three statements, and nothing outside them: read the world, insert the
 * replacement, abandon the original. In particular it writes NO Session — not a cancel, not a
 * complete, not an end — and the planner is what makes that structural rather than promised, by
 * refusing every task that has one.
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreatorType } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { orderedIds } from '../common/lock-order';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { decideTaskOwnership } from './project-ownership-gate';
import {
  ownershipFactsOf,
  taskOwnershipQuery,
  type TaskOwnershipRow,
} from './project-ownership-read';
import {
  OWNERSHIP_REFILE_TRIGGER,
  planOwnershipRefile,
  type RefilePlan,
} from './project-ownership-refile';

/** The four session states that mean somebody is mid-run (0130's own list). */
const LIVE_SESSION_STATUSES = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] as const;

export interface RefileOutcome {
  /** Base62, like everything the API hands back. */
  taskId: string;
  replacementTaskId: string;
  replacementProjectId: string;
  abandonedProjectId: string | null;
  /** False when a previous call already did the work — the same answer, said twice. */
  created: boolean;
}

@Injectable()
export class ProjectOwnershipRefileService {
  private readonly log = new Logger(ProjectOwnershipRefileService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Repair one mis-filed task, or say precisely why it cannot be repaired.
   *
   * The refusals are `409`, not `400`: nothing is wrong with the request. The world is in a state
   * where this operation has no correct outcome, and that is a fact about the task rather than
   * about the caller's typing. `TARGET_UNKNOWN` and `NOT_MISFILED` are the two exceptions —
   * "there is nothing here to repair" is a mistaken request, and answering it 409 would have
   * clients retrying a call that will never succeed.
   */
  async refile(ownerId: string, taskId: string, retried = false): Promise<RefileOutcome> {
    return withTransactionRetry(this.prisma, async (tx) => {
      // I2's rank 10, taken FIRST and taken explicitly: the INSERT below reaches
      // `task_owner_id_fkey`/`task_creator_id_fkey` several statements from now, and the UPDATE
      // after it reaches `project_acceptance_reopen` (rank 40) from a trigger. Taking the ranks in
      // order here is what stops this transaction being caught holding 50 while it asks for 10.
      await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerId}::uuid FOR KEY SHARE`;
      const task = await tx.task.findFirst({
        where: { id: taskId, ownerId },
        select: {
          id: true, title: true, description: true, acceptanceCriteria: true, labels: true,
          status: true, projectId: true, assigneeId: true, provider: true, model: true,
          requiredCapabilities: true, dueDate: true, completionPolicy: true,
        },
      });
      if (!task) throw new NotFoundException('task not found');

      const [ownershipRow] = await tx.$queryRaw<TaskOwnershipRow[]>(
        taskOwnershipQuery(ownerId, [taskId]),
      );
      // The row above already proved the task exists under this owner, so this one does too. The
      // guard is here because a `find` that cannot fail is still a `find`, and the alternative is a
      // `TypeError` several frames away from what actually went wrong.
      if (!ownershipRow) throw new NotFoundException('task not found');
      const ownership = decideTaskOwnership(ownershipFactsOf(ownershipRow));
      const target = ownership.fromProjectId;
      // Rank 40, both ends, sorted and in one statement — `ProjectHandoffService.declare`'s
      // acquisition, because this is the same crossing seen from the other side. FOR NO KEY UPDATE
      // is the mode `task_supersession_project_lock_order` takes on the project when the abandon
      // below fires it, so this only ORDERS an acquisition that was going to happen anyway.
      const projectIds = orderedIds([task.projectId, target]);
      if (projectIds.length) {
        await tx.$queryRaw`
          SELECT "id" FROM "project"
          WHERE "id" = ANY(${projectIds}::uuid[])
          ORDER BY "id"
          FOR NO KEY UPDATE`;
      }
      // Rank 50, and FOR UPDATE rather than FOR SHARE: this row is about to be written. Two callers
      // racing the same repair therefore serialize here rather than at the unique index — the index
      // is the backstop for the pair that got past this on different replicas, not the mechanism.
      await tx.$queryRaw`SELECT "id" FROM "task" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
      const [liveSessionCount, sessionCount, targetProject, existing] = await Promise.all([
        tx.session.count({
          where: { taskId, ownerId, deletedAt: null, status: { in: [...LIVE_SESSION_STATUSES] } },
        }),
        // `deletedAt` deliberately NOT filtered. The question is "did work ever happen under this
        // task", and a session somebody deleted from their list still ran: its branch, its commits
        // and its merge receipt are all still there. A soft delete hides a conversation, it does
        // not un-run it.
        tx.session.count({ where: { taskId, ownerId } }),
        target
          ? tx.project.findFirst({ where: { id: target, ownerId }, select: { status: true } })
          : Promise.resolve(null),
        tx.task.findFirst({
          where: { sourceTaskId: taskId, triggerEvent: OWNERSHIP_REFILE_TRIGGER, ownerId },
          select: { id: true, projectId: true },
        }),
      ]);

      const plan = planOwnershipRefile({
        ownership,
        taskStatus: task.status,
        liveSessionCount,
        sessionCount,
        targetProjectStatus:
          (targetProject?.status as 'OPEN' | 'DONE' | 'CANCELLED' | undefined) ?? null,
        existingReplacementTaskId: existing?.id ?? null,
      });

      if (plan.action === 'REFUSE') return this.refuse(plan, taskId);
      if (plan.action === 'ALREADY_REFILED') {
        return {
          taskId: uuidToBase62(taskId),
          replacementTaskId: uuidToBase62(plan.replacementTaskId),
          replacementProjectId: uuidToBase62(existing!.projectId!),
          abandonedProjectId: task.projectId ? uuidToBase62(task.projectId) : null,
          created: false,
        };
      }

      // What the replacement carries, and what it deliberately does not.
      //
      // Carried: everything that describes the WORK — what it is, what would settle it, who does
      // it, with what. Those are facts about the task and they did not become wrong when it landed
      // in the wrong project.
      //
      // Dropped: `parentTaskId`, `verifiesTaskId` and every dependency edge, because each of them
      // points into the graph of the project the work does not belong to, and re-pointing them is a
      // judgment nobody has made. Dropped too: `listId`, `runAt` and `autoRunWhenReady` — the
      // replacement arrives OPEN and started by nobody, so the coordinator of the project that
      // actually owns it decides when it runs. That decision is exactly the authority the
      // mis-filing bypassed, and handing the replacement a schedule would bypass it again.
      const replacement = await tx.task.create({
        data: {
          ownerId,
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          labels: task.labels,
          assigneeId: task.assigneeId,
          provider: task.provider,
          model: task.model,
          requiredCapabilities: task.requiredCapabilities,
          dueDate: task.dueDate,
          completionPolicy: task.completionPolicy,
          projectId: plan.replacementProjectId,
          // A person asked for this. `creatorCoordinatorProjectId` is left out of the INSERT for
          // the reason §4 R1 exempts the owner from the scope contract at all: there is no scope to
          // compare theirs against, and writing one would be recording a fiction — one that this
          // unit's own gate would then read.
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          // The mapping, and the only durable form it can take: 0128's supersession guard requires
          // a successor in the SAME project, so `supersededByTaskId` is unavailable by construction
          // here. Provenance is one-directional and queryable both ways, and 0156's partial unique
          // index over exactly this pair is what stops a second replacement existing.
          sourceTaskId: task.id,
          discoveredFromProjectId: task.projectId,
          triggerEvent: OWNERSHIP_REFILE_TRIGGER,
        },
        select: { id: true },
      });

      // ABANDONED, not SUPERSEDED, and the difference is not bookkeeping: SUPERSEDED means "a later
      // attempt at this took over", which 0128 will only let a task in the same project claim.
      // What actually happened is that this filing was dropped on purpose — nothing is replacing it
      // HERE — and the replacement lives under another goal entirely.
      //
      // CANCELLED because `task_retirement_status_check` requires a terminal reason to sit on a
      // CANCELLED or FAILED row, and FAILED would assert a run that never happened. Which is safe
      // to write only because the planner refused every task that ever ran; 0130's
      // `task_supersession_live_session_guard` is the backstop that makes that true even for a
      // caller racing a session insert.
      await tx.task.update({
        where: { id: task.id },
        data: { status: 'CANCELLED', terminalReason: 'ABANDONED', supersededAt: new Date() },
      });

      return {
        taskId: uuidToBase62(task.id),
        replacementTaskId: uuidToBase62(replacement.id),
        replacementProjectId: uuidToBase62(plan.replacementProjectId),
        abandonedProjectId: plan.abandonedProjectId ? uuidToBase62(plan.abandonedProjectId) : null,
        created: true,
      };
    }, loggedRetry(this.log, 'projectOwnership.refile')).catch((error: unknown) => {
      // The race the partial unique index decides: two callers reached the insert with neither
      // seeing the other's replacement. The loser reads back the winner's row rather than reporting
      // a constraint violation, which is what makes "idempotent" a property of the operation and
      // not of how it is called.
      // Once, and only once. A second P2002 is not the race — the loser's re-read is guaranteed to
      // find the winner's row — so retrying again would be spinning on a constraint this operation
      // does not understand, which is worse than reporting it.
      if (
        !retried
        && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      ) {
        return this.refile(ownerId, taskId, true);
      }
      throw error;
    });
  }

  private refuse(plan: Extract<RefilePlan, { action: 'REFUSE' }>, taskId: string): never {
    const sentence = `task ${uuidToBase62(taskId)}: ${plan.message}`;
    if (plan.reason === 'NOT_MISFILED' || plan.reason === 'TARGET_UNKNOWN') {
      throw new BadRequestException(sentence);
    }
    throw new ConflictException(sentence);
  }
}
