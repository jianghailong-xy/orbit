import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Runner, RunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const ORCHESTRATION_AUDIENCE = 'orbit-runner-orchestration';
const ORCHESTRATION_PURPOSE = 'runner-orchestration';
const LEGACY_ORCHESTRATION_RUNNER_VERSION = /^v?0\.1\.79(?:[-+].*)?$/;
export const RUNNER_ORCHESTRATION_JWT = Symbol('RUNNER_ORCHESTRATION_JWT');

/** Dedicated JWT instance: access-token defaults (notably ACCESS_TOKEN_TTL) must not bleed in. */
export function createRunnerOrchestrationJwt(config: ConfigService): JwtService {
  const secret = config.get<string>('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET is required');
  return new JwtService({ secret });
}

type OrchestrationClaims = {
  sub?: string;
  runnerId?: string;
  purpose?: string;
};

function isLegacyOrchestrationRunner(version: string | null | undefined): boolean {
  return LEGACY_ORCHESTRATION_RUNNER_VERSION.test(version ?? '');
}

const LIVE_ORCHESTRATOR_STATUSES: RunStatus[] = [
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
];

/**
 * Authorizes runner-token calls made on behalf of an in-session orchestrator.
 *
 * ORBIT_ALLOW_ORCHESTRATION is a discovery/runtime UX gate, not an authorization
 * boundary: an agent can alter its child-process environment. The control plane
 * therefore verifies a signed credential bound to the calling session and runner,
 * then re-checks the session and its current agent configuration for every request.
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
    private readonly config: ConfigService,
  ) {}

  /** Mint a credential that proves which claimed process is making a later CLI/MCP call. */
  issue(runnerId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { runnerId, purpose: ORCHESTRATION_PURPOSE },
      // The live-session DB predicate below is the revocation/lifetime boundary. Orbit
      // sessions can remain awaiting input indefinitely, so a fixed JWT expiry would
      // strand an otherwise-live session without any in-process refresh path.
      { audience: ORCHESTRATION_AUDIENCE, subject: sessionId },
    );
  }

  async assert(
    runner: Pick<Runner, 'id' | 'ownerId'> & { version?: string | null },
    sessionId: string | undefined,
    credential: string | undefined,
  ): Promise<string> {
    if (!sessionId) throw new BadRequestException('missing session context');
    // Optional, server-controlled rollout bridge for 0.1.79: web/apiserver deployment
    // publishes the new runner binary, but external daemons update only when restarted.
    // It is fail-closed by default and only an operator can enable this explicitly
    // insecure legacy path. Remove the bridge after 0.1.79 runners have been retired.
    if (!credential) {
      const legacyRolloutEnabled = ['1', 'true', 'yes', 'on'].includes(
        (this.config.get<string>('ORBIT_ALLOW_LEGACY_ORCHESTRATION') ?? '').trim().toLowerCase(),
      );
      if (!legacyRolloutEnabled || !isLegacyOrchestrationRunner(runner.version)) {
        throw new ForbiddenException('missing orchestration credential');
      }
    } else {
      let claims: OrchestrationClaims;
      try {
        claims = await this.jwt.verifyAsync<OrchestrationClaims>(credential, {
          audience: ORCHESTRATION_AUDIENCE,
        });
      } catch {
        throw new ForbiddenException('invalid orchestration credential');
      }
      if (
        claims.purpose !== ORCHESTRATION_PURPOSE ||
        claims.sub !== sessionId ||
        claims.runnerId !== runner.id
      ) {
        throw new ForbiddenException('invalid orchestration credential');
      }
    }

    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        ownerId: runner.ownerId,
        assignedRunnerId: runner.id,
        deletedAt: null,
        cancelRequestedAt: null,
        status: { in: LIVE_ORCHESTRATOR_STATUSES },
        agent: { enableOrchestration: true, deletedAt: null },
      },
      select: { id: true },
    });
    if (!session) {
      throw new ForbiddenException('orchestration is not enabled for this session');
    }
    return session.id;
  }
}
