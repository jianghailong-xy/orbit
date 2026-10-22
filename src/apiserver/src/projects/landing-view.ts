import type {
  IntegrationJobKind,
  IntegrationJobLiveness,
  IntegrationJobPhase,
  SessionLandingAttempt,
  SessionLandingTodo,
  SessionLandingView,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readInFlightJobs } from './project-integration-line';
import { pushBoundaryPassed } from './project-integration-job';
import { readLandingTimeline } from './landing-timeline';
import { INTEGRATION_ITEM_KINDS, openItemOwed } from './project-open-item';

/**
 * The landing view (docs/project-integration-line-contract.md §2.9 LS1, LS6; errata E4):
 * `GET /sessions/:id`, `GET /sessions/:id/compact` and the runner's `GET /runner/sessions/:id`
 * (which is what MCP `session_get` calls) answer it for a LANDING session.
 *
 * It is read from the SUBJECT, not from the session row, because the row is inserted only after
 * the first claim commits: a link to a landing opened the moment its subject opens has no row yet,
 * and the same view must be reachable through `project_landing.session_id` (LS1). The two cases
 * differ only in whether the session row exists; `readLandingView` does not care.
 *
 * Everything here is a fact another door already keeps: the newest attempt is the job row, its
 * liveness and blocking reason are `readInFlightJobs`' own read-time rules, the todos are the
 * subject's OPEN integration items still owed, and the generations are the subject's own
 * episodes. Nothing is copied into the session row and nothing is written.
 *
 * Deliberately absent until the later tasks add them: the job timeline and the per-check output.
 */
export async function readLandingView(
  prisma: PrismaService,
  ownerId: string,
  landingSessionId: string,
): Promise<SessionLandingView<Date> | null> {
  const landing = await prisma.projectLanding.findFirst({
    where: { sessionId: landingSessionId, ownerId },
    select: {
      id: true,
      projectId: true,
      ownerId: true,
      codebaseId: true,
      subject: true,
      taskId: true,
      promotionId: true,
      episode: true,
      sessionId: true,
      openedAt: true,
      settledAt: true,
      settledAs: true,
    },
  });
  if (!landing) return null;

  const job = await prisma.projectIntegrationJob.findFirst({
    where: { landingId: landing.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      kind: true,
      state: true,
      generation: true,
      phase: true,
      round: true,
      step: true,
      claimGeneration: true,
      runnerId: true,
      sessionId: true,
      targetRef: true,
      createdAt: true,
      claimedAt: true,
      heartbeatAt: true,
      outputMovedAt: true,
      progressProtocol: true,
      pushReportedGeneration: true,
      checks: true,
    },
  });

  // The write-side liveness/blocking rules are `readInFlightJobs`' and are read here rather than
  // re-derived: only a QUEUED or RUNNING attempt has a claim to judge, and that read also
  // carries the queue-wide facts (serial slot, runner wait) a reason is built from.
  const inFlight = job && (job.state === 'RUNNING' || job.state === 'QUEUED')
    ? (await readInFlightJobs(prisma, landing.projectId)).find((row) => row.jobId === job.id) ?? null
    : null;

  const [runner, sourceSession, jobRows] = await Promise.all([
    job?.runnerId
      ? prisma.runner.findFirst({ where: { id: job.runnerId, ownerId }, select: { name: true } })
      : Promise.resolve(null),
    // 0424: `job.session_id` is a history reference with no relation. A purged source session is
    // the NULL the column's old writer would have produced, never a 404 or a 500.
    job?.sessionId
      ? prisma.session.findFirst({ where: { id: job.sessionId }, select: { id: true } })
      : Promise.resolve(null),
    prisma.projectIntegrationJob.findMany({
      where: { landingId: landing.id },
      select: { id: true },
    }),
  ]);

  const todos = await readLandingTodos(prisma, ownerId, {
    projectId: landing.projectId,
    taskId: landing.taskId,
    promotionId: landing.promotionId,
    jobIds: jobRows.map((row) => row.id),
  });

  const generations = await prisma.projectLanding.findMany({
    where: landing.subject === 'TASK'
      ? { ownerId, subject: 'TASK', taskId: landing.taskId }
      : { ownerId, subject: 'PROMOTION', projectId: landing.projectId, codebaseId: landing.codebaseId },
    orderBy: [{ episode: 'asc' }, { openedAt: 'asc' }],
    select: { sessionId: true, episode: true, openedAt: true, settledAt: true, settledAs: true },
  });

  // §2.9 LS2/LS4: the ordered timeline — one section per attempt, the facts each recorded, and the
  // lines derived from the rows that kept the decisions. Read-only and bounded.
  const timeline = await readLandingTimeline(prisma, landing);

  const checks = Array.isArray(job?.checks)
    ? (job!.checks as unknown as Array<Record<string, unknown>>)
    : [];
  const phase = (job?.phase as IntegrationJobPhase | null) ?? null;

  const currentAttempt: SessionLandingAttempt<Date> | null = job
    ? {
        jobId: job.id,
        kind: job.kind as IntegrationJobKind,
        state: job.state,
        generation: job.generation,
        phase,
        round: job.round ?? null,
        step: job.step ?? null,
        claim: Number(job.claimGeneration),
        runnerName: runner?.name ?? null,
        sourceSessionId: sourceSession ? job.sessionId : null,
        targetRef: job.targetRef,
        startedAt: job.claimedAt ?? job.createdAt,
        heartbeatAt: job.heartbeatAt,
        outputMovedAt: job.outputMovedAt,
        progressProtocol: job.progressProtocol,
        check: inFlight?.check ?? null,
        liveness: (inFlight?.liveness as IntegrationJobLiveness | null | undefined) ?? null,
        blockingReason: inFlight?.blockingReason ?? null,
        timedOut: inFlight?.timedOut ?? false,
        limitSeconds: inFlight?.limitSeconds ?? null,
        // The doors' own facts (§2.9 LS6): the queue's Retry applicability, and J-T4's push
        // boundary computed from the row exactly as the stop and cancel doors compute it. The
        // page reads these rather than re-deriving either rule.
        retryable: inFlight?.retryable ?? false,
        pushBoundaryPassed: pushBoundaryPassed(job),
      }
    : null;

  return {
    sessionId: landing.sessionId,
    projectId: landing.projectId,
    subject: landing.subject as 'TASK' | 'PROMOTION',
    taskId: landing.taskId,
    promotionId: landing.promotionId,
    episode: landing.episode,
    openedAt: landing.openedAt,
    settledAt: landing.settledAt,
    settledAs: landing.settledAs,
    phase,
    round: job?.round ?? null,
    checks,
    liveness: currentAttempt?.liveness ?? null,
    blockingReason: currentAttempt?.blockingReason ?? null,
    currentAttempt,
    todos,
    generations,
    timeline,
  };
}

/** The subject's OPEN integration items: what the landing page lists as its todos (LS4 — the item
 *  keeps its own card and assignee; the landing only shows that it is waiting).
 *
 *  Only the INTEGRATION_* kinds, only while still OWED (`openItemOwed`), and only an item about the
 *  subject's task, about the candidate the landing row names, or about a job of this landing: the
 *  same filters and the same three tiers the session row's AWAITING_DECISION asks
 *  (`SessionsService`'s LANDING subquery), so every todo the page lists is one that subquery would
 *  also count while the landing is unsettled. A settled generation is not held to it: the row
 *  answers SETTLED before it asks anything, and the task tier matches every episode of the task,
 *  so a settled generation can still list its task's owed items from a later episode. The candidate
 *  tier is what finds an item about one of the candidate's jobs queued before 0436, whose
 *  `landing_id` is NULL and so is no job of this landing. Another kind about the same task (a
 *  delivery review, a task failure) is not the landing's to show, and an integration item whose
 *  candidate left the live states, or whose task was cancelled or replaced, is owed by nobody
 *  however OPEN it reads. */
async function readLandingTodos(
  prisma: PrismaService,
  ownerId: string,
  subject: { projectId: string; taskId: string | null; promotionId: string | null; jobIds: string[] },
): Promise<SessionLandingTodo<Date>[]> {
  const tiers = [
    ...(subject.taskId ? [Prisma.sql`item."task_id" = ${subject.taskId}::uuid`] : []),
    ...(subject.promotionId ? [Prisma.sql`item."promotion_id" = ${subject.promotionId}::uuid`] : []),
    ...(subject.jobIds.length > 0
      ? [Prisma.sql`item."integration_job_id" IN (${Prisma.join(subject.jobIds.map((id) => Prisma.sql`${id}::uuid`))})`]
      : []),
  ];
  if (tiers.length === 0) return [];
  return prisma.$queryRaw<SessionLandingTodo<Date>[]>(Prisma.sql`
    SELECT item."id", item."kind", item."state", item."title", item."waiting_since" AS "waitingSince"
      FROM "project_open_item" item
     WHERE item."owner_id" = ${ownerId}::uuid
       AND item."project_id" = ${subject.projectId}::uuid
       AND item."state" = 'OPEN'
       AND item."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS)})
       AND (${Prisma.join(tiers, ' OR ')})
       AND ${openItemOwed('item')}
     ORDER BY item."waiting_since" ASC, item."id" ASC`);
}
