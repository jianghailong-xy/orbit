import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Runner } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';

const ORCHESTRATION_AUDIENCE = 'orbit-runner-orchestration';
const ORCHESTRATION_PURPOSE = 'runner-orchestration';
const ORCHESTRATION_KEY_DERIVATION_DOMAIN = 'orbit:runner-orchestration-jwt:v1';
export const ORCHESTRATION_CREDENTIAL_MISSING_CODE = 'ORCHESTRATION_CREDENTIAL_MISSING';
export const ORCHESTRATION_CREDENTIAL_INVALID_CODE = 'ORCHESTRATION_CREDENTIAL_INVALID';
export const RUNNER_ORCHESTRATION_TOKEN_TTL_SECONDS = 15 * 60;
export const RUNNER_ORCHESTRATION_JWT = Symbol('RUNNER_ORCHESTRATION_JWT');

/**
 * Dedicated JWT instance and signing domain. A deployment may supply an independently
 * rotatable key; otherwise derive one from JWT_SECRET so an orchestration proof can never
 * be accepted as a normal user access token signed directly by JWT_SECRET.
 */
export function createRunnerOrchestrationJwt(config: ConfigService): JwtService {
  const dedicatedSecret = config.get<string>('RUNNER_ORCHESTRATION_JWT_SECRET');
  const rootSecret = config.get<string>('JWT_SECRET');
  const secret = dedicatedSecret
    ? dedicatedSecret
    : rootSecret
      ? createHmac('sha256', rootSecret).update(ORCHESTRATION_KEY_DERIVATION_DOMAIN).digest()
      : undefined;
  if (!secret) {
    throw new Error('JWT_SECRET or RUNNER_ORCHESTRATION_JWT_SECRET is required');
  }
  return new JwtService({ secret });
}

type OrchestrationClaims = {
  sub?: string;
  runnerId?: string;
  purpose?: string;
};

/**
 * Authorizes runner-token calls made on behalf of an in-session orchestrator.
 *
 * ORBIT_ALLOW_ORCHESTRATION is a discovery/runtime UX gate, not an authorization
 * boundary: a workspace can alter its child-process environment. The control plane
 * therefore verifies a signed credential bound to the calling session and runner,
 * then re-checks the session and its current workspace configuration for every request.
 * A discovered session id alone is therefore insufficient. The runner's OS account is
 * still the trust boundary: sibling processes that can inspect each other's environments
 * or runner config are not isolated from one another.
 */
@Injectable()
export class RunnerOrchestrationAuthorizer {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUNNER_ORCHESTRATION_JWT)
    private readonly jwt: JwtService,
  ) {}

  /** Mint a credential that proves which claimed process is making a later CLI/MCP call. */
  issue(runnerId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { runnerId, purpose: ORCHESTRATION_PURPOSE },
      // A short cryptographic lifetime bounds a leaked proof. The runner reads its private
      // credential file on every call and transparently reissues after an expiry-driven 403;
      // the live-session predicate below remains the immediate revocation boundary.
      {
        audience: ORCHESTRATION_AUDIENCE,
        subject: sessionId,
        expiresIn: RUNNER_ORCHESTRATION_TOKEN_TTL_SECONDS,
      },
    );
  }

  /** Reissue only while the authenticated runner still owns an eligible live session. */
  async reissue(
    runner: Pick<Runner, 'id' | 'ownerId'>,
    sessionId: string,
  ): Promise<string> {
    await this.assertLiveOrchestrationSession(runner, sessionId);
    return this.issue(runner.id, sessionId);
  }

  async assert(
    runner: Pick<Runner, 'id' | 'ownerId'>,
    sessionId: string | undefined,
    credential: string | undefined,
  ): Promise<string> {
    if (!sessionId) throw new BadRequestException('missing session context');
    if (!credential) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: ORCHESTRATION_CREDENTIAL_MISSING_CODE,
        message: 'missing orchestration credential',
      });
    }

    let claims: OrchestrationClaims;
    try {
      claims = await this.jwt.verifyAsync<OrchestrationClaims>(credential, {
        audience: ORCHESTRATION_AUDIENCE,
      });
    } catch {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: ORCHESTRATION_CREDENTIAL_INVALID_CODE,
        message: 'invalid orchestration credential',
      });
    }
    if (
      claims.purpose !== ORCHESTRATION_PURPOSE ||
      claims.sub !== sessionId ||
      claims.runnerId !== runner.id
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: ORCHESTRATION_CREDENTIAL_INVALID_CODE,
        message: 'invalid orchestration credential',
      });
    }

    return this.assertLiveOrchestrationSession(runner, sessionId);
  }

  private async assertLiveOrchestrationSession(
    runner: Pick<Runner, 'id' | 'ownerId'>,
    sessionId: string,
  ): Promise<string> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        ownerId: runner.ownerId,
        assignedRunnerId: runner.id,
        deletedAt: null,
        cancelRequestedAt: null,
        status: { in: OPEN_SESSION_STATUSES },
        workspace: { enableOrchestration: true, deletedAt: null },
      },
      select: { id: true },
    });
    if (!session) {
      throw new ForbiddenException('orchestration is not enabled for this session');
    }
    return session.id;
  }
}
