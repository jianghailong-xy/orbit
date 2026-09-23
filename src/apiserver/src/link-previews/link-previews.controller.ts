import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { LinkPreviewsDto } from './dto';
import { LinkPreviewsService } from './link-previews.service';

@UseGuards(JwtAuthGuard)
@Controller('link-previews')
export class LinkPreviewsController {
  constructor(private readonly previews: LinkPreviewsService) {}

  /**
   * The cards for up to 50 links to Orbit objects, one per ref and in the order asked. A POST
   * because the refs are a body, not because anything is written: it answers 200. Every id comes
   * back base62; `unavailable` is all a caller learns about an object it may not read.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  read(@CurrentUser() user: AuthUser, @Body() dto: LinkPreviewsDto) {
    return this.previews.read(user.userId, dto.refs);
  }
}
