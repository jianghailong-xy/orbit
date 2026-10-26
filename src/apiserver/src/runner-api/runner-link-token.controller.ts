import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentRunner } from './current-runner.decorator';
import { parseLeaseGeneration } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import {
  RUNNER_LINK,
  RUNNER_LINK_CELL,
  RUNNER_LINK_REVOCATION_WINDOW_MS,
  isRunnerLinkGateway,
  runnerLinkCredential,
  runnerLinkNotConfigured,
  signRunnerLinkToken,
  type RunnerLinkState,
} from './runner-link-token';

export interface RunnerLinkTokenRequest {
  /** The asking process's identity: the `leaseOwner` its heartbeats carry. */
  leaseOwner?: string;
}

export interface RunnerLinkTokenResponse {
  token: string;
  expiresAt: string;
  cellId: string;
  /** Where the runner connects: its cell's gateway. */
  linkUrl: string;
}

export interface RunnerLinkRevocationsResponse {
  /** Revocations at or after this instant are listed; an earlier one can refuse no live token. */
  since: string;
  revocations: Array<{ credential: string; revokedAt: string }>;
}

/**
 * The link gateway's door: the secret RUNNER_LINK_GATEWAY_TOKEN names, in the Authorization header.
 * While the link is off the route answers its 404 before anything else, whatever was presented.
 */
@Injectable()
export class RunnerLinkGatewayGuard implements CanActivate {
  constructor(@Inject(RUNNER_LINK) private readonly link: RunnerLinkState) {}

  canActivate(context: ExecutionContext): boolean {
    const config = this.link.config;
    if (!config) throw runnerLinkNotConfigured();
    if (!isRunnerLinkGateway(config, context.switchToHttp().getRequest().headers['authorization'])) {
      throw new UnauthorizedException({
        code: 'RUNNER_LINK_GATEWAY_UNAUTHORIZED',
        message: 'This route answers the link gateway, which presents RUNNER_LINK_GATEWAY_TOKEN.',
      });
    }
    return true;
  }
}

/**
 * The runner link's two HTTPS routes (docs/runner-link-design.md §5.4, §6.2; runner-link-token.ts):
 * a runner trades its runner token for a connection token, and the gateway reads which runner
 * credentials stopped vouching for the tokens it holds.
 */
@Controller('runner/link-token')
export class RunnerLinkTokenController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUNNER_LINK) private readonly link: RunnerLinkState,
  ) {}

  /**
   * POST /api/runner/link-token: a connection token for this runner, valid for an hour, naming the
   * runner, its tenant, the tenant's cell and that cell's address, and the asking process. It is
   * bound to the runner credential that asked: deleting the runner or replacing its credential
   * revokes it (migration 0443's trigger), and the gateway refuses it from then on.
   */
  @UseGuards(RunnerAuthGuard)
  @Post()
  @HttpCode(200)
  async issue(@CurrentRunner() runner: Runner, @Body() body: RunnerLinkTokenRequest): Promise<RunnerLinkTokenResponse> {
    const config = this.link.config;
    if (!config) throw runnerLinkNotConfigured();
    const leaseOwner = parseLeaseGeneration(body?.leaseOwner, 'leaseOwner');
    if (!leaseOwner) throw new BadRequestException('leaseOwner is required: the process identity the token is for');
    const cellId = await this.cellOf(runner.ownerId);
    const { token, claims } = signRunnerLinkToken(
      config,
      {
        runnerId: runner.id,
        ownerId: runner.ownerId,
        cellId,
        leaseOwner,
        // The guard found this row by the hash of the token presented, so this is the credential that asked.
        credential: runnerLinkCredential(runner.tokenHash),
      },
      new Date(),
    );
    return { token, expiresAt: new Date(claims.exp * 1000).toISOString(), cellId, linkUrl: claims.linkUrl };
  }

  /**
   * GET /api/runner/link-token/revocations: the fingerprints of the runner credentials revoked within
   * a token's lifetime. The gateway keeps them as its deny list and refuses, and disconnects, every
   * token whose `credential` is one of them; anything older can refuse nothing.
   */
  @UseGuards(RunnerLinkGatewayGuard)
  @Get('revocations')
  async revocations(): Promise<RunnerLinkRevocationsResponse> {
    const since = new Date(Date.now() - RUNNER_LINK_REVOCATION_WINDOW_MS);
    const rows = await this.prisma.runnerLinkRevocation.findMany({
      where: { revokedAt: { gte: since } },
      select: { credential: true, revokedAt: true },
      orderBy: { revokedAt: 'asc' },
    });
    return {
      since: since.toISOString(),
      revocations: rows.map((row) => ({ credential: row.credential, revokedAt: row.revokedAt.toISOString() })),
    };
  }

  /**
   * The tenant's cell from the directory (tenant_cell), placing the tenant in the one cell on its
   * runners' first request. ON CONFLICT DO NOTHING, so two first requests at once place it once and
   * both read the row that stands.
   */
  private async cellOf(ownerId: string): Promise<string> {
    const placed = await this.prisma.tenantCell.findUnique({ where: { ownerId }, select: { cellId: true } });
    if (placed) return placed.cellId;
    await this.prisma.tenantCell.createMany({ data: [{ ownerId, cellId: RUNNER_LINK_CELL }], skipDuplicates: true });
    return (await this.prisma.tenantCell.findUniqueOrThrow({ where: { ownerId }, select: { cellId: true } })).cellId;
  }
}
