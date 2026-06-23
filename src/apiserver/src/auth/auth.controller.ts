import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AuthService } from './auth.service';
import { BootstrapDto, ChangePasswordDto, LoginDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Public: whether the system still has zero users, so the web can funnel to /setup. */
  @Get('setup-status')
  setupStatus() {
    return this.auth.getSetupStatus();
  }

  /** Public first-run endpoint: create the first user (guarded by ADMIN_TOKEN) and
   *  return a session token. Self-closes once any user exists. */
  @Post('bootstrap')
  bootstrap(@Headers('x-admin-token') adminToken: string | undefined, @Body() dto: BootstrapDto) {
    return this.auth.bootstrap(adminToken, dto.email, dto.name, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.userId, dto.currentPassword, dto.newPassword);
  }
}
