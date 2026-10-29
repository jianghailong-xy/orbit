import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { IntegrationJobResultRequest, IntegrationObservation } from '@orbit/shared';
import { orderedIds } from '../common/lock-order';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { landingPendingObservationSql, resolveObservationErrorItems } from './landing-observation';
import { sessionReportedWork } from './landing-source-branch';
import { branchName } from './project-criterion-landing';
import { appendIntegrationJobEvent, resultText } from './project-integration-event';
import {
  recordLandingUnobserved,
  resolveIntegrationItemsOnLanding,
  type LandingUnobservedReason,
} from './project-open-item';

/**
 * An OBSERVE_LANDING's OBSERVED result (`docs/project-integration-line-contract.md` §10.6 O-J3): what
 * the job saw, task by task, written in the transaction that writes the job's terminal state —
 * O-R1's receipt, O-R2's empty branch, O-R4's item — so a reader never sees the job OBSERVED without
 * what it observed. The rest of the result transaction (the claim fence, the doors' answer, the
 * delivery after the commit) is the queue's own, `runner-api/integration-job-relay.ts`.
 */

const logger = new Logger('LandingObservationResult');

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why an OBSERVED result cannot be read, or null when it can (§10.6 O-S3): its observations are a list,
 * each naming a task and the commits it was asked about, with the three answers typed as the runner
 * sends them, and the two tips full commit names. Refused whole: an observation half understood would
 * be written down as half a landing.
 */
export function observedResultRefusal(body: Pick<IntegrationJobResultRequest,
  'observations' | 'upstreamSha' | 'targetShaBefore'>): string | null {
  if (!Array.isArray(body.observations)) {
    return 'an OBSERVED result carries observations: one per task its command named';
  }
  for (const [index, entry] of (body.observations as unknown[]).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `observation ${index} is not an object`;
    const observation = entry as Record<string, unknown>;
    if (typeof observation.taskId !== 'string' || !UUID.test(observation.taskId)) {
      return `observation ${index} names no task`;
    }
    if (typeof observation.deliveredSha !== 'string' || !SHA.test(observation.deliveredSha)) {
      return `observation ${index}: deliveredSha is not a full commit sha`;
    }
    if (observation.baseSha != null && (typeof observation.baseSha !== 'string' || !SHA.test(observation.baseSha))) {
      return `observation ${index}: baseSha is not a full commit sha`;
    }
    if (typeof observation.onUpstream !== 'boolean' || typeof observation.empty !== 'boolean') {
      return `observation ${index}: onUpstream and empty are booleans`;
    }
    for (const field of ['onIntegrationLine', 'fullyApplied'] as const) {
      if (observation[field] != null && typeof observation[field] !== 'boolean') {
        return `observation ${index}: ${field} is a boolean or null`;
      }
    }
  }
  for (const field of ['upstreamSha', 'targetShaBefore'] as const) {
    const value = body[field];
    if (value != null && (typeof value !== 'string' || !SHA.test(value))) return `${field} is not a full commit sha`;
  }
  return null;
}

/** The job columns this result is written from. */
export interface ObservedJob {
  id: string;
  projectId: string;
  ownerId: string;
  targetRef: string;
  upstreamRef: string;
  claimGeneration: bigint;
  round: number | null;
}

/** What the result wrote, for the doors' answer and the delivery after the commit. */
export interface ObservedApplied {
  receiptIds: string[];
  /** The tasks whose landing a receipt here recorded: J10 dispatches their dependents. */
  landedTaskIds: string[];
  /** The `LANDING_UNOBSERVED` items opened, for their holder to be told. */
  openItemIds: string[];
}

/** A waiting task as this result reads it. */
interface ObservedTask {
  id: string;
  deliveredSha: string | null;
  deliveredBaseSha: string | null;
  deliveredBranch: string | null;
  deliveredSessionId: string | null;
  pending: boolean;
}

type TaskPlan =
  | { kind: 'RECEIPT'; task: ObservedTask; sessionId: string; targetBranch: string;
      targetShaBefore: string | null; empty: boolean }
  | { kind: 'UNOBSERVED'; task: ObservedTask; reason: LandingUnobservedReason };

/**
 * O-J3: write the job OBSERVED and, task by task, what it saw (O-R1–O-R4).
 *
 * Only a task still waiting to be observed, and still delivering the commit the observation was asked
 * about, is answered for: a task reopened since, landed since, or another project's says nothing here.
 * That is also what makes a replayed or a second observation of the same task a no-op — its first
 * receipt has taken it out of the waiting set — beside the receipt's own idempotency key.
 *
 *  - O-R1, seen: `onUpstream`, else `onIntegrationLine` — an ALREADY_MERGED receipt written through
 *    `MergeReceiptService` (RUNNER, `{ integrationJobId, observed: true }`), which retires M-T13's
 *    candidates, closes the task's `LANDING_UNOBSERVED` and raises O-R3 when owed; the task's
 *    integration items close as J-T5's landing edge closes them; J10 follows the commit.
 *  - O-R2, an empty branch (`delivered_sha = delivered_base_sha`), by O-L7 and J8's rule: no session
 *    of the task reported work — a receipt on the line, saying there was nothing of its own to land;
 *    one did — in an AGENT_PUSH project, `LANDING_UNOBSERVED` (WORK_ELSEWHERE).
 *  - O-R4, not seen: in an AGENT_PUSH project whose task's work has stopped moving,
 *    `LANDING_UNOBSERVED` — APPLIED_AS_OTHER_COMMITS when `git cherry` found every change on the
 *    upstream, NOT_ON_LINE otherwise; one per delivered commit. A PLATFORM project writes nothing: its
 *    own pipeline carries the work.
 *
 * Locks in rank order before the first write (`common/lock-order.ts`): the sessions the receipts write
 * (30), the project (40) and the tasks (50) every row here names, then the rank-60 rows.
 */
export async function applyObservedResult(
  tx: Prisma.TransactionClient,
  job: ObservedJob,
  body: IntegrationJobResultRequest,
): Promise<ObservedApplied> {
  const now = new Date();
  const upstreamSha = body.upstreamSha ?? null;
  const lineSha = body.targetShaBefore ?? null;
  const seen = new Set<string>();
  const observations = (body.observations ?? []).filter((observation) => {
    if (seen.has(observation.taskId)) return false;
    seen.add(observation.taskId);
    return true;
  });

  const line = await tx.projectCodebase.findFirst({
    where: { projectId: job.projectId, slot: 'primary' },
    select: { deliveryMode: true, integrationRef: true, upstreamRef: true },
  });
  const agentPush = line?.deliveryMode === 'AGENT_PUSH';
  const upstreamBranch = branchName(line?.upstreamRef ?? job.upstreamRef);
  const lineBranch = branchName(line?.integrationRef ?? job.targetRef);
  const tasks = observations.length === 0 ? [] : await tx.$queryRaw<ObservedTask[]>(Prisma.sql`
    SELECT t."id", t."delivered_sha" AS "deliveredSha", t."delivered_base_sha" AS "deliveredBaseSha",
           t."delivered_branch" AS "deliveredBranch", t."delivered_session_id" AS "deliveredSessionId",
           ${Prisma.raw(landingPendingObservationSql('t'))} AS "pending"
      FROM "task" t
     WHERE t."id" = ANY(${observations.map((observation) => observation.taskId)}::uuid[])
       AND t."project_id" = ${job.projectId}::uuid
       AND t."owner_id" = ${job.ownerId}::uuid`);
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const plans: TaskPlan[] = [];
  for (const observation of observations) {
    const task = byId.get(observation.taskId);
    if (!task?.pending || task.deliveredSha !== observation.deliveredSha) continue;
    const plan = await planTask(tx, { task, observation, agentPush, upstreamBranch, lineBranch, upstreamSha, lineSha });
    if (plan) plans.push(plan);
  }

  const receiptPlans = plans.filter((plan): plan is Extract<TaskPlan, { kind: 'RECEIPT' }> => plan.kind === 'RECEIPT');
  const sessionIds = orderedIds(receiptPlans.map((plan) => plan.sessionId));
  if (sessionIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "session" WHERE "id" = ANY(${sessionIds}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`);
  }
  if (plans.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "project" WHERE "id" = ${job.projectId}::uuid FOR KEY SHARE`);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "task"
       WHERE "id" = ANY(${orderedIds(plans.map((plan) => plan.task.id))}::uuid[])
       ORDER BY "id" FOR KEY SHARE`);
  }

  const receiptIds: string[] = [];
  const landedTaskIds: string[] = [];
  for (const plan of receiptPlans) {
    let receiptId: string;
    try {
      const recorded = await MergeReceiptService.recordIn(tx, job.ownerId, plan.sessionId, {
        result: 'ALREADY_MERGED',
        sourceBranch: plan.task.deliveredBranch,
        sourceSha: plan.task.deliveredSha!,
        targetBranch: plan.targetBranch,
        targetShaBefore: plan.targetShaBefore,
        targetShaAfter: null,
        detail: { integrationJobId: job.id, observed: true, ...(plan.empty ? { empty: true } : {}) },
      }, 'RUNNER');
      receiptId = recorded.receipt.id;
    } catch (error) {
      // A door's refusal is raised before it writes anything — a session that is gone or not an
      // engine session, a checkpoint the landing gate does not accept — so the transaction goes on
      // and the task stays waiting, to be answered by a later look. Anything else is not a refusal.
      if (!(error instanceof HttpException)) throw error;
      logger.warn(`observation ${job.id} wrote no receipt for task ${plan.task.id}: ${error.message}`);
      continue;
    }
    receiptIds.push(receiptId);
    landedTaskIds.push(plan.task.id);
    // J-T5's landing edge: what was open about landing this task is answered by its landing.
    await resolveIntegrationItemsOnLanding(tx, plan.task.id);
  }

  const openItemIds: string[] = [];
  for (const plan of plans) {
    if (plan.kind !== 'UNOBSERVED') continue;
    const opened = await recordLandingUnobserved(tx, {
      taskId: plan.task.id,
      reason: plan.reason,
      deliveredSha: plan.task.deliveredSha,
      baseSha: plan.task.deliveredBaseSha,
      branch: plan.task.deliveredBranch,
      sessionId: plan.task.deliveredSessionId,
      observedUpstreamSha: upstreamSha,
      observedLineSha: lineSha,
      observedAt: now,
      jobId: job.id,
    });
    if (opened) openItemIds.push(opened.itemId);
  }

  // O-J4's ending: the project's observation answered.
  await resolveObservationErrorItems(tx, job.projectId);
  await tx.projectIntegrationJob.update({
    where: { id: job.id },
    data: {
      state: 'OBSERVED',
      phase: 'OBSERVE',
      ...(upstreamSha ? { upstreamSha } : {}),
      ...(lineSha ? { targetShaBefore: lineSha } : {}),
      observations: (body.observations ?? []) as unknown as Prisma.InputJsonValue,
      receiptIds,
      finishedAt: now,
      heartbeatAt: now,
    },
  });
  // §2.9 LS2: the answer is a fact of the transaction that wrote it.
  await appendIntegrationJobEvent(tx, {
    jobId: job.id,
    key: 'result',
    kind: 'RESULT',
    claim: Number(job.claimGeneration),
    round: job.round ?? null,
    phase: 'OBSERVE',
    data: {
      state: 'OBSERVED',
      requestedState: 'OBSERVED',
      upstreamSha,
      targetShaBefore: lineSha,
      observed: observations.length,
      receiptIds,
      finishedAt: now.toISOString(),
    },
    text: resultText({
      state: 'OBSERVED', phase: 'OBSERVE', targetRef: job.targetRef, upstreamRef: job.upstreamRef,
      targetShaBefore: lineSha,
    }),
    at: now,
  });
  return { receiptIds, landedTaskIds, openItemIds };
}

/** What one waiting task's observation calls for (O-R1, O-R2, O-R4), or null for nothing. */
async function planTask(
  tx: Prisma.TransactionClient,
  input: {
    task: ObservedTask;
    observation: IntegrationObservation;
    agentPush: boolean;
    upstreamBranch: string;
    lineBranch: string;
    upstreamSha: string | null;
    lineSha: string | null;
  },
): Promise<TaskPlan | null> {
  const { task, observation } = input;
  const work = await tx.session.findMany({
    where: { taskId: task.id, startsTaskWork: true, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, finishedAt: true, isolationStatus: true, branch: true, changedFiles: true },
  });
  // The work has stopped moving (J-T1e): every work session finished. A frozen identity says it had,
  // and a session started since says it has not any more.
  const settled = work.every((session) => session.finishedAt !== null);
  const receipt = async (targetBranch: string, targetShaBefore: string | null, empty: boolean): Promise<TaskPlan | null> => {
    const sessionId = await receiptSession(tx, task, work.map((session) => session.id));
    return sessionId ? { kind: 'RECEIPT', task, sessionId, targetBranch, targetShaBefore, empty } : null;
  };

  // O-R2: a branch that carried no commit of its own is J8's NOTHING_TO_LAND, whatever the tips say —
  // its fork point is on every line it forked from.
  if (task.deliveredBaseSha !== null && task.deliveredSha === task.deliveredBaseSha) {
    const reported = work.some((session) => session.isolationStatus === 'worktree' && session.branch !== null
      && sessionReportedWork(session));
    if (!reported) return receipt(input.lineBranch, input.lineSha ?? input.upstreamSha, true);
    return input.agentPush && settled ? { kind: 'UNOBSERVED', task, reason: 'WORK_ELSEWHERE' } : null;
  }
  // O-R1: seen on the upstream, else on the project's own line.
  if (observation.onUpstream) return receipt(input.upstreamBranch, input.upstreamSha, false);
  if (observation.onIntegrationLine === true) return receipt(input.lineBranch, input.lineSha, false);
  // O-R4: not seen.
  if (!input.agentPush || !settled) return null;
  return {
    kind: 'UNOBSERVED',
    task,
    reason: observation.fullyApplied === true ? 'APPLIED_AS_OTHER_COMMITS' : 'NOT_ON_LINE',
  };
}

/**
 * The session a task's receipt is written against: the one its identity was read from
 * (`delivered_session_id`), when it is still there and still this task's; else its newest work
 * session. Null when it has none — a receipt needs a session, and the task then stays waiting.
 */
async function receiptSession(
  tx: Prisma.TransactionClient,
  task: ObservedTask,
  workSessionIds: string[],
): Promise<string | null> {
  if (task.deliveredSessionId) {
    const delivered = await tx.session.findFirst({
      where: { id: task.deliveredSessionId, taskId: task.id },
      select: { id: true },
    });
    if (delivered) return delivered.id;
  }
  return workSessionIds[0] ?? null;
}
