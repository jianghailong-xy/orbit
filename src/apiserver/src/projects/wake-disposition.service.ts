import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  NO_COMPARABLE_EXIT_CODE,
  TASK_ACCEPTANCE_CLIENT_TURN_PREFIX,
  readExecutableAcceptanceOutcome,
} from '../tasks/executable-acceptance-round';
import {
  type BlockerDisposition,
  type DeliveryObservations,
  blockerDisposition,
  declaredPaths,
} from './blocker-disposition';
import {
  type CoordinatorMessageOutcome,
  CoordinatorDeliveryService,
} from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { WakeFact, criterionSubjectId } from './coordinator-wake';
import type { WakeAuthorizer } from './coordinator-wake.service';
import { probeMainTip, type MainTipAnswer } from './main-tip-probe';
import {
  type MechanicalAction,
  type RoundOutcome,
  mechanicalAction,
} from './mechanical-disposition';
import { criterionKeyOf } from './project-acceptance';
import {
  type CriterionWithLandingFacts,
  criterionLanding,
  receiptIsLandingEvidence,
} from './project-criterion-landing';
import { CriterionState, criterionCoverage, wakeDisposition } from './wake-disposition';

/** The blocker one delivery raised, for a caller that has to report that it stopped. */
export interface RaisedBlocker extends BlockerDisposition {
  /** The work the blocker is about. */
  taskId: string;
  /** The row, or `null` when this episode was already open and this delivery added nothing. */
  blockerId: string | null;
}

/** How long a HUMAN-recovery blocker waits before it reads as overdue (BL5's escalation alarm). */
const HUMAN_BLOCKER_ALARM_MS = 30 * 60 * 1_000;

/**
 * What a fact that DID change the decision was spent on, for a caller that has to report it.
 *
 * Two ways to be spent and therefore two ways to have already been: `OPENED`/`ALREADY_OPEN` came
 * back from the unit that opens a judgment session, `DELIVERED`/`ALREADY_DELIVERED` from the one
 * that hands the fact to the conversation the project already has. They are kept apart rather than
 * folded into one word because they name different things having happened — a conversation that
 * now exists, against a message on one that already did.
 */
export interface WakeSpend {
  outcome:
    | 'OPENED'
    | 'ALREADY_OPEN'
    | 'DELIVERED'
    | 'ALREADY_DELIVERED'
    | 'ALREADY_AWAKE'
    | 'REFUSED';
  refusalCode?: string;
}

/**
 * The durable half of `wake-disposition.ts`: read the criteria the fact bears on, decide, and open
 * only when the answer is yes.
 *
 * WHY THE READ COMES BEFORE THE CLAIM, AND WHY THAT IS SAFE
 * ========================================================
 * `coordinator-wake.ts` §1 forbids letting an authorization decision run before the idempotency
 * key is claimed, because a key computed after a permission branch makes the winner of a race
 * depend on a question about permission. This read is not that. It cannot change the key — the key
 * is a total function of the fact — and it cannot refuse the wake: both of its answers end in a
 * status inside 0174's partial unique index, so whichever branch a delivery takes it claims the
 * same key and loses the same races. Two concurrent deliveries that read different coverage still
 * produce exactly one terminal, because only one of them wins the INSERT.
 *
 * WHY THIS IS NOT ON THE ROUTER
 * =============================
 * `CompletionInputRouter` records facts against named consumers and deliberately opens no session
 * of its own — a claim `completion-input.spec.ts` holds it to over its source. Opening one is
 * `CoordinatorJudgmentService`'s, writing to the one this project already has is
 * `CoordinatorDeliveryService`'s, and choosing between the three terminals is this unit's, which is
 * why the router asks and does not decide.
 *
 * THE SECOND HALF OF "SPENT ON"
 * =============================
 * `chooseAction` answers the other half of the same question: not which terminal this fact is
 * worth, but which action the round it is about already settles without one. It is here rather
 * than in a unit of its own because the two answers are about one fact at one moment, and a second
 * service would be a second reader of the same rows with its own idea of when to ask them.
 * Neither method authorizes anything, and both are called only for a fact its producer's own
 * authorizer already allowed.
 *
 * AND THE HALF THAT IS NOBODY'S TO SPEND
 * ======================================
 * `raiseBlockerIfNeeded` answers the third: whether this fact is one a machine may settle at all.
 * `blocker-disposition.ts` §0 names the four deliveries it may not, and this method is where their
 * observations are read — the same rows, at the same moment, for the same fact. It runs BEFORE
 * `chooseAction` in the router, because a delivery a person has to look at is not a delivery whose
 * merge is worth computing.
 */
@Injectable()
export class WakeDispositionService {
  private readonly logger = new Logger(WakeDispositionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /**
   * Spend the one decisive terminal this fact justifies, or `null` when it justifies none.
   *
   * `null` is the caller's instruction to record the fact and stop — NOT a refusal, and not a
   * failure. The authorizer is handed straight through rather than consulted here, so a wake the
   * coordinator's switch or the convergence ledger would refuse is refused on the same terms in
   * every branch: this unit decides what an allowed wake is spent on and never whether it is
   * allowed.
   *
   * The name is older than the second decisive answer and is kept: what the caller asks is still
   * "is this one worth acting on, and if so act on it", and WHICH action is exactly the thing this
   * unit exists to keep out of the caller. `wake-disposition.ts` §2.2 is where the two differ.
   */
  async openIfDecisive(fact: WakeFact, authorize: WakeAuthorizer): Promise<WakeSpend | null> {
    const criteria = await this.statesOf(fact);
    const decided = wakeDisposition(fact.event, criteria);
    if (decided === 'RECORD_ONLY') return null;

    if (decided === 'DELIVER_TO_COORDINATOR') {
      // ...unless a person has to answer first. What the standing conversation is sent is an
      // instruction to MERGE, in that order, and that conversation is the thing that performs
      // merges — so telling it to merge a delivery whose ruler is in dispute, whose files nobody
      // asked for, or whose branch git already refused would be routing the merge around the
      // blocker rather than stopping it. RECORD_ONLY is the existing answer for "this fact is not
      // worth waking anybody for", and it is the right one here: the fact stays in the ledger, and
      // `raiseBlockerIfNeeded` puts the question to the person on the way back through `spend`.
      //
      // A read, not a decision about permission: it takes the same branch either way, both
      // branches end in a status inside 0174's partial unique index, and nothing is WRITTEN here.
      // The blocker itself is raised only after this fact's own authorizer allowed it, which is
      // what keeps a switched-off coordinator from being handed a question it never asked.
      if (await this.blockerFor(fact)) return null;
      const delivered = await this.deliveries.deliver(fact, authorize);
      return delivered.outcome === 'REFUSED'
        ? { outcome: 'REFUSED', refusalCode: delivered.refusalCode }
        : { outcome: delivered.outcome };
    }

    const judged = await this.judgments.wake(fact, authorize);
    return judged.outcome === 'REFUSED'
      ? { outcome: 'REFUSED', refusalCode: judged.refusalCode }
      : { outcome: judged.outcome };
  }

  /**
   * The message without the terminal: put this fact on the standing conversation and leave the
   * ledger alone.
   *
   * `openIfDecisive` spends a fact ON that conversation and binds its wake row to the turn. A fact
   * whose terminal is a NAMED CONSUMER cannot end that way — one fact has one terminal — and still
   * has something to say, which is what the evidence ledger's door asks for. Both reach the same
   * performer through here rather than through two, because "may this conversation be written to,
   * and under which key" is one reading and a second holder of `CoordinatorDeliveryService` would
   * be a second place for it to drift.
   *
   * It authorizes nothing, exactly like the two answers above: the caller's own producer decided
   * that before it got here.
   */
  notifyStandingCoordinator(fact: WakeFact): Promise<CoordinatorMessageOutcome> {
    return this.deliveries.message(fact);
  }

  /**
   * The mechanical action this authorized fact calls for, or `null` when nothing about it is
   * mechanical.
   *
   * WHY THIS QUESTION LIVES BESIDE `openIfDecisive`
   * ===============================================
   * "What is an allowed wake spent on" is one question with two halves, and both are answered
   * here so that neither can be answered twice. `openIfDecisive` decides which terminal the fact is
   * worth — a judgment session, a message to the standing conversation, or the ledger row alone;
   * this decides what the round it is about already settles without any of them. Neither is an
   * authorization: a caller asks this only for a fact its producer's own authorizer already
   * allowed, which is what makes "the switch is off, so no action is chosen" true by construction
   * rather than by a second check of the same column.
   *
   * WHY THE OBSERVATIONS ARE READ HERE AND FOLDED THERE
   * ===================================================
   * `mechanical-disposition.ts` is a fold over three observations and cannot go and get them.
   * Getting them is this method's whole body, and it is deliberately visible: a row, a count, and
   * a check that is really run. Nothing is passed in but the fact, so no caller can hand this unit
   * the answer it is supposed to find out.
   *
   * The probe is reached only from the branch that needs it — a round that came back with a code
   * of its own and disagreed. A pass merges, and a round that did not come back is decided by
   * concurrency, so neither spends a subprocess.
   */
  async chooseAction(fact: WakeFact): Promise<MechanicalAction | null> {
    // A criterion whose finished work is off `main`. Every serving task reached DONE, and for
    // EXECUTABLE work there is exactly one way to reach it: the declared command exited the
    // declared code under the task's own row lock. That IS the round, so it is read as one rather
    // than re-derived from a session that has long since ended.
    if (fact.event === 'CRITERION_UNLANDED') {
      return (await this.servingWorkPassed(fact))
        ? mechanicalAction({ round: 'PASSED', concurrentRounds: 0, mainTip: 'UNKNOWN' })
        : null;
    }

    if (fact.event !== 'ATTEMPT_ENDED_UNSETTLED') return null;

    // The attempt's session id is this fact's subject version — `coordinator-wake.ts` §2 chose it
    // precisely because it names one attempt and cannot move — and the session's `error` is the
    // one place the round's two numbers survive the request that compared them.
    const attempt = await this.prisma.session.findUnique({
      where: { id: fact.subjectVersion },
      select: { id: true, error: true, assignedRunnerId: true },
    });
    const reported = readExecutableAcceptanceOutcome(attempt?.error);
    if (!attempt || !reported) return null;

    const round: RoundOutcome = reported.actualExitCode === NO_COMPARABLE_EXIT_CODE
      ? 'NO_COMPARABLE_RESULT'
      : 'RAN_AND_DISAGREED';

    return mechanicalAction({
      round,
      concurrentRounds: round === 'NO_COMPARABLE_RESULT'
        ? await this.roundsAlongside(attempt.id, attempt.assignedRunnerId)
        : 0,
      mainTip: round === 'RAN_AND_DISAGREED'
        ? await this.checkAtMainTip(fact.projectId, fact.subjectId)
        : 'UNKNOWN',
    });
  }

  /**
   * The state of every acceptance criterion this fact bears on, re-read after the commit.
   *
   * Which criteria a fact bears on is decided by its SUBJECT and not by its event: work names the
   * one criterion it was filed against, and a criterion fact names itself. Every other subject
   * bears on none, which §3 records and does not judge — the project-scoped fact has its own door
   * and is not delivered through this one.
   *
   * Both dimensions are read here, for every fact, and neither is taken from the fact itself. A
   * fact's `detail` is display and diagnosis (`coordinator-wake.ts` says so in as many words), so
   * a landing answer copied out of it would be this unit deciding on what was true when the fact
   * was DERIVED rather than on what is true now — and "the merge landed in between" is precisely
   * the case where those differ and where nobody should be woken. The receipts arrive on the
   * criterion's serving work, which is the same nested read `project-criterion-landing.ts` makes
   * for the person looking at the same question.
   */
  private async statesOf(fact: WakeFact): Promise<CriterionState[]> {
    if (fact.subjectType === 'TASK') {
      const served = await this.prisma.projectAcceptanceCriterionDefinition.findFirst({
        where: { projectId: fact.projectId, servingTasks: { some: { id: fact.subjectId } } },
        select: { id: true, servingTasks: { select: SERVING_WORK } },
      });
      if (!served) return [];
      return [state(served, criterionCoverage(settlements(served.servingTasks), fact.subjectId))];
    }

    if (fact.subjectType === 'CRITERION') {
      const stated = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: fact.projectId },
        select: { id: true, servingTasks: { select: SERVING_WORK } },
      });
      // Matched by re-deriving the subject rather than by parsing it: the spelling of a criterion's
      // wake subject belongs to the function that writes it, and a second parser of it here would
      // be a second definition of what a criterion is called.
      return stated
        .filter((row) => criterionSubjectId(fact.projectId, criterionKeyOf(row.id)) === fact.subjectId)
        .map((row) => state(row, criterionCoverage(settlements(row.servingTasks))));
    }

    return [];
  }

  /**
   * Whether this criterion's serving work is finished work whose finishing was a comparison.
   *
   * The fact's own predicate already says every serving task is DONE. This adds the half the fact
   * does not carry: that each of them declared a command and a code, so "the round exited what it
   * was asked to" is something that HAPPENED rather than something assumed. A criterion served by
   * work that reached DONE another way is not a round, and this unit has nothing to say about it.
   */
  private async servingWorkPassed(fact: WakeFact): Promise<boolean> {
    const stated = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: fact.projectId },
      select: {
        id: true,
        servingTasks: { select: { status: true, completionCriterion: true } },
      },
    });
    const serving = stated
      .filter((row) => criterionSubjectId(fact.projectId, criterionKeyOf(row.id)) === fact.subjectId)
      .flatMap((row) => row.servingTasks);
    return serving.length > 0
      && serving.every((task) => task.status === 'DONE' && task.completionCriterion === 'EXECUTABLE');
  }

  /**
   * How many other acceptance rounds were in flight while this one ran.
   *
   * COUNTED, NOT DECLARED
   * =====================
   * A round is a reserved shell turn: the server queues exactly one per attempt and marks it with
   * `TASK_ACCEPTANCE_CLIENT_TURN_PREFIX`, which is how the door that compares exit codes knows a
   * turn is one. So "was anything else running" is a question about rows — delivered before this
   * round ended, and either still unanswered or answered after it started — and the answer moves
   * when the world does, which is the whole reason `-1` is allowed to mean anything here.
   *
   * Bounded to the same runner on purpose. Two rounds on two machines do not contend for anything,
   * and counting them would turn a busy account into a permanent excuse for every `-1`. A session
   * with no runner cannot say what it shared a machine with, so it counts nothing.
   */
  private async roundsAlongside(
    sessionId: string,
    assignedRunnerId: string | null,
  ): Promise<number> {
    if (!assignedRunnerId) return 0;
    const round = await this.prisma.conversationTurn.findFirst({
      where: {
        sessionId,
        kind: 'shell',
        clientTurnId: { startsWith: TASK_ACCEPTANCE_CLIENT_TURN_PREFIX },
      },
      orderBy: { seq: 'desc' },
      select: { deliveredAt: true, answeredAt: true },
    });
    // Never delivered is not a round that ran, and a round with no start has no window for
    // anything to overlap. Neither is an observation of concurrency, so neither is reported as one.
    if (!round?.deliveredAt) return 0;
    const ended = round.answeredAt ?? new Date();

    return this.prisma.conversationTurn.count({
      where: {
        sessionId: { not: sessionId },
        kind: 'shell',
        clientTurnId: { startsWith: TASK_ACCEPTANCE_CLIENT_TURN_PREFIX },
        session: { assignedRunnerId },
        deliveredAt: { lte: ended },
        OR: [{ answeredAt: null }, { answeredAt: { gte: round.deliveredAt } }],
      },
    });
  }

  /**
   * Run this task's own declared check at the tip of the project's integration ref.
   *
   * The two inputs are rows: the task says what the check IS, and the project's primary codebase
   * binding says which repository and which ref the tip is OF. `project_codebase` is the row that
   * owns both — a second opinion about where a project's `main` lives is the ambiguity that
   * contract exists to remove — so a project with no binding gets no answer rather than a guess
   * about a repository nobody named.
   */
  private async checkAtMainTip(projectId: string, taskId: string): Promise<MainTipAnswer> {
    const [task, codebase] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        select: { acceptanceCommand: true, acceptanceExpectedExitCode: true },
      }),
      this.prisma.projectCodebase.findFirst({
        where: { projectId, slot: 'primary' },
        select: { canonicalRepoUrl: true, integrationRef: true },
      }),
    ]);
    if (!task?.acceptanceCommand || task.acceptanceExpectedExitCode == null) return 'UNKNOWN';
    if (!codebase) return 'UNKNOWN';

    return probeMainTip({
      repoUrl: codebase.canonicalRepoUrl,
      ref: codebase.integrationRef,
      command: task.acceptanceCommand,
      expectedExitCode: task.acceptanceExpectedExitCode,
    });
  }

  /**
   * Raise the one blocker this authorized fact calls for, or `null` when nothing about it does.
   *
   * WHY ONLY THIS EVENT
   * ===================
   * `CRITERION_UNLANDED` is the fact that means "the work is finished and it is not on `main`" —
   * the one moment a coordinator would otherwise merge and release the next task. That is exactly
   * the moment these four deliveries have to stop it, and stopping a fact that was never going to
   * merge anything would be raising a blocker about nothing.
   *
   * WHY THE FIRST TASK WINS
   * =======================
   * A criterion can be served by several tasks, and the fact is about all of them at once. This
   * walks them in id order and stops at the first that needs a person, because a blocker is a
   * question addressed to somebody: two of them raised in one pass would be two notifications
   * about one delivery, and the second question is not askable until the first is answered
   * anyway. The order is fixed so that two readings of the same world ask the same question.
   */
  async raiseBlockerIfNeeded(fact: WakeFact): Promise<RaisedBlocker | null> {
    const stopped = await this.blockerFor(fact);
    if (!stopped) return null;
    return {
      ...stopped.disposition,
      taskId: stopped.taskId,
      blockerId: await this.raiseBlocker(fact.projectId, stopped.taskId, stopped.disposition),
    };
  }

  /**
   * The same question, asked without writing anything.
   *
   * Two callers and one answer: `openIfDecisive` needs it BEFORE the fact is handed to whoever
   * would act on it, and `raiseBlockerIfNeeded` needs it after the fact was allowed, because that
   * is the only moment a blocker may be written. Asking twice costs one repeated read and buys the
   * property that matters — nothing is written on the strength of a fact nobody authorized.
   */
  private async blockerFor(
    fact: WakeFact,
  ): Promise<{ taskId: string; disposition: BlockerDisposition } | null> {
    if (fact.event !== 'CRITERION_UNLANDED') return null;

    for (const delivery of await this.deliveriesUnder(fact)) {
      const disposition = blockerDisposition(delivery.observed);
      if (disposition) return { taskId: delivery.taskId, disposition };
    }
    return null;
  }

  /**
   * The work serving this criterion, each with the five observations the fold is a function of.
   *
   * One query. The nested selects carry the receipts and the delivering session with the task,
   * because the alternative is a query per task and the criterion this fact is about can be served
   * by several. Nothing here decides anything: `blocker-disposition.ts` §2 says which row each
   * observation is, and this is that reading, spelled once.
   */
  private async deliveriesUnder(
    fact: WakeFact,
  ): Promise<Array<{ taskId: string; observed: DeliveryObservations }>> {
    const stated = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: fact.projectId },
      select: {
        id: true,
        revision: true,
        servingTasks: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            title: true,
            description: true,
            acceptanceCriteria: true,
            completionCriterionOverrideReason: true,
            criterionRevision: true,
            mergeReceipts: {
              orderBy: { createdAt: 'desc' },
              select: { result: true, targetBranch: true, conflicts: true },
            },
            // The attempt that produced the branch. Its snapshot is what the runner computed
            // against this session's own base, so a task that ran twice is described by its
            // latest delivery and not by a diff of a tree nobody has any more.
            sessions: {
              where: { startsTaskWork: true, deletedAt: null },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { changedFiles: true },
            },
          },
        },
      },
    });

    return stated
      .filter((row) => criterionSubjectId(fact.projectId, criterionKeyOf(row.id)) === fact.subjectId)
      .flatMap((row) => row.servingTasks.map((task) => ({
        taskId: task.id,
        observed: {
          criterionExemptionArgued: (task.completionCriterionOverrideReason ?? '').trim() !== '',
          // A snapshot that disagrees with the criterion it names. A task filed against no
          // criterion has no snapshot to disagree, and says nothing about the standard moving.
          statedCriterionMoved:
            task.criterionRevision != null && task.criterionRevision !== row.revision,
          changedPaths: changedPathsOf(task.sessions[0]?.changedFiles),
          declaredPaths: declaredPaths(task),
          // The branch test is the landing fold's own, asked without its result: a conflict on
          // some other branch is a conflict about somewhere else, exactly as a merge into one is.
          conflictedPaths: task.mergeReceipts.find((receipt) => receipt.result === 'CONFLICT'
            && receiptIsLandingEvidence({ result: 'MERGED', targetBranch: receipt.targetBranch }),
          )?.conflicts ?? [],
        },
      })));
  }

  /**
   * Put the question on the project's needs-human surface, once per episode.
   *
   * The shape is the one the missing-judgment-path signal already uses, for the same reasons:
   * USER owns it, only a HUMAN clears it, and the partial unique index over open rows is what
   * makes a redelivery of the same condition find the question already asked instead of asking it
   * again. `lifecycleGeneration` advances only when a resolved episode genuinely comes back.
   *
   * Nothing else is written. This method does not touch the task, its status, the wake row or any
   * merge: what it produces is a question, and the answer is somebody else's.
   */
  private async raiseBlocker(
    projectId: string,
    taskId: string,
    disposition: BlockerDisposition,
  ): Promise<string | null> {
    const dedupeKey = `${disposition.kind}:${disposition.reason}:${taskId}`;
    const detail = {
      reason: disposition.reason,
      source: 'CRITERION_UNLANDED',
      taskId,
      paths: disposition.paths,
    };
    const conditionVersion = createHash('sha256').update(JSON.stringify(detail)).digest('hex');

    return withTransactionRetry(this.prisma, async (tx) => {
      // The project row is the only thing this write has to be serialised against — a second
      // delivery of the same fact — and it is taken before the blocker rows below it.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE
      `);
      const now = new Date();
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "project_blocker" (
          "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
          "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
          "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at",
          "updated_at"
        )
        SELECT ${randomUUID()}::uuid, ${projectId}::uuid, ${disposition.kind},
               'USER'::"project_blocker_owner", 'HUMAN'::"project_blocker_recovery",
               'CRITICAL'::"project_blocker_severity", ${REQUIRED_ACTION[disposition.reason]},
               ${new Date(now.getTime() + HUMAN_BLOCKER_ALARM_MS)}, 'TASK', ${taskId},
               ${JSON.stringify(detail)}::jsonb, ${dedupeKey},
               coalesce(max(blocker."lifecycle_generation"), 0) + 1,
               ${conditionVersion}, ${now}, ${now}, ${now}
          FROM "project_blocker" blocker
         WHERE blocker."project_id" = ${projectId}::uuid
           AND blocker."dedupe_key" = ${dedupeKey}
        ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING
        RETURNING "id"
      `);
      return rows[0]?.id ?? null;
    }, loggedRetry(this.logger, 'wakeDisposition.raiseBlocker'));
  }
}

/** One executable sentence per reason, addressed to the person the blocker hands the delivery to. */
const REQUIRED_ACTION: Readonly<Record<BlockerDisposition['reason'], string>> = {
  CRITERION_EXEMPTION_ARGUED:
    '这份交付写下了「某条判据不适用」的理由。请读那段理由并裁定它成不成立，再决定合不合入；'
    + '在你裁定之前不要合并，也不要放行下一条。',
  ACCEPTANCE_STANDARD_MOVED:
    '这份工作声明的那条验收标准在它开工之后被改过。请确认按今天的措辞它算不算通过；'
    + '改验收标准只有账号所有者能做，协调会话不能替。',
  OUTSIDE_DECLARED_SCOPE:
    '这份交付改了它自己的声明里没提过的文件。请看 detail.paths 列出的那些改动，'
    + '决定接受、退回还是让它拆开；在你决定之前不要合并。',
  MERGE_REFUSED_BY_GIT:
    'git 拒绝了这次合并。请按 detail.paths 列出的冲突文件手工解决，再重新合入；'
    + '重试不会有帮助。',
};

/**
 * The paths in a session's reported worktree snapshot.
 *
 * The column is JSON because that is what the runner sends, and this reads it defensively for the
 * same reason every reader of it does: a session that never ran has none, an older runner may omit
 * the field, and neither is a delivery that changed nothing outside its scope — it is a delivery
 * about which nothing can be said.
 */
function changedPathsOf(reported: unknown): string[] {
  if (!Array.isArray(reported)) return [];
  return reported
    .map((file) => (file && typeof file === 'object' ? (file as { path?: unknown }).path : null))
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

/** What one criterion's serving work has to carry for both halves of the rule to be answerable. */
const SERVING_WORK = {
  id: true,
  status: true,
  mergeReceipts: { select: { result: true, targetBranch: true } },
} as const;

function settlements(tasks: ReadonlyArray<{ id: string; status: string }>) {
  return tasks.map((task) => ({ taskId: task.id, status: task.status }));
}

/**
 * One criterion's row, folded into the pair the rule reads.
 *
 * The landing half goes through `criterionLanding` — one row at a time, because that is the unit
 * this fact is decided in — rather than through a receipt test written here. The fold is where
 * "landed" is defined, and calling it is how this unit stays a reader of that definition instead
 * of becoming a second author of it.
 */
function state(criterion: CriterionWithLandingFacts, coverage: CriterionState['coverage']) {
  return { coverage, landing: criterionLanding([criterion])[0]!.landing };
}
