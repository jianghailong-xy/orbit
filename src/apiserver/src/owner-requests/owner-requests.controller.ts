import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CompleteOwnerRequestDto, DeclineOwnerRequestDto } from './dto';
import { OwnerRequestsService } from './owner-requests.service';

/**
 * The account owner's side of owner requests: read them, and end them as done or declined.
 * Sessions file and withdraw them through `RunnerOwnerRequestsController`.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('NO_SCOPE')
@Controller('owner-requests')
export class OwnerRequestsController {
  constructor(private readonly requests: OwnerRequestsService) {}

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
  complete(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: CompleteOwnerRequestDto) {
    return this.requests.complete(user.userId, id, dto);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: DeclineOwnerRequestDto) {
    return this.requests.decline(user.userId, id, dto.reason);
  }
}
