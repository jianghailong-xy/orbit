import { BadRequestException } from '@nestjs/common';
import { AgentProvider, openCodeKeyOf, type PlanUsageSnapshot } from '@orbit/shared';
import type { ModelProvider, Prisma } from '@prisma/client';
import type { UsageProviderRow } from '../providers/plan-usage.service';
import {
  accountPoolRuntime,
  adminOnlyProviderRefusal,
  isBuiltinProvider,
  openCodeKeyRows,
  resolveProviderExec,
  type ModelProviderRow,
} from '../providers/custom-provider';
import { dispatchKeyRow } from '../providers/engine-provider';
import { withKeyGatewayToken } from '../providers/key-gateway';
import { isPoolCandidate, poolUnavailableReason } from '../providers/pool-admission';
import { choosePoolMember } from '../providers/pool-select';
import { sessionEngine } from '../providers/session-engine';
import type { QueueService } from '../queue/queue.service';
import { ADMIN_ONLY_PROVIDER_ERROR, PROVIDER_UNAVAILABLE_ERROR } from './runner-provider-support';

/**
 * The session's credential as dispatch would resolve it now (resolveProviderExec): the key its slug names,
 * or the member of its account pool the claim would choose, recorded as the claim records it. Read by a
 * provider-switch reload (RunnerApiController.reloadProviderEnv) and by a SubAgent run on the parent's own
 * engine and credential (RunnerSubagentsController). Empty when the session is gone; `refusal` when nothing
 * can run its credential, in the claim's words.
 *
 * With `target`, the same read for another engine, provider and model on this session's runner: a SubAgent's
 * routed pick, or its next candidate after its account hit a limit (docs/subagent-design.md §4.2, §4.3). A
 * built-in engine's sign-in, a key the owner configured, or a Claude account pool of the owner's own, whose
 * member is chosen for the SubAgent alone (subagentPoolMember) and handed back as `poolMember` for its
 * `subagent_run` row — nothing is written onto the session, which is the parent's. A Codex pool is refused:
 * its gateway sends each request on the account its session row names, so it cannot carry a member of its own.
 */
export async function sessionProviderExec(
  tx: Prisma.TransactionClient,
  queue: Pick<QueueService, 'resolveLoginPool' | 'resolvePoolMember' | 'resolveSharedPool'>,
  sessionId: string,
  target?: { engine: string; provider: string; model: string },
  planUsage?: PoolMemberUsageReader | null,
): Promise<{
  exec?: ReturnType<typeof resolveProviderExec>;
  customRow?: ModelProviderRow | null;
  refusal?: string;
  poolMember?: SubagentPoolMemberChoice;
}> {
  const read = await tx.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      ownerId: true,
      model: true,
      provider: true,
      providerBuiltin: true,
      engine: true,
      poolMemberProviderId: true,
      poolKeyId: true,
      poolCodexAccountId: true,
      usesRuntimeDefaultModel: true,
      codexAccount: true,
      claudeAccount: true,
      antigravityAccount: true,
      kimiAccount: true,
      cursorAccount: true,
      workspace: {
        select: {
          model: true, env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true, kimiAccount: true,
          cursorAccount: true,
        },
      },
      assignedRunner: {
        select: {
          runtimeDefaultModels: true, modelCatalog: true, engines: true, defaultRemoved: true, accountPauses: true,
          planUsage: true,
        },
      },
    },
  });
  if (!read) return {};
  const session = target
    ? {
      ...read,
      provider: target.provider,
      providerBuiltin: (Object.values(AgentProvider) as string[]).includes(target.provider),
      engine: target.engine,
      model: target.model,
      usesRuntimeDefaultModel: false,
      poolMemberProviderId: null,
      poolKeyId: null,
      poolCodexAccountId: null,
    }
    : read;
  // The claim's words for a credential nothing holds: a member's session on a shared provider is told
  // only an admin can run it, any other to check the configuration — asked of the slug the credential
  // names, which on OpenCode is the key its model names.
  const unavailable = async (customRow: unknown): Promise<string> => {
    const slug = !isBuiltinProvider(session.provider, session.providerBuiltin)
      ? session.provider
      : session.provider === AgentProvider.OPENCODE ? openCodeKeyOf(session.model)?.slug : undefined;
    return !customRow && slug && (await adminOnlyProviderRefusal(tx, session.ownerId, slug))
      ? ADMIN_ONLY_PROVIDER_ERROR
      : PROVIDER_UNAVAILABLE_ERROR;
  };
  // The environment is built for the engine the session runs on — the one it was spawned with and
  // is re-spawned with now — from wherever its credential now comes from: a switch moves the
  // credential, never the engine.
  const engine = await sessionEngine(tx, session);
  if (!engine) return { refusal: await unavailable(null) };
  // As on the claim: the key the slug names or a retired name of one, and a legacy built-in dsh
  // session's default DeepSeek key when its workspace holds no key itself.
  // Claude Code on an OpenAI key re-spawns on a token minted for this reload, as the claim mints one.
  const keyRow = await withKeyGatewayToken(tx, session, engine, await dispatchKeyRow(tx, session, session.workspace?.env));
  let poolMember: SubagentPoolMemberChoice | undefined;
  let memberRow: ModelProvider | null = null;
  if (target && !keyRow && !isBuiltinProvider(session.provider, session.providerBuiltin)) {
    const chosen = await subagentPoolMember(tx, session.ownerId, target.provider, planUsage ?? null);
    if ('refusal' in chosen) return { refusal: chosen.refusal };
    memberRow = chosen.row;
    poolMember = { providerId: chosen.row.id, label: chosen.row.label };
  }
  const customRow = isBuiltinProvider(session.provider, session.providerBuiltin)
    ? keyRow
    : (keyRow ?? memberRow ??
      (await queue.resolveLoginPool(tx, session, session.provider!, false, engine)) ??
      (await queue.resolvePoolMember(tx, session, session.provider!)) ??
      (await queue.resolveSharedPool(tx, session, session.provider!)));
  // As on the claim: a Claude pool of the owner's own that none of its members can run re-spawns on
  // the Claude default, as the line resolvePoolMember owed says; any other slug nothing holds is refused.
  const poolFallback = !customRow && !isBuiltinProvider(session.provider, session.providerBuiltin)
    && (await accountPoolRuntime(tx, session.ownerId, session.provider!)) === AgentProvider.CLAUDE;
  let exec: ReturnType<typeof resolveProviderExec>;
  try {
    exec = resolveProviderExec({
      engine,
      declaredProvider: poolFallback ? AgentProvider.CLAUDE : session.provider,
      declaredProviderBuiltin: poolFallback || session.providerBuiltin,
      customRow,
      openCodeKeys:
        session.provider === AgentProvider.OPENCODE && openCodeKeyOf(session.model)
          ? await openCodeKeyRows(tx, session.ownerId)
          : undefined,
      sessionModel: session.model,
      usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
      runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
      workspaceModel: session.workspace?.model,
      modelCatalog: session.assignedRunner?.modelCatalog,
      workspaceEnv: session.workspace?.env as Record<string, string> | null,
      codexAccount: session.codexAccount ?? session.workspace?.codexAccount,
      claudeAccount: session.claudeAccount ?? session.workspace?.claudeAccount,
      antigravityAccount: session.antigravityAccount ?? session.workspace?.antigravityAccount,
      kimiAccount: session.kimiAccount ?? session.workspace?.kimiAccount,
      cursorAccount: session.cursorAccount ?? session.workspace?.cursorAccount,
      runner: session.assignedRunner,
    });
  } catch (error) {
    // Every refusal it makes is of the credential: gone, disabled, on a runtime no engine speaks, or
    // one this session's engine cannot run — which last the claim and the reclaim say in its own words.
    if (!(error instanceof BadRequestException)) throw error;
    const refusal = error.getResponse() as { code?: string; message?: string };
    return {
      refusal: refusal.code === 'PROVIDER_ENGINE_INCOMPATIBLE' && refusal.message
        ? refusal.message
        : await unavailable(customRow),
    };
  }
  return { exec, customRow, ...(poolMember ? { poolMember } : {}) };
}

/** The member of an account pool a SubAgent runs on, recorded on its `subagent_run` attempt. */
export interface SubagentPoolMemberChoice {
  providerId: string;
  label: string;
}

/** What choosing a member reads of ProviderPlanUsageService: each member's cached quota and its standing. */
export interface PoolMemberUsageReader {
  snapshot(row: UsageProviderRow): PlanUsageSnapshot | null;
  usageStanding(row: UsageProviderRow): string | null;
}

/**
 * The member of the owner's own Claude account pool `slug` a SubAgent runs on, chosen as a claim would
 * (choosePoolMember: the member with room whose window resets soonest, else the one spent the least) but
 * with no member to stay on and nothing written: a SubAgent's choice is its own, not its parent session's.
 * Refused, with why, for a slug that names no such pool, a Codex pool, or a pool none of whose members can run.
 */
export async function subagentPoolMember(
  tx: Prisma.TransactionClient,
  ownerId: string,
  slug: string,
  planUsage: PoolMemberUsageReader | null,
  now = new Date(),
): Promise<{ row: ModelProvider } | { refusal: string }> {
  const pool = await tx.providerPool.findFirst({
    where: { slug, ownerId, shared: false },
    select: {
      label: true,
      engine: true,
      members: { where: { ownerId }, orderBy: { provider: { slug: 'asc' } }, select: { provider: true, pausedUntil: true } },
    },
  });
  const codex = pool?.engine === AgentProvider.CODEX
    || (!pool && (await tx.providerPool.count({ where: { slug, engine: AgentProvider.CODEX, people: { some: { userId: ownerId } } } })) > 0);
  if (codex) {
    return { refusal: `${slug} is a Codex account pool, whose gateway runs on the session's own account; a SubAgent cannot run on it` };
  }
  if (!pool) return { refusal: `${slug} names no provider or account pool this account has` };
  const rows = pool.members.map((member) => ({ ...member.provider, pausedUntil: member.pausedUntil }));
  const candidates = rows.filter(isPoolCandidate).map((row) => {
    const standing = planUsage?.usageStanding(row) ?? null;
    return {
      row,
      pausedUntil: row.pausedUntil,
      usage: planUsage?.snapshot(row) ?? null,
      refused: standing === 'KEY_REFUSED',
      usageUnreadable: standing === 'USAGE_UNKNOWN',
    };
  });
  const row = choosePoolMember(candidates, null, now);
  if (row) return { row };
  return {
    refusal: candidates.some((c) => c.pausedUntil && c.pausedUntil > now)
      ? `every account in the pool "${pool.label}" that can run is paused`
      : poolUnavailableReason(pool.label, rows),
  };
}
