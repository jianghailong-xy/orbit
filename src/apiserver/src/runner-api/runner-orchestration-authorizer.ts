import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Runner, RunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const ORCHESTRATION_AUDIENCE = 'orbit-runner-orchestration';
const ORCHESTRATION_PURPOSE = 'runner-orchestration';
const ORCHESTRATION_CREDENTIAL_MIN_VERSION = [0, 1, 80] as const;

type OrchestrationClaims = {
  sub?: string;
  runnerId?: string;
  purpose?: string;
};

function runnerRequiresCredential(version: string | null | undefined): boolean {
  // Fail closed for unknown/non-release builds. The sole compatibility case is a
  // reported, older semver runner that predates the signed credential protocol.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? '');
  if (!match) return true;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < ORCHESTRATION_CREDENTIAL_MIN_VERSION.length; i += 1) {
    if (parts[i] !== ORCHESTRATION_CREDENTIAL_MIN_VERSION[i]) {
      return parts[i] > ORCHESTRATION_CREDENTIAL_MIN_VERSION[i];
    }
  }
  return true;
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
 * This also prevents another process on the same runner from authorizing itself with
 * a discovered session id.
 */
@Injectable()
export class RunnerOrchestrationAuthorizer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Mint a credential that proves which claimed process is making a later CLI/MCP call. */
  issue(runnerId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { runnerId, purpose: ORCHESTRATION_PURPOSE },
      { audience: ORCHESTRATION_AUDIENCE, subject: sessionId, expiresIn: '30d' },
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
    // It is fail-closed by default and cannot be enabled by a runner heartbeat/version lie.
    // Remove this bridge after 0.1.79 runners have been retired.
    if (!credential) {
      const legacyRolloutEnabled = ['1', 'true', 'yes', 'on'].includes(
        (this.config.get<string>('ORBIT_ALLOW_LEGACY_ORCHESTRATION') ?? '').trim().toLowerCase(),
      );
      if (!legacyRolloutEnabled || runnerRequiresCredential(runner.version)) {
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
