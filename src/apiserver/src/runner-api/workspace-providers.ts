import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentProvider, toUuid } from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { subagentCandidateRefusal, subagentPairVerdicts } from '../tasks/model-routing';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { subagentRouteInput, type SubagentPlanUsageReader } from './subagent-route';

/** One provider × engine as a workspace's runner stands toward it. */
export interface WorkspaceProviderPair {
  provider: string;
  engine: string;
  /** A built-in engine's own sign-in on the runner, rather than a configured key or pool. */
  builtin: boolean;
  usable: boolean;
  /** Why not, in one line; absent when usable. */
  reason?: string;
  /** The models usable there: the provider's own, else what the runner reports for the engine. Empty when not usable. */
  models: string[];
  /** The pair the workspace's sessions start on when none is named. */
  default?: true;
}

export interface WorkspaceProviderView {
  workspace: { id: string; name: string };
  runner: { name: string; online: boolean };
  /** What the workspace's sessions start on when none is named (its seed), and whether its runner can run it. */
  default: { provider: string; engine: string | null; model: string | null; usable: boolean; reason?: string };
  pairs: WorkspaceProviderPair[];
}

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** The owner's workspace `named` names: by name first, as delegate's `workspace` does, else by its id. */
async function ownWorkspace(db: Prisma.TransactionClient, ownerId: string, named: string) {
  const select = { id: true, name: true, runnerId: true } as const;
  const byName = await db.workspace.findFirst({
    where: { ownerId, name: named, deletedAt: null },
    orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
    select,
  });
  if (byName) return byName;
  let id: string | null = null;
  try {
    id = toUuid(named);
  } catch {
    id = null;
  }
  return id ? db.workspace.findFirst({ where: { id, ownerId, deletedAt: null }, select }) : null;
}

/**
 * provider_list with `workspace`: every provider × engine of the owner's, judged against that workspace's runner by
 * the reads and checks a remote delegate to it uses (planRemoteSubagent): subagentRouteInput read for that workspace
 * and runner, subagentPairVerdicts for each pair, and subagentCandidateRefusal for its default — so this cannot call
 * a pair usable that the delegate refuses. Each pair carries the models it lists when usable, and the workspace's
 * default is marked. Reads only. A workspace that is not the caller's, or does not exist, is refused alike.
 */
export async function workspaceProviderView(
  db: Prisma.TransactionClient,
  args: { ownerId: string; workspace: string; planUsage?: SubagentPlanUsageReader | null; now?: Date },
): Promise<WorkspaceProviderView> {
  const named = args.workspace.trim();
  const workspace = named ? await ownWorkspace(db, args.ownerId, named) : null;
  if (!workspace) {
    throw refusal(HttpStatus.NOT_FOUND, 'WORKSPACE_NOT_FOUND', `No workspace named or with id "${named}" in this account.`);
  }
  const runner = workspace.runnerId
    ? await db.runner.findFirst({
      where: { id: workspace.runnerId, ownerId: args.ownerId },
      select: { name: true, displayName: true, status: true, ...RUNNER_BEATS },
    })
    : null;
  if (!workspace.runnerId || !runner) {
    throw refusal(HttpStatus.CONFLICT, 'WORKSPACE_HAS_NO_RUNNER', `${workspace.name} has no runner, so nothing can run there.`);
  }
  const runnerName = runner.displayName || runner.name;
  const seed = await agentProviderSeed(db, workspace.id);
  const input = await subagentRouteInput(db, {
    ownerId: args.ownerId,
    workspaceId: workspace.id,
    runnerId: workspace.runnerId,
    // Nothing is routed here: only the reads and the pair checks of the input are used.
    dto: { toolUseId: '', type: 'general', definitionSource: 'builtin' },
    parent: { engine: seed.engine ?? seed.provider, provider: seed.provider, model: '', effort: null },
    planUsage: args.planUsage ?? null,
    now: args.now,
    runnerLabel: runnerName,
  });

  // subagentPairVerdicts walks input.providers in order, each engine in turn; the built-in sign-ins come first.
  const builtinCount = Object.values(AgentProvider).length;
  const verdicts = subagentPairVerdicts(input);
  const pairs: WorkspaceProviderPair[] = [];
  let cursor = 0;
  input.providers.forEach((provider, index) => {
    const own = verdicts.slice(cursor, cursor + provider.engines.length);
    cursor += provider.engines.length;
    // provider_list names only what is in scope: a shared provider outside it is not one this caller can pass.
    if (!provider.inScope) return;
    for (const verdict of own) {
      pairs.push({
        provider: verdict.provider,
        engine: verdict.engine,
        builtin: index < builtinCount,
        ...(verdict.reason !== undefined
          ? { usable: false, reason: verdict.reason, models: [] }
          : { usable: true, models: verdict.models }),
      });
    }
  });
  // The default as a remote delegate judges it: the first provider of that slug, on the seed's engine.
  const start = seed.engine ? pairs.find((pair) => pair.provider === seed.provider && pair.engine === seed.engine) : undefined;
  if (start) start.default = true;
  const defaultRefusal = seed.engine ? subagentCandidateRefusal(input, seed.provider, seed.engine) : null;
  const missing = start ? null : `${seed.provider} is not a provider this account can run${seed.engine ? ` on ${seed.engine}` : ''}`;
  const reason = defaultRefusal ?? missing;

  return {
    workspace: { id: workspace.id, name: workspace.name },
    runner: { name: runnerName, online: runnerIsOnline(runner, (args.now ?? new Date()).getTime()) },
    default: {
      provider: seed.provider,
      engine: seed.engine,
      model: seed.model ?? null,
      usable: reason === null,
      ...(reason !== null ? { reason } : {}),
    },
    pairs,
  };
}
