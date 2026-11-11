import type { Prisma } from '@prisma/client';
import { AgentProvider, keyDialect, providerPreset, type EngineTableOptions } from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import { upstreamUrlRefusal } from './gateway-upstream';
import { catalogModels } from './model-catalog';
import { POOL_GATEWAY_TOKEN_TTL_MS } from './shared-pool';

/**
 * Claude Code on an OpenAI key, through Orbit's own gateway (docs/claude-engine-openai-gateway-design.md §4.2):
 * the deployment switch, the session token, and the row dispatch hands the engine in the key's place.
 */

/**
 * The deployment switch (decision D6), read on every call so a spec can turn it: `true` turns the gateway on;
 * absent, empty, `false` or anything else is off. Off, no key's `engines` list or dispatch environment differs
 * from what it was before the gateway existed.
 */
export const ANTHROPIC_GATEWAY_FLAG = 'ORBIT_CLAUDE_OPENAI_GATEWAY';

export function anthropicGatewayEnabled(): boolean {
  return process.env[ANTHROPIC_GATEWAY_FLAG]?.trim().toLowerCase() === 'true';
}

/**
 * The compatibility table's options as this deployment has them for a key whose endpoint is `baseUrl` (shared
 * providerEngines.ts): the gateway counts as on only for an endpoint it may call (design §5.3), so a key aimed
 * anywhere else is never offered Claude Code.
 */
export function engineTableOptions(baseUrl: string): EngineTableOptions {
  return anthropicGatewayEnabled() && upstreamUrlRefusal(baseUrl) === null ? { anthropicGateway: true } : {};
}

/** A key gateway token starts with this; a pool's start `orbit-gw-` and `orbit-gwl-` (shared-pool.ts). */
export const KEY_GATEWAY_TOKEN_PREFIX = 'orbit-gwk-';

/** The gateway's path under the API prefix; Claude Code appends `/v1/messages` to it. */
export const ANTHROPIC_GATEWAY_PATH = '/api/gw/anthropic';

/** Where a runner's claude reaches the gateway: this deployment's public origin, as poolGatewayUrl reads it. */
export function anthropicGatewayUrl(): string {
  const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
  return `${origin}${ANTHROPIC_GATEWAY_PATH}`;
}

/** Whether a session on `engine` spends `row` through the gateway: Claude Code on an OpenAI-dialect key. */
export function runsThroughAnthropicGateway(engine: AgentProvider | null | undefined, row: { runtime: string }): boolean {
  return engine === AgentProvider.CLAUDE && keyDialect(row.runtime) === 'openai';
}

/**
 * Mint the token a build of such a session's engine environment carries — the claim, a reclaim, a
 * provider-switch reload — and store only its hash, as mintPoolGatewayToken does for a pool. Earlier tokens of
 * the same session on the same key stay good and move with it, since a warm engine may still hold one; the
 * session's tokens for any other key, and its expired or revoked ones, are deleted.
 */
export async function mintKeyGatewayToken(
  db: Prisma.TransactionClient | PrismaService,
  binding: { providerId: string; userId: string; sessionId: string },
  now: Date,
): Promise<string> {
  const token = `${KEY_GATEWAY_TOKEN_PREFIX}${generateToken(32)}`;
  const expiresAt = new Date(now.getTime() + POOL_GATEWAY_TOKEN_TTL_MS);
  await db.keyGatewayToken.deleteMany({
    where: {
      sessionId: binding.sessionId,
      OR: [{ providerId: { not: binding.providerId } }, { expiresAt: { lte: now } }, { revokedAt: { not: null } }],
    },
  });
  await db.keyGatewayToken.updateMany({ where: { sessionId: binding.sessionId }, data: { expiresAt } });
  await db.keyGatewayToken.create({ data: { ...binding, tokenHash: sha256(token), expiresAt } });
  return token;
}

/**
 * Whether the gateway books this session's spend (design §5.5, decision D8): Claude Code on the key a gateway
 * token was minted for. Such a session's answers are priced as they pass the gateway (AnthropicGatewayService
 * `record`), so turn-complete books none of the CLI's own `total_cost_usd` or `modelUsage`, which is its guess from
 * Anthropic's price table. A token of a key the session has since moved off, or of an engine it no longer runs,
 * does not count.
 */
export async function gatewayBooksSpend(
  db: Prisma.TransactionClient | PrismaService,
  session: { id: string; provider: string | null; engine: string | null },
): Promise<boolean> {
  if (session.engine !== AgentProvider.CLAUDE || !session.provider) return false;
  const token = await db.keyGatewayToken.findFirst({
    where: { sessionId: session.id, provider: { slug: session.provider } },
    select: { id: true },
  });
  return token !== null;
}

/** Every live token of a key, revoked: the key was disabled or its secret replaced. */
export async function revokeKeyGatewayTokens(
  db: Prisma.TransactionClient | PrismaService,
  providerId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.keyGatewayToken.updateMany({ where: { providerId, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * The row dispatch builds a session's environment from: `row` itself, unless the session runs Claude Code on an
 * OpenAI key with the gateway on — then a copy whose credential is a token minted for this build
 * (`sessionToken`, which injectedEnv's Claude branch hands the engine in the key's place).
 */
export async function withKeyGatewayToken<T extends { id: string; runtime: string; enabled: boolean }>(
  db: Prisma.TransactionClient | PrismaService,
  session: { id: string; ownerId: string },
  engine: AgentProvider | null | undefined,
  row: T | null,
): Promise<(T & { sessionToken?: string }) | null> {
  if (!row || !row.enabled || !anthropicGatewayEnabled() || !runsThroughAnthropicGateway(engine, row)) return row;
  const sessionToken = await mintKeyGatewayToken(
    db,
    { providerId: row.id, userId: session.ownerId, sessionId: session.id },
    new Date(),
  );
  return { ...row, sessionToken };
}

/**
 * The key's small model, for Claude Code's haiku slot (design §4.5): the first of the key's models named a
 * `mini` — the preset's, or the row's own list — else none, and the CLI then sends the session model there.
 */
export function gatewaySmallModel(row: { presetSlug?: string | null; followsPreset?: boolean; models?: unknown }): string | undefined {
  const preset = providerPreset(row.presetSlug);
  const own = Array.isArray(row.models)
    ? row.models.filter((m): m is { value: string } => !!m && typeof (m as { value?: unknown }).value === 'string')
    : [];
  const models = preset && (row.followsPreset !== false || own.length === 0) ? catalogModels(preset) : own;
  return models.find((m) => /(^|-)mini($|-)/i.test(m.value))?.value;
}
