import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CreateWatchDto, UpdateWatchDto } from './dto';
import { WatchesService } from './watches.service';

@UseGuards(JwtAuthGuard)
@PatForbidden('NO_SCOPE')
@Controller('watches')
export class WatchesController {
  constructor(private readonly watches: WatchesService) {}

  /** A one-shot watch over an explicit set of sessions or tasks, evaluated before it is returned. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWatchDto) {
    return this.watches.create(user.userId, dto);
  }

  /**
   * The caller's watches, newest first; `?state=ACTIVE` narrows the list to one state. `?needsAttention=true`
   * answers instead with the watches that need attention (contract `attention`) — an end nobody was told about,
   * or a delivery that failed — however many watches were made after them. `?following=true` answers with the
   * union a Following page needs: the newest 100 of any state plus every ACTIVE, PAUSED and needs-attention
   * watch (at most 100 each), each watch once.
   */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('state') state?: string,
    @Query('needsAttention') needsAttention?: string,
    @Query('following') following?: string,
  ) {
    if (following !== undefined) {
      if (following !== 'true' || state !== undefined || needsAttention !== undefined) {
        throw new BadRequestException('following is true, alone: it is the union of the other reads');
      }
      return this.watches.listFollowing(user.userId);
    }
    if (needsAttention === undefined) return this.watches.list(user.userId, state);
    if (needsAttention !== 'true') {
      throw new BadRequestException('needsAttention is true or left out: there is no read of the watches nobody has to look at');
    }
    return this.watches.listNeedingAttention(user.userId, state);
  }

  /** The account's deliveries in one state, dead letters unless `?state=` names another: the operations entry. */
  @Get('deliveries')
  listDeliveries(@CurrentUser() user: AuthUser, @Query('state') state?: string) {
    return this.watches.listDeliveries(user.userId, state);
  }

  /** Redrive a dead letter: back to PENDING for the delivery worker, unless its code says it may not be. */
  @Post('deliveries/:id/retry')
  @HttpCode(HttpStatus.OK)
  retryDelivery(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.watches.retryDelivery(user.userId, id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.watches.get(user.userId, id);
  }

  /** Edit the condition or the deadline of a live watch. Its targets and action stay as created. */
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateWatchDto) {
    return this.watches.update(user.userId, id, dto);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.watches.pause(user.userId, id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.watches.resume(user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.watches.cancel(user.userId, id);
  }
}
