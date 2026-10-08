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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { listParam } from '../wiki/wiki-retrieval';
import { PutShareLinkDto, TurnOffShareLinksDto } from './dto';
import { ShareLinksService } from './share-links.service';

/**
 * The owner's side of public links (docs/share-links-design.md §5, §10). Each of a session, a task, a
 * project and a wiki space answers `GET | PUT | DELETE …/:id/share` — read its link, open or change
 * it, turn it off — and `/share-links` is every link the account has made. Owner-scoped throughout:
 * another account's object, or link, is not found. The public side is SharedController.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('SHARE_LINK')
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

  /** A wiki space's link: its home and every document written for it. Refused WIKI_DISABLED, as every
   *  route of the wiki is, to an account the wiki is not on for. */
  @Get('wiki/spaces/:id/share')
  wikiLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.current(user.userId, 'WIKI', id);
  }

  @Put('wiki/spaces/:id/share')
  putWikiLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: PutShareLinkDto) {
    return this.links.put(user.userId, 'WIKI', id, dto);
  }

  @Delete('wiki/spaces/:id/share')
  turnOffWikiLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.links.turnOff(user.userId, 'WIKI', id);
  }

  /**
   * Every link the caller has made, ended ones included, each with its state and why. `kind` names
   * the kinds of root to list — joined with commas, or repeated — and without it the list is the
   * three kinds every shipped client knows (SESSION, TASK, PROJECT): a client asks for WIKI once it
   * can draw one.
   */
  @Get('share-links')
  list(@CurrentUser() user: AuthUser, @Query('kind') kind?: string | string[]) {
    return this.links.list(user.userId, listParam(kind));
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
