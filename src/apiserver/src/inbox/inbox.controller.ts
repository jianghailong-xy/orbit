import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { InboxService } from './inbox.service';

@UseGuards(JwtAuthGuard)
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** Everything in the caller's account waiting on them, oldest first. `?resolvedSince=<iso>`
   *  additionally returns what they have already settled since that instant. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('resolvedSince') resolvedSince?: string) {
    return this.inbox.list(user.userId, resolvedSince);
  }
}
