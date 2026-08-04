import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Runner } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const SERVICE_TOKEN_AUDIENCE = 'orbit-service-token';
const SERVICE_TOKEN_PURPOSE = 'headless-service';
const SERVICE_TOKEN_KEY_DERIVATION_DOMAIN = 'orbit:service-token-jwt:v1';
export const SERVICE_TOKEN_JWT = Symbol('SERVICE_TOKEN_JWT');

/**
 * Everything a headless process may be granted. The destructive verbs — end, interrupt, merge,
 * complete — are deliberately absent rather than merely unselected: a bridge never needs them,
 * they are the most damaging thing a leaked credential could reach, and leaving them out of the
 * vocabulary means no future caller can request them by accident.
 */
export const SERVICE_TOKEN_SCOPES = [
  'session:get',
  'session:list',
  'session:send',
  'session:create',
] as const;
export type ServiceTokenScope = (typeof SERVICE_TOKEN_SCOPES)[number];

const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;

export type ServiceTokenGrant = {
  tokenId: string;
  runner: Runner;
  scopes: ServiceTokenScope[];
  /** When set, every route this token reaches is confined to this one agent. */
  agentId: string | null;
};

type ServiceTokenClaims = {
  jti?: string;
  runnerId?: string;
  ownerId?: string;
  agentId?: string | null;
  scopes?: string[];
  purpose?: string;
};

/**
 * Dedicated signing domain, mirroring the orchestration credential: a service token can never be
 * mistaken for a user access token or for an orchestration proof, and a deployment may rotate its
 * key independently of JWT_SECRET.
 */
export function createServiceTokenJwt(config: ConfigService): JwtService {
  const dedicatedSecret = config.get<string>('SERVICE_TOKEN_JWT_SECRET');
  const rootSecret = config.get<string>('JWT_SECRET');
  const secret = dedicatedSecret
    ? dedicatedSecret
    : rootSecret
      ? createHmac('sha256', rootSecret).update(SERVICE_TOKEN_KEY_DERIVATION_DOMAIN).digest()
      : undefined;
  if (!secret) {
    throw new Error('JWT_SECRET or SERVICE_TOKEN_JWT_SECRET is required');
  }
  return new JwtService({ secret });
}

/**
 * Mints, verifies and revokes the narrow credentials a headless process runs on.
 *
 * The signature carries the scope, so a request can be authorized without trusting anything the
 * caller says about itself; the database row is consulted on every call anyway, because expiry
 * alone is not revocation — an owner who discovers a leaked token must be able to kill it now,
 * not at the end of its TTL.
 */
@Injectable()
export class ServiceTokenAuthorizer {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVICE_TOKEN_JWT) private readonly jwt: JwtService,
  ) {}

  /**
   * Mint a token for one runner. Authorization to call this lives with the RUNNER credential
   * (see RunnerServiceTokensController): a service token can never mint another, so a leaked
   * bridge token cannot extend its own life or widen its own scope past what was granted.
   */
  async mint(
    runner: Pick<Runner, 'id' | 'ownerId'>,
    dto: { scopes?: string[]; agentId?: string; label?: string; ttlSeconds?: number },
  ) {
    const scopes = this.parseScopes(dto.scopes);
    const ttlSeconds = this.parseTtl(dto.ttlSeconds);
    // A create-capable token is the one that can start work of its own accord, so it must name
    // the single agent it may start. get/list/send stay optionally pinned: a bridge that only
    // observes usually watches more than one session.
    if (scopes.includes('session:create') && !dto.agentId) {
      throw new BadRequestException('an agent id is required for the session:create scope');
    }
    if (dto.agentId) await this.assertAgentOnRunner(runner, dto.agentId);

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const row = await this.prisma.serviceToken.create({
      data: {
        ownerId: runner.ownerId,
        runnerId: runner.id,
        agentId: dto.agentId ?? null,
        label: dto.label?.trim() || null,
        scopes,
        expiresAt,
      },
    });
    const token = await this.jwt.signAsync(
      {
        runnerId: runner.id,
        ownerId: runner.ownerId,
        agentId: row.agentId,
        scopes,
        purpose: SERVICE_TOKEN_PURPOSE,
      },
      { audience: SERVICE_TOKEN_AUDIENCE, jwtid: row.id, expiresIn: ttlSeconds },
    );
    // The token is returned exactly once: nothing about it is recoverable from the row, so a
    // caller that loses it mints a new one and revokes this.
    return {
      id: row.id,
      token,
      scopes,
      agentId: row.agentId,
      label: row.label,
      expiresAt: row.expiresAt,
    };
  }

  /** Resolve a bearer token to a grant, or throw. Returns null when it is not a service token. */
  async verify(token: string): Promise<ServiceTokenGrant | null> {
    let claims: ServiceTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<ServiceTokenClaims>(token, {
        audience: SERVICE_TOKEN_AUDIENCE,
      });
    } catch {
      // Not ours (or expired/tampered). The caller decides what an unrecognized token means.
      return null;
    }
    if (claims.purpose !== SERVICE_TOKEN_PURPOSE || !claims.jti) {
      throw new UnauthorizedException('invalid service token');
    }
    const row = await this.prisma.serviceToken.findFirst({
      where: { id: claims.jti, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { runner: true },
    });
    // Revoked, expired server-side, or deleted along with its runner/agent: the signature is
    // valid but the grant is gone, and the row is the authority on that.
    if (!row) throw new UnauthorizedException('service token is revoked or expired');
    // The claims are signed, so a mismatch means the row moved under a still-valid signature
    // (a re-registered runner reusing an id, a repointed pin). Refuse rather than guess.
    if (row.runnerId !== claims.runnerId || row.ownerId !== claims.ownerId) {
      throw new UnauthorizedException('invalid service token');
    }
    if ((row.agentId ?? null) !== (claims.agentId ?? null)) {
      throw new UnauthorizedException('invalid service token');
    }
    // Not awaited: recording use must never make a valid request fail or wait on a write.
    void this.prisma.serviceToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      tokenId: row.id,
      runner: row.runner,
      scopes: this.parseScopes(row.scopes),
      agentId: row.agentId,
    };
  }

  async list(runner: Pick<Runner, 'id' | 'ownerId'>) {
    const rows = await this.prisma.serviceToken.findMany({
      where: { runnerId: runner.id, ownerId: runner.ownerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        scopes: true,
        agentId: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
        agent: { select: { name: true } },
      },
    });
    const now = Date.now();
    return rows.map(({ agent, ...row }) => ({
      ...row,
      agentName: agent?.name ?? null,
      status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now ? 'expired' : 'active',
    }));
  }

  /** Revoke immediately. Idempotent: revoking twice is not an error a script has to handle. */
  async revoke(runner: Pick<Runner, 'id' | 'ownerId'>, id: string) {
    const row = await this.prisma.serviceToken.findFirst({
      where: { id, runnerId: runner.id, ownerId: runner.ownerId },
      select: { id: true, revokedAt: true },
    });
    if (!row) throw new NotFoundException('service token not found');
    if (row.revokedAt) return { id: row.id, revokedAt: row.revokedAt };
    const updated = await this.prisma.serviceToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
      select: { id: true, revokedAt: true },
    });
    return updated;
  }

  private parseScopes(scopes: string[] | undefined): ServiceTokenScope[] {
    const requested = (scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
    if (requested.length === 0) throw new BadRequestException('at least one scope is required');
    const allowed = new Set<string>(SERVICE_TOKEN_SCOPES);
    const unknown = requested.filter((scope) => !allowed.has(scope));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `unknown scope(s): ${unknown.join(', ')}; allowed: ${SERVICE_TOKEN_SCOPES.join(', ')}`,
      );
    }
    return [...new Set(requested)] as ServiceTokenScope[];
  }

  private parseTtl(ttlSeconds: number | undefined): number {
    const ttl = Math.floor(Number(ttlSeconds));
    if (!Number.isFinite(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
      throw new BadRequestException(
        `ttlSeconds must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
      );
    }
    return ttl;
  }

  /** An agent pin only means anything if that agent runs on this machine. */
  private async assertAgentOnRunner(runner: Pick<Runner, 'id' | 'ownerId'>, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, ownerId: runner.ownerId, runnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('agent not found on this runner');
  }
}
