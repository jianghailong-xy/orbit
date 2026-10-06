import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What every personal access token starts with. Secret scanners (GitHub, gitleaks) recognise a
 * leaked token by it, and JwtAuthGuard routes on it before anything else is read.
 */
export const PAT_PREFIX = 'orbit_pat_';

/**
 * Everything a personal access token may be granted (docs/personal-access-token-design.md §4).
 * Resource × read/write, coarse on purpose so a person can tell what they are handing out. Owner
 * actions (§5), auth, admin and token management are absent rather than merely unselected: no
 * scope can ever open them.
 */
export const PAT_SCOPES = [
  'tasks:read',
  'tasks:write',
  'projects:read',
  'projects:write',
  'sessions:read',
  'sessions:write',
  'workspaces:read',
  'workspaces:write',
  'runners:read',
  'wiki:read',
  'wiki:write',
  'events:read',
] as const;
export type PatScopeName = (typeof PAT_SCOPES)[number];

export type PatCreatedVia = 'WEB' | 'CLI_DEVICE';
export type PatRevokedReason = 'USER' | 'EXPIRED' | 'PASSWORD_CHANGED' | 'USER_DELETED' | 'ADMIN';

/** §3: a user's tokens that are not revoked. Past it, issuing answers 409 — a script issuing in a loop stops there. */
export const PAT_MAX_ACTIVE_PER_USER = 50;
/** The longest finite lifetime; anything longer is a token that never expires, chosen as such (§11.1). */
export const PAT_MAX_EXPIRES_IN_DAYS = 365;
const PAT_NAME_MAX_LENGTH = 100;
/** `last_used_*` is written at most this often per token (§3). */
const LAST_USED_THROTTLE_MS = 60_000;
const USER_AGENT_MAX_LENGTH = 512;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a verified token acts as, and what it was granted. */
export interface PatGrant {
  tokenId: string;
  userId: string;
  email: string;
  scopes: string[];
  workspaceIds: string[];
}

/**
 * Issues, verifies and revokes personal access tokens (docs/personal-access-token-design.md §3, §6.1).
 *
 * A token is an opaque random string, not a JWT: every request reads its row anyway (revocation,
 * expiry, last use), so a signature would add nothing but a signing key worth stealing. Only the
 * sha256 is stored; the token itself exists once, in the answer to `issue`.
 */
@Injectable()
export class PatService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issue a token to `ownerId`. The answer is the only place the token ever appears: a caller that
   * loses it issues another and revokes this one. `expiresInDays: null` is a token that never
   * expires. Refused 409 when the name is taken by another of the user's live tokens, or when the
   * user already has PAT_MAX_ACTIVE_PER_USER of them.
   */
  async issue(
    ownerId: string,
    input: {
      name: string;
      scopes: string[];
      workspaceIds?: string[];
      expiresInDays: number | null;
      createdVia: PatCreatedVia;
    },
  ) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('a token needs a name');
    if (name.length > PAT_NAME_MAX_LENGTH) {
      throw new BadRequestException(`a token name is at most ${PAT_NAME_MAX_LENGTH} characters`);
    }
    const scopes = parseScopes(input.scopes);
    const workspaceIds = await this.ownedWorkspaces(ownerId, input.workspaceIds ?? []);
    const now = new Date();
    const expiresAt = expiryFrom(input.expiresInDays, now);

    await this.settleExpired(ownerId, now);
    // A soft cap: two issues racing at the last place can both land. It exists to stop a runaway
    // loop, and every issue after the cap is crossed is refused.
    const active = await this.prisma.personalAccessToken.count({ where: { ownerId, revokedAt: null } });
    if (active >= PAT_MAX_ACTIVE_PER_USER) {
      throw new ConflictException({
        code: 'PAT_LIMIT_REACHED',
        message: `You already have ${PAT_MAX_ACTIVE_PER_USER} access tokens — revoke one before issuing another`,
      });
    }

    const token = PAT_PREFIX + randomBytes(32).toString('base64url');
    try {
      const row = await this.prisma.personalAccessToken.create({
        data: {
          ownerId,
          name,
          tokenHash: sha256(token),
          tokenHint: token.slice(-4),
          scopes,
          workspaceIds,
          expiresAt,
          createdVia: input.createdVia,
        },
      });
      return {
        id: row.id,
        token,
        name: row.name,
        tokenHint: row.tokenHint,
        scopes: row.scopes,
        workspaceIds: row.workspaceIds,
        expiresAt: row.expiresAt,
        createdVia: row.createdVia,
        createdAt: row.createdAt,
      };
    } catch (error) {
      // The name's partial unique index (0383); a token_hash collision would need 2^128 tokens.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'PAT_NAME_IN_USE',
          message: `You already have an access token named "${name}" — revoke it or pick another name`,
        });
      }
      throw error;
    }
  }

  /**
   * Resolve a presented token to its grant, or null. Null alike for a token that does not exist,
   * was revoked or has expired (`expires_at` NULL never does): which one it was is not the caller's
   * to learn (§6.1). The user is there whenever the row is — the row cascades away with its user.
   *
   * Recording the use is not awaited: it must never make a valid request fail or wait on a write.
   */
  async verify(token: string, seen: { ip?: string; userAgent?: string } = {}): Promise<PatGrant | null> {
    if (!token.startsWith(PAT_PREFIX)) return null;
    const row = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { owner: { select: { email: true } } },
    });
    const now = new Date();
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
      void this.recordUse(row.id, now, seen).catch(() => undefined);
    }
    return {
      tokenId: row.id,
      userId: row.ownerId,
      email: row.owner.email,
      scopes: row.scopes,
      workspaceIds: row.workspaceIds,
    };
  }

  /** Revoke at once. Idempotent: revoking a revoked token answers it as it already is. */
  async revoke(ownerId: string, id: string, reason: PatRevokedReason = 'USER') {
    await this.prisma.personalAccessToken.updateMany({
      where: { id, ownerId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    const row = await this.prisma.personalAccessToken.findFirst({
      where: { id, ownerId },
      select: { id: true, revokedAt: true, revokedReason: true },
    });
    if (!row) throw new NotFoundException('access token not found');
    return row;
  }

  /**
   * The throttle is in the statement as well as in `verify`: two requests that both read a stale
   * `last_used_at` write it once.
   */
  private recordUse(id: string, now: Date, seen: { ip?: string; userAgent?: string }) {
    const stale = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
    return this.prisma.personalAccessToken.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: stale } }] },
      data: {
        lastUsedAt: now,
        lastUsedIp: seen.ip || null,
        lastUsedUserAgent: seen.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) || null,
      },
    });
  }

  /**
   * Tokens past their expiry are settled EXPIRED, as share links are, so they stop holding their
   * name and their place under the cap.
   */
  private settleExpired(ownerId: string, now: Date) {
    return this.prisma.personalAccessToken.updateMany({
      where: { ownerId, revokedAt: null, expiresAt: { lte: now } },
      data: { revokedAt: now, revokedReason: 'EXPIRED' },
    });
  }

  /** A token can only be confined to workspaces its owner has. */
  private async ownedWorkspaces(ownerId: string, ids: string[]): Promise<string[]> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    if (!wanted.every((id) => UUID.test(id))) {
      throw new BadRequestException('workspaceIds must be workspace ids');
    }
    const found = await this.prisma.workspace.count({
      where: { id: { in: wanted }, ownerId, deletedAt: null },
    });
    if (found !== wanted.length) throw new NotFoundException('workspace not found');
    return wanted;
  }
}

function parseScopes(scopes: string[]): PatScopeName[] {
  const requested = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (requested.length === 0) throw new BadRequestException('at least one scope is required');
  const allowed = new Set<string>(PAT_SCOPES);
  const unknown = requested.filter((scope) => !allowed.has(scope));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `unknown scope(s): ${unknown.join(', ')}; allowed: ${PAT_SCOPES.join(', ')}`,
    );
  }
  return requested as PatScopeName[];
}

function expiryFrom(days: number | null, now: Date): Date | null {
  if (days === null) return null;
  if (!Number.isInteger(days) || days < 1 || days > PAT_MAX_EXPIRES_IN_DAYS) {
    throw new BadRequestException(
      `expiresInDays must be a whole number from 1 to ${PAT_MAX_EXPIRES_IN_DAYS}, or null for a token that never expires`,
    );
  }
  return new Date(now.getTime() + days * DAY_MS);
}
