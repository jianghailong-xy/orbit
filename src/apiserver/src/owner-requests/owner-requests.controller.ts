import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CompleteOwnerRequestDto, DeclineOwnerRequestDto, SubmitOwnerSecretDto } from './dto';
import { OwnerRequestsService, ownerRequestClient } from './owner-requests.service';
import { OwnerSecretsService, refuseActingSession } from './owner-secrets.service';

/**
 * The account owner's side of owner requests: read them, and end them as done or declined.
 * Sessions file and withdraw them through `RunnerOwnerRequestsController`.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('NO_SCOPE')
@Controller('owner-requests')
export class OwnerRequestsController {
  constructor(
    private readonly requests: OwnerRequestsService,
    private readonly secrets: OwnerSecretsService,
  ) {}

  /** `?state=open` (the default), `done`, `declined`, `expired`, `withdrawn` or `all`; newest first. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('state') state?: string) {
    return this.requests.list(user.userId, state);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.requests.get(user.userId, id);
  }

  @Post(':id/done')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: CompleteOwnerRequestDto,
    @Headers('x-orbit-client') client?: string,
  ) {
    return this.requests.complete(user.userId, id, dto, ownerRequestClient(client));
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: DeclineOwnerRequestDto,
    @Headers('x-orbit-client') client?: string,
  ) {
    return this.requests.decline(user.userId, id, dto.reason, ownerRequestClient(client));
  }

  /**
   * The owner enters a SECRET request's key (design §4.2 step 1). Answers with the request as the card shows it, which
   * never carries the value. The request becomes DONE only when the runner acknowledges delivery.
   */
  @Post(':id/secret')
  @PatForbidden('OWNER_INTERACTIVE')
  @HttpCode(HttpStatus.OK)
  async submitSecret(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: SubmitOwnerSecretDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    refuseActingSession(request.headers);
    await this.secrets.submit(user.userId, id, dto);
    return this.requests.get(user.userId, id);
  }

  /** The owner takes back a key that has not reached the runner yet. */
  @Post(':id/secret/cancel')
  @PatForbidden('OWNER_INTERACTIVE')
  @HttpCode(HttpStatus.OK)
  async cancelSecret(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    refuseActingSession(request.headers);
    await this.secrets.cancel(user.userId, id);
    return this.requests.get(user.userId, id);
  }

  /** The owner's Revoke: the runner removes the key on its next heartbeat. */
  @Post(':id/secret/revoke')
  @PatForbidden('OWNER_INTERACTIVE')
  @HttpCode(HttpStatus.OK)
  async revokeSecret(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    refuseActingSession(request.headers);
    await this.secrets.revoke(user.userId, id);
    return this.requests.get(user.userId, id);
  }
}
