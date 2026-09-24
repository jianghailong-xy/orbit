import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  type CoordinatorDeliveryOutcome,
} from './coordinator-delivery.service';
import {
  WakeFact,
  projectSettledUnmergedFact,
  type UnmergedLineWork,
} from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';
import {
  LANDED_RESULTS,
  LANDING_SERVING_WORK_SELECT,
  readLandingBranches,
  taskHasNothingToLand,
  taskLanding,
  type LandingBranches,
} from './project-criterion-landing';

/** The project disappeared between the committed read and the wake's authorization. */
export const PROJECT_SETTLED_UNMERGED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/** The project still exists and its automation switch is off at authorization time — the same
 *  refusal about the same column its siblings spell this way. */
export const PROJECT_SETTLED_UNMERGED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** What one settled project's delivery answered, for a caller that has to say what happened. */
export interface SettledUnmergedDelivery {
  projectId: string;
  outcome: CoordinatorDeliveryOutcome['outcome'];
  refusalCode?: string;
}

/**
 * `PROJECT_SETTLED_UNMERGED`: the work a settled project left sitting on its integration line.
 *
 * WHAT WAS WRONG
 * ==============
 * Promotion candidates are made off landings — `considerCandidate` runs when the queue gets
 * shorter — so a commit that reaches the integration line with no landing behind it is offered to
 * nobody. The job that would have carried it answered `ALREADY_LANDED` and went terminal while the
 * session was still writing its final commit (2026-09-23, project `34ODoUKJGEsfbgcJDGS4q`, commit
 * `d6b55d2d853f8b2410977674e3ec54c39f52a34e`), and once the project settled, the writes that would
 * have re-derived anything stopped too. The promotion queue's own guards were not wrong and are
 * not loosened here: what was missing is that the skip left no trace, and a skip nobody can read is
 * indistinguishable from a project with nothing left to do.
 *
 * WHAT IT ASKS, AND WHAT IT DOES NOT
 * ==================================
 * One read, of the same fold every landing reader uses (`taskLanding` over the receipts, correlated
 * to the project's own two branches in `project-criterion-landing.ts`) — a task whose work is on
 * the integration line and on no receipt's answer on the upstream is work this project made and has
 * not landed. It names the commits it can: the tip each such task's landing produced, or the commit
 * it merged where the line took the work without moving. It merges nothing, starts nothing and
 * refuses nothing — the card that merges a project branch is the owner's alone (M7).
 *
 * WHY ONLY A SETTLED PROJECT, AND WHY THAT BOUNDS THE READ
 * ======================================================
 * An OPEN project with work on its line is the ordinary state of a project being integrated: the
 * landing that put the work there is exactly what makes the next candidate, and a fact about it
 * would wake every coordinator of every project in flight. A settled project has no more landings,
 * which is what makes this the one state where the line can stop without anybody noticing. The
 * scan that follows is bounded by the same clause: settled projects are read on the edges a settled
 * project still takes (a merge receipt landing on it), not on every completion of every project.
 *
 * WHY IT DELIVERS RATHER THAN RECORDS
 * ===================================
 * A fact whose whole content is "these commits are going nowhere" is worth nothing recorded where
 * nobody reads it, so it goes to the project's standing coordinator conversation through
 * `CoordinatorDeliveryService.deliver`, under this unit's authorizer, and NOT through
 * `WakeDispositionService`: that unit's rule is about the criteria a fact bears on, and a settled
 * project's stated criteria are all `LANDED` before it could settle. What this fact is about is
 * work the criteria do not name.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S
 * =================================
 * The fact is derived from the project's rows, so it answers to the project's coordinator switch,
 * composed cheapest refusal first with `convergence.authorizeWake` LAST — that one records a
 * judgment, so no refusal may follow it and leave a record of a wake that never happened.
 */
@Injectable()
export class ProjectSettledUnmergedProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /**
   * The `PROJECT_SETTLED_UNMERGED` facts these projects justify, in project-id order.
   *
   * Empty is the ordinary answer and the negative half of this rule: a project that is not settled,
   * and a project whose line is level with its upstream, both justify nothing.
   */
  async factsFor(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<WakeFact[]> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];

    const settled = await this.prisma.project.findMany({
      where: { id: { in: ids }, status: 'DONE' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const facts: WakeFact[] = [];
    for (const project of settled) {
      const work = await this.unmergedWork(project.id);
      const fact = projectSettledUnmergedFact(project.id, work);
      if (fact) facts.push(fact);
    }
    return facts;
  }

  /**
   * Derive, then deliver each fact to its project's standing coordinator conversation.
   *
   * After the commit and never inside it, for the reason every door on this router gives: the facts
   * are derived from the rows that actually committed, and a delivery writes a turn on another
   * conversation, which no write of a receipt may hold its locks across.
   */
  async afterCommit(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<SettledUnmergedDelivery[]> {
    const delivered: SettledUnmergedDelivery[] = [];
    for (const fact of await this.factsFor(projectIds)) {
      const answer = await this.deliveries.deliver(fact, this.authorize);
      delivered.push({
        projectId: fact.projectId,
        outcome: answer.outcome,
        ...(answer.outcome === 'REFUSED' ? { refusalCode: answer.refusalCode } : {}),
      });
    }
    return delivered;
  }

  /**
   * What one project made and never landed, as this fact names it: one entry per task, carrying the
   * commit its work reached the line at.
   *
   * The same two folds the landing lane reads — `taskHasNothingToLand` and `taskLanding`, over
   * receipts read in one statement for the whole project rather than one per task — and for the
   * same reason that lane reads them: a second definition of "on the line and not on the upstream"
   * would be a second answer to a question this repository already answers, able to drift from the
   * one a person is shown.
   *
   * The exemption is the criterion lane's, and it is needed here for the same reason it is needed
   * there: work whose whole record at the line is "the branch it was handed had nothing of its own
   * on it" has no commit to be stuck, and a criterion-12 acceptance task that ran a branch and
   * committed nothing to it would otherwise raise this fact about a project with nothing left over.
   */
  private async unmergedWork(projectId: string): Promise<UnmergedLineWork[]> {
    const branches = await readLandingBranches(this.prisma, projectId);
    // Tasks with a landing receipt of their own: a task nothing ever landed has no commit on the
    // line to be stuck, and excluding it here is what keeps this read proportional to the work the
    // project actually integrated rather than to every task it ever filed.
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        mergeReceipts: { some: { result: { in: [...LANDED_RESULTS] } } },
      },
      select: {
        id: true,
        title: true,
        // The fold's own input, widened with the two columns that let this fact NAME the commit —
        // the fold reads neither, and a reader that wrote its own copy of this select would be a
        // second author of what the fold sees.
        ...LANDING_SERVING_WORK_SELECT,
        mergeReceipts: {
          where: { result: { in: [...LANDED_RESULTS] } },
          select: {
            result: true,
            targetBranch: true,
            sourceSha: true,
            targetShaAfter: true,
            createdAt: true,
            id: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return tasks.flatMap((task) => {
      if (taskHasNothingToLand(task)) return [];
      if (taskLanding(task.mergeReceipts, branches) !== 'ON_INTEGRATION_LINE') return [];
      const sha = newestShaOnLine(task.mergeReceipts, branches);
      return sha ? [{ taskId: task.id, title: task.title, sha }] : [];
    });
  }

  /**
   * The authorizer every settled-unmerged delivery is routed with.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` states
   * about its own: handed across as a bare method it would arrive without its `this`, and a throw
   * inside an authorizer is recorded as `WAKE_AUTHORIZATION_FAILED` — a wiring mistake wearing the
   * costume of a transient failure.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    // Claim first, authorize second, so permission cannot decide who wins the idempotency key.
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: PROJECT_SETTLED_UNMERGED_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: PROJECT_SETTLED_UNMERGED_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}

/**
 * The commit to name for one task: the newest receipt that put its work on the integration line,
 * and the tip that landing produced — or, where the line took the work without moving (an
 * `ALREADY_MERGED` into a branch that already carried it, which is how most of this work lands),
 * the commit it merged.
 *
 * `mergeReceipts` arrives newest first, so the first receipt on the line is the one the tip is
 * about. A receipt on some other branch is skipped rather than folded: what is being named is a
 * commit a reader can go and find on THIS project's line.
 */
function newestShaOnLine(
  receipts: ReadonlyArray<{
    targetBranch: string;
    sourceSha: string;
    targetShaAfter: string | null;
  }>,
  branches: LandingBranches,
): string | null {
  const onLine = receipts.find((receipt) => branches.integration.includes(receipt.targetBranch));
  if (!onLine) return null;
  return onLine.targetShaAfter ?? onLine.sourceSha;
}
