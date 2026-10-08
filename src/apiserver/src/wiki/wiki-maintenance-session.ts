import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  PermissionMode,
  WIKI_MAINTENANCE_CATCH_UP,
  WIKI_MAINTENANCE_RUN,
  wikiMaintenanceBehind,
  wikiMaintenanceSettings,
  type AgentExecConfig,
  type WikiMaintenanceCatchUp,
  type WikiMaintenanceRun,
} from '@orbit/shared';
import { wikiMaintenanceProviderProblem, wikiMaintenanceSpaceOf } from './wiki-maintenance-settings';

/**
 * The run a Wiki maintenance session is claimed with (design §8.2, contracts/wiki.contract.json
 * `maintenance.run`).
 *
 * A maintenance session (`isWikiMaintenanceSession`) is not started the way its workspace starts any
 * other: the claim, and the reclaim a restarted runner rebuilds it from, hand the runner an explicit run —
 * the provider and workspace the space's maintenance settings name, no provider to fall back to, 120 model
 * turns, no sub-agents and no web, and the clean start (runner-go wiki_maintenance_session.go): a bare
 * Claude Code with an empty HOME and config directory that carries a few thousand tokens a request instead
 * of the sixty thousand an Orbit session carries.
 *
 * PINNED, OR NOT STARTED. The settings name one provider, and the run is on it or on nothing: a slug
 * nothing holds, a provider turned off, a session that names another provider or sits in another
 * workspace, all end the run before an engine starts (`refusal`) instead of dispatching it where an
 * ordinary session would go — on the runner's own Claude login. And the provider must borrow the Claude
 * Code runtime: the codex path ignores disallowedTools, and a clean start reads no login, only an
 * endpoint's key, so a built-in engine or an account pool of sign-ins cannot carry one either.
 *
 * ONLY A RUNNER THAT KNOWS IT. A runner that does not declare `wiki-maintenance-run/v1` would start the
 * session as an ordinary one, so the claim does not offer it such a row (`wikiMaintenanceSessionSql`) and
 * the reclaim leaves it out, the way a pinned SOURCE is withheld from a runner that cannot pin (SR35).
 */

type RunReader = Pick<Prisma.TransactionClient, 'session' | 'wikiSpace' | 'modelProvider' | 'providerPool' | 'wikiPlanJob' | 'user'>;

/**
 * The run a session is claimed with when it is a maintenance session, or null for every other session.
 * A run that may not start carries its `refusal`: the runner ends it FAILED with that and starts nothing.
 */
export async function wikiMaintenanceRunOf(
  db: RunReader,
  session: { id: string; taskId: string | null; workspaceId: string | null; provider: string | null },
): Promise<WikiMaintenanceRun | null> {
  if (!session.taskId) return null;
  const maintained = await wikiMaintenanceSpaceOf(db, session.id);
  if (!maintained) return null;
  const space = await db.wikiSpace.findFirst({ where: { id: maintained.spaceId }, select: { settings: true } });
  const stored = space?.settings !== null && typeof space?.settings === 'object' && !Array.isArray(space.settings)
    ? (space.settings as Record<string, unknown>).maintenance
    : undefined;
  const settings = wikiMaintenanceSettings(stored);
  const run: WikiMaintenanceRun = {
    spaceId: maintained.spaceId,
    workspaceId: settings.workspaceId,
    provider: settings.provider,
    providerFallbacks: [],
    maxTurns: WIKI_MAINTENANCE_RUN.maxTurns,
    disallowedTools: [...WIKI_MAINTENANCE_RUN.disallowedTools],
    cleanStart: true,
  };
  const named = session.provider ?? AgentProvider.CLAUDE;
  // A plan job's task (contract `plan.jobs.task`) runs in the maintenance list whether or not maintenance
  // is on: a space is drafted a plan before its owner turns maintenance on. Everything else holds for it.
  const planJob = (await db.wikiPlanJob.findFirst({ where: { taskId: session.taskId }, select: { id: true } })) !== null;
  let why: string | null = null;
  if (!settings.enabled && !planJob) {
    why = "maintenance is off in its space: the owner turned it off after this run was made";
  } else if (!settings.workspaceId || settings.workspaceId !== session.workspaceId) {
    why = "it runs only in the workspace its space's maintenance settings name, and this session is in another one";
  } else if (named !== settings.provider) {
    why = `it runs only on the provider its space's maintenance settings pin, '${settings.provider}', and this session `
      + `names '${named}'`;
  } else {
    why = (await wikiMaintenanceProviderProblem(db, maintained.ownerId, settings.provider))?.why ?? null;
  }
  return why ? { ...run, refusal: `This Wiki maintenance run did not start: ${why}.` } : run;
}

/**
 * A claim or a reclaim with the maintenance run applied, or — for any other session — exactly as it was.
 * The guardrails go into the agent config too, where every runtime already reads them: the turn limit,
 * the tools the run may not have, and a permission mode that refuses what is not pre-approved rather
 * than asking nobody. A maintenance run orchestrates nothing and thinks only when told to.
 */
export function withWikiMaintenanceRun<
  T extends { agent: AgentExecConfig; allowOrchestration?: boolean; orchestrationToken?: string; wikiMaintenance?: WikiMaintenanceRun },
>(job: T, run: WikiMaintenanceRun | null): T {
  if (!run) return job;
  return {
    ...job,
    agent: {
      ...job.agent,
      maxTurns: run.maxTurns,
      disallowedTools: [...new Set([...job.agent.disallowedTools, ...run.disallowedTools])],
      permissionMode: PermissionMode.DONT_ASK,
      effort: undefined,
    },
    allowOrchestration: false,
    orchestrationToken: undefined,
    wikiMaintenance: run,
  };
}

/**
 * What every maintenance session's task tells its model of the one Bash call that is its whole run (contract
 * `maintenance.run.bashCall`): the timeout to give it. The clean start gives a call that names none five hours
 * already, but a timeout the call names wins, and a model names one of its own unless told: on 2026-10-03 one
 * gave 600000 and was cut off at ten minutes.
 */
export const WIKI_RUN_BASH_TIMEOUT = `Give that Bash call \`timeout: ${WIKI_MAINTENANCE_RUN.bashTimeoutMs}\` (five hours), never a shorter one`;

/**
 * …and what to do when the tool comes back before the command has ended: not run it again — the run of
 * 2026-10-03 did, with 1800000, was cut off again, and spent its one retry on it — but report what it printed
 * and end. `next` says what picks the work up.
 */
export function wikiRunCutOff(next: string): string {
  return 'If the Bash tool comes back before the command has ended — it timed out, or was cut off — do not run it '
    + 'again, with this timeout or any other, and spend no retry on it: report what it printed up to there, say it '
    + `was cut off, and end; ${next}`;
}

/**
 * SQL: the session row `sessionAlias` is a maintenance session — `isWikiMaintenanceSession` in the form the
 * claim asks it, inside its locked statement, to withhold the row from a runner that cannot start it clean.
 */
export function wikiMaintenanceSessionSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "task" wm_task
      JOIN "wiki_space" wm_space ON wm_space."owner_id" = wm_task."owner_id"
       AND wm_space."settings" -> 'maintenance' ->> 'listId' = wm_task."list_id"::text
     WHERE wm_task."id" = ${s}."task_id"
       AND wm_task."owner_id" = ${s}."owner_id"
  )`;
}

/**
 * How many maintenance runs a space has made today (the UTC day `now` is in) against its daily limit
 * (contract `space.settings.maintenance.keys.dailyRunLimit`): counted per RUN — the tasks of its
 * maintenance list made since midnight UTC, however they ended, and the runs a wiki job ran (migration
 * 0401), which have no task and are found through their own rows. A plan job's task (contract `plan.jobs`)
 * is not a maintenance run and is not counted against the day, and a run made in catch-up that is not
 * counted either (contract `maintenance.job.catchUp.dailyLimit`): one pinned to a local endpoint, or one
 * that failed. The maintenance job asks it before it makes another.
 *
 * The task branch is the count this has always been, unchanged: a run made by a task is counted off its
 * task exactly as before, so the numbers a deployment computes today are the numbers it computed
 * yesterday, and a run made by a job is read off the row the design gives it.
 */
export async function wikiMaintenanceRunsToday(
  db: Pick<Prisma.TransactionClient, 'wikiSpace' | 'task' | 'wikiPlanJob' | 'wikiMaintenanceRun'>,
  ownerId: string,
  spaceId: string,
  now: Date = new Date(),
): Promise<{ limit: number; used: number; remaining: number; since: string }> {
  const space = await db.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { settings: true } });
  if (!space) throw new NotFoundException('no such wiki space');
  const stored = space.settings !== null && typeof space.settings === 'object' && !Array.isArray(space.settings)
    ? (space.settings as Record<string, unknown>).maintenance
    : undefined;
  const settings = wikiMaintenanceSettings(stored);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const planTasks = settings.listId
    ? (await db.wikiPlanJob.findMany({ where: { ownerId, spaceId, madeAt: { gte: since }, taskId: { not: null } }, select: { taskId: true } }))
      .map((job) => job.taskId as string)
    : [];
  // A run's row is made after its task, in the same transaction: one made since midnight covers every run of today's tasks.
  const uncounted = settings.listId
    ? (await db.wikiMaintenanceRun.findMany({
      where: {
        ownerId,
        spaceId,
        taskId: { not: null },
        catchUp: 'active',
        createdAt: { gte: since },
        OR: [{ localEndpoint: true }, { outcome: { in: ['failed', 'truncated'] } }],
      },
      select: { taskId: true },
    })).map((run) => run.taskId as string)
    : [];
  const left = [...planTasks, ...uncounted];
  const byTask = settings.listId
    ? await db.task.count({
      where: { ownerId, listId: settings.listId, createdAt: { gte: since }, ...(left.length > 0 ? { id: { notIn: left } } : {}) },
    })
    : 0;
  // The server path's runs: made by a wiki job, counted off the run row itself, under the same rules the
  // task branch has — not a catch-up run on a local endpoint, and not one that failed. A list is not
  // needed for them: a space the server executes makes no task (contract `maintenance.job.server`, P8).
  const byJob = await db.wikiMaintenanceRun.count({
    where: {
      ownerId,
      spaceId,
      jobId: { not: null },
      createdAt: { gte: since },
      NOT: { catchUp: 'active', OR: [{ localEndpoint: true }, { outcome: { in: ['failed', 'truncated'] } }] },
    },
  });
  const used = byTask + byJob;
  return {
    limit: settings.dailyRunLimit,
    used,
    remaining: Math.max(0, settings.dailyRunLimit - used),
    since: since.toISOString(),
  };
}

/** Where a space stands on catch-up (contract `maintenance.job.catchUp`). */
export interface WikiMaintenanceCatchUpRead {
  /** The oldest fact after the cursor is older than `catchUp.rules.behindHours`. */
  behind: boolean;
  /** How many of the space's latest runs that ended failed in a row, counted as far as the pause. */
  failures: number;
  /** null — not behind; `active` — behind and catching up; `paused` — behind, and its last runs all failed. */
  state: WikiMaintenanceCatchUp | null;
}

/**
 * Whether a space whose oldest fact after the cursor is `oldestPendingAt` is catching up at `now` (contract
 * `maintenance.job.catchUp`): behind is read off the facts, never waited for; paused, off the ends of its latest
 * runs — a run whose session died before it said how is given its end by the trigger before this is asked, and
 * counts — so a streak the cursor's own count never saw pauses it all the same.
 */
export async function wikiMaintenanceCatchUpOf(
  db: Pick<Prisma.TransactionClient, 'wikiMaintenanceRun'>,
  ownerId: string,
  spaceId: string,
  oldestPendingAt: Date | null,
  now: Date,
): Promise<WikiMaintenanceCatchUpRead> {
  if (!wikiMaintenanceBehind(oldestPendingAt, now)) return { behind: false, failures: 0, state: null };
  const ended = await db.wikiMaintenanceRun.findMany({
    where: { ownerId, spaceId, outcome: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: WIKI_MAINTENANCE_CATCH_UP.pauseAfterFailures,
    select: { outcome: true },
  });
  const succeeded = ended.findIndex((run) => run.outcome === 'succeeded');
  const failures = succeeded < 0 ? ended.length : succeeded;
  return { behind: true, failures, state: failures >= WIKI_MAINTENANCE_CATCH_UP.pauseAfterFailures ? 'paused' : 'active' };
}
