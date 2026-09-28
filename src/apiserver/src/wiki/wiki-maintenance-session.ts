import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  PermissionMode,
  WIKI_MAINTENANCE_RUN,
  wikiMaintenanceSettings,
  type AgentExecConfig,
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

type RunReader = Pick<Prisma.TransactionClient, 'session' | 'wikiSpace' | 'modelProvider' | 'providerPool'>;

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
  let why: string | null = null;
  if (!settings.enabled) {
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
 * How many maintenance tasks a space has made today (the UTC day `now` is in) against its daily limit
 * (contract `space.settings.maintenance.keys.dailyRunLimit`): every task of its maintenance list made
 * since midnight UTC, however it ended. The maintenance job asks it before it makes another.
 */
export async function wikiMaintenanceRunsToday(
  db: Pick<Prisma.TransactionClient, 'wikiSpace' | 'task'>,
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
  const used = settings.listId
    ? await db.task.count({ where: { ownerId, listId: settings.listId, createdAt: { gte: since } } })
    : 0;
  return {
    limit: settings.dailyRunLimit,
    used,
    remaining: Math.max(0, settings.dailyRunLimit - used),
    since: since.toISOString(),
  };
}
