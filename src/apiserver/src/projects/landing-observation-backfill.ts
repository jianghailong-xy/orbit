import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { lockOwnerTaskGraph, orderedIds } from '../common/lock-order';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { queueLandingObservation, type ObservationQueued } from './landing-observation';
import { isCodeTaskSql, lineStartedSql, taskLandingSql } from './project-criterion-landing';
import { settleDeliveredIdentity, type DeliveredIdentitySettlement } from './project-integration-job';

/**
 * The deploy-time pass of revision 29 (`docs/project-integration-line-contract.md` §10.9 「迁移」 2):
 * the tasks written DONE before delivered identities existed are given one, and their projects one
 * observation, so that work already on the line is recorded as landed and what waits on it is let go.
 *
 * WHAT IT DOES. For every project whose line has started (§1.1 `lineStarted`) and that has a DONE code
 * task (`isCodeTask`) not known to be on the line (§1.4 `NOT_KNOWN`) whose identity was never frozen:
 * freezes that identity from the rows as they stand (O-L4, `settleDeliveredIdentity`) — only for work
 * that has stopped moving and names its commit; work still moving is frozen by its own finish, and an
 * identity nobody can name stays unfrozen, as it would at a DONE — then queues ONE `OBSERVE_LANDING`
 * for the project (`trigger: DEPLOY`), or folds into the one already queued. The observation does the
 * rest: what it sees gets its receipt (O-R1), whose M-T13 retires the BLOCKED candidates and whose
 * commit lets J10 start what waited; on a PLATFORM project's main, this round's O-R3 is one
 * `LANDED_WITHOUT_CONFIRMATION` for the project (`UL:backfill:<projectId>`, `answersDeployRound`).
 *
 * WHAT IT DOES NOT DO. No history is rewritten and no receipt invented: it writes the five identity
 * columns of the tasks it freezes (and what a freeze writes beside them anywhere, O-L5's naming of a
 * candidate still waiting for its check), and the observation. Nothing it cannot read from committed
 * rows is guessed.
 *
 * WHY IT IS SAFE TO RUN ON EVERY START. Every write is conditioned on the state it changes: an identity
 * is frozen only while `delivered_at` is NULL (a compare-and-set), and an observation is queued only for
 * a project this run froze something in — so a second run over the same rows freezes nothing and queues
 * nothing, and a run after an older replica wrote a DONE meanwhile freezes just that one. One project is
 * one transaction, so a run that died half-way leaves each project either done or untouched, and the
 * next start finishes it. One run at a time across replicas: a session-level advisory lock on a
 * connection of its own (`LANDING_OBSERVATION_BACKFILL_LOCK`), held for the whole run, so a second
 * replica starting beside the first waits for it and then finds nothing left — and if both ran anyway,
 * the per-task compare-and-set and the project's one queued observation (§10.4's partial unique index,
 * under the binding's row lock) would still leave one of each.
 *
 * No clock (G3): it runs when the server starts (`LandingObservationBackfillAtBoot`), and never again
 * in that process.
 */

/** The advisory lock every run holds (hashtextextended of this, seed 0). */
export const LANDING_OBSERVATION_BACKFILL_LOCK = 'landing-observation-backfill';
/** How long a start waits for another replica's run before it boots without one. */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

const logger = new Logger('LandingObservationBackfill');

/** What the pass did for one project. */
export interface LandingBackfillProject {
  projectId: string;
  /** The tasks whose delivered identity this run froze. */
  frozen: string[];
  /** The tasks it left unfrozen, and why: work still moving, an identity nobody can name, or a task
   *  that stopped qualifying between the read and its lock. */
  left: Array<{ taskId: string; settlement: DeliveredIdentitySettlement }>;
  /** The observation queued for the project (`queued: false` when it folded into the one queued),
   *  or null when this run froze nothing there. */
  observation: ObservationQueued | null;
}

export interface LandingBackfillResult {
  projects: LandingBackfillProject[];
  /** Projects whose transaction failed, left for the next start. */
  failures: Array<{ projectId: string; error: string }>;
}

export interface LandingBackfillOptions {
  /** The database the advisory lock is held on, over a connection of its own. */
  databaseUrl: string;
  log?: Pick<Logger, 'log' | 'warn' | 'error'>;
  lockTimeoutMs?: number;
}

/** One task the pass looks at: DONE, code work of a started line, not known to be on it, unfrozen. */
interface BackfillCandidate {
  taskId: string;
  ownerId: string;
  projectId: string;
}

/**
 * The pass, under its advisory lock. Each project in a retried transaction of its own; one that fails
 * is logged and left for the next start, and does not stop the others.
 */
export async function runLandingObservationBackfill(
  prisma: PrismaService,
  options: LandingBackfillOptions,
): Promise<LandingBackfillResult> {
  const log = options.log ?? logger;
  const unlock = await lockBackfill(options);
  try {
    const byProject = new Map<string, { ownerId: string; taskIds: string[] }>();
    for (const candidate of await readBackfillCandidates(prisma)) {
      const project = byProject.get(candidate.projectId) ?? { ownerId: candidate.ownerId, taskIds: [] };
      project.taskIds.push(candidate.taskId);
      byProject.set(candidate.projectId, project);
    }
    const result: LandingBackfillResult = { projects: [], failures: [] };
    for (const [projectId, { ownerId, taskIds }] of byProject) {
      try {
        result.projects.push(await withTransactionRetry(
          prisma,
          (tx) => backfillProject(tx, { ownerId, projectId, taskIds }),
          loggedRetry(logger, 'landingObservationBackfill.project'),
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push({ projectId, error: message });
        log.error(`landing backfill of project ${projectId} failed and is left for the next start: ${message}`);
      }
    }
    const frozen = result.projects.reduce((sum, project) => sum + project.frozen.length, 0);
    const observed = result.projects.filter((project) => project.observation !== null).length;
    if (byProject.size > 0) {
      log.log(`landing backfill: ${byProject.size} project(s) with unfrozen finished work, ${frozen} `
        + `identit${frozen === 1 ? 'y' : 'ies'} frozen, ${observed} observation(s) queued, `
        + `${result.failures.length} failed`);
    }
    return result;
  } finally {
    await unlock();
  }
}

/**
 * The tasks the pass looks at, by project: DONE, in a project whose line has started, code work of
 * that line (O-L7's repository condition included), not known to be on it, and never frozen. Read
 * without locks — each project's transaction locks its own and re-reads every condition there.
 */
export function readBackfillCandidates(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<BackfillCandidate[]> {
  return db.$queryRaw<BackfillCandidate[]>(Prisma.sql`
    SELECT t."id" AS "taskId", t."owner_id" AS "ownerId", t."project_id" AS "projectId"
      FROM "task" t
     WHERE t."status" = 'DONE'
       AND t."delivered_at" IS NULL
       AND t."project_id" IS NOT NULL
       AND ${Prisma.raw(lineStartedSql('t'))}
       AND ${Prisma.raw(isCodeTaskSql('t'))}
       AND (${Prisma.raw(taskLandingSql('t'))}) = 'NOT_KNOWN'
     ORDER BY t."project_id", t."id"`);
}

/**
 * One project, in one transaction: freeze what can be frozen (O-L4), then queue the one observation
 * (§10.9). Locks in rank order before the first write (`common/lock-order.ts`): the owner's graph mutex
 * (10, I1 — several task rows are written), the project FOR KEY SHARE (40), the tasks FOR NO KEY UPDATE
 * in id order in one statement (50 — the mode each freeze's UPDATE takes), and the binding FOR UPDATE
 * (55) — the DONE transaction's shape — before the first rank-60 write: the candidate a freeze names
 * by its commit (O-L5), the observation and its enqueue fact.
 */
export async function backfillProject(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; taskIds: readonly string[] },
): Promise<LandingBackfillProject> {
  const taskIds = orderedIds(input.taskIds);
  await lockOwnerTaskGraph(tx, input.ownerId);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "project" WHERE "id" = ${input.projectId}::uuid FOR KEY SHARE`);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "task" WHERE "id" = ANY(${taskIds}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "project_codebase"
     WHERE "project_id" = ${input.projectId}::uuid AND "slot" = 'primary'
       FOR UPDATE`);

  const frozen: string[] = [];
  const left: LandingBackfillProject['left'] = [];
  for (const taskId of taskIds) {
    // Read again under the locks: a task reopened, landed or frozen since the scan answers for itself.
    const settlement = await settleDeliveredIdentity(tx, { ownerId: input.ownerId, taskId, after: 'DEPLOY' });
    if (settlement === 'FROZEN') frozen.push(taskId);
    else left.push({ taskId, settlement });
  }
  const observation = frozen.length > 0
    ? await queueLandingObservation(tx, { ownerId: input.ownerId, projectId: input.projectId, trigger: 'DEPLOY' })
    : null;
  return { projectId: input.projectId, frozen, left, observation };
}

/** Hold the pass's advisory lock on a connection of its own until the returned release. */
async function lockBackfill(options: LandingBackfillOptions): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const timeout = Math.max(1, Math.trunc(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
    await client.query(`SET lock_timeout = ${timeout}`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [LANDING_OBSERVATION_BACKFILL_LOCK]);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LANDING_OBSERVATION_BACKFILL_LOCK]);
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}
