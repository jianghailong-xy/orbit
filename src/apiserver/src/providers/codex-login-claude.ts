import type { Prisma } from '@prisma/client';
import { AgentProvider, type EngineTableOptions } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelProviderRow } from './custom-provider';
import { poolGatewayUrl, POOL_LOGIN_TOKEN_PREFIX } from './shared-pool';

/**
 * Claude Code on the account owner's own Codex login pool (docs/claude-engine-openai-gateway-design.md §9,
 * decision D4 as amended on 2026-11-11): the deployment switch, which pools it covers, and the row dispatch
 * hands Claude Code in the pool's place. The pool's ChatGPT accounts stay in the API server: the engine gets
 * /api/gw/anthropic and the pool's own session token (`orbit-gwl-`), which names no account.
 */

/**
 * The deployment switch (D6), separate from ORBIT_CLAUDE_OPENAI_GATEWAY and read on every call so a spec can
 * turn it: `true` turns it on; absent, empty, `false` or anything else is off. Off, no pool's `engines` list or
 * dispatch environment differs from what it was before.
 */
export const CLAUDE_CODEX_LOGIN_FLAG = 'ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY';

export function claudeCodexLoginEnabled(): boolean {
  return process.env[CLAUDE_CODEX_LOGIN_FLAG]?.trim().toLowerCase() === 'true';
}

/** The compatibility table's options for a pool, as this deployment has them (shared providerEngines.ts). */
export function poolTableOptions(): EngineTableOptions {
  return claudeCodexLoginEnabled() ? { codexLoginGateway: true } : {};
}

/**
 * Whether `slug` names a Codex pool of `ownerId`'s own — not shared, made by them — the only pool Claude Code
 * may run on. Asked only with the switch on, so with it off nothing reads anything more than before.
 */
export async function isOwnCodexLoginPool(
  db: Prisma.TransactionClient | PrismaService,
  ownerId: string,
  slug: string,
): Promise<boolean> {
  if (!claudeCodexLoginEnabled()) return false;
  const pool = await db.providerPool.findFirst({
    where: { slug, ownerId, shared: false, engine: AgentProvider.CODEX },
    select: { id: true },
  });
  return pool !== null;
}

/**
 * What a Claude Code session on its owner's own Codex login pool dispatches as: the pool gateway's row
 * (shared-pool.ts sharedPoolExecRow) marked `codexLogin`, so the compatibility check reads it as that pool and
 * injectedEnv hands Claude Code /api/gw/anthropic with the pool's session token — never an account's.
 */
export function codexLoginClaudeExecRow(sessionToken: string): ModelProviderRow {
  return {
    runtime: AgentProvider.CODEX,
    baseUrl: poolGatewayUrl(),
    apiKeyEnc: '',
    sessionToken,
    defaultModel: null,
    presetSlug: 'openai',
    followsPreset: true,
    enabled: true,
    codexLogin: true,
  };
}

/** The pool session token a `codexLogin` row carries, or nothing: never a key, never an account's token. */
export function codexLoginToken(row: Pick<ModelProviderRow, 'codexLogin' | 'sessionToken'>): string | undefined {
  return row.codexLogin && row.sessionToken?.startsWith(POOL_LOGIN_TOKEN_PREFIX) ? row.sessionToken : undefined;
}
