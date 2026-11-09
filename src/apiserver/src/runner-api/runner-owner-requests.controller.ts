import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { FileOwnerRequestDto, WithdrawOwnerRequestDto } from '../owner-requests/dto';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * A session asking its owner to act: file a request, read it back, withdraw it.
 *
 * Any session this runner hosts may file one — not only a project's coordinator, which is what
 * sets this apart from `POST /runner/projects/:id/owner-questions`. No orchestration credential:
 * a request grants nothing and starts nothing; it puts a card in front of the owner, and the
 * owner decides. The session is X-Orbit-Session-Id, checked to be one this runner hosts.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerOwnerRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: OwnerRequestsService,
  ) {}

  @Post('owner-requests')
  async file(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Body() dto: FileOwnerRequestDto,
  ) {
    const sessionId = await this.callingSession(runner, sessionHeader);
    return this.requests.file(runner.ownerId, sessionId, dto);
  }

  @Get('owner-requests/:id')
  get(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.requests.get(runner.ownerId, id);
  }

  @Post('owner-requests/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WithdrawOwnerRequestDto,
  ) {
    const sessionId = await this.callingSession(runner, sessionHeader);
    return this.requests.withdraw(runner.ownerId, sessionId, id, dto.reason);
  }

  private async callingSession(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException('missing session context: an owner request is filed by a session, so this door needs X-Orbit-Session-Id');
    }
    let id: string;
    try {
      id = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: runner.ownerId, assignedRunnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    return session.id;
  }
}
