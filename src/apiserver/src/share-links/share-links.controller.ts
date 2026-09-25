import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { PutShareLinkDto, TurnOffShareLinksDto } from './dto';
import { ShareLinksService } from './share-links.service';

/**
 * The owner's side of public links (docs/share-links-design.md §5). Each of a session, a task and a
 * project answers `GET | PUT | DELETE …/:id/share` — read its link, open or change it, turn it off —
 * and `/share-links` is every link the account has made. Owner-scoped throughout: another
 * account's object, or link, is not found. The public side is SharedController.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class ShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @Get('sessions/:id/share')
  sessionLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.current(user.userId, 'SESSION', id);
  }

  @Put('sessions/:id/share')
  putSessionLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: PutShareLinkDto) {
    return this.links.put(user.userId, 'SESSION', id, dto);
  }

  /** The old door, which shipped iOS builds still use: open the link with the defaults (or leave the
   *  open one as it is) and answer `{shareToken, sharedAt}`. */
  @Post('sessions/:id/share')
  enableSessionLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.enableLegacy(user.userId, id);
  }

  @Delete('sessions/:id/share')
  turnOffSessionLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.turnOff(user.userId, 'SESSION', id);
  }

  @Get('tasks/:id/share')
  taskLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.current(user.userId, 'TASK', id);
  }

  @Put('tasks/:id/share')
  putTaskLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: PutShareLinkDto) {
    return this.links.put(user.userId, 'TASK', id, dto);
  }

  @Delete('tasks/:id/share')
  turnOffTaskLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.turnOff(user.userId, 'TASK', id);
  }

  @Get('projects/:id/share')
  projectLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.current(user.userId, 'PROJECT', id);
  }

  @Put('projects/:id/share')
  putProjectLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: PutShareLinkDto) {
    return this.links.put(user.userId, 'PROJECT', id, dto);
  }

  @Delete('projects/:id/share')
  turnOffProjectLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.turnOff(user.userId, 'PROJECT', id);
  }

  /** Every link the caller has made, ended ones included, each with its state and why. */
  @Get('share-links')
  list(@CurrentUser() user: AuthUser) {
    return this.links.list(user.userId);
  }

  /** Turn off the listed links in one request ("Turn off these N"). */
  @Post('share-links/turn-off')
  @HttpCode(HttpStatus.OK)
  turnOffMany(@CurrentUser() user: AuthUser, @Body() dto: TurnOffShareLinksDto) {
    return this.links.turnOffMany(user.userId, dto.shareLinkIds);
  }

  @Delete('share-links/:id')
  turnOff(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.turnOffById(user.userId, id);
  }
}
