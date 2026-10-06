import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { SessionRequestService } from './session-request.service';

/**
 * A session request as the account owner's clients read it (docs/session-request-reply-contract.md §6):
 * the state a request card shows, read again whenever the request's sessions announce a change. Read
 * only — the owner does not answer on the recipient's behalf (§9.3), so there is no write here.
 *
 * The route parameter is `id`, not `requestId`: that name is one the public-id codec never translates
 * (NEVER_PUBLIC_ID_FIELDS), and this one is an address.
 */
@UseGuards(JwtAuthGuard)
@Controller('session-requests')
export class SessionRequestsController {
  constructor(private readonly requests: SessionRequestService) {}

  @PatScope('sessions:read')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.requests.view(user.userId, id);
  }
}
