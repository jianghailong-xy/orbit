import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PollPatDeviceLoginDto, StartPatDeviceLoginDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatDeviceLoginService } from './pat-device-login.service';
import { PatForbidden } from './pat-scope.decorator';

/**
 * `orbit login` through the browser (docs/personal-access-token-design.md §7.3), the runner device
 * flow's shape (runner-api.controller.ts `device/start` and `device/poll`, runners.controller.ts
 * `device/:userCode` and its approve). The CLI starts a request and polls for its token with no
 * credential: the device code it alone holds is what it polls with. The person approves or denies
 * it at /cli-login?code=… signed in to Orbit — those three routes are behind JwtAuthGuard and, like
 * the rest of /access-tokens, closed to every token (TOKEN_MANAGEMENT): approving is how a token is
 * issued, and a token cannot issue one.
 */
@PatForbidden('TOKEN_MANAGEMENT')
@Controller('access-tokens/device')
export class PatDeviceLoginController {
  constructor(private readonly logins: PatDeviceLoginService) {}

  /** `orbit login` asks for a token. No credential. */
  @Post('start')
  start(@Body() dto: StartPatDeviceLoginDto) {
    return this.logins.start(dto);
  }

  /** The CLI polls this until the request is decided; approved, the answer is the token's one appearance. No credential. */
  @Post('poll')
  @HttpCode(200)
  poll(@Body() dto: PollPatDeviceLoginDto) {
    return this.logins.poll(dto.deviceCode);
  }

  /** What the approval page shows: the token asked for, the host asking, where the request stands. */
  @UseGuards(JwtAuthGuard)
  @Get(':userCode')
  lookup(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.logins.lookup(user.userId, userCode);
  }

  /** Approve: the token is issued to the caller when the CLI next polls. */
  @UseGuards(JwtAuthGuard)
  @Post(':userCode/approve')
  approve(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.logins.approve(user.userId, userCode);
  }

  /** Deny: the CLI is told so, and no token is issued. */
  @UseGuards(JwtAuthGuard)
  @Post(':userCode/deny')
  deny(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.logins.deny(user.userId, userCode);
  }
}
