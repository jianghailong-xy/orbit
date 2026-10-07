import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelProviderRow } from './custom-provider';
import type { PoolKeyCandidate } from './pool-key-select';

/**
 * Shared Codex pools (migration 0321, docs/codex-shared-pool-design.md §2.2–§2.5): several Orbit users
 * run Codex on organization/project OpenAI API keys that only this server holds. What the claim and the
 * pool page share lives here; the pool's own doors are SharedPoolsService.
 */

/**
 * An OpenAI API key as a person pastes one: `sk-` and the key's own characters — a project key
 * (`sk-proj-…`), a service account's (`sk-svcacct-…`) or a legacy user key. Not an Anthropic key, which
 * shares the prefix (`sk-ant-…`), and not an admin key (`sk-admin-…`), which manages an organization and
 * runs no model.
 */
const OPENAI_API_KEY = /^sk-(?!ant-|admin-)[A-Za-z0-9_-]{20,400}$/;

/** A key read off a request: the secret, what two adds of it collide on, and all a response shows of it. */
export interface PoolApiKeyInput {
  secret: string;
  /** SHA-256 of the key (`pool_api_key_pool_id_key_fingerprint_key`). */
  fingerprint: string;
  /** Its last four characters. */
  hint: string;
}

/**
 * The key a person typed, or a 400 that says what is wrong with it without repeating it: the refusal is a
 * response body, and a key in a response body is exactly what this pool exists to avoid.
 */
export function parsePoolApiKey(raw: string): PoolApiKeyInput {
  const secret = raw.trim();
  if (!OPENAI_API_KEY.test(secret)) {
    throw new BadRequestException({
      code: 'POOL_KEY_FORMAT',
      message: "That isn't an OpenAI API key — paste an organization or project key (sk-…)",
    });
  }
  return { secret, fingerprint: sha256(secret), hint: secret.slice(-4) };
}

/** A key as every response names it: `sk-…AB12`. */
export const maskedKey = (hint: string) => `sk-…${hint}`;

/** The first day of the calendar month (UTC) `now` falls in: the window a share cap and the ledger count. */
export function usageWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The first day of the month after `now`'s: when that month's caps start again. */
export function nextUsageWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Where a runner's codex reaches the pool gateway: this deployment's public origin — the one runners are
 * installed against, PUBLIC_ORIGIN, as the web image bakes it in — and the gateway's path under the API
 * prefix. Codex appends `/responses` to it.
 */
export function poolGatewayUrl(): string {
  const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
  return `${origin}/api/gw/codex`;
}

/**
 * How long a session token stays good without a claim of its session. Every claim of the session pushes
 * all of its tokens out this far again, because a warm engine keeps running on the token of the claim that
 * spawned it (runner-go session_pool.go reuses the process, and its environment, across claims), and so
 * can long outlive a fixed lifetime. What ends a token is its session ending, its person leaving and its
 * pool being deleted; this is the backstop for a session nobody ends.
 */
export const POOL_GATEWAY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mint the token a build of a shared-pool session's engine environment carries — the claim, a reclaim,
 * a provider-switch reload — and store only its hash. Earlier tokens of the same session on the same pool
 * stay good and move with it, since a warm engine may still hold one of them; the session's tokens for any
 * other pool, and its expired or revoked ones, are deleted.
 */
export async function mintPoolGatewayToken(
  db: Prisma.TransactionClient | PrismaService,
  binding: { poolId: string; userId: string; sessionId: string },
  now: Date,
): Promise<string> {
  const token = `orbit-gw-${generateToken(32)}`;
  const expiresAt = new Date(now.getTime() + POOL_GATEWAY_TOKEN_TTL_MS);
  await db.poolGatewayToken.deleteMany({
    where: {
      sessionId: binding.sessionId,
      OR: [{ poolId: { not: binding.poolId } }, { expiresAt: { lte: now } }, { revokedAt: { not: null } }],
    },
  });
  await db.poolGatewayToken.updateMany({ where: { sessionId: binding.sessionId }, data: { expiresAt } });
  await db.poolGatewayToken.create({ data: { ...binding, tokenHash: sha256(token), expiresAt } });
  return token;
}

/**
 * A login pool's session tokens start with this, a shared pool's with `orbit-gw-`: the prefix is how the
 * gateway knows which table to look a token up in (PoolLoginToken or PoolGatewayToken).
 */
export const POOL_LOGIN_TOKEN_PREFIX = 'orbit-gwl-';

/**
 * mintPoolGatewayToken for a Codex pool of one person's own (migration 0324): the same build-by-build
 * token, kept in `pool_login_token` and prefixed POOL_LOGIN_TOKEN_PREFIX so the gateway knows to look for
 * it there. It names no account (migration 0355): the account its requests go out on is the session's own
 * (`session.pool_codex_account_id`, which the claim records), so the token authenticates (pool, owner,
 * session) alone and no account's removal reaches it. Earlier tokens of the same session on the same pool
 * stay good and move with it; its tokens for another pool, and its expired or revoked ones, are deleted.
 */
export async function mintPoolLoginToken(
  db: Prisma.TransactionClient | PrismaService,
  binding: { poolId: string; userId: string; sessionId: string },
  now: Date,
): Promise<string> {
  const token = `${POOL_LOGIN_TOKEN_PREFIX}${generateToken(32)}`;
  const expiresAt = new Date(now.getTime() + POOL_GATEWAY_TOKEN_TTL_MS);
  await db.poolLoginToken.deleteMany({
    where: {
      sessionId: binding.sessionId,
      OR: [{ poolId: { not: binding.poolId } }, { expiresAt: { lte: now } }, { revokedAt: { not: null } }],
    },
  });
  await db.poolLoginToken.updateMany({ where: { sessionId: binding.sessionId }, data: { expiresAt } });
  await db.poolLoginToken.create({ data: { ...binding, tokenHash: sha256(token), expiresAt } });
  return token;
}

/**
 * What a pool session dispatches as — a shared pool's, or a login pool's (migration 0324): a Codex
 * provider whose endpoint is the pool gateway and whose key is the session token — so the runner's own
 * translation of a configured Codex provider (runner-go codexProviderArgs) points its codex at the
 * gateway, and no key or login of the pool is in the job. The gateway sends it on to the Codex CLI's own
 * endpoint for the pool's credential, so the model space is the CLI's (followsRuntimeCatalog).
 */
export function sharedPoolExecRow(sessionToken: string): ModelProviderRow {
  return {
    runtime: AgentProvider.CODEX,
    baseUrl: poolGatewayUrl(),
    apiKeyEnc: '',
    sessionToken,
    defaultModel: null,
    presetSlug: 'openai',
    followsPreset: true,
    enabled: true,
  };
}

/**
 * The keys of a shared pool as a claim chooses among them (pool-key-select.ts), each with what everyone
 * but its contributor spent on it in the month `now` falls in. Never the secret.
 */
export async function sharedPoolKeyCandidates(
  db: Prisma.TransactionClient | PrismaService,
  poolId: string,
  now: Date,
): Promise<Array<PoolKeyCandidate & { label: string }>> {
  const keys = await db.poolApiKey.findMany({
    where: { poolId },
    orderBy: { id: 'asc' },
    select: {
      id: true, contributorId: true, label: true, enabled: true, state: true, shareCap: true, spentUntil: true, throttledUntil: true, pausedUntil: true,
    },
  });
  const spent = await db.poolUsage.findMany({
    where: { poolId, windowStart: usageWindowStart(now) },
    select: { keyId: true, userId: true, costMicros: true },
  });
  return keys.map((key) => ({
    ...key,
    othersCostMicros: spent
      .filter((row) => row.keyId === key.id && row.userId !== key.contributorId)
      .reduce((sum, row) => sum + Number(row.costMicros), 0),
  }));
}

/**
 * Why a shared pool none of whose keys can run is refused by the doors that take a provider — it has no
 * keys, or every one is switched off or refused by OpenAI — naming why each key is out. A pool whose keys
 * are only spent to their caps is not refused: those come back on the first of the month.
 */
export function sharedPoolUnavailableReason(
  label: string,
  keys: Array<{ label: string; enabled: boolean; state: string }>,
): string | null {
  if (keys.some((key) => key.enabled && key.state === 'ACTIVE')) return null;
  if (keys.length === 0) {
    return `the shared pool "${label}" has no keys in it — add one on its page, or pick another provider`;
  }
  const out = keys.map((key) => {
    const why = !key.enabled ? 'switched off' : key.state === 'INVALID' ? 'refused by OpenAI' : 'disabled by OpenAI';
    return `${key.label}: ${why}`;
  });
  return (
    `no key in the shared pool "${label}" can run (${out.join('; ')}) — ` +
    'fix one on its page, or pick another provider'
  );
}
