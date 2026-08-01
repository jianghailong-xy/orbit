import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Runner, RunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
 * therefore re-checks the calling session and its current agent configuration for
 * every orchestration request. Binding the session to this runner also prevents one
 * machine owned by the same user from borrowing another machine's session context.
 */
@Injectable()
export class RunnerOrchestrationAuthorizer {
  constructor(private readonly prisma: PrismaService) {}

  async assert(runner: Pick<Runner, 'id' | 'ownerId'>, sessionId: string | undefined): Promise<string> {
    if (!sessionId) throw new BadRequestException('missing session context');
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
